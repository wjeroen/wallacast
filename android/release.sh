#!/usr/bin/env bash
# Builds both apps and puts them on the GitHub release "android-latest", with versions.json,
# which the watch app's Update button reads. Needs the GitHub CLI (gh), logged in with write
# access to the repository, and everything build.sh needs.
#
# Usage: android/release.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TAG="android-latest"
bash "$HERE/build.sh"
CODE="$(git -C "$HERE" rev-list --count HEAD)"
printf '{"watch": %s, "player_link": %s}\n' "$CODE" "$CODE" > "$HERE/build/versions.json"

if ! gh release view "$TAG" >/dev/null 2>&1; then
  gh release create "$TAG" --prerelease --title "Android apps (latest)" \
    --notes "The Wallacast watch app and Player Link, built from the newest commit. Install and setup: android/README.md."
fi
gh release upload "$TAG" --clobber \
  "$HERE/build/wallacast-watch.apk" "$HERE/build/player-link.apk" "$HERE/build/versions.json"
echo "Released version $CODE"
