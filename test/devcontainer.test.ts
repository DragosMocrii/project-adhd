import { expect, test } from "bun:test";
import { constants, existsSync } from "node:fs";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
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

type Fixture = {
  checkout: string;
  root: string;
  stubBin: string;
  state: string;
  calls: string;
  config: string;
};

async function makeFixture(parent: string, attach = true): Promise<Fixture> {
  const { checkout } = await makeInstallation(parent);
  const root = join(parent, "project with spaces");
  await makeRepo(root);
  if (attach) {
    const attached = await run(
      [hostBash, join(checkout, "bin/adhd"), "attach", root, "--agents", "codex"],
      parent,
    );
    if (attached.exitCode !== 0) throw new Error(`${attached.stdout}${attached.stderr}`);
  }
  const stubBin = join(parent, "stub-bin");
  const state = join(parent, "containers");
  const calls = join(parent, "calls");
  await writeFile(state, "");
  await writeStubs(stubBin, {
    docker: `#!/bin/sh
printf 'docker' >> "$CALLS"; printf ' [%s]' "$@" >> "$CALLS"; printf '\\n' >> "$CALLS"
case "$1" in
  ps)
    [ "\${DOCKER_PS_FAIL:-0}" = 0 ] || exit "\${DOCKER_PS_FAIL}"
    shift
    local_folder= config_file= service=
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --filter ]; then
        shift
        case "$1" in
          label=devcontainer.local_folder=*) local_folder="\${1#label=devcontainer.local_folder=}" ;;
          label=devcontainer.config_file=*) config_file="\${1#label=devcontainer.config_file=}" ;;
          label=com.docker.compose.service=*) service="\${1#label=com.docker.compose.service=}" ;;
        esac
      fi
      shift
    done
    while IFS='|' read -r id root config record_service project running; do
      [ -n "$id" ] || continue
      [ "$root" = "$local_folder" ] || continue
      [ "$config" = "$config_file" ] || continue
      [ "$record_service" = "$service" ] || continue
      printf '%s\\n' "$id"
    done < "$CONTAINERS"
    ;;
  inspect)
    [ "\${DOCKER_INSPECT_FAIL:-0}" = 0 ] || exit "\${DOCKER_INSPECT_FAIL}"
    id=$4
    record=$(awk -F'|' -v id="$id" '$1 == id { print; found=1 } END { if (!found) exit 1 }' "$CONTAINERS") || exit 1
    IFS='|' read -r rid root config service project running <<EOF
$record
EOF
    case "$3" in
      *State.Running*) printf '%s\\n' "$running" ;;
      *Config.Labels*) [ -n "$project" ] || exit 1; printf '%s\\n' "$project" ;;
      *) exit 2 ;;
    esac
    ;;
  stop)
    [ "\${DOCKER_STOP_FAIL:-0}" = 0 ] || exit "\${DOCKER_STOP_FAIL}"
    id=$2
    awk -F'|' -v id="$id" 'BEGIN { OFS="|" } $1 == id { $6="false" } { print }' "$CONTAINERS" > "$CONTAINERS.tmp" && mv "$CONTAINERS.tmp" "$CONTAINERS"
    printf '%s\\n' "$id"
    ;;
esac
`,
    devcontainer: `#!/bin/sh
printf 'devcontainer' >> "$CALLS"; printf ' [%s]' "$@" >> "$CALLS"; printf ' project=%s' "\${COMPOSE_PROJECT_NAME:-}" >> "$CALLS"; printf '\\n' >> "$CALLS"
[ "\${DEVCONTAINER_FAIL:-0}" = 0 ] || exit "\${DEVCONTAINER_FAIL}"
root= config=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --workspace-folder) shift; root=$1 ;;
    --config) shift; config=$1 ;;
  esac
  shift
done
if [ "\${CLI_NO_RECORD:-0}" = 1 ]; then exit 0; fi
id=container-1
project=\${COMPOSE_PROJECT_NAME:-adhd-test-project}
if awk -F'|' -v id="$id" '$1 == id { found=1 } END { exit !found }' "$CONTAINERS"; then
  awk -F'|' -v id="$id" 'BEGIN { OFS="|" } $1 == id { $6="true" } { print }' "$CONTAINERS" > "$CONTAINERS.tmp" && mv "$CONTAINERS.tmp" "$CONTAINERS"
else
  printf '%s|%s|%s|workspace|%s|true\\n' "$id" "$root" "$config" "$project" >> "$CONTAINERS"
fi
`,
  });
  return { checkout, root, stubBin, state, calls, config: join(root, RUNTIME, "devcontainer.json") };
}

function invoke(fixture: Fixture, action: string, extra: string[] = [], env: Record<string, string> = {}): Promise<CommandResult> {
  return run(
    [hostBash, join(fixture.checkout, "bin/adhd"), "devcontainer", action, fixture.root, ...extra],
    fixture.root,
    { PATH: `${fixture.stubBin}:${process.env.PATH ?? ""}`, CONTAINERS: fixture.state, CALLS: fixture.calls, ...env },
  );
}

async function containerState(fixture: Fixture): Promise<string> {
  return (await readFile(fixture.state, "utf8")).trim();
}

async function callLog(fixture: Fixture): Promise<string> {
  return existsSync(fixture.calls) ? readFile(fixture.calls, "utf8") : "";
}

async function makeIsolatedPath(parent: string, dockerStub?: string, tools = [
  "bash",
  "dirname",
  "readlink",
  "git",
  "find",
  "grep",
  "awk",
  "mv",
  "cat",
  "chmod",
  "mkdir",
  "cp",
  "rm",
]): Promise<string> {
  const directory = join(parent, `path-${dockerStub === undefined ? "without" : "with"}-docker`);
  await writeStubs(directory, {});
  for (const tool of tools) {
    let source: string | undefined;
    for (const entry of (process.env.PATH ?? "").split(delimiter)) {
      const candidate = join(entry, tool);
      try {
        await access(candidate, constants.X_OK);
        source = candidate;
        break;
      } catch {}
    }
    if (source === undefined) throw new Error(`missing host test prerequisite: ${tool}`);
    await symlink(source, join(directory, tool));
  }
  if (dockerStub !== undefined) {
    await symlink(join(dockerStub, "docker"), join(directory, "docker"));
  }
  return directory;
}

test("up starts once, then stop retains the container and up resumes it", async () => {
  await withTemporaryParent(async (parent) => {
    const fixture = await makeFixture(parent);
    expect(existsSync(join(fixture.root, RUNTIME, ".env"))).toBe(false);

    const started = await invoke(fixture, "up");
    if (started.exitCode !== 0) throw new Error(`${started.stdout}${started.stderr}\n${await containerState(fixture)}\n${await callLog(fixture)}`);
    expect(started.stdout).toContain("Dev Container is running");
    const firstRecord = await containerState(fixture);
    if (firstRecord !== `container-1|${fixture.root}|${fixture.config}|workspace|adhd-test-project|true`) throw new Error(`record: ${firstRecord}`);

    const repeated = await invoke(fixture, "up");
    expect(repeated.exitCode).toBe(0);
    expect(repeated.stdout).toContain("already running");
    expect((await callLog(fixture)).split("\n").filter((line) => line.startsWith("devcontainer "))).toHaveLength(1);
    expect(await containerState(fixture)).toBe(firstRecord);

    const stopped = await invoke(fixture, "stop");
    expect(stopped.exitCode).toBe(0);
    expect(stopped.stdout).toContain("Dev Container is stopped");
    expect(await containerState(fixture)).toBe(firstRecord.replace(/\|true$/, "|false"));

    const again = await invoke(fixture, "stop");
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("already stopped");

    const resumed = await invoke(fixture, "up");
    expect(resumed.exitCode).toBe(0);
    expect(resumed.stdout).toContain("Dev Container is running");
    expect((await containerState(fixture)).split("|")[0]).toBe("container-1");
    expect((await containerState(fixture)).endsWith("|true")).toBe(true);
    expect(await callLog(fixture)).toContain("devcontainer");
  });
});

test("stop on an attached worktree does not initialize state", async () => {
  await withTemporaryParent(async (parent) => {
    const fixture = await makeFixture(parent);
    const stopped = await invoke(fixture, "stop");
    if (stopped.exitCode !== 0) throw new Error(`${stopped.stdout}${stopped.stderr}`);
    expect(stopped.stdout).toContain("already stopped");
    expect(existsSync(join(fixture.root, RUNTIME, ".env"))).toBe(false);
    expect(await callLog(fixture)).not.toMatch(/^devcontainer /m);
  });
});
test("up resumes the labeled Compose project, regardless of the current override", async () => {
  await withTemporaryParent(async (parent) => {
    const fixture = await makeFixture(parent);
    await writeFile(fixture.state, `container-1|${fixture.root}|${fixture.config}|workspace|original-project|false\n`);

    const resumed = await invoke(fixture, "up", [], { COMPOSE_PROJECT_NAME: "different-project" });

    expect(resumed.exitCode).toBe(0);
    expect(resumed.stdout).toContain("Dev Container is running");
    expect(await containerState(fixture)).toBe(
      `container-1|${fixture.root}|${fixture.config}|workspace|original-project|true`,
    );
    expect(await callLog(fixture)).toContain("project=original-project");
  });
});

test("up and stop reject ambiguity without changing either matching container", async () => {
  await withTemporaryParent(async (parent) => {
    const fixture = await makeFixture(parent);
    const records =
      `first|${fixture.root}|${fixture.config}|workspace|project-a|true\n` +
      `second|${fixture.root}|${fixture.config}|workspace|project-b|false\n`;
    await writeFile(fixture.state, records);

    for (const action of ["up", "stop"]) {
      const result = await invoke(fixture, action);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("more than one Dev Container matches");
      expect(await containerState(fixture)).toBe(records.trim());
    }
  });
});

test("startup failures and missing running postconditions never report success", async () => {
  await withTemporaryParent(async (parent) => {
    const fixture = await makeFixture(parent);

    const failed = await invoke(fixture, "up", [], { DEVCONTAINER_FAIL: "23" });
    expect(failed.exitCode).toBe(23);
    expect(failed.stdout).toContain("Starting Dev Container");
    expect(failed.stdout).not.toContain("is running");

    const missing = await invoke(fixture, "up", [], { CLI_NO_RECORD: "1" });
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("did not reach the running state");
    expect(missing.stdout).not.toContain("is running");
  });
});

test("failed Docker listing, inspection, and stop are errors without false success", async () => {
  await withTemporaryParent(async (parent) => {
    const fixture = await makeFixture(parent);

    const listFailure = await invoke(fixture, "stop", [], { DOCKER_PS_FAIL: "17" });
    expect(listFailure.exitCode).toBe(1);
    expect(listFailure.stderr).toContain("unable to list containers");
    expect(listFailure.stdout).not.toContain("already stopped");

    const started = await invoke(fixture, "up");
    expect(started.exitCode).toBe(0);
    const inspectFailure = await invoke(fixture, "stop", [], { DOCKER_INSPECT_FAIL: "18" });
    expect(inspectFailure.exitCode).toBe(1);
    expect(inspectFailure.stderr).toContain("unable to inspect Dev Container");

    const stopFailure = await invoke(fixture, "stop", [], { DOCKER_STOP_FAIL: "19" });
    if (stopFailure.exitCode !== 19) throw new Error(`status=${stopFailure.exitCode}\n${stopFailure.stdout}\n${stopFailure.stderr}\n${await callLog(fixture)}`);
    expect(stopFailure.stdout).not.toContain("Dev Container is stopped");
    expect((await containerState(fixture)).endsWith("|true")).toBe(true);
  });
});

test("already-running up and stop do not need the Dev Container CLI", async () => {
  await withTemporaryParent(async (parent) => {
    const fixture = await makeFixture(parent);
    expect((await invoke(fixture, "up")).exitCode).toBe(0);
    const dockerOnly = await makeIsolatedPath(parent, fixture.stubBin);
    const env = { PATH: dockerOnly };

    const repeated = await invoke(fixture, "up", [], env);
    expect(repeated.exitCode).toBe(0);
    expect(repeated.stdout).toContain("already running");
    expect((await invoke(fixture, "stop", [], env)).exitCode).toBe(0);

    const missing = await invoke(fixture, "up", [], env);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("devcontainer is required on the host");
  });
});

test("exact workspace and config labels exclude other services and configs", async () => {
  await withTemporaryParent(async (parent) => {
    const fixture = await makeFixture(parent);
    const otherWorktree = join(parent, "other worktree");
    const worktreeAdded = await run(
      ["git", "-C", fixture.root, "worktree", "add", "-b", "other-worktree", otherWorktree],
      parent,
    );
    expect(worktreeAdded.exitCode).toBe(0);
    const attachedWorktree = await run(
      [hostBash, join(fixture.checkout, "bin/adhd"), "attach", otherWorktree, "--agents", "codex"],
      parent,
    );
    expect(attachedWorktree.exitCode).toBe(0);
    const otherRoot = join(parent, "other repository");
    await makeRepo(otherRoot);
    const unrelated =
      `app|${fixture.root}|${fixture.config}|api|app-project|true\n` +
      `other-config|${fixture.root}|${fixture.root}/.devcontainer/other.json|workspace|other-project|true\n` +
      `other-worktree|${otherWorktree}|${join(otherWorktree, RUNTIME, "devcontainer.json")}|workspace|worktree-project|true\n` +
      `other-repo|${otherRoot}|${join(otherRoot, RUNTIME, "devcontainer.json")}|workspace|other-repo-project|true\n`;
    await writeFile(fixture.state, unrelated);

    const started = await invoke(fixture, "up");

    expect(started.exitCode).toBe(0);
    expect(await containerState(fixture)).toBe(
      `${unrelated}container-1|${fixture.root}|${fixture.config}|workspace|adhd-test-project|true`.trim(),
    );
  });
});

test("invalid and unattached roots fail before Docker, while help needs no dependencies", async () => {
  await withTemporaryParent(async (parent) => {
    const fixture = await makeFixture(parent, false);
    const absentConfig = await invoke(fixture, "stop");
    expect(absentConfig.exitCode).not.toBe(0);
    expect(absentConfig.stderr).toContain("run adhd attach");
    expect(await callLog(fixture)).toBe("");

    const helpPath = await makeIsolatedPath(parent, undefined, ["bash", "dirname", "readlink", "cat"]);
    const help = await run(
      [hostBash, join(fixture.checkout, "bin/adhd"), "devcontainer", "up", "--help"],
      fixture.root,
      { PATH: helpPath, CONTAINERS: fixture.state, CALLS: fixture.calls },
    );
    if (help.exitCode !== 0) throw new Error(`${help.stdout}${help.stderr}`);
    expect(help.stdout).toContain("usage: adhd devcontainer");
    expect(await callLog(fixture)).toBe("");
  });
});
test("Docker is required, and invalid actions or roots do not invoke it", async () => {
  await withTemporaryParent(async (parent) => {
    const fixture = await makeFixture(parent);
    const noDockerPath = await makeIsolatedPath(parent);
    const noDocker = await invoke(fixture, "stop", [], { PATH: noDockerPath });
    expect(noDocker.exitCode).not.toBe(0);
    expect(noDocker.stderr).toContain("docker is required on the host");
    expect(await callLog(fixture)).toBe("");

    for (const args of [
      ["devcontainer"],
      ["devcontainer", "--unexpected"],
      ["devcontainer", "restart"],
      ["devcontainer", "up", fixture.root, "--unexpected"],
      ["devcontainer", "up", fixture.root, "extra"],
      ["devcontainer", "stop", join(fixture.root, "nested")],
    ]) {
      const result = await run(
        [hostBash, join(fixture.checkout, "bin/adhd"), ...args],
        fixture.root,
        {
          PATH: noDockerPath,
          CONTAINERS: fixture.state,
          CALLS: fixture.calls,
        },
      );
      expect(result.exitCode).not.toBe(0);
    }
    expect(await callLog(fixture)).toBe("");
  });
});

test("tracked Dev Container config works without an adhd marker", async () => {
  await withTemporaryParent(async (parent) => {
    const fixture = await makeFixture(parent, false);
    await mkdir(join(fixture.root, RUNTIME), { recursive: true });
    await writeFile(fixture.config, "{}\n");
    const added = await run(["git", "add", `${RUNTIME}/devcontainer.json`], fixture.root);
    expect(added.exitCode).toBe(0);
    const committed = await run(["git", "commit", "-m", "track devcontainer config"], fixture.root);
    expect(committed.exitCode).toBe(0);
    expect(existsSync(join(fixture.root, RUNTIME, ".adhd"))).toBe(false);

    const started = await invoke(fixture, "up");

    expect(started.exitCode).toBe(0);
    expect(started.stdout).toContain("Dev Container is running");
  });
});
