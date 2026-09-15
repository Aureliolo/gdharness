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
  harnessNote,
  launchFor,
  SERVER_KEY,
} from '../src/harnesses.js';
import { currentRunner, type Runner, spawnFor } from '../src/runner.js';

const LAUNCH = launchFor('9.9.9', '/opt/godot/godot', '/home/you/game', 'npx');

function project(): string {
  return mkdtempSync(join(tmpdir(), 'gdharness-harness-'));
}

function read(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** Every harness whose config this writes, rather than handing the reader a command or a block. */
/** The harnesses whose config is JSON, which is the shape this file reads back. */
const JSON_WRITERS = HARNESSES.filter(
  (harness) => harness.snippet === undefined && harness.toml === undefined && harness.yaml === undefined,
);

/** The two whose file is documented but whose key is not, so the block is printed. */
const PRINTERS = HARNESSES.filter((harness) => harness.snippet !== undefined);

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
  // The project with it, because a server that knows which one it serves announces its bridge
  // there, and an editor then finds that bridge wherever it landed rather than at one number
  // every project on the machine wants.
  assert.deepEqual(LAUNCH.env, {
    GODOT_PATH: '/opt/godot/godot',
    GDHARNESS_PROJECT: '/home/you/game',
  });

  // Whoever installed with bunx may have no Node at all, so the config has to name their runner,
  // and it is the other runner here: these tests run under Bun, so `npx` is the one we have no
  // path for and can only name.
  const bun = spawnFor('bunx', '9.9.9', '/somewhere/bin/bun');
  assert.deepEqual(bun.args.slice(-1), ['gdharness@9.9.9'], 'the version is pinned either way');
}

function testTheRunnerRunningUsIsNamedByItsPathRatherThanItsName(): void {
  // A harness spawns what a config names, through PATH, and a runner's name is not always on it:
  // a Bun installed under a project ships a `bun` and no `bunx` beside it, so an entry saying
  // `bunx` starts nothing. Found by a project that pins Bun under `.tools/`, where setup reported
  // success over a config that could not spawn. Nothing is lost by naming a path: every entry
  // carries an absolute GODOT_PATH already, so none of these was ever portable between machines.
  const mine = currentRunner();
  const here = spawnFor(mine, '9.9.9', '/somewhere/bin/bun');
  assert.notEqual(here.command, mine, 'the runner running us is named by a path, not by a name');
  assert.ok(here.args.includes('gdharness@9.9.9'), 'and is still asked for the pinned version');
  if (mine === 'bunx') {
    assert.equal(here.command, '/somewhere/bin/bun');
    assert.deepEqual(here.args, ['x', '--bun', 'gdharness@9.9.9'], '`bunx` is `bun x`');
  }

  // The other runner is somebody else's, and there is no path here to know: its name is all there
  // is to offer, and offering it is better than offering nothing.
  const theirs: Runner = mine === 'bunx' ? 'npx' : 'bunx';
  assert.equal(spawnFor(theirs, '9.9.9').command, theirs);
}

/**
 * A Bun entry starts the server under Bun, rather than under whatever Node is lying around.
 *
 * Our bundles carry a Node shebang so that the npx line works, and a runner honours a shebang, so
 * a plain `bun x` hands the file to Node. An entry that names a pinned Bun and then runs a server
 * under an unpinned Node says one thing and does another, and which runtime it lands on becomes a
 * property of the machine. Found by a project that pins Bun under `.tools/` and read its own
 * config back: it named `npx.cmd` under `C:\\Program Files`.
 */
function testABunEntryRunsUnderBun(): void {
  for (const spawn of [spawnFor('bunx', '9.9.9', '/somewhere/bin/bun'), spawnFor('bunx', '9.9.9')]) {
    assert.ok(
      spawn.args.includes('--bun'),
      `a bunx entry should ask for Bun's own runtime, got ${JSON.stringify(spawn)}`,
    );
  }
  assert.ok(
    !spawnFor('npx', '9.9.9').args.includes('--bun'),
    'and npx, which has no such flag, should not be handed one',
  );
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
  assert.deepEqual(open['environment'], LAUNCH.env, 'opencode calls it environment, not env');
  assert.equal(open['enabled'], true);
}

function testAConfigIsWrittenWhereTheHarnessLooks(): void {
  for (const harness of JSON_WRITERS.filter((known) => known.scope === 'project')) {
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
    const second = connect(harness, root, launchFor('9.9.10', '/opt/godot/other', root, 'npx'));
    assert.equal(second.action, 'replaced', 'the second write says it replaced the entry');

    const servers = read(second.path)['mcpServers'] as Record<string, Record<string, unknown>>;
    assert.deepEqual(servers[SERVER_KEY]?.['args'], ['-y', 'gdharness@9.9.10'], 'the new version won');
    assert.equal(Object.keys(servers).length, 1, 'and there is still one gdharness');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * An upgrade keeps what somebody put in gdharness's own entry, not just the rest of the file.
 *
 * The entry was rebuilt from nothing on every write, so ports a person had pinned by hand went with
 * it and nothing said so. They are the worst keys to lose: nobody sets them until they already have
 * a port conflict, so the only config that loses them is the one that needed them. Reported from a
 * project holding all three, whose next editor would have come back on the defaults and collided
 * with the project they were set to avoid.
 */
function testAnUpgradeKeepsWhatWasPinnedByHand(): void {
  const harness = harnessById('claude-code');
  assert.ok(harness, 'claude-code is in the table');
  const root = project();
  try {
    connect(harness, root, LAUNCH);
    const path = configPath(harness, root);
    const before = read(path);
    const servers = before['mcpServers'] as Record<string, Record<string, unknown>>;
    const entry = servers[SERVER_KEY];
    assert.ok(entry, 'the install wrote an entry to pin anything in');
    entry['env'] = {
      ...(entry['env'] as Record<string, string>),
      GDHARNESS_BRIDGE_PORT: '6515',
      GDHARNESS_LSP_PORT: '6015',
    };
    entry['timeout'] = 120;
    writeFileSync(path, `${JSON.stringify(before, null, 2)}\n`, 'utf8');

    connect(harness, root, launchFor('9.9.10', '/opt/godot/other', root, 'npx'));

    const after = (read(path)['mcpServers'] as Record<string, Record<string, unknown>>)[SERVER_KEY];
    assert.ok(after, 'gdharness is still in the file');
    const env = after['env'] as Record<string, string>;
    assert.equal(env['GDHARNESS_BRIDGE_PORT'], '6515', 'a port pinned by hand survives the upgrade');
    assert.equal(env['GDHARNESS_LSP_PORT'], '6015', 'and so does the next one');
    assert.equal(after['timeout'], 120, 'and a key on the entry gdharness knows nothing about');

    // What the upgrade is for still wins, and the two the install decides are still its own.
    assert.deepEqual(after['args'], ['-y', 'gdharness@9.9.10'], 'the version is re-pinned');
    assert.equal(env['GODOT_PATH'], '/opt/godot/other', 'and the engine path is written over');
    assert.equal(env['GDHARNESS_PROJECT'], root, 'and so is the project');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * An install that replaces a command somebody set by hand says which one it replaced.
 *
 * The command and the arguments are written over on purpose, because they carry the version and
 * that is the whole of what an upgrade is. So a config pointed at a local build goes back to the
 * published package, and "replaced .mcp.json" says nothing about it: the session afterwards runs a
 * different server from the one somebody chose, under a line that read like success. Reported from
 * a project running gdharness out of a working tree to get at an unreleased fix.
 */
function testAnInstallSaysWhatItLaunchedInsteadOf(): void {
  const harness = harnessById('claude-code');
  assert.ok(harness, 'claude-code is in the table');
  const root = project();
  try {
    connect(harness, root, LAUNCH);
    const path = configPath(harness, root);
    const before = read(path);
    const entry = (before['mcpServers'] as Record<string, Record<string, unknown>>)[SERVER_KEY];
    assert.ok(entry, 'the install wrote an entry to point somewhere else');
    entry['command'] = 'node';
    entry['args'] = ['../gdharness/build/index.js'];
    writeFileSync(path, `${JSON.stringify(before, null, 2)}\n`, 'utf8');

    const moved = connect(harness, root, LAUNCH);
    assert.equal(
      moved.wasLaunchedBy,
      'node ../gdharness/build/index.js',
      'the line it replaced is named rather than dropped in silence',
    );

    // And a write that moved nothing says nothing, so the line means what it says when it appears.
    assert.equal(connect(harness, root, LAUNCH).wasLaunchedBy, undefined, 'nothing moved, nothing said');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * What an upgrade says the harness is still running is what the config held, not what the addons
 * were.
 *
 * The note inferred one from the other, which holds only while a gdharness install is the thing
 * that wrote the config. A project pointed at a local build to get at an unreleased fix was told a
 * version that appeared nowhere in its config, and the instruction beside it was right either way,
 * which is exactly why a wrong number there could sit for good.
 */
function testTheUpgradeNoteNamesTheConfigRatherThanTheAddons(): void {
  const moved = harnessNote(['node ../gdharness/build/index.js'], 'npx -y gdharness@9.9.10');
  assert.match(moved, /node \.\.\/gdharness\/build\/index\.js/, 'it names what the config held');
  assert.match(moved, /npx -y gdharness@9\.9\.10/, 'and what it holds now');

  // Nothing moved, so there is nothing it can honestly name: the server the harness is running is
  // whichever one it spawned, and an upgrade cannot see into another process.
  const still = harnessNote([], 'npx -y gdharness@9.9.10');
  assert.match(still, /already named this version/, 'it says the config was already there');
  assert.doesNotMatch(still, /9\.9\.10 *\n? *when/, 'and claims nothing about what is running');
  assert.match(still, /Reconnect the MCP server/, 'and still says what to do');
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
 * A harness that will not take the config's word for it says so.
 *
 * Writing the file is not the same as being connected: one reads its config only at startup, one
 * asks you to trust the folder, one asks you to trust the server, one asks before every tool
 * call, and one will not start a project server until you toggle it on. Each of those is an
 * install that reports success and then answers nothing, so the sentence explaining it has to
 * exist and has to be a sentence.
 */
function testEveryManualStepIsSaidOutLoud(): void {
  const named = HARNESSES.filter((harness) => harness.manual !== undefined);
  for (const harness of named) {
    const line = harness.manual ?? '';
    assert.match(line, /^[A-Z]/, `${harness.id}: the line should read as a sentence: ${line}`);
    assert.match(line, /\.$/, `${harness.id}: and end like one: ${line}`);
    assert.ok(line.length > 20, `${harness.id}: and actually say something: ${line}`);
  }
  // Each of these was read off that harness's own documentation rather than assumed from how a
  // similar one behaves, and each holds the reader up before anything answers.
  for (const id of ['codex', 'cursor', 'vscode', 'copilot-cli', 'warp']) {
    assert.ok(
      named.some((harness) => harness.id === id),
      `${id} makes the reader do something, and should say so`,
    );
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
  for (const harness of PRINTERS) {
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

/**
 * TOML is written, not printed. The engine path is this machine's, which is the one thing a block
 * of copy-paste cannot carry, and the reason a paste step was worth removing.
 */
function testATomlConfigIsWrittenAndCarriesTheGodotPath(): void {
  const harness = harnessById('codex');
  assert.ok(harness?.toml, 'codex is in the table with a TOML block');
  const root = project();
  const local = { ...harness, scope: 'project' as const, file: 'config.toml' };
  try {
    const path = join(root, 'config.toml');
    writeFileSync(path, '# mine\nmodel = "something"\n\n[tools]\nweb_search = true\n', 'utf8');

    assert.equal(connect(local, root, LAUNCH).action, 'written');
    const written = readFileSync(path, 'utf8');
    assert.match(written, /^# mine$/m, 'their comment survives');
    assert.match(written, /^model = "something"$/m, 'and their keys');
    assert.match(written, /^\[tools]$/m, 'and their other tables');
    assert.match(written, /\[mcp_servers\.gdharness]/, 'ours is in it');
    assert.match(written, /GODOT_PATH = "\/opt\/godot\/godot"/, 'carrying this machine\u2019s engine');

    // Twice over is once: an entry replaced rather than a second copy appended.
    assert.equal(
      connect(local, root, launchFor('9.9.10', '/opt/godot/other', root, 'npx')).action,
      'replaced',
    );
    const again = readFileSync(path, 'utf8');
    assert.equal(again.match(/\[mcp_servers\.gdharness]/g)?.length, 1, 'still one entry');
    assert.match(again, /gdharness@9\.9\.10/, 'and it is the new version');

    assert.equal(disconnect(local, root).action, 'removed');
    const left = readFileSync(path, 'utf8');
    assert.doesNotMatch(left, /gdharness/, 'ours is gone');
    assert.match(left, /^# mine$/m, 'theirs is not');
    assert.match(left, /^\[tools]$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** YAML goes through a parser, because the comments in these files are the reader's. */
function testAYamlConfigKeepsItsComments(): void {
  const harness = harnessById('hermes');
  assert.ok(harness?.yaml, 'hermes is in the table with a YAML path');
  const root = project();
  const local = { ...harness, scope: 'project' as const, file: 'config.yaml' };
  try {
    const path = join(root, 'config.yaml');
    writeFileSync(
      path,
      '# my notes\nmodel: something\n\nmcp_servers:\n  # theirs, do not touch\n  other:\n    command: other\n',
      'utf8',
    );

    assert.equal(connect(local, root, LAUNCH).action, 'written');
    const written = readFileSync(path, 'utf8');
    assert.match(written, /# my notes/, 'the comment at the top survives');
    assert.match(written, /# theirs, do not touch/, 'and the one inside the mapping');
    assert.match(written, /^\s+other:$/m, 'their server survives');
    assert.match(written, /gdharness/, 'and ours is there');
    assert.match(written, /\/opt\/godot\/godot/, 'carrying the engine path');

    assert.equal(disconnect(local, root).action, 'removed');
    const left = readFileSync(path, 'utf8');
    assert.doesNotMatch(left, /gdharness/, 'ours is gone');
    assert.match(left, /# theirs, do not touch/, 'their comment is not');
    assert.match(left, /^\s+other:$/m, 'nor their server');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A file we could not write we cannot read our way out of either, so it is described instead. */
function testAConfigWeCannotEditIsDescribedRatherThanTouched(): void {
  const harness = harnessById('nanobot');
  assert.ok(harness?.snippet, 'nanobot is one whose key is not documented');
  const root = project();
  const local = { ...harness, scope: 'project' as const, file: 'config.json' };
  try {
    const path = join(root, 'config.json');
    const theirs = '{ "something": true }';
    writeFileSync(path, theirs, 'utf8');

    const written = connect(local, root, LAUNCH);
    assert.equal(written.action, 'snippet');
    assert.match(written.snippet ?? '', /gdharness@9\.9\.9/, 'the block names the pinned version');
    assert.equal(readFileSync(path, 'utf8'), theirs, 'and the file is untouched');

    assert.equal(disconnect(local, root).action, 'manual');
    assert.equal(readFileSync(path, 'utf8'), theirs, 'removal leaves it alone too');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

const TESTS = [
  testEveryIdIsUniqueAndFindable,
  testTheLaunchIsTheSameEverywhere,
  testEachShapeIsWrittenAsItsHarnessReadsIt,
  testAConfigIsWrittenWhereTheHarnessLooks,
  testTheRunnerRunningUsIsNamedByItsPathRatherThanItsName,
  testABunEntryRunsUnderBun,
  testHarnessesSharingAFileAreWrittenOnce,
  testEveryHarnessHasAReadablePathOnEveryPlatform,
  testNothingAlreadyInTheFileIsLost,
  testWritingTwiceReplacesRatherThanDuplicates,
  testAnUpgradeKeepsWhatWasPinnedByHand,
  testAnInstallSaysWhatItLaunchedInsteadOf,
  testTheUpgradeNoteNamesTheConfigRatherThanTheAddons,
  testAConfigThatDoesNotParseIsLeftAlone,
  testDetectionNeverReachesOutOfTheProject,
  testEveryCandidateCarriesWhyItIsOffered,
  testEveryManualStepIsSaidOutLoud,
  testEveryInstalledMarkerIsUnderHome,
  testAHarnessIsDetectedByItsOwnDirectory,
  testAHarnessWeCannotWriteIsNeverWrittenTo,
  testATomlConfigIsWrittenAndCarriesTheGodotPath,
  testAYamlConfigKeepsItsComments,
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
