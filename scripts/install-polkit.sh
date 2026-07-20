#!/bin/bash
# One-time installer for the ToBeVPN polkit helpers.
# Installs the fixed, root-owned privilege boundary used by the desktop app.

set -e

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

if [ "$EUID" -ne 0 ]; then
    echo "Need root to install. Re-running with sudo..."
    exec sudo /bin/bash "$SCRIPT_DIR/$(basename -- "$0")"
fi

cd "$SCRIPT_DIR"

install -m 755 tobevpn-helper.sh /usr/local/bin/tobevpn-helper.sh
install -m 755 tobevpn-update-helper.sh /usr/local/bin/tobevpn-update-helper.sh
install -m 644 app.tobevpn.network.policy /usr/share/polkit-1/actions/app.tobevpn.network.policy
install -m 644 app.tobevpn.update.policy /usr/share/polkit-1/actions/app.tobevpn.update.policy

echo "Installed:"
echo "  /usr/local/bin/tobevpn-helper.sh"
echo "  /usr/local/bin/tobevpn-update-helper.sh"
echo "  /usr/share/polkit-1/actions/app.tobevpn.network.policy"
echo "  /usr/share/polkit-1/actions/app.tobevpn.update.policy"
echo ""
echo "ToBeVPN will request cached administrator authorization for privileged operations."
echo "To uninstall: sudo rm /usr/local/bin/tobevpn-helper.sh /usr/local/bin/tobevpn-update-helper.sh /usr/share/polkit-1/actions/app.tobevpn.network.policy /usr/share/polkit-1/actions/app.tobevpn.update.policy"
