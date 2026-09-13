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
  candidates,
  configPath,
  connect,
  detect,
  detectGlobal,
  disconnect,
  displayPath,
  entryFor,
  groupByFile,
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

function testEachShapeIsWrittenAsItsHarnessReadsIt(): void {
  const plain = entryFor('plain', LAUNCH);
  assert.equal(plain['command'], 'npx');
  assert.equal(plain['type'], undefined, 'the common shape carries no type');

  const typed = entryFor('typed', LAUNCH);
  assert.equal(typed['type'], 'stdio', 'VS Code and Factory are told the transport');
  assert.equal(typed['command'], 'npx');

  const open = entryFor('opencode', LAUNCH);
  assert.equal(open['type'], 'local');
  assert.deepEqual(open['command'], ['npx', '-y', 'gdharness@9.9.9'], 'opencode takes one array');
  assert.deepEqual(open['environment'], { GODOT_PATH: '/opt/godot/godot' });
  assert.equal(open['enabled'], true);
}

function testAConfigIsWrittenWhereTheHarnessLooks(): void {
  for (const harness of WRITERS.filter((known) => known.scope === 'project')) {
    const root = project();
    try {
      const written = connect(harness, root, LAUNCH);
      assert.equal(written.action, 'written', `${harness.id} wrote a new file`);
      assert.equal(written.path, join(root, harness.file as string), `${harness.id} wrote where it looks`);

      const config = read(written.path);
      const servers = config[harness.container] as Record<string, unknown>;
      assert.ok(servers[SERVER_KEY], `${harness.id} holds gdharness under ${harness.container}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

/**
 * Four harnesses read `.mcp.json`. Writing it once and naming all four is the point of grouping,
 * and a group that silently dropped a harness would leave somebody unconfigured.
 */
function testHarnessesSharingAFileAreWrittenOnce(): void {
  const root = project();
  try {
    const groups = groupByFile(
      HARNESSES.filter((known) => known.scope === 'project'),
      root,
    );
    const paths = groups.map((group) => group.path);
    assert.equal(new Set(paths).size, paths.length, 'no file is written by two groups');

    const shared = groups.find((group) => group.path === join(root, '.mcp.json'));
    assert.ok(shared, '.mcp.json is one group');
    const names = shared.harnesses.map((harness) => harness.id);
    for (const id of ['claude-code', 'copilot-cli', 'qoder', 'command-code']) {
      assert.ok(names.includes(id), `${id} reads .mcp.json and is named on that group`);
    }

    const grouped = groups.flatMap((group) => group.harnesses).length;
    assert.equal(
      grouped,
      HARNESSES.filter((known) => known.scope === 'project').length,
      'every harness is in exactly one group',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A path we cannot show a reader is a path they cannot check, whatever platform they are on. */
function testEveryHarnessHasAReadablePathOnEveryPlatform(): void {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    for (const harness of HARNESSES) {
      const shown = displayPath(harness, platform);
      assert.ok(shown.length > 0, `${harness.id} has a path on ${platform}`);
      assert.ok(!shown.includes('\\'), `${harness.id} shows forward slashes on ${platform}`);
      if (harness.scope === 'home') {
        assert.ok(
          shown.startsWith('~/') || shown.startsWith('%APPDATA%/'),
          `${harness.id} is shown as leaving the project on ${platform}`,
        );
      }
    }
  }
}

function testNothingAlreadyInTheFileIsLost(): void {
  const harness = harnessById('claude-code');
  assert.ok(harness, 'claude-code is in the table');
  const root = project();
  try {
    const path = join(root, harness.file as string);
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
    const path = join(root, harness.file as string);
    const damaged = '{ this is not json';
    writeFileSync(path, damaged, 'utf8');

    assert.throws(() => connect(harness, root, LAUNCH), /not valid JSON/, 'it refuses rather than writes');
    assert.equal(readFileSync(path, 'utf8'), damaged, 'and the file is exactly as it was');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Every project-scoped harness made to look set up, by whatever evidence that harness actually
 * leaves: its own directory, the directory it is recognised by, or the config file itself for the
 * ones that keep it at the project root.
 */
function makeEveryProjectHarnessPresent(root: string): void {
  for (const harness of HARNESSES.filter((known) => known.scope === 'project')) {
    const path = configPath(harness, root);
    if (dirname(path) !== root) {
      mkdirSync(dirname(path), { recursive: true });
    } else if (harness.marker !== undefined) {
      mkdirSync(join(root, harness.marker), { recursive: true });
    } else {
      writeFileSync(path, '', 'utf8');
    }
  }
}

/**
 * The whole point of the split. Installing gdharness into one project must not register it for
 * every project the reader opens with a harness whose configuration is machine-wide.
 */
function testDetectionNeverReachesOutOfTheProject(): void {
  const root = project();
  try {
    // Every harness in the table made to look present at once, so the assertions below are about
    // the whole table rather than about whichever ones happen to exist on the machine running this.
    makeEveryProjectHarnessPresent(root);

    const found = detect(root);
    assert.equal(
      found.length,
      HARNESSES.filter((harness) => harness.scope === 'project').length,
      'every project-scoped harness is found once its directory is there',
    );
    for (const harness of found) {
      assert.ok(
        configPath(harness, root).startsWith(root),
        `${harness.id} would be written at ${configPath(harness, root)}, outside the project`,
      );
    }

    // The other half: a machine-wide config is never something detection writes, whatever is on
    // the machine. Installing one project is not consent to change every other one.
    const global = HARNESSES.filter((harness) => harness.scope === 'home');
    assert.ok(global.length > 0, 'the table has machine-wide harnesses, or this proves nothing');
    for (const harness of global) {
      assert.equal(found.includes(harness), false, `${harness.id} must never be written unasked`);
      assert.equal(
        configPath(harness, root).startsWith(root),
        false,
        `${harness.id} is only worth this test because its config is outside the project`,
      );
    }
    assert.equal(
      detectGlobal(root).every((harness) => global.includes(harness)),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * What the prompt is built from. A candidate that is already configured here is a different
 * question from one that merely exists on the machine, and a machine-wide one is a different
 * question again, so the reason has to survive detection rather than being inferred later.
 */
function testEveryCandidateCarriesWhyItIsOffered(): void {
  const root = project();
  try {
    assert.equal(
      candidates(root).some((one) => one.reason === 'configured'),
      false,
      'an empty project has nothing configured in it',
    );

    makeEveryProjectHarnessPresent(root);

    const offered = candidates(root);
    const configured = offered.filter((one) => one.reason === 'configured');
    assert.equal(
      configured.length,
      HARNESSES.filter((harness) => harness.scope === 'project').length,
      'every project-scoped harness is offered once its directory is there',
    );
    for (const one of configured) {
      assert.ok(
        configPath(one.harness, root).startsWith(root),
        `${one.harness.id} is offered as a project write but would land outside it`,
      );
    }
    for (const one of offered.filter((candidate) => candidate.reason === 'machine-wide')) {
      assert.equal(one.harness.scope, 'home', `${one.harness.id} is only machine-wide if it has to be`);
      assert.equal(
        configPath(one.harness, root).startsWith(root),
        false,
        `${one.harness.id} is only worth asking about because its config is outside the project`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A marker we would read to decide a harness is installed has to be one it documents. */
function testEveryInstalledMarkerIsUnderHome(): void {
  const marked = HARNESSES.filter((harness) => harness.home !== undefined);
  assert.ok(marked.length > 0, 'some harnesses carry a home marker, or this proves nothing');
  for (const harness of marked) {
    assert.equal(harness.scope, 'project', `${harness.id} only needs a marker if it is project-scoped`);
    assert.ok(
      !(harness.home ?? '').startsWith('/'),
      `${harness.id} names a path under home, not an absolute one`,
    );
    assert.ok(!(harness.home ?? '').includes('..'), `${harness.id} does not climb out of home`);
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

/**
 * Taking gdharness out again. The file belongs to the harness, so the only thing that may change
 * is our own entry: everything else in it, servers and settings alike, comes through untouched.
 */
function testRemovingTakesOnlyOurEntry(): void {
  const harness = harnessById('cursor');
  assert.ok(harness, 'cursor is in the table');
  const root = project();
  try {
    const path = join(root, harness.file as string);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { other: { command: 'other-server' } },
        somethingElse: { kept: true },
      }),
      'utf8',
    );
    connect(harness, root, LAUNCH);

    const removal = disconnect(harness, root);
    assert.equal(removal.action, 'removed');
    const config = read(path);
    const servers = config['mcpServers'] as Record<string, unknown>;
    assert.deepEqual(servers['other'], { command: 'other-server' }, 'their server survives');
    assert.deepEqual(config['somethingElse'], { kept: true }, 'and so does a key we know nothing about');
    assert.equal(SERVER_KEY in servers, false, 'ours is gone');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A file that held nothing but gdharness is one we created, and leaving it empty is litter. */
function testAFileThatHeldOnlyUsIsDeleted(): void {
  const harness = harnessById('claude-code');
  assert.ok(harness, 'claude-code is in the table');
  const root = project();
  try {
    const written = connect(harness, root, LAUNCH);
    assert.equal(written.action, 'written');

    const removal = disconnect(harness, root);
    assert.equal(removal.action, 'deleted');
    assert.equal(existsSync(written.path), false, 'the file goes with the entry');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Nothing to say is better than something wrong to say. A config that is not there, or is there
 * without us in it, or cannot be parsed, all mean the same thing: we have nothing to remove.
 */
function testThereIsNothingToReportWhenWeWereNeverThere(): void {
  const harness = harnessById('cursor');
  const toml = harnessById('vtcode');
  assert.ok(harness && toml, 'both are in the table');
  const root = project();
  try {
    assert.equal(disconnect(harness, root).action, 'absent', 'no file at all');
    assert.equal(disconnect(toml, root).action, 'absent', 'and no advice about a file that is not there');

    const path = join(root, harness.file as string);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: 'other' } } }), 'utf8');
    assert.equal(disconnect(harness, root).action, 'absent', 'a config holding only their servers');

    writeFileSync(path, '{ not json at all', 'utf8');
    assert.equal(disconnect(harness, root).action, 'absent', 'and one we could never have written to');
    assert.equal(readFileSync(path, 'utf8'), '{ not json at all', 'which is left exactly as it was');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A config we cannot edit gets described instead, and only once its file actually exists. */
function testAConfigWeCannotEditIsDescribedRatherThanTouched(): void {
  const harness = harnessById('codex');
  assert.ok(harness?.removeCommand, 'codex documents how to take a server out');
  const root = project();
  try {
    const path = join(root, 'config.toml');
    writeFileSync(path, '[mcp_servers.gdharness]\n', 'utf8');
    const removal = disconnect({ ...harness, scope: 'project', file: 'config.toml' }, root);
    assert.equal(removal.action, 'manual');
    assert.deepEqual(removal.command, ['codex', 'mcp', 'remove', 'gdharness']);
    assert.equal(readFileSync(path, 'utf8'), '[mcp_servers.gdharness]\n', 'the file is not touched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const TESTS = [
  testEveryIdIsUniqueAndFindable,
  testTheLaunchIsTheSameEverywhere,
  testEachShapeIsWrittenAsItsHarnessReadsIt,
  testAConfigIsWrittenWhereTheHarnessLooks,
  testHarnessesSharingAFileAreWrittenOnce,
  testEveryHarnessHasAReadablePathOnEveryPlatform,
  testNothingAlreadyInTheFileIsLost,
  testWritingTwiceReplacesRatherThanDuplicates,
  testAConfigThatDoesNotParseIsLeftAlone,
  testDetectionNeverReachesOutOfTheProject,
  testEveryCandidateCarriesWhyItIsOffered,
  testEveryInstalledMarkerIsUnderHome,
  testAHarnessIsDetectedByItsOwnDirectory,
  testAHarnessWeCannotWriteIsNeverWrittenTo,
  testCodexCarriesTheGodotPath,
  testRemovingTakesOnlyOurEntry,
  testAFileThatHeldOnlyUsIsDeleted,
  testThereIsNothingToReportWhenWeWereNeverThere,
  testAConfigWeCannotEditIsDescribedRatherThanTouched,
];

for (const test of TESTS) {
  test();
}

console.log(`harness table tests passed for ${HARNESSES.length} harnesses`);
process.exitCode = 0;
