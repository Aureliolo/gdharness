# How it works

Two halves: what an install puts where, and what talks to what once it is running.

## What an install puts where

Everything belongs to one project. Twenty Godot projects means twenty installs, each with its own
copy of the addons, its own pinned version and its own engine path.

```text
your-project/
├── addons/gdharness_editor/      editor plugin: the bridge behind the scene and editor tools
├── addons/gdharness_runtime/     autoload: the running game answers through this
├── addons/auto_reload/           editor plugin: reloads what changed on disk
├── project.godot                 two plugin entries and one autoload, written by the engine
├── .mcp.json                     Claude Code, Copilot CLI, Qoder, Command Code
├── .cursor/mcp.json              Cursor, and one file per other harness set up here
├── .agents/skills/gdharness/     the skill, read by nine of the harnesses
└── .claude/skills/gdharness/     and a copy for each of the three that do not read .agents

~/                                touched only when you say so
└── .codex/config.toml            Codex, and the other harnesses with no project-level config
```

The entry written into each config is the same everywhere: `npx -y gdharness@{{version}}` with
`GODOT_PATH` set to the engine found when it was installed. The version is pinned rather than
`latest` because the server and the addons have to match; `editor_status` reports a mismatch as
`addonIsStale`.

## How setup decides what to write

```text
                       gdharness setup .
                              │
              ┌───────────────┴───────────────┐
      harnesses named                    none named
      by flag                                 │
              │                     ┌─────────┴─────────┐
      write exactly those,     a terminal            a pipe, CI,
      no questions             to ask                or an agent
              │                     │                     │
              │            ask about each one    write the ones this
              │            found here or on      project already uses,
              │            this machine          name the rest with the
              │                     │            flag that writes them
              └─────────────────────┴─────────────────────┘
                              │
                    write the skill, unless --no-skill
```

**Nothing outside the project is written without a flag or a typed yes.** A harness with no
project-level config at all is then written where it lives, because that is its limitation rather
than a choice we can make better for you, but never as a side effect of installing a project.

Detection asks two questions of each harness: whether this project is already configured for it,
and whether it is on this machine at all. The second reads the harness's own directory under home
and never writes there.

## Every harness

{{harnesses}}

Three kinds. Most are a JSON file we can write and re-read, so gdharness merges itself in and
leaves everything else in the file alone. A few keep their config in TOML or YAML, which we will
not rewrite because round-tripping it would cost somebody their comments, so those get the command
their own CLI documents or the block to paste. And eight have no project-level config at all.

Four harnesses read the same `.mcp.json`, so it is written once and all four are named.

## Where the skill goes

`.agents/skills/<name>/SKILL.md` is the cross-tool convention, and the reason there is one skill
rather than an integration per harness.

| | |
| --- | --- |
| Reads `.agents/skills` | Codex, which looks nowhere else, plus Cursor, VS Code, Copilot, Gemini CLI, opencode, Junie, Windsurf, Hermes |
| Needs its own copy | Claude Code `.claude/skills`, Kiro `.kiro/skills`, Cline `.cline/skills` |

A harness that does read the shared directory still gets its own copy when this project already
keeps skills there, because that is where its author will look.

## What talks to what

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

| Tools                                                                 | Route                                                               | Needs running                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------- |
| `scene_*`, `resource_edit`, `editor_rescan`, `editor_launch restart`  | Editor bridge                                                       | The editor, addon enabled                       |
| `script_diagnostics`, `script_info` except `structure`                | Language server                                                     | The editor                                      |
| `debug_*`, and the console `editor_output` returns                    | Debug adapter                                                       | A game the editor is playing                    |
| `runtime_*`                                                           | Runtime                                                             | A game with the runtime autoload                |
| `project_*`, `editor_classes`, `script_info structure`, `script_edit` | Headless operations                                                 | Nothing                                         |
| `editor_run`                                                          | Editor bridge when an editor is connected, otherwise a spawned game | Nothing, though the editor changes what it does |
| `editor_status`                                                       | All of them, reporting what answers                                 | Nothing                                         |

## Running the game

`editor_run` asks the editor to play, and connects the debug adapter first so the game's first
lines are not lost. The game then belongs to the editor's debugger: `debug_*` speaks to that
session and `editor_output` reads the console over it.

With no editor connected, the server spawns the game itself. It has no debug session, so `debug_*`
will not answer for it, and its console is read from the process pipe instead.

`editor_run check` always spawns: headless, a few frames, then quit, answering with the boot
verdict and every error and warning printed.

`editor_output` answers with entries rather than lines: each `ERROR:`, `SCRIPT ERROR:` and
`WARNING:` headline with its `at:` line and backtrace, the counts, and a `clean` verdict. It
filters by severity, by text, and to what has arrived since the last call. A screenshot cannot do
this job: a non-empty PNG says nothing about whether the game came up clean.

The engine's own stdin debugger is never enabled. It breaks into a prompt on the first script
error and never returns without a terminal.

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
