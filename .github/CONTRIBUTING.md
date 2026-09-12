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

Five things, for each language present. A language that arrives without all five arrives with
them in the same change. There is no JavaScript here: the server, the scripts and the tests are
all TypeScript, so one type checker covers everything Bun runs.

| | TypeScript | GDScript | Workflows |
| --- | --- | --- | --- |
| Formatter | Biome | gdformat | - |
| Linter | Biome, oxlint type-aware | gdlint, nothing disabled | actionlint, zizmor at `pedantic` |
| Type checker | `tsc`, `@tsconfig/strictest`, over `src`, `test` and `scripts` alike | the engine, warnings as errors | - |
| Dead code | knip: every file, export and dependency is reached from an entry point | - | - |
| Fuzzing | fast-check properties in `test/fuzz.ts` over every reader of bytes nobody here wrote: the Content-Length framing, `project.godot`, paths inside a project, the engine archive | - | - |

Rules are **written out rather than inherited from a preset**, so the file says what it enforces:
see `.oxlintrc.json` and `.gdlintrc`. Nothing is turned off quietly. A rule that fires on good
code is an argument about the rule, and the argument goes next to the suppression along with what
it would cost to adopt.

**Every job CI runs is a required status check.** A job that can be red while something merges is
not a gate, and we have been bitten by exactly that.

**Nothing from outside the repository runs unverified.** Every file CI downloads is refused
unless it matches a digest written in this repository: the Bun that runs every job
(`.github/actions/install-bun`), uv and the interpreter and gdtoolkit under it (`ci.yml`,
`.github/requirements/`), actionlint (`workflows.yml`), and the engine
(`scripts/install-godot.ts`). npm packages carry theirs in `bun.lock`, actions are pinned by
commit, and zizmor runs from a container image whose digest is fixed by the action's commit. A
tool that arrives without a digest arrives with one in the same change.

**Every pin is watched by Renovate, digest included.** `renovate.json` is the whole of it: the
`bun` and `github-actions` managers cover `package.json`, the lockfile and every `uses:`; the
`pip-compile` manager recompiles the gdtoolkit lock with new hashes; and two regex managers read
the `# renovate:` line above any other pin, so a new one is watched the moment it is annotated.
One pull request a week carries everything, a vulnerability fix arrives on its own the day it
exists, and the lock file refresh is its own weekly pull request because it changes nothing this
file names. A pin without an annotation is a pin nothing watches, and the review refuses it.

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
bun run ci                 # build, typecheck over src, test and scripts, regression, detection, archive and property tests
bun run test:integration   # the bridge against a mock editor and a mock runtime
bun run test:metadata
bun run format             # Biome, writes
bun run lint               # Biome, then oxlint with its type-aware rules, then knip
bun run lint:gd            # gdlint, needs gdtoolkit from .github/requirements/gdtoolkit.txt
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
