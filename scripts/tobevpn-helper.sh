#!/bin/bash
# Privileged TUN/routing helper for ToBeVPN.
# Installed at /usr/local/bin and invoked via pkexec; the matching polkit
# policy (app.tobevpn.network.policy) allows active local sessions to call
# this constrained helper without repeated password prompts.
#
# SECURITY: this script runs as root. Do NOT accept arbitrary executable paths
# from the caller — pkexec passes argv straight through, so a malicious caller
# could otherwise run any binary as root. Only the whitelisted tun2socks paths
# below are allowed.

set -e

TUN_NAME="tobe0"
TUN_ADDR="198.18.0.1/15"
TUN_ADDR6="fd66:6f62:6576:706e::1/64"
TUN_PUBLIC_V6_PREFIX="2000::/3"
TUN_TABLE="100"
FWMARK="0x1"
SOCKS_PORT="10809"
PID_FILE="/tmp/tobevpn_tun2socks.pid"

# Allowed tun2socks binary locations. The Tauri sidecar lives in the resource
# tree under the app's install dir; on a stock .deb that's somewhere in
# /usr/lib/<pkg>/, but the exact subpath depends on the Tauri build. We
# accept a small set of plausible roots and additionally enforce that the
# file is owned by root and not world-writable (so a non-root user can't
# drop a malicious binary into one of these paths and call us).
ALLOWED_TUN2SOCKS_PREFIXES=(
    "/usr/bin/"
    "/usr/lib/"
    "/usr/local/lib/"
    "/opt/"
)

validate_tun2socks_path() {
    local path="$1"
    # Must be absolute, no symlinks, executable
    if [ -z "$path" ] || [ "${path:0:1}" != "/" ]; then
        echo "ERROR: tun2socks path must be absolute" >&2
        return 1
    fi
    if [ -L "$path" ]; then
        echo "ERROR: tun2socks path must not be a symlink: $path" >&2
        return 1
    fi
    if [ ! -x "$path" ]; then
        echo "ERROR: tun2socks not executable: $path" >&2
        return 1
    fi
    # Reject path traversal — `..` segments + symlinks could otherwise let an
    # attacker resolve a whitelisted prefix to an arbitrary location.
    case "$path" in
        *..*) echo "ERROR: '..' segments not allowed: $path" >&2; return 1 ;;
    esac

    local prefix_ok=0
    for p in "${ALLOWED_TUN2SOCKS_PREFIXES[@]}"; do
        if [ "${path#$p}" != "$path" ]; then
            prefix_ok=1
            break
        fi
    done
    if [ $prefix_ok -ne 1 ]; then
        echo "ERROR: tun2socks path not in allowed prefix: $path" >&2
        echo "       allowed: ${ALLOWED_TUN2SOCKS_PREFIXES[*]}" >&2
        return 1
    fi

    # File must be root-owned (uid 0). stat output differs across BSD/GNU,
    # use Python-free portable check: GNU stat is universal on Linux distros.
    local owner
    owner=$(stat -c '%u' "$path" 2>/dev/null || echo "?")
    if [ "$owner" != "0" ]; then
        echo "ERROR: tun2socks must be owned by root, got uid=$owner: $path" >&2
        return 1
    fi
    # Not world-writable.
    local mode
    mode=$(stat -c '%a' "$path" 2>/dev/null || echo "?")
    if [ -z "$mode" ] || [ "$mode" = "?" ]; then
        echo "ERROR: cannot stat $path" >&2
        return 1
    fi
    # Last digit (others) must not have write bit (2).
    local others="${mode: -1}"
    if [ $((others & 2)) -ne 0 ]; then
        echo "ERROR: tun2socks is world-writable (mode $mode): $path" >&2
        return 1
    fi
    return 0
}

cleanup_routing() {
    if [ -f "$PID_FILE" ]; then
        OLD=$(cat "$PID_FILE")
        kill "$OLD" 2>/dev/null || true
        rm -f "$PID_FILE"
    fi
    pkill -9 -f "tun2socks.*-device[[:space:]]+${TUN_NAME}" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
        ip rule del table "$TUN_TABLE" 2>/dev/null || break
    done
    ip rule del not fwmark "$FWMARK" table "$TUN_TABLE" prio 100 2>/dev/null || true
    for _ in 1 2 3 4 5; do
        ip -6 rule del table "$TUN_TABLE" 2>/dev/null || break
    done
    ip -6 rule del not fwmark "$FWMARK" table "$TUN_TABLE" prio 100 2>/dev/null || true
    ip route flush table "$TUN_TABLE" 2>/dev/null || true
    ip -6 route flush table "$TUN_TABLE" 2>/dev/null || true
    ip link del "$TUN_NAME" 2>/dev/null || true
}

case "$1" in
  start)
    TUN2SOCKS_BIN="$2"
    SERVER_IP="$3"
    EXTRA_BYPASS_IPS=("${@:4}")

    if [ -z "$TUN2SOCKS_BIN" ] || [ -z "$SERVER_IP" ]; then
        echo "ERROR: usage: $0 start <tun2socks-bin> <server-ip> [bypass-ip ...]" >&2
        exit 1
    fi
    if ! validate_tun2socks_path "$TUN2SOCKS_BIN"; then
        exit 1
    fi
    for BYPASS_IP in "$SERVER_IP" "${EXTRA_BYPASS_IPS[@]}"; do
        if ! echo "$BYPASS_IP" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
            echo "ERROR: invalid bypass IP" >&2
            exit 1
        fi
    done

    cleanup_routing

    # Parse `ip route show default` by token names (not field positions) so
    # we handle both `default via X dev Y ...` and on-link `default dev Y ...`
    # routes (PPP, cellular, WireGuard upstream — there's no gateway IP).
    DEFAULT_LINE=$(ip route show default | head -1)
    DEFAULT_GW=$(echo "$DEFAULT_LINE" | awk '{for(i=1;i<=NF;i++) if($i=="via") print $(i+1)}')
    DEFAULT_DEV=$(echo "$DEFAULT_LINE" | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}')
    if [ -z "$DEFAULT_DEV" ]; then
        echo "ERROR: no default route found" >&2
        exit 1
    fi
    echo "${DEFAULT_GW:-on-link} $DEFAULT_DEV" > /tmp/tobevpn_orig_route
    echo "$SERVER_IP" > /tmp/tobevpn_server_ip

    setsid "$TUN2SOCKS_BIN" -device "$TUN_NAME" \
        -proxy "socks5://127.0.0.1:${SOCKS_PORT}" \
        -fwmark "$FWMARK" &>/dev/null &
    T2S_PID=$!
    echo "$T2S_PID" > "$PID_FILE"
    disown $T2S_PID 2>/dev/null || true

    for _ in $(seq 1 30); do
        ip link show "$TUN_NAME" >/dev/null 2>&1 && break
        sleep 0.1
    done
    if ! ip link show "$TUN_NAME" >/dev/null 2>&1; then
        echo "ERROR: TUN ${TUN_NAME} did not appear" >&2
        if kill -0 $T2S_PID 2>/dev/null; then
            echo "  tun2socks PID $T2S_PID still running" >&2
        else
            echo "  tun2socks PID $T2S_PID has exited" >&2
        fi
        exit 1
    fi

    ip addr add "$TUN_ADDR" dev "$TUN_NAME" 2>/dev/null || true
    ip -6 addr add "$TUN_ADDR6" dev "$TUN_NAME" 2>/dev/null || true
    ip link set "$TUN_NAME" up

    for BYPASS_IP in "$SERVER_IP" "${EXTRA_BYPASS_IPS[@]}"; do
        if [ -n "$DEFAULT_GW" ]; then
            ip route add "${BYPASS_IP}/32" via "$DEFAULT_GW" dev "$DEFAULT_DEV" table "$TUN_TABLE"
        else
            # On-link upstream — no via, packet goes directly out the interface.
            ip route add "${BYPASS_IP}/32" dev "$DEFAULT_DEV" scope link table "$TUN_TABLE"
        fi
    done
    ip route add default dev "$TUN_NAME" table "$TUN_TABLE"
    ip -6 route add "$TUN_PUBLIC_V6_PREFIX" dev "$TUN_NAME" table "$TUN_TABLE"
    ip rule add not fwmark "$FWMARK" table "$TUN_TABLE" prio 100
    ip -6 rule add not fwmark "$FWMARK" table "$TUN_TABLE" prio 100

    # DNS hardening: prevent the OS from resolving through the original NIC,
    # which would leak DNS queries past the VPN even if their answers come
    # back through the tunnel.
    #
    # Two-tier strategy:
    #   1) systemd-resolved (most modern distros) — pin DNS to the TUN with a
    #      catch-all routing domain "~.". This is reverted on stop.
    #   2) Fallback — back up /etc/resolv.conf and overwrite with our own
    #      pointing at 1.1.1.1/8.8.8.8. Restored on stop. We explicitly do
    #      NOT silently fall through if neither path works — that would
    #      leave a DNS leak.
    DNS_MODE="none"
    if command -v resolvectl >/dev/null 2>&1; then
        if resolvectl dns "$TUN_NAME" 1.1.1.1 8.8.8.8 2>/dev/null \
           && resolvectl domain "$TUN_NAME" '~.' 2>/dev/null; then
            DNS_MODE="resolvectl"
        fi
    fi
    if [ "$DNS_MODE" = "none" ]; then
        # Detect resolv.conf — usually a symlink (stub-resolv.conf) or a
        # plain file. If it's a symlink we can't safely move it: dropping a
        # plain file in its place is fine. Save the original (file or
        # symlink target) so we can restore on stop.
        if [ -e /etc/resolv.conf ]; then
            if [ -L /etc/resolv.conf ]; then
                readlink /etc/resolv.conf > /tmp/tobevpn_resolv_link
            else
                cp -p /etc/resolv.conf /tmp/tobevpn_resolv.bak 2>/dev/null || true
            fi
        fi
        if printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /etc/resolv.conf 2>/dev/null; then
            chmod 644 /etc/resolv.conf 2>/dev/null || true
            DNS_MODE="resolvconf"
        fi
    fi
    echo "$DNS_MODE" > /tmp/tobevpn_dns_mode

    echo "OK $T2S_PID"
    ;;

  stop)
    cleanup_routing

    # Restore DNS in the same mode we set it. Untouched if start() never
    # got past DNS-mode "none".
    if [ -f /tmp/tobevpn_dns_mode ]; then
        DNS_MODE=$(cat /tmp/tobevpn_dns_mode)
        case "$DNS_MODE" in
            resolvectl)
                command -v resolvectl >/dev/null 2>&1 \
                    && resolvectl revert "$TUN_NAME" 2>/dev/null || true
                ;;
            resolvconf)
                if [ -f /tmp/tobevpn_resolv_link ]; then
                    target=$(cat /tmp/tobevpn_resolv_link)
                    rm -f /etc/resolv.conf
                    ln -s "$target" /etc/resolv.conf 2>/dev/null || true
                elif [ -f /tmp/tobevpn_resolv.bak ]; then
                    cp -p /tmp/tobevpn_resolv.bak /etc/resolv.conf 2>/dev/null || true
                fi
                ;;
        esac
    fi
    rm -f /tmp/tobevpn_orig_route /tmp/tobevpn_server_ip \
          /tmp/tobevpn_dns_mode /tmp/tobevpn_resolv.bak /tmp/tobevpn_resolv_link
    echo "STOPPED"
    ;;

  *)
    echo "ERROR: usage: $0 {start <tun2socks-bin> <server-ip> [bypass-ip ...]|stop}" >&2
    exit 1
    ;;
esac
