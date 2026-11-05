#!/usr/bin/env bash
# Signs the built app ad-hoc (there is no Apple Developer ID) and packs it into a DMG with an
# Applications shortcut and the install notes. Run after `npm run build:mac`.
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(node -p "require('./package.json').version")
APP="release/$VER/mac-arm64/Filmareto OpenScreen.app"
OUT="release/Filmareto-OpenScreen-$VER-arm64.dmg"
[ -d "$APP" ] || { echo "No app at $APP: run npm run build:mac first" >&2; exit 1; }

# The builder leaves a linker-only signature that does not cover the bundle: sign it properly.
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/Filmareto OpenScreen.app"
ln -s /Applications "$STAGE/Applications"
cp packaging/INSTALL.txt "$STAGE/INSTALL (διάβασέ με).txt"
rm -f "$OUT"
hdiutil create -volname "Filmareto OpenScreen" -srcfolder "$STAGE" -ov -format UDZO "$OUT" >/dev/null
echo "$OUT"
shasum -a 256 "$OUT"
