# shellcheck shell=bash
# adhd detach: remove an attached project-adhd runtime from a Git worktree.
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
# shellcheck disable=SC2154  # ADHD_* come from common.sh

detach_usage() {
  cat <<'EOF'
usage: adhd detach [dir]

Removes .devcontainer/project-adhd/ and its ignore rules from <dir> (default:
the current directory). Docker volumes are kept.
EOF
}

# other_worktree_attached <root>: succeeds when another worktree of the same
# repository still holds an untracked attachment, which needs the shared
# exclude block.
other_worktree_attached() {
  local root=$1 line path

  while IFS= read -r line; do
    case "$line" in
      "worktree "*) path=${line#worktree } ;;
      *) continue ;;
    esac
    path=$(cd -P -- "$path" 2>/dev/null && pwd -P) || continue
    [[ "$path" == "$root" ]] && continue
    if [[ "$(marker_get "$path/$ADHD_RUNTIME_REL/.adhd" mode 2>/dev/null)" == untracked ]]; then
      return 0
    fi
  done < <(git -C "$root" worktree list --porcelain)
  return 1
}

cmd_detach() {
  local target=. root runtime marker mode prefix

  while (( $# > 0 )); do
    case "$1" in
      -h|--help)
        detach_usage
        return 0
        ;;
      -*)
        die "unknown option: $1"
        ;;
      *)
        [[ "$target" == . ]] || die "unexpected argument: $1"
        target=$1
        shift
        ;;
    esac
  done

  root=$(require_worktree_root "$target")
  runtime="$root/$ADHD_RUNTIME_REL"
  marker="$runtime/.adhd"
  [[ -d "$runtime" ]] || die "nothing to detach: $ADHD_RUNTIME_REL does not exist in $root"
  [[ -f "$marker" ]] || die "$ADHD_RUNTIME_REL in $root was not created by adhd; refusing to remove it"
  mode=$(marker_get "$marker" mode) || die "unreadable marker: $marker"
  prefix=$(marker_get "$runtime/.env" PROJECT_STATE_PREFIX 2>/dev/null) || prefix=

  rm -rf -- "$runtime"
  rmdir "$root/.devcontainer" 2>/dev/null || true
  case "$mode" in
    untracked)
      if ! other_worktree_attached "$root"; then
        remove_block "$(git_common_dir "$root")/info/exclude"
      fi
      ;;
    tracked)
      remove_block "$root/.gitignore"
      ;;
    *)
      die "unknown attach mode in marker: $mode"
      ;;
  esac

  note "Detached project-adhd from $root (its devcontainer.env was removed)"
  if [[ -n "$prefix" ]]; then
    printf "Docker volumes were kept. List this repository's with: docker volume ls --filter name=%s\n" "$prefix"
  else
    printf 'Docker volumes were kept. List them with: docker volume ls --filter name=project-adhd\n'
  fi
}
