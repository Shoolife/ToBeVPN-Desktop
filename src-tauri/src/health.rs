//! Process health for the diagnostic journal, to catch an app that dies or
//! hangs without a word: how the previous run ended, memory and CPU over
//! time (with the WebKit processes), a main-thread stall watchdog, WebKit
//! renderer crashes, Rust panics and termination signals.
//!
//! Each important line also goes to stderr, so the system journal has it
//! even with diagnostic collection off.

use crate::diagnostics;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

const RUN_STATE_FILE: &str = "run-state.json";
// Process sampling exists on Linux and macOS.
#[cfg_attr(target_os = "windows", allow(dead_code))]
const SAMPLE_EVERY: Duration = Duration::from_secs(120);
const STALL_CHECK_EVERY: Duration = Duration::from_secs(5);
const STALL_AFTER_SECS: u64 = 10;
/// Memory (main + WebKit) and CPU that make a sample a warning.
// Process sampling exists on Linux and macOS.
#[cfg_attr(target_os = "windows", allow(dead_code))]
const WARN_RSS_MB: u64 = 900;
// Process sampling exists on Linux and macOS.
#[cfg_attr(target_os = "windows", allow(dead_code))]
const WARN_CPU_PERCENT: f64 = 30.0;

static RUN_STATE_PATH: OnceLock<PathBuf> = OnceLock::new();
static MAIN_THREAD_ACK: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Deserialize, Default, Clone)]
struct RunState {
    pid: u32,
    version: String,
    started: u64,
    heartbeat: u64,
    clean_exit: bool,
    last_sample: Option<String>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn log(level: &str, tag: &str, message: &str) {
    eprintln!("[HEALTH] {tag}: {message}");
    let _ = diagnostics::append_diagnostic_event(level.into(), tag.into(), message.into());
}

fn read_state() -> Option<RunState> {
    let path = RUN_STATE_PATH.get()?;
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn write_state(state: &RunState) {
    if let Some(path) = RUN_STATE_PATH.get() {
        let _ = std::fs::write(path, serde_json::to_vec(state).unwrap_or_default());
    }
}

fn update_state(change: impl FnOnce(&mut RunState)) {
    let mut state = read_state().unwrap_or_default();
    change(&mut state);
    write_state(&state);
}

fn ago(timestamp: u64) -> String {
    let seconds = now().saturating_sub(timestamp);
    format!("{}m{:02}s ago", seconds / 60, seconds % 60)
}

/// Starts the health checks; called once from setup.
pub fn start(app: &AppHandle, data_dir: PathBuf) {
    let _ = RUN_STATE_PATH.set(data_dir.join(RUN_STATE_FILE));
    report_previous_run();
    write_state(&RunState {
        pid: std::process::id(),
        version: env!("CARGO_PKG_VERSION").into(),
        started: now(),
        heartbeat: now(),
        clean_exit: false,
        last_sample: None,
    });
    install_panic_hook();
    start_sampler();
    start_stall_watchdog(app.clone());
    #[cfg(unix)]
    start_signal_watch(app.clone());
}

/// Marks this run as ended normally (Quit, window close to exit).
pub fn mark_clean_exit() {
    update_state(|state| {
        state.clean_exit = true;
        state.heartbeat = now();
    });
}

fn report_previous_run() {
    let Some(previous) = read_state() else { return };
    if previous.clean_exit || previous.pid == 0 {
        return;
    }
    log(
        "W",
        "App-Health",
        &format!(
            "Previous run ended abnormally: pid={}, version={}, started {}, last heartbeat {}, last sample: {}",
            previous.pid,
            previous.version,
            ago(previous.started),
            ago(previous.heartbeat),
            previous.last_sample.as_deref().unwrap_or("none"),
        ),
    );
}

fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let location = info
            .location()
            .map(|location| format!("{}:{}", location.file(), location.line()))
            .unwrap_or_default();
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|text| text.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_default();
        log(
            "E",
            "App-Panic",
            &format!(
                "thread '{}' panicked at {location}: {}",
                thread.name().unwrap_or("?"),
                payload.chars().take(300).collect::<String>()
            ),
        );
        default(info);
    }));
}

// ------------------------------------------------------------- sampling ---

// Process sampling exists on Linux and macOS.
#[cfg_attr(target_os = "windows", allow(dead_code))]
#[derive(Default, Clone, Copy)]
struct ProcSample {
    rss_kb: u64,
    cpu_ticks: u64,
    threads: u64,
}

#[cfg(target_os = "linux")]
fn proc_sample(pid: u32) -> Option<ProcSample> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let field = |name: &str| {
        status
            .lines()
            .find(|line| line.starts_with(name))
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
    };
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // Fields after the command name (which may contain spaces).
    let rest = stat.rsplit_once(')')?.1;
    let fields: Vec<&str> = rest.split_whitespace().collect();
    let ticks = fields.get(11)?.parse::<u64>().ok()? + fields.get(12)?.parse::<u64>().ok()?;
    Some(ProcSample {
        rss_kb: field("VmRSS:"),
        cpu_ticks: ticks,
        threads: field("Threads:"),
    })
}

/// WebKit's renderer and network processes started by this app.
#[cfg(target_os = "linux")]
fn webkit_children() -> Vec<(u32, String)> {
    let me = std::process::id();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse::<u32>().ok())
        .filter_map(|pid| {
            let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
            let name = stat.split_once('(')?.1.rsplit_once(')')?.0.to_string();
            let parent: u32 = stat
                .rsplit_once(')')?
                .1
                .split_whitespace()
                .nth(1)?
                .parse()
                .ok()?;
            (parent == me && name.starts_with("WebKit")).then_some((pid, name))
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn open_files() -> usize {
    std::fs::read_dir("/proc/self/fd")
        .map(|dir| dir.count())
        .unwrap_or(0)
}

/// macOS: resident memory, CPU time (in nanoseconds, so the sampler's
/// "ticks per second" is 1e9 there) and threads from proc_pidinfo.
// mach_timebase_info is deprecated in libc only in favour of the mach2 crate;
// one call does not justify a new dependency.
#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn proc_sample(pid: u32) -> Option<ProcSample> {
    let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
    let read = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTASKINFO,
            0,
            (&mut info as *mut libc::proc_taskinfo).cast(),
            size,
        )
    };
    if read != size {
        return None;
    }
    // Task times are in Mach absolute time units (not nanoseconds on Apple
    // Silicon).
    let mut timebase = libc::mach_timebase_info { numer: 0, denom: 0 };
    unsafe { libc::mach_timebase_info(&mut timebase) };
    let (numer, denom) = if timebase.denom == 0 {
        (1, 1)
    } else {
        (u64::from(timebase.numer), u64::from(timebase.denom))
    };
    let cpu = (info.pti_total_user + info.pti_total_system).saturating_mul(numer) / denom;
    Some(ProcSample {
        rss_kb: info.pti_resident_size / 1024,
        cpu_ticks: cpu,
        threads: u64::try_from(info.pti_threadnum).unwrap_or(0),
    })
}

/// WebKit's processes on macOS are XPC services of launchd, not this app's
/// children, and shared with other apps: only the app itself is sampled.
#[cfg(target_os = "macos")]
fn webkit_children() -> Vec<(u32, String)> {
    Vec::new()
}

#[cfg(target_os = "macos")]
fn open_files() -> usize {
    std::fs::read_dir("/dev/fd")
        .map(|dir| dir.count())
        .unwrap_or(0)
}

fn start_sampler() {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    std::thread::Builder::new()
        .name("health-sampler".into())
        .spawn(|| {
            #[cfg(target_os = "linux")]
            let ticks_per_second = unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as f64;
            #[cfg(target_os = "macos")]
            let ticks_per_second = 1_000_000_000_f64;
            let mut previous: std::collections::HashMap<u32, (ProcSample, std::time::Instant)> =
                Default::default();
            let mut first = true;
            loop {
                std::thread::sleep(if first {
                    Duration::from_secs(30)
                } else {
                    SAMPLE_EVERY
                });
                first = false;
                let me = std::process::id();
                let mut processes = vec![(me, "main".to_string())];
                processes.extend(webkit_children());
                let mut parts = Vec::new();
                let mut total_rss_mb = 0;
                let mut max_cpu: f64 = 0.0;
                for (pid, name) in processes {
                    let Some(sample) = proc_sample(pid) else {
                        continue;
                    };
                    let cpu = previous.get(&pid).map(|(before, at)| {
                        let seconds = at.elapsed().as_secs_f64().max(1.0);
                        (sample.cpu_ticks.saturating_sub(before.cpu_ticks) as f64
                            / ticks_per_second)
                            / seconds
                            * 100.0
                    });
                    previous.insert(pid, (sample, std::time::Instant::now()));
                    let rss_mb = sample.rss_kb / 1024;
                    total_rss_mb += rss_mb;
                    max_cpu = max_cpu.max(cpu.unwrap_or(0.0));
                    let label = name.trim_start_matches("WebKit").to_string();
                    parts.push(format!(
                        "{label}: rss={rss_mb}MB cpu={} threads={}",
                        cpu.map(|value| format!("{value:.1}%"))
                            .unwrap_or_else(|| "-".into()),
                        sample.threads
                    ));
                }
                let line = format!(
                    "{}; fds={}; total_rss={total_rss_mb}MB",
                    parts.join("; "),
                    open_files()
                );
                let warn = total_rss_mb >= WARN_RSS_MB || max_cpu >= WARN_CPU_PERCENT;
                if warn {
                    log("W", "App-Resources", &format!("High usage: {line}"));
                } else {
                    let _ = diagnostics::append_diagnostic_event(
                        "D".into(),
                        "App-Resources".into(),
                        line.clone(),
                    );
                }
                update_state(|state| {
                    state.heartbeat = now();
                    state.last_sample = Some(line);
                });
            }
        })
        .ok();
}

// --------------------------------------------------------- main thread ---

/// Asks the main (GTK) thread to answer every few seconds; a main thread
/// that does not answer is a frozen window, which the desktop then offers
/// to "Force Quit" (a kill that leaves no trace otherwise).
fn start_stall_watchdog(app: AppHandle) {
    MAIN_THREAD_ACK.store(now(), Ordering::Relaxed);
    std::thread::Builder::new()
        .name("health-stall".into())
        .spawn(move || {
            let mut stalled_since: Option<u64> = None;
            loop {
                std::thread::sleep(STALL_CHECK_EVERY);
                let _ = app.run_on_main_thread(|| MAIN_THREAD_ACK.store(now(), Ordering::Relaxed));
                std::thread::sleep(Duration::from_millis(500));
                let last = MAIN_THREAD_ACK.load(Ordering::Relaxed);
                let silent = now().saturating_sub(last);
                match stalled_since {
                    None if silent >= STALL_AFTER_SECS => {
                        stalled_since = Some(last);
                        log(
                            "W",
                            "App-Health",
                            &format!("Main thread unresponsive for {silent}s"),
                        );
                        update_state(|state| {
                            state.last_sample = Some(format!(
                                "main thread unresponsive since {}s; {}",
                                silent,
                                state.last_sample.clone().unwrap_or_default()
                            ));
                        });
                    }
                    Some(since) if silent < STALL_AFTER_SECS => {
                        log(
                            "I",
                            "App-Health",
                            &format!(
                                "Main thread responsive again after {}s",
                                now().saturating_sub(since)
                            ),
                        );
                        stalled_since = None;
                    }
                    _ => {}
                }
            }
        })
        .ok();
}

// ------------------------------------------------------------- WebKit ---

/// Logs a crashed WebKit renderer and reloads the page, which otherwise
/// leaves an empty window that looks like the app quit.
#[cfg(target_os = "linux")]
pub fn watch_webview(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| {
        use webkit2gtk::{WebProcessTerminationReason, WebViewExt};
        let view: webkit2gtk::WebView = webview.inner();
        view.connect_web_process_terminated(|view, reason| {
            let why = match reason {
                WebProcessTerminationReason::Crashed => "crashed",
                WebProcessTerminationReason::ExceededMemoryLimit => "exceeded its memory limit",
                WebProcessTerminationReason::TerminatedByApi => "was terminated by the app",
                _ => "ended",
            };
            log(
                "E",
                "App-Health",
                &format!("WebKit renderer {why}; reloading the window"),
            );
            if !matches!(reason, WebProcessTerminationReason::TerminatedByApi) {
                view.reload();
            }
        });
    });
}

#[cfg(not(target_os = "linux"))]
pub fn watch_webview(_window: &tauri::WebviewWindow) {}

// ------------------------------------------------------------ signals ---

/// Whether the process has a controlling terminal (started from a shell).
#[cfg(unix)]
fn has_controlling_terminal() -> bool {
    std::fs::OpenOptions::new()
        .read(true)
        .open("/dev/tty")
        .is_ok()
}

/// SIGTERM, SIGHUP and SIGINT (logout, `kill`, a terminal's Ctrl+C) are
/// logged and turned into a normal exit, which also stops the VPN cleanly.
#[cfg(unix)]
fn start_signal_watch(app: AppHandle) {
    static SIGNAL: AtomicU64 = AtomicU64::new(0);
    extern "C" fn on_signal(signal: libc::c_int) {
        SIGNAL.store(signal as u64, Ordering::SeqCst);
    }
    unsafe {
        for signal in [libc::SIGTERM, libc::SIGHUP, libc::SIGINT] {
            libc::signal(signal, on_signal as *const () as libc::sighandler_t);
        }
    }
    std::thread::Builder::new()
        .name("health-signals".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_millis(300));
            let signal = SIGNAL.swap(0, Ordering::SeqCst);
            // SIGHUP means "your terminal closed": only an app started from a
            // terminal has one. Started from the menu it has none, and a
            // SIGHUP then comes from elsewhere (seen on Astra Linux's Fly when
            // its compositor is switched): the window stays.
            if signal as libc::c_int == libc::SIGHUP && !has_controlling_terminal() {
                log(
                    "W",
                    "App-Health",
                    "Received SIGHUP without a terminal; ignored",
                );
                continue;
            }
            if signal != 0 {
                let name = match signal as libc::c_int {
                    libc::SIGTERM => "SIGTERM",
                    libc::SIGHUP => "SIGHUP",
                    libc::SIGINT => "SIGINT",
                    _ => "signal",
                };
                log(
                    "W",
                    "App-Health",
                    &format!("Received {name}; exiting normally"),
                );
                app.exit(0);
            }
        })
        .ok();
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn samples_this_process() {
        let sample = proc_sample(std::process::id()).expect("own /proc entry");
        assert!(sample.rss_kb > 0);
        assert!(sample.threads >= 1);
        assert!(open_files() > 0);
        assert!(webkit_children().is_empty());
    }

    #[test]
    fn run_state_round_trips() {
        let state = RunState {
            pid: 7,
            started: 1,
            heartbeat: 2,
            ..Default::default()
        };
        let back: RunState = serde_json::from_slice(&serde_json::to_vec(&state).unwrap()).unwrap();
        assert_eq!(back.pid, 7);
        assert!(!back.clean_exit);
    }
}
