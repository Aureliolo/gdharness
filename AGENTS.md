# gdharness

## Commands

| Command                                                   | What it does                                                                                                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run build`                                           | Bundles into `build/` without typechecking. `ci`, `test:metadata`, `test:packaging` and `test:node-runtime` run it first. `test:ci` and the regressions do not. |
| `bun run typecheck`                                       | `tsc --noEmit`.                                                                                                                                                 |
| `bun run ci`                                              | Build, typecheck, `format:check`, `lint` and `test:ci`, in that order.                                                                                          |
| `bun run lint`                                            | Biome, types, dead code and markdownlint.                                                                                                                       |
| `bun run format:check`                                    | Biome and Prettier.                                                                                                                                             |
| `bun run lint:gd`, `bun run format:gd:check`              | The pinned gdstyle with the lane's `gdstyle.toml`, on every script under `src/godot` and `test/support/gd`.                                                     |
| `uv run yamllint --strict .`                              | The `yaml` job.                                                                                                                                                 |
| `bun run format`, `bun run lint:fix`, `bun run format:gd` | Write the fixes.                                                                                                                                                |

## Test commands

| Command                                               | What it does                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `bun run test:typed`                                  | Shipped scripts and fixtures in Godot, warnings as errors.                               |
| `bun test/regressions.ts [name ...]`                  | Every regression. Names select tests, loosely matched.                                   |
| `bun run test:ci`                                     | The eleven fast files, regressions included.                                             |
| `test:integration`, `test:metadata`, `test:packaging` | The other four files the `build-and-test` job runs. `test:packaging` refuses on Windows. |
| `bun run test:engine`, `bun run test:editor`          | The engine and editor legs. They need a real Godot.                                      |

## Setup

Set up with `bun install`, `bun scripts/install-gdstyle.ts` and `uv sync --locked`. The second puts
the pinned gdstyle in `tools` under gdharness's cache folder, beside the engine slots, where the
GDScript gates look for it. The third puts the pinned yamllint in `.venv`. `uv run` takes that copy
before any on `PATH`. `gdstyle.toml` is copied byte for byte from the lane, where a change to it is
made first.

## Engines and fixtures

Build before running a suite, because the suites start servers from the bundle. Engine-backed cases
need `GODOT_PATH` and the gdUnit fixture `GDUNIT4_PATH`. Without them those cases skip and say so.
The engine legs set `GDHARNESS_REQUIRE_GODOT=1`, which turns those skips into failures. Windowed
regressions skip unless `GDHARNESS_ALLOW_WINDOWS` is set.

`bun scripts/install-godot.ts` and `bun scripts/install-gdunit4.ts` fetch the pinned versions into
the same cache folder and print where they landed. CI keeps them in the runner's temporary folder.
Anywhere else a temporary folder is swept, taking the engine from every session whose `GODOT_PATH`
names it.

## Protocol

The server speaks the 2026-07-28 protocol only, as Claude Code does. `ServerProcess` opens with
`server/discover` and puts the envelope on every request. `test/smoke.ts` checks that a 2025
`initialize` gets the unsupported-protocol-version error naming 2026-07-28.

## GDScript

`.claude/rules/gdscript.md` holds the GDScript rules: the typed gate, the `Gdh` prefix and the shared
modules. It loads with any file under `src/godot` or `test/support/gd`.

## Layout

`src/` is the TypeScript MCP server. Its entry point is `cli.ts`, which serves stdio when given no
command. Every tool is one entry in `src/tool-definitions.ts`. The server dispatches from it. The
site and the skill render their tool reference from it.

`src/godot/addons/` holds the editor, runtime and auto-reload addons. `src/godot/operations/` holds
the headless engine operations. Both are GDScript. `test/` holds the suites, with shared helpers in
`test/support/`. `scripts/` holds the build, release and installer scripts.

`docs/architecture.md` describes how the parts fit together. The repository map in
`.github/CONTRIBUTING.md` names the main modules.

## Tests

`.claude/rules/tests.md` holds how to write, disarm and check a case. It loads with any file under
`test/`.

### Running suites

- Do not edit or build while a suite runs. A build mid-run hands later fixtures a half-written file,
  because each fixture starts a server from the bundle.
- Rerun any suite that failed beside a build.
- Redirect a run's output to a file under `$TEMP` or the scratchpad and read the file. `| tail`
  loses the message, and a failure that never repeats leaves nothing else behind.

### CI and local runs

- CI runs the suites, since the repository is public. Push and read every suite CI runs before
  calling a change done: `test:ci`, `test:integration`, `test:metadata` and `test:packaging`,
  fifteen files in all, plus the engine and editor legs.
- Locally, run the regressions and editor cases the change touches. A change that passes the
  regressions can still fail `test/bridge.ts`, because the suites call the same code in different
  ways.
- Locally, run engines headless and leave the windowed cases to CI. Do not set
  `GDHARNESS_ALLOW_WINDOWS` on a desktop someone is using.
- Do not call `editor_run start` through a local probe editor, because a headless editor still opens
  a window for the game it plays. Measure played-game behaviour with the `withAPlayingEditor` fixture,
  which starts the game with `--headless`.

## Releasing

### When to release

Work the tracker to empty, then ship. When issues are open, fix all of them, then cut a release
carrying the fixes. A fix nobody can install is not delivered.

Cut a release only when nothing known is open or in flight. That covers the tracker, unanswered
reports from the owner's downstream projects, and your own findings. A finding that arrives while a
release is being prepared stops that release until it is fixed.

A change only to `AGENTS.md`, `.github/*.md`, `docs/` or the README gets no release of
its own and goes out with the next one. The skill and the tool reference ship in the package and
count as code.

### Batches

Release in batches, not per fix. Every release raises the pin in each game, and each raise costs
that game a whole gate of an hour or more. Merge fixes as they are done. Cut a release once the
batch holds something a game needs, such as a fix a game reported or a fault a game would hit.
A release that changes nothing a game runs, such as a description alone, waits for the next one.

### Whose issues

Issues from the owner, reports from the owner's downstream projects and your own findings are
implemented directly. Read an issue filed by anyone else and reproduce it if that is cheap. Put the
finding to the owner with a recommendation instead of a pull request. Tell them apart by the issue's
author, not its content.

### Versions

**Every release is a patch.** A patch raises only the last number. Fixes, additions nothing has to
adapt to, new arguments, new answer fields, new tools and new ops are all patches. This is the
owner's standing rule.

A wrong answer corrected is a patch even when the output changes shape. Never leave an answer wrong
to protect a caller who parsed it. Never keep a tool lying because a fix would be breaking. The
surface is worth less than the answers being right. `.github/CONTRIBUTING.md` states this
publicly, so keep the two in step.

### Minor and major

**Never cut a minor without the owner's approval, given for that release.** Run `minor` on the
"Prepare release" workflow only when the owner has said so for the release in hand. That approval
comes in the owner's own words, after being asked directly. A change that looks like it deserves a
minor is still a patch until then.

**Never cut a major, and never ask for one.** Neither `major` nor an exact `2.0.0` is an option here,
however ready anything looks.

### Older releases

Nothing is kept working for an older release while gdharness has no users outside the owner's own
projects. The server and the addons of one release work with each other only. An editor or a game
on another release's addon is refused with the command that brings it into step. No fallback, alias
or old reading is kept for it. A rename or a removal goes out in a minor the owner approved, as
`.github/CONTRIBUTING.md` says under Versions.

### Release workflows

`.claude/rules/release-workflows.md` holds the rules for changing the release workflows. It loads
with any file under `.github/workflows`.

### Cutting a release

Cut releases through the button rather than by hand. Run the "Prepare release" workflow with the
bump and merge the pull request it opens. `release-tag.yml` tags whatever version lands on `main`.
`.github/release-process.md` covers how a release is cut, signed and verified.

Merge nothing else while a release pull request is open. Every other merge costs the release branch
all fourteen checks again, since the ruleset on `main` requires up-to-date branches. Cut the release
last, let it through, then carry on. This is a convention rather than a setting. It costs nothing
because the work is done by the time the release is cut.

### Rulesets

Read that requirement from the rulesets rather than from branch protection.
`gh api repos/Aureliolo/gdharness/branches/main/protection` answers 404, which reads as "nothing is
enforced" and is wrong. The rules live in `gh api repos/Aureliolo/gdharness/rulesets`, where
`strict` on the required checks is the line that matters.

The same rule is why the fixes from one stretch of work go into one pull request. Every merge sends
each other open pull request through CI again. GitHub offers merge queues only to repositories owned
by an organisation.

### Merging

Merge your own pull request with `gh pr merge <n> --squash --delete-branch` as soon as every
required check passes, because the merge is part of the work. A release pull request's runs wait for
approval, because the workflow's token opened it. They report `status: completed` with
`conclusion: action_required`. Select on the conclusion, approve each with
`gh api -X POST repos/Aureliolo/gdharness/actions/runs/<id>/approve`, and merge once the checks
pass.

Before approval the pull request lists only the CodeQL contexts, so "nothing pending" is not "every
check passed".

### After a merge

Follow `main`'s own `ci.yml` run to its end, because a green pull request does not make a green
`main`. Because `ci.yml` cancels a run in progress on the same ref, a release merge cancels the run
for the fix merged before it. Follow the run on the release commit. Cut the release without waiting
for `main`'s run, since the release pull request runs the same checks on the same code. A failure on
`main` is root-caused before anything else merges.

### Commit subjects

Read a commit's subject back after writing it, with `git log -1 --format=%s`. A PowerShell
here-string, `-m @'...'@`, passed through a POSIX shell commits with the subject `@` and still
succeeds. Write `-m "Subject" -m "Body"`, or a heredoc. A branch subject never reaches `main`, since
pull requests squash with their title and body. The branch commits are still what a reviewer reads.
