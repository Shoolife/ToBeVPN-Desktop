//! Home router detection for the Router section.
//!
//! Finds the default IPv4 gateway and identifies the router from its web
//! login page, which needs no password: OpenWrt-based firmware serves LuCI
//! and puts the model into the page title (SNR's EasyWRT: "SNR-CPE-AX2").
//! Nothing is sent to the router beyond two plain GET requests.

use serde::Serialize;
use std::net::{Ipv4Addr, SocketAddr};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpSocket;
use tokio::time::timeout;

/// Routers the installer has been verified on. Other OpenWrt-based routers
/// are reported as detected but not yet supported.
const SUPPORTED_MODELS: &[&str] = &["SNR-CPE-AX2"];
const HTTP_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_PAGE_BYTES: usize = 64 * 1024;

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RouterInfo {
    /// Default gateway, e.g. "192.168.1.1"; None without a network.
    pub gateway: Option<String>,
    /// Model from the login page title, e.g. "SNR-CPE-AX2".
    pub model: Option<String>,
    /// "easywrt" (SNR's OpenWrt), "openwrt", or None when not recognised.
    pub firmware: Option<String>,
    pub supported: bool,
}

#[tauri::command]
pub async fn detect_router() -> RouterInfo {
    let Some((gateway, interface)) = default_gateway() else {
        return RouterInfo::default();
    };
    let mut info = RouterInfo {
        gateway: Some(gateway.to_string()),
        ..RouterInfo::default()
    };
    let Some(root) = http_get(gateway, interface.as_deref(), "/").await else {
        return info;
    };
    // LuCI's index only redirects (meta refresh) to /cgi-bin/luci.
    let page = if root.contains("/cgi-bin/luci") {
        http_get(gateway, interface.as_deref(), "/cgi-bin/luci")
            .await
            .unwrap_or(root)
    } else {
        root
    };
    let (model, firmware) = identify(&page);
    info.supported = model
        .as_deref()
        .is_some_and(|model| SUPPORTED_MODELS.contains(&model));
    info.model = model;
    info.firmware = firmware;
    info
}

/// Model and firmware family from a router's login page.
fn identify(page: &str) -> (Option<String>, Option<String>) {
    let lower = page.to_ascii_lowercase();
    let firmware = if lower.contains("luci-static/snr") || lower.contains("easywrt") {
        Some("easywrt")
    } else if lower.contains("luci") || lower.contains("openwrt") {
        Some("openwrt")
    } else {
        None
    };
    let title = page_title(page).filter(|title| {
        let generic = title.to_ascii_lowercase();
        !generic.is_empty() && generic != "luci" && generic != "openwrt" && generic.len() <= 64
    });
    (title, firmware.map(str::to_string))
}

fn page_title(page: &str) -> Option<String> {
    let lower = page.to_ascii_lowercase();
    let start = lower.find("<title>")? + "<title>".len();
    let end = start + lower[start..].find("</title>")?;
    let title = page[start..end].trim();
    // "SNR-CPE-AX2 - Обзор" on inner pages; the login page is the bare model.
    let model = title.split(" - ").next().unwrap_or(title).trim();
    Some(model.to_string())
}

/// One HTTP/1.0 GET to the router. On Linux the socket is bound to the
/// physical interface, so the request reaches the router even while an
/// older tunnel setup sends local networks into the VPN.
async fn http_get(gateway: Ipv4Addr, interface: Option<&str>, path: &str) -> Option<String> {
    let socket = TcpSocket::new_v4().ok()?;
    #[cfg(target_os = "linux")]
    if let Some(interface) = interface {
        let _ = socket.bind_device(Some(interface.as_bytes()));
    }
    #[cfg(not(target_os = "linux"))]
    let _ = interface;
    let mut stream = timeout(
        HTTP_TIMEOUT,
        socket.connect(SocketAddr::from((gateway, 80))),
    )
    .await
    .ok()?
    .ok()?;
    let request = format!("GET {path} HTTP/1.0\r\nHost: {gateway}\r\nConnection: close\r\n\r\n");
    timeout(HTTP_TIMEOUT, stream.write_all(request.as_bytes()))
        .await
        .ok()?
        .ok()?;
    let mut body = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match timeout(HTTP_TIMEOUT, stream.read(&mut chunk)).await {
            Ok(Ok(0)) | Err(_) | Ok(Err(_)) => break,
            Ok(Ok(read)) => {
                body.extend_from_slice(&chunk[..read]);
                if body.len() >= MAX_PAGE_BYTES {
                    break;
                }
            }
        }
    }
    (!body.is_empty()).then(|| String::from_utf8_lossy(&body).into_owned())
}

/// Default IPv4 gateway of a physical interface and the interface name.
#[cfg(target_os = "linux")]
fn default_gateway() -> Option<(Ipv4Addr, Option<String>)> {
    let table = std::fs::read_to_string("/proc/net/route").ok()?;
    parse_proc_net_route(&table).map(|(gateway, interface)| (gateway, Some(interface)))
}

#[cfg(target_os = "windows")]
fn default_gateway() -> Option<(Ipv4Addr, Option<String>)> {
    crate::vpn::default_physical_gateway().map(|gateway| (gateway, None))
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn default_gateway() -> Option<(Ipv4Addr, Option<String>)> {
    None
}

/// Lowest-metric default route in /proc/net/route that is not a tunnel.
/// Addresses there are hex in host byte order (little endian on our targets).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_proc_net_route(table: &str) -> Option<(Ipv4Addr, String)> {
    table
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let (interface, destination, gateway, metric) = (
                fields.first()?,
                fields.get(1)?,
                fields.get(2)?,
                fields.get(6)?,
            );
            if *destination != "00000000"
                || interface.starts_with("tobe")
                || interface.starts_with("tun")
            {
                return None;
            }
            let gateway = u32::from_str_radix(gateway, 16).ok()?;
            if gateway == 0 {
                return None;
            }
            let metric: u32 = metric.parse().ok()?;
            Some((
                metric,
                Ipv4Addr::from(gateway.to_le_bytes()),
                interface.to_string(),
            ))
        })
        .min_by_key(|(metric, _, _)| *metric)
        .map(|(_, gateway, interface)| (gateway, interface))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_snr_easywrt_login_page() {
        let page = r#"<html><head><title>SNR-CPE-AX2</title>
            <link href="/luci-static/snr/css/style.css"></head></html>"#;
        assert_eq!(
            identify(page),
            (Some("SNR-CPE-AX2".to_string()), Some("easywrt".to_string()))
        );
    }

    #[test]
    fn strips_page_name_from_inner_titles_and_ignores_generic_ones() {
        assert_eq!(
            page_title("<TITLE>SNR-CPE-AX2 - Обзор</TITLE>").as_deref(),
            Some("SNR-CPE-AX2")
        );
        let (model, firmware) = identify("<title>LuCI</title><a href=\"/cgi-bin/luci\">");
        assert_eq!(model, None);
        assert_eq!(firmware.as_deref(), Some("openwrt"));
    }

    #[test]
    fn picks_lowest_metric_physical_default_route() {
        let table = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\n\
            tobe0\t00000000\t00000000\t0001\t0\t0\t0\t00000000\n\
            wlp1s0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\n\
            eth0\t00000000\t0102A8C0\t0003\t0\t0\t100\t00000000\n\
            wlp1s0\t0001A8C0\t00000000\t0001\t0\t0\t600\t00FFFFFF\n";
        assert_eq!(
            parse_proc_net_route(table),
            Some((Ipv4Addr::new(192, 168, 2, 1), "eth0".to_string()))
        );
    }
}
