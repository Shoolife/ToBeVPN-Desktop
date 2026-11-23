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
    /// "easywrt" (SNR's OpenWrt), "openwrt", "keenetic" (KeeneticOS, which
    /// ToBeVPN cannot be installed on yet), or None when not recognised.
    pub firmware: Option<String>,
    pub supported: bool,
    /// ToBeVPN's mark on the router (a hash of its device id in the
    /// account), read without logging in; None without ToBeVPN.
    pub mark: Option<String>,
}

/// The mark a ToBeVPN router with this device id publishes (the agent's
/// publish_id): the first 16 hex digits of MD5 of the lowercase id (MD5,
/// which every router's busybox has; the mark only names the router).
pub fn router_mark(hwid: &str) -> String {
    let digest = md5::compute(hwid.trim().to_lowercase().as_bytes());
    digest
        .0
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Marks for the account's router ids, to compare with a router's mark.
#[tauri::command]
pub fn router_marks(ids: Vec<String>) -> Vec<String> {
    ids.iter().map(|id| router_mark(id)).collect()
}

fn parse_mark(body: &str) -> Option<String> {
    let rest = &body[body.find("tobevpn-router ")? + "tobevpn-router ".len()..];
    let mark: String = rest.chars().take(16).collect();
    (mark.len() == 16
        && mark
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()))
    .then_some(mark)
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
    let Some(mut root) = http_get(gateway, interface.as_deref(), "/").await else {
        return info;
    };
    // A web server that sends HTTP to HTTPS (OpenWrt's redirect_https): the
    // pages are read over HTTPS then, with the router's own certificate
    // (self-signed) accepted, since only its title and mark are read.
    let https = redirects_to_https(&root);
    if https {
        match https_get(gateway, interface.clone(), "/").await {
            Some(page) => root = page,
            None => return info,
        }
    }
    let get = |path: &'static str| {
        let interface = interface.clone();
        async move {
            if https {
                https_get(gateway, interface, path).await
            } else {
                http_get(gateway, interface.as_deref(), path).await
            }
        }
    };
    // LuCI's index only redirects (meta refresh) to /cgi-bin/luci.
    let page = if root.contains("/cgi-bin/luci") {
        get("/cgi-bin/luci").await.unwrap_or(root)
    } else {
        root
    };
    let (model, firmware) = identify(&page);
    // Keenetic (and Netcraze, its Russian name): the login API answers
    // without a password and names the router in X-NDM-Realm.
    if firmware.is_none() {
        if let Some(realm) = get("/auth").await.and_then(|answer| ndm_realm(&answer)) {
            info.model = (!realm.is_empty()).then_some(realm);
            info.firmware = Some("keenetic".to_string());
            return info;
        }
    }
    info.supported = model
        .as_deref()
        .is_some_and(|model| SUPPORTED_MODELS.contains(&model));
    info.model = model;
    info.firmware = firmware;
    info.mark = get("/tobevpn-id").await.and_then(|body| parse_mark(&body));
    info
}

/// An HTTP answer that sends the browser to an https:// address.
fn redirects_to_https(response: &str) -> bool {
    let mut lines = response.lines();
    let redirect = lines
        .next()
        .and_then(|status| status.split_whitespace().nth(1))
        .is_some_and(|code| code.starts_with('3'));
    redirect
        && lines
            .take_while(|line| !line.is_empty())
            .any(|line| line.to_ascii_lowercase().starts_with("location: https://"))
}

/// One HTTPS GET to the router: its self-signed certificate accepted (only
/// the page title and the ToBeVPN mark are read; nothing is sent), no
/// redirects followed, bound to the physical interface like `http_get`.
async fn https_get(
    gateway: Ipv4Addr,
    interface: Option<String>,
    path: &'static str,
) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::update_download::install_rustls_provider();
        let builder = reqwest::blocking::Client::builder()
            .danger_accept_invalid_certs(true)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(HTTP_TIMEOUT);
        #[cfg(target_os = "linux")]
        let builder = match &interface {
            Some(name) => builder.interface(name),
            None => builder,
        };
        #[cfg(not(target_os = "linux"))]
        let _ = &interface;
        let client = builder.build().ok()?;
        let response = client.get(format!("https://{gateway}{path}")).send().ok()?;
        let text = response.text().ok()?;
        (!text.is_empty()).then(|| text.chars().take(MAX_PAGE_BYTES).collect())
    })
    .await
    .ok()
    .flatten()
}

/// The router's name from a KeeneticOS answer to /auth (X-NDM-Realm, e.g.
/// "Keenetic Giga"): empty when the header is there but empty, None when the
/// answer is not KeeneticOS's.
fn ndm_realm(response: &str) -> Option<String> {
    response
        .lines()
        .skip(1)
        .map(|line| line.trim_end_matches('\r'))
        .take_while(|line| !line.is_empty())
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("x-ndm-realm")
                .then(|| value.trim().chars().take(64).collect())
        })
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

/// Drops this computer's cached DNS answers, after the router's VPN for it
/// changed: no reconnect needed, unlike other devices. Best effort.
#[tauri::command]
pub async fn flush_dns_cache() -> bool {
    tokio::task::spawn_blocking(|| {
        #[cfg(target_os = "linux")]
        let status = std::process::Command::new("resolvectl")
            .arg("flush-caches")
            .status();
        #[cfg(windows)]
        let status = {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("ipconfig")
                .arg("/flushdns")
                .creation_flags(0x0800_0000)
                .status()
        };
        // The resolver cache of this user's processes; mDNSResponder's own
        // cache needs root, and the helper flushes it when DNS changes.
        #[cfg(target_os = "macos")]
        let status = std::process::Command::new("/usr/bin/dscacheutil")
            .arg("-flushcache")
            .status();
        #[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
        let status: std::io::Result<std::process::ExitStatus> =
            Err(std::io::Error::other("unsupported"));
        status.map(|status| status.success()).unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

// ------------------------------------------------------- device names ---

/// What a home device says about itself over UPnP (SSDP): smart TVs, set-top
/// boxes and media players announce a readable name, while DHCP only carries
/// a short host name such as "LGwebOSTV".
#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LanName {
    pub friendly_name: String,
    pub manufacturer: String,
    pub model: String,
}

const SSDP_ADDR: Ipv4Addr = Ipv4Addr::new(239, 255, 255, 250);
const SSDP_LISTEN: Duration = Duration::from_millis(2500);

/// Names announced by devices of the home network, by IPv4 address.
/// `local_ip` is this computer's address in that network: the search is
/// sent from it, so it reaches the home network and not a VPN tunnel.
#[tauri::command]
pub async fn lan_device_names(local_ip: String) -> std::collections::HashMap<String, LanName> {
    let mut names = std::collections::HashMap::new();
    let Ok(local) = local_ip.parse::<Ipv4Addr>() else {
        return names;
    };
    let answers = tokio::task::spawn_blocking(move || ssdp_search(local))
        .await
        .unwrap_or_default();
    let interface = default_gateway().and_then(|(_, interface)| interface);
    // A device answers ssdp:all once per service, mostly with the same
    // description: each one is fetched once, never again for every answer.
    let mut tried = std::collections::HashSet::new();
    for (ip, location) in answers {
        if names.contains_key(&ip.to_string()) || !tried.insert((ip, location.clone())) {
            continue;
        }
        let Some((port, path)) = location_on(&location, ip) else {
            continue;
        };
        let Some(page) = http_get_at(ip, port, interface.as_deref(), &path).await else {
            continue;
        };
        let name = LanName {
            friendly_name: xml_tag(&page, "friendlyName"),
            manufacturer: xml_tag(&page, "manufacturer"),
            model: xml_tag(&page, "modelName"),
        };
        if !name.friendly_name.is_empty() {
            names.insert(ip.to_string(), name);
        }
    }
    names
}

/// SSDP M-SEARCH from `local`; each answer's address and description URL.
fn ssdp_search(local: Ipv4Addr) -> Vec<(Ipv4Addr, String)> {
    use socket2::{Domain, Protocol, Socket, Type};
    let mut answers = Vec::new();
    let Ok(socket) = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)) else {
        return answers;
    };
    if socket.bind(&SocketAddr::from((local, 0)).into()).is_err()
        || socket.set_multicast_if_v4(&local).is_err()
    {
        return answers;
    }
    let _ = socket.set_multicast_ttl_v4(2);
    let socket: std::net::UdpSocket = socket.into();
    let request = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n";
    if socket
        .send_to(request.as_bytes(), SocketAddr::from((SSDP_ADDR, 1900)))
        .is_err()
    {
        return answers;
    }
    let deadline = std::time::Instant::now() + SSDP_LISTEN;
    let mut buffer = [0u8; 2048];
    while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
        if left.is_zero() || socket.set_read_timeout(Some(left)).is_err() {
            break;
        }
        let Ok((read, from)) = socket.recv_from(&mut buffer) else {
            break;
        };
        let std::net::SocketAddr::V4(from) = from else {
            continue;
        };
        if !from.ip().is_private() {
            continue;
        }
        let text = String::from_utf8_lossy(&buffer[..read]);
        if let Some(location) = text.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.trim()
                .eq_ignore_ascii_case("location")
                .then(|| value.trim().to_string())
        }) {
            answers.push((*from.ip(), location));
        }
    }
    answers
}

/// Port and path of a description URL served by the answering device
/// itself; any other host is ignored.
fn location_on(location: &str, ip: Ipv4Addr) -> Option<(u16, String)> {
    let rest = location.strip_prefix("http://")?;
    let (host_port, path) = rest.split_once('/').unwrap_or((rest, ""));
    let (host, port) = match host_port.rsplit_once(':') {
        Some((host, port)) => (host, port.parse().ok()?),
        None => (host_port, 80),
    };
    (host.parse::<Ipv4Addr>().ok()? == ip).then(|| (port, format!("/{path}")))
}

fn xml_tag(page: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    page.find(&open)
        .and_then(|start| {
            let value = &page[start + open.len()..];
            value.find(&close).map(|end| &value[..end])
        })
        .map(|value| {
            value
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .chars()
                .filter(|character| !character.is_control())
                .take(80)
                .collect::<String>()
                .trim()
                .to_string()
        })
        .unwrap_or_default()
}

/// One HTTP/1.0 GET to the router. On Linux the socket is bound to the
/// physical interface, so the request reaches the router even while an
/// older tunnel setup sends local networks into the VPN.
async fn http_get(gateway: Ipv4Addr, interface: Option<&str>, path: &str) -> Option<String> {
    http_get_at(gateway, 80, interface, path).await
}

async fn http_get_at(
    gateway: Ipv4Addr,
    port: u16,
    interface: Option<&str>,
    path: &str,
) -> Option<String> {
    let socket = TcpSocket::new_v4().ok()?;
    #[cfg(target_os = "linux")]
    if let Some(interface) = interface {
        let _ = socket.bind_device(Some(interface.as_bytes()));
    }
    #[cfg(not(target_os = "linux"))]
    let _ = interface;
    let mut stream = timeout(
        HTTP_TIMEOUT,
        socket.connect(SocketAddr::from((gateway, port))),
    )
    .await
    .ok()?
    .ok()?;
    let request =
        format!("GET {path} HTTP/1.0\r\nHost: {gateway}:{port}\r\nConnection: close\r\n\r\n");
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

/// macOS: the default route of a physical interface. The tunnel takes
/// 0/1 and 128/1 and leaves the default route alone, so this is the
/// network's own gateway also while connected; the LAN route to it is more
/// specific than the tunnel's, so no binding is needed.
#[cfg(target_os = "macos")]
fn default_gateway() -> Option<(Ipv4Addr, Option<String>)> {
    let output = std::process::Command::new("/sbin/route")
        .args(["-n", "get", "-inet", "default"])
        .output()
        .ok()?;
    parse_route_get(&String::from_utf8_lossy(&output.stdout)).map(|(gateway, _)| (gateway, None))
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn default_gateway() -> Option<(Ipv4Addr, Option<String>)> {
    None
}

/// The gateway and interface from `route -n get default` (macOS), unless the
/// route is a tunnel's.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_route_get(text: &str) -> Option<(Ipv4Addr, String)> {
    let field = |name: &str| {
        text.lines().find_map(|line| {
            let (key, value) = line.trim().split_once(':')?;
            (key.trim() == name).then(|| value.trim().to_string())
        })
    };
    let gateway = field("gateway")?.parse::<Ipv4Addr>().ok()?;
    let interface = field("interface")?;
    if interface.starts_with("utun") || gateway.is_unspecified() {
        return None;
    }
    Some((gateway, interface))
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
    #[test]
    fn reads_the_macos_default_route() {
        let wifi = "   route to: default\ndestination: default\n       mask: default\n    gateway: 192.168.1.1\n  interface: en0\n      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING>\n";
        assert_eq!(
            super::parse_route_get(wifi),
            Some(("192.168.1.1".parse().unwrap(), "en0".to_string()))
        );
        let tunnel = "destination: default\n    gateway: 198.18.0.1\n  interface: utun199\n";
        assert_eq!(super::parse_route_get(tunnel), None);
        assert_eq!(super::parse_route_get("route: writing to routing socket: not in table"), None);
    }


    #[test]
    fn sees_a_redirect_to_https() {
        assert!(redirects_to_https(
            "HTTP/1.1 302 Found\r\nLocation: https://192.168.1.1/cgi-bin/luci\r\n\r\n"
        ));
        assert!(!redirects_to_https(
            "HTTP/1.1 200 OK\r\n\r\n<a href=\"https://x\">"
        ));
        assert!(!redirects_to_https(
            "HTTP/1.1 302 Found\r\nLocation: /cgi-bin/luci\r\n\r\n"
        ));
    }

    #[test]
    fn router_mark_matches_the_agent() {
        // Router shell: printf '%s' "befe0dc8-..." | md5sum | cut -c1-16
        assert_eq!(
            router_mark("BEFE0DC8-F668-5434-847A-1D108CE7D224"),
            "5848f5aac4a78e07"
        );
        assert_eq!(
            parse_mark("HTTP/1.0 200 OK\r\n\r\ntobevpn-router b5eda37d94f713a3\n"),
            Some("b5eda37d94f713a3".to_string())
        );
        assert_eq!(parse_mark("<html>404</html>"), None);
    }

    use super::*;

    #[test]
    fn reads_keenetic_realm_from_auth_answer() {
        let answer = "HTTP/1.1 401 Unauthorized\r\nServer: nginx\r\nX-NDM-Realm: Keenetic Giga\r\nX-NDM-Challenge: ABC\r\n\r\n";
        assert_eq!(ndm_realm(answer).as_deref(), Some("Keenetic Giga"));
        assert_eq!(
            ndm_realm("HTTP/1.1 401 x\r\nx-ndm-realm: Netcraze Hopper\r\n\r\n").as_deref(),
            Some("Netcraze Hopper")
        );
        assert_eq!(
            ndm_realm("HTTP/1.1 401 x\r\nX-NDM-Realm:\r\n\r\n").as_deref(),
            Some("")
        );
        assert_eq!(
            ndm_realm("HTTP/1.1 404 Not Found\r\nServer: uhttpd\r\n\r\n"),
            None
        );
        // Only among the headers, not in the page.
        assert_eq!(ndm_realm("HTTP/1.1 200 OK\r\n\r\nX-NDM-Realm: fake"), None);
    }

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

#[cfg(test)]
mod lan_name_tests {
    use super::*;

    #[test]
    fn reads_description_url_and_names() {
        let ip = Ipv4Addr::new(192, 168, 1, 139);
        assert_eq!(
            location_on("http://192.168.1.139:1528/desc.xml", ip),
            Some((1528, "/desc.xml".to_string()))
        );
        assert_eq!(location_on("http://10.0.0.5:80/x.xml", ip), None);
        assert_eq!(location_on("https://192.168.1.139/x.xml", ip), None);
        let page = "<root><device><friendlyName>[LG] webOS TV UJ630V</friendlyName>\
                    <manufacturer>LG Electronics</manufacturer><modelName>LG TV</modelName></device></root>";
        assert_eq!(xml_tag(page, "friendlyName"), "[LG] webOS TV UJ630V");
        assert_eq!(xml_tag(page, "modelName"), "LG TV");
        assert_eq!(xml_tag(page, "serialNumber"), "");
    }
}
