use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::{hash_map::DefaultHasher, HashSet};
#[cfg(target_os = "macos")]
use std::ffi::CString;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

// Suppress deprecation warnings is NO LONGER NEEDED as we removed cocoa.
// #![allow(deprecated)]

/// 已安装应用信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledApp {
    pub name: String,
    pub bundle_id: String,
    pub path: String,
    pub icon_path: Option<String>,
    pub icon_base64: Option<String>, // 新增 base64 图标数据
    pub is_terminal: bool,
}

#[cfg(target_os = "macos")]
fn close_native_quick_look_process(
    native_quick_look: &tauri::State<'_, crate::NativeQuickLookState>,
) -> Result<(), String> {
    let mut child_guard = native_quick_look
        .lock()
        .map_err(|_| "Failed to lock native Quick Look process".to_string())?;

    if let Some(mut child) = child_guard.take() {
        match child.try_wait() {
            Ok(Some(_)) => Ok(()),
            Ok(None) => {
                child
                    .kill()
                    .map_err(|e| format!("Failed to close native Quick Look: {}", e))?;
                let _ = child.wait();
                Ok(())
            }
            Err(e) => Err(format!(
                "Failed to inspect native Quick Look process: {}",
                e
            )),
        }
    } else {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn reorder_quick_look_paths(paths: Vec<String>, current_path: Option<String>) -> Vec<String> {
    const MAX_NATIVE_QUICK_LOOK_ITEMS: usize = 9;
    let mut seen = HashSet::new();
    let mut valid_paths = paths
        .into_iter()
        .filter(|path| !path.is_empty())
        .filter(|path| Path::new(path).exists())
        .filter(|path| seen.insert(path.clone()))
        .collect::<Vec<_>>();

    let current_index = current_path
        .as_ref()
        .and_then(|path| valid_paths.iter().position(|item| item == path));

    if valid_paths.len() > MAX_NATIVE_QUICK_LOOK_ITEMS {
        let center = current_index.unwrap_or(0);
        let half_window = MAX_NATIVE_QUICK_LOOK_ITEMS / 2;
        let start = center
            .saturating_sub(half_window)
            .min(valid_paths.len() - MAX_NATIVE_QUICK_LOOK_ITEMS);
        valid_paths = valid_paths
            .into_iter()
            .skip(start)
            .take(MAX_NATIVE_QUICK_LOOK_ITEMS)
            .collect();
    }

    if let Some(current_path) = current_path {
        if let Some(current_index) = valid_paths.iter().position(|path| path == &current_path) {
            let current = valid_paths.remove(current_index);
            valid_paths.insert(0, current);
        }
    }

    valid_paths
}

/// 已知终端应用的 Bundle ID
const TERMINAL_BUNDLE_IDS: &[&str] = &[
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "dev.warp.Warp-Stable",
    "co.zeit.hyper",
    "net.kovidgoyal.kitty",
    "io.alacritty",
    "com.github.wez.wezterm",
    "com.termius.mac",
];

/// 终端启动配置
#[cfg(target_os = "macos")]
struct TerminalLaunchConfig {
    bundle_id: &'static str,
    executable: &'static str,
    args: &'static [&'static str],
}

#[cfg(target_os = "macos")]
const SPECIAL_TERMINALS: &[TerminalLaunchConfig] = &[
    TerminalLaunchConfig {
        bundle_id: "net.kovidgoyal.kitty",
        executable: "/Applications/kitty.app/Contents/MacOS/kitty",
        args: &["--directory"],
    },
    TerminalLaunchConfig {
        bundle_id: "io.alacritty",
        executable: "/Applications/Alacritty.app/Contents/MacOS/alacritty",
        args: &["--working-directory"],
    },
    TerminalLaunchConfig {
        bundle_id: "com.github.wez.wezterm",
        executable: "/Applications/WezTerm.app/Contents/MacOS/wezterm",
        args: &["start", "--cwd"],
    },
];

/// 图标工具模块
#[cfg(target_os = "macos")]
mod icon_utils {
    use base64::{engine::general_purpose, Engine as _};
    use objc2_app_kit::{NSBitmapImageRep, NSImage, NSPNGFileType};
    use objc2_foundation::{NSDictionary, NSSize};

    /// 将 NSImage 转换为 PNG 字节
    pub unsafe fn ns_image_to_png_bytes(image: &NSImage, size: f64) -> Option<Vec<u8>> {
        image.setSize(NSSize::new(size, size));

        let tiff_data = image.TIFFRepresentation()?;
        let bitmap_rep = NSBitmapImageRep::imageRepWithData(&tiff_data)?;
        let props = NSDictionary::new();
        let png_data = bitmap_rep.representationUsingType_properties(NSPNGFileType, &props)?;

        Some(png_data.bytes().to_vec())
    }

    /// 将 NSImage 转换为 Base64 PNG
    pub unsafe fn ns_image_to_base64(image: &NSImage, size: f64) -> Option<String> {
        let bytes = ns_image_to_png_bytes(image, size)?;
        Some(general_purpose::STANDARD.encode(bytes))
    }
}

#[cfg(target_os = "macos")]
fn quicklook_thumbnail_path(output_dir: &Path, source_path: &Path) -> Option<PathBuf> {
    let file_name = source_path.file_name()?.to_string_lossy();
    let png_path = output_dir.join(format!("{}.png", file_name));
    if png_path.exists() {
        return Some(png_path);
    }

    fs::read_dir(output_dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.extension().is_some_and(|ext| ext == "png"))
}

#[cfg(target_os = "macos")]
fn generate_quicklook_thumbnail_bytes(path: &Path, size: f64) -> Option<Vec<u8>> {
    if path.is_dir() {
        return None;
    }

    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    let path_hash = hasher.finish();
    let temp_root = std::env::temp_dir().join("imageexplorer-quicklook");
    let cache_hint = format!("{}-{}", path_hash, size.round() as u32);
    let output_dir = temp_root.join(cache_hint);

    let _ = fs::remove_dir_all(&output_dir);
    fs::create_dir_all(&output_dir).ok()?;

    let status = Command::new("/usr/bin/qlmanage")
        .args([
            "-t",
            "-s",
            &format!("{}", size.round() as u32),
            "-o",
            output_dir.to_string_lossy().as_ref(),
            path.to_string_lossy().as_ref(),
        ])
        .output()
        .ok()?;

    if !status.status.success() {
        let _ = fs::remove_dir_all(&output_dir);
        return None;
    }

    let thumbnail_path = quicklook_thumbnail_path(&output_dir, path)?;
    let bytes = std::fs::read(&thumbnail_path).ok();
    let _ = fs::remove_dir_all(&output_dir);
    bytes
}

#[cfg(target_os = "macos")]
fn generate_quicklook_thumbnail_bytes_in_process(
    path: &Path,
    size: f64,
    prefer_embedded: bool,
) -> Option<Vec<u8>> {
    extern "C" {
        fn imageexplorer_quicklook_thumbnail(
            path: *const std::ffi::c_char,
            size: u32,
            prefer_embedded: i32,
            length: *mut usize,
        ) -> *mut u8;
        fn imageexplorer_free_thumbnail(buffer: *mut u8);
    }

    let path = CString::new(path.to_string_lossy().as_bytes()).ok()?;
    let mut length = 0usize;
    let buffer = unsafe {
        imageexplorer_quicklook_thumbnail(
            path.as_ptr(),
            size.round() as u32,
            if prefer_embedded { 1 } else { 0 },
            &mut length,
        )
    };
    if buffer.is_null() || length == 0 {
        return None;
    }

    let bytes = unsafe { std::slice::from_raw_parts(buffer, length).to_vec() };
    unsafe { imageexplorer_free_thumbnail(buffer) };
    Some(bytes)
}

#[cfg(target_os = "macos")]
pub fn get_arw_embedded_jpeg_bytes_blocking(
    path: &str,
    max_pixel_size: u32,
) -> Option<crate::cache::CachedImageBytes> {
    let path_obj = Path::new(path);
    let metadata = fs::metadata(path_obj).ok()?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let cache_key = format!(
        "arw:{}:{}:{}:{}",
        path,
        metadata.len(),
        modified,
        max_pixel_size
    );
    if let Some(cached) = crate::cache::get_thumb_bytes_cache(&cache_key) {
        return Some(cached);
    }

    extern "C" {
        fn imageexplorer_arw_embedded_jpeg(
            path: *const std::ffi::c_char,
            max_pixel_size: u32,
            length: *mut usize,
        ) -> *mut u8;
        fn imageexplorer_free_thumbnail(buffer: *mut u8);
    }
    let c_path = CString::new(path).ok()?;
    let mut length = 0usize;
    let buffer =
        unsafe { imageexplorer_arw_embedded_jpeg(c_path.as_ptr(), max_pixel_size, &mut length) };
    if buffer.is_null() || length == 0 {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(buffer, length).to_vec() };
    unsafe { imageexplorer_free_thumbnail(buffer) };
    Some(crate::cache::set_thumb_bytes_cache(cache_key, bytes))
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn get_arw_embedded_jpeg(
    path: String,
    max_pixel_size: u32,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(cached) = get_arw_embedded_jpeg_bytes_blocking(&path, max_pixel_size) else {
            return Ok(None);
        };
        Ok(Some(
            base64::engine::general_purpose::STANDARD.encode(cached.bytes.as_slice()),
        ))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 扫描指定目录下的应用
fn scan_apps_in_dir(dir: &Path) -> Vec<InstalledApp> {
    let mut apps = Vec::new();

    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e == "app").unwrap_or(false) {
                if let Some(app) = parse_app_bundle(&path) {
                    apps.push(app);
                }
            }
        }
    }

    apps
}

/// 解析 .app bundle 获取应用信息（进程内通过 NSBundle 直接读取 Info.plist，避免为每个应用派生 defaults 子进程）
#[cfg(target_os = "macos")]
fn parse_app_bundle(app_path: &Path) -> Option<InstalledApp> {
    use objc2::{msg_send, ClassType};
    use objc2_foundation::{NSBundle, NSString};

    let info_plist = app_path.join("Contents/Info.plist");
    if !info_plist.exists() {
        return None;
    }

    let path_str = app_path.to_string_lossy();
    let (bundle_id, name, icon_name) = unsafe {
        let ns_path = NSString::from_str(&path_str);
        let bundle = NSBundle::bundleWithPath(&ns_path)?;
        let bundle_id = bundle.bundleIdentifier()?.to_string();
        if bundle_id.is_empty() {
            return None;
        }

        let read_string = |key: &str| -> Option<String> {
            let ns_key = NSString::from_str(key);
            let value = bundle.objectForInfoDictionaryKey(&ns_key)?;
            let is_string: bool = msg_send![&*value, isKindOfClass: NSString::class()];
            if !is_string {
                return None;
            }
            let ns_string = &*(objc2::rc::Retained::as_ptr(&value) as *const NSString);
            let text = ns_string.to_string();
            (!text.is_empty()).then_some(text)
        };

        let name = read_string("CFBundleName")
            .or_else(|| read_string("CFBundleDisplayName"))
            .unwrap_or_else(|| {
                app_path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Unknown")
                    .to_string()
            });
        let icon_name = read_string("CFBundleIconFile").or_else(|| read_string("CFBundleIconName"));
        (bundle_id, name, icon_name)
    };

    let icon_path = icon_name.map(|icon| {
        let mut icon_file = icon;
        if !icon_file.ends_with(".icns") {
            icon_file.push_str(".icns");
        }
        app_path
            .join("Contents/Resources")
            .join(icon_file)
            .to_string_lossy()
            .to_string()
    });

    let is_terminal = TERMINAL_BUNDLE_IDS.contains(&bundle_id.as_str());

    Some(InstalledApp {
        name,
        bundle_id,
        path: path_str.into_owned(),
        icon_path,
        icon_base64: None,
        is_terminal,
    })
}

#[cfg(not(target_os = "macos"))]
fn parse_app_bundle(_app_path: &Path) -> Option<InstalledApp> {
    None
}

const INSTALLED_APPS_CACHE_TTL: Duration = Duration::from_secs(60);

type InstalledAppsCache = Mutex<Option<(Instant, Vec<InstalledApp>)>>;

fn installed_apps_cache() -> &'static InstalledAppsCache {
    static CACHE: OnceLock<InstalledAppsCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn scan_installed_apps_cached() -> Vec<InstalledApp> {
    if let Ok(guard) = installed_apps_cache().lock() {
        if let Some((timestamp, apps)) = guard.as_ref() {
            if timestamp.elapsed() <= INSTALLED_APPS_CACHE_TTL {
                return apps.clone();
            }
        }
    }

    let mut apps = Vec::new();
    apps.extend(scan_apps_in_dir(Path::new("/Applications")));
    if let Some(home) = dirs::home_dir() {
        apps.extend(scan_apps_in_dir(&home.join("Applications")));
    }
    apps.extend(scan_apps_in_dir(Path::new("/System/Applications")));
    apps.sort_by_key(|app| app.name.to_lowercase());

    if let Ok(mut guard) = installed_apps_cache().lock() {
        *guard = Some((Instant::now(), apps.clone()));
    }
    apps
}

/// 获取所有已安装应用
#[tauri::command]
pub async fn get_installed_apps() -> Vec<InstalledApp> {
    tauri::async_runtime::spawn_blocking(scan_installed_apps_cached)
        .await
        .unwrap_or_default()
}

/// 获取终端类应用
#[tauri::command]
pub async fn get_terminal_apps() -> Vec<InstalledApp> {
    tauri::async_runtime::spawn_blocking(|| {
        scan_installed_apps_cached()
            .into_iter()
            .filter(|app| app.is_terminal)
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// 获取指定文件的推荐打开应用
#[tauri::command]
pub async fn get_recommended_apps(path: String) -> Vec<InstalledApp> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSWorkspace;
        use objc2_foundation::{NSBundle, NSString, NSURL};

        unsafe {
            let workspace = NSWorkspace::sharedWorkspace();
            let path_ns = NSString::from_str(&path);
            let file_url = NSURL::fileURLWithPath(&path_ns);

            let app_urls = workspace.URLsForApplicationsToOpenURL(&file_url);
            let mut results = Vec::new();
            let count = app_urls.count();

            for i in 0..count {
                let app_url = app_urls.objectAtIndex(i);

                // Get Path
                let app_path_ns = app_url.path();
                let app_path = app_path_ns.map(|s| s.to_string()).unwrap_or_default();

                // Get Bundle ID
                let bundle = NSBundle::bundleWithURL(&app_url);
                let bundle_id = if let Some(b) = &bundle {
                    b.bundleIdentifier()
                        .map(|s| s.to_string())
                        .unwrap_or_default()
                } else {
                    String::new()
                };

                // Get Name from file system
                let mut name = app_url
                    .lastPathComponent()
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                if name.ends_with(".app") {
                    name = name[..name.len() - 4].to_string();
                }

                results.push(InstalledApp {
                    name,
                    bundle_id: bundle_id.clone(),
                    path: app_path,
                    icon_path: None,
                    icon_base64: None,
                    is_terminal: TERMINAL_BUNDLE_IDS.contains(&bundle_id.as_str()),
                });
            }
            results
        }
    }

    #[cfg(not(target_os = "macos"))]
    Vec::new()
}

/// 获取应用图标 (Base64)
#[tauri::command]
pub async fn get_app_icon(app: tauri::AppHandle, app_path: String) -> Option<String> {
    // 先检查缓存
    let cache_key = format!("path:{}", app_path);
    if let Some(cached) = crate::cache::get_icon_cache(&cache_key) {
        return Some(cached);
    }

    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        let path_clone = app_path.clone();

        // 将 AppKit 调用调度到主线程，避免崩溃
        let _ = app.run_on_main_thread(move || {
            use objc2_app_kit::NSWorkspace;
            use objc2_foundation::NSString;

            let result = unsafe {
                let workspace = NSWorkspace::sharedWorkspace();
                let path_ns = NSString::from_str(&path_clone);
                let icon = workspace.iconForFile(&path_ns);
                icon_utils::ns_image_to_base64(&icon, 128.0)
            };
            let _ = tx.send(result);
        });

        // 等待主线程结果
        let result = rx.recv().unwrap_or(None);

        // 存入缓存
        if let Some(ref base64) = result {
            crate::cache::set_icon_cache(cache_key, base64.clone());
        }

        result
    }

    #[cfg(not(target_os = "macos"))]
    None
}

/// 获取指定文件/文件夹的原生缩略图或图标（原始二进制字节，供 thumb:// 协议零 Base64 使用）
pub fn get_file_thumbnail_bytes_blocking_generic<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    path: String,
    size: Option<f64>,
    allow_icon_fallback: Option<bool>,
    prefer_embedded: Option<bool>,
) -> Option<crate::cache::CachedImageBytes> {
    let path_obj = Path::new(&path);
    let metadata = fs::metadata(path_obj).ok()?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let size_val = size.unwrap_or(128.0).clamp(16.0, 8192.0);
    let allow_icon_fallback = allow_icon_fallback.unwrap_or(true);
    let prefer_embedded = prefer_embedded.unwrap_or(false);

    let image_cache_key = format!(
        "file:{}:{}:{}:{}:{}",
        path,
        metadata.len(),
        modified,
        size_val.round() as u32,
        if prefer_embedded { "embedded" } else { "full" }
    );
    let icon_cache_key = format!("{}:icon", image_cache_key);
    if let Some(cached) = crate::cache::get_thumb_bytes_cache(&image_cache_key) {
        return Some(cached);
    }
    if allow_icon_fallback {
        if let Some(cached) = crate::cache::get_thumb_bytes_cache(&icon_cache_key) {
            return Some(cached);
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(bytes) =
            generate_quicklook_thumbnail_bytes_in_process(path_obj, size_val, prefer_embedded)
        {
            return Some(crate::cache::set_thumb_bytes_cache(image_cache_key, bytes));
        }

        if let Some(bytes) = generate_quicklook_thumbnail_bytes(path_obj, size_val) {
            return Some(crate::cache::set_thumb_bytes_cache(image_cache_key, bytes));
        }

        if !allow_icon_fallback {
            return None;
        }

        let (tx, rx) = std::sync::mpsc::channel();
        let path_clone = path.clone();

        let _ = app.run_on_main_thread(move || {
            use objc2_app_kit::NSWorkspace;
            use objc2_foundation::NSString;

            let result = unsafe {
                let workspace = NSWorkspace::sharedWorkspace();
                let path_ns = NSString::from_str(&path_clone);
                let icon = workspace.iconForFile(&path_ns);
                icon_utils::ns_image_to_png_bytes(&icon, size_val)
            };
            let _ = tx.send(result);
        });

        let result = rx.recv().unwrap_or(None)?;
        Some(crate::cache::set_thumb_bytes_cache(icon_cache_key, result))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        None
    }
}

/// 获取指定文件/文件夹的原生缩略图或图标 (Base64，保留兼容接口)
#[tauri::command]
pub async fn get_file_thumbnail(
    app: tauri::AppHandle,
    path: String,
    size: Option<f64>,
    allow_icon_fallback: Option<bool>,
    prefer_embedded: Option<bool>,
) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cached = get_file_thumbnail_bytes_blocking_generic(
            &app,
            path,
            size,
            allow_icon_fallback,
            prefer_embedded,
        )?;
        Some(base64::engine::general_purpose::STANDARD.encode(cached.bytes.as_slice()))
    })
    .await
    .ok()
    .flatten()
}

/// 获取 SF Symbol 图标 (Base64)
#[tauri::command]
#[allow(deprecated)]
pub async fn get_sf_symbol(app: tauri::AppHandle, name: String) -> Option<String> {
    let cache_key = format!("sfsymbol:{}", name);
    if let Some(cached) = crate::cache::get_icon_cache(&cache_key) {
        return Some(cached);
    }

    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        let name_clone = name.clone();

        let _ = app.run_on_main_thread(move || {
            use base64::{engine::general_purpose, Engine as _};
            use objc2::ClassType;
            use objc2_app_kit::{NSBitmapImageRep, NSCompositingOperation, NSImage, NSPNGFileType};
            use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};

            let result = unsafe {
                let name_ns = NSString::from_str(&name_clone);
                if let Some(base_image) =
                    NSImage::imageWithSystemSymbolName_accessibilityDescription(&name_ns, None)
                {
                    // Create a new target image of 128x128
                    let size = NSSize::new(128.0, 128.0);
                    let target_image = NSImage::initWithSize(NSImage::alloc(), size);

                    // Lock focus to draw into the target image
                    target_image.lockFocus();

                    // Draw the symbol filling the rect
                    base_image.drawInRect_fromRect_operation_fraction(
                        NSRect::new(NSPoint::new(0.0, 0.0), size),
                        NSRect::ZERO,
                        NSCompositingOperation::SourceOver,
                        1.0,
                    );

                    target_image.unlockFocus();

                    if let Some(tiff_data) = target_image.TIFFRepresentation() {
                        if let Some(bitmap_rep) = NSBitmapImageRep::imageRepWithData(&tiff_data) {
                            let props = NSDictionary::new();
                            bitmap_rep
                                .representationUsingType_properties(NSPNGFileType, &props)
                                .map(|png_data| general_purpose::STANDARD.encode(png_data.bytes()))
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                }
            };
            let _ = tx.send(result);
        });

        let result = rx.recv().unwrap_or(None);
        if let Some(ref base64) = result {
            crate::cache::set_icon_cache(cache_key, base64.clone());
        }
        result
    }
    #[cfg(not(target_os = "macos"))]
    None
}

/// 获取文件类型图标 (Base64)
#[tauri::command]
#[allow(deprecated)]
pub async fn get_file_type_icon(app: tauri::AppHandle, ext: String) -> Option<String> {
    // 先检查缓存
    let cache_key = format!("ext:{}", ext);
    if let Some(cached) = crate::cache::get_icon_cache(&cache_key) {
        return Some(cached);
    }

    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        let ext_clone = ext.clone();

        let _ = app.run_on_main_thread(move || {
            use objc2_app_kit::NSWorkspace;
            use objc2_foundation::NSString;

            let result = unsafe {
                let workspace = NSWorkspace::sharedWorkspace();
                let ext_ns = NSString::from_str(&ext_clone);
                let icon = workspace.iconForFileType(&ext_ns);
                icon_utils::ns_image_to_base64(&icon, 128.0)
            };
            let _ = tx.send(result);
        });

        let result = rx.recv().unwrap_or(None);

        // 存入缓存
        if let Some(ref base64) = result {
            crate::cache::set_icon_cache(cache_key, base64.clone());
        }

        result
    }

    #[cfg(not(target_os = "macos"))]
    None
}

/// 使用指定应用打开文件/文件夹
#[tauri::command]
pub fn open_with(path: String, app_path: String) -> Result<(), String> {
    // 验证 app_path 是有效的 .app 包路径
    let app = Path::new(&app_path);
    if !app.exists() || !app_path.ends_with(".app") {
        return Err(format!("Invalid application path: {}", app_path));
    }

    Command::new("/usr/bin/open")
        .args(["-a", &app_path, &path])
        .spawn()
        .map_err(|e| format!("Failed to open with app: {}", e))?;

    Ok(())
}

/// 使用系统 Quick Look 预览多个文件（macOS）
#[tauri::command]
pub fn open_native_quick_look(
    paths: Vec<String>,
    current_path: Option<String>,
    native_quick_look: tauri::State<'_, crate::NativeQuickLookState>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let ordered_paths = reorder_quick_look_paths(paths, current_path);
        if ordered_paths.is_empty() {
            return Err("No valid files available for Quick Look".to_string());
        }

        close_native_quick_look_process(&native_quick_look)?;

        let mut command = Command::new("/usr/bin/qlmanage");
        command.arg("-p");
        command.args(&ordered_paths);
        command.stdout(Stdio::null());
        command.stderr(Stdio::null());

        let child = command
            .spawn()
            .map_err(|e| format!("Failed to open native Quick Look: {}", e))?;

        let mut child_guard = native_quick_look
            .lock()
            .map_err(|_| "Failed to store native Quick Look process".to_string())?;
        *child_guard = Some(child);
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = paths;
        let _ = current_path;
        let _ = native_quick_look;
        Err("Native Quick Look is only supported on macOS".to_string())
    }
}

/// 关闭由应用启动的系统 Quick Look 预览（macOS）
#[tauri::command]
pub fn close_native_quick_look(
    native_quick_look: tauri::State<'_, crate::NativeQuickLookState>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        close_native_quick_look_process(&native_quick_look)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = native_quick_look;
        Err("Native Quick Look is only supported on macOS".to_string())
    }
}

/// 使用指定终端打开目录
#[tauri::command]
pub fn open_in_terminal_with(path: String, terminal_bundle_id: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // 验证 terminal_bundle_id 是否在已知终端列表中
        if !TERMINAL_BUNDLE_IDS.contains(&terminal_bundle_id.as_str()) {
            return Err(format!(
                "Unknown terminal bundle ID: {}",
                terminal_bundle_id
            ));
        }

        // 检查是否是需要特殊处理的终端
        if let Some(config) = SPECIAL_TERMINALS
            .iter()
            .find(|c| c.bundle_id == terminal_bundle_id)
        {
            let mut cmd = Command::new(config.executable);
            cmd.args(config.args);
            cmd.arg(&path);
            cmd.spawn().map_err(|e| e.to_string())?;
        } else {
            // 其他所有遵循 macOS 规范的终端使用 open -b
            Command::new("/usr/bin/open")
                .args(["-b", &terminal_bundle_id, &path])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }

    #[cfg(not(target_os = "macos"))]
    return Err("Not supported on this platform".to_string());

    Ok(())
}
