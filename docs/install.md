# Install

Written for the agent doing the installing. Every step is a command with something to check
afterwards, so a step that half worked is one you find out about here rather than three tool calls
later. If you are a person reading this, the same steps work by hand.

## What you are installing

A dependency-free archive from the project's own releases, built and signed by its CI. It carries
the MCP server, a CLI, and the three Godot addons that go into the project being worked on. It
contacts no registry at install time and nothing is downloaded from anywhere else.

## 1. Check what is already here

```bash
godot --version          # 4.7 or newer; note the absolute path to the binary
bun --version            # any recent Bun; the server runs on it
```

If Godot is not on `PATH`, that is fine: find the binary and keep the absolute path, since the
server is told where it is rather than searching. If Bun is missing, install it from
[bun.sh](https://bun.sh) before going on. Do not substitute Node: the release is built and tested
against Bun.

## 2. Get a release, and verify it before running it

Pick the latest version from
[the releases page](https://github.com/Aureliolo/gdharness/releases), then, with `gh` installed
and authenticated:

```bash
VERSION=X.Y.Z
gh release download "v${VERSION}" --repo Aureliolo/gdharness
sha256sum -c "gdharness-${VERSION}.tgz.sha256"
gh attestation verify "gdharness-${VERSION}.tgz" --repo Aureliolo/gdharness \
  --bundle "gdharness-${VERSION}.intoto.jsonl" \
  --signer-workflow Aureliolo/gdharness/.github/workflows/release-build.yml \
  --source-ref "refs/tags/v${VERSION}" \
  --deny-self-hosted-runners
```

The checksum proves the bytes match what the release lists. The attestation proves GitHub Actions
built those bytes from this repository, by the steps in `release-build.yml`, at that tag, on a
GitHub-hosted runner. A checksum on its own cannot tell you that: one generated beside a tampered
archive agrees with it perfectly. **If either check fails, stop and say so.** Do not fall back to
downloading without verification, and do not carry on with the archive you have.

Then unpack it somewhere the project can reach, for example `.tools/gdharness`:

```bash
mkdir -p .tools/gdharness
tar -xzf "gdharness-${VERSION}.tgz" -C .tools/gdharness --strip-components=1
bun .tools/gdharness/build/cli.js version    # should print the version you downloaded
```

## 3. Tell your MCP client about it

The server speaks stdio. Every client spells this the same way; the file it goes in differs. For
Claude Code, `.mcp.json` at the root of the project:

```json
{
  "mcpServers": {
    "gdharness": {
      "command": "/absolute/path/to/bun",
      "args": ["/absolute/path/to/.tools/gdharness/build/index.js"],
      "env": { "GODOT_PATH": "/absolute/path/to/godot" }
    }
  }
}
```

**Absolute paths, all three.** A client does not expand `${...}` when it spawns a server, and it
does not always inherit the `PATH` you have in a shell: a relative path or a bare `bun` fails
silently, or worse, resolves to something else. `GODOT_PATH` is the only thing the server reads
from the environment; everything else about a project arrives in the tool call.

If the project keeps this file generated rather than committed, write the template instead and
regenerate. Reconnect the server afterwards, or restart the client, and confirm the tools are
listed before going on.

## 4. Put the addons in the project

```bash
bun .tools/gdharness/build/cli.js setup /absolute/path/to/project
bun .tools/gdharness/build/cli.js doctor /absolute/path/to/project
```

`setup` installs `gdharness_editor` and `auto_reload`, enables both in `project.godot`, and
rebuilds the class list. `doctor` then says whether the addons are the ones this version ships,
whether the plugins are on, whether the runtime autoload is registered, and whether the class cache
lists every `class_name` on disk. It exits 1 on a problem, so a green `doctor` is the check for
this step.

The third addon, `gdharness_runtime`, is an autoload, and autoloads reach an exported build. Turn
it on only while working:

```bash
bun .tools/gdharness/build/cli.js runtime on  /absolute/path/to/project
bun .tools/gdharness/build/cli.js runtime off /absolute/path/to/project
```

It refuses to serve outside a debug build, so an export that ships with it on is not a server on a
player's machine; it is a broken autoload if the addon was excluded from the export. Off before
committing is the habit worth having, and a test that fails the commit while it is on is worth
writing.

## 5. Prove it works

Ask the server, not the filesystem:

- `editor_status` says whether an editor has reached the bridge, which Godot answers, and whether a
  game with the runtime addon is reachable. Run it first, with nothing open: it should report no
  editor rather than fail.
- Open the project in the Godot editor. `editor_status` should now report the editor connected and
  the addon version matching the server's.
- `project_info` with the project path should answer with the project's name and main scene.
- `editor_run` then `editor_output` then `editor_stop` should start the game, hand back what it
  printed, and stop it.

If `editor_status` shows the bridge unavailable with a port conflict, another gdharness is already
holding it. There should only be one.

## 6. What to tell the person who asked

Once it is working, these are the conventions that make the difference between a harness that helps
and one that quietly misleads. Recommend them:

- **One editor.** The editor's language server and debug adapter are single-holder ports. A second
  editor, headless or otherwise, takes them from the first, which then gives up without retrying,
  and answers start coming from a process nobody can see.
- **Never start Godot by hand.** `editor_run` plays the game through the editor that is already
  open, which is what gives the game a debugger session and leaves nothing behind. A hand-started
  engine outlives the session that started it.
- **After writing a `class_name`, rebuild the class list** with `project_import refresh_classes`
  before running the game. Godot's own list is fixed at editor startup and refreshed only by a
  filesystem scan, so a game started from a stale editor cannot resolve a class written since.
- **Look at the running game before forming an opinion about it.** `runtime_inspect` for what is on
  screen and where, `runtime_invoke` for a real value. A green test tier is not evidence that the
  interface does what you think.
- **Read what `editor_output` says.** It reports the engine's errors and warnings as entries with
  their backtraces and answers with a verdict, so a run that printed an error is one call away from
  being known.

[Traps](traps.html) is the longer version of that list, and worth reading once before the first
real change.
