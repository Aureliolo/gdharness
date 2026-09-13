# How it works

```text
                stdio
  agent  ◄─────────────►  gdharness server
                                │
                                ├─ 6505   websocket, the editor connects in  ──►  gdharness_editor
                                ├─ 6005   tcp, the server connects out       ──►  language server
                                ├─ 6006   tcp, the server connects out       ──►  debug adapter
                                ├─ auto   tcp, port read from a file         ──►  gdharness_runtime
                                └─ spawn  one engine per call                ──►  godot --headless
```

`gdharness_editor`, the language server and the debug adapter are all inside the Godot editor you
have open. `gdharness_runtime` is inside the running game. The spawned engine opens nothing and
exits when the call is answered.

## Connections

| Connection          | Transport                                 | Port               | Override                                      | Needs                                          |
| ------------------- | ----------------------------------------- | ------------------ | --------------------------------------------- | ---------------------------------------------- |
| Editor bridge       | WebSocket, editor connects to the server  | 6505               | `GDHARNESS_BRIDGE_PORT`                       | Editor open, addon enabled                     |
| Language server     | TCP, server connects to the editor        | 6005               | `GDHARNESS_LSP_PORT`, Godot's `--lsp-port`    | Editor open                                    |
| Debug adapter       | TCP, server connects to the editor        | 6006               | `GDHARNESS_DAP_PORT`, Godot's `--dap-port`    | Editor open                                    |
| Runtime             | TCP loopback, server connects to the game | assigned by the OS | `GDHARNESS_RUNTIME_DIR` for the announce file | Game running, autoload registered, debug build |
| Headless operations | Process, one per call                     | none               | `GODOT_PATH` for the binary                   | Nothing                                        |

6005 and 6006 hold one client each. A second editor takes them from the first.

## Which tools use which

| Tools                                                                 | Route                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `scene_*`, `resource_edit`, `editor_rescan`, `editor_launch restart`  | Editor bridge                                                       |
| `script_diagnostics`, `script_info` except `structure`                | Language server                                                     |
| `debug_*`, and the console `editor_output` returns                    | Debug adapter                                                       |
| `runtime_*`                                                           | Runtime                                                             |
| `project_*`, `editor_classes`, `script_info structure`, `script_edit` | Headless operations                                                 |
| `editor_run`                                                          | Editor bridge when an editor is connected, otherwise a spawned game |
| `editor_status`                                                       | All of them, reporting what answers                                 |

## Running the game

`editor_run` asks the editor to play, and connects the debug adapter first so the game's first
lines are not lost. The game then belongs to the editor's debugger: `debug_*` speaks to that
session and `editor_output` reads the console over it.

With no editor connected, the server spawns the game itself. It has no debug session, so `debug_*`
will not answer for it, and its console is read from the process pipe instead.

`editor_run check` always spawns: headless, a few frames, then quit, answering with the boot
verdict and every error and warning printed.

## Finding a running game

The runtime addon binds loopback on a port the OS assigns and writes a file named by its process
id, holding the port and the project path. The server reads that directory:
`$GDHARNESS_RUNTIME_DIR`, else `$XDG_RUNTIME_DIR/gdharness`, else the temporary directory.

Two games can run at once. `projectPath` picks between them, and `editor_status` lists what it can
reach.

## Headless operations

One engine per call: `godot --headless --path <project> --script <operations.gd> <operation>
@file:<params.json>`. Arguments are camelCase in the tool call and snake_case in the file the
engine reads. The answer is the last JSON object printed on stdout. Anything on stderr comes back
under `engine_messages`.
