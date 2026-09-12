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

## What every language in here is held to

Four things, for each language present. A language that arrives without all four arrives with
them in the same change.

| | TypeScript | JavaScript (`.mjs`) | GDScript | Workflows |
| --- | --- | --- | --- | --- |
| Formatter | Biome | Biome | gdformat | - |
| Linter | Biome, oxlint | Biome, oxlint | gdlint, nothing disabled | actionlint, zizmor at `pedantic` |
| Type checker | `tsc`, `@tsconfig/strictest` | `checkJs` | the engine, warnings as errors | - |
| Fuzzing | property tests on every parser of untrusted input | same | - | - |

Rules are **written out rather than inherited from a preset**, so the file says what it enforces:
see `.oxlintrc.json` and `.gdlintrc`. Nothing is turned off quietly. A rule that fires on good
code is an argument about the rule, and the argument goes next to the suppression along with what
it would cost to adopt.

**Every job CI runs is a required status check.** A job that can be red while something merges is
not a gate, and we have been bitten by exactly that.

**Every pinned version is watched by something.** Dependabot covers the package ecosystems it
understands, which is `package.json` and the workflow `uses:` digests. It does not see a version
passed as an action input, an inline `pip install x==y`, a version inside a URL, or a pin held in
a script: the engine, gdtoolkit, Python, actionlint and zizmor are all in that second group.
`bun run check:pins` covers them, and it fails when it finds a pin that nothing watches, so a new
pin cannot arrive unwatched.

Pick the newest stable version of a tool rather than the familiar one, and read what the release
actually changed before taking it.

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
bun run lint               # Biome, then oxlint with its type-aware rules
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
