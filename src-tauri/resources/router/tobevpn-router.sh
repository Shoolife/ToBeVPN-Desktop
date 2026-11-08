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

DIR=/opt/tobevpn
RUN=/tmp/tobevpn
TUN=tobe0
TABLE=100
PRIO=101
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

apply_routes() {
    subnet=$(lan_subnet)
    ip route replace default dev "$TUN" table "$TABLE"
    [ -n "$subnet" ] && ip route replace "$subnet" dev "$LAN_DEV" table "$TABLE"
    while ip rule del lookup "$TABLE" prio "$PRIO" 2>/dev/null; do :; done
    # clients: "all" (every home device) or one IPv4 address per line.
    # direct: addresses that stay outside the tunnel when "all" is used.
    if grep -qx all "$DIR/clients" 2>/dev/null; then
        for ip in $(cat "$DIR/direct" 2>/dev/null); do
            ip rule add from "$ip" lookup main prio "$PRIO"
        done
        [ -n "$subnet" ] && ip rule add from "$subnet" lookup "$TABLE" prio "$PRIO"
    else
        for ip in $(grep -E '^[0-9.]+$' "$DIR/clients" 2>/dev/null); do
            ip rule add from "$ip" lookup "$TABLE" prio "$PRIO"
        done
    fi
    firewall_rule filter FORWARD 1 -i "$LAN_DEV" -o "$TUN" -j ACCEPT
    firewall_rule filter FORWARD 1 -i "$TUN" -o "$LAN_DEV" -j ACCEPT
    firewall_rule mangle FORWARD 1 -o "$TUN" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
}

start() {
    mkdir -p "$RUN"
    [ -c /dev/net/tun ] || modprobe tun 2>/dev/null || insmod tun 2>/dev/null
    refresh_subscription
    if ! pidof xray >/dev/null; then
        GOMEMLIMIT=40MiB GOGC=50 "$DIR/xray" run -c "$DIR/xray.json" >"$RUN/xray.log" 2>&1 &
    fi
    if ! pidof hev-socks5-tunnel >/dev/null; then
        "$DIR/hev-socks5-tunnel" "$DIR/hev.yml" >"$RUN/hev.log" 2>&1 &
    fi
    i=0
    while [ $i -lt 15 ] && ! ip link show "$TUN" >/dev/null 2>&1; do
        sleep 1
        i=$((i + 1))
    done
    ip link show "$TUN" >/dev/null 2>&1 || { echo "error=tunnel did not come up"; return 1; }
    ip link set "$TUN" up
    echo 0 >"/proc/sys/net/ipv4/conf/$TUN/rp_filter"
    apply_routes
    echo "started=1"
}

stop() {
    while ip rule del lookup "$TABLE" prio "$PRIO" 2>/dev/null; do :; done
    while ip rule del lookup main prio "$PRIO" 2>/dev/null; do :; done
    ip route flush table "$TABLE" 2>/dev/null
    remove_firewall_rules
    # busybox killall matches the 15-character kernel name; pidof does not.
    for name in hev-socks5-tunnel xray; do
        pids=$(pidof "$name")
        # shellcheck disable=SC2086 # several pids
        [ -n "$pids" ] && kill $pids
    done
    # Wait for both to exit, so an immediate start does not see them alive.
    i=0
    while [ $i -lt 6 ] && pidof xray hev-socks5-tunnel >/dev/null; do
        sleep 0.5
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
    echo "autostart=$([ -x /etc/rc.d/S99tobevpn ] && echo 1 || echo 0)"
    [ -n "$xray_pid" ] && echo "xray_rss_kb=$(awk '/VmRSS/{print $2}' "/proc/$xray_pid/status")"
    echo "mem_available_kb=$(awk '/MemAvailable/{print $2}' /proc/meminfo)"
    echo "tun_rx_bytes=$(cat "/sys/class/net/$TUN/statistics/rx_bytes" 2>/dev/null || echo 0)"
    echo "tun_tx_bytes=$(cat "/sys/class/net/$TUN/statistics/tx_bytes" 2>/dev/null || echo 0)"
    echo "clients=$(tr '\n' ' ' <"$DIR/clients" 2>/dev/null)"
    echo "direct=$(tr '\n' ' ' <"$DIR/direct" 2>/dev/null)"
    grep -i '^subscription-userinfo:' "$RUN/subscription.headers" 2>/dev/null |
        sed 's/^[^:]*: */subscription_userinfo=/' | tr -d '\r'
}

uninstall() {
    stop >/dev/null
    [ -x /etc/init.d/tobevpn ] && /etc/init.d/tobevpn disable 2>/dev/null
    rm -f /etc/init.d/tobevpn
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
uninstall) uninstall ;;
*) echo "usage: $0 start|stop|restart|status|uninstall" >&2; exit 2 ;;
esac
