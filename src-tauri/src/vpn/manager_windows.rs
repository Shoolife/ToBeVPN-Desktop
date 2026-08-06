// Windows VPN backend: xray-core + tun2socks (wintun) + IP Helper routing.
//
// Privilege model: the app itself is launched elevated (the NSIS installer
// installs to Program Files; users start it via the shortcut, which inherits
// the embedded UAC manifest). Route changes then run without
// secondary UAC prompts. This mirrors how stock Windows VPN clients behave.
//
// If the user somehow launches the binary unelevated, `start()` returns a
// human-readable error so the UI can prompt them to "Run as administrator".

use std::collections::BTreeSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout, Duration};

use super::config::{self, ServerConfig, SOCKS_PORT, STATS_API_PORT};
use super::state::{PingHostMapping, TrafficStats, VpnState};
use super::windows_routes::{self, PhysicalRoute};
use super::{ConnectAttempt, CONNECT_CANCELLED};

// CREATE_NO_WINDOW — suppress flashing console for every spawned helper.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const DNS_RESOLVE_TIMEOUT: Duration = Duration::from_secs(8);
const BYPASS_DNS_RESOLVE_TIMEOUT: Duration = Duration::from_secs(2);
const STATS_QUERY_TIMEOUT: Duration = Duration::from_millis(500);

/// Per-user app data dir (e.g. C:\Users\<user>\AppData\Local\ToBeVPN).
/// %LOCALAPPDATA% is already per-user — by default other local users on
/// the box only get traversal/list permissions on its parent, not read on
/// our subdir. We rely on that default ACL inheritance instead of running
/// icacls (which adds dependencies and can fail on locked-down systems).
fn app_data_dir() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir);
    let dir = base.join("ToBeVPN");
    if !dir.exists() {
        if let Err(e) = std::fs::create_dir_all(&dir) {
            eprintln!("[VPN-WIN] could not create {}: {e}", dir.display());
            return std::env::temp_dir();
        }
    }
    dir
}

fn write_log_line(msg: &str) {
    // Plain eprintln, NOT log_win! — calling the macro here would recurse.
    eprintln!("{}", msg);
    crate::diagnostics::record_native("VPN-Windows", msg);
}

macro_rules! log_win {
    ($($arg:tt)*) => {{
        let s = format!($($arg)*);
        write_log_line(&s);
    }};
}

// Wintun adapter parameters. The /30 subnet keeps the wintun side off any
// real LAN; tun2socks doesn't actually route via WINTUN_GATEWAY, but Windows
// requires a sensible address on the interface.
const WINTUN_ADAPTER: &str = "ToBeVPN";
const WINTUN_IP: Ipv4Addr = Ipv4Addr::new(198, 18, 0, 2);
const WINTUN_GATEWAY: Ipv4Addr = Ipv4Addr::new(198, 18, 0, 1);
const WINTUN_IPV6: Ipv6Addr = Ipv6Addr::new(0xfd66, 0x6f62, 0x6576, 0x706e, 0, 0, 0, 2);
const WINTUN_PUBLIC_IPV6_ROUTE: Ipv6Addr = Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0);
const WINTUN_PUBLIC_IPV6_PREFIX: u8 = 3;

pub struct VpnManager {
    state: Arc<Mutex<VpnState>>,
    xray_process: Arc<Mutex<Option<Child>>>,
    tun2socks_process: Arc<Mutex<Option<Child>>>,
    server_ip: Arc<Mutex<Option<String>>>,
    control_bypass_ips: Arc<Mutex<Vec<String>>>,
    physical_route: Arc<Mutex<Option<PhysicalRoute>>>,
    wintun_interface_index: Arc<Mutex<Option<u32>>>,
    /// Bumps every time start() reaches Connected. Watchdog tasks compare
    /// against the snapshot they captured at spawn time and exit when the
    /// generation changes — so a watchdog from a previous session doesn't
    /// fire vpn-died against a new one.
    session_gen: Arc<Mutex<u64>>,
    bin_dir: PathBuf,
    asset_dir: PathBuf,
    app_handle: Arc<Mutex<Option<tauri::AppHandle>>>,
}

impl VpnManager {
    pub fn new(bin_dir: PathBuf, asset_dir: PathBuf) -> Self {
        Self {
            state: Arc::new(Mutex::new(VpnState::Disconnected)),
            xray_process: Arc::new(Mutex::new(None)),
            tun2socks_process: Arc::new(Mutex::new(None)),
            server_ip: Arc::new(Mutex::new(None)),
            control_bypass_ips: Arc::new(Mutex::new(Vec::new())),
            physical_route: Arc::new(Mutex::new(None)),
            wintun_interface_index: Arc::new(Mutex::new(None)),
            session_gen: Arc::new(Mutex::new(0)),
            bin_dir,
            asset_dir,
            app_handle: Arc::new(Mutex::new(None)),
        }
    }

    /// Stash the AppHandle so the watchdog can emit "vpn-died" events.
    pub fn set_app_handle(&mut self, handle: tauri::AppHandle) {
        if let Ok(mut guard) = self.app_handle.try_lock() {
            *guard = Some(handle);
        }
    }

    pub async fn get_state(&self) -> VpnState {
        self.state.lock().await.clone()
    }

    /// Best-effort cleanup of leftovers from a crashed previous run.
    pub async fn cleanup_stale_state(&self) {
        // If the wintun adapter is still around, drop its IP config and any
        // default route pointing through it. Otherwise route detection can
        // pick our own leftover route as the "real" gateway and the bypass
        // ends up looping through ourselves.
        if let Some(interface_index) = windows_routes::adapter_index_by_alias(WINTUN_ADAPTER) {
            log_win!("[VPN-WIN] Stale wintun adapter detected, resetting");
            self.reset_wintun_ipv4_config(interface_index).await;
            self.reset_ipv6_tunnel(interface_index).await;
        }
    }

    pub async fn prepare_ping_bypass(
        &self,
        hosts: Vec<String>,
    ) -> Result<Vec<PingHostMapping>, String> {
        // Always return the host → IPv4 mapping so the caller can pin
        // tcp_ping to a fixed IP. Routing is only mutated when a tunnel is
        // up; off-tunnel the OS already routes ping packets directly.
        let mapping = Self::resolve_hosts_to_ipv4_pairs(&hosts).await;
        if !matches!(self.get_state().await, VpnState::Connected) {
            return Ok(mapping);
        }

        let active_server_ip = self.server_ip.lock().await.clone();
        let existing_bypass_ips = self.control_bypass_ips.lock().await.clone();
        let mut new_ips: Vec<String> = {
            let mut seen = BTreeSet::new();
            for entry in &mapping {
                seen.insert(entry.ip.clone());
            }
            seen.into_iter().collect()
        };
        new_ips.retain(|ip| {
            active_server_ip.as_ref() != Some(ip) && !existing_bypass_ips.contains(ip)
        });
        if new_ips.is_empty() {
            return Ok(mapping);
        }

        let physical_route = self
            .physical_route
            .lock()
            .await
            .clone()
            .or_else(get_default_route)
            .ok_or("Could not detect the physical IPv4 route")?;
        log_win!("[VPN-WIN] Preparing {} direct ping routes", new_ips.len());
        for ip in &new_ips {
            let destination = ip
                .parse::<Ipv4Addr>()
                .map_err(|e| format!("Invalid ping destination {ip}: {e}"))?;
            windows_routes::replace_ipv4_route(
                destination,
                32,
                physical_route.gateway,
                physical_route.interface_index,
                1,
            )
            .map_err(|e| format!("Could not add direct ping route: {e}"))?;
        }

        let mut control_bypass_ips = self.control_bypass_ips.lock().await;
        for ip in new_ips {
            if !control_bypass_ips.contains(&ip) {
                control_bypass_ips.push(ip);
            }
        }
        Ok(mapping)
    }

    /// Start full VPN: xray-core → tun2socks (wintun) → routing.
    pub async fn start(
        &self,
        server: ServerConfig,
        attempt: &ConnectAttempt,
    ) -> Result<(), String> {
        attempt.ensure_active()?;
        log_win!("══════════════════════════════════════════════════");
        log_win!("[VPN-WIN] START called");

        if !is_elevated().await {
            let msg = "ToBeVPN must be run as Administrator on Windows. \
                       Right-click the app and choose 'Run as administrator', \
                       then try again."
                .to_string();
            self.set_state(VpnState::Error {
                message: msg.clone(),
            })
            .await;
            return Err(msg);
        }

        let prev_state = self.state.lock().await.clone();
        if matches!(&prev_state, VpnState::Disconnecting) {
            return Err("Disconnecting in progress, try again in a moment".into());
        }

        // Resolve the replacement before stopping an existing tunnel. Under
        // restricted networks the current tunnel may be the only path that
        // can resolve a different VPN endpoint during a live switch.
        // Resolve the server endpoint and the direct-access (bypass) hosts
        // concurrently. They are independent DNS lookups, so overlapping them
        // trims connect/switch latency; on a live switch both still run while
        // the existing tunnel is up (see comment above).
        let (server_ip_res, bypass_res) = tokio::join!(
            Self::resolve_server_ip(&server.address, attempt),
            Self::resolve_bypass_ips(&server.bypass_hosts, attempt),
        );
        let server_ip = match server_ip_res {
            Ok(ip) => ip,
            Err(e) => {
                if !matches!(&prev_state, VpnState::Connected) {
                    self.set_state(VpnState::Error { message: e.clone() }).await;
                }
                return Err(e);
            }
        };
        log_win!("[VPN-WIN] Server address resolved");
        let mut control_bypass_ips = match bypass_res {
            Ok(ips) => ips,
            Err(e) => return Err(e),
        };
        control_bypass_ips.retain(|ip| ip != &server_ip);
        log_win!(
            "[VPN-WIN] Resolved {} configured direct-access destinations",
            control_bypass_ips.len()
        );
        let physical_route =
            get_default_route().ok_or("Could not detect the physical IPv4 route")?;
        log_win!(
            "[VPN-WIN] Physical route detected (ifIndex={}, metric={})",
            physical_route.interface_index,
            physical_route.metric
        );
        let direct_interface = if server.requires_direct_interface() {
            let interface = match physical_route.interface_alias.clone() {
                Some(interface) => interface,
                None => windows_routes::interface_alias_by_index(physical_route.interface_index)
                    .ok_or_else(|| {
                        format!(
                            "Could not resolve physical adapter alias for ifIndex {} via gateway {}",
                            physical_route.interface_index, physical_route.gateway
                        )
                    })?,
            };
            log_win!("[VPN-WIN] Direct routing interface detected");
            Some(interface)
        } else {
            None
        };
        if attempt.is_cancelled() {
            return Err(CONNECT_CANCELLED.into());
        }

        match prev_state {
            VpnState::Connected | VpnState::Connecting => {
                log_win!("[VPN-WIN] Previous session active — stopping first");
                self.bump_session_gen().await;
                self.force_stop().await;
            }
            _ => {}
        }

        if attempt.is_cancelled() {
            self.set_state(VpnState::Disconnected).await;
            return Err(CONNECT_CANCELLED.into());
        }
        self.set_state(VpnState::Connecting).await;

        let mut server = server;
        if server.sni.is_empty() && server.address.parse::<std::net::IpAddr>().is_err() {
            server.sni = server.address.clone();
        }
        server.address = server_ip.clone();
        if let Some(interface) = direct_interface {
            server.direct_interface = interface;
        }
        *self.server_ip.lock().await = Some(server_ip.clone());
        *self.control_bypass_ips.lock().await = control_bypass_ips.clone();

        // 1. xray config — written under per-user %LOCALAPPDATA%\ToBeVPN\
        // (NOT %TEMP%). Contains the user's UUID; %TEMP% is per-user but is
        // sometimes scraped by AV / cleanup tools and the dir is not as
        // tightly ACL'd on multi-user boxes.
        let config_json = config::build_xray_config(&server);
        let config_path = app_data_dir().join("xray.json");
        std::fs::write(&config_path, &config_json)
            .map_err(|e| format!("Failed to write xray config: {e}"))?;
        if attempt.is_cancelled() {
            self.set_state(VpnState::Disconnected).await;
            return Err(CONNECT_CANCELLED.into());
        }

        let asset_dir = self.find_asset_dir();
        log_win!(
            "[VPN-WIN] asset dir: {:?} (geoip.dat: {}, geosite.dat: {})",
            asset_dir,
            asset_dir.join("geoip.dat").exists(),
            asset_dir.join("geosite.dat").exists()
        );
        if server.requires_geosite_assets() && !asset_dir.join("geosite.dat").is_file() {
            let message = format!("Routing database is missing from {}", asset_dir.display());
            log_win!("[VPN-WIN] ERROR: {message}");
            self.set_state(VpnState::Error {
                message: message.clone(),
            })
            .await;
            return Err(message);
        }

        // 2. xray.exe
        let xray_bin = self.resolve_bin("xray");
        log_win!("[VPN-WIN] xray binary: {:?}", xray_bin);

        let mut xray_child = Command::new(&xray_bin)
            .arg("run")
            .arg("-config")
            .arg(&config_path)
            .env("XRAY_LOCATION_ASSET", &asset_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Failed to start xray: {e}"))?;

        if let Some(stderr) = xray_child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log_win!("[xray] {line}");
                }
            });
        }
        *self.xray_process.lock().await = Some(xray_child);
        if attempt.is_cancelled() {
            self.force_stop().await;
            self.set_state(VpnState::Disconnected).await;
            return Err(CONNECT_CANCELLED.into());
        }

        // 3. wait for SOCKS port
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
            if let Some(ref mut child) = *proc {
                match child.try_wait() {
                    Ok(Some(status)) => {
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
                    Ok(None) => {}
                    Err(e) => {
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

        // 4. TUN + routes
        if let Err(e) = self
            .start_tun(&server_ip, &control_bypass_ips, &physical_route, attempt)
            .await
        {
            self.force_stop().await;
            if attempt.is_cancelled() {
                self.set_state(VpnState::Disconnected).await;
            } else {
                self.set_state(VpnState::Error { message: e.clone() }).await;
            }
            return Err(e);
        }

        if attempt.is_cancelled() {
            self.force_stop().await;
            self.set_state(VpnState::Disconnected).await;
            return Err(CONNECT_CANCELLED.into());
        }
        self.set_state(VpnState::Connected).await;
        log_win!("[VPN-WIN] State -> Connected");

        // Bump generation, spawn kill-switch watchdog. This is the key safety
        // net on Windows: if tun2socks dies (crash, OOM, AV-killed), the
        // wintun adapter goes away and so do the split-default routes that
        // pinned traffic to the tunnel. Without intervention Windows would
        // pick the next-lowest-metric default route — i.e. the physical
        // NIC — and the user's traffic would silently leak past the VPN.
        // The watchdog detects this and runs force_stop, which yanks the
        // bypass route and surfaces an error to the UI.
        let gen = {
            let mut g = self.session_gen.lock().await;
            *g = g.wrapping_add(1);
            *g
        };
        self.spawn_killswitch_watchdog(gen).await;

        log_win!("══════════════════════════════════════════════════");
        Ok(())
    }

    /// Polls xray + tun2socks; on unexpected exit while still Connected,
    /// runs full cleanup (so the bypass route is removed and the user is
    /// not silently pushed back onto the physical NIC) and emits vpn-died.
    async fn spawn_killswitch_watchdog(&self, gen: u64) {
        let xray_proc = self.xray_process.clone();
        let t2s_proc = self.tun2socks_process.clone();
        let state = self.state.clone();
        let session_gen = self.session_gen.clone();
        let app = self.app_handle.clone();
        // VpnManager fields are all Arc<...>+Clone, so cloning self into the
        // task is cheap and gives us back force_stop() inside the watchdog
        // without juggling free helpers.
        let manager_clone = VpnManager {
            state: self.state.clone(),
            xray_process: self.xray_process.clone(),
            tun2socks_process: self.tun2socks_process.clone(),
            server_ip: self.server_ip.clone(),
            control_bypass_ips: self.control_bypass_ips.clone(),
            physical_route: self.physical_route.clone(),
            wintun_interface_index: self.wintun_interface_index.clone(),
            session_gen: self.session_gen.clone(),
            bin_dir: self.bin_dir.clone(),
            asset_dir: self.asset_dir.clone(),
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
                let dead_reason: Option<String> = {
                    let mut x = xray_proc.lock().await;
                    let mut t = t2s_proc.lock().await;
                    let xray_dead = match x.as_mut() {
                        Some(c) => match c.try_wait() {
                            Ok(Some(s)) => Some(format!("xray exited: {s}")),
                            Ok(None) => None,
                            Err(e) => Some(format!("xray probe failed: {e}")),
                        },
                        None => Some("xray child handle gone".to_string()),
                    };
                    let t2s_dead = match t.as_mut() {
                        Some(c) => match c.try_wait() {
                            Ok(Some(s)) => Some(format!("tun2socks exited: {s}")),
                            Ok(None) => None,
                            Err(e) => Some(format!("tun2socks probe failed: {e}")),
                        },
                        None => Some("tun2socks child handle gone".to_string()),
                    };
                    xray_dead.or(t2s_dead)
                };
                if let Some(msg) = dead_reason {
                    log_win!("[VPN-WIN-WATCHDOG] {msg} — running force_stop to kill switch");
                    // Critical: tear down routing/bypass so the user is NOT
                    // bridged onto the physical NIC after wintun disappears.
                    manager_clone.force_stop().await;
                    *state.lock().await = VpnState::Error {
                        message: format!("VPN process stopped unexpectedly: {msg}"),
                    };
                    if let Some(h) = &*app.lock().await {
                        use tauri::Emitter;
                        let _ = h.emit("vpn-died", &msg);
                    }
                    return;
                }
            }
        });
    }

    pub async fn stop(&self) -> Result<(), String> {
        log_win!("[VPN-WIN] STOP called");
        // Bump generation so any running watchdog from the previous Connected
        // session exits cleanly without firing vpn-died over our intentional
        // teardown.
        self.bump_session_gen().await;
        self.set_state(VpnState::Disconnecting).await;
        self.force_stop().await;
        self.set_state(VpnState::Disconnected).await;
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

    /// Read the bundled xray-core version from the sidecar binary itself.
    /// Keeps Settings honest when CI refreshes the sidecar in a small app
    /// release.
    pub async fn xray_version(&self) -> String {
        let xray_bin = self.resolve_bin("xray");
        let output = match timeout(
            Duration::from_secs(2),
            Command::new(xray_bin)
                .arg("version")
                .creation_flags(CREATE_NO_WINDOW)
                .output(),
        )
        .await
        {
            Ok(Ok(out)) if out.status.success() => out,
            _ => return "unknown".into(),
        };
        parse_xray_version(&String::from_utf8_lossy(&output.stdout))
    }

    // ── private ──────────────────────────────────────────────────

    async fn set_state(&self, state: VpnState) {
        *self.state.lock().await = state;
    }

    async fn bump_session_gen(&self) {
        let mut g = self.session_gen.lock().await;
        *g = g.wrapping_add(1);
    }

    async fn reset_wintun_ipv4_config(&self, interface_index: u32) {
        if let Err(error) = windows_routes::delete_interface_ipv4_addresses(interface_index) {
            log_win!("[TUN-WIN] IPv4 address reset failed: {error}");
        }
        for (destination, prefix_length) in [
            (Ipv4Addr::UNSPECIFIED, 0),
            (Ipv4Addr::UNSPECIFIED, 1),
            (Ipv4Addr::new(128, 0, 0, 0), 1),
        ] {
            if let Err(error) = windows_routes::delete_ipv4_routes(
                destination,
                prefix_length,
                Some(interface_index),
            ) {
                log_win!("[TUN-WIN] IPv4 route reset failed: {error}");
            }
        }
        // Do not switch Wintun to DHCP here: there is no DHCP server behind
        // this adapter, and Windows can spend seconds probing before we set
        // the static tunnel address immediately below.
    }

    async fn configure_wintun_ipv4_interface(&self, interface_index: u32) {
        // The interface metric is belt-and-suspenders — the split-default /1
        // routes at metric 1 already win regardless. A freshly-created wintun
        // interface can transiently reject SetIpInterfaceEntry with
        // ERROR_INVALID_PARAMETER (87), so retry briefly, then give up quietly.
        let deadline = tokio::time::Instant::now() + Duration::from_millis(1500);
        loop {
            match windows_routes::set_ipv4_interface_metric(interface_index, 1) {
                Ok(()) => return,
                Err(error) => {
                    if tokio::time::Instant::now() >= deadline {
                        log_win!("[TUN-WIN] IPv4 metric configuration failed: {error}");
                        return;
                    }
                    sleep(Duration::from_millis(200)).await;
                }
            }
        }
    }

    /// Locate a sidecar binary. Tauri renames externalBin to drop the triple
    /// suffix in production, but in dev it stays — handle both.
    fn resolve_bin(&self, name: &str) -> PathBuf {
        let plain = self.bin_dir.join(format!("{}.exe", name));
        if plain.exists() {
            return plain;
        }
        self.bin_dir
            .join(format!("{}-x86_64-pc-windows-msvc.exe", name))
    }

    fn find_asset_dir(&self) -> PathBuf {
        if self.asset_dir.join("geoip.dat").exists() || self.asset_dir.join("geosite.dat").exists()
        {
            return self.asset_dir.clone();
        }
        let beside = self.bin_dir.join("geoip.dat");
        if beside.exists() {
            return self.bin_dir.clone();
        }
        let sub = self.bin_dir.join("bin");
        if sub.join("geoip.dat").exists() {
            return sub;
        }
        self.bin_dir.clone()
    }

    async fn lookup_ipv4s(
        host: String,
        port: u16,
        timeout_dur: Duration,
    ) -> Result<Vec<String>, String> {
        let lookup = timeout(
            timeout_dur,
            tokio::net::lookup_host(format!("{}:{}", host, port)),
        );
        let addrs = lookup
            .await
            .map_err(|_| "DNS resolve timed out".to_string())?
            .map_err(|e| format!("DNS resolve failed: {}", e))?;
        Ok(addrs
            .filter(|addr| addr.is_ipv4())
            .map(|addr| addr.ip().to_string())
            .collect())
    }

    async fn resolve_server_ip(address: &str, attempt: &ConnectAttempt) -> Result<String, String> {
        match address.parse::<IpAddr>() {
            Ok(IpAddr::V4(_)) => return Ok(address.to_string()),
            Ok(IpAddr::V6(_)) => return Err("No IPv4 address found for server".into()),
            Err(_) => {}
        }
        let addrs = tokio::select! {
            result = Self::lookup_ipv4s(address.to_string(), 0, DNS_RESOLVE_TIMEOUT) => result?,
            _ = attempt.cancelled() => return Err(CONNECT_CANCELLED.into()),
        };
        if let Some(ip) = addrs.into_iter().next() {
            return Ok(ip);
        }
        Err("No IPv4 address found for server".into())
    }

    async fn resolve_bypass_ips(
        hosts: &[String],
        attempt: &ConnectAttempt,
    ) -> Result<Vec<String>, String> {
        let mut ips = BTreeSet::new();
        let mut seen_hosts = BTreeSet::new();
        let mut tasks = Vec::new();
        for host in hosts {
            let trimmed = host.trim();
            if trimmed.is_empty() || !seen_hosts.insert(trimmed.to_string()) {
                continue;
            }
            if let Ok(ip) = trimmed.parse::<std::net::Ipv4Addr>() {
                ips.insert(ip.to_string());
                continue;
            }
            let host = trimmed.to_string();
            tasks.push(tokio::spawn(async move {
                Self::lookup_ipv4s(host, 443, BYPASS_DNS_RESOLVE_TIMEOUT).await
            }));
        }
        for task in tasks {
            let result = tokio::select! {
                result = task => result,
                _ = attempt.cancelled() => return Err(CONNECT_CANCELLED.into()),
            };
            match result {
                Ok(Ok(found)) => ips.extend(found),
                Ok(Err(_)) | Err(_) => {
                    log_win!("[VPN-WIN] Direct-access destination DNS lookup failed")
                }
            }
        }
        Ok(ips.into_iter().collect())
    }

    /// Resolve each host to its first IPv4 address, preserving the input
    /// host string. Hosts that fail to resolve or that are IPv6-only are
    /// omitted — the JS caller falls back to the hostname for ping.
    async fn resolve_hosts_to_ipv4_pairs(hosts: &[String]) -> Vec<PingHostMapping> {
        let mut out = Vec::new();
        let mut seen = BTreeSet::new();
        let mut tasks = Vec::new();
        for host in hosts {
            let trimmed = host.trim();
            if trimmed.is_empty() {
                continue;
            }
            if !seen.insert(trimmed.to_string()) {
                continue;
            }
            if trimmed.parse::<std::net::Ipv4Addr>().is_ok() {
                out.push(PingHostMapping {
                    host: trimmed.to_string(),
                    ip: trimmed.to_string(),
                });
                continue;
            }
            let host = trimmed.to_string();
            tasks.push(tokio::spawn(async move {
                let ip = Self::lookup_ipv4s(host.clone(), 443, BYPASS_DNS_RESOLVE_TIMEOUT)
                    .await
                    .ok()
                    .and_then(|ips| ips.into_iter().next());
                ip.map(|ip| PingHostMapping { host, ip })
            }));
        }
        for task in tasks {
            match task.await {
                Ok(Some(mapping)) => out.push(mapping),
                Ok(None) | Err(_) => log_win!("[VPN-WIN] Ping destination DNS lookup failed"),
            }
        }
        out
    }

    async fn start_tun(
        &self,
        server_ip: &str,
        control_bypass_ips: &[String],
        physical_route: &PhysicalRoute,
        attempt: &ConnectAttempt,
    ) -> Result<(), String> {
        attempt.ensure_active()?;
        let tun2socks_bin = self.resolve_bin("tun2socks");
        log_win!("[TUN-WIN] tun2socks binary: {:?}", tun2socks_bin);

        // wintun.dll must sit next to tun2socks.exe at runtime.
        self.ensure_wintun_dll(&tun2socks_bin)?;

        *self.physical_route.lock().await = Some(physical_route.clone());
        attempt.ensure_active()?;

        // Pin VPN and configured fallback destinations to the original
        // interface so control-plane requests never depend on the tunnel.
        let mut direct_ips = vec![server_ip.to_string()];
        direct_ips.extend(control_bypass_ips.iter().cloned());
        direct_ips.sort();
        direct_ips.dedup();
        for ip in &direct_ips {
            let destination = ip
                .parse::<Ipv4Addr>()
                .map_err(|e| format!("Invalid direct-access destination {ip}: {e}"))?;
            windows_routes::replace_ipv4_route(
                destination,
                32,
                physical_route.gateway,
                physical_route.interface_index,
                1,
            )
            .map_err(|e| format!("Could not add direct-access route: {e}"))?;
        }
        attempt.ensure_active()?;

        // Spawn tun2socks. It creates the wintun adapter on first packet.
        let mut t2s_child = Command::new(&tun2socks_bin)
            .args([
                "--device",
                // xjasonlyu/tun2socks uses `tun://NAME` on every OS;
                // on Windows it auto-loads wintun.dll under the hood.
                // The `wintun://` scheme does not exist and produces
                // "unsupported driver: wintun" at startup.
                &format!("tun://{}", WINTUN_ADAPTER),
                "--proxy",
                &format!("socks5://127.0.0.1:{}", SOCKS_PORT),
                "--loglevel",
                "error",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Failed to start tun2socks: {e}"))?;

        if let Some(stderr) = t2s_child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    log_win!("[tun2socks] {line}");
                }
            });
        }
        *self.tun2socks_process.lock().await = Some(t2s_child);

        // Resolve the wintun IPv4 interface AND claim the tunnel address in one
        // retry loop. This is what makes reconnect/switch reliable: a previous
        // session can leave an orphaned "ToBeVPN"/"ToBeVPN 1" adapter that
        // tun2socks tears down while creating the fresh one, so for a moment the
        // IPv4 index resolves to a *dying* interface. If we lock onto that index
        // and try to configure it, CreateUnicastIpAddressEntry returns
        // ERROR_NOT_FOUND (1168) for as long as we keep retrying the same index.
        // Instead we re-resolve the index every iteration and treat a failed
        // address claim as "not the live adapter yet" — the next poll picks up
        // the new adapter (see log: idx 45 -> orphan removed -> idx 21).
        let ready_deadline_secs = 20u64;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(ready_deadline_secs);
        let mut iter = 0;
        let mut last_err: Option<String> = None;
        let wintun_idx = loop {
            attempt.ensure_active()?;
            iter += 1;
            let ipv4 = windows_routes::adapter_ipv4_index(WINTUN_ADAPTER);
            let any = windows_routes::adapter_index_by_alias(WINTUN_ADAPTER);
            log_win!("[TUN-WIN] adapter poll {iter}: ipv4_index={ipv4:?}, any_index={any:?}");
            // Prefer the IPv4 IfIndex; fall back to the collapsed index. The
            // readiness + address claim below reject a wrong/dying index anyway.
            if let Some(idx) = ipv4.or(any) {
                if windows_routes::ipv4_interface_ready(idx) {
                    // Clear stale config on this interface, then claim the
                    // tunnel address. Success proves this is the live adapter.
                    self.reset_wintun_ipv4_config(idx).await;
                    match windows_routes::ensure_ipv4_address(idx, WINTUN_IP, 30) {
                        Ok(()) => break idx,
                        Err(e) => {
                            log_win!("[TUN-WIN] address claim on idx {idx} failed, retrying: {e}");
                            last_err = Some(e);
                        }
                    }
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(format!(
                    "Windows IPv4 address configuration failed: {}",
                    last_err.unwrap_or_else(|| format!(
                        "wintun adapter '{}' IPv4 interface never became ready within {}s",
                        WINTUN_ADAPTER, ready_deadline_secs
                    ))
                ));
            }
            sleep(Duration::from_millis(250)).await;
        };
        *self.wintun_interface_index.lock().await = Some(wintun_idx);
        log_win!(
            "[TUN-WIN] wintun IPv4 ready & address set (idx={wintun_idx}, after {iter} polls)"
        );
        attempt.ensure_active()?;
        self.configure_wintun_ipv4_interface(wintun_idx).await;
        attempt.ensure_active()?;

        // Split-default override: 0.0.0.0/1 and 128.0.0.0/1 are both more
        // specific than the OS-wide default 0.0.0.0/0, so the routing engine
        // always prefers them regardless of interface metrics. Without this,
        // relying on a default route and interface metrics alone can leave
        // browser traffic on the LAN interface.
        log_win!(
            "[TUN-WIN] wintun ifIndex={}, installing split-default",
            wintun_idx
        );
        windows_routes::replace_ipv4_route(Ipv4Addr::UNSPECIFIED, 1, WINTUN_GATEWAY, wintun_idx, 1)
            .map_err(|e| format!("Could not add 0.0.0.0/1 tunnel route: {e}"))?;
        attempt.ensure_active()?;
        windows_routes::replace_ipv4_route(
            Ipv4Addr::new(128, 0, 0, 0),
            1,
            WINTUN_GATEWAY,
            wintun_idx,
            1,
        )
        .map_err(|e| format!("Could not add 128.0.0.0/1 tunnel route: {e}"))?;
        attempt.ensure_active()?;

        self.configure_ipv6_tunnel(attempt).await?;

        Ok(())
    }

    async fn configure_ipv6_tunnel(&self, attempt: &ConnectAttempt) -> Result<(), String> {
        attempt.ensure_active()?;

        // IPv6 is best-effort: on hosts with IPv6 disabled the stack may never
        // bind to the wintun interface. Do not let that block an otherwise
        // healthy IPv4 tunnel — wait briefly, then skip if it never appears.
        // Resolve the dedicated IPv6 interface index (Ipv6IfIndex); it can
        // differ from the IPv4 IfIndex, so we must not reuse the IPv4 one here.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        let interface_index = loop {
            attempt.ensure_active()?;
            if let Some(idx) = windows_routes::adapter_ipv6_index(WINTUN_ADAPTER) {
                if windows_routes::ipv6_interface_ready(idx) {
                    break idx;
                }
            }
            if tokio::time::Instant::now() >= deadline {
                log_win!("[TUN-WIN] IPv6 interface not ready, skipping IPv6 tunnel config");
                return Ok(());
            }
            sleep(Duration::from_millis(200)).await;
        };
        attempt.ensure_active()?;

        self.reset_ipv6_tunnel(interface_index).await;
        attempt.ensure_active()?;

        // Retry the address like IPv4: it can transiently report 1168 while the
        // interface settles. Failures here are logged, not fatal.
        let addr_deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            match windows_routes::ensure_ipv6_address(interface_index, WINTUN_IPV6, 64) {
                Ok(()) => break,
                Err(error) => {
                    if tokio::time::Instant::now() >= addr_deadline {
                        log_win!("[TUN-WIN] IPv6 address configuration failed: {error}");
                        return Ok(());
                    }
                    sleep(Duration::from_millis(200)).await;
                }
            }
        }
        if let Err(error) = windows_routes::set_ipv6_interface_metric(interface_index, 1) {
            log_win!("[TUN-WIN] IPv6 metric configuration failed: {error}");
        }
        if let Err(error) = windows_routes::replace_ipv6_route(
            WINTUN_PUBLIC_IPV6_ROUTE,
            WINTUN_PUBLIC_IPV6_PREFIX,
            interface_index,
            1,
        ) {
            log_win!("[TUN-WIN] IPv6 tunnel route configuration failed: {error}");
        }

        Ok(())
    }

    async fn reset_ipv6_tunnel(&self, interface_index: u32) {
        if let Err(error) = windows_routes::delete_ipv6_routes(
            WINTUN_PUBLIC_IPV6_ROUTE,
            WINTUN_PUBLIC_IPV6_PREFIX,
            Some(interface_index),
        ) {
            log_win!("[TUN-WIN] IPv6 route reset failed: {error}");
        }
        if let Err(error) =
            windows_routes::delete_interface_ipv6_address(interface_index, WINTUN_IPV6)
        {
            log_win!("[TUN-WIN] IPv6 address reset failed: {error}");
        }
    }

    /// Tauri puts wintun.dll in the resources dir, but tun2socks looks for it
    /// next to its own .exe. Copy it on first connect (idempotent).
    fn ensure_wintun_dll(&self, tun2socks_path: &PathBuf) -> Result<(), String> {
        let dest = tun2socks_path
            .parent()
            .ok_or("tun2socks path has no parent")?
            .join("wintun.dll");
        if dest.exists() {
            return Ok(());
        }

        // Cover all Tauri NSIS resource layouts we have observed:
        //   <install_dir>\wintun.dll                       (next to exe)
        //   <install_dir>\bin\wintun.dll                   (resources kept their bin/ prefix)
        //   <install_dir>\resources\bin\wintun.dll         (NSIS resources sub-dir)
        //   <install_dir>\resources\wintun.dll
        //   legacy: bin_dir = <install_dir>\resources\bin
        let candidates = [
            self.bin_dir.join("wintun.dll"),
            self.bin_dir.join("bin").join("wintun.dll"),
            self.bin_dir
                .join("resources")
                .join("bin")
                .join("wintun.dll"),
            self.bin_dir.join("resources").join("wintun.dll"),
            self.bin_dir.join("../resources/bin/wintun.dll"),
            self.bin_dir.join("../resources/wintun.dll"),
        ];
        for src in &candidates {
            if src.exists() {
                std::fs::copy(src, &dest)
                    .map_err(|e| format!("copy wintun.dll {:?} -> {:?}: {e}", src, dest))?;
                log_win!("[TUN-WIN] Copied wintun.dll: {:?} -> {:?}", src, dest);
                return Ok(());
            }
        }
        let tried: Vec<String> = candidates.iter().map(|p| p.display().to_string()).collect();
        Err(format!(
            "wintun.dll not found near tun2socks. Tried: {}",
            tried.join(" | ")
        ))
    }

    async fn force_stop(&self) {
        log_win!("[VPN-WIN] force_stop");

        // Stop proxy traffic first, then remove only routes owned by this
        // session while the Wintun adapter still has a valid interface index.
        if let Some(mut child) = self.xray_process.lock().await.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }

        let physical_route = self.physical_route.lock().await.take();
        let server_ip = self.server_ip.lock().await.take();
        let bypass_ips: Vec<String> = self.control_bypass_ips.lock().await.drain(..).collect();
        if let Some(physical_route) = physical_route {
            let mut direct_ips = bypass_ips;
            if let Some(server_ip) = server_ip {
                direct_ips.push(server_ip);
            }
            for ip in direct_ips {
                if let Ok(destination) = ip.parse::<Ipv4Addr>() {
                    if let Err(error) = windows_routes::delete_ipv4_routes(
                        destination,
                        32,
                        Some(physical_route.interface_index),
                    ) {
                        log_win!("[VPN-WIN] direct route cleanup failed: {error}");
                    }
                }
            }
        }

        let wintun_interface_index = self
            .wintun_interface_index
            .lock()
            .await
            .take()
            .or_else(|| windows_routes::adapter_index_by_alias(WINTUN_ADAPTER));

        // Remove split-default routes installed by start_tun (best-effort).
        if let Some(interface_index) = wintun_interface_index {
            for destination in [Ipv4Addr::UNSPECIFIED, Ipv4Addr::new(128, 0, 0, 0)] {
                if let Err(error) =
                    windows_routes::delete_ipv4_routes(destination, 1, Some(interface_index))
                {
                    log_win!("[VPN-WIN] split route cleanup failed: {error}");
                }
            }
            self.reset_ipv6_tunnel(interface_index).await;
            self.reset_wintun_ipv4_config(interface_index).await;
        }

        // tun2socks owns the Wintun adapter, so stop it after route/address
        // cleanup. This avoids stale routes when the adapter vanishes.
        if let Some(mut child) = self.tun2socks_process.lock().await.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }

        let _ = std::fs::remove_file(app_data_dir().join("xray.json"));
    }
}

// ── helpers ────────────────────────────────────────────────────────

/// True if the current process token is elevated (running as Administrator).
/// Reads the process token directly via the Win32 API. The previous probe
/// (`net session`) gave false negatives on machines where the Server /
/// LanmanServer service is disabled — it fails with a non-zero exit even for
/// a fully elevated process, wrongly telling the user to "Run as
/// administrator". The token check has no such external dependency.
async fn is_elevated() -> bool {
    windows_routes::process_is_elevated()
}

/// Returns the lowest-metric physical IPv4 default route, excluding Wintun.
fn get_default_route() -> Option<PhysicalRoute> {
    match windows_routes::default_ipv4_route(WINTUN_ADAPTER, WINTUN_GATEWAY) {
        Ok(route) => Some(route),
        Err(error) => {
            log_win!("[get_default_route] IP Helper query failed: {error}");
            None
        }
    }
}

async fn wait_for_port(
    port: u16,
    timeout: Duration,
    attempt: &ConnectAttempt,
) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        attempt.ensure_active()?;
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "xray did not start within {}s (port {} not open)",
                timeout.as_secs(),
                port
            ));
        }
        if tokio::net::TcpStream::connect(format!("127.0.0.1:{}", port))
            .await
            .is_ok()
        {
            return Ok(());
        }
        sleep(Duration::from_millis(100)).await;
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
        .creation_flags(CREATE_NO_WINDOW)
        .kill_on_drop(true);
    let out = match timeout(STATS_QUERY_TIMEOUT, command.output()).await {
        Ok(Ok(out)) => out,
        Err(_) => return 0,
        Ok(Err(_)) => return 0,
    };
    if !out.status.success() {
        return 0;
    }
    parse_stat_value(&String::from_utf8_lossy(&out.stdout)).unwrap_or(0)
}

fn parse_stat_value(text: &str) -> Option<u64> {
    for line in text.lines() {
        let trimmed = line.trim().trim_start_matches(',').trim();
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
        if let Ok(value) = cleaned.parse::<u64>() {
            return Some(value);
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
