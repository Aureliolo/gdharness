# gdharness

[![CI](https://github.com/Aureliolo/gdharness/actions/workflows/ci.yml/badge.svg)](https://github.com/Aureliolo/gdharness/actions/workflows/ci.yml)
[![Scorecard](https://api.scorecard.dev/projects/github.com/Aureliolo/gdharness/badge)](https://scorecard.dev/viewer/?uri=github.com/Aureliolo/gdharness)
[![SLSA Build 3](https://img.shields.io/badge/SLSA-Build%20L3-2f6f4e?style=flat)](.github/release-process.md#slsa)
[![SBOM](https://img.shields.io/badge/SBOM-SPDX-2f6f4e?style=flat)](.github/release-process.md#what-a-release-carries)
[![Signed releases](https://img.shields.io/badge/releases-Sigstore%20signed-2f6f4e?style=flat)](.github/release-process.md#verifying-a-release)
[![Release](https://img.shields.io/github/v/release/Aureliolo/gdharness?display_name=tag&sort=semver)](https://github.com/Aureliolo/gdharness/releases)
[![MCP server](https://badge.mcpx.dev?type=server 'MCP Server')](https://modelcontextprotocol.io/introduction)
[![Made for Godot 4.7+](https://img.shields.io/badge/Made%20for-Godot%204.7%2B-478CBF?style=flat&logo=godot%20engine&logoColor=white)](https://godotengine.org)
[![Bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FAureliolo%2Fgdharness%2Fmain%2Fpackage.json&query=%24.engines.bun&label=bun&color=f9f1e1&logo=bun&logoColor=black)](https://bun.sh/)
[![Licence](https://img.shields.io/github/license/Aureliolo/gdharness)](LICENSE)

MCP server and Godot addons for driving a Godot 4 project from an agent: the editor that is open,
the game that is running, and the project on disk.

Requires Godot 4.7.0 or newer and [Bun](https://bun.sh) 1.4.0 or newer.

```jsonc
runtime_inspect { "op": "rect", "nodePath": "/root/Hall/Ledger/BuyButton" }

{
  "type": "rect",
  "path": "/root/Hall/Ledger/BuyButton",
  "visible": true,
  "canvas": { "position": { "x": 812, "y": 418 }, "size": { "x": 180, "y": 34 } },
  "window": { "position": { "x": 812, "y": 418 }, "size": { "x": 180, "y": 34 } }
}
```

**Documentation: [aureliolo.github.io/gdharness](https://aureliolo.github.io/gdharness)**

## Install

1. Download a release and verify its attestation.
2. Point your MCP client at `build/index.js`, with `GODOT_PATH` set.
3. `gdharness setup /path/to/project`
4. `gdharness doctor /path/to/project`

[Install](https://aureliolo.github.io/gdharness/install.html) has the commands. To have an agent do
it, paste:

```text
Install gdharness into this project by following
https://aureliolo.github.io/gdharness/agent.md, then tell me what it asked you to
recommend back to me.
```

## Three parts

**Inside Godot.** Addons installed into your project. They make the open editor and the running
game answerable, and reload the editor's view when files change on disk.

**The MCP server.** What your agent calls: thirty-odd tools and four `godot://` resources.

**The CLI.** Installs the addons, checks them, rebuilds the class cache.

[How it works](https://aureliolo.github.io/gdharness/architecture.html) is what connects to what.

## Tools

Tools are named `domain_verb`. A tool that does several related things takes an `op`. An unknown op
or argument is refused with the valid set listed. Answers are read from the engine after the
change, not echoed from the request.

[Reference](https://aureliolo.github.io/gdharness/tools.html), generated from the server.

## Rules

- **No fixture, no ship.** Every tool is driven against a pinned Godot in CI before it ships.
- **A tool fails rather than answers.** No success payload for an empty or partial result.
- **Every mutation reads back** from the engine.
- **Strict projects are the baseline.** Everything shipped, and everything the tools write, parses
  with all GDScript warnings as errors.
- **Few tools, shaped like tasks.** Around thirty, not a hundred.
- **Answers are sized.** Detail levels by default, pagination where unbounded.

[What is proven](https://aureliolo.github.io/gdharness/tested.html) is how to check that.

## Security

- The runtime bridge binds `127.0.0.1` and refuses to listen outside a debug build. No exported
  game serves it.
- Subprocesses are spawned with an argument array, never a shell.
- Releases carry an SPDX SBOM and a keyless Sigstore build-provenance attestation over the archive,
  its checksum and the SBOM, built by one reusable workflow: [SLSA Build Level
  3](.github/release-process.md#slsa). Published releases are immutable.
- Every dependency is an exact version and every action is pinned by commit digest. Nothing
  downloaded in CI runs unless it matches a digest in this repository.
- `main` takes pull requests only, linear history, signed commits, and every CI job is a required
  check. CodeQL, Scorecard, actionlint, zizmor and secret scanning run on every change.

```bash
gh attestation verify gdharness-X.Y.Z.tgz --repo Aureliolo/gdharness \
  --signer-workflow Aureliolo/gdharness/.github/workflows/release-build.yml
```

[SECURITY.md](.github/SECURITY.md) is how to report something.

## Development

```bash
bun install
bun run build
bun run ci
bun run docs     # the site, into site/
```

[CONTRIBUTING.md](.github/CONTRIBUTING.md) is what a change has to clear.

## Project

Fork of [GoPeak](https://github.com/HaD0Yun/Doyunha-Gopeak) v2.3.9, September 2026, MIT, by Solomon
Elias originally and completely reworked since to be hardened, condensed and more streamlined.

Not affiliated with GoPeak or the Godot Foundation.
