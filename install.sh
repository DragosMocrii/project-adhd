#!/usr/bin/env bash
# Install or update the adhd host CLI.
#
#   curl -fsSL https://raw.githubusercontent.com/DragosMocrii/project-adhd/main/install.sh | bash
#
# Run from a project-adhd checkout, it links that checkout instead of cloning.
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
set -euo pipefail

die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'install.sh: warning: %s\n' "$*" >&2
}

ADHD_REPO=${ADHD_REPO:-https://github.com/DragosMocrii/project-adhd.git}
ADHD_REF=${ADHD_REF:-main}
BIN_DIR="$HOME/.local/bin"

command -v git >/dev/null 2>&1 || die 'git is required'

self_dir=
if [[ -n "${BASH_SOURCE[0]-}" && -f "${BASH_SOURCE[0]}" ]]; then
  self_dir=$(cd -P -- "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
fi

if [[ -n "$self_dir" && -f "$self_dir/bin/adhd" && -e "$self_dir/.git" ]]; then
  ADHD_HOME=$self_dir
  echo "==> Using the checkout at $ADHD_HOME"
else
  ADHD_HOME=${ADHD_HOME:-$HOME/.local/share/project-adhd}
  if [[ -e "$ADHD_HOME/.git" ]]; then
    echo "==> Updating $ADHD_HOME"
    git -C "$ADHD_HOME" pull --ff-only || die "unable to fast-forward $ADHD_HOME"
  elif [[ -e "$ADHD_HOME" ]]; then
    die "$ADHD_HOME exists but is not a project-adhd checkout"
  else
    echo "==> Cloning project-adhd into $ADHD_HOME"
    mkdir -p "$(dirname "$ADHD_HOME")"
    git clone --quiet --branch "$ADHD_REF" "$ADHD_REPO" "$ADHD_HOME" ||
      die "unable to clone $ADHD_REPO"
  fi
fi

target="$ADHD_HOME/bin/adhd"
link="$BIN_DIR/adhd"
[[ -f "$target" ]] || die "$target is missing; the checkout is incomplete"
chmod +x "$target"
mkdir -p "$BIN_DIR"
if [[ -L "$link" ]]; then
  [[ "$(readlink "$link")" == "$target" ]] ||
    die "$link already points to $(readlink "$link"); remove it and rerun"
elif [[ -e "$link" ]]; then
  die "$link already exists and is not a symlink; remove it and rerun"
else
  ln -s "$target" "$link"
fi
echo "==> adhd is installed at $link"

case ":${PATH-}:" in
  *":$BIN_DIR:"*) ;;
  *)
    warn "$BIN_DIR is not on PATH. Add this line to ~/.zprofile (zsh) or ~/.bashrc (bash):"
    # shellcheck disable=SC2016  # the line is printed for the user, unexpanded
    printf '  export PATH="$HOME/.local/bin:$PATH"\n' >&2
    ;;
esac
command -v docker >/dev/null 2>&1 || warn 'docker is not installed; Dev Containers need it'
command -v gh >/dev/null 2>&1 || warn 'gh is not installed; adhd attach owner/repo and adhd new need it'
