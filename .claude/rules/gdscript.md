---
paths:
  - 'src/godot/**'
  - 'test/support/gd/**'
  - 'scripts/sync-shared-gd.ts'
---

# GDScript

Run `test:typed` after any GDScript change. gdstyle passes a script the engine refuses with warnings
as errors. The regressions load the addons under the default warnings. A runtime addon can pass them
locally and fail to compile on the Linux engine leg. The fixtures in `test/support/gd` must also
compile under the strict settings, not only in a scratch project with default warnings.

Every name a shipped script declares in a class's casing (a preloaded module, an inner class, an
enum) starts with `Gdh`. Godot resolves a type as the project's global class or autoload before the
script's own constant. A game with `class_name Log` or an autoload called `Log` breaks every module
that preloads its logger as `Log`. The engine leg's `ourNames` case refuses a name without the
prefix. It also compiles the shipped scripts beside a class and an autoload for each name.

## Shared modules and packaging

The modules listed in `scripts/sync-shared-gd.ts` (`reading.gd`, `serialisation.gd`,
`value_shapes.gd`, `property_values.gd`, `property_paths.gd`, `declared_values.gd`,
`same_values.gd`, `file_reads.gd`, `file_walk.gd`, `animation_reads.gd`, `setting_reads.gd` and
`picture_saves.gd`) are edited in `src/godot/operations/` only. `bun run sync:gd` writes the copies
inside the addons. A regression fails on a copy that has drifted.

Commit the `.gd.uid` Godot writes beside every new addon script. Add a new operations module to the
list in `test/packaging-consistency.ts`. `test:packaging` checks both, on Linux and macOS only. From
Windows, the push is the first run that sees them.
