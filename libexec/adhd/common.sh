# shellcheck shell=bash
# Shared helpers for the adhd host CLI. Sourced by bin/adhd, never executed.
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
# Callers set ADHD_HOME before sourcing.
# shellcheck disable=SC2034  # constants are used by the subcommand files

ADHD_RUNTIME_REL=.devcontainer/project-adhd
ADHD_RUNTIME_SOURCE="$ADHD_HOME/$ADHD_RUNTIME_REL"
ADHD_BLOCK_BEGIN='# >>> project-adhd'
ADHD_BLOCK_END='# <<< project-adhd'
ADHD_IGNORED_PATHS=(/.worktrees/ /.claude/worktrees/ /.superpowers/ /docs/superpowers/)

# Files attach copies into a target repository. Must match the tracked contents
# of .devcontainer/project-adhd/ other than .gitignore; a contract test checks.
ADHD_RUNTIME_FILES=(
  devcontainer.json
  devcontainer-lock.json
  docker-compose.yml
  initialize.sh
  post-create.sh
  verify.sh
  devcontainer.env.example
  lib/agent-tools.sh
  lib/claude-marketplaces.ts
  lib/claude-plugins.ts
  lib/codex-marketplaces.ts
  lib/codex-plugins.ts
  lib/collect.ts
  lib/omp-plugins.ts
)

die() {
  printf 'adhd: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '==> %s\n' "$*"
}

warn() {
  printf 'adhd: warning: %s\n' "$*" >&2
}

file_sha256() {
  local digest

  if command -v sha256sum >/dev/null 2>&1; then
    digest=$(sha256sum < "$1") || die "unable to hash $1"
  elif command -v shasum >/dev/null 2>&1; then
    digest=$(shasum -a 256 < "$1") || die "unable to hash $1"
  else
    die 'neither sha256sum nor shasum is available'
  fi
  printf '%s\n' "${digest%% *}"
}

# require_worktree_root <dir>: prints the canonical path of <dir>, which must
# be exactly the top level of a Git worktree.
require_worktree_root() {
  local dir=$1 canonical top

  [[ -d "$dir" ]] || die "not a directory: $dir"
  canonical=$(cd -P -- "$dir" && pwd -P) || die "unable to resolve: $dir"
  top=$(git -C "$canonical" rev-parse --show-toplevel 2>/dev/null) ||
    die "not a Git repository: $dir"
  top=$(cd -P -- "$top" && pwd -P) || die "unable to resolve: $top"
  [[ "$top" == "$canonical" ]] ||
    die "not the root of a Git worktree: $dir (its worktree root is $top)"
  printf '%s\n' "$canonical"
}

git_common_dir() {
  local root=$1 reported

  reported=$(git -C "$root" rev-parse --git-common-dir) ||
    die "unable to resolve the Git common directory of $root"
  case "$reported" in
    /*) ;;
    *) reported="$root/$reported" ;;
  esac
  (cd -P -- "$reported" && pwd -P) || die "unable to resolve: $reported"
}

# marker_get <file> <key>: prints the value of the first <key>=value line.
marker_get() {
  local file=$1 key=$2 line

  [[ -f "$file" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "$key="*)
        printf '%s\n' "${line#"$key="}"
        return 0
        ;;
    esac
  done < "$file"
  return 1
}

# remove_block <file>: drops the delimited project-adhd block, keeping the
# file's mode and every other line.
remove_block() {
  local file=$1 line inside=0 temporary

  [[ -f "$file" ]] || return 0
  temporary=$(mktemp "$file.adhd.XXXXXX") || die "unable to create a temporary file next to $file"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$ADHD_BLOCK_BEGIN" ]]; then
      inside=1
    elif [[ "$line" == "$ADHD_BLOCK_END" ]]; then
      inside=0
    elif (( inside == 0 )); then
      printf '%s\n' "$line"
    fi
  done < "$file" > "$temporary"
  cat "$temporary" > "$file"
  rm -f -- "$temporary"
}

# write_block <file>: replaces (or appends) the delimited project-adhd block.
write_block() {
  local file=$1 path

  remove_block "$file"
  if [[ -s "$file" && -n "$(tail -c 1 "$file")" ]]; then
    printf '\n' >> "$file"
  fi
  {
    printf '%s\n' "$ADHD_BLOCK_BEGIN"
    for path in "${ADHD_IGNORED_PATHS[@]}"; do
      printf '%s\n' "$path"
    done
    printf '%s\n' "$ADHD_BLOCK_END"
  } >> "$file"
}

# validate_agents <list>: dies on an unknown tool; sets AGENT_TOOLS_SELECTED.
validate_agents() {
  AGENT_TOOLS=$1 agent_tools_init
}

selected_agents_csv() {
  local IFS=,
  printf '%s' "${AGENT_TOOLS_SELECTED[*]}"
}
