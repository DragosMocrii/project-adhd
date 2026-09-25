export const PLUGIN_CONTAINER_KEYS = [
  "plugins",
  "installedPlugins",
  "installed",
  "items",
  "data",
] as const;

export const MARKETPLACE_CONTAINER_KEYS = ["marketplaces", "items", "data"] as const;

export const IDENTITY_KEYS = ["id", "pluginId", "name", "slug", "package", "marketplace"] as const;

export const MARKETPLACE_IDENTITY_KEYS = ["name", "id", "marketplace", "slug"] as const;

function hasIdentity(record: Record<string, unknown>, identityKeys: readonly string[]): boolean {
  if (identityKeys.some((key) => typeof record[key] === "string")) return true;
  const plugin = record.plugin;
  return Boolean(
    plugin && typeof plugin === "object" &&
      typeof (plugin as Record<string, unknown>).id === "string",
  );
}

export function collectEntries(
  value: unknown,
  containerKeys: readonly string[],
  identityKeys: readonly string[],
  directKeys: readonly string[] = [],
): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      entry && typeof entry === "object"
        ? collectEntries(entry, containerKeys, identityKeys, directKeys)
        : [entry],
    );
  }
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;

  const entries: unknown[] = [];
  for (const key of containerKeys) {
    if (key in record) {
      entries.push(...collectEntries(record[key], containerKeys, identityKeys, directKeys));
    }
  }

  if (hasIdentity(record, identityKeys)) entries.push(record);

  if (entries.length === 0) {
    for (const [key, child] of Object.entries(record)) {
      if (!directKeys.includes(key)) continue;
      entries.push(
        child && typeof child === "object" && !Array.isArray(child)
          ? { ...(child as Record<string, unknown>), id: key, name: key }
          : { id: key, name: key, installed: child },
      );
    }
  }

  return entries;
}

export function identifiers(entry: unknown, keys: readonly string[]): string[] {
  if (typeof entry === "string") return [entry];
  if (!entry || typeof entry !== "object") return [];
  const record = entry as Record<string, unknown>;
  const plugin = record.plugin as Record<string, unknown> | undefined;
  return [...keys.map((key) => record[key]), plugin?.id].filter(
    (value): value is string => typeof value === "string",
  );
}

export function isDisabled(entry: Record<string, unknown>): boolean {
  const status = String(entry.status ?? entry.state ?? "").toLowerCase();
  return entry.enabled === false ||
    entry.enabled === "false" ||
    entry.isEnabled === false ||
    entry.disabled === true ||
    ["disabled", "off", "inactive"].includes(status);
}

export function isInstalled(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return true;
  const record = entry as Record<string, unknown>;
  const status = String(record.status ?? record.state ?? "")
    .toLowerCase()
    .replaceAll("_", "-")
    .replaceAll(" ", "-");
  return record.installed !== false &&
    record.installed !== "false" &&
    !["not-installed", "uninstalled", "available"].includes(status);
}

export async function runCli(
  label: string,
  handlers: Record<string, (document: unknown) => string>,
): Promise<never> {
  const field = process.argv[2];
  const handler = field === undefined ? undefined : handlers[field];
  if (handler === undefined) {
    console.error(
      `${label}: unsupported field: ${field ?? "(none)"} (valid: ${Object.keys(handlers).join(", ")})`,
    );
    process.exit(1);
  }

  let document: unknown;
  try {
    document = JSON.parse(await Bun.stdin.text());
  } catch (error) {
    console.error(
      `${label}: unable to parse JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  try {
    process.stdout.write(`${handler(document)}\n`);
  } catch (error) {
    console.error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  process.exit(0);
}
