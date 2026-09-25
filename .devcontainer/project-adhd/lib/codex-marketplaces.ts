import {
  MARKETPLACE_CONTAINER_KEYS,
  MARKETPLACE_IDENTITY_KEYS,
  collectEntries,
  identifiers,
  runCli,
} from "./collect";

const SUPPORTED_NAMES = ["openai-curated", "openai-api-curated"] as const;

function isPreferred(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;
  return ["active", "default", "isActive", "isDefault", "current", "selected"].some(
    (key) => record[key] === true || record[key] === "true" || record[key] === 1,
  );
}

export function marketplaceName(document: unknown): string {
  let selected: string | undefined;
  let selectedScore = -1;

  for (const entry of collectEntries(
    document,
    MARKETPLACE_CONTAINER_KEYS,
    MARKETPLACE_IDENTITY_KEYS,
    SUPPORTED_NAMES,
  )) {
    const name = identifiers(entry, MARKETPLACE_IDENTITY_KEYS).find((identifier) =>
      (SUPPORTED_NAMES as readonly string[]).includes(identifier),
    );
    if (name === undefined) continue;

    const score = (isPreferred(entry) ? 2 : 0) + (name === "openai-curated" ? 1 : 0);
    if (score > selectedScore) {
      selected = name;
      selectedScore = score;
    }
  }

  if (selected === undefined) throw new Error("No supported official Codex marketplace is exposed");
  return selected;
}

if (import.meta.main) {
  await runCli("codex-marketplaces", { name: marketplaceName });
}
