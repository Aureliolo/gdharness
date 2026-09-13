# Traps

Godot behaviours that affect how you use this. The first five are yours to handle. The rest are
handled for you and listed so you can check.

## Yours

### The class list goes stale

Godot fixes its list of global classes when the editor starts, and refreshes it only on a
filesystem scan. Until then, scripts naming a `class_name` written since report "Could not find
type", and the editor writes that stale list into `.godot/global_script_class_cache.cfg`, so the
next game it launches cannot resolve them either.

Focusing the window does not reliably trigger the scan. `workspace/didChangeWatchedFiles` is
ignored. [godotengine/godot#42786](https://github.com/godotengine/godot/issues/42786).

**Call `project_import refresh_classes` after writing a `class_name`, before running the game.**
`project_test` does it first. `gdharness doctor` reports a stale cache.

### The runtime addon reaches an export

It is an autoload, and exports ship every registered autoload. Excluding the addon directory from
the export without removing the autoload entry ships a reference to nothing.

It refuses to serve outside a debug build, so it is not a server on a player's machine.
`gdharness runtime off` before committing.

### Headless has no window, and a 64 by 64 viewport

`runtime_capture` refuses in a headless game. Input works, but the GUI only delivers inside the
viewport, which is 64 by 64 regardless of project settings. A control at (400, 20) cannot be
clicked headless.

### There is no pause

Godot's debug adapter answers a pause request, sends a stopped event, and leaves the game running.
`debug_control` continues and steps but cannot pause. Stop the game with a breakpoint, then
`debug_state variables` reads what is in scope there.

### One editor

6005 and 6006 hold one client each. A second editor takes them from the first, which gives up
without retrying.

## Handled

| Godot                                                                                                   | What happens instead                                                               |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| A game started as its own process has no debug session, so breakpoints never hit and the stack is empty | `editor_run` asks the editor to play, so the game belongs to the editor's debugger |
| A script error drops the engine into a `debug>` prompt on stdin and the run never ends                  | The local debugger is never enabled, and the remote one points at port 0           |
| `godot ... \| tail` kills the engine with SIGPIPE and reports exit 139                                  | Output is captured whole and returned as entries with backtraces                   |
| gdUnit4 refuses `--headless`                                                                            | `project_test` passes `--ignoreHeadlessMode` and rebuilds the class list first     |
| `PackedScene.pack()` drops a connection made without `CONNECT_PERSIST`                                  | Connections are written persistent                                                 |
| `Object.set` takes a `Resource`, not a path                                                             | `scene_node set` loads `res://` paths for object-typed properties                  |
| A `ConfigFile` write to `project.godot` drops the header and comments                                   | Writes go through `ProjectSettings` in the engine                                  |
| Input actions written as text load as a `String` and leave `InputMap` empty                             | Actions are built as real `InputEvent` objects                                     |
| Windows 8.3 short names and the macOS `/var` symlink give one path two spellings                        | Paths are resolved before they are compared                                        |
| `OS.get_cmdline_args()` returns only what the engine did not consume                                    | `editor_launch restart` restarts a windowed editor and refuses a headless one      |
| The editor asks before reloading a file that changed on disk                                            | `auto_reload` reloads the open scene and its scripts without the dialog            |
| An addon replaced under a running editor keeps serving the old code                                     | `editor_status` reports the version the editor is holding and whether it is stale  |
