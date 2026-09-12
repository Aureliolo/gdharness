# gdharness

[![CI](https://github.com/Aureliolo/gdharness/actions/workflows/ci.yml/badge.svg)](https://github.com/Aureliolo/gdharness/actions/workflows/ci.yml)
[![](https://badge.mcpx.dev?type=server 'MCP Server')](https://modelcontextprotocol.io/introduction)
[![Made with Godot](https://img.shields.io/badge/Made%20with-Godot-478CBF?style=flat&logo=godot%20engine&logoColor=white)](https://godotengine.org)
[![Licence](https://img.shields.io/github/license/Aureliolo/gdharness)](LICENSE)

**A harness for driving a Godot 4 project from an agent.** It installs and manages the
Godot side: two editor addons, a runtime bridge into the running game, the class cache, and
the fixtures that prove any of it works. It speaks MCP, so the agent driving it can be
Claude Code, Cursor, Cline, OpenCode or anything else that speaks the protocol.

Forked from [GoPeak](https://github.com/HaD0Yun/Doyunha-Gopeak), and being rebuilt to be more
complete, hardened and actually working.

## Rules

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
