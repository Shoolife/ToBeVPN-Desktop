// Windows VPN backend: xray-core + tun2socks (wintun) + netsh-driven routing.
//
// Privilege model: the app itself is launched elevated (the NSIS installer
// installs to Program Files; users start it via the shortcut, which inherits
// the embedded UAC manifest). All `route`/`netsh` calls then run without
// secondary UAC prompts. This mirrors how stock Windows VPN clients behave.
//
// If the user somehow launches the binary unelevated, `start()` returns a
// human-readable error so the UI can prompt them to "Run as administrator".

use std::io::Write;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout, Duration};

use super::config::{self, ServerConfig, SOCKS_PORT, STATS_API_PORT};
use super::state::{TrafficStats, VpnState};

// CREATE_NO_WINDOW — suppress flashing console for every spawned helper.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// Hard ceiling for any external process we spawn (PowerShell, netsh, route...).
// Without this a hanging subprocess pins the connection in "Connecting" forever.
const SUBPROC_TIMEOUT: Duration = Duration::from_secs(15);
// Tighter cap for fast-poll commands (adapter_exists) so the surrounding
// retry loop stays time-bounded even if PowerShell wedges.
const POLL_TIMEOUT: Duration = Duration::from_secs(3);

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

// Append-only log under the per-user app dir so users can share diagnostics
// when the GUI gives no useful error (Windows release builds discard stderr).
fn log_path() -> PathBuf {
    app_data_dir().join("tobevpn.log")
}

fn write_log_line(msg: &str) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Plain eprintln, NOT log_win! — calling the macro here would recurse.
    eprintln!("{}", msg);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let _ = writeln!(f, "[{ts}] {msg}");
    }
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
const WINTUN_IP: &str = "198.18.0.2";
const WINTUN_MASK: &str = "255.255.255.252";
const WINTUN_GATEWAY: &str = "198.18.0.1";
const WINTUN_IPV6: &str = "fd66:6f62:6576:706e::2";
const WINTUN_IPV6_CIDR: &str = "fd66:6f62:6576:706e::2/64";
const WINTUN_PUBLIC_IPV6_ROUTE: &str = "2000::/3";

pub struct VpnManager {
    state: Arc<Mutex<VpnState>>,
    xray_process: Arc<Mutex<Option<Child>>>,
    tun2socks_process: Arc<Mutex<Option<Child>>>,
    server_ip: Arc<Mutex<Option<String>>>,
    /// Bumps every time start() reaches Connected. Watchdog tasks compare
    /// against the snapshot they captured at spawn time and exit when the
    /// generation changes — so a watchdog from a previous session doesn't
    /// fire vpn-died against a new one.
    session_gen: Arc<Mutex<u64>>,
    bin_dir: PathBuf,
    app_handle: Arc<Mutex<Option<tauri::AppHandle>>>,
}

impl VpnManager {
    pub fn new(bin_dir: PathBuf) -> Self {
        Self {
            state: Arc::new(Mutex::new(VpnState::Disconnected)),
            xray_process: Arc::new(Mutex::new(None)),
            tun2socks_process: Arc::new(Mutex::new(None)),
            server_ip: Arc::new(Mutex::new(None)),
            session_gen: Arc::new(Mutex::new(0)),
            bin_dir,
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
        // default route pointing through it. Otherwise get_default_gateway
        // picks our own leftover route as the "real" gateway and the bypass
        // ends up looping through ourselves.
        if adapter_exists(WINTUN_ADAPTER).await {
            log_win!("[VPN-WIN] Stale wintun adapter detected, resetting");
            let _ = run_cmd(
                "netsh",
                &[
                    "interface",
                    "ipv4",
                    "set",
                    "address",
                    &format!("name={}", WINTUN_ADAPTER),
                    "source=dhcp",
                ],
            )
            .await;
            // Best-effort: remove any 0.0.0.0/0 route on the wintun adapter.
            let cmd = format!(
                "Get-NetRoute -DestinationPrefix '0.0.0.0/0' -InterfaceAlias '{}' \
                 -ErrorAction SilentlyContinue | Remove-NetRoute -Confirm:$false \
                 -ErrorAction SilentlyContinue",
                WINTUN_ADAPTER
            );
            let _ = run_cmd(
                "powershell",
                &["-NoProfile", "-NonInteractive", "-Command", &cmd],
            )
            .await;
            self.reset_ipv6_tunnel().await;
        }
    }

    /// Start full VPN: xray-core → tun2socks (wintun) → routing.
    pub async fn start(&self, server: ServerConfig) -> Result<(), String> {
        // Reset the diagnostic log so users sharing it only ship the latest run.
        let _ = std::fs::remove_file(log_path());
        log_win!("══════════════════════════════════════════════════");
        log_win!(
            "[VPN-WIN] START called (server={}, port={}, network={})",
            server.address,
            server.port,
            server.network
        );
        log_win!("[VPN-WIN] log file: {}", log_path().display());

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
        match prev_state {
            VpnState::Connected | VpnState::Connecting => {
                log_win!("[VPN-WIN] Previous session active — stopping first");
                self.force_stop().await;
            }
            VpnState::Disconnecting => {
                return Err("Disconnecting in progress, try again in a moment".into());
            }
            _ => {}
        }

        self.set_state(VpnState::Connecting).await;

        // Pre-resolve server hostname so xray never needs to DNS through itself.
        let server_ip = match Self::resolve_server_ip(&server.address).await {
            Ok(ip) => ip,
            Err(e) => {
                self.set_state(VpnState::Error { message: e.clone() }).await;
                return Err(e);
            }
        };
        log_win!("[VPN-WIN] Pre-resolved {} -> {}", server.address, server_ip);

        let mut server = server;
        if server.sni.is_empty() && server.address.parse::<std::net::IpAddr>().is_err() {
            server.sni = server.address.clone();
        }
        server.address = server_ip.clone();
        *self.server_ip.lock().await = Some(server_ip.clone());

        // 1. xray config — written under per-user %LOCALAPPDATA%\ToBeVPN\
        // (NOT %TEMP%). Contains the user's UUID; %TEMP% is per-user but is
        // sometimes scraped by AV / cleanup tools and the dir is not as
        // tightly ACL'd on multi-user boxes.
        let config_json = config::build_xray_config(&server);
        let config_path = app_data_dir().join("xray.json");
        std::fs::write(&config_path, &config_json)
            .map_err(|e| format!("Failed to write xray config: {e}"))?;

        let asset_dir = self.find_asset_dir();

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
                    log_win!("[xray] {}", line);
                }
            });
        }
        *self.xray_process.lock().await = Some(xray_child);

        // 3. wait for SOCKS port
        if let Err(e) = wait_for_port(SOCKS_PORT, Duration::from_secs(10)).await {
            self.force_stop().await;
            self.set_state(VpnState::Error { message: e.clone() }).await;
            return Err(e);
        }

        // 4. TUN + routes
        if let Err(e) = self.start_tun(&server_ip).await {
            self.force_stop().await;
            self.set_state(VpnState::Error { message: e.clone() }).await;
            return Err(e);
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
        {
            let mut g = self.session_gen.lock().await;
            *g = g.wrapping_add(1);
        }
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

    async fn resolve_server_ip(address: &str) -> Result<String, String> {
        if address.parse::<std::net::IpAddr>().is_ok() {
            return Ok(address.to_string());
        }
        let addrs = tokio::net::lookup_host(format!("{}:0", address))
            .await
            .map_err(|e| format!("DNS resolve failed for {}: {}", address, e))?;
        for addr in addrs {
            if addr.is_ipv4() {
                return Ok(addr.ip().to_string());
            }
        }
        Err(format!("No IPv4 address found for {}", address))
    }

    async fn start_tun(&self, server_ip: &str) -> Result<(), String> {
        let tun2socks_bin = self.resolve_bin("tun2socks");
        log_win!("[TUN-WIN] tun2socks binary: {:?}", tun2socks_bin);

        // wintun.dll must sit next to tun2socks.exe at runtime.
        self.ensure_wintun_dll(&tun2socks_bin)?;

        // Save the current default gateway so we can pin a bypass route.
        let (gw, idx) = get_default_gateway()
            .await
            .ok_or("Could not detect default IPv4 gateway")?;
        log_win!("[TUN-WIN] Default gateway: {} (ifIndex {})", gw, idx);

        // Bypass route: VPN server reachable via the original gateway, never
        // via TUN. We pin it to the physical interface index — on cellular
        // setups Windows reports the default route as "on-link" with no IP
        // gateway, and only the explicit `if <idx>` keeps the route on the
        // right NIC instead of getting picked up by some other adapter.
        run_cmd(
            "route",
            &[
                "add",
                server_ip,
                "mask",
                "255.255.255.255",
                &gw,
                "metric",
                "1",
                "if",
                &idx,
            ],
        )
        .await
        .map_err(|e| format!("route add bypass failed: {e}"))?;

        // Spawn tun2socks. It creates the wintun adapter on first packet.
        let mut t2s_child = Command::new(&tun2socks_bin)
            .args([
                "-device",
                // xjasonlyu/tun2socks uses `tun://NAME` on every OS;
                // on Windows it auto-loads wintun.dll under the hood.
                // The `wintun://` scheme does not exist and produces
                // "unsupported driver: wintun" at startup.
                &format!("tun://{}", WINTUN_ADAPTER),
                "-proxy",
                &format!("socks5://127.0.0.1:{}", SOCKS_PORT),
                "-loglevel",
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
                    log_win!("[tun2socks] {}", line);
                }
            });
        }
        *self.tun2socks_process.lock().await = Some(t2s_child);

        // Wait for the adapter to register with Windows. Time-bounded so
        // a flaky adapter_exists never extends the loop past the deadline.
        let adapter_deadline_secs = 15u64;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(adapter_deadline_secs);
        let mut found = false;
        let mut iter = 0;
        while tokio::time::Instant::now() < deadline {
            iter += 1;
            if adapter_exists(WINTUN_ADAPTER).await {
                found = true;
                break;
            }
            log_win!("[TUN-WIN] adapter not ready yet (iter {iter})");
            sleep(Duration::from_millis(500)).await;
        }
        if !found {
            return Err(format!(
                "Wintun adapter '{}' did not appear within {}s",
                WINTUN_ADAPTER, adapter_deadline_secs
            ));
        }
        log_win!("[TUN-WIN] wintun adapter ready (after {iter} polls)");

        // Configure adapter: address + low metric so it's the default route.
        run_cmd(
            "netsh",
            &[
                "interface",
                "ipv4",
                "set",
                "address",
                &format!("name={}", WINTUN_ADAPTER),
                "static",
                WINTUN_IP,
                WINTUN_MASK,
                WINTUN_GATEWAY,
            ],
        )
        .await
        .map_err(|e| format!("netsh set address failed: {e}"))?;

        run_cmd(
            "netsh",
            &[
                "interface",
                "ipv4",
                "set",
                "interface",
                WINTUN_ADAPTER,
                "metric=1",
            ],
        )
        .await
        .ok(); // non-fatal

        // DNS over the tunnel.
        run_cmd(
            "netsh",
            &[
                "interface",
                "ipv4",
                "set",
                "dnsservers",
                &format!("name={}", WINTUN_ADAPTER),
                "static",
                "1.1.1.1",
                "primary",
            ],
        )
        .await
        .ok();
        run_cmd(
            "netsh",
            &[
                "interface",
                "ipv4",
                "add",
                "dnsservers",
                &format!("name={}", WINTUN_ADAPTER),
                "8.8.8.8",
                "index=2",
            ],
        )
        .await
        .ok();

        // Split-default override: 0.0.0.0/1 and 128.0.0.0/1 are both more
        // specific than the OS-wide default 0.0.0.0/0, so the routing engine
        // always prefers them regardless of interface metrics. Without this,
        // `netsh set address ... 198.18.0.1` may install a default route
        // whose effective metric is higher than the real adapter's, leaving
        // browser traffic on the LAN interface.
        let wintun_idx = match get_adapter_index(WINTUN_ADAPTER).await {
            Some(i) => i,
            None => {
                log_win!("[TUN-WIN] could not resolve wintun ifIndex; skipping split-default");
                return Ok(());
            }
        };
        log_win!(
            "[TUN-WIN] wintun ifIndex={}, installing split-default",
            wintun_idx
        );
        run_cmd(
            "route",
            &[
                "add",
                "0.0.0.0",
                "mask",
                "128.0.0.0",
                WINTUN_GATEWAY,
                "metric",
                "1",
                "if",
                &wintun_idx,
            ],
        )
        .await
        .map_err(|e| format!("route add 0.0.0.0/1 failed: {e}"))?;
        run_cmd(
            "route",
            &[
                "add",
                "128.0.0.0",
                "mask",
                "128.0.0.0",
                WINTUN_GATEWAY,
                "metric",
                "1",
                "if",
                &wintun_idx,
            ],
        )
        .await
        .map_err(|e| format!("route add 128.0.0.0/1 failed: {e}"))?;

        self.configure_ipv6_tunnel().await?;

        Ok(())
    }

    async fn configure_ipv6_tunnel(&self) -> Result<(), String> {
        self.reset_ipv6_tunnel().await;

        run_cmd(
            "netsh",
            &[
                "interface",
                "ipv6",
                "add",
                "address",
                &format!("interface={}", WINTUN_ADAPTER),
                &format!("address={}", WINTUN_IPV6_CIDR),
                "store=active",
            ],
        )
        .await
        .map_err(|e| format!("netsh ipv6 add address failed: {e}"))?;

        run_cmd(
            "netsh",
            &[
                "interface",
                "ipv6",
                "add",
                "route",
                &format!("prefix={}", WINTUN_PUBLIC_IPV6_ROUTE),
                &format!("interface={}", WINTUN_ADAPTER),
                "metric=1",
                "store=active",
            ],
        )
        .await
        .map_err(|e| format!("netsh ipv6 add route failed: {e}"))?;

        Ok(())
    }

    async fn reset_ipv6_tunnel(&self) {
        let _ = run_cmd(
            "netsh",
            &[
                "interface",
                "ipv6",
                "delete",
                "route",
                &format!("prefix={}", WINTUN_PUBLIC_IPV6_ROUTE),
                &format!("interface={}", WINTUN_ADAPTER),
                "store=active",
            ],
        )
        .await;

        let _ = run_cmd(
            "netsh",
            &[
                "interface",
                "ipv6",
                "delete",
                "address",
                &format!("interface={}", WINTUN_ADAPTER),
                &format!("address={}", WINTUN_IPV6),
                "store=active",
            ],
        )
        .await;
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

        // Kill xray
        if let Some(mut child) = self.xray_process.lock().await.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        // Kill tun2socks (wintun adapter goes away with it)
        if let Some(mut child) = self.tun2socks_process.lock().await.take() {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }

        // Remove bypass route
        if let Some(server_ip) = self.server_ip.lock().await.take() {
            let _ = run_cmd("route", &["delete", &server_ip]).await;
        }

        // Remove split-default routes installed by start_tun (best-effort —
        // they're gone with the wintun adapter anyway, but explicit cleanup
        // avoids stale entries surviving an abnormal shutdown).
        let _ = run_cmd("route", &["delete", "0.0.0.0", "mask", "128.0.0.0"]).await;
        let _ = run_cmd("route", &["delete", "128.0.0.0", "mask", "128.0.0.0"]).await;
        self.reset_ipv6_tunnel().await;

        // Reset wintun adapter address (in case adapter is still listed)
        if adapter_exists(WINTUN_ADAPTER).await {
            let _ = run_cmd(
                "netsh",
                &[
                    "interface",
                    "ipv4",
                    "set",
                    "address",
                    &format!("name={}", WINTUN_ADAPTER),
                    "source=dhcp",
                ],
            )
            .await;
        }

        let _ = std::fs::remove_file(app_data_dir().join("xray.json"));
    }
}

// ── helpers ────────────────────────────────────────────────────────

/// True if the current process token has admin privileges.
/// `net session` is the most reliable cross-version probe: it requires admin
/// and exits non-zero with "Access is denied" otherwise.
async fn is_elevated() -> bool {
    let fut = Command::new("net")
        .args(["session"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
    match timeout(SUBPROC_TIMEOUT, fut).await {
        Ok(Ok(s)) => s.success(),
        Ok(Err(e)) => {
            log_win!("[is_elevated] net session spawn err: {e}");
            false
        }
        Err(_) => {
            log_win!("[is_elevated] net session timed out");
            false
        }
    }
}

async fn run_cmd(cmd: &str, args: &[&str]) -> Result<(), String> {
    log_win!("[CMD] {} {}", cmd, args.join(" "));
    let fut = Command::new(cmd)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let output = match timeout(SUBPROC_TIMEOUT, fut).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("{} spawn failed: {e}", cmd)),
        Err(_) => {
            return Err(format!(
                "{} timed out after {}s",
                cmd,
                SUBPROC_TIMEOUT.as_secs()
            ))
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "{} {} exit {}: {}{}",
            cmd,
            args.join(" "),
            output.status,
            stderr.trim(),
            stdout.trim()
        ));
    }
    log_win!("[CMD OK] {} {}", cmd, args.join(" "));
    Ok(())
}

/// Returns (next_hop, interface_index) for the lowest-metric IPv4 default
/// route that is NOT our own wintun adapter.
///
/// On cellular / PPP / metered tethering setups Windows often shows the
/// default route as "on-link" (NextHop = 0.0.0.0). For those we substitute
/// the local interface address as the next-hop so callers can pass it to
/// `route add ... if <idx>` — Windows treats a gateway equal to the
/// interface's own IP as on-link and routes the packet out that interface.
async fn get_default_gateway() -> Option<(String, String)> {
    log_win!("[get_default_gateway] querying Get-NetRoute");
    let cmd = format!(
        "$r = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | \
         Where-Object {{ $_.InterfaceAlias -ne '{adapter}' }} | \
         Sort-Object RouteMetric | Select-Object -First 1; \
         if ($r) {{ \
           $ip = (Get-NetIPAddress -InterfaceIndex $r.InterfaceIndex -AddressFamily IPv4 \
                  -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress; \
           Write-Host \"$($r.NextHop) $($r.InterfaceIndex) $ip\" \
         }}",
        adapter = WINTUN_ADAPTER
    );
    let fut = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &cmd])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let out = match timeout(SUBPROC_TIMEOUT, fut).await {
        Ok(Ok(o)) => Some(o),
        Ok(Err(e)) => {
            log_win!("[get_default_gateway] spawn err: {e}");
            None
        }
        Err(_) => {
            log_win!("[get_default_gateway] timed out");
            None
        }
    };

    if let Some(out) = out {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            let trimmed = s.trim();
            log_win!("[get_default_gateway] raw: {:?}", trimmed);
            let mut parts = trimmed.split_whitespace();
            let next_hop = parts.next().unwrap_or("");
            let idx = parts.next().unwrap_or("");
            let iface_ip = parts.next().unwrap_or("");
            if !idx.is_empty() {
                let gw = if next_hop == "0.0.0.0" || next_hop.is_empty() {
                    iface_ip.to_string()
                } else {
                    next_hop.to_string()
                };
                if !gw.is_empty() {
                    return Some((gw, idx.to_string()));
                }
            }
        } else {
            log_win!("[get_default_gateway] non-zero exit");
        }
    }

    // Fallback: parse `route print -4`. Default rows have destination 0.0.0.0
    // and mask 0.0.0.0. Format:
    //   "          0.0.0.0          0.0.0.0      <gw>          <iface>     <metric>"
    // The gw column is literal "On-link" for on-link routes (cellular, PPP,
    // some tethered configurations).
    log_win!("[get_default_gateway] falling back to `route print -4`");
    let fut2 = Command::new("route")
        .args(["print", "-4"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let out2 = match timeout(SUBPROC_TIMEOUT, fut2).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            log_win!("[get_default_gateway] route print spawn err: {e}");
            return None;
        }
        Err(_) => {
            log_win!("[get_default_gateway] route print timed out");
            return None;
        }
    };
    let s = String::from_utf8_lossy(&out2.stdout);
    let mut best: Option<(u64, String, String)> = None;
    for line in s.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5 {
            continue;
        }
        if parts[0] != "0.0.0.0" || parts[1] != "0.0.0.0" {
            continue;
        }
        let gw_raw = parts[2];
        let iface_ip = parts[3].to_string();
        let metric: u64 = parts[4].parse().unwrap_or(u64::MAX);
        if iface_ip == WINTUN_IP || iface_ip == WINTUN_GATEWAY {
            continue;
        }
        // On-link rows have no real next-hop IP; collapse to the iface IP so
        // the caller can use it as a gateway placeholder with `if <idx>`.
        let gw = if gw_raw.eq_ignore_ascii_case("on-link") || gw_raw == "0.0.0.0" {
            iface_ip.clone()
        } else {
            gw_raw.to_string()
        };
        if best.as_ref().map(|b| metric < b.0).unwrap_or(true) {
            best = Some((metric, gw, iface_ip));
        }
    }
    if let Some((_metric, gw, iface_ip)) = best {
        log_win!(
            "[get_default_gateway] route print picked gw={} iface={}",
            gw,
            iface_ip
        );
        let cmd = format!(
            "(Get-NetIPAddress -IPAddress '{}' -ErrorAction SilentlyContinue | Select-Object -First 1).InterfaceIndex",
            iface_ip
        );
        let idx_fut = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &cmd])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        if let Ok(Ok(o)) = timeout(SUBPROC_TIMEOUT, idx_fut).await {
            let idx = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !idx.is_empty() {
                return Some((gw, idx));
            }
        }
    }
    None
}

/// Returns the wintun adapter's InterfaceIndex as a string suitable for
/// `route add ... if <idx>`. None when the adapter is missing or PowerShell
/// times out.
async fn get_adapter_index(name: &str) -> Option<String> {
    let cmd = format!(
        "(Get-NetAdapter -Name '{}' -ErrorAction SilentlyContinue | Select-Object -First 1).ifIndex",
        name
    );
    let fut = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &cmd])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match timeout(SUBPROC_TIMEOUT, fut).await {
        Ok(Ok(o)) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        }
        _ => None,
    }
}

async fn adapter_exists(name: &str) -> bool {
    let fut = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!(
                "if (Get-NetAdapter -Name '{}' -ErrorAction SilentlyContinue) {{ Write-Host found }}",
                name
            ),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match timeout(POLL_TIMEOUT, fut).await {
        Ok(Ok(o)) => o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "found",
        Ok(Err(e)) => {
            log_win!("[adapter_exists] spawn err: {e}");
            false
        }
        Err(_) => {
            log_win!("[adapter_exists] timed out");
            false
        }
    }
}

async fn wait_for_port(port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
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
        sleep(Duration::from_millis(200)).await;
    }
}

async fn query_stat_value(xray_bin: &PathBuf, server: &str, name: &str) -> u64 {
    let output = Command::new(xray_bin)
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
