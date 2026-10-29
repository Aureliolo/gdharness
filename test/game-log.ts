/**
 * The game log read as the engine writes it: a headline and the indented lines under it are
 * one entry, whatever chunks the pipe made of them, and the filters answer by entry.
 */

import assert from 'node:assert/strict';
import { forAnswer, GameLog } from '../src/game-log.js';
import { suitesPrinted } from '../src/junit.js';

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

  // The two reads above asked for errors and for warnings, so neither offered the info lines and
  // neither has consumed them: "since the last call" is measured per floor.
  log.append('stdout', 'later\n');
  const since = log.select({ severity: 'info', sinceLastCall: true, limit: 10 });
  assert.deepEqual(
    since.entries.map((entry) => entry.text),
    ['booting', 'slow', 'bad', 'still going', 'later'],
    'an info read still has what the error and warning reads never reported',
  );
  const nothingNew = log.select({ severity: 'info', sinceLastCall: true, limit: 10 });
  assert.deepEqual(nothingNew.entries, [], 'and the read that did offer them moves its own mark');

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

/**
 * A read consumes what it reported and nothing else.
 *
 * `sinceLastCall` used to be measured from one mark that every call walked to the end, so a filter
 * decided what a later call could see. A session polling for errors while a bench ran, and then
 * asking what the run had printed, was answered with nothing: the polls had walked the mark over
 * hundreds of lines none of them reported. Empty is the answer a caller reaches for that read to
 * find a parked run, and it could not tell a silent run from output it had never been shown.
 */
function testAFilteredReadDoesNotConsumeWhatItDidNotReport(): void {
  const log = new GameLog();
  log.append('stdout', 'one\n');
  log.append('stderr', 'ERROR: bad\n');
  log.append('stdout', 'two\n');

  // A search, which answers about the whole run rather than about a window.
  const found = log.select({ severity: 'info', sinceLastCall: false, contains: 'bad', limit: 10 });
  assert.deepEqual(
    found.entries.map((entry) => entry.text),
    ['bad'],
    'the search finds its line',
  );
  assert.deepEqual(
    log.select({ severity: 'info', sinceLastCall: true, limit: 10 }).entries.map((entry) => entry.text),
    ['one', 'bad', 'two'],
    'and costs the caller nothing: a search moves no mark at all',
  );

  // The mark for a floor does move, or nothing here would be a window.
  log.append('stdout', 'three\n');
  log.append('stderr', 'ERROR: worse\n');
  assert.deepEqual(
    log.select({ severity: 'error', sinceLastCall: true, limit: 10 }).entries.map((entry) => entry.text),
    ['worse'],
    'an error read answers with the errors since the last error read',
  );
  assert.deepEqual(
    log.select({ severity: 'error', sinceLastCall: true, limit: 10 }).entries,
    [],
    'and has consumed them by answering',
  );
  assert.deepEqual(
    log.select({ severity: 'info', sinceLastCall: true, limit: 10 }).entries.map((entry) => entry.text),
    ['three', 'worse'],
    'while the info read still has the line no error read would have shown',
  );
}

/**
 * A crash is an error, with its report as its detail.
 *
 * Nothing in the crash handler's report is indented, so it was read as a column of info lines: a
 * run that ended on a segfault counted no errors and read as clean. The Windows report here is what
 * Godot 4.7.2 printed for `OS.crash`, cut to three native frames; the Linux and macOS handler opens
 * with `handle_crash` instead and prints the rest the same way.
 */
function testACrashIsAnErrorWithItsReport(): void {
  const windows = new GameLog();
  windows.append(
    'transcript',
    [
      'Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org',
      'about to crash',
      '================================================================',
      'CrashHandlerException: Program crashed with signal 4',
      'Engine version: Godot Engine v4.7.2.stable.official (ed1daf0bf001b61586d9930840f2f1394092c079)',
      'Dumping the backtrace. Please include this when reporting the bug on: https://github.com/godotengine/godot/issues',
      'Load address: 7ff51ac40000',
      '',
      '[1] 7ff65ed14d03 (main+40d4d03) - no debug info in PE/COFF executable',
      '[2] 7fffc7964702 (ntdll.dll+124702) - no debug info in PE/COFF executable',
      '[3] -1 (main+-7ff65ac40001) - no debug info in PE/COFF executable',
      '-- END OF C++ BACKTRACE --',
      '================================================================',
      'GDScript backtrace (most recent call first):',
      '    [0] boom (res://main.gd:10)',
      '    [1] _ready (res://main.gd:6)',
      '-- END OF GDSCRIPT BACKTRACE --',
      '================================================================',
      '',
    ].join('\r\n'),
  );
  assert.equal(windows.count('error'), 1, `the crash is the one error: ${JSON.stringify(windows.all)}`);
  const crash = windows.all.find((entry) => entry.severity === 'error');
  assert.equal(crash?.text, 'CrashHandlerException: Program crashed with signal 4');
  assert.deepEqual(
    crash.detail,
    [
      'Engine version: Godot Engine v4.7.2.stable.official (ed1daf0bf001b61586d9930840f2f1394092c079)',
      'Dumping the backtrace. Please include this when reporting the bug on: https://github.com/godotengine/godot/issues',
      'Load address: 7ff51ac40000',
      'GDScript backtrace (most recent call first):',
      '[0] boom (res://main.gd:10)',
      '[1] _ready (res://main.gd:6)',
    ],
    'its report is its detail, the GDScript backtrace with it, and frames with no symbol are left out',
  );
  assert.deepEqual(
    windows.all.filter((entry) => entry.severity === 'info').map((entry) => entry.text),
    [
      'Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org',
      'about to crash',
      '================================================================',
    ],
    'and what came before it is still what the game printed',
  );

  const linux = new GameLog();
  linux.append(
    'stderr',
    [
      'handle_crash: Program crashed with signal 11',
      'Engine version: Godot Engine v4.7.2.stable.official',
      '[1] /lib/x86_64-linux-gnu/libc.so.6(+0x42520) [0x7f0000042520] (??:0)',
      '-- END OF C++ BACKTRACE --',
      '',
    ].join('\n'),
  );
  assert.equal(linux.count('error'), 1, JSON.stringify(linux.all));
  assert.deepEqual(
    linux.all[0]?.detail,
    [
      'Engine version: Godot Engine v4.7.2.stable.official',
      '[1] /lib/x86_64-linux-gnu/libc.so.6(+0x42520) [0x7f0000042520] (??:0)',
    ],
    'a frame that names its library is kept',
  );

  // The words alone, printed by a game, are not a crash: only the handler's own opening is.
  const quoted = new GameLog();
  quoted.append('stdout', 'the log said: CrashHandlerException: Program crashed with signal 11\n');
  assert.equal(quoted.count('error'), 0, JSON.stringify(quoted.all));
}

/**
 * An entry answers with the project script and line it points at. A push_error's at: line is the
 * engine's own push_error, and the call that raised it is the first frame of the backtrace, above
 * the frames of whatever called the game: the lines are as a headless 4.7.2 game printed them.
 */
function testAnEntrySaysTheScriptItPointsAt(): void {
  const log = new GameLog();
  log.append(
    'transcript',
    [
      'ERROR: greet pressed with no name',
      '   at: push_error (core/variant/variant_utility.cpp:1023)',
      '   GDScript backtrace (most recent call first):',
      '       [0] _on_greet (res://ui.gd:27)',
      '       [1] _press_button (res://addons/gdharness_runtime/runtime_input.gd:827)',
      'SCRIPT ERROR: Parse Error: Function "speak()" not found in base Speaker.',
      '   at: GDScript::reload (res://renamed/shouter.gd:6)',
      '   GDScript backtrace (most recent call first):',
      '       [0] reload_script (res://addons/gdharness_editor/tools/class_tools.gd:99)',
      'ERROR: Condition "!is_inside_tree()" is true.',
      '   at: get_global_transform (scene/2d/node_2d.cpp:415)',
      'just a print',
      '',
    ].join('\n'),
  );
  const [pushed, parse, engine, print] = forAnswer(log.all);
  assert.deepEqual(
    [pushed?.script, pushed?.line, pushed?.function],
    ['res://ui.gd', 27, '_on_greet'],
    `a push_error is the game's call, not the engine's push_error: ${JSON.stringify(pushed)}`,
  );
  assert.equal(pushed?.detail?.length, 4, 'and the lines it was read from stay');
  assert.deepEqual(
    [parse?.script, parse?.line, parse?.function],
    ['res://renamed/shouter.gd', 6, 'GDScript::reload'],
    `an at: line naming a script is where the entry points, ahead of its backtrace: ${JSON.stringify(parse)}`,
  );
  assert.ok(engine !== undefined && print !== undefined);
  for (const nowhere of [engine, print]) {
    assert.deepEqual(
      ['script', 'line', 'function'].filter((field) => field in nowhere),
      [],
      `an entry naming no script says none: ${JSON.stringify(nowhere)}`,
    );
  }
  assert.equal(engine.detail?.[0], 'at: get_global_transform (scene/2d/node_2d.cpp:415)');
}

/**
 * A windowed engine on Windows prints a case's script error on stdout, where gdUnit4 prints its
 * indented case lines: the error's backtrace is its detail, and the case lines after it are not.
 */
function testAScriptErrorDoesNotTakeTheCasesAfterIt(): void {
  const log = new GameLog();
  log.append(
    'stdout',
    [
      'Run Test Suite: res://tests/a_test.gd',
      '  res://tests/a_test.gd > test_null STARTED',
      "SCRIPT ERROR: Cannot call method 'get_class' on a null value.",
      '   at: test_null (res://tests/a_test.gd:14)',
      '   GDScript backtrace (most recent call first):',
      '       [0] test_null (res://tests/a_test.gd:14)',
      '  res://tests/a_test.gd > test_null FAILED 10ms',
      '  Report:',
      '  res://tests/a_test.gd > test_row:2 (3, 10) STARTED',
      '  res://tests/a_test.gd > test_row:2 (3, 10) FAILED 16ms',
      'Statistics: 2 test cases | 1 errors | 1 failures | 0 flaky | 0 skipped | 0 orphans | FAILED 115ms',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    log.all.map((entry) => [entry.severity, entry.text, ...entry.detail]),
    [
      ['info', 'Run Test Suite: res://tests/a_test.gd'],
      ['info', '  res://tests/a_test.gd > test_null STARTED'],
      [
        'error',
        "Cannot call method 'get_class' on a null value.",
        'at: test_null (res://tests/a_test.gd:14)',
        'GDScript backtrace (most recent call first):',
        '[0] test_null (res://tests/a_test.gd:14)',
      ],
      ['info', '  res://tests/a_test.gd > test_null FAILED 10ms'],
      ['info', '  Report:'],
      ['info', '  res://tests/a_test.gd > test_row:2 (3, 10) STARTED'],
      ['info', '  res://tests/a_test.gd > test_row:2 (3, 10) FAILED 16ms'],
      [
        'info',
        'Statistics: 2 test cases | 1 errors | 1 failures | 0 flaky | 0 skipped | 0 orphans | FAILED 115ms',
      ],
    ],
  );
  const printed = log.select({ severity: 'info', sinceLastCall: false, limit: Number.POSITIVE_INFINITY });
  assert.deepEqual(
    suitesPrinted(printed.entries.map((entry) => entry.text)).finished.map((suite) => suite.failed),
    [['test_null', 'test_row:2 (3, 10)']],
    'every failing case is read off what the run printed',
  );
}

testAScriptErrorDoesNotTakeTheCasesAfterIt();
testAnEntrySaysTheScriptItPointsAt();
testACrashIsAnErrorWithItsReport();
testAFilteredReadDoesNotConsumeWhatItDidNotReport();
testHeadlinesKeepTheirDetail();
testChunksAndLineEndingsDoNotMatter();
testSelectionAnswersByEntry();
console.log('game log tests passed');
