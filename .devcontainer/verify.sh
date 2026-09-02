#!/usr/bin/env bash
set -euo pipefail

CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
export CLAUDE_CONFIG_DIR
export PATH="$HOME/.bun/bin:$HOME/.local/bin:${PATH:-}"

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
  local plugin_json
  if ! plugin_json="$(claude plugin list --json)"; then
    fail 'claude plugin list --json failed'
  fi

  if ! printf '%s' "$plugin_json" | bun -e '
const expectedId = "superpowers@claude-plugins-official";
let document;
try {
  document = JSON.parse(await Bun.stdin.text());
} catch (error) {
  console.error(`Unable to parse Claude plugin list JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

function collectEntries(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      entry && typeof entry === "object" ? collectEntries(entry) : [entry],
    );
  }
  if (!value || typeof value !== "object") return [];

  const entries = [];
  for (const key of ["plugins", "installedPlugins", "installed", "items", "data"]) {
    if (key in value) entries.push(...collectEntries(value[key]));
  }

  if (
    ["id", "pluginId", "name", "slug"].some((key) => typeof value[key] === "string") ||
    (value.plugin && typeof value.plugin === "object" && typeof value.plugin.id === "string")
  ) {
    entries.push(value);
  }

  if (entries.length === 0) {
    for (const [key, child] of Object.entries(value)) {
      if (key === expectedId) {
        entries.push(
          child && typeof child === "object" && !Array.isArray(child)
            ? { ...child, id: expectedId }
            : { id: expectedId, installed: child },
        );
      }
    }
  }
  return entries;
}

function identifiers(entry) {
  if (typeof entry === "string") return [entry];
  if (!entry || typeof entry !== "object") return [];
  return [entry.id, entry.pluginId, entry.plugin?.id, entry.name, entry.slug]
    .filter((value) => typeof value === "string");
}

const plugin = collectEntries(document).find((entry) =>
  identifiers(entry).some((identifier) => identifier === expectedId),
);
if (!plugin) {
  console.error(`Claude plugin ${expectedId} is missing`);
  process.exit(1);
}

const metadata = plugin && typeof plugin === "object" ? plugin : {};
const status = String(metadata.status ?? metadata.state ?? "").toLowerCase();
const disabled = metadata.enabled === false ||
  metadata.enabled === "false" ||
  metadata.isEnabled === false ||
  metadata.disabled === true ||
  ["disabled", "off", "inactive"].includes(status);
if (disabled) {
  console.error(`Claude plugin ${expectedId} is disabled`);
  process.exit(1);
}
' >/dev/null; then
    fail 'Claude plugin superpowers@claude-plugins-official is missing or disabled'
  fi
}

check_claude_settings() {
  local settings_path="$CLAUDE_CONFIG_DIR/settings.json"
  if [[ ! -f "$settings_path" || ! -r "$settings_path" ]]; then
    fail "Claude settings file is missing or unreadable: $settings_path"
  fi

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
  local plugin_json
  if ! plugin_json="$(codex plugin list --json)"; then
    fail 'codex plugin list --json failed'
  fi

  if ! printf '%s' "$plugin_json" | bun -e '
const expectedIds = new Set(["superpowers", "superpowers@openai-api-curated"]);
let document;
try {
  document = JSON.parse(await Bun.stdin.text());
} catch (error) {
  console.error(`Unable to parse Codex plugin list JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

function collectEntries(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      entry && typeof entry === "object" ? collectEntries(entry) : [entry],
    );
  }
  if (!value || typeof value !== "object") return [];

  const entries = [];
  for (const key of ["plugins", "installedPlugins", "installed", "items", "data"]) {
    if (key in value) entries.push(...collectEntries(value[key]));
  }
  if (
    ["id", "pluginId", "name", "slug", "package"].some((key) => typeof value[key] === "string") ||
    (value.plugin && typeof value.plugin === "object" && typeof value.plugin.id === "string")
  ) {
    entries.push(value);
  }

  if (entries.length === 0) {
    for (const [key, child] of Object.entries(value)) {
      if (expectedIds.has(key)) {
        entries.push(
          child && typeof child === "object" && !Array.isArray(child)
            ? { ...child, id: key }
            : { id: key, installed: child },
        );
      }
    }
  }
  return entries;
}

function identifiers(entry) {
  if (typeof entry === "string") return [entry];
  if (!entry || typeof entry !== "object") return [];
  return [entry.id, entry.pluginId, entry.name, entry.slug, entry.package, entry.plugin?.id]
    .filter((value) => typeof value === "string");
}

function isInstalled(entry) {
  if (!entry || typeof entry !== "object") return true;
  const status = String(entry.status ?? entry.state ?? "")
    .toLowerCase()
    .replaceAll("_", "-")
    .replaceAll(" ", "-");
  return entry.installed !== false &&
    entry.installed !== "false" &&
    !["not-installed", "uninstalled", "available"].includes(status);
}

const installed = collectEntries(document).some((entry) =>
  identifiers(entry).some((identifier) => expectedIds.has(identifier)) && isInstalled(entry),
);
if (!installed) {
  console.error("Codex installed plugin list does not contain superpowers");
  process.exit(1);
}
' >/dev/null; then
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

  if ! install_path="$(printf '%s' "$plugin_json" | bun -e '
const expectedId = "superpowers";
let document;
try {
  document = JSON.parse(await Bun.stdin.text());
} catch (error) {
  console.error(`Unable to parse OMP plugin list JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

function collectEntries(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      entry && typeof entry === "object" ? collectEntries(entry) : [entry],
    );
  }
  if (!value || typeof value !== "object") return [];

  const entries = [];
  for (const key of ["plugins", "npm", "installedPlugins", "installed", "items", "data"]) {
    if (key in value) entries.push(...collectEntries(value[key]));
  }
  if (
    ["id", "pluginId", "name", "slug", "package"].some((key) => typeof value[key] === "string") ||
    (value.plugin && typeof value.plugin === "object" && typeof value.plugin.id === "string")
  ) {
    entries.push(value);
  }
  if (entries.length === 0) {
    for (const [key, child] of Object.entries(value)) {
      if (key === expectedId) {
        entries.push(
          child && typeof child === "object" && !Array.isArray(child)
            ? { ...child, name: expectedId }
            : { name: expectedId, installed: child },
        );
      }
    }
  }
  return entries;
}

function identifiers(entry) {
  if (typeof entry === "string") return [entry];
  if (!entry || typeof entry !== "object") return [];
  return [entry.id, entry.pluginId, entry.name, entry.slug, entry.package, entry.plugin?.id]
    .filter((value) => typeof value === "string");
}

function isDisabled(entry) {
  if (!entry || typeof entry !== "object") return false;
  const status = String(entry.status ?? entry.state ?? "").toLowerCase();
  return entry.enabled === false ||
    entry.enabled === "false" ||
    entry.disabled === true ||
    ["disabled", "off", "inactive"].includes(status);
}

function installPath(entry) {
  if (!entry || typeof entry !== "object") return "";
  for (const key of ["path", "installPath", "packagePath", "root", "location"]) {
    if (typeof entry[key] === "string" && entry[key].length > 0) return entry[key];
  }
  if (entry.plugin && typeof entry.plugin === "object") return installPath(entry.plugin);
  return "";
}

const plugin = collectEntries(document).find((entry) =>
  identifiers(entry).some((identifier) => identifier === expectedId),
);
if (!plugin || typeof plugin !== "object") {
  console.error("OMP plugin list does not contain superpowers");
  process.exit(1);
}
if (isDisabled(plugin)) {
  console.error("OMP superpowers plugin is disabled");
  process.exit(1);
}
const path = installPath(plugin);
if (!path) {
  console.error("OMP superpowers plugin has no install path");
  process.exit(1);
}
process.stdout.write(path);
' )"; then
    fail 'OMP plugin list does not contain an enabled superpowers plugin with an install path'
  fi
  if [[ ! -f "$install_path/skills/using-superpowers/SKILL.md" || ! -r "$install_path/skills/using-superpowers/SKILL.md" ]]; then
    fail "OMP superpowers package is missing skills/using-superpowers/SKILL.md: $install_path"
  fi

  local extension="$HOME/.omp/agent/extensions/rtk.ts"
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
  for command_name in bun node gh claude codex omp rtk; do
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
