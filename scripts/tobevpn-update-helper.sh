#!/bin/sh
# Polkit entrypoint for signed Linux .deb updates.
#
# SECURITY: this script intentionally does not install a caller-provided
# package path. It delegates to the installed ToBeVPN binary in a special
# root-only CLI mode; that mode fetches the fixed updater manifest, verifies
# the package minisign signature, checks the package name, and only then runs
# dpkg.

set -e

if [ "$#" -ne 2 ] || [ "$1" != "install-latest" ]; then
    echo "ERROR: usage: $0 install-latest <version>" >&2
    exit 2
fi

VERSION="$2"
if [ "${#VERSION}" -gt 64 ]; then
    echo "ERROR: version is too long" >&2
    exit 2
fi
case "$VERSION" in
    ""|*[!0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._+-]*)
        echo "ERROR: invalid version: $VERSION" >&2
        exit 2
        ;;
esac

for bin in \
    /usr/bin/tobevpn-desktop \
    /usr/bin/ToBeVPN \
    /usr/bin/tobevpn ; do
    if [ -f "$bin" ] && [ -x "$bin" ] && [ ! -L "$bin" ]; then
        owner=$(/usr/bin/stat -c '%u' "$bin" 2>/dev/null || echo '?')
        mode=$(/usr/bin/stat -c '%a' "$bin" 2>/dev/null || echo '?')
        case "$mode" in
            ???|????) ;;
            *) continue ;;
        esac
        permissions=$((0$mode))
        if [ "$owner" = "0" ] \
            && [ $((permissions & 022)) -eq 0 ]; then
            exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=/root \
                "$bin" --tobevpn-install-latest "$VERSION"
        fi
    fi
done

echo "ERROR: trusted installed ToBeVPN binary not found" >&2
exit 127
