/**
 * 全局缓存模块
 * 提供目录列表和图标的跨窗口共享缓存
 */
use dashmap::DashMap;
use once_cell::sync::Lazy;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
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

/// 目录列表缓存（使用 Arc 避免 10 万条目录在读写缓存时深拷贝）
static DIR_CACHE: Lazy<DashMap<String, CacheEntry<Arc<Vec<FileEntry>>>>> = Lazy::new(DashMap::new);

/// Serializes cache publication with invalidation so an in-flight scan cannot
/// put an older directory snapshot back after a change event removed it.
static DIR_CACHE_GATE: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static DIR_CACHE_GENERATION: AtomicU64 = AtomicU64::new(0);

struct IconLruEntry {
    data: String,
    timestamp: Instant,
    sequence: u64,
}

#[derive(Default)]
struct IconLruCache {
    entries: HashMap<String, IconLruEntry>,
    order: VecDeque<(String, u64)>,
    total_bytes: usize,
    next_sequence: u64,
}

impl IconLruCache {
    fn get(&mut self, key: &str) -> Option<String> {
        let expired = self
            .entries
            .get(key)
            .is_some_and(|entry| entry.timestamp.elapsed() > ICON_CACHE_TTL);
        if expired {
            if let Some(removed) = self.entries.remove(key) {
                self.total_bytes = self.total_bytes.saturating_sub(removed.data.len());
            }
            return None;
        }

        let seq = self.next_sequence.wrapping_add(1);
        self.next_sequence = seq;
        let data = {
            let entry = self.entries.get_mut(key)?;
            entry.sequence = seq;
            entry.data.clone()
        };
        self.order.push_back((key.to_string(), seq));
        self.compact_order_if_needed();
        Some(data)
    }

    fn insert(&mut self, key: String, base64: String) {
        let new_bytes = base64.len();
        let seq = self.next_sequence.wrapping_add(1);
        self.next_sequence = seq;
        if let Some(previous) = self.entries.insert(
            key.clone(),
            IconLruEntry {
                data: base64,
                timestamp: Instant::now(),
                sequence: seq,
            },
        ) {
            self.total_bytes = self.total_bytes.saturating_sub(previous.data.len());
        }
        self.total_bytes = self.total_bytes.saturating_add(new_bytes);
        self.order.push_back((key, seq));
        self.evict_if_needed();
    }

    fn evict_if_needed(&mut self) {
        // Evict stale queue entries and expired/oldest entries in amortized O(1).
        while let Some((oldest_key, oldest_seq)) = self.order.front() {
            let Some(entry) = self.entries.get(oldest_key) else {
                self.order.pop_front();
                continue;
            };
            if entry.sequence != *oldest_seq {
                self.order.pop_front();
                continue;
            }
            let over_limit = self.entries.len() > MAX_ICON_CACHE_ENTRIES
                || self.total_bytes > MAX_ICON_CACHE_BYTES;
            let expired = entry.timestamp.elapsed() > ICON_CACHE_TTL;
            if !over_limit && !expired {
                break;
            }
            let (evict_key, _) = self.order.pop_front().expect("front exists");
            if let Some(removed) = self.entries.remove(&evict_key) {
                self.total_bytes = self.total_bytes.saturating_sub(removed.data.len());
            }
        }
        self.compact_order_if_needed();
    }

    fn compact_order_if_needed(&mut self) {
        if self.order.len() > self.entries.len().saturating_mul(4).max(256) {
            self.order.retain(|(key, seq)| {
                self.entries
                    .get(key)
                    .is_some_and(|entry| entry.sequence == *seq)
            });
        }
    }

    #[allow(dead_code)]
    fn len(&self) -> usize {
        self.entries.len()
    }
}

/// 图标缓存（O(1) 均摊 LRU + 字节预算）
static ICON_CACHE: Lazy<Mutex<IconLruCache>> = Lazy::new(|| Mutex::new(IconLruCache::default()));

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
pub fn get_dir_cache_snapshot(path: &str) -> (u64, Option<Arc<Vec<FileEntry>>>) {
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
            Some(Arc::clone(&entry.data))
        }
    } else {
        None
    };

    (generation, cached)
}

/// Publish a scan only if no directory change occurred after it started.
pub fn set_dir_cache_if_generation(
    path: String,
    entries: Arc<Vec<FileEntry>>,
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
    let mut cache = ICON_CACHE.lock().unwrap_or_else(|error| error.into_inner());
    cache.get(key)
}

/// 设置图标缓存
pub fn set_icon_cache(key: String, base64: String) {
    let mut cache = ICON_CACHE.lock().unwrap_or_else(|error| error.into_inner());
    cache.insert(key, base64);
}

/// 获取目录缓存大小（用于调试）
#[allow(dead_code)]
pub fn dir_cache_size() -> usize {
    DIR_CACHE.len()
}

/// 获取图标缓存大小（用于调试）
#[allow(dead_code)]
pub fn icon_cache_size() -> usize {
    ICON_CACHE
        .lock()
        .map(|cache| cache.len())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{get_dir_cache_snapshot, invalidate_dir_cache, set_dir_cache_if_generation};
    use std::sync::Arc;
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
            Arc::new(Vec::new()),
            started_generation
        ));
        assert!(get_dir_cache_snapshot(&path).1.is_none());
    }
}
