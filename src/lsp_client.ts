import { existsSync, realpathSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { answerJson } from './answer-json.js';
import { Refusal } from './errors.js';
import { FrameReader, frame, OversizedStreamError } from './framing.js';
import { envValue } from './launch.js';
import { isSameDirectory, isWithinRoot, resolveWithinProject } from './paths.js';
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

/** What a request is given unless it says otherwise: one position answered from the open script. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * What a references request is given. Godot answers one by looking for the name's text in every
 * script of the project and resolving each match, so its cost grows with how often the word is
 * written, not with how often the symbol is used: a method named like the project's commonest local
 * ran past ten seconds on a project where a rarer name in the same class answered in a few.
 */
const REFERENCES_TIMEOUT_MS = 180_000;

/**
 * What an initialize is given. Godot reads every script in the project while answering the first
 * one after its editor starts, and answers every later one at once: on 4.7.2, a project of 3000
 * small generated scripts took 7.3 s the first time and 1 ms the second, and a project with larger
 * scripts ran past the ten seconds every request was given, on the first call after editor_launch.
 * A project whose language server reads for longer sets GDHARNESS_LSP_INITIALIZE_TIMEOUT_MS.
 */
function initializeTimeoutMs(): number {
  const override = Number.parseInt(envValue('GDHARNESS_LSP_INITIALIZE_TIMEOUT_MS') ?? '', 10);
  return Number.isInteger(override) && override > 0 ? override : 180_000;
}

/** How long a request is given, references and initialize apart from the rest. */
export interface LSPTimeouts {
  readonly requestMs: number;
  readonly referencesMs: number;
  readonly initializeMs: number;
}

/** A request the server took in but did not answer in the time it was given. */
export class LSPTimeout extends Error {
  readonly method: string;
  readonly seconds: number;

  constructor(method: string, timeoutMs: number) {
    super(`LSP request timed out after ${String(timeoutMs / 1000)}s: ${method}`);
    this.method = method;
    this.seconds = timeoutMs / 1000;
  }
}

/** A call refused for what it was asked, which no language server could answer either. */
class ArgumentRefusal extends Refusal {}

/**
 * A server that took a file in and published nothing for it in the time given. About that file
 * rather than the server, which answered the files before it: one not in its workspace is the
 * case named in the message, so a call asking about several goes on to the next.
 */
class NoDiagnosticsPublished extends Error {}

/** A language server that belongs to an editor of another project than the one asked about. */
class AnotherProjectsServer extends Refusal {
  readonly serves: string;

  constructor(port: number, serves: string, asked: string) {
    super(`The language server on port ${port} belongs to the editor of ${serves}, not ${asked}.`);
    this.serves = serves;
  }
}

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
  /** The project the server named as its own while answering the last initialize, or null. */
  private servedWorkspace: string | null = null;
  private diagnosticsWaiters = new Map<string, DiagnosticsWaiter>();
  private documentVersions = new Map<string, number>();
  /** The last ask queued on each file, which the next one waits behind; see [withDocument]. */
  private documentTurns = new Map<string, Promise<void>>();

  private readonly timeouts: LSPTimeouts;

  constructor(
    port = portFromEnv('GDHARNESS_LSP_PORT', DEFAULT_LSP_PORT),
    host = '127.0.0.1',
    timeouts: LSPTimeouts = {
      requestMs: REQUEST_TIMEOUT_MS,
      referencesMs: REFERENCES_TIMEOUT_MS,
      initializeMs: initializeTimeoutMs(),
    },
  ) {
    this.port = port;
    this.host = host;
    this.timeouts = timeouts;
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

  private async sendRequest(
    method: string,
    params?: unknown,
    timeoutMs = this.timeouts.requestMs,
  ): Promise<unknown> {
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
        rejectRequest(new LSPTimeout(method, timeoutMs));
      }, timeoutMs);

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

    if (message['method'] === 'gdscript_client/changeWorkspace') {
      const path = (message['params'] as JsonRecord | undefined)?.['path'];
      this.servedWorkspace = typeof path === 'string' ? path : null;
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

  /**
   * Give the document back once its answer is in.
   *
   * A file this client has opened is one the language server answers about from the copy it was
   * handed, and it keeps that parse for as long as the document stays open. The parse holds the
   * parses of everything the file depends on, so a `class_name` script edited outside the editor
   * is frozen at whatever it said when some open file first pulled it in, and every member added
   * since reads as missing: `Static function "opening()" not found in base "Components"` about a
   * static function the engine compiles and runs.
   *
   * Nothing on the editor side clears that. A filesystem scan, which is all `editor_rescan` can
   * ask for, rebuilds the editor's own list and reaches neither cache. Asking a second time
   * re-parses only the file asked about, while every other document still open goes on pinning
   * the stale dependency, so two files that use one class hold each other's answer wrong.
   *
   * Closing releases both. A file the client does not own is read from disk, and the engine
   * deliberately declines to cache that parse past the request, "since we can't invalidate the
   * cache properly". Holding documents open opts into exactly the cache it is refusing to keep.
   */
  private closeDocument(uri: string): void {
    if (!this.documentVersions.delete(uri)) {
      return;
    }
    try {
      this.sendNotification('textDocument/didClose', { textDocument: { uri } });
    } catch {
      // A connection that has gone holds no documents to give back, and the close is the last
      // thing a failing request does: throwing here would bury whatever actually went wrong.
    }
  }

  /** Only what the server says in answer to the next initialize is about that initialize. */
  private forgetServedWorkspace(): void {
    this.servedWorkspace = null;
  }

  async initialize(rootPath: string): Promise<unknown> {
    await this.ensureConnected();

    const resolvedRootPath = resolve(rootPath);
    const rootUri = pathToFileURL(resolvedRootPath).href;

    this.forgetServedWorkspace();
    const result = await this.sendRequest(
      'initialize',
      {
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
      },
      this.timeouts.initializeMs,
    );

    // Godot serves one project, its editor's, and answers an initialize naming any other root by
    // telling the client to change to its own, ahead of the answer. Whatever it said after that
    // about this project's scripts would be read against the other project's `res://` and its
    // classes, and look like findings in this one.
    const served = this.servedWorkspace;
    if (served !== null && !isSameDirectory(served, resolvedRootPath)) {
      throw new AnotherProjectsServer(this.port, served, resolvedRootPath);
    }

    this.sendNotification('initialized', {});

    this.initialized = true;
    this.rootPath = resolvedRootPath;

    return result;
  }

  /**
   * Run [work] on one file with no other ask about that file in flight.
   *
   * An ask is an open, an answer and a close, and two at once on one file share all three: the
   * second found the first's document open and sent a change, the first closed the document under
   * the second, and the second's diagnostics waiter replaced the first's, which was left with no
   * timer and nothing that would ever settle it. A parallel sweep naming a file twice, or a retry
   * sent before the first answer, is enough.
   */
  private async withDocument<T>(filePath: string, work: () => Promise<T>): Promise<T> {
    const key = diagnosticsKey(this.toFileUri(filePath));
    const before = this.documentTurns.get(key) ?? Promise.resolve();
    let done = (): void => {};
    const mine = new Promise<void>((finished) => {
      done = finished;
    });
    const turn = before.then(() => mine);
    this.documentTurns.set(key, turn);
    await before;
    try {
      return await work();
    } finally {
      done();
      if (this.documentTurns.get(key) === turn) {
        this.documentTurns.delete(key);
      }
    }
  }

  async getDiagnostics(filePath: string, content: string): Promise<unknown[]> {
    await this.ensureConnected();
    await this.ensureInitializedForFile(filePath);

    return this.withDocument(filePath, async () => {
      const key = diagnosticsKey(this.toFileUri(filePath));

      const diagnosticsPromise = new Promise<unknown[]>((resolveDiagnostics, rejectDiagnostics) => {
        const timer = setTimeout(() => {
          this.diagnosticsWaiters.delete(key);
          // Not an empty array. Godot publishes an empty diagnostics list for a file that
          // really is clean, so resolving [] here makes a broken language server look
          // exactly like healthy code, and the caller has no way to tell the two apart.
          rejectDiagnostics(
            new NoDiagnosticsPublished(
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

      let opened: string | null = null;
      try {
        opened = this.syncDocument(filePath, content);
        return await diagnosticsPromise;
      } catch (error) {
        const waiter = this.diagnosticsWaiters.get(key);
        if (waiter) {
          clearTimeout(waiter.timer);
          this.diagnosticsWaiters.delete(key);
        }
        throw error;
      } finally {
        if (opened !== null) {
          this.closeDocument(opened);
        }
      }
    });
  }

  async getCompletions(
    filePath: string,
    content: string,
    line: number,
    character: number,
  ): Promise<unknown[]> {
    await this.ensureConnected();
    await this.ensureInitializedForFile(filePath);

    const result = await this.withDocument(filePath, async () => {
      const uri = this.syncDocument(filePath, content);
      try {
        return await this.sendRequest('textDocument/completion', {
          textDocument: { uri },
          position: { line, character },
        });
      } finally {
        this.closeDocument(uri);
      }
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

    return this.withDocument(filePath, async () => {
      const uri = this.syncDocument(filePath, content);
      try {
        return await this.sendRequest('textDocument/hover', {
          textDocument: { uri },
          position: { line, character },
        });
      } finally {
        this.closeDocument(uri);
      }
    });
  }

  /**
   * Every place the language server resolves to the symbol at a position, declaration included,
   * as file paths and zero-based positions.
   *
   * Godot finds these by looking for the symbol's name in every script of the project and keeping
   * the places that resolve to the same symbol, so the answer carries the word wherever it occurs in
   * a comment or a string too, resolved by name alone: a caller renaming from it has to tell those
   * apart itself.
   */
  async getReferences(
    filePath: string,
    content: string,
    line: number,
    character: number,
  ): Promise<{ file: string; line: number; character: number }[]> {
    await this.ensureConnected();
    await this.ensureInitializedForFile(filePath);

    const result = await this.withDocument(filePath, async () => {
      const uri = this.syncDocument(filePath, content);
      try {
        return await this.sendRequest(
          'textDocument/references',
          {
            textDocument: { uri },
            position: { line, character },
            context: { includeDeclaration: true },
          },
          this.timeouts.referencesMs,
        );
      } finally {
        this.closeDocument(uri);
      }
    });

    return locationsIn(result);
  }

  /**
   * Where the language server says the symbol at a position is declared. More than one place is
   * the analyser not knowing the type the name is looked up on and offering every declaration of
   * that name it has, which is a guess rather than a resolution.
   */
  async getDefinitions(
    filePath: string,
    content: string,
    line: number,
    character: number,
  ): Promise<{ file: string; line: number; character: number }[]> {
    await this.ensureConnected();
    await this.ensureInitializedForFile(filePath);

    const result = await this.withDocument(filePath, async () => {
      const uri = this.syncDocument(filePath, content);
      try {
        return await this.sendRequest('textDocument/definition', {
          textDocument: { uri },
          position: { line, character },
        });
      } finally {
        this.closeDocument(uri);
      }
    });

    return locationsIn(result);
  }

  async getDocumentSymbols(filePath: string, content: string): Promise<unknown[]> {
    await this.ensureConnected();
    await this.ensureInitializedForFile(filePath);

    const result = await this.withDocument(filePath, async () => {
      const uri = this.syncDocument(filePath, content);
      try {
        return await this.sendRequest('textDocument/documentSymbol', {
          textDocument: { uri },
        });
      } finally {
        this.closeDocument(uri);
      }
    });

    return Array.isArray(result) ? (result as unknown[]) : [];
  }

  isConnected(): boolean {
    return this.connected;
  }
}

/** The file positions in a Location, a list of them, or a list of LocationLinks. */
function locationsIn(result: unknown): { file: string; line: number; character: number }[] {
  const entries = Array.isArray(result)
    ? (result as unknown[])
    : result === null || result === undefined
      ? []
      : [result];
  const found: { file: string; line: number; character: number }[] = [];
  for (const entry of entries) {
    const location = entry as {
      uri?: unknown;
      range?: { start?: { line?: unknown; character?: unknown } };
      targetUri?: unknown;
      targetSelectionRange?: { start?: { line?: unknown; character?: unknown } };
    };
    const uri = location.uri ?? location.targetUri;
    const start = location.range?.start ?? location.targetSelectionRange?.start;
    if (typeof uri !== 'string' || typeof start?.line !== 'number' || typeof start.character !== 'number') {
      continue;
    }
    try {
      found.push({ file: fileURLToPath(uri), line: start.line, character: start.character });
    } catch {
      // A location that is not a file is nothing a rename can write.
    }
  }
  return found;
}

function asToolResponse(payload: unknown): { content: { type: string; text: string }[] } {
  return {
    content: [
      {
        type: 'text',
        text: answerJson(payload),
      },
    ],
  };
}

/**
 * The port is the client's rather than the default's, because the two come apart: an editor that
 * was moved off 6005 is exactly the case where somebody needs to be told which port was tried.
 */
export function normalizeLSPError(error: unknown, port: number): string {
  if (error instanceof Error) {
    if (
      error.message.includes('ECONNREFUSED') ||
      error.message.includes('Failed to connect to Godot LSP') ||
      error.message.includes('socket closed')
    ) {
      return `Godot LSP is unavailable on port ${port}. Start the Godot editor and enable Language Server in Editor Settings, or set GDHARNESS_LSP_PORT to the port it serves.`;
    }
    if (error instanceof LSPTimeout && error.method === 'initialize') {
      return `The language server on port ${port} took the connection and did not answer initialize within ${String(error.seconds)}s. Godot reads every script in the project before it answers the first initialize after its editor starts, and goes on reading after this call stops waiting, so call again once the editor has settled.`;
    }
    return error.message;
  }

  return String(error);
}

/*
 * The language server's answers as the editor shows them rather than as the protocol carries them:
 * lines and columns counted from one, and kinds and severities as words. The protocol counts lines
 * from zero, so every diagnostic named the line above the one the editor, the file and the engine's
 * own errors name, and a caller fixing the line it was given edited the line above the fault.
 */

const SEVERITIES = ['error', 'warning', 'information', 'hint'];

const SYMBOL_KINDS = [
  'file',
  'module',
  'namespace',
  'package',
  'class',
  'method',
  'property',
  'field',
  'constructor',
  'enum',
  'interface',
  'function',
  'variable',
  'constant',
  'string',
  'number',
  'boolean',
  'array',
  'object',
  'key',
  'null',
  'enum member',
  'struct',
  'event',
  'operator',
  'type parameter',
];

const COMPLETION_KINDS = [
  'text',
  'method',
  'function',
  'constructor',
  'field',
  'variable',
  'class',
  'interface',
  'module',
  'property',
  'unit',
  'value',
  'enum',
  'keyword',
  'snippet',
  'color',
  'file',
  'reference',
  'folder',
  'enum member',
  'constant',
  'struct',
  'event',
  'operator',
  'type parameter',
];

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

/** The protocol's numbered kind as its name, or the value as it came when it is not one. */
function named(value: unknown, names: readonly string[]): unknown {
  return typeof value === 'number' && Number.isInteger(value) ? (names[value - 1] ?? value) : value;
}

/** A protocol position counted from one, or null when the server sent something else. */
function shownPosition(position: unknown): { line: number; column: number } | null {
  const { line, character } = asRecord(position);
  return typeof line === 'number' && typeof character === 'number'
    ? { line: line + 1, column: character + 1 }
    : null;
}

/** Where a protocol range starts, and the position just past its end, counted from one. */
function shownRange(range: unknown): Record<string, number> {
  const start = shownPosition(asRecord(range)['start']);
  const end = shownPosition(asRecord(range)['end']);
  return {
    ...(start === null ? {} : { line: start.line, column: start.column }),
    ...(end === null ? {} : { endLine: end.line, endColumn: end.column }),
  };
}

function shownDiagnostic(entry: unknown): JsonRecord {
  const { range, severity, message, code } = asRecord(entry);
  return {
    ...shownRange(range),
    severity: named(severity, SEVERITIES),
    message,
    // Godot sends 0 for every diagnostic, which tells a reader nothing the message does not.
    ...(code === undefined || code === null || code === 0 || code === '' ? {} : { code }),
  };
}

/**
 * A symbol where its name is, which is the position hover and completion are asked at, and the
 * last line of its declaration. Godot also sends an empty documentation and a native class for
 * every symbol, which are left out when they say nothing.
 */
function shownSymbol(entry: unknown): JsonRecord {
  const symbol = asRecord(entry);
  const whole = asRecord(symbol['range'] ?? asRecord(symbol['location'])['range']);
  const at = shownPosition(asRecord(symbol['selectionRange'] ?? whole)['start']);
  const last = shownPosition(whole['end']);
  const children = Array.isArray(symbol['children']) ? (symbol['children'] as unknown[]) : [];
  const { documentation, native_class: nativeClass, deprecated, detail } = symbol;
  return {
    name: symbol['name'],
    kind: named(symbol['kind'], SYMBOL_KINDS),
    ...(typeof detail === 'string' && detail !== '' ? { detail } : {}),
    ...(at === null ? {} : { line: at.line, column: at.column }),
    ...(last === null ? {} : { lastLine: last.line }),
    ...(typeof documentation === 'string' && documentation !== '' ? { documentation } : {}),
    ...(typeof nativeClass === 'string' && nativeClass !== '' ? { nativeClass } : {}),
    ...(deprecated === true ? { deprecated } : {}),
    ...(children.length > 0 ? { children: children.map(shownSymbol) } : {}),
  };
}

/** A completion without the copy of the request Godot hands back with every item. */
function shownCompletion(entry: unknown): JsonRecord {
  const { data: _request, kind, ...rest } = asRecord(entry);
  return { ...rest, kind: named(kind, COMPLETION_KINDS) };
}

function shownHover(hover: unknown): unknown {
  if (hover === null || typeof hover !== 'object') {
    return hover;
  }
  const { range, ...rest } = asRecord(hover);
  return { ...rest, ...shownRange(range) };
}

/** The position a completion or hover names, counted from one, as the protocol counts it. */
function protocolPosition(args: JsonRecord): { line: number; character: number } {
  const line = args['line'];
  const character = args['character'];
  if (
    typeof line !== 'number' ||
    typeof character !== 'number' ||
    !Number.isInteger(line) ||
    !Number.isInteger(character) ||
    line < 1 ||
    character < 1
  ) {
    throw new ArgumentRefusal(
      `line and character are counted from 1, as the editor shows them; got line ${String(line)} and character ${String(character)}.`,
    );
  }
  return { line: line - 1, character: character - 1 };
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
    throw new ArgumentRefusal(`Project path does not exist: ${requestedProjectPath}`);
  }
  if (!existsSync(join(projectPath, 'project.godot'))) {
    throw new ArgumentRefusal(
      `Not a Godot project: ${projectPath}. Point projectPath at the directory holding project.godot.`,
    );
  }

  // The project's own reader rather than a plain resolve, so `res://scripts/a.gd` names the same
  // file here as it does everywhere else in the server: it is the spelling Godot itself uses, and
  // resolving it literally made a path with `res:` in the middle and reported the file missing.
  const contained = resolveWithinProject(projectPath, scriptPathValue);
  if (!contained.ok) {
    throw new ArgumentRefusal(contained.reason);
  }

  let scriptPath: string;
  try {
    scriptPath = await realpath(contained.absolutePath);
  } catch {
    throw new ArgumentRefusal(`Script file does not exist: ${contained.absolutePath}`);
  }

  if (!isWithinRoot(projectPath, scriptPath)) {
    throw new ArgumentRefusal('scriptPath resolves outside the project root boundary.');
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
      throw new ArgumentRefusal('Tool arguments must be an object.');
    }

    const parsedArgs = args as JsonRecord;
    const projectPathValue = parsedArgs['projectPath'];
    const scriptPathValue = parsedArgs['scriptPath'];

    if (typeof projectPathValue !== 'string' || projectPathValue.length === 0) {
      throw new ArgumentRefusal('Missing required argument: projectPath');
    }

    if (typeof scriptPathValue !== 'string' || scriptPathValue.length === 0) {
      throw new ArgumentRefusal('Missing required argument: scriptPath');
    }

    const { projectPath, scriptPath } = await resolveLSPPaths(projectPathValue, scriptPathValue);
    const content = await readFile(scriptPath, 'utf8');

    await client.initialize(projectPath);

    switch (toolName) {
      case 'lsp_get_diagnostics': {
        const diagnostics = await client.getDiagnostics(scriptPath, content);
        return asToolResponse({ diagnostics: diagnostics.map(shownDiagnostic) });
      }

      case 'lsp_get_completions': {
        const { line, character } = protocolPosition(parsedArgs);
        const completions = await client.getCompletions(scriptPath, content, line, character);
        return asToolResponse({ completions: completions.map(shownCompletion) });
      }

      case 'lsp_get_hover': {
        const { line, character } = protocolPosition(parsedArgs);
        const hover = await client.getHover(scriptPath, content, line, character);
        return asToolResponse({ hover: shownHover(hover) });
      }

      case 'lsp_get_symbols': {
        const symbols = await client.getDocumentSymbols(scriptPath, content);
        return asToolResponse({ symbols: symbols.map(shownSymbol) });
      }

      default:
        return asToolResponse({ error: `Unknown LSP tool: ${toolName}` });
    }
  } catch (error) {
    return asToolResponse({
      error: normalizeLSPError(error, client.port),
      ...(error instanceof AnotherProjectsServer ? { serves: error.serves } : {}),
      ...(error instanceof ArgumentRefusal ? { refusedArguments: true } : {}),
      ...(error instanceof NoDiagnosticsPublished ? { aboutThisFile: true } : {}),
      ...(error instanceof LSPTimeout && error.method === 'initialize' ? { stillReading: true } : {}),
    });
  }
}
