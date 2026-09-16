import { realpathSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Refusal } from './errors.js';
import { FrameReader, frame, OversizedStreamError } from './framing.js';
import { isWithinRoot, resolveWithinProject } from './paths.js';
import { portFromEnv } from './ports.js';

/** What an editor serves the language server on when nothing has moved it. */
export const DEFAULT_LSP_PORT = 6005;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

interface DiagnosticsWaiter {
  resolve: (diagnostics: unknown[]) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

type JsonRecord = Record<string, unknown>;

const DIAGNOSTICS_TIMEOUT_MS = 5000;

/**
 * Normalise a file URI so the same file always produces the same key.
 *
 * Windows spells one path several ways, and a waiter registered under one spelling is never
 * found under another, so diagnostics simply never arrive while every other request answers.
 *
 *   file:///C%3A/Users/me/game/player.gd   Godot, which encodes per RFC 3986 since 4.5
 *   file:///C:/Users/me/game/player.gd     Node's pathToFileURL, per WHATWG URL
 *   file:///C:/Users/RUNNER~1/...          the 8.3 name, which is what TEMP holds on a runner
 *
 * Decoding settles the first, and resolving the path settles the rest: the OS answers with the
 * long name in the case the filesystem holds, and lowercasing matches the way Windows compares
 * its own paths. On Linux and macOS the spellings already agree and only the decode applies.
 */
function diagnosticsKey(uri: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    decoded = uri;
  }

  if (process.platform !== 'win32') {
    return decoded;
  }

  try {
    return realpathSync.native(fileURLToPath(decoded)).toLowerCase();
  } catch {
    // A URI for a file that is gone, or one that is not a file URI at all. Both sides still
    // agree on the string, which is all a key has to do.
    return decoded.toLowerCase();
  }
}

export class GodotLSPClient {
  private socket: Socket | null = null;
  private connected = false;
  /** Public so a caller can tell when the editor it is following has moved to another one. */
  readonly port: number;
  private host: string;
  private requestId = 0;
  private pendingRequests: Map<number, PendingRequest>;
  private reader = new FrameReader();

  private connectPromise: Promise<void> | null = null;
  private initialized = false;
  private rootPath: string | null = null;
  private diagnosticsWaiters = new Map<string, DiagnosticsWaiter>();
  private documentVersions = new Map<string, number>();

  constructor(port = portFromEnv('GDHARNESS_LSP_PORT', DEFAULT_LSP_PORT), host = '127.0.0.1') {
    this.port = port;
    this.host = host;
    this.pendingRequests = new Map<number, PendingRequest>();
  }

  async connect(): Promise<void> {
    if (this.connected && this.socket) {
      return;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>((resolveConnect, rejectConnect) => {
      let settled = false;

      const socket = createConnection({ port: this.port, host: this.host }, () => {
        this.socket = socket;
        this.connected = true;
        this.reader = new FrameReader();

        if (!settled) {
          settled = true;
          resolveConnect();
        }
      });

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
              `[GodotLSP] Discarding a ${received.byteLength} byte message that is not JSON: ${received.reason}`,
            );
            continue;
          }
          this.handleMessage(received.value);
        }
      });

      socket.on('error', (error: Error) => {
        if (!settled && !this.connected) {
          settled = true;
          rejectConnect(
            new Error(`Failed to connect to Godot LSP at ${this.host}:${this.port}: ${error.message}`),
          );
        }
        this.handleSocketFailure(error);
      });

      socket.on('close', () => {
        this.handleSocketClose();
      });
    });

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.socket) {
      this.connected = false;
      this.initialized = false;
      this.forgetOpenDocuments();
      return;
    }

    const socketToClose = this.socket;
    this.socket = null;
    this.connected = false;
    this.initialized = false;
    this.forgetOpenDocuments();

    await new Promise<void>((resolveClose) => {
      socketToClose.once('close', () => {
        resolveClose();
      });
      socketToClose.end();
      setTimeout(() => {
        if (!socketToClose.destroyed) {
          socketToClose.destroy();
        }
        resolveClose();
      }, 1000);
    });

    const disconnected = new Error('Disconnected from Godot LSP');
    this.rejectAllPending(disconnected);
    this.rejectAllDiagnosticsWaiters(disconnected);
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connected || !this.socket) {
      await this.connect();
    }
  }

  private async ensureInitializedForFile(filePath: string): Promise<void> {
    if (this.initialized) {
      return;
    }

    const rootPath = this.rootPath ?? dirname(resolve(filePath));
    await this.initialize(rootPath);
  }

  private async sendRequest(method: string, params?: unknown): Promise<unknown> {
    await this.ensureConnected();

    if (!this.socket) {
      throw new Refusal('Not connected to Godot LSP');
    }

    this.requestId += 1;
    const id = this.requestId;

    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const framed = frame(payload);

    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        rejectRequest(new Error(`LSP request timed out after 10s: ${method}`));
      }, 10000);

      this.pendingRequests.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
      });

      const socket = this.socket;
      if (!socket) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        rejectRequest(new Error(`Not connected while sending LSP request ${method}`));
        return;
      }

      socket.write(framed, (error?: Error | null) => {
        if (error) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          rejectRequest(new Error(`Failed to send LSP request ${method}: ${error.message}`));
        }
      });
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    if (!this.connected || !this.socket) {
      throw new Refusal('Not connected to Godot LSP');
    }

    const payload = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.socket.write(frame(payload));
  }

  private handleMessage(parsed: unknown): void {
    if (!parsed || typeof parsed !== 'object') {
      return;
    }

    const message: JsonRecord = parsed as JsonRecord;

    if (typeof message['id'] === 'number') {
      const pending = this.pendingRequests.get(message['id']);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message['id']);

        const errorPayload = message['error'];
        if (errorPayload && typeof errorPayload === 'object') {
          const errorObject = errorPayload as JsonRecord;
          const code = typeof errorObject['code'] === 'number' ? errorObject['code'] : 'unknown';
          const messageText =
            typeof errorObject['message'] === 'string' ? errorObject['message'] : 'Unknown LSP error';
          pending.reject(new Error(`LSP error (${code}): ${messageText}`));
        } else {
          pending.resolve(message['result']);
        }
      }
    }

    if (message['method'] === 'textDocument/publishDiagnostics') {
      const params = message['params'];
      const paramsObject = params && typeof params === 'object' ? (params as JsonRecord) : null;
      const uri = paramsObject && typeof paramsObject['uri'] === 'string' ? paramsObject['uri'] : null;
      const diagnostics =
        paramsObject && Array.isArray(paramsObject['diagnostics'])
          ? (paramsObject['diagnostics'] as unknown[])
          : [];
      if (typeof uri === 'string') {
        const key = diagnosticsKey(uri);
        const waiter = this.diagnosticsWaiters.get(key);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.diagnosticsWaiters.delete(key);
          waiter.resolve(diagnostics);
        }
      }
    }
  }

  /**
   * Drop a connection whose framing has run away, naming the size that did it.
   *
   * Nothing downstream can recover from a stream this far out of step, and waiting quietly
   * for the rest of a body that is never coming is indistinguishable from an idle server.
   */
  private failOversizedStream(detail: string): void {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.initialized = false;
    this.reader = new FrameReader();
    socket?.destroy();

    const overflow = new Error(`Godot LSP ${detail}. The connection was dropped.`);
    this.rejectAllPending(overflow);
    this.rejectAllDiagnosticsWaiters(overflow);
  }

  private handleSocketFailure(error: Error): void {
    this.connected = false;
    this.initialized = false;
    this.socket = null;
    this.forgetOpenDocuments();
    const failure = new Error(`Godot LSP connection error: ${error.message}`);
    this.rejectAllPending(failure);
    this.rejectAllDiagnosticsWaiters(failure);
  }

  private handleSocketClose(): void {
    this.connected = false;
    this.initialized = false;
    this.socket = null;
    this.forgetOpenDocuments();
    const closed = new Error('Godot LSP socket closed');
    this.rejectAllPending(closed);
    this.rejectAllDiagnosticsWaiters(closed);
  }

  /**
   * Forget which documents the server has been told about.
   *
   * A version above zero means didOpen has gone out, so the next sync sends didChange instead.
   * That is true of the connection it went out on and of no other: an editor that restarts is a
   * language server with no record of the document, and Godot publishes nothing at all for a
   * didChange naming one it never opened. This client outlives the editor, so every file asked
   * about before a restart went silent afterwards, with the same socket answering documentSymbol
   * on the same file completely and currently. Reproduced on two projects and on two versions.
   */
  private forgetOpenDocuments(): void {
    this.documentVersions.clear();
  }

  private rejectAllPending(error: Error): void {
    this.pendingRequests.forEach((pending, id) => {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingRequests.delete(id);
    });
  }

  /**
   * Fail every waiter, for the same reason the timeout does: a lost connection is not a
   * file without problems, and resolving [] here reports one as the other.
   */
  private rejectAllDiagnosticsWaiters(error: Error): void {
    this.diagnosticsWaiters.forEach((waiter, uri) => {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.diagnosticsWaiters.delete(uri);
    });
  }

  private toFileUri(filePath: string): string {
    return pathToFileURL(resolve(filePath)).href;
  }

  private syncDocument(filePath: string, content: string): string {
    const uri = this.toFileUri(filePath);
    const currentVersion = this.documentVersions.get(uri) ?? 0;
    const nextVersion = currentVersion + 1;
    this.documentVersions.set(uri, nextVersion);

    if (currentVersion === 0) {
      this.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: 'gdscript',
          version: nextVersion,
          text: content,
        },
      });
    } else {
      this.sendNotification('textDocument/didChange', {
        textDocument: {
          uri,
          version: nextVersion,
        },
        contentChanges: [
          {
            text: content,
          },
        ],
      });
    }

    return uri;
  }

  async initialize(rootPath: string): Promise<unknown> {
    await this.ensureConnected();

    const resolvedRootPath = resolve(rootPath);
    const rootUri = pathToFileURL(resolvedRootPath).href;

    const result = await this.sendRequest('initialize', {
      processId: process.pid,
      rootPath: resolvedRootPath,
      rootUri,
      capabilities: {
        textDocument: {
          publishDiagnostics: {},
          completion: {
            completionItem: {
              snippetSupport: true,
            },
          },
          hover: {
            contentFormat: ['markdown', 'plaintext'],
          },
          documentSymbol: {},
        },
      },
      workspaceFolders: [
        {
          uri: rootUri,
          name: resolvedRootPath,
        },
      ],
    });

    this.sendNotification('initialized', {});

    this.initialized = true;
    this.rootPath = resolvedRootPath;

    return result;
  }

  async getDiagnostics(filePath: string, content: string): Promise<unknown[]> {
    await this.ensureConnected();
    await this.ensureInitializedForFile(filePath);

    const key = diagnosticsKey(this.toFileUri(filePath));

    const diagnosticsPromise = new Promise<unknown[]>((resolveDiagnostics, rejectDiagnostics) => {
      const existing = this.diagnosticsWaiters.get(key);
      if (existing) {
        clearTimeout(existing.timer);
      }

      const timer = setTimeout(() => {
        this.diagnosticsWaiters.delete(key);
        // Not an empty array. Godot publishes an empty diagnostics list for a file that
        // really is clean, so resolving [] here makes a broken language server look
        // exactly like healthy code, and the caller has no way to tell the two apart.
        rejectDiagnostics(
          new Error(
            `Godot published no diagnostics for ${key} within ${DIAGNOSTICS_TIMEOUT_MS}ms. ` +
              'The language server may not be running, or may not have this file in its workspace.',
          ),
        );
      }, DIAGNOSTICS_TIMEOUT_MS);

      this.diagnosticsWaiters.set(key, {
        resolve: resolveDiagnostics,
        reject: rejectDiagnostics,
        timer,
      });
    });

    try {
      this.syncDocument(filePath, content);
      return await diagnosticsPromise;
    } catch (error) {
      const waiter = this.diagnosticsWaiters.get(key);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.diagnosticsWaiters.delete(key);
      }
      throw error;
    }
  }

  async getCompletions(
    filePath: string,
    content: string,
    line: number,
    character: number,
  ): Promise<unknown[]> {
    await this.ensureConnected();
    await this.ensureInitializedForFile(filePath);

    const uri = this.syncDocument(filePath, content);
    const result = await this.sendRequest('textDocument/completion', {
      textDocument: { uri },
      position: { line, character },
    });

    if (Array.isArray(result)) {
      return result as unknown[];
    }

    if (result && typeof result === 'object') {
      const items = (result as JsonRecord)['items'];
      if (Array.isArray(items)) {
        return items as unknown[];
      }
    }

    return [];
  }

  async getHover(filePath: string, content: string, line: number, character: number): Promise<unknown> {
    await this.ensureConnected();
    await this.ensureInitializedForFile(filePath);

    const uri = this.syncDocument(filePath, content);
    return this.sendRequest('textDocument/hover', {
      textDocument: { uri },
      position: { line, character },
    });
  }

  async getDocumentSymbols(filePath: string, content: string): Promise<unknown[]> {
    await this.ensureConnected();
    await this.ensureInitializedForFile(filePath);

    const uri = this.syncDocument(filePath, content);
    const result = await this.sendRequest('textDocument/documentSymbol', {
      textDocument: { uri },
    });

    return Array.isArray(result) ? (result as unknown[]) : [];
  }

  isConnected(): boolean {
    return this.connected;
  }
}

function asToolResponse(payload: unknown): { content: { type: string; text: string }[] } {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

/**
 * The port is the client's rather than the default's, because the two come apart: an editor that
 * was moved off 6005 is exactly the case where somebody needs to be told which port was tried.
 */
function normalizeLSPError(error: unknown, port: number): string {
  if (error instanceof Error) {
    if (
      error.message.includes('ECONNREFUSED') ||
      error.message.includes('Failed to connect to Godot LSP') ||
      error.message.includes('socket closed')
    ) {
      return `Godot LSP is unavailable on port ${port}. Start the Godot editor and enable Language Server in Editor Settings, or set GDHARNESS_LSP_PORT to the port it serves.`;
    }
    return error.message;
  }

  return String(error);
}

async function resolveLSPPaths(
  projectPathValue: string,
  scriptPathValue: string,
): Promise<{ projectPath: string; scriptPath: string }> {
  const requestedProjectPath = resolve(projectPathValue);
  let projectPath: string;
  try {
    projectPath = await realpath(requestedProjectPath);
  } catch {
    throw new Refusal(`Project path does not exist: ${requestedProjectPath}`);
  }

  // The project's own reader rather than a plain resolve, so `res://scripts/a.gd` names the same
  // file here as it does everywhere else in the server: it is the spelling Godot itself uses, and
  // resolving it literally made a path with `res:` in the middle and reported the file missing.
  const contained = resolveWithinProject(projectPath, scriptPathValue);
  if (!contained.ok) {
    throw new Refusal(contained.reason);
  }

  let scriptPath: string;
  try {
    scriptPath = await realpath(contained.absolutePath);
  } catch {
    throw new Refusal(`Script file does not exist: ${contained.absolutePath}`);
  }

  if (!isWithinRoot(projectPath, scriptPath)) {
    throw new Refusal('scriptPath resolves outside the project root boundary.');
  }

  return { projectPath, scriptPath };
}

export async function handleLSPTool(
  client: GodotLSPClient,
  toolName: string,
  args: unknown,
): Promise<{ content: { type: string; text: string }[] }> {
  try {
    if (!args || typeof args !== 'object') {
      throw new Refusal('Tool arguments must be an object.');
    }

    const parsedArgs = args as JsonRecord;
    const projectPathValue = parsedArgs['projectPath'];
    const scriptPathValue = parsedArgs['scriptPath'];

    if (typeof projectPathValue !== 'string' || projectPathValue.length === 0) {
      throw new Refusal('Missing required argument: projectPath');
    }

    if (typeof scriptPathValue !== 'string' || scriptPathValue.length === 0) {
      throw new Refusal('Missing required argument: scriptPath');
    }

    const { projectPath, scriptPath } = await resolveLSPPaths(projectPathValue, scriptPathValue);
    const content = await readFile(scriptPath, 'utf8');

    await client.initialize(projectPath);

    switch (toolName) {
      case 'lsp_get_diagnostics': {
        const diagnostics = await client.getDiagnostics(scriptPath, content);
        return asToolResponse({ diagnostics });
      }

      case 'lsp_get_completions': {
        const line = Number(parsedArgs['line']);
        const character = Number(parsedArgs['character']);

        if (!Number.isFinite(line) || !Number.isFinite(character)) {
          throw new Refusal('Arguments line and character must be numbers.');
        }

        const completions = await client.getCompletions(scriptPath, content, line, character);
        return asToolResponse({ completions });
      }

      case 'lsp_get_hover': {
        const line = Number(parsedArgs['line']);
        const character = Number(parsedArgs['character']);

        if (!Number.isFinite(line) || !Number.isFinite(character)) {
          throw new Refusal('Arguments line and character must be numbers.');
        }

        const hover = await client.getHover(scriptPath, content, line, character);
        return asToolResponse({ hover });
      }

      case 'lsp_get_symbols': {
        const symbols = await client.getDocumentSymbols(scriptPath, content);
        return asToolResponse({ symbols });
      }

      default:
        return asToolResponse({ error: `Unknown LSP tool: ${toolName}` });
    }
  } catch (error) {
    return asToolResponse({
      error: normalizeLSPError(error, client.port),
    });
  }
}
