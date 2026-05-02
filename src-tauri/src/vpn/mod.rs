pub mod config;
pub mod state;

#[cfg(target_os = "linux")]
#[path = "manager_linux.rs"]
pub mod manager;

#[cfg(target_os = "windows")]
#[path = "manager_windows.rs"]
pub mod manager;
