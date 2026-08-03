use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
#[cfg(target_os = "macos")]
use std::sync::OnceLock;
use std::time::SystemTime;

#[derive(Serialize)]
pub struct ImageDimensions {
    pub width: u32,
    pub height: u32,
}

/// A compact subset of camera metadata used by icon view. Values remain
/// optional because macOS may not expose every MakerNote field for every RAW
/// format.
#[derive(Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImageMetadata {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    pub iso: Option<String>,
    pub shutter_speed: Option<String>,
    pub aperture: Option<String>,
    pub focal_length: Option<String>,
    pub captured_at: Option<String>,
}

/// A focus rectangle written by the camera. Coordinates are normalized to the
/// displayed, orientation-corrected image and are only populated when the
/// MakerNote contains enough information to draw a rectangle safely.
#[derive(Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CameraAfRegion {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub confidence: f32,
}

/// Sony AF data is deliberately separate from the sharpness estimate used as
/// a fallback in the UI. A file can contain the AF mode without containing a
/// drawable AF coordinate, so `exact` must not be inferred from `source`.
#[derive(Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CameraAfMetadata {
    pub source: String,
    pub exact: bool,
    pub regions: Vec<CameraAfRegion>,
    pub area_mode: Option<String>,
    pub focus_mode: Option<String>,
    pub selected_point: Option<String>,
    pub points_used: Option<u32>,
    pub extractor: Option<String>,
    pub note: Option<String>,
}

/// 受保护的目录列表（macOS）
#[cfg(target_os = "macos")]
const PROTECTED_DIRS: &[&str] = &[
    "Desktop",
    "Documents",
    "Downloads",
    "Library",
    "Movies",
    "Music",
    "Pictures",
    "Public",
    "Applications",
];

/// 路径工具模块
mod path_utils {
    use std::path::{Path, PathBuf};

    /// 获取唯一路径（处理名称冲突）
    pub fn get_unique_path(base_path: &Path) -> PathBuf {
        if !base_path.exists() {
            return base_path.to_path_buf();
        }

        let stem = base_path.file_stem().unwrap_or_default().to_string_lossy();
        let ext = base_path
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();

        let mut counter = 1;
        loop {
            let new_name = format!("{} {}{}", stem, counter, ext);
            let new_path = base_path.with_file_name(new_name);
            if !new_path.exists() {
                return new_path;
            }
            counter += 1;
        }
    }

    /// 检查路径是否为受保护目录（macOS）
    #[cfg(target_os = "macos")]
    pub fn is_protected_path(path: &Path) -> bool {
        use super::PROTECTED_DIRS;

        if let Some(home) = dirs::home_dir() {
            let path_str = path.to_string_lossy();

            // 检查是否是用户主目录的直接子目录
            if let Some(parent) = path.parent() {
                if parent == home {
                    if let Some(name) = path.file_name() {
                        let name_str = name.to_string_lossy();
                        if PROTECTED_DIRS.contains(&name_str.as_ref()) {
                            return true;
                        }
                    }
                }
            }

            // 检查是否是 /Applications 目录
            if path_str == "/Applications" || path_str.starts_with("/Applications/") {
                return true;
            }
        }
        false
    }

    #[cfg(not(target_os = "macos"))]
    pub fn is_protected_path(_path: &Path) -> bool {
        true
    }
}

/// Return the platform-specific permission details that can be represented in
/// the shared file model. Unix exposes mode/uid/gid, while Windows exposes the
/// file attribute bitmask. Unsupported values remain `None`.
fn metadata_details(
    metadata: &fs::Metadata,
) -> (Option<u32>, Option<u32>, Option<u32>, Option<u32>) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (
            Some(metadata.mode()),
            Some(metadata.uid()),
            Some(metadata.gid()),
            None,
        )
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        (None, None, None, Some(metadata.file_attributes()))
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = metadata;
        (None, None, None, None)
    }
}

fn system_time_seconds(time: Option<std::io::Result<SystemTime>>) -> Option<u64> {
    time.and_then(|value| value.ok())
        .and_then(|value| value.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
}

fn is_hidden_entry(name: &str, metadata: Option<&fs::Metadata>) -> bool {
    if name.starts_with('.') {
        return true;
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return metadata
            .map(|value| value.file_attributes() & 0x2 != 0)
            .unwrap_or(false);
    }

    #[cfg(not(windows))]
    {
        let _ = metadata;
        false
    }
}

fn package_type(path: &Path, is_dir: bool) -> Option<String> {
    if !is_dir {
        return None;
    }

    let extension = path.extension()?.to_string_lossy().to_lowercase();
    let is_package = matches!(
        extension.as_str(),
        "app" | "bundle" | "framework" | "plugin" | "kext" | "prefpane" | "appex" | "xpc"
    );

    is_package.then_some(extension)
}

/// Finder aliases are regular files with a special macOS file type. The
/// extension check also covers aliases exported or copied by other tools and
/// keeps directory enumeration free of one metadata-process invocation per
/// item. Resolving the target is deferred to the property inspector.
fn is_alias_entry(path: &Path) -> bool {
    path.extension()
        .map(|extension| extension.to_string_lossy().eq_ignore_ascii_case("alias"))
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn is_native_finder_alias(path: &Path) -> bool {
    let path_string = path.to_string_lossy();
    let output = std::process::Command::new("/usr/bin/mdls")
        .args(["-raw", "-name", "kMDItemContentType", path_string.as_ref()])
        .output();
    output
        .ok()
        .filter(|value| value.status.success())
        .map(|value| String::from_utf8_lossy(&value.stdout).trim().to_string())
        .map(|content_type| content_type == "com.apple.alias-file")
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn resolve_finder_alias_target(path: &Path) -> Option<String> {
    let escaped = path
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let script = format!(
        "tell application \"Finder\"\nset aliasFile to POSIX file \"{}\" as alias\ntry\nreturn POSIX path of (original item of aliasFile)\non error\nreturn \"\"\nend try\nend tell",
        escaped
    );
    let output = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let target = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!target.is_empty()).then_some(target)
}

#[derive(Debug, Serialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<u64>,
    pub extension: Option<String>,
    pub readonly: bool,
    pub is_hidden: bool,
    pub is_symlink: bool,
    pub symlink_target: Option<String>,
    pub is_alias: bool,
    pub alias_target: Option<String>,
    pub is_package: bool,
    pub package_type: Option<String>,
    pub created: Option<u64>,
    pub accessed: Option<u64>,
    pub mode: Option<u32>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub file_attributes: Option<u32>,
}

#[tauri::command]
pub fn get_entries(path: String) -> Result<Vec<FileEntry>, String> {
    // 先检查缓存
    if let Some(cached) = crate::cache::get_dir_cache(&path) {
        return Ok(cached);
    }

    // 缓存未命中，执行实际加载
    let entries = load_directory_entries(&path)?;

    // 存入缓存
    crate::cache::set_dir_cache(path, entries.clone());

    Ok(entries)
}

/// 实际加载目录内容（内部使用）
fn load_directory_entries(path: &str) -> Result<Vec<FileEntry>, String> {
    let dir_path = Path::new(path);

    if !dir_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    if !dir_path.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let mut entries: Vec<FileEntry> = Vec::new();

    match fs::read_dir(dir_path) {
        Ok(read_dir) => {
            for entry in read_dir.flatten() {
                let file_path = entry.path();

                let name = entry.file_name().to_string_lossy().to_string();

                let is_dir = file_path.is_dir();

                // Use symlink metadata so the UI can identify links instead of
                // silently treating them as their target.
                let metadata = entry
                    .path()
                    .symlink_metadata()
                    .ok()
                    .or_else(|| fs::metadata(&file_path).ok());

                let is_symlink = metadata
                    .as_ref()
                    .map(|value| value.file_type().is_symlink())
                    .unwrap_or(false);
                let symlink_target = if is_symlink {
                    fs::read_link(&file_path)
                        .ok()
                        .map(|target| target.to_string_lossy().to_string())
                } else {
                    None
                };
                let package_type = package_type(&file_path, is_dir);
                let (mode, uid, gid, file_attributes) = metadata
                    .as_ref()
                    .map(metadata_details)
                    .unwrap_or((None, None, None, None));
                let is_hidden = is_hidden_entry(&name, metadata.as_ref());

                let size = if is_dir {
                    0
                } else {
                    metadata.as_ref().map(|m| m.len()).unwrap_or(0)
                };

                let modified = system_time_seconds(metadata.as_ref().map(|value| value.modified()));
                let created = system_time_seconds(metadata.as_ref().map(|value| value.created()));
                let accessed = system_time_seconds(metadata.as_ref().map(|value| value.accessed()));

                let extension = if is_dir {
                    None
                } else {
                    file_path
                        .extension()
                        .map(|e| e.to_string_lossy().to_string())
                };

                // Check if file is readonly (no write permission)
                let mut readonly = metadata
                    .as_ref()
                    .map(|m| m.permissions().readonly())
                    .unwrap_or(false);

                // macOS 系统保护目录检测
                if !readonly {
                    readonly = path_utils::is_protected_path(&file_path);
                }

                entries.push(FileEntry {
                    name,
                    path: file_path.to_string_lossy().to_string(),
                    is_dir,
                    size,
                    modified,
                    extension,
                    readonly,
                    is_hidden,
                    is_symlink,
                    symlink_target,
                    is_alias: is_alias_entry(&file_path),
                    alias_target: None,
                    is_package: package_type.is_some(),
                    package_type,
                    created,
                    accessed,
                    mode,
                    uid,
                    gid,
                    file_attributes,
                });
            }
        }
        Err(e) => return Err(format!("Failed to read directory: {}", e)),
    }

    // Sort: directories first, then alphabetically
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

/// Read one entry without requiring callers to load its parent directory.
/// This is used by the property inspector for search results, whose lightweight
/// index records intentionally omit filesystem metadata.
#[tauri::command]
pub fn get_file_entry(path: String) -> Result<FileEntry, String> {
    let file_path = Path::new(&path);
    let metadata = file_path
        .symlink_metadata()
        .map_err(|error| format!("Failed to read metadata for {}: {}", path, error))?;
    let target_metadata = if metadata.file_type().is_symlink() {
        fs::metadata(file_path).ok()
    } else {
        Some(metadata.clone())
    };
    let is_symlink = metadata.file_type().is_symlink();
    let is_dir = target_metadata
        .as_ref()
        .map(|value| value.is_dir())
        .unwrap_or(false);
    let name = file_path
        .file_name()
        .ok_or_else(|| "Invalid file path".to_string())?
        .to_string_lossy()
        .to_string();
    let package_type = package_type(file_path, is_dir);
    #[cfg(target_os = "macos")]
    let native_alias = is_native_finder_alias(file_path);
    #[cfg(target_os = "macos")]
    let resolved_alias_target = (is_alias_entry(file_path) || native_alias)
        .then(|| resolve_finder_alias_target(file_path))
        .flatten();
    #[cfg(not(target_os = "macos"))]
    let native_alias = false;
    #[cfg(not(target_os = "macos"))]
    let resolved_alias_target: Option<String> = None;
    let (mode, uid, gid, file_attributes) = metadata_details(&metadata);
    let symlink_target = is_symlink
        .then(|| {
            fs::read_link(file_path)
                .ok()
                .map(|target| target.to_string_lossy().to_string())
        })
        .flatten();
    let mut readonly = target_metadata
        .as_ref()
        .map(|value| value.permissions().readonly())
        .unwrap_or(true);
    if !readonly {
        readonly = path_utils::is_protected_path(file_path);
    }

    Ok(FileEntry {
        name: name.clone(),
        path: path.clone(),
        is_dir,
        size: if is_dir {
            0
        } else {
            target_metadata
                .as_ref()
                .map(|value| value.len())
                .unwrap_or(0)
        },
        modified: system_time_seconds(Some(metadata.modified())),
        extension: if is_dir {
            None
        } else {
            file_path
                .extension()
                .map(|value| value.to_string_lossy().to_string())
        },
        readonly,
        is_hidden: is_hidden_entry(&name, Some(&metadata)),
        is_symlink,
        symlink_target,
        is_alias: is_alias_entry(file_path) || native_alias || resolved_alias_target.is_some(),
        alias_target: resolved_alias_target,
        is_package: package_type.is_some(),
        package_type,
        created: system_time_seconds(Some(metadata.created())),
        accessed: system_time_seconds(Some(metadata.accessed())),
        mode,
        uid,
        gid,
        file_attributes,
    })
}

#[tauri::command]
pub fn get_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "Could not determine home directory".to_string())
}

#[derive(Debug, Serialize, Clone)]
pub struct MountedVolume {
    pub name: String,
    pub path: String,
    pub readonly: bool,
}

#[cfg(target_os = "macos")]
fn mounted_volumes_from_foundation() -> Vec<MountedVolume> {
    use objc2_foundation::{NSFileManager, NSVolumeEnumerationOptions};

    let file_manager = unsafe { NSFileManager::defaultManager() };
    let Some(urls) = (unsafe {
        file_manager.mountedVolumeURLsIncludingResourceValuesForKeys_options(
            None,
            NSVolumeEnumerationOptions(0),
        )
    }) else {
        return Vec::new();
    };

    let mut volumes = Vec::new();
    for index in 0..urls.count() {
        let url = unsafe { urls.objectAtIndex(index) };
        let Some(path) = (unsafe { url.path() }) else {
            continue;
        };
        let path = path.to_string();

        // The root volume has no useful basename here. External, removable,
        // and network volumes are exposed under /Volumes and are what Finder
        // shows as separate locations.
        let Some(name) = path.strip_prefix("/Volumes/") else {
            continue;
        };
        if name.is_empty() || name.contains('/') {
            continue;
        }

        let readonly = fs::metadata(&path)
            .map(|metadata| metadata.permissions().readonly())
            .unwrap_or(false);
        volumes.push(MountedVolume {
            name: name.to_string(),
            path,
            readonly,
        });
    }

    volumes.sort_by_key(|volume| volume.name.to_lowercase());
    volumes
}

#[cfg(target_os = "macos")]
fn mounted_volumes_from_mount_directory() -> Result<Vec<MountedVolume>, String> {
    let mut volumes = Vec::new();
    let read_dir = match fs::read_dir("/Volumes") {
        Ok(read_dir) => read_dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(volumes),
        Err(error) => return Err(format!("Failed to read mounted volumes: {}", error)),
    };

    for entry in read_dir.flatten() {
        let path = entry.path();
        let metadata = match fs::metadata(&path) {
            Ok(metadata) if metadata.is_dir() => metadata,
            _ => continue,
        };

        let Some(name) = path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
        else {
            continue;
        };

        volumes.push(MountedVolume {
            name,
            path: path.to_string_lossy().to_string(),
            readonly: metadata.permissions().readonly(),
        });
    }

    volumes.sort_by_key(|volume| volume.name.to_lowercase());
    Ok(volumes)
}

/// Return currently mounted external volumes on macOS.
///
/// Finder exposes these volumes in its Locations section. `/Volumes` is the
/// stable mount point for removable and network volumes on macOS, so this is
/// kept as a dedicated command instead of treating mounts as normal entries.
#[tauri::command]
pub fn get_mounted_volumes() -> Result<Vec<MountedVolume>, String> {
    #[cfg(target_os = "macos")]
    {
        let native_volumes = mounted_volumes_from_foundation();
        if !native_volumes.is_empty() {
            return Ok(native_volumes);
        }
        mounted_volumes_from_mount_directory()
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub fn get_parent_dir(path: String) -> Result<Option<String>, String> {
    let p = Path::new(&path);
    Ok(p.parent()
        .map(|parent| parent.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn open_file(path: String) -> Result<(), String> {
    open::that(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    open::that(url).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_text_file(path: String, max_size: Option<u64>) -> Result<String, String> {
    let path_obj = Path::new(&path);
    if !path_obj.exists() {
        return Err("File does not exist".to_string());
    }

    let metadata = fs::metadata(path_obj).map_err(|e| e.to_string())?;
    let limit = max_size.unwrap_or(1024 * 1024); // Default 1MB

    if metadata.len() > limit {
        return Err(format!("File too large (max {} bytes)", limit));
    }

    fs::read_to_string(path_obj).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_image_base64(path: String) -> Result<String, String> {
    let path_obj = Path::new(&path);
    if !path_obj.exists() {
        return Err("File does not exist".to_string());
    }

    // 限制文件大小，防止 OOM（默认 50MB）
    let metadata = fs::metadata(path_obj).map_err(|e| e.to_string())?;
    const MAX_IMAGE_SIZE: u64 = 50 * 1024 * 1024;
    if metadata.len() > MAX_IMAGE_SIZE {
        return Err(format!("Image too large (max {} bytes)", MAX_IMAGE_SIZE));
    }

    // Read file as bytes
    let bytes = fs::read(path_obj).map_err(|e| e.to_string())?;

    // Get MIME type from extension
    let mime_type = path_obj
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| match ext.to_lowercase().as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "png" => "image/png",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "svg" => "image/svg+xml",
            "bmp" => "image/bmp",
            "ico" => "image/x-icon",
            _ => "application/octet-stream",
        })
        .unwrap_or("application/octet-stream");

    // Encode to base64
    use base64::{engine::general_purpose, Engine as _};
    let base64_str = general_purpose::STANDARD.encode(&bytes);

    // Return data URL
    Ok(format!("data:{};base64,{}", mime_type, base64_str))
}

#[cfg(target_os = "macos")]
fn parse_sips_u32(output: &str, key: &str) -> Option<u32> {
    output.lines().find_map(|line| {
        let trimmed = line.trim();
        if !trimmed.starts_with(key) {
            return None;
        }

        trimmed
            .split_once(':')
            .and_then(|(_, value)| value.trim().parse::<u32>().ok())
    })
}

#[tauri::command]
pub fn read_image_dimensions(path: String) -> Result<ImageDimensions, String> {
    let path_obj = Path::new(&path);
    if !path_obj.exists() {
        return Err("File does not exist".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/bin/sips")
            .args([
                "-g",
                "pixelWidth",
                "-g",
                "pixelHeight",
                "-g",
                "orientation",
                &path,
            ])
            .output()
            .map_err(|e| e.to_string())?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                "Failed to read image dimensions".to_string()
            } else {
                stderr
            });
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut width = parse_sips_u32(&stdout, "pixelWidth")
            .ok_or_else(|| "Failed to parse image width".to_string())?;
        let mut height = parse_sips_u32(&stdout, "pixelHeight")
            .ok_or_else(|| "Failed to parse image height".to_string())?;
        let orientation = parse_sips_u32(&stdout, "orientation").unwrap_or(1);

        if matches!(orientation, 5..=8) {
            std::mem::swap(&mut width, &mut height);
        }

        Ok(ImageDimensions { width, height })
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Reading image dimensions is only supported on macOS".to_string())
    }
}

#[cfg(target_os = "macos")]
fn parse_mdls_value(output: &str, key: &str) -> Option<String> {
    let prefix = format!("{key} =");
    output.lines().find_map(|line| {
        let value = line.trim().strip_prefix(&prefix)?.trim();
        if value.is_empty() || value == "(null)" || value == "null" {
            return None;
        }

        let value = value.trim_matches('"').trim();
        if value.is_empty() || value == "(null)" {
            None
        } else {
            Some(value.to_string())
        }
    })
}

#[cfg(target_os = "macos")]
fn parse_mdls_u32(output: &str, key: &str) -> Option<u32> {
    parse_mdls_value(output, key).and_then(|value| {
        value
            .trim_matches(['[', ']'])
            .split(|character: char| !character.is_ascii_digit())
            .find(|part| !part.is_empty())
            .and_then(|part| part.parse::<u32>().ok())
    })
}

#[cfg(target_os = "macos")]
fn read_image_metadata_with_imageio(path: &str) -> Option<ImageMetadata> {
    use std::ffi::CString;

    extern "C" {
        fn imageexplorer_image_metadata(
            path: *const std::ffi::c_char,
            length: *mut usize,
        ) -> *mut u8;
        fn imageexplorer_free_thumbnail(buffer: *mut u8);
    }

    let path = CString::new(path.as_bytes()).ok()?;
    let mut length = 0usize;
    let buffer = unsafe { imageexplorer_image_metadata(path.as_ptr(), &mut length) };
    if buffer.is_null() || length == 0 {
        return None;
    }

    let bytes = unsafe { std::slice::from_raw_parts(buffer, length).to_vec() };
    unsafe { imageexplorer_free_thumbnail(buffer) };
    serde_json::from_slice(&bytes).ok()
}

#[cfg(target_os = "macos")]
fn merge_image_metadata(primary: &mut ImageMetadata, fallback: ImageMetadata) {
    if primary.width.is_none() {
        primary.width = fallback.width;
    }
    if primary.height.is_none() {
        primary.height = fallback.height;
    }
    if primary.make.is_none() {
        primary.make = fallback.make;
    }
    if primary.model.is_none() {
        primary.model = fallback.model;
    }
    if primary.lens.is_none() {
        primary.lens = fallback.lens;
    }
    if primary.iso.is_none() {
        primary.iso = fallback.iso;
    }
    if primary.shutter_speed.is_none() {
        primary.shutter_speed = fallback.shutter_speed;
    }
    if primary.aperture.is_none() {
        primary.aperture = fallback.aperture;
    }
    if primary.focal_length.is_none() {
        primary.focal_length = fallback.focal_length;
    }
    if primary.captured_at.is_none() {
        primary.captured_at = fallback.captured_at;
    }
}

#[cfg(target_os = "macos")]
fn image_metadata_needs_fallback(metadata: &ImageMetadata) -> bool {
    metadata.make.is_none()
        || metadata.model.is_none()
        || metadata.lens.is_none()
        || metadata.iso.is_none()
        || metadata.shutter_speed.is_none()
        || metadata.aperture.is_none()
        || metadata.focal_length.is_none()
}

#[cfg(target_os = "macos")]
fn sony_exiftool_candidates() -> Vec<std::path::PathBuf> {
    let mut candidates = Vec::new();

    for variable in ["IMAGEEXPLORER_EXIFTOOL", "EXIFTOOL_PATH"] {
        if let Ok(path) = std::env::var(variable) {
            if !path.trim().is_empty() {
                candidates.push(std::path::PathBuf::from(path));
            }
        }
    }

    if let Ok(executable) = std::env::current_exe() {
        if let Some(contents) = executable.parent() {
            // Tauri app bundle resources are normally next to the executable
            // under ../Resources. The second layout is useful in development
            // and for a directory resource containing the Perl launcher.
            candidates.push(contents.join("../Resources/exiftool"));
            candidates.push(contents.join("../Resources/exiftool/exiftool"));
            candidates.push(contents.join("resources/exiftool"));
            candidates.push(contents.join("resources/exiftool/exiftool"));
        }
    }

    // Homebrew installs ExifTool in one of these locations. The bare command
    // is kept last so PATH remains usable in development and CI.
    candidates.extend([
        std::path::PathBuf::from("/opt/homebrew/bin/exiftool"),
        std::path::PathBuf::from("/usr/local/bin/exiftool"),
        std::path::PathBuf::from("/usr/bin/exiftool"),
        std::path::PathBuf::from("exiftool"),
    ]);
    candidates
}

#[cfg(target_os = "macos")]
fn sony_exiftool_command() -> Option<std::path::PathBuf> {
    static EXIFTOOL_PATH: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();
    EXIFTOOL_PATH
        .get_or_init(|| {
            sony_exiftool_candidates().into_iter().find(|candidate| {
                if candidate.as_os_str() == "exiftool" {
                    return std::process::Command::new(candidate)
                        .arg("-ver")
                        .output()
                        .map(|output| output.status.success())
                        .unwrap_or(false);
                }
                candidate.is_file()
            })
        })
        .clone()
}

#[cfg(target_os = "macos")]
fn sony_json_value<'a>(record: &'a Map<String, Value>, names: &[&str]) -> Option<&'a Value> {
    for name in names {
        if let Some((_, value)) = record.iter().find(|(key, _)| {
            let short_name = key.rsplit(':').next().unwrap_or(key);
            short_name.eq_ignore_ascii_case(name) || key.eq_ignore_ascii_case(name)
        }) {
            return Some(value);
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn sony_json_numbers(value: Option<&Value>) -> Vec<f64> {
    let Some(value) = value else {
        return Vec::new();
    };

    match value {
        Value::Array(values) => values
            .iter()
            .flat_map(|item| sony_json_numbers(Some(item)))
            .collect(),
        Value::Number(number) => number.as_f64().into_iter().collect(),
        Value::String(text) => text
            .split(|character: char| {
                !(character.is_ascii_digit() || matches!(character, '.' | '-' | '+'))
            })
            .filter(|part| !part.is_empty() && *part != "+" && *part != "-")
            .filter_map(|part| part.parse::<f64>().ok())
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(target_os = "macos")]
fn sony_json_text(value: Option<&Value>) -> Option<String> {
    let value = value?;
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Value::Number(number) => Some(number.to_string()),
        Value::Array(values) => {
            let text = values
                .iter()
                .filter_map(|item| sony_json_text(Some(item)))
                .collect::<Vec<_>>()
                .join(" ");
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn sony_focus_mode(value: Option<&Value>) -> Option<String> {
    let number = sony_json_numbers(Some(value?)).first().copied()? as i32;
    Some(
        match number {
            0 => "Manual",
            2 => "AF-S",
            3 => "AF-C",
            4 => "AF-A",
            6 => "DMF",
            7 => "AF-D",
            _ => return Some(format!("MakerNote {number}")),
        }
        .to_string(),
    )
}

#[cfg(target_os = "macos")]
fn sony_area_mode(value: Option<&Value>, setting_layout: bool) -> Option<String> {
    let number = sony_json_numbers(Some(value?)).first().copied()? as i32;
    Some(
        match (setting_layout, number) {
            (true, 0) => "Wide",
            (true, 1) => "Center",
            (true, 3 | 4) => "Flexible Spot",
            (true, 8 | 11) => "Zone",
            (true, 9) => "Center",
            (true, 12) => "Expanded Flexible Spot",
            (true, 13) => "Custom AF Area",
            (false, 0) => "Wide / Default",
            (false, 1) => "Multi",
            (false, 2) => "Center",
            (false, 3) => "Spot",
            (false, 4) => "Flexible Spot",
            (false, 6) => "Touch",
            (false, 14) => "Tracking",
            (false, 15) => "Face Tracking",
            _ => return Some(format!("MakerNote {number}")),
        }
        .to_string(),
    )
}

#[cfg(target_os = "macos")]
fn clamp_af_region(
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    confidence: f32,
) -> Option<CameraAfRegion> {
    if ![x, y, width, height]
        .iter()
        .all(|value| value.is_finite() && *value >= 0.0)
        || width <= 0.0
        || height <= 0.0
    {
        return None;
    }

    let right = (x + width).min(1.0);
    let bottom = (y + height).min(1.0);
    let left = x.min(right);
    let top = y.min(bottom);
    let clipped_width = right - left;
    let clipped_height = bottom - top;
    if clipped_width <= 0.0 || clipped_height <= 0.0 {
        return None;
    }

    Some(CameraAfRegion {
        x: left as f32,
        y: top as f32,
        width: clipped_width as f32,
        height: clipped_height as f32,
        confidence: confidence.clamp(0.0, 1.0),
    })
}

#[cfg(target_os = "macos")]
fn orient_af_region(region: CameraAfRegion, orientation: u8) -> CameraAfRegion {
    let (x, y, width, height) = (region.x, region.y, region.width, region.height);
    let (next_x, next_y, next_width, next_height) = match orientation {
        2 => (1.0 - x - width, y, width, height),
        3 => (1.0 - x - width, 1.0 - y - height, width, height),
        4 => (x, 1.0 - y - height, width, height),
        5 => (y, x, height, width),
        6 => (1.0 - y - height, x, height, width),
        7 => (1.0 - y - height, 1.0 - x - width, height, width),
        8 => (y, 1.0 - x - width, height, width),
        _ => (x, y, width, height),
    };

    CameraAfRegion {
        x: next_x.clamp(0.0, 1.0),
        y: next_y.clamp(0.0, 1.0),
        width: next_width.clamp(0.0, 1.0),
        height: next_height.clamp(0.0, 1.0),
        confidence: region.confidence,
    }
}

#[cfg(target_os = "macos")]
fn sony_region_from_focus_location(
    location: &[f64],
    frame_size: &[f64],
    orientation: u8,
    expected_image_width: f64,
    expected_image_height: f64,
) -> Option<CameraAfRegion> {
    if location.len() < 4 || frame_size.len() < 2 {
        return None;
    }

    // Sony's FocusLocation is stored as image width, image height, X, Y. The
    // first two values are checked against the actual file dimensions so a
    // different MakerNote layout can never be silently misinterpreted.
    let image_width = location[0];
    let image_height = location[1];
    let center_x = location[2];
    let center_y = location[3];
    if image_width < 1.0
        || image_height < 1.0
        || center_x < 0.0
        || center_y < 0.0
        || center_x > image_width
        || center_y > image_height
    {
        return None;
    }
    if expected_image_width > 0.0
        && expected_image_height > 0.0
        && ((image_width - expected_image_width).abs() > expected_image_width * 0.02
            || (image_height - expected_image_height).abs() > expected_image_height * 0.02)
    {
        return None;
    }

    let width = frame_size[0];
    let height = frame_size[1];
    let region = clamp_af_region(
        (center_x - width / 2.0) / image_width,
        (center_y - height / 2.0) / image_height,
        width / image_width,
        height / image_height,
        1.0,
    )?;
    Some(orient_af_region(region, orientation))
}

#[cfg(target_os = "macos")]
fn sony_region_from_flexible_spot(
    position: &[f64],
    frame_size: &[f64],
    orientation: u8,
) -> Option<CameraAfRegion> {
    if position.len() < 2 {
        return None;
    }

    // ExifTool documents the NEX/ILCE coordinate space as 640 x 480 (some
    // older bodies use an 11 x 9 grid). Do not treat arbitrary small numbers
    // as image pixels; that would produce the false upper-left boxes seen in
    // the previous sharpness-only implementation.
    let center_x = position[0];
    let center_y = position[1];
    if !(0.0..=640.0).contains(&center_x) || !(0.0..=480.0).contains(&center_y) {
        return None;
    }
    let (width, height, confidence) = if frame_size.len() >= 2
        && frame_size[0] > 0.0
        && frame_size[1] > 0.0
        && frame_size[0] <= 640.0
        && frame_size[1] <= 480.0
    {
        (frame_size[0] / 640.0, frame_size[1] / 480.0, 0.85)
    } else {
        // The point itself is camera-authored, but this fallback box is only
        // an approximate visual affordance because the MakerNote omitted its
        // frame size.
        (0.06, 0.06, 0.7)
    };

    let region = clamp_af_region(
        center_x / 640.0 - width / 2.0,
        center_y / 480.0 - height / 2.0,
        width,
        height,
        confidence,
    )?;
    Some(orient_af_region(region, orientation))
}

#[cfg(target_os = "macos")]
fn read_sony_camera_af_metadata(path: &str) -> Option<CameraAfMetadata> {
    let exiftool = sony_exiftool_command()?;
    let output = std::process::Command::new(&exiftool)
        .args([
            "-j",
            "-n",
            "-q",
            "-q",
            "-api",
            "RequestAll=3",
            "-ImageWidth",
            "-ImageHeight",
            "-Orientation",
            "-Sony:FocusLocation",
            "-Sony:FocusLocation2",
            "-Sony:FocusFrameSize",
            "-Sony:FlexibleSpotPosition",
            "-Sony:AFAreaModeSetting",
            "-Sony:AFAreaMode",
            "-Sony:FocusMode",
            "-Sony:AFPointSelected",
            "-Sony:AFPointAtShutterRelease",
            "-Sony:FocalPlaneAFPointsUsed",
            path,
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let records: Vec<Value> = serde_json::from_slice(&output.stdout).ok()?;
    let record = records.first()?.as_object()?;
    let image_width = sony_json_numbers(sony_json_value(record, &["ImageWidth"]))
        .first()
        .copied()
        .unwrap_or_default();
    let image_height = sony_json_numbers(sony_json_value(record, &["ImageHeight"]))
        .first()
        .copied()
        .unwrap_or_default();
    let orientation = sony_json_numbers(sony_json_value(record, &["Orientation"]))
        .first()
        .copied()
        .unwrap_or(1.0) as u8;
    let frame_size = sony_json_numbers(sony_json_value(record, &["FocusFrameSize"]));
    let focus_location = sony_json_numbers(sony_json_value(record, &["FocusLocation"]));
    let focus_location2 = sony_json_numbers(sony_json_value(record, &["FocusLocation2"]));
    let flexible_spot = sony_json_numbers(sony_json_value(record, &["FlexibleSpotPosition"]));

    let mut regions = Vec::new();
    if let Some(region) = sony_region_from_focus_location(
        &focus_location,
        &frame_size,
        orientation,
        image_width,
        image_height,
    ) {
        regions.push(region);
    }
    if let Some(region) = sony_region_from_focus_location(
        &focus_location2,
        &frame_size,
        orientation,
        image_width,
        image_height,
    ) {
        if !regions.iter().any(|existing| {
            (existing.x - region.x).abs() < 0.001
                && (existing.y - region.y).abs() < 0.001
                && (existing.width - region.width).abs() < 0.001
                && (existing.height - region.height).abs() < 0.001
        }) {
            regions.push(region);
        }
    }
    if regions.is_empty() {
        if let Some(region) =
            sony_region_from_flexible_spot(&flexible_spot, &frame_size, orientation)
        {
            regions.push(region);
        }
    }

    let area_mode = if let Some(value) = sony_json_value(record, &["AFAreaModeSetting"]) {
        sony_area_mode(Some(value), true)
    } else {
        sony_area_mode(sony_json_value(record, &["AFAreaMode"]), false)
    };
    let focus_mode = sony_focus_mode(sony_json_value(record, &["FocusMode"]));
    let selected_point = sony_json_text(sony_json_value(
        record,
        &["AFPointAtShutterRelease", "AFPointSelected"],
    ));
    let points_used = sony_json_numbers(sony_json_value(record, &["FocalPlaneAFPointsUsed"]))
        .first()
        .and_then(|value| (*value >= 0.0).then_some(*value as u32));

    let has_camera_tags = area_mode.is_some()
        || focus_mode.is_some()
        || selected_point.is_some()
        || points_used.is_some()
        || !focus_location.is_empty()
        || !focus_location2.is_empty()
        || !flexible_spot.is_empty();
    if !has_camera_tags {
        return Some(CameraAfMetadata {
            source: "unavailable".to_string(),
            exact: false,
            regions: Vec::new(),
            area_mode: None,
            focus_mode: None,
            selected_point: None,
            points_used: None,
            extractor: Some("ExifTool".to_string()),
            note: Some("Sony MakerNote 中未记录可绘制的 AF 坐标".to_string()),
        });
    }

    let exact = regions.iter().all(|region| region.confidence >= 0.99) && !regions.is_empty();
    let note = if exact {
        Some("Sony MakerNote FocusLocation / FocusFrameSize".to_string())
    } else if !regions.is_empty() {
        Some("Sony MakerNote AF 坐标；区域尺寸由相机记录或兼容坐标空间推导".to_string())
    } else {
        Some("Sony MakerNote 仅记录 AF 模式/点位，未提供可绘制坐标".to_string())
    };

    Some(CameraAfMetadata {
        source: "camera-maker-note".to_string(),
        exact,
        regions,
        area_mode,
        focus_mode,
        selected_point,
        points_used,
        extractor: Some("ExifTool".to_string()),
        note,
    })
}

#[tauri::command]
pub fn read_camera_af_metadata(path: String) -> Result<Option<CameraAfMetadata>, String> {
    let path_obj = Path::new(&path);
    if !path_obj.exists() || !path_obj.is_file() {
        return Ok(None);
    }

    #[cfg(target_os = "macos")]
    {
        Ok(Some(read_sony_camera_af_metadata(&path).unwrap_or_else(
            || CameraAfMetadata {
                source: "unavailable".to_string(),
                exact: false,
                regions: Vec::new(),
                area_mode: None,
                focus_mode: None,
                selected_point: None,
                points_used: None,
                extractor: None,
                note: Some("未找到 ExifTool 或文件中没有可读取的 Sony MakerNote".to_string()),
            },
        )))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Ok(None)
    }
}

#[cfg(all(test, target_os = "macos"))]
mod sony_camera_af_tests {
    use super::{orient_af_region, sony_region_from_focus_location, CameraAfRegion};

    #[test]
    fn focus_location_uses_image_dimensions_and_frame_size() {
        let region = sony_region_from_focus_location(
            &[6000.0, 4000.0, 3000.0, 2000.0],
            &[1000.0, 800.0],
            1,
            6000.0,
            4000.0,
        )
        .expect("valid Sony FocusLocation");

        assert!((region.x - (2500.0 / 6000.0) as f32).abs() < 0.0001);
        assert!((region.y - (1600.0 / 4000.0) as f32).abs() < 0.0001);
        assert!((region.width - (1000.0 / 6000.0) as f32).abs() < 0.0001);
        assert!((region.height - (800.0 / 4000.0) as f32).abs() < 0.0001);
        assert!((region.confidence - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn focus_location_rejects_a_different_coordinate_layout() {
        assert!(sony_region_from_focus_location(
            &[100.0, 200.0, 300.0, 400.0],
            &[50.0, 50.0],
            1,
            6000.0,
            4000.0,
        )
        .is_none());
    }

    #[test]
    fn orientation_six_rotates_the_region_with_the_preview() {
        let rotated = orient_af_region(
            CameraAfRegion {
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.4,
                confidence: 1.0,
            },
            6,
        );

        assert!((rotated.x - 0.4).abs() < 0.0001);
        assert!((rotated.y - 0.1).abs() < 0.0001);
        assert!((rotated.width - 0.4).abs() < 0.0001);
        assert!((rotated.height - 0.3).abs() < 0.0001);
    }
}

/// Read EXIF-like fields through Spotlight's metadata importer. This keeps
/// RAW decoding off the React thread and gracefully returns `None` when the
/// importer does not expose metadata for a particular file.
#[tauri::command]
pub fn read_image_metadata(path: String) -> Result<Option<ImageMetadata>, String> {
    let path_obj = Path::new(&path);
    if !path_obj.exists() || !path_obj.is_file() {
        return Ok(None);
    }

    #[cfg(target_os = "macos")]
    {
        // ImageIO reads the EXIF dictionaries embedded in RAW files directly.
        // Spotlight's mdls importer remains a fallback for formats whose
        // ImageIO property dictionary is incomplete.
        let mut imageio_metadata = read_image_metadata_with_imageio(&path);
        if let Some(metadata) = imageio_metadata.as_ref() {
            if !image_metadata_needs_fallback(metadata) {
                return Ok(imageio_metadata);
            }
        }

        let output = std::process::Command::new("/usr/bin/mdls")
            .args([
                "-name",
                "kMDItemPixelWidth",
                "-name",
                "kMDItemPixelHeight",
                "-name",
                "kMDItemAcquisitionMake",
                "-name",
                "kMDItemAcquisitionModel",
                "-name",
                "kMDItemLensModel",
                "-name",
                "kMDItemISOSpeed",
                "-name",
                "kMDItemExposureTimeSeconds",
                "-name",
                "kMDItemFNumber",
                "-name",
                "kMDItemFocalLength",
                "-name",
                "kMDItemContentCreationDate",
                &path,
            ])
            .output()
            .map_err(|error| error.to_string())?;

        if !output.status.success() {
            return Ok(imageio_metadata);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let metadata = ImageMetadata {
            width: parse_mdls_u32(&stdout, "kMDItemPixelWidth"),
            height: parse_mdls_u32(&stdout, "kMDItemPixelHeight"),
            make: parse_mdls_value(&stdout, "kMDItemAcquisitionMake"),
            model: parse_mdls_value(&stdout, "kMDItemAcquisitionModel"),
            lens: parse_mdls_value(&stdout, "kMDItemLensModel"),
            iso: parse_mdls_value(&stdout, "kMDItemISOSpeed"),
            shutter_speed: parse_mdls_value(&stdout, "kMDItemExposureTimeSeconds"),
            aperture: parse_mdls_value(&stdout, "kMDItemFNumber"),
            focal_length: parse_mdls_value(&stdout, "kMDItemFocalLength"),
            captured_at: parse_mdls_value(&stdout, "kMDItemContentCreationDate"),
        };

        if metadata.width.is_none()
            && metadata.height.is_none()
            && metadata.make.is_none()
            && metadata.model.is_none()
            && metadata.lens.is_none()
            && metadata.iso.is_none()
            && metadata.shutter_speed.is_none()
            && metadata.aperture.is_none()
            && metadata.focal_length.is_none()
            && metadata.captured_at.is_none()
        {
            return Ok(imageio_metadata);
        }

        if let Some(ref mut imageio_metadata) = imageio_metadata {
            merge_image_metadata(imageio_metadata, metadata);
            return Ok(Some(imageio_metadata.clone()));
        }

        Ok(Some(metadata))
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}

#[tauri::command]
pub fn check_full_disk_access() -> bool {
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            let protected_paths = [
                "Library/Safari",
                "Library/Messages",
                "Library/Mail",
                "Library/Suggestions",
                "Library/Cookies",
            ];

            for path in protected_paths {
                let test_path = home.join(path);
                if std::fs::read_dir(test_path).is_ok() {
                    return true;
                }
            }
        }
        false
    }
    #[cfg(not(target_os = "macos"))]
    true
}

#[tauri::command]
pub fn delete_to_trash(path: String) -> Result<(), String> {
    // 防御性检查：文件已不存在则静默成功
    if !Path::new(&path).exists() {
        return Ok(());
    }
    let parent = Path::new(&path)
        .parent()
        .map(|p| p.to_string_lossy().to_string());
    trash::delete(&path).map_err(|e| e.to_string())?;
    // 清除父目录缓存，确保下次 get_entries 返回最新数据
    if let Some(parent_path) = parent {
        crate::cache::invalidate_dir_cache(&parent_path);
    }
    Ok(())
}

#[tauri::command]
pub fn exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
pub fn open_in_terminal(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // 使用 POSIX path 变量避免注入，不需要手动转义
        // AppleScript 的 quoted form of 会正确处理所有特殊字符
        let script = format!(
            r#"set posixPath to "{}"
tell application "Terminal"
    activate
    if (count of windows) = 0 then
        do script "cd " & quoted form of posixPath
    else
        do script "cd " & quoted form of posixPath in front window
    end if
end tell"#,
            path.replace("\\", "\\\\").replace("\"", "\\\"")
        );

        std::process::Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .spawn()
            .map_err(|e| e.to_string())?;

        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    Err("Not supported on this platform".to_string())
}

#[tauri::command]
pub fn create_directory(path: String) -> Result<String, String> {
    let target_path = path_utils::get_unique_path(Path::new(&path));
    fs::create_dir(&target_path).map_err(|e| e.to_string())?;
    // 清除父目录缓存
    if let Some(parent) = target_path.parent() {
        crate::cache::invalidate_dir_cache(&parent.to_string_lossy());
    }
    Ok(target_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_file(path: String) -> Result<String, String> {
    let target_path = path_utils::get_unique_path(Path::new(&path));
    fs::File::create(&target_path).map_err(|e| e.to_string())?;
    // 清除父目录缓存
    if let Some(parent) = target_path.parent() {
        crate::cache::invalidate_dir_cache(&parent.to_string_lossy());
    }
    Ok(target_path.to_string_lossy().to_string())
}

#[derive(Debug, Serialize, Clone)]
pub struct DiskSpace {
    pub path: String,
    pub available_bytes: Option<u64>,
}

/// Return free space for the filesystem containing `path`. The command is
/// intentionally best-effort on platforms where the host does not expose a
/// portable statvfs API; callers should treat `None` as "unknown", not zero.
#[tauri::command]
pub fn get_disk_space(path: String) -> Result<DiskSpace, String> {
    let path_obj = Path::new(&path);
    let probe = if path_obj.is_dir() {
        path_obj.to_path_buf()
    } else {
        path_obj.parent().unwrap_or(path_obj).to_path_buf()
    };

    #[cfg(unix)]
    let available_bytes = std::process::Command::new("df")
        .args(["-Pk", probe.to_string_lossy().as_ref()])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .nth(1)
                .and_then(|line| line.split_whitespace().nth(3))
                .and_then(|value| value.parse::<u64>().ok())
                .map(|kilobytes| kilobytes.saturating_mul(1024))
        });

    #[cfg(windows)]
    let available_bytes = None;

    Ok(DiskSpace {
        path,
        available_bytes,
    })
}

#[tauri::command]
pub fn copy_file(src: String, dest_dir: String) -> Result<String, String> {
    let src_path = Path::new(&src);
    let dest_dir_path = Path::new(&dest_dir);

    if !src_path.exists() {
        return Err(format!("Source does not exist: {}", src));
    }

    // 检测环形复制：目标目录不能是源目录的子目录
    if src_path.is_dir() {
        let src_canonical = src_path.canonicalize().map_err(|e| e.to_string())?;
        let dest_canonical = dest_dir_path.canonicalize().map_err(|e| e.to_string())?;
        if dest_canonical.starts_with(&src_canonical) {
            return Err("Cannot copy a folder into itself".to_string());
        }
    }

    let file_name = src_path
        .file_name()
        .ok_or("Invalid source path")?
        .to_string_lossy();

    let dest_path = dest_dir_path.join(&*file_name);

    // 如果目标已存在，添加后缀
    let final_dest = if dest_path.exists() {
        path_utils::get_unique_path(&dest_path)
    } else {
        dest_path
    };

    if src_path.is_dir() {
        copy_dir_recursive(src_path, &final_dest)?;
    } else {
        fs::copy(src_path, &final_dest).map_err(|e| e.to_string())?;
    }

    // 清除目标目录缓存
    crate::cache::invalidate_dir_cache(&dest_dir);

    Ok(final_dest.to_string_lossy().to_string())
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;

    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dest_path)?;
        } else {
            fs::copy(&src_path, &dest_path).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

const COPY_BUFFER_SIZE: usize = 8 * 1024 * 1024;

fn copy_single_resumable<F>(src: &Path, dest: &Path, on_progress: &mut F) -> Result<(), String>
where
    F: FnMut(u64) -> bool,
{
    let source_size = fs::metadata(src).map_err(|error| error.to_string())?.len();
    if let Ok(metadata) = fs::metadata(dest) {
        if metadata.len() == source_size {
            if source_size > 0 && !on_progress(source_size) {
                return Err("Operation cancelled".to_string());
            }
            return Ok(());
        }
    }

    let partial_name = format!(
        ".{}.imageexplorer-part",
        dest.file_name().unwrap_or_default().to_string_lossy()
    );
    let partial = dest.with_file_name(partial_name);
    let mut offset = fs::metadata(&partial)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if offset > source_size {
        let _ = fs::remove_file(&partial);
        offset = 0;
    }

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut source = fs::File::open(src).map_err(|error| error.to_string())?;
    source
        .seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    let mut output = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&partial)
        .map_err(|error| error.to_string())?;
    let mut buffer = vec![0_u8; COPY_BUFFER_SIZE];
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| error.to_string())?;
        if !on_progress(read as u64) {
            return Err("Operation cancelled".to_string());
        }
    }
    output.flush().map_err(|error| error.to_string())?;
    output.sync_all().map_err(|error| error.to_string())?;
    fs::rename(&partial, dest).map_err(|error| error.to_string())?;
    Ok(())
}

fn copy_dir_recursive_resumable<F>(
    src: &Path,
    dest: &Path,
    on_progress: &mut F,
) -> Result<(), String>
where
    F: FnMut(u64) -> bool,
{
    fs::create_dir_all(dest).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(src).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive_resumable(&src_path, &dest_path, on_progress)?;
        } else {
            copy_single_resumable(&src_path, &dest_path, on_progress)?;
        }
    }
    Ok(())
}

/// Copy using an 8 MiB buffer and hidden partial files. A transient failure
/// leaves the partial file in place so a queued retry resumes from the last
/// durable offset instead of restarting a large transfer from byte zero.
pub fn copy_file_resumable<F>(
    src: String,
    dest_dir: String,
    mut on_progress: F,
) -> Result<String, String>
where
    F: FnMut(u64) -> bool,
{
    let src_path = Path::new(&src);
    let dest_dir_path = Path::new(&dest_dir);
    if !src_path.exists() {
        return Err(format!("Source does not exist: {}", src));
    }
    let file_name = src_path
        .file_name()
        .ok_or("Invalid source path")?
        .to_string_lossy();
    let dest_path = dest_dir_path.join(&*file_name);
    let final_dest = if dest_path.exists() && !src_path.is_file() {
        path_utils::get_unique_path(&dest_path)
    } else if dest_path.exists() && src_path.is_file() {
        let partial = dest_path.with_file_name(format!(
            ".{}.imageexplorer-part",
            dest_path.file_name().unwrap_or_default().to_string_lossy()
        ));
        if partial.exists() {
            dest_path
        } else {
            path_utils::get_unique_path(&dest_path)
        }
    } else {
        dest_path
    };

    if src_path.is_dir() {
        copy_dir_recursive_resumable(src_path, &final_dest, &mut on_progress)?;
    } else {
        copy_single_resumable(src_path, &final_dest, &mut on_progress)?;
    }
    crate::cache::invalidate_dir_cache(&dest_dir);
    Ok(final_dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn move_file(src: String, dest_dir: String) -> Result<String, String> {
    let src_path = Path::new(&src);
    let dest_dir_path = Path::new(&dest_dir);

    // 清除源文件所在目录的缓存
    let src_parent = src_path.parent().map(|p| p.to_string_lossy().to_string());

    let file_name = src_path
        .file_name()
        .ok_or("Invalid source path")?
        .to_string_lossy();

    let dest_path = dest_dir_path.join(&*file_name);

    // 如果目标已存在，添加后缀
    let final_dest = if dest_path.exists() {
        path_utils::get_unique_path(&dest_path)
    } else {
        dest_path
    };

    // 优先尝试原子 rename（同文件系统内）
    match fs::rename(src_path, &final_dest) {
        Ok(()) => {
            // 清除缓存
            crate::cache::invalidate_dir_cache(&dest_dir);
            if let Some(parent_path) = src_parent {
                crate::cache::invalidate_dir_cache(&parent_path);
            }
            return Ok(final_dest.to_string_lossy().to_string());
        }
        Err(_) => {
            // rename 失败（跨文件系统），fallback 到 copy+delete
        }
    }

    // Fallback: 先复制，再删除
    let dest = copy_file_resumable(src.clone(), dest_dir, |_| true)?;

    if src_path.is_dir() {
        fs::remove_dir_all(src_path).map_err(|e| e.to_string())?;
    } else {
        fs::remove_file(src_path).map_err(|e| e.to_string())?;
    }

    if let Some(parent_path) = src_parent {
        crate::cache::invalidate_dir_cache(&parent_path);
    }

    Ok(dest)
}

#[tauri::command]
pub fn rename(path: String, new_name: String) -> Result<(), String> {
    let path_obj = Path::new(&path);
    let parent = path_obj.parent().ok_or("Invalid path")?;
    let new_path = parent.join(new_name);

    if new_path.exists() {
        return Err("Target name already exists".to_string());
    }

    fs::rename(&path, &new_path).map_err(|e| e.to_string())?;
    // 清除父目录缓存
    crate::cache::invalidate_dir_cache(&parent.to_string_lossy());
    Ok(())
}

/// 批量重命名结果
#[derive(Debug, Serialize)]
pub struct BatchRenameResult {
    pub success: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

/// 批量重命名
/// mode: "replace" | "prefix" | "suffix" | "counter"
/// pattern: 替换/前缀/后缀的文本，或计数器格式如 "photo_{counter}"
#[tauri::command]
pub fn batch_rename(
    paths: Vec<String>,
    pattern: String,
    mode: String,
    find: Option<String>,
) -> Result<BatchRenameResult, String> {
    let mut success = 0;
    let mut failed = 0;
    let mut errors = Vec::new();
    let mut parents_to_invalidate = std::collections::HashSet::new();

    for (i, path_str) in paths.iter().enumerate() {
        let path_obj = Path::new(path_str);
        let parent = match path_obj.parent() {
            Some(p) => p,
            None => {
                failed += 1;
                errors.push(format!("{}: invalid path", path_str));
                continue;
            }
        };

        // 处理文件名和扩展名（支持点文件如 .bashrc）
        let file_name = match path_obj.file_name() {
            Some(s) => s.to_string_lossy().to_string(),
            None => {
                failed += 1;
                errors.push(format!("{}: no filename", path_str));
                continue;
            }
        };
        let old_name = path_obj
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| file_name.clone());
        let ext = path_obj
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();

        let new_name = match mode.as_str() {
            "replace" => {
                let find_str = find.as_deref().unwrap_or("");
                if find_str.is_empty() {
                    failed += 1;
                    errors.push(format!("{}: find string is empty", path_str));
                    continue;
                }
                format!("{}{}", old_name.replace(find_str, &pattern), ext)
            }
            "prefix" => format!("{}{}{}", pattern, old_name, ext),
            "suffix" => format!("{}{}{}", old_name, pattern, ext),
            "counter" => {
                let counter = format!("{}", i + 1);
                let name = pattern
                    .replace("{counter}", &counter)
                    .replace("{name}", &old_name);
                format!("{}{}", name, ext)
            }
            _ => {
                failed += 1;
                errors.push(format!("{}: unknown mode '{}'", path_str, mode));
                continue;
            }
        };

        let new_path = parent.join(&new_name);

        if new_path.exists() && new_path != path_obj {
            failed += 1;
            errors.push(format!(
                "{}: target '{}' already exists",
                old_name, new_name
            ));
            continue;
        }

        match fs::rename(path_obj, &new_path) {
            Ok(()) => {
                success += 1;
                parents_to_invalidate.insert(parent.to_string_lossy().to_string());
            }
            Err(e) => {
                failed += 1;
                errors.push(format!("{}: {}", old_name, e));
            }
        }
    }

    // 批量清除缓存
    for parent in &parents_to_invalidate {
        crate::cache::invalidate_dir_cache(parent);
    }

    Ok(BatchRenameResult {
        success,
        failed,
        errors,
    })
}

#[cfg(test)]
mod file_entry_tests {
    use super::{copy_file_resumable, get_file_entry, is_alias_entry, package_type};
    use std::fs;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_root() -> std::path::PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after the epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("imageexplorer-file-entry-{stamp}"))
    }

    #[test]
    fn package_and_alias_detection_is_case_insensitive_and_directory_scoped() {
        assert_eq!(
            package_type(Path::new("/tmp/Editor.APP"), true),
            Some("app".to_string())
        );
        assert_eq!(package_type(Path::new("/tmp/Editor.app"), false), None);
        assert!(is_alias_entry(Path::new("/tmp/Project.ALIAS")));
        assert!(!is_alias_entry(Path::new("/tmp/Project")));
    }

    #[test]
    fn file_entry_preserves_extended_metadata_and_symlink_identity() {
        let root = test_root();
        fs::create_dir_all(&root).expect("create test root");
        let file = root.join(".hidden.txt");
        fs::write(&file, b"metadata").expect("write test file");
        let package = root.join("Editor.app");
        fs::create_dir(&package).expect("create package directory");
        let alias = root.join("Shortcut.alias");
        fs::write(&alias, b"alias placeholder").expect("write alias marker");

        let entry = get_file_entry(file.to_string_lossy().to_string()).expect("read file entry");
        assert!(entry.is_hidden);
        assert!(!entry.is_dir);
        assert_eq!(entry.size, 8);
        assert!(entry.modified.is_some());
        assert!(entry.created.is_some() || entry.accessed.is_some());

        let package_entry =
            get_file_entry(package.to_string_lossy().to_string()).expect("read package entry");
        assert!(package_entry.is_dir);
        assert!(package_entry.is_package);
        assert_eq!(package_entry.package_type.as_deref(), Some("app"));

        let alias_entry =
            get_file_entry(alias.to_string_lossy().to_string()).expect("read alias entry");
        assert!(alias_entry.is_alias);

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&file, root.join("file-link")).expect("create symlink");
            let link = get_file_entry(root.join("file-link").to_string_lossy().to_string())
                .expect("read symlink entry");
            assert!(link.is_symlink);
            assert!(link
                .symlink_target
                .as_deref()
                .is_some_and(|target| target.ends_with(".hidden.txt")));
            assert!(!link.is_dir);
        }

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn resumable_copy_keeps_partial_data_for_retry() {
        let root = test_root();
        let destination = root.join("destination");
        let source = root.join("large.bin");
        fs::create_dir_all(&destination).expect("create destination");
        fs::write(&source, vec![7_u8; 1024 * 1024]).expect("write source");

        let mut first_callback = true;
        let first = copy_file_resumable(
            source.to_string_lossy().to_string(),
            destination.to_string_lossy().to_string(),
            |_| {
                if first_callback {
                    first_callback = false;
                    false
                } else {
                    true
                }
            },
        );
        assert!(first.is_err());

        let mut copied = 0_u64;
        let final_path = copy_file_resumable(
            source.to_string_lossy().to_string(),
            destination.to_string_lossy().to_string(),
            |bytes| {
                copied += bytes;
                true
            },
        )
        .expect("resume copy");
        assert_eq!(copied, 0);
        assert_eq!(
            fs::metadata(final_path).expect("final file").len(),
            1024 * 1024
        );

        fs::remove_dir_all(root).expect("remove test root");
    }
}
