# shellcheck shell=bash
# adhd attach: copy the project-adhd runtime into a Git worktree.
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
# shellcheck disable=SC2154  # ADHD_* and AGENT_TOOLS_SELECTED come from common.sh and agent-tools.sh

attach_usage() {
  cat <<'EOF'
usage: adhd attach <dir> [--agents <list>]

Copies the project-adhd Dev Container into <dir>/.devcontainer/project-adhd/
and hides it from git. Rerun it to refresh an attached repository.
EOF
}

# resolve_attach_target <arg>: prints the directory to attach.
resolve_attach_target() {
  local arg=$1

  [[ -d "$arg" ]] || die "no such directory: $arg"
  printf '%s\n' "$arg"
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
    printf 'Agent tools to install, comma-separated from claude, codex, gemini, omp [all]: ' >&2
    IFS= read -r answer || answer=
    agents=$answer
  fi
  validate_agents "$agents"
  ATTACH_AGENTS=$(selected_agents_csv)
}

# copy_runtime <runtime>: copies every runtime file, printing one sha line each.
copy_runtime() {
  local runtime=$1 file source destination

  for file in "${ADHD_RUNTIME_FILES[@]}"; do
    source="$ADHD_RUNTIME_SOURCE/$file"
    destination="$runtime/$file"
    [[ -f "$source" ]] || die "the installation is incomplete (missing $source); run: adhd update"
    mkdir -p "$(dirname "$destination")"
    cp -p "$source" "$destination"
    printf 'sha:%s=%s\n' "$file" "$(file_sha256 "$destination")"
  done
}

# write_marker <runtime> <mode>: copies the runtime and records what was written.
write_marker() {
  local runtime=$1 mode=$2 body revision

  body=$(mktemp "$runtime/.adhd.XXXXXX") || die "unable to create a temporary file in $runtime"
  revision=$(git -C "$ADHD_HOME" rev-parse HEAD 2>/dev/null) || revision=unknown
  {
    printf 'mode=%s\n' "$mode"
    printf 'source=%s\n' "$revision"
    copy_runtime "$runtime"
  } > "$body"
  mv -f -- "$body" "$runtime/.adhd"
}

# write_ignore_rules <root> <runtime> <mode>
write_ignore_rules() {
  local root=$1 runtime=$2 mode=$3 common

  case "$mode" in
    untracked)
      printf '*\n' > "$runtime/.gitignore"
      common=$(git_common_dir "$root")
      mkdir -p "$common/info"
      write_block "$common/info/exclude"
      ;;
    *)
      die "unknown attach mode: $mode"
      ;;
  esac
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

cmd_attach() {
  local target='' agents='' agents_given=0 mode=untracked root runtime marker recorded tracked_files

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

  choose_agents "$runtime" "$agents" "$agents_given"
  mkdir -p "$runtime"
  write_marker "$runtime" "$mode"
  write_ignore_rules "$root" "$runtime" "$mode"
  write_devcontainer_env "$runtime" "$ATTACH_AGENTS"
  print_next_steps "$root" "$mode"
}
