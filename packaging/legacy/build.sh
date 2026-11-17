#!/bin/bash
# The ToBeVPN .deb for older systems: WebKitGTK only with API 4.0 (libsoup2)
# and glibc 2.28, as on Astra Linux 1.7. The regular .deb needs API 4.1 and
# a newer glibc there.
#
# Everything but the app binary is the regular release .deb's (Xray,
# tun2socks, the routing data, helpers, polkit policies, icons), so this
# rebuilds only the binary, on the old system itself, and repacks that .deb:
#
#   packaging/legacy/build.sh ToBeVPN_1.2.3_amd64.deb [out dir]
#
# Run it from a checkout of the same release whose dist/ holds that
# release's frontend (npm run build with the release's VITE_* values).
#
# Tauri's WebKitGTK bindings link API 4.1 and libsoup 3. The API is the same
# in 4.0 but for libsoup's own types, which the app does not use, so for
# this build the three -sys crates are local copies that link the 4.0
# libraries instead ([patch] in a temporary .cargo/config.toml).
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DEB=$(realpath "${1:?usage: $0 <regular .deb> [out dir]}")
OUT=$(realpath -m "${2:-$ROOT/src-tauri/target/legacy}")
VERSION=$(dpkg-deb -f "$DEB" Version)
NAME="ToBeVPN_${VERSION}_amd64_legacy.deb"

[ -f "$ROOT/dist/index.html" ] || { echo "dist/ is missing: build the frontend first (npm run build)" >&2; exit 1; }
grep -q "^version = \"$VERSION\"" "$ROOT/src-tauri/Cargo.toml" \
    || { echo "the checkout is not version $VERSION" >&2; exit 1; }

cd "$ROOT/src-tauri"
[ ! -e .cargo/config.toml ] || { echo "src-tauri/.cargo/config.toml exists: refusing to replace it" >&2; exit 1; }
cargo fetch --locked

SYS="$ROOT/src-tauri/target/legacy-sys"
rm -rf "$SYS"
mkdir -p "$SYS"
cargo metadata --format-version 1 --locked | python3 -c '
import json, os, re, shutil, sys
dest = sys.argv[1]
# crate -> (pkg-config name of API 4.1/libsoup 3, its 4.0/libsoup 2 one, version floor or None)
swap = {
    "webkit2gtk-sys": ("webkit2gtk-4.1", "webkit2gtk-4.0", None),
    "javascriptcore-rs-sys": ("javascriptcoregtk-4.1", "javascriptcoregtk-4.0", None),
    "soup3-sys": ("libsoup-3.0", "libsoup-2.4", "2.62"),
}
# library names in #[link(name = ...)] -> their 4.0 / libsoup 2 ones
links = {
    "webkit2gtk-4.1": "webkit2gtk-4.0",
    "javascriptcoregtk-4.1": "javascriptcoregtk-4.0",
    "soup-3.0": "soup-2.4",
}
found = set()
for pkg in json.load(sys.stdin)["packages"]:
    if pkg["name"] not in swap or not (pkg.get("source") or "").startswith("registry+"):
        continue
    old, new, floor = swap[pkg["name"]]
    src = os.path.dirname(pkg["manifest_path"])
    dst = os.path.join(dest, pkg["name"])
    shutil.copytree(src, dst)
    path = os.path.join(dst, "Cargo.toml")
    out, in_deps = [], False
    for line in open(path).read().splitlines():
        if line.startswith("["):
            in_deps = line.startswith("[package.metadata.system-deps")
        if in_deps:
            line = line.replace("\"%s\"" % old, "\"%s\"" % new)
            if floor and re.match(r"^version = \"", line):
                line = "version = \"%s\"" % floor
        out.append(line)
    open(path, "w").write("\n".join(out) + "\n")
    # The bindings name the libraries in #[link] attributes too.
    lib = os.path.join(dst, "src", "lib.rs")
    text = open(lib).read()
    for a, b in links.items():
        text = text.replace("#[link(name = \"%s\")]" % a, "#[link(name = \"%s\")]" % b)
    open(lib, "w").write(text)
    found.add(pkg["name"])
missing = set(swap) - found
if missing:
    sys.exit("not in the dependency tree: %s" % ", ".join(sorted(missing)))
' "$SYS"
if grep -rnE 'link\(name = "(webkit2gtk-4\.1|javascriptcoregtk-4\.1|soup-3\.0)"' "$SYS"/*/src; then
    echo "a 4.1 / libsoup 3 library is still named in the bindings: update this script" >&2
    exit 1
fi

mkdir -p .cargo
cp Cargo.lock "$SYS/Cargo.lock.orig"
cleanup() {
    cp "$SYS/Cargo.lock.orig" Cargo.lock
    rm -f .cargo/config.toml
    rmdir .cargo 2>/dev/null || true
}
trap cleanup EXIT
cat > .cargo/config.toml <<EOF
[patch.crates-io]
webkit2gtk-sys = { path = "$SYS/webkit2gtk-sys" }
javascriptcore-rs-sys = { path = "$SYS/javascriptcore-rs-sys" }
soup3-sys = { path = "$SYS/soup3-sys" }
EOF
# soup3 builds glib-rs for GLib 2.70, the old systems have 2.58: no
# pkg-config version check for GLib itself. The few newer GLib functions
# glib-rs then calls are provided by src/legacy_webkit.rs; any other one
# fails to link right here.
for dep in GLIB_2_0:glib-2.0 GOBJECT_2_0:gobject-2.0 GIO_2_0:gio-2.0; do
    export "SYSTEM_DEPS_${dep%%:*}_NO_PKG_CONFIG=1" "SYSTEM_DEPS_${dep%%:*}_LIB=${dep#*:}"
done
# tauri/custom-protocol is what the Tauri CLI adds for a release: the app
# then serves the bundled dist/ instead of the dev server's address.
# The updater checks this build's own manifest: it learns of a release only
# once the release has its legacy .deb (made after the regular one).
LEGACY_MANIFEST=https://github.com/Shoolife/ToBeVPN-Desktop/releases/latest/download/latest-legacy.json
export TAURI_CONFIG="{\"plugins\":{\"updater\":{\"endpoints\":[\"$LEGACY_MANIFEST\"]}}}"
cargo build --release --features webkit-4-0,tauri/custom-protocol
BIN="$ROOT/src-tauri/target/release/tobevpn-desktop"

# Nothing newer than the system's glibc, and the 4.0 libraries linked.
NEEDED=$(objdump -p "$BIN" | awk '/NEEDED/{print $2}')
echo "$NEEDED" | grep -q '^libwebkit2gtk-4\.0\.so' || { echo "not linked against WebKitGTK 4.0" >&2; exit 1; }
if echo "$NEEDED" | grep -qE '^libwebkit2gtk-4\.1|^libsoup-3'; then
    echo "still linked against WebKitGTK 4.1 / libsoup 3" >&2
    exit 1
fi
GLIBC=$(objdump -T "$BIN" | grep -oE 'GLIBC_[0-9.]+' | sort -uV | tail -1)
echo "highest glibc symbol: $GLIBC"

WORK=$(mktemp -d)
trap 'cleanup; rm -rf "$WORK"' EXIT
dpkg-deb -R "$DEB" "$WORK/pkg"
install -m 755 "$BIN" "$WORK/pkg/usr/bin/tobevpn-desktop"
sed -i 's/libwebkit2gtk-4\.1-0/libwebkit2gtk-4.0-37/' "$WORK/pkg/DEBIAN/control"
grep -q 'libwebkit2gtk-4.0-37' "$WORK/pkg/DEBIAN/control" || { echo "no WebKitGTK dependency to replace" >&2; exit 1; }
(cd "$WORK/pkg" && find . -path ./DEBIAN -prune -o -type f -printf '%P\0' | xargs -0 md5sum > DEBIAN/md5sums)
mkdir -p "$OUT"
dpkg-deb --root-owner-group -Zxz -b "$WORK/pkg" "$OUT/$NAME" >/dev/null
echo "$OUT/$NAME"
