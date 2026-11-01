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
import {
  BIND_ADDRESS_SETTING,
  PORT_SETTING,
  QUIET_SCENES_SETTING,
  RUNTIME_AUTOLOAD,
  SCRIPT_RUNS_SETTING,
} from './setup.js';
import { projectPathSentence, TOOL_SPECS, theGamePicked } from './tool-definitions.js';
import { renderToolsMarkdown } from './tool-reference.js';

/** The skill's name, which is also its directory. The format requires them to match. */
export const SKILL_NAME = 'gdharness';

/** The directory every harness that follows the convention reads, relative to the project. */
export const SHARED_SKILLS = join('.agents', 'skills');

const SKILL_DESCRIPTION =
  'Drive a Godot 4 project through the gdharness MCP server: run the game from the open editor, ' +
  'read what is on screen, set breakpoints, and edit scenes, scripts and resources. Use whenever ' +
  'the question is what the engine or the running game actually does, rather than what the source ' +
  'says it should do.';

function skillMarkdown(version: string): string {
  // Quoted, because a colon followed by a space inside a plain YAML value starts a mapping.
  return `---
name: ${SKILL_NAME}
description: ${JSON.stringify(SKILL_DESCRIPTION)}
license: MIT
metadata:
  version: "${version}"
---

# gdharness

An MCP server and four Godot addons. Together they answer about the editor that is open, the game
that is running, and the project on disk. ${TOOL_SPECS.length} tools, named \`domain_verb\`.

\`references/tools.md\` is every tool, op and argument.

## Start here

- ${projectPathSentence()}. The \`editor_*\` ones answer about the editor this server is connected
  to. There is no ambient project.
- \`runtime_*\` calls pick a game by \`projectPath\`, or by \`pid\` when several run from one
  project, as a bench and its workers do. \`debug_*\` calls go to the game this server started or
  the editor is playing.
  ${theGamePicked()}
- An argument a tool does not declare is refused rather than ignored.
- \`editor_status\` says whether an editor is connected and whether its addon matches the server.
  \`addonIsStale\` means the editor is running different addon code from what the server ships
  (an older \`addonVersion\` on the same code is not stale), and \`staleNote\` says which half is behind: an editor that
  needs restarting, a project that needs the upgrade command, or a server that needs reconnecting
  in your harness. A stale editor is asked nothing but to quit, and every other call to it is
  refused with the same note. A game's runtime addon is judged the same way, under each entry in
  \`runtimes\`, and a \`runtime_*\` call to a stale game is refused with its note.
- Start the game with \`editor_run start\`, never by spawning an engine. The editor plays it, so
  the \`debug_*\` tools reach its debugger. Its answer
  says under \`runtime\` whether the game can be talked to yet. When it cannot, \`mayYetAnnounce\`
  false is a runtime that is not coming and true is a game still on its way up.
- Read \`editor_output\` after every run. Its entries carry the engine's errors and warnings with
  their backtraces, and its \`clean\` verdict judges the run. For a run the editor plays, the errors
  come from the game through the runtime addon, so a played game without the addon answers
  \`errorsUnread\` and no \`clean\`. For a long run it also names a transcript file: read that for
  output and this answer for state. Never decide a run has ended because its transcript stopped
  growing, a process list or a timeout. From outside, a bench between prints looks the same as a
  dead one.
- \`endedBy\` says whether gdharness ended a run. \`running\` comes from the operating system when
  the run has a pid: every run this server started itself, and every editor-played run whose game
  announced its runtime. An editor-played game with no runtime addon has no pid, so \`running\` is
  the editor's answer and can lag by seconds. \`editor_status\` does not list such a game under
  \`runtimes\`.
- When every tool says the project is fine and something is still wrong, read the editor's own
  console with \`editor_output op: "editor"\`. It runs from the editor's first line, with repeats
  grouped under \`repeated\`. It exists only for an editor gdharness opened, and one opened by hand
  is refused. The line before a burst of parse errors often names the plugin behind it.
- One server, one editor. A second project needs a second harness session with its own server.
  Never open a second editor on a project that already has one.

## Measuring a running game

| Ask | Tool |
| --- | --- |
| What a screen says | \`runtime_inspect text\`, which reads what is drawn and leaves out what is hidden. Read \`omitted\`: a long list above a dialog pushes it past the limit, and what comes back then is the top of the screen rather than the screen |
| Find a control by the word on it | \`runtime_inspect find\` with \`says\`, rather than listing a screen and reading each one |
| What a control is showing | \`runtime_inspect find\` with \`property\` as well. The value comes back with each match in the same frame. A separate read a frame later can meet a rebuilt panel and answer "Node not found" |
| Where a control is, and whether it is visible | \`runtime_inspect\` \`find\`, \`rect\` |
| What a property reads right now, on a node whose path you already hold | \`runtime_inspect\` \`property\`, \`runtime_invoke\` |
| What a property on an object a node holds reads | the same two, with colons: \`_game:clock:speed\` |
| Which control holds the focus, or anything only a method answers | the same path with a step written as a call, \`get_viewport():gui_get_focus_owner\`, which calls a method that only reads and walks into what it returned. An engine method takes literal arguments in the brackets, \`get_theme_constant("separation")\` |
| Press a button | \`runtime_input click\` with \`says\` and the words on it, which finds it and presses it in the same frame and says what was under the pointer. A \`find\` and then a click by the path it answered is two calls over a generated path, and a panel that rebuilds between them frees the button first. \`nodePath\` narrows where \`says\` looks, and several matches are refused with an \`index\` for each |
| Press the next thing after a click that changed screen | \`runtime_wait until\` with \`says\` and a word the new screen shows (no \`nodePath\` needed: without one the whole game is searched), then the click. A click sent straight after a screen change lands on a control the new screen is about to free, answers \`landed: true\`, and does nothing. Do not wait a frame count instead. The right count differs between a cold start and a warm one |
| Fill in a field | \`runtime_input click\` on it, then \`runtime_input text\` with \`replace\`. A submitted field has to be clicked again |
| Click a 3D node | \`runtime_input click\` on the Node3D, which aims at what it draws |
| Pick something out of a dropdown | \`runtime_input choose\` on it, by what the item says, rather than a click and keys: the menu opens as a window of its own that an injected key never reaches, so Enter closes it with nothing chosen |
| Answer a dialog | \`runtime_input click\` on its button, or \`runtime_input key\` with \`keycode\` \`Escape\` to dismiss it: an \`AcceptDialog\` reads that key itself and never asks the InputMap, so \`ui_cancel\` leaves it standing |
| Press a bound key | \`runtime_input action\` with the action's name, or \`runtime_input key\` with \`keycode\`, a whole press unless you hold it |
| Drag, stir, paint or draw a line | \`runtime_input mouse_drag\` from \`x\`, \`y\` to \`toX\`, \`toY\` over \`frames\`, with \`via\` for the points between: one call sends a motion a frame, as a hand does, where a press, a few motions and a release as separate calls is a stroke a game sees as a handful of jumps |
| Where a 3D node is on screen | \`runtime_inspect\` \`rect\`, rather than unprojecting by hand |
| Wait for whichever of several screens comes next | \`runtime_wait until\` with \`says\` naming each, separated by \`|\`: \`"*won*|*lost*|*turn 3*"\` is met by the first of them to appear |
| Ask the game a question its own code answers | \`runtime_invoke call\` on the method that answers it, reached through what a node holds (\`_league:round:rival:best_reply\`), with object arguments given as paths to what the game holds and a list of paths for a list: the game's own rules answer, in the running game, before anything is committed |
| Wait for something in a running game | \`runtime_wait\`, never a sleep. Use \`until\` with \`says\` for a panel that rebuilds its own labels. The words have to be shown: a button that exists hidden through an animation does not satisfy it until it appears, unless \`includeHidden\` says otherwise |
| See a tween or an animation partway | \`runtime_wait watch\` with \`nodePath\` and \`property\` ("position:x"), then the call or click that starts it, then \`runtime_wait recorded\` with the watch: every change, each with its frame and game time. Send the watch before the click. One sent after it can miss a short animation |
| What every label on a screen says | \`runtime_inspect tree\` with \`properties\` naming \`text\`, which reads it off every node that has one. \`includeProperties\` returns every stored property of every node, tens of thousands of characters for one row |
| Whether this engine has a method or property, and what it takes | \`editor_classes info\` with \`member\`, which answers that one member and which class declares it rather than the whole class |
| Wait for a run to finish | \`editor_run wait\`, never a sleep or a shell loop on the pid: it answers as \`editor_output\` does, once the run is over |
| Find which GDScript makes a run slow | \`editor_run start\` with \`profile\` set, then \`editor_run profile\`: the engine's own script profiler, per function with calls and self and total milliseconds, by self time, never \`Time.get_ticks_usec()\` laps edited into the game. A scene that does its work in \`_ready\` and quits is covered whole when the runtime autoload is registered, and a game the editor is already playing is profiled from the moment it is asked. For one action, a press or a commit, set \`mark\` on a profile before it and pass \`since: "mark"\` after it, which answers only what the action added. \`callersOf\` names where the project's scripts call one function, each place with its function's numbers, since the engine records no callers |
| End a bench and the workers it opened | \`editor_run stop\` with \`andChildren\`, never a process listing by scene name: it ends every process under the run's, to any depth, that is a game of the project, announced as one or the project's engine run with \`--path\` on it, names them under \`endedChildren\` with what identified each, and leaves and names any other |
| End a game of the project that no server is holding | \`editor_run stop\` with its \`pid\` from \`editor_status\` \`runtimes\`, never a process kill by hand: it is ended only when it announced itself for the project and its command line is the project's engine run |
| Play a game without touching the player's saves | \`editor_run start\` with \`savesIn\`, a directory for this run's \`user://\`: the editor plays with its own environment, so a run given one is started by the server, and the answer says under \`savesNote\` when the platform ignores it |
| A picture, for a person who asked to see one | \`runtime_capture\` |

These need the runtime autoload, which \`gdharness setup\` registers. \`runtime_capture\` needs a
window and refuses headless rather than handing back the last frame anything drew. On Windows a
windowed run this server starts is on a desktop of its own, where it draws and can be captured but
never shows or takes the keyboard or the pointer.

The autoload reads these settings and no others. \`${BIND_ADDRESS_SETTING}\` is \`127.0.0.1\`.
Keep it there. The runtime takes unauthenticated \`call_method\`, \`set_property\` and input, and
Godot's \`listen()\` defaults to every interface. \`${PORT_SETTING}\` is 0, so the operating system
picks a port and the game announces it. Fix it only for a client that cannot read the announcement.

A headless game answers. A \`godot -s\` script run does not by default, because it has no game in it.
Set \`${SCRIPT_RUNS_SETTING}\` to true in \`project.godot\` to serve one. Read the setting rather
than assume the default.

A scene that is not the game, such as a bench, is run as a scene and is served like the game unless
the project lists its folder in \`${QUIET_SCENES_SETTING}\`, a \`PackedStringArray\` of \`res://\`
prefixes, empty by default. A run started on a scene under one of them neither serves nor
announces, nor do the engines it starts, unless it was started to be profiled from its start.

The autoload names \`res://${RUNTIME_AUTOLOAD.path}\`, the loader \`gdharness setup\` writes, which
brings the runtime up only in a debug build that has the addon. A release export leaves out the
entry, the loader, and the runtime, editor and auto_reload addons. A debug export keeps them. The
loader is committed with \`project.godot\`, and \`gdharness doctor\` says when it differs from the
one gdharness ships.

## At a breakpoint

\`debug_state variables\` reads what is in scope. \`debug_control step_over\` and \`step_into\`
move. A game the editor plays cannot be paused or stepped out of, because Godot's debug adapter
implements neither. Hold it with a breakpoint. A game this server started takes
\`debug_control pause\` and \`step_out\`.

A held game draws nothing and answers no \`runtime_*\` call. The server says so at once when it
knows, naming why the game is held and \`debug_control continue\` as what lets it go, and
\`editor_output\` and \`editor_status\` carry the same under \`heldAt\`. A breakpoint set with
\`debug_breakpoint\` holds for every start until \`debug_breakpoint remove\`, across a reconnect,
so take it off when the question it was for is answered.

## Editing

\`scene_tree\` reads what a scene holds, rather than what the \`.tscn\` text implies, and
\`resource_edit read\` reads a resource. Writes go through \`scene_create\`, \`scene_node\`,
\`scene_signal\`, \`scene_animation\` and every \`resource_edit\` op but \`move\`. All of them use
the editor when one serves the project, so the files keep their formatting, and a headless engine
otherwise. The headless engine runs the scene's scripts, so the answer puts back what they
changed. It refuses a file where it cannot, such as a scene whose script does not compile. For
those, open the editor (\`editor_launch\` with \`hidden: true\`) and ask again.

\`script_info\` comes from the editor's own language server, and so does
\`script_diagnostics\` when this project's editor is open. Without it a headless engine compiles the
scripts and reports their errors, with lines but no columns and no warnings.

\`project_info\`, \`project_dependencies\`, \`project_settings\`, \`project_import\`,
\`project_export\`, \`project_test\`, \`script_edit\`, \`script_info structure\` and
\`editor_classes\` need nothing open: they run a short headless engine and are gone before the
answer is printed. The exception is \`script_edit rename\` of a method, variable, signal or other
member, which asks the editor's language server which uses are that class's. A setting absent
from \`project.godot\` comes back from \`project_settings get\` with the engine's default.

To rename a class or a member across the project, use \`script_edit rename\` rather than a text
replacement. It changes the uses the engine resolves, doc links and what scenes record, and lists
every occurrence it did not change:

- \`leftAlone\`: a string holding the whole name, such as a \`find_children\` type, since nothing
  compiles it, and files under a \`.gdignore\` directory.
- \`leftAloneInProse\`: comments, doc lines, strings and text files, by line.
- \`leftAloneOtherSymbols\`: a local or another class's member of the same name, by line.

A common name's lines go to the file \`leftAloneDetail\` names. Pass \`preview\` first on a large
rename. If the answer has \`ok: false\` beside \`written: true\`, the files were changed and a
script did not compile afterwards.

To move or rename a scene, a resource, an image or a directory, use \`resource_edit move\` rather
than moving the file: it takes the \`.import\` and \`.uid\` along, rewrites every path naming what
moved in scenes, resources, scripts and \`project.godot\`, and brings an open editor up to it so the
editor does not save the old paths back. It needs no editor. A scene saved as \`.scn\` or a
resource saved as \`.res\` cannot be rewritten and is listed under \`leftAlone\`. It still finds
a moved file by its UID. To move a script with its class, use \`script_edit rename\` with
\`newScriptPath\`.

Editing a file while a game is running does not change the running game. \`auto_reload\` is an
editor plugin and reloads into the editor's own process. The game is a separate process holding
its own copy. So a long run is not a reason to stop editing, and the new code arrives on the next
\`editor_run start\`.

A wall of "Could not find type" on the project's own classes means the editor is not holding
them. \`editor_rescan\` asks it to scan and names any class it still cannot resolve under
\`unseenByEditor\`: the editor's own scan skips a file a headless engine has already imported, so
the declaration and the cache can both be right while the editor stays blind to it. For a class
under \`unseenByEditor\`, run \`editor_rescan\` again, which needs no change to the declaring
script. \`editor_launch restart\` also fixes it, at the cost of an editor restart.

With no editor open, the headless engine that compiles for \`script_diagnostics\` and for
\`project_info\`'s health and validation resolves class names only from that cache file. A
project never opened, as a fresh clone is, has no such file, so every script typed by a project
class fails there. \`script_diagnostics\` names the class under
\`typesMissingFromTheClassCache\`, health and validation say so beside the failure, and
\`project_import refresh_classes\` writes the cache from the declarations on disk.

The scan writes \`.godot/global_script_class_cache.cfg\` from the list the editor is holding, so
a class it cannot resolve would go out of that file with it. The answer names that loss under
\`cacheLost\` and rebuilds the cache from the declarations on disk, naming what came back under
\`cacheRestored\`, so no fresh engine, CI run or clone inherits the short file. That is the same
class \`unseenByEditor\` names, and the loss is not a reason to refuse the scan. An editor that lost
classes this way still holds the short list and writes it again on every scan. Restart it with
\`editor_launch restart\` before the next \`editor_rescan\`.

The editor also scans on its own, when files change under it, and it rewrites that file just after
the scan ends. Every engine this server starts on the project (a run, a boot check, a test run, a
headless operation) waits until a scan in progress and the write after it are done, and says how
long under \`waitedForEditorScanMs\`. A \`scanNote\` means a scan was still going after thirty
seconds and the engine started anyway: a "Could not find type" from that engine is the scan, not
the script. Run \`editor_rescan\`, then the same call again.

A diagnostic about a member, such as \`Static function "x()" not found in base "Y"\`, is read from
disk on every ask. If one disagrees with a run, believe the run and say so.

## Refusals

An unknown op, an undeclared argument or a missing required one is refused with the valid set
spelled out.

The running server decides what a tool takes, not the schema in your context. A conversation that
began before gdharness was upgraded, and was resumed since, can go on holding the tool definitions
it first loaded, even from a fresh search, while the server behind them is newer. When an answer
names an op or an argument the schema you hold does not show, make the call as the answer says: the
server accepts it or refuses it with what it does take.

A tool that cannot answer says which state it is in and what changes it, rather than answering
emptily: no game running, a game with no debugger behind it, a game running rather than stopped, a
control outside a headless viewport. Read the refusal instead of retrying the call.

Every answer is read back from the engine after the change rather than echoed from the request, and
whatever the engine said on stderr comes back under \`engine_messages\`. A headless engine runs the
project's autoloads after the operation has answered, and what it reports from then until it exits
comes back separately, under \`engine_messages_after_answer\`: none of it changes the answer. A
check or write of a script waits for the autoloads to start, so the scripts naming them compile, and
what they report while starting comes back under \`engine_messages_before_operation\`.

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
 * Uninstalling has to find what was written when a different set of harnesses was set up here, so
 * it looks everywhere rather than only where it would write now.
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

/** The skill taken out of wherever it was put. Only what was actually there is named. */
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

/** The skill written into each directory, over any copy already there. */
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
