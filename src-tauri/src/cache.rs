/**
 * 全局缓存模块
 * 提供目录列表和图标的跨窗口共享缓存
 */
use dashmap::DashMap;
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

use crate::commands::fs::FileEntry;

/// 缓存条目（带时间戳）
struct CacheEntry<T> {
    data: T,
    timestamp: Instant,
}

/// 目录缓存有效期（5分钟）
const DIR_CACHE_TTL: Duration = Duration::from_secs(300);

/// 图标缓存有效期（1小时）
const ICON_CACHE_TTL: Duration = Duration::from_secs(3600);

/// 缓存大小上限
const MAX_DIR_CACHE_ENTRIES: usize = 500;
const MAX_ICON_CACHE_ENTRIES: usize = 1200;
const MAX_ICON_CACHE_BYTES: usize = 64 * 1024 * 1024;

/// 目录列表缓存
static DIR_CACHE: Lazy<DashMap<String, CacheEntry<Vec<FileEntry>>>> = Lazy::new(DashMap::new);

/// Serializes cache publication with invalidation so an in-flight scan cannot
/// put an older directory snapshot back after a change event removed it.
static DIR_CACHE_GATE: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static DIR_CACHE_GENERATION: AtomicU64 = AtomicU64::new(0);

/// 图标缓存
static ICON_CACHE: Lazy<DashMap<String, CacheEntry<String>>> = Lazy::new(DashMap::new);

/// 淘汰过期条目，如果仍超限则移除最旧的条目
fn evict_cache<T>(cache: &DashMap<String, CacheEntry<T>>, ttl: Duration, max_size: usize) {
    // 先移除过期条目
    cache.retain(|_, entry| entry.timestamp.elapsed() <= ttl);

    // 如果仍超限，移除最旧的条目
    while cache.len() > max_size {
        let oldest = cache
            .iter()
            .max_by_key(|entry| entry.value().timestamp.elapsed())
            .map(|entry| entry.key().clone());
        if let Some(key) = oldest {
            cache.remove(&key);
        } else {
            break;
        }
    }
}

/// Read the directory cache and its generation as one snapshot.
pub fn get_dir_cache_snapshot(path: &str) -> (u64, Option<Vec<FileEntry>>) {
    let _guard = DIR_CACHE_GATE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let generation = DIR_CACHE_GENERATION.load(Ordering::Acquire);
    let cached = if let Some(entry) = DIR_CACHE.get(path) {
        if entry.timestamp.elapsed() > DIR_CACHE_TTL {
            drop(entry);
            DIR_CACHE.remove(path);
            None
        } else {
            Some(entry.data.clone())
        }
    } else {
        None
    };

    (generation, cached)
}

/// Publish a scan only if no directory change occurred after it started.
pub fn set_dir_cache_if_generation(
    path: String,
    entries: Vec<FileEntry>,
    expected_generation: u64,
) -> bool {
    let _guard = DIR_CACHE_GATE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if DIR_CACHE_GENERATION.load(Ordering::Acquire) != expected_generation {
        return false;
    }

    if DIR_CACHE.len() >= MAX_DIR_CACHE_ENTRIES {
        evict_cache(&DIR_CACHE, DIR_CACHE_TTL, MAX_DIR_CACHE_ENTRIES);
    }
    DIR_CACHE.insert(
        path,
        CacheEntry {
            data: entries,
            timestamp: Instant::now(),
        },
    );
    true
}

/// 清除目录缓存
pub fn invalidate_dir_cache(path: &str) {
    let _guard = DIR_CACHE_GATE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    DIR_CACHE_GENERATION.fetch_add(1, Ordering::AcqRel);
    DIR_CACHE.remove(path);
}

/// Invalidate backend data before notifying every window to discard its local
/// snapshot and reload the changed directory.
pub fn notify_dir_change(app: &AppHandle, path: &str) {
    invalidate_dir_cache(path);
    let _ = app.emit("dir-change", path.to_string());
}

/// 获取图标缓存
pub fn get_icon_cache(key: &str) -> Option<String> {
    let entry = ICON_CACHE.get(key)?;
    if entry.timestamp.elapsed() > ICON_CACHE_TTL {
        drop(entry);
        ICON_CACHE.remove(key);
        return None;
    }
    Some(entry.data.clone())
}

/// 设置图标缓存
pub fn set_icon_cache(key: String, base64: String) {
    ICON_CACHE.insert(
        key,
        CacheEntry {
            data: base64,
            timestamp: Instant::now(),
        },
    );

    // Thumbnail values are base64 strings and can be much larger than normal
    // application icons. Bound both count and payload size so visiting a
    // multi-thousand RAW folder cannot retain hundreds of megabytes forever.
    evict_cache(&ICON_CACHE, ICON_CACHE_TTL, MAX_ICON_CACHE_ENTRIES);
    while icon_cache_bytes() > MAX_ICON_CACHE_BYTES {
        let oldest = ICON_CACHE
            .iter()
            .max_by_key(|entry| entry.value().timestamp.elapsed())
            .map(|entry| entry.key().clone());
        if let Some(key) = oldest {
            ICON_CACHE.remove(&key);
        } else {
            break;
        }
    }
}

fn icon_cache_bytes() -> usize {
    ICON_CACHE
        .iter()
        .map(|entry| entry.value().data.len())
        .sum()
}

/// 获取目录缓存大小（用于调试）
#[allow(dead_code)]
pub fn dir_cache_size() -> usize {
    DIR_CACHE.len()
}

/// 获取图标缓存大小（用于调试）
#[allow(dead_code)]
pub fn icon_cache_size() -> usize {
    ICON_CACHE.len()
}

#[cfg(test)]
mod tests {
    use super::{get_dir_cache_snapshot, invalidate_dir_cache, set_dir_cache_if_generation};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn directory_cache_rejects_a_scan_started_before_invalidation() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be valid")
            .as_nanos();
        let path = format!("cache-generation-{}-{suffix}", std::process::id());
        let (started_generation, cached) = get_dir_cache_snapshot(&path);
        assert!(cached.is_none());

        invalidate_dir_cache(&path);

        assert!(!set_dir_cache_if_generation(
            path.clone(),
            Vec::new(),
            started_generation
        ));
        assert!(get_dir_cache_snapshot(&path).1.is_none());
    }
}
