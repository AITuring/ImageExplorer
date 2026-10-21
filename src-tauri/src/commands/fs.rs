use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
#[cfg(target_os = "macos")]
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

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
    use std::io;
    use std::path::{Path, PathBuf};

    fn candidate_path(base_path: &Path, counter: u64) -> PathBuf {
        let stem = base_path.file_stem().unwrap_or_default().to_string_lossy();
        let ext = base_path
            .extension()
            .map(|extension| format!(".{}", extension.to_string_lossy()))
            .unwrap_or_default();
        base_path.with_file_name(format!("{} {}{}", stem, counter, ext))
    }

    /// 获取唯一路径（处理名称冲突）
    pub fn get_unique_path(base_path: &Path) -> PathBuf {
        if !base_path.exists() {
            return base_path.to_path_buf();
        }
        let mut counter = 1_u64;
        loop {
            let new_path = candidate_path(base_path, counter);
            if !new_path.exists() {
                return new_path;
            }
            counter = counter.saturating_add(1);
        }
    }

    /// Create a file without replacing a path that appeared after name selection.
    pub fn create_unique_file(base_path: &Path) -> io::Result<PathBuf> {
        let mut counter = 0_u64;
        loop {
            let candidate = if counter == 0 {
                base_path.to_path_buf()
            } else {
                candidate_path(base_path, counter)
            };
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
            {
                Ok(_) => return Ok(candidate),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    counter = counter.checked_add(1).ok_or(error)?;
                }
                Err(error) => return Err(error),
            }
        }
    }

    /// Create a directory without replacing a path that appeared after name selection.
    pub fn create_unique_directory(base_path: &Path) -> io::Result<PathBuf> {
        let mut counter = 0_u64;
        loop {
            let candidate = if counter == 0 {
                base_path.to_path_buf()
            } else {
                candidate_path(base_path, counter)
            };
            match std::fs::create_dir(&candidate) {
                Ok(()) => return Ok(candidate),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    counter = counter.checked_add(1).ok_or(error)?;
                }
                Err(error) => return Err(error),
            }
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

    #[cfg(test)]
    mod tests {
        use super::{create_unique_directory, create_unique_file};
        use std::collections::HashSet;
        use std::fs;
        use std::path::PathBuf;
        use std::sync::{Arc, Barrier};
        use std::thread;
        use std::time::{SystemTime, UNIX_EPOCH};

        fn test_root(name: &str) -> PathBuf {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be valid")
                .as_nanos();
            std::env::temp_dir().join(format!(
                "imageexplorer-path-utils-{}-{name}-{suffix}",
                std::process::id()
            ))
        }

        #[test]
        fn concurrent_file_creation_never_truncates_the_existing_candidate() {
            let root = test_root("files");
            fs::create_dir_all(&root).expect("create test root");
            let base = root.join("New File.txt");
            fs::write(&base, b"existing data").expect("write preexisting file");

            let worker_count = 8;
            let barrier = Arc::new(Barrier::new(worker_count));
            let workers = (0..worker_count)
                .map(|_| {
                    let base = base.clone();
                    let barrier = Arc::clone(&barrier);
                    thread::spawn(move || {
                        barrier.wait();
                        create_unique_file(&base).expect("create unique file")
                    })
                })
                .collect::<Vec<_>>();
            let created = workers
                .into_iter()
                .map(|worker| worker.join().expect("file creator should not panic"))
                .collect::<Vec<_>>();
            let unique = created.iter().collect::<HashSet<_>>();

            assert_eq!(unique.len(), worker_count);
            assert!(created.iter().all(|path| path.is_file()));
            assert_eq!(
                fs::read(&base).expect("read existing file"),
                b"existing data"
            );
            fs::remove_dir_all(root).expect("remove test root");
        }

        #[test]
        fn directory_creation_retries_an_existing_candidate() {
            let root = test_root("directories");
            fs::create_dir_all(&root).expect("create test root");
            let base = root.join("New Folder");
            fs::create_dir(&base).expect("create preexisting directory");
            fs::write(base.join("keep.txt"), b"keep").expect("write preexisting child");

            let created = create_unique_directory(&base).expect("create unique directory");

            assert_eq!(created, root.join("New Folder 1"));
            assert!(created.is_dir());
            assert_eq!(
                fs::read(base.join("keep.txt")).expect("read existing child"),
                b"keep"
            );
            fs::remove_dir_all(root).expect("remove test root");
        }
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
pub async fn get_entries(path: String, force_refresh: bool) -> Result<Vec<FileEntry>, String> {
    // Directory scans can block for seconds on sleeping or disconnected
    // external volumes. Use a detached filesystem thread instead of Tokio's
    // blocking pool: the window remains responsive, and a stuck volume cannot
    // keep the async runtime alive when the application exits.
    let (result_sender, mut result_receiver) = tauri::async_runtime::channel(1);
    std::thread::Builder::new()
        .name("imageexplorer-directory-scan".to_string())
        .spawn(move || {
            let result = (|| {
                if force_refresh {
                    crate::cache::invalidate_dir_cache(&path);
                }

                // If a watcher invalidates the cache while the scan is in
                // flight, retry once against the new generation. A later
                // event will schedule another refresh, while this scan must
                // never publish its stale result back into the shared cache.
                for attempt in 0..2 {
                    let (generation, cached) = crate::cache::get_dir_cache_snapshot(&path);
                    if let Some(cached) = cached {
                        return Ok(cached);
                    }

                    let entries = load_directory_entries(&path)?;
                    if crate::cache::set_dir_cache_if_generation(
                        path.clone(),
                        entries.clone(),
                        generation,
                    ) {
                        return Ok(entries);
                    }
                    if attempt == 1 {
                        return Ok(entries);
                    }
                }

                unreachable!("directory scan retry loop always returns")
            })();
            let _ = result_sender.blocking_send(result);
        })
        .map_err(|error| format!("Failed to start directory scan: {error}"))?;

    match result_receiver.recv().await {
        Some(result) => result,
        None => Err("Directory scan stopped unexpectedly".to_string()),
    }
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

                // Use symlink metadata so the UI can identify links instead of
                // silently treating them as their target. DirEntry::metadata
                // avoids the separate `is_dir` stat that previously doubled
                // metadata I/O for every regular item on external volumes.
                let metadata = entry
                    .metadata()
                    .ok()
                    .or_else(|| file_path.symlink_metadata().ok())
                    .or_else(|| fs::metadata(&file_path).ok());

                let is_symlink = metadata
                    .as_ref()
                    .map(|value| value.file_type().is_symlink())
                    .unwrap_or(false);
                let is_dir = if is_symlink {
                    fs::metadata(&file_path)
                        .map(|value| value.is_dir())
                        .unwrap_or(false)
                } else {
                    metadata
                        .as_ref()
                        .map(|value| value.is_dir())
                        .unwrap_or(false)
                };
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
    // Cache lowercase keys once instead of allocating them for every
    // comparison in the O(n log n) sort.
    entries.sort_by_cached_key(|entry| (!entry.is_dir, entry.name.to_lowercase()));

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
    if !path_exists(Path::new(&path)) {
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
    path_exists(Path::new(&path))
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
    let target_path =
        path_utils::create_unique_directory(Path::new(&path)).map_err(|error| error.to_string())?;
    // 清除父目录缓存
    if let Some(parent) = target_path.parent() {
        crate::cache::invalidate_dir_cache(&parent.to_string_lossy());
    }
    Ok(target_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_file(path: String) -> Result<String, String> {
    let target_path =
        path_utils::create_unique_file(Path::new(&path)).map_err(|error| error.to_string())?;
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

    if !path_exists(src_path) {
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
    let final_dest = if path_exists(&dest_path) {
        path_utils::get_unique_path(&dest_path)
    } else {
        dest_path
    };

    copy_path_resumable(
        src.clone(),
        final_dest.to_string_lossy().to_string(),
        false,
        |_| true,
    )?;

    // 清除目标目录缓存
    crate::cache::invalidate_dir_cache(&dest_dir);

    Ok(final_dest.to_string_lossy().to_string())
}

const COPY_BUFFER_SIZE: usize = 8 * 1024 * 1024;

pub(crate) fn path_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

/// Rename without ever replacing an entry that appeared at `destination`.
/// The ordinary Unix rename primitive replaces files atomically, which is
/// unsafe for copy publication and rollback paths that first checked for a
/// conflict. Use the platform's exclusive rename primitive instead.
#[cfg(target_os = "macos")]
pub(crate) fn rename_without_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    // SAFETY: both C strings are NUL-terminated and remain alive for the call.
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn rename_without_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    // SAFETY: both C strings are NUL-terminated and remain alive for the call.
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
pub(crate) fn rename_without_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileW(existing_file_name: *const u16, new_file_name: *const u16) -> i32;
    }

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both UTF-16 strings are NUL-terminated and remain alive for the call.
    let result = unsafe { MoveFileW(source.as_ptr(), destination.as_ptr()) };
    if result != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub(crate) fn rename_without_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    if path_exists(destination) {
        return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
    }
    fs::rename(source, destination)
}

fn files_equal(left: &Path, right: &Path) -> Result<bool, String> {
    let left_metadata = fs::metadata(left).map_err(|error| error.to_string())?;
    let right_metadata = fs::metadata(right).map_err(|error| error.to_string())?;
    if !left_metadata.is_file()
        || !right_metadata.is_file()
        || left_metadata.len() != right_metadata.len()
    {
        return Ok(false);
    }

    let mut left_file = fs::File::open(left).map_err(|error| error.to_string())?;
    let mut right_file = fs::File::open(right).map_err(|error| error.to_string())?;
    let mut left_buffer = vec![0_u8; COPY_BUFFER_SIZE];
    let mut right_buffer = vec![0_u8; COPY_BUFFER_SIZE];
    loop {
        let left_read = left_file
            .read(&mut left_buffer)
            .map_err(|error| error.to_string())?;
        let right_read = right_file
            .read(&mut right_buffer)
            .map_err(|error| error.to_string())?;
        if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
    }
}

pub(crate) fn paths_equivalent(left: &Path, right: &Path) -> Result<bool, String> {
    let left_metadata = fs::symlink_metadata(left).map_err(|error| error.to_string())?;
    let right_metadata = fs::symlink_metadata(right).map_err(|error| error.to_string())?;
    let left_type = left_metadata.file_type();
    let right_type = right_metadata.file_type();
    if left_type.is_symlink() || right_type.is_symlink() {
        return if left_type.is_symlink() && right_type.is_symlink() {
            Ok(fs::read_link(left).map_err(|error| error.to_string())?
                == fs::read_link(right).map_err(|error| error.to_string())?)
        } else {
            Ok(false)
        };
    }
    if left_metadata.is_file() || right_metadata.is_file() {
        return files_equal(left, right);
    }
    if !left_metadata.is_dir() || !right_metadata.is_dir() {
        return Ok(false);
    }

    let mut left_names = fs::read_dir(left)
        .map_err(|error| error.to_string())?
        .map(|entry| {
            entry
                .map(|entry| entry.file_name())
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut right_names = fs::read_dir(right)
        .map_err(|error| error.to_string())?
        .map(|entry| {
            entry
                .map(|entry| entry.file_name())
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    left_names.sort();
    right_names.sort();
    if left_names != right_names {
        return Ok(false);
    }
    for name in left_names {
        if !paths_equivalent(&left.join(&name), &right.join(name))? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn partial_matches_source_prefix(
    source: &Path,
    partial: &Path,
    length: u64,
) -> Result<bool, String> {
    if length == 0 {
        return Ok(true);
    }
    let mut source = fs::File::open(source).map_err(|error| error.to_string())?;
    let mut partial = open_partial_for_read(partial)?;
    let mut source_buffer = vec![0_u8; COPY_BUFFER_SIZE];
    let mut partial_buffer = vec![0_u8; COPY_BUFFER_SIZE];
    let mut remaining = length;
    while remaining > 0 {
        let requested = remaining.min(COPY_BUFFER_SIZE as u64) as usize;
        source
            .read_exact(&mut source_buffer[..requested])
            .map_err(|error| error.to_string())?;
        partial
            .read_exact(&mut partial_buffer[..requested])
            .map_err(|error| error.to_string())?;
        if source_buffer[..requested] != partial_buffer[..requested] {
            return Ok(false);
        }
        remaining -= requested as u64;
    }
    Ok(true)
}

fn open_partial_for_read(path: &Path) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path).map_err(|error| error.to_string())
}

fn open_partial_for_append(path: &Path, create_new: bool) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    options.append(true);
    if create_new {
        options.create_new(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path).map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn apply_copied_metadata(source: &Path, destination: &Path) -> Result<(), String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source_c = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| "Source path contains NUL".to_string())?;
    let destination_c = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| "Destination path contains NUL".to_string())?;
    // SAFETY: both C strings are NUL-terminated and remain alive for the call;
    // a null copyfile state requests the default metadata behavior.
    let result = unsafe {
        libc::copyfile(
            source_c.as_ptr(),
            destination_c.as_ptr(),
            std::ptr::null_mut(),
            libc::COPYFILE_METADATA,
        )
    };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ENOTSUP) {
        let permissions = fs::metadata(source)
            .map_err(|fallback| fallback.to_string())?
            .permissions();
        return fs::set_permissions(destination, permissions)
            .map_err(|fallback| fallback.to_string());
    }
    Err(format!("Could not copy file metadata: {}", error))
}

#[cfg(not(target_os = "macos"))]
fn apply_copied_metadata(source: &Path, destination: &Path) -> Result<(), String> {
    let permissions = fs::metadata(source)
        .map_err(|error| error.to_string())?
        .permissions();
    fs::set_permissions(destination, permissions).map_err(|error| error.to_string())
}

#[cfg(unix)]
fn create_symbolic_link(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::unix::fs::symlink;
    let target = fs::read_link(source).map_err(|error| error.to_string())?;
    symlink(target, destination).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn create_symbolic_link(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::fs::{symlink_dir, symlink_file, FileTypeExt};
    let target = fs::read_link(source).map_err(|error| error.to_string())?;
    let file_type = fs::symlink_metadata(source)
        .map_err(|error| error.to_string())?
        .file_type();
    if file_type.is_symlink_dir() {
        symlink_dir(target, destination).map_err(|error| error.to_string())
    } else if file_type.is_symlink_file() {
        symlink_file(target, destination).map_err(|error| error.to_string())
    } else {
        Err("Unsupported Windows symbolic link type".to_string())
    }
}

#[cfg(not(any(unix, windows)))]
fn create_symbolic_link(_source: &Path, _destination: &Path) -> Result<(), String> {
    Err("Symbolic-link copying is not supported on this platform".to_string())
}

fn copy_symlink_resumable<F, C>(
    source: &Path,
    destination: &Path,
    visible_destination: bool,
    accept_existing_destination: bool,
    on_progress: &mut F,
    on_ready: &mut C,
) -> Result<(), String>
where
    F: FnMut(u64) -> bool,
    C: FnMut(&Path, bool) -> Result<(), String>,
{
    if path_exists(destination) {
        if paths_equivalent(source, destination)? {
            return if (accept_existing_destination || !visible_destination) && on_progress(0) {
                if visible_destination {
                    on_ready(destination, true)?;
                }
                Ok(())
            } else if visible_destination && !accept_existing_destination {
                Err(format!(
                    "Destination already exists: {}",
                    destination.to_string_lossy()
                ))
            } else {
                Err("Operation cancelled".to_string())
            };
        }
        if visible_destination {
            return Err(format!(
                "Destination exists and does not match the source link: {}",
                destination.to_string_lossy()
            ));
        }
        return Err(format!(
            "Unsafe symbolic-link staging path already exists: {}",
            destination.display()
        ));
    }

    let publication_path = if visible_destination {
        partial_path_for(destination)
    } else {
        destination.to_path_buf()
    };
    let resumed_staging_link = path_exists(&publication_path);
    if resumed_staging_link {
        if !paths_equivalent(source, &publication_path)? {
            return Err(format!(
                "Unsafe symbolic-link staging path already exists: {}",
                publication_path.to_string_lossy()
            ));
        }
    } else {
        if let Some(parent) = publication_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        create_symbolic_link(source, &publication_path)?;
    }
    if visible_destination {
        on_ready(&publication_path, resumed_staging_link)?;
    }

    let link_bytes = if resumed_staging_link {
        0
    } else {
        fs::symlink_metadata(source)
            .map_err(|error| error.to_string())?
            .len()
    };
    if !on_progress(link_bytes) {
        return Err("Operation cancelled".to_string());
    }
    if !paths_equivalent(source, &publication_path)? {
        return Err(format!(
            "Symbolic-link target changed while it was being copied; staging was preserved: {}",
            publication_path.display()
        ));
    }
    if visible_destination {
        rename_without_replace(&publication_path, destination).map_err(|error| {
            format!(
                "Could not publish the symbolic link without replacing another item: {}",
                error
            )
        })?;
    }
    Ok(())
}

pub(crate) fn partial_path_for(destination: &Path) -> std::path::PathBuf {
    destination.with_file_name(format!(
        ".{}.imageexplorer-part",
        destination
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
    ))
}

fn source_name_for_staging_entry(name: &std::ffi::OsStr) -> Option<std::ffi::OsString> {
    let name = name.to_string_lossy();
    let source_name = name
        .strip_prefix('.')?
        .strip_suffix(".imageexplorer-part")?;
    if source_name.is_empty() {
        return None;
    }
    Some(std::ffi::OsString::from(source_name))
}

fn copy_single_resumable<F, C>(
    src: &Path,
    dest: &Path,
    on_progress: &mut F,
    on_ready: &mut C,
    report_ready: bool,
) -> Result<(), String>
where
    F: FnMut(u64) -> bool,
    C: FnMut(&Path, bool) -> Result<(), String>,
{
    let source_metadata = fs::metadata(src).map_err(|error| error.to_string())?;
    let source_size = source_metadata.len();
    let source_modified = source_metadata.modified().ok();
    if path_exists(dest) {
        if !paths_equivalent(src, dest)? {
            return Err(format!(
                "Destination exists and does not match the source: {}",
                dest.to_string_lossy()
            ));
        }
        if report_ready {
            on_ready(dest, true)?;
        }
        return if on_progress(0) {
            // A durable destination can exist when an operation completed its
            // filesystem work immediately before the app exited. Verify its
            // bytes instead of accepting a same-sized unrelated file.
            Ok(())
        } else {
            Err("Operation cancelled".to_string())
        };
    }

    let partial = partial_path_for(dest);
    let (offset, create_new) = match fs::symlink_metadata(&partial) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            (metadata.len(), false)
        }
        Ok(_) => {
            return Err(format!(
                "Unsafe copy staging path already exists: {}",
                partial.to_string_lossy()
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (0, true),
        Err(error) => return Err(error.to_string()),
    };
    if !create_new && report_ready {
        // A partial file is resumable only if the operation journal already
        // proves that this exact object belongs to the interrupted copy.
        on_ready(&partial, true)?;
    }
    if offset > source_size || !partial_matches_source_prefix(src, &partial, offset)? {
        return Err(format!(
            "Existing copy staging data no longer matches the source and was preserved: {}",
            partial.display()
        ));
    }

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut source = fs::File::open(src).map_err(|error| error.to_string())?;
    source
        .seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    let mut output = open_partial_for_append(&partial, create_new)?;
    if report_ready && create_new {
        // Persist ownership immediately after exclusive creation and before
        // writing any bytes, so a crash cannot leave an unclaimed partial.
        on_ready(&partial, false)?;
    }
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
    drop(output);
    let source_after = source.metadata().map_err(|error| error.to_string())?;
    if source_after.len() != source_size || source_after.modified().ok() != source_modified {
        return Err(format!(
            "Source changed while it was being copied; staging was preserved for review: {}",
            partial.display()
        ));
    }
    apply_copied_metadata(src, &partial)?;
    if report_ready {
        on_ready(&partial, true)?;
    }
    rename_without_replace(&partial, dest).map_err(|error| {
        format!(
            "Could not publish the copied file without replacing another item: {}",
            error
        )
    })?;
    Ok(())
}

fn copy_dir_recursive_resumable<F, C>(
    src: &Path,
    dest: &Path,
    on_progress: &mut F,
    on_ready: &mut C,
    is_root_staging_directory: bool,
) -> Result<(), String>
where
    F: FnMut(u64) -> bool,
    C: FnMut(&Path, bool) -> Result<(), String>,
{
    if path_exists(dest)
        && !fs::symlink_metadata(dest)
            .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
    {
        if is_root_staging_directory {
            return Err(format!(
                "Unsafe directory staging path already exists: {}",
                dest.to_string_lossy()
            ));
        }
        return Err(format!(
            "A copied directory staging item changed type and was preserved: {}",
            dest.display()
        ));
    }
    if is_root_staging_directory {
        if path_exists(dest) {
            on_ready(dest, true)?;
        } else {
            // create_dir is exclusive; create_dir_all could follow a path
            // planted after the preceding existence check.
            fs::create_dir(dest).map_err(|error| error.to_string())?;
            on_ready(dest, false)?;
        }
    } else {
        if path_exists(dest) {
            if !fs::symlink_metadata(dest)
                .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
            {
                return Err(format!(
                    "A copied directory staging item changed type and was preserved: {}",
                    dest.display()
                ));
            }
        } else {
            fs::create_dir(dest).map_err(|error| error.to_string())?;
        }
    }

    // Stale entries can be user-created replacements, so never delete them
    // merely because the current source no longer has the same name.
    for entry in fs::read_dir(dest).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let entry_name = entry.file_name();
        let source_path = source_name_for_staging_entry(&entry_name)
            .map(|source_name| src.join(source_name))
            .filter(|candidate| path_exists(candidate))
            .unwrap_or_else(|| src.join(&entry_name));
        if !path_exists(&source_path) {
            return Err(format!(
                "A copy staging item no longer exists in the source and was preserved: {}",
                entry.path().display()
            ));
        }
    }

    for entry in fs::read_dir(src).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        let source_metadata = fs::symlink_metadata(&src_path).map_err(|error| error.to_string())?;
        if source_metadata.file_type().is_symlink() {
            copy_symlink_resumable(&src_path, &dest_path, false, true, on_progress, on_ready)?;
        } else if source_metadata.is_dir() {
            copy_dir_recursive_resumable(&src_path, &dest_path, on_progress, on_ready, false)?;
        } else {
            if path_exists(&dest_path) && !paths_equivalent(&src_path, &dest_path)? {
                return Err(format!(
                    "A copied file staging item changed and was preserved: {}",
                    dest_path.display()
                ));
            }
            copy_single_resumable(&src_path, &dest_path, on_progress, on_ready, false)?;
        }
    }
    apply_copied_metadata(src, dest)?;
    if is_root_staging_directory {
        on_ready(dest, true)?;
    }
    Ok(())
}

/// Copies `src` to one exact destination path. Incomplete files and
/// directories are kept under a hidden `.imageexplorer-part` sibling so the
/// visible destination only appears after the copy is durable.
pub fn copy_path_resumable<F>(
    src: String,
    destination: String,
    accept_existing_destination: bool,
    on_progress: F,
) -> Result<(), String>
where
    F: FnMut(u64) -> bool,
{
    copy_path_resumable_with_ready(
        src,
        destination,
        accept_existing_destination,
        on_progress,
        |_, _| Ok(()),
    )
}

/// Like `copy_path_resumable`, but reports each completed root output before
/// publishing it so the operation log can durably record its identity.
pub(crate) fn copy_path_resumable_with_ready<F, C>(
    src: String,
    destination: String,
    accept_existing_destination: bool,
    mut on_progress: F,
    mut on_ready: C,
) -> Result<(), String>
where
    F: FnMut(u64) -> bool,
    C: FnMut(&Path, bool) -> Result<(), String>,
{
    let src_path = Path::new(&src);
    let destination_path = Path::new(&destination);
    if !path_exists(src_path) {
        return Err(format!("Source does not exist: {}", src));
    }
    if src_path == destination_path {
        return Ok(());
    }

    let source_metadata = fs::symlink_metadata(src_path).map_err(|error| error.to_string())?;
    if source_metadata.file_type().is_symlink() {
        return copy_symlink_resumable(
            src_path,
            destination_path,
            true,
            accept_existing_destination,
            &mut on_progress,
            &mut on_ready,
        );
    }

    if source_metadata.is_dir() {
        let source_canonical = src_path.canonicalize().map_err(|error| error.to_string())?;
        let destination_parent = destination_path
            .parent()
            .ok_or_else(|| format!("Invalid destination path: {}", destination))?;
        let parent_canonical = destination_parent
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if parent_canonical.starts_with(&source_canonical) {
            return Err("Cannot copy a folder into itself".to_string());
        }
    }

    if path_exists(destination_path) {
        if !accept_existing_destination {
            return Err(format!("Destination already exists: {}", destination));
        }
        if !paths_equivalent(src_path, destination_path)? {
            return Err(format!(
                "Destination exists and does not match the source: {}",
                destination
            ));
        }
        on_ready(destination_path, true)?;
        if on_progress(0) {
            return Ok(());
        }
        return Err("Operation cancelled".to_string());
    }

    if let Some(parent) = destination_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    if source_metadata.is_dir() {
        let partial = partial_path_for(destination_path);
        copy_dir_recursive_resumable(src_path, &partial, &mut on_progress, &mut on_ready, true)?;
        if !on_progress(0) {
            return Err("Operation cancelled".to_string());
        }
        if path_exists(destination_path) {
            return Err(format!(
                "Destination appeared while copying: {}",
                destination
            ));
        }
        rename_without_replace(&partial, destination_path).map_err(|error| {
            format!(
                "Could not publish the copied directory without replacing another item: {}",
                error
            )
        })?;
    } else {
        copy_single_resumable(
            src_path,
            destination_path,
            &mut on_progress,
            &mut on_ready,
            true,
        )?;
    }

    if let Some(parent) = destination_path.parent() {
        crate::cache::invalidate_dir_cache(&parent.to_string_lossy());
    }
    Ok(())
}

/// Moves `src` to one exact destination. Same-volume moves use an atomic
/// rename. Cross-volume moves reuse the resumable hidden copy and only remove
/// the source after the destination is complete and cancellation is checked.
pub fn move_path_resumable<F>(
    src: String,
    destination: String,
    accept_existing_destination: bool,
    on_progress: F,
) -> Result<(), String>
where
    F: FnMut(u64) -> bool,
{
    move_path_resumable_with_ready(
        src,
        destination,
        accept_existing_destination,
        on_progress,
        |_, _| Ok(()),
    )
}

/// Like `move_path_resumable`, but reports the destination identity before a
/// cross-volume move removes its source.
pub(crate) fn move_path_resumable_with_ready<F, C>(
    src: String,
    destination: String,
    accept_existing_destination: bool,
    mut on_progress: F,
    mut on_ready: C,
) -> Result<(), String>
where
    F: FnMut(u64) -> bool,
    C: FnMut(&Path, bool) -> Result<(), String>,
{
    let src_path = Path::new(&src);
    let destination_path = Path::new(&destination);
    if src_path == destination_path {
        return Ok(());
    }
    if !path_exists(src_path) {
        return Err(format!("Source does not exist: {}", src));
    }

    let source_parent = src_path.parent().map(|parent| parent.to_path_buf());
    if rename_without_replace(src_path, destination_path).is_ok() {
        on_ready(destination_path, false)?;
        if let Some(parent) = source_parent.as_deref() {
            crate::cache::invalidate_dir_cache(&parent.to_string_lossy());
        }
        if let Some(parent) = destination_path.parent() {
            crate::cache::invalidate_dir_cache(&parent.to_string_lossy());
        }
        return Ok(());
    }

    copy_path_resumable_with_ready(
        src.clone(),
        destination.clone(),
        accept_existing_destination,
        &mut on_progress,
        &mut on_ready,
    )?;
    // Recheck both the completed target and source immediately before the
    // destructive cross-volume source removal.
    on_ready(destination_path, true)?;
    if !on_progress(0) {
        return Err("Operation cancelled".to_string());
    }
    if !paths_equivalent(src_path, destination_path)? {
        return Err(
            "Source changed before cross-volume move deletion; the source was retained".to_string(),
        );
    }

    let source_metadata = fs::symlink_metadata(src_path).map_err(|error| error.to_string())?;
    if source_metadata.is_dir() && !source_metadata.file_type().is_symlink() {
        fs::remove_dir_all(src_path).map_err(|error| {
            format!(
                "Destination was copied, but the source directory could not be removed: {}",
                error
            )
        })?;
    } else {
        fs::remove_file(src_path).map_err(|error| {
            format!(
                "Destination was copied, but the source file could not be removed: {}",
                error
            )
        })?;
    }

    if let Some(parent) = source_parent.as_deref() {
        crate::cache::invalidate_dir_cache(&parent.to_string_lossy());
    }
    Ok(())
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

    move_path_resumable(src, final_dest.to_string_lossy().to_string(), false, |_| {
        true
    })?;
    if let Some(parent_path) = src_parent {
        crate::cache::invalidate_dir_cache(&parent_path);
    }
    Ok(final_dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn rename(path: String, new_name: String) -> Result<(), String> {
    let path_obj = Path::new(&path);
    validate_file_name(&new_name)?;
    if fs::symlink_metadata(path_obj).is_err() {
        return Err("Source does not exist".to_string());
    }
    let parent = path_obj.parent().ok_or("Invalid path")?;
    let new_path = parent.join(&new_name);

    if new_path == path_obj {
        return Ok(());
    }

    if fs::symlink_metadata(&new_path).is_ok() {
        if !same_filesystem_entry(path_obj, &new_path) {
            return Err("Target name already exists".to_string());
        }
        // Case-only renames on case-insensitive filesystems resolve both paths
        // to the same entry and need the native rename behavior.
        fs::rename(&path, &new_path).map_err(|e| e.to_string())?;
    } else {
        rename_without_replace(path_obj, &new_path).map_err(|error| {
            format!("Could not rename without replacing another item: {}", error)
        })?;
    }
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

const DEFAULT_COUNTER_PATTERN: &str = "{name}_{counter}";

#[derive(Debug)]
struct RenamePlan {
    original: std::path::PathBuf,
    target: std::path::PathBuf,
    temporary: std::path::PathBuf,
}

fn validate_file_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("A file name is required".to_string());
    }
    if matches!(name, "." | "..") {
        return Err("The names '.' and '..' are reserved".to_string());
    }
    if name.contains(['/', '\\', '\0']) {
        return Err("A file name cannot contain path separators or NUL".to_string());
    }
    let mut components = Path::new(name).components();
    if !matches!(components.next(), Some(std::path::Component::Normal(_)))
        || components.next().is_some()
    {
        return Err("The new name must be a single file name".to_string());
    }

    #[cfg(windows)]
    {
        if name.ends_with([' ', '.']) || name.contains(['<', '>', ':', '"', '|', '?', '*']) {
            return Err("The file name contains characters reserved by Windows".to_string());
        }
        let base = name
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let reserved = matches!(
            base.as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        );
        if reserved {
            return Err("The file name is reserved by Windows".to_string());
        }
    }
    Ok(())
}

fn same_filesystem_entry(left: &Path, right: &Path) -> bool {
    let (Ok(left_metadata), Ok(right_metadata)) =
        (fs::symlink_metadata(left), fs::symlink_metadata(right))
    else {
        return false;
    };

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left_metadata.dev() == right_metadata.dev() && left_metadata.ino() == right_metadata.ino()
    }
    #[cfg(not(unix))]
    {
        fs::canonicalize(left).ok() == fs::canonicalize(right).ok()
    }
}

fn rename_collision_key(path: &Path) -> String {
    let value = path.to_string_lossy().to_string();
    #[cfg(any(target_os = "macos", windows))]
    {
        value.to_lowercase()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        value
    }
}

fn batch_rename_failure(total: usize, errors: Vec<String>) -> BatchRenameResult {
    BatchRenameResult {
        success: 0,
        failed: total,
        errors,
    }
}

fn rollback_staged_renames(plans: &[RenamePlan]) -> Vec<String> {
    let mut errors = Vec::new();
    for plan in plans.iter().rev() {
        if fs::symlink_metadata(&plan.temporary).is_ok() {
            if let Err(error) = rename_without_replace(&plan.temporary, &plan.original) {
                errors.push(format!(
                    "rollback '{}' failed: {}",
                    plan.original.to_string_lossy(),
                    error
                ));
            }
        }
    }
    errors
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
    let mut errors = Vec::new();
    let mut planned_targets = std::collections::HashSet::new();
    let source_paths = paths
        .iter()
        .map(std::path::PathBuf::from)
        .collect::<Vec<_>>();
    let effective_pattern = if mode == "counter" && pattern.is_empty() {
        DEFAULT_COUNTER_PATTERN
    } else {
        pattern.as_str()
    };
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut plans = Vec::new();

    for (i, path_str) in paths.iter().enumerate() {
        let path_obj = Path::new(path_str);
        let source_metadata = match fs::symlink_metadata(path_obj) {
            Ok(metadata) => metadata,
            Err(_) => {
                errors.push(format!("{}: source does not exist", path_str));
                continue;
            }
        };
        let parent = match path_obj.parent() {
            Some(p) => p,
            None => {
                errors.push(format!("{}: invalid path", path_str));
                continue;
            }
        };

        // 处理文件名和扩展名（支持点文件如 .bashrc）
        let file_name = match path_obj.file_name() {
            Some(s) => s.to_string_lossy().to_string(),
            None => {
                errors.push(format!("{}: no filename", path_str));
                continue;
            }
        };
        let (old_name, ext) = if source_metadata.is_dir() {
            (file_name.clone(), String::new())
        } else {
            (
                path_obj
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| file_name.clone()),
                path_obj
                    .extension()
                    .map(|e| format!(".{}", e.to_string_lossy()))
                    .unwrap_or_default(),
            )
        };

        let new_name = match mode.as_str() {
            "replace" => {
                let find_str = find.as_deref().unwrap_or("");
                if find_str.is_empty() {
                    errors.push(format!("{}: find string is empty", path_str));
                    continue;
                }
                format!("{}{}", old_name.replace(find_str, effective_pattern), ext)
            }
            "prefix" => format!("{}{}{}", effective_pattern, old_name, ext),
            "suffix" => format!("{}{}{}", old_name, effective_pattern, ext),
            "counter" => {
                let counter = format!("{}", i + 1);
                let name = effective_pattern
                    .replace("{counter}", &counter)
                    .replace("{name}", &old_name);
                format!("{}{}", name, ext)
            }
            _ => {
                errors.push(format!("{}: unknown mode '{}'", path_str, mode));
                continue;
            }
        };

        if let Err(error) = validate_file_name(&new_name) {
            errors.push(format!("{}: {}", file_name, error));
            continue;
        }

        let new_path = parent.join(&new_name);
        let target_key = rename_collision_key(&new_path);
        if !planned_targets.insert(target_key) {
            errors.push(format!(
                "{}: multiple items would be renamed to '{}'",
                old_name, new_name
            ));
            continue;
        }
        if fs::symlink_metadata(&new_path).is_ok()
            && !source_paths
                .iter()
                .any(|source| same_filesystem_entry(source, &new_path))
        {
            errors.push(format!(
                "{}: target '{}' already exists",
                old_name, new_name
            ));
            continue;
        }
        if new_path == path_obj {
            continue;
        }

        let temporary = path_utils::get_unique_path(
            &parent.join(format!(".imageexplorer-rename-{}-{}", stamp, i)),
        );
        plans.push(RenamePlan {
            original: path_obj.to_path_buf(),
            target: new_path,
            temporary,
        });
    }

    if !errors.is_empty() {
        return Ok(batch_rename_failure(paths.len(), errors));
    }

    for (staged_count, plan) in plans.iter().enumerate() {
        if let Err(error) = rename_without_replace(&plan.original, &plan.temporary) {
            errors.push(format!(
                "could not stage '{}': {}",
                plan.original.to_string_lossy(),
                error
            ));
            errors.extend(rollback_staged_renames(&plans[..staged_count]));
            return Ok(batch_rename_failure(paths.len(), errors));
        }
    }

    let mut committed_count = 0_usize;
    for plan in &plans {
        if fs::symlink_metadata(&plan.target).is_ok() {
            errors.push(format!(
                "target appeared during rename: {}",
                plan.target.to_string_lossy()
            ));
        } else if let Err(error) = rename_without_replace(&plan.temporary, &plan.target) {
            errors.push(format!(
                "could not rename '{}' to '{}': {}",
                plan.original.to_string_lossy(),
                plan.target.to_string_lossy(),
                error
            ));
        } else {
            committed_count += 1;
            continue;
        }

        // Move committed targets back to their private staging paths first,
        // then restore every source. This also handles rename cycles safely.
        for committed in plans[..committed_count].iter().rev() {
            if let Err(error) = rename_without_replace(&committed.target, &committed.temporary) {
                errors.push(format!(
                    "could not stage committed target '{}' for rollback: {}",
                    committed.target.to_string_lossy(),
                    error
                ));
            }
        }
        errors.extend(rollback_staged_renames(&plans));
        return Ok(batch_rename_failure(paths.len(), errors));
    }

    let mut parents_to_invalidate = std::collections::HashSet::new();
    for plan in &plans {
        if let Some(parent) = plan.original.parent() {
            parents_to_invalidate.insert(parent.to_string_lossy().to_string());
        }
        if let Some(parent) = plan.target.parent() {
            parents_to_invalidate.insert(parent.to_string_lossy().to_string());
        }
    }
    for parent in parents_to_invalidate {
        crate::cache::invalidate_dir_cache(&parent);
    }

    Ok(BatchRenameResult {
        success: paths.len(),
        failed: 0,
        errors: Vec::new(),
    })
}

#[cfg(test)]
mod file_entry_tests {
    use super::{
        batch_rename, copy_path_resumable, get_file_entry, is_alias_entry, load_directory_entries,
        move_path_resumable, package_type, partial_path_for, rename, rename_without_replace,
        validate_file_name,
    };
    use std::fs;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEST_ROOT: AtomicU64 = AtomicU64::new(1);

    fn test_root() -> std::path::PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after the epoch")
            .as_nanos();
        let sequence = NEXT_TEST_ROOT.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "imageexplorer-file-entry-{}-{stamp}-{sequence}",
            std::process::id()
        ))
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

        let listed = load_directory_entries(root.to_string_lossy().as_ref())
            .expect("enumerate file-entry fixture");
        assert_eq!(
            listed.first().map(|entry| entry.name.as_str()),
            Some("Editor.app")
        );
        assert!(listed.iter().any(|entry| entry.name == ".hidden.txt"));
        #[cfg(unix)]
        assert!(listed
            .iter()
            .find(|entry| entry.name == "file-link")
            .is_some_and(|entry| entry.is_symlink && !entry.is_dir));

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn resumable_copy_keeps_partial_data_for_retry() {
        let root = test_root();
        let destination = root.join("destination");
        let source = root.join("large.bin");
        let final_path = destination.join("large.bin");
        fs::create_dir_all(&destination).expect("create destination");
        fs::write(&source, vec![7_u8; 1024 * 1024]).expect("write source");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&source, fs::Permissions::from_mode(0o740))
                .expect("set source permissions");
        }

        let mut first_callback = true;
        let first = copy_path_resumable(
            source.to_string_lossy().to_string(),
            final_path.to_string_lossy().to_string(),
            false,
            |_| !std::mem::take(&mut first_callback),
        );
        assert!(first.is_err());

        let mut copied = 0_u64;
        copy_path_resumable(
            source.to_string_lossy().to_string(),
            final_path.to_string_lossy().to_string(),
            true,
            |bytes| {
                copied += bytes;
                true
            },
        )
        .expect("resume copy");
        assert_eq!(copied, 0);
        assert_eq!(
            fs::metadata(&final_path).expect("final file").len(),
            1024 * 1024
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&final_path)
                    .expect("final file metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o740
            );
        }

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn existing_same_size_destination_is_verified_and_never_replaced() {
        let root = test_root();
        let source = root.join("source.raw");
        let destination = root.join("destination.raw");
        fs::create_dir_all(&root).expect("create test root");
        fs::write(&source, b"AAAA").expect("write source");
        fs::write(&destination, b"BBBB").expect("write destination");

        let result = copy_path_resumable(
            source.to_string_lossy().to_string(),
            destination.to_string_lossy().to_string(),
            true,
            |_| true,
        );

        assert!(result.is_err());
        assert_eq!(
            fs::read(&destination).expect("read preserved destination"),
            b"BBBB"
        );
        assert_eq!(fs::read(&source).expect("read source"), b"AAAA");
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn changed_source_preserves_a_stale_partial_prefix_and_source() {
        let root = test_root();
        let source = root.join("source.raw");
        let destination = root.join("destination.raw");
        fs::create_dir_all(&root).expect("create test root");
        fs::write(&source, vec![1_u8; 8 * 1024 * 1024 + 1]).expect("write original source");

        let first = copy_path_resumable(
            source.to_string_lossy().to_string(),
            destination.to_string_lossy().to_string(),
            false,
            |_| false,
        );
        assert!(first.is_err());
        assert!(partial_path_for(&destination).is_file());

        let replacement = vec![2_u8; 8 * 1024 * 1024 + 1];
        fs::write(&source, &replacement).expect("replace source bytes");
        let resumed = copy_path_resumable(
            source.to_string_lossy().to_string(),
            destination.to_string_lossy().to_string(),
            true,
            |_| true,
        );

        assert!(resumed.is_err());
        assert!(!destination.exists());
        assert_eq!(fs::read(&source).expect("read source"), replacement);
        let preserved_partial =
            fs::read(partial_path_for(&destination)).expect("read preserved partial");
        assert_eq!(preserved_partial.len(), 8 * 1024 * 1024);
        assert!(preserved_partial.first().is_some_and(|byte| *byte == 1));
        assert!(preserved_partial.last().is_some_and(|byte| *byte == 1));
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn exclusive_rename_does_not_replace_an_existing_item() {
        let root = test_root();
        let source = root.join("source.raw");
        let destination = root.join("destination.raw");
        fs::create_dir_all(&root).expect("create test root");
        fs::write(&source, b"source").expect("write source");
        fs::write(&destination, b"destination").expect("write destination");

        assert!(rename_without_replace(&source, &destination).is_err());
        assert_eq!(fs::read(&source).expect("read source"), b"source");
        assert_eq!(
            fs::read(&destination).expect("read destination"),
            b"destination"
        );
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn cancelled_directory_copy_stays_hidden_and_resumes_to_the_same_target() {
        let root = test_root();
        let source = root.join("source");
        let destination = root.join("copied");
        fs::create_dir_all(&source).expect("create source directory");
        fs::write(source.join("image.raw"), vec![9_u8; 1024 * 1024]).expect("write source file");

        let cancelled = copy_path_resumable(
            source.to_string_lossy().to_string(),
            destination.to_string_lossy().to_string(),
            false,
            |_| false,
        );
        assert!(cancelled.is_err());
        assert!(!destination.exists());
        assert!(partial_path_for(&destination).exists());

        copy_path_resumable(
            source.to_string_lossy().to_string(),
            destination.to_string_lossy().to_string(),
            true,
            |_| true,
        )
        .expect("resume directory copy");
        assert!(destination.join("image.raw").is_file());
        assert!(!partial_path_for(&destination).exists());

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[cfg(unix)]
    #[test]
    fn resumable_directory_copy_preserves_relative_symbolic_links() {
        use std::os::unix::fs::symlink;

        let root = test_root();
        let source = root.join("source");
        let destination = root.join("copied");
        fs::create_dir_all(&source).expect("create source directory");
        fs::write(source.join("photo.raw"), b"raw").expect("write source file");
        symlink("photo.raw", source.join("latest.raw")).expect("create relative symlink");

        copy_path_resumable(
            source.to_string_lossy().to_string(),
            destination.to_string_lossy().to_string(),
            false,
            |_| true,
        )
        .expect("copy directory with symbolic link");

        let copied_link = destination.join("latest.raw");
        assert!(fs::symlink_metadata(&copied_link)
            .expect("copied link metadata")
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_link(&copied_link).expect("read copied link target"),
            Path::new("photo.raw")
        );
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn cancelled_cross_volume_style_move_keeps_source_until_retry() {
        let root = test_root();
        let source = root.join("source.raw");
        let destination = root.join("destination.raw");
        fs::create_dir_all(&root).expect("create test root");
        fs::write(&source, b"camera data").expect("write source");
        // A durable destination with the source still present models the
        // copy-complete/delete-pending point of a cross-volume move.
        fs::write(&destination, b"camera data").expect("write copied destination");

        let cancelled = move_path_resumable(
            source.to_string_lossy().to_string(),
            destination.to_string_lossy().to_string(),
            true,
            |_| false,
        );
        assert!(cancelled.is_err());
        assert!(source.exists());
        assert!(destination.exists());

        move_path_resumable(
            source.to_string_lossy().to_string(),
            destination.to_string_lossy().to_string(),
            true,
            |_| true,
        )
        .expect("retry move deletion");
        assert!(!source.exists());
        assert_eq!(
            fs::read(&destination).expect("read destination"),
            b"camera data"
        );

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn cross_volume_move_keeps_a_source_changed_before_deletion() {
        let root = test_root();
        let source = root.join("source.raw");
        let destination = root.join("destination.raw");
        fs::create_dir_all(&root).expect("create test root");
        fs::write(&source, b"original camera data").expect("write original source");
        fs::write(&destination, b"original camera data").expect("write copied destination");
        let mut changed_source = false;

        let result = move_path_resumable(
            source.to_string_lossy().to_string(),
            destination.to_string_lossy().to_string(),
            true,
            |_| {
                if !changed_source {
                    fs::write(&source, b"source changed during move")
                        .expect("change source before deletion");
                    changed_source = true;
                }
                true
            },
        );

        assert!(result.is_err());
        assert_eq!(
            fs::read(&source).expect("read retained source"),
            b"source changed during move"
        );
        assert_eq!(
            fs::read(&destination).expect("read preserved destination"),
            b"original camera data"
        );
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn rename_rejects_path_escape_and_reserved_components() {
        assert!(validate_file_name("").is_err());
        assert!(validate_file_name(".").is_err());
        assert!(validate_file_name("..").is_err());
        assert!(validate_file_name("../outside.raw").is_err());
        assert!(validate_file_name("folder/file.raw").is_err());

        let root = test_root();
        let folder = root.join("folder");
        let source = folder.join("inside.raw");
        fs::create_dir_all(&folder).expect("create folder");
        fs::write(&source, b"raw").expect("write source");

        let result = rename(
            source.to_string_lossy().to_string(),
            "../outside.raw".to_string(),
        );
        assert!(result.is_err());
        assert!(source.exists());
        assert!(!root.join("outside.raw").exists());

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn counter_batch_rename_uses_the_preview_default() {
        let root = test_root();
        fs::create_dir_all(&root).expect("create test root");
        let first = root.join("alpha.raw");
        let second = root.join("beta.raw");
        fs::write(&first, b"alpha").expect("write first source");
        fs::write(&second, b"beta").expect("write second source");

        let result = batch_rename(
            vec![
                first.to_string_lossy().to_string(),
                second.to_string_lossy().to_string(),
            ],
            String::new(),
            "counter".to_string(),
            None,
        )
        .expect("rename batch");

        assert_eq!(result.success, 2);
        assert_eq!(result.failed, 0);
        assert!(root.join("alpha_1.raw").is_file());
        assert!(root.join("beta_2.raw").is_file());

        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn batch_rename_treats_a_directory_dot_as_part_of_its_name() {
        let root = test_root();
        fs::create_dir_all(root.join("album.2026")).expect("create dotted directory");

        let result = batch_rename(
            vec![root.join("album.2026").to_string_lossy().to_string()],
            "edited-".to_string(),
            "prefix".to_string(),
            None,
        )
        .expect("rename dotted directory");

        assert_eq!(result.success, 1);
        assert!(root.join("edited-album.2026").is_dir());
        assert!(!root.join("album.edited-2026").exists());
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn batch_rename_preflight_prevents_partial_collision_changes() {
        let root = test_root();
        fs::create_dir_all(&root).expect("create test root");
        let first = root.join("cat.raw");
        let second = root.join("bat.raw");
        fs::write(&first, b"cat").expect("write first source");
        fs::write(&second, b"bat").expect("write second source");

        let result = batch_rename(
            vec![
                first.to_string_lossy().to_string(),
                second.to_string_lossy().to_string(),
            ],
            "bat".to_string(),
            "replace".to_string(),
            Some("cat".to_string()),
        )
        .expect("preflight batch");

        assert_eq!(result.success, 0);
        assert_eq!(result.failed, 2);
        assert!(first.is_file());
        assert!(second.is_file());
        assert_eq!(fs::read(&first).expect("read first"), b"cat");
        assert_eq!(fs::read(&second).expect("read second"), b"bat");

        fs::remove_dir_all(root).expect("remove test root");
    }
}
