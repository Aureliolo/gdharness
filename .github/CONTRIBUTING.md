# Contributing

## The rules that decide whether a change lands

- **No fixture, no ship.** A tool is driven against a pinned Godot in CI before it exists in
  a release. A change that adds or alters a tool comes with the fixture that proves it.
- **A tool fails rather than answers.** No success payload for an empty or partial result
  that could be a silent failure. An unknown argument or enum value is an error naming the
  valid set, never a silent default.
- **Every mutation reads back.** A tool that writes returns the engine's actual state
  afterwards, read from the engine, not an echo of the request.
- **Answers are sized.** Anything that can return a lot takes a detail level and defaults to
  the smallest useful one. Anything unbounded paginates.

## Development setup

```bash
git clone https://github.com/Aureliolo/gdharness.git
cd gdharness
bun install
bun run build
```

Checks, all of which CI runs:

```bash
bun run ci                 # build, typecheck, regression and detection tests
bun run test:dynamic-groups
bun run test:metadata
bun run format             # Biome, writes
bun run lint               # Biome and ESLint
bun run lint:gd            # gdlint, needs gdtoolkit==4.5.0 from pip
bun run format:gd          # gdformat, writes
bun run watch              # TypeScript watch mode
```

`bun run test:packaging` and `bun run release:pack` only work on Linux or macOS. Windows
cannot record a POSIX file mode, so the packer refuses there rather than shipping an archive
whose executables are world-writable. Releases are cut by CI.

## Repository map

```text
.
├── src/
│   ├── index.ts           # MCP server entry point
│   ├── cli.ts             # CLI entry point
│   ├── tool-definitions.ts# Tool schemas
│   ├── resources.ts       # MCP resources
│   ├── prompts.ts         # MCP prompts
│   ├── godot-bridge.ts    # Bridge transport to the editor addon
│   ├── lsp_client.ts      # Godot language server client
│   ├── dap_client.ts      # Godot debug adapter client
│   ├── visualizer/        # Browser visualiser, bundled into the release
│   └── godot/             # GDScript, copied verbatim into the bundle
│       ├── addons/        # The Godot addons: editor, runtime, auto reload
│       └── operations/    # Headless engine operations
├── test/
│   └── support/           # Shared helpers, not suites
├── docs/
└── scripts/               # Build, pack and release tooling
```

## Style

- British English in prose. No em-dashes.
- Comments explain why, never what.
