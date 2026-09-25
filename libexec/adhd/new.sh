# shellcheck shell=bash
# adhd new: create a GitHub repository and attach project-adhd to it, tracked.
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
# shellcheck disable=SC2154  # ADHD_HOME comes from bin/adhd

# shellcheck disable=SC1091
source "$ADHD_HOME/libexec/adhd/attach.sh"

new_usage() {
  cat <<'EOF'
usage: adhd new <name> [--public] [--agents <list>]

Creates a private (or --public) GitHub repository with gh, clones it into
./<name>, and attaches project-adhd in tracked mode. Nothing is committed.
EOF
}

cmd_new() {
  local name='' visibility=--private agents='' agents_given=0 directory
  local -a attach_args=(--track)

  while (( $# > 0 )); do
    case "$1" in
      --public)
        visibility=--public
        shift
        ;;
      --agents)
        (( $# >= 2 )) || die '--agents needs a value'
        agents=$2
        agents_given=1
        shift 2
        ;;
      --agents=*)
        agents=${1#--agents=}
        agents_given=1
        shift
        ;;
      -h|--help)
        new_usage
        return 0
        ;;
      -*)
        die "unknown option: $1"
        ;;
      *)
        [[ -z "$name" ]] || die "unexpected argument: $1"
        name=$1
        shift
        ;;
    esac
  done
  if [[ -z "$name" ]]; then
    new_usage >&2
    exit 1
  fi
  [[ "$name" =~ ^([A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+$ ]] || die "invalid repository name: $name"
  if (( agents_given )); then
    validate_agents "$agents"
    attach_args+=(--agents "$agents")
  fi

  directory=${name##*/}
  [[ ! -e "$directory" ]] || die "$directory already exists"
  require_gh
  note "Creating $name ($visibility)"
  gh repo create "$name" "$visibility" --clone || die "gh repo create failed for $name"

  cmd_attach "$directory" "${attach_args[@]}"
  cat <<EOF
Suggested first commit:
  cd "$directory" && git add -A && git commit -m "chore: add project-adhd dev container"
EOF
}
