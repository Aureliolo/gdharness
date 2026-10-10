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
import {
  bodyCallsSuper,
  type CallSite,
  type ClassBody,
  callSitesOf,
  codeOf,
  enclosingFunction,
  shapeOf,
} from './gdscript-source.js';
import { type DebuggerMessage, DebuggerStream, framedCommand, type GodotValue } from './godot-variant.js';
import { parseProjectGodot } from './resources.js';

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
  /**
   * The most functions the profiler was asked to send in one frame, how many frames carried that
   * many, and whether the engine's totals did: each leaves out the functions with the least time in
   * it. Absent from a file written by a keeper older than the cap.
   */
  readonly frameFunctions?: number;
  readonly cappedFrames?: number;
  readonly totalCapped?: boolean;
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

/** Where a project sizes its game's outgoing debugger queue, and the engine's default for it. */
const QUEUE_SETTING = 'limits/debugger/max_queued_messages';
const QUEUE_DEFAULT = 2048;

/** Room left in the queue beside a frame's names: the frame itself, and whatever else is sent then. */
const QUEUE_HEADROOM = 512;

/**
 * How many functions each frame may carry, for a game whose debugger queue holds [param queued]
 * messages. The engine names a function once, as it first appears, in a message of its own sent
 * with the frame, and queues every one of them at once; past the queue's size it drops them and
 * never names those functions again, so 3000 functions called in one frame came back with 956 of
 * them as bare numbers, and the frame or the totals queued after the names can go the same way. It
 * sends a frame's functions by total time, so the cap leaves out the ones that took least, which a
 * later frame can still name.
 */
export function frameFunctionsFor(queued: number): number {
  return Math.max(64, queued - QUEUE_HEADROOM);
}

/** The debugger queue size [param projectGodot] sets for its game, or the engine's default. */
export function queuedMessagesOf(projectGodot: string | null): number {
  const set = projectGodot === null ? undefined : parseProjectGodot(projectGodot)['network']?.[QUEUE_SETTING];
  return typeof set === 'number' && Number.isInteger(set) && set > 0 ? set : QUEUE_DEFAULT;
}

/**
 * What a quitting game sends after its profile's totals, and the answer it waits for before it
 * exits: its debugger thread stops without emptying its queue, so without the answer the totals
 * could go down with the process. Kept in step with the runtime addon's `runtime_autoload.gd`.
 */
const PROFILE_SENT = 'gdharness:profile_sent';
const PROFILE_RECEIVED = 'gdharness:profile_received';

/** What a function is called when its name never arrived: `#` and the number the engine gave it. */
export const UNNAMED_PREFIX = '#';

/** The command that switches the profiler on, as the editor sends it: `[true, [count, native]]`. */
export function profilerOn(frameFunctions: number): Uint8Array {
  return framedCommand('profiler:servers', [true, [frameFunctions, false]]);
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
  private cappedFrames = 0;
  private totalCapped = false;
  private readonly startedAt: number;
  private readonly frameFunctions: number;

  constructor(startedAt: number, frameFunctions: number) {
    this.startedAt = startedAt;
    this.frameFunctions = frameFunctions;
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
      const carried = this.addFrame(received.data, this.totals);
      if (carried === null) {
        this.unreadable += 1;
      } else {
        this.frames += 1;
        this.lastFrameAt = now;
        this.cappedFrames += carried >= this.frameFunctions ? 1 : 0;
      }
    } else if (received.message === 'servers:profile_total') {
      // The engine's own count since the profiler started, so it replaces the frames' sum rather
      // than adding to it: it is what the frames add up to, with nothing lost between them.
      const whole = new Map<string, { calls: number; selfSeconds: number; totalSeconds: number }>();
      const carried = this.addFrame(received.data, whole);
      if (carried === null) {
        this.unreadable += 1;
      } else {
        this.totals = whole;
        this.complete = true;
        this.lastFrameAt = now;
        this.totalCapped = carried >= this.frameFunctions;
      }
    }
  }

  /**
   * Adds one frame's functions into [param into], reading past the servers' section to reach them,
   * and answers how many it carried, or null for a frame that could not be read.
   */
  private addFrame(
    data: readonly GodotValue[],
    into: Map<string, { calls: number; selfSeconds: number; totalSeconds: number }>,
  ): number | null {
    let at = 6;
    const servers = data[at];
    if (typeof servers !== 'number') {
      return null;
    }
    at += 1;
    for (let server = 0; server < servers; server += 1) {
      const fields = data[at + 1];
      if (typeof fields !== 'number') {
        return null;
      }
      at += 2 + fields;
    }
    const values = data[at];
    if (typeof values !== 'number' || values % 5 !== 0) {
      return null;
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
        return null;
      }
      const name = this.names.get(id) ?? `${UNNAMED_PREFIX}${id}`;
      const sum = into.get(name) ?? { calls: 0, selfSeconds: 0, totalSeconds: 0 };
      sum.calls += calls;
      sum.selfSeconds += self;
      sum.totalSeconds += total;
      into.set(name, sum);
    }
    return values / 5;
  }

  snapshot(): ProfileTotals {
    return {
      startedAt: this.startedAt,
      lastFrameAt: this.lastFrameAt,
      frames: this.frames,
      complete: this.complete,
      functions: Object.fromEntries(this.totals),
      unreadable: this.unreadable,
      frameFunctions: this.frameFunctions,
      cappedFrames: this.cappedFrames,
      totalCapped: this.totalCapped,
    };
  }
}

/** A function as an answer carries it. */
export interface ProfiledFunction {
  readonly script: string;
  readonly function: string;
  /** The line of the function body's first statement, which is what the engine records. */
  readonly line: number;
  /** For a lambda, the named function it is written in, read off the script's source. */
  readonly within?: string;
  readonly calls: number;
  readonly selfMs: number;
  readonly totalMs: number;
  /**
   * True for a function that calls through `super`, whose selfMs then holds what that call took.
   * The engine takes every other call a script function makes out of its self time, but its opcode
   * for a super call (`OPCODE_CALL_SELF_BASE` in `gdscript_vm.cpp` at 4.7.2) is not timed, so the
   * overridden function's time is in its own row and again in this one.
   */
  readonly selfIncludesSuper?: true;
}

/** A script's source by its `res://` path, or null when it cannot be read. */
export type SourceOf = (script: string) => string | null;

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
  sourceOf: SourceOf = () => null,
): {
  functions: readonly ProfiledFunction[];
  omitted: number;
  scriptMs: number;
  counted: number;
  superCallers: number;
} {
  const rows = rowsOf(totals, sourceOf);
  const scriptMs = ms(
    Object.values(totals.functions).reduce((sum, one) => sum + (one.calls > 0 ? one.selfSeconds : 0), 0),
  );
  return {
    functions: rows.slice(0, limit).map((row) => placedLambda(row, sourceOf)),
    omitted: Math.max(0, rows.length - limit),
    scriptMs,
    counted: rows.length,
    superCallers: rows.filter((row) => row.selfIncludesSuper === true).length,
  };
}

/** Every function [param totals] counts a call of, by self time, each marked if it calls super. */
function rowsOf(totals: ProfileTotals, sourceOf: SourceOf): ProfiledFunction[] {
  const codes = new Map<string, string | null>();
  const codeOfScript = (script: string): string | null => {
    if (!codes.has(script)) {
      const source = sourceOf(script);
      codes.set(script, source === null ? null : codeOf(source));
    }
    return codes.get(script) ?? null;
  };
  return Object.entries(totals.functions)
    .filter(([, sum]) => sum.calls > 0)
    .map(([signature, sum]): ProfiledFunction => {
      const parts = signatureParts(signature);
      const code = codeOfScript(parts.script);
      return {
        script: parts.script,
        function: parts.function,
        line: parts.line,
        calls: sum.calls,
        selfMs: ms(sum.selfSeconds),
        totalMs: ms(sum.totalSeconds),
        ...(code !== null && bodyCallsSuper(code, parts.line, parts.function.endsWith('(lambda)'))
          ? { selfIncludesSuper: true as const }
          : {}),
      };
    })
    .sort((a, b) => b.selfMs - a.selfMs || b.totalMs - a.totalMs || a.function.localeCompare(b.function));
}

/** A function's own name, without the class the compiler puts in front of it. */
function bareName(fn: string): string {
  return fn.slice(fn.lastIndexOf('.') + 1);
}

/**
 * [param row] with the function it is written in, when it is a lambda. The compiler names a lambda
 * `Class.name(lambda)`, and every anonymous one `Class.<anonymous lambda>(lambda)`, so ten of them
 * in one class read alike, and the line alone sends a reader to the file.
 */
function placedLambda(row: ProfiledFunction, sourceOf: SourceOf): ProfiledFunction {
  if (!row.function.endsWith('(lambda)')) {
    return row;
  }
  const source = sourceOf(row.script);
  const within = source === null ? null : enclosingFunction(source, row.line);
  return within === null ? row : { ...row, within };
}

/** A place that names the function asked about, with the profile's row for the function it is in. */
export interface ProfiledCallSite extends CallSite {
  readonly script: string;
  /** The profile's numbers for `within`, absent when it made no counted call. */
  readonly withinCalls?: number;
  readonly withinSelfMs?: number;
  readonly withinTotalMs?: number;
  /** As `selfIncludesSuper` on the function's own row. */
  readonly withinSelfIncludesSuper?: true;
}

/** The classes [param source] declares by name: its class_name and its inner classes, nested. */
function classNamesOf(source: string): string[] {
  const shape = shapeOf(source);
  const inner = (body: ClassBody): string[] =>
    body.inner.flatMap((one) => [...(one.name === null ? [] : [one.name]), ...inner(one)]);
  return [...(shape.className === null ? [] : [shape.className.name]), ...inner(shape.body)];
}

/** How many places a callers answer lists before saying how many more there were. */
const CALL_SITES = 40;

/**
 * Where the project's scripts name [param name], each with the profile's numbers for the function
 * it is written in, those that took the most time first. [param name] is a function's own name, or
 * `Class.name` to pick out the rows of one class.
 *
 * Found by name in the source, because the engine's profiler counts calls and time per function and
 * records nothing about who made them. A place is a caller only if the name there is this function:
 * a method of the same name on another class is found as well, which the answer says, except one
 * called through another class the project declares by name when one class was asked about.
 */
export function callersOf(
  totals: ProfileTotals,
  name: string,
  scripts: Iterable<readonly [script: string, source: string]>,
): { target: readonly ProfiledFunction[]; sites: readonly ProfiledCallSite[]; omitted: number } {
  const listed = [...scripts];
  const sources = new Map(listed);
  const rows = rowsOf(totals, (script) => sources.get(script) ?? null);
  const bare = bareName(name);
  const target = rows.filter((row) =>
    name.includes('.') ? row.function === name : bareName(row.function) === bare,
  );
  const asked = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : null;
  const otherClasses = new Set<string>();
  if (asked !== null) {
    for (const [, source] of listed) {
      for (const declared of classNamesOf(source)) {
        if (declared !== asked) {
          otherClasses.add(declared);
        }
      }
    }
  }
  const sites: ProfiledCallSite[] = [];
  for (const [script, source] of listed) {
    for (const site of callSitesOf(source, bare, otherClasses)) {
      const within =
        site.within === null
          ? undefined
          : rows.find((row) => row.script === script && bareName(row.function) === site.within);
      sites.push({
        script,
        ...site,
        ...(within === undefined
          ? {}
          : {
              withinCalls: within.calls,
              withinSelfMs: within.selfMs,
              withinTotalMs: within.totalMs,
              ...(within.selfIncludesSuper === true ? { withinSelfIncludesSuper: true as const } : {}),
            }),
      });
    }
  }
  sites.sort(
    (a, b) =>
      (b.withinTotalMs ?? -1) - (a.withinTotalMs ?? -1) ||
      a.script.localeCompare(b.script) ||
      a.line - b.line,
  );
  return { target, sites: sites.slice(0, CALL_SITES), omitted: Math.max(0, sites.length - CALL_SITES) };
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
  private readonly frameFunctions: number;

  private constructor(
    server: Server,
    port: number,
    changed: (totals: ProfileTotals) => void,
    frameFunctions: number,
  ) {
    this.server = server;
    this.port = port;
    this.changed = changed;
    this.frameFunctions = frameFunctions;
  }

  /** A listener asking for at most [param frameFunctions] functions a frame; see `frameFunctionsFor`. */
  static async open(
    changed: (totals: ProfileTotals) => void,
    frameFunctions: number,
  ): Promise<ProfileListener> {
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
    const listener = new ProfileListener(server, address.port, changed, frameFunctions);
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
    const aggregate = new ProfileAggregate(started, this.frameFunctions);
    this.aggregate = aggregate;
    const stream = new DebuggerStream();
    socket.write(profilerOn(this.frameFunctions));
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
        // Read in order, so the totals sent before this are summed by now.
        if ('message' in received && received.message === PROFILE_SENT) {
          socket.write(framedCommand(PROFILE_RECEIVED, []));
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
