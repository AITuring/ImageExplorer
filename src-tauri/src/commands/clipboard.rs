use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileClipboardContents {
    paths: Vec<String>,
    cut: bool,
    change_count: i64,
}

#[cfg(target_os = "macos")]
const CUT_PASTEBOARD_TYPE: &str = "app.imageexplorer.cut-files";

#[cfg(target_os = "macos")]
fn valid_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    use std::path::Path;

    if paths.is_empty() || paths.len() > 2000 {
        return Err("The file clipboard requires 1 to 2000 paths".to_string());
    }
    let mut unique = Vec::with_capacity(paths.len());
    for path in paths {
        if !Path::new(&path).is_absolute() {
            return Err(format!("Clipboard path is not absolute: {path}"));
        }
        std::fs::symlink_metadata(&path)
            .map_err(|error| format!("Clipboard source is unavailable: {path}: {error}"))?;
        if !unique.contains(&path) {
            unique.push(path);
        }
    }
    Ok(unique)
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn write_file_clipboard(
    paths: Vec<String>,
    cut: bool,
) -> Result<FileClipboardContents, String> {
    let pasteboard = unsafe { objc2_app_kit::NSPasteboard::generalPasteboard() };
    write_to_pasteboard(&pasteboard, paths, cut)
}

#[cfg(target_os = "macos")]
fn write_to_pasteboard(
    pasteboard: &objc2_app_kit::NSPasteboard,
    paths: Vec<String>,
    cut: bool,
) -> Result<FileClipboardContents, String> {
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboardItem, NSPasteboardTypeFileURL, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};

    let paths = valid_paths(paths)?;
    let cut_type = NSString::from_str(CUT_PASTEBOARD_TYPE);
    let mut items = Vec::with_capacity(paths.len());
    for (index, path) in paths.iter().enumerate() {
        let url = unsafe { NSURL::fileURLWithPath(&NSString::from_str(path)) };
        let url_string = unsafe { url.absoluteString() }
            .ok_or_else(|| format!("Cannot encode file URL: {path}"))?;
        let item = unsafe { NSPasteboardItem::new() };
        if !unsafe { item.setString_forType(&url_string, NSPasteboardTypeFileURL) } {
            return Err(format!("Cannot place file URL on clipboard: {path}"));
        }
        if cut && index == 0 {
            unsafe { item.setString_forType(&NSString::from_str("1"), &cut_type) };
        }
        items.push(ProtocolObject::<dyn NSPasteboardWriting>::from_retained(
            item,
        ));
    }

    unsafe { pasteboard.clearContents() };
    if !unsafe { pasteboard.writeObjects(&NSArray::from_vec(items)) } {
        return Err("macOS rejected the file clipboard contents".to_string());
    }
    Ok(FileClipboardContents {
        paths,
        cut,
        change_count: unsafe { pasteboard.changeCount() } as i64,
    })
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn read_file_clipboard() -> Result<FileClipboardContents, String> {
    let pasteboard = unsafe { objc2_app_kit::NSPasteboard::generalPasteboard() };
    read_from_pasteboard(&pasteboard)
}

#[cfg(target_os = "macos")]
fn read_from_pasteboard(
    pasteboard: &objc2_app_kit::NSPasteboard,
) -> Result<FileClipboardContents, String> {
    use objc2_app_kit::NSPasteboardTypeFileURL;
    use objc2_foundation::{NSString, NSURL};

    let change_count = unsafe { pasteboard.changeCount() } as i64;
    let cut_type = NSString::from_str(CUT_PASTEBOARD_TYPE);
    let mut paths = Vec::new();
    let mut cut = false;
    if let Some(items) = unsafe { pasteboard.pasteboardItems() } {
        for index in 0..items.count() {
            let item = unsafe { items.objectAtIndex(index) };
            if index == 0 {
                cut = unsafe { item.stringForType(&cut_type) }.is_some();
            }
            let Some(raw_url) = (unsafe { item.stringForType(NSPasteboardTypeFileURL) }) else {
                continue;
            };
            let Some(url) = (unsafe { NSURL::URLWithString(&raw_url) }) else {
                continue;
            };
            if !unsafe { url.isFileURL() } {
                continue;
            }
            if let Some(path) = unsafe { url.path() } {
                let path = path.to_string();
                if !paths.contains(&path) {
                    paths.push(path);
                }
            }
        }
    }
    if unsafe { pasteboard.changeCount() } as i64 != change_count {
        return Err("The file clipboard changed while it was being read".to_string());
    }
    Ok(FileClipboardContents {
        cut: cut && !paths.is_empty(),
        paths,
        change_count,
    })
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn consume_cut_file_clipboard(expected_change_count: i64) -> Result<bool, String> {
    use objc2_app_kit::NSPasteboard;

    let pasteboard = unsafe { NSPasteboard::generalPasteboard() };
    if unsafe { pasteboard.changeCount() } as i64 != expected_change_count {
        return Ok(false);
    }
    let contents = read_from_pasteboard(&pasteboard)?;
    if !contents.cut || contents.change_count != expected_change_count {
        return Ok(false);
    }
    unsafe { pasteboard.clearContents() };
    Ok(true)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn write_file_clipboard(
    _paths: Vec<String>,
    _cut: bool,
) -> Result<FileClipboardContents, String> {
    Err("Native file clipboard is available only on macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn read_file_clipboard() -> Result<FileClipboardContents, String> {
    Err("Native file clipboard is available only on macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn consume_cut_file_clipboard(_expected_change_count: i64) -> Result<bool, String> {
    Ok(false)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use objc2_app_kit::NSPasteboard;

    #[test]
    #[ignore = "requires an AppKit application session with pasteboard access"]
    fn file_urls_and_cut_marker_round_trip_without_touching_general_clipboard() {
        let root =
            std::env::temp_dir().join(format!("imageexplorer-clipboard-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("create test directory");
        let first = root.join("first image.raw");
        let second = root.join("第二张.jpg");
        std::fs::write(&first, b"first").expect("write first file");
        std::fs::write(&second, b"second").expect("write second file");
        let paths = vec![
            first.to_string_lossy().to_string(),
            second.to_string_lossy().to_string(),
        ];

        let pasteboard = unsafe { NSPasteboard::pasteboardWithUniqueName() };
        let written =
            write_to_pasteboard(&pasteboard, paths.clone(), true).expect("write cut files");
        let read = read_from_pasteboard(&pasteboard).expect("read cut files");
        assert_eq!(read.paths, paths);
        assert!(read.cut);
        assert_eq!(read.change_count, written.change_count);

        write_to_pasteboard(&pasteboard, paths.clone(), false).expect("write copied files");
        let read = read_from_pasteboard(&pasteboard).expect("read copied files");
        assert_eq!(read.paths, paths);
        assert!(!read.cut);
        std::fs::remove_dir_all(root).expect("remove test files");
    }
}
