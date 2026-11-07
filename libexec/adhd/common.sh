# shellcheck shell=bash
# Shared helpers for the adhd host CLI. Sourced by bin/adhd, never executed.
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
# Callers set ADHD_HOME before sourcing.
# shellcheck disable=SC2034  # constants are used by the subcommand files

ADHD_RUNTIME_REL=.devcontainer/project-adhd
ADHD_RUNTIME_SOURCE="$ADHD_HOME/$ADHD_RUNTIME_REL"
ADHD_BLOCK_BEGIN='# >>> project-adhd'
ADHD_BLOCK_END='# <<< project-adhd'
ADHD_IGNORED_PATHS=(/.worktrees/ /.claude/worktrees/ /.superpowers/ /docs/superpowers/)

# Files attach copies into a target repository. Must match the tracked contents
# of .devcontainer/project-adhd/ other than .gitignore; a contract test checks.
ADHD_RUNTIME_FILES=(
  devcontainer.json
  devcontainer-lock.json
  docker-compose.yml
  initialize.sh
  post-create.sh
  verify.sh
  devcontainer.env.example
  image/Dockerfile
  lib/agent-tools.sh
  lib/claude-marketplaces.ts
  lib/claude-plugins.ts
  lib/codex-marketplaces.ts
  lib/codex-plugins.ts
  lib/collect.ts
  lib/omp-plugins.ts
)

die() {
  printf 'adhd: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '==> %s\n' "$*"
}

warn() {
  printf 'adhd: warning: %s\n' "$*" >&2
}

file_sha256() {
  local digest

  if command -v sha256sum >/dev/null 2>&1; then
    digest=$(sha256sum < "$1") || die "unable to hash $1"
  elif command -v shasum >/dev/null 2>&1; then
    digest=$(shasum -a 256 < "$1") || die "unable to hash $1"
  else
    die 'neither sha256sum nor shasum is available'
  fi
  printf '%s\n' "${digest%% *}"
}

# require_worktree_root <dir>: prints the canonical path of <dir>, which must
# be exactly the top level of a Git worktree.
require_worktree_root() {
  local dir=$1 canonical top

  [[ -d "$dir" ]] || die "not a directory: $dir"
  canonical=$(cd -P -- "$dir" && pwd -P) || die "unable to resolve: $dir"
  top=$(git -C "$canonical" rev-parse --show-toplevel 2>/dev/null) ||
    die "not a Git repository: $dir"
  top=$(cd -P -- "$top" && pwd -P) || die "unable to resolve: $top"
  [[ "$top" == "$canonical" ]] ||
    die "not the root of a Git worktree: $dir (its worktree root is $top)"
  printf '%s\n' "$canonical"
}

# refuse_symlinks <root>: dies when .devcontainer, the runtime folder, or
# anything inside it is a symlink. A repository can commit symlinks, and
# following one would redirect adhd's writes or rm -rf outside the worktree.
refuse_symlinks() {
  local root=$1 path found

  for path in "$root/.devcontainer" "$root/$ADHD_RUNTIME_REL"; do
    [[ ! -L "$path" ]] || die "refusing to follow the symlink $path"
  done
  [[ -d "$root/$ADHD_RUNTIME_REL" ]] || return 0
  found=$(find "$root/$ADHD_RUNTIME_REL" -type l -print) ||
    die "unable to inspect $root/$ADHD_RUNTIME_REL"
  [[ -z "$found" ]] || die "refusing to follow the symlink ${found%%$'\n'*}"
}

git_common_dir() {
  local root=$1 reported

  reported=$(git -C "$root" rev-parse --git-common-dir) ||
    die "unable to resolve the Git common directory of $root"
  case "$reported" in
    /*) ;;
    *) reported="$root/$reported" ;;
  esac
  (cd -P -- "$reported" && pwd -P) || die "unable to resolve: $reported"
}

# marker_get <file> <key>: prints the value of the first <key>=value line.
marker_get() {
  local file=$1 key=$2 line

  [[ -f "$file" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "$key="*)
        printf '%s\n' "${line#"$key="}"
        return 0
        ;;
    esac
  done < "$file"
  return 1
}

# remove_block <file>: drops the delimited project-adhd block, keeping the
# file's mode and every other line.
remove_block() {
  local file=$1 line inside=0 temporary

  [[ ! -L "$file" ]] || die "refusing to follow the symlink $file"
  [[ -f "$file" ]] || return 0
  temporary=$(mktemp "$file.adhd.XXXXXX") || die "unable to create a temporary file next to $file"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$ADHD_BLOCK_BEGIN" ]]; then
      inside=1
    elif [[ "$line" == "$ADHD_BLOCK_END" ]]; then
      inside=0
    elif (( inside == 0 )); then
      printf '%s\n' "$line"
    fi
  done < "$file" > "$temporary"
  cat "$temporary" > "$file"
  rm -f -- "$temporary"
}

# write_block <file>: replaces (or appends) the delimited project-adhd block.
write_block() {
  local file=$1 path

  remove_block "$file"
  if [[ -s "$file" && -n "$(tail -c 1 "$file")" ]]; then
    printf '\n' >> "$file"
  fi
  {
    printf '%s\n' "$ADHD_BLOCK_BEGIN"
    for path in "${ADHD_IGNORED_PATHS[@]}"; do
      printf '%s\n' "$path"
    done
    printf '%s\n' "$ADHD_BLOCK_END"
  } >> "$file"
}

# Runtime sync, shared by attach and refresh. Set ADHD_SYNC_DRY_RUN=1 to
# report what would change without writing anything into the repository.
ADHD_SYNC_DRY_RUN=0
# Marker temp file of a sync in progress; the callers' EXIT traps remove it.
ADHD_MARKER_TEMP=''
# Set ADHD_SYNC_PORCELAIN=1 for stable, tab-separated output.
ADHD_SYNC_PORCELAIN=0
# Counts of the lines sync_report printed during this run.
ADHD_SYNC_CHANGES=0
ADHD_SYNC_CONFLICTS=0

# sync_report <action> <file> [detail]: prints one line of the change list.
# In porcelain mode: <action>\t<file>[\t<detail>]
# In human mode:
#   action file
#   action file -> detail
sync_report() {
  local action=$1 file=$2 detail=${3-}
  ADHD_SYNC_CHANGES=$((ADHD_SYNC_CHANGES + 1))
  case "$action" in
    conflict|review) ADHD_SYNC_CONFLICTS=$((ADHD_SYNC_CONFLICTS + 1)) ;;
  esac
  if (( ADHD_SYNC_PORCELAIN )); then
    if [[ -n "$detail" ]]; then
      printf '%s\t%s\t%s\n' "$action" "$file" "$detail"
    else
      printf '%s\t%s\n' "$action" "$file"
    fi
  else
    if [[ -n "$detail" ]]; then
      printf '  %-9s %s -> %s\n' "$action" "$file" "$detail"
    else
      printf '  %-9s %s\n' "$action" "$file"
    fi
  fi
}

in_manifest() {
  local candidate=$1 file

  for file in "${ADHD_RUNTIME_FILES[@]}"; do
    [[ "$file" == "$candidate" ]] && return 0
  done
  return 1
}

# merge_runtime_file <file> <destination> <source> <marker> <version>: three-way
# merges the user's <destination> with the newly shipped <source>. The base is
# the version the marker's source= revision shipped, used only when its sha
# matches the marker's sha:<file>. Sets ADHD_MERGE_RESULT to merged, conflict,
# or nobase, and ADHD_MERGE_HUNKS to the conflict count. Unless dry-run, a clean
# merge is written into <destination>; a conflict (with markers) or, without a
# base, the plain new version is written to <destination>.adhd-new. The user's
# file is never overwritten otherwise.
merge_runtime_file() {
  local file=$1 destination=$2 source=$3 marker=$4 version=$5 revision recorded base merged rc=0

  ADHD_MERGE_RESULT=nobase
  ADHD_MERGE_HUNKS=0
  revision=$(marker_get "$marker" source) || revision=''
  recorded=$(marker_get "$marker" "sha:$file") || recorded=''
  base=$(mktemp "${TMPDIR:-/tmp}/adhd-base.XXXXXX") || die 'unable to create a temporary file'
  merged=$(mktemp "${TMPDIR:-/tmp}/adhd-merged.XXXXXX") || die 'unable to create a temporary file'
  if [[ -n "$revision" && "$revision" != unknown && -n "$recorded" ]] &&
    git -C "$ADHD_HOME" show "$revision:$ADHD_RUNTIME_REL/$file" > "$base" 2>/dev/null &&
    [[ "$(file_sha256 "$base")" == "$recorded" ]]; then
    git merge-file -p -L yours -L 'adhd (previous)' -L "adhd $version" \
      "$destination" "$base" "$source" > "$merged" 2>/dev/null || rc=$?
    if (( rc == 0 )); then
      ADHD_MERGE_RESULT=merged
    elif (( rc > 0 && rc < 128 )); then
      ADHD_MERGE_RESULT=conflict
      ADHD_MERGE_HUNKS=$rc
    fi
  fi
  if (( ADHD_SYNC_DRY_RUN == 0 )); then
    case "$ADHD_MERGE_RESULT" in
      merged)
        cat "$merged" > "$destination"
        rm -f -- "$destination.adhd-new"
        ;;
      conflict)
        cp "$merged" "$destination.adhd-new"
        ;;
      *)
        cp -p "$source" "$destination.adhd-new"
        ;;
    esac
  fi
  rm -f -- "$base" "$merged"
}

# copy_runtime <runtime> <marker> <body> <version>: brings every runtime file up
# to date, appends its sha line to <body>, and prints the change list. A file
# the user edited is merged with the new version (see merge_runtime_file); the
# new sha is recorded either way, so a version is offered only once.
copy_runtime() {
  local runtime=$1 marker=$2 body=$3 version=$4 file source destination recorded='' shipped current

  for file in "${ADHD_RUNTIME_FILES[@]}"; do
    source="$ADHD_RUNTIME_SOURCE/$file"
    destination="$runtime/$file"
    [[ -f "$source" ]] || die "the installation is incomplete (missing $source); run: adhd update"
    shipped=$(file_sha256 "$source")
    printf 'sha:%s=%s\n' "$file" "$shipped" >> "$body"
    if [[ ! -f "$destination" ]]; then
      if (( ADHD_SYNC_DRY_RUN == 0 )); then
        mkdir -p "$(dirname "$destination")"
        cp -p "$source" "$destination"
      fi
      # A first attach adds everything; list additions only on a refresh.
      [[ ! -f "$marker" ]] || sync_report added "$file"
      continue
    fi
    current=$(file_sha256 "$destination")
    recorded=$(marker_get "$marker" "sha:$file") || recorded=''
    if [[ "$current" == "$shipped" ]]; then
      (( ADHD_SYNC_DRY_RUN )) || rm -f -- "$destination.adhd-new"
    elif [[ "$current" == "$recorded" ]]; then
      (( ADHD_SYNC_DRY_RUN )) || cp -p "$source" "$destination"
      sync_report updated "$file"
    elif [[ "$shipped" != "$recorded" ]]; then
      merge_runtime_file "$file" "$destination" "$source" "$marker" "$version"
      if [[ "$ADHD_MERGE_RESULT" == merged ]]; then
        sync_report merged "$file"
      elif [[ "$ADHD_MERGE_RESULT" == conflict ]]; then
        sync_report conflict "$file" "$file.adhd-new ($ADHD_MERGE_HUNKS hunk$([[ $ADHD_MERGE_HUNKS == 1 ]] || printf 's'))"
        warn "kept your edited $ADHD_RUNTIME_REL/$file; merge $file.adhd-new into it"
      else
        sync_report review "$file" "$file.adhd-new (no base; compare by hand)"
        warn "kept your edited $ADHD_RUNTIME_REL/$file; merge $file.adhd-new into it"
      fi
    fi
    # Otherwise the user edited it and nothing new shipped: keep it silently.
  done
}

# prune_removed <runtime> <marker>: deletes files the marker lists that are no
# longer in the manifest, unless the user edited them.
prune_removed() {
  local runtime=$1 marker=$2 line file recorded

  [[ -f "$marker" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      sha:*) ;;
      *) continue ;;
    esac
    file=${line#sha:}
    file=${file%%=*}
    recorded=${line#*=}
    in_manifest "$file" && continue
    [[ -f "$runtime/$file" ]] || continue
    if [[ "$(file_sha256 "$runtime/$file")" == "$recorded" ]]; then
      (( ADHD_SYNC_DRY_RUN )) || rm -f -- "$runtime/$file"
      sync_report removed "$file"
    else
      warn "kept $ADHD_RUNTIME_REL/$file: project-adhd no longer ships it, but you edited it"
    fi
  done < "$marker"
}

# write_marker <runtime> <mode> <version>: refreshes the runtime and records
# what was written. In dry-run it only reports.
write_marker() {
  local runtime=$1 mode=$2 version=$3 marker="$1/.adhd" body revision

  if (( ADHD_SYNC_DRY_RUN )); then
    body=$(mktemp "${TMPDIR:-/tmp}/adhd-marker.XXXXXX") || die 'unable to create a temporary file'
  else
    body=$(mktemp "$runtime/.adhd.XXXXXX") || die "unable to create a temporary file in $runtime"
  fi
  ADHD_MARKER_TEMP=$body
  revision=$(git -C "$ADHD_HOME" rev-parse HEAD 2>/dev/null) || revision=unknown
  {
    printf 'mode=%s\n' "$mode"
    printf 'source=%s\n' "$revision"
    printf 'version=%s\n' "$version"
  } > "$body"
  copy_runtime "$runtime" "$marker" "$body" "$version"
  prune_removed "$runtime" "$marker"
  if (( ADHD_SYNC_DRY_RUN )); then
    rm -f -- "$body"
  else
    mv -f -- "$body" "$marker"
  fi
  ADHD_MARKER_TEMP=''
}

# write_ignore_rules <root> <runtime> <mode>
write_ignore_rules() {
  local root=$1 runtime=$2 mode=$3 common

  case "$mode" in
    untracked)
      printf '*\n' > "$runtime/.gitignore"
      common=$(git_common_dir "$root")
      mkdir -p "$common/info"
      write_block "$common/info/exclude"
      ;;
    tracked)
      printf '%s' "$ADHD_TRACKED_GITIGNORE" > "$runtime/.gitignore"
      write_block "$root/.gitignore"
      ;;
    *)
      die "unknown attach mode: $mode"
      ;;
  esac
}

# validate_agents <list>: dies on an unknown tool; sets AGENT_TOOLS_SELECTED.
validate_agents() {
  AGENT_TOOLS=$1 agent_tools_init
}

selected_agents_csv() {
  local IFS=,
  printf '%s' "${AGENT_TOOLS_SELECTED[*]}"
}

# Ignore rules committed with a tracked attachment.
ADHD_TRACKED_GITIGNORE=$'/.env\n/devcontainer.env\n*.adhd-new\n'

require_gh() {
  command -v gh >/dev/null 2>&1 ||
    die 'gh is required for this command; install the GitHub CLI, then run: gh auth login'
  gh auth status >/dev/null 2>&1 ||
    die 'gh is not authenticated on this host; run: gh auth login'
}

# adhd_version: prints the running version. On a clean checkout of tag
# v<VERSION> that is just VERSION; elsewhere git describe adds the commits past
# the nearest tag and a .dirty suffix, e.g. 0.1.0+5.gabc1234.dirty. Without
# git it falls back to VERSION alone.
adhd_version() {
  local version='' described dirty='' hash count tag

  if [[ -f "$ADHD_HOME/VERSION" ]]; then
    IFS= read -r version < "$ADHD_HOME/VERSION" || true
  fi
  [[ -n "$version" ]] || version=unknown
  if ! described=$(git -C "$ADHD_HOME" describe --tags --long --dirty --match 'v[0-9]*' 2>/dev/null); then
    printf '%s\n' "$version"
    return 0
  fi
  case "$described" in
    *-dirty)
      dirty=.dirty
      described=${described%-dirty}
      ;;
  esac
  hash=${described##*-}
  described=${described%-*}
  count=${described##*-}
  tag=${described%-*}
  if [[ "$count" == 0 && -z "$dirty" && "$tag" == "v$version" ]]; then
    printf '%s\n' "$version"
  else
    printf '%s+%s.%s%s\n' "$version" "$count" "$hash" "$dirty"
  fi
}

# adhd_channel: prints what this installation follows (its adhd.ref): release,
# a branch, a tag, or checkout. Installs from before releases have no adhd.ref;
# only the default location was made by install.sh, so anywhere else is a
# checkout someone develops in and must not be moved.
adhd_channel() {
  local ref default_home

  if ref=$(git -C "$ADHD_HOME" config --get adhd.ref 2>/dev/null); then
    printf '%s\n' "$ref"
    return 0
  fi
  default_home=$(cd -P -- "$HOME/.local/share/project-adhd" 2>/dev/null && pwd -P) || default_home=''
  if [[ -n "$default_home" && "$ADHD_HOME" == "$default_home" ]]; then
    printf 'release\n'
  else
    printf 'checkout\n'
  fi
}

ADHD_RELEASES_URL=https://github.com/DragosMocrii/project-adhd/releases

# latest_release_tag <home>: prints the newest vX.Y.Z tag, skipping
# pre-releases (any tag with a -). Kept identical in install.sh.
latest_release_tag() {
  local tags tag

  tags=$(git -C "$1" tag --list 'v[0-9]*' --sort=-v:refname) || return 1
  while IFS= read -r tag; do
    case "$tag" in
      ''|*-*) continue ;;
    esac
    printf '%s\n' "$tag"
    return 0
  done <<< "$tags"
  return 1
}

# move_to_ref <home> <ref>: checks out <ref> in <home>. release is the newest
# release tag (main while there is none), a tag is checked out detached, and a
# branch is fast-forwarded to origin. Kept identical in install.sh.
move_to_ref() {
  local home=$1 ref=$2 tag

  if [[ "$ref" == release ]]; then
    if tag=$(latest_release_tag "$home"); then
      git -C "$home" checkout --quiet --detach "refs/tags/$tag"
      return
    fi
    warn 'no release found; following main'
    ref=main
  fi
  if git -C "$home" show-ref --verify --quiet "refs/tags/$ref"; then
    git -C "$home" checkout --quiet --detach "refs/tags/$ref"
  elif git -C "$home" show-ref --verify --quiet "refs/remotes/origin/$ref"; then
    git -C "$home" checkout --quiet "$ref" &&
      git -C "$home" merge --quiet --ff-only "origin/$ref"
  else
    warn "no release tag or branch named $ref"
    return 1
  fi
}
