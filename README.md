# project-adhd

A GitHub template for an agentic development environment: a pinned Dev
Container that installs your choice of agent CLIs, wires them to the RTK
token-optimizing proxy and the Superpowers plugin, and keeps every credential
and plugin in per-project Docker volumes that survive rebuilds.

**What you get**

- A digest-pinned Dev Container with Bun, Node, `python3`, and the GitHub CLI.
- Your choice of Claude Code, Codex, Gemini CLI, and OMP — see `AGENT_TOOLS`.
- RTK configured as a hook for each selected agent, cutting bash output tokens.
- The Superpowers plugin and the Archify skill installed per agent.
- Seven named state volumes, scoped per project and shared across worktrees.
- A contract test suite and `verify.sh` that prove the environment is correct.

This template provisions an *environment*. It ships no application scaffold —
your project's own `package.json`, `src/`, and tests stay entirely yours.

## Create a project

```bash
gh repo create my-project --private --template DragosMocrii/project-adhd --clone
cd my-project
```

Open the clone in VS Code (`code .`) and run **Dev Containers: Reopen in
Container**.

## First-run setup

1. **Choose your tools.** Copy `.devcontainer/devcontainer.env.example` to
   `.devcontainer/devcontainer.env` and set `AGENT_TOOLS` (see below). Skip
   this to get all four.
2. **Let the container build.** The first creation installs Bun tooling, the
   selected agent CLIs, RTK, and Archify. No agent is authenticated yet, so
   post-create deliberately defers Superpowers setup, prints what to run, and
   exits successfully.
3. **Authenticate.** Start `gemini` once and complete its sign-in flow if you
   selected it, then run the logins for the tools you selected:

   ```bash
   gh auth login
   claude auth login
   codex login
   ```

4. **Rerun post-create.** This installs or enables Superpowers through each
   CLI's native mechanism, selecting the exposed reserved Codex catalog:
   `openai-curated` for ChatGPT authentication or `openai-api-curated` for
   API-key authentication.

   ```bash
   bash .devcontainer/post-create.sh
   ```

5. **Verify.**

   ```bash
   .devcontainer/verify.sh
   ```

   Checks for unselected tools report `SKIP`; a selected tool that is not yet
   configured reports a failure, which is the expected result before step 3.

Complete the OMP provider setup if OMP asks for it after authentication.
Credentials and configuration stay in this project's state volumes; they are
not shared with another generated project.

## Choosing your agent tools

`AGENT_TOOLS` in `.devcontainer/devcontainer.env` controls which agent CLIs
are installed and verified. It is a comma-separated list drawn from `claude`,
`codex`, `gemini`, and `omp`:

```bash
AGENT_TOOLS=claude          # Claude Code only
AGENT_TOOLS=claude,codex    # Claude Code and Codex
```

Leave it unset or empty to select all four. An unrecognized value fails the
run rather than being silently ignored.

`rtk` and the GitHub CLI are always installed — RTK is a proxy consumed by the
agents rather than an agent itself.

Two constraints are worth knowing before you choose:

- **OMP Superpowers requires Claude.** OMP sources the Superpowers package
  from Claude's installed plugin, so `omp` needs `claude` selected *and*
  authenticated. Otherwise OMP is installed and configured, and its
  Superpowers step is skipped with a message.
- **Gemini CLI has no RTK integration** and no Archify destination today.

## Security

`post-create.sh` fetches and executes vendor installers, and the container has
access to the host Docker daemon. See [SECURITY.md](SECURITY.md) for exactly
what runs, from where, and where credentials live.

## Adapting an existing project

If the generated repository will be used with a project that already has its own source and test files, keep those root application files and remove or replace only template-owned content:

- `.devcontainer/test/scaffold.test.ts` — template contract suite; remove it if the existing project has its own tests and the template contract is no longer needed.
- `.omp/lsp.json` — template-owned OMP language-server configuration pointing
  at the TypeScript under `.devcontainer/`. Remove it if the adopted project
  does not use OMP, or repoint it at the project's own TypeScript install.
- `src/` and `test/` — the root directories belong to the adopted project. Remove either only when it contains no existing project files.
- `README.md` — replaceable project documentation; preserve the relevant Dev Container, authentication, and state-volume instructions if the setup remains in use.

Keep `.devcontainer/` unless the project's development environment is being replaced. In particular, `devcontainer.json`, `docker-compose.yml`, `initialize.sh`, `post-create.sh`, and `verify.sh` provide the container lifecycle and agent-tool setup. The template's `package.json`, `bun.lock`, and `tsconfig.json` live under `.devcontainer/`; the generated project's root package manifest, lockfile, and TypeScript configuration remain independent. Adapt the root project's own scripts and dependencies without merging them into the template contract.

Deleting `.devcontainer/.env` or `.devcontainer/devcontainer.env` does not clear the named Docker volumes. The initializer recreates missing local files, but deleting `devcontainer.env` loses its local secrets; removing persistent agent state requires a separate, deliberate Docker volume cleanup.


## Worktrees and persistent state

Create project-local linked worktrees with:

```bash
git worktree add .worktrees/feature-example -b feature/example
```

The generated `.devcontainer/.env` derives `PROJECT_STATE_PREFIX` from the repository name and canonical Git common directory. The selected valid prefix is also persisted in the canonical Git common directory. Linked worktrees therefore reuse it, including a newly created worktree after the repository is moved. Existing valid prefixes are preserved; conflicting canonical/worktree prefixes fail instead of silently switching volumes.
The local environment files are:

- `.devcontainer/devcontainer.env.example` — tracked template for optional environment variables.
- `.devcontainer/devcontainer.env` — ignored per-project secrets file, loaded into the workspace container by Compose; initialize it with local values such as `CONTEXT7_API_KEY`.
- `.devcontainer/.env` — ignored, generated Compose interpolation file containing exactly `PROJECT_STATE_PREFIX=<slug>-<8-hex-id>`.

These files have different scopes. `.devcontainer/.env` is generated by `initialize.sh` for Compose project and persistent-volume identity; it is not a general-purpose container environment file. `.devcontainer/devcontainer.env` is user-managed local configuration passed into the workspace container through Compose's `env_file` setting. The initializer preserves existing values in `devcontainer.env` and never commits either ignored local environment file.
Compose gives the seven persistent volumes explicit names based on that prefix:

- `${PROJECT_STATE_PREFIX}-claude`
- `${PROJECT_STATE_PREFIX}-gh`
- `${PROJECT_STATE_PREFIX}-rtk-config`
- `${PROJECT_STATE_PREFIX}-rtk-data`
- `${PROJECT_STATE_PREFIX}-codex`
- `${PROJECT_STATE_PREFIX}-gemini`
- `${PROJECT_STATE_PREFIX}-omp`

Tool binaries are reinstalled on rebuild; authentication, plugin files, histories, and other state remain in these volumes. Do not commit either ignored local environment file.

## Compose projects launched from the Dev Container

The Docker daemon used from inside the Dev Container runs on the host. Any bind source supplied to an added Compose project must therefore be a daemon-visible host path; do not use a path that exists only inside the container, such as `/workspace`, as a host bind source.

`LOCAL_WORKSPACE_FOLDER` identifies the host main-checkout anchor passed into the container. For a linked worktree, do not treat it as the current worktree path: derive the current worktree path relative to the shared/main checkout (for example, `.worktrees/feature-example`), then append that offset to the daemon-visible host main-checkout anchor before constructing bind mounts. This keeps Compose paths correct for both the main checkout and linked worktrees.

Run the nested template contract, strict TypeScript check, and non-mutating tool smoke check from the repository root:

```bash
(cd .devcontainer && bun test)
(cd .devcontainer && bun run typecheck)
.devcontainer/verify.sh
```
