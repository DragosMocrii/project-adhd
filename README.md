# project-adhd

<p align="center">
  <img src="assets/mascot.jpg" alt="project-adhd mascot" width="180">
</p>

An agentic Dev Container you attach to any Git repository. It installs your
choice of agent CLIs, wires supported agents to the RTK token-optimizing proxy
and Superpowers plugin, and keeps supported credentials and settings in Docker
volumes shared by every repository you attach it to.

**What you get**

- `adhd`, a small host CLI: `attach`, `detach`, `refresh`, `update`, `new`,
  `herdr`, `devcontainer`, `version`.
- A digest-pinned Dev Container with Bun, Node, `python3`, and the GitHub CLI.
- Your choice of Claude Code, Codex, OMP, and the Antigravity CLI (`agy`) —
  see `AGENT_TOOLS`.
- RTK configured for supported selected agents.
- [Herdr](https://herdr.dev), with sound notifications on your host by running
  its client locally — see [Herdr on the host](#herdr-on-the-host).
- The Superpowers plugin and the Archify skill installed for supported agents.
- One container per repository (and per worktree); several can run at once.
- Nothing committed to the repository you attach to.

## Install

Your host needs Docker, VS Code with the Dev Containers extension, `git`,
`bash`, and the GitHub CLI (`gh auth login`) for cloning and creating
repositories. Linux and macOS are supported.

```bash
curl -fsSL https://raw.githubusercontent.com/DragosMocrii/project-adhd/main/install.sh | bash
```

This clones project-adhd into `~/.local/share/project-adhd`, checks out the
newest release, and links `~/.local/bin/adhd`. If `~/.local/bin` is not on
your `PATH`, the installer prints the line to add. Running it again updates
the installation. Set `ADHD_REF=main` to follow unreleased changes, or
`ADHD_REF=v0.1.0` to pin a release. From a checkout of this repository,
`./install.sh` links that checkout instead, and `adhd update` leaves it to
you and git.

## Attach to a repository

```bash
adhd attach facebook/react --agents claude,codex   # clones with gh, then attaches
adhd attach ~/src/existing-clone                   # or attach a clone you already have
```

Then open the repository in VS Code and run **Dev Containers: Reopen in
Container**. If the repository ships its own `.devcontainer/`, VS Code asks
which configuration to open; pick `project-adhd`.

During the host-side initialization, project-adhd copies missing Git
`user.name` and `user.email` from the repository's effective host Git
configuration into repository-local configuration. Existing repository or
worktree values are preserved. This is a one-time fill: later changes to the
host identity do not replace the repository values. If either host value is
unset or empty, initialization warns and continues; configure it on the host
with `git config --global user.name 'Your Name'` or
`git config --global user.email 'you@example.com'`.

The first time on a host, authenticate inside the container, then finish
setup:

```bash
gh auth login        # always
claude auth login    # if claude is in AGENT_TOOLS
codex login          # if codex is in AGENT_TOOLS
bash .devcontainer/project-adhd/post-create.sh
.devcontainer/project-adhd/verify.sh
```

The existing Gemini volume persists Antigravity preferences and follows
`AGENT_STATE_SCOPE`, but Antigravity OAuth credentials use an OS keyring and
are not guaranteed to persist with the current configuration. See the
[official Antigravity authentication documentation](https://antigravity.google/docs/install?surface=cli).
For headless authentication, configure
`"modelProvider": "gemini"` in
`~/.gemini/antigravity-cli/settings.json` and export `GEMINI_API_KEY` inside
the container. The key is not configured or stored by project-adhd.

`verify.sh` reports `SKIP` for unselected tools and checks that each selected
CLI is available; it does not verify authentication.

**What `attach` writes.** Everything lives in
`.devcontainer/project-adhd/`, which contains a `.gitignore` of `*` so git
never sees it. It also adds a marked block to `.git/info/exclude` covering the
directories agents create at the repository root (`.worktrees/`,
`.claude/worktrees/`, `.superpowers/`, `docs/superpowers/`). `git status`
stays clean.

**Worktrees.** `git worktree add` does not copy untracked files, so run
`adhd attach .` inside each new worktree. Each worktree gets its own
container.

## Start without VS Code

Install the Dev Container CLI on the host:

```bash
npm install -g @devcontainers/cli
```

From an attached Git worktree root, start or stop the same workspace container
that VS Code would use:

```bash
adhd devcontainer up       # starts or resumes the Dev Container
adhd devcontainer stop     # stops it but keeps the container and volumes
```

Pass a different worktree root as the final argument when needed. Repeated
`up` leaves an already-running container untouched; stopped containers can be
resumed with `up`.

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
the flag, `attach` asks, or selects all available tools when it cannot ask.

```bash
adhd attach <dir> --agents antigravity  # installs the Antigravity CLI (`agy`)
AGENT_TOOLS=claude                     # Claude Code only
AGENT_TOOLS=claude,codex               # Claude Code and Codex
```

Empty selects all available tools; an unrecognized value fails the run. `rtk`,
the GitHub CLI, and Herdr are always installed. Changing it later requires
**Dev Containers: Rebuild Container**, then
`bash .devcontainer/project-adhd/post-create.sh`.

The Gemini CLI is no longer selectable; use `antigravity` instead. Existing
environment files whose `AGENT_TOOLS` value includes `gemini` must remove it
before rebuilding. This removes the Gemini CLI, not Antigravity's Gemini
provider option for headless API-key authentication.

Antigravity settings share the existing `~/.gemini` volume and follow
`AGENT_STATE_SCOPE`; OAuth keyring persistence is not configured. The supported
headless option and authentication boundary are described above.

- **OMP Superpowers requires Claude.** OMP sources the Superpowers package from
  Claude's installed plugin, so `omp` needs `claude` selected and
  authenticated; otherwise its Superpowers step is skipped with a message.

## Herdr on the host


### Usage

Herdr is a server, which runs your panes, and clients that draw it. Sounds and
system notifications play wherever the client runs. `adhd herdr` runs the
client on your host and attaches it to the Herdr server in the repository's
running Dev Container:

```bash
adhd herdr                       # the repository in the current directory
adhd herdr ~/src/my-project      # or name it
adhd herdr . -- --session work   # arguments after -- go to herdr
```

Install Herdr on the host first (`curl -fsSL https://herdr.dev/install.sh | sh`),
then open the repository in its Dev Container. On macOS the sound plays with
`afplay`; set `[ui.toast] delivery = "system"` in the host's Herdr config for
Notification Center alerts too.

It uses Herdr's own `herdr --remote` over SSH, but nothing listens on a port:
`adhd herdr` gives Herdr `ssh` and `scp` wrappers whose connection to the
container is `docker exec` running sshd on stdin and stdout. The first run
creates a dedicated key in `~/.local/state/project-adhd/herdr-remote/`, which is
the only key that sshd accepts. Your own `~/.ssh/config` and keys are not
touched, and Herdr's other SSH machines still use plain `ssh`. Panes started
this way get the container's environment and `PATH`, the same as a VS Code
terminal, and they share one Herdr server with the container's terminals.
New terminals in a fresh Herdr session start in the mounted repository directory.
Reattaching to an existing session preserves its terminals, working directories,
and running commands.

## State and isolation

| Volume | Scope |
|---|---|
| `project-adhd-shared-claude`, `-gh`, `-codex`, `-gemini`, `-omp`, `-rtk-config` | shared by every attached repository |
| `project-adhd-shared-lock` | shared; serializes concurrent first-time setup |
| `<project-prefix>-rtk-data` | this repository only |
| `<project-prefix>-vscode-extensions`, `-vscode-machine`, `-vscode-user` | this repository only, shared by its worktrees; installed extensions, remote settings, and extension storage |

Agent histories stay separate because each repository is mounted at its own
path, `/workspaces/<folder-name>`. Two clones with the same folder name open
at the same time share a history namespace; their histories merge, and
nothing is lost.

Each worktree gets its own Compose project name. `COMPOSE_PROJECT_NAME` in
your environment or the repository's root `.env` may override it;
`initialize.sh` warns when it finds one.

To keep a repository's agent state private — separate logins included — set
`AGENT_STATE_SCOPE=project` in its `devcontainer.env` and rebuild.

Agent tool binaries and VS Code Server binaries are reinstalled on rebuild.
Agent logins, plugins, and histories stay in the agent volumes, which are
shared unless `AGENT_STATE_SCOPE=project`. VS Code extensions you install in
the container, remote settings, and extension storage stay in this
repository's VS Code volumes, so every worktree of the repository sees them.
Workspace `.vscode/settings.json` persists through the repository bind mount.
Extensions installed before these volumes existed were not kept; install them
once more. Deleting `.devcontainer/project-adhd/.env` or `devcontainer.env`
does not remove any volume.

## Updating and customizing

```bash
adhd update              # move this installation to the newest release
adhd refresh [dir]       # apply it to an attached repository (default: .)
adhd refresh --dry-run   # list what would change, and change nothing
```

`update` changes only your adhd installation; `refresh` brings one attached
repository up to the installed version. In tracked mode, `refresh` refuses to
run while `.devcontainer/project-adhd/` has uncommitted changes, so the
refresh shows up as its own reviewable diff; `--force` skips that check.
For scripting and agent workflows, `--porcelain` prints stable tab-separated
records (`<action>\t<file>[\t<detail>]`) and exits with code `3` if any conflicts
or manual reviews remain.

### Versions and channels

project-adhd is released as `vX.Y.Z` tags with notes on the
[releases page](https://github.com/DragosMocrii/project-adhd/releases) and in
[CHANGELOG.md](CHANGELOG.md). `adhd version` prints what is installed and what
it follows:

```console
$ adhd version
adhd 0.1.0 (release)
```

```bash
adhd update --ref v0.1.0   # pin a release; later updates stay there
adhd update --ref main     # follow main, including unreleased changes
adhd update --ref release  # back to the newest release
```

Each attached repository records the version it was refreshed from in
`.devcontainer/project-adhd/.adhd` (`version=`); in tracked mode that file is
committed, so the repository's history shows every runtime upgrade.

**Installed before releases existed?** Run `adhd update` twice: the first run
fetches the new `adhd`, the second moves it to the newest release.

You can edit an attached repository's runtime files — for example add a Dev
Container Feature for a toolchain to `devcontainer.json`:

```json
"ghcr.io/devcontainers/features/go:1": {}
```

`refresh` (and rerunning `attach`) never overwrites a file you edited. When a
new version of it ships, adhd three-way merges your edits with the new version,
using the version you last received as the base:

- **merged** — the changes do not overlap; your file now has both.
- **conflict** — your file is left as is, and the merge, with git-style
  conflict markers, is written beside it as `<file>.adhd-new`. The report shows
  how many conflicted hunks occurred (`conflict <file> -> <file>.adhd-new (N hunks)`).
- **review** — if the previous version cannot be found in the installation's
  history (for example, it was refreshed from a checkout with uncommitted changes),
  `<file>.adhd-new` holds the plain new version instead (`review <file> -> <file>.adhd-new (no base; compare by hand)`).

Merge each `.adhd-new` into its file and delete it before the next refresh: a
version is offered only once, and later refreshes stay quiet until another
version ships. When conflicts or manual reviews exist, `adhd refresh` exits with code `3`.

## Detaching

```bash
adhd detach [dir]
```

Removes `.devcontainer/project-adhd/` (including its `devcontainer.env`) and
the ignore block. Docker volumes are kept; the command prints how to list
them.

## Docker from inside the Dev Container

The workspace container does not have access to the host Docker daemon.
Starting Docker or Compose projects from inside the workspace is unsupported
unless you separately configure access to an isolated or remote daemon. Docker
on the host is still required for VS Code to build and run the Dev Container.

`LOCAL_WORKSPACE_FOLDER` remains the host path of the folder VS Code opened.
For a linked worktree, that is the worktree's own host path.

## Security

`post-create.sh` fetches and executes vendor installers, the installer is
meant to be piped to `bash`, and attached repositories share agent credentials.
See [SECURITY.md](SECURITY.md) before using this with code you do not trust.

## FAQ

### Can I add project-adhd to an existing Git repository?

Yes. That was one of the project's main goals. Run `adhd attach` with the
path to your existing clone, for example `adhd attach ~/src/my-project`.
See [Attach to a repository](#attach-to-a-repository) for details.

### Can I quickly scaffold a new repository?

Yes. Run `adhd new my-project` to create the repository locally and on GitHub.
It creates a private GitHub repository by default; add `--public` to make it
public. See [Start a new project](#start-a-new-project) for details.

### How do I get a new project up and running with the tools it needs?

Use an agentic tool in the Dev Container to analyze the repository, identify
the tools needed for its development workflows, and configure those tools in
the Dev Container. For example, start by asking:

> Analyze this repository and determine what is needed to run its tests.
> Identify any tools or dependencies that are missing from the Dev Container,
> and configure the Dev Container so the tests can be run here.

Review the proposed changes, then rebuild the Dev Container if its
configuration changed.

## Contributing to project-adhd

```bash
bun install
bun test
bun run typecheck
shellcheck install.sh bin/adhd libexec/adhd/*.sh libexec/adhd/herdr-bin/* .devcontainer/project-adhd/*.sh .devcontainer/project-adhd/lib/agent-tools.sh
```
