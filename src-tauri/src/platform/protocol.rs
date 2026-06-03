/// Register the `yug-cc-manager://` custom protocol handler on Windows.
///
/// Writes to `HKEY_CURRENT_USER\Software\Classes\yug-cc-manager` so the OS
/// knows to launch this application when the custom URL scheme is activated.
pub fn register_protocol() {
    let exe = match std::env::current_exe() {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(e) => {
            eprintln!("[protocol] Failed to get exe path: {}", e);
            return;
        }
    };

    let hkcu = match winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey_with_flags(r"Software\Classes", winreg::enums::KEY_WRITE)
    {
        Ok(k) => k,
        Err(e) => {
            eprintln!("[protocol] Failed to open Software\\Classes: {}", e);
            return;
        }
    };

    let (proto, _) = match hkcu.create_subkey("yug-cc-manager") {
        Ok(k) => k,
        Err(e) => {
            eprintln!("[protocol] Failed to create subkey: {}", e);
            return;
        }
    };
    if let Err(e) = proto.set_value("", &"URL:yug-cc-manager Protocol") {
        eprintln!("[protocol] Failed to set description: {}", e);
    }
    if let Err(e) = proto.set_value("URL Protocol", &"") {
        eprintln!("[protocol] Failed to set URL Protocol: {}", e);
    }

    let (cmd, _) = match proto.create_subkey(r"shell\open\command") {
        Ok(k) => k,
        Err(e) => {
            eprintln!("[protocol] Failed to create shell command key: {}", e);
            return;
        }
    };
    if let Err(e) = cmd.set_value("", &format!("\"{}\" \"%1\"", exe)) {
        eprintln!("[protocol] Failed to set command: {}", e);
    }
}
