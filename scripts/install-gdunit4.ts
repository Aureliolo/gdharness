/**
 * Installs the pinned gdUnit4 for the engine fixtures and says where it landed.
 *
 * The runner is GDScript fetched from GitHub and executed by the engine, so it is pinned the
 * way the engine is: one commit, one digest of the archive that commit answers with, and a
 * hard failure on anything else. It exports GDUNIT4_PATH, the addon directory to copy into a
 * project as addons/gdUnit4.
 *
 * Renovate raises the tag and the commit together and cannot compute the archive digest, so a
 * raise fails here until the digest below is rewritten to what the failure prints: the pin is
 * watched, and nothing installs on the strength of a tag alone.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { download, extract } from './install-godot.js';

const REPOSITORY = 'godot-gdunit-labs/gdUnit4';
// renovate: datasource=github-tags depName=godot-gdunit-labs/gdUnit4
const VERSION = 'v6.2.1';
const COMMIT = '08ffc7c65b61b1b2edd545616061a99973c13ce1';
const DIGEST = 'd96c3b37b9282cd40c724892c321b0e5e3d51dd0cce700241efe0d86b88ec0eb';

async function main(): Promise<void> {
  const root = join(process.env['RUNNER_TEMP'] ?? tmpdir(), `gdunit4-${COMMIT}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const archive = await download(`https://github.com/${REPOSITORY}/archive/${COMMIT}.zip`);
  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== DIGEST) {
    throw new Error(
      [
        `gdUnit4 ${COMMIT} is not the archive this repository pins.`,
        `  expected ${DIGEST}`,
        `  received ${digest}`,
      ].join('\n'),
    );
  }
  extract(archive, root);

  const addon = join(root, `gdUnit4-${COMMIT}`, 'addons', 'gdUnit4');
  if (!existsSync(join(addon, 'bin', 'GdUnitCmdTool.gd'))) {
    throw new Error(`${addon} holds no GdUnitCmdTool.gd.`);
  }

  const githubEnv = process.env['GITHUB_ENV'];
  if (githubEnv) {
    appendFileSync(githubEnv, `GDUNIT4_PATH=${addon}\n`);
  }
  console.log(`gdUnit4 ${VERSION} (${COMMIT}) installed at ${addon}`);
}

await main();
