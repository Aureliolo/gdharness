# gdharness

## Commands

| Command                                               | What it does                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| `bun run build`                                       | Bundles into `build/` without typechecking. Suites run this. |
| `bun run typecheck`                                   | `tsc --noEmit`.                                              |
| `bun run lint`                                        | Biome, types, dead code and markdownlint.                    |
| `bun run format:check`                                | Biome and Prettier.                                          |
| `bun run lint:gd`, `bun run format:gd:check`          | gdlint and gdformat on `src/godot` and `test/support/gd`.    |
| `bun run test:typed`                                  | Shipped scripts and fixtures, warnings as errors; Godot.     |
| `bun test/regressions.ts [name ...]`                  | Every regression; names select tests, loosely matched.       |
| `bun run test:ci`                                     | The eleven fast files, regressions included.                 |
| `test:integration`, `test:metadata`, `test:packaging` | The other four files the `build-and-test` job runs.          |
| `bun run test:engine`, `bun run test:editor`          | The engine and editor legs; need a real Godot.               |

Build before running a suite, because the suites start servers from the bundle. Engine-backed cases
need `GODOT_PATH`, and the gdUnit fixture needs `GDUNIT4_PATH`; without them those cases skip and say
so. `bun scripts/install-godot.ts` and `bun scripts/install-gdunit4.ts` fetch the pinned versions into
the temp directory and print where they landed.

Run `test:typed` after any GDScript change. gdlint and gdformat pass a script the engine refuses with
warnings as errors, and the regressions load the addons under the default warnings, so a local run
with the engine passed a runtime addon that failed to compile on the Linux engine leg. The fixtures
in `test/support/gd` compile under those settings too: one tried in a scratch project with default
warnings passed there and failed on the leg for discarding what `ItemList.add_item` returns.

`src/` is the TypeScript MCP server (entry points `server-entry.ts` and `cli.ts`), `src/godot/addons/`
holds the editor and runtime addons in GDScript, `test/` has one file per suite, and `scripts/` holds
the build, release and installer scripts. `docs/architecture.md` describes how the parts fit together.

## Tests

### Disarming

- Check a fixture by disarming what it guards: break the line on purpose, say which tests should
  notice before running them, then run and compare. `bun test/regressions.ts` keeps going after a
  failure and names every failure at the end, so one disarm shows every test that caught it.
- A disarm counts only when it fails on the assertion you aimed at. Read the message, not the exit
  code. `bun run build` does not typecheck, so a disarm that does not compile leaves the old bundle
  in place and the suite runs the unbroken code. An edit calling `writeFileSync` without importing
  it built clean, threw at run time and failed three assertions early. Run `bun run typecheck`
  before trusting a disarm.
- When a disarm passes, look at the setup before strengthening the assertion: the fixture reached
  the assertion without walking the broken line. The causes seen here:
  - The setup removes the state the fault needs. A decoy run record written to the wrong runtime
    directory left the disarmed server nothing to pick up, so it said "No game is running" and the
    pass proved only that the directory was empty.
  - The setup supplies the state the broken line would have computed. Three earlier fixtures each
    opened a debug adapter session as a side effect, and a session lasts as long as the server, so
    fixture order decided what the console timing case measured.
  - The input is the reproduction from the report, which is the shape that survived. The
    `@abstract` report used a script with `class_name` behind an annotation and `extends` on the
    next line; the second line set the insertion point by itself, so the fix was never exercised.
    The shape that breaks is a script whose whole header is the annotated line. Ask which other
    inputs reach the same line, and write the one where the line has nothing to fall back on.
  - A second guard covers the one you broke. Stripping trailing comments and counting bracket depth
    overlap exactly on `func noted(a: int) -> void:  # a comment with a bracket )`, so disarming the
    depth count passed. It is still needed: `func noted(a: int) -> void: print(a, ")")` is legal and
    only the depth count handles it. Disarm one line at a time, and when one passes, look for the
    input only that line handles.

  Fix the setup and disarm again.

- Sometimes the assertion is the problem because it reads the wrong property. A doubled-word check
  searched for the same word twice in a row; the fault was
  `the addon from before versions were reported addon`, nineteen words apart, and the disarm passed
  on it. Before changing the setup, ask
  which property the assertion reads and whether the broken and working versions differ in it.
- Ask the same of any check: what would make it fail on the thing it is meant to catch? If nothing
  could, it measures its own shape. The recorded-arguments check under "Disagreements" was one.
- Do not say which case catches a line without a disarm to show it. Such claims are usually guesses,
  and the line is often held by cases you had not credited.
- Some disarms cannot run: deleting a line leaves an unused parameter, a dead branch or a dangling
  import, and the gates refuse it. Use a smaller break the compiler accepts, and note that the gates
  hold the line as well as the test.
- A disarmed containment guard can escape. Give the disarmed run somewhere harmless to escape to
  before running it.

### Writing assertions

- Never assert only what did not happen. A `doesNotMatch` against the complaint you expect is
  satisfied by a crash, a timeout and every other refusal. Assert what the call returns when it
  works.
- When the finding is an absence (nothing written, killed or changed), pair it with a positive in the
  same fixture showing the code ran. The guard keeping test servers out of the real runtime directory
  was once checked by watching that directory not grow, which a suite that had stopped starting
  servers also passes. Assert the record it wrote, then that it wrote it nowhere else.
- Assert the invariant, not the reading. A case that encodes a measurement or a conclusion keeps it
  in force after the evidence is gone. A report that a stale type was cured by editing the declaring
  script went into three sentences and a case requiring all three. When the reporting project
  retracted it, fixing the sentences failed the suite, so they stayed wrong for two releases. The
  rewrite holds only what does not depend on the remedy: nothing tells a caller to edit source that
  is already correct.
- Check the output, not the inputs. A case comparing generated tool names against the schemas passed
  on two renderings of one sentence, one of which escaped every backtick, because the markup sits
  between the names. A case reading `src/server.ts` for remedy sentences could not see the one built
  from parts at run time. Render it, call it, and assert what comes back.
- Render the branches no reproduction reaches: a plural argument, an empty list, a second entry. The
  note on which script to reload told callers to pass two paths comma-separated to an argument that
  takes one string, and it was found only by rendering the two-type case.
- Name the thing being checked in terms that survive it improving, and take everything else as an
  argument. A check split a document on a marker that appeared only while a notice was printed; the
  notice was removed and the case failed as if the feature had regressed.
- When a count is stated twice, hold every statement of it. `docs/architecture.md` gives the number
  of harnesses that read their own skills directory twice, one line apart, and only the first was
  checked.
- Changing a test to fit the code is allowed in one case: the test asserts a state that cannot occur.
  A fixture wrote a record claiming its run began a minute before the process it had just spawned,
  although one call does both. Correct the setup, keep the assertions, and say in the change why the
  state was unreachable.
- A case that needs something the machine has only one of, such as window focus, fails for reasons
  outside it. The windowed menu case needs the game window to keep focus for thirty frames, and an
  editor for another project opening mid-run failed it with `window focus_exited` in the log. Do not
  loosen it. Say in the case what it needs, and have the assertion report lost focus as the
  desktop's doing rather than an input fault.

### Sets, floors and counts

- Walk the directory rather than listing files. The gate on tool names in prose listed three of five
  documents, one of the skill's two files (not the generated reference, which a rename rewrites) and
  no GDScript.
- A derived set can still be wrong. The same gate derived its excused words from the `.gd`
  filenames, and two modules are named after their tools, so `runtime_capture` and `runtime_input`
  were excused everywhere. After deriving a set, ask what the derivation removes from what is being
  checked.
- Read every count that feeds a floor on every change, and ask which way the change should move it.
  The fault above was found because the mention count fell from 427 to 422 after a change that only
  added sources.
- Set a floor to what the file holds today, not a comfortable minimum. A floor of 25 on a table of
  31 misses six entries silently going. Removing an entry then means lowering the floor in the same
  change. Disarm a floor by reading one entry fewer, not none.
- A check that loops over the list it checks tests less when an entry is dropped, and still passes.

### Disagreements, faults and the platform

- Code that runs only when something is wrong is not exercised by runs that go well. Put the system
  into the mismatch, fault or timeout on purpose and read the output. The refusal for a game
  announcing an unreadable protocol consulted a sweep that drops those announcements, so it gave
  advice that would end the run it was refusing, while a function written for that state sat unused
  twenty lines away. It was found by bumping a protocol constant for another reason.
- Hold that state by taking the disagreeing thing as an argument, the way `judgeRun` is given the
  operating system's answer. A port reservation fixture asked the real kernel for forty ports, got
  forty different ones, and still passed with the deduplication removed.
- To check identity, test the closest thing that is not the target. The check before `process.kill`
  compared the engine basename and the project path, and every case was something unrelated. The
  project's editor matches both and is the process most likely to reuse the pid, so it was confirmed
  and killed. Treat the answer as a set: ostinato's thirty-one bench workers also share the
  executable and `--path`, with no editor flag.
- When every compared property is shared across a family, adding more of the same kind does not
  help. The recorded arguments matched the workers too, because their command line is a superset.
  Find a property no sibling can have: the process start time, because a pid cannot be reissued
  until its holder has gone.
- Size a tolerance to what it absorbs, then ask what falls inside it that should not. A
  ninety-second start-time window, described as generous against clock skew, missed every run
  shorter than ninety seconds, which is how the bench workers run.
- Assert a platform-supplied property whose absence would be silent. Start time is read three ways
  on three platforms and every judging case hands it in, so a platform that never produced one would
  have passed everything. One case asks a real process and requires an answer.
- A best-effort reading that says when it fails is different. Processor time uses a PowerShell call
  with a two-second budget, which a loaded Windows runner exceeds. Assert that the question went to
  the right process (the number, or the note that the platform did not answer), and identify the
  process by a field the platform does not supply.
- A stand-in for a real process has behaviour of its own. Node children on Windows sit in the
  parent's job object and die with it; Godot workers from `OS.create_process` do not, so a case meant
  to measure orphans measured the job object. Start stand-ins detached, and ask which behaviours are
  the stand-in's own.

### State, caches and events

- A message describing its own work must be written after the work. A line announcing a kill was
  printed before the signal, so for runs already over it reported a kill that never happened. Read
  the output and check whether the work had happened yet.
- Before interpreting a measurement, ask which result would have contradicted it. Two lists both
  showing a new method cannot tell one cache from two; that needs one moment where one is stale and
  the other is not. The note that a built copy was stale while diagnostics read clean compared a
  read before a reload with a read after it, and taking both in the same window confirmed it.
- A cached reading's timestamp decides whether to read again, so a wrong reading blocks its own
  correction, and a shared cache makes this worse. The update check once kept a result for four
  hours in one file per user, so a server starting at 19:00 used a 17:07 reading and missed two
  releases. For anything timestamped, compare the window with how often the source changes, and
  decide separately whether a newly started process should inherit it. A fixture with its own copy
  of the window stops testing the boundary when the window changes.
- For a two-step act where the process can be replaced between the steps, write the intent where the
  next process reads it before the first step, and have whatever completes or cancels the act remove
  it. The editor restart quits and then starts the editor; a reconnect in between left a successor
  that saw nothing connected and said an editor might still dial in. The user's reconnect is the
  usual replacement.
- A replacement process misses events the old one saw. The debug adapter reports a stop only to
  sessions connected at the time; a later session asking for the stack gets a thread and no frames
  while the game sits at a breakpoint, and the code read that as running. When state comes from an
  event, ask what a process that missed it is told. If nothing, treat it as a third state and find
  another source; here the runtime, which `editor_status` already used.
- Check that a measurement distinguished the property a fix depends on. The write-up said the
  session was attached when the property that mattered was being connected. A server playing a scene
  through the editor is connected but does not attach until its first stack read, so the fix sent
  the ordinary case to the runtime.
- Do not trust a comment saying a source never sends something, because nothing will handle it.
  Godot sends `continued` to every connection when a game is released, and `breakpoint` events with
  `reason: "removed"`. Log every event the other side sends during one fixture run and read the log.
  When something is set and then consumed by a play, a run or a request, set it once and use it
  twice.
- Test the effect, not the stored value. Godot clears every editor breakpoint when a debug session
  opens unless one setting is off. Writing that setting read back fine, but the adapter rereads it
  only on a notification the settings dialog sends after Apply, so nothing changed. The fixture that
  caught it opened a second session and read what the adapter sent.

### After a change

- Run the change and read what comes out, especially your own change with a good argument behind
  it. `terminateDebuggee: false` was reasoned from the protocol and given to the reporting project as
  the fix for an editor-played game ending on reconnect. Godot's adapter ignores the field; only
  skipping the disconnect request saved the game.
- After a fix, look for answers elsewhere that were right only because the fault existed. Once played
  games survived a reconnect, the refusal that cannot see a played game (the addon takes about thirty
  seconds to dial back in) went from rare to routine.
- A fix that makes something survive creates states nothing has exercised. A replacement server
  meeting a live editor-played run could not be tested until the shutdown stopped killing those
  runs. Ask what now happens to the thing that survives.

### Running suites

- Do not edit or build while a suite runs. Each fixture starts a server from the bundle, so a build
  mid-run hands later fixtures a half-written file, and their failures look like faults in the tools
  they called. Rerun any suite that failed beside a build.
- Run what CI runs before calling a change done: `test:ci`, `test:integration`, `test:metadata` and
  `test:packaging`, fifteen files in all. They call the same code in different ways: a sentence
  change passed the regressions and failed `test/bridge.ts` on the push.
- Redirect a run's output to a file and read the file. `| tail` loses the message, and a failure that
  never repeats leaves nothing else behind.

## Releasing

Work the tracker to empty, then ship. When issues are open, fix all of them, then cut a release
carrying the fixes rather than leaving them sitting on `main` unreleased. A fix nobody can install
is not delivered.

A report must not stand between an irreversible act and the work that depends on it. The release
takes three acts that cannot be taken back, and the step comparing what npm serves against the
signed archive sat inside the npm job, after the publish. On 1.0.11 npm took 7m11s to serve the
version against a five-minute window, the job went red, and the two jobs behind it were skipped for
needing that job rather than that step: the MCP registry entry and the install checks on three
platforms. The listing every marketplace reads stayed a release behind, and the registry entry for
that version can never be made, because publishing there happens once. Widening the window makes it
rarer and leaves the shape alone. Ask of every such step whether what comes next depends on the act
or on the report of it, and move the report out.

Then ask the same question of each act on its own: can this run be run again? All three refused to
act on something already done, so a release run that failed anywhere after the first publish could
not be re-run at all, and the tag workflow, dispatched by hand on a tag that already existed, said
"nothing to do" and exited without starting the release, which is exactly the state somebody
presses that button in.

**Every release is a patch.** From 1.0.0 the next version is 1.0.1, then 1.0.2, and so on: a fix,
an addition nothing has to adapt to, a new argument, a new field in an answer, a new tool, a new op,
all of them patches. The owner set this on 2026-09-21 as a standing rule, and it replaces the
patch-or-minor judgement that held before 1.0.

A wrong answer corrected is a patch even when the output changes shape. Never leave an answer wrong
to protect a caller who parsed it, and never let "that would be breaking" become a reason to ship a
tool that lies. The surface is worth less than the answers being right, and that is the one trade
this project does not make. `.github/CONTRIBUTING.md` states this publicly, so keep the two in step.

**Never cut a minor without the owner's approval, given for that release.** `minor` on the
"Prepare release" workflow is run only when the owner has said so for the release in hand, in their
own words, after being asked directly; a change that looks like it deserves one is still a patch
until then. **Never cut a major, and never ask for one.** `major` and an exact `2.0.0` are not
options here, however ready anything looks; a rename or a removal is not made.

Cut releases through the button rather than by hand: run the "Prepare release" workflow with the
bump, merge the pull request it opens, and `release-tag.yml` tags whatever version lands on
`main`.

Merge nothing else while a release pull request is open. The ruleset on `main` requires branches to
be up to date, so every other merge puts the release branch behind and costs it all thirteen checks
again, three of them engine legs. On 2026-09-20 five pull requests went in while one release sat
open, and it took four rounds of updating and re-running to land. Cut the release last, let it
through, then carry on. It is a convention rather than a setting, and it costs nothing: the work is
already done by the time the release is cut.

Read that requirement from the rulesets rather than from branch protection. `gh api
repos/.../branches/main/protection` answers 404 here, which reads as "nothing is enforced" and is
wrong: the rules live in `gh api repos/.../rulesets`, and `strict` on the required checks is the
line that makes this matter.

Read a commit's subject back after writing it. Twelve of the nineteen commits between v0.13.36 and
v0.13.37 have the subject `@`, because the message was written as a PowerShell here-string,
`-m @'...'@`, through a POSIX shell, where `@'` is a literal `@` and a quote. Every one of those
commits succeeded, and the fault was found downstream by somebody reading `git log` to see what an
upgrade brought. The repository squashes with the pull request's title and body now, so a branch
subject cannot reach `main` again, but the branch commits are what a reviewer reads:
`-m "Subject" -m "Body"`, or a heredoc, and then `git log -1 --format=%s`.
