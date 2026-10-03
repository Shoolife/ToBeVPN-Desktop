//! Manual speed test, ported from the Android client's SpeedTestViewModel.
//!
//! Runs in Rust instead of the webview: the fallback provider (Selectel) sends
//! no CORS headers, and four parallel native streams are needed to measure
//! fast links the way the phone does. When the VPN is up, the OS routes this
//! traffic through the tunnel like any other process.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_http::reqwest::{self, Client};

const TEST_DURATION: Duration = Duration::from_secs(10);
const PARALLEL_STREAMS: usize = 4;
const WARMUP_STREAMS: usize = 2;
const WARMUP_BYTES: u64 = 1_000_000;
const DOWNLOAD_CHUNK_BYTES: u64 = 25_000_000;
const PING_SAMPLE_COUNT: usize = 7;
const PREFLIGHT_TIMEOUT: Duration = Duration::from_secs(5);
const UI_UPDATE_INTERVAL: Duration = Duration::from_millis(250);
const MAX_TRANSIENT_FAILURES_PER_STREAM: u32 = 2;
const REQUEST_RETRY_BASE_DELAY: Duration = Duration::from_millis(250);
const CLOUDFLARE_ENDPOINT: &str = "https://speed.cloudflare.com/__down";
const SELECTEL_LATENCY_ENDPOINT: &str = "https://speedtest.selectel.ru/10MB";
const SELECTEL_DOWNLOAD_ENDPOINT: &str = "https://speedtest.selectel.ru/100MB";
const PROGRESS_EVENT: &str = "speed-test-progress";

/// Id of the run allowed to continue; 0 when nothing should run. The UI picks
/// a fresh non-zero id per run, so a newer start or a cancel stops older work.
static RUN_GENERATION: AtomicU64 = AtomicU64::new(0);
static CACHE_BUST: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Provider {
    Cloudflare,
    Selectel,
}

const PROVIDERS: [Provider; 2] = [Provider::Cloudflare, Provider::Selectel];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    run_id: u64,
    phase: &'static str,
    ping_ms: Option<u64>,
    current_mbps: f64,
    progress: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedTestResult {
    run_id: u64,
    /// "ok", "cancelled", "no_connection" or "measure_failed".
    status: &'static str,
    ping_ms: Option<u64>,
    download_mbps: f64,
    provider: Option<&'static str>,
}

fn is_active(run_id: u64) -> bool {
    RUN_GENERATION.load(Ordering::SeqCst) == run_id
}

fn cache_bust() -> String {
    let n = CACHE_BUST.fetch_add(1, Ordering::Relaxed);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("{now:x}-{n}")
}

fn mbps(bytes: u64, seconds: f64) -> f64 {
    if bytes > 0 && seconds > 0.0 {
        (bytes as f64 * 8.0) / (seconds * 1_000_000.0)
    } else {
        0.0
    }
}

fn latency_request(client: &Client, provider: Provider) -> reqwest::RequestBuilder {
    let builder = match provider {
        Provider::Cloudflare => client.get(format!(
            "{CLOUDFLARE_ENDPOINT}?bytes=0&cacheBust={}",
            cache_bust()
        )),
        Provider::Selectel => client.head(SELECTEL_LATENCY_ENDPOINT),
    };
    builder
        .header("Accept-Encoding", "identity")
        .header("Cache-Control", "no-cache, no-store")
}

fn download_request(client: &Client, provider: Provider, bytes: u64) -> reqwest::RequestBuilder {
    let builder = match provider {
        Provider::Cloudflare => client.get(format!(
            "{CLOUDFLARE_ENDPOINT}?bytes={bytes}&cacheBust={}",
            cache_bust()
        )),
        Provider::Selectel => client
            .get(format!("{SELECTEL_DOWNLOAD_ENDPOINT}?cacheBust={}", cache_bust()))
            .header("Range", format!("bytes=0-{}", bytes - 1)),
    };
    builder
        .header("Accept-Encoding", "identity")
        .header("Cache-Control", "no-cache, no-store")
}

/// One request to the latency endpoint; returns its duration in ms.
async fn latency_probe(
    client: &Client,
    provider: Provider,
    timeout: Option<Duration>,
) -> Result<u64, String> {
    let mut request = latency_request(client, provider);
    if let Some(timeout) = timeout {
        request = request.timeout(timeout);
    }
    let start = Instant::now();
    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let _ = response.bytes().await;
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    Ok(start.elapsed().as_millis() as u64)
}

async fn find_reachable_provider(client: &Client, run_id: u64) -> Option<Provider> {
    for provider in PROVIDERS {
        if !is_active(run_id) {
            return None;
        }
        if latency_probe(client, provider, Some(PREFLIGHT_TIMEOUT)).await.is_ok() {
            return Some(provider);
        }
    }
    None
}

/// Median of several probes on a warmed-up connection, as on the phone.
async fn measure_ping(client: &Client, provider: Provider, run_id: u64) -> Option<u64> {
    // Establish DNS, TLS and the reusable HTTP connection first.
    latency_probe(client, provider, None).await.ok()?;
    let mut samples = Vec::with_capacity(PING_SAMPLE_COUNT);
    for _ in 0..PING_SAMPLE_COUNT {
        if !is_active(run_id) {
            return None;
        }
        samples.push(latency_probe(client, provider, None).await.ok()?);
    }
    samples.sort_unstable();
    Some(samples[samples.len() / 2])
}

/// Downloads a small body so connection setup and TCP slow start are not
/// counted. Returns false if the provider rejected the request.
async fn warmup(client: Client, provider: Provider, run_id: u64) -> bool {
    if !is_active(run_id) {
        return true;
    }
    let Ok(mut response) = download_request(&client, provider, WARMUP_BYTES).send().await else {
        return true;
    };
    if !response.status().is_success() {
        return false;
    }
    while is_active(run_id) {
        match response.chunk().await {
            Ok(Some(_)) => {}
            _ => break,
        }
    }
    true
}

struct Shared {
    total_bytes: AtomicU64,
    http_rejected: AtomicBool,
}

async fn download_worker(
    client: Client,
    provider: Provider,
    run_id: u64,
    deadline: tokio::time::Instant,
    shared: Arc<Shared>,
) {
    let mut consecutive_failures = 0u32;
    let running = |shared: &Shared| {
        is_active(run_id)
            && !shared.http_rejected.load(Ordering::SeqCst)
            && tokio::time::Instant::now() < deadline
    };
    while running(&shared) {
        let request = download_request(&client, provider, DOWNLOAD_CHUNK_BYTES).send();
        let outcome = match tokio::time::timeout_at(deadline, request).await {
            Err(_) => return, // deadline reached while connecting
            Ok(result) => result,
        };
        match outcome {
            Ok(mut response) if response.status().is_success() => {
                consecutive_failures = 0;
                while running(&shared) {
                    match tokio::time::timeout_at(deadline, response.chunk()).await {
                        Ok(Ok(Some(chunk))) => {
                            shared
                                .total_bytes
                                .fetch_add(chunk.len() as u64, Ordering::Relaxed);
                        }
                        Ok(Ok(None)) => break,
                        Ok(Err(_)) => {
                            consecutive_failures += 1;
                            break;
                        }
                        Err(_) => return,
                    }
                }
            }
            Ok(_) => {
                // A refused request means this provider will not serve the
                // test; stop every stream and let the caller try the next one.
                shared.http_rejected.store(true, Ordering::SeqCst);
                return;
            }
            Err(_) => consecutive_failures += 1,
        }
        if consecutive_failures >= MAX_TRANSIENT_FAILURES_PER_STREAM {
            return;
        }
        if consecutive_failures > 0 {
            tokio::time::sleep(REQUEST_RETRY_BASE_DELAY * consecutive_failures).await;
        }
    }
}

/// Returns (Mbps, provider rejected the request).
async fn measure_download(
    emit: &(dyn Fn(Progress) + Send + Sync),
    client: &Client,
    provider: Provider,
    run_id: u64,
    ping_ms: u64,
) -> (f64, bool) {
    let warmups: Vec<_> = (0..WARMUP_STREAMS)
        .map(|_| tauri::async_runtime::spawn(warmup(client.clone(), provider, run_id)))
        .collect();
    let mut rejected = false;
    for handle in warmups {
        if let Ok(false) = handle.await {
            rejected = true;
        }
    }
    if !is_active(run_id) || rejected {
        return (0.0, rejected);
    }

    let shared = Arc::new(Shared {
        total_bytes: AtomicU64::new(0),
        http_rejected: AtomicBool::new(false),
    });
    let started = tokio::time::Instant::now();
    let deadline = started + TEST_DURATION;
    let workers: Vec<_> = (0..PARALLEL_STREAMS)
        .map(|_| {
            tauri::async_runtime::spawn(download_worker(
                client.clone(),
                provider,
                run_id,
                deadline,
                shared.clone(),
            ))
        })
        .collect();

    while is_active(run_id) && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(UI_UPDATE_INTERVAL).await;
        let now = tokio::time::Instant::now().min(deadline);
        let elapsed = (now - started).as_secs_f64();
        emit(Progress {
            run_id,
            phase: "download",
            ping_ms: Some(ping_ms),
            current_mbps: mbps(shared.total_bytes.load(Ordering::Relaxed), elapsed),
            progress: (elapsed / TEST_DURATION.as_secs_f64()).clamp(0.0, 1.0),
        });
        if shared.http_rejected.load(Ordering::SeqCst) {
            break;
        }
    }
    for worker in workers {
        let _ = worker.await;
    }
    let measured = (tokio::time::Instant::now().min(deadline) - started).as_secs_f64();
    (
        mbps(shared.total_bytes.load(Ordering::Relaxed), measured),
        shared.http_rejected.load(Ordering::SeqCst),
    )
}

fn emit_phase(
    emit: &(dyn Fn(Progress) + Send + Sync),
    run_id: u64,
    phase: &'static str,
    ping_ms: Option<u64>,
) {
    emit(Progress {
        run_id,
        phase,
        ping_ms,
        current_mbps: 0.0,
        progress: 0.0,
    });
}

fn result(run_id: u64, status: &'static str) -> SpeedTestResult {
    SpeedTestResult {
        run_id,
        status,
        ping_ms: None,
        download_mbps: 0.0,
        provider: None,
    }
}

/// Starts run `run_id` (cancelling any previous one) and resolves with its
/// result. Progress is reported through `speed-test-progress` events carrying
/// the same `runId`.
#[tauri::command]
pub async fn start_speed_test(app: AppHandle, run_id: u64) -> Result<SpeedTestResult, String> {
    if run_id == 0 {
        return Err("run id must be non-zero".into());
    }
    let emit = move |progress: Progress| {
        let _ = app.emit(PROGRESS_EVENT, progress);
    };
    run_speed_test(run_id, &emit).await
}

async fn run_speed_test(
    run_id: u64,
    emit: &(dyn Fn(Progress) + Send + Sync),
) -> Result<SpeedTestResult, String> {
    RUN_GENERATION.store(run_id, Ordering::SeqCst);
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    emit_phase(emit, run_id, "checking", None);
    let Some(first) = find_reachable_provider(&client, run_id).await else {
        return Ok(result(
            run_id,
            if is_active(run_id) { "no_connection" } else { "cancelled" },
        ));
    };

    let order = std::iter::once(first).chain(PROVIDERS.into_iter().filter(|p| *p != first));
    for provider in order {
        if !is_active(run_id) {
            return Ok(result(run_id, "cancelled"));
        }
        emit_phase(emit, run_id, "ping", None);
        let Some(ping) = measure_ping(&client, provider, run_id).await else {
            continue;
        };
        if !is_active(run_id) {
            return Ok(result(run_id, "cancelled"));
        }
        emit_phase(emit, run_id, "download", Some(ping));
        let (download, rejected) = measure_download(emit, &client, provider, run_id, ping).await;
        if !is_active(run_id) {
            return Ok(result(run_id, "cancelled"));
        }
        if download > 0.0 && !rejected {
            return Ok(SpeedTestResult {
                run_id,
                status: "ok",
                ping_ms: Some(ping),
                download_mbps: download,
                provider: Some(match provider {
                    Provider::Cloudflare => "cloudflare",
                    Provider::Selectel => "selectel",
                }),
            });
        }
    }
    Ok(result(run_id, "measure_failed"))
}

/// Stops the current run; its pending `start_speed_test` resolves as cancelled.
#[tauri::command]
pub fn cancel_speed_test() {
    RUN_GENERATION.store(0, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mbps_matches_the_phone_formula() {
        assert_eq!(mbps(0, 10.0), 0.0);
        assert_eq!(mbps(125_000_000, 10.0), 100.0);
        assert_eq!(mbps(1, 0.0), 0.0);
    }

    #[test]
    fn cache_bust_is_unique() {
        assert_ne!(cache_bust(), cache_bust());
    }

    /// Full run as the UI sees it: `cargo test -- --ignored speed_test`.
    #[test]
    #[ignore]
    fn full_run_reports_progress_and_result() {
        tauri::async_runtime::block_on(async {
            let events = std::sync::Mutex::new(Vec::new());
            let emit = |p: Progress| events.lock().unwrap().push((p.phase, p.current_mbps));
            let result = run_speed_test(7, &emit).await.unwrap();
            let events = events.into_inner().unwrap();
            println!(
                "status={} provider={:?} ping={:?} mbps={:.1} events={}",
                result.status, result.provider, result.ping_ms, result.download_mbps, events.len()
            );
            assert_eq!(result.status, "ok");
            assert!(result.download_mbps > 0.0);
            assert!(events.iter().any(|(phase, _)| *phase == "checking"));
            assert!(events.iter().filter(|(phase, _)| *phase == "download").count() >= 30);
        });
    }

    /// Stop must end a run quickly, not after the 10-second window.
    #[test]
    #[ignore]
    fn cancel_stops_a_running_test() {
        tauri::async_runtime::block_on(async {
            let emit = |_p: Progress| {};
            let run = tauri::async_runtime::spawn(async move { run_speed_test(9, &emit).await });
            tokio::time::sleep(Duration::from_secs(4)).await;
            let cancelled_at = Instant::now();
            cancel_speed_test();
            let result = run.await.unwrap().unwrap();
            println!("status={} stop_ms={}", result.status, cancelled_at.elapsed().as_millis());
            assert_eq!(result.status, "cancelled");
            assert!(cancelled_at.elapsed() < Duration::from_secs(2));
        });
    }

    /// Live check of both providers: `cargo test -- --ignored speed_test`.
    #[test]
    #[ignore]
    fn providers_answer_latency_and_download() {
        tauri::async_runtime::block_on(async {
            let client = Client::builder().build().unwrap();
            let run_id = 1;
            RUN_GENERATION.store(run_id, Ordering::SeqCst);
            for provider in PROVIDERS {
                let ping = measure_ping(&client, provider, run_id).await;
                assert!(ping.is_some(), "{provider:?} ping failed");
                let mut response = download_request(&client, provider, 1_000_000)
                    .send()
                    .await
                    .unwrap();
                assert!(response.status().is_success(), "{provider:?} {}", response.status());
                let mut bytes = 0usize;
                while let Some(chunk) = response.chunk().await.unwrap() {
                    bytes += chunk.len();
                }
                assert_eq!(bytes, 1_000_000, "{provider:?} body size");
                println!("{provider:?}: ping={ping:?}ms");
            }
        });
    }
}
