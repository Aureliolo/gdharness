# Install

## Requirements

|       |                                                        |
| ----- | ------------------------------------------------------ |
| Godot | 4.7.0 or newer. Keep the absolute path to the binary.  |
| Node  | 22 or newer, for `npx`. Bun 1.4.0 or newer also works. |

Godot does not have to be on `PATH`.

## One command

```bash from the project directory
npx -y gdharness@{{version}} setup . --runtime
```

That installs the addons, enables the editor plugins, registers the runtime autoload, rebuilds
the class list, and writes the server into every agent harness it finds on this machine.

Then reconnect the harness so it spawns the server, and check `editor_status` answers.

## What it writes, and where

Detected harnesses are written to. Name them instead to pick:

```bash
npx -y gdharness@{{version}} setup . --cursor --vscode
npx -y gdharness@{{version}} setup . --no-connect    # addons only
```

{{harnesses}}

A `project` scope writes inside the project, which is right for gdharness: the entry carries this
project's Godot path. A `home` scope harness has no per-project config, so its entry is global and
the Godot path in it is the one from the machine that ran `setup`.

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

## The runtime autoload

It is an autoload, so an export ships it unless it is removed. It refuses to serve outside a debug
build, so it is not a server on a player's machine, but leave it off in anything you ship.

```bash
gdharness runtime on  /path/to/project
gdharness runtime off /path/to/project
```

Without it the `runtime_*` tools have nothing to talk to.

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

## Conventions to recommend

- After writing a `class_name`, call `project_import refresh_classes` before running the game.
- Use `editor_run` rather than starting an engine. A game started as its own process has no
  debugger session.
- Set breakpoints before running. They register on the adapter, not on a session.
- Read `editor_output` after a run: entries with backtraces and a `clean` verdict.
- Measure the running game with `runtime_inspect` and `runtime_invoke` rather than reasoning from
  the source.
- One editor at a time. 6005 and 6006 hold one client each.

[Traps](traps.html) is the rest of what is worth knowing before the first change.
