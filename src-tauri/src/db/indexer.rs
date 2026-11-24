//! 文件索引器
//!
//! 负责扫描文件系统并写入数据库

use ignore::{DirEntry, WalkBuilder, WalkState};
use rusqlite::Connection;
use std::path::{Path, PathBuf, MAIN_SEPARATOR};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::SystemTime;
use tauri::Emitter;

/// 索引构建器（用于全盘扫描）
pub struct IndexBuilder {
    conn: Arc<Mutex<Connection>>,
}

impl IndexBuilder {
    pub fn new(conn: Arc<Mutex<Connection>>) -> Self {
        Self { conn }
    }

    /// Leave a durable marker so startup retries indexing after a watcher
    /// could not be registered for the current session.
    pub fn mark_rebuild_required(&self) -> Result<(), String> {
        self.set_metadata("index_building", "1")
    }

    /// 全盘扫描并构建索引
    pub fn build(&self, root: &str, app: Option<&tauri::AppHandle>) -> Result<usize, String> {
        self.set_metadata("index_building", "1")?;
        match self.build_staging_and_activate(root, app) {
            Ok(count) => Ok(count),
            Err(error) => {
                // A failed scan must leave the last committed index available.
                // Keep index_building set if cleanup itself fails so the next
                // startup retries instead of trusting an uncertain state.
                if let Err(cleanup_error) = self.cleanup_failed_build() {
                    return Err(format!("{error} (staging cleanup failed: {cleanup_error})"));
                }
                Err(error)
            }
        }
    }

    fn build_staging_and_activate(
        &self,
        root: &str,
        app: Option<&tauri::AppHandle>,
    ) -> Result<usize, String> {
        self.prepare_staging_table()?;
        let mut batch = Vec::with_capacity(2000);
        let count = self.scan_files(root, app, |file| {
            batch.push(file);
            if batch.len() >= 2000 {
                self.batch_insert_staging(&batch)?;
                batch.clear();
            }
            Ok(())
        })?;
        if !batch.is_empty() {
            self.batch_insert_staging(&batch)?;
        }
        self.activate_staging_table(root)?;
        Ok(count)
    }

    /// Fast incremental startup reconciliation using directory `mtime` checks.
    ///
    /// Instead of walking all 300k+ files and rewriting the entire `files` and
    /// FTS5 tables on every launch, checks only indexed directories in parallel
    /// (`rayon`) and updates only directories whose `mtime` changed or disappeared
    /// while the app was closed.
    pub fn reconcile_incremental(&self, root: &str) -> Result<usize, String> {
        use rayon::prelude::*;
        use std::collections::{HashMap, HashSet};

        let root_path = Path::new(root);
        let root_mtime = directory_mtime_secs(root_path)
            .ok_or_else(|| format!("Root directory is unavailable: {root}"))?;

        let (indexed_dirs, recorded_root_mtime): (Vec<(String, Option<i64>)>, Option<i64>) = {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare("SELECT path, modified_at FROM files WHERE is_dir = 1")
                .map_err(|e| e.to_string())?;
            let dirs = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;

            let root_mtime_recorded = conn
                .query_row(
                    "SELECT value FROM metadata WHERE key = 'root_mtime'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .ok()
                .and_then(|value| value.parse::<i64>().ok());

            (dirs, root_mtime_recorded)
        };

        let indexed_dir_set: HashSet<String> =
            indexed_dirs.iter().map(|(path, _)| path.clone()).collect();

        enum DirCheck {
            Unchanged,
            Removed(String),
            Dirty(String),
        }

        let checks: Vec<DirCheck> = indexed_dirs
            .par_iter()
            .map(
                |(path, recorded_mtime)| match directory_mtime_secs(Path::new(path)) {
                    None => DirCheck::Removed(path.clone()),
                    Some(current_mtime) if Some(current_mtime) != *recorded_mtime => {
                        DirCheck::Dirty(path.clone())
                    }
                    Some(_) => DirCheck::Unchanged,
                },
            )
            .collect();

        let mut removed_dirs = Vec::new();
        let mut dirty_dirs = Vec::new();
        for check in checks {
            match check {
                DirCheck::Unchanged => {}
                DirCheck::Removed(path) => removed_dirs.push(path),
                DirCheck::Dirty(path) => dirty_dirs.push(path),
            }
        }
        if recorded_root_mtime != Some(root_mtime) {
            dirty_dirs.push(root.to_string());
        }

        let updater = IndexUpdater::new(self.conn.clone());

        // Sort shortest paths first so removing a deleted parent skips redundant child deletes.
        removed_dirs.sort_by_key(|path| path.len());
        let mut removed_prefixes: Vec<String> = Vec::new();
        for removed in removed_dirs {
            let covered = removed_prefixes
                .iter()
                .any(|prefix| removed.starts_with(prefix));
            if covered {
                continue;
            }
            updater.remove(&removed)?;
            removed_prefixes.push(format!("{removed}{MAIN_SEPARATOR}"));
        }

        for dir in dirty_dirs {
            if removed_prefixes
                .iter()
                .any(|prefix| dir.starts_with(prefix))
            {
                continue;
            }
            let dir_path = Path::new(&dir);
            let Ok(read_dir) = std::fs::read_dir(dir_path) else {
                continue;
            };

            let mut current_children: HashMap<String, bool> = HashMap::new();
            for entry in read_dir.flatten() {
                let child_path = entry.path();
                if crate::config::is_index_excluded(&child_path) {
                    continue;
                }
                let is_dir = entry
                    .file_type()
                    .map(|kind| kind.is_dir())
                    .unwrap_or_else(|_| child_path.is_dir());
                current_children.insert(child_path.to_string_lossy().to_string(), is_dir);
            }

            let indexed_children: Vec<String> = {
                let conn = self.conn.lock().map_err(|e| e.to_string())?;
                let mut stmt = conn
                    .prepare("SELECT path FROM files WHERE parent_path = ?1")
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([&dir], |row| row.get::<_, String>(0))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                rows
            };

            for stale in indexed_children {
                if !current_children.contains_key(&stale) {
                    updater.remove(&stale)?;
                }
            }

            for (child_path, is_dir) in current_children {
                if is_dir && !indexed_dir_set.contains(&child_path) {
                    let _ = updater.upsert_subtree(&child_path)?;
                } else {
                    updater.upsert(&child_path, is_dir)?;
                }
            }

            if dir != root {
                updater.upsert(&dir, true)?;
            }
        }

        self.set_metadata("root_mtime", &root_mtime.to_string())?;
        let count = {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            conn.query_row("SELECT COUNT(*) FROM files", [], |row| row.get::<_, i64>(0))
                .map_err(|e| e.to_string())?
                .max(0) as usize
        };
        Ok(count)
    }

    /// 扫描文件系统，并按批次交给数据库写入，避免百万文件全部驻留内存。
    /// 使用真正的并行遍历（build_parallel）并通过有界通道流式交给写线程。
    fn scan_files<F>(
        &self,
        root: &str,
        app: Option<&tauri::AppHandle>,
        mut on_file: F,
    ) -> Result<usize, String>
    where
        F: FnMut(FileRecord) -> Result<(), String>,
    {
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            / 2;
        let threads = std::cmp::max(1, threads);

        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<FileRecord, String>>(4096);
        let cancelled = Arc::new(AtomicBool::new(false));
        let root_owned = root.to_string();
        let walker_cancelled = Arc::clone(&cancelled);

        let walker_handle = std::thread::Builder::new()
            .name("imageexplorer-index-walker".to_string())
            .spawn(move || {
                let walker = WalkBuilder::new(&root_owned)
                    .hidden(false)
                    .git_ignore(false)
                    .git_global(false)
                    .git_exclude(false)
                    .threads(threads)
                    .filter_entry(|entry| !crate::config::is_index_excluded(entry.path()))
                    .build_parallel();

                walker.run(|| {
                    let tx = tx.clone();
                    let root_str = root_owned.clone();
                    let cancelled = Arc::clone(&walker_cancelled);
                    Box::new(move |result| {
                        if cancelled.load(Ordering::Relaxed) {
                            return WalkState::Quit;
                        }
                        let entry = match result {
                            Ok(entry) => entry,
                            Err(error) => {
                                // Skip macOS TCC / permission-denied subdirectories (e.g.
                                // ~/Library/DoNotDisturb) without aborting the entire index.
                                let is_non_root_permission_denied = error.depth().unwrap_or(0) > 0
                                    && error.io_error().is_some_and(|io| {
                                        io.kind() == std::io::ErrorKind::PermissionDenied
                                    });
                                if is_non_root_permission_denied {
                                    return WalkState::Continue;
                                }
                                let _ =
                                    tx.send(Err(format!("index scan traversal failed: {error}")));
                                cancelled.store(true, Ordering::Relaxed);
                                return WalkState::Quit;
                            }
                        };
                        let path = entry.path();
                        let path_str = path.to_string_lossy().to_string();
                        if path_str == root_str {
                            return WalkState::Continue;
                        }
                        let Some(file_name) = path.file_name() else {
                            return WalkState::Continue;
                        };
                        let name = file_name.to_string_lossy().to_string();
                        let name_lower = name.to_lowercase();
                        let (size, modified, is_dir) = if let Ok(metadata) = entry.metadata() {
                            let size = metadata.len() as i64;
                            let modified = metadata
                                .modified()
                                .ok()
                                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                                .map(|d| d.as_secs() as i64);
                            (size, modified, metadata.is_dir())
                        } else {
                            (0, None, entry.file_type().is_some_and(|kind| kind.is_dir()))
                        };
                        let extension = path.extension().map(|e| e.to_string_lossy().to_string());
                        let parent_path = path.parent().map(|p| p.to_string_lossy().to_string());

                        if tx
                            .send(Ok(FileRecord {
                                path: path_str,
                                name,
                                name_lower,
                                extension,
                                size,
                                modified_at: modified,
                                is_dir,
                                parent_path,
                            }))
                            .is_err()
                        {
                            cancelled.store(true, Ordering::Relaxed);
                            return WalkState::Quit;
                        }
                        WalkState::Continue
                    })
                });
            })
            .map_err(|error| format!("Failed to start index walker: {error}"))?;

        let mut count = 0;
        let mut last_emit = std::time::Instant::now();
        let mut scan_result: Result<(), String> = Ok(());

        for item in rx {
            match item {
                Ok(record) => {
                    if let Err(error) = on_file(record) {
                        cancelled.store(true, Ordering::Relaxed);
                        scan_result = Err(error);
                        break;
                    }
                    count += 1;

                    // 进度通知
                    if count % crate::config::INDEX_PROGRESS_INTERVAL == 0
                        || last_emit.elapsed().as_secs() >= 1
                    {
                        if let Some(app_handle) = app {
                            let _ = app_handle.emit("index-progress", count);
                        }
                        last_emit = std::time::Instant::now();

                        // CPU 降速
                        if count % crate::config::INDEX_THROTTLE_INTERVAL == 0 {
                            std::thread::sleep(std::time::Duration::from_millis(
                                crate::config::INDEX_THROTTLE_MS,
                            ));
                        }
                    }
                }
                Err(error) => {
                    cancelled.store(true, Ordering::Relaxed);
                    scan_result = Err(error);
                    break;
                }
            }
        }

        let _ = walker_handle.join();
        scan_result?;
        Ok(count)
    }

    fn set_metadata(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO metadata(key, value) VALUES (?1, ?2)",
            rusqlite::params![key, value],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn prepare_staging_table(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS files_rebuild_staging (
                path TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                name_lower TEXT NOT NULL,
                extension TEXT,
                size INTEGER DEFAULT 0,
                modified_at INTEGER,
                is_dir INTEGER DEFAULT 0,
                parent_path TEXT
            );
            DELETE FROM files_rebuild_staging;",
        )
        .map_err(|e| e.to_string())
    }

    /// 批量写入暂存索引，扫描失败时不会触碰当前可查询索引。
    fn batch_insert_staging(&self, files: &[FileRecord]) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;

        // 每个批次独立事务，避免长事务阻塞搜索和占用过多内存。
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO files_rebuild_staging (path, name, name_lower, extension, size, modified_at, is_dir, parent_path)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                )
                .map_err(|e| e.to_string())?;

            for file in files {
                stmt.execute(rusqlite::params![
                    file.path,
                    file.name,
                    file.name_lower,
                    file.extension,
                    file.size,
                    file.modified_at,
                    file.is_dir as i32,
                    file.parent_path,
                ])
                .map_err(|e| e.to_string())?;
            }
        }

        tx.commit().map_err(|e| e.to_string())?;

        Ok(())
    }

    /// 在单个事务中替换活动索引并同步 FTS。WAL 读者在提交前仍可读取旧索引。
    /// 批量替换前先移除 FTS 触发器，避免逐行维护 FTS 后又全量 rebuild 的双倍开销。
    fn activate_staging_table(&self, root: &str) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        crate::db::schema::drop_fts_triggers(&tx).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM files", [])
            .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO files (path, name, name_lower, extension, size, modified_at, is_dir, parent_path)
             SELECT path, name, name_lower, extension, size, modified_at, is_dir, parent_path
             FROM files_rebuild_staging",
            [],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO files_fts(files_fts) VALUES('rebuild')", [])
            .map_err(|e| e.to_string())?;
        crate::db::schema::setup_fts_triggers(&tx).map_err(|e| e.to_string())?;
        tx.execute("DROP TABLE files_rebuild_staging", [])
            .map_err(|e| e.to_string())?;
        let indexed_at = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            .to_string();
        tx.execute(
            "INSERT OR REPLACE INTO metadata(key, value) VALUES ('last_indexed', ?1)",
            [indexed_at],
        )
        .map_err(|e| e.to_string())?;
        if let Some(root_mtime) = directory_mtime_secs(Path::new(root)) {
            tx.execute(
                "INSERT OR REPLACE INTO metadata(key, value) VALUES ('root_mtime', ?1)",
                [root_mtime.to_string()],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "INSERT OR REPLACE INTO metadata(key, value) VALUES ('index_building', '0')",
            [],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    fn cleanup_failed_build(&self) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch("DROP TABLE IF EXISTS files_rebuild_staging;")
            .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR REPLACE INTO metadata(key, value) VALUES ('index_building', '0')",
            [],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }
}

fn directory_mtime_secs(path: &Path) -> Option<i64> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_dir() {
        return None;
    }
    meta.modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
}

/// 索引更新器（用于增量更新）
pub struct IndexUpdater {
    conn: Arc<Mutex<Connection>>,
    subtree_update_lock: Mutex<()>,
}

impl IndexUpdater {
    pub fn new(conn: Arc<Mutex<Connection>>) -> Self {
        Self {
            conn,
            subtree_update_lock: Mutex::new(()),
        }
    }

    /// 添加或更新文件
    pub fn upsert(&self, path: &str, is_dir: bool) -> Result<(), String> {
        let path_buf = PathBuf::from(path);

        let name = path_buf
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let name_lower = name.to_lowercase();

        let extension = path_buf
            .extension()
            .map(|e| e.to_string_lossy().to_string());

        let parent_path = path_buf.parent().map(|p| p.to_string_lossy().to_string());

        let (size, modified_at) = if let Ok(metadata) = std::fs::metadata(path) {
            let size = metadata.len() as i64;
            let modified = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64);
            (size, modified)
        } else {
            (0, None)
        };

        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        conn.execute(
            "INSERT OR REPLACE INTO files (path, name, name_lower, extension, size, modified_at, is_dir, parent_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                path,
                name,
                name_lower,
                extension,
                size,
                modified_at,
                is_dir as i32,
                parent_path,
            ],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    /// Rebuild one directory subtree off to the side, then replace it atomically.
    /// This is used when a directory enters the indexed area or is created with
    /// existing contents (for example, a move out of an excluded directory).
    pub fn upsert_subtree(&self, root: &str) -> Result<usize, String> {
        let _staging_guard = self
            .subtree_update_lock
            .lock()
            .map_err(|error| error.to_string())?;
        let root_path = Path::new(root);
        if !root_path.is_dir() {
            self.upsert(root, false)?;
            return Ok(1);
        }

        self.prepare_subtree_staging()?;
        let scan_result = (|| {
            let threads = std::thread::available_parallelism()
                .map(|count| count.get() / 2)
                .unwrap_or(2)
                .max(1);
            let walker = WalkBuilder::new(root_path)
                .hidden(false)
                .git_ignore(false)
                .git_global(false)
                .git_exclude(false)
                .threads(threads)
                .filter_entry(|entry| !crate::config::is_index_excluded(entry.path()))
                .build();

            let mut batch = Vec::with_capacity(512);
            let mut count = 0;
            for entry in walker {
                let entry = entry.map_err(|error| error.to_string())?;
                batch.push(file_record_from_entry(&entry)?);
                count += 1;
                if batch.len() == 512 {
                    self.batch_insert_subtree_staging(&batch)?;
                    batch.clear();
                }
            }
            if !batch.is_empty() {
                self.batch_insert_subtree_staging(&batch)?;
            }
            Ok(count)
        })();

        let count = match scan_result {
            Ok(count) => count,
            Err(error) => {
                let cleanup = self.clear_subtree_staging();
                return match cleanup {
                    Ok(()) => Err(error),
                    Err(cleanup_error) => Err(format!(
                        "{error} (subtree staging cleanup failed: {cleanup_error})"
                    )),
                };
            }
        };

        let mut conn = self.conn.lock().map_err(|error| error.to_string())?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        delete_path_tree(&tx, root)?;
        tx.execute(
            "INSERT OR REPLACE INTO files (path, name, name_lower, extension, size, modified_at, is_dir, parent_path)
             SELECT path, name, name_lower, extension, size, modified_at, is_dir, parent_path
             FROM files_subtree_staging",
            [],
        )
        .map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM files_subtree_staging", [])
            .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(count)
    }

    fn prepare_subtree_staging(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|error| error.to_string())?;
        conn.execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS files_subtree_staging (
                path TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                name_lower TEXT NOT NULL,
                extension TEXT,
                size INTEGER DEFAULT 0,
                modified_at INTEGER,
                is_dir INTEGER DEFAULT 0,
                parent_path TEXT
            );
            DELETE FROM files_subtree_staging;",
        )
        .map_err(|error| error.to_string())
    }

    fn batch_insert_subtree_staging(&self, files: &[FileRecord]) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|error| error.to_string())?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO files_subtree_staging (path, name, name_lower, extension, size, modified_at, is_dir, parent_path)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                )
                .map_err(|error| error.to_string())?;
            for file in files {
                stmt.execute(rusqlite::params![
                    file.path,
                    file.name,
                    file.name_lower,
                    file.extension,
                    file.size,
                    file.modified_at,
                    file.is_dir as i32,
                    file.parent_path,
                ])
                .map_err(|error| error.to_string())?;
            }
        }
        tx.commit().map_err(|error| error.to_string())
    }

    fn clear_subtree_staging(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|error| error.to_string())?;
        conn.execute("DELETE FROM files_subtree_staging", [])
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// 删除文件
    pub fn remove(&self, path: &str) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        delete_path_tree(&tx, path)?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// 重命名文件或目录子树；路径字段与 FTS 通过同一事务更新。
    pub fn rename(&self, from: &str, to: &str, is_dir: bool) -> Result<(), String> {
        if from == to {
            return Ok(());
        }

        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let source_paths = read_path_tree(&tx, from, is_dir)?;

        // The OS has already completed this rename. Remove a stale destination
        // subtree before moving the source rows to prevent UNIQUE conflicts.
        delete_path_tree(&tx, to)?;

        if source_paths.is_empty() {
            insert_path_record(&tx, to, is_dir)?;
        } else {
            for old_path in source_paths {
                let suffix = old_path
                    .strip_prefix(from)
                    .ok_or_else(|| format!("Indexed path is outside rename source: {old_path}"))?;
                let new_path = format!("{to}{suffix}");
                let new_buf = PathBuf::from(&new_path);
                let name = new_buf
                    .file_name()
                    .map(|value| value.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let name_lower = name.to_lowercase();
                let extension = new_buf
                    .extension()
                    .map(|value| value.to_string_lossy().into_owned());
                let parent_path = new_buf
                    .parent()
                    .map(|value| value.to_string_lossy().into_owned());
                tx.execute(
                    "UPDATE files
                     SET path = ?1, name = ?2, name_lower = ?3, extension = ?4, parent_path = ?5
                     WHERE path = ?6",
                    rusqlite::params![new_path, name, name_lower, extension, parent_path, old_path],
                )
                .map_err(|e| e.to_string())?;
            }
            // A watcher can report a rename after the root row was already
            // absent from an incomplete/stale index. Ensure the new root exists.
            if !source_paths_contains(&tx, to)? {
                insert_path_record(&tx, to, is_dir)?;
            }
        }

        tx.commit().map_err(|e| e.to_string())
    }
}

fn path_prefix(path: &str) -> String {
    if path.ends_with(MAIN_SEPARATOR) {
        path.to_string()
    } else {
        format!("{path}{MAIN_SEPARATOR}")
    }
}

/// Exclusive upper bound for a path prefix ending with `MAIN_SEPARATOR` so
/// SQLite can satisfy subtree queries with a B-tree index range scan instead of
/// `substr(path, ...)`, which forces a full table scan.
fn path_prefix_upper_bound(prefix: &str) -> String {
    let mut bytes = prefix.as_bytes().to_vec();
    if let Some(last) = bytes.last_mut() {
        *last = last.saturating_add(1);
    }
    String::from_utf8(bytes).unwrap_or_else(|_| format!("{prefix}\u{10FFFF}"))
}

fn read_path_tree(conn: &Connection, root: &str, recursive: bool) -> Result<Vec<String>, String> {
    let mut paths = if recursive {
        let prefix = path_prefix(root);
        let upper_bound = path_prefix_upper_bound(&prefix);
        let mut stmt = conn
            .prepare("SELECT path FROM files WHERE path = ?1 OR (path >= ?2 AND path < ?3)")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![root, prefix, upper_bound], |row| {
                row.get(0)
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    } else {
        let mut stmt = conn
            .prepare("SELECT path FROM files WHERE path = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([root], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    paths.sort_by_key(|path| path.len());
    Ok(paths)
}

fn delete_path_tree(conn: &Connection, root: &str) -> Result<(), String> {
    let prefix = path_prefix(root);
    let upper_bound = path_prefix_upper_bound(&prefix);
    conn.execute(
        "DELETE FROM files WHERE path = ?1 OR (path >= ?2 AND path < ?3)",
        rusqlite::params![root, prefix, upper_bound],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn source_paths_contains(conn: &Connection, path: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM files WHERE path = ?1)",
        [path],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

fn insert_path_record(conn: &Connection, path: &str, is_dir: bool) -> Result<(), String> {
    let path_buf = Path::new(path);
    let name = path_buf
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name_lower = name.to_lowercase();
    let extension = path_buf
        .extension()
        .map(|value| value.to_string_lossy().into_owned());
    let parent_path = path_buf
        .parent()
        .map(|value| value.to_string_lossy().into_owned());
    let (size, modified_at) = std::fs::metadata(path)
        .map(|metadata| {
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs() as i64);
            (metadata.len() as i64, modified)
        })
        .unwrap_or((0, None));

    conn.execute(
        "INSERT OR REPLACE INTO files (path, name, name_lower, extension, size, modified_at, is_dir, parent_path)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![path, name, name_lower, extension, size, modified_at, is_dir as i32, parent_path],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 文件记录
struct FileRecord {
    path: String,
    name: String,
    name_lower: String,
    extension: Option<String>,
    size: i64,
    modified_at: Option<i64>,
    is_dir: bool,
    parent_path: Option<String>,
}

fn file_record_from_entry(entry: &DirEntry) -> Result<FileRecord, String> {
    let path = entry.path();
    let metadata = entry.metadata().map_err(|error| error.to_string())?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64);

    Ok(FileRecord {
        path: path.to_string_lossy().to_string(),
        name_lower: name.to_lowercase(),
        extension: path
            .extension()
            .map(|value| value.to_string_lossy().to_string()),
        size: metadata.len() as i64,
        modified_at,
        is_dir: metadata.is_dir(),
        parent_path: path
            .parent()
            .map(|parent| parent.to_string_lossy().to_string()),
        name,
    })
}

#[cfg(test)]
mod tests {
    use super::{IndexBuilder, IndexUpdater};
    use crate::db::schema;
    use rusqlite::Connection;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn connection() -> Arc<Mutex<Connection>> {
        let conn = Connection::open_in_memory().expect("in-memory database");
        schema::init(&conn).expect("initialize schema");
        Arc::new(Mutex::new(conn))
    }

    fn temp_dir(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be valid")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "imageexplorer-indexer-{label}-{}-{suffix}",
            std::process::id()
        ))
    }

    fn indexed_paths(conn: &Arc<Mutex<Connection>>) -> Vec<String> {
        let guard = conn.lock().expect("database lock");
        let mut stmt = guard
            .prepare("SELECT path FROM files ORDER BY path")
            .expect("prepare path query");
        stmt.query_map([], |row| row.get(0))
            .expect("query paths")
            .collect::<Result<Vec<String>, _>>()
            .expect("read paths")
    }

    #[test]
    fn rebuilding_swaps_in_a_complete_index_and_drops_removed_paths() {
        let conn = connection();
        let updater = IndexUpdater::new(conn.clone());
        updater
            .upsert("/previous-index/keep.txt", false)
            .expect("seed previous index");

        let root = temp_dir("swap");
        std::fs::create_dir_all(root.join("nested")).expect("create fixture");
        std::fs::write(root.join("nested/current.txt"), "current").expect("write fixture file");

        let count = IndexBuilder::new(conn.clone())
            .build(root.to_str().expect("utf-8 temp path"), None)
            .expect("build replacement index");

        let paths = indexed_paths(&conn);
        assert_eq!(count, 2);
        assert!(paths.iter().any(|path| path.ends_with("/nested")));
        assert!(paths
            .iter()
            .any(|path| path.ends_with("/nested/current.txt")));
        assert!(!paths
            .iter()
            .any(|path| path.starts_with("/previous-index/")));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn failed_rebuild_preserves_active_index_and_clears_staging_state() {
        let conn = connection();
        let updater = IndexUpdater::new(conn.clone());
        updater
            .upsert("/previous-index/keep.txt", false)
            .expect("seed previous index");

        {
            let guard = conn.lock().expect("database lock");
            guard
                .execute_batch(
                    "CREATE TABLE files_rebuild_staging (
                        path TEXT UNIQUE NOT NULL,
                        name TEXT NOT NULL,
                        name_lower TEXT NOT NULL,
                        extension TEXT,
                        size INTEGER DEFAULT 0,
                        modified_at INTEGER,
                        is_dir INTEGER DEFAULT 0,
                        parent_path TEXT
                    );
                    CREATE TRIGGER fail_rebuild_insert
                    BEFORE INSERT ON files_rebuild_staging
                    BEGIN SELECT RAISE(ABORT, 'forced staging failure'); END;",
                )
                .expect("create failure injection");
        }

        let root = temp_dir("failure");
        std::fs::create_dir_all(&root).expect("create fixture");
        std::fs::write(root.join("current.txt"), "current").expect("write fixture file");

        let result =
            IndexBuilder::new(conn.clone()).build(root.to_str().expect("utf-8 temp path"), None);
        assert!(result.is_err());
        assert_eq!(indexed_paths(&conn), vec!["/previous-index/keep.txt"]);

        let guard = conn.lock().expect("database lock");
        let building: String = guard
            .query_row(
                "SELECT value FROM metadata WHERE key = 'index_building'",
                [],
                |row| row.get(0),
            )
            .expect("index build state");
        assert_eq!(building, "0");
        let staging_tables: i64 = guard
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='files_rebuild_staging'",
                [],
                |row| row.get(0),
            )
            .expect("staging table count");
        assert_eq!(staging_tables, 0);
        drop(guard);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn traversal_failure_preserves_active_index_and_can_be_marked_for_retry() {
        let conn = connection();
        let updater = IndexUpdater::new(conn.clone());
        updater
            .upsert("/previous-index/keep.txt", false)
            .expect("seed previous index");

        let missing_root = temp_dir("missing-root");
        let builder = IndexBuilder::new(conn.clone());
        let error = builder
            .build(missing_root.to_str().expect("utf-8 temp path"), None)
            .expect_err("missing root should fail the authoritative scan");
        assert!(error.contains("index scan traversal failed"));
        assert_eq!(indexed_paths(&conn), vec!["/previous-index/keep.txt"]);

        builder
            .mark_rebuild_required()
            .expect("persist retry marker");
        let guard = conn.lock().expect("database lock");
        let building: String = guard
            .query_row(
                "SELECT value FROM metadata WHERE key = 'index_building'",
                [],
                |row| row.get(0),
            )
            .expect("index build state");
        assert_eq!(building, "1");
    }

    #[test]
    fn directory_rename_and_remove_are_subtree_scoped_transactions() {
        let conn = connection();
        let updater = IndexUpdater::new(conn.clone());
        for (path, is_dir) in [
            ("/tmp/old", true),
            ("/tmp/old/nested", true),
            ("/tmp/old/nested/file.txt", false),
            ("/tmp/oldish/keep.txt", false),
        ] {
            updater.upsert(path, is_dir).expect("seed index");
        }

        updater
            .rename("/tmp/old", "/tmp/new", true)
            .expect("rename indexed subtree");
        let paths = indexed_paths(&conn);
        assert!(paths.contains(&"/tmp/new".to_string()));
        assert!(paths.contains(&"/tmp/new/nested/file.txt".to_string()));
        assert!(!paths.iter().any(|path| path.starts_with("/tmp/old/")));
        assert!(paths.contains(&"/tmp/oldish/keep.txt".to_string()));

        updater.remove("/tmp/new").expect("remove indexed subtree");
        let paths = indexed_paths(&conn);
        assert!(!paths
            .iter()
            .any(|path| path == "/tmp/new" || path.starts_with("/tmp/new/")));
        assert!(paths.contains(&"/tmp/oldish/keep.txt".to_string()));
    }

    #[test]
    fn subtree_upsert_indexes_nested_entries_and_removes_stale_descendants() {
        let conn = connection();
        let updater = IndexUpdater::new(conn.clone());
        let root = temp_dir("subtree-upsert");
        std::fs::create_dir_all(root.join("nested/deeper")).expect("create nested fixture");
        std::fs::create_dir_all(root.join("nested/node_modules/pkg"))
            .expect("create excluded fixture");
        let current_file = root.join("nested/deeper/current.txt");
        let stale_file = root.join("stale.txt");
        std::fs::write(&current_file, "current").expect("write current file");
        std::fs::write(&stale_file, "stale").expect("write stale file");
        let excluded_file = root.join("nested/node_modules/pkg/ignored.js");
        std::fs::write(&excluded_file, "ignored").expect("write excluded file");
        let root_str = root.to_str().expect("utf-8 fixture path");

        let count = updater.upsert_subtree(root_str).expect("index subtree");
        assert_eq!(count, 5);
        let paths = indexed_paths(&conn);
        assert!(paths.contains(&root.to_string_lossy().to_string()));
        assert!(paths.contains(&current_file.to_string_lossy().to_string()));
        assert!(!paths.contains(
            &root
                .join("nested/node_modules")
                .to_string_lossy()
                .to_string()
        ));
        assert!(!paths.contains(&excluded_file.to_string_lossy().to_string()));

        std::fs::remove_file(&stale_file).expect("remove stale file");
        updater
            .upsert_subtree(root_str)
            .expect("refresh changed subtree");
        let paths = indexed_paths(&conn);
        assert!(!paths.contains(&stale_file.to_string_lossy().to_string()));
        assert!(paths.contains(&current_file.to_string_lossy().to_string()));

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn incremental_reconcile_updates_changed_directories_and_removes_deleted_subtrees() {
        let conn = connection();
        let builder = IndexBuilder::new(conn.clone());
        let root = temp_dir("incremental-reconcile");
        let keep_dir = root.join("keep");
        let drop_dir = root.join("drop");
        std::fs::create_dir_all(&keep_dir).expect("create keep dir");
        std::fs::create_dir_all(&drop_dir).expect("create drop dir");
        let keep_file = keep_dir.join("unchanged.txt");
        let drop_file = drop_dir.join("gone.txt");
        std::fs::write(&keep_file, "keep").expect("write keep");
        std::fs::write(&drop_file, "drop").expect("write drop");

        let root_str = root.to_str().expect("utf-8 root");
        builder.build(root_str, None).expect("initial full build");

        // Wait >1s so directory mtime seconds advance cleanly on filesystems with 1s granularity.
        std::thread::sleep(std::time::Duration::from_millis(1100));

        // Simulate offline changes while app was closed:
        // 1) add a new file in an existing dir, 2) add a brand new nested dir, 3) remove an entire dir.
        let added_file = keep_dir.join("added.txt");
        std::fs::write(&added_file, "added").expect("write added");
        let new_nested = root.join("brand_new/deep");
        std::fs::create_dir_all(&new_nested).expect("create brand new nested dir");
        let nested_file = new_nested.join("photo.arw");
        std::fs::write(&nested_file, "raw").expect("write nested file");
        std::fs::remove_dir_all(&drop_dir).expect("remove drop dir");

        let count = builder
            .reconcile_incremental(root_str)
            .expect("incremental reconcile");
        assert!(count >= 5);

        let paths = indexed_paths(&conn);
        assert!(paths.contains(&keep_file.to_string_lossy().to_string()));
        assert!(paths.contains(&added_file.to_string_lossy().to_string()));
        assert!(paths.contains(&nested_file.to_string_lossy().to_string()));
        assert!(!paths.contains(&drop_dir.to_string_lossy().to_string()));
        assert!(!paths.contains(&drop_file.to_string_lossy().to_string()));

        let _ = std::fs::remove_dir_all(root);
    }
}
