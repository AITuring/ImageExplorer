use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct TrashEntry {
    pub id: String,
    pub name: String,
    pub original_path: Option<String>,
    pub size: Option<u64>,
    pub deleted_at: Option<i64>,
    pub can_restore: bool,
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
                id: original_path.clone(),
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
fn run_osascript(script: &str) -> Result<String, String> {
    let output = std::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(target_os = "macos")]
fn escape_applescript(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn list_entries() -> Result<Vec<TrashEntry>, String> {
    let script = r#"
tell application "Finder"
  set output to {}
  repeat with trashItem in every item of trash
    try
      set itemName to name of trashItem
      set originalPath to POSIX path of (original item of trashItem as alias)
      set end of output to itemName & tab & originalPath
    on error
      set end of output to (name of trashItem) & tab
    end try
  end repeat
  set AppleScript's text item delimiters to linefeed
  return output as text
end tell
"#;
    let output = run_osascript(script)?;
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let trash_dir = home.join(".Trash");
    let mut entries = Vec::new();
    for line in output.lines().filter(|line| !line.is_empty()) {
        let (name, original) = line.split_once('\t').unwrap_or((line, ""));
        let path = trash_dir.join(name);
        let size = std::fs::metadata(&path).ok().map(|metadata| metadata.len());
        entries.push(TrashEntry {
            id: format!("{}|{}", name, original),
            name: name.to_string(),
            original_path: (!original.is_empty()).then(|| original.to_string()),
            size,
            deleted_at: None,
            can_restore: !original.is_empty(),
        });
    }
    Ok(entries)
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
        .find(|item| item.original_path().to_string_lossy() == entry_id)
        .ok_or_else(|| "Trash item not found".to_string())?;
    trash::os_limited::restore_all([item]).map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn restore_trash_entry(entry_id: String) -> Result<(), String> {
    let (name, original_path) = entry_id
        .split_once('|')
        .ok_or_else(|| "Invalid Trash item".to_string())?;
    let original_path = Path::new(original_path);
    let parent = original_path
        .parent()
        .ok_or_else(|| "Invalid original path".to_string())?;
    let script = format!(
        "tell application \"Finder\" to move (first item of trash whose name is \"{}\") to POSIX file \"{}\"",
        escape_applescript(name),
        escape_applescript(&parent.to_string_lossy())
    );
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
