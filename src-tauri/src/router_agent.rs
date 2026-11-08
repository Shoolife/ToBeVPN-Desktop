//! Installs and drives ToBeVPN on the home router over SSH.
//!
//! Pairing logs in once with the router password, which is never stored,
//! and adds this app's own SSH key; later calls use that key. The router's
//! host key is remembered on first pairing and checked on every connection.
//! On the router, resources/router/tobevpn-router.sh does the work: Xray and
//! hev-socks5-tunnel, home devices sent into the tunnel by source address.
//! Its runtime changes are undone by "stop" or a reboot.

use crate::vpn::config::{build_proxy_outbound, ServerConfig};
use flate2::read::DeflateDecoder;
use russh::client;
use russh::keys::{Algorithm, HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::ChannelMsg;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const AGENT_SCRIPT: &str = include_str!("../resources/router/tobevpn-router.sh");
const INIT_SCRIPT: &str = "#!/bin/sh /etc/rc.common\n\
# ToBeVPN on the router, installed by the ToBeVPN desktop app.\n\
START=99\nSTOP=10\n\
start() { /opt/tobevpn/tobevpn-router.sh start >/dev/null 2>&1; }\n\
stop() { /opt/tobevpn/tobevpn-router.sh stop >/dev/null 2>&1; }\n";
/// Xray SOCKS port of slot 0; slot N listens on SOCKS_PORT + N.
const SOCKS_PORT: u16 = 10808;
/// Server slots 0-7, one tunnel each; how many are used is decided by the
/// app from the router's free memory.
const MAX_SLOT: u8 = 7;
/// Re-applies per-device routes when a home device gets an address.
const DHCP_HOOK: &str = "#!/bin/sh\n\
# ToBeVPN: per-device routes follow a device's new address.\n\
[ -f /tmp/tobevpn/watch.pid ] && /opt/tobevpn/tobevpn-router.sh apply >/dev/null 2>&1\n";
/// Marks our key in the router's authorized_keys, so uninstall removes it.
const KEY_COMMENT: &str = "tobevpn-desktop-router";
const SSH_TIMEOUT: Duration = Duration::from_secs(10);
/// Space the two binaries need on the router's flash, with margin.
const REQUIRED_FREE_KB: u64 = 40 * 1024;
const PRIVATE_RANGES: &[&str] = &[
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "100.64.0.0/10",
];

/// A release asset for the router (aarch64), verified by SHA-256.
#[derive(Clone, Debug)]
struct Binary {
    name: &'static str,
    url: String,
    /// Digest of the downloaded file (the zip for Xray).
    download_sha256: String,
    /// Member to extract from a zip download; None for a plain binary.
    zip_member: Option<&'static str>,
    /// Digest and MD5 of the binary on the router, for builds pinned in this
    /// app (the router's busybox has md5sum, not sha256sum). A newer GitHub
    /// release is checked by its download digest and compared by version.
    sha256: Option<&'static str>,
    md5: Option<&'static str>,
    /// Version, for binaries compared by version (Xray).
    version: Option<String>,
}

/// Router CPU families the VPN runs on. MIPS routers are left out: Xray
/// needs more memory and CPU than they have.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Arch {
    Arm64,
    Armv7,
}

impl Arch {
    /// From `uname -m`: aarch64, or 32-bit ARM v7 (armv8l is a 64-bit core
    /// running a 32-bit system).
    fn from_uname(machine: &str) -> Option<Arch> {
        match machine.trim() {
            "aarch64" | "arm64" => Some(Arch::Arm64),
            "armv7l" | "armv7" | "armv8l" => Some(Arch::Armv7),
            _ => None,
        }
    }

    fn xray_asset(self) -> &'static str {
        match self {
            Arch::Arm64 => "Xray-linux-arm64-v8a.zip",
            Arch::Armv7 => "Xray-linux-arm32-v7a.zip",
        }
    }
}

/// Xray build carried by this app: the fallback when GitHub cannot be read.
const PINNED_XRAY_VERSION: &str = "26.10.31";

fn pinned_xray(arch: Arch) -> Binary {
    let (download_sha256, sha256, md5) = match arch {
        Arch::Arm64 => (
            "1811c8f1da0c3b6dc707ebaf1c8390e987ba39859a8f0a7aadd8526157f2ec8d",
            "5939649960deaf535bcd5f7ce0467a2b1d63b72a2758a6f42eade714ae8d5328",
            "1ac186b69bff1fa9937de653fbb2bd19",
        ),
        Arch::Armv7 => (
            "2387f55239ee7799fd67d5382e79f589c1da07a97d993e86b058f2290b8e456b",
            "2a893d5b5f7cf5a33168c102f01771ed69a674abeab0b8fb085b1ddf098cf52c",
            "57da9fbd8d2262f9d4f6356d16829a44",
        ),
    };
    Binary {
        name: "xray",
        url: format!(
            "https://github.com/XTLS/Xray-core/releases/download/v{PINNED_XRAY_VERSION}/{}",
            arch.xray_asset()
        ),
        download_sha256: download_sha256.into(),
        zip_member: Some("xray"),
        sha256: Some(sha256),
        md5: Some(md5),
        version: Some(PINNED_XRAY_VERSION.into()),
    }
}

/// hev-socks5-tunnel; both builds are static, the ARMv7 one soft-float so
/// it runs on any ARMv7 core.
fn hev_tunnel(arch: Arch) -> Binary {
    let (asset, sha256, md5) = match arch {
        Arch::Arm64 => (
            "hev-socks5-tunnel-linux-arm64",
            "3a7e5e6fc21ce507d6106cefcdb101d43e43f04e7aac20f892edbd2d1264110d",
            "7720e92733082f4920c511205bb115da",
        ),
        Arch::Armv7 => (
            "hev-socks5-tunnel-linux-arm32v7",
            "51a8e91cc346d29e1521223535a4e4c54e3aacc9ea08f10e046910430a3f616e",
            "53991f8f4bee88214dbc54015492ebdf",
        ),
    };
    Binary {
        name: "hev-socks5-tunnel",
        url: format!(
            "https://github.com/heiher/hev-socks5-tunnel/releases/download/2.19.2/{asset}"
        ),
        download_sha256: sha256.into(),
        zip_member: None,
        sha256: Some(sha256),
        md5: Some(md5),
        version: None,
    }
}

/// A GitHub release must be this old before routers get it: withdrawn
/// releases (26.10.29) are usually gone within a day or two.
const RELEASE_MIN_AGE_DAYS: i64 = 3;
/// GitHub answers 60 unauthenticated requests an hour per address.
const RELEASE_CHECK_EVERY: Duration = Duration::from_secs(6 * 3600);
#[allow(clippy::type_complexity)]
static XRAY_TARGET: std::sync::Mutex<Vec<(Arch, std::time::Instant, Binary)>> =
    std::sync::Mutex::new(Vec::new());

/// The Xray build routers should run: the newest GitHub release that is
/// not a pre-release, at least three days old, and publishes the ARM64
/// archive with its digest file; else the build pinned in this app.
async fn xray_target(app: &AppHandle, arch: Arch) -> Binary {
    if let Ok(guard) = XRAY_TARGET.lock() {
        if let Some((_, _, binary)) = guard
            .iter()
            .find(|(cached, at, _)| *cached == arch && at.elapsed() < RELEASE_CHECK_EVERY)
        {
            return binary.clone();
        }
    }
    let latest = tokio::task::spawn_blocking(move || latest_xray_release(arch))
        .await
        .unwrap_or_else(|error| Err(format!("release check task: {error}")));
    let target = match latest {
        Ok(Some(release))
            // The same version as the pinned build keeps the pinned build's
            // stronger check (the binary's own digest).
            if version_tuple(release.version.as_deref().unwrap_or(""))
                > version_tuple(PINNED_XRAY_VERSION) =>
        {
            log(
                app,
                "info",
                format!(
                    "xray: latest suitable GitHub release {}",
                    release.version.as_deref().unwrap_or("")
                ),
            );
            release
        }
        Ok(_) => {
            log(
                app,
                "info",
                format!("xray: no newer suitable GitHub release, using {PINNED_XRAY_VERSION}"),
            );
            pinned_xray(arch)
        }
        Err(error) => {
            log(
                app,
                "warn",
                format!(
                    "xray: GitHub releases not readable ({error}), using {PINNED_XRAY_VERSION}"
                ),
            );
            return pinned_xray(arch);
        }
    };
    if let Ok(mut guard) = XRAY_TARGET.lock() {
        guard.retain(|(cached, _, _)| *cached != arch);
        guard.push((arch, std::time::Instant::now(), target.clone()));
    }
    target
}

fn latest_xray_release(arch: Arch) -> Result<Option<Binary>, String> {
    // reqwest is built without a default TLS provider: install it before the
    // first client, whatever ran first in the app.
    crate::update_download::install_rustls_provider();
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .user_agent("ToBeVPN-desktop")
        .build()
        .map_err(|error| format!("http client: {error}"))?;
    let releases: serde_json::Value = client
        .get("https://api.github.com/repos/XTLS/Xray-core/releases?per_page=15")
        .header("Accept", "application/vnd.github+json")
        .send()
        .and_then(|response| response.error_for_status())
        .and_then(|response| response.json())
        .map_err(|error| error_chain(&error))?;
    let now = chrono::Utc::now();
    for release in releases.as_array().into_iter().flatten() {
        let Some(candidate) = suitable_release(release, now, arch.xray_asset()) else {
            continue;
        };
        let (version, zip_url, digest_url) = candidate;
        let digest = client
            .get(&digest_url)
            .send()
            .and_then(|response| response.error_for_status())
            .and_then(|response| response.text())
            .map_err(|error| error_chain(&error))?;
        let Some(sha256) = sha256_from_dgst(&digest) else {
            continue;
        };
        return Ok(Some(Binary {
            name: "xray",
            url: zip_url,
            download_sha256: sha256,
            zip_member: Some("xray"),
            sha256: None,
            md5: None,
            version: Some(version),
        }));
    }
    Ok(None)
}

/// Version, archive URL and digest-file URL of a release routers may get.
fn suitable_release(
    release: &serde_json::Value,
    now: chrono::DateTime<chrono::Utc>,
    asset: &str,
) -> Option<(String, String, String)> {
    if release["draft"].as_bool() != Some(false) || release["prerelease"].as_bool() != Some(false) {
        return None;
    }
    let published = chrono::DateTime::parse_from_rfc3339(release["published_at"].as_str()?).ok()?;
    if now.signed_duration_since(published).num_days() < RELEASE_MIN_AGE_DAYS {
        return None;
    }
    let version = release["tag_name"]
        .as_str()?
        .trim_start_matches('v')
        .to_string();
    if version_tuple(&version).is_empty() {
        return None;
    }
    let assets = release["assets"].as_array()?;
    let url_of = |name: &str| {
        assets.iter().find_map(|asset| {
            (asset["name"].as_str()? == name)
                .then(|| asset["browser_download_url"].as_str().map(str::to_string))
                .flatten()
        })
    };
    let zip_url = url_of(asset)?;
    let digest_url = url_of(&format!("{asset}.dgst"))?;
    // Only GitHub's own download host.
    if !zip_url.starts_with("https://github.com/XTLS/Xray-core/releases/download/")
        || !digest_url.starts_with("https://github.com/XTLS/Xray-core/releases/download/")
    {
        return None;
    }
    Some((version, zip_url, digest_url))
}

/// The SHA2-256 line of an Xray .dgst file.
fn sha256_from_dgst(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        let value = value.trim().to_ascii_lowercase();
        (key.trim().eq_ignore_ascii_case("SHA2-256")
            && value.len() == 64
            && value.chars().all(|character| character.is_ascii_hexdigit()))
        .then_some(value)
    })
}

/// "26.10.31" as [26, 10, 31]; empty when not a plain dotted version.
fn version_tuple(version: &str) -> Vec<u32> {
    let parts: Option<Vec<u32>> = version
        .trim()
        .split('.')
        .map(|part| part.parse().ok())
        .collect();
    parts.unwrap_or_default()
}

/// Components routers should run, Xray resolved against GitHub.
async fn router_binaries(app: &AppHandle, arch: Arch) -> Vec<Binary> {
    vec![xray_target(app, arch).await, hev_tunnel(arch)]
}

/// The router's CPU family, or why the VPN cannot run on it.
async fn router_arch(session: &Session) -> Result<Arch, String> {
    let machine = session.run_ok("uname -m", None).await?;
    Arch::from_uname(&machine).ok_or_else(|| format!("unsupported router CPU: {}", machine.trim()))
}

/// Memory the router must have: in all, and free besides our own Xray.
const MIN_TOTAL_MEMORY_KB: u64 = 120 * 1024;
const MIN_FREE_MEMORY_KB: u64 = 64 * 1024;

/// Packages a stock OpenWrt may lack; installed by apk (OpenWrt 25) or opkg.
fn package_install_command(packages: &[&str]) -> String {
    let list = packages.join(" ");
    format!(
        "if command -v apk >/dev/null 2>&1; then apk update >/tmp/tobevpn-pkg.log 2>&1; apk add {list} >>/tmp/tobevpn-pkg.log 2>&1; \
         elif command -v opkg >/dev/null 2>&1; then opkg update >/tmp/tobevpn-pkg.log 2>&1; opkg install {list} >>/tmp/tobevpn-pkg.log 2>&1; \
         else echo 'no package manager' >/tmp/tobevpn-pkg.log; false; fi"
    )
}

/// Shell lines reporting what the router has: MD5 per binary, Xray's version.
fn component_facts_command(binaries: &[Binary]) -> String {
    let mut command: String = binaries
        .iter()
        .map(|binary| {
            format!(
                "echo md5_{0}=$(md5sum /opt/tobevpn/{0} 2>/dev/null | cut -d' ' -f1); ",
                binary.name
            )
        })
        .collect();
    command.push_str(
        // The version is written next to Xray on install and update; "xray
        // version" is only for routers set up before that.
        "echo xray_version=$(cat /opt/tobevpn/xray.version 2>/dev/null || /opt/tobevpn/xray version 2>/dev/null | awk 'NR==1{print $2}'); ",
    );
    command
}

/// Whether the router needs this binary: Xray when its version is older
/// than the target (or unknown), the others when their MD5 differs.
fn binary_outdated(binary: &Binary, facts: &HashMap<String, String>) -> bool {
    match &binary.version {
        Some(target) => {
            let current = facts.get("xray_version").map(String::as_str).unwrap_or("");
            let current = version_tuple(current);
            current.is_empty() || current < version_tuple(target)
        }
        None => {
            facts
                .get(&format!("md5_{}", binary.name))
                .map(String::as_str)
                != binary.md5
        }
    }
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RouterStatus {
    pub installed: bool,
    pub running: bool,
    pub autostart: bool,
    pub xray_memory_kb: Option<u64>,
    pub memory_available_kb: Option<u64>,
    pub tunnel_rx_bytes: u64,
    pub tunnel_tx_bytes: u64,
    /// "vpn" or "direct": the mode of devices without their own choice.
    pub default_mode: String,
    /// This computer's address in the home network, as the router sees it.
    pub client_ip: Option<String>,
    pub subscription_used_bytes: Option<u64>,
    pub subscription_total_bytes: Option<u64>,
    /// The core does not start: the home is direct, the router retries
    /// every minute.
    pub failed: bool,
    /// Slots whose server does not answer: their devices go direct until
    /// it answers again.
    pub down_slots: Vec<u8>,
    /// Routes that keep ToBeVPN servers outside the tunnel.
    pub server_bypass_rules: u64,
    /// Name the owner gave the router; None keeps the model.
    pub name: Option<String>,
    /// The router's device id in the account (from its LAN MAC).
    pub hwid: Option<String>,
}

/// Traffic through the router's tunnels in one hour.
#[derive(Serialize, Debug, PartialEq)]
pub struct TrafficHour {
    /// Epoch seconds of the hour's start.
    pub hour: u64,
    pub bytes: u64,
}

// ---------------------------------------------------------------- SSH ---

struct RouterHandler {
    /// Remembered host key fingerprint; None accepts and records it (pairing).
    expected: Option<String>,
    seen: Arc<std::sync::Mutex<Option<String>>>,
}

impl client::Handler for RouterHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let fingerprint = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => {
                key.fingerprint(HashAlg::Sha256).to_string()
            }
            PublicKeyOrCertificate::Certificate(_) => return Ok(false),
        };
        *self.seen.lock().unwrap() = Some(fingerprint.clone());
        Ok(self
            .expected
            .as_ref()
            .is_none_or(|expected| *expected == fingerprint))
    }
}

struct Session {
    handle: client::Handle<RouterHandler>,
}

impl Session {
    /// Runs one command, feeding `stdin` to it; returns stdout and the exit code.
    async fn run(&self, command: &str, stdin: Option<&[u8]>) -> Result<(String, u32), String> {
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|error| format!("ssh channel: {error}"))?;
        channel
            .exec(true, command)
            .await
            .map_err(|error| format!("ssh exec: {error}"))?;
        if let Some(input) = stdin {
            channel
                .data(input)
                .await
                .map_err(|error| format!("ssh upload: {error}"))?;
        }
        channel
            .eof()
            .await
            .map_err(|error| format!("ssh eof: {error}"))?;
        let mut output = Vec::new();
        let mut code = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => output.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                _ => {}
            }
        }
        Ok((
            String::from_utf8_lossy(&output).into_owned(),
            code.unwrap_or(255),
        ))
    }

    async fn run_ok(&self, command: &str, stdin: Option<&[u8]>) -> Result<String, String> {
        let (output, code) = self.run(command, stdin).await?;
        if code == 0 {
            Ok(output)
        } else {
            Err(format!("router command failed ({code}): {}", output.trim()))
        }
    }

    async fn write_file(&self, path: &str, content: &[u8], mode: &str) -> Result<(), String> {
        let command = format!("umask 077; cat > '{path}.tmp' && chmod {mode} '{path}.tmp' && mv '{path}.tmp' '{path}'");
        self.run_ok(&command, Some(content)).await.map(|_| ())
    }
}

fn router_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("app data dir: {error}"))?
        .join("router");
    std::fs::create_dir_all(&dir).map_err(|error| format!("create {}: {error}", dir.display()))?;
    Ok(dir)
}

/// This app's SSH key for routers, created on first use.
fn app_key(app: &AppHandle) -> Result<PrivateKey, String> {
    let path = router_dir(app)?.join("ssh_ed25519");
    if let Ok(text) = std::fs::read_to_string(&path) {
        return PrivateKey::from_openssh(text).map_err(|error| format!("router key: {error}"));
    }
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
        .map_err(|error| format!("router key: {error}"))?;
    let text = key
        .to_openssh(russh::keys::ssh_key::LineEnding::LF)
        .map_err(|error| format!("router key: {error}"))?;
    write_private(&path, text.as_bytes())?;
    Ok(key)
}

fn write_private(path: &std::path::Path, content: &[u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|error| format!("write {}: {error}", path.display()))?;
        file.write_all(content)
            .map_err(|error| format!("write {}: {error}", path.display()))
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, content).map_err(|error| format!("write {}: {error}", path.display()))
    }
}

fn known_hosts_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(router_dir(app)?.join("known_hosts.json"))
}

fn known_hosts(app: &AppHandle) -> HashMap<String, String> {
    known_hosts_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

async fn connect(
    app: &AppHandle,
    host: &str,
    pairing: bool,
) -> Result<(Session, Option<String>), String> {
    let expected = if pairing {
        None
    } else {
        known_hosts(app).get(host).cloned()
    };
    if !pairing && expected.is_none() {
        return Err("router is not paired".into());
    }
    let seen = Arc::new(std::sync::Mutex::new(None));
    let handler = RouterHandler {
        expected,
        seen: seen.clone(),
    };
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(120)),
        ..Default::default()
    });
    let handle = tokio::time::timeout(SSH_TIMEOUT, client::connect(config, (host, 22), handler))
        .await
        .map_err(|_| "router did not answer on SSH".to_string())?
        .map_err(|error| match error {
            russh::Error::UnknownKey => "router host key changed".to_string(),
            other => format!("ssh connect: {other}"),
        })?;
    let fingerprint = seen.lock().unwrap().clone();
    Ok((Session { handle }, fingerprint))
}

async fn open(app: &AppHandle, host: &str, user: &str) -> Result<Session, String> {
    let (mut session, _) = connect(app, host, false).await?;
    let key = PrivateKeyWithHashAlg::new(Arc::new(app_key(app)?), None);
    let auth = session
        .handle
        .authenticate_publickey(user, key)
        .await
        .map_err(|error| format!("ssh auth: {error}"))?;
    if !auth.success() {
        return Err("router rejected the app key".into());
    }
    Ok(session)
}

// ------------------------------------------------------------ commands ---

/// Logs in once with the router password and installs this app's key.
#[tauri::command]
pub async fn router_pair(
    app: AppHandle,
    host: String,
    user: String,
    password: String,
) -> Result<(), String> {
    log(&app, "info", format!("SSH {user}@{host}:22"));
    let result = pair(&app, host, user, password).await;
    match &result {
        Ok(()) => log(&app, "info", "app key installed on the router"),
        Err(error) => log(&app, "error", error.clone()),
    }
    result
}

async fn pair(app: &AppHandle, host: String, user: String, password: String) -> Result<(), String> {
    let app = app.clone();
    let (mut session, fingerprint) = connect(&app, &host, true).await?;
    if let Some(fingerprint) = &fingerprint {
        log(&app, "info", format!("new router host key {fingerprint}"));
    }
    let auth = session
        .handle
        .authenticate_password(&user, password)
        .await
        .map_err(|error| format!("ssh auth: {error}"))?;
    if !auth.success() {
        return Err("wrong router login or password".into());
    }
    log(&app, "info", "password accepted");
    let public = app_key(&app)?
        .public_key()
        .to_openssh()
        .map_err(|error| format!("router key: {error}"))?;
    let line = format!(
        "{} {KEY_COMMENT}\n",
        public
            .split_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join(" ")
    );
    session
        .run_ok(
            "umask 077; if [ \"$(id -u)\" = 0 ] && [ -d /etc/dropbear ]; then f=/etc/dropbear/authorized_keys; \
             else mkdir -p ~/.ssh; f=~/.ssh/authorized_keys; fi; \
             grep -qF tobevpn-desktop-router \"$f\" 2>/dev/null && sed -i '/tobevpn-desktop-router/d' \"$f\"; cat >> \"$f\"",
            Some(line.as_bytes()),
        )
        .await?;
    if let Some(fingerprint) = fingerprint {
        let mut hosts = known_hosts(&app);
        hosts.insert(host, fingerprint);
        let path = known_hosts_path(&app)?;
        std::fs::write(&path, serde_json::to_vec_pretty(&hosts).unwrap_or_default())
            .map_err(|error| format!("write {}: {error}", path.display()))?;
    }
    Ok(())
}

fn progress(app: &AppHandle, step: &str) {
    let _ = app.emit("router-install-progress", step);
    log(app, "step", step);
}

/// A line of the install log the Router screen can show in full.
#[derive(Serialize, Clone)]
struct LogLine {
    level: &'static str,
    text: String,
}

fn log(app: &AppHandle, level: &'static str, text: impl Into<String>) {
    let _ = app.emit(
        "router-install-log",
        LogLine {
            level,
            text: text.into(),
        },
    );
}

/// Installs (or updates) ToBeVPN on the paired router and starts it.
#[tauri::command]
pub async fn router_install(
    app: AppHandle,
    host: String,
    user: String,
    servers: Vec<SlotServer>,
    server_hosts: Vec<String>,
    subscription_url: String,
    autostart: bool,
) -> Result<RouterStatus, String> {
    let result = install(
        &app,
        host,
        user,
        servers,
        server_hosts,
        subscription_url,
        autostart,
    )
    .await;
    if let Err(error) = &result {
        log(&app, "error", error.clone());
    }
    result
}

async fn install(
    app: &AppHandle,
    host: String,
    user: String,
    servers: Vec<SlotServer>,
    server_hosts: Vec<String>,
    subscription_url: String,
    autostart: bool,
) -> Result<RouterStatus, String> {
    let app = app.clone();
    validate_slots(&servers)?;
    for server in &servers {
        log(
            &app,
            "info",
            format!("server slot {}: {}", server.slot, server.name),
        );
    }
    progress(&app, "connect");
    let session = open(&app, &host, &user).await?;

    progress(&app, "check");
    let arch = router_arch(&session).await?;
    let binaries = router_binaries(&app, arch).await;
    let md5_checks = component_facts_command(&binaries);
    let facts = parse_key_values(
        &session
            .run_ok(
                &format!(
                    "echo arch=$(uname -m); echo free_kb=$(df -k /overlay 2>/dev/null | awk 'NR==2{{print $4}}'); \
                     echo tun=$([ -c /dev/net/tun ] || grep -qw tun /proc/modules && echo 1 || echo 0); \
                     echo pkg=$(command -v apk >/dev/null || command -v opkg >/dev/null && echo 1 || echo 0); \
                     echo curl=$(command -v curl >/dev/null && echo 1 || echo 0); \
                     echo mem_total_kb=$(awk '/^MemTotal:/{{print $2}}' /proc/meminfo); \
                     echo mem_available_kb=$(awk '/^MemAvailable:/{{print $2}}' /proc/meminfo); \
                     echo own_xray_kb=$(p=$(pidof xray); [ -n \"$p\" ] && awk '/^VmRSS:/{{print $2}}' /proc/$p/status || echo 0); \
                     {md5_checks}\
                     echo mac=$(cat /sys/class/net/br-lan/address 2>/dev/null); \
                     . /etc/openwrt_release 2>/dev/null; echo os=\"$DISTRIB_RELEASE\"; \
                     echo model=$(cat /tmp/sysinfo/model 2>/dev/null | tr ' ' '-')"
                ),
                None,
            )
            .await?,
    );
    let fact = |key: &str| facts.get(key).map(String::as_str).unwrap_or("");
    log(
        &app,
        "info",
        format!(
            "router: {} · {} {} · free {} KB on /overlay · memory {} MB, {} MB free · TUN {} · curl {}",
            fact("model"),
            fact("arch"),
            fact("os").trim_matches('"'),
            fact("free_kb"),
            fact("mem_total_kb").parse::<u64>().unwrap_or(0) / 1024,
            fact("mem_available_kb").parse::<u64>().unwrap_or(0) / 1024,
            if fact("tun") == "1" { "yes" } else { "no" },
            if fact("curl") == "1" { "yes" } else { "no" }
        ),
    );
    // Before anything changes: a router without the memory for Xray would
    // freeze or reboot under it.
    let total_kb: u64 = fact("mem_total_kb").parse().unwrap_or(0);
    let free_kb: u64 = fact("mem_available_kb").parse::<u64>().unwrap_or(0)
        + fact("own_xray_kb").parse::<u64>().unwrap_or(0);
    if total_kb > 0 && total_kb < MIN_TOTAL_MEMORY_KB {
        return Err(format!(
            "router has too little memory: {} MB",
            total_kb / 1024
        ));
    }
    if total_kb > 0 && free_kb < MIN_FREE_MEMORY_KB {
        return Err(format!(
            "not enough free memory on the router: {} MB free",
            free_kb / 1024
        ));
    }
    let mut packages: Vec<&str> = Vec::new();
    if fact("tun") != "1" {
        packages.push("kmod-tun");
    }
    if fact("curl") != "1" {
        packages.push("curl");
    }
    if !packages.is_empty() && fact("pkg") != "1" {
        return Err(format!(
            "the router lacks {} and has no package manager",
            packages.join(", ")
        ));
    }
    let needed: Vec<&Binary> = binaries
        .iter()
        .filter(|binary| binary_outdated(binary, &facts))
        .collect();
    for binary in &binaries {
        let current = !needed.iter().any(|item| item.name == binary.name);
        log(
            &app,
            "info",
            format!(
                "{}: {}",
                binary.name,
                if current {
                    "already on the router, up to date"
                } else {
                    "will be installed"
                }
            ),
        );
    }
    if !needed.is_empty() {
        let free_kb: u64 = fact("free_kb").parse().unwrap_or(0);
        if free_kb < REQUIRED_FREE_KB {
            return Err(format!(
                "not enough space on the router: {} MB free",
                free_kb / 1024
            ));
        }
    }

    // Everything is downloaded before the running VPN is touched: a failed
    // download leaves the router as it was.
    let mut downloads = Vec::new();
    for binary in &needed {
        progress(&app, &format!("download:{}", binary.name));
        downloads.push((*binary, fetch_binary(&app, binary).await?));
    }

    // An earlier run may be active; it is restarted with the new files.
    let (stopped, _) = session
        .run(
            "[ -x /opt/tobevpn/tobevpn-router.sh ] && /opt/tobevpn/tobevpn-router.sh stop",
            None,
        )
        .await?;
    log_output(&app, &stopped);

    session.run_ok("mkdir -p /opt/tobevpn", None).await?;
    if !packages.is_empty() {
        progress(&app, "tun");
        let (_, code) = session
            .run(&package_install_command(&packages), None)
            .await?;
        let (log_tail, _) = session.run("tail -5 /tmp/tobevpn-pkg.log", None).await?;
        log_output(&app, &log_tail);
        let (check, _) = session
            .run(
                "modprobe tun 2>/dev/null; echo tun=$([ -c /dev/net/tun ] || grep -qw tun /proc/modules && echo 1 || echo 0); \
                 echo curl=$(command -v curl >/dev/null && echo 1 || echo 0)",
                None,
            )
            .await?;
        let after = parse_key_values(&check);
        if code != 0
            || after.get("tun").map(String::as_str) != Some("1")
            || after.get("curl").map(String::as_str) != Some("1")
        {
            return Err(format!(
                "could not install {} on the router: {}",
                packages.join(", "),
                log_tail.trim()
            ));
        }
        // Remembered, so removing ToBeVPN removes only what it added.
        session
            .write_file(
                "/opt/tobevpn/packages",
                format!("{}\n", packages.join(" ")).as_bytes(),
                "644",
            )
            .await?;
        log(&app, "info", format!("installed {}", packages.join(", ")));
    }
    for (binary, content) in downloads {
        progress(&app, &format!("upload:{}", binary.name));
        session
            .write_file(&format!("/opt/tobevpn/{}", binary.name), &content, "755")
            .await?;
        log(
            &app,
            "info",
            format!("{}: uploaded {} KB", binary.name, content.len() / 1024),
        );
        if let (Some(version), "xray") = (&binary.version, binary.name) {
            session
                .write_file(
                    "/opt/tobevpn/xray.version",
                    format!("{version}\n").as_bytes(),
                    "644",
                )
                .await?;
        }
    }

    progress(&app, "configure");
    let mac = facts
        .get("mac")
        .cloned()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let hwid = uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_OID,
        format!("tobevpn-router:{mac}").as_bytes(),
    );
    let model = facts
        .get("model")
        .filter(|value| !value.is_empty())
        .cloned()
        .unwrap_or_else(|| "router".into());
    let subscription = format!(
        "SUB_URL='{}'\nHWID='{hwid}'\nAPP_VERSION='{}'\nOS_VERSION='{}'\nMODEL='{}'\n",
        shell_quote_inner(&subscription_url),
        env!("CARGO_PKG_VERSION"),
        shell_quote_inner(
            facts
                .get("os")
                .map(|value| value.trim_matches('"'))
                .unwrap_or("")
        ),
        shell_quote_inner(&model),
    );
    session
        .write_file(
            "/opt/tobevpn/tobevpn-router.sh",
            AGENT_SCRIPT.as_bytes(),
            "755",
        )
        .await?;
    write_servers(&session, &servers).await?;
    session
        .write_file(
            "/opt/tobevpn/subscription.conf",
            subscription.as_bytes(),
            "600",
        )
        .await?;
    session
        .write_file(
            "/opt/tobevpn/servers",
            server_list(&server_hosts).as_bytes(),
            "644",
        )
        .await?;
    // New devices stay direct until the owner picks a server for them; a
    // device with its own ToBeVPN on reaches the servers directly (see
    // "servers"). Choices made earlier are kept when reinstalling.
    session
        .run_ok(
            "[ -s /opt/tobevpn/default_mode ] || echo direct > /opt/tobevpn/default_mode; \
             touch /opt/tobevpn/devices; rm -f /opt/tobevpn/clients /opt/tobevpn/direct; \
             mkdir -p /etc/hotplug.d/dhcp",
            None,
        )
        .await?;
    session
        .write_file(
            "/etc/hotplug.d/dhcp/90-tobevpn",
            DHCP_HOOK.as_bytes(),
            "755",
        )
        .await?;
    session
        .write_file("/etc/init.d/tobevpn", INIT_SCRIPT.as_bytes(), "755")
        .await?;
    session
        .run_ok(
            if autostart {
                "/etc/init.d/tobevpn enable"
            } else {
                "/etc/init.d/tobevpn disable"
            },
            None,
        )
        .await?;

    log(
        &app,
        "info",
        format!("autostart {}", if autostart { "on" } else { "off" }),
    );
    progress(&app, "start");
    let started = session
        .run_ok("/opt/tobevpn/tobevpn-router.sh start", None)
        .await?;
    log_output(&app, &started);
    let status = session
        .run_ok("/opt/tobevpn/tobevpn-router.sh status", None)
        .await?;
    log_output(&app, &status);
    progress(&app, "done");
    Ok(parse_status(&status))
}

/// Components on the router that differ from the ones this app carries.
#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RouterUpdate {
    pub available: bool,
    /// "xray", "hev-socks5-tunnel", "agent".
    pub components: Vec<String>,
    /// Xray on the router and the version it would get.
    pub xray_current: Option<String>,
    pub xray_target: Option<String>,
}

/// Binaries the router should get (Xray by version against the newest
/// suitable GitHub release, the rest by MD5), the router's Xray version,
/// and whether the agent script differs.
async fn outdated_components(
    app: &AppHandle,
    session: &Session,
) -> Result<(Vec<Binary>, Option<String>, bool), String> {
    let arch = router_arch(session).await?;
    let binaries = router_binaries(app, arch).await;
    let facts = parse_key_values(
        &session
            .run_ok(&component_facts_command(&binaries), None)
            .await?,
    );
    let current = facts
        .get("xray_version")
        .filter(|version| !version.is_empty())
        .cloned();
    let needed = binaries
        .into_iter()
        .filter(|binary| binary_outdated(binary, &facts))
        .collect();
    let (agent, _) = session
        .run("cat /opt/tobevpn/tobevpn-router.sh 2>/dev/null", None)
        .await?;
    Ok((needed, current, agent != AGENT_SCRIPT))
}

/// Whether the router runs older components than this app carries. Uses
/// the app's key; nothing on the router changes.
#[tauri::command]
pub async fn router_update_check(
    app: AppHandle,
    host: String,
    user: String,
) -> Result<RouterUpdate, String> {
    let session = open(&app, &host, &user).await?;
    let (binaries, xray_current, agent) = outdated_components(&app, &session).await?;
    let xray_target = binaries
        .iter()
        .find(|binary| binary.name == "xray")
        .and_then(|binary| binary.version.clone());
    let mut components: Vec<String> = binaries
        .iter()
        .map(|binary| binary.name.to_string())
        .collect();
    if agent {
        components.push("agent".into());
    }
    Ok(RouterUpdate {
        available: !components.is_empty(),
        components,
        xray_current,
        xray_target,
    })
}

/// Brings the router's components to this app's versions: everything is
/// downloaded and checked first, then the VPN is stopped, the files
/// replaced and the VPN started again. Servers and device choices stay.
#[tauri::command]
pub async fn router_update(
    app: AppHandle,
    host: String,
    user: String,
) -> Result<RouterStatus, String> {
    let result = update(&app, &host, &user).await;
    if let Err(error) = &result {
        log(&app, "error", error.clone());
    }
    result
}

async fn update(app: &AppHandle, host: &str, user: &str) -> Result<RouterStatus, String> {
    progress(app, "connect");
    let session = open(app, host, user).await?;
    progress(app, "check");
    let (needed, _, _) = outdated_components(app, &session).await?;
    if !needed.is_empty() {
        let free_kb: u64 = session
            .run_ok("df -k /overlay 2>/dev/null | awk 'NR==2{print $4}'", None)
            .await?
            .trim()
            .parse()
            .unwrap_or(0);
        if free_kb < REQUIRED_FREE_KB {
            return Err(format!(
                "not enough space on the router: {} MB free",
                free_kb / 1024
            ));
        }
    }
    let mut downloads = Vec::new();
    for binary in &needed {
        progress(app, &format!("download:{}", binary.name));
        downloads.push((binary, fetch_binary(app, binary).await?));
    }

    progress(app, "configure");
    let (stopped, _) = session
        .run("/opt/tobevpn/tobevpn-router.sh stop", None)
        .await?;
    log_output(app, &stopped);
    for (binary, content) in downloads {
        progress(app, &format!("upload:{}", binary.name));
        session
            .write_file(&format!("/opt/tobevpn/{}", binary.name), &content, "755")
            .await?;
        log(
            app,
            "info",
            format!("{}: uploaded {} KB", binary.name, content.len() / 1024),
        );
        if let (Some(version), "xray") = (&binary.version, binary.name) {
            session
                .write_file(
                    "/opt/tobevpn/xray.version",
                    format!("{version}\n").as_bytes(),
                    "644",
                )
                .await?;
        }
    }
    session
        .write_file(
            "/opt/tobevpn/tobevpn-router.sh",
            AGENT_SCRIPT.as_bytes(),
            "755",
        )
        .await?;
    session
        .write_file(
            "/etc/hotplug.d/dhcp/90-tobevpn",
            DHCP_HOOK.as_bytes(),
            "755",
        )
        .await?;
    // Rewriting the init script keeps its enabled/disabled state (rc.d link).
    session
        .write_file("/etc/init.d/tobevpn", INIT_SCRIPT.as_bytes(), "755")
        .await?;

    progress(app, "start");
    let started = session
        .run_ok("/opt/tobevpn/tobevpn-router.sh start", None)
        .await?;
    log_output(app, &started);
    let status = session
        .run_ok("/opt/tobevpn/tobevpn-router.sh status", None)
        .await?;
    progress(app, "done");
    Ok(parse_status(&status))
}

#[tauri::command]
pub async fn router_status(
    app: AppHandle,
    host: String,
    user: String,
) -> Result<RouterStatus, String> {
    let session = open(&app, &host, &user).await?;
    let (output, _) = session
        .run(
            "[ -x /opt/tobevpn/tobevpn-router.sh ] && /opt/tobevpn/tobevpn-router.sh status",
            None,
        )
        .await?;
    Ok(parse_status(&output))
}

/// start | stop | restart | autostart-on | autostart-off | uninstall
#[tauri::command]
pub async fn router_control(
    app: AppHandle,
    host: String,
    user: String,
    action: String,
) -> Result<RouterStatus, String> {
    let session = open(&app, &host, &user).await?;
    let command = match action.as_str() {
        "start" | "stop" | "restart" => format!("/opt/tobevpn/tobevpn-router.sh {action}"),
        "autostart-on" => "/etc/init.d/tobevpn enable".into(),
        "autostart-off" => "/etc/init.d/tobevpn disable".into(),
        "uninstall" => {
            // Only the packages the install added (kmod-tun, curl) are removed.
            "added=$(cat /opt/tobevpn/packages 2>/dev/null); /opt/tobevpn/tobevpn-router.sh uninstall; \
             if [ -n \"$added\" ]; then if command -v apk >/dev/null 2>&1; then apk del $added; else opkg remove $added; fi; fi >/dev/null 2>&1; true"
                .into()
        }
        _ => return Err(format!("unknown router action: {action}")),
    };
    session.run_ok(&command, None).await?;
    if action == "uninstall" {
        let mut hosts = known_hosts(&app);
        hosts.remove(&host);
        if let Ok(path) = known_hosts_path(&app) {
            let _ = std::fs::write(path, serde_json::to_vec_pretty(&hosts).unwrap_or_default());
        }
        return Ok(RouterStatus::default());
    }
    let (output, _) = session
        .run("/opt/tobevpn/tobevpn-router.sh status", None)
        .await?;
    Ok(parse_status(&output))
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RouterDevice {
    pub mac: String,
    pub ip: Option<String>,
    /// Name the device reported over DHCP.
    pub hostname: Option<String>,
    /// "vpn", "direct" or "default" (follows the router's default mode).
    pub mode: String,
    /// Name the user gave the device.
    pub name: Option<String>,
    pub online: bool,
    /// Server slot: 0 is the router's server.
    pub slot: u8,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RouterSlot {
    pub slot: u8,
    pub server_id: String,
    pub server_name: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RouterNetwork {
    pub devices: Vec<RouterDevice>,
    pub slots: Vec<RouterSlot>,
}

/// Devices of the home network, with their VPN choice.
#[tauri::command]
pub async fn router_devices(
    app: AppHandle,
    host: String,
    user: String,
) -> Result<RouterNetwork, String> {
    let session = open(&app, &host, &user).await?;
    let output = session
        .run_ok("/opt/tobevpn/tobevpn-router.sh devices", None)
        .await?;
    Ok(RouterNetwork {
        devices: parse_devices(&output),
        slots: parse_slots(&output),
    })
}

/// Sets one device to "vpn", "direct" or back to "default", with a name.
#[tauri::command]
pub async fn router_set_device(
    app: AppHandle,
    host: String,
    user: String,
    mac: String,
    mode: String,
    slot: u8,
    name: String,
) -> Result<(), String> {
    if slot > MAX_SLOT {
        return Err("invalid server slot".into());
    }
    let mac = mac.trim().to_ascii_lowercase();
    let valid_mac = mac.len() == 17
        && mac.split(':').count() == 6
        && mac
            .split(':')
            .all(|part| part.len() == 2 && part.bytes().all(|byte| byte.is_ascii_hexdigit()));
    if !valid_mac || !matches!(mode.as_str(), "vpn" | "direct" | "default") {
        return Err("invalid device".into());
    }
    let name: String = name
        .chars()
        .filter(|character| !character.is_control() && *character != '|')
        .take(40)
        .collect();
    let session = open(&app, &host, &user).await?;
    session
        .run_ok(
            &format!(
                "/opt/tobevpn/tobevpn-router.sh set-device '{mac}' '{mode}' '{slot}' '{}'",
                shell_quote_inner(name.trim())
            ),
            None,
        )
        .await
        .map(|_| ())
}

/// Name of the router, kept on the router so every app paired with it sees
/// it. An empty name returns to the model.
#[tauri::command]
pub async fn router_set_name(
    app: AppHandle,
    host: String,
    user: String,
    name: String,
) -> Result<RouterStatus, String> {
    let name = clean_router_name(&name);
    let session = open(&app, &host, &user).await?;
    session
        .run_ok(
            &format!(
                "/opt/tobevpn/tobevpn-router.sh set-name '{}'",
                shell_quote_inner(&name)
            ),
            None,
        )
        .await?;
    let (output, _) = session
        .run("/opt/tobevpn/tobevpn-router.sh status", None)
        .await?;
    Ok(parse_status(&output))
}

fn clean_router_name(name: &str) -> String {
    name.chars()
        .filter(|character| !character.is_control() && !"|\\\"`$".contains(*character))
        .take(40)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Hourly traffic through the router's tunnels, about the last 5 weeks.
#[tauri::command]
pub async fn router_traffic(
    app: AppHandle,
    host: String,
    user: String,
) -> Result<Vec<TrafficHour>, String> {
    let session = open(&app, &host, &user).await?;
    let (output, _) = session
        .run("/opt/tobevpn/tobevpn-router.sh traffic", None)
        .await?;
    Ok(parse_traffic(&output))
}

fn parse_traffic(text: &str) -> Vec<TrafficHour> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let hour = fields.next()?.parse().ok()?;
            let bytes = fields.next()?.parse().ok()?;
            Some(TrafficHour { hour, bytes })
        })
        .collect()
}

/// Mode for devices without their own choice: "vpn" or "direct".
#[tauri::command]
pub async fn router_set_default_mode(
    app: AppHandle,
    host: String,
    user: String,
    mode: String,
) -> Result<RouterStatus, String> {
    if !matches!(mode.as_str(), "vpn" | "direct") {
        return Err("invalid mode".into());
    }
    let session = open(&app, &host, &user).await?;
    session
        .run_ok(
            &format!("/opt/tobevpn/tobevpn-router.sh set-default {mode}"),
            None,
        )
        .await?;
    let (output, _) = session
        .run("/opt/tobevpn/tobevpn-router.sh status", None)
        .await?;
    Ok(parse_status(&output))
}

fn parse_slots(text: &str) -> Vec<RouterSlot> {
    text.lines()
        .filter_map(|line| line.strip_prefix("slot="))
        .filter_map(|line| {
            let mut fields = line.splitn(3, '|');
            let slot = fields
                .next()?
                .parse::<u8>()
                .ok()
                .filter(|slot| *slot <= MAX_SLOT)?;
            Some(RouterSlot {
                slot,
                server_id: fields.next()?.to_string(),
                server_name: fields.next().unwrap_or_default().to_string(),
            })
        })
        .collect()
}

fn parse_devices(text: &str) -> Vec<RouterDevice> {
    let mut devices: Vec<RouterDevice> = text
        .lines()
        .filter_map(|line| line.strip_prefix("device="))
        .filter_map(|line| {
            let fields: Vec<&str> = line.split('|').collect();
            let [mac, ip, hostname, mode, name, online, rest @ ..] = fields.as_slice() else {
                return None;
            };
            let slot = rest
                .first()
                .and_then(|slot| slot.parse().ok())
                .filter(|slot| *slot <= MAX_SLOT)
                .unwrap_or(0);
            let present = |value: &&str| (!value.is_empty()).then(|| value.to_string());
            Some(RouterDevice {
                mac: mac.to_string(),
                ip: present(ip),
                hostname: present(hostname),
                mode: mode.to_string(),
                name: present(name),
                online: *online == "1",
                slot,
            })
        })
        .collect();
    devices.sort_by(|a, b| b.online.cmp(&a.online).then_with(|| a.ip.cmp(&b.ip)));
    devices
}

/// Sets the router's server (slot 0) and the servers of single devices
/// (slots 1-7), then restarts the tunnels.
#[tauri::command]
pub async fn router_set_servers(
    app: AppHandle,
    host: String,
    user: String,
    servers: Vec<SlotServer>,
    server_hosts: Vec<String>,
) -> Result<RouterStatus, String> {
    validate_slots(&servers)?;
    let session = open(&app, &host, &user).await?;
    session
        .write_file(
            "/opt/tobevpn/servers",
            server_list(&server_hosts).as_bytes(),
            "644",
        )
        .await?;
    write_servers(&session, &servers).await?;
    session
        .run_ok("/opt/tobevpn/tobevpn-router.sh restart", None)
        .await?;
    let (output, _) = session
        .run("/opt/tobevpn/tobevpn-router.sh status", None)
        .await?;
    Ok(parse_status(&output))
}

/// A server in a slot (0-7); devices are sent to their server's slot.
#[derive(serde::Deserialize, Debug)]
pub struct SlotServer {
    pub slot: u8,
    pub id: String,
    pub name: String,
    pub server: ServerConfig,
}

fn validate_slots(servers: &[SlotServer]) -> Result<(), String> {
    let mut seen = [false; MAX_SLOT as usize + 1];
    for server in servers {
        let slot = server.slot as usize;
        if server.slot > MAX_SLOT || seen[slot] {
            return Err("invalid server slots".into());
        }
        seen[slot] = true;
    }
    if seen[0] {
        Ok(())
    } else {
        Err("the router server is missing".into())
    }
}

/// Xray config, one tunnel config per slot and the slot list on the router.
async fn write_servers(session: &Session, servers: &[SlotServer]) -> Result<(), String> {
    session
        .write_file(
            "/opt/tobevpn/xray.json",
            router_xray_config(servers).as_bytes(),
            "600",
        )
        .await?;
    for slot in 0..=MAX_SLOT {
        let path = if slot == 0 {
            "/opt/tobevpn/hev.yml".to_string()
        } else {
            format!("/opt/tobevpn/hev{slot}.yml")
        };
        if servers.iter().any(|server| server.slot == slot) {
            session
                .write_file(&path, hev_config(slot).as_bytes(), "600")
                .await?;
        } else {
            session.run_ok(&format!("rm -f '{path}'"), None).await?;
        }
    }
    let clean = |value: &str| -> String {
        value
            .chars()
            .filter(|character| !character.is_control() && *character != '|')
            .take(80)
            .collect()
    };
    let slots: String = servers
        .iter()
        .map(|server| {
            format!(
                "{}\t{}\t{}\n",
                server.slot,
                clean(&server.id),
                clean(&server.name)
            )
        })
        .collect();
    session
        .write_file("/opt/tobevpn/slots", slots.as_bytes(), "644")
        .await
}

fn hev_config(slot: u8) -> String {
    format!(
        "tunnel:\n  name: tobe{slot}\n  mtu: 1500\n  multi-queue: false\n  ipv4: 198.18.{slot}.1\n\
         socks5:\n  port: {}\n  address: 127.0.0.1\n  udp: udp\nmisc:\n  log-level: warn\n",
        SOCKS_PORT + u16::from(slot)
    )
}

// ------------------------------------------------------------- helpers ---

/// One SOCKS input per slot, each sent to its own server.
fn router_xray_config(servers: &[SlotServer]) -> String {
    let inbounds: Vec<_> = servers
        .iter()
        .map(|server| {
            json!({
                "tag": format!("socks{}", server.slot),
                "listen": "127.0.0.1",
                "port": SOCKS_PORT + u16::from(server.slot),
                "protocol": "socks",
                "settings": { "auth": "noauth", "udp": true }
            })
        })
        .collect();
    let mut outbounds: Vec<_> = servers
        .iter()
        .map(|server| build_proxy_outbound(&server.server, &format!("proxy{}", server.slot)))
        .collect();
    outbounds.push(json!({ "tag": "direct", "protocol": "freedom" }));
    outbounds.push(json!({ "tag": "block", "protocol": "blackhole" }));
    let mut rules = vec![json!({ "type": "field", "ip": PRIVATE_RANGES, "outboundTag": "direct" })];
    rules.extend(servers.iter().map(|server| {
        json!({
            "type": "field",
            "inboundTag": [format!("socks{}", server.slot)],
            "outboundTag": format!("proxy{}", server.slot)
        })
    }));
    let base_key = servers
        .iter()
        .find(|server| server.slot == 0)
        .map(|server| server.server.uuid.clone())
        .unwrap_or_default();
    let config = json!({
        "log": { "loglevel": "warning" },
        "inbounds": inbounds,
        "outbounds": outbounds,
        "routing": { "domainStrategy": "AsIs", "rules": rules },
        "xudp": { "baseKey": base_key }
    });
    serde_json::to_string_pretty(&config).unwrap_or_default()
}

/// ToBeVPN server hosts, one per line; anything but a plain host name or
/// address is dropped, as the router agent passes them to resolveip.
fn server_list(hosts: &[String]) -> String {
    let mut list: Vec<&str> = hosts
        .iter()
        .map(|host| host.trim())
        .filter(|host| {
            !host.is_empty()
                && host.len() <= 253
                && host
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b".:-".contains(&byte))
        })
        .collect();
    list.sort_unstable();
    list.dedup();
    list.iter().map(|host| format!("{host}\n")).collect()
}

/// Escapes a value for use inside single quotes in a shell script.
fn shell_quote_inner(value: &str) -> String {
    value.replace('\'', "'\\''")
}

fn parse_key_values(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        .collect()
}

fn parse_status(text: &str) -> RouterStatus {
    let values = parse_key_values(text);
    let flag = |key: &str| values.get(key).map(String::as_str) == Some("1");
    let number = |key: &str| values.get(key).and_then(|value| value.parse::<u64>().ok());
    let (used, total) = values
        .get("subscription_userinfo")
        .map(|info| {
            let parts = parse_userinfo(info);
            let used = match (parts.get("upload"), parts.get("download")) {
                (None, None) => None,
                (upload, download) => Some(upload.unwrap_or(&0) + download.unwrap_or(&0)),
            };
            (used, parts.get("total").copied())
        })
        .unwrap_or((None, None));
    RouterStatus {
        installed: flag("installed"),
        running: flag("running"),
        autostart: flag("autostart"),
        xray_memory_kb: number("xray_rss_kb"),
        memory_available_kb: number("mem_available_kb"),
        tunnel_rx_bytes: number("tun_rx_bytes").unwrap_or(0),
        tunnel_tx_bytes: number("tun_tx_bytes").unwrap_or(0),
        default_mode: values
            .get("default_mode")
            .cloned()
            .unwrap_or_else(|| "vpn".into()),
        client_ip: values.get("client_ip").filter(|ip| !ip.is_empty()).cloned(),
        subscription_used_bytes: used,
        subscription_total_bytes: total,
        failed: values.contains_key("failed"),
        down_slots: values
            .get("down_slots")
            .map(|slots| {
                slots
                    .split_whitespace()
                    .filter_map(|slot| slot.parse().ok())
                    .filter(|slot| *slot <= MAX_SLOT)
                    .collect()
            })
            .unwrap_or_default(),
        server_bypass_rules: number("bypass_rules").unwrap_or(0),
        name: values.get("name").filter(|name| !name.is_empty()).cloned(),
        hwid: values.get("hwid").filter(|hwid| !hwid.is_empty()).cloned(),
    }
}

fn parse_userinfo(info: &str) -> HashMap<String, u64> {
    info.split(';')
        .filter_map(|part| part.split_once('='))
        .filter_map(|(key, value)| {
            Some((key.trim().to_ascii_lowercase(), value.trim().parse().ok()?))
        })
        .collect()
}

/// A pinned binary from the app cache, downloading and verifying it once.
async fn fetch_binary(app: &AppHandle, binary: &Binary) -> Result<Vec<u8>, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("app cache dir: {error}"))?
        .join("router");
    std::fs::create_dir_all(&cache)
        .map_err(|error| format!("create {}: {error}", cache.display()))?;
    // The download is cached and checked by its own digest, so a release
    // known only by its .dgst can be taken from the cache too.
    let cached = cache.join(format!(
        "{}-{}.download",
        binary.name,
        &binary.download_sha256[..16]
    ));
    let from_cache = std::fs::read(&cached)
        .ok()
        .filter(|content| sha256_hex(content) == binary.download_sha256);
    if from_cache.is_some() {
        log(
            app,
            "info",
            format!("{}: taken from the app cache", binary.name),
        );
    }
    let mut attempt = 0;
    let downloaded = if let Some(content) = from_cache {
        content
    } else {
        loop {
            attempt += 1;
            log(
                app,
                "info",
                format!(
                    "{}: download attempt {attempt}/{DOWNLOAD_ATTEMPTS}: {}",
                    binary.name, binary.url
                ),
            );
            let url = binary.url.to_string();
            let result = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
                crate::update_download::install_rustls_provider();
                let response = reqwest::blocking::Client::builder()
                    .connect_timeout(Duration::from_secs(20))
                    .timeout(Duration::from_secs(300))
                    .build()
                    .map_err(|error| format!("http client: {error}"))?
                    .get(&url)
                    .send()
                    .and_then(|response| response.error_for_status())
                    .map_err(|error| format!("download {url}: {}", error_chain(&error)))?;
                response
                    .bytes()
                    .map(|bytes| bytes.to_vec())
                    .map_err(|error| format!("download {url}: {}", error_chain(&error)))
            })
            .await
            .map_err(|error| format!("download task: {error}"))?;
            match result {
                Ok(bytes) => {
                    log(
                        app,
                        "info",
                        format!("{}: downloaded {} KB", binary.name, bytes.len() / 1024),
                    );
                    break bytes;
                }
                Err(error) if attempt < DOWNLOAD_ATTEMPTS => {
                    log(app, "warn", error);
                    tokio::time::sleep(Duration::from_secs(2 * attempt as u64)).await;
                }
                Err(error) => return Err(error),
            }
        }
    };
    if sha256_hex(&downloaded) != binary.download_sha256 {
        return Err(format!("{}: download checksum mismatch", binary.name));
    }
    let _ = std::fs::write(&cached, &downloaded);
    let content = match binary.zip_member {
        Some(member) => unzip_member(&downloaded, member)?,
        None => downloaded,
    };
    if let Some(expected) = binary.sha256 {
        if sha256_hex(&content) != expected {
            return Err(format!("{}: checksum mismatch", binary.name));
        }
    }
    Ok(content)
}

const DOWNLOAD_ATTEMPTS: u32 = 3;

/// The error with its causes: reqwest's top message alone hides them.
fn error_chain(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

/// Each line of a command's output as a log line.
fn log_output(app: &AppHandle, output: &str) {
    for line in output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        // The subscription header carries no secret, but keep the log short.
        if !line.starts_with("subscription_userinfo=") {
            log(app, "info", line.to_string());
        }
    }
}

fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Extracts one stored or deflated member from a zip archive, located via
/// the central directory (local headers may defer sizes to a descriptor).
fn unzip_member(zip: &[u8], name: &str) -> Result<Vec<u8>, String> {
    let le16 = |at: usize| -> Option<usize> {
        Some(u16::from_le_bytes(zip.get(at..at + 2)?.try_into().ok()?) as usize)
    };
    let le32 = |at: usize| -> Option<usize> {
        Some(u32::from_le_bytes(zip.get(at..at + 4)?.try_into().ok()?) as usize)
    };
    let eocd = (0..zip.len().saturating_sub(21))
        .rev()
        .find(|&at| zip[at..].starts_with(&[0x50, 0x4b, 0x05, 0x06]))
        .ok_or("zip: no end of central directory")?;
    let entries = le16(eocd + 10).ok_or("zip: truncated")?;
    let mut at = le32(eocd + 16).ok_or("zip: truncated")?;
    for _ in 0..entries {
        if !zip
            .get(at..)
            .is_some_and(|rest| rest.starts_with(&[0x50, 0x4b, 0x01, 0x02]))
        {
            return Err("zip: bad central directory".into());
        }
        let method = le16(at + 10).ok_or("zip: truncated")?;
        let compressed = le32(at + 20).ok_or("zip: truncated")?;
        let size = le32(at + 24).ok_or("zip: truncated")?;
        let name_len = le16(at + 28).ok_or("zip: truncated")?;
        let extra_len = le16(at + 30).ok_or("zip: truncated")?;
        let comment_len = le16(at + 32).ok_or("zip: truncated")?;
        let local = le32(at + 42).ok_or("zip: truncated")?;
        let entry_name = zip
            .get(at + 46..at + 46 + name_len)
            .ok_or("zip: truncated")?;
        if entry_name == name.as_bytes() {
            let data_at = local
                + 30
                + le16(local + 26).ok_or("zip: truncated")?
                + le16(local + 28).ok_or("zip: truncated")?;
            let data = zip
                .get(data_at..data_at + compressed)
                .ok_or("zip: truncated member")?;
            return match method {
                0 => Ok(data.to_vec()),
                8 => {
                    let mut out = Vec::with_capacity(size);
                    DeflateDecoder::new(data)
                        .read_to_end(&mut out)
                        .map_err(|error| format!("zip: {error}"))?;
                    Ok(out)
                }
                other => Err(format!("zip: unsupported method {other}")),
            };
        }
        at += 46 + name_len + extra_len + comment_len;
    }
    Err(format!("zip: {name} not found"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_agent_status() {
        let status = parse_status(
            "installed=1\nrunning=1\nautostart=0\nxray_rss_kb=33600\nmem_available_kb=47116\n\
             tun_rx_bytes=105470974\ntun_tx_bytes=420978\ndefault_mode=vpn\nclient_ip=192.168.1.183\n\
             down_slots=0 2\n\
             subscription_userinfo=upload=0; download=68544880231; total=268435456000; expire=1813168827\n",
        );
        assert!(status.installed && status.running && !status.autostart);
        assert_eq!(status.xray_memory_kb, Some(33600));
        assert_eq!(status.default_mode, "vpn");
        assert_eq!(status.client_ip.as_deref(), Some("192.168.1.183"));
        assert_eq!(status.subscription_used_bytes, Some(68544880231));
        assert_eq!(status.subscription_total_bytes, Some(268435456000));
        assert_eq!(status.down_slots, vec![0, 2]);
        assert_eq!(status.name, None);
        assert!(parse_status("down_slots=\n").down_slots.is_empty());
    }

    #[test]
    fn parses_name_traffic_and_cleans_names() {
        let status = parse_status("name=Дача\nhwid=1b2c\n");
        assert_eq!(status.name.as_deref(), Some("Дача"));
        assert_eq!(status.hwid.as_deref(), Some("1b2c"));
        assert_eq!(
            parse_traffic("1794150000 52085819\nbad\n1794153600 7\n"),
            vec![
                TrafficHour {
                    hour: 1794150000,
                    bytes: 52085819
                },
                TrafficHour {
                    hour: 1794153600,
                    bytes: 7
                },
            ]
        );
        assert_eq!(clean_router_name("  Дача`$ у мамы\n "), "Дача у мамы");
        assert_eq!(clean_router_name(&"я".repeat(60)).chars().count(), 40);
    }

    #[test]
    fn picks_router_xray_releases() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-08T12:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let release = |tag: &str, published: &str, prerelease: bool| {
            json!({
                "tag_name": tag, "draft": false, "prerelease": prerelease, "published_at": published,
                "assets": [
                    {"name": "Xray-linux-arm64-v8a.zip",
                     "browser_download_url": format!("https://github.com/XTLS/Xray-core/releases/download/{tag}/Xray-linux-arm64-v8a.zip")},
                    {"name": "Xray-linux-arm64-v8a.zip.dgst",
                     "browser_download_url": format!("https://github.com/XTLS/Xray-core/releases/download/{tag}/Xray-linux-arm64-v8a.zip.dgst")}
                ]
            })
        };
        // Old enough, final: taken.
        assert_eq!(
            suitable_release(
                &release("v26.11.2", "2026-11-04T10:00:00Z", false),
                now,
                "Xray-linux-arm64-v8a.zip"
            )
            .map(|found| found.0),
            Some("26.11.2".to_string())
        );
        // Too fresh, or a pre-release: skipped.
        assert!(suitable_release(
            &release("v26.11.7", "2026-11-07T10:00:00Z", false),
            now,
            "Xray-linux-arm64-v8a.zip"
        )
        .is_none());
        assert!(suitable_release(
            &release("v26.11.2", "2026-11-01T10:00:00Z", true),
            now,
            "Xray-linux-arm64-v8a.zip"
        )
        .is_none());
        assert_eq!(
            sha256_from_dgst("MD5= 00\nSHA1= 11\nSHA2-256= 1811C8F1DA0C3B6DC707EBAF1C8390E987BA39859A8F0A7AADD8526157F2EC8D\n"),
            Some("1811c8f1da0c3b6dc707ebaf1c8390e987ba39859a8f0a7aadd8526157f2ec8d".to_string())
        );
        assert_eq!(sha256_from_dgst("SHA2-256= short"), None);
        assert!(version_tuple("26.10.31") < version_tuple("26.11.2"));
        assert!(version_tuple("v26").is_empty());

        let mut facts = HashMap::new();
        facts.insert("xray_version".to_string(), "26.10.31".to_string());
        let mut target = pinned_xray(Arch::Arm64);
        assert!(!binary_outdated(&target, &facts));
        target.version = Some("26.11.2".into());
        assert!(binary_outdated(&target, &facts));
        facts.insert("xray_version".to_string(), String::new());
        assert!(binary_outdated(&pinned_xray(Arch::Arm64), &facts));
        facts.insert(
            "md5_hev-socks5-tunnel".to_string(),
            "7720e92733082f4920c511205bb115da".to_string(),
        );
        assert!(!binary_outdated(&hev_tunnel(Arch::Arm64), &facts));
        assert!(binary_outdated(&hev_tunnel(Arch::Armv7), &facts));
        assert_eq!(Arch::from_uname("aarch64\n"), Some(Arch::Arm64));
        assert_eq!(Arch::from_uname("armv7l"), Some(Arch::Armv7));
        assert_eq!(Arch::from_uname("mips"), None);
        assert!(pinned_xray(Arch::Armv7)
            .url
            .ends_with("Xray-linux-arm32-v7a.zip"));
    }

    #[test]
    #[ignore]
    fn live_latest_xray_release() {
        println!("LIVE {:?}", latest_xray_release(Arch::Armv7));
    }

    #[test]
    fn server_list_keeps_plain_hosts_only() {
        let hosts = vec![
            "germany2.tobevpn.help".to_string(),
            " 149.33.40.130 ".to_string(),
            "germany2.tobevpn.help".to_string(),
            "bad host; rm -rf /".to_string(),
            String::new(),
        ];
        assert_eq!(
            server_list(&hosts),
            "149.33.40.130\ngermany2.tobevpn.help\n"
        );
    }

    #[test]
    fn parses_device_lines() {
        let devices = parse_devices(
            "device=52:e1:c9:b5:1a:c8|192.168.1.107|Pixel-10-Pro|direct|Телефон|1|2\n\
             device=aa:bb:cc:dd:ee:ff|||default||0\nbroken line\nslot=2|nl2|Нидерланды 2\n",
        );
        assert_eq!(devices[0].slot, 2);
        assert_eq!(devices[1].slot, 0);
        assert_eq!(
            parse_slots("slot=0|de2|Германия 2\nslot=9|x|y\nslot=2|nl2|Нидерланды 2\n"),
            vec![
                RouterSlot {
                    slot: 0,
                    server_id: "de2".into(),
                    server_name: "Германия 2".into()
                },
                RouterSlot {
                    slot: 2,
                    server_id: "nl2".into(),
                    server_name: "Нидерланды 2".into()
                },
            ]
        );
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].name.as_deref(), Some("Телефон"));
        assert_eq!(devices[0].mode, "direct");
        assert!(devices[0].online);
        assert_eq!(devices[1].ip, None);
        assert!(!devices[1].online);
    }

    #[test]
    fn quotes_values_for_single_quoted_shell_strings() {
        assert_eq!(shell_quote_inner("a'b"), "a'\\''b");
    }

    #[test]
    fn router_hwid_is_stable_for_a_mac() {
        let a = uuid::Uuid::new_v5(
            &uuid::Uuid::NAMESPACE_OID,
            b"tobevpn-router:8C:AE:DB:31:AE:68",
        );
        let b = uuid::Uuid::new_v5(
            &uuid::Uuid::NAMESPACE_OID,
            b"tobevpn-router:8C:AE:DB:31:AE:68",
        );
        assert_eq!(a, b);
    }

    #[test]
    fn extracts_a_deflated_zip_member() {
        use std::io::Write;
        let payload = b"hello router hello router hello router";
        let mut encoder =
            flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(payload).unwrap();
        let data = encoder.finish().unwrap();
        let name = b"xray";
        let mut zip = Vec::new();
        // Local header (sizes zero, as with a data descriptor), then data.
        zip.extend_from_slice(&[
            0x50, 0x4b, 0x03, 0x04, 20, 0, 8, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0,
        ]);
        zip.extend_from_slice(&(name.len() as u16).to_le_bytes());
        zip.extend_from_slice(&0u16.to_le_bytes());
        zip.extend_from_slice(name);
        zip.extend_from_slice(&data);
        let cd = zip.len();
        zip.extend_from_slice(&[
            0x50, 0x4b, 0x01, 0x02, 20, 0, 20, 0, 8, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ]);
        zip.extend_from_slice(&(data.len() as u32).to_le_bytes());
        zip.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        zip.extend_from_slice(&(name.len() as u16).to_le_bytes());
        // extra, comment, disk, internal and external attributes
        zip.extend_from_slice(&[0; 12]);
        zip.extend_from_slice(&0u32.to_le_bytes());
        zip.extend_from_slice(name);
        let cd_size = zip.len() - cd;
        zip.extend_from_slice(&[0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 1, 0, 1, 0]);
        zip.extend_from_slice(&(cd_size as u32).to_le_bytes());
        zip.extend_from_slice(&(cd as u32).to_le_bytes());
        zip.extend_from_slice(&0u16.to_le_bytes());
        assert_eq!(unzip_member(&zip, "xray").unwrap(), payload);
        assert!(unzip_member(&zip, "other").is_err());
    }
}
