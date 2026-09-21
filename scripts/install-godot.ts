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
 * The digests are the ones Godot publishes in the SHA512-SUMS.txt attached to the release, and
 * a mismatch is a hard failure rather than a warning. Renovate raises the tag and the digest of
 * each platform together, which is why the tag is written three times: a digest can only be
 * looked up beside the version it belongs to, and the three are checked against each other
 * below so that a partial update cannot install anything.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { isWithinRoot } from '../src/paths.js';

/**
 * Per platform: the release tag, the SHA-512 of the asset as published, and where the executable
 * sits once the archive is open. The Windows archive holds two binaries and this is the plain
 * one on purpose: the console build derives the real executable's filename from its own and
 * dies if it is ever renamed, while the plain build writes to a redirected pipe, which is what
 * every caller here gives it.
 */
interface Build {
  tag: string;
  digest: string;
  asset: (tag: string) => string;
  executable: (tag: string) => string;
}

const BUILDS: Partial<Record<NodeJS.Platform, Build>> = {
  linux: {
    // renovate: datasource=github-release-attachments depName=godotengine/godot versioning=regex:^(?<major>\d+)\.(?<minor>\d+)(?:\.(?<patch>\d+))?-(?<compatibility>stable)$
    tag: '4.7.2-stable',
    digest:
      '9aa00f7a605200940bce3027a567b782f49bd8e940dd06ae9e987bd65aee1b1467edd56ed84fcdcbdd44354bf613bdbb4e5d2913e925850368e150c59ed54c65',
    asset: (tag) => `Godot_v${tag}_linux.x86_64.zip`,
    executable: (tag) => `Godot_v${tag}_linux.x86_64`,
  },
  darwin: {
    // renovate: datasource=github-release-attachments depName=godotengine/godot versioning=regex:^(?<major>\d+)\.(?<minor>\d+)(?:\.(?<patch>\d+))?-(?<compatibility>stable)$
    tag: '4.7.2-stable',
    digest:
      '38aa16e5bba2083941fc5b3e54be0089bd4cc35e32415f5b9fd9a8a6a7b9818255d44532ea8ef94b5aef56c4b407c2d634fa4f657e4ebe681ebbf59b7bac69ca',
    asset: (tag) => `Godot_v${tag}_macos.universal.zip`,
    executable: () => join('Godot.app', 'Contents', 'MacOS', 'Godot'),
  },
  win32: {
    // renovate: datasource=github-release-attachments depName=godotengine/godot versioning=regex:^(?<major>\d+)\.(?<minor>\d+)(?:\.(?<patch>\d+))?-(?<compatibility>stable)$
    tag: '4.7.2-stable',
    digest:
      '83decd58fdf67b9d657958a1ae6bf1929c20785315a81effe245874cdc57acb709bf868e00778a96984338c1b29dafdb453c6847747694621c6ecf5da2259993',
    asset: (tag) => `Godot_v${tag}_win64.exe.zip`,
    executable: (tag) => `Godot_v${tag}_win64.exe`,
  },
};

/** The one tag every platform pins, or a throw naming the disagreement. */
function pinnedTag(): string {
  const tags = new Set(Object.values(BUILDS).map((build) => build.tag));
  const [tag] = tags;
  if (tags.size !== 1 || tag === undefined) {
    throw new Error(`The platforms pin different Godot releases: ${[...tags].join(', ')}.`);
  }
  return tag;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

/** The marker a zip writes in a 32-bit field it could not fit, which means zip64. */
const NEEDS_ZIP64 = 0xffffffff;

/**
 * How the attempts at a download are spaced, in milliseconds between one and the next.
 *
 * Sized to what it absorbs. A reset or a refusal lands in milliseconds, and a second attempt in
 * the same millisecond is close enough to the first to fail with it, so nothing is immediate. A
 * gateway timeout from the release host is the other shape: GitHub's download front answered
 * 504 to three attempts two seconds apart, and an outage of that kind clears in tens of seconds
 * to a minute, so the spacing doubles until a minute has been given over to it in all. Longer
 * than that is a host that is down, and a red build saying so is the right answer.
 */
const DOWNLOAD_WAITS_MS = [2_000, 4_000, 8_000, 16_000, 32_000] as const;

/**
 * The release asset, or a throw naming what came back instead.
 *
 * Retried, because a transient network failure here is a red build that says nothing about the
 * code; each failed attempt is printed so the log shows what the host answered and when.
 */
export async function download(
  url: string,
  fetching: (url: string) => Promise<Response> = (target) => fetch(target, { redirect: 'follow' }),
  waiting: (ms: number) => Promise<void> = (ms) => new Promise((wake) => setTimeout(wake, ms)),
): Promise<Buffer> {
  let lastFailure: unknown = null;

  for (let attempt = 0; attempt <= DOWNLOAD_WAITS_MS.length; attempt += 1) {
    const wait = attempt === 0 ? undefined : DOWNLOAD_WAITS_MS[attempt - 1];
    if (wait !== undefined) {
      await waiting(wait);
    }
    try {
      const response = await fetching(url);
      if (!response.ok) {
        throw new Error(`${url} answered ${response.status} ${response.statusText}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (failure) {
      lastFailure = failure;
      const next = DOWNLOAD_WAITS_MS[attempt];
      const reason = failure instanceof Error ? failure.message : String(failure);
      console.error(
        `attempt ${attempt + 1} of ${DOWNLOAD_WAITS_MS.length + 1} failed: ${reason}` +
          (next === undefined ? '' : `; trying again in ${next / 1000}s`),
      );
    }
  }

  const reason = lastFailure instanceof Error ? lastFailure.message : String(lastFailure);
  throw new Error(`Could not download ${url}: ${reason}`);
}

/**
 * Where the end-of-central-directory record starts. It is the last thing in the file, 22 bytes
 * plus a comment of up to 65535, so the search starts at the end and walks back that far.
 */
function endOfCentralDirectory(zip: Buffer): number {
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
interface Entry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeader: number;
}

function* entriesOf(zip: Buffer): Generator<Entry> {
  const eocd = endOfCentralDirectory(zip);
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);

  for (let seen = 0; seen < count; seen += 1) {
    if (zip.readUInt32LE(at) !== CENTRAL_FILE_HEADER) {
      throw new Error(`Central directory entry ${seen} has no header signature.`);
    }

    const nameLength = zip.readUInt16LE(at + 28);
    const entry: Entry = {
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
function contentsOf(zip: Buffer, entry: Entry): Buffer {
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

  let contents: Buffer;
  if (entry.method === STORED) {
    contents = compressed;
  } else if (entry.method === DEFLATED) {
    // Deflate expands up to a thousandfold, so a body that unpacks past the size the directory
    // promised is stopped there rather than allowed to fill memory first and fail the size
    // check afterwards. zlib insists the limit be at least one byte.
    contents = inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.uncompressedSize) });
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
export function extract(zip: Buffer, into: string): void {
  const root = resolve(into);

  // Every entry is judged and unpacked before the first one is written, so an archive that
  // turns out to be bad halfway through has put nothing on disk. It was fetched over the network
  // before anything looked at it, and a name such as `../x`, `/etc/x`, `D:/x` or `//host/share/x`
  // otherwise writes wherever it likes; the containment check is the same arithmetic the
  // filesystem will do, shared with the server's own path handling. Holding the unpacked engine
  // in memory for a moment costs a few hundred megabytes on a runner that has gigabytes.
  const planned: { target: string; contents: Buffer | null }[] = [];
  for (const entry of entriesOf(zip)) {
    if (entry.name.includes('\0')) {
      throw new Error('An entry name contains a null byte.');
    }
    const target = resolve(root, entry.name);
    if (target === root) {
      throw new Error(`${entry.name} names the install directory itself.`);
    }
    if (!isWithinRoot(root, target)) {
      throw new Error(`${entry.name} would be written outside the install directory.`);
    }
    planned.push({ target, contents: entry.name.endsWith('/') ? null : contentsOf(zip, entry) });
  }

  for (const { target, contents } of planned) {
    if (contents === null) {
      mkdirSync(target, { recursive: true });
      continue;
    }

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

async function main(): Promise<void> {
  const tag = pinnedTag();
  const build = BUILDS[process.platform];
  if (!build) {
    throw new Error(`No pinned Godot for platform ${process.platform}.`);
  }

  const root = join(process.env['RUNNER_TEMP'] ?? tmpdir(), `godot-${tag}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const asset = build.asset(tag);
  const archive = await download(`https://github.com/godotengine/godot/releases/download/${tag}/${asset}`);
  const digest = createHash('sha512').update(archive).digest('hex');
  if (digest !== build.digest) {
    throw new Error(
      [
        `${asset} is not the file this repository pins.`,
        `  expected ${build.digest}`,
        `  received ${digest}`,
      ].join('\n'),
    );
  }

  extract(archive, root);

  const executable = join(root, build.executable(tag));
  chmodSync(executable, 0o755);

  // A path that exists is not an engine. Ask it what it is, and fail here rather than leave a
  // broken install for the suite to report as "no Godot found".
  const reported = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 120000 }).trim();
  if (!reported.startsWith(tag.replace('-', '.'))) {
    throw new Error(`${executable} reports ${reported}, which is not ${tag}.`);
  }

  const githubEnv = process.env['GITHUB_ENV'];
  if (githubEnv) {
    appendFileSync(githubEnv, `GODOT_PATH=${executable}\n`);
  }

  console.log(`${reported} installed at ${executable}`);
}

// Imported by test/zip-extract.ts for the reader alone and by install-gdunit4.ts for the
// reader and the download, neither of which must install an engine.
if (import.meta.main) {
  await main();
}
