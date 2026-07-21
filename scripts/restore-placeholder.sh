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
SUBSCRIPTION_HOST_VAL=$(resolve SUBSCRIPTION_HOST VITE_SUBSCRIPTION_URL)

# Fallback hosts are pulled from the same environment/.env entries the inject
# script uses. We keep separate placeholders because the two routes need not
# be hosted together.
extract_host_for_restore() {
    local raw=$1
    raw="${raw#https://}"
    raw="${raw#http://}"
    raw="${raw%%/*}"
    raw="${raw%%\?*}"
    echo "$raw"
}
resolve_fallback() {
    local host_env=$1 url_env=$2 dotenv_key=$3
    local raw="${!host_env:-}"
    if [ -n "$raw" ]; then echo "$raw"; return 0; fi
    raw="${!url_env:-}"
    if [ -z "$raw" ] && [ -f .env ]; then
        local line
        line=$(grep -E "^${dotenv_key}=" .env || true)
        [ -n "$line" ] && raw="${line#${dotenv_key}=}"
    fi
    [ -n "$raw" ] && extract_host_for_restore "$raw"
}
FALLBACK_BOT_HOST_VAL=$(resolve_fallback FALLBACK_BOT_HOST VITE_FALLBACK_BOT_DOMAIN VITE_FALLBACK_BOT_DOMAIN || true)
FALLBACK_SUBS_HOST_VAL=$(resolve_fallback FALLBACK_SUBS_HOST VITE_FALLBACK_SUBS_DOMAIN VITE_FALLBACK_SUBS_DOMAIN || true)

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
    local file=$1 value=$2 placeholder=$3
    [ -f "$file" ] || return 0
    [ -z "$value" ] && return 0
    sed -i.bak "s|${value}|${placeholder}|g" "$file"
    rm -f "${file}.bak"
}

restore_in src-tauri/tauri.conf.json
restore_in src-tauri/capabilities/default.json
if [ "$BOT" = "$PANEL" ]; then
    # The first global substitution necessarily turns both equal hosts into
    # BOT placeholders. Restore the second CSP slot structurally so the
    # public tree remains stable after builds that use one shared domain.
    sed -i.bak \
        's|https://__BOT_API_HOST__ https://__BOT_API_HOST__|https://__BOT_API_HOST__ https://__PANEL_HOST__|' \
        src-tauri/tauri.conf.json
    rm -f src-tauri/tauri.conf.json.bak
fi
restore_fallback_in src-tauri/capabilities/default.json "$SUBSCRIPTION_HOST_VAL" __SUBSCRIPTION_HOST__
restore_fallback_in src-tauri/capabilities/default.json "$FALLBACK_BOT_HOST_VAL" __FALLBACK_BOT_HOST__
restore_fallback_in src-tauri/capabilities/default.json "$FALLBACK_SUBS_HOST_VAL" __FALLBACK_SUBS_HOST__
if [ -n "$FALLBACK_BOT_HOST_VAL" ] && [ "$FALLBACK_BOT_HOST_VAL" = "$FALLBACK_SUBS_HOST_VAL" ]; then
    # A global substitution cannot distinguish two equal hosts; restore the
    # second allowlist entry to its dedicated placeholder.
    sed -i.bak \
        '/__FALLBACK_BOT_HOST__/{n;s|__FALLBACK_BOT_HOST__|__FALLBACK_SUBS_HOST__|;}' \
        src-tauri/capabilities/default.json
    rm -f src-tauri/capabilities/default.json.bak
fi

# Final safety net: local builds may have capabilities/default.json injected
# with values from an older .env, so exact host substitutions above cannot
# always know what needs to be removed. The public source must keep only
# placeholders in the HTTP allowlist.
perl -0pi -e 's/"allow": \[\n(?:\s*\{ "url": "https:\/\/[^"]+" \},\n){4}\s*\{ "url": "https:\/\/[^"]+" \}\n\s*\]/"allow": [\n        { "url": "https:\/\/__BOT_API_HOST__\/*" },\n        { "url": "https:\/\/__PANEL_HOST__\/*" },\n        { "url": "https:\/\/__SUBSCRIPTION_HOST__\/*" },\n        { "url": "https:\/\/__FALLBACK_BOT_HOST__\/*" },\n        { "url": "https:\/\/__FALLBACK_SUBS_HOST__\/*" }\n      ]/s' src-tauri/capabilities/default.json

echo "✓ restored __BOT_API_HOST__ / __PANEL_HOST__ placeholders"
