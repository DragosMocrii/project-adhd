import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checked,
  headTag,
  hostBash,
  makeInstallation,
  makeRepo,
  publishRelease,
  readChannel,
  repoRoot,
  run,
  setChannel,
  withTemporaryParent,
} from "./helpers";

async function pipedInstall(
  home: string,
  origin: string,
  path = process.env.PATH ?? "",
  env: Record<string, string> = {},
) {
  const script = await readFile(join(repoRoot, "install.sh"), "utf8");
  return run([hostBash], home, { HOME: home, ADHD_REPO: origin, PATH: path, ...env }, script);
}

function shellFunction(source: string, name: string): string {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, "m"));
  if (!match) throw new Error(`${name} not found`);
  return match[0];
}

async function currentBranch(repo: string): Promise<string> {
  const result = await run(["git", "-C", repo, "symbolic-ref", "--short", "HEAD"], repo);
  return result.exitCode === 0 ? result.stdout.trim() : "";
}

test("a piped install clones into ~/.local/share and links adhd", async () => {
  await withTemporaryParent(async (parent) => {
    const { origin } = await makeInstallation(parent);
    const home = join(parent, "home");
    await mkdir(home);

    const result = await pipedInstall(home, origin);

    expect(result.exitCode).toBe(0);
    const installed = join(home, ".local/share/project-adhd");
    expect(existsSync(join(installed, "bin/adhd"))).toBe(true);
    expect(await readlink(join(home, ".local/bin/adhd"))).toBe(join(installed, "bin/adhd"));
    expect(result.stderr).toContain(".local/bin is not on PATH");
  });
});

test("a second install updates in place and keeps the link", async () => {
  await withTemporaryParent(async (parent) => {
    const { origin } = await makeInstallation(parent);
    const home = join(parent, "home");
    await mkdir(home);
    const onPath = `${join(home, ".local/bin")}:${process.env.PATH ?? ""}`;
    expect((await pipedInstall(home, origin, onPath)).exitCode).toBe(0);

    const second = await pipedInstall(home, origin, onPath);

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("Updating");
    expect(second.stderr).not.toContain("not on PATH");
  });
});

test("install refuses to replace an adhd it did not create", async () => {
  await withTemporaryParent(async (parent) => {
    const { origin } = await makeInstallation(parent);
    const home = join(parent, "home");
    await mkdir(join(home, ".local/bin"), { recursive: true });
    await writeFile(join(home, ".local/bin/adhd"), "#!/bin/sh\n");

    const result = await pipedInstall(home, origin);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("already exists and is not a symlink");
    expect(await readFile(join(home, ".local/bin/adhd"), "utf8")).toBe("#!/bin/sh\n");
  });
});

test("running install.sh from a checkout links that checkout without cloning", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const home = join(parent, "home");
    await mkdir(home);

    const result = await run([hostBash, join(checkout, "install.sh")], home, { HOME: home });

    expect(result.exitCode).toBe(0);
    expect(await readlink(join(home, ".local/bin/adhd"))).toBe(join(checkout, "bin/adhd"));
    expect(existsSync(join(home, ".local/share/project-adhd"))).toBe(false);
  });
});

test("install refuses an adhd link that points elsewhere, before cloning", async () => {
  await withTemporaryParent(async (parent) => {
    const { origin } = await makeInstallation(parent);
    const home = join(parent, "home");
    await mkdir(join(home, ".local/bin"), { recursive: true });
    await symlink("/elsewhere/adhd", join(home, ".local/bin/adhd"));

    const result = await pipedInstall(home, origin);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("already points to /elsewhere/adhd");
    expect(await readlink(join(home, ".local/bin/adhd"))).toBe("/elsewhere/adhd");
    expect(existsSync(join(home, ".local/share/project-adhd"))).toBe(false);
  });
});

test("install refuses to pull a Git checkout that is not project-adhd", async () => {
  await withTemporaryParent(async (parent) => {
    const { origin } = await makeInstallation(parent);
    const home = join(parent, "home");
    const foreign = join(home, ".local/share/project-adhd");
    await makeRepo(foreign);

    const result = await pipedInstall(home, origin);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("exists but is not a project-adhd checkout");
    expect(existsSync(join(foreign, "bin/adhd"))).toBe(false);
  });
});

test("a piped install lands on the newest release and records the channel", async () => {
  await withTemporaryParent(async (parent) => {
    const { origin } = await makeInstallation(parent);
    for (const version of ["0.1.0", "0.2.0", "0.10.0", "0.3.0-rc.1"]) {
      await publishRelease(parent, origin, version);
    }
    const home = join(parent, "home");
    await mkdir(home);

    const result = await pipedInstall(home, origin);

    expect(result.exitCode).toBe(0);
    const installed = join(home, ".local/share/project-adhd");
    expect(await headTag(installed)).toBe("v0.10.0");
    expect(await readChannel(installed)).toBe("release");
    expect(await readFile(join(installed, "VERSION"), "utf8")).toBe("0.10.0\n");
  });
});

test("ADHD_REF follows a branch or pins a tag", async () => {
  await withTemporaryParent(async (parent) => {
    const { origin } = await makeInstallation(parent);
    await publishRelease(parent, origin, "0.1.0");
    await publishRelease(parent, origin, "0.2.0");
    const branchHome = join(parent, "branch-home");
    const pinnedHome = join(parent, "pinned-home");
    await mkdir(branchHome);
    await mkdir(pinnedHome);

    expect((await pipedInstall(branchHome, origin, undefined, { ADHD_REF: "main" })).exitCode).toBe(0);
    expect((await pipedInstall(pinnedHome, origin, undefined, { ADHD_REF: "v0.1.0" })).exitCode).toBe(0);

    const branchInstall = join(branchHome, ".local/share/project-adhd");
    expect(await currentBranch(branchInstall)).toBe("main");
    expect(await readChannel(branchInstall)).toBe("main");
    const pinnedInstall = join(pinnedHome, ".local/share/project-adhd");
    expect(await headTag(pinnedInstall)).toBe("v0.1.0");
    expect(await readChannel(pinnedInstall)).toBe("v0.1.0");
  });
});

test("with no release yet, install follows main and warns", async () => {
  await withTemporaryParent(async (parent) => {
    const { origin } = await makeInstallation(parent);
    const home = join(parent, "home");
    await mkdir(home);

    const result = await pipedInstall(home, origin);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("no release found; following main");
    const installed = join(home, ".local/share/project-adhd");
    expect(await currentBranch(installed)).toBe("main");
    expect(await readChannel(installed)).toBe("release");
  });
});

test("with only pre-release tags, install follows main and warns", async () => {
  await withTemporaryParent(async (parent) => {
    const { origin } = await makeInstallation(parent);
    await publishRelease(parent, origin, "0.1.0-rc.1");
    const home = join(parent, "home");
    await mkdir(home);

    const result = await pipedInstall(home, origin);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("no release found; following main");
    expect(await currentBranch(join(home, ".local/share/project-adhd"))).toBe("main");
  });
});

test("rerunning install moves to a newly published release", async () => {
  await withTemporaryParent(async (parent) => {
    const { origin } = await makeInstallation(parent);
    const home = join(parent, "home");
    await mkdir(home);
    expect((await pipedInstall(home, origin)).exitCode).toBe(0);
    await publishRelease(parent, origin, "0.1.0");

    const second = await pipedInstall(home, origin);

    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("Updating");
    expect(await headTag(join(home, ".local/share/project-adhd"))).toBe("v0.1.0");
  });
});

test("an install made before releases migrates on rerun", async () => {
  await withTemporaryParent(async (parent) => {
    const { origin } = await makeInstallation(parent);
    const home = join(parent, "home");
    const installed = join(home, ".local/share/project-adhd");
    await mkdir(join(home, ".local/share"), { recursive: true });
    await checked(["git", "clone", "-q", origin, installed], parent);
    await publishRelease(parent, origin, "0.1.0");

    const result = await pipedInstall(home, origin);

    expect(result.exitCode).toBe(0);
    expect(await headTag(installed)).toBe("v0.1.0");
    expect(await readChannel(installed)).toBe("release");
  });
});

test("install refuses to move an existing install with local changes", async () => {
  await withTemporaryParent(async (parent) => {
    const { origin } = await makeInstallation(parent);
    const home = join(parent, "home");
    await mkdir(home);
    expect((await pipedInstall(home, origin)).exitCode).toBe(0);
    const installed = join(home, ".local/share/project-adhd");
    await writeFile(join(installed, "install.sh"), "# local edit\n");
    await publishRelease(parent, origin, "0.1.0");

    const result = await pipedInstall(home, origin);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("has local changes");
    expect(await readFile(join(installed, "install.sh"), "utf8")).toBe("# local edit\n");
    expect(await currentBranch(installed)).toBe("main");
  });
});

test("install from a checkout marks it as a development checkout once", async () => {
  await withTemporaryParent(async (parent) => {
    const { checkout } = await makeInstallation(parent);
    const home = join(parent, "home");
    await mkdir(home);

    expect((await run([hostBash, join(checkout, "install.sh")], home, { HOME: home })).exitCode).toBe(0);
    expect(await readChannel(checkout)).toBe("checkout");

    await setChannel(checkout, "release");
    expect((await run([hostBash, join(checkout, "install.sh")], home, { HOME: home })).exitCode).toBe(0);
    expect(await readChannel(checkout)).toBe("release");
  });
});

test("install keeps its release helpers identical to adhd's", async () => {
  const installer = await readFile(join(repoRoot, "install.sh"), "utf8");
  const common = await readFile(join(repoRoot, "libexec/adhd/common.sh"), "utf8");
  for (const name of ["latest_release_tag", "move_to_ref"]) {
    expect(shellFunction(installer, name)).toBe(shellFunction(common, name));
  }
});
