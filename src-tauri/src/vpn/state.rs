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
