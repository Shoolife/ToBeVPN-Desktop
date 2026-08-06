mod autostart;
mod diagnostics;
#[cfg(target_os = "linux")]
pub mod linux_update;
mod vpn;

use keyring::{Entry, Error as KeyringError};
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WindowEvent};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

#[cfg(target_os = "linux")]
use gtk::prelude::*;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use std::{ffi::OsString, os::windows::ffi::OsStringExt};

use vpn::config::ServerConfig;
use vpn::manager::VpnManager;
use vpn::state::{PingHostMapping, TrafficStats, VpnState};
use vpn::ConnectAttempt;

/// Shared VPN manager state.
struct AppVpn(Arc<Mutex<Option<VpnManager>>>);

/// Serializes start/stop pipelines so a user mashing the Connect button
/// can't fire three concurrent xray spawns. Held for the duration of one
/// command — the manager's own state lock is too granular for this (it
/// covers state-field writes only, not the full pipeline).
struct VpnPipelineLock {
    gate: Arc<Mutex<()>>,
    generation: Arc<AtomicU64>,
}

const SECURE_SESSION_SERVICE: &str = "network.tobevpn.desktop";
const SECURE_SESSION_ACCOUNT: &str = "device-session-v1";
const SECURE_SESSION_TOMBSTONE: &str = "tobevpn-revoked-v1";
const MAX_SECURE_SESSION_BYTES: usize = 64 * 1024;
const MAX_DESKTOP_STATS_BYTES: usize = 512 * 1024;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(target_os = "linux")]
const LEGACY_WEBKIT_WAL_COMPACT_THRESHOLD_BYTES: u64 = 8 * 1024 * 1024;

#[cfg(target_os = "windows")]
fn windows_system_directory() -> Result<PathBuf, String> {
    use windows::Win32::System::SystemInformation::GetSystemDirectoryW;

    let mut buffer = vec![0u16; 32_768];
    let length = unsafe { GetSystemDirectoryW(Some(&mut buffer)) } as usize;
    if length == 0 || length >= buffer.len() {
        return Err("Could not resolve the Windows system directory".into());
    }
    Ok(PathBuf::from(OsString::from_wide(&buffer[..length])))
}

#[cfg(target_os = "windows")]
fn configure_windows_powershell_environment(
    command: &mut std::process::Command,
) -> Result<(), String> {
    let system_dir = windows_system_directory()?;
    let windows_dir = system_dir
        .parent()
        .ok_or_else(|| "Windows system directory has no parent".to_string())?;
    let powershell_dir = system_dir.join("WindowsPowerShell").join("v1.0");
    let module_path = powershell_dir.join("Modules");
    let wbem_dir = system_dir.join("Wbem");
    let trusted_path = std::env::join_paths([
        system_dir.as_path(),
        wbem_dir.as_path(),
        powershell_dir.as_path(),
    ])
    .map_err(|_| "Could not construct the trusted Windows command path".to_string())?;

    command
        .env_clear()
        .env("SystemRoot", windows_dir)
        .env("WINDIR", windows_dir)
        .env("ComSpec", system_dir.join("cmd.exe"))
        .env("PATH", trusted_path)
        .env("PSModulePath", module_path)
        .env("TEMP", windows_dir.join("Temp"))
        .env("TMP", windows_dir.join("Temp"))
        .env("POWERSHELL_TELEMETRY_OPTOUT", "1")
        .current_dir(&system_dir);
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    diagnostics::record_native("Window", "Main window show requested");
    if let Some(window) = app.get_webview_window("main") {
        eprintln!(
            "[TRAY] show_main_window: visible={:?} minimized={:?}",
            window.is_visible(),
            window.is_minimized()
        );

        #[cfg(target_os = "linux")]
        {
            restore_window_chrome(&window);
            let _ = window.set_skip_taskbar(false);
            if let Ok(gtk_window) = window.gtk_window() {
                gtk_window.set_skip_taskbar_hint(false);
                gtk_window.set_skip_pager_hint(false);
                gtk_window.deiconify();
                gtk_window.present();
            }
            let _ = window.show();
            if window.is_minimized().unwrap_or(false) {
                let _ = window.unminimize();
            }
            restore_window_chrome(&window);
            let _ = window.set_focus();
            refresh_window_chrome_after_show(window);
        }

        #[cfg(not(target_os = "linux"))]
        {
            restore_window_chrome(&window);
            let _ = window.show();
            if window.is_minimized().unwrap_or(false) {
                let _ = window.unminimize();
            }
            restore_window_chrome(&window);
            let _ = window.set_focus();
            refresh_window_chrome_after_show(window);
        }
    }
}

fn restore_window_chrome(window: &tauri::WebviewWindow) {
    let _ = window.set_enabled(true);
    let _ = window.set_focusable(true);
    let _ = window.set_minimizable(true);
    let _ = window.set_closable(true);
    let _ = window.set_maximizable(false);
    apply_platform_window_chrome(window);
}

#[cfg(target_os = "windows")]
fn apply_platform_window_chrome(window: &tauri::WebviewWindow) {
    let _ = window.set_decorations(false);
    let _ = window.set_shadow(false);
    let _ = window.set_background_color(Some(tauri::utils::config::Color(0, 0, 0, 0)));
    apply_windows_rounded_corners(window);
}

#[cfg(not(target_os = "windows"))]
fn apply_platform_window_chrome(window: &tauri::WebviewWindow) {
    let _ = window.set_decorations(true);
}

#[cfg(target_os = "windows")]
fn apply_windows_rounded_corners(window: &tauri::WebviewWindow) {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE,
        DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };

    if let Ok(hwnd) = window.hwnd() {
        let preference = DWMWCP_ROUND;
        let border_color = DWMWA_COLOR_NONE;
        unsafe {
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &preference as *const _ as _,
                std::mem::size_of_val(&preference) as u32,
            );
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_BORDER_COLOR,
                &border_color as *const _ as _,
                std::mem::size_of_val(&border_color) as u32,
            );
        }
    }
}

#[cfg(target_os = "linux")]
fn is_wayland_session() -> bool {
    std::env::var("WAYLAND_DISPLAY")
        .map(|value| !value.is_empty())
        .unwrap_or(false)
        || std::env::var("XDG_SESSION_TYPE")
            .map(|value| value.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn rebuild_wayland_titlebar(window: &tauri::WebviewWindow) {
    if !is_wayland_session() {
        return;
    }

    if let Ok(gtk_window) = window.gtk_window() {
        let title = gtk_window
            .title()
            .map(|value| value.to_string())
            .unwrap_or_else(|| "ToBeVPN".into());
        let layout = if gtk_window.is_resizable() {
            "menu:minimize,maximize,close"
        } else {
            "menu:minimize,close"
        };
        let header = gtk::HeaderBar::builder()
            .show_close_button(true)
            .decoration_layout(layout)
            .title(title)
            .build();

        // Wayland needs an event window around rebuilt CSD titlebars for drag.
        // Keep it below child widgets so header buttons still receive clicks.
        let event_box = gtk::EventBox::new();
        event_box.set_above_child(false);
        event_box.set_visible_window(false);
        event_box.set_can_focus(false);
        event_box.add(&header);

        let header_weak = header.downgrade();
        gtk_window.connect_resizable_notify(move |gtk_window| {
            if let Some(header) = header_weak.upgrade() {
                let layout = if gtk_window.is_resizable() {
                    "menu:minimize,maximize,close"
                } else {
                    "menu:minimize,close"
                };
                header.set_decoration_layout(Some(layout));
            }
        });

        gtk_window.set_titlebar(Some(&event_box));
        gtk_window.set_sensitive(true);
        gtk_window.set_deletable(true);
        event_box.show_all();
        eprintln!("[TRAY] rebuilt Wayland titlebar");
    }
}

fn send_window_to_background(window: tauri::WebviewWindow) {
    diagnostics::record_native("Window", "Main window hidden to system tray");
    restore_window_chrome(&window);

    #[cfg(target_os = "linux")]
    let _ = window.set_skip_taskbar(true);

    match window.hide() {
        Ok(_) => eprintln!("[TRAY] window hidden"),
        Err(e) => eprintln!("[TRAY] hide failed: {e:?}"),
    }
}

#[tauri::command]
fn hide_main_window_to_tray(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        tauri::async_runtime::spawn(async move {
            send_window_to_background(window);
        });
    }
}

fn refresh_window_chrome_after_show(window: tauri::WebviewWindow) {
    #[cfg(target_os = "linux")]
    {
        restore_window_chrome(&window);
        rebuild_wayland_titlebar(&window);

        let window_for_refresh = window.clone();
        gtk::glib::timeout_add_local_once(Duration::from_millis(120), move || {
            restore_window_chrome(&window_for_refresh);
            rebuild_wayland_titlebar(&window_for_refresh);
            let _ = window_for_refresh.set_skip_taskbar(false);
            let _ = window_for_refresh.set_focus();
        });
    }

    #[cfg(not(target_os = "linux"))]
    let _ = window;
}

/// Returns the system hostname (e.g. "ivan-pc").
#[tauri::command]
fn get_hostname() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_default()
}

/// Stable per-machine ID. Linux: /etc/machine-id, macOS: IOPlatformUUID,
/// Windows: HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid.
/// Survives app reinstall, does NOT survive OS reinstall.
#[tauri::command]
fn get_hwid() -> String {
    machine_uid::get().unwrap_or_default()
}

/// OS version string, e.g. "11" / "26.4" / "24.04".
#[tauri::command]
fn get_os_version() -> String {
    os_info::get().version().to_string()
}

/// OS family name normalized for the panel: "Windows" / "macOS" / "Linux".
#[tauri::command]
fn get_os_name() -> String {
    match std::env::consts::OS {
        "windows" => "Windows".into(),
        "macos" => "macOS".into(),
        "linux" => "Linux".into(),
        other => other.to_string(),
    }
}

/// Hardware model identifier, e.g. "MacBookPro18,3" / "Dell XPS 13".
/// Falls back to OS edition (e.g. "Pro") if model can't be detected.
#[tauri::command]
fn get_device_model() -> String {
    if let Some(model) = detect_hardware_model() {
        return model;
    }

    let info = os_info::get();
    let edition = info.edition().unwrap_or("");
    let codename = info.codename().unwrap_or("");
    if !edition.is_empty() {
        edition.to_string()
    } else if !codename.is_empty() {
        codename.to_string()
    } else {
        info.os_type().to_string()
    }
}

fn clean_device_model_part(value: &str) -> Option<String> {
    let cleaned = value.trim().trim_matches(char::from(0)).trim();
    let normalized = cleaned.to_ascii_lowercase();
    let generic = [
        "",
        "0",
        "none",
        "null",
        "unknown",
        "default string",
        "not specified",
        "not applicable",
        "to be filled by o.e.m.",
        "to be filled by oem",
        "system product name",
        "system manufacturer",
        "standard pc",
        "computer",
        "desktop",
        "pc",
        "linux",
        "windows",
        "macos",
    ];
    if generic.contains(&normalized.as_str()) {
        None
    } else {
        let bounded = cleaned
            .chars()
            .map(|character| {
                if character.is_control() {
                    ' '
                } else {
                    character
                }
            })
            .take(256)
            .collect::<String>();
        let bounded = bounded.split_whitespace().collect::<Vec<_>>().join(" ");
        (!bounded.is_empty()).then_some(bounded)
    }
}

fn compose_vendor_model(vendor: Option<String>, model: Option<String>) -> Option<String> {
    let model = model?;
    match vendor {
        Some(vendor)
            if !model
                .to_ascii_lowercase()
                .starts_with(&vendor.to_ascii_lowercase()) =>
        {
            Some(format!("{vendor} {model}"))
        }
        _ => Some(model),
    }
}

fn looks_like_model_code(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 12
        && value
            .chars()
            .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '-' || ch == '_')
        && value.chars().any(|ch| ch.is_ascii_digit())
}

fn prefer_human_model(
    product_name: Option<String>,
    product_version: Option<String>,
    product_family: Option<String>,
) -> Option<String> {
    let product_name_is_code = product_name
        .as_deref()
        .map(looks_like_model_code)
        .unwrap_or(false);

    if product_name_is_code {
        return product_version.or(product_family).or(product_name);
    }

    product_name.or(product_version).or(product_family)
}

#[cfg(target_os = "linux")]
fn detect_hardware_model() -> Option<String> {
    fn read_dmi(name: &str) -> Option<String> {
        fs::read_to_string(PathBuf::from("/sys/class/dmi/id").join(name))
            .ok()
            .and_then(|value| clean_device_model_part(&value))
    }

    let vendor = read_dmi("sys_vendor");
    let model = prefer_human_model(
        read_dmi("product_name"),
        read_dmi("product_version"),
        read_dmi("product_family"),
    );

    compose_vendor_model(vendor, model)
        .or_else(|| compose_vendor_model(read_dmi("board_vendor"), read_dmi("board_name")))
}

#[cfg(target_os = "windows")]
fn detect_hardware_model() -> Option<String> {
    let powershell = windows_system_directory()
        .ok()?
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if !powershell.is_file() {
        return None;
    }
    let mut command = std::process::Command::new(powershell);
    configure_windows_powershell_environment(&mut command).ok()?;
    let output = command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "$c=Get-CimInstance Win32_ComputerSystem; (($c.Manufacturer,$c.Model) -join ' ')",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    clean_device_model_part(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(target_os = "macos")]
fn detect_hardware_model() -> Option<String> {
    let output = std::process::Command::new("sysctl")
        .args(["-n", "hw.model"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    clean_device_model_part(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn detect_hardware_model() -> Option<String> {
    None
}

fn secure_session_entry() -> Result<Entry, String> {
    Entry::new(SECURE_SESSION_SERVICE, SECURE_SESSION_ACCOUNT)
        .map_err(|e| format!("Could not open secure session storage: {e}"))
}

#[tauri::command]
fn load_secure_session() -> Result<Option<String>, String> {
    let entry = secure_session_entry()?;
    match entry.get_password() {
        Ok(value) if value.len() <= MAX_SECURE_SESSION_BYTES => Ok(Some(value)),
        Ok(_) => Err("Secure session payload is unexpectedly large".into()),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(format!("Could not load secure session: {e}")),
    }
}

#[tauri::command]
fn save_secure_session(value: String) -> Result<(), String> {
    if value.len() > MAX_SECURE_SESSION_BYTES {
        return Err("Secure session payload is unexpectedly large".into());
    }
    let entry = secure_session_entry()?;
    entry
        .set_password(&value)
        .map_err(|e| format!("Could not save secure session: {e}"))
}

#[tauri::command]
fn clear_secure_session() -> Result<(), String> {
    let entry = secure_session_entry()?;
    // Overwrite before delete. If a keyring backend updates successfully but
    // then fails deletion, the surviving value can no longer restore a login.
    match entry.set_password(SECURE_SESSION_TOMBSTONE) {
        Ok(()) => {
            match entry.delete_credential() {
                Ok(_) | Err(KeyringError::NoEntry) => {}
                Err(error) => eprintln!(
                    "[SESSION] keyring tombstone retained because deletion failed: {error}"
                ),
            }
            Ok(())
        }
        Err(overwrite_error) => match entry.delete_credential() {
            Ok(_) | Err(KeyringError::NoEntry) => Ok(()),
            Err(delete_error) => Err(format!(
                "Could not revoke secure session (overwrite: {overwrite_error}; delete: {delete_error})"
            )),
        },
    }
}

fn desktop_stats_path() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .ok_or_else(|| "Could not resolve the per-user local data directory".to_string())
        .map(|directory| directory.join("ToBeVPN").join("stats.json"))
}

fn validate_desktop_stats_payload(payload: &str) -> Result<(), String> {
    if payload.len() > MAX_DESKTOP_STATS_BYTES {
        return Err("Desktop stats payload is unexpectedly large".into());
    }
    let parsed: serde_json::Value = serde_json::from_str(payload)
        .map_err(|error| format!("Desktop stats JSON is invalid: {error}"))?;
    if !parsed
        .as_object()
        .and_then(|object| object.get("buckets"))
        .is_some_and(serde_json::Value::is_array)
    {
        return Err("Desktop stats payload has an invalid shape".into());
    }
    Ok(())
}

fn read_desktop_stats_file(path: &std::path::Path) -> Result<Option<String>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not inspect {}: {error}", path.display())),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!(
            "Desktop stats path {} is not a regular file",
            path.display()
        ));
    }
    if metadata.len() > MAX_DESKTOP_STATS_BYTES as u64 {
        return Err(format!(
            "Desktop stats file {} is too large",
            path.display()
        ));
    }
    let file = fs::File::open(path)
        .map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    let mut bytes = Vec::new();
    file.take((MAX_DESKTOP_STATS_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    if bytes.len() > MAX_DESKTOP_STATS_BYTES {
        return Err(format!(
            "Desktop stats file {} is too large",
            path.display()
        ));
    }
    let payload = String::from_utf8(bytes)
        .map_err(|_| format!("Desktop stats file {} is not UTF-8", path.display()))?;
    validate_desktop_stats_payload(&payload)?;
    Ok(Some(payload))
}

#[tauri::command]
fn load_desktop_stats() -> Result<Option<String>, String> {
    let path = desktop_stats_path()?;
    match read_desktop_stats_file(&path) {
        Ok(Some(value)) => return Ok(Some(value)),
        Ok(None) => {}
        Err(error) => eprintln!("[STATS] primary stats file rejected: {error}"),
    }
    let backup = path.with_extension("json.bak");
    match read_desktop_stats_file(&backup) {
        Ok(value) => Ok(value),
        Err(error) => {
            // Both copies are unusable. Start from an empty in-memory store;
            // the next valid save repairs the primary without trusting either.
            eprintln!("[STATS] backup stats file rejected: {error}");
            Ok(None)
        }
    }
}

#[tauri::command]
fn save_desktop_stats(payload: String) -> Result<(), String> {
    validate_desktop_stats_payload(&payload)?;

    let path = desktop_stats_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "Desktop stats path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create desktop stats directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not secure desktop stats directory: {error}"))?;
    }

    let mut temporary = tempfile::Builder::new()
        .prefix(".stats-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|error| format!("Could not create desktop stats temp file: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("Could not secure desktop stats temp file: {error}"))?;
    }
    temporary
        .as_file_mut()
        .write_all(payload.as_bytes())
        .and_then(|_| temporary.as_file().sync_all())
        .map_err(|error| format!("Could not write desktop stats: {error}"))?;

    let backup_path = path.with_extension("json.bak");
    if fs::symlink_metadata(&path).is_ok() {
        if read_desktop_stats_file(&path).ok().flatten().is_some() {
            if fs::symlink_metadata(&backup_path).is_ok() {
                fs::remove_file(&backup_path)
                    .map_err(|error| format!("Could not replace desktop stats backup: {error}"))?;
            }
            fs::rename(&path, &backup_path)
                .map_err(|error| format!("Could not stage previous desktop stats: {error}"))?;
        } else {
            fs::remove_file(&path)
                .map_err(|error| format!("Could not remove corrupt desktop stats: {error}"))?;
        }
    }
    if let Err(error) = temporary.persist(&path) {
        if fs::symlink_metadata(&backup_path).is_ok() && fs::symlink_metadata(&path).is_err() {
            let _ = fs::rename(&backup_path, &path);
        }
        return Err(format!("Could not commit desktop stats: {error}"));
    }
    #[cfg(unix)]
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not sync desktop stats directory: {error}"))?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn compact_legacy_webkit_localstorage() {
    use rusqlite::{Connection, OpenFlags};
    use std::time::Duration;

    let database_path = dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("com.tobevpn.desktop")
        .join("localstorage")
        .join("tauri_localhost_0.localstorage");
    let wal_path = database_path.with_extension("localstorage-wal");
    let wal_size = match fs::metadata(&wal_path) {
        Ok(metadata) if metadata.len() >= LEGACY_WEBKIT_WAL_COMPACT_THRESHOLD_BYTES => {
            metadata.len()
        }
        _ => return,
    };

    let connection = match Connection::open_with_flags(
        &database_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(connection) => connection,
        Err(error) => {
            eprintln!("[STATS] could not open legacy WebKit localStorage for compaction: {error}");
            return;
        }
    };
    if let Err(error) = connection.busy_timeout(Duration::from_millis(250)) {
        eprintln!("[STATS] could not set localStorage busy timeout: {error}");
        return;
    }

    match connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
        ))
    }) {
        Ok((0, _, _)) => {
            let remaining = fs::metadata(&wal_path)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            eprintln!(
                "[STATS] compacted legacy WebKit localStorage WAL: {wal_size} -> {remaining} bytes"
            );
        }
        Ok((busy, _, _)) => {
            eprintln!(
                "[STATS] skipped legacy WebKit localStorage compaction: database busy ({busy})"
            );
        }
        Err(error) => {
            eprintln!("[STATS] could not compact legacy WebKit localStorage: {error}");
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn compact_legacy_webkit_localstorage() {}

#[cfg(target_os = "linux")]
#[tauri::command]
async fn install_latest_linux_update(version: String) -> Result<(), String> {
    linux_update::install_latest_via_polkit(version).await
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
async fn install_latest_linux_update(_version: String) -> Result<(), String> {
    Err("Linux update helper is unavailable on this platform".into())
}

/// Measure TCP connect latency to `host:port`.
#[tauri::command]
async fn tcp_ping(host: String, port: u16, timeout_ms: u64) -> i64 {
    let addr = format!("{}:{}", host, port);
    let deadline = Duration::from_millis(timeout_ms);
    let start = Instant::now();
    match timeout(deadline, TcpStream::connect(&addr)).await {
        Ok(Ok(_)) => start.elapsed().as_millis() as i64,
        _ => -1,
    }
}

/// Resolve a hostname to its first IP (IPv4 preferred). Returns empty string on failure.
#[tauri::command]
async fn resolve_host(host: String) -> String {
    tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        let addr = format!("{}:0", host);
        let mut addrs: Vec<_> = addr
            .to_socket_addrs()
            .ok()
            .map(|it| it.collect())
            .unwrap_or_default();
        addrs.sort_by_key(|a| if a.is_ipv4() { 0 } else { 1 });
        addrs
            .first()
            .map(|a| a.ip().to_string())
            .unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

/// Add direct routes for server ping targets while a tunnel is active and
/// return the resolved host→IPv4 mapping so the JS layer can pin `tcp_ping`
/// to the exact IP a bypass route was installed for. Without this pinning,
/// `tcp_ping` would call `getaddrinfo` a second time and potentially land
/// on a different rotation/CDN replica that isn't in the bypass set,
/// sending the probe back through the tunnel.
#[tauri::command]
async fn prepare_ping_bypass(
    hosts: Vec<String>,
    state: tauri::State<'_, AppVpn>,
) -> Result<Vec<PingHostMapping>, String> {
    let guard = state.0.lock().await;
    match guard.as_ref() {
        Some(mgr) => mgr.prepare_ping_bypass(hosts).await,
        None => Ok(Vec::new()),
    }
}

/// Start the VPN connection with the given server config.
#[tauri::command]
async fn start_vpn(
    server: ServerConfig,
    state: tauri::State<'_, AppVpn>,
    pipeline: tauri::State<'_, VpnPipelineLock>,
) -> Result<(), String> {
    // Validate untrusted renderer/backend data before touching native network
    // state. This is intentionally structural and allows private/IPv6 servers.
    server.validate()?;
    // Signal cancellation before waiting on the gate. Otherwise a rapid
    // server switch or Stop press can wait behind an obsolete start that
    // still raises system routes and briefly becomes active.
    let attempt = ConnectAttempt::begin(&pipeline.generation);
    // Serialize the entire connect pipeline. Without this a user mashing the
    // "Connect" button (or live-switch + manual reconnect) can fire several
    // start() invocations in parallel, racing xray spawns and leaving zombie
    // processes that the second start can't detect via `prev_state`.
    let _gate = pipeline.gate.lock().await;
    attempt.ensure_active()?;
    let guard = state.0.lock().await;
    match guard.as_ref() {
        Some(mgr) => mgr.start(server, &attempt).await,
        None => Err("VPN manager not initialized".into()),
    }
}

/// Stop the VPN connection.
#[tauri::command]
async fn stop_vpn(
    state: tauri::State<'_, AppVpn>,
    pipeline: tauri::State<'_, VpnPipelineLock>,
) -> Result<(), String> {
    // Stop invalidates a start immediately, even while that start still owns
    // the serialized native pipeline.
    ConnectAttempt::cancel_current(&pipeline.generation);
    let _gate = pipeline.gate.lock().await;
    let guard = state.0.lock().await;
    match guard.as_ref() {
        Some(mgr) => mgr.stop().await,
        None => Err("VPN manager not initialized".into()),
    }
}

/// Get the current VPN connection state.
#[tauri::command]
async fn get_vpn_state(state: tauri::State<'_, AppVpn>) -> Result<VpnState, String> {
    let guard = state.0.lock().await;
    match guard.as_ref() {
        Some(mgr) => Ok(mgr.get_state().await),
        None => Ok(VpnState::Disconnected),
    }
}

/// Query current traffic stats (uplink/downlink bytes since last query).
#[tauri::command]
async fn get_traffic_stats(state: tauri::State<'_, AppVpn>) -> Result<TrafficStats, String> {
    let guard = state.0.lock().await;
    match guard.as_ref() {
        Some(mgr) => mgr.query_stats().await.ok_or("Stats unavailable".into()),
        None => Err("VPN manager not initialized".into()),
    }
}

/// Read xray-core version from the bundled sidecar binary.
#[tauri::command]
async fn get_xray_version(state: tauri::State<'_, AppVpn>) -> Result<String, String> {
    let guard = state.0.lock().await;
    Ok(match guard.as_ref() {
        Some(mgr) => mgr.xray_version().await,
        None => "unknown".into(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK keeps localStorage in SQLite. Older versions wrote the VPN
    // stats snapshot once per second, which could leave a large WAL file.
    // Run a safe checkpoint before the webview opens; SQLite skips it if a
    // previous instance still owns the database.
    compact_legacy_webkit_localstorage();

    let mut builder = tauri::Builder::default();

    // Single-instance must be the FIRST plugin registered. When a second copy
    // of the .exe is launched (e.g. user double-clicks the shortcut while the
    // app is hidden in the tray), this callback fires in the first instance
    // and the second one exits — preventing the duplicate-process bug.
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            show_main_window(app);
            if cfg!(any(target_os = "windows", target_os = "linux"))
                && autostart::args_contain_autostart(argv.iter())
            {
                let _ = app.emit("autostart-connect-requested", ());
            }
        }));
    }

    #[cfg(target_os = "linux")]
    {
        builder = builder.plugin(autostart::linux_plugin());
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Deep-link `tobevpn://open` handling: we deliberately do NOT use
            // tauri-plugin-deep-link. Its init() writes a user-level
            // ~/.local/share/applications/*-handler.desktop on Linux, which
            // collides with the system .desktop the .deb installs and makes
            // the OS show an "open with" chooser with two ToBeVPN entries.
            //
            // Instead the scheme is registered purely by the bundler
            // (plugins.deep-link.schemes in tauri.conf.json adds the
            // x-scheme-handler MimeType to the .deb .desktop / Windows
            // registry), and tauri-plugin-single-instance raises the window
            // when the OS launches us with the URL while already running.
            // We only need to surface the window — auth/payment stay on the
            // existing polling path.

            // Resolve sidecar binary directory.
            // In dev mode, Tauri copies externalBin to target/debug/ (next to the executable).
            // In production, they're in the resource dir.
            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                .unwrap_or_default();

            let resource_dir = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| exe_dir.clone());
            let resource_bin_dir = resource_dir.join("bin");

            let diagnostic_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
            diagnostics::initialize(diagnostic_data_dir, env!("CARGO_PKG_VERSION").to_string())?;

            let xray_in_exe_dir = exe_dir.join("xray").exists()
                || exe_dir.join("xray.exe").exists()
                || exe_dir.join("xray-x86_64-unknown-linux-gnu").exists()
                || exe_dir.join("xray-x86_64-pc-windows-msvc.exe").exists();
            let bin_dir = if xray_in_exe_dir {
                exe_dir.clone()
            } else {
                resource_bin_dir.clone()
            };

            eprintln!("VPN bin dir: {:?}", bin_dir);
            eprintln!("VPN asset dir: {:?}", resource_bin_dir);

            let mut manager = VpnManager::new(bin_dir, resource_bin_dir);
            manager.set_app_handle(app.handle().clone());
            let shared = Arc::new(Mutex::new(Some(manager)));
            app.manage(AppVpn(shared.clone()));
            app.manage(VpnPipelineLock {
                gate: Arc::new(Mutex::new(())),
                generation: Arc::new(AtomicU64::new(0)),
            });

            // Set when the user picks "Выход" in the tray menu so the
            // CloseRequested handler lets the app actually shut down instead
            // of hiding the window. Captured by both closures below.
            let quit_flag = Arc::new(AtomicBool::new(false));

            // System tray, V2rayN-style: closing the window hides it to tray
            // (the tunnel keeps running) and Quit is the only way to fully
            // exit. Left-click on the icon restores the window.
            let show_item = MenuItem::with_id(app, "show", "Показать", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&show_item, &separator, &quit_item])?;

            let icon = app
                .default_window_icon()
                .ok_or("default window icon not available")?
                .clone();
            let quit_for_menu = quit_flag.clone();
            let tray_builder = TrayIconBuilder::with_id("main")
                .icon(icon)
                .tooltip("ToBeVPN")
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "show" => show_main_window(app),
                    "quit" => {
                        quit_for_menu.store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });

            #[cfg(target_os = "linux")]
            {
                // libayatana-appindicator registers the StatusNotifierItem and
                // its DBusMenu almost simultaneously. GNOME Shell 50 can race
                // those signals, dispose the first menu actor, and leave a
                // correctly exported `Показать`/`Выход` menu visually blank.
                // Register the indicator first and attach its menu on the next
                // settled GTK turn. Windows does not use AppIndicator and keeps
                // the synchronous menu path below.
                let tray = tray_builder.build(app)?;
                let tray_for_menu = tray.clone();
                let delayed_menu = menu.clone();
                gtk::glib::timeout_add_local_once(Duration::from_millis(350), move || {
                    match tray_for_menu.set_menu(Some(delayed_menu)) {
                        Ok(()) => eprintln!("[TRAY] Linux menu attached after indicator setup"),
                        Err(error) => eprintln!("[TRAY] Linux menu attach failed: {error}"),
                    }
                });
            }

            #[cfg(not(target_os = "linux"))]
            {
                let _tray = tray_builder.menu(&menu).build(app)?;
            }

            // Intercept the [X] button per-window: send the window to the tray
            // instead of exiting so the tunnel keeps running in the background.
            // The builder-level
            // .on_window_event hook proved unreliable on Linux/GTK — after the
            // first hide()/show() cycle from the tray, subsequent close events
            // weren't routed back to it. Binding directly on the window works
            // every time.
            //
            // The background operation is dispatched via async_runtime::spawn
            // rather than called inline — invoking GTK from inside its own
            // delete-event callback is reentrant and on some Wayland/GTK setups
            // the call is silently dropped, leaving the window stuck on screen.
            if let Some(main_window) = app.get_webview_window("main") {
                restore_window_chrome(&main_window);
                let quit_for_window = quit_flag.clone();
                let window_for_handler = main_window.clone();
                main_window.on_window_event(move |event| match event {
                    WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                        #[cfg(target_os = "windows")]
                        apply_platform_window_chrome(&window_for_handler);
                    }
                    WindowEvent::CloseRequested { api, .. } => {
                        eprintln!("[TRAY] CloseRequested fired");
                        if quit_for_window.load(Ordering::SeqCst) {
                            eprintln!("[TRAY] quit flag set — allowing close");
                            return;
                        }
                        api.prevent_close();
                        let w = window_for_handler.clone();
                        tauri::async_runtime::spawn(async move {
                            send_window_to_background(w);
                        });
                    }
                    _ => {}
                });
            }

            // Windows and Linux create the window hidden to avoid an early
            // unstyled flash. Once setup is complete every launch, including
            // an OS autostart launch, presents the main window.
            show_main_window(app.handle());

            // Recover from a previous unclean shutdown (crash / SIGKILL / dev HMR
            // restart). If leftover ip rules + TUN are present, internet is broken
            // until they're removed. Run the cleanup off the setup thread so the
            // window opens immediately even if pkexec takes a moment.
            tauri::async_runtime::spawn(async move {
                let guard = shared.lock().await;
                if let Some(mgr) = guard.as_ref() {
                    mgr.cleanup_stale_state().await;
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_hostname,
            get_hwid,
            get_os_version,
            get_os_name,
            get_device_model,
            hide_main_window_to_tray,
            autostart::launched_from_autostart,
            autostart::get_autostart_enabled,
            autostart::set_autostart_enabled,
            load_secure_session,
            save_secure_session,
            clear_secure_session,
            load_desktop_stats,
            save_desktop_stats,
            install_latest_linux_update,
            tcp_ping,
            resolve_host,
            prepare_ping_bypass,
            start_vpn,
            stop_vpn,
            get_vpn_state,
            get_traffic_stats,
            get_xray_version,
            diagnostics::get_diagnostic_state,
            diagnostics::set_diagnostic_mode,
            diagnostics::set_diagnostic_collection,
            diagnostics::append_diagnostic_event,
            diagnostics::list_diagnostic_logs,
            diagnostics::export_diagnostic_log,
            diagnostics::delete_diagnostic_log,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Only run on ExitRequested — fires once before shutdown while async
            // runtime is still alive. Avoids double-prompt for the pkexec password.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                diagnostics::record_native("App", "Application exit requested");
                if let Some(state) = app_handle.try_state::<AppVpn>() {
                    let manager = state.0.clone();
                    tauri::async_runtime::block_on(async move {
                        let guard = manager.lock().await;
                        if let Some(mgr) = guard.as_ref() {
                            if !matches!(mgr.get_state().await, VpnState::Disconnected) {
                                eprintln!("[EXIT] VPN was active — running cleanup");
                                let _ = mgr.stop().await;
                                eprintln!("[EXIT] Cleanup complete");
                            }
                        }
                    });
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::validate_desktop_stats_payload;

    #[test]
    fn desktop_stats_payload_requires_expected_shape() {
        assert!(validate_desktop_stats_payload(r#"{"buckets":[]}"#).is_ok());
        assert!(validate_desktop_stats_payload("[]").is_err());
        assert!(validate_desktop_stats_payload(r#"{"buckets":{}}"#).is_err());
        assert!(validate_desktop_stats_payload("not-json").is_err());
    }
}
