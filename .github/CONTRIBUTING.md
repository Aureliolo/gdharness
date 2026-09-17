# Contributing

## The rules that decide whether a change lands

- **No fixture, no ship.** A tool is driven against a pinned Godot in CI before it exists in
  a release. A change that adds or alters a tool comes with the fixture that proves it.
- **A tool fails rather than answers.** No success payload for an empty or partial result
  that could be a silent failure. An unknown argument or enum value is an error naming the
  valid set, never a silent default.
- **Every mutation reads back.** A tool that writes returns the engine's actual state
  afterwards, read from the engine, not an echo of the request.
- **A failure nobody modelled says so.** A refusal names what would have worked; anything that
  reaches the tool boundary as a throw is a defect, and answers as one. Never dress an
  unmodelled failure as a refusal: the caller then spends its turns rephrasing a call that was
  right, and the bug is never heard about.
- **Answers are sized.** Anything that can return a lot takes a detail level and defaults to
  the smallest useful one. Anything unbounded paginates.

## Versions

- **Patch**: nearly everything. An answer that was wrong is now right, and the output may change
  shape for it, because a wrong answer corrected is a fix rather than a feature and leaving one
  wrong to protect whoever parsed it is how a tool stops being worth asking. An addition nothing
  has to adapt to is a patch too: a new argument, a new field, an argument reaching further than it
  did. Ignore all of it and your calls still work.
- **Minor**: a new tool or a new op, meaning gdharness does something it could not do before.
- **Major**: a tool, an op, an argument or a field was renamed or taken away. Nothing else earns
  one.

## What every language in here is held to

Five things, for each language present. A language that arrives without all five arrives with
them in the same change. There is no JavaScript here: the server, the scripts and the tests are
all TypeScript, so one type checker covers everything Bun runs.

|              | TypeScript                                                                                                                                                                    | GDScript                                                                                                                                                              | YAML                                                                       | Markdown                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------- |
| Formatter    | Biome                                                                                                                                                                         | gdformat, the fixtures included                                                                                                                                       | Prettier                                                                   | Prettier, prose wrap preserved         |
| Linter       | Biome, oxlint type-aware                                                                                                                                                      | gdlint, nothing disabled                                                                                                                                              | yamllint `--strict`; actionlint and zizmor at `pedantic` for the workflows | markdownlint, every rule, lines at 100 |
| Type checker | `tsc`, `@tsconfig/strictest`, over `src`, `test` and `scripts` alike                                                                                                          | the engine: `test:engine` parses every shipped script and fixture with all 43 GDScript warnings as errors, addons included, and proves the gate bites by planting one | -                                                                          | -                                      |
| Dead code    | knip: every file, export and dependency is reached from an entry point                                                                                                        | -                                                                                                                                                                     | -                                                                          | -                                      |
| Fuzzing      | fast-check properties in `test/fuzz.ts` over every reader of bytes nobody here wrote: the Content-Length framing, `project.godot`, paths inside a project, the engine archive | -                                                                                                                                                                     | -                                                                          | -                                      |

Rules are **written out rather than inherited from a preset**, so the file says what it enforces:
see `.oxlintrc.json`, `.gdlintrc`, `.yamllint.yaml` and `.markdownlint-cli2.jsonc`. Nothing is
turned off quietly. A rule that fires on good code is an argument about the rule, and the
argument goes next to the suppression along with what it would cost to adopt.

**Every job CI runs is a required status check.** A job that can be red while something merges is
not a gate, and we have been bitten by exactly that.

**Nothing from outside the repository runs unverified.** Every file CI downloads is refused
unless it matches a digest written in this repository: the Bun that runs every job
(`.github/actions/install-bun`), uv and the interpreter, gdtoolkit and yamllint under it
(`ci.yml`, `uv.lock`), actionlint (`workflows.yml`), the engine
(`scripts/install-godot.ts`) and the gdUnit4 the runner fixture drives
(`scripts/install-gdunit4.ts`). npm packages carry theirs in `bun.lock`, actions are pinned by
commit, and zizmor runs from a container image whose digest is fixed by the action's commit. A
tool that arrives without a digest arrives with one in the same change.

**Every pin is watched by Renovate, digest included.** `.github/renovate.json` is the whole of
it: the `bun` and `github-actions` managers cover `package.json`, `bun.lock` and every `uses:`;
the `uv` manager covers gdtoolkit and yamllint in `pyproject.toml` and `uv.lock`, hashes
included; and three regex managers read the `# renovate:` line above any other pin, so a new one
is watched the moment it is annotated.
Renovate opens two pull requests a week and no others. Monday's carries every raise, majors and
vulnerability fixes included. Tuesday's regenerates `bun.lock` and `uv.lock`, which is where the
transitive dependencies move, and it is its own pull request because it changes nothing this
file names. A pin without an annotation is a pin nothing watches, and the review refuses it.

Pick the newest stable version of a tool rather than the familiar one, and read what the release
actually changed before taking it.

## Development setup

```bash
git clone https://github.com/Aureliolo/gdharness.git
cd gdharness
bun install
uv sync --locked           # gdtoolkit and yamllint, into .venv
bun run build
```

Checks, all of which CI runs:

```bash
bun run ci                 # build, typecheck over src, test and scripts, regression, detection, archive and property tests
bun run test:integration   # the bridge against a mock editor and a mock runtime
bun run test:metadata
bun run format             # Biome for the code, Prettier for the prose and YAML; writes
bun run lint               # Biome, then oxlint with its type-aware rules, then knip, then markdownlint
uv run bun run lint:gd     # gdlint, from .venv
uv run bun run format:gd   # gdformat, writes
uv run yamllint --strict .
bun run docs               # the public site, into site/; refuses a page nothing links to
bun run watch              # TypeScript watch mode
```

`bun test/regressions.ts` runs every regression whether or not an earlier one failed and names
the failures at the end, which is what makes a disarm readable: break the line a fixture guards,
and the run says which fixtures noticed rather than stopping at the first. Arguments select
tests by name, loosely matched, for working on one: `bun test/regressions.ts debugtools`.

Install the engine locally and the fixtures that need it stop skipping: `bun scripts/install-godot.ts`
and `bun scripts/install-gdunit4.ts` each print a path to export as `GODOT_PATH` and `GDUNIT4_PATH`.
Both verify a published digest and refuse anything else.

`bun run test:packaging` and `bun run release:pack` only work on Linux or macOS. Windows
cannot record a POSIX file mode, so the packer refuses there rather than shipping an archive
whose executables are world-writable. Releases are cut by CI.

## Repository map

```text
.
├── src/
│   ├── server.ts          # The MCP server: validation and dispatch of every tool
│   ├── server-entry.ts    # Its entry point, bundled as build/index.js
│   ├── cli.ts             # CLI entry point: the server by default, setup, doctor, runtime, classes
│   ├── setup.ts           # What the CLI does to a project
│   ├── tool-definitions.ts# Tool schemas
│   ├── headless.ts        # Running one operation of the engine script
│   ├── godot-path.ts      # Finding the engine
│   ├── game-log.ts        # What a game prints, read as problems
│   ├── junit.ts           # The JUnit report a test runner writes, read as cases
│   ├── launch.ts          # How a game is started
│   ├── runtime-client.ts  # Talking to a running game
│   ├── project-scan.ts    # Reading a project directory without the engine
│   ├── resources.ts       # MCP resources
│   ├── harnesses.ts       # Which agent harnesses setup can register the server with
│   ├── godot-bridge.ts    # Bridge transport to the editor addon
│   ├── lsp_client.ts      # Godot language server client
│   ├── dap_client.ts      # Godot debug adapter client
│   └── godot/             # GDScript, copied verbatim into the bundle
│       ├── addons/        # The Godot addons: editor, runtime, auto reload
│       └── operations/    # Headless engine operations
├── test/
│   └── support/           # Shared helpers, not suites
├── docs/                  # The public site's source
│   └── theme/             # Its template and stylesheet, both hand-written
└── scripts/               # Build, pack, release and site tooling
```

[release-process.md](./release-process.md) is how a release is cut, signed and verified, which is a
maintainer's job rather than a reader's, so it lives here rather than on the site.

The site at <https://aureliolo.github.io/gdharness> is built from `docs/` by
`scripts/build-docs.ts` and published by `.github/workflows/docs.yml`. The tool reference is
rendered from `src/tool-definitions.ts` at build time rather than written by hand, so it says what
the server says; a page added to `docs/` has to be listed in the generator, which is what stops one
publishing with nothing linking to it.

## Style

- British English in prose. No em-dashes.
- Comments explain why, never what.
