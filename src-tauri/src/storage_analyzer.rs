//! Parallel directory storage analyzer & 3-stage exact duplicate file finder.
//!
//! - `analyze_directory_storage_blocking`: computes recursive byte totals for
//!   each immediate child in parallel via `rayon`, plus the top 30 largest
//!   individual files in the subtree.
//! - `find_duplicate_files_blocking`: uses a 3-stage pipeline (exact size ->
//!   64KB head+tail fast digest -> full streaming 128-bit digest) so non-duplicate
//!   files never read their full payload from disk.

use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

const PARTIAL_CHUNK_BYTES: usize = 64 * 1024;
const FULL_HASH_BUF_BYTES: usize = 128 * 1024;
const MAX_LARGEST_FILES: usize = 30;

type DigestKey = (u64, u64);
type FileCandidate = (PathBuf, Option<u64>);

struct HashedCandidate {
    size: u64,
    digest: DigestKey,
    path: PathBuf,
    modified: Option<u64>,
}

pub struct StorageAnalysisState {
    latest_request_id: AtomicU64,
}

impl Default for StorageAnalysisState {
    fn default() -> Self {
        Self {
            latest_request_id: AtomicU64::new(0),
        }
    }
}

impl StorageAnalysisState {
    pub fn begin(&self, request_id: u64) {
        self.latest_request_id
            .fetch_max(request_id, Ordering::SeqCst);
    }

    pub fn cancel(&self, request_id: u64) {
        self.latest_request_id
            .fetch_max(request_id, Ordering::SeqCst);
    }

    fn is_cancelled(&self, request_id: u64) -> bool {
        self.latest_request_id.load(Ordering::SeqCst) > request_id
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageChildEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub bytes: u64,
    pub file_count: u64,
    pub percent: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFileEntry {
    pub name: String,
    pub path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryStorageReport {
    pub path: String,
    pub total_bytes: u64,
    pub total_files: u64,
    pub total_dirs: u64,
    pub children: Vec<StorageChildEntry>,
    pub largest_files: Vec<LargeFileEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateFileItem {
    pub name: String,
    pub path: String,
    pub modified: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateGroup {
    pub hash: String,
    pub file_size: u64,
    pub wasted_bytes: u64,
    pub files: Vec<DuplicateFileItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateFilesReport {
    pub path: String,
    pub scanned_files: u64,
    pub group_count: usize,
    pub wasted_bytes: u64,
    pub groups: Vec<DuplicateGroup>,
}

fn walk_subtree_stats(
    root: &Path,
    state: &StorageAnalysisState,
    request_id: u64,
) -> Result<(u64, u64, u64, Vec<LargeFileEntry>), String> {
    let mut total_bytes = 0u64;
    let mut total_files = 0u64;
    let mut total_dirs = 0u64;
    let mut largest: Vec<LargeFileEntry> = Vec::new();
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if state.is_cancelled(request_id) {
            return Err("Storage analysis cancelled".to_string());
        }
        let Ok(read_dir) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in read_dir.flatten() {
            let entry_path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&entry_path) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                total_dirs += 1;
                stack.push(entry_path);
            } else if meta.is_file() {
                let len = meta.len();
                total_bytes = total_bytes.saturating_add(len);
                total_files += 1;

                if largest.len() < MAX_LARGEST_FILES || len > largest.last().map_or(0, |f| f.bytes)
                {
                    let name = entry.file_name().to_string_lossy().to_string();
                    largest.push(LargeFileEntry {
                        name,
                        path: entry_path.to_string_lossy().to_string(),
                        bytes: len,
                    });
                    largest.sort_by_key(|a| std::cmp::Reverse(a.bytes));
                    if largest.len() > MAX_LARGEST_FILES {
                        largest.truncate(MAX_LARGEST_FILES);
                    }
                }
            }
        }
    }

    Ok((total_bytes, total_files, total_dirs, largest))
}

pub fn analyze_directory_storage_blocking(
    root: &Path,
    state: &StorageAnalysisState,
    request_id: u64,
) -> Result<DirectoryStorageReport, String> {
    state.begin(request_id);
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", root.display()));
    }

    let direct_entries: Vec<(String, PathBuf, bool, u64)> = fs::read_dir(root)
        .map_err(|error| format!("Failed to read {}: {error}", root.display()))?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let meta = fs::symlink_metadata(&path).ok()?;
            if meta.file_type().is_symlink() {
                return None;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            Some((name, path, meta.is_dir(), meta.len()))
        })
        .collect();

    let per_child: Result<Vec<(StorageChildEntry, u64, Vec<LargeFileEntry>)>, String> =
        direct_entries
            .into_par_iter()
            .map(|(name, path, is_dir, direct_len)| {
                if state.is_cancelled(request_id) {
                    return Err("Storage analysis cancelled".to_string());
                }
                if is_dir {
                    let (bytes, files, dirs, largest) =
                        walk_subtree_stats(&path, state, request_id)?;
                    Ok((
                        StorageChildEntry {
                            name,
                            path: path.to_string_lossy().to_string(),
                            is_dir: true,
                            bytes,
                            file_count: files,
                            percent: 0.0,
                        },
                        dirs + 1,
                        largest,
                    ))
                } else {
                    let path_str = path.to_string_lossy().to_string();
                    Ok((
                        StorageChildEntry {
                            name: name.clone(),
                            path: path_str.clone(),
                            is_dir: false,
                            bytes: direct_len,
                            file_count: 1,
                            percent: 0.0,
                        },
                        0,
                        vec![LargeFileEntry {
                            name,
                            path: path_str,
                            bytes: direct_len,
                        }],
                    ))
                }
            })
            .collect();

    let per_child = per_child?;
    let mut total_bytes = 0u64;
    let mut total_files = 0u64;
    let mut total_dirs = 0u64;
    let mut children = Vec::with_capacity(per_child.len());
    let mut largest_files = Vec::new();

    for (child, dirs, mut child_largest) in per_child {
        total_bytes = total_bytes.saturating_add(child.bytes);
        total_files = total_files.saturating_add(child.file_count);
        total_dirs = total_dirs.saturating_add(dirs);
        children.push(child);
        largest_files.append(&mut child_largest);
    }

    for child in &mut children {
        child.percent = if total_bytes > 0 {
            (child.bytes as f64 / total_bytes as f64) * 100.0
        } else {
            0.0
        };
    }

    children.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.name.cmp(&b.name)));
    largest_files.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.name.cmp(&b.name)));
    largest_files.truncate(MAX_LARGEST_FILES);

    Ok(DirectoryStorageReport {
        path: root.to_string_lossy().to_string(),
        total_bytes,
        total_files,
        total_dirs,
        children,
        largest_files,
    })
}

/// Dual-seed 128-bit streaming content hasher (two independent 64-bit FNV-1a
/// lanes mixed with distinct primes & initializers).
struct Digest128 {
    a: u64,
    b: u64,
}

impl Digest128 {
    fn new() -> Self {
        Self {
            a: 0xcbf2_9ce4_8422_2325,
            b: 0x8422_2325_cbf2_9ce4,
        }
    }

    fn update(&mut self, bytes: &[u8]) {
        for (idx, &byte) in bytes.iter().enumerate() {
            self.a ^= u64::from(byte);
            self.a = self.a.wrapping_mul(0x0000_0100_0000_01b3);

            self.b ^= u64::from(byte).wrapping_add((idx as u64).wrapping_mul(0x9e37_79b9));
            self.b = self.b.wrapping_mul(0x0000_0100_0000_01b3).rotate_left(7);
        }
    }

    fn finish(self) -> (u64, u64) {
        (self.a, self.b)
    }
}

fn partial_file_digest(path: &Path, size: u64) -> Option<(u64, u64)> {
    let mut file = File::open(path).ok()?;
    let mut digest = Digest128::new();
    digest.update(&size.to_le_bytes());

    let mut buf = vec![0u8; PARTIAL_CHUNK_BYTES.min(size as usize)];
    let n = file.read(&mut buf).ok()?;
    digest.update(&buf[..n]);

    if size > PARTIAL_CHUNK_BYTES as u64 {
        let tail_start = size.saturating_sub(PARTIAL_CHUNK_BYTES as u64);
        file.seek(SeekFrom::Start(tail_start)).ok()?;
        let tail_len = (size - tail_start) as usize;
        let mut tail_buf = vec![0u8; tail_len];
        let n_tail = file.read(&mut tail_buf).ok()?;
        digest.update(&tail_buf[..n_tail]);
    }

    Some(digest.finish())
}

fn full_file_digest(
    path: &Path,
    size: u64,
    state: &StorageAnalysisState,
    request_id: u64,
) -> Result<Option<(u64, u64)>, String> {
    let Ok(mut file) = File::open(path) else {
        return Ok(None);
    };
    let mut digest = Digest128::new();
    digest.update(&size.to_le_bytes());

    let mut buf = vec![0u8; FULL_HASH_BUF_BYTES];
    loop {
        if state.is_cancelled(request_id) {
            return Err("Duplicate scan cancelled".to_string());
        }
        let Ok(n) = file.read(&mut buf) else {
            return Ok(None);
        };
        if n == 0 {
            break;
        }
        digest.update(&buf[..n]);
    }
    Ok(Some(digest.finish()))
}

pub fn find_duplicate_files_blocking(
    root: &Path,
    state: &StorageAnalysisState,
    request_id: u64,
) -> Result<DuplicateFilesReport, String> {
    state.begin(request_id);
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", root.display()));
    }

    // Stage 1: Group non-empty regular files by exact size.
    let mut by_size: HashMap<u64, Vec<(PathBuf, Option<u64>)>> = HashMap::new();
    let mut scanned_files = 0u64;
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        if state.is_cancelled(request_id) {
            return Err("Duplicate scan cancelled".to_string());
        }
        let Ok(read_dir) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in read_dir.flatten() {
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() {
                scanned_files += 1;
                let len = meta.len();
                if len == 0 {
                    continue;
                }
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs());
                by_size.entry(len).or_default().push((path, modified));
            }
        }
    }

    // Stage 2: Partial 64KB head+tail digest for size collisions.
    let size_candidates: Vec<(u64, PathBuf, Option<u64>)> = by_size
        .into_iter()
        .filter(|(_, files)| files.len() >= 2)
        .flat_map(|(size, files)| {
            files
                .into_iter()
                .map(move |(path, modified)| (size, path, modified))
        })
        .collect();

    let partial_hashed: Vec<HashedCandidate> = size_candidates
        .into_par_iter()
        .filter_map(|(size, path, modified)| {
            if state.is_cancelled(request_id) {
                return None;
            }
            let digest = partial_file_digest(&path, size)?;
            Some(HashedCandidate {
                size,
                digest,
                path,
                modified,
            })
        })
        .collect();

    if state.is_cancelled(request_id) {
        return Err("Duplicate scan cancelled".to_string());
    }

    let mut by_partial: HashMap<(u64, DigestKey), Vec<FileCandidate>> = HashMap::new();
    for item in partial_hashed {
        by_partial
            .entry((item.size, item.digest))
            .or_default()
            .push((item.path, item.modified));
    }

    // Stage 3: Full streaming 128-bit digest for partial-hash collisions.
    let full_candidates: Vec<(u64, PathBuf, Option<u64>)> = by_partial
        .into_iter()
        .filter(|(_, files)| files.len() >= 2)
        .flat_map(|((size, _), files)| {
            files
                .into_iter()
                .map(move |(path, modified)| (size, path, modified))
        })
        .collect();

    let full_hashed: Result<Vec<Option<HashedCandidate>>, String> = full_candidates
        .into_par_iter()
        .map(|(size, path, modified)| {
            let maybe_digest = full_file_digest(&path, size, state, request_id)?;
            Ok(maybe_digest.map(|digest| HashedCandidate {
                size,
                digest,
                path,
                modified,
            }))
        })
        .collect();

    let mut by_full: HashMap<(u64, DigestKey), Vec<DuplicateFileItem>> = HashMap::new();
    for item in full_hashed?.into_iter().flatten() {
        let name = item
            .path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        by_full
            .entry((item.size, item.digest))
            .or_default()
            .push(DuplicateFileItem {
                name,
                path: item.path.to_string_lossy().to_string(),
                modified: item.modified,
            });
    }

    let mut groups = Vec::new();
    let mut total_wasted = 0u64;
    for ((file_size, (ha, hb)), mut files) in by_full {
        if files.len() < 2 {
            continue;
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let wasted_bytes = file_size.saturating_mul((files.len() - 1) as u64);
        total_wasted = total_wasted.saturating_add(wasted_bytes);
        groups.push(DuplicateGroup {
            hash: format!("{ha:016x}{hb:016x}"),
            file_size,
            wasted_bytes,
            files,
        });
    }

    groups.sort_by_key(|a| std::cmp::Reverse(a.wasted_bytes));

    Ok(DuplicateFilesReport {
        path: root.to_string_lossy().to_string(),
        scanned_files,
        group_count: groups.len(),
        wasted_bytes: total_wasted,
        groups,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        analyze_directory_storage_blocking, find_duplicate_files_blocking, StorageAnalysisState,
    };
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(prefix: &str) -> std::path::PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("imageexplorer-{prefix}-{stamp}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn storage_analyzer_ranks_children_and_largest_files() {
        let root = temp_dir("storage");
        let sub_a = root.join("BigFolder");
        let sub_b = root.join("SmallFolder");
        fs::create_dir_all(&sub_a).expect("sub_a");
        fs::create_dir_all(&sub_b).expect("sub_b");
        fs::write(sub_a.join("huge.bin"), vec![1u8; 4096]).expect("huge");
        fs::write(sub_b.join("tiny.bin"), vec![2u8; 512]).expect("tiny");
        fs::write(root.join("root.bin"), vec![3u8; 1024]).expect("root");

        let state = StorageAnalysisState::default();
        let report = analyze_directory_storage_blocking(&root, &state, 1).expect("analyze storage");
        assert_eq!(report.total_bytes, 4096 + 512 + 1024);
        assert_eq!(report.total_files, 3);
        assert_eq!(report.children[0].name, "BigFolder");
        assert_eq!(report.children[0].bytes, 4096);
        assert_eq!(report.largest_files[0].name, "huge.bin");

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn duplicate_finder_detects_exact_duplicates_and_ignores_same_size_distinct_files() {
        let root = temp_dir("dupes");
        let sub = root.join("copy");
        fs::create_dir_all(&sub).expect("sub");

        let payload_a = vec![0xAA; 200_000];
        let mut payload_b = vec![0xAA; 200_000];
        // Same head & tail 64KB, differs only in the middle -> Stage 3 must distinguish them!
        payload_b[100_000] = 0x55;

        fs::write(root.join("orig.jpg"), &payload_a).expect("orig");
        fs::write(sub.join("dup.jpg"), &payload_a).expect("dup");
        fs::write(root.join("same_size_diff_mid.jpg"), &payload_b).expect("diff");
        fs::write(root.join("unique.txt"), b"hello").expect("unique");

        let state = StorageAnalysisState::default();
        let report = find_duplicate_files_blocking(&root, &state, 1).expect("find dupes");
        assert_eq!(report.scanned_files, 4);
        assert_eq!(report.group_count, 1);
        assert_eq!(report.wasted_bytes, 200_000);
        assert_eq!(report.groups[0].files.len(), 2);

        fs::remove_dir_all(root).expect("cleanup");
    }
}
