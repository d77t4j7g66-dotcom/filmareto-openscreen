#!/usr/bin/env bash
# Publishes the built stable app: a history-free snapshot to the public repo and a GitHub release
# holding the update zip that Check for Updates downloads. Run after set-channel.sh stable, a
# version bump, `npm run build:mac` and `make-pkg.sh`.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=d77t4j7g66-dotcom/filmareto-openscreen
VER=$(node -p "require('./package.json').version")
ZIP="release/Filmareto-OpenScreen-Update-$VER.zip"
PKG="release/Filmareto-OpenScreen-$VER-arm64.pkg"
[ "$(node -p "require('./package.json').productName")" = "Filmareto OpenScreen" ] || { echo "Not the stable channel" >&2; exit 1; }
[ -f "$ZIP" ] && [ -f "$PKG" ] || { echo "Build $VER first" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "Commit first" >&2; exit 1; }
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
git clone -q --depth 1 "https://github.com/$REPO.git" "$WORK/public"
find "$WORK/public" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git archive HEAD | tar -x -C "$WORK/public"
git -C "$WORK/public" add -A
git -C "$WORK/public" -c user.name=Filmareto -c user.email=d77t4j7g66-dotcom@users.noreply.github.com \
  commit -q -m "Filmareto OpenScreen $VER"
git -C "$WORK/public" push -q origin main
gh release create "v$VER" "$ZIP" "$PKG" --repo "$REPO" --target main --title "Filmareto OpenScreen $VER" --notes "Update through Check for Updates, or install the .pkg."
echo "Published v$VER"
