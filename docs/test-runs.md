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
- `--slots DIR`: the slot directory, `.godot/gate/slots` in the main checkout by default.
- `--slot-count N`: how many slots that directory has; 4, or fewer on a machine with fewer
  processors.
- `--silence S`: the shortest silence that ends an engine, in seconds; 300 by default.
- `--tests DIR`: where to look for suites, `tests` and `test` by default. May be given more than
  once.
- `--import`: import the project in an engine of its own before the suites.
- `--order reversed` or `--order SEED`: every suite in one engine, in reverse order of path or
  shuffled by a number, to find suites that depend on the order they run in.
- `--changed-only`: leave out the suites that passed with everything they reach unchanged. For
  iterating only.
- `--reach-also PATH`: a file every suite depends on, for `--changed-only`. May be given more than
  once.
- `--window-only-needed`: keep the windowed engine to the suites that need a window, as though
  every other suite declared `GDHARNESS_NEEDS_WINDOW = false`.
- `--print-output`: print everything each engine printed, before the verdict, as for a benchmark
  written as a suite and run by hand. A gate never passes it.
- `--runner`: print the path of the shipped runner and exit.

## Which suites run

A suite is a script under one of the test directories whose chain of `extends` reaches
`GdUnitTestSuite`, by class name, by `res://` path or by a path relative to the script, and which
declares a function starting `test_` or inherits one from a script of the project. Those functions
are the cases it is expected to run, which is how a case that never ran is noticed.

## How they are dealt to engines

What each case took is kept in `.godot/gdharness/suite-times.json`, in the main checkout when the
project is a git worktree of one:

```json
{
  "res://tests/a_test.gd": {
    "seconds": 12.4,
    "cases": { "test_x": 5.1, "test_y": 7.0 }
  }
}
```

`seconds` is the suite run whole, with its `before` and `after`; `cases` holds each function, with
the rows of a parameterised one added together. A case never timed is taken to cost the median of
the cases that have been, and 0.02 s when nothing has.

A suite costing more than 10 seconds, with more than one case, is dealt out case by case, and an
engine holding part of it skips the rest; the run names each suite it dealt out that way. Units are
dealt slowest first, each to the engine with the least so far. A run starts no more engines than
`--engines`, the machine's processors, or its
free memory allows once 4 GB is left for everything else at 1.5 GB an engine, and no more than it
takes to keep each one busy for as long as the slowest unit or 5 seconds, whichever is longer. A
run held below `--engines` by processors or memory says which on its first line. On macOS the free
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
- Objects, resources or memory pages still held as the engine exits.
- An exit code other than 0, named by its meaning: a Windows status such as
  `0xC0000005 (STATUS_ACCESS_VIOLATION)`, or one of gdUnit4's, such as 101 for orphan nodes. gdUnit4's
  100, which it exits with when a case failed, is left out beside that case's own line.
- An engine ended for its silence, or because an autoload did not start.

Each failure is printed with the lines that show it: a failing case's report, each unexpected error
and the line after it, and the run's summary. When an engine was cut short and none of that explains
it, its last 60 lines. The engine's whole output stays in
`.godot/gdharness/test-runs/<start>-<pid>/engine-<n>/engine.log`, which the output names, and the
last lines count the problems and name the run's directory. A run that passes leaves no logs, and
the next run removes the logs of runs that have ended; `--print-output` prints every engine's
output before the verdict, whether the run passed or not.

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
outside every suite, as the engine starts or exits, is not judged, and neither is the one Godot
prints when it falls back to another rendering driver.

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
counts from the suite or any script it extends. All the windowed suites go to one windowed engine,
which starts first and counts toward `--engines`, and which is then dealt the suites that declare
nothing like the others, so a few quick windowed suites never leave it idle. A suite dealt there
meets the real display server, so the screen size and scale, the keyboard layout and the display
features it reports are the machine's rather than the headless server's, and setting the root
viewport's size leaves it the window's. `--window-only-needed` keeps every suite that does not need
a window out of it, for a project with suites reading any of those. A suite declaring `false` is
therefore never dealt there while another engine runs, and a
run that has a windowed suite and one declaring `false` starts two engines at least. On a machine
with room for one engine, they run one after the other, and the line announcing the run says so.
When the run is one engine (`--engines 1` or `--order`), the run names each suite declaring `false`
that runs with the window before it starts. The windowed engine runs without
`--headless`, at the size `project.godot` gives its viewport, and with the Dummy audio driver like
every other test engine. On Windows it runs on a desktop of its own, so its window never appears
on the desktop in use or takes its focus. Elsewhere it uses the display there is; on a CI runner
with none, run it under `xvfb-run`.

On a GitHub macOS runner, whose GPU is virtual, Godot's Metal driver under the Forward+ renderer
prints `timeout waiting for fence` as a windowed engine draws, and that engine error fails the run.
It was measured in eight of ten windowed runs drawing thirty frames, and in none of ten under the
Mobile or Compatibility renderer or with the Vulkan driver. A project rendering with Forward+ that
runs windowed suites there can set `rendering/rendering_device/driver.macos` to `vulkan`.

## Silence and memory

An engine that prints nothing for 300 seconds, or for four times its slowest unit's last time when
that is longer, is ended, and the case it was in is named. `--silence` changes the 300. An engine
whose autoload did not start is ended as soon as it says so, since nothing a suite reports without
it means anything.

When an engine runs out of memory, which shows as the allocator's null, an image decode failing, or
Windows' `STATUS_NO_MEMORY` or `STATUS_COMMITMENT_LIMIT`, every engine that failed runs again, one at
a time, and those runs are the ones judged.

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

The slots are files in one directory, shared by every tool on the machine that starts a test engine
for the project, so that a gate, a benchmark and a build running at once start no more engines
between them than there are slots. A tool of a game's own that starts engines takes them the same
way:

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
process's creation time to the millisecond, and `ps -o lstart` elsewhere only to the second, which
is why the tolerance is two seconds.

## Starting the runner yourself

`gdharness test --runner` prints the path of the shipped runner, `listed.gd`, for a tool that starts
an engine on it directly. It is started with `-s <path>` from outside the project and takes
gdUnit4's own options, then after `--`:

- `--suites-in FILE`: the suites to run, one `res://` path a line, in order.
- `--skipping-in FILE`: the cases to leave out, `res://a_test.gd:test_x` a line.
- `--html-report-off` and `--junit-report-off`: no HTML report, and no JUnit report.
- `--compile-together`: compile the suites together beside every class of the game before running
  them, so every script that does not compile is named.
- `--expected-out FILE`: write each suite's `GDHARNESS_EXPECTED_ERRORS` and
  `GDHARNESS_EXPECTED_WARNINGS` there, as JSON under `errors` and `warnings`.
