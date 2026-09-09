import { expect, test } from "bun:test";
import { join, resolve } from "node:path";

const scaffoldRoot = resolve(import.meta.dir, "..");
const libraryPath = join(scaffoldRoot, "lib", "agent-tools.sh");

type ShellResult = { exitCode: number; stdout: string; stderr: string };

async function selection(agentTools?: string): Promise<ShellResult> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  if (agentTools === undefined) delete env.AGENT_TOOLS;
  else env.AGENT_TOOLS = agentTools;

  const child = Bun.spawn(
    ["bash", "-c", 'source "$1"; agent_tools_init; agent_tools_summary', "agent-tools-test", libraryPath],
    { cwd: scaffoldRoot, env, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode: await child.exited, stdout, stderr };
}

async function predicate(agentTools: string, tool: string): Promise<number> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  env.AGENT_TOOLS = agentTools;

  const child = Bun.spawn(
    ["bash", "-c", 'source "$1"; agent_tools_init; agent_tool_selected "$2"', "agent-tools-test", libraryPath, tool],
    { cwd: scaffoldRoot, env, stdout: "pipe", stderr: "pipe" },
  );
  return child.exited;
}

test("selects every known tool when AGENT_TOOLS is unset", async () => {
  const result = await selection();
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("claude, codex, gemini, omp");
});

test("selects every known tool when AGENT_TOOLS is empty or only separators", async () => {
  for (const value of ["", "   ", ","]) {
    const result = await selection(value);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("claude, codex, gemini, omp");
  }
});

test("selects only the named tool", async () => {
  const result = await selection("claude");
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("claude");
});

test("normalizes whitespace, case, and duplicates into canonical order", async () => {
  const result = await selection(" OMP , claude,claude , Codex ");
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("claude, codex, omp");
});

test("rejects an unknown tool with the valid-names message", async () => {
  const result = await selection("claude,foo");
  expect(result.exitCode).toBe(1);
  expect(result.stderr.trim()).toBe(
    "agent-tools: unknown tool 'foo' (valid: claude, codex, gemini, omp)",
  );
  expect(result.stdout).toBe("");
});

test("agent_tool_selected answers for selected and unselected tools", async () => {
  expect(await predicate("claude,omp", "claude")).toBe(0);
  expect(await predicate("claude,omp", "omp")).toBe(0);
  expect(await predicate("claude,omp", "codex")).toBe(1);
  expect(await predicate("claude,omp", "gemini")).toBe(1);
});
