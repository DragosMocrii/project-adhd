import { IDENTITY_KEYS, collectEntries, identifiers, isDisabled, runCli } from "./collect";

const PLUGIN_ID = "superpowers";
const OMP_CONTAINER_KEYS = [
  "plugins",
  "npm",
  "installedPlugins",
  "installed",
  "items",
  "data",
] as const;

const PATH_KEYS = ["path", "installPath", "packagePath", "root", "location"] as const;

function resolvePath(entry: Record<string, unknown>): string {
  for (const key of PATH_KEYS) {
    const value = entry[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const nested = entry.plugin;
  if (nested && typeof nested === "object") return resolvePath(nested as Record<string, unknown>);
  return "";
}

export function pluginInstallPath(document: unknown): string {
  const match = collectEntries(document, OMP_CONTAINER_KEYS, IDENTITY_KEYS, [PLUGIN_ID]).find(
    (entry) => identifiers(entry, IDENTITY_KEYS).includes(PLUGIN_ID),
  );
  if (!match || typeof match !== "object") {
    throw new Error("OMP plugin list does not contain superpowers");
  }

  const plugin = match as Record<string, unknown>;
  if (isDisabled(plugin)) throw new Error("OMP superpowers plugin is disabled");

  const path = resolvePath(plugin);
  if (path === "") throw new Error("OMP superpowers plugin has no install path");
  return path;
}

if (import.meta.main) {
  await runCli("omp-plugins", { installPath: pluginInstallPath });
}
