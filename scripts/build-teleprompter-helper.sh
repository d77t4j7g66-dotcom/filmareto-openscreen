#!/usr/bin/env bash
# Builds the teleprompter helper into electron/native/bin. It re-launches itself with macOS
# "responsibility" disclaimed, and macOS will not start a disclaimed process that only carries the
# linker's ad-hoc signature, so it is signed for real here (local identity when present).
set -euo pipefail
cd "$(dirname "$0")/.."
PKG=electron/native/teleprompter
swift build --package-path "$PKG" -c release
BIN=electron/native/bin/darwin-arm64/filmareto-teleprompter
cp "$PKG/.build/release/filmareto-native" "$BIN"
ID=com.filmareto.openscreen.teleprompter
SIGN_DIR="$HOME/.filmareto-signing"
if [ -f "$SIGN_DIR/signing.keychain-db" ] && [ -f "$SIGN_DIR/password" ]; then
  KEYCHAIN="$SIGN_DIR/signing.keychain-db"
  security unlock-keychain -p "$(cat "$SIGN_DIR/password")" "$KEYCHAIN"
  IDENTITY=$(security find-identity -p codesigning "$KEYCHAIN" | awk '/Filmareto Local Signing/ {print $2; exit}')
  codesign --force --keychain "$KEYCHAIN" --sign "$IDENTITY" --identifier "$ID" "$BIN"
else
  codesign --force --sign - --identifier "$ID" "$BIN"
fi
echo "$BIN"
