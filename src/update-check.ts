/**
 * Whether a newer gdharness has been published, asked in the background and never in the way.
 *
 * The registry is the only thing this talks to and a version string is the only thing it reads
 * back. Nothing about the project, the machine or the session leaves here, and a check that
 * fails or hangs costs a tool call nothing: the answer it would have carried lands on whichever
 * call comes after it instead.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentRunner, runLine } from './runner.js';

/** Only this host, only https, and nothing built from anything a caller supplies. */
const REGISTRY = 'https://registry.npmjs.org/gdharness/latest';

/** Where a release's notes are, which is what an agent should read before recommending one. */
const RELEASES = 'https://github.com/Aureliolo/gdharness/releases/tag';

/** How long an answer stands before it is worth asking again. */
const CACHE_MS = 4 * 60 * 60 * 1000;

/** A registry that answers slowly is one this waits out rather than lets build up. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * A cap on the body, because the size of what a host sends is the host's choice, not ours.
 * The document this reads is a few kilobytes.
 */
const MAX_BODY_BYTES = 1 << 20;

const FIRST_RETRY_MS = 30_000;
const MAX_RETRY_MS = 60 * 60 * 1000;

/** Semantic versions only: anything else is a registry answering something this cannot judge. */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface UpdateNotice {
  readonly current: string;
  readonly latest: string;
  readonly releaseNotes: string;
  readonly upgrade: string;
}

interface Cached {
  readonly checkedAt: number;
  readonly latest: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

/** The per-user cache directory each platform keeps for exactly this. */
function cacheDirectory(environment: Environment): string {
  const set = (name: string): string | null => {
    const value = environment[name];
    return value !== undefined && value !== '' ? value : null;
  };
  const home = set('HOME') ?? homedir();
  if (process.platform === 'win32') {
    return join(set('LOCALAPPDATA') ?? home, 'gdharness');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Caches', 'gdharness');
  }
  return join(set('XDG_CACHE_HOME') ?? join(home, '.cache'), 'gdharness');
}

/** Where the answer is kept between runs, so a restart does not mean another request. */
export function cacheFile(environment: Environment = process.env): string {
  // A home directory is not guaranteed to exist under a service account, and a cache is the one
  // thing that may live in a temporary directory: losing it costs one extra request.
  try {
    const directory = cacheDirectory(environment);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return join(directory, 'update-check.json');
  } catch {
    return join(tmpdir(), 'gdharness-update-check.json');
  }
}

function readCache(path: string): Cached | null {
  try {
    if (!existsSync(path)) {
      return null;
    }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const checkedAt = record['checkedAt'];
    const latest = record['latest'];
    if (typeof checkedAt !== 'number' || typeof latest !== 'string' || !VERSION.test(latest)) {
      return null;
    }
    return { checkedAt, latest };
  } catch {
    return null;
  }
}

function writeCache(path: string, entry: Cached): void {
  try {
    writeFileSync(path, JSON.stringify(entry), { encoding: 'utf8', mode: 0o600 });
  } catch {
    // A cache that cannot be written costs a request per check, which is not worth an error.
  }
}

/** Build metadata is not part of the ordering, and a prerelease sorts below its own version. */
function parts(version: string): { numbers: number[]; prerelease: boolean } {
  const withoutBuild = version.split('+')[0] ?? version;
  const dash = withoutBuild.indexOf('-');
  const numeric = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  return {
    numbers: numeric.split('.').map((piece) => Number.parseInt(piece, 10) || 0),
    prerelease: dash !== -1,
  };
}

/** Whether the registry is offering something this server is behind. */
export function isNewer(candidate: string, current: string): boolean {
  const left = parts(candidate);
  const right = parts(current);
  for (let index = 0; index < 3; index += 1) {
    const a = left.numbers[index] ?? 0;
    const b = right.numbers[index] ?? 0;
    if (a !== b) {
      return a > b;
    }
  }
  return !left.prerelease && right.prerelease;
}

/** The published version, or null when the registry did not answer with one this can trust. */
async function fetchLatest(): Promise<string | null> {
  const response = await fetch(REGISTRY, {
    // The abbreviated document, which is what a client that only wants a version should ask for.
    headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok || response.body === null) {
    return null;
  }
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return null;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      return null;
    }
    chunks.push(chunk);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const version = (parsed as Record<string, unknown>)['version'];
  return typeof version === 'string' && VERSION.test(version) ? version : null;
}

/**
 * The check, as something a tool call can start and walk away from.
 *
 * One at a time: a call arriving while a check is in flight leaves it alone rather than starting
 * a second. A failure is never given up on, but it is retried on a window that doubles to an
 * hour, so a registry that is down is asked once an hour rather than on every tool call. There
 * is no timer behind any of it: the next tool call is what starts a check, so a session left
 * open overnight makes no requests until somebody uses it again.
 */
export class UpdateCheck {
  private latest: string | null = null;
  private checking = false;
  private checkedAt = 0;
  private retryAt = 0;
  private backoffMs = FIRST_RETRY_MS;
  private readonly enabled: boolean;
  private readonly current: string;
  private readonly cachePath: string;

  constructor(current: string, environment: Environment = process.env) {
    this.current = current;
    this.enabled = (environment['GDHARNESS_NO_UPDATE_CHECK'] ?? '') === '';
    this.cachePath = cacheFile(environment);
    // Off means off, not "ask nothing but go on repeating the last answer": a cache left behind
    // by a session before the switch was set would otherwise still be reported.
    const cached = this.enabled ? readCache(this.cachePath) : null;
    if (cached !== null) {
      this.latest = cached.latest;
      this.checkedAt = cached.checkedAt;
    }
  }

  /**
   * Starts a check if the answer in hand has gone stale, and returns immediately.
   *
   * Called from a tool call, which is what makes this "only while the server is being used":
   * a session left open overnight asks nothing until somebody calls a tool again.
   */
  refresh(now = Date.now()): void {
    if (!this.enabled || this.checking || now < this.retryAt || now - this.checkedAt < CACHE_MS) {
      return;
    }
    this.checking = true;
    void fetchLatest()
      .then((version) => {
        if (version === null) {
          this.scheduleRetry(now);
          return;
        }
        this.latest = version;
        this.checkedAt = Date.now();
        this.backoffMs = FIRST_RETRY_MS;
        this.retryAt = 0;
        writeCache(this.cachePath, { checkedAt: this.checkedAt, latest: version });
      })
      .catch(() => {
        this.scheduleRetry(now);
      })
      .finally(() => {
        this.checking = false;
      });
  }

  private scheduleRetry(now: number): void {
    this.retryAt = now + this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_RETRY_MS);
  }

  /** What to tell the agent, or null when this is the newest there is. */
  notice(now = Date.now()): UpdateNotice | null {
    const latest = this.latest;
    if (!this.enabled || latest === null || !isNewer(latest, this.current)) {
      return null;
    }
    // Not an answer this has already judged too old to use. `refresh()` runs first on the same
    // call and starts a fetch precisely because the window has passed, so naming the version here
    // hands out something known stale together with an upgrade command for it. A server that had
    // just restarted read a note left hours earlier by a previous process and told its first
    // caller to install a version and a half behind; the call after that named the right one.
    //
    // Only while a fetch is actually in flight. A failed one backs off and leaves `checking`
    // false, and then this reports what it has again, because offline and behind is still worth
    // saying and silence would be permanent.
    if (this.checking && now - this.checkedAt >= CACHE_MS) {
      return null;
    }
    return {
      current: this.current,
      latest,
      releaseNotes: `${RELEASES}/v${latest}`,
      // Under whichever runner is running us, and with no path on it: somebody who installed with
      // bunx may have no Node at all, and upgrade takes the directory it is run in.
      upgrade: runLine(currentRunner(), latest, 'upgrade'),
    };
  }
}
