import {
  MARKETPLACE_CONTAINER_KEYS,
  MARKETPLACE_IDENTITY_KEYS,
  collectEntries,
  identifiers,
  runCli,
} from "./collect";

const MARKETPLACE_NAME = "claude-plugins-official";

export function marketplaceState(document: unknown): "present" | "missing" {
  const present = collectEntries(
    document,
    MARKETPLACE_CONTAINER_KEYS,
    MARKETPLACE_IDENTITY_KEYS,
    [MARKETPLACE_NAME],
  ).some((entry) => identifiers(entry, MARKETPLACE_IDENTITY_KEYS).includes(MARKETPLACE_NAME));
  return present ? "present" : "missing";
}

if (import.meta.main) {
  await runCli("claude-marketplaces", { state: marketplaceState });
}
