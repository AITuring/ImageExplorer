//! Persistent bounded disk LRU cache for binary thumbnails (`thumb://`).
//!
//! Sits behind the in-memory `THUMB_BYTES_CACHE` (L1) as an L2 cache in the OS
//! cache directory (`~/Library/Caches/com.hyperexplorer.app/thumbs_v1` on macOS).
//! Cache keys already include `(path, size, mtime, requested_size, mode)`, so
//! entries automatically invalidate when source files change.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, SystemTime};

/// Maximum size of a single entry persisted to disk (2 MB). Oversized full-res
/// RAW zoom frames stay memory-only so they don't evict thousands of thumbnails.
const MAX_SINGLE_ENTRY_BYTES: usize = 2 * 1024 * 1024;
/// Total disk budget (512 MB).
const MAX_DISK_CACHE_BYTES: u64 = 512 * 1024 * 1024;
/// Target size after an LRU prune sweep (80% of budget).
const PRUNE_TARGET_BYTES: u64 = (MAX_DISK_CACHE_BYTES * 4) / 5;
/// Maximum cached thumbnail files on disk.
const MAX_DISK_CACHE_FILES: usize = 25_000;
/// Run a background prune check once every N writes.
const PRUNE_EVERY_N_WRITES: u64 = 128;

static WRITE_COUNTER: AtomicU64 = AtomicU64::new(0);
static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);
static PRUNE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

fn cache_root() -> &'static PathBuf {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        dirs::cache_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("com.hyperexplorer.app")
            .join("thumbs_v1")
    })
}

/// Deterministic 128-bit hash (two independent 64-bit FNV-1a lanes) producing a
/// 32-char lowercase hex string stable across Rust versions and app restarts.
pub(crate) fn stable_key_hash(key: &str) -> String {
    let mut h1: u64 = 0xcbf29ce484222325;
    let mut h2: u64 = 0x84222325cbf29ce4;
    for &byte in key.as_bytes() {
        h1 ^= u64::from(byte);
        h1 = h1.wrapping_mul(0x00000100000001b3);
        h2 = h2.wrapping_mul(0x9e3779b185ebca87);
        h2 ^= u64::from(byte).wrapping_add(0x517cc1b727220a95);
    }
    // Final avalanche mix
    h1 ^= h1 >> 33;
    h1 = h1.wrapping_mul(0xff51afd7ed558ccd);
    h1 ^= h1 >> 33;
    h2 ^= h2 >> 30;
    h2 = h2.wrapping_mul(0xbf58476d1ce4e5b9);
    h2 ^= h2 >> 27;
    format!("{h1:016x}{h2:016x}")
}

fn entry_path_in(root: &Path, key: &str) -> PathBuf {
    let hash = stable_key_hash(key);
    let shard = &hash[..2];
    root.join(shard).join(format!("{hash}.bin"))
}

pub(crate) fn get_in(root: &Path, key: &str) -> Option<Vec<u8>> {
    let path = entry_path_in(root, key);
    let bytes = fs::read(&path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    // Lazily refresh mtime at most once per hour so LRU tracks recency without
    // turning every read into a metadata write.
    if let Ok(meta) = fs::metadata(&path) {
        if let Ok(modified) = meta.modified() {
            if modified.elapsed().unwrap_or_default() > Duration::from_secs(3600) {
                touch_mtime(&path);
            }
        }
    }
    Some(bytes)
}

pub(crate) fn put_in(root: &Path, key: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_SINGLE_ENTRY_BYTES {
        return Ok(());
    }
    let path = entry_path_in(root, key);
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("tmp.{}.{seq}", std::process::id()));
    fs::write(&tmp, bytes).map_err(|error| error.to_string())?;
    if let Err(error) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(error.to_string());
    }
    Ok(())
}

pub(crate) fn prune_in(root: &Path, max_bytes: u64, target_bytes: u64, max_files: usize) {
    let Ok(shards) = fs::read_dir(root) else {
        return;
    };

    let mut entries: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    let mut total_bytes: u64 = 0;

    for shard in shards.flatten() {
        let shard_path = shard.path();
        if !shard_path.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(shard_path) else {
            continue;
        };
        for file in files.flatten() {
            let file_path = file.path();
            let Ok(meta) = file.metadata() else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let len = meta.len();
            let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            total_bytes = total_bytes.saturating_add(len);
            entries.push((file_path, len, modified));
        }
    }

    if total_bytes <= max_bytes && entries.len() <= max_files {
        return;
    }

    // Evict oldest-touched thumbnails first until within target budget.
    entries.sort_by_key(|(_, _, modified)| *modified);
    let mut remaining_files = entries.len();
    for (path, len, _) in entries {
        if total_bytes <= target_bytes && remaining_files <= max_files {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total_bytes = total_bytes.saturating_sub(len);
            remaining_files = remaining_files.saturating_sub(1);
        }
    }
}

#[cfg(unix)]
fn touch_mtime(path: &Path) {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    if let Ok(c_path) = CString::new(path.as_os_str().as_bytes()) {
        // SAFETY: NULL times sets atime/mtime to current time.
        unsafe {
            libc::utimes(c_path.as_ptr(), std::ptr::null());
        }
    }
}

#[cfg(not(unix))]
fn touch_mtime(_path: &Path) {}

/// Lookup a thumbnail in the persistent disk L2 cache.
pub fn get(key: &str) -> Option<Vec<u8>> {
    if cfg!(test) {
        return None;
    }
    get_in(cache_root(), key)
}

/// Persist a thumbnail to the disk L2 cache asynchronously so callers return
/// bytes to the WebView immediately without waiting for filesystem writes.
pub fn put_async(key: String, bytes: Arc<Vec<u8>>) {
    if cfg!(test) || bytes.is_empty() || bytes.len() > MAX_SINGLE_ENTRY_BYTES {
        return;
    }
    let root = cache_root().clone();
    std::thread::spawn(move || {
        if put_in(&root, &key, &bytes).is_ok() {
            let count = WRITE_COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
            if count.is_multiple_of(PRUNE_EVERY_N_WRITES)
                && PRUNE_IN_PROGRESS
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
            {
                prune_in(
                    &root,
                    MAX_DISK_CACHE_BYTES,
                    PRUNE_TARGET_BYTES,
                    MAX_DISK_CACHE_FILES,
                );
                PRUNE_IN_PROGRESS.store(false, Ordering::Release);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{get_in, prune_in, put_in, stable_key_hash};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_cache_dir(label: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "imageexplorer-thumb-disk-cache-{label}-{}-{nanos}",
            std::process::id()
        ))
    }

    #[test]
    fn stable_key_hash_is_deterministic_and_distinct() {
        let first = stable_key_hash("file:/photos/a.arw:100:200:288:embedded");
        let again = stable_key_hash("file:/photos/a.arw:100:200:288:embedded");
        let changed = stable_key_hash("file:/photos/a.arw:100:201:288:embedded");
        assert_eq!(first.len(), 32);
        assert_eq!(first, again);
        assert_ne!(first, changed);
    }

    #[test]
    fn disk_cache_round_trips_and_prunes_oldest_entries_when_over_budget() {
        let root = temp_cache_dir("prune");
        let payload_a = vec![0xAA; 1024];
        let payload_b = vec![0xBB; 1024];
        let payload_c = vec![0xCC; 1024];

        put_in(&root, "k1", &payload_a).expect("put k1");
        std::thread::sleep(std::time::Duration::from_millis(15));
        put_in(&root, "k2", &payload_b).expect("put k2");
        std::thread::sleep(std::time::Duration::from_millis(15));
        put_in(&root, "k3", &payload_c).expect("put k3");

        assert_eq!(get_in(&root, "k1"), Some(payload_a));
        assert_eq!(get_in(&root, "k2"), Some(payload_b.clone()));
        assert_eq!(get_in(&root, "k3"), Some(payload_c.clone()));

        // Enforce 2048-byte limit -> oldest entry (k1) must be evicted.
        prune_in(&root, 2048, 2048, 100);
        assert_eq!(get_in(&root, "k1"), None);
        assert_eq!(get_in(&root, "k2"), Some(payload_b));
        assert_eq!(get_in(&root, "k3"), Some(payload_c));

        let _ = fs::remove_dir_all(root);
    }
}
