# shellcheck shell=bash
# adhd attach: copy the project-adhd runtime into a Git worktree.
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
# shellcheck disable=SC2154  # ADHD_* and AGENT_TOOLS_SELECTED come from common.sh and agent-tools.sh

attach_usage() {
  cat <<'EOF'
usage: adhd attach <dir | owner/repo | url> [--agents <list>] [--track]

Copies the project-adhd Dev Container into <dir>/.devcontainer/project-adhd/.
By default it is hidden from git; --track makes it part of the repository.
owner/repo and GitHub URLs are cloned with gh first. To bring in a newer
project-adhd later, run: adhd refresh <dir>
EOF
}

# resolve_attach_target <arg>: prints the directory to attach, cloning
# owner/repo or a GitHub URL into the current directory first.
resolve_attach_target() {
  local arg=$1 name

  if [[ -d "$arg" ]]; then
    printf '%s\n' "$arg"
    return 0
  fi
  case "$arg" in
    https://github.com/*|git@github.com:*)
      name=${arg%/}
      name=${name%.git}
      name=${name##*/}
      ;;
    /*|./*|../*|'~'*)
      die "no such directory: $arg"
      ;;
    *)
      [[ "$arg" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
        die "not a directory, owner/repo, or GitHub URL: $arg"
      name=${arg##*/}
      ;;
  esac
  [[ -n "$name" && "$name" != . && "$name" != .. ]] || die "unable to derive a directory name from: $arg"
  [[ ! -e "$name" ]] || die "$name already exists; to attach it, run: adhd attach $name"
  require_gh
  note "Cloning $arg" >&2
  gh repo clone "$arg" "$name" >&2 || die "gh repo clone failed for $arg"
  printf '%s\n' "$name"
}

# choose_agents <runtime> <agents> <agents_given>: sets ATTACH_AGENTS to the
# normalized tool list, or to empty when devcontainer.env already exists.
choose_agents() {
  local runtime=$1 agents=$2 agents_given=$3 answer

  ATTACH_AGENTS=
  if [[ -e "$runtime/devcontainer.env" ]]; then
    if (( agents_given )); then
      warn "kept the existing $ADHD_RUNTIME_REL/devcontainer.env; --agents was not applied"
    fi
    return 0
  fi
  if (( agents_given == 0 )) && [[ -t 0 ]]; then
    printf 'Agent tools to install, comma-separated from %s [all]: ' \
      "$(agent_tools_join "${AGENT_TOOLS_KNOWN[@]}")" >&2
    IFS= read -r answer || answer=
    agents=$answer
  fi
  validate_agents "$agents"
  ATTACH_AGENTS=$(selected_agents_csv)
}

# write_devcontainer_env <runtime> <agents>: creates devcontainer.env from the
# example; does nothing when <agents> is empty (the file already exists).
write_devcontainer_env() {
  local runtime=$1 agents=$2 line

  [[ -n "$agents" ]] || return 0
  (
    umask 077
    while IFS= read -r line || [[ -n "$line" ]]; do
      case "$line" in
        AGENT_TOOLS=*) printf 'AGENT_TOOLS=%s\n' "$agents" ;;
        *) printf '%s\n' "$line" ;;
      esac
    done < "$runtime/devcontainer.env.example" > "$runtime/devcontainer.env"
  )
}

print_next_steps() {
  local root=$1 mode=$2

  note "Attached project-adhd to $root ($mode)"
  printf 'Next: open %s in VS Code and run "Dev Containers: Reopen in Container".\n' "$root"
}

# Cleanup state for a failed attach; see attach_cleanup.
ATTACH_RUNTIME=''
ATTACH_CREATED_RUNTIME=0

# attach_cleanup: the EXIT trap. On failure it removes the marker temp file and,
# when this run created the runtime folder, the folder itself, so a failed
# attach changes nothing and does not block the next one.
attach_cleanup() {
  local status=$?

  (( status != 0 )) || return 0
  if [[ -n "$ADHD_MARKER_TEMP" ]]; then
    rm -f -- "$ADHD_MARKER_TEMP"
  fi
  if (( ATTACH_CREATED_RUNTIME )); then
    rm -rf -- "$ATTACH_RUNTIME"
    rmdir "$(dirname "$ATTACH_RUNTIME")" 2>/dev/null || true
  fi
}

cmd_attach() {
  local target='' agents='' agents_given=0 mode=untracked root runtime marker recorded tracked_files version previous

  while (( $# > 0 )); do
    case "$1" in
      --agents)
        (( $# >= 2 )) || die '--agents needs a value'
        agents=$2
        agents_given=1
        shift 2
        ;;
      --agents=*)
        agents=${1#--agents=}
        agents_given=1
        shift
        ;;
      --track)
        mode=tracked
        shift
        ;;
      -h|--help)
        attach_usage
        return 0
        ;;
      -*)
        die "unknown option: $1"
        ;;
      *)
        [[ -z "$target" ]] || die "unexpected argument: $1"
        target=$1
        shift
        ;;
    esac
  done
  if [[ -z "$target" ]]; then
    attach_usage >&2
    exit 1
  fi
  if (( agents_given )); then
    validate_agents "$agents"
  fi

  target=$(resolve_attach_target "$target")
  root=$(require_worktree_root "$target")
  runtime="$root/$ADHD_RUNTIME_REL"
  marker="$runtime/.adhd"
  refuse_symlinks "$root"
  if [[ "$mode" == tracked ]]; then
    [[ ! -L "$root/.gitignore" ]] || die "refusing to follow the symlink $root/.gitignore"
  fi

  if [[ -e "$runtime" ]]; then
    [[ -f "$marker" ]] ||
      die "$ADHD_RUNTIME_REL already exists in $root and was not created by adhd"
    recorded=$(marker_get "$marker" mode) || die "unreadable marker: $marker"
    [[ "$recorded" == "$mode" ]] ||
      die "$ADHD_RUNTIME_REL was attached $recorded; run adhd detach first to attach it $mode"
  fi
  if [[ "$mode" == untracked ]]; then
    tracked_files=$(git -C "$root" ls-files -- "$ADHD_RUNTIME_REL")
    [[ -z "$tracked_files" ]] ||
      die "git already tracks files in $ADHD_RUNTIME_REL; use --track"
  fi

  version=$(adhd_version)
  previous=$(marker_get "$marker" version) || previous=''

  choose_agents "$runtime" "$agents" "$agents_given"
  ATTACH_RUNTIME=$runtime
  if [[ ! -e "$runtime" ]]; then
    ATTACH_CREATED_RUNTIME=1
  fi
  trap attach_cleanup EXIT
  mkdir -p "$runtime"
  if [[ "$mode" == untracked ]]; then
    # Hide the folder from git before anything is copied into it.
    printf '*\n' > "$runtime/.gitignore"
  fi
  write_marker "$runtime" "$mode" "$version"
  write_ignore_rules "$root" "$runtime" "$mode"
  write_devcontainer_env "$runtime" "$ATTACH_AGENTS"
  trap - EXIT
  if [[ -n "$previous" && "$previous" != "$version" ]]; then
    note "Refreshed the runtime: $previous → $version"
  fi
  print_next_steps "$root" "$mode"
}
