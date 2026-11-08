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
import { join } from 'node:path';
import { toolHome } from '../src/cache-home.js';
import { download, extract } from './install-godot.js';

const REPOSITORY = 'godot-gdunit-labs/gdUnit4';
// renovate: datasource=github-tags depName=godot-gdunit-labs/gdUnit4
const VERSION = 'v6.2.3';
// Below master, whose session finds a case by id itself: the games run a gdUnit4 that lists them, the
// one the runner's indexed session and its session check are for.
const COMMIT = 'f2e4f8679ebd28e27ef523a4fb7b09e8337bfce9';
const DIGEST = '0c0da9141049a79314c43d404b73d25ef6277daface95964495b8a4e2243492b';

async function main(): Promise<void> {
  const root = toolHome(`gdunit4-${COMMIT}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  // codeload, where github.com's archive address redirects: that address answered 502 to 504 while
  // codeload served the same bytes.
  const archive = await download(`https://codeload.github.com/${REPOSITORY}/zip/${COMMIT}`);
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
