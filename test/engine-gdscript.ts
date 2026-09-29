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
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runOperation as runThroughTheServersOwnPath } from '../src/headless.js';
import { userDataIn } from '../src/launch.js';
import { TOOL_SPECS } from '../src/tool-definitions.js';
import { asArray, asNumber, asObject, asString, get, lastJsonLine } from './support/json.js';
import { solidPng } from './support/png.js';
import { sweep } from './support/sweep.js';

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
  return ['operations', 'addons'].flatMap((root) => scriptsUnder(join('src', 'godot', root), root));
}

/** Every fixture script, as the engine will see it once the typed gate copies them to res://fixtures. */
function fixtureScripts(): string[] {
  return scriptsUnder(join('test', 'support', 'gd'), 'fixtures');
}

function scriptsUnder(directory: string, root: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.gd'))
    .map((entry) => `res://${root}/${entry.replaceAll('\\', '/')}`);
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
    //
    // The count the pinned engine holds rather than a comfortable minimum below it. The floor was
    // 40 against a real 49, which is an anchor against the query breaking altogether and no guard
    // at all against it quietly returning eight fewer, and eight fewer is a project built laxer
    // than the one this gate is named for. `scripts/install-godot.ts` pins 4.7.2-stable here and
    // in CI, so this moving means the engine moved: raise it in the same change as the pin and
    // read what arrived, because a warning the engine added is one nothing has been compiled under.
    assert.ok(
      names.length >= 49,
      `the engine should have named every warning it takes a level for: ${names.length}\n${said}`,
    );
    // And the two this gate was built for are named, because a count alone still passes while the
    // filtering above quietly drops them, which is the gate going quiet about the one thing it
    // exists to catch.
    for (const wanted of ['unsafe_call_argument', 'return_value_discarded']) {
      assert.ok(names.includes(wanted), `the derived warnings should include ${wanted}: ${said}`);
    }
    return names;
  } finally {
    sweep(dir);
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
function assertNoEngineErrors(label: string, output: string, expected: readonly RegExp[] = []): void {
  const errors = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(USER )?(SCRIPT ERROR|ERROR|WARNING):/.test(line));
  const unexpected = errors.filter((line) => !expected.some((pattern) => pattern.test(line)));
  assert.equal(unexpected.length, 0, `${label} hit engine errors or warnings:\n${unexpected.join('\n')}`);
  // An error the fixture provokes on purpose is part of what it checks, so one that stops appearing
  // means the check stopped reaching the engine rather than that the engine improved.
  for (const pattern of expected) {
    assert.ok(
      errors.some((line) => pattern.test(line)),
      `${label} should have made the engine report ${pattern}:\n${errors.join('\n')}`,
    );
  }
}

/**
 * The engine errors a fixture provokes on purpose, by fixture. Each has to appear, and nothing else
 * may. Here rather than at the call, so running one fixture by name expects what the leg expects.
 */
const PROVOKED: Readonly<Record<string, readonly RegExp[]>> = {
  // The call refused for its argument and the method reporting on its way through, both of which
  // the fixture asserts reach the answer, and the typed list and map built with an element of another
  // script to show the container coming back shorter is caught.
  runtime_change: [
    /^ERROR: Error calling method from 'callv': 'Node::take': Cannot convert argument 1 from Object to Object\.$/,
    /^ERROR: noisy said so$/,
    /^ERROR: Attempted to assign an object into a TypedArray, that does not inherit from 'GDScript'\.$/,
    /^ERROR: Unable to convert array index 0 from "Object" to "Object"\.$/,
    /^ERROR: Attempted to assign an object into a TypedDictionary\.Value, that does not inherit from 'GDScript'\.$/,
    /^ERROR: Unable to convert value at key "a" from "Object" to "Object"\.$/,
  ],
  // The parse error the refused reload is refused for.
  reload_script: [/^SCRIPT ERROR: Parse Error: Expected parameter name\.$/],
};

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
  assertNoEngineErrors(name, output, PROVOKED[name]);
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
  const fixtures = fixtureScripts();
  assert.ok(shipped.length >= 48, `the package ships GDScript: ${shipped.length} files`);
  assert.ok(fixtures.length >= 20, `the fixtures are GDScript: ${fixtures.length} files`);
  // The fixtures run under these settings on the engine leg and nowhere else, so a fixture that
  // discarded a return value passed every local check and failed there.
  const fixturesDir = join(projectDir, 'fixtures');
  cpSync(join('test', 'support', 'gd'), fixturesDir, { recursive: true });
  try {
    assert.equal(
      get(runFixture(godotPath, projectDir, 'typed'), 'checked'),
      shipped.length + fixtures.length,
      `every shipped script and fixture should be parsed: ${[...shipped, ...fixtures].join(', ')}`,
    );
  } finally {
    sweep(fixturesDir);
  }

  const probeDir = join(projectDir, 'addons', 'probe');
  mkdirSync(probeDir, { recursive: true });
  writeFileSync(join(probeDir, 'untyped.gd'), 'extends Node\n\nvar loose = 1\n');
  const refused = runScript(godotPath, projectDir, join(projectDir, 'typed.gd'));
  sweep(probeDir);

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

  const payload = runOperation(godotPath, projectDir, 'get_dependencies', {
    resource_path: 'res://chain/top.gd',
    depth: 5,
  });

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
  const cyclicPayload = runOperation(godotPath, projectDir, 'get_dependencies', {
    resource_path: 'res://chain/ouro.gd',
  });
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
  let shipping: unknown;
  try {
    shipping = runOperation(godotPath, projectDir, 'get_dependencies', {
      resource_path: 'res://chain/shipping.gd',
      depth: 3,
    });
  } finally {
    rmSync(join(projectDir, 'chain', 'shipping.gd'));
  }
  const shippingDeps = asArray(get(shipping, 'dependencies', 'res://chain/shipping.gd')).map((dep) =>
    get(dep, 'path'),
  );
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
  const run = runOperationScript(godotPath, projectDir, operation, params, scriptPath);
  const output = `${run.stdout}\n${run.stderr}`;

  if (run.status !== 0) {
    throw new Error(`${operation} failed (${run.status ?? run.signal}):\n${output.trim()}`);
  }
  // Anything on stderr from an operation that succeeded is the engine complaining about
  // something the operation did, a leaked object or a resource still in use at exit included,
  // and the server hands every such line on to the caller. So an operation that passes here is
  // one that answers cleanly.
  assert.equal(run.stderr.trim(), '', `${operation} succeeded but wrote to stderr:\n${run.stderr.trim()}`);
  assert.ok(run.answer !== null, `${operation} wrote no answer:\n${output.trim()}`);
  return run.answer;
}

interface OperationRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** What the operation wrote to its answer file, or null when it wrote none. */
  answer: unknown;
}

/**
 * One operation run the way the server runs it, whatever it answers.
 *
 * `scriptPath` defaults to the copy inside the project. The server runs the one in its own
 * package instead, from outside the project entirely, which is what testInstalledLayout passes.
 */
function runOperationScript(
  godotPath: string,
  projectDir: string,
  operation: string,
  params: unknown,
  scriptPath?: string,
): OperationRun {
  const paramsPath = join(projectDir, 'operation-params.json');
  const answerPath = join(projectDir, 'operation-answer.json');
  writeFileSync(paramsPath, JSON.stringify(params));
  rmSync(answerPath, { force: true });

  const script = scriptPath ?? join(projectDir, 'operations', 'godot_operations.gd');
  const run = runScript(godotPath, projectDir, script, [operation, `@file:${paramsPath}`, answerPath]);
  const answer = existsSync(answerPath) ? (JSON.parse(readFileSync(answerPath, 'utf8')) as unknown) : null;
  rmSync(answerPath, { force: true });
  return { status: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr, answer };
}

/** The exit status, output and answer of an operation that is expected to refuse. */
function runRefusedOperation(
  godotPath: string,
  projectDir: string,
  operation: string,
  params: unknown,
): OperationRun {
  return runOperationScript(godotPath, projectDir, operation, params);
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
  assert.deepEqual(
    [get(created, 'class_name'), get(created, 'extends')],
    ['FixtureHero', 'Node2D'],
    'the class and base are read off the script the engine parsed',
  );
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
  assert.equal(get(broken.answer, 'parses'), false, 'a script the engine refuses is reported as not parsing');
  assert.match(broken.stderr, /loose/, 'the reason is on stderr, where the server reads it from');
  // Gone again before the resave below walks the project, which would trip over it.
  rmSync(join(projectDir, 'made', 'broken.gd'));

  // Content is the whole file: written as sent, header and all, and read back from what was parsed.
  const whole = 'class_name FixtureWhole\nextends Sprite2D\n\n\nfunc _ready() -> void:\n\tpass\n';
  const wrote = operation('create_script', { script_path: 'made/whole.gd', content: whole });
  assert.equal(readFileSync(join(projectDir, 'made', 'whole.gd'), 'utf8'), whole, 'the file is the content');
  assert.deepEqual(
    [get(wrote, 'parses'), get(wrote, 'class_name'), get(wrote, 'extends')],
    [true, 'FixtureWhole', 'Sprite2D'],
    `and the answer is what the engine read in it: ${JSON.stringify(wrote)}`,
  );
  rmSync(join(projectDir, 'made', 'whole.gd'));
  const doubled = runRefusedOperation(godotPath, projectDir, 'create_script', {
    script_path: 'made/doubled.gd',
    extends: 'Node2D',
    content: whole,
  });
  assert.equal(doubled.answer, null, 'content with a header argument beside it is refused');
  assert.match(
    doubled.stderr,
    /content is the whole file, so extends cannot be given with it/,
    doubled.stderr,
  );
  assert.ok(!existsSync(join(projectDir, 'made', 'doubled.gd')), 'and nothing is written');

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
  assert.equal(get(modified, 'parses'), true, 'and what they made parses under every warning');
  // Each line answered is where the declaration is in the file written.
  const onTheirLines = (answer: unknown): void => {
    const written = readFileSync(join(projectDir, 'made', 'hero.gd'), 'utf8').split('\n');
    const keywords: Record<string, string> = {
      add_function: 'func',
      add_variable: 'var',
      add_signal: 'signal',
    };
    for (const applied of asArray(get(answer, 'modifications_applied'))) {
      assert.match(
        written[asNumber(get(applied, 'line')) - 1] ?? '',
        new RegExp(
          `^${keywords[asString(get(applied, 'type'))] ?? '?'} ${asString(get(applied, 'name'))}\\b`,
        ),
        `${JSON.stringify(applied)} should name the line its declaration is on`,
      );
    }
  };
  onTheirLines(modified);
  // The function first and the others above it after, so a number taken at the moment of placing
  // is two short for the function, and the variable moves when the signal goes in above it.
  onTheirLines(
    operation('modify_script', {
      script_path: 'made/hero.gd',
      modifications: [
        { type: 'add_function', name: 'placed_first', body: 'placed_third.emit()' },
        { type: 'add_variable', name: 'placed_second', varType: 'int' },
        { type: 'add_signal', name: 'placed_third' },
      ],
    }),
  );
  const modifiedSource = readFileSync(join(projectDir, 'made', 'hero.gd'), 'utf8');

  // One addition that cannot be made refuses the call, and the file is left as it was.
  const refused = runRefusedOperation(godotPath, projectDir, 'modify_script', {
    script_path: 'made/hero.gd',
    modifications: [
      { type: 'add_variable', name: 'fine', varType: 'int' },
      { type: 'add_variable', name: '' },
      { type: 'add_signal', name: 'not a name' },
    ],
  });
  assert.equal(refused.answer, null, 'a call with an addition it cannot make answers nothing');
  assert.match(
    refused.stderr,
    /Nothing was changed: modification 2 has no name; modification 3 is named 'not a name', which GDScript does not accept as a name/,
    refused.stderr,
  );
  assert.equal(
    readFileSync(join(projectDir, 'made', 'hero.gd'), 'utf8'),
    modifiedSource,
    'and nothing is written',
  );
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
  assert.deepEqual(
    [get(hero, 'enabled'), get(hero, 'global'), get(hero, 'file_exists')],
    [true, true, true],
    'the leading asterisk makes the name global',
  );
  // Without the asterisk it still loads, which is why it is listed as enabled and not global.
  const quiet = operation('add_autoload', { name: 'Quiet', path: 'made/hero.gd', global: false });
  assert.deepEqual([get(quiet, 'enabled'), get(quiet, 'global')], [true, false], JSON.stringify(quiet));
  assert.match(
    readFileSync(projectFile, 'utf8'),
    /^Quiet="res:\/\/made\/hero\.gd"$/m,
    'written with no asterisk',
  );
  const listedQuiet = named(get(operation('list_autoloads', {}), 'autoloads'), 'Quiet');
  assert.deepEqual([get(listedQuiet, 'enabled'), get(listedQuiet, 'global')], [true, false]);
  assert.equal(get(operation('remove_autoload', { name: 'Quiet' }), 'removed'), true);
  const disabled = runRefusedOperation(godotPath, projectDir, 'add_autoload', {
    name: 'Off',
    path: 'made/hero.gd',
    enabled: false,
  });
  assert.equal(disabled.answer, null, 'an autoload cannot be added disabled, since it would load anyway');
  assert.match(disabled.stderr, /global: false keeps its name out of the global scope/, disabled.stderr);
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

  // An option holding an engine type is read tagged and written back as that type. Straight into
  // JSON it came back as the text "(1, 2, 3)", and writing that back put a string in the sidecar.
  const sidecarFile = join(projectDir, 'art.png.import');
  writeFileSync(
    sidecarFile,
    readFileSync(sidecarFile, 'utf8').replace('[params]\n', '[params]\n\nextent=Vector3(1, 2, 3)\n'),
  );
  const extent = get(operation('get_import_options', { resource_path: 'art.png' }), 'params', 'extent');
  assert.deepEqual(extent, { _type: 'Vector3', x: 1, y: 2, z: 3 }, JSON.stringify(extent));
  operation('set_import_options', {
    resource_path: 'art.png',
    options: { extent: { ...(extent as object), z: 6 } },
  });
  assert.match(readFileSync(sidecarFile, 'utf8'), /^extent=Vector3\(1, 2, 6\)$/m, 'written back as a vector');
  const kept = readFileSync(sidecarFile, 'utf8');
  const wrong = runRefusedOperation(godotPath, projectDir, 'set_import_options', {
    resource_path: 'art.png',
    options: { extent: '(4, 5, 6)', 'compress/mode': 2.5 },
  });
  assert.equal(wrong.answer, null, 'an option given something it cannot hold is refused');
  assert.match(
    wrong.stderr,
    /Nothing was written: extent holds a Vector3, and "\(4, 5, 6\)" is not one; compress\/mode holds an int, and 2\.5 is not one/,
    wrong.stderr,
  );
  assert.equal(readFileSync(sidecarFile, 'utf8'), kept, 'and the sidecar is left as it was');
  // A sidecar whose source has gone takes options nothing will ever apply.
  writeFileSync(
    join(projectDir, 'gone.png.import'),
    '[remap]\n\nimporter="texture"\n\n[params]\n\ncompress/mode=0\n',
  );
  const orphan = runRefusedOperation(godotPath, projectDir, 'set_import_options', {
    resource_path: 'gone.png',
    options: { 'compress/mode': 1 },
  });
  rmSync(join(projectDir, 'gone.png.import'));
  assert.equal(orphan.answer, null, 'options for a source that is gone are refused');
  assert.match(
    orphan.stderr,
    /res:\/\/gone\.png is not on disk, so there is nothing its import options apply to/,
  );

  assert.equal(
    get(operation('get_import_status', { resource_path: 'art.png' }), 'resources', 0, 'status'),
    // A sidecar the engine never wrote has no uid and no recorded hash, and the editor imports it.
    'needs_reimport',
  );

  // A file with no sidecar has not been imported only if the engine imports that kind of file.
  // A scene was answered as needing an import, and asking for its options as not imported yet.
  const statusOf = (path: string): unknown[] => {
    const one = get(operation('get_import_status', { resource_path: path }), 'resources', 0);
    return [get(one, 'status'), get(one, 'reason')];
  };
  assert.deepEqual(statusOf('fixture_scene.tscn'), [
    'not_imported',
    'the engine loads .tscn files as they are, without importing them',
  ]);
  mkdirSync(join(projectDir, 'kept_out'), { recursive: true });
  writeFileSync(join(projectDir, 'kept_out', '.gdignore'), '');
  writeFileSync(join(projectDir, 'kept_out', 'raw.png'), '');
  writeFileSync(join(projectDir, 'fresh.png'), '');
  writeFileSync(join(projectDir, 'model.blend'), '');
  try {
    assert.deepEqual(statusOf('kept_out/raw.png'), [
      'not_imported',
      'a .gdignore in res://kept_out keeps the engine from importing anything under it',
    ]);
    assert.deepEqual(statusOf('fresh.png'), ['needs_reimport', 'it has not been imported']);
    assert.match(
      String(statusOf('model.blend')[1]),
      /^no importer built into the engine takes \.blend files/,
    );
  } finally {
    rmSync(join(projectDir, 'kept_out'), { recursive: true, force: true });
    rmSync(join(projectDir, 'fresh.png'), { force: true });
    rmSync(join(projectDir, 'model.blend'), { force: true });
  }
  const sceneOptions = runRefusedOperation(godotPath, projectDir, 'get_import_options', {
    resource_path: 'fixture_scene.tscn',
  });
  assert.equal(sceneOptions.answer, null);
  assert.match(
    sceneOptions.stderr,
    /res:\/\/fixture_scene\.tscn has no import options: the engine loads \.tscn files as they are/,
    sceneOptions.stderr,
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
  // A category passes when it found nothing, and what it found is listed as an issue: every one said
  // passed beside its own failures, and issues was always empty.
  for (const [category, check] of Object.entries(asObject(get(health, 'checks')))) {
    const details = asArray(get(check, 'details'));
    assert.equal(get(check, 'passed'), details.length === 0, `${category}: ${JSON.stringify(check)}`);
    for (const detail of details) {
      assert.ok(
        asArray(get(health, 'issues')).some(
          (issue) => get(issue, 'check') === category && get(issue, 'detail') === detail,
        ),
        `${category}'s ${JSON.stringify(detail)} should be an issue: ${JSON.stringify(get(health, 'issues'))}`,
      );
    }
  }

  // A main scene named by a UID nothing resolves is said to be that, not a file that does not exist.
  operation('set_project_setting', { setting: 'application/run/main_scene', value: 'uid://b0gusb0gusb0g' });
  try {
    const unresolved = operation('get_project_health', { categories: ['config'] });
    assert.equal(get(unresolved, 'checks', 'config', 'passed'), false, JSON.stringify(unresolved));
    assert.ok(
      asArray(get(unresolved, 'checks', 'config', 'details')).includes(
        "Main scene uid://b0gusb0gusb0g does not resolve: no file in the project's uid cache has it, so the file has gone or the project has not been imported yet (project_import refresh_uids imports it)",
      ),
      JSON.stringify(unresolved),
    );
  } finally {
    operation('set_project_setting', {
      setting: 'application/run/main_scene',
      value: 'res://fixture_scene.tscn',
    });
  }

  // A preset asked about is looked for, rather than logged and passed over.
  const presetless = operation('validate_project', { preset: 'Nope' });
  assert.equal(get(presetless, 'valid'), false, JSON.stringify(presetless));
  assert.ok(asArray(get(presetless, 'checks_performed')).includes('export_preset'));
  assert.ok(
    asArray(get(presetless, 'issues')).some(
      (issue) => get(issue, 'message') === 'No export preset is named Nope: the project has none',
    ),
    JSON.stringify(presetless),
  );

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

  // Another language's classes are kept while their files are there: the rebuild reads GDScript
  // only and writes the list whole, so a C# project's global classes were dropped and called removed.
  const cacheFile = join(projectDir, '.godot', 'global_script_class_cache.cfg');
  const csharp = (name: string, path: string): string =>
    `{\n"base": &"Node",\n"class": &"${name}",\n"icon": "",\n"is_abstract": false,\n"is_tool": false,\n"language": &"C#",\n"path": "${path}"\n}`;
  writeFileSync(join(projectDir, 'made', 'Foe.cs'), 'public partial class Foe : Godot.Node {}\n');
  writeFileSync(
    cacheFile,
    `list=[${csharp('Foe', 'res://made/Foe.cs')}, ${csharp('Lost', 'res://made/Lost.cs')}]\n`,
  );
  try {
    const kept = operation('refresh_class_cache', {});
    assert.deepEqual(get(kept, 'carried'), ['Foe'], JSON.stringify(kept));
    assert.deepEqual(get(kept, 'removed'), ['Lost'], 'one whose file has gone is dropped');
    assert.match(
      readFileSync(cacheFile, 'utf8'),
      /"class": &"Foe"[\s\S]*"language": &"C#"/,
      'and the kept one is in the file',
    );
  } finally {
    rmSync(join(projectDir, 'made', 'Foe.cs'));
    assert.equal(
      get(operation('refresh_class_cache', {}), 'carried'),
      undefined,
      'and gone again with its file',
    );
  }

  // A script the engine has never imported has no .uid beside it, and the answer says which of the
  // two it is rather than returning an empty string for both. This used to sit next to a call to
  // resave_resources, which walked the project writing every scene and script back: the assertion
  // here recorded that the resave minted no UID, while the assertion above it took that same
  // operation's `scripts_resaved` count as correct. Both were true about the engine and the pair
  // was still wrong, because nothing asked what a caller reads `scripts_resaved: 1` as meaning.
  const absent = operation('get_uid', { resource_path: 'made/hero.gd' });
  assert.equal(get(absent, 'exists'), false);
  assert.equal(get(absent, 'file'), 'res://made/hero.gd');
  assert.match(
    String(get(absent, 'message')),
    /refresh_uids/,
    'and it names the op that makes one, since that is the next thing the caller wants',
  );
  // Every other kind keeps its UID somewhere else, and refresh_uids makes none of them: a scene in its
  // header and an imported file in its import file. All were answered as having no .uid, with
  // refresh_uids named as what would make one.
  writeFileSync(
    join(projectDir, 'uid_scene.tscn'),
    '[gd_scene format=3 uid="uid://c4c550daekhi1"]\n\n[node name="S" type="Node"]\n',
  );
  writeFileSync(join(projectDir, 'bare_scene.tscn'), '[gd_scene format=3]\n\n[node name="B" type="Node"]\n');
  writeFileSync(join(projectDir, 'uid_art.png'), solidPng(10, 10, 10));
  writeFileSync(
    join(projectDir, 'uid_art.png.import'),
    '[remap]\n\nimporter="texture"\nuid="uid://bsrmp7ti1112c"\n',
  );
  writeFileSync(join(projectDir, 'raw_art.png'), solidPng(10, 10, 10));
  try {
    const uidOf = (path: string): unknown[] => {
      const answer = operation('get_uid', { resource_path: path });
      return [
        get(answer, 'exists'),
        get(answer, 'uid') ?? null,
        get(answer, 'from') ?? get(answer, 'message'),
      ];
    };
    assert.deepEqual(uidOf('uid_scene.tscn'), [true, 'uid://c4c550daekhi1', "the file's header"]);
    assert.deepEqual(uidOf('uid_art.png'), [true, 'uid://bsrmp7ti1112c', 'res://uid_art.png.import']);
    assert.deepEqual(uidOf('bare_scene.tscn'), [
      false,
      null,
      'Its header carries no uid. The editor writes one when it saves the file; refresh_uids does not, and a headless save does not either.',
    ]);
    assert.deepEqual(uidOf('raw_art.png'), [
      false,
      null,
      'It has not been imported, and the import is what gives it a UID: project_import reimport imports it.',
    ]);
  } finally {
    for (const file of [
      'uid_scene.tscn',
      'bare_scene.tscn',
      'uid_art.png',
      'uid_art.png.import',
      'raw_art.png',
    ]) {
      rmSync(join(projectDir, file), { force: true });
    }
  }

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

  // A plugin one folder down is a plugin to the editor, which loads it from the path in the list.
  // Read through a pattern for one folder, it was never listed, and enabling any other plugin wrote
  // the list back without it.
  const nested = join(projectDir, 'addons', 'pack', 'sub');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'plugin.cfg'), '[plugin]\n\nname="Nested"\nscript="nested.gd"\n');
  try {
    assert.equal(get(operation('enable_plugin', { plugin_name: 'pack/sub' }), 'action'), 'enabled');
    const another = operation('enable_plugin', { plugin_name: 'gdharness_editor' });
    assert.deepEqual(
      get(another, 'enabled_plugins'),
      ['pack/sub', 'gdharness_editor'],
      `enabling another keeps the nested one: ${JSON.stringify(another)}`,
    );
    const both = operation('list_plugins', {});
    assert.deepEqual(
      [get(named(get(both, 'plugins'), 'pack/sub'), 'enabled'), get(both, 'enabled_count')],
      [true, 2],
      `and it is listed, enabled: ${JSON.stringify(both)}`,
    );
    assert.equal(get(both, 'enabled_but_missing'), undefined, 'every enabled plugin is there');
    // An entry whose folder has gone is one the editor fails to load at every start.
    rmSync(join(projectDir, 'addons', 'pack'), { recursive: true, force: true });
    const gone = operation('list_plugins', {});
    assert.deepEqual(
      get(gone, 'enabled_but_missing'),
      ['res://addons/pack/sub/plugin.cfg'],
      `an enabled plugin with no plugin.cfg is named: ${JSON.stringify(gone)}`,
    );
    operation('disable_plugin', { plugin_name: 'gdharness_editor' });
    operation('disable_plugin', { plugin_name: 'pack/sub' });
    assert.equal(readFileSync(projectFile, 'utf8'), beforePlugin, 'and both come out again');
  } finally {
    rmSync(join(projectDir, 'addons', 'pack'), { recursive: true, force: true });
  }

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
  // A second bus sending to Master goes in right after it, ahead of the first. Taking the last index
  // as the new one renamed the first bus and answered with it.
  const second = operation('create_audio_bus', { bus_name: 'Second' });
  const layoutNames = (answer: unknown): unknown[] =>
    asArray(get(answer, 'buses')).map((bus) => [get(bus, 'index'), get(bus, 'name'), get(bus, 'send')]);
  assert.deepEqual(
    [get(second, 'bus', 'index'), get(second, 'bus', 'name'), get(second, 'bus', 'send')],
    [1, 'Second', 'Master'],
    `the new bus is where it went: ${JSON.stringify(second)}`,
  );
  assert.deepEqual(
    layoutNames(operation('get_audio_buses', {})),
    [
      [0, 'Master', ''],
      [1, 'Second', 'Master'],
      [2, 'Fixture', 'Master'],
    ],
    'and the bus that was there keeps its name, one further along',
  );
  const twice = runRefusedOperation(godotPath, projectDir, 'create_audio_bus', { bus_name: 'Fixture' });
  assert.equal(twice.answer, null, 'a name a bus already has is refused');
  assert.match(twice.stderr, /A bus named Fixture already exists, at index 2/, twice.stderr);

  // Set means the slot holds this effect afterwards: added at the end, replaced where one is.
  const effects = (answer: unknown): unknown[] =>
    asArray(get(answer, 'bus', 'effects')).map((effect) => get(effect, 'type'));
  const reverb = operation('set_audio_bus_effect', {
    bus_index: 2,
    effect_index: 0,
    effect_type: 'AudioEffectReverb',
  });
  assert.deepEqual(effects(reverb), ['AudioEffectReverb'], `no padding: ${JSON.stringify(reverb)}`);
  const chorus = operation('set_audio_bus_effect', { bus_index: 2, effect_index: 0, effect_type: 'Chorus' });
  assert.deepEqual(
    [effects(chorus), get(chorus, 'replaced'), get(chorus, 'effect_type')],
    [['AudioEffectChorus'], 'AudioEffectReverb', 'AudioEffectChorus'],
    `the effect in the slot is replaced, not pushed along: ${JSON.stringify(chorus)}`,
  );
  const beyond = runRefusedOperation(godotPath, projectDir, 'set_audio_bus_effect', {
    bus_index: 2,
    effect_index: 3,
    effect_type: 'Reverb',
  });
  assert.equal(beyond.answer, null, 'a slot past the one after the last is refused');
  assert.match(
    beyond.stderr,
    /Bus 2 has 1 effect, so effect_index can be 0 to 1, where 1 adds one after the last/,
    beyond.stderr,
  );

  // ClassDB, which is the one source of answers that does not touch the project at all.
  const classes = operation('query_classes', { filter: 'camera', category: 'node' });
  assert.ok(asArray(get(classes, 'classes')).includes('Camera2D'));
  assert.ok(
    asNumber(get(classes, 'filtered_count')) < asNumber(get(classes, 'total_classes')),
    'the filter should exclude something',
  );

  // Every category the schema offers is one the operation knows. The schema offered physics3d and
  // ui, which were refused, and physics answered the 3D bodies alone.
  const offered = asArray(
    get(
      TOOL_SPECS.find((spec) => spec.name === 'editor_classes'),
      'parameters',
      'category',
      'enum',
    ),
  ).map((one) => String(one));
  assert.ok(offered.length >= 12, `the schema's categories: ${offered.join(', ')}`);
  for (const category of offered) {
    const found = operation('query_classes', { category });
    assert.ok(
      asNumber(get(found, 'filtered_count')) > 0,
      `${category} answers classes: ${JSON.stringify(found)}`,
    );
  }
  const bodies = asArray(get(operation('query_classes', { category: 'physics' }), 'classes'));
  assert.ok(
    bodies.includes('CharacterBody2D') && bodies.includes('CharacterBody3D'),
    `physics is both families: ${bodies.join(', ')}`,
  );
  const threeD = asArray(get(operation('query_classes', { category: 'physics3d' }), 'classes'));
  assert.ok(
    threeD.includes('CharacterBody3D') && !threeD.includes('CharacterBody2D'),
    `physics3d is the 3D bodies: ${threeD.join(', ')}`,
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
/**
 * An import is judged by content: what it built is there, its source is the one it recorded, and a
 * scene depends on every image it names.
 *
 * Status compared file times. That missed the case it was first written for, 64 glTF scenes
 * imported before their textures and so untextured, all read as up to date; and once it compared
 * more times it was wrong the other way: 31 images an installer rewrote byte for byte read as
 * changed, and 33 correct scenes read as built before their textures, because a texture a 3D scene
 * uses is reimported compressed after the scene. Everything here is imported by the engine itself
 * with --import, so the files are the ones the editor writes.
 */
function testAnImportIsJudgedByWhatItWasBuiltFrom(godotPath: string, _projectDir: string): void {
  const dir = createProject(godotPath);
  const operation = (name: string, params: unknown): unknown => runOperation(godotPath, dir, name, params);
  const importAll = (): void => {
    const run = spawnSync(godotPath, ['--headless', '--path', dir, '--import'], {
      encoding: 'utf8',
      timeout: 180_000,
    });
    assert.equal(run.status, 0, `the project should import: ${run.stdout}\n${run.stderr}`);
  };
  const statusOf = (resource: string): unknown =>
    get(operation('get_import_status', { resource_path: resource }), 'resources', 0);
  try {
    mkdirSync(join(dir, 'models', 'tex'), { recursive: true });
    const wall = join(dir, 'models', 'tex', 'wall.png');
    writeFileSync(wall, solidPng(200, 40, 40));
    writeFileSync(join(dir, 'models', 'hut.gltf'), JSON.stringify(triangleUsing('tex/wall.png')));
    // Named before its image exists, so the import builds it without one.
    writeFileSync(join(dir, 'models', 'shack.gltf'), JSON.stringify(triangleUsing('tex/later.png')));
    // Saved materials: one using the image the scenes name, one using another.
    writeFileSync(join(dir, 'models', 'tex', 'stone.png'), solidPng(120, 120, 120));
    mkdirSync(join(dir, 'materials'));
    const material = (image: string): string =>
      `[gd_resource type="StandardMaterial3D" load_steps=2 format=3]\n\n[ext_resource type="Texture2D" path="res://models/tex/${image}" id="1"]\n\n[resource]\nalbedo_texture = ExtResource("1")\n`;
    writeFileSync(join(dir, 'materials', 'trim.tres'), material('wall.png'));
    writeFileSync(join(dir, 'materials', 'stone.tres'), material('stone.png'));
    // Its material set to the saved one by an import option, so the scene uses the image only
    // through the material.
    writeFileSync(join(dir, 'models', 'shed.gltf'), JSON.stringify(triangleUsing('tex/wall.png')));
    writeFileSync(
      join(dir, 'models', 'shed.gltf.import'),
      '[remap]\n\nimporter="scene"\ntype="PackedScene"\n\n[params]\n\n_subresources={\n"materials": {\n"Trim": {\n"use_external/enabled": true,\n"use_external/path": "res://materials/trim.tres"\n}\n}\n}\n',
    );
    // Shaped by a post-import script that swaps its material for one using another image entirely.
    writeFileSync(
      join(dir, 'kit_import.gd'),
      '@tool\nextends EditorScenePostImport\n\n\nfunc _post_import(scene: Node) -> Object:\n\tvar swapped: Material = load("res://materials/stone.tres")\n\tfor found: Node in scene.find_children("*", "MeshInstance3D", true, false):\n\t\tvar mesh: MeshInstance3D = found as MeshInstance3D\n\t\tmesh.mesh.surface_set_material(0, swapped)\n\treturn scene\n',
    );
    writeFileSync(join(dir, 'models', 'kit.gltf'), JSON.stringify(triangleUsing('tex/wall.png')));
    writeFileSync(
      join(dir, 'models', 'kit.gltf.import'),
      '[remap]\n\nimporter="scene"\ntype="PackedScene"\n\n[params]\n\nimport_script/path="res://kit_import.gd"\n',
    );
    // Its mesh saved to a .mesh file, which holds the material and so the image. The importer keys
    // a mesh by the file's name and the mesh's.
    writeFileSync(join(dir, 'models', 'barn.gltf'), JSON.stringify(triangleUsing('tex/wall.png', 'Barn')));
    mkdirSync(join(dir, 'meshes'));
    writeFileSync(
      join(dir, 'models', 'barn.gltf.import'),
      '[remap]\n\nimporter="scene"\ntype="PackedScene"\n\n[params]\n\n_subresources={\n"meshes": {\n"barn_Barn": {\n"save_to_file/enabled": true,\n"save_to_file/path": "res://meshes/barn.mesh"\n}\n}\n}\n',
    );
    // Its material the head of a chain of next passes longer than any cap a walk might set, with
    // the image at the far end.
    const chain = 201;
    mkdirSync(join(dir, 'materials', 'chain'));
    for (let link = 0; link < chain; link++) {
      const last = link === chain - 1;
      const uses = last
        ? 'Texture2D" path="res://models/tex/wall.png'
        : `Material" path="res://materials/chain/${link + 1}.tres`;
      writeFileSync(
        join(dir, 'materials', 'chain', `${link}.tres`),
        `[gd_resource type="StandardMaterial3D" load_steps=2 format=3]\n\n[ext_resource type="${uses}" id="1"]\n\n[resource]\n${last ? 'albedo_texture' : 'next_pass'} = ExtResource("1")\n`,
      );
    }
    writeFileSync(join(dir, 'models', 'yard.gltf'), JSON.stringify(triangleUsing('tex/wall.png')));
    writeFileSync(
      join(dir, 'models', 'yard.gltf.import'),
      '[remap]\n\nimporter="scene"\ntype="PackedScene"\n\n[params]\n\n_subresources={\n"materials": {\n"Trim": {\n"use_external/enabled": true,\n"use_external/path": "res://materials/chain/0.tres"\n}\n}\n}\n',
    );
    // One image for each way an import goes stale, so each is stale for its own reason only.
    const tex = join(dir, 'models', 'tex');
    for (const [name, red] of [
      ['tint', 30],
      ['bare', 60],
      ['rug', 90],
      ['dropped', 150],
      ['plain', 180],
      ['held', 210],
    ] as const) {
      writeFileSync(join(tex, `${name}.png`), solidPng(red, 90, 90));
    }
    writeFileSync(join(tex, 'held.png.import'), '[remap]\n\nimporter="keep"\n');
    writeFileSync(join(tex, 'broken.png'), 'not an image at all');
    importAll();
    assert.ok(existsSync(join(dir, 'meshes', 'barn.mesh')), 'the barn import should save its mesh to a file');
    writeFileSync(join(dir, 'models', 'tex', 'later.png'), solidPng(40, 200, 40));
    importAll();

    const hut = statusOf('models/hut.gltf');
    assert.equal(
      get(hut, 'status'),
      'up_to_date',
      `a scene imported with its texture is current: ${JSON.stringify(hut)}`,
    );
    const shed = statusOf('models/shed.gltf');
    assert.equal(
      get(shed, 'status'),
      'up_to_date',
      `a scene using its image through a saved material is current: ${JSON.stringify(shed)}`,
    );
    const kit = statusOf('models/kit.gltf');
    assert.equal(
      get(kit, 'status'),
      'up_to_date',
      `a scene an import script gave other images is current: ${JSON.stringify(kit)}`,
    );
    const barn = statusOf('models/barn.gltf');
    assert.equal(
      get(barn, 'status'),
      'up_to_date',
      `a scene using its image through a saved mesh is current: ${JSON.stringify(barn)}`,
    );
    const yard = statusOf('models/yard.gltf');
    assert.equal(
      get(yard, 'status'),
      'up_to_date',
      `a scene using its image at the end of a long chain of resources is current: ${JSON.stringify(yard)}`,
    );
    const shack = statusOf('models/shack.gltf');
    assert.equal(
      get(shack, 'status'),
      'needs_reimport',
      `a scene imported before its texture existed was built without it: ${JSON.stringify(shack)}`,
    );
    assert.deepEqual(get(shack, 'imported_without'), ['res://models/tex/later.png'], JSON.stringify(shack));

    // Rewritten byte for byte, which moves the time and not the content.
    const later = Math.floor(Date.now() / 1000) + 60;
    writeFileSync(wall, readFileSync(wall));
    utimesSync(wall, later, later);
    const same = statusOf('models/tex/wall.png');
    assert.equal(
      get(same, 'status'),
      'up_to_date',
      `a source rewritten unchanged is current: ${JSON.stringify(same)}`,
    );
    writeFileSync(wall, solidPng(10, 10, 200));
    const edited = statusOf('models/tex/wall.png');
    assert.equal(
      get(edited, 'status'),
      'needs_reimport',
      `a source that changed is not: ${JSON.stringify(edited)}`,
    );
    assert.match(asString(get(edited, 'reason')), /source changed/, JSON.stringify(edited));

    // A texture otherwise current, so only the missing output can make it stale.
    const imported = asArray(
      get(operation('get_import_options', { resource_path: 'models/tex/later.png' }), 'deps', 'dest_files'),
    );
    const output = asString(imported[0]);
    rmSync(join(dir, output.replace('res://', '')));
    const gone = statusOf('models/tex/later.png');
    assert.equal(
      get(gone, 'status'),
      'needs_reimport',
      `a resource whose output is gone: ${JSON.stringify(gone)}`,
    );
    assert.deepEqual(get(gone, 'missing_outputs'), [output], JSON.stringify(gone));

    const expectStale = (resource: string, status: string, reason: RegExp, what: string): void => {
      const found = statusOf(resource);
      assert.equal(get(found, 'status'), status, `${what}: ${JSON.stringify(found)}`);
      assert.match(asString(get(found, 'reason')), reason, `${what}: ${JSON.stringify(found)}`);
    };
    const held = statusOf('models/tex/held.png');
    assert.equal(get(held, 'status'), 'up_to_date', `a resource kept as it is: ${JSON.stringify(held)}`);
    expectStale('models/tex/broken.png', 'failed', /last import failed/, 'an image that would not import');

    // An option set in the sidecar without a reimport, as set_options does; the editor holds the
    // sidecar's hash from its last import in its filesystem cache.
    const tintSidecar = join(tex, 'tint.png.import');
    const tintText = readFileSync(tintSidecar, 'utf8');
    assert.match(tintText, /compress\/mode=0/, 'the fixture should change an option the sidecar holds');
    writeFileSync(tintSidecar, tintText.replace('compress/mode=0', 'compress/mode=1'));
    expectStale(
      'models/tex/tint.png',
      'needs_reimport',
      /import file changed/,
      'an option set without a reimport',
    );

    // Its output rewritten, with the source and the sidecar as the import left them.
    const rugOutput = asString(
      asArray(
        get(operation('get_import_options', { resource_path: 'models/tex/rug.png' }), 'deps', 'dest_files'),
      )[0],
    );
    const rugFile = join(dir, rugOutput.replace('res://', ''));
    writeFileSync(rugFile, Buffer.concat([readFileSync(rugFile), Buffer.from([0])]));
    expectStale(
      'models/tex/rug.png',
      'needs_reimport',
      /output changed/,
      'an output changed after its import',
    );

    // A sidecar copied beside a copy of its image, naming the image it was written for.
    writeFileSync(join(tex, 'twin.png'), readFileSync(join(tex, 'plain.png')));
    writeFileSync(join(tex, 'twin.png.import'), readFileSync(join(tex, 'plain.png.import')));
    expectStale(
      'models/tex/twin.png',
      'needs_reimport',
      /written for res:\/\/models\/tex\/plain\.png/,
      'a copied sidecar',
    );

    // Its record of the hashes gone, with everything else as the import left it.
    const plainRecord = join(
      dir,
      '.godot',
      'imported',
      `plain.png-${createHash('md5').update('res://models/tex/plain.png').digest('hex')}.md5`,
    );
    assert.ok(existsSync(plainRecord), `the import should record its hashes at ${plainRecord}`);
    rmSync(plainRecord);
    expectStale(
      'models/tex/plain.png',
      'needs_reimport',
      /no hash/,
      'an import with no record of its hashes',
    );

    // Past the cache from here, since a sidecar with no uid is also a sidecar changed since its
    // import, and the editor reads the cache first.
    const cacheDir = join(dir, '.godot', 'editor');
    const caches = readdirSync(cacheDir).filter((name) => name.startsWith('filesystem_cache'));
    assert.ok(
      caches.length > 0,
      `the import should write the editor's filesystem cache: ${readdirSync(cacheDir).join(', ')}`,
    );
    for (const cache of caches) {
      rmSync(join(cacheDir, cache));
    }
    const bareSidecar = join(tex, 'bare.png.import');
    const bareText = readFileSync(bareSidecar, 'utf8');
    assert.match(bareText, /^uid=/m, 'the fixture should remove a uid the sidecar holds');
    writeFileSync(bareSidecar, bareText.replace(/^uid=.*\n/m, ''));
    expectStale('models/tex/bare.png', 'needs_reimport', /no uid/, 'a sidecar without a uid');

    // Walked for as a whole: a sidecar whose source is gone, and a source of a type the first
    // import did not meet.
    rmSync(join(tex, 'dropped.png'));
    writeFileSync(join(tex, 'fresh.bmp'), solidBmp());
    const walked = asArray(get(operation('get_import_status', {}), 'resources'));
    const entry = (path: string): unknown => walked.find((one) => get(one, 'path') === path);
    const dropped = entry('res://models/tex/dropped.png');
    assert.equal(
      get(dropped, 'status'),
      'missing_source',
      `a sidecar left behind: ${JSON.stringify(walked)}`,
    );
    assert.equal(get(dropped, 'import_file_exists'), true, JSON.stringify(dropped));
    const fresh = entry('res://models/tex/fresh.bmp');
    assert.equal(
      get(fresh, 'status'),
      'needs_reimport',
      `a bitmap never imported: ${JSON.stringify(walked)}`,
    );
    const summary = get(operation('get_import_status', {}), 'summary');
    assert.equal(
      get(summary, 'failed'),
      1,
      `the failed import should be counted: ${JSON.stringify(summary)}`,
    );
  } finally {
    sweep(dir);
  }
}

/** A 1 by 1 bitmap, 24 bits a pixel. */
function solidBmp(): Buffer {
  const bytes = Buffer.alloc(58);
  bytes.write('BM', 0, 'ascii');
  bytes.writeUInt32LE(58, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(1, 18);
  bytes.writeInt32LE(1, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(4, 34);
  bytes.writeUInt8(200, 54);
  return bytes;
}

/** A glTF document of one textured triangle whose image is [uri], with its buffer inline. */
function triangleUsing(uri: string, meshName?: string): Record<string, unknown> {
  const data = Buffer.alloc(60);
  const values = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1];
  for (const [index, value] of values.entries()) {
    data.writeFloatLE(value, index * 4);
  }
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        ...(meshName ? { name: meshName } : {}),
        primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }],
      },
    ],
    materials: [{ name: 'Trim', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ uri }],
    buffers: [{ byteLength: 60, uri: `data:application/octet-stream;base64,${data.toString('base64')}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 24 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
    ],
  };
}

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
      { setting: 'debug/gdscript/warnings/unsafe_call_argument' },
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
    sweep(project);
    sweep(home);
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
  assert.equal(missing.answer, null, 'a failed operation should write no answer');

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
/**
 * A whole family of settings is answerable in one call, with the type the engine registers for each.
 *
 * Reading one setting by name cannot answer a question about a family, and the engine is the only
 * thing that knows what a family contains, so the way round it was a script written to walk
 * `get_property_list()` and an engine started to run it. The type is the half that matters: this
 * suite's own gate wrote a level over `renamed_in_godot_4_hint`, which is a bool sitting among the
 * warning levels, and nothing looked wrong because 2 is as true as true is.
 */
function testAFamilyOfSettingsAnswersWithItsTypes(godotPath: string, projectDir: string): void {
  const payload = runOperation(godotPath, projectDir, 'get_project_setting', {
    prefix: 'debug/gdscript/warnings/',
  });
  const settings = asArray(get(payload, 'settings'));
  assert.ok(settings.length > 40, `the family should have been named: ${JSON.stringify(payload)}`);
  assert.equal(asNumber(get(payload, 'count')), settings.length);

  const byName = new Map(
    settings.map((entry) => [asString(get(entry, 'setting')), asString(get(entry, 'type'))]),
  );
  assert.equal(byName.get('debug/gdscript/warnings/unsafe_call_argument'), 'int');
  // The one this exists for: among fifty settings that take a level, it takes a bool.
  assert.equal(byName.get('debug/gdscript/warnings/renamed_in_godot_4_hint'), 'bool');
  assert.equal(byName.get('debug/gdscript/warnings/directory_rules'), 'Dictionary');

  // And a prefix nothing matches is an empty answer rather than an error, because "no settings
  // start with this" is a fact about the project rather than a fault in the call.
  const none = runOperation(godotPath, projectDir, 'get_project_setting', { prefix: 'nothing/starts/here/' });
  assert.equal(asNumber(get(none, 'count')), 0);
}

/**
 * A reverse search finds every way the engine is told to load a file, and nothing that only shares
 * its name.
 *
 * An autoload, the main scene and a plugin's script are named only in project.godot and plugin.cfg,
 * and each was answered as used by nothing, which is the answer a file is deleted on. A relative
 * preload and a scene named by its UID were missed, a node and a string sharing a class's name were
 * counted as uses of it, and the forward walk passed over relative paths and handed a list cut short
 * deep in the walk to a nearer reach of the same file.
 */
function testEveryUseIsFound(godotPath: string): void {
  const dir = createProject(godotPath);
  const operation = (name: string, params: unknown): unknown => runOperation(godotPath, dir, name, params);
  const kinds = (path: string): unknown =>
    get(operation('find_resource_usages', { resource_path: path }), 'summary', 'by_kind');
  try {
    mkdirSync(join(dir, 'auto'));
    writeFileSync(join(dir, 'auto', 'autoload.gd'), 'extends Node\n');
    writeFileSync(
      join(dir, 'main.tscn'),
      '[gd_scene format=3 uid="uid://c4c550daekhi1"]\n\n[node name="Main" type="Node"]\n',
    );
    writeFileSync(
      join(dir, 'project.godot'),
      // An input action sharing a class's name is a key written bare, which only the rule that a
      // class is used by name in code alone keeps from counting.
      `${readFileSync(join(dir, 'project.godot'), 'utf8')}\n[autoload]\n\nAuto="*res://auto/autoload.gd"\n\n[application]\n\nrun/main_scene="uid://c4c550daekhi1"\n\n[input]\n\nEnemy={\n"deadzone": 0.5,\n"events": []\n}\n`,
    );
    mkdirSync(join(dir, 'addons', 'probe'), { recursive: true });
    writeFileSync(
      join(dir, 'addons', 'probe', 'plugin.cfg'),
      '[plugin]\n\nname="Probe"\nscript="plugin.gd"\n',
    );
    writeFileSync(join(dir, 'addons', 'probe', 'plugin.gd'), '@tool\nextends EditorPlugin\n');
    assert.deepEqual(kinds('auto/autoload.gd'), { setting: 1 }, 'an autoload is used by project.godot');
    assert.deepEqual(kinds('main.tscn'), { setting: 1 }, 'and the main scene, named by its UID');
    assert.deepEqual(
      kinds('addons/probe/plugin.gd'),
      { plugin: 1 },
      'and a plugin script, relative to plugin.cfg',
    );

    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'b.gd'), 'extends Node\n');
    writeFileSync(join(dir, 'sub', 'a.gd'), 'extends Node\n\nconst B = preload("b.gd")\n');
    assert.deepEqual(kinds('sub/b.gd'), { preload: 1 }, 'a relative preload names its sibling');
    const forward = asArray(
      get(operation('get_dependencies', { resource_path: 'sub/a.gd' }), 'dependencies', 'res://sub/a.gd'),
    );
    assert.deepEqual(
      forward.map((dep) => get(dep, 'path')),
      ['res://sub/b.gd'],
      'and the forward walk follows it',
    );

    // A class used by name in code, and only there: a node and a string with the same word are not uses.
    writeFileSync(join(dir, 'enemy.gd'), 'class_name Enemy\nextends Node2D\n');
    writeFileSync(
      join(dir, 'spawner.gd'),
      'extends Node\n\nvar held: Enemy\n\n\nfunc say() -> void:\n\tprint("Enemy")  # an Enemy\n',
    );
    writeFileSync(join(dir, 'arena.tscn'), '[gd_scene format=3]\n\n[node name="Enemy" type="Node2D"]\n');
    assert.deepEqual(
      kinds('enemy.gd'),
      { class_name: 1, comment: 1 },
      'the declaration uses it; the string and node do not',
    );

    // Five deep and a shortcut to the middle: at depth three the middle is first reached two down,
    // where its list stops short, and then again one down, where it does not.
    for (const [name, next] of [
      ['a', ['b', 'c']],
      ['b', ['c']],
      ['c', ['d']],
      ['d', ['e']],
      ['e', []],
    ] as const) {
      writeFileSync(
        join(dir, 'sub', `chain_${name}.gd`),
        `extends Node\n\n${next.map((one) => `const ${one.toUpperCase()} = preload("res://sub/chain_${one}.gd")\n`).join('')}`,
      );
    }
    const walked = asArray(
      get(
        operation('get_dependencies', { resource_path: 'sub/chain_a.gd', depth: 3 }),
        'dependencies',
        'res://sub/chain_a.gd',
      ),
    );
    const shortcut = walked.find((dep) => get(dep, 'path') === 'res://sub/chain_c.gd');
    assert.deepEqual(
      asArray(get(shortcut, 'dependencies')).map((dep) => [
        get(dep, 'path'),
        asArray(get(dep, 'dependencies') ?? []).map((one) => get(one, 'path')),
      ]),
      [['res://sub/chain_d.gd', ['res://sub/chain_e.gd']]],
      `one down, the middle has its whole list: ${JSON.stringify(walked)}`,
    );
  } finally {
    sweep(dir);
  }
}

/**
 * A setting is answered with the feature overrides that replace it, since the value under its own
 * name is not the one a Windows build or the editor reads. Measured on 4.7.2: `get_setting` answers
 * the plain value in a headless run, so the answer was right and the one a game showed was elsewhere.
 */
function testASettingSaysWhatReplacesIt(godotPath: string): void {
  const dir = createProject(godotPath);
  try {
    writeFileSync(
      join(dir, 'project.godot'),
      `${readFileSync(join(dir, 'project.godot'), 'utf8')}\n[application]\n\nconfig/description="plain"\nconfig/description.windows="on windows"\nconfig/description.editor="in the editor"\n`,
    );
    const read = runOperation(godotPath, dir, 'get_project_setting', {
      setting: 'application/config/description',
    });
    assert.deepEqual(
      [get(read, 'value'), get(read, 'overrides')],
      ['plain', { windows: 'on windows', editor: 'in the editor' }],
      JSON.stringify(read),
    );
    const bare = runOperation(godotPath, dir, 'get_project_setting', { setting: 'application/config/name' });
    assert.equal(get(bare, 'overrides'), undefined, 'and a setting with none carries none');
  } finally {
    sweep(dir);
  }
}

/**
 * Validation reads at most a hundred scripts, and says so with the count it read and the count there
 * are. It counted the one past the limit before stopping and answered 101.
 */
function testValidationSaysHowMuchItRead(godotPath: string): void {
  const dir = createProject(godotPath);
  try {
    mkdirSync(join(dir, 'many'));
    for (let index = 0; index < 60; index++) {
      writeFileSync(join(dir, 'many', `s${index}.gd`), 'extends Node\n');
    }
    const validated = runOperation(godotPath, dir, 'validate_project', {});
    const total = asNumber(get(validated, 'scripts_total'));
    assert.ok(total > 100, `the project should hold more than the limit: ${total}`);
    assert.equal(get(validated, 'scripts_checked'), 100, JSON.stringify(validated));
  } finally {
    sweep(dir);
  }
}

/**
 * An import is judged stale when the importer would judge it so, before any of its files is looked at.
 *
 * Both states have every file current: an importer that now writes a newer format, which every scene
 * meets after an engine upgrade, and a VRAM texture imported before the project asked for another
 * compression format. Both read as up to date while the editor's next scan imported them. Each is
 * checked against the engine's own verdict: the import pass after the reading has to rebuild it.
 */
function testTheImporterIsAskedFirst(godotPath: string): void {
  const dir = createProject(godotPath);
  const operation = (name: string, params: unknown): unknown => runOperation(godotPath, dir, name, params);
  const statusOf = (resource: string): unknown[] => {
    const one = get(operation('get_import_status', { resource_path: resource }), 'resources', 0);
    return [get(one, 'status'), get(one, 'reason')];
  };
  const importAll = (): void => {
    const run = spawnSync(godotPath, ['--headless', '--path', dir, '--import'], {
      encoding: 'utf8',
      timeout: 180_000,
    });
    assert.equal(run.status, 0, `the project should import: ${run.stdout}\n${run.stderr}`);
  };
  const imported = (name: string): number =>
    Math.max(
      ...readdirSync(join(dir, '.godot', 'imported'))
        .filter((file) => file.startsWith(`${name}-`) && !file.endsWith('.md5'))
        .map((file) => statSync(join(dir, '.godot', 'imported', file)).mtimeMs),
    );
  try {
    writeFileSync(join(dir, 'thing.gltf'), JSON.stringify(triangleUsing('none.png')));
    writeFileSync(join(dir, 'tex.png'), solidPng(40, 160, 40));
    writeFileSync(
      join(dir, 'tex.png.import'),
      '[remap]\n\nimporter="texture"\n\n[params]\n\ncompress/mode=2\n',
    );
    importAll();
    assert.deepEqual(statusOf('thing.gltf')[0], 'up_to_date', 'a fresh import is current');
    assert.deepEqual(statusOf('tex.png')[0], 'up_to_date', 'a fresh import is current');

    // The version this engine writes, read off the sidecar it just wrote, has to be the one judged
    // against, or an engine that raises it leaves every older scene answered as current.
    const sidecarPath = join(dir, 'thing.gltf.import');
    const sidecar = readFileSync(sidecarPath, 'utf8');
    const written = /^importer_version=(\d+)$/m.exec(sidecar)?.[1];
    assert.ok(written !== undefined, `the scene importer writes its version: ${sidecar}`);
    // Older, and with the hash the editor recorded for the sidecar moved to match it, so the version
    // is the only thing that differs from a sidecar the editor wrote.
    const cachePath = join(dir, '.godot', 'editor', 'filesystem_cache10');
    const md5 = (text: string): string => createHash('md5').update(text).digest('hex');
    const older = sidecar.replace(/^importer_version=\d+\n/m, '');
    writeFileSync(sidecarPath, older);
    writeFileSync(cachePath, readFileSync(cachePath, 'utf8').replace(md5(sidecar), md5(older)));
    assert.deepEqual(statusOf('thing.gltf'), [
      'needs_reimport',
      `it was imported at version 0 of the scene importer, and this engine imports at version ${written}`,
    ]);
    const sceneBefore = imported('thing.gltf');
    importAll();
    assert.ok(
      imported('thing.gltf') > sceneBefore,
      'and the engine reimports it, which is the verdict held to',
    );
    assert.deepEqual(statusOf('thing.gltf')[0], 'up_to_date');

    operation('set_project_setting', {
      setting: 'rendering/textures/vram_compression/import_etc2_astc',
      value: true,
    });
    assert.deepEqual(statusOf('tex.png'), [
      'needs_reimport',
      'the project now asks for etc2_astc textures, and this import did not write them',
    ]);
    const textureBefore = imported('tex.png');
    importAll();
    assert.ok(imported('tex.png') > textureBefore, 'and the engine reimports it, in the format asked for');
    assert.deepEqual(statusOf('tex.png')[0], 'up_to_date');

    // Asking for less is not a reason: an import holding a format the project no longer asks for
    // stays, measured as the engine leaving it alone.
    operation('set_project_setting', {
      setting: 'rendering/textures/vram_compression/import_etc2_astc',
      value: false,
    });
    assert.deepEqual(statusOf('tex.png')[0], 'up_to_date');
  } finally {
    sweep(dir);
  }
}

/**
 * The answer is what the operation wrote, whatever the project prints and however the engine ends.
 *
 * Through the server's own path, because the reading is the server's. The project's autoloads run
 * after the operation has answered: one printing a dictionary in `_process` was the last JSON line
 * out and was taken as the answer, and one quitting with a code afterwards turned a write that had
 * happened into a failure a caller would retry. The third project is the operations script faulting
 * part-way, which the engine survives by handing the caller a default value and exiting 0.
 */
async function testTheAnswerIsTheOperations(godotPath: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gdharness-answer-'));
  const operations = mkdtempSync(join(tmpdir(), 'gdharness-faulty-operations-'));
  try {
    writeFileSync(
      join(dir, 'project.godot'),
      [
        'config_version=5',
        '',
        '[application]',
        'config/name="Answered"',
        '',
        '[autoload]',
        'Loud="*res://loud.gd"',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'loud.gd'),
      [
        'extends Node',
        '',
        '',
        'func _ready() -> void:',
        '\tprint({"setting_path": "not the operation", "value": "loud _ready"})',
        '\tif FileAccess.file_exists("res://quit_after"):',
        '\t\tget_tree().quit(3)',
        '',
        '',
        'func _process(_delta: float) -> void:',
        '\tprint({"setting_path": "not the operation", "value": "loud _process"})',
        '',
      ].join('\n'),
    );
    const engine = { godotPath, script: resolve('src/godot/operations/godot_operations.gd'), debug: false };

    const read = await runThroughTheServersOwnPath(
      engine,
      'get_project_setting',
      { setting: 'application/config/name' },
      dir,
    );
    assert.ok(read.ok, `the read should answer: ${read.ok ? '' : read.message}`);
    assert.deepEqual(
      [get(read.payload, 'setting_path'), get(read.payload, 'value'), read.afterAnswer],
      ['application/config/name', 'Answered', undefined],
      `the answer is the operation's, not the autoload's: ${JSON.stringify(read.payload)}`,
    );

    writeFileSync(join(dir, 'quit_after'), '');
    const written = await runThroughTheServersOwnPath(
      engine,
      'set_project_setting',
      { setting: 'application/config/description', value: 'written before the quit' },
      dir,
    );
    assert.ok(written.ok, `a write that happened is answered as one: ${written.ok ? '' : written.message}`);
    assert.match(
      written.afterAnswer ?? '',
      /wrote this answer, and then the engine did not exit cleanly \(exit code 3\)/,
      String(written.afterAnswer),
    );
    assert.match(
      readFileSync(join(dir, 'project.godot'), 'utf8'),
      /^config\/description="written before the quit"$/m,
      'and the write it answered for is on disk',
    );
    rmSync(join(dir, 'quit_after'));

    // One helper made to raise part-way through building the answer, in a copy of the scripts.
    cpSync(resolve('src/godot/operations'), operations, { recursive: true });
    const config = join(operations, 'project_config.gd');
    const source = readFileSync(config, 'utf8');
    const faulted = source.replace('"setting_path": setting_path,', '"setting_path": _faulty(),');
    assert.notEqual(faulted, source, 'the fault should have gone in where the answer is built');
    writeFileSync(
      config,
      `${faulted}\n\nfunc _faulty() -> String:\n\tvar none: Array = []\n\treturn none[1]\n`,
    );
    const partial = await runThroughTheServersOwnPath(
      { ...engine, script: join(operations, 'godot_operations.gd') },
      'get_project_setting',
      { setting: 'application/config/name' },
      dir,
    );
    assert.ok(
      !partial.ok,
      `an answer the script faulted while building is refused: ${JSON.stringify(partial)}`,
    );
    assert.match(
      partial.message,
      /^get_project_setting hit an error in the operations script, so its answer is left out: .*Out of bounds get index '1'.* \(_faulty \(.*project_config\.gd:\d+\)\)$/,
      partial.message,
    );
  } finally {
    sweep(dir);
    sweep(operations);
  }
}

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
    sweep(dir);
  }
}

/** The cases after the fixtures, in the order the leg runs them, by the name `case` takes. */
/**
 * A scene saved binary counts as a scene in the health check.
 *
 * It looked for `.tscn` alone, so a project saving its scenes as `.scn` was told it had none and
 * lost five points for it. The file is taken away again, since it is empty and a later case walking
 * the project's scenes would try to load it.
 */
function testBinaryScenesAreScenes(godotPath: string, projectDir: string): void {
  const counted = (): number =>
    asNumber(
      get(
        runOperation(godotPath, projectDir, 'get_project_health', { categories: ['scenes'] }),
        'checks',
        'scenes',
        'total_scenes',
      ),
    );
  const before = counted();
  const binary = join(projectDir, 'only_binary.scn');
  writeFileSync(binary, '');
  try {
    assert.equal(counted(), before + 1, 'a binary scene is counted as a scene');
  } finally {
    rmSync(binary);
  }
}

const CASES: Readonly<Record<string, (godotPath: string, projectDir: string) => void | Promise<void>>> = {
  dependencyWalk: testDependencyWalk,
  operations: testOperations,
  gdignore: testAGdignoreStopsTheWalk,
  importJudged: testAnImportIsJudgedByWhatItWasBuiltFrom,
  importerFirst: (godotPath) => {
    testTheImporterIsAskedFirst(godotPath);
  },
  validationCounts: (godotPath) => {
    testValidationSaysHowMuchItRead(godotPath);
  },
  everyUse: (godotPath) => {
    testEveryUseIsFound(godotPath);
  },
  overrides: (godotPath) => {
    testASettingSaysWhatReplacesIt(godotPath);
  },
  runningLog: (godotPath) => testAnOperationLeavesARunningLogAlone(godotPath),
  refusals: testRefusals,
  installedLayout: testInstalledLayout,
  settingsFamily: testAFamilyOfSettingsAnswersWithItsTypes,
  everyWarning: (godotPath) => {
    testTheOperationsSurviveEveryWarning(godotPath);
  },
  answer: (godotPath) => testTheAnswerIsTheOperations(godotPath),
  binaryScenes: testBinaryScenesAreScenes,
};

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
  // The gate on its own, in seconds, for after a GDScript edit: gdlint and gdformat pass a script
  // the engine refuses under warnings as errors, and a regression run with an engine loads the
  // addon under the default warnings, so both said yes to an addon that did not compile.
  if (process.argv.includes('typed')) {
    try {
      testTypedGate(godotPath, projectDir);
    } finally {
      sweep(projectDir);
    }
    console.log('typed gate passed');
    return;
  }
  // Cases by name, in the order given, for the same reason as one fixture below. Several, because
  // some read what an earlier one left in the project: operations reads the chain dependencyWalk writes.
  const one = process.argv.indexOf('case');
  if (one !== -1) {
    const names = process.argv.slice(one + 1);
    const unknown = names.filter((name) => CASES[name] === undefined);
    if (names.length === 0 || unknown.length > 0) {
      throw new Error(`case needs names from: ${Object.keys(CASES).join(', ')}`);
    }
    try {
      for (const name of names) {
        await CASES[name]?.(godotPath, projectDir);
      }
    } finally {
      sweep(projectDir);
    }
    console.log(`cases ${names.join(', ')} passed`);
    return;
  }
  // One fixture script by name, for working on the thing it checks without the whole leg.
  const named = process.argv.indexOf('fixture');
  if (named !== -1) {
    const fixture = process.argv[named + 1];
    if (fixture === undefined) {
      throw new Error('fixture needs the name of a script in test/support/gd, without .gd');
    }
    try {
      console.log(JSON.stringify(runFixture(godotPath, projectDir, fixture)));
    } finally {
      sweep(projectDir);
    }
    console.log(`fixture ${fixture} passed`);
    return;
  }
  try {
    testTypedGate(godotPath, projectDir);
    runFixture(godotPath, projectDir, 'scene_parse');
    runFixture(godotPath, projectDir, 'operations_serialize');
    // Identity rather than equality, and both directions: the pattern cache was argued for in the
    // source and held by nothing, so taking it away would have broken no answer and failed no case.
    const cached = runFixture(godotPath, projectDir, 'patterns_cache');
    for (const claim of [
      'same_pattern_is_one_object',
      'different_patterns_are_not',
      'it_still_matches',
      'it_still_refuses',
    ]) {
      assert.equal(get(cached, claim), true, `${claim}: ${JSON.stringify(cached)}`);
    }
    runFixture(godotPath, projectDir, 'runtime_serialize');
    runFixture(godotPath, projectDir, 'runtime_input');
    runFixture(godotPath, projectDir, 'runtime_query');
    runFixture(godotPath, projectDir, 'runtime_change');
    runFixture(godotPath, projectDir, 'reload_script');
    runFixture(godotPath, projectDir, 'runtime_click');
    runFixture(godotPath, projectDir, 'runtime_words');
    runFixture(godotPath, projectDir, 'runtime_wait');
    runFixture(godotPath, projectDir, 'runtime_signal');
    runFixture(godotPath, projectDir, 'runtime_calls');
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
    for (const run of Object.values(CASES)) {
      await run(godotPath, projectDir);
    }
  } finally {
    sweep(projectDir);
  }

  console.log('engine gdscript tests passed');
}

await main();
