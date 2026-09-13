/**
 * The game log read as the engine writes it: a headline and the indented lines under it are
 * one entry, whatever chunks the pipe made of them, and the filters answer by entry.
 */

import assert from 'node:assert/strict';
import { GameLog } from '../src/game-log.js';

function testHeadlinesKeepTheirDetail(): void {
  const log = new GameLog();
  log.append(
    'stderr',
    [
      'SCRIPT ERROR: Parse Error: Unexpected identifier "this" in class body.',
      '   at: GDScript::reload (res://broken.gd:4)',
      'ERROR: Failed to load script "res://broken.gd" with error "Parse error".',
      '   at: load (modules/gdscript/gdscript_resource_format.cpp:46)',
      '   GDScript backtrace (most recent call first):',
      '       [0] _init (res://probe.gd:14)',
      'USER WARNING: something mild',
      '   at: push_warning (core/variant/variant_utility.cpp:1096)',
      '',
    ].join('\n'),
  );
  log.append('stdout', 'Godot Engine v4.7.2.stable.official\n[gdharness] runtime listening on 127.0.0.1:5\n');

  assert.equal(log.all.length, 5, 'five things were said');
  assert.equal(log.count('error'), 2);
  assert.equal(log.count('warning'), 1);
  assert.equal(log.count('info'), 2);

  const [parse, load, warning] = log.all;
  assert.ok(parse && load && warning);
  assert.equal(parse.severity, 'error');
  assert.equal(parse.text, 'Parse Error: Unexpected identifier "this" in class body.');
  assert.deepEqual(parse.detail, ['at: GDScript::reload (res://broken.gd:4)']);
  assert.equal(load.detail.length, 3, 'a backtrace stays with its headline');
  assert.equal(warning.severity, 'warning');
  assert.equal(warning.text, 'something mild');
}

function testChunksAndLineEndingsDoNotMatter(): void {
  const whole = new GameLog();
  whole.append('stderr', 'ERROR: one\r\n   at: here\r\nWARNING: two\r\n');

  const pieces = new GameLog();
  for (const piece of ['ERR', 'OR: one\r\n   at: he', 're\r\nWARN', 'ING: two\r', '\n']) {
    pieces.append('stderr', piece);
  }

  assert.deepEqual(pieces.all, whole.all, 'the pipe may split anywhere and the entries are the same');

  // The pipe cuts bytes, not characters: a chunk boundary inside "é" must not show as garbage.
  const bytes = Buffer.from('WARNING: café\n', 'utf8');
  const cut = bytes.indexOf(0xa9);
  const halves = new GameLog();
  halves.append('stderr', bytes.subarray(0, cut));
  halves.append('stderr', bytes.subarray(cut));
  assert.equal(halves.all[0]?.text, 'café');
  assert.deepEqual(
    whole.all.map((entry) => [entry.severity, entry.text, ...entry.detail]),
    [
      ['error', 'one', 'at: here'],
      ['warning', 'two'],
    ],
  );

  // A last line with no newline is held until the stream ends, then counted.
  const trailing = new GameLog();
  trailing.append('stdout', 'printed without a newline');
  assert.equal(trailing.all.length, 0);
  trailing.finish();
  assert.equal(trailing.all.length, 1);
  assert.equal(trailing.all[0]?.text, 'printed without a newline');
}

function testSelectionAnswersByEntry(): void {
  const log = new GameLog();
  log.append('stdout', 'booting\n');
  log.append('stderr', 'WARNING: slow\n   at: a\n');
  log.append('stderr', 'ERROR: bad\n   at: res://x.gd:1\n');
  log.append('stdout', 'still going\n');

  const errors = log.select({ severity: 'error', sinceLastCall: false, limit: 10 });
  assert.deepEqual(
    errors.entries.map((entry) => entry.text),
    ['bad'],
  );
  const warnings = log.select({ severity: 'warning', sinceLastCall: false, limit: 10 });
  assert.deepEqual(
    warnings.entries.map((entry) => entry.text),
    ['slow', 'bad'],
    'the floor is inclusive of everything above it',
  );

  // Every call moves the cursor, so "since the last call" is what arrived after the last answer,
  // whatever that call asked for.
  log.append('stdout', 'later\n');
  const since = log.select({ severity: 'info', sinceLastCall: true, limit: 10 });
  assert.deepEqual(
    since.entries.map((entry) => entry.text),
    ['later'],
  );
  const nothingNew = log.select({ severity: 'info', sinceLastCall: true, limit: 10 });
  assert.deepEqual(nothingNew.entries, []);

  // The detail is searched as well as the headline.
  const byDetail = log.select({ severity: 'info', sinceLastCall: false, contains: 'x.gd', limit: 10 });
  assert.deepEqual(
    byDetail.entries.map((entry) => entry.text),
    ['bad'],
  );

  // The newest are kept and the count of what was left out is answered.
  const tail = log.select({ severity: 'info', sinceLastCall: false, limit: 2 });
  assert.deepEqual(
    tail.entries.map((entry) => entry.text),
    ['still going', 'later'],
  );
  assert.equal(tail.omitted, 3);
}

testHeadlinesKeepTheirDetail();
testChunksAndLineEndingsDoNotMatter();
testSelectionAnswersByEntry();
console.log('game log tests passed');
