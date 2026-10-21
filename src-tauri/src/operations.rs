use crate::commands::fs::{
    copy_path_resumable_with_ready, delete_to_trash, get_disk_space, move_path_resumable,
    move_path_resumable_with_ready, partial_path_for, path_exists, paths_equivalent,
    rename_without_replace,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

static NEXT_OPERATION_ID: AtomicU64 = AtomicU64::new(1);
static NEXT_STATE_TEMP_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    KeepBoth,
    Replace,
    Skip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationErrorCode {
    Conflict,
    SourceChanged,
    InsufficientSpace,
    PermissionDenied,
    VolumeUnavailable,
    Cancelled,
    Recovery,
    Filesystem,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationErrorDetail {
    pub code: OperationErrorCode,
    pub message: String,
}

fn classify_operation_error(message: &str) -> OperationErrorCode {
    let lower = message.to_ascii_lowercase();
    if lower.contains("source changed") || lower.contains("source was changed") {
        OperationErrorCode::SourceChanged
    } else if lower.contains("no space left")
        || lower.contains("disk full")
        || lower.contains("not enough space")
    {
        OperationErrorCode::InsufficientSpace
    } else if lower.contains("permission denied") || lower.contains("operation not permitted") {
        OperationErrorCode::PermissionDenied
    } else if lower.contains("volume offline")
        || lower.contains("not mounted")
        || lower.contains("no such device")
    {
        OperationErrorCode::VolumeUnavailable
    } else if lower.contains("cancel") {
        OperationErrorCode::Cancelled
    } else if lower.contains("undo")
        || lower.contains("recovery")
        || lower.contains("ownership")
        || lower.contains("identity")
    {
        OperationErrorCode::Recovery
    } else if lower.contains("conflict")
        || lower.contains("already exists")
        || lower.contains("changed after")
        || lower.contains("changed and was preserved")
        || lower.contains("destination appeared")
        || lower.contains("cannot verify")
    {
        OperationErrorCode::Conflict
    } else {
        OperationErrorCode::Filesystem
    }
}

fn append_operation_error(snapshot: &mut OperationSnapshot, message: String) {
    snapshot.error_details.push(OperationErrorDetail {
        code: classify_operation_error(&message),
        message: message.clone(),
    });
    snapshot.errors.push(message);
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
    #[serde(default)]
    pub error_details: Vec<OperationErrorDetail>,
    pub cancel_requested: bool,
    pub undo_status: UndoStatus,
    #[serde(default)]
    pub retryable: bool,
    pub started_at: u64,
    pub finished_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum UndoAction {
    PendingCopy {
        source: String,
        path: String,
        #[serde(default)]
        partial_path: String,
        #[serde(default)]
        identity: Option<SourceIdentity>,
    },
    PendingMove {
        from: String,
        to: String,
        #[serde(default)]
        source_identity: Option<SourceIdentity>,
        #[serde(default)]
        target_identity: Option<SourceIdentity>,
    },
    PendingArchiveOutput {
        path: String,
        partial_path: String,
        #[serde(default)]
        identity: Option<SourceIdentity>,
        #[serde(default)]
        ready: bool,
    },
    RemoveCreatedPath {
        path: String,
        #[serde(default)]
        identity: Option<SourceIdentity>,
    },
    MoveBack {
        from: String,
        to: String,
        #[serde(default)]
        identity: Option<SourceIdentity>,
    },
    RestoreBackup {
        backup_path: String,
        original_path: String,
        #[serde(default)]
        identity: Option<SourceIdentity>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OperationRequest {
    kind: OperationKind,
    paths: Vec<String>,
    destination: Option<String>,
    conflict_policy: ConflictPolicy,
    #[serde(default)]
    source_identities: Vec<Option<SourceIdentity>>,
    #[serde(default)]
    target_paths: Vec<Option<String>>,
    #[serde(default)]
    started_items: Vec<bool>,
    #[serde(default)]
    resolved_items: Vec<bool>,
}

impl OperationRequest {
    fn normalize(&mut self) {
        self.source_identities.resize(self.paths.len(), None);
        self.target_paths.resize(self.paths.len(), None);
        self.started_items.resize(self.paths.len(), false);
        self.resolved_items.resize(self.paths.len(), false);
    }

    fn has_unresolved_items(&self) -> bool {
        self.resolved_items.iter().any(|resolved| !resolved)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SourceIdentity {
    kind: u8,
    len: u64,
    modified_nanos: Option<u64>,
    #[serde(default)]
    device: Option<u64>,
    #[serde(default)]
    inode: Option<u64>,
}

struct OperationRecord {
    snapshot: OperationSnapshot,
    cancel_requested: Arc<AtomicBool>,
    undo_actions: Vec<UndoAction>,
    request: Option<OperationRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedOperationRecord {
    snapshot: OperationSnapshot,
    #[serde(default)]
    undo_actions: Vec<UndoAction>,
    #[serde(default)]
    request: Option<OperationRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum PersistedOperationEntry {
    Current(PersistedOperationRecord),
    Legacy(OperationSnapshot),
}

enum QueueJob {
    Operation {
        id: String,
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

fn persist_record_map(records: &HashMap<String, OperationRecord>) -> Result<(), String> {
    persist_record_map_to_path(records, &operation_state_path())
}

fn persist_record_map_to_path(
    records: &HashMap<String, OperationRecord>,
    path: &Path,
) -> Result<(), String> {
    let persisted: Vec<PersistedOperationRecord> = records
        .values()
        .map(|record| {
            let mut snapshot = record.snapshot.clone();
            snapshot.current_item = snapshot.current_item.as_deref().map(redact_path);
            PersistedOperationRecord {
                snapshot,
                undo_actions: record.undo_actions.clone(),
                request: record.request.clone(),
            }
        })
        .collect();
    let payload = serde_json::to_vec_pretty(&persisted).map_err(|error| error.to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid operation state path".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!(
        ".operations.json.tmp-{}-{}",
        std::process::id(),
        NEXT_STATE_TEMP_ID.fetch_add(1, Ordering::Relaxed)
    ));
    let write_result = (|| -> Result<(), String> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp).map_err(|error| error.to_string())?;
        file.write_all(&payload)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        fs::rename(&temp, path).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        if let Ok(directory) = fs::File::open(parent) {
            // Some mounted filesystems do not support fsync on directories.
            // The state file itself is already synced and atomically renamed.
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write_result?;
    Ok(())
}

fn operation_record_from_persisted(mut persisted: PersistedOperationRecord) -> OperationRecord {
    let known_error_count = persisted.snapshot.error_details.len();
    if known_error_count < persisted.snapshot.errors.len() {
        let missing = persisted.snapshot.errors[known_error_count..].to_vec();
        for message in missing {
            persisted.snapshot.error_details.push(OperationErrorDetail {
                code: classify_operation_error(&message),
                message,
            });
        }
    }
    if let Some(request) = persisted.request.as_mut() {
        request.normalize();
    }

    let operation_was_interrupted = matches!(
        persisted.snapshot.status,
        OperationStatus::Queued | OperationStatus::Running
    );
    if operation_was_interrupted {
        persisted.snapshot.finished_at = Some(now_seconds());
        if persisted
            .request
            .as_ref()
            .is_some_and(|request| !request.has_unresolved_items())
        {
            persisted.snapshot.status = OperationStatus::Completed;
            persisted.snapshot.current_item = None;
        } else {
            persisted.snapshot.status = OperationStatus::Failed;
            append_operation_error(
                &mut persisted.snapshot,
                "Operation was interrupted by an application restart. Retry to continue from the durable partial copy."
                    .to_string(),
            );
        }
    }

    if matches!(
        persisted.snapshot.undo_status,
        UndoStatus::Queued | UndoStatus::Running
    ) {
        persisted.snapshot.undo_status = UndoStatus::Failed;
        append_operation_error(
            &mut persisted.snapshot,
            "Undo was interrupted by an application restart. Retry undo to continue.".to_string(),
        );
    } else if persisted.undo_actions.is_empty()
        && matches!(
            persisted.snapshot.undo_status,
            UndoStatus::Available | UndoStatus::Failed
        )
    {
        // Legacy state files only persisted display snapshots. Never expose an
        // Undo button when the actual recovery actions are unavailable.
        persisted.snapshot.undo_status = UndoStatus::None;
    } else if operation_was_interrupted
        && !persisted.undo_actions.is_empty()
        && !matches!(persisted.snapshot.undo_status, UndoStatus::Completed)
    {
        persisted.snapshot.undo_status = UndoStatus::Available;
    }

    persisted.snapshot.cancel_requested = false;
    persisted.snapshot.retryable = matches!(
        persisted.snapshot.status,
        OperationStatus::Failed | OperationStatus::Cancelled
    ) && persisted
        .request
        .as_ref()
        .is_some_and(OperationRequest::has_unresolved_items);

    OperationRecord {
        snapshot: persisted.snapshot,
        cancel_requested: Arc::new(AtomicBool::new(false)),
        undo_actions: persisted.undo_actions,
        request: persisted.request,
    }
}

fn load_operation_records(payload: &[u8]) -> Result<HashMap<String, OperationRecord>, String> {
    let entries = serde_json::from_slice::<Vec<PersistedOperationEntry>>(payload)
        .map_err(|error| error.to_string())?;
    Ok(entries
        .into_iter()
        .map(|entry| {
            let persisted = match entry {
                PersistedOperationEntry::Current(record) => record,
                PersistedOperationEntry::Legacy(snapshot) => PersistedOperationRecord {
                    snapshot,
                    undo_actions: Vec::new(),
                    request: None,
                },
            };
            let record = operation_record_from_persisted(persisted);
            (record.snapshot.id.clone(), record)
        })
        .collect())
}

impl Default for OperationManager {
    fn default() -> Self {
        let records = fs::read(operation_state_path())
            .ok()
            .and_then(|payload| match load_operation_records(&payload) {
                Ok(records) => Some(records),
                Err(error) => {
                    eprintln!("Failed to load operation recovery state: {}", error);
                    None
                }
            })
            .unwrap_or_default();
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
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("op-{}-{}-{}", nanos, std::process::id(), sequence)
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

fn source_identity(path: &Path) -> Option<SourceIdentity> {
    let metadata = fs::symlink_metadata(path).ok()?;
    let file_type = metadata.file_type();
    let kind = if file_type.is_symlink() {
        3
    } else if metadata.is_dir() {
        2
    } else if metadata.is_file() {
        1
    } else {
        4
    };
    let modified_nanos = metadata.modified().ok().and_then(|modified| {
        modified
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|duration| duration.as_nanos().min(u64::MAX as u128) as u64)
    });
    #[cfg(unix)]
    let (device, inode) = {
        use std::os::unix::fs::MetadataExt;
        (Some(metadata.dev()), Some(metadata.ino()))
    };
    #[cfg(not(unix))]
    let (device, inode) = (None, None);

    Some(SourceIdentity {
        kind,
        len: metadata.len(),
        modified_nanos,
        device,
        inode,
    })
}

fn source_identity_matches(path: &Path, expected: &SourceIdentity) -> bool {
    source_identity(path).as_ref() == Some(expected)
}

fn object_identity_matches(path: &Path, expected: &SourceIdentity) -> bool {
    let Some(actual) = source_identity(path) else {
        return false;
    };
    object_identities_match(expected, &actual)
}

fn object_identities_match(expected: &SourceIdentity, actual: &SourceIdentity) -> bool {
    match (expected.device, expected.inode, actual.device, actual.inode) {
        (Some(expected_device), Some(expected_inode), Some(actual_device), Some(actual_inode)) => {
            expected.kind == actual.kind
                && expected_device == actual_device
                && expected_inode == actual_inode
        }
        _ => actual == expected,
    }
}

fn verify_created_path_identity(
    path: &Path,
    expected: Option<&SourceIdentity>,
) -> Result<bool, String> {
    if !path_exists(path) {
        return Ok(false);
    }
    if expected.is_some_and(|identity| source_identity_matches(path, identity)) {
        return Ok(true);
    }
    Err(format!(
        "The created item changed after the operation; undo stopped and preserved it: {}",
        path.display()
    ))
}

fn same_undo_intent(left: &UndoAction, right: &UndoAction) -> bool {
    match (left, right) {
        (
            UndoAction::PendingCopy {
                source: left_source,
                path: left_path,
                ..
            },
            UndoAction::PendingCopy {
                source: right_source,
                path: right_path,
                ..
            },
        ) => left_source == right_source && left_path == right_path,
        (
            UndoAction::PendingMove {
                from: left_from,
                to: left_to,
                ..
            },
            UndoAction::PendingMove {
                from: right_from,
                to: right_to,
                ..
            },
        ) => left_from == right_from && left_to == right_to,
        (
            UndoAction::PendingArchiveOutput {
                path: left_path,
                partial_path: left_partial,
                ..
            },
            UndoAction::PendingArchiveOutput {
                path: right_path,
                partial_path: right_partial,
                ..
            },
        ) => left_path == right_path && left_partial == right_partial,
        _ => left == right,
    }
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

fn operation_collision_key(path: &Path) -> String {
    let value = path.to_string_lossy().to_string();
    #[cfg(any(target_os = "macos", windows))]
    {
        value.to_lowercase()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        value
    }
}

fn unique_operation_path(base: &Path) -> PathBuf {
    let is_available =
        |candidate: &Path| !path_exists(candidate) && !path_exists(&partial_path_for(candidate));
    if is_available(base) {
        return base.to_path_buf();
    }

    let stem = base.file_stem().unwrap_or_default().to_string_lossy();
    let extension = base
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default();
    let mut counter = 1_u64;
    loop {
        let candidate = base.with_file_name(format!("{} {}{}", stem, counter, extension));
        if is_available(&candidate) {
            return candidate;
        }
        counter += 1;
    }
}

fn new_file_request(
    kind: OperationKind,
    paths: Vec<String>,
    destination: Option<String>,
    conflict_policy: ConflictPolicy,
) -> Result<OperationRequest, String> {
    let source_identities = paths
        .iter()
        .map(|path| source_identity(Path::new(path)))
        .collect();
    let target_paths = if matches!(kind, OperationKind::Copy | OperationKind::Move) {
        let destination = destination
            .as_deref()
            .ok_or_else(|| "A destination directory is required".to_string())?;
        paths
            .iter()
            .map(|path| {
                let base = destination_for(path, destination)?;
                if matches!(conflict_policy, ConflictPolicy::KeepBoth) && base != Path::new(path) {
                    Ok(Some(
                        unique_operation_path(&base).to_string_lossy().to_string(),
                    ))
                } else {
                    Ok(Some(base.to_string_lossy().to_string()))
                }
            })
            .collect::<Result<Vec<_>, String>>()?
    } else {
        vec![None; paths.len()]
    };

    if matches!(conflict_policy, ConflictPolicy::Replace) {
        let mut targets = std::collections::HashSet::new();
        for target in target_paths.iter().flatten() {
            if !targets.insert(operation_collision_key(Path::new(target))) {
                return Err(format!(
                    "Multiple sources would replace the same destination: {}. Use Keep Both or rename the sources first.",
                    target
                ));
            }
        }
    }

    Ok(OperationRequest {
        kind,
        source_identities,
        started_items: vec![false; paths.len()],
        resolved_items: vec![false; paths.len()],
        paths,
        destination,
        conflict_policy,
        target_paths,
    })
}

fn new_archive_request(
    kind: OperationKind,
    paths: Vec<String>,
    destination: String,
) -> OperationRequest {
    let source_identities = paths
        .iter()
        .map(|path| source_identity(Path::new(path)))
        .collect();
    OperationRequest {
        kind,
        source_identities,
        target_paths: vec![Some(destination); paths.len()],
        started_items: vec![false; paths.len()],
        resolved_items: vec![false; paths.len()],
        paths,
        destination: None,
        conflict_policy: ConflictPolicy::KeepBoth,
    }
}

fn backup_path_for(original: &Path, operation_id: &str, item_index: usize) -> PathBuf {
    let parent = original.parent().unwrap_or_else(|| Path::new("."));
    let base = parent.join(format!(
        ".imageexplorer-replaced-{}-{}",
        operation_id, item_index
    ));
    unique_operation_path(&base)
}

fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(());
    };
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else {
        fs::remove_file(path).map_err(|error| error.to_string())
    }
}

fn restore_backup(
    backup_path: &str,
    original_path: &str,
    expected_identity: Option<&SourceIdentity>,
) -> Result<(), String> {
    let backup = Path::new(backup_path);
    let original = Path::new(original_path);
    if !path_exists(backup) {
        return if path_exists(original)
            && expected_identity.is_some_and(|identity| source_identity_matches(original, identity))
        {
            Ok(())
        } else if path_exists(original) {
            Err(format!(
                "The original target changed before its recovery backup was restored: {}",
                original_path
            ))
        } else {
            Err(format!("Recovery backup is missing: {}", backup_path))
        };
    }
    if !expected_identity.is_some_and(|identity| source_identity_matches(backup, identity)) {
        return Err(format!(
            "The recovery backup changed and was preserved: {}",
            backup_path
        ));
    }
    if path_exists(original) {
        return Err(format!(
            "Cannot restore the replaced item because the target exists: {}",
            original_path
        ));
    }
    rename_without_replace(backup, original).map_err(|error| error.to_string())
}

fn discard_backup_to_trash(
    backup_path: &str,
    original_path: &str,
    expected_identity: Option<&SourceIdentity>,
) -> Result<(), String> {
    let backup = Path::new(backup_path);
    let original = Path::new(original_path);
    if !path_exists(backup) {
        return Ok(());
    }
    if !expected_identity.is_some_and(|identity| source_identity_matches(backup, identity)) {
        return Err(format!(
            "The recovery backup changed and was preserved: {}",
            backup_path
        ));
    }
    if !path_exists(original) {
        return rename_without_replace(backup, original).map_err(|error| error.to_string());
    }

    let parent = original
        .parent()
        .ok_or_else(|| format!("Invalid original path: {}", original_path))?;
    let stem = original.file_stem().unwrap_or_default().to_string_lossy();
    let extension = original
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default();
    let discard_path =
        unique_operation_path(&parent.join(format!("{} (replaced){}", stem, extension)));
    rename_without_replace(backup, &discard_path).map_err(|error| error.to_string())?;
    if let Err(error) = delete_to_trash(discard_path.to_string_lossy().to_string()) {
        let _ = rename_without_replace(&discard_path, backup);
        return Err(error);
    }
    Ok(())
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
            if !path_exists(&target) {
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
    let is_available =
        |candidate: &Path| !path_exists(candidate) && !path_exists(&partial_path_for(candidate));
    if is_available(base) {
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
        if is_available(&candidate) {
            return candidate;
        }
        counter += 1;
    }
}

fn run_cancellable_process(
    command: &mut Command,
    cancel_requested: &AtomicBool,
) -> Result<(), String> {
    let mut child = command
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    let stderr_reader = child.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut stderr = String::new();
            let _ = pipe.read_to_string(&mut stderr);
            stderr
        })
    });

    loop {
        if cancel_requested.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            if let Some(reader) = stderr_reader {
                let _ = reader.join();
            }
            return Err("Operation cancelled".to_string());
        }

        match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) => {
                let stderr = stderr_reader
                    .and_then(|reader| reader.join().ok())
                    .unwrap_or_default();
                return if status.success() {
                    Ok(())
                } else if stderr.trim().is_empty() {
                    Err(format!("Archive command exited with {}", status))
                } else {
                    Err(stderr.trim().to_string())
                };
            }
            None => std::thread::sleep(std::time::Duration::from_millis(50)),
        }
    }
}

fn zip_entry_is_safe(entry: &str) -> bool {
    let normalized = entry.replace('\\', "/");
    if normalized.starts_with('/') {
        return false;
    }
    let mut components = normalized.split('/');
    if components.next().is_some_and(|component| {
        let bytes = component.as_bytes();
        bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
    }) {
        return false;
    }
    !normalized
        .split('/')
        .any(|component| matches!(component, ".."))
}

fn validate_zip_entries(archive: &str, cancel_requested: &AtomicBool) -> Result<(), String> {
    if cancel_requested.load(Ordering::Acquire) {
        return Err("Operation cancelled".to_string());
    }
    #[cfg(target_os = "macos")]
    let unzip = "/usr/bin/unzip";
    #[cfg(not(target_os = "macos"))]
    let unzip = "unzip";
    let listing = Command::new(unzip)
        .arg("-Z1")
        .arg(archive)
        .output()
        .map_err(|error| error.to_string())?;
    if !listing.status.success() {
        return Err(String::from_utf8_lossy(&listing.stderr).trim().to_string());
    }
    if cancel_requested.load(Ordering::Acquire) {
        return Err("Operation cancelled".to_string());
    }
    for entry in String::from_utf8_lossy(&listing.stdout).lines() {
        if !zip_entry_is_safe(entry) {
            return Err(format!("Unsafe ZIP entry: {}", entry));
        }
    }
    Ok(())
}

fn run_archive_command(
    kind: OperationKind,
    paths: &[String],
    destination: &str,
    cancel_requested: &AtomicBool,
) -> Result<(), String> {
    if paths.is_empty() {
        return Err("No archive input was provided".to_string());
    }
    if cancel_requested.load(Ordering::Acquire) {
        return Err("Operation cancelled".to_string());
    }

    match kind {
        OperationKind::Compress => {
            #[cfg(target_os = "macos")]
            {
                let mut command = Command::new("/usr/bin/ditto");
                command
                    .arg("-c")
                    .arg("-k")
                    .arg("--sequesterRsrc")
                    .arg("--keepParent")
                    .args(paths)
                    .arg(destination);
                run_cancellable_process(&mut command, cancel_requested)
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
                let mut command = Command::new("zip");
                command
                    .current_dir(base)
                    .arg("-r")
                    .arg(destination)
                    .args(names);
                run_cancellable_process(&mut command, cancel_requested)
            }
        }
        OperationKind::Extract => {
            validate_zip_entries(&paths[0], cancel_requested)?;
            fs::create_dir_all(destination).map_err(|error| error.to_string())?;
            #[cfg(target_os = "macos")]
            {
                let mut command = Command::new("/usr/bin/ditto");
                command.arg("-x").arg("-k").arg(&paths[0]).arg(destination);
                run_cancellable_process(&mut command, cancel_requested)
            }
            #[cfg(not(target_os = "macos"))]
            {
                let mut command = Command::new("unzip");
                command.arg("-o").arg(&paths[0]).arg("-d").arg(destination);
                run_cancellable_process(&mut command, cancel_requested)
            }
        }
        _ => Err("Unsupported archive operation".to_string()),
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

        let total_items = paths.len();
        let total_bytes = source_bytes(&paths);
        let conflict_policy = conflict_policy.unwrap_or(ConflictPolicy::KeepBoth);
        let request = new_file_request(kind, paths, destination, conflict_policy)?;

        let id = new_operation_id();
        let cancel_requested = Arc::new(AtomicBool::new(false));
        let snapshot = OperationSnapshot {
            id: id.clone(),
            kind,
            status: OperationStatus::Queued,
            total_items,
            completed_items: 0,
            failed_items: 0,
            skipped_items: 0,
            total_bytes,
            completed_bytes: 0,
            current_item: None,
            errors: Vec::new(),
            error_details: Vec::new(),
            cancel_requested: false,
            undo_status: UndoStatus::None,
            retryable: false,
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
                    request: Some(request),
                },
            );
            if let Err(error) = persist_record_map(&records) {
                records.remove(&id);
                return Err(format!(
                    "Failed to persist operation recovery state: {}",
                    error
                ));
            }
        }
        self.emit(&app, &snapshot);

        {
            let mut queue = self.queue.lock().map_err(|e| e.to_string())?;
            queue.push_back(QueueJob::Operation { id: id.clone() });
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
            && paths.iter().any(|path| !path_exists(Path::new(path)))
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
            error_details: Vec::new(),
            cancel_requested: false,
            undo_status: UndoStatus::None,
            retryable: false,
            started_at: now_seconds(),
            finished_at: None,
        };
        let request =
            new_archive_request(kind, paths, final_destination.to_string_lossy().to_string());
        {
            let mut records = self.records.lock().map_err(|e| e.to_string())?;
            records.insert(
                id.clone(),
                OperationRecord {
                    snapshot: snapshot.clone(),
                    cancel_requested,
                    undo_actions: Vec::new(),
                    request: Some(request),
                },
            );
            if let Err(error) = persist_record_map(&records) {
                records.remove(&id);
                return Err(format!(
                    "Failed to persist operation recovery state: {}",
                    error
                ));
            }
        }
        self.emit(&app, &snapshot);
        {
            let mut queue = self.queue.lock().map_err(|e| e.to_string())?;
            queue.push_back(QueueJob::Operation { id: id.clone() });
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
                    QueueJob::Operation { id } => {
                        if let Some(request) = self.request(&id) {
                            if matches!(
                                request.kind,
                                OperationKind::Compress | OperationKind::Extract
                            ) {
                                self.run_archive_job(&app, id, request);
                            } else {
                                self.run_job(&app, id, request);
                            }
                        }
                    }
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

    fn run_job(&self, app: &AppHandle, id: String, request: OperationRequest) {
        let Some(cancel_requested) = self.cancel_flag(&id) else {
            return;
        };

        if cancel_requested.load(Ordering::Acquire) {
            self.finish(app, &id, OperationStatus::Cancelled);
            return;
        }

        self.update(app, &id, |snapshot| {
            snapshot.status = OperationStatus::Running;
            snapshot.retryable = false;
        });

        for (item_index, path) in request.paths.iter().enumerate() {
            if request
                .resolved_items
                .get(item_index)
                .copied()
                .unwrap_or(false)
            {
                continue;
            }
            if cancel_requested.load(Ordering::Acquire) {
                self.finish(app, &id, OperationStatus::Cancelled);
                return;
            }

            self.update(app, &id, |snapshot| {
                snapshot.current_item = Some(path.clone());
            });

            let item_bytes = path_bytes(Path::new(path));
            if matches!(request.kind, OperationKind::Move)
                && !request
                    .source_identities
                    .get(item_index)
                    .and_then(Option::as_ref)
                    .is_some()
            {
                self.fail_resolved_item(
                    app,
                    &id,
                    item_index,
                    path,
                    "Could not record the source identity; the item was not moved",
                );
                continue;
            }
            if matches!(request.kind, OperationKind::Delete)
                && path_exists(Path::new(path))
                && !request
                    .source_identities
                    .get(item_index)
                    .and_then(Option::as_ref)
                    .is_some_and(|identity| source_identity_matches(Path::new(path), identity))
            {
                self.fail_resolved_item(
                    app,
                    &id,
                    item_index,
                    path,
                    "The item changed after deletion was queued; it was not moved to Trash",
                );
                continue;
            }
            let destination_path = match self.prepare_item_target(&id, item_index, &request) {
                Ok(path) => path,
                Err(error) => {
                    self.fail_item(app, &id, path, &error);
                    continue;
                }
            };

            if matches!(request.kind, OperationKind::Copy | OperationKind::Move)
                && destination_path
                    .as_deref()
                    .is_some_and(|destination| Path::new(destination) == Path::new(path))
            {
                self.skip_item(app, &id, item_index);
                continue;
            }

            if destination_path
                .as_deref()
                .is_some_and(|destination| path_exists(Path::new(destination)))
                && matches!(request.conflict_policy, ConflictPolicy::Skip)
            {
                self.skip_item(app, &id, item_index);
                continue;
            }

            let item_was_started = request
                .started_items
                .get(item_index)
                .copied()
                .unwrap_or(false);
            if let Err(error) = self.mark_item_started(&id, item_index) {
                self.fail_item(app, &id, path, &error);
                continue;
            }

            let replacement = if matches!(request.conflict_policy, ConflictPolicy::Replace) {
                match destination_path.as_deref() {
                    Some(destination) => match self.stage_replacement(&id, item_index, destination)
                    {
                        Ok(action) => action,
                        Err(error) => {
                            self.fail_item(app, &id, path, &error);
                            continue;
                        }
                    },
                    None => None,
                }
            } else {
                None
            };

            let (pending_undo_action, final_undo_action) =
                match (request.kind, destination_path.as_deref()) {
                    (OperationKind::Copy, Some(destination)) => (
                        Some(UndoAction::PendingCopy {
                            source: path.clone(),
                            path: destination.to_string(),
                            partial_path: partial_path_for(Path::new(destination))
                                .to_string_lossy()
                                .to_string(),
                            identity: None,
                        }),
                        Some(UndoAction::RemoveCreatedPath {
                            path: destination.to_string(),
                            identity: None,
                        }),
                    ),
                    (OperationKind::Move, Some(destination)) => (
                        Some(UndoAction::PendingMove {
                            from: path.clone(),
                            to: destination.to_string(),
                            source_identity: request
                                .source_identities
                                .get(item_index)
                                .cloned()
                                .flatten(),
                            target_identity: None,
                        }),
                        Some(UndoAction::MoveBack {
                            from: path.clone(),
                            to: destination.to_string(),
                            identity: None,
                        }),
                    ),
                    _ => (None, None),
                };
            let pending_was_persisted = pending_undo_action
                .as_ref()
                .is_some_and(|action| self.has_undo_intent(&id, action));
            if let Some(action) = pending_undo_action.as_ref() {
                if let Err(error) = self.stage_undo_intent(&id, action) {
                    let rollback_error = replacement.as_ref().and_then(|replacement| {
                        self.rollback_replacement(
                            &id,
                            destination_path.as_deref(),
                            replacement,
                            None,
                        )
                        .err()
                    });
                    let error = rollback_error
                        .map(|rollback| format!("{}; recovery rollback: {}", error, rollback))
                        .unwrap_or(error);
                    self.fail_item(app, &id, path, &error);
                    continue;
                }
            }

            if request.kind == OperationKind::Move
                && path_exists(Path::new(path))
                && request
                    .source_identities
                    .get(item_index)
                    .and_then(Option::as_ref)
                    .is_some_and(|identity| !source_identity_matches(Path::new(path), identity))
            {
                self.fail_resolved_item(
                    app,
                    &id,
                    item_index,
                    path,
                    "The item changed after the move was queued; it was not moved",
                );
                continue;
            }

            if let Some(UndoAction::PendingCopy {
                partial_path,
                identity,
                ..
            }) = pending_undo_action
                .as_ref()
                .and_then(|action| self.stored_undo_intent(&id, action))
            {
                if path_exists(Path::new(&partial_path))
                    && identity.as_ref().is_none_or(|expected| {
                        !object_identity_matches(Path::new(&partial_path), expected)
                    })
                {
                    self.fail_resolved_item(
                        app,
                        &id,
                        item_index,
                        &partial_path,
                        "The copy staging file is not owned by this operation; it was preserved",
                    );
                    continue;
                }
            }
            if let Some(UndoAction::PendingMove {
                to,
                target_identity,
                ..
            }) = pending_undo_action
                .as_ref()
                .and_then(|action| self.stored_undo_intent(&id, action))
            {
                let partial_path = partial_path_for(Path::new(&to));
                if path_exists(&partial_path)
                    && target_identity
                        .as_ref()
                        .is_none_or(|expected| !object_identity_matches(&partial_path, expected))
                {
                    self.fail_resolved_item(
                        app,
                        &id,
                        item_index,
                        &partial_path.to_string_lossy(),
                        "The move staging file is not owned by this operation; it was preserved",
                    );
                    continue;
                }
            }

            let mut reports_byte_progress = false;
            let mut copy_output_identity: Option<SourceIdentity> = None;
            let result = match request.kind {
                OperationKind::Copy => retry_operation(|| {
                    copy_output_identity = None;
                    let mut pending_bytes = 0_u64;
                    let mut last_emit = std::time::Instant::now();
                    let pending = pending_undo_action
                        .as_ref()
                        .expect("copy operation should have a recovery intent");
                    let result = copy_path_resumable_with_ready(
                        path.clone(),
                        destination_path.clone().unwrap_or_default(),
                        item_was_started && pending_was_persisted,
                        |delta| {
                            reports_byte_progress = true;
                            pending_bytes = pending_bytes.saturating_add(delta);
                            let cancelled = cancel_requested.load(Ordering::Acquire);
                            if cancelled
                                || last_emit.elapsed() >= std::time::Duration::from_millis(100)
                            {
                                let increment = pending_bytes;
                                pending_bytes = 0;
                                self.update(app, &id, |snapshot| {
                                    snapshot.completed_bytes = snapshot
                                        .completed_bytes
                                        .saturating_add(increment)
                                        .min(snapshot.total_bytes);
                                });
                                last_emit = std::time::Instant::now();
                            }
                            !cancelled
                        },
                        |ready_path, was_preexisting| {
                            let stored = self.stored_undo_intent(&id, pending);
                            if destination_path
                                .as_deref()
                                .is_some_and(|destination| Path::new(destination) == ready_path)
                                && was_preexisting
                            {
                                let expected = match stored.as_ref() {
                                    Some(UndoAction::PendingCopy {
                                        identity: Some(identity),
                                        ..
                                    }) => identity,
                                    _ => {
                                        return Err(format!(
                                            "Cannot verify ownership of the existing copy target: {}",
                                            ready_path.display()
                                        ))
                                    }
                                };
                                if !source_identity_matches(ready_path, expected) {
                                    return Err(format!(
                                        "The existing copy target changed and was preserved: {}",
                                        ready_path.display()
                                    ));
                                }
                                return Ok(());
                            }
                            if was_preexisting {
                                let expected = match stored.as_ref() {
                                    Some(UndoAction::PendingCopy {
                                        identity: Some(identity),
                                        ..
                                    }) => identity,
                                    _ => {
                                        return Err(format!(
                                            "Cannot verify ownership of the existing copy staging path: {}",
                                            ready_path.display()
                                        ))
                                    }
                                };
                                if !object_identity_matches(ready_path, expected) {
                                    return Err(format!(
                                        "The existing copy staging path changed and was preserved: {}",
                                        ready_path.display()
                                    ));
                                }
                            }
                            let identity = self.update_pending_identity(&id, pending, ready_path)?;
                            copy_output_identity = Some(identity.clone());
                            Ok(())
                        },
                    );
                    if pending_bytes > 0 {
                        let increment = pending_bytes;
                        self.update(app, &id, |snapshot| {
                            snapshot.completed_bytes = snapshot
                                .completed_bytes
                                .saturating_add(increment)
                                .min(snapshot.total_bytes);
                        });
                    }
                    result
                })
                .map(|_| destination_path.clone()),
                OperationKind::Move
                    if item_was_started
                        && pending_was_persisted
                        && !path_exists(Path::new(path)) =>
                {
                    let Some(destination) = destination_path.as_deref() else {
                        return self.fail_item(app, &id, path, "Move destination is missing");
                    };
                    let expected = pending_undo_action
                        .as_ref()
                        .and_then(|pending| self.stored_undo_intent(&id, pending))
                        .and_then(|stored| match stored {
                            UndoAction::PendingMove {
                                target_identity,
                                source_identity,
                                ..
                            } => target_identity.or(source_identity),
                            _ => None,
                        });
                    if path_exists(Path::new(destination))
                        && expected.as_ref().is_some_and(|identity| {
                            source_identity_matches(Path::new(destination), identity)
                        })
                    {
                        Ok(destination_path.clone())
                    } else {
                        Err(format!(
                            "Cannot verify the interrupted move target; it was preserved: {}",
                            destination
                        ))
                    }
                }
                OperationKind::Move => retry_operation(|| {
                    let mut pending_bytes = 0_u64;
                    let mut last_emit = std::time::Instant::now();
                    let pending = pending_undo_action
                        .as_ref()
                        .expect("move operation should have a recovery intent");
                    let result = move_path_resumable_with_ready(
                        path.clone(),
                        destination_path.clone().unwrap_or_default(),
                        item_was_started && pending_was_persisted,
                        |delta| {
                            reports_byte_progress = true;
                            pending_bytes = pending_bytes.saturating_add(delta);
                            let cancelled = cancel_requested.load(Ordering::Acquire);
                            if cancelled
                                || last_emit.elapsed() >= std::time::Duration::from_millis(100)
                            {
                                let increment = pending_bytes;
                                pending_bytes = 0;
                                self.update(app, &id, |snapshot| {
                                    snapshot.completed_bytes = snapshot
                                        .completed_bytes
                                        .saturating_add(increment)
                                        .min(snapshot.total_bytes);
                                });
                                last_emit = std::time::Instant::now();
                            }
                            !cancelled
                        },
                        |ready_path, was_preexisting| {
                            let stored = self.stored_undo_intent(&id, pending);
                            if path_exists(Path::new(path)) {
                                let source_identity = stored.as_ref().and_then(|stored| match stored {
                                    UndoAction::PendingMove {
                                        source_identity: Some(identity),
                                        ..
                                    } => Some(identity),
                                    _ => None,
                                });
                                if !source_identity.is_some_and(|identity| {
                                    source_identity_matches(Path::new(path), identity)
                                }) {
                                    return Err(format!(
                                        "The move source changed during the operation and was preserved: {}",
                                        path
                                    ));
                                }
                            }
                            let is_final_destination = destination_path
                                .as_deref()
                                .is_some_and(|destination| Path::new(destination) == ready_path);
                            if was_preexisting && is_final_destination {
                                let expected = match stored.as_ref() {
                                    Some(UndoAction::PendingMove {
                                        target_identity: Some(identity),
                                        ..
                                    }) => identity,
                                    _ => {
                                        return Err(format!(
                                            "Cannot verify ownership of the existing move target: {}",
                                            ready_path.display()
                                        ))
                                    }
                                };
                                if !source_identity_matches(ready_path, expected) {
                                    return Err(format!(
                                        "The existing move target changed and was preserved: {}",
                                        ready_path.display()
                                    ));
                                }
                                return Ok(());
                            }
                            if was_preexisting {
                                let expected = stored.as_ref().and_then(|stored| match stored {
                                    UndoAction::PendingMove {
                                        target_identity: Some(identity),
                                        ..
                                    } => Some(identity),
                                    _ => None,
                                });
                                if !expected
                                    .is_some_and(|identity| object_identity_matches(ready_path, identity))
                                {
                                    return Err(format!(
                                        "Cannot verify ownership of the existing move staging path: {}",
                                        ready_path.display()
                                    ));
                                }
                            }
                            self.update_pending_identity(&id, pending, ready_path)
                                .map(|_| ())
                        },
                    );
                    if pending_bytes > 0 {
                        let increment = pending_bytes;
                        self.update(app, &id, |snapshot| {
                            snapshot.completed_bytes = snapshot
                                .completed_bytes
                                .saturating_add(increment)
                                .min(snapshot.total_bytes);
                        });
                    }
                    result
                })
                .map(|_| destination_path.clone()),
                OperationKind::Delete => {
                    retry_operation(|| delete_to_trash(path.clone()).map(|_| ())).map(|_| None)
                }
                OperationKind::Compress | OperationKind::Extract => {
                    Err("Archive operation was routed to the file worker".to_string())
                }
            };

            match result {
                Ok(created_path) => {
                    debug_assert_eq!(created_path.is_some(), final_undo_action.is_some());
                    let final_undo_action = final_undo_action.map(|action| match action {
                        UndoAction::RemoveCreatedPath { path, .. } => {
                            let identity = copy_output_identity.clone().or_else(|| {
                                pending_undo_action
                                    .as_ref()
                                    .and_then(|pending| self.stored_undo_intent(&id, pending))
                                    .and_then(|stored| match stored {
                                        UndoAction::PendingCopy { identity, .. } => identity,
                                        _ => None,
                                    })
                            });
                            UndoAction::RemoveCreatedPath { path, identity }
                        }
                        UndoAction::MoveBack { from, to, .. } => {
                            let identity = pending_undo_action
                                .as_ref()
                                .and_then(|pending| self.stored_undo_intent(&id, pending))
                                .and_then(|stored| match stored {
                                    UndoAction::PendingMove {
                                        target_identity,
                                        source_identity,
                                        ..
                                    } => target_identity.or(source_identity),
                                    _ => None,
                                });
                            UndoAction::MoveBack { from, to, identity }
                        }
                        action => action,
                    });
                    // 目录监听器按 WebView 注册，跨窗口拖拽时不能只依赖
                    // 单个窗口的 notify watcher；把受影响的目录变化广播给
                    // 所有窗口，让源窗口和目标窗口都立即失效并刷新缓存。
                    if matches!(request.kind, OperationKind::Move | OperationKind::Delete) {
                        if let Some(parent) = Path::new(path).parent() {
                            let parent = parent.to_string_lossy().to_string();
                            crate::cache::notify_dir_change(app, &parent);
                        }
                    }
                    if matches!(request.kind, OperationKind::Copy | OperationKind::Move) {
                        if let Some(destination) = destination_path
                            .as_deref()
                            .and_then(|target| Path::new(target).parent())
                        {
                            crate::cache::notify_dir_change(app, &destination.to_string_lossy());
                        }
                    }
                    self.complete_item(
                        app,
                        &id,
                        item_index,
                        item_bytes,
                        reports_byte_progress,
                        pending_undo_action.zip(final_undo_action),
                    );
                }
                Err(error) => {
                    let staging_identity_error = pending_undo_action.as_ref().and_then(|pending| {
                        let stored = self.stored_undo_intent(&id, pending)?;
                        let (partial_path, expected_identity) = match stored {
                            UndoAction::PendingCopy {
                                partial_path,
                                identity,
                                ..
                            } => (PathBuf::from(partial_path), identity),
                            UndoAction::PendingMove {
                                to,
                                target_identity,
                                ..
                            } => (partial_path_for(Path::new(&to)), target_identity),
                            _ => return None,
                        };
                        if !path_exists(&partial_path) {
                            return None;
                        }
                        (!expected_identity.as_ref().is_some_and(|identity| {
                            object_identity_matches(&partial_path, identity)
                        }))
                        .then(|| {
                            format!(
                                "Cannot verify ownership of the operation staging path; it was preserved: {}",
                                partial_path.display()
                            )
                        })
                    });
                    let rollback_error = replacement.as_ref().and_then(|action| {
                        self.rollback_replacement(
                            &id,
                            destination_path.as_deref(),
                            action,
                            pending_undo_action.as_ref(),
                        )
                        .err()
                    });
                    let cleanup_error = if replacement.is_none() {
                        pending_undo_action.as_ref().and_then(|action| {
                            let keep_for_undo = match action {
                                UndoAction::PendingCopy {
                                    path, partial_path, ..
                                } => {
                                    path_exists(Path::new(path))
                                        || path_exists(Path::new(partial_path))
                                }
                                UndoAction::PendingMove { to, .. } => {
                                    path_exists(Path::new(to))
                                        || path_exists(&partial_path_for(Path::new(to)))
                                }
                                _ => false,
                            };
                            (!keep_for_undo)
                                .then(|| self.remove_undo_intent(&id, action).err())
                                .flatten()
                        })
                    } else {
                        None
                    }
                    .or(staging_identity_error);
                    if cancel_requested.load(Ordering::Acquire) {
                        if let Some(recovery_error) = rollback_error.or(cleanup_error) {
                            self.fail_item(app, &id, path, &recovery_error);
                        }
                        self.finish(app, &id, OperationStatus::Cancelled);
                        return;
                    }
                    let error = rollback_error
                        .or(cleanup_error)
                        .map(|recovery| format!("{}; recovery cleanup: {}", error, recovery))
                        .unwrap_or(error);
                    self.fail_item(app, &id, path, &error);
                }
            }
        }

        let status = self.terminal_status(&id);
        self.finish(app, &id, status);
    }

    fn run_archive_job(&self, app: &AppHandle, id: String, request: OperationRequest) {
        let Some(cancel_requested) = self.cancel_flag(&id) else {
            return;
        };
        if cancel_requested.load(Ordering::Acquire) {
            self.finish(app, &id, OperationStatus::Cancelled);
            return;
        }

        let destination = match self.prepare_archive_target(&id, &request) {
            Ok(destination) => destination,
            Err(error) => {
                self.fail_archive(app, &id, &error);
                self.finish(app, &id, OperationStatus::Failed);
                return;
            }
        };

        let existing_pending = self.pending_archive_for_path(&id, &destination);
        let partial_destination = existing_pending
            .as_ref()
            .and_then(|action| match action {
                UndoAction::PendingArchiveOutput { partial_path, .. } => {
                    Some(PathBuf::from(partial_path))
                }
                _ => None,
            })
            .unwrap_or_else(|| partial_path_for(Path::new(&destination)));
        let mut pending = existing_pending.unwrap_or_else(|| UndoAction::PendingArchiveOutput {
            path: destination.clone(),
            partial_path: partial_destination.to_string_lossy().to_string(),
            identity: None,
            ready: false,
        });

        if path_exists(Path::new(&destination)) {
            let owns_destination = matches!(
                &pending,
                UndoAction::PendingArchiveOutput {
                    identity: Some(identity),
                    ready: true,
                    ..
                } if source_identity_matches(Path::new(&destination), identity)
            );
            if owns_destination {
                self.complete_archive(app, &id, &destination, Some(pending));
                self.finish(app, &id, OperationStatus::Completed);
            } else {
                self.fail_archive(
                    app,
                    &id,
                    &format!(
                        "The archive destination cannot be verified as this operation's output; it was preserved: {}",
                        destination
                    ),
                );
                self.finish(app, &id, OperationStatus::Failed);
            }
            return;
        }

        if path_exists(&partial_destination) {
            let partial_is_owned = matches!(
                &pending,
                UndoAction::PendingArchiveOutput {
                    identity: Some(identity),
                    ..
                } if source_identity_matches(&partial_destination, identity)
            );
            if !partial_is_owned {
                self.fail_archive(
                    app,
                    &id,
                    &format!(
                        "The archive staging file cannot be verified as this operation's output; it was preserved: {}",
                        partial_destination.to_string_lossy()
                    ),
                );
                self.finish(app, &id, OperationStatus::Failed);
                return;
            }

            let ready = matches!(
                &pending,
                UndoAction::PendingArchiveOutput { ready: true, .. }
            );
            if ready {
                if let Err(error) =
                    rename_without_replace(&partial_destination, Path::new(&destination))
                {
                    self.fail_archive(app, &id, &error.to_string());
                    self.finish(app, &id, OperationStatus::Failed);
                    return;
                }
                if let Some(parent) = Path::new(&destination).parent() {
                    crate::cache::notify_dir_change(app, &parent.to_string_lossy());
                }
                self.complete_archive(app, &id, &destination, Some(pending));
                self.finish(app, &id, OperationStatus::Completed);
                return;
            }

            if let Err(error) = remove_path_if_exists(&partial_destination) {
                self.fail_archive(app, &id, &error);
                self.finish(app, &id, OperationStatus::Failed);
                return;
            }
            if let Err(error) = self.remove_undo_intent(&id, &pending) {
                self.fail_archive(app, &id, &error);
                self.finish(app, &id, OperationStatus::Failed);
                return;
            }
            pending = UndoAction::PendingArchiveOutput {
                path: destination.clone(),
                partial_path: partial_destination.to_string_lossy().to_string(),
                identity: None,
                ready: false,
            };
        } else if self.has_undo_intent(&id, &pending) {
            if let Err(error) = self.remove_undo_intent(&id, &pending) {
                self.fail_archive(app, &id, &error);
                self.finish(app, &id, OperationStatus::Failed);
                return;
            }
            pending = UndoAction::PendingArchiveOutput {
                path: destination.clone(),
                partial_path: partial_destination.to_string_lossy().to_string(),
                identity: None,
                ready: false,
            };
        }

        if let Err(error) = self.mark_all_items_started(&id) {
            self.fail_archive(app, &id, &error);
            self.finish(app, &id, OperationStatus::Failed);
            return;
        }

        self.update(app, &id, |snapshot| {
            snapshot.status = OperationStatus::Running;
            snapshot.retryable = false;
            snapshot.current_item = request.paths.first().cloned();
        });

        if let Err(error) = self.stage_undo_intent(&id, &pending) {
            self.fail_archive(app, &id, &error);
            self.finish(app, &id, OperationStatus::Failed);
            return;
        }
        let result = run_archive_command(
            request.kind,
            &request.paths,
            &partial_destination.to_string_lossy(),
            &cancel_requested,
        );
        match result {
            Ok(()) => {
                if let Err(error) =
                    self.update_pending_identity(&id, &pending, &partial_destination)
                {
                    self.fail_archive(app, &id, &error);
                    self.finish(app, &id, OperationStatus::Failed);
                    return;
                }
                if let Err(error) = self.mark_pending_archive_ready(&id, &pending) {
                    self.fail_archive(app, &id, &error);
                    self.finish(app, &id, OperationStatus::Failed);
                    return;
                }
                if path_exists(Path::new(&destination)) {
                    self.fail_archive(
                        app,
                        &id,
                        "Archive destination appeared while processing; the staged output was preserved",
                    );
                    self.finish(app, &id, OperationStatus::Failed);
                    return;
                }
                if let Err(error) =
                    rename_without_replace(&partial_destination, Path::new(&destination))
                {
                    self.fail_archive(app, &id, &error.to_string());
                    self.finish(app, &id, OperationStatus::Failed);
                    return;
                }
                if let Some(parent) = Path::new(&destination).parent() {
                    crate::cache::notify_dir_change(app, &parent.to_string_lossy());
                }
                let completed_pending = self.stored_undo_intent(&id, &pending).unwrap_or(pending);
                self.complete_archive(app, &id, &destination, Some(completed_pending));
                self.finish(app, &id, OperationStatus::Completed);
            }
            Err(error) => {
                if path_exists(&partial_destination) {
                    let known_identity =
                        self.stored_undo_intent(&id, &pending)
                            .and_then(|stored| match stored {
                                UndoAction::PendingArchiveOutput { identity, .. } => identity,
                                _ => None,
                            });
                    if !known_identity.as_ref().is_some_and(|identity| {
                        object_identity_matches(&partial_destination, identity)
                    }) {
                        self.fail_archive(
                            app,
                            &id,
                            &format!(
                                "Archive staging ownership could not be verified; the file was preserved: {}",
                                partial_destination.display()
                            ),
                        );
                    }
                } else if let Err(cleanup_error) = self.remove_undo_intent(&id, &pending) {
                    self.fail_archive(app, &id, &cleanup_error);
                }
                if cancel_requested.load(Ordering::Acquire) {
                    self.finish(app, &id, OperationStatus::Cancelled);
                } else {
                    self.fail_archive(app, &id, &error);
                    self.finish(app, &id, OperationStatus::Failed);
                }
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
                UndoAction::PendingCopy {
                    path,
                    partial_path,
                    identity,
                    ..
                } => {
                    let target_exists = path_exists(Path::new(path));
                    let partial_exists = path_exists(Path::new(partial_path));
                    let result = if !target_exists && !partial_exists {
                        Ok(())
                    } else if let Some(identity) = identity {
                        if (target_exists && !source_identity_matches(Path::new(path), identity))
                            || (partial_exists
                                && !object_identity_matches(Path::new(partial_path), identity))
                        {
                            Err(format!(
                                "The interrupted copy changed after the operation; undo stopped: {}",
                                path
                            ))
                        } else {
                            let cleanup = if partial_exists {
                                remove_path_if_exists(Path::new(partial_path))
                            } else {
                                Ok(())
                            };
                            cleanup.and_then(|()| {
                                if target_exists {
                                    delete_to_trash(path.clone())
                                } else {
                                    Ok(())
                                }
                            })
                        }
                    } else {
                        Err(format!(
                            "Cannot verify ownership of the interrupted copy; existing files were preserved: {}",
                            path
                        ))
                    };
                    (path.clone(), result)
                }
                UndoAction::PendingMove {
                    from,
                    to,
                    source_identity,
                    target_identity,
                } => {
                    let source_exists = path_exists(Path::new(from));
                    let destination_exists = path_exists(Path::new(to));
                    let partial = partial_path_for(Path::new(to));
                    let partial_exists = path_exists(&partial);
                    let expected_identity = target_identity.as_ref().or(source_identity.as_ref());
                    let destination_matches = expected_identity
                        .is_some_and(|identity| source_identity_matches(Path::new(to), identity));
                    let partial_matches = target_identity
                        .as_ref()
                        .is_some_and(|identity| object_identity_matches(&partial, identity));
                    let result = if partial_exists && !partial_matches {
                        Err(format!(
                            "Cannot verify ownership of the interrupted move staging file; it was preserved: {}",
                            partial.to_string_lossy()
                        ))
                    } else {
                        let cleanup_partial = || {
                            if partial_exists {
                                remove_path_if_exists(&partial)
                            } else {
                                Ok(())
                            }
                        };
                        match (source_exists, destination_exists) {
                        (true, false) => cleanup_partial(),
                        (true, true) if target_identity.is_some() && destination_matches => {
                            cleanup_partial().and_then(|()| delete_to_trash(to.clone()))
                        }
                        (true, true) => Err(format!(
                            "Cannot verify that the interrupted move owns this path; it was preserved: {}",
                            to
                        )),
                        (false, true) => {
                            if !destination_matches {
                                Err(format!(
                                    "The interrupted move target changed; it was preserved: {}",
                                    to
                                ))
                            } else if Path::new(from).parent().is_none() {
                                Err(format!("Invalid original path: {}", from))
                            } else {
                                cleanup_partial().and_then(|()| {
                                    move_path_resumable(to.clone(), from.clone(), false, |_| true)
                                })
                            }
                        }
                        (false, false) => Err(format!(
                            "Both paths for the interrupted move are missing: {}",
                            to
                        )),
                    }
                    };
                    (to.clone(), result)
                }
                UndoAction::PendingArchiveOutput {
                    path,
                    partial_path,
                    identity,
                    ..
                } => {
                    let target_exists = path_exists(Path::new(path));
                    let partial_exists = path_exists(Path::new(partial_path));
                    let result = if !target_exists && !partial_exists {
                        Ok(())
                    } else if let Some(identity) = identity {
                        if (target_exists && !source_identity_matches(Path::new(path), identity))
                            || (partial_exists
                                && !object_identity_matches(Path::new(partial_path), identity))
                        {
                            Err(format!(
                                "The archive output changed after the operation; undo stopped: {}",
                                path
                            ))
                        } else {
                            let cleanup = if partial_exists {
                                remove_path_if_exists(Path::new(partial_path))
                            } else {
                                Ok(())
                            };
                            cleanup.and_then(|()| {
                                if target_exists {
                                    delete_to_trash(path.clone())
                                } else {
                                    Ok(())
                                }
                            })
                        }
                    } else {
                        Err(format!(
                            "Cannot verify ownership of the archive output; existing files were preserved: {}",
                            path
                        ))
                    };
                    (path.clone(), result)
                }
                UndoAction::RemoveCreatedPath { path, identity } => {
                    let path_ref = Path::new(path);
                    let result = verify_created_path_identity(path_ref, identity.as_ref())
                        .and_then(|exists| {
                            if exists {
                                delete_to_trash(path.clone())
                            } else {
                                Ok(())
                            }
                        });
                    (path.clone(), result)
                }
                UndoAction::MoveBack { from, to, identity } => {
                    let result = if path_exists(Path::new(from)) && !path_exists(Path::new(to)) {
                        // This action was already completed before a restart.
                        Ok(())
                    } else if path_exists(Path::new(from)) {
                        Err(format!("Original path already exists: {}", from))
                    } else if Path::new(from).parent().is_none() {
                        Err(format!("Invalid original path: {}", from))
                    } else if !identity
                        .as_ref()
                        .is_some_and(|identity| source_identity_matches(Path::new(to), identity))
                    {
                        Err(format!(
                            "The moved item changed after the operation; undo stopped and preserved it: {}",
                            to
                        ))
                    } else {
                        move_path_resumable(to.clone(), from.clone(), false, |_| true)
                    };
                    (to.clone(), result)
                }
                UndoAction::RestoreBackup {
                    backup_path,
                    original_path,
                    identity,
                } => (
                    original_path.clone(),
                    restore_backup(backup_path, original_path, identity.as_ref()),
                ),
            };

            self.update(app, &operation_id, |snapshot| {
                snapshot.current_item = Some(display_path.clone());
            });

            match result {
                Ok(()) => {
                    if let Some(parent) = Path::new(&display_path).parent() {
                        crate::cache::notify_dir_change(app, &parent.to_string_lossy());
                    }
                    match action {
                        UndoAction::PendingMove { from, .. }
                        | UndoAction::MoveBack { from, .. }
                        | UndoAction::RestoreBackup {
                            original_path: from,
                            ..
                        } => {
                            if let Some(parent) = Path::new(from).parent() {
                                crate::cache::notify_dir_change(app, &parent.to_string_lossy());
                            }
                        }
                        UndoAction::PendingCopy { .. }
                        | UndoAction::PendingArchiveOutput { .. }
                        | UndoAction::RemoveCreatedPath { .. } => {}
                    }
                    self.update(app, &operation_id, |snapshot| {
                        snapshot.current_item = None;
                    });
                }
                Err(error) => {
                    self.update(app, &operation_id, |snapshot| {
                        snapshot.undo_status = UndoStatus::Failed;
                        append_operation_error(
                            snapshot,
                            format!(
                                "Undo {}: {}",
                                redact_path(&display_path),
                                redact_error(&error)
                            ),
                        );
                        snapshot.current_item = None;
                    });
                    return;
                }
            }
        }

        self.complete_undo(app, &operation_id);
    }

    fn request(&self, id: &str) -> Option<OperationRequest> {
        self.records
            .lock()
            .ok()
            .and_then(|records| records.get(id).and_then(|record| record.request.clone()))
    }

    fn prepare_item_target(
        &self,
        id: &str,
        item_index: usize,
        request: &OperationRequest,
    ) -> Result<Option<String>, String> {
        let Some(mut target) = request.target_paths.get(item_index).cloned().flatten() else {
            return if matches!(request.kind, OperationKind::Copy | OperationKind::Move) {
                Err("Operation destination is missing".to_string())
            } else {
                Ok(None)
            };
        };

        let started = request
            .started_items
            .get(item_index)
            .copied()
            .unwrap_or(false);
        if matches!(request.conflict_policy, ConflictPolicy::KeepBoth)
            && !started
            && (path_exists(Path::new(&target))
                || path_exists(&partial_path_for(Path::new(&target))))
        {
            target = unique_operation_path(Path::new(&target))
                .to_string_lossy()
                .to_string();
            let mut records = self.records.lock().map_err(|error| error.to_string())?;
            let record = records
                .get_mut(id)
                .ok_or_else(|| "Operation not found".to_string())?;
            let stored_request = record
                .request
                .as_mut()
                .ok_or_else(|| "Operation recovery request is missing".to_string())?;
            let stored_target = stored_request
                .target_paths
                .get_mut(item_index)
                .ok_or_else(|| "Operation item is missing".to_string())?;
            *stored_target = Some(target.clone());
            persist_record_map(&records).map_err(|error| {
                format!("Failed to persist the selected destination: {}", error)
            })?;
        }
        if matches!(request.conflict_policy, ConflictPolicy::KeepBoth) && started {
            let partial = partial_path_for(Path::new(&target));
            let pending_key = match request.kind {
                OperationKind::Copy => UndoAction::PendingCopy {
                    source: request.paths[item_index].clone(),
                    path: target.clone(),
                    partial_path: partial.to_string_lossy().to_string(),
                    identity: None,
                },
                OperationKind::Move => UndoAction::PendingMove {
                    from: request.paths[item_index].clone(),
                    to: target.clone(),
                    source_identity: request.source_identities.get(item_index).cloned().flatten(),
                    target_identity: None,
                },
                _ => return Ok(Some(target)),
            };
            let pending = self.stored_undo_intent(id, &pending_key);
            let destination_exists = path_exists(Path::new(&target));
            let partial_exists = path_exists(&partial);
            let destination_owned = match pending.as_ref() {
                Some(UndoAction::PendingCopy {
                    identity: Some(identity),
                    ..
                }) => source_identity_matches(Path::new(&target), identity),
                Some(UndoAction::PendingMove {
                    target_identity: Some(identity),
                    ..
                }) => source_identity_matches(Path::new(&target), identity),
                Some(UndoAction::PendingMove {
                    source_identity: Some(identity),
                    ..
                }) => source_identity_matches(Path::new(&target), identity),
                _ => false,
            };
            let partial_owned = match pending.as_ref() {
                Some(UndoAction::PendingCopy {
                    identity: Some(identity),
                    ..
                }) => object_identity_matches(&partial, identity),
                Some(UndoAction::PendingMove {
                    target_identity: Some(identity),
                    ..
                }) => object_identity_matches(&partial, identity),
                _ => false,
            };

            if partial_exists && !partial_owned {
                return Err(format!(
                    "The interrupted operation has an unverified staging file; it was preserved: {}",
                    partial.to_string_lossy()
                ));
            }
            if destination_exists && !destination_owned {
                if partial_exists {
                    remove_path_if_exists(&partial)?;
                }
                if let Some(pending) = pending.as_ref() {
                    self.remove_undo_intent(id, pending)?;
                }
                target = unique_operation_path(Path::new(&target))
                    .to_string_lossy()
                    .to_string();
                let mut records = self.records.lock().map_err(|error| error.to_string())?;
                let record = records
                    .get_mut(id)
                    .ok_or_else(|| "Operation not found".to_string())?;
                let stored_request = record
                    .request
                    .as_mut()
                    .ok_or_else(|| "Operation recovery request is missing".to_string())?;
                let stored_target = stored_request
                    .target_paths
                    .get_mut(item_index)
                    .ok_or_else(|| "Operation item is missing".to_string())?;
                *stored_target = Some(target.clone());
                persist_record_map(&records).map_err(|error| {
                    format!("Failed to persist the selected destination: {}", error)
                })?;
            }
        }
        Ok(Some(target))
    }

    fn prepare_archive_target(
        &self,
        id: &str,
        request: &OperationRequest,
    ) -> Result<String, String> {
        let mut target = request
            .target_paths
            .first()
            .cloned()
            .flatten()
            .ok_or_else(|| "Archive destination is missing".to_string())?;
        let started = request.started_items.first().copied().unwrap_or(false);
        let previous_target = target.clone();
        let pending = self.pending_archive_for_path(id, &previous_target);
        let previous_partial = pending
            .as_ref()
            .and_then(|action| match action {
                UndoAction::PendingArchiveOutput { partial_path, .. } => {
                    Some(PathBuf::from(partial_path))
                }
                _ => None,
            })
            .unwrap_or_else(|| partial_path_for(Path::new(&previous_target)));
        let pending_identity = pending.as_ref().and_then(|action| match action {
            UndoAction::PendingArchiveOutput { identity, .. } => identity.as_ref(),
            _ => None,
        });
        let pending_ready = pending.as_ref().is_some_and(|action| {
            matches!(action, UndoAction::PendingArchiveOutput { ready: true, .. })
        });
        let target_exists = path_exists(Path::new(&previous_target));
        let partial_exists = path_exists(&previous_partial);
        let target_matches = pending_identity
            .is_some_and(|identity| source_identity_matches(Path::new(&previous_target), identity));
        let partial_matches = pending_identity
            .is_some_and(|identity| source_identity_matches(&previous_partial, identity));

        if started && target_exists && pending.is_some() && (!target_matches || !pending_ready) {
            return Err(format!(
                "The archive destination changed while the operation was interrupted; it was preserved: {}",
                previous_target
            ));
        }
        if started && partial_exists && !partial_matches {
            return Err(format!(
                "The archive staging file cannot be verified; it was preserved: {}",
                previous_partial.to_string_lossy()
            ));
        }
        let owns_published_target = started && target_exists && target_matches && pending_ready;
        let should_retarget = (target_exists && !owns_published_target && pending.is_none())
            || (!started && partial_exists);
        if should_retarget {
            target = unique_archive_path(
                Path::new(&previous_target),
                matches!(request.kind, OperationKind::Extract),
            )
            .to_string_lossy()
            .to_string();
            let mut records = self.records.lock().map_err(|error| error.to_string())?;
            let record = records
                .get_mut(id)
                .ok_or_else(|| "Operation not found".to_string())?;
            let stored_request = record
                .request
                .as_mut()
                .ok_or_else(|| "Operation recovery request is missing".to_string())?;
            for stored_target in &mut stored_request.target_paths {
                *stored_target = Some(target.clone());
            }
            persist_record_map(&records)
                .map_err(|error| format!("Failed to persist archive destination: {}", error))?;
        }
        Ok(target)
    }

    fn mark_item_started(&self, id: &str, item_index: usize) -> Result<(), String> {
        let mut records = self.records.lock().map_err(|error| error.to_string())?;
        let record = records
            .get_mut(id)
            .ok_or_else(|| "Operation not found".to_string())?;
        let request = record
            .request
            .as_mut()
            .ok_or_else(|| "Operation recovery request is missing".to_string())?;
        let started = request
            .started_items
            .get_mut(item_index)
            .ok_or_else(|| "Operation item is missing".to_string())?;
        if *started {
            return Ok(());
        }
        *started = true;
        persist_record_map(&records)
            .map_err(|error| format!("Failed to persist operation start: {}", error))
    }

    fn mark_all_items_started(&self, id: &str) -> Result<(), String> {
        let mut records = self.records.lock().map_err(|error| error.to_string())?;
        let record = records
            .get_mut(id)
            .ok_or_else(|| "Operation not found".to_string())?;
        let request = record
            .request
            .as_mut()
            .ok_or_else(|| "Operation recovery request is missing".to_string())?;
        request.started_items.fill(true);
        persist_record_map(&records)
            .map_err(|error| format!("Failed to persist archive start: {}", error))
    }

    fn stage_undo_intent(&self, id: &str, action: &UndoAction) -> Result<(), String> {
        let mut records = self.records.lock().map_err(|error| error.to_string())?;
        let record = records
            .get_mut(id)
            .ok_or_else(|| "Operation not found".to_string())?;
        if record
            .undo_actions
            .iter()
            .any(|candidate| same_undo_intent(candidate, action))
        {
            return Ok(());
        }
        record.undo_actions.push(action.clone());
        if let Err(error) = persist_record_map(&records) {
            if let Some(record) = records.get_mut(id) {
                record.undo_actions.retain(|candidate| candidate != action);
            }
            return Err(format!("Could not persist undo intent: {}", error));
        }
        Ok(())
    }

    fn has_undo_intent(&self, id: &str, action: &UndoAction) -> bool {
        self.records
            .lock()
            .ok()
            .map(|records| {
                records.get(id).is_some_and(|record| {
                    record
                        .undo_actions
                        .iter()
                        .any(|candidate| same_undo_intent(candidate, action))
                })
            })
            .unwrap_or(false)
    }

    fn stored_undo_intent(&self, id: &str, action: &UndoAction) -> Option<UndoAction> {
        self.records.lock().ok().and_then(|records| {
            records.get(id).and_then(|record| {
                record
                    .undo_actions
                    .iter()
                    .find(|candidate| same_undo_intent(candidate, action))
                    .cloned()
            })
        })
    }

    fn pending_archive_for_path(&self, id: &str, path: &str) -> Option<UndoAction> {
        self.records.lock().ok().and_then(|records| {
            records.get(id).and_then(|record| {
                record.undo_actions.iter().find_map(|action| match action {
                    UndoAction::PendingArchiveOutput {
                        path: stored_path, ..
                    } if stored_path == path => Some(action.clone()),
                    _ => None,
                })
            })
        })
    }

    fn update_pending_identity(
        &self,
        id: &str,
        action: &UndoAction,
        object_path: &Path,
    ) -> Result<SourceIdentity, String> {
        let identity = source_identity(object_path).ok_or_else(|| {
            format!(
                "Could not verify the operation output: {}",
                object_path.display()
            )
        })?;
        let mut records = self.records.lock().map_err(|error| error.to_string())?;
        let record = records
            .get_mut(id)
            .ok_or_else(|| "Operation not found".to_string())?;
        let stored = record
            .undo_actions
            .iter_mut()
            .find(|candidate| same_undo_intent(candidate, action))
            .ok_or_else(|| "Operation recovery intent is missing".to_string())?;
        let expected = match stored {
            UndoAction::PendingCopy {
                identity: expected, ..
            }
            | UndoAction::PendingArchiveOutput {
                identity: expected, ..
            } => expected,
            UndoAction::PendingMove {
                target_identity: expected,
                from,
                source_identity,
                ..
            } => {
                // A same-volume rename preserves the source file object. If
                // the source path has disappeared, never adopt an unrelated
                // object that raced into the destination after the rename.
                if !path_exists(Path::new(from))
                    && !source_identity
                        .as_ref()
                        .is_some_and(|source| source_identity_matches(object_path, source))
                {
                    return Err(format!(
                        "The move target does not match the queued source object: {}",
                        object_path.display()
                    ));
                }
                expected
            }
            _ => return Err("This recovery intent cannot record an output identity".to_string()),
        };
        let previous_identity = expected.clone();
        if expected
            .as_ref()
            .is_some_and(|expected| !object_identities_match(expected, &identity))
        {
            return Err(format!(
                "The operation output changed before it could be recorded: {}",
                object_path.display()
            ));
        }
        *expected = Some(identity.clone());
        if let Err(error) = persist_record_map(&records) {
            // Keep the in-memory action aligned with the durable record.
            if let Some(stored) = records.get_mut(id).and_then(|record| {
                record
                    .undo_actions
                    .iter_mut()
                    .find(|candidate| same_undo_intent(candidate, action))
            }) {
                match stored {
                    UndoAction::PendingCopy { identity, .. }
                    | UndoAction::PendingArchiveOutput { identity, .. } => {
                        *identity = previous_identity
                    }
                    UndoAction::PendingMove {
                        target_identity, ..
                    } => *target_identity = previous_identity,
                    _ => {}
                }
            }
            return Err(format!(
                "Could not persist operation output identity: {}",
                error
            ));
        }
        Ok(identity)
    }

    fn mark_pending_archive_ready(&self, id: &str, action: &UndoAction) -> Result<(), String> {
        let mut records = self.records.lock().map_err(|error| error.to_string())?;
        let record = records
            .get_mut(id)
            .ok_or_else(|| "Operation not found".to_string())?;
        let stored = record
            .undo_actions
            .iter_mut()
            .find(|candidate| same_undo_intent(candidate, action))
            .ok_or_else(|| "Archive recovery intent is missing".to_string())?;
        let UndoAction::PendingArchiveOutput {
            ready, identity, ..
        } = stored
        else {
            return Err("Archive recovery intent is invalid".to_string());
        };
        if identity.is_none() {
            return Err("Archive output identity was not recorded".to_string());
        }
        let previous_ready = *ready;
        *ready = true;
        if let Err(error) = persist_record_map(&records) {
            if let Some(UndoAction::PendingArchiveOutput { ready, .. }) =
                records.get_mut(id).and_then(|record| {
                    record
                        .undo_actions
                        .iter_mut()
                        .find(|candidate| same_undo_intent(candidate, action))
                })
            {
                *ready = previous_ready;
            }
            return Err(format!(
                "Could not persist archive completion state: {}",
                error
            ));
        }
        Ok(())
    }

    fn remove_undo_intent(&self, id: &str, action: &UndoAction) -> Result<(), String> {
        let mut records = self.records.lock().map_err(|error| error.to_string())?;
        let record = records
            .get_mut(id)
            .ok_or_else(|| "Operation not found".to_string())?;
        let Some(position) = record
            .undo_actions
            .iter()
            .position(|candidate| same_undo_intent(candidate, action))
        else {
            return Ok(());
        };
        let removed = record.undo_actions.remove(position);
        if let Err(error) = persist_record_map(&records) {
            if let Some(record) = records.get_mut(id) {
                record.undo_actions.insert(position, removed);
            }
            return Err(format!("Could not persist undo cleanup: {}", error));
        }
        Ok(())
    }

    fn stage_replacement(
        &self,
        id: &str,
        item_index: usize,
        original_path: &str,
    ) -> Result<Option<UndoAction>, String> {
        let existing_action = self.records.lock().ok().and_then(|records| {
            records.get(id).and_then(|record| {
                record.undo_actions.iter().find_map(|action| match action {
                    UndoAction::RestoreBackup {
                        backup_path,
                        original_path: stored_original,
                        identity,
                    } if stored_original == original_path => Some(UndoAction::RestoreBackup {
                        backup_path: backup_path.clone(),
                        original_path: stored_original.clone(),
                        identity: identity.clone(),
                    }),
                    _ => None,
                })
            })
        });

        if let Some(action) = existing_action {
            let UndoAction::RestoreBackup {
                backup_path,
                identity,
                ..
            } = &action
            else {
                unreachable!();
            };
            if path_exists(Path::new(backup_path)) {
                if !identity.as_ref().is_some_and(|identity| {
                    source_identity_matches(Path::new(backup_path), identity)
                }) {
                    return Err(format!(
                        "The recovery backup changed and was preserved: {}",
                        backup_path
                    ));
                }
                return Ok(Some(action));
            }
            if !path_exists(Path::new(original_path)) {
                return Err(format!(
                    "Both the replacement target and its recovery backup are missing: {}",
                    original_path
                ));
            }
            if !identity
                .as_ref()
                .is_some_and(|identity| source_identity_matches(Path::new(original_path), identity))
            {
                return Err(format!(
                    "The replacement target changed before it could be protected: {}",
                    original_path
                ));
            }
            rename_without_replace(Path::new(original_path), Path::new(backup_path))
                .map_err(|error| error.to_string())?;
            if !identity
                .as_ref()
                .is_some_and(|identity| source_identity_matches(Path::new(backup_path), identity))
            {
                return Err(format!(
                    "The replacement backup changed while it was being staged: {}",
                    backup_path
                ));
            }
            return Ok(Some(action));
        }

        if !path_exists(Path::new(original_path)) {
            return Ok(None);
        }
        let backup_path = backup_path_for(Path::new(original_path), id, item_index)
            .to_string_lossy()
            .to_string();
        let identity = source_identity(Path::new(original_path)).ok_or_else(|| {
            format!(
                "Could not record the existing target identity: {}",
                original_path
            )
        })?;
        let action = UndoAction::RestoreBackup {
            backup_path: backup_path.clone(),
            original_path: original_path.to_string(),
            identity: Some(identity.clone()),
        };

        {
            let mut records = self.records.lock().map_err(|error| error.to_string())?;
            let record = records
                .get_mut(id)
                .ok_or_else(|| "Operation not found".to_string())?;
            record.undo_actions.push(action.clone());
            if let Err(error) = persist_record_map(&records) {
                if let Some(record) = records.get_mut(id) {
                    record.undo_actions.pop();
                }
                return Err(format!(
                    "Could not persist replacement recovery intent: {}",
                    error
                ));
            }
        }

        if let Err(error) =
            rename_without_replace(Path::new(original_path), Path::new(&backup_path))
        {
            if let Ok(mut records) = self.records.lock() {
                if let Some(record) = records.get_mut(id) {
                    record.undo_actions.retain(|candidate| candidate != &action);
                }
                let _ = persist_record_map(&records);
            }
            return Err(format!("Could not protect the existing target: {}", error));
        }
        if !source_identity_matches(Path::new(&backup_path), &identity) {
            return Err(format!(
                "The replacement backup changed while it was being staged: {}",
                backup_path
            ));
        }
        Ok(Some(action))
    }

    fn rollback_replacement(
        &self,
        id: &str,
        destination: Option<&str>,
        action: &UndoAction,
        pending_action: Option<&UndoAction>,
    ) -> Result<(), String> {
        let UndoAction::RestoreBackup {
            backup_path,
            original_path,
            identity,
        } = action
        else {
            return Ok(());
        };

        if let Some(destination) = destination {
            let partial = partial_path_for(Path::new(destination));
            let expected_identity = pending_action
                .and_then(|pending| self.stored_undo_intent(id, pending))
                .and_then(|pending| match pending {
                    UndoAction::PendingCopy { identity, .. } => identity,
                    UndoAction::PendingMove {
                        target_identity,
                        source_identity,
                        ..
                    } => target_identity.or(source_identity),
                    _ => None,
                });
            let destination_exists = path_exists(Path::new(destination));
            let partial_exists = path_exists(&partial);
            if (destination_exists || partial_exists)
                && !expected_identity.as_ref().is_some_and(|identity| {
                    (!destination_exists
                        || source_identity_matches(Path::new(destination), identity))
                        && (!partial_exists || object_identity_matches(&partial, identity))
                })
            {
                return Err(format!(
                    "Replacement rollback could not verify ownership of the new output; it was preserved: {}",
                    destination
                ));
            }
            if destination_exists {
                delete_to_trash(destination.to_string())?;
            }
            if partial_exists {
                remove_path_if_exists(&partial)?;
            }
        }
        restore_backup(backup_path, original_path, identity.as_ref())?;

        let mut records = self.records.lock().map_err(|error| error.to_string())?;
        if let Some(record) = records.get_mut(id) {
            record.undo_actions.retain(|candidate| {
                candidate != action
                    && pending_action.is_none_or(|pending| !same_undo_intent(candidate, pending))
            });
        }
        persist_record_map(&records)
            .map_err(|error| format!("Failed to persist replacement rollback: {}", error))
    }

    fn complete_item(
        &self,
        app: &AppHandle,
        id: &str,
        item_index: usize,
        item_bytes: u64,
        reports_byte_progress: bool,
        undo_transition: Option<(UndoAction, UndoAction)>,
    ) {
        let snapshot = {
            let Ok(mut records) = self.records.lock() else {
                return;
            };
            let Some(record) = records.get_mut(id) else {
                return;
            };
            if let Some(request) = record.request.as_mut() {
                if let Some(resolved) = request.resolved_items.get_mut(item_index) {
                    *resolved = true;
                }
            }
            if let Some((pending, action)) = undo_transition {
                record
                    .undo_actions
                    .retain(|candidate| !same_undo_intent(candidate, &pending));
                if !record.undo_actions.contains(&action) {
                    record.undo_actions.push(action);
                }
            }
            record.snapshot.completed_items += 1;
            if !reports_byte_progress {
                record.snapshot.completed_bytes = record
                    .snapshot
                    .completed_bytes
                    .saturating_add(item_bytes)
                    .min(record.snapshot.total_bytes);
            }
            record.snapshot.current_item = None;
            if let Err(error) = persist_record_map(&records) {
                if let Some(record) = records.get_mut(id) {
                    record.snapshot.failed_items += 1;
                    append_operation_error(
                        &mut record.snapshot,
                        format!(
                            "Filesystem work completed, but recovery state could not be persisted: {}",
                            error
                        ),
                    );
                }
            }
            records.get(id).map(|record| record.snapshot.clone())
        };
        if let Some(snapshot) = snapshot {
            self.emit(app, &snapshot);
        }
    }

    fn skip_item(&self, app: &AppHandle, id: &str, item_index: usize) {
        let snapshot = {
            let Ok(mut records) = self.records.lock() else {
                return;
            };
            let Some(record) = records.get_mut(id) else {
                return;
            };
            if let Some(request) = record.request.as_mut() {
                if let Some(resolved) = request.resolved_items.get_mut(item_index) {
                    *resolved = true;
                }
            }
            record.snapshot.skipped_items += 1;
            record.snapshot.current_item = None;
            if let Err(error) = persist_record_map(&records) {
                eprintln!("Failed to persist skipped operation item: {}", error);
            }
            records.get(id).map(|record| record.snapshot.clone())
        };
        if let Some(snapshot) = snapshot {
            self.emit(app, &snapshot);
        }
    }

    fn fail_item(&self, app: &AppHandle, id: &str, path: &str, error: &str) {
        self.update(app, id, |snapshot| {
            snapshot.failed_items += 1;
            append_operation_error(
                snapshot,
                format!("{}: {}", redact_path(path), redact_error(error)),
            );
            snapshot.current_item = None;
        });
    }

    fn fail_resolved_item(
        &self,
        app: &AppHandle,
        id: &str,
        item_index: usize,
        path: &str,
        error: &str,
    ) {
        let snapshot = {
            let Ok(mut records) = self.records.lock() else {
                return;
            };
            let Some(record) = records.get_mut(id) else {
                return;
            };
            if let Some(request) = record.request.as_mut() {
                if let Some(resolved) = request.resolved_items.get_mut(item_index) {
                    *resolved = true;
                }
            }
            record.snapshot.failed_items += 1;
            append_operation_error(
                &mut record.snapshot,
                format!("{}: {}", redact_path(path), redact_error(error)),
            );
            record.snapshot.current_item = None;
            if let Err(error) = persist_record_map(&records) {
                eprintln!("Failed to persist rejected operation item: {}", error);
            }
            records.get(id).map(|record| record.snapshot.clone())
        };
        if let Some(snapshot) = snapshot {
            self.emit(app, &snapshot);
        }
    }

    fn complete_archive(
        &self,
        app: &AppHandle,
        id: &str,
        destination: &str,
        pending_action: Option<UndoAction>,
    ) {
        let snapshot = {
            let Ok(mut records) = self.records.lock() else {
                return;
            };
            let Some(record) = records.get_mut(id) else {
                return;
            };
            if let Some(request) = record.request.as_mut() {
                request.resolved_items.fill(true);
            }
            let output_identity = pending_action.as_ref().and_then(|pending| match pending {
                UndoAction::PendingArchiveOutput { identity, .. } => identity.clone(),
                _ => None,
            });
            if let Some(pending) = pending_action.as_ref() {
                record
                    .undo_actions
                    .retain(|candidate| !same_undo_intent(candidate, pending));
            }
            let action = UndoAction::RemoveCreatedPath {
                path: destination.to_string(),
                identity: output_identity,
            };
            if !record.undo_actions.contains(&action) {
                record.undo_actions.push(action);
            }
            record.snapshot.completed_items = record.snapshot.total_items;
            record.snapshot.completed_bytes = record.snapshot.total_bytes;
            record.snapshot.current_item = None;
            if let Err(error) = persist_record_map(&records) {
                if let Some(record) = records.get_mut(id) {
                    record.snapshot.failed_items = record.snapshot.total_items;
                    append_operation_error(
                        &mut record.snapshot,
                        format!(
                            "Archive completed, but recovery state could not be persisted: {}",
                            error
                        ),
                    );
                }
            }
            records.get(id).map(|record| record.snapshot.clone())
        };
        if let Some(snapshot) = snapshot {
            self.emit(app, &snapshot);
        }
    }

    fn fail_archive(&self, app: &AppHandle, id: &str, error: &str) {
        self.update(app, id, |snapshot| {
            snapshot.failed_items = snapshot.total_items;
            append_operation_error(snapshot, redact_error(error));
            snapshot.current_item = None;
        });
    }

    fn terminal_status(&self, id: &str) -> OperationStatus {
        self.records
            .lock()
            .ok()
            .and_then(|records| {
                records.get(id).map(|record| {
                    let unresolved = record
                        .request
                        .as_ref()
                        .is_some_and(OperationRequest::has_unresolved_items);
                    if record.cancel_requested.load(Ordering::Acquire) && unresolved {
                        OperationStatus::Cancelled
                    } else if record.snapshot.failed_items > 0 || unresolved {
                        OperationStatus::Failed
                    } else {
                        OperationStatus::Completed
                    }
                })
            })
            .unwrap_or(OperationStatus::Failed)
    }

    fn complete_undo(&self, app: &AppHandle, id: &str) {
        let snapshot = {
            let Ok(mut records) = self.records.lock() else {
                return;
            };
            let Some(record) = records.get_mut(id) else {
                return;
            };
            record.request = None;
            record.snapshot.undo_status = UndoStatus::Completed;
            record.snapshot.retryable = false;
            record.snapshot.current_item = None;
            if let Err(error) = persist_record_map(&records) {
                eprintln!("Failed to persist completed undo: {}", error);
            }
            records.get(id).map(|record| record.snapshot.clone())
        };
        if let Some(snapshot) = snapshot {
            self.emit(app, &snapshot);
        }
    }

    fn cancel_flag(&self, id: &str) -> Option<Arc<AtomicBool>> {
        self.records.lock().ok().and_then(|records| {
            records
                .get(id)
                .map(|record| record.cancel_requested.clone())
        })
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
            let previous_durable_state = (
                record.snapshot.status,
                record.snapshot.undo_status,
                record.snapshot.finished_at,
                record.snapshot.cancel_requested,
                record.snapshot.retryable,
                record.snapshot.completed_items,
                record.snapshot.failed_items,
                record.snapshot.skipped_items,
                record.snapshot.errors.len(),
            );
            update(&mut record.snapshot);
            record.snapshot.cancel_requested = record.cancel_requested.load(Ordering::Acquire);
            let durable_state = (
                record.snapshot.status,
                record.snapshot.undo_status,
                record.snapshot.finished_at,
                record.snapshot.cancel_requested,
                record.snapshot.retryable,
                record.snapshot.completed_items,
                record.snapshot.failed_items,
                record.snapshot.skipped_items,
                record.snapshot.errors.len(),
            );
            let should_persist = previous_durable_state != durable_state;
            let snapshot = record.snapshot.clone();
            if should_persist {
                if let Err(error) = persist_record_map(&records) {
                    eprintln!("Failed to persist operation update: {}", error);
                }
            }
            snapshot
        };
        self.emit(app, &snapshot);
    }

    fn finish(&self, app: &AppHandle, id: &str, status: OperationStatus) {
        let (has_undo_actions, has_unresolved_items) = self
            .records
            .lock()
            .ok()
            .and_then(|records| {
                records.get(id).map(|record| {
                    (
                        !record.undo_actions.is_empty(),
                        record
                            .request
                            .as_ref()
                            .is_some_and(OperationRequest::has_unresolved_items),
                    )
                })
            })
            .unwrap_or((false, false));
        self.update(app, id, |snapshot| {
            snapshot.status = status;
            snapshot.current_item = None;
            snapshot.finished_at = Some(now_seconds());
            snapshot.retryable =
                matches!(status, OperationStatus::Failed | OperationStatus::Cancelled)
                    && has_unresolved_items;
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
            persist_record_map(&records)
                .map_err(|error| format!("Failed to persist cancellation: {}", error))?;
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
            record.snapshot.retryable = false;
            (record.snapshot.clone(), record.undo_actions.clone())
        };

        if let Ok(records) = self.records.lock() {
            persist_record_map(&records)
                .map_err(|error| format!("Failed to persist queued undo: {}", error))?;
        }
        {
            let mut queue = self.queue.lock().map_err(|e| e.to_string())?;
            queue.push_back(QueueJob::Undo {
                operation_id: id.to_string(),
                actions,
            });
        }
        self.emit(&app, &snapshot);
        self.ensure_worker(app);
        Ok(())
    }

    pub fn retry(&self, app: AppHandle, id: &str) -> Result<(), String> {
        let request = {
            let records = self.records.lock().map_err(|error| error.to_string())?;
            let record = records
                .get(id)
                .ok_or_else(|| "Operation not found".to_string())?;
            if !matches!(
                record.snapshot.status,
                OperationStatus::Failed | OperationStatus::Cancelled
            ) || !record.snapshot.retryable
            {
                return Err("Operation cannot be retried".to_string());
            }
            record
                .request
                .clone()
                .filter(OperationRequest::has_unresolved_items)
                .ok_or_else(|| "Operation has no recoverable work".to_string())?
        };

        if matches!(request.kind, OperationKind::Copy | OperationKind::Move) {
            let remaining_paths = request
                .paths
                .iter()
                .zip(&request.resolved_items)
                .zip(&request.target_paths)
                .filter_map(|((path, resolved), target)| {
                    if *resolved || !path_exists(Path::new(path)) {
                        return None;
                    }
                    let destination_is_complete = target.as_deref().is_some_and(|target| {
                        path_exists(Path::new(target))
                            && paths_equivalent(Path::new(path), Path::new(target)).unwrap_or(false)
                    });
                    (!destination_is_complete).then_some(path.clone())
                })
                .collect::<Vec<_>>();
            if !remaining_paths.is_empty() {
                ensure_destination_space(
                    &remaining_paths,
                    request.destination.as_deref().unwrap_or_default(),
                )?;
            }
        }

        let snapshot = {
            let mut records = self.records.lock().map_err(|error| error.to_string())?;
            let record = records
                .get_mut(id)
                .ok_or_else(|| "Operation not found".to_string())?;
            record.cancel_requested.store(false, Ordering::Release);
            record.snapshot.status = OperationStatus::Queued;
            record.snapshot.failed_items = 0;
            record.snapshot.errors.clear();
            record.snapshot.cancel_requested = false;
            record.snapshot.undo_status = UndoStatus::None;
            record.snapshot.retryable = false;
            record.snapshot.current_item = None;
            record.snapshot.started_at = now_seconds();
            record.snapshot.finished_at = None;
            let snapshot = record.snapshot.clone();
            persist_record_map(&records)
                .map_err(|error| format!("Failed to persist queued retry: {}", error))?;
            snapshot
        };

        {
            let mut queue = self.queue.lock().map_err(|error| error.to_string())?;
            queue.push_back(QueueJob::Operation { id: id.to_string() });
        }
        self.emit(&app, &snapshot);
        self.ensure_worker(app);
        Ok(())
    }

    pub fn clear(&self, id: &str) -> Result<(), String> {
        let mut records = self.records.lock().map_err(|error| error.to_string())?;
        let undo_actions = {
            let Some(record) = records.get(id) else {
                return Ok(());
            };
            if !matches!(
                record.snapshot.status,
                OperationStatus::Completed | OperationStatus::Failed | OperationStatus::Cancelled
            ) || matches!(
                record.snapshot.undo_status,
                UndoStatus::Queued | UndoStatus::Running
            ) {
                return Ok(());
            }
            record.undo_actions.clone()
        };

        for action in &undo_actions {
            if let UndoAction::RestoreBackup {
                backup_path,
                original_path,
                identity,
            } = action
            {
                discard_backup_to_trash(backup_path, original_path, identity.as_ref())?;
            }
        }
        records.remove(id);
        if let Err(error) = persist_record_map(&records) {
            return Err(format!("Failed to persist cleared operation: {}", error));
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
pub fn retry_file_operation(
    app: AppHandle,
    manager: State<'_, OperationManager>,
    operation_id: String,
) -> Result<(), String> {
    manager.retry(app, &operation_id)
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
    use super::{
        conflicts, load_operation_records, new_file_request, object_identity_matches,
        persist_record_map_to_path, restore_backup, source_identity, source_identity_matches,
        verify_created_path_identity, zip_entry_is_safe, ConflictPolicy, OperationKind,
        OperationRequest, OperationSnapshot, OperationStatus, PersistedOperationRecord, UndoAction,
        UndoStatus,
    };
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEST_ROOT: AtomicU64 = AtomicU64::new(1);

    fn test_root(name: &str) -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be valid")
            .as_nanos();
        let sequence = NEXT_TEST_ROOT.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "imageexplorer-{name}-{}-{suffix}-{sequence}",
            std::process::id()
        ))
    }

    fn snapshot(id: &str, status: OperationStatus, undo_status: UndoStatus) -> OperationSnapshot {
        OperationSnapshot {
            id: id.to_string(),
            kind: OperationKind::Copy,
            status,
            total_items: 1,
            completed_items: 0,
            failed_items: 0,
            skipped_items: 0,
            total_bytes: 4,
            completed_bytes: 2,
            current_item: Some("/tmp/source.txt".to_string()),
            errors: Vec::new(),
            error_details: Vec::new(),
            cancel_requested: false,
            undo_status,
            retryable: false,
            started_at: 1,
            finished_at: None,
        }
    }

    #[test]
    fn conflicts_reports_existing_destination_items() {
        let root = test_root("conflict-test");
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

    #[test]
    fn replace_rejects_multiple_sources_for_the_same_target_before_mutation() {
        let request = new_file_request(
            OperationKind::Copy,
            vec![
                "/tmp/camera-a/photo.raw".to_string(),
                "/tmp/camera-b/photo.raw".to_string(),
            ],
            Some("/tmp/destination".to_string()),
            ConflictPolicy::Replace,
        );

        assert!(request.is_err());
        assert!(request
            .expect_err("duplicate replace target must fail")
            .contains("same destination"));
    }

    #[test]
    fn queued_delete_identity_does_not_match_a_recreated_path() {
        let root = test_root("delete-identity");
        let path = root.join("photo.raw");
        fs::create_dir_all(&root).expect("create test root");
        fs::write(&path, b"original").expect("write original item");
        let identity = source_identity(&path).expect("capture original identity");

        fs::remove_file(&path).expect("remove original item");
        fs::write(&path, b"replacement").expect("write replacement item");

        assert!(!source_identity_matches(&path, &identity));
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn partial_identity_remains_owned_while_copy_bytes_are_written() {
        let root = test_root("partial-identity");
        fs::create_dir_all(&root).expect("create test root");
        let partial = root.join(".photo.raw.imageexplorer-part");
        fs::write(&partial, b"").expect("create partial file");
        let identity = source_identity(&partial).expect("capture partial identity");

        fs::write(&partial, b"copied bytes").expect("append copied bytes");

        assert!(object_identity_matches(&partial, &identity));
        assert!(!source_identity_matches(&partial, &identity));
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn undo_preserves_an_external_replacement_at_the_created_path() {
        let root = test_root("undo-replacement");
        fs::create_dir_all(&root).expect("create test root");
        let created = root.join("copied.raw");
        let replacement = root.join("external-replacement.raw");
        let moved_original = root.join("original-owned-by-operation.raw");
        fs::write(&created, b"operation output").expect("write copied output");
        let identity = source_identity(&created).expect("capture copied output identity");

        fs::rename(&created, &moved_original).expect("move original out of target path");
        fs::write(&replacement, b"external replacement").expect("write replacement");
        fs::rename(&replacement, &created).expect("install external replacement");

        assert!(verify_created_path_identity(&created, Some(&identity)).is_err());
        assert_eq!(
            fs::read(&created).expect("read preserved replacement"),
            b"external replacement"
        );
        assert_eq!(
            fs::read(&moved_original).expect("read preserved original output"),
            b"operation output"
        );
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn zip_entry_validation_rejects_cross_platform_path_escape() {
        assert!(zip_entry_is_safe("folder/photo.raw"));
        assert!(!zip_entry_is_safe("../photo.raw"));
        assert!(!zip_entry_is_safe("folder/../../photo.raw"));
        assert!(!zip_entry_is_safe("..\\photo.raw"));
        assert!(!zip_entry_is_safe("/tmp/photo.raw"));
        assert!(!zip_entry_is_safe("C:/photo.raw"));
    }

    #[test]
    fn interrupted_state_preserves_retry_and_undo_data() {
        let request = OperationRequest {
            kind: OperationKind::Copy,
            paths: vec!["/tmp/source.txt".to_string()],
            destination: Some("/tmp/destination".to_string()),
            conflict_policy: ConflictPolicy::Replace,
            source_identities: vec![None],
            target_paths: vec![Some("/tmp/destination/source.txt".to_string())],
            started_items: vec![true],
            resolved_items: vec![false],
        };
        let action = UndoAction::RestoreBackup {
            backup_path: "/tmp/.imageexplorer-replaced-op-1".to_string(),
            original_path: "/tmp/destination/source.txt".to_string(),
            identity: None,
        };
        let pending = UndoAction::PendingCopy {
            source: "/tmp/source.txt".to_string(),
            path: "/tmp/destination/source.txt".to_string(),
            partial_path: "/tmp/.source.txt.imageexplorer-part".to_string(),
            identity: None,
        };
        let payload = serde_json::to_vec(&vec![PersistedOperationRecord {
            snapshot: snapshot("op-1", OperationStatus::Running, UndoStatus::Available),
            undo_actions: vec![action.clone(), pending.clone()],
            request: Some(request),
        }])
        .expect("serialize recovery state");

        let records = load_operation_records(&payload).expect("load recovery state");
        let record = records.get("op-1").expect("operation should be restored");

        assert_eq!(record.snapshot.status, OperationStatus::Failed);
        assert!(record.snapshot.retryable);
        assert_eq!(record.snapshot.undo_status, UndoStatus::Available);
        assert_eq!(record.undo_actions, vec![action, pending]);
        assert!(record
            .request
            .as_ref()
            .is_some_and(OperationRequest::has_unresolved_items));
        assert!(!record
            .cancel_requested
            .load(std::sync::atomic::Ordering::Acquire));
    }

    #[test]
    fn restart_recognizes_filesystem_work_persisted_before_final_status() {
        let request = OperationRequest {
            kind: OperationKind::Copy,
            paths: vec!["/tmp/source.txt".to_string()],
            destination: Some("/tmp/destination".to_string()),
            conflict_policy: ConflictPolicy::KeepBoth,
            source_identities: vec![None],
            target_paths: vec![Some("/tmp/destination/source.txt".to_string())],
            started_items: vec![true],
            resolved_items: vec![true],
        };
        let action = UndoAction::RemoveCreatedPath {
            path: "/tmp/destination/source.txt".to_string(),
            identity: None,
        };
        let payload = serde_json::to_vec(&vec![PersistedOperationRecord {
            snapshot: snapshot("op-complete", OperationStatus::Running, UndoStatus::None),
            undo_actions: vec![action.clone()],
            request: Some(request),
        }])
        .expect("serialize completed recovery state");

        let records = load_operation_records(&payload).expect("load recovery state");
        let record = records
            .get("op-complete")
            .expect("completed operation should be restored");

        assert_eq!(record.snapshot.status, OperationStatus::Completed);
        assert_eq!(record.snapshot.undo_status, UndoStatus::Available);
        assert!(!record.snapshot.retryable);
        assert_eq!(record.undo_actions, vec![action]);
    }

    #[test]
    fn legacy_snapshot_never_exposes_an_undo_without_actions() {
        let payload = serde_json::to_vec(&vec![snapshot(
            "legacy-op",
            OperationStatus::Completed,
            UndoStatus::Available,
        )])
        .expect("serialize legacy snapshot");

        let records = load_operation_records(&payload).expect("load legacy state");
        let record = records
            .get("legacy-op")
            .expect("legacy operation should load");

        assert_eq!(record.snapshot.undo_status, UndoStatus::None);
        assert!(!record.snapshot.retryable);
        assert!(record.undo_actions.is_empty());
    }

    #[test]
    fn recovery_state_is_atomically_written_and_reloadable() {
        let root = test_root("persist-recovery");
        let state_path = root.join("operations.json");
        fs::create_dir_all(&root).expect("create test root");
        let payload = serde_json::to_vec(&vec![snapshot(
            "persisted-op",
            OperationStatus::Completed,
            UndoStatus::None,
        )])
        .expect("serialize seed state");
        let records = load_operation_records(&payload).expect("load seed records");

        persist_record_map_to_path(&records, &state_path).expect("persist recovery state");
        let reloaded = load_operation_records(&fs::read(&state_path).expect("read state"))
            .expect("reload persisted state");

        assert!(reloaded.contains_key("persisted-op"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&state_path)
                    .expect("state metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[test]
    fn replacement_backup_restores_the_original_bytes_idempotently() {
        let root = test_root("replacement-restore");
        fs::create_dir_all(&root).expect("create test root");
        let original = root.join("photo.raw");
        let backup = root.join(".imageexplorer-replaced-op-1-0");
        fs::write(&original, b"original").expect("write original target");
        let identity = source_identity(&original).expect("capture original target identity");
        fs::rename(&original, &backup).expect("stage recovery backup");
        fs::write(&original, b"replacement").expect("write replacement target");
        fs::remove_file(&original).expect("remove replacement before restore");

        restore_backup(
            &backup.to_string_lossy(),
            &original.to_string_lossy(),
            Some(&identity),
        )
        .expect("restore original target");
        assert_eq!(
            fs::read(&original).expect("read restored target"),
            b"original"
        );
        restore_backup(
            &backup.to_string_lossy(),
            &original.to_string_lossy(),
            Some(&identity),
        )
        .expect("repeating a completed restore should be safe");

        fs::remove_dir_all(root).expect("remove test root");
    }
}
