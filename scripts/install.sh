#!/bin/sh
# nodeterm installer — one-liner for the landing page:
#   curl -fsSL https://nodeterm.dev/install.sh | sh
#
# Downloads the latest signed + notarized release for this Mac's architecture, mounts the DMG,
# and installs nodeterm.app into /Applications. macOS only. No sudo needed for /Applications.
set -eu

REPO="eneskirca/nodeterm"
APP="nodeterm.app"
DEST="/Applications"
API="https://api.github.com/repos/$REPO/releases/latest"

fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "nodeterm is macOS-only."
command -v curl >/dev/null 2>&1 || fail "curl is required."

printf '→ Finding the latest nodeterm release…\n'
# All .dmg download URLs in the latest release (skips .blockmap and .zip).
dmgs="$(curl -fsSL "$API" \
  | grep -o '"browser_download_url": *"[^"]*\.dmg"' \
  | sed 's/.*"browser_download_url": *"//; s/"$//')"
[ -n "$dmgs" ] || fail "No .dmg found in the latest release (is the repo/release public?)."

# Apple Silicon → the -arm64 DMG; Intel → the plain (non-arm64) DMG.
case "$(uname -m)" in
  arm64)  url="$(printf '%s\n' "$dmgs" | grep arm64      | head -1)" ;;
  x86_64) url="$(printf '%s\n' "$dmgs" | grep -v arm64   | head -1)" ;;
  *)      fail "Unsupported architecture: $(uname -m)" ;;
esac
[ -n "${url:-}" ] || fail "No DMG matching this Mac's architecture."

tmp="$(mktemp -d)"
mnt=""
cleanup() {
  [ -n "$mnt" ] && hdiutil detach "$mnt" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

printf '→ Downloading %s\n' "$(basename "$url")"
curl -fSL --progress-bar "$url" -o "$tmp/nodeterm.dmg" || fail "Download failed."

printf '→ Mounting…\n'
# hdiutil output is TAB-separated; the mount point is the last field. Read it that way so a
# volume name with spaces (electron-builder names the volume "nodeterm <version>") stays intact.
mnt="$(hdiutil attach -nobrowse "$tmp/nodeterm.dmg" | awk -F'\t' '/\/Volumes\// { print $NF }' | head -1)"
[ -n "$mnt" ] && [ -d "$mnt/$APP" ] || fail "Could not mount the DMG."

printf '→ Installing to %s/%s…\n' "$DEST" "$APP"
rm -rf "${DEST:?}/$APP"
cp -R "$mnt/$APP" "$DEST/" || fail "Copy to $DEST failed."

# The app is signed + notarized; clearing the download quarantine skips even the one-time
# "downloaded from the internet" prompt so it opens straight away.
xattr -dr com.apple.quarantine "$DEST/$APP" 2>/dev/null || true

printf '\033[32m✓ nodeterm installed.\033[0m Launch it from Applications, or run: open -a nodeterm\n'
