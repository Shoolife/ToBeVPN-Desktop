#!/bin/sh
set -e

case "$1" in
  configure)
    chmod 755 /usr/local/bin/tobevpn-helper.sh 2>/dev/null || true
    chmod 755 /usr/local/bin/tobevpn-update-helper.sh 2>/dev/null || true
    chmod 644 /usr/share/polkit-1/actions/app.tobevpn.network.policy 2>/dev/null || true
    chmod 644 /usr/share/polkit-1/actions/app.tobevpn.update.policy 2>/dev/null || true

    # Sidecar binaries must be root-owned and not world-writable so the
    # privileged helper accepts them. Without these chown/chmod calls a
    # tampered sidecar dropped into /usr/lib/tobevpn-desktop/ by another
    # user would be silently picked up — turning C1's allowlist into a
    # paper tiger. Locate the install dir tolerantly because Tauri/NSIS
    # may name the dir differently across versions.
    for d in \
        /usr/lib/tobevpn-desktop \
        /usr/lib/ToBeVPN \
        /usr/lib/tobevpn ; do
        [ -d "$d" ] || continue
        find "$d" -type f \( -name "xray*" -o -name "tun2socks*" \) \
            -exec chown root:root {} \; \
            -exec chmod 755 {} \; 2>/dev/null || true
    done
    ;;
esac

exit 0
