#!/usr/bin/env bash
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

if ! workspace_root=$(canonical_directory "$workspace_root"); then
  die "unable to resolve workspace root: $workspace_root"
fi

if ! repo_root_reported=$(git -C "$workspace_root" rev-parse --show-toplevel 2>/dev/null); then
  die "workspace root is not a Git repository: $workspace_root"
fi
if ! repo_root=$(canonical_directory "$repo_root_reported"); then
  die "unable to resolve Git repository root: $repo_root_reported"
fi

devcontainer_dir=$repo_root/.devcontainer
if [[ ! -d "$devcontainer_dir" ]]; then
  die "missing .devcontainer directory in repository: $repo_root"
fi

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

if command -v sha256sum >/dev/null 2>&1; then
  if ! project_hash=$(printf '%s' "$git_common_dir" | sha256sum 2>/dev/null); then
    die 'unable to hash the canonical Git common directory'
  fi
elif command -v shasum >/dev/null 2>&1; then
  if ! project_hash=$(printf '%s' "$git_common_dir" | shasum -a 256 2>/dev/null); then
    die 'unable to hash the canonical Git common directory'
  fi
else
  die 'neither sha256sum nor shasum is available to derive the project identity'
fi
project_id=${project_hash%% *}
if [[ ! "$project_id" =~ ^[0-9a-f]{64}$ ]]; then
  die 'hash utility returned an invalid digest'
fi
project_id=${project_id:0:8}
computed_prefix=$project_slug-$project_id

prefix_pattern='[a-z0-9][a-z0-9-]*-[0-9a-f]{8}'
read_valid_prefix() {
  local path=$1
  local line=
  local first_line=
  local line_count=0
  local newline_count
  READ_PREFIX=

  if [[ ! -e "$path" && ! -L "$path" ]]; then
    return 0
  fi
  if [[ ! -f "$path" || ! -r "$path" ]]; then
    die "existing $path is not a readable regular file"
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    line_count=$((line_count + 1))
    if (( line_count == 1 )); then
      first_line=$line
    fi
  done < "$path"
  newline_count=$(wc -l < "$path")
  if (( line_count == 1 && newline_count == 1 )) &&
    [[ "$first_line" =~ ^PROJECT_STATE_PREFIX=$prefix_pattern$ ]]; then
    READ_PREFIX=${first_line#PROJECT_STATE_PREFIX=}
  fi
}

write_prefix() {
  local destination=$1
  local temporary

  if ! temporary=$(mktemp "${destination}.tmp.XXXXXX"); then
    die "unable to create temporary state file for $destination"
  fi
  if ! printf 'PROJECT_STATE_PREFIX=%s\n' "$SELECTED_PREFIX" > "$temporary"; then
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
read_valid_prefix "$state_env"
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
  write_prefix "$canonical_state"
fi
if [[ "$worktree_prefix" != "$SELECTED_PREFIX" ]]; then
  write_prefix "$state_env"
fi

devcontainer_env=$devcontainer_dir/devcontainer.env
if [[ ! -e "$devcontainer_env" && ! -L "$devcontainer_env" ]]; then
  if ! (umask 077; set -o noclobber; : > "$devcontainer_env") 2>/dev/null; then
    if [[ ! -e "$devcontainer_env" && ! -L "$devcontainer_env" ]]; then
      die "unable to create $devcontainer_env"
    fi
  fi
fi
