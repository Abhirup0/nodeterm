# SSH test harness (Docker)

A disposable OpenSSH server in Docker for exercising nodeterm's SSH connect paths
(`src/main/remote-ssh`, `src/core/remote-ssh`), especially the SSH_ASKPASS passphrase flow,
without touching a real server. sshd binds to `127.0.0.1:22022` only - never reachable off this
machine.

Nothing generated (host keys, client keys, known_hosts, logs) is committed. It all lives under
`test/ssh-docker/.work/` (gitignored); set `NT_SSHDOCKER_WORKDIR` to keep it somewhere else
entirely, e.g. outside the repo.

## Start / stop

```
./run.sh up      # generate keys (if missing), build the image, start the container
./run.sh down     # stop and remove the container (keeps the image and keys for a fast restart)
./run.sh clean     # full teardown: stop+remove the container, remove the image, delete all keys
```

`up` is idempotent: re-running it reuses existing keys and just rebuilds/restarts the container.
Only `clean` deletes the generated keys (a fresh `up` after that regenerates everything, with a
new host key fingerprint).

Manual teardown if you don't want to use the script:

```
docker rm -f nodeterm-ssh-test
docker rmi -f nodeterm-ssh-test
rm -rf test/ssh-docker/.work    # or your $NT_SSHDOCKER_WORKDIR
```

## The three users

| user     | auth                    | password / passphrase | purpose |
|----------|--------------------------|------------------------|---------|
| keyuser  | public key, unencrypted    | n/a                | baseline: connect and it should just work |
| passuser | public key, passphrase-protected | `testpass123`  | the main case - exercises the SSH_ASKPASS passphrase prompt |
| pwuser   | password only, no key at all | `pwpass123`     | server wants a password with no identity file configured; the ControlMaster has no tty to prompt into |

Keys live under `test/ssh-docker/.work/clientkeys/` after `run.sh up`:
`keyuser` / `keyuser.pub`, `passuser` / `passuser.pub` (both ed25519, generated fresh each time
the workdir doesn't already have them).

## Connecting by hand

Run the ssh CLIENT inside a throwaway container, never on the host. `ssh` resolves the user's home
directory from the passwd database, NOT from `$HOME`, so `StrictHostKeyChecking=accept-new` appends
to the real `~/.ssh/known_hosts` even when `HOME` is redirected. This harness must never touch the
host's `~/.ssh`, and `matrix.sh` plus the vitest e2e both refuse to run the client anywhere else
for exactly this reason.

```
# The client container joins the same docker network as the sshd container and brings its own
# HOME, so its known_hosts is created and destroyed with the container.
docker run --rm -it --network nt-ssh-net \
  -v "$PWD/.work/clientkeys":/keys:ro \
  alpine:3.20 sh -lc '
    apk add --no-cache openssh >/dev/null
    cp /keys/passuser /root/passuser && chmod 600 /root/passuser
    # passphrase-protected key: answer testpass123
    ssh -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes \
        -i /root/passuser passuser@nodeterm-ssh-test
  '
```

Swap `passuser` for `keyuser` (unencrypted key) or drop `-i` and use `pwuser` (password
`pwpass123`) to exercise the other two accounts.

## What pins the measured behaviors

`matrix.sh` measures the connect/ask matrix (the before/after prompt counts and the no-agent
degradation) with a fake `SSH_ASKPASS` helper. The finer OpenSSH behaviors the code depends on
are pinned by `askpass-e2e.test.ts` against the real ssh binary: `$PPID` is the exact master pid
(cancel attribution), an empty answer abandons the key, and the unlocked key lands only in the
app's own agent, never the ambient one. One behavior is read from OpenSSH's source rather than
measured here: a retry re-invokes askpass with a byte-identical prompt (readpass.c), which is why
retries are detected by (key, pid) instead of prompt text.

## Layout

- `Dockerfile` - debian-slim + openssh-server, three users created at build time.
- `sshd_config` - pubkey auth for keyuser/passuser, password auth scoped to pwuser only via a
 trailing `Match User pwuser` block (Match blocks run to end-of-file, so it must be last).
- `entrypoint.sh` - copies the bind-mounted host key and public keys into place with correct
 in-container ownership (a straight bind-mount keeps the host's UID, which trips sshd's
 StrictModes check), then execs sshd in the foreground.
- `run.sh` - key generation + build + run/stop/clean, all confined to the outer temp dir.

## Harness parity with production

`pwuser` exists to test what OpenSSH *can* route, not what the app does. Production `masterArgs`
sets `PasswordAuthentication=no` and `KbdInteractiveAuthentication=no`, because a tty-less master
can never complete either method and would otherwise submit an empty credential once per allowed
prompt, spending real login attempts and tripping a host's fail2ban. So the app never reaches a
server password prompt at all.

Keep that in mind before building on a probe result: a scenario that works here with a bare `ssh`
invocation may be unreachable in the app. If you add server-password support, the two options
above have to change first, and `NumberOfPasswordPrompts` must NOT be used to express it: that
counter also bounds the key passphrase retry loop, so setting it to 0 silently disables passphrase
prompting entirely.

## ssh-agent is the passphrase cache, and the app owns the agent

Production `masterArgs` also sets `AddKeysToAgent=yes`: the first successful unlock loads the
key into the agent named by `SSH_AUTH_SOCK`, and every later master (fresh process) authenticates
through it with zero prompts - `matrix.sh`'s third section demonstrates it against this container
(first connect asks=1, second asks=0, third with askpass removed asks=0). The app therefore keeps
no passphrase state of its own.

Which agent that is, is deliberate: main spawns an **app-private** `ssh-agent` and points its
masters at it (`src/main/remote-ssh/ssh-agent.ts`), then kills it at quit, so an unlock lasts one
app run instead of until the user's next logout. Consequences the harness has to respect: nothing
should ever land in the ambient agent (the e2e asserts this), and a key the user already loaded
into their own agent does NOT authenticate a nodeterm master - the app prompts once per run and
keeps the unlock in its own agent. `matrix.sh` still measures the raw OpenSSH behavior with a
plain agent, which is the layer underneath this decision and is unchanged.

Two measured facts to keep in mind when extending this:

- An agent full of OTHER keys is offered before a `-i` file identity, and each rejected offer
 spends one of sshd's `MaxAuthTries` (default 6, unset in this harness's sshd_config). Eight
 junk agent keys ended the connection with "Too many authentication failures" before the right
 key was reached. That is why production pins `IdentitiesOnly=yes` alongside `-i` - and ONLY
 alongside `-i`, because IdentitiesOnly with no configured identity disables agent keys
 entirely. The agent still signs the pinned key, so the zero-prompt reconnect is unaffected.
- With no agent reachable (`SSH_AUTH_SOCK` unset), `AddKeysToAgent=yes` degrades silently:
 the connection works, the prompt just fires once per connect, and ssh prints nothing to
 stderr about the skipped add (so it can never pollute the app's connect-error banner).
