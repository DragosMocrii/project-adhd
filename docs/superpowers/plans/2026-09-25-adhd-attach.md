# adhd attach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn project-adhd from a GitHub template into a host CLI (`adhd`) that attaches its Dev Container to any existing Git repository, with agent credentials and plugins shared across repositories.

**Architecture:** The runtime Dev Container files move into `.devcontainer/project-adhd/`, which `adhd attach` copies into a target clone and hides from Git (a self-ignoring `.gitignore` plus a block in `.git/info/exclude`). `initialize.sh` writes four Compose values so that each worktree gets its own container while agent state volumes are shared under one fixed prefix. The host CLI is plain bash 3.2, split into a dispatcher (`bin/adhd`) and one file per subcommand under `libexec/adhd/`.

**Tech Stack:** bash (3.2-compatible on the host, 4+ in the container), Docker Compose, Dev Containers, Bun 1.4.0 + `bun:test` for the contract suite, TypeScript 7 (`tsc --noEmit`), ShellCheck, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-25-adhd-attach-design.md` — read it before starting any task.

## Global Constraints

- Host scripts (`install.sh`, `bin/adhd`, `libexec/adhd/*.sh`, `.devcontainer/project-adhd/initialize.sh`, `.devcontainer/project-adhd/lib/agent-tools.sh`) must run under **bash 3.2**: no associative arrays, no `${var,,}`/`${var^^}`, no `mapfile`/`readarray`, no `|&`; no `sed -i`, `stat -c`, `readlink -f`, `realpath`; resolve paths with `cd -P` + `pwd -P`; hash with `sha256sum`, falling back to `shasum -a 256`.
- Under `set -u` in bash 3.2, never expand a possibly-empty array as `"${arr[@]}"`.
- Container scripts (`post-create.sh`, `verify.sh`) keep bash 4+ and GNU tools.
- Every shell script uses `set -euo pipefail` (sourced files excepted) and a local `die()`/`fail()` helper.
- No `jq`. Agent CLI installers stay unpinned.
- `NO_BROWSER=true` stays in `containerEnv`.
- Runtime folder: `.devcontainer/project-adhd/`. Shared agent prefix: the literal `project-adhd-shared`.
- Canonical prefix file keeps its name and format: `<git-common-dir>/.agentic-bun-devcontainer-prefix`, one line `PROJECT_STATE_PREFIX=<prefix>`.
- `.env` in the runtime folder holds exactly, in order: `PROJECT_STATE_PREFIX`, `COMPOSE_INSTANCE`, `AGENT_STATE_PREFIX`, `WORKSPACE_NAME`.
- Exclude/ignore block, exactly:
  ```
  # >>> project-adhd
  /.worktrees/
  /.claude/worktrees/
  /.superpowers/
  /docs/superpowers/
  # <<< project-adhd
  ```
- Tracked-mode runtime `.gitignore`, exactly: `/.env`, `/devcontainer.env`, `*.adhd-new` (one per line).
- `workspaceFolder`: `/workspaces/${localWorkspaceFolderBasename}`.
- post-create lock: `~/.local/state/project-adhd/post-create.lock`, 600-second wait, message `==> Waiting for another project-adhd setup to finish`.
- Contract tests never touch the network: stub commands on `PATH`, temporary `HOME`, temporary repositories.

## Review Focus

1. **An `info/exclude` or root `.gitignore` without a trailing newline** — attach must not glue `# >>> project-adhd` onto the user's last rule. Test in Task 7.
2. **Detaching one worktree while another is still attached** — the shared exclude block must stay until the last untracked attachment is gone. Test in Task 10.
3. **Repository paths containing spaces** (`My Project`) through attach, initialize, and Compose. Tests in Tasks 4, 5, and 7.
4. **Re-running `attach` with nothing changed** — no `.adhd-new` files, no duplicated exclude block, and an unchanged marker. Test in Task 8.
5. **Relative targets** (`.`, `My Project/` with a trailing slash) must resolve to the same canonical root as an absolute path. Test in Task 7.

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `test/helpers.ts` | Shared test harness: paths, `run`/`checked`, temp dirs, stubs, fixture repos | 1, 2, 7, 11 |
| `test/initialize.test.ts` | Host: `initialize.sh` | 1, 4 |
| `test/post-create.test.ts` | Container: `post-create.sh` | 1, 6 |
| `test/verify.test.ts` | Container: `verify.sh` | 1 |
| `test/config.test.ts` | Static config and docs contracts, Compose rendering | 1, 2, 5, 13 |
| `test/portability.test.ts` | Static bash-3.2/BSD guard over host scripts | 3 |
| `test/adhd.test.ts` | Host: `adhd` subcommands | 7–10 |
| `test/install.test.ts` | Host: `install.sh` | 11 |
| `.devcontainer/project-adhd/*` | Runtime files (moved) | 2, 4, 5, 6 |
| `.devcontainer/project-adhd/.gitignore` | Tracked-mode ignore rules for this repo | 2 |
| `bin/adhd` | Dispatcher; resolves `ADHD_HOME` | 7 |
| `libexec/adhd/common.sh` | Shared host helpers, runtime manifest, ignore blocks, marker | 7, 8, 9, 10 |
| `libexec/adhd/attach.sh` | `adhd attach` | 7, 8, 9 |
| `libexec/adhd/detach.sh` | `adhd detach` | 10 |
| `libexec/adhd/update.sh` | `adhd update` | 10 |
| `libexec/adhd/new.sh` | `adhd new` | 9 |
| `install.sh` | Host installer | 11 |
| `package.json`, `bun.lock`, `tsconfig.json` | Moved to root | 2 |
| `.github/workflows/ci.yml` | Linux suite, macOS host job, ShellCheck | 2, 12 |
| `README.md`, `AGENTS.md`, `SECURITY.md` | Docs | 2, 13 |

`libexec/adhd/` is a structural addition beyond the spec's `bin/adhd`: one file per subcommand keeps each unit small and lets every task own one file.

---

### Task 1: Split the contract suite into focused test files

Pure refactor, before anything moves. Test count stays at 41.

**Files:**
- Create: `.devcontainer/test/helpers.ts`, `.devcontainer/test/initialize.test.ts`, `.devcontainer/test/post-create.test.ts`, `.devcontainer/test/verify.test.ts`, `.devcontainer/test/config.test.ts`
- Delete: `.devcontainer/test/scaffold.test.ts`

**Interfaces:**
- Produces (`helpers.ts`): `repoRoot`, `runtimeDir`, `initializerPath`, `postCreatePath`, `verifyPath`, `devcontainerConfigPath`, `composePath`, `gitignorePath`, `hostBash`, `type CommandResult`, `run(command, cwd, env?)`, `checked(command, cwd, env?)`, `withTemporaryParent(cb)`, `writeStubs(dir, stubs)`, `STATE_DIRECTORIES`, `makeHome(parent) → {home, stubBin}`, `prepareRepository(root)`.

- [ ] **Step 1: Record the baseline**

Run: `cd .devcontainer && bun test 2>&1 | tail -3`
Expected: `41 pass`, `0 fail`.

- [ ] **Step 2: Create `.devcontainer/test/helpers.ts`**

```ts
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const repoRoot = resolve(import.meta.dir, "../..");
export const runtimeDir = join(repoRoot, ".devcontainer");
export const initializerPath = join(runtimeDir, "initialize.sh");
export const postCreatePath = join(runtimeDir, "post-create.sh");
export const verifyPath = join(runtimeDir, "verify.sh");
export const devcontainerConfigPath = join(runtimeDir, "devcontainer.json");
export const composePath = join(runtimeDir, "docker-compose.yml");
export const gitignorePath = join(repoRoot, ".gitignore");

// Host scripts must run under bash 3.2; CI's macOS job sets /bin/bash here.
export const hostBash = process.env.ADHD_TEST_BASH ?? "bash";

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export async function run(
  command: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<CommandResult> {
  const mergedEnv: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ...env,
  };
  if (env?.AGENT_TOOLS === undefined) {
    delete mergedEnv.AGENT_TOOLS;
  }
  const childProcess = Bun.spawn(command, {
    cwd,
    env: mergedEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(childProcess.stdout).text(),
    new Response(childProcess.stderr).text(),
  ]);
  return { exitCode: await childProcess.exited, stdout, stderr };
}

export async function checked(
  command: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<string> {
  const result = await run(command, cwd, env);
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed with exit code ${result.exitCode}\n` +
        `${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

export async function withTemporaryParent<T>(
  callback: (parent: string) => Promise<T>,
): Promise<T> {
  const parent = await mkdtemp(join(tmpdir(), "project-adhd-test-"));
  try {
    return await callback(parent);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
}

export async function writeStubs(
  directory: string,
  stubs: Record<string, string>,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const [name, contents] of Object.entries(stubs)) {
    const path = join(directory, name);
    await writeFile(path, contents);
    await chmod(path, 0o755);
  }
}

// Every directory post-create.sh repairs; pre-creating them keeps tests off sudo.
export const STATE_DIRECTORIES = [
  ".claude",
  ".config/gh",
  ".config/rtk",
  ".local/share/rtk",
  ".codex",
  ".gemini",
  ".omp",
  ".bun",
  ".bun/bin",
  ".bun/install",
  ".bun/install/global",
];

export async function makeHome(parent: string): Promise<{ home: string; stubBin: string }> {
  const home = join(parent, "home");
  const stubBin = join(home, ".local", "bin");
  await mkdir(stubBin, { recursive: true });
  for (const directory of STATE_DIRECTORIES) {
    await mkdir(join(home, directory), { recursive: true });
  }
  return { home, stubBin };
}

export async function prepareRepository(root: string): Promise<void> {
  await mkdir(join(root, ".devcontainer"), { recursive: true });
  await copyFile(initializerPath, join(root, ".devcontainer", "initialize.sh"));
  await chmod(join(root, ".devcontainer", "initialize.sh"), 0o755);
  await copyFile(gitignorePath, join(root, ".gitignore"));
  await writeFile(join(root, "seed.txt"), "seed\n");

  await checked(["git", "init", "--initial-branch=main"], root);
  await checked(["git", "config", "user.email", "scaffold-tests@example.invalid"], root);
  await checked(["git", "config", "user.name", "Scaffold Tests"], root);
  await checked(["git", "add", "--", ".devcontainer/initialize.sh", ".gitignore", "seed.txt"], root);
  await checked(["git", "commit", "--message=initial"], root);
}
```

- [ ] **Step 3: Move each test verbatim into its new file**

Cut these tests from `scaffold.test.ts` (unchanged except as noted below) into:

| New file | Tests (by title) | Local helpers moved with them |
|---|---|---|
| `initialize.test.ts` | "normalizes the repository name and hashes its canonical Git common directory", "shares one state prefix between linked worktrees", "reuses the persisted prefix for a linked worktree created after a repository move", "fails instead of switching volumes when canonical and worktree prefixes conflict", "rejects a valid prefix followed by an unterminated extra state line", "separates independent repositories with the same basename", "preserves a valid state prefix and an existing devcontainer secret on reruns" | `runInitializer`, `readStatePrefix`, `canonicalGitCommonDirectory` |
| `post-create.test.ts` | "selects Codex default and API-key catalogs, preferring active/default, and rejects absence", "runs pre-login post-create successfully while still installing auth-free Archify", "installs Gemini CLI globally when the command is missing", "reports Bun trust query failures", "reinstalls RTK when the existing binary fails the RTK identity check", "installs and configures only the selected agent tool", "skips OMP Superpowers when omp is selected without claude" | `parseCodexMarketplace` (its `cwd` becomes `repoRoot`) |
| `verify.test.ts` | "verify skips checks for unselected tools and succeeds", "verify fails when a selected tool is missing from PATH" | `runVerify` |
| `config.test.ts` | "enforces root-scoped ignore rules for local state", "renders one Compose workspace with seven explicit state volumes and no published ports", "configures Gemini CLI for manual authentication", "presents one aligned project identity and a Bun-matched types pin", "documents AGENT_TOOLS in the tracked environment example", "documents a create command that works for someone who is not the repository owner", "ships agent guidance that Claude and Codex both resolve" | none |

Mechanical edits while moving:
- Replace `scaffoldRoot` with `repoRoot`, and the path constants with the ones imported from `./helpers`.
- In `initialize.test.ts`, run the initializer with `hostBash` instead of `"bash"` (in `runInitializer` and in the conflict test).
- In post-create tests, replace each block of `const home = …; const stubBin = …; await mkdir(stubBin…); for (const directory of [...]) mkdir(...)` with `const { home, stubBin } = await makeHome(parent);`, and each `for (const [name, contents] of Object.entries(stubs)) { … chmod … }` loop with `await writeStubs(stubBin, stubs);`. Tests that created only `stubBin` also switch to `makeHome`.
- In `verify.test.ts`'s `runVerify`, replace its stub loop with `await writeStubs(stubBin, stubs);`.
- The "identity" test reads `join(runtimeDir, "package.json")`; the env-example test reads `join(runtimeDir, "devcontainer.env.example")`.

Each file starts with `import { expect, test } from "bun:test";` plus exactly the `node:*` and `./helpers` imports it uses. `bun run typecheck` reports any unused or missing import.

- [ ] **Step 4: Delete the old file and run the suite**

Run: `git rm -q .devcontainer/test/scaffold.test.ts && cd .devcontainer && bun test 2>&1 | tail -3 && bun run typecheck`
Expected: `41 pass`, `0 fail`, and typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add .devcontainer/test
git commit -m "test: split the contract suite by where the code runs"
```

---

### Task 2: Move to the `.devcontainer/project-adhd/` layout

Moves files and fixes paths. No behaviour changes yet, except that `updateContentCommand` is dropped.

**Files:**
- Move: `.devcontainer/{devcontainer.json,devcontainer-lock.json,docker-compose.yml,initialize.sh,post-create.sh,verify.sh,devcontainer.env.example,lib}` → `.devcontainer/project-adhd/`
- Move: `.devcontainer/test/` → `test/`; `.devcontainer/{package.json,bun.lock,tsconfig.json}` → repo root
- Create: `.devcontainer/project-adhd/.gitignore`
- Modify: `.devcontainer/project-adhd/devcontainer.json`, `.devcontainer/project-adhd/docker-compose.yml`, `.devcontainer/project-adhd/initialize.sh`, `.devcontainer/project-adhd/post-create.sh:312`, `tsconfig.json`, `.gitignore`, `.omp/lsp.json`, `.github/workflows/ci.yml`, `AGENTS.md` (the "Verifying a change" block only), `test/helpers.ts`, `test/parsers.test.ts`, `test/agent-tools.test.ts`, `test/post-create.test.ts`, `test/config.test.ts`

**Interfaces:**
- Produces: `runtimeDir = <repo>/.devcontainer/project-adhd`; `prepareRepository(root)` puts `initialize.sh` and the runtime `.gitignore` under `root/.devcontainer/project-adhd/`.

- [ ] **Step 1: Move the files**

```bash
mkdir -p .devcontainer/project-adhd
git mv .devcontainer/devcontainer.json .devcontainer/devcontainer-lock.json \
  .devcontainer/docker-compose.yml .devcontainer/initialize.sh \
  .devcontainer/post-create.sh .devcontainer/verify.sh \
  .devcontainer/devcontainer.env.example .devcontainer/lib .devcontainer/project-adhd/
git mv .devcontainer/test test
git mv .devcontainer/package.json .devcontainer/bun.lock .devcontainer/tsconfig.json .
# Local, ignored state for this repo's own container:
for f in .env devcontainer.env; do
  [ -e ".devcontainer/$f" ] && mv ".devcontainer/$f" ".devcontainer/project-adhd/$f"
done
rm -rf .devcontainer/node_modules
bun install --frozen-lockfile
```

- [ ] **Step 2: Create `.devcontainer/project-adhd/.gitignore`**

```
/.env
/devcontainer.env
*.adhd-new
```

In the root `.gitignore`, delete the two lines `/.devcontainer/.env` and `/.devcontainer/devcontainer.env`.

- [ ] **Step 3: Update the test harness paths**

In `test/helpers.ts`:

```ts
export const repoRoot = resolve(import.meta.dir, "..");
export const runtimeDir = join(repoRoot, ".devcontainer", "project-adhd");
export const runtimeGitignorePath = join(runtimeDir, ".gitignore");
```

Replace `prepareRepository` with:

```ts
export async function prepareRepository(root: string): Promise<void> {
  const runtime = join(root, ".devcontainer", "project-adhd");
  await mkdir(runtime, { recursive: true });
  await copyFile(initializerPath, join(runtime, "initialize.sh"));
  await chmod(join(runtime, "initialize.sh"), 0o755);
  await copyFile(runtimeGitignorePath, join(runtime, ".gitignore"));
  await copyFile(gitignorePath, join(root, ".gitignore"));
  await writeFile(join(root, "seed.txt"), "seed\n");

  await checked(["git", "init", "--initial-branch=main"], root);
  await checked(["git", "config", "user.email", "scaffold-tests@example.invalid"], root);
  await checked(["git", "config", "user.name", "Scaffold Tests"], root);
  await checked(["git", "add", "-A"], root);
  await checked(["git", "commit", "--message=initial"], root);
}
```

In `test/initialize.test.ts`, replace every `join(root, ".devcontainer", …)` with `join(root, ".devcontainer", "project-adhd", …)`.

In `test/parsers.test.ts`, change the imports from `../lib/…` to `../.devcontainer/project-adhd/lib/…`, and set `const postCreatePath = join(runtimeDir, "post-create.sh");` (importing `runtimeDir` from `./helpers`; drop the local `scaffoldRoot` and use `repoRoot` wherever it was a `cwd`).

In `test/agent-tools.test.ts`, import `{ repoRoot, runtimeDir }` from `./helpers`, set `const libraryPath = join(runtimeDir, "lib", "agent-tools.sh");`, and use `repoRoot` as `cwd`.

In `test/post-create.test.ts`, change both `expect(result.stdout).toContain("bash .devcontainer/post-create.sh");` to `…("bash .devcontainer/project-adhd/post-create.sh")`.

In `test/config.test.ts`, the "identity" test reads `join(repoRoot, "package.json")`. In the Compose test, copy the file to `join(root, ".devcontainer", "project-adhd", "docker-compose.yml")`, write `devcontainer.env` beside it, and run `docker compose -f .devcontainer/project-adhd/docker-compose.yml config --format json`.

- [ ] **Step 4: Replace the ignore-rules test in `test/config.test.ts`**

Replace "enforces root-scoped ignore rules for local state" with:

```ts
test("ignores local state files inside the runtime folder only", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "ignore-rules");
    await mkdir(root);
    await prepareRepository(root);

    const folderRules = [
      [".devcontainer/project-adhd/.env", "/.env"],
      [".devcontainer/project-adhd/devcontainer.env", "/devcontainer.env"],
      [".devcontainer/project-adhd/docker-compose.yml.adhd-new", "*.adhd-new"],
    ] as const;
    for (const [path, rule] of folderRules) {
      const details = await run(
        ["git", "check-ignore", "--no-index", "--verbose", "--", path],
        root,
      );
      expect(details.exitCode).toBe(0);
      expect(details.stdout).toContain(".devcontainer/project-adhd/.gitignore:");
      expect(details.stdout).toContain(`:${rule}\t${path}`);
    }

    for (const path of [".worktrees/probe", ".claude/worktrees/probe", ".superpowers/probe"]) {
      const result = await run(["git", "check-ignore", "--no-index", "--quiet", "--", path], root);
      expect(result.exitCode).toBe(0);
    }

    const nested = await run(
      ["git", "check-ignore", "--no-index", "--quiet", "--", "nested/.devcontainer/project-adhd/devcontainer.env"],
      root,
    );
    expect(nested.exitCode).not.toBe(0);
  });
});
```

- [ ] **Step 5: Run the suite and watch it fail**

Run: `bun test 2>&1 | tail -15`
Expected: failures in the initializer tests (`missing .devcontainer directory`) and the two post-create hint assertions.

- [ ] **Step 6: Fix the runtime paths**

`.devcontainer/project-adhd/devcontainer.json`: delete the `updateContentCommand` line, and set:

```json
  "initializeCommand": "bash \"${localWorkspaceFolder}/.devcontainer/project-adhd/initialize.sh\" \"${localWorkspaceFolder}\"",
  "postCreateCommand": "bash .devcontainer/project-adhd/post-create.sh",
```

`.devcontainer/project-adhd/docker-compose.yml`: change the workspace mount to `- ../..:/workspace:cached`. The Compose file is now two levels below the repository root.

`.devcontainer/project-adhd/initialize.sh`: change `devcontainer_dir=$repo_root/.devcontainer` to `devcontainer_dir=$repo_root/.devcontainer/project-adhd`.

`.devcontainer/project-adhd/post-create.sh:312`: `echo '    After authenticating, rerun: bash .devcontainer/project-adhd/post-create.sh'`.

`tsconfig.json`: `"include": [".devcontainer/project-adhd/lib/**/*.ts", "test/**/*.ts"]`.

`.omp/lsp.json`: set `"args": ["node_modules/typescript/lib/tsc.js", "--lsp", "--stdio"]` and `"rootMarkers": ["package.json", "tsconfig.json", "jsconfig.json"]`.

`.github/workflows/ci.yml`: delete the three `working-directory: .devcontainer` lines, and replace the ShellCheck `run` with:

```yaml
        run: |
          shellcheck \
            .devcontainer/project-adhd/initialize.sh \
            .devcontainer/project-adhd/post-create.sh \
            .devcontainer/project-adhd/verify.sh \
            .devcontainer/project-adhd/lib/agent-tools.sh
```

`AGENTS.md`, "Verifying a change" code block:

```bash
bun test
bun run typecheck
shellcheck .devcontainer/project-adhd/*.sh .devcontainer/project-adhd/lib/agent-tools.sh
```

- [ ] **Step 7: Run everything**

Run: `bun test 2>&1 | tail -3 && bun run typecheck`
Expected: `41 pass`, `0 fail`; typecheck exits 0.

- [ ] **Step 8: Commit**

```bash
git add -A
git status --short   # must list no .env, devcontainer.env, or node_modules
git commit -m "refactor: move the runtime into .devcontainer/project-adhd and the suite to the root"
```

---

### Task 3: Make `agent-tools.sh` bash 3.2-safe, with a static portability guard

**Files:**
- Create: `test/portability.test.ts`
- Modify: `.devcontainer/project-adhd/lib/agent-tools.sh:24-58` (`agent_tools_init`)
- Modify: `test/agent-tools.test.ts` (run through `hostBash`)

**Interfaces:**
- Consumes: `hostBash`, `repoRoot` from `./helpers`.
- Produces: `agent_tools_init`, `agent_tool_selected`, `agent_tools_summary`, `agent_tools_join`, and `AGENT_TOOLS_SELECTED`, with unchanged behaviour. Later tasks source this file from the host.

- [ ] **Step 1: Write the failing portability test**

`test/portability.test.ts`:

```ts
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "./helpers";

// Every script that runs on the host. Files that do not exist yet are skipped,
// so later tasks are covered as soon as they create their files.
const HOST_SCRIPTS = [
  "install.sh",
  "bin/adhd",
  "libexec/adhd/common.sh",
  "libexec/adhd/attach.sh",
  "libexec/adhd/detach.sh",
  "libexec/adhd/update.sh",
  "libexec/adhd/new.sh",
  ".devcontainer/project-adhd/initialize.sh",
  ".devcontainer/project-adhd/lib/agent-tools.sh",
];

const FORBIDDEN: Array<[RegExp, string]> = [
  [/\b(local|declare|typeset)\s+-[a-zA-Z]*A/, "associative arrays need bash 4"],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*(,,?|\^\^?)\}/, "case modification needs bash 4"],
  [/\b(mapfile|readarray)\b/, "mapfile needs bash 4"],
  [/\|&/, "|& needs bash 4"],
  [/\bsed\s+(-[a-zA-Z]+\s+)*-i\b/, "sed -i differs between GNU and BSD"],
  [/\breadlink\s+-f\b/, "readlink -f is GNU-only"],
  [/\bstat\s+-c\b/, "stat -c is GNU-only"],
  [/\brealpath\b/, "realpath is missing on older macOS"],
];

test("host scripts avoid bash-4-only syntax and GNU-only tools", async () => {
  const violations: string[] = [];
  for (const script of HOST_SCRIPTS) {
    const path = join(repoRoot, script);
    if (!existsSync(path)) continue;
    const lines = (await readFile(path, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (/^\s*#/.test(line)) return;
      for (const [pattern, reason] of FORBIDDEN) {
        if (pattern.test(line)) violations.push(`${script}:${index + 1}: ${reason}: ${line.trim()}`);
      }
    });
  }
  expect(violations).toEqual([]);
});
```

In `test/agent-tools.test.ts`, import `hostBash` and replace both `"bash"` spawn arguments with `hostBash`.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/portability.test.ts`
Expected: FAIL listing `agent-tools.sh` lines for `local -A seen=()` and `${token,,}`.

- [ ] **Step 3: Rewrite `agent_tools_init`**

Replace the function in `.devcontainer/project-adhd/lib/agent-tools.sh` with:

```bash
agent_tools_init() {
  local raw="${AGENT_TOOLS-}"
  local token known valid seen=' '
  local -a tokens=() normalized=()

  raw=${raw//,/ }
  read -r -a tokens <<< "$raw"

  if (( ${#tokens[@]} == 0 )); then
    AGENT_TOOLS_SELECTED=("${AGENT_TOOLS_KNOWN[@]}")
    return 0
  fi

  for token in "${tokens[@]}"; do
    token=$(printf '%s' "$token" | tr '[:upper:]' '[:lower:]')
    valid=false
    for known in "${AGENT_TOOLS_KNOWN[@]}"; do
      if [[ "$token" == "$known" ]]; then
        valid=true
        break
      fi
    done
    if [[ "$valid" != true ]]; then
      agent_tools_die "unknown tool '$token' (valid: $(agent_tools_join "${AGENT_TOOLS_KNOWN[@]}"))"
    fi
    seen="$seen$token "
  done

  for known in "${AGENT_TOOLS_KNOWN[@]}"; do
    if [[ "$seen" == *" $known "* ]]; then
      normalized+=("$known")
    fi
  done
  AGENT_TOOLS_SELECTED=("${normalized[@]}")
}
```

Also add this line to the header comment: `# Sourced on the host by adhd as well, so it must stay bash 3.2-compatible.`

- [ ] **Step 4: Run the tests**

Run: `bun test test/portability.test.ts test/agent-tools.test.ts test/post-create.test.ts test/verify.test.ts`
Expected: all pass. The agent-tools messages and order are unchanged.

- [ ] **Step 5: Commit**

```bash
git add test/portability.test.ts test/agent-tools.test.ts .devcontainer/project-adhd/lib/agent-tools.sh
git commit -m "fix: make agent-tools.sh bash 3.2-safe and guard host scripts statically"
```

---

### Task 4: `initialize.sh` — self-locating, four state keys, state scope

**Files:**
- Modify: `.devcontainer/project-adhd/initialize.sh` (full replacement below)
- Modify: `.devcontainer/project-adhd/devcontainer.env.example`
- Modify: `test/initialize.test.ts`, `test/config.test.ts` (env-example test)

**Interfaces:**
- Consumes: `prepareRepository`, `hostBash`, `run`, `checked` from `./helpers`.
- Produces: `.devcontainer/project-adhd/.env` holding exactly
  `PROJECT_STATE_PREFIX=…\nCOMPOSE_INSTANCE=…\nAGENT_STATE_PREFIX=…\nWORKSPACE_NAME=…\n`. Task 5's Compose file reads these four names.

- [ ] **Step 1: Replace the state helpers in `test/initialize.test.ts` and add tests**

Replace `readStatePrefix` with:

```ts
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
```

Replace the body of "rejects a valid prefix followed by an unterminated extra state line" with:

```ts
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
```

Replace the body of "preserves a valid state prefix and an existing devcontainer secret on reruns" with:

```ts
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
```

Add these tests:

```ts
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
```

Add `rm` and `realpath` to the `node:fs/promises` import. `createHash` is already imported.

In `test/config.test.ts`, add to "documents AGENT_TOOLS in the tracked environment example": `expect(example).toContain("AGENT_STATE_SCOPE");`.

- [ ] **Step 2: Run to verify the failures**

Run: `bun test test/initialize.test.ts test/config.test.ts`
Expected: the new tests and the adapted ones FAIL (a single-line `.env`, and no `AGENT_STATE_SCOPE` in the example).

- [ ] **Step 3: Replace `.devcontainer/project-adhd/initialize.sh`**

```bash
#!/usr/bin/env bash
# Runs on the host before the Dev Container is built (initializeCommand).
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
set -euo pipefail

LC_ALL=C
export LC_ALL

die() {
  printf 'initialize.sh: %s\n' "$*" >&2
  exit 1
}

canonical_directory() {
  local directory=$1

  [[ -d "$directory" ]] || return 1
  (
    cd -P -- "$directory" 2>/dev/null || exit 1
    pwd -P
  )
}

short_hash() {
  local digest

  if command -v sha256sum >/dev/null 2>&1; then
    digest=$(printf '%s' "$1" | sha256sum 2>/dev/null) || return 1
  else
    digest=$(printf '%s' "$1" | shasum -a 256 2>/dev/null) || return 1
  fi
  digest=${digest%% *}
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s' "${digest:0:8}"
}

if (( $# > 1 )); then
  die 'expected at most one workspace root argument'
fi

if (( $# == 1 )); then
  workspace_root=$1
else
  if ! workspace_root=$(git rev-parse --show-toplevel 2>/dev/null); then
    die 'current directory is not a Git repository'
  fi
fi

if [[ -z "$workspace_root" || ! -d "$workspace_root" ]]; then
  die "workspace root is not a directory: $workspace_root"
fi

# Must equal the Dev Containers ${localWorkspaceFolderBasename}, so it is taken
# from the path as given, before symlinks are resolved.
workspace_name=${workspace_root%/}
workspace_name=${workspace_name##*/}
if [[ -z "$workspace_name" ]]; then
  die "unable to derive a workspace name from: $workspace_root"
fi

if ! workspace_root=$(canonical_directory "$workspace_root"); then
  die "unable to resolve workspace root: $workspace_root"
fi

if ! repo_root_reported=$(git -C "$workspace_root" rev-parse --show-toplevel 2>/dev/null); then
  die "workspace root is not a Git repository: $workspace_root"
fi
if ! repo_root=$(canonical_directory "$repo_root_reported"); then
  die "unable to resolve Git repository root: $repo_root_reported"
fi

if ! devcontainer_dir=$(canonical_directory "$(dirname "${BASH_SOURCE[0]}")"); then
  die 'unable to resolve the initializer directory'
fi
case "$devcontainer_dir/" in
  "$repo_root"/*) ;;
  *) die "initializer is not inside the repository $repo_root: $devcontainer_dir" ;;
esac

if ! git_common_dir_reported=$(git -C "$workspace_root" rev-parse --git-common-dir 2>/dev/null); then
  die "unable to resolve Git common directory: $workspace_root"
fi
if [[ "$git_common_dir_reported" == /* ]]; then
  git_common_dir_candidate=$git_common_dir_reported
else
  git_common_dir_candidate=$workspace_root/$git_common_dir_reported
fi
if ! git_common_dir=$(canonical_directory "$git_common_dir_candidate"); then
  die "unable to resolve Git common directory: $git_common_dir_candidate"
fi

if ! project_root_reported=$(git -C "$workspace_root" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p'); then
  die "unable to resolve Git repository root: $workspace_root"
fi
if [[ -z "$project_root_reported" ]]; then
  die "unable to resolve Git repository root: $workspace_root"
fi
if ! project_root=$(canonical_directory "$project_root_reported"); then
  die "unable to resolve Git repository root: $project_root_reported"
fi

repo_basename=${project_root##*/}
lowercase_basename=$(printf '%s' "$repo_basename" | tr '[:upper:]' '[:lower:]')
project_slug=$(printf '%s' "$lowercase_basename" | sed \
  -e 's/[^a-z0-9][^a-z0-9]*/-/g' \
  -e 's/^-*//' \
  -e 's/-*$//')
if [[ -z "$project_slug" ]]; then
  project_slug=project
fi
project_slug=${project_slug:0:40}

if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  die 'neither sha256sum nor shasum is available to derive the project identity'
fi
if ! project_id=$(short_hash "$git_common_dir"); then
  die 'unable to hash the canonical Git common directory'
fi
computed_prefix=$project_slug-$project_id

prefix_pattern='[a-z0-9][a-z0-9-]*-[0-9a-f]{8}'

# read_valid_prefix <path> [<key>...]
# Sets READ_PREFIX when <path> holds a valid PROJECT_STATE_PREFIX line followed
# by exactly one line per <key>, in that order, every line newline-terminated.
read_valid_prefix() {
  local path=$1
  shift
  local line= first_line= keys= expected_keys= line_count=0 newline_count key
  READ_PREFIX=

  if [[ ! -e "$path" && ! -L "$path" ]]; then
    return 0
  fi
  if [[ ! -f "$path" || ! -r "$path" ]]; then
    die "existing $path is not a readable regular file"
  fi

  for key in "$@"; do
    expected_keys="$expected_keys $key"
  done

  while IFS= read -r line || [[ -n "$line" ]]; do
    line_count=$((line_count + 1))
    if (( line_count == 1 )); then
      first_line=$line
    else
      keys="$keys ${line%%=*}"
    fi
  done < "$path"
  newline_count=$(wc -l < "$path")
  if (( line_count == $# + 1 && newline_count == $# + 1 )) &&
    [[ "$keys" == "$expected_keys" ]] &&
    [[ "$first_line" =~ ^PROJECT_STATE_PREFIX=$prefix_pattern$ ]]; then
    READ_PREFIX=${first_line#PROJECT_STATE_PREFIX=}
  fi
}

# read_agent_state_scope <devcontainer.env>: sets AGENT_STATE_SCOPE_VALUE.
read_agent_state_scope() {
  local path=$1 line value=

  if [[ -f "$path" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      case "$line" in
        AGENT_STATE_SCOPE=*) value=${line#AGENT_STATE_SCOPE=} ;;
      esac
    done < "$path"
  fi
  case "$value" in
    ''|shared) AGENT_STATE_SCOPE_VALUE=shared ;;
    project) AGENT_STATE_SCOPE_VALUE=project ;;
    *) die "invalid AGENT_STATE_SCOPE '$value' in $path (valid: shared, project)" ;;
  esac
}

write_file() {
  local destination=$1 contents=$2 temporary

  if ! temporary=$(mktemp "${destination}.tmp.XXXXXX"); then
    die "unable to create temporary state file for $destination"
  fi
  if ! printf '%s' "$contents" > "$temporary"; then
    rm -f -- "$temporary"
    die "unable to write state file $destination"
  fi
  if ! mv -f -- "$temporary" "$destination"; then
    rm -f -- "$temporary"
    die "unable to install state file $destination"
  fi
}

state_env=$devcontainer_dir/.env
canonical_state=$git_common_dir/.agentic-bun-devcontainer-prefix
read_valid_prefix "$canonical_state"
canonical_prefix=$READ_PREFIX
read_valid_prefix "$state_env" COMPOSE_INSTANCE AGENT_STATE_PREFIX WORKSPACE_NAME
worktree_prefix=$READ_PREFIX

if [[ -n "$canonical_prefix" && -n "$worktree_prefix" && "$canonical_prefix" != "$worktree_prefix" ]]; then
  die "conflicting PROJECT_STATE_PREFIX values in $canonical_state and $state_env"
fi

if [[ -n "$canonical_prefix" ]]; then
  SELECTED_PREFIX=$canonical_prefix
elif [[ -n "$worktree_prefix" ]]; then
  SELECTED_PREFIX=$worktree_prefix
else
  SELECTED_PREFIX=$computed_prefix
fi

if [[ "$canonical_prefix" != "$SELECTED_PREFIX" ]]; then
  write_file "$canonical_state" "PROJECT_STATE_PREFIX=$SELECTED_PREFIX"$'\n'
fi

devcontainer_env=$devcontainer_dir/devcontainer.env
if [[ ! -e "$devcontainer_env" && ! -L "$devcontainer_env" ]]; then
  if ! (umask 077; set -o noclobber; : > "$devcontainer_env") 2>/dev/null; then
    if [[ ! -e "$devcontainer_env" && ! -L "$devcontainer_env" ]]; then
      die "unable to create $devcontainer_env"
    fi
  fi
fi

read_agent_state_scope "$devcontainer_env"
if [[ "$AGENT_STATE_SCOPE_VALUE" == project ]]; then
  agent_state_prefix=$SELECTED_PREFIX
else
  agent_state_prefix=project-adhd-shared
fi

if ! worktree_id=$(short_hash "$workspace_root"); then
  die 'unable to hash the canonical worktree root'
fi

write_file "$state_env" "PROJECT_STATE_PREFIX=$SELECTED_PREFIX
COMPOSE_INSTANCE=$SELECTED_PREFIX-$worktree_id
AGENT_STATE_PREFIX=$agent_state_prefix
WORKSPACE_NAME=$workspace_name
"
```

- [ ] **Step 4: Document the scope in `devcontainer.env.example`**

Add after the `AGENT_TOOLS=` line:

```bash

# Where agent credentials, plugins, and settings live.
#   shared  (default) one set of volumes shared by every attached repository
#   project           volumes private to this repository; log in separately here
# Changing it requires Dev Containers: Rebuild Container.
AGENT_STATE_SCOPE=
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/initialize.test.ts test/config.test.ts test/portability.test.ts`
Expected: all pass. The Compose test still passes because it sets only `PROJECT_STATE_PREFIX`, and Task 5 changes that test.

- [ ] **Step 6: Commit**

```bash
git add .devcontainer/project-adhd/initialize.sh .devcontainer/project-adhd/devcontainer.env.example test/initialize.test.ts test/config.test.ts
git commit -m "feat: derive per-worktree Compose instances and shared agent state in initialize.sh"
```

---

### Task 5: Compose and `devcontainer.json` — shared volumes, per-worktree instance, `/workspaces/<name>`

**Files:**
- Modify: `.devcontainer/project-adhd/docker-compose.yml` (full replacement)
- Modify: `.devcontainer/project-adhd/devcontainer.json` (`workspaceFolder`)
- Modify: `test/config.test.ts`

**Interfaces:**
- Consumes: the four `.env` keys from Task 4.
- Produces: the volume `${AGENT_STATE_PREFIX}-lock` mounted at `/home/vscode/.local/state/project-adhd`, which Task 6 uses.

- [ ] **Step 1: Replace the Compose test and add a `devcontainer.json` test**

Replace "renders one Compose workspace with seven explicit state volumes and no published ports" with:

```ts
test("renders a per-worktree Compose project with shared agent volumes read from .env", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "My Project");
    const runtime = join(root, ".devcontainer", "project-adhd");
    await mkdir(runtime, { recursive: true });
    await copyFile(composePath, join(runtime, "docker-compose.yml"));
    await writeFile(join(runtime, "devcontainer.env"), "");
    await writeFile(
      join(runtime, ".env"),
      "PROJECT_STATE_PREFIX=my-project-1234abcd\n" +
        "COMPOSE_INSTANCE=my-project-1234abcd-9f9f9f9f\n" +
        "AGENT_STATE_PREFIX=project-adhd-shared\n" +
        "WORKSPACE_NAME=My Project\n",
    );
    const result = await run(
      ["docker", "compose", "-f", ".devcontainer/project-adhd/docker-compose.yml", "config", "--format", "json"],
      root,
    );
    if (result.exitCode !== 0) {
      throw new Error(`docker compose config failed:\n${result.stdout}${result.stderr}`);
    }

    type ComposeConfig = {
      name?: string;
      services?: Record<string, {
        ports?: unknown[];
        volumes?: Array<{ source?: string; target?: string; type?: string }>;
      }>;
      volumes?: Record<string, { name?: string }>;
    };
    const config = JSON.parse(result.stdout) as ComposeConfig;
    expect(config.name).toBe("my-project-1234abcd-9f9f9f9f");

    const expectedVolumes = {
      "claude-state": "project-adhd-shared-claude",
      "github-state": "project-adhd-shared-gh",
      "rtk-config-state": "project-adhd-shared-rtk-config",
      "rtk-data-state": "my-project-1234abcd-rtk-data",
      "codex-state": "project-adhd-shared-codex",
      "gemini-state": "project-adhd-shared-gemini",
      "omp-state": "project-adhd-shared-omp",
      "lock-state": "project-adhd-shared-lock",
    };
    expect(Object.keys(config.volumes ?? {}).sort()).toEqual(Object.keys(expectedVolumes).sort());
    for (const [logicalName, explicitName] of Object.entries(expectedVolumes)) {
      expect(config.volumes?.[logicalName]?.name).toBe(explicitName);
    }

    const workspace = config.services?.workspace;
    expect(workspace?.ports ?? []).toHaveLength(0);
    const mounts = new Map((workspace?.volumes ?? []).map((mount) => [mount.target, mount]));
    expect(mounts.get("/home/vscode/.local/state/project-adhd")?.source).toBe("lock-state");
    expect(mounts.get("/home/vscode/.local/share/rtk")?.source).toBe("rtk-data-state");
    const bind = mounts.get("/workspaces/My Project");
    expect(bind?.type).toBe("bind");
    expect(bind?.source).toBe(root);
  });
});

test("opens the workspace at /workspaces/<folder> with runtime-folder lifecycle commands", async () => {
  const config = JSON.parse(await readFile(devcontainerConfigPath, "utf8")) as Record<string, unknown>;
  expect(config.workspaceFolder).toBe("/workspaces/${localWorkspaceFolderBasename}");
  expect(config.initializeCommand).toBe(
    'bash "${localWorkspaceFolder}/.devcontainer/project-adhd/initialize.sh" "${localWorkspaceFolder}"',
  );
  expect(config.postCreateCommand).toBe("bash .devcontainer/project-adhd/post-create.sh");
  expect(config.updateContentCommand).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test test/config.test.ts`
Expected: FAIL (volume names, no `name`, workspaceFolder `/workspace`).

If `docker compose` does not read `.env` from beside the Compose file when `cwd` is the repository root, the failure shows empty or unset variables rather than the old values. Stop and report it: this is spec §12 item 3's sibling, and it changes where `initialize.sh` writes `.env`.

- [ ] **Step 3: Replace `.devcontainer/project-adhd/docker-compose.yml`**

```yaml
name: "${COMPOSE_INSTANCE}"

services:
  workspace:
    image: mcr.microsoft.com/devcontainers/base@sha256:d94c97dd9cacf183d0a6fd12a8e87b526e9e928307674ae9c94139139c0c6eae
    env_file: devcontainer.env
    command: sleep infinity
    volumes:
      - claude-state:/home/vscode/.claude
      - github-state:/home/vscode/.config/gh
      - rtk-config-state:/home/vscode/.config/rtk
      - rtk-data-state:/home/vscode/.local/share/rtk
      - codex-state:/home/vscode/.codex
      - gemini-state:/home/vscode/.gemini
      - omp-state:/home/vscode/.omp
      - lock-state:/home/vscode/.local/state/project-adhd
      - ../..:/workspaces/${WORKSPACE_NAME}:cached

volumes:
  claude-state:
    name: "${AGENT_STATE_PREFIX}-claude"
  github-state:
    name: "${AGENT_STATE_PREFIX}-gh"
  rtk-config-state:
    name: "${AGENT_STATE_PREFIX}-rtk-config"
  rtk-data-state:
    name: "${PROJECT_STATE_PREFIX}-rtk-data"
  codex-state:
    name: "${AGENT_STATE_PREFIX}-codex"
  gemini-state:
    name: "${AGENT_STATE_PREFIX}-gemini"
  omp-state:
    name: "${AGENT_STATE_PREFIX}-omp"
  lock-state:
    name: "${AGENT_STATE_PREFIX}-lock"
```

In `devcontainer.json`, set `"workspaceFolder": "/workspaces/${localWorkspaceFolderBasename}",`.

- [ ] **Step 4: Run the tests**

Run: `bun test test/config.test.ts`
Expected: PASS, including the space in `/workspaces/My Project`. That confirms spec §12 item 3.

- [ ] **Step 5: Commit**

```bash
git add .devcontainer/project-adhd/docker-compose.yml .devcontainer/project-adhd/devcontainer.json test/config.test.ts
git commit -m "feat: share agent volumes across repositories and mount at /workspaces/<name>"
```

---

### Task 6: post-create — serialize shared-state setup with `flock`

**Files:**
- Modify: `.devcontainer/project-adhd/post-create.sh` (`STATE_ROOTS`, new `with_shared_state_lock` + `configure_shared_state`, `main`)
- Modify: `test/helpers.ts` (`STATE_DIRECTORIES`), `test/post-create.test.ts`

**Interfaces:**
- Consumes: the lock volume path `~/.local/state/project-adhd` from Task 5.
- Produces: `with_shared_state_lock <command...>`, and `POST_CREATE_LOCK_TIMEOUT` (seconds, default 600; the override exists for tests).

- [ ] **Step 1: Write the failing tests**

In `test/helpers.ts`, append `".local/state/project-adhd"` to `STATE_DIRECTORIES`.

Add to `test/post-create.test.ts` (importing `makeHome`, `postCreatePath`, `run` and `withTemporaryParent` from `./helpers`, and `join` from `node:path`):

```ts
async function holdLock(lockFile: string, seconds: number): Promise<ReturnType<typeof Bun.spawn>> {
  const holder = Bun.spawn(["flock", lockFile, "sleep", String(seconds)]);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const probe = Bun.spawn(["flock", "-n", lockFile, "true"]);
    if ((await probe.exited) !== 0) return holder;
    await Bun.sleep(40);
  }
  holder.kill();
  throw new Error("lock holder never acquired the lock");
}

test("waits for another setup's shared-state lock, then runs the step", async () => {
  await withTemporaryParent(async (parent) => {
    const { home } = await makeHome(parent);
    const lockFile = join(home, ".local/state/project-adhd/post-create.lock");
    const holder = await holdLock(lockFile, 1);

    const result = await run(
      ["bash", "-c", 'source "$1"; with_shared_state_lock echo locked-step', "lock-test", postCreatePath],
      home,
      { HOME: home, POST_CREATE_LOCK_TIMEOUT: "20" },
    );
    await holder.exited;

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("==> Waiting for another project-adhd setup to finish");
    expect(result.stdout).toContain("locked-step");
  });
});

test("fails with the lock path when the shared-state lock is not released in time", async () => {
  await withTemporaryParent(async (parent) => {
    const { home } = await makeHome(parent);
    const lockFile = join(home, ".local/state/project-adhd/post-create.lock");
    const holder = await holdLock(lockFile, 10);
    try {
      const result = await run(
        ["bash", "-c", 'source "$1"; with_shared_state_lock echo never', "lock-test", postCreatePath],
        home,
        { HOME: home, POST_CREATE_LOCK_TIMEOUT: "1" },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("never");
      expect(result.stderr).toContain(`timed out after 1s waiting for ${lockFile}`);
    } finally {
      holder.kill();
    }
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/post-create.test.ts`
Expected: the two new tests FAIL with `with_shared_state_lock: command not found`.

- [ ] **Step 3: Implement the lock**

In `post-create.sh`, add `"$HOME/.local/state/project-adhd"` as the last entry of `STATE_ROOTS`. After the `INSTALLER_ROOTS` declaration add:

```bash
readonly POST_CREATE_LOCK_FILE="$HOME/.local/state/project-adhd/post-create.lock"
# Seconds to wait for another container's setup. Overridable for tests only.
POST_CREATE_LOCK_TIMEOUT="${POST_CREATE_LOCK_TIMEOUT:-600}"
```

Add before `main()`:

```bash
# Agent state volumes are shared by every attached repository, so two
# containers created at once must not install or enable plugins concurrently.
with_shared_state_lock() {
  exec 9>"$POST_CREATE_LOCK_FILE" || die "unable to open lock file: $POST_CREATE_LOCK_FILE"
  if ! flock -n 9; then
    echo '==> Waiting for another project-adhd setup to finish'
    flock -w "$POST_CREATE_LOCK_TIMEOUT" 9 ||
      die "timed out after ${POST_CREATE_LOCK_TIMEOUT}s waiting for $POST_CREATE_LOCK_FILE"
  fi
  "$@"
  flock -u 9
  exec 9>&-
}

configure_shared_state() {
  configure_rtk
  configure_superpowers
  install_archify
}
```

In `main`, replace the three lines `configure_rtk`, `configure_superpowers`, `install_archify` with `with_shared_state_lock configure_shared_state`.

- [ ] **Step 4: Run the tests**

Run: `bun test test/post-create.test.ts test/verify.test.ts`
Expected: all pass. The existing full-run tests pass because `makeHome` now creates the lock directory.

- [ ] **Step 5: Commit**

```bash
git add .devcontainer/project-adhd/post-create.sh test/helpers.ts test/post-create.test.ts
git commit -m "feat: serialize shared-state setup across containers with flock"
```

---

### Task 7: `adhd attach` into an existing directory (untracked mode)

**Files:**
- Create: `bin/adhd`, `libexec/adhd/common.sh`, `libexec/adhd/attach.sh`, `test/adhd.test.ts`
- Modify: `test/helpers.ts` (add `makeRepo`, `makeInstallation`)

**Interfaces:**
- Consumes: `agent_tools_init`, `AGENT_TOOLS_SELECTED` from `agent-tools.sh`.
- Produces (`common.sh`, for Tasks 8–10): `ADHD_RUNTIME_REL`, `ADHD_RUNTIME_SOURCE`, `ADHD_RUNTIME_FILES`, `ADHD_BLOCK_BEGIN`, `ADHD_BLOCK_END`, `ADHD_IGNORED_PATHS`, `die`, `note`, `warn`, `file_sha256 <file>`, `require_worktree_root <dir>` (prints the canonical root), `git_common_dir <root>`, `marker_get <file> <key>`, `remove_block <file>`, `write_block <file>`, `validate_agents <list>`, `selected_agents_csv`.
- Produces (`attach.sh`): `cmd_attach "$@"`, `resolve_attach_target`, `choose_agents`, `copy_runtime`, `write_marker`, `write_ignore_rules <root> <runtime> <mode>`, `write_devcontainer_env`, `print_next_steps`.
- Produces (`helpers.ts`): `makeRepo(root, files?)`, `makeInstallation(parent) → {checkout, origin}`.

- [ ] **Step 1: Add fixtures to `test/helpers.ts`**

Add `existsSync` from `node:fs` and `dirname` from `node:path` to the imports, then:

```ts
export async function makeRepo(
  root: string,
  files: Record<string, string> = { "seed.txt": "seed\n" },
): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  await checked(["git", "init", "-q", "--initial-branch=main"], root);
  await checked(["git", "config", "user.email", "project-adhd-tests@example.invalid"], root);
  await checked(["git", "config", "user.name", "project-adhd tests"], root);
  await checked(["git", "add", "-A"], root);
  await checked(["git", "commit", "-q", "--allow-empty", "--message=initial"], root);
}

// A throwaway copy of this checkout's host CLI and runtime folder, committed,
// pushed to a bare origin, and cloned, so tests can change it and pull.
export async function makeInstallation(parent: string): Promise<{ checkout: string; origin: string }> {
  const source = join(parent, "installation-source");
  const origin = join(parent, "installation-origin.git");
  const checkout = join(parent, "installation");
  const listed = await checked(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "--",
      "bin", "libexec", ".devcontainer/project-adhd", "install.sh"],
    repoRoot,
  );
  await mkdir(source, { recursive: true });
  for (const file of listed.split("\n").filter(Boolean)) {
    if (!existsSync(join(repoRoot, file))) continue;
    await mkdir(dirname(join(source, file)), { recursive: true });
    await copyFile(join(repoRoot, file), join(source, file));
  }
  for (const executable of ["bin/adhd", "install.sh"]) {
    if (existsSync(join(source, executable))) await chmod(join(source, executable), 0o755);
  }
  await makeRepo(source, {});
  await checked(["git", "clone", "-q", "--bare", source, origin], parent);
  await checked(["git", "clone", "-q", origin, checkout], parent);
  return { checkout, origin };
}
```

- [ ] **Step 2: Write the failing tests**

`test/adhd.test.ts`:

```ts
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
```

- [ ] **Step 3: Run to verify they fail**

Run: `bun test test/adhd.test.ts`
Expected: FAIL. `bin/adhd` doesn't exist, and `manifest` fails on the missing `common.sh`.

- [ ] **Step 4: Create `libexec/adhd/common.sh`**

```bash
# shellcheck shell=bash
# Shared helpers for the adhd host CLI. Sourced by bin/adhd, never executed.
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
# Callers set ADHD_HOME before sourcing.
# shellcheck disable=SC2034  # constants are used by the subcommand files

ADHD_RUNTIME_REL=.devcontainer/project-adhd
ADHD_RUNTIME_SOURCE="$ADHD_HOME/$ADHD_RUNTIME_REL"
ADHD_BLOCK_BEGIN='# >>> project-adhd'
ADHD_BLOCK_END='# <<< project-adhd'
ADHD_IGNORED_PATHS=(/.worktrees/ /.claude/worktrees/ /.superpowers/ /docs/superpowers/)

# Files attach copies into a target repository. Must match the tracked contents
# of .devcontainer/project-adhd/ other than .gitignore; a contract test checks.
ADHD_RUNTIME_FILES=(
  devcontainer.json
  devcontainer-lock.json
  docker-compose.yml
  initialize.sh
  post-create.sh
  verify.sh
  devcontainer.env.example
  lib/agent-tools.sh
  lib/claude-marketplaces.ts
  lib/claude-plugins.ts
  lib/codex-marketplaces.ts
  lib/codex-plugins.ts
  lib/collect.ts
  lib/omp-plugins.ts
)

die() {
  printf 'adhd: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '==> %s\n' "$*"
}

warn() {
  printf 'adhd: warning: %s\n' "$*" >&2
}

file_sha256() {
  local digest

  if command -v sha256sum >/dev/null 2>&1; then
    digest=$(sha256sum < "$1") || die "unable to hash $1"
  elif command -v shasum >/dev/null 2>&1; then
    digest=$(shasum -a 256 < "$1") || die "unable to hash $1"
  else
    die 'neither sha256sum nor shasum is available'
  fi
  printf '%s\n' "${digest%% *}"
}

# require_worktree_root <dir>: prints the canonical path of <dir>, which must
# be exactly the top level of a Git worktree.
require_worktree_root() {
  local dir=$1 canonical top

  [[ -d "$dir" ]] || die "not a directory: $dir"
  canonical=$(cd -P -- "$dir" && pwd -P) || die "unable to resolve: $dir"
  top=$(git -C "$canonical" rev-parse --show-toplevel 2>/dev/null) ||
    die "not a Git repository: $dir"
  top=$(cd -P -- "$top" && pwd -P) || die "unable to resolve: $top"
  [[ "$top" == "$canonical" ]] ||
    die "not the root of a Git worktree: $dir (its worktree root is $top)"
  printf '%s\n' "$canonical"
}

git_common_dir() {
  local root=$1 reported

  reported=$(git -C "$root" rev-parse --git-common-dir) ||
    die "unable to resolve the Git common directory of $root"
  case "$reported" in
    /*) ;;
    *) reported="$root/$reported" ;;
  esac
  (cd -P -- "$reported" && pwd -P) || die "unable to resolve: $reported"
}

# marker_get <file> <key>: prints the value of the first <key>=value line.
marker_get() {
  local file=$1 key=$2 line

  [[ -f "$file" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "$key="*)
        printf '%s\n' "${line#"$key="}"
        return 0
        ;;
    esac
  done < "$file"
  return 1
}

# remove_block <file>: drops the delimited project-adhd block, keeping the
# file's mode and every other line.
remove_block() {
  local file=$1 line inside=0 temporary

  [[ -f "$file" ]] || return 0
  temporary=$(mktemp "$file.adhd.XXXXXX") || die "unable to create a temporary file next to $file"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$ADHD_BLOCK_BEGIN" ]]; then
      inside=1
    elif [[ "$line" == "$ADHD_BLOCK_END" ]]; then
      inside=0
    elif (( inside == 0 )); then
      printf '%s\n' "$line"
    fi
  done < "$file" > "$temporary"
  cat "$temporary" > "$file"
  rm -f -- "$temporary"
}

# write_block <file>: replaces (or appends) the delimited project-adhd block.
write_block() {
  local file=$1 path

  remove_block "$file"
  if [[ -s "$file" && -n "$(tail -c 1 "$file")" ]]; then
    printf '\n' >> "$file"
  fi
  {
    printf '%s\n' "$ADHD_BLOCK_BEGIN"
    for path in "${ADHD_IGNORED_PATHS[@]}"; do
      printf '%s\n' "$path"
    done
    printf '%s\n' "$ADHD_BLOCK_END"
  } >> "$file"
}

# validate_agents <list>: dies on an unknown tool; sets AGENT_TOOLS_SELECTED.
validate_agents() {
  AGENT_TOOLS=$1 agent_tools_init
}

selected_agents_csv() {
  local IFS=,
  printf '%s' "${AGENT_TOOLS_SELECTED[*]}"
}
```

- [ ] **Step 5: Create `libexec/adhd/attach.sh`**

```bash
# shellcheck shell=bash
# adhd attach: copy the project-adhd runtime into a Git worktree.
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
# shellcheck disable=SC2154  # ADHD_* and AGENT_TOOLS_SELECTED come from common.sh and agent-tools.sh

attach_usage() {
  cat <<'EOF'
usage: adhd attach <dir> [--agents <list>]

Copies the project-adhd Dev Container into <dir>/.devcontainer/project-adhd/
and hides it from git. Rerun it to refresh an attached repository.
EOF
}

# resolve_attach_target <arg>: prints the directory to attach.
resolve_attach_target() {
  local arg=$1

  [[ -d "$arg" ]] || die "no such directory: $arg"
  printf '%s\n' "$arg"
}

# choose_agents <runtime> <agents> <agents_given>: sets ATTACH_AGENTS to the
# normalized tool list, or to empty when devcontainer.env already exists.
choose_agents() {
  local runtime=$1 agents=$2 agents_given=$3 answer

  ATTACH_AGENTS=
  if [[ -e "$runtime/devcontainer.env" ]]; then
    if (( agents_given )); then
      warn "kept the existing $ADHD_RUNTIME_REL/devcontainer.env; --agents was not applied"
    fi
    return 0
  fi
  if (( agents_given == 0 )) && [[ -t 0 ]]; then
    printf 'Agent tools to install, comma-separated from claude, codex, gemini, omp [all]: ' >&2
    IFS= read -r answer || answer=
    agents=$answer
  fi
  validate_agents "$agents"
  ATTACH_AGENTS=$(selected_agents_csv)
}

# copy_runtime <runtime>: copies every runtime file, printing one sha line each.
copy_runtime() {
  local runtime=$1 file source destination

  for file in "${ADHD_RUNTIME_FILES[@]}"; do
    source="$ADHD_RUNTIME_SOURCE/$file"
    destination="$runtime/$file"
    [[ -f "$source" ]] || die "the installation is incomplete (missing $source); run: adhd update"
    mkdir -p "$(dirname "$destination")"
    cp -p "$source" "$destination"
    printf 'sha:%s=%s\n' "$file" "$(file_sha256 "$destination")"
  done
}

# write_marker <runtime> <mode>: copies the runtime and records what was written.
write_marker() {
  local runtime=$1 mode=$2 body revision

  body=$(mktemp "$runtime/.adhd.XXXXXX") || die "unable to create a temporary file in $runtime"
  revision=$(git -C "$ADHD_HOME" rev-parse HEAD 2>/dev/null) || revision=unknown
  {
    printf 'mode=%s\n' "$mode"
    printf 'source=%s\n' "$revision"
    copy_runtime "$runtime"
  } > "$body"
  mv -f -- "$body" "$runtime/.adhd"
}

# write_ignore_rules <root> <runtime> <mode>
write_ignore_rules() {
  local root=$1 runtime=$2 mode=$3 common

  case "$mode" in
    untracked)
      printf '*\n' > "$runtime/.gitignore"
      common=$(git_common_dir "$root")
      mkdir -p "$common/info"
      write_block "$common/info/exclude"
      ;;
    *)
      die "unknown attach mode: $mode"
      ;;
  esac
}

# write_devcontainer_env <runtime> <agents>: creates devcontainer.env from the
# example; does nothing when <agents> is empty (the file already exists).
write_devcontainer_env() {
  local runtime=$1 agents=$2 line

  [[ -n "$agents" ]] || return 0
  (
    umask 077
    while IFS= read -r line || [[ -n "$line" ]]; do
      case "$line" in
        AGENT_TOOLS=*) printf 'AGENT_TOOLS=%s\n' "$agents" ;;
        *) printf '%s\n' "$line" ;;
      esac
    done < "$runtime/devcontainer.env.example" > "$runtime/devcontainer.env"
  )
}

print_next_steps() {
  local root=$1 mode=$2

  note "Attached project-adhd to $root ($mode)"
  printf 'Next: open %s in VS Code and run "Dev Containers: Reopen in Container".\n' "$root"
}

cmd_attach() {
  local target= agents= agents_given=0 mode=untracked root runtime marker recorded tracked_files

  while (( $# > 0 )); do
    case "$1" in
      --agents)
        (( $# >= 2 )) || die '--agents needs a value'
        agents=$2
        agents_given=1
        shift 2
        ;;
      --agents=*)
        agents=${1#--agents=}
        agents_given=1
        shift
        ;;
      -h|--help)
        attach_usage
        return 0
        ;;
      -*)
        die "unknown option: $1"
        ;;
      *)
        [[ -z "$target" ]] || die "unexpected argument: $1"
        target=$1
        shift
        ;;
    esac
  done
  if [[ -z "$target" ]]; then
    attach_usage >&2
    exit 1
  fi
  if (( agents_given )); then
    validate_agents "$agents"
  fi

  target=$(resolve_attach_target "$target")
  root=$(require_worktree_root "$target")
  runtime="$root/$ADHD_RUNTIME_REL"
  marker="$runtime/.adhd"

  if [[ -e "$runtime" ]]; then
    [[ -f "$marker" ]] ||
      die "$ADHD_RUNTIME_REL already exists in $root and was not created by adhd"
    recorded=$(marker_get "$marker" mode) || die "unreadable marker: $marker"
    [[ "$recorded" == "$mode" ]] ||
      die "$ADHD_RUNTIME_REL was attached $recorded; run adhd detach first to attach it $mode"
  fi
  if [[ "$mode" == untracked ]]; then
    tracked_files=$(git -C "$root" ls-files -- "$ADHD_RUNTIME_REL")
    [[ -z "$tracked_files" ]] ||
      die "git already tracks files in $ADHD_RUNTIME_REL; use --track"
  fi

  choose_agents "$runtime" "$agents" "$agents_given"
  mkdir -p "$runtime"
  write_marker "$runtime" "$mode"
  write_ignore_rules "$root" "$runtime" "$mode"
  write_devcontainer_env "$runtime" "$ATTACH_AGENTS"
  print_next_steps "$root" "$mode"
}
```

- [ ] **Step 6: Create `bin/adhd`**

```bash
#!/usr/bin/env bash
# adhd: attach the project-adhd Dev Container to a Git repository.
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
set -euo pipefail

# Prints the directory holding this script, following symlinks without readlink -f.
script_directory() {
  local path=$1 directory link

  while [[ -L "$path" ]]; do
    directory=$(cd -P -- "$(dirname "$path")" && pwd -P)
    link=$(readlink "$path")
    case "$link" in
      /*) path=$link ;;
      *) path="$directory/$link" ;;
    esac
  done
  cd -P -- "$(dirname "$path")" && pwd -P
}

ADHD_HOME=$(cd -P -- "$(script_directory "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck disable=SC1091
source "$ADHD_HOME/libexec/adhd/common.sh"
# shellcheck disable=SC1091
source "$ADHD_RUNTIME_SOURCE/lib/agent-tools.sh"

usage() {
  cat <<'EOF'
usage: adhd <command> [arguments]

commands:
  attach <dir | owner/repo | url> [--agents <list>] [--track]
  detach [dir]
  update
  new <name> [--public] [--agents <list>]
EOF
}

main() {
  local command=${1-}

  case "$command" in
    attach|detach|update|new)
      shift
      # shellcheck disable=SC1090
      source "$ADHD_HOME/libexec/adhd/$command.sh"
      "cmd_$command" "$@"
      ;;
    -h|--help|help)
      usage
      ;;
    '')
      usage >&2
      exit 1
      ;;
    *)
      printf 'adhd: unknown command: %s\n' "$command" >&2
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
```

Run: `chmod +x bin/adhd`

- [ ] **Step 7: Run the tests**

Run: `bun test test/adhd.test.ts test/portability.test.ts`
Expected: all pass. If the manifest test fails, the difference names the missing or extra runtime file; fix `ADHD_RUNTIME_FILES`.

- [ ] **Step 8: ShellCheck the new files**

Run: `shellcheck bin/adhd libexec/adhd/common.sh libexec/adhd/attach.sh` (install it first if needed: `sudo apt-get update && sudo apt-get install -y shellcheck`).
Expected: no findings.

- [ ] **Step 9: Commit**

```bash
git add bin libexec test/adhd.test.ts test/helpers.ts
git commit -m "feat: add adhd attach for existing worktrees in untracked mode"
```

---

### Task 8: `adhd attach` refresh — keep user edits, prune retired files

**Files:**
- Modify: `libexec/adhd/attach.sh` (replace `copy_runtime` and `write_marker`, add `in_manifest` and `prune_removed`)
- Modify: `test/adhd.test.ts`

**Interfaces:**
- Consumes: `marker_get`, `file_sha256`, `warn` from `common.sh`.
- Produces: `copy_runtime <runtime> <marker>`, `prune_removed <runtime> <marker>`, and `<file>.adhd-new` beside a user-edited file.

- [ ] **Step 1: Write the failing tests**

Append to `test/adhd.test.ts`:

```ts
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
    expect(second.stderr).toContain("kept your edited .devcontainer/project-adhd/devcontainer.json");
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
```

`shasum` exists on macOS and on Debian (via perl). If the dev container lacks it, use `sha256sum` in that one line. Both print `<hex>  <path>`.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/adhd.test.ts`
Expected: the refresh tests FAIL (the edited file is overwritten; retired files remain). The idempotence test may already pass.

- [ ] **Step 3: Replace `copy_runtime` and `write_marker` in `attach.sh`, and add the pruning helpers**

```bash
in_manifest() {
  local candidate=$1 file

  for file in "${ADHD_RUNTIME_FILES[@]}"; do
    [[ "$file" == "$candidate" ]] && return 0
  done
  return 1
}

# copy_runtime <runtime> <marker>: copies every runtime file, printing one sha
# line each. A file whose checksum differs from the marker's (the user edited
# it) is kept; the new version is written beside it as <file>.adhd-new.
copy_runtime() {
  local runtime=$1 marker=$2 file source destination recorded

  for file in "${ADHD_RUNTIME_FILES[@]}"; do
    source="$ADHD_RUNTIME_SOURCE/$file"
    destination="$runtime/$file"
    [[ -f "$source" ]] || die "the installation is incomplete (missing $source); run: adhd update"
    mkdir -p "$(dirname "$destination")"
    if [[ -f "$destination" ]] && recorded=$(marker_get "$marker" "sha:$file") &&
      [[ "$(file_sha256 "$destination")" != "$recorded" ]]; then
      cp -p "$source" "$destination.adhd-new"
      warn "kept your edited $ADHD_RUNTIME_REL/$file; the new version is $file.adhd-new"
      printf 'sha:%s=%s\n' "$file" "$recorded"
      continue
    fi
    cp -p "$source" "$destination"
    printf 'sha:%s=%s\n' "$file" "$(file_sha256 "$destination")"
  done
}

# prune_removed <runtime> <marker>: deletes files the marker lists that are no
# longer in the manifest, unless the user edited them.
prune_removed() {
  local runtime=$1 marker=$2 line file recorded

  [[ -f "$marker" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      sha:*) ;;
      *) continue ;;
    esac
    file=${line#sha:}
    file=${file%%=*}
    recorded=${line#*=}
    in_manifest "$file" && continue
    [[ -f "$runtime/$file" ]] || continue
    if [[ "$(file_sha256 "$runtime/$file")" == "$recorded" ]]; then
      rm -f -- "$runtime/$file"
    else
      warn "kept $ADHD_RUNTIME_REL/$file: project-adhd no longer ships it, but you edited it"
    fi
  done < "$marker"
}

# write_marker <runtime> <mode>: refreshes the runtime and records what was written.
write_marker() {
  local runtime=$1 mode=$2 marker="$1/.adhd" body revision

  body=$(mktemp "$runtime/.adhd.XXXXXX") || die "unable to create a temporary file in $runtime"
  revision=$(git -C "$ADHD_HOME" rev-parse HEAD 2>/dev/null) || revision=unknown
  {
    printf 'mode=%s\n' "$mode"
    printf 'source=%s\n' "$revision"
    copy_runtime "$runtime" "$marker"
  } > "$body"
  prune_removed "$runtime" "$marker"
  mv -f -- "$body" "$marker"
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/adhd.test.ts test/portability.test.ts && shellcheck libexec/adhd/attach.sh`
Expected: all pass; no ShellCheck findings.

- [ ] **Step 5: Commit**

```bash
git add libexec/adhd/attach.sh test/adhd.test.ts
git commit -m "feat: refresh attached repositories without clobbering edited runtime files"
```

---

### Task 9: `attach --track`, cloning targets, and `adhd new`

**Files:**
- Modify: `libexec/adhd/common.sh` (add `ADHD_TRACKED_GITIGNORE`, `require_gh`)
- Modify: `libexec/adhd/attach.sh` (replace `attach_usage`, `resolve_attach_target`, `write_ignore_rules`, and the option loop in `cmd_attach`)
- Create: `libexec/adhd/new.sh`
- Modify: `test/adhd.test.ts`

**Interfaces:**
- Consumes: `cmd_attach` (Task 7), `write_block` (Task 7).
- Produces: `cmd_new "$@"`, `require_gh`, `ADHD_TRACKED_GITIGNORE`.

- [ ] **Step 1: Write the failing tests**

Append to `test/adhd.test.ts` (add `writeStubs` to the helpers import):

```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/adhd.test.ts`
Expected: the new tests FAIL (`unknown option: --track`, `no such directory: acme/widget`, `unknown command: new` → the `new.sh` source fails).

- [ ] **Step 3: Extend `common.sh`**

Append:

```bash
# Ignore rules committed with a tracked attachment.
ADHD_TRACKED_GITIGNORE=$'/.env\n/devcontainer.env\n*.adhd-new\n'

require_gh() {
  command -v gh >/dev/null 2>&1 ||
    die 'gh is required for this command; install the GitHub CLI, then run: gh auth login'
  gh auth status >/dev/null 2>&1 ||
    die 'gh is not authenticated on this host; run: gh auth login'
}
```

- [ ] **Step 4: Update `attach.sh`**

Replace `attach_usage`:

```bash
attach_usage() {
  cat <<'EOF'
usage: adhd attach <dir | owner/repo | url> [--agents <list>] [--track]

Copies the project-adhd Dev Container into <dir>/.devcontainer/project-adhd/.
By default it is hidden from git; --track makes it part of the repository.
owner/repo and GitHub URLs are cloned with gh first. Rerun to refresh.
EOF
}
```

Replace `resolve_attach_target`:

```bash
# resolve_attach_target <arg>: prints the directory to attach, cloning
# owner/repo or a GitHub URL into the current directory first.
resolve_attach_target() {
  local arg=$1 name

  if [[ -d "$arg" ]]; then
    printf '%s\n' "$arg"
    return 0
  fi
  case "$arg" in
    https://github.com/*|git@github.com:*)
      name=${arg%/}
      name=${name%.git}
      name=${name##*/}
      ;;
    /*|./*|../*|'~'*)
      die "no such directory: $arg"
      ;;
    *)
      [[ "$arg" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
        die "not a directory, owner/repo, or GitHub URL: $arg"
      name=${arg##*/}
      ;;
  esac
  [[ -n "$name" && "$name" != . && "$name" != .. ]] || die "unable to derive a directory name from: $arg"
  [[ ! -e "$name" ]] || die "$name already exists; to attach it, run: adhd attach $name"
  require_gh
  note "Cloning $arg" >&2
  gh repo clone "$arg" "$name" >&2 || die "gh repo clone failed for $arg"
  printf '%s\n' "$name"
}
```

Replace `write_ignore_rules`:

```bash
# write_ignore_rules <root> <runtime> <mode>
write_ignore_rules() {
  local root=$1 runtime=$2 mode=$3 common

  case "$mode" in
    untracked)
      printf '*\n' > "$runtime/.gitignore"
      common=$(git_common_dir "$root")
      mkdir -p "$common/info"
      write_block "$common/info/exclude"
      ;;
    tracked)
      printf '%s' "$ADHD_TRACKED_GITIGNORE" > "$runtime/.gitignore"
      write_block "$root/.gitignore"
      ;;
    *)
      die "unknown attach mode: $mode"
      ;;
  esac
}
```

In `cmd_attach`'s option loop, add this case before `-h|--help)`:

```bash
      --track)
        mode=tracked
        shift
        ;;
```

- [ ] **Step 5: Create `libexec/adhd/new.sh`**

```bash
# shellcheck shell=bash
# adhd new: create a GitHub repository and attach project-adhd to it, tracked.
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
# shellcheck disable=SC2154  # ADHD_HOME comes from bin/adhd

# shellcheck disable=SC1091
source "$ADHD_HOME/libexec/adhd/attach.sh"

new_usage() {
  cat <<'EOF'
usage: adhd new <name> [--public] [--agents <list>]

Creates a private (or --public) GitHub repository with gh, clones it into
./<name>, and attaches project-adhd in tracked mode. Nothing is committed.
EOF
}

cmd_new() {
  local name= visibility=--private agents= agents_given=0 directory
  local -a attach_args=(--track)

  while (( $# > 0 )); do
    case "$1" in
      --public)
        visibility=--public
        shift
        ;;
      --agents)
        (( $# >= 2 )) || die '--agents needs a value'
        agents=$2
        agents_given=1
        shift 2
        ;;
      --agents=*)
        agents=${1#--agents=}
        agents_given=1
        shift
        ;;
      -h|--help)
        new_usage
        return 0
        ;;
      -*)
        die "unknown option: $1"
        ;;
      *)
        [[ -z "$name" ]] || die "unexpected argument: $1"
        name=$1
        shift
        ;;
    esac
  done
  if [[ -z "$name" ]]; then
    new_usage >&2
    exit 1
  fi
  [[ "$name" =~ ^([A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+$ ]] || die "invalid repository name: $name"
  if (( agents_given )); then
    validate_agents "$agents"
    attach_args+=(--agents "$agents")
  fi

  directory=${name##*/}
  [[ ! -e "$directory" ]] || die "$directory already exists"
  require_gh
  note "Creating $name ($visibility)"
  gh repo create "$name" "$visibility" --clone || die "gh repo create failed for $name"

  cmd_attach "$directory" "${attach_args[@]}"
  cat <<EOF
Suggested first commit:
  cd "$directory" && git add -A && git commit -m "chore: add project-adhd dev container"
EOF
}
```

- [ ] **Step 6: Run the tests**

Run: `bun test test/adhd.test.ts test/portability.test.ts && shellcheck bin/adhd libexec/adhd/*.sh`
Expected: all pass; no ShellCheck findings.

- [ ] **Step 7: Commit**

```bash
git add libexec test/adhd.test.ts
git commit -m "feat: add attach --track, clone targets, and adhd new"
```

---

### Task 10: `adhd detach` and `adhd update`

**Files:**
- Create: `libexec/adhd/detach.sh`, `libexec/adhd/update.sh`
- Modify: `test/adhd.test.ts`

**Interfaces:**
- Consumes: `require_worktree_root`, `git_common_dir`, `marker_get`, `remove_block` from `common.sh`.
- Produces: `cmd_detach "$@"`, `cmd_update "$@"`, `other_worktree_attached <root>`.

- [ ] **Step 1: Write the failing tests**

Append to `test/adhd.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test test/adhd.test.ts`
Expected: the new tests FAIL (`detach.sh`/`update.sh` missing).

- [ ] **Step 3: Create `libexec/adhd/detach.sh`**

```bash
# shellcheck shell=bash
# adhd detach: remove an attached project-adhd runtime from a Git worktree.
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
# shellcheck disable=SC2154  # ADHD_* come from common.sh

detach_usage() {
  cat <<'EOF'
usage: adhd detach [dir]

Removes .devcontainer/project-adhd/ and its ignore rules from <dir> (default:
the current directory). Docker volumes are kept.
EOF
}

# other_worktree_attached <root>: succeeds when another worktree of the same
# repository still holds an untracked attachment, which needs the shared
# exclude block.
other_worktree_attached() {
  local root=$1 line path

  while IFS= read -r line; do
    case "$line" in
      "worktree "*) path=${line#worktree } ;;
      *) continue ;;
    esac
    path=$(cd -P -- "$path" 2>/dev/null && pwd -P) || continue
    [[ "$path" == "$root" ]] && continue
    if [[ "$(marker_get "$path/$ADHD_RUNTIME_REL/.adhd" mode 2>/dev/null)" == untracked ]]; then
      return 0
    fi
  done < <(git -C "$root" worktree list --porcelain)
  return 1
}

cmd_detach() {
  local target=. root runtime marker mode prefix

  while (( $# > 0 )); do
    case "$1" in
      -h|--help)
        detach_usage
        return 0
        ;;
      -*)
        die "unknown option: $1"
        ;;
      *)
        [[ "$target" == . ]] || die "unexpected argument: $1"
        target=$1
        shift
        ;;
    esac
  done

  root=$(require_worktree_root "$target")
  runtime="$root/$ADHD_RUNTIME_REL"
  marker="$runtime/.adhd"
  [[ -d "$runtime" ]] || die "nothing to detach: $ADHD_RUNTIME_REL does not exist in $root"
  [[ -f "$marker" ]] || die "$ADHD_RUNTIME_REL in $root was not created by adhd; refusing to remove it"
  mode=$(marker_get "$marker" mode) || die "unreadable marker: $marker"
  prefix=$(marker_get "$runtime/.env" PROJECT_STATE_PREFIX 2>/dev/null) || prefix=

  rm -rf -- "$runtime"
  rmdir "$root/.devcontainer" 2>/dev/null || true
  case "$mode" in
    untracked)
      if ! other_worktree_attached "$root"; then
        remove_block "$(git_common_dir "$root")/info/exclude"
      fi
      ;;
    tracked)
      remove_block "$root/.gitignore"
      ;;
    *)
      die "unknown attach mode in marker: $mode"
      ;;
  esac

  note "Detached project-adhd from $root (its devcontainer.env was removed)"
  if [[ -n "$prefix" ]]; then
    printf "Docker volumes were kept. List this repository's with: docker volume ls --filter name=%s\n" "$prefix"
  else
    printf 'Docker volumes were kept. List them with: docker volume ls --filter name=project-adhd\n'
  fi
}
```

- [ ] **Step 4: Create `libexec/adhd/update.sh`**

```bash
# shellcheck shell=bash
# adhd update: fast-forward the project-adhd installation.
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
# shellcheck disable=SC2154  # ADHD_HOME comes from bin/adhd

cmd_update() {
  (( $# == 0 )) || die 'usage: adhd update'
  git -C "$ADHD_HOME" pull --ff-only || die "unable to fast-forward $ADHD_HOME"
  note "Updated project-adhd in $ADHD_HOME"
  printf 'Rerun "adhd attach <dir>" in each attached repository to refresh it.\n'
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/adhd.test.ts test/portability.test.ts && shellcheck bin/adhd libexec/adhd/*.sh`
Expected: all pass; no ShellCheck findings.

- [ ] **Step 6: Commit**

```bash
git add libexec test/adhd.test.ts
git commit -m "feat: add adhd detach and adhd update"
```

---

### Task 11: `install.sh`

**Files:**
- Create: `install.sh`, `test/install.test.ts`
- Modify: `test/helpers.ts` (`run` accepts `stdin`)

**Interfaces:**
- Consumes: `makeInstallation` → `{checkout, origin}`.
- Produces: `~/.local/bin/adhd` → `$ADHD_HOME/bin/adhd`; `ADHD_HOME`, `ADHD_REPO`, and `ADHD_REF` environment overrides.

- [ ] **Step 1: Let `run` feed stdin**

In `test/helpers.ts`, change `run`'s signature and spawn options:

```ts
export async function run(
  command: string[],
  cwd: string,
  env?: Record<string, string>,
  stdin?: string,
): Promise<CommandResult> {
```

```ts
  const childProcess = Bun.spawn(command, {
    cwd,
    env: mergedEnv,
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
```

- [ ] **Step 2: Write the failing tests**

`test/install.test.ts`:

```ts
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostBash, makeInstallation, repoRoot, run, withTemporaryParent } from "./helpers";

async function pipedInstall(home: string, origin: string, path = process.env.PATH ?? "") {
  const script = await readFile(join(repoRoot, "install.sh"), "utf8");
  return run([hostBash], home, { HOME: home, ADHD_REPO: origin, PATH: path }, script);
}

test("a piped install clones into ~/.local/share and links adhd", async () => {
  await withTemporaryParent(async (parent) => {
    const { origin } = await makeInstallation(parent);
    const home = join(parent, "home");
    await mkdir(home);

    const result = await pipedInstall(home, origin);

    expect(result.exitCode).toBe(0);
    const installed = join(home, ".local/share/project-adhd");
    expect(existsSync(join(installed, "bin/adhd"))).toBe(true);
    expect(await readlink(join(home, ".local/bin/adhd"))).toBe(join(installed, "bin/adhd"));
    expect(result.stderr).toContain(".local/bin is not on PATH");
  });
});

test("a second install updates in place and keeps the link", async () => {
  await withTemporaryParent(async (parent) => {
    const { origin } = await makeInstallation(parent);
    const home = join(parent, "home");
    await mkdir(home);
    const onPath = `${join(home, ".local/bin")}:${process.env.PATH ?? ""}`;
    expect((await pipedInstall(home, origin, onPath)).exitCode).toBe(0);

    const second = await pipedInstall(home, origin, onPath);

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("Updating");
    expect(second.stderr).not.toContain("not on PATH");
  });
});

test("install refuses to replace an adhd it did not create", async () => {
  await withTemporaryParent(async (parent) => {
    const { origin } = await makeInstallation(parent);
    const home = join(parent, "home");
    await mkdir(join(home, ".local/bin"), { recursive: true });
    await writeFile(join(home, ".local/bin/adhd"), "#!/bin/sh\n");

    const result = await pipedInstall(home, origin);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("already exists and is not a symlink");
    expect(await readFile(join(home, ".local/bin/adhd"), "utf8")).toBe("#!/bin/sh\n");
  });
});

test("running install.sh from a checkout links that checkout without cloning", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const home = join(parent, "home");
    await mkdir(home);

    const result = await run([hostBash, join(checkout, "install.sh")], home, { HOME: home });

    expect(result.exitCode).toBe(0);
    expect(await readlink(join(home, ".local/bin/adhd"))).toBe(join(checkout, "bin/adhd"));
    expect(existsSync(join(home, ".local/share/project-adhd"))).toBe(false);
  });
});
```

On macOS, `tmpdir()` is under a `/var` → `/private/var` symlink. If `readlink` comparisons fail there, compare against `await realpath(...)` of the expected path. `install.sh` stores canonical `pwd -P` paths for the checkout case.

- [ ] **Step 3: Run to verify they fail**

Run: `bun test test/install.test.ts`
Expected: FAIL (`install.sh` doesn't exist). `makeInstallation` skips the missing file.

- [ ] **Step 4: Create `install.sh`**

```bash
#!/usr/bin/env bash
# Install or update the adhd host CLI.
#
#   curl -fsSL https://raw.githubusercontent.com/DragosMocrii/project-adhd/main/install.sh | bash
#
# Run from a project-adhd checkout, it links that checkout instead of cloning.
# Host code: must stay bash 3.2-compatible with BSD or GNU userland.
set -euo pipefail

die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'install.sh: warning: %s\n' "$*" >&2
}

ADHD_REPO=${ADHD_REPO:-https://github.com/DragosMocrii/project-adhd.git}
ADHD_REF=${ADHD_REF:-main}
BIN_DIR="$HOME/.local/bin"

command -v git >/dev/null 2>&1 || die 'git is required'

self_dir=
if [[ -n "${BASH_SOURCE[0]-}" && -f "${BASH_SOURCE[0]}" ]]; then
  self_dir=$(cd -P -- "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
fi

if [[ -n "$self_dir" && -f "$self_dir/bin/adhd" && -e "$self_dir/.git" ]]; then
  ADHD_HOME=$self_dir
  echo "==> Using the checkout at $ADHD_HOME"
else
  ADHD_HOME=${ADHD_HOME:-$HOME/.local/share/project-adhd}
  if [[ -e "$ADHD_HOME/.git" ]]; then
    echo "==> Updating $ADHD_HOME"
    git -C "$ADHD_HOME" pull --ff-only || die "unable to fast-forward $ADHD_HOME"
  elif [[ -e "$ADHD_HOME" ]]; then
    die "$ADHD_HOME exists but is not a project-adhd checkout"
  else
    echo "==> Cloning project-adhd into $ADHD_HOME"
    mkdir -p "$(dirname "$ADHD_HOME")"
    git clone --quiet --branch "$ADHD_REF" "$ADHD_REPO" "$ADHD_HOME" ||
      die "unable to clone $ADHD_REPO"
  fi
fi

target="$ADHD_HOME/bin/adhd"
link="$BIN_DIR/adhd"
[[ -f "$target" ]] || die "$target is missing; the checkout is incomplete"
chmod +x "$target"
mkdir -p "$BIN_DIR"
if [[ -L "$link" ]]; then
  [[ "$(readlink "$link")" == "$target" ]] ||
    die "$link already points to $(readlink "$link"); remove it and rerun"
elif [[ -e "$link" ]]; then
  die "$link already exists and is not a symlink; remove it and rerun"
else
  ln -s "$target" "$link"
fi
echo "==> adhd is installed at $link"

case ":${PATH-}:" in
  *":$BIN_DIR:"*) ;;
  *)
    warn "$BIN_DIR is not on PATH. Add this line to ~/.zprofile (zsh) or ~/.bashrc (bash):"
    # shellcheck disable=SC2016  # the line is printed for the user, unexpanded
    printf '  export PATH="$HOME/.local/bin:$PATH"\n' >&2
    ;;
esac
command -v docker >/dev/null 2>&1 || warn 'docker is not installed; Dev Containers need it'
command -v gh >/dev/null 2>&1 || warn 'gh is not installed; adhd attach owner/repo and adhd new need it'
```

Run: `chmod +x install.sh`

- [ ] **Step 5: Run the tests**

Run: `bun test test/install.test.ts test/portability.test.ts && shellcheck install.sh`
Expected: all pass; no ShellCheck findings.

- [ ] **Step 6: Commit**

```bash
git add install.sh test/install.test.ts test/helpers.ts
git commit -m "feat: add install.sh for the adhd host CLI"
```

---

### Task 12: CI — macOS bash 3.2 host job and full ShellCheck coverage

**Files:**
- Modify: `.github/workflows/ci.yml` (full replacement)
- Modify: `AGENTS.md` (the "Verifying a change" ShellCheck line)

- [ ] **Step 1: Replace `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  test:
    name: Contract suite
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0
      - name: Install dependencies
        run: bun install --frozen-lockfile
      - name: Run contract suite
        run: bun test
      - name: Typecheck
        run: bun run typecheck

  host-macos:
    name: Host scripts (macOS, bash 3.2)
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0
      - name: Install dependencies
        run: bun install --frozen-lockfile
      - name: Confirm the system bash is 3.2
        run: /bin/bash -c 'echo "$BASH_VERSION"; [[ "$BASH_VERSION" == 3.2.* ]]'
      - name: Run host tests under /bin/bash
        env:
          ADHD_TEST_BASH: /bin/bash
        run: >-
          bun test
          test/initialize.test.ts
          test/adhd.test.ts
          test/install.test.ts
          test/agent-tools.test.ts
          test/portability.test.ts

  shellcheck:
    name: ShellCheck
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Lint shell scripts
        run: |
          shellcheck \
            install.sh \
            bin/adhd \
            libexec/adhd/*.sh \
            .devcontainer/project-adhd/*.sh \
            .devcontainer/project-adhd/lib/agent-tools.sh
```

- [ ] **Step 2: Update the ShellCheck line in `AGENTS.md`**

```bash
shellcheck install.sh bin/adhd libexec/adhd/*.sh .devcontainer/project-adhd/*.sh .devcontainer/project-adhd/lib/agent-tools.sh
```

- [ ] **Step 3: Run the same commands locally**

Run: `bun test 2>&1 | tail -3 && bun run typecheck && shellcheck install.sh bin/adhd libexec/adhd/*.sh .devcontainer/project-adhd/*.sh .devcontainer/project-adhd/lib/agent-tools.sh`
Expected: all tests pass, typecheck exits 0, and ShellCheck reports nothing.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml AGENTS.md
git commit -m "ci: run host tests under macOS bash 3.2 and lint every shell script"
```

After pushing, confirm the `host-macos` job passes. A failure there is a portability bug in a host script: fix the script, not the test.

---

### Task 13: Documentation — README, AGENTS.md, SECURITY.md

**Files:**
- Modify: `README.md` (full replacement), `AGENTS.md` (full replacement), `SECURITY.md` (sections listed)
- Modify: `test/config.test.ts` (README and AGENTS tests)

- [ ] **Step 1: Update the doc tests first**

Replace "documents a create command that works for someone who is not the repository owner" in `test/config.test.ts` with:

```ts
test("documents installing adhd and attaching it, not the retired template flow", async () => {
  const readme = await readFile(join(repoRoot, "README.md"), "utf8");

  expect(readme).toContain("install.sh | bash");
  expect(readme).toContain("adhd attach");
  expect(readme).toContain("adhd new");
  expect(readme).toContain("adhd detach");
  expect(readme).toContain("AGENT_TOOLS");
  expect(readme).toContain("AGENT_STATE_SCOPE");
  expect(readme).toContain("SECURITY.md");
  expect(readme).not.toContain("--template");
});
```

In "ships agent guidance that Claude and Codex both resolve", change `expect(agents).toContain(".devcontainer/");` to `expect(agents).toContain(".devcontainer/project-adhd/");`, and add `expect(agents).toContain("bash 3.2");`.

Run: `bun test test/config.test.ts`
Expected: both FAIL.

- [ ] **Step 2: Replace `README.md`**

````markdown
# project-adhd

An agentic Dev Container you attach to any Git repository. It installs your
choice of agent CLIs, wires them to the RTK token-optimizing proxy and the
Superpowers plugin, and keeps logins and plugins in Docker volumes shared by
every repository you attach it to — so you authenticate once, not once per
project.

**What you get**

- `adhd`, a small host CLI: `attach`, `detach`, `update`, `new`.
- A digest-pinned Dev Container with Bun, Node, `python3`, and the GitHub CLI.
- Your choice of Claude Code, Codex, Gemini CLI, and OMP — see `AGENT_TOOLS`.
- RTK configured as a hook for each selected agent.
- The Superpowers plugin and the Archify skill installed per agent.
- One container per repository (and per worktree); several can run at once.
- Nothing committed to the repository you attach to.

## Install

Your host needs Docker, VS Code with the Dev Containers extension, `git`,
`bash`, and the GitHub CLI (`gh auth login`) for cloning and creating
repositories. Linux and macOS are supported.

```bash
curl -fsSL https://raw.githubusercontent.com/DragosMocrii/project-adhd/main/install.sh | bash
```

This clones project-adhd into `~/.local/share/project-adhd` and links
`~/.local/bin/adhd`. If `~/.local/bin` is not on your `PATH`, the installer
prints the line to add. Running it again updates the installation. From a
checkout of this repository, `./install.sh` links that checkout instead.

## Attach to a repository

```bash
adhd attach facebook/react --agents claude,codex   # clones with gh, then attaches
adhd attach ~/src/existing-clone                   # or attach a clone you already have
```

Then open the repository in VS Code and run **Dev Containers: Reopen in
Container**. If the repository ships its own `.devcontainer/`, VS Code asks
which configuration to open; pick `project-adhd`.

The first time on a host, authenticate inside the container, then finish
setup:

```bash
gh auth login        # always
claude auth login    # if claude is in AGENT_TOOLS
codex login          # if codex is in AGENT_TOOLS
gemini               # start once and sign in, if gemini is in AGENT_TOOLS
bash .devcontainer/project-adhd/post-create.sh
.devcontainer/project-adhd/verify.sh
```

Every repository you attach afterwards finds those logins already in place.
`verify.sh` reports `SKIP` for unselected tools and a failure for a selected
tool that is not configured yet.

**What `attach` writes.** Everything lives in
`.devcontainer/project-adhd/`, which contains a `.gitignore` of `*` so git
never sees it. It also adds a marked block to `.git/info/exclude` covering the
directories agents create at the repository root (`.worktrees/`,
`.claude/worktrees/`, `.superpowers/`, `docs/superpowers/`). `git status`
stays clean.

**Worktrees.** `git worktree add` does not copy untracked files, so run
`adhd attach .` inside each new worktree. Each worktree gets its own
container.

## Start a new project

```bash
adhd new my-project --agents claude    # private; add --public for a public repository
```

This creates the repository with `gh`, clones it, and attaches project-adhd
in tracked mode (`--track`): `.devcontainer/project-adhd/` becomes part of the
repository, with only its local files (`.env`, `devcontainer.env`) ignored.
Nothing is committed for you.

## Choosing your agent tools

`AGENT_TOOLS` in `.devcontainer/project-adhd/devcontainer.env` controls which
agent CLIs are installed and verified. `adhd attach --agents` sets it; without
the flag, `attach` asks, or selects all four when it cannot ask.

```bash
AGENT_TOOLS=claude          # Claude Code only
AGENT_TOOLS=claude,codex    # Claude Code and Codex
```

Empty selects all four; an unrecognized value fails the run. `rtk` and the
GitHub CLI are always installed. Changing it later requires **Dev Containers:
Rebuild Container**, then `bash .devcontainer/project-adhd/post-create.sh`.

- **OMP Superpowers requires Claude.** OMP sources the Superpowers package from
  Claude's installed plugin, so `omp` needs `claude` selected and
  authenticated; otherwise its Superpowers step is skipped with a message.
- **Gemini CLI has no RTK integration** and no Archify destination today.

## State and isolation

| Volume | Scope |
|---|---|
| `project-adhd-shared-claude`, `-gh`, `-codex`, `-gemini`, `-omp`, `-rtk-config` | shared by every attached repository |
| `project-adhd-shared-lock` | shared; serializes concurrent first-time setup |
| `<project-prefix>-rtk-data` | this repository only |

Agent histories stay separate because each repository is mounted at its own
path, `/workspaces/<folder-name>`. Two clones with the same folder name open
at the same time share a history namespace; their histories merge, and
nothing is lost.

To keep a repository's agent state private — separate logins included — set
`AGENT_STATE_SCOPE=project` in its `devcontainer.env` and rebuild.

Tool binaries are reinstalled on rebuild; logins, plugins, and histories stay
in the volumes. Deleting `.devcontainer/project-adhd/.env` or
`devcontainer.env` does not remove any volume.

## Updating and customizing

```bash
adhd update              # pull the latest project-adhd
adhd attach <dir>        # refresh an attached repository
```

You can edit an attached repository's runtime files — for example add a Dev
Container Feature for a toolchain to `devcontainer.json`:

```json
"ghcr.io/devcontainers/features/go:1": {}
```

`attach` never overwrites a file you edited. It writes the new version beside
it as `<file>.adhd-new` and warns, so you can merge by hand.

## Detaching

```bash
adhd detach [dir]
```

Removes `.devcontainer/project-adhd/` (including its `devcontainer.env`) and
the ignore block. Docker volumes are kept; the command prints how to list
them.

## Compose projects launched from the Dev Container

The Docker daemon used from inside the container runs on the host, so any
bind source in a Compose project you start from inside must be a host path.
Do not use a container path such as `/workspaces/<name>` as a bind source.

`LOCAL_WORKSPACE_FOLDER` is the host path of the folder VS Code opened. For a
linked worktree, that is the worktree's own host path.

## Migrating from the template layout

Projects generated from the old GitHub template keep working as they are.
To move a project's existing logins into the shared volumes, copy each one
(`<old-prefix>` is the `PROJECT_STATE_PREFIX` from its old
`.devcontainer/.env`):

```bash
old=<old-prefix>
for v in claude gh rtk-config codex gemini omp; do
  docker volume create "project-adhd-shared-$v" >/dev/null
  docker run --rm -v "$old-$v:/from:ro" -v "project-adhd-shared-$v:/to" \
    mcr.microsoft.com/devcontainers/base@sha256:d94c97dd9cacf183d0a6fd12a8e87b526e9e928307674ae9c94139139c0c6eae \
    sh -c 'cp -a /from/. /to/'
done
```

`<old-prefix>-rtk-data` keeps its name and needs no copy.

## Security

`post-create.sh` fetches and executes vendor installers, the installer is
meant to be piped to `bash`, attached repositories share agent credentials,
and the container can reach the host Docker daemon. See
[SECURITY.md](SECURITY.md) before using this with code you do not trust.

## Contributing to project-adhd

```bash
bun install
bun test
bun run typecheck
shellcheck install.sh bin/adhd libexec/adhd/*.sh .devcontainer/project-adhd/*.sh .devcontainer/project-adhd/lib/agent-tools.sh
```
````

- [ ] **Step 3: Replace `AGENTS.md`**

````markdown
# Agent guidance

This repository is project-adhd: a host CLI (`adhd`) and the Dev Container
runtime it attaches to other Git repositories.

## Layout

- `bin/adhd` — host CLI dispatcher. `libexec/adhd/` — one file per
  subcommand plus `common.sh` (shared helpers and the runtime manifest).
- `install.sh` — host installer.
- `.devcontainer/project-adhd/` — **the runtime**: everything `adhd attach`
  copies. This repository dogfoods it in tracked mode.
- `.devcontainer/project-adhd/lib/` — shared units. `agent-tools.sh` parses
  `AGENT_TOOLS` and is sourced by `post-create.sh`, `verify.sh`, and `adhd`;
  the `*.ts` modules parse agent-CLI plugin JSON.
- `test/` — the contract suite, split by where code runs: host
  (`initialize`, `adhd`, `install`, `agent-tools`, `portability`) and
  container (`post-create`, `verify`), plus static `config` checks.
- `package.json`, `bun.lock`, `tsconfig.json` — the suite's own tooling.

## Conventions

- Shell scripts use `set -euo pipefail` and a local `die()` or `fail()` helper.
- **Host scripts must run under bash 3.2** with BSD or GNU tools: no
  associative arrays, `${var,,}`, `mapfile`, `sed -i`, `stat -c`,
  `readlink -f`, or `realpath`. `test/portability.test.ts` guards this and
  CI runs the host tests under macOS `/bin/bash`. Container scripts
  (`post-create.sh`, `verify.sh`) may use bash 4+.
- A new runtime file must be added to `ADHD_RUNTIME_FILES` in
  `libexec/adhd/common.sh`; a contract test fails otherwise.
- No `jq`. JSON is parsed by the Bun modules under
  `.devcontainer/project-adhd/lib/`.
- Plugin-detection logic lives only in those modules. Do not reintroduce
  inline `bun -e` parsers in the shell scripts. The one deliberate exception
  is `check_claude_settings` in `verify.sh`, which inspects a Claude settings
  file rather than CLI plugin output.
- Agent CLI installers are intentionally unpinned. Do not add version pins
  without changing `SECURITY.md` to match.
- `NO_BROWSER=true` is container-wide on purpose; a contract test asserts it.

## AGENT_TOOLS

`AGENT_TOOLS` selects which agent CLIs are installed and verified —
comma-separated from `claude`, `codex`, `gemini`, `omp`; unset means all four.
`rtk` and `gh` are always installed. OMP Superpowers requires `claude`
selected and authenticated.

## Verifying a change

```bash
bun test
bun run typecheck
shellcheck install.sh bin/adhd libexec/adhd/*.sh .devcontainer/project-adhd/*.sh .devcontainer/project-adhd/lib/agent-tools.sh
```

`shellcheck` is not preinstalled in the container image; CI runs it. To run
it locally: `sudo apt-get update && sudo apt-get install -y shellcheck`.

`.devcontainer/project-adhd/verify.sh` checks the live environment and needs
authenticated CLIs. The contract suite does not — it stubs `PATH` under a
temporary `HOME` and never touches the network.
````

- [ ] **Step 4: Update `SECURITY.md`**

Make these edits:
- First paragraph: "This template provisions…" → "project-adhd provisions a development environment, attached to repositories you choose, that installs third-party agent CLIs and stores their credentials."
- Replace every `.devcontainer/post-create.sh`, `.devcontainer/devcontainer.env`, `.devcontainer/docker-compose.yml`, `.devcontainer/.env`, and `.devcontainer/lib/*.ts` with its `.devcontainer/project-adhd/…` path.
- In "Installers are unpinned by design", "fork the template" → "fork project-adhd".
- Insert after "What post-create executes":

```markdown
## What install.sh does

The documented one-liner pipes `install.sh` from this repository's `main`
branch into `bash`. It clones project-adhd with `git` into
`~/.local/share/project-adhd` (or fast-forwards an existing clone) and links
`~/.local/bin/adhd`. It downloads nothing else and needs no `sudo`. To review
it first, clone the repository and run `./install.sh` from the checkout.
```

- Replace "Credentials at rest" with:

```markdown
## Credentials at rest, and shared state

Agent credentials, plugins, settings, and histories live in named Docker
volumes that persist across rebuilds:

- shared by every attached repository: `project-adhd-shared-claude`, `-gh`,
  `-rtk-config`, `-codex`, `-gemini`, `-omp`, `-lock`
- per repository: `<prefix>-rtk-data`

**Sharing is the default.** Code running in any attached repository's
container — a dependency's install script, a test fixture — can read every
repository's agent credentials and session histories. They are the same
accounts either way, but the reach is every project. Set
`AGENT_STATE_SCOPE=project` in a repository's `devcontainer.env` to give it
private volumes instead.

Deleting `.devcontainer/project-adhd/.env` or `devcontainer.env`, or running
`adhd detach`, does **not** remove any volume. Remove them deliberately:

```bash
docker volume ls --filter name=project-adhd
docker volume rm project-adhd-shared-claude project-adhd-shared-gh …
```

Both local environment files are git-ignored by the runtime folder's
`.gitignore`, and the contract suite asserts that. Never commit either one.
```

- Append to "Host Docker socket": "For repositories you do not trust, this is the larger exposure: the Docker socket gives code in the container control of the host. Separating credentials per repository does not change that."

- [ ] **Step 5: Run the tests**

Run: `bun test 2>&1 | tail -3`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add README.md AGENTS.md SECURITY.md test/config.test.ts
git commit -m "docs: document adhd install, attach, and shared agent state"
```

---

### Task 14: Verify the spec's open items end to end

These can't be settled by the contract suite. Record each result in spec §12, marking it "Verified 2026-MM-DD: …" or describing how the design changed.

**Files:**
- Modify: `docs/superpowers/specs/2026-09-25-adhd-attach-design.md` (§12)

- [ ] **Step 1: RTK on linux/arm64 (spec §12.4)**

Run: `gh release view --repo rtk-ai/rtk --json assets --jq '.assets[].name'`
Expected: an asset naming `aarch64` (or `arm64`) and `linux`. If none exists, add a spec note and a README caveat that arm64 hosts need RTK built from source.

- [ ] **Step 2: Build an attached repository on this Linux host**

On the host (not inside this container):

```bash
./install.sh
mkdir -p /tmp/adhd-smoke && cd /tmp/adhd-smoke
adhd attach cli/cli --agents claude
code cli
```

Run **Dev Containers: Reopen in Container**.
Expected (§12.1, §12.2): VS Code finds `.devcontainer/project-adhd/devcontainer.json`, the terminal opens at `/workspaces/cli`, and `git status` inside the container is clean.

- [ ] **Step 3: Upstream devcontainer coexistence (§12.1)**

Repeat Step 2 with a repository that ships `.devcontainer/devcontainer.json` (for example `microsoft/vscode-remote-try-node`).
Expected: VS Code offers a choice between the two configurations.

- [ ] **Step 4: Shared logins and concurrency**

In the Step 2 container, authenticate `gh` and `claude`, then run `bash .devcontainer/project-adhd/post-create.sh`. Attach a second repository, reopen it in a container, and run `gh auth status` and `claude auth status`.
Expected: both are already authenticated. Open both windows at the same time: two containers, named after two different `COMPOSE_INSTANCE` values, run side by side (`docker ps`).

- [ ] **Step 5: UID alignment (§12.5)**

On a Linux host where `id -u` is not 1000 (or as a second user created for the test), repeat Step 2.
Expected: files created in the container are owned by the host user on the host. If they are not, record it. The fix belongs in spec 2 or a follow-up.

- [ ] **Step 6: macOS smoke (if a Mac is available)**

Repeat Step 2 on macOS with Docker Desktop or OrbStack.
Expected: the same results. `install.sh` prints the PATH hint for `~/.zprofile`.

- [ ] **Step 7: Retire the GitHub template setting (maintainer, manual)**

After the branch merges, turn off **Settings → General → Template repository** for `DragosMocrii/project-adhd` (spec §11).

- [ ] **Step 8: Record and commit**

```bash
git add docs/superpowers/specs/2026-09-25-adhd-attach-design.md
git commit -m "docs: record end-to-end verification of the adhd attach spec"
```

Finish with superpowers:finishing-a-development-branch.
