# Using it

How the pieces fit together once it is installed: which tools need what open, how a game gets run
and read, and what the server does about more than one of anything.

## What needs the editor, and what does not

- The `scene_*` and `resource_edit` tools and `editor_rescan` go through the editor addon, so they
  need the editor open on the project.
- `script_diagnostics`, `script_info` beyond `structure`, and the `debug_*` tools talk to the
  editor's language server and debug adapter.
- The `runtime_*` tools talk to a running game, whether `editor_run` started it or somebody pressed
  play in the editor.
- Everything else runs a short-lived headless engine and needs nothing open at all: the `project_*`
  tools, `editor_classes`, and `script_info structure`.

Those three connections are on 6505, 6005 and 6006, and `GDHARNESS_BRIDGE_PORT`,
`GDHARNESS_LSP_PORT` and `GDHARNESS_DAP_PORT` move them. Godot takes the last two on its own
command line as `--lsp-port` and `--dap-port`, so an editor that had to be moved off a default port
is still reachable. A variable holding something that is not a port is reported rather than
ignored.

## Setting a project up

```sh
gdharness setup /path/to/project             # addons in, editor ones enabled, class list rebuilt
gdharness setup /path/to/project --runtime   # and the runtime autoload registered
gdharness doctor /path/to/project            # what holds and what does not; exit 1 on a problem
gdharness runtime on|off /path/to/project    # the autoload, which reaches an export if left on
gdharness classes /path/to/project           # rebuild the class cache from disk
```

`setup` copies each addon whole, over whatever was there, and writes the version it came from
beside it, so an upgrade never leaves a file of the old version behind and `doctor` can tell an old
copy from the shipped one. An editor that was already open goes on serving the addon it read at
startup: `editor_status` reports the version that editor is actually holding, and
`editor_launch restart` is what puts the new one in front of it.

`doctor` also compares every `class_name` on disk with the class cache, which is the check the
editor cannot make for itself. Every write to `project.godot` goes through the engine, so the file
is written the way the editor writes it, comments and all.

## Running the game

**`editor_run` asks the editor to play when the editor is there.** A game started as its own
process is a game nothing is debugging: a breakpoint set on it is never hit and the stack is always
empty. One the editor plays belongs to the editor's debugger, which is the session the `debug_*`
tools speak to, and its console comes back over that same session, so `editor_output` answers the
same way either way.

Set breakpoints first and then run. They are registered on the adapter rather than on a session, so
they are waiting when the game starts.

A run asked for headless is still spawned as its own process, unless the project's own
`editor/run/main_run_args` says the editor would play it headless too. `editor_run check` always
is: it boots the project headless for a few frames, waits for it to quit, and answers whether it
came up clean, which is the boot gate a commit hook otherwise does by hand with a grep.

## Reading what it printed

What a game prints comes back as entries rather than lines. `editor_output` reads the engine's
`ERROR:`, `SCRIPT ERROR:` and `WARNING:` headlines with the `at:` line and the backtrace under
each, answers with the counts and a `clean` verdict, and filters by severity, by text, or to what
has arrived since the last call.

The engine's own stdin debugger is never turned on. It breaks into a prompt on the first script
error and, with no terminal to read from, never comes back.

## The test tier

`project_test` runs the project's gdUnit4 suites headless and answers with every case rather than a
console to read: which failed, at what line, and what the assertion said, along with anything the
engine printed on the way. The class list is rebuilt before the run, because the runner is itself a
set of `class_name`s the engine has to resolve, and so is any suite written since the editor last
scanned.

## The class cache

`project_import refresh_classes` rewrites `.godot/global_script_class_cache.cfg` from the
`class_name` declarations on disk, and the answer says which classes were added, removed or
changed. [Traps](traps.html#the-editors-class-list-goes-stale-silently) is the longer version of
why that exists, and it is the single most common way a session goes sideways.

## More than one game

A game finds its own port: the runtime addon listens on whatever the operating system hands out and
announces the port in a file named by its process id, under `$GDHARNESS_RUNTIME_DIR`, else
`$XDG_RUNTIME_DIR/gdharness`, else the temporary directory. The server reads that, so two games can
run at once, `projectPath` picks between them, and a headless operation never takes the port a game
wanted.

`editor_status` lists every game it can reach, and why it cannot reach the rest.

## More than one editor

Do not. The language server and the debug adapter are single-holder ports: a second editor takes
them from the first, which then gives up without retrying, and answers start coming from a process
nobody can see. `editor_status` reports the port conflict when it happens, but the cheaper rule is
one editor.
