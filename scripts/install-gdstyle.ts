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
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { download, extract } from './install-godot.js';

const REPOSITORY = 'atelico/gdstyle';
// renovate: datasource=github-releases depName=atelico/gdstyle
export const GDSTYLE_VERSION = 'v0.5.0';

const ASSETS: Record<string, { asset: string; digest: string }> = {
  'win32-x64': {
    asset: 'gdstyle-x86_64-pc-windows-msvc.zip',
    digest: '6b7410466fbd6ba6c7b63caf3868607314f7ab90e33b194899f37990df3ba18c',
  },
  'linux-x64': {
    asset: 'gdstyle-x86_64-unknown-linux-gnu.tar.gz',
    digest: '1322ca08a395b00932d17ff59c9ee634d5b01c6d623c7771865c80689b591936',
  },
  'darwin-x64': {
    asset: 'gdstyle-x86_64-apple-darwin.tar.gz',
    digest: '9836a6ff9030c60307baeb6b358b548b8b0b57d43c9ef75d2b45cc3908c5c5de',
  },
  'darwin-arm64': {
    asset: 'gdstyle-aarch64-apple-darwin.tar.gz',
    digest: '1dd6c25f4e9f5b48f660ee4316da38644911bc6b64db70b3085fcadaa5578266',
  },
};

/** Where the pinned gdstyle is installed on this machine. */
export function gdstylePath(): string {
  const root = join(process.env['RUNNER_TEMP'] ?? tmpdir(), `gdstyle-${GDSTYLE_VERSION}`);
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

  const archive = await download(
    `https://github.com/${REPOSITORY}/releases/download/${GDSTYLE_VERSION}/${pinned.asset}`,
  );
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
