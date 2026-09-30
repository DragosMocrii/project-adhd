# shellcheck shell=bash
# adhd update: move the project-adhd installation to its channel's newest
# version, or to the channel --ref names.
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
# shellcheck disable=SC2154  # ADHD_HOME comes from bin/adhd

cmd_update() {
  local ref='' channel from to tag

  while (( $# > 0 )); do
    case "$1" in
      --ref)
        (( $# >= 2 )) || die '--ref needs a value'
        ref=$2
        shift 2
        ;;
      --ref=*)
        ref=${1#--ref=}
        shift
        ;;
      *)
        die 'usage: adhd update [--ref <release|branch|tag>]'
        ;;
    esac
  done
  [[ "$ref" != checkout ]] || die 'checkout is not a ref; it marks a development checkout'

  channel=$(adhd_channel)
  [[ "$channel" != checkout ]] ||
    die "$ADHD_HOME is a development checkout; update it with git (to let adhd manage it: git -C \"$ADHD_HOME\" config adhd.ref release)"
  [[ -z "$(git -C "$ADHD_HOME" status --porcelain --untracked-files=no)" ]] ||
    die "$ADHD_HOME has local changes; commit or discard them, then rerun"
  [[ -n "$ref" ]] || ref=$channel

  from=$(adhd_version)
  git -C "$ADHD_HOME" fetch --quiet --tags --prune origin || die "unable to fetch into $ADHD_HOME"
  move_to_ref "$ADHD_HOME" "$ref" || die "unable to update $ADHD_HOME to $ref"
  git -C "$ADHD_HOME" config adhd.ref "$ref" || die "unable to record adhd.ref in $ADHD_HOME"
  to=$(adhd_version)

  if [[ "$from" == "$to" ]]; then
    note "project-adhd is already at $to"
  else
    note "Updated project-adhd $from → $to"
  fi
  if tag=$(git -C "$ADHD_HOME" describe --tags --exact-match HEAD 2>/dev/null); then
    printf 'Release notes: %s/tag/%s\n' "$ADHD_RELEASES_URL" "$tag"
  fi
  printf 'Rerun "adhd attach <dir>" in each attached repository to refresh it.\n'
}
