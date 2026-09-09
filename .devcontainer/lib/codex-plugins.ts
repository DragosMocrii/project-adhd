import {
  IDENTITY_KEYS,
  PLUGIN_CONTAINER_KEYS,
  collectEntries,
  identifiers,
  isInstalled,
  runCli,
} from "./collect";

const PLUGIN_IDS = [
  "superpowers",
  "superpowers@openai-curated",
  "superpowers@openai-api-curated",
] as const;

export function pluginState(document: unknown): "installed" | "missing" {
  const installed = collectEntries(document, PLUGIN_CONTAINER_KEYS, IDENTITY_KEYS, PLUGIN_IDS).some(
    (entry) =>
      identifiers(entry, IDENTITY_KEYS).some((identifier) =>
        (PLUGIN_IDS as readonly string[]).includes(identifier),
      ) && isInstalled(entry),
  );
  return installed ? "installed" : "missing";
}

if (import.meta.main) {
  await runCli("codex-plugins", { state: pluginState });
}
