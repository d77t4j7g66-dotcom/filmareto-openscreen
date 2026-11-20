@AGENTS.md

# Filmareto OpenScreen (this fork)

This repo is Filmareto's fork of OpenScreen (MIT, keep the upstream notice). Where this file and
AGENTS.md disagree, this file wins. Upstream's release flow in AGENTS.md (`workflow_dispatch`, RC
branches, `promote.yml`) does not apply here: GitHub Actions are off on both fork repos.

## Remotes and branches

- `origin` = upstream `getopenscreen/openscreen`, fetch only (its push URL is disabled).
- `private` = `d77t4j7g66-dotcom/filmareto-openscreen-private`: full history, every branch. Push work here.
- `public` = `d77t4j7g66-dotcom/filmareto-openscreen`: history-free snapshots of stable releases only.
  Never push a branch to it by hand; only `packaging/publish-release.sh` writes to it.
- `beta` = day-to-day work. A release is cut on `release/<version>`, branched from `beta`.

## Two channels, two apps

- **beta**: "Filmareto OpenScreen Beta", `com.filmareto.openscreen.beta`. Installs beside the stable
  app for our own work and never updates from GitHub. Commits on `beta` stay on this channel.
- **stable**: "Filmareto OpenScreen", `com.filmareto.openscreen`. What other people use. Check for
  Updates reads the latest release of the public repo (`electron/file-update.ts`) and also accepts
  an update zip picked by hand. Copies on 1.0.0 only have the by-hand route.
- `packaging/set-channel.sh stable|beta` switches the identity in every file that names it.

## Cutting a stable release (on the Mac that holds the signing key)

1. From an up-to-date `beta`: `git switch -c release/<version>`.
2. `bash packaging/set-channel.sh stable`, then set `"version"` in package.json, higher than the
   last public release.
3. If anything under `crates/` changed: `(cd crates && cargo clean -p openscreen-compositor)`.
   Then `npm run build:mac`.
4. `bash packaging/make-pkg.sh` writes `release/Filmareto-OpenScreen-<version>-arm64.pkg` and
   `release/Filmareto-OpenScreen-Update-<version>.zip`.
5. Check the signature: `codesign -d -r- "release/<version>/mac-arm64/Filmareto OpenScreen.app"`
   must show the same `certificate leaf = H"…"` as the installed stable app. A different one means
   installed copies refuse the update.
6. Commit ("Version <version>"), tag `filmareto-v<version>`, push branch and tag to `private`.
   Plain `v<version>` tags in `private` are upstream's (`v1.1.0` … `v1.9.2`), so never reuse them
   there. In `public` the release script creates `v<version>`, which is what Check for Updates reads.
7. `bash packaging/publish-release.sh` pushes a snapshot of HEAD to `public` main and creates the
   GitHub release with the zip and the pkg. It refuses on the beta channel, a dirty tree or missing
   files.
8. Check that `https://api.github.com/repos/d77t4j7g66-dotcom/filmareto-openscreen/releases/latest`
   names the new tag and that its zip downloads.
9. On the release branch: `bash packaging/set-channel.sh beta`, commit, push to `private`, then
   merge the release branch into `beta`.

## Rules

- Signing: `make-pkg.sh` signs with "Filmareto Local Signing" from `~/.filmareto-signing/`. Never
  change or regenerate that identity: installed copies accept only updates with the same signature.
  Without that keychain the build falls back to ad-hoc and every update is refused, so releases are
  built on that Mac, never in a cloud session. Cloud sessions can edit code and push to `private`.
- No Apple Developer ID: the pkg is not notarized, so the first open needs right click > Open.
- The public repo is public: ship only finished, tested work, and nothing with personal data,
  footage or keys.
