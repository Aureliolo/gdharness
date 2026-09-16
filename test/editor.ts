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
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { SERVER_VERSION } from '../src/server-version.js';
import { RUNTIME_AUTOLOAD } from '../src/setup.js';
import { asArray, asNumber, asObject, asString, get, text } from './support/json.js';
import { parseTextContent, textOf } from './support/json-rpc.js';
import { reservePort, ServerProcess } from './support/server.js';

/** Long enough for a cold editor to finish its first filesystem scan on a slow runner. */
const CONNECT_TIMEOUT_MS = 120_000;
/** Past the longest a tool waits on its own, so the tool's answer is what a case fails on. */
const TOOL_TIMEOUT_MS = 120_000;
/** The editor serves its language server after the addon has connected, and takes its time. */
const LSP_READY_TIMEOUT_MS = 90_000;
/** A game the editor plays is a second engine starting, on a runner that is already busy. */
const GAME_STOP_TIMEOUT_MS = 90_000;

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
  project: string;
  /** The engine this editor is, for a case that needs a second one against the same project. */
  godotPath: string;
  /** What this editor was opened on, which is what it should be reporting it serves. */
  lspPort: number;
  dapPort: number;
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

  writeFileSync(join(dir, 'main.gd'), MAIN_GD.join('\n'));
  writeFileSync(
    join(dir, 'main.tscn'),
    [
      '[gd_scene load_steps=2 format=3]',
      '',
      '[ext_resource type="Script" path="res://main.gd" id="1_main"]',
      '',
      '[node name="Main" type="Node"]',
      'script = ExtResource("1_main")',
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
function endEnginesUnder(project: string): void {
  const listing =
    process.platform === 'win32'
      ? spawnSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            'Get-CimInstance Win32_Process -Filter "Name=\'godot.exe\'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }',
          ],
          { encoding: 'utf8', timeout: 30_000 },
        )
      : spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 30_000 });

  const wanted = project.replaceAll('\\', '/').toLowerCase();
  for (const line of listing.stdout.split('\n')) {
    const [, pid, rest] = /^\s*(\d+)\s+(.*)$/.exec(line.trim()) ?? [];
    if (pid === undefined || rest === undefined) continue;
    if (!rest.replaceAll('\\', '/').toLowerCase().includes(wanted)) continue;
    try {
      process.kill(Number(pid));
      console.log(`ended engine ${pid}, which was still holding the fixture project`);
    } catch {
      // Gone between the listing and here, which is the outcome this is for.
    }
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
      rmSync(directory, { recursive: true, force: true });
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

  const server = new ServerProcess({
    env: {
      ...own,
      GDHARNESS_BRIDGE_PORT: String(bridgePort),
      GDHARNESS_LSP_PORT: String(lspPort),
      GDHARNESS_DAP_PORT: String(dapPort),
      GODOT_PATH: godotPath,
    },
  });

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

  const editor: ChildProcess = spawn(
    godotPath,
    [
      '--editor',
      '--headless',
      '--path',
      project,
      '--lsp-port',
      String(lspPort),
      '--dap-port',
      String(dapPort),
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

    await body({ call, refusal, attempt, project, godotPath, lspPort, dapPort });
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
    throw new Error(
      `${failure instanceof Error ? failure.stack : String(failure)}\n\nThe editor this started is ${state}. It said:\n${said}`,
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
    endEnginesUnder(project);
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
}

/** Resources written to disk: a .tres, a shader, and a theme edited in place. */
async function testResources({ call, refusal, project }: Editor): Promise<void> {
  const label = { projectPath: project, resourcePath: 'res://label.tres' };
  await call('resource_edit', { ...label, op: 'create', resourceType: 'LabelSettings' });
  await call('resource_edit', { ...label, op: 'modify', properties: { font_size: 24 } });
  assert.match(fileText(project, 'label.tres'), /font_size = 24/, 'the property should be in the file');

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
 * So the case is written the way it bites: a scan that says it finished while a class stays
 * unresolvable has to answer for it, and a real change to the declaring script has to cure it.
 */
async function testAClassTheEditorCannotSee({ call, project, godotPath }: Editor): Promise<void> {
  const declaring = join(project, 'late_class.gd');
  writeFileSync(declaring, 'class_name LateClass\nextends RefCounted\n');

  // What puts the file beyond the editor's walk: a second engine records it and writes its .uid,
  // which is what a commit hook, a build script or a test tier does while an editor sits open. It
  // has to be a real import rather than project_import reimport, which only asks the engine that
  // is already running and says as much in its own answer.
  const imported = spawnSync(godotPath, ['--headless', '--path', project, '--import'], {
    encoding: 'utf8',
    timeout: 180_000,
  });
  assert.equal(imported.status, 0, `the headless import should succeed:\n${imported.stderr}`);

  const blind = await call('editor_rescan', { projectPath: project });

  // Said in the failure rather than left to be worked out: a cache without the class means the
  // import did not do its half, and a cache with it means the editor saw the file regardless.
  const cache = join(project, '.godot', 'global_script_class_cache.cfg');
  const cached = existsSync(cache) && readFileSync(cache, 'utf8').includes('LateClass');
  const standing = `${text(blind)} (cache lists LateClass: ${cached})`;
  assert.equal(get(blind, 'ok'), false, `a scan leaving a class unresolvable is not clean: ${standing}`);
  const named = asArray(get(blind, 'unseenByEditor')).map((entry) => get(entry, 'className'));
  assert.deepEqual(named, ['LateClass'], `the class the editor cannot see should be named: ${standing}`);

  writeFileSync(
    declaring,
    'class_name LateClass\nextends RefCounted\n\n\nfunc answer() -> int:\n\treturn 33\n',
  );
  const seeing = await call('editor_rescan', { projectPath: project });
  assert.equal(get(seeing, 'ok'), true, `a changed script should reach the editor's list: ${text(seeing)}`);
  assert.equal(get(seeing, 'unseenByEditor'), undefined, `and leave nothing to name: ${text(seeing)}`);
}

/**
 * The language server tools, which answer from the editor's own server rather than from the addon.
 *
 * Both scripts are driven, the one that parses and the one that does not. A diagnostics tool
 * that has quietly stopped answering returns nothing for every file, which reads exactly like a
 * clean project, so the case that matters is the one where something is wrong.
 */
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
async function testDebugging({ call, refusal, attempt, project }: Editor): Promise<void> {
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

  const run = await call('editor_run', { projectPath: project });
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

  // The game announces itself in a file, which it writes once it is listening, so the first
  // answer is waited for rather than assumed.
  const deadline = Date.now() + GAME_STOP_TIMEOUT_MS;
  let reached = await attempt('runtime_inspect', { ...game, op: 'tree', nodePath: '/root' });
  while (!reached.ok && Date.now() < deadline) {
    await delay(500);
    reached = await attempt('runtime_inspect', { ...game, op: 'tree', nodePath: '/root' });
  }
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

  await call('editor_run', { projectPath: project, op: 'stop' });
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
async function testTheDebuggerGetsAPortOfItsOwn({ call, attempt, project }: Editor): Promise<void> {
  // Attempted rather than called: what came before may have left a game running or may not, and
  // a stop with nothing to stop is refused.
  await attempt('editor_run', { projectPath: project, op: 'stop' });

  try {
    const took = asNumber(get(await call('editor_run', { projectPath: project }), 'debugPort'), 'debugPort');
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
    await attempt('editor_run', { projectPath: project, op: 'stop' });
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
async function testAnErrorTheGameBrokeOnIsReported({ call, attempt, project }: Editor): Promise<void> {
  const game = { projectPath: project };
  await call('editor_run', { projectPath: project });

  const deadline = Date.now() + GAME_STOP_TIMEOUT_MS;
  let reached = await attempt('runtime_inspect', { ...game, op: 'tree', nodePath: '/root' });
  while (!reached.ok && Date.now() < deadline) {
    await delay(500);
    reached = await attempt('runtime_inspect', { ...game, op: 'tree', nodePath: '/root' });
  }
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
  assert.ok(asNumber(get(output, 'errors')) > 0, 'and the error is counted like a printed one');

  const said = asArray(get(output, 'entries'), 'entries').filter(
    (entry) => text(get(entry, 'severity')) === 'error',
  );
  assert.ok(said.length > 0, `the error should be an entry: ${JSON.stringify(output)}`);
  assert.equal(
    text(get(said[0], 'source')),
    'debugger',
    "marked as the debugger's, because the game printed none of it",
  );
  assert.match(
    text(get(said[0], 'text')),
    /null/i,
    `carrying the engine's own words: ${JSON.stringify(said)}`,
  );

  // Where it is held, so a caller whose runtime calls are timing out is told why rather than
  // left to guess between a hung engine, a long frame and this.
  assert.equal(get(output, 'heldAt', 'reason'), 'exception', 'and the console says it is held');

  // Asked twice on purpose: every ask drains the adapter, which goes on reporting the same stop
  // for as long as the game sits at it, so one error must not become one more error per call.
  const counted = asNumber(get(output, 'errors'));
  assert.equal(
    asNumber(get(await call('editor_output', {}), 'errors')),
    counted,
    'and one error stays one error however often the console is read',
  );

  await call('editor_run', { projectPath: project, op: 'stop' });
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
    await refusal('editor_launch', { projectPath: project, op: 'restart' }),
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

  await withEditor(godotPath, async (editor) => {
    // One editor for all of them, in order: each case builds on the scene the last one left.
    await testSceneNodes(editor);
    await testSceneSignals(editor);
    await testSceneAnimation(editor);
    await testResources(editor);
    await testResourcesOnNodes(editor);
    await testEditorRescan(editor);
    await testAClassTheEditorCannotSee(editor);
    await testLanguageServer(editor);
    await testDebugging(editor);
    await testRuntime(editor);
    await testTheDebuggerGetsAPortOfItsOwn(editor);
    await testAnErrorTheGameBrokeOnIsReported(editor);
    await testEditorRestart(editor);
  });

  console.log('editor tests passed');
}

await main();
