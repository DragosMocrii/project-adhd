import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CommandResult,
  makeHome,
  postCreatePath,
  repoRoot,
  run,
  withTemporaryParent,
  writeStubs,
} from "./helpers";

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
    repoRoot,
  );
}

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

test("runs pre-login post-create successfully while still installing auth-free Archify", async () => {
  await withTemporaryParent(async (parent) => {
    const { home, stubBin } = await makeHome(parent);

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
    await writeStubs(stubBin, stubs);

    const result = await run(["bash", postCreatePath], home, {
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Superpowers setup deferred");
    expect(result.stdout).toContain("deferred for claude");
    expect(result.stdout).toContain("deferred for codex");
    expect(result.stdout).toContain("bash .devcontainer/project-adhd/post-create.sh");
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
    const { home, stubBin } = await makeHome(parent);
    const marker = join(parent, "gemini-install-args");
    const trustMarker = join(parent, "omp-trust-args");
    const trustStage = join(parent, "omp-trust-stage");

    const stubs: Record<string, string> = {
      claude: "#!/bin/sh\nexit 0\n",
      codex: "#!/bin/sh\nexit 0\n",
      omp: "#!/bin/sh\nexit 0\n",
      rtk: "#!/bin/sh\nexit 0\n",
      npm: "#!/bin/sh\nprintf '%s|%s' \"$NPM_CONFIG_PREFIX\" \"$*\" > \"$GEMINI_INSTALL_MARKER\"\n",
      bun: "#!/bin/sh\ncase \"$*\" in\n  'pm -g untrusted')\n    if [ -f \"$OMP_TRUST_STAGE\" ]; then printf 'sharp\\n'; else printf 'onnxruntime-node\\nprotobufjs\\n'; fi\n    ;;\n  *)\n    printf '%s\\n' \"$*\" >> \"$OMP_TRUST_MARKER\"\n    : > \"$OMP_TRUST_STAGE\"\n    ;;\nesac\n",
    };
    await writeStubs(stubBin, stubs);

    const result = await run(
      ["/bin/bash", "-c", 'source "$1"; agent_tools_init; install_tools', "scaffold-installer", postCreatePath],
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
    const { home, stubBin } = await makeHome(parent);

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
    const { home, stubBin } = await makeHome(parent);
    const marker = join(parent, "rtk-installer-ran");

    const stubs: Record<string, string> = {
      claude: "#!/bin/sh\nexit 0\n",
      codex: "#!/bin/sh\nexit 0\n",
      omp: "#!/bin/sh\nexit 0\n",
      gemini: "#!/bin/sh\nexit 0\n",
      rtk: "#!/bin/sh\nif [ \"$1\" = gain ]; then exit 1; fi\nexit 0\n",
      curl: "#!/bin/sh\ncase \"$*\" in\n  *rtk-ai/rtk/*) printf 'printf installed > \"$RTK_INSTALL_MARKER\"\\n';;\n  *) echo 'unexpected installer invoked' >&2; exit 42;;\nesac\n",
      bun: "#!/bin/sh\nif [ \"$1\" = pm ]; then exit 0; fi\necho 'unexpected OMP installer invoked' >&2\nexit 42\n",
    };
    await writeStubs(stubBin, stubs);

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

test("installs and configures only the selected agent tool", async () => {
  await withTemporaryParent(async (parent) => {
    const { home, stubBin } = await makeHome(parent);
    const npmMarker = join(parent, "npm-invoked");

    // No codex, gemini, or omp stubs: if gating leaks, their installers run
    // and the curl/npm stubs below fail the run.
    const stubs: Record<string, string> = {
      curl: "#!/bin/sh\necho 'no installer may run for an unselected tool' >&2\nexit 42\n",
      npm: `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(npmMarker)}\nexit 42\n`,
      bun: "#!/bin/sh\nif [ \"$1\" = install ]; then echo 'omp installer must not run' >&2; exit 42; fi\nexit 0\n",
      bunx: "#!/bin/sh\nmkdir -p \"$HOME/.agents/skills/archify\"\nprintf 'archify\\n' > \"$HOME/.agents/skills/archify/SKILL.md\"\n",
      gh: "#!/bin/sh\nif [ \"$1\" = auth ] && [ \"$2\" = status ]; then exit 1; fi\nexit 0\n",
      claude: "#!/bin/sh\nif [ \"$1\" = auth ] && [ \"$2\" = status ]; then exit 1; fi\nexit 0\n",
      rtk: "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HOME/rtk-args\"\nexit 0\n",
    };
    await writeStubs(stubBin, stubs);

    const result = await run(["bash", postCreatePath], home, {
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      AGENT_TOOLS: "claude",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Superpowers setup deferred");
    expect(result.stdout).toContain("deferred for claude");
    expect(result.stdout).not.toContain("deferred for codex");
    expect(result.stdout).toContain("bash .devcontainer/project-adhd/post-create.sh");
    expect(existsSync(npmMarker)).toBe(false);
    expect(await readFile(join(home, ".claude/skills/archify/SKILL.md"), "utf8")).toBe("archify\n");
    expect(existsSync(join(home, ".codex/skills/archify"))).toBe(false);
    expect(existsSync(join(home, ".omp/agent/skills/archify"))).toBe(false);

    const rtkArguments = await readFile(join(home, "rtk-args"), "utf8");
    expect(rtkArguments).toContain("--auto-patch");
    expect(rtkArguments).not.toContain("--codex");
    expect(rtkArguments).not.toContain("--agent pi");
  });
});

test("skips OMP Superpowers when omp is selected without claude", async () => {
  await withTemporaryParent(async (parent) => {
    const { home, stubBin } = await makeHome(parent);

    const stubs: Record<string, string> = {
      curl: "#!/bin/sh\necho 'no installer may run for an unselected tool' >&2\nexit 42\n",
      bun: "#!/bin/sh\nexit 0\n",
      bunx: "#!/bin/sh\nmkdir -p \"$HOME/.agents/skills/archify\"\nprintf 'archify\\n' > \"$HOME/.agents/skills/archify/SKILL.md\"\n",
      gh: "#!/bin/sh\nif [ \"$1\" = auth ] && [ \"$2\" = status ]; then exit 1; fi\nexit 0\n",
      omp: "#!/bin/sh\nexit 0\n",
      rtk: "#!/bin/sh\nexit 0\n",
    };
    await writeStubs(stubBin, stubs);

    const result = await run(["bash", postCreatePath], home, {
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      AGENT_TOOLS: "omp",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Skipping OMP Superpowers: requires claude in AGENT_TOOLS and an authenticated Claude",
    );
    expect(await readFile(join(home, ".omp/agent/skills/archify/SKILL.md"), "utf8")).toBe("archify\n");
    expect(existsSync(join(home, ".claude/skills/archify"))).toBe(false);
  });
});
