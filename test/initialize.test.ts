import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
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

async function readStatePrefix(root: string): Promise<string> {
  const contents = await readFile(join(root, ".devcontainer", "project-adhd", ".env"), "utf8");
  const match = /^PROJECT_STATE_PREFIX=(.+)\n$/.exec(contents);
  if (match === null) {
    throw new Error(`invalid initializer state file:\n${contents}`);
  }
  return match[1];
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
    await writeFile(
      join(root, ".devcontainer", "project-adhd", ".env"),
      "PROJECT_STATE_PREFIX=malformed-state-1234abcd\ntrailing-junk",
    );

    await runInitializer(root);

    expect(await readStatePrefix(root)).toMatch(/^malformed-state-[0-9a-f]{8}$/);
    expect(await readStatePrefix(root)).not.toBe("malformed-state-1234abcd");
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
    await writeFile(statePath, `${"PROJECT_STATE_PREFIX="}${preservedPrefix}\n`);
    await writeFile(secretPath, secret, { mode: 0o600 });

    await runInitializer(root);
    await runInitializer(root);

    expect(await readFile(statePath, "utf8")).toBe(
      `PROJECT_STATE_PREFIX=${preservedPrefix}\n`,
    );
    expect(await readFile(secretPath, "utf8")).toBe(secret);
  });
});
