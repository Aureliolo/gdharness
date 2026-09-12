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
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * GODOT_PATH first, then the GODOT that setup-godot exports, then plain `godot` on PATH.
 *
 * Each is tried by running it rather than by looking for it on disk, since on Windows what
 * sits on PATH is a shim. That platform also needs the extensions spelled out: setup-godot
 * exports GODOT without one, and spawn does not apply PATHEXT to a path it is handed whole.
 */
function resolveGodotPath() {
  const named = [process.env.GODOT_PATH, process.env.GODOT, 'godot'].filter(Boolean);
  const candidates =
    process.platform === 'win32'
      ? named.flatMap((name) => [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`])
      : named;

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 60000 });
    if (probe.status === 0) return candidate;
  }
  return null;
}

/**
 * A project holding the shipped GDScript exactly where the bundle puts it, so the fixtures
 * load the same paths the addons and the operations script use in the field.
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
  cpSync('src/godot/operations/godot_operations.gd', join(dir, 'operations', 'godot_operations.gd'));

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

function main() {
  const godotPath = resolveGodotPath();
  if (!godotPath) {
    // A skip is fine on a machine with no engine and never fine where the job exists to run
    // this. Without the flag, CI installing Godot wrong would read as a pass.
    if (process.env.GDHARNESS_REQUIRE_GODOT) {
      throw new Error(
        'GDHARNESS_REQUIRE_GODOT is set and no Godot could be run. Tried GODOT_PATH, GODOT and godot on PATH.',
      );
    }
    console.log('engine gdscript tests skipped (no Godot found)');
    return;
  }

  const projectDir = createProject();
  try {
    runFixture(godotPath, projectDir, 'operations_serialize');
    runFixture(godotPath, projectDir, 'runtime_serialize');
    runFixture(godotPath, projectDir, 'input_action');
    runFixture(godotPath, projectDir, 'shader_templates');
    testDependencyWalk(godotPath, projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }

  console.log('engine gdscript tests passed');
}

main();
