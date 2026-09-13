# Documentation

These files are the source of <https://aureliolo.github.io/gdharness>. `bun run docs` renders them
into `site/`, which is gitignored; `scripts/build-docs.ts` is the whole of the generator and
`theme/` is the whole of the theme.

- [index.md](./index.md): what gdharness is and the rules it is built to.
- [install.md](./install.md): how to install it, written for the agent doing it.
- [traps.md](./traps.md): what Godot does that costs an afternoon.
- [release-process.md](./release-process.md): how a release is cut, signed and verified.

The tool reference has no file here: it is rendered from `src/tool-definitions.ts` at build time,
so it cannot drift from what the server answers.
