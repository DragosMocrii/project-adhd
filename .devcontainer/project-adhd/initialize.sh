#!/usr/bin/env bash
# Runs on the host before the Dev Container is built (initializeCommand).
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
set -euo pipefail

LC_ALL=C
export LC_ALL

die() {
  printf 'initialize.sh: %s\n' "$*" >&2
  exit 1
}

canonical_directory() {
  local directory=$1

  [[ -d "$directory" ]] || return 1
  (
    cd -P -- "$directory" 2>/dev/null || exit 1
    pwd -P
  )
}

short_hash() {
  local digest

  if command -v sha256sum >/dev/null 2>&1; then
    digest=$(printf '%s' "$1" | sha256sum 2>/dev/null) || return 1
  else
    digest=$(printf '%s' "$1" | shasum -a 256 2>/dev/null) || return 1
  fi
  digest=${digest%% *}
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s' "${digest:0:8}"
}

if (( $# > 1 )); then
  die 'expected at most one workspace root argument'
fi

if (( $# == 1 )); then
  workspace_root=$1
else
  if ! workspace_root=$(git rev-parse --show-toplevel 2>/dev/null); then
    die 'current directory is not a Git repository'
  fi
fi

if [[ -z "$workspace_root" || ! -d "$workspace_root" ]]; then
  die "workspace root is not a directory: $workspace_root"
fi

# Must equal the Dev Containers ${localWorkspaceFolderBasename}, so it is taken
# from the path as given, before symlinks are resolved.
workspace_name=${workspace_root%/}
workspace_name=${workspace_name##*/}
if [[ -z "$workspace_name" ]]; then
  die "unable to derive a workspace name from: $workspace_root"
fi
# WORKSPACE_NAME is written unquoted to Compose's .env, where these characters
# would be interpolated or start a comment, breaking the mount path.
case "$workspace_name" in
  *'$'*|*'"'*|*"'"*|*\\*|*' #'*)
    die "the folder name '$workspace_name' contains \$, a quote, a backslash, or ' #'; rename the folder"
    ;;
esac

if ! workspace_root=$(canonical_directory "$workspace_root"); then
  die "unable to resolve workspace root: $workspace_root"
fi

if ! repo_root_reported=$(git -C "$workspace_root" rev-parse --show-toplevel 2>/dev/null); then
  die "workspace root is not a Git repository: $workspace_root"
fi
if ! repo_root=$(canonical_directory "$repo_root_reported"); then
  die "unable to resolve Git repository root: $repo_root_reported"
fi

if ! devcontainer_dir=$(canonical_directory "$(dirname "${BASH_SOURCE[0]}")"); then
  die 'unable to resolve the initializer directory'
fi
case "$devcontainer_dir/" in
  "$repo_root"/*) ;;
  *) die "initializer is not inside the repository $repo_root: $devcontainer_dir" ;;
esac

if ! git_common_dir_reported=$(git -C "$workspace_root" rev-parse --git-common-dir 2>/dev/null); then
  die "unable to resolve Git common directory: $workspace_root"
fi
if [[ "$git_common_dir_reported" == /* ]]; then
  git_common_dir_candidate=$git_common_dir_reported
else
  git_common_dir_candidate=$workspace_root/$git_common_dir_reported
fi
if ! git_common_dir=$(canonical_directory "$git_common_dir_candidate"); then
  die "unable to resolve Git common directory: $git_common_dir_candidate"
fi

if ! project_root_reported=$(git -C "$workspace_root" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p'); then
  die "unable to resolve Git repository root: $workspace_root"
fi
if [[ -z "$project_root_reported" ]]; then
  die "unable to resolve Git repository root: $workspace_root"
fi
if ! project_root=$(canonical_directory "$project_root_reported"); then
  die "unable to resolve Git repository root: $project_root_reported"
fi

repo_basename=${project_root##*/}
lowercase_basename=$(printf '%s' "$repo_basename" | tr '[:upper:]' '[:lower:]')
project_slug=$(printf '%s' "$lowercase_basename" | sed \
  -e 's/[^a-z0-9][^a-z0-9]*/-/g' \
  -e 's/^-*//' \
  -e 's/-*$//')
if [[ -z "$project_slug" ]]; then
  project_slug=project
fi
project_slug=${project_slug:0:40}

if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  die 'neither sha256sum nor shasum is available to derive the project identity'
fi
if ! project_id=$(short_hash "$git_common_dir"); then
  die 'unable to hash the canonical Git common directory'
fi
computed_prefix=$project_slug-$project_id

prefix_pattern='[a-z0-9][a-z0-9-]*-[0-9a-f]{8}'

# read_valid_prefix <path> [<key>...]
# Sets READ_PREFIX when <path> holds a valid PROJECT_STATE_PREFIX line followed
# by exactly one line per <key>, in that order, every line newline-terminated.
read_valid_prefix() {
  local path=$1
  shift
  local line='' first_line='' keys='' expected_keys='' line_count=0 newline_count key
  READ_PREFIX=

  if [[ ! -e "$path" && ! -L "$path" ]]; then
    return 0
  fi
  if [[ ! -f "$path" || ! -r "$path" ]]; then
    die "existing $path is not a readable regular file"
  fi

  for key in "$@"; do
    expected_keys="$expected_keys $key"
  done

  while IFS= read -r line || [[ -n "$line" ]]; do
    line_count=$((line_count + 1))
    if (( line_count == 1 )); then
      first_line=$line
    else
      keys="$keys ${line%%=*}"
    fi
  done < "$path"
  newline_count=$(wc -l < "$path")
  if (( line_count == $# + 1 && newline_count == $# + 1 )) &&
    [[ "$keys" == "$expected_keys" ]] &&
    [[ "$first_line" =~ ^PROJECT_STATE_PREFIX=$prefix_pattern$ ]]; then
    READ_PREFIX=${first_line#PROJECT_STATE_PREFIX=}
  fi
}

# read_agent_state_scope <devcontainer.env>: sets AGENT_STATE_SCOPE_VALUE.
read_agent_state_scope() {
  local path=$1 line value=

  if [[ -f "$path" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      case "$line" in
        AGENT_STATE_SCOPE=*) value=${line#AGENT_STATE_SCOPE=} ;;
      esac
    done < "$path"
  fi
  case "$value" in
    ''|shared) AGENT_STATE_SCOPE_VALUE=shared ;;
    project) AGENT_STATE_SCOPE_VALUE=project ;;
    *) die "invalid AGENT_STATE_SCOPE '$value' in $path (valid: shared, project)" ;;
  esac
}

write_file() {
  local destination=$1 contents=$2 temporary

  if ! temporary=$(mktemp "${destination}.tmp.XXXXXX"); then
    die "unable to create temporary state file for $destination"
  fi
  if ! printf '%s' "$contents" > "$temporary"; then
    rm -f -- "$temporary"
    die "unable to write state file $destination"
  fi
  if ! mv -f -- "$temporary" "$destination"; then
    rm -f -- "$temporary"
    die "unable to install state file $destination"
  fi
}

state_env=$devcontainer_dir/.env
canonical_state=$git_common_dir/.agentic-bun-devcontainer-prefix
read_valid_prefix "$canonical_state"
canonical_prefix=$READ_PREFIX
read_valid_prefix "$state_env" COMPOSE_INSTANCE AGENT_STATE_PREFIX WORKSPACE_NAME
worktree_prefix=$READ_PREFIX

if [[ -n "$canonical_prefix" && -n "$worktree_prefix" && "$canonical_prefix" != "$worktree_prefix" ]]; then
  die "conflicting PROJECT_STATE_PREFIX values in $canonical_state and $state_env"
fi

if [[ -n "$canonical_prefix" ]]; then
  SELECTED_PREFIX=$canonical_prefix
elif [[ -n "$worktree_prefix" ]]; then
  SELECTED_PREFIX=$worktree_prefix
else
  SELECTED_PREFIX=$computed_prefix
fi

if [[ "$canonical_prefix" != "$SELECTED_PREFIX" ]]; then
  write_file "$canonical_state" "PROJECT_STATE_PREFIX=$SELECTED_PREFIX"$'\n'
fi

devcontainer_env=$devcontainer_dir/devcontainer.env
if [[ ! -e "$devcontainer_env" && ! -L "$devcontainer_env" ]]; then
  if ! (umask 077; set -o noclobber; : > "$devcontainer_env") 2>/dev/null; then
    if [[ ! -e "$devcontainer_env" && ! -L "$devcontainer_env" ]]; then
      die "unable to create $devcontainer_env"
    fi
  fi
fi

read_agent_state_scope "$devcontainer_env"
if [[ "$AGENT_STATE_SCOPE_VALUE" == project ]]; then
  agent_state_prefix=$SELECTED_PREFIX
else
  agent_state_prefix=project-adhd-shared
fi

if ! worktree_id=$(short_hash "$workspace_root"); then
  die 'unable to hash the canonical worktree root'
fi

write_file "$state_env" "PROJECT_STATE_PREFIX=$SELECTED_PREFIX
COMPOSE_INSTANCE=$SELECTED_PREFIX-$worktree_id
AGENT_STATE_PREFIX=$agent_state_prefix
WORKSPACE_NAME=$workspace_name
"
