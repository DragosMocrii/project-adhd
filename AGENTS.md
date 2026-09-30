# Agent guidance

This repository is project-adhd: a host CLI (`adhd`) and the Dev Container
runtime it attaches to other Git repositories.

## Layout

- `bin/adhd` — host CLI dispatcher. `libexec/adhd/` — one file per
  subcommand plus `common.sh` (shared helpers and the runtime manifest).
- `install.sh` — host installer.
- `.devcontainer/project-adhd/` — **the runtime**: everything `adhd attach`
  copies. This repository dogfoods it in tracked mode.
- `.devcontainer/project-adhd/lib/` — shared units. `agent-tools.sh` parses
  `AGENT_TOOLS` and is sourced by `post-create.sh`, `verify.sh`, and `adhd`;
  the `*.ts` modules parse agent-CLI plugin JSON.
- `test/` — the contract suite, split by where code runs: host
  (`initialize`, `adhd`, `install`, `agent-tools`, `portability`) and
  container (`post-create`, `verify`), plus static `config` checks and
  `parsers` (unit tests for the plugin-JSON modules).
- `package.json`, `bun.lock`, `tsconfig.json` — the suite's own tooling.

## Conventions

- Shell scripts use `set -euo pipefail` and a local `die()` or `fail()` helper.
- **Host scripts must run under bash 3.2** with BSD or GNU tools: no
  associative arrays, `${var,,}`, `mapfile`, `sed -i`, `stat -c`,
  `readlink -f`, or `realpath`. `test/portability.test.ts` guards this and
  CI runs the host tests under macOS `/bin/bash`. Container scripts
  (`post-create.sh`, `verify.sh`) may use bash 4+.
- A new runtime file must be added to `ADHD_RUNTIME_FILES` in
  `libexec/adhd/common.sh`; a contract test fails otherwise.
- No `jq`. JSON is parsed by the Bun modules under
  `.devcontainer/project-adhd/lib/`.
- Plugin-detection logic lives only in those modules. Do not reintroduce
  inline `bun -e` parsers in the shell scripts. The one deliberate exception
  is `check_claude_settings` in `verify.sh`, which inspects a Claude settings
  file rather than CLI plugin output.
- Agent CLI installers are intentionally unpinned. Do not add version pins
  without changing `SECURITY.md` to match.
- `NO_BROWSER=true` is container-wide on purpose; a contract test asserts it.
- Agent guidance lives only in this file. Do not add a `CLAUDE.md`: Claude
  Code reads `AGENTS.md` only when no project `CLAUDE.md` exists, and a
  contract test asserts there is none.

## Commits

Commit titles follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):
`<type>[optional scope][!]: <description>`.

- Types: `feat`, `fix`, `docs`, `test`, `refactor`, `ci`, `chore`, `build`,
  `perf`, `style`, `revert`.
- The scope is optional and names the area touched, such as a subcommand or
  script: `fix(attach): …`, `feat(initialize): …`.
- The description is lowercase, imperative, and has no trailing period.
- Mark a breaking change with `!` before the colon, or with a
  `BREAKING CHANGE:` footer.

## AGENT_TOOLS

`AGENT_TOOLS` selects which agent CLIs are installed and verified —
comma-separated from `claude`, `codex`, `gemini`, `omp`; unset means all four.
`rtk` and `gh` are always installed. OMP Superpowers requires `claude`
selected and authenticated.

## Verifying a change

```bash
bun test
bun run typecheck
shellcheck install.sh bin/adhd libexec/adhd/*.sh .devcontainer/project-adhd/*.sh .devcontainer/project-adhd/lib/agent-tools.sh
```

`shellcheck` is not preinstalled in the container image; CI runs it. To run
it locally: `sudo apt-get update && sudo apt-get install -y shellcheck`.

`.devcontainer/project-adhd/verify.sh` checks the live environment and needs
authenticated CLIs. The contract suite does not — it stubs `PATH` under a
temporary `HOME` and never touches the network.
