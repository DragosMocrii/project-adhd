# shellcheck shell=bash
# adhd version: print the installed project-adhd version and channel.
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
# shellcheck disable=SC2154  # ADHD_HOME comes from bin/adhd

cmd_version() {
  local channel

  (( $# == 0 )) || die 'usage: adhd version'
  channel=$(adhd_channel)
  if [[ "$channel" != release && "$channel" != checkout ]] &&
    git -C "$ADHD_HOME" show-ref --verify --quiet "refs/tags/$channel" 2>/dev/null; then
    channel="pinned $channel"
  fi
  printf 'adhd %s (%s)\n' "$(adhd_version)" "$channel"
}
