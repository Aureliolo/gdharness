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
 * Read off the transport rather than off the absence of findings, because a clean audit and an
 * unreachable one both name no advisory, so "printed nothing" cannot tell them apart.
 *
 * The status code is only read as one on a line that also says `error`, which is narrower than it
 * looks necessary and is not: a package at version 1.502.0 puts a bare `502` between two word
 * boundaries, so a status matched anywhere in the output reads a genuine advisory as an outage and
 * waits it out instead of failing the build. Getting that backwards is the cheap direction; getting
 * the other one backwards ships a release having cleared nothing.
 */
export function serviceDidNotAnswer(output: string): boolean {
  const status = /^.*\berror\b.*?[\s-]\b(?:408|429|5\d\d)\b.*$/im;
  const transport = /ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|socket hang up|fetch failed|network error/i;
  return status.test(output) || transport.test(output);
}

type Attempt =
  | { ran: true; ok: boolean; output: string }
  /** The command itself never started, which is neither a finding nor an outage. */
  | { ran: false; why: string };

function auditOnce(): Attempt {
  const run = spawnSync('bun', ['audit', '--prod'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (run.error !== undefined || run.status === null) {
    return { ran: false, why: run.error?.message ?? `killed by ${run.signal ?? 'an unknown signal'}` };
  }
  return { ran: true, ok: run.status === 0, output: `${run.stdout}${run.stderr}` };
}

async function main(): Promise<void> {
  let delayMs = 5000;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    const tried = auditOnce();
    if (!tried.ran) {
      console.error(`The audit could not be run: ${tried.why}`);
      process.exitCode = 1;
      return;
    }
    const { ok, output } = tried;
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
