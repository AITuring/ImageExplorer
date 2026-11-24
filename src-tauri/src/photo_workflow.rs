use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "macos")]
use std::ffi::{CStr, CString};

#[cfg(target_os = "macos")]
extern "C" {
    fn imageexplorer_detect_faces(path: *const libc::c_char, out_length: *mut usize) -> *mut u8;
    fn imageexplorer_detect_faces_from_bytes(
        bytes: *const u8,
        length: usize,
        out_length: *mut usize,
    ) -> *mut u8;
    fn imageexplorer_export_image(
        src_path: *const libc::c_char,
        dst_path: *const libc::c_char,
        format: *const libc::c_char,
        max_edge: u32,
        quality: f64,
        strip_gps: libc::c_int,
        out_error: *mut *mut libc::c_char,
    ) -> libc::c_int;
    fn imageexplorer_image_metadata(path: *const libc::c_char, length: *mut usize) -> *mut u8;
    fn imageexplorer_rotate_image(
        path: *const libc::c_char,
        clockwise: libc::c_int,
        out_error: *mut *mut libc::c_char,
    ) -> libc::c_int;
    fn imageexplorer_share_files(
        paths_json: *const libc::c_char,
        out_error: *mut *mut libc::c_char,
    ) -> libc::c_int;
    fn imageexplorer_free_thumbnail(bytes: *mut u8);
    fn imageexplorer_free_c_string(value: *mut libc::c_char);
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedFace {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub eye_x: f64,
    pub eye_y: f64,
    pub left_eye: Option<[f64; 2]>,
    pub right_eye: Option<[f64; 2]>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchExportRequest {
    pub paths: Vec<String>,
    pub dest_dir: String,
    pub format: String,
    pub max_edge: u32,
    pub quality: f64,
    pub strip_gps: bool,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchExportResult {
    pub exported: usize,
    pub skipped: usize,
    pub failed: Vec<String>,
    pub dest_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SdIngestFolderSummary {
    pub folder: String,
    pub count: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SdIngestPlan {
    pub source_dir: String,
    pub dest_dir: String,
    pub total_files: usize,
    pub total_bytes: u64,
    pub duplicate_count: usize,
    pub photo_count: usize,
    pub raw_count: usize,
    pub video_count: usize,
    pub folders: Vec<SdIngestFolderSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SdIngestResult {
    pub copied: usize,
    pub skipped: usize,
    pub failed: Vec<String>,
    pub dest_dir: String,
    pub first_folder: Option<String>,
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

fn is_photo_ext(ext: &str) -> bool {
    matches!(
        ext,
        "jpg" | "jpeg" | "heic" | "heif" | "png" | "webp" | "tif" | "tiff" | "avif"
    ) || is_raw_ext(ext)
}

fn is_video_ext(ext: &str) -> bool {
    matches!(ext, "mp4" | "mov" | "m4v" | "mts" | "m2ts" | "avi" | "mkv")
}

fn is_ingestible_media(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if is_raw_ext(&ext) {
        Some("raw")
    } else if is_photo_ext(&ext) {
        Some("photo")
    } else if is_video_ext(&ext) {
        Some("video")
    } else {
        None
    }
}

/// Parse EXIF `YYYY:MM:DD HH:MM:SS` or ISO `YYYY-MM-DD...` into `(year, month, day)`.
pub fn parse_exif_ymd(raw: &str) -> Option<(i32, u32, u32)> {
    let trimmed = raw.trim();
    if trimmed.len() < 10 {
        return None;
    }
    let bytes = trimmed.as_bytes();
    if !((bytes[4] == b':' || bytes[4] == b'-') && (bytes[7] == b':' || bytes[7] == b'-')) {
        return None;
    }
    let year: i32 = trimmed[0..4].parse().ok()?;
    let month: u32 = trimmed[5..7].parse().ok()?;
    let day: u32 = trimmed[8..10].parse().ok()?;
    if !(1970..=2200).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some((year, month, day))
}

#[cfg(unix)]
fn unix_seconds_to_local_ymd(secs: i64) -> (i32, u32, u32) {
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let t = secs as libc::time_t;
    let ok = unsafe { !libc::localtime_r(&t, &mut tm).is_null() };
    if ok {
        (tm.tm_year + 1900, (tm.tm_mon + 1) as u32, tm.tm_mday as u32)
    } else {
        (1970, 1, 1)
    }
}

#[cfg(not(unix))]
fn unix_seconds_to_local_ymd(_secs: i64) -> (i32, u32, u32) {
    (1970, 1, 1)
}

#[cfg(target_os = "macos")]
fn read_exif_captured_at(path: &Path) -> Option<String> {
    let c_path = CString::new(path.to_string_lossy().as_bytes()).ok()?;
    let mut len: usize = 0;
    let ptr = unsafe { imageexplorer_image_metadata(c_path.as_ptr(), &mut len) };
    if ptr.is_null() || len == 0 {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
    unsafe { imageexplorer_free_thumbnail(ptr) };
    let parsed: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    parsed
        .get("capturedAt")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

#[cfg(not(target_os = "macos"))]
fn read_exif_captured_at(_path: &Path) -> Option<String> {
    None
}

fn determine_media_ymd(path: &Path, modified: Option<SystemTime>) -> (i32, u32, u32) {
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        if is_photo_ext(&ext.to_ascii_lowercase()) {
            if let Some(captured) = read_exif_captured_at(path) {
                if let Some(ymd) = parse_exif_ymd(&captured) {
                    return ymd;
                }
            }
        }
    }
    let secs = modified
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    unix_seconds_to_local_ymd(secs)
}

pub fn build_ingest_destination(
    dest_root: &Path,
    ymd: (i32, u32, u32),
    file_name: &str,
    rename_prefix_date: bool,
) -> (String, PathBuf) {
    let (y, m, d) = ymd;
    let rel_folder = format!("{y:04}/{y:04}-{m:02}-{d:02}");
    let target_name = if rename_prefix_date {
        let prefix = format!("{y:04}{m:02}{d:02}_");
        if file_name.starts_with(&prefix) {
            file_name.to_string()
        } else {
            format!("{prefix}{file_name}")
        }
    } else {
        file_name.to_string()
    };
    let full_path = dest_root.join(&rel_folder).join(target_name);
    (rel_folder, full_path)
}

fn collect_media_files_recursive(
    dir: &Path,
    out: &mut Vec<(PathBuf, &'static str, u64, Option<SystemTime>)>,
) {
    let Ok(read_dir) = fs::read_dir(dir) else {
        return;
    };
    for entry in read_dir.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            collect_media_files_recursive(&path, out);
        } else if meta.is_file() {
            if let Some(kind) = is_ingestible_media(&path) {
                out.push((path, kind, meta.len(), meta.modified().ok()));
            }
        }
    }
}

fn unique_destination_path(target: &Path) -> PathBuf {
    if !target.exists() {
        return target.to_path_buf();
    }
    let parent = target.parent().unwrap_or_else(|| Path::new(""));
    let stem = target
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let ext = target.extension().and_then(|e| e.to_str());
    for idx in 1..10_000 {
        let candidate_name = match ext {
            Some(e) if !e.is_empty() => format!("{stem}_{idx}.{e}"),
            _ => format!("{stem}_{idx}"),
        };
        let candidate = parent.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
    }
    target.to_path_buf()
}

#[cfg(target_os = "macos")]
fn detect_faces_blocking(path: &str) -> Result<Vec<DetectedFace>, String> {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    let mut out_len: usize = 0;
    let mut ptr: *mut u8 = std::ptr::null_mut();

    if is_raw_ext(&ext) {
        if let Some(embedded) = crate::raw_preview::extract_embedded_jpeg_from_path(Path::new(path))
        {
            ptr = unsafe {
                imageexplorer_detect_faces_from_bytes(
                    embedded.as_ptr(),
                    embedded.len(),
                    &mut out_len,
                )
            };
        }
    }

    if ptr.is_null() {
        let c_path = CString::new(path).map_err(|_| "Invalid file path".to_string())?;
        ptr = unsafe { imageexplorer_detect_faces(c_path.as_ptr(), &mut out_len) };
    }

    if ptr.is_null() || out_len == 0 {
        return Ok(Vec::new());
    }

    let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) }.to_vec();
    unsafe { imageexplorer_free_thumbnail(ptr) };

    serde_json::from_slice::<Vec<DetectedFace>>(&bytes)
        .map_err(|e| format!("Failed to parse face detection results: {e}"))
}

#[cfg(not(target_os = "macos"))]
fn detect_faces_blocking(_path: &str) -> Result<Vec<DetectedFace>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub async fn detect_photo_faces(path: String) -> Result<Vec<DetectedFace>, String> {
    tauri::async_runtime::spawn_blocking(move || detect_faces_blocking(&path))
        .await
        .map_err(|e| format!("Face detection task failed: {e}"))?
}

#[cfg(target_os = "macos")]
fn export_single_photo(
    src: &Path,
    dst: &Path,
    format: &str,
    max_edge: u32,
    quality: f64,
    strip_gps: bool,
) -> Result<(), String> {
    let c_src = CString::new(src.to_string_lossy().as_bytes())
        .map_err(|_| "Invalid source path".to_string())?;
    let c_dst = CString::new(dst.to_string_lossy().as_bytes())
        .map_err(|_| "Invalid destination path".to_string())?;
    let c_fmt = CString::new(format).map_err(|_| "Invalid format".to_string())?;
    let mut err_ptr: *mut libc::c_char = std::ptr::null_mut();

    let ok = unsafe {
        imageexplorer_export_image(
            c_src.as_ptr(),
            c_dst.as_ptr(),
            c_fmt.as_ptr(),
            max_edge,
            quality,
            if strip_gps { 1 } else { 0 },
            &mut err_ptr,
        )
    };

    if ok != 0 {
        return Ok(());
    }

    let message = if !err_ptr.is_null() {
        let msg = unsafe { CStr::from_ptr(err_ptr) }
            .to_string_lossy()
            .into_owned();
        unsafe { imageexplorer_free_c_string(err_ptr) };
        msg
    } else {
        "Image export failed".to_string()
    };
    Err(message)
}

#[cfg(not(target_os = "macos"))]
fn export_single_photo(
    _src: &Path,
    _dst: &Path,
    _format: &str,
    _max_edge: u32,
    _quality: f64,
    _strip_gps: bool,
) -> Result<(), String> {
    Err("Native image export is only supported on macOS".to_string())
}

#[tauri::command]
pub async fn batch_export_photos(request: BatchExportRequest) -> Result<BatchExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest_root = PathBuf::from(&request.dest_dir);
        fs::create_dir_all(&dest_root)
            .map_err(|e| format!("Failed to create destination folder: {e}"))?;

        let fmt = match request.format.to_ascii_lowercase().as_str() {
            "png" => "png",
            "heic" => "heic",
            _ => "jpeg",
        };
        let ext = match fmt {
            "png" => "png",
            "heic" => "heic",
            _ => "jpg",
        };

        // Pre-allocate unique output paths sequentially so parallel exports never collide.
        let mut jobs: Vec<(PathBuf, PathBuf)> = Vec::with_capacity(request.paths.len());
        let mut reserved: HashSet<PathBuf> = HashSet::new();
        for raw_path in &request.paths {
            let src = PathBuf::from(raw_path);
            let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("photo");
            let mut candidate = dest_root.join(format!("{stem}.{ext}"));
            if !request.overwrite {
                let mut counter = 1usize;
                while candidate.exists() || reserved.contains(&candidate) {
                    candidate = dest_root.join(format!("{stem}_{counter}.{ext}"));
                    counter += 1;
                }
            }
            reserved.insert(candidate.clone());
            jobs.push((src, candidate));
        }

        let outcomes: Vec<Result<(), String>> = jobs
            .par_iter()
            .map(|(src, dst)| {
                export_single_photo(
                    src,
                    dst,
                    fmt,
                    request.max_edge,
                    request.quality,
                    request.strip_gps,
                )
                .map_err(|err| {
                    let name = src
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("unknown");
                    format!("{name}: {err}")
                })
            })
            .collect();

        let mut exported = 0usize;
        let mut failed = Vec::new();
        for outcome in outcomes {
            match outcome {
                Ok(()) => exported += 1,
                Err(msg) => failed.push(msg),
            }
        }

        Ok(BatchExportResult {
            exported,
            skipped: 0,
            failed,
            dest_dir: request.dest_dir,
        })
    })
    .await
    .map_err(|e| format!("Batch export task failed: {e}"))?
}

fn plan_sd_ingest_sync(
    source_dir: String,
    dest_dir: String,
    rename_prefix_date: bool,
) -> Result<SdIngestPlan, String> {
    let source_path = PathBuf::from(&source_dir);
    if !source_path.is_dir() {
        return Err("Source directory does not exist".to_string());
    }
    let dest_root = PathBuf::from(&dest_dir);

    let mut media = Vec::new();
    collect_media_files_recursive(&source_path, &mut media);

    let items: Vec<(String, PathBuf, &'static str, u64)> = media
        .par_iter()
        .map(|(path, kind, size, modified)| {
            let ymd = determine_media_ymd(path, *modified);
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("media");
            let (rel_folder, target) =
                build_ingest_destination(&dest_root, ymd, name, rename_prefix_date);
            (rel_folder, target, *kind, *size)
        })
        .collect();

    let mut total_bytes = 0u64;
    let mut duplicate_count = 0usize;
    let mut photo_count = 0usize;
    let mut raw_count = 0usize;
    let mut video_count = 0usize;
    let mut by_folder: BTreeMap<String, (usize, u64)> = BTreeMap::new();

    for (folder, target, kind, size) in items {
        total_bytes = total_bytes.saturating_add(size);
        match kind {
            "raw" => raw_count += 1,
            "photo" => photo_count += 1,
            "video" => video_count += 1,
            _ => {}
        }
        if let Ok(existing) = fs::metadata(&target) {
            if existing.is_file() && existing.len() == size {
                duplicate_count += 1;
            }
        }
        let entry = by_folder.entry(folder).or_insert((0, 0));
        entry.0 += 1;
        entry.1 = entry.1.saturating_add(size);
    }

    let folders = by_folder
        .into_iter()
        .map(|(folder, (count, bytes))| SdIngestFolderSummary {
            folder,
            count,
            total_bytes: bytes,
        })
        .collect();

    Ok(SdIngestPlan {
        source_dir,
        dest_dir,
        total_files: media.len(),
        total_bytes,
        duplicate_count,
        photo_count,
        raw_count,
        video_count,
        folders,
    })
}

fn run_sd_ingest_sync(
    source_dir: String,
    dest_dir: String,
    rename_prefix_date: bool,
    skip_duplicates: bool,
) -> Result<SdIngestResult, String> {
    let source_path = PathBuf::from(&source_dir);
    if !source_path.is_dir() {
        return Err("Source directory does not exist".to_string());
    }
    let dest_root = PathBuf::from(&dest_dir);
    fs::create_dir_all(&dest_root)
        .map_err(|e| format!("Failed to create destination folder: {e}"))?;

    let mut media = Vec::new();
    collect_media_files_recursive(&source_path, &mut media);

    let planned: Vec<(PathBuf, String, PathBuf, u64)> = media
        .par_iter()
        .map(|(path, _kind, size, modified)| {
            let ymd = determine_media_ymd(path, *modified);
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("media");
            let (rel_folder, target) =
                build_ingest_destination(&dest_root, ymd, name, rename_prefix_date);
            (path.clone(), rel_folder, target, *size)
        })
        .collect();

    let mut copied = 0usize;
    let mut skipped = 0usize;
    let mut failed = Vec::new();
    let mut first_folder: Option<String> = None;

    for (src, rel_folder, target, size) in planned {
        if skip_duplicates {
            if let Ok(existing) = fs::metadata(&target) {
                if existing.is_file() && existing.len() == size {
                    skipped += 1;
                    continue;
                }
            }
        }
        if let Some(parent) = target.parent() {
            if let Err(err) = fs::create_dir_all(parent) {
                failed.push(format!("{}: {err}", src.display()));
                continue;
            }
        }
        let final_target = unique_destination_path(&target);
        match fs::copy(&src, &final_target) {
            Ok(_) => {
                copied += 1;
                if first_folder.is_none() {
                    first_folder = Some(dest_root.join(&rel_folder).to_string_lossy().into_owned());
                }
            }
            Err(err) => {
                let name = src
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown");
                failed.push(format!("{name}: {err}"));
            }
        }
    }

    Ok(SdIngestResult {
        copied,
        skipped,
        failed,
        dest_dir,
        first_folder,
    })
}

#[tauri::command]
pub async fn plan_sd_ingest(
    source_dir: String,
    dest_dir: String,
    rename_prefix_date: bool,
) -> Result<SdIngestPlan, String> {
    tauri::async_runtime::spawn_blocking(move || {
        plan_sd_ingest_sync(source_dir, dest_dir, rename_prefix_date)
    })
    .await
    .map_err(|e| format!("SD ingest plan task failed: {e}"))?
}

#[tauri::command]
pub async fn run_sd_ingest(
    source_dir: String,
    dest_dir: String,
    rename_prefix_date: bool,
    skip_duplicates: bool,
) -> Result<SdIngestResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_sd_ingest_sync(source_dir, dest_dir, rename_prefix_date, skip_duplicates)
    })
    .await
    .map_err(|e| format!("SD ingest task failed: {e}"))?
}

#[derive(Debug, Clone, Default)]
pub struct RenameExifTokens {
    pub date_ymd: Option<String>,
    pub model: Option<String>,
    pub iso: Option<String>,
    pub focal: Option<String>,
}

fn sanitize_token(raw: &str) -> String {
    raw.trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else if c.is_whitespace() {
                '-'
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches(|c| c == '-' || c == '_')
        .to_string()
}

#[cfg(target_os = "macos")]
pub fn read_rename_exif_tokens(path: &Path) -> RenameExifTokens {
    let Ok(c_path) = CString::new(path.to_string_lossy().as_bytes()) else {
        return RenameExifTokens::default();
    };
    let mut len: usize = 0;
    let ptr = unsafe { imageexplorer_image_metadata(c_path.as_ptr(), &mut len) };
    if ptr.is_null() || len == 0 {
        return RenameExifTokens::default();
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
    unsafe { imageexplorer_free_thumbnail(ptr) };
    let Ok(parsed) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return RenameExifTokens::default();
    };
    let date_ymd = parsed
        .get("capturedAt")
        .and_then(|v| v.as_str())
        .and_then(parse_exif_ymd)
        .map(|(y, m, d)| format!("{y:04}{m:02}{d:02}"));
    let model = parsed
        .get("model")
        .and_then(|v| v.as_str())
        .map(sanitize_token)
        .filter(|s| !s.is_empty());
    let iso = parsed
        .get("iso")
        .and_then(|v| v.as_str())
        .map(|s| format!("ISO{}", sanitize_token(s)))
        .filter(|s| s.len() > 3);
    let focal = parsed
        .get("focalLength")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .map(|f| format!("{}mm", f.round() as i64));
    RenameExifTokens {
        date_ymd,
        model,
        iso,
        focal,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn read_rename_exif_tokens(_path: &Path) -> RenameExifTokens {
    RenameExifTokens::default()
}

pub fn file_mtime_ymd(path: &Path) -> String {
    let secs = fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (y, m, d) = unix_seconds_to_local_ymd(secs);
    format!("{y:04}{m:02}{d:02}")
}

#[cfg(target_os = "macos")]
fn rotate_image_blocking(path: &str, clockwise: bool) -> Result<(), String> {
    let c_path = CString::new(path).map_err(|_| "Invalid file path".to_string())?;
    let mut err_ptr: *mut libc::c_char = std::ptr::null_mut();
    let ok = unsafe {
        imageexplorer_rotate_image(c_path.as_ptr(), if clockwise { 1 } else { 0 }, &mut err_ptr)
    };
    if ok != 0 {
        return Ok(());
    }
    let message = if !err_ptr.is_null() {
        let msg = unsafe { CStr::from_ptr(err_ptr) }
            .to_string_lossy()
            .into_owned();
        unsafe { imageexplorer_free_c_string(err_ptr) };
        msg
    } else {
        "Image rotation failed".to_string()
    };
    Err(message)
}

#[cfg(not(target_os = "macos"))]
fn rotate_image_blocking(_path: &str, _clockwise: bool) -> Result<(), String> {
    Err("Image rotation is only supported on macOS".to_string())
}

#[tauri::command]
pub async fn rotate_image_file(path: String, clockwise: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || rotate_image_blocking(&path, clockwise))
        .await
        .map_err(|e| format!("Image rotation task failed: {e}"))?
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn share_files_native(paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let json = serde_json::to_string(&paths).map_err(|e| e.to_string())?;
    let c_json = CString::new(json).map_err(|_| "Invalid paths JSON".to_string())?;
    let mut err_ptr: *mut libc::c_char = std::ptr::null_mut();
    let ok = unsafe { imageexplorer_share_files(c_json.as_ptr(), &mut err_ptr) };
    if ok != 0 {
        return Ok(());
    }
    let message = if !err_ptr.is_null() {
        let msg = unsafe { CStr::from_ptr(err_ptr) }
            .to_string_lossy()
            .into_owned();
        unsafe { imageexplorer_free_c_string(err_ptr) };
        msg
    } else {
        "Unable to open macOS Share sheet".to_string()
    };
    Err(message)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn share_files_native(_paths: Vec<String>) -> Result<(), String> {
    Err("Native share sheet is only supported on macOS".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_exif_and_iso_capture_dates() {
        assert_eq!(parse_exif_ymd("2025:05:10 08:30:12"), Some((2025, 5, 10)));
        assert_eq!(parse_exif_ymd("2024-12-31T23:59:59"), Some((2024, 12, 31)));
        assert_eq!(parse_exif_ymd("invalid"), None);
    }

    #[test]
    fn builds_date_folder_and_optional_prefix_without_double_prefix() {
        let root = Path::new("/tmp/Photos");
        let (folder, dst) = build_ingest_destination(root, (2025, 7, 4), "DSC0001.ARW", false);
        assert_eq!(folder, "2025/2025-07-04");
        assert_eq!(
            dst,
            PathBuf::from("/tmp/Photos/2025/2025-07-04/DSC0001.ARW")
        );

        let (_, prefixed) = build_ingest_destination(root, (2025, 7, 4), "DSC0001.ARW", true);
        assert_eq!(
            prefixed,
            PathBuf::from("/tmp/Photos/2025/2025-07-04/20250704_DSC0001.ARW")
        );

        let (_, already_prefixed) =
            build_ingest_destination(root, (2025, 7, 4), "20250704_DSC0001.ARW", true);
        assert_eq!(
            already_prefixed,
            PathBuf::from("/tmp/Photos/2025/2025-07-04/20250704_DSC0001.ARW")
        );
    }

    #[test]
    fn sd_ingest_plans_copies_and_skips_duplicates() {
        let unique = format!(
            "ie_sd_ingest_{}_{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let base = std::env::temp_dir().join(unique);
        let dcim = base.join("SD/DCIM/100MSDCF");
        let dest = base.join("Library");
        fs::create_dir_all(&dcim).unwrap();
        fs::write(dcim.join("DSC00001.ARW"), vec![1u8; 64]).unwrap();
        fs::write(dcim.join("DSC00001.JPG"), vec![2u8; 32]).unwrap();
        fs::write(dcim.join("._DSC00001.JPG"), vec![3u8; 16]).unwrap(); // hidden AppleDouble ignored

        let plan = plan_sd_ingest_sync(
            base.join("SD").to_string_lossy().into_owned(),
            dest.to_string_lossy().into_owned(),
            true,
        )
        .unwrap();
        assert_eq!(plan.total_files, 2);
        assert_eq!(plan.raw_count, 1);
        assert_eq!(plan.photo_count, 1);
        assert_eq!(plan.duplicate_count, 0);

        let first_run = run_sd_ingest_sync(
            base.join("SD").to_string_lossy().into_owned(),
            dest.to_string_lossy().into_owned(),
            true,
            true,
        )
        .unwrap();
        assert_eq!(first_run.copied, 2);
        assert_eq!(first_run.skipped, 0);
        assert!(first_run.failed.is_empty());

        // Second run should detect both as duplicates and skip cleanly
        let second_plan = plan_sd_ingest_sync(
            base.join("SD").to_string_lossy().into_owned(),
            dest.to_string_lossy().into_owned(),
            true,
        )
        .unwrap();
        assert_eq!(second_plan.duplicate_count, 2);

        let second_run = run_sd_ingest_sync(
            base.join("SD").to_string_lossy().into_owned(),
            dest.to_string_lossy().into_owned(),
            true,
            true,
        )
        .unwrap();
        assert_eq!(second_run.copied, 0);
        assert_eq!(second_run.skipped, 2);

        let _ = fs::remove_dir_all(&base);
    }
}
