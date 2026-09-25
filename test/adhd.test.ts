import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CommandResult,
  checked,
  hostBash,
  makeInstallation,
  makeRepo,
  repoRoot,
  run,
  withTemporaryParent,
} from "./helpers";

const RUNTIME = ".devcontainer/project-adhd";
const BLOCK =
  "# >>> project-adhd\n/.worktrees/\n/.claude/worktrees/\n/.superpowers/\n/docs/superpowers/\n# <<< project-adhd\n";

function adhd(
  installation: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<CommandResult> {
  return run([hostBash, join(installation, "bin", "adhd"), ...args], cwd, env);
}

function status(root: string): Promise<string> {
  return checked(["git", "status", "--porcelain", "--untracked-files=all"], root);
}

async function manifest(installation: string): Promise<string[]> {
  const out = await checked(
    [hostBash, "-c", 'ADHD_HOME="$1"; source "$1/libexec/adhd/common.sh"; printf "%s\\n" "${ADHD_RUNTIME_FILES[@]}"', "manifest", installation],
    installation,
  );
  return out.trim().split("\n");
}

test("attach copies the runtime, hides it from git, and records an untracked marker", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const root = join(parent, "My Project");
    await makeRepo(root);

    const result = await adhd(checkout, ["attach", root, "--agents", "claude"], parent);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Attached project-adhd");
    for (const file of await manifest(checkout)) {
      expect(existsSync(join(root, RUNTIME, file))).toBe(true);
    }
    expect(await readFile(join(root, RUNTIME, ".gitignore"), "utf8")).toBe("*\n");
    const marker = await readFile(join(root, RUNTIME, ".adhd"), "utf8");
    expect(marker).toStartWith("mode=untracked\nsource=");
    expect(marker).toMatch(/^sha:devcontainer\.json=[0-9a-f]{64}$/m);
    expect(await readFile(join(root, ".git/info/exclude"), "utf8")).toEndWith(BLOCK);
    const envFile = join(root, RUNTIME, "devcontainer.env");
    expect(await readFile(envFile, "utf8")).toMatch(/^AGENT_TOOLS=claude$/m);
    expect((await stat(envFile)).mode & 0o777).toBe(0o600);

    for (const path of [".superpowers/state", "docs/superpowers/specs/x.md", ".worktrees/a/file", ".claude/worktrees/b/file"]) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), "x\n");
    }
    expect(await status(root)).toBe("");
  });
});

test("attach selects every agent when --agents is omitted and stdin is not a terminal", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const root = join(parent, "defaults");
    await makeRepo(root);

    expect((await adhd(checkout, ["attach", root], parent)).exitCode).toBe(0);

    expect(await readFile(join(root, RUNTIME, "devcontainer.env"), "utf8")).toMatch(
      /^AGENT_TOOLS=claude,codex,gemini,omp$/m,
    );
  });
});

test("attach resolves . and a trailing-slash path to the same worktree root", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const dotRoot = join(parent, "dot");
    const slashRoot = join(parent, "Slash Name");
    await makeRepo(dotRoot);
    await makeRepo(slashRoot);

    expect((await adhd(checkout, ["attach", ".", "--agents", "claude"], dotRoot)).exitCode).toBe(0);
    expect((await adhd(checkout, ["attach", "Slash Name/", "--agents", "claude"], parent)).exitCode).toBe(0);

    expect(existsSync(join(dotRoot, RUNTIME, ".adhd"))).toBe(true);
    expect(existsSync(join(slashRoot, RUNTIME, ".adhd"))).toBe(true);
  });
});

test("attach keeps a user's last exclude rule on its own line", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const root = join(parent, "no-newline");
    await makeRepo(root);
    await mkdir(join(root, ".git/info"), { recursive: true });
    await writeFile(join(root, ".git/info/exclude"), "custom-rule");

    expect((await adhd(checkout, ["attach", root, "--agents", "claude"], parent)).exitCode).toBe(0);

    expect(await readFile(join(root, ".git/info/exclude"), "utf8")).toBe(`custom-rule\n${BLOCK}`);
  });
});

test("the runtime manifest matches the runtime folder", async () => {
  const listed = await checked(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", RUNTIME],
    repoRoot,
  );
  const files = listed
    .split("\n")
    .filter(Boolean)
    .filter((path) => existsSync(join(repoRoot, path)))
    .map((path) => path.slice(RUNTIME.length + 1))
    .filter((path) => path !== ".gitignore")
    .sort();
  expect((await manifest(repoRoot)).sort()).toEqual(files);
});

test("attach refuses a directory that is not a worktree root, and changes nothing", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const root = join(parent, "nested");
    await makeRepo(root, { "sub/file.txt": "x\n" });

    const result = await adhd(checkout, ["attach", join(root, "sub")], parent);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not the root of a Git worktree");
    expect(existsSync(join(root, "sub", RUNTIME))).toBe(false);
    expect(existsSync(join(root, RUNTIME))).toBe(false);
  });
});

test("attach refuses a runtime folder it did not create", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const root = join(parent, "foreign");
    await makeRepo(root, { [`${RUNTIME}/devcontainer.json`]: "{}\n" });

    const result = await adhd(checkout, ["attach", root], parent);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("was not created by adhd");
    expect(await readFile(join(root, RUNTIME, "devcontainer.json"), "utf8")).toBe("{}\n");
  });
});

test("attach rejects an unknown agent before changing anything", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const root = join(parent, "bad-agent");
    await makeRepo(root);

    const result = await adhd(checkout, ["attach", root, "--agents", "claude,foo"], parent);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unknown tool 'foo'");
    expect(existsSync(join(root, RUNTIME))).toBe(false);
  });
});

test("attach refuses untracked mode once git tracks files in the runtime folder", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const root = join(parent, "force-added");
    await makeRepo(root);
    expect((await adhd(checkout, ["attach", root, "--agents", "claude"], parent)).exitCode).toBe(0);
    await checked(["git", "add", "-f", `${RUNTIME}/devcontainer.json`], root);

    const result = await adhd(checkout, ["attach", root], parent);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("git already tracks files in .devcontainer/project-adhd; use --track");
  });
});
