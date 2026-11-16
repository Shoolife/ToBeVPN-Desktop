#!/bin/bash
# Lays the Debian package's files out the Arch way into "$pkgdir" (shared by
# the release PKGBUILD and the AUR one, so both install the same files):
#  - Xray and tun2socks under /usr/lib/ToBeVPN/bin, not /usr/bin: Arch has
#    its own xray package, and pacman refuses two packages with one file;
#    the app looks for them there when they are not next to its binary;
#  - the privileged helpers under /usr/lib/ToBeVPN (Arch packages may not
#    use /usr/local), with the polkit policies naming that path;
#  - the desktop entry passing tobevpn:// links through (%u), as the
#    Debian postinst does.
set -euo pipefail

deb_root=$1   # the unpacked data.tar of the .deb
pkgdir=$2
lib="$pkgdir/usr/lib/ToBeVPN"

install -Dm755 "$deb_root/usr/bin/tobevpn-desktop" "$pkgdir/usr/bin/tobevpn-desktop"
install -Dm755 "$deb_root/usr/bin/xray" "$lib/bin/xray"
install -Dm755 "$deb_root/usr/bin/tun2socks" "$lib/bin/tun2socks"
install -Dm644 "$deb_root/usr/lib/ToBeVPN/bin/geoip.dat" "$lib/bin/geoip.dat"
install -Dm644 "$deb_root/usr/lib/ToBeVPN/bin/geosite.dat" "$lib/bin/geosite.dat"

install -Dm755 "$deb_root/usr/local/bin/tobevpn-helper.sh" "$lib/tobevpn-helper.sh"
install -Dm755 "$deb_root/usr/local/bin/tobevpn-update-helper.sh" "$lib/tobevpn-update-helper.sh"
for policy in app.tobevpn.network.policy app.tobevpn.update.policy; do
    install -Dm644 "$deb_root/usr/share/polkit-1/actions/$policy" "$pkgdir/usr/share/polkit-1/actions/$policy"
    sed -i 's#/usr/local/bin/#/usr/lib/ToBeVPN/#g' "$pkgdir/usr/share/polkit-1/actions/$policy"
    grep -q '/usr/lib/ToBeVPN/' "$pkgdir/usr/share/polkit-1/actions/$policy"
done

desktop="$pkgdir/usr/share/applications/ToBeVPN.desktop"
install -Dm644 "$deb_root/usr/share/applications/ToBeVPN.desktop" "$desktop"
sed -i -E '/^Exec=/{s/%[fFU]/%u/g; /%[uU]/! s/[[:space:]]*$/ %u/;}' "$desktop"
cp -a "$deb_root/usr/share/icons" "$pkgdir/usr/share/"
