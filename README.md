# project-adhd

An agentic Dev Container you attach to any Git repository. It installs your
choice of agent CLIs, wires them to the RTK token-optimizing proxy and the
Superpowers plugin, and keeps logins and plugins in Docker volumes shared by
every repository you attach it to — so you authenticate once, not once per
project.

**What you get**

- `adhd`, a small host CLI: `attach`, `detach`, `update`, `new`.
- A digest-pinned Dev Container with Bun, Node, `python3`, and the GitHub CLI.
- Your choice of Claude Code, Codex, Gemini CLI, and OMP — see `AGENT_TOOLS`.
- RTK configured as a hook for each selected agent.
- The Superpowers plugin and the Archify skill installed per agent.
- One container per repository (and per worktree); several can run at once.
- Nothing committed to the repository you attach to.

## Install

Your host needs Docker, VS Code with the Dev Containers extension, `git`,
`bash`, and the GitHub CLI (`gh auth login`) for cloning and creating
repositories. Linux and macOS are supported.

```bash
curl -fsSL https://raw.githubusercontent.com/DragosMocrii/project-adhd/main/install.sh | bash
```

This clones project-adhd into `~/.local/share/project-adhd` and links
`~/.local/bin/adhd`. If `~/.local/bin` is not on your `PATH`, the installer
prints the line to add. Running it again updates the installation. From a
checkout of this repository, `./install.sh` links that checkout instead.

## Attach to a repository

```bash
adhd attach facebook/react --agents claude,codex   # clones with gh, then attaches
adhd attach ~/src/existing-clone                   # or attach a clone you already have
```

Then open the repository in VS Code and run **Dev Containers: Reopen in
Container**. If the repository ships its own `.devcontainer/`, VS Code asks
which configuration to open; pick `project-adhd`.

The first time on a host, authenticate inside the container, then finish
setup:

```bash
gh auth login        # always
claude auth login    # if claude is in AGENT_TOOLS
codex login          # if codex is in AGENT_TOOLS
gemini               # start once and sign in, if gemini is in AGENT_TOOLS
bash .devcontainer/project-adhd/post-create.sh
.devcontainer/project-adhd/verify.sh
```

Every repository you attach afterwards finds those logins already in place.
`verify.sh` reports `SKIP` for unselected tools and a failure for a selected
tool that is not configured yet.

**What `attach` writes.** Everything lives in
`.devcontainer/project-adhd/`, which contains a `.gitignore` of `*` so git
never sees it. It also adds a marked block to `.git/info/exclude` covering the
directories agents create at the repository root (`.worktrees/`,
`.claude/worktrees/`, `.superpowers/`, `docs/superpowers/`). `git status`
stays clean.

**Worktrees.** `git worktree add` does not copy untracked files, so run
`adhd attach .` inside each new worktree. Each worktree gets its own
container.

## Start a new project

```bash
adhd new my-project --agents claude    # private; add --public for a public repository
```

This creates the repository with `gh`, clones it, and attaches project-adhd
in tracked mode (`--track`): `.devcontainer/project-adhd/` becomes part of the
repository, with only its local files (`.env`, `devcontainer.env`) ignored.
Nothing is committed for you.

## Choosing your agent tools

`AGENT_TOOLS` in `.devcontainer/project-adhd/devcontainer.env` controls which
agent CLIs are installed and verified. `adhd attach --agents` sets it; without
the flag, `attach` asks, or selects all four when it cannot ask.

```bash
AGENT_TOOLS=claude          # Claude Code only
AGENT_TOOLS=claude,codex    # Claude Code and Codex
```

Empty selects all four; an unrecognized value fails the run. `rtk` and the
GitHub CLI are always installed. Changing it later requires **Dev Containers:
Rebuild Container**, then `bash .devcontainer/project-adhd/post-create.sh`.

- **OMP Superpowers requires Claude.** OMP sources the Superpowers package from
  Claude's installed plugin, so `omp` needs `claude` selected and
  authenticated; otherwise its Superpowers step is skipped with a message.
- **Gemini CLI has no RTK integration** and no Archify destination today.

## State and isolation

| Volume | Scope |
|---|---|
| `project-adhd-shared-claude`, `-gh`, `-codex`, `-gemini`, `-omp`, `-rtk-config` | shared by every attached repository |
| `project-adhd-shared-lock` | shared; serializes concurrent first-time setup |
| `<project-prefix>-rtk-data` | this repository only |

Agent histories stay separate because each repository is mounted at its own
path, `/workspaces/<folder-name>`. Two clones with the same folder name open
at the same time share a history namespace; their histories merge, and
nothing is lost.

To keep a repository's agent state private — separate logins included — set
`AGENT_STATE_SCOPE=project` in its `devcontainer.env` and rebuild.

Tool binaries are reinstalled on rebuild; logins, plugins, and histories stay
in the volumes. Deleting `.devcontainer/project-adhd/.env` or
`devcontainer.env` does not remove any volume.

## Updating and customizing

```bash
adhd update              # pull the latest project-adhd
adhd attach <dir>        # refresh an attached repository
```

You can edit an attached repository's runtime files — for example add a Dev
Container Feature for a toolchain to `devcontainer.json`:

```json
"ghcr.io/devcontainers/features/go:1": {}
```

`attach` never overwrites a file you edited. It writes the new version beside
it as `<file>.adhd-new` and warns, so you can merge by hand.

## Detaching

```bash
adhd detach [dir]
```

Removes `.devcontainer/project-adhd/` (including its `devcontainer.env`) and
the ignore block. Docker volumes are kept; the command prints how to list
them.

## Compose projects launched from the Dev Container

The Docker daemon used from inside the container runs on the host, so any
bind source in a Compose project you start from inside must be a host path.
Do not use a container path such as `/workspaces/<name>` as a bind source.

`LOCAL_WORKSPACE_FOLDER` is the host path of the folder VS Code opened. For a
linked worktree, that is the worktree's own host path.

## Migrating from the template layout

Projects generated from the old GitHub template keep working as they are.
To move a project's existing logins into the shared volumes, copy each one
(`<old-prefix>` is the `PROJECT_STATE_PREFIX` from its old
`.devcontainer/.env`):

```bash
old=<old-prefix>
for v in claude gh rtk-config codex gemini omp; do
  docker volume create "project-adhd-shared-$v" >/dev/null
  docker run --rm -v "$old-$v:/from:ro" -v "project-adhd-shared-$v:/to" \
    mcr.microsoft.com/devcontainers/base@sha256:d94c97dd9cacf183d0a6fd12a8e87b526e9e928307674ae9c94139139c0c6eae \
    sh -c 'cp -a /from/. /to/'
done
```

`<old-prefix>-rtk-data` keeps its name and needs no copy.

## Security

`post-create.sh` fetches and executes vendor installers, the installer is
meant to be piped to `bash`, attached repositories share agent credentials,
and the container can reach the host Docker daemon. See
[SECURITY.md](SECURITY.md) before using this with code you do not trust.

## Contributing to project-adhd

```bash
bun install
bun test
bun run typecheck
shellcheck install.sh bin/adhd libexec/adhd/*.sh .devcontainer/project-adhd/*.sh .devcontainer/project-adhd/lib/agent-tools.sh
```
