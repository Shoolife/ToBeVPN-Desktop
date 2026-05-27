#!/usr/bin/env bash
# Replaces backend host placeholders in tauri.conf.json and
# capabilities/default.json with real values from environment variables.
#
# Run before `tauri build` / `tauri dev` so the public source tree never
# contains the production domain — that would land in GitHub search and
# leak the backend infrastructure to scrapers.
#
# Sources for the real hostnames (in order):
#   1. $BOT_API_HOST and $PANEL_HOST      (CI / Actions secrets)
#   2. VITE_BOT_API_URL / VITE_PANEL_URL  (developer .env, gitignored)
#
# Usage:
#   ./scripts/inject-backend-host.sh
#
# The script edits files **in place**. Both files are gitignored back via
# git update-index --skip-worktree so a developer doesn't accidentally
# commit their host settings — see README for the optional one-time setup.

set -euo pipefail

cd "$(dirname "$0")/.."

# Pick up VITE_* from .env if env vars aren't set explicitly.
if [ -z "${BOT_API_HOST:-}" ] && [ -f .env ]; then
    line=$(grep -E '^VITE_BOT_API_URL=' .env || true)
    if [ -n "$line" ]; then
        url="${line#VITE_BOT_API_URL=}"
        url="${url#https://}"
        url="${url%/}"
        BOT_API_HOST="$url"
    fi
fi
if [ -z "${PANEL_HOST:-}" ] && [ -f .env ]; then
    line=$(grep -E '^VITE_PANEL_URL=' .env || true)
    if [ -n "$line" ]; then
        url="${line#VITE_PANEL_URL=}"
        url="${url#https://}"
        url="${url%/}"
        PANEL_HOST="$url"
    fi
fi
if [ -z "${SUBSCRIPTION_HOST:-}" ] && [ -f .env ]; then
    line=$(grep -E '^VITE_SUBSCRIPTION_URL=' .env || true)
    if [ -n "$line" ]; then
        url="${line#VITE_SUBSCRIPTION_URL=}"
        url="${url#https://}"
        url="${url%/}"
        SUBSCRIPTION_HOST="$url"
    fi
fi

# Fallback hosts — extract just the hostname from the full URL so we can
# whitelist them in capabilities/default.json. CI provides these values as
# environment variables; local builds may read them from .env.
extract_host() {
    local url=$1
    url="${url#https://}"
    url="${url#http://}"
    url="${url%%/*}"
    url="${url%%\?*}"
    echo "$url"
}
fallback_host_from_url() {
    local env_var=$1 dotenv_key=$2
    local raw="${!env_var:-}"
    if [ -z "$raw" ] && [ -f .env ]; then
        local line
        line=$(grep -E "^${dotenv_key}=" .env || true)
        [ -n "$line" ] && raw="${line#${dotenv_key}=}"
    fi
    if [ -n "$raw" ]; then
        extract_host "$raw"
    fi
    return 0
}

FALLBACK_BOT_HOST="${FALLBACK_BOT_HOST:-$(fallback_host_from_url VITE_FALLBACK_BOT_DOMAIN VITE_FALLBACK_BOT_DOMAIN)}"
FALLBACK_SUBS_HOST="${FALLBACK_SUBS_HOST:-$(fallback_host_from_url VITE_FALLBACK_SUBS_DOMAIN VITE_FALLBACK_SUBS_DOMAIN)}"
# RFC 2606 reserved TLD — guaranteed never to resolve in DNS, so an
# unconfigured fallback can't accidentally match someone else's host.
: "${FALLBACK_BOT_HOST:=example.invalid}"
: "${FALLBACK_SUBS_HOST:=example.invalid}"
: "${SUBSCRIPTION_HOST:=example.invalid}"

if [ -z "${BOT_API_HOST:-}" ] || [ -z "${PANEL_HOST:-}" ]; then
    # Hosts unavailable. If the working tree already has real hosts
    # injected (from an earlier CI step), leave it alone — `tauri build`
    # invokes us a second time via `beforeBuildCommand` and at that point
    # the env vars aren't propagated through the tauri-cli child process.
    # Detect "already injected" by checking the placeholder is gone.
    if ! grep -q "__BOT_API_HOST__" src-tauri/tauri.conf.json 2>/dev/null \
       && ! grep -q "__PANEL_HOST__" src-tauri/tauri.conf.json 2>/dev/null; then
        echo "✓ hosts already injected (skipping)"
        exit 0
    fi
    echo "ERROR: BOT_API_HOST and PANEL_HOST must be set (env or .env)" >&2
    echo "  current: BOT_API_HOST=${BOT_API_HOST:-<unset>} PANEL_HOST=${PANEL_HOST:-<unset>}" >&2
    exit 1
fi

# Tauri's `tauri build` regenerates the schemas dir from capabilities/, so
# editing capabilities/default.json is enough — the gen/schemas tree is
# gitignored anyway.
#
# We also have to handle the **idempotent** case: a previous run may have
# already replaced the placeholder, so a fresh sed wouldn't find it. To
# stay re-runnable we first restore the placeholder if a known production
# host is currently sitting where the placeholder belongs, then sed in the
# real host. This is a workaround for the lack of true variable-substitution
# in tauri.conf.json — see https://github.com/tauri-apps/tauri/issues/4818.
restore_placeholder() {
    local file=$1 placeholder=$2 host_var=$3
    # If placeholder is already there, leave the file alone.
    if grep -q "$placeholder" "$file"; then
        return 0
    fi
    # Otherwise the file currently has SOME real host in that slot from a
    # previous run. We can't know which, so we read the same value from the
    # most recent .env we ran with — but rather than try to track that, we
    # just trust the caller to pass the same BOT_API_HOST/PANEL_HOST and
    # restore the placeholder for those exact values before re-injecting.
    sed -i.bak "s|${!host_var}|$placeholder|g" "$file"
    rm -f "${file}.bak"
}

# Step 1: restore placeholders for *previous* hosts (best-effort idempotence).
restore_placeholder src-tauri/tauri.conf.json __BOT_API_HOST__ BOT_API_HOST
restore_placeholder src-tauri/tauri.conf.json __PANEL_HOST__   PANEL_HOST
restore_placeholder src-tauri/capabilities/default.json __BOT_API_HOST__ BOT_API_HOST
restore_placeholder src-tauri/capabilities/default.json __PANEL_HOST__   PANEL_HOST
restore_placeholder src-tauri/capabilities/default.json __FALLBACK_BOT_HOST__ FALLBACK_BOT_HOST
restore_placeholder src-tauri/capabilities/default.json __FALLBACK_SUBS_HOST__ FALLBACK_SUBS_HOST
restore_placeholder src-tauri/capabilities/default.json __SUBSCRIPTION_HOST__ SUBSCRIPTION_HOST

# Step 2: inject real hosts.
sed -i.bak \
    -e "s|__BOT_API_HOST__|${BOT_API_HOST}|g" \
    -e "s|__PANEL_HOST__|${PANEL_HOST}|g" \
    src-tauri/tauri.conf.json \
    src-tauri/capabilities/default.json

sed -i.bak \
    -e "s|__FALLBACK_BOT_HOST__|${FALLBACK_BOT_HOST}|g" \
    -e "s|__FALLBACK_SUBS_HOST__|${FALLBACK_SUBS_HOST}|g" \
    -e "s|__SUBSCRIPTION_HOST__|${SUBSCRIPTION_HOST}|g" \
    src-tauri/capabilities/default.json

rm -f src-tauri/tauri.conf.json.bak src-tauri/capabilities/default.json.bak

echo "Injected configured HTTP host allowlist."
