/**
 * Drives the GDScript that ships inside the bundle against a real engine.
 *
 * The rest of the suite exercises the TypeScript in front of these scripts. Nothing exercised
 * the scripts themselves, which is where the value serialisers, the project.godot writers and
 * the dependency walk live: code that answers rather than fails when it is wrong, so a silent
 * regression in it reads as a working tool returning a plausible shape.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tried = [];

/** True when the binary at this path answers --version, which is the only test that counts. */
function godotRuns(candidate) {
  const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 60000 });
  tried.push(`${candidate} -> ${probe.status ?? probe.error?.code ?? 'no status'}`);
  return probe.status === 0;
}

/**
 * GODOT_PATH first, then GODOT, then plain `godot` on PATH.
 *
 * Every candidate is tried by running it rather than by looking for it on disk, because a path
 * that exists is not an engine. Windows gets the .exe spelling tried as well, since a bare name
 * handed to spawn does not go through PATHEXT the way it would in a shell. Nothing beyond that
 * is guessed at: CI installs the engine itself through scripts/install-godot.mjs and exports an
 * absolute GODOT_PATH, so a miss here is a real miss rather than a layout nobody predicted.
 */
function resolveGodotPath() {
  const spellings = (name) => (process.platform === 'win32' ? [name, `${name}.exe`] : [name]);

  return (
    [process.env.GODOT_PATH, process.env.GODOT, 'godot'].filter(Boolean).flatMap(spellings).find(godotRuns) ??
    null
  );
}

/**
 * A project holding the shipped GDScript exactly where the bundle puts it, so the fixtures
 * load the same paths the addons and the operations script use in the field.
 *
 * The whole operations directory is copied rather than the entry script alone: the entry
 * dispatches to sibling modules it preloads by relative path, and half of them are only
 * reachable that way.
 */
function createProject() {
  const dir = mkdtempSync(join(tmpdir(), 'gdharness-engine-'));
  mkdirSync(join(dir, 'addons', 'godot_mcp_editor', 'tools'), { recursive: true });
  mkdirSync(join(dir, 'addons', 'godot_mcp_runtime'), { recursive: true });
  mkdirSync(join(dir, 'operations'), { recursive: true });

  cpSync('src/godot/addons/godot_mcp_editor/tools', join(dir, 'addons', 'godot_mcp_editor', 'tools'), {
    recursive: true,
  });
  cpSync(
    'src/godot/addons/godot_mcp_runtime/mcp_runtime_autoload.gd',
    join(dir, 'addons', 'godot_mcp_runtime', 'mcp_runtime_autoload.gd'),
  );
  cpSync('src/godot/operations', join(dir, 'operations'), { recursive: true });

  writeFileSync(
    join(dir, 'project.godot'),
    '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="GdharnessEngineFixture"\n',
  );

  return dir;
}

function runScript(godotPath, projectDir, scriptPath, extraArgs = []) {
  return spawnSync(godotPath, ['--headless', '--path', projectDir, '--script', scriptPath, ...extraArgs], {
    encoding: 'utf8',
    timeout: 180000,
  });
}

/**
 * A GDScript runtime error does not stop the engine: it aborts the running function and
 * carries on, so a fixture whose checks never ran exits 0 and prints whatever its caller
 * printed next. The engine says so on stderr and nothing else does, which makes that line the
 * only thing separating a fixture that passed from one that never executed.
 */
function assertNoEngineErrors(label, output) {
  const errors = output
    .split('\n')
    .filter((line) => /^(SCRIPT ERROR|USER SCRIPT ERROR|ERROR|USER ERROR):/.test(line.trim()));
  assert.equal(errors.length, 0, `${label} hit engine errors:\n${errors.join('\n')}`);
}

/** Runs one of the fixture scripts in test/support/gd and asserts it reported success. */
function runFixture(godotPath, projectDir, name) {
  const scriptPath = join(projectDir, `${name}.gd`);
  cpSync(join('test', 'support', 'gd', `${name}.gd`), scriptPath);

  const run = runScript(godotPath, projectDir, scriptPath);
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  if (run.status !== 0) {
    throw new Error(`${name} failed (${run.status ?? run.signal}):\n${output.trim()}`);
  }
  assertNoEngineErrors(name, output);
  assert.match(output, /"ok"\s*:\s*true/, `${name} should report success JSON`);
}

/**
 * The dependency walk is the one piece that cannot be called directly: the operations script
 * runs its whole job from _init and prints JSON, so it is driven the way the server drives it.
 */
function testDependencyWalk(godotPath, projectDir) {
  mkdirSync(join(projectDir, 'chain'), { recursive: true });

  // A chain three deep, plus a cycle, so both the depth cut and the cycle detection are hit.
  writeFileSync(join(projectDir, 'chain', 'leaf.gd'), 'extends Node\n');
  writeFileSync(
    join(projectDir, 'chain', 'middle.gd'),
    'extends Node\n\nconst Leaf = preload("res://chain/leaf.gd")\n',
  );
  writeFileSync(
    join(projectDir, 'chain', 'top.gd'),
    'extends Node\n\nconst Middle = preload("res://chain/middle.gd")\n',
  );
  writeFileSync(
    join(projectDir, 'chain', 'ouro.gd'),
    'extends Node\n\nconst Boros = preload("res://chain/boros.gd")\n',
  );
  writeFileSync(
    join(projectDir, 'chain', 'boros.gd'),
    'extends Node\n\nconst Ouro = preload("res://chain/ouro.gd")\n',
  );

  const paramsPath = join(projectDir, 'deps.json');
  writeFileSync(paramsPath, JSON.stringify({ resource_path: 'res://chain/top.gd', max_depth: 5 }));

  const run = runScript(godotPath, projectDir, join(projectDir, 'operations', 'godot_operations.gd'), [
    'get_dependencies',
    `@file:${paramsPath}`,
  ]);
  if (run.status !== 0) {
    throw new Error(`get_dependencies failed:\n${`${run.stdout}\n${run.stderr}`.trim()}`);
  }

  const payload = JSON.parse(
    run.stdout
      .split('\n')
      .map((line) => line.trim())
      .findLast((line) => line.startsWith('{')),
  );

  const top = payload.dependencies['res://chain/top.gd'];
  assert.ok(Array.isArray(top), 'the walk should return an array of dependencies');

  const middle = top.find((dep) => dep.path === 'res://chain/middle.gd');
  assert.ok(middle, 'top should depend on middle');
  assert.ok(middle.exists, 'middle should be reported as existing');

  // Recursion is the half that broke when the walk state was six loose arguments.
  const leaf = (middle.dependencies ?? []).find((dep) => dep.path === 'res://chain/leaf.gd');
  assert.ok(leaf, 'the walk should recurse from middle into leaf');

  assert.equal(payload.summary.total_resources, 1, 'one resource was asked for');
  assert.ok(payload.summary.total_dependencies >= 2, 'the chain has at least two dependencies');

  // A cycle has to be reported rather than walked forever.
  writeFileSync(paramsPath, JSON.stringify({ resource_path: 'res://chain/ouro.gd', max_depth: 10 }));
  const cyclic = runScript(godotPath, projectDir, join(projectDir, 'operations', 'godot_operations.gd'), [
    'get_dependencies',
    `@file:${paramsPath}`,
  ]);
  if (cyclic.status !== 0) {
    throw new Error(`get_dependencies on a cycle failed:\n${`${cyclic.stdout}\n${cyclic.stderr}`.trim()}`);
  }

  const cyclicPayload = JSON.parse(
    cyclic.stdout
      .split('\n')
      .map((line) => line.trim())
      .findLast((line) => line.startsWith('{')),
  );
  assert.ok(
    cyclicPayload.circular_references.length > 0,
    'the walk should report the cycle it found rather than silently stopping',
  );
}

/**
 * Runs one operation the way the server runs it, and returns the JSON object it printed.
 *
 * `scriptPath` defaults to the copy inside the project. The server runs the one in its own
 * package instead, from outside the project entirely, which is what testInstalledLayout passes.
 */
function runOperation(godotPath, projectDir, operation, params, scriptPath) {
  const paramsPath = join(projectDir, 'operation-params.json');
  writeFileSync(paramsPath, JSON.stringify(params));

  const script = scriptPath ?? join(projectDir, 'operations', 'godot_operations.gd');
  const run = runScript(godotPath, projectDir, script, [operation, `@file:${paramsPath}`]);
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;

  if (run.status !== 0) {
    throw new Error(`${operation} failed (${run.status ?? run.signal}):\n${output.trim()}`);
  }
  assertNoEngineErrors(operation, output);

  const line = (run.stdout ?? '')
    .split('\n')
    .map((text) => text.trim())
    .findLast((text) => text.startsWith('{'));
  assert.ok(line, `${operation} printed no JSON payload:\n${output.trim()}`);
  return JSON.parse(line);
}

/** The exit status and combined output of an operation that is expected to refuse. */
function runRefusedOperation(godotPath, projectDir, operation, params) {
  const paramsPath = join(projectDir, 'operation-params.json');
  writeFileSync(paramsPath, JSON.stringify(params));

  const run = runScript(godotPath, projectDir, join(projectDir, 'operations', 'godot_operations.gd'), [
    operation,
    `@file:${paramsPath}`,
  ]);
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '' };
}

/** A scene with one node of each shape the scene operations are asked to work on. */
function writeFixtureScene(projectDir) {
  writeFileSync(
    join(projectDir, 'fixture_scene.tscn'),
    [
      '[gd_scene format=3]',
      '',
      '[node name="Root" type="Node2D"]',
      '',
      '[node name="Child" type="Node2D" parent="."]',
      '',
      '[node name="Panel" type="Control" parent="."]',
      '',
      '[node name="Zone" type="Area2D" parent="."]',
      '',
    ].join('\n'),
  );
}

/** An importable resource and the .import sidecar the import operations read and write. */
function writeImportedResource(projectDir) {
  writeFileSync(join(projectDir, 'art.png'), 'fixture bytes, never decoded');
  writeFileSync(
    join(projectDir, 'art.png.import'),
    [
      '[remap]',
      '',
      'importer="texture"',
      'type="CompressedTexture2D"',
      '',
      '[deps]',
      '',
      'source_file="res://art.png"',
      '',
      '[params]',
      '',
      'compress/mode=0',
      '',
    ].join('\n'),
  );
}

/**
 * Drives the operations the server can ask for, through the dispatch, against the engine.
 *
 * Each one is asserted on something only it produces. A tool that answers rather than fails is
 * the failure mode here: every one of these builds a plausible-looking dictionary, so a module
 * wired to the wrong place, or a payload that lost a key, reads as success without this.
 */
function testOperations(godotPath, projectDir) {
  const operation = (name, params) => runOperation(godotPath, projectDir, name, params);

  // GDScript authoring, then the analysis of what it wrote.
  const created = operation('create_script', {
    script_path: 'made/hero.gd',
    class_name: 'FixtureHero',
    extends_class: 'Node2D',
    template: 'state_machine',
  });
  assert.equal(created.registered, true, 'a script given a class_name is registered');
  assert.equal(created.full_path, 'res://made/hero.gd');
  const heroSource = readFileSync(join(projectDir, 'made', 'hero.gd'), 'utf8');
  assert.match(heroSource, /^class_name FixtureHero/m, 'the class_name should be written first');
  assert.match(heroSource, /func change_state/, 'the state_machine template should be the one used');

  const modified = operation('modify_script', {
    script_path: 'made/hero.gd',
    modifications: [
      { type: 'add_variable', name: 'speed', varType: 'float', defaultValue: '4.0' },
      { type: 'add_function', name: 'halt', body: 'speed = 0.0' },
    ],
  });
  assert.equal(modified.total_modifications, 2, 'both modifications should be applied');
  const modifiedSource = readFileSync(join(projectDir, 'made', 'hero.gd'), 'utf8');
  assert.match(modifiedSource, /var speed: float = 4\.0/, 'the variable should carry its type and default');
  assert.match(modifiedSource, /func halt\(\):\n\tspeed = 0\.0/, 'the function body should be indented');

  const info = operation('get_script_info', { script_path: 'made/hero.gd' });
  assert.equal(info.class_name, 'FixtureHero');
  assert.equal(info.extends, 'Node2D');
  assert.ok(
    info.functions.some((entry) => entry.name === 'change_state'),
    'the parser should find the template functions',
  );
  assert.ok(
    info.signals.some((entry) => entry.name === 'state_changed'),
    'the parser should find the template signal',
  );
  assert.ok(
    info.variables.some((entry) => entry.name === 'speed' && entry.type === 'float'),
    'the parser should read the type off the variable that was just added',
  );

  // Project settings, including the value serialisers on both the way in and the way out.
  const name = operation('get_project_setting', { setting: 'application/config/name' });
  assert.equal(name.exists, true);
  assert.equal(name.value, 'GdharnessEngineFixture');

  const written = operation('set_project_setting', {
    setting: 'fixture/vector',
    value: { _type: 'Vector2', x: 3, y: 4 },
  });
  assert.equal(written.was_new, true);
  assert.equal(written.saved, true);
  assert.equal(written.new_value._type, 'Vector2', 'a tagged value should survive as its own type');
  const readBack = operation('get_project_setting', { setting: 'fixture/vector' });
  assert.deepEqual(
    { x: readBack.value.x, y: readBack.value.y },
    { x: 3, y: 4 },
    'the setting should come back as the vector it went in as',
  );

  // Autoloads are written into project.godot by hand, so the round trip is the only proof.
  const added = operation('add_autoload', { name: 'Hero', path: 'made/hero.gd' });
  assert.equal(added.action, 'added');
  const listed = operation('list_autoloads', {});
  const hero = listed.autoloads.find((entry) => entry.name === 'Hero');
  assert.ok(hero, 'the autoload that was just added should be listed');
  assert.equal(hero.enabled, true, 'the leading asterisk means enabled');
  assert.equal(hero.file_exists, true);
  assert.equal(operation('remove_autoload', { name: 'Hero' }).removed, true);

  operation('configure_physics_layer', { layerType: '2d', layerIndex: 1, layerName: 'Solid' });
  assert.equal(
    operation('get_project_setting', { setting: 'layer_names/2d_physics/layer_1' }).value,
    'Solid',
    'a named layer should be readable back out of project.godot',
  );

  // Scenes: read the tree, write a property into it, and add a node to it.
  writeFixtureScene(projectDir);
  assert.equal(operation('set_main_scene', { scene_path: 'fixture_scene.tscn' }).saved, true);

  const tree = operation('list_scene_nodes', { scene_path: 'fixture_scene.tscn' });
  assert.equal(tree.root.name, 'Root');
  assert.ok(Array.isArray(tree.root.children), 'the root should carry the children it has');
  assert.deepEqual(
    tree.root.children.map((child) => child.name).sort(),
    ['Child', 'Panel', 'Zone'],
    'every child of the scene root should be listed',
  );

  const set = operation('set_node_properties', {
    scene_path: 'fixture_scene.tscn',
    node_path: 'root/Child',
    properties: { position: { _type: 'Vector2', x: 12, y: 34 } },
  });
  assert.equal(set.properties_set, 1);
  assert.equal(set.scene_saved, true);
  const withProperties = operation('list_scene_nodes', {
    scene_path: 'fixture_scene.tscn',
    include_properties: true,
  });
  const child = withProperties.root.children.find((entry) => entry.name === 'Child');
  assert.deepEqual(
    { x: child.properties.position.x, y: child.properties.position.y },
    { x: 12, y: 34 },
    'the property should have been saved into the scene as the vector it was given as',
  );

  assert.equal(
    operation('create_camera', { scenePath: 'fixture_scene.tscn', nodeName: 'Eye', is3D: false }).node_name,
    'Eye',
  );
  const withCamera = operation('list_scene_nodes', { scene_path: 'fixture_scene.tscn' });
  const camera = withCamera.root.children.find((entry) => entry.name === 'Eye');
  assert.ok(camera, 'the camera should have been added to the saved scene');
  assert.equal(camera.type, 'Camera2D', 'is3D false means a 2D camera');

  // Both of these pick their node type through a helper that hands back an untyped value,
  // because the classes it chooses between share the settings but not a base class that
  // declares them. Building one of each is what shows that the value still lands as a node.
  assert.equal(
    operation('create_light', {
      scenePath: 'fixture_scene.tscn',
      nodeName: 'Sun',
      lightType: 'PointLight2D',
      color: { r: 1, g: 0.5, b: 0 },
      energy: 2,
    }).light_type,
    'PointLight2D',
  );
  assert.equal(
    operation('create_audio_stream_player', {
      scenePath: 'fixture_scene.tscn',
      nodeName: 'Speaker',
      playerType: 'AudioStreamPlayer2D',
      bus: 'Master',
    }).player_type,
    'AudioStreamPlayer2D',
  );
  const built = operation('list_scene_nodes', { scene_path: 'fixture_scene.tscn' });
  assert.deepEqual(
    built.root.children
      .filter((entry) => entry.name === 'Sun' || entry.name === 'Speaker')
      .map((entry) => entry.type)
      .sort(),
    ['AudioStreamPlayer2D', 'PointLight2D'],
    'each node should have been saved as the type it was asked for',
  );

  const masked = operation('set_collision_layer_mask', {
    scenePath: 'fixture_scene.tscn',
    nodePath: 'root/Zone',
    collisionLayer: 3,
    collisionMask: 5,
  });
  assert.deepEqual({ layer: masked.collision_layer, mask: masked.collision_mask }, { layer: 3, mask: 5 });

  // Resources saved on their own, and the one operation that applies one to a node.
  assert.equal(operation('create_theme', { themePath: 'made/ui.tres' }).success, true);
  assert.equal(
    operation('create_physics_material', { materialPath: 'made/bouncy.tres', bounce: 0.5 }).success,
    true,
  );
  assert.equal(
    operation('apply_theme_to_node', {
      scenePath: 'fixture_scene.tscn',
      nodePath: 'root/Panel',
      themePath: 'made/ui.tres',
    }).success,
    true,
  );

  // The import pipeline reads and writes the .import sidecar, which is a ConfigFile.
  writeImportedResource(projectDir);
  const status = operation('get_import_status', { include_up_to_date: true });
  assert.equal(status.summary.total, 1, 'the one importable resource should be found');
  assert.equal(status.resources[0].path, 'res://art.png');
  assert.equal(status.resources[0].import_file_exists, true);

  assert.equal(operation('get_import_options', { resource_path: 'art.png' }).params['compress/mode'], 0);
  const options = operation('set_import_options', {
    resource_path: 'art.png',
    options: { 'compress/mode': 2 },
  });
  assert.deepEqual(options.updated_options, ['compress/mode']);
  assert.equal(
    operation('get_import_options', { resource_path: 'art.png' }).params['compress/mode'],
    2,
    'the option should have been written into the .import file',
  );
  assert.equal(operation('reimport_resource', { resource_path: 'art.png' }).current_status, 'up_to_date');

  const presets = operation('list_export_presets', {});
  assert.equal(presets.presets_file_exists, false, 'the fixture project configures no exports');
  assert.match(presets.note, /export_presets\.cfg/);

  const validation = operation('validate_project', {});
  assert.ok(validation.checks_performed.includes('main_scene'));
  assert.equal(validation.valid, true, 'the main scene was set above, so the project validates');
  assert.ok(
    validation.warnings.some((warning) => warning.check === 'export_presets'),
    'a project with no export presets should be warned about',
  );

  // Diagnostics: the log parser, the health score, and the project-wide text search.
  const parsed = operation('parse_error_log', {
    log_content: 'SCRIPT ERROR: Invalid call on null\nWARNING: something mild\n',
  });
  assert.equal(parsed.summary.total_errors, 1);
  assert.equal(parsed.errors[0].category, 'Script', 'a SCRIPT ERROR line should be categorised as one');
  assert.ok(parsed.errors[0].suggestion, 'suggestions are on by default');
  assert.equal(parsed.summary.total_warnings, 1);

  const health = operation('get_project_health', {});
  assert.match(health.grade, /^[A-F]$/);
  assert.ok(health.checks.scripts.total_scripts > 0, 'the project has scripts in it');

  // The chain the dependency walk was pointed at is also what refers to leaf.gd.
  const usages = operation('find_resource_usages', { resource_path: 'chain/leaf.gd' });
  assert.ok(usages.summary.total_usages > 0, 'leaf.gd is preloaded by middle.gd');
  assert.ok(
    usages.usages.some((entry) => entry.file === 'res://chain/middle.gd'),
    'the file holding the reference should be named',
  );

  const found = operation('search_project', { query: 'state_changed' });
  assert.ok(found.summary.total_matches > 0, 'the signal written into the new script should be found');
  assert.ok(
    found.results.some((entry) => entry.file === 'res://made/hero.gd'),
    'the file that carries the match should be named',
  );

  // The resave walks the project and writes every scene and script back.
  assert.equal(operation('get_uid', { file_path: 'made/hero.gd' }).exists, false);
  const resaved = operation('resave_resources', {});
  assert.ok(resaved.scenes_saved > 0, 'the fixture scene should be resaved');
  assert.equal(resaved.scenes_with_errors, 0);
  assert.ok(resaved.scripts_resaved > 0, 'the scripts in the project should be resaved');
  // Measured on 4.7.2: outside the editor ResourceSaver answers OK and writes no .uid
  // sidecar, so a script that had none still has none. The count above is resaves, not UIDs.
  assert.equal(
    operation('get_uid', { file_path: 'made/hero.gd' }).exists,
    false,
    'a headless resave cannot mint a UID, and saying it did would be the lie to catch',
  );

  // Plugins: the fixture copies addon code without a plugin.cfg, so none are installed.
  const plugins = operation('list_plugins', {});
  assert.equal(plugins.addons_directory_exists, true);
  assert.deepEqual(plugins.plugins, [], 'an addon directory without a plugin.cfg holds no plugins');

  // Input actions, which are stored as an engine expression rather than as JSON.
  const action = operation('add_input_action', {
    action_name: 'fixture_jump',
    events: [{ type: 'key', keycode: 'Space', ctrl: true }],
  });
  assert.equal(action.events_count, 1);
  assert.equal(action.events[0].keycode, 32, 'Space is KEY_SPACE');
  assert.equal(action.events[0].ctrl_pressed, true);

  // Audio buses live in the AudioServer and only survive the run if the layout is saved.
  assert.equal(operation('create_audio_bus', { busName: 'Fixture' }).success, true);
  const buses = operation('get_audio_buses', {});
  assert.ok(buses.bus_count >= 1);
  assert.ok(
    buses.buses.some((bus) => bus.name === 'Master'),
    'every project has a Master bus',
  );

  // ClassDB, which is the one source of answers that does not touch the project at all.
  const classes = operation('query_classes', { filter: 'camera', category: 'node' });
  assert.ok(classes.classes.includes('Camera2D'));
  assert.ok(classes.filtered_count < classes.total_classes, 'the filter should exclude something');

  const classInfo = operation('query_class_info', { class_name: 'Camera2D' });
  assert.equal(classInfo.parent_class, 'Node2D');
  assert.ok(classInfo.methods_count > 0);
  assert.ok(classInfo.properties.some((property) => property.name === 'zoom'));

  const inheritance = operation('inspect_inheritance', { class_name: 'Node2D' });
  assert.ok(inheritance.ancestors.includes('CanvasItem'));
  assert.ok(inheritance.all_descendants.includes('Camera2D'));
}

/**
 * An operation that cannot answer has to say so rather than print a payload.
 *
 * The failure path is the half that breaks silently: a module that answers with an empty
 * result and one that answers with a half-built dictionary look alike from the outside until
 * somebody reads the exit status as well as the output.
 */
function testRefusals(godotPath, projectDir) {
  const missing = runRefusedOperation(godotPath, projectDir, 'get_script_info', {
    script_path: 'no/such/script.gd',
  });
  assert.notEqual(missing.status, 0, 'a missing script should fail the run');
  assert.match(missing.stderr, /\[ERROR\].*does not exist/, 'the reason should be on stderr');
  assert.doesNotMatch(missing.stdout, /^\{/m, 'a failed operation should print no payload');

  const unknown = runRefusedOperation(godotPath, projectDir, 'no_such_operation', {});
  assert.notEqual(unknown.status, 0, 'an unknown operation should fail the run');
  assert.match(unknown.stderr, /Unknown operation: no_such_operation/);
}

/**
 * The server runs the operations script from inside its own package, so the whole directory
 * sits outside the project it is pointed at. Relative preloads resolve against the script
 * rather than against res://, and this is the only test that exercises that layout.
 */
function testInstalledLayout(godotPath, projectDir) {
  const installed = resolve('src/godot/operations/godot_operations.gd');
  const params = { class_name: 'Node' };
  const payload = runOperation(godotPath, projectDir, 'query_class_info', params, installed);
  assert.equal(payload.class_name, 'Node');
  assert.ok(payload.methods_count > 0, 'the modules should have loaded from outside the project');
}

function main() {
  const godotPath = resolveGodotPath();
  if (!godotPath) {
    // A skip is fine on a machine with no engine and never fine where the job exists to run
    // this. Without the flag, CI installing Godot wrong would read as a pass.
    if (process.env.GDHARNESS_REQUIRE_GODOT) {
      // The list of what was tried and how each one failed, because the next person to hit
      // this is looking at a CI log for a platform they cannot reproduce.
      throw new Error(
        [
          'GDHARNESS_REQUIRE_GODOT is set and no Godot could be run.',
          `GODOT_PATH=${process.env.GODOT_PATH ?? '<unset>'} GODOT=${process.env.GODOT ?? '<unset>'}`,
          ...tried.map((line) => `  tried ${line}`),
        ].join('\n'),
      );
    }
    console.log('engine gdscript tests skipped (no Godot found)');
    return;
  }

  const projectDir = createProject();
  try {
    runFixture(godotPath, projectDir, 'scene_parse');
    runFixture(godotPath, projectDir, 'operations_modules');
    runFixture(godotPath, projectDir, 'operations_serialize');
    runFixture(godotPath, projectDir, 'runtime_serialize');
    runFixture(godotPath, projectDir, 'input_action');
    runFixture(godotPath, projectDir, 'shader_templates');
    testDependencyWalk(godotPath, projectDir);
    testOperations(godotPath, projectDir);
    testRefusals(godotPath, projectDir);
    testInstalledLayout(godotPath, projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }

  console.log('engine gdscript tests passed');
}

main();
