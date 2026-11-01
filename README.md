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
[![MCP 2026-07-28](https://img.shields.io/badge/MCP-2026--07--28-2f6f4e?style=flat)](https://modelcontextprotocol.io/specification/2026-07-28)
[![Made for Godot 4.7+](https://img.shields.io/badge/Made%20for-Godot%204.7%2B-478CBF?style=flat&logo=godot%20engine&logoColor=white)](https://godotengine.org)
[![Node](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FAureliolo%2Fgdharness%2Fmain%2Fpackage.json&query=%24.engines.node&label=node&color=5fa04e&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FAureliolo%2Fgdharness%2Fmain%2Fpackage.json&query=%24.engines.bun&label=bun&color=f9f1e1&logo=bun&logoColor=black)](https://bun.sh/)
[![Licence](https://img.shields.io/github/license/Aureliolo/gdharness)](LICENSE)

An agent cannot see a running game. It reads your scripts and guesses at the rest: whether the
button is on screen, whether the panel updated, whether that error mattered.

gdharness is an MCP server and four Godot addons. Through them the agent asks the open editor and
the running game what the screen says and where a control is. It can also ask what a property holds
now, what the console printed, and what broke on which line.

## Install

Hand this to your agent:

```text
Install gdharness here by following https://aureliolo.github.io/gdharness/agent.md,
then tell me what it asked you to recommend back to me.
```

Or do it yourself, and pick your harness:
[aureliolo.github.io/gdharness](https://aureliolo.github.io/gdharness).

## The loop it exists for

```jsonc
editor_run      { "op": "start", "projectPath": "C:/games/shop" }
runtime_inspect { "op": "find", "says": "Buy" }              // the button, by the word on it
runtime_input   { "op": "click", "nodePath": "/root/Shop/Ledger/BuyButton" }
runtime_inspect { "op": "text", "nodePath": "/root/Shop/Ledger" }   // what the panel says now
editor_output   { "projectPath": "C:/games/shop" }           // errors and warnings, with backtraces
```

The open editor plays the game, so you can set a breakpoint and read the variables in scope when it
stops.

Every answer is read back from the engine, never echoed from the request. A tool that cannot answer
says which state it is in and what would change it.

## At a glance

|           |                                                                                      |
| --------- | ------------------------------------------------------------------------------------ |
| Needs     | Godot 4.7 or newer, Node 22 or newer. Runs under Bun 1.4 too.                        |
| Surface   | 30 tools named `domain_verb`, 4 `godot://` resources and 3 prompts                   |
| Reaches   | The editor that is open, a game it is playing, and the project on disk               |
| Harnesses | 35, written inside the project wherever the harness has a project config             |
| Skill     | Written to `.agents/skills`, with a copy for Claude Code, Kiro and Cline             |
| Install   | npm, or a Sigstore-signed archive with an SBOM, SLSA Build Level 3                   |
| Proven    | Every tool driven against Godot 4.7.2 in CI, on Windows, Linux and macOS             |
| Status    | 1.x: every release is a patch. [What a bump means](.github/CONTRIBUTING.md#versions) |

Godot before 4.7 is not tested.

## Documentation

[aureliolo.github.io/gdharness](https://aureliolo.github.io/gdharness): installing it, how the
parts connect, and every tool, op and argument.

[SECURITY.md](.github/SECURITY.md) is how to report a security fault.
[CONTRIBUTING.md](.github/CONTRIBUTING.md) is what a change has to clear.

## Project

Fork of [GoPeak](https://github.com/HaD0Yun/Doyunha-Gopeak) v2.3.9, September 2026, MIT. The
original MCP server is [godot-mcp](https://github.com/Coding-Solo/godot-mcp) by
[Solomon Elias](https://github.com/Coding-Solo), and GoPeak is by
[HaD0Yun](https://github.com/HaD0Yun).

Not affiliated with the Godot Foundation.
