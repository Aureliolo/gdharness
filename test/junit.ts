/**
 * The JUnit reader against what gdUnit4 writes: one suite with a pass, a failure and a skip,
 * as the runner produced it, and the malformed inputs that must be refused rather than read
 * as a smaller run.
 */

import assert from 'node:assert/strict';
import {
  failedCases,
  failedWithin,
  hookFailuresPrinted,
  ignoredForTheRunner,
  ignoredLeftOut,
  ignoredYetRan,
  LONGEST_DETAIL,
  MalformedReportError,
  MOST_REPORTS_SHOWN,
  orphansLeftSaid,
  orphansPrinted,
  parseJUnit,
  rowsIgnoredIn,
  scriptErrorsPrinted,
  skippedInReport,
  suitesPrinted,
  testProgressMessage,
  whyNoReport,
} from '../src/junit.js';
import { casesRan, type Expected, judgeEngine, readRun } from '../src/suite-judge.js';

/** What gdUnit4 printed for a run pointed at a directory that is not there, as it printed it. */
const NOTHING_THERE = [
  'Godot Engine v4.7.2.stable.official - https://godotengine.org',
  'Given directory or file does not exists: res://test',
  'No test cases found, abort test run!',
];

const GDUNIT_REPORT = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites id="2026-09-13" name="report_1" tests="3" failures="1" skipped="1" flaky="0" time="0.000">
\t<testsuite id="0" name="sums_test" package="test" timestamp="2026-09-13T04:18:22" hostname="localhost" tests="3" failures="1" errors="0" skipped="1" flaky="0" time="0.073">
\t\t<testcase name="test_two_and_two" classname="sums_test" time="0.008">
\t\t</testcase>
\t\t<testcase name="test_two_and_two_is_not_five" classname="sums_test" time="0.009">
\t\t\t<failure message="FAILED: res://test/sums_test.gd:9" type="FAILURE">
<![CDATA[
Expecting:
 5
 but was
 4
\tat 'test_two_and_two_is_not_five' in res://test/sums_test.gd:9
]]>
\t\t\t</failure>
\t\t</testcase>
\t\t<testcase name="test_skipped_for_now" classname="sums_test" time="0.000">
\t\t\t<skipped message="SKIPPED: res://test/sums_test.gd:12">
<![CDATA[
This test is skipped!
  Reason: 'not today'
]]>
\t\t\t</skipped>
\t\t</testcase>
\t</testsuite>
</testsuites>
`;

function testWhatGdUnitWrites(): void {
  const report = parseJUnit(GDUNIT_REPORT);
  assert.deepEqual(
    { tests: report.tests, failures: report.failures, errors: report.errors, skipped: report.skipped },
    { tests: 3, failures: 1, errors: 0, skipped: 1 },
  );
  assert.equal(report.time, 0.073, "the time is the suites' own, not the zero on the top element");

  const [suite] = report.suites;
  assert.ok(suite);
  assert.equal(suite.name, 'sums_test');
  assert.equal(suite.path, 'res://test/sums_test.gd');
  assert.deepEqual(
    suite.cases.map((entry) => [entry.name, entry.status]),
    [
      ['test_two_and_two', 'passed'],
      ['test_two_and_two_is_not_five', 'failed'],
      ['test_skipped_for_now', 'skipped'],
    ],
  );

  const failed = suite.cases[1];
  assert.ok(failed);
  assert.equal(failed.message, 'FAILED: res://test/sums_test.gd:9');
  assert.equal(
    failed.detail,
    "Expecting:\n 5\n but was\n 4\n\tat 'test_two_and_two_is_not_five' in res://test/sums_test.gd:9",
  );
  assert.equal(suite.cases[0]?.detail, null, 'a pass has nothing to say');
}

function testEntitiesAndShapes(): void {
  const report = parseJUnit(
    '<testsuite name="t" package="test" tests="1"><testcase name="a &lt;b&gt; &amp; &#39;c&#x27;" time="1"><error message="x=&quot;y&quot;">boom &amp; bust</error></testcase><testcase name="self" time="0"/></testsuite>',
  );
  assert.equal(report.tests, 2);
  assert.equal(report.errors, 1);
  const [suite] = report.suites;
  assert.ok(suite);
  const [escaped, selfClosing] = suite.cases;
  assert.ok(escaped && selfClosing);
  assert.equal(escaped.name, "a <b> & 'c'");
  assert.equal(escaped.message, 'x="y"');
  assert.equal(escaped.detail, 'boom & bust');
  assert.equal(selfClosing.status, 'passed', 'a self-closing case passed');
}

/**
 * Suites come back in the order of their paths, whatever order gdUnit4 wrote them in, which is the
 * order the file system listed them: the same project's answer differed between Linux and Windows.
 * A suite the report gives no directory for sorts by its name.
 */
function testSuitesComeInTheOrderOfTheirPaths(): void {
  const report = parseJUnit(
    '<testsuites><testsuite name="noisy_test" package="tests" tests="0"/><testsuite name="b_test" package="tests/deeper" tests="0"/><testsuite name="a_test" package="tests" tests="0"/><testsuite name="nameless" tests="0"/></testsuites>',
  );
  assert.deepEqual(
    report.suites.map((suite) => suite.path ?? suite.name),
    ['nameless', 'res://tests/a_test.gd', 'res://tests/deeper/b_test.gd', 'res://tests/noisy_test.gd'],
  );
}

function testMalformedReportsAreRefused(): void {
  for (const broken of [
    '',
    '<testsuites>',
    '<testsuites><testsuite name="t"></testsuites>',
    '<testsuites><testcase name="orphan"/></testsuites>',
    '<testsuites><testsuite name="t" tests=1></testsuite></testsuites>',
    '<nothing/>',
    '<testsuites><![CDATA[never closed</testsuites>',
    '<testsuites>&bogus;</testsuites>',
  ]) {
    assert.throws(() => parseJUnit(broken), MalformedReportError, `should refuse ${JSON.stringify(broken)}`);
  }
}

function testARunThatFoundNothingIsNotAPass(): void {
  // The failure this exists for: gdUnit4 exits 0 when it found nothing to run, so every verdict
  // taken off the exit code alone called a tier that never ran a green one.
  assert.equal(whyNoReport(NOTHING_THERE, 'res://test'), 'nothing at res://test');
  assert.equal(
    whyNoReport(['No test cases found, abort test run!'], 'res://tests'),
    'no test cases found at res://tests',
    'an ignore list that excluded everything says so without naming a path that is there',
  );
  assert.equal(
    whyNoReport(NOTHING_THERE, 'res://anything'),
    'nothing at res://test',
    'the path the runner named beats the one it was asked for',
  );
  // A directory with a space in its name is named whole: the path was read up to the first space.
  assert.equal(
    whyNoReport(
      ['Given directory or file does not exists: res://my tests', 'No test cases found, abort test run!'],
      'res://my tests',
    ),
    'nothing at res://my tests',
  );
}

/**
 * A before() that failed, as gdUnit4 wrote it on 4.7.2: the suite counts the failure, neither case
 * carries it, and the console names it under the suite's finalize().
 */
function testAFailedHookIsCountedAndNamed(): void {
  const report = parseJUnit(`<?xml version="1.0" encoding="UTF-8" ?>
<testsuites id="2026-09-29" name="report_1" tests="2" failures="1" skipped="0" flaky="0" time="0.000">
\t<testsuite id="0" name="hooked_test" package="test" timestamp="2026-09-29T03:05:42" hostname="localhost" tests="2" failures="1" errors="0" skipped="0" flaky="0" time="0.044">
\t\t<testcase name="test_after_a_failed_hook" classname="hooked_test" time="0.009">
\t\t</testcase>
\t\t<testcase name="test_another" classname="hooked_test" time="0.009">
\t\t</testcase>
\t</testsuite>
</testsuites>`);
  assert.deepEqual(
    [report.failures, report.hookFailures, report.suites[0]?.hookFailures, report.suites[0]?.hookErrors],
    [0, 1, 1, 0],
    'the failure no case carries is the hook',
  );
  assert.deepEqual(
    hookFailuresPrinted([
      '  hooked_test > finalize()  Report:',
      "  Expecting: 'true' but is 'false'\tat 'before' in res://test/hooked_test.gd:5",
      "  Expecting: 5 but is 4\tat 'test_sums' in res://test/sums_test.gd:9",
    ]),
    [
      {
        hook: 'before',
        path: 'res://test/hooked_test.gd',
        line: 5,
        message: "Expecting: 'true' but is 'false'",
      },
    ],
    'and the printed line names it, where a case failing is not a hook',
  );
  // As gdUnit4 4.7.2 prints a failed assert_int in before(), colours taken off: the message ends on
  // the line naming the hook, and what it expected is on the lines above.
  assert.deepEqual(
    hookFailuresPrinted([
      '  setup_test > finalize()  Report:',
      '  Expecting:',
      ' 4',
      ' but was',
      " 3\tat 'before' in res://test/setup_test.gd:9",
      "  Expecting: 'true' but is 'false'\tat 'after' in res://test/setup_test.gd:14",
      'Statistics: 2 test cases | 0 errors | 2 failures | 0 flaky | 0 skipped | 0 orphans | FAILED 66ms',
      '  a line the run printed between suites',
      "  Expecting: 'true' but is 'false'\tat 'before' in res://test/other_test.gd:5",
    ]).map((hook) => `${hook.hook}:${hook.message}`),
    [
      'before:Expecting: 4 but was 3',
      "after:Expecting: 'true' but is 'false'",
      "before:Expecting: 'true' but is 'false'",
    ],
    'a message over several lines is read whole, up to the hook before it and no further than its report',
  );
}

/**
 * A case failing more than one assertion is not a hook failing (#800).
 *
 * gdUnit4 goes on past a failed assertion and counts each on the suite, so a suite of one case
 * failing twice wrote failures="2", and the hook count, taken as the suite's failures less its
 * failed cases, called the second assertion a failed before(). The report below is the one gdUnit4
 * wrote on 4.7.2 for three suites: that one, the same beside a failed before(), and a failed
 * before() alone.
 */
function testASecondFailedAssertionIsNotAHook(): void {
  const report = parseJUnit(`<?xml version="1.0" encoding="UTF-8" ?>
<testsuites id="2026-09-29" name="report_1" tests="3" failures="6" skipped="0" flaky="0" time="0.000">
\t<testsuite id="0" name="both_test" package="test" tests="1" failures="3" errors="0" skipped="0" flaky="0" time="0.040">
\t\t<testcase name="test_two_assertions_fail" classname="both_test" time="0.009">
\t\t\t<failure message="FAILED: res://test/both_test.gd:9" type="FAILURE"><![CDATA[Expecting: 'true' but is 'false']]></failure>
\t\t\t<failure message="FAILED: res://test/both_test.gd:10" type="FAILURE"><![CDATA[Expecting: 'true' but is 'false']]></failure>
\t\t</testcase>
\t</testsuite>
\t<testsuite id="2" name="hooked_test" package="test" tests="1" failures="1" errors="0" skipped="0" flaky="0" time="0.030">
\t\t<testcase name="test_passes" classname="hooked_test" time="0.009">
\t\t</testcase>
\t</testsuite>
\t<testsuite id="3" name="twice_test" package="test" tests="1" failures="2" errors="0" skipped="0" flaky="0" time="0.030">
\t\t<testcase name="test_two_assertions_fail" classname="twice_test" time="0.009">
\t\t\t<failure message="FAILED: res://test/twice_test.gd:5" type="FAILURE"><![CDATA[Expecting: 'true' but is 'false']]></failure>
\t\t\t<failure message="FAILED: res://test/twice_test.gd:6" type="FAILURE"><![CDATA[Expecting: 'true' but is 'false']]></failure>
\t\t</testcase>
\t</testsuite>
</testsuites>`);
  assert.deepEqual(
    report.suites.map((suite) => [suite.name, suite.failures, suite.hookFailures]),
    [
      ['both_test', 1, 1],
      ['hooked_test', 0, 1],
      ['twice_test', 1, 0],
    ],
    'a failed hook is counted once whatever its cases failed, and a case failing twice is no hook',
  );
  assert.equal(report.hookFailures, 2);
}

/**
 * Every report a case carries (#1000), from the reports gdUnit4 v6.2.1 wrote on 4.7.2 for the
 * suites below. It writes a case's error ahead of its failures, and only the first child was read,
 * so a case that failed an assertion and then hit a runtime error answered the error alone with no
 * failure counted, and a case failing twice lost its second.
 *
 *     func test_fails_then_errors() -> void:
 *         assert_int(1).is_equal(2)
 *         var empty: Dictionary[String, int] = {}
 *         print(empty["missing"])
 *     func test_fails_twice() -> void:
 *         assert_int(1).is_equal(2)
 *         assert_int(3).is_equal(4)
 *     func test_errors_then_fails() -> void:
 *         var empty: Dictionary[String, int] = {}
 *         print(empty["missing"])
 *         assert_int(1).is_equal(2)
 */
/**
 * The frames of gdharness's own runner, which stands under every case it starts, are left out of a
 * report, wherever the runner was installed. A project's own script of the same name, and another
 * script started by its full path, are kept.
 */
function testTheRunnersOwnFramesAreLeftOut(): void {
  const frames = [
    "\tat 'test_x' in res://tests/x_test.gd:5",
    "\tat 'helper' in res://godot/tests/listed.gd:9",
    "\tat '_execute' in X:/tools/gdharness/build/godot/tests/listed.gd:712",
    "\tat 'tool' in X:/elsewhere/godot/tests/listed_more.gd:3",
    "\tat '_execute' in /home/me/.npm/_npx/0a1b/node_modules/gdharness/build/godot/tests/listed.gd:712",
  ];
  const report = parseJUnit(`<?xml version="1.0" encoding="UTF-8" ?>
<testsuites id="2026-11-12" name="report_1" tests="1" failures="1" skipped="0" flaky="0" time="0.000">
\t<testsuite id="0" name="x_test" package="tests" tests="1" failures="1" errors="0" skipped="0" flaky="0" time="0.010">
\t\t<testcase name="test_x" classname="x_test" time="0.010">
\t\t\t<failure message="FAILED: res://tests/x_test.gd:5" type="FAILURE">
<![CDATA[
Expecting:
 2
 but was
 1
${frames.join('\n')}
]]>
\t\t\t</failure>
\t\t</testcase>
\t</testsuite>
</testsuites>`);
  assert.equal(
    report.suites[0]?.cases[0]?.detail,
    ['Expecting:\n 2\n but was\n 1', frames[0], frames[1], frames[3]].join('\n'),
  );
}

function testEveryReportOfACaseIsKept(): void {
  const failure = (name: string, suite: string, line: number, expected: number, found: number): string =>
    `<failure message="FAILED: res://tests/${suite}.gd:${line}" type="FAILURE">\n<![CDATA[\nExpecting:\n ${expected}\n but was\n ${found}\n\tat '${name}' in res://tests/${suite}.gd:${line}\n]]>\n</failure>`;
  const error = (name: string, suite: string, line: number): string =>
    `<error message="ERROR: res://tests/${suite}.gd:${line}" type="ABORT">\n<![CDATA[\nGodot Runtime Error !\n  'Invalid access to property or key 'missing' on a base object of type 'Dictionary[String, int]'.'\n\tat '${name}' in res://tests/${suite}.gd:${line}\n]]>\n</error>`;
  const report = parseJUnit(`<?xml version="1.0" encoding="UTF-8" ?>
<testsuites id="2026-10-10" name="report_1" tests="3" failures="3" skipped="0" flaky="0" time="0.000">
\t<testsuite id="0" name="probe_test" package="tests" tests="1" failures="1" errors="1" skipped="0" flaky="0" time="0.040">
\t\t<testcase name="test_fails_then_errors" classname="probe_test" time="0.014">
${error('test_fails_then_errors', 'probe_test', 7)}
${failure('test_fails_then_errors', 'probe_test', 5, 2, 1)}
\t\t</testcase>
\t</testsuite>
\t<testsuite id="1" name="twice_test" package="tests" tests="2" failures="2" errors="0" skipped="0" flaky="0" time="0.040">
\t\t<testcase name="test_fails_twice" classname="twice_test" time="0.011">
${failure('test_fails_twice', 'twice_test', 5, 2, 1)}
${failure('test_fails_twice', 'twice_test', 6, 4, 3)}
\t\t</testcase>
\t</testsuite>
\t<testsuite id="2" name="late_test" package="tests" tests="1" failures="0" errors="1" skipped="0" flaky="0" time="0.037">
\t\t<testcase name="test_errors_then_fails" classname="late_test" time="0.015">
${error('test_errors_then_fails', 'late_test', 6)}
\t\t</testcase>
\t</testsuite>
</testsuites>`);
  assert.deepEqual(
    [report.failures, report.errors, report.hookFailures, report.hookErrors],
    [2, 2, 0, 0],
    'a case that failed and then hit an error counts in both, and neither half is a hook',
  );
  assert.deepEqual(
    report.suites.map((suite) => [suite.name, suite.failures, suite.errors]),
    [
      ['late_test', 0, 1],
      ['probe_test', 1, 1],
      ['twice_test', 1, 0],
    ],
  );
  const failed = failedCases(report);
  assert.deepEqual(
    failed.map((entry) => [
      entry.name,
      entry.status,
      entry.message,
      entry.reports?.map((one) => [one.kind, one.message]),
    ]),
    [
      ['test_errors_then_fails', 'error', 'ERROR: res://tests/late_test.gd:6', undefined],
      [
        'test_fails_then_errors',
        'error',
        'FAILED: res://tests/probe_test.gd:5',
        [
          ['failure', 'FAILED: res://tests/probe_test.gd:5'],
          ['error', 'ERROR: res://tests/probe_test.gd:7'],
        ],
      ],
      [
        'test_fails_twice',
        'failed',
        'FAILED: res://tests/twice_test.gd:5',
        [
          ['failure', 'FAILED: res://tests/twice_test.gd:5'],
          ['failure', 'FAILED: res://tests/twice_test.gd:6'],
        ],
      ],
    ],
    'each case leads with the first thing that went wrong in it, and lists every report when it has several',
  );
  assert.match(
    failed[1]?.detail ?? '',
    /^Expecting:\n 2\n but was\n 1\n\tat 'test_fails_then_errors' in res:\/\/tests\/probe_test\.gd:5$/,
    `the failed assertion is the detail, not the error after it: ${failed[1]?.detail}`,
  );
  assert.equal(failed[0]?.path, 'res://tests/late_test.gd');

  // A case with one report answers as it always did, without a list of one.
  const single = failedCases(parseJUnit(GDUNIT_REPORT));
  assert.deepEqual(
    single.map((entry) => [entry.name, entry.status, entry.message, 'reports' in entry]),
    [['test_two_and_two_is_not_five', 'failed', 'FAILED: res://test/sums_test.gd:9', false]],
  );

  // A failing string comes through as gdUnit4's report wrote it, the merge of both sides included.
  const merged =
    "<failure message=\"FAILED: res://test/each_test.gd:7\" type=\"FAILURE\"><![CDATA[Expecting:\n 'abc'\n but was\n 'abc'\n\tat 'test_each' in res://test/each_test.gd:7]]></failure>";
  const [each] = failedCases(
    parseJUnit(
      `<testsuites><testsuite name="each_test" package="test" tests="1" failures="2"><testcase name="test_each">${merged}${merged}</testcase></testsuite></testsuites>`,
    ),
  );
  assert.deepEqual(
    each?.reports?.map((one) => [one.detail, one.times]),
    [["Expecting:\n 'abc'\n but was\n 'abc'\n\tat 'test_each' in res://test/each_test.gd:7", 2]],
    'the report is passed through as written, the same one twice folded into one',
  );
}

/**
 * A case raising the same errors on every pass of a loop answers each once, with how many times,
 * and a case whose reports all differ, or whose detail runs on, is bounded all the same. A run of
 * 125 cases calling into a class that had stopped compiling answered 18 MB on one line, one case
 * carrying 2,062 reports, and Claude Code closed the connection on it.
 */
function testARunawayCaseIsFoldedAndBounded(): void {
  const error = (line: number, detail: string): string =>
    `<error message="ERROR: res://tests/loop_test.gd:${line}" type="ABORT"><![CDATA[${detail}]]></error>`;
  const runtime = (line: number): string =>
    `Godot Runtime Error !\n  'Cannot call method 'tick' on a null value.'\n\tat 'test_loop' in res://tests/loop_test.gd:${line}\n${'\tat Clock.advance (res://core/clock.gd:40)\n'.repeat(8)}`;
  const looped = Array.from({ length: 2_000 }, (_, pass) =>
    error(10 + (pass % 4), runtime(10 + (pass % 4))),
  ).join('');
  const distinct = Array.from({ length: MOST_REPORTS_SHOWN + 10 }, (_, line) =>
    error(line + 1, runtime(line + 1)),
  ).join('');
  const long = error(3, `Expecting:\n '${'x'.repeat(LONGEST_DETAIL + 30_000)}'\n but was\n 'y'`);
  const suite = (name: string, cases: string): string =>
    `<testsuite name="${name}" package="tests" tests="1" failures="0" errors="1">${cases}</testsuite>`;
  const report = parseJUnit(
    `<testsuites>${suite('loop_test', `<testcase name="test_loop">${looped}</testcase>`)}${suite(
      'many_test',
      `<testcase name="test_many">${distinct}</testcase>`,
    )}${suite('long_test', `<testcase name="test_long">${long}</testcase>`)}</testsuites>`,
  );
  const [longest, loop, many] = failedCases(report);

  assert.deepEqual(
    loop?.reports?.map((one) => [one.message, one.times]),
    [10, 11, 12, 13].map((line) => [`ERROR: res://tests/loop_test.gd:${line}`, 500]),
    `the same four errors are answered once each, with how many times: ${JSON.stringify(loop?.reports?.length)}`,
  );
  assert.equal(loop.reportCount, 2_000, 'and the case says how many reports it made');
  assert.equal(loop.reportsLeftOut, undefined, 'and none of the four is left out');
  assert.match(loop.detail ?? '', /Cannot call method 'tick' on a null value/, 'the first report leads');

  assert.equal(many?.reports?.length, MOST_REPORTS_SHOWN, 'different reports are kept up to the limit');
  assert.equal(many.reportsLeftOut, 10, 'and the rest are counted');
  assert.equal(many.reports[0]?.times, undefined, 'a report made once carries no count');

  const whole = report.suites.find((one) => one.name === 'long_test')?.cases[0]?.detail?.length ?? 0;
  const marker = `\n[${whole - LONGEST_DETAIL} more characters left out]`;
  assert.ok(whole > LONGEST_DETAIL, `the long detail reached the reader whole: ${whole}`);
  assert.ok(
    longest?.detail?.length === LONGEST_DETAIL + marker.length && longest.detail.endsWith(marker),
    `a detail past the limit is cut and says by how much: ${longest?.detail?.length} ending ${JSON.stringify(longest?.detail?.slice(-60))}`,
  );

  // Held to a budget: every case still named with its first message, the ones past it without
  // their reports.
  const run = Array.from({ length: 125 }, () => many);
  const size = JSON.stringify(many).length;
  const held = failedWithin(run, size * 3);
  assert.equal(held.failed.length, 125, 'every failing case is still named');
  assert.equal(held.briefed, 122, 'and those past the budget are counted');
  assert.deepEqual(
    [held.failed[2]?.reports?.length, held.failed[3]?.reports, held.failed[3]?.detail, held.failed[3]?.name],
    [MOST_REPORTS_SHOWN, undefined, null, 'test_many'],
    'the cases inside the budget keep their reports and the rest keep their names',
  );
  assert.ok(
    JSON.stringify(held.failed).length < size * 3 + 125 * 400,
    `the whole list stays near its budget: ${JSON.stringify(held.failed).length}`,
  );

  // The largest case gives up its detail first, wherever it ran, and the order is kept.
  const small = JSON.stringify(loop).length;
  assert.ok(JSON.stringify(longest).length > small * 2, 'the long case is the largest');
  const mixed = failedWithin([longest, loop, loop], small * 2);
  assert.deepEqual(
    mixed.failed.map((entry) => [entry.name, entry.detail === null, entry.reports?.length]),
    [
      ['test_long', true, undefined],
      ['test_loop', false, 4],
      ['test_loop', false, 4],
    ],
    'the long case is named alone and the two loops keep their reports',
  );
  assert.equal(mixed.briefed, 1);
}

function testASuiteWithASpaceInItsPathKeepsItsOrphans(): void {
  const found = orphansPrinted([
    'Run Test Suite: res://my tests/ticket_test.gd',
    'Statistics: 3 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 2 orphans |	WARNING',
    'Overall Summary: 3 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 2 orphans |',
  ]);
  assert.deepEqual(
    found.suites,
    [{ path: 'res://my tests/ticket_test.gd', orphans: 2, left: [] }],
    JSON.stringify(found),
  );
}

function testARunThatSaidNothingOfTheSortIsLeftAlone(): void {
  // The half that would pass either way. A run with failures in it must reach the exit code's
  // own verdict rather than being called empty because this looked at the wrong lines.
  assert.equal(whyNoReport([], 'res://test'), null);
  assert.equal(
    whyNoReport(['Executed test suites: 7', 'Total test cases: 79', 'Failed: 0'], 'res://tests'),
    null,
  );
}

/**
 * The scripts gdUnit4 could not load, read off the lines it printed on 4.7.2 with v6.2.1 for a
 * directory holding a suite with an undeclared identifier, one extending a class that does not
 * exist, one with two faults and a suite that loads.
 */
function testScriptErrorsAreReadOffTheConsole(): void {
  const printed = [
    'Scanning for test suites in: res://test',
    'Parse Error: Could not find base class "NoSuchBaseClass".',
    'Failed to load script "res://test/deeper/missing_base_test.gd" with error "Parse error".',
    'Script errors were detected during test discovery!',
    '  Parse Error: Could not find base class "NoSuchBaseClass".',
    '\tat res://test/deeper/missing_base_test.gd:1',
    '  Parse Error: Identifier "undefined_thing" not declared in the current scope.',
    '\tat res://test/parse_test.gd:5',
    '  Parse Error: Cannot assign a value of type "String" as "int".',
    '\tat res://test/two_faults_test.gd:5',
    '  Parse Error: Function "not_a_function()" not found in base self.',
    '\tat res://test/two_faults_test.gd:9',
    'Abnormal exit with 105',
    'Run dispose test resources',
  ];
  assert.deepEqual(scriptErrorsPrinted(printed), [
    {
      path: 'res://test/deeper/missing_base_test.gd',
      line: 1,
      message: 'Parse Error: Could not find base class "NoSuchBaseClass".',
    },
    {
      path: 'res://test/parse_test.gd',
      line: 5,
      message: 'Parse Error: Identifier "undefined_thing" not declared in the current scope.',
    },
    {
      path: 'res://test/two_faults_test.gd',
      line: 5,
      message: 'Parse Error: Cannot assign a value of type "String" as "int".',
    },
    {
      path: 'res://test/two_faults_test.gd',
      line: 9,
      message: 'Parse Error: Function "not_a_function()" not found in base self.',
    },
  ]);
  assert.deepEqual(
    scriptErrorsPrinted(printed.filter((line) => !line.startsWith('Script errors'))),
    [],
    'the engine lines before the block are not read as its entries',
  );
  // The order the Linux engine leg printed the same scripts in: the directory's, not the name's.
  const block = printed.indexOf('Script errors were detected during test discovery!');
  const pairs = [0, 1, 2, 3].map((pair) => printed.slice(block + 1 + pair * 2, block + 3 + pair * 2));
  const linuxOrder = [
    ...printed.slice(0, block + 1),
    ...[pairs[1], pairs[0], pairs[3], pairs[2]].flatMap((pair) => pair ?? []),
    ...printed.slice(block + 9),
  ];
  assert.deepEqual(
    scriptErrorsPrinted(linuxOrder),
    scriptErrorsPrinted(printed),
    'the same scripts read in the same order whichever order the platform listed them in',
  );
  // A script that failed for a dependency's sake carries no line of its own, and the engine
  // prints its line as 0. game-b's tier had four of them.
  assert.deepEqual(
    scriptErrorsPrinted([
      'Script errors were detected during test discovery!',
      '  Compile Error: Failed to compile depended scripts.',
      '\tat res://core/run.gd:0',
    ]),
    [
      {
        path: 'res://core/run.gd',
        line: null,
        message: 'Compile Error: Failed to compile depended scripts.',
      },
    ],
    'line 0 is read as no line',
  );
}

/**
 * The orphan counts, which are in the console and nowhere else.
 *
 * gdUnit4 decides a run's state on orphan nodes and writes none of it into its JUnit report: an
 * ORPHAN report produces no element, and no suite attribute carries the count. A tier that passed
 * every case and left nodes behind came back as `warnings`, exit 101, with `failures` 0, `failed`
 * empty and `engineEntries` empty, so the word in the verdict was the entire answer and finding
 * out what it meant cost a guess and another run of a tier that takes minutes.
 *
 * The lines below are the shapes the runner prints: the suite is announced on its own line, its
 * statistics end its block on one line with the state written after them, and the run's totals
 * come back under `Overall Summary`.
 */
function testOrphansAreReadOffTheConsole(): void {
  const printed = [
    'Run Test Suite: res://test/shop_test.gd',
    '	test_sells	STATUS: PASSED	13ms',
    'Statistics: 2 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 0 orphans |	PASSED',
    'Run Test Suite: res://test/ticket_test.gd',
    'gdharness orphans: res://test/ticket_test.gd > test_posts left 3: Timer, Node "Board" of res://board.gd, Label',
    '	test_posts	STATUS: PASSED	9ms',
    'gdharness orphans: res://test/ticket_test.gd > after left 1: Node2D "Pin"',
    'Statistics: 3 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 4 orphans |	WARNING',
    'Overall Summary: 5 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 4 orphans |',
    'Executed test suites: (2/2)',
  ];

  const found = orphansPrinted(printed);
  assert.equal(found.total, 4, 'the run total comes off the summary line');
  const ticket = 'res://test/ticket_test.gd';
  assert.deepEqual(
    found.suites,
    [
      {
        path: ticket,
        orphans: 4,
        left: [
          {
            suite: ticket,
            during: 'test_posts',
            count: 3,
            nodes: 'Timer, Node "Board" of res://board.gd, Label',
          },
          { suite: ticket, during: 'after', count: 1, nodes: 'Node2D "Pin"' },
        ],
      },
    ],
    'named per suite with what the runner named in it, and a suite that left none is not a warning',
  );
  // A hook's auto_free() frees at the suite's end rather than the case's, and a suite whose cases
  // never began cannot tell its two hooks apart.
  const said = (during: string, count: number): string =>
    orphansLeftSaid({ suite: ticket, during, count, nodes: 'Node "Pin"' });
  assert.equal(
    said('test_posts', 2),
    'res://test/ticket_test.gd > test_posts left 2 nodes neither freed nor in the tree, which gdUnit4 counts as orphans: Node "Pin". Free each one, or make it with auto_free(), which frees it once the case is over.',
  );
  assert.equal(
    said('before', 1),
    `res://test/ticket_test.gd's before() left 1 node neither freed nor in the tree, which gdUnit4 counts as orphans: Node "Pin". Free each one, or make it with auto_free(), which frees it once the suite is over.`,
  );
  assert.match(said('after', 1), /^res:\/\/test\/ticket_test\.gd's after\(\) left 1 node /);
  assert.match(
    said('before or after', 1),
    /^res:\/\/test\/ticket_test\.gd's before\(\) or after\(\) left 1 node .+ once the suite is over\.$/,
  );

  // A clean run says nothing, which must stay nothing rather than becoming an empty warning.
  assert.deepEqual(
    orphansPrinted([
      'Run Test Suite: res://test/shop_test.gd',
      'Statistics: 2 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 0 orphans |	PASSED',
      'Overall Summary: 2 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 0 orphans |',
    ]),
    { total: 0, suites: [] },
  );

  // The totals are not a suite's. A summary line arriving with a suite still open would otherwise
  // be counted twice: once against that suite and once as the total.
  const onlyTotals = orphansPrinted([
    'Run Test Suite: res://test/ticket_test.gd',
    'Overall Summary: 5 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 4 orphans |',
  ]);
  assert.deepEqual(onlyTotals, { total: 4, suites: [] });

  // And a summary line this stops recognising costs the total, not the rows under it.
  const noSummary = orphansPrinted([
    'Run Test Suite: res://test/ticket_test.gd',
    'Statistics: 3 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 4 orphans |',
    'Run Test Suite: res://test/purse_test.gd',
    'Statistics: 1 test case | 0 errors | 0 failures | 0 flaky | 0 skipped | 2 orphans |',
  ]);
  assert.equal(noSummary.total, 6, 'summed from the suites when no summary line was read');
  assert.equal(noSummary.suites.length, 2);
}

/**
 * A failing string's value put back from the console, which keeps the diff marks the report drops.
 * The console lines are gdUnit4's own, as the runner printed them on 4.7.2, ended both ways: a pipe
 * on Windows carries CRLF, which the report has none of.
 */
function testFinishedSuitesAreReadOffTheConsole(): void {
  const printed = [
    'Scanning for test suites in: res://test',
    'Run Test Suite: res://test/a_test.gd',
    '  res://test/a_test.gd > test_one STARTED',
    '  res://test/a_test.gd > test_one PASSED 10ms',
    '  res://test/a_test.gd > test_two STARTED',
    '  res://test/a_test.gd > test_two PASSED 1s 969ms',
    'Statistics: 2 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 0 orphans | PASSED 2s 6ms',
    'Run Test Suite: res://test/my suites/b_test.gd',
    '  res://test/my suites/b_test.gd > test_fails STARTED',
    '  res://test/my suites/b_test.gd > test_fails FAILED 1s 993ms',
    '  Report:',
    '  Expecting:',
    ' 2',
    ' but was',
    " 1\tat 'test_fails' in res://test/my suites/b_test.gd:6",
    '  res://test/my suites/b_test.gd > test_errs:1 (a, b) STARTED',
    '  res://test/my suites/b_test.gd > test_errs:1 (a, b) FAILED 5ms',
    'Statistics: 2 test cases | 1 errors | 1 failures | 0 flaky | 0 skipped | 0 orphans | PASSED 2s 21ms',
    'Run Test Suite: res://test/c_test.gd',
    '  res://test/c_test.gd > test_long STARTED',
  ];
  assert.deepEqual(suitesPrinted(printed), {
    finished: [
      { path: 'res://test/a_test.gd', cases: 2, errors: 0, failures: 0, failed: [] },
      {
        path: 'res://test/my suites/b_test.gd',
        cases: 2,
        errors: 1,
        failures: 1,
        failed: ['test_fails', 'test_errs:1 (a, b)'],
      },
    ],
    running: 'res://test/c_test.gd',
  });
  const ended = [
    ...printed,
    '  res://test/c_test.gd > test_long PASSED 2m 0s',
    'Statistics: 1 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 0 orphans | PASSED 2m 0s',
    'Overall Summary: 5 test cases | 1 errors | 1 failures | 0 flaky | 0 skipped | 0 orphans |',
  ];
  assert.deepEqual(
    suitesPrinted(ended).finished.map((suite) => suite.path),
    ['res://test/a_test.gd', 'res://test/my suites/b_test.gd', 'res://test/c_test.gd'],
    'the overall summary is not a suite',
  );
  assert.equal(suitesPrinted(ended).running, null);
  assert.equal(
    testProgressMessage(printed, 125_400),
    '2 suites have finished, 1 with failures, running res://test/c_test.gd, 2m 5s in.',
  );
  assert.equal(
    testProgressMessage(printed.slice(0, 4), 9_999),
    'No suite has finished, running res://test/a_test.gd, 9s in.',
  );
  assert.equal(testProgressMessage(printed.slice(0, 7), 30_000), 'One suite has finished, 30s in.');
  assert.equal(testProgressMessage([], 1_000), 'No suite has finished, 1s in.');
}

testWhatGdUnitWrites();
testASuiteWithASpaceInItsPathKeepsItsOrphans();
testAFailedHookIsCountedAndNamed();
/**
 * The ignore entries that named a case which ran, on the forms the real run does not reach: a case
 * named with its suite, a suite named by a piece of its path, a res:// prefix, and an entry naming
 * no case at all, which is not something this can tell went unused and is left out.
 */
function testAnIgnoreThatLeftOutNothingIsNamed(): void {
  const report = parseJUnit(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<testsuites tests="3" failures="0" errors="0" skipped="0" time="0.1">',
      '<testsuite name="ledger_test" package="test/econ" tests="2" failures="0" errors="0" skipped="0" time="0.1">',
      '<testcase name="test_sum" classname="ledger_test" time="0.01"></testcase>',
      '<testcase name="test_tax" classname="ledger_test" time="0.01"></testcase>',
      '<testcase name="test_rate:0" classname="ledger_test" time="0.01"></testcase>',
      '</testsuite>',
      '<testsuite name="inn_test" package="test" tests="1" failures="0" errors="0" skipped="0" time="0.1">',
      '<testcase name="test_sum" classname="inn_test" time="0.01"></testcase>',
      '</testsuite>',
      '<testsuite name="tap_test" tests="1" failures="0" errors="0" skipped="0" time="0.1">',
      '<testcase name="test_pour" classname="tap_test" time="0.01"></testcase>',
      '</testsuite>',
      '</testsuites>',
    ].join('\n'),
  );
  assert.deepEqual(
    ignoredYetRan(report, [
      'test_tax',
      'ledger_test:test_sum',
      'res://test/econ:test_tax',
      'test_gone',
      'inn_test',
    ]),
    [
      { entry: 'test_tax', ran: 'ledger_test:test_tax' },
      { entry: 'ledger_test:test_sum', ran: 'ledger_test:test_sum' },
      { entry: 'res://test/econ:test_tax', ran: 'ledger_test:test_tax' },
    ],
    JSON.stringify(report.suites.map((suite) => [suite.name, suite.path])),
  );
  // A bare name that two suites' cases share is named once for each case that ran.
  assert.deepEqual(ignoredYetRan(report, ['test_sum']), [
    { entry: 'test_sum', ran: 'ledger_test:test_sum' },
    { entry: 'test_sum', ran: 'inn_test:test_sum' },
  ]);

  // What the list did leave out, read against what the suites declare: a case named with its suite
  // or by its suite's path, once however many entries name it, every case of a suite named alone,
  // and neither a case that ran, under its parameters or in a suite the report gives no path for,
  // nor an entry naming nothing there.
  assert.deepEqual(
    ignoredLeftOut(
      report,
      [
        'ledger_test:test_fee',
        'res://test/econ/ledger_test.gd:test_fee',
        'cellar_test',
        'ledger_test:test_sum',
        'ledger_test:test_rate',
        'tap_test:test_pour',
        'tap_test:test_drip',
        'ledger_test:test_fea',
        'test_tax',
      ],
      [
        { path: 'res://test/econ/ledger_test.gd', cases: ['test_fee', 'test_rate', 'test_sum', 'test_tax'] },
        { path: 'res://test/inn_test.gd', cases: ['test_sum'] },
        { path: 'res://test/cellar_test.gd', cases: ['test_cask', 'test_tap'] },
        { path: 'res://test/tap_test.gd', cases: ['test_drip', 'test_pour'] },
      ],
    ),
    {
      leftOut: [
        'cellar_test:test_cask',
        'cellar_test:test_tap',
        'ledger_test:test_fee',
        'tap_test:test_drip',
      ],
      unmatched: ['ledger_test:test_fea', 'test_tax'],
    },
  );

  // A row is handed to the runner by the path of each suite declaring its case, as the failure named
  // it or by its index alone, and as nothing when no suite does: gdUnit4 would read it as the case.
  const declared = [
    { path: 'res://test/econ/ledger_test.gd', cases: ['test_rate', 'test_sum'] },
    { path: 'res://more/ledger_test.gd', cases: ['test_rate'] },
  ];
  assert.deepEqual(
    ignoredForTheRunner(
      ['ledger_test:test_rate:2 (3, 4)', 'ledger_test:test_sum', 'ledger_test:test_fee:1', 'tap_test'],
      declared,
    ),
    [
      'res://test/econ/ledger_test.gd:test_rate:2',
      'res://more/ledger_test.gd:test_rate:2',
      'ledger_test:test_sum',
      'tap_test',
    ],
  );
  // Left out is what the runner said it left out, so a row the case does not have matches nothing.
  const said = rowsIgnoredIn([
    'gdharness ignored res://test/econ/ledger_test.gd > test_rate:2',
    'gdharness left out res://more/ledger_test.gd > test_rate:2',
  ]);
  assert.deepEqual([...said], ['res://test/econ/ledger_test.gd > test_rate:2']);
  assert.deepEqual(
    ignoredLeftOut(report, ['ledger_test:test_rate:2 (3, 4)', 'ledger_test:test_rate:7'], declared, said),
    { leftOut: ['ledger_test:test_rate:2'], unmatched: ['ledger_test:test_rate:7'] },
  );
}

/**
 * The report gdUnit4 writes for a case whose call into another script raised, from calc_test.gd:
 *
 *     func test_div_by_zero() -> void:
 *         assert_int(Calc.new().div(1, 0)).is_equal(0)
 *
 * with Calc.div dividing by zero on line 11 of calc.gd, and beside it a case raising in the suite.
 */
function testAnErrorIsPlacedWhereItWasRaised(): void {
  const report = parseJUnit(`<?xml version="1.0" encoding="UTF-8" ?>
<testsuites id="2026-10-28" name="report_1" tests="2" failures="2" skipped="0" flaky="0" time="0.000">
\t<testsuite id="0" name="calc_test" package="test" tests="2" failures="2" errors="0" skipped="0" flaky="0" time="0.179">
\t\t<testcase name="test_div_by_zero" classname="calc_test" time="0.034">
\t\t\t<error message="ERROR: res://test/calc_test.gd:11" type="ABORT">
<![CDATA[
Godot Runtime Error !
  'Division by zero error in operator '/'.'
\tat 'div' in res://calc.gd:11
\tat 'test_div_by_zero' in res://test/calc_test.gd:15
]]>
\t\t\t</error>
\t\t</testcase>
\t\t<testcase name="test_reads_missing" classname="calc_test" time="0.012">
\t\t\t<error message="ERROR: res://test/calc_test.gd:20" type="ABORT">
<![CDATA[
Godot Runtime Error !
  'Invalid access to property or key 'missing' on a base object of type 'Dictionary'.'
\tat 'test_reads_missing' in res://test/calc_test.gd:20
]]>
\t\t\t</error>
\t\t</testcase>
\t</testsuite>
</testsuites>`);
  assert.deepEqual(
    failedCases(report).map((entry) => [entry.name, entry.message]),
    [
      ['test_div_by_zero', 'ERROR: res://calc.gd:11'],
      ['test_reads_missing', 'ERROR: res://test/calc_test.gd:20'],
    ],
    'an error is named where it was raised, in the suite or in the script it called',
  );
}

/** [param whole] in pieces of [param size] bytes. */
function testEverySkipTheReportHoldsIsListedWithItsReason(): void {
  const skipped = (name: string, line: number, reason: string): string =>
    `\t\t<testcase name="${name}" classname="x" time="0.000">\n\t\t\t<skipped message="SKIPPED: res://test/x.gd:${String(line)}">\n<![CDATA[\nThis test is skipped!\n  Reason: '${reason}'\n]]>\n\t\t\t</skipped>\n\t\t</testcase>\n`;
  const report = parseJUnit(
    `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites id="2026-11-22" name="report_1" tests="10" failures="0" skipped="7" flaky="0" time="0.000">
\t<testsuite id="0" name="one_skip_test" package="test" tests="2" failures="0" errors="0" skipped="1" flaky="0" time="0.458">
\t\t<testcase name="test_a" classname="one_skip_test" time="0.044">
\t\t</testcase>
${skipped('test_skipped', 6, 'not ready yet')}\t</testsuite>
\t<testsuite id="1" name="rows_skip_test" package="test" tests="2" failures="0" errors="0" skipped="2" flaky="0" time="0.432">
${skipped('test_rows:0 (1)', 3, 'rows wait')}${skipped('test_rows:1 (2)', 3, 'rows wait')}\t</testsuite>
\t<testsuite id="2" name="whole_skip_test" package="test" tests="1" failures="0" errors="0" skipped="1" flaky="0" time="0.000">
${skipped('test_a', 6, 'Skipped from the entire test suite')}\t</testsuite>
</testsuites>
`,
  );
  assert.deepEqual(
    skippedInReport(report),
    [
      { suite: 'res://test/one_skip_test.gd', name: 'test_skipped', reason: 'not ready yet' },
      { suite: 'res://test/rows_skip_test.gd', name: 'test_rows:0 (1)', reason: 'rows wait' },
      { suite: 'res://test/rows_skip_test.gd', name: 'test_rows:1 (2)', reason: 'rows wait' },
      {
        suite: 'res://test/whole_skip_test.gd',
        name: 'test_a',
        reason: 'Skipped from the entire test suite',
      },
    ],
    'each skipped case, in the order of its suite',
  );
  assert.deepEqual(skippedInReport(parseJUnit(GDUNIT_REPORT)), [
    { suite: 'res://test/sums_test.gd', name: 'test_skipped_for_now', reason: 'not today' },
  ]);
}

/**
 * How a report spells the failure {@link aSuiteFailingOn} prints: the merge of both sides, a
 * character of each after [param value].
 */
/** A report of [param suites], each a script under test/ with its cases as gdUnit4 writes them. */
function reportOf(
  suites: readonly {
    readonly name: string;
    readonly hookFailures?: number;
    readonly cases: readonly (readonly [
      name: string,
      status: 'passed' | 'failed' | 'skipped',
      text?: string,
    ])[];
  }[],
): ReturnType<typeof parseJUnit> {
  const element = ([name, status, text]: readonly [string, string, string?]): string => {
    if (status === 'failed') {
      return `<testcase name="${name}" time="0.010"><failure message="FAILED: res://test/x.gd:5" type="FAILURE"><![CDATA[${text ?? 'Expecting: 1'}]]></failure></testcase>`;
    }
    if (status === 'skipped') {
      return `<testcase name="${name}" time="0.000"><skipped message="SKIPPED: res://test/x.gd:5"><![CDATA[\nThis test is skipped!\n  Reason: '${text ?? ''}'\n]]></skipped></testcase>`;
    }
    return `<testcase name="${name}" time="0.010"></testcase>`;
  };
  return parseJUnit(
    `<testsuites>${suites
      .map((suite) => {
        const failures =
          suite.cases.filter(([, status]) => status === 'failed').length + (suite.hookFailures ?? 0);
        return `<testsuite name="${suite.name}" package="test" tests="${suite.cases.length}" failures="${failures}" errors="0" time="0.050">${suite.cases.map(element).join('')}</testsuite>`;
      })
      .join('')}</testsuites>`,
  );
}

const A_TEST = 'res://test/a_test.gd';
const NOTHING_HANDED = { errors: {}, warnings: {} } satisfies Expected;
const ENDED_WELL = { code: 0, signal: null, ended: null };

/**
 * Every case's outcome, the suite's verdict and the totals are the report's, whatever the console
 * printed beside them. The console here says the failing case passed and prints no line for the rest.
 */
function testTheReportAloneSaysWhatEachCaseDid(): void {
  const report = reportOf([
    {
      name: 'a_test',
      cases: [
        ['test_ok', 'passed'],
        ['test_bad', 'failed', 'Expecting: 2'],
        ['test_later', 'skipped', 'not today'],
        ['test_rows:0 (1)', 'passed'],
      ],
    },
  ]);
  const printed = readRun(
    [
      `Run Test Suite: ${A_TEST}`,
      `  ${A_TEST} > test_bad STARTED`,
      `  ${A_TEST} > test_bad PASSED 3ms`,
      'Statistics: 4 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 0 orphans | PASSED 9ms',
      'Executed test cases : (99/99)',
    ].join('\n'),
    [report],
  );
  const suite = printed.suites.get(A_TEST);
  assert.deepEqual(
    suite?.cases.map((one) => [one.name, one.func, one.row, one.verdict, one.message]),
    [
      ['test_ok', 'test_ok', null, 'PASSED', null],
      ['test_bad', 'test_bad', null, 'FAILED', 'FAILED: res://test/x.gd:5'],
      ['test_later', 'test_later', null, 'SKIPPED', 'SKIPPED: res://test/x.gd:5'],
      ['test_rows:0 (1)', 'test_rows', 0, 'PASSED', null],
    ],
  );
  assert.deepEqual(
    printed.suites.get(A_TEST)?.closed,
    { verdict: 'FAILED', seconds: 0.05 },
    'the suite failed, as the report counts',
  );
  assert.equal(printed.executed, 3, 'executed counts the cases the report holds that were not skipped');
  assert.equal(casesRan(printed), 3);
  assert.deepEqual(printed.skipped, [{ suite: A_TEST, name: 'test_later', reason: 'not today' }]);
  const judged = judgeEngine(
    printed,
    {
      suites: [{ path: A_TEST, cases: ['test_ok', 'test_bad', 'test_later', 'test_rows'] }],
      expected: NOTHING_HANDED,
    },
    ENDED_WELL,
  );
  assert.deepEqual(judged.faults, [
    `${A_TEST} > test_later never ran: gdUnit4 skipped it, saying "not today"`,
    `${A_TEST} > test_bad failed: FAILED: res://test/x.gd:5`,
  ]);
}

/** A skip reason is the report's text, whatever it holds: line breaks, quotes, tags and a separator. */
function testASkipReasonIsPassedThroughAsTheReportWroteIt(): void {
  const reasons = [
    'first\nERROR: second',
    'it\'s "quoted" and ends in a quote\'',
    '[color=a\nb][color=c\nd] tags',
    `line${String.fromCharCode(0x2028)}separator`,
  ];
  const report = reportOf([
    {
      name: 'a_test',
      cases: reasons.map((reason, at) => [`test_${String(at)}`, 'skipped', reason] as const),
    },
  ]);
  const printed = readRun(`Run Test Suite: ${A_TEST}`, [report]);
  assert.deepEqual(
    printed.skipped.map((one) => one.reason),
    reasons,
  );
  const failing = reportOf([{ name: 'a_test', cases: [['test_x', 'failed', 'a ]]]]><![CDATA[> b']] }]);
  assert.equal(failedCases(failing)[0]?.detail, 'a ]]> b');
}

/** The console still says whose an error is, and what the report cannot hold: a script that did not load. */
function testTheConsoleStillSaysWhoseAnErrorIs(): void {
  const report = reportOf([{ name: 'a_test', cases: [['test_ok', 'passed']] }]);
  const printed = readRun(
    [
      'ERROR: before any suite',
      `Run Test Suite: ${A_TEST}`,
      `  ${A_TEST} > test_ok STARTED`,
      'ERROR: in the case',
      `  ${A_TEST} > test_ok PASSED 3ms`,
      'Statistics: 1 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 0 orphans | PASSED 9ms',
    ].join('\n'),
    [report],
  );
  assert.deepEqual(
    printed.errors.map((error) => [error.text, error.suite, error.during]),
    [
      ['before any suite', null, null],
      ['in the case', A_TEST, 'test_ok'],
    ],
  );
  const unloaded = readRun(
    [
      'Script errors were detected during test discovery!',
      '  Parse Error: Identifier "x" not declared in the current scope.',
      '\tat res://test/a_test.gd:5',
    ].join('\n'),
  );
  assert.deepEqual(unloaded.unloadable, [
    'res://test/a_test.gd:5: Parse Error: Identifier "x" not declared in the current scope.',
  ]);
}

/** A run with no report has no case outcomes and says so, however far its console got. */
function testARunWithNoReportSaysSoAndNamesWhereItStopped(): void {
  const printed = readRun([`Run Test Suite: ${A_TEST}`, `  ${A_TEST} > test_hangs STARTED`].join('\n'));
  assert.equal(printed.executed, null);
  assert.deepEqual(printed.suites.get(A_TEST)?.cases, []);
  assert.equal(printed.stoppedIn, `${A_TEST} > test_hangs`);
  const judged = judgeEngine(
    printed,
    { suites: [{ path: A_TEST, cases: ['test_hangs'] }], expected: NOTHING_HANDED },
    { code: null, signal: null, ended: 'it was ended after 60 s' },
  );
  assert.ok(judged.faults.includes('the run wrote no JUnit report'), judged.faults.join(' | '));
  assert.ok(judged.faults.includes(`${A_TEST} never finished`), judged.faults.join(' | '));
}

/** A hook that failed makes its suite FAILED with every case passing, as the report counts it. */
function testAFailedHookFailsItsSuiteWithEveryCasePassing(): void {
  const report = reportOf([{ name: 'a_test', hookFailures: 1, cases: [['test_ok', 'passed']] }]);
  const printed = readRun(`Run Test Suite: ${A_TEST}`, [report]);
  const judged = judgeEngine(
    printed,
    { suites: [{ path: A_TEST, cases: ['test_ok'] }], expected: NOTHING_HANDED },
    { code: 100, signal: null, ended: null },
  );
  assert.ok(
    judged.faults.includes(`${A_TEST} reported FAILED with every case passing, so a hook failed`),
    judged.faults.join(' | '),
  );
}

testTheReportAloneSaysWhatEachCaseDid();
testASkipReasonIsPassedThroughAsTheReportWroteIt();
testTheConsoleStillSaysWhoseAnErrorIs();
testARunWithNoReportSaysSoAndNamesWhereItStopped();
testAFailedHookFailsItsSuiteWithEveryCasePassing();
testASecondFailedAssertionIsNotAHook();
testAnErrorIsPlacedWhereItWasRaised();
testEveryReportOfACaseIsKept();
testTheRunnersOwnFramesAreLeftOut();
testARunawayCaseIsFoldedAndBounded();
testEntitiesAndShapes();
testSuitesComeInTheOrderOfTheirPaths();
testMalformedReportsAreRefused();
testARunThatFoundNothingIsNotAPass();
testARunThatSaidNothingOfTheSortIsLeftAlone();
testOrphansAreReadOffTheConsole();
testScriptErrorsAreReadOffTheConsole();
testFinishedSuitesAreReadOffTheConsole();
testAnIgnoreThatLeftOutNothingIsNamed();
testEverySkipTheReportHoldsIsListedWithItsReason();
console.log('junit reader tests passed');
