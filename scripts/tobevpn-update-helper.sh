#!/bin/sh
# Passwordless polkit entrypoint for Linux .deb updates.
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
    if [ -x "$bin" ]; then
        exec "$bin" --tobevpn-install-latest "$VERSION"
    fi
done

if command -v tobevpn-desktop >/dev/null 2>&1; then
    exec "$(command -v tobevpn-desktop)" --tobevpn-install-latest "$VERSION"
fi

echo "ERROR: installed ToBeVPN binary not found" >&2
exit 127
