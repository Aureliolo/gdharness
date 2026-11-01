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

- `--engines N`: at most this many engines, 4 by default.
- `--slots DIR`: the slot directory, the machine's own by default (see
  [Engine slots](#engine-slots)).
- `--slot-count N`: how many slots that directory has. By default it is half the processors, at
  least one.
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
  is still imported first [when no suite could run in it](#when-a-run-imports-first).
- `--order reversed` or `--order SEED`: every suite in one engine, in reverse order of path or
  shuffled by a number. It finds suites that depend on the order they run in.

## Reuse options

- `--changed-only`: leave out the suites that passed on exactly the files their engine loaded, all
  of them unchanged. Every script is still compiled together, unless they compiled together
  cleanly on the same files last time.
- `--reach-also PATH`: a file every suite depends on, for `--changed-only`. May be given more than
  once.
- `--times FILE`: deal the suites by the times in `FILE` and record what they took into it, in
  place of `.godot/gdharness/suite-times.json`. A missing file deals as no times would.

## Output options

- `--print-output`: print everything each engine printed before the verdict, as for a benchmark
  written as a suite and run by hand.
- `--verbose`: start every engine with Godot's `--verbose` to name a leak at exit, where the engine
  otherwise prints only two counts. The verdict counts the objects left alive by class and names
  the resources still in use, the project's own before its addons'.
- `--result FILE`: write the run's result to `FILE` as JSON, for a gate that acts on more than the
  exit code. [The result file](#the-result-file) lists what it holds.
- `--runner`: print the path of the shipped runner and exit.

## When a run imports first

Without `--import`, a project is still imported first when no suite could run in it as it stands.
That is when one of these holds:

- It has no class cache.
- It holds a `.gdextension` and no `.godot/extension_list.cfg`. `gdharness setup` leaves it so,
  since it writes the class cache without importing.
- The cache does not list a class a script declares where the script declares it.

## The result file

Every run writes its result to `.godot/gdharness/last-run.json`, beside the project's suite times.
`--result` writes the same to a file of your choice. A gate that keeps none of a passing step's
output can still read it there. It holds:

- `passed` and `seconds`.
- `problems`: every problem the output lists, one sentence each. An engine's is prefixed with
  `engine N:`.
- `suites`: each suite an engine closed, slowest first. Each has its `path`, `seconds`, gdUnit4's
  `verdict` and the `engine` that ran it.
- `engines`: each engine, with the fields below.
- `logs`: the directory every engine's output is kept under.
- `enginesAsked`.
- `slotsFree`: how many of the slots its lanes take were free as it began. Fewer than the lanes
  means the engines were handed the suites a share at a time.
- `dealing`: the lines the run printed about its deal.

### Each engine

- `index` and `lane`.
- `startedAfter`: the seconds after the command started that it got a slot and began.
- `seconds`, and `dealt`, the seconds the times kept had it at.
- `passed` and `windowed`.
- `suites`: the suites it was handed.
- `log`: the file its output is kept in.

`log` and `logs` are null once a passing run has removed them. A run that failed its import, or had
nothing left to run under `--changed-only`, writes empty `suites` and `engines`.

## Which suites run

A suite is a script under one of the test directories whose chain of `extends` reaches
`GdUnitTestSuite`. The chain may name a class, a `res://` path or a path relative to the script.
The suite also declares a function starting `test_`, or inherits one from a script of the project.
Those functions are the cases it is expected to run, which is how a case that never ran is noticed.

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
    "rows": { "test_y": [3.4, 3.6] }
  }
}
```

`seconds` is the suite run whole, with its `before` and `after`. `cases` holds each function, with
the rows of a parameterised one added together. `rows` holds what each row of a parameterised case
took, from row 0.

### Missing and stale times

A case never timed is taken to cost the median of the cases that have been, or 0.02 s when nothing
has. Each run that writes the file drops a suite the project no longer has, deleted or renamed. It
also drops a case its suite no longer declares and takes its seconds off the suite's. A run that
printed only some rows of a case, because it was dealt them or cut short, keeps the old times of
the rest.

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

Units are dealt slowest first, each to the engine with the least so far. A run starts no more
engines than the smallest of these:

- `--engines`.
- The machine's processors, or `--cores`.
- What its free memory allows at 1.5 GB an engine, once 4 GB is left for everything else.
- What it takes to keep each engine busy for as long as the slowest unit or 5 seconds, whichever
  is longer. One more is added for each unit with a case never timed.

The median is only a guess at what an untimed case costs. It guesses worst for a suite just split
out of a slow one, and for every suite on a project's first run. A run held below `--engines` by
processors or memory says which on its first line.

### Free memory

On macOS the free memory is the share the system itself counts as free, which includes the cache it
can give back. On Windows it is the smaller of the physical memory free and what the system can
still commit. An allocation fails at the commit limit however much physical memory is free.

### When some slots are held

That deal needs every slot the run uses free as it begins. Another run or tool may hold some (a
gate's export, say). Then the run says how many were free and hands the work out a share at a time.

Each slot it holds starts an engine on a share. An engine starts in each other slot as that slot
comes free. An engine that ends is followed in its slot by one on the next share.

### Shares

The windowed suites go out first and whole. After them, a share is the slowest units that fit in
what is left divided by the run's engines. It is never less than 30 seconds while that much is
left, since every share starts an engine.

The shares shrink as the work runs out. A slot freed partway through takes on part of what is
left, rather than a part fixed when the run began. Once everything is handed out, the run stops
waiting for slots.

### When memory is short

Memory is handed out the same way. The memory free as a run begins may hold it below the engines
the processors allow. Then the run deals for those engines, says how many memory had room for and
hands the work out a share at a time.

Before each engine starts, the memory free is read again. The engine starts when there is room for
one more. Each engine of the run started in the last 30 seconds counts at its whole 1.5 GB, since
it has yet to take it. The run's first engine always starts.

A share waiting for memory keeps a mark in the slots' `waiting` folder, as a wait for a slot does.
It takes its slot only once memory has room, so it holds no slot from anybody else while it waits.

## What fails a run

- A case that failed, or that failed and then passed on a retry.
- An engine error (`ERROR:`, `SCRIPT ERROR:` or `USER ERROR:`) that the suite did not declare,
  except [before a driver switch](#errors-before-a-driver-switch).
- An error a suite declares that it did not print.
- A suite that never started, never finished, or finished without running every case it declares.
- A case that ran without being planned.
- A suite that reports a failure while all its cases passed, which is a failing `before` or `after`.
- A run that printed no summary or ran no case, or a script gdUnit4 could not load.
- A script under the folders searched for suites that declares `test_` functions but extends
  nothing that reaches `GdUnitTestSuite`. gdUnit4 runs none of its cases and says nothing, so the
  run names the script beside the suites it did run.

### Engine failures

- Objects, resources, memory pages or a server's RIDs still held as the engine exits
  ([leaks at exit](#leaks-at-exit)).
- An exit code other than 0, named by its meaning ([exit codes](#exit-codes)).
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

A project that is a worktree of another checkout has the logs of a failed run copied to the same
place under the main checkout. The output names the copy and then the worktree's own. A gate
running in a worktree of the commit removes the worktree once the run ends.

### Before the verdict

A run over several engines says what each took beside what it was dealt. That tells an uneven deal
from a slow suite. A run of several suites names its five slowest. The last lines count the
problems and name the run's directory.

A run that passes leaves no logs. A failed run keeps its logs until five later runs have failed. The
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

A project whose scene runner suites pass headless turns the guess off for every suite. It sets
`gdharness/tests/scene_runner_needs_window=false` in `project.godot`. Then only a suite declaring
`true` gets a window.

### The windowed engine

All the windowed suites go to one windowed engine, which starts first, counts toward `--engines`
and runs nothing else. A suite there sees the machine's real screen size, scale and keyboard
layout, and runs slower for drawing frames.

### After the windowed engine

Once the windowed engine ends, a headless engine follows it in the same slot without giving the
slot back. It is dealt as though it began then, so a few quick windowed suites never leave a slot
idle. With `--engines 1` the run is that one slot, the windowed engine and then a headless one. On a
machine with room for fewer engines than asked for, the slots run one after the other. The line
announcing the run says so.

An ordered run (`--order`) is one engine, so a suite in it needing a window gives the whole run
one. Before it starts, the run names each suite declaring `false` that runs with the window.

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

The `project_test` tool reads the suites the same way. Its run is one engine, so when a suite in it
needs a window the whole run has one, started as above. The answer's `windowNote` names the suites
that needed it and those declaring `false` that shared it. On a machine with no display the run
stays headless, and the note says so.

### macOS runners

On a GitHub macOS runner, Metal under Forward+ often prints `timeout waiting for fence` in a
windowed engine, which fails the run. Mobile, Compatibility and the Vulkan driver do not. A Forward+
project can set `rendering/rendering_device/driver.macos` to `vulkan`.

## Silence and memory

An engine that prints nothing for 300 seconds is ended, and the case it was in is named.
`--silence` changes the 300.

A case may stay silent for four times its last time, when that is longer than the limit. At the
default limit, that is a case whose last time was over 75 seconds. For a row of a parameterised
case it is the row's time. A suite's hooks, and the stretch between its cases, get the time the
suite spent outside its cases.

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

When an engine runs out of memory, every engine that failed runs again, one at a time, and those
runs are the ones judged. Running out shows as the allocator's null, an image decode failing, or
Windows' `STATUS_NO_MEMORY` or `STATUS_COMMITMENT_LIMIT`. One that fails again is headed as run
again alone.

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

### Inputs of every suite

Every suite also has these inputs:

- `project.godot`
- the gdharness version and runner
- the engine executable's path past every link, size and modification time
- each file named with `--reach-also`, by its path in the project
- all of gdUnit4, an addon the runner loads

So checkouts reaching one engine install through junctions of their own, with the records copied
between them, keep each other's passes.

## Engine slots

The slots are files in one directory, shared by every tool on the machine that starts an engine,
for every project. The gates of several games, a benchmark and a build running at once then start
no more engines between them than there are slots.

The MCP server's own engines take them too. Each headless operation, script check, export,
`project_test` run and `editor_run check` waits for a slot before its engine starts. So does a game
started with `editor_run start`, whether the server starts it or the editor plays it. The game
keeps the slot for as long as it runs.

### Games and their slots

A game outlives the server that started it, so its lock is handed on. It goes to the keeper holding
the game, or to the game the editor plays once it announces. It is free once that process has gone.
A played game that has not announced by the end of the start's wait gives its slot back, since
nothing would see it end. An editor, and a game played from it by hand, take none.

### Waiting for a slot

A wait for a slot is announced. A tool call that asked for progress hears it at once and every 20
seconds after. A call that waited a second or more in all is answered with an `engine_slot_wait`
block. It holds `waitedMs` and a note naming who held the slots when it first waited.

`gdharness test` and `gdharness spread` print a line once the wait passes 2 seconds, and again
every 20 seconds while it lasts. It is one line however many of its engines are waiting. Every
other command prints it to standard error. The line names the directory and the count. A gate gone
quiet because the machine's other runs hold every slot then says so.

### The directory and the count

They are the same for every tool on the machine. The directory is the first of these that applies:

1. `GODOT_ENGINE_SLOTS`, when it is set and not empty.
2. `$XDG_CACHE_HOME/gdharness/slots`, when `XDG_CACHE_HOME` is set and not empty, on any platform.
3. `%LOCALAPPDATA%\gdharness\slots` on Windows.
4. `~/.cache/gdharness/slots` everywhere else.

The count is `GODOT_ENGINE_SLOT_COUNT` when that is set, a whole number above 0. Otherwise it is
half the processors the machine offers, rounded down, and at least one. A command's `--slots` and
`--slot-count` come before both.

`--engines` is how many engines one run would like, and is not the slot count. A gate given its
share of the machine passes `--engines` for its share. It passes the machine's directory and count
for the slots.

### Taking a slot from your own tool

A tool of a game's own that starts engines takes slots the same way, in the steps below.

### Step 1: create a lock

- A slot is `<directory>/<n>.lock`, for `n` from 0 below the slot count.
- To take one, create the file exclusively (`O_CREAT | O_EXCL`, Python's `open(path, "x")`). Write
  `{"pid": <your pid>, "started": <your process's start time>}` into it.
- The time is in milliseconds since the epoch, as the operating system reports it.
- An optional `"by"` says what took the slot, such as the tool and its project. A run waiting for a
  slot names each holder by it, or by its pid when it is missing.

### Step 2: find a free lock

When every slot exists, read each one. A lock whose holder's start time cannot be read is held. Any
other lock is free in these cases:

- No process has its pid.
- The process with that pid started more than 2000 ms away from `started`.
- The file is still empty or unreadable 10 seconds after it was last written.

### Step 3: take a free lock over

- First create `<n>.lock.steal` exclusively. Holding it, read the lock again, and if it is still
  free remove it, create it as in step 1 and remove the steal file.
- If the steal file cannot be created, someone else is taking the lock over. Remove the steal file
  only if it is more than 10 seconds old.
- On Windows a lock another process holds open cannot be removed. Leave it, since that process
  still has the slot.
- When nothing is free, look again 50 ms later.

### Step 4: mark the wait

From the first look that finds every slot held until the take ends, however it ends, keep a mark of
the wait.

- The mark is `<directory>/waiting/<pid>-<n>.json`, with `n` unique within your process.
- Make it exclusively as a lock is. Create the folder first if it is missing.
- It holds what your lock will, plus `taker` (`gate`, `timing`, `tier` or `other`, as below) and
  `since`. That is when the take began to wait, in seconds since the epoch.
- A wait for memory rather than a slot names `taker` `memory`.

### Step 5: take in order

Take in the order you began to wait. At each look, read every live mark but your own and `memory`
ones.

- Those whose `since` is earlier are ahead of you, the earliest first. A mark naming no `since`
  waits since its file was made, and one naming another `taker` is `other`.
- Give each, in turn, the first free slot of those it may take now (below, aged by its own `since`)
  not given to one before it. Leave those slots alone.
- You may take a slot you have left for 5 seconds, since one ahead takes a slot within a moment of
  its coming free. From then on, leave that waiter nothing.
- A waiter that leaves a free slot untaken is waiting for something else, such as memory.
- A `timing` taker leaves no slot to those ahead, because its queue has already given it its turn.

### Step 6: give the slot back

- When done, remove the lock, but only if it still names your pid.
- At each take, remove every `<n>.lock` numbered at or past the slot count whose holder has gone,
  under its steal file as in step 3.
- Only a taker given a larger slot count makes those locks. Takers with the normal count never look
  at them, so nobody else frees them.

### A slot lent to a child

gdharness starts every engine it holds a slot for with `GODOT_ENGINE_HELD` set to that slot's lock
path. A taker started under it runs one engine on that slot rather than take a second one. That
holds only while the slot is the engine's, in one of two ways:

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

### Gates come first

Each gate in the machine's queue, waiting for its seat or holding it, keeps a mark from its arrival
to its release. The mark is `<directory>/queued/<its ticket>.json` and holds what a lock does. An
empty `<its ticket>.json.seated` sits beside it once the gate has its seat.

A mark is live by the rule a lock is held by. One not yet written names nobody and is passed over.
One whose holder has gone is removed with its `.seated` file.

### The kept slots

The last `kept = max(2, floor(count / 4))` slots are kept for engines outside a gate, 4 of 16. The
first of them, `count - kept`, is for a gate's own steps (`GATE_KEPT`, one slot). Where two or more
are kept, the last, `count - 1`, is for one-off runs. While a mark is live, neither a gate's own
step nor a game takes it.

### Which slots each engine takes

A process runs inside a gate when `GODOT_ENGINE_SHARE` and `GODOT_ENGINE_SHARE_COUNT` are both
set. Each kind of engine takes:

- A gate's engine takes only the slots below `count - kept`, and slot 0 at least, whatever the queue
  holds. A gate's seat counts only these slots, so work in the kept ones never holds a seat back.
- A timing's engine, one with `GODOT_ENGINE_TIMED` set, takes any slot.
- Any other engine takes any slot while no mark is live.
- While a mark is live, a gate's own step outside its seat takes the kept slots but the one-off's,
  `count - kept` first. Such a step has `GODOT_ENGINE_TIER` set (`fast` or `full`).
- Any other engine then takes the kept slots but the gate's own steps' one, the highest first. After
  two minutes of waiting, one that is not a game takes any slot, so gates never hold it back for
  good.

### Games and the kept slots

A game `editor_run` started is one of those other engines. Its lock carries `"game": true`, which
stays when its keeper takes the lock over. While a mark is live, a game does not take the one-off's
slot. Games hold at most `min(floor(kept / 2), kept - GATE_KEPT - 1)` of the kept slots between
them (2 of 16) before a game's start waits.

An engine outside a gate tries the highest-numbered slot first, a gate's own step excepted. The
gates' slots then stay free longest. Which slots a take may try is asked again at every look. A
slot already held is kept to its end, whatever arrives in the queue.

### Removing locks on Windows

On Windows, Python opens a file without delete sharing. A lock or mark open in another process
cannot be removed until it is closed. gdharness retries a refused removal for a second, and a
game's own tool that removes them should do the same.

### Reading the wait marks

The marks let a gate that counts its own time tell a wait for slots others hold from its own work.
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

### Inherited cases

The runner files every case under the suite it was found in. gdUnit4 alone files a case under the
script declaring it. Its reports then leave out every case a suite inherits. An inherited
parameterised case also runs as a suite of the base's own, outside the suite that inherits it.
