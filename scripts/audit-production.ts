/**
 * `bun audit --prod`, retried when the advisory service did not answer.
 *
 * The audit asks registry.npmjs.org for advisories, so it fails in two quite different ways and
 * `bun audit` exits 1 for both: a dependency with a known vulnerability, and the service being
 * briefly unavailable. Those want opposite treatment, and the workflows ran the command bare, so a
 * 503 read as a failed audit and stopped a build.
 *
 * The one thing it must never do is pass because the service was unreachable. An audit that cannot
 * reach the advisories has not cleared anything, and reporting that as a clean run is the failure
 * mode worth avoiding above the inconvenience of a stopped build. So an outage is retried, and if
 * the answer never comes the run still fails, saying which of the two it was.
 */

import { spawnSync } from 'node:child_process';

const ATTEMPTS = 4;

/**
 * Whether this failure is the service rather than the dependencies.
 *
 * Matched on the transport, not on the absence of findings: a run that failed because the endpoint
 * answered 503 says so in one line and names no advisory, and treating "printed no advisories" as
 * the test would make every future change to bun's output read as an outage.
 */
export function serviceDidNotAnswer(output: string): boolean {
  const status = /^.*\berror\b.*?[\s-]\b(?:408|429|5\d\d)\b.*$/im;
  const transport = /ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|socket hang up|fetch failed|network error/i;
  return status.test(output) || transport.test(output);
}

function auditOnce(): { ok: boolean; output: string } {
  const run = spawnSync('bun', ['audit', '--prod'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const output = `${run.stdout}${run.stderr}`;
  return { ok: run.status === 0, output };
}

async function main(): Promise<void> {
  let delayMs = 5000;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const { ok, output } = auditOnce();
    process.stdout.write(output);
    if (ok) {
      return;
    }
    if (!serviceDidNotAnswer(output)) {
      console.error('\nThe audit reached the advisory service and it reported the above.');
      process.exitCode = 1;
      return;
    }
    if (attempt === ATTEMPTS) {
      console.error(
        `\nThe advisory service did not answer in ${ATTEMPTS} attempts, so nothing has been cleared.`,
      );
      process.exitCode = 1;
      return;
    }
    console.error(`\nThe advisory service did not answer; retrying in ${delayMs / 1000}s.`);
    await new Promise((wait) => setTimeout(wait, delayMs));
    delayMs *= 2;
  }
}

if (import.meta.main) {
  await main();
}
