import { readFile, realpath } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isWithinRoot } from './paths.js';

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

const HEADER_TERMINATOR = '\r\n\r\n';

/**
 * A ceiling on the bytes held while waiting for a message to complete.
 *
 * Without one, a peer that announces a Content-Length and then stops sending grows this
 * process until it dies, and says nothing on the way. The largest real traffic on this
 * socket is a completion list over the whole global scope or the diagnostics for a very
 * long script, both of which Godot answers in hundreds of kilobytes; 32 MiB is two orders
 * of magnitude above that, so reaching it means the stream is broken rather than busy.
 */
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

/**
 * Normalise a file URI so the same file always produces the same key.
 *
 * Godot and Node spell a Windows path differently. Since Godot 4.5 the language server
 * encodes URIs per RFC 3986, which percent-encodes the drive colon:
 *
 *   Godot: file:///C%3A/Users/me/game/player.gd
 *   Node:  file:///C:/Users/me/game/player.gd    (pathToFileURL, per WHATWG URL)
 *
 * Both are valid and both name the same file, but they are not equal as strings, so a
 * waiter registered under one is never found under the other. Decoding puts them in the
 * same shape. On Linux and macOS there is no drive letter, the two already agree, and this
 * is a no-op.
 */
function diagnosticsKey(uri: string): string {
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}

export class GodotLSPClient {
  private socket: Socket | null = null;
  private connected = false;
  private port: number;
  private host: string;
  private requestId = 0;
  private pendingRequests: Map<number, PendingRequest>;
  // Bytes, not a string. Content-Length counts bytes, while every string index in
  // JavaScript counts UTF-16 code units, and the two stop agreeing at the first character
  // outside ASCII: an accented project name desynchronises the stream for good.
  private buffer: Buffer = Buffer.alloc(0);

  private connectPromise: Promise<void> | null = null;
  private initialized = false;
  private rootPath: string | null = null;
  private diagnosticsWaiters = new Map<string, DiagnosticsWaiter>();
  private documentVersions = new Map<string, number>();

  constructor(port = 6005, host = '127.0.0.1') {
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
        this.buffer = Buffer.alloc(0);

        if (!settled) {
          settled = true;
          resolveConnect();
        }
      });

      socket.on('data', (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.parseMessages();

        if (this.buffer.length > MAX_MESSAGE_BYTES) {
          this.failOversizedStream(`${this.buffer.length} bytes buffered with no complete message`);
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
      return;
    }

    const socketToClose = this.socket;
    this.socket = null;
    this.connected = false;
    this.initialized = false;

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
      throw new Error('Not connected to Godot LSP');
    }

    this.requestId += 1;
    const id = this.requestId;

    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const content = JSON.stringify(payload);
    const framed = this.frameMessage(content);

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
      throw new Error('Not connected to Godot LSP');
    }

    const payload = {
      jsonrpc: '2.0',
      method,
      params,
    };

    const content = JSON.stringify(payload);
    const framed = this.frameMessage(content);

    this.socket.write(framed);
  }

  private frameMessage(content: string): Buffer {
    const body = Buffer.from(content, 'utf8');
    // Header and body come from the same encode, so the announced length is always the
    // number of bytes that follow it.
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}${HEADER_TERMINATOR}`, 'ascii'), body]);
  }

  private parseMessages(): void {
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_TERMINATOR);
      if (headerEnd === -1) {
        return;
      }

      // Headers are ASCII by specification, so latin1 decodes them one byte to one
      // character and the offsets below stay byte offsets.
      const header = this.buffer.toString('latin1', 0, headerEnd);
      const contentLengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
      if (!contentLengthMatch?.[1]) {
        this.buffer = this.buffer.subarray(headerEnd + HEADER_TERMINATOR.length);
        continue;
      }

      const contentLength = Number.parseInt(contentLengthMatch[1], 10);
      if (contentLength > MAX_MESSAGE_BYTES) {
        this.failOversizedStream(`a peer announced a ${contentLength} byte message`);
        return;
      }

      const bodyStart = headerEnd + HEADER_TERMINATOR.length;
      const bodyEnd = bodyStart + contentLength;

      if (this.buffer.length < bodyEnd) {
        return;
      }

      const body = this.buffer.toString('utf8', bodyStart, bodyEnd);
      this.buffer = this.buffer.subarray(bodyEnd);

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch (error) {
        // A body that will not parse is the only symptom a framing fault has, and skipping
        // it in silence leaves the stream desynchronised with nothing on any log to say so.
        console.error(
          `[GodotLSP] Discarding a ${contentLength} byte message that is not JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }

      if (!parsed || typeof parsed !== 'object') {
        continue;
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
    this.buffer = Buffer.alloc(0);
    socket?.destroy();

    const overflow = new Error(
      `Godot LSP stream exceeded the ${MAX_MESSAGE_BYTES} byte ceiling: ${detail}. The connection was dropped.`,
    );
    this.rejectAllPending(overflow);
    this.rejectAllDiagnosticsWaiters(overflow);
  }

  private handleSocketFailure(error: Error): void {
    this.connected = false;
    this.initialized = false;
    this.socket = null;
    const failure = new Error(`Godot LSP connection error: ${error.message}`);
    this.rejectAllPending(failure);
    this.rejectAllDiagnosticsWaiters(failure);
  }

  private handleSocketClose(): void {
    this.connected = false;
    this.initialized = false;
    this.socket = null;
    const closed = new Error('Godot LSP socket closed');
    this.rejectAllPending(closed);
    this.rejectAllDiagnosticsWaiters(closed);
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

export function createLSPTools(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}[] {
  return [
    {
      name: 'lsp_get_diagnostics',
      description: 'Get GDScript diagnostics from Godot Language Server for a script file.',
      inputSchema: {
        type: 'object',
        properties: {
          projectPath: { type: 'string', description: 'Absolute path to Godot project root' },
          scriptPath: { type: 'string', description: 'Path to script relative to project root' },
        },
        required: ['projectPath', 'scriptPath'],
      },
    },
    {
      name: 'lsp_get_completions',
      description: 'Get code completions from Godot Language Server at a given position.',
      inputSchema: {
        type: 'object',
        properties: {
          projectPath: { type: 'string', description: 'Absolute path to Godot project root' },
          scriptPath: { type: 'string', description: 'Path to script relative to project root' },
          line: { type: 'number', description: 'Zero-based line number' },
          character: { type: 'number', description: 'Zero-based character offset' },
        },
        required: ['projectPath', 'scriptPath', 'line', 'character'],
      },
    },
    {
      name: 'lsp_get_hover',
      description: 'Get hover information from Godot Language Server at a given position.',
      inputSchema: {
        type: 'object',
        properties: {
          projectPath: { type: 'string', description: 'Absolute path to Godot project root' },
          scriptPath: { type: 'string', description: 'Path to script relative to project root' },
          line: { type: 'number', description: 'Zero-based line number' },
          character: { type: 'number', description: 'Zero-based character offset' },
        },
        required: ['projectPath', 'scriptPath', 'line', 'character'],
      },
    },
    {
      name: 'lsp_get_symbols',
      description: 'Get document symbols for a GDScript file from Godot Language Server.',
      inputSchema: {
        type: 'object',
        properties: {
          projectPath: { type: 'string', description: 'Absolute path to Godot project root' },
          scriptPath: { type: 'string', description: 'Path to script relative to project root' },
        },
        required: ['projectPath', 'scriptPath'],
      },
    },
  ];
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

function normalizeLSPError(error: unknown): string {
  if (error instanceof Error) {
    if (
      error.message.includes('ECONNREFUSED') ||
      error.message.includes('Failed to connect to Godot LSP') ||
      error.message.includes('socket closed')
    ) {
      return 'Godot LSP is unavailable. Start the Godot editor and enable Language Server in Editor Settings (port 6005 by default).';
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
    throw new Error(`Project path does not exist: ${requestedProjectPath}`);
  }

  const requestedScriptPath = resolve(projectPath, scriptPathValue);
  let scriptPath: string;
  try {
    scriptPath = await realpath(requestedScriptPath);
  } catch {
    throw new Error(`Script file does not exist: ${requestedScriptPath}`);
  }

  if (!isWithinRoot(projectPath, scriptPath)) {
    throw new Error('scriptPath resolves outside the project root boundary.');
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
      throw new Error('Tool arguments must be an object.');
    }

    const parsedArgs = args as JsonRecord;
    const projectPathValue = parsedArgs['projectPath'];
    const scriptPathValue = parsedArgs['scriptPath'];

    if (typeof projectPathValue !== 'string' || projectPathValue.length === 0) {
      throw new Error('Missing required argument: projectPath');
    }

    if (typeof scriptPathValue !== 'string' || scriptPathValue.length === 0) {
      throw new Error('Missing required argument: scriptPath');
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
          throw new Error('Arguments line and character must be numbers.');
        }

        const completions = await client.getCompletions(scriptPath, content, line, character);
        return asToolResponse({ completions });
      }

      case 'lsp_get_hover': {
        const line = Number(parsedArgs['line']);
        const character = Number(parsedArgs['character']);

        if (!Number.isFinite(line) || !Number.isFinite(character)) {
          throw new Error('Arguments line and character must be numbers.');
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
      error: normalizeLSPError(error),
    });
  }
}
