use base64::Engine;
use once_cell::sync::Lazy;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "macos")]
use std::ffi::CString;

#[cfg(target_os = "macos")]
extern "C" {
    fn imageexplorer_extract_face_embeddings(
        path: *const libc::c_char,
        out_length: *mut usize,
    ) -> *mut u8;
    fn imageexplorer_extract_face_embeddings_from_bytes(
        bytes: *const u8,
        length: usize,
        out_length: *mut usize,
    ) -> *mut u8;
    fn imageexplorer_free_thumbnail(bytes: *mut u8);
}

const COMPANION_EXTS: &[&str] = &["xmp", "acr", "dop", "pp3"];

static ACTIVE_PEOPLE_SCAN_ID: AtomicU64 = AtomicU64::new(0);
static ACTIVE_PEOPLE_CANCEL: Lazy<Mutex<Option<Arc<AtomicBool>>>> = Lazy::new(|| Mutex::new(None));
static LAST_SCAN_SESSION: Lazy<Mutex<Option<CachedPeopleSession>>> = Lazy::new(|| Mutex::new(None));

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawVisionFace {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    area: f64,
    embedding_b64: String,
    avatar_b64: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FaceEmbeddingSample {
    pub photo_index: usize,
    pub area: f64,
    pub embedding: Vec<f32>,
    pub avatar_b64: Option<String>,
}

#[derive(Debug, Clone)]
struct ScannedPhotoRecord {
    path: String,
    file_name: String,
    modified: Option<i64>,
    size: u64,
    companions: Vec<String>,
}

#[derive(Debug, Clone)]
struct CachedPeopleSession {
    scan_id: u64,
    directory: String,
    photos: Vec<ScannedPhotoRecord>,
    faces: Vec<FaceEmbeddingSample>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonCluster {
    pub person_id: String,
    pub default_name: String,
    pub avatar_data_url: Option<String>,
    pub face_count: usize,
    pub photo_paths: Vec<String>,
    pub solo_photo_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeoplePhotoSummary {
    pub path: String,
    pub file_name: String,
    pub modified: Option<i64>,
    pub size: u64,
    pub companion_files: Vec<String>,
    pub person_ids: Vec<String>,
    pub primary_person_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeopleScanResult {
    pub scan_id: u64,
    pub directory: String,
    pub cancelled: bool,
    pub threshold: f32,
    pub total_photos: usize,
    pub total_faces: usize,
    pub people: Vec<PersonCluster>,
    pub group_photo_paths: Vec<String>,
    pub no_face_photo_paths: Vec<String>,
    pub photos: Vec<PeoplePhotoSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PeopleScanProgressEvent {
    pub scan_id: u64,
    pub processed: usize,
    pub total: usize,
    pub faces_found: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeopleScanRequest {
    pub directory: String,
    #[serde(default)]
    pub selected_paths: Vec<String>,
    #[serde(default = "default_threshold")]
    pub threshold: f32,
}

fn default_threshold() -> f32 {
    0.64
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeopleOrganizeAssignment {
    pub source_path: String,
    pub target_folder_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeopleOrganizeRequest {
    pub directory: String,
    pub assignments: Vec<PeopleOrganizeAssignment>,
    /// "move" | "copy"
    #[serde(default = "default_organize_mode")]
    pub mode: String,
    #[serde(default = "default_true")]
    pub include_companions: bool,
}

fn default_organize_mode() -> String {
    "move".to_string()
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedOrganizeOp {
    pub from: String,
    pub to: String,
    pub is_copy: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeopleOrganizeResult {
    pub organized_photos: usize,
    pub organized_companions: usize,
    pub created_folders: Vec<String>,
    pub failed: Vec<String>,
    pub completed_ops: Vec<CompletedOrganizeOp>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeopleUndoResult {
    pub restored: usize,
    pub failed: Vec<String>,
}

fn is_raw_ext(ext: &str) -> bool {
    matches!(
        ext,
        "arw"
            | "cr2"
            | "cr3"
            | "nef"
            | "nrw"
            | "raf"
            | "orf"
            | "rw2"
            | "pef"
            | "srw"
            | "dcr"
            | "kdc"
            | "3fr"
            | "iiq"
            | "x3f"
            | "dng"
    )
}

fn is_portrait_photo_ext(ext: &str) -> bool {
    matches!(
        ext,
        "jpg" | "jpeg" | "heic" | "heif" | "png" | "webp" | "tif" | "tiff" | "avif"
    ) || is_raw_ext(ext)
}

fn decode_embedding_b64(b64: &str) -> Option<Vec<f32>> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut floats = Vec::with_capacity(bytes.len() / 4);
    for &chunk in bytes.as_chunks::<4>().0 {
        floats.push(f32::from_le_bytes(chunk));
    }
    Some(floats)
}

type ExtractedFace = (f64, Vec<f32>, Option<String>);

#[cfg(target_os = "macos")]
fn extract_faces_for_photo(path: &Path) -> Vec<ExtractedFace> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    let mut out_len: usize = 0;
    let mut ptr: *mut u8 = std::ptr::null_mut();

    if is_raw_ext(&ext) {
        if let Some(embedded) = crate::raw_preview::extract_embedded_jpeg_from_path(path) {
            ptr = unsafe {
                imageexplorer_extract_face_embeddings_from_bytes(
                    embedded.as_ptr(),
                    embedded.len(),
                    &mut out_len,
                )
            };
        }
    }

    if ptr.is_null() {
        if let Ok(c_path) = CString::new(path.to_string_lossy().as_bytes()) {
            ptr = unsafe { imageexplorer_extract_face_embeddings(c_path.as_ptr(), &mut out_len) };
        }
    }

    if ptr.is_null() || out_len == 0 {
        return Vec::new();
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) }.to_vec();
    unsafe { imageexplorer_free_thumbnail(ptr) };

    let raw_faces = serde_json::from_slice::<Vec<RawVisionFace>>(&bytes).unwrap_or_default();
    let mut out = Vec::with_capacity(raw_faces.len());
    for face in raw_faces {
        let _ = (face.x, face.y, face.width, face.height);
        if let Some(emb) = decode_embedding_b64(&face.embedding_b64) {
            out.push((face.area, emb, face.avatar_b64));
        }
    }
    out
}

#[cfg(not(target_os = "macos"))]
fn extract_faces_for_photo(_path: &Path) -> Vec<ExtractedFace> {
    Vec::new()
}

fn dot_product(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

fn normalize_vec(vec: &mut [f32]) {
    let norm_sq: f32 = vec.iter().map(|v| v * v).sum();
    if norm_sq > 1e-12 {
        let inv = 1.0 / norm_sq.sqrt();
        for v in vec.iter_mut() {
            *v *= inv;
        }
    }
}

struct MutableCluster {
    centroid: Vec<f32>,
    sum_vec: Vec<f32>,
    member_indices: Vec<usize>,
    photo_set: HashSet<usize>,
    best_avatar: Option<String>,
    best_area: f64,
}

/// Cluster L2-normalized face embeddings using centroid assignment + agglomerative merge,
/// strictly enforcing a **cannot-link constraint** so two faces appearing in the exact
/// same photo are never merged into the same person cluster.
pub fn cluster_face_embeddings(faces: &[FaceEmbeddingSample], threshold: f32) -> Vec<Vec<usize>> {
    if faces.is_empty() {
        return Vec::new();
    }
    let clamped_threshold = threshold.clamp(0.40, 0.95);

    // Seed largest / sharpest portraits first so clean faces establish accurate centroids.
    let mut order: Vec<usize> = (0..faces.len()).collect();
    order.sort_by(|&a, &b| {
        faces[b]
            .area
            .partial_cmp(&faces[a].area)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut clusters: Vec<MutableCluster> = Vec::new();

    for face_idx in order {
        let sample = &faces[face_idx];
        let mut best_cluster: Option<usize> = None;
        let mut best_sim = clamped_threshold;

        for (c_idx, cluster) in clusters.iter().enumerate() {
            // Cannot-link: two distinct faces in the same photo cannot be the same person.
            if cluster.photo_set.contains(&sample.photo_index) {
                continue;
            }
            let sim = dot_product(&sample.embedding, &cluster.centroid);
            if sim >= best_sim {
                best_sim = sim;
                best_cluster = Some(c_idx);
            }
        }

        if let Some(c_idx) = best_cluster {
            let cluster = &mut clusters[c_idx];
            cluster.member_indices.push(face_idx);
            cluster.photo_set.insert(sample.photo_index);
            if cluster.sum_vec.len() == sample.embedding.len() {
                for (acc, &v) in cluster.sum_vec.iter_mut().zip(sample.embedding.iter()) {
                    *acc += v;
                }
                cluster.centroid.clone_from(&cluster.sum_vec);
                normalize_vec(&mut cluster.centroid);
            }
            if sample.area > cluster.best_area && sample.avatar_b64.is_some() {
                cluster.best_area = sample.area;
                cluster.best_avatar = sample.avatar_b64.clone();
            }
        } else {
            let mut centroid = sample.embedding.clone();
            normalize_vec(&mut centroid);
            let mut photo_set = HashSet::new();
            photo_set.insert(sample.photo_index);
            clusters.push(MutableCluster {
                sum_vec: centroid.clone(),
                centroid,
                member_indices: vec![face_idx],
                photo_set,
                best_avatar: sample.avatar_b64.clone(),
                best_area: sample.area,
            });
        }
    }

    // Agglomerative centroid refinement pass (still honoring cannot-link!)
    let merge_threshold = (clamped_threshold + 0.025).min(0.96);
    loop {
        let mut best_pair: Option<(usize, usize)> = None;
        let mut best_sim = merge_threshold;
        for i in 0..clusters.len() {
            for j in (i + 1)..clusters.len() {
                if !clusters[i].photo_set.is_disjoint(&clusters[j].photo_set) {
                    continue;
                }
                let sim = dot_product(&clusters[i].centroid, &clusters[j].centroid);
                if sim >= best_sim {
                    best_sim = sim;
                    best_pair = Some((i, j));
                }
            }
        }
        let Some((i, j)) = best_pair else {
            break;
        };
        let removed = clusters.remove(j);
        let target = &mut clusters[i];
        target.member_indices.extend(removed.member_indices);
        target.photo_set.extend(removed.photo_set);
        if target.sum_vec.len() == removed.sum_vec.len() {
            for (acc, v) in target.sum_vec.iter_mut().zip(removed.sum_vec) {
                *acc += v;
            }
            target.centroid.clone_from(&target.sum_vec);
            normalize_vec(&mut target.centroid);
        }
        if removed.best_area > target.best_area && removed.best_avatar.is_some() {
            target.best_area = removed.best_area;
            target.best_avatar = removed.best_avatar;
        }
    }

    clusters.sort_by_key(|c| std::cmp::Reverse(c.photo_set.len()));
    clusters.into_iter().map(|c| c.member_indices).collect()
}

fn build_scan_result_from_session(
    session: &CachedPeopleSession,
    threshold: f32,
) -> PeopleScanResult {
    let raw_clusters = cluster_face_embeddings(&session.faces, threshold);

    let mut photo_person_areas: Vec<Vec<(String, f64)>> = vec![Vec::new(); session.photos.len()];
    let mut people: Vec<PersonCluster> = Vec::with_capacity(raw_clusters.len());

    for (cluster_idx, member_face_indices) in raw_clusters.iter().enumerate() {
        let person_id = format!("person-{}", cluster_idx + 1);
        let default_name = format!("人物 {}", cluster_idx + 1);

        let mut best_avatar: Option<String> = None;
        let mut best_area = -1.0f64;
        let mut photo_indices: Vec<usize> = Vec::new();
        let mut seen_photos: HashSet<usize> = HashSet::new();

        for &face_idx in member_face_indices {
            let face = &session.faces[face_idx];
            if face.area > best_area && face.avatar_b64.is_some() {
                best_area = face.area;
                best_avatar = face.avatar_b64.clone();
            }
            if seen_photos.insert(face.photo_index) {
                photo_indices.push(face.photo_index);
            }
            photo_person_areas[face.photo_index].push((person_id.clone(), face.area));
        }

        photo_indices.sort_unstable();
        let photo_paths: Vec<String> = photo_indices
            .iter()
            .map(|&pi| session.photos[pi].path.clone())
            .collect();

        people.push(PersonCluster {
            person_id,
            default_name,
            avatar_data_url: best_avatar.map(|b64| format!("data:image/jpeg;base64,{b64}")),
            face_count: member_face_indices.len(),
            photo_paths,
            solo_photo_paths: Vec::new(),
        });
    }

    let mut group_photo_paths = Vec::new();
    let mut no_face_photo_paths = Vec::new();
    let mut photo_summaries = Vec::with_capacity(session.photos.len());
    let mut solo_by_person: HashMap<String, Vec<String>> = HashMap::new();

    for (photo_idx, rec) in session.photos.iter().enumerate() {
        let mut pairs = photo_person_areas[photo_idx].clone();
        pairs.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        let mut unique_ids = Vec::new();
        let mut seen = HashSet::new();
        for (pid, _) in pairs {
            if seen.insert(pid.clone()) {
                unique_ids.push(pid);
            }
        }

        let primary_person_id = unique_ids.first().cloned();
        if unique_ids.is_empty() {
            no_face_photo_paths.push(rec.path.clone());
        } else if unique_ids.len() == 1 {
            solo_by_person
                .entry(unique_ids[0].clone())
                .or_default()
                .push(rec.path.clone());
        } else {
            group_photo_paths.push(rec.path.clone());
        }

        photo_summaries.push(PeoplePhotoSummary {
            path: rec.path.clone(),
            file_name: rec.file_name.clone(),
            modified: rec.modified,
            size: rec.size,
            companion_files: rec.companions.clone(),
            person_ids: unique_ids,
            primary_person_id,
        });
    }

    for person in &mut people {
        if let Some(solos) = solo_by_person.remove(&person.person_id) {
            person.solo_photo_paths = solos;
        }
    }

    PeopleScanResult {
        scan_id: session.scan_id,
        directory: session.directory.clone(),
        cancelled: false,
        threshold,
        total_photos: session.photos.len(),
        total_faces: session.faces.len(),
        people,
        group_photo_paths,
        no_face_photo_paths,
        photos: photo_summaries,
    }
}

fn find_companions(
    dir: &Path,
    stem: &str,
    existing_names: &HashMap<String, String>,
) -> Vec<String> {
    let mut found = Vec::new();
    for ext in COMPANION_EXTS {
        let key = format!("{stem}.{ext}").to_lowercase();
        if let Some(actual) = existing_names.get(&key) {
            if dir.join(actual).is_file() {
                found.push(actual.clone());
            }
        }
    }
    found
}

fn scan_people_sync(
    app: &AppHandle,
    scan_id: u64,
    cancel: &Arc<AtomicBool>,
    request: PeopleScanRequest,
) -> Result<PeopleScanResult, String> {
    let dir = PathBuf::from(&request.directory);
    if !dir.is_dir() {
        return Err("Target directory does not exist".to_string());
    }

    let selected_set: HashSet<PathBuf> = request.selected_paths.iter().map(PathBuf::from).collect();
    let filter_by_selection = !selected_set.is_empty();

    let mut all_dir_names: HashMap<String, String> = HashMap::new();
    let mut candidate_files: Vec<(PathBuf, String, u64, Option<i64>)> = Vec::new();

    for entry in fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read directory: {e}"))?
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        all_dir_names.insert(name.to_lowercase(), name.clone());

        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        if !is_portrait_photo_ext(&ext) {
            continue;
        }
        if filter_by_selection && !selected_set.contains(&path) {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64);
        candidate_files.push((path, name, meta.len(), modified));
    }

    candidate_files.sort_by_key(|a| a.1.to_lowercase());

    let total = candidate_files.len();
    let _ = app.emit(
        "people-cluster-progress",
        PeopleScanProgressEvent {
            scan_id,
            processed: 0,
            total,
            faces_found: 0,
        },
    );

    let processed = AtomicUsize::new(0);
    let faces_found = AtomicUsize::new(0);

    let per_photo_faces: Vec<Vec<ExtractedFace>> = candidate_files
        .par_iter()
        .map(|(path, _, _, _)| {
            if cancel.load(Ordering::Acquire) {
                return Vec::new();
            }
            let detected = extract_faces_for_photo(path);
            let f_count = faces_found.fetch_add(detected.len(), Ordering::Relaxed) + detected.len();
            let done = processed.fetch_add(1, Ordering::Relaxed) + 1;
            if done == total || done.is_multiple_of(3) {
                let _ = app.emit(
                    "people-cluster-progress",
                    PeopleScanProgressEvent {
                        scan_id,
                        processed: done,
                        total,
                        faces_found: f_count,
                    },
                );
            }
            detected
        })
        .collect();

    if cancel.load(Ordering::Acquire) {
        return Ok(PeopleScanResult {
            scan_id,
            directory: request.directory,
            cancelled: true,
            threshold: request.threshold,
            total_photos: total,
            total_faces: 0,
            people: Vec::new(),
            group_photo_paths: Vec::new(),
            no_face_photo_paths: Vec::new(),
            photos: Vec::new(),
        });
    }

    let mut photos: Vec<ScannedPhotoRecord> = Vec::with_capacity(total);
    let mut faces: Vec<FaceEmbeddingSample> = Vec::new();

    for (idx, ((path, file_name, size, modified), detected)) in
        candidate_files.into_iter().zip(per_photo_faces).enumerate()
    {
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&file_name);
        let companions = find_companions(&dir, stem, &all_dir_names);
        photos.push(ScannedPhotoRecord {
            path: path.to_string_lossy().into_owned(),
            file_name,
            modified,
            size,
            companions,
        });
        for (area, embedding, avatar_b64) in detected {
            faces.push(FaceEmbeddingSample {
                photo_index: idx,
                area,
                embedding,
                avatar_b64,
            });
        }
    }

    let session = CachedPeopleSession {
        scan_id,
        directory: request.directory,
        photos,
        faces,
    };
    let result = build_scan_result_from_session(&session, request.threshold);
    if let Ok(mut guard) = LAST_SCAN_SESSION.lock() {
        *guard = Some(session);
    }
    Ok(result)
}

#[tauri::command]
pub async fn scan_people_clusters(
    app: AppHandle,
    request: PeopleScanRequest,
) -> Result<PeopleScanResult, String> {
    let scan_id = ACTIVE_PEOPLE_SCAN_ID.fetch_add(1, Ordering::AcqRel) + 1;
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut guard) = ACTIVE_PEOPLE_CANCEL.lock() {
        if let Some(prev) = guard.replace(cancel.clone()) {
            prev.store(true, Ordering::Release);
        }
    }
    tauri::async_runtime::spawn_blocking(move || scan_people_sync(&app, scan_id, &cancel, request))
        .await
        .map_err(|e| format!("People scan task failed: {e}"))?
}

#[tauri::command]
pub fn cancel_people_scan() {
    if let Ok(guard) = ACTIVE_PEOPLE_CANCEL.lock() {
        if let Some(flag) = guard.as_ref() {
            flag.store(true, Ordering::Release);
        }
    }
}

#[tauri::command]
pub fn recluster_people(scan_id: u64, threshold: f32) -> Result<PeopleScanResult, String> {
    let guard = LAST_SCAN_SESSION
        .lock()
        .map_err(|_| "Session cache unavailable".to_string())?;
    let session = guard
        .as_ref()
        .filter(|s| s.scan_id == scan_id)
        .ok_or_else(|| "Scan session expired; please scan again".to_string())?;
    Ok(build_scan_result_from_session(session, threshold))
}

fn sanitize_folder_name(raw: &str) -> Result<String, String> {
    let cleaned = raw
        .trim()
        .replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|', '\0'], "_");
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return Err("Invalid person folder name".to_string());
    }
    Ok(cleaned)
}

fn unique_path_in_dir(dir: &Path, file_name: &str) -> PathBuf {
    let candidate = dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let path_obj = Path::new(file_name);
    let stem = path_obj
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file_name);
    let ext = path_obj.extension().and_then(|e| e.to_str());
    for i in 1..10_000 {
        let name = match ext {
            Some(e) if !e.is_empty() => format!("{stem}_{i}.{e}"),
            _ => format!("{stem}_{i}"),
        };
        let next = dir.join(name);
        if !next.exists() {
            return next;
        }
    }
    candidate
}

fn organize_people_sync(
    log_dir: Option<PathBuf>,
    request: PeopleOrganizeRequest,
) -> Result<PeopleOrganizeResult, String> {
    let root = PathBuf::from(&request.directory);
    if !root.is_dir() {
        return Err("Target directory does not exist".to_string());
    }
    let is_copy = request.mode.eq_ignore_ascii_case("copy");
    let mut organized_photos = 0usize;
    let mut organized_companions = 0usize;
    let mut created_folders: Vec<String> = Vec::new();
    let mut created_set: HashSet<PathBuf> = HashSet::new();
    let mut failed: Vec<String> = Vec::new();
    let mut completed_ops: Vec<CompletedOrganizeOp> = Vec::new();

    for assign in &request.assignments {
        let src = PathBuf::from(&assign.source_path);
        if !src.is_file() {
            failed.push(format!("源文件不存在: {}", assign.source_path));
            continue;
        }
        let folder_name = match sanitize_folder_name(&assign.target_folder_name) {
            Ok(n) => n,
            Err(err) => {
                failed.push(format!("{}: {err}", assign.target_folder_name));
                continue;
            }
        };
        let target_dir = root.join(&folder_name);
        if !target_dir.exists() {
            if let Err(err) = fs::create_dir_all(&target_dir) {
                failed.push(format!("无法创建目录 {folder_name}: {err}"));
                continue;
            }
            if created_set.insert(target_dir.clone()) {
                created_folders.push(target_dir.to_string_lossy().into_owned());
            }
        }

        let Some(file_name) = src.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let dst = unique_path_in_dir(&target_dir, file_name);
        let op_res = if is_copy {
            fs::copy(&src, &dst).map(|_| ())
        } else {
            fs::rename(&src, &dst)
        };
        if let Err(err) = op_res {
            failed.push(format!("{file_name}: {err}"));
            continue;
        }
        organized_photos += 1;
        completed_ops.push(CompletedOrganizeOp {
            from: src.to_string_lossy().into_owned(),
            to: dst.to_string_lossy().into_owned(),
            is_copy,
        });

        if request.include_companions {
            let src_parent = src.parent().unwrap_or(&root);
            let src_stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let dst_stem = dst.file_stem().and_then(|s| s.to_str()).unwrap_or(src_stem);
            if !src_stem.is_empty() {
                if let Ok(read_dir) = fs::read_dir(src_parent) {
                    for entry in read_dir.flatten() {
                        let c_name = entry.file_name().to_string_lossy().into_owned();
                        if c_name.starts_with('.') {
                            continue;
                        }
                        let c_path = entry.path();
                        let c_ext = c_path.extension().and_then(|e| e.to_str()).unwrap_or("");
                        let c_stem = c_path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                        if c_stem == src_stem
                            && COMPANION_EXTS
                                .iter()
                                .any(|allowed| allowed.eq_ignore_ascii_case(c_ext))
                        {
                            let c_dst = target_dir.join(format!("{dst_stem}.{c_ext}"));
                            if !c_dst.exists() {
                                let c_res = if is_copy {
                                    fs::copy(&c_path, &c_dst).map(|_| ())
                                } else {
                                    fs::rename(&c_path, &c_dst)
                                };
                                if c_res.is_ok() {
                                    organized_companions += 1;
                                    completed_ops.push(CompletedOrganizeOp {
                                        from: c_path.to_string_lossy().into_owned(),
                                        to: c_dst.to_string_lossy().into_owned(),
                                        is_copy,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if !completed_ops.is_empty() {
        if let Some(dir) = log_dir {
            let _ = fs::create_dir_all(&dir);
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let manifest = dir.join(format!("people-organize-{ts}.json"));
            if let Ok(json) = serde_json::to_string_pretty(&completed_ops) {
                let _ = fs::write(manifest, json);
            }
        }
    }

    Ok(PeopleOrganizeResult {
        organized_photos,
        organized_companions,
        created_folders,
        failed,
        completed_ops,
    })
}

fn undo_people_sync(ops: Vec<CompletedOrganizeOp>) -> PeopleUndoResult {
    let mut restored = 0usize;
    let mut failed = Vec::new();
    let mut touched_dirs: HashSet<PathBuf> = HashSet::new();

    for op in ops.into_iter().rev() {
        let target = PathBuf::from(&op.to);
        let original = PathBuf::from(&op.from);
        if let Some(parent) = target.parent() {
            touched_dirs.insert(parent.to_path_buf());
        }
        if op.is_copy {
            if target.exists() {
                match fs::remove_file(&target) {
                    Ok(()) => restored += 1,
                    Err(err) => failed.push(format!("{}: {err}", op.to)),
                }
            }
        } else {
            if !target.exists() {
                failed.push(format!("文件不存在: {}", op.to));
                continue;
            }
            if original.exists() {
                failed.push(format!("原路径已被占用: {}", op.from));
                continue;
            }
            match fs::rename(&target, &original) {
                Ok(()) => restored += 1,
                Err(err) => failed.push(format!("{}: {err}", op.to)),
            }
        }
    }

    // Clean up empty person folders created during organization
    for dir in touched_dirs {
        let _ = fs::remove_dir(&dir);
    }

    PeopleUndoResult { restored, failed }
}

#[tauri::command]
pub async fn organize_people_photos(
    app: AppHandle,
    request: PeopleOrganizeRequest,
) -> Result<PeopleOrganizeResult, String> {
    let log_dir = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("people_organize_logs"));
    tauri::async_runtime::spawn_blocking(move || organize_people_sync(log_dir, request))
        .await
        .map_err(|e| format!("Organize people task failed: {e}"))?
}

#[tauri::command]
pub async fn undo_people_organization(
    ops: Vec<CompletedOrganizeOp>,
) -> Result<PeopleUndoResult, String> {
    tauri::async_runtime::spawn_blocking(move || undo_people_sync(ops))
        .await
        .map_err(|e| format!("Undo people organization task failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit_vec(values: [f32; 4]) -> Vec<f32> {
        let mut v = values.to_vec();
        normalize_vec(&mut v);
        v
    }

    #[test]
    fn clusters_same_person_together_and_enforces_same_photo_cannot_link() {
        let faces = vec![
            // Person A in photo 0 and photo 1
            FaceEmbeddingSample {
                photo_index: 0,
                area: 0.25,
                embedding: unit_vec([1.0, 0.05, 0.0, 0.0]),
                avatar_b64: None,
            },
            FaceEmbeddingSample {
                photo_index: 1,
                area: 0.20,
                embedding: unit_vec([0.98, 0.12, 0.0, 0.0]),
                avatar_b64: None,
            },
            // Person B in photo 2 and photo 3
            FaceEmbeddingSample {
                photo_index: 2,
                area: 0.22,
                embedding: unit_vec([0.0, 0.0, 1.0, 0.08]),
                avatar_b64: None,
            },
            FaceEmbeddingSample {
                photo_index: 3,
                area: 0.18,
                embedding: unit_vec([0.0, 0.0, 0.99, 0.14]),
                avatar_b64: None,
            },
            // Twin / very similar face in the SAME photo 0 as Person A -> MUST NOT merge with Person A!
            FaceEmbeddingSample {
                photo_index: 0,
                area: 0.15,
                embedding: unit_vec([0.96, 0.20, 0.0, 0.0]),
                avatar_b64: None,
            },
        ];

        let clusters = cluster_face_embeddings(&faces, 0.70);
        assert_eq!(clusters.len(), 3);
        // Verify no cluster ever contains two faces from photo 0
        for c in &clusters {
            let photos: HashSet<usize> = c.iter().map(|&idx| faces[idx].photo_index).collect();
            assert_eq!(photos.len(), c.len());
        }
    }

    #[test]
    fn organizes_photos_with_companions_into_person_folders_and_undoes_cleanly() {
        let unique = format!(
            "ie_people_org_{}_{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(unique);
        fs::create_dir_all(&root).unwrap();
        let photo = root.join("DSC00100.ARW");
        let xmp = root.join("DSC00100.xmp");
        fs::write(&photo, b"raw-bytes").unwrap();
        fs::write(&xmp, b"<xmp/>").unwrap();

        let res = organize_people_sync(
            None,
            PeopleOrganizeRequest {
                directory: root.to_string_lossy().into_owned(),
                assignments: vec![PeopleOrganizeAssignment {
                    source_path: photo.to_string_lossy().into_owned(),
                    target_folder_name: "人物 1".to_string(),
                }],
                mode: "move".to_string(),
                include_companions: true,
            },
        )
        .unwrap();

        assert_eq!(res.organized_photos, 1);
        assert_eq!(res.organized_companions, 1);
        assert!(root.join("人物 1/DSC00100.ARW").is_file());
        assert!(root.join("人物 1/DSC00100.xmp").is_file());
        assert!(!photo.exists());

        let undo = undo_people_sync(res.completed_ops);
        assert_eq!(undo.restored, 2);
        assert!(undo.failed.is_empty());
        assert!(photo.is_file());
        assert!(xmp.is_file());
        assert!(!root.join("人物 1").exists());

        let _ = fs::remove_dir_all(&root);
    }
}
