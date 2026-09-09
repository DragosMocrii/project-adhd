# Security

This template provisions a development environment that installs third-party
agent CLIs and stores their credentials. Read this before adopting it.

## What post-create executes

`.devcontainer/post-create.sh` runs on first container creation and on every
manual rerun. It fetches and executes the following, as the `vscode` user:

| Source | Fetched from | Method |
|--------|--------------|--------|
| Claude Code installer | `https://claude.ai/install.sh` | `curl \| bash` |
| RTK installer | `https://raw.githubusercontent.com/rtk-ai/rtk/` | `curl \| sh` |
| Codex installer | `https://chatgpt.com/codex/install.sh` | `curl \| sh` |
| Gemini CLI | npm registry (`@google/gemini-cli`) | `npm install -g` |
| OMP | npm registry (`@oh-my-pi/pi-coding-agent`) | `bun install -g` |
| Archify skill | `bunx skills@latest add tt-a1i/archify` | `bunx` |

Set `AGENT_TOOLS` in `.devcontainer/devcontainer.env` to install only the
tools you actually use. `rtk` and `gh` are always installed.

## Installers are unpinned by design

None of the above are version-pinned. Agent CLIs ship frequently, and a pinned
template goes stale faster than it gains reproducibility. The consequence is
explicit: **container rebuilds are not byte-reproducible**, and you are
trusting each vendor's installer at the moment you build. If your threat model
does not allow that, fork the template and pin the installers yourself.

The base image *is* pinned, by digest, in `.devcontainer/docker-compose.yml`.

## Host Docker socket

The `docker-outside-of-docker` Dev Container feature exposes the **host**
Docker daemon inside the container. Any process in the container can therefore
control host containers, images, and volumes. This is a deliberate tradeoff
that lets Compose projects be launched from inside the environment; it is not
a sandbox boundary.

## Credentials at rest

Seven named Docker volumes hold live credentials and agent state:
`<prefix>-claude`, `-gh`, `-rtk-config`, `-rtk-data`, `-codex`, `-gemini`,
`-omp`. They persist across rebuilds by design.

Deleting `.devcontainer/.env` or `.devcontainer/devcontainer.env` does **not**
remove them. Removing persistent agent state requires deliberate Docker volume
cleanup:

```bash
docker volume ls --filter name=<prefix>
docker volume rm <prefix>-claude <prefix>-gh <prefix>-rtk-config \
  <prefix>-rtk-data <prefix>-codex <prefix>-gemini <prefix>-omp
```

Both local environment files are git-ignored with root-anchored rules, and the
contract suite asserts that. Never commit either one.

## Known fragility: plugin detection

`.devcontainer/lib/*.ts` infer plugin and marketplace state from the JSON that
three CLIs emit. Those output shapes are undocumented and may change without
notice. The modules are shape-tolerant and unit-tested, which makes the
behavior *verifiable* — not guaranteed correct against a future CLI release.
If `verify.sh` reports a plugin missing that you know is installed, suspect a
changed JSON shape first and open an issue.

## Reporting a vulnerability

Open a GitHub issue for anything affecting the template's own scripts. For
vulnerabilities in the installed agent CLIs, report to those vendors directly.
