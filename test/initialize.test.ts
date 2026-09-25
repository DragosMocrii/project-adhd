import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { checked, hostBash, prepareRepository, run, withTemporaryParent } from "./helpers";

async function runInitializer(root: string): Promise<void> {
  const result = await run([hostBash, join(root, ".devcontainer", "project-adhd", "initialize.sh"), root], root);
  if (result.exitCode !== 0) {
    throw new Error(
      `initializer failed with exit code ${result.exitCode}\n${result.stdout}${result.stderr}`,
    );
  }
}

const STATE_KEYS = ["PROJECT_STATE_PREFIX", "COMPOSE_INSTANCE", "AGENT_STATE_PREFIX", "WORKSPACE_NAME"];

async function readState(root: string): Promise<Record<string, string>> {
  const contents = await readFile(join(root, ".devcontainer", "project-adhd", ".env"), "utf8");
  expect(contents.endsWith("\n")).toBe(true);
  const lines = contents.slice(0, -1).split("\n");
  expect(lines.map((line) => line.slice(0, line.indexOf("=")))).toEqual(STATE_KEYS);
  return Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

async function readStatePrefix(root: string): Promise<string> {
  const prefix = (await readState(root)).PROJECT_STATE_PREFIX;
  expect(prefix).toMatch(/^[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$/);
  return prefix;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

async function canonicalGitCommonDirectory(root: string): Promise<string> {
  const reported = (await checked(
    ["git", "-C", root, "rev-parse", "--git-common-dir"],
    root,
  )).trim();
  return realpath(isAbsolute(reported) ? reported : join(root, reported));
}

test("normalizes the repository name and hashes its canonical Git common directory", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "My Project");
    await mkdir(root);
    await prepareRepository(root);

    await runInitializer(root);

    const commonDirectory = await canonicalGitCommonDirectory(root);
    const expectedId = createHash("sha256")
      .update(commonDirectory)
      .digest("hex")
      .slice(0, 8);
    expect(await readStatePrefix(root)).toBe(`my-project-${expectedId}`);
    expect(await readFile(join(root, ".devcontainer", "project-adhd", "devcontainer.env"), "utf8")).toBe("");
  });
});

test("shares one state prefix between linked worktrees", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "linked-project");
    const linked = join(parent, "linked-project-worktree");
    await mkdir(root);
    await prepareRepository(root);
    await checked(["git", "-C", root, "worktree", "add", linked, "-b", "feature/example"], root);

    await runInitializer(root);
    await runInitializer(linked);

    expect(await readStatePrefix(linked)).toBe(await readStatePrefix(root));
  });
});

test("reuses the persisted prefix for a linked worktree created after a repository move", async () => {
  await withTemporaryParent(async (parent) => {
    const original = join(parent, "before-move", "moved-project");
    const moved = join(parent, "after-move", "moved-project");
    const linked = join(parent, "after-move", "linked-project");
    await mkdir(join(parent, "before-move"), { recursive: true });
    await mkdir(join(parent, "after-move"), { recursive: true });
    await mkdir(original);
    await prepareRepository(original);

    await runInitializer(original);
    const persistedPrefix = await readStatePrefix(original);
    await rename(original, moved);
    await checked(["git", "-C", moved, "worktree", "add", linked, "-b", "feature/after-move"], moved);

    await runInitializer(linked);

    expect(await readStatePrefix(linked)).toBe(persistedPrefix);
  });
});

test("fails instead of switching volumes when canonical and worktree prefixes conflict", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "conflicting-prefix");
    await mkdir(root);
    await prepareRepository(root);

    await runInitializer(root);
    const commonDirectory = await canonicalGitCommonDirectory(root);
    await writeFile(
      join(commonDirectory, ".agentic-bun-devcontainer-prefix"),
      "PROJECT_STATE_PREFIX=conflicting-prefix-deadbeef\n",
    );

    const result = await run(
      [hostBash, join(root, ".devcontainer", "project-adhd", "initialize.sh"), root],
      root,
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("conflicting PROJECT_STATE_PREFIX values");
  });
});

test("rejects a valid prefix followed by an unterminated extra state line", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "malformed-state");
    await mkdir(root);
    await prepareRepository(root);
    const statePath = join(root, ".devcontainer", "project-adhd", ".env");
    for (const malformed of [
      "PROJECT_STATE_PREFIX=malformed-state-1234abcd\nCOMPOSE_INSTANCE=x\nAGENT_STATE_PREFIX=y\nWORKSPACE_NAME=z",
      "PROJECT_STATE_PREFIX=malformed-state-1234abcd\n",
      "PROJECT_STATE_PREFIX=malformed-state-1234abcd\nWORKSPACE_NAME=z\nAGENT_STATE_PREFIX=y\nCOMPOSE_INSTANCE=x\n",
    ]) {
      await writeFile(statePath, malformed);
      await runInitializer(root);
      expect(await readStatePrefix(root)).not.toBe("malformed-state-1234abcd");
      await rm(join(await canonicalGitCommonDirectory(root), ".agentic-bun-devcontainer-prefix"));
    }
  });
});

test("separates independent repositories with the same basename", async () => {
  await withTemporaryParent(async (parent) => {
    const firstParent = join(parent, "first");
    const secondParent = join(parent, "second");
    const first = join(firstParent, "same-name");
    const second = join(secondParent, "same-name");
    await mkdir(firstParent);
    await mkdir(secondParent);
    await mkdir(first);
    await mkdir(second);
    await prepareRepository(first);
    await prepareRepository(second);

    await runInitializer(first);
    await runInitializer(second);

    const firstPrefix = await readStatePrefix(first);
    const secondPrefix = await readStatePrefix(second);
    expect(firstPrefix).toMatch(/^same-name-[0-9a-f]{8}$/);
    expect(secondPrefix).toMatch(/^same-name-[0-9a-f]{8}$/);
    expect(firstPrefix).not.toBe(secondPrefix);
  });
});

test("preserves a valid state prefix and an existing devcontainer secret on reruns", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "preserved-state");
    await mkdir(root);
    await prepareRepository(root);
    const statePath = join(root, ".devcontainer", "project-adhd", ".env");
    const secretPath = join(root, ".devcontainer", "project-adhd", "devcontainer.env");
    const preservedPrefix = "preserved-state-1234abcd";
    const secret = "CONTEXT7_API_KEY=keep-this-secret\n";
    await writeFile(
      statePath,
      `PROJECT_STATE_PREFIX=${preservedPrefix}\nCOMPOSE_INSTANCE=old\nAGENT_STATE_PREFIX=old\nWORKSPACE_NAME=old\n`,
    );
    await writeFile(secretPath, secret, { mode: 0o600 });

    await runInitializer(root);
    await runInitializer(root);

    expect(await readStatePrefix(root)).toBe(preservedPrefix);
    expect(await readFile(secretPath, "utf8")).toBe(secret);
  });
});

test("writes four state keys: per-worktree Compose instance, shared agent prefix, raw workspace name", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "My Project");
    await mkdir(root);
    await prepareRepository(root);

    await runInitializer(root);

    const state = await readState(root);
    expect(state.COMPOSE_INSTANCE).toBe(`${state.PROJECT_STATE_PREFIX}-${shortHash(await realpath(root))}`);
    expect(state.AGENT_STATE_PREFIX).toBe("project-adhd-shared");
    expect(state.WORKSPACE_NAME).toBe("My Project");
  });
});

test("gives each linked worktree its own Compose instance but one state prefix", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "instances");
    const linked = join(parent, "instances-wt");
    await mkdir(root);
    await prepareRepository(root);
    await checked(["git", "-C", root, "worktree", "add", linked, "-b", "feature/x"], root);

    await runInitializer(root);
    await runInitializer(linked);

    const main = await readState(root);
    const worktree = await readState(linked);
    expect(worktree.PROJECT_STATE_PREFIX).toBe(main.PROJECT_STATE_PREFIX);
    expect(worktree.COMPOSE_INSTANCE).not.toBe(main.COMPOSE_INSTANCE);
    expect(worktree.WORKSPACE_NAME).toBe("instances-wt");
  });
});

test("uses the project prefix for agent state when AGENT_STATE_SCOPE=project", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "scoped");
    await mkdir(root);
    await prepareRepository(root);
    await writeFile(join(root, ".devcontainer", "project-adhd", "devcontainer.env"), "AGENT_STATE_SCOPE=project\n");

    await runInitializer(root);

    const state = await readState(root);
    expect(state.AGENT_STATE_PREFIX).toBe(state.PROJECT_STATE_PREFIX);
  });
});

test("rejects a folder name that Compose's .env would mangle", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "price$tag");
    await mkdir(root);
    await prepareRepository(root);

    const initializer = join(root, ".devcontainer", "project-adhd", "initialize.sh");
    const result = await run([hostBash, initializer, root], root);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("the folder name 'price$tag' contains");
  });
});

test("rejects an unknown AGENT_STATE_SCOPE", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "bad-scope");
    await mkdir(root);
    await prepareRepository(root);
    await writeFile(join(root, ".devcontainer", "project-adhd", "devcontainer.env"), "AGENT_STATE_SCOPE=global\n");

    const initializer = join(root, ".devcontainer", "project-adhd", "initialize.sh");
    const result = await run([hostBash, initializer, root], root);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("invalid AGENT_STATE_SCOPE 'global'");
  });
});
