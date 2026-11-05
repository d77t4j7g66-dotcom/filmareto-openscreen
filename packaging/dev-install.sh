#!/usr/bin/env bash
# Puts the freshly built app into /Applications without the installer, for working on it.
# Run after `npm run build:mac` and `bash packaging/make-pkg.sh` (which signs the app).
#   --fresh   also forget the app's privacy permissions and its permissions screen, as the
#             installer does, so the first launch asks for everything again.
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(node -p "require('./package.json').version")
APP="release/$VER/mac-arm64/Filmareto OpenScreen.app"
DEST="/Applications/Filmareto OpenScreen.app"
ID="com.filmareto.openscreen"
[ -d "$APP" ] || { echo "No app at $APP: build first" >&2; exit 1; }

pkill -x "Filmareto OpenScreen" 2>/dev/null || true
sleep 1
if [ -e "$DEST" ]; then
  # Renaming needs only write access to /Applications, which admins have; deleting an app the
  # installer made as root would not work.
  mv "$DEST" "$HOME/.Trash/Filmareto OpenScreen $(date +%H%M%S).app"
fi
ditto "$APP" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
if [ "${1:-}" = "--fresh" ]; then
  tccutil reset All "$ID" >/dev/null 2>&1 || true
  rm -f "$HOME/Library/Application Support/Filmareto OpenScreen/permissions.json"
fi
codesign -dr - "$DEST" 2>&1 | tail -1
open "$DEST"
