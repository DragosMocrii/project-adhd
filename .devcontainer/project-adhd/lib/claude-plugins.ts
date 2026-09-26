import {
  IDENTITY_KEYS,
  PLUGIN_CONTAINER_KEYS,
  collectEntries,
  identifiers,
  isDisabled,
  runCli,
} from "./collect";

const PLUGIN_ID = "superpowers@claude-plugins-official";

function findPlugin(document: unknown): unknown {
  return collectEntries(document, PLUGIN_CONTAINER_KEYS, IDENTITY_KEYS, [PLUGIN_ID]).find(
    (entry) => identifiers(entry, IDENTITY_KEYS).includes(PLUGIN_ID),
  );
}

export function pluginState(document: unknown): "missing" | "disabled" | "enabled" {
  const plugin = findPlugin(document);
  if (plugin === undefined) return "missing";
  const metadata = plugin && typeof plugin === "object" ? (plugin as Record<string, unknown>) : {};
  return isDisabled(metadata) ? "disabled" : "enabled";
}

export function pluginInstallPath(document: unknown): string {
  const plugin = findPlugin(document);
  if (plugin === undefined) throw new Error(`plugin ${PLUGIN_ID} is missing from plugin metadata`);
  const installPath = plugin && typeof plugin === "object"
    ? (plugin as Record<string, unknown>).installPath
    : undefined;
  if (typeof installPath !== "string" || installPath.length === 0) {
    throw new Error(`plugin ${PLUGIN_ID} has no installPath in plugin metadata`);
  }
  return installPath;
}

if (import.meta.main) {
  await runCli("claude-plugins", { state: pluginState, installPath: pluginInstallPath });
}
