#!/bin/sh
# Run askpass-e2e.test.ts against the harness sshd, with the ssh CLIENT inside a container.
#
# The suite refuses to run on the host (it drives a real `ssh`, and `ssh` reads the passwd
# database rather than $HOME, so StrictHostKeyChecking=accept-new would append to the real
# ~/.ssh/known_hosts, which is banned here). This script gives it the only environment it accepts:
# a throwaway node container on the same docker network as the sshd container.
#
#   ./run.sh up && ./e2e.sh
#
# The container gets its own node_modules (an anonymous volume shadows the bind-mounted one, whose
# native builds are macOS ABI), installed with --ignore-scripts: nothing here needs node-pty or a
# real Electron binary. The test hardcodes 127.0.0.1:22022, which is the HOST's published port, so
# socat re-creates that address inside the container.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
keys="${NT_SSHDOCKER_WORKDIR:-$here/.work}/clientkeys"
net=nt-ssh-net
server=nodeterm-ssh-test

[ -d "$keys" ] || { echo "no client keys at $keys - run ./run.sh up first" >&2; exit 1; }
docker inspect "$server" >/dev/null 2>&1 || { echo "sshd container $server is not running - ./run.sh up" >&2; exit 1; }
docker network create "$net" >/dev/null 2>&1 || true
docker network connect "$net" "$server" >/dev/null 2>&1 || true

docker run --rm -i --network "$net" \
  -v "$repo":/app \
  -v /app/node_modules \
  -v "$keys":/keys:ro \
  -w /app \
  -e NODETERM_SSH_DOCKER=1 \
  -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
  -e SERVER="$server" \
  -e NT_SSHDOCKER_KEYS=/root/ntkeys \
  node:22-bookworm-slim sh -s <<'INNER'
set -e
apt-get update -qq >/dev/null && apt-get install -y -qq openssh-client socat curl >/dev/null
# The suite reads its keys from $NT_SSHDOCKER_KEYS. They cannot be used straight off the
# bind mount: ssh refuses a private key the calling user does not own ("bad ownership or modes"),
# and the mounted files carry the host uid while this container runs as root.
mkdir -p /root/ntkeys && cp /keys/* /root/ntkeys/ && chmod 600 /root/ntkeys/*
# The suite dials 127.0.0.1:22022 (the host's published port); inside the container that address
# has to be forwarded to the sshd container's port 22.
socat TCP-LISTEN:22022,bind=127.0.0.1,fork,reuseaddr "TCP:$SERVER:22" &
npm ci --ignore-scripts --no-audit --no-fund --silent
# electron/index.js throws on import unless it can resolve a binary path; the suite only imports
# the module for its (unused in Node) `app`/`ipcMain` bindings, so any path satisfies it.
echo electron > node_modules/electron/path.txt
npx vitest run test/ssh-docker/askpass-e2e.test.ts
INNER
