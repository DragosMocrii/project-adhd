# Agent guidance

This repository is a Dev Container template. It provisions an environment; it
ships no application code of its own.

## Layout

- `.devcontainer/` — **everything template-owned.** Its `package.json`,
  `bun.lock`, and `tsconfig.json` belong to the template's own contract suite,
  not to any project generated from it.
- `.devcontainer/lib/` — shared units. `agent-tools.sh` parses `AGENT_TOOLS`;
  the `*.ts` modules parse agent-CLI plugin JSON. Both scripts use them, so a
  change here has two callers.
- `.devcontainer/test/scaffold.test.ts` — the template contract suite.
- `.omp/lsp.json` — template-owned OMP language-server configuration.
- Repository root — belongs to the adopted project.

## Conventions

- Shell scripts use `set -euo pipefail` and a local `die()` or `fail()` helper.
- No `jq`. JSON is parsed by the Bun modules under `.devcontainer/lib/`.
- Plugin-detection logic lives in exactly one place: the modules under
  `.devcontainer/lib/`. Do not reintroduce inline `bun -e` parsers in the
  shell scripts. The one deliberate exception is `check_claude_settings` in
  `verify.sh`, which inspects a Claude settings file rather than CLI plugin
  output — it has no counterpart module and is meant to stay inline.
- Agent CLI installers are intentionally unpinned. Do not add version pins
  without changing `SECURITY.md` to match.
- `NO_BROWSER=true` is container-wide on purpose; a contract test asserts it.

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

Note: `shellcheck` is not preinstalled in the container image. CI runs it on
every push and pull request (it is preinstalled on GitHub's `ubuntu-latest`
runners). To run it locally, install it first: `sudo apt-get update && sudo apt-get install -y shellcheck`.

`.devcontainer/verify.sh` additionally checks the live environment, and needs
authenticated CLIs. The contract suite does not — it stubs `PATH` under a
temporary `HOME` and never touches the network.
