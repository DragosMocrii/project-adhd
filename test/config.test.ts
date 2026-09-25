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

test("renders one Compose workspace with seven explicit state volumes and no published ports", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "compose-contract");
    await mkdir(join(root, ".devcontainer", "project-adhd"), { recursive: true });
    await copyFile(composePath, join(root, ".devcontainer", "project-adhd", "docker-compose.yml"));
    await writeFile(join(root, ".devcontainer", "project-adhd", "devcontainer.env"), "");
    const prefix = "compose-contract-test";
    const result = await run(
      ["docker", "compose", "-f", ".devcontainer/project-adhd/docker-compose.yml", "config", "--format", "json"],
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
