#!/bin/sh
# ToBeVPN on an OpenWrt router: Xray + hev-socks5-tunnel; home devices are
# sent into a tunnel by source address. Installed and driven by the
# ToBeVPN desktop app over SSH.
#
# Everything this script changes at runtime (routes, rules, firewall rules
# marked "tobevpn", processes) is undone by "stop" or by a reboot. Only the
# files in /opt/tobevpn, /etc/hotplug.d/dhcp/90-tobevpn and the optional
# /etc/init.d/tobevpn stay.
#
# Servers come in slots: slot 0 is the router's server (tunnel tobe0, Xray
# SOCKS port 10808), slots 1-3 are servers chosen for single devices
# (tobeN, port 10808+N, config hevN.yml). Xray sends each SOCKS input to
# its own server, so a device's tunnel decides its server.
#
# Files: default_mode ("vpn" or "direct" for devices without a choice),
# devices (MAC<tab>vpn|direct|default<tab>name<tab>slot, one per line),
# slots (slot<tab>server id<tab>server name), servers (ToBeVPN server hosts,
# always reached directly so a device running its own ToBeVPN is not
# tunnelled twice).
#
#   tobevpn-router.sh start|stop|restart|status|uninstall|apply|devices
#   tobevpn-router.sh set-device MAC vpn|direct|default SLOT [NAME]
#   tobevpn-router.sh set-default vpn|direct

DIR=/opt/tobevpn
RUN=/tmp/tobevpn
TABLE=100
SLOT_TABLE_BASE=110
PRIO=101
DEVICE_PRIO=100
BYPASS_PRIO=99
DNS_CHAIN=TOBEVPN_DNS
TUNNEL_DNS=1.1.1.1
TUNNEL_DNS2=1.0.0.1
DNS_PRIO=98
DNSMASQ_CONF=/tmp/dnsmasq.d/tobevpn.conf
LAN_DEV=br-lan
TAG=tobevpn
SOCKS_PORT=10808
# Checked through each server every 30 s; after FAIL_LIMIT failures in a row
# its devices go direct (slot 0: the whole home) until a check passes again.
HEALTH_URL=http://www.gstatic.com/generate_204
FAIL_LIMIT=2

lan_subnet() {
    ip -4 route show dev "$LAN_DEV" scope link 2>/dev/null | awk '{print $1; exit}'
}

lan_address() {
    ip -4 addr show "$LAN_DEV" 2>/dev/null | awk '/inet /{split($2, a, "/"); print a[1]; exit}'
}

# Extra server slots that have a tunnel config (1-3).
extra_slots() {
    for config in "$DIR"/hev[1-3].yml; do
        [ -f "$config" ] && basename "$config" .yml | sed 's/^hev//'
    done
}

tunnel_of() {
    echo "tobe$1"
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

# Current IPv4 address of a MAC: DHCP lease first, then the ARP table.
mac_address_ip() {
    awk -v mac="$1" 'tolower($2) == mac {print $3; exit}' /tmp/dhcp.leases 2>/dev/null |
        grep . || awk -v mac="$1" -v dev="$LAN_DEV" \
            'tolower($4) == mac && $6 == dev && $3 != "0x0" {print $1; exit}' /proc/net/arp
}

# Saved devices as "MAC effective-mode slot". A slot without a tunnel falls
# back to slot 0; a device whose server does not answer goes direct until it
# does, rather than through a server nobody chose for it.
device_choices() {
    default=$(default_mode)
    slots=" 0 $(extra_slots | tr '\n' ' ')"
    down=" $(cat "$RUN/down" 2>/dev/null | tr '\n' ' ')"
    awk -F '\t' -v default="$default" -v slots="$slots" -v down="$down" '
        $1 != "" {
            mode = ($2 == "vpn" || $2 == "direct") ? $2 : default
            slot = ($4 ~ /^[1-3]$/ && index(slots, " " $4 " ")) ? $4 : 0
            if (mode == "vpn" && index(down, " " slot " ")) mode = "direct"
            print tolower($1), mode, slot
        }' "$DIR/devices" 2>/dev/null
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

# Resolvers of the internet provider, used for the names of the servers.
isp_dns() {
    awk '/^nameserver/ {print $2}' /tmp/resolv.conf.auto 2>/dev/null | grep -E '^[0-9.]+$'
}

# Names that must never be resolved through the tunnel: Xray needs them to
# build the tunnel, the subscription is fetched outside it.
direct_domains() {
    {
        cat "$DIR/servers" 2>/dev/null
        sed -n "s|^SUB_URL='https\{0,1\}://\([^/:']*\).*|\1|p" "$DIR/subscription.conf" 2>/dev/null
        grep -o '"address": *"[^"]*"' "$DIR/xray.json" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/'
    } | grep -E '^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' | sort -u
}

# With the whole home on the VPN, the router's own DNS (dnsmasq, with its
# cache) asks 1.1.1.1 through the tunnel; a query then costs a tunnel round
# trip only once. The file is in /tmp: a reboot drops it with the routing.
dns_upstream() {
    while ip rule del prio "$DNS_PRIO" 2>/dev/null; do :; done
    isp=$(isp_dns)
    # Without the provider's resolvers the server names could only be
    # resolved through the tunnel they build: keep the provider's DNS.
    [ -n "$isp" ] || set -- isp
    if [ "$1" = tunnel ]; then
        for server in "$TUNNEL_DNS" "$TUNNEL_DNS2"; do
            ip rule add to "$server" iif lo lookup "$TABLE" prio "$DNS_PRIO"
        done
        want=$(
            printf 'no-resolv\nserver=%s\nserver=%s' "$TUNNEL_DNS" "$TUNNEL_DNS2"
            for domain in $(direct_domains); do
                for resolver in $isp; do
                    printf '\nserver=/%s/%s' "$domain" "$resolver"
                done
            done
        )
        if [ "$(cat "$DNSMASQ_CONF" 2>/dev/null)" != "$want" ]; then
            mkdir -p "${DNSMASQ_CONF%/*}"
            printf '%s\n' "$want" >"$DNSMASQ_CONF"
            /etc/init.d/dnsmasq restart >/dev/null 2>&1
        fi
    elif [ -f "$DNSMASQ_CONF" ]; then
        rm -f "$DNSMASQ_CONF"
        /etc/init.d/dnsmasq restart >/dev/null 2>&1
    fi
}

# Traffic through the tunnels by hour ("HOUR_EPOCH BYTES" lines). Counted in
# RAM every minute; written to flash once an hour and on stop, so the flash
# is not worn. About 5 weeks are kept.
TRAFFIC_KEEP=900

account_traffic() {
    [ -f "$RUN/traffic" ] || cp "$DIR/traffic" "$RUN/traffic" 2>/dev/null || : >"$RUN/traffic"
    delta=0
    for slot in 0 1 2 3; do
        stats=/sys/class/net/$(tunnel_of "$slot")/statistics
        [ -r "$stats/rx_bytes" ] || { rm -f "$RUN/counter_$slot"; continue; }
        now=$(($(cat "$stats/rx_bytes") + $(cat "$stats/tx_bytes")))
        # No previous reading: the tunnel is new since start, counting from 0.
        last=$(cat "$RUN/counter_$slot" 2>/dev/null || echo 0)
        # A restarted tunnel starts its counters from zero.
        if [ "$now" -ge "$last" ]; then delta=$((delta + now - last)); else delta=$((delta + now)); fi
        echo "$now" >"$RUN/counter_$slot"
    done
    hour=$(($(date +%s) / 3600 * 3600))
    if [ "$delta" -gt 0 ]; then
        awk -v hour="$hour" -v delta="$delta" '
            $1 == hour {$2 += delta; found = 1} {print $1, $2}
            END {if (!found) print hour, delta}' "$RUN/traffic" >"$RUN/traffic.tmp" &&
            mv "$RUN/traffic.tmp" "$RUN/traffic"
    fi
    [ "$(cat "$RUN/traffic_saved" 2>/dev/null)" = "$hour" ] || save_traffic "$hour"
}

save_traffic() {
    [ -f "$RUN/traffic" ] || return 0
    tail -n "$TRAFFIC_KEEP" "$RUN/traffic" >"$DIR/traffic.tmp" && mv "$DIR/traffic.tmp" "$DIR/traffic"
    echo "${1:-$(($(date +%s) / 3600 * 3600))}" >"$RUN/traffic_saved"
}

slot_down() {
    grep -qx "$1" "$RUN/down" 2>/dev/null
}

# One request through the slot's server, bypassing the routing and the DNS.
probe_slot() {
    code=$(curl -s -m "${2:-10}" -o /dev/null -w '%{http_code}' \
        --socks5-hostname "127.0.0.1:$((SOCKS_PORT + $1))" "$HEALTH_URL" 2>/dev/null)
    [ "$code" = 204 ]
}

event() {
    echo "$(date +%s) $*" >>"$RUN/events"
    tail -n 30 "$RUN/events" >"$RUN/events.tmp" && mv "$RUN/events.tmp" "$RUN/events"
}

# Checks every slot; returns 0 when a slot went down or came back.
check_health() {
    changed=1
    for slot in 0 $(extra_slots); do
        fails=$(cat "$RUN/fails_$slot" 2>/dev/null || echo 0)
        if probe_slot "$slot"; then
            echo 0 >"$RUN/fails_$slot"
            if slot_down "$slot"; then
                sed -i "/^$slot\$/d" "$RUN/down"
                event "slot $slot back"
                changed=0
            fi
        else
            fails=$((fails + 1))
            echo "$fails" >"$RUN/fails_$slot"
            if [ "$fails" -ge "$FAIL_LIMIT" ] && ! slot_down "$slot"; then
                echo "$slot" >>"$RUN/down"
                event "slot $slot down"
                changed=0
            fi
        fi
    done
    return $changed
}

clear_device_rules() {
    while ip rule del lookup "$TABLE" prio "$PRIO" 2>/dev/null; do :; done
    while ip rule del prio "$DEVICE_PRIO" 2>/dev/null; do :; done
}

apply_routes() {
    subnet=$(lan_subnet)
    router_ip=$(lan_address)
    ip route replace default dev "$(tunnel_of 0)" table "$TABLE"
    [ -n "$subnet" ] && ip route replace "$subnet" dev "$LAN_DEV" table "$TABLE"
    for slot in $(extra_slots); do
        table=$((SLOT_TABLE_BASE + slot))
        ip route replace default dev "$(tunnel_of "$slot")" table "$table" 2>/dev/null
        [ -n "$subnet" ] && ip route replace "$subnet" dev "$LAN_DEV" table "$table"
    done
    clear_device_rules
    iptables -t nat -N "$DNS_CHAIN" 2>/dev/null || iptables -t nat -F "$DNS_CHAIN"
    # The router's DNS goes through the tunnel when the home does; otherwise
    # only queries of VPN devices are sent through their tunnel.
    main_down=0
    slot_down 0 && main_down=1
    if [ "$(default_mode)" = vpn ] && [ $main_down = 0 ]; then
        dns_upstream tunnel
        dns_router_ip=
    else
        dns_upstream isp
        dns_router_ip=$router_ip
    fi
    device_choices | while read -r mac mode slot; do
        ip=$(mac_address_ip "$mac")
        [ -n "$ip" ] || continue
        if [ "$mode" = direct ]; then
            # Only matters when the rest of the home goes through the VPN.
            ip rule add from "$ip" lookup main prio "$DEVICE_PRIO"
            iptables -t nat -A "$DNS_CHAIN" -s "$ip" -j RETURN
        elif [ "$slot" != 0 ]; then
            ip rule add from "$ip" lookup "$((SLOT_TABLE_BASE + slot))" prio "$DEVICE_PRIO"
            [ -n "$dns_router_ip" ] && dns_rule "$ip" "$dns_router_ip"
        elif [ $main_down = 1 ]; then
            # The router's server does not answer: direct until it does.
            ip rule add from "$ip" lookup main prio "$DEVICE_PRIO"
        elif [ "$(default_mode)" = direct ]; then
            ip rule add from "$ip" lookup "$TABLE" prio "$PRIO"
            [ -n "$dns_router_ip" ] && dns_rule "$ip" "$dns_router_ip"
        fi
    done
    if [ "$(default_mode)" = vpn ] && [ $main_down = 0 ] && [ -n "$subnet" ]; then
        # The whole home network, except the devices handled above.
        ip rule add from "$subnet" lookup "$TABLE" prio "$PRIO"
    fi
    # DNS of VPN devices when the home is direct: resolved inside their tunnel.
    iptables -t nat -C PREROUTING -j "$DNS_CHAIN" -m comment --comment "$TAG" 2>/dev/null ||
        iptables -t nat -I PREROUTING 1 -j "$DNS_CHAIN" -m comment --comment "$TAG"
    apply_server_bypass
    firewall_rule filter FORWARD 1 -i "$LAN_DEV" -o "tobe+" -j ACCEPT
    firewall_rule filter FORWARD 1 -i "tobe+" -o "$LAN_DEV" -j ACCEPT
    firewall_rule mangle FORWARD 1 -o "tobe+" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
}

# One line per home device: device=MAC|IP|HOSTNAME|MODE|NAME|ONLINE|SLOT,
# MODE being the saved choice or "default"; then slot=N|SERVER_ID|NAME.
list_devices() {
    {
        awk '{print tolower($2) "\t" $3 "\t" $4}' /tmp/dhcp.leases 2>/dev/null
        awk -v dev="$LAN_DEV" 'NR > 1 && $6 == dev && $3 != "0x0" {print tolower($4) "\t" $1 "\t*"}' /proc/net/arp
        awk -F '\t' '{print tolower($1) "\t\t*"}' "$DIR/devices" 2>/dev/null
    } | awk -F '\t' -v saved="$DIR/devices" -v arp=/proc/net/arp -v dev="$LAN_DEV" '
        BEGIN {
            while ((getline line < saved) > 0) {
                split(line, f, "\t"); m = tolower(f[1]); mode[m] = f[2]; name[m] = f[3]; slot[m] = f[4]
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
                s = (slot[m] ~ /^[1-3]$/) ? slot[m] : 0
                print "device=" m "|" ip[m] "|" h "|" (m in mode && mode[m] != "" ? mode[m] : "default") "|" name[m] "|" (m in online ? 1 : 0) "|" s
            }
        }'
    awk -F '\t' '$1 ~ /^[0-3]$/ {print "slot=" $1 "|" $2 "|" $3}' "$DIR/slots" 2>/dev/null
}

set_device() {
    mac=$(echo "$1" | tr 'A-F' 'a-f')
    mode=$2
    slot=$3
    echo "$mac" | grep -qE '^([0-9a-f]{2}:){5}[0-9a-f]{2}$' || { echo "error=bad mac"; return 2; }
    case "$mode" in vpn | direct | default) ;; *) echo "error=bad mode"; return 2 ;; esac
    case "$slot" in 0 | 1 | 2 | 3) ;; *) echo "error=bad slot"; return 2 ;; esac
    name=$(printf '%s' "$4" | tr -d '\t\r\n|' | cut -c1-40)
    touch "$DIR/devices"
    grep -v -i "^$mac	" "$DIR/devices" >"$DIR/devices.tmp" 2>/dev/null
    if [ "$mode" != default ] || [ "$slot" != 0 ] || [ -n "$name" ]; then
        printf '%s\t%s\t%s\t%s\n' "$mac" "$mode" "$name" "$slot" >>"$DIR/devices.tmp"
    fi
    mv "$DIR/devices.tmp" "$DIR/devices"
    pidof xray >/dev/null && apply_routes
    echo "saved=1"
}

hev_count() {
    echo $((1 + $(extra_slots | wc -l)))
}

start_core() {
    if ! pidof xray >/dev/null; then
        GOMEMLIMIT=40MiB GOGC=50 "$DIR/xray" run -c "$DIR/xray.json" >"$RUN/xray.log" 2>&1 &
    fi
    if [ "$(pidof hev-socks5-tunnel | wc -w)" -lt "$(hev_count)" ]; then
        # Restart every tunnel: hev does not tell which config a pid runs.
        pids=$(pidof hev-socks5-tunnel)
        # shellcheck disable=SC2086 # several pids
        [ -n "$pids" ] && kill $pids && sleep 1
        "$DIR/hev-socks5-tunnel" "$DIR/hev.yml" >"$RUN/hev.log" 2>&1 &
        for slot in $(extra_slots); do
            "$DIR/hev-socks5-tunnel" "$DIR/hev$slot.yml" >"$RUN/hev$slot.log" 2>&1 &
        done
    fi
}

core_alive() {
    pidof xray >/dev/null && [ "$(pidof hev-socks5-tunnel | wc -w)" -ge "$(hev_count)" ]
}

# Background watchdog. A crashed core is restarted; while it cannot start,
# the routing is removed so the home stays online without the VPN, and a
# new start is tried every minute. A server that stops answering sends its
# devices direct until it answers again (check_health).
watch() {
    echo $$ >"$RUN/watch.pid"
    ticks=0
    # Processes every 10 s; servers every 30 s; addresses of devices every
    # 5 minutes; server addresses every 6 hours.
    while sleep 10; do
        ticks=$((ticks + 1))
        if ! core_alive; then
            # In the failed state only once a minute.
            [ -f "$RUN/state" ] && [ $((ticks % 6)) -ne 0 ] && continue
            start_core
            sleep 5
            if ! core_alive; then
                if [ ! -f "$RUN/state" ]; then
                    echo "failed=$(date +%s)" >"$RUN/state"
                    stop_routing
                    event "core failed, home direct"
                fi
                continue
            fi
            if [ -f "$RUN/state" ]; then
                rm -f "$RUN/state"
                event "core back"
            fi
            bring_up_tunnels && apply_routes
        fi
        [ $((ticks % 6)) -eq 0 ] && account_traffic
        [ $((ticks % 3)) -eq 0 ] && check_health && apply_routes
        [ $((ticks % 2160)) -eq 0 ] && apply_server_bypass
        # Devices that reconnected with another address; DHCP events also
        # trigger this through /etc/hotplug.d/dhcp/90-tobevpn.
        [ $((ticks % 30)) -eq 0 ] && apply_routes
    done
}

bring_up_tunnels() {
    for slot in 0 $(extra_slots); do
        tun=$(tunnel_of "$slot")
        i=0
        while [ $i -lt 15 ] && ! ip link show "$tun" >/dev/null 2>&1; do
            sleep 1
            i=$((i + 1))
        done
        ip link show "$tun" >/dev/null 2>&1 || { echo "error=tunnel $tun did not come up"; return 1; }
        ip link set "$tun" up
        echo 0 >"/proc/sys/net/ipv4/conf/$tun/rp_filter"
    done
}

start() {
    mkdir -p "$RUN"
    rm -f "$RUN/state"
    [ -c /dev/net/tun ] || modprobe tun 2>/dev/null || insmod tun 2>/dev/null
    refresh_subscription
    start_core
    bring_up_tunnels || return 1
    # A server that does not answer must not take the home offline.
    rm -f "$RUN/down" "$RUN"/fails_*
    for slot in 0 $(extra_slots); do
        probe_slot "$slot" 8 || { sleep 2; probe_slot "$slot" 8; } || {
            echo "$slot" >>"$RUN/down"
            event "slot $slot down at start"
        }
    done
    apply_routes
    if ! { [ -f "$RUN/watch.pid" ] && kill -0 "$(cat "$RUN/watch.pid")" 2>/dev/null; }; then
        "$0" watch >/dev/null 2>&1 &
    fi
    echo "started=1"
}

stop_routing() {
    clear_device_rules
    while ip rule del lookup main prio "$PRIO" 2>/dev/null; do :; done
    while ip rule del lookup main prio "$BYPASS_PRIO" 2>/dev/null; do :; done
    ip route flush table "$TABLE" 2>/dev/null
    for slot in 1 2 3; do
        ip route flush table "$((SLOT_TABLE_BASE + slot))" 2>/dev/null
    done
    remove_dns_redirect
    dns_upstream isp
    remove_firewall_rules
}

stop() {
    if [ -f "$RUN/watch.pid" ]; then
        kill "$(cat "$RUN/watch.pid")" 2>/dev/null
        rm -f "$RUN/watch.pid"
    fi
    # The last minute of traffic, before the tunnels and their counters go.
    if [ -d "$RUN" ]; then
        account_traffic
        save_traffic
        rm -f "$RUN"/counter_*
    fi
    stop_routing
    rm -f "$RUN/down" "$RUN"/fails_*
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
    echo "installed=$([ -x "$DIR/xray" ] && echo 1 || echo 0)"
    echo "running=$(core_alive && echo 1 || echo 0)"
    [ -f "$RUN/state" ] && cat "$RUN/state"
    echo "down_slots=$(cat "$RUN/down" 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
    echo "bypass_rules=$(ip rule | grep -c "^$BYPASS_PRIO:")"
    echo "autostart=$([ -x /etc/rc.d/S99tobevpn ] && echo 1 || echo 0)"
    [ -n "$xray_pid" ] && echo "xray_rss_kb=$(awk '/VmRSS/{print $2}' "/proc/$xray_pid/status")"
    echo "mem_available_kb=$(awk '/MemAvailable/{print $2}' /proc/meminfo)"
    rx=0
    tx=0
    for slot in 0 $(extra_slots); do
        stats=/sys/class/net/$(tunnel_of "$slot")/statistics
        rx=$((rx + $(cat "$stats/rx_bytes" 2>/dev/null || echo 0)))
        tx=$((tx + $(cat "$stats/tx_bytes" 2>/dev/null || echo 0)))
    done
    echo "tun_rx_bytes=$rx"
    echo "tun_tx_bytes=$tx"
    echo "default_mode=$(default_mode)"
    echo "name=$(cat "$DIR/name" 2>/dev/null)"
    sed -n "s/^HWID='\(.*\)'$/hwid=\1/p" "$DIR/subscription.conf" 2>/dev/null
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
set-name)
    # The app limits the name to 40 characters; bytes are capped here only
    # as a guard (busybox cut counts bytes, not letters).
    name=$(printf '%s' "$2" | tr -d '\t\r\n|\\"`$' | head -c 200)
    if [ -n "$name" ]; then printf '%s\n' "$name" >"$DIR/name"; else rm -f "$DIR/name"; fi
    echo "saved=1"
    ;;
traffic)
    # Counted by the watchdog every minute; read only, so the two never race.
    cat "$RUN/traffic" 2>/dev/null || cat "$DIR/traffic" 2>/dev/null
    ;;
set-device) set_device "$2" "$3" "$4" "$5" ;;
set-default)
    case "$2" in vpn | direct) echo "$2" >"$DIR/default_mode" ;; *) echo "error=bad mode"; exit 2 ;; esac
    pidof xray >/dev/null && apply_routes
    echo "saved=1"
    ;;
apply) pidof xray >/dev/null && apply_routes; echo "applied=1" ;;
uninstall) uninstall ;;
*) echo "usage: $0 start|stop|restart|status|uninstall|apply|devices|set-device|set-default" >&2; exit 2 ;;
esac
