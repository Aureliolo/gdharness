#!/usr/bin/env node
/**
 * The editor tools, driven against a real editor.
 *
 * `scene_*`, `resource_edit` and `editor_rescan` all go through the addon inside a running
 * editor, and nothing in CI ever started one: what stood behind them was argument validation
 * and path refusals, which a tool answering plausible nonsense passes exactly as well as a
 * working one. This starts the pinned engine as a headless editor, lets its addon dial the
 * bridge the server is holding, and drives each tool the way a client does, reading every
 * result back out of the file the engine wrote rather than out of the answer.
 *
 * The editor gets its own user directory, its own language server port and its own debug
 * adapter port, so a run here cannot rewrite the editor settings of the machine it runs on or
 * take the ports off an editor somebody has open.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { GodotDAPClient } from '../src/dap_client.js';
import { alive } from '../src/server.js';
import { SERVER_VERSION } from '../src/server-version.js';
import { RUNTIME_AUTOLOAD } from '../src/setup.js';
import { asArray, asNumber, asObject, asString, get, text } from './support/json.js';
import { parseTextContent, textOf } from './support/json-rpc.js';
import { reservePort, ServerProcess } from './support/server.js';
import { sweep } from './support/sweep.js';

/** Long enough for a cold editor to finish its first filesystem scan on a slow runner. */
const CONNECT_TIMEOUT_MS = 120_000;
/** Past the longest a tool waits on its own, so the tool's answer is what a case fails on. */
const TOOL_TIMEOUT_MS = 120_000;
/** The editor serves its language server after the addon has connected, and takes its time. */
const LSP_READY_TIMEOUT_MS = 90_000;
/** A game the editor plays is a second engine starting, on a runner that is already busy. */
const GAME_STOP_TIMEOUT_MS = 90_000;
/** How long a start waits for that game to announce its runtime, for the same reason. */
const RUNTIME_BOOT_MS = 30_000;
/** How much of the server's log a failing case carries: the case's own start and wait, not the tier's. */
const SERVER_ACCOUNT_CHARS = 8_000;

const SCENE = 'res://fixture.tscn';

/** An action bound to nothing, for the input tool to name. */
const FIXTURE_ACTION = 'fixture_action';
/** Godot's KEY_SPACE, which is what the engine reports for the key the input case sends. */
const SPACE_KEYCODE = 32;

/** What every editor on a machine would hold its debugger on, which is why none of them may. */
const SHARED_DEBUGGER_PORT = 6007;

/**
 * The game the editor plays: something to break in, something to ask, something to wait for,
 * and something to click.
 *
 * It runs until it is stopped rather than quitting after the print, because a game that ends
 * that instant can take its debugger connection down before the console it wrote comes over it,
 * and because the runtime cases need it there to answer.
 */
const MAIN_GD = [
  'extends Node',
  '',
  'signal ticked(at: int)',
  '',
  // Reached from the script the editor loads with the main scene, which is what makes the editor
  // hold an analysed copy of Ringer and, through it, of Bell. A class that is only declared and
  // only in the cache is parsed fresh on every request, and a copy that is never held can never
  // go stale.
  'var ringer: Ringer = Ringer.new()',
  '',
  '## Changed only by the game, so waiting on it is waiting on something real.',
  'var ticks: int = 0',
  '## Changed only from outside, so a case can set it and read it back without racing.',
  'var stash: int = 0',
  '## Set to 42 a second in, which is what there is to wait for.',
  'var answer: int = 0',
  '## Raised by the button, so a click is judged by what the game did rather than by the answer',
  '## the tool gave about itself.',
  'var clicks: int = 0',
  '## The last action and key the tree was handed, which says whether an injected one arrived.',
  'var acted: String = ""',
  'var keyed: int = 0',
  '## Set from _ready through a call, so there is a frame to step into and back out of.',
  'var doubled: int = 0',
  '## A property holding a node rather than a number, which is what a wait for the wrong kind of',
  '## value has to be refused against: comparing one with a string is a hard error in GDScript.',
  'var held: Node = null',
  '',
  '',
  'func _ready() -> void:',
  '\tvar total: int = 2 + 2',
  '\tprint("the game said ", total)',
  '\tdoubled = _twice(total)',
  '',
  '\tvar ticker: Timer = Timer.new()',
  '\tticker.name = "Ticker"',
  '\tticker.wait_time = 0.2',
  '\tticker.autostart = true',
  '\tadd_child(ticker)',
  '\tticker.timeout.connect(_tick)',
  '\theld = ticker',
  '',
  '\tvar late: Timer = Timer.new()',
  '\tlate.name = "Late"',
  '\tlate.wait_time = 1.0',
  '\tlate.one_shot = true',
  '\tlate.autostart = true',
  '\tadd_child(late)',
  '\tlate.timeout.connect(_answer)',
  '',
  '\tvar panel: Control = Control.new()',
  '\tpanel.name = "Panel"',
  '\tpanel.position = Vector2(10, 20)',
  '\tpanel.size = Vector2(320, 240)',
  '\tadd_child(panel)',
  '',
  '\tvar press: Button = Button.new()',
  '\tpress.name = "Press"',
  '\tpress.text = "Go"',
  // A headless engine's window is 64 by 64 whatever the project asks for, and the GUI only
  // delivers to what is inside it, so the button has to be small and near the corner.
  '\tpress.position = Vector2(2, 2)',
  '\tpress.size = Vector2(40, 20)',
  '\tadd_child(press)',
  '\tpress.pressed.connect(_pressed)',
  '',
  '',
  'func _input(event: InputEvent) -> void:',
  '\tif event is InputEventAction:',
  '\t\tvar action: InputEventAction = event',
  '\t\tacted = action.action',
  '\telif event is InputEventKey:',
  '\t\tvar key: InputEventKey = event',
  '\t\tkeyed = key.keycode',
  '',
  '',
  'func _tick() -> void:',
  '\tticks += 1',
  '\tticked.emit(ticks)',
  '',
  '',
  'func _answer() -> void:',
  '\tanswer = 42',
  '',
  '',
  'func _pressed() -> void:',
  '\tclicks += 1',
  '',
  '',
  'func stow(value: int) -> int:',
  '\tstash = value',
  '\treturn stash',
  '',
  '',
  'func peek() -> int:',
  '\treturn stash',
  '',
  '',
  '## Printed on demand, so a case can put a line in the console after the last time anything read',
  '## it. What the adapter is still holding when the next play starts is the whole question.',
  'func announce() -> void:',
  '\tprint("the first run said its piece")',
  '',
  '',
  'func peek_clicks() -> int:',
  '\treturn clicks',
  '',
  '',
  'func last_action() -> String:',
  '\treturn acted',
  '',
  '',
  'func last_key() -> int:',
  '\treturn keyed',
  '',
  '',
  '## What the game itself was handed, which is whatever followed `--` on its command line.',
  'func given_args() -> PackedStringArray:',
  '\treturn OS.get_cmdline_user_args()',
  '',
  '',
  '## The whole command line, so a case that finds nothing above can say what did arrive.',
  'func given_command_line() -> PackedStringArray:',
  '\treturn OS.get_cmdline_args()',
  '',
  '',
  `func holding() -> bool:`,
  `\treturn Input.is_action_pressed("${FIXTURE_ACTION}")`,
  '',
  '',
  'func _twice(n: int) -> int:',
  '\treturn n * 2',
  '',
  '',
  // A runtime error rather than a parse error, so the project still opens and the game still
  // plays: the whole point is a game that was fine until somebody called this.
  //
  // Through a node that is not there rather than a Variant. The analyser knows every method on
  // a Variant is unsafe and this project has that warning at error level, so a Variant call is a
  // parse error and the script never loads at all; a Node the scene has not got is a null the
  // analyser cannot see, holding a method it knows perfectly well.
  'func break_on_purpose() -> void:',
  '\tvar nobody: Node = get_node_or_null("NoSuchNode")',
  '\tstash = nobody.get_index()',
  '',
];

/**
 * Where the breakpoint goes, found in the script rather than written down twice.
 *
 * A line number in two places is a line number that drifts: this one did, the moment the game
 * gained anything above it.
 */
const BREAK_LINE = MAIN_GD.findIndex((line) => line.includes('print(')) + 1;

interface Editor {
  /** Calls a tool and answers with its payload, failing on a refusal. */
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Calls a tool that must be refused and answers with the sentence it was refused with. */
  refusal: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Calls a tool and answers with how it went, for waiting on something to come up. */
  attempt: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;
  /**
   * Starts a run of the project and answers once its runtime is listening, failing if it is not.
   *
   * The tool's own wait for the announcement is five seconds, and a game a loaded runner is
   * booting can take longer: the answer then says `mayYetAnnounce` and names `runtimeWaitMs`,
   * exactly as designed, and a case that goes on to ask the game something is refused for a game
   * that announces a moment later. Every case that talks to the game it started goes through
   * this, so the budget is stated once and a case is about what it asks the game, not about the
   * runner's speed.
   */
  play: (args?: Record<string, unknown>) => Promise<unknown>;
  project: string;
  /** The engine this editor is, for a case that needs a second one against the same project. */
  godotPath: string;
  /** What this editor was opened on, which is what it should be reporting it serves. */
  lspPort: number;
  dapPort: number;
  /**
   * The server process itself, for the one case that has to end it while the editor plays on.
   *
   * A reconnect is this process being replaced, and what a played game is attached to is on the
   * other side of it. Nothing else here should reach for this: a case that ends the server ends
   * the session every case after it shares.
   */
  server: ServerProcess;
  /**
   * What that server was given, for the one case that has to start a replacement for it.
   *
   * A reconnect is a new process on the same ports and the same runtime directory, so a case
   * testing what survives one needs to be able to build the same server again rather than a
   * different one that happens to run.
   */
  serverEnv: Record<string, string>;
}

/** True when the binary at this path answers --version, which is the only test that counts. */
function godotRuns(candidate: string): boolean {
  const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 60000 });
  return probe.status === 0;
}

/** GODOT_PATH first, then GODOT, then plain `godot`, each tried by running it. */
function resolveGodotPath(): string | null {
  const spellings = (name: string): string[] =>
    process.platform === 'win32' ? [name, `${name}.exe`] : [name];

  return (
    [process.env['GODOT_PATH'], process.env['GODOT'], 'godot']
      .filter((name): name is string => Boolean(name))
      .flatMap(spellings)
      .find(godotRuns) ?? null
  );
}

/**
 * A project the editor can open, with the addon in it and the unsafe warnings raised to errors.
 *
 * Strict is the baseline the README promises, and these are the settings that make an editor
 * refuse to load an addon script which regressed, so the fixture project is configured the way
 * the strictest user's is. Everything the cases need on disk is written before the editor
 * starts, because a file written afterwards is not in its filesystem until a rescan.
 */
function createProject(): string {
  // Resolved, because the editor answers with the path the filesystem really has and the
  // temporary directory is behind a symlink on macOS and an 8.3 name on a Windows runner: the
  // fixture would then be holding one spelling of the project while the editor holds another.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'gdharness-editor-')));

  cpSync('src/godot/addons', join(dir, 'addons'), { recursive: true });
  // The marker an install writes beside the addon, which is how the editor knows which version
  // it is running: a copy without one is a copy gdharness did not put there.
  writeFileSync(join(dir, 'addons', 'gdharness_editor', '.gdharness-version'), `${SERVER_VERSION}\n`);

  writeFileSync(
    join(dir, 'project.godot'),
    [
      '; Engine configuration file.',
      'config_version=5',
      '',
      '[application]',
      'config/name="GdharnessEditorFixture"',
      'run/main_scene="res://main.tscn"',
      '',
      // What the editor appends to the game's command line when it plays it. Headless because a
      // fixture must not put a window on the desktop of whoever runs it, and because a runner
      // has no display to put one on.
      '[editor]',
      '',
      'run/main_run_args="--headless"',
      '',
      '[debug]',
      'gdscript/warnings/exclude_addons=false',
      'gdscript/warnings/untyped_declaration=2',
      'gdscript/warnings/inferred_declaration=2',
      'gdscript/warnings/unsafe_property_access=2',
      'gdscript/warnings/unsafe_method_access=2',
      'gdscript/warnings/unsafe_cast=2',
      'gdscript/warnings/static_called_on_instance=2',
      '',
      '[editor_plugins]',
      'enabled=PackedStringArray("res://addons/gdharness_editor/plugin.cfg")',
      '',
      // The runtime addon, registered the way an install registers it. A game the editor plays
      // then serves the runtime tools, which is the only way to drive them against a real one:
      // its own guard is the debug build, not the display, so a headless game answers.
      '[autoload]',
      '',
      `${RUNTIME_AUTOLOAD.name}="*res://${RUNTIME_AUTOLOAD.path}"`,
      '',
      // An action with nothing bound to it: runtime_input action names one, and an injected
      // InputEventAction carries the name rather than a key, so the binding is what is not needed.
      '[input]',
      '',
      `${FIXTURE_ACTION}={`,
      '"deadzone": 0.2,',
      '"events": []',
      '}',
      '',
    ].join('\n'),
  );

  // Two scripts for the language server: one that parses and one that does not, because a
  // diagnostics tool that answers "clean" for everything looks exactly like a working one.
  writeFileSync(
    join(dir, 'sound.gd'),
    [
      'extends Node',
      '',
      'signal rang(times: int)',
      '',
      'var count: int = 0',
      '',
      '',
      'func ring(times: int) -> int:',
      '\tcount += times',
      '\trang.emit(count)',
      '\treturn count',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(dir, 'broken.gd'),
    ['extends Node', '', '', 'func ring( -> int:', '\tpass', ''].join('\n'),
  );

  // A global class and a dependent of it, both present before the editor starts. The stale-analysis
  // case needs the language server to have analysed both already: a dependent created later is
  // analysed from scratch, sees the current type and reports nothing, which is a different case and
  // the one an earlier probe measured by mistake.
  writeFileSync(
    join(dir, 'clapper.gd'),
    ['class_name Clapper', 'extends Node', '', '', 'func weight() -> int:', '\treturn 1', ''].join('\n'),
  );

  // A project the size of the one that reproduces the stale-member fault, for finding out whether
  // the size is the variable. The editor resolves its global classes once at startup, so they have
  // to exist before it is spawned to count for anything.
  const crowd = Number(process.env['GDHARNESS_EXTRA_CLASSES'] ?? '0');
  if (crowd > 0) {
    mkdirSync(join(dir, 'crowd'), { recursive: true });
    for (let index = 0; index < crowd; index += 1) {
      writeFileSync(
        join(dir, 'crowd', `filler_${index}.gd`),
        [
          `class_name Filler${index}`,
          'extends Node',
          '',
          '',
          'func value() -> int:',
          `\treturn ${index}`,
          '',
        ].join('\n'),
      );
    }
  }

  writeFileSync(
    join(dir, 'bell.gd'),
    [
      'class_name Bell',
      'extends Node',
      '',
      // Held as another global class rather than as a plain int, because the reported fault is on a
      // type that has a class_name dependency of its own and the remedy found for it was changing
      // that dependency. A type depending on nothing is a different graph and may be a different
      // case, which is the thing this fixture exists to find out.
      'var clapper: Clapper = Clapper.new()',
      'var tolls: int = 0',
      '',
      '',
      'func toll() -> int:',
      '\ttolls += clapper.weight()',
      '\treturn tolls',
      '',
    ].join('\n'),
  );

  writeFileSync(
    join(dir, 'ringer.gd'),
    [
      // A global class itself, because the dependent in the report is one and a plain script is a
      // different entry in the editor's list: the global classes are resolved at startup and a
      // script that is only a file is not in that list at all.
      'class_name Ringer',
      'extends Node',
      '',
      'var bell: Bell = Bell.new()',
      '',
      '',
      'func ring_once() -> int:',
      '\treturn bell.toll()',
      '',
    ].join('\n'),
  );

  writeFileSync(join(dir, 'main.gd'), MAIN_GD.join('\n'));
  writeFileSync(
    join(dir, 'main.tscn'),
    [
      '[gd_scene load_steps=3 format=3]',
      '',
      '[ext_resource type="Script" path="res://main.gd" id="1_main"]',
      // The dependent hangs in the main scene, because the script in the report is one the editor
      // has instantiated rather than one that only sits on disk. A GDScript with live instances is
      // reloaded differently from one nothing has ever made, and the main scene is the one an
      // editor opens for itself.
      '[ext_resource type="Script" path="res://ringer.gd" id="2_ringer"]',
      '',
      '[node name="Main" type="Node"]',
      'script = ExtResource("1_main")',
      '',
      '[node name="Ringer" type="Node" parent="."]',
      'script = ExtResource("2_ringer")',
      '',
    ].join('\n'),
  );

  // An AnimationTree whose root is a state machine. The state ops need one and nothing makes
  // one: a tool that writes a node cannot build the resource that goes inside it.
  writeFileSync(
    join(dir, 'states.tscn'),
    [
      '[gd_scene load_steps=2 format=3]',
      '',
      '[sub_resource type="AnimationNodeStateMachine" id="StateMachine_1"]',
      '',
      '[node name="Root" type="Node2D"]',
      '',
      '[node name="Tree" type="AnimationTree" parent="."]',
      'tree_root = SubResource("StateMachine_1")',
      '',
    ].join('\n'),
  );

  return dir;
}

/**
 * Ends every engine whose command line names this project, whoever started it.
 *
 * Asked of the operating system rather than tracked, because the processes worth ending here are
 * the ones nothing has a handle to: an editor a restart brought up, or a game the editor played.
 * Nothing outside the fixture's own temporary directory can match.
 */
async function endEnginesUnder(project: string): Promise<void> {
  // Every process, matched on its command line alone. Filtering by `Name='godot.exe'` first meant
  // this found nothing at all wherever the engine is not called that, which is every machine using
  // the pinned build: it is `Godot_v4.7.2-stable_win64.exe` on Windows. Nineteen fixture projects
  // and eleven engines were left running on this machine before anybody looked. The path is the
  // discriminator anyway, and it is a temporary directory this fixture made, so nothing else can
  // match it; a name filter can only subtract from that.
  const listing =
    process.platform === 'win32'
      ? spawnSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
          ],
          { encoding: 'utf8', timeout: 30_000 },
        )
      : spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 30_000 });

  // A listing that did not happen is the failure this had for months, and it looks exactly like a
  // machine with nothing to clean up. Said out loud, because the cost of it lands on the next run
  // and on whoever is using the machine, not on this one.
  if (listing.status !== 0 || listing.stdout.trim() === '') {
    console.warn(
      `could not list processes to clean up engines under ${project}: ${listing.status ?? listing.error?.message ?? 'no output'}`,
    );
    return;
  }

  const wanted = project.replaceAll('\\', '/').toLowerCase();
  const ended: number[] = [];
  for (const line of listing.stdout.split('\n')) {
    const [, pid, rest] = /^\s*(\d+)\s+(.*)$/.exec(line.trim()) ?? [];
    if (pid === undefined || rest === undefined) continue;
    if (!rest.replaceAll('\\', '/').toLowerCase().includes(wanted)) continue;
    try {
      process.kill(Number(pid));
      ended.push(Number(pid));
      console.log(`ended engine ${pid}, which was still holding the fixture project`);
    } catch {
      // Gone between the listing and here, which is the outcome this is for.
    }
  }

  // Waited for, for the same reason the editor with a handle is: a signal is not an exit, and an
  // editor on its way out still holds the debug adapter port it bound. The next case reserves a
  // port, is handed that number because nothing has released it yet, and is refused by the guard
  // that asks who is really listening. Cases here are written on the understanding that one editor
  // is up at a time, and that only holds if ending one finishes before the next starts.
  const deadline = Date.now() + 10_000;
  while (ended.some((pid) => alive(pid)) && Date.now() < deadline) {
    await delay(100);
  }
  const holding = ended.filter((pid) => alive(pid));
  if (holding.length > 0) {
    console.warn(`engines ${holding.join(', ')} were signalled and are still up; the next case may collide`);
  }
}

/** Waits for a killed engine to actually be gone, which is not the same moment. */
async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
    setTimeout(resolve, 10_000);
  });
}

/**
 * Removes the fixture project once nothing is holding it.
 *
 * Windows refuses to unlink a directory a process still has open, and the game the editor played
 * is a second engine closing in its own time, so the first attempt can land while it is still on
 * its way out.
 */
async function removeWhenFree(directory: string): Promise<string | null> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      sweep(directory);
      return null;
    } catch (error) {
      await delay(250);
      if (attempt === 39) {
        return `${directory} is still held: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  return null;
}

/** A file the engine wrote, which is the only answer it cannot fake. */
function fileText(project: string, name: string): string {
  return readFileSync(join(project, name), 'utf8');
}

/** Every name in a document symbol answer, nested ones included. */
function symbolNames(symbols: unknown[]): string[] {
  return symbols.flatMap((symbol) => [
    asString(get(symbol, 'name'), 'name'),
    ...symbolNames(asArray(get(symbol, 'children') ?? [], 'children')),
  ]);
}

/** Every node path in a scene_tree answer, sorted, so a case says what the scene holds. */
function nodePaths(tree: unknown): string[] {
  const children = asArray(get(tree, 'children'), 'children').flatMap(nodePaths);
  return [asString(get(tree, 'path'), 'path'), ...children].sort();
}

/**
 * The server, a headless editor connected to it, and the handles for driving them.
 *
 * The editor connects out to the bridge rather than being connected to, so the server goes
 * first and the addon's own reconnect covers the gap. editor_status is polled rather than
 * slept on, because the wait is a cold engine start and a number that is right on one runner
 * is wrong on the next.
 */
async function withEditor(godotPath: string, body: (editor: Editor) => Promise<void>): Promise<void> {
  const project = createProject();
  const home = join(project, 'home');
  mkdirSync(home);

  const bridgePort = await reservePort();
  const lspPort = await reservePort();
  const dapPort = await reservePort();

  // The same user directories the editor gets: a restart is the server starting the editor
  // again, and a child of this server must not be the one run that writes into the editor
  // settings of whoever is running the fixture.
  const own = {
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
    XDG_DATA_HOME: home,
    XDG_CACHE_HOME: home,
    // Where a played game announces the port it is listening on, and where the server looks for
    // it. Named here so the two agree by construction rather than by both deriving a temporary
    // directory that Windows spells two ways.
    GDHARNESS_RUNTIME_DIR: join(home, 'runtime'),
  };

  const serverEnv: Record<string, string> = {
    ...own,
    GDHARNESS_BRIDGE_PORT: String(bridgePort),
    GDHARNESS_LSP_PORT: String(lspPort),
    GDHARNESS_DAP_PORT: String(dapPort),
    GODOT_PATH: godotPath,
    // The server's own account, kept in its stderr for the case that fails: a start that waited
    // thirty seconds on a game whose console said it had announced left nothing behind saying
    // what the wait looked at, and the editor's output is the other half of that evidence.
    DEBUG: 'true',
  };
  const server = new ServerProcess({ env: serverEnv });

  const invoke = async (name: string, args: Record<string, unknown>) =>
    await server.request('tools/call', { name, arguments: args }, TOOL_TIMEOUT_MS);

  // A refusal comes back as a sentence rather than as JSON, so it is reported as the sentence
  // the server wrote instead of as a parse failure several frames from the call that caused it.
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const response = await invoke(name, args);
    assert.notEqual(get(response, 'result', 'isError'), true, `${name} was refused: ${textOf(response)}`);
    const payload = parseTextContent(response);
    assert.notEqual(payload, null, `${name} answered with no content: ${textOf(response)}`);
    return payload;
  };

  const refusal = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const response = await invoke(name, args);
    assert.equal(get(response, 'result', 'isError'), true, `${name} should have been refused`);
    return textOf(response) ?? '';
  };

  const attempt = async (name: string, args: Record<string, unknown>) => {
    const response = await invoke(name, args);
    return { ok: get(response, 'result', 'isError') !== true, text: textOf(response) ?? '' };
  };

  const play = async (args: Record<string, unknown> = {}): Promise<unknown> => {
    const run = await call('editor_run', { projectPath: project, runtimeWaitMs: RUNTIME_BOOT_MS, ...args });
    // What the game printed goes with a start that came back without a runtime, since the next
    // question is always why it did not come up, and which of the two states it is: a runtime
    // that is not coming is the promise broken, and one still on its way after this long is a
    // machine slower than anything worth waiting for.
    if (get(run, 'runtime', 'listening') !== true) {
      const said = (await attempt('editor_output', {})).text;
      const what =
        get(run, 'runtime', 'mayYetAnnounce') === true
          ? 'had still not announced itself'
          : 'is not coming up at all';
      assert.fail(`the game ${what}: ${JSON.stringify(run)}\n${said}`);
    }
    return run;
  };

  const editor: ChildProcess = spawn(
    godotPath,
    [
      '--editor',
      ...(process.env['GDHARNESS_WINDOWED_EDITOR'] === '1' ? [] : ['--headless']),
      '--path',
      project,
      '--lsp-port',
      String(lspPort),
      '--dap-port',
      String(dapPort),
      // The scene the editor opens, which is how a real one is started and is what decides which
      // scripts it loads and holds. Without it the editor opens nothing, reaches no script, and
      // parses every file fresh on each request: a state in which a stale analysed type cannot
      // exist, so a whole class of fault is unreproducible here and was for a day.
      'res://main.tscn',
    ],
    {
      env: {
        ...process.env,
        GDHARNESS_BRIDGE_PORT: String(bridgePort),
        // The same two the command line above names, which is what editor_launch does: the engine
        // keeps a port it was given on the command line to itself, so the environment is how the
        // addon knows what this editor is serving and what to write into its settings.
        GDHARNESS_LSP_PORT: String(lspPort),
        GDHARNESS_DAP_PORT: String(dapPort),
        // Its own everything: a fixture must not rewrite the editor settings of the machine it
        // runs on, and on a developer's machine those belong to the editor they have open.
        ...own,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const engineOutput: string[] = [];
  editor.stdout?.on('data', (chunk: Buffer) => engineOutput.push(chunk.toString()));
  editor.stderr?.on('data', (chunk: Buffer) => engineOutput.push(chunk.toString()));

  try {
    await server.initialize('editor-fixture');

    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    let connected = false;
    while (!connected && Date.now() < deadline) {
      if (editor.exitCode !== null) {
        throw new Error(`the editor exited with ${editor.exitCode}:\n${engineOutput.join('')}`);
      }
      connected = get(parseTextContent(await invoke('editor_status', {})), 'editor', 'connected') === true;
      if (!connected) await delay(250);
    }
    assert.ok(connected, `the editor never reached the bridge:\n${engineOutput.join('')}`);

    await body({ call, refusal, attempt, play, project, godotPath, lspPort, dapPort, server, serverEnv });
  } catch (failure) {
    // What the engine said on its way to failing, which is the half of the evidence a tool
    // answer does not carry: a fixture that reports only its own assertion sends whoever reads
    // the run back to guessing about an editor that is no longer there to ask.
    const said = engineOutput.join('').trim();
    // Whether the editor this started is still alive, which separates a restart that never
    // happened from one that happened and never came back: the editor a restart brings up is a
    // process Godot spawns, and nothing here can read its output.
    const state =
      editor.exitCode === null && editor.signalCode === null
        ? 'still running'
        : `gone (exit ${editor.exitCode ?? 'none'}, signal ${editor.signalCode ?? 'none'})`;
    // The tail rather than the whole: a tier's log runs to thousands of lines, and the case that
    // failed is the last thing in it.
    const account = server.stderr.slice(-SERVER_ACCOUNT_CHARS).trim();
    throw new Error(
      `${failure instanceof Error ? failure.stack : String(failure)}\n\nThe editor this started is ${state}. It said:\n${said}\n\nThe server's last ${SERVER_ACCOUNT_CHARS} characters:\n${account}`,
    );
  } finally {
    // The game first: it is the editor's child and outlives it, so a run that failed part way
    // through would otherwise leave an engine behind holding the fixture project.
    await invoke('editor_run', { op: 'stop' }).catch(() => undefined);

    editor.kill();
    await exited(editor);
    await server.stop();

    // Every engine still holding this project, not just the one spawned here. A restart replaces
    // that process with one nothing here has a handle to, and a restart that failed part way
    // leaves an editor running on somebody's desktop: that happened, on a real machine, and the
    // only reason it was noticed is that it put a window up.
    await endEnginesUnder(project);
    // Reported rather than thrown: a directory still held is worth saying, and an exception from
    // here would replace whatever the cases were failing on, which is the thing worth reading.
    const held = await removeWhenFree(project);
    if (held !== null) {
      console.warn(held);
    }
  }
}

/** Building a scene node by node, with the tree and the file read back after each step. */
async function testSceneNodes({ call, project }: Editor): Promise<void> {
  const scene = { projectPath: project, scenePath: SCENE };

  await call('scene_create', { ...scene, rootNodeType: 'Node2D' });
  assert.ok(existsSync(join(project, 'fixture.tscn')), 'scene_create should write the scene file');

  await call('scene_node', { ...scene, op: 'add', nodeType: 'Button', nodeName: 'Press' });
  await call('scene_node', { ...scene, op: 'set', nodePath: 'Press', properties: { text: 'Go' } });

  const read = await call('scene_node', { ...scene, op: 'get', nodePath: 'Press' });
  assert.equal(get(read, 'properties', 'text'), 'Go', 'the property should read back off the node');
  assert.match(fileText(project, 'fixture.tscn'), /text = "Go"/, 'and be in the saved scene');

  await call('scene_node', { ...scene, op: 'add', nodeType: 'Node2D', nodeName: 'Panel' });
  await call('scene_node', { ...scene, op: 'duplicate', nodePath: 'Press', newName: 'Copy' });
  await call('scene_node', { ...scene, op: 'reparent', nodePath: 'Copy', newParentPath: 'Panel' });

  assert.deepEqual(
    nodePaths(get(await call('scene_tree', scene), 'tree')),
    ['.', 'Panel', 'Panel/Copy', 'Press'],
    'the duplicate should be under its new parent',
  );
  assert.match(fileText(project, 'fixture.tscn'), /\[node name="Copy" type="Button" parent="Panel"/);

  await call('scene_node', { ...scene, op: 'delete', nodePath: 'Panel/Copy' });
  assert.deepEqual(nodePaths(get(await call('scene_tree', scene), 'tree')), ['.', 'Panel', 'Press']);
  assert.doesNotMatch(fileText(project, 'fixture.tscn'), /name="Copy"/, 'and be gone from the file');

  // Saving it again, and saving it somewhere else. The copy is read back through the tool that
  // reads scenes rather than as text, so it is a scene rather than a file of the right size.
  const saved = await call('scene_create', { ...scene, op: 'save' });
  assert.equal(get(saved, 'savedPath'), SCENE, 'a save should answer with where it went');
  const copy = 'res://made/copy.tscn';
  await call('scene_create', { ...scene, op: 'save_as', newPath: copy });
  assert.deepEqual(
    nodePaths(get(await call('scene_tree', { projectPath: project, scenePath: copy }), 'tree')),
    ['.', 'Panel', 'Press'],
    'and a copy should hold the same nodes, in a directory the save made',
  );
}

/**
 * The values a property read hands back, for the types JSON cannot carry on its own.
 *
 * JSON does not refuse a value it cannot carry: it writes the value's own text instead. So a
 * Polygon2D's points came back as the string "[(1.0, 2.0), (3.0, 4.0)]", a Line2D's width curve as
 * a bare class name and a Quaternion as "(0, 0, 0, 1)", each of them reading like an answer and
 * none of them readable back. What is asked here is that a value survives the trip out and the trip
 * home: written, read, and written again from what the read gave, the node ends up where it started.
 */
async function testValuesSurviveBeingRead({ call, project }: Editor): Promise<void> {
  const scene = { projectPath: project, scenePath: SCENE };
  const points = [
    { _type: 'Vector2', x: 10, y: 20 },
    { _type: 'Vector2', x: 30, y: 40 },
  ];
  await call('scene_node', { ...scene, op: 'add', nodeType: 'Polygon2D', nodeName: 'Shape' });
  await call('scene_node', {
    ...scene,
    op: 'set',
    nodePath: 'Shape',
    properties: { polygon: points, color: { _type: 'Color', r: 0.25, g: 0.5, b: 0.75, a: 1 } },
  });

  const read = await call('scene_node', { ...scene, op: 'get', nodePath: 'Shape' });
  const held = asArray(get(read, 'properties', 'polygon') ?? []);
  assert.equal(held.length, 2, `the points should come back as points: ${text(read)}`);
  assert.equal(asNumber(get(held[0], 'x')), 10, `the first point should be the one written: ${text(read)}`);
  assert.equal(asString(get(held[1], '_type')), 'Vector2', `each one tagged: ${text(read)}`);
  assert.equal(
    asNumber(get(read, 'properties', 'color', 'g')),
    0.5,
    `and a colour should be a colour: ${text(read)}`,
  );

  // The trip home: what the read gave, written back to a second node, leaves the file saying the
  // same thing about both. A shape that survives the read and not the write is still lost.
  await call('scene_node', { ...scene, op: 'add', nodeType: 'Polygon2D', nodeName: 'Echo' });
  await call('scene_node', {
    ...scene,
    op: 'set',
    nodePath: 'Echo',
    properties: { polygon: held, color: get(read, 'properties', 'color') },
  });
  const saved = fileText(project, 'fixture.tscn');
  const written = [...saved.matchAll(/polygon = PackedVector2Array\(([^)]*)\)/g)].map((one) => one[1]);
  assert.equal(written.length, 2, `both polygons should be in the scene: ${written.join(' | ')}`);
  assert.equal(written[0], written[1], `and hold the same points: ${written.join(' | ')}`);
  assert.match(String(written[0]), /10, 20, 30, 40/, `which are the ones written: ${written[0]}`);

  await call('scene_node', { ...scene, op: 'delete', nodePath: 'Echo' });
  await call('scene_node', { ...scene, op: 'delete', nodePath: 'Shape' });
}

/**
 * A value the property cannot hold is refused, and the scene keeps what it had.
 *
 * Object.set converts rather than refuses, and every conversion it makes here is silent and wrong:
 * a word written to an int is stored as 0, to a bool as true, to a Vector2 as (0, 0), and a polygon
 * written as a list of anything but points becomes that many zero vectors. The node then holds a
 * value nobody asked for, the scene is saved with it, and the answer says the change was made. The
 * write that works is asserted beside each refusal, because a tool that had stopped writing
 * anything at all would satisfy the refusals exactly as well.
 */
async function testAValueTheSceneCannotHoldIsRefused({ call, refusal, project }: Editor): Promise<void> {
  const scene = { projectPath: project, scenePath: SCENE };
  await call('scene_node', { ...scene, op: 'add', nodeType: 'Polygon2D', nodeName: 'Guarded' });

  const set = (properties: Record<string, unknown>) => ({
    ...scene,
    op: 'set',
    nodePath: 'Guarded',
    properties,
  });

  assert.match(
    await refusal('scene_node', set({ z_index: 'on' })),
    /z_index is int and the value given is String, which cannot become one/,
    'a word where a number goes should be refused rather than stored as 0',
  );
  assert.match(
    await refusal('scene_node', set({ visible: 'nope' })),
    /visible is bool and the value given is String, which cannot become one/,
    'and where a bool goes, rather than stored as true',
  );
  assert.match(
    await refusal('scene_node', set({ position: 'somewhere' })),
    /position is Vector2 and the value given is String, which cannot become one/,
    'and where a vector goes, rather than stored as the origin',
  );

  // A list is a list whatever is in it, so the packed array is asked about its elements too.
  assert.match(
    await refusal('scene_node', set({ polygon: [{ x: 1, y: 2 }, { x: 3 }] })),
    /item 1 of the list given is Dictionary, not Vector2/,
    'an element that is not a point should be refused, naming which one',
  );

  // The file, not the tool. Every assertion above reads a refusal the tool handed back, and a
  // refusal that refused and saved anyway satisfies all of them: the caller is told no while the
  // scene on disk is the one they were told they had not written. A downstream project reached
  // for `git status` after the same refusal for the same reason, and the file is the only place
  // that question can be asked.
  const untouched = fileText(project, 'fixture.tscn');
  assert.doesNotMatch(untouched, /z_index = 0/, `no int was stored for the word: ${untouched}`);
  assert.doesNotMatch(untouched, /polygon = PackedVector2Array\(0, 0/, 'and no zero vectors were');
  assert.match(untouched, /\[node name="Guarded" type="Polygon2D"/, 'while the node itself is there');

  // And what the guard lets through: a number for a number, and points written the short way,
  // which is the form a caller writes by hand and the one that used to land as zeroes.
  await call(
    'scene_node',
    set({
      z_index: 3,
      polygon: [
        [10, 20],
        [30, 40],
      ],
    }),
  );
  const read = await call('scene_node', { ...scene, op: 'get', nodePath: 'Guarded' });
  assert.equal(
    asNumber(get(read, 'properties', 'z_index')),
    3,
    `the number should be written: ${text(read)}`,
  );
  const held = asArray(get(read, 'properties', 'polygon') ?? []);
  assert.equal(asNumber(get(held[0], 'x')), 10, `and the pairs read back as points: ${text(read)}`);
  assert.equal(asNumber(get(held[1], 'y')), 40, `both of them: ${text(read)}`);

  await call('scene_node', { ...scene, op: 'delete', nodePath: 'Guarded' });
}

/**
 * Connecting and disconnecting a signal, asserted against the scene file.
 *
 * The file rather than the answer, because the answer was right while the file was not: a
 * connection made without CONNECT_PERSIST is a runtime one, PackedScene.pack leaves it out, and
 * connect reported the connection it had just made over a scene that was saved without it.
 * Nothing in the tool's arguments tells a caller that, so this connects the way they do.
 */
async function testSceneSignals({ call, project }: Editor): Promise<void> {
  const scene = { projectPath: project, scenePath: SCENE };
  const connection = {
    sourceNodePath: 'Press',
    signalName: 'pressed',
    targetNodePath: '.',
    methodName: '_on_pressed',
  };

  await call('scene_signal', { ...scene, op: 'connect', ...connection });
  assert.match(
    fileText(project, 'fixture.tscn'),
    /\[connection signal="pressed" from="Press" to="\." method="_on_pressed"\]/,
    'the connection should be in the saved scene',
  );

  const listed = asArray(get(await call('scene_signal', { ...scene, op: 'list' }), 'connections'));
  assert.equal(listed.length, 1, 'and the tool should see it');
  assert.equal(get(listed[0], 'signalName'), 'pressed');
  assert.equal(get(listed[0], 'targetNodePath'), '.');

  await call('scene_signal', { ...scene, op: 'disconnect', ...connection });
  assert.doesNotMatch(fileText(project, 'fixture.tscn'), /\[connection/, 'and go when disconnected');
  assert.equal(asArray(get(await call('scene_signal', { ...scene, op: 'list' }), 'connections')).length, 0);
}

/** An animation and a track on it, read back out of the sub-resources the scene gained. */
async function testSceneAnimation({ call, project }: Editor): Promise<void> {
  const scene = { projectPath: project, scenePath: SCENE };

  await call('scene_node', { ...scene, op: 'add', nodeType: 'AnimationPlayer', nodeName: 'Anim' });
  await call('scene_animation', {
    ...scene,
    op: 'create',
    playerNodePath: 'Anim',
    animationName: 'fade',
    length: 2,
    loopMode: 'linear',
  });

  const track = await call('scene_animation', {
    ...scene,
    op: 'add_track',
    playerNodePath: 'Anim',
    animationName: 'fade',
    track: {
      type: 'property',
      nodePath: 'Press',
      property: 'modulate:a',
      keyframes: [
        { time: 0, value: 1 },
        { time: 2, value: 0 },
      ],
    },
  });
  assert.equal(get(track, 'trackIndex'), 0, 'the first track should be index 0');

  const saved = fileText(project, 'fixture.tscn');
  assert.match(saved, /\[sub_resource type="Animation"/, 'the animation should be in the scene');
  assert.match(saved, /length = 2\.0/);
  assert.match(saved, /loop_mode = 1/, 'linear is loop mode 1');
  assert.match(saved, /tracks\/0\/path = NodePath\("Press:modulate:a"\)/);
  assert.match(saved, /"times": PackedFloat32Array\(0, 2\)/);
  assert.match(saved, /&"fade": SubResource/, 'and be in the player library under its name');

  // A method track, which is the other kind and keeps none of the same fields: a call with its
  // arguments rather than a value to interpolate.
  const method = await call('scene_animation', {
    ...scene,
    op: 'add_track',
    playerNodePath: 'Anim',
    animationName: 'fade',
    track: {
      type: 'method',
      nodePath: '.',
      method: 'queue_redraw',
      keyframes: [{ time: 1, args: [] }],
    },
  });
  assert.equal(get(method, 'trackIndex'), 1, 'the second track should be index 1');

  const withMethod = fileText(project, 'fixture.tscn');
  assert.match(withMethod, /tracks\/1\/type = "method"/, 'the track type should be in the scene');
  assert.match(withMethod, /"method": &"queue_redraw"/, 'with the method it calls');

  // An argument of a type this tool did not use to know. It handled three tags of its own and
  // stored everything else as the dictionary it arrived as, so a Quaternion was saved as one.
  await call('scene_animation', {
    ...scene,
    op: 'add_track',
    playerNodePath: 'Anim',
    animationName: 'fade',
    track: {
      type: 'method',
      nodePath: '.',
      method: 'set_quaternion',
      keyframes: [{ time: 0, args: [{ _type: 'Quaternion', x: 0, y: 0, z: 0, w: 1 }] }],
    },
  });
  assert.match(
    fileText(project, 'fixture.tscn'),
    /Quaternion\(0, 0, 0, 1\)/,
    'a tagged value should reach the scene as the value, not as its dictionary',
  );
}

/** Resources written to disk: a .tres, a shader, and a theme edited in place. */
async function testResources({ call, refusal, project }: Editor): Promise<void> {
  const label = { projectPath: project, resourcePath: 'res://label.tres' };
  await call('resource_edit', { ...label, op: 'create', resourceType: 'LabelSettings' });
  await call('resource_edit', { ...label, op: 'modify', properties: { font_size: 24 } });
  assert.match(fileText(project, 'label.tres'), /font_size = 24/, 'the property should be in the file');

  // The same guard the scene write has, because this writes to a file just as readily: a word
  // where a number goes was stored as 0 and saved, and a property name nothing has was ignored
  // and reported as written.
  assert.match(
    await refusal('resource_edit', { ...label, op: 'modify', properties: { font_size: 'big' } }),
    /font_size is int and the value given is String, which cannot become one/,
    'a value the property cannot hold should be refused',
  );
  assert.match(
    await refusal('resource_edit', { ...label, op: 'modify', properties: { nonesuch: 1 } }),
    /has no property nonesuch/,
    'and a property the resource has not should be refused rather than ignored',
  );
  assert.match(
    fileText(project, 'label.tres'),
    /font_size = 24/,
    'and the file should still say what it said before either of them',
  );

  // And what it now reads that it could not: a packed array written by hand as pairs, which the
  // seven tags this tool knew did not cover at all.
  const hull = { projectPath: project, resourcePath: 'res://hull.tres' };
  await call('resource_edit', {
    ...hull,
    op: 'create',
    resourceType: 'ConvexPolygonShape2D',
    properties: {
      points: [
        [0, 0],
        [8, 0],
        [8, 8],
      ],
    },
  });
  assert.match(
    fileText(project, 'hull.tres'),
    /points = PackedVector2Array\(0, 0, 8, 0, 8, 8\)/,
    'the pairs should be saved as the points they name',
  );
  assert.match(
    await refusal('resource_edit', { ...hull, op: 'modify', properties: { points: [[0, 0], 'corner'] } }),
    /item 1 of the list given is String, not Vector2/,
    'and an element that is not a point should be refused, naming which one',
  );

  await call('resource_edit', {
    projectPath: project,
    resourcePath: 'res://look.gdshader',
    op: 'create_shader',
    shaderType: 'canvas_item',
  });
  assert.match(fileText(project, 'look.gdshader'), /^shader_type canvas_item;/, 'the shader type');

  // A theme op on a path with no theme used to load a blank one and save it there, which wrote
  // a resource nobody asked for and answered success for it.
  const missing = await refusal('resource_edit', {
    projectPath: project,
    resourcePath: 'res://absent.tres',
    op: 'set_theme_color',
    controlType: 'Button',
    colorName: 'font_color',
    color: { r: 1, g: 0, b: 0 },
  });
  assert.match(missing, /No Theme at/, 'a theme op should refuse a path with no theme');
  assert.ok(!existsSync(join(project, 'absent.tres')), 'and write nothing there');

  const theme = { projectPath: project, resourcePath: 'res://theme.tres' };
  await call('resource_edit', { ...theme, op: 'create', resourceType: 'Theme' });

  const coloured = await call('resource_edit', {
    ...theme,
    op: 'set_theme_color',
    controlType: 'Button',
    colorName: 'font_color',
    color: { r: 1, g: 0, b: 0 },
  });
  assert.equal(get(coloured, 'color', 'r'), 1, 'the colour should be read back off the saved theme');
  assert.equal(get(coloured, 'color', 'a'), 1, 'with the alpha it was stored with');

  const sized = await call('resource_edit', {
    ...theme,
    op: 'set_theme_font_size',
    controlType: 'Button',
    fontSizeName: 'font_size',
    size: 21,
  });
  assert.equal(get(sized, 'size'), 21, 'and the font size likewise');

  const written = fileText(project, 'theme.tres');
  assert.match(written, /Button\/colors\/font_color = Color\(1, 0, 0, 1\)/);
  assert.match(written, /Button\/font_sizes\/font_size = 21/);
}

/**
 * The ops that need a resource in hand: a texture on a sprite, a tile set under a tile map,
 * states in an AnimationTree.
 *
 * Setting a resource-valued property is what ties them together, and it is the thing that had
 * no way through: `Object.set` takes a Resource, a caller has a path, and nothing turned one
 * into the other, so a TileMap could never be given the TileSet its cells are placed from.
 */
async function testResourcesOnNodes({ call, refusal, project }: Editor): Promise<void> {
  const scene = { projectPath: project, scenePath: SCENE };

  // A texture resource rather than an image: a headless editor writes the .import file for a
  // PNG and leaves it `valid=false`, so nothing can load one. The tools under test assign a
  // Texture2D, which this is, and the import pipeline is somebody else's fixture.
  await call('resource_edit', {
    projectPath: project,
    resourcePath: 'res://dot.tres',
    op: 'create',
    resourceType: 'PlaceholderTexture2D',
    properties: { size: { type: 'Vector2', x: 8, y: 8 } },
  });

  // A texture is a resource-valued property like any other, so set is what assigns one: there is
  // no op of its own for sprites.
  await call('scene_node', { ...scene, op: 'add', nodeType: 'Sprite2D', nodeName: 'Dot' });
  await call('scene_node', {
    ...scene,
    op: 'set',
    nodePath: 'Dot',
    properties: { texture: 'res://dot.tres' },
  });
  assert.match(fileText(project, 'fixture.tscn'), /dot\.tres/, 'the texture should be on the sprite');

  // The boundary holds for a path inside `properties`, where no argument name announces that it
  // is one: user:// loads perfectly well and is not a file this project owns.
  assert.match(
    await refusal('scene_node', {
      ...scene,
      op: 'set',
      nodePath: 'Dot',
      properties: { texture: 'user://elsewhere.tres' },
    }),
    /res:\/\/ or uid:\/\//,
    'a resource outside the project is refused',
  );

  const tiles = { projectPath: project, resourcePath: 'res://tiles.tres' };
  await call('resource_edit', {
    ...tiles,
    op: 'create_tileset',
    sources: [{ texture: 'res://dot.tres', tileSize: { x: 8, y: 8 } }],
  });
  assert.match(fileText(project, 'tiles.tres'), /TileSetAtlasSource/, 'the atlas should be in the tile set');

  await call('scene_node', { ...scene, op: 'add', nodeType: 'TileMap', nodeName: 'Map' });
  await call('scene_node', {
    ...scene,
    op: 'set',
    nodePath: 'Map',
    properties: { tile_set: 'res://tiles.tres' },
  });
  assert.match(fileText(project, 'fixture.tscn'), /tile_set = ExtResource/, 'and on the tile map');

  const placed = await call('scene_node', {
    ...scene,
    op: 'set_tilemap_cells',
    nodePath: 'Map',
    cells: [
      { coords: { x: 0, y: 0 }, sourceId: 0, atlasCoords: { x: 0, y: 0 } },
      { coords: { x: 1, y: 0 }, sourceId: 0, atlasCoords: { x: 0, y: 0 } },
    ],
  });
  assert.equal(get(placed, 'placed'), 2, 'both cells should be on the map afterwards');

  // set_cell takes any source id and a tile set without it simply draws nothing, so a cell
  // naming a source that is not there has to be refused rather than counted.
  assert.match(
    await refusal('scene_node', {
      ...scene,
      op: 'set_tilemap_cells',
      nodePath: 'Map',
      cells: [{ coords: { x: 5, y: 5 }, sourceId: 7, atlasCoords: { x: 0, y: 0 } }],
    }),
    /has no source 7/,
    'a cell from a source the tile set has not should be refused',
  );

  assert.match(
    await refusal('scene_node', { ...scene, op: 'set', nodePath: 'Map', properties: { nonesuch: 1 } }),
    /has no property nonesuch/,
    'a property the node has not should be refused rather than ignored',
  );
  assert.match(
    await refusal('scene_node', {
      ...scene,
      op: 'set',
      nodePath: 'Map',
      properties: { tile_set: 'res://absent.tres' },
    }),
    /No resource at res:\/\/absent\.tres/,
    'and so should a resource path with nothing at it',
  );

  const states = { projectPath: project, scenePath: 'res://states.tscn' };
  await call('scene_animation', {
    ...states,
    op: 'add_state',
    animTreePath: 'Tree',
    stateName: 'idle',
    animationName: 'stand',
  });
  await call('scene_animation', {
    ...states,
    op: 'add_state',
    animTreePath: 'Tree',
    stateName: 'walk',
    animationName: 'step',
  });
  await call('scene_animation', {
    ...states,
    op: 'connect_states',
    animTreePath: 'Tree',
    fromState: 'idle',
    toState: 'walk',
  });

  const written = fileText(project, 'states.tscn');
  assert.match(written, /states\/idle\/node = SubResource/, 'the state should be in the machine');
  assert.match(written, /states\/walk\/node = SubResource/);
  assert.match(written, /transitions = \[/, 'and the transition with it');
}

/** editor_rescan is how a file written from outside the editor becomes loadable. */
async function testEditorRescan({ call, project }: Editor): Promise<void> {
  writeFileSync(join(project, 'late.gd'), 'extends Node\n');
  await call('editor_rescan', { projectPath: project });

  const attached = await call('resource_edit', {
    projectPath: project,
    resourcePath: 'res://custom.tres',
    op: 'create',
    resourceType: 'Resource',
    script: 'res://late.gd',
  });
  assert.equal(get(attached, 'resourcePath'), 'res://custom.tres');
  assert.match(fileText(project, 'custom.tres'), /late\.gd/, 'the script should be on the resource');
}

/**
 * A class declared on disk, listed in the cache, and invisible to the editor.
 *
 * This is the state every check gdharness had called clean, because all of them compared one
 * file on disk against another and both of those are correct here. What is wrong is the list
 * inside the editor: its scan is change-detecting, a headless engine has already recorded the
 * file, so the walk reads it as settled and never looks inside for the declaration. Two
 * projects lost a day each to it, both times to a diagnostic that was right and disbelieved.
 *
 * Whether an editor has taken a newly written file in before anybody asks it to scan is the
 * engine's business and is not the same on every platform: measured, a Linux editor has not and
 * the rebuild names the class, a Windows one has. Both are true answers about that editor, so
 * what is asserted is that the answer is true rather than which of the two it is, and that the
 * cure holds everywhere. The editor is asked whether it can see the class, never told.
 */
async function testAClassTheEditorCannotSee({ call, project }: Editor): Promise<void> {
  writeFileSync(join(project, 'late_class.gd'), 'class_name LateClass\nextends RefCounted\n');

  const rebuilt = await call('project_import', { projectPath: project, op: 'refresh_classes' });
  const cache = join(project, '.godot', 'global_script_class_cache.cfg');
  assert.ok(readFileSync(cache, 'utf8').includes('LateClass'), 'the cache on disk should list it');
  assert.equal(get(rebuilt, 'classesUnchecked'), undefined, `the editor answered: ${text(rebuilt)}`);
  const named = asArray(get(rebuilt, 'unseenByEditor') ?? []).map((entry) => get(entry, 'className'));
  assert.ok(
    named.length === 0 || named.join(',') === 'LateClass',
    `the only class it could be missing is the one just written: ${text(rebuilt)}`,
  );

  // A scan is the cure, and it is the half that holds on every platform.
  const seeing = await call('editor_rescan', { projectPath: project });
  assert.equal(get(seeing, 'ok'), true, `a scanned project resolves its own classes: ${text(seeing)}`);
  assert.equal(get(seeing, 'unseenByEditor'), undefined, `with nothing to name: ${text(seeing)}`);
}

/**
 * A scan writes the class cache from the list the editor is holding, which is why the file on
 * disk is never the thing to ask after one.
 *
 * What a downstream project saw was a rescan leaving `global_script_class_cache.cfg` narrower
 * than the project with nothing in the answer about it, and the fix reached for first was a
 * second check that read the file. Measured here, the file cannot disagree with the editor: an
 * emptied one comes back full. So what narrows it is the registry behind it, the class the
 * editor cannot resolve is the class the scan writes the file without, and `unseenByEditor` is
 * the whole answer rather than half of it.
 */
async function testAScanWritesTheCacheFromTheEditor({ call, project }: Editor): Promise<void> {
  writeFileSync(join(project, 'parted.gd'), 'class_name PartedClass\nextends RefCounted\n');
  await call('project_import', { projectPath: project, op: 'refresh_classes' });
  const cache = join(project, '.godot', 'global_script_class_cache.cfg');
  assert.ok(readFileSync(cache, 'utf8').includes('PartedClass'), 'the rebuild should have listed it');

  writeFileSync(cache, 'list=[]\n');
  const scanned = await call('editor_rescan', { projectPath: project });
  assert.equal(get(scanned, 'ok'), true, `the scan should settle: ${text(scanned)}`);
  assert.ok(
    readFileSync(cache, 'utf8').includes('PartedClass'),
    "the scan should write the editor's list back over the emptied file",
  );
  assert.equal(
    get(scanned, 'unseenByEditor'),
    undefined,
    `and it holds every class it wrote: ${text(scanned)}`,
  );
}

/**
 * A rescan does not undo the rebuild that told the caller to run it.
 *
 * The sequence is the one `refresh_classes` prints as its own advice, run exactly as printed.
 * Downstream: the rebuild wrote a correct cache and named `Offer` as a class the editor was not
 * holding; the rescan it recommended then wrote the editor's own list over that file, dropped
 * `Offer`, and answered `ok: true`. The damage surfaced in a separate headless engine an hour
 * later as `Identifier "Offer" not declared in the current scope`, exit 105, which reads as a
 * broken test rather than as a clobbered cache. Twenty minutes and one misread failure.
 *
 * What is asked is the thing a caller following that advice is entitled to: after the rescan, the
 * class is still in the file. Whether the editor picked it up or the rescan was refused is the
 * engine's business and the answer's; losing it silently is not an option either way.
 */
async function testARescanKeepsWhatTheRebuildWrote({ call, project }: Editor): Promise<void> {
  const cache = join(project, '.godot', 'global_script_class_cache.cfg');
  // Enough files that the editor's scan takes real time. Reported from a project of 376 classes,
  // where the scan reported itself finished 296ms in and the cache was written after that; a
  // project of three files finishes inside the first poll and never shows the gap.
  const crowd = join(project, 'crowd');
  mkdirSync(crowd, { recursive: true });
  for (let index = 0; index < 400; index += 1) {
    writeFileSync(join(crowd, `filler_${index}.gd`), `class_name Filler${index}\nextends RefCounted\n`);
  }
  writeFileSync(join(project, 'offered.gd'), 'class_name OfferedClass\nextends RefCounted\n');

  // A headless engine records the file first, which is the state the editor's own scan goes past:
  // change-detecting, and the file already looks imported. That is what made the class invisible
  // to the editor downstream while being correct everywhere on disk.
  const rebuilt = await call('project_import', { projectPath: project, op: 'refresh_classes' });
  assert.ok(
    readFileSync(cache, 'utf8').includes('OfferedClass'),
    `the rebuild should have written it: ${text(rebuilt)}`,
  );

  // The state the report describes, reproduced rather than assumed: the file is on disk, the cache
  // has it, and the editor's own list does not. Without this the case below is a rescan of a
  // project where nothing was ever at risk, which passes for the wrong reason.
  const blind = asArray(get(rebuilt, 'unseenByEditor') ?? []).map((one) => asString(get(one, 'className')));
  assert.ok(
    blind.includes('OfferedClass'),
    `the editor should be blind to the new class, or this proves nothing: ${blind.length} unseen`,
  );

  const scanned = await call('editor_rescan', { projectPath: project });
  const after = readFileSync(cache, 'utf8');
  const missing = ['OfferedClass', 'Filler0', 'Filler399'].filter((name) => !after.includes(name));
  // What the caller following that advice is entitled to, whichever way the scan went: the class
  // is in the file when the call comes back. Whether the editor picked it up or the cache had to
  // be rebuilt around it is the engine's business, and the answer says which.
  assert.deepEqual(missing, [], `the rescan must not leave the file short: ${text(scanned)}`);

  // And the answer is not allowed to be quiet about having done it. A rescan that dropped classes
  // has an editor still holding the short list, so the next one drops them again.
  const lost = asArray(get(scanned, 'cacheLost') ?? []).map((one) => asString(one));
  if (lost.length > 0) {
    const restored = asArray(get(scanned, 'cacheRestored') ?? []).map((one) => asString(one));
    assert.deepEqual(
      lost.filter((name) => !restored.includes(name)),
      [],
      `everything it lost should be named as put back: ${text(scanned)}`,
    );
    assert.match(
      asString(get(scanned, 'note')),
      /editor_launch restart/,
      `and the editor still holding the short list should be said: ${text(scanned)}`,
    );
  }
}

/**
 * A rescan does not write a class the editor still holds for a script that is gone back into the
 * cache, and says what it dropped.
 *
 * The other direction from the case above. A `class_name` script renamed on disk, its `.uid`
 * moved with it and the class renamed inside: the editor goes on holding the old class for the
 * old path, and the scan writes that list over the cache, so the cache carries both the new class
 * and the old one at a path that does not exist. The next engine to read it fails on `Could not
 * parse global class "Pace" from "res://ui/pace.gd"` in whichever correct script shares the bare
 * name, and the scan had answered `ok: true` with nothing else. Reproduced three times downstream,
 * the third one controlled: a rebuild removed the ghost and one scan put it back.
 *
 * What is held is the invariant the report proposed: after a scan, every entry the cache carries
 * names a file that exists, and the answer names what it dropped. Whether the editor is still
 * holding the ghost is the editor's business and the note's.
 */
async function testARescanDropsAClassWhoseScriptIsGone({ call, project }: Editor): Promise<void> {
  const cache = join(project, '.godot', 'global_script_class_cache.cfg');
  const ui = join(project, 'ui');
  mkdirSync(ui, { recursive: true });
  writeFileSync(join(ui, 'pace.gd'), 'class_name Pace\nextends RefCounted\n');
  // The bare name shared by a correct script, which is where the failure lands downstream.
  writeFileSync(
    join(ui, 'settings.gd'),
    'class_name Settings\nextends RefCounted\n\nenum Pace { SLOW, FAST }\n',
  );
  const picked = await call('editor_rescan', { projectPath: project });
  assert.ok(
    readFileSync(cache, 'utf8').includes('"Pace"'),
    `the editor should hold Pace first: ${text(picked)}`,
  );

  // Renamed on disk, the way a project does it: the file, the class in it, and the sidecar.
  writeFileSync(join(ui, 'tempo.gd'), 'class_name Tempo\nextends RefCounted\n');
  rmSync(join(ui, 'pace.gd'));
  if (existsSync(join(ui, 'pace.gd.uid'))) {
    renameSync(join(ui, 'pace.gd.uid'), join(ui, 'tempo.gd.uid'));
  }

  const scanned = await call('editor_rescan', { projectPath: project });
  const after = readFileSync(cache, 'utf8');
  assert.ok(after.includes('"Tempo"'), `the new class is in the cache: ${text(scanned)}`);
  assert.ok(
    !after.includes('res://ui/pace.gd'),
    `and the old path is not, whatever the editor still holds: ${text(scanned)}\n${after}`,
  );
  // Every entry names a file, which is the invariant rather than the reading.
  for (const [, path] of after.matchAll(/"path":\s*"res:\/\/([^"]+)"/g)) {
    assert.ok(existsSync(join(project, path ?? '')), `every cached path exists: res://${path}`);
  }
  assert.deepEqual(
    asArray(get(scanned, 'cacheDropped') ?? []).map((one) => asString(one)),
    ['Pace'],
    `the answer names what it dropped: ${text(scanned)}`,
  );
  assert.match(
    asString(get(scanned, 'note')),
    /editor_launch restart/,
    `and says the editor still holds it: ${text(scanned)}`,
  );
  assert.equal(get(scanned, 'ok'), true, `the cache is right when the call comes back: ${text(scanned)}`);

  // The consequence the report named: a headless engine reading the cache now parses the script
  // that shares the bare name. The engine having run is the positive beside that absence; what
  // else this project's three-frame boot reports at exit is its own business.
  const checked = await call('editor_run', { projectPath: project, op: 'check' });
  assert.equal(
    get(checked, 'exitCode'),
    0,
    `an engine reading the cache after the scan runs: ${text(checked)}`,
  );
  assert.ok(asNumber(get(checked, 'frames')) >= 1, `and draws frames: ${text(checked)}`);
  const parseFailures = asArray(get(checked, 'entries')).filter((entry) =>
    asString(get(entry, 'text')).includes('Could not parse global class'),
  );
  assert.deepEqual(parseFailures, [], `with no ghost class to fail parsing on: ${text(checked)}`);
}

/**
 * Asked about a project this editor is not open on, the answer is "not checked", never "clean".
 *
 * The editor holds the classes of the project it opened, so comparing them against another
 * project's cache makes every class in it look unseen. Guarding that is worth a case of its own
 * because it is also the one place the check reports a positive on demand, whatever the platform
 * does: a silence here is the comparison never running, which is the shape this whole thing
 * exists to stop and is exactly how it first shipped.
 */
async function testTheClassCheckKnowsWhichProjectItIsAbout({ call, project }: Editor): Promise<void> {
  const elsewhere = mkdtempSync(join(realpathSync(tmpdir()), 'gdharness-other-'));
  try {
    writeFileSync(join(elsewhere, 'project.godot'), 'config_version=5\n');
    writeFileSync(join(elsewhere, 'stranger.gd'), 'class_name Stranger\nextends RefCounted\n');

    const rebuilt = await call('project_import', { projectPath: elsewhere, op: 'refresh_classes' });
    assert.equal(get(rebuilt, 'unseenByEditor'), undefined, `Stranger is not unseen: ${text(rebuilt)}`);
    assert.match(
      String(get(rebuilt, 'classesUnchecked')),
      /open on .*not this one/,
      `the answer should say it did not check, and why: ${text(rebuilt)}`,
    );
    assert.notEqual(project, elsewhere, 'the two projects have to be two projects');
  } finally {
    sweep(elsewhere);
  }
}

/**
 * A setting read from the editor rather than from the file, and the two disagreeing on purpose.
 *
 * `from: "editor"` exists because the two readings are not the same: the file is what a check with
 * nobody's window open can reproduce, and the editor is what it has been told. Asserting only that
 * the editor answers would be satisfied by a server that quietly read the file and called it the
 * editor's, which is exactly the ambiguity the argument was added to remove, so the file is changed
 * underneath the editor first and then both are asked. Whether an editor ever picks a change up on
 * its own is the engine's business; what is asserted is that the two answers come from two places,
 * and the editor's is the one it was holding.
 */
async function testASettingReadFromTheEditor({ call, refusal, project }: Editor): Promise<void> {
  const named = 'application/config/description';
  const written = 'what only the file says';

  const before = await call('project_settings', {
    projectPath: project,
    op: 'get',
    setting: named,
    from: 'editor',
  });
  assert.equal(get(before, 'exists'), true, `the editor should hold the setting: ${text(before)}`);
  assert.equal(asString(get(before, 'value')), '', `and it opened with nothing in it: ${text(before)}`);

  // Headless, so the file changes and the open editor is never told.
  await call('project_settings', { projectPath: project, op: 'set', setting: named, value: written });
  assert.match(
    readFileSync(join(project, 'project.godot'), 'utf8'),
    new RegExp(written),
    'the write should have reached the file',
  );

  const fromDisk = await call('project_settings', { projectPath: project, op: 'get', setting: named });
  assert.equal(asString(get(fromDisk, 'value')), written, `disk reads the file: ${text(fromDisk)}`);

  const fromEditor = await call('project_settings', {
    projectPath: project,
    op: 'get',
    setting: named,
    from: 'editor',
  });
  assert.equal(
    asString(get(fromEditor, 'value')),
    '',
    `the editor answers with what it is holding: ${text(fromEditor)}`,
  );

  // The prefix form comes back with the type of each, which is the half a name hides: a family of
  // levels can hold a bool, and a level written over it looks like it worked.
  const family = await call('project_settings', {
    projectPath: project,
    op: 'get',
    prefix: 'debug/gdscript/warnings/',
    from: 'editor',
  });
  const settings = asArray(get(family, 'settings') ?? []);
  assert.ok(settings.length > 40, `the editor should list the whole family: ${settings.length}`);
  const kinds = new Set(settings.map((one) => asString(get(one, 'type'))));
  assert.ok(kinds.has('int'), `the levels are ints: ${[...kinds].join(', ')}`);
  assert.ok(kinds.has('bool'), `and enable is not: ${[...kinds].join(', ')}`);

  // An op with no editor to ask is refused rather than answered from the file under the editor's
  // name, which is the whole of what the argument promises.
  const refused = await refusal('project_settings', {
    projectPath: project,
    op: 'set',
    setting: named,
    value: 'x',
    from: 'editor',
  });
  assert.match(refused, /does not take from/, `a write has no editor reading to choose: ${refused}`);
}

/**
 * The language server tools, which answer from the editor's own server rather than from the addon.
 *
 * Both scripts are driven, the one that parses and the one that does not. A diagnostics tool
 * that has quietly stopped answering returns nothing for every file, which reads exactly like a
 * clean project, so the case that matters is the one where something is wrong.
 */
/**
 * A class written under a running editor is unresolved until something tells the editor, and
 * `editor_rescan` is what tells it.
 *
 * Two projects hit this and neither could say which side was wrong: a declaration, the cache on
 * disk and a headless compile all agreeing a file was fine, against diagnostics reporting errors on
 * it. The answer now names the class under `typesTheEditorHasNotLoaded`, and this is what holds that
 * answer to the editor rather than to a reading of how the editor ought to behave.
 *
 * The idle waits are the load-bearing half and are not padding. The remedy takes time and so does
 * doing nothing, so a rescan that appears to clear this is indistinguishable from an editor that
 * would have caught up on its own a moment later. Without the control the case would pass with the
 * rescan removed, and the sentence the tool prints would be a guess.
 */
async function testAClassWrittenUnderTheEditorNeedsARescan({ call, project }: Editor): Promise<void> {
  writeFileSync(
    join(project, 'chime.gd'),
    ['class_name Chime', 'extends Node', '', '', 'func strike() -> void:', '\tpass', ''].join('\n'),
  );
  writeFileSync(
    join(project, 'striker.gd'),
    [
      'extends Node',
      '',
      'var chime: Chime = Chime.new()',
      '',
      '',
      'func go() -> void:',
      '\tchime.strike()',
      '',
    ].join('\n'),
  );

  const rebuilt = await call('project_import', { projectPath: project, op: 'refresh_classes' });
  assert.deepEqual(get(rebuilt, 'added'), ['Chime'], `the cache should gain it: ${JSON.stringify(rebuilt)}`);

  const readStriker = async (): Promise<unknown> => {
    // The language server publishes on its own schedule, so an answer taken the instant after a
    // write says more about the timing than about the analysis.
    await delay(2500);
    return await call('script_diagnostics', { projectPath: project, scriptPath: 'res://striker.gd' });
  };
  const namesChime = (answered: unknown): boolean =>
    asArray(get(answered, 'diagnostics'))
      .map((entry) => asString(get(entry, 'message'), 'message'))
      .some((message) => message.includes('Chime'));

  const before = await readStriker();
  assert.ok(
    namesChime(before),
    `the editor should not resolve a class written under it: ${JSON.stringify(before)}`,
  );
  assert.deepEqual(
    get(before, 'typesTheEditorHasNotLoaded'),
    [{ type: 'Chime', declaredIn: 'res://chime.gd', inTheClassCache: true }],
    `and the answer should name it, with the cache answer that picks the remedy: ${JSON.stringify(before)}`,
  );
  assert.match(
    asString(get(before, 'staleAnalysis'), 'staleAnalysis'),
    /editor_rescan/,
    'and should send the caller to the cheap remedy rather than to a restart',
  );

  // Twice, because one wait of the same length as the remedy's proves nothing about which of them
  // did the work.
  for (const attemptNumber of [1, 2]) {
    assert.ok(
      namesChime(await readStriker()),
      `waiting alone should not clear it (attempt ${attemptNumber}), or the rescan below is being credited with time passing`,
    );
  }

  await call('editor_rescan', { projectPath: project });
  const after = await readStriker();
  assert.equal(
    namesChime(after),
    false,
    `editor_rescan should make the editor resolve it, with no restart: ${JSON.stringify(after)}`,
  );
  assert.equal(get(after, 'typesTheEditorHasNotLoaded'), undefined, 'and the answer should stop naming it');
  assert.equal(get(after, 'clean'), true, JSON.stringify(after));
}

/**
 * A method added to a type the language server has already analysed is resolved without being told.
 *
 * The other half of #387, and the half that does *not* misbehave here. A project reported a method
 * added to an existing `class_name` coming back missing at every caller until the editor restarted,
 * with `editor_rescan` and `refresh_classes` both failing to clear it. That does not happen to an
 * editor this suite starts, and the difference is worth holding onto rather than assuming: it says
 * the fault needs something an editor seconds old does not have, so anyone hunting it needs a
 * reproduction before a remedy.
 *
 * The dependent is in the project before the editor starts and is read once before the change, so
 * the server has analysed it. An earlier probe wrote the dependent fresh, which had the server
 * analysing it from scratch against the current type: clean for a reason that says nothing about
 * the fault, and a case nobody reported.
 *
 * Asserted as what the editor does rather than as what it fails to do, so a Godot that starts
 * holding the old copy fails this rather than quietly matching a "no complaint" expectation.
 */
async function testAMethodAddedToAnAnalysedTypeIsPickedUp({ call, project }: Editor): Promise<void> {
  const read = async (): Promise<unknown> => {
    await delay(2500);
    return await call('script_diagnostics', { projectPath: project, scriptPath: 'res://ringer.gd' });
  };

  const analysed = await read();
  assert.equal(
    get(analysed, 'clean'),
    true,
    `the dependent starts clean and analysed: ${JSON.stringify(analysed)}`,
  );

  // The declaring file is opened through the language server too, so that this case cannot pass
  // merely because the server had never looked at it. Godot resolves a dependency from disk rather
  // than from the copy it holds open, which was measured here by doing exactly this: the held copy
  // stayed at the old content and the new method resolved anyway.
  const declaring = await call('script_diagnostics', {
    projectPath: project,
    scriptPath: 'res://bell.gd',
  });
  assert.equal(get(declaring, 'clean'), true, JSON.stringify(declaring));

  writeFileSync(
    join(project, 'bell.gd'),
    [
      'class_name Bell',
      'extends Node',
      '',
      'var clapper: Clapper = Clapper.new()',
      'var tolls: int = 0',
      '',
      '',
      'func toll() -> int:',
      '\ttolls += clapper.weight()',
      '\treturn tolls',
      '',
      '',
      'func silence() -> void:',
      '\ttolls = 0',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(project, 'ringer.gd'),
    [
      'class_name Ringer',
      'extends Node',
      '',
      'var bell: Bell = Bell.new()',
      '',
      '',
      'func ring_once() -> int:',
      '\treturn bell.toll()',
      '',
      '',
      'func hush() -> void:',
      '\tbell.silence()',
      '',
    ].join('\n'),
  );

  // Both readings in the same window, which is the whole point of this case and was missing from
  // it: the analyser's answer taken between the change and any remedy, and the built copy taken in
  // the next call. Without the first one, a clean diagnostic read after the reload says only that
  // the reload worked, and pairing it with a stale built copy from before is two readings from
  // different moments reported as one divergence.
  const analyserFirst = await read();
  const reloaded = await call('editor_rescan', { projectPath: project, reloadScript: 'res://bell.gd' });
  assert.equal(get(reloaded, 'reloadProblem'), undefined, JSON.stringify(reloaded));
  const names = (field: string): string[] =>
    asArray(get(reloaded, field)).map((entry) => asString(entry, 'method'));

  // The divergence, held as the one reading it is. The analyser resolved a call to the new method
  // with nothing asked of the editor, and in the next call the copy the editor built has not got
  // that method, so the built copy and whatever the analyser resolves types against are two things
  // rather than one. Asserted together because either alone says nothing: a clean analyser is the
  // ordinary case, and a stale built copy read after a remedy is a reading from another moment.
  assert.equal(
    get(analyserFirst, 'clean'),
    true,
    `the analyser should resolve the new method before any remedy: ${JSON.stringify(analyserFirst)}`,
  );
  assert.ok(
    !names('heldBeforeReload').includes('silence'),
    `while the built copy has not got it: ${names('heldBeforeReload').join(', ')}`,
  );
  assert.ok(
    names('heldBeforeReload').includes('toll'),
    'and should be a real copy of that script rather than an empty answer',
  );

  assert.ok(
    names('reloadedMethods').includes('silence'),
    `the recompiled copy should have the method added since it was built: ${names('reloadedMethods').join(', ')}`,
  );
  assert.ok(names('reloadedMethods').includes('toll'), 'and should still have the one it was built with');

  const grown = await read();
  assert.equal(
    get(grown, 'clean'),
    true,
    `a call to the new method resolves with nothing asked of the editor: ${JSON.stringify(grown)}`,
  );
  assert.equal(
    get(grown, 'contradictedByTheFile'),
    undefined,
    'and there is nothing for the contradiction check to name, because the editor kept up',
  );
}

/**
 * A game the editor is playing survives the server being replaced under it.
 *
 * The case that used to stand for this, `testARunOutlivesItsServer` in the regression tier, starts
 * its run with no editor connected, so the server spawns the game itself and there is no debug
 * adapter session anywhere. An editor-played run is the other shape: the editor spawns it, the
 * editor's debugger holds it, and gdharness attaches to that debugger. Replacing the server is then
 * replacing one end of the connection the game is held by, which the other case never touches.
 *
 * This was written because a downstream project lost an editor-played run inside the window a
 * reconnect landed in, with no evidence inside the window either way, and said plainly that the
 * safety measurement on record did not cover that shape. It did not.
 *
 * The session opens by itself here: an editor-played game and the debug tools share one adapter
 * client, so playing the scene is what puts a session on the other end of the shutdown. Nothing in
 * this case has to ask for one, which is also why the fault it guards needs no unusual setup.
 *
 * It takes its own editor and server rather than the ones every other case shares, because ending
 * the server ends the session the rest of them are using. It runs after that pair is down rather
 * than inside it, since two editors at once on a machine already holding one per project is where
 * the spawns begin to fail, and a case that cannot start says nothing about what it guards.
 */
async function testAPlayedRunOutlivesTheServerUnderIt(godotPath: string): Promise<void> {
  await withEditor(godotPath, async (own) => {
    const started = await own.play({ op: 'start', headless: true });
    assert.equal(get(started, 'started'), true, `the editor should have played the scene: ${text(started)}`);
    // The whole difference between this case and the one in the regression tier. A run the server
    // spawned would answer `gdharness` here, have no debug adapter session behind it, and prove
    // nothing about the shape that went missing.
    assert.equal(get(started, 'through'), 'editor', `the editor should be the one playing: ${text(started)}`);
    const pid = asNumber(get(started, 'runtime', 'pid'), 'the played run needs a process of its own');
    assert.ok(pid > 0 && alive(pid), `the run should be up before anything is replaced: ${text(started)}`);

    // A reconnect as a harness performs one: stdin ends and the server shuts down through the same
    // path a SIGINT takes. Not a kill, which runs no shutdown at all and so never reaches the
    // disconnect this case is about, and would leave the fixture green while every real reconnect
    // took somebody's game with it.
    own.server.child.stdin?.end();
    await exited(own.server.child);
    assert.ok(own.server.exited, 'the server should be gone, or nothing below is a test of anything');

    // Long enough for a termination asked for on the way out to have happened. A game killed by
    // the disconnect dies with the request rather than later, so this is slack rather than a race.
    await delay(2500);
    assert.ok(
      alive(pid),
      'a game the editor is playing must outlive the server that was talking to its debugger',
    );

    // Surviving is not the same as being usable, and the second half only became reachable when
    // the first started working: while the shutdown ended the game, no replacement server ever met
    // a played run to pick up. A game nobody can stop except by pid is most of the fault still
    // there, so the replacement is brought up and asked.
    const replacement = new ServerProcess({ env: own.serverEnv });
    try {
      await replacement.initialize('played-run-fixture');
      const answered = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
        parseTextContent(await replacement.request('tools/call', { name, arguments: args }, TOOL_TIMEOUT_MS));

      // The editor has to dial back in before a played run can be seen at all, which is the window
      // the refusal now names. Waited out here rather than asserted around: what is under test is
      // what the server can do once the editor is there.
      const until = Date.now() + CONNECT_TIMEOUT_MS;
      let back = false;
      while (!back && Date.now() < until) {
        back = get(await answered('editor_status', {}), 'editor', 'connected') === true;
        if (!back) await delay(500);
      }
      assert.ok(back, 'the editor should reach the replacement server, or the rest proves nothing');

      // Asked of editor_status rather than editor_run check, which is a boot probe that starts an
      // engine of its own and answers about the project rather than about this run.
      const found = await answered('editor_status', {});
      assert.equal(
        get(found, 'game', 'playingInEditor', 'playing'),
        true,
        `the replacement should see the run the editor is still playing: ${text(found)}`,
      );
      assert.equal(
        get(found, 'game', 'processActive'),
        true,
        `and that it is a process rather than a record: ${text(found)}`,
      );
      // The other half of the held-game case beside this one: a replacement attaching to a game
      // that is running must not take it for held. The attach asks the adapter for a stack, and a
      // running game has to answer none; a stale frame left over from an earlier halt would read
      // here as a game sitting still.
      const picked = await answered('editor_output', {});
      assert.equal(get(picked, 'heldAt'), null, `a running game picked up is not held: ${text(picked)}`);
      const stopResponse = await replacement.request(
        'tools/call',
        // No projectPath: stop is about the run this server is holding, not about a project named
        // by the caller, and an argument the op does not take is refused rather than ignored.
        { name: 'editor_run', arguments: { op: 'stop' } },
        TOOL_TIMEOUT_MS,
      );
      const ended = parseTextContent(stopResponse);
      assert.equal(
        get(ended, 'stopped'),
        true,
        `and be able to end it, rather than: ${textOf(stopResponse) ?? text(ended)}`,
      );
      assert.equal(get(ended, 'through'), 'editor', `through the editor that owns it: ${text(ended)}`);
      await delay(1500);
      assert.ok(!alive(pid), 'after which the game is actually gone, rather than reported gone');
    } finally {
      await replacement.stop();
    }
  });
}

/**
 * A game held at a breakpoint stays held for the server that replaces the one it was reported to,
 * and that server finds out, says so, and can let it go.
 *
 * `halt` was learned from the adapter's `stopped` event and from nothing else, so a session that
 * connected after the halt never learned it: the event had gone to whichever clients were there.
 * Measured against a real editor, in three states. The server that was connected when the game
 * stopped is told, attached or not, and the reason it is told names the stop. A fresh session
 * attaching *while* that server holds the game is answered the frames, so its attach asks and it
 * knows. A fresh session attaching *after* that server has gone is answered a thread and no frames
 * while the game is still sitting at its breakpoint, which is the state every replacement server is
 * in after a reconnect, and the game itself is what says held: it accepts a runtime connection and
 * never answers a ping.
 *
 * So the three are held together, since any one alone fits another story: the first server's
 * reason is the event arriving on a socket that never attached; frames for a second session while
 * held is the instrument working; the replacement reading held from the runtime, refusing the stack
 * for the right reason, and the game ticking once let go, is what separates held from wedged and
 * from forgotten.
 */
async function testAHeldGameIsStillHeldForTheReplacement(godotPath: string): Promise<void> {
  await withEditor(godotPath, async (own) => {
    const main = { projectPath: own.project, scriptPath: 'res://main.gd' };
    await own.call('debug_breakpoint', { ...main, op: 'set', line: BREAK_LINE });
    const run = await own.play({ op: 'start', headless: true });
    assert.equal(get(run, 'through'), 'editor', `the editor should be the one playing: ${text(run)}`);
    const pid = asNumber(get(run, 'runtime', 'pid'), 'the played run needs a process of its own');
    await stackWithin(own.attempt, 'the game should stop at the breakpoint', (stack) => stack.length > 0);

    // The server that was sent the event says so, with the reason the event carried. Its session
    // attached only just now, for the stack read above, and an attach that asked the adapter again
    // would answer "attached" here in place of what it was told.
    const before = await own.call('editor_output', {});
    assert.equal(
      get(before, 'heldAt', 'reason'),
      'breakpoint',
      `held, seen by the first server: ${text(before)}`,
    );

    // A second session, attached while the first server holds the game. It was never sent the
    // stopped event, so what it knows it learned by asking on attach. This is the state a server
    // meets when the editor's own debugger, or another client, has the game at a breakpoint.
    const second = new GodotDAPClient(own.dapPort);
    await second.connect();
    await second.attach();
    assert.ok(second.isStopped(), 'a session attaching to a held game learns that it is held');
    assert.equal(second.whereItStopped()?.reason, 'attached', 'and says how it came to know');
    const seen = await second.getStackTrace();
    assert.equal(get(seen[0], 'line'), BREAK_LINE, `on the line it is held at: ${JSON.stringify(seen[0])}`);
    await second.abandon();
    // The first server still holds it: a second client asking did not let it go.
    const stillSaid = await own.attempt('debug_state', { op: 'stack' });
    const still = stillSaid.ok ? asArray(JSON.parse(stillSaid.text), 'stackFrames') : [];
    assert.equal(get(still[0], 'line'), BREAK_LINE, `and asking did not release it: ${stillSaid.text}`);

    // Now the client holding it goes, the way a harness reconnect ends a server: stdin ends and the
    // shutdown runs, which closes the adapter socket without a disconnect request.
    own.server.child.stdin?.end();
    await exited(own.server.child);
    assert.ok(own.server.exited, 'the server should be gone, or nothing below is a test of anything');
    await delay(1500);
    assert.ok(alive(pid), 'the game outlives the server that was holding it');

    const replacement = new ServerProcess({ env: own.serverEnv });
    try {
      await replacement.initialize('held-game-fixture');
      const answered = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
        parseTextContent(await replacement.request('tools/call', { name, arguments: args }, TOOL_TIMEOUT_MS));
      const until = Date.now() + CONNECT_TIMEOUT_MS;
      let back = false;
      while (!back && Date.now() < until) {
        back = get(await answered('editor_status', {}), 'editor', 'connected') === true;
        if (!back) await delay(500);
      }
      assert.ok(back, 'the editor should reach the replacement server, or the rest proves nothing');

      // The adapter shows this session no stack, so what it knows it learned from the runtime: a
      // held game accepts the connection and never answers. Asserted as held rather than as not
      // running, and with the reason that says which instrument answered.
      const output = await answered('editor_output', {});
      assert.equal(
        get(output, 'heldAt', 'reason'),
        'unanswered',
        `the replacement finds the game held, from the runtime not answering: ${text(output)}`,
      );
      assert.equal(get(output, 'heldUnknown'), undefined, 'and does not also say it could not tell');
      const stack = await replacement.request(
        'tools/call',
        { name: 'debug_state', arguments: { op: 'stack' } },
        TOOL_TIMEOUT_MS,
      );
      assert.match(
        textOf(stack) ?? '',
        /The game is held, and this server cannot read its stack/,
        `and the stack refusal says held and why it cannot be read, not running: ${textOf(stack)}`,
      );

      // A bystander, connected and nothing more, the way the server that played the scene is
      // connected before its first stack read. It is told when the game is let go by somebody
      // else, which is what the editor's own debugger or another client does, and what it knows
      // afterwards is that the game runs: without the event, a session told of the stop went on
      // answering held about a game that was running.
      const bystander = new GodotDAPClient(own.dapPort);
      await bystander.connect();
      assert.equal(bystander.holdIsKnown(), false, 'a bare connection opened now has been told nothing');

      // Let go through the replacement. That it then ticks is what says the game was held rather
      // than wedged, and that this session can act on a hold it was never told about.
      const released = await replacement.request(
        'tools/call',
        { name: 'debug_control', arguments: { op: 'continue' } },
        TOOL_TIMEOUT_MS,
      );
      assert.equal(
        get(parseTextContent(released), 'continued'),
        true,
        `continue through the replacement: ${textOf(released)}`,
      );
      const afterwards = await answered('editor_output', {});
      assert.equal(get(afterwards, 'heldAt'), null, `and the session now knows it runs: ${text(afterwards)}`);
      const toldToo = Date.now() + 5000;
      while (!bystander.holdIsKnown() && Date.now() < toldToo) {
        await delay(50);
      }
      assert.ok(bystander.holdIsKnown(), 'a continue by another client is reported to every connection');
      assert.equal(bystander.isStopped(), false, 'as a game that runs');
      await bystander.abandon();
      // Polled, because a game let go a moment ago has not ticked yet, and how soon it does is not
      // a number this fixture can know.
      const patience = Date.now() + GAME_STOP_TIMEOUT_MS;
      let ticked = 0;
      let lastAnswer = '';
      while (ticked === 0 && Date.now() < patience) {
        const ticksResponse = await replacement.request(
          'tools/call',
          {
            name: 'runtime_inspect',
            arguments: {
              projectPath: own.project,
              op: 'property',
              nodePath: '/root/Main',
              property: 'ticks',
            },
          },
          TOOL_TIMEOUT_MS,
        );
        lastAnswer = textOf(ticksResponse) ?? '';
        const value = get(parseTextContent(ticksResponse), 'value');
        ticked = typeof value === 'number' ? value : 0;
        if (ticked === 0) await delay(500);
      }
      assert.ok(ticked > 0, `a released game ticks, which a held one cannot: ${lastAnswer}`);

      const ended = parseTextContent(
        await replacement.request(
          'tools/call',
          { name: 'editor_run', arguments: { op: 'stop' } },
          TOOL_TIMEOUT_MS,
        ),
      );
      assert.equal(get(ended, 'stopped'), true, `the replacement should be able to end it: ${text(ended)}`);
      await delay(1500);
      assert.ok(!alive(pid), 'after which the game is gone');

      // The breakpoint the first server set is the replacement's to send as well: the editor
      // keeps one for a single play, the first server is gone with what it held, and a play
      // through the replacement used to run straight past the line. The note in the project is
      // what carries it, and the start answer says it was sent.
      const one = [{ scriptPath: 'res://main.gd', lines: [BREAK_LINE] }];
      const replayed = await answered('editor_run', {
        projectPath: own.project,
        op: 'start',
        headless: true,
      });
      assert.deepEqual(
        get(replayed, 'breakpoints'),
        one,
        `a play through the replacement sends the breakpoint the first server set: ${text(replayed)}`,
      );
      const stopsAgain = Date.now() + GAME_STOP_TIMEOUT_MS;
      let reason: unknown = null;
      while (reason !== 'breakpoint' && Date.now() < stopsAgain) {
        reason = get(await answered('editor_output', {}), 'heldAt', 'reason');
        if (reason !== 'breakpoint') await delay(500);
      }
      assert.equal(reason, 'breakpoint', 'and the game stops on it, for a server that never set it');
      const cleared = await answered('debug_breakpoint', {
        projectPath: own.project,
        scriptPath: 'res://main.gd',
        op: 'remove',
        line: BREAK_LINE,
      });
      assert.deepEqual(get(cleared, 'held'), [], `the replacement can take it off again: ${text(cleared)}`);
      await answered('editor_run', { op: 'stop' });
    } finally {
      await replacement.stop();
    }
  });
}

async function testLanguageServer({ call, attempt, project }: Editor): Promise<void> {
  const sound = { projectPath: project, scriptPath: 'res://sound.gd' };

  // The bridge is up as soon as the plugin loads, which is well before the editor is serving
  // diagnostics on a cold runner, so the first answer is waited for rather than assumed. Only
  // the first: everything after it asserts once, so a tool that stops working still fails.
  const ready = Date.now() + LSP_READY_TIMEOUT_MS;
  let attempted = await attempt('script_diagnostics', sound);
  while (!attempted.ok && Date.now() < ready) {
    await delay(500);
    attempted = await attempt('script_diagnostics', sound);
  }
  if (!attempted.ok) {
    // Asked a second way, so the failure says which half is missing: a server that answers for
    // symbols but publishes no diagnostics is a different fault from one that is not there.
    const symbols = await attempt('script_info', { ...sound, op: 'symbols' });
    assert.fail(
      `the language server never published diagnostics: ${attempted.text}\n` +
        `symbols ${symbols.ok ? 'answered' : 'was refused'}: ${symbols.text.slice(0, 400)}`,
    );
  }

  const clean = await call('script_diagnostics', sound);
  assert.equal(get(clean, 'clean'), true, 'a script that parses should come back clean');
  assert.equal(get(clean, 'errors'), 0);
  assert.equal(get(clean, 'warnings'), 0, 'and with no warnings on it either');

  const broken = await call('script_diagnostics', { projectPath: project, scriptPath: 'res://broken.gd' });
  assert.equal(get(broken, 'clean'), false, 'and a script that does not parse should not');
  assert.ok(asNumber(get(broken, 'errors'), 'errors') >= 1, 'with the errors counted');
  assert.match(
    asArray(get(broken, 'diagnostics'), 'diagnostics')
      .map((entry) => asString(get(entry, 'message'), 'message'))
      .join('\n'),
    /Expected parameter name/,
    'and the parser saying what it wanted',
  );

  const symbols = symbolNames(
    asArray(get(await call('script_info', { ...sound, op: 'symbols' }), 'symbols')),
  );
  for (const declared of ['ring', 'count', 'rang']) {
    assert.ok(symbols.includes(declared), `symbols should name ${declared}: ${symbols.join(', ')}`);
  }

  // Line 8 is `count += times`, and column 6 is the end of `count`.
  const hover = await call('script_info', { ...sound, op: 'hover', line: 8, character: 6 });
  assert.match(
    text(get(hover, 'hover', 'contents', 'value')),
    /var count: int/,
    'hover should answer with the declaration under the cursor',
  );

  const completions = asArray(
    get(await call('script_info', { ...sound, op: 'completion', line: 8, character: 6 }), 'completions'),
    'completions',
  ).map((entry) => asString(get(entry, 'label'), 'label'));
  assert.ok(
    completions.includes('rang'),
    `completions should offer the script's own names: ${completions.length}`,
  );
}

/**
 * The stack the adapter answers with, once it says what the case is waiting for.
 *
 * Polled rather than slept on: how long a second engine takes to reach a line, or to stop on
 * being asked, is not a number anything here can know.
 */
async function stackWithin(
  attempt: Editor['attempt'],
  what: string,
  reached: (frames: unknown[]) => boolean,
): Promise<unknown[]> {
  const deadline = Date.now() + GAME_STOP_TIMEOUT_MS;
  let frames: unknown[] = [];
  let said = '';
  while (!reached(frames) && Date.now() < deadline) {
    const stack = await attempt('debug_state', { op: 'stack' });
    said = stack.text;
    frames = stack.ok ? asArray(JSON.parse(stack.text), 'stackFrames') : [];
    if (!reached(frames)) await delay(500);
  }
  assert.ok(reached(frames), `${what}, and the adapter answered with: ${said}`);
  return frames;
}

/**
 * The debug tools, against a game the editor is playing.
 *
 * They only answer for a game the editor's own debugger is holding, which is why editor_run asks
 * the editor to play rather than starting the engine itself: a game started as its own process
 * has no debug session, so a breakpoint set through the adapter is never hit and the stack is
 * always empty. Everything here is asserted off the session: the stop, the frame it stopped in,
 * and the line the game printed after being let go.
 */
async function testDebugging({ call, refusal, attempt, play, project }: Editor): Promise<void> {
  const main = { projectPath: project, scriptPath: 'res://main.gd' };

  // Nothing is running yet, and the whole trap this replaces was that every one of these
  // answered with an empty stack: the same answer a game stopped in an empty frame gives.
  assert.match(
    await refusal('debug_state', { op: 'stack' }),
    /No game is running.*editor_run start/s,
    'a stack asked for with no game should name the command that starts one',
  );
  assert.match(
    await refusal('debug_control', { op: 'continue' }),
    /No game is running/,
    'and so should a step asked for with no game',
  );

  // The print, so the frame the game stops in is _ready with the sum already worked out.
  await call('debug_breakpoint', { ...main, op: 'set', line: BREAK_LINE });

  // The autoload announces itself before the main scene is ready, which is where this run's
  // breakpoint is, so a game stopped there has already announced and the start says so.
  const run = await play();
  assert.equal(get(run, 'through'), 'editor', 'the editor should be the one playing it');

  const frames = await stackWithin(
    attempt,
    'the game should stop at the breakpoint',
    (stack) => stack.length > 0,
  );
  assert.equal(get(frames[0], 'name'), '_ready', 'in the function the breakpoint is in');
  assert.equal(get(frames[0], 'line'), BREAK_LINE, 'on the line it was set on');

  // The whole point of stopping somewhere: reading what the program is holding. `total` is
  // worked out on the line above the breakpoint, so a frame that cannot show it as 4 is one
  // that is not really stopped where it says it is.
  const scopes = asArray(get(await call('debug_state', { op: 'variables' }), 'scopes'), 'scopes');
  assert.deepEqual(
    scopes.map((scope) => text(get(scope, 'name'))),
    ['Locals', 'Members', 'Globals'],
    'all three scopes should have arrived, not the empty list the first ask answers with',
  );
  const named = scopes.flatMap((scope) => asArray(get(scope, 'variables'), 'variables'));
  const total = named.find((variable) => text(get(variable, 'name')) === 'total');
  assert.ok(total, `total should be in scope at the breakpoint; saw ${JSON.stringify(named)}`);
  assert.match(text(get(total, 'value')), /\b4\b/, 'and should read as the 4 the line above worked out');

  // One line, run. The game is held either way, so what says the step happened is where it is
  // held now: a step that did nothing leaves it on the line it was already on.
  await call('debug_control', { op: 'step_over' });
  await stackWithin(
    attempt,
    `stepping should leave the game held past line ${BREAK_LINE}`,
    (stack) => stack.length > 0 && asNumber(get(stack[0], 'line')) > BREAK_LINE,
  );

  // Into the call on that line. Judged by the function the top frame is in, which is the only
  // thing that tells a step_into from a step_over that happened to move.
  //
  // There is no step_out to come back with: Godot's adapter parser implements req_next and
  // req_stepIn and nothing for stepOut, so the request is never answered. Stepping over from
  // inside the function runs it to its end and returns to the caller, which is the way back.
  await call('debug_control', { op: 'step_into' });
  const inside = await stackWithin(
    attempt,
    'step_into should leave the game inside the function that line calls',
    (stack) => stack.length > 0 && text(get(stack[0], 'name')) === '_twice',
  );
  assert.ok(inside.length > 1, 'with the caller still under it on the stack');

  await call('debug_control', { op: 'continue' });

  // The adapter's own console, read before anything drains it: editor_output takes the lines
  // out of the adapter as it reads them, so this is the one that has to ask first.
  const printed = Date.now() + GAME_STOP_TIMEOUT_MS;
  let adapter = '';
  while (!adapter.includes('the game said 4') && Date.now() < printed) {
    adapter = asArray(get(await call('debug_state', { op: 'output' }), 'output'), 'output')
      .map(text)
      .join('\n');
    if (!adapter.includes('the game said 4')) await delay(500);
  }
  assert.match(adapter, /the game said 4/, `the adapter should have the game's console: ${adapter}`);

  const output = await call('editor_output', {});
  assert.equal(get(output, 'through'), 'editor', 'the console should come from the editor session');
  const console_ = asArray(get(output, 'entries'), 'entries')
    .map((entry) => text(get(entry, 'text')))
    .join('\n');
  assert.match(console_, /the game said 4/, `and reach editor_output; it carried:\n${console_}`);

  // There is no pause op, and this is why: the adapter takes a pause, answers it, sends the
  // stopped event, and the game goes on for as long as anybody watches, with an empty stack
  // throughout. Asking for it has to be refused as the unknown op it is rather than quietly
  // becoming one of the two that work.
  assert.match(
    await refusal('debug_control', { op: 'pause' }),
    /continue, step_over, step_into/,
    'an op that does not exist should be refused with the ones that do',
  );

  // The other one Godot has not got. Asked for rather than assumed absent, so that an engine
  // which grows a stepOut is noticed here instead of going unused.
  assert.match(
    await refusal('debug_control', { op: 'step_out' }),
    /continue, step_over, step_into/,
    'step_out should be refused: the adapter never answers a stepOut request',
  );

  // The game was let go above, so it is running rather than held, which is the third thing an
  // empty stack used to mean. The console is the one debug_state op that still answers here,
  // and it answered a few lines up, which is what makes this refusal about the state and not
  // about the session.
  assert.match(
    await refusal('debug_state', { op: 'stack' }),
    /running, not stopped.*debug_breakpoint set/s,
    'a stack asked for while the game runs should say so and name what stops it',
  );

  await call('debug_breakpoint', { ...main, op: 'remove', line: BREAK_LINE });
  // The game is left running: it is past the breakpoint and answering, which is what the runtime
  // cases need, and a game stopped at a breakpoint answers nothing at all.
}

/**
 * The runtime tools, against a game that is actually running.
 *
 * Both halves of these were covered and the join was not: the addon's GDScript is driven inside
 * a headless engine, and the relay is driven against a mock Godot, so a server and an addon that
 * had stopped agreeing would have passed both. The game here is the one the editor plays, which
 * is what gives it a debugger and a runtime socket at the same time.
 *
 * Input included, both ways in: a click by path, which the addon pushes into the viewport, and
 * the raw events, which go through Input. Each is judged by what the game did about it rather
 * than by the answer the tool gave about itself.
 *
 * A capture is the one tool that cannot answer here, and its refusal is asserted instead: a
 * headless engine draws nothing and its texture holds whatever was drawn last, so a capture that
 * succeeded would be the same frame for ever.
 */
async function testRuntime({ call, refusal, attempt, project, lspPort, dapPort }: Editor): Promise<void> {
  const game = { projectPath: project };

  // Asked once rather than polled for. The start is what waits for the game to announce itself
  // now, and this loop worked around it not doing so: whether a caller can talk to the game it
  // was just told had started is the promise being held here.
  const reached = await attempt('runtime_inspect', { ...game, op: 'tree', nodePath: '/root' });
  assert.ok(reached.ok, `the game should be reachable over the runtime socket: ${reached.text}`);

  const tree = await call('runtime_inspect', { ...game, op: 'tree', nodePath: '/root', depth: 3 });
  const paths = JSON.stringify(tree);
  assert.match(paths, /Main/, 'the tree should carry the running scene');
  assert.match(paths, /Ticker/, 'and the nodes it made at runtime, which no .tscn has');

  const found = asArray(
    get(await call('runtime_inspect', { ...game, op: 'find', className: 'Timer' }), 'nodes'),
    'nodes',
  );
  assert.equal(found.length, 2, `find should answer with both timers: ${JSON.stringify(found)}`);

  // One property off every match, which is what makes a panel one question. Read off the timers
  // because they differ: a wait_time the same on both would pass against a find that answered with
  // one node twice. The Panel is in as well, and it has no wait_time at all.
  const timed = asArray(
    get(
      await call('runtime_inspect', {
        ...game,
        op: 'find',
        className: 'Node',
        namePattern: '*e*',
        property: 'wait_time',
      }),
      'nodes',
    ),
    'nodes',
  );
  const waits = new Map(
    timed.map((node) => [
      text(get(node, 'name')),
      get(node, 'has_property') === true ? get(node, 'value') : null,
    ]),
  );
  assert.equal(
    waits.get('Ticker'),
    0.2,
    `Ticker's own wait should come back with it: ${JSON.stringify(timed)}`,
  );
  assert.equal(waits.get('Late'), 1, "and Late's, which is a different number on a node of the same class");
  // A node without it says so rather than answering null, because null is what a node holding
  // null answers, and a find over a panel matches several classes on purpose.
  assert.equal(waits.get('Panel'), null, 'a matched node without that property should not claim a value');
  assert.equal(
    get(
      timed.find((node) => text(get(node, 'name')) === 'Panel'),
      'has_property',
    ),
    false,
    'and should say plainly that it has not got it',
  );

  const rect = await call('runtime_inspect', { ...game, op: 'rect', nodePath: '/root/Main/Panel' });
  assert.equal(get(rect, 'canvas', 'size', 'x'), 320, 'rect should measure the control it was given');
  assert.equal(get(rect, 'canvas', 'position', 'y'), 20, 'and place it where the game put it');
  // How it is spelled, not only what it holds. A downstream project reads every click result and
  // every rect off this path and keys on the tag, and nothing here said which tag it would be: the
  // three serialisers that used to disagree could have been made to agree on the other spelling
  // with every case in this file still green.
  assert.equal(
    asString(get(rect, 'canvas', 'position', '_type')),
    'Vector2',
    `a vector off a running game is tagged: ${text(rect)}`,
  );

  // One property, read straight: the alternative is the whole tree with every property on it, or
  // calling `get` through runtime_invoke, and neither is a question about one value.
  const doubled = await call('runtime_inspect', {
    ...game,
    op: 'property',
    nodePath: '/root/Main',
    property: 'doubled',
  });
  assert.equal(get(doubled, 'value'), 8, 'property should read what _ready worked out');
  assert.equal(get(doubled, 'property'), 'doubled', 'and say which property it answered for');

  // A property the node has not got is refused rather than answered null, which is what a node
  // with that property set to null would answer.
  assert.match(
    await refusal('runtime_inspect', { ...game, op: 'property', nodePath: '/root/Main', property: 'nope' }),
    /has no property nope/,
    'a property that does not exist is refused',
  );

  const metrics = await call('runtime_inspect', { ...game, op: 'metrics', metrics: ['object_node_count'] });
  assert.deepEqual(
    Object.keys(asObject(get(metrics, 'data'))),
    ['object_node_count'],
    'metrics should answer with the ones named and no others',
  );
  assert.match(
    await refusal('runtime_inspect', { ...game, op: 'metrics', metrics: ['frames_per_second'] }),
    /Unknown metrics: frames_per_second/,
    'and refuse a name that is not one, rather than answering with everything',
  );

  // A method call and a property set, each read back through the other, so neither is taken on
  // its own word: the call answers, and the property it wrote is read by a second call.
  assert.equal(
    get(
      await call('runtime_invoke', {
        ...game,
        op: 'call',
        nodePath: '/root/Main',
        method: 'stow',
        args: [7],
      }),
      'result',
    ),
    7,
    'a method should run in the game and answer with what it returned',
  );
  await call('runtime_invoke', { ...game, op: 'set', nodePath: '/root/Main', property: 'stash', value: 9 });
  assert.equal(
    get(
      await call('runtime_invoke', { ...game, op: 'call', nodePath: '/root/Main', method: 'peek' }),
      'result',
    ),
    9,
    'and the property set on it should be what the game reads back',
  );

  const frames = await call('runtime_wait', { ...game, op: 'frames', frames: 5 });
  assert.equal(get(frames, 'frames'), 5, 'waiting for frames should let that many pass');

  const signalled = await call('runtime_wait', {
    ...game,
    op: 'signal',
    nodePath: '/root/Main',
    signal: 'ticked',
    timeoutMs: 10_000,
  });
  assert.equal(get(signalled, 'fired'), true, 'waiting for a signal should catch it');
  assert.equal(typeof get(signalled, 'args', 0), 'number', 'and carry what it was emitted with');

  // Something the game does on its own a second in, so this waits rather than answering about
  // a value that was already there.
  const until = await call('runtime_wait', {
    ...game,
    op: 'until',
    nodePath: '/root/Main',
    property: 'answer',
    value: 42,
    timeoutMs: 10_000,
  });
  assert.equal(get(until, 'met'), true, 'waiting for a property should answer when it reads that');
  assert.equal(get(until, 'value'), 42, 'and with what it read');

  // A wrong argument costs a refusal, never the game. Waiting on a property that holds a node for
  // a value that is a string compared an Object against a String, which GDScript raises rather
  // than answering, inside the game: it was held at a debugger break, every later call answered
  // "did not respond within 10000ms, it may be stuck in a long frame", and nothing named the
  // argument that did it. Downstream lost a session to it. Both types are in the refusal because
  // the caller can see neither from where they stand.
  const mismatched = await refusal('runtime_wait', {
    ...game,
    op: 'until',
    nodePath: '/root/Main',
    property: 'held',
    value: 'a timer is not a string',
    timeoutMs: 2000,
  });
  assert.match(mismatched, /cannot be compared/, `it says why it will not: ${mismatched}`);
  assert.match(mismatched, /Object/, `naming what the property holds: ${mismatched}`);
  assert.match(mismatched, /String/, `and what it was given: ${mismatched}`);

  // And the game is still running, which is the whole point of refusing. Frames rather than a
  // property read: a game held at a debugger break answers nothing at all, and a game that is
  // merely alive still has to be advancing for anything after this to mean anything.
  assert.equal(
    get(await call('runtime_wait', { ...game, op: 'frames', frames: 2 }), 'frames'),
    2,
    'the game should still be drawing frames after a refused wait',
  );

  // The same rule one function along: an argument that cannot be converted is refused rather than
  // handed to callv, which raises inside the game exactly as the comparison did.
  const unfittable = await refusal('runtime_invoke', {
    ...game,
    op: 'call',
    nodePath: '/root/Main',
    method: 'stow',
    args: [{ _type: 'Object', class: 'RefCounted' }],
  });
  assert.match(unfittable, /cannot be converted|takes int/, `a bad argument is refused: ${unfittable}`);

  // A word where a number goes. Downstream found this one: `get_child(["not an index"])` came back
  // with child 0, as a Label, with no refusal and no note, because the conversion answered 0 for a
  // string that reads as no number at all and the check then saw a well-typed int. The gate was in
  // the wrong place, and a plausible wrong answer is worse than the halt it replaced: the halt is
  // visible. Nothing that cannot become a number may arrive as one.
  const worded = await refusal('runtime_invoke', {
    ...game,
    op: 'call',
    nodePath: '/root/Main',
    method: 'get_child',
    args: ['not an index'],
  });
  assert.match(worded, /cannot be converted/, `a word where an index goes is refused: ${worded}`);
  assert.match(worded, /String/, `naming what arrived: ${worded}`);

  // And the number written as text still works, because that is a value somebody meant.
  assert.equal(
    get(
      await call('runtime_invoke', {
        ...game,
        op: 'call',
        nodePath: '/root/Main',
        method: 'stow',
        args: ['7'],
      }),
      'result',
    ),
    7,
    'a number written as text is still a number',
  );

  // The same rule on the way in to a property: what cannot become what the property holds is
  // refused rather than written, because the engine picks zero and the answer reports it as new.
  const written = await refusal('runtime_invoke', {
    ...game,
    op: 'set',
    nodePath: '/root/Main',
    property: 'ticks',
    value: 'not a count',
  });
  assert.match(written, /cannot become one/, `a word where a count goes is refused: ${written}`);

  // And on a wait, where the same conversion landed worst of all: the word became 0.0, 0.0 equalled
  // the property already, and the wait answered met: true with the real value beside it, in zero
  // milliseconds, about a state nobody asked about. A refused call is read; a met is acted on.
  const impossible = await refusal('runtime_wait', {
    ...game,
    op: 'until',
    nodePath: '/root/Main',
    property: 'ticks',
    value: 'not a count',
    timeoutMs: 1500,
  });
  assert.match(impossible, /cannot become one/, `a wait that could never be met is refused: ${impossible}`);

  // A property the node has not got, refused rather than waited on. Waiting answered "not met"
  // after the whole timeout, which is what a game that never got there answers too, while the
  // property read refuses the same typo in one call. Two tools disagreeing about a typo is the
  // fault; that the wait was the slow one about it is how it stayed unnoticed.
  const mistyped = await refusal('runtime_wait', {
    ...game,
    op: 'until',
    nodePath: '/root/Main',
    property: 'tikcs',
    value: 1,
    timeoutMs: 1500,
  });
  assert.match(mistyped, /tikcs/, `the name nobody has is named: ${mistyped}`);
  assert.match(mistyped, /no property|has no/, `and said to be missing: ${mistyped}`);

  // Both at once, refused rather than answered about one of them. says and a property are two
  // different questions: one looks for words anywhere under the path, the other compares one
  // value on one node. says used to win and the property went unmentioned, so a caller watching
  // a screen believed they were watching a property and the answer read the same either way.
  const both = await refusal('runtime_wait', {
    ...game,
    op: 'until',
    nodePath: '/root/Main',
    property: 'ticks',
    value: 1,
    says: 'Go',
    timeoutMs: 1500,
  });
  assert.match(both, /says or a property, not both/, `both at once is refused: ${both}`);
  assert.match(both, /ticks/, `naming the one that was going to be dropped: ${both}`);

  // And says on its own still answers, which is what says the refusal is about the pair.
  const said = await call('runtime_wait', {
    ...game,
    op: 'until',
    nodePath: '/root/Main',
    says: 'Go',
    timeoutMs: 1500,
  });
  assert.equal(get(said, 'met'), true, `the button's own text is on the screen: ${text(said)}`);

  // And the conversions a caller actually relies on still go through, which is the half a
  // whitelist gets wrong. A downstream project reads and pokes its run through `get_indexed` and
  // `set_indexed` with a string path, dozens of calls a session: the parameter is a NodePath and
  // the argument is a String, so a rule that only accepted an exact type match would have taken
  // their whole workflow away in the name of protecting it.
  const indexed = await call('runtime_invoke', {
    ...game,
    op: 'call',
    nodePath: '/root/Main',
    method: 'get_indexed',
    args: ['doubled'],
  });
  assert.equal(get(indexed, 'result'), 8, 'a string where a NodePath is wanted is still a NodePath');
  const numeric = await call('runtime_invoke', {
    ...game,
    op: 'call',
    nodePath: '/root/Main',
    method: 'stow',
    args: [3.0],
  });
  assert.equal(get(numeric, 'result'), 3, 'and a float where an int is wanted is still a number');

  // A whole click, judged by what the game did about it: the button raises a counter, and the
  // counter is read back through a second tool. The tool's own answer is asserted too, because
  // "what was under the pointer" is the part that says the click landed where it was aimed.
  const clicked = await call('runtime_input', { ...game, op: 'click', nodePath: '/root/Main/Press' });
  assert.equal(get(clicked, 'landed'), true, 'the click should reach the control it named');
  assert.equal(get(clicked, 'control_afterwards'), 'in_tree', 'which is still there afterwards');
  assert.equal(
    get(
      await call('runtime_invoke', { ...game, op: 'call', nodePath: '/root/Main', method: 'peek_clicks' }),
      'result',
    ),
    1,
    'and the game should have acted on it',
  );

  // The same button, pressed by position rather than by path: the events go through Input, which
  // is the other of the two ways in, and the counter says whether they arrived.
  const where = await call('runtime_inspect', { ...game, op: 'rect', nodePath: '/root/Main/Press' });
  const centre = {
    x: asNumber(get(where, 'window', 'position', 'x')) + asNumber(get(where, 'window', 'size', 'x')) / 2,
    y: asNumber(get(where, 'window', 'position', 'y')) + asNumber(get(where, 'window', 'size', 'y')) / 2,
  };
  await call('runtime_input', { ...game, op: 'mouse_motion', ...centre });
  await call('runtime_input', { ...game, op: 'mouse_click', ...centre, pressed: true });
  await call('runtime_wait', { ...game, op: 'frames', frames: 1 });
  await call('runtime_input', { ...game, op: 'mouse_click', ...centre, pressed: false });
  await call('runtime_wait', { ...game, op: 'frames', frames: 2 });
  assert.equal(
    get(
      await call('runtime_invoke', { ...game, op: 'call', nodePath: '/root/Main', method: 'peek_clicks' }),
      'result',
    ),
    2,
    'a mouse button sent by position should press what is under it',
  );

  const injected = await call('runtime_input', {
    ...game,
    op: 'action',
    action: FIXTURE_ACTION,
    pressed: true,
  });
  assert.equal(get(injected, 'action'), FIXTURE_ACTION, 'an action should be injected by name');
  assert.equal(
    get(
      await call('runtime_invoke', { ...game, op: 'call', nodePath: '/root/Main', method: 'holding' }),
      'result',
    ),
    true,
    'and the game should read it as held',
  );
  await call('runtime_wait', { ...game, op: 'frames', frames: 2 });
  assert.equal(
    get(
      await call('runtime_invoke', { ...game, op: 'call', nodePath: '/root/Main', method: 'last_action' }),
      'result',
    ),
    FIXTURE_ACTION,
    'and the tree should have been handed the event',
  );
  await call('runtime_input', { ...game, op: 'action', action: FIXTURE_ACTION, pressed: false });

  // And the shape a caller gets by saying nothing. An action left down is a press that never
  // ends, and everything reading `Input.is_action_pressed` goes on seeing it.
  const whole = await call('runtime_input', { ...game, op: 'action', action: FIXTURE_ACTION });
  assert.equal(get(whole, 'whole'), true, 'an action with no pressed should be the whole press');
  assert.equal(
    get(
      await call('runtime_invoke', { ...game, op: 'call', nodePath: '/root/Main', method: 'holding' }),
      'result',
    ),
    false,
    'and should leave nothing held',
  );
  await call('runtime_input', { ...game, op: 'key', keycode: 'Space' });
  await call('runtime_wait', { ...game, op: 'frames', frames: 2 });
  assert.equal(
    get(
      await call('runtime_invoke', { ...game, op: 'call', nodePath: '/root/Main', method: 'last_key' }),
      'result',
    ),
    SPACE_KEYCODE,
    'a key should arrive as the key it names',
  );

  assert.match(
    await refusal('runtime_input', { ...game, op: 'action', action: 'no_such_action' }),
    /Action not found/,
    'an action nothing declares should be refused rather than injected into nowhere',
  );
  assert.match(
    await refusal('runtime_input', { ...game, op: 'key', keycode: 'Ctrl-Alt-Nonsense' }),
    /Invalid key_label/,
    'and so should a key name that is not one',
  );

  assert.match(
    await refusal('runtime_capture', game),
    /no window/,
    'a capture with nothing drawing should be refused, not answered with the last frame',
  );
  assert.match(
    await refusal('runtime_capture', { ...game, op: 'viewport', viewportPath: '/root/Main/Panel' }),
    /not a Viewport/,
    'and a viewport capture of something that is not one should say which mistake was made',
  );

  // What the editor is playing, which is the half the server cannot see for itself: this game
  // was started through it, so the editor is the one that knows.
  const status = await call('editor_status', {});
  // And where it serves. Godot keeps one language server and one debug adapter per machine, so
  // an editor that does not say which ports it took is one a second server cannot tell apart
  // from the editor that took the defaults.
  assert.equal(get(status, 'editor', 'lspPort'), lspPort, 'the editor should say where it serves the LSP');
  assert.equal(get(status, 'editor', 'dapPort'), dapPort, 'and where its debug adapter is');
  assert.equal(
    get(status, 'game', 'playingInEditor', 'playing'),
    true,
    'the editor should say it is playing',
  );
  assert.match(
    text(get(status, 'game', 'playingInEditor', 'scene')),
    /main\.tscn/,
    'and which scene it has running',
  );

  await call('editor_run', { op: 'stop' });
}

/**
 * A file edited while a game is running does not change the game.
 *
 * The `auto_reload` addon is an EditorPlugin: it polls the open scene and the scripts on that
 * scene's node tree, and reloads them with `CACHE_MODE_REPLACE` in the editor's own process. A
 * game the editor is playing is a separate process holding its own copy, so nothing here crosses
 * over. That reading of the source is easy to reach and easy to doubt, and a session that doubts
 * it stops editing anything for the length of a run: one downstream project came within a
 * decision of parking a two-hour bench over it.
 *
 * So it is measured on the strongest form, which is also the one that is worth relying on:
 * whatever the editor does with the changed file, the running game answers from the code it
 * started with. The edit is proved to have landed where the tools look before the game is asked
 * again, because a write that never reached disk would leave the game unchanged too.
 */
async function testAnEditDoesNotReachTheRunningGame({ call, attempt, play, project }: Editor): Promise<void> {
  await attempt('editor_run', { op: 'stop' });
  const game = { projectPath: project };
  const source = join(project, 'main.gd');
  const before = readFileSync(source, 'utf8');
  const asked = { ...game, op: 'call', nodePath: '/root/Main', method: '_twice', args: [4] };
  try {
    await play();
    assert.equal(
      get(await call('runtime_invoke', asked), 'result'),
      8,
      'the running game should answer from the code it started with',
    );

    const changed = before.replace('\treturn n * 2', '\treturn n * 3');
    assert.notEqual(changed, before, 'the fixture should still hold the line this rewrites');
    writeFileSync(source, changed);
    const searched = await call('project_search', {
      projectPath: project,
      query: 'return n * 3',
      fileTypes: ['gd'],
    });
    assert.match(
      text(searched),
      /main\.gd/,
      `the edit should be on disk where the tools read it: ${text(searched)}`,
    );

    // Three passes of a watcher that polls once a second, so a reload that was going to happen
    // has had its chances rather than been raced.
    await delay(3000);

    assert.equal(
      get(await call('runtime_invoke', asked), 'result'),
      8,
      'and should still answer from it after the file under it changed',
    );

    // The same call against a process started since, with nothing changed but which process is
    // answering. Without this the case passes just as well against a runtime that had stopped
    // reading the method at all, and 8 would be the sound of nothing happening.
    await call('editor_run', { op: 'stop' });
    await play();
    assert.equal(
      get(await call('runtime_invoke', asked), 'result'),
      12,
      'a game started after the edit should answer from the edited file',
    );
  } finally {
    writeFileSync(source, before);
    await attempt('editor_run', { op: 'stop' });
  }
}

/**
 * The port the editor's debugger holds while it plays.
 *
 * Godot keeps it in a setting shared by every editor on the machine and takes no command line
 * option for it, so two editors playing at once want the same number and both ways that can go
 * are wrong: a bind that fails leaves a game with no debugger behind it, and a bind that succeeds
 * anyway leaves two editors on one port. Measured on the machine this was written on, where a
 * fixture could not take 6007 because the editor on the desk was holding it.
 *
 * So the addon asks the operating system for one before every play. Which means the number is
 * never the shared default, and the console is the proof that the debugger really did attach to
 * the game on whatever it got: the console only travels that way.
 */
async function testTheDebuggerGetsAPortOfItsOwn({ call, attempt, play }: Editor): Promise<void> {
  // Attempted rather than called: what came before may have left a game running or may not, and
  // a stop with nothing to stop is refused.
  await attempt('editor_run', { op: 'stop' });

  try {
    const took = asNumber(get(await play(), 'debugPort'), 'debugPort');
    assert.notEqual(took, SHARED_DEBUGGER_PORT, 'the editor should not play on the shared default');
    assert.ok(took > 0 && took <= 65535, `and what it took should be a port: ${took}`);
    assert.equal(
      get(await call('editor_status', {}), 'editor', 'debugPort'),
      took,
      'and the editor should report the one it is on',
    );

    // Accumulated because editor_output takes the lines out of the adapter as it reads them.
    const deadline = Date.now() + GAME_STOP_TIMEOUT_MS;
    let said = '';
    while (!said.includes('the game said 4') && Date.now() < deadline) {
      said += (await attempt('editor_output', {})).text;
      if (!said.includes('the game said 4')) await delay(500);
    }
    assert.match(said, /the game said 4/, `the console should reach the editor: ${said}`);
  } finally {
    await attempt('editor_run', { op: 'stop' });
  }
}

/**
 * The game's own arguments, and the run that carries them being started here rather than played.
 *
 * The editor builds the game's command line out of `editor/run/main_run_args` and reads that when
 * it opens the project: measured against 4.7.2, a value written into the live settings was not on
 * the command line of the game played a moment later, saving it to disk did not change it, and the
 * same value put there before the editor started arrived. So a run with arguments is spawned, and
 * both halves of that are asserted here, with an editor connected the whole time: the game is
 * handed what the caller asked for, and the answer says who started it.
 *
 * Headless, like every other game this fixture runs: the editor plays them that way because this
 * project's own run arguments say so. A spawned run answers that question from the platform
 * instead, which asked for a window on Windows and macOS and for none on a Linux runner with no
 * display, and the macOS runner was the one where nothing ever announced itself. Asking for
 * headless here leaves the editor as the one that would have played it, because the project's run
 * arguments say headless too, so what moves this run is still the arguments and nothing else.
 */
async function testTheGameIsHandedItsOwnArguments({ call, attempt, play, project }: Editor): Promise<void> {
  await attempt('editor_run', { op: 'stop' });

  try {
    const run = await play({ headless: true, args: ['--fixture-flag=7', '--quiet'] });
    assert.equal(
      get(run, 'through'),
      'gdharness',
      `a run with arguments should be started here: ${JSON.stringify(run)}`,
    );
    assert.match(
      text(get(run, 'message')),
      /debug_\*/,
      'and the answer should say the debug tools will not answer for it',
    );

    const given = await call('runtime_invoke', {
      projectPath: project,
      op: 'call',
      nodePath: '/root/Main',
      method: 'given_args',
    });
    const whole = await call('runtime_invoke', {
      projectPath: project,
      op: 'call',
      nodePath: '/root/Main',
      method: 'given_command_line',
    });
    assert.deepEqual(
      asArray(get(given, 'result'), 'result'),
      ['--fixture-flag=7', '--quiet'],
      `the game should be handed what the caller asked for, and its command line was ${JSON.stringify(whole)}`,
    );

    const refused = await attempt('editor_run', { projectPath: project, args: [7] });
    assert.match(
      refused.text,
      /list of strings/,
      `arguments that are not strings should be refused: ${refused.text}`,
    );
  } finally {
    await attempt('editor_run', { op: 'stop' });
  }
}

/**
 * An error the editor breaks the game on, and the console that said nothing about it.
 *
 * Godot prints no script error over the debug adapter. It halts the game and names the error in
 * the `stopped` event, so a console built from what the adapter printed held no trace of one:
 * `editor_output` answered `clean` with zero errors about a game sitting dead at a null call,
 * while every runtime tool timed out and said only that it might be at a breakpoint. Found the
 * slow way, on a real project whose save carried one bad field.
 *
 * Its own game, because it ends with one that cannot run.
 */
/**
 * How long an editor-played run takes to reach `editor_output` when nothing else asks for it.
 *
 * The other cases here read the console after something has spoken to the debug adapter: a stack,
 * a step, a `debug_state output`. A session that only ever calls `editor_output` speaks to it
 * through nothing, and that is the case a downstream project measured at tens of seconds before the
 * first line arrived, against the engine's own log holding it already. They read that as output
 * never arriving and filed it as loss; on a current version it is latency, and the difference is
 * only visible if somebody waits.
 *
 * So the number is what is asserted, not the eventual arrival. A budget rather than a measurement
 * because a runner is slower than a desk, and a generous one: what it is guarding against is tens
 * of seconds, and what it would catch is the console going back to arriving only when something
 * else pokes the adapter.
 *
 * **This case has to run before anything opens a session on the adapter**, which a stack read, a
 * step or `debug_state output` all do as a side effect, and which stays open for the life of the
 * server. Run after one of those it passes whatever the server does, which is how it passed twice
 * while the report it was supposed to answer was right: the console really did not arrive, and the
 * transcript named for it really was empty, for a caller who only ever asked `editor_output`.
 */
async function testAPlayedRunsConsoleArrivesOnItsOwn({ call, play, project }: Editor): Promise<void> {
  await play();

  const started = Date.now();
  const until = started + GAME_STOP_TIMEOUT_MS;
  let said = '';
  while (!said.includes('the game said 4') && Date.now() < until) {
    const output = await call('editor_output', {});
    said = asArray(get(output, 'entries'), 'entries')
      .map((entry) => text(get(entry, 'text')))
      .join('\n');
    if (!said.includes('the game said 4')) await delay(500);
  }
  const waited = Date.now() - started;
  assert.match(said, /the game said 4/, `the console should reach editor_output: ${said}`);
  console.log(`  an editor-played run's first line reached editor_output in ${waited}ms`);
  assert.ok(waited < 15_000, `and without a wait nobody would sit through: ${waited}ms`);

  // A line printed after the last time anything read the console, which is the state the fault
  // needs: what the adapter is still holding when the next play starts. A bench prints its results
  // table at the end of its run, which is exactly after the last poll somebody made of it.
  await call('runtime_invoke', {
    projectPath: project,
    op: 'call',
    nodePath: '/root/Main',
    method: 'announce',
  });
  await delay(1000);

  // The second play. The adapter's buffer outlives the run that filled it, so the first drain
  // after a new play took everything still in it: a finished bench's results table arrived at the
  // top of the next run's output, under the next run's startedAt, indexed continuously with it,
  // and the only boundary was an engine banner in the middle of the list. A scene that cannot
  // print a bench table was reported as having printed one.
  // Played straight over the top rather than stopped first, because stop drains the console on its
  // way out and the fault is about what nobody drained. A bench that finishes on its own leaves
  // the same state, and that is the ordinary way one ends.
  await play();
  const second = Date.now() + GAME_STOP_TIMEOUT_MS;
  let lines: string[] = [];
  while (!lines.some((line) => line.includes('the game said 4')) && Date.now() < second) {
    lines = asArray(get(await call('editor_output', {}), 'entries'), 'entries').map((entry) =>
      text(get(entry, 'text')),
    );
    if (!lines.some((line) => line.includes('the game said 4'))) await delay(500);
  }
  assert.ok(
    lines.some((line) => line.includes('the game said 4')),
    `the second run's own console should be there: ${lines.join('\n')}`,
  );
  assert.equal(
    lines.filter((line) => line.includes('the first run said its piece')).length,
    0,
    `and the run before it should not be:\n${lines.join('\n')}`,
  );

  // The transcript has to grow while nobody is asking, because the use it exists for is arming a
  // watch on the path. Written on drain it advanced only when polled: measured downstream, a live
  // run's file sat at 411 bytes through a minute and moved the instant an editor_output was made,
  // which makes the watcher do the thing the watch replaces and leaves a stalled tail looking
  // exactly like a run that has died. So the file is read twice here with no call in between.
  const running = await call('editor_output', {});
  const path = text(get(running, 'transcript'));
  assert.ok(path.length > 0, `an editor-played run should name its transcript: ${text(running)}`);
  const atFirst = statSync(path).size;
  await call('runtime_invoke', {
    projectPath: project,
    op: 'call',
    nodePath: '/root/Main',
    method: 'announce',
  });
  const grown = Date.now() + 15_000;
  let after = atFirst;
  while (after === atFirst && Date.now() < grown) {
    await delay(250);
    after = statSync(path).size;
  }
  assert.ok(after > atFirst, `the file should grow with the run, not with the polling: ${atFirst}`);
  assert.match(readFileSync(path, 'utf8'), /the first run said its piece/, 'and hold what was printed');

  // The reading that separates a bench doing work from a bench parked, asked of a run whose
  // process this server does not hold. The game announced its own process id, which the runtime
  // call above went through, and that number is what names the run and what it is asked by: this
  // used to be answered as "there is no process to ask" beside a runtimes list naming the process.
  // The reading itself is best effort, a PowerShell start on Windows that a loaded runner can hold
  // past its budget, so what is held is that the question was put to that process.
  const asked = await call('editor_output', { cpu: true });
  const pid = asNumber(get(asked, 'pid'), 'a played game that announced is named by that number');
  const status = await call('editor_status', {});
  assert.equal(pid, asNumber(get(status, 'game', 'runtimes', 0, 'pid')));
  // The game says which editor played it, through the environment the editor addon marks and the
  // game inherits: this is the property that tells the editor's game from another of the same
  // project that some other server started, and it is asserted here through a real editor, a
  // real play and the real addon, since the mark is written by one process and read by two others.
  assert.equal(
    get(status, 'game', 'runtimes', 0, 'editorPid'),
    asNumber(get(status, 'editor', 'editorPid'), 'the editor should say which process it is'),
    `the played game announces the editor that played it: ${text(status)}`,
  );
  const cpuSeconds = get(asked, 'cpuSeconds');
  assert.ok(
    (typeof cpuSeconds === 'number' && cpuSeconds >= 0) ||
      text(get(asked, 'note')).includes('this platform would not say what the run has used'),
    `and asked by it: ${text(asked)}`,
  );

  // Left with nothing playing, because this case runs before the debugger ones now and those ask
  // what a stack answers with no game running. And the answer says what it ended, which for a run
  // the editor plays is the scene and nothing that scene started for itself: a bench downstream
  // fanned out to thirty-one workers with OS.create_process, had the one process that prints
  // ended, and the thirty left grinding wrote their slices into the next run of the same bench,
  // which then reported 107.9% of runs won.
  // Named by the number the game announced, which is the one the status call lists it under:
  // this run has no handle here, and the stop used to answer null about a process the same
  // server had just been talking to.
  const before = await call('editor_status', {});
  const announced = asArray(get(before, 'game', 'runtimes')).map((one) => asNumber(get(one, 'pid')));
  assert.equal(announced.length, 1, `one game should be announced before the stop: ${text(before)}`);
  const ended = await call('editor_run', { op: 'stop' });
  assert.equal(get(ended, 'stopped'), true, `the run should stop: ${text(ended)}`);
  assert.equal(
    get(ended, 'endedPid'),
    announced[0],
    `an editor-played run is named by the process its game announced: ${text(ended)}`,
  );
  assert.match(
    text(get(ended, 'note')),
    /is not the editor's to stop and was not signalled; andChildren ends/,
    `and what a stop does not reach is said, with the argument that reaches it: ${text(ended)}`,
  );
}

async function testAnErrorTheGameBrokeOnIsReported({ call, attempt, play, project }: Editor): Promise<void> {
  const game = { projectPath: project };
  await play();
  const reached = await attempt('runtime_inspect', { ...game, op: 'tree', nodePath: '/root' });
  assert.ok(reached.ok, `the game should be answering before it is broken: ${reached.text}`);

  const clean = await call('editor_output', {});
  assert.equal(get(clean, 'clean'), true, 'a game that has not broken should read as clean');
  assert.equal(get(clean, 'heldAt'), null, 'and as held nowhere');

  // The call never returns: the game breaks inside it and stops answering, which is the whole
  // shape of the failure. What it says is not the subject; what the console says next is.
  await attempt('runtime_invoke', {
    ...game,
    op: 'call',
    nodePath: '/root/Main',
    method: 'break_on_purpose',
  });

  const broke = Date.now() + GAME_STOP_TIMEOUT_MS;
  let output = await call('editor_output', {});
  while (get(output, 'clean') !== false && Date.now() < broke) {
    await delay(500);
    output = await call('editor_output', {});
  }
  assert.equal(
    get(output, 'clean'),
    false,
    `a game broken on an error is not a clean run: ${JSON.stringify(output)}`,
  );
  // One error, one entry: the game reports it through the runtime addon before it breaks, with
  // the engine's own line under it, and the halt the adapter announces is the same error rather
  // than a second one.
  assert.equal(
    asNumber(get(output, 'errors')),
    1,
    `and the error is counted once: ${JSON.stringify(output)}`,
  );

  const said = asArray(get(output, 'entries'), 'entries').filter(
    (entry) => text(get(entry, 'severity')) === 'error',
  );
  assert.equal(said.length, 1, `the error should be one entry: ${JSON.stringify(output)}`);
  assert.equal(
    text(get(said[0], 'source')),
    'transcript',
    "the game's own report, read through the transcript",
  );
  assert.match(
    text(get(said[0], 'text')),
    /null/i,
    `carrying the engine's own words: ${JSON.stringify(said)}`,
  );
  assert.match(
    asArray(get(said[0], 'detail')).map(text).join('\n'),
    /at: break_on_purpose \(res:\/\/main\.gd:\d+\)/,
    `and where it broke: ${JSON.stringify(said)}`,
  );

  // Where it is held, so a caller whose runtime calls are timing out is told why rather than
  // left to guess between a hung engine, a long frame and this.
  assert.equal(get(output, 'heldAt', 'reason'), 'exception', 'and the console says it is held');
  // The status call too, which is the one an agent makes first: it listed this game as unreachable
  // with a guess about breakpoints beside it, while the session it was answering from knew.
  const status = await call('editor_status', {});
  assert.equal(
    get(status, 'game', 'heldAt', 'reason'),
    'exception',
    `and editor_status says the same about the same run: ${text(status)}`,
  );

  // A runtime call to a game the session knows is held is refused at once, with why it is held
  // and what lets it go. It used to wait the whole runtime timeout on a game that answers nothing
  // and then guess that it might be paused, when the session had been told the moment it broke.
  const asked = Date.now();
  const refused = await attempt('runtime_inspect', { ...game, op: 'tree', nodePath: '/root' });
  const waited = Date.now() - asked;
  assert.equal(refused.ok, false, `a runtime call to a held game is refused: ${refused.text}`);
  assert.match(refused.text, /held by the editor's debugger, on an error: .*null/i, refused.text);
  assert.match(refused.text, /debug_control continue lets it go/, refused.text);
  assert.ok(waited < 5000, `and refused at once rather than after the runtime timeout: ${waited}ms`);

  // Asked twice on purpose: every ask drains the adapter, which goes on reporting the same stop
  // for as long as the game sits at it, so one error must not become one more error per call.
  const counted = asNumber(get(output, 'errors'));
  assert.equal(
    asNumber(get(await call('editor_output', {}), 'errors')),
    counted,
    'and one error stays one error however often the console is read',
  );

  await call('editor_run', { op: 'stop' });
}

/** Whether the game is ticking, asked until it is: a game sitting on a line in _ready never does. */
async function ticksWithin(attempt: Editor['attempt'], project: string, what: string): Promise<void> {
  const deadline = Date.now() + GAME_STOP_TIMEOUT_MS;
  let ticked = 0;
  let said = '';
  while (ticked === 0 && Date.now() < deadline) {
    const asked = await attempt('runtime_inspect', {
      projectPath: project,
      op: 'property',
      nodePath: '/root/Main',
      property: 'ticks',
    });
    said = asked.text;
    const value = asked.ok ? get(JSON.parse(asked.text), 'value') : 0;
    ticked = typeof value === 'number' ? value : 0;
    if (ticked === 0) await delay(500);
  }
  assert.ok(ticked > 0, `${what}: ${said}`);
}

/**
 * A breakpoint holds for every play started here, not only the next one.
 *
 * Measured on 4.7.2: a breakpoint set through the adapter stopped the play after it and not the
 * one after that. The same session set it, continued past it, stopped the game and played again,
 * and the game ran straight through the line; setting it again before the play is what made the
 * second play stop. Nothing said any of this: the set answer was the same both times and the
 * second play answered like the first. So the server sends every breakpoint it holds before each
 * play it starts and says so in the start answer. The set is also kept in the project for the
 * server after a reconnect, which the held-game case in the own-pair set holds.
 */
async function testABreakpointHoldsForEveryPlay({
  call,
  attempt,
  play,
  project,
  dapPort,
}: Editor): Promise<void> {
  const main = { projectPath: project, scriptPath: 'res://main.gd' };
  const one = [{ scriptPath: 'res://main.gd', lines: [BREAK_LINE] }];
  const set = await call('debug_breakpoint', { ...main, op: 'set', line: BREAK_LINE });
  assert.deepEqual(get(set, 'held'), one, `the set answer lists what is held: ${text(set)}`);

  // Godot clears every breakpoint in the editor when a session opens on its adapter unless the
  // editor syncs them, and it does not by default. The addon turned that on as it loaded, this
  // editor says so, and a session opening now is told the breakpoint set above rather than
  // taking it away: what an onlooker is told is the measurement, since a clearing editor sends
  // it "removed" for the same line.
  const status = await call('editor_status', {});
  assert.equal(
    get(status, 'editor', 'syncsBreakpoints'),
    true,
    `the editor keeps its breakpoints: ${text(status)}`,
  );
  assert.equal(
    get(status, 'editor', 'breakpointsAtRisk'),
    undefined,
    `so nothing is said against it: ${text(status)}`,
  );
  const onlooker = new GodotDAPClient(dapPort);
  await onlooker.initialize();
  const toldOf = (): boolean =>
    onlooker
      .breakpointsInEditor()
      .some((file) => file.scriptPath.endsWith('main.gd') && file.lines.includes(BREAK_LINE));
  const patience = Date.now() + 5000;
  while (!toldOf() && Date.now() < patience) {
    await delay(50);
  }
  assert.ok(
    toldOf(),
    `a session opening is told the breakpoint rather than clearing it: ${JSON.stringify(onlooker.breakpointsInEditor())}`,
  );
  await onlooker.abandon();

  const first = await play({ headless: true });
  assert.deepEqual(
    get(first, 'breakpoints'),
    one,
    `the start says what the game was told to stop on: ${text(first)}`,
  );
  await stackWithin(attempt, 'the first play stops at the breakpoint', (stack) => stack.length > 0);
  await call('debug_control', { op: 'continue' });
  await call('editor_run', { op: 'stop' });

  // The play after, which used to run straight through.
  const second = await play({ headless: true });
  assert.deepEqual(get(second, 'breakpoints'), one, `the second start says the same: ${text(second)}`);
  await stackWithin(attempt, 'the second play stops at the same breakpoint', (stack) => stack.length > 0);
  await call('debug_control', { op: 'continue' });

  const removed = await call('debug_breakpoint', { ...main, op: 'remove', line: BREAK_LINE });
  assert.deepEqual(get(removed, 'held'), [], `removing it empties the set: ${text(removed)}`);
  await call('editor_run', { op: 'stop' });

  // With nothing held, a play is told nothing and runs: it ticks, which a game sitting on the line
  // in _ready cannot, so this is the positive beside the absent field.
  const third = await play({ headless: true });
  assert.equal(get(third, 'breakpoints'), undefined, `a play with nothing held says nothing: ${text(third)}`);
  await ticksWithin(attempt, project, 'and runs through the line the breakpoint was on');
  await call('editor_run', { op: 'stop' });
}

/**
 * Restarting the editor, and the staleness that makes it necessary.
 *
 * An install replaces the addon under a running editor, which goes on serving the code it read
 * at startup: the only sign is a tool behaving like the old version, which is no sign at all.
 * The editor reports the version it loaded, and this is the tool that changes it. Run last,
 * because everything before it is talking to the editor this ends.
 */
async function testEditorRestart({ call, refusal, project }: Editor): Promise<void> {
  const before = get(await call('editor_status', {}), 'editor');
  assert.equal(
    get(before, 'addonVersion'),
    SERVER_VERSION,
    'the editor should report the version of the addon it loaded',
  );
  assert.equal(get(before, 'addonIsStale'), false, 'which is the one this server ships');
  assert.equal(typeof get(before, 'editorPid'), 'number', 'and say which process it is');

  // A second editor takes the language server and debug adapter ports off the first, which then
  // gives up without retrying, and every answer after that comes from a process nobody can see.
  // Refused rather than written down somewhere, because the tool that would do it is this one.
  assert.match(
    await refusal('editor_launch', { projectPath: project, op: 'open' }),
    /already connected.*editor_launch restart/s,
    'opening a second editor should be refused while one is connected',
  );

  // The editor here is headless, and a headless editor must refuse: the engine hands back none
  // of the arguments it consumed, so a restart brings up a project manager with no project
  // instead of the editor that was there. That happened on a real desktop, which is why this
  // case asserts the refusal rather than skipping.
  assert.match(
    await refusal('editor_launch', { op: 'restart' }),
    /headless/,
    'a headless editor should refuse to restart, and say why',
  );

  const after = get(await call('editor_status', {}), 'editor');
  assert.equal(get(after, 'connected'), true, 'and still be there afterwards');
  assert.equal(
    get(after, 'editorPid'),
    get(before, 'editorPid'),
    'as the same process, since a refused restart must not have restarted anything',
  );
}

async function main(): Promise<void> {
  const godotPath = resolveGodotPath();
  if (!godotPath) {
    if (process.env['GDHARNESS_REQUIRE_GODOT'] === '1') {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and no Godot answered --version.');
    }
    console.log('editor tests skipped (no Godot found)');
    return;
  }

  // Named so that one can be run on its own while it is being written, the way the regressions
  // take an argument. The order is the contract and a filter does not reorder them: it drops the
  // ones not asked for, which is not the same thing as them not having run. Several build on the
  // scene the last one left, and the console case has to come before anything opens a session on
  // the debug adapter, so a filtered run is for working on a case rather than for believing one.
  const CASES: [string, (editor: Editor) => Promise<void>][] = [
    ['testSceneNodes', testSceneNodes],
    ['testValuesSurviveBeingRead', testValuesSurviveBeingRead],
    ['testAValueTheSceneCannotHoldIsRefused', testAValueTheSceneCannotHoldIsRefused],
    ['testSceneSignals', testSceneSignals],
    ['testSceneAnimation', testSceneAnimation],
    ['testResources', testResources],
    ['testResourcesOnNodes', testResourcesOnNodes],
    ['testEditorRescan', testEditorRescan],
    ['testAClassTheEditorCannotSee', testAClassTheEditorCannotSee],
    ['testAScanWritesTheCacheFromTheEditor', testAScanWritesTheCacheFromTheEditor],
    ['testARescanKeepsWhatTheRebuildWrote', testARescanKeepsWhatTheRebuildWrote],
    ['testARescanDropsAClassWhoseScriptIsGone', testARescanDropsAClassWhoseScriptIsGone],
    ['testTheClassCheckKnowsWhichProjectItIsAbout', testTheClassCheckKnowsWhichProjectItIsAbout],
    ['testASettingReadFromTheEditor', testASettingReadFromTheEditor],
    ['testLanguageServer', testLanguageServer],
    ['testAClassWrittenUnderTheEditorNeedsARescan', testAClassWrittenUnderTheEditorNeedsARescan],
    ['testAMethodAddedToAnAnalysedTypeIsPickedUp', testAMethodAddedToAnAnalysedTypeIsPickedUp],
    ['testAPlayedRunsConsoleArrivesOnItsOwn', testAPlayedRunsConsoleArrivesOnItsOwn],
    ['testDebugging', testDebugging],
    ['testRuntime', testRuntime],
    ['testAnEditDoesNotReachTheRunningGame', testAnEditDoesNotReachTheRunningGame],
    ['testTheDebuggerGetsAPortOfItsOwn', testTheDebuggerGetsAPortOfItsOwn],
    ['testTheGameIsHandedItsOwnArguments', testTheGameIsHandedItsOwnArguments],
    ['testAnErrorTheGameBrokeOnIsReported', testAnErrorTheGameBrokeOnIsReported],
    ['testABreakpointHoldsForEveryPlay', testABreakpointHoldsForEveryPlay],
    ['testEditorRestart', testEditorRestart],
  ];

  // Cases that bring up their own editor and server, because they end one. Kept out of the shared
  // pair rather than nested inside it: nesting runs two editors at once, and on a machine already
  // holding one per project that is where the spawns start failing.
  const OWN_PAIR: [string, (godotPath: string) => Promise<void>][] = [
    ['testAPlayedRunOutlivesTheServerUnderIt', testAPlayedRunOutlivesTheServerUnderIt],
    ['testAHeldGameIsStillHeldForTheReplacement', testAHeldGameIsStillHeldForTheReplacement],
  ];
  const wanted = process.argv.slice(2).map((argument) => argument.toLowerCase());
  const picked = <T>(from: [string, T][]): [string, T][] =>
    wanted.length === 0
      ? from
      : from.filter(([name]) => wanted.some((word) => name.toLowerCase().includes(word)));
  const chosen = picked(CASES);
  const alone = picked(OWN_PAIR);
  if (chosen.length === 0 && alone.length === 0) {
    throw new Error(`No editor case is named ${process.argv.slice(2).join(' ')}.`);
  }
  const total = CASES.length + OWN_PAIR.length;
  if (chosen.length + alone.length !== total) {
    console.log(
      `running ${chosen.length + alone.length} of ${total} editor cases, out of their usual company`,
    );
  }

  if (chosen.length > 0) {
    await withEditor(godotPath, async (editor) => {
      for (const [, run] of chosen) {
        await run(editor);
      }
    });
  }
  // After the shared pair has been taken down, so only one editor is up at a time.
  for (const [, run] of alone) {
    await run(godotPath);
  }

  console.log(`editor tests passed (${chosen.length + alone.length})`);
}

await main();
