/**
 * Where the server looks for an engine when nothing names one.
 *
 * A release download is a file called `Godot_v4.4.1-stable_win64.exe`, which no fixed list of
 * install paths can name, so the directories a download lands in are read as well. The list is
 * asserted against a temp directory laid out like a home, so the order in which candidates are
 * tried is a fact about the function rather than about this machine.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { godotCandidates, scanDirectoryForGodotBinaries } from '../src/detection.js';

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
    rmSync(dir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A download in the home directory is tried, after every conventional path and never before. */
function testDownloadsAreTriedAfterTheConventionalPaths() {
  const home = mkdtempSync(join(tmpdir(), 'gdharness-detect-home-'));
  try {
    mkdirSync(join(home, 'Downloads'));
    writeFileSync(join(home, 'Downloads', 'Godot_v4.4.1-stable_win64.exe'), '');
    mkdirSync(join(home, 'Desktop'));
    writeFileSync(join(home, 'Desktop', 'godot_v4.3-stable_linux.x86_64'), '');

    const windows = godotCandidates('win32', home);
    const downloaded = windows.indexOf(join(home, 'Downloads', 'Godot_v4.4.1-stable_win64.exe'));
    assert.ok(downloaded !== -1, `the download should be a candidate: ${windows.join(', ')}`);
    assert.equal(windows[0], 'godot', 'PATH is asked first');
    assert.ok(windows.indexOf(`${home}\\Godot\\Godot.exe`) < downloaded, 'named paths come before the scan');
    assert.ok(!windows.some((p) => p.endsWith('linux.x86_64')), 'a Linux build is not a Windows candidate');

    const linux = godotCandidates('linux', home);
    assert.ok(linux.includes(join(home, 'Desktop', 'godot_v4.3-stable_linux.x86_64')));
    assert.ok(!linux.some((p) => p.endsWith('.exe')), 'a Windows build is not a Linux candidate');
  } finally {
    rmSync(home, { recursive: true, force: true });
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
