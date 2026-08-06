use chrono::{Local, NaiveDate};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const LOG_DIRECTORY: &str = "diagnostic_logs";
const STATE_FILE: &str = "diagnostics-state.json";
const FILE_PREFIX: &str = "ToBeVPN-diagnostic-";
const FILE_SUFFIX: &str = ".log";
const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;
const MAX_HISTORY_FILES: usize = 7;
const MAX_MESSAGE_CHARS: usize = 600;

static JOURNAL: OnceLock<DiagnosticJournal> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticState {
    pub debug_mode_enabled: bool,
    pub collecting: bool,
    pub has_current_log: bool,
    pub current_log_size_bytes: u64,
    pub current_log_date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticLogFileInfo {
    pub file_name: String,
    pub date: String,
    pub size_bytes: u64,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredDiagnosticState {
    debug_mode_enabled: bool,
    collecting: bool,
}

struct DiagnosticJournal {
    inner: Mutex<JournalInner>,
}

struct JournalInner {
    app_data_dir: PathBuf,
    app_version: String,
    debug_mode_enabled: bool,
    collecting: bool,
    limit_marker_date: Option<NaiveDate>,
}

pub fn initialize(app_data_dir: PathBuf, app_version: String) -> Result<(), String> {
    if JOURNAL.get().is_some() {
        return Ok(());
    }

    fs::create_dir_all(app_data_dir.join(LOG_DIRECTORY))
        .map_err(|error| format!("Could not create the diagnostic directory: {error}"))?;
    let stored = read_stored_state(&app_data_dir);
    let journal = DiagnosticJournal {
        inner: Mutex::new(JournalInner {
            app_data_dir,
            app_version,
            debug_mode_enabled: stored.debug_mode_enabled,
            collecting: stored.debug_mode_enabled && stored.collecting,
            limit_marker_date: None,
        }),
    };
    let _ = JOURNAL.set(journal);

    with_inner(|inner| {
        prune_history(inner)?;
        if inner.collecting {
            append_locked(
                inner,
                "I",
                "DiagnosticLog",
                "Diagnostic collection resumed after application start",
            )?;
        }
        Ok(())
    })
}

pub fn record_native(tag: &str, message: &str) {
    let lowered = message.to_ascii_lowercase();
    // Core output may contain destinations visited through the tunnel. It is
    // deliberately never copied into the user-exportable journal.
    if lowered.starts_with("[xray]")
        || lowered.starts_with("[tun2socks]")
        || lowered.contains("xray binary:")
        || lowered.contains("tun2socks binary:")
        || lowered.contains("asset dir:")
        || message
            .chars()
            .all(|character| character.is_whitespace() || character == '═')
    {
        return;
    }
    let _ = record("D", tag, message);
}

fn journal() -> Result<&'static DiagnosticJournal, String> {
    JOURNAL
        .get()
        .ok_or_else(|| "Diagnostic journal is not initialized".to_string())
}

fn with_inner<T>(
    operation: impl FnOnce(&mut JournalInner) -> Result<T, String>,
) -> Result<T, String> {
    let journal = journal()?;
    let mut inner = journal
        .inner
        .lock()
        .map_err(|_| "Diagnostic journal lock is poisoned".to_string())?;
    operation(&mut inner)
}

fn today() -> NaiveDate {
    Local::now().date_naive()
}

fn file_name(date: NaiveDate) -> String {
    format!("{FILE_PREFIX}{date}{FILE_SUFFIX}")
}

fn date_from_file_name(name: &str) -> Option<NaiveDate> {
    if Path::new(name).file_name()?.to_str()? != name
        || !name.starts_with(FILE_PREFIX)
        || !name.ends_with(FILE_SUFFIX)
    {
        return None;
    }
    let encoded = &name[FILE_PREFIX.len()..name.len() - FILE_SUFFIX.len()];
    let date = NaiveDate::parse_from_str(encoded, "%Y-%m-%d").ok()?;
    (file_name(date) == name).then_some(date)
}

fn log_directory(inner: &JournalInner) -> PathBuf {
    inner.app_data_dir.join(LOG_DIRECTORY)
}

fn current_log_path(inner: &JournalInner) -> PathBuf {
    log_directory(inner).join(file_name(today()))
}

fn state_path(inner: &JournalInner) -> PathBuf {
    inner.app_data_dir.join(STATE_FILE)
}

fn read_stored_state(app_data_dir: &Path) -> StoredDiagnosticState {
    fs::read_to_string(app_data_dir.join(STATE_FILE))
        .ok()
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default()
}

fn persist_state(inner: &JournalInner) -> Result<(), String> {
    let value = serde_json::to_vec(&StoredDiagnosticState {
        debug_mode_enabled: inner.debug_mode_enabled,
        collecting: inner.debug_mode_enabled && inner.collecting,
    })
    .map_err(|error| format!("Could not encode diagnostic settings: {error}"))?;
    fs::write(state_path(inner), value)
        .map_err(|error| format!("Could not save diagnostic settings: {error}"))
}

fn current_state(inner: &JournalInner) -> DiagnosticState {
    let path = current_log_path(inner);
    let size = fs::metadata(&path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    DiagnosticState {
        debug_mode_enabled: inner.debug_mode_enabled,
        collecting: inner.debug_mode_enabled && inner.collecting,
        has_current_log: size > 0,
        current_log_size_bytes: size,
        current_log_date: (size > 0).then(|| today().to_string()),
    }
}

fn sanitizers() -> &'static Vec<(Regex, &'static str)> {
    static SANITIZERS: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    SANITIZERS.get_or_init(|| {
        vec![
            (
                Regex::new(r"(?i)\b(?:https?|vless|vmess|trojan|ss|socks5?|tobevpn)://\S+")
                    .expect("valid URL diagnostic regex"),
                "<redacted-url>",
            ),
            (
                Regex::new(r"(?i)\b(?:authorization|bearer|access[_ -]?token|refresh[_ -]?token)\s*[:=]?\s*[A-Za-z0-9._~+/=-]{8,}")
                    .expect("valid credential diagnostic regex"),
                "<redacted-credential>",
            ),
            (
                Regex::new(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
                    .expect("valid email diagnostic regex"),
                "<redacted-email>",
            ),
            (
                Regex::new(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b")
                    .expect("valid UUID diagnostic regex"),
                "<redacted-uuid>",
            ),
            (
                Regex::new(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
                    .expect("valid IPv4 diagnostic regex"),
                "<redacted-ip>",
            ),
            (
                Regex::new(r"(?i)(?:[0-9a-f]{0,4}:){2,}[0-9a-f]{0,4}")
                    .expect("valid IPv6 diagnostic regex"),
                "<redacted-ip>",
            ),
            (
                Regex::new(r"\b\d{7,}\b").expect("valid numeric ID diagnostic regex"),
                "<redacted-id>",
            ),
            (
                Regex::new(r"\b[A-Za-z0-9_-]{32,}\b")
                    .expect("valid opaque secret diagnostic regex"),
                "<redacted-secret>",
            ),
        ]
    })
}

fn sanitize_tag(tag: &str) -> String {
    let sanitized = tag
        .trim()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | '-') {
                character
            } else {
                '_'
            }
        })
        .take(48)
        .collect::<String>();
    if sanitized.is_empty() {
        "App".to_string()
    } else {
        sanitized
    }
}

fn sanitize_message(message: &str) -> String {
    // Bound work before running regular expressions so even an accidental
    // oversized frontend error cannot stall the VPN task that records it.
    let bounded = message.chars().take(4096).collect::<String>();
    let mut sanitized = bounded.replace(['\r', '\n', '\t'], " ").trim().to_string();
    for (pattern, replacement) in sanitizers() {
        sanitized = pattern.replace_all(&sanitized, *replacement).into_owned();
    }
    let sanitized = sanitized
        .chars()
        .take(MAX_MESSAGE_CHARS)
        .collect::<String>()
        .trim()
        .to_string();
    if sanitized.is_empty() {
        "<empty>".to_string()
    } else {
        sanitized
    }
}

fn ensure_header(inner: &JournalInner, path: &Path) -> Result<(), String> {
    if fs::metadata(path)
        .map(|metadata| metadata.len() > 0)
        .unwrap_or(false)
    {
        return Ok(());
    }
    fs::create_dir_all(log_directory(inner))
        .map_err(|error| format!("Could not create the diagnostic directory: {error}"))?;
    let os = os_info::get();
    let locale = std::env::var("LANG").unwrap_or_else(|_| "unknown".to_string());
    let header = format!(
        "# ToBeVPN diagnostic journal\n# Date: {}\n# App: {}\n# OS: {} {} ({})\n# Locale: {}\n# Contains application events only; traffic content is not recorded.\n\n",
        today(),
        inner.app_version,
        os.os_type(),
        os.version(),
        std::env::consts::ARCH,
        sanitize_message(&locale),
    );
    fs::write(path, header).map_err(|error| format!("Could not create the diagnostic log: {error}"))
}

fn append_locked(
    inner: &mut JournalInner,
    level: &str,
    tag: &str,
    message: &str,
) -> Result<(), String> {
    prune_history(inner)?;
    let path = current_log_path(inner);
    ensure_header(inner, &path)?;
    let line = format!(
        "{} {}/{}: {}\n",
        Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
        match level {
            "E" => "E",
            "W" => "W",
            "D" => "D",
            _ => "I",
        },
        sanitize_tag(tag),
        sanitize_message(message),
    );
    let current_size = fs::metadata(&path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if current_size.saturating_add(line.len() as u64) <= MAX_LOG_BYTES {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|error| format!("Could not open the diagnostic log: {error}"))?;
        file.write_all(line.as_bytes())
            .map_err(|error| format!("Could not append the diagnostic log: {error}"))?;
    } else if inner.limit_marker_date != Some(today()) {
        let marker = b"# Daily journal size limit reached; further events were omitted.\n";
        if current_size.saturating_add(marker.len() as u64) <= MAX_LOG_BYTES {
            let mut file = OpenOptions::new()
                .append(true)
                .open(&path)
                .map_err(|error| format!("Could not open the diagnostic log: {error}"))?;
            file.write_all(marker).map_err(|error| {
                format!("Could not append the diagnostic limit marker: {error}")
            })?;
        }
        inner.limit_marker_date = Some(today());
    }
    Ok(())
}

fn history_locked(inner: &JournalInner) -> Result<Vec<DiagnosticLogFileInfo>, String> {
    let mut logs = fs::read_dir(log_directory(inner))
        .map_err(|error| format!("Could not read diagnostic history: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            if !entry.file_type().ok()?.is_file() {
                return None;
            }
            let name = entry.file_name().into_string().ok()?;
            let date = date_from_file_name(&name)?;
            let size = entry.metadata().ok()?.len();
            (size > 0).then_some((date, name, size))
        })
        .collect::<Vec<_>>();
    logs.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
    Ok(logs
        .into_iter()
        .map(|(date, file_name, size_bytes)| DiagnosticLogFileInfo {
            file_name,
            date: date.to_string(),
            size_bytes,
        })
        .collect())
}

fn prune_history(inner: &JournalInner) -> Result<(), String> {
    let directory = log_directory(inner);
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the diagnostic directory: {error}"))?;
    let mut files = fs::read_dir(&directory)
        .map_err(|error| format!("Could not read diagnostic history: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let date = date_from_file_name(&name)?;
            Some((date, name, entry.path()))
        })
        .collect::<Vec<_>>();
    files.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
    for (_, _, path) in files.into_iter().skip(MAX_HISTORY_FILES) {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

fn resolve_log(inner: &JournalInner, requested: Option<&str>) -> Result<PathBuf, String> {
    let name = requested
        .map(str::to_string)
        .unwrap_or_else(|| file_name(today()));
    if date_from_file_name(&name).is_none() {
        return Err("Invalid diagnostic log name".to_string());
    }
    let path = log_directory(inner).join(name);
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| "Diagnostic log does not exist".to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("Diagnostic log cannot be a symbolic link".to_string());
    }
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("Diagnostic log is empty".to_string());
    }
    Ok(path)
}

fn record(level: &str, tag: &str, message: &str) -> Result<(), String> {
    with_inner(|inner| {
        if !inner.debug_mode_enabled || !inner.collecting {
            return Ok(());
        }
        append_locked(inner, level, tag, message)
    })
}

#[tauri::command]
pub fn get_diagnostic_state() -> Result<DiagnosticState, String> {
    with_inner(|inner| {
        prune_history(inner)?;
        Ok(current_state(inner))
    })
}

#[tauri::command]
pub fn set_diagnostic_mode(enabled: bool) -> Result<DiagnosticState, String> {
    with_inner(|inner| {
        if inner.debug_mode_enabled == enabled {
            return Ok(current_state(inner));
        }
        if !enabled && inner.collecting {
            let _ = append_locked(
                inner,
                "I",
                "DiagnosticLog",
                "Diagnostic collection stopped because debug mode was disabled",
            );
            inner.collecting = false;
        }
        inner.debug_mode_enabled = enabled;
        persist_state(inner)?;
        Ok(current_state(inner))
    })
}

#[tauri::command]
pub fn set_diagnostic_collection(enabled: bool) -> Result<DiagnosticState, String> {
    with_inner(|inner| {
        if enabled {
            if !inner.debug_mode_enabled {
                return Err("Diagnostic mode is disabled".to_string());
            }
            if !inner.collecting {
                inner.collecting = true;
                if let Err(error) = persist_state(inner) {
                    inner.collecting = false;
                    return Err(error);
                }
                append_locked(
                    inner,
                    "I",
                    "DiagnosticLog",
                    "Diagnostic collection started manually",
                )?;
            }
        } else if inner.collecting {
            let _ = append_locked(
                inner,
                "I",
                "DiagnosticLog",
                "Diagnostic collection stopped manually",
            );
            inner.collecting = false;
            persist_state(inner)?;
        }
        Ok(current_state(inner))
    })
}

#[tauri::command]
pub fn append_diagnostic_event(level: String, tag: String, message: String) -> Result<(), String> {
    record(&level, &tag, &message)
}

#[tauri::command]
pub fn list_diagnostic_logs() -> Result<Vec<DiagnosticLogFileInfo>, String> {
    with_inner(|inner| {
        prune_history(inner)?;
        history_locked(inner)
    })
}

#[tauri::command]
pub fn export_diagnostic_log(file_name: Option<String>) -> Result<String, String> {
    with_inner(|inner| {
        let source = resolve_log(inner, file_name.as_deref())?;
        let downloads = dirs::download_dir()
            .or_else(dirs::document_dir)
            .ok_or_else(|| "Could not resolve the Downloads directory".to_string())?;
        fs::create_dir_all(&downloads)
            .map_err(|error| format!("Could not create the export directory: {error}"))?;
        let original_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Diagnostic log has an invalid file name".to_string())?;
        let stem = original_name.trim_end_matches(FILE_SUFFIX);
        let mut destination = downloads.join(original_name);
        for suffix in 1..=999 {
            if !destination.exists() {
                break;
            }
            destination = downloads.join(format!("{stem}-{suffix}{FILE_SUFFIX}"));
        }
        if destination.exists() {
            return Err("Too many diagnostic log exports already exist".to_string());
        }
        fs::copy(&source, &destination)
            .map_err(|error| format!("Could not export the diagnostic log: {error}"))?;
        Ok(destination.to_string_lossy().into_owned())
    })
}

#[tauri::command]
pub fn delete_diagnostic_log(file_name: String) -> Result<DiagnosticState, String> {
    with_inner(|inner| {
        let path = resolve_log(inner, Some(&file_name))?;
        fs::remove_file(&path)
            .map_err(|error| format!("Could not delete the diagnostic log: {error}"))?;
        if file_name == self::file_name(today()) {
            inner.limit_marker_date = None;
        }
        Ok(current_state(inner))
    })
}

#[cfg(test)]
mod tests {
    use super::{
        append_locked, date_from_file_name, file_name, history_locked, log_directory,
        prune_history, sanitize_message, JournalInner,
    };
    use chrono::NaiveDate;
    use std::fs;

    #[test]
    fn accepts_only_our_daily_log_names() {
        let date = NaiveDate::from_ymd_opt(2026, 8, 5).unwrap();
        assert_eq!(file_name(date), "ToBeVPN-diagnostic-2026-08-05.log");
        assert_eq!(date_from_file_name(&file_name(date)), Some(date));
        assert_eq!(
            date_from_file_name("../ToBeVPN-diagnostic-2026-08-05.log"),
            None
        );
    }

    #[test]
    fn redacts_private_network_and_identity_values() {
        let value = sanitize_message(
            "https://example.com/a user@example.com 123456789 1.2.3.4 123e4567-e89b-12d3-a456-426614174000",
        );
        assert!(!value.contains("example.com"));
        assert!(!value.contains("123456789"));
        assert!(!value.contains("1.2.3.4"));
        assert!(!value.contains("123e4567"));
    }

    #[test]
    fn daily_journal_writes_a_sanitized_header_and_event() {
        let directory = tempfile::tempdir().unwrap();
        let mut inner = JournalInner {
            app_data_dir: directory.path().to_path_buf(),
            app_version: "test".to_string(),
            debug_mode_enabled: true,
            collecting: true,
            limit_marker_date: None,
        };
        append_locked(
            &mut inner,
            "E",
            "VPN Test",
            "failed at 1.2.3.4 for 123e4567-e89b-12d3-a456-426614174000",
        )
        .unwrap();

        let contents =
            fs::read_to_string(log_directory(&inner).join(file_name(super::today()))).unwrap();
        assert!(contents.contains("# ToBeVPN diagnostic journal"));
        assert!(contents.contains("E/VPN_Test"));
        assert!(contents.contains("<redacted-ip>"));
        assert!(contents.contains("<redacted-uuid>"));
        assert!(!contents.contains("1.2.3.4"));
    }

    #[test]
    fn retention_keeps_only_the_seven_newest_daily_logs() {
        let directory = tempfile::tempdir().unwrap();
        let inner = JournalInner {
            app_data_dir: directory.path().to_path_buf(),
            app_version: "test".to_string(),
            debug_mode_enabled: false,
            collecting: false,
            limit_marker_date: None,
        };
        fs::create_dir_all(log_directory(&inner)).unwrap();
        for day in 1..=9 {
            let date = NaiveDate::from_ymd_opt(2026, 7, day).unwrap();
            fs::write(log_directory(&inner).join(file_name(date)), "event\n").unwrap();
        }

        prune_history(&inner).unwrap();
        let history = history_locked(&inner).unwrap();
        assert_eq!(history.len(), 7);
        assert_eq!(history.first().unwrap().date, "2026-07-09");
        assert_eq!(history.last().unwrap().date, "2026-07-03");
    }
}
