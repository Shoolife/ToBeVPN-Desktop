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

# Fallback hosts are pulled from the same .env entries the inject script
# uses. Both store full URLs (https://host/path?...), but we only need the
# bare hostname here because that's what got substituted into capabilities.
extract_host_for_restore() {
    local raw=$1
    raw="${raw#https://}"
    raw="${raw#http://}"
    raw="${raw%%/*}"
    raw="${raw%%\?*}"
    echo "$raw"
}
FALLBACK_HOST_VAL=""
if [ -n "${FALLBACK_HOST:-}" ]; then
    FALLBACK_HOST_VAL="${FALLBACK_HOST}"
elif [ -f .env ]; then
    line=$(grep -E '^VITE_FALLBACK_BOT_DOMAIN=' .env || true)
    if [ -z "$line" ]; then
        line=$(grep -E '^VITE_FALLBACK_SUBS_DOMAIN=' .env || true)
        [ -n "$line" ] && FALLBACK_HOST_VAL=$(extract_host_for_restore "${line#VITE_FALLBACK_SUBS_DOMAIN=}")
    else
        FALLBACK_HOST_VAL=$(extract_host_for_restore "${line#VITE_FALLBACK_BOT_DOMAIN=}")
    fi
fi

if [ -z "$BOT" ] || [ -z "$PANEL" ]; then
    # Nothing to restore — the placeholders are probably already in place.
    exit 0
fi

# Skip restore on CI: the runner is ephemeral and the still-injected
# config files are exactly what `tauri build` (which we run after vite)
# needs to embed the right CSP / capabilities into the bundle. Restoring
# placeholders mid-flow would break the .deb / .nsis output.
if [ "${CI:-}" = "true" ] || [ -n "${GITHUB_ACTIONS:-}" ]; then
    echo "✓ CI environment — skipping placeholder restore"
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

restore_fallback_in() {
    local file=$1
    [ -f "$file" ] || return 0
    [ -z "$FALLBACK_HOST_VAL" ] && return 0
    sed -i.bak "s|${FALLBACK_HOST_VAL}|__FALLBACK_HOST__|g" "$file"
    rm -f "${file}.bak"
}

restore_in src-tauri/tauri.conf.json
restore_in src-tauri/capabilities/default.json
restore_fallback_in src-tauri/capabilities/default.json

echo "✓ restored __BOT_API_HOST__ / __PANEL_HOST__ placeholders"
