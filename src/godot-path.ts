/**
 * Where the engine is. GODOT_PATH when it is set, else the first conventional location that
 * answers `--version`. Nothing is guessed, because a guessed path is a tool that fails later
 * with a message about the wrong thing.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';
import { godotCandidates, resolveHomeDirectory } from './detection.js';
import { errorMessage } from './errors.js';
import { envValue } from './launch.js';
import { runHidden as run } from './spawn.js';

/**
 * The engine, or why there is none, which is two answers and not one.
 *
 * A GODOT_PATH that names something which does not answer is a configuration to fix, and nothing
 * else on the machine is consulted, because running some other engine in silence would be worse.
 * Nothing set and nothing found is a machine with no engine on it. Both used to arrive as null and
 * so as one sentence, "No Godot executable found. Set GODOT_PATH", which told somebody who had set
 * it to set it, and never named the path they had set or what was wrong with it.
 */
export type Located =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly named: string; readonly reason: string }
  | { readonly ok: false; readonly named: null };

/** How many times a start that crashes is tried in all before the path is called one that does not start. */
export const VERSION_STARTS = 5;
/** The wait before the second start, doubled before each one after it. */
const FIRST_RETRY_MS = 500;
/** How much of what a failing start printed a reason quotes. */
const QUOTED_CHARACTERS = 300;

/** How one `--version` start went. */
type VersionStart =
  | { readonly kind: 'answered' }
  | { readonly kind: 'crashed'; readonly said: string }
  | { readonly kind: 'refused'; readonly said: string };

/**
 * How the `--version` start that threw [param error] went. A Windows exception code, a signal, or a
 * failing exit with nothing printed is the engine crashing as it starts, which a loaded machine
 * makes Godot do now and then (0xC06D007F, a race in its input library's hook). Output with a
 * failing exit, or a program that cannot be started at all, is an answer.
 */
export function versionStartOf(error: unknown): VersionStart {
  const failed = (error ?? {}) as {
    code?: unknown;
    signal?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  const printed = [failed.stdout, failed.stderr]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
    .trim();
  const quoted = printed.length > QUOTED_CHARACTERS ? `${printed.slice(0, QUOTED_CHARACTERS)}...` : printed;
  const output = quoted === '' ? ' and printed nothing' : ` and printed ${JSON.stringify(quoted)}`;
  if (typeof failed.signal === 'string') {
    return { kind: 'crashed', said: `it was ended by ${failed.signal}${output}` };
  }
  if (typeof failed.code !== 'number') {
    return { kind: 'refused', said: `it could not be started: ${errorMessage(error)}` };
  }
  const code = failed.code >>> 0;
  const exception = code >= 0xc0000000;
  const said = `it exited ${exception ? `0x${code.toString(16).toUpperCase()}` : String(failed.code)}${output}`;
  return exception || printed === '' ? { kind: 'crashed', said } : { kind: 'refused', said };
}

export class GodotLocator {
  /** Why a path does not answer, or null for one that does. A path that only crashed is asked again. */
  private readonly answered = new Map<string, string | null>();
  private found: string | null = null;
  private readonly start: (path: string) => Promise<unknown>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    start: (path: string) => Promise<unknown> = (path) => run(path, ['--version']),
    sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((done) => {
        setTimeout(done, ms);
      }),
  ) {
    this.start = start;
    this.sleep = sleep;
  }

  async find(): Promise<Located> {
    if (this.found !== null && (await this.whyNot(this.found)) === null) {
      return { ok: true, path: this.found };
    }
    this.found = null;

    const named = envValue('GODOT_PATH');
    if (named !== undefined) {
      // Made whole against the directory this process runs in, since the desktop helper starting a
      // windowed engine runs in another, where a relative path names nothing. Bare godot is the one
      // name looked up on PATH. An absolute one is kept as written, since setup writes it into the
      // harness config and resolving respells D:/ as D:\ there.
      const path = named === 'godot' || isAbsolute(named) ? named : resolve(named);
      const reason = await this.whyNot(path);
      if (reason === null) {
        this.found = path;
        return { ok: true, path };
      }
      return { ok: false, named: path, reason };
    }

    for (const candidate of godotCandidates(process.platform, resolveHomeDirectory())) {
      const path = normalize(candidate);
      if ((await this.whyNot(path)) === null) {
        this.found = path;
        return { ok: true, path };
      }
    }
    return { ok: false, named: null };
  }

  /** The sentence for a locator that found nothing, and what to do about it. */
  static refusal(located: { readonly ok: false; readonly named: string | null; readonly reason?: string }): {
    readonly message: string;
    readonly advice: readonly string[];
  } {
    if (located.named === null) {
      return {
        message: 'No Godot executable found.',
        advice: [
          'Set GODOT_PATH to a Godot 4.7 or newer executable',
          'Or install Godot where it is usually found, such as /usr/bin/godot or C:\\Program Files\\Godot',
        ],
      };
    }
    return {
      message: `GODOT_PATH is set to ${located.named}, which ${located.reason ?? 'does not answer'}.`,
      advice: [
        'Point GODOT_PATH at a Godot 4.7 or newer executable that answers --version',
        'Or unset it, and the usual install locations are searched instead',
      ],
    };
  }

  /** Why [param path] is not an engine that answers, or null because it is. */
  private async whyNot(path: string): Promise<string | null> {
    const known = this.answered.get(path);
    if (known !== undefined) {
      return known;
    }
    if (path !== 'godot' && !existsSync(path)) {
      this.answered.set(path, 'does not exist');
      return 'does not exist';
    }
    let crashed = '';
    for (let started = 1; started <= VERSION_STARTS; started += 1) {
      if (started > 1) {
        await this.sleep(FIRST_RETRY_MS * 2 ** (started - 2));
      }
      let went: VersionStart;
      try {
        await this.start(path);
        went = { kind: 'answered' };
      } catch (error) {
        went = versionStartOf(error);
      }
      if (went.kind === 'answered') {
        this.answered.set(path, null);
        return null;
      }
      if (went.kind === 'refused') {
        const reason = `does not answer --version: ${went.said}`;
        this.answered.set(path, reason);
        return reason;
      }
      crashed = went.said;
    }
    return `crashed on each of ${String(VERSION_STARTS)} starts with --version, the last time ${crashed}`;
  }
}
