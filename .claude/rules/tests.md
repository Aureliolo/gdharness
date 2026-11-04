---
paths:
  - 'test/**'
---

# Writing and checking tests

## Disarming

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

## Disarms that cannot run or can escape

- When deleting a line leaves an unused parameter, a dead branch or a dangling import, use a
  smaller break the compiler accepts. Note that the gates hold that line as well as the test.
- A disarmed containment guard can escape. Give the disarmed run somewhere harmless to escape to
  before running it.

## When a disarm passes

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

## When the assertion is the problem

- An assertion can read the wrong property. Before changing the setup, ask which property it reads
  and whether the broken and working versions differ in it.
- Ask of any check what would make it fail on the thing it is meant to catch. If nothing could, it
  measures its own shape.

## Writing assertions

- Assert what a call returns when it works, never only what did not happen. A `doesNotMatch`
  against the expected complaint also passes on a crash, a timeout or any other refusal.
- Pair an absence (nothing written, killed or changed) with a positive in the same fixture showing
  the code ran. A fixture that never ran shows the same absence.
- Assert the record a guard wrote, then that it wrote it nowhere else.
- Assert the invariant, not the reading. A case encoding a measurement or a conclusion keeps it in
  force after the evidence is gone and fails the correction.

## Checking output

- To check the output, render it, call it and assert what comes back. A read of the source misses
  the markup between names and the sentences built at run time.
- Render the branches no reproduction reaches, such as a plural argument, an empty list or a second
  entry. Only the two-type rendering showed a note asking for two paths in a one-string argument.
- When a count is stated twice, hold every statement of it. A check on the first leaves the second
  free to drift.

## Changing a case

- Name the thing being checked in terms that survive it improving. Take everything else as an
  argument, since a check that splits a document on a notice's marker fails when the notice goes.
- Change a test to fit the code only when it asserts an impossible state, such as a run recorded
  as starting before its own process. Correct the setup, keep the assertions, and say in
  the change why the state was unreachable.
- Do not loosen a case needing something the machine has only one of, such as the windowed menu
  case's thirty frames of focus. Say in the case what it needs and report lost focus
  (`window focus_exited`) as the desktop's doing rather than an input fault.

## Sets, floors and counts

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

## Faults and disagreements

- Code that runs only when something is wrong is not exercised by runs that go well. Put the system
  into the mismatch, fault or timeout on purpose and read the output.
- Hold that state by taking the disagreeing thing as an argument, the way `judgeRun` is given the
  operating system's answer. A fixture asking the real kernel for forty ports gets forty different
  ones even with the deduplication removed.
- Size a tolerance to what it absorbs, then ask what falls inside it that should not. A
  ninety-second start-time window misses every run shorter than ninety seconds, which is how bench
  workers run.

## Identity

- To check identity, test the closest thing that is not the target. A check on the engine basename
  and project path before a kill also matches the project's editor, the likeliest process to reuse
  the pid.
- Treat the answer as a set. A project's bench workers share the executable and `--path` too, with
  no editor flag.
- When every compared property is shared across a family, more of the same kind does not help. Find
  a property no sibling can have, such as the process start time, since a pid cannot be reissued
  until its holder has gone.

## The platform

- Assert a platform-supplied property whose absence would be silent. Since every judging case hands
  in a start time read three ways on three platforms, one case asks a real process for it.
- Processor time from a budgeted PowerShell query is a best-effort reading that passes with a number
  or a note saying it failed. Assert that it asked the right process, named by a field the platform
  does not supply.
- Start a stand-in for a real process detached and ask which of its behaviours are its own. Node
  children on Windows die with the parent's job object, while Godot workers started by
  `create_process` do not.

## Messages and measurements

- A message describing its own work is written after the work. Read the output and check whether
  the work had happened yet, since a message printed before can report a kill that never happened.
- Before interpreting a measurement, ask which result would have contradicted it. Take both readings
  in the same window, since telling one cache from two needs one moment where only one is stale.
- Check that a measurement distinguished the property a fix depends on. A server playing a scene
  through the editor is connected but attaches only at its first stack read.

## Caches and replacement processes

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

## Events

- A replacement process misses events the old one saw. When it is told nothing about one, treat
  that as a third state with another source.
- The debug adapter reports a stop only to the sessions connected then. A later one sees a thread
  with no frames at a breakpoint, and the runtime, which `editor_status` already reads, answers it.
- Do not trust a comment saying a source never sends something. Log every event the other side
  sends during one fixture run and read the log.
- Godot sends `continued` to every connection when a game is released. It also sends `breakpoint`
  events with `reason: "removed"`.

## Settings and consumed state

- When something is set and then consumed by a play, a run or a request, set it once and use it
  twice.
- Test the effect, not the stored value. The setting that stops Godot clearing editor breakpoints
  reads back fine when written, while the adapter rereads it only after the settings dialog's Apply.

## After a change

- Run the change and read what comes out, especially your own change with a good argument behind
  it. Godot's adapter ignores `terminateDebuggee: false`, although the protocol suggests it.
- After a fix, look for answers elsewhere that were right only because the fault existed. Once
  played games survive a reconnect, the refusal that cannot see one during the addon's thirty
  seconds to dial back in becomes routine.
- A fix that makes something survive creates states nothing has exercised. Ask what now happens to
  the thing that survives, such as a replacement server meeting a live editor-played run.
