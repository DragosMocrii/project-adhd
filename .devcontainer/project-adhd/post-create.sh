#!/usr/bin/env bash
set -euo pipefail

CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
export CLAUDE_CONFIG_DIR
export NPM_CONFIG_PREFIX="$HOME/.local"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:${PATH:-}"

POST_CREATE_DIR="${BASH_SOURCE[0]%/*}"
if [[ "$POST_CREATE_DIR" == "${BASH_SOURCE[0]}" ]]; then
  POST_CREATE_DIR=.
fi
LIB_DIR="$(cd "$POST_CREATE_DIR/lib" && pwd)"

# shellcheck disable=SC1091
source "$LIB_DIR/agent-tools.sh"

readonly -a STATE_ROOTS=(
  "$CLAUDE_CONFIG_DIR"
  "$HOME/.config/gh"
  "$HOME/.config/rtk"
  "$HOME/.local/share/rtk"
  "$HOME/.codex"
  "$HOME/.gemini"
  "$HOME/.omp"
  "$HOME/.local/state/project-adhd"
)
readonly -a INSTALLER_ROOTS=(
  "$HOME/.local"
  "$HOME/.local/bin"
  "$HOME/.local/share"
  "$HOME/.local/state"
  "$HOME/.bun"
  "$HOME/.bun/bin"
  "$HOME/.bun/install"
  "$HOME/.bun/install/global"
)

readonly POST_CREATE_LOCK_FILE="$HOME/.local/state/project-adhd/post-create.lock"
# Seconds to wait for another container's setup. Overridable for tests only.
POST_CREATE_LOCK_TIMEOUT="${POST_CREATE_LOCK_TIMEOUT:-600}"

die() {
  printf 'post-create: %s\n' "$*" >&2
  exit 1
}

repair_directory_ownership() {
  local dir owner uid gid
  uid="$(id -u)"
  gid="$(id -g)"

  for dir in "$@"; do
    if [[ ! -d "$dir" ]]; then
      sudo mkdir -p "$dir"
    fi

    owner="$(stat -c '%u:%g' "$dir")"
    if [[ "$owner" != "$uid:$gid" ]]; then
      printf '==> Taking ownership of %s\n' "$dir"
      sudo chown "$uid:$gid" "$dir"
    fi

    [[ -w "$dir" ]] || die "Directory is not writable: $dir"
  done
}

repair_state_ownership() {
  repair_directory_ownership "${STATE_ROOTS[@]}"
}

repair_installer_ownership() {
  repair_directory_ownership "${INSTALLER_ROOTS[@]}"
  [[ -w "$HOME/.bun" ]] || die "Bun home is not writable: $HOME/.bun"
}

configure_github_auth() {
  if gh auth status >/dev/null 2>&1; then
    echo '==> Configuring gh as the git credential helper'
    gh auth setup-git
  fi
}

trust_omp_dependencies() {
  local untrusted

  if ! untrusted="$(bun pm -g untrusted 2>&1)"; then
    printf 'post-create: unable to query untrusted Bun dependencies:\n%s\n' "$untrusted" >&2
    return 1
  fi
  case "$untrusted" in
    *onnxruntime-node*) bun pm -g trust onnxruntime-node ;;
  esac
  case "$untrusted" in
    *protobufjs*) bun pm -g trust protobufjs ;;
  esac

  if ! untrusted="$(bun pm -g untrusted 2>&1)"; then
    printf 'post-create: unable to query untrusted Bun dependencies:\n%s\n' "$untrusted" >&2
    return 1
  fi
  case "$untrusted" in
    *sharp*) bun pm -g trust sharp ;;
  esac
}

install_tools() {
  if agent_tool_selected claude; then
    if command -v claude >/dev/null 2>&1; then
      echo '==> Claude Code is already installed; skipping Claude installer'
    else
      echo '==> Installing Claude Code'
      curl -fsSL https://claude.ai/install.sh | bash
    fi
  fi

  if command -v rtk >/dev/null 2>&1 && rtk gain >/dev/null 2>&1; then
    echo '==> rtk is already installed and verified; skipping rtk installer'
  else
    echo '==> Installing rtk'
    curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
  fi

  if agent_tool_selected codex; then
    if command -v codex >/dev/null 2>&1; then
      echo '==> Codex is already installed; skipping Codex installer'
    else
      echo '==> Installing codex'
      curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh
    fi
  fi

  if agent_tool_selected gemini; then
    if command -v gemini >/dev/null 2>&1; then
      echo '==> Gemini CLI is already installed; skipping Gemini installer'
    else
      echo '==> Installing Gemini CLI'
      npm install -g --allow-scripts=@github/keytar @google/gemini-cli
    fi
  fi

  if agent_tool_selected omp; then
    if command -v omp >/dev/null 2>&1; then
      echo '==> OMP is already installed; skipping OMP installer'
    else
      echo '==> Installing omp (Oh My Pi)'
      bun install -g @oh-my-pi/pi-coding-agent
    fi

    echo '==> Trusting OMP runtime dependencies'
    trust_omp_dependencies
  fi
}

configure_rtk() {
  if agent_tool_selected claude; then
    echo '==> Configuring rtk for Claude Code'
    rtk init -g --auto-patch
  fi

  if agent_tool_selected codex; then
    echo '==> Configuring rtk for Codex'
    rtk init -g --codex
  fi

  if agent_tool_selected omp; then
    echo '==> Configuring rtk for OMP'
    PI_CODING_AGENT_DIR="$HOME/.omp/agent" rtk init -g --agent pi
  fi

  # Gemini CLI has no rtk integration yet; skipping it is intentional.
}

parse_claude_plugin_field() {
  local field="$1"
  local plugin_json="$2"

  printf '%s' "$plugin_json" | bun "$LIB_DIR/claude-plugins.ts" "$field"
}

parse_claude_marketplace_state() {
  local marketplace_json="$1"

  printf '%s' "$marketplace_json" | bun "$LIB_DIR/claude-marketplaces.ts" state
}

parse_codex_plugin_state() {
  local plugin_json="$1"

  printf '%s' "$plugin_json" | bun "$LIB_DIR/codex-plugins.ts" state
}

parse_codex_marketplace_name() {
  local marketplace_json="$1"

  printf '%s' "$marketplace_json" | bun "$LIB_DIR/codex-marketplaces.ts" name
}

CLAUDE_SUPERPOWERS_INSTALL_PATH=""

configure_claude_superpowers() {
  local claude_plugins claude_state claude_marketplaces marketplace_state install_path

  echo '==> Checking Claude Superpowers plugin'
  if ! claude_plugins="$(claude plugin list --json)"; then
    die 'Unable to list Claude plugins'
  fi
  if ! claude_state="$(parse_claude_plugin_field state "$claude_plugins")"; then
    die 'Unable to parse Claude plugin metadata'
  fi

  case "$claude_state" in
    missing)
      if ! claude_marketplaces="$(claude plugin marketplace list --json)"; then
        die 'Unable to list Claude marketplaces'
      fi
      if ! marketplace_state="$(parse_claude_marketplace_state "$claude_marketplaces")"; then
        die 'Unable to parse Claude marketplace metadata'
      fi
      case "$marketplace_state" in
        missing)
          claude plugin marketplace add anthropics/claude-plugins-official --scope user
          ;;
        present)
          claude plugin marketplace update claude-plugins-official
          ;;
        *)
          die "Unexpected Claude marketplace state: $marketplace_state"
          ;;
      esac
      claude plugin install superpowers@claude-plugins-official --scope user --yes
      ;;
    disabled)
      claude plugin enable superpowers@claude-plugins-official
      ;;
    enabled)
      ;;
    *)
      die "Unexpected Claude Superpowers state: $claude_state"
      ;;
  esac

  if ! claude_plugins="$(claude plugin list --json)"; then
    die 'Unable to list Claude plugins after Superpowers setup'
  fi
  if ! install_path="$(parse_claude_plugin_field installPath "$claude_plugins")"; then
    die 'Unable to find Claude Superpowers installPath'
  fi
  [[ -n "$install_path" ]] || die 'Claude Superpowers installPath is empty'
  CLAUDE_SUPERPOWERS_INSTALL_PATH="$install_path"
}

configure_codex_superpowers() {
  local codex_marketplaces codex_marketplace codex_plugins codex_state

  echo '==> Enabling Codex plugins'
  codex features enable plugins
  if ! codex_marketplaces="$(codex plugin marketplace list --json)"; then
    die 'Unable to list Codex marketplaces'
  fi
  if ! codex_marketplace="$(parse_codex_marketplace_name "$codex_marketplaces")"; then
    die 'No supported official Codex marketplace is available'
  fi

  echo '==> Checking Codex Superpowers plugin'
  if ! codex_plugins="$(codex plugin list --json)"; then
    die 'Unable to list Codex plugins'
  fi
  if ! codex_state="$(parse_codex_plugin_state "$codex_plugins")"; then
    die 'Unable to parse Codex plugin metadata'
  fi

  case "$codex_state" in
    installed)
      ;;
    missing)
      codex plugin add "superpowers@$codex_marketplace" --json
      ;;
    *)
      die "Unexpected Codex Superpowers state: $codex_state"
      ;;
  esac
}

configure_superpowers() {
  local deferred=0

  CLAUDE_SUPERPOWERS_INSTALL_PATH=""

  if agent_tool_selected claude; then
    if claude auth status >/dev/null 2>&1; then
      configure_claude_superpowers
    else
      echo '==> Superpowers setup deferred for claude - run: claude auth login'
      deferred=$((deferred + 1))
    fi
  fi

  if agent_tool_selected codex; then
    if codex login status >/dev/null 2>&1; then
      configure_codex_superpowers
    else
      echo '==> Superpowers setup deferred for codex - run: codex login'
      deferred=$((deferred + 1))
    fi
  fi

  if agent_tool_selected omp; then
    if [[ -n "$CLAUDE_SUPERPOWERS_INSTALL_PATH" ]]; then
      echo '==> Installing Claude Superpowers package into OMP'
      omp install "$CLAUDE_SUPERPOWERS_INSTALL_PATH" --scope user --force --json
    else
      echo '==> Skipping OMP Superpowers: requires claude in AGENT_TOOLS and an authenticated Claude'
    fi
  fi

  if (( deferred > 0 )); then
    echo '    After authenticating, rerun: bash .devcontainer/project-adhd/post-create.sh'
  fi
}

install_archify() {
  local source="$HOME/.agents/skills/archify"
  local destination
  local -a agents=() destinations=()

  if agent_tool_selected claude; then
    agents+=(claude-code)
    destinations+=("$CLAUDE_CONFIG_DIR/skills/archify")
  fi
  if agent_tool_selected codex; then
    agents+=(codex)
    destinations+=("$HOME/.codex/skills/archify")
  fi
  if agent_tool_selected omp; then
    destinations+=("$HOME/.omp/agent/skills/archify")
  fi

  if (( ${#destinations[@]} == 0 )); then
    echo '==> Skipping archify: no agent with an archify destination is selected'
    return 0
  fi

  if (( ${#agents[@]} == 0 )); then
    # Only omp is selected, but the skills CLI needs an agent target to create
    # "$source". claude-code is used only for that; just OMP gets a copy below.
    agents=(claude-code)
  fi

  echo "==> Installing the archify skill (${agents[*]})"
  bunx skills@latest add tt-a1i/archify -g -y --copy --agent "${agents[@]}" </dev/null

  [[ -d "$source" ]] || die "Archify skill source is missing: $source"

  for destination in "${destinations[@]}"; do
    mkdir -p "$(dirname "$destination")"
    rm -rf -- "$destination"
    cp -a -- "$source" "$destination"
  done
}

# Agent state volumes are shared by every attached repository, so two
# containers created at once must not install or enable plugins concurrently.
with_shared_state_lock() {
  exec 9>"$POST_CREATE_LOCK_FILE" || die "unable to open lock file: $POST_CREATE_LOCK_FILE"
  if ! flock -n 9; then
    echo '==> Waiting for another project-adhd setup to finish'
    flock -w "$POST_CREATE_LOCK_TIMEOUT" 9 ||
      die "timed out after ${POST_CREATE_LOCK_TIMEOUT}s waiting for $POST_CREATE_LOCK_FILE"
  fi
  # 9>&- closes the lock fd in children, so a stray background child cannot hold the lock.
  "$@" 9>&-
  flock -u 9
  exec 9>&-
}

configure_shared_state() {
  configure_rtk
  configure_superpowers
  install_archify
}

main() {
  agent_tools_init
  printf '==> Selected agent tools: %s\n' "$(agent_tools_summary)"
  repair_state_ownership
  repair_installer_ownership
  configure_github_auth
  install_tools
  with_shared_state_lock configure_shared_state
  echo '==> Post-create complete'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
