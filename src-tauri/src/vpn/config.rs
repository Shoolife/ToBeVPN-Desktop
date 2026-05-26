use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

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

pub const SOCKS_PORT: u16 = 10809;
pub const STATS_API_PORT: u16 = 10086;

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
        "routing": build_routing(),
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
                "destOverride": ["http", "tls"],
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

    json!([
        proxy,
        {
            "tag": "direct",
            "protocol": "freedom",
            "settings": { "domainStrategy": "UseIP" }
        },
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

fn build_routing() -> Value {
    json!({
        "domainStrategy": "AsIs",
        "rules": [
            {
                "inboundTag": ["api"],
                "outboundTag": "api",
                "type": "field"
            }
        ]
    })
}
