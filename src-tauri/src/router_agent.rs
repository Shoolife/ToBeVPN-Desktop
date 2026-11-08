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
const HEV_CONFIG: &str =
    "tunnel:\n  name: tobe0\n  mtu: 1500\n  multi-queue: false\n  ipv4: 198.18.0.1\n\
socks5:\n  port: 10808\n  address: 127.0.0.1\n  udp: udp\nmisc:\n  log-level: warn\n";
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

/// A pinned release asset for the router (aarch64), verified by SHA-256.
struct Binary {
    name: &'static str,
    url: &'static str,
    /// Digest of the downloaded file (the zip for Xray).
    download_sha256: &'static str,
    /// Member to extract from a zip download; None for a plain binary.
    zip_member: Option<&'static str>,
    /// Digest of the binary installed on the router.
    sha256: &'static str,
}

const BINARIES: &[Binary] = &[
    Binary {
        name: "xray",
        url: "https://github.com/XTLS/Xray-core/releases/download/v26.10.31/Xray-linux-arm64-v8a.zip",
        download_sha256: "1811c8f1da0c3b6dc707ebaf1c8390e987ba39859a8f0a7aadd8526157f2ec8d",
        zip_member: Some("xray"),
        sha256: "5939649960deaf535bcd5f7ce0467a2b1d63b72a2758a6f42eade714ae8d5328",
    },
    Binary {
        name: "hev-socks5-tunnel",
        url: "https://github.com/heiher/hev-socks5-tunnel/releases/download/2.19.2/hev-socks5-tunnel-linux-arm64",
        download_sha256: "3a7e5e6fc21ce507d6106cefcdb101d43e43f04e7aac20f892edbd2d1264110d",
        zip_member: None,
        sha256: "3a7e5e6fc21ce507d6106cefcdb101d43e43f04e7aac20f892edbd2d1264110d",
    },
];

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
    /// The watchdog removed the routing after the core failed to restart.
    pub failed: bool,
    /// Routes that keep ToBeVPN servers outside the tunnel.
    pub server_bypass_rules: u64,
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
    let (mut session, fingerprint) = connect(&app, &host, true).await?;
    let auth = session
        .handle
        .authenticate_password(&user, password)
        .await
        .map_err(|error| format!("ssh auth: {error}"))?;
    if !auth.success() {
        return Err("wrong router login or password".into());
    }
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
}

/// Installs (or updates) ToBeVPN on the paired router and starts it.
#[tauri::command]
pub async fn router_install(
    app: AppHandle,
    host: String,
    user: String,
    server: ServerConfig,
    server_hosts: Vec<String>,
    subscription_url: String,
    autostart: bool,
) -> Result<RouterStatus, String> {
    progress(&app, "connect");
    let session = open(&app, &host, &user).await?;

    progress(&app, "check");
    let facts = parse_key_values(
        &session
            .run_ok(
                "echo arch=$(uname -m); echo free_kb=$(df -k /overlay 2>/dev/null | awk 'NR==2{print $4}'); \
                 echo tun=$([ -c /dev/net/tun ] || grep -qw tun /proc/modules && echo 1 || echo 0); \
                 echo opkg=$(command -v opkg >/dev/null && echo 1 || echo 0); \
                 echo installed_sha=$(cat /opt/tobevpn/VERSIONS 2>/dev/null | tr '\\n' ' '); \
                 echo mac=$(cat /sys/class/net/br-lan/address 2>/dev/null); \
                 echo client=${SSH_CLIENT%% *}; \
                 . /etc/openwrt_release 2>/dev/null; echo os=\"$DISTRIB_RELEASE\"; \
                 echo model=$(cat /tmp/sysinfo/model 2>/dev/null | tr ' ' '-')",
                None,
            )
            .await?,
    );
    if facts.get("arch").map(String::as_str) != Some("aarch64") {
        return Err(format!(
            "unsupported router CPU: {}",
            facts.get("arch").cloned().unwrap_or_default()
        ));
    }
    let pinned = BINARIES
        .iter()
        .map(|binary| binary.sha256)
        .collect::<Vec<_>>()
        .join(" ");
    let binaries_current =
        facts.get("installed_sha").map(|value| value.trim()) == Some(pinned.as_str());
    if !binaries_current {
        let free_kb: u64 = facts
            .get("free_kb")
            .and_then(|value| value.parse().ok())
            .unwrap_or(0);
        if free_kb < REQUIRED_FREE_KB {
            return Err(format!(
                "not enough space on the router: {} MB free",
                free_kb / 1024
            ));
        }
    }

    // An earlier run may be active; it is restarted with the new files.
    session
        .run(
            "[ -x /opt/tobevpn/tobevpn-router.sh ] && /opt/tobevpn/tobevpn-router.sh stop",
            None,
        )
        .await?;

    if facts.get("tun").map(String::as_str) != Some("1") {
        progress(&app, "tun");
        if facts.get("opkg").map(String::as_str) != Some("1") {
            return Err("the router has no TUN support and no package manager".into());
        }
        session
            .run_ok(
                "opkg update >/tmp/tobevpn-opkg.log 2>&1; opkg install kmod-tun >>/tmp/tobevpn-opkg.log 2>&1; \
                 modprobe tun 2>/dev/null; [ -c /dev/net/tun ] || grep -qw tun /proc/modules || { tail -5 /tmp/tobevpn-opkg.log; exit 1; }",
                None,
            )
            .await?;
    }

    session.run_ok("mkdir -p /opt/tobevpn", None).await?;
    if !binaries_current {
        for binary in BINARIES {
            progress(&app, &format!("download:{}", binary.name));
            let content = fetch_binary(&app, binary).await?;
            progress(&app, &format!("upload:{}", binary.name));
            session
                .write_file(&format!("/opt/tobevpn/{}", binary.name), &content, "755")
                .await?;
        }
        session
            .write_file(
                "/opt/tobevpn/VERSIONS",
                format!("{}\n", pinned.replace(' ', "\n")).as_bytes(),
                "644",
            )
            .await?;
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
    session
        .write_file(
            "/opt/tobevpn/xray.json",
            router_xray_config(&server).as_bytes(),
            "600",
        )
        .await?;
    session
        .write_file("/opt/tobevpn/hev.yml", HEV_CONFIG.as_bytes(), "600")
        .await?;
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
    // Every home device goes through the VPN; one with its own ToBeVPN on
    // reaches the servers directly (see "servers"). A choice made earlier
    // is kept when reinstalling.
    session
        .run_ok(
            "[ -s /opt/tobevpn/default_mode ] || echo vpn > /opt/tobevpn/default_mode; \
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

    progress(&app, "start");
    session
        .run_ok("/opt/tobevpn/tobevpn-router.sh start", None)
        .await?;
    let status = session
        .run_ok("/opt/tobevpn/tobevpn-router.sh status", None)
        .await?;
    progress(&app, "done");
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
            "/opt/tobevpn/tobevpn-router.sh uninstall; opkg remove kmod-tun >/dev/null 2>&1; true"
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
}

/// Devices of the home network, with their VPN choice.
#[tauri::command]
pub async fn router_devices(
    app: AppHandle,
    host: String,
    user: String,
) -> Result<Vec<RouterDevice>, String> {
    let session = open(&app, &host, &user).await?;
    let output = session
        .run_ok("/opt/tobevpn/tobevpn-router.sh devices", None)
        .await?;
    Ok(parse_devices(&output))
}

/// Sets one device to "vpn", "direct" or back to "default", with a name.
#[tauri::command]
pub async fn router_set_device(
    app: AppHandle,
    host: String,
    user: String,
    mac: String,
    mode: String,
    name: String,
) -> Result<(), String> {
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
                "/opt/tobevpn/tobevpn-router.sh set-device '{mac}' '{mode}' '{}'",
                shell_quote_inner(name.trim())
            ),
            None,
        )
        .await
        .map(|_| ())
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

fn parse_devices(text: &str) -> Vec<RouterDevice> {
    let mut devices: Vec<RouterDevice> = text
        .lines()
        .filter_map(|line| line.strip_prefix("device="))
        .filter_map(|line| {
            let fields: Vec<&str> = line.split('|').collect();
            let [mac, ip, hostname, mode, name, online] = fields.as_slice() else {
                return None;
            };
            let present = |value: &&str| (!value.is_empty()).then(|| value.to_string());
            Some(RouterDevice {
                mac: mac.to_string(),
                ip: present(ip),
                hostname: present(hostname),
                mode: mode.to_string(),
                name: present(name),
                online: *online == "1",
            })
        })
        .collect();
    devices.sort_by(|a, b| b.online.cmp(&a.online).then_with(|| a.ip.cmp(&b.ip)));
    devices
}

/// Switches the router to another server and restarts the tunnel.
#[tauri::command]
pub async fn router_set_server(
    app: AppHandle,
    host: String,
    user: String,
    server: ServerConfig,
    server_hosts: Vec<String>,
) -> Result<RouterStatus, String> {
    let session = open(&app, &host, &user).await?;
    session
        .write_file(
            "/opt/tobevpn/servers",
            server_list(&server_hosts).as_bytes(),
            "644",
        )
        .await?;
    session
        .write_file(
            "/opt/tobevpn/xray.json",
            router_xray_config(&server).as_bytes(),
            "600",
        )
        .await?;
    session
        .run_ok("/opt/tobevpn/tobevpn-router.sh restart", None)
        .await?;
    let (output, _) = session
        .run("/opt/tobevpn/tobevpn-router.sh status", None)
        .await?;
    Ok(parse_status(&output))
}

// ------------------------------------------------------------- helpers ---

fn router_xray_config(server: &ServerConfig) -> String {
    let config = json!({
        "log": { "loglevel": "warning" },
        "inbounds": [{
            "tag": "socks",
            "listen": "127.0.0.1",
            "port": 10808,
            "protocol": "socks",
            "settings": { "auth": "noauth", "udp": true }
        }],
        "outbounds": [
            build_proxy_outbound(server, "proxy"),
            { "tag": "direct", "protocol": "freedom" },
            { "tag": "block", "protocol": "blackhole" }
        ],
        "routing": {
            "domainStrategy": "AsIs",
            "rules": [{ "type": "field", "ip": PRIVATE_RANGES, "outboundTag": "direct" }]
        },
        "xudp": { "baseKey": server.uuid }
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
        server_bypass_rules: number("bypass_rules").unwrap_or(0),
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
    let cached = cache.join(format!("{}-{}", binary.name, &binary.sha256[..16]));
    if let Ok(content) = std::fs::read(&cached) {
        if sha256_hex(&content) == binary.sha256 {
            return Ok(content);
        }
    }
    let url = binary.url.to_string();
    let downloaded = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let response = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(300))
            .build()
            .map_err(|error| format!("http client: {error}"))?
            .get(&url)
            .send()
            .and_then(|response| response.error_for_status())
            .map_err(|error| format!("download {url}: {error}"))?;
        response
            .bytes()
            .map(|bytes| bytes.to_vec())
            .map_err(|error| format!("download {url}: {error}"))
    })
    .await
    .map_err(|error| format!("download task: {error}"))??;
    if sha256_hex(&downloaded) != binary.download_sha256 {
        return Err(format!("{}: download checksum mismatch", binary.name));
    }
    let content = match binary.zip_member {
        Some(member) => unzip_member(&downloaded, member)?,
        None => downloaded,
    };
    if sha256_hex(&content) != binary.sha256 {
        return Err(format!("{}: checksum mismatch", binary.name));
    }
    let _ = std::fs::write(&cached, &content);
    Ok(content)
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
             subscription_userinfo=upload=0; download=68544880231; total=268435456000; expire=1813168827\n",
        );
        assert!(status.installed && status.running && !status.autostart);
        assert_eq!(status.xray_memory_kb, Some(33600));
        assert_eq!(status.default_mode, "vpn");
        assert_eq!(status.client_ip.as_deref(), Some("192.168.1.183"));
        assert_eq!(status.subscription_used_bytes, Some(68544880231));
        assert_eq!(status.subscription_total_bytes, Some(268435456000));
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
            "device=52:e1:c9:b5:1a:c8|192.168.1.107|Pixel-10-Pro|direct|Телефон|1\n\
             device=aa:bb:cc:dd:ee:ff|||default||0\nbroken line\n",
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
