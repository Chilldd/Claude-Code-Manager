use windows::core::HSTRING;

/// Escape special XML characters for safe inclusion in Toast XML.
fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Send a Windows Toast notification that opens the app via deep link on click.
///
/// The toast XML includes a `launch` attribute with the `yug-cc-manager://session/{id}`
/// URI, so clicking the notification brings the user directly to the session.
pub fn send_toast_with_deeplink(
    identifier: &str,
    session_id: &str,
    title: &str,
    body: &str,
) {
    #[cfg(target_os = "windows")]
    {
        // COM initialization (MTA) — required before WinRT API calls.
        // In practice the Tauri runtime may already have initialized COM,
        // but calling CoInitializeEx again is safe (returns RPC_E_CHANGED_MODE
        // or S_FALSE, which we ignore).
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
                eprintln!("[notifications] Failed to load Toast XML");
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
                } else {
                    eprintln!("[notifications] Failed to create ToastNotifier");
                }
            } else {
                eprintln!("[notifications] Failed to create ToastNotification");
            }
        } else {
            eprintln!("[notifications] Failed to create XmlDocument");
        }
    }
}
