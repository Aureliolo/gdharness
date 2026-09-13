#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import pkg from '../package.json' with { type: 'json' };
import serverManifest from '../server.json' with { type: 'json' };
import { isRecord } from './support/json-rpc.js';
import { ServerProcess } from './support/server.js';

assert.equal(serverManifest.version, pkg.version, 'server.json version should match package.json');
assert.equal(
  (serverManifest as { packages?: unknown }).packages,
  undefined,
  'server.json should not advertise a registry package for a GitHub Release tarball',
);
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
