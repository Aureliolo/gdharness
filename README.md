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

**A harness for driving a Godot 4 project from an agent.** An MCP server that hands the agent the
three things it otherwise has to guess at: the editor that is open, the game that is running, and
the project on disk. Thirty-two tools, each shaped like a task rather than an engine call, and
every answer read back from the engine rather than echoed from the request.

📖 **[Documentation](https://aureliolo.github.io/gdharness)** — what it is, how to install it, every
tool, and what Godot does that costs an afternoon.

## Installing

Godot 4.7 or newer and [Bun](https://bun.sh) 1.4 or newer, and nothing else: gdharness installs the
Godot addons into your project itself, and there is no Python and no Node.

[Install](https://aureliolo.github.io/gdharness/install.html) is the whole of it, written for the
agent doing the work, including verifying the release before running it. The short version:
download a release, check its attestation, point your MCP client at `build/index.js` with
`GODOT_PATH` set, then `gdharness setup /path/to/project`.

There are no one-click install links, deliberately. A link that configures an editor for you is the
exact shape of a known attack; a line of text the agent reads is as convenient without teaching
anybody that clicking one is safe.

## Rules

- **No fixture, no ship.** Every tool is driven against a pinned Godot in CI before it exists in
  a release. Anything nobody will write a fixture for is cut instead of shipped.
- **A tool fails rather than answers.** No success payload for an empty or partial result that
  could be a silent failure. An unknown argument or an unknown enum value is an error naming the
  valid set, never a silent default.
- **Every mutation reads back.** A tool that writes returns the engine's actual state afterwards,
  read back from the engine, never an echo of the request.
- **Strict projects are the baseline.** Every shipped script, and every script the tools write,
  parses with all of GDScript's warnings raised to errors, and CI parses them that way: a project
  configured like that loads the addons and the operations under its own settings, and a harness
  that will not load there is no harness.
- **Few tools, shaped like tasks.** Around thirty, not a hundred. A server whose tool list does not
  fit in a context window has too many tools, not a missing pagination feature.
- **Answers are sized.** Anything that can return a lot takes a detail level and defaults to the
  smallest useful one; anything unbounded paginates. A tree comes back as paths, not as nested
  objects that repeat their keys a thousand times.

## Security

An MCP server is a program you hand an agent, and it usually arrives as an unsigned tarball of
unpinned dependencies. Every claim here is one you can check rather than take on trust.

**What it does on your machine.** The runtime bridge binds `127.0.0.1` and refuses to listen at all
outside a debug build, because its command set includes calling arbitrary methods, setting
arbitrary properties and injecting input, none of it authenticated. No exported game serves it.
Every subprocess is spawned with an argument array, never a shell: there is no string for a path
full of quotes or backslashes to escape out of.

**What the release is.** Each one carries an SPDX SBOM and a Sigstore build-provenance attestation
over the archive, its checksum and the SBOM. The signing is keyless, so there is no signing key
anywhere, including in CI, and the whole build runs in one reusable workflow whose identity the
certificate carries, which is [SLSA Build Level 3](docs/release-process.md#slsa). Published
releases are immutable.

```bash
gh attestation verify gdharness-X.Y.Z.tgz --repo Aureliolo/gdharness \
  --signer-workflow Aureliolo/gdharness/.github/workflows/release-build.yml
```

**What goes into it.** Every dependency is an exact version and every GitHub action is pinned by
commit digest. No carets, no ranges, no floating tags; the only version ranges in the repository
are the two support floors above. Nothing fetched from outside the repository runs unchecked: the
engine CI drives the fixtures against, the Bun that runs every job, uv, the interpreter and
gdtoolkit under it, and actionlint are each refused unless they match a digest written here, and
the npm packages carry theirs in the lockfile. Renovate proposes the bumps, digests included, in
one pull request a week, and a human takes them.

**What guards the branch.** `main` takes pull requests only, with linear history and nine required
status checks: the build and its tests, both formatters, both linters, the GDScript lint, and the
engine fixtures on Linux, Windows and macOS. Every job CI runs is one of them, so there is no check
that can be red at the moment something merges. Nobody can bypass it, and every commit on every
branch has to be signed. CodeQL, OpenSSF Scorecard, actionlint, zizmor and secret scanning run
against every change, and zizmor's findings fail the build rather than filing a ticket somebody has
to notice.

Found something? [SECURITY.md](.github/SECURITY.md) says how to report it.

## Working on it

```bash
bun install
bun run build
bun run ci
bun run docs          # the site, into site/
```

[CONTRIBUTING.md](.github/CONTRIBUTING.md) is what a change has to clear, and what every language
in here is held to.

## Licence

MIT. Copyright (c) 2025 Solomon Elias for the original work, and Aurelio Amoroso for changes since
the fork. See [LICENSE](LICENSE).

Forked from [GoPeak](https://github.com/HaD0Yun/Doyunha-Gopeak), rebuilt to be complete, hardened
and actually tested. This project is not affiliated with or endorsed by the GoPeak project or the
Godot Foundation.
