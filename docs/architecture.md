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
compares the editor addon code the editor loaded against the code this server ships (by a digest
the install writes as `.gdharness-digest`, so an upgrade that leaves that code alone does not call
the editor stale; an addon from before digests is compared by version), and `projectIs` catches
the other direction, a project upgraded while the server kept running, which nothing else reports
at all.

Every answer that came out of the editor carries `addonIsStale` and `staleNote` too, when the two
halves differ. Only `editor_status` used to, so an editor several releases behind went on
answering scene and resource questions out of the code it loaded at startup, confidently, and a
caller who never asked about versions had nothing to go on. Measured in the field: four errors
from a stale addon that were not errors and vanished on restart. Read the version from
`serverVersion` rather than from the pin when it matters, because the pin describes the next
server and the process answering is whatever the harness spawned at the last reconnect.

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

A fix is not finished when the code is right. It is finished when the answers are still
unambiguous afterwards, because a fix makes new states and hands them to the sentence that was
already there. Teaching a server to claim only its own runs made "No game is running" mean both
_nothing is running_ and _something is running that I have no claim on_, which is the fault it had
just fixed, one layer in and written by the fixing. Read the sentences a change leaves behind.

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

**One editor setting is written, once, and it is not a port.** Godot's debug adapter answers a
session's `initialize` by clearing every breakpoint in the script editor, open scripts and closed
ones alike, unless `network/debug_adapter/sync_breakpoints` is on, and it is off by default. A
server opens a session for its first breakpoint or its first stack read, so a harness session took
the user's breakpoints away on its first debug call. The addon turns the setting on as it loads,
which the adapter picks up without a restart, and reports it in its greeting: `editor_status` and
`debug_breakpoint` say `breakpointsAtRisk` about an editor running an addon that did not. With it
on, a session opening is told the editor's breakpoints instead, and `debug_breakpoint` sends a
file's whole list as the union of what it holds and what the editor has, so setting a line never
clears the ones set by hand.

Two projects, two harness sessions, two servers and two editors therefore work at once. A server
`setup` wrote answers about its own project's game rather than whichever one it finds announced,
so `runtime_*` needs no `projectPath` on a machine running two. One server still serves one
editor: the bridge carries a single connection.

Two servers on one project is the harder case, since their games announce the same project. A
game the editor plays says which editor: the editor addon puts its process id into its own
environment as it loads, every game it plays inherits that, and the runtime announces it as
`editor_pid`. A game some other server started announces none, so a start waiting for its game's
runtime passes over a stranger's announcement however fresh, and `editor_status` lists `editorPid`
under each runtime so a caller can tell them apart too.

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

**An editor gdharness opens writes its console to `.godot/gdharness-editor.log`,** because nothing
can read it otherwise. What an editor prints goes to a console no plugin can reach, so the addon
cannot scrape it from inside, and an editor in self-contained mode writes no log of its own: a
project whose editor printed hundreds of parse errors at startup had every gdharness tool agreeing
it was fine, and the only way to the wall was somebody reading the window. So `editor_launch` asks
the engine for a log file as it starts, and `editor_output op: "editor"` reads it. The engine
replaces that file when it opens it, so one file is one editor session from its first line, which
is where a wall of startup errors will be. Beside it, `.godot/gdharness-editor.json` records which
editor the log belongs to: a log from yesterday's editor is still on disk today, and reading it as
this one's would answer with a session that has ended. An editor somebody opened by hand has no log
at all and is refused saying so.

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

`project_import refresh_classes` is the one headless call that also asks the editor what classes
it holds, when one is connected and open on the same project. Rewriting the cache does not reach
the list a running editor already loaded, so a class it cannot resolve stays unresolvable and the
rebuild still answers `added: []`. Any such class comes back under `unseenByEditor`, and
`classesUnchecked` says so when the editor would not answer, because a check that goes quiet on
failure reads exactly like a clean project. `editor_rescan` reports the same two after its scan.

The scan also writes `.godot/global_script_class_cache.cfg` from the list the editor is holding,
so that file follows the editor rather than the project: a class the editor cannot resolve is one
the scan drops out of the file, and the next fresh engine, CI run or clone starts from the
narrower one. Reading the file after a scan therefore says nothing the editor has not already
said, which is why `unseenByEditor` is the whole answer and not half of it.

The write lands a frame after the editor stops reporting the scan, measured on 4.7.2, and an engine
reads the file as it boots, so one started during the scan or in that frame resolves no global
class at all. Every engine the server starts on a project (a run, a boot check, a test run, a
headless operation, the import pass) first asks an editor open on that project with the addon's
`scan_status`, waits out a scan or import in progress, then waits for the cache to be newer than the
scan's end or for two seconds past it, and says how long under `waitedForEditorScanMs`. A class
cache rebuild waits before it reads the cache it compares against, so the list the editor writes is
the one compared. A scan still going after thirty seconds is an import of large assets rather than
a script scan, and the engine starts anyway with a `scanNote`. An editor that does not answer, or
whose addon predates `scan_status`, is not waited for.

The editor writes that file on every save as well, so an editor holding a shorter list than the
files takes the same classes out of it between any two rebuilds, and each rebuild puts them back.
Every rebuild the server runs, for `refresh_classes`, for a test run or after a scan, writes what
it left into `.godot/gdharness-classes.json`; a class in that list that the cache no longer holds
when the next rebuild begins is named under `lostSinceLastRebuild`, and the editor's pid goes into
the same note as one whose scan or save writes the cache short. On that editor the rescan loads
nothing, so `script_diagnostics` and `refresh_classes` send the caller to `editor_launch restart`
rather than to it, from whichever server is running by then; a restarted editor has a new pid and
is offered the rescan again.

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

Three things take that away and start the game here instead, and all three are things the editor
cannot be given: the game's own `args`, which it builds from `editor/run/main_run_args` when it
opens the project; `savesIn`, a directory for this run's `user://`, which Godot takes no flag for
and which therefore has to be the environment; and `env`, variables for the run alone. A game the
editor plays inherits the editor's environment, and a session cannot restart the editor to move
one variable, so the windowed run somebody watches was the one run that could not be kept out of
the player's saves. The run's environment is this server's, with `user://` moved when a directory
was named and the caller's variables over that, and `GDHARNESS_RUNTIME_DIR` set last: the addon
derives where it announces from the temporary directory where `XDG_RUNTIME_DIR` is unset, so a run
given a temporary directory of its own would otherwise announce where nothing looks. Names
beginning with `GDHARNESS_` are refused for the same reason.

A start waits for the game to announce its runtime, and the wait is sized to the project. The
usual budget is five seconds, which a project that boots in eight overran on every start until
the caller passed `runtimeWaitMs` each time. So the announcement's time against the run's start is
noted in the project's `.godot/gdharness-boot.json` whenever a game is tied to its run, inside the
wait or at the first status call after it, and the next start with no `runtimeWaitMs` waits half
as long again as that: never less than the usual, never more than a minute, and never sized to a
boot of more than five minutes, which is a run doing what it was asked before its first frame.

The adapter relays what the game prints and not what it reports. A `push_error` raised in a game
the editor plays goes to the editor's own stderr, which nobody reads, and to the editor's Errors
tab, which the adapter does not forward, so `editor_output` answered `clean: true` about a game
that had just refused something out loud. The runtime addon takes the report where it is made: a
`Logger` in the game, registered for a game carrying the editor's mark, writes every error and
warning the engine reports to `runtime-<pid>.log` beside the game's announcement, in the lines
the engine itself prints, with the `at:` line and the backtrace. The server reads that file by
offset into the played run's transcript, and the transcript into the log, so a reported error is
an entry with its severity the way one printed by a spawned run is. The report outlives its game
by an hour, since the last errors are read after the game has gone; the announcement does not.

With no editor connected, the server spawns the game itself. It has no debug session, so `debug_*`
will not answer for it, and its console is read from a file rather than over the adapter, stderr
included, so nothing more is needed there and the game writes no report.

**Editing a file while a game runs does not change that game.** `auto_reload` is an editor plugin:
it polls the open scene and the scripts on that scene's node tree, and reloads them with
`CACHE_MODE_REPLACE` in the editor's own process. The game is a separate process holding its own
copy, and nothing crosses between them. Measured rather than reasoned: the same method answers 8
throughout a run, and 12 from a game started afterwards, with only the file having changed. So a
long bench is not a reason to stop editing, and the new code arrives on the next
`editor_run start`. A script attached to nothing on the open scene, a helper hanging off no node,
is watched by nothing at all.

That run belongs to the operating system rather than to the server. A harness restarts its MCP
server whenever it likes, and Claude Code does it by killing the server's process tree, walking
parent pids: benches forty minutes into a sweep were killed twice in one session by a reconnect
nobody asked for, and spawning the run detached did not help, because a detached child is still a
child to that walk. So the server starts `build/keeper.js` as a launcher, which starts a keeper and
exits as soon as it has the game's pid; the keeper is the game's parent and nobody's child here,
so the walk has nothing to follow. The editor `editor_launch` opens goes through the same launcher
without a keeper. Both of the game's streams are written to a transcript under the runtime
directory, with a note beside it naming the process and the file. A file rather than a pipe
because a pipe with no reader fills and then blocks the writer: surviving the server down a pipe
would only trade a killed run for a wedged one.

The keeper writes the note once the game is up and its exit into the note when it ends, since it
is the one process that can wait on the game; the server that started the run and any server that
picks it up read the exit from there alike. A process still there is reported as running, with
everything printed while nobody was reading; one that is gone is answered with its output and the
code the keeper wrote, or with `endedUnwatched` when the keeper went first and nothing wrote one,
because a guessed zero reads as a run that finished its work. `editor_run stop` ends it by pid,
reads the exit the keeper writes for it, and takes the note away. One run is one process: what the
game started for itself is not signalled and the answer says so, unless the stop is asked for
`andChildren`, and then every process under the run's, to any depth,
that is a game of the project goes with it, listed before the run is ended because ending it is
what makes them nobody's children on POSIX. A game of the project is one announced as such, or one
whose command line is the project's engine run with `--path` on the project: a project that keeps
the runtime out of its benches on purpose, so that thirty-one workers do not each bind a port, has
workers that never announce, and the fan-out this argument was written for was the one it could
not reach. The engine is the executable of the run's own process or of one between the child and
it, since a worker is started with the game's own executable, and an editor is refused whatever
its path says. To any depth because the process the run holds is not always the game: the Windows
console build is a wrapper that starts the engine as its child, so the game announces a number the
handle does not have and a worker it opens is the handle's grandchild. The run's own game is told
from a worker by the same tree, as the announced process under the handle with no announced
process between the two, or, where nothing announced, as the project's engine under the handle
with no such engine between, and the same reading serves a runtime call and a processor-time
reading when nothing else has tied the run to its game. A process under the run that is neither
is left and named, since what it is cannot be told from here.

A run that has ended also says who ended it. `endedBy` names the call when that was this server,
and is null when it was not, which is an answer rather than the absence of one: a bench that
stopped on its own and a bench this server stopped are otherwise the same silence. Six deaths in
one afternoon were each worked out by hand for want of that distinction, and the reflex they
produced, watching a log stop growing, is wrong on a run that prints only at the end.

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

A file whose process is gone is swept on the way past, and a file whose number is held by a process
that began after the file was written is swept the same way: a game boots before it announces, so
its start precedes its file, and a process that started later took the number after the game had
gone. Measured downstream, where a shell held the number of a game ended an hour before and the
file read as a game "still starting" through two further runs. The start time is asked of the
operating system once per file, after the file is a minute old, and again once a minute after a
confirmation. `editor_run stop` takes the file of the game it ended down itself, once the process
has gone, so the common case never reaches that judgement. A file that will not parse under a
number a live process holds is left for the next look, not swept, and the addon writes the file
whole under a `.tmp` name and moves it into place: the directory is shared by every server on the
machine, and one still running an older sweep would otherwise take a file it met between the
game's open and its write.

A script run is not one of them. Autoloads come up for `godot -s` as well, so a test tier or a
batch tool would bind a port and announce itself under the project's own path, and a client asking
the runtime anything while sixteen of those run gets whichever answers first. The addon stays quiet
there unless `gdharness/runtime/serve_script_runs` is true, which is for driving a `-s` script on
purpose.

## Headless operations

One engine per call: `godot --headless --log-file <temp> --path <project> --script <operations.gd>
<operation> @file:<params.json>`. Arguments are camelCase in the tool call and snake_case in the
file the engine reads. The answer is the last JSON object printed on stdout. Anything on stderr
comes back under `engine_messages`.

`--log-file` keeps that engine out of the project's `user://logs/`. Godot renames `godot.log` when
a process starts, so on a project with file logging on, one of these boots rotated a running
bench's log out from under it, and the bench went on writing at the offset it still believed it
was at: the operation's few hundred bytes, a zero-filled gap, then the bench's next row. These
runs answer one question and exit, so their own log is of no use to anybody and goes beside the
parameters instead.

That holds for every short-lived engine gdharness starts to answer something: the operations, and
`project_export`, which reads its own output off the process and reports it. The engines that do
write where the project keeps its logs are the ones that are the point rather than a means, a game
and an editor, and a run's log is the run's. `project_test` is neither: its whole `user://` moves
to a directory of its own, so a suite that saves a game cannot write into the saves somebody
plays.

Which tools this covers is worth knowing, because `project_settings get` reads like a look at a
config file and is not: it starts an engine so that a setting nobody wrote into `project.godot`
still answers with the default the engine registers for it.

That engine is the file's reading, and an open editor holds a different one: what it has been told,
including changes nobody has saved. `project_settings get` takes `from` to choose between them.
`disk` is the default and is the only reading a push gate can use, because it needs no editor and
any machine reproduces it. `editor` costs no engine start and answers what the editor is holding,
and asking for it with no editor connected is refused rather than answered from the file, because
an answer that silently changed its source is one the caller cannot tell from the one they asked
for. Both readings run their values through the same serialiser, so a `Vector2` comes back spelled
the same either way and a caller can compare the two. Only reads take the argument: a write goes
to the file whichever way it is phrased, so there is nothing to choose between.

That serialiser is one file, copied into each addon by `bun run sync:gd` because an addon is
installed as a directory and cannot preload out of one, and a fixture refuses a copy that has
drifted. It used to be three, and the three disagreed: the same `Vector2` came back tagged `_type`
from a headless read and `type` from the editor, and a `Rect2` came back as two corners from one
and four numbers from the other. What is tagged is what JSON cannot carry. JSON does not refuse
such a value, it writes the value's own text and moves on, so a `Polygon2D`'s points came back as
the string `"[(1.0, 2.0), (3.0, 4.0)]"`, a `Quaternion` as `"(0, 0, 0, 1)"`, and each read like an
answer while being unreadable back. Twenty-four of the engine's thirty-nine types were flattened
that way and thirteen were handled, so the fixture walks the engine's own type list rather than a
list kept here: every type is carried out through JSON and built back, and a type with no case
fails rather than being skipped. What JSON does carry exactly is left alone, which is why a plugin
list is still `["res://addons/x/plugin.cfg"]` rather than a wrapper around one; `type_convert`
restores the exact packed type wherever the receiver knows which one it wanted.

The other direction, a value arriving to be written, is `property_values.gd` on the editor side. It
reads the serialiser's tags, so every shape a read answers with is a shape a write accepts, and adds
the part only a property knows: the type wanted, so a dictionary shaped like a vector, or a bare pair
of numbers, is read as one. `scene_node set`, `resource_edit` and `scene_animation` all go through
it, which they did not before: they knew eighteen types, seven and three respectively, and a
`Quaternion` keyframe or a `Rect2` written to a resource was stored as the dictionary it arrived as.

It also decides whether the write happens at all. `Object.set` converts rather than refuses, and the
conversion is silent and lossy: a word written to an `int` property is stored as `0`, to a `bool` as
`true`, to a `Vector2` as `(0, 0)`, and a packed array takes whatever is in the list, so a polygon
written as anything but points becomes that many zero vectors. The file is then saved holding a value
nobody asked for while the answer reports the change as made, which leaves nothing to read afterwards
that says otherwise. A value that cannot become the declared type is refused naming both types, a
packed array is asked the same question of each element and names the index, and a property the
object does not declare is refused rather than ignored. The running game asks the same question of an
argument before `callv` and of a value before a wait compares it, through `acceptable` beside the
serialiser, so the two sides cannot answer it differently.

`--path` also makes that project's GDScript warning levels the ones the operations script is
compiled under, although the file lives in gdharness's own package and not in the project at all.
Godot's escape hatch does not reach it: `debug/gdscript/warnings/directory_rules` exempts paths
under `res://`, and this one is nowhere near. So a project that turns `unsafe_call_argument` or
`return_value_discarded` up to error stops compiling gdharness, and loses every headless operation
at once rather than the one it was using. The shipped GDScript is therefore written to survive
every warning this engine has at error level: nothing untyped handed to a typed parameter, nothing
answered and dropped. `test/engine-gdscript.ts` asks the engine for its own list of warnings rather
than keeping one, turns all of them up, empties `directory_rules` so the addons are held to it too,
and runs an operation from outside the project the way the server does.

Not everything under `debug/gdscript/warnings/` is a warning level, which is the part worth knowing
before writing anything that sets them. On 4.7.2 there are 52 settings there and 49 take a level:
`enable` and `renamed_in_godot_4_hint` are booleans and `directory_rules` is a dictionary of path to
level. A loop that reads the prefix and writes 2 to each writes a level over a boolean, and nothing
looks wrong afterwards because 2 is as true as true is. So the levels are picked out by the type the
engine registers rather than by a list of the three exceptions, which would go stale the way the
list of warnings did. `project_settings get` takes a `prefix` and answers with the type of each,
which is the call to make before deciding what a family holds.

Beyond that log, one of these boots leaves the project alone. A `--script` run performs no
filesystem scan and no import, so it writes nothing under `.godot`: a project that has only ever
been scripted still has an empty one, and a settled project's class cache, uid cache and extension
list come through a boot untouched. Measured across a settings read, a health walk, a class query
and a validation. So a read-only call beside a running game is a call that leaves it alone, and
`project_import refresh_classes` writes the class cache there because that is what it was asked to
do.

`project_import refresh_uids` is the exception to the paragraph above, because it is not a
`--script` run: it is `--import`, the engine's own pass over the project, which is the only thing
that mints a `.uid`. So it scans, it writes under `.godot`, and it writes a `.uid` beside each
script and shader that had none. What it does not write is any file that already exists: the pass
leaves every scene byte for byte as it was. That is worth stating rather than assuming, because the
op previously loaded every scene and resaved it instead, and a headless resave rebuilds the header
from what the engine could see, dropping `load_steps` and the scene's own `uid=` and so deleting
the very references the op exists to keep resolvable.

Every walk over a project directory stops at the same three things, whether the engine is doing
the walking or the server is reading the directory itself: a name spelled with a dot,
`node_modules`, and a directory holding a `.gdignore`. That is what the engine steps over, so
nothing under one is imported and what is in there is not a resource, not a dependency, not a
global class and not a search result. A vendored engine, an export directory and somebody else's
project kept for reference are the usual reasons to have one, and answering about their files
means naming things the engine will never load.
