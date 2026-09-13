/**
 * What the harness says when the answer is "tell the maintainer": the defect report a call that
 * fell through every modelled failure carries, and the invitation to name a missing tool.
 *
 * Both are read by an agent that will act on them, so what is asserted here is the part that
 * decides what it does next: that the retry is called pointless, that the decision is handed to
 * the user, and that the link it would be handed is one a browser can open.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import process from 'node:process';
import pkg from '../package.json' with { type: 'json' };
import { Refusal } from '../src/errors.js';
import { defectReport, defectSignature, ENHANCEMENT_URL, feedbackNotice } from '../src/issues.js';
import { portFromEnv } from '../src/ports.js';

const report = defectReport('editor_scene op=open', new TypeError('Cannot read properties of undefined'));

// The facts a report is useless without. Version and platform above all: the first question on
// any bug is "which one", and an agent cannot answer it from a message alone.
assert.match(report, /editor_scene op=open/, 'the report should say which call failed');
assert.match(report, /Cannot read properties of undefined/, 'the report should carry the error');
assert.match(report, new RegExp(`gdharness ${pkg.version.replaceAll('.', '\\.')}`), 'and the version');
assert.match(report, new RegExp(process.platform), 'and the platform it happened on');

// The two sentences that decide what the agent does with it. Without the first it retries a call
// that cannot succeed; without the second it files on somebody's behalf without asking.
assert.match(report, /sending it again will not\nchange it/, 'the report should stop the retry loop');
assert.match(report, /Do not open an issue on your own initiative/, 'and hand the decision over');
assert.match(report, /ask whether you may report it/, 'by asking the user first');
assert.match(report, /no way to open an issue yourself/, 'with the case where it cannot file at all');

// The one report nobody would think to send: the message itself being wrong. A failure this
// program anticipates arriving dressed as one it does not is the misclassification that keeps
// every future caller chasing a bug that is not there.
assert.match(report, /this message is the defect/, 'a misfiled failure should invite its own report');

// A link that does not open is worse than no link: the agent hands it over and the user is stuck.
const link = /(https:\/\/github\.com\/\S+)/.exec(report)?.[1];
assert.ok(link !== undefined, 'the report should carry a link');
const url = new URL(link);
assert.equal(url.pathname, '/Aureliolo/gdharness/issues/new', 'the link should open a new issue');
assert.equal(url.searchParams.get('template'), 'bug_report.md', 'against the bug template');
const body = url.searchParams.get('body') ?? '';
assert.match(body, /Cannot read properties of undefined/, 'the prefilled body should carry the error');
assert.match(body, /## What you did/, 'and the headings the template asks for');
assert.match(
  body,
  /rather than as a refusal naming what would have worked/,
  'and leave a place to say the message itself was the mistake',
);
assert.match(
  url.searchParams.get('title') ?? '',
  /^Defect [0-9a-f]{8}: editor_scene op=open$/,
  'the title should name the signature and the call',
);

// The signature is a dedupe aid: the same defect from two machines has to arrive as one. Paths
// and numbers are what differ between those machines, so they are what it must not see.
const windows = defectSignature('editor_scene op=open', 'ENOENT: C:\\Users\\ana\\game\\main.tscn line 42');
const linux = defectSignature('editor_scene op=open', 'ENOENT: /home/bo/game/main.tscn line 7');
assert.equal(windows, linux, 'one defect on two machines should sign the same');
assert.match(windows, /^[0-9a-f]{8}$/, 'a signature should be eight hex characters');
assert.notEqual(
  windows,
  defectSignature('editor_scene op=open', 'the bridge answered with no payload'),
  'two different failures should not sign the same',
);
assert.notEqual(
  windows,
  defectSignature('editor_script op=create', 'ENOENT: /home/bo/game/main.tscn line 7'),
  'the same message from two calls should not sign the same',
);

// The feedback block rides on an ordinary answer, so it has to parse as one more field rather
// than as prose a reader has to guess the shape of.
const notice: unknown = JSON.parse(feedbackNotice());
assert.ok(
  typeof notice === 'object' && notice !== null && 'gdharness_feedback' in notice,
  'the feedback notice should be a JSON block under one named key',
);
const feedback = (notice as { gdharness_feedback: { what_to_do?: unknown; enhancement_url?: unknown } })
  .gdharness_feedback;
assert.equal(feedback.enhancement_url, ENHANCEMENT_URL, 'and carry the link to open');
assert.equal(
  new URL(ENHANCEMENT_URL).searchParams.get('template'),
  'feature_request.md',
  'which should open the enhancement template',
);
assert.match(String(feedback.what_to_do), /offer to open an enhancement issue/, 'it should offer, not file');
assert.match(String(feedback.what_to_do), /Only if they say yes/, 'and wait for a yes');
assert.match(
  String(feedback.what_to_do),
  /a call you got wrong is not one/,
  'and say what does not count as a gap, since everything else here invites reporting',
);

// The other half of the same line, on the server side: a failure that was anticipated has to
// carry its type, or the boundary in server.ts reads it as a state nobody modelled and answers a
// misconfigured environment with a bug report.
process.env['GDHARNESS_TEST_PORT'] = 'banana';
assert.throws(
  () => portFromEnv('GDHARNESS_TEST_PORT', 6005),
  Refusal,
  'a port variable holding nonsense is the caller"s to fix, not a defect',
);
delete process.env['GDHARNESS_TEST_PORT'];
assert.ok(new Refusal('x') instanceof Error, 'a refusal is still an Error wherever one is caught');

// The same line has to hold at the command line, where it is drawn by a class rather than a
// catch: a mistyped command is the caller's, and answering one with a bug report would have
// people filing their own typos.
const mistyped = Bun.spawnSync([process.execPath, 'src/cli.ts', 'nonsense-command'], {
  cwd: join(import.meta.dirname, '..'),
  stdout: 'pipe',
  stderr: 'pipe',
});
const said = mistyped.stderr.toString();
assert.equal(mistyped.exitCode, 2, `a mistyped command should exit 2, said: ${said}`);
assert.match(said, /Unknown command/, 'and name what was wrong with it');
assert.doesNotMatch(said, /Do not open an issue/, 'and never read as a defect in gdharness');

console.log('issue reporting checks passed');
