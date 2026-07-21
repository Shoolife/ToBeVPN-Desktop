#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)

if [ "$#" -eq 0 ]; then
    echo "usage: $0 command [args...]" >&2
    exit 64
fi

node "$SCRIPT_DIR/backend-hosts.mjs" inject
restored=0
restore_hosts() {
    if [ "$restored" -eq 0 ]; then
        restored=1
        node "$SCRIPT_DIR/backend-hosts.mjs" restore
    fi
}
trap restore_hosts EXIT HUP INT TERM

"$@"
