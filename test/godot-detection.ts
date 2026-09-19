/**
 * Where the server looks for an engine when nothing names one.
 *
 * A release download is a file called `Godot_v4.4.1-stable_win64.exe`, which no fixed list of
 * install paths can name, so the directories a download lands in are read as well. The list is
 * asserted against a temp directory laid out like a home, so the order in which candidates are
 * tried is a fact about the function rather than about this machine.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { godotCandidates, scanDirectoryForGodotBinaries } from '../src/detection.js';
import { sweep } from './support/sweep.js';

function testIgnoresEmptyAndMissingDirectories() {
  assert.deepEqual(scanDirectoryForGodotBinaries('', 'linux'), [], 'empty directory returns no candidates');
  assert.deepEqual(
    scanDirectoryForGodotBinaries('/nonexistent/path/xyz', 'linux'),
    [],
    'missing directory returns no candidates',
  );
}

function testDetectsVersionedWindowsBinaries() {
  const dir = mkdtempSync(join(tmpdir(), 'gdharness-detect-win-'));
  try {
    writeFileSync(join(dir, 'Godot_v4.4.1-stable_win64.exe'), '');
    writeFileSync(join(dir, 'Godot_v4.3-stable_win64.exe'), '');
    writeFileSync(join(dir, 'notepad.exe'), '');
    writeFileSync(join(dir, 'readme.txt'), '');

    const result = scanDirectoryForGodotBinaries(dir, 'win32');
    assert.equal(result.length, 2, 'should find both Godot exe files');
    assert.ok(
      result.every((p) => /\.exe$/i.test(p)),
      'all win32 candidates must be .exe',
    );
    assert.ok(
      result.some((p) => p.includes('Godot_v4.4.1-stable_win64.exe')),
      'should include the versioned 4.4.1 binary',
    );
    assert.ok(!result.some((p) => p.includes('notepad.exe')), 'should not include non-Godot executables');
  } finally {
    sweep(dir);
  }
}

function testDetectsVersionedLinuxBinaries() {
  const dir = mkdtempSync(join(tmpdir(), 'gdharness-detect-linux-'));
  try {
    writeFileSync(join(dir, 'godot_v4.4.1-stable_linux.x86_64'), '');
    writeFileSync(join(dir, 'godot4'), '');
    writeFileSync(join(dir, 'godot'), '');
    writeFileSync(join(dir, 'unrelated_tool'), '');

    const result = scanDirectoryForGodotBinaries(dir, 'linux');
    assert.equal(result.length, 3, 'should find all godot-prefixed binaries');
    assert.ok(
      result.some((p) => p.includes('godot_v4.4.1-stable_linux.x86_64')),
      'should include the versioned linux binary',
    );
    assert.ok(!result.some((p) => p.includes('unrelated_tool')), 'should not include non-godot files');
  } finally {
    sweep(dir);
  }
}

function testNewestFirstOrdering() {
  const dir = mkdtempSync(join(tmpdir(), 'gdharness-detect-order-'));
  try {
    writeFileSync(join(dir, 'Godot_v4.0-stable_win64.exe'), 'old');
    const past = new Date(Date.now() - 120_000);
    utimesSync(join(dir, 'Godot_v4.0-stable_win64.exe'), past, past);

    writeFileSync(join(dir, 'Godot_v4.4.1-stable_win64.exe'), 'new');

    const result = scanDirectoryForGodotBinaries(dir, 'win32');
    assert.equal(result.length, 2, 'both binaries found');
    assert.ok(
      result[0]?.includes('Godot_v4.4.1-stable_win64.exe'),
      `newest binary should be returned first, got: ${result[0]}`,
    );
  } finally {
    sweep(dir);
  }
}

function testIgnoresDirectoriesMatchingPattern() {
  const dir = mkdtempSync(join(tmpdir(), 'gdharness-detect-dir-'));
  try {
    mkdirSync(join(dir, 'Godot_temp'));
    writeFileSync(join(dir, 'Godot_v4.4.1-stable_win64.exe'), '');

    const result = scanDirectoryForGodotBinaries(dir, 'win32');
    assert.equal(result.length, 1, 'should only return files, not directories');
    assert.ok(result[0]?.includes('Godot_v4.4.1-stable_win64.exe'));
  } finally {
    sweep(dir);
  }
}

/**
 * A download in the home directory is tried, after every conventional path and never before.
 *
 * The scan reads the host's filesystem with the host's separators, so it is exercised for the
 * platform this runs on; the other platforms' lists are shape-checked without a scan.
 */
function testDownloadsAreTriedAfterTheConventionalPaths() {
  const home = mkdtempSync(join(tmpdir(), 'gdharness-detect-home-'));
  try {
    // Where a release download lands on each platform, and what it is called there.
    const hosts = {
      win32: {
        directory: 'Downloads',
        binary: 'Godot_v4.4.1-stable_win64.exe',
        named: `${home}\\Godot\\Godot.exe`,
      },
      linux: {
        directory: 'Desktop',
        binary: 'godot_v4.3-stable_linux.x86_64',
        named: `${home}/.local/bin/godot`,
      },
      darwin: {
        directory: 'Applications',
        binary: 'Godot_v4.4.1-stable_macos.universal',
        named: `${home}/Applications/Godot.app/Contents/MacOS/Godot`,
      },
    } as const;
    const platform =
      process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';
    const host = hosts[platform];

    mkdirSync(join(home, host.directory));
    writeFileSync(join(home, host.directory, host.binary), '');
    writeFileSync(join(home, host.directory, `${host.binary}.zip`), '');
    writeFileSync(
      join(home, host.directory, platform === 'win32' ? 'godot_linux.x86_64' : 'Godot_win64.exe'),
      '',
    );

    const candidates = godotCandidates(platform, home);
    const downloaded = candidates.indexOf(join(home, host.directory, host.binary));
    assert.ok(downloaded !== -1, `the download should be a candidate: ${candidates.join(', ')}`);
    assert.equal(candidates[0], 'godot', 'PATH is asked first');
    assert.ok(candidates.indexOf(host.named) < downloaded, 'named paths come before the scan');
    assert.ok(!candidates.some((p) => p.endsWith('.zip')), 'the archive is not a candidate');
    assert.ok(
      !candidates.some((p) => p.endsWith(platform === 'win32' ? 'linux.x86_64' : 'win64.exe')),
      "the other platform's build is not a candidate",
    );

    for (const other of ['win32', 'linux', 'darwin'] as const) {
      const shaped = godotCandidates(other, home);
      assert.equal(shaped[0], 'godot', `${other} asks PATH first`);
      assert.ok(shaped.includes(hosts[other].named), `${other} lists its home install: ${shaped.join(', ')}`);
    }
  } finally {
    sweep(home);
  }
}

/** Without a home directory the list is the fixed paths alone, with nothing spelled "undefined". */
function testNoHomeMeansNoHomeCandidates() {
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    const candidates = godotCandidates(platform, '');
    assert.ok(candidates.length > 1, `${platform} still has the conventional paths`);
    assert.ok(
      candidates.every((p) => !p.includes('undefined') && !p.startsWith('/Downloads') && !p.startsWith('\\')),
      `${platform} candidates should not be built from a missing home: ${candidates.join(', ')}`,
    );
  }
}

function main() {
  testIgnoresEmptyAndMissingDirectories();
  testDetectsVersionedWindowsBinaries();
  testDetectsVersionedLinuxBinaries();
  testNewestFirstOrdering();
  testIgnoresDirectoriesMatchingPattern();
  testDownloadsAreTriedAfterTheConventionalPaths();
  testNoHomeMeansNoHomeCandidates();
  console.log('godot detection tests passed');
}

main();
