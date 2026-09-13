import { createConnection, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Refusal } from './errors.js';
import { FrameReader, frame, OversizedStreamError } from './framing.js';
import { portFromEnv } from './ports.js';

const DEFAULT_DAP_PORT = 6006;

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
  private port: number;
  private host: string;
  private seq = 1;
  private pendingRequests: Map<number, PendingRequest>;
  private reader = new FrameReader();
  private outputBuffer: string[] = [];
  private maxOutputLines = 1000;
  private initialized = false;
  private attached = false;
  private lastThreadId = 1;
  /**
   * Whether the game is sitting at a breakpoint right now.
   *
   * Without it every question about the stack answers with an empty array, which reads the same
   * whether nothing is running, the game is running freely, or the stack is genuinely empty.
   */
  private stopped = false;
  private breakpoints = new Map<string, Set<number>>();

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
          this.connected = false;
          this.initialized = false;
          this.attached = false;
          this.stopped = false;
          this.socket = null;
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

  async disconnect(): Promise<void> {
    if (!this.socket) {
      this.connected = false;
      this.initialized = false;
      this.attached = false;
      this.stopped = false;
      return;
    }

    if (this.connected) {
      try {
        await this.sendRequest('disconnect', { restart: false });
      } catch {
        // The adapter may already be gone; the socket close below is what matters.
      }
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

    this.socket = null;
    this.connected = false;
    this.initialized = false;
    this.attached = false;
    this.stopped = false;
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
      this.stopped = true;
      return;
    }

    // Godot's adapter sends no `continued`, so the only other thing that clears this is the
    // request that resumed the game.
    if (eventName === 'terminated' || eventName === 'exited') {
      this.attached = false;
      this.stopped = false;
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
    await this.ensureConnected();
    await this.initialize();

    const fileBreakpoints = this.breakpoints.get(filePath) ?? new Set<number>();
    fileBreakpoints.add(line);
    this.breakpoints.set(filePath, fileBreakpoints);

    const lines = Array.from(fileBreakpoints).sort((a, b) => a - b);
    return await this.sendRequest('setBreakpoints', {
      source: { path: filePath },
      breakpoints: lines.map((breakpointLine) => ({ line: breakpointLine })),
    });
  }

  async removeBreakpoint(filePath: string, line: number): Promise<DAPBody> {
    await this.ensureConnected();
    await this.initialize();

    const fileBreakpoints = this.breakpoints.get(filePath) ?? new Set<number>();
    fileBreakpoints.delete(line);

    if (fileBreakpoints.size === 0) {
      this.breakpoints.delete(filePath);
    } else {
      this.breakpoints.set(filePath, fileBreakpoints);
    }

    const remaining = Array.from(fileBreakpoints).sort((a, b) => a - b);
    return await this.sendRequest('setBreakpoints', {
      source: { path: filePath },
      breakpoints: remaining.map((breakpointLine) => ({ line: breakpointLine })),
    });
  }

  async continue(threadId?: number): Promise<void> {
    await this.attach();
    const resolvedThreadId = await this.resolveThreadId(threadId);
    await this.sendRequest('continue', { threadId: resolvedThreadId });
    this.stopped = false;
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

  /** Whether a game is sitting at a breakpoint, which is the only state the stack is real in. */
  isStopped(): boolean {
    return this.stopped;
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
    this.socket = null;
    this.connected = false;
    this.initialized = false;
    this.attached = false;
    this.stopped = false;
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
    return {
      // Marked as the failure it is: without this a caller reads a sentence about what went
      // wrong as the answer to what it asked, which is the one thing a tool must never do.
      isError: true,
      content: [
        {
          type: 'text',
          text:
            `DAP tool '${toolName}' failed: ${message}. ` +
            'The debug tools answer for a game the editor is playing: start one with editor_run.',
        },
      ],
    };
  }
}
