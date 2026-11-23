#!/bin/bash
# Pushes the AUR package tobevpn-desktop-bin (PKGBUILD, .SRCINFO, package.sh,
# tobevpn-desktop.install from the given directory) with AUR_SSH_PRIVATE_KEY.
# Run once the release exists: the PKGBUILD downloads its .deb.
# Usage: scripts/push-aur.sh <dir with the AUR files> <version>
set -euo pipefail
DIR="$1"
VERSION="${2:-${VERSION:?}}"
command -v ssh >/dev/null || { command -v pacman >/dev/null && pacman -S --noconfirm --needed openssh; }
install -dm700 ~/.ssh
printf '%s\n' "$AUR_SSH_PRIVATE_KEY" > ~/.ssh/aur
chmod 600 ~/.ssh/aur
ssh-keyscan -t ed25519 aur.archlinux.org >> ~/.ssh/known_hosts
export GIT_SSH_COMMAND="ssh -i ~/.ssh/aur -o IdentitiesOnly=yes"
rm -rf aur-repo
git clone ssh://aur@aur.archlinux.org/tobevpn-desktop-bin.git aur-repo
cp "$DIR/PKGBUILD" "$DIR/.SRCINFO" "$DIR/package.sh" "$DIR/tobevpn-desktop.install" aur-repo/
cd aur-repo
git config user.name "ToBeVPN release"
git config user.email "noreply@github.com"
git add -A
git diff --cached --quiet || git commit -m "Update to ${VERSION}"
git push origin HEAD:master
