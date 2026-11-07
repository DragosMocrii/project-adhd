# shellcheck shell=bash
# adhd refresh: bring an attached repository's runtime up to the installed
# project-adhd version, merging in files the user edited.
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
# shellcheck disable=SC2154  # ADHD_* come from common.sh

refresh_usage() {
  cat <<'EOF'
usage: adhd refresh [dir] [--dry-run] [--force] [--porcelain]

Brings <dir>/.devcontainer/project-adhd/ (default: the current directory) up
to the installed project-adhd version. Run adhd update first to get a newer one.
Files you edited are three-way merged with the new version; on a conflict your
file is kept and the merge, with conflict markers, is written to <file>.adhd-new.

  --dry-run    list what would change, and change nothing
  --force      in tracked mode, refresh even with uncommitted runtime changes
  --porcelain  machine-readable output: <action>\t<file>[\t<detail>]
EOF
}

refresh_cleanup() {
  local status=$?

  (( status != 0 )) || return 0
  if [[ -n "$ADHD_MARKER_TEMP" ]]; then
    rm -f -- "$ADHD_MARKER_TEMP"
  fi
}

cmd_refresh() {
  local target=. target_given=0 dry_run=0 force=0 porcelain=0 root runtime marker mode previous version changes tracked_files

  while (( $# > 0 )); do
    case "$1" in
      --dry-run)
        dry_run=1
        shift
        ;;
      --force)
        force=1
        shift
        ;;
      --porcelain)
        porcelain=1
        shift
        ;;
      -h|--help)
        refresh_usage
        return 0
        ;;
      -*)
        die "unknown option: $1"
        ;;
      *)
        (( target_given == 0 )) || die "unexpected argument: $1"
        target=$1
        target_given=1
        shift
        ;;
    esac
  done

  root=$(require_worktree_root "$target")
  runtime="$root/$ADHD_RUNTIME_REL"
  marker="$runtime/.adhd"
  refuse_symlinks "$root"
  if [[ ! -e "$runtime" ]]; then
    die "project-adhd is not attached to $root; run: adhd attach $target"
  fi
  [[ -f "$marker" ]] ||
    die "$ADHD_RUNTIME_REL in $root was not created by adhd; refusing to refresh it"
  mode=$(marker_get "$marker" mode) || die "unreadable marker: $marker"
  case "$mode" in
    untracked)
      tracked_files=$(git -C "$root" ls-files -- "$ADHD_RUNTIME_REL")
      [[ -z "$tracked_files" ]] ||
        die "git tracks files in $ADHD_RUNTIME_REL, but it was attached untracked; detach and attach it with --track"
      ;;
    tracked)
      [[ ! -L "$root/.gitignore" ]] || die "refusing to follow the symlink $root/.gitignore"
      changes=$(git -C "$root" status --porcelain -- "$ADHD_RUNTIME_REL") ||
        die "unable to read the git status of $root"
      if [[ -n "$changes" ]] && (( force == 0 && dry_run == 0 )); then
        die "$ADHD_RUNTIME_REL has uncommitted changes; commit or stash them so the refresh is a reviewable diff, or rerun with --force"
      fi
      ;;
    *)
      die "unknown attach mode in marker: $mode"
      ;;
  esac

  version=$(adhd_version)
  previous=$(marker_get "$marker" version) || previous=''

  if (( porcelain )); then
    # shellcheck disable=SC2034  # read by the sync helpers in common.sh
    ADHD_SYNC_PORCELAIN=1
  fi

  if (( dry_run )); then
    # shellcheck disable=SC2034  # read by the sync helpers in common.sh
    ADHD_SYNC_DRY_RUN=1
    trap refresh_cleanup EXIT
    write_marker "$runtime" "$mode" "$version"
    trap - EXIT
    if (( porcelain == 0 )); then
      (( ADHD_SYNC_CHANGES )) || printf '  nothing to change\n'
      if [[ -n "$previous" && "$previous" != "$version" ]]; then
        note "Dry run: would refresh $root: $previous → $version; nothing was changed"
      else
        note "Dry run: nothing was changed"
      fi
    fi
    if (( ADHD_SYNC_CONFLICTS )); then
      return 3
    fi
    return 0
  fi

  trap refresh_cleanup EXIT
  write_marker "$runtime" "$mode" "$version"
  write_ignore_rules "$root" "$runtime" "$mode"
  trap - EXIT

  if (( porcelain == 0 )); then
    if [[ -n "$previous" && "$previous" != "$version" ]]; then
      note "Refreshed project-adhd in $root: $previous → $version"
    elif (( ADHD_SYNC_CHANGES )); then
      note "Refreshed project-adhd in $root ($version)"
    else
      note "project-adhd in $root is already up to date ($version)"
    fi
    if (( ADHD_SYNC_CONFLICTS )); then
      printf 'Merge each <file>.adhd-new into its file, then delete the .adhd-new files.\n'
    fi
    if [[ ! -e "$runtime/devcontainer.env" ]]; then
      printf 'No devcontainer.env; to create one, run: adhd attach %s --agents <list>\n' "$target"
    fi
    if [[ "$mode" == tracked ]] && (( ADHD_SYNC_CHANGES )); then
      printf 'Review the changes with: git -C "%s" diff -- %s\n' "$root" "$ADHD_RUNTIME_REL"
    fi
  fi

  if (( ADHD_SYNC_CONFLICTS )); then
    return 3
  fi
}
