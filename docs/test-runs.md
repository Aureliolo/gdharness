# Test runs

`gdharness test` runs a project's gdUnit4 suites over several engines and judges everything they
print. It is the command a game's gate runs, so every game runs its suites the same way. Each engine
waits for one of the machine's engine slots, is ended when it goes silent, and is judged on its
output line by line rather than on its exit code.

It needs gdUnit4 6.0 or later under `addons/gdUnit4`, and finds Godot the way the rest of the CLI
does: `GODOT_PATH`, then the usual places.

```text
gdharness test                         every suite under tests/ and test/
gdharness test path/to/game            the same, for a project elsewhere
gdharness test tests/combat            every suite in a directory
gdharness test tests/a_test.gd         one suite
gdharness test tests/a_test.gd:test_x  one case
```

It exits 0 when every case passed and nothing else was wrong, 1 when anything failed, and 2 when the
command line itself is wrong.

- `--engines N`: at most this many engines, 4 by default.
- `--slots DIR`: the slot directory, the machine's own by default (see
  [Engine slots](#engine-slots)).
- `--slot-count N`: how many slots that directory has; by default a fifth of the processors, at
  least one.
- `--silence S`: the shortest silence that ends an engine, in seconds; 300 by default.
- `--deadline S`: the most seconds one engine may run, printing or not, the import's included. No
  limit by default.
- `--godot PATH`: the engine to run, in place of the one `GODOT_PATH` or the usual places give.
- `--godot-version V`: fail every engine, the import's included, whose banner names another
  version. `4.7.2` holds for `4.7.2.stable.official`, and `4.7` for every patch of it.
- `--cores N`: hold every engine, the import's included, to the first N processors, and start no
  more engines than N. On Linux this goes through `taskset`, and on Windows the engine is held
  before it starts running. macOS has no way to hold a process to some processors, so there it
  holds only the number of engines.
- `--tests DIR`: where to look for suites, `tests` and `test` by default. May be given more than
  once.
- `--import`: import the project in an engine of its own before the suites.
- `--order reversed` or `--order SEED`: every suite in one engine, in reverse order of path or
  shuffled by a number, to find suites that depend on the order they run in.
- `--changed-only`: leave out the suites that passed with everything they reach unchanged. For
  iterating only.
- `--reach-also PATH`: a file every suite depends on, for `--changed-only`. May be given more than
  once.
- `--print-output`: print everything each engine printed, before the verdict, as for a benchmark
  written as a suite and run by hand. A gate never passes it.
- `--result FILE`: write the run's result to `FILE` as JSON, for a gate that acts on more than the
  exit code. It holds `passed`, `seconds`, `problems` (every problem the output lists, one sentence
  each, an engine's prefixed with `engine N:`), `suites` (each suite an engine closed, slowest first,
  with its `path`, `seconds`, gdUnit4's `verdict` and the `engine` that ran it), `engines` (each
  with its `index`, `seconds`, the `dealt` seconds the times kept had it at, `passed`, `windowed`
  and the `log` its output is kept in) and `logs`, the directory every engine's output is kept
  under. `log` and `logs` are null once a passing run has removed them. A run that failed its
  import, or had nothing left to run under `--changed-only`, writes empty `suites` and `engines`.
- `--runner`: print the path of the shipped runner and exit.

## Which suites run

A suite is a script under one of the test directories whose chain of `extends` reaches
`GdUnitTestSuite`, by class name, by `res://` path or by a path relative to the script, and which
declares a function starting `test_` or inherits one from a script of the project. Those functions
are the cases it is expected to run, which is how a case that never ran is noticed.

A project keeps folders out of every search by listing them in `gdharness/tests/not_searched`, a
`PackedStringArray` of `res://` paths in `project.godot`; benches written as suites and run by hand
go there. A suite in such a folder still runs when it, or a folder at or inside the listed one, is
named. project_test reads the same setting.

```ini
[gdharness]

tests/not_searched=PackedStringArray("res://test/bench")
```

## How they are dealt to engines

What each case took is kept in `.godot/gdharness/suite-times.json`, in the main checkout when the
project is a git worktree of one:

```json
{
  "res://tests/a_test.gd": {
    "seconds": 12.4,
    "cases": { "test_x": 5.1, "test_y": 7.0 },
    "rows": { "test_y": [3.4, 3.6] }
  }
}
```

`seconds` is the suite run whole, with its `before` and `after`; `cases` holds each function, with
the rows of a parameterised one added together, and `rows` what each row of a parameterised case
took, from row 0. A case never timed is taken to cost the median of the cases that have been, and
0.02 s when nothing has. Each run that writes the file leaves out a suite the project no longer has,
deleted or renamed, and a case its suite no longer declares, with its seconds taken off the suite's.
A run that printed only some rows of a case, because it was dealt them or cut short, keeps the old
times of the rest.

A suite costing more than 10 seconds, with more than one case, is dealt out case by case, and an
engine holding part of it skips the rest; the run names each suite it dealt out that way. A
parameterised case that costs more than 10 seconds by itself, with at least two rows timed, is dealt
out row by row, in a suite of any number of cases. Each engine holding some of its rows runs only
those, and the one holding the last row also runs any row the times do not know, so a row added
since they were taken still runs once. The run names each case it dealt out that way, and fails
when a row that any engine found ran in none of them or in more than one. Units are
dealt slowest first, each to the engine with the least so far. A run starts no more engines than
`--engines`, the machine's processors (or `--cores`), or its
free memory allows once 4 GB is left for everything else at 1.5 GB an engine, and no more than it
takes to keep each one busy for as long as the slowest unit or 5 seconds, whichever is longer, plus
one for each unit with a case never timed: the median is a guess, and a suite just split out of a
slow one, or every suite of a project's first run, is unlikely to cost it. A run held below
`--engines` by processors or memory says which on its first line. On macOS the free
memory is the share the system itself counts as free, which includes the cache it can give back. On
Windows it is the smaller of the physical memory free and what the system can still commit, since
an allocation fails at the commit limit however much physical memory is free.

## What fails a run

- A case that failed, or that failed and then passed on a retry.
- An engine error (`ERROR:`, `SCRIPT ERROR:` or `USER ERROR:`) that the suite did not declare. The
  errors before Godot's warning that it is switching to another rendering driver are left out: the
  display server is made before any of the project's scripts run, so those are the engine trying a
  driver the machine lacks, as a windowed engine does on a machine without a Vulkan surface.
- An error a suite declares that it did not print.
- A suite that never started, never finished, or finished without running every case it declares,
  and a case that ran without being planned.
- A suite that reports a failure while all its cases passed, which is a failing `before` or `after`.
- A run that printed no summary or ran no case, or a script gdUnit4 could not load.
- Objects, resources or memory pages still held as the engine exits. Godot never frees a script that
  exports an array or dictionary typed with its own class, such as `@export var parts: Array[Item]`
  in the script declaring `Item`, so a run that loads one always ends this way; the verdict names
  each such script in the project. Typed with a class it extends instead, as `Array[Resource]`, it
  is freed. Below 4.8 the engine's shutdown can stop part way through its scripts, when releasing one
  frees the next (godot#117991, fixed in 4.8 by godot#120976), and it then reports as held
  everything it never reached. On those engines the runner keeps every script loaded from a file
  alive until that walk is over, which keeps it whole, and prints a line as the walk starts and
  another as it ends. A run whose walk still stopped part way lists what the engine reported under
  "not counted against the run" instead of failing on it. What a test leaks itself, a script it
  holds included, still holds what it reaches, so it is still reported and still fails the run.
- An exit code other than 0, named by its meaning: a Windows status such as
  `0xC0000005 (STATUS_ACCESS_VIOLATION)`, or one of gdUnit4's, such as 101 for orphan nodes. gdUnit4's
  100, which it exits with when a case failed, is left out beside that case's own line. An engine
  that died on a Windows exception status also says how much memory was free as it ended.
- An engine that printed nothing at all.
- An engine ended for its silence or its deadline, or because an autoload did not start.
- An engine whose banner names another version than `--godot-version` asks for.
- A gdUnit4 that no longer works the way the runner relies on. The runner swaps the session gdUnit4
  makes for one that finds each case by its id in a dictionary, since gdUnit4's own walks every case
  of the session for each lookup, which grows with the square of a run's cases. The swap holds only
  while gdUnit4 announces a session before it hands it to its hooks and its console, so a session
  hook of the runner's own fails the run, with gdUnit4's version, when it is handed another session
  or when the cases ran without one lookup reaching it. A report turned off by an option that
  gdUnit4 no longer registers a hook for fails the run the same way, and so does any file in an
  engine's reports folder, since the runner turns both reports off by marking their hooks and a
  file there means gdUnit4 no longer reads the mark. These checks run in the gdUnit4 the project
  installs, on every run.
- A script under the folders searched for suites that declares `test_` functions and is no suite,
  because nothing it extends reaches `GdUnitTestSuite`. gdUnit4 runs none of its cases and says
  nothing of it, so a suite whose `extends` names the wrong class would pass with no case run. The
  run names the script beside the suites it did run.

Each failure is printed with the lines that show it: a failing case's report, each unexpected error
and the line after it, and the run's summary. When an engine was cut short and none of that explains
it, its last 60 lines. The engine's whole output stays in
`.godot/gdharness/test-runs/<start>-<pid>/engine-<n>/engine.log`, which the output names and which
opens with the engine's verdict, so the file says why even for an engine that printed nothing. A
project that is a worktree of another checkout has the logs of a failed run copied to the same place
under the main checkout, and the output names the copy, since a gate running in a worktree of the
commit removes the worktree once the run ends. Before
the verdict, a run over several engines says what each took beside what it was dealt, so an uneven
deal is told from a slow suite, and a run of several suites names its five slowest. The last lines
count the problems and name the run's directory. A run that passes leaves no logs. A failed run
keeps its logs until five later runs have failed, so the run that tries to reproduce a crash does
not remove the log that explains it; `--print-output` prints every engine's output before the
verdict, whether the run passed or not.

## Errors and warnings a suite expects

A suite that prints an engine error on purpose declares it, with its exact text, in a constant:

```gdscript
const GDHARNESS_EXPECTED_ERRORS: Dictionary = {
    "before": ["the save folder is missing"],
    "test_rejects_a_bad_file": ["Could not parse broken.json"],
}
```

The keys are case functions, or `before` and `after` for the suite's own hooks. The text is what
follows `ERROR:` and its space on the line. Each text listed accepts one such line, so a case
printing it twice lists it twice, and a parameterised case declares what one row prints. A
declared text the case does not print fails the run too, since the case no longer reaches what it
was written to test. There is no way to accept errors across a whole run: gdUnit4's own
`report/godot/script_error` setting decides only which errors fail a case, and an error a case meant
to raise with `assert_error` is declared like any other.

An engine warning printed while a suite runs fails the run the same way, since Godot answers some
refused changes with nothing but a warning: an `after_test` setting the root's
`gui_embed_subwindows` while a window it had shown was still up was refused, the root went on
embedding windows for every later suite, and the run passed. A suite that prints one on purpose
declares it in `GDHARNESS_EXPECTED_WARNINGS`, keyed the same way, with the text after `WARNING:` and
its space. A text declared as an error does not accept a warning, or the reverse. A warning printed
outside every suite fails the run as an error there does: it comes from an autoload, a session hook
or the game's own code, and no suite can declare it. So does one the `--import` engine prints. A
warning outside every suite that the engine's platform layer or a rendering driver raised, as its
`at:` line names a file under `platform/` or `drivers/`, is about the machine and is not judged: a
windowed engine on a macOS runner's virtual GPU warns that it is switching to ANGLE, and one falling
back to another rendering driver says so.

`project_test` judges a run's errors and warnings by the same declarations, and names what fails it
under `undeclaredErrors` and `declaredNotPrinted`, a warning marked `warning: true`.

An error counts as the case's that was running when it was printed. One printed after a case's
verdict counts as that case's while another case follows, since what a case leaves for a later
frame prints there, and as `after`'s once the last case is done.

## Suites that need a window

A suite declaring `const GDHARNESS_NEEDS_WINDOW: bool = true` runs in an engine with a window, since
a headless engine delivers no input events. So does one calling gdUnit4's `scene_runner` that
declares nothing, which is a guess: a suite that uses the scene runner only to stand a scene up and
read it declares `const GDHARNESS_NEEDS_WINDOW: bool = false` and runs headless. The declaration
counts from the suite or any script it extends. A project whose scene runner suites pass headless
turns the guess off for every suite with `gdharness/tests/scene_runner_needs_window=false` in
`project.godot`, and then only a suite declaring `true` gets a window. All the windowed suites go
to one windowed engine, which starts first, counts toward `--engines`, and runs nothing else: a
suite dealt there would meet the real display server, so the screen size and scale, the keyboard
layout and the display features it reports would be the machine's rather than the headless
server's, setting the root viewport's
size would leave it the window's, and it would run slower for drawing frames. Once the windowed
engine ends, a headless engine follows it in the same slot without giving the slot back, dealt as
though it began then, so a few quick windowed suites never leave a slot idle. With `--engines 1`
the run is that one slot: the windowed engine, then a headless one. On a machine with room for
fewer engines than asked for, the slots run one after the other, and the line announcing the run
says so. An ordered run (`--order`) is one engine, so a suite in it needing a window gives the
whole run one, and the run names each suite declaring `false` that runs with the window before it
starts. The windowed engine runs without
`--headless`, at the size `project.godot` gives its viewport, and with the Dummy audio driver like
every other test engine. On Windows it runs on a desktop of its own, so its window never appears
on the desktop in use or takes its focus. The headless engines run there too, since an engine that
fails to start shows a modal alert even with `--headless`. Elsewhere it uses the display there is;
on a CI runner with none, run it under `xvfb-run`.

The `project_test` tool reads the suites the same way. Its run is one engine, so when a suite in it
needs a window the whole run has one, started as above, and the answer's `windowNote` names the
suites that needed it and those declaring `false` that shared it. On a machine with no display the
run stays headless, and the note says so.

On a GitHub macOS runner, whose GPU is virtual, Godot's Metal driver under the Forward+ renderer
prints `timeout waiting for fence` as a windowed engine draws, and that engine error fails the run.
It was measured in eight of ten windowed runs drawing thirty frames, and in none of ten under the
Mobile or Compatibility renderer or with the Vulkan driver. A project rendering with Forward+ that
runs windowed suites there can set `rendering/rendering_device/driver.macos` to `vulkan`.

## Silence and memory

An engine that prints nothing for 300 seconds, or for four times its slowest unit's last time when
that is longer, is ended, and the case it was in is named. `--silence` changes the 300. Silence
never ends an engine that keeps printing, such as a case warning every frame; `--deadline` ends any
engine that has run that many seconds, naming the case it was in. An engine whose autoload did not
start is ended as soon as it says so, since nothing a suite reports without it means anything.

When an engine runs out of memory, which shows as the allocator's null, an image decode failing, or
Windows' `STATUS_NO_MEMORY` or `STATUS_COMMITMENT_LIMIT`, every engine that failed runs again, one at
a time, and those runs are the ones judged. One that fails again is headed as run again alone.

## Leaving out what passed

`--changed-only` leaves out every suite that passed last time with everything it reaches unchanged.
It is for iterating while working on something. A gate, `make ci`, a pre-push hook or a release
build never passes it: they run every suite, every time.

A suite's fingerprint covers its own script and, followed from file to file, every class its code
names, every `res://` path in it, every script it preloads by relative path, every resource those
name with each one's `.import` file, every addon it reaches (read whole), the project's autoloads
and extensions, `project.godot`, the gdharness version and runner, and each file named with
`--reach-also`. A suite that reaches anything named only at run time has no fingerprint and always
runs: a `DirAccess`, a `list_directory`, a `load` of a computed path, a path with a placeholder in
it, a `uid://` path, or a binary `.scn` or `.res`. The fingerprints of the suites that passed are
kept in `.godot/gdharness/suite-passed.json`, beside the times.

## Engine slots

The slots are files in one directory, shared by every tool on the machine that starts an engine,
for every project, so that the gates of several games, a benchmark and a build running at once
start no more engines between them than there are slots. The MCP server's own engines take them
too: each headless operation, script check, export, `project_test` run and `editor_run check`
waits for a slot before its engine starts. A game started with `editor_run start`, and one the
editor plays, does not: someone is driving it for as long as it runs.

A wait for a slot is said. A tool call that asked for progress hears it at once, and every 20
seconds after. `gdharness test` and `gdharness spread` print a line once the wait passes 2 seconds,
and again every 20 seconds while it lasts, one line however many of its engines are waiting; every
other command prints it to standard error. The line names the directory and the count, so a gate
that has gone quiet because the machine's other runs hold every slot says so.

The directory and the count are the same for every tool on the machine:

- The directory is `GODOT_ENGINE_SLOTS` when that is set and not empty. Otherwise it is
  `$XDG_CACHE_HOME/gdharness/slots` when `XDG_CACHE_HOME` is set and not empty, on any platform,
  then `%LOCALAPPDATA%\gdharness\slots` on Windows, and `~/.cache/gdharness/slots` everywhere
  else.
- The count is `GODOT_ENGINE_SLOT_COUNT` when that is set, a whole number above 0. Otherwise it is
  a fifth of the processors the machine offers, rounded down, and at least one.
- A command's `--slots` and `--slot-count` come before both.

`--engines` is how many engines one run would like, and is not the slot count: a gate given its
share of the machine passes `--engines` for its share and the machine's directory and count for
the slots. A tool of a game's own that starts engines takes them the same way:

1. A slot is `<directory>/<n>.lock`, for `n` from 0 below the slot count.
2. To take one, create the file exclusively (`O_CREAT | O_EXCL`, Python's `open(path, "x")`), and
   write `{"pid": <your pid>, "started": <your process's start time>}` into it, the time in
   milliseconds since the epoch as the operating system reports it.
3. When every slot exists, read each one. It is free when no process has its pid, when the process
   with that pid started more than 2000 ms away from `started`, or when the file is still empty or
   unreadable 10 seconds after it was last written. A lock whose holder's start time cannot be read
   is held.
4. To take a free one over, first create `<n>.lock.steal` exclusively. If that fails, someone else
   is taking it over; remove the steal file only if it is more than 10 seconds old. Holding the
   steal file, read the lock again, and if it is still free remove it and create it as in step 2.
   Then remove the steal file. On Windows a lock another process holds open cannot be removed;
   leave it, since that process still has the slot.
5. When nothing is free, look again 50 ms later.
6. When done, remove the lock, but only if it still names your pid.

The start time is what tells a holder from a later process given its pid. Windows reports a
process's creation time to the millisecond, and `ps -o lstart` on macOS only to the second, which
is why the tolerance is two seconds. On Linux, read it as gdharness and psutil's `create_time()` do:
the `btime` line of `/proc/stat`, plus the 22nd field of `/proc/<pid>/stat` divided by
`getconf CLK_TCK`, in seconds. That is up to a second early; `ps -o lstart` there cuts the same sum
to the second again and reads up to two seconds early, which is the whole tolerance.

## Preparing the game before any suite

Something every suite needs in place before the first one runs, such as a root node of the game's
own or a pace the game's clock runs at, goes in a gdUnit4 session hook. The runner leaves the
project's hooks on, so each engine calls the hook's `startup` once before its first suite and its
`shutdown` once after its last. A hook extends `GdUnitTestSessionHook` and is registered in
gdUnit4's settings dialog, which keeps it under `gdunit4/hooks/session_hooks` in `project.godot`:

```gdscript
class_name GameRootHook
extends GdUnitTestSessionHook


func _init() -> void:
    super("Game root", "Adds the game's root before the first suite.")


func startup(_session: GdUnitTestSession) -> GdUnitResult:
    var tree := Engine.get_main_loop() as SceneTree
    tree.root.add_child(preload("res://game/root.tscn").instantiate())
    return GdUnitResult.success()


func shutdown(_session: GdUnitTestSession) -> GdUnitResult:
    return GdUnitResult.success()
```

A hook that answers with `GdUnitResult.error` fails the run, because gdUnit4 prints that answer as
an engine error that no suite declared.

## Waits, tweens and input in a suite

The tests addon, `addons/gdharness_tests`, which `gdharness setup` installs, has three classes for
the things a suite waits on or presses:

- `GdhWait.until(tree, done)` awaits until `done` answers true, asking once a frame, and answers
  false after 30 seconds (or the bound it is given) so that something that never ends fails the
  case by name. `GdhWait.still(tree)` awaits three frames in a row with no tween running.
  `GdhWait.frames(tree, n)` awaits n frames.
- `GdhTweens.step(tree, seconds)` moves every running tween on by that much, as frames would.
  `GdhTweens.past(tree, seconds)` steps one frame further, for a case about what an animation
  leaves when it is over: a step ending exactly where the last tweener ends leaves the callback
  after it unrun.
- `GdhEvent` builds events: `click(at)`, `release(at)`, `wheel(at, up)`, `motion(at, moved, held)`,
  `key(KEY_SPACE)`, `pad(JOY_BUTTON_A)`, `axis(JOY_AXIS_LEFT_X, value)` and `action("jump")`, each
  pressed unless told otherwise. Hand one to `Input.parse_input_event`, or to a control's own
  `_gui_input`.

A wait on a timer of an animation's length races the animation: the engine counts a tween's time
in frame deltas, so on a machine running other engines the timer ends with the tween still going.
Asking once a frame, or stepping the tween, holds however slowly the frames come.

## What suites cost, by function

`gdharness test` runs suites as a script, and the engine's script profiler only sees a scene, so
it cannot say where a tier's time goes. `editor_run start` with `suites`, the same paths
`project_test` takes, plays them in the tests addon's suites scene through the same runner, and
`editor_run profile` then names what each function cost:

```text
editor_run start    suites ["tests/house"], headless true, profile true
editor_output       until running is false
editor_run profile
```

The run quits with gdUnit4's exit code. A suite that needs a window needs `headless: false` here
too.

For game code rather than suites, a scene can step its work one call a frame with
`GdhBench.each_frame(tree, most, step)`, which stops early when `step` answers false and answers
`steps` and `ms_each`, the step's own time on average. The profiler names only so many functions a
frame, so work played inside one frame comes back mostly unnamed; one step a frame names them all.

## Starting the runner yourself

`gdharness test --runner` prints the path of the shipped runner, `listed.gd`, for a tool that starts
an engine on it directly. It is started with `-s <path>` from outside the project and takes
gdUnit4's own options, then after `--`:

- `--suites-in FILE`: the suites to run, one `res://` path a line, in order.
- `--skipping-in FILE`: the cases to leave out, `res://a_test.gd:test_x` a line. Such a line leaves
  out that case of that suite alone, a case the suite inherits included; any other line is passed
  to gdUnit4's `-i` as it is.

The runner files every case under the suite it was found in. gdUnit4 files a case under the script
declaring it, so on its own its reports leave out every case a suite inherits, and an inherited
parameterised case runs as a suite of the base's own, outside the suite that inherits it.

- `--html-report-off` and `--junit-report-off`: no HTML report, and no JUnit report.
- `--compile-together`: compile the suites together beside every class of the game before running
  them, so every script that does not compile is named.
- `--expected-out FILE`: write each suite's `GDHARNESS_EXPECTED_ERRORS` and
  `GDHARNESS_EXPECTED_WARNINGS` there, as JSON under `errors` and `warnings`.
