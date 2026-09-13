# Using it

## What has to be running

| Tools                                                                 | Needs                                    |
| --------------------------------------------------------------------- | ---------------------------------------- |
| `scene_*`, `resource_edit`, `editor_rescan`                           | The editor open, addon enabled           |
| `script_diagnostics`, `script_info` except `structure`                | The editor open                          |
| `debug_*`                                                             | A game the editor is playing             |
| `runtime_*`                                                           | A game running with the runtime autoload |
| `project_*`, `editor_classes`, `script_info structure`, `script_edit` | Nothing                                  |

## The CLI

```bash
gdharness setup /path/to/project             # addons in, editor ones enabled, class list rebuilt
gdharness setup /path/to/project --runtime   # and the runtime autoload registered
gdharness doctor /path/to/project            # exits 1 on a problem and names it
gdharness runtime on|off /path/to/project    # the autoload; reaches an export if left on
gdharness classes /path/to/project           # rebuild the class cache from disk
```

`setup` copies each addon whole and writes the version beside it, so `doctor` can tell an old copy
from the shipped one. An editor that was already open keeps serving the addon it loaded at startup
until it is restarted.

Writes to `project.godot` go through the engine, so the file keeps its comments and formatting.

## Running the game

`editor_run` asks the editor to play. The game then belongs to the editor's debugger, which is the
session `debug_*` speaks to and where `editor_output` reads the console from.

Set breakpoints first. They register on the adapter, not on a session, so they are waiting when the
game starts.

`editor_run check` boots headless for a few frames, waits for the quit, and answers with the
verdict: whether it came up, and every error and warning printed.

A run asked for headless is spawned as its own process, unless the project's
`editor/run/main_run_args` says the editor would play it headless anyway.

## Reading the output

`editor_output` returns entries, not lines: the engine's `ERROR:`, `SCRIPT ERROR:` and `WARNING:`
headlines with the `at:` line and backtrace under each, the counts, and a `clean` verdict. It
filters by severity, by text, and to what has arrived since the last call.

The engine's stdin debugger is never enabled. It breaks into a prompt on the first script error and
never returns without a terminal.

A screenshot does not check a boot. A non-empty PNG says nothing about whether the game came up
clean. `editor_run check` reads the log.

## Tests

`project_test` runs the gdUnit4 suites headless and answers with every case: which failed, at what
line, what the assertion said, and anything the engine printed. The class list is rebuilt first,
because the runner and the suites are `class_name`s the engine has to resolve.

## The class cache

`project_import refresh_classes` rewrites `.godot/global_script_class_cache.cfg` from the
declarations on disk and reports what was added, removed or changed. Call it after writing a
`class_name` and before running the game. See [Traps](traps.html).

## Two games at once

The runtime addon binds a port the OS assigns and announces it in a file named by its process id.
`projectPath` picks between games. `editor_status` lists what it can reach and why it cannot reach
the rest.

## One editor

6005 and 6006 hold one client each. A second editor takes them from the first, which gives up
without retrying. An agent should never start one, nor spawn an engine for anything a tool already
does.
