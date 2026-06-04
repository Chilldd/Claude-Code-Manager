// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![windows_subsystem = "windows"]

mod claude_agents;
mod config;
mod errors;
mod import;
pub mod log;
mod metrics;
mod platform;
mod pty;
mod workspace;

use errors::AppError;
use log::debug_log;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Manager, WebviewWindow};

/// Frontend-facing wrapper so JS can log to the same file
#[tauri::command]
fn frontend_log(msg: String) {
    debug_log(format!("[frontend] {}", msg));
}

// ── AppState ──

struct AppState {
    pty: Mutex<pty::PtyManager>,
    metrics: Mutex<metrics::MetricsEngine>,
    agents: claude_agents::ClaudeAgentMonitor,
}

// ── Tauri commands ──

// Workspace CRUD

#[tauri::command]
fn get_workspaces() -> Vec<workspace::Workspace> {
    workspace::get_workspaces()
}

#[tauri::command]
fn add_workspace(ws: workspace::Workspace) -> Vec<workspace::Workspace> {
    workspace::add_workspace(ws)
}

#[tauri::command]
fn update_workspace(ws: workspace::Workspace) -> Vec<workspace::Workspace> {
    workspace::update_workspace(ws)
}

#[tauri::command]
fn delete_workspace(id: String) -> Vec<workspace::Workspace> {
    workspace::delete_workspace(id)
}

#[tauri::command]
fn reorder_workspaces(ids: Vec<String>) -> Vec<workspace::Workspace> {
    workspace::reorder_workspaces(ids)
}

#[tauri::command]
fn import_from_claude_code() -> Vec<workspace::Workspace> {
    import::import_from_claude_code()
}

// PTY session management

#[tauri::command]
fn create_pty(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    session_id: String,
    workspace_id: String,
    session_name: String,
    command: String,
    args: String,
    cwd: String,
    env: std::collections::HashMap<String, String>,
) -> Result<String, AppError> {
    debug_log(format!("create_pty: sid={}, cmd={}, args={}, cwd={}", &session_id, command, args, cwd));

    let mut pty = state.pty.lock().map_err(|e| {
        let msg = format!("pty lock: {}", e);
        debug_log(&msg);
        AppError::Internal(msg)
    })?;

    let (_, root_pids) = pty.create(
        &window,
        &session_id,
        &workspace_id,
        &session_name,
        &command,
        &args,
        &cwd,
        env,
    ).map_err(|e| {
        debug_log(format!("pty.create FAILED: {}", e));
        AppError::PtyError(e)
    })?;

    debug_log(format!("create_pty OK: session_id={}", session_id));

    // Notify metrics engine to start tracking this session's processes
    debug_log("about to lock metrics");
    let metrics = state.metrics.lock().map_err(|e| {
        let msg = format!("metrics lock: {}", e);
        debug_log(&msg);
        AppError::Internal(msg)
    })?;
    debug_log("metrics locked, sending TrackSession");
    metrics.send(metrics::MetricsCmd::TrackSession {
        session_id: session_id.clone(),
        root_pids: root_pids.clone(),
    });
    debug_log("TrackSession sent");

    // Emit session-created event to frontend
    debug_log("about to emit session-created");
    if let Err(e) = window.emit(
        "session-created",
        pty::SessionCreatedPayload {
            session_id: session_id.clone(),
            workspace_id,
            root_pids,
        },
    ) {
        eprintln!("[main] Failed to emit session-created: {}", e);
    }

    debug_log("create_pty returning OK");
    Ok(session_id)
}

#[tauri::command]
fn write_pty(
    state: tauri::State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), AppError> {
    let mut pty = state.pty.lock()
        .map_err(|e| { debug_log(format!("[main] write_pty lock error: {}", e)); AppError::Internal(e.to_string()) })?;
    pty.write(&session_id, &data)
        .map_err(|e| { debug_log(format!("[main] write_pty error session={}: {}", session_id, e)); AppError::PtyError(e) })
}

#[tauri::command]
fn resize_pty(
    state: tauri::State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    let mut pty = state.pty.lock()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    pty.resize(&session_id, cols, rows)
        .map_err(|e| { debug_log(format!("[main] resize_pty error session={}: {}", session_id, e)); AppError::PtyError(e) })
}

#[tauri::command]
fn kill_pty(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), AppError> {
    debug_log(format!("[main] kill_pty session={}", session_id));
    let mut pty = state.pty.lock()
        .map_err(|e| { debug_log(format!("[main] kill_pty lock error: {}", e)); AppError::Internal(e.to_string()) })?;
    pty.kill(&session_id);

    // Notify metrics engine to stop tracking
    let metrics = state.metrics.lock()
        .map_err(|e| { debug_log(format!("[main] kill_pty metrics lock error: {}", e)); AppError::Internal(e.to_string()) })?;
    metrics.send(metrics::MetricsCmd::UntrackSession {
        session_id: session_id.clone(),
    });

    // Emit session-killed event
    if let Err(e) = window.emit(
        "session-killed",
        pty::SessionKilledPayload {
            session_id,
        },
    ) {
        eprintln!("[main] Failed to emit session-killed: {}", e);
    }

    Ok(())
}

#[tauri::command]
fn is_pty_active(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<bool, AppError> {
    let pty = state.pty.lock()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(pty.is_active(&session_id))
}

#[tauri::command]
fn list_active_sessions(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<pty::SessionInfo>, AppError> {
    let pty = state.pty.lock()
        .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(pty.list_active())
}

#[tauri::command]
fn get_agent_info(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Option<claude_agents::ClaudeAgentInfo> {
    state.agents.get(&session_id)
}

#[tauri::command]
fn get_config() -> config::Ccconfig {
    config::load()
}

#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    debug_log(format!("[main] open_in_explorer path={}", path));
    let path = std::path::Path::new(&path);
    if !path.exists() {
        let msg = format!("路径不存在：{}", path.display());
        debug_log(format!("[main] open_in_explorer: {}", msg));
        return Err(msg);
    }
    let canonical = path.canonicalize()
        .map_err(|e| { let m = format!("无法解析路径：{}", e); debug_log(format!("[main] open_in_explorer: {}", m)); m })?;
    // On Windows, use explorer.exe to open the directory
    std::process::Command::new("explorer")
        .arg(canonical.as_os_str())
        .spawn()
        .map_err(|e| { let m = format!("无法打开资源管理器：{}", e); debug_log(format!("[main] open_in_explorer: {}", m)); m })?;
    Ok(())
}

#[derive(Serialize)]
struct WorktreeInfo {
    name: String,
    path: String,
    active: bool, // true = has actual content, false = orphaned empty directory
}

#[tauri::command]
fn scan_worktrees(path: String) -> Result<Vec<WorktreeInfo>, String> {
    debug_log(format!("[main] scan_worktrees path={}", path));
    let worktrees_dir = std::path::Path::new(&path).join(".claude").join("worktrees");

    if !worktrees_dir.exists() {
        debug_log("[main] scan_worktrees: no .claude/worktrees dir");
        return Ok(Vec::new()); // No worktrees yet, not an error
    }

    let mut worktrees = Vec::new();
    let entries = std::fs::read_dir(&worktrees_dir)
        .map_err(|e| { let m = format!("无法读取 worktrees 目录：{}", e); debug_log(format!("[main] scan_worktrees: {}", m)); m })?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败：{}", e))?;
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            let name = entry.file_name();
            let name = name.to_string_lossy().to_string();
            // Skip empty names or hidden files
            if !name.is_empty() && !name.starts_with('.') {
                // Check if directory has actual content (not just . and ..)
                let has_content = std::fs::read_dir(entry.path())
                    .map(|mut rd| rd.next().is_some())
                    .unwrap_or(false);
                worktrees.push(WorktreeInfo {
                    path: entry.path().to_string_lossy().to_string(),
                    name,
                    active: has_content,
                });
            }
        }
    }

    // Sort alphabetically for consistent display
    worktrees.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(worktrees)
}

#[tauri::command]
fn send_session_notification(
    app: tauri::AppHandle,
    session_id: String,
    title: String,
    body: String,
) {
    let identifier = &app.config().identifier;
    platform::notifications::send_toast_with_deeplink(identifier, &session_id, &title, &body);
}

// ── Main ──

fn main() {
    // Load config early — logging and other subsystems depend on it
    let cfg = config::load();
    log::init(&cfg.log.level, &cfg.log.path);
    debug_log("[main] config loaded, logging initialized");

    let incoming_deeplink = std::env::args()
        .find(|a| a.starts_with("yug-cc-manager://"))
        .and_then(|url| platform::deeplink::parse_session_id(&url));

    platform::protocol::register_protocol();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Forward deep-link from notification clicks (second instance) to the
            // already-running window instead of opening a new one.
            if let Some(url) = argv.iter().find(|a| a.starts_with("yug-cc-manager://")) {
                if let Some(sid) = platform::deeplink::parse_session_id(url) {
                    platform::deeplink::handle_deep_link(app, &sid);
                }
            }
        }));

    builder
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            // Spawn the metrics engine (background sampling + event emitter)
            let metrics_engine = metrics::MetricsEngine::spawn(app.handle().clone());

            // Spawn the Claude agents monitor (polls claude agents --json + emits events)
            let agents_monitor = claude_agents::ClaudeAgentMonitor::spawn(app.handle().clone());

            // Store manager + metrics engine in app state
            app.manage(AppState {
                pty: Mutex::new(pty::PtyManager::new()),
                metrics: Mutex::new(metrics_engine),
                agents: agents_monitor,
            });

            if let Some(sid) = incoming_deeplink {
                platform::deeplink::handle_deep_link(app.handle(), &sid);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_workspaces,
            add_workspace,
            update_workspace,
            delete_workspace,
            reorder_workspaces,
            import_from_claude_code,
            create_pty,
            write_pty,
            resize_pty,
            kill_pty,
            is_pty_active,
            list_active_sessions,
            get_agent_info,
            get_config,
            send_session_notification,
            open_in_explorer,
            scan_worktrees,
            frontend_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
