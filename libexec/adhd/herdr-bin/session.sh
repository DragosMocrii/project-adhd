# shellcheck shell=sh
set -eu

workspace=$ADHD_HERDR_WORKSPACE

if [ "${SSH_ORIGINAL_COMMAND-}" = internal-sftp ]; then
  exec /usr/lib/openssh/sftp-server
fi

if ! cd -- "$workspace"; then
  printf 'unable to enter Herdr workspace: %s\n' "$workspace" >&2
  exit 1
fi

if [ -n "${SSH_ORIGINAL_COMMAND-}" ]; then
  exec "${SHELL:-/bin/sh}" -c "$SSH_ORIGINAL_COMMAND"
fi
exec "${SHELL:-/bin/sh}" -l
