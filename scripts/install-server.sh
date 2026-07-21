#!/usr/bin/env bash
#
# nodeterm headless notification host — one-line installer / updater.
#
#   curl -fsSL https://raw.githubusercontent.com/eneskirca/nodeterm/main/scripts/install-server.sh | bash
#
# Installs (or updates) the nodeterm Server Edition on this Linux host and runs it in HEADLESS
# mode (NODETERM_HEADLESS=1): it boots every core service — the loopback hook server, agent-status
# mirror, usage poll and the granted push senders — but binds NO public HTTP/WS listener, so there
# are ZERO open ports. A phone that SSHes into this host and drops a push grant gets full push /
# Live-Activity coverage for as long as the service runs. See docs/SERVER.md.
#
# Idempotent: re-run it any time to pull the latest code, rebuild, and restart the service.
set -euo pipefail

REPO_URL="${NODETERM_REPO_URL:-https://github.com/eneskirca/nodeterm}"
APP_DIR="${NODETERM_APP_DIR:-$HOME/.nodeterm-server-app}"
SERVICE_NAME="nodeterm-server"
MIN_NODE_MAJOR=20

# ---- pretty output ---------------------------------------------------------------------------
info() { printf '\033[36m→\033[0m %s\n' "$1"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '\033[33m⚠\033[0m %s\n' "$1" >&2; }
fail() { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# ---- preflight: OS + required tools ----------------------------------------------------------
[ "$(uname -s)" = "Linux" ] || fail "The headless host targets Linux (systemd). For macOS run the desktop app; for containers use the Dockerfile (see docs/SERVER.md)."

command -v git >/dev/null 2>&1 || fail "git is not installed. Install it first (e.g. 'sudo apt install git' or 'sudo dnf install git')."

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is not installed. Install Node.js >= ${MIN_NODE_MAJOR} (https://nodejs.org or your distro / nvm) and re-run."
fi
NODE_BIN="$(command -v node)"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  fail "Node.js >= ${MIN_NODE_MAJOR} is required, found $("$NODE_BIN" -v). Upgrade Node and re-run."
fi

command -v npm >/dev/null 2>&1 || fail "npm is not installed (it normally ships with Node.js). Install npm and re-run."

# node-pty is a native module and is (re)built from source against Node's ABI, which needs a C/C++
# toolchain + python3. Missing tools → warn with the install one-liner, but don't hard-fail: if a
# prebuilt binary is available the build still succeeds.
MISSING_BUILD=""
for tool in make gcc python3; do
  command -v "$tool" >/dev/null 2>&1 || MISSING_BUILD="$MISSING_BUILD $tool"
done
if [ -n "$MISSING_BUILD" ]; then
  warn "Missing build tools for the node-pty native module:$MISSING_BUILD"
  warn "  Debian/Ubuntu:  sudo apt install -y build-essential python3"
  warn "  Fedora/RHEL:    sudo dnf install -y make gcc gcc-c++ python3"
  warn "Continuing — install them and re-run this script if the build below fails."
fi

# tmux is what makes terminal sessions survive restarts; the server falls back to a plain shell
# without it. Not fatal for a notification host, but worth flagging.
command -v tmux >/dev/null 2>&1 || warn "tmux is not installed — terminal sessions won't survive restarts (install 'tmux' for continuity)."

# ---- clone or update -------------------------------------------------------------------------
if [ -d "$APP_DIR/.git" ]; then
  info "Updating existing checkout in $APP_DIR"
  git -C "$APP_DIR" fetch --depth 1 origin main
  git -C "$APP_DIR" reset --hard origin/main
else
  [ -e "$APP_DIR" ] && fail "$APP_DIR exists but is not a git checkout. Remove it and re-run, or set NODETERM_APP_DIR."
  info "Cloning $REPO_URL into $APP_DIR"
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"

# ---- install deps + build --------------------------------------------------------------------
# The repo's postinstall runs electron-rebuild (targets ELECTRON's ABI). The server runs under
# plain Node, so we --ignore-scripts and rebuild node-pty against Node's own ABI afterwards. Same
# trap the Dockerfile documents — see docs/SERVER.md.
info "Installing dependencies (npm ci --ignore-scripts)…"
npm ci --ignore-scripts

info "Building renderer + server bundle…"
npm run build
npm run server:build

info "Rebuilding node-pty against Node's ABI…"
npm rebuild node-pty

[ -f "$APP_DIR/out/server/main.cjs" ] || fail "Build did not produce out/server/main.cjs — check the output above."

# ---- install + (re)start the systemd service -------------------------------------------------
UNIT_DESC="nodeterm headless notification host"

write_unit() {
  # $1 = target unit path
  cat > "$1" <<UNIT
[Unit]
Description=$UNIT_DESC
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=NODETERM_HEADLESS=1
ExecStart=$NODE_BIN $APP_DIR/out/server/main.cjs
Restart=on-failure
RestartSec=5
# Logs go to journald (journalctl); StandardOutput/Error default to journal.

[Install]
WantedBy=$2
UNIT
}

if [ "$(id -u)" = "0" ]; then
  # Root install: system-wide unit.
  UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
  info "Installing system service at $UNIT_PATH"
  write_unit "$UNIT_PATH" "multi-user.target"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
  ok "Service installed and (re)started."
  echo
  systemctl --no-pager status "$SERVICE_NAME" || true
  echo
  info "Logs:   journalctl -u $SERVICE_NAME -f"
  info "Update: re-run this script."
else
  # Non-root install: per-user unit + linger so it runs without an active login session.
  command -v systemctl >/dev/null 2>&1 || fail "systemctl not found — a systemd host is required for the service. (You can still run it manually: NODETERM_HEADLESS=1 node $APP_DIR/out/server/main.cjs)"
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT_PATH="$UNIT_DIR/${SERVICE_NAME}.service"
  info "Installing user service at $UNIT_PATH"
  mkdir -p "$UNIT_DIR"
  write_unit "$UNIT_PATH" "default.target"
  # enable-linger keeps the user manager (and the service) alive across logout / reboot.
  loginctl enable-linger "$(id -un)" 2>/dev/null || warn "Could not enable linger — the service may stop when you log out."
  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME"
  systemctl --user restart "$SERVICE_NAME"
  ok "Service installed and (re)started."
  echo
  systemctl --user --no-pager status "$SERVICE_NAME" || true
  echo
  info "Logs:   journalctl --user -u $SERVICE_NAME -f"
  info "Update: re-run this script."
fi

echo
ok "nodeterm headless notification host is running (NODETERM_HEADLESS=1 — zero open ports)."
