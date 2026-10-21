import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CommandResult,
  hostBash,
  makeInstallation,
  makeRepo,
  run,
  withTemporaryParent,
  writeStubs,
} from "./helpers";

const RUNTIME = ".devcontainer/project-adhd";
const INSTANCE = "my-project-1234abcd-9f9f9f9f";
const TARGET = `adhd-${INSTANCE}`;

type Fixture = { checkout: string; root: string; stubBin: string; log: string; state: string };

// Stubs log one line per call to <log>. docker ps prints the ids in
// $DOCKER_PS_IDS; the herdr stub exercises the wrappers it finds on PATH.
async function makeFixture(parent: string): Promise<Fixture> {
  const { checkout } = await makeInstallation(parent);
  const root = join(parent, "project");
  await makeRepo(root);
  await mkdir(join(root, RUNTIME), { recursive: true });
  await writeFile(
    join(root, RUNTIME, ".env"),
    `PROJECT_STATE_PREFIX=my-project-1234abcd\nCOMPOSE_INSTANCE=${INSTANCE}\n` +
      "AGENT_STATE_PREFIX=project-adhd-shared\nWORKSPACE_NAME=project\nHOST_PULSE_DIR=\n",
  );
  const stubBin = join(parent, "stub-bin");
  const log = join(parent, "calls");
  const logLine = (name: string) => `printf '${name}' >> "$CALL_LOG"; printf ' [%s]' "$@" >> "$CALL_LOG"; printf '\\n' >> "$CALL_LOG"`;
  await writeStubs(stubBin, {
    docker: `#!/bin/sh\n${logLine("docker")}\nif [ "$1" = ps ]; then printf '%s' "$DOCKER_PS_IDS"; fi\nif [ "$1" = exec ]; then cat > "$CALL_LOG.stdin"; fi\n`,
    "ssh-keygen": `#!/bin/sh\n${logLine("ssh-keygen")}\nwhile [ "$#" -gt 1 ]; do shift; done\nprintf 'private\\n' > "$1"\nprintf 'ssh-ed25519 AAAA project-adhd-herdr\\n' > "$1.pub"\n`,
    ssh: `#!/bin/sh\n${logLine("ssh")}\n`,
    scp: `#!/bin/sh\n${logLine("scp")}\n`,
    herdr: `#!/bin/sh\n${logLine("herdr")}\nssh -T "$ADHD_HERDR_TARGET" true\nssh -T other-host true\nscp herdr "$ADHD_HERDR_TARGET:.local/bin/herdr"\n`,
  });
  return { checkout, root, stubBin, log, state: join(parent, "state") };
}

function adhdHerdr(fixture: Fixture, args: string[], ids: string): Promise<CommandResult> {
  return run([hostBash, join(fixture.checkout, "bin", "adhd"), "herdr", ...args], fixture.root, {
    PATH: `${fixture.stubBin}:${process.env.PATH ?? ""}`,
    CALL_LOG: fixture.log,
    DOCKER_PS_IDS: ids,
    XDG_STATE_HOME: fixture.state,
  });
}

async function calls(fixture: Fixture, name: string): Promise<string[]> {
  if (!existsSync(fixture.log)) return [];
  return (await readFile(fixture.log, "utf8"))
    .split("\n")
    .filter((line) => line.startsWith(`${name} `));
}

test("Herdr session launcher executes commands in the workspace safely", async () => {
  await withTemporaryParent(async (parent) => {
    const script = join(import.meta.dir, "../libexec/adhd/herdr-bin/session.sh");
    const workspace = join(parent, "repo with spaces; $(touch nope)");
    await mkdir(workspace);
    const launch = (command: string, stdin?: string) =>
      run(["sh", script], parent, {
        ADHD_HERDR_WORKSPACE: workspace,
        SSH_ORIGINAL_COMMAND: command,
      }, stdin);

    const pwd = await launch("pwd -P");
    expect(pwd.exitCode).toBe(0);
    expect(pwd.stdout.trim()).toBe(workspace);

    const piped = await launch("cat", "input through stdin\n");
    expect(piped.exitCode).toBe(0);
    expect(piped.stdout).toBe("input through stdin\n");

    const status = await launch("exit 23");
    expect(status.exitCode).toBe(23);

    const marker = join(parent, "must-not-exist");
    const missing = await run(["sh", script], parent, {
      ADHD_HERDR_WORKSPACE: join(parent, "missing"),
      SSH_ORIGINAL_COMMAND: `touch '${marker}'`,
    });
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain(`unable to enter Herdr workspace: ${join(parent, "missing")}`);
    expect(existsSync(marker)).toBe(false);

    const fakeShell = join(parent, "fake-shell");
    await writeFile(fakeShell, "#!/bin/sh\nprintf 'cwd=%s\\n' \"$PWD\"\nprintf 'arg=%s\\n' \"$1\"\n");
    await chmod(fakeShell, 0o755);
    for (const command of ["", undefined]) {
      const env: Record<string, string> = {
        ADHD_HERDR_WORKSPACE: workspace,
        SHELL: fakeShell,
      };
      if (command !== undefined) env.SSH_ORIGINAL_COMMAND = command;
      const login = await run(["sh", script], parent, env);
      expect(login.exitCode).toBe(0);
      expect(login.stdout).toBe(`cwd=${workspace}\narg=-l\n`);
    }
  });
});

test("herdr prepares the container and attaches Herdr through docker exec", async () => {
  await withTemporaryParent(async (parent) => {
    const fixture = await makeFixture(parent);
    const key = join(fixture.state, "project-adhd", "herdr-remote", "id_ed25519");

    const result = await adhdHerdr(fixture, [".", "--", "--session", "demo"], "c0ffee\n");

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`==> Attaching Herdr to ${INSTANCE}`);
    expect((await calls(fixture, "docker"))[0]).toBe(
      `docker [ps] [-q] [--filter] [label=com.docker.compose.project=${INSTANCE}] [--filter] [label=com.docker.compose.service=workspace]`,
    );
    expect((await calls(fixture, "docker"))[1]).toContain("docker [exec] [-i] [-u] [root] [c0ffee] [sh] [-s]");
    expect(await calls(fixture, "herdr")).toEqual([`herdr [--remote] [${TARGET}] [--session] [demo]`]);

    const proxy =
      `ProxyCommand='${join(fixture.stubBin, "docker")}' exec -i -u root 'c0ffee' ` +
      "/usr/sbin/sshd -i -e -f /etc/project-adhd/herdr_sshd_config";
    const options =
      `[-o] [${proxy}] [-o] [User=vscode] [-o] [IdentityFile="${key}"] [-o] [IdentitiesOnly=yes] ` +
      "[-o] [IdentityAgent=none] [-o] [UserKnownHostsFile=/dev/null] [-o] [StrictHostKeyChecking=no] [-o] [LogLevel=ERROR]";
    expect(await calls(fixture, "ssh")).toEqual([
      `ssh ${options} [-T] [${TARGET}] [true]`,
      "ssh [-T] [other-host] [true]",
    ]);
    expect(await calls(fixture, "scp")).toEqual([
      `scp ${options} [herdr] [${TARGET}:.local/bin/herdr]`,
    ]);

    expect(await calls(fixture, "ssh-keygen")).toHaveLength(1);
    await writeFile(fixture.log, "");
    const again = await adhdHerdr(fixture, [], "c0ffee\n");
    expect(again.exitCode).toBe(0);
    expect(await calls(fixture, "ssh-keygen")).toEqual([]);
  });
});
test("herdr explains when the Dev Container is not running", async () => {
  await withTemporaryParent(async (parent) => {
    const fixture = await makeFixture(parent);

    const result = await adhdHerdr(fixture, [], "");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`no running Dev Container for Compose project ${INSTANCE}`);
    expect(result.stderr).toContain("Reopen in Container");
    expect(result.stderr).toContain("COMPOSE_PROJECT_NAME");
    expect(await calls(fixture, "herdr")).toEqual([]);
  });
});

test("herdr refuses to pick between two running containers", async () => {
  await withTemporaryParent(async (parent) => {
    const fixture = await makeFixture(parent);

    const result = await adhdHerdr(fixture, [], "c0ffee\nbeef00\n");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`more than one running container belongs to Compose project ${INSTANCE}`);
    expect(await calls(fixture, "herdr")).toEqual([]);
  });
});

test("herdr requires a repository with Dev Container state", async () => {
  await withTemporaryParent(async (parent) => {
    const fixture = await makeFixture(parent);
    const bare = join(parent, "unattached");
    await makeRepo(bare);

    const result = await adhdHerdr(fixture, [bare], "c0ffee\n");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("has no Dev Container state");
    expect(await calls(fixture, "docker")).toEqual([]);
  });
});

test("herdr requires a nonempty workspace name before accessing Docker or keys", async () => {
  await withTemporaryParent(async (parent) => {
    const fixture = await makeFixture(parent);
    const envFile = join(fixture.root, RUNTIME, ".env");

    for (const workspaceState of ["", "WORKSPACE_NAME=\n"]) {
      await writeFile(
        envFile,
        `PROJECT_STATE_PREFIX=my-project-1234abcd\nCOMPOSE_INSTANCE=${INSTANCE}\n` +
          `AGENT_STATE_PREFIX=project-adhd-shared\n${workspaceState}HOST_PULSE_DIR=\n`,
      );
      await writeFile(fixture.log, "");
      const result = await adhdHerdr(fixture, [], "c0ffee\n");

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(
        `${fixture.root} has no workspace name in Dev Container state; reopen the repository in its Dev Container to regenerate it`,
      );
      expect(await calls(fixture, "docker")).toEqual([]);
      expect(await calls(fixture, "ssh-keygen")).toEqual([]);
      expect(await calls(fixture, "herdr")).toEqual([]);
    }
  });
});

test("herdr rejects stray arguments before --", async () => {
  await withTemporaryParent(async (parent) => {
    const fixture = await makeFixture(parent);

    const result = await adhdHerdr(fixture, [".", "--session"], "c0ffee\n");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("usage: adhd herdr [dir] [-- <herdr arguments>]");
  });
});
