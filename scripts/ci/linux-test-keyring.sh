#!/bin/sh
# CI/test only: runs a command with a throwaway, unlocked GNOME Keyring login collection in the
# current D-Bus session, so the Linux Secret Service adapter can be exercised. Use it under
# `dbus-run-session -- scripts/ci/linux-test-keyring.sh <command>`. The keyring lives in a fresh
# temporary XDG_DATA_HOME and its password is a fixed, public test value.
set -eu
XDG_DATA_HOME="$(mktemp -d)"
export XDG_DATA_HOME
printf 'tyrminal-test-keyring' | gnome-keyring-daemon --components=secrets --daemonize --unlock >/dev/null
exec "$@"
