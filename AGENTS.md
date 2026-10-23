# Agent guidance

This repository is project-adhd: a host CLI (`adhd`) and the Dev Container
runtime it attaches to other Git repositories.

## Layout

- `bin/adhd` — host CLI dispatcher. `libexec/adhd/` — one file per
  subcommand plus `common.sh` (shared helpers and the runtime manifest).
  `libexec/adhd/herdr-bin/` holds the `ssh` and `scp` wrappers `adhd herdr`
  puts on Herdr's `PATH`, and the script it runs in the container.
- `install.sh` — host installer.
- `VERSION`, `CHANGELOG.md`, `release-please-config.json`,
  `.release-please-manifest.json` — release metadata, owned by release-please.
- `.devcontainer/project-adhd/` — **the runtime**: everything `adhd attach`
  copies. This repository dogfoods it in tracked mode.
- `.devcontainer/project-adhd/lib/` — shared units. `agent-tools.sh` parses
  `AGENT_TOOLS` and is sourced by `post-create.sh`, `verify.sh`, and `adhd`;
  the `*.ts` modules parse agent-CLI plugin JSON.
- `test/` — the contract suite. Host tests: `initialize`, `adhd`, `herdr`,
  `install`, `agent-tools`, `portability`. Container tests: `post-create`, `verify`.
  Also `config` (static checks) and `parsers` (plugin-JSON module tests).
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
- Plugin detection lives only in those modules; do not add inline `bun -e`
  parsers to the shell scripts. The one exception is `check_claude_settings`
  in `verify.sh`, which reads a Claude settings file, not CLI plugin output.
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
- The type decides whether a change is released: `feat`, `fix`, `perf`, and
  `revert` appear in the changelog and trigger a release; `docs`, `test`,
  `ci`, `chore`, `refactor`, `style`, and `build` do neither without a
  breaking-change marker. Use `feat` or `fix` for any change a user of `adhd`
  or the runtime would notice, even a small one.
- The description becomes the changelog line, so write it for users.
- A pull request merged by squash supplies its title as the commit subject;
  the title must follow these rules, and any intended `BREAKING CHANGE:` footer
  must survive in the squash commit body.

## Releases

Keep [release-please](https://github.com/googleapis/release-please) because
this simple, single-version project needs a reviewed `VERSION`/changelog
update and a deliberate merge gate, not package publishing or automatic
releases on every feature merge.

An explicit request such as “release” or “push and release” authorizes an agent
to complete the normal release sequence, including merging the release PR,
without asking for another approval. A request to prepare, review, or document
a release does not authorize publication.

A rolling release includes all unreleased changes already on `main`, not just
the latest change. A release request does not authorize merging unrelated open
PRs or committing, stashing, or resetting unrelated working-tree changes. If
the requested work still needs to land, finish only that authorized work
through the normal checks and merge path before starting the release sequence.

release-please (`.github/workflows/release.yml`) owns `VERSION`,
`CHANGELOG.md`, and `.release-please-manifest.json`; never hand-edit these
files, create release tags, or use `gh release create` as a shortcut. While
pre-1.0, normal `feat`/`fix` changes bump patch (for example, `0.1.7` →
`0.1.8`), and breaking changes bump minor (for example, `0.1.7` → `0.2.0`).
The generated release PR is the source of the proposed version.

- `latest_release_tag` and `move_to_ref` exist in both
  `libexec/adhd/common.sh` and `install.sh`, which must run standalone. Change
  both copies together; a contract test asserts they are identical.
- Installs follow `adhd.ref` in their own Git config: `release`, a branch, a
  pinned tag, or `checkout` (a development checkout adhd never moves).

### Release sequence

1. **Preflight and identify current main.** Run from this repository. Set
   `REPO=DragosMocrii/project-adhd`; every GitHub command must use
   `--repo "$REPO"` or an API path `repos/$REPO/...`, never infer the target
   from the attached repository or fork.

   ```sh
   REPO=DragosMocrii/project-adhd
   gh auth status
   gh repo view "$REPO" --json nameWithOwner,defaultBranchRef,viewerPermission,squashMergeAllowed
   gh release view --repo "$REPO" --json tagName,url,isDraft,isPrerelease,publishedAt
   ```

   Require access to inspect Actions and merge the PR. Missing authentication
   or permissions is a blocker; do not change credentials or print secrets.
   Record the latest published stable tag as `LAST_TAG`. If there is no prior
   release, distinguish “not found” from authentication or network errors and
   continue through the first-release PR without assuming a prior tag.

   ```sh
   BASE_SHA=$(gh api "repos/$REPO/commits/main" --template '{{.sha}}{{"\n"}}')
   gh run list --repo "$REPO" --workflow ci.yml --commit "$BASE_SHA" --json databaseId,headSha,status,conclusion,url
   gh run list --repo "$REPO" --workflow release.yml --commit "$BASE_SHA" --json databaseId,headSha,status,conclusion,url
   ```

   Identify the exact main-push CI and Release runs for `BASE_SHA`. Watch any
   unfinished run with `gh run watch "$RUN_ID" --repo "$REPO" --exit-status`.
   For CI, inspect `gh run view "$RUN_ID" --repo "$REPO" --json headSha,conclusion,jobs,url`.
   Require successful main-push CI and Release runs; they are independent
   workflows, and release-PR creation does not prove CI passed.

2. **Find the generated candidate.** List release candidates:

   ```sh
   gh pr list --repo "$REPO" --base main --state open --label "autorelease: pending" --json number,title,headRefName,isDraft,url,labels
   ```

   Select only the generated root release PR with head
   `release-please--branches--main`, base `main`, and title
   `chore(main): release X.Y.Z`. Never select an arbitrary PR or hard-code its
   number.

   If there is no release PR after the exact-main Release run succeeded,
   inspect unreleased commits:

   ```sh
   gh api "repos/$REPO/compare/$LAST_TAG...$BASE_SHA" --template 'status: {{.status}}; ahead: {{.ahead_by}}{{"\n"}}{{range .commits}}{{.sha}} {{.commit.message}}{{"\n"}}{{end}}'
   ```

   If the comparison is identical or contains only non-releasable commits,
   report “nothing to release” and the latest release URL. For a first release,
   skip comparison and diagnose from Release logs and history. If releasable
   changes exist, follow step 5. Unexpected/multiple candidates or mismatched
   identity require diagnosis, never guessing.

3. **Review, require CI, and merge the candidate.** Record `PR`, `HEAD_SHA`,
   `PR_TITLE`, and proposed `VERSION` from actual candidate metadata and diff:

   ```sh
   gh pr view "$PR" --repo "$REPO" --json number,title,state,isDraft,baseRefName,headRefName,headRefOid,files,labels,url
   gh pr diff "$PR" --repo "$REPO"
   ```

   Require a non-draft open PR and consistent version changes in `VERSION`,
   manifest `"."`, changelog heading, and title. The expected changed paths
   are exactly `VERSION`, `.release-please-manifest.json`, and `CHANGELOG.md`.
   Diagnose unexpected code/configuration edits before merging. Review the
   complete generated changelog and breaking-change impact. Missing intended
   changes require correcting the underlying commit classification through
   the normal workflow, not editing generated metadata or renaming an ordinary
   PR. Do not publish a version inconsistent with an explicitly requested
   version; report the mismatch without inventing an override.

   ```sh
   gh pr checks "$PR" --repo "$REPO" --watch
   gh pr checks "$PR" --repo "$REPO" --json name,state,bucket,workflow,link
   ```

   Require all three CI checks—`Contract suite`, `Host scripts (macOS, bash
   3.2)`, and `ShellCheck`—to be present and successful. Missing, skipped,
   cancelled, pending, or failed expected checks do not pass. Resolve other
   failing applicable checks and merge-policy requirements too. Do not use
   `--required` as the sole gate; branch protection may not be configured.

   Immediately before merging, re-read candidate metadata and `main`. If
   `HEAD_SHA` changed, repeat diff review and checks for the new head. If
   `BASE_SHA` changed, restart candidate discovery so main CI and release
   scope are current. Merge only the reviewed head:

   ```sh
   gh pr merge "$PR" --repo "$REPO" --squash --match-head-commit "$HEAD_SHA" --subject "$PR_TITLE"
   ```

   Preserve the generated title. Never use `--admin` or unattended auto-merge.
   A head mismatch restarts review, never a blind retry. If policy queues the
   merge, monitor until the PR is actually merged and honor all restrictions;
   invoking the command is not publication.

4. **Verify publication.** Obtain the actual merge SHA; do not assume it equals
   `HEAD_SHA` or current `main`:

   ```sh
   gh pr view "$PR" --repo "$REPO" --json state,mergeCommit,url
   ```

   Set `MERGE_SHA` from `mergeCommit` and `TAG=v$VERSION`. Discover and watch
   the exact-`MERGE_SHA` Release and push-CI runs using step 1's `gh run list`
   commands with `MERGE_SHA` in place of `BASE_SHA`. Require both runs and
   all three CI jobs to succeed. If a run has not appeared, wait; never
   substitute an older successful run.

   ```sh
   gh release view "$TAG" --repo "$REPO" --json tagName,url,isDraft,isPrerelease,publishedAt,body
   gh api "repos/$REPO/commits/$TAG" --template '{{.sha}}{{"\n"}}'
   gh api "repos/$REPO/contents/VERSION?ref=$TAG" --header 'Accept: application/vnd.github.raw+json'
   gh api "repos/$REPO/contents/.release-please-manifest.json?ref=$TAG" --header 'Accept: application/vnd.github.raw+json'
   gh api "repos/$REPO/contents/CHANGELOG.md?ref=$TAG" --header 'Accept: application/vnd.github.raw+json'
   ```

   Require the release to be published, stable, and non-draft, with intended
   notes. Resolved tag commit must equal `MERGE_SHA`. `VERSION` and manifest
   `"."` must equal `$VERSION`; the newest changelog heading and notes must
   describe it. Inspect raw outputs directly; no `jq` or new JSON parser.
   Tag verification matters: default installs and updates select stable Git
   tags, not GitHub Release objects, so a release page alone is insufficient.
   Do not install/update the operator's real installation as a check.

   Report the released tag, GitHub Release URL, and observed exact-commit
   Release/CI outcomes. Do not say “released” if only the PR merged, only a
   tag appeared, or post-merge checks failed. A published release with failed
   CI is “published with failed verification.”

5. **Diagnose and recover safely.** Inspect failed logs with
   `gh run view "$RUN_ID" --repo "$REPO" --log-failed`. After addressing the
   cause of an actually failed run, rerun only failures:
   `gh run rerun "$RUN_ID" --repo "$REPO" --failed`. To reprocess a successful
   run after correcting a confirmed release-please state or commit
   classification issue, rerun the relevant current-main run with
   `gh run rerun "$RUN_ID" --repo "$REPO"`. If `main` advanced, reselect its
   current run. Do not create empty commits or add workflow-dispatch features.

   The App workflow requires repository secrets `RELEASE_APP_CLIENT_ID` and
   `RELEASE_APP_PRIVATE_KEY`, an installed App with repository access, and
   contents/pull-request write permissions. Preserve the App-token design so
   automation-created PRs trigger CI. Credential/provisioning problems need a
   repository administrator; never print secret values or silently replace
   the App token with `GITHUB_TOKEN` or a personal token.

   For an absent PR, inspect releasable commit classification, latest Release
   logs, and merged/open PRs labeled `autorelease: pending`; stale labels can
   explain a stuck lifecycle. Never remove a pending label automatically when
   a release may still need publication. If diagnosis/rerunning does not fix
   it, report the specific state for administrator repair.

   For a merged PR with a missing release or partial tag/release state,
   inspect and rerun release-please, then repeat step 4. Never hand-create,
   move, or delete tags, or manually bump metadata. If recovery fails, report
   the PR, version, run URL, and exact partial state. For an already published
   bad version, leave its tag immutable; fix/revert through the normal change
   flow and publish the next release. Do not initiate that separate fix while
   diagnosing a failed release.

## AGENT_TOOLS

`AGENT_TOOLS` selects which agent CLIs are installed and verified —
comma-separated from `claude`, `codex`, `gemini`, `omp`; unset means all four.
`rtk`, `gh`, and Herdr are always installed. `adhd herdr` runs a Herdr client
on the host and connects to the Herdr server in the Dev Container. OMP
Superpowers requires `claude` selected and authenticated.

## Verifying a change

```bash
bun test
bun run typecheck
shellcheck install.sh bin/adhd libexec/adhd/*.sh libexec/adhd/herdr-bin/* .devcontainer/project-adhd/*.sh .devcontainer/project-adhd/lib/agent-tools.sh
```

`shellcheck` is not preinstalled in the container image; CI runs it. To run
it locally: `sudo apt-get update && sudo apt-get install -y shellcheck`.

`.devcontainer/project-adhd/verify.sh` checks the live environment and needs
authenticated CLIs. The contract suite does not — it stubs `PATH` under a
temporary `HOME` and never touches the network.
