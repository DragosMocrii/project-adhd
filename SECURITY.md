# Security

project-adhd provisions a development environment, attached to repositories
you choose, that installs third-party agent CLIs and stores their
credentials. Read this before adopting it.

## What post-create executes

`.devcontainer/project-adhd/post-create.sh` runs on first container creation
and on every manual rerun. It fetches and executes the following, as the
`vscode` user:

| Source | Fetched from | Method |
|--------|--------------|--------|
| Claude Code installer | `https://claude.ai/install.sh` | `curl \| bash` |
| RTK installer | `https://raw.githubusercontent.com/rtk-ai/rtk/` | `curl \| sh` |
| Codex installer | `https://chatgpt.com/codex/install.sh` | `curl \| sh` |
| Gemini CLI | npm registry (`@google/gemini-cli`) | `npm install -g` |
| OMP | npm registry (`@oh-my-pi/pi-coding-agent`) | `bun install -g` |
| Archify skill | `bunx skills@latest add tt-a1i/archify` | `bunx` |

Set `AGENT_TOOLS` in `.devcontainer/project-adhd/devcontainer.env` to install
only the tools you actually use. `rtk` and `gh` are always installed.

## What install.sh does

The documented one-liner pipes `install.sh` from this repository's `main`
branch into `bash`. It clones project-adhd with `git` into
`~/.local/share/project-adhd` (or fetches into an existing clone), checks out
the newest release tag (`vX.Y.Z`), and links `~/.local/bin/adhd`. The
installer script itself always comes from `main`; the code it installs is the
release. `ADHD_REF=vX.Y.Z` pins a specific release and `ADHD_REF=main`
installs unreleased code. It downloads nothing else and needs no `sudo`. To
review it first, clone the repository and run `./install.sh` from the
checkout.

Releases are tagged by release-please from a GitHub Actions workflow that
authenticates with a GitHub App restricted to this repository; its actions are
pinned by commit SHA.

## Installers are unpinned by design

None of the above are version-pinned. Agent CLIs ship frequently, and a pinned
project-adhd goes stale faster than it gains reproducibility. The consequence is
explicit: **container rebuilds are not byte-reproducible**, and you are
trusting each vendor's installer at the moment you build. If your threat model
does not allow that, fork project-adhd and pin the installers yourself.

The base image *is* pinned, by digest, in
`.devcontainer/project-adhd/docker-compose.yml`.

## Host Docker access

The Dev Container does not enable a Docker-outside-of-Docker feature or mount
the host Docker socket. Docker on the host is still used by VS Code to create
and run the Dev Container, but processes inside the workspace cannot use that
daemon through this configuration. Existing containers need to be rebuilt for
the change to take effect.

This removes the direct Docker-daemon control path, not all host exposure:
the workspace repository itself is bind-mounted into the container, so
processes inside can read and modify files in that repository.

## Credentials at rest, and shared state

Agent credentials, plugins, settings, and histories live in named Docker
volumes that persist across rebuilds:

- shared by every attached repository: `project-adhd-shared-claude`, `-gh`,
  `-rtk-config`, `-codex`, `-gemini`, `-omp`, `-lock`
- per repository: `<prefix>-rtk-data`

**Sharing is the default.** Code running in any attached repository's
container — a dependency's install script, a test fixture — can read every
repository's agent credentials and session histories. They are the same
accounts either way, but the reach is every project. Set
`AGENT_STATE_SCOPE=project` in a repository's `devcontainer.env` to give it
private volumes instead.

Deleting `.devcontainer/project-adhd/.env` or `devcontainer.env`, or running
`adhd detach`, does **not** remove any volume. Remove them deliberately:

```bash
docker volume ls --filter name=project-adhd-shared   # shared agent state
docker volume ls --filter name=<prefix>              # per-repository rtk-data, and project-scope agent state
docker volume rm project-adhd-shared-claude project-adhd-shared-gh …
```

Both local environment files are git-ignored by the runtime folder's
`.gitignore`, and the contract suite asserts that. Never commit either one.

## Known fragility: plugin detection

`.devcontainer/project-adhd/lib/*.ts` infer plugin and marketplace state from
the JSON that three CLIs emit. Those output shapes are undocumented and may
change without notice. The modules are shape-tolerant and unit-tested, which
makes the behavior *verifiable* — not guaranteed correct against a future CLI
release. If `verify.sh` reports a plugin missing that you know is installed,
suspect a changed JSON shape first and open an issue.

## Reporting a vulnerability

Report vulnerabilities in project-adhd's own scripts privately, through
[GitHub private vulnerability reporting](https://github.com/DragosMocrii/project-adhd/security/advisories/new).
Do not open a public issue for them. For vulnerabilities in the installed
agent CLIs, report to those vendors directly.
