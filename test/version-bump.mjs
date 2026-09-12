#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'gdharness-version-bump-'));
const maintainedFiles = ['README.md'];

try {
  // Given: every maintained install surface points at the current release asset.
  await mkdir(path.join(fixtureRoot, 'scripts'), { recursive: true });
  await cp(
    path.join(root, 'scripts', 'bump-version.mjs'),
    path.join(fixtureRoot, 'scripts', 'bump-version.mjs'),
  );
  await writeFile(path.join(fixtureRoot, 'package.json'), '{"name":"gdharness","version":"0.1.0"}\n');
  await writeFile(
    path.join(fixtureRoot, 'server.json'),
    '{"name":"io.github.Aureliolo/gdharness","version":"0.1.0"}\n',
  );
  for (const fileName of maintainedFiles) {
    await writeFile(
      path.join(fixtureRoot, fileName),
      'https://github.com/Aureliolo/gdharness/releases/download/v0.1.0/gdharness-0.1.0.tgz\n' +
        'gdharness-0.1.0.tgz.sha256\nbun add -g "$PWD/gdharness-0.1.0.tgz"\n',
    );
  }

  // When: the release version is bumped once.
  const bump = Bun.spawnSync([process.execPath, 'scripts/bump-version.mjs', '0.2.0'], {
    cwd: fixtureRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Then: metadata and every maintained download/install reference move together.
  assert.equal(bump.exitCode, 0, bump.stderr.toString());
  assert.equal(JSON.parse(await readFile(path.join(fixtureRoot, 'package.json'), 'utf8')).version, '0.2.0');
  assert.equal(JSON.parse(await readFile(path.join(fixtureRoot, 'server.json'), 'utf8')).version, '0.2.0');
  for (const fileName of maintainedFiles) {
    const content = await readFile(path.join(fixtureRoot, fileName), 'utf8');
    assert.doesNotMatch(content, /0\.1\.0/, `${fileName} should not retain the previous release version`);
    assert.match(content, /releases\/download\/v0\.2\.0\/gdharness-0\.2\.0\.tgz/);
    assert.match(content, /gdharness-0\.2\.0\.tgz\.sha256/);
    assert.match(content, /\$PWD\/gdharness-0\.2\.0\.tgz/);
  }
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

console.log('version bump synchronization checks passed');
