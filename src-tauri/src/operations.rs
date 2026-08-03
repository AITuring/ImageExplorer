use crate::commands::fs::{copy_file_resumable, delete_to_trash, get_disk_space, move_file};
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OperationKind {
    Copy,
    Move,
    Delete,
    Compress,
    Extract,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OperationStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    Archive {
        id: String,
        kind: OperationKind,
        paths: Vec<String>,
        destination: String,
    },
    Undo {
        operation_id: String,
        actions: Vec<UndoAction>,
    },
}

#[derive(Clone)]
pub struct OperationManager {
    records: Arc<Mutex<HashMap<String, OperationRecord>>>,
    queue: Arc<Mutex<VecDeque<QueueJob>>>,
    worker_running: Arc<AtomicBool>,
}

fn operation_state_path() -> std::path::PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("com.hyperexplorer.app")
        .join("operations.json")
}

fn persist_snapshot_map(records: &HashMap<String, OperationRecord>) {
    let snapshots: Vec<OperationSnapshot> = records
        .values()
        .map(|record| {
            let mut snapshot = record.snapshot.clone();
            snapshot.current_item = snapshot.current_item.as_deref().map(redact_path);
            snapshot
        })
        .collect();
    let Ok(payload) = serde_json::to_vec_pretty(&snapshots) else {
        return;
    };
    let path = operation_state_path();
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let temp = path.with_extension("json.tmp");
    if fs::write(&temp, payload).is_ok() {
        let _ = fs::rename(temp, path);
    }
}

impl Default for OperationManager {
    fn default() -> Self {
        let mut records = HashMap::new();
        if let Ok(payload) = fs::read(operation_state_path()) {
            if let Ok(mut snapshots) = serde_json::from_slice::<Vec<OperationSnapshot>>(&payload) {
                for snapshot in &mut snapshots {
                    if matches!(
                        snapshot.status,
                        OperationStatus::Queued | OperationStatus::Running
                    ) {
                        snapshot.status = OperationStatus::Failed;
                        snapshot.cancel_requested = true;
                        snapshot.finished_at = Some(now_seconds());
                        snapshot.errors.push(
                            "Operation interrupted by an application restart; please retry it."
                                .to_string(),
                        );
                    }
                    records.insert(
                        snapshot.id.clone(),
                        OperationRecord {
                            snapshot: snapshot.clone(),
                            cancel_requested: Arc::new(AtomicBool::new(snapshot.cancel_requested)),
                            undo_actions: Vec::new(),
                        },
                    );
                }
            }
        }
        Self {
            records: Arc::new(Mutex::new(records)),
            queue: Arc::new(Mutex::new(VecDeque::new())),
            worker_running: Arc::new(AtomicBool::new(false)),
        }
    }
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

fn path_bytes(path: &Path) -> u64 {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return 0;
    };
    if !metadata.is_dir() {
        return metadata.len();
    }
    fs::read_dir(path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| path_bytes(&entry.path()))
        .sum()
}

fn source_bytes(paths: &[String]) -> u64 {
    paths.iter().map(|path| path_bytes(Path::new(path))).sum()
}

fn is_transient_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    [
        "timed out",
        "timeout",
        "temporarily unavailable",
        "resource busy",
        "would block",
        "stale file handle",
        "input/output error",
        "network",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn retry_operation<T, F>(mut operation: F) -> Result<T, String>
where
    F: FnMut() -> Result<T, String>,
{
    let mut last_error = String::new();
    for attempt in 0..3 {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) => {
                last_error = error;
                if !is_transient_error(&last_error) || attempt == 2 {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(150 * (attempt + 1)));
            }
        }
    }
    Err(last_error)
}

fn ensure_destination_space(paths: &[String], destination: &str) -> Result<(), String> {
    let required = source_bytes(paths);
    let Some(available) = get_disk_space(destination.to_string())
        .ok()
        .and_then(|space| space.available_bytes)
    else {
        return Ok(());
    };
    let headroom = (required / 100).max(64 * 1024 * 1024);
    let needed = required.saturating_add(headroom);
    if available < needed {
        return Err(format!(
            "Insufficient disk space: need at least {} bytes, but only {} bytes are available",
            needed, available
        ));
    }
    Ok(())
}

fn destination_for(path: &str, destination: &str) -> Result<std::path::PathBuf, String> {
    Path::new(path)
        .file_name()
        .map(|name| Path::new(destination).join(name))
        .ok_or_else(|| format!("Invalid source path: {}", path))
}

fn redact_path(path: &str) -> String {
    if let Some(home) = dirs::home_dir() {
        let home = home.to_string_lossy();
        if let Some(relative) = path.strip_prefix(home.as_ref()) {
            return format!("~{}", relative);
        }
    }
    path.to_string()
}

fn redact_error(error: &str) -> String {
    if let Some(home) = dirs::home_dir() {
        return error.replace(home.to_string_lossy().as_ref(), "~");
    }
    error.to_string()
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

fn unique_archive_path(base: &Path, directory: bool) -> std::path::PathBuf {
    if !base.exists() {
        return base.to_path_buf();
    }
    let stem = base.file_stem().unwrap_or_default().to_string_lossy();
    let extension = if directory {
        String::new()
    } else {
        base.extension()
            .map(|value| format!(".{}", value.to_string_lossy()))
            .unwrap_or_default()
    };
    let mut counter = 1;
    loop {
        let candidate = base.with_file_name(format!("{} {}{}", stem, counter, extension));
        if !candidate.exists() {
            return candidate;
        }
        counter += 1;
    }
}

fn run_archive_command(
    kind: OperationKind,
    paths: &[String],
    destination: &str,
) -> Result<(), String> {
    if paths.is_empty() {
        return Err("No archive input was provided".to_string());
    }

    let output = match kind {
        OperationKind::Compress => {
            #[cfg(target_os = "macos")]
            {
                std::process::Command::new("/usr/bin/ditto")
                    .arg("-c")
                    .arg("-k")
                    .arg("--sequesterRsrc")
                    .arg("--keepParent")
                    .args(paths)
                    .arg(destination)
                    .output()
                    .map_err(|error| error.to_string())?
            }
            #[cfg(not(target_os = "macos"))]
            {
                let base = Path::new(&paths[0])
                    .parent()
                    .unwrap_or_else(|| Path::new("."));
                let names = paths
                    .iter()
                    .map(|path| {
                        Path::new(path)
                            .file_name()
                            .map(|name| name.to_string_lossy().to_string())
                            .ok_or_else(|| format!("Invalid archive input: {}", path))
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                std::process::Command::new("zip")
                    .current_dir(base)
                    .arg("-r")
                    .arg(destination)
                    .args(names)
                    .output()
                    .map_err(|error| error.to_string())?
            }
        }
        OperationKind::Extract => {
            fs::create_dir_all(destination).map_err(|error| error.to_string())?;
            #[cfg(target_os = "macos")]
            {
                std::process::Command::new("/usr/bin/ditto")
                    .arg("-x")
                    .arg("-k")
                    .arg(&paths[0])
                    .arg(destination)
                    .output()
                    .map_err(|error| error.to_string())?
            }
            #[cfg(not(target_os = "macos"))]
            {
                let listing = std::process::Command::new("unzip")
                    .arg("-Z1")
                    .arg(&paths[0])
                    .output()
                    .map_err(|error| error.to_string())?;
                if !listing.status.success() {
                    return Err(String::from_utf8_lossy(&listing.stderr).trim().to_string());
                }
                for entry in String::from_utf8_lossy(&listing.stdout).lines() {
                    if Path::new(entry).components().any(|component| {
                        matches!(
                            component,
                            std::path::Component::ParentDir
                                | std::path::Component::RootDir
                                | std::path::Component::Prefix(_)
                        )
                    }) {
                        return Err(format!("Unsafe ZIP entry: {}", entry));
                    }
                }
                std::process::Command::new("unzip")
                    .arg("-o")
                    .arg(&paths[0])
                    .arg("-d")
                    .arg(destination)
                    .output()
                    .map_err(|error| error.to_string())?
            }
        }
        _ => return Err("Unsupported archive operation".to_string()),
    };

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("Archive command exited with {}", output.status)
        } else {
            stderr
        })
    }
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

        if matches!(kind, OperationKind::Copy | OperationKind::Move) {
            ensure_destination_space(&paths, destination.as_deref().unwrap_or_default())?;
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
            persist_snapshot_map(&records);
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

    pub fn start_archive(
        &self,
        app: AppHandle,
        kind: OperationKind,
        paths: Vec<String>,
        destination: String,
    ) -> Result<String, String> {
        if !matches!(kind, OperationKind::Compress | OperationKind::Extract) {
            return Err("Unsupported archive operation".to_string());
        }
        if paths.is_empty() || destination.is_empty() {
            return Err("Archive input and destination are required".to_string());
        }
        if matches!(kind, OperationKind::Compress)
            && paths.iter().any(|path| !Path::new(path).exists())
        {
            return Err("One or more archive inputs do not exist".to_string());
        }
        if matches!(kind, OperationKind::Extract) && !Path::new(&paths[0]).is_file() {
            return Err("The ZIP archive does not exist".to_string());
        }

        let final_destination = unique_archive_path(
            Path::new(&destination),
            matches!(kind, OperationKind::Extract),
        );
        let id = new_operation_id();
        let cancel_requested = Arc::new(AtomicBool::new(false));
        let total_items = if matches!(kind, OperationKind::Compress) {
            paths.len()
        } else {
            1
        };
        let snapshot = OperationSnapshot {
            id: id.clone(),
            kind,
            status: OperationStatus::Queued,
            total_items,
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
            persist_snapshot_map(&records);
        }
        self.emit(&app, &snapshot);
        {
            let mut queue = self.queue.lock().map_err(|e| e.to_string())?;
            queue.push_back(QueueJob::Archive {
                id: id.clone(),
                kind,
                paths,
                destination: final_destination.to_string_lossy().to_string(),
            });
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
                    QueueJob::Archive {
                        id,
                        kind,
                        paths,
                        destination,
                    } => self.run_archive_job(&app, id, kind, paths, destination),
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

            let item_bytes = path_bytes(Path::new(path));

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
                    if let Err(error) = retry_operation(|| {
                        delete_to_trash(destination.to_string_lossy().to_string())
                    }) {
                        self.update(app, &job.id, |snapshot| {
                            snapshot.failed_items += 1;
                            snapshot.errors.push(format!(
                                "{}: {}",
                                redact_path(path),
                                redact_error(&error)
                            ));
                            snapshot.current_item = None;
                        });
                        continue;
                    }
                }
            }

            let mut reports_byte_progress = false;
            let result = match job.kind {
                OperationKind::Copy => retry_operation(|| {
                    reports_byte_progress = true;
                    let mut pending_bytes = 0_u64;
                    let mut last_emit = std::time::Instant::now();
                    let result = copy_file_resumable(
                        path.clone(),
                        job.destination.clone().unwrap_or_default(),
                        |delta| {
                            if cancel_requested.load(Ordering::Acquire) {
                                return false;
                            }
                            pending_bytes = pending_bytes.saturating_add(delta);
                            if last_emit.elapsed() >= std::time::Duration::from_millis(100) {
                                let increment = pending_bytes;
                                pending_bytes = 0;
                                self.update(app, &job.id, |snapshot| {
                                    snapshot.completed_bytes =
                                        snapshot.completed_bytes.saturating_add(increment);
                                });
                                last_emit = std::time::Instant::now();
                            }
                            true
                        },
                    );
                    if pending_bytes > 0 {
                        let increment = pending_bytes;
                        self.update(app, &job.id, |snapshot| {
                            snapshot.completed_bytes =
                                snapshot.completed_bytes.saturating_add(increment);
                        });
                    }
                    result
                })
                .map(Some),
                OperationKind::Move => retry_operation(|| {
                    move_file(path.clone(), job.destination.clone().unwrap_or_default())
                })
                .map(Some),
                OperationKind::Delete => {
                    retry_operation(|| delete_to_trash(path.clone()).map(|_| ())).map(|_| None)
                }
                OperationKind::Compress | OperationKind::Extract => {
                    Err("Archive operation was routed to the file worker".to_string())
                }
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
                            OperationKind::Compress | OperationKind::Extract => {
                                unreachable!("archive operation was routed to the file worker")
                            }
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
                        if !reports_byte_progress {
                            snapshot.completed_bytes =
                                snapshot.completed_bytes.saturating_add(item_bytes);
                        }
                        snapshot.current_item = None;
                    });
                }
                Err(error) => {
                    self.update(app, &job.id, |snapshot| {
                        snapshot.failed_items += 1;
                        snapshot.errors.push(format!(
                            "{}: {}",
                            redact_path(path),
                            redact_error(&error)
                        ));
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

    fn run_archive_job(
        &self,
        app: &AppHandle,
        id: String,
        kind: OperationKind,
        paths: Vec<String>,
        destination: String,
    ) {
        let Some(cancel_requested) = self.cancel_flag(&id) else {
            return;
        };
        if cancel_requested.load(Ordering::Acquire) {
            self.finish(app, &id, OperationStatus::Cancelled);
            return;
        }

        self.update(app, &id, |snapshot| {
            snapshot.status = OperationStatus::Running;
            snapshot.current_item = paths.first().cloned();
        });

        let result = run_archive_command(kind, &paths, &destination);
        match result {
            Ok(()) => {
                if let Some(parent) = Path::new(&destination).parent() {
                    let _ = app.emit("dir-change", parent.to_string_lossy().to_string());
                }
                self.update(app, &id, |snapshot| {
                    snapshot.completed_items = snapshot.total_items;
                    snapshot.completed_bytes = snapshot.total_bytes;
                    snapshot.current_item = None;
                });
                self.finish(app, &id, OperationStatus::Completed);
            }
            Err(error) => {
                self.update(app, &id, |snapshot| {
                    snapshot.failed_items = snapshot.total_items;
                    snapshot.errors.push(redact_error(&error));
                    snapshot.current_item = None;
                });
                self.finish(app, &id, OperationStatus::Failed);
            }
        }
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
                        snapshot.errors.push(format!(
                            "Undo {}: {}",
                            redact_path(&display_path),
                            redact_error(&error)
                        ));
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
        let (snapshot, should_persist) = {
            let Ok(mut records) = self.records.lock() else {
                return;
            };
            let Some(record) = records.get_mut(id) else {
                return;
            };
            let previous_status = record.snapshot.status;
            update(&mut record.snapshot);
            record.snapshot.cancel_requested = record.cancel_requested.load(Ordering::Acquire);
            let should_persist = previous_status != record.snapshot.status
                || record.snapshot.finished_at.is_some()
                || record.snapshot.completed_items % 25 == 0;
            (record.snapshot.clone(), should_persist)
        };
        if should_persist {
            if let Ok(records) = self.records.lock() {
                persist_snapshot_map(&records);
            }
        }
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
        if let Ok(records) = self.records.lock() {
            persist_snapshot_map(&records);
        }
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
        if let Ok(records) = self.records.lock() {
            persist_snapshot_map(&records);
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
            persist_snapshot_map(&records);
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
pub fn start_compress_operation(
    app: AppHandle,
    manager: State<'_, OperationManager>,
    paths: Vec<String>,
    dest_path: String,
) -> Result<String, String> {
    manager.start_archive(app, OperationKind::Compress, paths, dest_path)
}

#[tauri::command]
pub fn start_extract_operation(
    app: AppHandle,
    manager: State<'_, OperationManager>,
    archive_path: String,
    dest_dir: String,
) -> Result<String, String> {
    manager.start_archive(app, OperationKind::Extract, vec![archive_path], dest_dir)
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
