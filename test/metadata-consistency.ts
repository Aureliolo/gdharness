#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import process from 'node:process';
import pkg from '../package.json' with { type: 'json' };
import serverManifest from '../server.json' with { type: 'json' };
import { HARNESSES } from '../src/harnesses.js';
import { RESOURCE_COUNT } from '../src/resources.js';
import { TOOL_SPECS } from '../src/tool-definitions.js';
import { isRecord } from './support/json-rpc.js';
import { ServerProcess } from './support/server.js';

assert.equal(serverManifest.version, pkg.version, 'server.json version should match package.json');
// How the registry decides this repository owns the name it is publishing: it reads `mcpName`
// out of the package npm serves and refuses anything that is not exactly the server's name. The
// two sit in different files, so without this they drift and the release job is where it shows.
assert.equal(
  pkg.mcpName,
  serverManifest.name,
  'package.json mcpName should be the name server.json publishes under',
);
// The registry entry is installable only if it names a package, and correct only if that package
// is the npm one at this exact version. A manifest pointing at a version nobody published is
// worse than no manifest: a client believes it and fails at install.
const registryPackages: unknown = (serverManifest as { packages?: unknown }).packages;
assert.ok(
  Array.isArray(registryPackages) && registryPackages.length === 1,
  'server.json should name exactly one installable package',
);
const registryPackage: unknown = registryPackages[0];
assert.ok(isRecord(registryPackage), 'the package entry should be an object');
assert.equal(registryPackage['registryType'], 'npm', 'the package should be the npm one');
assert.equal(registryPackage['identifier'], pkg.name, 'the package should be named as package.json names it');
assert.equal(registryPackage['version'], pkg.version, 'the package version should match package.json');
assert.deepEqual(registryPackage['transport'], { type: 'stdio' }, 'the package should be a stdio server');
assert.equal(
  serverManifest.websiteUrl,
  pkg.homepage,
  'server.json website should match the package homepage',
);
assert.equal(
  serverManifest.repository.url,
  'https://github.com/Aureliolo/gdharness',
  'server.json should link to the canonical GitHub repository',
);
assert.equal(
  serverManifest.websiteUrl,
  'https://github.com/Aureliolo/gdharness#readme',
  'server.json should link to the canonical project page',
);
assert.equal(
  pkg.repository.url,
  'git+https://github.com/Aureliolo/gdharness.git',
  'package.json should link to the canonical GitHub repository',
);
assert.equal(
  serverManifest.repository.source,
  'github',
  'server.json should identify GitHub as its repository source',
);

assert.match(pkg.description, /godot/i, 'package description should say what the harness is for');

/**
 * The numbers the README states about itself, against the tables they are about.
 *
 * Nothing generates the README, so a count in it is a number somebody typed once. The same prose
 * in the docs said eight harnesses had no project-level config when it was eleven, and that nine
 * read the shared skills directory when it was thirty-two of thirty-five. Both had been true, and
 * both had been wrong for twenty-four harnesses.
 */
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const claimed = (pattern: RegExp, what: string): number => {
  const found = pattern.exec(readme);
  assert.ok(found?.[1], `the README should still state ${what}`);
  return Number(found[1]);
};
assert.equal(
  claimed(/\|\s*(\d+) tools named/, 'how many tools there are'),
  TOOL_SPECS.length,
  'the README tool count should match the tools the server answers',
);
assert.equal(
  claimed(/and (\d+) `godot:\/\/` resources/, 'how many resources there are'),
  RESOURCE_COUNT,
  'the README resource count should match the resources the server serves',
);
assert.equal(
  claimed(/\|\s*Harnesses\s*\|\s*(\d+),/, 'how many harnesses it knows'),
  HARNESSES.length,
  'the README harness count should match the harness table',
);
// The row above these says what a reader has to install before any of it works, and it is the one
// claim on that table nothing was holding: the counts are checked against what the server answers,
// while the versions were prose agreeing with `engines` by memory. A minimum raised in package.json
// and not here leaves the table telling somebody the runtime they have is enough.
assert.equal(
  `>=${claimed(/Node (\d+) or newer/, 'the Node version it needs')}.0.0`,
  pkg.engines.node,
  'the README Node version should be the one package.json will refuse an install under',
);
assert.equal(
  `>=${claimed(/Runs under Bun ([\d.]+)/, 'the Bun version it runs under')}.0`,
  pkg.engines.bun,
  'the README Bun version should be the one package.json names',
);
/**
 * The same, for the counts the documentation writes out in words.
 *
 * The README's are checked above because they are the ones somebody reads first, and these are the
 * rest of the numbers in this repository that a file on disk can settle. A word is as typed-once as
 * a digit: `three addons` was written when there were three and says nothing when there is a fourth.
 *
 * Only the counts something here can compute. A count of the bullets under it, or of anything
 * outside this repository, has nothing to hold it to and is better written as its list than guarded
 * by a check that has to be told the answer.
 */
const WRITTEN_COUNTS: readonly [string, RegExp, number][] = [
  [
    'docs/install.md',
    /The (\w+) addons land in/,
    readdirSync(new URL('../src/godot/addons', import.meta.url)).length,
  ],
  [
    'docs/architecture.md',
    /read by all but (\w+) harnesses/,
    HARNESSES.filter((harness) => harness.skills !== undefined && !harness.skills.shared).length,
  ],
];
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
for (const [file, pattern, actual] of WRITTEN_COUNTS) {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const found = pattern.exec(text);
  assert.ok(found?.[1], `${file} should still make the claim ${pattern.source} is about`);
  assert.equal(
    found[1],
    NUMBER_WORDS[actual] ?? String(actual),
    `${file} states a count the repository no longer has`,
  );
}

assert.match(
  serverManifest.description,
  /godot/i,
  'server manifest description should say what the harness is for',
);
assert.ok(
  serverManifest.description.length <= 100,
  'server.json description must satisfy the MCP schema 100-character limit',
);

const versionOutput = execFileSync(process.execPath, ['./build/cli.js', 'version'], {
  cwd: process.cwd(),
  encoding: 'utf8',
}).trim();
assert.equal(
  versionOutput,
  `${pkg.name} v${pkg.version}`,
  'CLI version output should stay in sync with package.json',
);

const server = new ServerProcess({ entry: './build/cli.js' });
try {
  const init = await server.initialize('metadata-test');
  assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init.error)}`);
  const result = isRecord(init.result) ? init.result : {};
  const serverInfo = isRecord(result['serverInfo']) ? result['serverInfo'] : {};
  assert.equal(serverInfo['name'], pkg.name, 'initialize should report package-aligned server name');
  assert.equal(serverInfo['version'], pkg.version, 'initialize should report package-aligned server version');
  const capabilities = isRecord(result['capabilities']) ? result['capabilities'] : {};
  const tools = isRecord(capabilities['tools']) ? capabilities['tools'] : {};
  // The list never changes, so a client is not told to expect it to.
  assert.equal(tools['listChanged'], undefined, 'initialize should not advertise a changing tool list');
} finally {
  await server.stop();
}
