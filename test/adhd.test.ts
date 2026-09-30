import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CommandResult,
  checked,
  commitFiles,
  headTag,
  hostBash,
  makeInstallation,
  makeRepo,
  publishRelease,
  pushCommit,
  readChannel,
  repoRoot,
  run,
  setChannel,
  withTemporaryParent,
  writeStubs,
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

async function attached(parent: string, name: string): Promise<{ checkout: string; root: string }> {
  const { checkout } = await makeInstallation(parent);
  const root = join(parent, name);
  await makeRepo(root);
  const result = await adhd(checkout, ["attach", root, "--agents", "claude"], parent);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return { checkout, root };
}

test("rerunning attach with nothing changed is a no-op", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout, root } = await attached(parent, "idempotent");
    const marker = await readFile(join(root, RUNTIME, ".adhd"), "utf8");

    const result = await adhd(checkout, ["attach", root], parent);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("warning");
    expect(await readFile(join(root, RUNTIME, ".adhd"), "utf8")).toBe(marker);
    const listed = await checked(["find", join(root, RUNTIME), "-name", "*.adhd-new"], root);
    expect(listed).toBe("");
    const exclude = await readFile(join(root, ".git/info/exclude"), "utf8");
    expect(exclude.split("# >>> project-adhd").length - 1).toBe(1);
    expect(await status(root)).toBe("");
  });
});

test("refresh updates unedited files, keeps edited ones, and preserves devcontainer.env", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout, root } = await attached(parent, "refresh");
    const envFile = join(root, RUNTIME, "devcontainer.env");
    await writeFile(envFile, "AGENT_TOOLS=claude\nCONTEXT7_API_KEY=mine\n");
    const editedFile = join(root, RUNTIME, "devcontainer.json");
    const edited = `${await readFile(editedFile, "utf8")}\n`;
    await writeFile(editedFile, edited);
    for (const file of ["devcontainer.json", "verify.sh"]) {
      const source = join(checkout, RUNTIME, file);
      await writeFile(source, `${await readFile(source, "utf8")}\n# newer\n`);
    }

    const result = await adhd(checkout, ["attach", root], parent);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("kept your edited .devcontainer/project-adhd/devcontainer.json");
    expect(await readFile(editedFile, "utf8")).toBe(edited);
    expect(await readFile(`${editedFile}.adhd-new`, "utf8")).toBe(
      await readFile(join(checkout, RUNTIME, "devcontainer.json"), "utf8"),
    );
    expect(await readFile(join(root, RUNTIME, "verify.sh"), "utf8")).toBe(
      await readFile(join(checkout, RUNTIME, "verify.sh"), "utf8"),
    );
    expect(await readFile(envFile, "utf8")).toBe("AGENT_TOOLS=claude\nCONTEXT7_API_KEY=mine\n");

    const second = await adhd(checkout, ["attach", root], parent);
    expect(second.exitCode).toBe(0);
    expect(second.stderr).not.toContain("kept your edited");
    expect(await readFile(editedFile, "utf8")).toBe(edited);
  });
});

test("refresh leaves a user-edited file alone when nothing new was shipped", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout, root } = await attached(parent, "edited-quiet");
    const editedFile = join(root, RUNTIME, "devcontainer.json");
    const edited = `${await readFile(editedFile, "utf8")}\n// mine\n`;
    await writeFile(editedFile, edited);

    const result = await adhd(checkout, ["attach", root], parent);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("warning");
    expect(await readFile(editedFile, "utf8")).toBe(edited);
    expect(existsSync(`${editedFile}.adhd-new`)).toBe(false);
  });
});

test("refresh accepts an adopted .adhd-new and later updates that file in place", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout, root } = await attached(parent, "adopted");
    const editedFile = join(root, RUNTIME, "devcontainer.json");
    const source = join(checkout, RUNTIME, "devcontainer.json");
    await writeFile(editedFile, `${await readFile(editedFile, "utf8")}\n// mine\n`);
    await writeFile(source, `${await readFile(source, "utf8")}\n// newer\n`);
    const offered = await adhd(checkout, ["attach", root], parent);
    expect(offered.stderr).toContain("kept your edited .devcontainer/project-adhd/devcontainer.json");
    await checked(["mv", `${editedFile}.adhd-new`, editedFile], root);
    const listRuntime = () => checked(["find", join(root, RUNTIME), "-type", "f"], root);
    const filesBefore = await listRuntime();

    const accepted = await adhd(checkout, ["attach", root], parent);

    expect(accepted.exitCode).toBe(0);
    expect(accepted.stderr).not.toContain("warning");
    expect(await listRuntime()).toBe(filesBefore);
    expect(await readFile(editedFile, "utf8")).toBe(await readFile(source, "utf8"));

    await writeFile(source, `${await readFile(source, "utf8")}// newest\n`);
    const updated = await adhd(checkout, ["attach", root], parent);

    expect(updated.exitCode).toBe(0);
    expect(updated.stderr).not.toContain("kept your edited");
    expect(await readFile(editedFile, "utf8")).toBe(await readFile(source, "utf8"));
    expect(existsSync(`${editedFile}.adhd-new`)).toBe(false);
  });
});

test("a failed attach leaves no trace and does not block a retry", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const root = join(parent, "failed-attach");
    await makeRepo(root);
    await rm(join(checkout, RUNTIME, "lib/collect.ts"));

    const failed = await adhd(checkout, ["attach", root, "--agents", "claude"], parent);

    expect(failed.exitCode).not.toBe(0);
    expect(failed.stderr).toContain("the installation is incomplete");
    expect(existsSync(join(root, ".devcontainer"))).toBe(false);
    expect(await status(root)).toBe("");

    await checked(["git", "-C", checkout, "checkout", "--", `${RUNTIME}/lib/collect.ts`], checkout);
    const retried = await adhd(checkout, ["attach", root, "--agents", "claude"], parent);
    expect(retried.exitCode).toBe(0);
    expect(existsSync(join(root, RUNTIME, "lib/collect.ts"))).toBe(true);
  });
});

test("a failed refresh keeps the existing runtime and marker and leaves no temp file", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout, root } = await attached(parent, "failed-refresh");
    const markerPath = join(root, RUNTIME, ".adhd");
    const marker = await readFile(markerPath, "utf8");
    await rm(join(checkout, RUNTIME, "lib/collect.ts"));

    const failed = await adhd(checkout, ["attach", root], parent);

    expect(failed.exitCode).not.toBe(0);
    expect(await readFile(markerPath, "utf8")).toBe(marker);
    expect(existsSync(join(root, RUNTIME, "lib/collect.ts"))).toBe(true);
    expect(await checked(["find", join(root, RUNTIME), "-name", ".adhd.*"], root)).toBe("");
  });
});

test("refresh removes a retired runtime file unless the user edited it", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout, root } = await attached(parent, "retired");
    const markerPath = join(root, RUNTIME, ".adhd");
    const pristine = join(root, RUNTIME, "lib/retired.ts");
    const edited = join(root, RUNTIME, "lib/retired-edited.ts");
    await writeFile(pristine, "export {};\n");
    await writeFile(edited, "export {};\n");
    const pristineSha = (await checked(["shasum", "-a", "256", pristine], root)).split(" ")[0];
    await writeFile(
      markerPath,
      `${await readFile(markerPath, "utf8")}sha:lib/retired.ts=${pristineSha}\nsha:lib/retired-edited.ts=${pristineSha}\n`,
    );
    await writeFile(edited, "export const mine = 1;\n");

    const result = await adhd(checkout, ["attach", root], parent);

    expect(result.exitCode).toBe(0);
    expect(existsSync(pristine)).toBe(false);
    expect(existsSync(edited)).toBe(true);
    expect(result.stderr).toContain("kept .devcontainer/project-adhd/lib/retired-edited.ts");
    expect(await readFile(markerPath, "utf8")).not.toContain("retired");
  });
});

const GH_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "auth status") [ -z "$GH_UNAUTHENTICATED" ] || exit 1 ;;
  "repo clone")
    git init -q "$4" &&
      git -C "$4" -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m init ;;
  "repo create")
    git init -q "$(basename "$3")" ;;
esac
`;

async function ghEnv(parent: string, extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const stubBin = join(parent, "gh-bin");
  await writeStubs(stubBin, { gh: GH_STUB });
  return { PATH: `${stubBin}:${process.env.PATH ?? ""}`, GH_LOG: join(parent, "gh.log"), ...extra };
}

test("attach --track writes committed ignore rules and a tracked marker", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const root = join(parent, "tracked");
    await makeRepo(root);

    const result = await adhd(checkout, ["attach", root, "--track", "--agents", "claude"], parent);

    expect(result.exitCode).toBe(0);
    expect(await readFile(join(root, RUNTIME, ".gitignore"), "utf8")).toBe(
      "/.env\n/devcontainer.env\n*.adhd-new\n",
    );
    expect(await readFile(join(root, RUNTIME, ".adhd"), "utf8")).toStartWith("mode=tracked\n");
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(BLOCK);
    const changes = await status(root);
    expect(changes).toContain(`?? ${RUNTIME}/.adhd`);
    expect(changes).toContain(`?? ${RUNTIME}/devcontainer.json`);
    expect(changes).toContain("?? .gitignore");
    expect(changes).not.toContain("devcontainer.env\n");
    expect(changes).not.toContain(`${RUNTIME}/.env`);
  });
});

test("this repository's runtime .gitignore is the tracked-mode rule set", async () => {
  expect(await readFile(join(repoRoot, RUNTIME, ".gitignore"), "utf8")).toBe(
    "/.env\n/devcontainer.env\n*.adhd-new\n",
  );
});

test("attach refuses to switch modes without a detach", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const root = join(parent, "switch");
    await makeRepo(root);
    expect((await adhd(checkout, ["attach", root, "--agents", "claude"], parent)).exitCode).toBe(0);

    const result = await adhd(checkout, ["attach", root, "--track"], parent);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("was attached untracked; run adhd detach first");
  });
});

test("attach clones owner/repo and GitHub URLs with gh before attaching", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const env = await ghEnv(parent);

    for (const [spec, directory] of [
      ["acme/widget", "widget"],
      ["https://github.com/acme/gadget.git", "gadget"],
      ["git@github.com:acme/gizmo.git", "gizmo"],
    ] as const) {
      const result = await adhd(checkout, ["attach", spec, "--agents", "claude"], parent, env);
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(parent, directory, RUNTIME, ".adhd"))).toBe(true);
    }
    const log = await readFile(env.GH_LOG, "utf8");
    expect(log).toContain("repo clone acme/widget widget");
    expect(log).toContain("repo clone https://github.com/acme/gadget.git gadget");
  });
});

test("attach refuses to clone over an existing directory or without gh auth", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    await mkdir(join(parent, "widget"));

    const exists = await adhd(checkout, ["attach", "acme/widget"], parent, await ghEnv(parent));
    expect(exists.exitCode).not.toBe(0);
    expect(exists.stderr).toContain("widget already exists; to attach it, run: adhd attach widget");

    const unauthenticated = await adhd(
      checkout,
      ["attach", "acme/other"],
      parent,
      await ghEnv(parent, { GH_UNAUTHENTICATED: "1" }),
    );
    expect(unauthenticated.exitCode).not.toBe(0);
    expect(unauthenticated.stderr).toContain("gh auth login");
    expect(existsSync(join(parent, "other"))).toBe(false);
  });
});

test("attach reports a missing relative path instead of treating it as owner/repo", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const env = await ghEnv(parent);

    const result = await adhd(checkout, ["attach", "./missing/dir"], parent, env);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("no such directory: ./missing/dir");
    expect(existsSync(env.GH_LOG)).toBe(false);
  });
});

test("new creates a private repository with gh and attaches it tracked", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const env = await ghEnv(parent);

    const privateRepo = await adhd(checkout, ["new", "acme/widget", "--agents", "claude"], parent, env);
    const publicRepo = await adhd(checkout, ["new", "gadget", "--public"], parent, env);

    expect(privateRepo.exitCode).toBe(0);
    expect(publicRepo.exitCode).toBe(0);
    const log = await readFile(env.GH_LOG, "utf8");
    expect(log).toContain("repo create acme/widget --private --clone");
    expect(log).toContain("repo create gadget --public --clone");
    expect(await readFile(join(parent, "widget", RUNTIME, ".adhd"), "utf8")).toStartWith("mode=tracked\n");
    expect(await readFile(join(parent, "widget", RUNTIME, "devcontainer.env"), "utf8")).toMatch(/^AGENT_TOOLS=claude$/m);
    expect(privateRepo.stdout).toContain('git commit -m "chore: add project-adhd dev container"');
  });
});

test("detach restores an untracked attachment exactly", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const root = join(parent, "round-trip");
    await makeRepo(root);
    const exclude = join(root, ".git/info/exclude");
    // Some git installs ship no templates, so info/exclude may not exist yet.
    const readExclude = async () => (existsSync(exclude) ? readFile(exclude, "utf8") : "");
    const excludeBefore = await readExclude();
    const statusBefore = await status(root);
    expect((await adhd(checkout, ["attach", root, "--agents", "claude"], parent)).exitCode).toBe(0);

    const result = await adhd(checkout, ["detach"], root);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, ".devcontainer"))).toBe(false);
    expect(await readExclude()).toBe(excludeBefore);
    expect(await status(root)).toBe(statusBefore);
    expect(result.stdout).toContain(
      `Detached project-adhd from ${root} (removed .devcontainer/project-adhd/, including devcontainer.env and any local edits)`,
    );
    expect(result.stdout).toContain("docker volume ls --filter name=project-adhd-shared");
  });
});

test("detach removes a tracked attachment's root .gitignore block", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const root = join(parent, "tracked-detach");
    await makeRepo(root, { ".gitignore": "node_modules/\n" });
    expect((await adhd(checkout, ["attach", root, "--track", "--agents", "claude"], parent)).exitCode).toBe(0);

    expect((await adhd(checkout, ["detach", root], parent)).exitCode).toBe(0);

    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("node_modules/\n");
    expect(await status(root)).toBe("");
  });
});

test("detach refuses a runtime folder adhd did not create", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const root = join(parent, "foreign-detach");
    await makeRepo(root, { [`${RUNTIME}/devcontainer.json`]: "{}\n" });

    const result = await adhd(checkout, ["detach", root], parent);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("was not created by adhd");
    expect(existsSync(join(root, RUNTIME, "devcontainer.json"))).toBe(true);
  });
});

test("attach refuses a symlinked .devcontainer and writes nothing through it", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const outside = join(parent, "outside");
    await mkdir(outside);
    const root = join(parent, "symlinked-devcontainer");
    await makeRepo(root);
    await symlink(outside, join(root, ".devcontainer"));

    const result = await adhd(checkout, ["attach", root, "--agents", "claude"], parent);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("refusing to follow the symlink");
    expect(existsSync(join(outside, "project-adhd"))).toBe(false);
  });
});

test("attach refuses a symlink inside the runtime folder", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const victim = join(parent, "victim");
    await writeFile(victim, "precious\n");
    const root = join(parent, "symlinked-runtime-file");
    await makeRepo(root, { [`${RUNTIME}/.adhd`]: "mode=tracked\n", [`${RUNTIME}/initialize.sh`]: "edited\n" });
    await symlink(victim, join(root, RUNTIME, "initialize.sh.adhd-new"));

    const result = await adhd(checkout, ["attach", root, "--track", "--agents", "claude"], parent);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("refusing to follow the symlink");
    expect(await readFile(victim, "utf8")).toBe("precious\n");
  });
});

test("attach --track refuses a symlinked root .gitignore", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const victim = join(parent, "victim");
    await writeFile(victim, "precious\n");
    const root = join(parent, "symlinked-gitignore");
    await makeRepo(root);
    await symlink(victim, join(root, ".gitignore"));

    const result = await adhd(checkout, ["attach", root, "--track", "--agents", "claude"], parent);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("refusing to follow the symlink");
    expect(await readFile(victim, "utf8")).toBe("precious\n");
    expect(existsSync(join(root, ".devcontainer"))).toBe(false);
  });
});

test("detach refuses a symlinked .devcontainer and keeps its target", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const other = join(parent, "other");
    await makeRepo(other);
    expect((await adhd(checkout, ["attach", other, "--agents", "claude"], parent)).exitCode).toBe(0);
    const root = join(parent, "symlinked-detach");
    await makeRepo(root);
    await symlink(join(other, ".devcontainer"), join(root, ".devcontainer"));

    const result = await adhd(checkout, ["detach", root], parent);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("refusing to follow the symlink");
    expect(existsSync(join(other, RUNTIME, "devcontainer.env"))).toBe(true);
  });
});

test("detach keeps the shared exclude block while another worktree is attached", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const root = join(parent, "main-wt");
    const linked = join(parent, "linked-wt");
    await makeRepo(root);
    await checked(["git", "-C", root, "worktree", "add", "-q", linked, "-b", "feature/x"], root);
    expect((await adhd(checkout, ["attach", root, "--agents", "claude"], parent)).exitCode).toBe(0);
    expect((await adhd(checkout, ["attach", linked, "--agents", "claude"], parent)).exitCode).toBe(0);
    const exclude = join(root, ".git/info/exclude");

    expect((await adhd(checkout, ["detach", root], parent)).exitCode).toBe(0);
    expect(await readFile(exclude, "utf8")).toContain("# >>> project-adhd");

    expect((await adhd(checkout, ["detach", linked], parent)).exitCode).toBe(0);
    expect(await readFile(exclude, "utf8")).not.toContain("# >>> project-adhd");
  });
});

test("update follows main when the channel is main", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout, origin } = await makeInstallation(parent);
    await setChannel(checkout, "main");
    await pushCommit(parent, origin, { NEWS: "new\n" });

    const result = await adhd(checkout, ["update"], parent);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(checkout, "NEWS"))).toBe(true);
    expect(result.stdout).toContain("adhd attach");
  });
});

test("update moves a release install to the newest tag and reports it", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout, origin } = await makeInstallation(parent);
    await setChannel(checkout, "release");
    for (const version of ["0.1.0", "0.2.0", "0.10.0", "0.3.0-rc.1"]) {
      await publishRelease(parent, origin, version);
    }

    const result = await adhd(checkout, ["update"], parent);

    expect(result.exitCode).toBe(0);
    expect(await headTag(checkout)).toBe("v0.10.0");
    expect(result.stdout).toContain("Updated project-adhd 0.0.0 → 0.10.0");
    expect(result.stdout).toContain("releases/tag/v0.10.0");
    expect(result.stdout).toContain("adhd attach");

    const again = await adhd(checkout, ["update"], parent);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("project-adhd is already at 0.10.0");
  });
});

test("update --ref pins a tag, keeps the pin, and --ref release unpins", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout, origin } = await makeInstallation(parent);
    await setChannel(checkout, "release");
    await publishRelease(parent, origin, "0.1.0");
    await publishRelease(parent, origin, "0.2.0");

    expect((await adhd(checkout, ["update", "--ref", "v0.1.0"], parent)).exitCode).toBe(0);
    expect(await headTag(checkout)).toBe("v0.1.0");
    expect(await readChannel(checkout)).toBe("v0.1.0");

    await publishRelease(parent, origin, "0.3.0");
    expect((await adhd(checkout, ["update"], parent)).exitCode).toBe(0);
    expect(await headTag(checkout)).toBe("v0.1.0");

    expect((await adhd(checkout, ["update", "--ref=release"], parent)).exitCode).toBe(0);
    expect(await headTag(checkout)).toBe("v0.3.0");
    expect(await readChannel(checkout)).toBe("release");
  });
});

test("update --ref main leaves a detached tag for the branch", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout, origin } = await makeInstallation(parent);
    await setChannel(checkout, "release");
    await publishRelease(parent, origin, "0.1.0");
    expect((await adhd(checkout, ["update"], parent)).exitCode).toBe(0);
    await pushCommit(parent, origin, { NEWS: "unreleased\n" });

    const result = await adhd(checkout, ["update", "--ref", "main"], parent);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(checkout, "NEWS"))).toBe(true);
    expect((await checked(["git", "-C", checkout, "symbolic-ref", "--short", "HEAD"], checkout)).trim()).toBe("main");
    expect(await readChannel(checkout)).toBe("main");
  });
});

test("update rejects an unknown ref and keeps the channel", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    await setChannel(checkout, "release");

    const unknown = await adhd(checkout, ["update", "--ref", "v9.9.9"], parent);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toContain("no release tag or branch named v9.9.9");
    expect(await readChannel(checkout)).toBe("release");

    const reserved = await adhd(checkout, ["update", "--ref", "checkout"], parent);
    expect(reserved.exitCode).not.toBe(0);
    expect(reserved.stderr).toContain("checkout is not a ref");
    expect(await readChannel(checkout)).toBe("release");
  });
});

test("update refuses local changes and development checkouts", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    await setChannel(checkout, "release");
    await writeFile(join(checkout, "install.sh"), `${await readFile(join(checkout, "install.sh"), "utf8")}# local\n`);

    const dirty = await adhd(checkout, ["update"], parent);
    expect(dirty.exitCode).not.toBe(0);
    expect(dirty.stderr).toContain("has local changes");
    await checked(["git", "-C", checkout, "checkout", "--", "install.sh"], checkout);

    await setChannel(checkout, "checkout");
    const marked = await adhd(checkout, ["update"], parent);
    expect(marked.exitCode).not.toBe(0);
    expect(marked.stderr).toContain("is a development checkout");

    await checked(["git", "-C", checkout, "config", "--unset", "adhd.ref"], checkout);
    const legacy = await adhd(checkout, ["update"], parent);
    expect(legacy.exitCode).not.toBe(0);
    expect(legacy.stderr).toContain("is a development checkout");
    expect(legacy.stderr).toContain("config adhd.ref release");
    expect((await checked(["git", "-C", checkout, "symbolic-ref", "--short", "HEAD"], checkout)).trim()).toBe("main");
  });
});

test("update migrates a pre-release install at the default location", async () => {
  await withTemporaryParent(async (parent) => {
    const { origin } = await makeInstallation(parent);
    const home = join(parent, "home");
    const installed = join(home, ".local/share/project-adhd");
    await mkdir(join(home, ".local/share"), { recursive: true });
    await checked(["git", "clone", "-q", origin, installed], parent);
    await publishRelease(parent, origin, "0.1.0");

    const result = await adhd(installed, ["update"], parent, { HOME: home });

    expect(result.exitCode).toBe(0);
    expect(await headTag(installed)).toBe("v0.1.0");
    expect(await readChannel(installed)).toBe("release");
  });
});

test("--version reports a clean release tag and the channel", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    await commitFiles(checkout, { VERSION: "0.1.0\n" }, "chore: release 0.1.0", "v0.1.0");
    await setChannel(checkout, "release");

    const result = await adhd(checkout, ["--version"], parent);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("adhd 0.1.0 (release)\n");
    expect((await adhd(checkout, ["version"], parent)).stdout).toBe("adhd 0.1.0 (release)\n");
  });
});

test("--version describes commits past the tag and local changes", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    await commitFiles(checkout, { VERSION: "0.1.0\n" }, "chore: release 0.1.0", "v0.1.0");
    await commitFiles(checkout, { NEWS: "one\n" }, "feat: news");
    await setChannel(checkout, "main");

    const past = await adhd(checkout, ["--version"], parent);
    expect(past.stdout).toMatch(/^adhd 0\.1\.0\+1\.g[0-9a-f]{7,} \(main\)\n$/);

    await writeFile(join(checkout, "NEWS"), "two\n");
    const dirty = await adhd(checkout, ["--version"], parent);
    expect(dirty.stdout).toMatch(/^adhd 0\.1\.0\+1\.g[0-9a-f]{7,}\.dirty \(main\)\n$/);
  });
});

test("--version labels a pinned tag and an unmanaged checkout", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    await commitFiles(checkout, { VERSION: "0.1.0\n" }, "chore: release 0.1.0", "v0.1.0");

    await setChannel(checkout, "v0.1.0");
    expect((await adhd(checkout, ["--version"], parent)).stdout).toBe("adhd 0.1.0 (pinned v0.1.0)\n");

    await checked(["git", "-C", checkout, "config", "--unset", "adhd.ref"], checkout);
    expect((await adhd(checkout, ["--version"], parent)).stdout).toBe("adhd 0.1.0 (checkout)\n");
  });
});

test("--version falls back to VERSION when git fails", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    await commitFiles(checkout, { VERSION: "0.1.0\n" }, "chore: release 0.1.0", "v0.1.0");
    const stubs = join(parent, "stubs");
    await writeStubs(stubs, { git: "#!/bin/sh\nexit 1\n" });

    const result = await adhd(checkout, ["--version"], parent, { PATH: `${stubs}:${process.env.PATH ?? ""}` });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("adhd 0.1.0 (checkout)\n");
  });
});

test("attach records the version in the marker and reports a version change", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout, root } = await attached(parent, "versioned");
    const marker = join(root, RUNTIME, ".adhd");
    expect(await readFile(marker, "utf8")).toMatch(/^mode=untracked\nsource=[^\n]+\nversion=0\.0\.0\n/);

    await commitFiles(checkout, { VERSION: "0.1.0\n" }, "chore: release 0.1.0", "v0.1.0");
    const refreshed = await adhd(checkout, ["attach", root], parent);

    expect(refreshed.exitCode).toBe(0);
    expect(refreshed.stdout).toContain("Refreshed the runtime: 0.0.0 → 0.1.0");
    expect(await readFile(marker, "utf8")).toMatch(/^version=0\.1\.0$/m);

    const again = await adhd(checkout, ["attach", root], parent);
    expect(again.stdout).not.toContain("Refreshed the runtime");
  });
});

test("usage lists version and update --ref", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);

    const result = await adhd(checkout, ["--help"], parent);

    expect(result.stdout).toContain("  version\n");
    expect(result.stdout).toContain("  update [--ref <release|branch|tag>]\n");
  });
});
