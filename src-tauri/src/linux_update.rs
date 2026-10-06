use crate::update_download;
use serde::Deserialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Command as StdCommand, Stdio};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::time::{timeout, Duration};

const UPDATE_HELPER: &str = "/usr/local/bin/tobevpn-update-helper.sh";
const UPDATE_ENDPOINT: &str =
    "https://github.com/Shoolife/ToBeVPN-Desktop/releases/latest/download/latest.json";
const UPDATE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_PACKAGE_BYTES: usize = 256 * 1024 * 1024;
const PACKAGE_NAMES: &[&str] = &["to-be-vpn", "tobevpn-desktop"];

/// Lines the root helper prints on stdout so the app can show how much of
/// the package is downloaded. pkexec passes stdout through unchanged.
const PROGRESS_PREFIX: &str = "TOBEVPN-UPDATE ";
const PROGRESS_EVENT: &str = "update-download-progress";

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    phase: &'static str,
    downloaded: u64,
    total: u64,
}

/// "TOBEVPN-UPDATE download <downloaded> <total>" or "TOBEVPN-UPDATE install".
fn parse_progress_line(line: &str) -> Option<UpdateProgress> {
    let mut parts = line.strip_prefix(PROGRESS_PREFIX)?.split_whitespace();
    match parts.next()? {
        "download" => Some(UpdateProgress {
            phase: "downloading",
            downloaded: parts.next()?.parse().ok()?,
            total: parts.next()?.parse().ok()?,
        }),
        "install" => Some(UpdateProgress {
            phase: "installing",
            downloaded: 0,
            total: 0,
        }),
        _ => None,
    }
}

fn report_progress(line: std::fmt::Arguments) {
    // Rust's stdout is line buffered, so each report leaves at once. A closed
    // pipe (the app quit) must not stop the update, unlike println!.
    let _ = writeln!(std::io::stdout(), "{PROGRESS_PREFIX}{line}");
}

#[derive(Debug, Deserialize)]
struct UpdateManifest {
    version: String,
    platforms: Option<HashMap<String, UpdatePlatform>>,
    url: Option<String>,
    signature: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UpdatePlatform {
    url: String,
    signature: String,
}

pub fn maybe_run_update_helper() -> bool {
    let mut args = std::env::args().skip(1);
    let Some(first) = args.next() else {
        return false;
    };
    if first != "--tobevpn-install-latest" {
        return false;
    }

    let version = args.next().unwrap_or_default();
    if args.next().is_some() {
        eprintln!("ERROR: too many arguments");
        std::process::exit(2);
    }

    match install_latest_signed_update(&version) {
        Ok(()) => std::process::exit(0),
        Err(e) => {
            eprintln!("ERROR: {e}");
            std::process::exit(1);
        }
    }
}

pub async fn install_latest_via_polkit(app: AppHandle, version: String) -> Result<(), String> {
    validate_version(&version)?;

    let mut cmd = Command::new("pkexec");
    cmd.arg(UPDATE_HELPER)
        .arg("install-latest")
        .arg(&version)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for var in &[
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "DBUS_SESSION_BUS_ADDRESS",
        "XDG_RUNTIME_DIR",
    ] {
        if let Ok(val) = std::env::var(var) {
            cmd.env(var, val);
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start update helper: {e}"))?;
    // Progress lines become events; anything else is kept for the error text.
    let stdout = child.stdout.take();
    let reader = tokio::spawn(async move {
        let mut other = Vec::new();
        let Some(stdout) = stdout else {
            return other;
        };
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            match parse_progress_line(&line) {
                Some(progress) => {
                    let _ = app.emit(PROGRESS_EVENT, progress);
                }
                None if other.len() < 64 => other.push(line),
                None => {}
            }
        }
        other
    });

    let output = timeout(UPDATE_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "Update helper timed out".to_string())?
        .map_err(|e| format!("Could not run update helper: {e}"))?;
    let stdout = reader.await.unwrap_or_default().join("\n");

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = stdout.trim().to_string();
    let detail = if stderr.is_empty() { stdout } else { stderr };
    Err(if detail.is_empty() {
        format!("Update helper failed: {}", output.status)
    } else {
        detail
    })
}

fn install_latest_signed_update(expected_version: &str) -> Result<(), String> {
    validate_root()?;
    validate_version(expected_version)?;

    let client = update_download::http_client()?;

    let manifest_response = client
        .get(UPDATE_ENDPOINT)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("fetch update manifest: {e}"))?;
    let manifest_bytes =
        read_limited_response(manifest_response, MAX_MANIFEST_BYTES, "update manifest")?;
    let manifest: UpdateManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("parse update manifest: {e}"))?;

    if normalize_version(&manifest.version) != normalize_version(expected_version) {
        return Err(format!(
            "latest version changed from {} to {}",
            expected_version, manifest.version
        ));
    }

    let platform = select_platform(&manifest)?;
    validate_package_url(&platform.url, expected_version)?;
    let bytes = update_download::download(
        &client,
        &platform.url,
        MAX_PACKAGE_BYTES as u64,
        |downloaded, total| report_progress(format_args!("download {downloaded} {total}")),
    )?;
    report_progress(format_args!("install"));

    update_download::verify_signature(&bytes, &platform.signature)?;
    if !infer::archive::is_deb(&bytes) {
        return Err("downloaded update is not a deb package".into());
    }

    let tmp_dir = tempfile::Builder::new()
        .prefix("tobevpn_deb_update")
        .tempdir()
        .map_err(|e| format!("create update temp dir: {e}"))?;
    let deb_path = tmp_dir.path().join("package.deb");
    std::fs::File::create(&deb_path)
        .and_then(|mut f| {
            f.write_all(&bytes)?;
            f.sync_all()
        })
        .map_err(|e| format!("write update package: {e}"))?;

    validate_deb_package(&deb_path, expected_version)?;
    let output = StdCommand::new("/usr/bin/dpkg")
        .arg("-i")
        .arg(&deb_path)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("run dpkg: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("dpkg failed: {}", output.status)
        } else {
            stderr
        })
    }
}

fn read_limited_response(
    response: reqwest::blocking::Response,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(format!("{label} exceeds the {max_bytes}-byte limit"));
    }

    let mut bytes = Vec::new();
    response
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read {label}: {e}"))?;
    if bytes.len() > max_bytes {
        return Err(format!("{label} exceeds the {max_bytes}-byte limit"));
    }
    Ok(bytes)
}

fn validate_package_url(value: &str, expected_version: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(value).map_err(|_| "invalid update package URL".to_string())?;
    let expected_prefix = format!(
        "/Shoolife/ToBeVPN-Desktop/releases/download/v{}/",
        normalize_version(expected_version)
    );
    let file_name = url
        .path()
        .strip_prefix(&expected_prefix)
        .unwrap_or_default();
    let valid_file_name = !file_name.is_empty()
        && !file_name.contains("..")
        && file_name.ends_with(".deb")
        && file_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'));

    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !valid_file_name
    {
        return Err("update package URL is outside the trusted release path".into());
    }
    Ok(())
}

fn select_platform(manifest: &UpdateManifest) -> Result<UpdatePlatform, String> {
    if let Some(platforms) = &manifest.platforms {
        let arch = std::env::consts::ARCH;
        let deb_target = format!("linux-{arch}-deb");
        let plain_target = format!("linux-{arch}");
        for target in [&deb_target, &plain_target] {
            if let Some(platform) = platforms.get(target.as_str()) {
                return Ok(UpdatePlatform {
                    url: platform.url.clone(),
                    signature: platform.signature.clone(),
                });
            }
        }
        return Err(format!("no Linux deb update for architecture {arch}"));
    }

    match (&manifest.url, &manifest.signature) {
        (Some(url), Some(signature)) => Ok(UpdatePlatform {
            url: url.clone(),
            signature: signature.clone(),
        }),
        _ => Err("update manifest does not contain a package URL/signature".into()),
    }
}

fn validate_deb_package(path: &std::path::Path, expected_version: &str) -> Result<(), String> {
    let package = read_deb_field(path, "Package")?;
    if !PACKAGE_NAMES.iter().any(|name| *name == package) {
        return Err(format!("unexpected deb package name: {package}"));
    }

    let version = read_deb_field(path, "Version")?;
    if normalize_version(&version) != normalize_version(expected_version) {
        return Err(format!(
            "deb version mismatch: expected {expected_version}, got {version}"
        ));
    }
    Ok(())
}

fn read_deb_field(path: &std::path::Path, field: &str) -> Result<String, String> {
    let output = StdCommand::new("/usr/bin/dpkg-deb")
        .arg("-f")
        .arg(path)
        .arg(field)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("run dpkg-deb: {e}"))?;
    if !output.status.success() {
        return Err(format!("dpkg-deb failed while reading {field}"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn validate_root() -> Result<(), String> {
    if unsafe { libc::geteuid() } == 0 {
        Ok(())
    } else {
        Err("update helper must run as root".into())
    }
}

fn validate_version(version: &str) -> Result<(), String> {
    if version.is_empty() || version.len() > 64 {
        return Err("invalid update version".into());
    }
    if version
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-' | b'v'))
    {
        Ok(())
    } else {
        Err("invalid update version".into())
    }
}

fn normalize_version(version: &str) -> &str {
    version.trim().trim_start_matches('v')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_url_is_restricted_to_the_expected_release() {
        assert!(validate_package_url(
            "https://github.com/Shoolife/ToBeVPN-Desktop/releases/download/v1.2.3/ToBeVPN_1.2.3_amd64.deb",
            "1.2.3",
        )
        .is_ok());
        assert!(validate_package_url(
            "https://example.com/Shoolife/ToBeVPN-Desktop/releases/download/v1.2.3/app.deb",
            "1.2.3",
        )
        .is_err());
        assert!(validate_package_url(
            "https://github.com/Shoolife/ToBeVPN-Desktop/releases/download/v9.9.9/app.deb",
            "1.2.3",
        )
        .is_err());
        assert!(validate_package_url(
            "https://github.com/Shoolife/ToBeVPN-Desktop/releases/download/v1.2.3/subdir/app.deb",
            "1.2.3",
        )
        .is_err());
        assert!(validate_package_url(
            "https://github.com/Shoolife/ToBeVPN-Desktop/releases/download/v1.2.3/app.deb?raw=1",
            "1.2.3",
        )
        .is_err());
    }

    #[test]
    fn progress_lines_are_parsed_and_other_output_is_not() {
        assert_eq!(
            parse_progress_line("TOBEVPN-UPDATE download 1048576 53187632"),
            Some(UpdateProgress {
                phase: "downloading",
                downloaded: 1_048_576,
                total: 53_187_632
            })
        );
        assert_eq!(
            parse_progress_line("TOBEVPN-UPDATE install").map(|p| p.phase),
            Some("installing")
        );
        assert_eq!(parse_progress_line("TOBEVPN-UPDATE download x 1"), None);
        assert_eq!(
            parse_progress_line("Selecting previously unselected package"),
            None
        );
    }

    #[test]
    fn update_version_rejects_shell_and_path_characters() {
        assert!(validate_version("v1.2.3").is_ok());
        assert!(validate_version("1.2.3;id").is_err());
        assert!(validate_version("../../package").is_err());
    }
}
