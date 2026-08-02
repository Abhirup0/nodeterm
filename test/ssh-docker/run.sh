#!/bin/bash
# Generate the test harness's keys/host keys into the outer scratch dir and start (or stop) the
# container. Nothing this script writes is committed - see .gitignore in this directory.
#
# Usage:
#   ./run.sh up      build the image, generate keys if missing, start the container (default)
#   ./run.sh down     stop and remove the container (keeps the built image and generated keys)
#   ./run.sh clean     full teardown: stop+remove the container, remove the image, delete all
#              generated keys (next 'up' rebuilds and regenerates everything)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Everything generated (keys, host keys, known_hosts) goes here - gitignored, override with
# NT_SSHDOCKER_WORKDIR to keep it outside the repo entirely.
WORKDIR="${NT_SSHDOCKER_WORKDIR:-$HERE/.work}"
IMAGE="nodeterm-ssh-test"
CONTAINER="nodeterm-ssh-test"
HOST_PORT=22022

cmd="${1:-up}"

do_down() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 && echo "removed container $CONTAINER" || echo "no running container to remove"
}

if [ "$cmd" = "down" ]; then
  do_down
  exit 0
fi

if [ "$cmd" = "clean" ]; then
  do_down
  docker rmi -f "$IMAGE" >/dev/null 2>&1 && echo "removed image $IMAGE" || echo "no image to remove"
  rm -rf "$WORKDIR"
  echo "deleted $WORKDIR"
  exit 0
fi

if [ "$cmd" != "up" ]; then
  echo "usage: $0 [up|down|clean]" >&2
  exit 1
fi

mkdir -p "$WORKDIR/host" "$WORKDIR/clientkeys"

# Host key (identifies the server). Regenerating this changes the host fingerprint, so keep it
# stable across 'up' re-runs - only 'clean' removes it.
if [ ! -f "$WORKDIR/host/ssh_host_ed25519_key" ]; then
  ssh-keygen -t ed25519 -f "$WORKDIR/host/ssh_host_ed25519_key" -N "" -C "nodeterm-test-sshd-host" -q
  echo "generated host key"
fi

# a) keyuser: unencrypted key, baseline "should just work" case.
if [ ! -f "$WORKDIR/clientkeys/keyuser" ]; then
  ssh-keygen -t ed25519 -f "$WORKDIR/clientkeys/keyuser" -N "" -C "keyuser" -q
  echo "generated keyuser key (unencrypted)"
fi

# b) passuser: passphrase-protected key, the main case under test.
if [ ! -f "$WORKDIR/clientkeys/passuser" ]; then
  ssh-keygen -t ed25519 -f "$WORKDIR/clientkeys/passuser" -N "testpass123" -C "passuser" -q
  echo "generated passuser key (passphrase-protected)"
fi

# c) pwuser has no key at all - password auth only, set at image build time (Dockerfile).
# ssh-keygen already wrote keyuser.pub / passuser.pub next to the private keys above, which is
# exactly what entrypoint.sh looks for - nothing more to generate.

# Empty known_hosts file dedicated to this harness so verification never touches ~/.ssh/known_hosts.
touch "$WORKDIR/known_hosts"

docker build -t "$IMAGE" "$HERE" >/dev/null
echo "built image $IMAGE"

do_down >/dev/null 2>&1 || true

docker run -d \
  --name "$CONTAINER" \
  -p "127.0.0.1:${HOST_PORT}:22" \
  -v "$WORKDIR/host:/keys/host:ro" \
  -v "$WORKDIR/clientkeys:/keys/clientkeys:ro" \
  "$IMAGE" >/dev/null

echo "started container $CONTAINER, sshd on 127.0.0.1:${HOST_PORT}"
echo "keys and known_hosts file are under $WORKDIR"
