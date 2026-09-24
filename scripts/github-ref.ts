#!/usr/bin/env bun
/**
 * Reads and makes the git refs a release is built on: whether a tag or a branch exists, and
 * creating one.
 *
 * Asked through the REST API with retries rather than through one `gh api` call whose failure is
 * read as "absent". A 503 during GitHub's incident on 2026-09-23 stopped a release being prepared
 * at the branch, and the same answer to the check for a taken tag reads as "free". Only a 404 is
 * absent; anything else is asked again, and named if the last attempt fails too.
 *
 * Creating can be repeated: a ref that already exists at the commit asked for is the ref wanted,
 * so a run retried after its create reached GitHub and the answer did not come back still succeeds.
 *
 * Usage:
 *   bun scripts/github-ref.ts state tags/v1.0.26            prints present or absent
 *   bun scripts/github-ref.ts create heads/release/v1.0.27 <sha>
 */

import process from 'node:process';

export interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/** One request to the API, by path under the host. Throws when nothing came back. */
export type Ask = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<Answer>;

export type Pause = (ms: number) => Promise<void>;

const ATTEMPTS = 5;
const FIRST_PAUSE_MS = 5_000;

/**
 * [param ask] until it answers with something other than a server error or nothing, pausing a
 * little longer each time. What the last attempt got is thrown, so the log says why.
 */
async function answered(ask: () => Promise<Answer>, pause: Pause, doing: string): Promise<Answer> {
  let last = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const answer = await ask();
      if (answer.status < 500) {
        return answer;
      }
      last = `HTTP ${answer.status}: ${JSON.stringify(answer.body)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (attempt < ATTEMPTS) {
      console.error(`${doing}: attempt ${attempt} got ${last}; asking again.`);
      await pause(FIRST_PAUSE_MS * attempt);
    }
  }
  throw new Error(`${doing} failed on all ${ATTEMPTS} attempts; the last got ${last}`);
}

function shaOf(body: unknown): string | null {
  if (body && typeof body === 'object' && 'object' in body) {
    const target = body.object;
    if (target && typeof target === 'object' && 'sha' in target) {
      return typeof target.sha === 'string' ? target.sha : null;
    }
  }
  return null;
}

/** Whether [param ref], such as "tags/v1.0.26", exists in [param repository]. */
export async function refState(
  ask: Ask,
  repository: string,
  ref: string,
  pause: Pause,
): Promise<'present' | 'absent'> {
  const answer = await answered(
    () => ask('GET', `/repos/${repository}/git/ref/${ref}`),
    pause,
    `Reading ${ref}`,
  );
  if (answer.status === 200) {
    return 'present';
  }
  if (answer.status === 404) {
    return 'absent';
  }
  throw new Error(`Reading ${ref} got HTTP ${answer.status}: ${JSON.stringify(answer.body)}`);
}

/**
 * Makes [param ref] point at [param sha], or finds it already does. A ref that exists at another
 * commit is refused, since moving it is not what was asked.
 */
export async function createRef(
  ask: Ask,
  repository: string,
  ref: string,
  sha: string,
  pause: Pause,
): Promise<'created' | 'existed'> {
  const answer = await answered(
    () => ask('POST', `/repos/${repository}/git/refs`, { ref: `refs/${ref}`, sha }),
    pause,
    `Creating ${ref}`,
  );
  if (answer.status === 201) {
    return 'created';
  }
  if (answer.status === 422) {
    const existing = await answered(
      () => ask('GET', `/repos/${repository}/git/ref/${ref}`),
      pause,
      `Reading ${ref}`,
    );
    const at = existing.status === 200 ? shaOf(existing.body) : null;
    if (at === sha) {
      return 'existed';
    }
    throw new Error(`${ref} already exists at ${at ?? 'a commit that could not be read'}, not ${sha}.`);
  }
  throw new Error(`Creating ${ref} got HTTP ${answer.status}: ${JSON.stringify(answer.body)}`);
}

function askGitHub(token: string): Ask {
  return async (method, path, body) => {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Kept as text: an error page from a proxy is still worth printing.
    }
    return { status: response.status, body: parsed };
  };
}

if (import.meta.main) {
  const [command, ref, sha] = process.argv.slice(2);
  const repository = process.env['GH_REPO'] ?? process.env['GITHUB_REPOSITORY'];
  const token = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'];
  if (!repository || !token || !ref || (command !== 'state' && !(command === 'create' && sha))) {
    console.error(
      'Usage: bun scripts/github-ref.ts state <ref> | create <ref> <sha>, with GH_REPO and GH_TOKEN set.',
    );
    process.exit(1);
  }
  const ask = askGitHub(token);
  const pause: Pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    console.log(
      command === 'state'
        ? await refState(ask, repository, ref, pause)
        : await createRef(ask, repository, ref, sha ?? '', pause),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
