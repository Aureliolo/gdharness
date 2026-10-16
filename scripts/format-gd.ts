#!/usr/bin/env bun
/**
 * gdformat with the arguments given, then every GDScript file under the directories among them put
 * back to LF.
 *
 * gdformat writes in Python's text mode, which on Windows turns every line ending of a file it
 * reformats into CRLF. Git restores LF on commit, so nothing published carries them, but the working
 * copy does until then and the build copies the working copy: a local bundle hashed other bytes than
 * the published one, and a project set up from it read its addons as stale beside a server built
 * from the same commit.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { spawnSyncHidden } from '../src/spawn.js';

const args = process.argv.slice(2);
const formatted = spawnSyncHidden('gdformat', args, { stdio: 'inherit' });
if (formatted.error !== undefined) {
  throw formatted.error;
}

const scripts = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? scripts(path) : entry.name.endsWith('.gd') ? [path] : [];
  });

for (const directory of args.filter((arg) => !arg.startsWith('-') && statSync(arg).isDirectory())) {
  for (const path of scripts(directory)) {
    const text = readFileSync(path, 'utf8');
    if (text.includes('\r\n')) {
      writeFileSync(path, text.replaceAll('\r\n', '\n'));
    }
  }
}

process.exit(formatted.status ?? 1);
