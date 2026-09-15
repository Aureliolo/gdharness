# gdharness: install into a project

For an agent. Version `{{version}}`. MCP server plus three Godot addons.

## Refuse

- Starting a second Godot editor on a project that already has one. One server serves one editor;
  another project wants its own server, which is its own session.
- Spawning an engine for anything a tool already does.
- Reporting provenance as verified when no check ran.

## 1. Requirements

```bash
godot --version   # >= 4.7.0
node --version    # >= 22, for npx; or bun --version >= 1.4, for bunx
```

Either runtime, not both. `setup` finds Godot itself; set `GODOT_PATH` to the binary if it is
somewhere unusual.

## 2. Install

```bash
cd /absolute/path/to/project
npx -y gdharness@{{version}} setup
```

It installs the addons, enables the editor plugins, registers the runtime autoload, rebuilds the
class list, writes the skill, and registers the server with the harnesses already set up in this
project. It prints what it wrote and where. Anything it hands back as a command or a block to
paste is yours to apply.

Some harnesses want something from the reader after the file is written: a folder to trust, a
server to trust, a toggle, a restart. `setup` prints that line under the harness it applies to.
Pass it on rather than reporting the install as finished, because until it is done the config is
written and nothing answers.

**It writes nothing outside the project directory without a flag or an answered prompt.** Run from
a pipe, as you are, it asks nothing: it writes the harnesses this project already uses and names
the rest. Do not pass a machine-wide harness's flag on the reader's behalf, because it changes
every other project they open with that harness. Report what it named and let them choose.

It also writes `.agents/skills/gdharness/`, the operating contract for this server in the format
your harness reads, plus a copy in `.claude/skills`, `.kiro/skills` or `.cline/skills` for the
three that do not read the shared directory. Read `SKILL.md` before your first tool call.

`gdharness harnesses` lists every flag. `--no-connect` installs the addons and writes no config at
all; `--no-skill` leaves the skill out; `--no-runtime` leaves the autoload out.

If this project generates its MCP config from a template, pass `--no-connect` and edit the
template instead.

The config carries `GODOT_PATH` and `GDHARNESS_PROJECT`, and nothing else is read from the
environment. Every tool call carries its own `projectPath`. Reconnect the harness, then confirm the
tools are listed.

The runtime addon is an autoload and reaches an export. Turn it off before committing:

```bash
npx -y gdharness@{{version}} runtime off
```

Without it, `runtime_*` has nothing to talk to.

## 3. Verify

1. `editor_status` with nothing open: reports no editor, does not fail.
2. Open the project in the editor. `editor_status`: `connected` true, `addonVersion` equal to
   `serverVersion`. If `addonIsStale`, run `editor_launch restart`.
3. `project_info`: returns the project name and main scene.
4. `editor_run`, `editor_output`, `editor_run stop`.

## Updating

The server tells you when there is a newer release: a tool answer carries an `update_available`
block naming the version, its notes and the command. Tell the reader, and run it only if they
agree, because it restarts their editor.

```bash
npx -y gdharness@<new> upgrade
```

`upgrade` re-pins every config that already names gdharness and touches no config that does not.
Then reconnect the MCP server, and restart an open editor with `editor_launch restart`. Confirm
with `editor_status`: `addonVersion` equal to `serverVersion`, `addonIsStale` false. Skipping
either leaves the old version answering.

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

A failed check stops the install. Without `gh`, `install.md` has the `cosign` command and the
browser lookup. If no check ran, say so rather than calling it verified.

## Rules

- Use `editor_run start` / `editor_output` / `editor_run stop`. The editor plays the game, so its
  debugger holds it, which is what the `debug_*` tools answer for.
- Set breakpoints before running. They are waiting when it starts.
- Read `editor_output` after every run.
- Measure the running game: `runtime_inspect` for what is on screen, `runtime_invoke` for a value,
  `runtime_wait` instead of sleeping.
- Colons in a property or method name reach through the objects a node holds, `_game:clock:speed`
  to read or write one and `_game:run:advance` to call one, which is where a game keeps its state
  and most of what it does.
- A refusal names the state it is in and what changes it. Read it rather than retrying.

## Reference

- `tools.md`: every tool, op and argument.
- `architecture.md`: what an install writes, what connects to what, and every harness.

All at <https://aureliolo.github.io/gdharness>.
