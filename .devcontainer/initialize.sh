#!/usr/bin/env bash
set -euo pipefail

LC_ALL=C
export LC_ALL

die() {
  printf 'initialize.sh: %s\n' "$*" >&2
  exit 1
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

if ! workspace_root=$(realpath -e -- "$workspace_root" 2>/dev/null); then
  die "unable to resolve workspace root: $workspace_root"
fi

if ! repo_root=$(git -C "$workspace_root" rev-parse --show-toplevel 2>/dev/null); then
  die "workspace root is not a Git repository: $workspace_root"
fi

if ! repo_root=$(realpath -e -- "$repo_root" 2>/dev/null); then
  die "unable to resolve Git repository root: $repo_root"
fi

devcontainer_dir=$repo_root/.devcontainer
if [[ ! -d "$devcontainer_dir" ]]; then
  die "missing .devcontainer directory in repository: $repo_root"
fi

if ! git_common_dir=$(git -C "$workspace_root" rev-parse --git-common-dir 2>/dev/null); then
  die "unable to resolve Git common directory: $workspace_root"
fi

if [[ "$git_common_dir" != /* ]]; then
  git_common_dir=$workspace_root/$git_common_dir
fi
if ! git_common_dir=$(realpath -e -- "$git_common_dir" 2>/dev/null); then
  die "unable to resolve Git common directory: $git_common_dir"
fi

if ! project_root=$(git -C "$workspace_root" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p'); then
  die "unable to resolve Git repository root: $workspace_root"
fi
if [[ -z "$project_root" ]]; then
  die "unable to resolve Git repository root: $workspace_root"
fi
if ! project_root=$(realpath -e -- "$project_root" 2>/dev/null); then
  die "unable to resolve Git repository root: $project_root"
fi
repo_basename=${project_root##*/}
project_slug=$(printf '%s' "${repo_basename,,}" | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
if [[ -z "$project_slug" ]]; then
  project_slug=project
fi
project_slug=${project_slug:0:40}

if ! project_hash=$(printf '%s' "$git_common_dir" | sha256sum 2>/dev/null); then
  die 'sha256sum is required to derive the project identity'
fi
project_id=${project_hash%% *}
if [[ ! "$project_id" =~ ^[0-9a-f]{64}$ ]]; then
  die 'sha256sum returned an invalid digest'
fi
project_id=${project_id:0:8}
computed_prefix=$project_slug-$project_id

state_env=$devcontainer_dir/.env
state_lines=()
if [[ -e "$state_env" || -L "$state_env" ]]; then
  if [[ ! -f "$state_env" || ! -r "$state_env" ]]; then
    die "existing $state_env is not a readable regular file"
  fi

  state_lines=()
  mapfile -t state_lines < "$state_env"
  if (( ${#state_lines[@]} != 1 )) ||
    [[ ! "${state_lines[0]}" =~ ^PROJECT_STATE_PREFIX=[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$ ]]; then
    state_lines=()
  fi
fi

if (( ${#state_lines[@]} == 0 )); then
  temporary_state_env=
  cleanup() {
    if [[ -n "$temporary_state_env" ]]; then
      rm -f -- "$temporary_state_env"
    fi
  }
  trap cleanup EXIT

  temporary_state_env=$(mktemp "$devcontainer_dir/.env.tmp.XXXXXX")
  printf 'PROJECT_STATE_PREFIX=%s\n' "$computed_prefix" > "$temporary_state_env"
  mv -f -- "$temporary_state_env" "$state_env"
  temporary_state_env=
fi

devcontainer_env=$devcontainer_dir/devcontainer.env
if [[ ! -e "$devcontainer_env" && ! -L "$devcontainer_env" ]]; then
  if ! (umask 077; set -o noclobber; : > "$devcontainer_env") 2>/dev/null; then
    if [[ ! -e "$devcontainer_env" && ! -L "$devcontainer_env" ]]; then
      die "unable to create $devcontainer_env"
    fi
  fi
fi
