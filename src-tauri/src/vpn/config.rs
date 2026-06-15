use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

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
    pub fn requires_direct_interface(&self) -> bool {
        matches!(self.routing_mode.as_str(), "blocked_only" | "selective")
            || !self.direct_domains.is_empty()
    }
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
            address: "203.0.113.10".into(),
            port: 443,
            uuid: "00000000-0000-0000-0000-000000000000".into(),
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
        assert_eq!(
            rules[4]["domain"][10],
            "geosite:ru-available-only-inside"
        );
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
        assert_eq!(
            rules[3]["domain"][10],
            "geosite:ru-available-only-inside"
        );
        assert_eq!(rules[3]["outboundTag"], "direct");
    }
}
