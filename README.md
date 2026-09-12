# gdharness

[![](https://badge.mcpx.dev?type=server 'MCP Server')](https://modelcontextprotocol.io/introduction)
[![Made with Godot](https://img.shields.io/badge/Made%20with-Godot-478CBF?style=flat&logo=godot%20engine&logoColor=white)](https://godotengine.org)
[![Bun](https://img.shields.io/badge/Bun-1.3.3%2B-f9f1e1?style=flat&logo=bun&logoColor=black 'Bun')](https://bun.sh/)
[![](https://img.shields.io/badge/License-MIT-red.svg 'MIT License')](https://opensource.org/licenses/MIT)

**A harness for driving a Godot 4 project from an agent.** It installs and manages the
Godot side: two editor addons, a runtime bridge into the running game, the class cache, and
the fixtures that prove any of it works. It speaks MCP, so the agent driving it can be
Claude Code, Cursor, Cline, OpenCode or anything else that speaks the protocol.

Forked from [GoPeak](https://github.com/HaD0Yun/Doyunha-Gopeak) by Solomon Elias, and being
rebuilt around a different set of rules.

## Status

Early. Version 0.x, no release cut yet, build from source. It reaches 1.0 when the intended
feature set is in and it is published on the MCP registries.

## Why a fork

GoPeak is a real piece of work and most of what makes it useful is the Godot side: 6,800
lines of headless engine operations, a GDScript parser, a language server client, a debug
adapter client, and the editor addon that answers questions about a scene without booting
one. That part is kept.

What is being replaced is everything facing the model, because using it daily surfaced one
defect repeatedly: **tools that answer instead of failing.** The language server client
returned an empty diagnostics list for every file on Windows for over a year, which reads
exactly like a clean file. An argument the server does not recognise is dropped in silence
and the call succeeds on the defaults, so `scene_create` accepts `rootType` and hands back a
`Node` root with a success payload. Every runtime argument is declared a string, so `false`
arrives as `"false"` and Godot reads it as true, and a quoted `Color(...)` written into
`project.godot` corrupts it for every later load. A viewport capture of a minimised window
returns the last frame it drew, with no indication that the picture is four minutes old.

None of those are exotic. They are what happens when nothing drives the tools against a real
engine before they ship.

## Rules

These are the design rules, and they are the point of the fork.

- **No fixture, no ship.** Every tool is driven against a pinned Godot in CI before it
  exists in a release. Anything nobody will write a fixture for is cut instead of shipped.
- **A tool fails rather than answers.** No success payload for an empty or partial result
  that could be a silent failure. An unknown argument or an unknown enum value is an error
  naming the valid set, never a silent default.
- **Every mutation reads back.** A tool that writes returns the engine's actual state
  afterwards, read back from the engine, never an echo of the request.
- **Few tools, shaped like tasks.** Around 30, not 100. A server whose tool list does not
  fit in a context window has too many tools, not a missing pagination feature.
- **Answers are sized.** Anything that can return a lot takes a detail level and defaults to
  the smallest useful one; anything unbounded paginates. A tree comes back as paths, not as
  nested objects that repeat their keys a thousand times.

## Requirements

- Godot 4.7
- Bun 1.3.3+
- An MCP client

## Building

```bash
bun install
bun run build
bun run ci
```

## Licence

MIT. Copyright (c) 2025 Solomon Elias for the original work, and the gdharness contributors
for changes since the fork. See [LICENSE](LICENSE).

This project is not affiliated with or endorsed by the GoPeak project or the Godot
Foundation.
