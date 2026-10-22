use ignore::WalkBuilder;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex, RwLock};
use std::thread;
use std::time::SystemTime;
use tauri::Emitter;

#[derive(Debug, Clone, Serialize)]
pub struct IndexedFile {
    pub name: String,
    pub name_lower: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<u64>,
    pub extension: Option<String>,
    pub is_hidden: bool,
}

pub type FileIndexData = (HashMap<String, IndexedFile>, Vec<(String, String)>);

pub struct FileIndex {
    // ... (existing fields)
    files: HashMap<String, IndexedFile>,
    /// 用于快速搜索的名称列表 (小写名称, 路径)
    name_index: Vec<(String, String)>,
    /// 是否正在构建
    pub is_building: bool,
    /// 索引的文件数量
    pub file_count: usize,
}

impl FileIndex {
    pub fn new() -> Self {
        Self {
            files: HashMap::new(),
            name_index: Vec::new(),
            is_building: false,
            file_count: 0,
        }
    }

    /// 扫描文件系统并返回索引数据（不占用锁）
    pub fn scan(root: &str, app: Option<&tauri::AppHandle>) -> Result<FileIndexData, String> {
        let mut files = HashMap::new();
        let mut name_index = Vec::new();

        // 动态计算线程数：使用核心数的一半
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            / 2;
        let threads = std::cmp::max(1, threads);

        let walker = WalkBuilder::new(root)
            .hidden(false)
            .git_ignore(false)
            .git_global(false)
            .git_exclude(false)
            .threads(threads)
            // 排除一些明显不需要索引的大目录
            .filter_entry(|entry| {
                let path = entry.path();
                let path_str = path.to_string_lossy();

                if path_str.contains("/Library/Caches/")
                    || path_str.contains("/Library/Logs/")
                    || path_str.contains("/.Trash/")
                    || path_str.contains("/node_modules/")
                    || path_str.contains("/.git/")
                    || path_str.contains("/.cargo/")
                    || path_str.contains("/.npm/")
                    || path_str.contains("/.pnpm-store/")
                    || path_str.contains("/target/debug/")
                    || path_str.contains("/target/release/")
                {
                    return false;
                }
                true
            })
            .build();

        let mut count = 0;
        let mut last_emit = std::time::Instant::now();

        for entry in walker {
            let entry =
                entry.map_err(|error| format!("failed to walk index root {root}: {error}"))?;
            let path = entry.path();
            let path_str = path.to_string_lossy().to_string();

            if path_str == root {
                continue;
            }

            if let Some(file_name) = path.file_name() {
                let name = file_name.to_string_lossy().to_string();
                let name_lower = name.to_lowercase();

                let metadata = entry
                    .metadata()
                    .map_err(|error| format!("failed to read metadata for {path_str}: {error}"))?;
                let size = metadata.len();
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs());

                let extension = path.extension().map(|e| e.to_string_lossy().to_string());

                let file = IndexedFile {
                    name: name.clone(),
                    name_lower: name_lower.clone(),
                    path: path_str.clone(),
                    is_dir: path.is_dir(),
                    size,
                    modified,
                    extension,
                    is_hidden: name.starts_with('.'),
                };

                name_index.push((name_lower, path_str.clone()));
                files.insert(path_str, file);

                count += 1;

                if count % 1000 == 0 || last_emit.elapsed().as_secs() >= 1 {
                    if let Some(app_handle) = app {
                        let _ = app_handle.emit("index-progress", count);
                    }
                    last_emit = std::time::Instant::now();

                    // 短暂休眠让步，避免 CPU 100% 导致 UI 卡顿
                    if count % 2000 == 0 {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                }
            }
        }

        Ok((files, name_index))
    }

    /// 更新索引数据
    pub fn update_data(
        &mut self,
        files: HashMap<String, IndexedFile>,
        name_index: Vec<(String, String)>,
    ) {
        self.files = files;
        self.name_index = name_index;
        self.file_count = self.files.len();
        self.is_building = false;
    }

    // ... (keep search and filter_by_extensions)
    /// 搜索索引
    pub fn search(&self, query: &str, limit: usize) -> Vec<IndexedFile> {
        use rayon::prelude::*;

        if query.is_empty() {
            return vec![];
        }

        let query_lower = query.to_lowercase();

        // 并行搜索，大幅提升百万级文件下的性能
        self.name_index
            .par_iter()
            .filter(|(name_lower, _)| name_lower.contains(&query_lower))
            .map(|(_, path)| path)
            .filter_map(|path| self.files.get(path).cloned())
            .take_any(limit)
            .collect()
    }

    /// 按扩展名过滤
    pub fn filter_by_extensions(&self, extensions: &[String], limit: usize) -> Vec<IndexedFile> {
        use rayon::prelude::*;

        if extensions.is_empty() {
            return vec![];
        }

        // 使用并行迭代器加速过滤
        self.files
            .par_iter()
            .map(|(_, file)| file)
            .filter(|file| !file.is_dir) // 只看文件
            .filter(|file| {
                if let Some(ext) = &file.extension {
                    let ext_lower = ext.to_lowercase();
                    extensions.contains(&ext_lower)
                } else {
                    false
                }
            })
            .take_any(limit)
            .cloned()
            .collect()
    }

    /// 添加文件到索引（用于 FSEvents 增量更新）
    pub fn add(&mut self, path: &str, is_dir: bool) {
        let path_buf = PathBuf::from(path);
        if let Some(file_name) = path_buf.file_name() {
            let name = file_name.to_string_lossy().to_string();
            let name_lower = name.to_lowercase();

            // 获取元数据
            let (size, modified) = if let Ok(metadata) = std::fs::metadata(path) {
                let size = metadata.len();
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs());
                (size, modified)
            } else {
                (0, None)
            };

            // 获取扩展名
            let extension = path_buf
                .extension()
                .map(|e| e.to_string_lossy().to_string());

            let file = IndexedFile {
                name: name.clone(),
                name_lower: name_lower.clone(),
                path: path.to_string(),
                is_dir,
                size,
                modified,
                extension,
                is_hidden: name.starts_with('.'),
            };

            // ... (rest of add logic)
            // 如果已存在，先移除旧的名称索引（路径是唯一的，但名称索引可能重复）
            if self.files.contains_key(path) {
                self.name_index.retain(|(_, p)| p != path);
            }

            self.name_index.push((name_lower, path.to_string()));
            self.files.insert(path.to_string(), file);
            self.file_count = self.files.len();
        }
    }

    /// 从索引中移除（用于 FSEvents 增量更新）
    pub fn remove(&mut self, path: &str) {
        if self.files.remove(path).is_some() {
            self.name_index.retain(|(_, p)| p != path);
            self.file_count = self.files.len();
        }
    }
}

impl Default for FileIndex {
    fn default() -> Self {
        Self::new()
    }
}

/// 全局索引状态
pub type SharedIndex = Arc<RwLock<FileIndex>>;

pub fn create_shared_index() -> SharedIndex {
    Arc::new(RwLock::new(FileIndex::new()))
}

enum MemoryWatcherMessage {
    Event(notify::Result<Event>),
    InitialSnapshot(Result<FileIndexData, String>),
    RecoverySnapshot(Result<FileIndexData, String>),
}

#[derive(Default)]
struct PendingMemoryEvents {
    events: Vec<Event>,
    reconciliation_requested: bool,
}

impl PendingMemoryEvents {
    fn push(&mut self, result: notify::Result<Event>) {
        match result {
            Ok(event) if event.need_rescan() => self.request_reconciliation(),
            Ok(event) if !self.reconciliation_requested => self.events.push(event),
            Ok(_) => {}
            Err(error) => {
                eprintln!("Memory index watcher error: {error:?}");
                self.request_reconciliation();
            }
        }
    }

    fn request_reconciliation(&mut self) {
        self.events.clear();
        self.reconciliation_requested = true;
    }

    fn begin_reconciliation(&mut self) {
        self.events.clear();
        self.reconciliation_requested = false;
    }

    fn finish_snapshot(&mut self, succeeded: bool) -> (Vec<Event>, bool) {
        let follow_up = self.reconciliation_requested;
        self.reconciliation_requested = false;
        if succeeded {
            self.events.clear();
        }
        (std::mem::take(&mut self.events), follow_up)
    }

    fn finish_initial_snapshot(&mut self) -> (Vec<Event>, bool) {
        let follow_up = self.reconciliation_requested;
        self.reconciliation_requested = false;
        (std::mem::take(&mut self.events), follow_up)
    }
}

/// 启动后台索引监听器（支持优雅关闭、快照缓冲和漏事件恢复）
pub fn start_index_watcher(
    index: SharedIndex,
    root: String,
    stop_rx: mpsc::Receiver<()>,
    recovery_rx: mpsc::Receiver<()>,
    app: tauri::AppHandle,
) {
    let (event_tx, event_rx) = mpsc::channel::<MemoryWatcherMessage>();
    let send_gate = Arc::new(Mutex::new(()));
    let mut watcher = match create_memory_event_watcher(&root, event_tx.clone(), send_gate.clone())
    {
        Ok(watcher) => Some(watcher),
        Err(error) => {
            eprintln!("Failed to start memory index watcher: {error}");
            None
        }
    };

    if let Ok(mut idx) = index.write() {
        idx.is_building = true;
    }
    let _ = app.emit("index-status", "building");

    thread::spawn(move || {
        let mut pending = PendingMemoryEvents::default();
        let initial_scan = FileIndex::scan(&root, Some(&app));
        send_memory_watcher_message(
            &event_tx,
            &send_gate,
            MemoryWatcherMessage::InitialSnapshot(initial_scan),
        );
        let mut initial_snapshot_received = false;
        let mut last_watcher_retry = std::time::Instant::now();
        let mut next_scan_retry = None;

        loop {
            if stop_rx.try_recv().is_ok() {
                println!("Index watcher received stop signal, shutting down");
                break;
            }

            while recovery_rx.try_recv().is_ok() {
                pending.request_reconciliation();
            }
            if next_scan_retry.is_some_and(|retry_at| retry_at <= std::time::Instant::now()) {
                pending.request_reconciliation();
                next_scan_retry = None;
            }

            if pending.reconciliation_requested && initial_snapshot_received {
                pending.begin_reconciliation();
                if let Ok(mut idx) = index.write() {
                    idx.is_building = true;
                }
                let _ = app.emit("index-status", "building");
                let scan = FileIndex::scan(&root, Some(&app));
                send_memory_watcher_message(
                    &event_tx,
                    &send_gate,
                    MemoryWatcherMessage::RecoverySnapshot(scan),
                );
            }

            if watcher.is_none()
                && last_watcher_retry.elapsed() >= std::time::Duration::from_secs(5)
            {
                match create_memory_event_watcher(&root, event_tx.clone(), send_gate.clone()) {
                    Ok(replacement) => {
                        watcher = Some(replacement);
                        println!("Memory index watcher reconnected");
                    }
                    Err(error) => eprintln!("Failed to reconnect memory index watcher: {error}"),
                }
                last_watcher_retry = std::time::Instant::now();
            }

            match event_rx.recv_timeout(std::time::Duration::from_millis(250)) {
                Ok(MemoryWatcherMessage::Event(result)) => {
                    let watcher_error = result.is_err();
                    pending.push(result);
                    if watcher_error {
                        match create_memory_event_watcher(
                            &root,
                            event_tx.clone(),
                            send_gate.clone(),
                        ) {
                            Ok(replacement) => watcher = Some(replacement),
                            Err(error) => {
                                eprintln!("Failed to restart memory index watcher: {error}");
                                watcher = None;
                            }
                        }
                        last_watcher_retry = std::time::Instant::now();
                    }
                    if initial_snapshot_received && !pending.reconciliation_requested {
                        for event in std::mem::take(&mut pending.events) {
                            handle_event(&index, event);
                        }
                    }
                }
                Ok(MemoryWatcherMessage::InitialSnapshot(scan)) => {
                    initial_snapshot_received = true;
                    let succeeded = publish_memory_snapshot(&index, scan);
                    next_scan_retry = (!succeeded)
                        .then(|| std::time::Instant::now() + std::time::Duration::from_secs(30));
                    let (events, follow_up) = pending.finish_initial_snapshot();
                    for event in events {
                        handle_event(&index, event);
                    }
                    if follow_up {
                        pending.request_reconciliation();
                    }
                    let _ = app.emit("index-status", "ready");
                }
                Ok(MemoryWatcherMessage::RecoverySnapshot(scan)) => {
                    let succeeded = publish_memory_snapshot(&index, scan);
                    next_scan_retry = (!succeeded)
                        .then(|| std::time::Instant::now() + std::time::Duration::from_secs(30));
                    let (events, follow_up) = pending.finish_snapshot(succeeded);
                    for event in events {
                        handle_event(&index, event);
                    }
                    if follow_up {
                        pending.request_reconciliation();
                    }
                    let _ = app.emit("index-status", "ready");
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });
}

fn create_memory_event_watcher(
    root: &str,
    tx: mpsc::Sender<MemoryWatcherMessage>,
    send_gate: Arc<Mutex<()>>,
) -> Result<RecommendedWatcher, String> {
    let mut watcher = RecommendedWatcher::new(
        move |result| {
            if let Ok(_gate) = send_gate.lock() {
                let _ = tx.send(MemoryWatcherMessage::Event(result));
            }
        },
        Config::default(),
    )
    .map_err(|error| format!("could not create watcher: {error}"))?;
    watcher
        .watch(std::path::Path::new(root), RecursiveMode::Recursive)
        .map_err(|error| format!("could not watch {root}: {error}"))?;
    Ok(watcher)
}

fn send_memory_watcher_message(
    tx: &mpsc::Sender<MemoryWatcherMessage>,
    send_gate: &Mutex<()>,
    message: MemoryWatcherMessage,
) {
    if let Ok(_gate) = send_gate.lock() {
        let _ = tx.send(message);
    }
}

fn publish_memory_snapshot(index: &SharedIndex, scan: Result<FileIndexData, String>) -> bool {
    match scan {
        Ok((files, name_index)) => {
            let count = files.len();
            match index.write() {
                Ok(mut idx) => idx.update_data(files, name_index),
                Err(error) => {
                    eprintln!("Failed to publish memory index snapshot: {error}");
                    return false;
                }
            }
            println!("Memory index snapshot published: {count} files");
            true
        }
        Err(error) => {
            eprintln!("Memory index scan failed; preserving the active index: {error}");
            if let Ok(mut idx) = index.write() {
                idx.is_building = false;
            }
            false
        }
    }
}

fn handle_event(index: &SharedIndex, event: Event) {
    let mut idx = match index.write() {
        Ok(idx) => idx,
        Err(e) => {
            eprintln!("Failed to acquire write lock on index: {:?}", e);
            return;
        }
    };

    // 简单的过滤逻辑
    let should_ignore = |path: &std::path::Path| -> bool {
        let path_str = path.to_string_lossy();
        if path_str.contains("/.")
            || path_str.contains("/Library/")
            || path_str.contains("/node_modules/")
        {
            return true;
        }
        false
    };

    match event.kind {
        EventKind::Create(_) => {
            for path in event.paths {
                if should_ignore(&path) {
                    continue;
                }
                let path_str = path.to_string_lossy().to_string();
                let is_dir = path.is_dir();
                idx.add(&path_str, is_dir);
            }
        }
        EventKind::Remove(_) => {
            for path in event.paths {
                // 删除不需要过滤，因为如果它之前被索引了，现在需要移除
                let path_str = path.to_string_lossy().to_string();
                idx.remove(&path_str);
            }
        }
        EventKind::Modify(notify::event::ModifyKind::Name(_mode)) => {
            if event.paths.len() == 2 {
                let from = &event.paths[0];
                let to = &event.paths[1];
                let is_dir = to.is_dir();

                let from_str = from.to_string_lossy().to_string();
                idx.remove(&from_str);

                if !should_ignore(to) {
                    let to_str = to.to_string_lossy().to_string();
                    idx.add(&to_str, is_dir);
                }
            } else {
                for path in event.paths {
                    let path_str = path.to_string_lossy().to_string();
                    if path.exists() {
                        if !should_ignore(&path) {
                            idx.add(&path_str, path.is_dir());
                        }
                    } else {
                        idx.remove(&path_str);
                    }
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_event(path: &str) -> Event {
        let mut event = Event::new(EventKind::Create(notify::event::CreateKind::File));
        event.paths.push(PathBuf::from(path));
        event
    }

    fn indexed_file(path: &str) -> IndexedFile {
        IndexedFile {
            name: "existing.txt".to_string(),
            name_lower: "existing.txt".to_string(),
            path: path.to_string(),
            is_dir: false,
            size: 1,
            modified: None,
            extension: Some("txt".to_string()),
            is_hidden: false,
        }
    }

    #[test]
    fn initial_snapshot_replays_events_buffered_during_scan() {
        let mut pending = PendingMemoryEvents::default();
        pending.push(Ok(create_event("/tmp/during-initial-scan.txt")));

        let (events, follow_up) = pending.finish_initial_snapshot();

        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].paths[0],
            PathBuf::from("/tmp/during-initial-scan.txt")
        );
        assert!(!follow_up);
    }

    #[test]
    fn successful_reconciliation_discards_events_covered_by_snapshot() {
        let mut pending = PendingMemoryEvents::default();
        pending.push(Ok(create_event("/tmp/before-reconciliation.txt")));
        pending.begin_reconciliation();
        pending.push(Ok(create_event("/tmp/during-reconciliation.txt")));

        let (events, follow_up) = pending.finish_snapshot(true);

        assert!(events.is_empty());
        assert!(!follow_up);
    }

    #[test]
    fn failed_memory_snapshot_preserves_the_active_index() {
        let index = create_shared_index();
        let path = "/tmp/existing-index-entry.txt";
        let mut files = HashMap::new();
        files.insert(path.to_string(), indexed_file(path));
        if let Ok(mut idx) = index.write() {
            idx.update_data(files, vec![("existing.txt".to_string(), path.to_string())]);
            idx.is_building = true;
        }

        assert!(!publish_memory_snapshot(
            &index,
            Err("simulated traversal failure".to_string())
        ));

        let idx = index.read().expect("index lock should remain available");
        assert!(!idx.is_building);
        assert_eq!(idx.file_count, 1);
        assert!(idx.files.contains_key(path));
    }

    #[test]
    fn scan_fails_when_the_root_is_missing() {
        let missing_root = std::env::temp_dir().join(format!(
            "imageexplorer-index-missing-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock should be after epoch")
                .as_nanos()
        ));

        assert!(!missing_root.exists());
        assert!(FileIndex::scan(&missing_root.to_string_lossy(), None).is_err());
    }
}
