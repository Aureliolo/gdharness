# Documentation

Source of <https://aureliolo.github.io/gdharness>. `bun run docs` renders it into `site/`, which is
gitignored. The generator is `scripts/build-docs.ts`; the theme is `theme/`.

| File              | Page                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| `index.md`        | Front page                                                             |
| `install.md`      | Install, verify, configure, update                                     |
| `architecture.md` | What connects to what, and the ports                                   |
| `usage.md`        | What has to be running for which tools                                 |
| `traps.md`        | Godot behaviours that affect use                                       |
| `tested.md`       | What CI covers and what it does not                                    |
| `agent.md`        | The install written for an agent. Markdown only, not in the navigation |

The tool reference has no file here. It is rendered from `src/tool-definitions.ts` at build time.

Every page is published as HTML and as its markdown. `llms.txt` indexes the markdown;
`llms-full.txt` is all of it in one file. A page in `docs/` that the generator does not list fails
the build.

Cutting a release is in [.github/release-process.md](../.github/release-process.md).
