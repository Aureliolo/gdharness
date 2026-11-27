/**
 * Installs the pinned gdstyle, which lints and formats the GDScript that ships, and says where it
 * landed.
 *
 * A binary fetched from GitHub, so it is pinned as the engine is: one release, one digest of each
 * platform's archive, and a hard failure on anything else. It installs where `gdstylePath` looks,
 * and on CI puts that directory on PATH too.
 *
 * Renovate raises the version and cannot compute the digests, so a raise fails here until each is
 * rewritten to what the failure prints: nothing installs on the strength of a tag alone.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { toolHome } from '../src/cache-home.js';
import { extract, releaseAsset } from './install-godot.js';

const REPOSITORY = 'atelico/gdstyle';
// renovate: datasource=github-releases depName=atelico/gdstyle
export const GDSTYLE_VERSION = 'v0.8.0';

const ASSETS: Record<string, { asset: string; digest: string }> = {
  'win32-x64': {
    asset: 'gdstyle-x86_64-pc-windows-msvc.zip',
    digest: '9ee5e6e80f2589b4bcd6250286a46614c8a0d7b7aa9800dd9e5a4a79f98aeb31',
  },
  'linux-x64': {
    asset: 'gdstyle-x86_64-unknown-linux-gnu.tar.gz',
    digest: '2d6611eef86fbdb8bac80685bedb9d936d8ceb4ad701995e34f50a558846f64f',
  },
  'darwin-x64': {
    asset: 'gdstyle-x86_64-apple-darwin.tar.gz',
    digest: 'cf540cb0f708ddd183ec9fd46892787b24e8f8483c234726da66578b878620f5',
  },
  'darwin-arm64': {
    asset: 'gdstyle-aarch64-apple-darwin.tar.gz',
    digest: '1e83a5407cdc8383757f6c8f4846d282d265da18a55b1a0d5eb5771f5de77d88',
  },
};

/** Where the pinned gdstyle is installed on this machine. */
export function gdstylePath(): string {
  const root = toolHome(`gdstyle-${GDSTYLE_VERSION}`);
  return join(root, process.platform === 'win32' ? 'gdstyle.exe' : 'gdstyle');
}

/** The one regular file named [name] in a tar archive, which is how each release packs its binary. */
function fromTar(archive: Buffer, name: string): Buffer {
  for (let at = 0; at + 512 <= archive.length; ) {
    const header = archive.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const entry = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim(), 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const body = at + 512;
    if ((type === '0' || type === '\0') && entry.replace(/^\.\//, '') === name) {
      return Buffer.from(archive.subarray(body, body + size));
    }
    at = body + Math.ceil(size / 512) * 512;
  }
  throw new Error(`The archive holds no ${name}.`);
}

async function main(): Promise<void> {
  const platform = `${process.platform}-${process.arch}`;
  const pinned = ASSETS[platform];
  if (pinned === undefined) {
    throw new Error(`gdstyle ${GDSTYLE_VERSION} has no release for ${platform}.`);
  }
  const target = gdstylePath();
  const root = dirname(target);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const archive = await releaseAsset(REPOSITORY, GDSTYLE_VERSION, pinned.asset);
  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== pinned.digest) {
    throw new Error(
      [
        `${pinned.asset} of gdstyle ${GDSTYLE_VERSION} is not the archive this repository pins.`,
        `  expected ${pinned.digest}`,
        `  received ${digest}`,
      ].join('\n'),
    );
  }
  if (pinned.asset.endsWith('.zip')) {
    extract(archive, root);
  } else {
    writeFileSync(target, fromTar(gunzipSync(archive), 'gdstyle'));
    chmodSync(target, 0o755);
  }
  if (!existsSync(target)) {
    throw new Error(`${pinned.asset} holds no ${target}.`);
  }

  const githubPath = process.env['GITHUB_PATH'];
  if (githubPath) {
    appendFileSync(githubPath, `${root}\n`);
  }
  console.log(`gdstyle ${GDSTYLE_VERSION} installed at ${target}`);
}

if (import.meta.main) {
  await main();
}
