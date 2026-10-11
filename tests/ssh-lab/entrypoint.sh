#!/bin/sh
# Installs per-run lab credentials from the read-only /lab-in mount, then runs sshd in the foreground.
set -eu

install -m 0600 -o root -g root /lab-in/hostkeys/ssh_host_ed25519_key /etc/ssh/lab/ssh_host_ed25519_key
install -m 0600 -o root -g root /lab-in/hostkeys/ssh_host_rsa_key /etc/ssh/lab/ssh_host_rsa_key
install -m 0644 -o root -g root /lab-in/authorized_keys /etc/ssh/lab/authorized_keys

# The password comes from a file so it never appears in argv, the image or the container environment.
password="$(cat /lab-in/password)"
printf 'tyr:%s\nnoforward:%s\n' "$password" "$password" | chpasswd >/dev/null 2>&1
unset password

exec /usr/sbin/sshd -D -e
