/**
 * Drives the GDScript that ships inside the bundle against a real engine.
 *
 * The rest of the suite exercises the TypeScript in front of these scripts. Nothing exercised
 * the scripts themselves, which is where the value serialisers, the project.godot writers and
 * the dependency walk live: code that answers rather than fails when it is wrong, so a silent
 * regression in it reads as a working tool returning a plausible shape.
 */

import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { asArray, asNumber, asString, get, lastJsonLine } from './support/json.js';

const tried: string[] = [];

/** True when the binary at this path answers --version, which is the only test that counts. */
function godotRuns(candidate: string): boolean {
  const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 60000 });
  const failure: NodeJS.ErrnoException | undefined = probe.error;
  tried.push(`${candidate} -> ${probe.status ?? failure?.code ?? 'no status'}`);
  return probe.status === 0;
}

/**
 * GODOT_PATH first, then GODOT, then plain `godot` on PATH.
 *
 * Every candidate is tried by running it rather than by looking for it on disk, because a path
 * that exists is not an engine. Windows gets the .exe spelling tried as well, since a bare name
 * handed to spawn does not go through PATHEXT the way it would in a shell. Nothing beyond that
 * is guessed at: CI installs the engine itself through scripts/install-godot.ts and exports an
 * absolute GODOT_PATH, so a miss here is a real miss rather than a layout nobody predicted.
 */
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

/** Every GDScript file the package ships, as the engine will see it inside the fixture project. */
function shippedScripts(): string[] {
  return ['operations', 'addons'].flatMap((root) =>
    readdirSync(join('src', 'godot', root), { recursive: true, encoding: 'utf8' })
      .filter((entry) => entry.endsWith('.gd'))
      .map((entry) => `res://${root}/${entry.replaceAll('\\', '/')}`),
  );
}

/**
 * A project holding the shipped GDScript exactly where the bundle puts it, so the fixtures
 * load the same paths the addons and the operations script use in the field.
 *
 * The whole operations directory is copied rather than the entry script alone: the entry
 * dispatches to sibling modules it preloads by relative path, and half of them are only
 * reachable that way. The addons are copied whole for the same reason, plugin.cfg included,
 * which is also what lets the plugin operations be driven against real ones.
 *
 * The warning settings make an untyped declaration a parse error, in the addons as well,
 * which the engine otherwise leaves out of its warnings. Every script the fixtures load is
 * parsed under those settings, so a script that regresses to `var x = ...` stops loading here.
 */
function createProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gdharness-engine-'));

  cpSync('src/godot/addons', join(dir, 'addons'), { recursive: true });
  cpSync('src/godot/operations', join(dir, 'operations'), { recursive: true });

  writeFileSync(
    join(dir, 'project.godot'),
    [
      '; Engine configuration file.',
      'config_version=5',
      '',
      '[application]',
      'config/name="GdharnessEngineFixture"',
      '',
      '[debug]',
      'gdscript/warnings/exclude_addons=false',
      'gdscript/warnings/untyped_declaration=2',
      '',
    ].join('\n'),
  );

  return dir;
}

function runScript(
  godotPath: string,
  projectDir: string,
  scriptPath: string,
  extraArgs: string[] = [],
): SpawnSyncReturns<string> {
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
function assertNoEngineErrors(label: string, output: string): void {
  const errors = output
    .split('\n')
    .filter((line) => /^(SCRIPT ERROR|USER SCRIPT ERROR|ERROR|USER ERROR):/.test(line.trim()));
  assert.equal(errors.length, 0, `${label} hit engine errors:\n${errors.join('\n')}`);
}

/** Runs one of the fixture scripts in test/support/gd and returns the JSON it reported. */
function runFixture(godotPath: string, projectDir: string, name: string): unknown {
  const scriptPath = join(projectDir, `${name}.gd`);
  cpSync(join('test', 'support', 'gd', `${name}.gd`), scriptPath);

  const run = runScript(godotPath, projectDir, scriptPath);
  const output = `${run.stdout}\n${run.stderr}`;
  if (run.status !== 0) {
    throw new Error(`${name} failed (${run.status ?? run.signal}):\n${output.trim()}`);
  }
  assertNoEngineErrors(name, output);
  const payload = lastJsonLine(run.stdout, name);
  assert.equal(get(payload, 'ok'), true, `${name} should report success JSON`);
  return payload;
}

/**
 * The typing gate: every shipped script parses with an untyped declaration as an error.
 *
 * The count of what was checked is pinned to the files on disk, so a walk that finds nothing
 * cannot pass, and the gate is then shown to bite by planting one untyped script and watching
 * it refuse. A check that only ever says yes has not been shown to be a check.
 */
function testTypedGate(godotPath: string, projectDir: string): void {
  const shipped = shippedScripts();
  assert.ok(shipped.length >= 15, `the package ships GDScript: ${shipped.length} files`);
  assert.equal(
    get(runFixture(godotPath, projectDir, 'typed'), 'checked'),
    shipped.length,
    `every shipped script should be parsed: ${shipped.join(', ')}`,
  );

  const probeDir = join(projectDir, 'addons', 'probe');
  mkdirSync(probeDir, { recursive: true });
  writeFileSync(join(probeDir, 'untyped.gd'), 'extends Node\n\nvar loose = 1\n');
  const refused = runScript(godotPath, projectDir, join(projectDir, 'typed.gd'));
  rmSync(probeDir, { recursive: true, force: true });

  assert.notEqual(refused.status, 0, 'an untyped declaration in an addon should fail the gate');
  assert.match(
    refused.stderr,
    /res:\/\/addons\/probe\/untyped\.gd/,
    `the refused script should be named:\n${refused.stderr.trim()}`,
  );
  assert.match(
    refused.stderr,
    /has no static type/,
    `the reason should be the missing type:\n${refused.stderr.trim()}`,
  );
}

/**
 * The dependency walk is the one piece that cannot be called directly: the operations script
 * runs its whole job from _init and prints JSON, so it is driven the way the server drives it.
 */
function testDependencyWalk(godotPath: string, projectDir: string): void {
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

  const payload = lastJsonLine(run.stdout, 'get_dependencies');

  const top = asArray(get(payload, 'dependencies', 'res://chain/top.gd'), 'the walk result');

  const middle = top.find((dep) => get(dep, 'path') === 'res://chain/middle.gd');
  assert.ok(middle, 'top should depend on middle');
  assert.ok(get(middle, 'exists'), 'middle should be reported as existing');

  // Recursion is the half that broke when the walk state was six loose arguments.
  const leaf = asArray(get(middle, 'dependencies') ?? []).find(
    (dep) => get(dep, 'path') === 'res://chain/leaf.gd',
  );
  assert.ok(leaf, 'the walk should recurse from middle into leaf');

  assert.equal(get(payload, 'summary', 'total_resources'), 1, 'one resource was asked for');
  assert.ok(
    asNumber(get(payload, 'summary', 'total_dependencies')) >= 2,
    'the chain has at least two dependencies',
  );

  // A cycle has to be reported rather than walked forever.
  writeFileSync(paramsPath, JSON.stringify({ resource_path: 'res://chain/ouro.gd', max_depth: 10 }));
  const cyclic = runScript(godotPath, projectDir, join(projectDir, 'operations', 'godot_operations.gd'), [
    'get_dependencies',
    `@file:${paramsPath}`,
  ]);
  if (cyclic.status !== 0) {
    throw new Error(`get_dependencies on a cycle failed:\n${`${cyclic.stdout}\n${cyclic.stderr}`.trim()}`);
  }

  const cyclicPayload = lastJsonLine(cyclic.stdout, 'get_dependencies on a cycle');
  assert.ok(
    asArray(get(cyclicPayload, 'circular_references')).length > 0,
    'the walk should report the cycle it found rather than silently stopping',
  );

  // addons/ is project content and often shipping content, so it is walked like anything
  // else; what the walk leaves out by default is the engine's own res://. space.
  mkdirSync(join(projectDir, 'addons', 'fixture'), { recursive: true });
  writeFileSync(join(projectDir, 'addons', 'fixture', 'helper.gd'), 'extends Node\n');
  // The engine-internal path is loaded at run time rather than preloaded: the walk reads source
  // text, while a preload of a file that does not exist is a parse error every later fixture
  // that loads the project's scripts would trip over.
  writeFileSync(
    join(projectDir, 'chain', 'shipping.gd'),
    'extends Node\n\nconst Helper = preload("res://addons/fixture/helper.gd")\n\n\nfunc _cache() -> Variant:\n\treturn load("res://.godot/fixture_cache.gd")\n',
  );
  writeFileSync(paramsPath, JSON.stringify({ resource_path: 'res://chain/shipping.gd', max_depth: 3 }));
  const shipping = runScript(godotPath, projectDir, join(projectDir, 'operations', 'godot_operations.gd'), [
    'get_dependencies',
    `@file:${paramsPath}`,
  ]);
  rmSync(join(projectDir, 'chain', 'shipping.gd'));
  if (shipping.status !== 0) {
    throw new Error(
      `get_dependencies through addons failed:\n${`${shipping.stdout}\n${shipping.stderr}`.trim()}`,
    );
  }
  const shippingDeps = asArray(
    get(
      lastJsonLine(shipping.stdout, 'get_dependencies through addons'),
      'dependencies',
      'res://chain/shipping.gd',
    ),
  ).map((dep) => get(dep, 'path'));
  assert.ok(
    shippingDeps.includes('res://addons/fixture/helper.gd'),
    `addons are walked: ${shippingDeps.join(', ')}`,
  );
  assert.ok(
    !shippingDeps.includes('res://.godot/fixture_cache.gd'),
    `res://. is skipped: ${shippingDeps.join(', ')}`,
  );
}

/**
 * Runs one operation the way the server runs it, and returns the JSON object it printed.
 *
 * `scriptPath` defaults to the copy inside the project. The server runs the one in its own
 * package instead, from outside the project entirely, which is what testInstalledLayout passes.
 */
function runOperation(
  godotPath: string,
  projectDir: string,
  operation: string,
  params: unknown,
  scriptPath?: string,
): unknown {
  const paramsPath = join(projectDir, 'operation-params.json');
  writeFileSync(paramsPath, JSON.stringify(params));

  const script = scriptPath ?? join(projectDir, 'operations', 'godot_operations.gd');
  const run = runScript(godotPath, projectDir, script, [operation, `@file:${paramsPath}`]);
  const output = `${run.stdout}\n${run.stderr}`;

  if (run.status !== 0) {
    throw new Error(`${operation} failed (${run.status ?? run.signal}):\n${output.trim()}`);
  }
  assertNoEngineErrors(operation, output);

  return lastJsonLine(run.stdout, operation);
}

interface RefusedRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The exit status and combined output of an operation that is expected to refuse. */
function runRefusedOperation(
  godotPath: string,
  projectDir: string,
  operation: string,
  params: unknown,
): RefusedRun {
  const paramsPath = join(projectDir, 'operation-params.json');
  writeFileSync(paramsPath, JSON.stringify(params));

  const run = runScript(godotPath, projectDir, join(projectDir, 'operations', 'godot_operations.gd'), [
    operation,
    `@file:${paramsPath}`,
  ]);
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** A scene with one node of each shape the scene operations are asked to work on. */
function writeFixtureScene(projectDir: string): void {
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
function writeImportedResource(projectDir: string): void {
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
function testOperations(godotPath: string, projectDir: string): void {
  const operation = (name: string, params: unknown): unknown =>
    runOperation(godotPath, projectDir, name, params);
  const named = (entries: unknown, name: string): unknown =>
    asArray(entries).find((entry) => get(entry, 'name') === name);

  // GDScript authoring, then the analysis of what it wrote.
  const created = operation('create_script', {
    script_path: 'made/hero.gd',
    class_name: 'FixtureHero',
    extends_class: 'Node2D',
    template: 'state_machine',
  });
  assert.equal(get(created, 'registered'), true, 'a script given a class_name is registered');
  assert.equal(get(created, 'full_path'), 'res://made/hero.gd');
  const heroSource = readFileSync(join(projectDir, 'made', 'hero.gd'), 'utf8');
  assert.match(heroSource, /^class_name FixtureHero/m, 'the class_name should be written first');
  assert.match(heroSource, /func change_state/, 'the state_machine template should be the one used');

  // What gets written has to parse where an untyped declaration is an error, which the
  // autoload check further down proves by booting the project with this script as one.
  const modified = operation('modify_script', {
    script_path: 'made/hero.gd',
    modifications: [
      { type: 'add_variable', name: 'speed', varType: 'float', defaultValue: '4.0' },
      { type: 'add_variable', name: 'lives', defaultValue: '3' },
      { type: 'add_variable', name: 'target' },
      { type: 'add_function', name: 'halt', body: 'speed = 0.0' },
    ],
  });
  assert.equal(get(modified, 'total_modifications'), 4, 'every modification should be applied');
  const modifiedSource = readFileSync(join(projectDir, 'made', 'hero.gd'), 'utf8');
  assert.match(modifiedSource, /var speed: float = 4\.0/, 'the variable should carry its type and default');
  assert.match(modifiedSource, /var lives := 3/, 'a value with no type is inferred rather than left untyped');
  assert.match(modifiedSource, /var target: Variant/, 'no type and no value is spelled out as Variant');
  assert.match(
    modifiedSource,
    /func halt\(\) -> void:\n\tspeed = 0\.0/,
    'a function with no return type returns void',
  );

  const info = operation('get_script_info', { script_path: 'made/hero.gd' });
  assert.equal(get(info, 'class_name'), 'FixtureHero');
  assert.equal(get(info, 'extends'), 'Node2D');
  assert.ok(named(get(info, 'functions'), 'change_state'), 'the parser should find the template functions');
  assert.ok(named(get(info, 'signals'), 'state_changed'), 'the parser should find the template signal');
  assert.equal(
    get(named(get(info, 'variables'), 'speed'), 'type'),
    'float',
    'the parser should read the type off the variable that was just added',
  );

  // Project settings, including the value serialisers on both the way in and the way out.
  const name = operation('get_project_setting', { setting: 'application/config/name' });
  assert.equal(get(name, 'exists'), true);
  assert.equal(get(name, 'value'), 'GdharnessEngineFixture');

  const written = operation('set_project_setting', {
    setting: 'fixture/vector',
    value: { _type: 'Vector2', x: 3, y: 4 },
  });
  assert.equal(get(written, 'was_new'), true);
  assert.equal(get(written, 'saved'), true);
  assert.equal(
    get(written, 'new_value', '_type'),
    'Vector2',
    'a tagged value should survive as its own type',
  );
  const readBack = operation('get_project_setting', { setting: 'fixture/vector' });
  assert.deepEqual(
    { x: get(readBack, 'value', 'x'), y: get(readBack, 'value', 'y') },
    { x: 3, y: 4 },
    'the setting should come back as the vector it went in as',
  );

  // Autoloads are written into project.godot by hand, so the round trip is the only proof.
  const added = operation('add_autoload', { name: 'Hero', path: 'made/hero.gd' });
  assert.equal(get(added, 'action'), 'added');
  const hero = named(get(operation('list_autoloads', {}), 'autoloads'), 'Hero');
  assert.ok(hero, 'the autoload that was just added should be listed');
  assert.equal(get(hero, 'enabled'), true, 'the leading asterisk means enabled');
  assert.equal(get(hero, 'file_exists'), true);
  assert.equal(get(operation('remove_autoload', { name: 'Hero' }), 'removed'), true);

  // The main scene is a project setting with a file behind it, so both halves are checked.
  writeFixtureScene(projectDir);
  assert.equal(get(operation('set_main_scene', { scene_path: 'fixture_scene.tscn' }), 'saved'), true);
  assert.equal(
    get(operation('get_project_setting', { setting: 'application/run/main_scene' }), 'value'),
    'res://fixture_scene.tscn',
  );

  // The import pipeline reads and writes the .import sidecar, which is a ConfigFile.
  writeImportedResource(projectDir);
  const status = operation('get_import_status', { include_up_to_date: true });
  assert.equal(get(status, 'summary', 'total'), 1, 'the one importable resource should be found');
  assert.equal(get(status, 'resources', 0, 'path'), 'res://art.png');
  assert.equal(get(status, 'resources', 0, 'import_file_exists'), true);

  assert.equal(
    get(operation('get_import_options', { resource_path: 'art.png' }), 'params', 'compress/mode'),
    0,
  );
  const options = operation('set_import_options', {
    resource_path: 'art.png',
    options: { 'compress/mode': 2 },
  });
  assert.deepEqual(get(options, 'updated_options'), ['compress/mode']);
  assert.equal(
    get(operation('get_import_options', { resource_path: 'art.png' }), 'params', 'compress/mode'),
    2,
    'the option should have been written into the .import file',
  );
  assert.equal(
    get(operation('reimport_resource', { resource_path: 'art.png' }), 'current_status'),
    'up_to_date',
  );

  const presets = operation('list_export_presets', {});
  assert.equal(get(presets, 'presets_file_exists'), false, 'the fixture project configures no exports');
  assert.match(asString(get(presets, 'note')), /export_presets\.cfg/);

  const validation = operation('validate_project', {});
  assert.ok(asArray(get(validation, 'checks_performed')).includes('main_scene'));
  assert.equal(get(validation, 'valid'), true, 'the main scene was set above, so the project validates');
  assert.ok(
    asArray(get(validation, 'warnings')).some((warning) => get(warning, 'check') === 'export_presets'),
    'a project with no export presets should be warned about',
  );

  // Diagnostics: the health score and the reverse dependency search.
  const health = operation('get_project_health', {});
  assert.match(asString(get(health, 'grade')), /^[A-F]$/);
  assert.ok(asNumber(get(health, 'checks', 'scripts', 'total_scripts')) > 0, 'the project has scripts in it');

  // The chain the dependency walk was pointed at is also what refers to leaf.gd.
  const usages = operation('find_resource_usages', { resource_path: 'chain/leaf.gd' });
  assert.ok(asNumber(get(usages, 'summary', 'total_usages')) > 0, 'leaf.gd is preloaded by middle.gd');
  assert.ok(
    asArray(get(usages, 'usages')).some((entry) => get(entry, 'file') === 'res://chain/middle.gd'),
    'the file holding the reference should be named',
  );

  // The resave walks the project and writes every scene and script back.
  assert.equal(get(operation('get_uid', { file_path: 'made/hero.gd' }), 'exists'), false);
  const resaved = operation('resave_resources', {});
  assert.ok(asNumber(get(resaved, 'scenes_saved')) > 0, 'the fixture scene should be resaved');
  assert.equal(get(resaved, 'scenes_with_errors'), 0);
  assert.ok(asNumber(get(resaved, 'scripts_resaved')) > 0, 'the scripts in the project should be resaved');
  // Measured on 4.7.2: outside the editor ResourceSaver answers OK and writes no .uid
  // sidecar, so a script that had none still has none. The count above is resaves, not UIDs.
  assert.equal(
    get(operation('get_uid', { file_path: 'made/hero.gd' }), 'exists'),
    false,
    'a headless resave cannot mint a UID, and saying it did would be the lie to catch',
  );

  // Plugins: the shipped addons are installed and none is enabled until one is asked for.
  // The enabled list in project.godot is an engine expression the editor reads, so what was
  // written is read back through the same file rather than trusted from the answer.
  const plugins = operation('list_plugins', {});
  assert.equal(get(plugins, 'addons_directory_exists'), true);
  assert.equal(get(named(get(plugins, 'plugins'), 'godot_mcp_editor'), 'enabled'), false);
  assert.equal(get(plugins, 'enabled_count'), 0);

  assert.equal(get(operation('enable_plugin', { plugin_name: 'godot_mcp_editor' }), 'action'), 'enabled');
  assert.match(
    readFileSync(join(projectDir, 'project.godot'), 'utf8'),
    /^enabled=PackedStringArray\("res:\/\/addons\/godot_mcp_editor\/plugin\.cfg"\)$/m,
    'the enabled list should be written as the expression the editor reads, not a quoted string',
  );
  const enabled = operation('list_plugins', {});
  assert.equal(get(named(get(enabled, 'plugins'), 'godot_mcp_editor'), 'enabled'), true);
  assert.equal(get(enabled, 'enabled_count'), 1);
  assert.equal(
    get(operation('enable_plugin', { plugin_name: 'godot_mcp_editor' }), 'action'),
    'already_enabled',
  );

  assert.equal(get(operation('disable_plugin', { plugin_name: 'godot_mcp_editor' }), 'action'), 'disabled');
  assert.equal(get(operation('list_plugins', {}), 'enabled_count'), 0);

  // Input actions, which are stored as an engine expression rather than as JSON.
  const action = operation('add_input_action', {
    action_name: 'fixture_jump',
    events: [{ type: 'key', keycode: 'Space', ctrl: true }],
  });
  assert.equal(get(action, 'events_count'), 1);
  assert.equal(get(action, 'events', 0, 'keycode'), 32, 'Space is KEY_SPACE');
  assert.equal(get(action, 'events', 0, 'ctrl_pressed'), true);

  // Audio buses live in the AudioServer and only survive the run if the layout is saved.
  assert.equal(get(operation('create_audio_bus', { busName: 'Fixture' }), 'success'), true);
  const buses = operation('get_audio_buses', {});
  assert.ok(asNumber(get(buses, 'bus_count')) >= 1);
  assert.ok(named(get(buses, 'buses'), 'Master'), 'every project has a Master bus');

  // ClassDB, which is the one source of answers that does not touch the project at all.
  const classes = operation('query_classes', { filter: 'camera', category: 'node' });
  assert.ok(asArray(get(classes, 'classes')).includes('Camera2D'));
  assert.ok(
    asNumber(get(classes, 'filtered_count')) < asNumber(get(classes, 'total_classes')),
    'the filter should exclude something',
  );

  const classInfo = operation('query_class_info', { class_name: 'Camera2D' });
  assert.equal(get(classInfo, 'parent_class'), 'Node2D');
  assert.ok(asNumber(get(classInfo, 'methods_count')) > 0);
  assert.ok(named(get(classInfo, 'properties'), 'zoom'));

  const inheritance = operation('inspect_inheritance', { class_name: 'Node2D' });
  assert.ok(asArray(get(inheritance, 'ancestors')).includes('CanvasItem'));
  assert.ok(asArray(get(inheritance, 'all_descendants')).includes('Camera2D'));
}

/**
 * An operation that cannot answer has to say so rather than print a payload.
 *
 * The failure path is the half that breaks silently: a module that answers with an empty
 * result and one that answers with a half-built dictionary look alike from the outside until
 * somebody reads the exit status as well as the output.
 */
function testRefusals(godotPath: string, projectDir: string): void {
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
function testInstalledLayout(godotPath: string, projectDir: string): void {
  const installed = resolve('src/godot/operations/godot_operations.gd');
  const params = { class_name: 'Node' };
  const payload = runOperation(godotPath, projectDir, 'query_class_info', params, installed);
  assert.equal(get(payload, 'class_name'), 'Node');
  assert.ok(
    asNumber(get(payload, 'methods_count')) > 0,
    'the modules should have loaded from outside the project',
  );
}

function main(): void {
  const godotPath = resolveGodotPath();
  if (!godotPath) {
    // A skip is fine on a machine with no engine and never fine where the job exists to run
    // this. Without the flag, CI installing Godot wrong would read as a pass.
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      // The list of what was tried and how each one failed, because the next person to hit
      // this is looking at a CI log for a platform they cannot reproduce.
      throw new Error(
        [
          'GDHARNESS_REQUIRE_GODOT is set and no Godot could be run.',
          `GODOT_PATH=${process.env['GODOT_PATH'] ?? '<unset>'} GODOT=${process.env['GODOT'] ?? '<unset>'}`,
          ...tried.map((line) => `  tried ${line}`),
        ].join('\n'),
      );
    }
    console.log('engine gdscript tests skipped (no Godot found)');
    return;
  }

  const projectDir = createProject();
  try {
    testTypedGate(godotPath, projectDir);
    runFixture(godotPath, projectDir, 'scene_parse');
    runFixture(godotPath, projectDir, 'operations_serialize');
    runFixture(godotPath, projectDir, 'runtime_serialize');
    runFixture(godotPath, projectDir, 'runtime_input');
    runFixture(godotPath, projectDir, 'runtime_clients');
    runFixture(godotPath, projectDir, 'input_action');
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
