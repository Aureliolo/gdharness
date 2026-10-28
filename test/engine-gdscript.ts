/**
 * Drives the GDScript that ships inside the bundle against a real engine.
 *
 * The rest of the suite exercises the TypeScript in front of these scripts. Nothing exercised
 * the scripts themselves, which is where the value serialisers, the project.godot writers and
 * the dependency walk live: code that answers rather than fails when it is wrong, so a silent
 * regression in it reads as a working tool returning a plausible shape.
 */

import assert from 'node:assert/strict';
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
import { declaredClassLines } from '../src/class-cache.js';
import {
  ANSWERED,
  ASIDE,
  BEGUN,
  engineExtras,
  RESUMED,
  runOperation as runThroughTheServersOwnPath,
  WAITING,
} from '../src/headless.js';
import { userDataIn } from '../src/launch.js';
import { type SpawnSyncReturns, spawnHidden, spawnSyncHidden } from '../src/spawn.js';
import { TOOL_SPECS } from '../src/tool-definitions.js';
import { containedEngine } from './support/contained-engine.js';
import { asArray, asNumber, asObject, asString, get, lastJsonLine, text } from './support/json.js';
import { solidPng } from './support/png.js';
import { sweep } from './support/sweep.js';

const tried: string[] = [];

/** True when the binary at this path answers --version, which is the only test that counts. */
function godotRuns(candidate: string): boolean {
  const probe = spawnSyncHidden(candidate, ['--version'], { encoding: 'utf8', timeout: 60000 });
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
  return ['operations', 'addons', 'loader'].flatMap((root) => scriptsUnder(join('src', 'godot', root), root));
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
  // Marked as an install marks them, so what the operations step over as gdharness's own is what
  // they step over in a game: unmarked, the tests addon's suites scene was offered as a scene of
  // the project's.
  for (const addon of readdirSync('src/godot/addons')) {
    writeFileSync(join(dir, 'addons', addon, '.gdharness-version'), '0.0.0\n');
  }
  cpSync('src/godot/operations', join(dir, 'operations'), { recursive: true });
  cpSync('src/godot/loader', join(dir, 'loader'), { recursive: true });

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

/** A script run, with how long the engine took, its start included. */
type ScriptRun = SpawnSyncReturns<string> & { ms: number };

function runScript(
  godotPath: string,
  projectDir: string,
  scriptPath: string,
  extraArgs: string[] = [],
): ScriptRun {
  const began = performance.now();
  const run = spawnSyncHidden(
    godotPath,
    ['--headless', '--path', projectDir, '--script', scriptPath, ...extraArgs],
    {
      encoding: 'utf8',
      timeout: 180000,
    },
  );
  return { ...run, ms: Math.round(performance.now() - began) };
}

/**
 * Why a script run failed. A Windows runner's engine once exited 127 having printed nothing, not
 * even its banner, and the time it ran is what tells an engine that never started from one that
 * stopped partway.
 */
function failedRun(
  name: string,
  run: { status: number | null; signal: string | null; ms: number },
  output: string,
): Error {
  const said = output.trim() === '' ? 'it printed nothing' : output.trim();
  return new Error(`${name} failed (${run.status ?? run.signal}) after ${run.ms} ms:\n${said}`);
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
    /^WARNING: noisy only warned$/,
    /^ERROR: Attempted to assign an object into a TypedArray, that does not inherit from 'GDScript'\.$/,
    /^ERROR: Unable to convert array index 0 from "Object" to "Object"\.$/,
    /^ERROR: Attempted to assign an object into a TypedDictionary\.Value, that does not inherit from 'GDScript'\.$/,
    /^ERROR: Unable to convert value at key "a" from "Object" to "Object"\.$/,
    // A setter's own reports, which the write's answer carries.
    /^ERROR: health cannot go below zero$/,
    /^WARNING: level is high$/,
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
    throw failedRun(name, run, output);
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
  assert.ok(shipped.length >= 101, `the package ships GDScript: ${shipped.length} files`);
  assert.ok(fixtures.length >= 36, `the fixtures are GDScript: ${fixtures.length} files`);
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
  testTypedRunner(godotPath);
}

/**
 * The gdUnit4 runner the package ships, parsed under the same warnings.
 *
 * Apart from the project above because it extends gdUnit4's classes, so it compiles only beside
 * gdUnit4, and gdUnit4's own scripts do not pass every warning: they sit under res://addons, which
 * the engine exempts unless told otherwise, as it is not told here. The runner is loaded from its
 * own path outside the project, as the games start it, where no exemption reaches it.
 */
function testTypedRunner(godotPath: string): void {
  const gdunit = process.env['GDUNIT4_PATH'];
  if (!gdunit || !existsSync(join(gdunit, 'bin', 'GdUnitCmdTool.gd'))) {
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and GDUNIT4_PATH names no gdUnit4.');
    }
    console.log('typed runner check skipped (GDUNIT4_PATH names no gdUnit4)');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'gdharness-typed-runner-'));
  try {
    cpSync(gdunit, join(dir, 'addons', 'gdUnit4'), { recursive: true });
    writeFileSync(
      join(dir, 'project.godot'),
      [
        '; Engine configuration file.',
        'config_version=5',
        '',
        '[application]',
        'config/name="GdharnessTypedRunner"',
        '',
        '[debug]',
        ...everyWarning(godotPath).map((warning) => `gdscript/warnings/${warning}=2`),
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'load_runner.gd'),
      [
        'extends SceneTree',
        '',
        '',
        'func _init() -> void:',
        '\tvar runner: Script = load(OS.get_cmdline_user_args()[0])',
        '\tvar loaded: bool = runner != null and runner.can_instantiate()',
        '\tprint(JSON.stringify({"ok": loaded}))',
        '\tquit(0 if loaded else 1)',
        '',
      ].join('\n'),
    );
    const imported = spawnSyncHidden(godotPath, ['--headless', '--path', dir, '--import'], {
      encoding: 'utf8',
      timeout: 180000,
    });
    assert.equal(imported.status, 0, `${imported.stdout}${imported.stderr}`);
    const runner = resolve(join('src', 'godot', 'tests', 'listed.gd'));
    const loaded = runScript(godotPath, dir, join(dir, 'load_runner.gd'), ['--', runner]);
    assert.equal(
      loaded.status,
      0,
      `the shipped runner should compile with every warning an error:\n${loaded.stdout}${loaded.stderr}`,
    );
    assert.match(loaded.stdout, /"ok":true/, loaded.stdout);
  } finally {
    sweep(dir);
  }
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
  assert.equal(get(payload, 'summary', 'total_dependencies'), 2, 'the chain has two dependencies');

  // A cycle has to be reported rather than walked forever.
  const cyclicPayload = runOperation(godotPath, projectDir, 'get_dependencies', {
    resource_path: 'res://chain/ouro.gd',
  });
  assert.ok(
    asArray(get(cyclicPayload, 'circular_references')).length > 0,
    'the walk should report the cycle it found rather than silently stopping',
  );
  // The cycle's way back names ouro itself, which is not one of its own dependencies.
  assert.deepEqual(
    [get(cyclicPayload, 'summary', 'total_dependencies'), get(cyclicPayload, 'summary', 'total_references')],
    [1, 2],
    `ouro depends on boros alone: ${JSON.stringify(get(cyclicPayload, 'summary'))}`,
  );
  // The cycle is marked at boros's reference back, which is the one that closes it.
  assert.deepEqual(
    get(cyclicPayload, 'dependencies', 'res://chain/ouro.gd'),
    [
      {
        path: 'res://chain/boros.gd',
        exists: true,
        dependencies: [{ path: 'res://chain/ouro.gd', exists: true, circular: true }],
      },
    ],
    'ouro is not a dependency of itself',
  );
  // Counting what boros names past the depth reads boros alone, and not ouro again in turn, which
  // around a cycle has no end.
  assert.deepEqual(
    get(
      runOperation(godotPath, projectDir, 'get_dependencies', {
        resource_path: 'res://chain/ouro.gd',
        depth: 1,
      }),
      'dependencies',
      'res://chain/ouro.gd',
    ),
    [{ path: 'res://chain/boros.gd', exists: true, beyond_depth: 1 }],
    'boros names one file the depth kept out',
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
 * Whether add_export_preset finds the templates of the preset's own platform, read from a copy of
 * the engine marked self-contained, so the templates directory is one this fixture fills.
 *
 * The directory is one per engine version and holds whichever platforms were installed into it.
 * Its being there was taken as the templates being installed, so an engine with only the Windows
 * templates answered yes for a Linux preset whose export then failed for want of them. The engine
 * legs run these fixtures on Linux and Windows only, so testASelfContainedEngineKeepsItsTemplates
 * in the regressions holds the macOS bundle.
 */
function checkTemplatesArePerPlatform(godotPath: string, projectDir: string): void {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'gdharness-contained-'));
  try {
    const engine = containedEngine(godotPath, home);
    const add = (preset: string, platform: string): unknown =>
      runOperation(engine, projectDir, 'add_export_preset', { preset, platform });

    const bare = add('Contained Linux', 'Linux');
    const templates = asString(get(bare, 'templates'));
    assert.equal(
      resolve(templates).startsWith(resolve(home, 'editor_data', 'export_templates')),
      true,
      `a self-contained engine keeps its templates beside it: ${JSON.stringify(bare)}`,
    );
    assert.equal(get(bare, 'templates_installed'), false, JSON.stringify(bare));
    assert.match(asString(get(bare, 'templates_note')), /^No Linux export templates for this engine are at /);

    mkdirSync(templates, { recursive: true });
    writeFileSync(join(templates, 'windows_release_x86_64.exe'), '');
    const other = add('Contained Linux 2', 'Linux');
    assert.deepEqual(
      [get(other, 'templates'), get(other, 'templates_installed')],
      [templates, false],
      `the Windows templates are not the Linux ones: ${JSON.stringify(other)}`,
    );
    const windows = add('Contained Windows', 'Windows Desktop');
    assert.deepEqual(
      [get(windows, 'templates_installed'), get(windows, 'templates_note')],
      [true, undefined],
      JSON.stringify(windows),
    );
    const listed = runOperation(engine, projectDir, 'list_export_presets', {});
    assert.equal(get(listed, 'templates'), templates, JSON.stringify(listed));
    assert.deepEqual(
      asArray(get(listed, 'presets'))
        .filter((preset) => asString(get(preset, 'name')).startsWith('Contained'))
        .map((preset) => [get(preset, 'name'), get(preset, 'templates_installed')]),
      [
        ['Contained Linux', false],
        ['Contained Linux 2', false],
        ['Contained Windows', true],
      ],
      `the list judges each preset by its own platform: ${JSON.stringify(listed)}`,
    );
  } finally {
    sweep(home);
  }
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
    throw failedRun(operation, run, output);
  }
  // Anything on stderr from an operation that succeeded is the engine complaining about
  // something the operation did, a leaked object or a resource still in use at exit included,
  // and the server hands every such line on to the caller. So an operation that passes here is
  // one that answers cleanly. The lines marking when it began and answered are the script's own,
  // and the only ones, with what it set aside between its aside marks, which the server drops.
  let aside = false;
  const complaints = run.stderr
    .split(/\r?\n/)
    .filter((line) => {
      const said = line.trim();
      if (said === ASIDE || said === RESUMED) {
        aside = said === ASIDE;
        return false;
      }
      return !aside && ![ANSWERED, WAITING, BEGUN].includes(said);
    })
    .join('\n')
    .trim();
  assert.equal(complaints, '', `${operation} succeeded but wrote to stderr:\n${run.stderr.trim()}`);
  assert.ok(run.answer !== null, `${operation} wrote no answer:\n${output.trim()}`);
  return run.answer;
}

interface OperationRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ms: number;
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
  return {
    status: run.status,
    signal: run.signal,
    stdout: run.stdout,
    stderr: run.stderr,
    ms: run.ms,
    answer,
  };
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
  // The editor writes a .uid beside a script it makes, and a headless engine writes none until an
  // import, so a check tracking the sidecars failed on every script made here.
  const heroUid = get(created, 'uid');
  assert.match(String(heroUid), /^uid:\/\/[a-z0-9]+$/, 'the answer names the uid it wrote');
  assert.equal(
    readFileSync(join(projectDir, 'made', 'hero.gd.uid'), 'utf8'),
    `${String(heroUid)}\n`,
    'the sidecar holds the uid the answer names, as the editor writes it',
  );
  const leftUid = 'uid://dfde0vm55ws7m';
  writeFileSync(join(projectDir, 'made', 'returned.gd.uid'), `${leftUid}\n`);
  const returned = operation('create_script', { script_path: 'made/returned.gd', extends: 'Node' });
  assert.equal(get(returned, 'uid'), leftUid, 'a sidecar already there is the uid the engine reads');
  assert.equal(readFileSync(join(projectDir, 'made', 'returned.gd.uid'), 'utf8'), `${leftUid}\n`);

  // Every template has to parse in the strictest project there is, which this one is: a
  // template that trips a warning there is a script the tool wrote that the engine refuses.
  // The operation loads what it wrote and says so, and anything it printed on the way is
  // stderr the run above refuses.
  // Given no extends, each takes the class it is written for: the resource template on the default
  // of Node wrote a script that did not parse.
  for (const [template, base] of [
    ['singleton', 'Node'],
    ['state_machine', 'Node'],
    ['component', 'Node'],
    ['resource', 'Resource'],
    ['none', 'Node'],
  ] as const) {
    const made = operation('create_script', {
      script_path: `made/${template}_template.gd`,
      template: template === 'none' ? '' : template,
    });
    // No class_name was given, so none is read, which is null rather than an empty name.
    assert.deepEqual(
      [get(made, 'parses'), get(made, 'extends'), get(made, 'class_name')],
      [true, base, null],
      `the ${template} template should parse under every warning, on ${base}: ${JSON.stringify(made)}`,
    );
  }
  // Its doc comment straight below the header, where Godot reads it as the class's.
  assert.match(
    readFileSync(join(projectDir, 'made', 'resource_template.gd'), 'utf8'),
    /^extends Resource\n## Data kept in a \.tres file/,
  );
  for (const [base, named] of [
    ['Node', 'Node'],
    ['FixtureHero', 'FixtureHero, a Node2D,'],
  ] as const) {
    const misplaced = runRefusedOperation(godotPath, projectDir, 'create_script', {
      script_path: 'made/misplaced.gd',
      extends: base,
      template: 'resource',
    });
    assert.equal(misplaced.answer, null, `the resource template on ${base} is refused`);
    assert.match(
      misplaced.stderr,
      new RegExp(
        `The resource template is written for a Resource, and extends ${named} is not one\\. Give extends a Resource class, or leave it out for Resource\\. Nothing was written\\.`,
      ),
      misplaced.stderr,
    );
    assert.ok(!existsSync(join(projectDir, 'made', 'misplaced.gd')), 'and nothing is written');
  }
  assert.equal(
    readFileSync(join(projectDir, 'made', 'none_template.gd'), 'utf8'),
    'extends Node\n',
    'with no template, the script is what was asked for and nothing else',
  );
  const broken = runRefusedOperation(godotPath, projectDir, 'create_script', {
    script_path: 'made/broken.gd',
    // With an inner class whose own extends is not the script's.
    content:
      'class_name FixtureBroken\nextends Node2D\n\n\nfunc _ready() -> void:\n\tvar loose = 1\n\n\nclass Inner:\n\textends Resource\n',
  });
  assert.equal(broken.status, 0, 'a script that was written is a success, whatever it says');
  assert.equal(get(broken.answer, 'parses'), false, 'a script the engine refuses is reported as not parsing');
  // The engine reads nothing off a script that does not parse, so the header comes off its text.
  assert.deepEqual(
    [get(broken.answer, 'extends'), get(broken.answer, 'class_name')],
    ['Node2D', 'FixtureBroken'],
    JSON.stringify(broken.answer),
  );
  assert.match(broken.stderr, /loose/, 'the reason is on stderr, where the server reads it from');
  // Gone again before the resave below walks the project, which would trip over it.
  rmSync(join(projectDir, 'made', 'broken.gd'));
  const nameless = runRefusedOperation(godotPath, projectDir, 'create_script', {
    script_path: 'made/nameless.gd',
    content: 'extends Node2D\n\n\nfunc _ready() -> void:\n\tvar loose = 1\n',
  });
  assert.deepEqual(
    [get(nameless.answer, 'parses'), get(nameless.answer, 'extends'), get(nameless.answer, 'class_name')],
    [false, 'Node2D', null],
    `a header read off the text with no class_name names none: ${JSON.stringify(nameless.answer)}`,
  );
  rmSync(join(projectDir, 'made', 'nameless.gd'));

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

  // A header that cannot compile is refused before anything is written. FixtureHero is in no class
  // list yet, since nothing has rebuilt one since hero.gd was made, so it is found in the script.
  for (const [file, header, said] of [
    [
      'taken',
      { class_name: 'FixtureHero', extends: 'Node' },
      'class_name FixtureHero is taken: res://made/hero.gd declares it, and a second script of that name does not compile. Give this one another class_name, or script_edit rename the first. Nothing was written.',
    ],
    [
      'engine_named',
      { class_name: 'Node2D', extends: 'Node' },
      'class_name Node2D is the name of an engine class, which a script cannot take. Nothing was written.',
    ],
    [
      'misnamed_base',
      { extends: 'FixtureHeroo' },
      'extends names FixtureHeroo, which is neither an engine class nor a class_name this project declares; the nearest is FixtureHero. Nothing was written.',
    ],
  ] as const) {
    const refused = runRefusedOperation(godotPath, projectDir, 'create_script', {
      script_path: `made/${file}.gd`,
      ...header,
    });
    assert.equal(refused.answer, null, `${file}: ${JSON.stringify(refused.answer)}`);
    assert.ok(refused.stderr.includes(said), `${file}: ${refused.stderr}`);
    assert.ok(!existsSync(join(projectDir, 'made', `${file}.gd`)), `${file}: and nothing is written`);
  }

  // An addition that would break a script that parses is the engine's to find, the base class's
  // members and a body that does not compile among it, and the script is left as it was. One that
  // does not parse yet is written to, since the addition can be what mends it.
  const plain = 'extends Node2D\n\n\nfunc _ready() -> void:\n\tpass\n';
  operation('create_script', { script_path: 'made/plain.gd', content: plain });
  for (const [modification, reason] of [
    [
      { type: 'add_variable', name: 'position', varType: 'Vector2' },
      /additions: line 3, Parse Error: Member "position" redefined \(original in native class 'Node2D'\); /,
    ],
    [{ type: 'add_function', name: 'stray', body: 'nowhere_at_all()' }, /line \d+, .*nowhere_at_all/],
  ] as const) {
    const refused = runRefusedOperation(godotPath, projectDir, 'modify_script', {
      script_path: 'made/plain.gd',
      modifications: [modification],
    });
    assert.equal(refused.answer, null, `${modification.name}: ${JSON.stringify(refused.answer)}`);
    assert.match(
      refused.stderr,
      /Nothing was changed: made\/plain\.gd parses now, and would not with these additions: /,
      refused.stderr,
    );
    assert.match(refused.stderr, reason, refused.stderr);
    assert.equal(
      readFileSync(join(projectDir, 'made', 'plain.gd'), 'utf8'),
      plain,
      'and the script is as it was',
    );
  }
  rmSync(join(projectDir, 'made', 'plain.gd'));
  const unmended = runRefusedOperation(godotPath, projectDir, 'create_script', {
    script_path: 'made/unmended.gd',
    content: 'extends Node\n\n\nfunc _ready() -> void:\n\tmend()\n',
  });
  assert.equal(get(unmended.answer, 'parses'), false, JSON.stringify(unmended.answer));
  const still = runRefusedOperation(godotPath, projectDir, 'modify_script', {
    script_path: 'made/unmended.gd',
    modifications: [{ type: 'add_variable', name: 'pace', varType: 'float', defaultValue: '1.0' }],
  });
  assert.equal(get(still.answer, 'parses'), false, `${JSON.stringify(still.answer)} ${still.stderr}`);
  assert.match(readFileSync(join(projectDir, 'made', 'unmended.gd'), 'utf8'), /^var pace: float = 1\.0$/m);
  const mended = runRefusedOperation(godotPath, projectDir, 'modify_script', {
    script_path: 'made/unmended.gd',
    modifications: [{ type: 'add_function', name: 'mend', body: 'pass' }],
  });
  assert.equal(get(mended.answer, 'parses'), true, `${JSON.stringify(mended.answer)} ${mended.stderr}`);
  rmSync(join(projectDir, 'made', 'unmended.gd'));

  // The first variable is set apart from the header above it, and the second sits with the first.
  operation('create_script', {
    script_path: 'made/bare.gd',
    content: 'extends Node\nsignal hit\n\n\nfunc _ready() -> void:\n\thit.emit()\n',
  });
  const apart = operation('modify_script', {
    script_path: 'made/bare.gd',
    modifications: [
      { type: 'add_variable', name: 'speed', varType: 'float', defaultValue: '1.0' },
      { type: 'add_variable', name: 'lives', varType: 'int', defaultValue: '3' },
    ],
  });
  assert.equal(
    readFileSync(join(projectDir, 'made', 'bare.gd'), 'utf8'),
    'extends Node\nsignal hit\n\nvar speed: float = 1.0\nvar lives: int = 3\n\n\nfunc _ready() -> void:\n\thit.emit()\n',
  );
  assert.deepEqual(
    asArray(get(apart, 'modifications_applied')).map((applied) => get(applied, 'line')),
    [4, 5],
    `and the lines answered are the ones they are on: ${JSON.stringify(apart)}`,
  );
  rmSync(join(projectDir, 'made', 'bare.gd'));

  // A class doc comment stays with the header it documents: Godot reads the `##` lines straight
  // below `extends` as the class's, and a signal or a variable put between them took them over. A
  // signal is set apart by a blank line from the header above it and from a variable below it.
  // Each body uses what the call adds, so the script parses once the additions are in and not before.
  const ready = (body: string): string => `\n\nfunc _ready() -> void:\n\t${body}\n`;
  for (const [content, modifications, expected] of [
    [
      `extends Node\n## What this node is for.\n## And a second line.\n${ready('hit.emit(int(speed))')}`,
      [
        { type: 'add_signal', name: 'hit', params: 'by: int' },
        { type: 'add_variable', name: 'speed', varType: 'float', defaultValue: '1.0' },
      ],
      `extends Node\n## What this node is for.\n## And a second line.\n\nsignal hit(by: int)\n\nvar speed: float = 1.0\n${ready('hit.emit(int(speed))')}`,
    ],
    [
      `extends Node\n## What this node is for.\n${ready('print(speed)')}`,
      [{ type: 'add_variable', name: 'speed', varType: 'float', defaultValue: '1.0' }],
      `extends Node\n## What this node is for.\n\nvar speed: float = 1.0\n${ready('print(speed)')}`,
    ],
    [
      `extends Node\nvar kept: int = 1\n${ready('hit.emit()')}`,
      [{ type: 'add_signal', name: 'hit' }],
      `extends Node\n\nsignal hit\n\nvar kept: int = 1\n${ready('hit.emit()')}`,
    ],
  ] as const) {
    runRefusedOperation(godotPath, projectDir, 'create_script', {
      script_path: 'made/documented.gd',
      content,
    });
    const laid = runRefusedOperation(godotPath, projectDir, 'modify_script', {
      script_path: 'made/documented.gd',
      modifications,
    });
    assert.equal(readFileSync(join(projectDir, 'made', 'documented.gd'), 'utf8'), expected);
    assert.equal(get(laid.answer, 'parses'), true, `${JSON.stringify(laid.answer)} ${laid.stderr}`);
    rmSync(join(projectDir, 'made', 'documented.gd'));
  }

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
      add_constant: 'const',
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
  assert.doesNotMatch(refused.stderr, /modify only adds/, 'nothing given was declared already');
  assert.equal(
    readFileSync(join(projectDir, 'made', 'hero.gd'), 'utf8'),
    modifiedSource,
    'and nothing is written',
  );
  // A name the script already declares, or one the call adds twice, is refused before anything is
  // written. A second variable of a name was written and did not parse, and a second function of a
  // name behind it was written with nothing said, since the engine reports only its first error.
  const duplicated = runRefusedOperation(godotPath, projectDir, 'modify_script', {
    script_path: 'made/hero.gd',
    modifications: [
      { type: 'add_variable', name: 'speed', varType: 'int' },
      { type: 'add_function', name: 'fresh' },
      { type: 'add_signal', name: 'fresh' },
      { type: 'add_constant', name: 'NOTHING' },
    ],
  });
  assert.equal(duplicated.answer, null, 'a call adding a name already there answers nothing');
  const speedLine = modifiedSource.split('\n').findIndex((line) => line.startsWith('var speed')) + 1;
  assert.match(
    duplicated.stderr,
    new RegExp(
      `Nothing was changed: modification 1 adds speed, and the script already declares var speed on line ${speedLine}; modification 3 adds fresh, which modification 2 adds too; modification 4 is a constant with no defaultValue, and a constant needs a value\\. modify only adds members; to change one the script declares already, edit its lines in the file`,
    ),
    duplicated.stderr,
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

  // A constant goes in typed, after the header and the signals, and on the line it is answered at.
  const constant = operation('modify_script', {
    script_path: 'made/hero.gd',
    modifications: [{ type: 'add_constant', name: 'FLOOR', defaultValue: '0' }],
  });
  assert.equal(get(constant, 'parses'), true, JSON.stringify(constant));
  onTheirLines(constant);
  const withConstant = readFileSync(join(projectDir, 'made', 'hero.gd'), 'utf8');
  assert.match(withConstant, /^const FLOOR: int = 0$/m, withConstant);
  const lines = withConstant.split('\n');
  const constantAt = lines.findIndex((line) => line.startsWith('const FLOOR'));
  assert.ok(
    constantAt > lines.findIndex((line) => line.startsWith('extends ')) &&
      constantAt < lines.findIndex((line) => line.startsWith('var ')),
    `the constant sits after the header and before the variables:\n${withConstant}`,
  );
  // Set apart from the header and from the variables as the style guide groups them, below the
  // class's own documentation, which a constant above would take over, and joined to the constants
  // already there. One went in directly under extends, against the header with no blank line.
  const spacedConstants: [string, string][] = [
    [
      'extends Node\n\nvar score: int = 0\n',
      'extends Node\n\nconst SAVE_PATH: String = "x"\n\nvar score: int = 0\n',
    ],
    [
      'extends Node\nvar score: int = 0\n',
      'extends Node\n\nconst SAVE_PATH: String = "x"\n\nvar score: int = 0\n',
    ],
    [
      'extends Node\n## The hero.\n\nvar score: int = 0\n',
      'extends Node\n## The hero.\n\nconst SAVE_PATH: String = "x"\n\nvar score: int = 0\n',
    ],
    [
      'extends Node\n\nconst FIRST: int = 1\n\nvar score: int = 0\n',
      'extends Node\n\nconst FIRST: int = 1\nconst SAVE_PATH: String = "x"\n\nvar score: int = 0\n',
    ],
  ];
  for (const [before, after] of spacedConstants) {
    writeFileSync(join(projectDir, 'made', 'constants.gd'), before);
    const placed = operation('modify_script', {
      script_path: 'made/constants.gd',
      modifications: [{ type: 'add_constant', name: 'SAVE_PATH', defaultValue: '"x"' }],
    });
    const written = readFileSync(join(projectDir, 'made', 'constants.gd'), 'utf8');
    assert.equal(written, after, `${JSON.stringify(before)} gets its constant spaced:\n${written}`);
    assert.equal(
      get(asArray(get(placed, 'modifications_applied'))[0], 'line'),
      written.split('\n').indexOf('const SAVE_PATH: String = "x"') + 1,
      'and answers the line it is on',
    );
  }

  // Functions are spaced the way gdstyle and gdformat write them, two blank lines on each side counting those
  // already there, and the file still ends with a newline; one placed after _ready goes above the
  // doc comment and the annotation line of the function that follows, not between them and it. The
  // comment indented in _ready's body is the end of that body and stays there.
  const spacedPath = join(projectDir, 'made', 'spaced.gd');
  writeFileSync(
    spacedPath,
    'extends Node\n\n\nfunc _ready() -> void:\n\tpass\n\t# the end of ready\n\n\n## Moves it.\n@rpc\nfunc move() -> void:\n\tpass\n',
  );
  const spaced = operation('modify_script', {
    script_path: 'made/spaced.gd',
    modifications: [
      { type: 'add_function', name: 'first' },
      { type: 'add_function', name: 'second' },
      { type: 'add_function', name: 'between', position: 'after_ready' },
    ],
  });
  assert.equal(get(spaced, 'parses'), true, JSON.stringify(spaced));
  assert.equal(
    readFileSync(spacedPath, 'utf8'),
    'extends Node\n\n\nfunc _ready() -> void:\n\tpass\n\t# the end of ready\n\n\nfunc between() -> void:\n\tpass\n\n\n## Moves it.\n@rpc\nfunc move() -> void:\n\tpass\n\n\nfunc first() -> void:\n\tpass\n\n\nfunc second() -> void:\n\tpass\n',
    "each function two blank lines from its neighbours, above the next one's doc comment, and a newline at the end",
  );
  assert.deepEqual(
    asArray(get(spaced, 'modifications_applied')).map((applied) => get(applied, 'line')),
    [19, 23, 9],
    `each answered on the line its declaration is on in the file written: ${JSON.stringify(spaced)}`,
  );
  writeFileSync(
    spacedPath,
    'extends Node\n\n\nfunc _init() -> void:\n\tpass\n\t# the end of init\nfunc later() -> void:\n\tpass\n',
  );
  operation('modify_script', {
    script_path: 'made/spaced.gd',
    modifications: [{ type: 'add_function', name: 'tucked', position: 'after_init' }],
  });
  assert.equal(
    readFileSync(spacedPath, 'utf8'),
    'extends Node\n\n\nfunc _init() -> void:\n\tpass\n\t# the end of init\n\n\nfunc tucked() -> void:\n\tpass\n\n\nfunc later() -> void:\n\tpass\n',
    'a comment indented into the body above stays in that body, with no blank line to set it off',
  );
  rmSync(spacedPath);

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
  // Files walked a_ before z_ declare their classes the other way round, so the order is the sort's.
  writeFileSync(join(projectDir, 'made', 'a_listed.gd'), 'class_name ZListed\nextends RefCounted\n');
  writeFileSync(join(projectDir, 'made', 'z_listed.gd'), 'class_name AListed\nextends RefCounted\n');
  const declared = asArray(get(operation('list_script_classes', {}), 'classes'));
  rmSync(join(projectDir, 'made', 'a_listed.gd'));
  rmSync(join(projectDir, 'made', 'z_listed.gd'));
  const classNames = declared.map((entry) => String(get(entry, 'name')));
  assert.ok(classNames.includes('AListed') && classNames.includes('ZListed'), JSON.stringify(declared));
  assert.deepEqual(
    declared.find((entry) => get(entry, 'name') === 'FixtureHero'),
    { name: 'FixtureHero', path: 'res://made/hero.gd' },
    JSON.stringify(declared),
  );
  assert.deepEqual(classNames, [...classNames].sort(), 'listed by name');
  // The newline ending the last line starts no line of its own, as an editor or wc counts them.
  const countedPath = join(projectDir, 'made', 'counted.gd');
  const counts = [
    'extends Node\n\nvar a := 1\n',
    'extends Node\r\n\r\nvar a := 1\r\n',
    'extends Node\nvar a := 1',
    '',
  ].map((content) => {
    writeFileSync(countedPath, content);
    return get(operation('get_script_info', { script_path: 'made/counted.gd' }), 'line_count');
  });
  rmSync(countedPath);
  assert.deepEqual(counts, [3, 3, 2, 0], 'a script counts the lines it holds');

  // A `##` block documents the class above its class_name or extends line, or above a blank line
  // before any member, and otherwise the member directly below it, past a line of annotations
  // alone. A blank line in between leaves it documenting nothing, and one in a body is a comment.
  const documentedPath = join(projectDir, 'made', 'documented.gd');
  writeFileSync(
    documentedPath,
    [
      '## The class.',
      '## Second line.',
      'class_name Documented',
      'extends Node',
      '',
      '## How fast it runs.',
      '@export var speed: float = 1.0',
      '## Left behind by a blank line.',
      '',
      'signal undocumented',
      '',
      '## Its count.',
      '@export',
      'var count: int = 0',
      '',
      '## A part of it.',
      'class Part:',
      '\t## Its weight.',
      '\tvar weight: int = 1',
      '',
      '## Takes one life.',
      'func hurt() -> void:',
      '\t## inside a body, documenting nothing',
      '\tpass',
      'var tail: int = 0',
      '',
    ].join('\n'),
  );
  const documented = operation('get_script_info', { script_path: 'made/documented.gd' });
  const docs = (key: string): Record<string, unknown> =>
    Object.fromEntries(
      asArray(get(documented, key)).map((member): [string, unknown] => [
        String(get(member, 'name')),
        get(member, 'doc'),
      ]),
    );
  assert.equal(get(documented, 'class_doc'), 'The class.\nSecond line.', JSON.stringify(documented));
  assert.deepEqual(docs('variables'), { speed: 'How fast it runs.', count: 'Its count.', tail: undefined });
  assert.deepEqual(docs('signals'), { undocumented: undefined });
  assert.deepEqual(docs('functions'), { hurt: 'Takes one life.' });
  const part = named(get(documented, 'inner_classes'), 'Part');
  assert.equal(get(part, 'doc'), 'A part of it.');
  assert.equal(get(named(get(part, 'variables'), 'weight'), 'doc'), 'Its weight.');
  writeFileSync(documentedPath, 'extends Node\n## After the header.\n\nvar x := 1\n');
  const after = operation('get_script_info', { script_path: 'made/documented.gd' });
  assert.equal(
    get(after, 'class_doc'),
    'After the header.',
    'a block under extends, set off by a blank line',
  );
  assert.equal(get(named(get(after, 'variables'), 'x'), 'doc'), undefined);
  rmSync(documentedPath);

  // Project settings, including the value serialisers on both the way in and the way out.
  const name = operation('get_project_setting', { setting: 'application/config/name' });
  assert.equal(get(name, 'exists'), true);
  assert.equal(get(name, 'value'), 'GdharnessEngineFixture');
  assert.equal(get(name, 'at_default'), false, 'a name the project set is not at the default');
  // Registered by the engine, so it exists whether or not project.godot says anything of it.
  const width = operation('get_project_setting', { setting: 'display/window/size/viewport_width' });
  assert.deepEqual(
    [get(width, 'exists'), get(width, 'at_default')],
    [true, true],
    `a setting the project never set exists, at its default: ${JSON.stringify(width)}`,
  );

  const written = operation('set_project_setting', {
    setting: 'fixture/vector',
    value: { _type: 'Vector2', x: 3, y: 4 },
  });
  assert.equal(get(written, 'was_new'), true);
  assert.equal(get(written, 'was_default'), false, 'a setting nobody registers has no default');
  assert.equal(get(written, 'saved'), true);
  // A setting the engine registers is there at its default before any file sets it, which is new to
  // the file all the same, and one the file sets is not.
  const described = operation('set_project_setting', {
    setting: 'application/config/description',
    value: 'A fixture',
  });
  assert.deepEqual(
    [get(described, 'old_value'), get(described, 'was_new'), get(described, 'was_default')],
    ['', true, true],
    `a registered setting at its default is new to the file: ${JSON.stringify(described)}`,
  );
  const renamed = operation('set_project_setting', {
    setting: 'application/config/name',
    value: 'GdharnessEngineFixture',
  });
  assert.deepEqual(
    [get(renamed, 'old_value'), get(renamed, 'was_new'), get(renamed, 'was_default')],
    ['GdharnessEngineFixture', false, false],
    `one the file sets is not: ${JSON.stringify(renamed)}`,
  );
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
  assert.equal(
    get(readBack, 'at_default'),
    undefined,
    'and a setting nothing registers has no default to be at',
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
    /max_log_files is declared as int, which holds whole numbers, and 50\.5 would be cut to fit/,
    `the refusal should say why:\n${truncated.stderr.trim()}`,
  );
  // A word for a number is a different refusal: nothing would be cut, it cannot become one at all.
  const worded = runRefusedOperation(godotPath, projectDir, 'set_project_setting', {
    setting: 'debug/file_logging/max_log_files',
    value: 'many',
  });
  assert.notEqual(worded.status, 0, 'a word where a number goes is refused');
  assert.match(
    `${worded.stdout}\n${worded.stderr}`,
    /max_log_files is declared as int, and "many" \(String\) cannot become one\./,
    `and says it cannot become one:\n${worded.stderr.trim()}`,
  );
  assert.match(
    readFileSync(join(projectDir, 'project.godot'), 'utf8'),
    /^file_logging\/max_log_files=50$/m,
    'and a refused write leaves the file as it was',
  );

  // The engine writes each section's keys in the order it registered them, and an engine running a
  // script registers them in another order than the editor, so a one-setting change moved lines
  // nobody touched. The file is turned around here, sections and the keys in each, which is an
  // order the engine would not write, and every write after this has to keep it.
  const projectFile = join(projectDir, 'project.godot');
  const turnedAround = (file: string): string => {
    const [preamble = '', ...sections] = file.split(/\n(?=\[)/);
    const reversed = sections.map((section) => {
      const [head = '', ...lines] = section.replace(/\n+$/, '').split('\n');
      const entries: string[] = [];
      for (const line of lines) {
        if (/^[\w"/.-]+=/.test(line) || entries.length === 0) {
          entries.push(line);
        } else {
          entries[entries.length - 1] += `\n${line}`;
        }
      }
      const kept = entries.filter((entry) => entry !== '');
      return `${head}\n\n${kept.reverse().join('\n')}`;
    });
    const ending = /\n*$/.exec(file)?.[0] ?? '';
    return `${preamble}\n${reversed.reverse().join('\n\n')}${ending}`;
  };
  const engineOrder = readFileSync(projectFile, 'utf8');
  writeFileSync(projectFile, turnedAround(engineOrder));
  const handOrdered = readFileSync(projectFile, 'utf8');
  assert.notEqual(handOrdered, engineOrder, 'the fixture has more than one key to turn around');
  const unchanged = operation('set_project_setting', {
    setting: 'application/config/description',
    value: 'A fixture',
  });
  assert.deepEqual(
    [get(unchanged, 'saved'), get(unchanged, 'unchanged')],
    [false, true],
    `a setting given the value it holds is not saved: ${JSON.stringify(unchanged)}`,
  );
  assert.equal(readFileSync(projectFile, 'utf8'), handOrdered, 'and the file is left byte for byte');
  assert.equal(get(unchanged, 'note'), undefined, 'a value the file holds needs no word on defaults');
  // A default the file has no line for is unchanged too, and said, since a caller looked for the line.
  const atDefault = operation('set_project_setting', {
    setting: 'internationalization/locale/fallback',
    value: 'en',
  });
  assert.deepEqual(
    [get(atDefault, 'saved'), get(atDefault, 'unchanged'), get(atDefault, 'note')],
    [
      false,
      true,
      '"en" is already this setting\'s default, which project.godot holds no line for: the engine reads it wherever internationalization/locale/fallback is asked for, so nothing was written.',
    ],
    JSON.stringify(atDefault),
  );
  assert.equal(readFileSync(projectFile, 'utf8'), handOrdered, 'and nothing is written for it');
  const redescribed = operation('set_project_setting', {
    setting: 'application/config/description',
    value: 'Another fixture',
  });
  assert.equal(get(redescribed, 'saved'), true, JSON.stringify(redescribed));
  assert.equal(
    readFileSync(projectFile, 'utf8'),
    handOrdered.replace('config/description="A fixture"', 'config/description="Another fixture"'),
    'a changed setting changes its own line and moves nothing',
  );
  const beforeSection = readFileSync(projectFile, 'utf8');
  operation('set_project_setting', { setting: 'editor/import/use_multiple_threads', value: false });
  const withSection = readFileSync(projectFile, 'utf8');
  assert.match(withSection, /^\[editor\]\n\nimport\/use_multiple_threads=false$/m, withSection);
  const linesOf = (file: string): string[] => file.split('\n').filter((line) => line !== '');
  assert.deepEqual(
    linesOf(withSection).filter(
      (line) => line !== '[editor]' && line !== 'import/use_multiple_threads=false',
    ),
    linesOf(beforeSection),
    'a new section is added whole and nothing else moves',
  );

  // Every write to project.godot goes through the engine's own save, which keeps the header
  // the editor writes and every line it did not touch, in the order the file had them, so from
  // here on a round trip has to give the bytes back and an addition has to keep every line that
  // was there.
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

  // A setting nothing declares has no type to fit a number to, and JSON sends every number as a
  // float, so a whole one was written as 800.0; one named like a declared setting is said to be.
  const beforeNew = readFileSync(projectFile, 'utf8');
  const widht = operation('set_project_setting', {
    setting: 'display/window/size/viewport_widht',
    value: 800,
  });
  assert.match(
    text(get(widht, 'note')),
    /^No setting display\/window\/size\/viewport_widht existed, so this wrote a new one, which the engine reads only where something asks for it by that name\. The nearest settings? (is|are) display\/window\/size\/viewport_width[,.]/,
    JSON.stringify(widht),
  );
  assert.match(readFileSync(projectFile, 'utf8'), /^window\/size\/viewport_widht=800$/m);
  const own = operation('set_project_setting', { setting: 'fixture_game/tempo', value: 3 });
  assert.equal(
    get(own, 'note'),
    undefined,
    `a section nothing declares has nothing to be near: ${JSON.stringify(own)}`,
  );
  assert.match(readFileSync(projectFile, 'utf8'), /^\[fixture_game\]\n\ntempo=3$/m);
  // The way back from a misspelt set: unset takes the line out, leaving every other line as it was.
  const unwritten = operation('unset_project_setting', { setting: 'display/window/size/viewport_widht' });
  assert.deepEqual(
    [get(unwritten, 'removed'), get(unwritten, 'old_value'), get(unwritten, 'default_value')],
    [true, 800, null],
    JSON.stringify(unwritten),
  );
  assert.doesNotMatch(readFileSync(projectFile, 'utf8'), /viewport_widht/);
  assert.match(readFileSync(projectFile, 'utf8'), /^\[fixture_game\]\n\ntempo=3$/m, 'and the rest stays');
  operation('set_project_setting', { setting: 'display/window/size/viewport_width', value: 640 });
  const engineDeclared = operation('unset_project_setting', {
    setting: 'display/window/size/viewport_width',
  });
  assert.deepEqual(
    [get(engineDeclared, 'removed'), get(engineDeclared, 'old_value'), get(engineDeclared, 'default_value')],
    [true, 640, 1152],
    `a declared setting goes back to the engine's default: ${JSON.stringify(engineDeclared)}`,
  );
  assert.doesNotMatch(readFileSync(projectFile, 'utf8'), /viewport_width=/);
  const unsaid = readFileSync(projectFile, 'utf8');
  const nothing = operation('unset_project_setting', { setting: 'display/window/size/viewport_width' });
  assert.deepEqual(
    [get(nothing, 'removed'), get(nothing, 'saved'), get(nothing, 'note')],
    [
      false,
      false,
      'project.godot does not set display/window/size/viewport_width, so there was nothing to take out.',
    ],
    JSON.stringify(nothing),
  );
  assert.equal(readFileSync(projectFile, 'utf8'), unsaid, 'and an unset of a line not there writes nothing');
  // A write of the base value with an override beside it says which builds still read the override,
  // and one with none says nothing of overrides.
  const unoverridden = operation('set_project_setting', {
    setting: 'display/window/size/viewport_width',
    value: 700,
  });
  operation('set_project_setting', { setting: 'display/window/size/viewport_width.mobile', value: 320 });
  const overridden = operation('set_project_setting', {
    setting: 'display/window/size/viewport_width',
    value: 800,
  });
  assert.deepEqual(
    [get(unoverridden, 'overrides'), get(overridden, 'overrides'), get(overridden, 'overridesNote')],
    [
      undefined,
      { mobile: 320 },
      'Not every build reads what was written: one with the feature mobile reads 320 from display/window/size/viewport_width.mobile. Set or unset an override to change what its builds read.',
    ],
    JSON.stringify([unoverridden, overridden]),
  );
  writeFileSync(projectFile, beforeNew);

  // Autoloads are written into project.godot by hand, so the round trip is the only proof.
  const beforeAutoload = readFileSync(projectFile, 'utf8');
  const added = operation('add_autoload', { name: 'Hero', path: 'made/hero.gd' });
  assert.equal(get(added, 'action'), 'added');
  keptWhole(beforeAutoload, readFileSync(projectFile, 'utf8'), 'adding an autoload');
  const withHero = readFileSync(projectFile, 'utf8');
  const again = operation('add_autoload', { name: 'Hero', path: 'made/hero.gd' });
  assert.deepEqual([get(again, 'action'), get(again, 'saved')], ['unchanged', false], JSON.stringify(again));
  assert.equal(readFileSync(projectFile, 'utf8'), withHero, 'and the file is left as it was');
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
  // A name every script would then reach the autoload by instead of what it names now: an autoload
  // called Input turned each Input.is_action_pressed into a call on the autoload.
  const beforeClash = readFileSync(projectFile, 'utf8');
  const clashes = [
    ['Input', 'it is the engine class Input, and every script naming Input would reach the autoload instead'],
    ['Vector2', 'it is the built-in type Vector2'],
    ['match', 'it is a GDScript keyword'],
    ['2nd', 'it is not an identifier, which a script could name'],
  ].map(([name, reason]) => {
    const refused = runRefusedOperation(godotPath, projectDir, 'add_autoload', {
      name,
      path: 'made/hero.gd',
    });
    return [
      refused.answer,
      refused.stderr.includes(`"${name}" cannot name an autoload: ${reason}. Nothing was written`),
    ];
  });
  assert.deepEqual(
    clashes,
    clashes.map(() => [null, true]),
    `each name is refused with its reason: ${JSON.stringify(clashes)}`,
  );
  assert.equal(readFileSync(projectFile, 'utf8'), beforeClash, 'and nothing was written for any of them');
  assert.equal(get(operation('remove_autoload', { name: 'Hero' }), 'removed'), true);
  assert.equal(
    readFileSync(projectFile, 'utf8'),
    beforeAutoload,
    'adding then removing an autoload should give project.godot back byte for byte',
  );

  // The main scene is a project setting with a file behind it, so both halves are checked.
  writeFixtureScene(projectDir);
  const notAScene = runRefusedOperation(godotPath, projectDir, 'set_main_scene', {
    scene_path: 'made/hero.gd',
  });
  assert.equal(notAScene.answer, null, JSON.stringify(notAScene.answer));
  assert.match(
    notAScene.stderr,
    /res:\/\/made\/hero\.gd is a GDScript, not a scene, and the main scene has to be one\. .*res:\/\/fixture_scene\.tscn/,
    notAScene.stderr,
  );
  assert.equal(get(operation('set_main_scene', { scene_path: 'fixture_scene.tscn' }), 'saved'), true);
  assert.equal(
    get(operation('get_project_setting', { setting: 'application/run/main_scene' }), 'value'),
    'res://fixture_scene.tscn',
  );

  // Scripts and a scene and nothing the engine imports: none counted, and said why rather than
  // left to read as a walk that found nothing.
  const nothingImported = operation('get_import_status', {});
  assert.equal(get(nothingImported, 'summary', 'total'), 0, 'scripts and scenes are not imported');
  assert.match(
    text(get(nothingImported, 'note')),
    /loads scripts and scenes as they are/,
    `and the answer says so: ${JSON.stringify(nothingImported)}`,
  );

  // The import pipeline reads and writes the .import sidecar, which is a ConfigFile.
  writeImportedResource(projectDir);
  const status = operation('get_import_status', { include_up_to_date: true });
  assert.equal(get(status, 'summary', 'total'), 1, 'the one importable resource should be found');
  assert.equal(get(status, 'note'), undefined, 'with something imported there is nothing to explain');
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
  assert.deepEqual(get(options, 'changed'), { 'compress/mode': { was: 0, now: 2 } }, JSON.stringify(options));
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
  // A misspelt path is offered what was likely meant: the file of the same name beside it for a
  // misspelt extension, which has no file of its own extension to be near, else the nearest name.
  const misspeltExtension = runRefusedOperation(godotPath, projectDir, 'get_import_options', {
    resource_path: 'art.pgn',
  });
  assert.match(
    misspeltExtension.stderr,
    /res:\/\/art\.pgn is not on disk\. The file of that name beside it is res:\/\/art\.png\./,
  );
  const misspeltName = runRefusedOperation(godotPath, projectDir, 'get_import_options', {
    resource_path: 'arts.png',
  });
  assert.match(
    misspeltName.stderr,
    /res:\/\/arts\.png is not on disk\. The nearest \.png files? (is|are) [^\n]*res:\/\/art\.png/,
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
  writeFileSync(join(projectDir, 'layers.psd'), '');
  // A sidecar with no source beside it, once under the .gdignore and once where the engine looks.
  // The whole-project listing is what a reimport reads its missingSource from, and asking about one
  // path never walks: the first is not the engine's, and the second, listed, shows the walk ran.
  const orphanSidecar = '[remap]\n\nimporter="texture"\n';
  writeFileSync(join(projectDir, 'kept_out', 'packed.png.import'), orphanSidecar);
  writeFileSync(join(projectDir, 'stray.png.import'), orphanSidecar);
  try {
    const sourceless = asArray(get(operation('get_import_status', {}), 'resources'))
      .filter((one) => get(one, 'status') === 'missing_source')
      .map((one) => get(one, 'path'));
    const said = JSON.stringify(sourceless);
    assert.ok(sourceless.includes('res://stray.png'), `a sourceless sidecar is listed: ${said}`);
    assert.ok(
      !sourceless.some((path) => String(path).startsWith('res://kept_out/')),
      `and one under a .gdignore is not: ${said}`,
    );
    assert.deepEqual(statusOf('kept_out/raw.png'), [
      'not_imported',
      'a .gdignore in res://kept_out keeps the engine from importing anything under it',
    ]);
    assert.deepEqual(statusOf('fresh.png'), ['needs_reimport', 'it has not been imported']);
    assert.match(String(statusOf('layers.psd')[1]), /^no importer built into the engine takes \.psd files/);
    assert.match(
      String(statusOf('model.blend')[1]),
      /^the engine imports \.blend files through Blender, which it finds through the editor setting filesystem\/import\/blender\/blender_path\./,
    );
    const freshOptions = runRefusedOperation(godotPath, projectDir, 'get_import_options', {
      resource_path: 'fresh.png',
    });
    assert.match(
      freshOptions.stderr,
      /res:\/\/fresh\.png has not been imported yet, so it has no import file: project_import reimport imports it with the importer's defaults and writes that file/,
      freshOptions.stderr,
    );
    // Named by health and validation both, the one under the .gdignore, the one the engine has no
    // importer for and the one only Blender imports left out.
    const neverImported =
      'res://fresh.png has never been imported, so nothing can load it until project_import reimport imports it';
    const resources = get(
      operation('get_project_health', { categories: ['resources'] }),
      'checks',
      'resources',
    );
    assert.deepEqual(get(resources, 'details'), [neverImported], JSON.stringify(resources));
    const unimported = asArray(get(operation('validate_project', {}), 'warnings')).filter(
      (warning) => get(warning, 'check') === 'imports',
    );
    assert.deepEqual(
      unimported.map((warning) => get(warning, 'message')),
      [neverImported],
      JSON.stringify(unimported),
    );
  } finally {
    rmSync(join(projectDir, 'kept_out'), { recursive: true, force: true });
    rmSync(join(projectDir, 'fresh.png'), { force: true });
    rmSync(join(projectDir, 'model.blend'), { force: true });
    rmSync(join(projectDir, 'layers.psd'), { force: true });
    rmSync(join(projectDir, 'stray.png.import'), { force: true });
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
  assert.equal(
    get(validation, 'valid'),
    true,
    `the main scene was set above, so the project validates: ${JSON.stringify(get(validation, 'issues'))}`,
  );
  assert.ok(
    asArray(get(validation, 'warnings')).some((warning) => get(warning, 'check') === 'export_presets'),
    'a project with no export presets should be warned about',
  );

  // A preset added as the editor's Export dialog adds one, then listed as the editor saved it.
  const presetsFile = join(projectDir, 'export_presets.cfg');
  const desktop = operation('add_export_preset', {
    preset: 'Desktop',
    platform: 'Windows Desktop',
    output_path: 'build/game.exe',
  });
  assert.deepEqual(
    [get(desktop, 'index'), get(desktop, 'runnable'), get(desktop, 'export_path')],
    [0, true, 'build/game.exe'],
    JSON.stringify(desktop),
  );
  assert.match(
    asString(get(desktop, 'templates')),
    /export_templates[\\/]\d+\.\d+(\.\d+)?\.\w+/,
    JSON.stringify(desktop),
  );
  assert.equal(typeof get(desktop, 'templates_installed'), 'boolean', JSON.stringify(desktop));
  const debugPreset = operation('add_export_preset', {
    preset: 'Desktop Debug',
    platform: 'Windows Desktop',
  });
  assert.equal(
    get(debugPreset, 'runnable'),
    false,
    `the platform has its runnable preset: ${JSON.stringify(debugPreset)}`,
  );
  const presetsText = readFileSync(presetsFile, 'utf8');
  assert.match(presetsText, /\[runnable_presets\]\s*\n\s*"?Windows Desktop"?="Desktop"/, presetsText);
  assert.match(presetsText, /\[preset\.1\.options\]/, presetsText);
  const presetList = asArray(get(operation('list_export_presets', {}), 'presets'));
  assert.deepEqual(
    presetList.map((preset) => [
      get(preset, 'name'),
      get(preset, 'platform'),
      get(preset, 'runnable'),
      get(preset, 'templates_installed'),
    ]),
    [
      ['Desktop', 'Windows Desktop', true, get(desktop, 'templates_installed')],
      ['Desktop Debug', 'Windows Desktop', false, get(desktop, 'templates_installed')],
    ],
    `the list reads templates as add_preset does: ${JSON.stringify(presetList)}`,
  );
  const taken = runRefusedOperation(godotPath, projectDir, 'add_export_preset', {
    preset: 'Desktop',
    platform: 'Linux',
  });
  assert.match(
    taken.stderr,
    /There is already an export preset named 'Desktop', for Windows Desktop, exporting to 'build\/game\.exe'\. project_export run exports with it; give another name to add a second\./,
    taken.stderr,
  );
  const pathless = runRefusedOperation(godotPath, projectDir, 'add_export_preset', {
    preset: 'Desktop Debug',
    platform: 'Linux',
  });
  assert.match(
    pathless.stderr,
    /There is already an export preset named 'Desktop Debug', for Windows Desktop, with no export path set\. project_export run/,
    pathless.stderr,
  );
  const unknown = runRefusedOperation(godotPath, projectDir, 'add_export_preset', {
    preset: 'Other',
    platform: 'Windows',
  });
  assert.match(
    unknown.stderr,
    /Unknown platform 'Windows'\. The platforms are Windows Desktop, Linux/,
    unknown.stderr,
  );
  checkTemplatesArePerPlatform(godotPath, projectDir);
  rmSync(presetsFile);

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

  // Only faults fail a check. The fixture keeps no res://scenes, res://scripts or res://assets and has
  // no export presets, which failed two checks and cost a grade: a layout Godot's own guidance
  // advises against, and presets a project in the making has no need of yet.
  assert.equal(
    get(health, 'checks', 'structure', 'passed'),
    true,
    `no layout is asked for: ${JSON.stringify(health)}`,
  );
  assert.equal(
    get(health, 'checks', 'config', 'passed'),
    true,
    `no presets is no fault: ${JSON.stringify(health)}`,
  );
  assert.ok(
    asArray(get(health, 'recommendations')).some((said) =>
      String(said).includes('No export presets are configured'),
    ),
    `and the missing presets are still recommended: ${JSON.stringify(get(health, 'recommendations'))}`,
  );
  const noted = join(projectDir, 'noted_for_later.gd');
  writeFileSync(noted, 'extends Node\n\n\n# TODO: something later\nfunc later() -> void:\n\tpass\n');
  try {
    const withNotes = operation('get_project_health', { categories: ['scripts'] });
    assert.equal(
      get(withNotes, 'checks', 'scripts', 'passed'),
      true,
      `a TODO fails nothing: ${JSON.stringify(withNotes)}`,
    );
    assert.ok(
      asArray(get(withNotes, 'recommendations')).some((said) =>
        String(said).includes('scripts have TODO or FIXME comments'),
      ),
      `and is said as something to look at: ${JSON.stringify(withNotes)}`,
    );
  } finally {
    rmSync(noted);
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
  // reference says how: middle.gd preloads it. Written here as dependencyWalk writes them, so the
  // case reads the same files when it runs on its own.
  mkdirSync(join(projectDir, 'chain'), { recursive: true });
  writeFileSync(join(projectDir, 'chain', 'leaf.gd'), 'extends Node\n');
  writeFileSync(
    join(projectDir, 'chain', 'middle.gd'),
    'extends Node\n\nconst Leaf = preload("res://chain/leaf.gd")\n',
  );
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
  // create_script writes the sidecar, so the script here is written as a file edit writes one.
  writeFileSync(join(projectDir, 'made', 'unimported.gd'), 'extends Node\n');
  const absent = operation('get_uid', { resource_path: 'made/unimported.gd' });
  rmSync(join(projectDir, 'made', 'unimported.gd'));
  assert.equal(get(absent, 'exists'), false);
  assert.equal(get(absent, 'file'), 'res://made/unimported.gd');
  assert.match(
    String(get(absent, 'message')),
    /refresh_uids/,
    'and it names the op that makes one, since that is the next thing the caller wants',
  );
  const minted = operation('get_uid', { resource_path: 'made/hero.gd' });
  assert.deepEqual(
    [get(minted, 'exists'), get(minted, 'uid')],
    [true, heroUid],
    'the sidecar create_script wrote is the uid the engine reads',
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
  const enabledOne = operation('enable_plugin', { plugin_name: 'gdharness_editor' });
  assert.deepEqual(
    [get(enabledOne, 'action'), get(enabledOne, 'note')],
    ['enabled', undefined],
    `a plugin the editor loads is enabled with nothing to say: ${JSON.stringify(enabledOne)}`,
  );
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

  // A plugin the editor will not load is still enabled, since its script can be put right before
  // the editor starts, and the answer says what the editor will find.
  const unloadable: Array<[string, string, string]> = [
    [
      'broken',
      '@tool\nextends EditorPlugin\n\n\nfunc _enter_tree() -> void\n\tpass\n',
      'res://addons/broken/plugin.gd does not compile, so the editor disables the plugin again at its next start. script_diagnostics names the error.',
    ],
    [
      'untooled',
      'extends EditorPlugin\n',
      'res://addons/untooled/plugin.gd is not a @tool script, so the editor loads nothing for it.',
    ],
    [
      'unplugged',
      '@tool\nextends Node\n',
      'res://addons/unplugged/plugin.gd does not extend EditorPlugin, so the editor loads nothing for it.',
    ],
    [
      'scriptless',
      '',
      'res://addons/scriptless/plugin.gd does not exist, so the editor will not enable the plugin.',
    ],
  ];
  try {
    for (const [name, source, note] of unloadable) {
      mkdirSync(join(projectDir, 'addons', name), { recursive: true });
      writeFileSync(
        join(projectDir, 'addons', name, 'plugin.cfg'),
        `[plugin]\n\nname="${name}"\nscript="plugin.gd"\n`,
      );
      if (source !== '') {
        writeFileSync(join(projectDir, 'addons', name, 'plugin.gd'), source);
      }
      const answer = operation('enable_plugin', { plugin_name: name });
      assert.deepEqual(
        [get(answer, 'action'), get(answer, 'note')],
        ['enabled', note],
        `${name} is enabled and the answer says why the editor will not load it: ${JSON.stringify(answer)}`,
      );
      operation('disable_plugin', { plugin_name: name });
    }
    assert.equal(readFileSync(projectFile, 'utf8'), beforePlugin, 'and each comes out again');
  } finally {
    for (const [name] of unloadable) {
      rmSync(join(projectDir, 'addons', name), { recursive: true, force: true });
    }
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
  // Read back, the binding says what it is: a bare resource said InputEventKey and nothing else.
  const boundTo = get(
    operation('get_project_setting', { setting: 'input/fixture_jump' }),
    'value',
    'events',
    0,
  );
  assert.deepEqual(
    [get(boundTo, 'class'), get(boundTo, 'keycode'), get(boundTo, 'ctrl_pressed')],
    ['InputEventKey', 32, true],
    JSON.stringify(boundTo),
  );
  assert.match(String(get(boundTo, 'text')), /Space/, JSON.stringify(boundTo));
  assert.equal(get(action, 'was_new'), true, JSON.stringify(action));
  assert.equal(get(action, 'old_events'), undefined, JSON.stringify(action));

  // Adding an action that exists rebinds it: the old events go, and the answer says what they were.
  const rebound = operation('add_input_action', {
    action_name: 'fixture_jump',
    events: [{ type: 'key', keycode: 'W' }],
    deadzone: 0.2,
  });
  assert.deepEqual(
    [
      get(rebound, 'was_new'),
      get(rebound, 'old_deadzone'),
      get(rebound, 'events_count'),
      get(rebound, 'saved'),
    ],
    [false, 0.5, 1, true],
    JSON.stringify(rebound),
  );
  const oldEvents = asArray(get(rebound, 'old_events'));
  assert.equal(oldEvents.length, 1, JSON.stringify(rebound));
  assert.deepEqual(
    [get(oldEvents[0], 'class_name'), get(oldEvents[0], 'keycode'), get(oldEvents[0], 'ctrl_pressed')],
    ['InputEventKey', 32, true],
    JSON.stringify(rebound),
  );
  assert.match(String(get(oldEvents[0], 'text')), /Space/, JSON.stringify(rebound));
  // One of the engine's own actions, which only add_input_action can change, has the engine's
  // bindings until then, and those are what it answers as replaced.
  const beforeUi = readFileSync(projectFile, 'utf8');
  const accept = operation('add_input_action', {
    action_name: 'ui_accept',
    events: [{ type: 'key', keycode: 'E' }],
  });
  assert.equal(get(accept, 'was_new'), false, JSON.stringify(accept));
  assert.ok(
    asArray(get(accept, 'old_events')).some((event) => String(get(event, 'text')).includes('Enter')),
    `the engine binds ui_accept to Enter: ${JSON.stringify(accept)}`,
  );
  // What project.godot holds, the project's own and an engine action it rebinds, and none of the
  // engine's that it leaves alone.
  const actions = asArray(get(operation('list_input_actions', {}), 'actions'));
  const listedAction = (name: string): unknown => actions.find((entry) => get(entry, 'name') === name);
  assert.deepEqual(
    [
      get(listedAction('fixture_jump'), 'deadzone'),
      get(listedAction('fixture_jump'), 'events', 0, 'keycode'),
      get(listedAction('fixture_jump'), 'engineAction'),
      get(listedAction('ui_accept'), 'events', 0, 'keycode'),
      get(listedAction('ui_accept'), 'engineAction'),
    ],
    [0.2, 87, false, 69, true],
    JSON.stringify(actions),
  );
  assert.equal(
    listedAction('ui_cancel'),
    undefined,
    `an engine action left alone is not listed: ${JSON.stringify(actions)}`,
  );
  // A rebind naming no deadzone keeps the action's own; a key can be bound by where it sits, and
  // every event is bound to every device, as the editor binds it, so a second joypad reaches it.
  const physical = operation('add_input_action', {
    action_name: 'fixture_jump',
    events: [
      { type: 'key', keycode: 'W', physical: true },
      { type: 'joypad_button', button: 0 },
    ],
  });
  assert.deepEqual(
    [get(physical, 'deadzone'), get(physical, 'old_deadzone'), get(physical, 'events', 0)],
    [0.2, 0.2, { class_name: 'InputEventKey', physical_keycode: 87 }],
    JSON.stringify(physical),
  );
  const boundEverywhere = readFileSync(projectFile, 'utf8');
  const jumpLine = /^fixture_jump=\{[\s\S]*?\n\}$/m.exec(boundEverywhere)?.[0] ?? boundEverywhere;
  assert.equal(jumpLine.match(/"device":-1,/g)?.length, 2, jumpLine);
  assert.match(jumpLine, /"keycode":0,[^)]*"physical_keycode":87,/, jumpLine);
  const relisted = asArray(get(operation('list_input_actions', {}), 'actions')).find(
    (entry) => get(entry, 'name') === 'fixture_jump',
  );
  assert.deepEqual(
    [get(relisted, 'events', 0, 'physical_keycode'), get(relisted, 'events', 0, 'keycode')],
    [87, undefined],
    `a physical binding reads back as one: ${JSON.stringify(relisted)}`,
  );
  assert.equal(get(relisted, 'events', 1, 'device'), undefined, JSON.stringify(relisted));
  // An event a file binds to one device says which, as the editor's binding to every device does not.
  writeFileSync(
    projectFile,
    boundEverywhere.replace(jumpLine, jumpLine.replace('"device":-1,', '"device":2,')),
  );
  const onePad = asArray(get(operation('list_input_actions', {}), 'actions')).find(
    (entry) => get(entry, 'name') === 'fixture_jump',
  );
  assert.deepEqual(
    [get(onePad, 'events', 0, 'device'), get(onePad, 'events', 1, 'device')],
    [2, undefined],
    JSON.stringify(onePad),
  );
  writeFileSync(projectFile, beforeUi);
  // A name the Input Map would refuse, and a key no name reaches, are refused with what is taken.
  const quoted = runRefusedOperation(godotPath, projectDir, 'add_input_action', {
    action_name: 'say "hi"',
    events: [{ type: 'key', keycode: 'Space' }],
  });
  assert.match(
    quoted.stderr,
    /"say \\"hi\\"" is not an action name the engine's Input Map takes: a name cannot hold \/ : = \\ or a double quote, or a control character\. jump, move_left or ui_menu are names it takes\./,
    quoted.stderr,
  );
  const unkeyed = runRefusedOperation(godotPath, projectDir, 'add_input_action', {
    action_name: 'fixture_dash',
    events: [{ type: 'key', keycode: 'Spacebarr' }],
  });
  assert.match(
    unkeyed.stderr,
    /Unknown key: Spacebarr\. The nearest key names are [^.]*\bSpace\b[^.]*\. A key is named by its letter, its digit, F1 to F12, or one of: Space, Escape, Tab, [^.]*, Equal\./,
    unkeyed.stderr,
  );
  const lone = runRefusedOperation(godotPath, projectDir, 'add_input_action', {
    action_name: 'fixture_dash',
    events: [{ type: 'key', keycode: 'CapsLok' }],
  });
  assert.match(
    lone.stderr,
    /Unknown key: CapsLok\. The nearest key name is CapsLock\. A key is named by its letter/,
    lone.stderr,
  );
  const farOff = runRefusedOperation(godotPath, projectDir, 'add_input_action', {
    action_name: 'fixture_dash',
    events: [{ type: 'key', keycode: 'Qwxz' }],
  });
  assert.match(farOff.stderr, /Unknown key: Qwxz\. A key is named by its letter/, farOff.stderr);
  // A field an event needs was given a default, a left click or axis 0 pushed right, and a number the
  // engine has no button or direction for was written as bound.
  const unbound: [Record<string, unknown>, RegExp][] = [
    [
      { type: 'mouse_button' },
      /A mouse_button event needs button, a whole number from 1 to 9 \(1 left, 2 right, 3 middle, [^)]*8 and 9 the side buttons\): none was given\./,
    ],
    [{ type: 'mouse_button', button: 10 }, /A mouse_button event needs button, [^:]*: 10 was given\./],
    [
      { type: 'joypad_button', button: 1.5 },
      /A joypad_button event needs button, a whole number from 0 to 127 /,
    ],
    [
      { type: 'joypad_axis', axisValue: 1 },
      /A joypad_axis event needs axis, a whole number from 0 to 9 \(0 and 1 the left stick[^)]*\): none was given\./,
    ],
    [
      { type: 'joypad_axis', axis: 2, axisValue: 0.5 },
      /A joypad_axis event needs axisValue, -1 or 1, the way the axis is pushed: 0\.5 was given\./,
    ],
    [
      { type: 'joypad_axis', axis: 2 },
      /A joypad_axis event needs axisValue, -1 or 1, [^:]*: none was given\./,
    ],
    [
      { type: 'joypad_axis', axis: 2, axisValue: '1' },
      /A joypad_axis event needs axisValue, -1 or 1, [^:]*: "1" was given\./,
    ],
  ];
  for (const [event, refusal] of unbound) {
    const refused = runRefusedOperation(godotPath, projectDir, 'add_input_action', {
      action_name: 'fixture_dash',
      events: [{ type: 'key', keycode: 'Space' }, event],
    });
    assert.match(refused.stderr, refusal, `${JSON.stringify(event)}: ${refused.stderr}`);
  }
  assert.equal(readFileSync(projectFile, 'utf8'), beforeUi, 'and nothing is written for any of them');
  const aimed = operation('add_input_action', {
    action_name: 'fixture_aim',
    events: [
      { type: 'joypad_axis', axis: 2, axisValue: -1 },
      { type: 'mouse_button', button: 9 },
      { type: 'joypad_button', button: 127 },
    ],
  });
  assert.deepEqual(
    get(aimed, 'events'),
    [
      { class_name: 'InputEventJoypadMotion', axis: 2, axis_value: -1 },
      { class_name: 'InputEventMouseButton', button_index: 9 },
      { class_name: 'InputEventJoypadButton', button_index: 127 },
    ],
    JSON.stringify(aimed),
  );
  writeFileSync(projectFile, beforeUi);

  // Audio buses live in the AudioServer and only survive the run if the layout is saved. Before any
  // change there is no layout file, and the setting names its path all the same.
  assert.equal(
    existsSync(join(projectDir, 'default_bus_layout.tres')),
    false,
    'the fixture starts with no layout',
  );
  const unsaved = operation('get_audio_buses', {});
  assert.deepEqual(
    { onDisk: get(unsaved, 'layout_on_disk'), note: get(unsaved, 'note') },
    {
      onDisk: false,
      note: "Nothing is at res://default_bus_layout.tres, so these are the engine's default buses; the first change to a bus writes the layout there.",
    },
    JSON.stringify(unsaved),
  );
  const fixtureBus = operation('create_audio_bus', { bus_name: 'Fixture' });
  assert.equal(get(fixtureBus, 'bus', 'name'), 'Fixture', 'the bus carries the name it was given');
  assert.equal(get(fixtureBus, 'layout'), 'res://default_bus_layout.tres');
  const buses = operation('get_audio_buses', {});
  assert.equal(
    get(buses, 'layout_on_disk'),
    undefined,
    `once written, the layout is there: ${JSON.stringify(buses)}`,
  );
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

  // A bus removed, with one sending to it: that one is sent on to where the removed bus went rather
  // than left sending to a name nothing has, which the engine reads as Master whatever the chain.
  const child = operation('create_audio_bus', { bus_name: 'Child', parent_bus_index: 1 });
  assert.deepEqual(
    [get(child, 'bus', 'index'), get(child, 'bus', 'send')],
    [2, 'Second'],
    JSON.stringify(child),
  );
  const removed = operation('remove_audio_bus', { bus_name: 'Second' });
  assert.deepEqual(get(removed, 'resent'), { buses: ['Child'], to: 'Master' }, JSON.stringify(removed));
  assert.deepEqual(
    layoutNames(operation('get_audio_buses', {})),
    [
      [0, 'Master', ''],
      [1, 'Child', 'Master'],
      [2, 'Fixture', 'Master'],
    ],
    'and the layout a fresh process reads has it gone',
  );
  const master = runRefusedOperation(godotPath, projectDir, 'remove_audio_bus', { bus_name: 'Master' });
  assert.match(
    master.stderr,
    /Master is the bus every other ends in, so it cannot be removed/,
    master.stderr,
  );
  const absentBus = runRefusedOperation(godotPath, projectDir, 'remove_audio_bus', { bus_name: 'Nope' });
  assert.match(
    absentBus.stderr,
    /No bus named Nope\. The buses are Master, Child, Fixture\./,
    absentBus.stderr,
  );

  // An input action removed, and one of the engine's own refused, since clearing it from the file
  // brings the engine's binding back rather than removing it.
  assert.deepEqual(operation('remove_input_action', { action_name: 'fixture_jump' }), {
    action_name: 'fixture_jump',
    removed: true,
  });
  assert.doesNotMatch(
    readFileSync(projectFile, 'utf8'),
    /fixture_jump/,
    'and project.godot no longer has it',
  );
  const builtIn = runRefusedOperation(godotPath, projectDir, 'remove_input_action', {
    action_name: 'ui_accept',
  });
  const untouchedBinding =
    "ui_accept is one of the engine's own actions, and project.godot does not rebind it, so there is nothing to remove: the engine's binding holds. Rebind it with add_input_action.";
  assert.ok(builtIn.stderr.includes(untouchedBinding), builtIn.stderr);
  // Rebound, it can go back to the engine's binding, and the refusal says how; the way it names
  // has to work, so it is taken.
  operation('add_input_action', { action_name: 'ui_accept', events: [{ type: 'key', keycode: 'E' }] });
  const reboundRefused = runRefusedOperation(godotPath, projectDir, 'remove_input_action', {
    action_name: 'ui_accept',
  });
  assert.ok(
    reboundRefused.stderr.includes(
      "ui_accept is one of the engine's own actions, so it cannot be removed. project_settings unset input/ui_accept puts the engine's binding back, and add_input_action rebinds it.",
    ),
    reboundRefused.stderr,
  );
  assert.equal(get(operation('unset_project_setting', { setting: 'input/ui_accept' }), 'removed'), true);
  assert.doesNotMatch(readFileSync(projectFile, 'utf8'), /^ui_accept=/m, 'and the file holds no binding');
  const restored = runRefusedOperation(godotPath, projectDir, 'remove_input_action', {
    action_name: 'ui_accept',
  });
  assert.ok(restored.stderr.includes(untouchedBinding), restored.stderr);
  const missingAction = runRefusedOperation(godotPath, projectDir, 'remove_input_action', {
    action_name: 'fixture_jump',
  });
  assert.match(
    missingAction.stderr,
    /This project has no input action named fixture_jump/,
    missingAction.stderr,
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

  // What a class inherits comes by name under each ancestor, its own members in full: in full, the
  // inherited members of CharacterBody2D ran to two hundred thousand characters, past what a client
  // takes in one answer.
  const withInherited = operation('query_class_info', {
    class_name: 'CharacterBody2D',
    include_inherited: true,
  });
  const ancestry = asArray(get(withInherited, 'inherited'));
  assert.deepEqual(
    ancestry.map((ancestor) => get(ancestor, 'class')),
    ['PhysicsBody2D', 'CollisionObject2D', 'Node2D', 'CanvasItem', 'Node', 'Object'],
    'every ancestor, nearest first',
  );
  const namedIn = (at: number, kind: string): unknown[] => asArray(get(ancestry[at], kind));
  assert.ok(
    namedIn(2, 'properties').includes('position') &&
      namedIn(4, 'methods').includes('add_child') &&
      namedIn(4, 'signals').includes('ready') &&
      namedIn(4, 'enums').includes('ProcessMode'),
    JSON.stringify(ancestry[4]),
  );
  assert.ok(named(get(withInherited, 'methods'), 'move_and_slide'), 'its own methods in full');
  assert.ok(!named(get(withInherited, 'methods'), 'add_child'), 'and only its own there');
  const inheritedSize = JSON.stringify(withInherited).length;
  assert.ok(inheritedSize < 40_000, `and the whole answer stays small: ${inheritedSize} characters`);

  // Every type named as well as numbered: the number is the engine's enum, which reads as nothing to
  // somebody who has not got it to hand. One member for each way a name is arrived at.
  const memberOf = (className: string, member: string): unknown =>
    get(operation('query_class_info', { class_name: className, member }), 'found', 0, 'member');
  assert.equal(get(memberOf('Node2D', 'position'), 'type_name'), 'Vector2', 'a value type by its own name');
  assert.equal(get(memberOf('Node', 'get_node'), 'return', 'type_name'), 'Node', 'an object by its class');
  assert.equal(get(memberOf('Object', 'get'), 'return', 'type_name'), 'Variant', 'anything as Variant');
  assert.equal(
    get(memberOf('Node', 'queue_free'), 'return', 'type_name'),
    'void',
    'nothing returned as void',
  );
  assert.equal(
    get(memberOf('Node', 'add_child'), 'args', 0, 'type_name'),
    'Node',
    'an argument named the same way',
  );
  // A default argument is a value like any other answer's, so a Vector2i is tagged rather than the
  // text JSON makes of it.
  assert.deepEqual(
    get(memberOf('TileMapLayer', 'set_cell'), 'default_args'),
    [-1, { _type: 'Vector2i', x: -1, y: -1 }, 0],
    JSON.stringify(memberOf('TileMapLayer', 'set_cell')),
  );
  // The flags by name beside the number, which reads as nothing without the engine's enum.
  assert.deepEqual(
    [
      get(memberOf('CharacterBody2D', 'move_and_slide'), 'flag_names'),
      get(memberOf('Node', 'get_child_count'), 'flag_names'),
      get(memberOf('Object', 'call'), 'flag_names'),
    ],
    [['normal'], ['normal', 'const'], ['normal', 'vararg']],
    'a plain method, a const one and one taking any number of arguments',
  );

  const inheritance = operation('inspect_inheritance', { class_name: 'Node2D' });
  assert.ok(asArray(get(inheritance, 'ancestors')).includes('CanvasItem'));
  assert.ok(asArray(get(inheritance, 'all_descendants')).includes('Camera2D'));

  // A class_name the project declares is not in ClassDB, and "Class not found" for one read as
  // though the project had no such class. The cache rebuilt above holds FixtureHero.
  const scripted = runRefusedOperation(godotPath, projectDir, 'query_class_info', {
    class_name: 'FixtureHero',
    project_classes: { FixtureHero: { path: 'res://made/hero.gd', extends: 'Node2D', abstract: false } },
  });
  assert.match(
    scripted.stderr,
    /FixtureHero is not an engine class: it is the class_name res:\/\/made\/hero\.gd declares/,
    scripted.stderr,
  );
  const nowhere = runRefusedOperation(godotPath, projectDir, 'inspect_inheritance', {
    class_name: 'FixtureNobody',
  });
  assert.match(
    nowhere.stderr,
    /Class not found: FixtureNobody\. Neither the engine nor a project script declares it\./,
    nowhere.stderr,
  );
  // A letter short of an engine class is offered the class, as the usual miss is a spelling.
  const misspelt = runRefusedOperation(godotPath, projectDir, 'query_class_info', {
    class_name: 'CharacterBody2',
  });
  assert.match(
    misspelt.stderr,
    /Class not found: CharacterBody2\. The nearest engine classes are CharacterBody2D, CharacterBody3D[,.].* editor_classes reads the engine's ClassDB/,
    misspelt.stderr,
  );
  // Two letters swapped are still a spelling, and a name sharing only a word is not: NoSuchClass was
  // offered ClassDB, both holding "class", which scores as high as the swap does.
  const swapped = runRefusedOperation(godotPath, projectDir, 'query_class_info', { class_name: 'Lable' });
  assert.match(
    swapped.stderr,
    /Class not found: Lable\. The nearest engine class(es)? (is|are) Label[,.]/,
    swapped.stderr,
  );
  const unlike = runRefusedOperation(godotPath, projectDir, 'query_class_info', {
    class_name: 'NoSuchClass',
  });
  assert.match(
    unlike.stderr,
    /Class not found: NoSuchClass\. editor_classes reads the engine's ClassDB/,
    unlike.stderr,
  );
  // The classes the scripts declare on disk are the ones judged, not the class cache, which lags
  // them: a class written a moment ago was refused as declared nowhere, and a misspelt one was
  // offered only engine classes.
  const unscanned = runRefusedOperation(godotPath, projectDir, 'query_class_info', {
    class_name: 'FixtureLater',
    project_classes: {
      FixtureHero: { path: 'res://made/hero.gd', extends: 'Node2D', abstract: false },
      FixtureLater: { path: 'res://made/later.gd', extends: 'Node', abstract: false },
    },
  });
  assert.match(
    unscanned.stderr,
    /FixtureLater is not an engine class: it is the class_name res:\/\/made\/later\.gd declares/,
    unscanned.stderr,
  );
  const ownMisspelt = runRefusedOperation(godotPath, projectDir, 'query_class_info', {
    class_name: 'FixtureHerp',
    project_classes: { FixtureHero: { path: 'res://made/hero.gd', extends: 'Node2D', abstract: false } },
  });
  assert.match(
    ownMisspelt.stderr,
    /Class not found: FixtureHerp\. The nearest class a project script declares is FixtureHero, which script_info structure reads\. editor_classes reads/,
    ownMisspelt.stderr,
  );
}

/**
 * A reference is missing only where the engine would fail to load it, and a missing one is named
 * in the summary as well as in the tree.
 *
 * Two shapes were called missing that load: an ext_resource whose path is stale and whose uid the
 * cache resolves, which is how a file moved outside the editor still loads, and a literal that is
 * a directory or the start of a path a script builds as it runs. A file that is really gone was one
 * `exists: false` deep in the tree, which a caller reading the summary never met.
 */
function testAReferenceIsMissingOnlyWhereTheEngineMissesIt(godotPath: string, _projectDir: string): void {
  const dir = createProject(godotPath);
  const operation = (name: string, params: unknown): unknown => runOperation(godotPath, dir, name, params);
  const importAll = (): void => {
    const run = spawnSyncHidden(godotPath, ['--headless', '--path', dir, '--import'], {
      encoding: 'utf8',
      timeout: 180_000,
    });
    assert.equal(run.status, 0, `the project should import: ${run.stdout}\n${run.stderr}`);
  };
  try {
    writeFileSync(join(dir, 'leaf.gd'), 'extends Node\n');
    importAll();
    const uid = readFileSync(join(dir, 'leaf.gd.uid'), 'utf8').trim();
    assert.match(uid, /^uid:\/\/[a-z0-9]+$/, 'the import mints the script a uid');
    // Moved with its sidecar and imported again, so the cache has the uid at the new place while
    // the scene still names the old one.
    mkdirSync(join(dir, 'moved'));
    for (const name of ['leaf.gd', 'leaf.gd.uid']) {
      writeFileSync(join(dir, 'moved', name), readFileSync(join(dir, name)));
      rmSync(join(dir, name));
    }
    writeFileSync(
      join(dir, 'stage.tscn'),
      `[gd_scene format=3]\n\n[ext_resource type="Script" uid="${uid}" path="res://leaf.gd" id="1_leaf"]\n[ext_resource type="Texture2D" path="res://gone.png" id="2_gone"]\n\n[node name="Stage" type="Node"]\nscript = ExtResource("1_leaf")\n`,
    );
    writeFileSync(
      join(dir, 'top.tscn'),
      '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://stage.tscn" id="1_stage"]\n\n[node name="Top" type="Node"]\n\n[node name="Stage" parent="." instance=ExtResource("1_stage")]\n',
    );
    writeFileSync(
      join(dir, 'walker.gd'),
      'extends Node\n\nconst Leaf = preload("res://moved/leaf.gd")\n\n\nfunc level(n: int) -> String:\n\treturn "res://levels/" + str(n) + ".tscn"\n',
    );
    importAll();

    const stage = operation('get_dependencies', { resource_path: 'res://stage.tscn' });
    assert.deepEqual(
      asArray(get(stage, 'dependencies', 'res://stage.tscn')).map((dep) => [
        get(dep, 'path'),
        get(dep, 'exists'),
      ]),
      [
        ['res://moved/leaf.gd', true],
        ['res://gone.png', false],
      ],
      `the moved script is followed by its uid and the gone image is missing: ${JSON.stringify(stage)}`,
    );
    assert.equal(
      get(asArray(get(stage, 'dependencies', 'res://stage.tscn'))[0], 'stale_path'),
      'res://leaf.gd',
      'with the path the scene still writes',
    );
    // Asked what uses the old path, the line is no use of it, since the engine loads the moved file.
    const old = operation('find_resource_usages', { resource_path: 'res://leaf.gd' });
    assert.deepEqual(
      [
        get(old, 'exists'),
        asArray(get(old, 'usages')).map((usage) => [get(usage, 'file'), get(usage, 'references')]),
        get(old, 'summary', 'in_code'),
      ],
      [
        false,
        [
          [
            'res://stage.tscn',
            [
              {
                line: 3,
                kind: 'stale_path',
                text: `[ext_resource type="Script" uid="${uid}" path="res://leaf.gd" id="1_leaf"]`,
                loads: 'res://moved/leaf.gd',
              },
            ],
          ],
        ],
        0,
      ],
      JSON.stringify(old),
    );
    const moved = operation('find_resource_usages', { resource_path: 'res://moved/leaf.gd' });
    const fromStage = asArray(get(moved, 'usages')).find(
      (usage) => get(usage, 'file') === 'res://stage.tscn',
    );
    assert.deepEqual(
      asArray(get(fromStage, 'references')).map((reference) => [
        get(reference, 'kind'),
        get(reference, 'stale_path'),
      ]),
      [['ext_resource', 'res://leaf.gd']],
      `the moved file is used by its uid, under a path that is stale: ${JSON.stringify(moved)}`,
    );
    // The uid wins over a path that has a file again, as the engine loads it.
    writeFileSync(join(dir, 'leaf.gd'), 'extends Node2D\n');
    assert.deepEqual(
      asArray(
        get(
          operation('get_dependencies', { resource_path: 'res://stage.tscn' }),
          'dependencies',
          'res://stage.tscn',
        ),
      ).map((dep) => [get(dep, 'path'), get(dep, 'stale_path')]),
      [
        ['res://moved/leaf.gd', 'res://leaf.gd'],
        ['res://gone.png', undefined],
      ],
      'a file back at the old path is not what the scene loads',
    );
    rmSync(join(dir, 'leaf.gd'));
    const top = operation('get_dependencies', { resource_path: 'res://top.tscn' });
    assert.deepEqual(
      get(top, 'summary', 'missing'),
      [{ path: 'res://gone.png', referenced_by: ['res://stage.tscn'] }],
      `the summary names the missing file and the scene that refers to it, not the one asked about: ${JSON.stringify(top)}`,
    );
    const walker = operation('get_dependencies', { resource_path: 'res://walker.gd' });
    assert.deepEqual(
      asArray(get(walker, 'dependencies', 'res://walker.gd')).map((dep) => get(dep, 'path')),
      ['res://moved/leaf.gd'],
      `a path built at run time is no dependency: ${JSON.stringify(walker)}`,
    );
    assert.deepEqual(get(walker, 'summary', 'missing'), [], 'and nothing is missing from it');

    // A uid the project does not know: beside a path that has the file, the engine warns and loads
    // the path, and loaded on its own it names nothing, which the game reports as an unrecognised
    // uid at that line. The walk followed the first without a word and passed over the second.
    writeFileSync(
      join(dir, 'old.tscn'),
      '[gd_scene format=3]\n\n[ext_resource type="Script" uid="uid://c0ld0ldst4le1" path="res://moved/leaf.gd" id="1_leaf"]\n\n[node name="Old" type="Node"]\nscript = ExtResource("1_leaf")\n',
    );
    writeFileSync(
      join(dir, 'badge.gd'),
      'extends Node\n\n\nfunc _ready() -> void:\n\tvar badge: Texture2D = load("uid://b4dn0th1ngh3r")\n\tprint(badge)\n',
    );
    const oldScene = operation('get_dependencies', { resource_path: 'res://old.tscn' });
    assert.deepEqual(
      asArray(get(oldScene, 'dependencies', 'res://old.tscn')).map((dep) => [
        get(dep, 'path'),
        get(dep, 'exists'),
        get(dep, 'unknown_uid'),
      ]),
      [['res://moved/leaf.gd', true, 'uid://c0ld0ldst4le1']],
      `followed by its path, with the uid that names nothing: ${JSON.stringify(oldScene)}`,
    );
    const fromOld = asArray(
      get(operation('find_resource_usages', { resource_path: 'res://moved/leaf.gd' }), 'usages'),
    ).find((usage) => get(usage, 'file') === 'res://old.tscn');
    assert.deepEqual(
      asArray(get(fromOld, 'references')).map((reference) => [
        get(reference, 'kind'),
        get(reference, 'unknown_uid'),
      ]),
      [['ext_resource', 'uid://c0ld0ldst4le1']],
      `and asked what uses the file, the same line says so: ${JSON.stringify(fromOld)}`,
    );
    const badge = operation('get_dependencies', { resource_path: 'res://badge.gd' });
    assert.deepEqual(
      [
        asArray(get(badge, 'dependencies', 'res://badge.gd')).map((dep) => [
          get(dep, 'path'),
          get(dep, 'exists'),
        ]),
        get(badge, 'summary', 'missing'),
      ],
      [
        [['uid://b4dn0th1ngh3r', false]],
        [{ path: 'uid://b4dn0th1ngh3r', referenced_by: ['res://badge.gd'] }],
      ],
      `a load of a uid nothing has is missing: ${JSON.stringify(badge)}`,
    );
    assert.match(
      JSON.stringify(operation('validate_project', {})),
      /uid:\/\/b4dn0th1ngh3r does not exist, and res:\/\/badge\.gd refers to it/,
      'and validation names it with the script loading it',
    );
    rmSync(join(dir, 'old.tscn'));
    rmSync(join(dir, 'badge.gd'));

    // A folder is refused as one, in both directions, where it was refused as a file not there.
    for (const [name, asked] of [
      ['get_dependencies', 'res://moved'],
      ['find_resource_usages', 'res://moved/'],
    ] as const) {
      assert.match(
        runRefusedOperation(godotPath, dir, name, { resource_path: asked }).stderr,
        /res:\/\/moved is a folder, and project_dependencies follows one file: name a file in it\./,
        `${name} on a folder`,
      );
    }

    // A path nothing is at is refused with the files of its kind nearest it, or every one of few.
    assert.match(
      runRefusedOperation(godotPath, dir, 'get_dependencies', { resource_path: 'res://stagee.tscn' }).stderr,
      /Resource file does not exist: res:\/\/stagee\.tscn\. The nearest \.tscn file is res:\/\/stage\.tscn\./,
    );
    assert.match(
      runRefusedOperation(godotPath, dir, 'get_import_status', { resource_path: 'res://qq.tscn' }).stderr,
      /Nothing is at res:\/\/qq\.tscn, and no import sidecar names it\. The project's \.tscn files are res:\/\/stage\.tscn, res:\/\/top\.tscn\./,
    );
    assert.match(
      runRefusedOperation(godotPath, dir, 'find_resource_usages', { resource_path: 'res://glow.gdshader' })
        .stderr,
      /Resource file does not exist: res:\/\/glow\.gdshader, and nothing in the project refers to it\. The project holds no \.gdshader file\./,
    );
    // A gone file something still refers to is searched for, since that is what is asked of one.
    const gone = operation('find_resource_usages', { resource_path: 'res://gone.png' });
    assert.deepEqual(
      [
        get(gone, 'exists'),
        asArray(get(gone, 'usages')).map((usage) => [
          get(usage, 'file'),
          asArray(get(usage, 'references')).map((reference) => get(reference, 'kind')),
        ]),
      ],
      [false, [['res://stage.tscn', ['ext_resource']]]],
      JSON.stringify(gone),
    );
    // Every operation that reads a named file refuses one that is not there the same way. A script
    // named unlike the operations and addons this project carries, which are scripts of it too.
    writeFileSync(join(dir, 'zebra_pen.gd'), 'extends Node\n');
    const nearStage = 'The nearest .tscn file is res://stage.tscn.';
    const nearZebra = 'The nearest .gd file is res://zebra_pen.gd.';
    for (const [name, params, said] of [
      [
        'set_main_scene',
        { scene_path: 'res://stagee.tscn' },
        `Scene file does not exist: res://stagee.tscn. ${nearStage}`,
      ],
      [
        'get_uid',
        { resource_path: 'res://stagee.tscn' },
        `File does not exist: res://stagee.tscn. ${nearStage}`,
      ],
      // A misspelt extension has no file of its own extension to be near.
      [
        'get_uid',
        { resource_path: 'res://stage.tcsn' },
        'File does not exist: res://stage.tcsn. The file of that name beside it is res://stage.tscn.',
      ],
      // Offered although the refusal's own path, res://stage.tscnn, holds its name.
      [
        'get_uid',
        { resource_path: 'res://stage.tscnn' },
        'File does not exist: res://stage.tscnn. The file of that name beside it is res://stage.tscn.',
      ],
      [
        'read_resource',
        { resource_path: 'res://stage.tcsn' },
        'No resource at res://stage.tcsn. The file of that name beside it is res://stage.tscn.',
      ],
      [
        'add_autoload',
        { name: 'Zebra', path: 'res://zebra_pn.gd' },
        `Autoload file does not exist: res://zebra_pn.gd. ${nearZebra}`,
      ],
      [
        'get_script_info',
        { script_path: 'res://zebra_pn.gd' },
        `Script file does not exist: res://zebra_pn.gd. ${nearZebra}`,
      ],
      // A scene was read as a script with nothing in it that extends RefCounted.
      [
        'get_script_info',
        { script_path: 'res://stage.tscn' },
        "res://stage.tscn is not a GDScript file, and script_info reads .gd files only: scene_tree reads a scene's nodes, and with properties the script each carries.",
      ],
      [
        'get_script_info',
        { script_path: 'kept.tres' },
        'res://kept.tres is not a GDScript file, and script_info reads .gd files only: resource_edit read reads a resource.',
      ],
      [
        'get_script_info',
        { script_path: 'res://notes.txt' },
        'res://notes.txt is not a GDScript file, and script_info reads .gd files only.',
      ],
      [
        'modify_script',
        { script_path: 'res://zebra_pn.gd', modifications: [{ type: 'add_signal', name: 'went' }] },
        `Script file does not exist: res://zebra_pn.gd. ${nearZebra}`,
      ],
    ] as const) {
      const refused = runRefusedOperation(godotPath, dir, name, params).stderr;
      assert.ok(refused.includes(said), `${name}: ${refused}`);
    }
    mkdirSync(join(dir, 'pile'));
    for (let at = 0; at < 13; at += 1) {
      writeFileSync(
        join(dir, 'pile', `p${at}.tres`),
        '[gd_resource type="Resource" format=3]\n\n[resource]\n',
      );
    }
    assert.match(
      runRefusedOperation(godotPath, dir, 'get_dependencies', { resource_path: 'res://zzzz.tres' }).stderr,
      /Resource file does not exist: res:\/\/zzzz\.tres\. None of the project's 13 \.tres files is named like it\./,
    );
  } finally {
    sweep(dir);
  }
}

/**
 * A uid is followed to the file declaring it before the project has been imported, as on a fresh
 * clone or a CI checkout, where the engine has no uid cache until its first import.
 *
 * The walk asked only the cache, so every uid named no file: a scene moved outside the editor was
 * missing under its old path with its uid called unknown, which is wrong for every project that
 * has not been opened yet. Each place a file declares its uid is used once: a scene's header, a
 * script's .uid sidecar and an image's import sidecar.
 */
function testAUidIsFollowedBeforeAnyImport(godotPath: string, _projectDir: string): void {
  const dir = createProject(godotPath);
  const operation = (name: string, params: unknown): unknown => runOperation(godotPath, dir, name, params);
  try {
    mkdirSync(join(dir, 'items'));
    writeFileSync(
      join(dir, 'items', 'chest.tscn'),
      '[gd_scene format=3 uid="uid://bm0v3dch3st"]\n\n[node name="Chest" type="Node"]\n',
    );
    writeFileSync(
      join(dir, 'hall.tscn'),
      '[gd_scene format=3]\n\n[ext_resource type="PackedScene" uid="uid://bm0v3dch3st" path="res://old/chest.tscn" id="1_chest"]\n\n[node name="Hall" type="Node"]\n\n[node name="Chest" parent="." instance=ExtResource("1_chest")]\n',
    );
    writeFileSync(join(dir, 'coin.gd'), 'extends Node\n');
    writeFileSync(join(dir, 'coin.gd.uid'), 'uid://c01ns1d3c4r\n');
    writeFileSync(join(dir, 'badge.png'), 'not read as an image here\n');
    writeFileSync(
      join(dir, 'badge.png.import'),
      '[remap]\n\nimporter="texture"\ntype="CompressedTexture2D"\nuid="uid://b4dg3s1d3c4r"\n',
    );
    writeFileSync(
      join(dir, 'bank.gd'),
      'extends Node\n\n\nfunc _ready() -> void:\n\tprint(load("uid://c01ns1d3c4r"), load("uid://b4dg3s1d3c4r"))\n',
    );

    const hall = operation('get_dependencies', { resource_path: 'res://hall.tscn' });
    assert.deepEqual(
      [
        asArray(get(hall, 'dependencies', 'res://hall.tscn')).map((dep) => [
          get(dep, 'path'),
          get(dep, 'exists'),
          get(dep, 'stale_path'),
          get(dep, 'unknown_uid'),
        ]),
        get(hall, 'summary', 'missing'),
      ],
      [[['res://items/chest.tscn', true, 'res://old/chest.tscn', undefined]], []],
      `the scene's uid leads to the file whose header declares it: ${JSON.stringify(hall)}`,
    );
    const old = operation('find_resource_usages', { resource_path: 'res://old/chest.tscn' });
    assert.deepEqual(
      asArray(get(old, 'usages')).map((usage) =>
        asArray(get(usage, 'references')).map((reference) => [
          get(usage, 'file'),
          get(reference, 'kind'),
          get(reference, 'loads'),
        ]),
      ),
      [[['res://hall.tscn', 'stale_path', 'res://items/chest.tscn']]],
      `asked what uses the old path, the line loads the moved scene: ${JSON.stringify(old)}`,
    );
    const bank = operation('get_dependencies', { resource_path: 'res://bank.gd' });
    assert.deepEqual(
      [
        asArray(get(bank, 'dependencies', 'res://bank.gd')).map((dep) => [
          get(dep, 'path'),
          get(dep, 'exists'),
        ]),
        get(bank, 'summary', 'missing'),
      ],
      [
        [
          ['res://coin.gd', true],
          ['res://badge.png', true],
        ],
        [],
      ],
      `a load by uid reaches the files their sidecars declare it for: ${JSON.stringify(bank)}`,
    );
    assert.ok(
      !existsSync(join(dir, '.godot', 'uid_cache.bin')),
      'the operations ran on a project the engine has never imported',
    );

    // Imported, then moved with its sidecar: the cache names a path with no file, and the file
    // declaring the uid is where the next import puts it.
    const run = spawnSyncHidden(godotPath, ['--headless', '--path', dir, '--import'], {
      encoding: 'utf8',
      timeout: 180_000,
    });
    assert.equal(run.status, 0, `the project should import: ${run.stdout}\n${run.stderr}`);
    assert.ok(existsSync(join(dir, '.godot', 'uid_cache.bin')), 'the import writes the uid cache');
    mkdirSync(join(dir, 'moved'));
    for (const name of ['coin.gd', 'coin.gd.uid']) {
      writeFileSync(join(dir, 'moved', name), readFileSync(join(dir, name)));
      rmSync(join(dir, name));
    }
    const movedBank = operation('get_dependencies', { resource_path: 'res://bank.gd' });
    assert.deepEqual(
      asArray(get(movedBank, 'dependencies', 'res://bank.gd')).map((dep) => [
        get(dep, 'path'),
        get(dep, 'exists'),
      ]),
      [
        ['res://moved/coin.gd', true],
        ['res://badge.png', true],
      ],
      `a cached path with no file gives way to the file declaring the uid: ${JSON.stringify(movedBank)}`,
    );
  } finally {
    sweep(dir);
  }
}

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
    const run = spawnSyncHidden(godotPath, ['--headless', '--path', dir, '--import'], {
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

  // An addon gdharness installed is not the project's, told by the marker setup writes and not by
  // its name; an addon the project wrote is. And a WebP texture is something the engine imports,
  // which the health check counted as nothing beside five other formats.
  const installed = join(projectDir, 'addons', 'installed_tool');
  const theirs = join(projectDir, 'addons', 'their_tool');
  mkdirSync(installed, { recursive: true });
  mkdirSync(theirs, { recursive: true });
  const checkedImports = (): number =>
    asNumber(get(operation('get_project_health', {}), 'checks', 'resources', 'importable_files'));
  const checkedBefore = checkedImports();
  try {
    writeFileSync(join(installed, '.gdharness-version'), '1.2.15\n');
    writeFileSync(join(installed, 'tooling.gd'), 'extends Node\n');
    writeFileSync(join(theirs, 'theirs.gd'), 'extends Node\n');
    writeFileSync(join(projectDir, 'made', 'pic.webp'), '');
    writeFileSync(join(projectDir, 'made', 'pic.webp.import'), '');
    assert.equal(
      scripts(),
      scriptsBefore + 2,
      "the project's own addon counts and the installed one does not",
    );
    assert.equal(
      checkedImports(),
      checkedBefore + 1,
      'and the WebP is counted among what the engine imports',
    );
  } finally {
    rmSync(installed, { recursive: true, force: true });
    rmSync(theirs, { recursive: true, force: true });
    rmSync(join(projectDir, 'made', 'pic.webp'), { force: true });
    rmSync(join(projectDir, 'made', 'pic.webp.import'), { force: true });
  }

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

  const bench = spawnHidden(
    godotPath,
    ['--headless', '--path', project, '--script', join(project, 'bench.gd')],
    {
      stdio: 'ignore',
      env: userDataIn(home),
    },
  );
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
      // class is used by name in code alone keeps from counting. The autoload's name is one no
      // shipped script's prose holds: named Auto, it was found in an addon comment opening "Auto".
      `${readFileSync(join(dir, 'project.godot'), 'utf8')}\n[autoload]\n\nAutoProbe="*res://auto/autoload.gd"\n\n[application]\n\nrun/main_scene="uid://c4c550daekhi1"\n\n[input]\n\nEnemy={\n"deadzone": 0.5,\n"events": []\n}\n`,
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
    // A path a comment names is not a dependency, in any of the three places a comment sits; the
    // shipped serialisation module's example path was one of every project with the addon.
    writeFileSync(
      join(dir, 'sub', 'commented.gd'),
      'extends Node\n## Loads b.gd, as res://sub/ghost_doc.gd once did.\n# res://sub/ghost_line.gd\n' +
        'const B = preload("res://sub/b.gd")  # in place of res://sub/ghost_trailing.gd\n',
    );
    assert.deepEqual(
      asArray(
        get(
          operation('get_dependencies', { resource_path: 'sub/commented.gd' }),
          'dependencies',
          'res://sub/commented.gd',
        ),
      ).map((dep) => get(dep, 'path')),
      ['res://sub/b.gd'],
      'a path named in a comment is not walked',
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
    // The forward walk follows the same use, and the reverse answer above is the one it has to agree with.
    assert.deepEqual(
      get(operation('get_dependencies', { resource_path: 'spawner.gd' }), 'dependencies', 'res://spawner.gd'),
      [{ path: 'res://enemy.gd', exists: true, by_class: 'Enemy' }],
      'a script depends on the script whose class_name it types a variable with',
    );
    writeFileSync(
      join(dir, 'herald.gd'),
      'extends Node\n## Announces an Enemy.\n\n\nfunc say() -> void:\n\tprint("Enemy")  # an Enemy\n',
    );
    assert.deepEqual(
      get(operation('get_dependencies', { resource_path: 'herald.gd' }), 'dependencies', 'res://herald.gd'),
      [],
      'a class named in a string, a comment or documentation is not depended on',
    );
    // script_info structure reads the same uses, so the two tools name the same dependencies.
    const structure = (path: string): unknown[] => {
      const info = operation('get_script_info', { script_path: path });
      return [get(info, 'dependencies'), get(info, 'classes_used')];
    };
    assert.deepEqual(
      structure('spawner.gd'),
      [['res://enemy.gd'], [{ name: 'Enemy', path: 'res://enemy.gd' }]],
      'script_info lists the script whose class_name the code uses',
    );
    assert.deepEqual(structure('herald.gd'), [[], []], 'and not one named only in words');
    assert.deepEqual(structure('enemy.gd'), [[], []], 'nor a script for its own name');

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
    // Reached through b and directly, c, d and e each sit in the tree twice and are four files.
    const whole = operation('get_dependencies', { resource_path: 'sub/chain_a.gd' });
    assert.deepEqual(
      [get(whole, 'summary', 'total_dependencies'), get(whole, 'summary', 'total_references')],
      [4, 7],
      `four files, seven entries: ${JSON.stringify(get(whole, 'dependencies'))}`,
    );
    // At depth three, d is reached through b and c at the limit and says it names one more file,
    // while e at the limit names none and says nothing.
    const throughB = asArray(
      get(
        walked.find((dep) => get(dep, 'path') === 'res://sub/chain_b.gd'),
        'dependencies',
      ),
    );
    assert.deepEqual(
      asArray(get(throughB[0], 'dependencies')),
      [{ path: 'res://sub/chain_d.gd', exists: true, beyond_depth: 1 }],
      `the depth stopped the walk at d, which names e: ${JSON.stringify(walked)}`,
    );
    assert.deepEqual(
      asArray(get(asArray(get(shortcut, 'dependencies'))[0], 'dependencies')),
      [{ path: 'res://sub/chain_e.gd', exists: true }],
      'and e names nothing',
    );

    // A shader includes relative to itself, as the preprocessor reads it, and its comments are // and
    // /* */: a # there opens a directive. A word in a shader is no use of a class.
    const enemyUses = kinds('enemy.gd');
    mkdirSync(join(dir, 'sub', 'parts'));
    writeFileSync(
      join(dir, 'sub', 'glow.gdshader'),
      'shader_type canvas_item;\n// once #include "res://sub/ghost_line.gdshaderinc"\n/* and\n#include "res://sub/ghost_block.gdshaderinc" */\n' +
        '#include "parts/tint.gdshaderinc" // after "res://sub/ghost_trailing.gdshaderinc"\nuniform float Enemy;\n',
    );
    writeFileSync(
      join(dir, 'sub', 'parts', 'tint.gdshaderinc'),
      '#include "res://sub/more.gdshaderinc"\nvec4 tinted(vec4 c) {\n\treturn more(c);\n}\n',
    );
    writeFileSync(join(dir, 'sub', 'more.gdshaderinc'), 'vec4 more(vec4 c) {\n\treturn c;\n}\n');
    assert.deepEqual(
      get(
        operation('get_dependencies', { resource_path: 'sub/glow.gdshader' }),
        'dependencies',
        'res://sub/glow.gdshader',
      ),
      [
        {
          path: 'res://sub/parts/tint.gdshaderinc',
          exists: true,
          dependencies: [{ path: 'res://sub/more.gdshaderinc', exists: true }],
        },
      ],
      'the relative include is followed, the include in it too, and no comment is',
    );
    assert.deepEqual(
      kinds('sub/parts/tint.gdshaderinc'),
      { include: 1 },
      'an include is a use, not a comment',
    );
    assert.deepEqual(kinds('sub/more.gdshaderinc'), { include: 1 }, 'and one inside an include is found');
    assert.deepEqual(
      [
        kinds('sub/ghost_line.gdshaderinc'),
        kinds('sub/ghost_block.gdshaderinc'),
        kinds('sub/ghost_trailing.gdshaderinc'),
      ],
      [{ comment: 1 }, { comment: 1 }, { comment: 1 }],
      'a path in a shader comment is a mention',
    );
    assert.equal(get(enemyUses, 'class_name'), 1, JSON.stringify(enemyUses));
    assert.deepEqual(kinds('enemy.gd'), enemyUses, 'and a uniform named like a class is no use of it');
    // An ext_resource path relative to its scene, under a word holding load.
    writeFileSync(
      join(dir, 'sub', 'loader.tscn'),
      '[gd_scene format=3]\n\n[ext_resource type="Texture2D" path="art/loading.png" id="1_l"]\n\n[node name="Loader" type="Sprite2D"]\ntexture = ExtResource("1_l")\n',
    );
    assert.deepEqual(
      get(
        operation('get_dependencies', { resource_path: 'sub/loader.tscn' }),
        'dependencies',
        'res://sub/loader.tscn',
      ),
      [{ path: 'res://sub/art/loading.png', exists: false }],
      'the path is read from path=, not the first quoted value on the line',
    );
  } finally {
    sweep(dir);
  }
}

/**
 * Each script compiled as the engine loads it, judged by the errors it raises. An abstract class
 * compiles and cannot be instantiated, and a script whose dependency fails is handed back as one
 * that can, so neither can_instantiate() answer says whether a script compiles.
 */
function testScriptsAreCompiled(godotPath: string): void {
  const dir = createProject(godotPath);
  try {
    mkdirSync(join(dir, 'checked'));
    writeFileSync(
      join(dir, 'checked', 'broken.gd'),
      'extends Node\n\n\nfunc hit() -> void:\n\trage()\n\tprint(undefined_thing)\n',
    );
    writeFileSync(
      join(dir, 'checked', 'dependent.gd'),
      'extends Node\n\nconst Broken = preload("res://checked/broken.gd")\n',
    );
    writeFileSync(join(dir, 'checked', 'shape.gd'), '@abstract\nclass_name Shape\nextends Node\n');
    writeFileSync(join(dir, 'checked', 'fine.gd'), 'extends Node\n');
    // Through the run rather than runOperation, which refuses anything on stderr: the engine prints
    // every compile error it raises there as well.
    const check = (...names: string[]): unknown => {
      const run = runOperationScript(godotPath, dir, 'check_scripts', {
        paths: names.map((name) => `res://checked/${name}.gd`),
      });
      assert.equal(run.status, 0, run.stderr);
      return run.answer;
    };

    // Up to the first failure and no further, since a script loaded after it that loads it would
    // compile in silence in the same engine.
    const first = check('shape', 'fine', 'broken', 'dependent');
    assert.deepEqual(
      [get(first, 'checked'), get(first, 'failed')],
      [
        ['res://checked/shape.gd', 'res://checked/fine.gd', 'res://checked/broken.gd'],
        ['res://checked/broken.gd'],
      ],
      `the abstract script compiles, and the run ends at the broken one: ${JSON.stringify(first)}`,
    );
    assert.deepEqual(
      get(first, 'scripts'),
      [
        {
          path: 'res://checked/broken.gd',
          errors: [
            { line: 5, message: 'Parse Error: Function "rage()" not found in base self.' },
            {
              line: 6,
              message: 'Parse Error: Identifier "undefined_thing" not declared in the current scope.',
            },
          ],
        },
      ],
      `each error at its own line: ${JSON.stringify(first)}`,
    );
    const rest = check('dependent');
    assert.deepEqual(
      get(rest, 'scripts'),
      [
        {
          path: 'res://checked/dependent.gd',
          errors: [{ line: 0, message: 'Compile Error: Failed to compile depended scripts.' }],
          dependencies_with_errors: ['res://checked/broken.gd'],
        },
      ],
      `a script whose dependency fails, in an engine of its own, says so: ${JSON.stringify(rest)}`,
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

    // An override names its base setting, and one the file does not set is not a setting nobody
    // knows: a build with its feature reads the base setting, which the answer holds.
    const set = runOperation(godotPath, dir, 'get_project_setting', {
      setting: 'application/config/description.windows',
    });
    assert.deepEqual(
      [get(set, 'exists'), get(set, 'value'), get(set, 'override_of'), get(set, 'message')],
      [true, 'on windows', 'application/config/description', undefined],
      JSON.stringify(set),
    );
    const unsetOverride = runOperation(godotPath, dir, 'get_project_setting', {
      setting: 'application/config/description.mobile',
    });
    assert.deepEqual(
      [
        get(unsetOverride, 'exists'),
        get(unsetOverride, 'override_of'),
        get(unsetOverride, 'holds'),
        get(unsetOverride, 'message'),
      ],
      [
        false,
        'application/config/description',
        'plain',
        'project.godot sets no mobile override of application/config/description, so a build with the mobile feature reads application/config/description, the value under holds, unless it also has a feature with an override: editor, windows.',
      ],
      JSON.stringify(unsetOverride),
    );
    const unknown = runOperation(godotPath, dir, 'get_project_setting', {
      setting: 'application/config/nothing.mobile',
    });
    assert.deepEqual(
      [get(unknown, 'exists'), get(unknown, 'holds'), get(unknown, 'message')],
      [false, undefined, 'Setting does not exist'],
      `an override of a setting nothing declares has nothing to fall back to: ${JSON.stringify(unknown)}`,
    );
    const family = asArray(
      get(
        runOperation(godotPath, dir, 'get_project_setting', { prefix: 'application/config/description' }),
        'settings',
      ),
    );
    assert.deepEqual(
      family.map((one) => [get(one, 'setting'), get(one, 'override_of')]),
      [
        ['application/config/description', undefined],
        ['application/config/description.editor', 'application/config/description'],
        ['application/config/description.windows', 'application/config/description'],
      ],
      JSON.stringify(family),
    );

    // Taking an override out says what its builds read now, which default_value, null for an
    // override, does not.
    const taken = runOperation(godotPath, dir, 'unset_project_setting', {
      setting: 'application/config/description.windows',
    });
    const fallsBack =
      'project.godot sets no windows override of application/config/description, so a build with the windows feature reads application/config/description, the value under holds, unless it also has a feature with an override: editor.';
    assert.deepEqual(
      [get(taken, 'removed'), get(taken, 'override_of'), get(taken, 'holds'), get(taken, 'note')],
      [true, 'application/config/description', 'plain', fallsBack],
      JSON.stringify(taken),
    );
    assert.doesNotMatch(readFileSync(join(dir, 'project.godot'), 'utf8'), /description\.windows/);
    const again = runOperation(godotPath, dir, 'unset_project_setting', {
      setting: 'application/config/description.windows',
    });
    assert.deepEqual(
      [get(again, 'removed'), get(again, 'holds'), get(again, 'note')],
      [
        false,
        'plain',
        `project.godot does not set application/config/description.windows, so there was nothing to take out. ${fallsBack}`,
      ],
      JSON.stringify(again),
    );
    // A new override is not a misspelt setting, so it is written with no nearest names offered.
    const back = runOperation(godotPath, dir, 'set_project_setting', {
      setting: 'application/config/description.windows',
      value: 'on windows again',
    });
    assert.deepEqual([get(back, 'saved'), get(back, 'note')], [true, undefined], JSON.stringify(back));
  } finally {
    sweep(dir);
  }
}

/**
 * A family read says which of its settings the project sets. `input/` answers the ninety actions the
 * engine ships beside the project's own, and without `at_default` on each a caller after the one it
 * added read them all. Three kinds are rendered: a setting the project changed, one it left alone,
 * and an action only the project defines, which the engine registers no default for.
 */
function testAFamilySaysWhatTheProjectSets(godotPath: string): void {
  const dir = createProject(godotPath);
  try {
    writeFileSync(
      join(dir, 'project.godot'),
      `${readFileSync(join(dir, 'project.godot'), 'utf8')}\n[input]\n\njump={\n"deadzone": 0.5,\n"events": []\n}\n`,
    );
    const entry = (prefix: string, setting: string): unknown =>
      asArray(get(runOperation(godotPath, dir, 'get_project_setting', { prefix }), 'settings')).find(
        (one) => get(one, 'setting') === setting,
      );
    // The fixture sets every warning to error, so a warning is the setting it changed.
    const changed = entry('debug/gdscript/warnings/', 'debug/gdscript/warnings/unsafe_call_argument');
    assert.equal(
      get(changed, 'at_default'),
      false,
      `a setting the project changed: ${JSON.stringify(changed)}`,
    );
    const untouched = entry('application/run/', 'application/run/max_fps');
    assert.equal(get(untouched, 'at_default'), true, `one it left alone: ${JSON.stringify(untouched)}`);
    const shipped = entry('input/', 'input/ui_accept');
    assert.equal(get(shipped, 'at_default'), true, `an action the engine ships: ${JSON.stringify(shipped)}`);
    const own = entry('input/', 'input/jump');
    assert.ok(own !== undefined, 'the project-defined action is listed');
    assert.equal(get(own, 'at_default'), undefined, `and has no default to be at: ${JSON.stringify(own)}`);
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
    // Past the limit by these alone: validation passes over installed addons, so the fixture's own
    // scripts count for nothing.
    for (let index = 0; index < 110; index++) {
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
 * Validation and health name each scene connection whose method or signal is not there, judging
 * the node by its type, its script and every script that script extends, by path or by class_name,
 * and leave alone every node the text cannot settle.
 *
 * A connection to a method nobody wrote loads without a word and fails on every emission, and one
 * from a signal the node lacks is dropped as the scene loads, so neither shows until the game runs.
 */
function testAConnectionNamesWhatItReaches(godotPath: string): void {
  const dir = createProject(godotPath);
  try {
    mkdirSync(join(dir, 'conn'));
    const files: Record<string, string> = {
      'base.gd': 'extends Node\n\nsignal shouted\n\n\nfunc greet() -> void:\n\tpass\n',
      'named_base.gd': 'class_name GdhFixtureBase extends Node2D\n\n\nfunc wave() -> void:\n\tpass\n',
      'hero.gd':
        'extends "base.gd"\n\n\nfunc _on_go() -> void:\n\tpass\n\n\nclass Inner:\n' +
        '\tfunc hidden_method() -> void:\n\t\tpass\n',
      'waver.gd': '@tool extends GdhFixtureBase\n',
      'loop_a.gd': 'extends "loop_b.gd"\n',
      'loop_b.gd': 'extends "loop_a.gd"\n',
      'part.tscn':
        '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://conn/base.gd" id="1"]\n\n' +
        '[node name="Part" type="Node2D"]\nscript = ExtResource("1")\n',
      'inherited.tscn':
        '[gd_scene format=3]\n\n[ext_resource type="PackedScene" path="res://conn/part.tscn" id="1"]\n\n' +
        '[node name="Derived" instance=ExtResource("1")]\n\n' +
        '[connection signal="ready" from="." to="." method="missing_here"]\n' +
        '[connection signal="ready" from="." to="." method="greet"]\n',
      'main.tscn':
        '[gd_scene format=3]\n\n' +
        '[ext_resource type="Script" path="res://conn/hero.gd" id="1"]\n' +
        '[ext_resource type="Script" path="res://conn/waver.gd" id="2"]\n' +
        '[ext_resource type="PackedScene" path="res://conn/part.tscn" id="3"]\n' +
        '[ext_resource type="Script" path="res://conn/loop_a.gd" id="4"]\n\n' +
        '[sub_resource type="GDScript" id="GDScript_in"]\nscript/source = "extends Node\n"\n\n' +
        '[node name="Hub" type="Node"]\nscript = ExtResource("1")\n\n' +
        '[node name="Go" type="Button" parent="."]\n\n' +
        '[node name="Wave" type="Node2D" parent="."]\nscript = ExtResource("2")\n\n' +
        '[node name="Part" parent="." instance=ExtResource("3")]\n\n' +
        '[node name="Looped" type="Node" parent="."]\nscript = ExtResource("4")\n\n' +
        '[node name="Builtin" type="Node" parent="."]\nscript = SubResource("GDScript_in")\n\n' +
        '[node name="Child" parent="Part"]\n\n' +
        '[node name="Dangling" type="Node" parent="."]\nscript = ExtResource("99")\n\n' +
        [
          ['pressed', 'Go', '.', '_on_go'],
          ['pressed', 'Go', '.', 'greet'],
          ['pressed', 'Go', '.', 'hidden_method'],
          ['pressed', 'Go', 'Wave', 'wave'],
          ['pressed', 'Go', 'Wave', 'queue_free'],
          ['pressed', 'Go', 'Wave', 'nope'],
          ['nope_signal', 'Go', '.', '_on_go'],
          ['shouted', '.', 'Part', 'greet'],
          ['shouted', '.', 'Part', 'absent_in_part'],
          ['pressed', 'Go', 'Looped', 'anything'],
          ['pressed', 'Go', 'Builtin', 'anything'],
          ['pressed', 'Go', 'Part/Child', 'anything'],
          ['pressed', 'Go', 'Dangling', 'anything'],
        ]
          .map(
            ([signal, from, to, method]) =>
              `[connection signal="${signal}" from="${from}" to="${to}" method="${method}"]\n`,
          )
          .join(''),
    };
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, 'conn', name), content);
    }
    const method = ', a method that node does not have, so every emission fails to call it.';
    const expected = [
      `res://conn/inherited.tscn connects Derived.ready to Derived.missing_here${method}`,
      `res://conn/main.tscn connects Go.nope_signal to Hub._on_go, a signal that node does not have, so the engine drops it as the scene loads.`,
      `res://conn/main.tscn connects Go.pressed to Hub.hidden_method${method}`,
      `res://conn/main.tscn connects Go.pressed to Wave.nope${method}`,
      `res://conn/main.tscn connects Hub.shouted to Part.absent_in_part${method}`,
    ];
    const validated = runOperation(godotPath, dir, 'validate_project', {});
    assert.ok(asArray(get(validated, 'checks_performed')).includes('connections'), JSON.stringify(validated));
    const warned = asArray(get(validated, 'warnings'))
      .filter((warning) => get(warning, 'check') === 'connections')
      .map((warning) => asString(get(warning, 'message')))
      .sort();
    assert.deepEqual(warned, expected, JSON.stringify(get(validated, 'warnings')));
    const health = runOperation(godotPath, dir, 'get_project_health', { categories: ['scenes'] });
    const noted = asArray(get(health, 'checks', 'scenes', 'details'))
      .map((detail) => asString(detail))
      .filter((detail) => detail.includes(' connects '))
      .sort();
    assert.deepEqual(noted, expected, JSON.stringify(health));
  } finally {
    sweep(dir);
  }
}

/**
 * Moves [sidecar]'s time two seconds past the second [importedAt] falls in, for a case that rewrites
 * a sidecar and then has `--import` act on it. The engine's filesystem cache keeps whole seconds and
 * asks the importer only about a sidecar whose time has moved, so a rewrite landing in the second
 * the import wrote it is never looked at: on a fast Linux runner it landed there and the engine
 * rebuilt nothing, once in the importer case and once in the font case. A sidecar somebody changes
 * is changed after its import, so this is the state those cases are about; the server's own
 * reimport forces the resources it names and does not depend on it.
 */
function pastTheImportsSecond(sidecar: string, importedAt: number): void {
  const at = new Date((Math.floor(importedAt / 1000) + 2) * 1000);
  utimesSync(sidecar, at, at);
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
    const run = spawnSyncHidden(godotPath, ['--headless', '--path', dir, '--import'], {
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
    const importedAt = statSync(sidecarPath).mtimeMs;
    writeFileSync(sidecarPath, older);
    writeFileSync(cachePath, readFileSync(cachePath, 'utf8').replace(md5(sidecar), md5(older)));
    pastTheImportsSecond(sidecarPath, importedAt);
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
        '\tpush_error("raised by the loud autoload")',
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
    // And so are its messages. Godot runs the autoloads in every script run, after the operation has
    // answered, and their errors rode on the answer as the operation's own.
    const raised = (entries: readonly { text: string }[] | undefined): boolean =>
      (entries ?? []).some((entry) => entry.text.includes('raised by the loud autoload'));
    assert.ok(
      raised(read.afterAnswerMessages),
      `the autoload's error is reported as printed after the answer: ${JSON.stringify(read.afterAnswerMessages)}`,
    );
    assert.ok(!raised(read.messages), `and not as the operation's: ${JSON.stringify(read.messages)}`);
    const extras = engineExtras(read);
    assert.match(
      String(get(extras, 'engine_messages_after_answer_note')),
      /^Printed after this operation had written its answer, while the engine ran the project's autoloads/,
      JSON.stringify(extras),
    );
    assert.ok(
      raised(get(extras, 'engine_messages_after_answer') as { text: string }[]),
      JSON.stringify(extras),
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
    const reads = join(operations, 'setting_reads.gd');
    const source = readFileSync(reads, 'utf8');
    const faulted = source.replace('"setting_path": setting_path,', '"setting_path": _faulty(),');
    assert.notEqual(faulted, source, 'the fault should have gone in where the answer is built');
    writeFileSync(
      reads,
      `${faulted}\n\nstatic func _faulty() -> String:\n\tvar none: Array = []\n\treturn none[1]\n`,
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
      /^get_project_setting hit an error in the operations script, so its answer is left out: .*Out of bounds get index '1'.* \(_faulty \(.*setting_reads\.gd:\d+\)\)$/,
      partial.message,
    );

    // An autoload whose script does not compile: the note still says the answer stands, and says
    // what it means for the project, which a raised error does not.
    assert.doesNotMatch(
      String(get(extras, 'engine_messages_after_answer_note')),
      /did not compile/,
      'an autoload that only raised an error is not called one that did not compile',
    );
    writeFileSync(
      join(dir, 'broken.gd'),
      'extends Node\n\n\nfunc greet() -> String:\n\treturn missing_name\n',
    );
    writeFileSync(
      join(dir, 'project.godot'),
      readFileSync(join(dir, 'project.godot'), 'utf8').replace(
        'Loud="*res://loud.gd"',
        'Loud="*res://loud.gd"\nBroken="*res://broken.gd"',
      ),
    );
    const beside = await runThroughTheServersOwnPath(
      engine,
      'get_project_setting',
      { setting: 'application/config/name' },
      dir,
    );
    assert.ok(beside.ok, `a read beside a broken autoload still answers: ${beside.ok ? '' : beside.message}`);
    assert.equal(get(beside.payload, 'value'), 'Answered', JSON.stringify(beside.payload));
    assert.match(
      String(get(engineExtras(beside), 'engine_messages_after_answer_note')),
      /none of these changes the answer\. res:\/\/broken\.gd did not compile, so every run of this project starts its autoloads without it until it is fixed; its errors are among these\.$/,
      JSON.stringify(engineExtras(beside)),
    );
  } finally {
    sweep(dir);
    sweep(operations);
  }
}

/**
 * A script naming an autoload compiles headless as it does in the game. The engine knows the name
 * only once the autoload is in the tree, after the operations script's `_init`, so compiled there
 * every such script failed with "Identifier not found". A wrong use of one still fails: the analyser
 * types the autoload from its script, which a type mismatch shows and a missing method does not,
 * since the engine warns about that one on any base but self.
 */
async function testAScriptNamingAnAutoloadCompiles(godotPath: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gdharness-autoloads-'));
  try {
    writeFileSync(
      join(dir, 'project.godot'),
      [
        'config_version=5',
        '',
        '[application]',
        'config/name="Autoloads"',
        '',
        '[autoload]',
        'Thing="*res://thing.gd"',
        'Noisy="*res://noisy.gd"',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'thing.gd'),
      'extends Node\n\n\nfunc hello() -> int:\n\treturn 1\n\n\nfunc again() -> int:\n\treturn Thing.hello()\n',
    );
    writeFileSync(
      join(dir, 'noisy.gd'),
      [
        'extends Node',
        '',
        '',
        'func _ready() -> void:',
        '\tpush_error("raised by the noisy autoload")',
        '\tif FileAccess.file_exists("res://die_at_start"):',
        '\t\tvar _killed: Error = OS.kill(OS.get_process_id())',
        '',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'user.gd'), 'extends RefCounted\n\n\nfunc f() -> int:\n\treturn Thing.hello()\n');
    writeFileSync(
      join(dir, 'wrong.gd'),
      'extends RefCounted\n\n\nfunc f() -> String:\n\tvar said: String = Thing.hello()\n\treturn said\n',
    );
    const engine = { godotPath, script: resolve('src/godot/operations/godot_operations.gd'), debug: false };

    const checked = await runThroughTheServersOwnPath(
      engine,
      'check_scripts',
      { paths: ['res://user.gd', 'res://wrong.gd'] },
      dir,
    );
    assert.ok(checked.ok, `the check should answer: ${checked.ok ? '' : checked.message}`);
    assert.deepEqual(
      [get(checked.payload, 'checked'), get(checked.payload, 'scripts')],
      [
        ['res://user.gd', 'res://wrong.gd'],
        [
          {
            path: 'res://wrong.gd',
            errors: [
              {
                line: 5,
                message:
                  'Parse Error: Cannot assign a value of type int to variable "said" with specified type String.',
              },
            ],
          },
        ],
      ],
      `the autoload resolves, and a wrong use of it is still an error at its line: ${JSON.stringify(checked.payload)}`,
    );
    // What the autoloads raised as they started is theirs, not the check's.
    const raised = (entries: readonly { text: string }[] | undefined): boolean =>
      (entries ?? []).some((entry) => entry.text === 'raised by the noisy autoload');
    assert.ok(raised(checked.beforeOperationMessages), JSON.stringify(checked.beforeOperationMessages));
    assert.ok(!raised(checked.messages), `and not as the operation's: ${JSON.stringify(checked.messages)}`);
    const extras = engineExtras(checked);
    assert.match(
      String(get(extras, 'engine_messages_before_operation_note')),
      /^Printed while the engine started the project's autoloads, before this operation ran/,
      JSON.stringify(extras),
    );

    const created = await runThroughTheServersOwnPath(
      engine,
      'create_script',
      { scriptPath: 'made.gd', content: 'extends Node\n\n\nfunc f() -> int:\n\treturn Thing.hello()\n' },
      dir,
    );
    const modified = await runThroughTheServersOwnPath(
      engine,
      'modify_script',
      {
        scriptPath: 'made.gd',
        modifications: [{ type: 'add_function', name: 'greet', body: 'print(Thing.hello())' }],
      },
      dir,
    );
    assert.deepEqual(
      [created, modified].map((made) => (made.ok ? get(made.payload, 'parses') : made.message)),
      [true, true],
      `a script written naming an autoload parses: ${JSON.stringify([created, modified])}`,
    );
    // A body written with the function's indent already on, and a blank line inside it.
    const indented = await runThroughTheServersOwnPath(
      engine,
      'modify_script',
      {
        scriptPath: 'made.gd',
        modifications: [
          { type: 'add_function', name: 'twice', body: '\tvar n: int = Thing.hello()\n\n\tprint(n, n)' },
        ],
      },
      dir,
    );
    assert.ok(indented.ok && get(indented.payload, 'parses') === true, JSON.stringify(indented));
    assert.match(
      readFileSync(join(dir, 'made.gd'), 'utf8'),
      /\nfunc greet\(\) -> void:\n\tprint\(Thing\.hello\(\)\)\n\n\nfunc twice\(\) -> void:\n\tvar n: int = Thing\.hello\(\)\n\n\tprint\(n, n\)\n$/,
      readFileSync(join(dir, 'made.gd'), 'utf8'),
    );
    // Each level of a body takes the file's own unit, whichever the caller nested it with: the
    // engine refuses a script indented with spaces in one place and tabs in another.
    const nested = await runThroughTheServersOwnPath(
      engine,
      'modify_script',
      {
        scriptPath: 'made.gd',
        modifications: [{ type: 'add_function', name: 'guarded', body: 'if Thing:\n  print(Thing)' }],
      },
      dir,
    );
    writeFileSync(
      join(dir, 'spaced.gd'),
      'extends Node\n\n\nfunc hurt() -> void:\n    if Thing:\n        pass\n',
    );
    const spaced = await runThroughTheServersOwnPath(
      engine,
      'modify_script',
      {
        scriptPath: 'spaced.gd',
        modifications: [{ type: 'add_function', name: 'heal', body: 'if Thing:\n\tprint(Thing)\n' }],
      },
      dir,
    );
    assert.deepEqual(
      [nested, spaced].map((made) => (made.ok ? get(made.payload, 'parses') : made.message)),
      [true, true],
      JSON.stringify([nested, spaced]),
    );
    assert.match(
      readFileSync(join(dir, 'made.gd'), 'utf8'),
      /\nfunc guarded\(\) -> void:\n\tif Thing:\n\t\tprint\(Thing\)\n$/,
      readFileSync(join(dir, 'made.gd'), 'utf8'),
    );
    assert.match(
      readFileSync(join(dir, 'spaced.gd'), 'utf8'),
      /\nfunc heal\(\) -> void:\n {4}if Thing:\n {8}print\(Thing\)\n$/,
      readFileSync(join(dir, 'spaced.gd'), 'utf8'),
    );
    const structure = await runThroughTheServersOwnPath(
      engine,
      'get_script_info',
      { scriptPath: 'made.gd' },
      dir,
    );
    assert.deepEqual(
      structure.ok
        ? [get(structure.payload, 'autoloads_used'), get(structure.payload, 'dependencies')]
        : structure,
      [[{ name: 'Thing', path: 'res://thing.gd' }], []],
      `the autoload the script names is answered with its script, apart from what it loads: ${JSON.stringify(structure)}`,
    );
    const itself = await runThroughTheServersOwnPath(
      engine,
      'get_script_info',
      { scriptPath: 'thing.gd' },
      dir,
    );
    assert.deepEqual(
      itself.ok ? get(itself.payload, 'autoloads_used') : itself,
      [],
      `an autoload's script naming its own global name uses no other: ${JSON.stringify(itself)}`,
    );

    writeFileSync(join(dir, 'die_at_start'), '');
    const died = await runThroughTheServersOwnPath(
      engine,
      'check_scripts',
      { paths: ['res://user.gd'] },
      dir,
    );
    assert.ok(!died.ok, `an engine that died before the check is no answer: ${JSON.stringify(died)}`);
    assert.match(
      died.message,
      /^check_scripts never ran: the engine ended \(.+\) while it started the project's autoloads, which this operation waits for\. The last it reported: raised by the noisy autoload$/,
      died.message,
    );
  } finally {
    sweep(dir);
  }
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
    sweep(dir);
  }
}

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

/**
 * The class list a rebuild writes is the one the engine's own import writes, so a rebuild over a
 * current list changes nothing and says so.
 *
 * Reported from game-a: `class_name Tab extends Heard.Named`, an inner class of a
 * global class, was written with the base `Heard.Named` where the engine writes nothing, and every
 * refresh reported Tab changed. The engine's class scan does not look names up, so the rules here
 * are its own and several are not what a reader would guess: a script extending another by path is
 * given that script's base rather than its class_name, a relative path is read from the project
 * root and not from the script's folder, and a parent that is missing still lists the class, with
 * no base. Each shape the scan treats differently is one script here, and the comparison is the
 * whole file, so a shape not listed is still held to agreeing.
 */
function testTheClassListIsTheEnginesOwn(godotPath: string): void {
  const projectDir = createProject(godotPath);
  try {
    const scripts: Record<string, string> = {
      'heard.gd':
        'class_name Heard\nextends Node\n\n\nclass Named:\n\textends RefCounted\n\tvar label: String = ""\n\n\tclass Deeper:\n\t\textends Node\n',
      'shapes.gd':
        'class_name Shapes\nextends Node\n\n\nclass Bare:\n\tvar count: int = 0\n\n\nclass Inline extends Node2D:\n\tvar moved: int = 0\n\n\nclass ByPathAgain:\n\textends "res://heard.gd"\n',
      'plain.gd': 'class_name Plain\nextends Heard\n',
      'same_line.gd': 'class_name SameLine extends Heard.Named\n',
      'tab.gd': 'class_name Tab\nextends Heard.Named\n',
      'deep.gd': 'class_name Deep\nextends Heard.Named.Deeper\n',
      'by_path.gd': 'class_name ByPath\nextends "res://heard.gd"\n',
      'by_path_inner.gd': 'class_name ByPathInner\nextends "res://heard.gd".Named\n',
      'by_path_deeper.gd': 'class_name ByPathDeeper\nextends "res://heard.gd".Named.Deeper\n',
      'path_to_tab.gd': 'class_name PathToTab\nextends "res://tab.gd"\n',
      'missing.gd': 'class_name Missing\nextends "res://nowhere.gd"\n',
      'uses_bare.gd': 'class_name UsesBare\nextends "res://shapes.gd".Bare\n',
      'uses_inline.gd': 'class_name UsesInline\nextends "res://shapes.gd".Inline\n',
      'uses_again.gd': 'class_name UsesAgain\nextends "res://shapes.gd".ByPathAgain\n',
      'uses_nothing.gd': 'class_name UsesNothing\nextends "res://shapes.gd".Nowhere\n',
      'nothing.gd': 'class_name Nothing\n',
      'more/sibling.gd': 'class_name Sibling\nextends Node3D\n',
      'more/beside.gd': 'class_name Beside\nextends "sibling.gd"\n',
      'more/up.gd': 'class_name Up\nextends "../heard.gd"\n',
      'more/from_root.gd': 'class_name FromRoot\nextends "heard.gd"\n',
      'more/from_root_inner.gd': 'class_name FromRootInner\nextends "heard.gd".Named\n',
    };
    mkdirSync(join(projectDir, 'more'));
    for (const [name, source] of Object.entries(scripts)) {
      writeFileSync(join(projectDir, name), source);
    }
    const imported = spawnSyncHidden(godotPath, ['--headless', '--path', projectDir, '--import'], {
      encoding: 'utf8',
      timeout: 180000,
    });
    assert.equal(imported.status, 0, `the engine imports the project: ${imported.stderr}`);
    const cache = join(projectDir, '.godot', 'global_script_class_cache.cfg');
    const theEngines = readFileSync(cache, 'utf8');
    const bases = (text: string): Record<string, string> => {
      const found: Record<string, string> = {};
      for (const entry of text.matchAll(/"base": &"([^"]*)",\s*"class": &"([^"]*)"/g)) {
        found[entry[2] ?? ''] = entry[1] ?? '';
      }
      return found;
    };
    // The engine's answers for the shapes that are not a guess, so a fixture whose engine had stopped
    // listing them would not pass by agreeing with a rebuild that had stopped too.
    assert.deepEqual(
      Object.fromEntries(
        ['Tab', 'SameLine', 'ByPath', 'ByPathInner', 'Missing', 'UsesBare', 'Beside', 'FromRoot'].map(
          (name) => [name, bases(theEngines)[name]],
        ),
      ),
      {
        Tab: '',
        SameLine: '',
        ByPath: 'Node',
        ByPathInner: 'RefCounted',
        Missing: '',
        UsesBare: 'RefCounted',
        Beside: '',
        FromRoot: 'Node',
      },
      theEngines,
    );

    const rebuilt = runOperation(godotPath, projectDir, 'refresh_class_cache', {});
    assert.deepEqual(
      { added: get(rebuilt, 'added'), removed: get(rebuilt, 'removed'), changed: get(rebuilt, 'changed') },
      { added: [], removed: [], changed: [] },
      `a rebuild over the engine's own list changes nothing: ${JSON.stringify(rebuilt)}`,
    );
    assert.deepEqual(
      bases(readFileSync(cache, 'utf8')),
      bases(theEngines),
      'and writes the bases the engine wrote',
    );
    assert.equal(readFileSync(cache, 'utf8'), theEngines, 'byte for byte');
  } finally {
    sweep(projectDir);
  }
}

/**
 * The shipped scripts compile and run in a project whose own classes and autoloads share the names
 * they would otherwise use.
 *
 * Godot resolves a type as a global class, then an autoload, before the script's own constants and
 * inner classes, so in a project with `class_name Log` a module's `var logger: Log` named the
 * project's class and the module refused to compile, losing every headless call; an inner class of
 * that name is refused as hiding the global one. Found when a fixture here declared
 * `class_name Shapes`. So every name a shipped script declares in a class's casing carries the
 * prefix, and the same name without it is one class, and in a second project one autoload, here.
 * The names in capitals are constants, which no project names a class after.
 */
function testOurNamesStandAsideForAProjectsClasses(godotPath: string): void {
  const declared = new Set<string>();
  for (const script of shippedScripts()) {
    const source = readFileSync(join('src', 'godot', script.slice('res://'.length)), 'utf8');
    for (const found of source.matchAll(/^\s*(?:const|class|enum|static var|var)\s+([A-Z]\w*)/gm)) {
      const name = found[1] ?? '';
      if (/[a-z]/.test(name)) {
        declared.add(name);
      }
    }
  }
  assert.ok(
    declared.size >= 64,
    `the shipped scripts declare names in a class's casing: ${[...declared].join(', ')}`,
  );
  const unprefixed = [...declared].filter((name) => !name.startsWith('Gdh'));
  assert.deepEqual(unprefixed, [], 'a name a project could also declare is shadowed by the project');
  const bare = [...declared].map((name) => name.replace(/^Gdh/, ''));

  const asClasses = createProject(godotPath);
  try {
    mkdirSync(join(asClasses, 'clashes'));
    for (const name of bare) {
      writeFileSync(
        join(asClasses, 'clashes', `${name.toLowerCase()}.gd`),
        `class_name ${name}\nextends RefCounted\n`,
      );
    }
    const imported = spawnSyncHidden(godotPath, ['--headless', '--path', asClasses, '--import'], {
      encoding: 'utf8',
      timeout: 180000,
    });
    assert.equal(imported.status, 0, `the engine imports the project: ${imported.stderr}`);
    const listed = readFileSync(join(asClasses, '.godot', 'global_script_class_cache.cfg'), 'utf8');
    assert.ok(
      bare.every((name) => listed.includes(`"class": &"${name}"`)),
      `every clashing class is one the engine lists: ${listed}`,
    );
    standsAside(godotPath, asClasses, 'classes');
  } finally {
    sweep(asClasses);
  }

  const asAutoloads = createProject(godotPath);
  try {
    writeFileSync(join(asAutoloads, 'clash.gd'), 'extends Node\n');
    const settings = join(asAutoloads, 'project.godot');
    const autoloads = bare.map((name) => `${name}="*res://clash.gd"`).join('\n');
    writeFileSync(settings, `${readFileSync(settings, 'utf8')}\n[autoload]\n\n${autoloads}\n`);
    standsAside(godotPath, asAutoloads, 'autoloads');
  } finally {
    sweep(asAutoloads);
  }
}

/** Every shipped script compiles in [projectDir], and an operation runs there and answers cleanly. */
function standsAside(godotPath: string, projectDir: string, beside: string): void {
  assert.equal(
    get(runFixture(godotPath, projectDir, 'typed'), 'checked'),
    shippedScripts().length,
    `every shipped script compiles beside the project's ${beside}`,
  );
  const rebuilt = runOperation(godotPath, projectDir, 'refresh_class_cache', {});
  assert.ok(
    Array.isArray(get(rebuilt, 'added')),
    `and an operation runs and answers: ${JSON.stringify(rebuilt)}`,
  );
}

/**
 * A font's OpenType features are written as the engine reads them, and the font is shaped by them.
 *
 * JSON names every key as a string and every number as a float, so set_options wrote
 * opentype_features as {"1818847073": 0.0}, said it had, and the font still formed its ligatures:
 * FontFile keys a feature by its tag as an int. The font is the engine's own fallback, written out,
 * which forms fi, fl and ff, so shaping "fi fl ff" before and after the change is the effect itself
 * rather than the sidecar's text.
 */
function testAFontsFeaturesAreWrittenAsTheEngineReadsThem(godotPath: string, _projectDir: string): void {
  const dir = createProject(godotPath);
  const operation = (name: string, params: unknown): unknown => runOperation(godotPath, dir, name, params);
  const importAll = (): void => {
    const run = spawnSyncHidden(godotPath, ['--headless', '--path', dir, '--import'], {
      encoding: 'utf8',
      timeout: 180_000,
    });
    assert.equal(run.status, 0, `the project should import: ${run.stdout}\n${run.stderr}`);
  };
  const glyphs = (): number => {
    const run = runScript(godotPath, dir, 'res://shape.gd');
    const counted = /glyphs (\d+)/.exec(run.stdout)?.[1];
    assert.ok(counted !== undefined, `the font should be shaped: ${run.stdout}\n${run.stderr}`);
    return Number(counted);
  };
  try {
    writeFileSync(
      join(dir, 'write_font.gd'),
      'extends SceneTree\n\n\nfunc _init() -> void:\n\tvar font: FontFile = ThemeDB.fallback_font as FontFile\n' +
        '\tvar file: FileAccess = FileAccess.open("res://fallback.ttf", FileAccess.WRITE)\n' +
        '\tvar _stored: bool = file.store_buffer(font.data)\n\tfile.close()\n\tquit(0)\n',
    );
    writeFileSync(
      join(dir, 'shape.gd'),
      'extends SceneTree\n\n\nfunc _init() -> void:\n\tvar font: FontFile = load("res://fallback.ttf")\n' +
        '\tvar server: TextServer = TextServerManager.get_primary_interface()\n' +
        '\tvar shaped: RID = server.create_shaped_text()\n' +
        '\tvar _added: bool = server.shaped_text_add_string(shaped, "fi fl ff", font.get_rids(), 16)\n' +
        '\tvar _shaped: bool = server.shaped_text_shape(shaped)\n' +
        '\tprint("glyphs %d" % server.shaped_text_get_glyph_count(shaped))\n' +
        '\tserver.free_rid(shaped)\n\tquit(0)\n',
    );
    const written = runScript(godotPath, dir, 'res://write_font.gd');
    assert.equal(written.status, 0, `the fallback font should be written out: ${written.stderr}`);
    importAll();
    assert.equal(
      glyphs(),
      5,
      'the font forms fi, fl and ff, so the five characters and two spaces are five glyphs',
    );

    // Ligatures by their name, contextual ligatures by their number.
    const sidecarPath = join(dir, 'fallback.ttf.import');
    const importedAt = statSync(sidecarPath).mtimeMs;
    const set = operation('set_import_options', {
      resource_path: 'fallback.ttf',
      options: { opentype_features: { liga: 0, '1668049255': 0 } },
    });
    assert.deepEqual(get(set, 'updated_options'), ['opentype_features'], JSON.stringify(set));
    pastTheImportsSecond(sidecarPath, importedAt);
    const sidecar = readFileSync(sidecarPath, 'utf8');
    assert.match(sidecar, /^1818847073: 0,?$/m, `liga is written by its tag as an int: ${sidecar}`);
    assert.match(sidecar, /^1668049255: 0,?$/m, `and clig: ${sidecar}`);
    importAll();
    assert.equal(glyphs(), 8, 'with ligatures off, every character is a glyph of its own');

    // A longer name is refused rather than read by its first four characters, which the engine does.
    const kept = readFileSync(join(dir, 'fallback.ttf.import'), 'utf8');
    const long = runRefusedOperation(godotPath, dir, 'set_import_options', {
      resource_path: 'fallback.ttf',
      options: { opentype_features: { ligatures: 0 } },
    });
    assert.equal(long.answer, null, 'a feature named by no tag is refused');
    assert.match(
      long.stderr,
      /opentype_features is keyed by OpenType tags, by name such as "liga" or as the number TextServer\.name_to_tag gives, and "ligatures" is not one/,
      long.stderr,
    );
    assert.equal(readFileSync(join(dir, 'fallback.ttf.import'), 'utf8'), kept, 'and nothing is written');

    // Any option already keyed by ints keeps its keys ints, and its values where they are ints.
    const sidecarFile = join(dir, 'fallback.ttf.import');
    writeFileSync(sidecarFile, kept.replace('[params]\n', '[params]\n\nnumbered={\n1: 2\n}\n'));
    operation('set_import_options', { resource_path: 'fallback.ttf', options: { numbered: { '3': 4 } } });
    assert.match(
      readFileSync(sidecarFile, 'utf8'),
      /^numbered=\{\n3: 4\n\}$/m,
      readFileSync(sidecarFile, 'utf8'),
    );
    const named = runRefusedOperation(godotPath, dir, 'set_import_options', {
      resource_path: 'fallback.ttf',
      options: { numbered: { three: 4 } },
    });
    assert.match(named.stderr, /numbered is keyed by ints, and "three" is not one/, named.stderr);
  } finally {
    sweep(dir);
  }
}

/**
 * A script naming an autoload depends on the autoload's script, both ways round. Asked what used
 * an autoload's script, the answer was its line in project.godot alone, beside the script calling
 * it by name, and asked what that script depended on, the autoload was not there. An autoload
 * that is not global is no name code can use, so a word spelling it is not a use.
 */
function testAnAutoloadIsUsedByItsName(godotPath: string): void {
  const dir = createProject(godotPath);
  const operation = (name: string, params: unknown): unknown => runOperation(godotPath, dir, name, params);
  try {
    writeFileSync(
      join(dir, 'project.godot'),
      `${readFileSync(join(dir, 'project.godot'), 'utf8')}\n[autoload]\n\nScore="*res://score.gd"\nQuiet="res://quiet.gd"\n`,
    );
    writeFileSync(
      join(dir, 'score.gd'),
      'extends Node\n\n\nfunc add(points: int) -> void:\n\tprint(points)\n',
    );
    writeFileSync(join(dir, 'quiet.gd'), 'extends Node\n');
    writeFileSync(
      join(dir, 'enemy.gd'),
      'extends Node\n\n# Score is told below.\n\n\nfunc hit() -> void:\n\tScore.add(10)\n\tprint(Quiet)\n',
    );

    const forward = operation('get_dependencies', { resource_path: 'res://enemy.gd' });
    assert.deepEqual(
      asArray(get(forward, 'dependencies', 'res://enemy.gd')),
      [{ path: 'res://score.gd', exists: true, by_autoload: 'Score' }],
      JSON.stringify(forward),
    );

    const reverse = operation('find_resource_usages', { resource_path: 'res://score.gd' });
    assert.equal(get(reverse, 'autoload'), 'Score', JSON.stringify(reverse));
    const kinds = (file: string): unknown[] =>
      asArray(
        get(
          asArray(get(reverse, 'usages')).find((usage) => get(usage, 'file') === file),
          'references',
        ) ?? [],
      ).map((reference) => [get(reference, 'kind'), get(reference, 'line')]);
    assert.deepEqual(kinds('res://enemy.gd'), [
      ['comment', 3],
      ['autoload', 7],
    ]);
    assert.deepEqual(
      kinds('res://project.godot').map((entry) => asArray(entry)[0]),
      ['setting'],
      JSON.stringify(reverse),
    );
    assert.equal(get(reverse, 'summary', 'in_code'), 2, 'the call and the setting, the comment left out');
    const quiet = operation('find_resource_usages', { resource_path: 'res://quiet.gd' });
    assert.deepEqual(
      asArray(get(quiet, 'usages')).map((usage) => get(usage, 'file')),
      ['res://project.godot'],
      `an autoload that is not global has no name in code: ${JSON.stringify(quiet)}`,
    );
    assert.equal(get(quiet, 'autoload'), undefined, JSON.stringify(quiet));
  } finally {
    sweep(dir);
  }
}

/** The cases after the fixtures, in the order the leg runs them, by the name `case` takes. */
/**
 * The classes a project's scripts declare stand beside the engine's in query and inheritance.
 *
 * Found by a probe: Creature extends Node2D, and inheritance on Node2D listed fifty descendants
 * without it, a query for "Creature" answered nothing, and inheritance on a project class was
 * refused, with no word that the answers covered the engine's classes alone. The case hands the
 * operation what the server reads from this project's scripts, so the reading and the answer are
 * held together rather than against a table written here.
 */
function testTheProjectsClassesStandBesideTheEngines(godotPath: string): void {
  const dir = createProject(godotPath);
  try {
    const scripts: Record<string, string> = {
      'creature.gd': 'class_name Creature\nextends Node2D\n',
      'dragon.gd': 'class_name Dragon\nextends Creature\n',
      // A base script with no class_name, between two that have one.
      'wyrm.gd': 'extends "res://dragon.gd"\n',
      'wyvern.gd': 'class_name Wyvern\nextends "wyrm.gd"\n',
      'shape.gd': '@abstract\nclass_name Shape\nextends Resource\n\n\n@abstract func area() -> float\n',
      'polygon.gd': '@abstract class_name Polygon extends Shape\n',
      'circle.gd': 'class_name Circle\nextends Shape\n\n\nfunc area() -> float:\n\treturn 1.0\n',
      'plain.gd': 'class_name Plain\n',
      // Concrete itself, on an engine class that cannot be instantiated.
      'body.gd': 'class_name Body\nextends PhysicsBody2D\n',
    };
    for (const [file, source] of Object.entries(scripts)) {
      writeFileSync(join(dir, file), source);
    }
    const mine = ['Body', 'Circle', 'Creature', 'Dragon', 'Plain', 'Polygon', 'Shape', 'Wyvern'];
    const project_classes = Object.fromEntries(declaredClassLines(dir));
    const operation = (name: string, params: Record<string, unknown>): unknown =>
      runOperation(godotPath, dir, name, { ...params, project_classes });
    const names = (list: unknown): string[] =>
      asArray(list)
        .map((entry) => String(get(entry, 'name')))
        .filter((name) => mine.includes(name));

    const found = operation('query_classes', { filter: 'creature' });
    assert.deepEqual(
      [get(found, 'classes'), get(found, 'project_classes')],
      [[], [{ name: 'Creature', path: 'res://creature.gd', extends: 'Node2D', abstract: false }]],
      JSON.stringify(found),
    );
    assert.deepEqual(
      names(get(operation('query_classes', { category: 'node2d' }), 'project_classes')),
      ['Body', 'Creature', 'Dragon', 'Wyvern'],
      'a category is the engine class a project class is built on',
    );
    assert.deepEqual(
      names(get(operation('query_classes', { instantiable_only: true }), 'project_classes')),
      ['Circle', 'Creature', 'Dragon', 'Plain', 'Wyvern'],
      'the @abstract classes and one on an abstract engine class are left out, and one extending an @abstract class is kept',
    );

    const node2d = operation('inspect_inheritance', { class_name: 'Node2D' });
    assert.deepEqual(
      [names(get(node2d, 'project_children')), names(get(node2d, 'project_descendants'))],
      [['Creature'], ['Body', 'Creature', 'Dragon', 'Wyvern']],
      JSON.stringify(node2d),
    );
    assert.ok(asArray(get(node2d, 'all_descendants')).includes('Camera2D'), 'beside the engine classes');

    const dragon = operation('inspect_inheritance', { class_name: 'Dragon' });
    assert.deepEqual(
      [
        get(dragon, 'declared_in'),
        get(dragon, 'parent_class'),
        get(dragon, 'ancestors'),
        names(get(dragon, 'project_children')),
        get(dragon, 'abstract'),
        get(dragon, 'can_instantiate'),
      ],
      [
        'res://dragon.gd',
        'Creature',
        ['Creature', 'Node2D', 'CanvasItem', 'Node', 'Object'],
        ['Wyvern'],
        false,
        true,
      ],
      JSON.stringify(dragon),
    );
    const shape = operation('inspect_inheritance', { class_name: 'Shape' });
    assert.deepEqual(
      [
        get(shape, 'ancestors'),
        names(get(shape, 'project_children')),
        get(shape, 'abstract'),
        get(shape, 'can_instantiate'),
      ],
      [['Resource', 'RefCounted', 'Object'], ['Circle', 'Polygon'], true, false],
      JSON.stringify(shape),
    );

    const misspelt = runRefusedOperation(godotPath, dir, 'inspect_inheritance', {
      class_name: 'Dragn',
      project_classes,
    });
    assert.match(
      misspelt.stderr,
      /Class not found: Dragn\..* The nearest class a project script declares is Dragon\. Neither the engine nor a project script declares it\./,
      misspelt.stderr,
    );
    const read = runRefusedOperation(godotPath, dir, 'query_class_info', {
      class_name: 'Dragon',
      project_classes,
    });
    assert.match(
      read.stderr,
      /Dragon is not an engine class: it is the class_name res:\/\/dragon\.gd declares, .*script_info structure/,
      read.stderr,
    );
  } finally {
    sweep(dir);
  }
}

const CASES: Readonly<Record<string, (godotPath: string, projectDir: string) => void | Promise<void>>> = {
  projectClasses: (godotPath) => {
    testTheProjectsClassesStandBesideTheEngines(godotPath);
  },
  dependencyWalk: testDependencyWalk,
  operations: testOperations,
  gdignore: testAGdignoreStopsTheWalk,
  importJudged: testAnImportIsJudgedByWhatItWasBuiltFrom,
  referencesMissing: testAReferenceIsMissingOnlyWhereTheEngineMissesIt,
  uidBeforeImport: testAUidIsFollowedBeforeAnyImport,
  autoloadUses: (godotPath) => {
    testAnAutoloadIsUsedByItsName(godotPath);
  },
  fontFeatures: testAFontsFeaturesAreWrittenAsTheEngineReadsThem,
  importerFirst: (godotPath) => {
    testTheImporterIsAskedFirst(godotPath);
  },
  validationCounts: (godotPath) => {
    testValidationSaysHowMuchItRead(godotPath);
  },
  connectionsReached: (godotPath) => {
    testAConnectionNamesWhatItReaches(godotPath);
  },
  everyUse: (godotPath) => {
    testEveryUseIsFound(godotPath);
  },
  scriptCheck: (godotPath) => {
    testScriptsAreCompiled(godotPath);
  },
  overrides: (godotPath) => {
    testASettingSaysWhatReplacesIt(godotPath);
  },
  runningLog: (godotPath) => testAnOperationLeavesARunningLogAlone(godotPath),
  refusals: testRefusals,
  installedLayout: testInstalledLayout,
  settingsFamily: testAFamilyOfSettingsAnswersWithItsTypes,
  familyDefaults: (godotPath) => {
    testAFamilySaysWhatTheProjectSets(godotPath);
  },
  everyWarning: (godotPath) => {
    testTheOperationsSurviveEveryWarning(godotPath);
  },
  answer: (godotPath) => testTheAnswerIsTheOperations(godotPath),
  autoloads: (godotPath) => testAScriptNamingAnAutoloadCompiles(godotPath),
  binaryScenes: testBinaryScenesAreScenes,
  classBases: (godotPath) => {
    testTheClassListIsTheEnginesOwn(godotPath);
  },
  ourNames: (godotPath) => {
    testOurNamesStandAsideForAProjectsClasses(godotPath);
  },
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
  // The gate on its own, in seconds, for after a GDScript edit: the linter and the formatter pass a
  // script the engine refuses under warnings as errors, and a regression run with an engine loads
  // the addon under the default warnings, so both said yes to an addon that did not compile.
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
    runFixture(godotPath, projectDir, 'runtime_input_said');
    runFixture(godotPath, projectDir, 'runtime_input_scaled');
    runFixture(godotPath, projectDir, 'runtime_drag');
    runFixture(godotPath, projectDir, 'runtime_offers');
    runFixture(godotPath, projectDir, 'runtime_pad');
    runFixture(godotPath, projectDir, 'runtime_accessibility');
    runFixture(godotPath, projectDir, 'runtime_query');
    runFixture(godotPath, projectDir, 'runtime_view');
    runFixture(godotPath, projectDir, 'runtime_change');
    runFixture(godotPath, projectDir, 'reload_script');
    runFixture(godotPath, projectDir, 'scripts_behind');
    runFixture(godotPath, projectDir, 'runtime_click');
    runFixture(godotPath, projectDir, 'runtime_click_part');
    runFixture(godotPath, projectDir, 'runtime_items');
    runFixture(godotPath, projectDir, 'runtime_hidden');
    runFixture(godotPath, projectDir, 'runtime_toggle');
    runFixture(godotPath, projectDir, 'runtime_words');
    runFixture(godotPath, projectDir, 'runtime_wait');
    runFixture(godotPath, projectDir, 'runtime_wait_order');
    runFixture(godotPath, projectDir, 'runtime_signal');
    runFixture(godotPath, projectDir, 'runtime_calls');
    runFixture(godotPath, projectDir, 'runtime_lazy');
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
