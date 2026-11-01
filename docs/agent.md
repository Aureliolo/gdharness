# gdharness: install into a project

For an agent. Version `{{version}}`. MCP server plus four Godot addons.

## Refuse

- Starting a second Godot editor on a project that already has one. Each project has one server
  for its one editor, in its own session.
- Spawning an engine for anything a tool already does.
- Reporting provenance as verified when no check ran.

## 1. Requirements

```bash
godot --version   # >= 4.7.0
node --version    # >= 22, for npx; or bun --version >= 1.4, for bunx
```

You need one of the two runtimes. `setup` finds Godot itself. Set `GODOT_PATH` to the binary if it is
somewhere unusual.

## 2. Install

```bash
cd /absolute/path/to/project
npx -y gdharness@{{version}} setup
```

It installs the addons, enables the editor plugins and registers the runtime autoload. It also
rebuilds the class list, writes the skill and registers the server with the harnesses this project
already uses. It prints what it wrote and where. Anything it hands back as a command or a block to
paste is yours to apply.

Some harnesses want something from the reader after the file is written. That can be a folder to
trust, a server to trust, a toggle or a restart. `setup` prints that line under the harness it
applies to. Pass it on rather than reporting the install as finished. Until it is done, the config
is written and nothing answers.

### Outside the project

Nothing outside the project directory is written without a flag or an answered prompt. Run from
a pipe, as you are, it asks nothing. It writes the harnesses this project already uses and names
the rest. Do not pass a machine-wide harness's flag on the reader's behalf, since it changes every
other project they open with that harness. Report what it named and let them choose.

### The skill and the flags

It also writes `.agents/skills/gdharness/`, the operating contract for this server, in the format
your harness reads. The three harnesses that do not read the shared directory get a copy in
`.claude/skills`, `.kiro/skills` or `.cline/skills`. Read `SKILL.md` before your first tool call.

`gdharness help` lists every command's flags, and `gdharness harnesses` the harness flags. Three
matter here:

- `--no-connect` installs the addons and writes no config at all.
- `--no-skill` leaves the skill out.
- `--no-runtime` leaves the autoload out.

If this project generates its MCP config from a template, pass `--no-connect` and edit the
template instead.

### The config and the autoload

The config carries `GODOT_PATH` and `GDHARNESS_PROJECT`. No tool call takes its project from the
environment. A call that needs one names it in `projectPath`. A `godot://` resource read, which has
no arguments, uses `GDHARNESS_PROJECT`. Reconnect the harness, then confirm the tools are listed.

The runtime autoload names `res://gdharness/loader.gd`, which setup writes. It brings the runtime up
only in a debug build that has the addon. It does nothing in a clone without `addons/`, and a
release export leaves it out. Commit it with `project.godot` and leave it on. Without it,
`runtime_*` has nothing to talk to.

## 3. Verify

1. `editor_status` with nothing open: reports no editor, does not fail.
2. Open the project in the editor. `editor_status` shows `connected` true and `addonIsStale`
   false (when it is true, run `editor_launch restart`).
3. `project_info`: returns the project name and main scene.
4. `editor_run`, `editor_output`, `editor_run stop`.

## Updating

When there is a newer release, a tool answer carries an `update_available` block. It names the
version, its notes and the command. Tell the reader. Run the command only with their agreement,
because it replaces the addons in their project. Agreement is a yes when asked, or a standing
instruction of theirs to upgrade on every release.

```bash
npx -y gdharness@<new> upgrade
```

`upgrade` re-pins every config that already names gdharness and touches no config that does not.
Then reconnect the MCP server, and restart an open editor with `editor_launch restart` when the
`upgrade` output asks for it. Confirm with `editor_status`: `addonIsStale` false.
Skipping either step when it is needed leaves the old version answering. `addonVersion` stays at
the older number when the editor code did not change.

## Installing from the signed archive instead

For a pinned or offline install. The archive is the same bytes npm serves.

```bash
VERSION={{version}}
gh release download "v${VERSION}" --repo Aureliolo/gdharness
sha256sum -c "gdharness-${VERSION}.tgz.sha256"
gh attestation verify "gdharness-${VERSION}.tgz" --repo Aureliolo/gdharness \
  --bundle "gdharness-${VERSION}.intoto.jsonl" \
  --signer-workflow Aureliolo/gdharness/.github/workflows/release-build.yml \
  --source-ref "refs/tags/v${VERSION}" \
  --deny-self-hosted-runners
mkdir -p .tools/gdharness
tar -xzf "gdharness-${VERSION}.tgz" -C .tools/gdharness --strip-components=1
node .tools/gdharness/build/cli.js setup
```

If a check fails, stop. Do not unpack or run the archive. Without `gh`, `install.md` has the
`cosign` command and the browser lookup. If no check ran, say so rather than calling it verified.

## Rules

- Use `editor_run start` / `editor_output` / `editor_run stop`. The editor plays the game, so the
  `debug_*` tools can answer through its debugger.
- Breakpoints set before running hold for every start until `debug_breakpoint remove`, reconnects
  included. Each start answer lists them.
- Read `editor_output` after every run.
- Measure the running game: `runtime_inspect` for what is on screen, `runtime_invoke` for a value,
  `runtime_wait` instead of sleeping.
- A refusal names the state it is in and what changes it. Read it rather than retrying.

## When the runtime is not up yet

- A start says under `runtime` whether the `runtime_*` tools can talk to the game yet.
- When they cannot, read `mayYetAnnounce` before giving up. False is a runtime that is not coming,
  true a game still on its way up.
- `runtimeWaitMs` waits longer on a project that boots slowly. From the second start on, the server
  waits for a slow project unasked, because it notes how long each game took to announce.
- Until the game announces, a server set up for a project refuses a `runtime_*` call that names no
  `projectPath`. A server set up for none sends it to whichever game is announced, and the note
  says which.

## Paths through objects

- Colons in a property or method name reach through the objects a node holds, where a game keeps
  its state and logic. So `_game:clock:speed` reads or writes one and `_game:run:advance` calls one.
- A step written as a call, `get_viewport():gui_get_focus_owner`, walks into what a reading method
  returned. It is for the questions only a method answers.
- An engine method takes literal arguments in its brackets, as in
  `get_theme_constant("separation")`.

## Reference

- `tools.md`: every tool, op and argument.
- `architecture.md`: what an install writes, what connects to what, and every harness.

All at <https://aureliolo.github.io/gdharness>.
