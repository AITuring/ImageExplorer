use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

pub struct WatcherState {
    /// 多路径监听：key 为目录路径，value 为 watcher 实例
    watchers: HashMap<String, WatchEntry>,
}

struct WatchEntry {
    _watcher: RecommendedWatcher,
    references: usize,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            watchers: HashMap::new(),
        }
    }
}

impl Default for WatcherState {
    fn default() -> Self {
        Self::new()
    }
}

/// 监听指定目录（支持多路径同时监听）
#[tauri::command]
pub fn watch_directory(
    app: AppHandle,
    state: tauri::State<'_, Mutex<WatcherState>>,
    path: String,
) -> Result<(), String> {
    let path_buf = PathBuf::from(&path);

    if !path_buf.exists() || !path_buf.is_dir() {
        return Err("Path does not exist or is not a directory".to_string());
    }

    let mut watcher_state = state.lock().map_err(|e| e.to_string())?;

    // 如果已经在监听该目录，跳过
    if let Some(entry) = watcher_state.watchers.get_mut(&path) {
        entry.references = entry.references.saturating_add(1);
        return Ok(());
    }

    // 创建新的监听器
    let (tx, rx) = std::sync::mpsc::channel::<Result<Event, notify::Error>>();

    let mut watcher = RecommendedWatcher::new(
        move |res| {
            let _ = tx.send(res);
        },
        Config::default(),
    )
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&path_buf, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    watcher_state.watchers.insert(
        path.clone(),
        WatchEntry {
            _watcher: watcher,
            references: 1,
        },
    );

    // 在后台线程处理事件
    let app_handle = app.clone();
    let watched_path = path.clone();
    std::thread::spawn(move || {
        for res in rx {
            match res {
                Ok(_event) => {
                    let _ = app_handle.emit("dir-change", &watched_path);
                }
                Err(e) => {
                    eprintln!("Watch error: {:?}", e);
                }
            }
        }
    });

    Ok(())
}

/// 停止监听指定目录
#[tauri::command]
pub fn unwatch_directory(
    state: tauri::State<'_, Mutex<WatcherState>>,
    path: String,
) -> Result<(), String> {
    let mut watcher_state = state.lock().map_err(|e| e.to_string())?;
    if let Some(entry) = watcher_state.watchers.get_mut(&path) {
        entry.references = entry.references.saturating_sub(1);
        if entry.references == 0 {
            watcher_state.watchers.remove(&path);
        }
    }
    Ok(())
}

/// 停止所有监听（向后兼容）
#[tauri::command]
pub fn stop_watching(state: tauri::State<'_, Mutex<WatcherState>>) -> Result<(), String> {
    let mut watcher_state = state.lock().map_err(|e| e.to_string())?;
    watcher_state.watchers.clear();
    Ok(())
}
