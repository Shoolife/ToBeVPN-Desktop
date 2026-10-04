//! "Export and import" settings file, as in the Android client. The UI builds
//! the JSON document; this command only writes it to Downloads, the same place
//! diagnostic logs are exported to. Import reads the file in the webview.

use std::fs;

/// Same limit as the phone's SettingsBackupCodec.
const MAX_FILE_BYTES: usize = 256 * 1024;
const FORMAT: &str = "tobevpn-settings";

#[tauri::command]
pub async fn export_settings_file(contents: String, file_name: String) -> Result<String, String> {
    if contents.len() > MAX_FILE_BYTES {
        return Err("Settings file is too large".into());
    }
    let document: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|_| "Settings file is not valid JSON".to_string())?;
    if document.get("format").and_then(|v| v.as_str()) != Some(FORMAT) {
        return Err("Not a ToBeVPN settings file".into());
    }
    let stem = sanitize_stem(&file_name);

    tauri::async_runtime::spawn_blocking(move || {
        let downloads = dirs::download_dir()
            .or_else(dirs::document_dir)
            .ok_or_else(|| "Could not resolve the Downloads directory".to_string())?;
        fs::create_dir_all(&downloads)
            .map_err(|error| format!("Could not create the export directory: {error}"))?;
        let mut destination = downloads.join(format!("{stem}.json"));
        for suffix in 1..=999 {
            if !destination.exists() {
                break;
            }
            destination = downloads.join(format!("{stem}-{suffix}.json"));
        }
        if destination.exists() {
            return Err("Too many settings exports already exist".to_string());
        }
        fs::write(&destination, contents)
            .map_err(|error| format!("Could not write the settings file: {error}"))?;
        Ok(destination.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("Settings export task failed: {error}"))?
}

/// Keeps only a safe file stem; the UI proposes "ToBeVPN-settings-YYYY-MM-DD".
fn sanitize_stem(value: &str) -> String {
    let stem: String = value
        .trim_end_matches(".json")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(80)
        .collect();
    if stem.is_empty() {
        "ToBeVPN-settings".into()
    } else {
        stem
    }
}

#[cfg(test)]
mod tests {
    use super::sanitize_stem;

    #[test]
    fn file_name_cannot_escape_downloads() {
        assert_eq!(
            sanitize_stem("ToBeVPN-settings-2026-10-03.json"),
            "ToBeVPN-settings-2026-10-03"
        );
        assert_eq!(sanitize_stem("../../etc/passwd"), "etcpasswd");
        assert_eq!(sanitize_stem("..\\..\\x"), "x");
        assert_eq!(sanitize_stem(""), "ToBeVPN-settings");
    }
}
