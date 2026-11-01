#!/usr/bin/env bun
/**
 * The pinned gdstyle on every GDScript file under the directories given, named one by one.
 *
 *     bun scripts/gdstyle.ts --lint <directory>...            every finding failing
 *     bun scripts/gdstyle.ts --format <directory>...          in place
 *     bun scripts/gdstyle.ts --format --check <directory>...  fail on a file it would change
 *
 * By name, because given a directory gdstyle leaves out everything under addons/ by default, and
 * that is where most of these scripts are: over src/godot it checked 71 of 139. A directory with no
 * GDScript is refused, since gdstyle given no file checks the working directory instead.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { spawnSyncHidden } from '../src/spawn.js';
import { GDSTYLE_VERSION, gdstylePath } from './install-gdstyle.js';

const scripts = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? scripts(path) : entry.name.endsWith('.gd') ? [path] : [];
  });

const args = process.argv.slice(2);
const lint = args.includes('--lint');
if (lint === args.includes('--format')) {
  console.error('Usage: bun scripts/gdstyle.ts --lint | --format [--check] <directory>...');
  process.exit(2);
}
const directories = args.filter((arg) => !arg.startsWith('-'));
const files: string[] = [];
for (const directory of directories) {
  const found = scripts(directory);
  if (found.length === 0) {
    console.error(`${directory} holds no GDScript, so gdstyle would check nothing there.`);
    process.exit(2);
  }
  files.push(...found);
}
if (files.length === 0) {
  console.error('Name the directories to check.');
  process.exit(2);
}

const gdstyle = gdstylePath();
if (!existsSync(gdstyle)) {
  console.error(
    `gdstyle ${GDSTYLE_VERSION} is not installed at ${gdstyle}: run bun scripts/install-gdstyle.ts.`,
  );
  process.exit(2);
}
const command = lint
  ? ['check', '--max-warnings', '0']
  : ['fmt', ...(args.includes('--check') ? ['--check'] : [])];
const ran = spawnSyncHidden(gdstyle, [...command, '--config', 'gdstyle.toml', ...files.toSorted()], {
  stdio: 'inherit',
});
if (ran.error !== undefined) {
  throw ran.error;
}
process.exit(ran.status ?? 1);
