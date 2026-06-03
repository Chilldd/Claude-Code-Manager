// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![windows_subsystem = "windows"]

mod errors;
mod import;
mod metrics;
mod platform;
mod pty;
mod workspace;

use errors::AppError;
use std::sync::Mutex;
use tauri::{Emitter, Manager, WebviewWindow};

// ── AppState ──

struct AppState {
    pty: Mutex<pty::PtyManager>,
    metrics: Mutex<metrics::MetricsEngine>,
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
    workspace_id: String,
    session_name: String,
    command: String,
    args: String,
    cwd: String,
    env: std::collections::HashMap<String, String>,
) -> Result<String, AppError> {
    let mut pty = state.pty.lock().map_err(|e| AppError::Internal(e.to_string()))?;
    let (session_id, root_pids) = pty.create(
        &window,
        &workspace_id,
        &session_name,
        &command,
        &args,
        &cwd,
        env,
    ).map_err(AppError::PtyError)?;

    // Notify metrics engine to start tracking this session's processes
    let metrics = state.metrics.lock().map_err(|e| AppError::Internal(e.to_string()))?;
    metrics.send(metrics::MetricsCmd::TrackSession {
        session_id: session_id.clone(),
        root_pids,
    });

    // Emit session-created event to frontend
    if let Err(e) = window.emit(
        "session-created",
        pty::SessionCreatedPayload {
            session_id: session_id.clone(),
            workspace_id,
            root_pids: vec![],
        },
    ) {
        eprintln!("[main] Failed to emit session-created: {}", e);
    }

    Ok(session_id)
}

#[tauri::command]
fn write_pty(
    state: tauri::State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), AppError> {
    let mut pty = state.pty.lock().map_err(|e| AppError::Internal(e.to_string()))?;
    pty.write(&session_id, &data).map_err(AppError::PtyError)
}

#[tauri::command]
fn resize_pty(
    state: tauri::State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    let mut pty = state.pty.lock().map_err(|e| AppError::Internal(e.to_string()))?;
    pty.resize(&session_id, cols, rows).map_err(AppError::PtyError)
}

#[tauri::command]
fn kill_pty(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), AppError> {
    let mut pty = state.pty.lock().map_err(|e| AppError::Internal(e.to_string()))?;
    pty.kill(&session_id);

    // Notify metrics engine to stop tracking
    let metrics = state.metrics.lock().map_err(|e| AppError::Internal(e.to_string()))?;
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
    let pty = state.pty.lock().map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(pty.is_active(&session_id))
}

#[tauri::command]
fn list_active_sessions(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<pty::SessionInfo>, AppError> {
    let pty = state.pty.lock().map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(pty.list_active())
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

            // Store manager + metrics engine in app state
            app.manage(AppState {
                pty: Mutex::new(pty::PtyManager::new()),
                metrics: Mutex::new(metrics_engine),
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
            send_session_notification,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
