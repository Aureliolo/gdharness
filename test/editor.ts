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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { asArray, asString, get } from './support/json.js';
import { parseTextContent, textOf } from './support/json-rpc.js';
import { reservePort, ServerProcess } from './support/server.js';

/** Long enough for a cold editor to finish its first filesystem scan on a slow runner. */
const CONNECT_TIMEOUT_MS = 120_000;
const TOOL_TIMEOUT_MS = 60_000;

const SCENE = 'res://fixture.tscn';

interface Editor {
  /** Calls a tool and answers with its payload, failing on a refusal. */
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Calls a tool that must be refused and answers with the sentence it was refused with. */
  refusal: (name: string, args: Record<string, unknown>) => Promise<string>;
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
  const dir = mkdtempSync(join(tmpdir(), 'gdharness-editor-'));

  cpSync('src/godot/addons', join(dir, 'addons'), { recursive: true });

  writeFileSync(
    join(dir, 'project.godot'),
    [
      '; Engine configuration file.',
      'config_version=5',
      '',
      '[application]',
      'config/name="GdharnessEditorFixture"',
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

  return dir;
}

/** A file the engine wrote, which is the only answer it cannot fake. */
function fileText(project: string, name: string): string {
  return readFileSync(join(project, name), 'utf8');
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
    env: { GDHARNESS_BRIDGE_PORT: String(bridgePort), GODOT_PATH: godotPath },
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

    await body({ call, refusal, project });
  } finally {
    editor.kill();
    await server.stop();
    rmSync(project, { recursive: true, force: true });
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
    await testEditorRescan(editor);
  });

  console.log('editor tests passed');
}

await main();
