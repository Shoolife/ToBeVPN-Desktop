#!/bin/bash
# The macOS .dmg: ToBeVPN, a link to Applications and "Удалить ToBeVPN"
# (scripts/macos-uninstaller.applescript), which removes the root network
# helper the app installs with the administrator password, the app and its
# data. Tauri's own .dmg cannot hold an extra item, so it is built here.
# Usage: scripts/macos-dmg.sh <ToBeVPN.app> <output.dmg>
set -euo pipefail
APP="$1"
OUT="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp -R "$APP" "$STAGE/ToBeVPN.app"
ln -s /Applications "$STAGE/Applications"
osacompile -o "$STAGE/Удалить ToBeVPN.app" "$HERE/macos-uninstaller.applescript"
# The app's icon on the uninstaller, so it is recognisable in the window.
cp "$APP/Contents/Resources/icon.icns" "$STAGE/Удалить ToBeVPN.app/Contents/Resources/applet.icns"
# Ad hoc signature: an unsigned applet does not start on Apple Silicon.
codesign --force --sign - "$STAGE/Удалить ToBeVPN.app"

rm -f "$OUT"
hdiutil create -volname ToBeVPN -srcfolder "$STAGE" -ov -format UDZO "$OUT" >/dev/null
echo "$OUT"
