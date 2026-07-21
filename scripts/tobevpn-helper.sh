#!/bin/bash
# Privileged TUN/routing helper for ToBeVPN.
#
# SECURITY BOUNDARY:
#   * this file is invoked through pkexec and always runs as root;
#   * callers are untrusted, so every argv value is validated;
#   * all mutable state is kept in a root-only directory under /run;
#   * cleanup removes only routes/rules carrying ToBeVPN's exact marker.

set -Eeuo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

TUN_NAME="tobe0"
TUN_ADDR="198.18.0.1/15"
TUN_ADDR6="fd66:6f62:6576:706e::1/64"
TUN_PUBLIC_V6_PREFIX="2000::/3"
TUN_TABLE="18676"
RULE_PRIORITY="18676"
TRANSITION_TABLE="18675"
TRANSITION_RULE_PRIORITY="18675"
ROUTE_PROTO="186"
FWMARK="0x1"
SOCKS_PORT="10809"

STATE_DIR="/run/tobevpn"
LOCK_FILE="$STATE_DIR/helper.lock"
UPDATE_LOCK_FILE="/run/tobevpn-update.lock"
OWNER_FILE="$STATE_DIR/owner"
PID_FILE="$STATE_DIR/tun2socks.pid"
LOG_FILE="$STATE_DIR/tun2socks.log"
ORIG_ROUTE_FILE="$STATE_DIR/original-route"
BYPASS_FILE="$STATE_DIR/bypass-ipv4"
TRANSITION_BYPASS_FILE="$STATE_DIR/transition-bypass-ipv4"
DNS_MODE_FILE="$STATE_DIR/dns-mode"
RESOLV_LINK_FILE="$STATE_DIR/resolv-link"
RESOLV_BACKUP_FILE="$STATE_DIR/resolv.conf.backup"
RESOLV_MISSING_FILE="$STATE_DIR/resolv-was-missing"
RESOLV_NEW_FILE="$STATE_DIR/resolv.conf.new"
OWNER_MARKER="tobevpn-network-v2"

die() {
    echo "ERROR: $*" >&2
    exit 1
}

init_state_dir() {
    if [ -L "$STATE_DIR" ]; then
        die "$STATE_DIR must not be a symlink"
    fi
    install -d -m 0700 -o root -g root "$STATE_DIR"
    local owner mode
    owner=$(stat -c '%u' "$STATE_DIR" 2>/dev/null || echo '?')
    mode=$(stat -c '%a' "$STATE_DIR" 2>/dev/null || echo '?')
    [ "$owner" = "0" ] || die "$STATE_DIR is not root-owned"
    [ "$mode" = "700" ] || die "$STATE_DIR has unsafe mode $mode"
    umask 077
}

is_ipv4() {
    local value="$1" a b c d octet
    [[ "$value" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
    IFS=. read -r a b c d <<<"$value"
    for octet in "$a" "$b" "$c" "$d"; do
        (( 10#$octet <= 255 )) || return 1
    done
}

is_public_ipv4() {
    local value="$1" a b c d
    is_ipv4 "$value" || return 1
    IFS=. read -r a b c d <<<"$value"
    a=$((10#$a)); b=$((10#$b)); c=$((10#$c)); d=$((10#$d))
    (( a != 0 && a != 10 && a != 127 && a < 224 )) || return 1
    (( !(a == 100 && b >= 64 && b <= 127) )) || return 1
    (( !(a == 169 && b == 254) )) || return 1
    (( !(a == 172 && b >= 16 && b <= 31) )) || return 1
    (( !(a == 192 && (b == 0 || b == 168)) )) || return 1
    (( !(a == 198 && (b == 18 || b == 19)) )) || return 1
    (( !(a == 198 && b == 51 && c == 100) )) || return 1
    (( !(a == 203 && b == 0 && c == 113) )) || return 1
    return 0
}

ipv6_stack_available() {
    # Install the IPv6 blackhole even when IPv6 is currently disabled through
    # sysctl. NetworkManager may enable it on a new adapter mid-session; if the
    # kernel supports IPv6 rules now, the guard must already be waiting.
    ip -6 rule list >/dev/null 2>&1
}

add_bypass_route() {
    local destination="$1" route_line gateway="" device="" index
    local -a route_fields=()

    route_line=$(ip -4 route get "$destination" mark "$FWMARK" 2>/dev/null | head -1) \
        || return 1
    read -r -a route_fields <<<"$route_line"
    for (( index = 0; index < ${#route_fields[@]}; index++ )); do
        case "${route_fields[$index]}" in
            via) gateway=${route_fields[$((index + 1))]:-} ;;
            dev) device=${route_fields[$((index + 1))]:-} ;;
        esac
    done
    [ -n "$device" ] && [ "$device" != "$TUN_NAME" ] || return 1
    if [ -n "$gateway" ]; then
        is_ipv4 "$gateway" || return 1
        ip route add "${destination}/32" via "$gateway" dev "$device" \
            table "$TUN_TABLE" proto "$ROUTE_PROTO"
    else
        ip route add "${destination}/32" dev "$device" scope link \
            table "$TUN_TABLE" proto "$ROUTE_PROTO"
    fi
}

# Install a physical /32 in the dedicated live-switch table. Route discovery
# uses mark 0x1 so it bypasses the active VPN policy rule and always describes
# the real uplink, even while the old tunnel is still connected.
add_transition_bypass_route() {
    local destination="$1" route_line gateway="" device="" index
    local -a route_fields=()

    route_line=$(ip -4 route get "$destination" mark "$FWMARK" 2>/dev/null | head -1) \
        || return 1
    read -r -a route_fields <<<"$route_line"
    for (( index = 0; index < ${#route_fields[@]}; index++ )); do
        case "${route_fields[$index]}" in
            via) gateway=${route_fields[$((index + 1))]:-} ;;
            dev) device=${route_fields[$((index + 1))]:-} ;;
        esac
    done
    [ -n "$device" ] && [ "$device" != "$TUN_NAME" ] || return 1
    if [ -n "$gateway" ]; then
        is_ipv4 "$gateway" || return 1
        ip route add "${destination}/32" via "$gateway" dev "$device" \
            table "$TRANSITION_TABLE" proto "$ROUTE_PROTO"
    else
        ip route add "${destination}/32" dev "$device" scope link \
            table "$TRANSITION_TABLE" proto "$ROUTE_PROTO"
    fi
}

cleanup_transition_guard() {
    while ip rule del priority "$TRANSITION_RULE_PRIORITY" not fwmark "$FWMARK" \
        table "$TRANSITION_TABLE" 2>/dev/null; do :; done
    while ip -6 rule del priority "$TRANSITION_RULE_PRIORITY" not fwmark "$FWMARK" \
        table "$TRANSITION_TABLE" 2>/dev/null; do :; done
    ip route flush table "$TRANSITION_TABLE" proto "$ROUTE_PROTO" 2>/dev/null || true
    ip -6 route flush table "$TRANSITION_TABLE" proto "$ROUTE_PROTO" 2>/dev/null || true
    rm -f "$TRANSITION_BYPASS_FILE"

    if ip rule list 2>/dev/null \
        | grep -Eq "^${TRANSITION_RULE_PRIORITY}:.*fwmark 0x1.*lookup ${TRANSITION_TABLE}([[:space:]]|$)"; then
        return 1
    fi
    if ip -6 rule list 2>/dev/null \
        | grep -Eq "^${TRANSITION_RULE_PRIORITY}:.*fwmark 0x1.*lookup ${TRANSITION_TABLE}([[:space:]]|$)"; then
        return 1
    fi
    if ip route show table "$TRANSITION_TABLE" proto "$ROUTE_PROTO" 2>/dev/null \
        | grep -q .; then
        return 1
    fi
    if ip -6 route show table "$TRANSITION_TABLE" proto "$ROUTE_PROTO" 2>/dev/null \
        | grep -q .; then
        return 1
    fi
    return 0
}

# Put an independent, higher-priority blackhole in place before dismantling
# the normal VPN table. Route cleanup is a multi-command transaction; without
# this guard, a failed command after deleting the normal policy rule creates a
# short fail-open window before the recovery guard can be rebuilt.
ensure_cleanup_guard() {
    ip route replace blackhole default table "$TRANSITION_TABLE" \
        proto "$ROUTE_PROTO" metric 32767 || return 1
    if ipv6_stack_available; then
        ip -6 route replace blackhole "$TUN_PUBLIC_V6_PREFIX" \
            table "$TRANSITION_TABLE" proto "$ROUTE_PROTO" metric 32767 \
            || return 1
    fi
    if ! ip rule list 2>/dev/null \
        | grep -Eq "^${TRANSITION_RULE_PRIORITY}:.*fwmark 0x1.*lookup ${TRANSITION_TABLE}([[:space:]]|$)"; then
        ip rule add priority "$TRANSITION_RULE_PRIORITY" not fwmark "$FWMARK" \
            table "$TRANSITION_TABLE" || return 1
    fi
    if ip -6 route show table "$TRANSITION_TABLE" proto "$ROUTE_PROTO" 2>/dev/null \
        | grep -q . \
        && ! ip -6 rule list 2>/dev/null \
            | grep -Eq "^${TRANSITION_RULE_PRIORITY}:.*fwmark 0x1.*lookup ${TRANSITION_TABLE}([[:space:]]|$)"; then
        ip -6 rule add priority "$TRANSITION_RULE_PRIORITY" not fwmark "$FWMARK" \
            table "$TRANSITION_TABLE" || return 1
    fi
}

# The executable and every one of its parent directories must be immutable to
# non-root users. Checking only the final file leaves a directory-swap TOCTOU.
validate_tun2socks_path() {
    local path="$1" canonical base owner mode current
    [ -n "$path" ] && [ "${path:0:1}" = "/" ] \
        || die "tun2socks path must be absolute"
    [ -f "$path" ] && [ -x "$path" ] \
        || die "tun2socks is not a regular executable: $path"

    canonical=$(readlink -f -- "$path" 2>/dev/null || true)
    [ "$canonical" = "$path" ] \
        || die "tun2socks path must be canonical and contain no symlinks: $path"

    base=$(basename -- "$path")
    case "$base" in
        tun2socks|tun2socks-x86_64-unknown-linux-gnu) ;;
        *) die "unexpected tun2socks executable name: $base" ;;
    esac
    case "$path" in
        /usr/bin/*|/usr/lib/*|/usr/local/lib/*|/opt/*) ;;
        *) die "tun2socks path is outside an installed application directory: $path" ;;
    esac

    current="$path"
    while [ "$current" != "/" ]; do
        owner=$(stat -c '%u' "$current" 2>/dev/null || echo '?')
        mode=$(stat -c '%a' "$current" 2>/dev/null || echo '?')
        [ "$owner" = "0" ] || die "non-root-owned path component: $current"
        [[ "$mode" =~ ^[0-7]{3,4}$ ]] || die "cannot inspect mode of $current"
        (( (8#$mode & 0022) == 0 )) \
            || die "group/world-writable path component: $current"
        current=$(dirname -- "$current")
    done
}

process_is_managed_tun2socks() {
    local pid="$1" exe raw_exe owner process_owner mode base arg next index
    local device_found=0 proxy_found=0 mark_found=0
    local -a argv=()
    [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 1 )) || return 1
    [ -r "/proc/$pid/cmdline" ] && [ -e "/proc/$pid/exe" ] || return 1
    mapfile -d '' -t argv <"/proc/$pid/cmdline" 2>/dev/null || return 1
    for (( index = 0; index < ${#argv[@]}; index++ )); do
        arg=${argv[$index]}
        next=${argv[$((index + 1))]:-}
        case "$arg" in
            --device|-device)
                if [ "$next" = "$TUN_NAME" ] || [ "$next" = "tun://$TUN_NAME" ]; then
                    device_found=1
                fi
                ;;
            "--device=$TUN_NAME"|"-device=$TUN_NAME"|"--device=tun://$TUN_NAME"|"-device=tun://$TUN_NAME")
                device_found=1
                ;;
            --proxy|-proxy)
                [ "$next" = "socks5://127.0.0.1:${SOCKS_PORT}" ] && proxy_found=1
                ;;
            "--proxy=socks5://127.0.0.1:${SOCKS_PORT}"|"-proxy=socks5://127.0.0.1:${SOCKS_PORT}")
                proxy_found=1
                ;;
            --fwmark|-fwmark)
                [ "$next" = "$FWMARK" ] && mark_found=1
                ;;
            "--fwmark=$FWMARK"|"-fwmark=$FWMARK")
                mark_found=1
                ;;
        esac
    done
    (( device_found == 1 && proxy_found == 1 && mark_found == 1 )) || return 1

    raw_exe=$(readlink -- "/proc/$pid/exe" 2>/dev/null || true)
    [ -n "$raw_exe" ] || return 1
    exe=${raw_exe%" (deleted)"}
    case "$exe" in
        /usr/bin/*|/usr/lib/*|/usr/local/lib/*|/opt/*) ;;
        *) return 1 ;;
    esac
    base=$(basename -- "$exe")
    case "$base" in tun2socks|tun2socks-x86_64-unknown-linux-gnu) ;; *) return 1 ;; esac
    process_owner=$(stat -c '%u' "/proc/$pid" 2>/dev/null || echo '?')
    owner=$(stat -Lc '%u' "/proc/$pid/exe" 2>/dev/null || echo '?')
    mode=$(stat -Lc '%a' "/proc/$pid/exe" 2>/dev/null || echo '?')
    [ "$process_owner" = "0" ] && [ "$owner" = "0" ] \
        && [[ "$mode" =~ ^[0-7]{3,4}$ ]] \
        && (( (8#$mode & 0022) == 0 ))
}

terminate_managed_pid() {
    local pid="$1"
    process_is_managed_tun2socks "$pid" || return 1
    if ! kill "$pid" 2>/dev/null; then
        kill -0 "$pid" 2>/dev/null && return 1
        return 0
    fi
    for _ in {1..20}; do
        kill -0 "$pid" 2>/dev/null || return 0
        sleep 0.05
    done
    process_is_managed_tun2socks "$pid" || return 0
    kill -9 "$pid" 2>/dev/null || return 1
    for _ in {1..20}; do
        kill -0 "$pid" 2>/dev/null || return 0
        sleep 0.05
    done
    return 1
}

managed_process_exists() {
    local pid
    command -v pgrep >/dev/null 2>&1 || return 1
    while IFS= read -r pid; do
        process_is_managed_tun2socks "$pid" && return 0
    done < <(pgrep -f tun2socks 2>/dev/null || true)
    return 1
}

verify_routing_cleanup() {
    managed_process_exists && return 1
    ip rule list 2>/dev/null \
        | grep -Eq "^${RULE_PRIORITY}:.*fwmark 0x1.*lookup ${TUN_TABLE}([[:space:]]|$)" \
        && return 1
    ip -6 rule list 2>/dev/null \
        | grep -Eq "^${RULE_PRIORITY}:.*fwmark 0x1.*lookup ${TUN_TABLE}([[:space:]]|$)" \
        && return 1
    ip route show table "$TUN_TABLE" proto "$ROUTE_PROTO" 2>/dev/null \
        | grep -q . && return 1
    ip -6 route show table "$TUN_TABLE" proto "$ROUTE_PROTO" 2>/dev/null \
        | grep -q . && return 1
    ip rule list 2>/dev/null \
        | grep -Eq '^100:.*fwmark 0x1.*lookup 100([[:space:]]|$)' && return 1
    ip -6 rule list 2>/dev/null \
        | grep -Eq '^100:.*fwmark 0x1.*lookup 100([[:space:]]|$)' && return 1
    if ip -details link show "$TUN_NAME" 2>/dev/null \
        | grep -Fq "alias $OWNER_MARKER"; then
        return 1
    fi
    return 0
}

# Cleanup is necessarily a sequence of iproute2 operations. If one of them
# fails after the policy rule has already been removed, rebuild a minimal
# normal-table guard before returning an error. This prevents a failed Stop or
# failed reconnect from silently falling through to the physical default route.
install_normal_failure_guard() {
    printf '%s\n' "$OWNER_MARKER" >"$OWNER_FILE" || return 1
    ip route replace blackhole default table "$TUN_TABLE" \
        proto "$ROUTE_PROTO" metric 32767 || return 1
    if ! ip rule list 2>/dev/null \
        | grep -Eq "^${RULE_PRIORITY}:.*fwmark 0x1.*lookup ${TUN_TABLE}([[:space:]]|$)"; then
        ip rule add priority "$RULE_PRIORITY" not fwmark "$FWMARK" \
            table "$TUN_TABLE" || return 1
    fi
    if ipv6_stack_available; then
        ip -6 route replace blackhole "$TUN_PUBLIC_V6_PREFIX" table "$TUN_TABLE" \
            proto "$ROUTE_PROTO" metric 32767 || return 1
        if ! ip -6 rule list 2>/dev/null \
            | grep -Eq "^${RULE_PRIORITY}:.*fwmark 0x1.*lookup ${TUN_TABLE}([[:space:]]|$)"; then
            ip -6 rule add priority "$RULE_PRIORITY" not fwmark "$FWMARK" \
                table "$TUN_TABLE" || return 1
        fi
    fi
}

has_managed_state() {
    [ "$(cat "$OWNER_FILE" 2>/dev/null || true)" = "$OWNER_MARKER" ] && return 0
    ip -details link show "$TUN_NAME" 2>/dev/null \
        | grep -Fq "alias $OWNER_MARKER" && return 0
    ip rule list 2>/dev/null \
        | grep -Eq "^${RULE_PRIORITY}:.*fwmark 0x1.*lookup ${TUN_TABLE}([[:space:]]|$)" && return 0
    ip route show table "$TUN_TABLE" proto "$ROUTE_PROTO" 2>/dev/null \
        | grep -q . && return 0
    ip -6 rule list 2>/dev/null \
        | grep -Eq "^${RULE_PRIORITY}:.*fwmark 0x1.*lookup ${TUN_TABLE}([[:space:]]|$)" && return 0
    ip -6 route show table "$TUN_TABLE" proto "$ROUTE_PROTO" 2>/dev/null \
        | grep -q . && return 0
    # Exact legacy signature, used only to migrate installations made by
    # releases that predate the root-only state directory.
    ip rule list 2>/dev/null \
        | grep -Eq '^100:.*fwmark 0x1.*lookup 100([[:space:]]|$)' && return 0
    ip -6 rule list 2>/dev/null \
        | grep -Eq '^100:.*fwmark 0x1.*lookup 100([[:space:]]|$)' && return 0
    return 1
}

restore_dns() {
    local mode target restore_kind
    mode=$(cat "$DNS_MODE_FILE" 2>/dev/null || true)
    case "$mode" in
        resolvectl)
            if command -v resolvectl >/dev/null 2>&1; then
                if ! resolvectl revert "$TUN_NAME" >/dev/null 2>&1; then
                    # Per-link DNS state disappears with the link. A crash can
                    # remove the TUN before the next cleanup reaches this file.
                    ip link show "$TUN_NAME" >/dev/null 2>&1 && return 1
                fi
            else
                ip link show "$TUN_NAME" >/dev/null 2>&1 && return 1
            fi
            ;;
        resolvconf)
            if [ -f "$RESOLV_LINK_FILE" ]; then
                target=$(cat "$RESOLV_LINK_FILE")
                [ -n "$target" ] || return 1
                restore_kind="link"
            elif [ -f "$RESOLV_BACKUP_FILE" ]; then
                restore_kind="file"
            elif [ -f "$RESOLV_MISSING_FILE" ]; then
                restore_kind="missing"
            else
                return 1
            fi
            # Validate the complete rollback record before removing the live
            # resolver. A truncated/crashed state must leave current DNS intact.
            rm -f /etc/resolv.conf || return 1
            case "$restore_kind" in
                link) ln -s -- "$target" /etc/resolv.conf || return 1 ;;
                file) cp -p -- "$RESOLV_BACKUP_FILE" /etc/resolv.conf || return 1 ;;
                missing) ;;
            esac
            ;;
        '') ;;
        *) return 1 ;;
    esac
    rm -f "$DNS_MODE_FILE" "$RESOLV_LINK_FILE" "$RESOLV_BACKUP_FILE" \
          "$RESOLV_MISSING_FILE" "$RESOLV_NEW_FILE"
}

cleanup_routing() {
    local managed=0 old ip
    has_managed_state && managed=1

    if [ -f "$PID_FILE" ]; then
        old=$(cat "$PID_FILE" 2>/dev/null || true)
        terminate_managed_pid "$old" || true
        rm -f "$PID_FILE"
        managed=1
    fi

    # Migration cleanup: never trust the old /tmp PID file. Find only a
    # root-owned, non-writable tun2socks whose argv names our exact device.
    if command -v pgrep >/dev/null 2>&1; then
        while IFS= read -r old; do
            if process_is_managed_tun2socks "$old"; then
                managed=1
                terminate_managed_pid "$old" || true
            fi
        done < <(pgrep -f "tun2socks.*--?device(=|[[:space:]])${TUN_NAME}" 2>/dev/null || true)
    fi

    if (( managed == 0 )); then
        # Remove attacker-created legacy names without ever following them.
        # These obsolete names live in world-writable /tmp. Remove only
        # non-directories and ignore attacker-created directory entries so
        # they cannot turn a harmless migration cleanup into a root-helper DoS.
        rm -f -- /tmp/tobevpn_tun2socks.pid /tmp/tobevpn_orig_route \
              /tmp/tobevpn_server_ip /tmp/tobevpn_dns_mode \
              /tmp/tobevpn_resolv.bak /tmp/tobevpn_resolv_link \
              2>/dev/null || true
        return 0
    fi

    # Block ordinary traffic before touching the normal VPN table. The caller
    # removes this independent guard only after cleanup has fully committed.
    ensure_cleanup_guard || return 1

    # Rules are removed first so lookups cannot target a half-deleted tunnel.
    # The higher-priority cleanup guard keeps this transition fail-closed.
    while ip rule del priority "$RULE_PRIORITY" not fwmark "$FWMARK" \
        table "$TUN_TABLE" 2>/dev/null; do :; done
    while ip -6 rule del priority "$RULE_PRIORITY" not fwmark "$FWMARK" \
        table "$TUN_TABLE" 2>/dev/null; do :; done

    # Exact legacy selectors only. Never delete every rule referencing table
    # 100 and never flush that shared table.
    while ip rule del priority 100 not fwmark "$FWMARK" table 100 2>/dev/null; do :; done
    while ip -6 rule del priority 100 not fwmark "$FWMARK" table 100 2>/dev/null; do :; done
    ip route del default dev "$TUN_NAME" table 100 2>/dev/null || true
    ip -6 route del "$TUN_PUBLIC_V6_PREFIX" dev "$TUN_NAME" table 100 2>/dev/null || true

    if [ -f "$BYPASS_FILE" ]; then
        while IFS= read -r ip; do
            if is_ipv4 "$ip"; then
                ip route del "${ip}/32" table "$TUN_TABLE" proto "$ROUTE_PROTO" \
                    2>/dev/null || true
            fi
        done <"$BYPASS_FILE"
    fi
    ip route del default dev "$TUN_NAME" table "$TUN_TABLE" proto "$ROUTE_PROTO" \
        metric 1 2>/dev/null || true
    ip route del blackhole default table "$TUN_TABLE" proto "$ROUTE_PROTO" \
        metric 32767 2>/dev/null || true
    ip -6 route del "$TUN_PUBLIC_V6_PREFIX" dev "$TUN_NAME" table "$TUN_TABLE" \
        proto "$ROUTE_PROTO" metric 1 2>/dev/null || true
    ip -6 route del blackhole "$TUN_PUBLIC_V6_PREFIX" table "$TUN_TABLE" \
        proto "$ROUTE_PROTO" metric 32767 2>/dev/null || true
    # The table/protocol pair is dedicated to this app. Flush it after the
    # exact deletes so a partial earlier cleanup cannot strand an unlisted
    # bypass route after its state file is gone.
    ip route flush table "$TUN_TABLE" proto "$ROUTE_PROTO" 2>/dev/null || true
    ip -6 route flush table "$TUN_TABLE" proto "$ROUTE_PROTO" 2>/dev/null || true

    if ip -details link show "$TUN_NAME" 2>/dev/null \
        | grep -Fq "alias $OWNER_MARKER" \
        || [ "$(cat "$OWNER_FILE" 2>/dev/null || true)" = "$OWNER_MARKER" ]; then
        ip link del "$TUN_NAME" 2>/dev/null || true
    fi

    rm -f "$OWNER_FILE"
    rm -f -- /tmp/tobevpn_tun2socks.pid /tmp/tobevpn_orig_route \
          /tmp/tobevpn_server_ip /tmp/tobevpn_dns_mode \
          /tmp/tobevpn_resolv.bak /tmp/tobevpn_resolv_link \
          2>/dev/null || true
    if ! verify_routing_cleanup; then
        install_normal_failure_guard \
            || echo "ERROR: could not restore fail-closed routing guard" >&2
        echo "ERROR: managed VPN routing/process state remains after cleanup" >&2
        return 1
    fi
    rm -f "$ORIG_ROUTE_FILE" "$BYPASS_FILE" "$LOG_FILE"
}

setup_dns() {
    if command -v resolvectl >/dev/null 2>&1; then
        if resolvectl dns "$TUN_NAME" 1.1.1.1 8.8.8.8 >/dev/null 2>&1; then
            if resolvectl domain "$TUN_NAME" '~.' >/dev/null 2>&1; then
                if ! printf '%s\n' resolvectl >"$DNS_MODE_FILE"; then
                    resolvectl revert "$TUN_NAME" >/dev/null 2>&1 || true
                    return 1
                fi
                return 0
            fi
            resolvectl revert "$TUN_NAME" >/dev/null 2>&1 || true
        fi
    fi

    rm -f "$RESOLV_LINK_FILE" "$RESOLV_BACKUP_FILE" "$RESOLV_MISSING_FILE"
    if [ -L /etc/resolv.conf ]; then
        readlink /etc/resolv.conf >"$RESOLV_LINK_FILE" || return 1
    elif [ -e /etc/resolv.conf ]; then
        cp -p -- /etc/resolv.conf "$RESOLV_BACKUP_FILE" || return 1
    else
        : >"$RESOLV_MISSING_FILE" || return 1
    fi

    printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' >"$RESOLV_NEW_FILE" || return 1
    chmod 0644 "$RESOLV_NEW_FILE" || return 1
    # Record the rollback mode before touching /etc. If install fails, the
    # EXIT trap can still reconstruct the original file or symlink.
    printf '%s\n' resolvconf >"$DNS_MODE_FILE" || return 1
    rm -f /etc/resolv.conf || return 1
    if ! install -m 0644 -o root -g root "$RESOLV_NEW_FILE" /etc/resolv.conf; then
        restore_dns || true
        return 1
    fi
}

init_state_dir
command -v flock >/dev/null 2>&1 || die "flock is required"
exec 9>"$LOCK_FILE"
flock -w 20 9 || die "another ToBeVPN network operation is still running"

# Start/switch and package replacement are mutually exclusive. The updater
# holds this lock from its final active-tunnel check through dpkg; Stop remains
# deliberately lock-free so an already active session can always be cleaned.
case "${1:-}" in
  start|guard-switch)
    exec 8>>"$UPDATE_LOCK_FILE"
    flock -n 8 || die "a ToBeVPN update is currently being installed"
    ;;
esac

case "${1:-}" in
  guard-switch)
    GUARD_IPS=("${@:2}")
    [ ${#GUARD_IPS[@]} -gt 0 ] \
        || die "usage: $0 guard-switch <server-ip> [bypass-ip ...]"
    (( ${#GUARD_IPS[@]} <= 512 )) || die "too many transition bypass IPv4 addresses"
    for BYPASS_IP in "${GUARD_IPS[@]}"; do
        is_public_ipv4 "$BYPASS_IP" || die "transition bypass IPv4 address must be public"
    done

    cleanup_transition_guard || die "could not clear an old live-switch guard"
    GUARD_STARTING=1
    guard_failure_cleanup() {
        local status=$?
        if (( GUARD_STARTING == 1 && status != 0 )); then
            GUARD_STARTING=0
            cleanup_transition_guard || true
        fi
        exit "$status"
    }
    trap guard_failure_cleanup EXIT

    printf '%s\n' "${GUARD_IPS[@]}" | awk 'NF && !seen[$0]++' \
        >"$TRANSITION_BYPASS_FILE"
    while IFS= read -r BYPASS_IP; do
        add_transition_bypass_route "$BYPASS_IP" \
            || die "could not resolve physical route for transition bypass IPv4 address"
    done <"$TRANSITION_BYPASS_FILE"

    # Add rules last. Until this point the old tunnel continues to carry
    # normal traffic; afterwards only the validated /32 endpoints can leave
    # physically and everything else is blackholed during the replacement.
    ip route add blackhole default table "$TRANSITION_TABLE" \
        proto "$ROUTE_PROTO" metric 32767
    if ipv6_stack_available; then
        ip -6 route add blackhole "$TUN_PUBLIC_V6_PREFIX" table "$TRANSITION_TABLE" \
            proto "$ROUTE_PROTO" metric 32767
    fi
    ip rule add priority "$TRANSITION_RULE_PRIORITY" not fwmark "$FWMARK" \
        table "$TRANSITION_TABLE"
    if ip -6 route show table "$TRANSITION_TABLE" proto "$ROUTE_PROTO" 2>/dev/null \
        | grep -q .; then
        ip -6 rule add priority "$TRANSITION_RULE_PRIORITY" not fwmark "$FWMARK" \
            table "$TRANSITION_TABLE"
    fi

    GUARD_STARTING=0
    trap - EXIT
    echo "GUARDED"
    ;;

  start)
    TUN2SOCKS_BIN="${2:-}"
    SERVER_IP="${3:-}"
    EXTRA_BYPASS_IPS=("${@:4}")
    [ -n "$TUN2SOCKS_BIN" ] && [ -n "$SERVER_IP" ] \
        || die "usage: $0 start <tun2socks-bin> <server-ip> [bypass-ip ...]"
    (( ${#EXTRA_BYPASS_IPS[@]} + 1 <= 512 )) || die "too many bypass IPv4 addresses"
    validate_tun2socks_path "$TUN2SOCKS_BIN"
    for BYPASS_IP in "$SERVER_IP" "${EXTRA_BYPASS_IPS[@]}"; do
        is_public_ipv4 "$BYPASS_IP" || die "bypass IPv4 address must be public"
    done

    DNS_ERROR=""
    CLEANUP_ERROR=""
    restore_dns || DNS_ERROR="could not restore DNS left by the previous session"
    [ -z "$DNS_ERROR" ] || die "$DNS_ERROR"
    cleanup_routing || CLEANUP_ERROR="could not remove routing left by the previous session"
    [ -z "$CLEANUP_ERROR" ] || die "$CLEANUP_ERROR"
    if ip link show "$TUN_NAME" >/dev/null 2>&1; then
        die "network interface $TUN_NAME already exists and is not owned by ToBeVPN"
    fi

    STARTING=1
    start_failure_cleanup() {
        local status=$?
        if (( STARTING == 1 && status != 0 )); then
            STARTING=0
            if restore_dns && cleanup_routing; then
                cleanup_transition_guard || true
            fi
        fi
        exit "$status"
    }
    trap start_failure_cleanup EXIT
    printf '%s\n' "$OWNER_MARKER" >"$OWNER_FILE"

    printf '%s\n' "$SERVER_IP" "${EXTRA_BYPASS_IPS[@]}" \
        | awk 'NF && !seen[$0]++' >"$BYPASS_FILE"

    : >"$LOG_FILE"
    chmod 0600 "$LOG_FILE"
    setsid "$TUN2SOCKS_BIN" --device "$TUN_NAME" \
        --proxy "socks5://127.0.0.1:${SOCKS_PORT}" \
        --fwmark "$FWMARK" --loglevel error >"$LOG_FILE" 2>&1 8>&- 9>&- &
    T2S_PID=$!
    printf '%s\n' "$T2S_PID" >"$PID_FILE"
    disown "$T2S_PID" 2>/dev/null || true

    for _ in {1..30}; do
        ip link show "$TUN_NAME" >/dev/null 2>&1 && break
        sleep 0.1
    done
    if ! ip link show "$TUN_NAME" >/dev/null 2>&1; then
        if [ -s "$LOG_FILE" ]; then
            tail -20 "$LOG_FILE" | sed 's/^/    /' >&2
        fi
        die "TUN $TUN_NAME did not appear"
    fi
    process_is_managed_tun2socks "$T2S_PID" \
        || die "tun2socks exited before routing was configured"

    ip link set dev "$TUN_NAME" alias "$OWNER_MARKER"
    ip addr add "$TUN_ADDR" dev "$TUN_NAME" 2>/dev/null || true
    ip -6 addr add "$TUN_ADDR6" dev "$TUN_NAME" 2>/dev/null || true
    ip link set "$TUN_NAME" up

    while IFS= read -r BYPASS_IP; do
        add_bypass_route "$BYPASS_IP" \
            || die "could not resolve physical route for bypass IPv4 address"
    done <"$BYPASS_FILE"

    # A high-metric blackhole remains if the TUN disappears unexpectedly.
    # This makes process crashes fail closed instead of falling through to the
    # physical default route until the watchdog notices.
    ip route add blackhole default table "$TUN_TABLE" proto "$ROUTE_PROTO" metric 32767
    ip route add default dev "$TUN_NAME" table "$TUN_TABLE" proto "$ROUTE_PROTO" metric 1
    if ipv6_stack_available; then
        ip -6 route add blackhole "$TUN_PUBLIC_V6_PREFIX" table "$TUN_TABLE" \
            proto "$ROUTE_PROTO" metric 32767
        if ip -6 addr show dev "$TUN_NAME" 2>/dev/null | grep -Fq "${TUN_ADDR6%/*}"; then
            ip -6 route add "$TUN_PUBLIC_V6_PREFIX" dev "$TUN_NAME" table "$TUN_TABLE" \
                proto "$ROUTE_PROTO" metric 1
        fi
    fi
    ip rule add priority "$RULE_PRIORITY" not fwmark "$FWMARK" table "$TUN_TABLE"
    if ip -6 route show table "$TUN_TABLE" proto "$ROUTE_PROTO" 2>/dev/null \
        | grep -q .; then
        ip -6 rule add priority "$RULE_PRIORITY" not fwmark "$FWMARK" table "$TUN_TABLE"
    fi

    setup_dns || die "could not configure leak-safe system DNS"
    process_is_managed_tun2socks "$T2S_PID" \
        || die "tun2socks exited during routing setup"
    # The normal table is now complete and fail-closed. Only now may the
    # independent live-switch guard be removed.
    cleanup_transition_guard || die "could not remove live-switch guard"

    STARTING=0
    trap - EXIT
    echo "OK $T2S_PID"
    ;;

  stop|stop-preserve-guard)
    DNS_ERROR=""
    CLEANUP_ERROR=""
    GUARD_ERROR=""
    restore_dns || DNS_ERROR="failed to restore system DNS"
    if [ -z "$DNS_ERROR" ]; then
        cleanup_routing || CLEANUP_ERROR="failed to remove managed VPN routing/process state"
    fi
    if [ "$1" = "stop" ] && [ -z "$DNS_ERROR" ] && [ -z "$CLEANUP_ERROR" ]; then
        cleanup_transition_guard || GUARD_ERROR="failed to remove live-switch guard"
    fi
    [ -z "$CLEANUP_ERROR" ] || die "$CLEANUP_ERROR"
    [ -z "$DNS_ERROR" ] || die "$DNS_ERROR"
    [ -z "$GUARD_ERROR" ] || die "$GUARD_ERROR"
    echo "STOPPED"
    ;;

  bypass)
    BYPASS_IPS=("${@:2}")
    [ ${#BYPASS_IPS[@]} -gt 0 ] || { echo "OK"; exit 0; }
    (( ${#BYPASS_IPS[@]} <= 512 )) || die "too many bypass IPv4 addresses"
    for BYPASS_IP in "${BYPASS_IPS[@]}"; do
        is_public_ipv4 "$BYPASS_IP" || die "bypass IPv4 address must be public"
    done
    [ "$(cat "$OWNER_FILE" 2>/dev/null || true)" = "$OWNER_MARKER" ] \
        || { echo "OK"; exit 0; }
    [ -f "$BYPASS_FILE" ] || die "bypass route state is missing"
    [ -f "$PID_FILE" ] || die "tun2socks process state is missing"
    T2S_PID=$(cat "$PID_FILE" 2>/dev/null || true)
    process_is_managed_tun2socks "$T2S_PID" \
        || die "tun2socks is no longer running"

    for BYPASS_IP in "${BYPASS_IPS[@]}"; do
        if grep -Fxq "$BYPASS_IP" "$BYPASS_FILE" 2>/dev/null; then
            continue
        fi
        add_bypass_route "$BYPASS_IP" \
            || die "could not resolve physical route for bypass IPv4 address"
        printf '%s\n' "$BYPASS_IP" >>"$BYPASS_FILE"
    done
    echo "OK"
    ;;

  *)
    die "usage: $0 {guard-switch <server-ip> [bypass-ip ...]|start <tun2socks-bin> <server-ip> [bypass-ip ...]|bypass <ip> [ip ...]|stop|stop-preserve-guard}"
    ;;
esac
