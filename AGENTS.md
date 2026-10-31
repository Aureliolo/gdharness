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

Run `test:typed` after any GDScript change. gdstyle passes a script the engine refuses with warnings
as errors. The regressions load the addons under the default warnings. A runtime addon can pass them
locally and fail to compile on the Linux engine leg. The fixtures in `test/support/gd` must also
compile under the strict settings, not only in a scratch project with default warnings.

Every name a shipped script declares in a class's casing (a preloaded module, an inner class, an
enum) starts with `Gdh`. Godot resolves a type as the project's global class or autoload before the
script's own constant. A game with `class_name Log` or an autoload called `Log` breaks every module
that preloads its logger as `Log`. The engine leg's `ourNames` case refuses a name without the
prefix. It also compiles the shipped scripts beside a class and an autoload for each name.

## Shared modules and packaging

The modules listed in `scripts/sync-shared-gd.ts` (`reading.gd`, `serialisation.gd`,
`value_shapes.gd`, `property_values.gd`, `property_paths.gd`, `declared_values.gd`,
`same_values.gd`, `file_reads.gd`, `file_walk.gd`, `animation_reads.gd` and `setting_reads.gd`) are
edited in `src/godot/operations/` only. `bun run sync:gd` writes the copies inside the addons. A
regression fails on a copy that has drifted.

Commit the `.gd.uid` Godot writes beside every new addon script. Add a new operations module to the
list in `test/packaging-consistency.ts`. `test:packaging` checks both, on Linux and macOS only. From
Windows, the push is the first run that sees them.

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

### Disarming

- Check a fixture by disarming what it guards. Break the line on purpose, say which tests should
  notice before running them, then run and compare.
- `bun test/regressions.ts` keeps going after a failure and names every failure at the end. One
  disarm therefore shows every test that caught it.
- A disarm counts only when it fails on the assertion you aimed at. Read the message, not the exit
  code.
- A disarm that does not compile leaves the old bundle in place, since `bun run build` does not
  typecheck. Run `bun run typecheck` before trusting a disarm.
- Do not say which case catches a line without a disarm to show it. Such a claim is usually a guess
  that misses cases you had not credited.

### Disarms that cannot run or can escape

- When deleting a line leaves an unused parameter, a dead branch or a dangling import, use a
  smaller break the compiler accepts. Note that the gates hold that line as well as the test.
- A disarmed containment guard can escape. Give the disarmed run somewhere harmless to escape to
  before running it.

### When a disarm passes

A passing disarm usually means the fixture never walked the broken line. Fix the setup before the
assertion, then disarm again. The causes seen here:

- The setup removes the state the fault needs. A disarmed server whose decoy run record sat in the
  wrong directory passed on an empty directory.
- The setup supplies the state the broken line would have computed. Earlier fixtures that left a
  debug adapter session open decided what the console timing case measured.
- The input is the report's reproduction, the shape that survived. Write the input where the line
  has nothing to fall back on, such as a script whose whole header is the `@abstract` line.
- A second guard can cover the one you broke, so disarm one line at a time. For a pass, look for the
  input only that line handles, such as `func noted(a: int) -> void: print(a, ")")` for the bracket
  depth.

### When the assertion is the problem

- An assertion can read the wrong property. Before changing the setup, ask which property it reads
  and whether the broken and working versions differ in it.
- Ask of any check what would make it fail on the thing it is meant to catch. If nothing could, it
  measures its own shape.

### Writing assertions

- Assert what a call returns when it works, never only what did not happen. A `doesNotMatch`
  against the expected complaint also passes on a crash, a timeout or any other refusal.
- Pair an absence (nothing written, killed or changed) with a positive in the same fixture showing
  the code ran. A fixture that never ran shows the same absence.
- Assert the record a guard wrote, then that it wrote it nowhere else.
- Assert the invariant, not the reading. A case encoding a measurement or a conclusion keeps it in
  force after the evidence is gone and fails the correction.

### Checking output

- To check the output, render it, call it and assert what comes back. A read of the source misses
  the markup between names and the sentences built at run time.
- Render the branches no reproduction reaches, such as a plural argument, an empty list or a second
  entry. Only the two-type rendering showed a note asking for two paths in a one-string argument.
- When a count is stated twice, hold every statement of it. A check on the first leaves the second
  free to drift.

### Changing a case

- Name the thing being checked in terms that survive it improving. Take everything else as an
  argument, since a check that splits a document on a notice's marker fails when the notice goes.
- Change a test to fit the code only when it asserts an impossible state, such as a run recorded
  as starting before its own process. Correct the setup, keep the assertions, and say in
  the change why the state was unreachable.
- Do not loosen a case needing something the machine has only one of, such as the windowed menu
  case's thirty frames of focus. Say in the case what it needs and report lost focus
  (`window focus_exited`) as the desktop's doing rather than an input fault.

### Sets, floors and counts

- Walk the directory rather than listing files. A list misses every file nobody added to it.
- Ask what deriving a set removes from what is checked. Excusing the `.gd` filenames also excuses
  the tools `runtime_capture` and `runtime_input`, since two modules share their tools' names.
- On every change, read each count that feeds a floor and ask which way the change should move it.
  A count that falls after a change that only added sources shows a fault.
- Set a floor to what the file holds today, not a comfortable minimum. A floor of 25 on a table of
  31 misses six entries going.
- Removing an entry means lowering the floor in the same change. Disarm a floor by reading one entry
  fewer, not none.
- A check that loops over the list it checks tests less when an entry is dropped, and still passes.

### Faults and disagreements

- Code that runs only when something is wrong is not exercised by runs that go well. Put the system
  into the mismatch, fault or timeout on purpose and read the output.
- Hold that state by taking the disagreeing thing as an argument, the way `judgeRun` is given the
  operating system's answer. A fixture asking the real kernel for forty ports gets forty different
  ones even with the deduplication removed.
- Size a tolerance to what it absorbs, then ask what falls inside it that should not. A
  ninety-second start-time window misses every run shorter than ninety seconds, which is how bench
  workers run.

### Identity

- To check identity, test the closest thing that is not the target. A check on the engine basename
  and project path before a kill also matches the project's editor, the likeliest process to reuse
  the pid.
- Treat the answer as a set. A project's bench workers share the executable and `--path` too, with
  no editor flag.
- When every compared property is shared across a family, more of the same kind does not help. Find
  a property no sibling can have, such as the process start time, since a pid cannot be reissued
  until its holder has gone.

### The platform

- Assert a platform-supplied property whose absence would be silent. Since every judging case hands
  in a start time read three ways on three platforms, one case asks a real process for it.
- Processor time from a budgeted PowerShell query is a best-effort reading that passes with a number
  or a note saying it failed. Assert that it asked the right process, named by a field the platform
  does not supply.
- Start a stand-in for a real process detached and ask which of its behaviours are its own. Node
  children on Windows die with the parent's job object, while Godot workers started by
  `create_process` do not.

### Messages and measurements

- A message describing its own work is written after the work. Read the output and check whether
  the work had happened yet, since a message printed before can report a kill that never happened.
- Before interpreting a measurement, ask which result would have contradicted it. Take both readings
  in the same window, since telling one cache from two needs one moment where only one is stale.
- Check that a measurement distinguished the property a fix depends on. A server playing a scene
  through the editor is connected but attaches only at its first stack read.

### Caches and replacement processes

- A wrong cached reading blocks its own correction, because its timestamp decides whether to read
  again. Compare the window with how often the source changes and decide separately whether a newly
  started process inherits a shared one.
- Read a cache window into a fixture rather than copying it. A copy stops testing the boundary when
  the window changes.
- Before the first step of a two-step act, write its intent where a replacement process reads it.
  Whatever completes or cancels the act removes the intent, since a user's reconnect can land
  between the editor restart's quit and its start.
- A server stops at its next successor check, ten seconds on, once a new test server claims its
  project at process start. Spawn a second server for a project where it is used, after
  the state it should meet.

### Events

- A replacement process misses events the old one saw. When it is told nothing about one, treat
  that as a third state with another source.
- The debug adapter reports a stop only to the sessions connected then. A later one sees a thread
  with no frames at a breakpoint, and the runtime, which `editor_status` already reads, answers it.
- Do not trust a comment saying a source never sends something. Log every event the other side
  sends during one fixture run and read the log.
- Godot sends `continued` to every connection when a game is released. It also sends `breakpoint`
  events with `reason: "removed"`.

### Settings and consumed state

- When something is set and then consumed by a play, a run or a request, set it once and use it
  twice.
- Test the effect, not the stored value. The setting that stops Godot clearing editor breakpoints
  reads back fine when written, while the adapter rereads it only after the settings dialog's Apply.

### After a change

- Run the change and read what comes out, especially your own change with a good argument behind
  it. Godot's adapter ignores `terminateDebuggee: false`, although the protocol suggests it.
- After a fix, look for answers elsewhere that were right only because the fault existed. Once
  played games survive a reconnect, the refusal that cannot see one during the addon's thirty
  seconds to dial back in becomes routine.
- A fix that makes something survive creates states nothing has exercised. Ask what now happens to
  the thing that survives, such as a replacement server meeting a live editor-played run.

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

### Reports after an irreversible act

A report must not stand between an irreversible act and the work that depends on it. The release
takes three acts that cannot be taken back, such as the MCP registry entry a version gets only once.
For every step after one of them, ask whether it depends on the act or on the report of it. Give the
report its own job rather than a wider timeout. `served` in `release.yml` checks what npm serves
without holding back the registry entry or the install checks.

### Runs that can be run again

Ask of each act whether its run can be run again. An act that refuses something already done makes
a run that failed after the first publish impossible to re-run. A hand-dispatched tag workflow that
stops on an existing tag does nothing in exactly the state somebody presses that button in. Take
what is already done as done and carry on.

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
