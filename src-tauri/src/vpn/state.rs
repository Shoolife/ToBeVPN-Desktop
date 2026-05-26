// Platform-independent types shared by every backend implementation
// (manager_linux.rs, manager_windows.rs, ...).

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "status")]
pub enum VpnState {
    Disconnected,
    Connecting,
    Connected,
    Disconnecting,
    Error { message: String },
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TrafficStats {
    pub uplink: u64,
    pub downlink: u64,
}

/// Resolved host → IPv4 mapping returned by `prepare_ping_bypass`. The
/// caller pins `tcp_ping` to the resolved IP so the actual ping destination
/// matches the address the bypass route was added for — otherwise a second
/// `getaddrinfo` call inside `tcp_ping` could land on a different rotation /
/// CDN replica and the packet would slip back into the tunnel.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PingHostMapping {
    pub host: String,
    pub ip: String,
}
