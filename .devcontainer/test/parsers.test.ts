import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
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
