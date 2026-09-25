import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostBash, makeInstallation, repoRoot, run, withTemporaryParent } from "./helpers";

async function pipedInstall(home: string, origin: string, path = process.env.PATH ?? "") {
  const script = await readFile(join(repoRoot, "install.sh"), "utf8");
  return run([hostBash], home, { HOME: home, ADHD_REPO: origin, PATH: path }, script);
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
