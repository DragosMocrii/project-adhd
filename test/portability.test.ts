import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "./helpers";

// Every script that runs on the host. Files that do not exist yet are skipped,
// so later tasks are covered as soon as they create their files.
const HOST_SCRIPTS = [
  "install.sh",
  "bin/adhd",
  "libexec/adhd/common.sh",
  "libexec/adhd/attach.sh",
  "libexec/adhd/detach.sh",
  "libexec/adhd/update.sh",
  "libexec/adhd/new.sh",
  ".devcontainer/project-adhd/initialize.sh",
  ".devcontainer/project-adhd/lib/agent-tools.sh",
];

const FORBIDDEN: Array<[RegExp, string]> = [
  [/\b(local|declare|typeset)\s+-[a-zA-Z]*A/, "associative arrays need bash 4"],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*(,,?|\^\^?)\}/, "case modification needs bash 4"],
  [/\b(mapfile|readarray)\b/, "mapfile needs bash 4"],
  [/\|&/, "|& needs bash 4"],
  [/\bsed\s+(-[a-zA-Z]+\s+)*-i\b/, "sed -i differs between GNU and BSD"],
  [/\breadlink\s+-f\b/, "readlink -f is GNU-only"],
  [/\bstat\s+-c\b/, "stat -c is GNU-only"],
  [/\brealpath\b/, "realpath is missing on older macOS"],
];

test("host scripts avoid bash-4-only syntax and GNU-only tools", async () => {
  const violations: string[] = [];
  for (const script of HOST_SCRIPTS) {
    const path = join(repoRoot, script);
    if (!existsSync(path)) continue;
    const lines = (await readFile(path, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (/^\s*#/.test(line)) return;
      for (const [pattern, reason] of FORBIDDEN) {
        if (pattern.test(line)) violations.push(`${script}:${index + 1}: ${reason}: ${line.trim()}`);
      }
    });
  }
  expect(violations).toEqual([]);
});
