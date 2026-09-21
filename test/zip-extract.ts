/**
 * The zip reader the Godot installer uses.
 *
 * It opens an archive fetched over the network, so the guards in it are the only thing between a
 * tampered release and arbitrary files written wherever the archive asks. A guard nothing drives
 * is a guard nobody knows is still there, so each one is given an archive built to trip it.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { download, extract } from '../scripts/install-godot.js';
import { sweep } from './support/sweep.js';
import { buildZip, DEFLATED } from './support/zip.js';

/** Extracts into a throwaway directory and hands it to the caller to look at. */
function intoTemp(zip: Buffer, inspect: (dir: string, run: () => void) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'gdharness-zip-'));
  try {
    inspect(dir, () => {
      extract(zip, dir);
    });
  } finally {
    sweep(dir);
  }
}

function testRoundTrip() {
  const zip = buildZip([
    { name: 'plain.txt', contents: 'stored bytes' },
    { name: 'nested/' },
    { name: 'nested/packed.txt', contents: 'deflated bytes, repeated'.repeat(40), method: DEFLATED },
  ]);

  intoTemp(zip, (dir, run) => {
    run();
    assert.equal(readFileSync(join(dir, 'plain.txt'), 'utf8'), 'stored bytes');
    assert.equal(
      readFileSync(join(dir, 'nested', 'packed.txt'), 'utf8'),
      'deflated bytes, repeated'.repeat(40),
    );
  });
}

function testRejectsTraversal() {
  for (const name of ['../escaped.txt', 'nested/../../escaped.txt']) {
    const zip = buildZip([{ name, contents: 'should never be written' }]);
    intoTemp(zip, (_dir, run) => {
      assert.throws(run, /outside the install directory/, `${name} should be refused`);
    });
  }
}

function testRejectsZip64() {
  const zip = buildZip([
    { name: 'huge.bin', contents: '', compressedSize: 0xffffffff, uncompressedSize: 0xffffffff },
  ]);
  intoTemp(zip, (_dir, run) => {
    assert.throws(run, /needs zip64/);
  });
}

/** A directory whose central entry points at bytes that are not an entry is a corrupt archive,
 * and reading on from there is how a reader writes whatever happens to follow. */
function testRejectsMisplacedLocalHeader() {
  const zip = buildZip([{ name: 'wrong.txt', contents: 'x', localSignature: 0x04034b51 }]);
  intoTemp(zip, (_dir, run) => {
    assert.throws(run, /no local header/);
  });
}

/** The size in the directory is what the caller is promised, so a body that unpacks to
 * something else is a lie the reader has to catch rather than pass on. */
function testRejectsSizeMismatch() {
  const zip = buildZip([{ name: 'short.txt', contents: 'four', uncompressedSize: 99 }]);
  intoTemp(zip, (_dir, run) => {
    assert.throws(run, /unpacked to 4 bytes, not the 99 promised/);
  });
}

function testRejectsUnknownCompression() {
  const zip = buildZip([{ name: 'exotic.bin', contents: 'x', method: 14 }]);
  intoTemp(zip, (_dir, run) => {
    assert.throws(run, /compression method 14/);
  });
}

function testRejectsNonZip() {
  intoTemp(Buffer.from('this is not an archive, it is a sentence'), (_dir, run) => {
    assert.throws(run, /no end-of-central-directory record/);
  });
}

/**
 * A download waits out a gateway timeout on the release host, with the waits growing.
 *
 * The host is handed in, the way the archive is above, so the case decides what it answers: a
 * 504 to the first four attempts and the bytes on the fifth is the outage the Windows leg met,
 * and it has to end in the bytes rather than a red build. The waits are recorded so the schedule
 * is what is held, not only that it ended well; and a host that never recovers has to end in a
 * throw naming what it kept answering, after the whole schedule and not before.
 */
async function testADownloadWaitsOutAGatewayTimeout(): Promise<void> {
  const url = 'https://example.invalid/engine.zip';
  const gateway = (answers: number[]) => {
    let asked = 0;
    return (target: string): Promise<Response> => {
      assert.equal(target, url, 'every attempt asks for the same asset');
      const status = answers[Math.min(asked, answers.length - 1)] ?? 200;
      asked += 1;
      return Promise.resolve(
        status === 200
          ? new Response('the engine', { status })
          : new Response('', { status, statusText: 'Gateway Time-out' }),
      );
    };
  };
  const waited: number[] = [];
  const recording = (ms: number): Promise<void> => {
    waited.push(ms);
    return Promise.resolve();
  };

  const got = await download(url, gateway([504, 504, 504, 504, 200]), recording);
  assert.equal(got.toString('utf8'), 'the engine', 'the fifth attempt brought the bytes');
  assert.deepEqual(waited, [2_000, 4_000, 8_000, 16_000], 'after four waits that doubled');

  waited.length = 0;
  await assert.rejects(
    download(url, gateway([504]), recording),
    /Could not download .* answered 504 Gateway Time-out/,
    'a host that never recovers is reported with what it kept answering',
  );
  assert.deepEqual(waited, [2_000, 4_000, 8_000, 16_000, 32_000], 'after the whole schedule');
}

testRoundTrip();
testRejectsTraversal();
testRejectsZip64();
testRejectsMisplacedLocalHeader();
testRejectsSizeMismatch();
testRejectsUnknownCompression();
testRejectsNonZip();
await testADownloadWaitsOutAGatewayTimeout();

console.log('zip extract tests passed');
