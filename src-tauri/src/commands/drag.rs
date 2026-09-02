use base64::Engine;
use std::path::PathBuf;
use tauri::Window;

const MAX_DRAG_PATHS: usize = 200;
const MAX_DRAG_ICON_BASE64_BYTES: usize = 8 * 1024 * 1024;
const FALLBACK_DRAG_ICON: &[u8] = include_bytes!("../../icons/128x128.png");

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
    window: Window,
    paths: Vec<String>,
    icon: Option<String>,
) -> Result<(), String> {
    let paths = validated_drag_paths(paths)?;
    let icon = decode_drag_icon(icon)?;
    let item = drag::DragItem::Files(paths);
    let image = drag::Image::Raw(icon);
    let options = drag::Options {
        mode: drag::DragMode::Copy,
        ..Default::default()
    };

    // Keep this command synchronous: WebKit starts its own DOM drag as soon as
    // the dragstart handler returns. Starting the native session inline lets it
    // take ownership of the still-active mouse gesture first.
    #[cfg(target_os = "linux")]
    let result = {
        let gtk_window = window.gtk_window().map_err(|error| error.to_string())?;
        drag::start_drag(
            &gtk_window,
            item,
            image,
            |_result, _cursor_position| {},
            options,
        )
    };

    #[cfg(not(target_os = "linux"))]
    let result = drag::start_drag(
        &window,
        item,
        image,
        |_result, _cursor_position| {},
        options,
    );

    result.map_err(|error| error.to_string())
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
