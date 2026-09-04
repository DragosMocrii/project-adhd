import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { environmentName } from "../src/index";

const scaffoldRoot = resolve(import.meta.dir, "..");
const initializerPath = join(scaffoldRoot, ".devcontainer", "initialize.sh");
const postCreatePath = join(scaffoldRoot, ".devcontainer", "post-create.sh");
const verifyPath = join(scaffoldRoot, ".devcontainer", "verify.sh");
const devcontainerConfigPath = join(scaffoldRoot, ".devcontainer", "devcontainer.json");
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

async function parseCodexMarketplace(document: unknown): Promise<CommandResult> {
  return run(
    [
      "bash",
      "-c",
      'source "$1"; parse_codex_marketplace_name "$2"',
      "scaffold-parser",
      postCreatePath,
      JSON.stringify(document),
    ],
    scaffoldRoot,
  );
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
      ["bash", join(root, ".devcontainer", "initialize.sh"), root],
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
      join(root, ".devcontainer", ".env"),
      "PROJECT_STATE_PREFIX=malformed-state-1234abcd\ntrailing-junk",
    );

    await runInitializer(root);

    expect(await readStatePrefix(root)).toMatch(/^malformed-state-[0-9a-f]{8}$/);
    expect(await readStatePrefix(root)).not.toBe("malformed-state-1234abcd");
  });
});

test("uses portable shell primitives for initializer identity and state files", async () => {
  const source = await readFile(initializerPath, "utf8");
  expect(source).not.toContain("realpath -e");
  expect(source).not.toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*,,\}/);
  expect(source).not.toContain("mapfile");
  expect(source).toContain("tr '[:upper:]' '[:lower:]'");
  expect(source).toContain("sha256sum");
  expect(source).toContain("shasum");
  expect(source).toContain("while IFS= read -r");
});

test("enables Codex plugins before selecting an exposed official marketplace", async () => {
  const postCreate = await readFile(postCreatePath, "utf8");
  const featureIndex = postCreate.indexOf("codex features enable plugins");
  const listIndex = postCreate.indexOf("codex plugin marketplace list --json");
  const addIndex = postCreate.indexOf("codex plugin add superpowers@$");

  expect(featureIndex).toBeGreaterThanOrEqual(0);
  expect(listIndex).toBeGreaterThan(featureIndex);
  expect(addIndex).toBeGreaterThan(listIndex);
  expect(postCreate).toContain("openai-curated");
  expect(postCreate).toContain("openai-api-curated");
  expect(postCreate).not.toContain("codex plugin marketplace upgrade");
  expect(postCreate).not.toContain("codex plugin marketplace add");
});

test("selects Codex default and API-key catalogs, preferring active/default, and rejects absence", async () => {
  const defaultCatalog = await parseCodexMarketplace({
    marketplaces: [{ name: "openai-curated", root: "/home/vscode/.codex/.tmp/plugins" }],
  });
  expect(defaultCatalog.stdout.trim()).toBe("openai-curated");

  const apiCatalog = await parseCodexMarketplace({
    marketplaces: [{ name: "openai-api-curated", root: "/home/vscode/.codex/.tmp/plugins" }],
  });
  expect(apiCatalog.exitCode).toBe(0);
  expect(apiCatalog.stdout.trim()).toBe("openai-api-curated");

  const bothCatalogs = await parseCodexMarketplace({
    marketplaces: [
      { name: "openai-api-curated", default: false, active: false },
      { name: "openai-curated", default: true, active: true },
    ],
  });
  expect(bothCatalogs.exitCode).toBe(0);
  expect(bothCatalogs.stdout.trim()).toBe("openai-curated");

  const absentCatalog = await parseCodexMarketplace({
    marketplaces: [{ name: "third-party" }],
  });
  expect(absentCatalog.exitCode).not.toBe(0);
  expect(absentCatalog.stderr).toContain("official Codex marketplace");
});

test("defers auth-gated Superpowers setup until users can rerun after login", async () => {
  const postCreate = await readFile(postCreatePath, "utf8");
  const verify = await readFile(verifyPath, "utf8");
  const obsoleteSelector = ["openai", "api", "curated"].join("-");
  const obsoleteAddCommand = `codex plugin add superpowers@${obsoleteSelector}`;

  expect(postCreate).toContain("claude auth status");
  expect(postCreate).toContain("codex login status");
  expect(postCreate).toContain("Superpowers setup deferred");
  expect(postCreate).toContain("bash .devcontainer/post-create.sh");
  expect(postCreate).toContain("install_archify");
  expect(postCreate).toContain("codex plugin add superpowers@$codex_marketplace --json");
  expect(postCreate).not.toContain(obsoleteAddCommand);
  expect(verify).toContain("openai-curated");
  expect(verify).toContain("openai-api-curated");
  expect(verify).not.toContain(obsoleteAddCommand);
});

test("runs pre-login post-create successfully while still installing auth-free Archify", async () => {
  await withTemporaryParent(async (parent) => {
    const home = join(parent, "home");
    const stubBin = join(home, ".local", "bin");
    await mkdir(stubBin, { recursive: true });
    for (const directory of [
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
    ]) {
      await mkdir(join(home, directory), { recursive: true });
    }

    const stubs: Record<string, string> = {
      curl: "#!/bin/sh\ncase \"$*\" in\n  *claude.ai/install.sh*|*rtk-ai/rtk/*|*chatgpt.com/codex/install.sh*) echo 'preinstalled tools must skip their installers' >&2; exit 42;;\n  *) printf ':';;\nesac\n",
      bun: "#!/bin/sh\nif [ \"$1\" = install ]; then echo 'preinstalled OMP must skip its installer' >&2; exit 42; fi\nexit 0\n",
      bunx: "#!/bin/sh\nmkdir -p \"$HOME/.agents/skills/archify\"\nprintf 'archify\\n' > \"$HOME/.agents/skills/archify/SKILL.md\"\n",
      gh: "#!/bin/sh\nif [ \"$1\" = auth ] && [ \"$2\" = status ]; then exit 1; fi\nexit 0\n",
      claude: "#!/bin/sh\nif [ \"$1\" = auth ] && [ \"$2\" = status ]; then exit 1; fi\nexit 0\n",
      codex: "#!/bin/sh\nif [ \"$1\" = login ] && [ \"$2\" = status ]; then exit 1; fi\nexit 0\n",
      gemini: "#!/bin/sh\nexit 0\n",
      rtk: "#!/bin/sh\nexit 0\n",
      omp: "#!/bin/sh\nexit 0\n",
    };
    for (const [name, contents] of Object.entries(stubs)) {
      const path = join(stubBin, name);
      await writeFile(path, contents);
      await chmod(path, 0o755);
    }

    const result = await run(["bash", postCreatePath], home, {
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Superpowers setup deferred");
    expect(result.stdout).toContain("bash .devcontainer/post-create.sh");
    for (const destination of [
      join(home, ".claude/skills/archify/SKILL.md"),
      join(home, ".codex/skills/archify/SKILL.md"),
      join(home, ".omp/agent/skills/archify/SKILL.md"),
    ]) {
      expect(await readFile(destination, "utf8")).toBe("archify\n");
    }
  });
});


test("installs Gemini CLI globally when the command is missing", async () => {
  await withTemporaryParent(async (parent) => {
    const home = join(parent, "home");
    const stubBin = join(home, ".local", "bin");
    const marker = join(parent, "gemini-install-args");
    const trustMarker = join(parent, "omp-trust-args");
    const trustStage = join(parent, "omp-trust-stage");
    await mkdir(stubBin, { recursive: true });

    const stubs: Record<string, string> = {
      claude: "#!/bin/sh\nexit 0\n",
      codex: "#!/bin/sh\nexit 0\n",
      omp: "#!/bin/sh\nexit 0\n",
      rtk: "#!/bin/sh\nexit 0\n",
      npm: "#!/bin/sh\nprintf '%s|%s' \"$NPM_CONFIG_PREFIX\" \"$*\" > \"$GEMINI_INSTALL_MARKER\"\n",
      bun: "#!/bin/sh\ncase \"$*\" in\n  'pm -g untrusted')\n    if [ -f \"$OMP_TRUST_STAGE\" ]; then printf 'sharp\\n'; else printf 'onnxruntime-node\\nprotobufjs\\n'; fi\n    ;;\n  *)\n    printf '%s\\n' \"$*\" >> \"$OMP_TRUST_MARKER\"\n    : > \"$OMP_TRUST_STAGE\"\n    ;;\nesac\n",
    };
    for (const [name, contents] of Object.entries(stubs)) {
      const path = join(stubBin, name);
      await writeFile(path, contents);
      await chmod(path, 0o755);
    }

    const result = await run(
      ["/bin/bash", "-c", 'source "$1"; install_tools', "scaffold-installer", postCreatePath],
      home,
      {
        HOME: home,
        PATH: stubBin,
        GEMINI_INSTALL_MARKER: marker,
        OMP_TRUST_MARKER: trustMarker,
        OMP_TRUST_STAGE: trustStage,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("==> Installing Gemini CLI");
    expect(await readFile(marker, "utf8")).toBe(
      `${join(home, ".local")}|install -g --allow-scripts=@github/keytar @google/gemini-cli`,
    );
    expect(await readFile(trustMarker, "utf8")).toBe(
      "pm -g trust onnxruntime-node\npm -g trust protobufjs\npm -g trust sharp\n",
    );
  });
});

test("reports Bun trust query failures", async () => {
  await withTemporaryParent(async (parent) => {
    const home = join(parent, "home");
    const stubBin = join(home, ".local", "bin");
    await mkdir(stubBin, { recursive: true });

    const bunPath = join(stubBin, "bun");
    await writeFile(
      bunPath,
      "#!/bin/sh\nif [ \"$*\" = 'pm -g untrusted' ]; then printf 'global store unavailable\\n' >&2; exit 17; fi\nexit 0\n",
    );
    await chmod(bunPath, 0o755);

    const result = await run(
      ["/bin/bash", "-c", 'source "$1"; trust_omp_dependencies', "scaffold-installer", postCreatePath],
      home,
      { HOME: home, PATH: stubBin },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unable to query untrusted Bun dependencies");
    expect(result.stderr).toContain("global store unavailable");
  });
});

test("reinstalls RTK when the existing binary fails the RTK identity check", async () => {
  await withTemporaryParent(async (parent) => {
    const home = join(parent, "home");
    const stubBin = join(home, ".local", "bin");
    const marker = join(parent, "rtk-installer-ran");
    await mkdir(stubBin, { recursive: true });

    const stubs: Record<string, string> = {
      claude: "#!/bin/sh\nexit 0\n",
      codex: "#!/bin/sh\nexit 0\n",
      omp: "#!/bin/sh\nexit 0\n",
      gemini: "#!/bin/sh\nexit 0\n",
      rtk: "#!/bin/sh\nif [ \"$1\" = gain ]; then exit 1; fi\nexit 0\n",
      curl: "#!/bin/sh\ncase \"$*\" in\n  *rtk-ai/rtk/*) printf 'printf installed > \"$RTK_INSTALL_MARKER\"\\n';;\n  *) echo 'unexpected installer invoked' >&2; exit 42;;\nesac\n",
      bun: "#!/bin/sh\nif [ \"$1\" = pm ]; then exit 0; fi\necho 'unexpected OMP installer invoked' >&2\nexit 42\n",
    };
    for (const [name, contents] of Object.entries(stubs)) {
      const path = join(stubBin, name);
      await writeFile(path, contents);
      await chmod(path, 0o755);
    }

    const result = await run(
      ["bash", "-c", 'source "$1"; install_tools', "scaffold-installer", postCreatePath],
      home,
      {
        HOME: home,
        PATH: `${stubBin}:${process.env.PATH ?? ""}`,
        RTK_INSTALL_MARKER: marker,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("==> Installing rtk");
    expect(await readFile(marker, "utf8")).toBe("installed");
  });
});
test("quotes the host-side initialize command for paths containing spaces", async () => {
  const devcontainer = await readFile(devcontainerConfigPath, "utf8");
  expect(devcontainer).toContain(
    '"initializeCommand": "bash \\"${localWorkspaceFolder}/.devcontainer/initialize.sh\\" \\"${localWorkspaceFolder}\\""',
  );
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

test("renders one Compose workspace with seven explicit state volumes and no published ports", async () => {
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
    const expectedVolumes = {
      "claude-state": `${prefix}-claude`,
      "github-state": `${prefix}-gh`,
      "rtk-config-state": `${prefix}-rtk-config`,
      "rtk-data-state": `${prefix}-rtk-data`,
      "codex-state": `${prefix}-codex`,
      "gemini-state": `${prefix}-gemini`,
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
    expect(mounts.get("/home/vscode/.gemini")?.source).toBe("gemini-state");
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

test("configures Gemini CLI for manual authentication", async () => {
  const config = JSON.parse(await readFile(devcontainerConfigPath, "utf8")) as {
    containerEnv?: Record<string, string>;
  };
  expect(config.containerEnv?.NO_BROWSER).toBe("true");
});

test("documents executable template setup and state conventions", async () => {
  const readme = await readFile(join(scaffoldRoot, "README.md"), "utf8");
  for (const required of [
    "python3",
    'OWNER="$(gh api user --jq .login)"',
    'gh repo create my-project --private --template "$OWNER/project-adhd" --clone',
    "git worktree add .worktrees/feature-example -b feature/example",
    "gh auth login",
    "claude auth login",
    "codex login",
    "gemini",
    "bash .devcontainer/post-create.sh",
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
  expect(readme).toContain("skips auth-dependent Superpowers plugin setup");
  expect(readme).toContain("exits successfully");
  expect(readme).not.toContain("private GitHub template");
  const authRerunSteps = [
    "gh auth login",
    "claude auth login",
    "codex login",
    "bash .devcontainer/post-create.sh",
    ".devcontainer/verify.sh",
  ];
  for (let index = 1; index < authRerunSteps.length; index += 1) {
    expect(readme.indexOf(authRerunSteps[index])).toBeGreaterThan(
      readme.indexOf(authRerunSteps[index - 1]),
    );
  }
});
