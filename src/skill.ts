/**
 * The skill gdharness writes into a project, in the format every major harness now reads.
 *
 * `.agents/skills/` is the cross-tool convention, and the reason this is one folder rather than an
 * integration per harness: Codex looks nowhere else, and Cursor, VS Code, Copilot, Gemini CLI,
 * opencode, Junie, Windsurf and Hermes all read it too. The three that do not, Claude Code, Kiro
 * and Cline, get a copy in their own directory.
 *
 * It is written rather than documented because the alternative is every agent rediscovering the
 * same five Godot behaviours by hitting them, which is what this project exists to stop.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Harness } from './harnesses.js';
import { BIND_ADDRESS_SETTING, PORT_SETTING, SCRIPT_RUNS_SETTING } from './setup.js';
import { projectPathSentence, TOOL_SPECS } from './tool-definitions.js';
import { renderToolsMarkdown } from './tool-reference.js';

/** The skill's name, which is also its directory. The format requires them to match. */
export const SKILL_NAME = 'gdharness';

/** The directory every harness that follows the convention reads, relative to the project. */
export const SHARED_SKILLS = join('.agents', 'skills');

function skillMarkdown(version: string): string {
  return `---
name: ${SKILL_NAME}
description: Drive a Godot 4 project through the gdharness MCP server: run the game from the open editor, read what is on screen, set breakpoints, and edit scenes, scripts and resources. Use whenever the question is what the engine or the running game actually does, rather than what the source says it should do.
license: MIT
metadata:
  version: "${version}"
---

# gdharness

An MCP server and three Godot addons. Together they answer about the editor that is open, the game
that is running, and the project on disk. ${TOOL_SPECS.length} tools, named \`domain_verb\`.

\`references/tools.md\` is every tool, op and argument.

## Start here

- ${projectPathSentence()}. The \`runtime_*\` and \`debug_*\` ones pick between running
  games instead, by \`projectPath\`, or by \`pid\` when several run from one project, as a bench
  and its workers do; the others answer about the editor this server is connected to. There is no
  ambient project, and an argument a tool does not declare is refused rather than ignored.
- \`editor_status\` says whether an editor is connected and whether its addon matches the server.
  \`addonIsStale\` means they differ, and \`staleNote\` says which half is behind: an editor that
  needs restarting, or a server that needs reconnecting in your harness. Every answer that came
  from the editor carries the same two when they differ, so a stale addon cannot answer quietly:
  believe a restart over a diagnostic that arrived with them.
- Start the game with \`editor_run start\`, never by spawning an engine. The editor plays it, so
  its debugger holds it, which is what gives the \`debug_*\` tools something to talk to. Its answer
  says under \`runtime\` whether the game can be talked to yet; when it cannot, \`mayYetAnnounce\`
  false is a runtime that is not coming and true is a game still on its way up.
- Read \`editor_output\` after every run. It returns the engine's errors and warnings as entries
  with their backtraces, and a \`clean\` verdict, so a run that printed an error is one call away
  from being known. For a long run it also names a transcript file: read that for output and this
  answer for state. Never decide a run has ended by watching the file stop growing, or a process
  list, or a timeout; a bench between prints looks exactly like a bench that died to everything else.
  \`endedBy\` says whether gdharness ended it, and \`running\` is asked of the operating system
  whenever there is a process to ask about: every run started through \`editor_run\`, and every
  editor-played run whose game announced its runtime. An editor-played run in a project with no
  runtime addon announces nothing, so there is no process id and \`running\` is the editor's answer,
  which can lag by seconds after the game has gone. \`editor_status\` names the game under
  \`runtimes\`, which does not depend on the editor answering.
- One server, one editor. A second project is a second harness session with its own server, and
  that works: each editor is opened on its own language server and debug adapter ports, and says
  where it serves. Two editors on one project is the thing to refuse.

## Measuring a running game

| Ask | Tool |
| --- | --- |
| What a screen says | \`runtime_inspect text\`, which reads what is drawn and leaves out what is hidden. Read \`omitted\`: a long list above a dialog pushes it past the limit, and what comes back then is the top of the screen rather than the screen |
| Find a control by the word on it | \`runtime_inspect find\` with \`says\`, rather than listing a screen and reading each one |
| What a control is showing | \`runtime_inspect find\` with \`property\` as well: the value comes back on each match in the same answer, so the game cannot tick between finding the node and reading it. A \`find\` followed by a \`property\` read of the path it answered is two calls with a frame between them, and a panel that rebuilds itself answers the second with "Node not found" |
| Where a control is, and whether it is visible | \`runtime_inspect\` \`find\`, \`rect\` |
| What a property reads right now, on a node whose path you already hold | \`runtime_inspect\` \`property\`, \`runtime_invoke\` |
| What a property on an object a node holds reads | the same two, with colons: \`_game:clock:speed\` |
| Press a button | \`runtime_input click\`, which says what was under the pointer |
| Press the next thing after a click that changed screen | \`runtime_wait until\` with \`says\` and a word the new screen shows, then the click. A click sent straight after a screen change lands on a control the new screen is about to free, answers \`landed: true\`, and does nothing; a frame count is a number nobody can pick correctly across a cold start and a warm one, and waiting for the words answered in about 130ms where twenty frames had not been enough |
| Fill in a field | \`runtime_input click\` on it, then \`runtime_input text\` with \`replace\`; a submitted field has to be clicked again |
| Click somebody standing in a 3D room | \`runtime_input click\` on the Node3D, which aims at what it draws |
| Pick something out of a dropdown | \`runtime_input choose\` on it, by what the item says |
| Answer a dialog | \`runtime_input click\` on its button, or \`key\` Escape to dismiss it: an [AcceptDialog] reads that key itself and never asks the InputMap, so \`ui_cancel\` leaves it standing |
| Press a bound key | \`runtime_input action\` or \`key\`, a whole press unless you hold it |
| Where a 3D node is on screen | \`runtime_inspect\` \`rect\`, rather than unprojecting by hand |
| Wait for something in a running game | \`runtime_wait\`, never a sleep; \`until\` with \`says\` for a panel that rebuilds its own labels |
| Wait for a run to finish | \`editor_run wait\`, never a sleep or a shell loop on the pid: it answers as \`editor_output\` does, once the run is over |
| A picture, for a person who asked to see one | \`runtime_capture\` |

These need the runtime autoload, which \`gdharness setup\` registers. \`runtime_capture\` needs a
window and refuses headless rather than handing back the last frame anything drew.

The autoload reads these settings and no others. \`${BIND_ADDRESS_SETTING}\`
is \`127.0.0.1\` and should stay there: the command set includes \`call_method\`, \`set_property\`
and input injection, none of it authenticated, and Godot's own \`listen()\` defaults to every
interface rather than to loopback, so this is named on purpose rather than left out.
\`${PORT_SETTING}\` is 0, meaning the operating system picks one and the game announces it, which is
what the server reads; fix it only for a client that cannot read the announcement.

A headless game answers; a \`godot -s\` script run does not, by default. It has no game in it, so the
autoload stays quiet there rather than announcing a test tier as the project: a gate starting sixteen
engines would otherwise announce sixteen games that are not games. Set \`${SCRIPT_RUNS_SETTING}\`
true in \`project.godot\` to serve one anyway, which is for driving a \`-s\` script on purpose. Read
that setting rather than assuming the quiet: it is a default and not a property of script runs.

The autoload reaches an export. \`gdharness runtime off\` in the project before shipping.

## At a breakpoint

\`debug_state variables\` reads what is in scope. \`debug_control step_over\` and \`step_into\`
move. There is no pause and no step out: Godot's debug adapter implements neither, so use a
breakpoint on the line you want instead.

## Editing

\`scene_tree\` for what a scene holds, rather than what the \`.tscn\` text implies. \`scene_node\`,
\`scene_signal\` and \`resource_edit\` change it through the editor, so the files keep their
formatting. \`script_diagnostics\` and \`script_info\` come from the editor's own language server.

\`project_info\`, \`project_dependencies\`, \`project_settings\`, \`project_import\`,
\`project_export\`, \`project_test\`, \`script_edit\`, \`script_info structure\` and
\`editor_classes\` need nothing open: they run a short headless engine and are gone before the
answer is printed. \`project_settings get\` is on that list too, reading as it does like a look at
a config file: it starts an engine so that a setting nobody wrote down still answers with the
default the engine registers for it.

Editing a file while a game is running does not change the running game. \`auto_reload\` is an
editor plugin and reloads into the editor's own process; the game is a separate process holding
its own copy. So a long run is not a reason to stop editing, and the new code arrives on the next
\`editor_run start\`.

A wall of "Could not find type" on the project's own classes means the editor is not holding
them. \`editor_rescan\` asks it to scan and names any class it still cannot resolve under
\`unseenByEditor\`: its walk skips a file a headless engine has already imported, so the
declaration and the cache can both be right while the editor stays blind to it. Rescan again on
its own, which is the measured cure and needs no change to the declaring script; \`editor_launch
restart\` also does it and costs a window.

The scan writes \`.godot/global_script_class_cache.cfg\` from the list the editor is holding, so
a class it cannot resolve would go out of that file with it. The answer names that loss under
\`cacheLost\` and rebuilds the cache from the declarations on disk, naming what came back under
\`cacheRestored\`, so no fresh engine, CI run or clone inherits the short file. That is the same
class \`unseenByEditor\` names, and the loss is not a reason to refuse the scan.

A diagnostic about a member rather than a type, \`Static function "x()" not found in base "Y"\`
about something the engine compiles, is a different thing and is no longer stale here: each ask
gives the document back when its answer arrives, so the next one is read off disk. If one turns
up anyway, believe the run over the diagnostic and say so.

## Refusals are useful

An unknown op, an argument the tool does not name, or a missing required one is refused with the
valid set spelled out, so a call that succeeded is a call that was understood.

A tool that cannot answer says which state it is in and what changes it, rather than answering
emptily: no game running, a game with no debugger behind it, a game running rather than stopped, a
control outside a headless viewport. Read the refusal instead of retrying the call.

Every answer is read back from the engine after the change rather than echoed from the request, and
whatever the engine said on stderr comes back under \`engine_messages\`.

## More

- \`references/tools.md\`: every tool, generated from the server.
- <https://aureliolo.github.io/gdharness>: what an install writes, and what talks to what.
`;
}

/** The skill's files, by path relative to the skill's own directory. */
export function skillFiles(version: string): ReadonlyMap<string, string> {
  return new Map([
    ['SKILL.md', skillMarkdown(version)],
    [join('references', 'tools.md'), renderToolsMarkdown()],
  ]);
}

/**
 * Where the skill goes for a given set of harnesses.
 *
 * The shared directory always, because it is what most of them read and what the rest can be
 * pointed at. A harness's own directory as well when it does not read the shared one, or when this
 * project already keeps skills there, since that is where its author will look.
 */
export function skillDirectories(
  harnesses: readonly Harness[],
  projectPath: string,
  exists: (path: string) => boolean,
): readonly string[] {
  const directories = [join(projectPath, SHARED_SKILLS, SKILL_NAME)];
  for (const harness of harnesses) {
    if (harness.skills === undefined) {
      continue;
    }
    const own = join(projectPath, harness.skills.dir);
    if ((!harness.skills.shared || exists(own)) && !directories.includes(join(own, SKILL_NAME))) {
      directories.push(join(own, SKILL_NAME));
    }
  }
  return directories;
}

/**
 * Every directory a skill could have been written into, whether or not this run would choose it.
 *
 * Uninstalling has to find what an older version wrote, or what was written when a different set
 * of harnesses was set up here, so it looks everywhere rather than only where it would write now.
 */
export function everySkillDirectory(projectPath: string, harnesses: readonly Harness[]): readonly string[] {
  const directories = new Set([join(projectPath, SHARED_SKILLS, SKILL_NAME)]);
  for (const harness of harnesses) {
    if (harness.skills !== undefined) {
      directories.add(join(projectPath, harness.skills.dir, SKILL_NAME));
    }
  }
  return [...directories];
}

/** The skill taken out of wherever it was put, naming only what was actually there. */
export function removeSkill(directories: readonly string[], projectPath: string): readonly string[] {
  const removed: string[] = [];
  for (const directory of directories) {
    if (existsSync(directory)) {
      rmSync(directory, { recursive: true, force: true });
      pruneEmpty(dirname(directory), projectPath);
      removed.push(directory);
    }
  }
  return removed;
}

/**
 * The directories that held the skill and now hold nothing.
 *
 * Only the ones gdharness itself creates: the `skills` folder it wrote into, and the shared
 * `.agents` above it. A harness's own directory is that harness's, empty or not, and removing it
 * would be deleting somebody else's folder rather than uninstalling ours.
 */
function pruneEmpty(directory: string, projectPath: string): void {
  const shared = join(projectPath, '.agents');
  let path = directory;
  while (path !== projectPath && (basename(path) === 'skills' || path === shared)) {
    if (readdirSync(path).length > 0) {
      return;
    }
    // Recursive even though it is empty: a plain unlink refuses a directory on Windows.
    rmSync(path, { recursive: true, force: true });
    path = dirname(path);
  }
}

export interface SkillWritten {
  readonly path: string;
  readonly replaced: boolean;
}

/** The skill written into each directory, replacing any copy already there. */
export function writeSkill(directories: readonly string[], version: string): readonly SkillWritten[] {
  const files = skillFiles(version);
  return directories.map((directory) => {
    const replaced = existsSync(directory);
    // Removed rather than merged: a stale reference file left beside a new SKILL.md is a tool list
    // that describes a server nobody is running.
    rmSync(directory, { recursive: true, force: true });
    for (const [name, contents] of files) {
      const path = join(directory, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents, 'utf8');
    }
    return { path: directory, replaced };
  });
}
