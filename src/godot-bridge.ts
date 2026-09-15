import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { RawData } from 'ws';
import { WebSocket, WebSocketServer } from 'ws';
import { errorMessage, Refusal, toError } from './errors.js';
import { isSameDirectory } from './paths.js';
import { portFromEnv } from './ports.js';

const DEFAULT_PORT = 6505;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_TIMEOUT_MS = 30_000;
const KEEPALIVE_INTERVAL_MS = 10_000;
const SECOND_CONNECTION_CLOSE_CODE = 4000;

/**
 * An editor belonging to another project, told so rather than served.
 *
 * Its own code, because the addon answers it differently from every other close: no amount of
 * retrying reaches a server that is not this project's, so the reason is worth putting in front of
 * a person once rather than backing off quietly forever.
 */
const OTHER_PROJECT_CLOSE_CODE = 4001;

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
  addon_version?: string;
  editor_pid?: number;
  /** The three ports this editor serves, so a server talks to this one and not another. */
  lsp_port?: number;
  dap_port?: number;
  debug_port?: number;
}

type IncomingMessage = ToolResultMessage | PongMessage | GodotReadyMessage;
type OutgoingMessage = ToolInvokeMessage | PingMessage;

/**
 * A port an editor says it serves on, or undefined for anything that is not one.
 *
 * Typed loosely on purpose: what arrives is whatever an addon sent, and an addon older than this
 * field sends nothing at all.
 */
function servedPort(said: unknown): number | undefined {
  return typeof said === 'number' && Number.isInteger(said) && said > 0 && said <= 65535 ? said : undefined;
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
}

interface GodotConnectionInfo {
  projectPath?: string;
  connectedAt: Date;
  lastPongAt?: Date;
  /** The addon version this editor loaded, which an install under it does not change. */
  addonVersion?: string;
  /** Which process is on the other end, since a restarted editor is a new one. */
  editorPid?: number | undefined;
  /**
   * Where this editor serves its language server, its debug adapter and its own debugger.
   *
   * Godot keeps one of each per machine rather than per editor, so the numbers are only worth
   * reporting because a second editor has to be moved off them. Undefined for an addon too old
   * to say, which is answered by falling back to the defaults it would have been on anyway.
   */
  lspPort?: number | undefined;
  dapPort?: number | undefined;
  debugPort?: number | undefined;
}

interface BridgeStatus {
  host: string;
  port: number;
  connected: boolean;
  projectPath?: string | undefined;
  connectedAt?: Date | undefined;
  lastPongAt?: Date | undefined;
  addonVersion?: string | undefined;
  editorPid?: number | undefined;
  lspPort?: number | undefined;
  dapPort?: number | undefined;
  debugPort?: number | undefined;
  pendingRequests: number;
  queuedResources: number;
}

export class GodotBridge extends EventEmitter {
  private httpServer: http.Server | null = null;
  private godotWss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private connectionInfo: GodotConnectionInfo | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private resourceQueues = new Map<string, Promise<void>>();

  private readonly wantedPort: number;
  private boundPort: number | null = null;
  private readonly host: string;
  private readonly timeoutMs: number;

  /**
   * The project this bridge serves, or null when nothing said which.
   *
   * Null is every config written by hand and every one written before a server knew its project,
   * and it is what keeps those working exactly as they did: an editor is taken on the port alone,
   * because the port is the whole contract when there is nowhere to announce.
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

  /**
   * Takes the port it was given, or any free one when that is held and it is allowed to move.
   *
   * Two projects open at once both want the same port, because nothing varies it per project, so
   * the second editor bridge never came up at all. A server that can announce where it landed
   * does not need the port to be the one anybody agreed on beforehand.
   */
  public async start(): Promise<void> {
    if (this.httpServer) {
      return;
    }
    try {
      await this.listenOn(this.wantedPort);
    } catch (error) {
      const held = error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
      if (!held || !this.mayMove) {
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

  public isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  public getStatus(): BridgeStatus {
    return {
      host: this.host,
      port: this.port,
      connected: this.isConnected(),
      projectPath: this.connectionInfo?.projectPath,
      connectedAt: this.connectionInfo?.connectedAt,
      lastPongAt: this.connectionInfo?.lastPongAt,
      addonVersion: this.connectionInfo?.addonVersion,
      editorPid: this.connectionInfo?.editorPid,
      lspPort: this.connectionInfo?.lspPort,
      dapPort: this.connectionInfo?.dapPort,
      debugPort: this.connectionInfo?.debugPort,
      pendingRequests: this.pendingRequests.size,
      queuedResources: this.resourceQueues.size,
    };
  }

  public invokeTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const resourceKey = this.getResourceKey(args);
    if (!resourceKey) {
      return this.invokeToolDirect(toolName, args);
    }

    return this.enqueueResourceRequest(resourceKey, () => this.invokeToolDirect(toolName, args, resourceKey));
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
        } else {
          pending.reject(new Error(message.error ?? `Tool ${pending.toolName} failed`));
        }
        return;
      }

      case 'godot_ready':
        if (this.connectionInfo) {
          if (this.belongsElsewhere(message.project_path)) {
            this.sendElsewhere(message.project_path);
            return;
          }
          this.connectionInfo.projectPath = message.project_path;
          // An older addon sends no version at all, which is itself worth reporting: it is one
          // installed before this was written, so it is certainly not the shipped one.
          this.connectionInfo.addonVersion = message.addon_version ?? '';
          this.connectionInfo.editorPid = message.editor_pid;
          // Zero is the addon saying it could not find out, which is the same answer as an addon
          // too old to be asked, and both are the defaults.
          this.connectionInfo.lspPort = servedPort(message.lsp_port);
          this.connectionInfo.dapPort = servedPort(message.dap_port);
          this.connectionInfo.debugPort = servedPort(message.debug_port);
          this.log('info', `Godot ready: ${message.project_path}`);
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
    resourceKey?: string,
  ): Promise<unknown> {
    if (!this.isConnected()) {
      return Promise.reject(new Error('Godot is not connected'));
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
        reject(new Error(`Tool ${toolName} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      this.pendingRequests.set(requestId, {
        toolName,
        timeout,
        resolve,
        reject,
        startedAt: Date.now(),
        resourceKey,
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
      if (!this.isConnected()) {
        return;
      }

      try {
        const ping: PingMessage = { type: 'ping' };
        this.sendMessage(ping);
      } catch (error) {
        this.log('warn', `Failed to send ping: ${errorMessage(error)}`);
      }
    }, KEEPALIVE_INTERVAL_MS);
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
    stranger?.close(OTHER_PROJECT_CLOSE_CODE, said);
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
      (message['error'] === undefined || typeof message['error'] === 'string')
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
