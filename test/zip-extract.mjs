/**
 * The zip reader the Godot installer uses.
 *
 * It opens an archive fetched over the network, so the guards in it are the only thing between a
 * tampered release and arbitrary files written wherever the archive asks. A guard nothing drives
 * is a guard nobody knows is still there, so each one is given an archive built to trip it.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { extract } from '../scripts/install-godot.mjs';

const STORED = 0;
const DEFLATED = 8;

/**
 * A zip holding exactly the entries given, written by hand.
 *
 * Building one rather than checking in a fixture file is what lets a test ask for a name no
 * archiver would produce, or a size field the format reserves, which is the whole point here.
 */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.contents ?? '', 'utf8');
    const method = entry.method ?? STORED;
    const body = method === DEFLATED ? deflateRawSync(raw) : raw;

    const compressedSize = entry.compressedSize ?? body.length;
    const uncompressedSize = entry.uncompressedSize ?? raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(entry.localSignature ?? 0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

/** Extracts into a throwaway directory and hands it to the caller to look at. */
function intoTemp(zip, inspect) {
  const dir = mkdtempSync(join(tmpdir(), 'gdharness-zip-'));
  try {
    return inspect(dir, () => {
      extract(zip, dir);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
