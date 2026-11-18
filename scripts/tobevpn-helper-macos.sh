#!/bin/bash
# ToBeVPN network helper for macOS. Installed once (administrator password)
# as /Library/PrivilegedHelperTools/app.tobevpn.helper, owned by root, with a
# sudoers rule letting the installing user run exactly this file without a
# password. It brings the tunnel up and down: tun2socks on a utun device,
# routes, and DNS of every network service.
#
# It never runs a binary it was given: tun2socks is its own root-owned copy
# next to it (the app bundle in /Applications belongs to the user, so a path
# from there could be swapped for anything). Every address argument must be a
# plain IPv4 address.
set -u
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

TUN2SOCKS="/Library/PrivilegedHelperTools/app.tobevpn.tun2socks"
TUN_NAME="utun199"
TUN_ADDR="198.18.0.1"
TUN_ADDR6="fd66:6f62:6576:706e::1"
SOCKS_PORT="10809"
STATE_DIR="/var/run/tobevpn"
PID_FILE="$STATE_DIR/tun2socks.pid"
ROUTE_FILE="$STATE_DIR/route"
BYPASS_FILE="$STATE_DIR/bypass"
DNS_FILE="$STATE_DIR/dns"
LOG_FILE="$STATE_DIR/tun2socks.log"

valid_ipv4() {
    echo "$1" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$'
}

# The enabled network services, one per line (names may hold spaces).
network_services() {
    networksetup -listallnetworkservices 2>/dev/null | tail -n +2 | grep -v '^\*'
}

flush_dns_cache() {
    dscacheutil -flushcache 2>/dev/null || true
    killall -HUP mDNSResponder 2>/dev/null || true
}

restore_dns() {
    [ -f "$DNS_FILE" ] || return 0
    while IFS=$'\t' read -r SERVICE SERVERS; do
        [ -n "$SERVICE" ] || continue
        # shellcheck disable=SC2086 # the saved servers are separate arguments
        networksetup -setdnsservers "$SERVICE" $SERVERS 2>/dev/null || true
    done < "$DNS_FILE"
    rm -f "$DNS_FILE"
    flush_dns_cache
}

# Remembers each service's own DNS servers ("Empty": from DHCP) and points
# them at public resolvers, which then answer through the tunnel.
set_tunnel_dns() {
    : > "$DNS_FILE"
    chmod 600 "$DNS_FILE"
    network_services | while IFS= read -r SERVICE; do
        CURRENT=$(networksetup -getdnsservers "$SERVICE" 2>/dev/null)
        case "$CURRENT" in
            *"aren't any"*|"") CURRENT="Empty" ;;
            *) CURRENT=$(echo "$CURRENT" | tr '\n' ' ') ;;
        esac
        printf '%s\t%s\n' "$SERVICE" "$CURRENT" >> "$DNS_FILE"
        networksetup -setdnsservers "$SERVICE" 1.1.1.1 8.8.8.8 2>/dev/null || true
    done
    flush_dns_cache
}

add_host_route() {
    local IP="$1" GW="$2" IFACE="$3"
    if [ -n "$GW" ]; then
        route -n add -host "$IP" "$GW" >/dev/null 2>&1 || true
    else
        route -n add -host "$IP" -interface "$IFACE" >/dev/null 2>&1 || true
    fi
    echo "$IP" >> "$BYPASS_FILE"
}

cleanup() {
    if [ -f "$PID_FILE" ]; then
        kill "$(cat "$PID_FILE")" 2>/dev/null || true
        rm -f "$PID_FILE"
    fi
    pkill -f "^$TUN2SOCKS" 2>/dev/null || true
    route -n delete -net 0.0.0.0/1 "$TUN_ADDR" >/dev/null 2>&1 || true
    route -n delete -net 128.0.0.0/1 "$TUN_ADDR" >/dev/null 2>&1 || true
    route -n delete -inet6 -net 2000::/3 -interface "$TUN_NAME" >/dev/null 2>&1 || true
    if [ -f "$BYPASS_FILE" ]; then
        sort -u "$BYPASS_FILE" | while read -r IP; do
            valid_ipv4 "$IP" && route -n delete -host "$IP" >/dev/null 2>&1 || true
        done
        rm -f "$BYPASS_FILE"
    fi
    restore_dns
    rm -f "$ROUTE_FILE"
}

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

case "${1:-}" in
  start)
    SERVER_IP="${2:-}"
    shift 2 2>/dev/null || true
    if ! valid_ipv4 "$SERVER_IP"; then
        echo "ERROR: usage: $0 start <server-ip> [bypass-ip ...]" >&2
        exit 1
    fi
    for IP in "$@"; do
        valid_ipv4 "$IP" || { echo "ERROR: invalid bypass IP" >&2; exit 1; }
    done
    if [ ! -x "$TUN2SOCKS" ] || [ "$(stat -f %u "$TUN2SOCKS")" != "0" ]; then
        echo "ERROR: tun2socks is not installed" >&2
        exit 1
    fi

    cleanup

    DEFAULT=$(route -n get default 2>/dev/null)
    GW=$(echo "$DEFAULT" | awk '/gateway:/ {print $2}')
    IFACE=$(echo "$DEFAULT" | awk '/interface:/ {print $2}')
    if [ -z "$IFACE" ] || [ "$IFACE" = "$TUN_NAME" ]; then
        echo "ERROR: no default route found" >&2
        exit 1
    fi
    echo "${GW:-} $IFACE" > "$ROUTE_FILE"

    : > "$LOG_FILE"
    chmod 600 "$LOG_FILE"
    nohup "$TUN2SOCKS" --device "$TUN_NAME" \
        --proxy "socks5://127.0.0.1:${SOCKS_PORT}" \
        --loglevel error >"$LOG_FILE" 2>&1 &
    T2S_PID=$!
    echo "$T2S_PID" > "$PID_FILE"

    for _ in $(seq 1 30); do
        ifconfig "$TUN_NAME" >/dev/null 2>&1 && break
        sleep 0.1
    done
    if ! ifconfig "$TUN_NAME" >/dev/null 2>&1; then
        echo "ERROR: TUN ${TUN_NAME} did not appear" >&2
        [ -s "$LOG_FILE" ] && tail -20 "$LOG_FILE" | sed 's/^/    /' >&2
        cleanup
        exit 1
    fi

    ifconfig "$TUN_NAME" "$TUN_ADDR" "$TUN_ADDR" up
    ifconfig "$TUN_NAME" inet6 "$TUN_ADDR6" prefixlen 64 >/dev/null 2>&1 || true

    # The server and the app's direct destinations keep the physical route.
    for IP in "$SERVER_IP" "$@"; do
        add_host_route "$IP" "$GW" "$IFACE"
    done
    # Everything else through the tunnel. Two halves are more specific than
    # the default route, which stays in place; local networks keep their own
    # (more specific) routes and so stay direct.
    route -n add -net 0.0.0.0/1 "$TUN_ADDR" >/dev/null
    route -n add -net 128.0.0.0/1 "$TUN_ADDR" >/dev/null
    route -n add -inet6 -net 2000::/3 -interface "$TUN_NAME" >/dev/null 2>&1 || true

    set_tunnel_dns
    echo "OK $T2S_PID"
    ;;
  bypass)
    shift
    [ -f "$ROUTE_FILE" ] || { echo "OK"; exit 0; }
    read -r GW IFACE < "$ROUTE_FILE"
    if [ -z "${IFACE:-}" ]; then
        IFACE="$GW"
        GW=""
    fi
    for IP in "$@"; do
        valid_ipv4 "$IP" || { echo "ERROR: invalid bypass IP" >&2; exit 1; }
        add_host_route "$IP" "$GW" "$IFACE"
    done
    echo "OK"
    ;;
  stop)
    cleanup
    echo "STOPPED"
    ;;
  *)
    echo "ERROR: usage: $0 start|bypass|stop" >&2
    exit 1
    ;;
esac
