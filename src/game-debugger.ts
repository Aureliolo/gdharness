/**
 * The debugger of a game this server started itself, held by the game's keeper.
 *
 * The editor's debugger holds only a game the editor plays, and a run started with its own
 * arguments or a saves directory cannot be played by the editor, so such a run had no debugger at
 * all: a game hung on its first frame could not be broken into, and a breakpoint on the line it spun
 * on was never hit. The game is started with `--remote-debug` pointed here instead, and this speaks
 * the engine's own debugger protocol to it. It sits in the keeper rather than the server because the
 * game dials once, at startup, and the keeper is the one process that lives exactly as long as the
 * game: a server restarted by its harness mid-run would take a debugger it held down with it.
 *
 * Read from `core/debugger/remote_debugger.cpp` at 4.7.2. A thread held at a break reads only the
 * commands addressed to it, so every command to a held game goes to the thread that stopped.
 */

import { createServer, type Server, type Socket } from 'node:net';
import {
  type DebuggerMessage,
  DebuggerStream,
  framedCommand,
  type GodotValue,
  MAIN_THREAD,
  type SentValue,
} from './godot-variant.js';

/** One frame of a held game's stack, innermost first. */
export interface DebugFrame {
  readonly id: number;
  readonly name: string;
  readonly line: number;
  /** The script as the project spells it. */
  readonly script: string;
}

interface DebugVariable {
  readonly name: string;
  readonly value: string;
  readonly type: string;
}

interface DebugScope {
  readonly name: 'Locals' | 'Members' | 'Globals';
  readonly variables: readonly DebugVariable[];
}

export type DebugRequest =
  | { readonly op: 'breakpoint'; readonly script: string; readonly line: number; readonly set: boolean }
  | { readonly op: 'pause' }
  | { readonly op: 'resume'; readonly how: 'continue' | 'next' | 'step' | 'out' }
  | { readonly op: 'stack' }
  | { readonly op: 'variables'; readonly frame: number }
  | { readonly op: 'output' }
  | { readonly op: 'state' };

/** An answer as it crosses the keeper's channel: a refusal says why under `refused`. */
export type DebugAnswer = Readonly<Record<string, unknown>>;

/** Something else reading the same connection, such as the script profiler. */
export interface DebugObserver {
  connected(send: (message: string, data: readonly SentValue[]) => void): void;
  message(received: DebuggerMessage, send: (message: string, data: readonly SentValue[]) => void): void;
}

/**
 * How long a pause waits for the game to stop. The engine takes the request between frames, and in a
 * script only every 2048 lines it runs, so a loop sleeping between its lines, the hang a pause is
 * for, gets there slowly: one sleeping a millisecond a turn took over five seconds on a macOS runner.
 */
export const PAUSE_MS = 30_000;
/** How long a step waits for the game to stop again, as the editor's adapter is given. */
export const STEP_MS = 10_000;
/** How long a read of a held game waits for its answer, which comes from the same thread at once. */
export const READ_MS = 5000;
/** The messages that answer a command, which wait in the inbox when no request is reading yet. */
const REPLIES: ReadonlySet<string> = new Set([
  'debug_enter',
  'debug_exit',
  'stack_dump',
  'stack_frame_vars',
  'stack_frame_var',
]);
/** The most unread replies kept, which a frame of a few thousand globals stays under. */
const INBOX_KEPT = 10_000;
/** How many lines of what the game printed are kept for `output`. */
const OUTPUT_KEPT = 1000;

/** The engine's `Variant::Type` names as GDScript spells them, by number. */
const TYPE_NAMES: readonly string[] = [
  'Nil',
  'bool',
  'int',
  'float',
  'String',
  'Vector2',
  'Vector2i',
  'Rect2',
  'Rect2i',
  'Vector3',
  'Vector3i',
  'Transform2D',
  'Vector4',
  'Vector4i',
  'Plane',
  'Quaternion',
  'AABB',
  'Basis',
  'Transform3D',
  'Projection',
  'Color',
  'StringName',
  'NodePath',
  'RID',
  'Object',
  'Callable',
  'Signal',
  'Dictionary',
  'Array',
  'PackedByteArray',
  'PackedInt32Array',
  'PackedInt64Array',
  'PackedFloat32Array',
  'PackedFloat64Array',
  'PackedStringArray',
  'PackedVector2Array',
  'PackedVector3Array',
  'PackedColorArray',
  'PackedVector4Array',
];

/** The scopes `stack_frame_var` numbers, in the engine's order. */
const SCOPES: readonly DebugScope['name'][] = ['Locals', 'Members', 'Globals'];

/** How many elements of a list or a dictionary a value's text shows before it says how many more. */
const ELEMENTS_SHOWN = 20;

// A type guard, because Array.isArray does not narrow a union holding a readonly array.
function isList(value: GodotValue): value is readonly GodotValue[] {
  return Array.isArray(value);
}

/** [param value] as text, the way a reader of a variables answer wants it. */
export function shownValue(value: GodotValue, typeHint = ''): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (isList(value)) {
    const shown = value.slice(0, ELEMENTS_SHOWN).map((each) => shownValue(each));
    const more = value.length - shown.length;
    return `[${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}]`;
  }
  if (value.kind === 'dictionary' && 'entries' in value) {
    const shown = value.entries
      .slice(0, ELEMENTS_SHOWN)
      .map(([key, each]) => `${shownValue(key)}: ${shownValue(each)}`);
    const more = value.entries.length - shown.length;
    return `{${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}}`;
  }
  if (!('values' in value)) {
    return value.kind;
  }
  if (value.kind === 'Object') {
    return `<${typeHint === '' ? 'Object' : typeHint}#${String(value.values[0])}>`;
  }
  return `${value.kind}(${value.values.join(', ')})`;
}

/** A held game's stack from a `stack_dump`: its size, then file, line and function per frame. */
export function framesOf(data: readonly GodotValue[]): DebugFrame[] {
  const frames: DebugFrame[] = [];
  for (let at = 1; at + 2 < data.length; at += 3) {
    const [script, line, name] = [data[at], data[at + 1], data[at + 2]];
    if (typeof script !== 'string' || typeof line !== 'number' || typeof name !== 'string') {
      break;
    }
    frames.push({ id: frames.length, name, line, script });
  }
  return frames;
}

interface Held {
  readonly thread: number;
  readonly canContinue: boolean;
  /** The error that stopped it, or `Breakpoint`, or empty for a stop that was asked for. */
  readonly reason: string;
  readonly hasStack: boolean;
}

interface Waiter {
  readonly wanted: (received: DebuggerMessage) => boolean;
  readonly resolve: (received: DebuggerMessage | null) => void;
}

export class GameDebugger {
  private connection: Socket | null = null;
  private held: Held | null = null;
  private ended = false;
  private readonly waiters: Waiter[] = [];
  private readonly inbox: DebuggerMessage[] = [];
  private readonly onClosed: (() => void)[] = [];
  private readonly output: string[] = [];
  private outputDropped = 0;
  /** Requests answered one at a time: each reads the replies to the commands it sent. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly server: Server;
  readonly port: number;
  private readonly breakpoints: readonly string[];
  private readonly observers: readonly DebugObserver[];

  private constructor(
    server: Server,
    port: number,
    breakpoints: readonly string[],
    observers: readonly DebugObserver[],
  ) {
    this.server = server;
    this.port = port;
    this.breakpoints = breakpoints;
    this.observers = observers;
  }

  /**
   * Listening on loopback, on a port the system picks, for the one game that will dial it.
   * [param breakpoints] are `res://path:line`, set as the game starts so a line in its first frame
   * stops it.
   */
  static async open(
    breakpoints: readonly string[],
    observers: readonly DebugObserver[] = [],
  ): Promise<GameDebugger> {
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
      throw new Error('the debugger has no port');
    }
    const peer = new GameDebugger(server, address.port, breakpoints, observers);
    server.on('connection', (socket) => {
      peer.accept(socket);
    });
    return peer;
  }

  /**
   * The engine arguments that point a game here. An error does not stop it, as it did not when the
   * run had no debugger: a bench that met an error would otherwise sit at it until somebody came.
   */
  get engineArguments(): readonly string[] {
    // The engine splits the list at commas and a breakpoint at its last colon, and reads %20 as a space.
    const listed = this.breakpoints.map((one) => one.replaceAll(' ', '%20')).join(',');
    return [
      '--remote-debug',
      `tcp://127.0.0.1:${this.port}`,
      '--ignore-error-breaks',
      ...(listed === '' ? [] : ['--breakpoints', listed]),
    ];
  }

  private accept(socket: Socket): void {
    if (this.connection !== null) {
      socket.destroy();
      return;
    }
    this.connection = socket;
    // Only the one game ever dials it, and it dials once.
    this.server.close();
    const send = (message: string, data: readonly SentValue[]): void => {
      this.send(message, data);
    };
    for (const observer of this.observers) {
      observer.connected(send);
    }
    const stream = new DebuggerStream();
    socket.on('data', (chunk: Buffer) => {
      let messages: DebuggerMessage[];
      try {
        messages = stream.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const received of messages) {
        if ('message' in received) {
          this.take(received);
          for (const observer of this.observers) {
            observer.message(received, send);
          }
        }
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      this.ended = true;
      this.held = null;
      for (const waiter of this.waiters.splice(0)) {
        waiter.resolve(null);
      }
      for (const done of this.onClosed.splice(0)) {
        done();
      }
    });
  }

  /**
   * Settles once the game's connection has closed, which an exiting game's does after the last of
   * what it sent, or after [param ms], or at once for a game that never connected. The process exit
   * is reported before the socket's last reads, so a profile finished on the exit alone lost the
   * frames still on their way: a thirty-frame scene was summed from twenty.
   */
  drained(ms: number): Promise<void> {
    if (this.connection === null || this.ended) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.onClosed.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** The state a message changes, then whoever was waiting for it. */
  private take(received: Extract<DebuggerMessage, { message: string }>): void {
    if (received.message === 'debug_enter') {
      const [canContinue, reason, hasStack] = received.data;
      this.held = {
        thread: received.thread,
        canContinue: canContinue === true,
        reason: typeof reason === 'string' ? reason : '',
        hasStack: hasStack === true,
      };
    } else if (received.message === 'debug_exit' && this.held?.thread === received.thread) {
      this.held = null;
    } else if (received.message === 'output') {
      const [strings] = received.data;
      if (Array.isArray(strings)) {
        for (const each of strings) {
          if (typeof each === 'string') {
            this.output.push(...each.split('\n'));
          }
        }
        const over = this.output.length - OUTPUT_KEPT;
        if (over > 0) {
          this.output.splice(0, over);
          this.outputDropped += over;
        }
      }
    }
    const at = this.waiters.findIndex((waiter) => waiter.wanted(received));
    if (at !== -1) {
      this.waiters.splice(at, 1)[0]?.resolve(received);
    } else if (REPLIES.has(received.message)) {
      // Kept for the request reading it: a frame's values arrive several to a read, and the request
      // asks for the next one only after the last has been handed to it.
      this.inbox.push(received);
      if (this.inbox.length > INBOX_KEPT) {
        this.inbox.shift();
      }
    }
  }

  /** Drops replies named [param message] that no request read, before a command whose reply it is. */
  private forget(message: string): void {
    for (let at = this.inbox.length - 1; at >= 0; at -= 1) {
      const kept = this.inbox[at];
      if (kept !== undefined && 'message' in kept && kept.message === message) {
        this.inbox.splice(at, 1);
      }
    }
  }

  private send(message: string, data: readonly SentValue[], thread = MAIN_THREAD): void {
    this.connection?.write(framedCommand(message, data, thread));
  }

  /** The next message [param wanted] takes, or null when none comes within [param ms] or the game goes. */
  private next(wanted: (received: DebuggerMessage) => boolean, ms: number): Promise<DebuggerMessage | null> {
    const kept = this.inbox.findIndex(wanted);
    if (kept !== -1) {
      return Promise.resolve(this.inbox.splice(kept, 1)[0] ?? null);
    }
    if (this.ended) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        wanted,
        resolve: (received) => {
          clearTimeout(timer);
          resolve(received);
        },
      };
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at !== -1) {
          this.waiters.splice(at, 1);
        }
        resolve(null);
      }, ms);
      this.waiters.push(waiter);
    });
  }

  private static named(message: string): (received: DebuggerMessage) => boolean {
    return (received) => 'message' in received && received.message === message;
  }

  /** Answers [param request], after every request asked before it. */
  ask(request: DebugRequest): Promise<DebugAnswer> {
    const answered = this.queue.then(() => this.answer(request));
    this.queue = answered.catch(() => undefined);
    return answered;
  }

  private async answer(request: DebugRequest): Promise<DebugAnswer> {
    if (request.op === 'output') {
      return {
        output: [...this.output],
        ...(this.outputDropped > 0 ? { notShown: this.outputDropped } : {}),
      };
    }
    if (request.op === 'state') {
      return { connected: this.connection !== null && !this.ended, held: this.heldState() };
    }
    if (this.connection === null) {
      return {
        refused:
          'The game never connected to its debugger: it dials once as it starts, and a game that has not got that far, or that was started without a debugger, has none.',
      };
    }
    if (this.ended) {
      return { refused: 'The game has closed its debugger connection, which it does as it exits.' };
    }
    switch (request.op) {
      case 'breakpoint':
        this.send(
          'breakpoint',
          [request.script, request.line, request.set],
          this.held?.thread ?? MAIN_THREAD,
        );
        return { sent: true };
      case 'pause':
        return await this.pause();
      case 'resume':
        return await this.resume(request.how);
      case 'stack': {
        const frames = await this.stack();
        if (frames === null) {
          return this.notHeld();
        }
        return {
          held: this.heldState(),
          stack: frames,
          ...(frames.length === 0
            ? {
                note: 'The game is held between frames, where no script runs, so there is no stack: debug_control step_over takes it to the next line of script it runs.',
              }
            : {}),
        };
      }
      case 'variables':
        return await this.variables(request.frame);
      default:
        return { refused: `Nothing here answers ${JSON.stringify(request)}.` };
    }
  }

  private heldState(): Readonly<Record<string, unknown>> | null {
    if (this.held === null) {
      return null;
    }
    return {
      thread: this.held.thread,
      ...(this.held.reason === '' ? {} : { reason: this.held.reason }),
      ...(this.held.canContinue ? {} : { canContinue: false }),
    };
  }

  private notHeld(): DebugAnswer {
    return {
      refused:
        'The game is running, not held, so it has no stack to read: debug_control pause stops it where it is, and a breakpoint stops it on its line.',
    };
  }

  /** The held game's stack, or null when it is not held or did not answer. */
  private async stack(): Promise<DebugFrame[] | null> {
    const held = this.held;
    if (held === null) {
      return null;
    }
    this.forget('stack_dump');
    this.send('get_stack_dump', [], held.thread);
    const dumped = await this.next(GameDebugger.named('stack_dump'), READ_MS);
    return dumped !== null && 'data' in dumped ? framesOf(dumped.data) : null;
  }

  /**
   * Stops the game where it is. The engine takes the request between lines of script, every 2048
   * of them, or between frames, so a game spinning in a script loop stops in it and an idle one at
   * its next frame. A stop between frames holds no script, so the game is then stepped to the next
   * line of script it runs, which is where a caller wants to look.
   */
  private async pause(): Promise<DebugAnswer> {
    if (this.held === null) {
      this.forget('debug_enter');
      this.send('break', []);
      const entered = await this.next(GameDebugger.named('debug_enter'), PAUSE_MS);
      if (entered === null) {
        return {
          paused: false,
          note: `The game has been asked to stop and had not within ${PAUSE_MS / 1000}s. It takes the request between frames, and in a script every 2048 lines it runs, so its main thread is in a loop that sleeps between few lines, or inside one long engine call or a native extension's own loop. The request stays with the game, which stops when it next reaches that point; debug_state stack reads where once it has.`,
        };
      }
    }
    const held = this.held;
    if (held === null) {
      return { refused: 'The game stopped and was let go again before its stack could be read.' };
    }
    if (!held.hasStack) {
      this.forget('debug_enter');
      this.send('next', [], held.thread);
      const again = await this.next(GameDebugger.named('debug_enter'), STEP_MS);
      if (again === null) {
        return {
          paused: false,
          note: `The game stopped between frames, where no script runs, so it was let go to stop at the next line of script it runs, and none ran within ${STEP_MS / 1000}s. It stops there when one does; debug_state stack reads it then.`,
        };
      }
    }
    this.stoppedBy('Paused');
    const frames = await this.stack();
    return { paused: true, held: this.heldState(), stack: frames ?? [] };
  }

  /**
   * Names what stopped the game when it was this debugger: the engine reports a stop after a step as
   * `Breakpoint`, which read after a pause as a breakpoint the caller had just removed.
   */
  private stoppedBy(cause: 'Paused' | 'Stepped'): void {
    if (this.held !== null) {
      this.held = { ...this.held, reason: cause };
    }
  }

  private async resume(how: 'continue' | 'next' | 'step' | 'out'): Promise<DebugAnswer> {
    const held = this.held;
    if (held === null) {
      return {
        refused:
          'The game is running, not held, so there is nothing to continue or step from: debug_control pause stops it, and a breakpoint stops it on its line.',
      };
    }
    if (how === 'continue') {
      this.forget('debug_exit');
      const exited = this.next(
        (received) =>
          'message' in received && received.message === 'debug_exit' && received.thread === held.thread,
        READ_MS,
      );
      this.send('continue', [], held.thread);
      return (await exited) === null
        ? { refused: `The game did not say it had gone on within ${READ_MS / 1000}s.` }
        : { continued: true };
    }
    this.forget('debug_enter');
    this.send(how, [], held.thread);
    const entered = await this.next(GameDebugger.named('debug_enter'), STEP_MS);
    if (entered === null) {
      return {
        stepped: true,
        heldAgain: false,
        note: `The game had not stopped again ${STEP_MS / 1000}s after the step: the step is still running, as one out of a function that never returns does, or it went on without reaching another line. debug_state stack answers once it stops, and debug_control pause stops it wherever it is.`,
      };
    }
    this.stoppedBy('Stepped');
    return { stepped: true, heldAgain: true, held: this.heldState(), stack: (await this.stack()) ?? [] };
  }

  private async variables(frame: number): Promise<DebugAnswer> {
    const held = this.held;
    if (held === null) {
      return this.notHeld();
    }
    const frames = await this.stack();
    if (frames === null) {
      return { refused: `The game did not send its stack within ${READ_MS / 1000}s.` };
    }
    if (frames.find((each) => each.id === frame) === undefined) {
      return {
        refused:
          frames.length === 0
            ? 'The game is held where no script runs, so it has no frames: debug_control step_over takes it to the next line of script.'
            : `The stack has no frame ${frame}; its frames are ${frames.map((each) => each.id).join(', ')}.`,
      };
    }
    this.forget('stack_frame_vars');
    this.forget('stack_frame_var');
    this.send('get_stack_frame_vars', [frame], held.thread);
    const counted = await this.next(GameDebugger.named('stack_frame_vars'), READ_MS);
    const count = counted !== null && 'data' in counted ? counted.data[0] : undefined;
    if (typeof count !== 'number') {
      return { refused: `The game did not send the frame's values within ${READ_MS / 1000}s.` };
    }
    const scopes: { name: DebugScope['name']; variables: DebugVariable[] }[] = SCOPES.map((name) => ({
      name,
      variables: [],
    }));
    for (let index = 0; index < count; index += 1) {
      const one = await this.next(GameDebugger.named('stack_frame_var'), READ_MS);
      if (one === null || !('data' in one)) {
        return {
          scopes,
          valuesMissing: count - index,
          note: `${count - index} of the frame's ${count} values did not arrive within ${READ_MS / 1000}s, so the scopes are not whole. Ask again.`,
        };
      }
      const [name, scope, type, value, hint] = one.data;
      const into = scopes[typeof scope === 'number' ? scope : 0];
      into?.variables.push({
        name: typeof name === 'string' ? name : shownValue(name ?? null),
        value: shownValue(value ?? null, typeof hint === 'string' ? hint : ''),
        type:
          typeof hint === 'string' && hint !== ''
            ? hint
            : typeof type === 'number'
              ? (TYPE_NAMES[type] ?? String(type))
              : 'Variant',
      });
    }
    return { held: this.heldState(), frame, scopes };
  }

  close(): void {
    this.connection?.destroy();
    this.server.close();
  }
}
