#!/usr/bin/env bun
/**
 * The harness table, driven against real files.
 *
 * What matters is not that a config is written but that the harness's own file survives it: these
 * are the reader's files, holding their other servers and their settings, and gdharness is a
 * guest in every one of them.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import {
  configPath,
  connect,
  containerKey,
  detect,
  entryFor,
  HARNESSES,
  harnessById,
  launchFor,
  SERVER_KEY,
} from '../src/harnesses.js';

const LAUNCH = launchFor('9.9.9', '/opt/godot/godot');

function project(): string {
  return mkdtempSync(join(tmpdir(), 'gdharness-harness-'));
}

function read(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** Every harness whose config this writes, rather than handing the reader a command or a block. */
const WRITERS = HARNESSES.filter(
  (harness) => harness.addCommand === undefined && harness.snippet === undefined,
);

function testEveryIdIsUniqueAndFindable(): void {
  const ids = HARNESSES.map((harness) => harness.id);
  assert.equal(new Set(ids).size, ids.length, 'no harness id is listed twice');
  for (const id of ids) {
    assert.equal(harnessById(id)?.id, id, `${id} is findable by its own id`);
  }
  assert.equal(harnessById('no-such-harness'), undefined, 'an unknown id finds nothing');
}

function testTheLaunchIsTheSameEverywhere(): void {
  // The whole reason for publishing to npm: one command, and the only per-harness difference is
  // where it is written down.
  assert.equal(LAUNCH.command, 'npx');
  assert.deepEqual(LAUNCH.args, ['-y', 'gdharness@9.9.9'], 'the version is pinned, never latest');
  assert.deepEqual(LAUNCH.env, { GODOT_PATH: '/opt/godot/godot' });
}

function testEachDialectIsShapedAsItsHarnessReadsIt(): void {
  const plain = entryFor('mcpServers', LAUNCH);
  assert.equal(plain['command'], 'npx');
  assert.equal(plain['type'], undefined, 'the common shape carries no type');

  const code = entryFor('servers', LAUNCH);
  assert.equal(code['type'], 'stdio', 'VS Code is told the transport');
  assert.equal(code['command'], 'npx');

  const open = entryFor('opencode', LAUNCH);
  assert.equal(open['type'], 'local');
  assert.deepEqual(open['command'], ['npx', '-y', 'gdharness@9.9.9'], 'opencode takes one array');
  assert.deepEqual(open['environment'], { GODOT_PATH: '/opt/godot/godot' });
  assert.equal(open['enabled'], true);

  assert.equal(containerKey('mcpServers'), 'mcpServers');
  assert.equal(containerKey('servers'), 'servers');
  assert.equal(containerKey('opencode'), 'mcp', 'opencode hangs its servers off mcp');
}

function testAConfigIsWrittenWhereTheHarnessLooks(): void {
  for (const harness of WRITERS.filter((known) => known.scope === 'project')) {
    const root = project();
    try {
      const written = connect(harness, root, LAUNCH);
      assert.equal(written.action, 'written', `${harness.id} wrote a new file`);
      assert.equal(written.path, join(root, harness.file), `${harness.id} wrote where it looks`);

      const config = read(written.path);
      const servers = config[containerKey(harness.dialect)] as Record<string, unknown>;
      assert.ok(servers[SERVER_KEY], `${harness.id} holds gdharness under ${containerKey(harness.dialect)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function testNothingAlreadyInTheFileIsLost(): void {
  const harness = harnessById('claude-code');
  assert.ok(harness, 'claude-code is in the table');
  const root = project();
  try {
    const path = join(root, harness.file);
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { other: { command: 'other-server' } },
        somethingElse: { kept: true },
      }),
      'utf8',
    );

    connect(harness, root, LAUNCH);

    const config = read(path);
    const servers = config['mcpServers'] as Record<string, unknown>;
    assert.deepEqual(servers['other'], { command: 'other-server' }, 'another server survives');
    assert.deepEqual(config['somethingElse'], { kept: true }, 'a key we know nothing about survives');
    assert.ok(servers[SERVER_KEY], 'and gdharness is there too');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testWritingTwiceReplacesRatherThanDuplicates(): void {
  const harness = harnessById('cursor');
  assert.ok(harness, 'cursor is in the table');
  const root = project();
  try {
    assert.equal(connect(harness, root, LAUNCH).action, 'written');
    const second = connect(harness, root, launchFor('9.9.10', '/opt/godot/other'));
    assert.equal(second.action, 'replaced', 'the second write says it replaced the entry');

    const servers = read(second.path)['mcpServers'] as Record<string, Record<string, unknown>>;
    assert.deepEqual(servers[SERVER_KEY]?.['args'], ['-y', 'gdharness@9.9.10'], 'the new version won');
    assert.equal(Object.keys(servers).length, 1, 'and there is still one gdharness');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testAConfigThatDoesNotParseIsLeftAlone(): void {
  const harness = harnessById('claude-code');
  assert.ok(harness, 'claude-code is in the table');
  const root = project();
  try {
    const path = join(root, harness.file);
    const damaged = '{ this is not json';
    writeFileSync(path, damaged, 'utf8');

    assert.throws(() => connect(harness, root, LAUNCH), /not valid JSON/, 'it refuses rather than writes');
    assert.equal(readFileSync(path, 'utf8'), damaged, 'and the file is exactly as it was');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testAHarnessIsDetectedByItsOwnDirectory(): void {
  const harness = harnessById('vscode');
  assert.ok(harness, 'vscode is in the table');
  const root = project();
  try {
    assert.ok(!detect(root).includes(harness), 'an empty project detects no VS Code');
    // The directory alone, with no config in it: a harness that has been opened but never had a
    // server added is still the harness this machine runs.
    mkdirSync(dirname(configPath(harness, root)), { recursive: true });
    assert.ok(detect(root).includes(harness), 'its directory is enough');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testAHarnessWeCannotWriteIsNeverWrittenTo(): void {
  for (const harness of HARNESSES.filter((known) => !WRITERS.includes(known))) {
    const root = project();
    try {
      const written = connect(harness, root, LAUNCH);
      assert.ok(
        written.action === 'command' || written.action === 'snippet',
        `${harness.id} hands back a command or a block`,
      );
      const shown = written.command?.join(' ') ?? written.snippet ?? '';
      assert.ok(shown.includes('gdharness@9.9.9'), `${harness.id} names the pinned version`);
      assert.ok(shown.includes('/opt/godot/godot'), `${harness.id} carries this machine's engine path`);
      assert.ok(!existsSync(written.path), `${harness.id} left its config alone`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function testCodexCarriesTheGodotPath(): void {
  // The one thing a plain copy-paste config block cannot do, and the reason setup writes these
  // rather than printing them: the engine path is this machine's.
  const harness = harnessById('codex');
  assert.ok(harness?.addCommand, 'codex is in the table with its own command');
  const command = harness.addCommand(LAUNCH);
  assert.deepEqual(command, [
    'codex',
    'mcp',
    'add',
    'gdharness',
    '--env',
    'GODOT_PATH=/opt/godot/godot',
    '--',
    'npx',
    '-y',
    'gdharness@9.9.9',
  ]);
}

const TESTS = [
  testEveryIdIsUniqueAndFindable,
  testTheLaunchIsTheSameEverywhere,
  testEachDialectIsShapedAsItsHarnessReadsIt,
  testAConfigIsWrittenWhereTheHarnessLooks,
  testNothingAlreadyInTheFileIsLost,
  testWritingTwiceReplacesRatherThanDuplicates,
  testAConfigThatDoesNotParseIsLeftAlone,
  testAHarnessIsDetectedByItsOwnDirectory,
  testAHarnessWeCannotWriteIsNeverWrittenTo,
  testCodexCarriesTheGodotPath,
];

for (const test of TESTS) {
  test();
}

console.log(`harness table tests passed for ${HARNESSES.length} harnesses`);
process.exitCode = 0;
