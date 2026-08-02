#!/bin/sh
# Auth-capability matrix for the SSH PROJECT flow (the tty-less ControlMaster), comparing the
# original master options against the current ones, then demonstrating the agent behavior the
# current options rely on: with `AddKeysToAgent=yes`, the FIRST connect prompts for the
# passphrase and loads the unlocked key into ssh-agent, and every later master (fresh process,
# nothing cached in the app) connects with ZERO prompts. That measurement is why the app has no
# in-process passphrase cache.
#
# The ssh CLIENT runs inside a throwaway container on a docker network with the sshd container.
# Nothing here reads or writes the host's ~/.ssh: the client has its own HOME inside the container,
# so its known_hosts is created and destroyed with the container. Never run these probes with the
# host's ssh.
#
#   ./run.sh up && ./matrix.sh
set -e
here="$(cd "$(dirname "$0")" && pwd)"
keys="${NT_SSHDOCKER_WORKDIR:-$here/.work}/clientkeys"
net=nt-ssh-net
server=nodeterm-ssh-test

docker network create "$net" >/dev/null 2>&1 || true
docker network connect "$net" "$server" >/dev/null 2>&1 || true

# The askpass helper and the probe both live inside the client container. `openssh` (not just
# openssh-client) because the agent section needs ssh-agent/ssh-add.
docker run --rm -i --network "$net" \
  -v "$keys":/keys:ro \
  -e SERVER="$server" \
  alpine:3.20 sh -s <<'INNER'
set -e
apk add --no-cache openssh >/dev/null 2>&1
export HOME=/root
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
cp /keys/keyuser /keys/passuser "$HOME/.ssh/" && chmod 600 "$HOME/.ssh"/keyuser "$HOME/.ssh"/passuser

cat > /askpass.sh <<'EOF'
#!/bin/sh
echo "ASKPASS_CALLED: $1" >> /askpass.log
printf '%s' 'testpass123'
EOF
chmod +x /askpass.sh

COMMON="-M -N -o ControlMaster=auto -o ControlPersist=300 -o BatchMode=no -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -p 22"
NEWOPTS="-o ConnectTimeout=15 -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o AddKeysToAgent=yes"

# probe NAME EXTRA_OPTS USER KEY ASKPASS [idonly]
# `idonly` mirrors production identityArgs: IdentitiesOnly rides with -i (and only with -i) so a
# stocked agent can't burn the server's MaxAuthTries offering unrelated keys first.
probe() {
  name="$1"; extra="$2"; user="$3"; key="$4"; ask="$5"
  sock="/tmp/s$(date +%s%N).sock"; rm -f "$sock"; : > /askpass.log
  iarg=""
  if [ -n "$key" ]; then
    iarg="-i $HOME/.ssh/$key"
    [ "$6" = idonly ] && iarg="-o IdentitiesOnly=yes $iarg"
  fi
  if [ "$ask" = yes ]; then
    SSH_ASKPASS=/askpass.sh SSH_ASKPASS_REQUIRE=force DISPLAY=:0 \
      ssh $COMMON $extra -o ControlPath="$sock" $iarg "$user@$SERVER" 2>/tmp/err &
  else
    ssh $COMMON $extra -o ControlPath="$sock" $iarg "$user@$SERVER" 2>/tmp/err &
  fi
  pid=$!
  ok=no
  i=0
  while [ $i -lt 40 ]; do
    if ssh -O check -o ControlPath="$sock" -p 22 "$user@$SERVER" >/dev/null 2>&1; then ok=yes; break; fi
    i=$((i+1)); sleep 0.25
  done
  asks=$(grep -c ASKPASS_CALLED /askpass.log 2>/dev/null || true)
  [ -z "$asks" ] && asks=0
  reason=$(grep -iE "permission denied|denied|closed|refused" /tmp/err 2>/dev/null | tail -1 | cut -c1-52)
  printf "  %-34s connected=%-4s asks=%-3s %s\n" "$name" "$ok" "$asks" "$reason"
  ssh -O exit -o ControlPath="$sock" -p 22 "$user@$SERVER" >/dev/null 2>&1 || true
  kill $pid 2>/dev/null || true
  rm -f "$sock"
}

echo "=== ORIGINAL master options (no askpass wired, password auth allowed) ==="
probe "key, no passphrase"   ""         keyuser  keyuser  no
probe "key, WITH passphrase" ""         passuser passuser no
probe "password-only server" ""         pwuser   ""       no
echo
echo "=== CURRENT master options, NO agent reachable (askpass wired, password auth refused) ==="
probe "key, no passphrase"   "$NEWOPTS" keyuser  keyuser  yes idonly
probe "key, WITH passphrase" "$NEWOPTS" passuser passuser yes idonly
probe "password-only server" "$NEWOPTS" pwuser   ""       yes
echo
echo "=== CURRENT master options + ssh-agent: the agent is the passphrase cache ==="
eval "$(ssh-agent -s)" >/dev/null
probe "1st connect (agent empty)"        "$NEWOPTS" passuser passuser yes idonly
echo "  agent identities now:"
ssh-add -l 2>&1 | sed 's/^/    /'
probe "2nd connect (fresh master)"       "$NEWOPTS" passuser passuser yes idonly
probe "3rd connect, askpass REMOVED"     "$NEWOPTS" passuser passuser no  idonly
INNER
