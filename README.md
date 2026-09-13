# gdharness

[![CI](https://github.com/Aureliolo/gdharness/actions/workflows/ci.yml/badge.svg)](https://github.com/Aureliolo/gdharness/actions/workflows/ci.yml)
[![Scorecard](https://api.scorecard.dev/projects/github.com/Aureliolo/gdharness/badge)](https://scorecard.dev/viewer/?uri=github.com/Aureliolo/gdharness)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/14619/badge)](https://www.bestpractices.dev/projects/14619)
[![OpenSSF Baseline](https://www.bestpractices.dev/projects/14619/baseline)](https://www.bestpractices.dev/projects/14619)
[![SLSA Build 3](https://img.shields.io/badge/SLSA-Build%20L3-2f6f4e?style=flat)](.github/release-process.md#slsa)
[![SBOM](https://img.shields.io/badge/SBOM-SPDX-2f6f4e?style=flat)](.github/release-process.md#what-a-release-carries)
[![Signed releases](https://img.shields.io/badge/releases-Sigstore%20signed-2f6f4e?style=flat)](.github/release-process.md#verifying-a-release)
[![npm](https://img.shields.io/npm/v/gdharness?logo=npm&logoColor=white&label=npm&color=cb3837)](https://www.npmjs.com/package/gdharness)
[![Release](https://img.shields.io/github/v/release/Aureliolo/gdharness?display_name=tag&sort=semver)](https://github.com/Aureliolo/gdharness/releases)
[![MCP server](https://badge.mcpx.dev?type=server 'MCP Server')](https://modelcontextprotocol.io/introduction)
[![Made for Godot 4.7+](https://img.shields.io/badge/Made%20for-Godot%204.7%2B-478CBF?style=flat&logo=godot%20engine&logoColor=white)](https://godotengine.org)
[![Node](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FAureliolo%2Fgdharness%2Fmain%2Fpackage.json&query=%24.engines.node&label=node&color=5fa04e&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FAureliolo%2Fgdharness%2Fmain%2Fpackage.json&query=%24.engines.bun&label=bun&color=f9f1e1&logo=bun&logoColor=black)](https://bun.sh/)
[![Licence](https://img.shields.io/github/license/Aureliolo/gdharness)](LICENSE)

Drive a Godot 4 project from an agent: the editor that is open, the game that is running, and the
project on disk.

**Install, and pick your harness:
[aureliolo.github.io/gdharness](https://aureliolo.github.io/gdharness)**

Or hand it to your agent:

```text
Install gdharness into this project by following
https://aureliolo.github.io/gdharness/agent.md, then tell me what it asked you to
recommend back to me.
```

## What it is for

An agent cannot see a running game. This makes one answerable: where a control is, what a property
reads, what the console printed, what broke and on which line.

```jsonc
runtime_inspect { "op": "rect", "nodePath": "/root/Hall/Ledger/BuyButton" }

{ "canvas": { "position": { "x": 812, "y": 418 }, "size": { "x": 180, "y": 34 } },
  "visible": true }
```

## At a glance

|           |                                                                          |
| --------- | ------------------------------------------------------------------------ |
| Needs     | Godot 4.7 or newer, Node 22 or newer. Runs under Bun 1.4 too.            |
| Surface   | 30 tools named `domain_verb`, and 4 `godot://` resources                 |
| Reaches   | The editor that is open, a game it is playing, and the project on disk   |
| Harnesses | 35, written inside the project wherever the harness has a project config |
| Skill     | Written to `.agents/skills`, which every major harness reads             |
| Install   | npm, or a Sigstore-signed archive with an SBOM, SLSA Build Level 3       |
| Proven    | Every tool driven against a pinned Godot in CI, on three platforms       |

## Documentation

[aureliolo.github.io/gdharness](https://aureliolo.github.io/gdharness): installing it, how the
parts connect, every tool, the Godot traps worth knowing, and what CI proves against a real engine.

[SECURITY.md](.github/SECURITY.md) is how to report something.
[CONTRIBUTING.md](.github/CONTRIBUTING.md) is what a change has to clear.

## Project

Fork of [GoPeak](https://github.com/HaD0Yun/Doyunha-Gopeak) v2.3.9, September 2026, MIT, by Solomon
Elias originally and completely reworked since to be hardened, condensed and more streamlined.

Not affiliated with GoPeak or the Godot Foundation.
