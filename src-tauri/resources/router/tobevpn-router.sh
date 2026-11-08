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
# Files: clients ("all" or one address per line), direct (addresses kept
# outside the tunnel), servers (ToBeVPN server hosts, always reached
# directly so a device running its own ToBeVPN is not tunnelled twice).

DIR=/opt/tobevpn
RUN=/tmp/tobevpn
TUN=tobe0
TABLE=100
PRIO=101
BYPASS_PRIO=99
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
    apply_server_bypass
    firewall_rule filter FORWARD 1 -i "$LAN_DEV" -o "$TUN" -j ACCEPT
    firewall_rule filter FORWARD 1 -i "$TUN" -o "$LAN_DEV" -j ACCEPT
    firewall_rule mangle FORWARD 1 -o "$TUN" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
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
    ip route flush table "$TABLE" 2>/dev/null
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
    [ -f "$RUN/state" ] && cat "$RUN/state"
    echo "bypass_rules=$(ip rule | grep -c "^$BYPASS_PRIO:")"
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
watch) watch ;;
uninstall) uninstall ;;
*) echo "usage: $0 start|stop|restart|status|uninstall" >&2; exit 2 ;;
esac
