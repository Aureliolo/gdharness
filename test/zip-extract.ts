/**
 * The zip reader the Godot installer uses.
 *
 * It opens an archive fetched over the network, so the guards in it are the only thing between a
 * tampered release and arbitrary files written wherever the archive asks. A guard nothing drives
 * is a guard nobody knows is still there, so each one is given an archive built to trip it.
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { download, extract, releaseAsset } from '../scripts/install-godot.js';
import { sweep } from './support/sweep.js';
import { buildZip } from './support/zip.js';

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
 * is what is held, not only that it ended well. A host that never recovers has to end in a
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

async function testAReleaseFileComesThroughTheApi(): Promise<void> {
  const saved = process.env['GH_TOKEN'];
  process.env['GH_TOKEN'] = 'the-token';
  const asked: { url: string; headers: Headers; redirect: string | undefined }[] = [];
  const github = (url: string, init: RequestInit): Promise<Response> => {
    asked.push({ url, headers: new Headers(init.headers), redirect: init.redirect });
    if (url.endsWith('/releases/tags/v1')) {
      return Promise.resolve(
        Response.json({
          assets: [{ name: 'tool.zip', url: 'https://api.github.com/repos/o/r/releases/assets/7' }],
        }),
      );
    }
    if (url.endsWith('/assets/7')) {
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: 'https://storage.invalid/signed?sig=1' } }),
      );
    }
    return Promise.resolve(new Response('the tool'));
  };
  const instantly = (): Promise<void> => Promise.resolve();

  try {
    const got = await releaseAsset('o/r', 'v1', 'tool.zip', github, instantly);
    assert.equal(got.toString('utf8'), 'the tool');
    assert.deepEqual(
      asked.map((each) => [
        each.url,
        each.headers.get('accept') ?? undefined,
        each.headers.get('authorization') ?? undefined,
        each.redirect,
      ]),
      [
        [
          'https://api.github.com/repos/o/r/releases/tags/v1',
          'application/vnd.github+json',
          'Bearer the-token',
          undefined,
        ],
        [
          'https://api.github.com/repos/o/r/releases/assets/7',
          'application/octet-stream',
          'Bearer the-token',
          'manual',
        ],
        ['https://storage.invalid/signed?sig=1', undefined, undefined, 'follow'],
      ],
      'the release is looked up and its file fetched through the API, and the token never reaches storage',
    );

    await assert.rejects(
      releaseAsset('o/r', 'v1', 'other.zip', github, instantly),
      /^Error: Release v1 of o\/r has no file named other\.zip\.$/,
    );
  } finally {
    if (saved === undefined) {
      delete process.env['GH_TOKEN'];
    } else {
      process.env['GH_TOKEN'] = saved;
    }
  }
}

testRejectsZip64();
testRejectsMisplacedLocalHeader();
testRejectsSizeMismatch();
testRejectsUnknownCompression();
testRejectsNonZip();
await testADownloadWaitsOutAGatewayTimeout();
await testAReleaseFileComesThroughTheApi();

console.log('zip extract tests passed');
