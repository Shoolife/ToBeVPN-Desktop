pub mod config;
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
