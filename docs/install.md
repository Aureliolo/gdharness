# Install

## Requirements

|       |                                                        |
| ----- | ------------------------------------------------------ |
| Godot | 4.7.0 or newer. Keep the absolute path to the binary.  |
| Node  | 22 or newer, for `npx`. Bun 1.4.0 or newer also works. |

Godot does not have to be on `PATH`.

## One command

```bash from the project directory
npx -y gdharness@{{version}} setup .
```

That installs the addons, enables the editor plugins, registers the runtime autoload, rebuilds the
class list, writes the gdharness skill, and registers the server with your harnesses.

Then reconnect the harness so it spawns the server, and check `editor_status` answers.

## It asks

Run at a terminal with no harness named, it asks about each one it finds, and writes nothing you
did not answer for:

```text
Claude Code is set up here. Add gdharness to it? [Y/n]
Cursor is installed. Set it up for this project? [Y/n]
Codex CLI is on this machine and has no project-level config. Write ~/.codex/config.toml?
That affects every project you open with it. [y/N]
```

Name harnesses by flag and it asks nothing, which is how a script or an agent runs it. With no
terminal and no flags, it writes the harnesses this project already uses and names the rest, so it
can never hang waiting for an answer nobody can give.

```bash
npx -y gdharness@{{version}} setup . --cursor --vscode # exactly these two, no questions
npx -y gdharness@{{version}} setup . --codex           # yes, write the machine-wide one
npx -y gdharness@{{version}} setup . --yes             # no questions, no machine-wide writes
npx -y gdharness@{{version}} setup . --no-connect      # addons only, no configuration at all
```

## What it writes, and where

**Nothing outside the project directory without a flag or a typed yes.** Eight of the harnesses
below have no project-level config at all, and for those a yes writes the machine-wide file,
because that is their limitation rather than a choice we can make better.

```text
Claude Code, Copilot CLI, Qoder, Command Code: written /home/you/game/.mcp.json
skill: written /home/you/game/.agents/skills/gdharness
skill: written /home/you/game/.claude/skills/gdharness
```

Four harnesses read the same `.mcp.json`, so it is written once and all four are named.

## The skill

`setup` writes `.agents/skills/gdharness/`, which is the cross-tool skills convention: Codex looks
nowhere else, and Cursor, VS Code, Copilot, Gemini CLI, opencode, Junie, Windsurf and Hermes all
read it too. Claude Code, Kiro and Cline do not, so they get a copy in their own directory when
they are one of the harnesses being set up.

It holds the five Godot behaviours that cost the most time, how to drive a running game, and a
generated reference for every tool. Without it each agent rediscovers them by hitting them.
`--no-skill` leaves it out.

{{harnesses}}

The entry is the same everywhere:

```jsonc the server, as most harnesses spell it
{
  "mcpServers": {
    "gdharness": {
      "command": "npx",
      "args": ["-y", "gdharness@{{version}}"],
      "env": { "GODOT_PATH": "/path/to/godot" },
    },
  },
}
```

The version is pinned rather than `latest`. The server and the addons it installed have to match,
and `latest` is how they drift apart: `editor_status` reports that as `addonIsStale`.

`GODOT_PATH` is the only environment variable read. Every tool call carries its own `projectPath`.

An existing config keeps everything already in it, including other servers. One that does not
parse is refused rather than replaced.

## Check it works

| Call                                      | Expected                                                   |
| ----------------------------------------- | ---------------------------------------------------------- |
| `editor_status`, nothing open             | Reports no editor. Does not fail.                          |
| `editor_status`, editor open              | `connected` true, `addonVersion` equal to `serverVersion`. |
| `project_info`                            | The project name and main scene.                           |
| `editor_run` start, `editor_output`, stop | The game starts, its console comes back, it stops.         |

`gdharness doctor .` exits 1 on any problem and names it.

## Updating

```bash
npx -y gdharness@<new> setup .
```

It rewrites the addons and the harness entries to the new version together. Then two things that
are easy to miss, because the old version keeps answering until they are done:

1. Reconnect the MCP server so the harness re-spawns it. In Claude Code, `/mcp` and reconnect.
   Restarting the harness is not required.
2. Restart an open editor: `editor_launch restart`, about seven seconds. A headless editor cannot
   be restarted and has to be started again by hand.

`editor_status` confirms: `addonVersion` equal to `serverVersion`, `addonIsStale` false.

## The rest of the CLI

```bash
gdharness setup /path/to/project              # addons in, editor ones enabled, class list rebuilt
gdharness setup /path/to/project --no-connect # and write no harness configuration
gdharness uninstall /path/to/project          # take all of it back out again
gdharness doctor /path/to/project             # exits 1 on a problem and names it
gdharness classes /path/to/project            # rebuild the class cache from disk
gdharness harnesses                           # every harness, its flag and the file it reads
```

`setup` copies each addon whole and writes the version beside it, so `doctor` can tell an old copy
from the shipped one. An editor that was already open keeps serving the addon it loaded at startup
until it is restarted.

## Uninstalling

```bash
gdharness uninstall /path/to/project
```

The addons, the editor plugin entries, the runtime autoload, the skill, and gdharness's own entry
in every config it can parse. Other servers in those files keep their entries and the file stays; a
file that held nothing but gdharness goes with it, and so does the `.agents/skills` directory it
created. A harness's own directory is left alone, empty or not, because it is theirs.

A machine-wide config may be serving another project, so it is named rather than edited:

```text
Codex CLI: left alone. Its config is machine-wide and may serve another project; pass --codex to remove it.
```

Writes to `project.godot` go through the engine, so the file keeps its comments and formatting.

## The runtime autoload

`setup` registers it, because without it the `runtime_*` tools have nothing to talk to. Like
everything else `setup` installs it belongs to that project alone: its own copy of the addon, its
own entry in that project's `project.godot`. Twenty Godot projects means twenty independent
installs, each pinned to its own version and its own engine. `--no-runtime` leaves it out.

It is an autoload, so an export ships it unless it is removed. It refuses to serve outside a debug
build, so it is not a server on a player's machine, but turn it off before you ship.

```bash
gdharness runtime on  /path/to/project
gdharness runtime off /path/to/project
```

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
cosign verify-blob-attestation "gdharness-${VERSION}.tgz" \
  --bundle "gdharness-${VERSION}.intoto.jsonl" \
  --new-bundle-format \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity "https://github.com/Aureliolo/gdharness/.github/workflows/release-build.yml@refs/tags/v${VERSION}"
```

With neither, hash the file and look the digest up in a browser at
[github.com/Aureliolo/gdharness/attestations](https://github.com/Aureliolo/gdharness/attestations).
That needs nothing installed, and it trusts GitHub over TLS rather than verifying a signature,
which is weaker than either command above.

macOS: `shasum -a 256 -c`. PowerShell: `Get-FileHash gdharness-$VERSION.tgz -Algorithm SHA256`.

**A failed check means stop.** Then unpack and run it from where it landed:

```bash
mkdir -p .tools/gdharness
tar -xzf "gdharness-${VERSION}.tgz" -C .tools/gdharness --strip-components=1
node .tools/gdharness/build/cli.js setup /path/to/project
```

## Before the first change

Two things cost the most time if nobody tells your agent: call `project_import refresh_classes`
after writing a `class_name` and before running the game, and use `editor_run` rather than starting
an engine, because a game started as its own process has no debugger session.

[Traps](traps.html) is the rest, and `agent.md` is the same list written for an agent to follow.
