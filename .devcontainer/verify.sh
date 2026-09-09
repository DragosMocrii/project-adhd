#!/usr/bin/env bash
set -euo pipefail

CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
export CLAUDE_CONFIG_DIR
export PATH="$HOME/.bun/bin:$HOME/.local/bin:${PATH:-}"

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd)"

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
  local plugin_json install_path extension

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

  extension="$HOME/.omp/agent/extensions/rtk.ts"
  if [[ ! -f "$extension" || ! -r "$extension" ]]; then
    fail "OMP RTK extension is missing or unreadable: $extension"
  fi
}

check_archify() {
  local skill_root
  for skill_root in \
    "$CLAUDE_CONFIG_DIR/skills/archify" \
    "$HOME/.codex/skills/archify" \
    "$HOME/.omp/agent/skills/archify"; do
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
  local command_name
  for command_name in bun node python3 gh claude codex gemini omp rtk; do
    require_command "$command_name"
  done

  check_claude_plugin
  check_claude_settings
  check_codex_plugin
  check_omp_plugin
  check_archify
  check_rtk
  printf 'verify: all tool, plugin, hook, skill, and RTK checks passed\n'
}

main "$@"
