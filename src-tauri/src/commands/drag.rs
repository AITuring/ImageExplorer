use base64::Engine;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Window};

const MAX_DRAG_PATHS: usize = 200;
const MAX_DRAG_ICON_BASE64_BYTES: usize = 8 * 1024 * 1024;
const FALLBACK_DRAG_ICON: &[u8] = include_bytes!("../../icons/128x128.png");
const NATIVE_FILE_DRAG_STARTED_EVENT: &str = "native-file-drag-started";
const NATIVE_FILE_DRAG_ENDED_EVENT: &str = "native-file-drag-ended";
const ACTIVE_DRAG_MAX_LIFETIME: Duration = Duration::from_secs(60);
const ACTIVE_DRAG_POST_DROP_GRACE: Duration = Duration::from_secs(2);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFileDragStarted {
    session_id: String,
    paths: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFileDragEnded {
    session_id: String,
    result: &'static str,
}

#[derive(Clone)]
struct ActiveNativeDragState {
    session_id: String,
    paths: Vec<String>,
    started_at: Instant,
    ended_at: Option<Instant>,
}

fn active_native_drag() -> &'static Mutex<Option<ActiveNativeDragState>> {
    static STATE: OnceLock<Mutex<Option<ActiveNativeDragState>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

fn set_active_native_drag(session_id: String, paths: Vec<String>) {
    if let Ok(mut guard) = active_native_drag().lock() {
        *guard = Some(ActiveNativeDragState {
            session_id,
            paths,
            started_at: Instant::now(),
            ended_at: None,
        });
    }
}

fn mark_active_native_drag_ended(session_id: &str) {
    if let Ok(mut guard) = active_native_drag().lock() {
        if let Some(state) = guard.as_mut() {
            if state.session_id == session_id {
                state.ended_at = Some(Instant::now());
            }
        }
    }
}

fn clear_active_native_drag(session_id: &str) {
    if let Ok(mut guard) = active_native_drag().lock() {
        if guard
            .as_ref()
            .is_some_and(|state| state.session_id == session_id)
        {
            *guard = None;
        }
    }
}

fn take_recent_active_native_drag_paths() -> Option<Vec<String>> {
    let mut guard = active_native_drag().lock().ok()?;
    let state = guard.as_ref()?;
    let expired = state.started_at.elapsed() > ACTIVE_DRAG_MAX_LIFETIME
        || state
            .ended_at
            .is_some_and(|ended| ended.elapsed() > ACTIVE_DRAG_POST_DROP_GRACE);
    if expired {
        *guard = None;
        return None;
    }
    Some(state.paths.clone())
}

#[cfg(target_os = "macos")]
fn read_macos_drag_pasteboard_paths() -> Vec<String> {
    use std::ffi::{c_char, CStr};

    extern "C" {
        fn imageexplorer_drag_pasteboard_paths_json() -> *mut c_char;
        fn imageexplorer_free_thumbnail(buffer: *mut u8);
    }

    let ptr = unsafe { imageexplorer_drag_pasteboard_paths_json() };
    if ptr.is_null() {
        return Vec::new();
    }
    let json_text = unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .into_owned();
    unsafe { imageexplorer_free_thumbnail(ptr.cast::<u8>()) };

    let parsed: Vec<String> = serde_json::from_str(&json_text).unwrap_or_default();
    let mut out = Vec::with_capacity(parsed.len());
    for candidate in parsed {
        let path = PathBuf::from(&candidate);
        if path.is_absolute() && path.exists() && !out.contains(&candidate) {
            out.push(candidate);
        }
    }
    out
}

#[cfg(not(target_os = "macos"))]
fn read_macos_drag_pasteboard_paths() -> Vec<String> {
    Vec::new()
}

/// Resolve native OS file paths for an active or just-completed drop.
/// Handles both cross-window ImageExplorer drags and external drags from Finder.
#[tauri::command]
pub fn get_native_drag_file_paths() -> Vec<String> {
    if let Some(paths) = take_recent_active_native_drag_paths() {
        let valid: Vec<String> = paths
            .into_iter()
            .filter(|path| PathBuf::from(path).exists())
            .collect();
        if !valid.is_empty() {
            return valid;
        }
    }

    read_macos_drag_pasteboard_paths()
}

fn validated_drag_paths(paths: Vec<String>) -> Result<Vec<PathBuf>, String> {
    if paths.is_empty() {
        return Err("No files were provided for dragging".to_string());
    }
    if paths.len() > MAX_DRAG_PATHS {
        return Err(format!(
            "Too many drag items: {} (maximum {})",
            paths.len(),
            MAX_DRAG_PATHS
        ));
    }

    let mut validated = Vec::with_capacity(paths.len());
    for path in paths {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err(format!("Drag path must be absolute: {}", path.display()));
        }
        if !path.exists() {
            return Err(format!("Drag path does not exist: {}", path.display()));
        }
        if !validated.contains(&path) {
            validated.push(path);
        }
    }

    Ok(validated)
}

fn decode_drag_icon(icon: Option<String>) -> Result<Vec<u8>, String> {
    let Some(icon) = icon else {
        return Ok(FALLBACK_DRAG_ICON.to_vec());
    };
    let Some(encoded) = icon.strip_prefix("data:image/png;base64,") else {
        return Ok(FALLBACK_DRAG_ICON.to_vec());
    };
    if encoded.len() > MAX_DRAG_ICON_BASE64_BYTES {
        return Err("Drag icon is too large".to_string());
    }

    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|error| format!("Invalid drag icon: {error}"))
}

/// Start an operating-system file drag so external desktop apps receive real
/// file URLs instead of WebKit's private representation of a DOM element.
#[tauri::command]
pub fn start_native_file_drag(
    app: AppHandle,
    window: Window,
    paths: Vec<String>,
    icon: Option<String>,
    session_id: String,
) -> Result<(), String> {
    if session_id.is_empty() || session_id.len() > 128 {
        return Err("Invalid native drag session id".to_string());
    }

    let paths = validated_drag_paths(paths)?;
    let normalized_strings: Vec<String> = paths
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    let icon = decode_drag_icon(icon)?;
    let item = drag::DragItem::Files(paths);
    let image = drag::Image::Raw(icon);
    let options = drag::Options {
        mode: drag::DragMode::CopyOrMove,
        ..Default::default()
    };

    // Share the active drag session across every ImageExplorer window so split-screen
    // drops from Window A -> Window B resolve instantaneously with full source paths.
    set_active_native_drag(session_id.clone(), normalized_strings.clone());
    let _ = app.emit(
        NATIVE_FILE_DRAG_STARTED_EVENT,
        NativeFileDragStarted {
            session_id: session_id.clone(),
            paths: normalized_strings,
        },
    );

    let end_session_id = session_id.clone();
    let on_drag_end = move |result: drag::DragResult, _cursor_position| {
        mark_active_native_drag_ended(&end_session_id);
        let result = match result {
            drag::DragResult::Dropped => "dropped",
            drag::DragResult::Cancel => "cancelled",
        };
        let _ = app.emit(
            NATIVE_FILE_DRAG_ENDED_EVENT,
            NativeFileDragEnded {
                session_id: end_session_id.clone(),
                result,
            },
        );
    };

    // Keep this command synchronous: WebKit starts its own DOM drag as soon as
    // the dragstart handler returns. Starting the native session inline lets it
    // take ownership of the still-active mouse gesture first.
    #[cfg(target_os = "linux")]
    let result = {
        let gtk_window = window.gtk_window().map_err(|error| error.to_string())?;
        drag::start_drag(&gtk_window, item, image, on_drag_end, options)
    };

    #[cfg(not(target_os = "linux"))]
    let result = drag::start_drag(&window, item, image, on_drag_end, options);

    if let Err(error) = result {
        clear_active_native_drag(&session_id);
        return Err(error.to_string());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_drag_payload() {
        assert!(validated_drag_paths(Vec::new()).is_err());
    }

    #[test]
    fn rejects_relative_drag_path() {
        assert!(validated_drag_paths(vec!["relative/image.jpg".to_string()]).is_err());
    }

    #[test]
    fn invalid_preview_does_not_replace_the_safe_fallback_icon() {
        assert_eq!(
            decode_drag_icon(Some("asset://thumbnail".to_string())).unwrap(),
            FALLBACK_DRAG_ICON
        );
    }
}
