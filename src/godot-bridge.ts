import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { RawData } from 'ws';
import { WebSocket, WebSocketServer } from 'ws';
import { errorMessage, Refusal, toError } from './errors.js';
import { envValue } from './launch.js';
import { isSameDirectory } from './paths.js';
import { portFromEnv } from './ports.js';
import { addonMismatch, SERVER_VERSION } from './server-version.js';
import { installedEditorDigest, shippedEditorDigest } from './setup.js';

const DEFAULT_PORT = 6505;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_TIMEOUT_MS = 30_000;
const KEEPALIVE_INTERVAL_MS = 10_000;
const SECOND_CONNECTION_CLOSE_CODE = 4000;

/** The most a WebSocket close frame carries as its reason, in UTF-8 bytes. */
const MOST_CLOSE_REASON_BYTES = 123;

/**
 * [param text] cut to fit a close frame, keeping its start or its end.
 *
 * The protocol carries at most 123 bytes of reason, and `ws` throws past that rather than trimming.
 * It threw inside the message handler, where nothing catches it, so the process ended: a reason
 * naming two project paths took down any server an editor of another project dialled, and an
 * editor whose own server is gone dials the shared default port.
 */
export function closeReason(text: string, keep: 'start' | 'end'): string {
  if (Buffer.byteLength(text) <= MOST_CLOSE_REASON_BYTES) {
    return text;
  }
  // By code point, so a character outside the basic plane is never split in half.
  const characters = Array.from(text);
  const marker = '...';
  while (Buffer.byteLength(characters.join('')) + marker.length > MOST_CLOSE_REASON_BYTES) {
    if (keep === 'end') {
      characters.shift();
    } else {
      characters.pop();
    }
  }
  return keep === 'end' ? `${marker}${characters.join('')}` : `${characters.join('')}${marker}`;
}

/**
 * An editor belonging to another project, told so rather than served.
 *
 * Its own code, because the addon answers it differently from every other close: no amount of
 * retrying reaches a server that is not this project's, so the reason is worth putting in front of
 * a person once rather than backing off quietly forever.
 */
const OTHER_PROJECT_CLOSE_CODE = 4001;

/**
 * An engine run that loaded the editor addon to do one job and quit, such as a gate's
 * `--headless --import`, told so rather than served. Its own code so the addon stops dialling in:
 * the run is no editor however often it tries.
 */
const ONE_SHOT_CLOSE_CODE = 4002;

/** What the bridge last turned away as a one-shot engine run, for editor_status to say. */
export interface TurnedAway {
  readonly pid: number;
  readonly option: string;
  readonly at: Date;
}

/**
 * The option that makes a process one job that quits, null for none, undefined when it cannot be
 * told. Given to the server's own bridge; a bridge without it takes every editor that greets.
 */
export type OneShotReader = (pid: number) => Promise<string | null | undefined>;

/** The editor addon reads GDHARNESS_BRIDGE_PORT too, so the two agree by construction. */
function resolveDefaultBridgePort(): number {
  return portFromEnv('GDHARNESS_BRIDGE_PORT', DEFAULT_PORT);
}

function resolveDefaultBridgeHost(): string {
  const host = process.env['GDHARNESS_BRIDGE_HOST']?.trim();
  return host === undefined || host === '' ? DEFAULT_HOST : host;
}

interface ToolInvokeMessage {
  type: 'tool_invoke';
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

interface ToolResultMessage {
  type: 'tool_result';
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
  /** The tool was not run because the editor was scanning or importing, and can be asked again. */
  busy?: boolean;
}

interface PingMessage {
  type: 'ping';
}

interface PongMessage {
  type: 'pong';
}

interface GodotReadyMessage {
  type: 'godot_ready';
  project_path: string;
  /** Empty for a copy of the addon gdharness did not install, which carries no markers. */
  addon_version: string;
  addon_digest: string;
  editor_pid: number;
  /** The three ports this editor serves, so a server talks to this one and not another; 0 when it could not find out. */
  lsp_port: number;
  dap_port: number;
  debug_port: number;
  /** Whether a debug session opening is told the editor's breakpoints, or takes them away. */
  syncs_breakpoints: boolean;
  /** Whether a gdharness server started this editor, which decides who may start it again. */
  opened_by_a_server: boolean;
  /** Whether another editor started this one, and so none of the arguments it was given reached it. */
  started_by_an_editor: boolean;
}

/** Every field of the greeting with its type, which is what an editor of this release sends. */
const GREETING_FIELDS: Readonly<Record<string, 'string' | 'number' | 'boolean'>> = {
  project_path: 'string',
  addon_version: 'string',
  addon_digest: 'string',
  editor_pid: 'number',
  lsp_port: 'number',
  dap_port: 'number',
  debug_port: 'number',
  syncs_breakpoints: 'boolean',
  opened_by_a_server: 'boolean',
  started_by_an_editor: 'boolean',
};

/** The greeting fields [param message] lacks or holds as the wrong type, in the order above. */
export function greetingFaults(message: Record<string, unknown>): string[] {
  return Object.entries(GREETING_FIELDS)
    .filter(([field, type]) => typeof message[field] !== type)
    .map(([field]) => field);
}

type IncomingMessage = ToolResultMessage | PongMessage | GodotReadyMessage;
type OutgoingMessage = ToolInvokeMessage | PingMessage;

/** A port an editor says it serves on, or undefined for 0, its word for not knowing, or anything else not a port. */
function servedPort(said: number): number | undefined {
  return Number.isInteger(said) && said > 0 && said <= 65535 ? said : undefined;
}

interface BridgeEventMap {
  tool_start: { tool: string; id: string; args: Record<string, unknown> };
  tool_end: { tool: string; id: string; success: boolean; duration: number };
  godot_connected: { projectPath?: string | undefined };
  godot_disconnected: Record<string, never>;
}

interface PendingRequest {
  toolName: string;
  timeout: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  startedAt: number;
  // Explicitly `| undefined`: under exactOptionalPropertyTypes the bare `?` means the key may
  // be missing, not that it may be present and unset, and these are built from optional chains.
  resourceKey?: string | undefined;
  counted: boolean;
}

/** How a request to the editor is sent. */
export interface InvokeOptions {
  /**
   * False for a question the caller waits on only briefly and then gives up on, such as the ones
   * editor_status asks. Such a question is not reported as pending: an editor busy importing
   * answers it late, and two of them outstanding read as two calls stuck in the editor.
   */
  readonly counted?: boolean;
}

interface GodotConnectionInfo {
  projectPath?: string;
  connectedAt: Date;
  lastPongAt?: Date;
  // The fields below are set from the greeting, and absent until it arrives.
  /** The addon version this editor loaded, which an install under it does not change. */
  addonVersion?: string;
  /** The digest of the editor addon code it loaded. */
  addonDigest?: string | undefined;
  /** Which process is on the other end, since a restarted editor is a new one. */
  editorPid?: number | undefined;
  /**
   * Where this editor serves its language server, its debug adapter and its own debugger, each
   * undefined when the editor could not find out.
   *
   * Godot keeps one of each per machine rather than per editor, so the numbers are only worth
   * reporting because a second editor has to be moved off them.
   */
  lspPort?: number | undefined;
  dapPort?: number | undefined;
  debugPort?: number | undefined;
  /** Whether a gdharness server started this editor; one nothing claims restarts itself. */
  openedByAServer?: boolean | undefined;
  /**
   * Whether another editor started this one: Godot's own restart, or the project manager opening a
   * project. Such an editor has the environment and none of the arguments of the one before it, so
   * it serves the ports its editor settings name, writes no console a server asked for, and is not
   * the editor any server opened.
   */
  startedByAnEditor?: boolean | undefined;
  /**
   * Whether the editor keeps its breakpoints when a debug session opens.
   *
   * Godot clears every breakpoint in the script editor on a session's `initialize` unless
   * `network/debug_adapter/sync_breakpoints` is on; the addon turns it on as it loads and reports
   * it here, so false is the setting turned off again by hand.
   */
  syncsBreakpoints?: boolean | undefined;
  /**
   * True while the bridge reads the command line of a process that greeted without a server's
   * mark, before it is taken as the editor. Until then it is not counted as connected.
   */
  identifying?: boolean;
  /** Set once the greeting has been read. */
  greeted?: boolean;
}

interface BridgeStatus {
  host: string;
  /**
   * The port it listens on, or null while it listens on none: before it binds, while it waits for
   * a predecessor to let go, and between a held port refusing it and a free one taking it. The
   * configured port stood in for it there, and read as a bridge listening where it was not.
   */
  port: number | null;
  connected: boolean;
  projectPath?: string | undefined;
  connectedAt?: Date | undefined;
  lastPongAt?: Date | undefined;
  addonVersion?: string | undefined;
  addonDigest?: string | undefined;
  editorPid?: number | undefined;
  lspPort?: number | undefined;
  dapPort?: number | undefined;
  debugPort?: number | undefined;
  openedByAServer?: boolean | undefined;
  startedByAnEditor?: boolean | undefined;
  syncsBreakpoints?: boolean | undefined;
  /** The last engine run turned away for being one job that quits rather than an editor. */
  turnedAway?: TurnedAway | undefined;
  /** A process has greeted and is being looked up before it is taken as the editor. */
  identifying?: boolean | undefined;
  pendingRequests: number;
  queuedResources: number;
  /** When an editor already up could first have reached this bridge, absent until it listens. */
  listeningSince?: Date | undefined;
  /**
   * The port this bridge was configured with, present only when it is on another one because that
   * was held. Read beside a pinned `GDHARNESS_BRIDGE_PORT`, a different `port` otherwise looks like
   * the pin being ignored.
   */
  portWanted?: number | undefined;
}

/**
 * How long a bridge has to have been listening before nothing having connected means no editor.
 *
 * The addon dials in by itself and doubles its wait between tries up to thirty seconds, so an
 * editor that was talking to the server this one replaced can be most of that away from noticing.
 * Measured downstream at thirty seconds between an editor starting and the bridge taking it.
 */
export const CONNECT_WINDOW_MS = 35_000;

/**
 * Whether an editor that is up could still be on its way to a bridge nothing has connected to.
 *
 * True while the bridge is young enough that an editor has not had its chance yet, and while it is
 * not listening at all, since nothing arrives at a port nobody holds. False is the answer worth
 * having: the bridge has been open long enough that an editor would have reached it, so there is
 * no editor rather than one not reached yet.
 */
export function mayYetConnect(listeningSince: Date | undefined, now: number = Date.now()): boolean {
  return listeningSince === undefined || now - listeningSince.getTime() < CONNECT_WINDOW_MS;
}

/**
 * Whether the editor a restart asked for has come back: a connection newer than the restart, which
 * counts only once the editor has greeted, so its version, pid and ports are there to be read.
 */
export function theEditorHasComeBack(
  status: { connected: boolean; connectedAt?: Date | undefined },
  startedAt: number,
): boolean {
  return status.connected && (status.connectedAt?.getTime() ?? 0) > startedAt;
}

/**
 * [param path] without the separator it ends in, unless it is a root.
 *
 * The editor reports its project as `ProjectSettings.globalize_path("res://")`, which ends in one,
 * and every answer naming the project carried it as though it were another path from the one the
 * caller had passed.
 */
export function withoutTrailingSeparator(path: string): string {
  if (path.length <= 1 || !/[\\/]$/.test(path) || /^[A-Za-z]:[\\/]$/.test(path)) {
    return path;
  }
  return path.slice(0, -1);
}

/**
 * Whether an editor could still reach this bridge, counting one the server started itself.
 *
 * Two reasons and either is enough. The bridge may be young, which covers an editor that was
 * already running and has to notice the port. Or the server launched one and that process is still
 * alive without having dialled in, which covers the import: an editor loads no plugin until the
 * project is imported, and on a large project that is minutes rather than the half-minute the window
 * allows. Measured downstream at nine minutes, over which the answer read "an editor that is not
 * there" about an editor the same server had just started.
 */
export function anEditorIsStillComing(
  listeningSince: Date | undefined,
  launchedEditorIsAlive: boolean,
  now: number = Date.now(),
): boolean {
  return mayYetConnect(listeningSince, now) || launchedEditorIsAlive;
}

/**
 * A request the editor took in and did not answer in time. Apart from a refusal or a dropped
 * connection, because it usually means the editor is busy rather than gone: a hidden editor runs
 * the import a scan sets off on the thread that answers requests, and answers nothing until it is
 * done.
 */
export class BridgeTimeout extends Error {
  readonly toolName: string;
  readonly waitedMs: number;

  constructor(toolName: string, waitedMs: number) {
    super(`Tool ${toolName} timed out after ${waitedMs}ms`);
    this.toolName = toolName;
    this.waitedMs = waitedMs;
  }
}

/**
 * A tool not sent to an editor running another release's addon, whose answer would be that
 * release's. The message is the remedy.
 */
export class AddonOfAnotherRelease extends Error {}

/**
 * The commands an editor of another release is still sent, since only its addon can end it: the
 * quit editor_launch close and a server's own restart send, and the restart an editor opened by
 * hand does itself.
 */
const ASKED_OF_ANY_RELEASE: ReadonlySet<string> = new Set(['quit_editor', 'restart_editor']);

/** The editor turned a tool away unrun because it was scanning or importing its files. */
class EditorBusy extends Error {
  constructor(toolName: string) {
    super(`The editor was scanning or importing its files, so ${toolName} was not run.`);
  }
}

/**
 * How long a tool the editor turns away while it scans or imports is asked for again. The scan wait
 * a game start is given, since it is the same scan: a few seconds covers a few hundred scripts, and
 * what runs longer is an import of large assets. GDHARNESS_SCAN_WAIT_MS sets another.
 */
function busyWaitMs(): number {
  const override = Number.parseInt(envValue('GDHARNESS_SCAN_WAIT_MS') ?? '', 10);
  return Number.isInteger(override) && override > 0 ? override : 30_000;
}

/** How often a tool turned away by a busy editor is asked for again. */
const BUSY_RETRY_MS = 100;

export class GodotBridge extends EventEmitter {
  /**
   * When this bridge started listening, which is when an editor already up could first reach it.
   *
   * The addon dials in on its own and backs off between attempts, so "nothing has connected" means
   * two different things depending on how long that has been true. Null until the port is taken.
   */
  private listeningSince: Date | null = null;
  private httpServer: http.Server | null = null;
  private godotWss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private connectionInfo: GodotConnectionInfo | null = null;
  private oneShotReader: OneShotReader | null = null;
  /** Processes already found to be one-shot runs, so one that dials in again is told at once. */
  private readonly oneShots = new Map<number, string>();
  private turnedAway: TurnedAway | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private resourceQueues = new Map<string, Promise<void>>();

  private readonly wantedPort: number;
  private boundPort: number | null = null;
  private readonly host: string;
  private readonly timeoutMs: number;

  /**
   * The project this bridge serves, or null when nothing said which.
   *
   * Null for a config written by hand: an editor is taken on the port alone, because the port is
   * the whole contract when there is nowhere to announce.
   */
  private readonly ownProject: string | null;

  public constructor(
    port: number = DEFAULT_PORT,
    host: string = DEFAULT_HOST,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    ownProject: string | null = null,
  ) {
    super();
    this.wantedPort = port;
    this.host = host;
    this.timeoutMs = timeoutMs;
    this.ownProject = ownProject;
  }

  /**
   * Has every process that greets without a server's mark looked up before it is taken as the
   * editor, and turned away when its command line makes it one job that quits.
   *
   * A gate's `godot --headless --path <project> --import` loads the editor addon, which connected
   * as the editor: a start for another project on the same server was refused for as long as the
   * import ran, and the project's real editor, dialling in meanwhile, was the one turned away as a
   * second connection. The addon cannot tell, since the engine hands a plugin none of its options,
   * so the bridge reads them from the process. An editor a server opened is marked as such and is
   * not looked up.
   */
  public identifyEditorsWith(reader: OneShotReader): void {
    this.oneShotReader = reader;
  }

  /**
   * Whether a port somebody else is holding is a reason to take another one.
   *
   * Only when the editor can be told where to look, which is when this server knows its project
   * and can announce there. Without that, moving off the port would mean an editor connecting to
   * nothing.
   */
  private get mayMove(): boolean {
    return this.ownProject !== null;
  }

  /** The port it is actually on, which is the one it asked for until that one was taken. */
  public get port(): number {
    return this.boundPort ?? this.wantedPort;
  }

  /** The port it was configured with, whichever one it ends up on. */
  public get configuredPort(): number {
    return this.wantedPort;
  }

  /**
   * Takes the port it was given, or any free one when that is held and it is allowed to move.
   *
   * Two projects open at once both want the same port, because nothing varies it per project, so
   * the second editor bridge never came up at all. A server that can announce where it landed
   * does not need the port to be the one anybody agreed on beforehand. [param moveIfHeld] false
   * refuses a held port instead, for a caller that knows the holder is about to let it go.
   */
  public async start(moveIfHeld = true): Promise<void> {
    if (this.httpServer) {
      return;
    }
    try {
      await this.listenOn(this.wantedPort);
    } catch (error) {
      const held = error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
      if (!held || !this.mayMove || !moveIfHeld) {
        throw error;
      }
      this.log('warn', `Editor bridge port ${this.wantedPort} is held; taking another one.`);
      await this.listenOn(0);
    }
  }

  private listenOn(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // The HTTP server exists to take the WebSocket upgrade for /godot and nothing else: no
      // page, no health endpoint, no CORS. Every other request is a 404, and an upgrade for
      // any other path is closed, so the port carries the editor's socket and nothing a browser
      // tab could reach.
      const server = http.createServer((_req, res) => {
        res.writeHead(404);
        res.end();
      });
      const godotWss = new WebSocketServer({ noServer: true });
      let settled = false;

      server.on('upgrade', (request, socket, head) => {
        if (this.getRequestPathname(request.url) !== '/godot') {
          socket.destroy();
          return;
        }
        godotWss.handleUpgrade(request, socket, head, (ws) => {
          godotWss.emit('connection', ws, request);
        });
      });

      godotWss.on('connection', (socket) => {
        this.handleConnection(socket);
      });

      server.once('listening', () => {
        settled = true;
        this.listeningSince = new Date();
        this.httpServer = server;
        this.godotWss = godotWss;
        const bound = server.address();
        this.boundPort = typeof bound === 'object' && bound !== null ? bound.port : port;
        this.log('info', `Editor bridge listening on ${this.host}:${this.port}`);
        resolve();
      });

      server.once('error', (error) => {
        if (!settled) {
          settled = true;
          // Closed before the rejection, because a start that failed is tried again: the port is
          // usually held by a server on its way out, and an attempt per retry left behind would
          // be a leak that grows for as long as the wait lasts.
          server.close();
          godotWss.close();
          reject(error);
          return;
        }

        this.log('error', `HTTP server error: ${error.message}`);
      });

      godotWss.on('error', (error) => {
        this.log('error', `Godot WebSocket server error: ${error.message}`);
      });

      server.listen(port, this.host);
    });
  }

  public async stop(): Promise<void> {
    this.stopKeepalive();
    this.rejectAllPending(new Error('GodotBridge stopped'));
    this.resourceQueues.clear();
    const closeTasks: Promise<void>[] = [];

    // A close that half-fails must not look like one that worked: a bridge still holding its
    // port is the failure that costs a whole session to find, and silence is what hides it.
    if (this.socket) {
      try {
        this.socket.close();
      } catch (error) {
        this.log('debug', `Godot socket did not close cleanly: ${errorMessage(error)}`);
      }
      this.socket = null;
    }

    if (this.godotWss) {
      const godotWss = this.godotWss;
      for (const client of godotWss.clients) {
        try {
          client.close();
        } catch (error) {
          this.log('debug', `Godot client did not close cleanly: ${errorMessage(error)}`);
        }
      }
      closeTasks.push(this.closeWebSocketServer(godotWss));
      this.godotWss = null;
    }

    if (this.httpServer) {
      const httpServer = this.httpServer;
      closeTasks.push(this.closeHttpServer(httpServer));
      this.httpServer = null;
    }

    await Promise.all(closeTasks);

    this.boundPort = null;
    this.connectionInfo = null;
    this.log('info', 'WebSocket bridge stopped');
  }

  /**
   * Whether the editor is served: it has greeted and been taken as the editor. A socket that has
   * only opened is not, since its greeting can still start a lookup or turn it away, and editor_status
   * read through that window saw connected go true, false and true again as the greeting arrived.
   */
  public isConnected(): boolean {
    const info = this.connectionInfo;
    return this.socket?.readyState === WebSocket.OPEN && info?.greeted === true && info.identifying !== true;
  }

  /**
   * Whether a process has opened the socket and is not yet settled as the editor or turned away:
   * it has not greeted, or its command line is still being read. A call waits this out rather than
   * being refused as not connected while the editor is a moment from being served.
   */
  public isArriving(): boolean {
    const info = this.connectionInfo;
    return (
      this.socket?.readyState === WebSocket.OPEN &&
      info !== null &&
      (info.greeted !== true || info.identifying === true)
    );
  }

  /** The counted requests sent to the editor and not yet answered, oldest first. */
  public requestsInFlight(): { tool: string; startedAt: number }[] {
    return [...this.pendingRequests.values()]
      .filter((pending) => pending.counted)
      .map((pending) => ({ tool: pending.toolName, startedAt: pending.startedAt }))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  public getStatus(): BridgeStatus {
    // A process still being looked up is not yet the editor, so nothing it said about itself is
    // reported as the editor's: a project named before it is served read as an editor that had
    // that project open, and anything waiting on the name went on to act on it.
    const identifying = this.isArriving();
    const editor = identifying ? null : this.connectionInfo;
    return {
      host: this.host,
      port: this.boundPort,
      connected: this.isConnected(),
      projectPath: editor?.projectPath,
      connectedAt: editor?.connectedAt,
      lastPongAt: editor?.lastPongAt,
      addonVersion: editor?.addonVersion,
      addonDigest: editor?.addonDigest,
      editorPid: editor?.editorPid,
      lspPort: editor?.lspPort,
      dapPort: editor?.dapPort,
      debugPort: editor?.debugPort,
      openedByAServer: editor?.openedByAServer,
      startedByAnEditor: editor?.startedByAnEditor,
      syncsBreakpoints: editor?.syncsBreakpoints,
      turnedAway: this.turnedAway ?? undefined,
      identifying: identifying ? true : undefined,
      pendingRequests: this.requestsInFlight().length,
      queuedResources: this.resourceQueues.size,
      listeningSince: this.listeningSince ?? undefined,
      // Not for port 0, which asks for whichever port is free and so is never moved off.
      portWanted:
        this.wantedPort !== 0 && this.boundPort !== null && this.boundPort !== this.wantedPort
          ? this.wantedPort
          : undefined,
    };
  }

  /**
   * Why the connected editor is asked nothing but to quit, with what to do about it, or undefined
   * when it runs this server's addon or has not greeted yet.
   */
  public anotherRelease(): string | undefined {
    const info = this.connectionInfo;
    if (info?.greeted !== true || info.addonVersion === undefined || info.addonDigest === undefined) {
      return undefined;
    }
    const project = info.projectPath;
    return addonMismatch(
      info.addonVersion,
      SERVER_VERSION,
      info.addonDigest,
      shippedEditorDigest(),
      project === undefined || project === '' ? undefined : installedEditorDigest(project),
    );
  }

  public invokeTool(
    toolName: string,
    args: Record<string, unknown>,
    options: InvokeOptions = {},
  ): Promise<unknown> {
    const counted = options.counted ?? true;
    const resourceKey = this.getResourceKey(args);
    if (!resourceKey) {
      return this.invokeUntilTaken(toolName, args, counted);
    }

    return this.enqueueResourceRequest(resourceKey, () =>
      this.invokeUntilTaken(toolName, args, counted, resourceKey),
    );
  }

  /**
   * The tool, asked again for as long as the editor turns it away while it scans or imports. A
   * turned-away call did nothing, so asking again cannot run it twice, and one given up on cannot
   * run later.
   */
  private async invokeUntilTaken(
    toolName: string,
    args: Record<string, unknown>,
    counted: boolean,
    resourceKey?: string,
  ): Promise<unknown> {
    const waitMs = busyWaitMs();
    const giveUpAt = Date.now() + waitMs;
    for (;;) {
      try {
        return await this.invokeToolDirect(toolName, args, counted, resourceKey);
      } catch (error) {
        if (!(error instanceof EditorBusy)) {
          throw error;
        }
        if (Date.now() >= giveUpAt) {
          throw new Error(
            `The editor was scanning or importing its files for all of ${Math.round(waitMs / 1000)} s, so ${toolName} was not run and nothing it would change was changed. editor_rescan says when the scan is over.`,
          );
        }
      }
      await new Promise((settle) => setTimeout(settle, BUSY_RETRY_MS));
    }
  }

  private getRequestPathname(url: string | undefined): string {
    try {
      return new URL(url ?? '/', `http://${this.host}:${this.port}`).pathname;
    } catch {
      return '/';
    }
  }

  private closeWebSocketServer(server: WebSocketServer): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      try {
        server.close(() => {
          finish();
        });
      } catch {
        finish();
      }
    });
  }

  private closeHttpServer(server: http.Server): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      try {
        server.close(() => {
          finish();
        });
      } catch {
        finish();
      }
    });
  }

  private handleConnection(nextSocket: WebSocket): void {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      this.log('warn', 'Rejecting second Godot connection');
      nextSocket.close(SECOND_CONNECTION_CLOSE_CODE, 'Godot already connected');
      return;
    }

    this.socket = nextSocket;
    this.connectionInfo = {
      connectedAt: new Date(),
    };

    this.startKeepalive();
    this.log('info', 'Godot editor connected');
    this.emitBridgeEvent('godot_connected', { projectPath: this.connectionInfo.projectPath });

    nextSocket.on('message', (data) => {
      this.handleRawMessage(data);
    });

    nextSocket.on('close', (code, reasonBuffer) => {
      const reason = reasonBuffer.toString();
      this.log('warn', `Godot disconnected (code=${code}, reason=${reason || 'none'})`);
      this.handleDisconnect(nextSocket, new Error('Godot disconnected during request'));
    });

    nextSocket.on('error', (error) => {
      this.log('error', `WebSocket error: ${error.message}`);
      if (nextSocket.readyState === WebSocket.CLOSED || nextSocket.readyState === WebSocket.CLOSING) {
        this.handleDisconnect(nextSocket, error);
      }
    });
  }

  /**
   * `ws` hands a frame over as one of three shapes, and only one of them survives a bare
   * `toString()`: an array of chunks comma-joins into nonsense and an ArrayBuffer renders as
   * "[object ArrayBuffer]". Both then fail to parse, so a payload large enough to be
   * fragmented (a deep scene tree, a base64 screenshot) is dropped and its caller waits for
   * the timeout. Which shape arrives depends on size, so the failure is intermittent.
   */
  private static rawDataToString(data: RawData): string {
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    return Buffer.from(data).toString('utf8');
  }

  private handleRawMessage(data: RawData): void {
    let parsed: unknown;

    try {
      parsed = JSON.parse(GodotBridge.rawDataToString(data));
    } catch (error) {
      this.log('error', `Invalid JSON from Godot: ${errorMessage(error)}`);
      return;
    }

    if (!this.isIncomingMessage(parsed)) {
      this.log('warn', 'Ignoring unknown Godot message payload');
      return;
    }

    this.handleMessage(parsed);
  }

  private handleMessage(message: IncomingMessage): void {
    switch (message.type) {
      case 'tool_result': {
        const pending = this.pendingRequests.get(message.id);
        if (!pending) {
          this.log('warn', `Received tool_result for unknown id=${message.id}`);
          return;
        }

        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.id);
        const duration = Date.now() - pending.startedAt;
        this.log('debug', `Tool ${pending.toolName} finished in ${duration}ms`);
        this.emitBridgeEvent('tool_end', {
          tool: pending.toolName,
          id: message.id,
          success: message.success,
          duration,
        });

        if (message.success) {
          pending.resolve(message.result);
        } else if (message.busy === true) {
          pending.reject(new EditorBusy(pending.toolName));
        } else {
          pending.reject(new Error(message.error ?? `Tool ${pending.toolName} failed`));
        }
        return;
      }

      case 'godot_ready':
        if (this.connectionInfo) {
          if (this.belongsElsewhere(message.project_path)) {
            this.elsewhereUnlessOneShot(message.project_path, message.editor_pid, message.opened_by_a_server);
            return;
          }
          this.connectionInfo.projectPath = withoutTrailingSeparator(message.project_path);
          const faults = greetingFaults(message as unknown as Record<string, unknown>);
          if (faults.length > 0) {
            // Another release's addon, which this server asks nothing but to quit. The connection is
            // kept for that: closed, the addon dials straight back, and only it can quit its editor.
            this.log('info', `Godot ready from another release's addon, which sent no ${faults.join(', ')}`);
            this.connectionInfo.addonVersion =
              typeof message.addon_version === 'string' ? message.addon_version : '';
            this.connectionInfo.addonDigest = '';
            // Read when it is one, so editor_launch close and restart can wait on its process.
            this.connectionInfo.editorPid =
              typeof message.editor_pid === 'number' ? message.editor_pid : undefined;
            this.connectionInfo.greeted = true;
            this.emitBridgeEvent('godot_connected', { projectPath: message.project_path });
            return;
          }
          this.connectionInfo.addonVersion = message.addon_version;
          this.connectionInfo.addonDigest = message.addon_digest;
          this.connectionInfo.editorPid = message.editor_pid;
          this.connectionInfo.lspPort = servedPort(message.lsp_port);
          this.connectionInfo.dapPort = servedPort(message.dap_port);
          this.connectionInfo.debugPort = servedPort(message.debug_port);
          this.connectionInfo.openedByAServer = message.opened_by_a_server;
          this.connectionInfo.startedByAnEditor = message.started_by_an_editor;
          this.connectionInfo.syncsBreakpoints = message.syncs_breakpoints;
          this.log('info', `Godot ready: ${message.project_path}`);
          this.connectionInfo.greeted = true;
          if (!message.opened_by_a_server && this.oneShotReader !== null) {
            this.identify(message.editor_pid);
            return;
          }
          this.emitBridgeEvent('godot_connected', { projectPath: message.project_path });
        }
        return;

      case 'pong':
        if (this.connectionInfo) {
          this.connectionInfo.lastPongAt = new Date();
        }
        return;
    }
  }

  private invokeToolDirect(
    toolName: string,
    args: Record<string, unknown>,
    counted: boolean,
    resourceKey?: string,
  ): Promise<unknown> {
    if (!this.isConnected()) {
      return Promise.reject(new Error('Godot is not connected'));
    }
    const otherRelease = ASKED_OF_ANY_RELEASE.has(toolName) ? undefined : this.anotherRelease();
    if (otherRelease !== undefined) {
      return Promise.reject(new AddonOfAnotherRelease(otherRelease));
    }

    const requestId = randomUUID();
    const message: ToolInvokeMessage = {
      type: 'tool_invoke',
      id: requestId,
      tool: toolName,
      args,
    };

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new BridgeTimeout(toolName, this.timeoutMs));
      }, this.timeoutMs);

      this.pendingRequests.set(requestId, {
        toolName,
        timeout,
        resolve,
        reject,
        startedAt: Date.now(),
        resourceKey,
        counted,
      });

      this.emitBridgeEvent('tool_start', {
        tool: toolName,
        id: requestId,
        args,
      });

      try {
        this.sendMessage(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(toError(error));
      }
    });
  }

  private sendMessage(message: OutgoingMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new Refusal('Godot is not connected');
    }

    this.socket.send(JSON.stringify(message));
  }

  private startKeepalive(): void {
    this.stopKeepalive();

    this.pingInterval = setInterval(() => {
      // Every open socket, greeted or not, so one that goes quiet before greeting is still found.
      if (this.socket?.readyState !== WebSocket.OPEN) {
        return;
      }

      try {
        const ping: PingMessage = { type: 'ping' };
        this.sendMessage(ping);
      } catch (error) {
        this.log('warn', `Failed to send ping: ${errorMessage(error)}`);
      }
    }, KEEPALIVE_INTERVAL_MS);
    // The socket and the server hold the process for as long as either is open; a ping left behind
    // by a connection nobody closed kept a finished test run alive for hours.
    this.pingInterval.unref();
  }

  private stopKeepalive(): void {
    if (!this.pingInterval) {
      return;
    }

    clearInterval(this.pingInterval);
    this.pingInterval = null;
  }

  /**
   * Whether the editor that just said hello belongs to a different project than this server.
   *
   * The addon falls back to the default port when its own project has no announcement in it, which
   * is every project whose server has not run yet. Any server holding that port then took the
   * connection, said "Godot editor connected" and served it: tool calls reached an editor showing
   * another project's scenes, and both sides reported a healthy bridge. One server serves one
   * editor was the rule, and nothing anywhere checked it.
   *
   * Only when this server knows which project is its own. Without that there is nothing to compare
   * against and the port stays the whole contract, which is what a hand-written config relies on.
   */
  private belongsElsewhere(theirProject: string): boolean {
    if (this.ownProject === null || theirProject.trim() === '') {
      return false;
    }
    return !isSameDirectory(this.ownProject, theirProject);
  }

  /**
   * Turns away an editor from another project, saying whose server this is.
   *
   * The socket goes rather than the connection being left half made: it was never this server's
   * editor, so a reply of any kind would be answering for a project it cannot see.
   */
  private sendElsewhere(theirProject: string): void {
    const said = `this server serves ${this.ownProject ?? ''}, and that editor has ${theirProject} open`;
    this.log('warn', `Turning away an editor from another project: ${said}`);
    const stranger = this.socket;
    this.socket = null;
    this.connectionInfo = null;
    this.stopKeepalive();
    // Both projects when they fit. When they do not, whose server this is, which the editor cannot
    // see for itself, cut from the front so the project's folder survives a long path.
    const fits = closeReason(said, 'start') === said;
    stranger?.close(
      OTHER_PROJECT_CLOSE_CODE,
      fits ? said : closeReason(`this server serves ${this.ownProject ?? ''}`, 'end'),
    );
  }

  /**
   * Turns away a process of another project, as a one-shot run when its command line makes it one
   * and as another project's editor otherwise.
   *
   * A gate's `--import` of a fresh worktree has no announcement and dials the shared default port,
   * so it reaches whichever server holds that port. Told it was another project's editor, it prints
   * a warning that gates refuse a push on, so the command line is read before either close: a
   * one-shot run is closed quietly, and a real editor is still told whose server this is.
   */
  private elsewhereUnlessOneShot(
    theirProject: string,
    pid: number | undefined,
    openedByAServer: boolean,
  ): void {
    const known = pid === undefined ? undefined : this.oneShots.get(pid);
    if (pid !== undefined && known !== undefined) {
      this.turnAway(pid, known);
      return;
    }
    const info = this.connectionInfo;
    const socket = this.socket;
    const reader = this.oneShotReader;
    if (pid === undefined || openedByAServer || info === null || reader === null) {
      this.sendElsewhere(theirProject);
      return;
    }
    info.identifying = true;
    void reader(pid)
      .catch(() => undefined)
      .then((option) => {
        if (this.socket !== socket || this.connectionInfo !== info) {
          return;
        }
        if (typeof option === 'string') {
          this.oneShots.set(pid, option);
          this.turnAway(pid, option);
          return;
        }
        this.sendElsewhere(theirProject);
      });
  }

  /**
   * Takes the process that just greeted as the editor once its command line says it is one, and
   * turns it away when the command line makes it one job that quits. Until the answer comes the
   * connection is not counted, so nothing is refused or sent to it on the strength of it.
   *
   * A command line that cannot be read is taken as an editor's, which is what every connection was
   * before this asked: the bridge errs towards serving a real editor rather than refusing one.
   */
  private identify(pid: number): void {
    const known = this.oneShots.get(pid);
    if (known !== undefined) {
      this.turnAway(pid, known);
      return;
    }
    const info = this.connectionInfo;
    const socket = this.socket;
    const reader = this.oneShotReader;
    if (info === null || reader === null) {
      return;
    }
    info.identifying = true;
    void reader(pid)
      .catch(() => undefined)
      .then((option) => {
        if (this.socket !== socket || this.connectionInfo !== info) {
          return;
        }
        if (typeof option === 'string') {
          this.oneShots.set(pid, option);
          this.turnAway(pid, option);
          return;
        }
        info.identifying = false;
        this.log('info', `Godot editor identified: pid ${pid}`);
        this.emitBridgeEvent('godot_connected', { projectPath: info.projectPath });
      });
  }

  private turnAway(pid: number, option: string): void {
    const said = `pid ${pid} was started with ${option}, which does one job and quits, so it is not an editor`;
    this.log('info', `Turning away an engine run: ${said}`);
    this.turnedAway = { pid, option, at: new Date() };
    const run = this.socket;
    this.socket = null;
    this.connectionInfo = null;
    this.stopKeepalive();
    run?.close(ONE_SHOT_CLOSE_CODE, closeReason(said, 'start'));
  }

  private handleDisconnect(disconnectedSocket: WebSocket | null, reason: Error): void {
    if (disconnectedSocket && this.socket && disconnectedSocket !== this.socket) {
      this.log('debug', 'Ignoring stale Godot socket disconnect event');
      return;
    }

    this.stopKeepalive();

    this.socket = null;
    this.connectionInfo = null;
    this.emitBridgeEvent('godot_disconnected', {});

    this.rejectAllPending(reason);
    this.resourceQueues.clear();
  }

  private emitBridgeEvent<K extends keyof BridgeEventMap>(eventName: K, payload: BridgeEventMap[K]): void {
    this.emit(eventName, payload);
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }

    this.pendingRequests.clear();
  }

  private enqueueResourceRequest<T>(resourceKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.resourceQueues.get(resourceKey) ?? Promise.resolve();

    const taskPromise = previous.catch(() => undefined).then(task);

    const tail = taskPromise.then(
      () => undefined,
      () => undefined,
    );
    this.resourceQueues.set(resourceKey, tail);

    return taskPromise.finally(() => {
      if (this.resourceQueues.get(resourceKey) === tail) {
        this.resourceQueues.delete(resourceKey);
      }
    });
  }

  private getResourceKey(args: Record<string, unknown>): string | undefined {
    const scenePath = this.getStringArg(args, 'scenePath') ?? this.getStringArg(args, 'scene_path');
    if (scenePath) {
      return `scene:${scenePath}`;
    }

    const resourcePath = this.getStringArg(args, 'resourcePath') ?? this.getStringArg(args, 'resource_path');
    if (resourcePath) {
      return `resource:${resourcePath}`;
    }

    return undefined;
  }

  private getStringArg(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private isIncomingMessage(value: unknown): value is IncomingMessage {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const message = value as Record<string, unknown>;
    const type = message['type'];
    if (type !== 'tool_result' && type !== 'pong' && type !== 'godot_ready') {
      return false;
    }

    if (type === 'pong') {
      return true;
    }

    if (type === 'godot_ready') {
      return typeof message['project_path'] === 'string';
    }

    return (
      typeof message['id'] === 'string' &&
      typeof message['success'] === 'boolean' &&
      (message['error'] === undefined || typeof message['error'] === 'string') &&
      (message['busy'] === undefined || typeof message['busy'] === 'boolean')
    );
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    console.error(`[${new Date().toISOString()}] [GodotBridge:${level.toUpperCase()}] ${message}`);
  }
}

let defaultBridge: GodotBridge | null = null;

export function getDefaultBridge(ownProject: string | null = null): GodotBridge {
  defaultBridge ??= new GodotBridge(
    resolveDefaultBridgePort(),
    resolveDefaultBridgeHost(),
    DEFAULT_TIMEOUT_MS,
    ownProject,
  );
  return defaultBridge;
}

export function createBridge(
  port?: number,
  timeoutMs?: number,
  host?: string,
  ownProject?: string,
): GodotBridge {
  return new GodotBridge(port, host, timeoutMs, ownProject ?? null);
}
