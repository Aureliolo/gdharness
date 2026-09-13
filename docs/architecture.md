# How it works

Two halves: what an install puts where, and what talks to what once it is running.

## What an install puts where

Everything belongs to one project. Twenty Godot projects means twenty installs, each with its own
copy of the addons, its own pinned version and its own engine path.

```text
your-project/
|-- addons/gdharness_editor/   the bridge: scenes, resources, running the game
|-- addons/gdharness_runtime/  an autoload: the running game answers here
|-- addons/auto_reload/        reloads what changed on disk
|-- project.godot              two plugin entries and one autoload
|-- .mcp.json                  Claude Code, Copilot CLI, Qoder, Command Code
|-- .cursor/mcp.json           Cursor, and one file per other harness
|-- .agents/skills/gdharness/  the skill, read by nine of the harnesses
`-- .claude/skills/gdharness/  a copy for each of the three that do not read it

~/                             touched only when you say so
`-- .codex/config.toml         Codex, and the others with no project config
```

The entry written into each config is the same everywhere: `npx -y gdharness@{{version}}` with
`GODOT_PATH` set to the engine found when it was installed. The version is pinned rather than
`latest` because the server and the addons have to match; `editor_status` reports a mismatch as
`addonIsStale`.

## How setup decides what to write

{{flow}}

`setup` takes the directory to install into, and defaults to the one you are in. The third way out
is a pipe, a CI job or an agent, where there is nobody to answer a question: it writes what the
project has already committed to rather than hanging on an answer that is never coming.

**Nothing outside the project is written without a flag or a typed yes.** A harness with no
project-level config at all is then written where it lives, because that is its limitation rather
than a choice we can make better for you, but never as a side effect of installing a project.

Detection asks two questions of each harness: whether this project is already configured for it,
and whether it is on this machine at all. The second reads the harness's own directory under home
and never writes there.

## Every harness

All but two are written for you, whatever the format, because a block to paste is a step that gets
skipped or pasted into the wrong file.

| Format | How it is written                          | What survives                                          |
| ------ | ------------------------------------------ | ------------------------------------------------------ |
| JSON   | Merged                                     | Every other server and key in the file                 |
| TOML   | Our table appended, or replaced in place   | Every other byte: TOML tables are position-independent |
| YAML   | Through a parser that round-trips comments | Their servers and the comments about them              |

The two exceptions are nanobot and Autohand. Their config file is documented; the key they hold
servers under is not, and an invented key writes a file that parses, loads and does nothing. Those
print the block instead.

Four harnesses read the same `.mcp.json`, so it is written once and all four are named.

{{harnesses}}

## Where the skill goes

`.agents/skills/<name>/SKILL.md` is the cross-tool convention, and the reason there is one skill
rather than an integration per harness.

| Where it goes          | Which harnesses                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| Reads `.agents/skills` | Codex, which looks nowhere else, plus Cursor, VS Code, Copilot, Gemini CLI, opencode, Junie, Windsurf, Hermes |
| Needs its own copy     | Claude Code `.claude/skills`, Kiro `.kiro/skills`, Cline `.cline/skills`                                      |

A harness that does read the shared directory still gets its own copy when this project already
keeps skills there, because that is where its author will look.

## What gdharness is made of

One npm package. It is the MCP server by default, and the CLI when given a command.

```text
gdharness
|-- cli.ts                setup, upgrade, uninstall, doctor, runtime, classes
|   |-- harnesses.ts      every harness: its file, its shape, its skills dir
|   |-- config-formats.ts TOML by table, YAML through a comment-keeping parser
|   |-- skill.ts          the skill, and which directories get a copy
|   |-- setup.ts          the addons, the editor plugins, the autoload
|   `-- prompt.ts         the questions, and the silence when nobody can answer
|
`-- server.ts             the MCP server: one call in, one answer out
    |-- tool-definitions  every tool, op and argument, in one table
    |-- tool-args.ts      the refusals, which name the valid set
    |
    |-- godot-bridge.ts   websocket, 6505, the editor addon connects in
    |-- lsp_client.ts     tcp, 6005, diagnostics and symbols
    |-- dap_client.ts     tcp, 6006, breakpoints, stepping, the console
    |-- runtime-client.ts tcp, the running game, on a port it announces
    `-- headless.ts       one short engine per call, nothing open needed

addons, installed into your project
|-- gdharness_editor      the bridge: scenes, resources, running the game
|-- gdharness_runtime     an autoload: the running game answers through it
`-- auto_reload           reloads the open scene when a file changes
```

The CLI half never loads the MCP SDK, and the server half never reads the harness table. They share
the engine locator and the project parsers and nothing else, which is why `setup` starts in well
under a second on a machine that has never run the server.

Every tool is declared in one table and dispatched from it, so a tool the server answers is a tool
the documentation lists and a fixture drives. The reference on this site is rendered from that same
table.

## When a call fails

Two kinds of failure, and the answer says which one it is.

A **refusal** is a failure the tool anticipated: an argument outside the valid set, a node that is
not in the scene, an editor that is not connected. It names what would have worked instead, and it
is the ordinary way a tool says no. Most of them are written by `tool-args.ts`.

A **defect** is everything left over: a throw nobody modelled, caught at the tool boundary in
`server.ts` or by the catch at the bottom of `cli.ts`. That answer says up front that repeating the
call will not help, since an exception message handed to an agent otherwise reads as something it
did wrong. It carries the version, the runtime, the platform and a short signature that comes out
the same for one bug on two machines, and it asks whoever is reading to tell the person whose
machine this is and ask whether they may report it on their behalf.

Nothing is sent from here, and no issue is opened without somebody seeing what it would contain:
the report is about their project, and a public tracker is their decision. The link it offers is
the issue form with those lines already filled in.

Rarely, one answer in a few hundred also carries an invitation to say what is missing. A tool that
should exist and does not is invisible from inside the server, and the only party that knows is the
one that just worked around it. It asks for the same yes before anything is filed.

## What talks to what

```text
            stdio
  agent  <--------->  gdharness server
                            |
                            +- 6505  -->  gdharness_editor   websocket, in
                            +- 6005  -->  language server    tcp, out
                            +- 6006  -->  debug adapter      tcp, out
                            +- auto  -->  gdharness_runtime  tcp, port in a file
                            `- spawn -->  godot --headless   one engine per call
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
