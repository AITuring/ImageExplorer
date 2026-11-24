use once_cell::sync::Lazy;
use rayon::prelude::*;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "macos")]
use std::ffi::CString;

#[cfg(target_os = "macos")]
extern "C" {
    fn imageexplorer_recognize_text(
        path: *const libc::c_char,
        accurate: libc::c_int,
        out_length: *mut usize,
    ) -> *mut u8;
    fn imageexplorer_recognize_text_from_bytes(
        bytes: *const u8,
        length: usize,
        accurate: libc::c_int,
        out_length: *mut usize,
    ) -> *mut u8;
    fn imageexplorer_image_metadata(path: *const libc::c_char, length: *mut usize) -> *mut u8;
    fn imageexplorer_free_thumbnail(bytes: *mut u8);
}

static ACTIVE_SCAN_ID: AtomicU64 = AtomicU64::new(0);
static ACTIVE_SCAN_CANCEL: Lazy<std::sync::Mutex<Option<Arc<AtomicBool>>>> =
    Lazy::new(|| std::sync::Mutex::new(None));

const COMPANION_EXTS: &[&str] = &["xmp", "acr", "dop", "pp3"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrTextLine {
    pub text: String,
    pub confidence: f64,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParsedExhibitEntry {
    pub era: String,
    pub name: String,
    pub provenance: String,
    pub collection: String,
    pub accession_number: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExhibitLabelGroup {
    pub label_id: String,
    pub label_path: String,
    pub label_name: String,
    pub captured_at: Option<i64>,
    pub raw_text: String,
    pub confidence: f64,
    pub is_shared_card: bool,
    pub primary_entry: ParsedExhibitEntry,
    pub candidate_entries: Vec<ParsedExhibitEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExhibitPhotoProposal {
    pub path: String,
    pub file_name: String,
    pub extension: String,
    pub camera_stem: String,
    pub already_renamed: bool,
    pub captured_at: Option<i64>,
    pub modified: Option<i64>,
    pub size: u64,
    /// "label" | "artifact_with_label" | "artifact"
    pub role: String,
    /// "matched" | "uncertain" | "label_photo" | "already_renamed" | "unmatched"
    pub status: String,
    pub matched_label_id: Option<String>,
    pub matched_entry_index: usize,
    pub proposed_entry: Option<ParsedExhibitEntry>,
    pub proposed_name: Option<String>,
    pub evidence_note: String,
    pub time_delta_secs: Option<i64>,
    pub companion_files: Vec<String>,
    pub ocr_snippet: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExhibitScanResult {
    pub scan_id: u64,
    pub directory: String,
    pub cancelled: bool,
    pub total_photos: usize,
    pub labels: Vec<ExhibitLabelGroup>,
    pub proposals: Vec<ExhibitPhotoProposal>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExhibitScanProgressEvent {
    pub scan_id: u64,
    pub phase: String,
    pub processed: usize,
    pub total: usize,
    pub labels_found: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExhibitScanRequest {
    pub directory: String,
    #[serde(default)]
    pub selected_paths: Vec<String>,
    /// "auto" | "label_before" | "label_after"
    #[serde(default = "default_match_direction")]
    pub match_direction: String,
    #[serde(default = "default_true")]
    pub skip_already_renamed: bool,
}

fn default_match_direction() -> String {
    "auto".to_string()
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExhibitRenamePairInput {
    pub source_path: String,
    pub target_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedRenamePair {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExhibitApplyResult {
    pub renamed_photos: usize,
    pub renamed_companions: usize,
    pub failed: Vec<String>,
    pub completed_pairs: Vec<CompletedRenamePair>,
    pub manifest_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExhibitUndoResult {
    pub restored: usize,
    pub failed: Vec<String>,
}

fn is_raw_ext(ext: &str) -> bool {
    matches!(
        ext,
        "arw"
            | "cr2"
            | "cr3"
            | "nef"
            | "nrw"
            | "raf"
            | "orf"
            | "rw2"
            | "pef"
            | "srw"
            | "dcr"
            | "kdc"
            | "3fr"
            | "iiq"
            | "x3f"
            | "dng"
    )
}

fn is_scannable_photo_ext(ext: &str) -> bool {
    matches!(
        ext,
        "jpg" | "jpeg" | "heic" | "heif" | "png" | "webp" | "tif" | "tiff" | "avif"
    ) || is_raw_ext(ext)
}

fn count_han_chars(text: &str) -> usize {
    text.chars()
        .filter(|&c| {
            ('\u{4E00}'..='\u{9FFF}').contains(&c) || ('\u{3400}'..='\u{4DBF}').contains(&c)
        })
        .count()
}

fn is_mostly_ascii_or_english(text: &str) -> bool {
    let han = count_han_chars(text);
    if han > 0 {
        return false;
    }
    let ascii_alpha = text.chars().filter(|c| c.is_ascii_alphabetic()).count();
    ascii_alpha >= 3
}

static CAMERA_CODE_END_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)(?:^|[-_\s])((?:_?DSC|IMG|DSCF|DSCN|DJI|P\d{2}|A7[A-Z0-9]?|R\d|L1\d{2}|CR\d)[_-]?\d{3,6}(?:_\d+)?)$",
    )
    .expect("camera code regex")
});

static CAMERA_SEQ_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(\d{3,6})").expect("seq regex"));

/// Extract original camera code (preserving suffixes like `_1`) and detect whether
/// the photo already carries a descriptive museum prefix.
pub fn inspect_camera_stem(stem: &str) -> (String, bool) {
    if let Some(caps) = CAMERA_CODE_END_RE.captures(stem) {
        if let Some(m) = caps.get(1) {
            let code = m.as_str().to_string();
            let prefix = stem[..m.start()].trim_end_matches(['-', '_', ' ']);
            let already_renamed = !prefix.is_empty() && count_han_chars(prefix) >= 2;
            return (code, already_renamed);
        }
    }
    let already_renamed = stem.contains('-') && count_han_chars(stem) >= 3;
    (stem.to_string(), already_renamed)
}

fn extract_camera_sequence(camera_stem: &str) -> Option<u64> {
    CAMERA_SEQ_RE
        .captures_iter(camera_stem)
        .last()
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<u64>().ok())
}

static MULTI_CHAR_ERA_REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(旧石器时代|新石器时代(?:早|中|晚)?期?|良渚文化|红山文化|龙山文化|仰韶文化|河姆渡文化|马家浜文化|崧泽文化|大汶口文化|凌家滩文化|石家河文化|二里头文化|齐家文化|三星堆(?:文化)?|金沙遗址|夏代|殷商|晚商|商代(?:早|中|晚)?期?|西周(?:早|中|晚)?期?|东周|春秋(?:早|中|晚)?期?|战国(?:早|中|晚)?期?|秦代|西汉(?:早|中|晚)?期?|东汉(?:早|中|晚)?期?|新莽|汉代(?:早|中|晚)?期?|三国[·・\s]?[吴魏蜀]|三国|西晋|东晋|两晋|十六国|南北朝|北魏|东魏|西魏|北齐|北周|南朝[·・\s]?[宋齐梁陈]?|隋代|初唐|盛唐|中唐|晚唐|唐代|五代十国|五代|吴越国?|南唐|北宋|南宋|两宋|宋代|辽代|金代|西夏|元代|明(?:洪武|永乐|宣德|正统|景泰|天顺|成化|弘治|正德|嘉靖|隆庆|万历|天启|崇祯)|明代(?:早|中|晚)?期?|清(?:顺治|康熙|雍正|乾隆|嘉庆|道光|咸丰|同治|光绪|宣统)|清代(?:早|中|晚)?期?|中华民国|民国|近代|现代|当代|\d{1,2}世纪(?:上叶|中叶|下叶|早期|中期|晚期)?|(?:公元前?)?\d{3,4}年|距今约?[0-9一二三四五六七八九十万千百]+年)",
    )
    .expect("multi-char era regex")
});

static STANDALONE_SINGLE_DYNASTY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(夏|商|秦|汉|隋|唐|宋|辽|金|元|明|清)(?:代)?(?:\s*[（(][^）)]{2,30}[）)])?$")
        .expect("standalone dynasty regex")
});

static PREFIX_SINGLE_DYNASTY_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(夏|商|秦|汉|隋|唐|宋|辽|金|元|明|清)(?:代)?[\s·・:：]+")
        .expect("prefix dynasty regex")
});

fn extract_era_from_line(raw: &str, allow_inline_prefix: bool) -> Option<(String, String)> {
    let era_line = raw
        .trim()
        .strip_prefix("年代：")
        .or_else(|| raw.trim().strip_prefix("年代:"))
        .or_else(|| raw.trim().strip_prefix("时代："))
        .or_else(|| raw.trim().strip_prefix("时代:"))
        .unwrap_or(raw.trim())
        .trim();

    if let Some(caps) = STANDALONE_SINGLE_DYNASTY_RE.captures(era_line) {
        if let Some(m) = caps.get(1) {
            return Some((normalize_era(m.as_str()), String::new()));
        }
    }

    if let Some(m) = MULTI_CHAR_ERA_REGEX.find(era_line) {
        // Check if line is essentially pure era (with optional parenthetical year range like "北宋（960-1127）")
        let rest_raw = format!("{}{}", &era_line[..m.start()], &era_line[m.end()..]);
        let rest_clean = rest_raw.replace(
            |c: char| {
                matches!(
                    c,
                    '（' | '）' | '(' | ')' | '-' | '—' | '~' | '～' | ' ' | '·' | '・'
                )
            },
            "",
        );
        let is_pure_era = count_han_chars(&rest_clean) == 0;
        if is_pure_era || (allow_inline_prefix && m.start() == 0 && era_line.chars().count() <= 26)
        {
            return Some((normalize_era(m.as_str()), rest_raw.trim().to_string()));
        }
    }

    if allow_inline_prefix {
        if let Some(caps) = PREFIX_SINGLE_DYNASTY_RE.captures(era_line) {
            if let (Some(full), Some(dynasty)) = (caps.get(0), caps.get(1)) {
                let rest = era_line[full.end()..].trim().to_string();
                return Some((normalize_era(dynasty.as_str()), rest));
            }
        }
    }

    None
}

static PROVENANCE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?:出土地点?|来源|采集地|发掘地点?)[:：]?\s*([^\n，。；;]{2,36})|([^\s，。；;：:]{2,32}(?:出土|采集|征集))",
    )
    .expect("provenance regex")
});

static COLLECTION_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?:收藏单位|藏品来源|馆藏单位|收藏)[:：]\s*([^\n，。；;]{2,36})|([^\s，。；;：:]{2,32}(?:博物馆|博物院|考古研究所|文物考古研究所|考古研究院|文物研究院|文管所|文物局|纪念馆|美术馆|图书馆)(?:藏|收藏|馆藏))",
    )
    .expect("collection regex")
});

static ACCESSION_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?:编号|藏品号|馆藏号|登记号|总登记号|No\.?)[:：\s]*([A-Za-z0-9,./\-_]{3,28})")
        .expect("accession regex")
});

static DIMENSION_OR_META_LINE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"^(?:通?高|长|宽|厚|口径|底径|腹径|直径|重|尺寸|质地|材质|文物级别|等级|说明|简介|展柜|展品编号|Dimensions?|Size|Height|Length|Width|Diameter|Material|Collection|Provenance)",
    )
    .expect("dimension regex")
});

static NUMBERED_ITEM_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(?:(\d{1,2})\s*[.、．)）]|([①②③④⑤⑥⑦⑧⑨⑩]))\s*(.+)$").expect("num regex")
});

fn normalize_era(raw: &str) -> String {
    raw.trim()
        .replace(['·', '・', ' '], "")
        .trim_end_matches('代')
        .to_string()
}

fn clean_field_text(raw: &str) -> String {
    raw.trim()
        .trim_matches(|c: char| {
            matches!(
                c,
                '：' | ':' | '，' | ',' | '。' | '.' | '；' | ';' | '（' | '）' | '(' | ')' | '-'
            )
        })
        .replace(
            ['/', '\\', ':', '*', '?', '"', '<', '>', '|', '\n', '\r'],
            "",
        )
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("")
}

fn strip_leading_label_prefix(line: &str) -> &str {
    for prefix in [
        "展品名称：",
        "展品名称:",
        "文物名称：",
        "文物名称:",
        "名称：",
        "名称:",
        "品名：",
        "品名:",
        "题名：",
        "题名:",
    ] {
        if let Some(rest) = line.strip_prefix(prefix) {
            return rest.trim();
        }
    }
    line.trim()
}

/// Parse OCR lines from an exhibit plaque into structured fields and detect
/// whether the plaque covers multiple artifacts (`is_shared_card`).
pub fn parse_exhibit_label_lines(
    lines: &[OcrTextLine],
) -> (ParsedExhibitEntry, Vec<ParsedExhibitEntry>, bool) {
    let full_text = lines
        .iter()
        .map(|l| l.text.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    let mut era = String::new();
    let mut provenance = String::new();
    let mut collection = String::new();
    let mut accession_number = String::new();

    // 1. Detect numbered multi-artifact entries on a shared card
    let mut numbered_entries: Vec<ParsedExhibitEntry> = Vec::new();
    for line in lines {
        let trimmed = line.text.trim();
        if let Some(caps) = NUMBERED_ITEM_RE.captures(trimmed) {
            let body = caps.get(3).map(|m| m.as_str()).unwrap_or("").trim();
            if count_han_chars(body) >= 2 && !DIMENSION_OR_META_LINE_RE.is_match(body) {
                let mut item = ParsedExhibitEntry::default();
                let mut residual = body.to_string();
                if let Some((found_era, rest)) = extract_era_from_line(&residual, true) {
                    item.era = found_era;
                    residual = rest;
                }
                if let Some(c) = PROVENANCE_RE.captures(&residual) {
                    let prov = c
                        .get(1)
                        .or_else(|| c.get(2))
                        .map(|m| m.as_str())
                        .unwrap_or("");
                    item.provenance = clean_field_text(prov);
                    residual = residual.replacen(prov, " ", 1);
                }
                if let Some(c) = COLLECTION_RE.captures(&residual) {
                    let col = c
                        .get(1)
                        .or_else(|| c.get(2))
                        .map(|m| m.as_str())
                        .unwrap_or("");
                    item.collection = normalize_collection(col);
                    residual = residual.replacen(col, " ", 1);
                }
                item.name = clean_object_name(&residual);
                if !item.name.is_empty() {
                    numbered_entries.push(item);
                }
            }
        }
    }

    // 2. Global metadata scan across all lines + count pure-era lines (detects unnumbered shared cards)
    let mut pure_era_line_indices: Vec<usize> = Vec::new();
    for (idx, line) in lines.iter().enumerate() {
        let trimmed = line.text.trim();
        if trimmed.is_empty() || is_mostly_ascii_or_english(trimmed) {
            continue;
        }
        if accession_number.is_empty() {
            if let Some(caps) = ACCESSION_RE.captures(trimmed) {
                if let Some(m) = caps.get(1) {
                    accession_number = m.as_str().trim().to_string();
                }
            }
        }
        if provenance.is_empty() {
            if let Some(caps) = PROVENANCE_RE.captures(trimmed) {
                if let Some(m) = caps.get(1).or_else(|| caps.get(2)) {
                    let candidate = clean_field_text(m.as_str());
                    if count_han_chars(&candidate) >= 2 {
                        provenance = candidate;
                    }
                }
            }
        }
        if collection.is_empty() {
            if let Some(caps) = COLLECTION_RE.captures(trimmed) {
                if let Some(m) = caps.get(1).or_else(|| caps.get(2)) {
                    let candidate = normalize_collection(m.as_str());
                    if count_han_chars(&candidate) >= 3 {
                        collection = candidate;
                    }
                }
            }
        }
        if let Some((found_era, _)) = extract_era_from_line(trimmed, false) {
            pure_era_line_indices.push(idx);
            if era.is_empty() {
                era = found_era;
            }
        }
    }

    // Fallback: inline era prefix such as "良渚文化 玉琮" when no dedicated era line existed
    if era.is_empty() {
        for line in lines {
            let trimmed = line.text.trim();
            if trimmed.is_empty() || is_mostly_ascii_or_english(trimmed) {
                continue;
            }
            if let Some((found_era, _)) = extract_era_from_line(trimmed, true) {
                era = found_era;
                break;
            }
        }
    }

    // Helper: check whether a line is a valid Chinese title candidate
    let extract_title_candidate = |line: &OcrTextLine| -> Option<(String, bool)> {
        let raw = line.text.trim();
        if raw.is_empty() || is_mostly_ascii_or_english(raw) {
            return None;
        }
        let stripped = strip_leading_label_prefix(raw);
        let explicit_name_prefix = stripped.len() < raw.len();
        if !explicit_name_prefix && DIMENSION_OR_META_LINE_RE.is_match(stripped) {
            return None;
        }
        let without_era = if !explicit_name_prefix {
            if let Some((_, rest)) = extract_era_from_line(stripped, true) {
                rest
            } else {
                stripped.to_string()
            }
        } else {
            stripped.to_string()
        };
        let cleaned_candidate = clean_object_name(&without_era);
        let han_count = count_han_chars(&cleaned_candidate);
        if han_count < 2 || cleaned_candidate.chars().count() > 28 {
            return None;
        }
        if !provenance.is_empty() && cleaned_candidate == provenance {
            return None;
        }
        if !collection.is_empty()
            && (cleaned_candidate == collection
                || cleaned_candidate == collection.trim_end_matches('藏'))
        {
            return None;
        }
        if cleaned_candidate.ends_with("出土")
            || cleaned_candidate.ends_with("采集")
            || cleaned_candidate.ends_with("博物馆藏")
            || cleaned_candidate.ends_with("博物院藏")
            || cleaned_candidate.ends_with("研究所藏")
            || cleaned_candidate.ends_with("研究院藏")
        {
            return None;
        }
        if stripped.contains('。') || (stripped.contains('，') && stripped.chars().count() > 16) {
            return None;
        }
        Some((cleaned_candidate, explicit_name_prefix))
    };

    // 3. Pick primary Chinese object name (preferring explicit label, then largest/topmost Chinese title)
    let mut best_name = String::new();
    let mut best_idx: Option<usize> = None;
    let mut best_score = f64::NEG_INFINITY;

    for (idx, line) in lines.iter().enumerate() {
        let Some((cleaned_candidate, explicit_name_prefix)) = extract_title_candidate(line) else {
            continue;
        };
        let height_score = line.height * 120.0;
        let position_score = (1.0 - (idx as f64 / (lines.len().max(1) as f64))) * 4.0;
        let explicit_bonus = if explicit_name_prefix { 20.0 } else { 0.0 };
        let conf_bonus = line.confidence * 2.0;
        let score = height_score + position_score + explicit_bonus + conf_bonus;
        if score > best_score {
            best_score = score;
            best_name = cleaned_candidate;
            best_idx = Some(idx);
        }
    }

    // Merge wrapped two-line Chinese title (e.g. "铜胎掐丝珐琅" directly above "狮子戏球纹双耳炉")
    if let Some(idx) = best_idx {
        if idx > 0 {
            let cur = &lines[idx];
            let prev = &lines[idx - 1];
            let vertical_gap = cur.y - (prev.y + prev.height);
            if prev.height >= cur.height * 0.68
                && vertical_gap >= -cur.height * 0.4
                && vertical_gap <= cur.height * 1.1
            {
                if let Some((prev_title, _)) = extract_title_candidate(prev) {
                    if prev_title.chars().count() <= 14
                        && (prev_title.chars().count() + best_name.chars().count()) <= 28
                        && prev_title != best_name
                    {
                        best_name = format!("{prev_title}{best_name}");
                    }
                }
            }
        }
    }

    let primary = ParsedExhibitEntry {
        era: era.clone(),
        name: best_name,
        provenance: provenance.clone(),
        collection: collection.clone(),
        accession_number: accession_number.clone(),
    };

    // Detect shared multi-artifact cards: numbered list OR multiple distinct era sections on one card
    let is_shared_card = numbered_entries.len() >= 2
        || pure_era_line_indices.len() >= 2
        || (full_text.contains("左：") && full_text.contains("右："))
        || (full_text.contains("上：") && full_text.contains("下："));

    let mut candidates = Vec::new();
    if numbered_entries.len() >= 2 {
        for mut sub in numbered_entries {
            if sub.era.is_empty() {
                sub.era = era.clone();
            }
            if sub.provenance.is_empty() {
                sub.provenance = provenance.clone();
            }
            if sub.collection.is_empty() {
                sub.collection = collection.clone();
            }
            candidates.push(sub);
        }
    } else if pure_era_line_indices.len() >= 2 {
        // Extract distinct prominent titles for unnumbered multi-object display cards
        let mut seen_names: HashSet<String> = HashSet::new();
        let max_h = lines.iter().map(|l| l.height).fold(0.0f64, f64::max);
        if !primary.name.is_empty() {
            seen_names.insert(primary.name.clone());
            candidates.push(primary.clone());
        }
        for (idx, line) in lines.iter().enumerate() {
            if line.height < max_h * 0.65 {
                continue;
            }
            if let Some((title, _)) = extract_title_candidate(line) {
                if seen_names
                    .iter()
                    .any(|n| n.contains(&title) || title.contains(n.as_str()))
                {
                    continue;
                }
                let mut merged = title;
                if idx > 0 {
                    let prev = &lines[idx - 1];
                    let gap = line.y - (prev.y + prev.height);
                    if prev.height >= line.height * 0.68
                        && gap >= -line.height * 0.4
                        && gap <= line.height * 1.1
                    {
                        if let Some((prev_t, _)) = extract_title_candidate(prev) {
                            if prev_t.chars().count() <= 14 && prev_t != merged {
                                merged = format!("{prev_t}{merged}");
                            }
                        }
                    }
                }
                if seen_names.insert(merged.clone()) {
                    candidates.push(ParsedExhibitEntry {
                        era: era.clone(),
                        name: merged,
                        provenance: provenance.clone(),
                        collection: collection.clone(),
                        accession_number: String::new(),
                    });
                }
            }
        }
    } else if !primary.name.is_empty() {
        candidates.push(primary.clone());
    }

    let final_primary = if !primary.name.is_empty() {
        primary
    } else {
        candidates.first().cloned().unwrap_or_default()
    };

    (final_primary, candidates, is_shared_card)
}

fn normalize_collection(raw: &str) -> String {
    let mut cleaned = clean_field_text(raw);
    if cleaned.ends_with("馆藏") {
        cleaned = format!("{}藏", cleaned.trim_end_matches("馆藏"));
    } else if cleaned.ends_with("收藏") {
        cleaned = format!("{}藏", cleaned.trim_end_matches("收藏"));
    } else if (cleaned.ends_with("博物馆")
        || cleaned.ends_with("博物院")
        || cleaned.ends_with("研究所")
        || cleaned.ends_with("研究院")
        || cleaned.ends_with("纪念馆")
        || cleaned.ends_with("美术馆"))
        && !cleaned.ends_with('藏')
    {
        cleaned.push('藏');
    }
    cleaned
}

fn clean_object_name(raw: &str) -> String {
    let trimmed = raw.trim();
    let trimmed = NUMBERED_ITEM_RE
        .captures(trimmed)
        .and_then(|c| c.get(3))
        .map(|m| m.as_str())
        .unwrap_or(trimmed);
    // Drop trailing English words when OCR merges Chinese title + English subtitle on one line
    let mut chinese_part = String::new();
    let mut seen_han = false;
    let mut ascii_run = 0usize;
    for ch in trimmed.chars() {
        if ('\u{4E00}'..='\u{9FFF}').contains(&ch) || ('\u{3400}'..='\u{4DBF}').contains(&ch) {
            seen_han = true;
            ascii_run = 0;
            chinese_part.push(ch);
        } else if ch.is_ascii_alphabetic() {
            ascii_run += 1;
            if seen_han && ascii_run >= 4 {
                // Trim the trailing English characters we just pushed
                let keep_len = chinese_part
                    .len()
                    .saturating_sub(ascii_run.saturating_sub(1));
                chinese_part.truncate(keep_len);
                break;
            }
            chinese_part.push(ch);
        } else {
            ascii_run = 0;
            chinese_part.push(ch);
        }
    }
    clean_field_text(&chinese_part)
}

/// Build filename following `SKILL.md` naming contract:
/// `时代-名称-出土地-馆藏-原图片名.ext` (omitting any unknown/empty field).
pub fn build_exhibit_filename(
    entry: &ParsedExhibitEntry,
    camera_stem: &str,
    extension: &str,
) -> Option<String> {
    if entry.name.trim().is_empty() {
        return None;
    }
    let mut parts: Vec<String> = Vec::with_capacity(5);
    for field in [
        &entry.era,
        &entry.name,
        &entry.provenance,
        &entry.collection,
    ] {
        let cleaned = clean_field_text(field);
        if !cleaned.is_empty() {
            parts.push(cleaned);
        }
    }
    if parts.is_empty() {
        return None;
    }
    parts.push(camera_stem.trim().to_string());
    let joined = parts.join("-");
    if extension.is_empty() {
        Some(joined)
    } else {
        Some(format!("{joined}.{extension}"))
    }
}

/// Classify whether a photo is a dedicated exhibit label, an artifact photo
/// containing an in-frame readable label, or a pure artifact photo.
pub fn classify_ocr_role(
    lines: &[OcrTextLine],
    parsed: &ParsedExhibitEntry,
) -> (&'static str, f64) {
    if lines.is_empty() {
        return ("artifact", 0.0);
    }

    let total_han: usize = lines.iter().map(|l| count_han_chars(&l.text)).sum();
    let total_chars: usize = lines.iter().map(|l| l.text.chars().count()).sum();
    let text_area: f64 = lines.iter().map(|l| (l.width * l.height).max(0.0)).sum();
    let avg_conf: f64 = lines.iter().map(|l| l.confidence).sum::<f64>() / (lines.len() as f64);

    let mut metadata_signals = 0u32;
    if !parsed.era.is_empty() {
        metadata_signals += 1;
    }
    if !parsed.name.is_empty() {
        metadata_signals += 1;
    }
    if !parsed.provenance.is_empty() {
        metadata_signals += 1;
    }
    if !parsed.collection.is_empty() {
        metadata_signals += 1;
    }
    if !parsed.accession_number.is_empty() {
        metadata_signals += 1;
    }

    // Dedicated exhibit plaque: structured museum metadata OR substantial text block covering the frame
    let is_dedicated_label = (metadata_signals >= 2 && total_han >= 5 && text_area >= 0.012)
        || (total_han >= 18 && lines.len() >= 3 && text_area >= 0.025)
        || (total_chars >= 40 && lines.len() >= 4 && text_area >= 0.03);

    if is_dedicated_label {
        let score = (avg_conf * 0.6 + (metadata_signals as f64 * 0.12).min(0.4)).min(1.0);
        return ("label", score);
    }

    // Artifact photo with a legible in-frame label corner
    if metadata_signals >= 2 && total_han >= 4 && !parsed.name.is_empty() {
        return ("artifact_with_label", (avg_conf * 0.7).min(0.85));
    }

    ("artifact", 0.0)
}

#[cfg(target_os = "macos")]
fn recognize_text_for_photo(path: &Path, accurate: bool) -> Vec<OcrTextLine> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    let mut out_len: usize = 0;
    let mut ptr: *mut u8 = std::ptr::null_mut();

    if is_raw_ext(&ext) {
        if let Some(embedded) = crate::raw_preview::extract_embedded_jpeg_from_path(path) {
            ptr = unsafe {
                imageexplorer_recognize_text_from_bytes(
                    embedded.as_ptr(),
                    embedded.len(),
                    if accurate { 1 } else { 0 },
                    &mut out_len,
                )
            };
        }
    }

    if ptr.is_null() {
        if let Ok(c_path) = CString::new(path.to_string_lossy().as_bytes()) {
            ptr = unsafe {
                imageexplorer_recognize_text(
                    c_path.as_ptr(),
                    if accurate { 1 } else { 0 },
                    &mut out_len,
                )
            };
        }
    }

    if ptr.is_null() || out_len == 0 {
        return Vec::new();
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) }.to_vec();
    unsafe { imageexplorer_free_thumbnail(ptr) };
    serde_json::from_slice::<Vec<OcrTextLine>>(&bytes).unwrap_or_default()
}

#[cfg(not(target_os = "macos"))]
fn recognize_text_for_photo(_path: &Path, _accurate: bool) -> Vec<OcrTextLine> {
    Vec::new()
}

fn parse_exif_datetime_secs(raw: &str) -> Option<i64> {
    // "YYYY:MM:DD HH:MM:SS"
    let s = raw.trim();
    if s.len() < 19 {
        return None;
    }
    let y: i32 = s[0..4].parse().ok()?;
    let mo: u32 = s[5..7].parse().ok()?;
    let d: u32 = s[8..10].parse().ok()?;
    let h: u32 = s[11..13].parse().ok()?;
    let mi: u32 = s[14..16].parse().ok()?;
    let se: u32 = s[17..19].parse().ok()?;
    if !(1970..=2200).contains(&y) || !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return None;
    }
    // Days since 1970-01-01 using Howard Hinnant's civil-from-days inverse
    let y_adj = y - i32::from(mo <= 2);
    let era = y_adj.div_euclid(400);
    let yoe = (y_adj - era * 400) as u32;
    let m_adj = if mo > 2 { mo - 3 } else { mo + 9 };
    let doy = (153 * m_adj + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era as i64 * 146_097 + doe as i64 - 719_468;
    Some(days * 86_400 + h as i64 * 3600 + mi as i64 * 60 + se as i64)
}

#[cfg(target_os = "macos")]
fn read_captured_at_secs(path: &Path) -> Option<i64> {
    let c_path = CString::new(path.to_string_lossy().as_bytes()).ok()?;
    let mut len: usize = 0;
    let ptr = unsafe { imageexplorer_image_metadata(c_path.as_ptr(), &mut len) };
    if ptr.is_null() || len == 0 {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
    unsafe { imageexplorer_free_thumbnail(ptr) };
    let val: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    val.get("capturedAt")
        .and_then(|v| v.as_str())
        .and_then(parse_exif_datetime_secs)
}

#[cfg(not(target_os = "macos"))]
fn read_captured_at_secs(_path: &Path) -> Option<i64> {
    None
}

struct ScannedPhoto {
    path: PathBuf,
    file_name: String,
    stem: String,
    extension: String,
    camera_stem: String,
    camera_seq: Option<u64>,
    already_renamed: bool,
    captured_at: Option<i64>,
    modified: Option<i64>,
    size: u64,
    companions: Vec<String>,
    ocr_lines: Vec<OcrTextLine>,
    role: String,
    label_confidence: f64,
    parsed_primary: ParsedExhibitEntry,
    parsed_candidates: Vec<ParsedExhibitEntry>,
    is_shared_card: bool,
}

fn find_companion_files(
    dir: &Path,
    stem: &str,
    existing_names: &HashMap<String, String>,
) -> Vec<String> {
    let mut found = Vec::new();
    for ext in COMPANION_EXTS {
        let lower_key = format!("{stem}.{ext}").to_lowercase();
        if let Some(actual_name) = existing_names.get(&lower_key) {
            let full = dir.join(actual_name);
            if full.is_file() {
                found.push(actual_name.clone());
            }
        }
    }
    found
}

fn scan_directory_sync(
    app: &AppHandle,
    scan_id: u64,
    cancel: &Arc<AtomicBool>,
    request: ExhibitScanRequest,
) -> Result<ExhibitScanResult, String> {
    let dir = PathBuf::from(&request.directory);
    if !dir.is_dir() {
        return Err("Target directory does not exist".to_string());
    }

    let selected_set: HashSet<PathBuf> = request.selected_paths.iter().map(PathBuf::from).collect();
    let filter_by_selection = !selected_set.is_empty();

    let mut all_dir_names: HashMap<String, String> = HashMap::new();
    let mut candidate_paths: Vec<(PathBuf, u64, Option<i64>)> = Vec::new();

    for entry in fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read directory: {e}"))?
        .flatten()
    {
        let os_name = entry.file_name();
        let name = os_name.to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        all_dir_names.insert(name.to_lowercase(), name.clone());

        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        if !is_scannable_photo_ext(&ext) {
            continue;
        }
        if filter_by_selection && !selected_set.contains(&path) {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);
        candidate_paths.push((path, meta.len(), modified));
    }

    let total = candidate_paths.len();
    let _ = app.emit(
        "exhibit-label-progress",
        ExhibitScanProgressEvent {
            scan_id,
            phase: "ocr".to_string(),
            processed: 0,
            total,
            labels_found: 0,
        },
    );

    let use_two_pass = total > 40;
    let processed_counter = AtomicUsize::new(0);
    let labels_counter = AtomicUsize::new(0);

    let mut scanned: Vec<ScannedPhoto> = candidate_paths
        .par_iter()
        .filter_map(|(path, size, modified)| {
            if cancel.load(Ordering::Acquire) {
                return None;
            }
            let file_name = path.file_name()?.to_string_lossy().into_owned();
            let extension = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_string();
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or(&file_name)
                .to_string();
            let (camera_stem, already_renamed) = inspect_camera_stem(&stem);
            let camera_seq = extract_camera_sequence(&camera_stem);
            let captured_at = read_captured_at_secs(path);
            let companions = find_companion_files(&dir, &stem, &all_dir_names);

            // Fast screen on large folders, then upgrade text-bearing frames to Accurate OCR
            let mut ocr_lines = recognize_text_for_photo(path, !use_two_pass);
            if use_two_pass && !ocr_lines.is_empty() && !cancel.load(Ordering::Acquire) {
                let han_hint: usize = ocr_lines.iter().map(|l| count_han_chars(&l.text)).sum();
                if han_hint >= 3 || ocr_lines.len() >= 2 {
                    let accurate_lines = recognize_text_for_photo(path, true);
                    if !accurate_lines.is_empty() {
                        ocr_lines = accurate_lines;
                    }
                }
            }

            let (parsed_primary, parsed_candidates, is_shared_card) =
                parse_exhibit_label_lines(&ocr_lines);
            let (role, label_confidence) = classify_ocr_role(&ocr_lines, &parsed_primary);

            if role == "label" {
                labels_counter.fetch_add(1, Ordering::Relaxed);
            }
            let done = processed_counter.fetch_add(1, Ordering::Relaxed) + 1;
            if done == total || done.is_multiple_of(4) {
                let _ = app.emit(
                    "exhibit-label-progress",
                    ExhibitScanProgressEvent {
                        scan_id,
                        phase: "ocr".to_string(),
                        processed: done,
                        total,
                        labels_found: labels_counter.load(Ordering::Relaxed),
                    },
                );
            }

            Some(ScannedPhoto {
                path: path.clone(),
                file_name,
                stem,
                extension,
                camera_stem,
                camera_seq,
                already_renamed,
                captured_at,
                modified: *modified,
                size: *size,
                companions,
                ocr_lines,
                role: role.to_string(),
                label_confidence,
                parsed_primary,
                parsed_candidates,
                is_shared_card,
            })
        })
        .collect();

    if cancel.load(Ordering::Acquire) {
        return Ok(ExhibitScanResult {
            scan_id,
            directory: request.directory,
            cancelled: true,
            total_photos: total,
            labels: Vec::new(),
            proposals: Vec::new(),
        });
    }

    // Sort strictly chronologically: EXIF capture time -> camera sequence number -> modified -> name
    scanned.sort_by(|a, b| {
        let ta = a.captured_at.or(a.modified).unwrap_or(0);
        let tb = b.captured_at.or(b.modified).unwrap_or(0);
        ta.cmp(&tb)
            .then_with(|| a.camera_seq.cmp(&b.camera_seq))
            .then_with(|| a.stem.cmp(&b.stem))
    });

    // Build ExhibitLabelGroup catalog for all detected label frames
    let mut labels: Vec<ExhibitLabelGroup> = Vec::new();
    let mut label_indices: Vec<(usize, usize)> = Vec::new(); // (scanned_idx, label_vec_idx)

    for (idx, photo) in scanned.iter().enumerate() {
        if photo.role == "label" || photo.role == "artifact_with_label" {
            let label_id = format!("label-{}", labels.len() + 1);
            let raw_text = photo
                .ocr_lines
                .iter()
                .map(|l| l.text.trim())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            let label_vec_idx = labels.len();
            labels.push(ExhibitLabelGroup {
                label_id,
                label_path: photo.path.to_string_lossy().into_owned(),
                label_name: photo.file_name.clone(),
                captured_at: photo.captured_at.or(photo.modified),
                raw_text,
                confidence: photo.label_confidence,
                is_shared_card: photo.is_shared_card,
                primary_entry: photo.parsed_primary.clone(),
                candidate_entries: photo.parsed_candidates.clone(),
            });
            if photo.role == "label" {
                label_indices.push((idx, label_vec_idx));
            }
        }
    }

    // Associate each photo with its best exhibit label
    let mut proposals: Vec<ExhibitPhotoProposal> = Vec::with_capacity(scanned.len());
    let direction = request.match_direction.as_str();

    for (idx, photo) in scanned.iter().enumerate() {
        let ocr_snippet: String = photo
            .ocr_lines
            .iter()
            .take(4)
            .map(|l| l.text.trim())
            .collect::<Vec<_>>()
            .join(" / ");
        let photo_ts = photo.captured_at.or(photo.modified);

        if photo.role == "label" {
            let own_label = labels
                .iter()
                .find(|l| l.label_path == photo.path.to_string_lossy())
                .cloned();
            proposals.push(ExhibitPhotoProposal {
                path: photo.path.to_string_lossy().into_owned(),
                file_name: photo.file_name.clone(),
                extension: photo.extension.clone(),
                camera_stem: photo.camera_stem.clone(),
                already_renamed: photo.already_renamed,
                captured_at: photo.captured_at,
                modified: photo.modified,
                size: photo.size,
                role: "label".to_string(),
                status: "label_photo".to_string(),
                matched_label_id: own_label.as_ref().map(|l| l.label_id.clone()),
                matched_entry_index: 0,
                proposed_entry: own_label.as_ref().map(|l| l.primary_entry.clone()),
                proposed_name: own_label.as_ref().and_then(|l| {
                    build_exhibit_filename(&l.primary_entry, &photo.camera_stem, &photo.extension)
                }),
                evidence_note: if photo.is_shared_card {
                    "展牌原图（多件文物共享展牌）".to_string()
                } else {
                    "展牌原图（默认不重命名）".to_string()
                },
                time_delta_secs: Some(0),
                companion_files: photo.companions.clone(),
                ocr_snippet,
            });
            continue;
        }

        if photo.already_renamed && request.skip_already_renamed {
            proposals.push(ExhibitPhotoProposal {
                path: photo.path.to_string_lossy().into_owned(),
                file_name: photo.file_name.clone(),
                extension: photo.extension.clone(),
                camera_stem: photo.camera_stem.clone(),
                already_renamed: true,
                captured_at: photo.captured_at,
                modified: photo.modified,
                size: photo.size,
                role: photo.role.clone(),
                status: "already_renamed".to_string(),
                matched_label_id: None,
                matched_entry_index: 0,
                proposed_entry: None,
                proposed_name: None,
                evidence_note: "已包含文物名称，自动跳过".to_string(),
                time_delta_secs: None,
                companion_files: photo.companions.clone(),
                ocr_snippet,
            });
            continue;
        }

        // If the artifact photo itself contains a legible in-frame exhibit label
        if photo.role == "artifact_with_label" && !photo.parsed_primary.name.is_empty() {
            let own_label = labels
                .iter()
                .find(|l| l.label_path == photo.path.to_string_lossy())
                .cloned();
            let proposed_name =
                build_exhibit_filename(&photo.parsed_primary, &photo.camera_stem, &photo.extension);
            let status = if photo.is_shared_card || photo.label_confidence < 0.55 {
                "uncertain"
            } else {
                "matched"
            };
            proposals.push(ExhibitPhotoProposal {
                path: photo.path.to_string_lossy().into_owned(),
                file_name: photo.file_name.clone(),
                extension: photo.extension.clone(),
                camera_stem: photo.camera_stem.clone(),
                already_renamed: photo.already_renamed,
                captured_at: photo.captured_at,
                modified: photo.modified,
                size: photo.size,
                role: "artifact_with_label".to_string(),
                status: status.to_string(),
                matched_label_id: own_label.map(|l| l.label_id),
                matched_entry_index: 0,
                proposed_entry: Some(photo.parsed_primary.clone()),
                proposed_name,
                evidence_note: "画面内识别到展牌文字".to_string(),
                time_delta_secs: Some(0),
                companion_files: photo.companions.clone(),
                ocr_snippet,
            });
            continue;
        }

        // Find nearest preceding & following dedicated label frames
        let prev_label = label_indices
            .iter()
            .rev()
            .find(|(scan_i, _)| *scan_i < idx)
            .copied();
        let next_label = label_indices
            .iter()
            .find(|(scan_i, _)| *scan_i > idx)
            .copied();

        let delta_for = |label_scan_idx: usize| -> i64 {
            let l_ts = scanned[label_scan_idx]
                .captured_at
                .or(scanned[label_scan_idx].modified);
            match (photo_ts, l_ts) {
                (Some(a), Some(b)) => (a - b).abs(),
                _ => ((idx as i64 - label_scan_idx as i64).abs()) * 30,
            }
        };

        let chosen: Option<(usize, &'static str, i64)> = match direction {
            "label_before" => prev_label.map(|(si, li)| (li, "前方展牌", delta_for(si))),
            "label_after" => next_label.map(|(si, li)| (li, "后方展牌", delta_for(si))),
            _ => match (prev_label, next_label) {
                (Some((psi, pli)), Some((nsi, nli))) => {
                    let dp = delta_for(psi);
                    let dn = delta_for(nsi);
                    // Slight preference for preceding label when both are within 3 minutes
                    if dp <= dn.saturating_add(15) || (dp <= 180 && dp <= dn * 2) {
                        Some((pli, "前方展牌", dp))
                    } else {
                        Some((nli, "后方展牌", dn))
                    }
                }
                (Some((psi, pli)), None) => Some((pli, "前方展牌", delta_for(psi))),
                (None, Some((nsi, nli))) => Some((nli, "后方展牌", delta_for(nsi))),
                (None, None) => None,
            },
        };

        if let Some((label_idx, side_label, delta_secs)) = chosen {
            let label = &labels[label_idx];
            let entry = &label.primary_entry;
            let proposed_name = build_exhibit_filename(entry, &photo.camera_stem, &photo.extension);

            let (status, note) = if proposed_name.is_none() {
                (
                    "uncertain",
                    format!("{side_label}（{delta_secs}s）未提取到文物名称，请手动补充"),
                )
            } else if label.is_shared_card {
                (
                    "uncertain",
                    format!("{side_label}（{delta_secs}s）为多件文物共享展牌，请核对具体对应项"),
                )
            } else if delta_secs > 300 {
                (
                    "uncertain",
                    format!(
                        "{side_label}间隔较长（{}分{}秒），请人工确认",
                        delta_secs / 60,
                        delta_secs % 60
                    ),
                )
            } else if label.confidence < 0.45 {
                (
                    "uncertain",
                    format!("{side_label}（{delta_secs}s）OCR 置信度偏低，请核对"),
                )
            } else {
                (
                    "matched",
                    format!(
                        "匹配{side_label}（间隔 {delta_secs}s）· {}",
                        label.label_name
                    ),
                )
            };

            proposals.push(ExhibitPhotoProposal {
                path: photo.path.to_string_lossy().into_owned(),
                file_name: photo.file_name.clone(),
                extension: photo.extension.clone(),
                camera_stem: photo.camera_stem.clone(),
                already_renamed: photo.already_renamed,
                captured_at: photo.captured_at,
                modified: photo.modified,
                size: photo.size,
                role: "artifact".to_string(),
                status: status.to_string(),
                matched_label_id: Some(label.label_id.clone()),
                matched_entry_index: 0,
                proposed_entry: Some(entry.clone()),
                proposed_name,
                evidence_note: note,
                time_delta_secs: Some(delta_secs),
                companion_files: photo.companions.clone(),
                ocr_snippet,
            });
        } else {
            proposals.push(ExhibitPhotoProposal {
                path: photo.path.to_string_lossy().into_owned(),
                file_name: photo.file_name.clone(),
                extension: photo.extension.clone(),
                camera_stem: photo.camera_stem.clone(),
                already_renamed: photo.already_renamed,
                captured_at: photo.captured_at,
                modified: photo.modified,
                size: photo.size,
                role: "artifact".to_string(),
                status: "unmatched".to_string(),
                matched_label_id: None,
                matched_entry_index: 0,
                proposed_entry: None,
                proposed_name: None,
                evidence_note: "附近未检测到可识别展牌".to_string(),
                time_delta_secs: None,
                companion_files: photo.companions.clone(),
                ocr_snippet,
            });
        }
    }

    Ok(ExhibitScanResult {
        scan_id,
        directory: request.directory,
        cancelled: false,
        total_photos: total,
        labels,
        proposals,
    })
}

#[tauri::command]
pub async fn scan_exhibit_labels(
    app: AppHandle,
    request: ExhibitScanRequest,
) -> Result<ExhibitScanResult, String> {
    let scan_id = ACTIVE_SCAN_ID.fetch_add(1, Ordering::AcqRel) + 1;
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut guard) = ACTIVE_SCAN_CANCEL.lock() {
        if let Some(prev) = guard.replace(cancel.clone()) {
            prev.store(true, Ordering::Release);
        }
    }

    tauri::async_runtime::spawn_blocking(move || {
        scan_directory_sync(&app, scan_id, &cancel, request)
    })
    .await
    .map_err(|e| format!("Exhibit label scan task failed: {e}"))?
}

#[tauri::command]
pub fn cancel_exhibit_label_scan() {
    if let Ok(guard) = ACTIVE_SCAN_CANCEL.lock() {
        if let Some(flag) = guard.as_ref() {
            flag.store(true, Ordering::Release);
        }
    }
}

fn validate_target_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return Err("Target filename cannot be empty".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains('\0') {
        return Err("Target filename contains invalid path characters".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn apply_exhibit_label_renames(
    app: AppHandle,
    items: Vec<ExhibitRenamePairInput>,
    rename_companions: bool,
) -> Result<ExhibitApplyResult, String> {
    let log_dir = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("exhibit_rename_logs"));

    tauri::async_runtime::spawn_blocking(move || {
        let mut planned_ops: Vec<(PathBuf, PathBuf, bool)> = Vec::new();
        let mut seen_targets: HashSet<String> = HashSet::new();
        let mut errors: Vec<String> = Vec::new();

        for item in &items {
            let src = PathBuf::from(&item.source_path);
            if !src.is_file() {
                errors.push(format!("{}: 源文件不存在", item.source_path));
                continue;
            }
            if let Err(err) = validate_target_name(&item.target_name) {
                errors.push(format!("{}: {err}", item.target_name));
                continue;
            }
            let Some(parent) = src.parent() else {
                errors.push(format!("{}: 无效路径", item.source_path));
                continue;
            };
            let dst = parent.join(item.target_name.trim());
            if src == dst {
                continue;
            }
            let dst_key = dst.to_string_lossy().to_lowercase();
            if !seen_targets.insert(dst_key) {
                errors.push(format!("目标文件名冲突: {}", item.target_name));
                continue;
            }
            if dst.exists() {
                errors.push(format!("目标已存在，跳过以避免覆盖: {}", item.target_name));
                continue;
            }
            planned_ops.push((src.clone(), dst.clone(), false));

            if rename_companions {
                let src_stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                let dst_stem = dst.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                if !src_stem.is_empty() && !dst_stem.is_empty() {
                    if let Ok(entries) = fs::read_dir(parent) {
                        for dir_entry in entries.flatten() {
                            let name = dir_entry.file_name().to_string_lossy().into_owned();
                            if name.starts_with('.') {
                                continue;
                            }
                            let candidate = dir_entry.path();
                            let c_ext =
                                candidate.extension().and_then(|e| e.to_str()).unwrap_or("");
                            let c_stem =
                                candidate.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                            if c_stem == src_stem
                                && COMPANION_EXTS
                                    .iter()
                                    .any(|allowed| allowed.eq_ignore_ascii_case(c_ext))
                            {
                                let comp_dst = parent.join(format!("{dst_stem}.{c_ext}"));
                                let comp_key = comp_dst.to_string_lossy().to_lowercase();
                                if !comp_dst.exists() && seen_targets.insert(comp_key) {
                                    planned_ops.push((candidate, comp_dst, true));
                                }
                            }
                        }
                    }
                }
            }
        }

        if !errors.is_empty() && planned_ops.is_empty() {
            return Ok(ExhibitApplyResult {
                renamed_photos: 0,
                renamed_companions: 0,
                failed: errors,
                completed_pairs: Vec::new(),
                manifest_path: None,
            });
        }

        let mut renamed_photos = 0usize;
        let mut renamed_companions = 0usize;
        let mut completed_pairs: Vec<CompletedRenamePair> = Vec::new();

        for (src, dst, is_companion) in planned_ops {
            match fs::rename(&src, &dst) {
                Ok(()) => {
                    if is_companion {
                        renamed_companions += 1;
                    } else {
                        renamed_photos += 1;
                    }
                    completed_pairs.push(CompletedRenamePair {
                        from: src.to_string_lossy().into_owned(),
                        to: dst.to_string_lossy().into_owned(),
                    });
                }
                Err(err) => {
                    errors.push(format!("{}: {err}", src.display()));
                }
            }
        }

        // Write durable manifest log so any batch is auditable & recoverable
        let manifest_path = if !completed_pairs.is_empty() {
            if let Some(dir) = log_dir {
                let _ = fs::create_dir_all(&dir);
                let ts = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let path = dir.join(format!("exhibit-rename-{ts}.json"));
                if let Ok(json) = serde_json::to_string_pretty(&completed_pairs) {
                    if fs::write(&path, json).is_ok() {
                        Some(path.to_string_lossy().into_owned())
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        Ok(ExhibitApplyResult {
            renamed_photos,
            renamed_companions,
            failed: errors,
            completed_pairs,
            manifest_path,
        })
    })
    .await
    .map_err(|e| format!("Exhibit rename apply task failed: {e}"))?
}

#[tauri::command]
pub async fn undo_exhibit_label_renames(
    pairs: Vec<CompletedRenamePair>,
) -> Result<ExhibitUndoResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut restored = 0usize;
        let mut failed = Vec::new();
        for pair in pairs.into_iter().rev() {
            let current = PathBuf::from(&pair.to);
            let original = PathBuf::from(&pair.from);
            if !current.exists() {
                failed.push(format!("文件不存在，无法撤销: {}", pair.to));
                continue;
            }
            if original.exists() {
                failed.push(format!("原路径已被占用: {}", pair.from));
                continue;
            }
            match fs::rename(&current, &original) {
                Ok(()) => restored += 1,
                Err(err) => failed.push(format!("{}: {err}", pair.to)),
            }
        }
        Ok(ExhibitUndoResult { restored, failed })
    })
    .await
    .map_err(|e| format!("Exhibit rename undo task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str, y: f64, height: f64) -> OcrTextLine {
        OcrTextLine {
            text: text.to_string(),
            confidence: 0.95,
            x: 0.1,
            y,
            width: 0.6,
            height,
        }
    }

    #[test]
    fn parses_real_chinese_museum_exhibit_label_and_builds_contract_filename() {
        let lines = vec![
            line("玉琮", 0.15, 0.08),
            line("良渚文化", 0.28, 0.045),
            line("浙江桐乡普安桥M11出土", 0.38, 0.04),
            line("浙江省文物考古研究所藏", 0.46, 0.04),
            line("Jade Cong", 0.58, 0.03),
            line("Liangzhu Culture", 0.64, 0.025),
        ];

        let (primary, candidates, is_shared) = parse_exhibit_label_lines(&lines);
        assert!(!is_shared);
        assert_eq!(candidates.len(), 1);
        assert_eq!(primary.era, "良渚文化");
        assert_eq!(primary.name, "玉琮");
        assert_eq!(primary.provenance, "浙江桐乡普安桥M11出土");
        assert_eq!(primary.collection, "浙江省文物考古研究所藏");

        let filename = build_exhibit_filename(&primary, "DSC00658", "ARW").unwrap();
        assert_eq!(
            filename,
            "良渚文化-玉琮-浙江桐乡普安桥M11出土-浙江省文物考古研究所藏-DSC00658.ARW"
        );
    }

    #[test]
    fn omits_unknown_fields_and_preserves_suffix_per_skill_contract() {
        let lines = vec![
            line("银鎏金莲花宝子香炉", 0.12, 0.07),
            line("北宋", 0.25, 0.045),
            line("长干寺长干塔地宫出土", 0.35, 0.04),
        ];
        let (primary, _, is_shared) = parse_exhibit_label_lines(&lines);
        assert!(!is_shared);
        assert_eq!(primary.collection, "");
        let filename = build_exhibit_filename(&primary, "DSC00119_1", "ARW").unwrap();
        assert_eq!(
            filename,
            "北宋-银鎏金莲花宝子香炉-长干寺长干塔地宫出土-DSC00119_1.ARW"
        );
    }

    #[test]
    fn detects_shared_multi_artifact_card_and_extracts_all_candidates() {
        let lines = vec![
            line("1. 良渚文化 玉璧", 0.12, 0.05),
            line("2. 良渚文化 玉钺", 0.24, 0.05),
            line("3. 良渚文化 三叉形器", 0.36, 0.05),
            line("良渚博物院藏", 0.50, 0.04),
        ];
        let (_primary, candidates, is_shared) = parse_exhibit_label_lines(&lines);
        assert!(is_shared);
        assert_eq!(candidates.len(), 3);
        assert_eq!(candidates[0].name, "玉璧");
        assert_eq!(candidates[1].name, "玉钺");
        assert_eq!(candidates[2].name, "三叉形器");
        assert_eq!(candidates[0].collection, "良渚博物院藏");
    }

    #[test]
    fn merges_wrapped_two_line_title_and_flags_unnumbered_multi_era_shared_card() {
        let lines = vec![
            line("明代", 0.08, 0.025),
            line("缠枝葡萄纹香炉", 0.14, 0.075),
            line("铜胎掐丝珐琅", 0.34, 0.076),
            line("狮子戏球纹双耳炉", 0.43, 0.087),
            line("明代", 0.56, 0.036),
            line("南京博物院藏", 0.62, 0.03),
        ];
        let (primary, candidates, is_shared) = parse_exhibit_label_lines(&lines);
        assert!(is_shared);
        assert_eq!(primary.era, "明");
        assert_eq!(primary.name, "铜胎掐丝珐琅狮子戏球纹双耳炉");
        assert_eq!(primary.collection, "南京博物院藏");
        assert!(candidates.len() >= 2);
        assert!(candidates.iter().any(|c| c.name.contains("缠枝葡萄纹香炉")));
    }

    #[test]
    fn inspects_camera_stem_and_detects_already_renamed_museum_files() {
        assert_eq!(
            inspect_camera_stem("DSC00019"),
            ("DSC00019".to_string(), false)
        );
        assert_eq!(
            inspect_camera_stem("DSC00019_1"),
            ("DSC00019_1".to_string(), false)
        );
        assert_eq!(
            inspect_camera_stem(
                "三国吴-宫闱宴乐图漆案-朱然墓出土-马鞍山市三国朱然家族墓地博物馆藏-DSC09077"
            ),
            ("DSC09077".to_string(), true)
        );
        assert_eq!(
            inspect_camera_stem("18世纪-英国斯塔福德郡蓝白瓷盘中式庭塔纹饰-DSC00080"),
            ("DSC00080".to_string(), true)
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "Manual read-only smoke test against local museum RAW sample folder"]
    fn real_museum_sample_ocr_smoke() {
        let dir = Path::new("/Volumes/2024.345/2026.11.14 马鞍山+朝天宫+大报恩寺+15良渚临安");
        if !dir.is_dir() {
            return;
        }
        let samples = [
            "DSC00003.ARW",
            "DSC00004.ARW",
            "DSC00010.ARW",
            "DSC00011.ARW",
            "DSC00012.ARW",
            "DSC00015.ARW",
            "DSC00016.ARW",
            "DSC00018.ARW",
            "DSC00019.ARW",
            "DSC00020.ARW",
        ];
        for name in samples {
            let p = dir.join(name);
            if !p.is_file() {
                continue;
            }
            let lines = recognize_text_for_photo(&p, true);
            let (parsed, cands, shared) = parse_exhibit_label_lines(&lines);
            let (role, conf) = classify_ocr_role(&lines, &parsed);
            println!(
                "{name}: role={role} conf={conf:.2} shared={shared} cands={} era={:?} name={:?} prov={:?} col={:?} lines={}",
                cands.len(),
                parsed.era,
                parsed.name,
                parsed.provenance,
                parsed.collection,
                lines.len()
            );
            for l in lines.iter().take(6) {
                println!("   [h={:.3} c={:.2}] {}", l.height, l.confidence, l.text);
            }
        }
    }
}
