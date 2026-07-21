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
# When the system Node is missing or too old we provision this pinned LTS privately (see ensure_node).
# v22.14.0 is a Node 22 "Jod" LTS release. Override with NODETERM_NODE_VERSION for a different pin.
NODE_LTS_VERSION="${NODETERM_NODE_VERSION:-v22.14.0}"
NODE_DIST_BASE="${NODETERM_NODE_DIST_BASE:-https://nodejs.org/dist}"

# ---- pretty output ---------------------------------------------------------------------------
info() { printf '\033[36m→\033[0m %s\n' "$1"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '\033[33m⚠\033[0m %s\n' "$1" >&2; }
fail() { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# ---- preflight: OS + required tools ----------------------------------------------------------
[ "$(uname -s)" = "Linux" ] || fail "The headless host targets Linux (systemd). For macOS run the desktop app; for containers use the Dockerfile (see docs/SERVER.md)."

command -v git >/dev/null 2>&1 || fail "git is not installed. Install it first (e.g. 'sudo apt install git' or 'sudo dnf install git')."

# ---- Node.js: use a good-enough system install, else provision a private one --------------------
# Sets NODE_BIN (absolute — used by npm ci, the node-pty rebuild, and the systemd ExecStart) and,
# when it provisions, prepends its bin to PATH so `node`/`npm`/`npx`/build scripts all use it. This
# is what makes the one-tap iOS install flow work on a host whose system Node is missing or < 20.
ensure_node() {
  # 1. A good-enough system Node (>= MIN_NODE_MAJOR, with npm)? Use it unchanged — today's behavior.
  if command -v node >/dev/null 2>&1; then
    local sys_node sys_major
    sys_node="$(command -v node)"
    sys_major="$("$sys_node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$sys_major" -ge "$MIN_NODE_MAJOR" ] && command -v npm >/dev/null 2>&1; then
      NODE_BIN="$sys_node"
      ok "Using system Node.js $("$NODE_BIN" -v)"
      return
    fi
    if [ "$sys_major" -ge "$MIN_NODE_MAJOR" ]; then
      warn "System Node.js $("$sys_node" -v) found but npm is missing — provisioning a private Node runtime instead."
    else
      info "System Node.js $("$sys_node" -v) is older than v${MIN_NODE_MAJOR} — provisioning Node ${NODE_LTS_VERSION} privately (no system changes)."
    fi
  else
    info "Node.js not found — provisioning Node ${NODE_LTS_VERSION} privately (no system changes)."
  fi

  # 2. Provision the pinned Node LTS under the app dir. Map uname → nodejs.org dist naming.
  local os arch runtime_dir node_bin
  case "$(uname -s)" in
    Linux)  os="linux" ;;
    Darwin) os="darwin" ;;
    *) fail "Automatic Node provisioning supports Linux and macOS only (found $(uname -s)). Install Node.js >= ${MIN_NODE_MAJOR} manually and re-run." ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) fail "Automatic Node provisioning supports x64 and arm64 only (found $(uname -m)). Install Node.js >= ${MIN_NODE_MAJOR} manually and re-run." ;;
  esac

  # The official tarballs are glibc-linked; musl (Alpine) can't run them.
  if [ "$os" = "linux" ] && { [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; }; then
    fail "This host uses musl libc (e.g. Alpine); the official Node.js binaries need glibc. Install Node.js >= ${MIN_NODE_MAJOR} via your package manager (e.g. 'apk add nodejs npm') and re-run."
  fi

  runtime_dir="$APP_DIR/runtime/node"
  node_bin="$runtime_dir/bin/node"

  # Idempotent: reuse an existing extract only when it is exactly the pinned version.
  if [ -x "$node_bin" ] && [ "$("$node_bin" -v 2>/dev/null)" = "$NODE_LTS_VERSION" ]; then
    ok "Node ${NODE_LTS_VERSION} already provisioned at $runtime_dir"
  else
    local tarname url tmp
    tarname="node-${NODE_LTS_VERSION}-${os}-${arch}"
    url="${NODE_DIST_BASE}/${NODE_LTS_VERSION}/${tarname}.tar.gz"
    rm -rf "$runtime_dir"                 # clear any partial / stale (wrong-version) extract
    mkdir -p "$runtime_dir"
    tmp="$(mktemp -d)"
    info "Downloading Node ${NODE_LTS_VERSION} (${os}-${arch}) from ${url}"
    if ! curl -fsSL "$url" -o "$tmp/node.tar.gz"; then
      rm -rf "$tmp" "$runtime_dir"
      fail "Failed to download Node.js from ${url}. Check the host's network / DNS and re-run."
    fi
    if ! tar -xzf "$tmp/node.tar.gz" -C "$runtime_dir" --strip-components=1; then
      rm -rf "$tmp" "$runtime_dir"
      fail "Failed to extract the Node.js tarball. Ensure 'tar' (with gzip) is installed and re-run."
    fi
    rm -rf "$tmp"
  fi

  # 3. Verify the binary runs before we depend on it, then put it first on PATH so npm/npx/build use it.
  if ! "$node_bin" --version >/dev/null 2>&1; then
    rm -rf "$runtime_dir"
    fail "The provisioned Node.js binary at $node_bin does not run on this host. Install Node.js >= ${MIN_NODE_MAJOR} manually and re-run."
  fi
  NODE_BIN="$node_bin"
  export PATH="$runtime_dir/bin:$PATH"
  ok "Provisioned Node $("$NODE_BIN" -v) at $runtime_dir"
}

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

# ---- Node.js runtime (system if good enough, else provision under $APP_DIR/runtime/node) ------
# Runs AFTER the clone so the runtime lives inside the checkout without tripping the clone's
# "dir already exists" guard; the untracked runtime/ survives `git reset --hard` on later updates.
ensure_node

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
