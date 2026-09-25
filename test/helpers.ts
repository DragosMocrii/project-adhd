import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
// Task 6 appends ".local/state" and ".local/state/project-adhd".
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
