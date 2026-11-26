# Test runs

`gdharness test` runs a project's gdUnit4 suites over several engines and judges everything they
print. Each engine waits for one
of the machine's engine slots and is ended when it goes silent. It is judged on its output line by
line rather than on its exit code.

It needs gdUnit4 6.0 or later under `addons/gdUnit4`. It finds Godot the way the rest of the CLI
does, from `GODOT_PATH` and then the usual places.

## Running it

```text
gdharness test                         every suite under tests/ and test/
gdharness test path/to/game            the same, for a project elsewhere
gdharness test tests/combat            every suite in a directory
gdharness test tests/a_test.gd         one suite
gdharness test tests/a_test.gd:test_x  one case
```

It exits 0 when every case passed and nothing else was wrong. It exits 1 when anything failed, and 2
when the command line itself is wrong.

## Engine options

- `--engines N`: the engines a run starts with at once, 4 by default, and the most at once. A run
  handed out a share at a time starts an engine again only for a lane whose engine ended (it
  crashed or was ended) or that waited for a slot, so in total it may start more engines than this.
- `--slots DIR`: the slot directory, the machine's own by default (see
  [Engine slots](#engine-slots)).
- `--slot-count N`: how many slots that directory has, unless its `count` file says otherwise. By
  default it is half the processors, at least one.
- `--cores N`: hold every engine, the import's included, to the first N processors, and start no
  more than N engines. Linux uses `taskset` and Windows holds the engine before it starts, while
  macOS cannot and holds only the number of engines.
- `--godot PATH`: the engine to run, in place of the one `GODOT_PATH` or the usual places give.
- `--godot-version V`: fail every engine, the import's included, whose banner names another
  version. `4.7.2` holds for `4.7.2.stable.official`, and `4.7` for every patch of it.

## Time limits

- `--silence S`: the shortest silence that ends an engine, in seconds, 300 by default.
- `--deadline S`: the most seconds one engine may run, printing or not, the import's included. No
  limit by default.

## Suite options

- `--tests DIR`: where to look for suites, `tests` and `test` by default. May be given more than
  once.
- `--import`: import the project in an engine of its own before the suites. Without it, a project
  is still imported first [when it is out of date](#when-a-run-imports-first).
- `--order reversed` or `--order SEED`: the suites in reverse order of path or shuffled by a number,
  in one engine. It finds suites that depend on the order they run in. Suites needing a window run
  in a windowed engine of their own, first, and the others in a headless one after it. The order
  holds within each engine.
- `--order named`: the suites you name, in the order you name them within their engine. Suites
  needing a window run first, in an engine of their own. To replay a case that fails only after
  others, name the `suites` list of an engine from the result file. Then halve it until one suite
  before the failing one is left.

## Reuse options

- `--changed-only`: leave out the suites that passed on exactly the files their engine loaded, all
  of them unchanged. Every script is still compiled together, unless they compiled together
  cleanly on the same files last time.
- `--reach-also PATH`: a file or folder every suite depends on, for `--changed-only`. May be given
  more than once. A suite reading data from a folder that holds a `.gdignore` or a `project.godot`
  of its own names that folder here, because the engine leaves such a folder out and so does the
  reuse check.
- `--whole-tree`: run nothing, and print each script that makes suites depend on every file, as
  `path:line: argument`. Each line says how many suites reach it from their code and the autoloads.
- `--times FILE`: deal the suites by the times in `FILE` and record what they took into it, in
  place of `.godot/gdharness/suite-times.json`. A missing file deals as no times would.

## Output options

- `--print-output`: print everything each engine printed before the verdict, as for a benchmark
  written as a suite and run by hand.
- `--verbose`: start every engine with Godot's `--verbose` to name a leak at exit, where the engine
  otherwise prints only two counts. The verdict counts the objects left alive by class and names
  the resources still in use, the project's own before its addons'.
- `--engine-arg ARG`: hand every engine of the run one entry of the flags `project_test`'s
  `engineArgs` takes, repeated for each entry. A flag and its value are two entries, so
  `--engine-arg --fixed-fps --engine-arg 60 --engine-arg --time-scale --engine-arg 20` runs every
  frame at 1/60 s of game time, twenty times faster. A fixed step makes the speed apply the same on
  every run, since headless frames are otherwise timed by the wall clock. A flag `project_test`
  refuses is refused here before any engine starts, in this option's words. That includes `--quiet`,
  which silences the lines the verdict is read from, and `--write-movie`. A pass kept for
  `--changed-only` counts only for the same flags. Under `--fixed-fps` a headless engine's game
  time runs ahead of the clock, so the run says that gdUnit4's timeouts and every game-time wait
  run out early.
- `--keep-slower-than SECONDS`: keep the log of each engine that ran a case slower than `SECONDS`,
  a plain decimal above 0 such as `10`, `2.5` or `.5`, in a passing run too. The time is gdUnit4's
  own, printed on the case's verdict line. The run names each such case with its time, the engine,
  the engine's slot, the engine process's priority and the kept log, and the result holds the same
  as `slowCases`. A passing run keeps only the logs of those engines, and its directory holds a
  `slow-run` file. A later run removes a slow run's directory once five newer slow runs have kept
  one, and a failed run's once five newer runs have failed. Neither kind counts against the other,
  and a directory without the file, as an older release left, counts as a failed run. A line with
  no time, such as an older gdUnit4 prints, never counts as slow.
- `--result FILE`: write the run's result to `FILE` as JSON, for a gate that acts on more than the
  exit code. [The result file](#the-result-file) lists what it holds.
- `--runner`: print the path of the shipped runner and exit.

## When a run imports first

Without `--import`, a project is still imported first when a suite would run against what it no
longer holds. That is when one of these holds:

- It has no class cache.
- It holds a `.gdextension` and no `.godot/extension_list.cfg`. `gdharness setup` leaves it so,
  since it writes the class cache without importing.
- The cache does not list a class a script declares where the script declares it.
- An imported file's import is behind it, as after the file changed. `project_import status` names
  the same files.

## The pipeline cache

Each engine gets a `user://` of its own, so a game's saves stay apart from the player's. Godot keeps
its shader cache there, in `user://shader_cache`, and the Vulkan driver's pipeline cache in
`user://vulkan/pipelines.*.cache`. The editor's `.editor.cache` file is left out. Each engine starts
with the caches the project's last run left, when the same engine build made them, so a drawing suite
does not build every shader and pipeline again. The largest shader cache a run leaves is kept
in gdharness's cache folder, one per project. Each pipeline file is kept by name, and a file the
run's engine wrote replaces the kept one of that name whenever the bytes differ, since an engine that
refuses a seeded file after a driver update writes a smaller valid one. A file the run was seeded
with and its engine left alone, as in a headless run, leaves the kept one alone. Of two runs at once,
the keep that finishes last wins each pipeline file it wrote, so pipelines only the earlier run built
are built again by the next run. A project whose name or user folder setting changed, in
`project.godot` or `override.cfg`, gets no seed from the old cache, and its next run's cache replaces
it. The cache of a project that is gone is removed.

## The result file

Every run writes its result to `.godot/gdharness/last-run.json`, beside the project's suite times.
`--result` writes the same to a file of your choice. A gate that keeps none of a passing step's
output can still read it there. It holds:

- `passed` and `seconds`.
- `problems`: every problem the output lists, one sentence each. An engine's is prefixed with
  `engine N:`.
- `suites`: each suite an engine closed, slowest first. Each has its `path`, gdUnit4's `seconds`
  and `verdict`, and the `engine` that ran it.
- In each suite, `loadSeconds` runs from the end of the suite before it, and `beforeSeconds` is its
  `before()`. Both are null when none of its cases began.
- `engines`: each engine, with the fields below.
- `logs`: the directory every engine's output is kept under.
- `slowCases`: present when `--keep-slower-than` was given and engines ran, empty when no case was
  slow. Each case slower than the limit, slowest first, has the `suite`, the `case` as gdUnit4
  printed it, `seconds`, the `engine` index, its `slot`, its `priority` and its `log`. `slot` is
  the engine slot's number, or null. `priority` is read from the engine's process while it ran: a
  Windows priority class such as `normal`, or the nice value such as `nice 0` on Linux and
  macOS. It is null when the engine ended before it was read. `log` names the kept file itself.
  Take the path from the field and never build it. `seconds` is exact, and the report prints it to
  the millisecond.
- `enginesAsked`.
- `slotsFree`: how many of the slots its lanes take were free as it began. Fewer than the lanes
  means the engines were handed the suites a share at a time.
- `dealing`: the lines the run printed about its deal.

### Each engine

- `index` and `lane`.
- `startedAfter`: the seconds after the command started that it got a slot and began.
- `seconds`, and `dealt`, the seconds the times kept had it at.
- `startSeconds`: its start until gdUnit4 began, null when it never did or when it ran in an engine
  started for an earlier share. `compiledSeconds` is the part spent compiling its suites together,
  and for a share in a reused engine the time that share's suites took to compile.
- `passed` and `windowed`.
- `suites`: the suites it was handed.
- `peakBytes`: the most memory it was read holding, or null when it was never read.
- `log`: the file its output is kept in.

`log` and `logs` are null once a passing run has removed them, except for the engines of
`slowCases`. A run that failed its import, or had nothing left to run under `--changed-only`,
writes empty `suites` and `engines`.

### Refused runs and unwritten results

A run refused before any engine started, such as one naming a suite that is not there, writes a
failed result with empty `suites` and `engines`. Its refusal is its one problem.

A run that cannot write a result file says which and exits 1, whatever its suites did. The file
would otherwise hold an earlier run's result.

A case's own time, as gdUnit4 prints it, runs from its `before_test()` to its `after_test()`. An
engine's start and a suite's load and `before()` are in the fields above, never in a case's time.
The run's closing lines also say what each engine spent starting.

## Which suites run

A suite is a script under one of the test directories whose chain of `extends` reaches
`GdUnitTestSuite`. The chain may name a class, a `res://` path or a path relative to the script.
The suite also declares a function starting `test_`, or inherits one from a script of the project.
Those functions are the cases it is expected to run, which is how a case that never ran is noticed.

A case, a row or a whole suite skipped with `do_skip` never ran either, though gdUnit4 prints it
passed and exits 0. The run fails and lists each skip with its `skip_reason`, and a suite skipped
whole is listed once. `project_test` answers them under `casesSkipped`. `gdharness test` counts
only the cases that ran. No option allows a skip. Both tools read each reason off the console, over
as many lines as the reason has in the JUnit report gdUnit4 wrote. Where those lines do not close
the reason's quote, the report's text is the reason, which lacks some words in square brackets. A
skip the report misses is read off the console, and a reason the output cut off
before its closing quote is listed by its first line and said to be cut. A run that wrote no report
reads a reason off the console only when it closes on its own line, and lists no skip whose reason
runs over several lines.

A project keeps folders out of every search by listing them in `gdharness/tests/not_searched`, a
`PackedStringArray` of `res://` paths in `project.godot`. Benches written as suites and run by hand
go there. A suite in such a folder still runs when it is named, or a folder at or inside the listed
one is. `project_test` reads the same setting.

```ini
[gdharness]

tests/not_searched=PackedStringArray("res://test/bench")
```

## How they are dealt to engines

What each case took is kept in `.godot/gdharness/suite-times.json`. A git worktree uses the main
checkout's copy. With `--times`, the times go to the file it names, and the run deals by that file
too. A gate that keeps a record of its own runs names it, so hand runs and benches never change how
the gate deals:

```json
{
  "res://tests/a_test.gd": {
    "seconds": 12.4,
    "cases": { "test_x": 5.1, "test_y": 7.0 },
    "rows": { "test_y": [3.4, 3.6] },
    "peak": 1610612736
  }
}
```

`seconds` is the suite run whole, with its `before` and `after`. `cases` holds each function, with
the rows of a parameterised one added together. `rows` holds what each row of a parameterised case
took, from row 0. `peak` is the most memory, in bytes, an engine holding the suite was seen to hold.
A run that closes the suite replaces it.

### Missing and stale times

A case never timed is taken to cost the median of the cases that have been, or 0.02 s when nothing
has. Each run that writes the file drops a suite the project no longer has, deleted or renamed. It
also drops a case its suite no longer declares and takes its seconds off the suite's. A run that
printed only some rows of a case, because it was dealt them or cut short, keeps the old times of
the rest. A suite with no peak kept counts as 1.5 GB.

### Splitting a suite

A suite is dealt out case by case when it has more than one case and costs more than 10 seconds. It
must also cost more than an engine's even share of the run. That share is the cost of every suite
over the engines there is room for. An engine holding part of such a suite skips the rest. The run
names each suite it dealt out that way.

A suite within its share is balanced by the rest.

### Splitting a parameterised case

A parameterised case that costs more than that share by itself, with at least two rows timed, is
dealt out row by row. That holds in a suite of any number of cases. Each engine holding some of its
rows runs only those. The one holding the last row also runs any row the times do not know. A row
added since they were taken still runs once.

The run names each case it dealt out that way. It fails when a row that any engine found ran in
none of them or in more than one.

### Keeping a suite whole

A suite declaring `const GDHARNESS_TOGETHER: bool = true` is never dealt out by case or by row. It
goes to one engine whole. Use it when its cases share work kept in the suite, such as a memoised
setup. Every engine holding part of it would do that work again.

The declaration counts from the suite or any script it extends, and the nearest one decides. A
suite can say `false` over a base saying `true`. A run over several engines names each such suite
it kept whole past that cost.

### How many engines start

Units are dealt slowest first, each to the engine with the least so far. Each engine then runs its
suites cheapest first, so its slowest suite does not run while the other engines are starting. A
run starts no more engines than the smallest of these:

- `--engines`.
- The machine's processors, or `--cores`.
- What its free memory allows past 4 GB, at the largest peak kept for any suite of the run.
- What it takes to keep each engine busy for as long as the slowest unit or 5 seconds, whichever
  is longer. One more is added for each unit with a case never timed.

The median is only a guess at what an untimed case costs. It guesses worst for a suite just split
out of a slow one, and for every suite on a project's first run. A run held below `--engines` by
processors or memory says which on its first line.

### Free memory

On macOS the free memory is the share the system itself counts as free, which includes the cache it
can give back. On Windows it is the smaller of the physical memory free and what the system can
still commit. An allocation fails at the commit limit however much physical memory is free. An
engine's own figure is what Windows has committed to it, and its resident memory on Linux and macOS.

### When some slots are held

That deal needs every slot the run uses free as it begins. Another run or tool may hold some (a
gate's export, say). Then the run says how many were free and hands the work out a share at a time.

Each slot it holds starts an engine on a share. An engine starts in each other slot as that slot
comes free. An engine that finishes its share while shares remain runs the next in the same
process, so a share after the first pays no engine start. A lane whose engine crashed or was ended
takes its next share in an engine started for it. An engine is reused only when memory does not
hold the run. In a run held by memory each share gets an engine of its own, admitted for that share.

Each share is judged on the lines the engine printed for it, with its own cases, failures,
timeouts, deadline and peak memory. A share in an engine that ran out of memory fails and is not run
again. What the engine reports as leaked at exit is attributed to the share it ran last.

The run and the engine pass shares through the folder named by `--shares-in` (see
[Starting the runner yourself](#starting-the-runner-yourself)). A share in an engine already
started has no start time of its own, so its `startSeconds` is null and the start figures below
read only the engines that started.

### Shares

The windowed suites go out first and whole. After them, a share is the slowest units that fit in
what is left divided by the run's engines. It is never less than six engine starts' work while that
much is left, since every share starts an engine, and never more than 120 seconds. A suite longer
than that is a share of its own.

An engine start is read from the run's own engines: the seconds each took before its first suite,
which the run prints as "Before their first suite the engines spent". Until two engines have
shown it, a start counts 5 seconds, so the floor is 30. The middle reading of theirs and the 5
seconds is taken (the lower of two middle ones), so one start, fast or slow, never sets it alone.

The shares shrink as the work runs out. A slot freed partway through takes on part of what is
left, rather than a part fixed when the run began. Once everything is handed out, the run stops
waiting for slots.

### When memory is short

Memory is handed out the same way. The memory free as a run begins may hold it below the engines
the processors allow. Then the run deals for those engines, says how many memory had room for and
hands the work out a share at a time.

Before each engine starts, the memory free is read again. The engine starts once that covers the
most its share's suites were seen to hold. Each engine going counts at what its share was seen to
hold, less what it holds now. The run's first engine always starts.

A share waiting for memory keeps a mark in the slots' `waiting` folder, as a wait for a slot does.
It takes its slot first and gives it back while it waits. Once memory has room it takes a slot
again, and memory is judged again before its engine starts.

### The memory ceiling and the kept peak

Every engine gdharness starts is read about once a second, with the processes it started. That
covers a headless operation, `project_test`, a game from `editor_run start`, the boot of
`editor_run check`, an editor from `editor_launch open` and the engines of a `gdharness test` run.
A game a server left running is read by the next server that picks up its run. The figure is
private bytes on Windows and resident memory on Linux and macOS. An engine past its ceiling is
ended with everything below it. The answer, the run's result and its printed line give the peak
and the ceiling and name how to raise it.

The ceiling is a quarter of the physical memory and at least 4 GiB. `GDHARNESS_ENGINE_MEMORY_CEILING_MB`
sets it, in megabytes, for every engine. The project setting `gdharness/engine/memory_ceiling_mb` in
`project.godot` sets it for the engines started for that project and wins over the variable. A
setting that is not a whole number above 0 refuses the start, and so does one written in quotes.
The answer for an engine ended for its memory names where its ceiling came from: the setting, the
variable or the default.

The memory of an engine is read in the same sample as its processor time, so an engine watched for
both is read once for each tick.

When an engine ends, its peak is kept for its project and tool in `runs/memory-<project>-<tool>.json`.
The boot of `editor_run check` keeps its own, apart from the game's. An engine ended for its memory
keeps none. The next start of that tool in that project counts the larger of 1.5 GiB and the kept
peak, up to the ceiling. It is refused when the free memory less the reserve does not cover it. The
refusal says what the engine needs, what that comes from and how much is free. It then names how
much memory to free, or the ceiling to set that lets the engine start. That ceiling leaves a margin
of a quarter of the room, and at least 1 GiB, for free memory that moves before the next start.

## What fails a run

- A case that failed, or that failed and then passed on a retry.
- An engine error (`ERROR:`, `SCRIPT ERROR:` or `USER ERROR:`) that the suite did not declare,
  except [before a driver switch](#errors-before-a-driver-switch).
- An error a suite declares that it did not print.
- A suite that never started, never finished, or finished without running every case it declares.
- A case that ran without being planned, or a suite the engine ran without being handed it.
- A suite that reports a failure while all its cases passed, which is a failing `before` or `after`.
- A run that printed no summary or ran no case, or a script gdUnit4 could not load.
- A script under the folders searched for suites that declares `test_` functions but extends
  nothing that reaches `GdUnitTestSuite`. gdUnit4 runs none of its cases and says nothing, so the
  run names the script beside the suites it did run.

### Engine failures

- Objects, resources, memory pages or a server's RIDs still held as the engine exits
  ([leaks at exit](#leaks-at-exit)).
- An exit code other than 0, named by its meaning ([exit codes](#exit-codes)).
- A crash report from the engine's crash handler, whatever code the engine exited with.
- Orphan nodes ([orphan nodes](#orphan-nodes)).
- An engine that printed nothing at all.
- An engine ended for its silence or its deadline, or because an autoload did not start.
- An engine whose banner names another version than `--godot-version` asks for.
- A gdUnit4 that no longer works the way the runner relies on
  ([gdUnit4 checks](#gdunit4-checks)).

### Errors before a driver switch

The errors before Godot's warning that it is switching to another rendering driver are left out.
The display server is made before any of the project's scripts run. Those errors are the engine
trying a driver the machine lacks, as a windowed engine does on a machine without a Vulkan surface.

### Leaks at exit

A RID made through a server and never freed shows only as `1 RID of type "CanvasItem" was leaked.`,
with no object counted beside it.

Godot never frees a script that exports an array or dictionary typed with its own class. An example
is `@export var parts: Array[Item]` in the script declaring `Item`. A run that loads one always
ends this way, and the verdict names each such script in the project. Typed with a class it extends
instead, as `Array[Resource]`, it is freed.

### Leaks on engines before 4.8

Below 4.8 the engine's shutdown can stop part way through its scripts, when releasing one frees the
next. That is godot#117991, fixed in 4.8 by godot#120976. The engine then reports as held
everything it never reached. On those engines the runner keeps every script loaded from a file
alive until that walk is over, so the walk finishes. It prints a line as the walk starts and
another as it ends.

A run whose walk still stopped part way lists what the engine reported under "not counted against
the run" instead of failing on it. What a test leaks itself, a script it holds included, is still
reported and still fails the run.

### Exit codes

A code is named as a Windows status such as `0xC0000005 (STATUS_ACCESS_VIOLATION)`, or as one of
gdUnit4's, such as 101 for orphan nodes. gdUnit4 exits with 100 when a case failed, and that code
is left out beside the case's own line. An engine that died on a Windows exception status also says
how much memory was free as it ended.

### Orphan nodes

Orphan nodes are named by the case that left them, or by the suite's `before()` or `after()`. The
verdict gives each node's class, its name when it has one, and its script, eight to a line and the
rest counted.

gdUnit4 names them only where a case calls `collect_orphan_node_details()`. So the runner notes the
orphans as each case and suite starts, and names what is new when gdUnit4 counts some.

gdUnit4 counts both hooks' orphans as the suite ends. Those already there as its first case began
are `before()`'s. In a suite whose cases never began, the two are named together. The suite fails
with them, and 101 is left out beside the line.

### gdUnit4 checks

The runner replaces gdUnit4's test session with a faster one and turns gdUnit4's reports off. If
the installed gdUnit4 no longer works the way the runner relies on, the run fails and names
gdUnit4's version. A file in an engine's reports folder fails it too, since it means gdUnit4 no
longer reads the runner's mark.

## What a failed run prints

Each failure is printed with the lines that show it. Those are a failing case's report, each
unexpected error and the line after it, and the run's summary. When an engine was cut short and
none of that explains it, its last 60 lines are printed.

The engine's whole output stays in `.godot/gdharness/test-runs/<start>-<pid>/engine-<n>/engine.log`,
which the output names. The file opens with the engine's verdict, so it says why even for an engine
that printed nothing.

On Windows every engine runs in a job named `gdharness-engine-<pid>`, which holds the engine and
everything it starts, so a reader can open it by name and total their processor time. Beside each
`engine.log` is a `lane.json`, `{"lane": 0, "pid": 1234}`, written before the engine runs. It names
the lane the engine ran in, counting from 0, and the engine's own pid, which the job is named after.
An engine handed a further share has the same file in each share's folder, and logs copied to the
main checkout take it with them.

A project that is a worktree of another checkout has the logs of a failed run copied to the same
place under the main checkout. The output names the copy and then the worktree's own. A gate
running in a worktree of the commit removes the worktree once the run ends.

### Before the verdict

A run over several engines says what each took beside what it was dealt. That tells an uneven deal
from a slow suite. A run of several suites names its five slowest. The last lines count the
problems and name the run's directory.

A run that passes leaves no logs, unless `--keep-slower-than` kept the logs of its slow cases. A
failed run keeps its logs until five later runs have failed, however many slow runs follow. The
run that tries to reproduce a crash then does not remove the log that explains it. `--print-output`
prints every engine's output before the verdict, whether the run passed or not.

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
printing it twice lists it twice. A parameterised case declares what one row prints.

A declared text the case does not print fails the run too, since the case no longer reaches what it
was written to test.

There is no way to accept errors across a whole run. gdUnit4's own `report/godot/script_error`
setting decides only which errors fail a case. An error a case meant to raise with `assert_error` is
declared like any other.

### Which case an error belongs to

An error counts as the case's that was running when it was printed. One printed after a case's
verdict counts as that case's while another case follows. What a case leaves for a later frame
prints there. Once the last case is done, it counts as `after`'s.

### Warnings

An engine warning printed while a suite runs fails the run the same way. Godot answers some refused
changes with nothing but a warning. A suite that prints one on purpose declares it in
`GDHARNESS_EXPECTED_WARNINGS`, keyed the same way, with the text after `WARNING:` and its space. A
text declared as an error does not accept a warning, or the reverse.

A warning printed outside every suite fails the run as an error there does. It comes from an
autoload, a session hook or the game's own code, and no suite can declare it. A warning the
`--import` engine prints fails the run too.

### Warnings about the machine

A warning outside every suite that the engine's platform layer or a rendering driver raised is about
the machine and is not judged. Its `at:` line names a file under `platform/` or `drivers/`. A
windowed engine on a macOS runner's virtual GPU warns this way that it is switching to ANGLE. So
does an engine falling back to another rendering driver.

### In `project_test`

`project_test` judges a run's errors and warnings by the same declarations. It names what fails the
run under `undeclaredErrors` and `declaredNotPrinted`, a warning marked `warning: true`.

## Suites that need a window

A suite declaring `const GDHARNESS_NEEDS_WINDOW: bool = true` runs in an engine with a window, since
a headless engine delivers no input events. So does one calling gdUnit4's `scene_runner` that
declares nothing, which is a guess. A suite that uses the scene runner only to stand a scene up and
read it declares `const GDHARNESS_NEEDS_WINDOW: bool = false` and runs headless. The declaration
counts from the suite or any script it extends.

Either declaration can name a constant of a class the project declares, such as
`const GDHARNESS_NEEDS_WINDOW: bool = GameFixture.NEEDS_WINDOW`. That constant must itself be `true`
or `false`. A declaration gdharness cannot read refuses the run and names the suite.

A project whose scene runner suites pass headless turns the guess off for every suite. It sets
`gdharness/tests/scene_runner_needs_window=false` in `project.godot`. Then only a suite declaring
`true` gets a window.

### The accessibility tree

Godot builds the accessibility tree only for a screen reader or with `--accessibility always`. A
suite declaring `const GDHARNESS_ACCESSIBILITY: bool = true` gets a window and an engine started
with that flag, in `gdharness test` and `project_test` alike. It is read like the window constant,
from the suite or a script it extends, or from a class constant. A suite declaring it beside
`GDHARNESS_NEEDS_WINDOW` false is refused.

The engine sends a control `NOTIFICATION_ACCESSIBILITY_UPDATE` only once something has asked for
the tree. On Windows the run asks once through UI Automation, as a screen reader does, before the
first suite starts. A run that could not ask prints why, starting with
`gdharness could not ask for the accessibility tree`.

### The windowed engine

All the windowed suites go to one windowed engine, which starts first, counts toward `--engines`
and runs nothing else. A suite there sees the machine's real screen size, scale and keyboard
layout, and runs slower for drawing frames.

### After the windowed engine

Once the windowed engine ends, a headless engine follows it in the same slot without giving the
slot back. It is dealt as though it began then, so a few quick windowed suites never leave a slot
idle. The windowed engine takes no second share, since its display flags belong to the windowed
suites. With `--engines 1` the run is that one slot, the windowed engine and then a headless one.
On a machine with room for fewer engines than asked for, the slots run one after the other. The
line announcing the run says so.

An ordered run (`--order`) is one engine, or two when it mixes the kinds: a windowed engine for the
suites needing a window and a headless one after it. Each keeps the order of the run within it.

### How the windowed engine runs

The windowed engine runs without `--headless`, at the size `project.godot` gives its viewport. Like
every other test engine, it uses the Dummy audio driver.

On Windows it runs on a desktop of its own, so its window never appears on the desktop in use or
takes its focus. That desktop has no compositor, so a layered window fails there once it has been
shown again. [The install guide](install.md) says how a game tells. The headless engines run there
too, since an engine that fails to start shows a modal alert even with `--headless`.

Elsewhere it uses the display there is. On a CI runner with none, run it under `xvfb-run`.

gdUnit4 minimises its window as the runner starts and after every suite, and a minimised window
draws nothing. So the runner puts the window back before each suite begins.

### Windows in `project_test`

The `project_test` tool reads the suites the same way. A run whose suites all need a window, or all
do not, is one engine, with a window if they need one, started as above. A named set mixing the two
kinds runs as two engines, the windowed suites with a window and the others headless, one after the
other, and the answer is the sum of both with `engines` set to 2. The answer's `windowNote` names
the suites that needed a window. On a machine with no display the run stays headless, and the note
says so.

### macOS runners

On a GitHub macOS runner, Metal under Forward+ often prints `timeout waiting for fence` in a
windowed engine, which fails the run. Mobile, Compatibility and the Vulkan driver do not. A Forward+
project can set `rendering/rendering_device/driver.macos` to `vulkan`.

## Silence and memory

An engine that prints nothing for 300 seconds is ended, and the case it was in is named.
`--silence` changes the 300.

A case may stay silent for four times its last time, when that is longer than the limit. At the
default limit, that is a case whose last time was over 75 seconds. For a row of a parameterised
case it is the row's time. A suite's hooks, and the stretch between its cases, get four times the
time the suite spent outside its cases.

The limit follows what the engine is running, not the slowest suite dealt to it. A long suite does
not let a suite beside it hang for as long.

### Deadlines

Silence never ends an engine that keeps printing, such as a case warning every frame. `--deadline`
ends any engine that has run that many seconds and names the case it was in. An engine whose
autoload did not start is ended as soon as it says so, since nothing a suite reports without it
means anything.

### A busy machine

While other work keeps a quarter of the machine or more busy, both limits count the engine's own
processor time rather than the clock. An engine slowed by a crowded machine is then not ended as if
it had hung. A hung engine uses no processor, so eight times either limit on the clock still ends it
however busy the machine is. Its ending says how it was counted.

### Running out of memory

An engine that runs out of memory fails, and the run fails with it. No engine is run again. The run
says an engine ran out of memory and gives the most each engine held in this run, or unread.

Running out shows as the allocator's null, an image decode failing, godot-sandbox failing to
allocate a sandbox, or Windows' `STATUS_NO_MEMORY` or `STATUS_COMMITMENT_LIMIT`.

## Leaving out what passed

`--changed-only` leaves out every suite that passed last time on inputs that are all unchanged. It
runs the rest. A gate can pass it, because a suite is left out only when the files it ran on are
the same to the byte. Every script is still compiled together in an engine of its own. A script
that no longer compiles fails the run even when every suite is left out.

That engine is left out too when nothing changed since the scripts last compiled together cleanly.
That means the suites and every class the cache lists, with all they reach, the same to the byte. A
run with nothing to run then takes no engine slot and waits for none.

### Recording a pass

A suite is recorded as passed only when its engine raised nothing outside any suite and none of
its inputs changed while it ran. The suites that passed are kept with their inputs in
`.godot/gdharness/suite-passed.json`, beside the times.

A run of chosen cases, such as `suite.gd:test_one`, records no pass for the suite, since the rest
of its cases did not run. A failing case still removes the pass its suite had. A run that cannot
write that file fails, because the file would go on keeping a suite that failed as passed.

### A suite's inputs

A suite's inputs are what its engine recorded for it as the run went:

- its own script
- what the autoloads loaded
- every path a loader was asked for while the suite ran
- every project script the engine compiled then without asking a loader

From those files the inputs are followed further:

- the scripts each one preloads or names
- what each one loads by a literal or constant path
- the paths a scene or resource names
- each resource's `.import` and `.uid` files
- the whole of any addon reached

A constant may be inherited, belong to another class (`Main.MUSIC`), or be built from literals and
constants joined with `+`.

### Loads the cache answers

The engine answers a load of a resource it holds from its cache without asking any loader. gdUnit4
loads every suite of an engine, with all they preload, before the first one runs. So a load the
cache answers is never recorded.

A suite loading by a path worked out at run time therefore has more inputs. They are the project
files the cache held as it began, other than the engine's suites. With a literal or constant prefix
(`SOUNDS + take + ".ogg"`), only the files under that prefix count.

The cache holds a resource only while something refers to it. What an earlier suite loaded and let
go is not among a later suite's inputs, because loading it again asks a loader.

### Files read at run time

A file read, listed or asked about (`ResourceLoader.exists`) by a literal or constant path is an
input. One missing then counts as changed when it appears.

A path joined at run time onto a folder the script names makes every file under that folder an
input. Examples are `FOLDER.path_join(name)`, `FOLDER + name` and `"res://data/%s.json" % name`. One
read by any other path computed at run time, or a `uid://` preload, makes every file in the project
an input. A `user://` path is never one.

A check or listing by any other computed path reads no file's content. Examples are
`FileAccess.file_exists`, `ResourceLoader.exists` and `DirAccess.get_files_at`. Such a call makes the
names of every file and folder in the project one input. It changes only when a file or folder
comes, goes or is renamed.

### Paths held in names

A path can come through a name. A local set once and never again holds what it was set to. A
parameter holds what every call that can reach its function passes it, or its default. The trail is
followed through any number of functions.

### Calls that reach a function

A call can reach a function from the function's own script, its bases and the scripts extending
it. From any script, it can come through a class, an autoload, a preloaded script, or a variable
typed as one of those. A call through an untyped variable or an expression could be to any
object, unless it passes an argument count the function cannot take.

A function also named without a call could be passed anything. That covers one handed on as a
`Callable`, called by name through `call()`, or named as a scene's method. So could a name a lambda
in the function takes, or a `match` binds again.

### Inputs of every suite

Every suite also has these inputs:

- `project.godot`
- the gdharness version and runner
- the engine executable's path past every link, size and modification time
- what each file named with `--reach-also` holds, wherever it lies
- all of gdUnit4, an addon the runner loads

So checkouts reaching one engine install through junctions of their own, with the records copied
between them, keep each other's passes. That holds at any depth, with the `--reach-also` files
inside them or outside.

## Engine slots

The slots are files in one directory, shared by every tool on the machine that starts an engine,
for every project. Several games' test runs, a benchmark and a build running at once then start
no more engines between them than there are slots.

The MCP server's own engines take them too. Each headless operation, script check, export,
`project_test` run and `editor_run check` waits for a slot before its engine starts. So does a game
started with `editor_run start`, whether the server starts it or the editor plays it. The game
keeps the slot for as long as it runs.

An import takes none. That covers every `project_import` op and its status reads, the import
another call starts first, the class cache rebuild an import or an operation runs first, and the
engines of `gdharness setup`, `runtime`, `upgrade` and `uninstall`. They are short steps every
other call waits behind. A test run's own engines, and the import passes it hands to its suites,
still take a slot. Inside an engine's slot (`GODOT_ENGINE_HELD`) an import runs on that slot as any
engine does.

These engines of one project run one at a time across the machine, since each writes the project's
`.godot`. Each takes the project's lock, `<directory>/projects/<key>.lock`, made and judged as a
slot's lock is, and waits while another holds it. The key is the first 16 hex digits of the SHA-256
of the project's resolved path, lower-cased on Windows. An engine for another project does not
wait. A tool call waiting for the lock is told as for a slot, below, with the process that holds it
named.

### Games and their slots

A game outlives the server that started it, so its lock is handed on. It goes to the keeper holding
the game, or to the game the editor plays once it announces. It is free once that process has gone.
A played game that has not announced by the end of the start's wait gives its slot back, since
nothing would see it end. An editor, and a game played from it by hand, take none.

### Waiting for a slot

A wait for a slot is announced. A tool call that asked for progress hears it at once and every 20
seconds after. A call that waited a second or more in all is answered with an `engine_slot_wait`
block. It holds `waitedMs` and a note naming who held the slots when it first waited. A wait for a
free slot that the memory check holds back, on Windows and Linux, says so instead, naming the free
memory, the memory kept, what the running engines still owe and what the engine needs.

`gdharness test` and `gdharness spread` print a line once the wait passes 2 seconds, and again
every 20 seconds while it lasts. It is one line however many of its engines are waiting. Every
other command prints it to standard error. The line names the directory and the count.

### The directory and the count

They are the same for every tool on the machine. The directory is the first of these that applies:

1. `GODOT_ENGINE_SLOTS`, when it is set and not empty.
2. `$XDG_CACHE_HOME/gdharness/slots`, when `XDG_CACHE_HOME` is set and not empty, on any platform.
3. `%LOCALAPPDATA%\gdharness\slots` on Windows.
4. `~/.cache/gdharness/slots` everywhere else.

The count is the file `<directory>/count` when it holds a whole number above 0. Without one it is
`GODOT_ENGINE_SLOT_COUNT` when that is set, a whole number above 0. Otherwise it is half the
processors the machine offers, rounded down, and at least one. A command's `--slots` and
`--slot-count` come before the variable and the processors, and the file before all of them. The
file is read at each take, the variable once per process.

`--engines` is how many engines one run would like, and is not the slot count.

### The contract for another queue

A queue that takes slots without gdharness's code follows the six items below. gdharness's own
takes follow them too, so both kinds of taker count one machine alike.

#### (i) The lock

- A slot is `<directory>/<n>.lock`, for `n` from 0 below the count.
- To take one, create the file exclusively (`O_CREAT | O_EXCL`, Python's `open(path, "x")`). Write
  `{"pid": <your pid>, "started": <your process's start time>}` into it. The time is in
  milliseconds since the epoch, as the operating system reports it.
- A lock may be read empty for a moment, between its creation and its text. Hold an empty lock as
  held, whatever decides on it. One still empty 10 seconds after it was made belongs to a taker
  that died, and is free.
- A lock is free when no process has its pid, or the process with that pid started more than 2000 ms
  away from `started`. A lock whose holder's start time cannot be read is held.
- To take a free lock over, create `<n>.lock.steal` exclusively. Holding it, read the lock again, and
  if it is still free remove it, create it as above and remove the steal file. If the steal file
  cannot be created, someone else is taking the lock over. Remove it only if it is more than 10
  seconds old. When nothing is free, look again 50 ms later.
- Marks and steal files are written whole. The text goes to a file beside,
  `.<name>.<pid>-<thread>.writing`, and is put in place under the name without replacing a file
  that exists (a hard link, or a rename that Windows refuses onto a taken name). A reader never opens
  a `.writing` file or counts it as a lock or a mark.
- An optional `"by"` says what took the slot, such as the tool and its project. A wait names each
  holder by it, or by its pid when it is missing.
- An optional `"memory"` says the peak in bytes the engine on the slot may reach, which (v) reads. A
  lock without it counts 1.5 GiB. The holder raises it, to the next 256 MiB, as its engine grows
  past it.
- An optional `"engine"` is `{"pid", "started"}` of the engine process, written once the holder
  has its pid (see Holders that are not the engine).

#### (ii) The waiting mark

A taker that finds every slot held keeps one mark for each slot it waits for, from the first such
look until the take ends, however it ends.

- The mark is `<directory>/waiting/<pid>-<n>.json`, with `n` unique within the process. It is made
  exclusively as a lock is, and the folder is made first if it is missing.
- It holds what a lock does (`pid`, `started`, optionally `by`) and `since`, when the take
  began to wait, in milliseconds since the epoch. The marks one take makes together share their
  `since`.
- A reader takes a `since` below 100000000000 as seconds since the epoch. It takes a mark with no
  `since` as begun at its file's modification time.
- A taker may touch `<mark name without .json>.seen` beside its mark at each look, and remove it with
  the mark. Its time says when the taker last looked. A mark with no such file looks since it was
  made.
- A mark whose `taker` is `memory` is a wait for something other than a slot. It takes no place in
  line.

#### (iii) The line order

Take in the order you began to wait.

- At each look, read every live mark but your own. Those with an earlier `since` are ahead of you,
  the earliest first. Where two `since` values are equal, the lower pid is ahead, and where those
  are equal too, the mark whose file name is first, byte by byte. Name marks in ASCII, so that
  every reader orders them alike.
- Each waiter ahead leaves one free slot to itself, the lowest first. Take the free slots that are
  left.
- Before you have a mark of your own, no other taker sees you. Two takers that began in the same
  millisecond may then both go first, and the slot's lock decides between them.
- A taker that already holds slots keeps the `since` of each mark it still waits on.
- You may take a slot you have left for 5 seconds. A waiter that has not looked for 5 seconds,
  counted from the later of the first time you left it a slot and its last look, is left nothing
  until it looks again. A slot you have left to waiters ahead at every look for 5 seconds is yours
  to take, since a waiter that holds the place and does not take the slot waits for something
  else.
- A waiter that leaves a free slot untaken is waiting for something else, such as memory.

#### (iv) The cap

- `<directory>/count` holds a whole number above 0, the count of slots. Read it at every take.
- Where the file does not exist, the count is `GODOT_ENGINE_SLOT_COUNT`, then half the processors.
  Processes started before and after a change of the variable disagree until they restart, so a
  machine that changes its count writes the file. gdharness setup writes none.
- A file that holds anything else counts as missing.
- Take a free slot only while the live locks in the folder, whatever their number, are fewer than
  the count. After taking, count the live locks made before yours, by file time and then slot, and
  give the slot back when they are as many as the count.
- A lock numbered at or past the count belongs to a taker given a larger count. At each take,
  remove every such lock whose holder has gone, under its steal file as in (i).

#### (v) The memory check

Before taking a free slot, an engine of `need` bytes checks that
`free - kept - owed >= need`. gdharness makes this check on Windows and Linux only. On macOS only
the count holds a take, since the system's free share there, less `kept`, leaves a small machine
room for one engine.

- `free` is the memory the machine can give engines now: the free physical memory as Node's
  `os.freemem()` reads it. On Windows it is the smaller of that and the commit left
  (`ullAvailPageFile`), and on macOS the total memory times the percentage `kern.memorystatus_level`
  reports.
- `kept` is 4 GiB, left for everything else.
- `need` is the engine's peak in bytes. gdharness uses the peak kept for the engine's project and
  tool, at most the engine's memory ceiling, and 1.5 GiB where none is kept.
- `owed` is the sum over every slot lock whose holder lives of its `memory` (or 1.5 GiB) less the
  memory the process its `engine` names, and the processes below it, hold now, never below 0. A lock
  that names no engine yet, or whose engine cannot be read, owes its whole figure. A lock still
  empty counts nothing.
- A take that finds no other lock live starts whatever the figures, since nothing would give memory
  back. After taking, count again with only the locks made before yours, and give the slot back and
  wait when they leave no room, so two takers that read one room do not both start.
- Write the peak your engines reach into their locks as `memory`, so another queue reads the
  machine the same way.

#### (vi) Cleanup

A lock or mark whose pid is gone, or whose pid's start time differs from the one it records by more
than 2000 ms, is removed by any reader, under its steal file for a lock. A mark that is still
empty or names no holder is being written and is passed over. A reader also removes the `.seen`
and `.ended` notes beside marks that are older than 10 minutes.

### A slot lent to a child

gdharness starts every engine it holds a slot for with `GODOT_ENGINE_HELD` set to that slot's lock
path. A taker started under it runs one engine on that slot rather than take a second one. Any
further take of that taker takes a slot of its own. The slot is the engine's only in one of two
ways:

- The slot's live holder is the nearest process above the taker running another executable. The
  search passes over launchers of the taker's own (a `bun` under `bun run`).
- The lock names that process under `engine`, `{"pid", "started"}` as a holder is written, with a
  start within 2000 ms.

### Holders that are not the engine

A holder that is not the engine writes `engine` once it has the engine's pid. Such a holder is the
keeper of a game, or a server waiting on an engine it started. It writes `engine` again when a game
restarts itself into another. A game an editor plays inherits the editor's environment while the
lock names the editor, so it takes a slot of its own. The taker never gives the lent slot back,
because it stays its holder's.

### Removing locks on Windows

On Windows, Python opens a file without delete sharing. A lock or mark open in another process
cannot be removed until it is closed. gdharness retries a refused removal for a second, and a
game's own tool that removes them should do the same.

### Reading the wait marks

The marks let a tool that counts its own time tell a wait for slots others hold from its own work.
`gdharness test`, `gdharness spread` and the server's own engines keep one whenever they wait. A
reader skips a mark that is still empty or names no holder, since it is being written. It removes
one whose holder has gone, by the same rule as a lock.

### Start times

The start time tells a holder from a later process given its pid. Windows reports a process's
creation time to the millisecond, and `ps -o lstart` on macOS only to the second. That is why the
tolerance is two seconds.

On Linux, read it as gdharness and psutil's `create_time()` do. Take the `btime` line of
`/proc/stat`, plus the 22nd field of `/proc/<pid>/stat` divided by `getconf CLK_TCK`, in seconds.
That is up to a second early. `ps -o lstart` there cuts the same sum to the second again and reads
up to two seconds early, which is the whole tolerance.

## Preparing the game before any suite

Something every suite needs in place before the first one runs goes in a gdUnit4 session hook. It
might be a root node of the game's own, or a pace the game's clock runs at. The runner leaves the
project's hooks on. Each engine calls the hook's `startup` once before its first suite and its
`shutdown` once after its last.

A hook extends `GdUnitTestSessionHook` and is registered in gdUnit4's settings dialog. The dialog
keeps it under `gdunit4/hooks/session_hooks` in `project.godot`:

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
the things a suite waits on or presses.

### `GdhWait`

- `GdhWait.until(tree, done)` asks `done` once a frame and awaits until it answers true. It answers
  false after 30 seconds (or the bound it is given), so something that never ends fails the case by
  name.
- `GdhWait.still(tree)` awaits three frames in a row with no tween running.
- `GdhWait.frames(tree, n)` awaits n frames.

### `GdhTweens`

- `GdhTweens.step(tree, seconds)` moves every running tween on by that much, as frames would.
- `GdhTweens.past(tree, seconds)` steps one frame further, for a case about what an animation
  leaves when it is over. A step ending exactly where the last tweener ends leaves the callback
  after it unrun.

A wait on a timer of an animation's length races the animation. The engine counts a tween's time in
frame deltas, so on a machine running other engines the timer ends with the tween still going.
Asking once a frame, or stepping the tween, holds however slowly the frames come.

### `GdhEvent`

`GdhEvent` builds events, each pressed unless told otherwise. Hand one to
`Input.parse_input_event`, or to a control's own `_gui_input`. The events are `click(at)`,
`release(at)`, `wheel(at, up)`, `motion(at, moved, held)`, `key(KEY_SPACE)`, `pad(JOY_BUTTON_A)`,
`axis(JOY_AXIS_LEFT_X, value)` and `action("jump")`.

`GdhEvent.press_and_release(event)` hands a press to `Input`, then the same event let go, and
flushes both. A press never let go stays held for every later suite in the same engine.

## What suites cost, by function

`gdharness test` runs suites as a script. The engine's script profiler only sees a scene, so it
cannot say where a tier's time goes.

`editor_run start` with `suites` plays them in the tests addon's suites scene through the same
runner. It takes the same paths as `project_test`. Then `editor_run profile` names what each
function cost:

```text
editor_run start    suites ["tests/house"], headless true, profile true
editor_output       until running is false
editor_run profile
```

The run quits with gdUnit4's exit code. A suite that needs a window needs `headless: false` here
too.

### Game code

For game code rather than suites, a scene can step its work one call a frame with
`GdhBench.each_frame(tree, most, step)`. It stops early when `step` answers false. It answers
`steps` and `ms_each`, the step's own time on average.

The profiler names only so many functions a frame, so work played inside one frame comes back
mostly unnamed. One step a frame names them all.

## Starting the runner yourself

`gdharness test --runner` prints the path of the shipped runner, `listed.gd`, for a tool that starts
an engine on it directly. It is started with `-s <path>` from outside the project. It takes
gdUnit4's own options, then these after `--`:

- `--suites-in FILE`: the suites to run, one `res://` path a line, in order.
- `--skipping-in FILE`: the cases to leave out, one `res://a_test.gd:test_x` a line, each for that
  suite alone (inherited cases included). Any other line is passed to gdUnit4's `-i` as it is.
- `--html-report-off` and `--junit-report-off`: no HTML report, and no JUnit report.
- `--compile-together`: compile the suites together beside every class of the game before running
  them, so every script that does not compile is named.
- `--expected-out FILE`: write each suite's `GDHARNESS_EXPECTED_ERRORS` and
  `GDHARNESS_EXPECTED_WARNINGS` there, as JSON under `errors` and `warnings`.
- `--shares-in DIR`: take more shares after the first. As each share ends the runner prints
  `gdharness share ended <n> exit <code>` and waits for `DIR/next-<n+1>.txt`. The file holds the
  arguments for the next share, one a line, as they follow `--` here, or `stop` to exit with the
  code of the share that ended.

### Inherited cases

The runner files every case under the suite it was found in. gdUnit4 alone files a case under the
script declaring it. Its reports then leave out every case a suite inherits. An inherited
parameterised case also runs as a suite of the base's own, outside the suite that inherits it.
