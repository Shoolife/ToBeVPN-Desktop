use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

const MAX_BYPASS_HOSTS: usize = 64;
const MAX_SERVICE_DOMAINS: usize = 10_000;
const MAX_CUSTOM_DOMAINS: usize = 128;
const MAX_EXTRA_BYTES: usize = 16 * 1024;

/// Server params received from the frontend (mirrors TV's Server model).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub address: String,
    pub port: u16,
    pub uuid: String,
    #[serde(default)]
    pub flow: String,
    #[serde(default = "default_security")]
    pub security: String,
    #[serde(default)]
    pub sni: String,
    #[serde(default = "default_fingerprint")]
    pub fingerprint: String,
    #[serde(default)]
    pub public_key: String,
    #[serde(default)]
    pub short_id: String,
    #[serde(default = "default_network")]
    pub network: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub spx: String,
    /// Transport fields from the subscription link, as on Android
    /// (VlessUrlParser / VpnConfig.buildStreamSettings).
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub alpn: String,
    #[serde(default)]
    pub header_type: String,
    #[serde(default)]
    pub service_name: String,
    /// Raw xhttp "extra" JSON object; ignored when it is not valid JSON.
    #[serde(default)]
    pub extra: String,
    /// "vless" or "hysteria2". Hysteria2 runs Xray's "hysteria" outbound over
    /// QUIC; `uuid` then carries its auth string (as on Android).
    #[serde(default = "default_protocol")]
    pub protocol: String,
    /// Hysteria2 salamander obfuscation password; empty = no obfuscation.
    #[serde(default)]
    pub obfs_password: String,
    /// Hysteria2 pinned certificate, hex SHA-256.
    #[serde(default)]
    pub pin_sha256: String,
    /// Hysteria2 port hopping spec, e.g. "443,20000-30000".
    #[serde(default)]
    pub port_hopping: String,
    /// Hysteria2 ECH config list (base64).
    #[serde(default)]
    pub ech_config_list: String,
    #[serde(default)]
    pub bypass_hosts: Vec<String>,
    #[serde(default = "default_routing_mode")]
    pub routing_mode: String,
    #[serde(default)]
    pub direct_domains: Vec<String>,
    #[serde(default)]
    pub proxy_domains: Vec<String>,
    #[serde(default)]
    pub select_all_services: bool,
    #[serde(default)]
    pub selected_service_domains: Vec<String>,
    #[serde(default)]
    pub excluded_service_domains: Vec<String>,
    #[serde(skip)]
    pub direct_interface: String,
}

fn default_security() -> String {
    "reality".into()
}
fn default_fingerprint() -> String {
    "chrome".into()
}
fn default_network() -> String {
    "tcp".into()
}
fn default_routing_mode() -> String {
    "blocked_only".into()
}
fn default_protocol() -> String {
    PROTOCOL_VLESS.into()
}

pub const PROTOCOL_VLESS: &str = "vless";
pub const PROTOCOL_HYSTERIA2: &str = "hysteria2";

impl ServerConfig {
    /// Reject malformed or unreasonably large frontend input before a VPN
    /// manager starts changing routes, DNS, or interfaces. Deliberately do
    /// not require a public address: private, loopback, and IPv6 endpoints
    /// are valid for self-hosted and local deployments.
    pub fn validate(&self) -> Result<(), String> {
        if self.port == 0 {
            return Err("VPN server port must be between 1 and 65535".into());
        }
        if self.is_hysteria2() {
            validate_required_text(&self.uuid, 512, "Hysteria2 auth")?;
            validate_optional_text(&self.obfs_password, 512, "Hysteria2 obfuscation password")?;
            validate_optional_text(&self.ech_config_list, 4096, "Hysteria2 ECH config")?;
            if !self.pin_sha256.is_empty() && !is_hex_sha256(&self.pin_sha256) {
                return Err("VPN Hysteria2 certificate pin is invalid".into());
            }
            if !self.port_hopping.is_empty() && !is_valid_port_list(&self.port_hopping) {
                return Err("VPN Hysteria2 port hopping range is invalid".into());
            }
        } else if self.protocol != PROTOCOL_VLESS {
            return Err("Unsupported VPN protocol".into());
        } else if !is_valid_vless_id(&self.uuid)
            || self
                .uuid
                .eq_ignore_ascii_case("00000000-0000-0000-0000-000000000000")
        {
            return Err("VPN server VLESS user ID is invalid".into());
        }

        validate_required_text(&self.address, 253, "VPN server address")?;
        validate_optional_text(&self.flow, 128, "VLESS flow")?;
        validate_optional_text(&self.security, 32, "transport security")?;
        validate_optional_text(&self.sni, 253, "VPN SNI")?;
        validate_optional_text(&self.fingerprint, 64, "TLS fingerprint")?;
        validate_optional_text(&self.public_key, 256, "Reality public key")?;
        validate_optional_text(&self.short_id, 64, "Reality short ID")?;
        validate_optional_text(&self.network, 32, "transport network")?;
        validate_optional_text(&self.path, 2048, "transport path")?;
        validate_optional_text(&self.mode, 64, "XHTTP mode")?;
        validate_optional_text(&self.spx, 2048, "Reality spider path")?;
        validate_optional_text(&self.host, 512, "transport host")?;
        validate_optional_text(&self.alpn, 128, "TLS ALPN")?;
        validate_optional_text(&self.header_type, 32, "TCP header type")?;
        validate_optional_text(&self.service_name, 512, "gRPC service name")?;
        // JSON may span lines, so only its size is bounded here; an invalid
        // object is simply left out of the config (xhttp_extra).
        if self.extra.len() > MAX_EXTRA_BYTES {
            return Err("XHTTP extra settings are too large".into());
        }

        if !matches!(
            self.routing_mode.as_str(),
            "blocked_only" | "selective" | "all_vpn"
        ) {
            return Err("Unsupported routing mode".into());
        }

        validate_text_list(&self.bypass_hosts, MAX_BYPASS_HOSTS, 253, "bypass hosts")?;
        validate_text_list(
            &self.selected_service_domains,
            MAX_SERVICE_DOMAINS,
            253,
            "selected service domains",
        )?;
        validate_text_list(
            &self.excluded_service_domains,
            MAX_SERVICE_DOMAINS,
            253,
            "excluded service domains",
        )?;
        validate_text_list(
            &self.direct_domains,
            MAX_CUSTOM_DOMAINS,
            253,
            "direct domains",
        )?;
        validate_text_list(
            &self.proxy_domains,
            MAX_CUSTOM_DOMAINS,
            253,
            "proxy domains",
        )?;
        Ok(())
    }

    pub fn is_hysteria2(&self) -> bool {
        self.protocol == PROTOCOL_HYSTERIA2
    }

    pub fn requires_direct_interface(&self) -> bool {
        matches!(self.routing_mode.as_str(), "blocked_only" | "selective")
            || !self.direct_domains.is_empty()
    }

    pub fn requires_geosite_assets(&self) -> bool {
        self.routing_mode == "blocked_only"
            || (self.routing_mode == "selective" && self.select_all_services)
    }
}

fn is_valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn is_valid_vless_id(value: &str) -> bool {
    is_valid_uuid(value)
        || (!value.is_empty()
            && value.len() < 30
            && !value.chars().any(|character| character.is_control()))
}

fn is_hex_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// "443" or "443,20000-30000": ports 1..65535, ranges ascending.
fn is_valid_port_list(value: &str) -> bool {
    value.len() <= 256
        && value.split(',').all(|part| {
            let mut bounds = part.splitn(2, '-');
            let port = |text: Option<&str>| {
                text.and_then(|text| text.parse::<u16>().ok())
                    .filter(|port| *port > 0)
            };
            match (port(bounds.next()), bounds.next()) {
                (Some(_), None) => true,
                (Some(low), Some(high)) => port(Some(high)).is_some_and(|high| low <= high),
                _ => false,
            }
        })
}

fn validate_required_text(value: &str, max_len: usize, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > max_len
        || value.chars().any(|character| character.is_control())
    {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

fn validate_optional_text(value: &str, max_len: usize, label: &str) -> Result<(), String> {
    if value.len() > max_len || value.chars().any(|character| character.is_control()) {
        return Err(format!("VPN {label} is invalid"));
    }
    Ok(())
}

fn validate_text_list(
    values: &[String],
    max_items: usize,
    max_item_len: usize,
    label: &str,
) -> Result<(), String> {
    if values.len() > max_items {
        return Err(format!("Too many {label}"));
    }
    if values.iter().any(|value| {
        value.len() > max_item_len || value.chars().any(|character| character.is_control())
    }) {
        return Err(format!("One or more {label} are invalid"));
    }
    Ok(())
}

pub const SOCKS_PORT: u16 = 10809;
pub const STATS_API_PORT: u16 = 10086;

const RU_DIRECT_DOMAIN_GROUPS: &[&str] = &[
    "geosite:category-bank-ru",
    "geosite:category-betting-ru",
    "geosite:category-ecommerce-ru",
    "geosite:category-entertainment-ru",
    "geosite:category-gov-ru",
    "geosite:category-media-ru",
    "geosite:category-medicine-ru",
    "geosite:category-retail-ru",
    "geosite:category-ru",
    "geosite:category-travel-ru",
    "geosite:ru-available-only-inside",
];

/// Build the full xray-core JSON config.
/// Mirrors TV's VpnConfig.kt but without the TUN inbound (tun2socks handles that).
pub fn build_xray_config(server: &ServerConfig) -> String {
    let config = json!({
        "stats": {},
        "log": { "loglevel": "info" },
        "api": {
            "tag": "api",
            "services": ["StatsService"]
        },
        "policy": build_policy(),
        "inbounds": build_inbounds(),
        "outbounds": build_outbounds(server),
        "dns": build_dns(),
        "routing": build_routing(server),
        "xudp": { "baseKey": server.uuid }
    });
    serde_json::to_string_pretty(&config).unwrap()
}

fn build_policy() -> Value {
    json!({
        "levels": {
            "8": {
                "handshake": 4,
                "connIdle": 300,
                "uplinkOnly": 1,
                "downlinkOnly": 1
            }
        },
        "system": {
            "statsOutboundUplink": true,
            "statsOutboundDownlink": true
        }
    })
}

fn build_inbounds() -> Value {
    json!([
        {
            "tag": "socks",
            "port": SOCKS_PORT,
            "protocol": "socks",
            "listen": "127.0.0.1",
            "settings": {
                "auth": "noauth",
                "udp": true,
                "userLevel": 8
            },
            "sniffing": {
                "enabled": true,
                "destOverride": ["http", "tls", "quic"],
                "routeOnly": false
            }
        },
        {
            "tag": "api",
            "port": STATS_API_PORT,
            "protocol": "dokodemo-door",
            "listen": "127.0.0.1",
            "settings": {
                "address": "127.0.0.1"
            }
        }
    ])
}

fn build_outbounds(server: &ServerConfig) -> Value {
    let proxy = build_proxy_outbound(server, "proxy");

    let mut direct = json!({
        "tag": "direct",
        "protocol": "freedom",
        "settings": { "domainStrategy": "UseIP" }
    });
    if !server.direct_interface.is_empty() {
        direct["streamSettings"] = json!({
            "sockopt": {
                "interface": server.direct_interface
            }
        });
    }

    json!([
        proxy,
        direct,
        {
            "tag": "block",
            "protocol": "blackhole",
            "settings": { "response": { "type": "http" } }
        }
    ])
}

/// The VLESS outbound for one server. Shared by the tunnel config and the
/// server check (server_probe.rs), so a check exercises exactly the profile
/// a connection would use.
pub fn build_proxy_outbound(server: &ServerConfig, tag: &str) -> Value {
    if server.is_hysteria2() {
        return build_hysteria2_outbound(server, tag);
    }
    let mut user: serde_json::Map<String, Value> = serde_json::Map::new();
    user.insert("id".into(), json!(server.uuid));
    user.insert("level".into(), json!(8));
    user.insert("encryption".into(), json!("none"));
    if !server.flow.is_empty() {
        user.insert("flow".into(), json!(server.flow));
    }

    let mut proxy = json!({
        "tag": tag,
        "protocol": "vless",
        "settings": {
            "vnext": [{
                "address": server.address,
                "port": server.port,
                "users": [user]
            }]
        },
        "streamSettings": build_stream_settings(server)
    });

    if server.network != "xhttp" {
        proxy["mux"] = json!({ "enabled": false, "concurrency": -1 });
    }
    proxy
}

/// Xray's "hysteria" outbound for a Hysteria2 server, as Android's
/// VpnConfig.buildHysteria2Outbound: TLS over QUIC (no uTLS fingerprint,
/// allowInsecure no longer exists), auth in hysteriaSettings, salamander and
/// port hopping as UDP finalmasks.
fn build_hysteria2_outbound(server: &ServerConfig, tag: &str) -> Value {
    let server_name = if server.sni.is_empty() {
        server.address.as_str()
    } else {
        server.sni.as_str()
    };
    let alpn = alpn_list(&server.alpn);
    let mut tls = json!({
        "serverName": server_name,
        "alpn": if alpn.is_empty() { vec!["h3".to_string()] } else { alpn },
    });
    if !server.pin_sha256.is_empty() {
        tls["pinnedPeerCertSha256"] = json!(server.pin_sha256);
    }
    if !server.ech_config_list.is_empty() {
        tls["echConfigList"] = json!(server.ech_config_list);
    }
    let mut stream = json!({
        "network": "hysteria",
        "security": "tls",
        "tlsSettings": tls,
        "hysteriaSettings": { "version": 2, "auth": server.uuid },
    });
    let mut masks = Vec::new();
    if !server.port_hopping.is_empty() {
        masks.push(json!({
            "type": "udphop",
            "settings": { "mode": "intervalRemote", "remotePorts": server.port_hopping },
        }));
    }
    if !server.obfs_password.is_empty() {
        masks.push(json!({
            "type": "salamander",
            "settings": { "password": server.obfs_password },
        }));
    }
    if !masks.is_empty() {
        stream["finalmask"] = json!({ "udp": masks });
    }
    json!({
        "tag": tag,
        "protocol": "hysteria",
        "settings": { "version": 2, "address": server.address, "port": server.port },
        "streamSettings": stream,
    })
}

fn build_stream_settings(server: &ServerConfig) -> Value {
    let mut ss = json!({
        "network": server.network,
        "security": server.security
    });

    match server.network.as_str() {
        "xhttp" => {
            let mut xhttp = serde_json::Map::new();
            if !server.path.is_empty() {
                xhttp.insert("path".into(), json!(server.path));
            }
            if !server.host.is_empty() {
                xhttp.insert("host".into(), json!(server.host));
            }
            if !server.mode.is_empty() {
                xhttp.insert("mode".into(), json!(server.mode));
            }
            if let Some(extra) = xhttp_extra(&server.extra) {
                xhttp.insert("extra".into(), extra);
            }
            ss["xhttpSettings"] = Value::Object(xhttp);
        }
        "ws" => {
            let mut ws = serde_json::Map::new();
            if !server.path.is_empty() {
                ws.insert("path".into(), json!(server.path));
            }
            if !server.host.is_empty() {
                ws.insert("host".into(), json!(server.host));
                ws.insert("headers".into(), json!({ "Host": server.host }));
            }
            ss["wsSettings"] = Value::Object(ws);
        }
        "grpc" => {
            let mut grpc = serde_json::Map::new();
            grpc.insert("serviceName".into(), json!(server.service_name));
            grpc.insert(
                "multiMode".into(),
                json!(server.mode.eq_ignore_ascii_case("multi")),
            );
            if !server.host.is_empty() {
                grpc.insert("authority".into(), json!(server.host));
            }
            ss["grpcSettings"] = Value::Object(grpc);
        }
        _ => {
            if server.header_type.eq_ignore_ascii_case("http") {
                let mut request = serde_json::Map::new();
                if !server.path.trim().is_empty() {
                    request.insert("path".into(), json!([server.path]));
                }
                if !server.host.trim().is_empty() {
                    request.insert("headers".into(), json!({ "Host": [server.host] }));
                }
                ss["tcpSettings"] = json!({
                    "header": { "type": "http", "request": request, "response": {} }
                });
            } else {
                ss["tcpSettings"] = json!({ "header": { "type": "none" } });
            }
        }
    }

    if server.security == "reality" {
        let spx = if server.spx.is_empty() {
            "/"
        } else {
            &server.spx
        };
        ss["realitySettings"] = json!({
            "allowInsecure": false,
            "serverName": server.sni,
            "fingerprint": server.fingerprint,
            "publicKey": server.public_key,
            "shortId": server.short_id,
            "spiderX": spx
        });
    } else if server.security == "tls" {
        ss["tlsSettings"] = json!({
            "allowInsecure": false,
            "serverName": server.sni,
            "fingerprint": server.fingerprint
        });
        let alpn = alpn_list(&server.alpn);
        if !alpn.is_empty() {
            ss["tlsSettings"]["alpn"] = json!(alpn);
        }
    }

    ss
}

/// "h2,http/1.1" -> ["h2", "http/1.1"], trimmed and without duplicates.
fn alpn_list(raw: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    raw.split(',')
        .map(str::trim)
        .filter(|protocol| !protocol.is_empty() && seen.insert(protocol.to_string()))
        .map(str::to_string)
        .collect()
}

/// The xhttp "extra" object; anything that is not a JSON object is ignored,
/// as on Android.
fn xhttp_extra(raw: &str) -> Option<Value> {
    if raw.trim().is_empty() || raw.len() > MAX_EXTRA_BYTES {
        return None;
    }
    serde_json::from_str::<Value>(raw)
        .ok()
        .filter(Value::is_object)
}

fn build_dns() -> Value {
    json!({
        "servers": ["1.1.1.1", "8.8.8.8"],
        "queryStrategy": "UseIP",
        "tag": "dns-module"
    })
}

fn normalize_domain(raw: &str) -> Option<String> {
    let domain = raw
        .trim()
        .trim_start_matches("*.")
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if domain.is_empty()
        || domain.len() > 253
        || (!domain.contains('.') && domain.len() < 2)
        || domain.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        return None;
    }
    Some(domain)
}

/// Domain rules where the most specific entry wins, whatever list it is in.
///
/// Xray takes the first matching rule and `domain:` also matches every
/// subdomain, so a plain "direct" list followed by a "proxy" list let a zone
/// override the sites inside it (an unchecked "ru" sent every checked .ru
/// service through the tunnel). Rules are emitted from the deepest domains up,
/// so `music.yandex.ru` decides before `yandex.ru`, and that before `ru`.
/// A domain present in both lists counts as `first_tag`.
fn longest_match_domain_rules(
    first: &[String],
    first_tag: &str,
    second: &[String],
    second_tag: &str,
) -> Vec<Value> {
    let mut entries: Vec<(String, usize, &str)> = Vec::new();
    let mut seen = HashSet::new();
    for (list, (domains, tag)) in [(first, first_tag), (second, second_tag)]
        .into_iter()
        .enumerate()
    {
        for domain in domains.iter().filter_map(|raw| normalize_domain(raw)) {
            if seen.insert(domain.clone()) {
                entries.push((domain, list, tag));
            }
        }
    }
    let depth = |domain: &str| domain.split('.').count();
    // Deepest first; one rule per depth and outbound keeps the config small.
    // Domains of equal depth never match the same host, so their order is
    // only for a stable config.
    entries.sort_by(|(left, left_list, _), (right, right_list, _)| {
        depth(right)
            .cmp(&depth(left))
            .then_with(|| left_list.cmp(right_list))
            .then_with(|| left.cmp(right))
    });
    let mut rules: Vec<Value> = Vec::new();
    let mut current: Option<(usize, &str, Vec<String>)> = None;
    for (domain, _, tag) in entries {
        let level = depth(&domain);
        match &mut current {
            Some((current_level, current_tag, list))
                if *current_level == level && *current_tag == tag =>
            {
                list.push(format!("domain:{domain}"));
            }
            _ => {
                if let Some((_, done_tag, list)) = current.take() {
                    rules.push(json!({ "type": "field", "domain": list, "outboundTag": done_tag }));
                }
                current = Some((level, tag, vec![format!("domain:{domain}")]));
            }
        }
    }
    if let Some((_, done_tag, list)) = current {
        rules.push(json!({ "type": "field", "domain": list, "outboundTag": done_tag }));
    }
    rules
}

fn build_routing(server: &ServerConfig) -> Value {
    let mut rules = vec![json!({
        "inboundTag": ["api"],
        "outboundTag": "api",
        "type": "field"
    })];

    // The user's own exceptions come first and decide among themselves by
    // specificity: "always VPN" for music.yandex.ru beats "always direct"
    // for yandex.ru and the other way round.
    rules.extend(longest_match_domain_rules(
        &server.proxy_domains,
        "proxy",
        &server.direct_domains,
        "direct",
    ));

    if server.routing_mode == "blocked_only" || server.routing_mode == "selective" {
        rules.push(json!({
            "type": "field",
            "port": "53",
            "network": "tcp,udp",
            "outboundTag": "proxy"
        }));
    }

    if server.routing_mode == "selective" {
        // Checked services go direct, unchecked ones the app sends along
        // (those inside a checked zone, or all excluded ones with "select
        // all") through the tunnel; the deepest entry decides.
        rules.extend(longest_match_domain_rules(
            &server.excluded_service_domains,
            "proxy",
            &server.selected_service_domains,
            "direct",
        ));
    }

    if server.routing_mode == "blocked_only"
        || (server.routing_mode == "selective" && server.select_all_services)
    {
        rules.push(json!({
            "type": "field",
            "domain": RU_DIRECT_DOMAIN_GROUPS,
            "outboundTag": "direct"
        }));
    }

    if server.routing_mode == "blocked_only" || server.routing_mode == "selective" {
        rules.push(json!({
            "type": "field",
            "network": "tcp,udp",
            "outboundTag": "proxy"
        }));
    }

    json!({
        // No rule matches on IP, so resolving unmatched domains first
        // (IPIfNonMatch) only delayed new connections.
        "domainStrategy": "AsIs",
        "rules": rules
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_server() -> ServerConfig {
        ServerConfig {
            address: "203.0.113.10".into(),
            port: 443,
            uuid: "123e4567-e89b-42d3-a456-426614174000".into(),
            flow: String::new(),
            security: "reality".into(),
            sni: "example.com".into(),
            fingerprint: "chrome".into(),
            public_key: "test".into(),
            short_id: "test".into(),
            network: "tcp".into(),
            path: String::new(),
            mode: String::new(),
            spx: String::new(),
            host: String::new(),
            alpn: String::new(),
            header_type: String::new(),
            service_name: String::new(),
            extra: String::new(),
            protocol: PROTOCOL_VLESS.into(),
            obfs_password: String::new(),
            pin_sha256: String::new(),
            port_hopping: String::new(),
            ech_config_list: String::new(),
            bypass_hosts: Vec::new(),
            routing_mode: "blocked_only".into(),
            direct_domains: Vec::new(),
            proxy_domains: Vec::new(),
            select_all_services: false,
            selected_service_domains: Vec::new(),
            excluded_service_domains: Vec::new(),
            direct_interface: String::new(),
        }
    }

    #[test]
    fn validates_server_input_without_forbidding_private_or_ipv6_endpoints() {
        assert!(test_server().validate().is_ok());

        let mut custom_id = test_server();
        custom_id.uuid = "custom-vless-user".into();
        assert!(custom_id.validate().is_ok());

        let mut private = test_server();
        private.address = "10.0.0.4".into();
        assert!(private.validate().is_ok());

        private.address = "::1".into();
        assert!(private.validate().is_ok());
    }

    #[test]
    fn rejects_malformed_or_unbounded_server_input() {
        let mut invalid_port = test_server();
        invalid_port.port = 0;
        assert!(invalid_port.validate().is_err());

        let mut invalid_id = test_server();
        invalid_id.uuid = "x".repeat(30);
        assert!(invalid_id.validate().is_err());

        let mut invalid_routing = test_server();
        invalid_routing.routing_mode = "typo".into();
        assert!(invalid_routing.validate().is_err());

        let mut oversized = test_server();
        oversized.direct_domains = vec!["example.com".into(); MAX_CUSTOM_DOMAINS + 1];
        assert!(oversized.validate().is_err());

        let mut control_character = test_server();
        control_character.address = "vpn.example.com\nignored".into();
        assert!(control_character.validate().is_err());
    }

    #[test]
    fn all_vpn_keeps_direct_outbound_unbound_and_has_no_automatic_rules() {
        let mut server = test_server();
        server.routing_mode = "all_vpn".into();
        let config: Value = serde_json::from_str(&build_xray_config(&server)).unwrap();
        assert!(config["outbounds"][1].get("streamSettings").is_none());
        assert_eq!(config["routing"]["rules"].as_array().unwrap().len(), 1);
        assert_eq!(config["routing"]["domainStrategy"], "AsIs");
    }

    #[test]
    fn split_routing_prioritizes_proxy_over_direct_and_binds_interface() {
        let mut server = test_server();
        server.routing_mode = "blocked_only".into();
        server.proxy_domains = vec!["vpn.example.com".into()];
        server.direct_domains = vec!["direct.example.net".into()];
        server.direct_interface = "eth0".into();

        let config: Value = serde_json::from_str(&build_xray_config(&server)).unwrap();
        assert_eq!(
            config["outbounds"][1]["streamSettings"]["sockopt"]["interface"],
            "eth0"
        );

        let rules = config["routing"]["rules"].as_array().unwrap();
        assert_eq!(rules[1]["outboundTag"], "proxy");
        assert_eq!(rules[1]["domain"][0], "domain:vpn.example.com");
        assert_eq!(rules[2]["outboundTag"], "direct");
        assert_eq!(rules[2]["domain"][0], "domain:direct.example.net");
        assert_eq!(rules[3]["outboundTag"], "proxy");
        assert_eq!(rules[3]["port"], "53");
        assert_eq!(rules[4]["outboundTag"], "direct");
        assert_eq!(rules[4]["domain"][0], "geosite:category-bank-ru");
        assert_eq!(rules[4]["domain"][8], "geosite:category-ru");
        assert_eq!(rules[4]["domain"][10], "geosite:ru-available-only-inside");
        assert_eq!(rules[5]["outboundTag"], "proxy");
        assert_eq!(rules[5]["network"], "tcp,udp");
        assert_eq!(config["routing"]["domainStrategy"], "AsIs");
    }

    #[test]
    fn invalid_domains_are_not_written_to_xray_config() {
        let rules = longest_match_domain_rules(
            &[
                " EXAMPLE.COM. ".into(),
                "*.sub.example.com".into(),
                "https://example.com".into(),
                "-broken.example".into(),
            ],
            "direct",
            &[],
            "proxy",
        );
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0]["domain"], json!(["domain:sub.example.com"]));
        assert_eq!(rules[1]["domain"], json!(["domain:example.com"]));
    }

    #[test]
    fn most_specific_domain_decides_across_lists() {
        let rules = longest_match_domain_rules(
            &["ru".into(), "music.yandex.ru".into()],
            "proxy",
            &["yandex.ru".into(), "sberbank.ru".into(), "ru".into()],
            "direct",
        );
        // music.yandex.ru, then the second-level sites, then the zone.
        assert_eq!(rules[0]["domain"], json!(["domain:music.yandex.ru"]));
        assert_eq!(rules[0]["outboundTag"], "proxy");
        assert_eq!(
            rules[1]["domain"],
            json!(["domain:sberbank.ru", "domain:yandex.ru"])
        );
        assert_eq!(rules[1]["outboundTag"], "direct");
        // A domain in both lists belongs to the first one.
        assert_eq!(rules[2]["domain"], json!(["domain:ru"]));
        assert_eq!(rules[2]["outboundTag"], "proxy");
        assert_eq!(rules.len(), 3);
    }

    #[test]
    fn user_exceptions_follow_specificity() {
        let mut server = test_server();
        server.routing_mode = "all_vpn".into();
        server.proxy_domains = vec!["yandex.ru".into()];
        server.direct_domains = vec!["music.yandex.ru".into()];
        let config: Value = serde_json::from_str(&build_xray_config(&server)).unwrap();
        let rules = config["routing"]["rules"].as_array().unwrap();
        assert_eq!(rules[1]["domain"][0], "domain:music.yandex.ru");
        assert_eq!(rules[1]["outboundTag"], "direct");
        assert_eq!(rules[2]["domain"][0], "domain:yandex.ru");
        assert_eq!(rules[2]["outboundTag"], "proxy");
    }

    #[test]
    fn selective_routing_uses_only_selected_domains() {
        let mut server = test_server();
        server.routing_mode = "selective".into();
        server.selected_service_domains = vec!["direct.example".into()];
        server.direct_interface = "eth0".into();

        let config: Value = serde_json::from_str(&build_xray_config(&server)).unwrap();
        let rules = config["routing"]["rules"].as_array().unwrap();
        assert_eq!(rules[1]["port"], "53");
        assert_eq!(rules[2]["domain"][0], "domain:direct.example");
        assert_eq!(rules[2]["outboundTag"], "direct");
        assert_eq!(rules[3]["outboundTag"], "proxy");
        assert_eq!(rules[3]["network"], "tcp,udp");
        assert!(rules
            .iter()
            .all(|rule| rule["domain"][0] != "geosite:category-bank-ru"));
    }

    #[test]
    fn selective_select_all_uses_database_with_direct_exclusions() {
        let mut server = test_server();
        server.routing_mode = "selective".into();
        server.select_all_services = true;
        server.excluded_service_domains = vec!["ru".into()];
        // Checked again inside the excluded zone.
        server.selected_service_domains = vec!["sberbank.ru".into()];
        server.direct_interface = "eth0".into();

        let config: Value = serde_json::from_str(&build_xray_config(&server)).unwrap();
        let rules = config["routing"]["rules"].as_array().unwrap();
        assert_eq!(rules[2]["domain"][0], "domain:sberbank.ru");
        assert_eq!(rules[2]["outboundTag"], "direct");
        assert_eq!(rules[3]["domain"][0], "domain:ru");
        assert_eq!(rules[3]["outboundTag"], "proxy");
        assert_eq!(rules[4]["domain"][0], "geosite:category-bank-ru");
        assert_eq!(rules[4]["domain"][8], "geosite:category-ru");
        assert_eq!(rules[4]["domain"][10], "geosite:ru-available-only-inside");
        assert_eq!(rules[4]["outboundTag"], "direct");
    }

    #[test]
    fn profiles_without_protocol_stay_vless() {
        let server: ServerConfig = serde_json::from_value(serde_json::json!({
            "address": "1.2.3.4", "port": 443,
            "uuid": "11111111-1111-4111-8111-111111111111"
        }))
        .unwrap();
        assert_eq!(server.protocol, PROTOCOL_VLESS);
        assert_eq!(build_proxy_outbound(&server, "proxy")["protocol"], "vless");
    }

    #[test]
    fn hysteria2_outbound_matches_android() {
        let mut server = test_server();
        server.protocol = PROTOCOL_HYSTERIA2.into();
        server.uuid = "a long hysteria2 auth string that is not a uuid".into();
        server.security = "tls".into();
        server.sni = String::new();
        server.alpn = String::new();
        assert!(server.validate().is_ok());

        let outbound = build_proxy_outbound(&server, "proxy");
        assert_eq!(outbound["protocol"], "hysteria");
        assert_eq!(outbound["settings"]["version"], 2);
        assert_eq!(outbound["settings"]["address"], "203.0.113.10");
        assert_eq!(outbound["settings"]["port"], 443);
        let stream = &outbound["streamSettings"];
        assert_eq!(stream["network"], "hysteria");
        assert_eq!(stream["security"], "tls");
        assert_eq!(stream["tlsSettings"]["serverName"], "203.0.113.10");
        assert_eq!(stream["tlsSettings"]["alpn"], serde_json::json!(["h3"]));
        assert!(stream["tlsSettings"].get("fingerprint").is_none());
        assert!(stream["tlsSettings"].get("allowInsecure").is_none());
        assert_eq!(stream["hysteriaSettings"]["auth"], server.uuid);
        assert!(stream.get("finalmask").is_none());
        assert!(outbound.get("mux").is_none());

        server.sni = "hy.example".into();
        server.obfs_password = "secret".into();
        server.port_hopping = "443,20000-30000".into();
        server.pin_sha256 = "ab".repeat(32);
        assert!(server.validate().is_ok());
        let stream = build_proxy_outbound(&server, "proxy")["streamSettings"].clone();
        assert_eq!(stream["tlsSettings"]["serverName"], "hy.example");
        assert_eq!(
            stream["tlsSettings"]["pinnedPeerCertSha256"],
            "ab".repeat(32)
        );
        assert_eq!(stream["finalmask"]["udp"][0]["type"], "udphop");
        assert_eq!(
            stream["finalmask"]["udp"][0]["settings"]["remotePorts"],
            "443,20000-30000"
        );
        assert_eq!(stream["finalmask"]["udp"][1]["type"], "salamander");
        assert_eq!(
            stream["finalmask"]["udp"][1]["settings"]["password"],
            "secret"
        );
    }

    #[test]
    fn rejects_malformed_hysteria2_fields() {
        let mut server = test_server();
        server.protocol = PROTOCOL_HYSTERIA2.into();
        server.port_hopping = "30000-20000".into();
        assert!(server.validate().is_err());
        server.port_hopping = "443,abc".into();
        assert!(server.validate().is_err());
        server.port_hopping = "443,20000-30000".into();
        server.pin_sha256 = "not-hex".into();
        assert!(server.validate().is_err());
        server.pin_sha256 = String::new();
        assert!(server.validate().is_ok());
        server.uuid = String::new();
        assert!(server.validate().is_err());

        let mut unknown = test_server();
        unknown.protocol = "trojan".into();
        assert!(unknown.validate().is_err());
    }

    #[test]
    fn transport_fields_match_android() {
        let base = || -> ServerConfig {
            serde_json::from_value(serde_json::json!({
                "address": "1.2.3.4", "port": 443,
                "uuid": "11111111-1111-4111-8111-111111111111",
                "security": "tls", "sni": "s.example", "alpn": "h2, http/1.1,h2"
            }))
            .unwrap()
        };
        let mut ws = base();
        ws.network = "ws".into();
        ws.path = "/ws".into();
        ws.host = "cdn.example".into();
        let ss = build_stream_settings(&ws);
        assert_eq!(ss["wsSettings"]["headers"]["Host"], "cdn.example");
        assert_eq!(
            ss["tlsSettings"]["alpn"],
            serde_json::json!(["h2", "http/1.1"])
        );

        let mut grpc = base();
        grpc.network = "grpc".into();
        grpc.service_name = "svc".into();
        grpc.mode = "multi".into();
        let ss = build_stream_settings(&grpc);
        assert_eq!(ss["grpcSettings"]["serviceName"], "svc");
        assert_eq!(ss["grpcSettings"]["multiMode"], true);

        let mut xhttp = base();
        xhttp.network = "xhttp".into();
        xhttp.host = "h.example".into();
        xhttp.extra = r#"{"xPaddingBytes":"100-1000"}"#.into();
        let ss = build_stream_settings(&xhttp);
        assert_eq!(ss["xhttpSettings"]["host"], "h.example");
        assert_eq!(ss["xhttpSettings"]["extra"]["xPaddingBytes"], "100-1000");
        xhttp.extra = "not json".into();
        assert!(build_stream_settings(&xhttp)["xhttpSettings"]
            .get("extra")
            .is_none());

        let mut tcp = base();
        tcp.header_type = "http".into();
        tcp.path = "/p".into();
        tcp.host = "h.example".into();
        let ss = build_stream_settings(&tcp);
        assert_eq!(ss["tcpSettings"]["header"]["type"], "http");
        assert_eq!(
            ss["tcpSettings"]["header"]["request"]["headers"]["Host"][0],
            "h.example"
        );
    }
}
