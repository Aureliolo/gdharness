# gdharness: install into a project

For an agent. Version `{{version}}`. MCP server plus three Godot addons.

## Refuse

- Installing without verifying the release. A failed check stops the install.
- Node instead of Bun.
- Starting a second Godot editor while one is open. 6005 and 6006 hold one client each.
- Spawning an engine for anything a tool already does.

## 1. Requirements

```bash
godot --version   # >= 4.7.0, keep the absolute path
bun --version     # >= 1.4.0
```

## 2. Download and verify

Two checks: the checksum for the bytes, the attestation for who built them.

```bash
gh --version
```

With `gh`, authenticated:

```bash
VERSION={{version}}
gh release download "v${VERSION}" --repo Aureliolo/gdharness
sha256sum -c "gdharness-${VERSION}.tgz.sha256"
gh attestation verify "gdharness-${VERSION}.tgz" --repo Aureliolo/gdharness \
  --bundle "gdharness-${VERSION}.intoto.jsonl" \
  --signer-workflow Aureliolo/gdharness/.github/workflows/release-build.yml \
  --source-ref "refs/tags/v${VERSION}" \
  --deny-self-hosted-runners
```

Without it:

```bash
VERSION={{version}}
BASE="https://github.com/Aureliolo/gdharness/releases/download/v${VERSION}"
curl -fsSLO "${BASE}/gdharness-${VERSION}.tgz"
curl -fsSLO "${BASE}/gdharness-${VERSION}.tgz.sha256"
sha256sum -c "gdharness-${VERSION}.tgz.sha256"   # macOS: shasum -a 256 -c
```

Then verify the `.intoto.jsonl` bundle with Sigstore tooling against identity
`https://github.com/Aureliolo/gdharness/.github/workflows/release-build.yml@refs/tags/v${VERSION}`
and issuer `https://token.actions.githubusercontent.com`. If that is not possible, report that the
provenance was not verified. Do not present it as verified.

```bash
mkdir -p .tools/gdharness
tar -xzf "gdharness-${VERSION}.tgz" -C .tools/gdharness --strip-components=1
bun .tools/gdharness/build/cli.js version   # must print ${VERSION}
```

## 3. Configure the MCP client

Absolute paths for all three values. Clients do not expand `${...}` and do not reliably inherit
`PATH`.

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

`GODOT_PATH` is the only environment variable read. Every tool call carries its own `projectPath`.
If the project generates this file, edit the template and regenerate. Reconnect the client, then
confirm the tools are listed.

## 4. Install the addons

```bash
bun .tools/gdharness/build/cli.js setup  /absolute/path/to/project
bun .tools/gdharness/build/cli.js doctor /absolute/path/to/project   # must exit 0
```

The runtime addon is an autoload and reaches an export, so it is off by default. Turn it on while
working, off before committing:

```bash
bun .tools/gdharness/build/cli.js runtime on  /absolute/path/to/project
bun .tools/gdharness/build/cli.js runtime off /absolute/path/to/project
```

Without it, `runtime_*` has nothing to talk to.

## 5. Verify

1. `editor_status` with nothing open: reports no editor, does not fail.
2. Open the project in the editor. `editor_status`: `connected` true, `addonVersion` equal to
   `serverVersion`. If `addonIsStale`, run `editor_launch restart`.
3. `project_info`: returns the project name and main scene.
4. `editor_run`, `editor_output`, `editor_stop`.

## Updating

```bash
# verify the new archive as in step 2, then
rm -rf .tools/gdharness && mkdir -p .tools/gdharness
tar -xzf "gdharness-${VERSION}.tgz" -C .tools/gdharness --strip-components=1
bun .tools/gdharness/build/cli.js setup  /absolute/path/to/project
bun .tools/gdharness/build/cli.js doctor /absolute/path/to/project
```

Then reconnect the MCP server, and restart an open editor with `editor_launch restart`. Confirm
with `editor_status`: `addonVersion` equal to `serverVersion`, `addonIsStale` false. Skipping
either leaves the old version answering.

## Rules

- After writing a `class_name`, call `project_import refresh_classes` before running the game.
  Otherwise the game fails with "Could not find type" at the first screen.
- Use `editor_run` / `editor_output` / `editor_stop`. A game started as its own process has no
  debugger session.
- Set breakpoints before running.
- Read `editor_output` after every run.
- Measure the running game: `runtime_inspect` for what is on screen, `runtime_invoke` for a value,
  `runtime_wait` instead of sleeping.
- `runtime_capture` needs a window and refuses headless.
- There is no `debug_control pause`. Use a breakpoint.
- A refusal lists the valid set. Read it.

## Reference

- `tools.md`: every tool, op and argument.
- `architecture.md`: what connects to what, and the ports.
- `traps.md`: Godot behaviours that affect how you use this.
- `usage.md`: what has to be running for which tools.
- `tested.md`: what is covered by tests and what is not.

All at <https://aureliolo.github.io/gdharness>.
