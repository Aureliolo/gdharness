/**
 * A stand-in engine whose test run fails one string equality on a long value. It prints a Godot
 * version for `--version`, answers an operation by writing an empty change list to the answer file,
 * and ends any other start that names no report folder at once. A test run's one suite prints the
 * value as gdUnit4 colours a failing string: a marked "o" the assertion did not find, then the
 * value, then its location line. The report holds the merge, "o" and the value. The project's
 * `value.json` names the value's character and how many times it is repeated, as
 * `{ "character": "x", "count": 1000 }`.
 */

import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

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
const parsed: unknown = JSON.parse(readFileSync(join(project, 'value.json'), 'utf8'));
const fields = new Map<string, unknown>(
  typeof parsed === 'object' && parsed !== null ? Object.entries(parsed) : [],
);
const character = fields.get('character');
const count = fields.get('count');
const asked = {
  character: typeof character === 'string' ? character : 'x',
  count: typeof count === 'number' ? count : 0,
};
const logFd = log === undefined ? null : openSync(log, 'a');
const say = (text: string): void => {
  const bytes = Buffer.from(text);
  writeSync(1, bytes);
  if (logFd !== null) {
    writeSync(logFd, bytes);
  }
};
const e = String.fromCharCode(0x1b);
const suite = 'res://tests/s0_test.gd';
const block = asked.character.repeat(64 * 1024);
say('Godot Engine v4.7.2.stable.official - https://godotengine.org\n');
say(
  `Run Test Suite: ${suite}\n  ${suite} > test_one STARTED\n  Expecting:\n 'other'\n but was\n '${e}[38;2;30;144;255m${e}[48;2;38;0;0m${e}[38;2;255;255;255mo${e}[0m`,
);
for (let left = asked.count; left > 0; left -= block.length) {
  say(left >= block.length ? block : block.slice(0, left));
}
say(
  `'${e}[0m\tat 'test_one' in ${suite}:5\n  ${suite} > test_one FAILED 5ms\nStatistics: 1 test cases | 0 errors | 1 failures | 0 flaky | 0 skipped | 0 orphans | FAILED 40ms\n\n`,
);
say(
  'Overall Summary: 1 test cases | 0 errors | 1 failures | 0 flaky | 0 skipped | 0 orphans |\nExecuted test suites: (1/1)\nExecuted test cases : (1/1)\nTotal execution time: 1s 0ms\n',
);
if (logFd !== null) {
  closeSync(logFd);
}
const failure = `<failure message="FAILED: ${suite}:5" type="FAILURE"><![CDATA[Expecting:\n 'other'\n but was\n 'o${asked.character.repeat(asked.count)}'\n\tat 'test_one' in ${suite}:5]]></failure>`;
const xml = `<?xml version="1.0" encoding="UTF-8" ?><testsuites id="x" name="report_1" tests="1" failures="1" skipped="0" flaky="0" time="0"><testsuite id="0" name="s0_test" package="tests" tests="1" failures="1" errors="0" skipped="0" flaky="0" time="0.04"><testcase name="test_one" classname="s0_test" time="0.012">${failure}</testcase></testsuite></testsuites>`;
const directory = join(project, reports, 'report_1');
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, 'results.xml'), xml);
process.exit(100);
