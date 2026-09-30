#!/usr/bin/env bash
# Install or update the adhd host CLI.
#
#   curl -fsSL https://raw.githubusercontent.com/DragosMocrii/project-adhd/main/install.sh | bash
#
# Run from a project-adhd checkout, it links that checkout instead of cloning.
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
# main is called on the last line, so a truncated download runs nothing.
set -euo pipefail

die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'install.sh: warning: %s\n' "$*" >&2
}

# check_link <link> <target>: dies when <link> exists and is not a symlink to <target>.
check_link() {
  local link=$1 target=$2

  if [[ -L "$link" ]]; then
    [[ "$(readlink "$link")" == "$target" ]] ||
      die "$link already points to $(readlink "$link"); remove it and rerun"
  elif [[ -e "$link" ]]; then
    die "$link already exists and is not a symlink; remove it and rerun"
  fi
}

main() {
  local repo=${ADHD_REPO:-https://github.com/DragosMocrii/project-adhd.git}
  local ref=${ADHD_REF:-main}
  local bin_dir="$HOME/.local/bin"
  local self_dir='' from_checkout=0 adhd_home target link

  command -v git >/dev/null 2>&1 || die 'git is required'

  if [[ -n "${BASH_SOURCE[0]-}" && -f "${BASH_SOURCE[0]}" ]]; then
    self_dir=$(cd -P -- "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
  fi
  if [[ -n "$self_dir" && -f "$self_dir/bin/adhd" && -e "$self_dir/.git" ]]; then
    adhd_home=$self_dir
    from_checkout=1
  else
    adhd_home=${ADHD_HOME:-$HOME/.local/share/project-adhd}
  fi
  target="$adhd_home/bin/adhd"
  link="$bin_dir/adhd"
  check_link "$link" "$target"

  if (( from_checkout )); then
    echo "==> Using the checkout at $adhd_home"
  elif [[ -e "$adhd_home/.git" && -f "$adhd_home/bin/adhd" ]]; then
    echo "==> Updating $adhd_home"
    git -C "$adhd_home" pull --ff-only || die "unable to fast-forward $adhd_home"
  elif [[ -e "$adhd_home" ]]; then
    die "$adhd_home exists but is not a project-adhd checkout"
  else
    echo "==> Cloning project-adhd into $adhd_home"
    mkdir -p "$(dirname "$adhd_home")"
    git clone --quiet --branch "$ref" "$repo" "$adhd_home" ||
      die "unable to clone $repo"
  fi

  [[ -f "$target" ]] || die "$target is missing; the checkout is incomplete"
  chmod +x "$target"
  mkdir -p "$bin_dir"
  if [[ ! -L "$link" ]]; then
    ln -s "$target" "$link"
  fi
  echo "==> adhd is installed at $link"

  case ":${PATH-}:" in
    *":$bin_dir:"*) ;;
    *)
      warn "$bin_dir is not on PATH. Add this line to ~/.zprofile (zsh) or ~/.bashrc (bash):"
      # shellcheck disable=SC2016  # the line is printed for the user, unexpanded
      printf '  export PATH="$HOME/.local/bin:$PATH"\n' >&2
      ;;
  esac
  command -v docker >/dev/null 2>&1 || warn 'docker is not installed; Dev Containers need it'
  command -v gh >/dev/null 2>&1 || warn 'gh is not installed; adhd attach owner/repo and adhd new need it'
}

main "$@"
