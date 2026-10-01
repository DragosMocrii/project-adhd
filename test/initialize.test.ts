import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { checked, CommandResult, hostBash, prepareRepository, run, withTemporaryParent } from "./helpers";

async function runIdentity(command: string[], cwd: string, env: Record<string, string>): Promise<CommandResult> {
  return run(
    ["env", "-i", `PATH=${process.env.PATH!}`, ...Object.entries(env).map(([key, value]) => `${key}=${value}`), ...command],
    cwd,
  );
}

async function runInitializer(root: string): Promise<void> {
  const result = await run([hostBash, join(root, ".devcontainer", "project-adhd", "initialize.sh"), root], root);
  if (result.exitCode !== 0) {
    throw new Error(
      `initializer failed with exit code ${result.exitCode}\n${result.stdout}${result.stderr}`,
    );
  }
}
function identityEnvironment(home: string, globalConfig: string): Record<string, string> {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

async function checkedIdentity(
  command: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<string> {
  const result = await runIdentity(command, cwd, env);
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with exit code ${result.exitCode}\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}

async function removeFixtureIdentity(root: string, env: Record<string, string>): Promise<void> {
  await checkedIdentity(["git", "-C", root, "config", "--local", "--unset-all", "user.name"], root, env);
  await checkedIdentity(["git", "-C", root, "config", "--local", "--unset-all", "user.email"], root, env);
}

async function initializeWithIdentity(
  root: string,
  env: Record<string, string>,
): Promise<CommandResult> {
  return runIdentity([hostBash, join(root, ".devcontainer", "project-adhd", "initialize.sh"), root], root, env);
}

test("pins host-global identity for commits without the host global config", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "identity");
    const hostHome = join(parent, "host-home");
    const containerHome = join(parent, "container-home");
    const globalConfig = join(parent, "host.gitconfig");
    await mkdir(root);
    await mkdir(hostHome);
    await mkdir(containerHome);
    await prepareRepository(root);
    const hostEnv = identityEnvironment(hostHome, globalConfig);
    await removeFixtureIdentity(root, hostEnv);
    const name = "Zoë O'Connor $dev \\ Team";
    const email = "zoe@example.invalid";
    await writeFile(globalConfig, "");
    await checkedIdentity(["git", "config", "--file", globalConfig, "user.name", name], root, hostEnv);
    await checkedIdentity(["git", "config", "--file", globalConfig, "user.email", email], root, hostEnv);

    const initialized = await initializeWithIdentity(root, hostEnv);
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    const containerEnv = identityEnvironment(containerHome, "/dev/null");
    expect((await checkedIdentity(["git", "-C", root, "config", "--worktree", "--get", "user.name"], root, containerEnv)).trim()).toBe(name);
    expect((await checkedIdentity(["git", "-C", root, "config", "--worktree", "--get", "user.email"], root, containerEnv)).trim()).toBe(email);
    await checkedIdentity(
      ["git", "-C", root, "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "--message=identity"],
      root,
      containerEnv,
    );
    expect((await checkedIdentity(["git", "-C", root, "log", "-1", "--format=%an <%ae>%n%cn <%ce>"], root, containerEnv)).trim())
      .toBe(`${name} <${email}>\n${name} <${email}>`);
  });
});

test("pins identity selected by a host conditional include", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "conditional");
    const home = join(parent, "host-home");
    const containerHome = join(parent, "container-home");
    const globalConfig = join(parent, "host.gitconfig");
    const includedConfig = join(parent, "included.gitconfig");
    await mkdir(root);
    await mkdir(home);
    await mkdir(containerHome);
    await prepareRepository(root);
    const hostEnv = identityEnvironment(home, globalConfig);
    await removeFixtureIdentity(root, hostEnv);
    await writeFile(includedConfig, "[user]\n\tname = Conditional Host\n\temail = conditional@example.invalid\n");
    await writeFile(
      globalConfig,
      `[user]\n\tname = Default Host\n\temail = default@example.invalid\n[includeIf "gitdir:${root}/"]\n\tpath = ${includedConfig}\n`,
    );

    const initialized = await initializeWithIdentity(root, hostEnv);
    expect(initialized.exitCode).toBe(0);
    const containerEnv = identityEnvironment(containerHome, "/dev/null");
    expect((await checkedIdentity(["git", "-C", root, "config", "--worktree", "--get", "user.name"], root, containerEnv)).trim())
      .toBe("Conditional Host");
    expect((await checkedIdentity(["git", "-C", root, "config", "--worktree", "--get", "user.email"], root, containerEnv)).trim())
      .toBe("conditional@example.invalid");
  });
});

test("preserves each existing repository identity field and fills the missing field once", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "preserved-identity");
    const home = join(parent, "host-home");
    const globalConfig = join(parent, "host.gitconfig");
    await mkdir(root);
    await mkdir(home);
    await prepareRepository(root);
    const env = identityEnvironment(home, globalConfig);
    await removeFixtureIdentity(root, env);
    await checkedIdentity(["git", "-C", root, "config", "--local", "user.name", "Repository Name"], root, env);
    await writeFile(globalConfig, "[user]\n\tname = Host Name\n\temail = host@example.invalid\n");

    let initialized = await initializeWithIdentity(root, env);
    expect(initialized.exitCode).toBe(0);
    await checkedIdentity(["git", "-C", root, "config", "--local", "user.email", "repository@example.invalid"], root, env);
    await writeFile(globalConfig, "[user]\n\tname = Changed Host\n\temail = changed@example.invalid\n");
    initialized = await initializeWithIdentity(root, env);
    expect(initialized.exitCode).toBe(0);
    expect((await checkedIdentity(["git", "-C", root, "config", "--local", "--get", "user.name"], root, env)).trim()).toBe("Repository Name");
    expect((await checkedIdentity(["git", "-C", root, "config", "--local", "--get", "user.email"], root, env)).trim()).toBe("repository@example.invalid");
  });
});
test("preserves an existing repository email while filling a missing name", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "preserved-email");
    const home = join(parent, "host-home");
    const globalConfig = join(parent, "host.gitconfig");
    await mkdir(root);
    await mkdir(home);
    await prepareRepository(root);
    const env = identityEnvironment(home, globalConfig);
    await removeFixtureIdentity(root, env);
    await checkedIdentity(["git", "-C", root, "config", "--local", "user.email", "repository@example.invalid"], root, env);
    await writeFile(globalConfig, "[user]\n\tname = Host Name\n\temail = host@example.invalid\n");

    const initialized = await initializeWithIdentity(root, env);
    expect(initialized.exitCode).toBe(0);
    expect((await checkedIdentity(["git", "-C", root, "config", "--local", "--get", "user.name"], root, env)).trim())
      .toBe("Host Name");
    expect((await checkedIdentity(["git", "-C", root, "config", "--local", "--get", "user.email"], root, env)).trim())
      .toBe("repository@example.invalid");
  });
});

test("warns and leaves unavailable or explicitly empty identity fields unset", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "partial-identity");
    const home = join(parent, "host-home");
    const globalConfig = join(parent, "host.gitconfig");
    await mkdir(root);
    await mkdir(home);
    await prepareRepository(root);
    const env = identityEnvironment(home, globalConfig);
    await removeFixtureIdentity(root, env);
    await checkedIdentity(["git", "-C", root, "config", "--local", "user.name", ""], root, env);
    await writeFile(globalConfig, "[user]\n\temail = available@example.invalid\n");

    const initialized = await initializeWithIdentity(root, env);
    expect(initialized.exitCode).toBe(0);
    expect(initialized.stderr).toContain("user.name");
    expect(initialized.stderr).toContain("git config --global");
    expect((await checkedIdentity(["git", "-C", root, "config", "--local", "--get", "user.email"], root, env)).trim())
      .toBe("available@example.invalid");
    const missingName = await runIdentity(["git", "-C", root, "config", "--local", "--get", "user.name"], root, env);
    expect(missingName.exitCode).toBe(0);
    expect(missingName.stdout.trim()).toBe("");
  });
});
test("warns for both fields and succeeds when host identity is unavailable", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "no-identity");
    const home = join(parent, "host-home");
    const globalConfig = join(parent, "missing.gitconfig");
    await mkdir(root);
    await mkdir(home);
    await prepareRepository(root);
    const env = identityEnvironment(home, globalConfig);
    await removeFixtureIdentity(root, env);

    const initialized = await initializeWithIdentity(root, env);
    expect(initialized.exitCode).toBe(0);
    expect(initialized.stderr).toContain("user.name");
    expect(initialized.stderr).toContain("user.email");
    for (const key of ["user.name", "user.email"]) {
      const result = await runIdentity(["git", "-C", root, "config", "--local", "--get", key], root, env);
      expect(result.exitCode).toBe(1);
    }
  });
});

test("writes inferred identity to the enabled worktree scope only", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "worktree-main");
    const sibling = join(parent, "worktree-sibling");
    const target = join(parent, "worktree-target");
    const home = join(parent, "host-home");
    const globalConfig = join(parent, "host.gitconfig");
    await mkdir(root);
    await mkdir(home);
    await prepareRepository(root);
    const env = identityEnvironment(home, globalConfig);
    await removeFixtureIdentity(root, env);
    await checkedIdentity(["git", "-C", root, "config", "--local", "extensions.worktreeConfig", "true"], root, env);
    await checkedIdentity(["git", "-C", root, "worktree", "add", sibling, "-b", "feature/sibling"], root, env);
    await checkedIdentity(["git", "-C", root, "worktree", "add", target, "-b", "feature/target"], root, env);
    await checkedIdentity(["git", "-C", sibling, "config", "--worktree", "user.name", "Sibling Identity"], sibling, env);
    await checkedIdentity(["git", "-C", sibling, "config", "--worktree", "user.email", "sibling@example.invalid"], sibling, env);
    await writeFile(globalConfig, "[user]\n\tname = Target Identity\n\temail = target@example.invalid\n");

    const initialized = await initializeWithIdentity(target, env);
    expect(initialized.exitCode).toBe(0);
    expect((await checkedIdentity(["git", "-C", target, "config", "--worktree", "--get", "user.name"], target, env)).trim())
      .toBe("Target Identity");
    const commonName = await runIdentity(["git", "-C", target, "config", "--local", "--get", "user.name"], target, env);
    expect(commonName.exitCode).toBe(1);
    expect((await checkedIdentity(["git", "-C", sibling, "config", "--worktree", "--get", "user.name"], sibling, env)).trim())
      .toBe("Sibling Identity");
  });
});

test("shares inferred identity through local config when worktree config is disabled", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "shared-main");
    const linked = join(parent, "shared-linked");
    const home = join(parent, "host-home");
    const globalConfig = join(parent, "host.gitconfig");
    await mkdir(root);
    await mkdir(home);
    await prepareRepository(root);
    const env = identityEnvironment(home, globalConfig);
    await removeFixtureIdentity(root, env);
    await checkedIdentity(["git", "-C", root, "worktree", "add", linked, "-b", "feature/shared"], root, env);
    await writeFile(globalConfig, "[user]\n\tname = Shared Host\n\temail = shared@example.invalid\n");

    const initialized = await initializeWithIdentity(linked, env);
    expect(initialized.exitCode).toBe(0);
    expect((await checkedIdentity(["git", "-C", root, "config", "--local", "--get", "user.name"], root, env)).trim())
      .toBe("Shared Host");
    expect((await checkedIdentity(["git", "-C", linked, "config", "--local", "--get", "user.email"], linked, env)).trim())
      .toBe("shared@example.invalid");
    const mainInitialized = await initializeWithIdentity(root, env);
    expect(mainInitialized.exitCode).toBe(0);
    expect(await readStatePrefix(linked)).toBe(await readStatePrefix(root));
  });
});

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

async function canonicalGitCommonDirectory(root: string): Promise<string> {
  const reported = (await checked(
    ["git", "-C", root, "rev-parse", "--git-common-dir"],
    root,
  )).trim();
  return realpath(isAbsolute(reported) ? reported : join(root, reported));
}

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
    expect(await readFile(join(root, ".devcontainer", "project-adhd", "devcontainer.env"), "utf8")).toBe("");
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
      [hostBash, join(root, ".devcontainer", "project-adhd", "initialize.sh"), root],
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
  });
});

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

test("rejects a folder name that Compose's .env would mangle", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "price$tag");
    await mkdir(root);
    await prepareRepository(root);

    const initializer = join(root, ".devcontainer", "project-adhd", "initialize.sh");
    const result = await run([hostBash, initializer, root], root);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("the folder name 'price$tag' contains");
  });
});

test("rejects a folder name with a colon, which breaks the Compose bind mount", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "time:stamp");
    await mkdir(root);
    await prepareRepository(root);

    const initializer = join(root, ".devcontainer", "project-adhd", "initialize.sh");
    const result = await run([hostBash, initializer, root], root);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("the folder name 'time:stamp' contains");
    expect(result.stderr).toContain("a colon");
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

test("warns, without failing, when an upstream COMPOSE_PROJECT_NAME may override the Compose project", async () => {
  await withTemporaryParent(async (parent) => {
    const root = join(parent, "upstream-name");
    await mkdir(root);
    await prepareRepository(root);
    const initializer = join(root, ".devcontainer", "project-adhd", "initialize.sh");

    const quiet = await run([hostBash, initializer, root], root);
    expect(quiet.exitCode).toBe(0);
    expect(quiet.stderr).not.toContain("COMPOSE_PROJECT_NAME");

    await writeFile(join(root, ".env"), "OTHER=1\nCOMPOSE_PROJECT_NAME=upstream\n");
    const fromFile = await run([hostBash, initializer, root], root);
    expect(fromFile.exitCode).toBe(0);
    expect(fromFile.stderr).toContain("COMPOSE_PROJECT_NAME is set");
    expect(fromFile.stderr).toContain(join(root, ".env"));

    await rm(join(root, ".env"));
    const fromEnvironment = await run([hostBash, initializer, root], root, { COMPOSE_PROJECT_NAME: "upstream" });
    expect(fromEnvironment.exitCode).toBe(0);
    expect(fromEnvironment.stderr).toContain("COMPOSE_PROJECT_NAME is set (in the environment)");
  });
});
