# Agentic Bun and TypeScript

This repository is a GitHub template for a generic Bun and TypeScript project. The Dev Container provides the pinned runtime and installs the agent CLIs during first container creation.

## Create a project

Resolve the authenticated GitHub owner and create a private generated repository from the template:

```bash
OWNER="$(gh api user --jq .login)"
gh repo create my-project --private --template "$OWNER/project-adhd" --clone
cd my-project
```

Open the clone in VS Code (`code .`) and run **Dev Containers: Reopen in Container**. The first creation installs Bun tooling, Claude Code, Codex, OMP, RTK, and Archify. On a fresh clone, Claude and Codex have no login yet, so post-create deliberately skips auth-dependent Superpowers plugin setup and exits successfully after printing the deferred setup instructions. Archify is still installed during this first run.

After the first run, authenticate each project and rerun the post-create bootstrap before verification:

```bash
gh auth login
claude auth login
codex login
bash .devcontainer/post-create.sh
.devcontainer/verify.sh
```

The rerun installs or enables Superpowers through each CLI's native mechanism, including Codex's reserved `openai-curated` marketplace. Complete the OMP provider setup if OMP asks for it after authentication. Credentials and configuration stay in this project's state volumes; they are not shared with another generated project.

## Worktrees and persistent state

Create project-local linked worktrees with:

```bash
git worktree add .worktrees/feature-example -b feature/example
```

The generated `.devcontainer/.env` derives `PROJECT_STATE_PREFIX` from the repository name and canonical Git common directory. The selected valid prefix is also persisted in the canonical Git common directory. Linked worktrees therefore reuse it, including a newly created worktree after the repository is moved. Existing valid prefixes are preserved; conflicting canonical/worktree prefixes fail instead of silently switching volumes.

The local environment files are:

- `.devcontainer/devcontainer.env.example` — tracked template for optional environment variables.
- `.devcontainer/devcontainer.env` — ignored per-project secrets file; initialize it with local values such as `CONTEXT7_API_KEY`.
- `.devcontainer/.env` — ignored, generated Compose identity containing exactly `PROJECT_STATE_PREFIX=<slug>-<8-hex-id>`.

Compose gives the six persistent volumes explicit names based on that prefix:

- `${PROJECT_STATE_PREFIX}-claude`
- `${PROJECT_STATE_PREFIX}-gh`
- `${PROJECT_STATE_PREFIX}-rtk-config`
- `${PROJECT_STATE_PREFIX}-rtk-data`
- `${PROJECT_STATE_PREFIX}-codex`
- `${PROJECT_STATE_PREFIX}-omp`

Tool binaries are reinstalled on rebuild; authentication, plugin files, histories, and other state remain in these volumes. Do not commit either ignored local environment file.

## Compose projects launched from the Dev Container

The Docker daemon used from inside the Dev Container runs on the host. Any bind source supplied to an added Compose project must therefore be a daemon-visible host path; do not use a path that exists only inside the container, such as `/workspace`, as a host bind source.

`LOCAL_WORKSPACE_FOLDER` identifies the host main-checkout anchor passed into the container. For a linked worktree, do not treat it as the current worktree path: derive the current worktree path relative to the shared/main checkout (for example, `.worktrees/feature-example`), then append that offset to the daemon-visible host main-checkout anchor before constructing bind mounts. This keeps Compose paths correct for both the main checkout and linked worktrees.

## Local checks

Run the starter contract, strict TypeScript check, and non-mutating tool smoke check with:

```bash
bun test
bun run typecheck
.devcontainer/verify.sh
```
