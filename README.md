# gdharness

[![CI](https://github.com/Aureliolo/gdharness/actions/workflows/ci.yml/badge.svg)](https://github.com/Aureliolo/gdharness/actions/workflows/ci.yml)
[![Scorecard](https://api.scorecard.dev/projects/github.com/Aureliolo/gdharness/badge)](https://scorecard.dev/viewer/?uri=github.com/Aureliolo/gdharness)
[![SLSA Build 3](https://img.shields.io/badge/SLSA-Build%20L3-2f6f4e?style=flat)](docs/release-process.md#slsa)
[![SBOM](https://img.shields.io/badge/SBOM-SPDX-2f6f4e?style=flat)](docs/release-process.md#what-a-release-carries)
[![Signed releases](https://img.shields.io/badge/releases-Sigstore%20signed-2f6f4e?style=flat)](docs/release-process.md#verifying-a-release)
[![Release](https://img.shields.io/github/v/release/Aureliolo/gdharness?display_name=tag&sort=semver)](https://github.com/Aureliolo/gdharness/releases)
[![MCP server](https://badge.mcpx.dev?type=server 'MCP Server')](https://modelcontextprotocol.io/introduction)
[![Made for Godot 4.7+](https://img.shields.io/badge/Made%20for-Godot%204.7%2B-478CBF?style=flat&logo=godot%20engine&logoColor=white)](https://godotengine.org)
[![Bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FAureliolo%2Fgdharness%2Fmain%2Fpackage.json&query=%24.engines.bun&label=bun&color=f9f1e1&logo=bun&logoColor=black)](https://bun.sh/)
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
- **Strict projects are the baseline.** Every shipped script, and every script the tools
  write, parses with all of GDScript's warnings raised to errors, and CI parses them that
  way: a project configured like that parses the addons and the operations under its own
  settings, and a harness that will not load there is no harness.
- **Few tools, shaped like tasks.** Around 30, not 100. A server whose tool list does not
  fit in a context window has too many tools, not a missing pagination feature.
- **Answers are sized.** Anything that can return a lot takes a detail level and defaults to
  the smallest useful one; anything unbounded paginates. A tree comes back as paths, not as
  nested objects that repeat their keys a thousand times.

## Requirements

Two things, and nothing else:

- **Godot 4.7 or newer.** That is the version CI drives every fixture against, on Linux,
  Windows and macOS. Older engines are not supported and will not be: the work in front of this
  wants `UDSServer` for the runtime bridge and the 4.7 input device ids, and carrying shims for
  engines nobody here tests against is how a harness starts lying about what it verified.
- **Bun 1.4.0 or newer.** 1.4 is the floor because the lockfile is `lockfileVersion: 2`,
  which older Bun cannot read.

Then point any MCP client at it. gdharness installs the Godot addons into your project
itself; there is nothing to copy by hand, no Python, and no Node.

## Setting up a project

```sh
gdharness setup /path/to/project             # the addons in, the editor ones enabled, the class list rebuilt
gdharness setup /path/to/project --runtime   # and the runtime autoload registered
gdharness doctor /path/to/project            # what holds and what does not; exit 1 on a problem
gdharness runtime on|off /path/to/project    # the runtime autoload, which reaches an export if left on
gdharness classes /path/to/project           # rebuild .godot/global_script_class_cache.cfg from disk
```

`setup` copies each addon whole, over whatever was there, and writes the version it came
from beside it, so an upgrade never leaves a file of the old version behind and `doctor` can
tell an old copy from the shipped one. `doctor` also compares every `class_name` on disk with
the class cache, which is the check the editor cannot make for itself. Every write to
`project.godot` goes through the engine, so the file is written the way the editor writes it.

The runtime addon is an autoload and nothing else. An autoload reaches an export, and its
command set includes calling methods and injecting input, so it is registered only when asked
for and refuses to serve outside a debug build.

## Tools

Thirty-two, named `domain_verb`. A tool that does several related things takes an `op`, and
its description says which arguments each op needs; a call with an argument the tool does not
name, an op it does not have, or a required argument missing is refused with the valid set
spelled out. Every answer is JSON, read back from the engine after the change rather than
echoed from the request, and anything the engine said on stderr on the way comes back with it
under `engine_messages`.

| Domain       | Tools                                                                            |
| ------------ | -------------------------------------------------------------------------------- |
| `project_*`  | `list`, `info`, `settings`, `search`, `dependencies`, `import`, `export`, `test` |
| `scene_*`    | `create`, `tree`, `node`, `signal`, `animation`                                  |
| `script_*`   | `edit`, `info`, `diagnostics`                                                    |
| `resource_*` | `edit`                                                                           |
| `editor_*`   | `launch`, `run`, `stop`, `output`, `status`, `rescan`, `classes`                 |
| `runtime_*`  | `inspect`, `invoke`, `capture`, `input`, `wait`                                  |
| `debug_*`    | `breakpoint`, `control`, `state`                                                 |

The `runtime_*` tools ask the game rather than the tree dump: `runtime_inspect find` answers
with the paths of the nodes matching a class, script, name pattern or group, `rect` with where
one is on screen in window pixels, `runtime_input click` presses and releases a Control by
path and says what was under the pointer and what became of the control (a menu button that
opens the next screen takes itself out of the tree, and the answer says so), and
`runtime_wait` lets frames pass or waits for a signal or a property before answering. A
node-valued property comes back as its path, so an answer can be fed straight into the next
call.

The `scene_*` and `resource_*` tools and `editor_rescan` go through the editor addon and need
the editor open; `script_diagnostics`, `script_info` beyond `structure`, and the `debug_*`
tools talk to the editor's language server and debug adapter; the `runtime_*` tools talk to
a running game, whether `editor_run` started it or the editor's play button did. Everything
else runs the engine headless and needs nothing open.

What a game prints comes back as entries rather than lines: `editor_output` reads the engine's
`ERROR:`, `SCRIPT ERROR:` and `WARNING:` headlines with the `at:` line and backtrace under each,
answers with the counts and a `clean` verdict, and filters by severity, by text, or to what has
arrived since the last call. `editor_run check` boots the project headless for a few frames,
waits for it to quit and answers whether it came up clean, which is the boot gate a commit hook
otherwise does by hand with a grep. The engine's own stdin debugger is never turned on: it
breaks into a prompt on the first script error and, with no terminal to read from, never comes
back.

`project_test` runs the project's gdUnit4 suites headless and answers with every case rather
than a console to read: which failed, at what line, and what the assertion said, along with
anything the engine printed on the way. The class list is rebuilt before the run, because the
runner is itself a set of `class_name`s the engine has to resolve, and so is any suite written
since the editor last scanned.

`project_import refresh_classes` rewrites `.godot/global_script_class_cache.cfg` from the
`class_name` declarations on disk. The editor fixes that list at startup and refreshes it only on
a filesystem scan it does not always run (godotengine/godot#42786), and a game started from a
stale editor cannot resolve any class written since; the rebuilt file is the one the engine reads
at boot, and the answer says which classes were added, removed or changed.

A game finds its own port: the runtime addon listens on whatever the operating system hands
out and announces the port in a file named by its process id, under `$GDHARNESS_RUNTIME_DIR`,
else `$XDG_RUNTIME_DIR/gdharness`, else the temporary directory. The server reads that, so two
games can run at once (`projectPath` picks one) and a headless operation never takes the port
a game wanted. `editor_status` lists every game it can reach and why it cannot reach the rest.

## Security

An MCP server is a program you hand an agent, and it usually arrives as an unsigned tarball of
unpinned dependencies. Every claim below is one you can check rather than take on trust.

**What it does on your machine.** The runtime bridge binds `127.0.0.1` and refuses to listen at
all outside a debug build, because its command set includes calling arbitrary methods, setting
arbitrary properties and injecting input, none of it authenticated. No exported game serves it.
Every subprocess is spawned with `execFile` and an argument array, never a shell: there is no
string for a path full of quotes or backslashes to escape out of.

**What the release is.** Each one carries an SPDX SBOM and a Sigstore build-provenance
attestation over the archive, its checksum and the SBOM. The signing is keyless, so there is no
signing key anywhere, including in CI, and it runs in a reusable workflow isolated from the
build, which is [SLSA Build Level 3](docs/release-process.md#slsa). Published releases are
immutable. Verify one before you install it:

```bash
gh attestation verify gdharness-X.Y.Z.tgz --repo Aureliolo/gdharness
```

**What goes into it.** Every dependency is an exact version and every GitHub action is pinned by
commit digest. No carets, no ranges, no floating tags; the only version ranges in the repository
are the two support floors above. Nothing fetched from outside the repository runs unchecked:
the engine CI drives the fixtures against, the Bun that runs every job, uv, the interpreter and
gdtoolkit under it, and actionlint are each refused unless they match a digest written here, and
the npm packages carry theirs in the lockfile. Renovate proposes the bumps, digests included, in
one pull request a week, and a human takes them.

**What guards the branch.** `main` takes pull requests only, with linear history and nine
required status checks: the build and its tests, both formatters, both linters, the GDScript
lint, and the engine fixtures on Linux, Windows and macOS. Every job CI runs is one of them, so
there is no check that can be red at the moment something merges. Nobody can bypass it, and every
commit on every branch has to be signed. CodeQL, OpenSSF Scorecard, actionlint, zizmor and secret
scanning run against every change, and zizmor's findings fail the build rather than filing a
ticket somebody has to notice.

Found something? [SECURITY.md](.github/SECURITY.md) says how to report it.

## Building

```bash
bun install
bun run build
bun run ci
```

## Licence

MIT. Copyright (c) 2025 Solomon Elias for the original work, and Aurelio Amoroso for changes
since the fork. See [LICENSE](LICENSE).

This project is not affiliated with or endorsed by the GoPeak project or the Godot
Foundation.
