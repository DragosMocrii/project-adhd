import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { environmentName } from "../src/index";

const scaffoldRoot = resolve(import.meta.dir, "..");
const initializerPath = join(scaffoldRoot, ".devcontainer", "initialize.sh");
const gitignorePath = join(scaffoldRoot, ".gitignore");
const composePath = join(scaffoldRoot, ".devcontainer", "docker-compose.yml");

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function run(
  command: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<CommandResult> {
  const mergedEnv = env === undefined
    ? undefined
    : {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
        ...env,
      };
  const childProcess = Bun.spawn(command, {
    cwd,
    ...(mergedEnv === undefined ? {} : { env: mergedEnv }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(childProcess.stdout).text(),
    new Response(childProcess.stderr).text(),
  ]);
  return { exitCode: await childProcess.exited, stdout, stderr };
}

async function checked(
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

async function withTemporaryParent<T>(
  callback: (parent: string) => Promise<T>,
): Promise<T> {
  const parent = await mkdtemp(join(tmpdir(), "agentic-bun-scaffold-"));
  try {
    return await callback(parent);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
}

async function prepareRepository(root: string): Promise<void> {
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

async function runInitializer(root: string): Promise<void> {
  const result = await run(["bash", join(root, ".devcontainer", "initialize.sh"), root], root);
  if (result.exitCode !== 0) {
    throw new Error(
      `initializer failed with exit code ${result.exitCode}\n${result.stdout}${result.stderr}`,
    );
  }
}

async function readStatePrefix(root: string): Promise<string> {
  const contents = await readFile(join(root, ".devcontainer", ".env"), "utf8");
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

test("reports the starter environment name", () => {
  expect(environmentName()).toBe("agentic-bun-project");
});

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
    expect(await readFile(join(root, ".devcontainer", "devcontainer.env"), "utf8")).toBe("");
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
    const statePath = join(root, ".devcontainer", ".env");
    const secretPath = join(root, ".devcontainer", "devcontainer.env");
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

test("enforces root-scoped ignore rules for local state", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "ignore-rules");
    await mkdir(root);
    await prepareRepository(root);

    const rootScopedRules = [
      [".devcontainer/.env", "/.devcontainer/.env"],
      [".devcontainer/devcontainer.env", "/.devcontainer/devcontainer.env"],
    ] as const;
    for (const [path, rule] of rootScopedRules) {
      const result = await run(
        ["git", "check-ignore", "--no-index", "--quiet", "--", path],
        root,
      );
      if (result.exitCode !== 0) {
        throw new Error(`expected ${path} to be ignored:\n${result.stderr}`);
      }
      const details = await run(
        ["git", "check-ignore", "--no-index", "--verbose", "--", path],
        root,
      );
      expect(details.stdout).toContain(`:${rule}\t${path}`);
    }

    for (const path of [
      ".worktrees/probe",
      ".claude/worktrees/probe",
      ".superpowers/probe",
    ]) {
      const result = await run(
        ["git", "check-ignore", "--no-index", "--quiet", "--", path],
        root,
      );
      if (result.exitCode !== 0) {
        throw new Error(`expected ${path} to be ignored:\n${result.stderr}`);
      }
    }

    const nestedEnvironmentFile = await run(
      [
        "git",
        "check-ignore",
        "--no-index",
        "--verbose",
        "--",
        "nested/.devcontainer/.env",
      ],
      root,
    );
    expect(nestedEnvironmentFile.exitCode).toBe(0);
    expect(nestedEnvironmentFile.stdout).toContain(
      ":.env\tnested/.devcontainer/.env",
    );
    expect(nestedEnvironmentFile.stdout).not.toContain(
      ":/.devcontainer/.env\tnested/.devcontainer/.env",
    );

    const nestedDevcontainerEnvironmentFile = await run(
      [
        "git",
        "check-ignore",
        "--no-index",
        "--quiet",
        "--",
        "nested/.devcontainer/devcontainer.env",
      ],
      root,
    );
    expect(nestedDevcontainerEnvironmentFile.exitCode).not.toBe(0);
  });
});

test("keeps tracked configuration free of product paths and unconditional databases", async () => {
  const tracked = (await checked(["git", "ls-files"], scaffoldRoot))
    .split("\n")
    .filter((path) => path.length > 0 && !path.startsWith("test/"));
  const contents = await Promise.all(
    tracked.map(async (path) => [path, await readFile(join(scaffoldRoot, path), "utf8")] as const),
  );
  const forbidden = [
    "integration-kit",
    "@integration-kit",
    "/workspaces/integration-kit",
    "DragosMocrii",
    "apps/playground",
  ];
  for (const [path, text] of contents) {
    for (const value of forbidden) {
      expect(text, `${path} contains forbidden value ${value}`).not.toContain(value);
    }
  }

  const compose = contents.find(([path]) => path === ".devcontainer/docker-compose.yml");
  expect(compose).toBeDefined();
  expect(compose?.[1]).not.toMatch(/^\s*(redis|postgres(?:ql)?|mysql)\s*:/im);
});

test("renders one Compose workspace with six explicit state volumes and no published ports", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "compose-contract");
    await mkdir(join(root, ".devcontainer"), { recursive: true });
    await copyFile(composePath, join(root, ".devcontainer", "docker-compose.yml"));
    await writeFile(join(root, ".devcontainer", "devcontainer.env"), "");
    const prefix = "compose-contract-test";
    const result = await run(
      ["docker", "compose", "-f", ".devcontainer/docker-compose.yml", "config", "--format", "json"],
      root,
      { PROJECT_STATE_PREFIX: prefix },
    );
    if (result.exitCode !== 0) {
      throw new Error(`docker compose config failed:\n${result.stdout}${result.stderr}`);
    }

    type ComposeConfig = {
      services?: Record<string, {
        ports?: unknown[];
        volumes?: Array<{ source?: string; target?: string; type?: string }>;
      }>;
      volumes?: Record<string, { name?: string }>;
    };
    const config = JSON.parse(result.stdout) as ComposeConfig;
    const serviceNames = Object.keys(config.services ?? {});
    expect(serviceNames).toEqual(["workspace"]);

    const expectedVolumes = {
      "claude-state": `${prefix}-claude`,
      "github-state": `${prefix}-gh`,
      "rtk-config-state": `${prefix}-rtk-config`,
      "rtk-data-state": `${prefix}-rtk-data`,
      "codex-state": `${prefix}-codex`,
      "omp-state": `${prefix}-omp`,
    };
    expect(Object.keys(config.volumes ?? {}).sort()).toEqual(
      Object.keys(expectedVolumes).sort(),
    );
    for (const [logicalName, explicitName] of Object.entries(expectedVolumes)) {
      expect(config.volumes?.[logicalName]?.name).toBe(explicitName);
    }

    const workspace = config.services?.workspace;
    expect(workspace).toBeDefined();
    expect(workspace?.ports ?? []).toHaveLength(0);
    const mounts = new Map(
      (workspace?.volumes ?? []).map((mount) => [mount.target, mount]),
    );
    expect(mounts.get("/home/vscode/.config/rtk")?.source).toBe("rtk-config-state");
    expect(mounts.get("/home/vscode/.local/share/rtk")?.source).toBe("rtk-data-state");
    expect(
      (workspace?.volumes ?? [])
        .filter((mount) => mount.type === "volume")
        .map((mount) => mount.source)
        .sort(),
    ).toEqual(Object.keys(expectedVolumes).sort());
  });
});

test("documents executable template setup and state conventions", async () => {
  const readme = await readFile(join(scaffoldRoot, "README.md"), "utf8");
  for (const required of [
    'OWNER="$(gh api user --jq .login)"',
    'gh repo create my-project --private --template "$OWNER/agentic-bun-devcontainer" --clone',
    "git worktree add .worktrees/feature-example -b feature/example",
    "gh auth login",
    "claude auth login",
    "codex login",
    "OMP provider",
    "LOCAL_WORKSPACE_FOLDER",
    "relative to the shared/main checkout",
    "host main-checkout anchor",
    "daemon-visible",
    "bun test",
    "bun run typecheck",
    ".devcontainer/verify.sh",
  ]) {
    expect(readme).toContain(required);
  }
});
