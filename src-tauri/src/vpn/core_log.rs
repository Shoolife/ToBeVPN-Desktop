//! Reads the Xray core's output and turns it into a privacy-safe summary for
//! the diagnostic journal.
//!
//! Core lines name the sites a user visits, so they never reach the journal.
//! What does is a count of outbound failures by kind every 30 seconds:
//! a tunnel that stalls shows timeouts, one a provider cuts shows resets or
//! EOFs, a REALITY or TLS refusal shows as tls. Xray logs to stdout; both
//! streams are read, which also keeps a full pipe from ever holding the core.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

const SUMMARY_EVERY: Duration = Duration::from_secs(30);

#[derive(Default, Clone, Copy, PartialEq, Debug)]
struct Counts {
    requests: u64,
    timeout: u64,
    reset: u64,
    refused: u64,
    eof: u64,
    tls: u64,
    xhttp: u64,
    other: u64,
}

impl Counts {
    fn failures(&self) -> u64 {
        self.timeout + self.reset + self.refused + self.eof + self.tls + self.xhttp + self.other
    }
}

struct Window {
    counts: Counts,
    started: Instant,
}

static WINDOW: Mutex<Option<Window>> = Mutex::new(None);

#[derive(Debug, PartialEq)]
enum Kind {
    Request,
    Failure(&'static str),
}

/// What one core line says about the proxy outbound, if anything. Normal
/// closes ("context canceled") and the core's own chatter are not counted.
fn classify(line: &str) -> Option<Kind> {
    let lower = line.to_ascii_lowercase();
    if lower.contains("tunneling request to") {
        return Some(Kind::Request);
    }
    let about_proxy = lower.contains("proxy/vless")
        || lower.contains("proxy/hysteria")
        || lower.contains("app/proxyman/outbound")
        || lower.contains("transport/internet")
        || lower.contains("splithttp")
        || lower.contains("reality");
    let failed = lower.contains("fail")
        || lower.contains("connection ends")
        || lower.contains("[error]")
        || lower.contains("[warning]");
    if !about_proxy || !failed || lower.contains("context canceled") {
        return None;
    }
    let kind = if lower.contains("i/o timeout")
        || lower.contains("deadline exceeded")
        || lower.contains("timed out")
        || lower.contains("timeout")
    {
        "timeout"
    } else if lower.contains("forcibly closed")
        || lower.contains("connection reset")
        || lower.contains("connection aborted")
        || lower.contains("broken pipe")
    {
        "reset"
    } else if lower.contains("refused") {
        "refused"
    } else if lower.contains("eof") || lower.contains("closed pipe") {
        "eof"
    } else if lower.contains("reality")
        || lower.contains("tls")
        || lower.contains("certificate")
        || lower.contains("handshake")
    {
        "tls"
    } else if lower.contains("splithttp")
        || lower.contains("xhttp")
        || lower.contains("status code")
    {
        "xhttp"
    } else {
        "other"
    };
    Some(Kind::Failure(kind))
}

fn add(counts: &mut Counts, kind: Kind) {
    match kind {
        Kind::Request => counts.requests += 1,
        Kind::Failure("timeout") => counts.timeout += 1,
        Kind::Failure("reset") => counts.reset += 1,
        Kind::Failure("refused") => counts.refused += 1,
        Kind::Failure("eof") => counts.eof += 1,
        Kind::Failure("tls") => counts.tls += 1,
        Kind::Failure("xhttp") => counts.xhttp += 1,
        Kind::Failure(_) => counts.other += 1,
    }
}

fn record(kind: Kind) {
    if let Ok(mut guard) = WINDOW.lock() {
        let window = guard.get_or_insert_with(|| Window {
            counts: Counts::default(),
            started: Instant::now(),
        });
        add(&mut window.counts, kind);
    }
}

/// Writes the window's summary when it is due (or `force`), then starts a new one.
fn flush(force: bool) {
    let taken = {
        let Ok(mut guard) = WINDOW.lock() else { return };
        match guard.as_ref() {
            Some(window) if force || window.started.elapsed() >= SUMMARY_EVERY => {
                let window = guard.take().expect("checked above");
                Some((window.counts, window.started.elapsed()))
            }
            _ => None,
        }
    };
    let Some((counts, elapsed)) = taken else {
        return;
    };
    if counts.failures() == 0 {
        return;
    }
    crate::diagnostics::record_native(
        "VPN-Core",
        &format!(
            "Core outbound errors; window_s={}, requests={}, timeout={}, reset={}, refused={}, eof={}, tls={}, xhttp={}, other={}",
            elapsed.as_secs(),
            counts.requests,
            counts.timeout,
            counts.reset,
            counts.refused,
            counts.eof,
            counts.tls,
            counts.xhttp,
            counts.other
        ),
    );
}

/// Reads one of the core's output streams until it closes: every line goes
/// to the console as before, and outbound failures into the summary.
pub fn spawn_reader<R>(stream: R, console: fn(&str))
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(stream).lines();
        let mut tick = tokio::time::interval(SUMMARY_EVERY);
        tick.tick().await;
        loop {
            tokio::select! {
                line = lines.next_line() => match line {
                    Ok(Some(line)) => {
                        console(&line);
                        if let Some(kind) = classify(&line) {
                            record(kind);
                        }
                    }
                    _ => break,
                },
                _ = tick.tick() => flush(false),
            }
        }
        // The core stopped: whatever it counted belongs to this session.
        flush(true);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outbound_failures_are_sorted_by_kind() {
        let cases = [
            ("[Info] [1] app/proxyman/outbound: failed to process outbound traffic > proxy/vless/outbound: failed to find an available destination > common/retry: [dial tcp 1.2.3.4:443: i/o timeout]", "timeout"),
            ("[Info] [2] proxy/vless/outbound: connection ends > wsarecv: An existing connection was forcibly closed by the remote host.", "reset"),
            ("[Info] [3] proxy/vless/outbound: connection ends > proxy/vless/encoding: failed to read response version > EOF", "eof"),
            ("[Info] [4] proxy/vless/outbound: failed to find an available destination > dial tcp: connectex: No connection could be made because the target machine actively refused it.", "refused"),
            ("[Info] [5] transport/internet/reality: failed to dial REALITY: REALITY: processed invalid connection", "tls"),
        ];
        for (line, kind) in cases {
            assert_eq!(classify(line), Some(Kind::Failure(kind)), "{line}");
        }
    }

    #[test]
    fn requests_are_counted_and_normal_closes_are_not() {
        assert_eq!(
            classify("[Info] [6] proxy/vless/outbound: tunneling request to tcp:example.com:443 via 1.2.3.4:443"),
            Some(Kind::Request)
        );
        assert_eq!(
            classify("[Info] [7] proxy/vless/outbound: connection ends > context canceled"),
            None
        );
        assert_eq!(classify("Xray 26.1.1 started"), None);
    }
}
