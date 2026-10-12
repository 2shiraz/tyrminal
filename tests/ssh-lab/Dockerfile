# Disposable OpenSSH fixture for the Tyrminal test lab. Never use outside tests.
# Base image and OpenSSH package are pinned; update both deliberately and re-record in docs/testing.md.
# REGISTRY only changes where the digest-pinned image is fetched from (e.g. mirror.gcr.io/library);
# the content is fixed by the digest.
ARG REGISTRY=docker.io/library
FROM ${REGISTRY}/alpine@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8

# Full-screen applications for the terminal tests. Not version-pinned (the Alpine branch is fixed
# by the base image digest); scripts/lab.mjs records the exact installed versions in lab.json.
RUN apk add --no-cache openssh-server=10.0_p1-r10 openssh-sftp-server=10.0_p1-r10 \
       vim nano tmux htop mc ncurses ncurses-terminfo-base bash \
    && adduser -D -s /bin/sh tyr \
    && adduser -D -s /bin/sh noforward \
    && adduser -D -s /bin/sh nosession \
    && mkdir -p /etc/ssh/lab /run/sshd

COPY sshd_config /etc/ssh/sshd_config
COPY tyr-colors.sh /usr/local/bin/tyr-colors
COPY entrypoint.sh /usr/local/bin/lab-entrypoint
RUN chmod 0755 /usr/local/bin/lab-entrypoint /usr/local/bin/tyr-colors

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/lab-entrypoint"]
