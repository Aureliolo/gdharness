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
import { asArray, asNumber, asString, get, text } from './support/json.js';
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

interface Editor {
  /** Calls a tool and answers with its payload, failing on a refusal. */
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Calls a tool that must be refused and answers with the sentence it was refused with. */
  refusal: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Calls a tool and answers with how it went, for waiting on something to come up. */
  attempt: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>;
  project: string;
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

  // A main scene for the debug cases, which need a game the editor is actually playing. It runs
  // until it is stopped rather than quitting on the line after the print: a game that ends that
  // instant can take its debugger connection down before the console it wrote comes over it.
  writeFileSync(
    join(dir, 'main.gd'),
    [
      'extends Node',
      '',
      '',
      'func _ready() -> void:',
      '\tvar total: int = 2 + 2',
      '\tprint("the game said ", total)',
      '',
    ].join('\n'),
  );
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

  const server = new ServerProcess({
    env: {
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
        // Its own everything: a fixture must not rewrite the editor settings of the machine it
        // runs on, and on a developer's machine those belong to the editor they have open.
        APPDATA: home,
        LOCALAPPDATA: home,
        XDG_CONFIG_HOME: home,
        XDG_DATA_HOME: home,
        XDG_CACHE_HOME: home,
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

    await body({ call, refusal, attempt, project });
  } catch (failure) {
    // What the engine said on its way to failing, which is the half of the evidence a tool
    // answer does not carry: a fixture that reports only its own assertion sends whoever reads
    // the run back to guessing about an editor that is no longer there to ask.
    const said = engineOutput.join('').trim();
    throw new Error(
      `${failure instanceof Error ? failure.stack : String(failure)}\n\nThe editor said:\n${said}`,
    );
  } finally {
    // The game first: it is the editor's child and outlives it, so a run that failed part way
    // through would otherwise leave an engine behind holding the fixture project.
    await invoke('editor_stop', {}).catch(() => undefined);

    // The editor that is connected now, which after a restart is not the one spawned here: that
    // process is long gone and killing its handle leaves the new one holding the project.
    const connected = await invoke('editor_status', {}).catch(() => null);
    const pid = connected === null ? undefined : get(parseTextContent(connected), 'editor', 'editorPid');
    if (typeof pid === 'number' && pid !== editor.pid) {
      try {
        process.kill(pid);
      } catch {
        // Already gone, which is the outcome this is for.
      }
    }

    editor.kill();
    await exited(editor);
    await server.stop();
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

  await call('scene_node', { ...scene, op: 'add', nodeType: 'Sprite2D', nodeName: 'Dot' });
  await call('scene_node', { ...scene, op: 'load_sprite', nodePath: 'Dot', texturePath: 'res://dot.tres' });
  assert.match(fileText(project, 'fixture.tscn'), /dot\.tres/, 'the texture should be on the sprite');

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
 * The debug tools, against a game the editor is playing.
 *
 * They only answer for a game the editor's own debugger is holding, which is why editor_run asks
 * the editor to play rather than starting the engine itself: a game started as its own process
 * has no debug session, so a breakpoint set through the adapter is never hit and the stack is
 * always empty. Everything here is asserted off the session: the stop, the frame it stopped in,
 * and the line the game printed after being let go.
 */
async function testDebugging({ call, attempt, project }: Editor): Promise<void> {
  const main = { projectPath: project, scriptPath: 'res://main.gd' };

  // Line 6 is the print, so the frame the game stops in is _ready with the sum already worked out.
  await call('debug_breakpoint', { ...main, op: 'set', line: 6 });

  const run = await call('editor_run', { projectPath: project });
  assert.equal(get(run, 'through'), 'editor', 'the editor should be the one playing it');

  const deadline = Date.now() + GAME_STOP_TIMEOUT_MS;
  let frames: unknown[] = [];
  let said = '';
  while (frames.length === 0 && Date.now() < deadline) {
    const stack = await attempt('debug_state', { op: 'stack' });
    said = stack.text;
    frames = stack.ok ? asArray(JSON.parse(stack.text), 'stackFrames') : [];
    if (frames.length === 0) await delay(500);
  }
  assert.ok(frames.length > 0, `the game should stop at the breakpoint; the adapter said: ${said}`);
  assert.equal(get(frames[0], 'name'), '_ready', 'in the function the breakpoint is in');
  assert.equal(get(frames[0], 'line'), 6, 'on the line it was set on');

  await call('debug_control', { op: 'continue' });

  // Waited for rather than slept on: the line arrives as a debug adapter event, and how long
  // that takes is how long a second engine takes to get past the line it was held on.
  const printed = Date.now() + GAME_STOP_TIMEOUT_MS;
  let console_ = '';
  let through = '';
  while (!console_.includes('the game said 4') && Date.now() < printed) {
    const output = await call('editor_output', {});
    through = text(get(output, 'through'));
    console_ = asArray(get(output, 'entries'), 'entries')
      .map((entry) => text(get(entry, 'text')))
      .join('\n');
    if (!console_.includes('the game said 4')) await delay(500);
  }
  assert.equal(through, 'editor', 'the console should come from the editor session');
  assert.match(console_, /the game said 4/, `and carry what the game printed; it carried:\n${console_}`);

  await call('debug_breakpoint', { ...main, op: 'remove', line: 6 });
  await call('editor_stop', {});
}

/**
 * Restarting the editor, and the staleness that makes it necessary.
 *
 * An install replaces the addon under a running editor, which goes on serving the code it read
 * at startup: the only sign is a tool behaving like the old version, which is no sign at all.
 * The editor reports the version it loaded, and this is the tool that changes it. Run last,
 * because everything before it is talking to the editor this ends.
 */
async function testEditorRestart({ call, project }: Editor): Promise<void> {
  const before = get(await call('editor_status', {}), 'editor');
  assert.equal(
    get(before, 'addonVersion'),
    SERVER_VERSION,
    'the editor should report the version of the addon it loaded',
  );
  assert.equal(get(before, 'addonIsStale'), false, 'which is the one this server ships');

  const restarted = await call('editor_launch', { projectPath: project, op: 'restart' });
  assert.equal(get(restarted, 'restarted'), true, 'the editor should come back');
  assert.equal(get(restarted, 'addonVersion'), SERVER_VERSION, 'with the addon it had');

  const after = get(await call('editor_status', {}), 'editor');
  assert.equal(get(after, 'connected'), true, 'and be connected again afterwards');
  assert.notEqual(
    get(after, 'connectedAt'),
    get(before, 'connectedAt'),
    'as a new connection rather than the one that was already there',
  );
  // The process too: an editor that reconnected without restarting would have the same one, and
  // is exactly the failure this tool exists to rule out.
  assert.notEqual(
    get(after, 'editorPid'),
    get(before, 'editorPid'),
    'and as a new process, which is what restarting means',
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
    await testLanguageServer(editor);
    await testDebugging(editor);
    await testEditorRestart(editor);
  });

  console.log('editor tests passed');
}

await main();
