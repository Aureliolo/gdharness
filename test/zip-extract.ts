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

import { extract } from '../scripts/install-godot.js';
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

testRoundTrip();
testRejectsTraversal();
testRejectsZip64();
testRejectsMisplacedLocalHeader();
testRejectsSizeMismatch();
testRejectsUnknownCompression();
testRejectsNonZip();

console.log('zip extract tests passed');
