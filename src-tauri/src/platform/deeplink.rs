use serde::Serialize;
use tauri::{Emitter, Manager};

/// Parse a `yug-cc-manager://session/{id}` URL and return the session ID.
pub fn parse_session_id(url: &str) -> Option<String> {
    url.strip_prefix("yug-cc-manager://session/")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Handle an incoming deep-link by emitting an event to the frontend and
/// bringing the main window to the foreground.
pub fn handle_deep_link(app: &tauri::AppHandle, session_id: &str) {
    #[derive(Clone, Serialize)]
    struct Payload {
        session_id: String,
    }

    if let Err(e) = app.emit("session-deeplink", Payload {
        session_id: session_id.to_string(),
    }) {
        eprintln!("[deeplink] Failed to emit session-deeplink: {}", e);
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();

        // ── Bring window to foreground ──
        // SetWindowPos with HWND_TOPMOST changes Z-order without needing the
        // Windows foreground-lock permission, bringing the window above all
        // others.  We immediately revert to HWND_NOTOPMOST so it doesn't
        // stay "always on top" permanently.
        #[cfg(target_os = "windows")]
        unsafe {
            use raw_window_handle::HasWindowHandle;
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::{
                IsIconic, SetWindowPos, ShowWindow, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOMOVE,
                SWP_NOSIZE, SWP_SHOWWINDOW, SW_RESTORE,
            };

            if let Ok(handle) = window.window_handle() {
                if let raw_window_handle::RawWindowHandle::Win32(win32) = handle.as_raw() {
                    let hwnd = HWND(win32.hwnd.get() as _);
                    if IsIconic(hwnd).as_bool() {
                        let _ = ShowWindow(hwnd, SW_RESTORE);
                    }
                    let _ = SetWindowPos(
                        hwnd,
                        Some(HWND_TOPMOST),
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
                    );
                    let _ = SetWindowPos(
                        hwnd,
                        Some(HWND_NOTOPMOST),
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
                    );
                }
            }
        }

        let _ = window.set_focus();
    }
}
