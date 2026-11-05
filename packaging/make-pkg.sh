#!/usr/bin/env bash
# Builds a double-click installer (.pkg) and an update file (.zip) from the built app. Run after `npm run build:mac`.
# The pkg is not signed (no Apple Developer ID): the first open needs right click > Open.
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(node -p "require('./package.json').version")
APP="release/$VER/mac-arm64/Filmareto OpenScreen.app"
OUT="release/Filmareto-OpenScreen-$VER-arm64.pkg"
[ -d "$APP" ] || { echo "No app at $APP: run npm run build:mac first" >&2; exit 1; }
# A fixed signature keeps the privacy permissions across builds (an ad-hoc one is a new identity
# every time). The key lives in its own keychain; without it the build falls back to ad-hoc.
SIGN_DIR="$HOME/.filmareto-signing"
if [ -f "$SIGN_DIR/signing.keychain-db" ] && [ -f "$SIGN_DIR/password" ]; then
  KEYCHAIN="$SIGN_DIR/signing.keychain-db"
  security unlock-keychain -p "$(cat "$SIGN_DIR/password")" "$KEYCHAIN"
  IDENTITY=$(security find-identity -p codesigning "$KEYCHAIN" | awk '/Filmareto Local Signing/ {print $2; exit}')
fi
if [ -n "${IDENTITY:-}" ]; then
  codesign --force --deep --keychain "$KEYCHAIN" --sign "$IDENTITY" "$APP"
else
  codesign --force --deep --sign - "$APP"
fi
codesign --verify --deep --strict "$APP"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir "$WORK/root"
ditto "$APP" "$WORK/root/Filmareto OpenScreen.app"
# Do not let the installer move an app it finds elsewhere: always write to /Applications.
pkgbuild --analyze --root "$WORK/root" "$WORK/components.plist" >/dev/null
plutil -replace 0.BundleIsRelocatable -bool NO "$WORK/components.plist"
pkgbuild --root "$WORK/root" --component-plist "$WORK/components.plist" \
  --identifier com.filmareto.openscreen.pkg --version "$VER" \
  --install-location /Applications --scripts packaging/pkg/scripts "$WORK/component.pkg" >/dev/null
sed "s/VERSION/$VER/" packaging/pkg/distribution.xml > "$WORK/distribution.xml"
rm -f "$OUT"
productbuild --distribution "$WORK/distribution.xml" --resources packaging/pkg/resources \
  --package-path "$WORK" "$OUT" >/dev/null
echo "$OUT"
shasum -a 256 "$OUT"

# The same signed app as a zip, for the app's own "check for updates": send this file to somebody
# who has an earlier version and they update from it without the installer or any password.
UPDATE="release/Filmareto-OpenScreen-Update-$VER.zip"
rm -f "$UPDATE"
ditto -c -k --keepParent "$APP" "$UPDATE"
echo "$UPDATE"
