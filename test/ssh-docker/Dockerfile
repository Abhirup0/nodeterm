# Disposable OpenSSH server for exercising nodeterm's SSH connect paths (see ../../src/main/remote-ssh
# and ../../src/core/remote-ssh) against a throwaway box instead of a real, rate-limited server.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd

RUN useradd -m -s /bin/bash keyuser \
 && useradd -m -s /bin/bash passuser \
 && useradd -m -s /bin/bash pwuser \
 && echo 'pwuser:pwpass123' | chpasswd \
 # useradd leaves new accounts LOCKED (shadow password field "!"), which sshd refuses outright
 # ("account is locked") even for pubkey auth, not just password auth. usermod -p '*' sets a
 # password hash that can never match any input (so password auth still can't succeed for these
 # two) while clearing the locked-account flag pubkey auth also checks.
 && usermod -p '*' keyuser \
 && usermod -p '*' passuser

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
