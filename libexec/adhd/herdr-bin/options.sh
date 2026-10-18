# shellcheck shell=sh
# Sourced by the ssh and scp wrappers: prepends the options that reach the Dev
# Container to the positional parameters. Options given first on the command
# line win over any ssh_config, including the one Herdr manages.
#
# The proxy runs sshd on stdin/stdout through docker exec (never with -t, which
# would corrupt the stream), so the container publishes no port and no SSH
# daemon keeps running. Host keys are not checked: anyone who can run docker
# exec already controls the container, and its host keys change on every
# rebuild. herdr-bin/prepare.sh writes the sshd configuration, which accepts
# only the key `adhd herdr` installs.
# Host code: POSIX sh with BSD or GNU userland.

set -- \
  -o "ProxyCommand='$ADHD_HERDR_DOCKER' exec -i -u root '$ADHD_HERDR_CONTAINER' /usr/sbin/sshd -i -e -f /etc/project-adhd/herdr_sshd_config" \
  -o "User=$ADHD_HERDR_USER" \
  -o "IdentityFile=\"$ADHD_HERDR_KEY\"" \
  -o IdentitiesOnly=yes \
  -o IdentityAgent=none \
  -o UserKnownHostsFile=/dev/null \
  -o StrictHostKeyChecking=no \
  -o LogLevel=ERROR \
  "$@"
