#!/bin/sh
# ToBeVPN on an OpenWrt router: Xray + hev-socks5-tunnel; home devices are
# sent into the tunnel by source address. Installed and driven by the
# ToBeVPN desktop app over SSH.
#
# Everything this script changes at runtime (routes, rules, firewall rules
# marked "tobevpn", processes) is undone by "stop" or by a reboot. Only the
# files in /opt/tobevpn and the optional /etc/init.d/tobevpn stay.
#
#   tobevpn-router.sh start|stop|restart|status|uninstall
#
# Files: default_mode ("vpn" or "direct" for devices without a choice),
# devices (MAC<tab>vpn|direct<tab>name, one per line), servers (ToBeVPN
# server hosts, always reached directly so a device running its own
# ToBeVPN is not tunnelled twice).
#
#   tobevpn-router.sh devices | set-device MAC vpn|direct [NAME] |
#                     set-default vpn|direct | apply

DIR=/opt/tobevpn
RUN=/tmp/tobevpn
TUN=tobe0
TABLE=100
PRIO=101
DIRECT_PRIO=100
BYPASS_PRIO=99
DNS_CHAIN=TOBEVPN_DNS
TUNNEL_DNS=1.1.1.1
LAN_DEV=br-lan
TAG=tobevpn

lan_subnet() {
    ip -4 route show dev "$LAN_DEV" scope link 2>/dev/null | awk '{print $1; exit}'
}

# Keep the router registered as a device of the account and read its quota.
refresh_subscription() {
    [ -f "$DIR/subscription.conf" ] || return 0
    # shellcheck disable=SC1091
    . "$DIR/subscription.conf"
    [ -n "$SUB_URL" ] || return 0
    curl -s -m 20 -o /dev/null -D "$RUN/subscription.headers" \
        -A "ToBeVPN/$APP_VERSION/router/1" \
        -H "x-hwid: $HWID" -H "x-device-os: OpenWrt" \
        -H "x-ver-os: $OS_VERSION" -H "x-device-model: $MODEL" \
        "$SUB_URL" || true
}

firewall_rule() {
    table=$1
    shift
    iptables -t "$table" -C "$@" -m comment --comment "$TAG" 2>/dev/null ||
        iptables -t "$table" -I "$@" -m comment --comment "$TAG"
}

remove_firewall_rules() {
    for table in filter mangle; do
        iptables -t "$table" -S 2>/dev/null | grep -- "--comment $TAG" | sed 's/^-A /-D /' |
            while read -r rule; do
                # shellcheck disable=SC2086 # the rule is a list of iptables arguments
                iptables -t "$table" $rule 2>/dev/null
            done
    done
}

# Connections to ToBeVPN servers stay outside the tunnel: a device with its
# own VPN on then connects directly, and its traffic is counted once.
apply_server_bypass() {
    while ip rule del lookup main prio "$BYPASS_PRIO" 2>/dev/null; do :; done
    for host in $(grep -E '^[A-Za-z0-9.:-]+$' "$DIR/servers" 2>/dev/null); do
        if echo "$host" | grep -qE '^[0-9.]+$'; then
            addresses=$host
        else
            addresses=$(resolveip -4 -t 5 "$host" 2>/dev/null)
        fi
        for address in $addresses; do
            ip rule add to "$address" lookup main prio "$BYPASS_PRIO" 2>/dev/null
        done
    done
}

default_mode() {
    mode=$(cat "$DIR/default_mode" 2>/dev/null)
    [ "$mode" = direct ] && echo direct || echo vpn
}

lan_address() {
    ip -4 addr show "$LAN_DEV" 2>/dev/null | awk '/inet /{split($2, a, "/"); print a[1]; exit}'
}

# Current IPv4 address of a MAC: DHCP lease first, then the ARP table.
mac_address_ip() {
    awk -v mac="$1" 'tolower($2) == mac {print $3; exit}' /tmp/dhcp.leases 2>/dev/null |
        grep . || awk -v mac="$1" -v dev="$LAN_DEV" \
            'tolower($4) == mac && $6 == dev && $3 != "0x0" {print $1; exit}' /proc/net/arp
}

# Addresses of saved devices whose mode is $1.
device_ips() {
    awk -F '\t' -v mode="$1" '$2 == mode {print tolower($1)}' "$DIR/devices" 2>/dev/null |
        while read -r mac; do mac_address_ip "$mac"; done
}

dns_rule() {
    for proto in udp tcp; do
        iptables -t nat -A "$DNS_CHAIN" -s "$1" -d "$2" -p "$proto" --dport 53 \
            -j DNAT --to-destination "$TUNNEL_DNS:53"
    done
}

remove_dns_redirect() {
    while iptables -t nat -D PREROUTING -j "$DNS_CHAIN" -m comment --comment "$TAG" 2>/dev/null; do :; done
    iptables -t nat -F "$DNS_CHAIN" 2>/dev/null
    iptables -t nat -X "$DNS_CHAIN" 2>/dev/null
}

apply_routes() {
    subnet=$(lan_subnet)
    router_ip=$(lan_address)
    ip route replace default dev "$TUN" table "$TABLE"
    [ -n "$subnet" ] && ip route replace "$subnet" dev "$LAN_DEV" table "$TABLE"
    while ip rule del lookup "$TABLE" prio "$PRIO" 2>/dev/null; do :; done
    while ip rule del lookup main prio "$DIRECT_PRIO" 2>/dev/null; do :; done
    iptables -t nat -N "$DNS_CHAIN" 2>/dev/null || iptables -t nat -F "$DNS_CHAIN"
    if [ "$(default_mode)" = vpn ]; then
        # The whole home network, except devices set to "direct".
        for ip in $(device_ips direct); do
            ip rule add from "$ip" lookup main prio "$DIRECT_PRIO"
            iptables -t nat -A "$DNS_CHAIN" -s "$ip" -j RETURN
        done
        if [ -n "$subnet" ]; then
            ip rule add from "$subnet" lookup "$TABLE" prio "$PRIO"
            [ -n "$router_ip" ] && dns_rule "$subnet" "$router_ip"
        fi
    else
        for ip in $(device_ips vpn); do
            ip rule add from "$ip" lookup "$TABLE" prio "$PRIO"
            [ -n "$router_ip" ] && dns_rule "$ip" "$router_ip"
        done
    fi
    # DNS of devices that go through the VPN is resolved inside the tunnel.
    iptables -t nat -C PREROUTING -j "$DNS_CHAIN" -m comment --comment "$TAG" 2>/dev/null ||
        iptables -t nat -I PREROUTING 1 -j "$DNS_CHAIN" -m comment --comment "$TAG"
    apply_server_bypass
    firewall_rule filter FORWARD 1 -i "$LAN_DEV" -o "$TUN" -j ACCEPT
    firewall_rule filter FORWARD 1 -i "$TUN" -o "$LAN_DEV" -j ACCEPT
    firewall_rule mangle FORWARD 1 -o "$TUN" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
}

# One line per home device: device=MAC|IP|HOSTNAME|MODE|NAME|ONLINE.
# MODE is the saved choice or "default".
list_devices() {
    {
        awk '{print tolower($2) "\t" $3 "\t" $4}' /tmp/dhcp.leases 2>/dev/null
        awk -v dev="$LAN_DEV" 'NR > 1 && $6 == dev && $3 != "0x0" {print tolower($4) "\t" $1 "\t*"}' /proc/net/arp
        awk -F '\t' '{print tolower($1) "\t\t*"}' "$DIR/devices" 2>/dev/null
    } | awk -F '\t' -v saved="$DIR/devices" -v arp=/proc/net/arp -v dev="$LAN_DEV" '
        BEGIN {
            while ((getline line < saved) > 0) {
                split(line, f, "\t"); m = tolower(f[1]); mode[m] = f[2]; name[m] = f[3]
            }
            while ((getline line < arp) > 0) {
                n = split(line, f, " "); if (f[6] == dev && f[3] == "0x2") online[tolower(f[4])] = 1
            }
        }
        $1 ~ /^([0-9a-f][0-9a-f]:){5}[0-9a-f][0-9a-f]$/ {
            if (!($1 in ip) || $2 != "") ip[$1] = $2
            if (!($1 in host) || $3 != "*") host[$1] = $3
        }
        END {
            for (m in ip) {
                h = host[m]; if (h == "*") h = ""
                print "device=" m "|" ip[m] "|" h "|" (m in mode ? mode[m] : "default") "|" name[m] "|" (m in online ? 1 : 0)
            }
        }'
}

set_device() {
    mac=$(echo "$1" | tr 'A-F' 'a-f')
    echo "$mac" | grep -qE '^([0-9a-f]{2}:){5}[0-9a-f]{2}$' || { echo "error=bad mac"; return 2; }
    case "$2" in vpn | direct | default) ;; *) echo "error=bad mode"; return 2 ;; esac
    shift 2
    name=$(echo "$*" | tr -d '\t\r\n|' | cut -c1-40)
    touch "$DIR/devices"
    grep -v -i "^$mac	" "$DIR/devices" >"$DIR/devices.tmp" 2>/dev/null
    if [ "$mode_arg" != default ] || [ -n "$name" ]; then
        printf '%s\t%s\t%s\n' "$mac" "$mode_arg" "$name" >>"$DIR/devices.tmp"
    fi
    mv "$DIR/devices.tmp" "$DIR/devices"
    pidof xray >/dev/null && apply_routes
    echo "saved=1"
}


start_core() {
    if ! pidof xray >/dev/null; then
        GOMEMLIMIT=40MiB GOGC=50 "$DIR/xray" run -c "$DIR/xray.json" >"$RUN/xray.log" 2>&1 &
    fi
    if ! pidof hev-socks5-tunnel >/dev/null; then
        "$DIR/hev-socks5-tunnel" "$DIR/hev.yml" >"$RUN/hev.log" 2>&1 &
    fi
}

core_alive() {
    pidof xray >/dev/null && pidof hev-socks5-tunnel >/dev/null
}

# Background watchdog: restarts a crashed core once; if that fails, removes
# the routing so the home stays online without the VPN instead of offline.
# Also refreshes the server addresses every 6 hours.
watch() {
    echo $$ >"$RUN/watch.pid"
    ticks=0
    while sleep 30; do
        ticks=$((ticks + 1))
        if ! core_alive; then
            start_core
            sleep 5
            if ! core_alive; then
                echo "failed=$(date +%s)" >"$RUN/state"
                stop_routing
                rm -f "$RUN/watch.pid"
                exit 1
            fi
        fi
        [ $((ticks % 720)) -eq 0 ] && apply_server_bypass
        # Devices that reconnected with another address; DHCP events also
        # trigger this through /etc/hotplug.d/dhcp/90-tobevpn.
        [ $((ticks % 10)) -eq 0 ] && apply_routes
    done
}

start() {
    mkdir -p "$RUN"
    rm -f "$RUN/state"
    [ -c /dev/net/tun ] || modprobe tun 2>/dev/null || insmod tun 2>/dev/null
    refresh_subscription
    start_core
    i=0
    while [ $i -lt 15 ] && ! ip link show "$TUN" >/dev/null 2>&1; do
        sleep 1
        i=$((i + 1))
    done
    ip link show "$TUN" >/dev/null 2>&1 || { echo "error=tunnel did not come up"; return 1; }
    ip link set "$TUN" up
    echo 0 >"/proc/sys/net/ipv4/conf/$TUN/rp_filter"
    apply_routes
    if ! { [ -f "$RUN/watch.pid" ] && kill -0 "$(cat "$RUN/watch.pid")" 2>/dev/null; }; then
        "$0" watch >/dev/null 2>&1 &
    fi
    echo "started=1"
}

stop_routing() {
    while ip rule del lookup "$TABLE" prio "$PRIO" 2>/dev/null; do :; done
    while ip rule del lookup main prio "$PRIO" 2>/dev/null; do :; done
    while ip rule del lookup main prio "$BYPASS_PRIO" 2>/dev/null; do :; done
    while ip rule del lookup main prio "$DIRECT_PRIO" 2>/dev/null; do :; done
    ip route flush table "$TABLE" 2>/dev/null
    remove_dns_redirect
    remove_firewall_rules
}

stop() {
    if [ -f "$RUN/watch.pid" ]; then
        kill "$(cat "$RUN/watch.pid")" 2>/dev/null
        rm -f "$RUN/watch.pid"
    fi
    stop_routing
    # busybox killall matches the 15-character kernel name; pidof does not.
    for name in hev-socks5-tunnel xray; do
        pids=$(pidof "$name")
        # shellcheck disable=SC2086 # several pids
        [ -n "$pids" ] && kill $pids
    done
    # Wait for both to exit, so an immediate start does not see them alive.
    i=0
    while [ $i -lt 3 ] && pidof xray hev-socks5-tunnel >/dev/null; do
        sleep 1
        i=$((i + 1))
    done
    for name in hev-socks5-tunnel xray; do
        pids=$(pidof "$name")
        # shellcheck disable=SC2086 # several pids
        [ -n "$pids" ] && kill -9 $pids
    done
    echo "stopped=1"
}

status() {
    xray_pid=$(pidof xray)
    hev_pid=$(pidof hev-socks5-tunnel)
    echo "installed=$([ -x "$DIR/xray" ] && echo 1 || echo 0)"
    echo "running=$([ -n "$xray_pid" ] && [ -n "$hev_pid" ] && echo 1 || echo 0)"
    [ -f "$RUN/state" ] && cat "$RUN/state"
    echo "bypass_rules=$(ip rule | grep -c "^$BYPASS_PRIO:")"
    echo "autostart=$([ -x /etc/rc.d/S99tobevpn ] && echo 1 || echo 0)"
    [ -n "$xray_pid" ] && echo "xray_rss_kb=$(awk '/VmRSS/{print $2}' "/proc/$xray_pid/status")"
    echo "mem_available_kb=$(awk '/MemAvailable/{print $2}' /proc/meminfo)"
    echo "tun_rx_bytes=$(cat "/sys/class/net/$TUN/statistics/rx_bytes" 2>/dev/null || echo 0)"
    echo "tun_tx_bytes=$(cat "/sys/class/net/$TUN/statistics/tx_bytes" 2>/dev/null || echo 0)"
    echo "default_mode=$(default_mode)"
    echo "client_ip=${SSH_CLIENT%% *}"
    grep -i '^subscription-userinfo:' "$RUN/subscription.headers" 2>/dev/null |
        sed 's/^[^:]*: */subscription_userinfo=/' | tr -d '\r'
}

uninstall() {
    stop >/dev/null
    [ -x /etc/init.d/tobevpn ] && /etc/init.d/tobevpn disable 2>/dev/null
    rm -f /etc/init.d/tobevpn /etc/hotplug.d/dhcp/90-tobevpn
    rm -rf "$RUN"
    sed -i '/tobevpn-desktop-router/d' /etc/dropbear/authorized_keys 2>/dev/null
    rm -rf "$DIR"
    echo "uninstalled=1"
}

case "$1" in
start) start ;;
stop) stop ;;
restart) stop >/dev/null; start ;;
status) status ;;
watch) watch ;;
devices) list_devices ;;
set-device) mode_arg=$3; set_device "$2" "$3" "$(shift 3; echo "$*")" ;;
set-default)
    case "$2" in vpn | direct) echo "$2" >"$DIR/default_mode" ;; *) echo "error=bad mode"; exit 2 ;; esac
    pidof xray >/dev/null && apply_routes
    echo "saved=1"
    ;;
apply) pidof xray >/dev/null && apply_routes; echo "applied=1" ;;
uninstall) uninstall ;;
*) echo "usage: $0 start|stop|restart|status|uninstall" >&2; exit 2 ;;
esac
