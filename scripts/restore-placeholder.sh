#!/usr/bin/env bash
# Re-applies the __BOT_API_HOST__ / __PANEL_HOST__ placeholders to
# tauri.conf.json and capabilities/default.json after a build, so the
# working tree never carries the real production hostnames.
#
# Used as a post-step after `vite build` / `tauri build` so a developer
# rebuilding locally doesn't accidentally `git add` files that contain the
# real domain.

set -euo pipefail

cd "$(dirname "$0")/.."

# Pull the same hosts the inject script used. Any of the three sources is OK.
host_from_env() {
    local var=$1
    if [ -n "${!var:-}" ]; then echo "${!var}"; return 0; fi
    return 1
}

host_from_dotenv() {
    local key=$1
    [ -f .env ] || return 1
    local line
    line=$(grep -E "^${key}=" .env || true)
    [ -n "$line" ] || return 1
    local url="${line#${key}=}"
    url="${url#https://}"
    url="${url%/}"
    echo "$url"
}

resolve() {
    local env_var=$1 dotenv_key=$2
    host_from_env "$env_var" 2>/dev/null \
        || host_from_dotenv "$dotenv_key" \
        || true
}

BOT=$(resolve BOT_API_HOST VITE_BOT_API_URL)
PANEL=$(resolve PANEL_HOST VITE_PANEL_URL)

if [ -z "$BOT" ] || [ -z "$PANEL" ]; then
    # Nothing to restore — the placeholders are probably already in place.
    exit 0
fi

restore_in() {
    local file=$1
    [ -f "$file" ] || return 0
    sed -i.bak \
        -e "s|${BOT}|__BOT_API_HOST__|g" \
        -e "s|${PANEL}|__PANEL_HOST__|g" \
        "$file"
    rm -f "${file}.bak"
}

restore_in src-tauri/tauri.conf.json
restore_in src-tauri/capabilities/default.json

echo "✓ restored __BOT_API_HOST__ / __PANEL_HOST__ placeholders"
