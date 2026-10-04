//! End-to-end server check, ported from the Android client
//! (BaseStationBypassProfileProbeRepository). An open TCP port proves little;
//! here every profile carries a real HTTPS request through a complete Xray
//! outbound (VLESS, transport, TLS/REALITY). One temporary Xray process gets
//! a local HTTP inbound per server, routed to that server's outbound. It never
//! touches the running tunnel: own process, random loopback ports, no TUN.

use std::collections::HashMap;
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
const MAX_SERVERS: usize = 64;
const MAX_CONCURRENT_PROBES: usize = 16;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 15_000;
const XRAY_READY_TIMEOUT: Duration = Duration::from_secs(5);
/// A server is not marked unavailable because one public endpoint is
/// filtered: the second target is tried only after the first fails.
const PROBE_TARGETS: [&str; 2] = [
    "https://www.gstatic.com/generate_204",
    "https://cp.cloudflare.com/generate_204",
];

/// Bumped by every new run and by cancel; a run stops reporting once stale.
static RUN_GENERATION: AtomicU64 = AtomicU64::new(0);

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
    let xray = {
        let guard = state.0.lock().await;
        guard
            .as_ref()
            .map(|manager| manager.xray_binary())
            .ok_or_else(|| "VPN manager is not ready".to_string())?
    };

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
            checks.push(tokio::spawn(async move {
                let _permit = slots.acquire_owned().await.ok()?;
                let open = server.config.validate().is_ok()
                    && tcp_open(&server.config.address, server.config.port, timeout).await;
                Some((server, open))
            }));
        }
        for check in checks {
            if let Ok(Some((server, open))) = check.await {
                if open {
                    reachable.push(server);
                } else {
                    report(&server.id, -1);
                }
            }
        }
    }
    if reachable.is_empty() || RUN_GENERATION.load(Ordering::SeqCst) != generation {
        return Ok(take_results(&results));
    }

    // 2. One Xray with an HTTP inbound per reachable server.
    let mut ports = Vec::with_capacity(reachable.len());
    for _ in &reachable {
        ports.push(free_loopback_port()?);
    }
    let config = probe_config(&reachable, &ports);
    let mut child = match spawn_xray(&xray, &config).await {
        Ok(child) => child,
        Err(error) => {
            diagnostics::record_native("ServerProbe", &format!("Xray start failed: {error}"));
            for server in &reachable {
                report(&server.id, -1);
            }
            return Ok(take_results(&results));
        }
    };
    if !wait_for_ports(&ports).await {
        diagnostics::record_native("ServerProbe", "Xray inbounds did not open in time");
    }

    // 3. A real request through each outbound.
    let slots = Arc::new(Semaphore::new(MAX_CONCURRENT_PROBES));
    let mut probes = Vec::new();
    for (server, port) in reachable.into_iter().zip(ports) {
        let slots = slots.clone();
        let report = report.clone();
        probes.push(tokio::spawn(async move {
            let Ok(_permit) = slots.acquire_owned().await else {
                return;
            };
            if RUN_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            let delay = measure_through_proxy(port, timeout, generation).await;
            report(&server.id, delay);
        }));
    }
    for probe in probes {
        let _ = probe.await;
    }
    let _ = child.kill().await;

    let results = take_results(&results);
    let verified = results.values().filter(|delay| **delay > 0).count();
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

async fn tcp_open(host: &str, port: u16, timeout: Duration) -> bool {
    matches!(
        tokio::time::timeout(timeout, TcpStream::connect((host, port))).await,
        Ok(Ok(_))
    )
}

fn free_loopback_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|error| format!("No free local port: {error}"))
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

fn probe_config(servers: &[ProbeServer], ports: &[u16]) -> String {
    let mut inbounds = Vec::new();
    let mut outbounds = Vec::new();
    let mut rules = Vec::new();
    for (index, (server, port)) in servers.iter().zip(ports).enumerate() {
        let inbound = format!("probe-in-{index}");
        let outbound = format!("probe-out-{index}");
        inbounds.push(json!({
            "tag": inbound,
            "listen": "127.0.0.1",
            "port": port,
            "protocol": "http",
            "settings": {}
        }));
        outbounds.push(build_proxy_outbound(
            &probe_outbound_server(&server.config),
            &outbound,
        ));
        rules.push(json!({
            "type": "field",
            "inboundTag": [inbound],
            "outboundTag": outbound
        }));
    }
    json!({
        "log": { "loglevel": "none" },
        "inbounds": inbounds,
        "outbounds": outbounds,
        "routing": { "domainStrategy": "AsIs", "rules": rules }
    })
    .to_string()
}

async fn spawn_xray(xray: &std::path::Path, config: &str) -> Result<tokio::process::Child, String> {
    let mut command = tokio::process::Command::new(xray);
    // The config holds VLESS ids and REALITY keys: pass it on stdin rather
    // than writing it to disk.
    command
        .args(["run", "-config", "stdin:"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start Xray: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Xray stdin unavailable".to_string())?;
    stdin
        .write_all(config.as_bytes())
        .await
        .map_err(|error| format!("could not pass the config: {error}"))?;
    drop(stdin);
    Ok(child)
}

async fn wait_for_ports(ports: &[u16]) -> bool {
    let deadline = Instant::now() + XRAY_READY_TIMEOUT;
    for port in ports {
        let address = SocketAddr::from(([127, 0, 0, 1], *port));
        loop {
            if TcpStream::connect(address).await.is_ok() {
                break;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    true
}

async fn measure_through_proxy(port: u16, timeout: Duration, generation: u64) -> i64 {
    let client = match reqwest::Client::builder()
        .proxy(
            match reqwest::Proxy::all(format!("http://127.0.0.1:{port}")) {
                Ok(proxy) => proxy,
                Err(_) => return -1,
            },
        )
        .timeout(timeout)
        .build()
    {
        Ok(client) => client,
        Err(_) => return -1,
    };
    for target in PROBE_TARGETS {
        if RUN_GENERATION.load(Ordering::SeqCst) != generation {
            return -1;
        }
        let started = Instant::now();
        if let Ok(response) = client.get(target).send().await {
            if response.status().is_success() {
                return (started.elapsed().as_millis() as i64).max(1);
            }
        }
    }
    -1
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
    fn routes_each_inbound_to_its_own_server() {
        let servers = [server("a.example", ""), server("10.0.0.2", "b.example")];
        let config: serde_json::Value =
            serde_json::from_str(&probe_config(&servers, &[20001, 20002])).unwrap();
        assert_eq!(config["inbounds"][1]["port"], 20002);
        assert_eq!(config["inbounds"][1]["protocol"], "http");
        assert_eq!(config["routing"]["rules"][1]["inboundTag"][0], "probe-in-1");
        assert_eq!(config["routing"]["rules"][1]["outboundTag"], "probe-out-1");
        assert_eq!(config["outbounds"][1]["tag"], "probe-out-1");
        // The domain becomes the SNI when the panel left it empty.
        assert_eq!(
            config["outbounds"][0]["streamSettings"]["realitySettings"]["serverName"],
            "a.example"
        );
        assert_eq!(
            config["outbounds"][1]["streamSettings"]["realitySettings"]["serverName"],
            "b.example"
        );
    }
}
