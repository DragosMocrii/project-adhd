import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    expect(result.stdout).toContain("docker volume ls");
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

test("update fast-forwards the installation", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout, origin } = await makeInstallation(parent);
    const other = join(parent, "other-clone");
    await checked(["git", "clone", "-q", origin, other], parent);
    await writeFile(join(other, "NEWS"), "new\n");
    await checked(["git", "-C", other, "add", "NEWS"], other);
    await checked(
      ["git", "-C", other, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "-m", "news"],
      other,
    );
    await checked(["git", "-C", other, "push", "-q", "origin", "HEAD"], other);

    const result = await adhd(checkout, ["update"], parent);

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(checkout, "NEWS"))).toBe(true);
    expect(result.stdout).toContain("adhd attach");
  });
});
