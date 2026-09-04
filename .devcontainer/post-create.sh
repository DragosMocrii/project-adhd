#!/usr/bin/env bash
set -euo pipefail

CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
export CLAUDE_CONFIG_DIR
export NPM_CONFIG_PREFIX="$HOME/.local"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:${PATH:-}"

readonly -a STATE_ROOTS=(
  "$CLAUDE_CONFIG_DIR"
  "$HOME/.config/gh"
  "$HOME/.config/rtk"
  "$HOME/.local/share/rtk"
  "$HOME/.codex"
  "$HOME/.gemini"
  "$HOME/.omp"
)
readonly -a INSTALLER_ROOTS=(
  "$HOME/.local"
  "$HOME/.local/bin"
  "$HOME/.local/share"
  "$HOME/.bun"
  "$HOME/.bun/bin"
  "$HOME/.bun/install"
  "$HOME/.bun/install/global"
)

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

install_tools() {
  if command -v claude >/dev/null 2>&1; then
    echo '==> Claude Code is already installed; skipping Claude installer'
  else
    echo '==> Installing Claude Code'
    curl -fsSL https://claude.ai/install.sh | bash
  fi

  if command -v rtk >/dev/null 2>&1 && rtk gain >/dev/null 2>&1; then
    echo '==> rtk is already installed and verified; skipping rtk installer'
  else
    echo '==> Installing rtk'
    curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
  fi

  if command -v codex >/dev/null 2>&1; then
    echo '==> Codex is already installed; skipping Codex installer'
  else
    echo '==> Installing codex'
    curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh
  fi

  if command -v gemini >/dev/null 2>&1; then
    echo '==> Gemini CLI is already installed; skipping Gemini installer'
  else
    echo '==> Installing Gemini CLI'
    npm install -g @google/gemini-cli
  fi

  if command -v omp >/dev/null 2>&1; then
    echo '==> OMP is already installed; skipping OMP installer'
  else
    echo '==> Installing omp (Oh My Pi)'
    bun install -g @oh-my-pi/pi-coding-agent
  fi
}

configure_rtk() {
  echo '==> Configuring rtk for Claude Code'
  rtk init -g --auto-patch

  echo '==> Configuring rtk for Codex'
  rtk init -g --codex

  echo '==> Configuring rtk for OMP'
  PI_CODING_AGENT_DIR="$HOME/.omp/agent" rtk init -g --agent pi
}

parse_claude_plugin_field() {
  local field="$1"
  local plugin_json="$2"

  printf '%s' "$plugin_json" | CLAUDE_PLUGIN_FIELD="$field" bun -e '
const expectedId = "superpowers@claude-plugins-official";
const field = process.env.CLAUDE_PLUGIN_FIELD;
let document;

try {
  document = JSON.parse(await Bun.stdin.text());
} catch (error) {
  console.error(`Unable to parse Claude plugin list JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

function collectEntries(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];

  const entries = [];
  for (const key of ["plugins", "installedPlugins", "installed", "items", "data"]) {
    if (key in value) entries.push(...collectEntries(value[key]));
  }

  if (typeof value.id === "string" || typeof value.pluginId === "string") {
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
  return [entry.id, entry.pluginId, entry.plugin?.id]
    .filter((value) => typeof value === "string");
}

const plugin = collectEntries(document).find((entry) =>
  identifiers(entry).some((identifier) => identifier === expectedId),
);

if (field === "state") {
  if (!plugin) {
    process.stdout.write("missing\n");
    process.exit(0);
  }

  const status = String(plugin.status ?? plugin.state ?? "").toLowerCase();
  const disabled = plugin.enabled === false ||
    plugin.enabled === "false" ||
    plugin.isEnabled === false ||
    plugin.disabled === true ||
    ["disabled", "off", "inactive"].includes(status);
  process.stdout.write(`${disabled ? "disabled" : "enabled"}\n`);
  process.exit(0);
}

if (field === "installPath") {
  if (!plugin) {
    console.error(`Claude plugin ${expectedId} is missing from plugin metadata`);
    process.exit(1);
  }

  const installPath = plugin.installPath;
  if (typeof installPath !== "string" || installPath.length === 0) {
    console.error(`Claude plugin ${expectedId} has no installPath in plugin metadata`);
    process.exit(1);
  }

  process.stdout.write(`${installPath}\n`);
  process.exit(0);
}

console.error(`Unsupported Claude plugin metadata field: ${field}`);
process.exit(1);
'
}

parse_claude_marketplace_state() {
  local marketplace_json="$1"

  printf '%s' "$marketplace_json" | bun -e '
const expectedName = "claude-plugins-official";
let document;

try {
  document = JSON.parse(await Bun.stdin.text());
} catch (error) {
  console.error(`Unable to parse Claude marketplace list JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

function collectEntries(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];

  const entries = [];
  for (const key of ["marketplaces", "items", "data"]) {
    if (key in value) entries.push(...collectEntries(value[key]));
  }

  if (
    typeof value.name === "string" ||
    typeof value.id === "string" ||
    typeof value.marketplace === "string"
  ) {
    entries.push(value);
  }

  if (entries.length === 0) {
    for (const [key, child] of Object.entries(value)) {
      if (key === expectedName) {
        entries.push(
          child && typeof child === "object" && !Array.isArray(child)
            ? { ...child, name: expectedName }
            : { name: expectedName, installed: child },
        );
      }
    }
  }

  return entries;
}

const present = collectEntries(document).some((entry) => {
  if (typeof entry === "string") return entry === expectedName;
  if (!entry || typeof entry !== "object") return false;
  return [entry.name, entry.id, entry.marketplace]
    .some((value) => value === expectedName);
});

process.stdout.write(`${present ? "present" : "missing"}\n`);
'
}

parse_codex_plugin_state() {
  local plugin_json="$1"

  printf '%s' "$plugin_json" | bun -e '
const expectedIds = new Set([
  "superpowers",
  "superpowers@openai-curated",
  "superpowers@openai-api-curated",
]);
let document;

try {
  document = JSON.parse(await Bun.stdin.text());
} catch (error) {
  console.error(`Unable to parse Codex plugin list JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

function collectEntries(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];

  const entries = [];
  for (const key of ["plugins", "installedPlugins", "installed", "items", "data"]) {
    if (key in value) entries.push(...collectEntries(value[key]));
  }

  if (typeof value.id === "string" || typeof value.pluginId === "string" || typeof value.name === "string") {
    entries.push(value);
  }

  if (entries.length === 0) {
    for (const [key, child] of Object.entries(value)) {
      if (
        key === "superpowers" ||
        key === "superpowers@openai-curated" ||
        key === "superpowers@openai-api-curated"
      ) {
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
  return [entry.id, entry.pluginId, entry.name, entry.slug, entry.package]
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
process.stdout.write(`${installed ? "installed" : "missing"}\n`);
'
}

parse_codex_marketplace_name() {
  local marketplace_json="$1"

  printf '%s' "$marketplace_json" | bun -e '
const supportedNames = new Set(["openai-curated", "openai-api-curated"]);
let document;

try {
  document = JSON.parse(await Bun.stdin.text());
} catch (error) {
  console.error(`Unable to parse Codex marketplace list JSON: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

function collectEntries(value) {
  if (Array.isArray(value)) return value.flatMap(collectEntries);
  if (!value || typeof value !== "object") return [];

  const entries = [];
  for (const key of ["marketplaces", "items", "data"]) {
    if (key in value) entries.push(...collectEntries(value[key]));
  }

  if (
    typeof value.name === "string" ||
    typeof value.id === "string" ||
    typeof value.marketplace === "string" ||
    typeof value.slug === "string"
  ) {
    entries.push(value);
  }

  if (entries.length === 0) {
    for (const [key, child] of Object.entries(value)) {
      if (supportedNames.has(key)) {
        entries.push(
          child && typeof child === "object" && !Array.isArray(child)
            ? { ...child, name: key }
            : { name: key },
        );
      }
    }
  }

  return entries;
}

function identifiers(entry) {
  if (typeof entry === "string") return [entry];
  if (!entry || typeof entry !== "object") return [];
  return [entry.name, entry.id, entry.marketplace, entry.slug]
    .filter((value) => typeof value === "string");
}

function isPreferred(entry) {
  if (!entry || typeof entry !== "object") return false;
  return ["active", "default", "isActive", "isDefault", "current", "selected"]
    .some((key) => entry[key] === true || entry[key] === "true" || entry[key] === 1);
}

let selected;
let selectedScore = -1;
for (const entry of collectEntries(document)) {
  const name = identifiers(entry).find((identifier) => supportedNames.has(identifier));
  if (!name) continue;

  const score = (isPreferred(entry) ? 2 : 0) + (name === "openai-curated" ? 1 : 0);
  if (score > selectedScore) {
    selected = name;
    selectedScore = score;
  }
}

if (!selected) {
  console.error("No supported official Codex marketplace is exposed");
  process.exit(1);
}
process.stdout.write(`${selected}\n`);
'
}

defer_superpowers_setup() {
  echo '==> Superpowers setup deferred until Claude and Codex authentication is available'
  echo '    Run gh auth login, claude auth login, and codex login, then rerun: bash .devcontainer/post-create.sh'
}
configure_superpowers() {
  local claude_plugins claude_state claude_marketplaces marketplace_state
  local install_path codex_plugins codex_state codex_marketplaces codex_marketplace

  if ! claude auth status >/dev/null 2>&1 || ! codex login status >/dev/null 2>&1; then
    defer_superpowers_setup
    return 0
  fi

  echo '==> Enabling Codex plugins'
  codex features enable plugins
  if ! codex_marketplaces="$(codex plugin marketplace list --json)"; then
    die 'Unable to list Codex marketplaces'
  fi
  if ! codex_marketplace="$(parse_codex_marketplace_name "$codex_marketplaces")"; then
    die 'No supported official Codex marketplace is available'
  fi

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
      codex plugin add superpowers@$codex_marketplace --json
      ;;
    *)
      die "Unexpected Codex Superpowers state: $codex_state"
      ;;
  esac

  echo '==> Installing Claude Superpowers package into OMP'
  omp install "$install_path" --scope user --force --json
}

install_archify() {
  local source="$HOME/.agents/skills/archify"
  local destination

  echo '==> Installing the archify skill (claude-code, codex)'
  bunx skills@latest add tt-a1i/archify -g -y --copy --agent claude-code codex </dev/null

  [[ -d "$source" ]] || die "Archify skill source is missing: $source"

  for destination in \
    "$CLAUDE_CONFIG_DIR/skills/archify" \
    "$HOME/.codex/skills/archify" \
    "$HOME/.omp/agent/skills/archify"; do
    mkdir -p "$(dirname "$destination")"
    rm -rf -- "$destination"
    cp -a -- "$source" "$destination"
  done
}

main() {
  repair_state_ownership
  repair_installer_ownership
  configure_github_auth
  install_tools
  configure_rtk
  configure_superpowers
  install_archify
  echo '==> Post-create complete'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
