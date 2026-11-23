/**
 * A stand-in engine whose test run prints one failing string value about as long as a suite may
 * print. It prints a Godot version for `--version`, answers an operation by writing an empty change
 * list to the answer file, and ends any other start that names no report folder at once. A test
 * run's first suite prints GDH_LIMIT bytes, nearly all of
 * them the value, closed by its location line, and a second suite prints GDH_REST_MIB MiB of short
 * lines. The report fails the first suite's case on that value, merged as gdUnit4 writes it, when the
 * project holds a file named `value-report-fails`, and passes it otherwise.
 */

import { closeSync, existsSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const MIB = 1024 * 1024;
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('4.7.2.stable.official.ed1daf0bf\n');
  process.exit(0);
}
const fileAt = args.findIndex((one) => one.startsWith('@file:'));
if (fileAt >= 0) {
  writeFileSync(args[fileAt + 1] ?? '', '{"added":[],"removed":[],"changed":[]}');
  process.exit(0);
}
if (!args.includes('-rd')) {
  process.exit(0);
}
const after = (flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const log = after('--log-file');
const project = after('--path') ?? '.';
const reports = (after('-rd') ?? 'res://.godot/gdharness-reports/x').replace(/^res:\/\//, '');
const limit = Number(process.env['GDH_LIMIT'] ?? String(128 * MIB));
const rest = Number(process.env['GDH_REST_MIB'] ?? '8') * MIB;
const failing = existsSync(join(project, 'value-report-fails'));
const logFd = log === undefined ? null : openSync(log, 'a');
const say = (text: string): void => {
  const bytes = Buffer.from(text);
  writeSync(1, bytes);
  if (logFd !== null) {
    writeSync(logFd, bytes);
  }
};
const e = String.fromCharCode(0x1b);
const first = 'res://tests/s0_test.gd';
const second = 'res://tests/s1_test.gd';
say('Godot Engine v4.7.2.stable.official - https://godotengine.org\n');
const head = `Run Test Suite: ${first}\n  ${first} > test_one STARTED\n  Expecting:\n 'other'\n but was\n '${e}[38;2;30;144;255m`;
const tail = `${e}[48;2;38;0;0m${e}[38;2;255;255;255mo${e}[0m'${e}[0m\tat 'test_one' in ${first}:5\n  ${first} > test_one FAILED 5ms\nStatistics: 1 test cases | 0 errors | 1 failures | 0 flaky | 0 skipped | 0 orphans | FAILED 40ms\n\n`;
const valueLength = limit - Buffer.byteLength(head) - Buffer.byteLength(tail);
say(head);
const block = 'v'.repeat(MIB);
for (let left = valueLength; left > 0; left -= block.length) {
  say(left >= block.length ? block : block.slice(0, left));
}
say(tail);
say(`Run Test Suite: ${second}\n  ${second} > test_one STARTED\n`);
for (let left = rest, n = 0; left > 0; ) {
  const lines: string[] = [];
  let size = 0;
  while (size < MIB && size < left) {
    const line = `frame ${String(n % 64)} of the loop ticked\n`;
    n += 1;
    lines.push(line);
    size += line.length;
  }
  say(lines.join(''));
  left -= size;
}
say(
  `  ${second} > test_one PASSED 5ms\nStatistics: 1 test cases | 0 errors | 0 failures | 0 flaky | 0 skipped | 0 orphans | PASSED 40ms\n\n`,
);
const failures = failing ? '1' : '0';
say(
  `Overall Summary: 2 test cases | 0 errors | ${failures} failures | 0 flaky | 0 skipped | 0 orphans |\nExecuted test suites: (2/2)\nExecuted test cases : (2/2)\nTotal execution time: 1s 0ms\n`,
);
if (logFd !== null) {
  closeSync(logFd);
}
const failure = failing
  ? `<failure message="FAILED: ${first}:5" type="FAILURE"><![CDATA[Expecting:\n 'other'\n but was\n '${'v'.repeat(valueLength)}o'\n\tat 'test_one' in ${first}:5]]></failure>`
  : '';
const suite = (id: number, name: string, failed: string, body: string): string =>
  `<testsuite id="${String(id)}" name="${name}" package="tests" tests="1" failures="${failed}" errors="0" skipped="0" flaky="0" time="0.04"><testcase name="test_one" classname="${name}" time="0.012">${body}</testcase></testsuite>`;
const xml = `<?xml version="1.0" encoding="UTF-8" ?><testsuites id="x" name="report_1" tests="2" failures="${failures}" skipped="0" flaky="0" time="0">${suite(0, 's0_test', failures, failure)}${suite(1, 's1_test', '0', '')}</testsuites>`;
const directory = join(project, reports, 'report_1');
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, 'results.xml'), xml);
process.exit(failing ? 100 : 0);
