/**
 * Where a run spends its time by GDScript function, off the engine's own script profiler.
 *
 * The `servers` profiler (`servers/debugger/servers_debugger.cpp` at 4.7.2) sends each function's
 * name once, as `servers:function_signature` `[name, id]`, and then `servers:profile_frame` every
 * frame: six frame times, a section per server, then five numbers per function called that frame
 * (id, calls, self, total and internal seconds). Its totals, `servers:profile_total`, come only when
 * the profiler is switched off, and never at exit: the profiler is torn down from a destructor where
 * its own switch-off is no longer reached. So the frames are summed here, which also covers a scene
 * that does its work in `_ready` and quits, whose one frame holds everything since the profiler
 * started.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { type DebuggerMessage, DebuggerStream, framedCommand, type GodotValue } from './godot-variant.js';

/** One function's totals, keyed by the signature the engine compiled into it. */
interface FunctionTotals {
  readonly calls: number;
  readonly selfSeconds: number;
  readonly totalSeconds: number;
}

/** What a profile holds, as it is written to disk and handed between processes. */
export interface ProfileTotals {
  /** When the profiler was switched on, in milliseconds since the epoch. */
  readonly startedAt: number;
  /** When the last frame arrived, or null before the first. */
  readonly lastFrameAt: number | null;
  readonly frames: number;
  /**
   * Whether the engine's own totals arrived, which it sends only when the profiler is switched off:
   * by the runtime addon as the game quits, or by the editor's session. Without them the functions
   * are the frames' sum, which misses the game's last frame when it quit.
   */
  readonly complete: boolean;
  readonly functions: Readonly<Record<string, FunctionTotals>>;
  /** Messages that could not be read, which leave a gap the answer has to admit to. */
  readonly unreadable: number;
}

/**
 * A profile file: the listener waiting for the game, or what it has summed since the game connected.
 * Told apart, because a game that never dialled and one that ran no script are different answers.
 */
export type ProfileFile =
  | { readonly connected: false; readonly listeningSince: number }
  | (ProfileTotals & { readonly connected: true });

/** Writes [param file] whole or not at all, so a reader never meets half of one. */
export function writeProfileFile(path: string, file: ProfileFile): void {
  const partial = `${path}.${process.pid}.partial`;
  writeFileSync(partial, JSON.stringify(file), 'utf8');
  renameSync(partial, path);
}

/** The profile at [param path], or null where there is none or it cannot be read. */
export function readProfileFile(path: string): ProfileFile | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ProfileFile;
    return typeof parsed === 'object' && typeof parsed.connected === 'boolean' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * How many functions each frame may carry. The engine sends only the top so many by total time
 * and clamps nothing on the game's side; this is its own buffer's default size
 * (`debug/settings/profiler/max_functions`), so a frame is never cut short of what was called.
 */
const FRAME_FUNCTIONS = 16384;

/** The command that switches the profiler on, as the editor sends it: `[true, [count, native]]`. */
export function profilerOn(): Uint8Array {
  return framedCommand('profiler:servers', [true, [FRAME_FUNCTIONS, false]]);
}

/**
 * [param args] with [param extra] put among the engine's own flags, before the `--` that starts the
 * game's arguments: after it they would be the game's, and the engine would never see them.
 */
export function withEngineArguments(args: readonly string[], extra: readonly string[]): string[] {
  const user = args.indexOf('--');
  return user < 0 ? [...args, ...extra] : [...args.slice(0, user), ...extra, ...args.slice(user)];
}

/** Sums a run's profile frames into totals per function. */
export class ProfileAggregate {
  private readonly names = new Map<number, string>();
  private totals = new Map<string, { calls: number; selfSeconds: number; totalSeconds: number }>();
  private complete = false;
  private frames = 0;
  private lastFrameAt: number | null = null;
  private unreadable = 0;
  private readonly startedAt: number;

  constructor(startedAt: number) {
    this.startedAt = startedAt;
  }

  /** Takes one message from the game; anything that is not the profiler's is left alone. */
  take(received: DebuggerMessage, now: number): void {
    if ('unreadable' in received) {
      this.unreadable += 1;
      return;
    }
    if (received.message === 'servers:function_signature') {
      const [name, id] = received.data;
      if (typeof name === 'string' && typeof id === 'number') {
        this.names.set(id, name);
      }
    } else if (received.message === 'servers:profile_frame') {
      if (this.addFrame(received.data, this.totals)) {
        this.frames += 1;
        this.lastFrameAt = now;
      } else {
        this.unreadable += 1;
      }
    } else if (received.message === 'servers:profile_total') {
      // The engine's own count since the profiler started, so it replaces the frames' sum rather
      // than adding to it: it is what the frames add up to, with nothing lost between them.
      const whole = new Map<string, { calls: number; selfSeconds: number; totalSeconds: number }>();
      if (this.addFrame(received.data, whole)) {
        this.totals = whole;
        this.complete = true;
        this.lastFrameAt = now;
      } else {
        this.unreadable += 1;
      }
    }
  }

  /** Adds one frame's functions into [param into], reading past the servers' section to reach them. */
  private addFrame(
    data: readonly GodotValue[],
    into: Map<string, { calls: number; selfSeconds: number; totalSeconds: number }>,
  ): boolean {
    let at = 6;
    const servers = data[at];
    if (typeof servers !== 'number') {
      return false;
    }
    at += 1;
    for (let server = 0; server < servers; server += 1) {
      const fields = data[at + 1];
      if (typeof fields !== 'number') {
        return false;
      }
      at += 2 + fields;
    }
    const values = data[at];
    if (typeof values !== 'number' || values % 5 !== 0) {
      return false;
    }
    at += 1;
    for (let index = 0; index < values; index += 5) {
      const [id, calls, self, total] = data.slice(at + index, at + index + 4);
      if (
        typeof id !== 'number' ||
        typeof calls !== 'number' ||
        typeof self !== 'number' ||
        typeof total !== 'number'
      ) {
        return false;
      }
      const name = this.names.get(id) ?? `#${id}`;
      const sum = into.get(name) ?? { calls: 0, selfSeconds: 0, totalSeconds: 0 };
      sum.calls += calls;
      sum.selfSeconds += self;
      sum.totalSeconds += total;
      into.set(name, sum);
    }
    return true;
  }

  snapshot(): ProfileTotals {
    return {
      startedAt: this.startedAt,
      lastFrameAt: this.lastFrameAt,
      frames: this.frames,
      complete: this.complete,
      functions: Object.fromEntries(this.totals),
      unreadable: this.unreadable,
    };
  }
}

/** A function as an answer carries it. */
export interface ProfiledFunction {
  readonly script: string;
  readonly function: string;
  /** The line of the function body's first statement, which is what the engine records. */
  readonly line: number;
  readonly calls: number;
  readonly selfMs: number;
  readonly totalMs: number;
}

/**
 * [param signature] split as the GDScript compiler built it: `path::line::Class.function`, with a
 * built-in script's own `::` in its path, so four parts rather than three.
 */
export function signatureParts(signature: string): { script: string; line: number; function: string } {
  const parts = signature.split('::');
  if (parts.length < 3) {
    return { script: '', line: 0, function: signature };
  }
  const name = parts.at(-1) ?? '';
  const line = Number(parts.at(-2));
  return { script: parts.slice(0, -2).join('::'), line: Number.isFinite(line) ? line : 0, function: name };
}

const ms = (seconds: number): number => Math.round(seconds * 1_000_000) / 1000;

/**
 * The functions [param totals] holds, by self time, the [param limit] that took most.
 *
 * A function with no calls is left out. One the profiler started inside is never counted as called,
 * and its time is measured from the engine's start rather than from its own, which would put it at
 * the top of every table with a time longer than the run.
 */
export function profiledFunctions(
  totals: ProfileTotals,
  limit: number,
): { functions: readonly ProfiledFunction[]; omitted: number; scriptMs: number; counted: number } {
  const rows = Object.entries(totals.functions)
    .filter(([, sum]) => sum.calls > 0)
    .map(([signature, sum]): ProfiledFunction => {
      const parts = signatureParts(signature);
      return {
        script: parts.script,
        function: parts.function,
        line: parts.line,
        calls: sum.calls,
        selfMs: ms(sum.selfSeconds),
        totalMs: ms(sum.totalSeconds),
      };
    })
    .sort((a, b) => b.selfMs - a.selfMs || b.totalMs - a.totalMs || a.function.localeCompare(b.function));
  const scriptMs = ms(
    Object.values(totals.functions).reduce((sum, one) => sum + (one.calls > 0 ? one.selfSeconds : 0), 0),
  );
  return {
    functions: rows.slice(0, limit),
    omitted: Math.max(0, rows.length - limit),
    scriptMs,
    counted: rows.length,
  };
}

/**
 * A debugger peer that switches the profiler on as the game connects and sums what it sends.
 *
 * Bound to loopback on a port the system picks, and it takes one connection: the game's, which
 * dials the address it was started with once, at startup, before any script loads. Nothing is sent
 * but the switch, and the game is started with `--skip-breakpoints` and `--ignore-error-breaks`, so
 * it never stops to wait for a debugger that will not answer. A break that happens all the same is
 * answered with `continue`.
 */
export class ProfileListener {
  private connection: Socket | null = null;
  private aggregate: ProfileAggregate | null = null;
  private readonly server: Server;
  readonly port: number;
  private readonly changed: (totals: ProfileTotals) => void;

  private constructor(server: Server, port: number, changed: (totals: ProfileTotals) => void) {
    this.server = server;
    this.port = port;
    this.changed = changed;
  }

  static async open(changed: (totals: ProfileTotals) => void): Promise<ProfileListener> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      throw new Error('the profiler listener has no port');
    }
    const listener = new ProfileListener(server, address.port, changed);
    server.on('connection', (socket) => {
      listener.accept(socket);
    });
    return listener;
  }

  /** The engine arguments that point a game at this listener and keep it from stopping. */
  get engineArguments(): readonly string[] {
    return ['--remote-debug', `tcp://127.0.0.1:${this.port}`, '--skip-breakpoints', '--ignore-error-breaks'];
  }

  private accept(socket: Socket): void {
    if (this.connection !== null) {
      socket.destroy();
      return;
    }
    this.connection = socket;
    // Only the one game ever dials it, and it dials once.
    this.server.close();
    const started = Date.now();
    const aggregate = new ProfileAggregate(started);
    this.aggregate = aggregate;
    const stream = new DebuggerStream();
    socket.write(profilerOn());
    this.changed(aggregate.snapshot());
    socket.on('data', (chunk: Buffer) => {
      let messages: DebuggerMessage[];
      try {
        messages = stream.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      let frames = false;
      for (const received of messages) {
        if ('message' in received && received.message === 'debug_enter') {
          socket.write(framedCommand('continue', []));
        }
        aggregate.take(received, Date.now());
        frames ||=
          'message' in received &&
          (received.message === 'servers:profile_frame' || received.message === 'servers:profile_total');
      }
      if (frames) {
        this.changed(aggregate.snapshot());
      }
    });
    socket.on('error', () => undefined);
  }

  /** What has been summed so far, or null when the game never connected. */
  totals(): ProfileTotals | null {
    return this.aggregate?.snapshot() ?? null;
  }

  close(): void {
    this.connection?.destroy();
    this.server.close();
  }
}
