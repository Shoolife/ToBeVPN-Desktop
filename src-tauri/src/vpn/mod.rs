pub mod config;
mod core_log;
pub mod dns_cache;
pub mod state;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

pub const CONNECT_CANCELLED: &str = "Connection cancelled";

/// Identifies one requested connection operation. A later start or an
/// explicit stop invalidates older attempts before they can publish an active
/// tunnel after the user has already asked to disconnect.
#[derive(Clone)]
pub struct ConnectAttempt {
    generation: Arc<AtomicU64>,
    id: u64,
}

impl ConnectAttempt {
    pub fn begin(generation: &Arc<AtomicU64>) -> Self {
        let id = generation.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
        Self {
            generation: generation.clone(),
            id,
        }
    }

    pub fn cancel_current(generation: &Arc<AtomicU64>) {
        generation.fetch_add(1, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.generation.load(Ordering::SeqCst) != self.id
    }

    pub fn ensure_active(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err(CONNECT_CANCELLED.into())
        } else {
            Ok(())
        }
    }

    pub async fn cancelled(&self) {
        while !self.is_cancelled() {
            tokio::time::sleep(tokio::time::Duration::from_millis(25)).await;
        }
    }
}

#[cfg(target_os = "linux")]
#[path = "manager_linux.rs"]
pub mod manager;

#[cfg(target_os = "windows")]
#[path = "manager_windows.rs"]
pub mod manager;

#[cfg(target_os = "macos")]
#[path = "manager_macos.rs"]
pub mod manager;

#[cfg(target_os = "windows")]
pub(crate) mod windows_routes;

/// Gateway of the lowest-metric physical default route, skipping our tunnel.
#[cfg(target_os = "windows")]
pub fn default_physical_gateway() -> Option<std::net::Ipv4Addr> {
    windows_routes::default_ipv4_route(manager::WINTUN_ADAPTER, manager::WINTUN_GATEWAY)
        .ok()
        .map(|route| route.gateway)
}

/// Xray processes of this user left running with this app's config by a
/// previous run that was killed (a crash, a force quit): the app's handle on
/// them is gone, so "Disconnect" never stops them. They keep their SOCKS port
/// (macOS even lets a new Xray bind the same port beside them), and traffic
/// could keep going to the old server. Stopped before a new Xray starts and
/// when the app starts. Returns how many there were.
#[cfg(unix)]
pub fn stop_stale_xray(xray_bin: &std::path::Path, config: &std::path::Path) -> usize {
    let Ok(output) = std::process::Command::new("/bin/ps")
        .args(["-axo", "pid=,uid=,command="])
        .output()
    else {
        return 0;
    };
    let wanted = format!("{} run -config {}", xray_bin.display(), config.display());
    let uid = unsafe { libc::getuid() };
    let pids = stale_xray_pids(
        &String::from_utf8_lossy(&output.stdout),
        uid,
        &wanted,
        std::process::id(),
    );
    for pid in &pids {
        unsafe { libc::kill(*pid, libc::SIGTERM) };
    }
    for _ in 0..10 {
        if pids.iter().all(|pid| unsafe { libc::kill(*pid, 0) } != 0) {
            return pids.len();
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    for pid in &pids {
        unsafe { libc::kill(*pid, libc::SIGKILL) };
    }
    pids.len()
}

/// The processes in `ps -axo pid=,uid=,command=` output that are exactly
/// `wanted` and belong to `uid`, never `own_pid`.
#[cfg_attr(not(unix), allow(dead_code))]
fn stale_xray_pids(ps: &str, uid: u32, wanted: &str, own_pid: u32) -> Vec<i32> {
    ps.lines()
        .filter_map(|line| {
            // Columns are padded with runs of spaces.
            let (pid, rest) = line.trim_start().split_once(char::is_whitespace)?;
            let (owner, command) = rest.trim_start().split_once(char::is_whitespace)?;
            let pid: i32 = pid.parse().ok()?;
            let owner: u32 = owner.parse().ok()?;
            let command = command.trim();
            (owner == uid && command == wanted && pid as u32 != own_pid).then_some(pid)
        })
        .collect()
}

#[cfg(test)]
mod stale_xray_tests {
    #[test]
    fn finds_only_this_users_xray_with_this_config() {
        let wanted = "/Applications/ToBeVPN.app/Contents/MacOS/xray run -config /Users/a/Library/Caches/tobevpn/xray.json";
        let ps = format!(
            "  101   501 {wanted}\n  102     0 {wanted}\n  103   501 {wanted} --extra\n  104   501 /usr/bin/xray run -config /tmp/other.json\n 4242   501 {wanted}\n"
        );
        assert_eq!(super::stale_xray_pids(&ps, 501, wanted, 4242), vec![101]);
    }
}
