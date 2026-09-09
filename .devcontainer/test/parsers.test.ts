import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { marketplaceState as claudeMarketplaceState } from "../lib/claude-marketplaces";
import { pluginInstallPath as claudeInstallPath, pluginState as claudePluginState } from "../lib/claude-plugins";
import { marketplaceName as codexMarketplaceName } from "../lib/codex-marketplaces";
import { pluginState as codexPluginState } from "../lib/codex-plugins";
import { pluginInstallPath as ompInstallPath } from "../lib/omp-plugins";
import {
  CLAUDE_MARKETPLACES_EMPTY,
  CLAUDE_MARKETPLACES_PRESENT,
  CLAUDE_PLUGINS_ARRAY,
  CLAUDE_PLUGINS_BARE_MAP,
  CLAUDE_PLUGINS_DISABLED,
  CLAUDE_PLUGINS_EMPTY,
  CODEX_MARKETPLACES_API_ONLY,
  CODEX_MARKETPLACES_BOTH,
  CODEX_MARKETPLACES_NONE,
  CODEX_PLUGINS_AVAILABLE_ONLY,
  CODEX_PLUGINS_EMPTY,
  CODEX_PLUGINS_INSTALLED,
  OMP_PLUGINS_DISABLED,
  OMP_PLUGINS_INSTALLED,
  OMP_PLUGINS_PATHLESS,
} from "./fixtures/plugin-json";

const scaffoldRoot = resolve(import.meta.dir, "..");
const postCreatePath = join(scaffoldRoot, "post-create.sh");

type ShellResult = { exitCode: number; stdout: string; stderr: string };

async function callShellParser(
  functionName: string,
  document: unknown,
  extraArgument?: string,
): Promise<ShellResult> {
  const call = extraArgument === undefined
    ? `${functionName} "$2"`
    : `${functionName} "$3" "$2"`;
  const argv = [
    "bash",
    "-c",
    `source "$1"; ${call}`,
    "parser-characterization",
    postCreatePath,
    JSON.stringify(document),
  ];
  if (extraArgument !== undefined) argv.push(extraArgument);

  const child = Bun.spawn(argv, { cwd: scaffoldRoot, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, stdout, stderr };
}

test("characterizes Claude plugin state across array, bare-map, disabled, and empty shapes", async () => {
  for (const [document, expected] of [
    [CLAUDE_PLUGINS_ARRAY, "enabled"],
    [CLAUDE_PLUGINS_BARE_MAP, "enabled"],
    [CLAUDE_PLUGINS_DISABLED, "disabled"],
    [CLAUDE_PLUGINS_EMPTY, "missing"],
  ] as const) {
    const result = await callShellParser("parse_claude_plugin_field", document, "state");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  }
});

test("characterizes Claude installPath resolution and its absence", async () => {
  const found = await callShellParser("parse_claude_plugin_field", CLAUDE_PLUGINS_ARRAY, "installPath");
  expect(found.exitCode).toBe(0);
  expect(found.stdout.trim()).toBe(
    "/home/vscode/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0",
  );

  const absent = await callShellParser("parse_claude_plugin_field", CLAUDE_PLUGINS_EMPTY, "installPath");
  expect(absent.exitCode).toBe(1);
  expect(absent.stdout.trim()).toBe("");
});

test("characterizes Claude marketplace presence", async () => {
  const present = await callShellParser("parse_claude_marketplace_state", CLAUDE_MARKETPLACES_PRESENT);
  expect(present.stdout.trim()).toBe("present");

  const missing = await callShellParser("parse_claude_marketplace_state", CLAUDE_MARKETPLACES_EMPTY);
  expect(missing.stdout.trim()).toBe("missing");
});

test("characterizes Codex plugin state, ignoring available-but-not-installed entries", async () => {
  for (const [document, expected] of [
    [CODEX_PLUGINS_INSTALLED, "installed"],
    [CODEX_PLUGINS_EMPTY, "missing"],
    [CODEX_PLUGINS_AVAILABLE_ONLY, "missing"],
  ] as const) {
    const result = await callShellParser("parse_codex_plugin_state", document);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  }
});

test("characterizes Codex marketplace preference and absence", async () => {
  const both = await callShellParser("parse_codex_marketplace_name", CODEX_MARKETPLACES_BOTH);
  expect(both.stdout.trim()).toBe("openai-curated");

  const apiOnly = await callShellParser("parse_codex_marketplace_name", CODEX_MARKETPLACES_API_ONLY);
  expect(apiOnly.stdout.trim()).toBe("openai-api-curated");

  const none = await callShellParser("parse_codex_marketplace_name", CODEX_MARKETPLACES_NONE);
  expect(none.exitCode).toBe(1);
  expect(none.stdout.trim()).toBe("");
});

test("claude-plugins module matches the characterized state behavior", () => {
  expect(claudePluginState(CLAUDE_PLUGINS_ARRAY)).toBe("enabled");
  expect(claudePluginState(CLAUDE_PLUGINS_BARE_MAP)).toBe("enabled");
  expect(claudePluginState(CLAUDE_PLUGINS_DISABLED)).toBe("disabled");
  expect(claudePluginState(CLAUDE_PLUGINS_EMPTY)).toBe("missing");
});

test("claude-plugins module resolves installPath and throws when absent", () => {
  expect(claudeInstallPath(CLAUDE_PLUGINS_ARRAY)).toBe(
    "/home/vscode/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0",
  );
  expect(() => claudeInstallPath(CLAUDE_PLUGINS_EMPTY)).toThrow();
});

test("claude-marketplaces module reports presence", () => {
  expect(claudeMarketplaceState(CLAUDE_MARKETPLACES_PRESENT)).toBe("present");
  expect(claudeMarketplaceState(CLAUDE_MARKETPLACES_EMPTY)).toBe("missing");
});

test("codex-plugins module ignores available-but-not-installed entries", () => {
  expect(codexPluginState(CODEX_PLUGINS_INSTALLED)).toBe("installed");
  expect(codexPluginState(CODEX_PLUGINS_EMPTY)).toBe("missing");
  expect(codexPluginState(CODEX_PLUGINS_AVAILABLE_ONLY)).toBe("missing");
});

test("codex-marketplaces module prefers openai-curated and throws when neither is exposed", () => {
  expect(codexMarketplaceName(CODEX_MARKETPLACES_BOTH)).toBe("openai-curated");
  expect(codexMarketplaceName(CODEX_MARKETPLACES_API_ONLY)).toBe("openai-api-curated");
  expect(() => codexMarketplaceName(CODEX_MARKETPLACES_NONE)).toThrow();
});

test("omp-plugins module requires an enabled plugin with a path", () => {
  expect(ompInstallPath(OMP_PLUGINS_INSTALLED)).toBe("/home/vscode/.omp/agent/plugins/superpowers");
  expect(() => ompInstallPath(OMP_PLUGINS_DISABLED)).toThrow();
  expect(() => ompInstallPath(OMP_PLUGINS_PATHLESS)).toThrow();
});

test("parser modules honor the stdin/argv CLI contract", async () => {
  const libDir = join(scaffoldRoot, "lib");

  const ok = Bun.spawn(["bun", join(libDir, "claude-plugins.ts"), "state"], {
    stdin: new TextEncoder().encode(JSON.stringify(CLAUDE_PLUGINS_ARRAY)),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await new Response(ok.stdout).text()).toBe("enabled\n");
  expect(await ok.exited).toBe(0);

  const malformed = Bun.spawn(["bun", join(libDir, "claude-plugins.ts"), "state"], {
    stdin: new TextEncoder().encode("{ not json"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const malformedStdout = await new Response(malformed.stdout).text();
  const malformedStderr = await new Response(malformed.stderr).text();
  expect(await malformed.exited).toBe(1);
  expect(malformedStdout).toBe("");
  expect(malformedStderr).toContain("unable to parse JSON");

  const badField = Bun.spawn(["bun", join(libDir, "claude-plugins.ts"), "nonsense"], {
    stdin: new TextEncoder().encode(JSON.stringify(CLAUDE_PLUGINS_ARRAY)),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await badField.exited).toBe(1);
  expect(await new Response(badField.stderr).text()).toContain("unsupported field");
});
