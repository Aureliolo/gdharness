# gdharness

[![CI](https://github.com/Aureliolo/gdharness/actions/workflows/ci.yml/badge.svg)](https://github.com/Aureliolo/gdharness/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/gdharness?logo=npm&logoColor=white&label=npm&color=cb3837)](https://www.npmjs.com/package/gdharness)
[![Made for Godot 4.7+](https://img.shields.io/badge/Made%20for-Godot%204.7%2B-478CBF?style=flat&logo=godot%20engine&logoColor=white)](https://godotengine.org)
[![MCP server](https://badge.mcpx.dev?type=server 'MCP Server')](https://modelcontextprotocol.io/introduction)
[![Scorecard](https://api.scorecard.dev/projects/github.com/Aureliolo/gdharness/badge)](https://scorecard.dev/viewer/?uri=github.com/Aureliolo/gdharness)
[![Licence](https://img.shields.io/github/license/Aureliolo/gdharness)](LICENSE)

**An agent cannot see a running game.** It reads your scripts and guesses at the rest: whether the
button is on screen, whether the panel updated, whether that error mattered.

gdharness makes the engine answerable instead. What the screen says, where a control is, what a
property reads right now, what the console printed, what broke and on which line.

## Install

Hand this to your agent:

```text
Install gdharness into this project by following
https://aureliolo.github.io/gdharness/agent.md, then tell me what it asked you to
recommend back to me.
```

Or do it yourself, and pick your harness:
[aureliolo.github.io/gdharness](https://aureliolo.github.io/gdharness).

## The loop it exists for

```jsonc
editor_run      { "op": "start", "projectPath": "C:/games/hall" }
runtime_inspect { "op": "find", "says": "Buy" }              // the button, by the word on it
runtime_input   { "op": "click", "nodePath": "/root/Hall/Ledger/BuyButton" }
runtime_inspect { "op": "text", "nodePath": "/root/Hall/Ledger" }   // what the panel says now
editor_output   { "projectPath": "C:/games/hall" }           // errors and warnings, with backtraces
```

The open editor plays the game, so its debugger holds it, which is what lets you set a breakpoint
and read the variables in scope when it stops.

Every answer is read back out of the engine after the fact, never echoed from the request. A tool
that cannot answer says which state it is in and what would change it, rather than answering
emptily, so a call that succeeded is a call that was understood.

## At a glance

|              |                                                                                  |
| ------------ | -------------------------------------------------------------------------------- |
| Needs        | Godot 4.7 or newer, Node 22 or newer. Runs under Bun 1.4 too.                    |
| Surface      | 30 tools named `domain_verb`, and 4 `godot://` resources                         |
| Reaches      | The editor that is open, a game it is playing, and the project on disk           |
| Harnesses    | 35, written inside the project wherever the harness has a project config         |
| Skill        | Written to `.agents/skills`, which every major harness reads                     |
| Proven       | Every tool driven against Godot 4.7.2 in CI, on Windows, Linux and macOS         |
| Supply chain | Sigstore-signed, SBOM, [SLSA Build L3](.github/release-process.md#slsa)          |
| Status       | 0.x: pin an exact version. [What a bump means](.github/CONTRIBUTING.md#versions) |

Older 4.x is likely to work and is not tested.

## Documentation

[aureliolo.github.io/gdharness](https://aureliolo.github.io/gdharness): installing it, how the
parts connect, and every tool, op and argument.

[SECURITY.md](.github/SECURITY.md) is how to report something.
[CONTRIBUTING.md](.github/CONTRIBUTING.md) is what a change has to clear.

## Project

Fork of [GoPeak](https://github.com/HaD0Yun/Doyunha-Gopeak) v2.3.9, September 2026, MIT: the
original MCP server [godot-mcp](https://github.com/Coding-Solo/godot-mcp) by
[Solomon Elias](https://github.com/Coding-Solo), GoPeak by [HaD0Yun](https://github.com/HaD0Yun),
and completely reworked since to be hardened, condensed and more streamlined.

Not affiliated with the Godot Foundation.
