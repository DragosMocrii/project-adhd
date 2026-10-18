# shellcheck shell=bash
# adhd herdr: attach a host Herdr client to the Herdr server in a repository's
# running Dev Container, so sound and notifications play on the host.
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
# shellcheck disable=SC2154  # ADHD_HOME comes from bin/adhd

# The container user Herdr runs as; devcontainer.json sets remoteUser to it.
ADHD_HERDR_USER=vscode

herdr_usage() {
  die 'usage: adhd herdr [dir] [-- <herdr arguments>]'
}

# herdr_container <instance>: prints the id of the running workspace container
# of Compose project <instance>.
herdr_container() {
  local instance=$1 ids count

  ids=$(docker ps -q \
    --filter "label=com.docker.compose.project=$instance" \
    --filter label=com.docker.compose.service=workspace) ||
    die 'unable to list containers; is Docker running?'
  count=$(printf '%s' "$ids" | grep -c . || true)
  if (( count == 0 )); then
    die "no running Dev Container for Compose project $instance; open the repository in VS Code and run Dev Containers: Reopen in Container (if COMPOSE_PROJECT_NAME is set, it may have renamed the project)"
  fi
  (( count == 1 )) || die "more than one running container belongs to Compose project $instance"
  printf '%s\n' "$ids"
}

# herdr_key: prints the private key adhd uses for every container, creating it once.
herdr_key() {
  local directory=${XDG_STATE_HOME:-$HOME/.local/state}/project-adhd/herdr-remote

  if [[ ! -f "$directory/id_ed25519" ]]; then
    mkdir -p "$directory" || die "unable to create $directory"
    chmod 0700 "$directory"
    ssh-keygen -q -t ed25519 -N '' -C project-adhd-herdr -f "$directory/id_ed25519" </dev/null ||
      die "unable to create an SSH key in $directory"
  fi
  printf '%s\n' "$directory/id_ed25519"
}

cmd_herdr() {
  local dir=. root instance container key public program

  if (( $# > 0 )) && [[ "$1" != -- ]]; then
    dir=$1
    shift
  fi
  if (( $# > 0 )); then
    [[ "$1" == -- ]] || herdr_usage
    shift
  fi

  for program in docker herdr ssh scp ssh-keygen; do
    command -v "$program" >/dev/null 2>&1 || die "$program is required on the host for adhd herdr"
  done
  root=$(require_worktree_root "$dir")
  instance=$(marker_get "$root/$ADHD_RUNTIME_REL/.env" COMPOSE_INSTANCE) ||
    die "$root has no Dev Container state; attach it with adhd attach, then open it in the container"
  container=$(herdr_container "$instance")
  key=$(herdr_key)
  public=$(cat "$key.pub") || die "unable to read $key.pub"

  docker exec -i -u root "$container" sh -s "$public" "$ADHD_HERDR_USER" \
    < "$ADHD_HOME/libexec/adhd/herdr-bin/prepare.sh" ||
    die "unable to prepare SSH access in container $container"

  # Read by libexec/adhd/herdr-bin/ssh and scp, which Herdr runs from PATH.
  ADHD_HERDR_TARGET=adhd-$instance
  ADHD_HERDR_CONTAINER=$container
  ADHD_HERDR_KEY=$key
  ADHD_HERDR_DOCKER=$(command -v docker)
  ADHD_HERDR_SSH=$(command -v ssh)
  ADHD_HERDR_SCP=$(command -v scp)
  export ADHD_HERDR_TARGET ADHD_HERDR_CONTAINER ADHD_HERDR_KEY ADHD_HERDR_DOCKER ADHD_HERDR_SSH ADHD_HERDR_SCP ADHD_HERDR_USER
  PATH="$ADHD_HOME/libexec/adhd/herdr-bin:$PATH"
  export PATH

  note "Attaching Herdr to $instance"
  exec herdr --remote "$ADHD_HERDR_TARGET" "$@"
}
