# Documentation

Source of <https://aureliolo.github.io/gdharness>. `bun run docs` renders it into `site/`, which is
gitignored. The generator is `scripts/build-docs.ts`; the theme is `theme/`.

| File              | Page                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| `install.md`      | Install, verify, configure, update                                     |
| `architecture.md` | What an install writes, what connects to what, and every harness       |
| `test-runs.md`    | `gdharness test`, what fails a run, and the engine slots it shares     |
| `spread.md`       | `gdharness spread`, a bench over several engines gathered back whole   |
| `agent.md`        | The install written for an agent. Markdown only, not in the navigation |

The front page and the tool reference have no file here. Both are rendered at build time, the
first by `renderHome` and the second from `src/tool-definitions.ts`.

Every page is published as HTML and as its markdown. `llms.txt` indexes the markdown;
`llms-full.txt` is all of it in one file. A page in `docs/` that the generator does not list fails
the build.

Cutting a release is in [.github/release-process.md](../.github/release-process.md).
