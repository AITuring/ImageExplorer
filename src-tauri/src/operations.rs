use crate::commands::fs::{copy_file, delete_to_trash, move_file};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

static NEXT_OPERATION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OperationKind {
    Copy,
    Move,
    Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OperationStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UndoStatus {
    None,
    Available,
    Queued,
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    KeepBoth,
    Replace,
    Skip,
}

#[derive(Debug, Clone, Serialize)]
pub struct OperationConflict {
    pub source: String,
    pub destination: String,
    pub source_is_dir: bool,
    pub destination_is_dir: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct OperationSnapshot {
    pub id: String,
    pub kind: OperationKind,
    pub status: OperationStatus,
    pub total_items: usize,
    pub completed_items: usize,
    pub failed_items: usize,
    pub skipped_items: usize,
    pub total_bytes: u64,
    pub completed_bytes: u64,
    pub current_item: Option<String>,
    pub errors: Vec<String>,
    pub cancel_requested: bool,
    pub undo_status: UndoStatus,
    pub started_at: u64,
    pub finished_at: Option<u64>,
}

#[derive(Debug, Clone)]
enum UndoAction {
    RemoveCreatedPath { path: String },
    MoveBack { from: String, to: String },
}

struct OperationRecord {
    snapshot: OperationSnapshot,
    cancel_requested: Arc<AtomicBool>,
    undo_actions: Vec<UndoAction>,
}

struct OperationJob {
    id: String,
    kind: OperationKind,
    paths: Vec<String>,
    destination: Option<String>,
    conflict_policy: ConflictPolicy,
}

enum QueueJob {
    Operation(OperationJob),
    Undo {
        operation_id: String,
        actions: Vec<UndoAction>,
    },
}

#[derive(Clone, Default)]
pub struct OperationManager {
    records: Arc<Mutex<HashMap<String, OperationRecord>>>,
    queue: Arc<Mutex<VecDeque<QueueJob>>>,
    worker_running: Arc<AtomicBool>,
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn new_operation_id() -> String {
    let sequence = NEXT_OPERATION_ID.fetch_add(1, Ordering::Relaxed);
    format!("op-{}-{}", now_seconds(), sequence)
}

fn source_bytes(paths: &[String]) -> u64 {
    paths
        .iter()
        .filter_map(|path| fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .sum()
}

fn destination_for(path: &str, destination: &str) -> Result<std::path::PathBuf, String> {
    Path::new(path)
        .file_name()
        .map(|name| Path::new(destination).join(name))
        .ok_or_else(|| format!("Invalid source path: {}", path))
}

pub fn conflicts(paths: Vec<String>, destination: String) -> Vec<OperationConflict> {
    paths
        .into_iter()
        .filter_map(|source| {
            let target = destination_for(&source, &destination).ok()?;
            if !target.exists() {
                return None;
            }
            let source_is_dir = fs::metadata(&source)
                .map(|metadata| metadata.is_dir())
                .unwrap_or(false);
            let destination_is_dir = fs::metadata(&target)
                .map(|metadata| metadata.is_dir())
                .unwrap_or(false);
            Some(OperationConflict {
                source,
                destination: target.to_string_lossy().to_string(),
                source_is_dir,
                destination_is_dir,
            })
        })
        .collect()
}

impl OperationManager {
    pub fn start(
        &self,
        app: AppHandle,
        kind: OperationKind,
        paths: Vec<String>,
        destination: Option<String>,
        conflict_policy: Option<ConflictPolicy>,
    ) -> Result<String, String> {
        if paths.is_empty() {
            return Err("No files were selected".to_string());
        }

        if matches!(kind, OperationKind::Copy | OperationKind::Move)
            && destination.as_deref().unwrap_or_default().is_empty()
        {
            return Err("A destination directory is required".to_string());
        }

        let id = new_operation_id();
        let cancel_requested = Arc::new(AtomicBool::new(false));
        let snapshot = OperationSnapshot {
            id: id.clone(),
            kind,
            status: OperationStatus::Queued,
            total_items: paths.len(),
            completed_items: 0,
            failed_items: 0,
            skipped_items: 0,
            total_bytes: source_bytes(&paths),
            completed_bytes: 0,
            current_item: None,
            errors: Vec::new(),
            cancel_requested: false,
            undo_status: UndoStatus::None,
            started_at: now_seconds(),
            finished_at: None,
        };

        {
            let mut records = self.records.lock().map_err(|e| e.to_string())?;
            records.insert(
                id.clone(),
                OperationRecord {
                    snapshot: snapshot.clone(),
                    cancel_requested,
                    undo_actions: Vec::new(),
                },
            );
        }
        self.emit(&app, &snapshot);

        {
            let mut queue = self.queue.lock().map_err(|e| e.to_string())?;
            queue.push_back(QueueJob::Operation(OperationJob {
                id: id.clone(),
                kind,
                paths,
                destination,
                conflict_policy: conflict_policy.unwrap_or(ConflictPolicy::KeepBoth),
            }));
        }

        self.ensure_worker(app);
        Ok(id)
    }

    fn ensure_worker(&self, app: AppHandle) {
        if self
            .worker_running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }

        let manager = self.clone();
        tauri::async_runtime::spawn_blocking(move || manager.worker_loop(app));
    }

    fn worker_loop(&self, app: AppHandle) {
        loop {
            let job = self
                .queue
                .lock()
                .ok()
                .and_then(|mut queue| queue.pop_front());

            if let Some(job) = job {
                match job {
                    QueueJob::Operation(job) => self.run_job(&app, job),
                    QueueJob::Undo {
                        operation_id,
                        actions,
                    } => self.run_undo_job(&app, operation_id, actions),
                }
                continue;
            }

            // Close the small race between observing an empty queue and
            // marking the worker idle. A producer that enqueues during this
            // window will be picked up here instead of being stranded.
            self.worker_running.store(false, Ordering::Release);
            let has_pending = self
                .queue
                .lock()
                .map(|queue| !queue.is_empty())
                .unwrap_or(false);
            if has_pending
                && self
                    .worker_running
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
            {
                continue;
            }
            return;
        }
    }

    fn run_job(&self, app: &AppHandle, job: OperationJob) {
        let Some(cancel_requested) = self.cancel_flag(&job.id) else {
            return;
        };

        if cancel_requested.load(Ordering::Acquire) {
            self.finish(app, &job.id, OperationStatus::Cancelled);
            return;
        }

        self.update(app, &job.id, |snapshot| {
            snapshot.status = OperationStatus::Running;
        });

        for path in &job.paths {
            if cancel_requested.load(Ordering::Acquire) {
                self.finish(app, &job.id, OperationStatus::Cancelled);
                return;
            }

            self.update(app, &job.id, |snapshot| {
                snapshot.current_item = Some(path.clone());
            });

            let item_bytes = fs::metadata(Path::new(path))
                .map(|metadata| metadata.len())
                .unwrap_or(0);

            let destination_path = job
                .destination
                .as_deref()
                .and_then(|destination| destination_for(path, destination).ok());

            if matches!(job.kind, OperationKind::Move)
                && destination_path
                    .as_ref()
                    .is_some_and(|destination| destination == Path::new(path))
            {
                self.update(app, &job.id, |snapshot| {
                    snapshot.skipped_items += 1;
                    snapshot.current_item = None;
                });
                continue;
            }

            if destination_path
                .as_ref()
                .is_some_and(|destination| destination.exists())
                && matches!(job.conflict_policy, ConflictPolicy::Skip)
            {
                self.update(app, &job.id, |snapshot| {
                    snapshot.skipped_items += 1;
                    snapshot.current_item = None;
                });
                continue;
            }

            if matches!(job.conflict_policy, ConflictPolicy::Replace) {
                if let Some(destination) = destination_path.as_ref().filter(|path| path.exists()) {
                    if let Err(error) = delete_to_trash(destination.to_string_lossy().to_string()) {
                        self.update(app, &job.id, |snapshot| {
                            snapshot.failed_items += 1;
                            snapshot.errors.push(format!("{}: {}", path, error));
                            snapshot.current_item = None;
                        });
                        continue;
                    }
                }
            }

            let result = match job.kind {
                OperationKind::Copy => {
                    copy_file(path.clone(), job.destination.clone().unwrap_or_default()).map(Some)
                }
                OperationKind::Move => {
                    move_file(path.clone(), job.destination.clone().unwrap_or_default()).map(Some)
                }
                OperationKind::Delete => delete_to_trash(path.clone()).map(|_| None),
            };

            match result {
                Ok(created_path) => {
                    if let Some(created_path) = created_path {
                        let action = match job.kind {
                            OperationKind::Copy => {
                                UndoAction::RemoveCreatedPath { path: created_path }
                            }
                            OperationKind::Move => UndoAction::MoveBack {
                                from: path.clone(),
                                to: created_path,
                            },
                            OperationKind::Delete => unreachable!("delete does not return a path"),
                        };
                        self.add_undo_action(&job.id, action);
                    }
                    // 目录监听器按 WebView 注册，跨窗口拖拽时不能只依赖
                    // 单个窗口的 notify watcher；把受影响的目录变化广播给
                    // 所有窗口，让源窗口和目标窗口都立即失效并刷新缓存。
                    if matches!(job.kind, OperationKind::Move | OperationKind::Delete) {
                        if let Some(parent) = Path::new(path).parent() {
                            let parent = parent.to_string_lossy().to_string();
                            let _ = app.emit("dir-change", &parent);
                        }
                    }
                    if matches!(job.kind, OperationKind::Copy | OperationKind::Move) {
                        if let Some(destination) = job.destination.as_deref() {
                            let _ = app.emit("dir-change", destination);
                        }
                    }
                    self.update(app, &job.id, |snapshot| {
                        snapshot.completed_items += 1;
                        snapshot.completed_bytes =
                            snapshot.completed_bytes.saturating_add(item_bytes);
                        snapshot.current_item = None;
                    });
                }
                Err(error) => {
                    self.update(app, &job.id, |snapshot| {
                        snapshot.failed_items += 1;
                        snapshot.errors.push(format!("{}: {}", path, error));
                        snapshot.current_item = None;
                    });
                }
            }
        }

        let status = self
            .records
            .lock()
            .ok()
            .and_then(|records| {
                records
                    .get(&job.id)
                    .map(|record| record.snapshot.failed_items)
            })
            .map(|failed| {
                if failed > 0 {
                    OperationStatus::Failed
                } else {
                    OperationStatus::Completed
                }
            })
            .unwrap_or(OperationStatus::Failed);
        self.finish(app, &job.id, status);
    }

    fn run_undo_job(&self, app: &AppHandle, operation_id: String, actions: Vec<UndoAction>) {
        self.update(app, &operation_id, |snapshot| {
            snapshot.undo_status = UndoStatus::Running;
            snapshot.current_item = None;
        });

        for action in actions.iter().rev() {
            let (display_path, result) = match action {
                UndoAction::RemoveCreatedPath { path } => {
                    (path.clone(), delete_to_trash(path.clone()))
                }
                UndoAction::MoveBack { from, to } => {
                    let result = if Path::new(from).exists() {
                        Err(format!("Original path already exists: {}", from))
                    } else if let Some(parent) = Path::new(from).parent() {
                        move_file(to.clone(), parent.to_string_lossy().to_string()).and_then(
                            |restored| {
                                if restored == from.as_str() {
                                    Ok(())
                                } else {
                                    Err(format!("Undo target was renamed to {}", restored))
                                }
                            },
                        )
                    } else {
                        Err(format!("Invalid original path: {}", from))
                    };
                    (to.clone(), result)
                }
            };

            self.update(app, &operation_id, |snapshot| {
                snapshot.current_item = Some(display_path.clone());
            });

            match result {
                Ok(()) => {
                    if let Some(parent) = Path::new(&display_path).parent() {
                        let _ = app.emit("dir-change", parent.to_string_lossy().to_string());
                    }
                    if let UndoAction::MoveBack { from, .. } = action {
                        if let Some(parent) = Path::new(from).parent() {
                            let _ = app.emit("dir-change", parent.to_string_lossy().to_string());
                        }
                    }
                    self.update(app, &operation_id, |snapshot| {
                        snapshot.current_item = None;
                    });
                }
                Err(error) => {
                    self.update(app, &operation_id, |snapshot| {
                        snapshot.undo_status = UndoStatus::Failed;
                        snapshot
                            .errors
                            .push(format!("Undo {}: {}", display_path, error));
                        snapshot.current_item = None;
                    });
                    return;
                }
            }
        }

        self.update(app, &operation_id, |snapshot| {
            snapshot.undo_status = UndoStatus::Completed;
            snapshot.current_item = None;
        });
    }

    fn cancel_flag(&self, id: &str) -> Option<Arc<AtomicBool>> {
        self.records.lock().ok().and_then(|records| {
            records
                .get(id)
                .map(|record| record.cancel_requested.clone())
        })
    }

    fn add_undo_action(&self, id: &str, action: UndoAction) {
        if let Ok(mut records) = self.records.lock() {
            if let Some(record) = records.get_mut(id) {
                record.undo_actions.push(action);
            }
        }
    }

    fn update<F>(&self, app: &AppHandle, id: &str, update: F)
    where
        F: FnOnce(&mut OperationSnapshot),
    {
        let snapshot = {
            let Ok(mut records) = self.records.lock() else {
                return;
            };
            let Some(record) = records.get_mut(id) else {
                return;
            };
            update(&mut record.snapshot);
            record.snapshot.cancel_requested = record.cancel_requested.load(Ordering::Acquire);
            record.snapshot.clone()
        };
        self.emit(app, &snapshot);
    }

    fn finish(&self, app: &AppHandle, id: &str, status: OperationStatus) {
        let has_undo_actions = self
            .records
            .lock()
            .ok()
            .and_then(|records| {
                records
                    .get(id)
                    .map(|record| !record.undo_actions.is_empty())
            })
            .unwrap_or(false);
        self.update(app, id, |snapshot| {
            snapshot.status = status;
            snapshot.current_item = None;
            snapshot.finished_at = Some(now_seconds());
            snapshot.undo_status = if has_undo_actions {
                UndoStatus::Available
            } else {
                UndoStatus::None
            };
        });
    }

    fn emit(&self, app: &AppHandle, snapshot: &OperationSnapshot) {
        let _ = app.emit("file-operation-updated", snapshot);
    }

    pub fn snapshots(&self) -> Vec<OperationSnapshot> {
        let mut snapshots = self
            .records
            .lock()
            .map(|records| {
                records
                    .values()
                    .map(|record| record.snapshot.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        snapshots.sort_by_key(|snapshot| std::cmp::Reverse(snapshot.started_at));
        snapshots
    }

    pub fn cancel(&self, app: &AppHandle, id: &str) -> Result<(), String> {
        let snapshot = {
            let mut records = self.records.lock().map_err(|e| e.to_string())?;
            let Some(record) = records.get_mut(id) else {
                return Err("Operation not found".to_string());
            };
            if matches!(
                record.snapshot.status,
                OperationStatus::Completed | OperationStatus::Failed | OperationStatus::Cancelled
            ) {
                return Ok(());
            }
            record.cancel_requested.store(true, Ordering::Release);
            record.snapshot.cancel_requested = true;
            if record.snapshot.status == OperationStatus::Queued {
                record.snapshot.status = OperationStatus::Cancelled;
                record.snapshot.finished_at = Some(now_seconds());
            }
            record.snapshot.clone()
        };
        self.emit(app, &snapshot);
        Ok(())
    }

    pub fn undo(&self, app: AppHandle, id: &str) -> Result<(), String> {
        let (snapshot, actions) = {
            let mut records = self.records.lock().map_err(|e| e.to_string())?;
            let Some(record) = records.get_mut(id) else {
                return Err("Operation not found".to_string());
            };
            if !matches!(
                record.snapshot.undo_status,
                UndoStatus::Available | UndoStatus::Failed
            ) {
                return Err("Operation cannot be undone".to_string());
            }
            if record.undo_actions.is_empty() {
                return Err("Operation has no undo actions".to_string());
            }
            record.snapshot.undo_status = UndoStatus::Queued;
            (record.snapshot.clone(), record.undo_actions.clone())
        };

        self.emit(&app, &snapshot);
        {
            let mut queue = self.queue.lock().map_err(|e| e.to_string())?;
            queue.push_back(QueueJob::Undo {
                operation_id: id.to_string(),
                actions,
            });
        }
        self.ensure_worker(app);
        Ok(())
    }

    pub fn clear(&self, id: &str) -> Result<(), String> {
        let mut records = self.records.lock().map_err(|e| e.to_string())?;
        if records
            .get(id)
            .map(|record| {
                matches!(
                    record.snapshot.status,
                    OperationStatus::Completed
                        | OperationStatus::Failed
                        | OperationStatus::Cancelled
                ) && !matches!(
                    record.snapshot.undo_status,
                    UndoStatus::Queued | UndoStatus::Running
                )
            })
            .unwrap_or(false)
        {
            records.remove(id);
        }
        Ok(())
    }
}

#[tauri::command]
pub fn start_copy_operation(
    app: AppHandle,
    manager: State<'_, OperationManager>,
    paths: Vec<String>,
    dest_dir: String,
    conflict_policy: Option<ConflictPolicy>,
) -> Result<String, String> {
    manager.start(
        app,
        OperationKind::Copy,
        paths,
        Some(dest_dir),
        conflict_policy,
    )
}

#[tauri::command]
pub fn start_move_operation(
    app: AppHandle,
    manager: State<'_, OperationManager>,
    paths: Vec<String>,
    dest_dir: String,
    conflict_policy: Option<ConflictPolicy>,
) -> Result<String, String> {
    manager.start(
        app,
        OperationKind::Move,
        paths,
        Some(dest_dir),
        conflict_policy,
    )
}

#[tauri::command]
pub fn start_delete_operation(
    app: AppHandle,
    manager: State<'_, OperationManager>,
    paths: Vec<String>,
) -> Result<String, String> {
    manager.start(app, OperationKind::Delete, paths, None, None)
}

#[tauri::command]
pub fn get_file_operation_conflicts(
    paths: Vec<String>,
    dest_dir: String,
) -> Vec<OperationConflict> {
    conflicts(paths, dest_dir)
}

#[tauri::command]
pub fn get_file_operations(manager: State<'_, OperationManager>) -> Vec<OperationSnapshot> {
    manager.snapshots()
}

#[tauri::command]
pub fn cancel_file_operation(
    app: AppHandle,
    manager: State<'_, OperationManager>,
    operation_id: String,
) -> Result<(), String> {
    manager.cancel(&app, &operation_id)
}

#[tauri::command]
pub fn undo_file_operation(
    app: AppHandle,
    manager: State<'_, OperationManager>,
    operation_id: String,
) -> Result<(), String> {
    manager.undo(app, &operation_id)
}

#[tauri::command]
pub fn clear_file_operation(
    manager: State<'_, OperationManager>,
    operation_id: String,
) -> Result<(), String> {
    manager.clear(&operation_id)
}

#[cfg(test)]
mod tests {
    use super::conflicts;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn conflicts_reports_existing_destination_items() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be valid")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("imageexplorer-conflict-test-{}", suffix));
        let source_dir = root.join("source");
        let destination_dir = root.join("destination");
        fs::create_dir_all(&source_dir).expect("source directory should be created");
        fs::create_dir_all(&destination_dir).expect("destination directory should be created");
        let source = source_dir.join("sample.txt");
        let destination = destination_dir.join("sample.txt");
        fs::write(&source, b"source").expect("source file should be written");
        fs::write(&destination, b"destination").expect("destination file should be written");

        let result = conflicts(
            vec![source.to_string_lossy().to_string()],
            destination_dir.to_string_lossy().to_string(),
        );

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].source, source.to_string_lossy());
        assert_eq!(result[0].destination, destination.to_string_lossy());
        assert!(!result[0].source_is_dir);
        assert!(!result[0].destination_is_dir);

        let _ = fs::remove_dir_all(root);
    }
}
