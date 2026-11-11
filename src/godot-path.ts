/**
 * Where the engine is, and whether a path is one. GODOT_PATH when it is set, else the first
 * conventional location that is an engine. Nothing is guessed, because a guessed path is a tool
 * that fails later with a message about the wrong thing.
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, normalize, resolve } from 'node:path';
import { godotCandidates, resolveHomeDirectory } from './detection.js';
import { versionPrinted } from './engine-launch.js';
import { errorMessage } from './errors.js';
import { envValue } from './launch.js';
import { plainEngineOf } from './process-children.js';
import { runHidden as run } from './spawn.js';
import { engineSaid } from './suite-run.js';

/**
 * Whether a path is an engine: the program judged and the version it printed, or the path as it
 * was named and why it is none.
 */
export type Judged =
  | { readonly ok: true; readonly path: string; readonly version: string }
  | { readonly ok: false; readonly named: string; readonly reason: string };

/**
 * The engine, or why there is none, which is two answers and not one.
 *
 * A GODOT_PATH that names something which is no engine is a configuration to fix, and nothing
 * else on the machine is consulted, because running some other engine in silence would be worse.
 * Nothing set and nothing found is a machine with no engine on it. Both used to arrive as null and
 * so as one sentence, "No Godot executable found. Set GODOT_PATH", which told somebody who had set
 * it to set it, and never named the path they had set or what was wrong with it.
 */
export type Located =
  | { readonly ok: true; readonly path: string; readonly version: string }
  | { readonly ok: false; readonly named: string; readonly reason: string }
  | { readonly ok: false; readonly named: null };

/** How many times a start that crashes is tried in all before the path is called one that does not start. */
export const VERSION_STARTS = 5;
/** How long a `--version` start may run. A real engine on a loaded machine has taken most of a minute. */
export const VERSION_ANSWER_MS = 60_000;
/** The wait before the second start, doubled before each one after it. */
const FIRST_RETRY_MS = 500;
/** How much of what a failing start printed a reason quotes. */
const QUOTED_CHARACTERS = 300;

/** How one `--version` start went. */
type VersionStart =
  | { readonly kind: 'answered' }
  | { readonly kind: 'crashed'; readonly said: string }
  | { readonly kind: 'hung'; readonly said: string }
  | { readonly kind: 'refused'; readonly said: string };

/** What a path's starts came to, and whether that is final. */
interface Asked {
  readonly final: boolean;
  readonly answer:
    | { readonly ok: true; readonly version: string }
    | { readonly ok: false; readonly reason: string };
}

/** [param text] as a reason quotes it. */
function quotedOf(text: string): string {
  const printed = text.trim();
  return printed.length > QUOTED_CHARACTERS ? `${printed.slice(0, QUOTED_CHARACTERS)}...` : printed;
}

/** [param ms] as a limit a reason names. */
function limitSaid(ms: number): string {
  return ms % 1000 === 0 ? `${String(ms / 1000)} seconds` : `${String(ms)} ms`;
}

/**
 * How the `--version` start that threw [param error] went. A start ended at its limit is a hang. A
 * Windows exception code, a signal, or a failing exit with nothing printed is the engine crashing
 * as it starts, which a loaded machine makes Godot do now and then (0xC06D007F, a race in its input
 * library's hook). Output with a failing exit, or a program that cannot be started at all, is an
 * answer.
 */
export function versionStartOf(error: unknown): VersionStart {
  const failed = (error ?? {}) as {
    code?: unknown;
    signal?: unknown;
    killed?: unknown;
    stdout?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  const printed = [failed.stdout, failed.stderr]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
    .trim();
  const quoted = quotedOf(printed);
  const output = quoted === '' ? ' and printed nothing' : ` and printed ${JSON.stringify(quoted)}`;
  if (failed.killed === true) {
    const signal = typeof failed.signal === 'string' ? failed.signal : 'a signal';
    return { kind: 'hung', said: `it was ended by ${signal}${output}` };
  }
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
  /** What a build said, by the build (see `engineSaid`). Only a final answer is kept. */
  private readonly kept = new Map<string, Asked['answer']>();
  /** The starts under way, so callers judging one path share them. */
  private readonly asking = new Map<string, Promise<Asked>>();
  private found: Extract<Judged, { readonly ok: true }> | null = null;
  private own: string | null = null;
  private readonly start: (path: string, limitMs: number) => Promise<{ readonly stdout: string }>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly answerMs: number;
  private readonly platform: NodeJS.Platform;

  constructor(
    the: {
      readonly start?: (path: string, limitMs: number) => Promise<{ readonly stdout: string }>;
      readonly sleep?: (ms: number) => Promise<void>;
      readonly answerMs?: number;
      readonly platform?: NodeJS.Platform;
    } = {},
  ) {
    this.start = the.start ?? ((path, limitMs) => run(path, ['--version'], { timeout: limitMs }));
    this.sleep =
      the.sleep ??
      ((ms) =>
        new Promise((done) => {
          setTimeout(done, ms);
        }));
    this.answerMs = the.answerMs ?? VERSION_ANSWER_MS;
    this.platform = the.platform ?? process.platform;
  }

  /** The version [method find] last answered with, read without a start. */
  ownVersion(): string | null {
    return this.own;
  }

  /**
   * The engine to run. Callers judging one path share its start, so a tool called during the
   * server's own first search starts no second engine.
   */
  async find(): Promise<Located> {
    if (this.found !== null) {
      const again = await this.judge(this.found.path);
      if (again.ok) {
        return this.taken(again);
      }
      this.found = null;
    }

    const named = envValue('GODOT_PATH');
    if (named !== undefined) {
      // Made whole against the directory this process runs in, since the desktop helper starting a
      // windowed engine runs in another, where a relative path names nothing. Bare godot is the one
      // name looked up on PATH. An absolute one is kept as written, since setup writes it into the
      // harness config and resolving respells D:/ as D:\ there.
      const judged = await this.judge(named === 'godot' || isAbsolute(named) ? named : resolve(named));
      return judged.ok ? this.taken(judged) : judged;
    }

    for (const candidate of godotCandidates(process.platform, resolveHomeDirectory())) {
      const judged = await this.judge(normalize(candidate));
      if (judged.ok) {
        return this.taken(judged);
      }
    }
    return { ok: false, named: null };
  }

  private taken(judged: Extract<Judged, { readonly ok: true }>): Located {
    this.found = judged;
    this.own = judged.version;
    return judged;
  }

  /**
   * Whether [param path] is an engine: its version, or why not. On Windows a console wrapper is
   * judged as the plain program beside it, which is the engine its child would be.
   */
  async judge(path: string): Promise<Judged> {
    const plain = plainEngineOf(path);
    const program = this.platform === 'win32' && plain !== path && existsSync(plain) ? plain : path;
    const asked = await this.asked(program);
    if (asked.ok) {
      return { ok: true, path: program, version: asked.version };
    }
    return {
      ok: false,
      named: path,
      reason:
        program === path
          ? asked.reason
          : `is Godot's console wrapper, and the engine beside it, ${program}, ${asked.reason}`,
    };
  }

  private async asked(program: string): Promise<Asked['answer']> {
    // The file system is asked each time and never remembered, because an engine installed after the
    // server started, or deleted since it was found, changes the answer.
    const bare = program === 'godot';
    if (!bare) {
      if (!existsSync(program)) {
        return { ok: false, reason: 'does not exist' };
      }
      if (statSync(program).isDirectory()) {
        return { ok: false, reason: 'is a folder, not a program' };
      }
    }
    // A bare name is looked up on PATH by the system alone, so what it prints is never remembered.
    let build: string | null = null;
    if (!bare) {
      try {
        build = engineSaid(program);
      } catch {
        build = null;
      }
    }
    const known = build === null ? undefined : this.kept.get(build);
    if (known !== undefined) {
      return known;
    }
    const shared = build ?? (bare ? program : null);
    const going = shared === null ? undefined : this.asking.get(shared);
    if (going !== undefined) {
      return (await going).answer;
    }
    const starting = this.ask(program);
    if (shared !== null) {
      this.asking.set(shared, starting);
    }
    try {
      const asked = await starting;
      if (asked.final && build !== null) {
        this.kept.set(build, asked.answer);
      }
      return asked.answer;
    } finally {
      if (shared !== null && this.asking.get(shared) === starting) {
        this.asking.delete(shared);
      }
    }
  }

  private async ask(program: string): Promise<Asked> {
    let crashed = '';
    for (let started = 1; started <= VERSION_STARTS; started += 1) {
      if (started > 1) {
        await this.sleep(FIRST_RETRY_MS * 2 ** (started - 2));
      }
      let went: VersionStart;
      try {
        const { stdout } = await this.start(program, this.answerMs);
        const version = versionPrinted(stdout);
        if (version === null) {
          const printed = quotedOf(stdout);
          return {
            final: true,
            answer: {
              ok: false,
              reason: `is not a Godot engine: --version printed ${printed === '' ? 'nothing' : JSON.stringify(printed)}`,
            },
          };
        }
        return { final: true, answer: { ok: true, version } };
      } catch (error) {
        went = versionStartOf(error);
      }
      if (went.kind === 'hung') {
        return {
          final: false,
          answer: {
            ok: false,
            reason: `was still running ${limitSaid(this.answerMs)} after its --version start`,
          },
        };
      }
      if (went.kind === 'refused') {
        return { final: true, answer: { ok: false, reason: `does not answer --version: ${went.said}` } };
      }
      if (went.kind === 'crashed') {
        crashed = went.said;
      }
    }
    return {
      final: false,
      answer: {
        ok: false,
        reason: `crashed on each of ${String(VERSION_STARTS)} starts with --version, the last time ${crashed}`,
      },
    };
  }

  /**
   * The sentence for a path that is no engine, and what to do about it. [param by] names where the
   * path came from when that is not GODOT_PATH: a call's argument, or the harness config of a project.
   */
  static refusal(failed: Extract<Located, { readonly ok: false }>): {
    readonly message: string;
    readonly advice: readonly string[];
  };
  static refusal(
    failed: Extract<Judged, { readonly ok: false }>,
    by: { readonly argument: string } | { readonly config: string },
  ): { readonly message: string; readonly advice: readonly string[] };
  static refusal(
    failed: Extract<Located, { readonly ok: false }>,
    by?: { readonly argument: string } | { readonly config: string },
  ): { readonly message: string; readonly advice: readonly string[] } {
    if (failed.named === null) {
      return {
        message: 'No Godot executable found.',
        advice: [
          'Set GODOT_PATH to a Godot 4.7 or newer executable',
          'Or install Godot where it is usually found, such as /usr/bin/godot or C:\\Program Files\\Godot',
        ],
      };
    }
    if (by !== undefined && 'argument' in by) {
      return {
        message: `${by.argument} names ${failed.named}, which ${failed.reason}.`,
        advice: [
          `Point ${by.argument} at a Godot 4.7 or newer executable that answers --version`,
          `Or leave ${by.argument} out, and the engine gdharness finds is used`,
        ],
      };
    }
    if (by !== undefined) {
      return {
        message: `The harness config of ${by.config} names ${failed.named} under GODOT_PATH, which ${failed.reason}.`,
        advice: [
          'Point GODOT_PATH in that config at a Godot 4.7 or newer executable that answers --version',
          'Or remove it from the config, and the engine gdharness finds is used',
        ],
      };
    }
    return {
      message: `GODOT_PATH is set to ${failed.named}, which ${failed.reason}.`,
      advice: [
        'Point GODOT_PATH at a Godot 4.7 or newer executable that answers --version',
        'Or unset it, and the usual install locations are searched instead',
      ],
    };
  }
}
