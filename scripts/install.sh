#!/bin/sh
# nodeterm installer — one-liner for the landing page:
#   curl -fsSL https://nodeterm.dev/install.sh | sh
#
# Downloads the latest signed + notarized release for this Mac's architecture via the
# nodeterm.dev download proxy (which 302s to GitHub's signed CDN — works even while the repo is
# private), mounts the DMG, and installs nodeterm.app into /Applications. macOS only; no sudo.
set -eu

BASE="${NODETERM_BASE:-https://nodeterm.dev}"
APP="nodeterm.app"
DEST="/Applications"

fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "nodeterm is macOS-only."
command -v curl >/dev/null 2>&1 || fail "curl is required."

# Apple Silicon → arm64, Intel → x64. The proxy maps ?arch=… to the matching DMG.
case "$(uname -m)" in
  arm64)  arch="arm64" ;;
  x86_64) arch="x64" ;;
  *)      fail "Unsupported architecture: $(uname -m)" ;;
esac

tmp="$(mktemp -d)"
mnt=""
cleanup() {
  [ -n "$mnt" ] && hdiutil detach "$mnt" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

printf '→ Downloading nodeterm (%s)…\n' "$arch"
curl -fSL --progress-bar "$BASE/download?arch=$arch" -o "$tmp/nodeterm.dmg" || fail "Download failed."

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
