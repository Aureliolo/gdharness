# Traps

What Godot does that costs an afternoon. Everything here was measured against the engine rather
than read somewhere, and most of it is why some tool is shaped the way it is.

## The editor's class list goes stale, silently

The editor fixes its list of global classes at startup and refreshes it only on a filesystem scan,
which it does when its window regains focus. Until then, every script that names a `class_name`
written since is "Could not find type", and the errors that matter arrive in the same block as
those phantom ones.

Worse, the editor writes that stale list back to `.godot/global_script_class_cache.cfg`, so a game
it launches cannot resolve those classes either: a parse error and a debugger break at the first
screen. Forcing the window to the foreground does not reliably fix it, and neither does opening the
defining file first, both measured here. `workspace/didChangeWatchedFiles` is ignored. This is
[godotengine/godot#42786](https://github.com/godotengine/godot/issues/42786), open since 2020.

**After writing a `class_name`, run `project_import refresh_classes` before running the game.** It
rewrites the cache from the declarations on disk and says what changed. `editor_rescan` asks the
editor for the scan it would do on focus. `gdharness doctor` says when the cache is stale.

## The debugger only works on a game the editor is playing

A game started as its own process has no debug session, so a breakpoint set through the adapter is
never hit and the stack is always empty. This is why `editor_run` asks the editor to play rather
than spawning an engine: the editor's debugger holds the game, `debug_*` speaks to that session,
and `editor_output` reads the console over it, since there is no pipe to read.

Set breakpoints before the run. They are registered on the adapter rather than on a session, so
they are already waiting when the game starts.

## There is no pause

Godot's debug adapter takes a pause request, answers it, sends the stopped event, and leaves the
game running. Measured on 4.7.2 over twenty seconds: the game kept ticking and the stack stayed
empty throughout. What Godot pauses is its own toolbar button.

So `debug_control` has `continue` and `step_over` and nothing else. Hold the game where you want it
with a breakpoint.

## Headless draws nothing, and its window is 64 by 64

A headless engine renders nothing at all, and its viewport texture keeps whatever was drawn last,
so a capture from one comes back byte for byte identical every time, with a success payload, for a
game that is running perfectly well. `runtime_capture` refuses instead of answering with that.

Input is different: all of it works headless. `runtime_input click` pushes the event into the
viewport rather than through `Input`, because `Input` accumulates events and flushes them on the
next frame, which would make the "what was under the pointer" answer describe the frame before the
pointer moved. The catch is the window size: a headless engine's viewport is 64 by 64 whatever the
project asks for, and the GUI only delivers to what is inside it, so a control at (400, 20) cannot
be clicked there.

## A screenshot is not evidence

A non-empty PNG says almost nothing. One stayed green here through a build that booted with three
errors. Read the boot log instead: `editor_run check` boots the project headless for a few frames
and answers with the verdict and every error and warning it printed, which is the thing you
actually wanted to know.

## Never pipe the engine into a reader that exits early

`godot ... | tail` kills the engine with SIGPIPE and reports exit 139, which looks exactly like a
crashed build. Redirect to a file and read the file.

## `--remote-debug tcp://127.0.0.1:0` on purpose

Port 0 never binds, so the connection is refused. That is deliberate: it stops the engine dropping
into its interactive `debug>` prompt on a parse error and hanging the run forever with no stdin to
answer it. The two connection errors it prints on the way are expected.

## gdUnit4 refuses `--headless`

It needs `--ignoreHeadlessMode`, which is correct for unit tests, since they inject no input. Tests
that drive the interface through `SceneRunner` need a real display, because Godot does not deliver
`InputEvent`s to a headless engine the way `Input` sends them. `project_test` handles the flag for
you.

## The engine forgets its own command line

`OS.get_cmdline_args()` returns only what the engine did not consume. An editor started
`--headless --path X --lsp-port N --script probe.gd` reports `["--script", "probe.gd"]` and nothing
else, so nothing running inside it can reconstruct how it was started.

That is why `editor_launch restart` refuses a headless editor: Godot's own restart and a
reconstructed command line were both tried, and both produced a project manager with no project,
running detached. A windowed editor restarts in about seven seconds.

## One path, two spellings

Windows hands out 8.3 short names (`RUNNER~1` inside a CI temp directory) and macOS puts `/var`
behind a symlink to `/private/var`. Both produce two spellings of one path, and a tool holding one
while the engine holds the other looks exactly like a tool that cannot find the file: diagnostics
that never arrive, a breakpoint the adapter never matches. Every path that crosses the boundary is
resolved before it is compared.

## A connection without `CONNECT_PERSIST` is not in the scene

`PackedScene.pack()` drops connections made without it, so a tool can report the connection it just
made over a scene that was saved without it. Everything `scene_signal` writes is persistent, and
the fixture asserts against the file rather than the answer, for exactly this reason.

## A resource-valued property needs a resource

`Object.set` takes a `Resource`, and a caller has a path. Nothing in the engine turns one into the
other, so setting a `TileMap`'s `tile_set` from a path is not something `set` can do until
something loads it first. `scene_node set` loads `res://` paths for object-typed properties, which
is what makes a TileMap with a TileSet reachable at all.

## `project.godot` is not a config file you edit

Writing it through `ConfigFile` drops every comment and the header on the way out. Everything here
goes through `ProjectSettings` inside the engine instead, so the file is saved the way the editor
saves it.

Input actions are the sharper version of the same trap: the value has to be a dictionary holding
real `InputEvent` objects, which the engine writes as the unquoted expression it parses back. Hand
it assembled text and it writes a quoted, escaped string, which loads as a `String` and leaves
`InputMap` with no action at all, while the tool that wrote it reports the events it was given.

## Autoloads reach an export

An `EditorPlugin` cannot be instantiated by an exported game, but an autoload can. If the runtime
addon is registered and its directory is excluded from the export, the export ships an autoload
pointing at nothing. `gdharness runtime off` before committing, and a test that fails the commit
while it is on, is the way to not ship that twice.

## The Windows console binary cannot be renamed

It finds the real executable by deriving its sibling's filename, and dies with "Invalid wrapper
executable name" if you rename it. Install the plain build under whatever name you like; it writes
to a redirected pipe perfectly well.
