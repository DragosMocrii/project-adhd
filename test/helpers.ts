import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const repoRoot = resolve(import.meta.dir, "..");
export const runtimeDir = join(repoRoot, ".devcontainer", "project-adhd");
export const runtimeGitignorePath = join(runtimeDir, ".gitignore");
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
  stdin?: string,
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
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
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
  // Canonical, so macOS's /var -> /private/var symlink matches the pwd -P paths
  // the scripts record.
  const parent = await realpath(await mkdtemp(join(tmpdir(), "project-adhd-test-")));
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
  ".local/state",
  ".local/state/project-adhd",
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
  // Fixtures must not depend on the released version: the repository's VERSION
  // changes with every release PR, so pin the fixture's own to 0.0.0.
  await writeFile(join(source, "VERSION"), "0.0.0\n");
  await makeRepo(source, {});
  await checked(["git", "clone", "-q", "--bare", source, origin], parent);
  await checked(["git", "clone", "-q", origin, checkout], parent);
  return { checkout, origin };
}

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

const TEST_IDENTITY = ["-c", "user.email=project-adhd-tests@example.invalid", "-c", "user.name=project-adhd tests"];

// Writes <files> in <repo>, commits them, and tags the commit when <tag> is given.
export async function commitFiles(
  repo: string,
  files: Record<string, string>,
  message: string,
  tag?: string,
): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), contents);
  }
  await checked(["git", "-C", repo, "add", "-A"], repo);
  await checked(["git", "-C", repo, ...TEST_IDENTITY, "commit", "-q", "-m", message], repo);
  if (tag !== undefined) await checked(["git", "-C", repo, "tag", tag], repo);
}

// Commits <files> to <origin>'s main from a scratch clone and pushes it, with <tag> if given.
export async function pushCommit(
  parent: string,
  origin: string,
  files: Record<string, string>,
  tag?: string,
): Promise<void> {
  const scratch = await mkdtemp(join(parent, "push-"));
  await checked(["git", "clone", "-q", origin, scratch], parent);
  await commitFiles(scratch, files, tag === undefined ? "chore: change" : `chore: release ${tag}`, tag);
  await checked(["git", "-C", scratch, "push", "-q", "origin", "HEAD:main", ...(tag === undefined ? [] : [tag])], scratch);
  await rm(scratch, { force: true, recursive: true });
}

// Publishes a release the way release-please does: VERSION bumped, commit tagged v<version>.
export async function publishRelease(parent: string, origin: string, version: string): Promise<void> {
  await pushCommit(parent, origin, { VERSION: `${version}\n` }, `v${version}`);
}

export async function setChannel(installation: string, ref: string): Promise<void> {
  await checked(["git", "-C", installation, "config", "adhd.ref", ref], installation);
}

export async function readChannel(installation: string): Promise<string> {
  const result = await run(["git", "-C", installation, "config", "--get", "adhd.ref"], installation);
  return result.exitCode === 0 ? result.stdout.trim() : "";
}

export async function headTag(installation: string): Promise<string> {
  const result = await run(["git", "-C", installation, "describe", "--tags", "--exact-match", "HEAD"], installation);
  return result.exitCode === 0 ? result.stdout.trim() : "";
}
