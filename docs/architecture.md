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
|-- .agents/skills/gdharness/  the skill, read by all but three harnesses
`-- .claude/skills/gdharness/  a copy for each of the three that do not

~/                             touched only when you say so
`-- .codex/config.toml         Codex, and the others with no project config
```

The entry written into each config is the same everywhere: `gdharness@{{version}}` through the
runner that installed it, with `GODOT_PATH` set to the engine found at the time. The version is
pinned rather than `latest` because the server and the addons have to match; `editor_status`
reports a mismatch as `addonIsStale`.

### What an upgrade reaches, and when

Upgrading writes new files to disk. Which of them are being run is a separate question, and the
three parts answer it differently:

| Part                       | Loaded                         | So a fix lands                   |
| -------------------------- | ------------------------------ | -------------------------------- |
| `addons/gdharness_runtime` | by the game, at every launch   | on the next `editor_run`         |
| `addons/gdharness_editor`  | by the editor, at startup      | after `editor_launch restart`    |
| the MCP server             | by the harness, when it spawns | only when the harness reconnects |

So a fix in the runtime addon is live immediately, even to a server several versions old: a
project upgraded mid-session had `runtime_inspect` walking a path its own server predated, because
the walk happens in the game. A fix in how an argument is parsed does not, because that happens in
the server, and a server cannot replace itself: nothing inside it can ask the harness for a
restart.

That matters when a fix is being verified. "Upgraded and the tier is green" says the files are
right, not that the thing answering is. `editor_status` is what settles it: `addonIsStale`
compares what the editor loaded against this server, and `projectIs` catches the other direction,
a project upgraded while the server kept running, which nothing else reports at all.

The runner is named by its path rather than as `npx` or `bunx`. A harness spawns what the config
names, through PATH, and a runner's name is not always on it: a Bun installed under a project
ships a `bun` and no `bunx` beside it, so an entry saying `bunx` starts nothing. Writing a path
costs nothing, because the entry carries an absolute `GODOT_PATH` already and so was never
portable between machines.

A Bun entry carries `--bun`. The published bundles start `#!/usr/bin/env node`, because npx is
Node and that line has to work, and a runner honours a shebang: without the flag a Bun entry
starts the server under whatever Node the machine has, which makes the runtime a property of the
machine rather than of the config.

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

{{mcp-json-count}} harnesses read the same `.mcp.json`, so it is written once and all of them are
named.

{{harnesses}}

## Where the skill goes

`.agents/skills/<name>/SKILL.md` is the cross-tool convention, and the reason there is one skill
rather than an integration per harness.

| Where it goes          | Which harnesses                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| Reads `.agents/skills` | {{shared-skill-count}} of the {{harness-count}}, Codex among them, which looks nowhere else |
| Needs its own copy     | Claude Code `.claude/skills`, Kiro `.kiro/skills`, Cline `.cline/skills`                    |

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

It asks to be reported even when it turns out to be wrong. A failure that was really the project's
or the environment's doing, arriving dressed as a defect, is a misclassification: the refusal that
should have named what would have worked is missing, and every later caller hits the same wall. So
that report is the more useful of the two, and the message and the form both say so.

Rarely, one answer in a few hundred also carries an invitation to say what is missing. A tool that
should exist and does not is invisible from inside the server, and the only party that knows is the
one that just worked around it. It asks for the same yes before anything is filed.

## The third kind of failure

Neither of the two above is the failure this surface is most prone to. Every tool here answers in
JSON, and JSON always looks certain. So the expensive failure is an answer that is well formed,
confident, and means something other than what a reader will take it to mean.

Five of those were reported by two projects in one day:

- five diagnostics about code the engine had just compiled and run green,
- `No game is running` about a bench that had printed forty minutes of output,
- four hidden labels read back as what the player can see,
- `warnings` naming neither what was warned nor where,
- a roster of twelve people rendered as the word `RefCounted` twelve times.

Nothing broke in any of them. Each was a confident answer, and each cost somebody hours, because
the only way to find out was to run the thing the tool was supposed to save them running.

So: a tool here should not be able to say something true in shape and false in meaning without a
field in the same answer that gives it away. `endedUnwatched` says a run ended with nobody
collecting its code, so a missing code cannot read as zero. `hidden` says a filter took matches
out, so none and four-all-hidden stop being the same answer. `omitted` says the cap dropped
entries. A list that cannot be stepped into says how long it is, rather than saying it has no
property by that name and sending somebody to look for one.

The sharpest statement of it came from one of the projects reporting these, about why it had
written a `Get-Process` loop rather than trust an answer: a false negative and a true negative were
spelled the same way, so the only reliable question was one asked of the operating system. Where
two states a caller must tell apart arrive as one answer, the caller's only way out is to stop
trusting the tool and go around it. That is the cost being avoided here, and it is higher than the
cost of a feature that does not exist yet.

## How a test here is checked

The same failure has a test-side spelling: an assertion that agrees with almost everything. Written
as "the answer is not the complaint I am thinking of", it is satisfied by a crash, a timeout, an
empty string and every refusal but one, so it stays green through the bug it was put there to hold.
Four of them sat in `test/regressions.ts`, each guarding a call that was supposed to be accepted.
An accepted call reaches something, and what it reaches is what gets asserted: the runtime that is
not running, the console buffer answering with itself, the engine run failing under the operation
that was asked for.

A fixture is checked by disarming the line it guards: break the code on purpose, say beforehand
which tests should notice, run them, and compare. A prediction that misses is worth more than a
green run, because it names a fixture that is not watching what its name says it watches.

For that to be readable the runner does not stop at the first failure. `bun test/regressions.ts`
runs every regression whether or not the one before it failed and lists the ones that failed at the
end, so a single disarm answers "which four noticed" rather than "one noticed, and the rest never
ran". Any arguments select tests by name, loosely matched, for running one on its own while it is
being written.

## What talks to what

```text
            stdio
  agent  <--------->  gdharness server
                            |
                            +- 6505  -->  gdharness_editor   websocket, in
                            +- 6005  -->  language server    tcp, out, per editor
                            +- 6006  -->  debug adapter      tcp, out, per editor
                            +- auto  -->  gdharness_runtime  tcp, port in a file
                            `- spawn -->  godot --headless   one engine per call
```

`gdharness_editor`, the language server and the debug adapter are all inside the Godot editor you
have open. `gdharness_runtime` is inside the running game. The spawned engine opens nothing and
exits when the call is answered.

## Connections

| Connection          | Transport                                 | Port               | Override                                      | Needs                                          |
| ------------------- | ----------------------------------------- | ------------------ | --------------------------------------------- | ---------------------------------------------- |
| Editor bridge       | WebSocket, editor connects to the server  | 6505, or any free  | `GDHARNESS_BRIDGE_PORT`                       | Editor open, addon enabled                     |
| Language server     | TCP, server connects to the editor        | 6005, or any free  | `GDHARNESS_LSP_PORT`, Godot's `--lsp-port`    | Editor open                                    |
| Debug adapter       | TCP, server connects to the editor        | 6006, or any free  | `GDHARNESS_DAP_PORT`, Godot's `--dap-port`    | Editor open                                    |
| Editor debugger     | TCP, the game connects to the editor      | assigned by the OS | none: Godot has no option for it              | A game the editor is playing                   |
| Runtime             | TCP loopback, server connects to the game | assigned by the OS | `GDHARNESS_RUNTIME_DIR` for the announce file | Game running, autoload registered, debug build |
| Headless operations | Process, one per call                     | none               | `GODOT_PATH` for the binary                   | Nothing                                        |

**Godot keeps those three per machine, not per editor.** All three live in editor settings, which
are one file for every editor on the machine, so two editors open at once want the same three
numbers and the second binds none of them. Every script and debug tool in the session behind it is
then answered by the first editor, about a different project, which is worse than not answering at
all.

So `editor_launch` opens an editor on the two Godot takes options for, `--lsp-port` and
`--dap-port`, keeping 6005 and 6006 whenever they are free and taking anything else when they are
not. It passes the same two in the environment, which is how the addon knows a server opened it.
`editor_status` reports where the connected editor says it serves, and the server follows that
rather than the default.

**Nothing is written into those settings, because they are shared.** The engine consumes the two
options and hands neither back, so an editor that restarts itself comes up without them. Writing
them into the settings made the restart work, and made a port chosen for one project the number in
the one file every editor of that version reads: the next editor opened by hand inherited it and
collided with the editor it had been moved away from. `editor_launch restart` starts such an editor
again instead, with the same arguments, since whatever wrote them can write them a second time. An
editor opened by hand is on the ports its own settings name and comes back on them by itself, so
that one still gets Godot's own restart.

The debugger is the third, and Godot takes no option for it, so the addon asks the operating system
for one before every play. `editor_run` answers with the port it got.

Two projects, two harness sessions, two servers and two editors therefore work at once. A server
`setup` wrote answers about its own project's game rather than whichever one it finds announced,
so `runtime_*` needs no `projectPath` on a machine running two. One server still serves one
editor: the bridge carries a single connection.

**The editor bridge is not at a number anybody agreed on.** A server set up by `setup` knows which
project it serves, so it takes 6505 when that is free and any free port when it is not, and writes
where it landed to `.godot/gdharness-bridge.json` inside that project. The editor addon reads that
file, and reads it again every few seconds, so it follows whichever server announced last.

Two things fall out of that, and both were real. Two projects open at once used to want the same
port, and the second editor never had a bridge at all. And a harness reconnect leaves the server it
replaced running, holding the port and still answering, with the editor no reason to look
elsewhere: it now moves to the replacement by itself rather than waiting for somebody to end a
process.

An announcement naming a process that has gone is ignored, and a server with no project to announce
in, which is any config written by hand, holds out for its configured port instead: it keeps asking
for it every two seconds and `editor_status` says it is waiting and why.

The editor keeps asking from its end too, so the order the two start in does not matter. A socket
pointed at a port nothing is listening on sits in its connect for thirty seconds before it gives
up, which outlasts a harness reconnect: an editor opened ahead of its server reaches the bridge
once the server is there, rather than waiting for somebody to restart it.

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

`project_import refresh_classes` is the one headless call that also asks the editor, when one is
connected and open on the same project. Rewriting the cache does not reach the list a running
editor already loaded, so a class it cannot resolve stays unresolvable and the rebuild still
answers `added: []`. Any such class comes back under `unseenByEditor`, and `classesUnchecked` says
so when the editor would not answer, because a check that goes quiet on failure reads exactly like
a clean project. `editor_rescan` reports the same two after its scan.

Neither of those reaches the language server, which keeps a cache of its own that nothing on the
editor side invalidates. Godot answers about a file the client has opened from the copy the client
handed it, and holds that parse, and that parse holds the parses of everything the file depends
on. Keeping documents open therefore froze every dependency at the text it had when some open file
first pulled it in: a `class_name` script edited outside the editor kept answering with the
members it used to have, a filesystem scan could not touch it, and asking again re-parsed only the
file asked about while the other open documents went on pinning the stale copy. So each ask gives
its document back as soon as the answer arrives. A file the client does not own is read from disk,
and the engine deliberately declines to keep that parse past the request, "since we can't
invalidate the cache properly"; holding documents open was opting into exactly the cache it is
refusing to keep.

## Running the game

`editor_run` asks the editor to play, and connects the debug adapter first so the game's first
lines are not lost. The game then belongs to the editor's debugger: `debug_*` speaks to that
session and `editor_output` reads the console over it.

With no editor connected, the server spawns the game itself. It has no debug session, so `debug_*`
will not answer for it, and its console is read from a file rather than over the adapter.

That run belongs to the operating system rather than to the server. It is spawned detached and
unreferenced, and both its streams are written to a transcript under the runtime directory, with a
note beside it naming the process and the file. A harness restarts its MCP server whenever it
likes, and an ordinary child dies with its parent: benches forty minutes into a sweep were killed
twice in one session by a reconnect nobody asked for, and `editor_output` afterwards answered "No
game is running" about output that had just been dropped. A file rather than a pipe for the same
reason and one more, since a pipe with no reader fills and then blocks the writer: surviving the
server down a pipe would only trade a killed run for a wedged one.

So a server that finds no run of its own reads that note. A process still there is reported as
running, with everything printed while nobody was reading; one that is gone is answered with its
output and `endedUnwatched`, because nothing collected an exit code for it and a guessed zero
reads as a run that finished its work. `editor_run stop` ends it by pid and takes the note away.

Two things guard that, because reading a note is also claiming the right to end what it names, and
the runtime directory is one per user rather than one per project.

**Whose run it is.** The note is only picked up by a server that can show the run is its own: the
project it was told to serve, or the project the editor on the bridge has open. A server that can
name neither answers that nothing of _its_ is running, and says what is there and why it has no
claim on it, rather than taking the run. "I cannot name a project" once read as "any note is
mine", which is how a regression suite, whose servers are started with no project and no editor,
adopted another project's bench and ended it to start its own: six times in fifty minutes, exit
code 1 with nothing printed, while its owner bisected their own scenes looking for the cause.

**Which process it is.** A pid is handed out again as soon as it is free, so before anything is
signalled the process has to answer as the run the note describes: the command line where the
platform gives it, the executable where it does not, and no when it will not say. Not knowing is
not the same as knowing, and the caller asking is the one that kills.

The first of those is the one that mattered. The pid in that story was correctly identified as the
run its note described, and the run was somebody else's.

The runs a caller waits on, `project_test` and `editor_run check`, stay ordinary children on
pipes. The answer is the point of them and it belongs to the call that asked, so outliving the
server would leave an engine nobody is reading and nobody will end.

`editor_run check` always spawns: headless, a few frames, then quit, answering with the boot
verdict and every error and warning printed.

`args` hands the game its own flags, the ones it reads back with `OS.get_cmdline_user_args()`,
behind the `--` the engine stops reading at. A run carrying any is spawned rather than played by
the editor, so `debug_*` will not answer for it.

That is the engine's line, not a preference. The editor builds the game's command line out of
`editor/run/main_run_args`, and it reads that when it opens the project: measured against 4.7.2,
a value the addon wrote into the live settings was not on the command line of the game played a
moment later, saving it to disk did not change that, and the same value put there before the
editor started arrived. So a run is the debugger or the arguments, and which one was wanted is
not the server's to guess.

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

A script run is not one of them. Autoloads come up for `godot -s` as well, so a test tier or a
batch tool would bind a port and announce itself under the project's own path, and a client asking
the runtime anything while sixteen of those run gets whichever answers first. The addon stays quiet
there unless `gdharness/runtime/serve_script_runs` is true, which is for driving a `-s` script on
purpose.

## Headless operations

One engine per call: `godot --headless --path <project> --script <operations.gd> <operation>
@file:<params.json>`. Arguments are camelCase in the tool call and snake_case in the file the
engine reads. The answer is the last JSON object printed on stdout. Anything on stderr comes back
under `engine_messages`.
