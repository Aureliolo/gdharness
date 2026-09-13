# gdharness

MCP server and Godot addons for driving a Godot 4 project from an agent: the editor that is open,
the game that is running, and the project on disk.

Requires Godot 4.7.0 or newer, and Node 22 or newer for `npx`. It runs under [Bun](https://bun.sh)
1.4.0 or newer too.

```jsonc a call and its answer
runtime_inspect { "op": "rect", "nodePath": "/root/Hall/Ledger/BuyButton" }

{
  "type": "rect",
  "path": "/root/Hall/Ledger/BuyButton",
  "visible": true,
  "canvas": { "position": { "x": 812, "y": 418 }, "size": { "x": 180, "y": 34 } },
  "window": { "position": { "x": 812, "y": 418 }, "size": { "x": 180, "y": 34 } }
}
```

## Install

```bash from the project directory
npx -y gdharness@{{version}} setup . --runtime
```

Addons in, editor plugins on, class list rebuilt, and the server written into every agent harness
found on the machine. [Install](install.html) has the rest, including the signed archive for a
pinned or offline install.

To have an agent do it, paste:

```text
Install gdharness into this project by following
https://aureliolo.github.io/gdharness/agent.md, then tell me what it asked you to
recommend back to me.
```

## Three parts

**Inside Godot.** Addons installed into your project. They make the open editor and the running
game answerable, and reload the editor's view when files change on disk.

**The MCP server.** What your agent calls: {{tools}} tools and four `godot://` resources.

**The CLI.** Installs the addons, registers the server with the harnesses on the machine, checks
them, rebuilds the class cache.

[How it works](architecture.html) is what talks to what.

## Tools

{{tools}} tools, named `domain_verb`. A tool that does several related things takes an `op`. An
unknown op or argument is refused with the valid set listed. Answers are read from the engine after
the change, not echoed from the request. Engine stderr comes back under `engine_messages`.

[Tools](tools.html) is the full reference, generated from the server.

## Pages

- [Install](install.html): install, verify, configure, update.
- [How it works](architecture.html): the parts, the connections, the ports.
- [Using it](usage.html): which tools need the editor, running and reading the game.
- [Tools](tools.html): every tool, op and argument.
- [Traps](traps.html): five Godot behaviours you still have to know, and the ones handled for you.
- [What is proven](tested.html): what CI drives against a real engine, and what it does not.

For agents: every page also exists as markdown at the same name, [llms.txt](llms.txt) indexes them,
and `llms-full.txt` is all of them in one file.

## Project

Fork of [GoPeak](https://github.com/HaD0Yun/Doyunha-Gopeak) v2.3.9, September 2026, MIT, by Solomon
Elias originally and completely reworked since to be hardened, condensed and more streamlined.

Not affiliated with GoPeak or the Godot Foundation.
