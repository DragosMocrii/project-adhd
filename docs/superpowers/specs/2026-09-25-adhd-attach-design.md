# adhd attach — design

Date: 2026-09-25
Status: draft, awaiting review
Scope: spec 1 of 2. Spec 2 (automatic per-repo toolchains via mise) is out of
scope here and builds on this one.

## 1. Intent

**Outcome.** A developer clones any existing GitHub repository — typically an
open-source project they want to contribute to — and attaches their
project-adhd environment to it in one command, then works in a Dev Container
with their agent CLIs, RTK, and Superpowers ready.

**Success criteria.**

1. From `git clone` to a working agent in the container in about two commands.
2. After attaching, `git status` in the target repository is clean. Nothing
   project-adhd creates can land in an upstream pull request.
3. Credentials and plugins are authenticated once and reused by every attached
   repository.
4. Attaching works when upstream already ships its own `.devcontainer/`.
5. Linux and macOS hosts are both supported.

**Decisions taken during brainstorming.**

- Attach by copying into the clone (approach A). Rejected: out-of-tree config
  via `dev.containers.repositoryConfigurationPaths` (B), one long-lived
  container holding all clones (C), a published Dev Container Feature (D, a
  possible later project).
- Share agent state across repositories; keep history separated by per-repo
  workspace path, and keep RTK analytics per repository.
- The GitHub "Use this template" flow is replaced by `adhd new`.
- Each attached repository runs in its own container; several can run at once.

**Non-goals.**

- Installing language toolchains other than Bun, Node, and `python3` (spec 2).
- Reusing an upstream repository's own devcontainer configuration.
- Native Windows, Podman, or rootless Docker hosts.
- Forking on the user's behalf. `gh pr create` already offers to fork.

## 2. User flow

```bash
# once per host
curl -fsSL https://raw.githubusercontent.com/DragosMocrii/project-adhd/main/install.sh | bash

# per repository
adhd attach facebook/react --agents claude,codex
code react        # Dev Containers: Reopen in Container
```

The first attached repository asks for the usual logins (`gh`, `claude`,
`codex`, …) followed by `bash .devcontainer/project-adhd/post-create.sh`.
Every later repository finds them already present in the shared volumes.

Starting a new project instead:

```bash
adhd new my-project --agents claude
```

## 3. Repository layout (after this change)

```
bin/adhd                        host CLI
install.sh                      host installer
package.json bun.lock tsconfig.json
test/                           contract suite (moved from .devcontainer/test)
.devcontainer/project-adhd/     runtime folder — the only thing attach copies
  devcontainer.json
  devcontainer-lock.json
  docker-compose.yml
  initialize.sh
  post-create.sh
  verify.sh
  devcontainer.env.example
  lib/
  .gitignore                    tracked-mode rules (see §5.3)
.omp/lsp.json                   repointed at the root node_modules
.github/workflows/ci.yml
```

The repository root now belongs to the tool itself. The rule "the root belongs
to the adopted project" in `AGENTS.md` and `README.md` is removed.

This repository dogfoods its own runtime folder in tracked mode.

**Runtime manifest.** The list of runtime files is defined once, as an array in
`bin/adhd`. A contract test asserts that it matches the tracked contents of
`.devcontainer/project-adhd/` other than `.gitignore` (which `attach`
generates per mode), so a new runtime file cannot be forgotten.

`updateContentCommand` is removed. It ran `bun install` for the template's own
test dependencies, and in an attached repository it would run against the
upstream project's `package.json`, which may be managed by npm, yarn, or pnpm.
Contributors to project-adhd run `bun install` at the root themselves.

## 4. Container configuration

### 4.1 `devcontainer.json`

| Field | Value |
|---|---|
| `dockerComposeFile` | `docker-compose.yml` |
| `workspaceFolder` | `/workspaces/${localWorkspaceFolderBasename}` |
| `initializeCommand` | `bash "${localWorkspaceFolder}/.devcontainer/project-adhd/initialize.sh" "${localWorkspaceFolder}"` |
| `postCreateCommand` | `bash .devcontainer/project-adhd/post-create.sh` |
| `updateContentCommand` | removed |

Everything else (features, extensions, `containerEnv` including
`NO_BROWSER=true`, `remoteEnv`) is unchanged.

The workspace path must be derivable before `initializeCommand` runs, because
the Dev Containers extension reads `devcontainer.json` first. It therefore uses
the folder basename, not a hash. Two clones with the same basename opened at
the same time share one agent-history namespace. Their histories merge; nothing
is lost. This is documented rather than prevented.

### 4.2 `docker-compose.yml`

```yaml
name: "${COMPOSE_INSTANCE}"

services:
  workspace:
    image: mcr.microsoft.com/devcontainers/base@sha256:d94c97dd…   # unchanged
    env_file: devcontainer.env
    command: sleep infinity
    volumes:
      - claude-state:/home/vscode/.claude
      - github-state:/home/vscode/.config/gh
      - rtk-config-state:/home/vscode/.config/rtk
      - rtk-data-state:/home/vscode/.local/share/rtk
      - codex-state:/home/vscode/.codex
      - gemini-state:/home/vscode/.gemini
      - omp-state:/home/vscode/.omp
      - lock-state:/home/vscode/.local/state/project-adhd
      - ../..:/workspaces/${WORKSPACE_NAME}:cached

volumes:
  claude-state:     { name: "${AGENT_STATE_PREFIX}-claude" }
  github-state:     { name: "${AGENT_STATE_PREFIX}-gh" }
  rtk-config-state: { name: "${AGENT_STATE_PREFIX}-rtk-config" }
  rtk-data-state:   { name: "${PROJECT_STATE_PREFIX}-rtk-data" }
  codex-state:      { name: "${AGENT_STATE_PREFIX}-codex" }
  gemini-state:     { name: "${AGENT_STATE_PREFIX}-gemini" }
  omp-state:        { name: "${AGENT_STATE_PREFIX}-omp" }
  lock-state:       { name: "${AGENT_STATE_PREFIX}-lock" }
```

The lock volume is keyed by `AGENT_STATE_PREFIX` so that it always pairs with
the state it guards.

**User customisation.** Instead of a separate `local/` override folder
(considered during brainstorming), users edit the runtime files directly —
for example adding a Feature to `devcontainer.json` or a sidecar service to
`docker-compose.yml`. `attach` detects edited files by checksum and never
overwrites them (§5.3).

## 5. Host scripts

All host scripts (`install.sh`, `bin/adhd`, `initialize.sh`, and the parts of
`lib/agent-tools.sh` that `adhd` sources) follow the portability rules in §8.

### 5.1 `initialize.sh`

- Locates its own directory from `BASH_SOURCE` instead of assuming
  `$repo_root/.devcontainer`. The "missing .devcontainer directory" check
  becomes a check that the script's directory is inside the repository.
- Keeps today's prefix algorithm, the canonical prefix file
  `<git-common-dir>/.agentic-bun-devcontainer-prefix` (name and format
  unchanged), and the conflict and malformed-file handling.
- Reads `AGENT_STATE_SCOPE` from `devcontainer.env` if present. Valid values:
  `shared` (default when unset or empty) and `project`. Any other value fails.
- Writes `.devcontainer/project-adhd/.env` with exactly four keys, in this
  order:

  | Key | Value | Stable across |
  |---|---|---|
  | `PROJECT_STATE_PREFIX` | `<slug>-<8 hex of git common dir>` (preserved as today) | worktrees, moves |
  | `COMPOSE_INSTANCE` | `<PROJECT_STATE_PREFIX>-<8 hex of canonical worktree root>` | nothing — one per worktree |
  | `AGENT_STATE_PREFIX` | `project-adhd-shared`, or `PROJECT_STATE_PREFIX` when scope is `project` | — |
  | `WORKSPACE_NAME` | basename of the worktree root, unmodified | — |

  Only `PROJECT_STATE_PREFIX` is read back and preserved. The other three keys
  are recomputed on every run. `read_valid_prefix` changes from "exactly one
  line" to "the four expected keys, in order, with a valid prefix".

`COMPOSE_INSTANCE` fixes an existing defect: today linked worktrees share one
Compose project name, so opening two of them at once makes the second
`docker compose up` recreate the first's container.

### 5.2 `install.sh`

- `ADHD_HOME` defaults to `~/.local/share/project-adhd`.
- When run as a file inside a project-adhd checkout, uses that checkout as
  `ADHD_HOME` (for contributors). When piped from `curl`, clones
  `${ADHD_REPO:-https://github.com/DragosMocrii/project-adhd.git}` at
  `${ADHD_REF:-main}` into `ADHD_HOME`, or fast-forwards an existing checkout.
- Links `~/.local/bin/adhd` to `$ADHD_HOME/bin/adhd`. Refuses to replace an
  existing `~/.local/bin/adhd` that is not already that symlink.
- Warns, without failing, when `~/.local/bin` is not on `PATH` (printing the
  line to add to `~/.zprofile` or `~/.bashrc`), and when `docker` or `gh` is
  missing.
- Requires `git` and `bash`; fails without them.

### 5.3 `bin/adhd`

`adhd` resolves its own location through the symlink with a `readlink` loop
(no `readlink -f`), and sources `lib/agent-tools.sh` for `--agents` validation.

**Marker file.** Every attached copy contains
`.devcontainer/project-adhd/.adhd`:

```
mode=untracked
source=<ADHD_HOME commit sha>
sha:devcontainer.json=<sha256>
sha:docker-compose.yml=<sha256>
…one line per runtime file…
```

The checksums record what `attach` last wrote, so a later refresh can tell
whether the user edited a file.

#### `adhd attach <dir | owner/repo | url> [--agents <list>] [--track]`

1. **Resolve the target.** An existing directory is used as given. Otherwise
   the argument must look like `owner/repo`, an `https://github.com/…` URL, or
   a `git@github.com:…` URL; `adhd` runs `gh repo clone <arg>` in the current
   directory and uses the resulting directory. It fails if that directory
   already exists.
2. **Check the target** (errors in §6): it is a worktree root; an existing
   `.devcontainer/project-adhd/` carries a `.adhd` marker; the requested mode
   matches the recorded mode; untracked mode is not requested over files git
   already tracks.
3. **Copy the runtime manifest** into `.devcontainer/project-adhd/`. On a
   refresh, a file whose current checksum differs from the marker's is left
   in place, the new version is written beside it as `<file>.adhd-new`, and a
   warning names it. Runtime files dropped from the manifest are removed if
   unmodified.
4. **Write ignore rules.**
   - Untracked (default): the folder's `.gitignore` is replaced with a single
     `*`. A block delimited by `# >>> project-adhd` / `# <<< project-adhd` is
     written to `<git-common-dir>/info/exclude` (replaced if present) with:
     `/.worktrees/`, `/.claude/worktrees/`, `/.superpowers/`,
     `/docs/superpowers/`.
   - Tracked (`--track`): the folder's `.gitignore` lists `.env`,
     `devcontainer.env`, and `*.adhd-new`. The `.adhd` marker is committed, so
     a fresh clone of the project can be refreshed with `adhd attach`. The same
     delimited block is written to the repository's root `.gitignore`.
5. **Create `devcontainer.env`** from `devcontainer.env.example` if it does not
   exist, setting `AGENT_TOOLS` from `--agents`; otherwise from an interactive
   prompt when stdin is a terminal; otherwise to all four tools. An existing
   `devcontainer.env` is never modified.
6. **Write the marker** and print the next steps.

In a linked worktree, untracked files are not copied by `git worktree add`, so
the user runs `adhd attach .` in each worktree. The exclude block lives in the
shared Git common directory and is written once.

#### `adhd detach [dir]`

Removes `.devcontainer/project-adhd/` (only when the `.adhd` marker is
present), removes `.devcontainer/` if that leaves it empty, and removes the
delimited block from `info/exclude` (untracked) or the root `.gitignore`
(tracked). It does not touch Docker volumes; it prints the command to list
them. The prefix file in the Git common directory is left in place so that a
later re-attach reuses the same per-repository volumes.

#### `adhd update`

Runs `git -C "$ADHD_HOME" pull --ff-only` and reminds the user to rerun
`adhd attach` in each attached repository.

#### `adhd new <name> [--public] [--agents <list>]`

Runs `gh repo create <name> --private --clone` (`--public` when given), then
`adhd attach --track` on the new directory (the basename of `<name>`, so
`org/name` works). It does not commit or push; it prints the suggested first
commit.

### 5.4 `lib/agent-tools.sh`

Rewritten so it runs under bash 3.2: lowercase via `tr`, duplicate removal
with an indexed array instead of `local -A`. Its behaviour and error messages
are unchanged. It stays the single `AGENT_TOOLS` parser for `post-create.sh`,
`verify.sh`, and `adhd`.

## 6. Error handling

`adhd` fails with a specific message, and changes nothing, when:

| Condition | Message points to |
|---|---|
| Target is not a Git worktree root | the worktree root, if inside one |
| `.devcontainer/project-adhd/` exists without a `.adhd` marker | it belongs to someone else |
| Untracked mode requested but git tracks files in that folder | `--track` |
| Requested mode differs from the recorded mode | `adhd detach` first |
| Clone or `new` needed but `gh` is missing or unauthenticated on the host | `gh auth login` |
| Unknown tool in `--agents` | the valid tool list (from `agent-tools.sh`) |
| Target directory for a clone already exists | `adhd attach <that dir>` |

`initialize.sh` additionally fails on an invalid `AGENT_STATE_SCOPE`.

## 7. Concurrency (`post-create.sh`)

`configure_rtk`, `configure_superpowers`, and `install_archify` change shared
state, and run while holding an exclusive `flock` on
`~/.local/state/project-adhd/post-create.lock`. If the lock is not immediately
free, the script prints `==> Waiting for another project-adhd setup to finish`
and waits up to 600 seconds, then fails with a message naming the lock file.
Binary installation stays outside the lock, because each container has its
own binaries. The lock directory is added to `STATE_ROOTS` for ownership
repair. `flock` is from util-linux in the Debian base image; it only ever runs
inside the container.

The deferred-setup hint and every other in-script path reference change to
`.devcontainer/project-adhd/…`. `verify.sh` changes only in such path strings.

## 8. Host platforms

**Supported:** Linux (Docker Engine) and macOS (Docker Desktop, OrbStack,
Colima), on amd64 and arm64. The pinned base-image digest is a multi-platform
index with `linux/amd64` and `linux/arm64` manifests, so Apple Silicon runs
natively.

**Portability rules for host scripts:**

- bash 3.2: no associative arrays, no `${var,,}`, no `mapfile`, no `|&`.
- No `sed -i` (write a temp file and `mv`), no `stat -c`, no `readlink -f`,
  no `realpath`; resolve paths with `cd -P` and `pwd -P`.
- Hash with `sha256sum`, falling back to `shasum -a 256`, as `initialize.sh`
  already does.

Container-side scripts (`post-create.sh`, `verify.sh`) always run on Debian
and keep using bash 4+ and GNU tools.

**Known caveats:**

- Bind mounts through Docker's VM on macOS are slower than on Linux.
- On Linux hosts whose UID is not 1000, the Dev Containers extension's
  `updateRemoteUserUID` is relied on to align file ownership.

## 9. Testing

The contract suite keeps its approach — stub commands on `PATH`, a temporary
`HOME`, no network. The existing `scaffold.test.ts` is split by where the code
runs:

- `test/initialize.test.ts` (host): today's initializer tests, adapted to the
  new path, plus: the four keys are written in order; `COMPOSE_INSTANCE`
  differs between two worktrees of one repository while `PROJECT_STATE_PREFIX`
  matches; `AGENT_STATE_SCOPE=project` makes `AGENT_STATE_PREFIX` equal the
  project prefix; an invalid scope fails; `WORKSPACE_NAME` keeps spaces
  unmodified.
- `test/adhd.test.ts` (host), using real `git` and a stub `gh`:
  - after an untracked attach, `git status --porcelain` is empty;
  - after detach, the working tree and `info/exclude` match their state before
    attach;
  - a refresh preserves `devcontainer.env`, and writes `<file>.adhd-new` for a
    user-edited runtime file without modifying it;
  - `--track` produces the tracked `.gitignore` and root-`.gitignore` block;
  - `owner/repo` invokes `gh repo clone`; `new` invokes `gh repo create` with
    `--private` unless `--public` is given;
  - every row of the §6 table has a test;
  - the runtime manifest matches the tracked contents of the runtime folder.
- `test/install.test.ts` (host): fresh install links `adhd`; a second run is a
  no-op; a foreign `~/.local/bin/adhd` is refused; the `PATH` warning appears.
- `test/post-create.test.ts` (container): today's post-create tests, plus a
  second run waits on a held lock and a run past the timeout fails.
- `test/parsers.test.ts`, `test/agent-tools.test.ts`: moved unchanged.
- Existing configuration assertions (`NO_BROWSER=true`, pinned image, volume
  names) are updated to the new files and names.

Host tests run bash through `ADHD_TEST_BASH` (default `bash`).

**CI.**

- The existing Linux job runs the whole suite and the typecheck from the root.
- A new `macos-latest` job runs the host tests with `ADHD_TEST_BASH=/bin/bash`
  (bash 3.2).
- ShellCheck covers `install.sh`, `bin/adhd`, and every script in the runtime
  folder.

## 10. Documentation

- `README.md`: rewritten around `install.sh`, `adhd attach`, and `adhd new`.
  Keeps the setup order (choose tools, open, authenticate, rerun post-create,
  verify), the state-volume table (now split into shared and per-repository),
  the concurrent-use notes (one container per repository; the same-basename
  history merge), and the Compose-from-inside-the-container guidance, updated
  for `/workspaces/<name>`.
- `AGENTS.md`: new layout; verification commands run from the root; the
  ShellCheck list.
- `SECURITY.md`: the `curl | bash` installer and what it runs; shared state
  means code in any attached repository can read every repository's agent
  credentials and histories; for untrusted repositories, the host Docker
  socket is the larger exposure.

## 11. Migration

- Projects generated from the old template are unaffected: they hold their own
  copy.
- This repository's own container moves to the new layout and volume names.
  After merging, rebuild and authenticate once, or copy each old volume into
  its new name:

  ```bash
  docker run --rm -v project-adhd-<id>-claude:/from -v project-adhd-shared-claude:/to \
    alpine sh -c 'cp -a /from/. /to/'
  ```

  README documents this for all six shared volumes.
- The GitHub repository's "Template repository" setting is turned off by the
  maintainer after release; this is a manual step outside the code.

## 12. To verify during implementation

Each of these either gets confirmed, or changes the design before merge:

1. The Dev Containers extension discovers `.devcontainer/project-adhd/devcontainer.json`
   when no root config exists, and offers a choice when upstream ships
   `.devcontainer/devcontainer.json` or `.devcontainer.json`.
   Pending — host verification (plan Task 14, Steps 2–5); cannot run inside the Dev Container.
2. `${localWorkspaceFolderBasename}` is substituted in `workspaceFolder` for
   Compose-based configurations.
   Pending — host verification (plan Task 14, Steps 2–5); cannot run inside the Dev Container.
3. Compose's `.env` parsing keeps a `WORKSPACE_NAME` containing spaces intact.
   Verified 2026-09-26: test/config.test.ts renders /workspaces/My Project from .env beside the compose file.
4. RTK's installer supports linux/arm64.
   Verified 2026-09-26: v0.50.0 release contains rtk-aarch64-unknown-linux-gnu.tar.gz asset.
5. `updateRemoteUserUID` applies to this Compose configuration on a Linux host
   with a UID other than 1000.
   Pending — host verification (plan Task 14, Steps 2–5); cannot run inside the Dev Container.
