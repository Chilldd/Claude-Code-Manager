// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![windows_subsystem = "windows"]

mod metrics;
mod pty;
mod workspace;

use metrics::MetricsEngine;
use pty::PtyManager;
use std::sync::Mutex;
use serde::Serialize;
use tauri::{Emitter, Manager, WebviewWindow};
use windows::core::HSTRING;

// ── AppState ──

struct AppState {
    pty: Mutex<PtyManager>,
    metrics: Mutex<MetricsEngine>,
}

// ── Deep link: protocol registration ──

fn register_protocol() {
    let exe = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => return,
    };

    let hkcu = match winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey_with_flags(r"Software\Classes", winreg::enums::KEY_WRITE)
    {
        Ok(k) => k,
        Err(_) => return,
    };

    let (proto, _) = match hkcu.create_subkey("yug-cc-manager") {
        Ok(k) => k,
        Err(_) => return,
    };
    let _ = proto.set_value("", &"URL:yug-cc-manager Protocol");
    let _ = proto.set_value("URL Protocol", &"");

    let (cmd, _) = match proto.create_subkey(r"shell\open\command") {
        Ok(k) => k,
        Err(_) => return,
    };
    let _ = cmd.set_value("", &format!("\"{}\" \"%1\"", exe));
}

// ── Custom Toast notification with deep-link activation ──

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn send_toast_with_deeplink(identifier: &str, session_id: &str, title: &str, body: &str) {
    #[cfg(target_os = "windows")]
    {
        #[allow(unused_unsafe)]
        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_MULTITHREADED,
            );
        }

        let xml = format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<toast activationType="protocol" launch="yug-cc-manager://session/{0}">
  <visual>
    <binding template="ToastGeneric">
      <text>{1}</text>
      <text>{2}</text>
    </binding>
  </visual>
</toast>"#,
            session_id,
            escape_xml(title),
            escape_xml(body),
        );

        let hxml = HSTRING::from(&xml);
        let hid = HSTRING::from(identifier);
        if let Ok(doc) = windows::Data::Xml::Dom::XmlDocument::new() {
            if doc.LoadXml(&hxml).is_err() {
                return;
            }
            if let Ok(notification) =
                windows::UI::Notifications::ToastNotification::CreateToastNotification(&doc)
            {
                if let Ok(notifier) =
                    windows::UI::Notifications::ToastNotificationManager::CreateToastNotifierWithId(
                        &hid,
                    )
                {
                    _ = notifier.Show(&notification);
                }
            }
        }
    }
}

fn parse_session_id(url: &str) -> Option<String> {
    url.strip_prefix("yug-cc-manager://session/")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn handle_deep_link(app: &tauri::AppHandle, session_id: &str) {
    #[derive(Clone, Serialize)]
    struct Payload {
        session_id: String,
    }

    let _ = app.emit("session-deeplink", Payload {
        session_id: session_id.to_string(),
    });

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

// ── Tauri commands ──

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
fn import_from_claude_code() -> Vec<workspace::Workspace> {
    workspace::import_from_claude_code()
}

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
) -> Result<String, String> {
    let mut pty = state.pty.lock().map_err(|e| e.to_string())?;
    let (session_id, root_pids) = pty.create(
        &window,
        &workspace_id,
        &session_name,
        &command,
        &args,
        &cwd,
        env,
    )?;

    // Notify metrics engine to start tracking this session's processes
    let metrics = state.metrics.lock().map_err(|e| e.to_string())?;
    metrics.send(metrics::MetricsCmd::TrackSession {
        session_id: session_id.clone(),
        root_pids,
    });

    // Emit session-created event to frontend
    let _ = window.emit(
        "session-created",
        pty::SessionCreatedPayload {
            session_id: session_id.clone(),
            workspace_id,
            root_pids: vec![], // we sent them to metrics engine, not needed in create event
        },
    );

    Ok(session_id)
}

#[tauri::command]
fn write_pty(
    state: tauri::State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut pty = state.pty.lock().map_err(|e| e.to_string())?;
    pty.write(&session_id, &data)
}

#[tauri::command]
fn resize_pty(
    state: tauri::State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut pty = state.pty.lock().map_err(|e| e.to_string())?;
    pty.resize(&session_id, cols, rows)
}

#[tauri::command]
fn kill_pty(
    window: WebviewWindow,
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let mut pty = state.pty.lock().map_err(|e| e.to_string())?;
    pty.kill(&session_id);

    // Notify metrics engine to stop tracking
    let metrics = state.metrics.lock().map_err(|e| e.to_string())?;
    metrics.send(metrics::MetricsCmd::UntrackSession {
        session_id: session_id.clone(),
    });

    // Emit session-killed event
    let _ = window.emit(
        "session-killed",
        pty::SessionKilledPayload {
            session_id,
        },
    );

    Ok(())
}

#[tauri::command]
fn is_pty_active(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<bool, String> {
    let pty = state.pty.lock().map_err(|e| e.to_string())?;
    Ok(pty.is_active(&session_id))
}

#[tauri::command]
fn list_active_sessions(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<pty::SessionInfo>, String> {
    let pty = state.pty.lock().map_err(|e| e.to_string())?;
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
    send_toast_with_deeplink(identifier, &session_id, &title, &body);
}

// ── Main ──

fn main() {
    let incoming_deeplink = std::env::args()
        .find(|a| a.starts_with("yug-cc-manager://"))
        .and_then(|url| parse_session_id(&url));

    register_protocol();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(url) = argv.iter().find(|a| a.starts_with("yug-cc-manager://")) {
                if let Some(sid) = parse_session_id(url) {
                    handle_deep_link(app, &sid);
                }
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            // Spawn the metrics engine (background sampling + event emitter)
            let metrics_engine = MetricsEngine::spawn(app.handle().clone());

            // Store manager + metrics engine in app state
            app.manage(AppState {
                pty: Mutex::new(PtyManager::new()),
                metrics: Mutex::new(metrics_engine),
            });

            if let Some(sid) = incoming_deeplink {
                handle_deep_link(app.handle(), &sid);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_workspaces,
            add_workspace,
            update_workspace,
            delete_workspace,
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
