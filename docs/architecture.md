# How it works

What an install puts where, and what talks to what once it runs.

## What an install puts where

```text
your-project/
|-- addons/gdharness_editor/   the bridge: scenes, resources, running the game
|-- addons/gdharness_runtime/  an autoload: the running game answers here
|-- addons/auto_reload/        reloads what changed on disk
|-- addons/gdharness_tests/    GdhShare, GdhBench and the suites scene
|-- gdharness/loader.gd        brings the runtime up in a debug build
|-- project.godot              two plugin entries and one autoload
|-- .mcp.json                  Claude Code, Copilot CLI, Qoder, Command Code
|-- .cursor/mcp.json           Cursor, and one file per other harness
|-- .agents/skills/gdharness/  the skill, read by all but three harnesses
`-- .claude/skills/gdharness/  a copy for each of the three that do not

~/                             touched only when you say so
`-- .codex/config.toml         Codex, and the others with no project config
```

Every config gets the same entry. It runs `gdharness@{{version}}` through the runner that installed
it, with `GODOT_PATH` set to the engine found at setup. The version is pinned rather than `latest`
because the server and the addons have to match. `editor_status` reports a mismatch as
`addonIsStale`.

### The runner in the entry

The entry names its runner by path, not as `npx` or `bunx`. A harness spawns what the config names
through PATH, and a runner's name is not always on PATH. A Bun installed under a project ships `bun`
without `bunx`, so an entry saying `bunx` starts nothing.

A Bun entry carries `--bun`. The published bundles start with `#!/usr/bin/env node`, because npx is
Node. A runner honours that line. Without the flag, a Bun entry runs the server under whatever Node
the machine has.

### What an upgrade reaches, and when

An upgrade writes new files to disk. Each part loads them at its own moment.

| Part                       | Loaded                         | So a fix lands                   |
| -------------------------- | ------------------------------ | -------------------------------- |
| `addons/gdharness_runtime` | by the game, at every launch   | on the next `editor_run`         |
| `addons/gdharness_editor`  | by the editor, at startup      | after `editor_launch restart`    |
| the MCP server             | by the harness, when it spawns | only when the harness reconnects |

So the halves of one project can run different releases. An upgrade writes the addons under a
running editor and game. A server cannot replace itself, because nothing inside it can ask the
harness for a restart. The server and the addons of one release work only with each other, so a
half running other code is refused.

### A stale editor addon

The install writes a digest of each addon's code as `.gdharness-digest`, beside its
`.gdharness-version`. The editor addon is stale when the digest of the code it loaded differs from
the code this server ships. An upgrade that leaves that code alone does not make the editor stale.
An editor whose greeting lacks a field this release sends is also another release's.

The bridge sends such an editor only the quit that `editor_launch close` and `editor_launch restart`
need. Every other editor-routed call is refused with the remedy:

- `editor_launch restart` when the project holds this server's addons.
- `gdharness upgrade` first when it does not.
- A reconnect when the editor is the newer half.

### Which release is running

`editor_status` answers throughout, with `addonIsStale` and `staleNote`. Its `projectIs` catches a
project upgraded while the server kept running. Read the running version from `serverVersion`, not
from the pin. The pin names the next server. The process answering is whatever the harness spawned
at its last reconnect.

### A stale runtime addon

A game reports the runtime addon it loaded, from the same two markers in `addons/gdharness_runtime`.
`editor_status` judges each entry under `runtimes` the same way, with `addonVersion`, `addonIsStale`
and `staleNote`. A `runtime_*` call to a stale game is refused with the note and not sent.

The check uses the digest, not the protocol number. A second checkout of a project, such as a git
worktree, has its own `addons/`. It can run an older runtime with an unchanged protocol number. The
note names the fix from what the game's own project holds:

- `gdharness upgrade` there when its addon is not this server's either.
- A restart of the game when it is.
- A reconnect when the game is the newer half.

A runtime of another protocol is not listed as reachable. The protocol changes whenever the wire
does. Such a game is named as unreadable, with the half that is behind.

## How setup decides what to write

{{flow}}

`setup` installs into the directory it is given, or the one you are in. The third way out is for a
pipe, a CI job or an agent, where nobody can answer a question. There it writes what the project has
already committed to and asks nothing.

What `setup` writes outside the project, and when, is in
[the install guide](install.md#what-it-writes-and-where).

Detection asks two questions of each harness. Is this project already configured for it? Is the
harness on this machine at all? The second reads the harness's own directory under home and never
writes there.

## Every harness

All but two are written for you, whatever the format.

| Format | How it is written                          | What survives                                          |
| ------ | ------------------------------------------ | ------------------------------------------------------ |
| JSON   | Merged                                     | Every other server and key in the file                 |
| TOML   | Our table appended, or replaced in place   | Every other byte: TOML tables are position-independent |
| YAML   | Through a parser that round-trips comments | Their servers and the comments about them              |

The two exceptions are nanobot and Autohand. Their config file is documented. The key they hold
servers under is not. An invented key writes a file that parses, loads and does nothing. Those two
print the block instead.

{{mcp-json-count}} harnesses read the same `.mcp.json`. Setup writes it once and names all of them.

{{harnesses}}

## Where the skill goes

`.agents/skills/<name>/SKILL.md` is the cross-tool convention. It is why there is one skill rather
than an integration per harness.

| Where it goes          | Which harnesses                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| Reads `.agents/skills` | {{shared-skill-count}} of the {{harness-count}}, Codex among them, which looks nowhere else |
| Needs its own copy     | Claude Code `.claude/skills`, Kiro `.kiro/skills`, Cline `.cline/skills`                    |

A harness that reads the shared directory still gets its own copy when this project already keeps
skills there. That is where its author will look.

## What gdharness is made of

One npm package. It is the MCP server by default, and the CLI when given a command.

```text
gdharness
|-- cli.ts                setup, upgrade, uninstall, doctor, runtime, classes, test
|   |-- harnesses.ts      every harness: its file, its shape, its skills dir
|   |-- config-formats.ts TOML by table, YAML through a comment-keeping parser
|   |-- skill.ts          the skill, and which directories get a copy
|   |-- setup.ts          the addons, the editor plugins, the autoload
|   |-- prompt.ts         the questions, and the silence when nobody can answer
|   `-- suite-run.ts      test: a game's suites over engines, judged line by line
|       |-- suite-plan.ts        which suites, their cost, which engine runs what
|       |-- suite-judge.ts       an engine's output read case by case
|       |-- suite-inputs.ts      what a suite's engine loaded, for --changed-only
|       `-- engine-slots.ts      the slots every tool starting an engine shares
|
`-- server.ts             the MCP server: one call in, one answer out
    |-- tool-definitions  every tool, op and argument, in one table
    |-- tool-args.ts      reading arguments of each type
    |
    |-- godot-bridge.ts   websocket, 6505, the editor addon connects in
    |-- lsp_client.ts     tcp, 6005, diagnostics and symbols
    |-- dap_client.ts     tcp, 6006, breakpoints, stepping, the console
    |-- runtime-client.ts tcp, the running game, on a port it announces
    `-- headless.ts       one short engine per call, nothing open needed

addons, installed into your project
|-- gdharness_editor      the bridge: scenes, resources, running the game
|-- gdharness_runtime     an autoload: the running game answers through it
|-- auto_reload           reloads the open scene when a file changes
`-- gdharness_tests       waits, tween steps and input events, GdhShare, GdhBench,
                          and the scene that profiles suites
```

The CLI half never loads the MCP SDK. The server half never reads the harness table. They share only
the engine locator and the project parsers. So `setup` starts in well under a second on a machine
that has never run the server.

Every tool is declared in one table and dispatched from it. So every tool the server answers is one
the documentation lists and a fixture drives. The reference on this site is rendered from the same
table.

### Test runs

A CI job runs a project's gdUnit4 suites with `gdharness test`. [Test runs](test-runs.md) describes
it and the engine slots it shares with other tools. Each of its engines starts the shipped runner,
`godot/tests/listed.gd`, from outside the project. `project_test` starts the same runner.

Both judge the engine's output with `suite-judge.ts`, from one file holding both streams in order.
They look in the same directories and judge engine errors against the same declarations. So a suite
`project_test` passes is one `gdharness test` passes.

`editor_run start` given `suites` plays the tests addon's `suites.tscn` instead, so the profiler sees
the suites. The scene loads the same runner from where the server ships it and calls its `started`
(`suites-scene.ts`). It loads it at run time because the addon must compile in a project without
gdUnit4.

### Spread benches

`gdharness spread` plays a bench scene over several engines, each holding one of the same slots.
[Spread benches](spread.md) describes it. Both commands start and watch their engines through
`engine-launch.ts`.

The bench asks the tests addon's GdhShare for its outcomes. In a worker, GdhShare plays every Nth run
and writes the outcomes with `store_var`. In the one engine started after the workers, it reads them
back. So the bench folds the same values in the same order as it does alone.

### The LSP bridge

`gdharness lsp` connects a harness that speaks LSP over stdio to the GDScript language server of the
project's open editor. It passes the bytes through unparsed (`lsp-bridge.ts`).

It never starts an editor. A new editor would take the port from the open one, which does not try
again. Every answer would then come from a process nobody can see.

### Which editor the bridge reaches

The editor addon writes the ports each editor process serves to
`.godot/gdharness-editors/<pid>.json`. It removes the file as the editor closes.

The bridge tries `--port` or `GDHARNESS_LSP_PORT` when given. Otherwise it tries each live editor's
port, newest first, then Godot's 6005. A port can belong to another project's editor, so the bridge
checks that it serves this project before passing anything through.

A record counts only while the process under its pid started before the record was written. Records
whose process has gone are deleted. A gate's `--import` loads the addon too and writes a record. Its
command line marks it as a one-off job, so it is passed over.

## When a call fails

A failed call is a refusal or a defect, and the answer says which.

A **refusal** is a failure the tool anticipated. Examples are an argument outside the valid set, a
node not in the scene, or an editor that is not connected. It names what would have worked instead.
Most refusals are written in `server.ts`.

A **defect** is any other throw, caught at the tool boundary in `server.ts` or at the bottom of
`cli.ts`. Its answer says first that this is a gdharness defect. Without that, an agent reads an
exception message as something it did wrong. The answer carries the version, the runtime, the
platform and a short signature that is the same for one bug on two machines.

### Retrying a defect

The first time, the answer asks for one retry. When the same signature comes back, it says a retry
will not help. It asks the reader to ask the machine's owner before reporting it for them.

### Reporting a defect

Nothing is sent automatically. The agent asks the machine's owner first, because the report names
their project's files. The link opens the issue form with the report filled in.

A defect asks to be reported even when the fault was really the project's or the environment's.
Then a refusal that should have named the fix is missing, and every later caller meets the same
failure. The message and the form both ask for such a report.

Every 250th answer also asks the caller which tool was missing. Only a caller that
just worked around a missing tool knows of it. It asks for the same yes before anything is filed.

## The third kind of failure

The costliest failure is a well-formed, confident answer that means something other than what the
reader takes it to mean. Examples:

- diagnostics about code that had just compiled and run,
- `No game is running` about a bench still printing,
- hidden labels read back as visible.

### Every answer shows its own ambiguity

No tool here may say something true in shape and false in meaning without a field in the same
answer that shows it.

- `endedUnwatched` says nobody collected a run's exit code, so a missing code cannot read as zero.
- `hidden` says a filter took matches out, so none and four-all-hidden are different answers.
- `omitted` says the cap dropped entries.
- A list that cannot be stepped into says how long it is. It does not claim to lack the property.

When two states a caller must tell apart arrive as one answer, the caller stops trusting the tool.
That cost is higher than the cost of a missing feature.

### A fix leaves sentences behind

A fix is finished when the answers are still unambiguous afterwards, not when the code is right. A
fix makes new states and hands them to sentences that were already there. A server that learned to
claim only its own runs made "No game is running" ambiguous. It meant _nothing is running_ or
_something I have no claim on is running_. Read the sentences a change leaves behind.

## How a test here is checked

An assertion that an answer is not one particular complaint agrees with almost everything. A crash,
a timeout, an empty string and every other refusal satisfy it. So it stays green through the bug it
was meant to hold. A test of a call that should be accepted asserts what the call reaches instead.
That is the runtime that is not running, the console buffer answering with itself, or the engine run
failing under the operation asked for.

### Disarming a fixture

A fixture is checked by disarming the line it guards. Break the code on purpose and say beforehand
which tests should notice. Then run them and compare. A prediction that misses names a fixture
that is not watching what its name says.

`bun test/regressions.ts` runs every regression even after a failure and lists the failures at the
end. So one disarm shows every test that noticed. Arguments select tests by name, loosely matched, to
run one on its own while writing it.

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

`gdharness_editor`, the language server and the debug adapter all live inside the Godot editor you
have open. `gdharness_runtime` lives inside the running game. The spawned engine opens nothing and
exits when the call is answered.

The agent's side is MCP over stdio in the 2026-07-28 revision. It opens with `server/discover` and
carries an envelope on every request. A client opening with the 2025 `initialize` gets the
unsupported-protocol-version error naming 2026-07-28.

### What the server offers beside the tools

- The `godot://` resources, with their paths completed from the project.
- Three prompts, written as the tool calls they make.
- A few lines of instructions a client puts in front of its agent.

Each tool tells a client whether it reads, adds or can destroy, worked out from its ops. A client
decides from that whether to ask before a call.

Results carry no `structuredContent`. When a result has that field, Claude Code hands the model that
field alone. Every answer here that leads with prose or carries a notice would lose them.

### Progress on long calls

A call whose request carries a progress token gets a progress notification at least every twenty
seconds until it answers. That holds for every tool. Claude Code ends a call that has said nothing
for thirty minutes. A test run and a folder of diagnostics say how far they have got. Any other call
says it is still going and how long it has taken.

## The servers' own log

A client can end a server mid-call and start another without saying why. So every server appends
JSON lines to `servers.log` in the runtime directory, one file for all of the user's servers.
`editor_status` names the file under `server.lifecycleLog`. Each line carries the time, the server's
pid, its parent's pid and its version. The events are these.

- `started`: the command line, working directory, project, and the `.mcp.json` beside it, if any.
- `replaced`: a server started while a live server of its project held the announcement. It names
  that `predecessor`.
- `parent`: the parent's command line, which names the client. It is read five seconds in, so a
  server that lives a moment (a test suite starts hundreds) costs no process listing.
- `client`: the name and version the client gave, written again whenever they change.
- `ended`: the `cause`, and the calls in flight with how long each had run.

### Why a server ended

| `cause`                                   | Meaning                                       |
| ----------------------------------------- | --------------------------------------------- |
| `stdin:end`                               | The client closed its end                     |
| A signal's name                           | That signal ended it                          |
| `superseded`                              | A successor took over, its pid in `successor` |
| `uncaughtException`, `unhandledRejection` | A throw, with the stack                       |
| `exit:` and the code                      | The process exited with that code             |

A server killed without warning writes no `ended` line. On Windows every kill is that, since
`TerminateProcess` runs no handler. So a `started` line with no `ended` line after it means
something killed that server. Past a megabyte the file moves aside to `servers.log.1`. That replaces
any older `servers.log.1`.

## Connections

| Connection          | Transport                                     | Port               | Override                                      | Needs                                          |
| ------------------- | --------------------------------------------- | ------------------ | --------------------------------------------- | ---------------------------------------------- |
| Editor bridge       | WebSocket, editor connects to the server      | 6505, or any free  | `GDHARNESS_BRIDGE_PORT`                       | Editor open, addon enabled                     |
| Language server     | TCP, server connects to the editor            | 6005, or any free  | `GDHARNESS_LSP_PORT`, Godot's `--lsp-port`    | Editor open                                    |
| Debug adapter       | TCP, server connects to the editor            | 6006, or any free  | `GDHARNESS_DAP_PORT`, Godot's `--dap-port`    | Editor open                                    |
| Editor debugger     | TCP, the game connects to the editor          | assigned by the OS | none: Godot has no option for it              | A game the editor is playing                   |
| Keeper debugger     | TCP loopback, the game connects to its keeper | assigned by the OS | none                                          | A game this server started                     |
| Runtime             | TCP loopback, server connects to the game     | assigned by the OS | `GDHARNESS_RUNTIME_DIR` for the announce file | Game running, autoload registered, debug build |
| Headless operations | Process, one per call                         | none               | `GODOT_PATH` for the binary                   | Nothing                                        |

### Godot's three editor ports are per machine

Godot keeps the language server, debug adapter and debugger ports in its editor settings. Those are
one file for every editor on the machine. So two editors open at once want the same three numbers.
The second binds none of them. Every script and debug tool in its session is then answered by the
first editor, about a different project.

### Ports for an editor gdharness opens

`editor_launch` opens an editor with the two options Godot takes, `--lsp-port` and `--dap-port`.
It keeps 6005 and 6006 when they are free and takes any free port when they are not. It passes the
same two in the environment, which tells the addon a server opened it. `editor_status` reports where
the connected editor says it serves. The server follows that rather than the default.

Godot takes no option for the debugger. So the addon asks the operating system for a port before
every play. `editor_run` answers with the port it got.

### Which project a language server serves

The language server says which project it serves, so a port's holder is checked rather than assumed.
Godot answers an `initialize` whose root is not its own project by telling the client to change to
its project, ahead of the answer. The script tools then refuse and name both projects.

### No port is written into the settings

The editor settings are shared, so gdharness writes no port into them. The engine consumes the two
options and hands neither back. So an editor that restarts itself comes up without them. A port
written into the settings would become the number every editor of that version reads. The next
editor opened by hand would collide with the one it was moved away from.

So `editor_launch restart` starts such an editor again with the same arguments. An editor opened by
hand uses the ports its own settings name and comes back on them by itself. That one still gets
Godot's own restart.

### The one setting the addon writes

Godot's debug adapter clears every breakpoint in the script editor when a session sends
`initialize`. That covers open and closed scripts alike, unless
`network/debug_adapter/sync_breakpoints` is on. It is off by default. A server opens a session for
its first breakpoint or stack read. So without the setting, its first debug call takes the user's
breakpoints away.

The addon turns the setting on as it loads. The adapter picks it up without a restart. The addon
reports it in its greeting. `editor_status` and `debug_breakpoint` say `breakpointsAtRisk` about an
editor whose addon did not turn it on.

With it on, an opening session is told the editor's breakpoints instead. `debug_breakpoint` sends a
file's whole list as the union of what it holds and what the editor has. So setting a line never
clears the ones set by hand.

### Two projects at once

Two projects, two harness sessions, two servers and two editors therefore work at once. A server
`setup` wrote answers about its own project's game, not whichever game it finds announced. So
`runtime_*` needs no `projectPath` on a machine running two. One server still serves one editor,
because the bridge carries a single connection.

### Two servers on one project

Two servers on one project is harder, because their games announce the same project. A game the
editor plays says which editor. The editor addon puts its process id into its own environment as it
loads. Every game it plays inherits that. The runtime announces it as `editor_pid`.

A game some other server started announces none. So a start waiting for its game's runtime passes
over a stranger's announcement, however fresh. `editor_status` lists `editorPid` under each runtime
so a caller can tell them apart too.

### The bridge port

The editor bridge has no fixed number. A server set up by `setup` knows which project it serves. It
takes 6505 when that is free and any free port when it is not. It writes where it landed to
`.godot/gdharness-bridge.json` inside that project. The editor addon reads that file every few
seconds, so it follows whichever server announced last.

An announcement naming a process that has gone is ignored. A server with no project to announce in
holds out for its configured port instead. That is any server whose config was written by hand. It
asks for the port every two seconds. `editor_status` says it is waiting and why.

### Reconnects and start order

Two projects open at once each get a bridge. After a harness reconnect, the replaced server keeps
running. It holds the port and still answers. The editor moves to the replacement by itself.

The editor keeps asking from its end too, so the order the two start in does not matter. A socket
pointed at a port nothing listens on waits thirty seconds in its connect before it gives up. That
outlasts a harness reconnect. So an editor opened ahead of its server reaches the bridge once the
server is there.

### The editor's console log

An editor gdharness opens writes its console to `.godot/gdharness-editor.log`. What an editor prints
goes to a console no plugin can reach. An editor in self-contained mode writes no log of its own
either. Without this file, hundreds of parse errors at startup go unseen by every tool.

`editor_launch` asks the engine for the log file as it starts. `editor_output op: "editor"` reads it.
The engine replaces that file when it opens it. So one file holds one editor session from its first
line.

### Which editor a log belongs to

Beside it, `.godot/gdharness-editor.json` records which editor the log belongs to. A log from
yesterday's editor is still on disk today. Once no editor is connected, the log is read as the named
editor's, with whether it still runs. So an editor that closed or crashed can still be asked what it
printed last. An editor somebody opened by hand has no log and is refused saying so.

## Which tools use which

| Tools                                                                                                                | Route                                                                                                                                  | Needs running                                   |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `editor_rescan`, `editor_launch restart`, `close`                                                                    | Editor bridge                                                                                                                          | The editor, addon enabled                       |
| `scene_tree`, `scene_animation read` and `read_states`, `resource_edit read`                                         | Editor bridge when an editor serves the project, otherwise headless operations                                                         | Nothing                                         |
| `scene_create`, `scene_node`, `scene_signal`, `scene_animation` but its reads, `resource_edit` but `read` and `move` | Editor bridge when an editor serves the project, otherwise the editor addon's own tool in headless operations                          | Nothing                                         |
| `script_diagnostics`                                                                                                 | Language server when this project's editor is open, otherwise headless operations, which report errors without columns and no warnings | Nothing                                         |
| `script_info` except `structure`, `script_edit rename` of a member                                                   | Language server                                                                                                                        | The editor                                      |
| `debug_*`, and the console `editor_output` returns                                                                   | Debug adapter                                                                                                                          | A game the editor is playing                    |
| `runtime_*`                                                                                                          | Runtime                                                                                                                                | A game with the runtime autoload                |
| `project_*`, `editor_classes`, `script_info structure`, `script_edit` otherwise, `resource_edit move`                | Headless operations                                                                                                                    | Nothing                                         |
| `editor_run`                                                                                                         | Editor bridge when an editor is connected, otherwise a spawned game                                                                    | Nothing, though the editor changes what it does |
| `editor_status`                                                                                                      | All of them, to report what answers                                                                                                    | Nothing                                         |

## Renames and moves

### Renaming a class

`script_edit rename` reads the project's files itself, through its own GDScript tokenizer in
`src/gdscript-source.ts`. For every occurrence of a name, the tokenizer tells code from a string, a
comment, a `##` doc comment or a node path.

A class is renamed from that alone. A bare identifier in code can name only a global class. The
exceptions are a script that declares something of its own by that name and a word that follows a
dot. Both are left for a person.

### Renaming a member

A member needs the analyser, since which `say` is meant in `thing.say()` depends on the type of
`thing`. So its uses come from the editor's language server. The server first takes the references
of the topmost declaration. Then it asks `textDocument/definition` at every other occurrence in
code.

The second pass is needed because Godot 4.7 answers for the overridden method when asked at an
override's declaration. A call inside the overriding class, or on a value typed as it, is in neither
answer. A definition answer with more than one place means the analyser cannot type the value. That
occurrence is left.

### After a rename

Every change is written or none is. Afterwards an open editor is told to read each changed file
again, including a moved script's old path. That is what makes it drop the old class. A scan alone
picks up a class that has appeared and keeps one that has gone.

With no editor, the class cache is rebuilt, and the UID table too when a script moved. Then the
changed scripts are compiled in a fresh engine.

### Moving a file

`resource_edit move` (`src/file-move.ts`) rewrites paths the same way for any file or directory. The
file's `.import` and `.uid` move beside it. Like the rename, it reads and writes the files itself. A
scene or resource saved as `.scn` or `.res` cannot be rewritten and is refused.

### Telling the editor about a move

An editor serving the project is then told what moved, as its own FileSystem dock tells itself.
Cached resources take over their new paths. Open tabs are renamed and read again. The settings the
move rewrote in `project.godot` are taken from the file, as they are after a rename that moves an
autoload's script. Each of those holds an old path the editor would otherwise save back.

The editor keeps a tab's path twice, on the scene's root and in its own list of scenes. A script can
set only the first. Reading the tab again renews the second. With no editor, an import pass rebuilds
the UID table and the class cache. Then the changed scripts are compiled.

## The class cache

### What the editor has not seen

`project_import refresh_classes` is the one headless call that also asks the editor which classes it
holds. It asks when an editor is connected and open on the same project. Rewriting the cache does
not reach the list a running editor already loaded. So a class it cannot resolve stays unresolvable,
and the rebuild still answers `added: []`.

Any such class comes back under `unseenByEditor`. `classesUnchecked` says so when the editor would
not answer, because a check that goes quiet on failure reads like a clean project. `editor_rescan`
reports the same two after its scan.

A class the editor holds compiled from an older text of its file comes back under
`heldBehindInEditor`. `heldBehindUnchecked` says why when the editor would not say.

### What a scan writes

The scan also writes `.godot/global_script_class_cache.cfg` from the list the editor holds. So that
file follows the editor rather than the project. A class the editor cannot resolve drops out of the
file. The next fresh engine, CI run or clone then starts from the narrower list.

Reading the file after a scan says nothing the editor has not already said. That is why
`unseenByEditor` is the whole answer.

### Engines wait for a scan

The write lands a frame after the editor stops reporting the scan, measured on 4.7.2. An engine
reads the file as it boots. So an engine started during the scan, or in that frame, resolves no
global class at all.

Every engine the server starts on a project therefore first asks an open editor with the addon's
`scan_status`. That covers a run, a boot check, a test run, a headless operation and the import
pass. The engine waits out a scan or import in progress. Then it waits until the cache is newer than
the scan's end, or for two seconds past it. It reports how long under `waitedForEditorScanMs`.

### Rebuilds and slow scans

A class cache rebuild waits before it reads the cache it compares against. So it compares the list
the editor writes. A scan still going after thirty seconds is an import of large assets, not a
script scan. The engine then starts anyway, with a `scanNote`. An editor that does not answer is not
waited for.

### No saves during a scan

Nothing the addon does saves a file while the editor scans or imports. A scan's thread ends by
writing the editor's file list to `.godot`. It walks the list as it writes. Every save in the editor
updates an entry of that list from the main thread and frees what the entry held. A save at that
moment has written garbage decoded as text and dropped the connection.

So the addon answers `busy` to every call except the few that only read or wait. Those are
`scan_status`, the rescan, the reimport, the play status and stop, and the profile read. While a
game start waits on a scan, the bridge asks again every tenth of a second. If the wait runs out, it
answers that nothing was run.

### Turned-away calls

A turned-away call did nothing. So asking again never runs it twice, and one given up on never runs
later. The scan a write asks for starts at the end of the frame, after every save the write makes.
`scan_status` reports it as `pending` until then.

### Classes lost between rebuilds

The editor writes the class cache on every save as well. So an editor holding a shorter list than
the files drops the same classes from it between rebuilds. Each rebuild puts them back.

Every rebuild the server runs writes what it left into `.godot/gdharness-classes.json`. That covers
`refresh_classes`, a test run and a rebuild after a scan. A class in that list that the cache lacks
when the next rebuild begins is named under `lostSinceLastRebuild`. The same note names the editor's
pid as one whose scan or save writes the cache short.

On that editor the rescan loads nothing. So `script_diagnostics` and `refresh_classes` send the
caller to `editor_launch restart` instead, from whichever server is running by then. A restarted
editor has a new pid and is offered the rescan again.

### The language server's own cache

Neither a rescan nor a rebuild reaches the language server. It keeps a cache of its own that nothing
on the editor side invalidates. Godot answers about a file the client has opened from the copy the
client handed it. It holds that parse. That parse holds the parses of everything the file depends on.

Keeping documents open would freeze every dependency at its text when an open file first pulled it
in. A `class_name` script edited outside the editor would keep its old members. A filesystem scan
could not touch it. Asking again re-parses only the file asked about, while the other open documents
keep pinning the stale copy.

### Each ask closes its document

Each ask gives its document back as soon as the answer arrives. A file the client does not own is
read from disk. The engine declines to keep that parse past the request, "since we can't invalidate
the cache properly". Holding documents open would opt into exactly the cache it refuses to keep.

## Running the game

`editor_run` asks the editor to play. It connects the debug adapter first, so the game's first lines
are not lost. The game then belongs to the editor's debugger. `debug_*` speaks to that session, and
`editor_output` reads the console over it.

### What makes a run spawned

Three arguments start the game here instead, because the editor cannot be given them.

- `args`, the game's own flags. The editor builds them from `editor/run/main_run_args` when it opens
  the project.
- `savesIn`, a directory for this run's `user://`. Godot takes no flag for it, so it goes in the
  environment.
- `env`, variables for this run alone.

A game the editor plays inherits the editor's environment. A session cannot restart the editor to
change one variable.

### A spawned run's environment

The run's environment is this server's, with `user://` moved when a directory was named. The
caller's variables go over that.

`GDHARNESS_RUNTIME_DIR` is set last. Where `XDG_RUNTIME_DIR` is unset, the addon derives where it
announces from the temporary directory. So a run given its own temporary directory would otherwise
announce where nothing looks. Names beginning with `GDHARNESS_` are refused for the same reason.

### How long a start waits

A start waits for the game to announce its runtime. The usual budget is five seconds, and
`runtimeWaitMs` sets another. Whenever a game is tied to its run, the server notes how long the
announcement took. The note goes into the project's `.godot/gdharness-boot.json`, inside the wait or
at the first status call after it.

The next start with no `runtimeWaitMs` waits half as long again as that boot. It never waits less
than the usual budget or more than a minute. A boot of more than five minutes is never used, because
that is a run doing its work before its first frame.

### Errors from a played game

The adapter relays what the game prints, not what it reports. A `push_error` in a played game goes
to the editor's own stderr and to its Errors tab. The adapter forwards neither.

So the runtime addon catches the report where it is made. A `Logger` in the game writes every error
and warning the engine reports to `runtime-<pid>.log`, beside the game's announcement. It is
registered only for a game carrying the editor's mark. It writes the lines the engine itself prints,
with the `at:` line and the backtrace.

The server reads that file by offset into the played run's transcript, and the transcript into the
log. So a reported error is an entry with its severity, as in a spawned run. The report outlives its
game by an hour, since the last errors are read after the game has gone. The announcement does not.

### Which report is the run's

The report is found by the game the run is tied to. A worker the game starts that loads the runtime
inherits the editor's mark and announces too. Where several games of the project have announced, the
process tree decides. The run's game is the one with no other of them between it and the editor.

A played run with no report found answers `errorsUnread` and no `clean`. A count of what the adapter
relayed says nothing about what the game raised.

### Prints and errors in order

Two streams read side by side lose their order. The prints arrive over the adapter as they come. The
errors arrive whenever the report is read. So the report carries the prints too, from the line
announcing the runtime (`[gdharness] runtime listening on ...`). The logger writes prints into the
report from that line on.

The server takes the adapter's lines up to that line and the report after it. It drops the adapter's
copies, so the console after that line is in the engine's own order.

### When the console switches to the report

The server switches at the first of these moments.

- The adapter delivers the line.
- There is no adapter to wait for, as in a run picked up after a reconnect.
- Two seconds have passed since the line reached the report.

After a reconnect, the previous server had copied the report into the transcript byte for byte. The
new one reads on from where that copy ends. A timer reads the report into the transcript four times
a second while the run is held. So an error with no print after it reaches a watched transcript
without anybody asking.

### A spawned game

With no editor connected, the server spawns the game itself. Its debugger is its keeper, described
under [The keeper as debugger](#the-keeper-as-debugger). Its console, stderr included, is read from
a file rather than over the adapter. So nothing more is needed, and the game writes no report.

### Editing while a game runs

Editing a file while a game runs does not change that game. `auto_reload` is an editor plugin. It
polls the open scene and the scripts on that scene's node tree. It reloads them with
`CACHE_MODE_REPLACE` in the editor's own process. The game is a separate process with its own copy.

So a long bench is no reason to stop editing. The new code arrives on the next
`editor_run start`. A script attached to nothing on the open scene, such as a helper on no node, is
watched by nothing.

## The keeper

### The run outlives the server

A spawned run belongs to the operating system, not to the server. A harness restarts its MCP server
whenever it likes. Claude Code does it by killing the server's process tree along parent pids. A
detached child is still a child to that walk.

So the server starts `build/keeper.js` as a launcher. The launcher starts a keeper and exits as soon
as it has the game's pid. The keeper is the game's parent and nobody's child here, so the walk has
nothing to follow. The editor `editor_launch` opens goes through the same launcher without a keeper.

### The transcript and the note

Both of the game's streams go to a transcript under the runtime directory. Beside it, a note names
the process and the file. There is one note per project, because every server on the machine shares
the directory.

The output goes to a file rather than a pipe. A pipe with no reader fills and then blocks the
writer, so a game writing into a pipe nobody reads would hang.

### No console windows

Every process the server, its scripts and its tests start goes through `src/spawn.ts`, which sets
`windowsHide`. A process with no console gives each console program it starts a console window of
its own on the desktop in use. A server under a harness can lack a console. A gate run detached
always does.

The exception is a game, whose window is the point of running it. The keeper starts it detached, so
it gets no console either. Godot's own `OS.create_process` and `OS.execute` open no console unless
asked, and the shipped scripts never ask.

### Crash dumps on Windows

On Windows an engine starts without `SEM_NOGPFAULTERRORBOX` in its error mode. So Windows Error
Reporting runs when it crashes and writes a dump where the machine keeps them. Node and Bun both set
that bit in themselves as they start. A child inherits its parent's mode. With the bit set, an
engine dying of an access violation leaves no dump and no Application Error event.

Under Bun, the server, the keeper and `gdharness test` clear the bit in themselves as they start.
Node cannot call Windows itself. So under Node, the keeper and `gdharness test` start their engines
through the desktop helper, which sets the mode first. Either way `SEM_FAILCRITICALERRORS` and
`SEM_NOOPENFILEERRORBOX` stay set. A missing drive or file then opens no box nobody will answer.

### Dumps from headless operations

The headless operations a server runs itself start the engine as the server's child. Under Node that
child still inherits the bit. A project that wants dumps from those runs gdharness under Bun. A
regression reads each engine's mode from outside it, under both runtimes.

### Writing the note

The keeper writes the note once the game is up, and the exit into it when the game ends. It is the
one process that can wait on the game. The server that started the run and any server that picks it
up both read the exit from there.

Every note, and a profiled run's profile, is written to a file of its own and renamed over the old
one. Other processes read it while it is written. A note rewritten in place is empty between the
truncate and the write.

Windows refuses a rename over a file another process has open. So the write retries for up to a
second. A write that still fails is reported to the caller rather than thrown, since a throw inside
the keeper ends the keeper.

### What a picked-up run answers

A process still there is reported as running, with everything printed while nobody was reading. One
that is gone is answered with its output and the code the keeper wrote. When the keeper went first
and nothing wrote a code, the answer is `endedUnwatched`. A guessed zero would read as a run that
finished its work.

### Stopping a run

`editor_run stop` asks the keeper to end the run. It reads the exit the keeper writes and takes the
note away. The keeper listens on a named pipe, or on a socket in a directory only its user can
enter. Its address is in the note, so a server that picked the run up asks the same way.

The keeper ends the game through the process handle it holds. For a game on the hidden desktop it
uses the handle the Windows helper holds. A handle cannot reach a later process given the same pid.

### Ending by pid

Ending by pid needs proof that the pid is still the run. On Windows that proof is a PowerShell query
and `tasklist`, and on a loaded machine neither may start in time. The pid and that proof remain for
a keeper that does not answer. Whatever the keeper says, the stop waits on the process itself before
it calls the run ended.

### A game that restarts itself

A game that restarts itself with `OS.set_restart_on_exit` is still the same run. Once the game exits,
its keeper looks for an engine started again in the last two seconds of the game's life. On Windows
it looks among the processes that still name the game as their parent.

On POSIX the engine starts the successor in a session of its own, and init adopts it. So there the
keeper looks for the engine writing into the run's transcript. The successor inherited that file,
and it belongs to this run alone.

### Telling a restart from a worker

From outside, a worker the game started in its last moments looks the same. So once the game's tree
has gone, the runtime addon writes a note saying whether a restart is set. It writes it into a
directory the keeper names in the game's environment. Where it says none, nothing is looked for. A
game without the addon is judged by the listing alone.

### Following the successor

The keeper writes `endingAt` into the note while it looks. A server waits that out rather than
settling the run as ended. When the keeper finds the successor, it writes it into the note in the
game's place, with `restartedFrom`. It then follows the successor, ends it on a stop, and records
its end as the run's. A successor that ends before the keeper's listing sees it is not followed.

On Windows the exit code is read through a handle a PowerShell opened as it listed the process.
POSIX tells only a process's parent its exit code. So there the run ends with `exitNotTold`. A stop
that closes the game like a player can set off the restart itself. The stop then ends the successor
too.

### Children of a run

Otherwise one run is one process. What the game started for itself is not signalled, and the answer
says so. A stop with `andChildren` also ends every process under the run's, to any depth, that is a
game of the project. They are listed before the run ends, because ending it makes them nobody's
children on POSIX.

A game of the project is one announced as such. It is also one whose command line is the project's
engine run with `--path` on the project. Some projects keep the runtime out of their benches, so
that thirty-one workers do not each bind a port. Those workers never announce.

The engine is the executable of the run's own process, or of one between the child and it. A worker
starts with the game's own executable. An editor is refused whatever its path says.

### Why to any depth

The process the run holds is not always the game. The Windows console build is a wrapper that starts
the engine as its child. So the game announces a pid the handle does not have. A worker it opens is
then the handle's grandchild.

The run's own game is told from a worker by the same tree. It is the announced process under the
handle with no announced process between the two. Where nothing announced, it is the project's
engine under the handle with no such engine between.

The same reading serves a runtime call and a processor-time reading when nothing else has tied the
run to its game. A process under the run that is neither is left and named, since what it is cannot
be told from here.

### Who ended a run

A run that has ended also says who ended it. `endedBy` names the call when that was this server, or
is null when it was not. Without it, a bench that stopped on its
own and a bench this server stopped look the same.

Watching a log stop growing tells nothing on a run that prints only at the end.

## Whose run a note is

Reading a note also claims the right to end what it names. The runtime directory is one per user,
not one per project. So three checks guard a note.

### Whose run it is

A server picks up a note only when it can show the run is its own. The run must be in the project it
was told to serve, or in the project the editor on the bridge has open. A server that can name
neither answers that nothing of _its_ is running. It says what is there and why it has no claim on
it.

So a regression suite, whose servers start with no project and no editor, never adopts another
project's bench.

### Which run it is

Every start, spawned or played, records which run the project's servers started last. A successor
picks up only the note of that run. A stop takes its run's note away, and a played run leaves none.
So the newest note left can be one the predecessor had long moved past, such as one from a git
worktree of the project.

### Which process it is

A pid is handed out again as soon as it is free. So before anything is signalled, the process must
answer as the run the server holds. That is the run it started or picked up from the note. Its
engine, its project and its start time, no later than the run's, must all match.

The server reads the command line where the platform gives it and the executable where it does not.
When the platform will not say, the answer is no. A process the platform will not describe is never
signalled.

The flags are read as the engine reads its own, up to the `--` after which the game's begin. So a
game given `-e` is not taken for an editor. The process is held against what the server holds, not
against the note, because the note can be gone while the run goes on.

### What a stop answers

A stop that signalled nothing answers `stopped: false` and names the pid under `notSignalled`. A
caller reads `stopped`, not the warning beside it. For the same reason, a game told to end that is
still running when the stop's wait is over answers `stopped: false`, with the pid under `stillGoing`.

A game no note names may be left by a server before a reconnect, or started some other way.
`editor_run stop` ends it by its `pid` only when two things hold. It announced itself for this
project. Its whole command line is this project's engine run, started before the announcement was
written.

## Spawned runs

### Runs a caller waits on

`project_test` and `editor_run check` stay ordinary children on pipes. Their answer is the point,
and it belongs to the call that asked. Outliving the server would leave an engine nobody reads and
nobody will end.

`editor_run check` always spawns. It runs headless for a few frames, then quits. It answers with the
boot verdict and every error and warning printed.

### Game arguments

`args` hands the game its own flags, behind the `--` where the engine stops reading. The game reads
them back with `OS.get_cmdline_user_args()`. A run carrying any is spawned rather than played by the
editor.

That is the engine's limit. The editor builds the game's command line from
`editor/run/main_run_args`, and reads that setting only when it opens the project. So a value
written later does not reach a played game.

### The keeper as debugger

The editor's debugger cannot hold a spawned run, so the run's keeper is its debugger. The game starts
with `--remote-debug` pointed at the keeper, which speaks the engine's own debugger protocol
(`src/game-debugger.ts`). `debug_*` asks the keeper over its pipe. The keeper hosts it, not the
server, because the game dials once, as it starts. The keeper is the one process that lives as long
as the game.

Every breakpoint the server holds is handed to the game as it starts. One set while it runs reaches
it at once. This debugger can also pause a running game, which the editor's adapter cannot. The
engine takes the pause between lines of script as well as between frames. So a game spinning in a
script loop on its first frame can be broken into and asked where it is.

### Pauses land in the game's own code

A pause can land between frames, or in the runtime addon, whose `_process` runs first in every frame
as an autoload's does. Either way it is stepped on to the next line of the game's own script. Nobody
pausing a game means to read gdharness's code. Errors do not stop such a game
(`--ignore-error-breaks`).

A profiled run's profiler reads the same connection. A mark (`editor_run profile` with `mark`) is the
profile's totals at that moment. It is written beside the run's note, not held in the server. So a
server that replaces this one counts `since: "mark"` from the same place.

## Reading a running game

### Reading the console

`editor_output` answers with entries rather than lines. Each `ERROR:`, `SCRIPT ERROR:` and `WARNING:`
headline comes with its `at:` line and backtrace. The answer adds the counts and a `clean` verdict.
It filters by severity, by text, and to what has arrived since the last call. A screenshot cannot do
this job, because a non-empty PNG says nothing about whether the game came up clean.

The engine's own stdin debugger is never enabled. It breaks into a prompt on the first script error
and never returns without a terminal.

### The accessibility tree

`runtime_inspect accessibility` is the one call that starts a process from inside the game. The
engine builds the tree a screen reader reads only when something asks for it. It gives a script no
way to read the tree back. Nothing on gdharness's desktop asks. A UI Automation client on the user's
desktop cannot reach a window on that desktop either.

So the runtime starts the system's own PowerShell as its child, which lands on whatever desktop the
game is on. The client's first question makes the engine build the tree. The game waits for it a
frame at a time, since the client's questions are answered on the game's main thread. A blocking
wait would hold both.

### When the engine builds the tree

The engine builds the tree only with `--accessibility always`, which `engineArgs` takes, or with the
project's setting at Always Active. The game cannot see the flag, because the engine consumes it. So
the refusal judges by a window with nothing in it. UI Automation is Windows' own. On Linux and macOS
the call says so.

## Finding a running game

The runtime addon binds loopback on a port the OS assigns. It writes a file named by its process id
with the port and the project path. The server reads that directory, which is
`$GDHARNESS_RUNTIME_DIR`, else `$XDG_RUNTIME_DIR/gdharness`, else the temporary directory.

Two games can run at once. `projectPath` picks between them, and `editor_status` lists what it can
reach.

### Sweeping stale announcements

A file whose process is gone is swept on the way past. So is a file whose pid is held by a process
that began after the file was written. A game boots before it announces, so its start precedes its
file. A process that started later took the pid after the game had gone.

The start time is asked of the operating system once per file, after the file is a minute old. It is
asked again once a minute after a confirmation. `editor_run stop` removes the file of the game it
ended, once the process has gone. So the common case never reaches that judgement.

### Writing the announcement

A file that will not parse, under a pid a live process holds, is left for the next look. The addon
writes the file whole under a `.tmp` name and moves it into place. Every server on the machine
shares the directory. A sweep could otherwise take a file between the game's open and its write.

### Script runs stay quiet

A script run is not a game. Autoloads come up for `godot -s` as well. So a test tier or a batch tool
would bind a port and announce itself under the project's own path. A client asking the runtime
anything while sixteen of those run gets whichever answers first. The addon stays quiet there unless
`gdharness/runtime/serve_script_runs` is true, for driving a `-s` script on purpose.

A scene that is not the game, such as a bench and the worker engines it starts, can be quiet the
same way. The project lists its folder in `gdharness/runtime/quiet_scenes_under`. The exception is a
run started to be profiled from its start. The variable saying so is taken out of the environment as
it is read, so the workers a profiled bench starts stay quiet.

## Headless operations

One engine per call: `godot --headless --log-file <temp> --path <project> --script <operations.gd>
<operation> @file:<params.json> <answer.json>`. Arguments are camelCase in the tool call and
snake_case in the file the engine reads. The answer is the JSON object the script writes to the
answer file. The engine's warnings and errors, and the script's own `[ERROR]` lines, come back under
`engine_messages`.

### Why the answer is a file

The project's autoloads run after the operation and print to the same stdout. An autoload printing a
dictionary in `_process` could replace an answer read as the last JSON line. With a file, a run that
wrote no answer has failed, whatever its exit code.

A run that wrote one and then exited badly still answers, as when an autoload quits with a code.
`engine_after_answer` then says how it ended, because the write it reports has happened.

### Messages after the answer

Godot starts the project's autoloads in every script run and has no switch to leave them out. So an
operation always runs them once it has answered. The script prints `[gdharness] answered` on stderr
when the answer is written.

What the engine reports after that line comes back under `engine_messages_after_answer`, with a note
saying whose it is. Mixed into `engine_messages`, a failing autoload's errors would ride on every
settings read and look like the read failing.

### Operations that wait for the autoloads

Some operations compile the project's scripts. They are `check_scripts`, `create_script`,
`modify_script`, `run_editor_tool`, and the scene, resource and animation reads, which load the
scripts a file names. They run on the first frame instead of in `_init`, after the autoloads have
entered the tree. Before then the engine does not know an autoload's name. So every script naming one
would fail to compile with "Identifier not found".

Such an operation prints `[gdharness] waiting for the autoloads` in `_init` and `[gdharness] begun`
when it starts. What the engine reports between those lines comes back under
`engine_messages_before_operation`. An engine that ends before the second line never ran the
operation, and the answer says so.

### Errors in the operations script

An error raised inside the operations script itself refuses the answer. The engine hands the
faulting function's caller a default value and exits 0. So the answer would lack whatever that
function would have given.

### The engine's own log

`--log-file` keeps that engine out of the project's `user://logs/`. Godot renames `godot.log` when a
process starts. So on a project with file logging on, a boot would rotate a running bench's log out
from under it. The bench would keep writing at its old offset. That leaves a zero-filled gap after
the operation's few hundred bytes.

These runs answer one question and exit. So their log goes beside the parameters instead.

### Which engines keep their logs

The same holds for every short-lived engine gdharness starts to answer something. These are the
operations and `project_export`, which reads its own output off the process and reports it.

A game and an editor are the point rather than a means. They write where the project keeps its logs.
A run's log is the run's. `project_test` is neither. Its whole `user://` moves to a directory of its
own, so a suite that saves a game cannot write into the saves somebody plays.

### A stale class reference cache

An import and an export start the engine as the editor. Godot crashes as such a run exits when the
editor's class reference cache is stale. The cache, `editor_doc_cache-<major>.<minor>.res` in the
editor's cache folder, is keyed on the exact build. Two patch releases of one minor version, such as
4.7.1 and 4.7.2, each leave the other a stale cache.

The thread that reads the cache hands the rebuild to the main thread as a deferred call. The editor
frees the class reference as it is torn down. The deferred call runs after that. By then the run
has done its work and written a fresh cache. So the next run is clean.

### Retrying after that crash

When an import or an export ends badly after a cache in that folder was written during the run,
gdharness runs it once more. It says why under `docCacheNote`. Windows reports the crash as an
access violation, 0xC0000005. A runtime that keeps only the low byte of an exit code, as Bun does,
reports it as 5.

On macOS the engine's crash handler prints the signal, and the process then exits 0. So a run whose
output holds that report counts as ending badly too.

## Reading settings

`project_settings get` reads like a look at a config file and is not. It starts an engine, so a
setting nobody wrote into `project.godot` still answers with the default the engine registers.

### The disk or the editor

The engine it starts reads the file. An open editor holds a different reading, including changes
nobody has saved. `project_settings get` takes `from` to choose between them.

- `disk` is the default and the only reading a CI job can use. It needs no editor, and any
  machine reproduces it.
- `editor` costs no engine start and answers what the editor holds.

Asking for `editor` with no editor connected is refused rather than answered from the file. An answer
that silently changed its source cannot be told from the one the caller asked for. Both readings run
their values through the same serialiser. So a `Vector2` is spelled the same either way, and the two
can be compared. Only reads take the argument, since a write goes to the file either way.

## Reading scenes and resources

`scene_tree` and `resource_edit read` offer no such choice, because the editor reads them from the
file as well. Both go through `file_reads.gd`. The editor's tools call it, and an operation runs it
when no editor serves the project. Only the editor's answer says whether it holds unsaved changes to
the scene. The headless answer carries `readBy` instead.

### A scene is read, not instantiated

A scene is read off its `SceneState`, with each instanced scene laid where it is instanced. It is not
instantiated. Instantiating outside the editor runs every node script's member initialisers and
`_init`. So a read would run the game's code on every node.

The read matches entries to nodes as instantiating does. An entry may set values on a node its source
scene has since renamed or moved. That entry is found by the node's `unique_id`, among the nodes
owned by the nearest instance above it. The node keeps its new name.

`SceneState` does not give scripts the ids, so they are read from the text of a `.tscn`. A binary
scene's entries are matched by path alone.

### Editable instances and stored properties

`SceneState` does not give scripts its list of editable instances either. That list is read off the
scene's `_bundled` dictionary, from the scene being read and the scenes it inherits only. Those share
its root. A scene instanced below lists the instances its own root keeps values for.

The stored properties come from a bare node of each engine class with the file's values set on it.
What a node lists depends on its values. Some setters also set others.

### Resources inside a file

A resource kept inside a file is found among what the file holds. Its path looks like
`res://hero.tscn::Animation_jump`, the path a property holding one is answered with. The engine loads
such a path only while the file is cached, and a read loads it uncached. The server takes the id off
before the project boundary judges the path, which is a file's.

### Animation reads

`scene_animation read` and `read_states` share `animation_reads.gd` the same way. The editor hands it
the node from the scene it opens. With no editor, the operation builds a bare `AnimationPlayer` or
`AnimationTree` from the properties `file_reads.gd` lays for that node, with its script left off. So
the libraries and the tree root are the ones the file stores, and no script of the scene runs.

## Headless writes

The scene and resource writes work the other way round. With no editor, `editor_tools.gd` runs the
editor addon's own `scene_tools.gd`, `animation_tools.gd`, `animation_states.gd` or
`resource_tools.gd` in a headless engine. They are preloaded from beside the operations in the
package. So a write passes the checks the editor's does and answers in its shape, with `writtenBy`
(or `readBy`) added.

### Undoing what scripts did

A write cannot avoid instancing the scene the way a read does. Outside the editor, instancing runs
every script. The editor gives a script that is not a tool a placeholder. So `scene_file.gd` and
`headless_check.gd` put back what such scripts did.

On opening, each node with such a script is compared with what the file stores for it. A difference
goes back to the file's value. Where the file does not set it, it goes back to what the node would
load with. That value is read from the files of the scenes it is instanced from. On writing, a node
the tool changed through such a script has every other property put back to what it held before.

### Nodes without such a script

A node with no such script is left alone. A script runs on its own node as the scene loads. Anything
else a pack changes, the editor's pack changes too. An example is a Control gaining its grow
directions from the setter of `anchors_preset`.

### Embedded resources and rounds

After the save, the embedded resources that carry a script are compared with the file's text before
the write. So is the main resource of a resource file. They are put back the same way.

Putting one property back can run a setter that changes another already put back. So a scene is
packed and put back again until nothing differs, for up to four rounds. A resource file gets one.
What still differs then is refused, with the file restored. So is a scene whose script did not
compile, which the engine instances without it.

### Lines that do not count against a write

A line that only restates a property's default does not count against a write. The engine reports no
default for an export initialised by a constructor call, such as `PackedStringArray()`. So every save
writes one, the editor's too. That default is read from the declaration in the script instead.

Nor does a line the saver writes another way. A file written by hand may set a default outright,
which the saver leaves out. It may spell a value as `3` where the saver writes `3.0`. So the texts
before and after are compared as the values they read as. A missing line reads as the default.

### UIDs in a headless save

A headless save also writes back the uid the file had, and the uid on each external resource it
names. An engine with no editor's file system drops them, since only that tells the saver a path's
uid. A reference gets the uid the uid cache holds for its path and no other.

- A uid the cache does not know warns on every load. That happens for a file made with no editor
  since the last scan.
- A uid the cache gives another file loads that file. That happens for the original of a scene
  copied whole.

A file left to be named by path for the first reason is listed under `namedByPath`, with
`project_import refresh_uids`. That import pass gives the cache its uid. Each headless call is an
engine of its own. So the list gathered in a static on `scene_file.gd` holds that call's saves alone.

### Library files and open editors

An animation library kept in a file of its own is saved beside the scene. It is refused when it, or
a resource it embeds, carries a script that is not a tool. Nothing compares that file with its text.

An editor of the project that is running but has not reached this server holds its own copy of
anything it has open. Saving that copy would put back what the engine wrote. So a write waits for it
to connect instead.

### Export presets

`project_export add_preset` writes `export_presets.cfg` from an operation in `export_presets.gd`. It
writes the keys the editor's Export dialog writes for a new preset. The exporter fills every platform
option the file leaves out with its default.

An open editor is the one reader this misses. Godot reads the file when the editor starts, and again
only when an export platform comes or goes. So the editor does not list the new preset. The next save
of its Export dialog writes its own list over the file.

The answer says so when an editor is connected. An export through `project_export run` starts an
engine of its own, which reads the file.

### Export templates

Whether templates are installed is read per platform, from the files in the engine version's
templates directory. That directory holds whichever platforms were installed into it.

## Values over JSON

### The serialiser

The serialiser both readings use is one file, `serialisation.gd`. `bun run sync:gd` copies it into
each addon, because an addon is installed as a directory and cannot preload out of one. A fixture
refuses a copy that has drifted.

What is tagged is what JSON cannot carry. JSON does not refuse such a value. It writes the value's
own text instead. A `Polygon2D`'s points would come back as the string `"[(1.0, 2.0), (3.0, 4.0)]"`
and a `Quaternion` as `"(0, 0, 0, 1)"`. Each reads like an answer and cannot be read back.

So the fixture walks the engine's own type list rather than a list kept here. Every type is carried
out through JSON and built back. A type with no case fails rather than being skipped.

### What is left untagged

What JSON does carry exactly is left alone. So a plugin list is still `["res://addons/x/plugin.cfg"]`,
not a wrapper around one. `type_convert` restores the exact packed type wherever the receiver knows
which one it wanted.

### Infinity and NaN

Infinity and NaN are numbers JSON cannot carry. The engine writes infinity as `1e99999` and NaN as
`null`. The server reads the first as `Infinity` and writes both back out as `null`. So a property
holding `INF` would be answered as holding nothing.

Each is tagged as `{"_type": "float", "value": "inf"}` (or `"-inf"`, `"nan"`), bare or as a
component of a vector, colour or rectangle. A write accepts the same tag. The fixture holds the wire
text itself to having neither spelling. A round trip through the engine's own JSON reads `1e99999`
back as infinity, so it would pass on the wire that loses it.

### Large whole numbers

Whole numbers of 2^53 or more are the other numbers JSON cannot carry. The server and the engine
both read a JSON number as a double. From 2^53 on, two neighbouring whole numbers share one.

A RefCounted's instance id has its top bit set. A resource uid is 63 bits. Both would come back as a
neighbouring id.

Such a number is answered as its digits, `{"_type": "int", "value": "..."}`, and built back from
them. One arriving as a bare number for an int is refused, since it may already be a neighbour of the
one sent. An RID is answered as its id and built back from it. So a viewport's RID read off one call
is an argument to the next.

### Dictionary keys

JSON keys are text. So a dictionary keyed by anything else is answered as its entries,
`{"_type": "Dictionary", "entries": [[1, "a"]]}`. A write accepts the same. Answered as text, an int
key would come back as `"1"`.

A whole-number key is built back as an int. JSON gives every number as
a float. A dictionary keys `1.0` apart from `1`.

### Answers too large for the client

An answer too large for the client never goes out. Claude Code closes the connection on a message
past 16 MB. That loses the call and every later tool until the server reconnects. The text is also
escaped again inside the JSON-RPC message.

An answer past 4 MB is written to files in a scratch directory. The answer says where, beside the
short fields of its top level. `project_test` bounds its own answer first. Identical reports in a
case are folded, and at most twenty different ones are kept. Past about a megabyte, the failing
cases with the largest reports are named with their first message only.

## Writing values

### Values arriving to be written

A value arriving to be written goes through `property_values.gd`. The editor addon carries a copy,
as it does of `file_reads.gd`. It reads the serialiser's tags, so every shape a read answers with is
a shape a write accepts. It adds what only a property knows, the type wanted. So a dictionary shaped
like a vector, or a bare pair of numbers, is read as one.

`scene_node set`, `resource_edit` and `scene_animation` all go through it.

### Refusing a lossy write

It also decides whether the write happens at all. `Object.set` converts rather than refuses, and the
conversion is silent and lossy. A word written to an `int` property is stored as `0`, to a `bool` as
`true`, to a `Vector2` as `(0, 0)`.

A packed array takes whatever is in the list. So a polygon written as anything but points becomes
that many zero vectors. The file would then hold a value nobody asked for while the answer reports
the change as made.

So a value that cannot become the declared type is refused with both types named. A packed array is
asked the same of each element, and the refusal names the index. A property the object does not
declare is refused rather than ignored.

### The same check in the running game

The running game asks the same of an argument before `callv` and of a value before a wait compares
it. It does so through `acceptable` beside the serialiser, so the two sides cannot answer
differently.

### Value shapes

`value_shapes.gd`, shared the same way, holds three things. They are what each tag has to carry, the
fields it reads when present, and how a refusal spells a type. A value carrying a field its type
does not have is not built. A builder takes the fields it knows and drops the rest. So
`{"x": 1, "y": 2, "z": 3}` for a `Vector2` would be written as `(1, 2)` and answered as written.

Every refusal of a value where such a type goes ends with the key that stopped it and the shape that
is read. It comes from the same function on every side. That includes an element of a packed or
typed list and a value of a typed map. Those are fitted one by one. So the refusal that names the
index says why that element was refused and not its neighbour.

### Reading back what a setter did

A value that passes is still read back once set. A setter can refuse or change it and say so only in
the editor's log. A `Timer` given a `wait_time` of 0 holds 1. A `Sprite2D` given a material for its
texture holds nothing.

Each property set in a call is set once more after the rest. So a `ProgressBar` given `value` before
a larger `max_value` is not left clamped to the old maximum. Then anything still holding something
other than what was sent is refused with what it holds.

### What else a setter moved

The stored properties the call was not given are read before and after it. Those a setter moved come
back under `alsoChanged`. A `Gradient` given a third colour gives the new point an offset of 0. A
`Control` given a size keeps it as offsets. So the answer names what the file will hold beyond what
was asked.

A list is copied before the write, since a setter can add to one in place.

### Declared ranges and enums

A value past an export range, or a number none of an enum's values has, is stored as the engine
stores it. It is named under `outsideDeclared`, since the inspector would not have let it be entered.
An enum is written by the name of a value as well as its number.

Both come from `declared_values.gd`, which the runtime addon carries too. So a set in the running
game takes the same names and says the same under `outside_declared`. A wait takes the names a set
does.

The element types of a typed `Array` or `Dictionary` export come from the property's declaration. In
the editor, a script's exports sit behind a placeholder that stores whatever it is given.

## Scene writes

The scene tools never touch the editor's open scene. Each works on a copy of the file through
`scene_file.gd`, which does for that copy what the editor does for its own.

### Reading past the resource cache

It reads the file past the resource cache. The cached `PackedScene` is the one a preload or an
exported scene holds. A write saves a new one without touching it. So each write would otherwise
start from the copy before the last write and save over it.

### The editor's edit state

It instantiates with the editor's edit state. Without one, the copy keeps no record of which nodes
came from another scene. The pack would write an inherited scene out as a standalone copy of its
base. It would also freeze each instanced scene's root properties into the scene instancing it.

### What the scene does not own

It refuses to change what the scene does not own.

- A node inside an instanced scene whose children are not editable here.
- A node a script made as the scene was instanced.
- The removal or renaming of a node a base scene gives.

The pack saves only what the scene owns. So these changes would be answered as done and be missing
from the file.

The refusal for a node inside an instance names the `scene_node set editableChildren` calls that let
the scene keep its own values for it. There is one call for each instance around it that is not
editable, outermost first. The pack skips everything under such an instance.

### Following a move into other scenes

A node renamed or reparented is followed into the other `.tscn` files that name it by path. Those
are the scenes instancing or inheriting the scene, found from the `path=` of their external
resources. The search repeats from the scenes found until it finds no more.

In each one, `scene_kin.gd` takes where the scene's instances are from its read tree. Then it
rewrites the editable paths, the entries' names and parents, and the connections it names below
them. Godot finds an entry whose node moved by `unique_id`, and its parent by `parent_id_path`. It
finds an editable path only by the path. So that scene's next save would drop what it kept below the
instance.

### Ids and scenes left alone

A reparent also drops the ids saved beside each rewritten path. They run through the old parent,
which still exists for a recovery to find. A rename keeps every id. A scene that does not load, or
that the editor holds unsaved changes to, is left as it was and named under `notFollowed`.

### Node paths a move leaves behind

`scene_paths.gd` carries the node paths a moved node leaves behind, as the editor's `SceneTreeDock`
does on a rename. It covers NodePath values in properties, arrays, dictionaries and the resources
built into the scene. It covers the tracks of every player's animations, read from the player's root
node.

It works each path out from where its holder was and where it pointed before the move, not from the
live tree. So the same code follows the paths in the scenes `scene_kin.gd` reaches. Those are loaded
after the move and no longer resolve the old paths.

### Paths another file gives

Each scene has its own terms. A value another file gives, the instanced scene's or a base's, is in
that file's terms. That file's own pass carried it. So it is named under `notRetargeted` only when
the move has left it naming nothing. A track of an animation kept in another scene or an imported
file is treated the same way.

An animation kept in a `.tres` of its own is saved after the scene. The editor shares that resource
with every scene using it, so a refused write puts its tracks back. A delete rewrites nothing. It
lists what still names the deleted node under `stillNaming`, since dropping a track loses its keys.

### Paths in scripts

Scripts are code and are left as they were, as the editor leaves them. Even so, a line reading a
moved node as `$Status` fails once the move is saved. `script_paths.gd` reads the paths a script
names from its tokens. Those are `$Path`, `%Unique`, and a string handed to `get_node` and its kin on
the node itself. `scene_paths.gd` works each out from the node the script is on, as it does a
NodePath value.

Every line whose path no longer reaches its node is listed under `scriptsNaming`, with the path that
would. For this, `scene_kin.gd` follows a move into a scene that holds a script and no NodePath. A
script read in two scenes, as on an instance's root, is listed once.

### Checking before writing

It packs the copy and instantiates the pack before writing anything. Each tool checks its change in
that result, which is what loading the file will give. A property the node took but the file does
not keep is refused there. An example is a variable a `@tool` script does not export.

### Unsaved changes in the editor

It refuses to write a scene the editor holds unsaved changes to. The editor reloads a scene written
under it, and the reload drops those changes without a prompt. After a write it replaces the cached
copy in place, so whatever holds the scene sees the change. It reloads every tab showing the scene,
not only the one in front.

### Saving through the editor

`scene_create save` of a scene open in the editor saves the editor's copy through the editor's own
save. It brings that tab to the front for the save, then puts back the tab that was there.

`scene_create` with `inherits` writes the new scene's text itself, as the editor's New Inherited
Scene saves it. It does not pack an instance of the base. A headless engine instancing the base runs
its scripts, and the pack would keep what they set as the new scene's own values. It names the base
by uid on the same rule as a headless save. Then it loads the result back to check that it inherits
the base.

`resource_edit` reads the file back after saving a resource. It puts the old file back when a
property set did not survive the save.

## The project's warnings and names

### Warning levels

`--path` also makes that project's GDScript warning levels the ones the operations script compiles
under. That holds although the file lives in gdharness's own package, not in the project.
`debug/gdscript/warnings/directory_rules` cannot exempt it, because its rules match only paths under
`res://`.

A project could turn `unsafe_call_argument` or `return_value_discarded` up to error. Then gdharness
would stop compiling, and every headless operation would fail at once. So the shipped GDScript is
written to survive every warning this engine has at error level. Nothing untyped goes to a typed
parameter, and nothing returned is dropped.

`test/engine-gdscript.ts` asks the engine for its own list of warnings rather than keeping one. It
turns all of them up and empties `directory_rules`, so the addons are held to it too. It then runs
an operation from outside the project, the way the server does.

### Names in the shipped scripts

The project's names reach into the shipped scripts too. Godot resolves a type as a global class,
then an autoload, before the script's own constants and inner classes. Take a project with
`class_name Log`, or an autoload called `Log`. There a module's `var logger: Log` names the project's
`Log`, not the logger it preloads. The script then refuses to compile at any warning level.

An inner class of the same name is refused outright as hiding the global one. So every name a
shipped script declares in a class's casing starts with `Gdh`. That covers a preloaded module, an
inner class and an enum.

The engine suite declares a class and an autoload for each such name, without the prefix. It
compiles and runs the shipped scripts beside them. It also refuses a declared name in a class's
casing that lacks the prefix.

### Settings under the warnings prefix

Not everything under `debug/gdscript/warnings/` is a warning level. On 4.7.2 there are 52 settings
there, and 49 take a level. `enable` and `renamed_in_godot_4_hint` are booleans. `directory_rules`
is a dictionary of path to level.

A loop that writes 2 to each setting under the prefix writes a level over a boolean. Nothing looks
wrong afterwards, because a boolean reads 2 as true.

So the levels are picked out by the type the engine registers. A list of the three exceptions would
go stale. `project_settings get` takes a `prefix` and answers with the type of each. Make that call
before deciding what a family holds.

## What a headless boot leaves alone

Apart from its own log, a headless boot leaves the project alone. A `--script` run performs no
filesystem scan and no import, so it writes nothing under `.godot`. A project that has only ever
been scripted still has an empty one. A settled project's class cache, uid cache and extension list
come through a boot untouched. That was measured across a settings read, a health walk, a class
query and a validation.

So a read-only call beside a running game leaves the game alone. `project_import refresh_classes`
writes the class cache there because that is what it was asked to do.

### `refresh_uids`

`project_import refresh_uids` is the exception. It runs `--import`, the engine's own pass over the
project, rather than `--script`. That pass is the only thing that mints a `.uid`.
So it scans, writes under `.godot`, and writes a `.uid` beside each script and shader that had none.

It writes no file that already exists. The pass leaves every scene byte for byte as it was. A
headless resave would rebuild the header from what the engine could see. It would drop `load_steps`
and the scene's own `uid=`. That would delete the very references the op exists to keep resolvable.

## What a project walk skips

Every walk over a project directory stops at the same three things. That holds whether the engine
walks or the server reads the directory itself.

- A name starting with a dot.
- `node_modules`.
- A directory holding a `.gdignore`.

That is what the engine steps over. So nothing under one is imported. What is in there is not a
resource, a dependency, a global class or a search result.

A vendored engine, an export directory and somebody else's project kept for reference are the usual
reasons to have one. Answering about their files would name things the engine will never load.
