# Install

## Requirements

|       |                                                       |
| ----- | ----------------------------------------------------- |
| Godot | 4.7.0 or newer. Keep the absolute path to the binary. |
| Bun   | 1.4.0 or newer.                                       |

Neither has to be on `PATH`. Node is not supported.

## 1. Download and verify

Two checks. The checksum proves the bytes match the release. The attestation proves GitHub Actions
built them from this repository at that tag on a hosted runner.

With [`gh`](https://cli.github.com), authenticated:

```bash verify with gh
VERSION={{version}}
gh release download "v${VERSION}" --repo Aureliolo/gdharness
sha256sum -c "gdharness-${VERSION}.tgz.sha256"
gh attestation verify "gdharness-${VERSION}.tgz" --repo Aureliolo/gdharness \
  --bundle "gdharness-${VERSION}.intoto.jsonl" \
  --signer-workflow Aureliolo/gdharness/.github/workflows/release-build.yml \
  --source-ref "refs/tags/v${VERSION}" \
  --deny-self-hosted-runners
```

Without `gh`:

```bash download and check the checksum
VERSION={{version}}
BASE="https://github.com/Aureliolo/gdharness/releases/download/v${VERSION}"
curl -fsSLO "${BASE}/gdharness-${VERSION}.tgz"
curl -fsSLO "${BASE}/gdharness-${VERSION}.tgz.sha256"
sha256sum -c "gdharness-${VERSION}.tgz.sha256"
```

macOS: `shasum -a 256 -c`. PowerShell: `Get-FileHash gdharness-$VERSION.tgz -Algorithm SHA256`.

The attestation needs a tool. Either install `gh` and run the command above, or verify the
`.intoto.jsonl` bundle with [Sigstore tooling](https://docs.sigstore.dev/cosign/verifying/verify/)
against:

- identity `https://github.com/Aureliolo/gdharness/.github/workflows/release-build.yml@refs/tags/v${VERSION}`
- issuer `https://token.actions.githubusercontent.com`

A failed check means stop.

## 2. Unpack

```bash
mkdir -p .tools/gdharness
tar -xzf "gdharness-${VERSION}.tgz" -C .tools/gdharness --strip-components=1
bun .tools/gdharness/build/cli.js version
```

## 3. Configure the MCP client

One stdio server. Absolute paths for all three values: clients do not expand `${...}` and do not
reliably inherit `PATH`.

```jsonc .mcp.json
{
  "mcpServers": {
    "gdharness": {
      "command": "/absolute/path/to/bun",
      "args": ["/absolute/path/to/.tools/gdharness/build/index.js"],
      "env": { "GODOT_PATH": "/absolute/path/to/godot" },
    },
  },
}
```

`GODOT_PATH` is the only environment variable read. Every tool call carries its own `projectPath`.

Reconnect or restart the client, then check the tools are listed.

## 4. Install the addons

```bash
bun .tools/gdharness/build/cli.js setup /absolute/path/to/project
bun .tools/gdharness/build/cli.js doctor /absolute/path/to/project
```

`setup` installs `gdharness_editor` and `auto_reload` and enables them. `doctor` exits 1 on any
problem and names it.

The runtime addon is an autoload and reaches an exported build, so it is off by default:

```bash
bun .tools/gdharness/build/cli.js runtime on  /absolute/path/to/project
bun .tools/gdharness/build/cli.js runtime off /absolute/path/to/project
```

Without it the `runtime_*` tools have nothing to talk to.

## 5. Check it works

| Call                                         | Expected                                                   |
| -------------------------------------------- | ---------------------------------------------------------- |
| `editor_status`, nothing open                | Reports no editor. Does not fail.                          |
| `editor_status`, editor open                 | `connected` true, `addonVersion` equal to `serverVersion`. |
| `project_info`                               | The project name and main scene.                           |
| `editor_run`, `editor_output`, `editor_stop` | The game starts, its console comes back, it stops.         |

`addonIsStale` true means the editor is running an older addon than the server ships. Restart it
with `editor_launch restart`.

## Updating

```bash
VERSION=<new>
# download and verify as in step 1, then
rm -rf .tools/gdharness && mkdir -p .tools/gdharness
tar -xzf "gdharness-${VERSION}.tgz" -C .tools/gdharness --strip-components=1
bun .tools/gdharness/build/cli.js setup  /absolute/path/to/project
bun .tools/gdharness/build/cli.js doctor /absolute/path/to/project
```

Then two things that are easy to miss, because the old version keeps answering until they are done:

1. Reconnect the MCP server so the client re-spawns it. In Claude Code, `/mcp` and reconnect.
   Restarting the client is not required.
2. Restart an open editor: `editor_launch restart`, about seven seconds. A headless editor cannot
   be restarted and has to be started again by hand.

`editor_status` confirms: `addonVersion` equal to `serverVersion`, `addonIsStale` false.

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
