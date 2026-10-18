# shellcheck shell=sh
# Run by `adhd herdr` as root inside the Dev Container, through
# `docker exec -i -u root <container> sh -s <public key> <user>`, on every
# connect. Writes the sshd configuration that libexec/adhd/herdr-bin/options.sh
# starts sshd with: the host key is the only one accepted, and the session gets
# the container's environment. sshd builds each session's environment from
# scratch, and PAM then loads /etc/environment, so without SetEnv the panes would
# lack containerEnv (CLAUDE_CONFIG_DIR, NO_BROWSER) and remoteEnv's PATH.
set -eu

public_key=$1
user=$2
directory=/etc/project-adhd

[ -x /usr/sbin/sshd ] || {
  echo 'sshd is missing; rebuild the container, or rerun post-create.sh' >&2
  exit 3
}
home=$(getent passwd "$user" | cut -d: -f6)
[ -n "$home" ] || {
  echo "no such container user: $user" >&2
  exit 3
}

# remoteEnv's PATH, then docker exec's, then any entries only /etc/environment
# has: Dev Container Features such as Node put their PATH there.
path="$home/.bun/bin:$home/.local/bin:$PATH"
extra=$(sed -n 's/^PATH="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/environment 2>/dev/null | tr '\n' ':')
set -f
old_ifs=$IFS
IFS=:
for entry in $extra; do
  case ":$path:" in
    *":$entry:"*) ;;
    *) path="$path:$entry" ;;
  esac
done
IFS=$old_ifs
set +f

mkdir -p /run/sshd "$directory"
chmod 0755 "$directory"
printf '%s\n' "$public_key" > "$directory/herdr_authorized_keys"
chmod 0644 "$directory/herdr_authorized_keys"

# SetEnv carries the container's environment, secrets from devcontainer.env
# included; only sshd, running as root, reads this file. It is emptied and made
# private before anything is written to it.
umask 077
: > "$directory/herdr_sshd_config"
chmod 0600 "$directory/herdr_sshd_config"
{
  # PAM is required: without it sshd refuses the password-less, locked user.
  printf 'UsePAM yes\n'
  # sshd -i -e logs to the client's terminal, which Herdr draws on.
  printf 'LogLevel ERROR\n'
  printf 'AuthorizedKeysFile %s/herdr_authorized_keys\n' "$directory"
  printf 'PasswordAuthentication no\n'
  printf 'KbdInteractiveAuthentication no\n'
  printf 'PermitRootLogin no\n'
  printf 'AllowUsers %s\n' "$user"
  # Herdr copies its binary with scp, which speaks SFTP.
  printf 'Subsystem sftp internal-sftp\n'
  printf 'SetEnv'
  # Values with a quote or backslash cannot be written to SetEnv; they are rare
  # and dropped. So are the per-process variables sshd sets itself.
  env | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' |
    grep -Ev '^(HOME|HOSTNAME|LOGNAME|MAIL|OLDPWD|PATH|PWD|SHELL|SHLVL|SUDO_[A-Z]*|TERM|USER|_)=' |
    grep -v '["\\]' |
    while IFS= read -r line; do
      printf ' "%s"' "$line"
    done
  printf ' "PATH=%s"\n' "$path"
} > "$directory/herdr_sshd_config"
