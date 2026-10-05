//! End-to-end server check, ported from the Android client
//! (BaseStationBypassProfileProbeRepository). An open TCP port proves little;
//! here every profile carries a real HTTPS request through a complete Xray
//! outbound (VLESS, transport, TLS/REALITY). Like Android, which starts one
//! core instance per profile, every server gets its own short-lived Xray with
//! a single local HTTP inbound: a profile Xray rejects fails alone instead of
//! keeping the whole check from starting. It never touches the running
//! tunnel: own processes, random loopback ports, no TUN.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, SocketAddr, TcpListener};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::Emitter;
use tauri_plugin_http::reqwest;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::Semaphore;

use crate::diagnostics;
use crate::vpn::config::{build_proxy_outbound, ServerConfig};

const PROBE_EVENT: &str = "server-probe-result";
const MAX_SERVERS: usize = 256;
const MAX_CONCURRENT_PROBES: usize = 16;
/// Xray processes alive at once (each one is a separate core).
const MAX_CONCURRENT_CORES: usize = 8;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 15_000;
const XRAY_READY_TIMEOUT: Duration = Duration::from_secs(4);
/// A server is not marked unavailable because one public endpoint is
/// filtered: the second target is tried only after the first fails.
const PROBE_TARGETS: [&str; 2] = [
    "https://www.gstatic.com/generate_204",
    "https://cp.cloudflare.com/generate_204",
];

/// Bumped by every new run and by cancel; a run stops reporting once stale.
static RUN_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Per-server outcome of the last check, written to
/// ~/.cache/tobevpn/server-check.log (endpoint, transport and the reason a
/// server failed; never ids or keys) so a mismatch with the phone can be
/// traced to its cause.
static CHECK_LOG: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

fn check_log(line: String) {
    CHECK_LOG
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .push(line);
}

fn profile_label(server: &ServerConfig) -> String {
    format!(
        "{}:{} type={} security={} flow={} sni={}",
        server.address,
        server.port,
        server.network,
        server.security,
        if server.flow.is_empty() {
            "-"
        } else {
            &server.flow
        },
        if server.sni.is_empty() {
            "-"
        } else {
            &server.sni
        },
    )
}

fn write_check_log(header: String) {
    let lines = std::mem::take(&mut *CHECK_LOG.lock().unwrap_or_else(|p| p.into_inner()));
    let Some(dir) = dirs::cache_dir().map(|dir| dir.join("tobevpn")) else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(
        dir.join("server-check.log"),
        format!("{header}\n{}\n", lines.join("\n")),
    );
}

#[derive(Debug, Deserialize)]
pub struct ProbeServer {
    pub id: String,
    pub config: ServerConfig,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResultEvent {
    run_id: u64,
    server_id: String,
    /// Positive: a request went through the whole outbound. -1: not confirmed.
    delay_ms: i64,
    completed: usize,
    total: usize,
}

/// Checks every server and reports each result as soon as it is known via
/// the `server-probe-result` event. Returns all results by server id.
#[tauri::command]
pub async fn probe_server_profiles(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppVpn>,
    run_id: u64,
    servers: Vec<ProbeServer>,
    timeout_ms: u64,
) -> Result<HashMap<String, i64>, String> {
    if servers.len() > MAX_SERVERS {
        return Err("Too many servers to check".into());
    }
    let timeout = Duration::from_millis(timeout_ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS));
    let generation = RUN_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    // With the tunnel up, the check must not travel inside it: the active
    // server rarely reaches the others, so they all looked unavailable. Bind
    // the check to the physical interface, as the tunnel's own direct
    // traffic is (Android excludes its own app from the VPN the same way).
    let (xray, bypass_interface) = {
        let guard = state.0.lock().await;
        let manager = guard
            .as_ref()
            .ok_or_else(|| "VPN manager is not ready".to_string())?;
        (
            manager.xray_binary(),
            manager.tunnel_bypass_interface().await,
        )
    };
    let bypass_interface: Option<Arc<str>> = bypass_interface.map(Arc::from);
    CHECK_LOG.lock().unwrap_or_else(|p| p.into_inner()).clear();
    let check_started = Instant::now();

    let total = servers.len();
    let completed = Arc::new(AtomicU64::new(0));
    let results = Arc::new(std::sync::Mutex::new(HashMap::<String, i64>::new()));
    let report = {
        let app = app.clone();
        let completed = completed.clone();
        let results = results.clone();
        move |server_id: &str, delay_ms: i64| {
            if RUN_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            let done = completed.fetch_add(1, Ordering::SeqCst) as usize + 1;
            results
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .insert(server_id.to_string(), delay_ms);
            let _ = app.emit(
                PROBE_EVENT,
                ProbeResultEvent {
                    run_id,
                    server_id: server_id.to_string(),
                    delay_ms,
                    completed: done,
                    total,
                },
            );
        }
    };

    // 1. A closed TCP port fails at once instead of waiting for Xray.
    let mut reachable = Vec::new();
    {
        let slots = Arc::new(Semaphore::new(MAX_CONCURRENT_PROBES));
        let mut checks = Vec::new();
        for server in servers {
            let slots = slots.clone();
            let bypass = bypass_interface.clone();
            checks.push(tokio::spawn(async move {
                let _permit = slots.acquire_owned().await.ok()?;
                let open = server.config.validate().is_ok()
                    && tcp_open(
                        &server.config.address,
                        server.config.port,
                        timeout,
                        bypass.as_deref(),
                    )
                    .await;
                Some((server, open))
            }));
        }
        for check in checks {
            if let Ok(Some((server, open))) = check.await {
                if open {
                    reachable.push(server);
                } else {
                    check_log(format!(
                        "{} -> TCP port closed",
                        profile_label(&server.config)
                    ));
                    report(&server.id, -1);
                }
            }
        }
    }
    if reachable.is_empty() || RUN_GENERATION.load(Ordering::SeqCst) != generation {
        return Ok(take_results(&results));
    }

    // 2. Per server: its own Xray, then one real request through it.
    let slots = Arc::new(Semaphore::new(MAX_CONCURRENT_CORES));
    let ports = Arc::new(std::sync::Mutex::new(HashSet::<u16>::new()));
    let rejected = Arc::new(AtomicU64::new(0));
    let mut probes = Vec::new();
    for server in reachable {
        let slots = slots.clone();
        let report = report.clone();
        let xray = xray.clone();
        let ports = ports.clone();
        let rejected = rejected.clone();
        let bypass = bypass_interface.clone();
        probes.push(tokio::spawn(async move {
            let Ok(_permit) = slots.acquire_owned().await else {
                return;
            };
            if RUN_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            let delay = match probe_one(
                &xray,
                &server.config,
                bypass.as_deref(),
                timeout,
                generation,
                &ports,
            )
            .await
            {
                Ok((delay, detail)) => {
                    check_log(format!(
                        "{} -> {}",
                        profile_label(&server.config),
                        if delay > 0 {
                            format!("OK {delay} ms")
                        } else {
                            format!("FAILED: {detail}")
                        }
                    ));
                    delay
                }
                Err(detail) => {
                    rejected.fetch_add(1, Ordering::SeqCst);
                    check_log(format!(
                        "{} -> XRAY DID NOT START: {detail}",
                        profile_label(&server.config)
                    ));
                    -1
                }
            };
            report(&server.id, delay);
        }));
    }
    for probe in probes {
        let _ = probe.await;
    }
    let rejected = rejected.load(Ordering::SeqCst);
    if rejected > 0 {
        diagnostics::record_native(
            "ServerProbe",
            &format!("Xray did not start for {rejected} profile(s)"),
        );
    }

    let results = take_results(&results);
    let verified = results.values().filter(|delay| **delay > 0).count();
    write_check_log(format!(
        "ToBeVPN server check: total={total} verified={verified} timeout_ms={} bypass_interface={} elapsed_ms={}",
        timeout.as_millis(),
        bypass_interface.as_deref().unwrap_or("-"),
        check_started.elapsed().as_millis()
    ));
    diagnostics::record_native(
        "ServerProbe",
        &format!(
            "Xray profile check completed: total={total}, verified={verified}, timeout_ms={}",
            timeout.as_millis()
        ),
    );
    Ok(results)
}

/// Stops reporting for the current run (screen closed or a new check).
#[tauri::command]
pub fn cancel_server_probe() {
    RUN_GENERATION.fetch_add(1, Ordering::SeqCst);
}

fn take_results(results: &std::sync::Mutex<HashMap<String, i64>>) -> HashMap<String, i64> {
    results
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone()
}

async fn tcp_open(host: &str, port: u16, timeout: Duration, bypass: Option<&str>) -> bool {
    match bypass {
        None => matches!(
            tokio::time::timeout(timeout, TcpStream::connect((host, port))).await,
            Ok(Ok(_))
        ),
        Some(interface) => tcp_open_bypassing_tunnel(host, port, timeout, interface).await,
    }
}

#[cfg(target_os = "linux")]
async fn tcp_open_bypassing_tunnel(
    host: &str,
    port: u16,
    timeout: Duration,
    interface: &str,
) -> bool {
    let attempt = async {
        let addresses = tokio::net::lookup_host((host, port)).await.ok()?;
        for address in addresses {
            let socket = if address.is_ipv4() {
                tokio::net::TcpSocket::new_v4()
            } else {
                tokio::net::TcpSocket::new_v6()
            }
            .ok()?;
            if socket.bind_device(Some(interface.as_bytes())).is_err() {
                continue;
            }
            if socket.connect(address).await.is_ok() {
                return Some(());
            }
        }
        None
    };
    matches!(tokio::time::timeout(timeout, attempt).await, Ok(Some(())))
}

/// Windows: no unprivileged way to pin this socket to the adapter here, and a
/// probe through the tunnel would fail for the wrong reason. Let the Xray
/// check (bound to the adapter) decide.
#[cfg(not(target_os = "linux"))]
async fn tcp_open_bypassing_tunnel(
    _host: &str,
    _port: u16,
    _timeout: Duration,
    _interface: &str,
) -> bool {
    true
}

/// A free loopback port not handed to another probe of this run (the OS may
/// return a port again once its listener is closed).
fn reserve_port(ports: &std::sync::Mutex<HashSet<u16>>) -> Option<u16> {
    for _ in 0..32 {
        let port = TcpListener::bind("127.0.0.1:0")
            .and_then(|listener| listener.local_addr())
            .ok()?
            .port();
        if ports.lock().unwrap_or_else(|p| p.into_inner()).insert(port) {
            return Some(port);
        }
    }
    None
}

/// One server through its own Xray. Err: Xray did not start (rejected the
/// profile or exited); Ok((-1, why)): started but no confirmed response.
async fn probe_one(
    xray: &std::path::Path,
    server: &ServerConfig,
    bypass_interface: Option<&str>,
    timeout: Duration,
    generation: u64,
    ports: &std::sync::Mutex<HashSet<u16>>,
) -> Result<(i64, String), String> {
    let port = reserve_port(ports).ok_or_else(|| "no free local port".to_string())?;
    let result = async {
        let (mut child, output) =
            spawn_xray(xray, &probe_config(server, port, bypass_interface)).await?;
        if !wait_for_port(port, &mut child).await {
            let _ = child.kill().await;
            tokio::time::sleep(Duration::from_millis(100)).await;
            return Err(last_lines(&output, "inbound did not open"));
        }
        let (delay, error) = measure_through_proxy(port, timeout, generation).await;
        let _ = child.kill().await;
        let detail = if delay > 0 {
            String::new()
        } else {
            format!("{error}; xray: {}", last_lines(&output, "-"))
        };
        Ok((delay, detail))
    }
    .await;
    ports
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&port);
    result
}

/// Last lines of Xray's output (its warnings name the failing step).
fn last_lines(output: &std::sync::Mutex<Vec<String>>, empty: &str) -> String {
    let lines = output.lock().unwrap_or_else(|p| p.into_inner());
    if lines.is_empty() {
        return empty.to_string();
    }
    lines
        .iter()
        .rev()
        .take(3)
        .rev()
        .cloned()
        .collect::<Vec<_>>()
        .join(" | ")
}

/// Same profile rules as a connection: the SNI falls back to the server's
/// domain when the panel leaves it empty.
fn probe_outbound_server(server: &ServerConfig) -> ServerConfig {
    let mut server = server.clone();
    if server.sni.is_empty() && server.address.parse::<IpAddr>().is_err() {
        server.sni = server.address.clone();
    }
    server
}

/// One HTTP inbound and the server's outbound: the profile exactly as a
/// connection uses it (routing rules, DNS, stats and mux are left out, as in
/// Android's buildOutboundDelayConfigJson).
fn probe_config(server: &ServerConfig, port: u16, bypass_interface: Option<&str>) -> String {
    let mut outbound = build_proxy_outbound(&probe_outbound_server(server), "probe-out");
    if let Some(interface) = bypass_interface {
        outbound["streamSettings"]["sockopt"] = json!({ "interface": interface });
    }
    json!({
        "log": { "loglevel": "warning" },
        "inbounds": [{
            "tag": "probe-in",
            "listen": "127.0.0.1",
            "port": port,
            "protocol": "http",
            "settings": {}
        }],
        "outbounds": [outbound]
    })
    .to_string()
}

type XrayOutput = Arc<std::sync::Mutex<Vec<String>>>;

async fn spawn_xray(
    xray: &std::path::Path,
    config: &str,
) -> Result<(tokio::process::Child, XrayOutput), String> {
    use tokio::io::AsyncBufReadExt;

    let mut command = tokio::process::Command::new(xray);
    // The config holds VLESS ids and REALITY keys: pass it on stdin rather
    // than writing it to disk.
    command
        .args(["run", "-config", "stdin:"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start Xray: {error}"))?;
    let output: XrayOutput = Arc::new(std::sync::Mutex::new(Vec::new()));
    let collect = |reader: Option<Box<dyn tokio::io::AsyncRead + Unpin + Send>>| {
        let output = output.clone();
        if let Some(reader) = reader {
            tokio::spawn(async move {
                let mut lines = tokio::io::BufReader::new(reader).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut stored = output.lock().unwrap_or_else(|p| p.into_inner());
                    if stored.len() >= 40 {
                        stored.remove(0);
                    }
                    stored.push(line.chars().take(300).collect());
                }
            });
        }
    };
    collect(child.stdout.take().map(|r| Box::new(r) as _));
    collect(child.stderr.take().map(|r| Box::new(r) as _));
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Xray stdin unavailable".to_string())?;
    stdin
        .write_all(config.as_bytes())
        .await
        .map_err(|error| format!("could not pass the config: {error}"))?;
    drop(stdin);
    Ok((child, output))
}

/// Waits for the inbound to accept connections; false if Xray exited first
/// (it rejected the config) or did not come up in time.
async fn wait_for_port(port: u16, child: &mut tokio::process::Child) -> bool {
    let deadline = Instant::now() + XRAY_READY_TIMEOUT;
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    loop {
        if TcpStream::connect(address).await.is_ok() {
            return true;
        }
        if matches!(child.try_wait(), Ok(Some(_))) || Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

/// Same measurement as AndroidLibXrayLite's measureInstDelay (v26.9.30):
/// two requests over one kept-alive connection, the shorter one counts, 200
/// or 204 with the body read. The first request pays for the VLESS/REALITY
/// and TLS handshakes; the second shows the latency through the server, which
/// is the number the phone reports.
async fn measure_through_proxy(port: u16, timeout: Duration, generation: u64) -> (i64, String) {
    let Ok(proxy) = reqwest::Proxy::all(format!("http://127.0.0.1:{port}")) else {
        return (-1, "proxy setup failed".into());
    };
    let Ok(client) = reqwest::Client::builder()
        .proxy(proxy)
        .timeout(Duration::from_secs(12))
        .build()
    else {
        return (-1, "client setup failed".into());
    };
    let mut last_error = String::from("no attempt");
    for target in PROBE_TARGETS {
        if RUN_GENERATION.load(Ordering::SeqCst) != generation {
            return (-1, "cancelled".into());
        }
        let mut errors = Vec::new();
        let attempts = async {
            let mut best: Option<i64> = None;
            for _ in 0..2 {
                let started = Instant::now();
                let response = match client.get(target).send().await {
                    Ok(response) => response,
                    Err(error) => {
                        errors.push(format!("{error:?}").chars().take(200).collect::<String>());
                        continue;
                    }
                };
                let status = response.status().as_u16();
                let body = response.bytes().await;
                if (status == 200 || status == 204) && body.is_ok() {
                    let elapsed = (started.elapsed().as_millis() as i64).max(1);
                    best = Some(best.map_or(elapsed, |current| current.min(elapsed)));
                } else {
                    errors.push(format!("status {status}"));
                }
            }
            best
        };
        match tokio::time::timeout(timeout, attempts).await {
            Ok(Some(delay)) => return (delay, String::new()),
            Ok(None) => last_error = format!("{target}: {}", errors.join(" / ")),
            Err(_) => last_error = format!("{target}: timed out after {} ms", timeout.as_millis()),
        }
    }
    (-1, last_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(address: &str, sni: &str) -> ProbeServer {
        ProbeServer {
            id: address.into(),
            config: serde_json::from_value(json!({
                "address": address,
                "port": 443,
                "uuid": "11111111-1111-4111-8111-111111111111",
                "sni": sni,
                "public_key": "key",
            }))
            .unwrap(),
        }
    }

    #[test]
    fn one_inbound_routed_to_the_server_profile() {
        for (probe, sni) in [
            (server("a.example", ""), "a.example"),
            (server("10.0.0.2", "b.example"), "b.example"),
        ] {
            let config: serde_json::Value =
                serde_json::from_str(&probe_config(&probe.config, 20002, None)).unwrap();
            assert_eq!(config["inbounds"][0]["port"], 20002);
            assert_eq!(config["inbounds"][0]["protocol"], "http");
            assert_eq!(config["outbounds"].as_array().unwrap().len(), 1);
            assert_eq!(config["outbounds"][0]["protocol"], "vless");
            // The domain becomes the SNI when the panel left it empty.
            assert_eq!(
                config["outbounds"][0]["streamSettings"]["realitySettings"]["serverName"],
                sni
            );
        }
    }

    #[test]
    fn reserved_ports_are_unique() {
        let ports = std::sync::Mutex::new(HashSet::new());
        let picked: HashSet<u16> = (0..20).filter_map(|_| reserve_port(&ports)).collect();
        assert_eq!(picked.len(), 20);
    }

    /// Live check against a local VLESS server on the bundled Xray:
    /// `TOBEVPN_TEST_XRAY=/path/to/xray cargo test -- --ignored live_probe`.
    #[tokio::test]
    #[ignore]
    async fn live_probe_through_local_vless_server() {
        let xray = std::path::PathBuf::from(std::env::var("TOBEVPN_TEST_XRAY").unwrap());
        let ports = std::sync::Mutex::new(HashSet::new());
        let server_port = reserve_port(&ports).unwrap();
        let server_config = json!({
            "log": { "loglevel": "none" },
            "inbounds": [{
                "listen": "127.0.0.1", "port": server_port, "protocol": "vless",
                "settings": { "clients": [{ "id": "11111111-1111-4111-8111-111111111111" }], "decryption": "none" }
            }],
            "outbounds": [{ "protocol": "freedom" }]
        });
        let (mut vless_server, _vless_output) =
            spawn_xray(&xray, &server_config.to_string()).await.unwrap();
        assert!(wait_for_port(server_port, &mut vless_server).await);

        let profile: ServerConfig = serde_json::from_value(json!({
            "address": "127.0.0.1", "port": server_port,
            "uuid": "11111111-1111-4111-8111-111111111111",
            "security": "none", "network": "tcp"
        }))
        .unwrap();
        let good = probe_one(
            &xray,
            &profile,
            None,
            Duration::from_secs(7),
            RUN_GENERATION.load(Ordering::SeqCst),
            &ports,
        )
        .await;
        let mut broken = profile.clone();
        broken.network = "ws".into();
        broken.security = "reality".into(); // Xray rejects REALITY over ws
        let rejected = probe_one(
            &xray,
            &broken,
            None,
            Duration::from_secs(7),
            RUN_GENERATION.load(Ordering::SeqCst),
            &ports,
        )
        .await;
        let _ = vless_server.kill().await;
        eprintln!("good={good:?} rejected={rejected:?}");
        assert!(matches!(good, Ok((delay, _)) if delay > 0));
        assert!(rejected.is_err());
    }
}
