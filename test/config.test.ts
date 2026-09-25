import { expect, test } from "bun:test";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  composePath,
  devcontainerConfigPath,
  prepareRepository,
  repoRoot,
  run,
  runtimeDir,
  withTemporaryParent,
} from "./helpers";

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

test("configures Gemini CLI for manual authentication", async () => {
  const config = JSON.parse(await readFile(devcontainerConfigPath, "utf8")) as {
    containerEnv?: Record<string, string>;
  };
  expect(config.containerEnv?.NO_BROWSER).toBe("true");
});

test("presents one aligned project identity and a Bun-matched types pin", async () => {
  const packageManifest = JSON.parse(
    await readFile(join(repoRoot, "package.json"), "utf8"),
  ) as { name?: string; devDependencies?: Record<string, string> };
  const devcontainerConfig = JSON.parse(await readFile(devcontainerConfigPath, "utf8")) as {
    name?: string;
    features?: Record<string, { version?: string }>;
  };

  expect(packageManifest.name).toBe("project-adhd");
  expect(devcontainerConfig.name).toBe("project-adhd");
  expect(packageManifest.devDependencies?.["@types/bun"]).toBe("1.4.2");

  const bunFeature = devcontainerConfig.features?.["ghcr.io/devcontainers-extra/features/bun:1"];
  expect(bunFeature?.version).toBe("1.4.0");
});

test("documents AGENT_TOOLS in the tracked environment example", async () => {
  const example = await readFile(
    join(runtimeDir, "devcontainer.env.example"),
    "utf8",
  );
  expect(example).toContain("AGENT_TOOLS");
  expect(example).toContain("claude,codex,gemini,omp");
  expect(example).toContain("AGENT_STATE_SCOPE");
});

test("documents a create command that works for someone who is not the repository owner", async () => {
  const readme = await readFile(join(repoRoot, "README.md"), "utf8");

  expect(readme).toContain("--template DragosMocrii/project-adhd");
  expect(readme).not.toContain("gh api user --jq .login");
  expect(readme).not.toContain('"$OWNER/project-adhd"');
  expect(readme).toContain("AGENT_TOOLS");
  expect(readme).toContain("SECURITY.md");

  const createCommandLine = readme
    .split("\n")
    .find((line) => line.includes("gh repo create"));
  expect(createCommandLine).toBeDefined();
  expect(createCommandLine).toContain("--template DragosMocrii/project-adhd");
  expect(createCommandLine).not.toContain("$OWNER");
});

test("ships agent guidance that Claude and Codex both resolve", async () => {
  const agents = await readFile(join(repoRoot, "AGENTS.md"), "utf8");
  const claude = await readFile(join(repoRoot, "CLAUDE.md"), "utf8");

  expect(agents).toContain("AGENT_TOOLS");
  expect(agents).toContain(".devcontainer/");
  expect(claude.trim()).toBe("@AGENTS.md");
});
