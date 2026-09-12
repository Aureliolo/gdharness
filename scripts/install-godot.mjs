/**
 * Installs the pinned Godot for this platform and says where it landed.
 *
 * The engine is a 180 MB binary that CI executes, which makes it the largest untrusted input in
 * a repository whose claim is that everything in it is pinned by digest. A setup action cannot
 * make that claim for us: it fetches whatever the release is today, puts it somewhere it does
 * not document under a name that differs per platform, and checks nothing about what arrived.
 * This fetches the published asset, refuses anything but the digest written below, and hands
 * back an absolute path to a binary that has already answered --version.
 *
 * Raising the version means raising the digests too. They come from the SHA512-SUMS.txt
 * attached to the same release, and a mismatch is a hard failure rather than a warning.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const VERSION = '4.7.2-stable';

/**
 * Per platform: the asset on the release, its SHA-512 as published, and where the executable
 * sits once the archive is open. The Windows archive holds two binaries and this is the plain
 * one on purpose: the console build derives the real executable's filename from its own and
 * dies if it is ever renamed, while the plain build writes to a redirected pipe, which is what
 * every caller here gives it.
 */
const BUILDS = {
  linux: {
    asset: `Godot_v${VERSION}_linux.x86_64.zip`,
    digest:
      '9aa00f7a605200940bce3027a567b782f49bd8e940dd06ae9e987bd65aee1b1467edd56ed84fcdcbdd44354bf613bdbb4e5d2913e925850368e150c59ed54c65',
    executable: `Godot_v${VERSION}_linux.x86_64`,
  },
  darwin: {
    asset: `Godot_v${VERSION}_macos.universal.zip`,
    digest:
      '38aa16e5bba2083941fc5b3e54be0089bd4cc35e32415f5b9fd9a8a6a7b9818255d44532ea8ef94b5aef56c4b407c2d634fa4f657e4ebe681ebbf59b7bac69ca',
    executable: join('Godot.app', 'Contents', 'MacOS', 'Godot'),
  },
  win32: {
    asset: `Godot_v${VERSION}_win64.exe.zip`,
    digest:
      '83decd58fdf67b9d657958a1ae6bf1929c20785315a81effe245874cdc57acb709bf868e00778a96984338c1b29dafdb453c6847747694621c6ecf5da2259993',
    executable: `Godot_v${VERSION}_win64.exe`,
  },
};

const RELEASE_URL = `https://github.com/godotengine/godot/releases/download/${VERSION}`;

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

/** The marker a zip writes in a 32-bit field it could not fit, which means zip64. */
const NEEDS_ZIP64 = 0xffffffff;

/** The release asset, or a throw naming what came back instead. Two attempts, because a
 * transient network failure here is a red build that says nothing about the code. */
async function download(url) {
  let lastFailure = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) {
        throw new Error(`${url} answered ${response.status} ${response.statusText}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (failure) {
      lastFailure = failure;
    }
  }

  throw new Error(`Could not download ${url}: ${lastFailure?.message ?? String(lastFailure)}`);
}

/**
 * Where the end-of-central-directory record starts. It is the last thing in the file, 22 bytes
 * plus a comment of up to 65535, so the search starts at the end and walks back that far.
 */
function endOfCentralDirectory(zip) {
  const earliest = Math.max(0, zip.length - 22 - 0xffff);

  for (let at = zip.length - 22; at >= earliest; at -= 1) {
    if (zip.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) return at;
  }

  throw new Error('Not a zip archive: no end-of-central-directory record.');
}

/**
 * Every entry, read from the central directory rather than from the local headers.
 *
 * The central directory is the authoritative copy: a local header may carry zeroed sizes with
 * the real ones in a trailing data descriptor, which cannot be found without already knowing
 * where the entry ends.
 */
function* entriesOf(zip) {
  const eocd = endOfCentralDirectory(zip);
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);

  for (let seen = 0; seen < count; seen += 1) {
    if (zip.readUInt32LE(at) !== CENTRAL_FILE_HEADER) {
      throw new Error(`Central directory entry ${seen} has no header signature.`);
    }

    const nameLength = zip.readUInt16LE(at + 28);
    const entry = {
      name: zip.subarray(at + 46, at + 46 + nameLength).toString('utf8'),
      method: zip.readUInt16LE(at + 10),
      compressedSize: zip.readUInt32LE(at + 20),
      uncompressedSize: zip.readUInt32LE(at + 24),
      localHeader: zip.readUInt32LE(at + 42),
    };

    // Godot's archives are well under 4 GB, so a zip64 marker here means the archive is not the
    // shape this reader was written for. Say so rather than extract something wrong.
    if ([entry.compressedSize, entry.uncompressedSize, entry.localHeader].includes(NEEDS_ZIP64)) {
      throw new Error(`${entry.name} needs zip64, which this reader does not support.`);
    }

    yield entry;
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
}

/** One entry's bytes, decompressed and checked against the size the directory promised. */
function contentsOf(zip, entry) {
  if (zip.readUInt32LE(entry.localHeader) !== LOCAL_FILE_HEADER) {
    throw new Error(`${entry.name} has no local header where the directory says it is.`);
  }

  // The local header repeats the name and may carry different extra fields, so its own lengths
  // are the ones that place the data.
  const start =
    entry.localHeader +
    30 +
    zip.readUInt16LE(entry.localHeader + 26) +
    zip.readUInt16LE(entry.localHeader + 28);
  const compressed = zip.subarray(start, start + entry.compressedSize);

  let contents;
  if (entry.method === STORED) {
    contents = compressed;
  } else if (entry.method === DEFLATED) {
    contents = inflateRawSync(compressed);
  } else {
    throw new Error(`${entry.name} uses compression method ${entry.method}, which is not stored or deflate.`);
  }

  if (contents.length !== entry.uncompressedSize) {
    throw new Error(
      `${entry.name} unpacked to ${contents.length} bytes, not the ${entry.uncompressedSize} promised.`,
    );
  }

  return contents;
}

/**
 * Opens the archive in process, because shelling out to tar or unzip makes the install depend
 * on which one PATH resolves. GNU tar cannot read a zip at all and is what a Windows machine
 * with git on it finds first, while Windows ships no unzip; that is one platform branch whose
 * two halves have to be right on a runner nobody here can reproduce. Reading the format is
 * about sixty lines and behaves the same everywhere.
 */
export function extract(zip, into) {
  const root = resolve(into);

  for (const entry of entriesOf(zip)) {
    const target = resolve(root, entry.name);

    // An archive naming ../ or an absolute path writes wherever it likes otherwise, and this
    // one is fetched over the network before anything has looked at it.
    const inside = relative(root, target);
    if (inside.startsWith('..') || inside.includes(`..${sep}`)) {
      throw new Error(`${entry.name} would be written outside the install directory.`);
    }

    if (entry.name.endsWith('/')) {
      mkdirSync(target, { recursive: true });
      continue;
    }

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contentsOf(zip, entry));
  }
}

async function main() {
  const build = BUILDS[process.platform];
  if (!build) {
    throw new Error(`No pinned Godot for platform ${process.platform}.`);
  }

  const root = join(process.env.RUNNER_TEMP ?? tmpdir(), `godot-${VERSION}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const archive = await download(`${RELEASE_URL}/${build.asset}`);
  const digest = createHash('sha512').update(archive).digest('hex');
  if (digest !== build.digest) {
    throw new Error(
      [
        `${build.asset} is not the file this repository pins.`,
        `  expected ${build.digest}`,
        `  received ${digest}`,
      ].join('\n'),
    );
  }

  extract(archive, root);

  const executable = join(root, build.executable);
  chmodSync(executable, 0o755);

  // A path that exists is not an engine. Ask it what it is, and fail here rather than leave a
  // broken install for the suite to report as "no Godot found".
  const reported = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 120000 }).trim();
  if (!reported.startsWith(VERSION.replace('-', '.'))) {
    throw new Error(`${executable} reports ${reported}, which is not ${VERSION}.`);
  }

  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `GODOT_PATH=${executable}\n`);
  }

  console.log(`${reported} installed at ${executable}`);
}

// Imported by test/zip-extract.mjs for the reader alone, which must not install an engine.
if (import.meta.main) {
  await main();
}
