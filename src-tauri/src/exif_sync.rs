use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[cfg(target_os = "macos")]
use std::ffi::{CStr, CString};

#[cfg(target_os = "macos")]
extern "C" {
    fn imageexplorer_image_metadata(path: *const libc::c_char, length: *mut usize) -> *mut u8;
    fn imageexplorer_write_image_metadata(
        path: *const libc::c_char,
        patch_json: *const libc::c_char,
        overwrite_existing: libc::c_int,
        out_error: *mut *mut libc::c_char,
    ) -> libc::c_int;
    fn imageexplorer_free_thumbnail(bytes: *mut u8);
    fn imageexplorer_free_c_string(value: *mut libc::c_char);
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifFields {
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    pub iso: Option<String>,
    pub aperture: Option<String>,
    pub shutter_speed: Option<String>,
    pub focal_length: Option<String>,
    pub captured_at: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifPhotoAudit {
    pub path: String,
    pub file_name: String,
    pub extension: String,
    pub modified: Option<i64>,
    pub size: u64,
    pub writable: bool,
    pub metadata: ExifFields,
    pub missing_time: bool,
    pub missing_camera_lens: bool,
    pub missing_exposure: bool,
    pub missing_gps: bool,
    pub suggested_source_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifFolderInspection {
    pub directory: String,
    pub total_photos: usize,
    pub missing_exif_count: usize,
    pub missing_gps_count: usize,
    pub photos: Vec<ExifPhotoAudit>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifPatchItem {
    pub path: String,
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    pub iso: Option<String>,
    pub aperture: Option<String>,
    pub shutter_speed: Option<String>,
    pub focal_length: Option<String>,
    pub captured_at: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifSyncApplyRequest {
    pub items: Vec<ExifPatchItem>,
    pub overwrite_existing: bool,
    #[serde(default)]
    pub sync_file_mtime: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifSyncApplyResult {
    pub updated: usize,
    pub unchanged: usize,
    pub failed: Vec<String>,
    pub updated_paths: Vec<String>,
}

fn is_writable_exif_ext(ext: &str) -> bool {
    matches!(
        ext,
        "jpg" | "jpeg" | "heic" | "heif" | "png" | "tif" | "tiff"
    )
}

fn is_readable_photo_ext(ext: &str) -> bool {
    is_writable_exif_ext(ext)
        || matches!(
            ext,
            "webp"
                | "avif"
                | "arw"
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

/// Normalize `"2026-11-16T21:17:00"` or `"2026/11/16 21:17:00"` to EXIF `"2026:11:16 21:17:00"`.
pub fn normalize_exif_datetime(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.len() < 16 {
        return None;
    }
    let digits_and_sep = trimmed.replace('T', " ");
    let parts: Vec<&str> = digits_and_sep.split_whitespace().collect();
    if parts.len() < 2 {
        return None;
    }
    let date_parts: Vec<&str> = parts[0].split([':', '-', '/']).collect();
    let time_parts: Vec<&str> = parts[1].split(':').collect();
    if date_parts.len() != 3 || time_parts.len() < 2 {
        return None;
    }
    let y: u32 = date_parts[0].parse().ok()?;
    let mo: u32 = date_parts[1].parse().ok()?;
    let d: u32 = date_parts[2].parse().ok()?;
    let h: u32 = time_parts[0].parse().ok()?;
    let mi: u32 = time_parts[1].parse().ok()?;
    let se: u32 = time_parts
        .get(2)
        .and_then(|s| s.split('.').next())
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    if !(1900..=2200).contains(&y)
        || !(1..=12).contains(&mo)
        || !(1..=31).contains(&d)
        || h > 23
        || mi > 59
        || se > 59
    {
        return None;
    }
    Some(format!("{y:04}:{mo:02}:{d:02} {h:02}:{mi:02}:{se:02}"))
}

pub fn parse_positive_f64_field(raw: &str) -> Option<f64> {
    let cleaned = raw
        .trim()
        .trim_start_matches(['f', 'F', '/', 'I', 'S', 'O', ' '])
        .trim_end_matches(['m', 'M', 's', 'S', ' ']);
    if let Some((num_str, den_str)) = cleaned.split_once('/') {
        let num: f64 = num_str.trim().parse().ok()?;
        let den: f64 = den_str.trim().parse().ok()?;
        if num > 0.0 && den > 0.0 {
            return Some(num / den);
        }
        return None;
    }
    let val: f64 = cleaned.parse().ok()?;
    if val.is_finite() && val > 0.0 {
        Some(val)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
pub fn read_exif_fields_for_path(path: &Path) -> ExifFields {
    let Ok(c_path) = CString::new(path.to_string_lossy().as_bytes()) else {
        return ExifFields::default();
    };
    let mut len: usize = 0;
    let ptr = unsafe { imageexplorer_image_metadata(c_path.as_ptr(), &mut len) };
    if ptr.is_null() || len == 0 {
        return ExifFields::default();
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
    unsafe { imageexplorer_free_thumbnail(ptr) };
    let Ok(val) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return ExifFields::default();
    };
    let str_field = |k: &str| {
        val.get(k)
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    ExifFields {
        make: str_field("make"),
        model: str_field("model"),
        lens: str_field("lens"),
        iso: str_field("iso"),
        aperture: str_field("aperture"),
        shutter_speed: str_field("shutterSpeed"),
        focal_length: str_field("focalLength"),
        captured_at: str_field("capturedAt"),
        latitude: val.get("latitude").and_then(|v| v.as_f64()),
        longitude: val.get("longitude").and_then(|v| v.as_f64()),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn read_exif_fields_for_path(_path: &Path) -> ExifFields {
    ExifFields::default()
}

fn normalized_base_stem(stem: &str) -> String {
    // Strip trailing `_1`, `-1`, `_edit`, ` copy` suffixes to match PS outputs like `DSC01684_1.jpg` -> `DSC01684`
    let lower = stem.to_lowercase();
    if let Some((prefix, suffix)) = lower.rsplit_once('_') {
        if !prefix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()) {
            return prefix.to_string();
        }
    }
    lower
}

fn exif_completeness_score(m: &ExifFields) -> usize {
    let mut score = 0;
    if m.captured_at.is_some() {
        score += 3;
    }
    if m.model.is_some() || m.make.is_some() {
        score += 2;
    }
    if m.lens.is_some() {
        score += 2;
    }
    if m.iso.is_some() {
        score += 1;
    }
    if m.aperture.is_some() {
        score += 1;
    }
    if m.shutter_speed.is_some() {
        score += 1;
    }
    if m.focal_length.is_some() {
        score += 1;
    }
    if m.latitude.is_some() && m.longitude.is_some() {
        score += 2;
    }
    score
}

fn inspect_folder_exif_sync(
    directory: String,
    selected_paths: Vec<String>,
) -> Result<ExifFolderInspection, String> {
    let dir = PathBuf::from(&directory);
    if !dir.is_dir() {
        return Err("Target directory does not exist".to_string());
    }
    let selected_set: HashSet<PathBuf> = selected_paths.iter().map(PathBuf::from).collect();
    let filter_by_selection = !selected_set.is_empty();

    let mut all_files: Vec<(PathBuf, String, String, u64, Option<i64>)> = Vec::new();
    for entry in fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read directory: {e}"))?
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().into_owned();
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
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        if !is_readable_photo_ext(&ext) {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);
        all_files.push((path, name, ext, meta.len(), modified));
    }

    all_files.sort_by_key(|a| a.1.to_lowercase());

    let audited_all: Vec<ExifPhotoAudit> = all_files
        .par_iter()
        .map(|(path, name, ext, size, modified)| {
            let metadata = read_exif_fields_for_path(path);
            let missing_time = metadata.captured_at.is_none();
            let missing_camera_lens = metadata.model.is_none() && metadata.lens.is_none();
            let missing_exposure = metadata.iso.is_none()
                && metadata.aperture.is_none()
                && metadata.shutter_speed.is_none()
                && metadata.focal_length.is_none();
            let missing_gps = metadata.latitude.is_none() || metadata.longitude.is_none();
            ExifPhotoAudit {
                path: path.to_string_lossy().into_owned(),
                file_name: name.clone(),
                extension: ext.clone(),
                modified: *modified,
                size: *size,
                writable: is_writable_exif_ext(ext),
                metadata,
                missing_time,
                missing_camera_lens,
                missing_exposure,
                missing_gps,
                suggested_source_path: None,
            }
        })
        .collect();

    // Build stem -> richest EXIF photo lookup so e.g. `DSC01684_1.jpg` automatically suggests `DSC01684.jpg` / `.ARW`
    let mut best_by_base_stem: HashMap<String, (usize, String)> = HashMap::new();
    for item in &audited_all {
        let stem = Path::new(&item.file_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&item.file_name);
        let base = normalized_base_stem(stem);
        let score = exif_completeness_score(&item.metadata);
        if score >= 3 {
            match best_by_base_stem.get(&base) {
                Some((prev_score, _)) if *prev_score >= score => {}
                _ => {
                    best_by_base_stem.insert(base, (score, item.path.clone()));
                }
            }
        }
    }

    let mut photos: Vec<ExifPhotoAudit> = Vec::new();
    for mut item in audited_all {
        if filter_by_selection && !selected_set.contains(Path::new(&item.path)) {
            continue;
        }
        let stem = Path::new(&item.file_name)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&item.file_name);
        let base = normalized_base_stem(stem);
        let own_score = exif_completeness_score(&item.metadata);
        if let Some((best_score, best_path)) = best_by_base_stem.get(&base) {
            if best_path != &item.path && *best_score > own_score {
                item.suggested_source_path = Some(best_path.clone());
            }
        }
        photos.push(item);
    }

    let missing_exif_count = photos
        .iter()
        .filter(|p| p.missing_time || p.missing_camera_lens || p.missing_exposure)
        .count();
    let missing_gps_count = photos.iter().filter(|p| p.missing_gps).count();

    Ok(ExifFolderInspection {
        directory,
        total_photos: photos.len(),
        missing_exif_count,
        missing_gps_count,
        photos,
    })
}

#[cfg(unix)]
fn set_file_mtime_from_exif(path: &Path, exif_datetime: &str) {
    let parts: Vec<&str> = exif_datetime.split_whitespace().collect();
    if parts.len() < 2 {
        return;
    }
    let d: Vec<i32> = parts[0].split(':').filter_map(|s| s.parse().ok()).collect();
    let t: Vec<i32> = parts[1].split(':').filter_map(|s| s.parse().ok()).collect();
    if d.len() != 3 || t.len() != 3 {
        return;
    }
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    tm.tm_year = d[0] - 1900;
    tm.tm_mon = d[1] - 1;
    tm.tm_mday = d[2];
    tm.tm_hour = t[0];
    tm.tm_min = t[1];
    tm.tm_sec = t[2];
    tm.tm_isdst = -1;
    let secs = unsafe { libc::mktime(&mut tm) };
    if secs < 0 {
        return;
    }
    let Ok(c_path) = std::ffi::CString::new(path.to_string_lossy().as_bytes()) else {
        return;
    };
    let times = [
        libc::timeval {
            tv_sec: secs,
            tv_usec: 0,
        },
        libc::timeval {
            tv_sec: secs,
            tv_usec: 0,
        },
    ];
    unsafe {
        libc::utimes(c_path.as_ptr(), times.as_ptr());
    }
}

#[cfg(not(unix))]
fn set_file_mtime_from_exif(_path: &Path, _exif_datetime: &str) {}

fn build_native_patch_json(item: &ExifPatchItem) -> (serde_json::Value, Option<String>) {
    let mut map = serde_json::Map::new();
    if let Some(make) = item
        .make
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        map.insert("make".into(), serde_json::Value::String(make.to_string()));
    }
    if let Some(model) = item
        .model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        map.insert("model".into(), serde_json::Value::String(model.to_string()));
    }
    if let Some(lens) = item
        .lens
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        map.insert("lens".into(), serde_json::Value::String(lens.to_string()));
    }
    if let Some(iso) = item.iso.as_deref().and_then(parse_positive_f64_field) {
        map.insert("iso".into(), serde_json::json!(iso.round() as i64));
    }
    if let Some(ap) = item.aperture.as_deref().and_then(parse_positive_f64_field) {
        map.insert("aperture".into(), serde_json::json!(ap));
    }
    if let Some(sh) = item
        .shutter_speed
        .as_deref()
        .and_then(parse_positive_f64_field)
    {
        map.insert("shutterSpeed".into(), serde_json::json!(sh));
    }
    if let Some(fl) = item
        .focal_length
        .as_deref()
        .and_then(parse_positive_f64_field)
    {
        map.insert("focalLength".into(), serde_json::json!(fl));
    }
    let normalized_dt = item
        .captured_at
        .as_deref()
        .and_then(normalize_exif_datetime);
    if let Some(ref dt) = normalized_dt {
        map.insert("capturedAt".into(), serde_json::Value::String(dt.clone()));
    }
    if let (Some(lat), Some(lon)) = (item.latitude, item.longitude) {
        if (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon) {
            map.insert("latitude".into(), serde_json::json!(lat));
            map.insert("longitude".into(), serde_json::json!(lon));
        }
    }
    (serde_json::Value::Object(map), normalized_dt)
}

#[cfg(target_os = "macos")]
fn write_single_exif(
    item: &ExifPatchItem,
    overwrite_existing: bool,
    sync_file_mtime: bool,
) -> Result<bool, String> {
    let path = Path::new(&item.path);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if !is_writable_exif_ext(&ext) {
        return Err("当前格式不支持直接写入 EXIF（仅支持 JPG/HEIC/PNG/TIFF）".to_string());
    }
    let (patch_val, normalized_dt) = build_native_patch_json(item);
    let patch_json = serde_json::to_string(&patch_val).map_err(|e| e.to_string())?;
    let c_path = CString::new(item.path.as_bytes()).map_err(|_| "Invalid file path".to_string())?;
    let c_json = CString::new(patch_json).map_err(|_| "Invalid patch JSON".to_string())?;
    let mut err_ptr: *mut libc::c_char = std::ptr::null_mut();

    let status = unsafe {
        imageexplorer_write_image_metadata(
            c_path.as_ptr(),
            c_json.as_ptr(),
            if overwrite_existing { 1 } else { 0 },
            &mut err_ptr,
        )
    };

    if status == 2 {
        return Ok(false); // unchanged
    }
    if status == 1 {
        if sync_file_mtime {
            if let Some(ref dt) = normalized_dt {
                set_file_mtime_from_exif(path, dt);
            }
        }
        return Ok(true);
    }

    let message = if !err_ptr.is_null() {
        let msg = unsafe { CStr::from_ptr(err_ptr) }
            .to_string_lossy()
            .into_owned();
        unsafe { imageexplorer_free_c_string(err_ptr) };
        msg
    } else {
        "Failed to write EXIF metadata".to_string()
    };
    Err(message)
}

#[cfg(not(target_os = "macos"))]
fn write_single_exif(
    _item: &ExifPatchItem,
    _overwrite_existing: bool,
    _sync_file_mtime: bool,
) -> Result<bool, String> {
    Err("Native EXIF writing is only supported on macOS".to_string())
}

#[tauri::command]
pub async fn inspect_folder_exif(
    directory: String,
    selected_paths: Vec<String>,
) -> Result<ExifFolderInspection, String> {
    tauri::async_runtime::spawn_blocking(move || {
        inspect_folder_exif_sync(directory, selected_paths)
    })
    .await
    .map_err(|e| format!("EXIF inspection task failed: {e}"))?
}

#[tauri::command]
pub async fn read_reference_exif(path: String) -> Result<ExifFields, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.is_file() {
            return Err("Reference file does not exist".to_string());
        }
        Ok(read_exif_fields_for_path(&p))
    })
    .await
    .map_err(|e| format!("Reference EXIF task failed: {e}"))?
}

#[tauri::command]
pub async fn apply_exif_sync(request: ExifSyncApplyRequest) -> Result<ExifSyncApplyResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let results: Vec<(String, Result<bool, String>)> = request
            .items
            .par_iter()
            .map(|item| {
                let res =
                    write_single_exif(item, request.overwrite_existing, request.sync_file_mtime);
                (item.path.clone(), res)
            })
            .collect();

        let mut updated = 0usize;
        let mut unchanged = 0usize;
        let mut failed = Vec::new();
        let mut updated_paths = Vec::new();

        for (path, outcome) in results {
            match outcome {
                Ok(true) => {
                    updated += 1;
                    updated_paths.push(path);
                }
                Ok(false) => unchanged += 1,
                Err(err) => {
                    let name = Path::new(&path)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(&path);
                    failed.push(format!("{name}: {err}"));
                }
            }
        }

        Ok(ExifSyncApplyResult {
            updated,
            unchanged,
            failed,
            updated_paths,
        })
    })
    .await
    .map_err(|e| format!("EXIF sync apply task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_human_friendly_exif_datetime_and_exposure_strings() {
        assert_eq!(
            normalize_exif_datetime("2026-11-16T21:17:05"),
            Some("2026:11:16 21:17:05".to_string())
        );
        assert_eq!(
            normalize_exif_datetime("2026/11/16 09:05"),
            Some("2026:11:16 09:05:00".to_string())
        );
        assert!((parse_positive_f64_field("1/250").unwrap() - 0.004).abs() < 1e-6);
        assert!((parse_positive_f64_field("f/2.8").unwrap() - 2.8).abs() < 1e-6);
        assert!((parse_positive_f64_field("50mm").unwrap() - 50.0).abs() < 1e-6);
        assert!((parse_positive_f64_field("ISO 800").unwrap() - 800.0).abs() < 1e-6);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn losslessly_writes_and_reads_back_exif_and_gps_metadata() {
        use std::time::SystemTime;

        // Minimal valid 1x1 baseline JPEG generated by macOS ImageIO
        const TINY_JPEG: &[u8] = &[
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
            0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xFF, 0xE1, 0x00, 0x40, 0x45, 0x78, 0x69, 0x66,
            0x00, 0x00, 0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x87, 0x69,
            0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x1A, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x02, 0xA0, 0x02, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0xA0, 0x03, 0x00, 0x04, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00,
            0x00, 0x00, 0xFF, 0xED, 0x00, 0x38, 0x50, 0x68, 0x6F, 0x74, 0x6F, 0x73, 0x68, 0x6F,
            0x70, 0x20, 0x33, 0x2E, 0x30, 0x00, 0x38, 0x42, 0x49, 0x4D, 0x04, 0x04, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x38, 0x42, 0x49, 0x4D, 0x04, 0x25, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x10, 0xD4, 0x1D, 0x8C, 0xD9, 0x8F, 0x00, 0xB2, 0x04, 0xE9, 0x80, 0x09, 0x98,
            0xEC, 0xF8, 0x42, 0x7E, 0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03,
            0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xC4, 0x00, 0x1F, 0x00,
            0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B,
            0xFF, 0xC4, 0x00, 0xB5, 0x10, 0x00, 0x02, 0x01, 0x03, 0x03, 0x02, 0x04, 0x03, 0x05,
            0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7D, 0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05,
            0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81,
            0x91, 0xA1, 0x08, 0x23, 0x42, 0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0, 0x24, 0x33, 0x62,
            0x72, 0x82, 0x09, 0x0A, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x25, 0x26, 0x27, 0x28, 0x29,
            0x2A, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
            0x49, 0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66,
            0x67, 0x68, 0x69, 0x6A, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x83, 0x84,
            0x85, 0x86, 0x87, 0x88, 0x89, 0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99,
            0x9A, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5,
            0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xCA,
            0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5,
            0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9,
            0xFA, 0xFF, 0xC4, 0x00, 0x1F, 0x01, 0x00, 0x03, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
            0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05,
            0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0xFF, 0xC4, 0x00, 0xB5, 0x11, 0x00, 0x02, 0x01,
            0x02, 0x04, 0x04, 0x03, 0x04, 0x07, 0x05, 0x04, 0x04, 0x00, 0x01, 0x02, 0x77, 0x00,
            0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61,
            0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xA1, 0xB1, 0xC1, 0x09, 0x23,
            0x33, 0x52, 0xF0, 0x15, 0x62, 0x72, 0xD1, 0x0A, 0x16, 0x24, 0x34, 0xE1, 0x25, 0xF1,
            0x17, 0x18, 0x19, 0x1A, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x35, 0x36, 0x37, 0x38, 0x39,
            0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A, 0x53, 0x54, 0x55, 0x56, 0x57,
            0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x73, 0x74, 0x75,
            0x76, 0x77, 0x78, 0x79, 0x7A, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8A,
            0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6,
            0xA7, 0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2,
            0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7,
            0xD8, 0xD9, 0xDA, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF2, 0xF3,
            0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0xFA, 0xFF, 0xDB, 0x00, 0x43, 0x00, 0x06, 0x06,
            0x06, 0x06, 0x06, 0x06, 0x0A, 0x06, 0x06, 0x0A, 0x0E, 0x0A, 0x0A, 0x0A, 0x0E, 0x12,
            0x0E, 0x0E, 0x0E, 0x0E, 0x12, 0x17, 0x12, 0x12, 0x12, 0x12, 0x12, 0x17, 0x1C, 0x17,
            0x17, 0x17, 0x17, 0x17, 0x17, 0x1C, 0x1C, 0x1C, 0x1C, 0x1C, 0x1C, 0x1C, 0x1C, 0x22,
            0x22, 0x22, 0x22, 0x22, 0x22, 0x27, 0x27, 0x27, 0x27, 0x27, 0x2C, 0x2C, 0x2C, 0x2C,
            0x2C, 0x2C, 0x2C, 0x2C, 0x2C, 0x2C, 0xFF, 0xDB, 0x00, 0x43, 0x01, 0x07, 0x07, 0x07,
            0x0B, 0x0A, 0x0B, 0x13, 0x0A, 0x0A, 0x13, 0x2E, 0x1F, 0x1A, 0x1F, 0x2E, 0x2E, 0x2E,
            0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E,
            0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E,
            0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0x2E,
            0x2E, 0x2E, 0x2E, 0x2E, 0x2E, 0xFF, 0xDD, 0x00, 0x04, 0x00, 0x01, 0xFF, 0xDA, 0x00,
            0x0C, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3F, 0x00, 0xF9, 0x56, 0x8A,
            0x28, 0xA0, 0x0F, 0xFF, 0xD9,
        ];

        let unique = format!(
            "ie_exif_sync_{}_{}.jpg",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let path = std::env::temp_dir().join(unique);
        fs::write(&path, TINY_JPEG).unwrap();

        // 1. Write camera + lens + exposure + capture time (without GPS)
        let first = ExifPatchItem {
            path: path.to_string_lossy().into_owned(),
            make: Some("SONY".to_string()),
            model: Some("ILCE-7RM5".to_string()),
            lens: Some("FE 50mm F1.2 GM".to_string()),
            iso: Some("400".to_string()),
            aperture: Some("1.4".to_string()),
            shutter_speed: Some("1/250".to_string()),
            focal_length: Some("50".to_string()),
            captured_at: Some("2026-11-16 21:17:00".to_string()),
            latitude: None,
            longitude: None,
        };
        let wrote_first = write_single_exif(&first, false, false).unwrap();
        assert!(wrote_first);

        let after_first = read_exif_fields_for_path(&path);
        assert_eq!(after_first.make.as_deref(), Some("SONY"));
        assert_eq!(after_first.model.as_deref(), Some("ILCE-7RM5"));
        assert_eq!(after_first.lens.as_deref(), Some("FE 50mm F1.2 GM"));
        assert_eq!(after_first.iso.as_deref(), Some("400"));
        assert_eq!(after_first.aperture.as_deref(), Some("1.4"));
        assert_eq!(after_first.shutter_speed.as_deref(), Some("0.004"));
        assert_eq!(after_first.focal_length.as_deref(), Some("50"));
        assert_eq!(
            after_first.captured_at.as_deref(),
            Some("2026:11:16 21:17:00")
        );
        assert!(after_first.latitude.is_none());

        // 2. Fill missing GPS only (overwrite=false must keep SONY ILCE-7RM5 intact!)
        let second = ExifPatchItem {
            path: path.to_string_lossy().into_owned(),
            make: Some("CANON".to_string()),
            model: Some("EOS R5".to_string()),
            lens: None,
            iso: None,
            aperture: None,
            shutter_speed: None,
            focal_length: None,
            captured_at: None,
            latitude: Some(32.0415),
            longitude: Some(118.7892),
        };
        let wrote_second = write_single_exif(&second, false, false).unwrap();
        assert!(wrote_second);

        let after_second = read_exif_fields_for_path(&path);
        assert_eq!(after_second.model.as_deref(), Some("ILCE-7RM5")); // preserved!
        assert!((after_second.latitude.unwrap() - 32.0415).abs() < 0.001);
        assert!((after_second.longitude.unwrap() - 118.7892).abs() < 0.001);

        let _ = fs::remove_file(&path);
    }
}
