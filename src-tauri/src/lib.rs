// 初始化 rust-i18n，加载 locales 目录的翻译文件
rust_i18n::i18n!("locales", fallback = "en");

mod cache;
mod commands;
mod config;
mod db;
mod index;
mod menu;
mod operations;
mod raw_preview;
mod storage_analyzer;
mod thumb_disk_cache;
mod thumb_protocol;
mod trash_commands;
mod xmp_sidecar;

#[cfg(target_os = "macos")]
use commands::apps::get_arw_embedded_jpeg;
use commands::apps::{
    close_native_quick_look, get_app_icon, get_file_thumbnail, get_file_type_icon,
    get_installed_apps, get_recommended_apps, get_sf_symbol, get_terminal_apps,
    open_in_terminal_with, open_native_quick_look, open_with,
};
use commands::clipboard::{consume_cut_file_clipboard, read_file_clipboard, write_file_clipboard};
use commands::drag::start_native_file_drag;
use commands::fs::{
    batch_rename, calculate_directory_size, cancel_directory_size, check_full_disk_access,
    copy_file, create_directory, create_file, delete_to_trash, eject_volume, exists,
    get_disk_space, get_entries, get_file_entry, get_home_dir, get_mounted_volumes, get_parent_dir,
    move_file, open_file, open_in_terminal, open_url, read_camera_af_metadata, read_image_base64,
    read_image_dimensions, read_image_metadata, read_text_file, rename, resolve_original_path,
    set_file_locked, set_file_tags, toggle_file_tag, DirectorySizeState,
};
use commands::search::{
    cancel_directory_search, get_smart_files, search_directory, search_files, DirectorySearchState,
};
use commands::watcher::{stop_watching, unwatch_directory, watch_directory, WatcherState};
use db::{
    CachedPhotoFeatureRecord, CachedPhotoMetadataRecord, CachedPhotoSharpnessRecord, Database,
    IndexBuilder, IndexUpdater, PhotoCacheLookup, PhotoCacheStore, PhotoCullingRecord,
    SearchEngine,
};
use index::{create_shared_index, IndexedFile, SharedIndex};
use operations::{
    cancel_file_operation, clear_file_operation, create_directory_with_history,
    create_file_with_history, get_file_operation_conflicts, get_file_operations,
    rename_with_history, retry_file_operation, start_compress_operation, start_copy_operation,
    start_delete_operation, start_extract_operation, start_move_operation, undo_file_operation,
    OperationManager,
};
use serde::Serialize;
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{MenuItem, MenuItemKind};
use tauri::{AppHandle, Emitter, Manager};
use trash_commands::{empty_trash, list_trash, restore_trash_entry};
#[cfg(target_os = "macos")]
use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};

/// 共享数据库连接
pub type SharedDatabase = Arc<Database>;

/// 搜索响应结构体
#[derive(Serialize)]
struct SearchResponse {
    results: Vec<IndexedFile>,
    index_reconciling: bool,
    index_failed: bool,
}

fn is_updatable_native_menu_command(command_id: &str) -> bool {
    matches!(
        command_id,
        "window.new"
            | "file.new-file"
            | "file.new-folder"
            | "edit.cut"
            | "edit.copy"
            | "edit.paste"
            | "edit.select-all"
    )
}

fn collect_native_menu_items(
    items: Vec<MenuItemKind<tauri::Wry>>,
    target_ids: &std::collections::HashSet<&str>,
    out: &mut std::collections::HashMap<String, MenuItem<tauri::Wry>>,
) -> Result<(), String> {
    for item in items {
        let id = item.id().as_ref();
        if target_ids.contains(id) {
            match item {
                MenuItemKind::MenuItem(menu_item) => {
                    out.insert(menu_item.id().as_ref().to_string(), menu_item);
                }
                _ => {
                    return Err(format!(
                        "Native menu command '{id}' is not a normal menu item"
                    ));
                }
            }
            continue;
        }

        if let MenuItemKind::Submenu(submenu) = item {
            collect_native_menu_items(
                submenu
                    .items()
                    .map_err(|error| format!("Failed to read native menu items: {error}"))?,
                target_ids,
                out,
            )?;
        }
    }
    Ok(())
}

#[tauri::command]
fn set_native_menu_command_enabled(
    app: AppHandle,
    command_id: String,
    enabled: bool,
) -> Result<(), String> {
    set_native_menu_commands_enabled(app, vec![(command_id, enabled)])
}

/// 批量同步多个原生菜单项的启用状态，避免前端一次交互触发 7 次独立 IPC 与菜单树遍历
#[tauri::command]
fn set_native_menu_commands_enabled(
    app: AppHandle,
    states: Vec<(String, bool)>,
) -> Result<(), String> {
    if states.is_empty() {
        return Ok(());
    }
    for (command_id, _) in &states {
        if !is_updatable_native_menu_command(command_id) {
            return Err(format!(
                "Native menu command '{command_id}' cannot be updated here"
            ));
        }
    }

    let menu = app
        .menu()
        .ok_or_else(|| "The native application menu is unavailable".to_string())?;
    let target_ids: std::collections::HashSet<&str> =
        states.iter().map(|(id, _)| id.as_str()).collect();
    let mut found = std::collections::HashMap::with_capacity(target_ids.len());
    collect_native_menu_items(
        menu.items()
            .map_err(|error| format!("Failed to read native menu items: {error}"))?,
        &target_ids,
        &mut found,
    )?;

    for (command_id, enabled) in states {
        let item = found
            .get(&command_id)
            .ok_or_else(|| format!("Native menu command '{command_id}' was not found"))?;
        item.set_enabled(enabled).map_err(|error| {
            format!("Failed to update native menu command '{command_id}': {error}")
        })?;
    }
    Ok(())
}

#[tauri::command]
async fn get_cached_photo_features(
    database: tauri::State<'_, Option<SharedDatabase>>,
    items: Vec<PhotoCacheLookup>,
    analysis_version: i64,
) -> Result<Vec<CachedPhotoFeatureRecord>, String> {
    let Some(ref db) = *database.inner() else {
        return Ok(Vec::new());
    };
    let store = PhotoCacheStore::new(db.read_connection(), db.connection());
    tauri::async_runtime::spawn_blocking(move || store.get_features(&items, analysis_version))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn save_cached_photo_features(
    database: tauri::State<'_, Option<SharedDatabase>>,
    records: Vec<CachedPhotoFeatureRecord>,
    analysis_version: i64,
) -> Result<(), String> {
    let Some(ref db) = *database.inner() else {
        return Ok(());
    };
    let store = PhotoCacheStore::new(db.read_connection(), db.connection());
    tauri::async_runtime::spawn_blocking(move || store.save_features(&records, analysis_version))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn get_cached_photo_metadata(
    database: tauri::State<'_, Option<SharedDatabase>>,
    items: Vec<PhotoCacheLookup>,
    metadata_version: i64,
) -> Result<Vec<CachedPhotoMetadataRecord>, String> {
    let Some(ref db) = *database.inner() else {
        return Ok(Vec::new());
    };
    let store = PhotoCacheStore::new(db.read_connection(), db.connection());
    tauri::async_runtime::spawn_blocking(move || store.get_metadata(&items, metadata_version))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn save_cached_photo_metadata(
    database: tauri::State<'_, Option<SharedDatabase>>,
    records: Vec<CachedPhotoMetadataRecord>,
    metadata_version: i64,
) -> Result<(), String> {
    let Some(ref db) = *database.inner() else {
        return Ok(());
    };
    let store = PhotoCacheStore::new(db.read_connection(), db.connection());
    tauri::async_runtime::spawn_blocking(move || store.save_metadata(&records, metadata_version))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn get_cached_photo_sharpness(
    database: tauri::State<'_, Option<SharedDatabase>>,
    items: Vec<PhotoCacheLookup>,
    sharpness_version: i64,
) -> Result<Vec<CachedPhotoSharpnessRecord>, String> {
    let Some(ref db) = *database.inner() else {
        return Ok(Vec::new());
    };
    let store = PhotoCacheStore::new(db.read_connection(), db.connection());
    tauri::async_runtime::spawn_blocking(move || store.get_sharpness(&items, sharpness_version))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn save_cached_photo_sharpness(
    database: tauri::State<'_, Option<SharedDatabase>>,
    records: Vec<CachedPhotoSharpnessRecord>,
    sharpness_version: i64,
) -> Result<(), String> {
    let Some(ref db) = *database.inner() else {
        return Ok(());
    };
    let store = PhotoCacheStore::new(db.read_connection(), db.connection());
    tauri::async_runtime::spawn_blocking(move || store.save_sharpness(&records, sharpness_version))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn get_photo_culling_states(
    database: tauri::State<'_, Option<SharedDatabase>>,
    paths: Vec<String>,
) -> Result<Vec<PhotoCullingRecord>, String> {
    let Some(ref db) = *database.inner() else {
        return Ok(Vec::new());
    };
    let store = PhotoCacheStore::new(db.read_connection(), db.connection());
    tauri::async_runtime::spawn_blocking(move || store.get_culling_states(&paths))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn set_photo_culling_states(
    database: tauri::State<'_, Option<SharedDatabase>>,
    records: Vec<PhotoCullingRecord>,
) -> Result<(), String> {
    let Some(ref db) = *database.inner() else {
        return Ok(());
    };
    let store = PhotoCacheStore::new(db.read_connection(), db.connection());
    tauri::async_runtime::spawn_blocking(move || store.set_culling_states(&records))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn analyze_directory_storage(
    state: tauri::State<'_, std::sync::Arc<storage_analyzer::StorageAnalysisState>>,
    path: String,
    request_id: u64,
) -> Result<storage_analyzer::DirectoryStorageReport, String> {
    let shared_state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        storage_analyzer::analyze_directory_storage_blocking(
            std::path::Path::new(&path),
            &shared_state,
            request_id,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn find_duplicate_files(
    state: tauri::State<'_, std::sync::Arc<storage_analyzer::StorageAnalysisState>>,
    path: String,
    request_id: u64,
) -> Result<storage_analyzer::DuplicateFilesReport, String> {
    let shared_state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        storage_analyzer::find_duplicate_files_blocking(
            std::path::Path::new(&path),
            &shared_state,
            request_id,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheStatsResponse {
    thumb_disk_bytes: u64,
    thumb_disk_files: usize,
    thumb_disk_budget_bytes: u64,
    db_bytes: u64,
    analysis_rows: u64,
    sharpness_rows: u64,
    metadata_rows: u64,
    culling_rows: u64,
}

#[tauri::command]
async fn get_cache_stats(
    database: tauri::State<'_, Option<SharedDatabase>>,
) -> Result<CacheStatsResponse, String> {
    let db_clone = database.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (thumb_disk_bytes, thumb_disk_files, thumb_disk_budget_bytes) =
            thumb_disk_cache::stats();
        let (db_bytes, analysis_rows, sharpness_rows, metadata_rows, culling_rows) =
            if let Some(ref db) = db_clone {
                let db_len = std::fs::metadata(&db.db_path).map(|m| m.len()).unwrap_or(0);
                let store = PhotoCacheStore::new(db.read_connection(), db.connection());
                let (a, s, m, c) = store.cache_row_counts().unwrap_or((0, 0, 0, 0));
                (db_len, a, s, m, c)
            } else {
                (0, 0, 0, 0, 0)
            };
        Ok(CacheStatsResponse {
            thumb_disk_bytes,
            thumb_disk_files,
            thumb_disk_budget_bytes,
            db_bytes,
            analysis_rows,
            sharpness_rows,
            metadata_rows,
            culling_rows,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn clear_thumbnail_cache() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        cache::clear_thumb_memory_cache();
        thumb_disk_cache::clear_all()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn clear_photo_analysis_cache(
    database: tauri::State<'_, Option<SharedDatabase>>,
) -> Result<(), String> {
    let Some(ref db) = *database.inner() else {
        return Ok(());
    };
    let store = PhotoCacheStore::new(db.read_connection(), db.connection());
    tauri::async_runtime::spawn_blocking(move || store.clear_computed_caches())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn cancel_storage_analysis(
    state: tauri::State<'_, std::sync::Arc<storage_analyzer::StorageAnalysisState>>,
    request_id: u64,
) {
    state.cancel(request_id);
}

#[tauri::command]
async fn export_xmp_sidecars(
    database: tauri::State<'_, Option<SharedDatabase>>,
    paths: Vec<String>,
) -> Result<usize, String> {
    let culling_map: std::collections::HashMap<String, PhotoCullingRecord> =
        if let Some(ref db) = *database.inner() {
            let store = PhotoCacheStore::new(db.read_connection(), db.connection());
            let lookup_paths = paths.clone();
            tauri::async_runtime::spawn_blocking(move || store.get_culling_states(&lookup_paths))
                .await
                .map_err(|error| error.to_string())??
                .into_iter()
                .map(|record| (record.path.clone(), record))
                .collect()
        } else {
            std::collections::HashMap::new()
        };

    tauri::async_runtime::spawn_blocking(move || {
        let mut written = 0usize;
        let mut parents = std::collections::HashSet::new();
        for raw_path in &paths {
            let file_path = std::path::Path::new(raw_path);
            if !file_path.is_file() {
                continue;
            }
            let tags = commands::fs::read_file_tags(file_path);
            let label = xmp_sidecar::finder_tags_to_xmp_label(&tags);
            let (rating, flag) = culling_map
                .get(raw_path)
                .map(|r| (r.rating, r.flag.as_str()))
                .unwrap_or((0, "none"));
            if rating == 0 && flag == "none" && label.is_none() {
                continue;
            }
            xmp_sidecar::write_xmp_sidecar(file_path, rating, flag, label)?;
            written += 1;
            if let Some(parent) = file_path.parent() {
                parents.insert(parent.to_string_lossy().to_string());
            }
        }
        for parent in parents {
            cache::invalidate_dir_cache(&parent);
        }
        Ok(written)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// 搜索已索引的文件
/// 优先使用 SQLite，回退到内存索引
#[tauri::command]
async fn search_indexed(
    _app: AppHandle,
    index: tauri::State<'_, SharedIndex>,
    database: tauri::State<'_, Option<SharedDatabase>>,
    query: String,
    limit: Option<usize>,
) -> Result<SearchResponse, String> {
    let limit_val = limit.unwrap_or(50);

    // 优先尝试 SQLite 搜索（使用只读连接以发挥 WAL 并发）
    if let Some(ref db) = *database.inner() {
        let conn = db.read_connection();
        let search_engine = SearchEngine::new(conn);
        let query_clone = query.clone();

        let sqlite_results = tauri::async_runtime::spawn_blocking(move || {
            search_engine.search(&query_clone, limit_val)
        })
        .await
        .map_err(|e| e.to_string())??;

        let results: Vec<IndexedFile> = sqlite_results
            .into_iter()
            .map(|r| IndexedFile {
                name: r.name,
                name_lower: r.name_lower,
                path: r.path,
                is_dir: r.is_dir,
                size: r.size as u64,
                modified: r.modified.map(|m| m as u64),
                extension: r.extension,
                is_hidden: r.is_hidden,
            })
            .collect();

        let (index_reconciling, index_failed) = index
            .read()
            .map(|state| (state.is_building, state.last_build_failed))
            .unwrap_or((true, false));
        return Ok(SearchResponse {
            results,
            index_reconciling,
            index_failed,
        });
    }

    // 回退到内存索引（阻塞等待，避免索引构建期间返回空结果）
    let index = index.inner().clone();
    let results = tauri::async_runtime::spawn_blocking(move || {
        let index = index
            .read()
            .map_err(|error| format!("Search index lock failed: {error}"))?;
        Ok::<_, String>((
            index.search(&query, limit_val),
            index.is_building,
            index.last_build_failed,
        ))
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(SearchResponse {
        results: results.0,
        index_reconciling: results.1,
        index_failed: results.2,
    })
}

/// 获取索引状态
#[derive(Serialize)]
struct IndexStatus {
    is_building: bool,
    file_count: usize,
    last_build_failed: bool,
    last_build_error: Option<String>,
}

#[tauri::command]
fn get_index_status(index: tauri::State<'_, SharedIndex>) -> IndexStatus {
    // 使用 try_read 避免阻塞，如果无法获取锁则返回默认值
    if let Ok(index) = index.try_read() {
        IndexStatus {
            is_building: index.is_building,
            file_count: index.file_count,
            last_build_failed: index.last_build_failed,
            last_build_error: index.last_build_error.clone(),
        }
    } else {
        // 如果无法获取锁（正在构建中），返回构建中状态
        IndexStatus {
            is_building: true,
            file_count: 0,
            last_build_failed: false,
            last_build_error: None,
        }
    }
}

/// Watcher 停止信号发送端（用于优雅关闭）
pub type WatcherStopSenders = Arc<Mutex<Vec<std::sync::mpsc::Sender<()>>>>;
pub type WatcherRecoverySenders = Arc<Mutex<Vec<std::sync::mpsc::SyncSender<()>>>>;
pub type WatcherRecoveryGeneration = Arc<AtomicU64>;
pub type NativeQuickLookState = Mutex<Option<Child>>;

struct SqliteWatcherRecoveryContext {
    index: SharedIndex,
    app: AppHandle,
    senders: WatcherRecoverySenders,
    generation: WatcherRecoveryGeneration,
}

/// 后台构建索引（优先使用 SQLite，回退到内存索引）
fn build_index_background(
    app: AppHandle,
    index: SharedIndex,
    database: Option<SharedDatabase>,
    stop_senders: WatcherStopSenders,
    recovery_senders: WatcherRecoverySenders,
    recovery_generation: WatcherRecoveryGeneration,
) {
    tauri::async_runtime::spawn_blocking(move || {
        // 获取用户主目录
        if let Some(home) = dirs::home_dir() {
            let home_str = home.to_string_lossy().to_string();

            if let Some(ref db) = database {
                // Start the watcher before the snapshot. Events arriving while
                // the snapshot is built are replayed after it is committed.
                let is_building = Arc::new(AtomicBool::new(true));
                let (stop_tx, stop_rx) = std::sync::mpsc::channel();
                if let Ok(mut senders) = stop_senders.lock() {
                    senders.push(stop_tx);
                }
                let watcher_started = match start_sqlite_watcher(
                    db.clone(),
                    home_str.clone(),
                    stop_rx,
                    is_building.clone(),
                    SqliteWatcherRecoveryContext {
                        index: index.clone(),
                        app: app.clone(),
                        senders: recovery_senders.clone(),
                        generation: recovery_generation.clone(),
                    },
                ) {
                    Ok(()) => true,
                    Err(error) => {
                        eprintln!("Failed to start SQLite index watcher at startup: {error}");
                        false
                    }
                };

                if let Ok(mut idx) = index.write() {
                    idx.is_building = true;
                    idx.last_build_failed = false;
                    idx.last_build_error = None;
                    idx.file_count = db.file_count().max(0) as usize;
                }
                println!(
                    "Delaying index reconciliation for {} seconds to allow UI to load...",
                    config::INDEX_BUILD_DELAY_SECS
                );
                std::thread::sleep(std::time::Duration::from_secs(
                    config::INDEX_BUILD_DELAY_SECS,
                ));

                let builder = IndexBuilder::new(db.connection());
                // When a healthy, recent persisted index exists, run a fast
                // incremental directory-mtime reconciliation instead of rewriting
                // the entire index on every launch. Fall back to a full rebuild
                // if the index is empty, expired, interrupted, or incremental
                // reconciliation reports an error.
                let use_incremental = !db.needs_rebuild();
                let _ = app.emit("index-status", "building");
                let build_result = if use_incremental {
                    println!("Starting incremental SQLite index reconciliation...");
                    match builder.reconcile_incremental(&home_str) {
                        Ok(count) => Ok(count),
                        Err(error) => {
                            eprintln!(
                                "Incremental reconciliation failed ({error}); falling back to full rebuild"
                            );
                            builder.build(&home_str, Some(&app))
                        }
                    }
                } else {
                    println!("Starting full SQLite index rebuild...");
                    builder.build(&home_str, Some(&app))
                };
                let build_succeeded = match build_result {
                    Ok(count) => {
                        println!("SQLite index ready: {} files", count);
                        if let Ok(mut idx) = index.write() {
                            idx.is_building = false;
                            idx.file_count = count;
                            idx.last_build_failed = false;
                            idx.last_build_error = None;
                        }
                        true
                    }
                    Err(e) => {
                        eprintln!(
                            "SQLite index build failed; keeping the last committed index: {}",
                            e
                        );
                        if let Ok(mut idx) = index.write() {
                            idx.is_building = false;
                            idx.file_count = db.file_count().max(0) as usize;
                            idx.last_build_failed = true;
                            idx.last_build_error = Some(e.to_string());
                        }
                        if let Err(marker_error) = builder.mark_rebuild_required() {
                            eprintln!("Failed to mark SQLite index for a retry: {marker_error}");
                        }
                        false
                    }
                };
                is_building.store(false, Ordering::Release);
                if !watcher_started {
                    if let Err(error) = builder.mark_rebuild_required() {
                        eprintln!("Failed to mark SQLite index for retry: {error}");
                    }
                }
                let _ = app.emit(
                    "index-status",
                    if build_succeeded { "ready" } else { "failed" },
                );
                return;
            }

            // SQLite is unavailable: retain the existing in-memory fallback.
            println!(
                "Delaying memory index build for {} seconds to allow UI to load...",
                config::INDEX_BUILD_DELAY_SECS
            );
            std::thread::sleep(std::time::Duration::from_secs(
                config::INDEX_BUILD_DELAY_SECS,
            ));
            if let Ok(mut idx) = index.write() {
                idx.is_building = true;
            }
            let _ = app.emit("index-status", "building");
            let (stop_tx, stop_rx) = std::sync::mpsc::channel();
            if let Ok(mut senders) = stop_senders.lock() {
                senders.push(stop_tx);
            }
            fallback_to_memory_index(
                &app,
                &index,
                &home_str,
                stop_rx,
                recovery_senders,
                recovery_generation,
            );
        }
    });
}

/// 回退到内存索引
fn fallback_to_memory_index(
    app: &AppHandle,
    index: &SharedIndex,
    home_str: &str,
    stop_rx: std::sync::mpsc::Receiver<()>,
    recovery_senders: WatcherRecoverySenders,
    recovery_generation: WatcherRecoveryGeneration,
) {
    println!("Starting background index watcher...");
    let (recovery_tx, recovery_rx) = std::sync::mpsc::sync_channel(1);
    if let Ok(mut senders) = recovery_senders.lock() {
        senders.push(recovery_tx.clone());
    }
    if recovery_generation.load(Ordering::Acquire) > 0 {
        let _ = recovery_tx.try_send(());
    }

    index::start_index_watcher(
        index.clone(),
        home_str.to_string(),
        stop_rx,
        recovery_rx,
        app.clone(),
    );
}

/// 启动 SQLite 增量监听器（支持优雅关闭）
fn start_sqlite_watcher(
    db: SharedDatabase,
    root: String,
    stop_rx: std::sync::mpsc::Receiver<()>,
    is_building: Arc<AtomicBool>,
    recovery: SqliteWatcherRecoveryContext,
) -> Result<(), String> {
    let (recovery_tx, recovery_rx) = std::sync::mpsc::sync_channel(1);
    let (watcher, rx) = create_sqlite_event_watcher(&root)?;

    if let Ok(mut senders) = recovery.senders.lock() {
        senders.push(recovery_tx.clone());
    }
    if recovery.generation.load(Ordering::Acquire) > 0 {
        let _ = recovery_tx.try_send(());
    }

    let SqliteWatcherRecoveryContext {
        index,
        app,
        senders: _,
        generation: _,
    } = recovery;
    std::thread::spawn(move || {
        // Keep the OS watcher alive and replace it if its backend reports an
        // error or drops the event channel.
        let mut watcher = watcher;
        let mut rx = rx;
        let updater = IndexUpdater::new(db.connection());
        let builder = IndexBuilder::new(db.connection());
        let mut pending_events = PendingIndexEvents::default();
        let mut watcher_disconnected = false;
        let mut watcher_had_error = false;

        loop {
            if stop_rx.try_recv().is_ok() {
                println!("SQLite watcher received stop signal, shutting down");
                break;
            }

            while recovery_rx.try_recv().is_ok() {
                pending_events.request_reconciliation();
            }

            if !is_building.load(Ordering::Acquire) && pending_events.reconciliation_requested {
                // Events already queued before the scan are represented by the
                // filesystem snapshot. Discard them so stale rename/remove
                // records cannot be replayed over the newly committed snapshot.
                pending_events.begin_reconciliation();
                loop {
                    match rx.try_recv() {
                        Ok(Ok(_event)) => {}
                        Ok(Err(error)) => {
                            eprintln!(
                                "SQLite watcher error while preparing reconciliation: {error:?}"
                            );
                            match replace_sqlite_event_watcher(&mut watcher, &mut rx, &root) {
                                Ok(()) => watcher_had_error = false,
                                Err(restart_error) => {
                                    watcher_had_error = true;
                                    watcher_disconnected = true;
                                    eprintln!("Failed to restart SQLite watcher: {restart_error}");
                                }
                            }
                        }
                        Err(std::sync::mpsc::TryRecvError::Empty)
                        | Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
                    }
                }

                is_building.store(true, Ordering::Release);
                if let Ok(mut idx) = index.write() {
                    idx.is_building = true;
                    idx.last_build_failed = false;
                    idx.last_build_error = None;
                }
                let _ = app.emit("index-status", "building");

                match builder.build(&root, None) {
                    Ok(count) => {
                        if let Ok(mut idx) = index.write() {
                            idx.is_building = false;
                            idx.file_count = count;
                            idx.last_build_failed = false;
                            idx.last_build_error = None;
                        }
                        println!("SQLite index reconciled after watcher gap: {count} files");
                    }
                    Err(error) => {
                        eprintln!("SQLite index reconciliation failed: {error}");
                        if let Err(marker_error) = builder.mark_rebuild_required() {
                            eprintln!(
                                "Failed to persist SQLite index recovery marker: {marker_error}"
                            );
                        }
                        if let Ok(mut idx) = index.write() {
                            idx.is_building = false;
                            idx.file_count = db.file_count().max(0) as usize;
                            idx.last_build_failed = true;
                            idx.last_build_error = Some(error.to_string());
                        }
                    }
                }

                is_building.store(false, Ordering::Release);
                let failed = index
                    .read()
                    .map(|idx| idx.last_build_failed)
                    .unwrap_or(true);
                let _ = app.emit("index-status", if failed { "failed" } else { "ready" });

                if watcher_disconnected || watcher_had_error {
                    // The snapshot restores current search results, but there
                    // may no longer be a reliable live watcher. Retry a full
                    // rebuild on the next launch instead of trusting it.
                    if let Err(error) = builder.mark_rebuild_required() {
                        eprintln!("Failed to persist watcher recovery marker: {error}");
                    }
                }
                if watcher_disconnected {
                    break;
                }
            }

            match rx.recv_timeout(std::time::Duration::from_millis(500)) {
                Ok(Ok(event)) => {
                    pending_events.push(event);
                    // Drain any immediately queued events from the same OS burst
                    // before updating SQLite.
                    while let Ok(next) = rx.try_recv() {
                        match next {
                            Ok(event) => pending_events.push(event),
                            Err(error) => {
                                eprintln!("SQLite watcher error; scheduling index reconciliation: {error:?}");
                                pending_events.request_reconciliation();
                                match replace_sqlite_event_watcher(&mut watcher, &mut rx, &root) {
                                    Ok(()) => watcher_had_error = false,
                                    Err(restart_error) => {
                                        watcher_had_error = true;
                                        watcher_disconnected = true;
                                        eprintln!(
                                            "Failed to restart SQLite watcher: {restart_error}"
                                        );
                                    }
                                }
                                break;
                            }
                        }
                    }
                }
                Ok(Err(error)) => {
                    eprintln!("SQLite watcher error; scheduling index reconciliation: {error:?}");
                    pending_events.request_reconciliation();
                    match replace_sqlite_event_watcher(&mut watcher, &mut rx, &root) {
                        Ok(()) => watcher_had_error = false,
                        Err(restart_error) => {
                            watcher_had_error = true;
                            watcher_disconnected = true;
                            eprintln!("Failed to restart SQLite watcher: {restart_error}");
                        }
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    eprintln!("SQLite watcher channel disconnected; attempting restart");
                    pending_events.request_reconciliation();
                    match replace_sqlite_event_watcher(&mut watcher, &mut rx, &root) {
                        Ok(()) => {
                            watcher_disconnected = false;
                            watcher_had_error = false;
                        }
                        Err(error) => {
                            watcher_disconnected = true;
                            watcher_had_error = true;
                            eprintln!("Failed to restart disconnected SQLite watcher: {error}");
                        }
                    }
                }
            }

            if !is_building.load(Ordering::Acquire) {
                for event in pending_events.take_events() {
                    apply_sqlite_index_event(&updater, event);
                }
            }
        }
    });
    Ok(())
}

fn create_sqlite_event_watcher(
    root: &str,
) -> Result<
    (
        notify::RecommendedWatcher,
        std::sync::mpsc::Receiver<Result<notify::Event, notify::Error>>,
    ),
    String,
> {
    use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};

    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = RecommendedWatcher::new(
        move |res| {
            let _ = tx.send(res);
        },
        Config::default(),
    )
    .map_err(|error| format!("could not create watcher: {error}"))?;
    watcher
        .watch(std::path::Path::new(root), RecursiveMode::Recursive)
        .map_err(|error| format!("could not watch {root}: {error}"))?;
    Ok((watcher, rx))
}

fn replace_sqlite_event_watcher(
    watcher: &mut notify::RecommendedWatcher,
    rx: &mut std::sync::mpsc::Receiver<Result<notify::Event, notify::Error>>,
    root: &str,
) -> Result<(), String> {
    let (replacement, replacement_rx) = create_sqlite_event_watcher(root)?;
    *watcher = replacement;
    *rx = replacement_rx;
    Ok(())
}

#[derive(Default)]
struct PendingIndexEvents {
    events: Vec<notify::Event>,
    reconciliation_requested: bool,
}

impl PendingIndexEvents {
    fn push(&mut self, event: notify::Event) {
        if event.need_rescan() {
            self.request_reconciliation();
        } else if !self.reconciliation_requested {
            self.events.push(event);
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

    fn take_events(&mut self) -> Vec<notify::Event> {
        std::mem::take(&mut self.events)
    }
}

#[cfg(target_os = "macos")]
fn register_macos_wake_observer(
    recovery_senders: WatcherRecoverySenders,
    recovery_generation: WatcherRecoveryGeneration,
) -> Result<objc2::rc::Retained<objc2_foundation::NSObject>, String> {
    use block2::RcBlock;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};
    use objc2_foundation::NSNotification;

    let workspace = unsafe { NSWorkspace::sharedWorkspace() };
    let notification_center = unsafe { workspace.notificationCenter() };
    let wake_block = RcBlock::new(move |_notification: std::ptr::NonNull<NSNotification>| {
        recovery_generation.fetch_add(1, Ordering::AcqRel);
        if let Ok(senders) = recovery_senders.lock() {
            for sender in senders.iter() {
                let _ = sender.try_send(());
            }
        }
    });
    let observer = unsafe {
        notification_center.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceDidWakeNotification),
            None,
            None,
            &wake_block,
        )
    };
    Ok(observer)
}

#[cfg(target_os = "macos")]
fn register_macos_volume_observers_with_callback<F>(
    on_change: F,
) -> Vec<objc2::rc::Retained<objc2_foundation::NSObject>>
where
    F: Fn() + Clone + 'static,
{
    use block2::RcBlock;
    use objc2_app_kit::{
        NSWorkspace, NSWorkspaceDidMountNotification, NSWorkspaceDidRenameVolumeNotification,
        NSWorkspaceDidUnmountNotification,
    };
    use objc2_foundation::NSNotification;

    let workspace = unsafe { NSWorkspace::sharedWorkspace() };
    let notification_center = unsafe { workspace.notificationCenter() };
    let notifications = [
        unsafe { NSWorkspaceDidMountNotification },
        unsafe { NSWorkspaceDidUnmountNotification },
        unsafe { NSWorkspaceDidRenameVolumeNotification },
    ];

    notifications
        .into_iter()
        .map(|name| {
            let callback = on_change.clone();
            let block = RcBlock::new(move |_notification: std::ptr::NonNull<NSNotification>| {
                callback();
            });
            unsafe {
                notification_center.addObserverForName_object_queue_usingBlock(
                    Some(name),
                    None,
                    None,
                    &block,
                )
            }
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn register_macos_volume_observers(
    app_handle: AppHandle,
) -> Vec<objc2::rc::Retained<objc2_foundation::NSObject>> {
    register_macos_volume_observers_with_callback(move || {
        let _ = app_handle.emit("volumes-changed", ());
    })
}

fn apply_sqlite_index_event(updater: &IndexUpdater, event: notify::Event) {
    use notify::EventKind;

    let result = match event.kind {
        EventKind::Create(_) => {
            for path in event.paths {
                if config::is_index_excluded(&path) {
                    continue;
                }
                let path_str = path.to_string_lossy().to_string();
                let result = if path.is_dir() {
                    updater.upsert_subtree(&path_str).map(|_| ())
                } else {
                    updater.upsert(&path_str, false)
                };
                if let Err(error) = result {
                    eprintln!("SQLite index upsert failed: {error}");
                }
            }
            Ok(())
        }
        EventKind::Modify(
            notify::event::ModifyKind::Data(_) | notify::event::ModifyKind::Metadata(_),
        ) => {
            // Directory mtime/metadata updates fire whenever a child changes.
            // Updating only the directory row avoids recursively re-scanning the
            // entire subtree on every single file write.
            for path in event.paths {
                if config::is_index_excluded(&path) {
                    continue;
                }
                let path_str = path.to_string_lossy().to_string();
                if let Err(error) = updater.upsert(&path_str, path.is_dir()) {
                    eprintln!("SQLite index upsert failed: {error}");
                }
            }
            Ok(())
        }
        EventKind::Remove(_) => {
            for path in event.paths {
                let path_str = path.to_string_lossy().to_string();
                if let Err(error) = updater.remove(&path_str) {
                    eprintln!("SQLite index removal failed: {error}");
                }
            }
            Ok(())
        }
        EventKind::Modify(notify::event::ModifyKind::Name(_)) if event.paths.len() == 2 => {
            let first = &event.paths[0];
            let second = &event.paths[1];
            // Backends differ in path ordering. A completed rename normally
            // leaves only the destination on disk.
            let (from, to) = match (first.exists(), second.exists()) {
                (false, true) => (first, second),
                (true, false) => (second, first),
                _ => (first, second),
            };
            let from_path = from.to_string_lossy().to_string();
            let to_path = to.to_string_lossy().to_string();
            let from_excluded = config::is_index_excluded(from);
            let to_excluded = config::is_index_excluded(to);
            if to_excluded {
                updater.remove(&from_path)
            } else if from_excluded {
                // The old subtree was intentionally absent from the index, so
                // scan the destination before publishing its indexed rows.
                if to.is_dir() {
                    updater.upsert_subtree(&to_path).map(|_| ())
                } else {
                    updater.upsert(&to_path, false)
                }
            } else {
                updater.rename(&from_path, &to_path, to.is_dir())
            }
        }
        _ => Ok(()),
    };

    if let Err(error) = result {
        eprintln!("SQLite index event update failed: {error}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared_index = create_shared_index();

    // 初始化 SQLite 数据库
    let shared_database: Option<SharedDatabase> = match Database::open() {
        Ok(db) => {
            println!("SQLite database opened at: {:?}", db.db_path);
            Some(Arc::new(db))
        }
        Err(e) => {
            eprintln!(
                "Failed to open SQLite database: {}, falling back to memory index",
                e
            );
            None
        }
    };

    // Watcher 停止信号管理
    let stop_senders: WatcherStopSenders = Arc::new(Mutex::new(Vec::new()));
    let stop_senders_for_exit = stop_senders.clone();
    let recovery_senders: WatcherRecoverySenders = Arc::new(Mutex::new(Vec::new()));
    let recovery_senders_for_setup = recovery_senders.clone();
    let recovery_generation: WatcherRecoveryGeneration = Arc::new(AtomicU64::new(0));
    let recovery_generation_for_setup = recovery_generation.clone();
    let operation_manager = OperationManager::default();

    let app = tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("thumb", thumb_protocol::handle_thumb_protocol)
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Mutex::new(WatcherState::new()))
        .manage(Mutex::new(None::<Child>))
        .manage(shared_index.clone())
        .manage(shared_database.clone())
        .manage(operation_manager)
        .manage(DirectorySearchState::default())
        .manage(DirectorySizeState::default())
        .manage(Arc::new(storage_analyzer::StorageAnalysisState::default()))
        .setup(move |app| {
            let window = app.get_webview_window("main").unwrap();

            #[cfg(target_os = "macos")]
            apply_vibrancy(
                &window,
                NSVisualEffectMaterial::UnderWindowBackground,
                None,
                None,
            )
            .expect("Unsupported platform! 'apply_vibrancy' is only supported on macOS");

            // 初始化国际化语言设置
            menu::init_locale();

            // 创建原生菜单（国际化）
            let menu = menu::create_menu(app.handle())?;
            app.set_menu(menu)?;

            // 后台构建索引
            build_index_background(
                app.handle().clone(),
                shared_index.clone(),
                shared_database.clone(),
                stop_senders.clone(),
                recovery_senders_for_setup.clone(),
                recovery_generation_for_setup.clone(),
            );

            Ok(())
        })
        .on_menu_event(|app, event| {
            let command_id = if event.id() == "window.new" {
                Some("window.new")
            } else if event.id() == "file.new-file" {
                Some("file.new-file")
            } else if event.id() == "file.new-folder" {
                Some("file.new-folder")
            } else if event.id() == "edit.cut" {
                Some("edit.cut")
            } else if event.id() == "edit.copy" {
                Some("edit.copy")
            } else if event.id() == "edit.paste" {
                Some("edit.paste")
            } else if event.id() == "edit.select-all" {
                Some("edit.select-all")
            } else {
                None
            };

            if let Some(command_id) = command_id {
                if let Some(window) = app
                    .webview_windows()
                    .values()
                    .find(|window| window.is_focused().unwrap_or(false))
                {
                    if let Err(error) = window.emit("app-command", command_id) {
                        eprintln!("Failed to route command '{:?}': {error}", event.id());
                    }
                }
            }
        })
        .on_window_event(|window, event| {
            // 当新窗口创建时应用 vibrancy
            if let tauri::WindowEvent::Focused(true) = event {
                #[cfg(target_os = "macos")]
                {
                    // 对所有窗口应用 vibrancy（如果还未应用）
                    let _ = apply_vibrancy(
                        window,
                        NSVisualEffectMaterial::UnderWindowBackground,
                        None,
                        None,
                    );
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_entries,
            get_file_entry,
            get_home_dir,
            get_mounted_volumes,
            eject_volume,
            get_disk_space,
            calculate_directory_size,
            cancel_directory_size,
            set_file_locked,
            set_file_tags,
            toggle_file_tag,
            resolve_original_path,
            get_parent_dir,
            open_file,
            delete_to_trash,
            exists,
            open_in_terminal,
            create_directory,
            create_file,
            rename,
            create_directory_with_history,
            create_file_with_history,
            rename_with_history,
            copy_file,
            move_file,
            watch_directory,
            unwatch_directory,
            stop_watching,
            search_files,
            search_directory,
            cancel_directory_search,
            search_indexed,
            get_cached_photo_features,
            save_cached_photo_features,
            get_cached_photo_metadata,
            save_cached_photo_metadata,
            get_cached_photo_sharpness,
            save_cached_photo_sharpness,
            get_photo_culling_states,
            set_photo_culling_states,
            export_xmp_sidecars,
            analyze_directory_storage,
            find_duplicate_files,
            cancel_storage_analysis,
            get_cache_stats,
            clear_thumbnail_cache,
            clear_photo_analysis_cache,
            get_smart_files,
            get_index_status,
            open_url,
            check_full_disk_access,
            get_installed_apps,
            get_terminal_apps,
            get_recommended_apps,
            get_app_icon,
            get_file_thumbnail,
            #[cfg(target_os = "macos")]
            get_arw_embedded_jpeg,
            get_file_type_icon,
            open_with,
            open_in_terminal_with,
            open_native_quick_look,
            close_native_quick_look,
            get_sf_symbol,
            start_native_file_drag,
            read_file_clipboard,
            write_file_clipboard,
            consume_cut_file_clipboard,
            read_text_file,
            read_image_base64,
            read_image_dimensions,
            read_camera_af_metadata,
            read_image_metadata,
            batch_rename,
            start_copy_operation,
            start_move_operation,
            start_delete_operation,
            start_compress_operation,
            start_extract_operation,
            get_file_operation_conflicts,
            get_file_operations,
            set_native_menu_command_enabled,
            set_native_menu_commands_enabled,
            cancel_file_operation,
            retry_file_operation,
            undo_file_operation,
            list_trash,
            restore_trash_entry,
            empty_trash,
            clear_file_operation
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    #[cfg(target_os = "macos")]
    let wake_observer = match register_macos_wake_observer(recovery_senders, recovery_generation) {
        Ok(observer) => Some(observer),
        Err(error) => {
            eprintln!("Failed to register macOS wake observer: {error}");
            None
        }
    };
    #[cfg(target_os = "macos")]
    let volume_observers = register_macos_volume_observers(app.handle().clone());

    app.run(move |app_handle, event| {
        #[cfg(target_os = "macos")]
        let _keep_wake_observer_alive = wake_observer.as_ref();
        #[cfg(target_os = "macos")]
        let _keep_volume_observers_alive = &volume_observers;

        if let tauri::RunEvent::Exit = event {
            println!("Application exiting, stopping watchers...");
            if let Ok(senders) = stop_senders_for_exit.lock() {
                for sender in senders.iter() {
                    let _ = sender.send(());
                }
            }
            if let Ok(mut native_quick_look) = app_handle.state::<NativeQuickLookState>().lock() {
                if let Some(mut child) = native_quick_look.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
            #[cfg(target_os = "macos")]
            commands::fs::shutdown_exiftool_daemon();
        }
    });
}

#[cfg(test)]
mod watcher_recovery_tests {
    use super::PendingIndexEvents;
    use notify::{event::Flag, Event, EventKind};

    #[test]
    fn rescan_notice_discards_deltas_until_authoritative_scan_starts() {
        let mut queue = PendingIndexEvents::default();
        queue.push(Event::new(EventKind::Other));
        assert_eq!(queue.events.len(), 1);

        queue.push(Event::new(EventKind::Any).set_flag(Flag::Rescan));
        assert!(queue.reconciliation_requested);
        assert!(queue.events.is_empty());

        queue.push(Event::new(EventKind::Other));
        assert!(queue.events.is_empty());

        queue.begin_reconciliation();
        assert!(!queue.reconciliation_requested);
        assert!(queue.events.is_empty());
        queue.push(Event::new(EventKind::Other));
        assert_eq!(queue.events.len(), 1);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_wake_observer_tests {
    use super::{register_macos_wake_observer, WatcherRecoveryGeneration, WatcherRecoverySenders};
    use objc2_app_kit::{NSWorkspace, NSWorkspaceDidWakeNotification};
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    };
    use std::time::Duration;

    #[test]
    fn workspace_wake_notification_requests_index_recovery() {
        let (recovery_tx, recovery_rx) = mpsc::sync_channel(1);
        let senders: WatcherRecoverySenders = Arc::new(Mutex::new(vec![recovery_tx]));
        let generation: WatcherRecoveryGeneration = Arc::new(AtomicU64::new(0));
        let observer = register_macos_wake_observer(senders, generation.clone())
            .expect("register wake observer");

        let workspace = unsafe { NSWorkspace::sharedWorkspace() };
        let notification_center = unsafe { workspace.notificationCenter() };
        unsafe {
            notification_center.postNotificationName_object(NSWorkspaceDidWakeNotification, None);
        }

        recovery_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("wake notification should enqueue index recovery");
        assert_eq!(generation.load(Ordering::Acquire), 1);

        unsafe { notification_center.removeObserver(&observer) };
    }

    #[test]
    fn workspace_volume_notifications_trigger_callback() {
        use super::register_macos_volume_observers_with_callback;
        use objc2_app_kit::{NSWorkspaceDidMountNotification, NSWorkspaceDidUnmountNotification};
        use std::sync::atomic::AtomicUsize;

        let calls = Arc::new(AtomicUsize::new(0));
        let calls_for_cb = calls.clone();
        let observers = register_macos_volume_observers_with_callback(move || {
            calls_for_cb.fetch_add(1, Ordering::AcqRel);
        });

        let workspace = unsafe { NSWorkspace::sharedWorkspace() };
        let notification_center = unsafe { workspace.notificationCenter() };
        unsafe {
            notification_center.postNotificationName_object(NSWorkspaceDidMountNotification, None);
            notification_center
                .postNotificationName_object(NSWorkspaceDidUnmountNotification, None);
        }

        assert!(calls.load(Ordering::Acquire) >= 2);
        for observer in observers {
            unsafe { notification_center.removeObserver(&observer) };
        }
    }
}
