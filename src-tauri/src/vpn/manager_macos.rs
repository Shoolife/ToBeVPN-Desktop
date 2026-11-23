//! VPN on macOS: Xray runs as the user, tun2socks on a utun device and the
//! routes/DNS are set up by a root helper (scripts/tobevpn-helper-macos.sh).
//! The helper is installed once with the administrator password; a sudoers
//! rule then lets this user run exactly that helper without a password, as
//! the polkit policy does on Linux.

use std::collections::BTreeSet;
use std::net::IpAddr;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout, Duration};

use super::config::{self, ServerConfig, SOCKS_PORT, STATS_API_PORT};
use super::state::{PingHostMapping, TrafficStats, VpnState};
use super::{ConnectAttempt, CONNECT_CANCELLED};

macro_rules! diagnostic_macos {
    ($($arg:tt)*) => {{
        crate::diagnostics::record_native("VPN-macOS", &format!($($arg)*));
    }};
}

const TUN_NAME: &str = "utun199";
const HELPER: &str = "/Library/PrivilegedHelperTools/app.tobevpn.helper";
const HELPER_TUN2SOCKS: &str = "/Library/PrivilegedHelperTools/app.tobevpn.tun2socks";
const SUDOERS_FILE: &str = "/etc/sudoers.d/tobevpn";
const HELPER_SH: &str = include_str!("../../../scripts/tobevpn-helper-macos.sh");

/// The administrator password prompt can stay open a while.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(180);
const HELPER_TIMEOUT: Duration = Duration::from_secs(60);
const DNS_RESOLVE_TIMEOUT: Duration = Duration::from_secs(8);
const BYPASS_DNS_RESOLVE_TIMEOUT: Duration = Duration::from_secs(2);
const ROUTE_DETECT_TIMEOUT: Duration = Duration::from_secs(3);
const STATS_QUERY_TIMEOUT: Duration = Duration::from_millis(500);

/// Per-user cache dir (~/Library/Caches/tobevpn), mode 0700: the Xray config
/// holds the subscription's keys.
fn cache_dir() -> PathBuf {
    let base = dirs::cache_dir().unwrap_or_else(std::env::temp_dir);
    let dir = base.join("tobevpn");
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    dir
}

fn write_secure(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .custom_flags(libc::O_NOFOLLOW)
        .mode(0o600)
        .open(path)?;
    f.write_all(contents)?;
    f.sync_all()?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Runs a command with a deadline; a cancelled connect attempt kills it.
async fn run_with_timeout(
    mut cmd: Command,
    timeout_dur: Duration,
    attempt: Option<&ConnectAttempt>,
) -> Result<std::process::Output, String> {
    cmd.kill_on_drop(true);
    let output = cmd.output();
    tokio::pin!(output);
    let deadline = sleep(timeout_dur);
    tokio::pin!(deadline);
    tokio::select! {
        result = &mut output => result.map_err(|e| format!("spawn failed: {e}")),
        _ = &mut deadline => Err(format!("command timed out after {}s", timeout_dur.as_secs())),
        _ = async {
            if let Some(attempt) = attempt {
                attempt.cancelled().await;
            }
        }, if attempt.is_some() => Err(CONNECT_CANCELLED.into()),
    }
}

/// `sudo -n <helper> args…`: passwordless through the installed rule.
fn helper_command(args: &[&str]) -> Command {
    let mut cmd = Command::new("/usr/bin/sudo");
    cmd.arg("-n").arg(HELPER).args(args);
    cmd
}

#[derive(Clone)]
pub struct VpnManager {
    state: Arc<Mutex<VpnState>>,
    xray_process: Arc<Mutex<Option<Child>>>,
    tun2socks_pid: Arc<Mutex<Option<u32>>>,
    session_gen: Arc<Mutex<u64>>,
    bin_dir: PathBuf,
    asset_dir: PathBuf,
    app_handle: Option<tauri::AppHandle>,
}

impl VpnManager {
    pub fn new(bin_dir: PathBuf, asset_dir: PathBuf) -> Self {
        Self {
            state: Arc::new(Mutex::new(VpnState::Disconnected)),
            xray_process: Arc::new(Mutex::new(None)),
            tun2socks_pid: Arc::new(Mutex::new(None)),
            session_gen: Arc::new(Mutex::new(0)),
            bin_dir,
            asset_dir,
            app_handle: None,
        }
    }

    pub fn set_app_handle(&mut self, handle: tauri::AppHandle) {
        self.app_handle = Some(handle);
    }

    pub async fn get_state(&self) -> VpnState {
        self.state.lock().await.clone()
    }

    async fn set_state(&self, state: VpnState) {
        *self.state.lock().await = state;
    }

    /// A tunnel left by a crashed run (its routes would black-hole traffic)
    /// is taken down at start.
    pub async fn cleanup_stale_state(&self) {
        let (bin, config) = (self.resolve_bin("xray"), cache_dir().join("xray.json"));
        let stale = tokio::task::spawn_blocking(move || super::stop_stale_xray(&bin, &config))
            .await
            .unwrap_or(0);
        if stale > 0 {
            diagnostic_macos!("Stopped {stale} VPN core process(es) left by a previous run");
        }
        let tun_up = std::process::Command::new("/sbin/ifconfig")
            .arg(TUN_NAME)
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);
        if !tun_up && !Path::new("/var/run/tobevpn/tun2socks.pid").exists() {
            return;
        }
        eprintln!("[VPN] Detected stale VPN state from previous run — cleaning up");
        self.set_state(VpnState::Disconnecting).await;
        self.force_stop().await;
        self.set_state(VpnState::Disconnected).await;
    }

    pub async fn prepare_ping_bypass(
        &self,
        hosts: Vec<String>,
    ) -> Result<Vec<PingHostMapping>, String> {
        let mapping = Self::resolve_hosts_to_ipv4_pairs(&hosts).await;
        if !matches!(self.get_state().await, VpnState::Connected) {
            return Ok(mapping);
        }
        let ips: BTreeSet<String> = mapping.iter().map(|entry| entry.ip.clone()).collect();
        if ips.is_empty() {
            return Ok(mapping);
        }
        let mut args = vec!["bypass"];
        args.extend(ips.iter().map(String::as_str));
        let output = run_with_timeout(helper_command(&args), HELPER_TIMEOUT, None).await?;
        if output.status.success() {
            Ok(mapping)
        } else {
            Err(format!(
                "direct ping route setup failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }

    /// The physical interface for traffic that must skip the tunnel.
    pub async fn tunnel_bypass_interface(&self) -> Option<String> {
        if !matches!(
            self.get_state().await,
            VpnState::Connected | VpnState::Connecting
        ) {
            return None;
        }
        Self::query_default_interface().await.ok()
    }

    async fn query_default_interface() -> Result<String, String> {
        let mut cmd = Command::new("/sbin/route");
        cmd.args(["-n", "get", "default"]).kill_on_drop(true);
        let output = timeout(ROUTE_DETECT_TIMEOUT, cmd.output())
            .await
            .map_err(|_| "Timed out while detecting the physical network interface".to_string())?
            .map_err(|e| format!("Failed to detect the physical network interface: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        stdout
            .lines()
            .filter_map(|line| line.trim().strip_prefix("interface:"))
            .map(str::trim)
            .find(|name| !name.is_empty() && *name != TUN_NAME)
            .map(str::to_string)
            .ok_or_else(|| "Could not find an active physical network interface".into())
    }

    /// Start full VPN: xray-core → tun2socks → routing.
    pub async fn start(
        &self,
        server: ServerConfig,
        attempt: &ConnectAttempt,
    ) -> Result<(), String> {
        attempt.ensure_active()?;
        let connect_started = Instant::now();
        diagnostic_macos!("VPN start requested; server configuration loaded");

        let prev_state = self.state.lock().await.clone();
        if matches!(&prev_state, VpnState::Disconnecting) {
            return Err("Disconnecting in progress, try again in a moment".into());
        }

        let (server_ip_res, bypass_res) = tokio::join!(
            Self::resolve_server_ip(&server.address, attempt),
            Self::resolve_bypass_ips(&server.bypass_hosts, attempt),
        );
        let server_ip = match server_ip_res {
            Ok(ip) => ip,
            Err(e) => {
                diagnostic_macos!("Endpoint resolution failed: {e}");
                if !matches!(&prev_state, VpnState::Connected) {
                    self.set_state(VpnState::Error { message: e.clone() }).await;
                }
                return Err(e);
            }
        };
        let mut control_bypass_ips = bypass_res?;
        control_bypass_ips.retain(|ip| ip != &server_ip);
        let direct_interface = if server.requires_direct_interface() {
            attempt.ensure_active()?;
            Some(Self::query_default_interface().await?)
        } else {
            None
        };
        attempt.ensure_active()?;

        if matches!(prev_state, VpnState::Connected | VpnState::Connecting) {
            self.force_stop().await;
        }
        if attempt.is_cancelled() {
            self.set_state(VpnState::Disconnected).await;
            return Err(CONNECT_CANCELLED.into());
        }
        self.set_state(VpnState::Connecting).await;

        let mut server = server;
        if server.sni.is_empty() && server.address.parse::<IpAddr>().is_err() {
            server.sni = server.address.clone();
        }
        server.address = server_ip.clone();
        if let Some(interface) = direct_interface {
            server.direct_interface = interface;
        }

        // 1. Xray config in the per-user cache (it holds the subscription keys).
        let config_json = config::build_xray_config(&server);
        let config_path = cache_dir().join("xray.json");
        write_secure(&config_path, config_json.as_bytes())
            .map_err(|e| format!("Failed to write xray config: {e}"))?;

        let asset_dir = &self.asset_dir;
        if server.requires_geosite_assets() && !asset_dir.join("geosite.dat").is_file() {
            let message = format!("Routing database is missing from {}", asset_dir.display());
            self.set_state(VpnState::Error {
                message: message.clone(),
            })
            .await;
            return Err(message);
        }

        // 2. Xray-core as this user.
        let xray_bin = self.resolve_bin("xray");
        let stale = {
            let (bin, config) = (xray_bin.clone(), config_path.clone());
            tokio::task::spawn_blocking(move || super::stop_stale_xray(&bin, &config))
                .await
                .unwrap_or(0)
        };
        if stale > 0 {
            diagnostic_macos!("Stopped {stale} VPN core process(es) left by a previous run");
        }
        let mut xray_child = Command::new(&xray_bin)
            .arg("run")
            .arg("-config")
            .arg(&config_path)
            .env("XRAY_LOCATION_ASSET", asset_dir)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                diagnostic_macos!("Could not start VPN core: {e}");
                format!("Failed to start xray: {e}")
            })?;
        if let Some(stderr) = xray_child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("[xray] {line}");
                }
            });
        }
        *self.xray_process.lock().await = Some(xray_child);

        // 3. Its SOCKS port answers.
        if let Err(e) = wait_for_port(SOCKS_PORT, Duration::from_secs(10), attempt).await {
            self.force_stop().await;
            if attempt.is_cancelled() {
                self.set_state(VpnState::Disconnected).await;
            } else {
                self.set_state(VpnState::Error { message: e.clone() }).await;
            }
            return Err(e);
        }
        {
            let mut proc = self.xray_process.lock().await;
            if let Some(child) = proc.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    *proc = None;
                    drop(proc);
                    self.force_stop().await;
                    let msg = format!("xray exited immediately with {status}");
                    self.set_state(VpnState::Error {
                        message: msg.clone(),
                    })
                    .await;
                    return Err(msg);
                }
            }
        }

        // 4. Tunnel, routes and DNS through the helper.
        let tunnel_setup_started = Instant::now();
        if let Err(e) = self
            .start_tun(&server_ip, &control_bypass_ips, attempt)
            .await
        {
            diagnostic_macos!("TUN and route setup failed: {e}");
            self.force_stop().await;
            if attempt.is_cancelled() {
                self.set_state(VpnState::Disconnected).await;
            } else {
                self.set_state(VpnState::Error { message: e.clone() }).await;
            }
            return Err(e);
        }
        diagnostic_macos!(
            "TUN and routes configured; elapsed_ms={}",
            tunnel_setup_started.elapsed().as_millis()
        );

        if attempt.is_cancelled() {
            self.force_stop().await;
            self.set_state(VpnState::Disconnected).await;
            return Err(CONNECT_CANCELLED.into());
        }
        self.set_state(VpnState::Connected).await;
        diagnostic_macos!(
            "Native state changed to Connected; total_elapsed_ms={}",
            connect_started.elapsed().as_millis()
        );

        let gen = {
            let mut g = self.session_gen.lock().await;
            *g = g.wrapping_add(1);
            *g
        };
        self.spawn_watchdog(gen);
        Ok(())
    }

    /// While connected, a dead Xray or tun2socks turns into an error the UI
    /// shows ("vpn-died"), instead of a green badge over a dead tunnel.
    fn spawn_watchdog(&self, gen: u64) {
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                sleep(Duration::from_secs(3)).await;
                if *manager.session_gen.lock().await != gen
                    || !matches!(*manager.state.lock().await, VpnState::Connected)
                {
                    return;
                }
                let dead = {
                    let mut proc = manager.xray_process.lock().await;
                    let xray_dead = match proc.as_mut() {
                        Some(child) => match child.try_wait() {
                            Ok(Some(status)) => Some(format!("xray exited: {status}")),
                            Ok(None) => None,
                            Err(e) => Some(format!("xray probe failed: {e}")),
                        },
                        None => Some("xray child handle gone".to_string()),
                    };
                    let t2s_dead = match *manager.tun2socks_pid.lock().await {
                        Some(pid) if process_alive(pid) => None,
                        Some(pid) => Some(format!("tun2socks exited: pid {pid}")),
                        None => Some("tun2socks pid missing".to_string()),
                    };
                    xray_dead.or(t2s_dead)
                };
                if let Some(msg) = dead {
                    diagnostic_macos!("Watchdog detected an unexpected process stop: {msg}");
                    manager.force_stop().await;
                    *manager.state.lock().await = VpnState::Error {
                        message: format!("VPN process stopped unexpectedly: {msg}"),
                    };
                    if let Some(handle) = &manager.app_handle {
                        use tauri::Emitter;
                        let _ = handle.emit("vpn-died", &msg);
                    }
                    return;
                }
            }
        });
    }

    pub async fn stop(&self) -> Result<(), String> {
        {
            let mut g = self.session_gen.lock().await;
            *g = g.wrapping_add(1);
        }
        self.set_state(VpnState::Disconnecting).await;
        self.force_stop().await;
        self.set_state(VpnState::Disconnected).await;
        diagnostic_macos!("Native state changed to Disconnected");
        Ok(())
    }

    pub async fn query_stats(&self) -> Option<TrafficStats> {
        let xray_bin = self.resolve_bin("xray");
        let server_addr = format!("127.0.0.1:{}", STATS_API_PORT);
        let up = query_stat_value(
            &xray_bin,
            &server_addr,
            "outbound>>>proxy>>>traffic>>>uplink",
        )
        .await;
        let down = query_stat_value(
            &xray_bin,
            &server_addr,
            "outbound>>>proxy>>>traffic>>>downlink",
        )
        .await;
        Some(TrafficStats {
            uplink: up,
            downlink: down,
        })
    }

    pub async fn xray_version(&self) -> String {
        let output = match timeout(
            Duration::from_secs(2),
            Command::new(self.resolve_bin("xray"))
                .arg("version")
                .output(),
        )
        .await
        {
            Ok(Ok(out)) if out.status.success() => out,
            _ => return "unknown".into(),
        };
        parse_xray_version(&String::from_utf8_lossy(&output.stdout))
    }

    /// The bundled Xray, also used by the server check (server_probe.rs).
    pub fn xray_binary(&self) -> PathBuf {
        self.resolve_bin("xray")
    }

    /// Tauri puts sidecars into Contents/MacOS without the target triple;
    /// a dev build keeps the triple.
    fn resolve_bin(&self, name: &str) -> PathBuf {
        let plain = self.bin_dir.join(name);
        if plain.exists() {
            return plain;
        }
        let triple = if cfg!(target_arch = "aarch64") {
            "aarch64-apple-darwin"
        } else {
            "x86_64-apple-darwin"
        };
        self.bin_dir.join(format!("{name}-{triple}"))
    }

    async fn resolve_server_ip(address: &str, attempt: &ConnectAttempt) -> Result<String, String> {
        match address.parse::<IpAddr>() {
            Ok(IpAddr::V4(_)) => return Ok(address.to_string()),
            Ok(IpAddr::V6(_)) => return Err("No IPv4 address found for server".into()),
            Err(_) => {}
        }
        let addrs = tokio::select! {
            result = lookup_ipv4s(address.to_string(), 0, DNS_RESOLVE_TIMEOUT) => result?,
            _ = attempt.cancelled() => return Err(CONNECT_CANCELLED.into()),
        };
        addrs
            .into_iter()
            .next()
            .ok_or_else(|| "No IPv4 address found for server".into())
    }

    async fn resolve_bypass_ips(
        hosts: &[String],
        attempt: &ConnectAttempt,
    ) -> Result<Vec<String>, String> {
        let mut ips = BTreeSet::new();
        let mut tasks = Vec::new();
        for host in hosts.iter().map(|h| h.trim()).filter(|h| !h.is_empty()) {
            if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
                ips.insert(ip.to_string());
                continue;
            }
            let host = host.to_string();
            tasks.push(tokio::spawn(async move {
                lookup_ipv4s(host, 443, BYPASS_DNS_RESOLVE_TIMEOUT).await
            }));
        }
        for task in tasks {
            let result = tokio::select! {
                result = task => result,
                _ = attempt.cancelled() => return Err(CONNECT_CANCELLED.into()),
            };
            if let Ok(Ok(found)) = result {
                ips.extend(found);
            }
        }
        Ok(ips.into_iter().collect())
    }

    async fn resolve_hosts_to_ipv4_pairs(hosts: &[String]) -> Vec<PingHostMapping> {
        let mut out = Vec::new();
        let mut seen = BTreeSet::new();
        let mut tasks = Vec::new();
        for host in hosts.iter().map(|h| h.trim()).filter(|h| !h.is_empty()) {
            if !seen.insert(host.to_string()) {
                continue;
            }
            if host.parse::<std::net::Ipv4Addr>().is_ok() {
                out.push(PingHostMapping {
                    host: host.to_string(),
                    ip: host.to_string(),
                });
                continue;
            }
            let host = host.to_string();
            tasks.push(tokio::spawn(async move {
                let ip = lookup_ipv4s(host.clone(), 443, BYPASS_DNS_RESOLVE_TIMEOUT)
                    .await
                    .ok()
                    .and_then(|ips| ips.into_iter().next());
                ip.map(|ip| PingHostMapping { host, ip })
            }));
        }
        for task in tasks {
            if let Ok(Some(mapping)) = task.await {
                out.push(mapping);
            }
        }
        out
    }

    /// Whether the installed helper, its tun2socks and the sudoers rule are
    /// this build's.
    fn helper_is_current(&self) -> bool {
        let helper_ok = std::fs::read_to_string(HELPER)
            .map(|installed| installed == HELPER_SH)
            .unwrap_or(false);
        let t2s_ok = match (
            std::fs::read(HELPER_TUN2SOCKS),
            std::fs::read(self.resolve_bin("tun2socks")),
        ) {
            (Ok(installed), Ok(bundled)) => installed == bundled,
            _ => false,
        };
        let sudo_ok = std::process::Command::new("/usr/bin/sudo")
            .args(["-n", "-l", HELPER])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        helper_ok && t2s_ok && sudo_ok
    }

    /// Installs the helper, its tun2socks and the sudoers rule with one
    /// administrator password prompt (osascript).
    async fn ensure_helper_installed(&self, attempt: &ConnectAttempt) -> Result<(), String> {
        if self.helper_is_current() {
            return Ok(());
        }
        let user = std::env::var("USER").unwrap_or_default();
        if user.is_empty()
            || !user
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        {
            return Err("Could not tell the current user for the VPN helper".into());
        }
        let tun2socks = self.resolve_bin("tun2socks");
        if !tun2socks.is_file() {
            return Err(format!("tun2socks is missing: {}", tun2socks.display()));
        }
        let dir = cache_dir();
        let staged_helper = dir.join("helper.sh.staged");
        let staged_sudoers = dir.join("sudoers.staged");
        let install = dir.join("install.sh");
        write_secure(&staged_helper, HELPER_SH.as_bytes())
            .map_err(|e| format!("write staged helper: {e}"))?;
        write_secure(
            &staged_sudoers,
            format!("{user} ALL=(root) NOPASSWD: {HELPER}\n").as_bytes(),
        )
        .map_err(|e| format!("write staged sudoers rule: {e}"))?;
        let script = format!(
            r#"#!/bin/bash
set -e
/usr/sbin/visudo -cf {sudoers}
mkdir -p /Library/PrivilegedHelperTools
install -o root -g wheel -m 755 {helper} {helper_path}
install -o root -g wheel -m 755 {t2s} {t2s_path}
install -o root -g wheel -m 440 {sudoers} {sudoers_path}
echo INSTALLED
"#,
            sudoers = shell_escape(&staged_sudoers.display().to_string()),
            helper = shell_escape(&staged_helper.display().to_string()),
            helper_path = HELPER,
            t2s = shell_escape(&tun2socks.display().to_string()),
            t2s_path = HELPER_TUN2SOCKS,
            sudoers_path = SUDOERS_FILE,
        );
        write_secure(&install, script.as_bytes()).map_err(|e| format!("write installer: {e}"))?;

        let apple_script = format!(
            "do shell script \"/bin/bash \" & quoted form of \"{}\" with administrator privileges with prompt \"ToBeVPN needs to install its network helper once.\"",
            install.display().to_string().replace('\\', "\\\\").replace('"', "\\\"")
        );
        let mut cmd = Command::new("/usr/bin/osascript");
        cmd.arg("-e").arg(apple_script);
        let output = run_with_timeout(cmd, INSTALL_TIMEOUT, Some(attempt)).await;
        let _ = std::fs::remove_file(&install);
        let _ = std::fs::remove_file(&staged_helper);
        let _ = std::fs::remove_file(&staged_sudoers);
        let output = output?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // -128: the user cancelled the password prompt.
            if stderr.contains("-128") {
                return Err("The administrator password is needed to connect".into());
            }
            return Err(format!("VPN helper install failed: {}", stderr.trim()));
        }
        diagnostic_macos!("Network helper installed");
        if self.helper_is_current() {
            Ok(())
        } else {
            Err("VPN helper was installed but does not answer".into())
        }
    }

    async fn start_tun(
        &self,
        server_ip: &str,
        control_bypass_ips: &[String],
        attempt: &ConnectAttempt,
    ) -> Result<(), String> {
        self.ensure_helper_installed(attempt).await?;
        attempt.ensure_active()?;
        let mut args = vec!["start", server_ip];
        args.extend(control_bypass_ips.iter().map(String::as_str));
        let output = run_with_timeout(helper_command(&args), HELPER_TIMEOUT, Some(attempt)).await?;
        attempt.ensure_active()?;
        if !output.status.success() {
            return Err(format!(
                "TUN setup failed ({}): {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let pid = stdout
            .lines()
            .find_map(|line| line.strip_prefix("OK "))
            .and_then(|pid| pid.trim().parse::<u32>().ok())
            .ok_or_else(|| "TUN helper did not return tun2socks PID".to_string())?;
        *self.tun2socks_pid.lock().await = Some(pid);
        Ok(())
    }

    /// Takes the tunnel, routes and DNS down and stops Xray.
    async fn force_stop(&self) {
        self.tun2socks_pid.lock().await.take();
        if Path::new(HELPER).exists() {
            match run_with_timeout(helper_command(&["stop"]), HELPER_TIMEOUT, None).await {
                Ok(out) if out.status.success() => {}
                Ok(out) => diagnostic_macos!(
                    "Helper cleanup failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ),
                Err(e) => diagnostic_macos!("Helper cleanup failed: {e}"),
            }
        }
        if let Some(mut child) = self.xray_process.lock().await.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        let _ = std::fs::remove_file(cache_dir().join("xray.json"));
    }
}

async fn lookup_ipv4s(
    host: String,
    port: u16,
    timeout_dur: Duration,
) -> Result<Vec<String>, String> {
    let addrs = timeout(
        timeout_dur,
        tokio::net::lookup_host(format!("{host}:{port}")),
    )
    .await
    .map_err(|_| "DNS resolve timed out".to_string())?
    .map_err(|e| format!("DNS resolve failed: {e}"))?;
    Ok(addrs
        .filter(|addr| addr.is_ipv4())
        .map(|addr| addr.ip().to_string())
        .collect())
}

/// tun2socks runs as root: signal 0 then answers EPERM, which still means
/// the process is there.
fn process_alive(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

async fn wait_for_port(port: u16, limit: Duration, attempt: &ConnectAttempt) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        attempt.ensure_active()?;
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "xray did not start within {}s (port {} not open)",
                limit.as_secs(),
                port
            ));
        }
        if tokio::net::TcpStream::connect(format!("127.0.0.1:{port}"))
            .await
            .is_ok()
        {
            return Ok(());
        }
        sleep(Duration::from_millis(200)).await;
    }
}

async fn query_stat_value(xray_bin: &PathBuf, server: &str, name: &str) -> u64 {
    let mut command = Command::new(xray_bin);
    command
        .args([
            "api",
            "statsquery",
            "-s",
            server,
            "-pattern",
            name,
            "-reset",
        ])
        .kill_on_drop(true);
    match timeout(STATS_QUERY_TIMEOUT, command.output()).await {
        Ok(Ok(out)) if out.status.success() => {
            parse_stat_value(&String::from_utf8_lossy(&out.stdout)).unwrap_or(0)
        }
        _ => 0,
    }
}

fn parse_stat_value(text: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        let trimmed = line.trim().trim_start_matches(',').trim();
        let rest = trimmed
            .strip_prefix("\"value\":")
            .or_else(|| trimmed.strip_prefix("value:"))?;
        rest.trim()
            .trim_matches('"')
            .trim_matches(',')
            .trim()
            .trim_matches('"')
            .parse::<u64>()
            .ok()
    })
}

fn parse_xray_version(text: &str) -> String {
    let first_line = text.lines().next().unwrap_or("").trim();
    let mut parts = first_line.split_whitespace();
    match (parts.next(), parts.next()) {
        (Some("Xray"), Some(version)) => format!("Xray-core v{version}"),
        _ if !first_line.is_empty() => first_line.to_string(),
        _ => "unknown".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::parse_stat_value;

    #[test]
    fn parses_unsigned_xray_counters_without_accepting_negative_values() {
        assert_eq!(
            parse_stat_value("value: 18446744073709551615"),
            Some(u64::MAX)
        );
        assert_eq!(parse_stat_value("\"value\": \"42\","), Some(42));
        assert_eq!(parse_stat_value("value: -1"), None);
    }
}
