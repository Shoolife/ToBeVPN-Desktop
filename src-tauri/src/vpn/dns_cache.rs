//! Server and direct-access host lookups with a memory of the last answer.
//!
//! While the VPN is on, the system resolver goes through the tunnel. When the
//! tunnel stops forwarding, every lookup times out: the server list then shows
//! every server with a host name as unavailable, and switching to another
//! server fails with "DNS resolve timed out" although the servers themselves
//! answer. A server's address changes rarely, so the last address a host had
//! is a better answer than none.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio::time::timeout;

/// How long a remembered address stays usable when a fresh lookup fails.
const REMEMBERED_FOR: Duration = Duration::from_secs(24 * 60 * 60);

/// Host → its last addresses and when they were found.
type Remembered = HashMap<String, (Vec<String>, Instant)>;

static REMEMBERED: Mutex<Option<Remembered>> = Mutex::new(None);

fn remember(host: &str, ips: &[String]) {
    if ips.is_empty() {
        return;
    }
    if let Ok(mut guard) = REMEMBERED.lock() {
        guard
            .get_or_insert_with(HashMap::new)
            .insert(host.to_ascii_lowercase(), (ips.to_vec(), Instant::now()));
    }
}

fn remembered(host: &str) -> Option<Vec<String>> {
    let guard = REMEMBERED.lock().ok()?;
    let (ips, at) = guard.as_ref()?.get(&host.to_ascii_lowercase())?;
    (at.elapsed() <= REMEMBERED_FOR).then(|| ips.clone())
}

/// The host's IPv4 addresses. A lookup that fails or times out falls back to
/// the addresses the host last had, so a dead tunnel does not hide servers
/// that are still reachable over the direct route.
///
/// `purpose` ("server", "direct-access", "ping") goes into the diagnostic
/// journal with the reason a lookup failed and whether a remembered address
/// stood in; the journal redacts the host itself.
pub async fn lookup_ipv4s(
    host: String,
    port: u16,
    timeout_dur: Duration,
    purpose: &'static str,
) -> Result<Vec<String>, String> {
    let started = Instant::now();
    let fresh = timeout(
        timeout_dur,
        tokio::net::lookup_host(format!("{host}:{port}")),
    )
    .await
    .map_err(|_| "DNS resolve timed out".to_string())
    .and_then(|result| result.map_err(|e| format!("DNS resolve failed: {e}")))
    .map(|addrs| {
        addrs
            .filter(|addr| addr.is_ipv4())
            .map(|addr| addr.ip().to_string())
            .collect::<Vec<_>>()
    });
    let (result, reason) = match fresh {
        Ok(ips) if !ips.is_empty() => {
            remember(&host, &ips);
            return Ok(ips);
        }
        Ok(ips) => (remembered(&host).map(Ok).unwrap_or(Ok(ips)), "no_ipv4"),
        Err(error) => {
            let reason = if error.contains("timed out") {
                "timeout"
            } else {
                "error"
            };
            (remembered(&host).ok_or(error), reason)
        }
    };
    let used_remembered = matches!(&result, Ok(ips) if !ips.is_empty());
    crate::diagnostics::record_native(
        "DNS",
        &format!(
            "Address lookup failed; purpose={purpose}, reason={reason}, remembered={}, elapsed_ms={}",
            if used_remembered { "yes" } else { "no" },
            started.elapsed().as_millis()
        ),
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_failed_lookup_returns_the_remembered_address() {
        remember("Cached.Example.Invalid", &["203.0.113.7".to_string()]);
        let ips = lookup_ipv4s(
            "cached.example.invalid".to_string(),
            443,
            Duration::from_secs(5),
            "ping",
        )
        .await
        .unwrap();
        assert_eq!(ips, vec!["203.0.113.7".to_string()]);
    }

    #[tokio::test]
    async fn a_failed_lookup_without_memory_is_an_error() {
        assert!(lookup_ipv4s(
            "never.example.invalid".to_string(),
            443,
            Duration::from_secs(5),
            "ping"
        )
        .await
        .is_err());
    }
}
