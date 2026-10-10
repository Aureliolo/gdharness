/**
 * The JUnit reader against what gdUnit4 writes: one suite with a pass, a failure and a skip,
 * as the runner produced it, and the malformed inputs that must be refused rather than read
 * as a smaller run.
 */

import assert from 'node:assert/strict';
import {
  BOTH_SIDES_ALIKE_NOTE,
  failedCases,
  hookFailuresPrinted,
  MalformedReportError,
  orphansPrinted,
  parseJUnit,
  RENDERED_AWAY_NOTE,
  scriptErrorsPrinted,
  suitesPrinted,
  testProgressMessage,
  VALUE_NOT_RECOVERED_NOTE,
  whyNoReport,
  withActualsPrinted,
} from '../src/junit.js';

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

function testMalformedReportsAreRefused(): void {
  for (const broken of [
    '',
    '<testsuites>',
    '<testsuites><testsuite name="t"></testsuites>',
    '<testsuites><testcase name="orphan"/></testsuites><extra>',
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
      ['probe_test', 1, 1],
      ['twice_test', 1, 0],
      ['late_test', 0, 1],
    ],
  );
  const failed = failedCases(report, '');
  assert.deepEqual(
    failed.map((entry) => [
      entry.name,
      entry.status,
      entry.message,
      entry.reports?.map((one) => [one.kind, one.message]),
    ]),
    [
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
      ['test_errors_then_fails', 'error', 'ERROR: res://tests/late_test.gd:6', undefined],
    ],
    'each case leads with the first thing that went wrong in it, and lists every report when it has several',
  );
  assert.match(
    failed[0]?.detail ?? '',
    /^Expecting:\n 2\n but was\n 1\n\tat 'test_fails_then_errors' in res:\/\/tests\/probe_test\.gd:5$/,
    `the failed assertion is the detail, not the error after it: ${failed[0]?.detail}`,
  );
  assert.equal(failed[2]?.path, 'res://tests/late_test.gd');

  // A case with one report answers as it always did, without a list of one.
  const single = failedCases(parseJUnit(GDUNIT_REPORT), '');
  assert.deepEqual(
    single.map((entry) => [entry.name, entry.status, entry.message, 'reports' in entry]),
    [['test_two_and_two_is_not_five', 'failed', 'FAILED: res://test/sums_test.gd:9', false]],
  );

  // Each report has its value read back, in the order the run printed them: the second string
  // equality of one case is the second diff, which reading the case's first report alone never met.
  const e = String.fromCharCode(0x1b);
  const at = `${e}[0m${e}[38;2;173;216;230m\tat 'test_each' in res://test/each_test.gd:7${e}[0m`;
  const printed = [
    ` but was`,
    ` '${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[38;2;255;255;255mabc${e}[0m${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[0m${e}[38;2;30;144;255m${e}[0m'${at}`,
    ` but was`,
    ` '${e}[38;2;30;144;255ma${e}[48;2;38;0;0m${e}[38;2;255;255;255mbc${e}[0m${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[0m${e}[38;2;30;144;255m${e}[0m'${at}`,
  ].join('\n');
  const merged =
    "<failure message=\"FAILED: res://test/each_test.gd:7\" type=\"FAILURE\"><![CDATA[Expecting:\n 'abc'\n but was\n 'abc'\n\tat 'test_each' in res://test/each_test.gd:7]]></failure>";
  const [each] = failedCases(
    parseJUnit(
      `<testsuites><testsuite name="each_test" package="test" tests="1" failures="2"><testcase name="test_each">${merged}${merged}</testcase></testsuite></testsuites>`,
    ),
    printed,
  );
  assert.deepEqual(
    each?.reports?.map((one) => / but was\n '(.*)'\n/.exec(one.detail ?? '')?.[1]),
    ['', 'a'],
    `both values read back, the second into the second report: ${JSON.stringify(each)}`,
  );
}

function testASuiteWithASpaceInItsPathKeepsItsOrphans(): void {
  const found = orphansPrinted([
    'Run Test Suite: res://my tests/docket_test.gd',
    'Statistics: 3 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 2 orphans |	WARNING',
    'Overall Summary: 3 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 2 orphans |',
  ]);
  assert.deepEqual(
    found.suites,
    [{ path: 'res://my tests/docket_test.gd', orphans: 2 }],
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
  // A script that failed for a dependency's sake carries no line of its own, which the engine
  // prints as 0; ostinato's tier had four of them.
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

function testOrphansAreReadOffTheConsole(): void {
  const printed = [
    'Run Test Suite: res://test/guild_test.gd',
    '	test_recruits	STATUS: PASSED	13ms',
    'Statistics: 2 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 0 orphans |	PASSED',
    'Run Test Suite: res://test/docket_test.gd',
    '	test_posts	STATUS: PASSED	9ms',
    'Statistics: 3 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 4 orphans |	WARNING',
    'Overall Summary: 5 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 4 orphans |',
    'Executed test suites: (2/2)',
  ];

  const found = orphansPrinted(printed);
  assert.equal(found.total, 4, 'the run total comes off the summary line');
  assert.deepEqual(
    found.suites,
    [{ path: 'res://test/docket_test.gd', orphans: 4 }],
    'named per suite, and a suite that left none is not a warning',
  );

  // A clean run says nothing, which must stay nothing rather than becoming an empty warning.
  assert.deepEqual(
    orphansPrinted([
      'Run Test Suite: res://test/guild_test.gd',
      'Statistics: 2 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 0 orphans |	PASSED',
      'Overall Summary: 2 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 0 orphans |',
    ]),
    { total: 0, suites: [] },
  );

  // The totals are not a suite's. A summary line arriving with a suite still open would otherwise
  // be counted twice: once against that suite and once as the total.
  const onlyTotals = orphansPrinted([
    'Run Test Suite: res://test/docket_test.gd',
    'Overall Summary: 5 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 4 orphans |',
  ]);
  assert.deepEqual(onlyTotals, { total: 4, suites: [] });

  // And a summary line this stops recognising costs the total, not the rows under it.
  const noSummary = orphansPrinted([
    'Run Test Suite: res://test/docket_test.gd',
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
function testAFailingStringReadsItsValue(): void {
  for (const ending of ['\n', '\r\n']) {
    readsItsValue(ending);
  }
}

function readsItsValue(ending: string): void {
  const e = String.fromCharCode(0x1b);
  const printed = [
    ` but was`,
    ` '${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[38;2;255;255;255mabc${e}[0m${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[0m${e}[38;2;30;144;255m${e}[0m'${e}[0m${e}[38;2;173;216;230m\tat 'test_empty' in res://test/words_test.gd:5${e}[0m`,
    ` but was`,
    ` '${e}[38;2;30;144;255mab${e}[48;2;38;0;0m${e}[38;2;255;255;255mc${e}[0m${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[0m${e}[38;2;30;144;255m${e}[48;2;0;38;0m${e}[38;2;255;255;255mX<LF>${e}[0m${e}[38;2;30;144;255m${e}[48;2;0;38;0m${e}[0m${e}[38;2;30;144;255md${e}[0m'${e}[0m${e}[38;2;173;216;230m\tat 'test_swapped' in res://test/words_test.gd:9${e}[0m`,
  ].join(ending);
  const reported = (name: string, line: number, expected: string, merged: string): { detail: string } => ({
    detail: `Expecting:\n '${expected}'\n but was\n '${merged}'\n\tat '${name}' in res://test/words_test.gd:${line}`,
  });
  const [empty, swapped, elsewhere, numbers, apart] = withActualsPrinted(
    [
      reported('test_empty', 5, 'abc', 'abc'),
      reported('test_swapped', 9, 'abcd', 'abcX<LF>d'),
      reported('test_unprinted', 12, 'same', 'same'),
      { detail: "Expecting:\n 5\n but was\n 4\n\tat 'test_sums' in res://test/words_test.gd:15" },
      reported('test_unprinted_apart', 18, 'abcd', 'abcXd'),
    ],
    printed,
  );
  assert.match(
    empty?.detail ?? '',
    / but was\n ''\n\tat 'test_empty'/,
    `an empty value reads as empty, lines ended ${JSON.stringify(ending)}`,
  );
  assert.match(
    swapped?.detail ?? '',
    / but was\n 'abX\nd'\n\tat 'test_swapped'/,
    'a swapped character reads as the one the value had, and a marked line break as a line break',
  );
  assert.ok(
    (elsewhere?.detail ?? '').endsWith(BOTH_SIDES_ALIKE_NOTE),
    `a detail the console kept no copy of says its two sides cannot be told apart: ${elsewhere?.detail}`,
  );
  assert.equal(
    numbers?.detail,
    "Expecting:\n 5\n but was\n 4\n\tat 'test_sums' in res://test/words_test.gd:15",
    'anything that is not a merged string is left as it was',
  );
  assert.ok(
    (apart?.detail ?? '').endsWith(
      `'abcXd'\n\tat 'test_unprinted_apart' in res://test/words_test.gd:18\n${VALUE_NOT_RECOVERED_NOTE}`,
    ),
    `a detail the console kept no copy of, whose sides differ, says its value may be the merge: ${apart?.detail}`,
  );
}

/**
 * One assertion line failing twice, as a parameterized test does: one function name, one line, and a
 * different value each time. Expected "abc", found "" and then "a", which merge alike, so a diff
 * offered to every failure it matched gave both the first one's value.
 */
function testOneLineFailingTwiceKeepsEachValue(): void {
  const e = String.fromCharCode(0x1b);
  const at = `${e}[0m${e}[38;2;173;216;230m\tat 'test_each' in res://test/each_test.gd:7${e}[0m`;
  const printed = [
    ` but was`,
    ` '${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[38;2;255;255;255mabc${e}[0m${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[0m${e}[38;2;30;144;255m${e}[0m'${at}`,
    ` but was`,
    ` '${e}[38;2;30;144;255ma${e}[48;2;38;0;0m${e}[38;2;255;255;255mbc${e}[0m${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[0m${e}[38;2;30;144;255m${e}[0m'${at}`,
  ].join('\n');
  const reported = {
    detail: "Expecting:\n 'abc'\n but was\n 'abc'\n\tat 'test_each' in res://test/each_test.gd:7",
  };
  const [first, second] = withActualsPrinted([reported, reported], printed);
  assert.match(
    first?.detail ?? '',
    / but was\n ''\n\tat 'test_each'/,
    `the first found nothing: ${first?.detail}`,
  );
  assert.match(
    second?.detail ?? '',
    / but was\n 'a'\n\tat 'test_each'/,
    `the second found "a": ${second?.detail}`,
  );
}

/**
 * A string equality after an array equality, read off the console that gdUnit4 v6.2.1 printed on
 * 4.7.2 for the suite below, ended both ways. An array's value is followed by a table of
 * differences and then its location, not by a quote and its location, so it is the one failure
 * whose own report a match cannot end in.
 *
 *     func test_a_array_failure_first() -> void:
 *         assert_array([0, 55, 110]).is_equal([0, 75, 150])
 *     func test_the_sentence_alone() -> void:
 *         assert_str(FOUND).is_equal(WANTED)
 *     func test_a_mismatch_string_first() -> void:
 *         assert_str("wanted deals 25; got deals 15").is_empty()
 *     func test_the_sentence_after_others() -> void:
 *         assert_str(FOUND).is_equal(WANTED)
 */
function testAStringAfterAnArrayReadsItsOwnValue(): void {
  for (const ending of ['\n', '\r\n']) {
    readsItsOwnValue(ending);
  }
}

function readsItsOwnValue(ending: string): void {
  const e = String.fromCharCode(0x1b);
  const printed = [
    `${e}[38;2;0;206;209mRun Test Suite: ${e}[0m${e}[38;2;250;235;215mres://mixed/mixed_test.gd${e}[0m`,
    `  ${e}[38;2;250;235;215mres://mixed/mixed_test.gd${e}[0m${e}[38;2;128;128;128m > ${e}[0m${e}[38;2;250;235;215mtest_a_array_failure_first${e}[0m${e}[38;2;34;139;34m STARTED${e}[0m${e}[38;2;128;128;128m${e}[0m`,
    `  ${e}[38;2;250;235;215mres://mixed/mixed_test.gd${e}[0m${e}[38;2;128;128;128m > ${e}[0m${e}[38;2;250;235;215mtest_a_array_failure_first${e}[0m${e}[38;2;178;34;34m${e}[1m FAILED${e}[0m${e}[38;2;100;149;237m 9ms${e}[0m`,
    `  ${e}[38;2;0;206;209m${e}[1m${e}[4mReport:${e}[0m`,
    `  ${e}[38;2;128;128;128m${e}[38;2;255;69;0mExpecting:${e}[0m`,
    ` '${e}[38;2;30;144;255m[0, 75, 150]${e}[0m'`,
    ` but was`,
    ` '${e}[38;2;30;144;255m[0, ${e}[48;2;38;0;0m${e}[38;2;255;255;255m55${e}[0m${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[0m${e}[38;2;30;144;255m, ${e}[48;2;38;0;0m${e}[38;2;255;255;255m110${e}[0m${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[0m${e}[38;2;30;144;255m]${e}[0m'`,
    ``,
    `${e}[38;2;255;69;0mDifferences found:${e}[0m`,
    `[table=3][cell][right]${e}[1mIndex${e}[0m[/right]\t[/cell][cell][right]${e}[1mCurrent${e}[0m[/right]\t[/cell][cell][right]${e}[1mExpected${e}[0m[/right]\t[/cell][cell][right]1[/right]\t[/cell][cell][right]55[/right]\t[/cell][cell][right]75[/right]\t[/cell][cell][right]2[/right]\t[/cell][cell][right]110[/right]\t[/cell][cell][right]150[/right]\t[/cell][/table]${e}[0m${e}[38;2;173;216;230m\tat 'test_a_array_failure_first' in res://mixed/mixed_test.gd:8${e}[0m${e}[38;2;128;128;128m${e}[0m`,
    `${e}[38;2;128;128;128m${e}[0m`,
    `  ${e}[38;2;250;235;215mres://mixed/mixed_test.gd${e}[0m${e}[38;2;128;128;128m > ${e}[0m${e}[38;2;250;235;215mtest_the_sentence_alone${e}[0m${e}[38;2;34;139;34m STARTED${e}[0m${e}[38;2;128;128;128m${e}[0m`,
    `  ${e}[38;2;250;235;215mres://mixed/mixed_test.gd${e}[0m${e}[38;2;128;128;128m > ${e}[0m${e}[38;2;250;235;215mtest_the_sentence_alone${e}[0m${e}[38;2;178;34;34m${e}[1m FAILED${e}[0m${e}[38;2;100;149;237m 9ms${e}[0m`,
    `  ${e}[38;2;0;206;209m${e}[1m${e}[4mReport:${e}[0m`,
    `  ${e}[38;2;128;128;128m${e}[38;2;255;69;0mExpecting:${e}[0m`,
    ` '${e}[38;2;30;144;255mevery word you speak is 1 louder, for every Ostinato you have spoken this duel${e}[0m'`,
    ` but was`,
    ` '${e}[38;2;30;144;255mevery word you speak is 1 louder, for every ${e}[48;2;38;0;0m${e}[38;2;255;255;255mO${e}[0m${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[0m${e}[38;2;30;144;255ms${e}[48;2;38;0;0m${e}[38;2;255;255;255mtinato${e}[0m${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[0m${e}[38;2;30;144;255m${e}[48;2;0;38;0m${e}[38;2;255;255;255mpell${e}[0m${e}[38;2;30;144;255m${e}[48;2;0;38;0m${e}[0m${e}[38;2;30;144;255m you have spoken this duel${e}[0m'${e}[0m${e}[38;2;173;216;230m\tat 'test_the_sentence_alone' in res://mixed/mixed_test.gd:12${e}[0m${e}[38;2;128;128;128m${e}[0m`,
    `${e}[38;2;128;128;128m${e}[0m`,
    `  ${e}[38;2;250;235;215mres://mixed/mixed_test.gd${e}[0m${e}[38;2;128;128;128m > ${e}[0m${e}[38;2;250;235;215mtest_a_mismatch_string_first${e}[0m${e}[38;2;34;139;34m STARTED${e}[0m${e}[38;2;128;128;128m${e}[0m`,
    `  ${e}[38;2;250;235;215mres://mixed/mixed_test.gd${e}[0m${e}[38;2;128;128;128m > ${e}[0m${e}[38;2;250;235;215mtest_a_mismatch_string_first${e}[0m${e}[38;2;178;34;34m${e}[1m FAILED${e}[0m${e}[38;2;100;149;237m 9ms${e}[0m`,
    `  ${e}[38;2;0;206;209m${e}[1m${e}[4mReport:${e}[0m`,
    `  ${e}[38;2;128;128;128m${e}[38;2;255;69;0mExpecting:${e}[0m`,
    ` must be empty but was`,
    ` '${e}[38;2;30;144;255mwanted deals 25; got deals 15${e}[0m'${e}[0m${e}[38;2;173;216;230m\tat 'test_a_mismatch_string_first' in res://mixed/mixed_test.gd:16${e}[0m${e}[38;2;128;128;128m${e}[0m`,
    `${e}[38;2;128;128;128m${e}[0m`,
    `  ${e}[38;2;250;235;215mres://mixed/mixed_test.gd${e}[0m${e}[38;2;128;128;128m > ${e}[0m${e}[38;2;250;235;215mtest_the_sentence_after_others${e}[0m${e}[38;2;34;139;34m STARTED${e}[0m${e}[38;2;128;128;128m${e}[0m`,
    `  ${e}[38;2;250;235;215mres://mixed/mixed_test.gd${e}[0m${e}[38;2;128;128;128m > ${e}[0m${e}[38;2;250;235;215mtest_the_sentence_after_others${e}[0m${e}[38;2;178;34;34m${e}[1m FAILED${e}[0m${e}[38;2;100;149;237m 9ms${e}[0m`,
    `  ${e}[38;2;0;206;209m${e}[1m${e}[4mReport:${e}[0m`,
    `  ${e}[38;2;128;128;128m${e}[38;2;255;69;0mExpecting:${e}[0m`,
    ` '${e}[38;2;30;144;255mevery word you speak is 1 louder, for every Ostinato you have spoken this duel${e}[0m'`,
    ` but was`,
    ` '${e}[38;2;30;144;255mevery word you speak is 1 louder, for every ${e}[48;2;38;0;0m${e}[38;2;255;255;255mO${e}[0m${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[0m${e}[38;2;30;144;255ms${e}[48;2;38;0;0m${e}[38;2;255;255;255mtinato${e}[0m${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[0m${e}[38;2;30;144;255m${e}[48;2;0;38;0m${e}[38;2;255;255;255mpell${e}[0m${e}[38;2;30;144;255m${e}[48;2;0;38;0m${e}[0m${e}[38;2;30;144;255m you have spoken this duel${e}[0m'${e}[0m${e}[38;2;173;216;230m\tat 'test_the_sentence_after_others' in res://mixed/mixed_test.gd:20${e}[0m${e}[38;2;128;128;128m${e}[0m`,
    `${e}[38;2;128;128;128m${e}[0m`,
  ].join(ending);
  const wanted = 'every word you speak is 1 louder, for every Ostinato you have spoken this duel';
  const found = 'every word you speak is 1 louder, for every spell you have spoken this duel';
  const merged = 'every word you speak is 1 louder, for every Ostinatopell you have spoken this duel';
  const at = (name: string, line: number): string => `\tat '${name}' in res://mixed/mixed_test.gd:${line}`;
  const arrayDetail = `Expecting:\n '[0, 75, 150]'\n but was\n '[0, 55, 110]'\n\nDifferences found:\nIndex\tCurrent\tExpected\t1\t55\t75\t2\t110\t150\t\n${at('test_a_array_failure_first', 8)}`;
  const emptyDetail = `Expecting:\n must be empty but was\n 'wanted deals 25; got deals 15'\n${at('test_a_mismatch_string_first', 16)}`;
  const [array, alone, empty, after] = withActualsPrinted(
    [
      { detail: arrayDetail },
      { detail: `Expecting:\n '${wanted}'\n but was\n '${merged}'\n${at('test_the_sentence_alone', 12)}` },
      { detail: emptyDetail },
      {
        detail: `Expecting:\n '${wanted}'\n but was\n '${merged}'\n${at('test_the_sentence_after_others', 20)}`,
      },
    ],
    printed,
  );
  for (const [name, line, entry] of [
    ['test_the_sentence_alone', 12, alone],
    ['test_the_sentence_after_others', 20, after],
  ] as const) {
    assert.equal(
      entry?.detail,
      `Expecting:\n '${wanted}'\n but was\n '${found}'\n${at(name, line)}`,
      `${name} reads the value it found, lines ended ${JSON.stringify(ending)}`,
    );
  }
  assert.equal(array?.detail, arrayDetail, 'the array equality is left as the report wrote it');
  assert.equal(empty?.detail, emptyDetail, 'a value with no marks is left as the report wrote it');
}

/**
 * The other shapes a string equality is printed in, read off the console gdUnit4 v6.2.1 printed on
 * 4.7.2, ended both ways, for these cases:
 *
 *     assert_str("for every spell").is_equal_ignoring_case("FOR EVERY OSTINATO")
 *     assert_str("a [b]bold[/b] x").is_equal("a [b]bold[/b] y")
 *     assert_str("keep [lb] as is").is_equal("other")
 *     assert_dict({"[lb]": 1}).is_equal({"[lb]": 2})
 *     assert_str("plain").is_equal("[b]plain[/b]")
 *     assert_failure(func() -> void: assert_int(1).is_equal(2)).has_message("Expecting:\n '3'\n but was\n '1'")
 */
function testEveryShapeOfAStringEqualityReadsItsValue(): void {
  for (const ending of ['\n', '\r\n']) {
    readsEveryShape(ending);
  }
}

function readsEveryShape(ending: string): void {
  const e = String.fromCharCode(0x1b);
  const printed = [
    `  ${e}[38;2;250;235;215mres://probe/probe_test.gd${e}[0m${e}[38;2;128;128;128m > ${e}[0m${e}[38;2;250;235;215mtest_ignoring_case_second${e}[0m${e}[38;2;178;34;34m${e}[1m FAILED${e}[0m${e}[38;2;100;149;237m 6ms${e}[0m`,
    `  ${e}[38;2;0;206;209m${e}[1m${e}[4mReport:${e}[0m`,
    `  ${e}[38;2;128;128;128m${e}[38;2;255;69;0mExpecting:${e}[0m`,
    ` '${e}[38;2;30;144;255mFOR EVERY OSTINATO${e}[0m'`,
    ` but was`,
    ` '${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[38;2;255;255;255mFOR${e}[0m${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[0m${e}[38;2;30;144;255m${e}[48;2;0;38;0m${e}[38;2;255;255;255mfor${e}[0m${e}[38;2;30;144;255m${e}[48;2;0;38;0m${e}[0m${e}[38;2;30;144;255m ${e}[48;2;38;0;0m${e}[38;2;255;255;255mEVERY${e}[0m${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[0m${e}[38;2;30;144;255m${e}[48;2;0;38;0m${e}[38;2;255;255;255mevery${e}[0m${e}[38;2;30;144;255m${e}[48;2;0;38;0m${e}[0m${e}[38;2;30;144;255m ${e}[48;2;38;0;0m${e}[38;2;255;255;255mOSTINATO${e}[0m${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[0m${e}[38;2;30;144;255m${e}[48;2;0;38;0m${e}[38;2;255;255;255mspell${e}[0m${e}[38;2;30;144;255m${e}[48;2;0;38;0m${e}[0m${e}[38;2;30;144;255m${e}[0m' (ignoring case)${e}[0m${e}[38;2;173;216;230m\tat 'test_ignoring_case_second' in res://probe/probe_test.gd:72${e}[0m${e}[38;2;128;128;128m${e}[0m`,
    `  ${e}[38;2;250;235;215mres://probe/probe_test.gd${e}[0m${e}[38;2;128;128;128m > ${e}[0m${e}[38;2;250;235;215mtest_bbcode${e}[0m${e}[38;2;178;34;34m${e}[1m FAILED${e}[0m${e}[38;2;100;149;237m 6ms${e}[0m`,
    `  ${e}[38;2;0;206;209m${e}[1m${e}[4mReport:${e}[0m`,
    `  ${e}[38;2;128;128;128m${e}[38;2;255;69;0mExpecting:${e}[0m`,
    ` '${e}[38;2;30;144;255ma [lb]b]bold[lb]/b] y${e}[0m'`,
    ` but was`,
    ` '${e}[38;2;30;144;255ma [lb]b]bold[lb]/b] x${e}[0m'${e}[0m${e}[38;2;173;216;230m\tat 'test_bbcode' in res://probe/probe_test.gd:80${e}[0m${e}[38;2;128;128;128m${e}[0m`,
    `  ${e}[38;2;250;235;215mres://probe/probe_test.gd${e}[0m${e}[38;2;128;128;128m > ${e}[0m${e}[38;2;250;235;215mtest_literal_lb${e}[0m${e}[38;2;178;34;34m${e}[1m FAILED${e}[0m${e}[38;2;100;149;237m 6ms${e}[0m`,
    `  ${e}[38;2;0;206;209m${e}[1m${e}[4mReport:${e}[0m`,
    `  ${e}[38;2;128;128;128m${e}[38;2;255;69;0mExpecting:${e}[0m`,
    ` '${e}[38;2;30;144;255mother${e}[0m'`,
    ` but was`,
    ` '${e}[38;2;30;144;255mkeep [lb]lb] as is${e}[0m'${e}[0m${e}[38;2;173;216;230m\tat 'test_literal_lb' in res://probe/probe_test.gd:84${e}[0m${e}[38;2;128;128;128m${e}[0m`,
    `  ${e}[38;2;250;235;215mres://probe/probe_test.gd${e}[0m${e}[38;2;128;128;128m > ${e}[0m${e}[38;2;250;235;215mtest_dict_lb${e}[0m${e}[38;2;178;34;34m${e}[1m FAILED${e}[0m${e}[38;2;100;149;237m 5ms${e}[0m`,
    `  ${e}[38;2;0;206;209m${e}[1m${e}[4mReport:${e}[0m`,
    `  ${e}[38;2;128;128;128m${e}[38;2;255;69;0mExpecting:${e}[0m`,
    ` '${e}[38;2;30;144;255m{`,
    `\t"[lb]": 2`,
    `  }${e}[0m'`,
    ` but was`,
    ` '${e}[38;2;30;144;255m{`,
    `\t"[lb]": 1`,
    `  }${e}[0m'${e}[0m${e}[38;2;173;216;230m\tat 'test_dict_lb' in res://probe/probe_test.gd:100${e}[0m${e}[38;2;128;128;128m${e}[0m`,
    `  ${e}[38;2;250;235;215mres://probe/probe_test.gd${e}[0m${e}[38;2;128;128;128m > ${e}[0m${e}[38;2;250;235;215mtest_bbcode_expected_only${e}[0m${e}[38;2;178;34;34m${e}[1m FAILED${e}[0m${e}[38;2;100;149;237m 18ms${e}[0m`,
    `  ${e}[38;2;0;206;209m${e}[1m${e}[4mReport:${e}[0m`,
    `  ${e}[38;2;128;128;128m${e}[38;2;255;69;0mExpecting:${e}[0m`,
    ` '${e}[38;2;30;144;255m${e}[1mplain${e}[0m${e}[38;2;30;144;255m${e}[0m'`,
    ` but was`,
    ` '${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[38;2;255;255;255m${e}[1m${e}[0m${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[0m${e}[38;2;30;144;255mplain${e}[48;2;38;0;0m${e}[38;2;255;255;255m${e}[0m${e}[38;2;255;255;255m${e}[48;2;38;0;0m${e}[0m${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[0m${e}[38;2;30;144;255m${e}[0m'${e}[0m${e}[38;2;173;216;230m\tat 'test_bbcode_expected_only' in res://probe/probe_test.gd:92${e}[0m${e}[38;2;128;128;128m${e}[0m`,
    `  ${e}[38;2;250;235;215mres://probe/probe_test.gd${e}[0m${e}[38;2;128;128;128m > ${e}[0m${e}[38;2;250;235;215mtest_has_message${e}[0m${e}[38;2;178;34;34m${e}[1m FAILED${e}[0m${e}[38;2;100;149;237m 6ms${e}[0m`,
    `  ${e}[38;2;0;206;209m${e}[1m${e}[4mReport:${e}[0m`,
    `  ${e}[38;2;128;128;128m${e}[38;2;255;69;0mExpecting error message:${e}[0m`,
    ` '${e}[38;2;30;144;255mExpecting:`,
    ` '3'`,
    ` but was`,
    ` '1'${e}[0m'`,
    ` but was`,
    ` '${e}[38;2;30;144;255mExpecting:`,
    ` ${e}[48;2;38;0;0m${e}[38;2;255;255;255m'3'${e}[0m${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[0m${e}[38;2;30;144;255m${e}[48;2;0;38;0m${e}[38;2;255;255;255m2${e}[0m${e}[38;2;30;144;255m${e}[48;2;0;38;0m${e}[0m${e}[38;2;30;144;255m`,
    ` but was`,
    ` ${e}[48;2;38;0;0m${e}[38;2;255;255;255m'${e}[0m${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[0m${e}[38;2;30;144;255m1${e}[48;2;38;0;0m${e}[38;2;255;255;255m'${e}[0m${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[0m${e}[38;2;30;144;255m${e}[0m'${e}[0m${e}[38;2;173;216;230m\tat 'test_has_message' in res://probe/probe_test.gd:76${e}[0m${e}[38;2;128;128;128m${e}[0m`,
  ];
  const reported = {
    test_ignoring_case_second:
      "Expecting:\n 'FOR EVERY OSTINATO'\n but was\n 'FORfor EVERYevery OSTINATOspell' (ignoring case)\n\tat 'test_ignoring_case_second' in res://probe/probe_test.gd:72",
    test_bbcode:
      "Expecting:\n 'a [lb]b]bold[lb]/b] y'\n but was\n 'a [lb]b]bold[lb]/b] x'\n\tat 'test_bbcode' in res://probe/probe_test.gd:80",
    test_literal_lb:
      "Expecting:\n 'other'\n but was\n 'keep [lb]lb] as is'\n\tat 'test_literal_lb' in res://probe/probe_test.gd:84",
    test_dict_lb:
      "Expecting:\n '{\n\t\"[lb]\": 2\n  }'\n but was\n '{\n\t\"[lb]\": 1\n  }'\n\tat 'test_dict_lb' in res://probe/probe_test.gd:100",
    test_bbcode_expected_only:
      "Expecting:\n 'plain'\n but was\n 'plain'\n\tat 'test_bbcode_expected_only' in res://probe/probe_test.gd:92",
    test_has_message:
      "Expecting error message:\n 'Expecting:\n '3'\n but was\n '1''\n but was\n 'Expecting:\n '3'2\n but was\n '1''\n\tat 'test_has_message' in res://probe/probe_test.gd:76",
  };
  const unprintedMessage = `Expecting error message:\n 'abc'\n but was\n 'abXc'\n\tat 'test_unprinted' in res://probe/probe_test.gd:90`;
  const [ignoring, bbcode, literal, dictionary, renderedAway, message, unprinted] = withActualsPrinted(
    [...Object.values(reported), unprintedMessage].map((detail) => ({ detail })),
    printed.join(ending),
  );
  const at = (name: string, line: number): string => `\n\tat '${name}' in res://probe/probe_test.gd:${line}`;
  assert.equal(
    ignoring?.detail,
    `Expecting:\n 'FOR EVERY OSTINATO'\n but was\n 'for every spell' (ignoring case)${at('test_ignoring_case_second', 72)}`,
    `an equality ignoring case reads the value it found, lines ended ${JSON.stringify(ending)}`,
  );
  assert.equal(
    bbcode?.detail,
    `Expecting:\n 'a [b]bold[/b] y'\n but was\n 'a [b]bold[/b] x'${at('test_bbcode', 80)}`,
    'a string holding BBCode reads without the mask gdUnit4 put on both sides',
  );
  assert.equal(
    literal?.detail,
    `Expecting:\n 'other'\n but was\n 'keep [lb] as is'${at('test_literal_lb', 84)}`,
    'a string holding the mask itself reads as it was written',
  );
  assert.equal(
    dictionary?.detail,
    reported.test_dict_lb,
    'a dictionary holding the mask is left as it printed',
  );
  assert.equal(
    renderedAway?.detail,
    `${reported.test_bbcode_expected_only}\n${RENDERED_AWAY_NOTE}`,
    'two sides that still read alike once the value is read back say what went unprinted',
  );
  assert.equal(
    message?.detail,
    `Expecting error message:\n 'Expecting:\n '3'\n but was\n '1''\n but was\n 'Expecting:\n 2\n but was\n 1'${at('test_has_message', 76)}`,
    'an error message holding " but was" of its own reads the message the failure had',
  );
  assert.equal(
    unprinted?.detail,
    `${unprintedMessage}\n${VALUE_NOT_RECOVERED_NOTE}`,
    'an error message the console kept no copy of says its value may be the merge',
  );
}

/**
 * #915: the suites a run has finished, read off the console as gdUnit4 printed it on 4.7.2 with
 * v6.2.1, for a run cut off before its report and for the progress a long one sends. The second
 * suite fails and is followed by its report's lines, and the third is still running.
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
    '  res://test/my suites/b_test.gd > test_errs:1 (a, b) ERROR 5ms',
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
    '2 suites have finished, 1 with failures; running res://test/c_test.gd; 2m 5s in.',
  );
  assert.equal(
    testProgressMessage(printed.slice(0, 4), 9_999),
    'No suite has finished; running res://test/a_test.gd; 9s in.',
  );
  assert.equal(testProgressMessage(printed.slice(0, 7), 30_000), 'One suite has finished; 30s in.');
  assert.equal(testProgressMessage([], 1_000), 'No suite has finished; 1s in.');
}

testWhatGdUnitWrites();
testAFailingStringReadsItsValue();
testOneLineFailingTwiceKeepsEachValue();
testASuiteWithASpaceInItsPathKeepsItsOrphans();
testAFailedHookIsCountedAndNamed();
testASecondFailedAssertionIsNotAHook();
testEveryReportOfACaseIsKept();
testAStringAfterAnArrayReadsItsOwnValue();
testEveryShapeOfAStringEqualityReadsItsValue();
testEntitiesAndShapes();
testMalformedReportsAreRefused();
testARunThatFoundNothingIsNotAPass();
testARunThatSaidNothingOfTheSortIsLeftAlone();
testOrphansAreReadOffTheConsole();
testScriptErrorsAreReadOffTheConsole();
testFinishedSuitesAreReadOffTheConsole();
console.log('junit reader tests passed');
