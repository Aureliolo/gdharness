/**
 * Drives the GDScript that ships inside the bundle against a real engine.
 *
 * The rest of the suite exercises the TypeScript in front of these scripts. Nothing exercised
 * the scripts themselves, which is where the value serialisers, the project.godot writers and
 * the dependency walk live: code that answers rather than fails when it is wrong, so a silent
 * regression in it reads as a working tool returning a plausible shape.
 */

import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runOperation as runThroughTheServersOwnPath } from '../src/headless.js';
import { userDataIn } from '../src/launch.js';
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
 * Every GDScript warning this engine has, asked of the engine rather than written down here.
 *
 * A list kept by hand is a list that goes stale. This one was missing eight of them,
 * `unsafe_call_argument` among them, so a project that turned that warning on lost every headless
 * operation at once while the gate calling itself the strictest project Godot can be configured as
 * went on passing. What is asked for is whatever this engine has, so a warning added by a future
 * Godot arrives here without anybody noticing it had to.
 *
 * Asking also survives the set being rearranged between versions: 4.7.2 has no `exclude_addons`
 * among these at all, and covers addons through `directory_rules` instead.
 *
 * What comes back is the settings that take a level, which is not all of them, decided on the type
 * the engine registers rather than on a list of exceptions kept here. Such a list goes stale the
 * same way: `renamed_in_godot_4_hint` sits among the warnings and is a bool.
 */
function everyWarning(godotPath: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'gdharness-warnings-'));
  try {
    writeFileSync(
      join(dir, 'project.godot'),
      [
        '; Engine configuration file.',
        'config_version=5',
        '',
        '[application]',
        'config/name="Warnings"',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'warnings.gd'),
      [
        'extends SceneTree',
        '',
        '',
        'func _init() -> void:',
        '\tvar names: Array[String] = []',
        '\tfor property: Dictionary in ProjectSettings.get_property_list():',
        '\t\tvar setting: String = str(property.get("name", ""))',
        '\t\tif not setting.begins_with("debug/gdscript/warnings/"):',
        '\t\t\tcontinue',
        // The ones that take a level are the ones registered as an int. Asked of the engine rather
        // than named here, because a list of exceptions goes stale exactly the way the list of
        // warnings did: renamed_in_godot_4_hint sits among them and is a bool, so it was being sent
        // a level, and 2 being truthy is the only reason nothing looked wrong.
        '\t\tvar kind: int = property.get("type", TYPE_NIL)',
        '\t\tif kind != TYPE_INT:',
        '\t\t\tcontinue',
        '\t\tnames.append(setting.get_slice("/", 3))',
        '\tnames.sort()',
        '\tprint("WARNINGS:" + ",".join(names))',
        '\tquit(0)',
        '',
      ].join('\n'),
    );
    const run = runScript(godotPath, dir, join(dir, 'warnings.gd'));
    const said = [run.stdout, run.stderr].join('\n');
    const line = run.stdout.split('\n').find((text) => text.startsWith('WARNINGS:')) ?? '';
    // Already filtered to the settings that take a level, by the engine's own idea of their type.
    // Three of the 52 do not: `enable`, `directory_rules`, which the callers here set for
    // themselves, and `renamed_in_godot_4_hint`.
    const names = line
      .slice('WARNINGS:'.length)
      .split(',')
      .filter((name) => name !== '');
    // A query that answered with nothing would build the laxest project rather than the strictest,
    // and every fixture after it would pass for the wrong reason.
    assert.ok(names.length > 40, `the engine should have named its warnings: ${said}`);
    // And the two this gate was built for are named, because a count alone still passes while the
    // filtering above quietly drops them, which is the gate going quiet about the one thing it
    // exists to catch.
    for (const wanted of ['unsafe_call_argument', 'return_value_discarded']) {
      assert.ok(names.includes(wanted), `the derived warnings should include ${wanted}: ${said}`);
    }
    return names;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
 * The warning settings make every GDScript warning a parse error, in the addons as well, which
 * the engine otherwise exempts. That is the strictest project Godot can be configured as, and a
 * project configured that way parses the shipped scripts under it: the operations script from
 * wherever the package is installed, the addons from its own addons/. Every script the fixtures
 * load is parsed under those settings, so a script that regresses to `var x = ...`, `var x := ...`,
 * a method called on a Variant or a static function called on an instance stops loading here
 * rather than in somebody's project.
 */
function createProject(godotPath: string): string {
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
      // Godot exempts res://addons from warnings by default, which would leave the shipped addons
      // unchecked here. Emptied rather than lowered: a project is free to do the same, and an
      // addon that only compiles where nobody is looking is an addon that breaks in the field.
      'gdscript/warnings/directory_rules={}',
      ...everyWarning(godotPath).map((warning) => `gdscript/warnings/${warning}=2`),
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
    .filter((line) => /^(USER )?(SCRIPT ERROR|ERROR|WARNING):/.test(line.trim()));
  assert.equal(errors.length, 0, `${label} hit engine errors or warnings:\n${errors.join('\n')}`);
}

/** Runs one of the fixture scripts in test/support/gd and returns the JSON it reported. */
function runFixture(godotPath: string, projectDir: string, name: string): unknown {
  const scriptPath = join(projectDir, `${name}.gd`);
  cpSync(join('test', 'support', 'gd', `${name}.gd`), scriptPath);
  // A fixture is copied to the project root on its own, so anything it preloads by a bare name has
  // to arrive beside it rather than stay behind in test/support/gd.
  cpSync(join('test', 'support', 'gd', 'checked.gd'), join(projectDir, 'checked.gd'));

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
  writeFileSync(paramsPath, JSON.stringify({ resource_path: 'res://chain/top.gd', depth: 5 }));

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
  writeFileSync(paramsPath, JSON.stringify({ resource_path: 'res://chain/ouro.gd' }));
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
  writeFileSync(paramsPath, JSON.stringify({ resource_path: 'res://chain/shipping.gd', depth: 3 }));
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
  // Anything on stderr from an operation that succeeded is the engine complaining about
  // something the operation did, a leaked object or a resource still in use at exit included,
  // and the server hands every such line on to the caller. So an operation that passes here is
  // one that answers cleanly.
  assert.equal(run.stderr.trim(), '', `${operation} succeeded but wrote to stderr:\n${run.stderr.trim()}`);

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
    extends: 'Node2D',
    template: 'state_machine',
  });
  assert.equal(get(created, 'registered'), true, 'a script given a class_name is registered');
  assert.equal(get(created, 'full_path'), 'res://made/hero.gd');
  assert.equal(get(created, 'parses'), true, 'the answer says the engine accepted what was written');
  const heroSource = readFileSync(join(projectDir, 'made', 'hero.gd'), 'utf8');
  assert.match(heroSource, /^class_name FixtureHero/m, 'the class_name should be written first');
  assert.match(heroSource, /func change_state/, 'the state_machine template should be the one used');

  // Every template has to parse in the strictest project there is, which this one is: a
  // template that trips a warning there is a script the tool wrote that the engine refuses.
  // The operation loads what it wrote and says so, and anything it printed on the way is
  // stderr the run above refuses.
  for (const [template, base] of [
    ['singleton', 'Node'],
    ['component', 'Node'],
    ['resource', 'Resource'],
    ['none', 'Node'],
  ] as const) {
    const made = operation('create_script', {
      script_path: `made/${template}_template.gd`,
      extends: base,
      template: template === 'none' ? '' : template,
    });
    assert.equal(get(made, 'parses'), true, `the ${template} template should parse under every warning`);
  }
  const broken = runRefusedOperation(godotPath, projectDir, 'create_script', {
    script_path: 'made/broken.gd',
    content: 'func _ready() -> void:\n\tvar loose = 1\n',
  });
  assert.equal(broken.status, 0, 'a script that was written is a success, whatever it says');
  assert.equal(
    get(lastJsonLine(broken.stdout, 'create_script'), 'parses'),
    false,
    'a script the engine refuses is reported as not parsing',
  );
  assert.match(broken.stderr, /loose/, 'the reason is on stderr, where the server reads it from');
  // Gone again before the resave below walks the project, which would trip over it.
  rmSync(join(projectDir, 'made', 'broken.gd'));

  // What gets written has to parse where an untyped declaration is an error, which the
  // autoload check further down proves by booting the project with this script as one.
  const modified = operation('modify_script', {
    script_path: 'made/hero.gd',
    modifications: [
      { type: 'add_variable', name: 'speed', varType: 'float', defaultValue: '4.0' },
      { type: 'add_variable', name: 'lives', defaultValue: '3' },
      { type: 'add_variable', name: 'home', defaultValue: 'Vector2(1, 2)' },
      { type: 'add_variable', name: 'owner_node', defaultValue: 'get_parent()' },
      { type: 'add_variable', name: 'target' },
      { type: 'add_function', name: 'halt', body: 'speed = 0.0' },
    ],
  });
  assert.equal(get(modified, 'total_modifications'), 6, 'every modification should be applied');
  const modifiedSource = readFileSync(join(projectDir, 'made', 'hero.gd'), 'utf8');
  assert.match(modifiedSource, /var speed: float = 4\.0/, 'the variable should carry its type and default');
  assert.match(
    modifiedSource,
    /var lives: int = 3/,
    'a value with no type gets the type it evaluates to, so it parses where an inferred declaration is an error',
  );
  assert.match(modifiedSource, /var home: Vector2 = Vector2\(1, 2\)/, 'a constructor evaluates to its type');
  assert.match(
    modifiedSource,
    /var owner_node: Variant = get_parent\(\)/,
    'a value nothing can evaluate here is Variant rather than a guess the engine would refuse',
  );
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

  // JSON has one number type, so an int setting was written as "50.0" and every reader cast it
  // back: the tool said 50, the editor said 50, and only the file in the commit said otherwise.
  // The file is the assertion for that reason.
  const counted = operation('set_project_setting', {
    setting: 'debug/file_logging/max_log_files',
    value: 50,
  });
  assert.equal(get(counted, 'new_value'), 50, 'an int setting takes an int');
  assert.match(
    readFileSync(join(projectDir, 'project.godot'), 'utf8'),
    /^file_logging\/max_log_files=50$/m,
    'and project.godot records it as one, not as 50.0',
  );

  const truncated = runRefusedOperation(godotPath, projectDir, 'set_project_setting', {
    setting: 'debug/file_logging/max_log_files',
    value: 50.5,
  });
  assert.notEqual(truncated.status, 0, 'a number the setting cannot hold is refused, not truncated');
  assert.match(
    `${truncated.stdout}\n${truncated.stderr}`,
    /cannot be written as that without losing something/,
    `the refusal should say why:\n${truncated.stderr.trim()}`,
  );
  assert.match(
    readFileSync(join(projectDir, 'project.godot'), 'utf8'),
    /^file_logging\/max_log_files=50$/m,
    'and a refused write leaves the file as it was',
  );

  // Every write to project.godot goes through the engine's own save, which keeps the header
  // the editor writes and every line it did not touch. The file is in the engine's own form
  // from the setting saved above, so from here on a round trip has to give the bytes back
  // and an addition has to keep every line that was there.
  const projectFile = join(projectDir, 'project.godot');
  const keptWhole = (before: string, after: string, what: string): void => {
    assert.match(after, /^; Engine configuration file\.$/m, `${what} should keep the editor's header`);
    const lines = after.split('\n');
    let from = 0;
    for (const line of before.split('\n')) {
      const at = lines.indexOf(line, from);
      assert.notEqual(at, -1, `${what} should keep the line ${JSON.stringify(line)}`);
      from = at + 1;
    }
  };

  // Autoloads are written into project.godot by hand, so the round trip is the only proof.
  const beforeAutoload = readFileSync(projectFile, 'utf8');
  const added = operation('add_autoload', { name: 'Hero', path: 'made/hero.gd' });
  assert.equal(get(added, 'action'), 'added');
  keptWhole(beforeAutoload, readFileSync(projectFile, 'utf8'), 'adding an autoload');
  const hero = named(get(operation('list_autoloads', {}), 'autoloads'), 'Hero');
  assert.ok(hero, 'the autoload that was just added should be listed');
  assert.equal(get(hero, 'enabled'), true, 'the leading asterisk means enabled');
  assert.equal(get(hero, 'file_exists'), true);
  assert.equal(get(operation('remove_autoload', { name: 'Hero' }), 'removed'), true);
  assert.equal(
    readFileSync(projectFile, 'utf8'),
    beforeAutoload,
    'adding then removing an autoload should give project.godot back byte for byte',
  );

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

  // The chain the dependency walk was pointed at is also what refers to leaf.gd, and each
  // reference says how: middle.gd preloads it.
  const usages = operation('find_resource_usages', { resource_path: 'chain/leaf.gd' });
  const middle = asArray(get(usages, 'usages')).find(
    (entry) => get(entry, 'file') === 'res://chain/middle.gd',
  );
  assert.ok(middle, `the file holding the reference should be named:\n${JSON.stringify(usages)}`);
  assert.equal(get(middle, 'references', 0, 'kind'), 'preload');
  assert.equal(get(usages, 'summary', 'by_kind', 'preload'), 1);
  assert.equal(get(usages, 'class_name'), null, 'leaf.gd declares no class_name');

  // A script with a class_name is referred to by that name, which no path search finds: one
  // script extends it, another instances it, and a scene attaches it by path.
  writeFileSync(join(projectDir, 'made', 'knight.gd'), 'extends FixtureHero\n');
  writeFileSync(
    join(projectDir, 'made', 'spawner.gd'),
    'extends Node\n\nfunc spawn() -> FixtureHero:\n\treturn FixtureHero.new()\n',
  );
  writeFileSync(
    join(projectDir, 'made', 'hero.tscn'),
    '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://made/hero.gd" id="1"]\n\n[node name="Hero" type="Node2D"]\nscript = ExtResource("1")\n',
  );
  const byName = operation('find_resource_usages', { resource_path: 'made/hero.gd' });
  assert.equal(get(byName, 'class_name'), 'FixtureHero');
  const kinds = new Map(
    asArray(get(byName, 'usages')).map((entry) => [
      asString(get(entry, 'file')),
      asArray(get(entry, 'references')).map((reference) => get(reference, 'kind')),
    ]),
  );
  assert.deepEqual(kinds.get('res://made/knight.gd'), ['extends'], JSON.stringify(byName));
  assert.deepEqual(kinds.get('res://made/spawner.gd'), ['class_name', 'class_name']);
  assert.deepEqual(kinds.get('res://made/hero.tscn'), ['ext_resource']);
  assert.equal(get(byName, 'summary', 'files_with_usages'), 3);

  // The global class list, rebuilt from the scripts on disk over a stale one, then read back
  // by a fresh engine: the file is only right if the engine itself lists the classes from it.
  writeFileSync(join(projectDir, 'made', 'squire.gd'), 'class_name FixtureSquire\nextends FixtureHero\n');
  mkdirSync(join(projectDir, '.godot'), { recursive: true });
  writeFileSync(
    join(projectDir, '.godot', 'global_script_class_cache.cfg'),
    'list=[{\n"base": &"Node",\n"class": &"Stale",\n"icon": "",\n"is_abstract": false,\n"is_tool": false,\n"language": &"GDScript",\n"path": "res://gone.gd"\n}]\n',
  );
  const rebuilt = operation('refresh_class_cache', {});
  assert.deepEqual(get(rebuilt, 'removed'), ['Stale'], JSON.stringify(rebuilt));
  const listed = asArray(get(rebuilt, 'added'));
  assert.ok(
    listed.includes('FixtureHero') && listed.includes('FixtureSquire'),
    `added: ${listed.join(', ')}`,
  );
  assert.deepEqual(get(rebuilt, 'skipped'), [], 'every script with a class_name loads');
  const known = runFixture(godotPath, projectDir, 'class_list');
  assert.equal(get(known, 'classes', 'FixtureSquire', 'base'), 'FixtureHero', JSON.stringify(known));
  assert.equal(get(known, 'classes', 'FixtureHero', 'base'), 'Node2D');
  assert.equal(get(known, 'classes', 'FixtureHero', 'path'), 'res://made/hero.gd');
  assert.equal(get(known, 'classes', 'Stale'), undefined, 'the stale entry is gone');

  // The resave walks the project and writes every scene and script back.
  assert.equal(get(operation('get_uid', { resource_path: 'made/hero.gd' }), 'exists'), false);
  const resaved = operation('resave_resources', {});
  assert.ok(asNumber(get(resaved, 'scenes_saved')) > 0, 'the fixture scene should be resaved');
  assert.equal(get(resaved, 'scenes_with_errors'), 0);
  assert.ok(asNumber(get(resaved, 'scripts_resaved')) > 0, 'the scripts in the project should be resaved');
  // Measured on 4.7.2: outside the editor ResourceSaver answers OK and writes no .uid
  // sidecar, so a script that had none still has none. The count above is resaves, not UIDs.
  assert.equal(
    get(operation('get_uid', { resource_path: 'made/hero.gd' }), 'exists'),
    false,
    'a headless resave cannot mint a UID, and saying it did would be the lie to catch',
  );

  // Plugins: the shipped addons are installed and none is enabled until one is asked for.
  // The enabled list in project.godot is an engine expression the editor reads, so what was
  // written is read back through the same file rather than trusted from the answer.
  const plugins = operation('list_plugins', {});
  assert.equal(get(plugins, 'addons_directory_exists'), true);
  assert.equal(get(named(get(plugins, 'plugins'), 'gdharness_editor'), 'enabled'), false);
  assert.equal(get(plugins, 'enabled_count'), 0);

  const beforePlugin = readFileSync(projectFile, 'utf8');
  assert.equal(get(operation('enable_plugin', { plugin_name: 'gdharness_editor' }), 'action'), 'enabled');
  const withPlugin = readFileSync(projectFile, 'utf8');
  assert.match(
    withPlugin,
    /^enabled=PackedStringArray\("res:\/\/addons\/gdharness_editor\/plugin\.cfg"\)$/m,
    'the enabled list should be written as the expression the editor reads, not a quoted string',
  );
  keptWhole(beforePlugin, withPlugin, 'enabling a plugin');
  const enabled = operation('list_plugins', {});
  assert.equal(get(named(get(enabled, 'plugins'), 'gdharness_editor'), 'enabled'), true);
  assert.equal(get(enabled, 'enabled_count'), 1);
  assert.equal(
    get(operation('enable_plugin', { plugin_name: 'gdharness_editor' }), 'action'),
    'already_enabled',
  );

  assert.equal(get(operation('disable_plugin', { plugin_name: 'gdharness_editor' }), 'action'), 'disabled');
  assert.equal(get(operation('list_plugins', {}), 'enabled_count'), 0);
  assert.equal(
    readFileSync(projectFile, 'utf8'),
    beforePlugin,
    'enabling then disabling a plugin should give project.godot back byte for byte',
  );

  // Input actions, which are stored as an engine expression rather than as JSON.
  const beforeAction = readFileSync(projectFile, 'utf8');
  const action = operation('add_input_action', {
    action_name: 'fixture_jump',
    events: [{ type: 'key', keycode: 'Space', ctrl: true }],
  });
  assert.equal(get(action, 'events_count'), 1);
  assert.equal(get(action, 'events', 0, 'keycode'), 32, 'Space is KEY_SPACE');
  assert.equal(get(action, 'events', 0, 'ctrl_pressed'), true);
  keptWhole(beforeAction, readFileSync(projectFile, 'utf8'), 'adding an input action');

  // Audio buses live in the AudioServer and only survive the run if the layout is saved.
  const fixtureBus = operation('create_audio_bus', { bus_name: 'Fixture' });
  assert.equal(get(fixtureBus, 'bus', 'name'), 'Fixture', 'the bus carries the name it was given');
  assert.equal(get(fixtureBus, 'layout'), 'res://default_bus_layout.tres');
  const buses = operation('get_audio_buses', {});
  assert.ok(named(get(buses, 'buses'), 'Master'), 'every project has a Master bus');
  assert.ok(named(get(buses, 'buses'), 'Fixture'), 'the layout was written, so a fresh process sees the bus');
  const reverb = operation('set_audio_bus_effect', {
    bus_index: asNumber(get(fixtureBus, 'bus', 'index')),
    effect_index: 0,
    effect_type: 'AudioEffectReverb',
  });
  assert.equal(get(reverb, 'bus', 'effects', 0, 'type'), 'AudioEffectReverb', JSON.stringify(reverb));

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
 * A `.gdignore` is how a project tells the engine a directory is not part of it: nothing under
 * one is imported, so nothing in there is a resource, a dependency or a global class. Both
 * walks have to stop at it, or every answer built on them names files the engine will never
 * load, and a class list holding one sends a game looking for a script it cannot resolve.
 *
 * Each half adds a visible file beside an ignored one and counts, because a walk that had
 * stopped finding anything at all satisfies the absence just as well.
 */
function testAGdignoreStopsTheWalk(godotPath: string, projectDir: string): void {
  const operation = (name: string, params: unknown): unknown =>
    runOperation(godotPath, projectDir, name, params);

  const vendor = join(projectDir, 'vendor');
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(vendor, '.gdignore'), '');

  const scripts = (): number =>
    asNumber(get(operation('get_project_health', {}), 'checks', 'scripts', 'total_scripts'));
  const scriptsBefore = scripts();
  writeFileSync(join(projectDir, 'made', 'errand.gd'), 'extends Node\n');
  writeFileSync(join(vendor, 'stowaway.gd'), 'class_name FixtureStowaway\nextends Node\n');
  assert.equal(
    scripts(),
    scriptsBefore + 1,
    'the visible script should count and the one under .gdignore should not',
  );

  // Rebuilt from nothing so the answer is the whole list rather than the difference from a
  // cache that already holds the project's classes.
  rmSync(join(projectDir, '.godot', 'global_script_class_cache.cfg'), { force: true });
  const added = asArray(get(operation('refresh_class_cache', {}), 'added')).map((name) => asString(name));
  assert.ok(added.includes('FixtureHero'), `the project's own classes are listed: ${added.join(', ')}`);
  assert.ok(
    !added.includes('FixtureStowaway'),
    `a class_name under .gdignore is not a global class: ${added.join(', ')}`,
  );

  // The extension walk, which import status is built from.
  const importable = (): number =>
    asNumber(get(operation('get_import_status', { include_up_to_date: true }), 'summary', 'total'));
  const importableBefore = importable();
  writeFileSync(join(projectDir, 'made', 'loose.png'), 'fixture bytes, never decoded');
  writeFileSync(join(vendor, 'stowed.png'), 'fixture bytes, never decoded');
  assert.equal(
    importable(),
    importableBefore + 1,
    'the visible resource should be found and the ignored one should not',
  );
}

/** The one `godot.log` under `home`, which is wherever the engine decided `user://` was. */
function benchLog(home: string): string | null {
  const look = (directory: string): string | null => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = look(path);
        if (found !== null) {
          return found;
        }
      } else if (entry.name === 'godot.log') {
        return path;
      }
    }
    return null;
  };
  return look(home);
}

/**
 * A headless operation does not touch the log of a run already going against the project.
 *
 * The engine renames `user://logs/godot.log` when a process starts, so on a project with file
 * logging on, one operation rotated a running bench's log out from under it and the bench went on
 * writing at the offset it still believed it was at. Measured before the fix: the operation's 237
 * bytes, then 964 zero bytes, then the bench's next row. A downstream project found it with
 * `project_settings get`, but nothing about that op is special. Every operation here boots the
 * same way, so the guard belongs where the boot is built rather than on the tool that revealed it.
 *
 * The bench is asserted to have gone on logging, because a bench that died at the first boot
 * leaves a log that is intact in exactly the same way.
 */
async function testAnOperationLeavesARunningLogAlone(godotPath: string): Promise<void> {
  // `user://` comes off APPDATA and XDG_DATA_HOME, and off HOME where neither is read: on macOS
  // this would write into the Godot directory of whoever is running it, and reaching into a real
  // one is the thing the whole case is about.
  if (process.platform === 'darwin') {
    console.log('the log race is not checked on macOS: user:// cannot be moved off the real HOME');
    return;
  }

  const home = mkdtempSync(join(tmpdir(), 'gdharness-userdata-'));
  const project = mkdtempSync(join(tmpdir(), 'gdharness-lograce-'));
  const name = `LogRace${process.pid}`;
  writeFileSync(
    join(project, 'project.godot'),
    [
      '; Engine configuration file.',
      'config_version=5',
      '',
      '[application]',
      `config/name="${name}"`,
      '',
      '[debug]',
      'file_logging/enable_file_logging=true',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(project, 'bench.gd'),
    [
      'extends SceneTree',
      '',
      'var _rows: int = 0',
      '',
      '',
      'func _init() -> void:',
      '\tvar ticker := Timer.new()',
      '\tticker.wait_time = 0.25',
      '\tticker.autostart = true',
      '\troot.add_child(ticker)',
      '\tticker.timeout.connect(_row)',
      '',
      '',
      'func _row() -> void:',
      '\t_rows += 1',
      '\tprint("row %04d %s" % [_rows, "settling".repeat(6)])',
      '\tif _rows >= 120:',
      '\t\tquit(0)',
      '',
    ].join('\n'),
  );

  const bench = spawn(godotPath, ['--headless', '--path', project, '--script', join(project, 'bench.gd')], {
    stdio: 'ignore',
    env: userDataIn(home),
  });
  const moved = ['APPDATA', 'XDG_DATA_HOME'];
  const saved = new Map(moved.map((name) => [name, process.env[name]]));
  // Put back, rather than set back: assigning undefined to a variable stores the word "undefined",
  // and a relative XDG_DATA_HOME is one the engine warns about on stderr in every later operation,
  // which is how this leaked out of the case that set it and failed a different one.
  const restore = (): void => {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
  try {
    let log: string | null = null;
    const ready = Date.now() + 60_000;
    while (log === null && Date.now() < ready) {
      await delay(500);
      log = benchLog(home);
    }
    assert.ok(log, 'the bench should have started writing a log to the moved user directory');
    while (!readFileSync(log, 'utf8').includes('row 0004') && Date.now() < ready) {
      await delay(500);
    }
    const before = readFileSync(log, 'utf8');
    assert.match(before, /row 0004/, `the bench should be logging rows: ${before.slice(0, 200)}`);

    // The operation the way the server runs it, pointed at the same project and reading the same
    // moved user directory, which is what makes the two engines want one file.
    process.env['APPDATA'] = home;
    process.env['XDG_DATA_HOME'] = home;
    const answered = await runThroughTheServersOwnPath(
      { godotPath, script: resolve('src/godot/operations/godot_operations.gd'), debug: false },
      'get_project_setting',
      { settingPath: 'debug/gdscript/warnings/unsafe_call_argument' },
      project,
    );
    assert.ok(answered.ok, `the operation should still answer: ${answered.ok ? '' : answered.message}`);

    // Time for the bench to write past wherever a truncation would have left the end.
    const rows = (text: string): number => (text.match(/row \d{4}/g) ?? []).length;
    const grown = Date.now() + 30_000;
    while (rows(readFileSync(log, 'utf8')) <= rows(before) && Date.now() < grown) {
      await delay(500);
    }

    const after = readFileSync(log);
    assert.ok(
      rows(after.toString('latin1')) > rows(before),
      'the bench should have gone on logging, or this proves nothing',
    );
    assert.equal(after.indexOf(0), -1, 'a log written over at a stale offset is zero-filled to reach it');
    assert.ok(
      after.toString('latin1').startsWith(before.slice(0, 200)),
      'and the rows written before the operation should still be at the front of it',
    );
    assert.ok(
      !after.toString('latin1').includes('get_project_setting'),
      "the operation's own log should not be in the project's",
    );
    assert.deepEqual(
      readdirSync(join(log, '..')),
      ['godot.log'],
      'and nothing should have been rotated aside',
    );
  } finally {
    restore();
    bench.kill();
    await delay(500);
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }

  // Checked here rather than left to whichever later case the engine happens to warn in. This
  // leaked once, and what reported it was an operation two cases further on writing a warning
  // about a relative path to stderr, which named neither the variable's owner nor this case.
  for (const [name, value] of saved) {
    assert.equal(process.env[name], value, `${name} should be back as it was, unset included`);
  }
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

/**
 * The operations run under the target project's warning levels, all of them, with nothing to hide
 * behind.
 *
 * `--path` puts the operations script under the project's settings even though the file lives in
 * the server's package, and `exclude_addons` cannot cover it: that only reaches `res://addons/`,
 * and this script is not in the project at all. So one project setting `unsafe_call_argument` or
 * `return_value_discarded` to error takes every headless operation with it, which is what happened.
 * The project here holds every warning this engine has at error level and contains nothing else, so
 * what compiles is the shipped operations directory and only that.
 */
function testTheOperationsSurviveEveryWarning(godotPath: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'gdharness-strict-'));
  try {
    writeFileSync(
      join(dir, 'project.godot'),
      [
        '; Engine configuration file.',
        'config_version=5',
        '',
        '[application]',
        'config/name="Strictest"',
        '',
        '[debug]',
        ...everyWarning(godotPath).map((warning) => `gdscript/warnings/${warning}=2`),
        '',
      ].join('\n'),
    );

    const installed = resolve('src/godot/operations/godot_operations.gd');
    const payload = runOperation(godotPath, dir, 'query_class_info', { class_name: 'Node' }, installed);
    assert.equal(get(payload, 'class_name'), 'Node');
    assert.ok(
      asNumber(get(payload, 'methods_count')) > 0,
      'the operation should have answered, not just compiled',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
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

  const projectDir = createProject(godotPath);
  try {
    testTypedGate(godotPath, projectDir);
    runFixture(godotPath, projectDir, 'scene_parse');
    runFixture(godotPath, projectDir, 'operations_serialize');
    runFixture(godotPath, projectDir, 'runtime_serialize');
    runFixture(godotPath, projectDir, 'runtime_input');
    runFixture(godotPath, projectDir, 'runtime_query');
    runFixture(godotPath, projectDir, 'runtime_wait');
    runFixture(godotPath, projectDir, 'runtime_capture');
    // An editor opened before its server has to keep asking. The wait is read back rather than
    // trusted: a client that connected before the fixture started listening would otherwise
    // pass this without ever having been refused.
    const reconnect = runFixture(godotPath, projectDir, 'bridge_reconnect');
    assert.ok(
      asNumber(get(reconnect, 'waited_msec')) >= asNumber(get(reconnect, 'silence_msec')),
      'the client should have been refused before anything answered it',
    );
    // Both arrivals, because the version it announces is only wrong on the second one: the
    // upgrade happens under it between the two.
    assert.equal(asNumber(get(reconnect, 'arrivals')), 2, 'the client should have arrived twice');
    // And it goes where the project says the bridge is, and moves when that changes, which is
    // what stops two projects wanting one port and an abandoned server keeping an editor.
    const follows = runFixture(godotPath, projectDir, 'bridge_follows');
    assert.equal(asNumber(get(follows, 'arrivals')), 2, 'the client should have greeted both servers');
    // And an announcement that does not answer is set aside rather than waited on for good.
    runFixture(godotPath, projectDir, 'bridge_leftover');
    // The game announces itself under the engine's temporary directory and the server looks
    // under Bun's; a platform where the two differ is one where no game is ever found. Both go
    // through the filesystem's own spelling, because Windows hands one side the 8.3 short name
    // and the other the long one for the same directory.
    const clients = runFixture(godotPath, projectDir, 'runtime_clients');
    assert.equal(
      realpathSync.native(asString(get(clients, 'temp_dir'))),
      realpathSync.native(tmpdir()),
      'the engine and the server should agree on the temporary directory',
    );
    runFixture(godotPath, projectDir, 'input_action');
    testDependencyWalk(godotPath, projectDir);
    testOperations(godotPath, projectDir);
    testAGdignoreStopsTheWalk(godotPath, projectDir);
    await testAnOperationLeavesARunningLogAlone(godotPath);
    testRefusals(godotPath, projectDir);
    testInstalledLayout(godotPath, projectDir);
    testTheOperationsSurviveEveryWarning(godotPath);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }

  console.log('engine gdscript tests passed');
}

await main();
