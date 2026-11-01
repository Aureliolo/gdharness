# Install

## Requirements

| What         | Version                                                    |
| ------------ | ---------------------------------------------------------- |
| Godot        | 4.7.0 or newer                                             |
| Node, or Bun | Node 22 or newer for `npx`, or Bun 1.4 or newer for `bunx` |

You need one of the two runtimes. `npx` ships with Node and `bunx` with Bun. The server runs under
either.

`setup` finds Godot itself, in the usual install locations. Set `GODOT_PATH` to the binary if yours
is somewhere else. Then `setup` writes that path into the config it generates. Without either,
`upgrade` and the other commands use the engine the project's own config names. In a git worktree
with no config of its own, they use the one the main checkout's config names.

## Hand it to your agent

```text hand this to an agent
Install gdharness here by following https://aureliolo.github.io/gdharness/agent.md,
then tell me what it asked you to recommend back to me.
```

The agent reads [agent.md](agent.md) and runs the one command below. It answers the questions the
command asks from what it finds in the project, then comes back with what it chose and why.

## Or one command yourself

```bash from the project directory
npx -y gdharness@{{version}} setup
```

That installs the addons, enables the editor plugins and registers the runtime autoload. It also
rebuilds the class list, writes the gdharness skill and registers the server with your harnesses.

Then reconnect the harness so it spawns the server. Check that `editor_status` answers.

## It asks

Run at a terminal with no harness named, it asks about each one it finds. It writes nothing you
did not answer for:

```text
Claude Code is set up here. Add gdharness to it? [Y/n]
Cursor is installed. Set it up for this project? [Y/n]
Codex CLI is on this machine and has no project-level config.
Write ~/.codex/config.toml? That affects every project. [y/N]
```

Name harnesses by flag and it asks nothing. That is how a script or an agent runs it. With no
terminal and no flags, it writes the harnesses this project already uses and names the rest.

```bash
# exactly these two, no questions
npx -y gdharness@{{version}} setup --cursor --vscode

# yes, write the machine-wide one
npx -y gdharness@{{version}} setup --codex

# no questions, and nothing outside the project
npx -y gdharness@{{version}} setup --yes

# the addons only, no configuration at all
npx -y gdharness@{{version}} setup --no-connect
```

## What it writes, and where

Nothing outside the project directory is written without a flag or a typed yes. {{home-count}} of the
{{harness-count}} have no project-level config at all. For those, a yes writes the machine-wide
file, because they read no other.

```text
Claude Code, Copilot CLI, Qoder, Command Code: written /home/you/game/.mcp.json
skill: written /home/you/game/.agents/skills/gdharness
skill: written /home/you/game/.claude/skills/gdharness
```

{{mcp-json-count}} harnesses read the same `.mcp.json`. `setup` writes it once and names all of
them on one line. The skill goes to `.agents/skills/`, which {{shared-skill-count}} of them read.
Each of the {{own-skill-count}} that do not gets a copy in its own directory. `--no-skill` leaves it
out.

[How it works](architecture.html) has every harness, its file and what `setup` decides.

## The config entry

The entry is the same everywhere:

```jsonc the server, as most harnesses spell it
{
  "mcpServers": {
    "gdharness": {
      "command": "npx",
      "args": ["-y", "gdharness@{{version}}"],
      "env": {
        "GODOT_PATH": "/path/to/godot",
        "GDHARNESS_PROJECT": "/path/to/project",
      },
    },
  },
}
```

The version is pinned rather than `latest`, because the server and the addons it installed have to
match. With `latest` they drift apart. The `editor_status` tool reports that as `addonIsStale`.

`GDHARNESS_PROJECT` is which project this server was set up for. The server writes the editor
bridge's port into that project, so the editor finds the server on any port. That lets two projects
be open at once, as [how it works](architecture.html#connections) explains. Without it, as in a
config written by hand, the server waits for its configured port, 6505 unless
`GDHARNESS_BRIDGE_PORT` names another.

Every tool call still carries its own `projectPath`. No call takes its project from the
environment.

An existing config keeps everything already in it, including other servers. One that does not
parse is refused rather than replaced.

## Committing what it installed

The four addons land in `addons/`. Commit them like any other Godot addon, so everybody on the team
runs the same version.

Two of them, `gdharness_editor` and `auto_reload`, are also named in `project.godot`'s
`editor_plugins/enabled`, which almost every project commits.

Commit the addons with `project.godot`. A clone with the plugin entries and no addons still opens.
The editor prints `Addon ... failed to load. No directory found` once per missing addon and leaves
`project.godot` alone.

Commit the `.uid` file beside each script too. Without it, each clone's editor generates its own
uid.

### If your project ignores the addons

Package-manager add-ons like [godam](https://github.com/nilsiker/godam) and
[GLAM](https://github.com/henriquelalves/glam) expect `addons/` to be in `.gitignore`. Then keep the
version somewhere committed and install from it instead. Each addon records its own at
`addons/<name>/.gdharness-version`, which is what `gdharness doctor` reads.

### The loader in a clone

A clone or CI runner without `addons/` boots cleanly. The runtime entry names
`res://gdharness/loader.gd`, which does nothing until the addon is there. Commit the loader with
`project.godot`, as [the runtime autoload](#the-runtime-autoload) explains.

To check, `gdharness doctor` asks git which of the files your autoloads name are in the index,
since those are what a clone gets. A file nobody added is a problem that fails `setup` and `doctor`.
A file your `.gitignore` matches is named on a line of its own and is not a problem. Ignoring it
says your own install step puts it there before `setup` runs. Outside a repository, or with no git
on the machine, it says nothing rather than guessing.

## Check it works

| Call                                      | Expected                                                   |
| ----------------------------------------- | ---------------------------------------------------------- |
| `editor_status`, nothing open             | Reports no editor. Does not fail.                          |
| `editor_status`, editor open              | `connected` true, `addonVersion` equal to `serverVersion`. |
| `project_info`                            | The project name and main scene.                           |
| `editor_run` start, `editor_output`, stop | The game starts, its console comes back, it stops.         |

`gdharness doctor` checks the install, names each problem, and exits 1 if there is one.

## Silent windowed runs

A windowed game this server starts makes no sound. It is started with `--audio-driver Dummy`, as is
an editor `editor_launch` opens. On Windows it also goes on a desktop of its own, out of sight.
Headless runs and test runs are silent already. `silent: false` on `editor_run` start or on
`editor_launch` asks for sound.

The editor takes no engine flags for a game it plays. So the server starts a silent windowed run
itself and holds it in its own debugger. The `debug_*` tools answer for that run as for one the
editor plays. With `silent: false` the editor plays it, with sound.

## The pointer on the game's desktop

On the game's own desktop, Windows refuses to say where the pointer is. It answers only for the
desktop in use.

Injected pointer input still reaches the controls under it, their hover and tooltips, and the
game's input handlers. `get_mouse_position()` on the root window reads a meaningless position, as do
the positions derived from it. The engine asks Windows and does not check the refusal. For a game
on that desktop, the pointer answers from `runtime_input` say so under `pointer_note`.

## The window station

The game's desktop is in the logon session's non-interactive window station. There a game's
`ClipCursor` and `SetCursorPos` cannot move the pointer in use. The station has no compositor, so
`DwmIsCompositionEnabled` answers false.

A layered window (`WS_EX_LAYERED`, as a click-through overlay makes) takes
`SetLayeredWindowAttributes` once. After the window has been hidden and shown again, the call fails
with `ERROR_GEN_FAILURE` (31). A game that makes its window layered can tell it is on that desktop
by that answer, or by `GDHARNESS_DESKTOP`. Then it can leave the window plain. `GDHARNESS_DESKTOP`
names the desktop to every process started on it.

## Waits you can set

`editor_launch restart` waits ninety seconds for the old editor to close and ninety more for the new
one to connect. A project whose import takes longer sets `GDHARNESS_EDITOR_RESTART_TIMEOUT_MS` in
the server's environment.

The editor's language server reads every script in the project before it answers the first request
after the editor starts. The server waits three minutes for that. A project whose language server
reads for longer sets `GDHARNESS_LSP_INITIALIZE_TIMEOUT_MS`.

Three shorter waits can be set the same way, in milliseconds:

- `GDHARNESS_SCAN_WAIT_MS` (30 seconds): how long a start waits for the editor to finish scanning.
  After it, the start goes ahead and says so.
- `GDHARNESS_STOP_WAIT_MS` (10 seconds): how long a stop waits for what it ended to be gone. After
  it, the stop answers that it is still running.
- `GDHARNESS_GREETING_WAIT_MS` (10 seconds): how long a restart waits for a newly connected editor
  to say who it is.

## Debug output

`GDHARNESS_DEBUG=1` writes the server's debug lines to stderr, where your harness's MCP log keeps
them. It also runs headless engines with `--debug-godot`.

## Updating

While it is in use, the server asks the npm registry for a newer release every ten minutes in the
background. It also asks once when it starts. When there is one, it tells your agent. Each check is
one request to one host and carries nothing about you or the project.

`GDHARNESS_NO_UPDATE_CHECK=1` in the server's environment stops the check.
`GDHARNESS_REGISTRY=https://your.mirror` asks somewhere else instead, https only.

```bash
npx -y gdharness@<new> upgrade
```

`upgrade` asks nothing. It reinstalls the addons at the new version and re-pins every config that
already names gdharness. It touches no config that does not.

## After the upgrade

The old version keeps answering until you do two more things:

1. Reconnect the MCP server so the harness re-spawns it. In Claude Code, run `/mcp` and reconnect,
   with no need to restart the harness.
2. If `upgrade` says the editor addons changed, restart an open editor with
   `editor_launch restart`. It takes about seven seconds.

An editor gdharness opened comes back visible, on Windows without taking the focus. Given
`hidden: true`, the restart brings it back headless and out of sight. A headless editor you started
by hand cannot be restarted this way. Start it again by hand.

The `editor_status` tool confirms with `addonIsStale` false. `addonVersion` stays at the older
number when the upgrade left the editor code unchanged. Staleness is decided by the code the editor
loaded, not by the version number on it.

## Worktrees

An upgrade of the main checkout does not reach the untracked `addons/` of a git worktree. `upgrade`
names each worktree whose addons are on another version, with the command to run there. It does not
upgrade them itself.

## The rest of the CLI

| Command              | What it does                                                       |
| -------------------- | ------------------------------------------------------------------ |
| `setup`              | Addons in, editor plugins on, class list rebuilt                   |
| `setup --no-connect` | The same, and no harness configuration written                     |
| `upgrade`            | Reinstalls the addons and re-pins configs at this version          |
| `uninstall`          | Removes everything setup wrote                                     |
| `doctor`             | Checks the install and names each problem. Exits 1 if there is one |
| `classes`            | Rebuilds the class cache from disk                                 |
| `runtime on` / `off` | Registers the runtime autoload, or takes it out again              |
| `harnesses`          | Every harness, its flag and the file it reads                      |

Each of these except `harnesses` takes the project directory as its argument. It defaults to the one
you are in. The directory must hold a `project.godot`. An unknown flag stops the command before it
does anything. `gdharness help` lists each command's flags.

### Addon versions

`setup` copies each addon whole and writes the version beside it. That lets `doctor` tell an old
copy from the shipped one. An editor that was already open keeps serving the addon it loaded at
startup until it is restarted.

## Uninstalling

```bash
gdharness uninstall
```

It removes the addons, the editor plugin entries, the runtime autoload and the skill. It also
removes gdharness's own entry from every config it can parse. Other servers' entries stay. A file
left with nothing in it is deleted, as is an `.agents/skills` directory setup created. A harness's
own directory stays, even when empty.

A machine-wide config may be serving another project, so it is named rather than edited:

```text
Codex CLI: left alone. Its config is machine-wide and may serve
another project; pass --codex to remove it.
```

Writes to `project.godot` go through the engine, so the file is written the way the editor writes
it. A comment you added by hand is dropped. The file gets Godot's own header back, as on any save of
the project settings.

## The runtime autoload

`setup` registers it, because without it the `runtime_*` tools have nothing to talk to. Each
project gets its own copy of the addon and its own entry. `--no-runtime` leaves it out.

```bash
gdharness runtime on
gdharness runtime off
```

### The loader

The entry names `res://gdharness/loader.gd`, a loader `setup` writes outside `addons/` so that it
is committed with `project.godot`. The loader brings the runtime up as a child of its own node,
only in a debug build that has the addon. Anywhere else it does nothing. A release export leaves it
out, as [Exports](#exports) says. The runtime itself also refuses to serve outside a debug build.

The runtime comes up before the main scene's `_ready`, so a scene that does its work there can be
reached while it does. `gdharness doctor` says when the loader differs from the one this gdharness
ships. Then `setup` and `upgrade` write it again.

### Entries that name something else

An entry naming the addon's own script fails in a build without `addons/`, so `setup`, `upgrade`
and `runtime on` point it at the loader.

An entry naming a loader of your own is left where you put it. Each of those commands says so and
says how to use the shipped one instead. Take your entry out of `[autoload]`, delete your loader
and run `gdharness runtime on`.

### Script runs

Autoloads come up for `godot -s` too, which is how a test tier and most batch tools are run. The
runtime refuses to serve those as well, since a script run has no game in it to answer about. Set
`gdharness/runtime/serve_script_runs` to true in `project.godot` to drive a `-s` script on purpose.

The loader's node, `/root/GdharnessRuntime`, exists in every engine, script runs included. Its
presence does not mean gdharness can reach the game. A test that
needs to know asks `get_node("/root/GdharnessRuntime").serving()`. It is true only while the
runtime under it is listening.

### Exports

A release export leaves gdharness out while the editor addon is enabled. The autoload entry is
taken out of the exported settings. The `gdharness/` folder, the runtime and the editor addons are
not exported, so no player's build carries them and `/root/GdharnessRuntime` is not there. Game
code that ships reaches it only by path, as with `get_node_or_null`.

A debug export keeps all of it and leaves `project.godot` as it was. The loader's own top-level
folder, `gdharness/`, goes into a debug export. A check that refuses unexpected top-level folders in
a debug pack has to allow that one.

### Scenes that are not the game

A scene that is not the game, such as a bench, is served like the game unless you list its folder
in `gdharness/runtime/quiet_scenes_under`, for example `PackedStringArray("res://tests/")`. A run
started on a scene there neither serves nor announces, and nor do the engines it starts. A run
profiled from its start is served anyway.

## Installing from the signed archive

For a pinned or offline install, and for anything that verifies its own supply chain. The archive
on the release is the same bytes npm serves, so either source verifies against the same
attestation.

```bash download and verify
VERSION={{version}}
gh release download "v${VERSION}" --repo Aureliolo/gdharness
sha256sum -c "gdharness-${VERSION}.tgz.sha256"
gh attestation verify "gdharness-${VERSION}.tgz" --repo Aureliolo/gdharness \
  --bundle "gdharness-${VERSION}.intoto.jsonl" \
  --signer-workflow Aureliolo/gdharness/.github/workflows/release-build.yml \
  --source-ref "refs/tags/v${VERSION}" \
  --deny-self-hosted-runners
```

Without `gh`, with `cosign` instead:

```bash verify with cosign
IDENTITY="https://github.com/Aureliolo/gdharness"
IDENTITY="$IDENTITY/.github/workflows/release-build.yml@refs/tags/v${VERSION}"

cosign verify-blob-attestation "gdharness-${VERSION}.tgz" \
  --bundle "gdharness-${VERSION}.intoto.jsonl" \
  --new-bundle-format \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity "$IDENTITY"
```

With neither, hash the file and look the digest up in a browser at
[github.com/Aureliolo/gdharness/attestations](https://github.com/Aureliolo/gdharness/attestations).
That needs nothing installed. It trusts GitHub over TLS rather than verifying a signature, so it is
weaker than either command above.

macOS: `shasum -a 256 -c`. PowerShell: `Get-FileHash gdharness-$VERSION.tgz -Algorithm SHA256`.

If a check fails, do not install the archive. Otherwise unpack and run it from where it landed:

```bash
mkdir -p .tools/gdharness
tar -xzf "gdharness-${VERSION}.tgz" -C .tools/gdharness --strip-components=1
node .tools/gdharness/build/cli.js setup /path/to/project
```
