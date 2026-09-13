# Make the engine answer

Drive a Godot 4 project from an agent: the editor that is open, the game that is running, and the
project on disk. An agent cannot see a running game; this makes one answerable.

Godot 4.7 or newer, and Node 22 or newer for `npx`. It runs under [Bun](https://bun.sh) 1.4 too.

## Hand it to your agent

```text paste this
Install gdharness into this project by following
https://aureliolo.github.io/gdharness/agent.md, then tell me what it asked you to
recommend back to me.
```

It reads the guide, installs the addons, writes the config for the harness it is running in, and
reports the two things it cannot do for itself.

## Or do it yourself

Pick your harness. It is the same command every time; what changes is the file it writes.

{{picker}}

With no harness named it asks about each one it finds, here or on this machine, and writes nothing
outside the project directory without a flag or a typed yes. [How it works](architecture.html) has
every harness it knows.

## One call, and its answer

```jsonc
runtime_inspect { "op": "rect", "nodePath": "/root/Hall/Ledger/BuyButton" }

{
  "type": "rect",
  "path": "/root/Hall/Ledger/BuyButton",
  "visible": true,
  "canvas": { "position": { "x": 812, "y": 418 }, "size": { "x": 180, "y": 34 } },
  "window": { "position": { "x": 812, "y": 418 }, "size": { "x": 180, "y": 34 } }
}
```

## Three parts

**Inside Godot.** Three addons in your project. They make the open editor and the running game
answerable, and reload the editor's view when files change on disk.

**The MCP server.** What your agent calls: {{tools}} tools named `domain_verb`, and four
`godot://` resources. An unknown op or argument is refused with the valid set listed, and every
answer is read back from the engine rather than echoed from the request.

**The CLI.** Installs the addons, writes the skill, registers the server, checks all of it, and
takes it back out again.

## Pages

- [Install](install.html): install, verify, update, uninstall.
- [How it works](architecture.html): what an install writes, how it decides, and what talks to what
  once it is running.
- [Tools](tools.html): every tool, op and argument.
- [Traps](traps.html): five Godot behaviours you still have to know, and the ones handled for you.
- [What is proven](tested.html): what CI drives against a real engine, and what it does not.

For agents: every page also exists as markdown at the same name, [llms.txt](llms.txt) indexes them,
and `llms-full.txt` is all of them in one file.

## Project

Fork of [GoPeak](https://github.com/HaD0Yun/Doyunha-Gopeak) v2.3.9, September 2026, MIT, by Solomon
Elias originally and completely reworked since to be hardened, condensed and more streamlined.

Not affiliated with GoPeak or the Godot Foundation.
