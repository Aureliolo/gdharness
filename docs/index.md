# A harness for driving Godot from an agent

gdharness is an MCP server that hands an agent the three things it otherwise has to guess at: the
editor that is open, the game that is running, and the project on disk. Thirty-two tools, each
shaped like a task rather than an engine call, and every answer read back from the engine rather
than echoed from the request.

- **The editor.** Scenes, nodes, signals, resources and animations, changed inside the editor you
  already have open, and read back out of the file it wrote.
- **The running game.** The live tree, a node's rectangle, a method called, a signal waited for, a
  button clicked. Headless included, where there is no window to click in.
- **The project.** Settings, autoloads, imports, exports, dependencies, the class cache, the test
  tier and ClassDB, off a short-lived engine that opens nothing.

## What it is for

An agent editing a Godot project without this is working from the source text alone. It can read a
`.tscn` file, but it cannot ask what the scene actually contains; it can write a script, but it
cannot ask the engine whether that script parses; it can change a screen, but it cannot look at the
screen. Every one of those gaps gets filled by guessing, and the guesses are what cost the
afternoon.

gdharness closes them by asking the engine. The editor answers about scenes, its language server
answers about scripts, its debugger holds the game it plays, and the game itself answers about what
is on screen right now.

## The rules it is built to

- **No fixture, no ship.** Every tool is driven against a pinned Godot in CI before it exists in a
  release. Anything nobody will write a fixture for is cut instead of shipped.
- **A tool fails rather than answers.** No success payload for an empty or partial result that
  could be a silent failure. An unknown argument or an unknown enum value is an error naming the
  valid set, never a silent default.
- **Every mutation reads back.** A tool that writes returns the engine's actual state afterwards,
  read from the engine, never an echo of the request.
- **Strict projects are the baseline.** Every shipped script, and every script the tools write,
  parses with all of GDScript's warnings raised to errors.
- **Few tools, shaped like tasks.** Around thirty, not a hundred. A server whose tool list does not
  fit in a context window has too many tools, not a missing pagination feature.
- **Answers are sized.** Anything that can return a lot takes a detail level and defaults to the
  smallest useful one; anything unbounded paginates.

## What it needs

Godot 4.7 or newer, and [Bun](https://bun.sh) to run the server. The editor addons are installed
into your project by `gdharness setup`, and nothing else is required: no global install, no
`PATH` entry, no ambient project. Every tool call names the project it is about.

## Getting it

The whole of it is on the [Install](install.html) page, written for the agent that will do it.
If you would rather hand the job over, paste this into any agent that speaks MCP:

```text
Install gdharness into this project by following
https://aureliolo.github.io/gdharness/install.html, then tell me what it asked you to
recommend back to me.
```

There are no one-click install links here, deliberately. A link that configures an editor for you
is the exact shape of a known attack, and a line of text the agent reads is just as convenient
without teaching anybody that clicking one is safe.

## Where the rest is

[Tools](tools.html) is the reference, generated from the server itself, so it says what the server
says. [Traps](traps.html) is what Godot does that costs an afternoon and what to do instead.
[Release process](releases.html) is how a release is built, signed and verified by whoever installs
it.

gdharness is a fork of [GoPeak](https://github.com/HaD0Yun/Doyunha-Gopeak), rebuilt to be complete,
hardened and actually tested.
