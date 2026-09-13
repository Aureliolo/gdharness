# What is proven

## What CI runs

Against a pinned Godot on Linux, Windows and macOS, for every change.

| Tier            | What it drives                                                                                                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editor fixtures | A headless editor on a temporary project: scenes built node by node, signals, animations with property and method tracks, resources, language server diagnostics and symbols, breakpoints and stepping, and a game the editor plays, inspected, clicked and waited on |
| Engine          | Every headless operation against a real engine, checked against what it wrote to `project.godot`, a `.tres`, or the class cache                                                                                                                                       |
| Consistency     | Every command the server sends exists on the side that answers it, every command that side answers is sent by something, every argument an operation reads is one a tool can send, every argument a tool declares is read by something                                |
| Fast            | Protocol framing under fuzzing, the release archive, the registry metadata, the project parsers                                                                                                                                                                       |

Results are checked against the file the engine wrote or the state of the running game, not against
the answer the tool returned.

The editor fixture uses its own user directory and its own LSP and DAP ports, so a run does not
touch the editor settings or ports of the machine it runs on.

## Checks are proven to fail

Each check was verified by breaking what it watches and confirming it reported: a dispatch name
misspelled, an operation reading an argument nobody sends, a connection saved without
`CONNECT_PERSIST`, a path spelled the way Windows spells it in a temporary directory.

## Not tested

|                      | Why                                             | What is tested instead             |
| -------------------- | ----------------------------------------------- | ---------------------------------- |
| `runtime_capture`    | No CI machine has a display                     | That it refuses in a headless game |
| `editor_launch open` | Would leave an editor running on the CI machine | The command line it builds         |

## Removed rather than documented

`debug_control pause` was removed after measurement: Godot answers the request, reports the game as
stopped, and leaves it running.

`debug_control step_out` went the same way. The request times out, because Godot's adapter parser
implements `req_next` and `req_stepIn` and nothing for `stepOut`. A fixture asks for the op and
expects the refusal, so an engine that grows one is noticed rather than left unused.

## Where to look

- [`ci.yml`](https://github.com/Aureliolo/gdharness/blob/main/.github/workflows/ci.yml). Every job
  is a required check.
- [CONTRIBUTING](https://github.com/Aureliolo/gdharness/blob/main/.github/CONTRIBUTING.md). What a
  change has to clear, and what each language in the repository is held to.
