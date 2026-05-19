#[cfg(target_os = "linux")]
pub mod linux_update;
mod vpn;

use keyring::{Entry, Error as KeyringError};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout, Duration};

use vpn::config::ServerConfig;
use vpn::manager::VpnManager;
use vpn::state::{TrafficStats, VpnState};

/// Shared VPN manager state.
struct AppVpn(Arc<Mutex<Option<VpnManager>>>);

/// Serializes start/stop pipelines so a user mashing the Connect button
/// can't fire three concurrent xray spawns. Held for the duration of one
/// command — the manager's own state lock is too granular for this (it
/// covers state-field writes only, not the full pipeline).
struct VpnPipelineLock(Arc<Mutex<()>>);

const SECURE_SESSION_SERVICE: &str = "network.tobevpn.desktop";
const SECURE_SESSION_ACCOUNT: &str = "device-session-v1";

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        eprintln!(
            "[TRAY] show_main_window: visible={:?} minimized={:?}",
            window.is_visible(),
            window.is_minimized()
        );
        restore_window_chrome(&window);
        #[cfg(target_os = "linux")]
        let _ = window.set_skip_taskbar(false);
        let _ = window.show();
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        restore_window_chrome(&window);
        let _ = window.set_focus();
        refresh_window_chrome_after_show(window);
    }
}

fn restore_window_chrome(window: &tauri::WebviewWindow) {
    let _ = window.set_enabled(true);
    let _ = window.set_focusable(true);
    let _ = window.set_decorations(true);
    let _ = window.set_minimizable(true);
    let _ = window.set_closable(true);
    let _ = window.set_maximizable(false);
}

fn send_window_to_background(window: tauri::WebviewWindow) {
    restore_window_chrome(&window);
    #[cfg(target_os = "linux")]
    let _ = window.set_skip_taskbar(true);

    match window.hide() {
        Ok(_) => {
            eprintln!("[TRAY] window hidden");
            #[cfg(target_os = "linux")]
            let _ = window.set_decorations(false);
        }
        Err(e) => eprintln!("[TRAY] hide failed: {e:?}"),
    }
}

fn refresh_window_chrome_after_show(window: tauri::WebviewWindow) {
    #[cfg(target_os = "linux")]
    tauri::async_runtime::spawn(async move {
        // WebKitGTK/GTK can restore the window before the window manager has
        // fully reattached native decorations. A short deferred pass keeps
        // the titlebar buttons sensitive after hide-to-tray -> show.
        sleep(Duration::from_millis(120)).await;
        restore_window_chrome(&window);
        let _ = window.set_skip_taskbar(false);
        let _ = window.set_focus();
    });

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

fn secure_session_entry() -> Result<Entry, String> {
    Entry::new(SECURE_SESSION_SERVICE, SECURE_SESSION_ACCOUNT)
        .map_err(|e| format!("Could not open secure session storage: {e}"))
}

#[tauri::command]
fn load_secure_session() -> Result<Option<String>, String> {
    let entry = secure_session_entry()?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(format!("Could not load secure session: {e}")),
    }
}

#[tauri::command]
fn save_secure_session(value: String) -> Result<(), String> {
    let entry = secure_session_entry()?;
    entry
        .set_password(&value)
        .map_err(|e| format!("Could not save secure session: {e}"))
}

#[tauri::command]
fn clear_secure_session() -> Result<(), String> {
    let entry = secure_session_entry()?;
    match entry.delete_credential() {
        Ok(_) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not clear secure session: {e}")),
    }
}

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

/// Start the VPN connection with the given server config.
#[tauri::command]
async fn start_vpn(
    server: ServerConfig,
    state: tauri::State<'_, AppVpn>,
    pipeline: tauri::State<'_, VpnPipelineLock>,
) -> Result<(), String> {
    // Serialize the entire connect pipeline. Without this a user mashing the
    // "Connect" button (or live-switch + manual reconnect) can fire several
    // start() invocations in parallel, racing xray spawns and leaving zombie
    // processes that the second start can't detect via `prev_state`.
    let _gate = pipeline.0.lock().await;
    let guard = state.0.lock().await;
    match guard.as_ref() {
        Some(mgr) => mgr.start(server).await,
        None => Err("VPN manager not initialized".into()),
    }
}

/// Stop the VPN connection.
#[tauri::command]
async fn stop_vpn(
    state: tauri::State<'_, AppVpn>,
    pipeline: tauri::State<'_, VpnPipelineLock>,
) -> Result<(), String> {
    let _gate = pipeline.0.lock().await;
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
    let mut builder = tauri::Builder::default();

    // Single-instance must be the FIRST plugin registered. When a second copy
    // of the .exe is launched (e.g. user double-clicks the shortcut while the
    // app is hidden in the tray), this callback fires in the first instance
    // and the second one exits — preventing the duplicate-process bug.
    #[cfg(any(target_os = "windows", target_os = "linux", target_os = "macos"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Resolve sidecar binary directory.
            // In dev mode, Tauri copies externalBin to target/debug/ (next to the executable).
            // In production, they're in the resource dir.
            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()))
                .unwrap_or_default();

            let xray_in_exe_dir = exe_dir.join("xray").exists()
                || exe_dir.join("xray.exe").exists()
                || exe_dir.join("xray-x86_64-unknown-linux-gnu").exists()
                || exe_dir.join("xray-x86_64-pc-windows-msvc.exe").exists();
            let bin_dir = if xray_in_exe_dir {
                exe_dir
            } else {
                app.path()
                    .resource_dir()
                    .map(|d| d.join("bin"))
                    .unwrap_or(exe_dir)
            };

            eprintln!("VPN bin dir: {:?}", bin_dir);

            let mut manager = VpnManager::new(bin_dir);
            manager.set_app_handle(app.handle().clone());
            let shared = Arc::new(Mutex::new(Some(manager)));
            app.manage(AppVpn(shared.clone()));
            app.manage(VpnPipelineLock(Arc::new(Mutex::new(()))));

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
            let _tray = TrayIconBuilder::with_id("main")
                .icon(icon)
                .tooltip("ToBeVPN")
                .menu(&menu)
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
                })
                .build(app)?;

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
                let quit_for_window = quit_flag.clone();
                let window_for_handler = main_window.clone();
                main_window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
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
                });
            }

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
            load_secure_session,
            save_secure_session,
            clear_secure_session,
            install_latest_linux_update,
            tcp_ping,
            resolve_host,
            start_vpn,
            stop_vpn,
            get_vpn_state,
            get_traffic_stats,
            get_xray_version,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Only run on ExitRequested — fires once before shutdown while async
            // runtime is still alive. Avoids double-prompt for the pkexec password.
            if let tauri::RunEvent::ExitRequested { .. } = event {
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
