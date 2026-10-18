import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

test("herdr prepares the container and attaches Herdr through docker exec", async () => {
  await withTemporaryParent(async (parent) => {
    const fixture = await makeFixture(parent);
    const key = join(fixture.state, "project-adhd", "herdr-remote", "id_ed25519");

    const result = await adhdHerdr(fixture, [".", "--", "--session", "demo"], "c0ffee\n");

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`==> Attaching Herdr to ${INSTANCE}`);
    expect(await calls(fixture, "docker")).toEqual([
      `docker [ps] [-q] [--filter] [label=com.docker.compose.project=${INSTANCE}] [--filter] [label=com.docker.compose.service=workspace]`,
      "docker [exec] [-i] [-u] [root] [c0ffee] [sh] [-s] [ssh-ed25519 AAAA project-adhd-herdr] [vscode]",
    ]);
    expect(await readFile(`${fixture.log}.stdin`, "utf8")).toBe(
      await readFile(join(fixture.checkout, "libexec/adhd/herdr-bin/prepare.sh"), "utf8"),
    );
    expect(await calls(fixture, "herdr")).toEqual([`herdr [--remote] [${TARGET}] [--session] [demo]`]);

    const proxy =
      `ProxyCommand='${join(fixture.stubBin, "docker")}' exec -i -u root 'c0ffee' ` +
      "/usr/sbin/sshd -i -e -f /etc/project-adhd/herdr_sshd_config";
    const options =
      `[-o] [${proxy}] [-o] [User=vscode] [-o] [IdentityFile="${key}"] [-o] [IdentitiesOnly=yes] ` +
      "[-o] [IdentityAgent=none] [-o] [UserKnownHostsFile=/dev/null] [-o] [StrictHostKeyChecking=no] [-o] [LogLevel=ERROR]";
    expect(await calls(fixture, "ssh")).toEqual([
      `ssh ${options} [-T] [${TARGET}] [true]`,
      // Herdr's other machines are left to plain ssh.
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

test("herdr rejects stray arguments before --", async () => {
  await withTemporaryParent(async (parent) => {
    const fixture = await makeFixture(parent);

    const result = await adhdHerdr(fixture, [".", "--session"], "c0ffee\n");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("usage: adhd herdr [dir] [-- <herdr arguments>]");
  });
});
