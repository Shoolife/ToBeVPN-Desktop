#!/bin/bash
# One-time installer for the ToBeVPN polkit helper.
# After running this, the desktop app no longer asks for the sudo/pkexec
# password on connect/disconnect.

set -e

cd "$(dirname "$0")"

if [ "$EUID" -ne 0 ]; then
    echo "Need root to install. Re-running with sudo..."
    exec sudo bash "$0"
fi

install -m 755 tobevpn-helper.sh /usr/local/bin/tobevpn-helper.sh
install -m 644 app.tobevpn.network.policy /usr/share/polkit-1/actions/app.tobevpn.network.policy

echo "Installed:"
echo "  /usr/local/bin/tobevpn-helper.sh"
echo "  /usr/share/polkit-1/actions/app.tobevpn.network.policy"
echo ""
echo "ToBeVPN will now start/stop without password prompts."
echo "To uninstall: sudo rm /usr/local/bin/tobevpn-helper.sh /usr/share/polkit-1/actions/app.tobevpn.network.policy"
