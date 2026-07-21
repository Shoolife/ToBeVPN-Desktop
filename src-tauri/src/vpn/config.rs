use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr};

const MAX_BYPASS_HOSTS: usize = 64;
const MAX_SERVICE_DOMAINS: usize = 10_000;
const MAX_CUSTOM_DOMAINS: usize = 128;

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

impl ServerConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.port == 0 {
            return Err("VPN server port must be between 1 and 65535".into());
        }
        if !is_valid_uuid(&self.uuid)
            || self
                .uuid
                .eq_ignore_ascii_case("00000000-0000-0000-0000-000000000000")
        {
            return Err("VPN server UUID is invalid".into());
        }
        validate_endpoint_host(&self.address, "VPN server address")?;
        if let Ok(ip) = self.address.parse::<IpAddr>() {
            match ip {
                IpAddr::V4(ip) if is_allowed_server_ipv4(ip) => {}
                IpAddr::V4(_) => {
                    return Err("VPN server address is not a public IPv4 address".into())
                }
                IpAddr::V6(_) => return Err("IPv6 VPN endpoints are not supported".into()),
            }
        }
        if !matches!(self.security.as_str(), "none" | "tls" | "reality") {
            return Err("Unsupported VPN transport security".into());
        }
        if !matches!(self.network.as_str(), "tcp" | "ws" | "xhttp") {
            return Err("Unsupported VPN transport network".into());
        }
        if !self.flow.is_empty() && self.flow != "xtls-rprx-vision" {
            return Err("Unsupported VLESS flow".into());
        }
        if !self.sni.is_empty() {
            validate_endpoint_host(&self.sni, "VPN SNI")?;
        }
        if self.security == "reality" {
            if self.sni.is_empty()
                || self.public_key.len() < 20
                || self.public_key.len() > 128
                || !self
                    .public_key
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            {
                return Err("Reality server parameters are invalid".into());
            }
            if self.short_id.len() > 32
                || !self.short_id.len().is_multiple_of(2)
                || !self.short_id.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err("Reality short ID is invalid".into());
            }
        }
        validate_short_ascii(&self.fingerprint, 32, "TLS fingerprint")?;
        validate_text_field(&self.path, 2048, "transport path")?;
        validate_short_ascii(&self.mode, 32, "XHTTP mode")?;
        validate_text_field(&self.spx, 2048, "Reality spider path")?;
        if !matches!(
            self.routing_mode.as_str(),
            "blocked_only" | "selective" | "all_vpn"
        ) {
            return Err("Unsupported routing mode".into());
        }
        validate_domain_list(&self.bypass_hosts, MAX_BYPASS_HOSTS, "bypass hosts", true)?;
        validate_domain_list(
            &self.selected_service_domains,
            MAX_SERVICE_DOMAINS,
            "selected service domains",
            false,
        )?;
        validate_domain_list(
            &self.excluded_service_domains,
            MAX_SERVICE_DOMAINS,
            "excluded service domains",
            false,
        )?;
        validate_domain_list(
            &self.direct_domains,
            MAX_CUSTOM_DOMAINS,
            "direct domains",
            false,
        )?;
        validate_domain_list(
            &self.proxy_domains,
            MAX_CUSTOM_DOMAINS,
            "proxy domains",
            false,
        )?;
        Ok(())
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

fn validate_endpoint_host(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 253 || value.chars().any(char::is_control) {
        return Err(format!("{label} is invalid"));
    }
    if value.parse::<IpAddr>().is_ok() {
        return Ok(());
    }
    if !value.contains('.') || !is_valid_domain(value) {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

fn validate_short_ascii(value: &str, max_len: usize, label: &str) -> Result<(), String> {
    if value.len() > max_len
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!("VPN {label} is invalid"));
    }
    Ok(())
}

fn validate_text_field(value: &str, max_len: usize, label: &str) -> Result<(), String> {
    if value.len() > max_len || value.chars().any(char::is_control) {
        return Err(format!("VPN {label} is invalid"));
    }
    Ok(())
}

fn validate_domain_list(
    values: &[String],
    max_items: usize,
    label: &str,
    require_fqdn: bool,
) -> Result<(), String> {
    if values.len() > max_items {
        return Err(format!("Too many {label}"));
    }
    if values.iter().any(|value| {
        let normalized = value.trim().trim_start_matches("*.").trim_end_matches('.');
        !is_valid_domain(normalized) || (require_fqdn && !normalized.contains('.'))
    }) {
        return Err(format!("One or more {label} are invalid"));
    }
    Ok(())
}

fn is_valid_domain(domain: &str) -> bool {
    !domain.is_empty()
        && domain.len() <= 253
        && (domain.contains('.') || domain.len() >= 2)
        && domain.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

pub fn is_allowed_server_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0
        || a >= 240
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0)
        || (a == 198 && matches!(b, 18 | 19)))
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
    let mut user: serde_json::Map<String, Value> = serde_json::Map::new();
    user.insert("id".into(), json!(server.uuid));
    user.insert("level".into(), json!(8));
    user.insert("encryption".into(), json!("none"));
    if !server.flow.is_empty() {
        user.insert("flow".into(), json!(server.flow));
    }

    let mut proxy = json!({
        "tag": "proxy",
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
            if !server.mode.is_empty() {
                xhttp.insert("mode".into(), json!(server.mode));
            }
            ss["xhttpSettings"] = Value::Object(xhttp);
        }
        "ws" => {
            let mut ws = serde_json::Map::new();
            if !server.path.is_empty() {
                ws.insert("path".into(), json!(server.path));
            }
            ss["wsSettings"] = Value::Object(ws);
        }
        _ => {
            ss["tcpSettings"] = json!({ "header": { "type": "none" } });
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
    }

    ss
}

fn build_dns() -> Value {
    json!({
        "servers": ["1.1.1.1", "8.8.8.8"],
        "queryStrategy": "UseIP",
        "tag": "dns-module"
    })
}

fn normalize_domain_rules(domains: &[String]) -> Vec<String> {
    let mut rules = Vec::new();
    let mut seen = HashSet::new();
    for raw in domains {
        let domain = raw
            .trim()
            .trim_start_matches("*.")
            .trim_end_matches('.')
            .to_ascii_lowercase();
        if !is_valid_domain(&domain) {
            continue;
        }
        let rule = format!("domain:{domain}");
        if seen.insert(rule.clone()) {
            rules.push(rule);
        }
    }
    rules
}

fn build_routing(server: &ServerConfig) -> Value {
    let mut rules = vec![json!({
        "inboundTag": ["api"],
        "outboundTag": "api",
        "type": "field"
    })];

    let proxy_domains = normalize_domain_rules(&server.proxy_domains);
    if !proxy_domains.is_empty() {
        rules.push(json!({
            "type": "field",
            "domain": proxy_domains,
            "outboundTag": "proxy"
        }));
    }

    let direct_domains = normalize_domain_rules(&server.direct_domains);
    if !direct_domains.is_empty() {
        rules.push(json!({
            "type": "field",
            "domain": direct_domains,
            "outboundTag": "direct"
        }));
    }

    if server.routing_mode == "blocked_only" || server.routing_mode == "selective" {
        rules.push(json!({
            "type": "field",
            "port": "53",
            "network": "tcp,udp",
            "outboundTag": "proxy"
        }));
    }

    if server.routing_mode == "blocked_only"
        || (server.routing_mode == "selective" && server.select_all_services)
    {
        if server.routing_mode == "selective" {
            let excluded = normalize_domain_rules(&server.excluded_service_domains);
            if !excluded.is_empty() {
                rules.push(json!({
                    "type": "field",
                    "domain": excluded,
                    "outboundTag": "proxy"
                }));
            }
        }
        rules.push(json!({
            "type": "field",
            "domain": RU_DIRECT_DOMAIN_GROUPS,
            "outboundTag": "direct"
        }));
    } else if server.routing_mode == "selective" {
        let selected = normalize_domain_rules(&server.selected_service_domains);
        if !selected.is_empty() {
            rules.push(json!({
                "type": "field",
                "domain": selected,
                "outboundTag": "direct"
            }));
        }
    }

    if server.routing_mode == "blocked_only" || server.routing_mode == "selective" {
        rules.push(json!({
            "type": "field",
            "network": "tcp,udp",
            "outboundTag": "proxy"
        }));
    }

    json!({
        "domainStrategy": if server.routing_mode == "blocked_only"
            || server.routing_mode == "selective"
        {
            "IPIfNonMatch"
        } else {
            "AsIs"
        },
        "rules": rules
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_server() -> ServerConfig {
        ServerConfig {
            address: "1.1.1.1".into(),
            port: 443,
            uuid: "123e4567-e89b-42d3-a456-426614174000".into(),
            flow: String::new(),
            security: "reality".into(),
            sni: "example.com".into(),
            fingerprint: "chrome".into(),
            public_key: "0123456789abcdefghijklmnopqrstuv_-ABCD".into(),
            short_id: "0123abcd".into(),
            network: "tcp".into(),
            path: String::new(),
            mode: String::new(),
            spx: String::new(),
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
    fn validates_server_before_native_network_changes() {
        assert!(test_server().validate().is_ok());

        let mut private = test_server();
        private.address = "127.0.0.1".into();
        assert!(private.validate().is_err());

        let mut invalid_uuid = test_server();
        invalid_uuid.uuid = "not-a-uuid".into();
        assert!(invalid_uuid.validate().is_err());

        let mut oversized = test_server();
        oversized.direct_domains = vec!["example.com".into(); MAX_CUSTOM_DOMAINS + 1];
        assert!(oversized.validate().is_err());
    }

    #[test]
    fn rejects_non_public_resolved_server_addresses() {
        assert!(is_allowed_server_ipv4(Ipv4Addr::new(1, 1, 1, 1)));
        assert!(!is_allowed_server_ipv4(Ipv4Addr::LOCALHOST));
        assert!(!is_allowed_server_ipv4(Ipv4Addr::new(10, 0, 0, 1)));
        assert!(!is_allowed_server_ipv4(Ipv4Addr::new(100, 64, 0, 1)));
        assert!(!is_allowed_server_ipv4(Ipv4Addr::new(198, 18, 0, 1)));
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
        assert_eq!(config["routing"]["domainStrategy"], "IPIfNonMatch");
    }

    #[test]
    fn invalid_domains_are_not_written_to_xray_config() {
        let rules = normalize_domain_rules(&[
            " EXAMPLE.COM. ".into(),
            "*.sub.example.com".into(),
            "https://example.com".into(),
            "-broken.example".into(),
        ]);
        assert_eq!(
            rules,
            vec![
                "domain:example.com".to_string(),
                "domain:sub.example.com".to_string()
            ]
        );
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
        server.excluded_service_domains = vec!["direct.example".into()];
        server.direct_interface = "eth0".into();

        let config: Value = serde_json::from_str(&build_xray_config(&server)).unwrap();
        let rules = config["routing"]["rules"].as_array().unwrap();
        assert_eq!(rules[2]["domain"][0], "domain:direct.example");
        assert_eq!(rules[2]["outboundTag"], "proxy");
        assert_eq!(rules[3]["domain"][0], "geosite:category-bank-ru");
        assert_eq!(rules[3]["domain"][8], "geosite:category-ru");
        assert_eq!(rules[3]["domain"][10], "geosite:ru-available-only-inside");
        assert_eq!(rules[3]["outboundTag"], "direct");
    }
}
