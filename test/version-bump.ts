#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type Answer, type Ask, createRef, refState } from '../scripts/github-ref.js';
import { get } from './support/json.js';

const root = path.join(import.meta.dirname, '..');
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'gdharness-version-bump-'));
const maintainedFiles = ['README.md'];

try {
  // Given: every maintained install surface points at the current release asset.
  await mkdir(path.join(fixtureRoot, 'scripts'), { recursive: true });
  await cp(
    path.join(root, 'scripts', 'bump-version.ts'),
    path.join(fixtureRoot, 'scripts', 'bump-version.ts'),
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
        'gdharness-0.1.0.tgz.sha256\nbun add -g "$PWD/gdharness-0.1.0.tgz"\n' +
        'npx -y gdharness@0.1.0 setup . --runtime\n',
    );
  }

  // When: the release version is bumped once.
  const bump = Bun.spawnSync([process.execPath, 'scripts/bump-version.ts', '0.2.0'], {
    cwd: fixtureRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Then: metadata and every maintained download/install reference move together.
  assert.equal(bump.exitCode, 0, bump.stderr.toString());
  for (const manifest of ['package.json', 'server.json']) {
    const parsed: unknown = JSON.parse(await readFile(path.join(fixtureRoot, manifest), 'utf8'));
    assert.equal(get(parsed, 'version'), '0.2.0', `${manifest} should carry the new version`);
  }
  for (const fileName of maintainedFiles) {
    const content = await readFile(path.join(fixtureRoot, fileName), 'utf8');
    assert.doesNotMatch(content, /0\.1\.0/, `${fileName} should not retain the previous release version`);
    assert.match(content, /releases\/download\/v0\.2\.0\/gdharness-0\.2\.0\.tgz/);
    assert.match(content, /gdharness-0\.2\.0\.tgz\.sha256/);
    assert.match(content, /\$PWD\/gdharness-0\.2\.0\.tgz/);
    // The line a reader copies to install it, which is the one that matters most.
    assert.match(content, /npx -y gdharness@0\.2\.0 setup \./);
  }
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

console.log('version bump synchronization checks passed');

/**
 * The refs a release is built on, asked through a stand-in for the API that answers in the order
 * given. A 503 is the answer that stopped a release being prepared on 2026-09-23, and read as
 * "absent" it would also have called a taken tag free.
 */
async function refsAreAskedUntilAnswered(): Promise<void> {
  const scripted = (...answers: (Answer | Error)[]): { ask: Ask; asked: string[] } => {
    const asked: string[] = [];
    const ask: Ask = (method, requested) => {
      asked.push(`${method} ${requested}`);
      const next = answers.shift();
      if (next === undefined) {
        return Promise.reject(new Error(`nothing scripted for ${method} ${requested}`));
      }
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    };
    return { ask, asked };
  };
  const pauses: number[] = [];
  const pause = (ms: number): Promise<void> => {
    pauses.push(ms);
    return Promise.resolve();
  };
  const repository = 'owner/name';

  assert.equal(
    await refState(scripted({ status: 404, body: {} }).ask, repository, 'tags/v1.0.0', pause),
    'absent',
  );
  assert.equal(
    await refState(scripted({ status: 200, body: {} }).ask, repository, 'tags/v1.0.0', pause),
    'present',
  );

  const busy = scripted({ status: 503, body: 'busy' }, new Error('socket hang up'), {
    status: 200,
    body: {},
  });
  assert.equal(await refState(busy.ask, repository, 'tags/v1.0.0', pause), 'present', 'a 503 is asked again');
  assert.deepEqual(busy.asked, Array(3).fill('GET /repos/owner/name/git/ref/tags/v1.0.0'));
  assert.deepEqual(pauses, [5_000, 10_000], 'with a longer pause each time');

  const down = scripted(...Array.from({ length: 5 }, () => ({ status: 503, body: 'busy' })));
  await assert.rejects(
    refState(down.ask, repository, 'tags/v1.0.0', pause),
    /failed on all 5 attempts; the last got HTTP 503/,
    'a 503 on every attempt is a failure, never "absent"',
  );

  const sha = 'a'.repeat(40);
  assert.equal(
    await createRef(
      scripted({ status: 502, body: 'bad gateway' }, { status: 201, body: {} }).ask,
      repository,
      'heads/b',
      sha,
      pause,
    ),
    'created',
  );
  assert.equal(
    await createRef(
      scripted({ status: 422, body: {} }, { status: 200, body: { object: { sha } } }).ask,
      repository,
      'heads/b',
      sha,
      pause,
    ),
    'existed',
    'a ref already at the commit asked for is the ref wanted, so a rerun succeeds',
  );
  await assert.rejects(
    createRef(
      scripted({ status: 422, body: {} }, { status: 200, body: { object: { sha: 'b'.repeat(40) } } }).ask,
      repository,
      'tags/v1.0.0',
      sha,
      pause,
    ),
    /already exists at b{40}, not a{40}/,
    'and one at another commit is refused rather than moved',
  );
}

await refsAreAskedUntilAnswered();
console.log('release ref checks passed');
