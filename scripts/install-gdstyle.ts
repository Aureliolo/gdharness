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
export const GDSTYLE_VERSION = 'v0.7.0';

const ASSETS: Record<string, { asset: string; digest: string }> = {
  'win32-x64': {
    asset: 'gdstyle-x86_64-pc-windows-msvc.zip',
    digest: '9f270d5cf9e967a85c321792c8e15e297b435d528b37dc6e6bb7c8509a02faa6',
  },
  'linux-x64': {
    asset: 'gdstyle-x86_64-unknown-linux-gnu.tar.gz',
    digest: '05504702d5fc8912799ee5fdca20e98d2f838ed72e28933fce5b855e9e87690e',
  },
  'darwin-x64': {
    asset: 'gdstyle-x86_64-apple-darwin.tar.gz',
    digest: '8cf31191228d524cd5c2c45ed3821ea92ac766433b4522f9dcd82b4102f32ff0',
  },
  'darwin-arm64': {
    asset: 'gdstyle-aarch64-apple-darwin.tar.gz',
    digest: '49ac37392275b1e8c312ad836408bf7445f2de82cc3ffdd7668de919b3ca261e',
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
