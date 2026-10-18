# shellcheck shell=bash
# adhd devcontainer: start or stop project-adhd's workspace container.
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
# shellcheck disable=SC2154  # ADHD_HOME and shared helpers come from bin/adhd

devcontainer_usage() {
  cat <<'EOF'
usage: adhd devcontainer <up|stop> [dir]
       adhd devcontainer --help

Start or stop project-adhd's Dev Container for a Git worktree root.
EOF
}

# devcontainer_container <root> <config>: prints the sole exact matching
# workspace container ID, or nothing if none exists.
devcontainer_container() {
  local root=$1 config=$2 ids count

  ids=$(docker ps -aq \
    --filter "label=devcontainer.local_folder=$root" \
    --filter "label=devcontainer.config_file=$config" \
    --filter label=com.docker.compose.service=workspace) ||
    die 'unable to list containers; is Docker running?'
  count=$(printf '%s\n' "$ids" | grep -c . || true)
  if (( count > 1 )); then
    die "more than one Dev Container matches $root; refusing to choose"
  fi
  if (( count == 1 )); then
    printf '%s\n' "$ids"
  fi
  return 0
}

# devcontainer_inspect <id> <format>: prints Docker inspect output or fails.
devcontainer_inspect() {
  local id=$1 format=$2 output

  output=$(docker inspect --format "$format" "$id") ||
    die "unable to inspect Dev Container $id"
  printf '%s\n' "$output"
}

cmd_devcontainer() {
  local action=${1-} dir=. root config container running project status

  if (( $# == 1 )) && [[ $action == -h || $action == --help ]]; then
    devcontainer_usage
    return 0
  fi
  if [[ $action == up || $action == stop ]] && (( $# == 2 )) &&
    [[ ${2-} == -h || ${2-} == --help ]]; then
    devcontainer_usage
    return 0
  fi
  if [[ $action != up && $action != stop ]] || (( $# > 2 )); then
    devcontainer_usage >&2
    return 1
  fi
  if (( $# == 2 )); then
    dir=$2
  fi

  root=$(require_worktree_root "$dir")
  refuse_symlinks "$root"
  config="$root/$ADHD_RUNTIME_REL/devcontainer.json"
  [[ -f "$config" && -r "$config" ]] ||
    die "no project-adhd Dev Container configuration in $root; run adhd attach $root first"
  command -v docker >/dev/null 2>&1 ||
    die 'docker is required on the host for adhd devcontainer'

  container=$(devcontainer_container "$root" "$config")
  if [[ -n $container ]]; then
    running=$(devcontainer_inspect "$container" '{{.State.Running}}')
    [[ $running == true || $running == false ]] ||
      die "unexpected running state for Dev Container $container: $running"
  else
    running=false
  fi

  if [[ $action == stop ]]; then
    if [[ -z $container || $running == false ]]; then
      note "Dev Container is already stopped for $root"
      return 0
    fi
    note "Stopping Dev Container for $root"
    docker stop "$container" || return $?
    note "Dev Container is stopped for $root"
    return 0
  fi

  if [[ -n $container && $running == true ]]; then
    note "Dev Container is already running for $root"
    return 0
  fi

  command -v devcontainer >/dev/null 2>&1 ||
    die 'devcontainer is required on the host; install it with npm install -g @devcontainers/cli'
  project=
  if [[ -n $container ]]; then
    project=$(devcontainer_inspect "$container" '{{ index .Config.Labels "com.docker.compose.project" }}')
    [[ -n $project && $project != '<no value>' ]] ||
      die "unable to determine Compose project for Dev Container $container"
  fi

  note "Starting Dev Container for $root"
  if [[ -n $project ]]; then
    (cd "$root" && COMPOSE_PROJECT_NAME=$project devcontainer up --workspace-folder "$root" --config "$config") || {
      status=$?
      return "$status"
    }
  else
    (cd "$root" && devcontainer up --workspace-folder "$root" --config "$config") || {
      status=$?
      return "$status"
    }
  fi

  container=$(devcontainer_container "$root" "$config")
  if [[ -n $container ]]; then
    running=$(devcontainer_inspect "$container" '{{.State.Running}}')
    [[ $running == true ]] || die "Dev Container did not reach the running state for $root"
  else
    die "Dev Container did not reach the running state for $root"
  fi
  note "Dev Container is running for $root"
}
