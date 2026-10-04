//! System notifications, as in the Android client (TrafficLimitNotifications,
//! PaymentNotifications). The UI decides when to notify; this command only
//! shows the toast, so the webview needs no notification permissions.

use crate::diagnostics;

/// Generous bounds: the texts come from the app's own translations.
const MAX_TITLE_CHARS: usize = 120;
const MAX_BODY_CHARS: usize = 400;

#[tauri::command]
pub fn show_system_notification(
    app: tauri::AppHandle,
    kind: String,
    title: String,
    body: String,
) -> Result<(), String> {
    let title: String = title.trim().chars().take(MAX_TITLE_CHARS).collect();
    let body: String = body.trim().chars().take(MAX_BODY_CHARS).collect();
    if title.is_empty() {
        return Err("Notification title is empty".into());
    }
    let kind: String = kind
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .take(32)
        .collect();

    show(&app, kind, title, body)
}

#[cfg(target_os = "linux")]
fn show(_app: &tauri::AppHandle, kind: String, title: String, body: String) -> Result<(), String> {
    // GNOME Shell destroys an app's notifications as soon as the D-Bus
    // connection that sent them goes away. notify-rust opens one connection
    // per notification and the notification plugin drops it at once, so the
    // toast was closed before it appeared. Keep the handles (which own the
    // connections) alive; notifications are rare, so a short list is enough.
    use std::sync::Mutex;
    static HANDLES: Mutex<Vec<notify_rust::NotificationHandle>> = Mutex::new(Vec::new());
    const KEEP_HANDLES: usize = 8;

    std::thread::spawn(move || {
        let mut notification = notify_rust::Notification::new();
        notification
            .appname("ToBeVPN")
            .summary(&title)
            .body(&body)
            // Ties the toast to the installed ToBeVPN.desktop entry (icon,
            // per-app notification settings).
            .hint(notify_rust::Hint::DesktopEntry("ToBeVPN".into()));
        // The icon as a file: GNOME did not resolve the "tobevpn-desktop"
        // theme name for the toast, and a dev build has no desktop entry.
        match notification_icon_path() {
            Some(path) => notification.icon(&path).image_path(&path),
            None => notification.icon("tobevpn-desktop"),
        };
        let result = notification.show();
        match result {
            Ok(handle) => {
                let mut handles = HANDLES.lock().unwrap_or_else(|poison| poison.into_inner());
                handles.push(handle);
                if handles.len() > KEEP_HANDLES {
                    handles.remove(0);
                }
                diagnostics::record_native(
                    "Notifications",
                    &format!("Notification shown: kind={kind}"),
                );
            }
            Err(error) => diagnostics::record_native(
                "Notifications",
                &format!("Notification failed: kind={kind}, error={error}"),
            ),
        }
    });
    Ok(())
}

/// The app icon written once to the cache directory, for notification servers
/// that take an image path.
#[cfg(target_os = "linux")]
fn notification_icon_path() -> Option<String> {
    const ICON: &[u8] = include_bytes!("../icons/128x128.png");
    let path = dirs::cache_dir()?
        .join("tobevpn")
        .join("notification-icon.png");
    let up_to_date = std::fs::read(&path).is_ok_and(|existing| existing == ICON);
    if !up_to_date {
        std::fs::create_dir_all(path.parent()?).ok()?;
        std::fs::write(&path, ICON).ok()?;
    }
    Some(path.to_string_lossy().into_owned())
}

#[cfg(not(target_os = "linux"))]
fn show(app: &tauri::AppHandle, kind: String, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|error| {
            diagnostics::record_native(
                "Notifications",
                &format!("Notification failed: kind={kind}, error={error}"),
            );
            format!("Could not show the notification: {error}")
        })?;
    diagnostics::record_native("Notifications", &format!("Notification shown: kind={kind}"));
    Ok(())
}
