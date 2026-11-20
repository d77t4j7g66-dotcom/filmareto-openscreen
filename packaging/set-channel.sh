#!/usr/bin/env bash
# Switches the app identity between the two channels: `stable` is what Nektarios gets through
# Check for Updates, `beta` installs beside it for our own work. Usage: set-channel.sh stable|beta
set -euo pipefail
cd "$(dirname "$0")/.."
CHANNEL="${1:?stable or beta}"
FILES=(electron-builder.json5 package.json electron/about.ts electron/file-update.ts
  packaging/dev-install.sh packaging/make-pkg.sh
  scripts/build-teleprompter-helper.sh electron/native/teleprompter/Info.plist)
perl -pi -e 's/Filmareto OpenScreen Beta/Filmareto OpenScreen/g; s/com\.filmareto\.openscreen\.beta/com.filmareto.openscreen/g; s/Filmareto-OpenScreen-Beta-/Filmareto-OpenScreen-/g' "${FILES[@]}"
if [ "$CHANNEL" = beta ]; then
  # Only the lines that name this copy of the app. The usage strings and the helper's id follow.
  perl -pi -e 's/Filmareto OpenScreen/Filmareto OpenScreen Beta/g; s/com\.filmareto\.openscreen/com.filmareto.openscreen.beta/g; s/Filmareto-OpenScreen-\$\{version\}/Filmareto-OpenScreen-Beta-\${version}/g' "${FILES[@]}"
fi
grep -m1 '"productName"' package.json
