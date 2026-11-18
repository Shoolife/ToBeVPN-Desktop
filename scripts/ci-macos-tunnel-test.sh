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
jq --arg iface "$IFACE" '
  .log = {loglevel: "debug", access: ""}
  | .outbounds |= map(if .tag == "proxy"
      then {tag: "proxy", protocol: "freedom", settings: {domainStrategy: "UseIP"},
            streamSettings: {sockopt: {interface: $iface}}}
      else . end)' "$OUT/app.json" > "$OUT/xray.json"

XRAY_LOCATION_ASSET=src-tauri/bin "src-tauri/bin/xray-$TRIPLE" run -c "$OUT/xray.json" > "$OUT/xray.log" 2>&1 &
XRAY_PID=$!
sleep 2

sudo install -o root -g wheel -m 755 scripts/tobevpn-helper-macos.sh /Library/PrivilegedHelperTools/app.tobevpn.helper
sudo install -o root -g wheel -m 755 "src-tauri/bin/tun2socks-$TRIPLE" /Library/PrivilegedHelperTools/app.tobevpn.tun2socks
# The documentation address of the test config stands for the VPN server.
sudo /Library/PrivilegedHelperTools/app.tobevpn.helper start 203.0.113.10 | tee "$OUT/helper.log"
sleep 2
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

sudo /Library/PrivilegedHelperTools/app.tobevpn.helper stop | tee -a "$OUT/helper.log"
kill "$XRAY_PID" 2>/dev/null || true
echo "== after stop"; curl -s -o /dev/null -m 20 -w "%{http_code}\n" https://ya.ru | tee -a "$OUT/curl.txt"
grep -E "tunneling request|taking detour|failed|error" "$OUT/xray.log" | head -60 > "$OUT/xray-routing.txt" || true
cat "$OUT/xray-routing.txt"
exit "$FAILED"
