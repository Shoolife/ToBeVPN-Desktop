use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout, Duration};

use super::config::{self, ServerConfig, SOCKS_PORT, STATS_API_PORT};
use super::state::{TrafficStats, VpnState};
use super::{ConnectAttempt, CONNECT_CANCELLED};

// ── TUN / routing constants (Linux) ───────────────────────────────
const TUN_NAME: &str = "tobe0";
const TUN_ADDR: &str = "198.18.0.1/15";
const TUN_ADDR6: &str = "fd66:6f62:6576:706e::1/64";
const TUN_PUBLIC_V6_PREFIX: &str = "2000::/3";
const TUN_TABLE: &str = "100";
const FWMARK: &str = "0x1";

// Hard ceiling on every pkexec invocation. Without this a wedged polkit agent
// or a user dismissing the prompt by ignoring it can pin the UI in
// "Connecting" indefinitely.
const PKEXEC_TIMEOUT: Duration = Duration::from_secs(60);
const DNS_RESOLVE_TIMEOUT: Duration = Duration::from_secs(8);

// Path of the installed polkit helper. When present, pkexec invocations match
// the app.tobevpn.network policy and run without repeated password prompts.
const POLKIT_HELPER: &str = "/usr/local/bin/tobevpn-helper.sh";
const POLKIT_POLICY: &str = "/usr/share/polkit-1/actions/app.tobevpn.network.policy";
const UPDATE_HELPER: &str = "/usr/local/bin/tobevpn-update-helper.sh";
const UPDATE_POLICY: &str = "/usr/share/polkit-1/actions/app.tobevpn.update.policy";

// Embedded resources — installed lazily on first VPN connect via a single pkexec
// prompt. After that, the helpers handle start/stop and signed updates.
const HELPER_SH: &str = include_str!("../../../scripts/tobevpn-helper.sh");
const POLICY_XML: &str = include_str!("../../../scripts/app.tobevpn.network.policy");
const UPDATE_HELPER_SH: &str = include_str!("../../../scripts/tobevpn-update-helper.sh");
const UPDATE_POLICY_XML: &str = include_str!("../../../scripts/app.tobevpn.update.policy");

// ── Secure-temp helpers ───────────────────────────────────────────
//
// SECURITY: never put privileged-execution payloads in /tmp on Linux. /tmp is
// world-writable (sticky) which exposes a TOCTOU window between writing a
// staged script and pkexec actually reading it — local attackers can race and
// substitute their own contents, getting root via our policy. We use a
// per-user dir under ~/.cache/tobevpn (mode 0700) for every file the helper
// or pkexec ever touches, and write each file with mode 0600.

/// Per-user cache dir, created with mode 0700.
fn cache_dir() -> PathBuf {
    let base = dirs::cache_dir().unwrap_or_else(std::env::temp_dir);
    let dir = base.join("tobevpn");
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
    if let Ok(meta) = std::fs::metadata(&dir) {
        let mode = meta.permissions().mode() & 0o777;
        if mode != 0o700 {
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
    }
    dir
}

/// Write `contents` to `path` with mode 0600, replacing any existing file
/// atomically. Uses O_CREAT|O_TRUNC|O_NOFOLLOW so a malicious symlink in our
/// own cache dir can't redirect the write — the dir is 0700 already, but
/// belt-and-braces.
fn write_secure(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // O_NOFOLLOW (libc::O_NOFOLLOW = 0x20000 on Linux) — refuse if the path
    // is a symlink. We still set permissions explicitly afterwards in case
    // umask munged the mode bit on the open() call.
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

/// Single-quote a path for safe inclusion in a generated shell script. We
/// only need this for paths under ~/.cache/tobevpn that we control, but be
/// defensive — single quotes inside paths are escaped via the standard
/// '\'' trick.
fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Run a Command with a hard timeout and the GUI/dbus env passed through so
/// pkexec can locate the active polkit agent.
async fn run_with_timeout_and_env(
    mut cmd: Command,
    timeout_dur: Duration,
    attempt: Option<&ConnectAttempt>,
) -> Result<std::process::Output, String> {
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
    // Dropping an output future normally leaves the spawned child running.
    // For a cancelled/expired privileged start that can later install routes
    // after the UI already says it is off, so require drop to kill the child.
    cmd.kill_on_drop(true);
    let output = cmd.output();
    tokio::pin!(output);
    let deadline = sleep(timeout_dur);
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            result = &mut output => {
                return result.map_err(|e| format!("spawn failed: {e}"));
            }
            _ = &mut deadline => {
                return Err(format!(
                    "command timed out after {}s (polkit agent unresponsive?)",
                    timeout_dur.as_secs()
                ));
            }
            _ = async {
                if let Some(attempt) = attempt {
                    attempt.cancelled().await;
                }
            }, if attempt.is_some() => {
                return Err(CONNECT_CANCELLED.into());
            }
        }
    }
}

// ── VPN Manager ───────────────────────────────────────────────────
pub struct VpnManager {
    state: Arc<Mutex<VpnState>>,
    xray_process: Arc<Mutex<Option<Child>>>,
    tun2socks_pid: Arc<Mutex<Option<u32>>>,
    stats_running: Arc<Mutex<bool>>,
    /// Bumps every time `start()` enters Connected. Watchdog tasks compare
    /// against the snapshot they captured at spawn time and exit when the
    /// generation changes — guarantees that an old watchdog from a previous
    /// session can't fire `disconnect-due-to-crash` against the new one.
    session_gen: Arc<Mutex<u64>>,
    bin_dir: PathBuf,
    app_handle: Option<tauri::AppHandle>,
}

impl VpnManager {
    pub fn new(bin_dir: PathBuf) -> Self {
        Self {
            state: Arc::new(Mutex::new(VpnState::Disconnected)),
            xray_process: Arc::new(Mutex::new(None)),
            tun2socks_pid: Arc::new(Mutex::new(None)),
            stats_running: Arc::new(Mutex::new(false)),
            session_gen: Arc::new(Mutex::new(0)),
            bin_dir,
            app_handle: None,
        }
    }

    /// Wire the AppHandle so the watchdog can emit "vpn-died" events when
    /// xray or tun2socks exits unexpectedly.
    pub fn set_app_handle(&mut self, handle: tauri::AppHandle) {
        self.app_handle = Some(handle);
    }

    pub async fn get_state(&self) -> VpnState {
        self.state.lock().await.clone()
    }

    /// Detect and clean up stale VPN artefacts left behind by a previous
    /// unclean shutdown (crash, SIGKILL, dev HMR restart). Without this the
    /// system would keep ip rules + routes pointing at a phantom TUN, breaking
    /// all internet traffic until a manual cleanup.
    ///
    /// All probes are non-privileged. The actual cleanup runs through the
    /// polkit helper (passwordless) when leftover state is detected.
    pub async fn cleanup_stale_state(&self) {
        if !Self::has_stale_artefacts() {
            return;
        }
        eprintln!("[VPN] Detected stale VPN state from previous run — cleaning up");

        // Reset internal state so the cleanup proceeds even though we never
        // started anything in this process.
        self.set_state(VpnState::Disconnecting).await;
        self.force_stop().await;
        self.set_state(VpnState::Disconnected).await;
        eprintln!("[VPN] Stale state cleanup complete");
    }

    /// Probe for leftover VPN artefacts using non-privileged commands.
    fn has_stale_artefacts() -> bool {
        // The helper writes the tun2socks PID file under /tmp because it runs
        // as root and needs a path both the helper (root) and our app (user)
        // can read across reboots; that path is fine because the *contents*
        // there are advisory only, never used as input to a privileged
        // operation. We just probe its existence.
        if Path::new("/tmp/tobevpn_tun2socks.pid").exists() {
            return true;
        }
        if let Ok(out) = std::process::Command::new("ip")
            .args(["link", "show", TUN_NAME])
            .output()
        {
            if out.status.success() {
                return true;
            }
        }
        if let Ok(out) = std::process::Command::new("ip")
            .args(["rule", "list"])
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout);
            if s.contains(&format!("lookup {}", TUN_TABLE)) {
                return true;
            }
        }
        false
    }

    /// Start full VPN: xray-core → tun2socks → routing.
    pub async fn start(
        &self,
        server: ServerConfig,
        attempt: &ConnectAttempt,
    ) -> Result<(), String> {
        attempt.ensure_active()?;
        eprintln!("══════════════════════════════════════════════════");
        eprintln!("[VPN] START called");
        eprintln!("[VPN] Server configuration loaded");

        // If a previous session is still active or stuck in Connecting,
        // tear it down first so server-switching works seamlessly (matches phone).
        let prev_state = self.state.lock().await.clone();
        eprintln!("[VPN] Current state: {:?}", prev_state);
        match prev_state {
            VpnState::Connected => {
                eprintln!("[VPN] Previous session active — stopping before reconnect");
                self.force_stop().await;
            }
            VpnState::Connecting => {
                eprintln!("[VPN] Previous attempt stuck in Connecting — running cleanup");
                self.force_stop().await;
            }
            VpnState::Disconnecting => {
                eprintln!("[VPN] ERROR: previous Disconnecting in progress, aborting");
                return Err("Disconnecting in progress, try again in a moment".into());
            }
            _ => {}
        }

        attempt.ensure_active()?;
        self.set_state(VpnState::Connecting).await;
        eprintln!("[VPN] State -> Connecting");

        // Pre-resolve server domain to IPv4 BEFORE TUN goes up, so xray never
        // has to do DNS through its own tunnel (which would loop via TUN).
        let server_ip = match Self::resolve_server_ip(&server.address, attempt).await {
            Ok(ip) => ip,
            Err(e) => {
                eprintln!("[VPN] ERROR: pre-resolve failed: {e}");
                self.set_state(VpnState::Error { message: e.clone() }).await;
                return Err(e);
            }
        };
        eprintln!("[VPN] Server address resolved");
        if attempt.is_cancelled() {
            self.set_state(VpnState::Disconnected).await;
            return Err(CONNECT_CANCELLED.into());
        }

        // Rewrite address to IP. SNI (server.sni) keeps the domain for Reality/TLS.
        let mut server = server;
        if server.sni.is_empty() && server.address.parse::<std::net::IpAddr>().is_err() {
            server.sni = server.address.clone();
            eprintln!("[VPN] Filled missing SNI from server address");
        }
        server.address = server_ip.clone();

        // 1. Write xray config to per-user cache dir (mode 0600).
        // Contains the user's UUID and reality keys — under no circumstances
        // should it land in /tmp where any local user could read it and clone
        // the subscription.
        let config_json = config::build_xray_config(&server);
        let config_path = cache_dir().join("xray.json");
        eprintln!("[VPN] Writing xray config ({} bytes)", config_json.len());
        write_secure(&config_path, config_json.as_bytes())
            .map_err(|e| format!("Failed to write xray config: {e}"))?;
        eprintln!("[VPN] Config written OK (mode 0600)");
        if attempt.is_cancelled() {
            self.set_state(VpnState::Disconnected).await;
            return Err(CONNECT_CANCELLED.into());
        }

        // xray needs geoip.dat/geosite.dat
        let asset_dir = {
            let beside = self.bin_dir.join("geoip.dat");
            if beside.exists() {
                self.bin_dir.clone()
            } else {
                let sub = self.bin_dir.join("bin");
                if sub.join("geoip.dat").exists() {
                    sub
                } else {
                    self.bin_dir.clone()
                }
            }
        };
        eprintln!(
            "[VPN] Asset dir: {:?} (geoip.dat exists: {})",
            asset_dir,
            asset_dir.join("geoip.dat").exists()
        );

        // 2. Start xray-core
        let xray_bin = self.resolve_bin("xray");
        eprintln!(
            "[VPN] xray binary: {:?} (exists: {})",
            xray_bin,
            xray_bin.exists()
        );

        let mut xray_child = Command::new(&xray_bin)
            .arg("run")
            .arg("-config")
            .arg(&config_path)
            .env("XRAY_LOCATION_ASSET", &asset_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                eprintln!("[VPN] ERROR: Failed to spawn xray: {e}");
                format!("Failed to start xray: {e}")
            })?;

        let xray_pid = xray_child.id();
        eprintln!("[VPN] xray spawned OK, PID: {:?}", xray_pid);

        // Spawn stderr reader for logging
        if let Some(stderr) = xray_child.stderr.take() {
            tokio::spawn(async move {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                while let Ok(Some(_line)) = lines.next_line().await {
                    eprintln!("[xray] diagnostic output received");
                }
            });
        }

        *self.xray_process.lock().await = Some(xray_child);
        if attempt.is_cancelled() {
            self.force_stop().await;
            self.set_state(VpnState::Disconnected).await;
            return Err(CONNECT_CANCELLED.into());
        }

        // 3. Wait for SOCKS port to be ready
        eprintln!("[VPN] Waiting for SOCKS port {} ...", SOCKS_PORT);
        if let Err(e) = wait_for_port(SOCKS_PORT, Duration::from_secs(10), attempt).await {
            eprintln!("[VPN] ERROR: SOCKS port not ready: {e}");
            self.force_stop().await;
            if attempt.is_cancelled() {
                self.set_state(VpnState::Disconnected).await;
            } else {
                self.set_state(VpnState::Error { message: e.clone() }).await;
            }
            return Err(e);
        }
        eprintln!("[VPN] SOCKS port {} is open", SOCKS_PORT);

        // Verify xray is still alive
        {
            let mut proc = self.xray_process.lock().await;
            if let Some(ref mut child) = *proc {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        eprintln!("[VPN] ERROR: xray already exited with {status}");
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
                    Ok(None) => {
                        eprintln!("[VPN] xray is alive (still running)");
                    }
                    Err(e) => {
                        eprintln!("[VPN] ERROR: xray process check failed: {e}");
                        *proc = None;
                        drop(proc);
                        self.force_stop().await;
                        let msg = format!("xray process check failed: {e}");
                        self.set_state(VpnState::Error {
                            message: msg.clone(),
                        })
                        .await;
                        return Err(msg);
                    }
                }
            }
        }

        // 4. Start tun2socks + routing via pkexec helper
        eprintln!("[VPN] Starting TUN setup (pkexec) ...");
        if let Err(e) = self.start_tun(&server, attempt).await {
            eprintln!("[VPN] ERROR: TUN setup failed: {e}");
            self.force_stop().await;
            if attempt.is_cancelled() {
                self.set_state(VpnState::Disconnected).await;
            } else {
                self.set_state(VpnState::Error { message: e.clone() }).await;
            }
            return Err(e);
        }
        eprintln!("[VPN] TUN setup OK");

        if attempt.is_cancelled() {
            self.force_stop().await;
            self.set_state(VpnState::Disconnected).await;
            return Err(CONNECT_CANCELLED.into());
        }
        self.set_state(VpnState::Connected).await;
        eprintln!("[VPN] State -> Connected");

        // Bump the session generation and spawn a watchdog so the UI doesn't
        // keep showing "Connected" if xray dies (OOM, killed, crashed). The
        // watchdog is bounded by the generation snapshot — once a new
        // start()/stop() cycle bumps gen, this watchdog exits without firing.
        let gen = {
            let mut g = self.session_gen.lock().await;
            *g = g.wrapping_add(1);
            *g
        };
        self.spawn_xray_watchdog(gen).await;

        eprintln!("══════════════════════════════════════════════════");
        Ok(())
    }

    /// Periodically polls the xray child. If it exits unexpectedly while the
    /// session is still supposed to be Connected, transitions to Error and
    /// emits a "vpn-died" event so the frontend can prompt the user to
    /// reconnect — without this, the UI would show a green "Connected" badge
    /// over a tunnel that quietly stopped forwarding traffic.
    async fn spawn_xray_watchdog(&self, gen: u64) {
        let xray_proc = self.xray_process.clone();
        let state = self.state.clone();
        let session_gen = self.session_gen.clone();
        let app = self.app_handle.clone();
        let manager_clone = VpnManager {
            state: self.state.clone(),
            xray_process: self.xray_process.clone(),
            tun2socks_pid: self.tun2socks_pid.clone(),
            stats_running: self.stats_running.clone(),
            session_gen: self.session_gen.clone(),
            bin_dir: self.bin_dir.clone(),
            app_handle: self.app_handle.clone(),
        };
        tauri::async_runtime::spawn(async move {
            loop {
                sleep(Duration::from_secs(3)).await;
                if *session_gen.lock().await != gen {
                    return;
                }
                if !matches!(*state.lock().await, VpnState::Connected) {
                    return;
                }
                let dead = {
                    let mut p = xray_proc.lock().await;
                    match p.as_mut() {
                        Some(child) => match child.try_wait() {
                            Ok(Some(status)) => Some(format!("xray exited: {status}")),
                            Ok(None) => None,
                            Err(e) => Some(format!("xray probe failed: {e}")),
                        },
                        None => Some("xray child handle gone".to_string()),
                    }
                };
                if let Some(msg) = dead {
                    eprintln!("[VPN-WATCHDOG] {msg} — running force_stop");
                    manager_clone.force_stop().await;
                    *state.lock().await = VpnState::Error {
                        message: format!("VPN process stopped unexpectedly: {msg}"),
                    };
                    if let Some(h) = &app {
                        use tauri::Emitter;
                        let _ = h.emit("vpn-died", &msg);
                    }
                    return;
                }
            }
        });
    }

    /// Stop VPN gracefully.
    pub async fn stop(&self) -> Result<(), String> {
        eprintln!("[VPN] STOP called");
        // Bump generation so any running watchdog from the previous Connected
        // session exits its loop and stops emitting "vpn-died" while we tear
        // things down on purpose.
        {
            let mut g = self.session_gen.lock().await;
            *g = g.wrapping_add(1);
        }
        self.set_state(VpnState::Disconnecting).await;
        self.force_stop().await;
        self.set_state(VpnState::Disconnected).await;
        eprintln!("[VPN] State -> Disconnected");
        Ok(())
    }

    /// Query traffic stats from xray stats API.
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

    /// Read the bundled xray-core version from the sidecar binary itself.
    /// Keeps Settings honest when CI refreshes the sidecar in a small app
    /// release.
    pub async fn xray_version(&self) -> String {
        let xray_bin = self.resolve_bin("xray");
        let output = match timeout(
            Duration::from_secs(2),
            Command::new(xray_bin).arg("version").output(),
        )
        .await
        {
            Ok(Ok(out)) if out.status.success() => out,
            _ => return "unknown".into(),
        };
        parse_xray_version(&String::from_utf8_lossy(&output.stdout))
    }

    // ── Private ───────────────────────────────────────────────────

    async fn set_state(&self, state: VpnState) {
        *self.state.lock().await = state;
    }

    fn resolve_bin(&self, name: &str) -> PathBuf {
        let plain = self.bin_dir.join(name);
        if plain.exists() {
            return plain;
        }
        let with_triple = format!("{}-x86_64-unknown-linux-gnu", name);
        self.bin_dir.join(with_triple)
    }

    /// Resolve server hostname to IP (needed for bypass route).
    async fn resolve_server_ip(address: &str, attempt: &ConnectAttempt) -> Result<String, String> {
        if address.parse::<std::net::IpAddr>().is_ok() {
            return Ok(address.to_string());
        }
        let lookup = timeout(
            DNS_RESOLVE_TIMEOUT,
            tokio::net::lookup_host(format!("{}:0", address)),
        );
        tokio::pin!(lookup);
        let addrs = tokio::select! {
            result = &mut lookup => result
                .map_err(|_| "DNS resolve timed out".to_string())?
                .map_err(|e| format!("DNS resolve failed: {}", e))?,
            _ = attempt.cancelled() => return Err(CONNECT_CANCELLED.into()),
        };
        for addr in addrs {
            if addr.is_ipv4() {
                return Ok(addr.ip().to_string());
            }
        }
        Err("No IPv4 address found for server".into())
    }

    /// Start tun2socks and configure routing.
    async fn start_tun(
        &self,
        server: &ServerConfig,
        attempt: &ConnectAttempt,
    ) -> Result<(), String> {
        attempt.ensure_active()?;
        let tun2socks_bin = self.resolve_bin("tun2socks");
        eprintln!(
            "[TUN] tun2socks binary: {:?} (exists: {})",
            tun2socks_bin,
            tun2socks_bin.exists()
        );

        // server.address is already the pre-resolved IP (set in start()).
        let server_ip = server.address.clone();
        eprintln!("[TUN] Using resolved bypass address");

        // Detect dev builds: cargo lays sidecars under target/{debug,release}/,
        // never under one of the helper's allowed production prefixes
        // (/usr/lib, /usr/local/lib, /opt). Asking the helper to validate
        // such a path always fails. In that case skip the helper entirely
        // and run the inline pkexec script — slower (password prompt every
        // time) but actually works during local development without
        // weakening the production whitelist that protects against the C1
        // arbitrary-binary-as-root LPE.
        let bin_dir_str = self.bin_dir.to_string_lossy();
        let is_dev_build =
            bin_dir_str.contains("/target/debug") || bin_dir_str.contains("/target/release");

        if !is_dev_build {
            // Auto-install the polkit helper on first run (one pkexec prompt, ever).
            // Also re-installs if the embedded helper differs from what's on disk
            // (e.g. after an app update).
            match Self::ensure_helper_installed(attempt).await {
                Ok(true) => eprintln!("[TUN] Polkit helper ready (installed/up-to-date)"),
                Ok(false) => eprintln!(
                    "[TUN] Polkit helper install was skipped/failed — falling back to inline pkexec"
                ),
                Err(e) => {
                    eprintln!("[TUN] Helper install error: {e} — falling back to inline pkexec")
                }
            }
            attempt.ensure_active()?;

            // Prefer the installed polkit helper — passwordless via app.tobevpn.network policy.
            if std::path::Path::new(POLKIT_HELPER).exists() {
                eprintln!("[TUN] Using polkit helper at {}", POLKIT_HELPER);
                match self
                    .start_tun_via_helper(&tun2socks_bin, &server_ip, attempt)
                    .await
                {
                    Ok(()) => return Ok(()),
                    Err(e) if e.contains("path not in allowed prefix") => {
                        // Helper installed by a different (production) build
                        // is rejecting our current binary path — fall back
                        // to the inline pkexec script for this run.
                        eprintln!(
                            "[TUN] helper rejected sidecar path; falling back to inline pkexec"
                        );
                    }
                    Err(e) => return Err(e),
                }
            } else {
                eprintln!(
                    "[TUN] Helper not installed at {} — falling back to inline pkexec (will prompt for password)",
                    POLKIT_HELPER
                );
            }
        } else {
            eprintln!(
                "[TUN] Dev build detected (bin_dir={:?}); skipping polkit helper, using inline pkexec",
                self.bin_dir
            );
        }

        let script = format!(
            r#"#!/bin/bash
set -e

echo "[TUN-SCRIPT] Starting..."
echo "[TUN-SCRIPT] TUN device: {tun}"
echo "[TUN-SCRIPT] SOCKS port: {socks_port}"

# 0. Clean up leftovers from previous run
echo "[TUN-SCRIPT] Cleaning up leftovers..."
if [ -f /tmp/tobevpn_tun2socks.pid ]; then
    OLD_PID=$(cat /tmp/tobevpn_tun2socks.pid)
    echo "[TUN-SCRIPT] Killing old tun2socks PID: $OLD_PID"
    kill $OLD_PID 2>/dev/null || true
    rm -f /tmp/tobevpn_tun2socks.pid
fi
pkill -9 -f "tun2socks.*-device[[:space:]]+{tun}" 2>/dev/null || true
# Remove ALL rules for our table (handles 'not fwmark' selector mismatches)
for _ in 1 2 3 4 5; do
    ip rule del table {table} 2>/dev/null || break
done
ip rule del not fwmark {fwmark} table {table} prio 100 2>/dev/null || true
for _ in 1 2 3 4 5; do
    ip -6 rule del table {table} 2>/dev/null || break
done
ip -6 rule del not fwmark {fwmark} table {table} prio 100 2>/dev/null || true
ip route flush table {table} 2>/dev/null || echo "[TUN-SCRIPT] No old routes to flush"
ip -6 route flush table {table} 2>/dev/null || echo "[TUN-SCRIPT] No old IPv6 routes to flush"
ip link del {tun} 2>/dev/null || echo "[TUN-SCRIPT] No old TUN to delete"
echo "[TUN-SCRIPT] Cleanup done"

# 1. Save current default gateway. Parse by token name so we handle both
# `default via X dev Y ...` and on-link `default dev Y ...` (PPP, cellular,
# WireGuard upstream — there's no gateway IP).
DEFAULT_LINE=$(ip route show default | head -1)
DEFAULT_GW=$(echo "$DEFAULT_LINE" | awk '{{for(i=1;i<=NF;i++) if($i=="via") print $(i+1)}}')
DEFAULT_DEV=$(echo "$DEFAULT_LINE" | awk '{{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}}')
echo "[TUN-SCRIPT] Default route detected"
echo "${{DEFAULT_GW:-on-link}} $DEFAULT_DEV" > /tmp/tobevpn_orig_route

if [ -z "$DEFAULT_DEV" ]; then
    echo "[TUN-SCRIPT] ERROR: no default route found" >&2
    exit 1
fi

echo "{server_ip}" > /tmp/tobevpn_server_ip

# 2. Start tun2socks as a detached daemon (setsid prevents pkexec from waiting)
echo "[TUN-SCRIPT] Starting tun2socks..."
setsid {tun2socks} -device {tun} -proxy socks5://127.0.0.1:{socks_port} -fwmark {fwmark} &>/dev/null &
T2S_PID=$!
echo $T2S_PID > /tmp/tobevpn_tun2socks.pid
disown $T2S_PID 2>/dev/null || true
echo "[TUN-SCRIPT] tun2socks started with PID: $T2S_PID"

# Wait for TUN interface to appear
echo "[TUN-SCRIPT] Waiting for TUN interface {tun}..."
for i in $(seq 1 30); do
    ip link show {tun} >/dev/null 2>&1 && break
    sleep 0.1
done
if ! ip link show {tun} >/dev/null 2>&1; then
    echo "[TUN-SCRIPT] ERROR: TUN interface {tun} did not appear after 3s" >&2
    echo "[TUN-SCRIPT] Checking if tun2socks is still alive..." >&2
    if kill -0 $T2S_PID 2>/dev/null; then
        echo "[TUN-SCRIPT] tun2socks PID $T2S_PID is still running but TUN not created" >&2
    else
        echo "[TUN-SCRIPT] tun2socks PID $T2S_PID has exited" >&2
        wait $T2S_PID 2>/dev/null
        echo "[TUN-SCRIPT] tun2socks exit code: $?" >&2
    fi
    exit 1
fi
echo "[TUN-SCRIPT] TUN interface {tun} appeared"

# 3. Configure TUN
echo "[TUN-SCRIPT] Configuring TUN: addr={tun_addr}"
ip addr add {tun_addr} dev {tun} 2>/dev/null || echo "[TUN-SCRIPT] addr already set"
ip -6 addr add {tun_addr6} dev {tun} 2>/dev/null || echo "[TUN-SCRIPT] ipv6 addr already set"
ip link set {tun} up
echo "[TUN-SCRIPT] TUN is UP"

# 4. Bypass route for VPN server IP in table 100
if [ -n "$DEFAULT_GW" ]; then
    echo "[TUN-SCRIPT] Adding bypass route"
    ip route add {server_ip}/32 via $DEFAULT_GW dev $DEFAULT_DEV table {table}
else
    echo "[TUN-SCRIPT] Adding on-link bypass route"
    ip route add {server_ip}/32 dev $DEFAULT_DEV scope link table {table}
fi
echo "[TUN-SCRIPT] Bypass route added"

# 5. Default route via TUN in table 100
echo "[TUN-SCRIPT] Adding default route via {tun} table {table}"
ip route add default dev {tun} table {table}
echo "[TUN-SCRIPT] Adding IPv6 route {tun_v6_prefix} via {tun} table {table}"
ip -6 route add {tun_v6_prefix} dev {tun} table {table}
echo "[TUN-SCRIPT] Default route added"

# 6. Policy rule
echo "[TUN-SCRIPT] Adding ip rule: not fwmark {fwmark} -> table {table} prio 100"
ip rule add not fwmark {fwmark} table {table} prio 100
echo "[TUN-SCRIPT] Adding ip -6 rule: not fwmark {fwmark} -> table {table} prio 100"
ip -6 rule add not fwmark {fwmark} table {table} prio 100
echo "[TUN-SCRIPT] IP rule added"

# Verify (no set -e here — grep may return 1 if format differs)
echo "[TUN-SCRIPT] === Verification ==="
echo "[TUN-SCRIPT] ip link:"
ip link show {tun} || true
echo "[TUN-SCRIPT] table {table} routes:"
ip route show table {table} || true
echo "[TUN-SCRIPT] table {table} IPv6 routes:"
ip -6 route show table {table} || true
echo "[TUN-SCRIPT] ip rules:"
ip rule list | grep "{table}" || echo "(no match but rule was added)"
echo "[TUN-SCRIPT] ip -6 rules:"
ip -6 rule list | grep "{table}" || echo "(no IPv6 match but rule was added)"

echo "OK $T2S_PID"
echo "[TUN-SCRIPT] Done!"
"#,
            tun2socks = tun2socks_bin.display(),
            tun = TUN_NAME,
            socks_port = SOCKS_PORT,
            fwmark = FWMARK,
            tun_addr = TUN_ADDR,
            tun_addr6 = TUN_ADDR6,
            tun_v6_prefix = TUN_PUBLIC_V6_PREFIX,
            server_ip = server_ip,
            table = TUN_TABLE,
        );

        let script_path = cache_dir().join("start_tun.sh");
        write_secure(&script_path, script.as_bytes())
            .map_err(|e| format!("Failed to write TUN script: {e}"))?;
        eprintln!("[TUN] Privileged setup script written (mode 0600)");

        eprintln!("[TUN] Running privileged setup");
        attempt.ensure_active()?;
        let mut cmd = Command::new("pkexec");
        cmd.arg("bash").arg(&script_path);
        let output = run_with_timeout_and_env(cmd, PKEXEC_TIMEOUT, Some(attempt))
            .await
            .map_err(|e| {
                eprintln!("[TUN] ERROR: pkexec failed: {e}");
                e
            })?;
        attempt.ensure_active()?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("[TUN] pkexec exit code: {}", output.status);

        if !output.status.success() {
            return Err(format!(
                "TUN setup failed (exit {}): {}",
                output.status,
                stderr.trim()
            ));
        }

        if let Some(line) = stdout.lines().find(|l| l.starts_with("OK ")) {
            if let Some(pid_str) = line.strip_prefix("OK ") {
                if let Ok(pid) = pid_str.trim().parse::<u32>() {
                    eprintln!("[TUN] tun2socks PID saved: {}", pid);
                    *self.tun2socks_pid.lock().await = Some(pid);
                }
            }
        } else {
            eprintln!("[TUN] WARNING: 'OK <pid>' line not found in stdout");
        }

        Ok(())
    }

    /// Install (or refresh) the polkit helper + policy so subsequent runs are
    /// passwordless. Returns `Ok(true)` if installed/up-to-date afterwards,
    /// `Ok(false)` if the user dismissed pkexec, `Err(_)` on hard error.
    ///
    /// SECURITY: every staged file lives under ~/.cache/tobevpn (mode 0700,
    /// owned by the current user). Writing through /tmp here would open a
    /// TOCTOU window between fs::write and `pkexec install -m 755 staged …`
    /// where another local user can swap the staged file's contents and end
    /// up with their own script installed at /usr/local/bin/tobevpn-helper.sh
    /// — passwordlessly callable as root forever after.
    async fn ensure_helper_installed(attempt: &ConnectAttempt) -> Result<bool, String> {
        // The .deb postinst (and the NSIS installer on Windows) drops both
        // files in their final locations as part of installing the app, so
        // by the time the user starts a session the helper is already on
        // disk with root ownership and the polkit policy active. The old
        // logic compared embedded vs on-disk byte-for-byte and, on the
        // tiniest whitespace drift between include_str! and the .deb
        // payload, fired a one-time-install pkexec — the second password
        // prompt the user hit on every fresh install or upgrade.
        //
        // Trust .deb / NSIS as the source of truth: if both files exist,
        // we're done. Only fall through to the pkexec fallback if the
        // installer didn't run (e.g. the binary was launched out of a
        // tarball or the .deb's postinst was skipped) — that's the edge
        // case the manual installer was originally written for.
        let helper_present = std::path::Path::new(POLKIT_HELPER).is_file();
        let update_helper_present = std::path::Path::new(UPDATE_HELPER).is_file();
        let policy_ready = std::fs::read_to_string(POLKIT_POLICY)
            .map(|s| {
                s.contains("<allow_active>yes</allow_active>")
                    && s.contains("<allow_inactive>yes</allow_inactive>")
            })
            .unwrap_or(false);
        let update_policy_ready = std::fs::read_to_string(UPDATE_POLICY)
            .map(|s| s.contains("<allow_active>yes</allow_active>"))
            .unwrap_or(false);
        if helper_present && update_helper_present && policy_ready && update_policy_ready {
            return Ok(true);
        }

        eprintln!("[INSTALL] Helper missing/outdated — running one-time install via pkexec");

        let dir = cache_dir();
        let staged_helper = dir.join("tobevpn-helper.sh.staged");
        let staged_update_helper = dir.join("tobevpn-update-helper.sh.staged");
        let staged_policy = dir.join("app.tobevpn.network.policy.staged");
        let staged_update_policy = dir.join("app.tobevpn.update.policy.staged");
        let staged_install = dir.join("tobevpn-install.sh");

        write_secure(&staged_helper, HELPER_SH.as_bytes())
            .map_err(|e| format!("write staged helper: {e}"))?;
        write_secure(&staged_update_helper, UPDATE_HELPER_SH.as_bytes())
            .map_err(|e| format!("write staged update helper: {e}"))?;
        write_secure(&staged_policy, POLICY_XML.as_bytes())
            .map_err(|e| format!("write staged policy: {e}"))?;
        write_secure(&staged_update_policy, UPDATE_POLICY_XML.as_bytes())
            .map_err(|e| format!("write staged update policy: {e}"))?;

        let install_script = format!(
            r#"#!/bin/bash
set -e
install -m 755 -o root -g root {staged_helper} {helper_path}
install -m 755 -o root -g root {staged_update_helper} {update_helper_path}
install -m 644 -o root -g root {staged_policy} {policy_path}
install -m 644 -o root -g root {staged_update_policy} {update_policy_path}
echo "INSTALLED"
"#,
            staged_helper = shell_escape(&staged_helper.display().to_string()),
            staged_update_helper = shell_escape(&staged_update_helper.display().to_string()),
            staged_policy = shell_escape(&staged_policy.display().to_string()),
            staged_update_policy = shell_escape(&staged_update_policy.display().to_string()),
            helper_path = POLKIT_HELPER,
            update_helper_path = UPDATE_HELPER,
            policy_path = POLKIT_POLICY,
            update_policy_path = UPDATE_POLICY,
        );
        write_secure(&staged_install, install_script.as_bytes())
            .map_err(|e| format!("write installer: {e}"))?;
        // The installer needs +x for `pkexec bash <file>` to even read it as
        // a script when invoked directly, but bash is fine with 0600 because
        // we pass it as an argument — keep it 0600 for safety.
        std::fs::set_permissions(&staged_install, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod installer: {e}"))?;

        let mut cmd = Command::new("pkexec");
        cmd.arg("bash").arg(&staged_install);
        let output = run_with_timeout_and_env(cmd, PKEXEC_TIMEOUT, Some(attempt)).await;

        let _ = std::fs::remove_file(&staged_install);
        let _ = std::fs::remove_file(&staged_helper);
        let _ = std::fs::remove_file(&staged_update_helper);
        let _ = std::fs::remove_file(&staged_policy);
        let _ = std::fs::remove_file(&staged_update_policy);

        let output = match output {
            Ok(o) => o,
            Err(e) => return Err(e),
        };

        if !output.status.success() {
            // pkexec exit 126/127 = dismissed/cancelled — soft failure
            eprintln!(
                "[INSTALL] pkexec exit {} stderr: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
            return Ok(false);
        }
        eprintln!("[INSTALL] Helper installed at {}", POLKIT_HELPER);
        Ok(true)
    }

    /// Run the polkit-installed helper to bring up routing.
    async fn start_tun_via_helper(
        &self,
        tun2socks_bin: &PathBuf,
        server_ip: &str,
        attempt: &ConnectAttempt,
    ) -> Result<(), String> {
        attempt.ensure_active()?;
        let mut cmd = Command::new("pkexec");
        cmd.arg(POLKIT_HELPER)
            .arg("start")
            .arg(tun2socks_bin)
            .arg(server_ip);
        let output = run_with_timeout_and_env(cmd, PKEXEC_TIMEOUT, Some(attempt)).await?;
        attempt.ensure_active()?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("[TUN] helper exit: {}", output.status);

        if !output.status.success() {
            return Err(format!(
                "TUN setup failed (exit {}): {}",
                output.status,
                stderr.trim()
            ));
        }

        if let Some(line) = stdout.lines().find(|l| l.starts_with("OK ")) {
            if let Some(pid_str) = line.strip_prefix("OK ") {
                if let Ok(pid) = pid_str.trim().parse::<u32>() {
                    *self.tun2socks_pid.lock().await = Some(pid);
                }
            }
        }
        Ok(())
    }

    /// Force-stop everything: kill processes, restore routing.
    async fn force_stop(&self) {
        eprintln!("[VPN] force_stop called");
        *self.stats_running.lock().await = false;

        let tun2socks_pid = self.tun2socks_pid.lock().await.take();
        eprintln!("[VPN] tun2socks PID to kill: {:?}", tun2socks_pid);

        // Prefer the polkit helper.
        if Path::new(POLKIT_HELPER).exists() {
            eprintln!("[VPN] Using polkit helper for cleanup");
            let mut cmd = Command::new("pkexec");
            cmd.arg(POLKIT_HELPER).arg("stop");
            let helper_stopped = match run_with_timeout_and_env(cmd, PKEXEC_TIMEOUT, None).await {
                Ok(out) => {
                    eprintln!(
                        "[VPN] helper cleanup exit: {}, stdout: {}",
                        out.status,
                        String::from_utf8_lossy(&out.stdout).trim()
                    );
                    out.status.success()
                }
                Err(e) => {
                    eprintln!("[VPN] helper cleanup error: {e}");
                    false
                }
            };

            // Kill xray
            if let Some(mut child) = self.xray_process.lock().await.take() {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
            let _ = std::fs::remove_file(cache_dir().join("xray.json"));
            if helper_stopped {
                eprintln!("[VPN] force_stop done (helper)");
                return;
            }
            eprintln!("[VPN] Helper cleanup failed; trying inline cleanup");
        } else {
            eprintln!("[VPN] Helper not installed; falling back to inline pkexec cleanup");
        }

        let cleanup_script = format!(
            r#"#!/bin/bash
echo "[CLEANUP] Starting..."

# Kill tun2socks via saved PID
if [ -f /tmp/tobevpn_tun2socks.pid ]; then
    OLD_PID=$(cat /tmp/tobevpn_tun2socks.pid)
    echo "[CLEANUP] Killing saved tun2socks PID: $OLD_PID"
    kill $OLD_PID 2>/dev/null || true
    rm -f /tmp/tobevpn_tun2socks.pid
fi
{kill_pid}

# Nuke any leftover tun2socks process bound to our TUN
pkill -9 -f "tun2socks.*-device[[:space:]]+{tun}" 2>/dev/null || true

# Remove ALL ip rules pointing at our table (handles 'not fwmark' selector mismatches)
echo "[CLEANUP] Removing ip rules for table {table}..."
for _ in 1 2 3 4 5; do
    ip rule del table {table} 2>/dev/null || break
done
# Explicit match variants too, in case above didn't catch them
ip rule del not fwmark {fwmark} table {table} prio 100 2>/dev/null || true
ip rule del fwmark {fwmark} table main prio 50 2>/dev/null || true
ip rule del table {table} prio 100 2>/dev/null || true
ip rule del table {table} prio 200 2>/dev/null || true
for _ in 1 2 3 4 5; do
    ip -6 rule del table {table} 2>/dev/null || break
done
ip -6 rule del not fwmark {fwmark} table {table} prio 100 2>/dev/null || true
ip -6 rule del table {table} prio 100 2>/dev/null || true
ip -6 rule del table {table} prio 200 2>/dev/null || true

# Flush our routing table
ip route flush table {table} 2>/dev/null || true
ip -6 route flush table {table} 2>/dev/null || true

# Clean temp files
rm -f /tmp/tobevpn_orig_route /tmp/tobevpn_server_ip

# Delete TUN interface
ip link del {tun} 2>/dev/null || true

# Verify — user-visible so we know cleanup worked
echo "[CLEANUP] Remaining rules for table {table}:"
ip rule list | grep "lookup {table}" || echo "  (none — good)"
echo "[CLEANUP] Remaining routes in table {table}:"
ip route show table {table} 2>/dev/null || echo "  (empty — good)"
echo "[CLEANUP] Remaining IPv6 routes in table {table}:"
ip -6 route show table {table} 2>/dev/null || echo "  (empty — good)"
echo "STOPPED"
"#,
            kill_pid = if let Some(pid) = tun2socks_pid {
                format!("kill {} 2>/dev/null || true", pid)
            } else {
                String::new()
            },
            table = TUN_TABLE,
            tun = TUN_NAME,
            fwmark = FWMARK,
        );

        let script_path = cache_dir().join("stop_tun.sh");
        let _ = write_secure(&script_path, cleanup_script.as_bytes());

        let mut cleanup_cmd = Command::new("pkexec");
        cleanup_cmd.arg("bash").arg(&script_path);
        let result = run_with_timeout_and_env(cleanup_cmd, PKEXEC_TIMEOUT, None).await;
        match &result {
            Ok(out) => eprintln!("[VPN] cleanup pkexec exit: {}", out.status),
            Err(e) => eprintln!("[VPN] cleanup pkexec error: {e}"),
        }

        // Kill xray
        if let Some(mut child) = self.xray_process.lock().await.take() {
            eprintln!("[VPN] Killing xray process");
            let _ = child.kill().await;
            let _ = child.wait().await;
        }

        let dir = cache_dir();
        let _ = std::fs::remove_file(dir.join("xray.json"));
        let _ = std::fs::remove_file(dir.join("start_tun.sh"));
        let _ = std::fs::remove_file(dir.join("stop_tun.sh"));
        eprintln!("[VPN] force_stop done");
    }
}

/// Wait until a TCP port becomes reachable.
async fn wait_for_port(
    port: u16,
    timeout: Duration,
    attempt: &ConnectAttempt,
) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + timeout;
    let mut attempts = 0u32;
    loop {
        attempt.ensure_active()?;
        attempts += 1;
        if tokio::time::Instant::now() >= deadline {
            eprintln!("[VPN] wait_for_port: timeout after {} attempts", attempts);
            return Err(format!(
                "xray did not start within {}s (port {} not open)",
                timeout.as_secs(),
                port
            ));
        }
        match tokio::net::TcpStream::connect(format!("127.0.0.1:{}", port)).await {
            Ok(_) => {
                eprintln!(
                    "[VPN] wait_for_port: port {} open after {} attempts",
                    port, attempts
                );
                return Ok(());
            }
            Err(_) => sleep(Duration::from_millis(200)).await,
        }
    }
}

/// Query a single stat value from xray's stats API via CLI.
/// Supports multiple output formats across xray-core versions:
///   - `value: 123` / `value:123` (protobuf text)
///   - `"value": "123"` / `"value": 123` (JSON, when -json passed)
async fn query_stat_value(xray_bin: &PathBuf, server: &str, name: &str) -> u64 {
    let output = Command::new(xray_bin)
        .arg("api")
        .arg("statsquery")
        .arg("-s")
        .arg(server)
        .arg("-pattern")
        .arg(name)
        .arg("-reset")
        .output()
        .await;

    let out = match output {
        Ok(out) => out,
        Err(_) => return 0,
    };
    if !out.status.success() {
        return 0;
    }
    parse_stat_value(&String::from_utf8_lossy(&out.stdout)).unwrap_or(0)
}

fn parse_stat_value(text: &str) -> Option<u64> {
    for line in text.lines() {
        let trimmed = line.trim().trim_start_matches(',').trim();
        // Match "value: N", "value:N", "\"value\": N", "\"value\": \"N\""
        let rest = match trimmed
            .strip_prefix("\"value\":")
            .or_else(|| trimmed.strip_prefix("value:"))
        {
            Some(r) => r,
            None => continue,
        };
        let cleaned = rest
            .trim()
            .trim_matches('"')
            .trim_matches(',')
            .trim()
            .trim_matches('"');
        if let Ok(v) = cleaned.parse::<i64>() {
            return Some(v.unsigned_abs());
        }
    }
    None
}

fn parse_xray_version(text: &str) -> String {
    let first_line = text.lines().next().unwrap_or("").trim();
    let mut parts = first_line.split_whitespace();
    match (parts.next(), parts.next()) {
        (Some("Xray"), Some(version)) => format!("Xray-core v{}", version),
        _ if !first_line.is_empty() => first_line.to_string(),
        _ => "unknown".into(),
    }
}
