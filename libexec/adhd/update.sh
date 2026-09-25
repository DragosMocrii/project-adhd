# shellcheck shell=bash
# adhd update: fast-forward the project-adhd installation.
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
# shellcheck disable=SC2154  # ADHD_HOME comes from bin/adhd

cmd_update() {
  (( $# == 0 )) || die 'usage: adhd update'
  git -C "$ADHD_HOME" pull --ff-only || die "unable to fast-forward $ADHD_HOME"
  note "Updated project-adhd in $ADHD_HOME"
  printf 'Rerun "adhd attach <dir>" in each attached repository to refresh it.\n'
}
