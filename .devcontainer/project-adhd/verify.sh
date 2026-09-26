#!/usr/bin/env bash
set -euo pipefail

CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
export CLAUDE_CONFIG_DIR
export PATH="$HOME/.bun/bin:$HOME/.local/bin:${PATH:-}"

VERIFY_DIR="${BASH_SOURCE[0]%/*}"
if [[ "$VERIFY_DIR" == "${BASH_SOURCE[0]}" ]]; then
  VERIFY_DIR=.
fi
LIB_DIR="$(cd "$VERIFY_DIR/lib" && pwd)"

# shellcheck disable=SC1091
source "$LIB_DIR/agent-tools.sh"

VERIFY_PASSED=0
VERIFY_SKIPPED=0

record_pass() {
  VERIFY_PASSED=$((VERIFY_PASSED + 1))
}

record_skip() {
  VERIFY_SKIPPED=$((VERIFY_SKIPPED + 1))
  printf 'verify: SKIP %s\n' "$1"
}

fail() {
  printf 'verify: %s\n' "$*" >&2
  exit 1
}

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    fail "required command is not on PATH: $command_name"
  fi
}

check_claude_plugin() {
  local plugin_json state

  if ! plugin_json="$(claude plugin list --json)"; then
    fail 'claude plugin list --json failed'
  fi
  if ! state="$(printf '%s' "$plugin_json" | bun "$LIB_DIR/claude-plugins.ts" state)"; then
    fail 'unable to parse Claude plugin metadata'
  fi
  if [[ "$state" != enabled ]]; then
    fail "Claude plugin superpowers@claude-plugins-official is $state"
  fi
}

check_claude_settings() {
  local settings_path="$CLAUDE_CONFIG_DIR/settings.json"
  if [[ ! -f "$settings_path" || ! -r "$settings_path" ]]; then
    fail "Claude settings file is missing or unreadable: $settings_path"
  fi

  # shellcheck disable=SC2016
  if ! CLAUDE_SETTINGS_PATH="$settings_path" bun -e '
let settings;
try {
  settings = JSON.parse(await Bun.file(process.env.CLAUDE_SETTINGS_PATH).text());
} catch (error) {
  console.error(`Unable to parse Claude settings JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

function preToolUseSections(value) {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(preToolUseSections);

  const sections = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === "PreToolUse") sections.push(child);
    sections.push(...preToolUseSections(child));
  }
  return sections;
}

function hasCommand(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasCommand);
  if (value.command === "rtk hook claude") return true;
  return Object.values(value).some((child) =>
    child && typeof child === "object" && hasCommand(child),
  );
}

function hasBashMatcher(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasBashMatcher);
  for (const [key, child] of Object.entries(value)) {
    if (
      ["matcher", "tool", "toolName", "name"].includes(key) &&
      (child === "Bash" || (Array.isArray(child) && child.includes("Bash")))
    ) {
      return true;
    }
    if (child && typeof child === "object" && hasBashMatcher(child)) return true;
  }
  return false;
}

function hasBashPreToolUseHook(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasBashPreToolUseHook);
  if (hasCommand(value) && hasBashMatcher(value)) return true;
  return Object.values(value).some((child) =>
    child && typeof child === "object" && hasBashPreToolUseHook(child),
  );
}

const found = preToolUseSections(settings).some(hasBashPreToolUseHook);
if (!found) {
  console.error("Claude PreToolUse Bash hook rtk hook claude is missing");
  process.exit(1);
}
' >/dev/null; then
    fail 'Claude settings lack a Bash PreToolUse command rtk hook claude'
  fi
}

check_codex_plugin() {
  local plugin_json state required_file

  if ! plugin_json="$(codex plugin list --json)"; then
    fail 'codex plugin list --json failed'
  fi
  if ! state="$(printf '%s' "$plugin_json" | bun "$LIB_DIR/codex-plugins.ts" state)"; then
    fail 'unable to parse Codex plugin metadata'
  fi
  if [[ "$state" != installed ]]; then
    fail 'Codex installed plugin list does not contain superpowers'
  fi

  for required_file in "$HOME/.codex/AGENTS.md" "$HOME/.codex/RTK.md"; do
    if [[ ! -f "$required_file" || ! -r "$required_file" ]]; then
      fail "Codex required file is missing or unreadable: $required_file"
    fi
  done
}

check_omp_plugin() {
  local plugin_json install_path

  if ! plugin_json="$(omp plugin list --json)"; then
    fail 'omp plugin list --json failed'
  fi
  if ! install_path="$(printf '%s' "$plugin_json" | bun "$LIB_DIR/omp-plugins.ts" installPath)"; then
    fail 'OMP plugin list does not contain an enabled superpowers plugin with an install path'
  fi
  if [[ ! -f "$install_path/skills/using-superpowers/SKILL.md" ||
    ! -r "$install_path/skills/using-superpowers/SKILL.md" ]]; then
    fail "OMP superpowers package is missing skills/using-superpowers/SKILL.md: $install_path"
  fi
}

check_omp_rtk_extension() {
  local extension="$HOME/.omp/agent/extensions/rtk.ts"

  if [[ ! -f "$extension" || ! -r "$extension" ]]; then
    fail "OMP RTK extension is missing or unreadable: $extension"
  fi
}

check_archify() {
  local skill_root
  local -a roots=()

  if agent_tool_selected claude; then roots+=("$CLAUDE_CONFIG_DIR/skills/archify"); fi
  if agent_tool_selected codex; then roots+=("$HOME/.codex/skills/archify"); fi
  if agent_tool_selected omp; then roots+=("$HOME/.omp/agent/skills/archify"); fi

  if (( ${#roots[@]} == 0 )); then
    return 0
  fi

  for skill_root in "${roots[@]}"; do
    if [[ ! -f "$skill_root/SKILL.md" || ! -r "$skill_root/SKILL.md" ]]; then
      fail "Archify SKILL.md is missing or unreadable: $skill_root/SKILL.md"
    fi
  done
}

check_rtk() {
  if ! rtk gain >/dev/null 2>&1; then
    fail 'rtk gain failed; verify that rtk-ai/rtk is installed rather than the Rust Type Kit collision'
  fi
}

main() {
  local command_name tool
  local -a unselected=()

  agent_tools_init
  printf 'verify: selected agent tools: %s\n' "$(agent_tools_summary)"

  for command_name in bun node python3 gh rtk; do
    require_command "$command_name"
    record_pass
  done

  for tool in "${AGENT_TOOLS_KNOWN[@]}"; do
    if agent_tool_selected "$tool"; then
      require_command "$tool"
      record_pass
    else
      unselected+=("$tool")
    fi
  done

  if agent_tool_selected claude; then
    check_claude_plugin
    record_pass
    check_claude_settings
    record_pass
  else
    record_skip 'Claude plugin and settings checks (claude not selected)'
  fi

  if agent_tool_selected codex; then
    check_codex_plugin
    record_pass
  else
    record_skip 'Codex plugin check (codex not selected)'
  fi

  if agent_tool_selected omp; then
    check_omp_rtk_extension
    record_pass
    if agent_tool_selected claude; then
      check_omp_plugin
      record_pass
    else
      record_skip 'OMP Superpowers check (requires claude in AGENT_TOOLS)'
    fi
  else
    record_skip 'OMP checks (omp not selected)'
  fi

  if agent_tool_selected claude || agent_tool_selected codex || agent_tool_selected omp; then
    check_archify
    record_pass
  else
    record_skip 'Archify skill check (no selected tool has an archify destination)'
  fi
  check_rtk
  record_pass

  if (( ${#unselected[@]} > 0 )); then
    printf 'verify: %d passed, %d skipped (%s not selected)\n' \
      "$VERIFY_PASSED" "$VERIFY_SKIPPED" "$(agent_tools_join "${unselected[@]}")"
  else
    printf 'verify: %d passed, %d skipped\n' "$VERIFY_PASSED" "$VERIFY_SKIPPED"
  fi
}

main "$@"
