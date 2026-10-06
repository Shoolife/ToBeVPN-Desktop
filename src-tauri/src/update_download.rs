//! Update package download shared by the Linux helper and the Windows app.
//!
//! Without a VPN GitHub's release CDN is throttled per connection (about
//! 120 KB/s here, so a 53 MB package took over seven minutes), while
//! several connections add up almost linearly. The package is therefore
//! fetched in byte ranges over parallel connections. Every range request
//! goes to the original release URL, so each one follows a fresh redirect
//! and an expiring signed CDN link cannot break a slow download. The
//! minisign signature of the assembled package is verified as before.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use reqwest::header::{CONTENT_RANGE, RANGE};
use reqwest::StatusCode;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

pub const UPDATE_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IERDQTkyQzdDOUVGMzk5NEMKUldSTW1mT2VmQ3lwM01NWkFhQ2ZoZ21kVjdCWFNUbk5kU0E4UHRvUVhKRGhPZjR5QVRWYW00azMK";

const CONNECTIONS: usize = 16;
const CHUNK_BYTES: u64 = 2 * 1024 * 1024;
const CHUNK_ATTEMPTS: usize = 4;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(150);

pub fn install_rustls_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

pub fn http_client() -> Result<reqwest::blocking::Client, String> {
    install_rustls_provider();
    reqwest::blocking::Client::builder()
        .user_agent("tobevpn-desktop-updater")
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("create HTTP client: {e}"))
}

/// Downloads `url` (at most `max_bytes`), calling `on_progress(downloaded,
/// total)` from the calling thread every PROGRESS_INTERVAL and once at the
/// end. Blocking: run it off the async runtime.
pub fn download(
    client: &reqwest::blocking::Client,
    url: &str,
    max_bytes: u64,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<Vec<u8>, String> {
    // The first range doubles as the size probe.
    let first = client
        .get(url)
        .header(RANGE, format!("bytes=0-{}", CHUNK_BYTES - 1))
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("download update package: {e}"))?;

    let total = match (first.status(), content_range_total(&first)) {
        (StatusCode::PARTIAL_CONTENT, Some(total)) => total,
        // No range support: one plain stream, as before.
        _ => return read_whole(first, max_bytes, &mut on_progress),
    };
    if total > max_bytes {
        return Err(format!("update package exceeds the {max_bytes}-byte limit"));
    }

    let chunk_count = total.div_ceil(CHUNK_BYTES).max(1) as usize;
    let chunks: Vec<Mutex<Option<Vec<u8>>>> = (0..chunk_count).map(|_| Mutex::new(None)).collect();
    let downloaded = AtomicU64::new(0);
    let next_chunk = AtomicUsize::new(1);
    let failed = AtomicBool::new(false);
    let error: Mutex<Option<String>> = Mutex::new(None);

    // Chunk 0 is already arriving on the probe connection.
    let first_len = range_len(0, total);
    let workers = CONNECTIONS.min(chunk_count);

    let fail = |message: String| {
        failed.store(true, Ordering::SeqCst);
        error
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_or_insert(message);
    };
    std::thread::scope(|scope| {
        {
            let (chunks, downloaded, fail) = (&chunks, &downloaded, &fail);
            scope.spawn(move || {
                match read_range(first, first_len, downloaded)
                    .or_else(|_| fetch_range(client, url, 0, total, downloaded))
                {
                    Ok(bytes) => *chunks[0].lock().unwrap_or_else(|p| p.into_inner()) = Some(bytes),
                    Err(e) => fail(e),
                }
            });
        }
        for _ in 1..workers.max(2) {
            let (chunks, downloaded, next_chunk, failed, fail) =
                (&chunks, &downloaded, &next_chunk, &failed, &fail);
            scope.spawn(move || loop {
                if failed.load(Ordering::SeqCst) {
                    break;
                }
                let index = next_chunk.fetch_add(1, Ordering::SeqCst);
                if index >= chunk_count {
                    break;
                }
                match fetch_range(client, url, index, total, downloaded) {
                    Ok(bytes) => {
                        *chunks[index].lock().unwrap_or_else(|p| p.into_inner()) = Some(bytes)
                    }
                    Err(e) => {
                        fail(e);
                        break;
                    }
                }
            });
        }

        // Report progress until every range is in or the download failed.
        loop {
            let done = chunks
                .iter()
                .all(|chunk| chunk.lock().unwrap_or_else(|p| p.into_inner()).is_some());
            on_progress(downloaded.load(Ordering::SeqCst).min(total), total);
            if done || failed.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(PROGRESS_INTERVAL);
        }
    });

    if let Some(message) = error.into_inner().unwrap_or_else(|p| p.into_inner()) {
        return Err(message);
    }
    let mut bytes = Vec::with_capacity(total as usize);
    for chunk in chunks {
        match chunk.into_inner().unwrap_or_else(|p| p.into_inner()) {
            Some(part) => bytes.extend_from_slice(&part),
            None => return Err("update package download is incomplete".into()),
        }
    }
    if bytes.len() as u64 != total {
        return Err("update package size does not match".into());
    }
    on_progress(total, total);
    Ok(bytes)
}

fn range_len(index: usize, total: u64) -> u64 {
    let start = index as u64 * CHUNK_BYTES;
    (total - start).min(CHUNK_BYTES)
}

/// "bytes 0-2097151/53644420" -> 53644420.
fn content_range_total(response: &reqwest::blocking::Response) -> Option<u64> {
    parse_content_range_total(response.headers().get(CONTENT_RANGE)?.to_str().ok()?)
}

fn parse_content_range_total(value: &str) -> Option<u64> {
    value
        .strip_prefix("bytes ")?
        .split('/')
        .nth(1)?
        .trim()
        .parse()
        .ok()
}

/// Reads exactly `expected` bytes of a range response, counting them into
/// `downloaded` as they arrive (and taking them back out on failure).
fn read_range(
    mut response: reqwest::blocking::Response,
    expected: u64,
    downloaded: &AtomicU64,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::with_capacity(expected as usize);
    let mut buffer = vec![0u8; 64 * 1024];
    let result = loop {
        match response.read(&mut buffer) {
            Ok(0) => break Ok(()),
            Ok(read) => {
                if bytes.len() as u64 + read as u64 > expected {
                    break Err("update server sent more data than requested".to_string());
                }
                bytes.extend_from_slice(&buffer[..read]);
                downloaded.fetch_add(read as u64, Ordering::SeqCst);
            }
            Err(e) => break Err(format!("read update package: {e}")),
        }
    };
    if result.is_ok() && bytes.len() as u64 == expected {
        return Ok(bytes);
    }
    downloaded.fetch_sub(bytes.len() as u64, Ordering::SeqCst);
    Err(result
        .err()
        .unwrap_or_else(|| "update package range ended early".into()))
}

fn fetch_range(
    client: &reqwest::blocking::Client,
    url: &str,
    index: usize,
    total: u64,
    downloaded: &AtomicU64,
) -> Result<Vec<u8>, String> {
    let start = index as u64 * CHUNK_BYTES;
    let expected = range_len(index, total);
    let mut last_error = String::new();
    for attempt in 0..CHUNK_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(500 * attempt as u64));
        }
        let response = client
            .get(url)
            .header(RANGE, format!("bytes={start}-{}", start + expected - 1))
            .send()
            .and_then(|r| r.error_for_status());
        match response {
            Ok(response) if response.status() == StatusCode::PARTIAL_CONTENT => {
                match read_range(response, expected, downloaded) {
                    Ok(bytes) => return Ok(bytes),
                    Err(e) => last_error = e,
                }
            }
            Ok(response) => {
                last_error = format!(
                    "update server ignored the range request: {}",
                    response.status()
                )
            }
            Err(e) => last_error = format!("download update package: {e}"),
        }
    }
    Err(last_error)
}

fn read_whole(
    mut response: reqwest::blocking::Response,
    max_bytes: u64,
    on_progress: &mut impl FnMut(u64, u64),
) -> Result<Vec<u8>, String> {
    let total = response.content_length().unwrap_or(0);
    if total > max_bytes {
        return Err(format!("update package exceeds the {max_bytes}-byte limit"));
    }
    let mut bytes = Vec::with_capacity(total as usize);
    let mut buffer = vec![0u8; 64 * 1024];
    let mut last_report = std::time::Instant::now();
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|e| format!("read update package: {e}"))?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.len() as u64 > max_bytes {
            return Err(format!("update package exceeds the {max_bytes}-byte limit"));
        }
        if last_report.elapsed() >= PROGRESS_INTERVAL {
            last_report = std::time::Instant::now();
            on_progress(bytes.len() as u64, total);
        }
    }
    on_progress(bytes.len() as u64, total.max(bytes.len() as u64));
    Ok(bytes)
}

pub fn verify_signature(data: &[u8], release_signature: &str) -> Result<(), String> {
    let pub_key_decoded = base64_to_string(UPDATE_PUBKEY)?;
    let public_key = PublicKey::decode(&pub_key_decoded)
        .map_err(|e| format!("decode update public key: {e}"))?;
    let signature_decoded = base64_to_string(release_signature)?;
    let signature = Signature::decode(&signature_decoded)
        .map_err(|e| format!("decode update signature: {e}"))?;
    public_key
        .verify(data, &signature, true)
        .map_err(|e| format!("verify update signature: {e}"))?;
    Ok(())
}

fn base64_to_string(value: &str) -> Result<String, String> {
    let decoded = STANDARD
        .decode(value)
        .map_err(|e| format!("decode base64: {e}"))?;
    String::from_utf8(decoded).map_err(|e| format!("decode utf8: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_range_total_is_parsed() {
        assert_eq!(
            parse_content_range_total("bytes 0-2097151/53644420"),
            Some(53_644_420)
        );
        assert_eq!(parse_content_range_total("bytes 0-1/*"), None);
        assert_eq!(parse_content_range_total("items 0-1/5"), None);
    }

    #[test]
    fn ranges_cover_the_package_exactly() {
        let total = 53_644_420u64;
        let count = total.div_ceil(CHUNK_BYTES) as usize;
        let sum: u64 = (0..count).map(|index| range_len(index, total)).sum();
        assert_eq!(sum, total);
        assert_eq!(
            range_len(count - 1, total),
            total - (count as u64 - 1) * CHUNK_BYTES
        );
    }

    /// Real download from the published release, checked against the
    /// release signature: `cargo test --lib live_parallel -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_parallel_download_of_published_release() {
        // TOBEVPN_TEST_IFACE=<physical interface> measures past a host VPN.
        let client = match std::env::var("TOBEVPN_TEST_IFACE") {
            #[cfg(target_os = "linux")]
            Ok(interface) => {
                install_rustls_provider();
                reqwest::blocking::Client::builder()
                    .user_agent("tobevpn-desktop-updater")
                    .connect_timeout(CONNECT_TIMEOUT)
                    .timeout(REQUEST_TIMEOUT)
                    .interface(&interface)
                    .build()
                    .unwrap()
            }
            _ => http_client().unwrap(),
        };
        let manifest: serde_json::Value = client
            .get("https://github.com/Shoolife/ToBeVPN-Desktop/releases/latest/download/latest.json")
            .send()
            .unwrap()
            .json()
            .unwrap();
        let platforms = &manifest["platforms"];
        let platform = if platforms["linux-x86_64-deb"].is_object() {
            &platforms["linux-x86_64-deb"]
        } else {
            &platforms["linux-x86_64"]
        };
        let url = platform["url"].as_str().unwrap();
        let started = std::time::Instant::now();
        let mut reports = 0;
        let bytes = download(&client, url, 256 * 1024 * 1024, |done, total| {
            reports += 1;
            assert!(done <= total);
        })
        .unwrap();
        verify_signature(&bytes, platform["signature"].as_str().unwrap()).unwrap();
        eprintln!(
            "{} bytes in {:.1}s, {reports} progress reports",
            bytes.len(),
            started.elapsed().as_secs_f64()
        );
    }
}
