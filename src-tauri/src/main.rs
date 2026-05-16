// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    if tobevpn_desktop_lib::linux_update::maybe_run_update_helper() {
        return;
    }

    tobevpn_desktop_lib::run()
}
