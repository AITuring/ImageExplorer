// 初始化 rust-i18n，加载 locales 目录的翻译文件
rust_i18n::i18n!("locales", fallback = "en");

mod cache;
mod commands;
mod config;
mod db;
mod index;
mod menu;
mod operations;
mod trash_commands;

use commands::apps::{
    close_native_quick_look, get_app_icon, get_file_thumbnail, get_file_type_icon,
    get_installed_apps, get_recommended_apps, get_sf_symbol, get_terminal_apps,
    open_in_terminal_with, open_native_quick_look, open_with,
};
use commands::drag::start_native_file_drag;
use commands::fs::{
    batch_rename, check_full_disk_access, copy_file, create_directory, create_file,
    delete_to_trash, exists, get_disk_space, get_entries, get_file_entry, get_home_dir,
    get_mounted_volumes, get_parent_dir, move_file, open_file, open_in_terminal, open_url,
    read_camera_af_metadata, read_image_base64, read_image_dimensions, read_image_metadata,
    read_text_file, rename,
};
use commands::search::{get_smart_files, search_files};
use commands::watcher::{stop_watching, unwatch_directory, watch_directory, WatcherState};
use db::{Database, IndexBuilder, IndexUpdater, SearchEngine};
use index::{create_shared_index, IndexedFile, SharedIndex};
use operations::{
    cancel_file_operation, clear_file_operation, get_file_operation_conflicts, get_file_operations,
    retry_file_operation, start_compress_operation, start_copy_operation, start_delete_operation,
    start_extract_operation, start_move_operation, undo_file_operation, OperationManager,
};
use serde::Serialize;
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
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

    // 优先尝试 SQLite 搜索
    if let Some(ref db) = *database.inner() {
        let conn = db.connection();
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

        return Ok(SearchResponse { results });
    }

    // 回退到内存索引（阻塞等待，避免索引构建期间返回空结果）
    let index = index.inner().clone();
    let results = tauri::async_runtime::spawn_blocking(move || {
        let index = match index.read() {
            Ok(idx) => idx,
            Err(_) => return vec![],
        };
        index.search(&query, limit_val)
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(SearchResponse { results })
}

/// 获取索引状态
#[derive(Serialize)]
struct IndexStatus {
    is_building: bool,
    file_count: usize,
}

#[tauri::command]
fn get_index_status(index: tauri::State<'_, SharedIndex>) -> IndexStatus {
    // 使用 try_read 避免阻塞，如果无法获取锁则返回默认值
    if let Ok(index) = index.try_read() {
        IndexStatus {
            is_building: index.is_building,
            file_count: index.file_count,
        }
    } else {
        // 如果无法获取锁（正在构建中），返回构建中状态
        IndexStatus {
            is_building: true,
            file_count: 0,
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
                // Install the watcher before the startup delay. Buffering
                // changes here closes the gap between the previous snapshot
                // and a later decision to reuse or rebuild it.
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

                println!(
                    "Delaying index decision for {} seconds to allow UI to load...",
                    config::INDEX_BUILD_DELAY_SECS
                );
                std::thread::sleep(std::time::Duration::from_secs(
                    config::INDEX_BUILD_DELAY_SECS,
                ));

                let builder = IndexBuilder::new(db.connection());
                if !db.needs_rebuild() && watcher_started {
                    let count = db.file_count();
                    println!("SQLite index ready: {} files (skipping rebuild)", count);

                    if let Ok(mut idx) = index.write() {
                        idx.is_building = false;
                        idx.file_count = count as usize;
                    }
                    is_building.store(false, Ordering::Release);
                    let _ = app.emit("index-status", "ready");
                    return;
                }

                if let Ok(mut idx) = index.write() {
                    idx.is_building = true;
                }
                println!("Starting SQLite index build...");
                let _ = app.emit("index-status", "building");
                match builder.build(&home_str, Some(&app)) {
                    Ok(count) => {
                        println!("SQLite index built: {} files", count);
                        if let Ok(mut idx) = index.write() {
                            idx.is_building = false;
                            idx.file_count = count;
                        }
                    }
                    Err(e) => {
                        eprintln!(
                            "SQLite index build failed; keeping the last committed index: {}",
                            e
                        );
                        if let Ok(mut idx) = index.write() {
                            idx.is_building = false;
                            idx.file_count = db.file_count().max(0) as usize;
                        }
                        if let Err(marker_error) = builder.mark_rebuild_required() {
                            eprintln!("Failed to mark SQLite index for a retry: {marker_error}");
                        }
                    }
                }
                is_building.store(false, Ordering::Release);
                if !watcher_started {
                    if let Err(error) = builder.mark_rebuild_required() {
                        eprintln!("Failed to mark SQLite index for retry: {error}");
                    }
                }
                let _ = app.emit("index-status", "ready");
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
                }
                let _ = app.emit("index-status", "building");

                match builder.build(&root, None) {
                    Ok(count) => {
                        if let Ok(mut idx) = index.write() {
                            idx.is_building = false;
                            idx.file_count = count;
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
                        }
                    }
                }

                is_building.store(false, Ordering::Release);
                let _ = app.emit("index-status", "ready");

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
                Ok(Ok(event)) => pending_events.push(event),
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

fn apply_sqlite_index_event(updater: &IndexUpdater, event: notify::Event) {
    use notify::EventKind;

    let result = match event.kind {
        EventKind::Create(_)
        | EventKind::Modify(
            notify::event::ModifyKind::Data(_) | notify::event::ModifyKind::Metadata(_),
        ) => {
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
            if event.id() == "new-window" {
                if let Some(window) = app
                    .webview_windows()
                    .values()
                    .find(|window| window.is_focused().unwrap_or(false))
                {
                    if let Err(error) = window.emit("menu-new-window-request", ()) {
                        eprintln!("Failed to route the new-window command: {error}");
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
            get_disk_space,
            get_parent_dir,
            open_file,
            delete_to_trash,
            exists,
            open_in_terminal,
            create_directory,
            create_file,
            rename,
            copy_file,
            move_file,
            watch_directory,
            unwatch_directory,
            stop_watching,
            search_files,
            search_indexed,
            get_smart_files,
            get_index_status,
            open_url,
            check_full_disk_access,
            get_installed_apps,
            get_terminal_apps,
            get_recommended_apps,
            get_app_icon,
            get_file_thumbnail,
            get_file_type_icon,
            open_with,
            open_in_terminal_with,
            open_native_quick_look,
            close_native_quick_look,
            get_sf_symbol,
            start_native_file_drag,
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

    app.run(move |app_handle, event| {
        #[cfg(target_os = "macos")]
        let _keep_wake_observer_alive = wake_observer.as_ref();

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
}
