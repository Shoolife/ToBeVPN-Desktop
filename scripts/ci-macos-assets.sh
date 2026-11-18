#!/bin/bash
# Sidecars and routing data for a macOS build (MACOS_ARCH: arm64 or x64), as
# build.yml's Linux step prepares them: Xray and tun2socks for that Mac,
# the geo databases and the Russian services list.
# Every download is checked against a pinned or published SHA-256.
set -euo pipefail
mkdir -p src-tauri/bin public/routing

XRAY_VERSION=$(jq -er '.version' .github/xray-core.json)
case "${MACOS_ARCH:-arm64}" in
  arm64)
    XRAY_KEY=macos_arm64
    TUN2SOCKS_ASSET=tun2socks-darwin-arm64
    TUN2SOCKS_SHA256=7c5ebfe2ffb60ecf6e958cc5bbf3e06e74b8b33575ffbb4ba4f6f785a647f1ad
    TRIPLE=aarch64-apple-darwin
    ;;
  x64)
    XRAY_KEY=macos_x64
    TUN2SOCKS_ASSET=tun2socks-darwin-amd64
    TUN2SOCKS_SHA256=6e654da8bab9ca1645862f0e251a69980e0966680713011feea7b1e5901b2a95
    TRIPLE=x86_64-apple-darwin
    ;;
  *) echo "::error::MACOS_ARCH must be arm64 or x64"; exit 1 ;;
esac
XRAY_ASSET=$(jq -er ".${XRAY_KEY}.asset" .github/xray-core.json)
XRAY_SHA256=$(jq -er ".${XRAY_KEY}.sha256" .github/xray-core.json)

download_verified_release_asset() {
  local repo="$1"
  local asset_name="$2"
  local output="$3"
  local metadata
  metadata=$(gh api "repos/${repo}/releases/latest")
  local url
  local digest
  url=$(jq -r --arg name "$asset_name" '.assets[] | select(.name == $name) | .browser_download_url' <<<"$metadata")
  digest=$(jq -r --arg name "$asset_name" '.assets[] | select(.name == $name) | .digest' <<<"$metadata")
  if [ -z "$url" ] || [ "$url" = "null" ] || [[ "$digest" != sha256:* ]]; then
    echo "::error::Could not resolve a verified ${repo}/${asset_name} release asset"
    exit 1
  fi
  curl -fsSL -o "$output" "$url"
  echo "${digest#sha256:}  ${output}" | shasum -a 256 -c -
}

extract_plain_category_domains() {
  local input="$1"
  local output="$2"
  shift 2
  local categories="$*"
  awk -v categories="$categories" '
    BEGIN {
      split(categories, items, " ")
      for (i in items) {
        keep[items[i]] = 1
      }
    }
    /^  - name: / {
      category=$0
      sub(/^  - name: /, "", category)
      gsub(/^"|"$/, "", category)
      in_category = (category in keep)
      next
    }
    in_category && /^      - "/ {
      rule=$0
      sub(/^      - "/, "", rule)
      sub(/"$/, "", rule)
      split(rule, parts, ":")
      if ((parts[1] == "domain" || parts[1] == "full") && parts[2] != "") {
        if (parts[2] !~ /\./) print "*." parts[2]
        else print parts[2]
      }
    }
  ' "$input" | sort -u > "$output"
  grep -qx 'avito.ru' "$output"
  grep -qx 'ozon.ru' "$output"
  grep -qx 'wildberries.ru' "$output"
  grep -qx '*.ru' "$output"
}

append_plain_domain_list() {
  local input="$1"
  local output="$2"
  awk '
    {
      sub(/[[:space:]]+#.*$/, "")
      for (i = 1; i <= NF; i++) {
        domain = tolower($i)
        sub(/^\*\./, "", domain)
        if (domain ~ /^include:/ || domain !~ /\./) next
        if (domain ~ /^[a-z0-9_.-]+$/) print domain
      }
    }
  ' "$input" >> "$output"
  sort -u -o "$output" "$output"
  grep -qx 'yandex.ru' "$output"
  grep -qx 'ozon.ru' "$output"
}


echo "Downloading Xray-core (macOS ${MACOS_ARCH:-arm64})..."
curl -fsSL -o xray.zip \
  "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/${XRAY_ASSET}"
echo "${XRAY_SHA256}  xray.zip" | shasum -a 256 -c -
unzip -o xray.zip -d xray-extracted
cp xray-extracted/xray "src-tauri/bin/xray-${TRIPLE}"
chmod +x "src-tauri/bin/xray-${TRIPLE}"

echo "Downloading automatic routing rules..."
download_verified_release_asset \
  runetfreedom/russia-v2ray-rules-dat geosite.dat src-tauri/bin/geosite.dat
download_verified_release_asset \
  runetfreedom/russia-v2ray-rules-dat geoip.dat src-tauri/bin/geoip.dat
download_verified_release_asset \
  v2fly/domain-list-community dlc.dat_plain.yml dlc.dat_plain.yml
curl -fsSL -o ru-available-only-inside.txt \
  https://raw.githubusercontent.com/runetfreedom/russia-domains-list/main/ru-available-only-inside
extract_plain_category_domains \
  dlc.dat_plain.yml public/routing/ru-services.txt \
  category-bank-ru \
  category-betting-ru \
  category-ecommerce-ru \
  category-entertainment-ru \
  category-gov-ru \
  category-media-ru \
  category-medicine-ru \
  category-retail-ru \
  category-ru \
  category-travel-ru
append_plain_domain_list \
  ru-available-only-inside.txt public/routing/ru-services.txt


# An Intel Xray runs on an Apple Silicon runner only through Rosetta.
if [ "$TRIPLE" = aarch64-apple-darwin ] || arch -x86_64 /usr/bin/true 2>/dev/null; then
  XRAY_LOCATION_ASSET=src-tauri/bin \
    "src-tauri/bin/xray-${TRIPLE}" run -test -config scripts/xray-routing-assets-test.json
else
  echo "No Rosetta here: the routing data is checked by the arm64 build"
fi

echo "Downloading tun2socks (macOS ${MACOS_ARCH:-arm64})..."
curl -fsSL -o tun2socks.zip \
  "https://github.com/xjasonlyu/tun2socks/releases/download/v2.7.0/${TUN2SOCKS_ASSET}.zip"
echo "${TUN2SOCKS_SHA256}  tun2socks.zip" | shasum -a 256 -c -
unzip -o tun2socks.zip -d tun2socks-extracted
cp "tun2socks-extracted/${TUN2SOCKS_ASSET}" "src-tauri/bin/tun2socks-${TRIPLE}"
chmod +x "src-tauri/bin/tun2socks-${TRIPLE}"
if [ "$TRIPLE" = aarch64-apple-darwin ] || arch -x86_64 /usr/bin/true 2>/dev/null; then
  "src-tauri/bin/tun2socks-${TRIPLE}" --version
fi

ls -la src-tauri/bin
