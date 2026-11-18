#!/bin/bash
# CI (build-macos.yml): the tunnel of the macOS client on a real Mac runner,
# in the automatic routing mode. The app's own Xray config is used, with the
# proxy swapped for a direct exit bound to the physical interface (there is no
# VPN server in CI): Russian sites must leave through the "direct" rule, the
# rest through "proxy", both through tun2socks, the helper's routes and DNS.
set -uo pipefail
TRIPLE=aarch64-apple-darwin
OUT="$PWD/tunnel-test"
mkdir -p "$OUT"
IFACE=$(route -n get default | awk '/interface:/ {print $2}')
echo "Physical interface: $IFACE"

(cd src-tauri && TOBEVPN_DUMP_XRAY_CONFIG="$OUT/app.json" TOBEVPN_DIRECT_INTERFACE="$IFACE" \
    cargo test --locked --lib dumps_auto_routing_config_for_ci -- --ignored -q)
# The test has no VPN server for DNS: Xray asks the system resolver, whose
# servers (1.1.1.1, 8.8.8.8, set by the helper) are kept off the tunnel below.
jq --arg iface "$IFACE" '
  .log = {loglevel: "debug", access: ""}
  | .dns.servers = ["localhost"]
  | .outbounds |= map(if .tag == "proxy"
      then {tag: "proxy", protocol: "freedom", settings: {domainStrategy: "UseIP"},
            streamSettings: {sockopt: {interface: $iface}}}
      else . end)' "$OUT/app.json" > "$OUT/xray.json"

XRAY_LOCATION_ASSET=src-tauri/bin "src-tauri/bin/xray-$TRIPLE" run -c "$OUT/xray.json" > "$OUT/xray.log" 2>&1 &
XRAY_PID=$!
sleep 2

sudo mkdir -p /Library/PrivilegedHelperTools
sudo install -o root -g wheel -m 755 scripts/tobevpn-helper-macos.sh /Library/PrivilegedHelperTools/app.tobevpn.helper
sudo install -o root -g wheel -m 755 "src-tauri/bin/tun2socks-$TRIPLE" /Library/PrivilegedHelperTools/app.tobevpn.tun2socks
# The documentation address of the test config stands for the VPN server.
sudo /Library/PrivilegedHelperTools/app.tobevpn.helper start 203.0.113.10 1.1.1.1 8.8.8.8 2>&1 | tee "$OUT/helper.log"
sleep 2
# Without the tunnel every site would still open: make sure traffic goes in.
VIA=$(route -n get 1.1.1.1 | awk '/interface:/ {print $2}')
echo "1.1.1.1 goes through: $VIA"
if [ "$VIA" != utun199 ]; then
  echo "::error::The tunnel did not come up"
  tail -20 /var/run/tobevpn/tun2socks.log 2>/dev/null || true
  exit 1
fi
{
  echo "== routes"; netstat -rn -f inet | head -25
  echo "== DNS"; scutil --dns | grep nameserver | sort -u
} > "$OUT/net.txt"

FAILED=0
for URL in https://www.ozon.ru https://mail.ru https://www.avito.ru https://ya.ru https://www.google.com https://github.com; do
  RESULT=$(curl -s -o /dev/null -m 20 -w "%{http_code} %{remote_ip} %{time_total}s" "$URL")
  echo "$URL -> $RESULT" | tee -a "$OUT/curl.txt"
  case "$RESULT" in 000*) FAILED=1 ;; esac
done

# UDP through the tunnel and Xray's interface-bound exit (QUIC, games): a DNS
# query to a server that is not kept off the tunnel.
echo "== UDP through the tunnel (dig @9.9.9.9 ya.ru)" | tee -a "$OUT/curl.txt"
dig +time=5 +tries=1 @9.9.9.9 ya.ru A +short 2>&1 | tee -a "$OUT/curl.txt" || true

sudo /Library/PrivilegedHelperTools/app.tobevpn.helper stop | tee -a "$OUT/helper.log"
kill "$XRAY_PID" 2>/dev/null || true
echo "== after stop"; curl -s -o /dev/null -m 20 -w "%{http_code}\n" https://ya.ru | tee -a "$OUT/curl.txt"
grep -E "taking detour|failed" "$OUT/xray.log" | grep -v "udp:1.1.1.1:53\|mask.icloud" | head -80 > "$OUT/xray-routing.txt" || true
cat "$OUT/xray-routing.txt"
exit "$FAILED"
