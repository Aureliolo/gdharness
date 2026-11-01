# Contributing

## The rules that decide whether a change lands

- **Every tool change comes with a fixture** driving it against a pinned Godot in CI.
- **A fixture asserts the invariant, not the reading.** A case that writes down a measurement keeps
  it in force after the evidence is gone, and then fails the correction.
- **A tool refuses rather than answering emptily.** An empty or partial result that could be a
  silent failure gets no success payload.
- **An unknown argument or enum value is an error** naming the valid set, never a silent default.
- **Every mutation reads back.** A tool that writes returns the engine's actual state afterwards,
  read from the engine, not an echo of the request.

## Refusals and answers

- **A failure nobody modelled says so.** Anything that reaches the tool boundary as a throw is a
  defect, and answers as one.
- **Never dress an unmodelled failure as a refusal.** The caller then spends its turns rephrasing a
  call that was right, while nobody hears about the bug.
- **A refusal says what the thing is and what would have worked.** "`editor_run check` is a boot
  probe" ends the attempt, while "invalid op" leads the caller to repeat the same call.
- **A refusal names the version that decided, where one did.** That separates a wrong call from one
  that is only too new for the server answering it.
- **Answers are sized.** Anything that can return a lot takes a detail level and defaults to the
  smallest useful one, and anything unbounded paginates.

## Versions

- **Patch** is every release, a corrected answer included, even when its output changes shape. A
  wrong answer is never kept for a caller who parsed it.
- An addition nothing has to adapt to is a patch too, such as a new argument, field, tool or op, or
  an argument reaching further. Ignore all of it and your calls still work.
- **Minor** comes only when the owner marks a release as one, announced ahead. Nothing earns one on
  its own.
- No **major** is planned.

Until gdharness has users outside the owner's own projects, nothing is kept working for an older release.
The server and the addons of one release work with each other only. An editor or a game on another
release's addon is refused with the command that brings it into step. A rename or a removal ships in
a minor.

## What every language in here is held to

Five things, for each language present. A language that arrives without all five arrives with them
in the same change.

|              | TypeScript                                                                                                                                                                    | GDScript                                                                                                                                                            | YAML                                                                       | Markdown                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------- |
| Formatter    | Biome                                                                                                                                                                         | gdstyle, the fixtures included                                                                                                                                      | Prettier                                                                   | Prettier, prose wrap preserved         |
| Linter       | Biome, oxlint type-aware                                                                                                                                                      | gdstyle, every finding failing, with `gdstyle.toml`                                                                                                                 | yamllint `--strict`, actionlint and zizmor at `pedantic` for the workflows | markdownlint, every rule, lines at 100 |
| Type checker | `tsc`, `@tsconfig/strictest`, over `src`, `test` and `scripts` alike                                                                                                          | the engine: `test:engine` parses every shipped script and fixture with all 49 engine warnings (4.7.2) as errors, addons included, and checks a planted one fails it | -                                                                          | -                                      |
| Dead code    | knip: every file, export and dependency is reached from an entry point                                                                                                        | -                                                                                                                                                                   | -                                                                          | -                                      |
| Fuzzing      | fast-check properties in `test/fuzz.ts` over every reader of bytes nobody here wrote: the Content-Length framing, `project.godot`, paths inside a project, the engine archive | -                                                                                                                                                                   | -                                                                          | -                                      |

## Lint rules

Rules are written out rather than inherited from a preset, so each file says what it enforces. See
`.oxlintrc.json`, `gdstyle.toml`, `.yamllint.yaml` and `.markdownlint-cli2.jsonc`. Nothing is
turned off quietly. A rule that fires on good code is an argument about the rule. That argument goes
next to the suppression, with what adopting the rule would cost.

`gdstyle.toml` is copied byte for byte from the owner's game projects, where a change to it is made
first.

## Required checks

**Every job CI runs is a required status check.** A job that can be red while something merges is
not a gate.

The engine legs run in parts on separate machines. Each platform's `engine (...)` check passes only
when every one of its parts did. It also passes when the `scope` job finds the pull request changes
nothing but the version lines a release bumps, and the parts are skipped. A `scope` that fails fails
those checks with it.

## Downloads and pins

**Nothing from outside the repository runs unverified.** Every file CI downloads is refused unless
it matches a digest written in this repository:

- the Bun that runs every job (`.github/actions/install-bun`)
- uv, the interpreter and yamllint under it (`ci.yml`, `uv.lock`)
- gdstyle (`scripts/install-gdstyle.ts`)
- actionlint (`workflows.yml`)
- the engine (`scripts/install-godot.ts`)
- the gdUnit4 the runner fixture drives (`scripts/install-gdunit4.ts`)

npm packages carry theirs in `bun.lock`. Actions are pinned by commit. zizmor runs from a container
image whose digest is fixed by the action's commit. A tool that arrives without a digest arrives
with one in the same change.

## Renovate

**Every pin is watched by Renovate, digest included.** `.github/renovate.json` is the whole of it.
The `bun` and `github-actions` managers cover `package.json`, `bun.lock` and every `uses:`. The `uv`
manager covers yamllint in `pyproject.toml` and `uv.lock`, hashes included. The regex managers read
the `renovate:` comment above any other pin, so a new pin is watched once it is annotated.

Renovate opens two pull requests a week and no others. Monday's carries every raise, majors and
vulnerability fixes included. Tuesday's regenerates `bun.lock` and `uv.lock`, where the transitive
dependencies move. It is a pull request of its own because it changes nothing this file names. A pin
without an annotation is a pin nothing watches, and the review refuses it.

Pick the newest stable version of a tool rather than the familiar one. Read what the release
changed before taking it.

## Development setup

```bash
git clone https://github.com/Aureliolo/gdharness.git
cd gdharness
bun install
bun scripts/install-gdstyle.ts
uv sync --locked           # yamllint, into .venv
bun run build
```

Checks CI runs:

```bash
bun run ci                 # build, typecheck, format:check, lint, then the eleven test:ci files
bun run test:integration   # the bridge against a mock editor and a mock runtime
bun run test:metadata
bun run lint               # Biome, then oxlint with its type-aware rules, then knip, then markdownlint
bun run lint:gd            # gdstyle's linter
bun run format:gd:check    # gdstyle's formatter, checking only
uv run yamllint --strict .
bun run docs               # the public site, into site/; refuses a page nothing links to
```

Fixes and tools:

```bash
bun run format             # Biome for the code, Prettier for the prose and YAML (writes)
bun run format:gd          # gdstyle's formatter, writes
bun run watch              # TypeScript watch mode
```

`bun test/regressions.ts` runs every regression whether or not an earlier one failed and names the
failures at the end. That makes a disarm readable. Break the line a fixture guards and the run says
which fixtures noticed. Arguments select tests by name, loosely matched, for working on one:
`bun test/regressions.ts debugtools`.

Install the engine locally and the fixtures that need it stop skipping: `bun scripts/install-godot.ts`
and `bun scripts/install-gdunit4.ts` each print a path to export as `GODOT_PATH` and `GDUNIT4_PATH`.
Both verify a published digest and refuse anything else.

`bun run test:packaging` and `bun run release:pack` only work on Linux or macOS. Windows cannot
record a POSIX file mode, and the packer refuses there rather than ship an archive whose executables
are world-writable. Releases are cut by CI.

## Repository map

There is no JavaScript here. The server, the scripts and the tests are all TypeScript, so one type
checker covers everything Bun runs.

```text
.
├── src/
│   ├── server.ts          # The MCP server: validation and dispatch of every tool
│   ├── cli.ts             # CLI entry point: the server by default, setup, doctor, runtime, classes, test
│   ├── setup.ts           # What the CLI does to a project
│   ├── suite-run.ts       # gdharness test: a game's suites over engines, judged by suite-judge.ts
│   ├── tool-definitions.ts# Tool schemas
│   ├── headless.ts        # Running one operation of the engine script
│   ├── godot-path.ts      # Finding the engine
│   ├── game-log.ts        # What a game prints, read as problems
│   ├── junit.ts           # The JUnit report a test runner writes, read as cases
│   ├── launch.ts          # How a game is started
│   ├── spawn.ts           # Every process start, each with no window of its own
│   ├── runtime-client.ts  # Talking to a running game
│   ├── project-scan.ts    # Reading a project directory without the engine
│   ├── resources.ts       # MCP resources, and completing their paths
│   ├── prompts.ts         # MCP prompts, written as the tool calls they make
│   ├── server-instructions.ts # What a client puts in front of its agent at connect
│   ├── harnesses.ts       # Which agent harnesses setup can register the server with
│   ├── godot-bridge.ts    # Bridge transport to the editor addon
│   ├── lsp_client.ts      # Godot language server client
│   ├── dap_client.ts      # Godot debug adapter client
│   └── godot/             # GDScript, copied verbatim into the bundle
│       ├── addons/        # The Godot addons: editor, runtime, auto reload, tests
│       ├── operations/    # Headless engine operations
│       └── tests/         # The gdUnit4 runner project_test and gdharness test start
├── test/
│   └── support/           # Shared helpers, not suites
├── docs/                  # The public site's source
│   └── theme/             # Its template and stylesheet, both hand-written
└── scripts/               # Build, pack, release and site tooling
```

[release-process.md](./release-process.md) says how a release is cut, signed and verified.

The site at <https://aureliolo.github.io/gdharness> is built from `docs/` by
`scripts/build-docs.ts` and published by `.github/workflows/docs.yml`. The tool reference is
rendered from `src/tool-definitions.ts` at build time, so it says what the server says. A page added
to `docs/` has to be listed in the generator, which stops one publishing with nothing linking to it.

## Style

- British English in prose.
- No em-dashes, and no en dash or double hyphen standing in for one.
- No chatbot openers or closers and no marketing words in what ships. A regression reads every file
  for these, and its list (`HABIT_PHRASES` in `test/regressions.ts`) is the one to add to.
- Comments explain why, never what.
