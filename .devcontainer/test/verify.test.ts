import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type CommandResult,
  run,
  verifyPath,
  withTemporaryParent,
  writeStubs,
} from "./helpers";

async function runVerify(
  parent: string,
  stubs: Record<string, string>,
  agentTools: string,
): Promise<CommandResult> {
  const home = join(parent, "home");
  const stubBin = join(home, ".local", "bin");
  await mkdir(stubBin, { recursive: true });
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeStubs(stubBin, stubs);
  return run(["/bin/bash", verifyPath], home, {
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    AGENT_TOOLS: agentTools,
    PATH: stubBin,
  });
}

test("verify skips checks for unselected tools and succeeds", async () => {
  await withTemporaryParent(async (parent) => {
    const noop = "#!/bin/sh\nexit 0\n";
    const result = await runVerify(
      parent,
      { bun: noop, node: noop, python3: noop, gh: noop, rtk: noop, gemini: noop },
      "gemini",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("SKIP");
    expect(result.stdout).toContain("claude not selected");
    expect(result.stdout).toContain("skipped");
  });
});

test("verify fails when a selected tool is missing from PATH", async () => {
  await withTemporaryParent(async (parent) => {
    const noop = "#!/bin/sh\nexit 0\n";
    const result = await runVerify(
      parent,
      { bun: noop, node: noop, python3: noop, gh: noop, rtk: noop },
      "codex",
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("required command is not on PATH: codex");
  });
});
