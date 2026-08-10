use serde::{Deserialize, Serialize};
use std::path::{Component, Path};

#[derive(Debug, Clone, Serialize)]
pub struct TrashEntry {
    pub id: String,
    pub name: String,
    pub original_path: Option<String>,
    pub size: Option<u64>,
    pub deleted_at: Option<i64>,
    pub can_restore: bool,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct MacTrashEntryId {
    trash_path: String,
    original_path: String,
}

#[cfg(target_os = "macos")]
const TRASH_FIELD_SEPARATOR: char = '\u{001f}';
#[cfg(target_os = "macos")]
const TRASH_RECORD_SEPARATOR: char = '\u{001e}';

#[cfg(all(unix, not(target_os = "macos")))]
fn encode_platform_trash_id(value: &std::ffi::OsStr) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use std::os::unix::ffi::OsStrExt;
    format!("unix:{}", URL_SAFE_NO_PAD.encode(value.as_bytes()))
}

#[cfg(windows)]
fn encode_platform_trash_id(value: &std::ffi::OsStr) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    use std::os::windows::ffi::OsStrExt;
    let bytes = value
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    format!("windows:{}", URL_SAFE_NO_PAD.encode(bytes))
}

#[cfg(not(any(unix, windows)))]
fn encode_platform_trash_id(value: &std::ffi::OsStr) -> String {
    value.to_string_lossy().to_string()
}

#[cfg(not(target_os = "macos"))]
fn list_entries() -> Result<Vec<TrashEntry>, String> {
    let items = trash::os_limited::list().map_err(|error| error.to_string())?;
    Ok(items
        .into_iter()
        .map(|item| {
            let size = trash::os_limited::metadata(&item)
                .ok()
                .and_then(|metadata| metadata.size.size());
            let original_path = item.original_path().to_string_lossy().to_string();
            TrashEntry {
                // The crate's platform identifier distinguishes twins that
                // shared the same original path at different deletion times.
                id: encode_platform_trash_id(&item.id),
                name: item.name.to_string_lossy().to_string(),
                original_path: Some(original_path),
                size,
                deleted_at: Some(item.time_deleted),
                can_restore: true,
            }
        })
        .collect())
}

#[cfg(target_os = "macos")]
fn run_osascript_raw(script: &str) -> Result<String, String> {
    let output = std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(target_os = "macos")]
fn run_osascript(script: &str) -> Result<String, String> {
    run_osascript_raw(script).map(|output| output.trim().to_string())
}

#[cfg(target_os = "macos")]
fn escape_applescript(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn encode_macos_entry_id(trash_path: &str, original_path: &str) -> Result<String, String> {
    serde_json::to_string(&MacTrashEntryId {
        trash_path: trash_path.to_string(),
        original_path: original_path.to_string(),
    })
    .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn decode_macos_entry_id(entry_id: &str) -> Result<MacTrashEntryId, String> {
    serde_json::from_str(entry_id).map_err(|_| "Invalid Trash item identifier".to_string())
}

#[cfg(target_os = "macos")]
fn parse_macos_trash_output(output: &str) -> Result<Vec<TrashEntry>, String> {
    output
        .trim_end_matches(['\r', '\n'])
        .split(TRASH_RECORD_SEPARATOR)
        .filter(|record| !record.is_empty())
        .map(|record| {
            let mut fields = record.splitn(3, TRASH_FIELD_SEPARATOR);
            let trash_path = fields
                .next()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "Trash item path is missing".to_string())?;
            let name = fields
                .next()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "Trash item name is missing".to_string())?;
            let original_path = fields.next().unwrap_or_default();
            let size = std::fs::symlink_metadata(trash_path)
                .ok()
                .map(|metadata| metadata.len());
            Ok(TrashEntry {
                id: encode_macos_entry_id(trash_path, original_path)?,
                name: name.to_string(),
                original_path: (!original_path.is_empty()).then(|| original_path.to_string()),
                size,
                deleted_at: None,
                can_restore: !original_path.is_empty(),
            })
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn validate_macos_trash_path(path: &Path) -> Result<(), String> {
    let contains_relative_component = path
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir));
    let in_home_trash = dirs::home_dir()
        .map(|home| path.starts_with(home.join(".Trash")))
        .unwrap_or(false);
    let components = path.components().collect::<Vec<_>>();
    let in_external_trash = components.len() >= 6
        && matches!(components[0], Component::RootDir)
        && components[1].as_os_str() == "Volumes"
        && components[3].as_os_str() == ".Trashes";
    if !path.is_absolute() || contains_relative_component || (!in_home_trash && !in_external_trash)
    {
        return Err("Trash item path is outside a macOS Trash directory".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn build_macos_restore_script(entry: &MacTrashEntryId) -> Result<String, String> {
    let trash_path = Path::new(&entry.trash_path);
    let original_path = Path::new(&entry.original_path);
    validate_macos_trash_path(trash_path)?;
    if !original_path.is_absolute()
        || original_path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err("Invalid original path".to_string());
    }
    let parent = original_path
        .parent()
        .ok_or_else(|| "Invalid original path".to_string())?;
    let original_name = original_path
        .file_name()
        .ok_or_else(|| "Invalid original file name".to_string())?;
    Ok(format!(
        r#"tell application "Finder"
  set exactTrashItem to POSIX file "{}" as alias
  set restoredItem to move exactTrashItem to (POSIX file "{}") without replacing
  set name of restoredItem to "{}"
end tell"#,
        escape_applescript(&entry.trash_path),
        escape_applescript(&parent.to_string_lossy()),
        escape_applescript(&original_name.to_string_lossy())
    ))
}

#[cfg(target_os = "macos")]
fn list_entries() -> Result<Vec<TrashEntry>, String> {
    let script = r#"
tell application "Finder"
  set fieldSeparator to ASCII character 31
  set recordSeparator to ASCII character 30
  set output to {}
  repeat with trashItem in every item of trash
    set trashedPath to POSIX path of (trashItem as alias)
    set itemName to name of trashItem
    try
      set originalPath to POSIX path of (original item of trashItem as alias)
    on error
      set originalPath to ""
    end try
    set end of output to trashedPath & fieldSeparator & itemName & fieldSeparator & originalPath
  end repeat
  set AppleScript's text item delimiters to recordSeparator
  return output as text
end tell
"#;
    parse_macos_trash_output(&run_osascript_raw(script)?)
}

#[tauri::command]
pub fn list_trash() -> Result<Vec<TrashEntry>, String> {
    list_entries()
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn restore_trash_entry(entry_id: String) -> Result<(), String> {
    let items = trash::os_limited::list().map_err(|error| error.to_string())?;
    let item = items
        .into_iter()
        .find(|item| encode_platform_trash_id(&item.id) == entry_id)
        .ok_or_else(|| "Trash item not found".to_string())?;
    trash::os_limited::restore_all([item]).map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn restore_trash_entry(entry_id: String) -> Result<(), String> {
    let entry = decode_macos_entry_id(&entry_id)?;
    if !list_entries()?
        .iter()
        .any(|candidate| candidate.id == entry_id)
    {
        return Err("Trash item no longer exists".to_string());
    }
    let trash_path = Path::new(&entry.trash_path);
    if std::fs::symlink_metadata(trash_path).is_err() {
        return Err("Trash item no longer exists".to_string());
    }
    if std::fs::symlink_metadata(&entry.original_path).is_ok() {
        return Err("An item already exists at the original location".to_string());
    }
    let script = build_macos_restore_script(&entry)?;
    run_osascript(&script).map(|_| ())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn empty_trash() -> Result<(), String> {
    let items = trash::os_limited::list().map_err(|error| error.to_string())?;
    trash::os_limited::purge_all(items).map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn empty_trash() -> Result<(), String> {
    run_osascript("tell application \"Finder\" to empty trash").map(|_| ())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{
        build_macos_restore_script, decode_macos_entry_id, parse_macos_trash_output,
        validate_macos_trash_path, MacTrashEntryId, TRASH_FIELD_SEPARATOR, TRASH_RECORD_SEPARATOR,
    };
    use std::path::Path;

    #[test]
    fn same_name_trash_items_keep_distinct_physical_identifiers() {
        let output = format!(
            "/Volumes/CameraA/.Trashes/501/photo.raw{field}photo.raw{field}/Users/test/A/photo.raw{record}/Volumes/CameraB/.Trashes/501/photo.raw{field}photo.raw{field}/Users/test/B/photo.raw",
            field = TRASH_FIELD_SEPARATOR,
            record = TRASH_RECORD_SEPARATOR,
        );

        let entries = parse_macos_trash_output(&output).expect("parse Trash output");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, entries[1].name);
        assert_ne!(entries[0].id, entries[1].id);
        assert_eq!(
            decode_macos_entry_id(&entries[0].id)
                .expect("decode first id")
                .trash_path,
            "/Volumes/CameraA/.Trashes/501/photo.raw"
        );
        assert_eq!(
            decode_macos_entry_id(&entries[1].id)
                .expect("decode second id")
                .trash_path,
            "/Volumes/CameraB/.Trashes/501/photo.raw"
        );
    }

    #[test]
    fn restore_script_selects_the_exact_trashed_path_instead_of_a_name() {
        let entry = MacTrashEntryId {
            trash_path: "/Volumes/CameraA/.Trashes/501/photo.raw".to_string(),
            original_path: "/Users/test/Pictures/photo.raw".to_string(),
        };

        let script = build_macos_restore_script(&entry).expect("build restore script");
        assert!(script.contains("/Volumes/CameraA/.Trashes/501/photo.raw"));
        assert!(script.contains("/Users/test/Pictures"));
        assert!(script.contains("set restoredItem to move exactTrashItem"));
        assert!(script.contains("without replacing"));
        assert!(script.contains("set name of restoredItem to \"photo.raw\""));
        assert!(!script.contains("item 1 of restoredItems"));
        assert!(!script.contains("first item of trash whose name"));
    }

    #[test]
    fn restore_identifier_rejects_non_trash_paths() {
        assert!(validate_macos_trash_path(Path::new("/Users/test/Documents/photo.raw")).is_err());
        assert!(
            validate_macos_trash_path(Path::new("/Volumes/CameraA/.Trashes/501/photo.raw")).is_ok()
        );
    }
}
