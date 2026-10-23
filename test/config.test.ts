import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
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

    // Legacy (pre-adhd) local files in existing checkouts of this repository.
    for (const path of [".devcontainer/.env", ".devcontainer/devcontainer.env"]) {
      const details = await run(["git", "check-ignore", "--no-index", "--verbose", "--", path], root);
      expect(details.exitCode).toBe(0);
      expect(details.stdout).toStartWith(".gitignore:");
    }

    const nested = await run(
      ["git", "check-ignore", "--no-index", "--quiet", "--", "nested/.devcontainer/project-adhd/devcontainer.env"],
      root,
    );
    expect(nested.exitCode).not.toBe(0);
  });
});

type ComposeMount = {
  source?: string;
  target?: string;
  type?: string;
  bind?: { create_host_path?: boolean };
};
type ComposeConfig = {
  name?: string;
  services?: Record<string, {
    build?: { context?: string; dockerfile?: string };
    environment?: Record<string, string>;
    ports?: unknown[];
    volumes?: ComposeMount[];
  }>;
  volumes?: Record<string, { name?: string }>;
};

const BASE_STATE =
  "PROJECT_STATE_PREFIX=my-project-1234abcd\n" +
  "COMPOSE_INSTANCE=my-project-1234abcd-9f9f9f9f\n" +
  "AGENT_STATE_PREFIX=project-adhd-shared\n" +
  "WORKSPACE_NAME=My Project\n";

// renderCompose writes .env with <state> under <root>, which Compose reads from
// the runtime folder, and returns the rendered configuration.
async function renderCompose(root: string, state: string): Promise<ComposeConfig> {
  const runtime = join(root, ".devcontainer", "project-adhd");
  await mkdir(runtime, { recursive: true });
  await copyFile(composePath, join(runtime, "docker-compose.yml"));
  await mkdir(join(runtime, "image"), { recursive: true });
  await copyFile(join(runtimeDir, "image", "Dockerfile"), join(runtime, "image", "Dockerfile"));
  await writeFile(join(runtime, "devcontainer.env"), "");
  await writeFile(join(runtime, ".env"), state);
  const result = await run(
    ["docker", "compose", "-f", ".devcontainer/project-adhd/docker-compose.yml", "config", "--format", "json"],
    root,
  );
  if (result.exitCode !== 0) {
    throw new Error(`docker compose config failed:\n${result.stdout}${result.stderr}`);
  }
  return JSON.parse(result.stdout) as ComposeConfig;
}


test("renders a per-worktree Compose project with shared agent volumes read from .env", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "My Project");
    const config = await renderCompose(root, BASE_STATE);
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
      "vscode-extensions": "my-project-1234abcd-vscode-extensions",
      "vscode-machine": "my-project-1234abcd-vscode-machine",
      "vscode-user": "my-project-1234abcd-vscode-user",
    };
    expect(Object.keys(config.volumes ?? {}).sort()).toEqual(Object.keys(expectedVolumes).sort());
    for (const [logicalName, explicitName] of Object.entries(expectedVolumes)) {
      expect(config.volumes?.[logicalName]?.name).toBe(explicitName);
    }
    const workspace = config.services?.workspace;
    expect(workspace?.build?.context).toBe(join(root, ".devcontainer", "project-adhd", "image"));

    expect(workspace?.environment?.PULSE_SERVER).toBeUndefined();
    expect(workspace?.ports ?? []).toHaveLength(0);
    expect((workspace?.volumes ?? []).some((mount) => mount.target === "/run/host/pulse")).toBe(false);
    const mounts = new Map((workspace?.volumes ?? []).map((mount) => [mount.target, mount]));
    const vscodeMounts = [
      ["/home/vscode/.vscode-server/extensions", "vscode-extensions"],
      ["/home/vscode/.vscode-server/data/Machine", "vscode-machine"],
      ["/home/vscode/.vscode-server/data/User", "vscode-user"],
    ] as const;
    const vscodeTargets = vscodeMounts.map(([target]) => target);
    expect(
      (workspace?.volumes ?? [])
        .filter((mount) => mount.target?.startsWith("/home/vscode/.vscode-server"))
        .map((mount) => mount.target)
        .sort(),
    ).toEqual([...vscodeTargets].sort());
    for (const [target, source] of vscodeMounts) {
      const mount = mounts.get(target);
      expect(mount?.type).toBe("volume");
      expect(mount?.source).toBe(source);
    }
    expect(mounts.get("/home/vscode/.local/state/project-adhd")?.source).toBe("lock-state");
    expect(mounts.get("/home/vscode/.local/share/rtk")?.source).toBe("rtk-data-state");
    const bind = mounts.get("/workspaces/My Project");
    expect(bind?.type).toBe("bind");
    expect(bind?.source).toBe(root);
  });
});

test("scopes VS Code state to the project, shared by its worktrees and independent of agent scope", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "My Project");
    const base = await renderCompose(root, BASE_STATE);
    const worktreeState = BASE_STATE.replace(
      "my-project-1234abcd-9f9f9f9f",
      "my-project-1234abcd-8e8e8e8e",
    );
    const otherWorktree = await renderCompose(root, worktreeState);
    const otherProject = await renderCompose(root, BASE_STATE.replaceAll("my-project-1234abcd", "my-project-5678ef01"));
    const vscodeVolumes = ["vscode-extensions", "vscode-machine", "vscode-user"];
    for (const logicalName of vscodeVolumes) {
      expect(base.volumes?.[logicalName]?.name).toBe(`my-project-1234abcd-${logicalName}`);
      expect(otherWorktree.volumes?.[logicalName]?.name).toBe(base.volumes?.[logicalName]?.name);
      expect(otherProject.volumes?.[logicalName]?.name).toBe(`my-project-5678ef01-${logicalName}`);
    }

    const agentScopeState = BASE_STATE.replace("project-adhd-shared", "another-shared-scope");
    const otherAgentScope = await renderCompose(root, agentScopeState);
    for (const logicalName of vscodeVolumes) {
      expect(otherAgentScope.volumes?.[logicalName]?.name).toBe(base.volumes?.[logicalName]?.name);
    }
  });
});


test("opens the workspace at /workspaces/<folder> with runtime-folder lifecycle commands and no host Docker feature", async () => {
  const config = JSON.parse(await readFile(devcontainerConfigPath, "utf8")) as {
    workspaceFolder?: string;
    initializeCommand?: string;
    postCreateCommand?: string;
    updateContentCommand?: unknown;
    features?: Record<string, unknown>;
  };
  expect(config.workspaceFolder).toBe("/workspaces/${localWorkspaceFolderBasename}");
  expect(config.initializeCommand).toBe(
    'bash "${localWorkspaceFolder}/.devcontainer/project-adhd/initialize.sh" "${localWorkspaceFolder}"',
  );
  expect(config.postCreateCommand).toBe("bash .devcontainer/project-adhd/post-create.sh");
  expect(config.updateContentCommand).toBeUndefined();
  expect(config.features).not.toHaveProperty(
    "ghcr.io/devcontainers/features/docker-outside-of-docker:1",
  );
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

test("ships agent guidance only as AGENTS.md", async () => {
  const agents = await readFile(join(repoRoot, "AGENTS.md"), "utf8");

  expect(agents).toContain("AGENT_TOOLS");
  expect(agents).toContain(".devcontainer/project-adhd/");
  expect(agents).toContain("bash 3.2");
  expect(agents).toContain("Conventional Commits");
  // Claude Code reads AGENTS.md only when no project CLAUDE.md exists.
  for (const file of ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"]) {
    expect(existsSync(join(repoRoot, file))).toBe(false);
  }
});

test("release-please owns VERSION with the agreed 0.x bump rules", async () => {
  const config = JSON.parse(await readFile(join(repoRoot, "release-please-config.json"), "utf8"));
  const pkg = config.packages["."];
  expect(pkg["release-type"]).toBe("simple");
  expect(pkg["version-file"]).toBe("VERSION");
  expect(pkg["include-component-in-tag"]).toBe(false);
  expect(pkg["include-v-in-tag"]).toBe(true);
  expect(pkg["bump-minor-pre-major"]).toBe(true);
  expect(pkg["bump-patch-for-minor-pre-major"]).toBe(true);

  const manifest = JSON.parse(await readFile(join(repoRoot, ".release-please-manifest.json"), "utf8"));
  const version = await readFile(join(repoRoot, "VERSION"), "utf8");
  expect(version).toMatch(/^\d+\.\d+\.\d+\n?$/);
  expect(manifest["."]).toBe(version.trim());
});

test("the release workflow pins every action to a commit", async () => {
  const workflow = await readFile(join(repoRoot, ".github/workflows/release.yml"), "utf8");
  const uses = workflow.split("\n").filter((line) => /^\s*(-\s*)?uses:/.test(line));
  expect(uses.length).toBeGreaterThan(0);
  for (const line of uses) {
    expect(line).toMatch(/uses:\s+[\w.-]+\/[\w.-]+@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+\s*$/);
  }
});
