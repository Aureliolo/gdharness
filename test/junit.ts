/**
 * The JUnit reader against what gdUnit4 writes: one suite with a pass, a failure and a skip,
 * as the runner produced it, and the malformed inputs that must be refused rather than read
 * as a smaller run.
 */

import assert from 'node:assert/strict';
import { MalformedReportError, parseJUnit } from '../src/junit.js';

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

testWhatGdUnitWrites();
testEntitiesAndShapes();
testMalformedReportsAreRefused();
console.log('junit reader tests passed');
