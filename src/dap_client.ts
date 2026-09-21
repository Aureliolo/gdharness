import { createConnection, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Refusal } from './errors.js';
import { FrameReader, frame, OversizedStreamError } from './framing.js';
import { portFromEnv } from './ports.js';

/** What an editor serves the debug adapter on when nothing has moved it. */
export const DEFAULT_DAP_PORT = 6006;

/** What any request waits before it is called unanswered. */
const DAP_REQUEST_TIMEOUT_MS = 10_000;

/**
 * How long to let a frame's variables arrive before giving up on them.
 *
 * The dump comes from the stopped game over the editor's debugger, so it is a round trip through
 * two processes rather than a local read. Generous, because the alternative is answering "no
 * variables" about a frame that has them.
 */
const SCOPES_TIMEOUT_MS = 20_000;

/**
 * What one poll for a frame's variables waits.
 *
 * Short, because the adapter answers nothing at all while the dump is in flight, and a poll that
 * waited the full request timeout would spend the whole budget learning that once.
 */
const VARIABLES_POLL_TIMEOUT_MS = 2_000;

interface PendingRequest {
  resolve: (value: DAPBody | PromiseLike<DAPBody>) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

interface DAPMessage {
  seq: number;
  type: 'request' | 'response' | 'event';
  command?: string;
  arguments?: unknown;
  request_seq?: number;
  success?: boolean;
  message?: string;
  body?: Record<string, unknown>;
  event?: string;
}

type DAPBody = Record<string, unknown>;

type DAPArrayItem = Record<string, unknown>;

/**
 * Why the game is sitting still, as the adapter last said it.
 *
 * Godot sends `breakpoint` for one a caller set and `exception` for an error it broke the game
 * on, and for the second it puts the engine's own sentence in `text`. That sentence is the only
 * place a script error appears: the adapter prints none of it, so a reader that kept nothing but
 * a boolean threw away the one report of what had gone wrong.
 */
export interface StoppedAt {
  readonly reason: string;
  readonly description: string;
  readonly text: string;
}

/** The breakpoints on one file, as this side spells the file: the path the adapter takes. */
export interface HeldBreakpoint {
  readonly scriptPath: string;
  readonly lines: readonly number[];
}

/** A file whose breakpoints the adapter would not take back, and what it said. */
export interface RefusedBreakpoint {
  readonly scriptPath: string;
  readonly reason: string;
}

/** One string off a DAP body, or empty for a field the adapter left out. */
function said(body: DAPBody | undefined, field: string): string {
  const value = body?.[field];
  return typeof value === 'string' ? value : '';
}

interface ToolResponse {
  content: { type: string; text: string }[];
  /** Set on a handled failure, so a caller does not read the reason as the answer. */
  isError?: boolean;
}

interface ToolArgs {
  scriptPath?: unknown;
  line?: unknown;
  frameId?: unknown;
}

export class GodotDAPClient {
  private socket: Socket | null = null;
  private connected = false;
  /** Public so a caller can tell when the editor it is following has moved to another one. */
  readonly port: number;
  private host: string;
  private seq = 1;
  private pendingRequests: Map<number, PendingRequest>;
  private reader = new FrameReader();
  private outputBuffer: string[] = [];
  /** Called with each console line as the adapter delivers it, for a reader that cannot poll. */
  private onOutput: ((line: string) => void) | null = null;
  private maxOutputLines = 1000;
  private initialized = false;
  private attached = false;
  private lastThreadId = 1;
  /**
   * Where the game is sitting still right now, or null while it runs.
   *
   * Without it every question about the stack answers with an empty array, which reads the same
   * whether nothing is running, the game is running freely, or the stack is genuinely empty.
   */
  private halt: StoppedAt | null = null;
  /** Whether `halt` is an answer or a default. See [holdIsKnown]. */
  private holdKnown = false;
  /** The breakpoints set through this side, by file: sent again before every play and kept. */
  private breakpoints = new Map<string, Set<number>>();
  /**
   * Every breakpoint the editor has told this connection about, by file, including the ones above.
   *
   * The adapter takes a file's whole list and removes what is not in it, so a list carrying only
   * this side's lines takes the editor's own breakpoints in that file away. With breakpoint
   * syncing on the editor names them all as a session opens, and every toggle after that, so what
   * is sent is the union. Learned per connection: the next one is told again.
   */
  private inEditor = new Map<string, Set<number>>();
  /** Told whenever the set this side holds changes without a call: see [setBreakpointsSink]. */
  private onBreakpointsChanged: ((held: HeldBreakpoint[]) => void) | null = null;

  constructor(port = portFromEnv('GDHARNESS_DAP_PORT', DEFAULT_DAP_PORT), host = '127.0.0.1') {
    this.port = port;
    this.host = host;
    this.pendingRequests = new Map();
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      this.socket = socket;

      const connectTimeout = setTimeout(() => {
        socket.destroy();
        this.socket = null;
        reject(
          new Error(
            `Could not connect to Godot DAP server at ${this.host}:${this.port}. ` +
              'Make sure Godot is running with debug/DAP enabled.',
          ),
        );
      }, 3000);

      const handleConnect = (): void => {
        clearTimeout(connectTimeout);
        this.connected = true;
        this.reader = new FrameReader();

        socket.on('data', (chunk: Buffer) => {
          let frames: ReturnType<FrameReader['push']>;
          try {
            frames = this.reader.push(chunk);
          } catch (error) {
            if (error instanceof OversizedStreamError) {
              this.failOversizedStream(error.message);
              return;
            }
            throw error;
          }
          for (const received of frames) {
            if (received.kind === 'malformed') {
              console.error(
                `[GodotDAP] Discarding a ${received.byteLength} byte message that is not JSON: ${received.reason}`,
              );
              continue;
            }
            this.handleMessage(received.value as DAPMessage);
          }
        });

        socket.on('error', (error: Error) => {
          this.failPendingRequests(error);
        });

        socket.on('close', () => {
          this.forgetConnection();
          this.failPendingRequests(new Error('DAP connection closed'));
        });

        resolve();
      };

      const handleError = (error: Error): void => {
        clearTimeout(connectTimeout);
        this.socket = null;
        reject(
          new Error(`Could not connect to Godot DAP server at ${this.host}:${this.port}: ${error.message}`),
        );
      };

      socket.once('connect', handleConnect);
      socket.once('error', handleError);
    });
  }

  /**
   * Lets go of the adapter without telling it to, which is what a shutdown wants.
   *
   * Godot stops the game it is playing when this session sends `disconnect`, and it does so with
   * `terminateDebuggee: false` on the request, so the protocol's way of asking to be let go without
   * taking the debuggee with you is not one this adapter honours. Measured: an editor-played run
   * dies on the server's own shutdown, which a harness performs on every reconnect, and survives
   * when the request is not sent. Closing the transport is all this side needs, and the process is
   * about to exit and close it anyway.
   */
  async abandon(): Promise<void> {
    if (!this.socket) {
      this.forgetConnection();
      return;
    }

    await new Promise<void>((resolve) => {
      const socket = this.socket;
      if (!socket) {
        resolve();
        return;
      }

      socket.once('close', () => {
        resolve();
      });
      socket.end();
      setTimeout(() => {
        if (!socket.destroyed) {
          socket.destroy();
        }
        resolve();
      }, 500);
    });

    this.forgetConnection();
  }

  /**
   * What a closed connection leaves behind: nothing.
   *
   * The adapter tells a connection what happens while it is open and repeats none of it to the
   * next one, so a stop heard here is not one the connection that replaces this one has heard.
   */
  private forgetConnection(): void {
    this.socket = null;
    this.connected = false;
    this.initialized = false;
    this.attached = false;
    this.halt = null;
    this.holdKnown = false;
    this.inEditor.clear();
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
  }

  private async sendRequest(
    command: string,
    args?: Record<string, unknown>,
    timeoutMs = DAP_REQUEST_TIMEOUT_MS,
  ): Promise<DAPBody> {
    await this.ensureConnected();

    if (!this.socket) {
      throw new Refusal('DAP socket is not available');
    }

    const requestSeq = this.seq++;
    const request: DAPMessage = {
      seq: requestSeq,
      type: 'request',
      command,
      arguments: args,
    };

    const payload = frame(request);

    return await new Promise<DAPBody>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestSeq);
        reject(new Error(`DAP request timed out: ${command}`));
      }, timeoutMs);

      this.pendingRequests.set(requestSeq, { resolve, reject, timer });

      this.socket?.write(payload, (error?: Error | null) => {
        if (error) {
          clearTimeout(timer);
          this.pendingRequests.delete(requestSeq);
          reject(new Error(`Failed to send DAP request '${command}': ${error.message}`));
        }
      });
    });
  }

  private handleMessage(message: DAPMessage): void {
    if (message.type === 'response') {
      const requestSeq = message.request_seq;
      if (typeof requestSeq !== 'number') {
        return;
      }

      const pending = this.pendingRequests.get(requestSeq);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timer);
      this.pendingRequests.delete(requestSeq);

      if (message.success) {
        pending.resolve(message.body ?? {});
      } else {
        const errorText =
          typeof message.message === 'string'
            ? message.message
            : `DAP request failed: ${message.command ?? 'unknown command'}`;
        pending.reject(new Error(errorText));
      }
    } else if (message.type === 'event') {
      this.handleEvent(message);
    }
  }

  private handleEvent(event: DAPMessage): void {
    const eventName = event.event;
    if (eventName === 'output') {
      const body = event.body;
      const outputText = typeof body?.['output'] === 'string' ? body['output'] : '';

      if (outputText.length > 0) {
        const lines = outputText.split(/\r?\n/).filter((line: string) => line.length > 0);
        this.outputBuffer.push(...lines);
        // Handed on as it arrives, as well as buffered for whoever polls. The buffer is pulled,
        // so anything built on it only advances when somebody asks, and a file written that way
        // cannot be tailed: measured downstream, an editor-played run's transcript sat at 411
        // bytes for a minute of a live run and grew the instant a poll was made. A watch on a file
        // that only moves when polled makes the watcher do the thing the watch replaces.
        if (this.onOutput !== null) {
          for (const line of lines) {
            try {
              this.onOutput(line);
            } catch {
              // A sink that throws is the caller's problem and must not cost the buffer its line.
            }
          }
        }
      }

      if (this.outputBuffer.length > this.maxOutputLines) {
        this.outputBuffer = this.outputBuffer.slice(this.outputBuffer.length - this.maxOutputLines);
      }
      return;
    }

    if (eventName === 'stopped') {
      const body = event.body;
      const threadId = body?.['threadId'];
      if (typeof threadId === 'number') {
        this.lastThreadId = threadId;
      }
      this.halt = {
        reason: said(body, 'reason'),
        description: said(body, 'description'),
        text: said(body, 'text'),
      };
      this.holdKnown = true;
      return;
    }

    // Sent to every connection when the game is let go, whoever let it go: measured on 4.7.2
    // with a second client sending `continue` while the session that had been told of the stop
    // looked on, and the editor's own debugger resumes the game through the same path. Without
    // this that session went on answering held about a game that was running, since the one other
    // thing that cleared it was its own `continue` request.
    if (eventName === 'continued') {
      this.halt = null;
      this.holdKnown = true;
      return;
    }

    // A breakpoint toggled anywhere, by anybody: the editor's gutter, another client, or this
    // side's own request echoed back. With syncing on, a session opening is told the whole set
    // this way. What is removed by somebody else is not held here either, since the alternative
    // is putting a breakpoint back that the user just clicked off.
    if (eventName === 'breakpoint') {
      const body = event.body;
      const breakpoint = body?.['breakpoint'];
      const source =
        typeof breakpoint === 'object' && breakpoint !== null ? (breakpoint as DAPBody)['source'] : undefined;
      const path = typeof source === 'object' && source !== null ? (source as DAPBody)['path'] : undefined;
      const line =
        typeof breakpoint === 'object' && breakpoint !== null ? (breakpoint as DAPBody)['line'] : undefined;
      if (typeof path !== 'string' || typeof line !== 'number') {
        return;
      }
      if (said(body, 'reason') === 'removed') {
        this.inEditor.get(path)?.delete(line);
        const held = this.breakpoints.get(path);
        if (held?.delete(line) === true) {
          if (held.size === 0) {
            this.breakpoints.delete(path);
          }
          this.onBreakpointsChanged?.(this.breakpointsHeld());
        }
        return;
      }
      const known = this.inEditor.get(path) ?? new Set<number>();
      known.add(line);
      this.inEditor.set(path, known);
      return;
    }

    if (eventName === 'terminated' || eventName === 'exited') {
      this.attached = false;
      this.halt = null;
    }
  }

  async initialize(): Promise<DAPBody> {
    await this.ensureConnected();

    if (this.initialized) {
      return {};
    }

    const response = await this.sendRequest('initialize', {
      adapterID: 'godot',
      clientID: 'godot-mcp',
      clientName: 'godot-mcp',
      locale: 'en',
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      supportsVariableType: true,
      supportsRunInTerminalRequest: false,
      supportsProgressReporting: false,
      supportsInvalidatedEvent: false,
      supportsMemoryReferences: false,
    });

    this.initialized = true;
    return response;
  }

  async attach(): Promise<void> {
    await this.ensureConnected();

    if (this.attached) {
      return;
    }

    await this.initialize();
    await this.sendRequest('attach', {});
    await this.sendRequest('configurationDone', {});
    this.attached = true;
    // A connection open when the game stopped was told, attached or not, and what it was told
    // names the stop: asking would replace an exception with "held when this session attached".
    if (!this.holdKnown) {
      await this.learnWhetherHeld();
    }
  }

  /**
   * Whether the game was already held when this session attached, asked rather than waited for.
   *
   * `halt` is set by the `stopped` event and the event goes to every client connected when the
   * game halts. A session opened afterwards never receives it, so it is asked for here through
   * the stack, and what the adapter answers depends on who else is attached. Measured against a
   * real editor: while the client that was told is still attached, a second session gets the frames
   * and learns the halt. Once that client has gone, which is what a harness reconnect does to a
   * server, the adapter answers a thread and no frames, and the game is still sitting at its
   * breakpoint: a runtime call to it accepts the connection and never answers. So no frames is not
   * "running". It is "this session cannot tell", and the answer is left unknown rather than set to
   * null, for the caller that can ask the runtime.
   */
  private async learnWhetherHeld(): Promise<void> {
    try {
      const threads = await this.sendRequest('threads');
      const listed = threads['threads'];
      const first = Array.isArray(listed) ? (listed[0] as DAPArrayItem | undefined)?.['id'] : undefined;
      if (typeof first !== 'number') {
        return;
      }
      this.lastThreadId = first;
      const response = await this.sendRequest('stackTrace', { threadId: first, startFrame: 0, levels: 1 });
      // Told while asking: a game that reaches its breakpoint between the question and the answer
      // puts frames in the answer and its reason in an event, and the event is the one with the
      // reason. Measured on macOS, where the attach for a first stack read and the stop at a
      // breakpoint in _ready land close enough together to cross.
      if (this.holdKnown) {
        return;
      }
      const frames = response['stackFrames'];
      if (Array.isArray(frames) && frames.length > 0) {
        this.halt = {
          reason: 'attached',
          description:
            'held when this session attached; the stop that held it was reported to an earlier one',
          text: '',
        };
        this.holdKnown = true;
      }
    } catch {
      // The adapter declining to answer is a game with nothing to say about where it stopped, and
      // an attach that succeeded is not undone by a question it could not answer.
    }
  }

  /**
   * Whether this session can say if the game is held.
   *
   * True once this connection has been told by a `stopped` event, has let the game go itself, or
   * found frames on attach. Being told needs the connection open at the time and nothing more: a
   * server that plays a scene through the editor hears the stop on a socket it never attached, and
   * the stop it hears is the one with the reason in it. False for a connection opened after a stop
   * the adapter will not repeat to it: for that one, `whereItStopped()` answering null is not an
   * answer.
   */
  holdIsKnown(): boolean {
    return this.holdKnown;
  }

  /**
   * What a caller that asked elsewhere found out: the game answered, so it is running.
   *
   * Unless the adapter has spoken since the question was put. The ping is awaited, the socket
   * delivers meanwhile, and a stop reported while the answer was in flight is newer than it.
   */
  learnedRunning(): void {
    if (this.holdKnown) {
      return;
    }
    this.halt = null;
    this.holdKnown = true;
  }

  /**
   * Where each console line goes as it arrives, on top of the buffer.
   *
   * Set once and left, because it reads the caller's own current state: a second play or a run
   * picked up after a reconnect is a different destination, and a sink that has to be re-pointed
   * is one that will be left pointing at the run before.
   */
  setOutputSink(sink: (line: string) => void): void {
    this.onOutput = sink;
  }

  getOutput(clear = false): string[] {
    const lines = [...this.outputBuffer];
    if (clear) {
      this.outputBuffer = [];
    }
    return lines;
  }

  /**
   * Breakpoints are set on the adapter rather than on a session, so no game has to be running.
   *
   * Attaching first would make the useful order impossible: set the breakpoint, start the game,
   * stop on the line. Attach refuses when nothing is playing, so a caller could only ever set
   * one on a game already past it.
   */
  async setBreakpoint(filePath: string, line: number): Promise<DAPBody> {
    const wanted = new Set(this.breakpoints.get(filePath) ?? []);
    wanted.add(line);
    return await this.sendBreakpoints(filePath, wanted);
  }

  /**
   * The line comes off whoever set it: the editor's own breakpoint on that line goes too, since
   * a caller asking for a line to be clear is asking about the line and not about provenance.
   */
  async removeBreakpoint(filePath: string, line: number): Promise<DAPBody> {
    const wanted = new Set(this.breakpoints.get(filePath) ?? []);
    wanted.delete(line);
    return await this.sendBreakpoints(filePath, wanted, line);
  }

  /**
   * The file's whole list, which is what the adapter takes: a line left out is a line removed.
   *
   * The list is this side's lines and the editor's own in that file, less the one being taken
   * off, so setting a breakpoint does not take away the ones the user set by hand. Held only once
   * the adapter has taken it, so a line it refused is not one this session goes on sending before
   * every play.
   */
  private async sendBreakpoints(
    filePath: string,
    mine: ReadonlySet<number>,
    clearing?: number,
  ): Promise<DAPBody> {
    await this.ensureConnected();
    await this.initialize();
    const lines = new Set([...mine, ...(this.inEditor.get(filePath) ?? [])]);
    if (clearing !== undefined) {
      lines.delete(clearing);
    }
    const sorted = Array.from(lines).sort((a, b) => a - b);
    const answer = await this.sendRequest('setBreakpoints', {
      source: { path: filePath },
      breakpoints: sorted.map((breakpointLine) => ({ line: breakpointLine })),
    });
    if (mine.size === 0) {
      this.breakpoints.delete(filePath);
    } else {
      this.breakpoints.set(filePath, new Set(mine));
    }
    // What the editor now has in this file, as sent; the adapter echoes each toggle back as an
    // event as well, and a read between the answer and the echo should not say otherwise.
    if (lines.size === 0) {
      this.inEditor.delete(filePath);
    } else {
      this.inEditor.set(filePath, lines);
    }
    return answer;
  }

  /**
   * Where changes to the held set that no call made are reported: a breakpoint of this side's
   * clicked off in the editor, or a file the adapter would not take back before a play.
   */
  setBreakpointsSink(sink: (held: HeldBreakpoint[]) => void): void {
    this.onBreakpointsChanged = sink;
  }

  /** The breakpoints the editor has told this connection of that this side did not set. */
  breakpointsInEditor(): HeldBreakpoint[] {
    const theirs: HeldBreakpoint[] = [];
    for (const [scriptPath, lines] of this.inEditor) {
      const mine = this.breakpoints.get(scriptPath);
      const rest = Array.from(lines)
        .filter((line) => !mine?.has(line))
        .sort((a, b) => a - b);
      if (rest.length > 0) {
        theirs.push({ scriptPath, lines: rest });
      }
    }
    return theirs;
  }

  /**
   * Sends every breakpoint this session holds again, for the play about to start.
   *
   * Measured on 4.7.2: a breakpoint set through the adapter stops the next play and not the one
   * after it. The same session that set it, continued past it and stopped the game played again
   * and ran straight through, and setting it again before the play is what made the second play
   * stop. So the editor is given the whole set before each play this server starts, and the
   * answer says what was sent and what the adapter would not take, since a file the project no
   * longer has is no reason to keep the play from starting.
   */
  async reapplyBreakpoints(): Promise<{ applied: HeldBreakpoint[]; refused: RefusedBreakpoint[] }> {
    const applied: HeldBreakpoint[] = [];
    const refused: RefusedBreakpoint[] = [];
    for (const [filePath, lines] of Array.from(this.breakpoints)) {
      try {
        await this.sendBreakpoints(filePath, lines);
        applied.push({ scriptPath: filePath, lines: Array.from(lines).sort((a, b) => a - b) });
      } catch (error) {
        this.breakpoints.delete(filePath);
        refused.push({
          scriptPath: filePath,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (refused.length > 0) {
      this.onBreakpointsChanged?.(this.breakpointsHeld());
    }
    return { applied, refused };
  }

  /** What this session holds, file by file, in the order the files were first named. */
  breakpointsHeld(): HeldBreakpoint[] {
    return Array.from(this.breakpoints, ([scriptPath, lines]) => ({
      scriptPath,
      lines: Array.from(lines).sort((a, b) => a - b),
    }));
  }

  /**
   * Takes on breakpoints another server set, without sending them: they are sent before the next
   * play, and a server that has just started has no play to send them for yet.
   */
  holdBreakpoints(held: readonly HeldBreakpoint[]): void {
    for (const { scriptPath, lines } of held) {
      const fileBreakpoints = this.breakpoints.get(scriptPath) ?? new Set<number>();
      for (const line of lines) {
        fileBreakpoints.add(line);
      }
      if (fileBreakpoints.size > 0) {
        this.breakpoints.set(scriptPath, fileBreakpoints);
      }
    }
  }

  async continue(threadId?: number): Promise<void> {
    await this.attach();
    const resolvedThreadId = await this.resolveThreadId(threadId);
    await this.sendRequest('continue', { threadId: resolvedThreadId });
    // Let go by this session, which is the one way a session knows the game runs without being
    // told: it asked for exactly that.
    this.halt = null;
    this.holdKnown = true;
  }

  async stepOver(threadId?: number): Promise<void> {
    await this.attach();
    const resolvedThreadId = await this.resolveThreadId(threadId);
    await this.sendRequest('next', { threadId: resolvedThreadId });
  }

  /**
   * There is no stepOut beside this. Godot's debug adapter parser implements req_next and
   * req_stepIn and nothing for stepOut, so the request is never answered and the call waits out
   * its timeout. Measured on 4.7.2, then read in the engine's own source.
   */
  async stepInto(threadId?: number): Promise<void> {
    await this.attach();
    const resolvedThreadId = await this.resolveThreadId(threadId);
    await this.sendRequest('stepIn', { threadId: resolvedThreadId });
  }

  async getStackTrace(threadId?: number): Promise<DAPArrayItem[]> {
    await this.attach();
    const resolvedThreadId = await this.resolveThreadId(threadId);
    const response = await this.sendRequest('stackTrace', {
      threadId: resolvedThreadId,
      startFrame: 0,
      levels: 100,
    });

    const stackFrames = response['stackFrames'];
    if (Array.isArray(stackFrames)) {
      return stackFrames as DAPArrayItem[];
    }

    return [];
  }

  /**
   * One scope's values, asked for until the game has sent them.
   *
   * `req_variables` refuses a reference it has not been given the values for yet, with the same
   * "unknown" any other failure gets, and answers nothing at all while the dump is in flight. Both
   * mean "not yet" rather than "no such thing", and neither is distinguishable from the other, so
   * both are waited out.
   */
  private async variablesWhenReady(variablesReference: number, deadline: number): Promise<DAPArrayItem[]> {
    while (Date.now() < deadline) {
      try {
        const answered = (
          await this.sendRequest('variables', { variablesReference }, VARIABLES_POLL_TIMEOUT_MS)
        )['variables'];
        if (Array.isArray(answered)) {
          return answered as DAPArrayItem[];
        }
      } catch {
        // Refused or unanswered: the dump is still coming.
      }
      await delay(200);
    }
    return [];
  }

  /**
   * What is in scope at a frame: locals, members and globals, each with its values.
   *
   * Asking once is not enough, and the engine's own source says why. `req_scopes` both answers and
   * asks: it calls `request_stack_dump` for the frame, so the first call sets the dump going and
   * answers with an empty list, and while the dump is partway in it answers "unknown". Only once
   * the game has sent all three does it answer with them.
   *
   * Which means asking for the scopes a second time restarts the very dump the values are waiting
   * on. So they are asked for until they arrive and then left alone, and it is the values that are
   * polled after that, never the scopes again.
   */
  async getScopes(frameId?: number): Promise<{ name: string; variables: DAPArrayItem[] }[]> {
    await this.attach();
    const frames = await this.getStackTrace();
    const frame = frameId === undefined ? frames[0] : frames.find((each) => each['id'] === frameId);
    if (frame === undefined) {
      return [];
    }

    const deadline = Date.now() + SCOPES_TIMEOUT_MS;
    let scopes: DAPArrayItem[] = [];
    while (scopes.length === 0 && Date.now() < deadline) {
      try {
        const answered = (await this.sendRequest('scopes', { frameId: frame['id'] }))['scopes'];
        if (Array.isArray(answered) && answered.length > 0) {
          scopes = answered as DAPArrayItem[];
          break;
        }
      } catch {
        // "unknown", which is what a half-filled frame answers. Asking again is the whole fix.
      }
      await delay(200);
    }

    const named: { name: string; variables: DAPArrayItem[] }[] = [];
    for (const scope of scopes) {
      const reference = scope['variablesReference'];
      named.push({
        name: typeof scope['name'] === 'string' ? scope['name'] : 'scope',
        variables: typeof reference === 'number' ? await this.variablesWhenReady(reference, deadline) : [],
      });
    }
    return named;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Whether a game is sitting still, which is the only state the stack is real in. */
  isStopped(): boolean {
    return this.halt !== null;
  }

  /** Why it is sitting still, or null while it runs. See [StoppedAt]. */
  whereItStopped(): StoppedAt | null {
    return this.halt;
  }

  private async resolveThreadId(threadId?: number): Promise<number> {
    if (typeof threadId === 'number' && threadId > 0) {
      this.lastThreadId = threadId;
      return threadId;
    }

    if (this.lastThreadId > 0) {
      return this.lastThreadId;
    }

    try {
      const response = await this.sendRequest('threads');
      const threads = response['threads'];
      if (Array.isArray(threads) && threads.length > 0) {
        const id = (threads[0] as DAPArrayItem | undefined)?.['id'];
        if (typeof id === 'number' && id > 0) {
          this.lastThreadId = id;
          return id;
        }
      }
    } catch {
      // No thread list: fall through to the default thread id rather than failing the call.
    }

    return 1;
  }

  /**
   * Drop a connection whose framing has run away, naming the size that did it.
   *
   * Nothing downstream can recover from a stream this far out of step, and waiting quietly
   * for the rest of a body that is never coming is indistinguishable from an idle adapter.
   */
  private failOversizedStream(detail: string): void {
    const socket = this.socket;
    this.forgetConnection();
    this.reader = new FrameReader();
    socket?.destroy();

    this.failPendingRequests(new Error(`Godot DAP ${detail}. The connection was dropped.`));
  }

  private failPendingRequests(error: Error): void {
    this.pendingRequests.forEach((pending, seq) => {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingRequests.delete(seq);
    });
  }
}

export async function handleDAPTool(
  client: GodotDAPClient,
  toolName: string,
  args: unknown,
): Promise<ToolResponse> {
  const safeArgs: ToolArgs = args && typeof args === 'object' ? args : {};

  try {
    switch (toolName) {
      // JSON like every other answer: a caller that reads one tool with a parser should not
      // have to read this one with a regex.
      case 'dap_get_output': {
        const output = client.getOutput(false);
        return {
          content: [{ type: 'text', text: JSON.stringify({ lines: output.length, output }, null, 2) }],
        };
      }

      case 'dap_set_breakpoint': {
        if (typeof safeArgs.scriptPath !== 'string' || typeof safeArgs.line !== 'number') {
          throw new Refusal('dap_set_breakpoint requires { scriptPath: string, line: number }');
        }

        const result = await client.setBreakpoint(safeArgs.scriptPath, safeArgs.line);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'dap_remove_breakpoint': {
        if (typeof safeArgs.scriptPath !== 'string' || typeof safeArgs.line !== 'number') {
          throw new Refusal('dap_remove_breakpoint requires { scriptPath: string, line: number }');
        }

        const result = await client.removeBreakpoint(safeArgs.scriptPath, safeArgs.line);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      // JSON like every other answer, and with the stack after the step rather than a sentence
      // about it: where the game is now is the thing the next call is decided on, and a step that
      // ran off the end of the program has an empty one.
      case 'dap_continue': {
        await client.continue();
        return { content: [{ type: 'text', text: JSON.stringify({ continued: true }, null, 2) }] };
      }

      case 'dap_step_over':
      case 'dap_step_into': {
        if (toolName === 'dap_step_into') {
          await client.stepInto();
        } else {
          await client.stepOver();
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ stepped: true, stack: await client.getStackTrace() }, null, 2),
            },
          ],
        };
      }

      case 'dap_get_stack_trace': {
        const stack = await client.getStackTrace();
        return {
          content: [{ type: 'text', text: JSON.stringify(stack, null, 2) }],
        };
      }

      case 'dap_get_variables': {
        const frameId = typeof safeArgs.frameId === 'number' ? safeArgs.frameId : undefined;
        const scopes = await client.getScopes(frameId);
        return {
          content: [{ type: 'text', text: JSON.stringify({ scopes }, null, 2) }],
        };
      }

      default:
        // Not a refusal: the caller never names a DAP tool, this server does, so one it does not
        // know is a routing table that disagrees with itself.
        throw new Error(`Unknown DAP tool: ${toolName}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A breakpoint is set on the editor's adapter with no game running, so a refusal there is
    // about the editor or the file and never about a game: "start one with editor_run" sent a
    // caller whose script the adapter could not find to start a game that would not have helped.
    const cure =
      toolName === 'dap_set_breakpoint' || toolName === 'dap_remove_breakpoint'
        ? 'Breakpoints need the editor open, not a running game: editor_status says whether one is connected, and the path is the script as the project spells it.'
        : 'The debug tools answer for a game the editor is playing: start one with editor_run.';
    return {
      // Marked as the failure it is: without this a caller reads a sentence about what went
      // wrong as the answer to what it asked, which is the one thing a tool must never do.
      isError: true,
      content: [{ type: 'text', text: `DAP tool '${toolName}' failed: ${message}. ${cure}` }],
    };
  }
}
