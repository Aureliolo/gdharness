import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { type JsonRpcMessage, parseJsonLines } from './json-rpc.js';

/** A runtime directory nothing else on this machine is using. */
function runtimeDirForTest(): string {
  return mkdtempSync(join(tmpdir(), 'gdharness-test-runtime-'));
}

/** A TCP port nothing is listening on right now. */
export async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => {
          reject(new Error('Failed to reserve a TCP port.'));
        });
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

export interface ServerOptions {
  entry?: string;
  env?: Record<string, string>;
  args?: string[];
}

/**
 * The built server as a child process speaking JSON-RPC over stdio.
 *
 * Responses are matched by id as they arrive rather than read after a fixed sleep, so a test
 * waits exactly as long as the server takes and fails with the stderr the server wrote when it
 * dies instead of reporting a missing response.
 */
export class ServerProcess {
  readonly child: ChildProcess;
  stdout = '';
  stderr = '';
  private nextId = 1;
  private readonly waiting = new Map<number | string, (message: JsonRpcMessage) => void>();
  private readonly abandoned = new Set<(reason: Error) => void>();
  private buffered = '';

  /** The runtime directory this server was given, kept so it can be taken away again. */
  /** The runtime directory this server was given, or null when the fixture named its own. */
  readonly runtimeDir: string | null;

  constructor(options: ServerOptions = {}) {
    // A runtime directory of its own, unless the fixture names one. The default is shared by
    // everything on this machine that speaks gdharness: one directory per user, holding the note
    // that says which process a run is. A server started without a project of its own reads any
    // note it finds there as its own and ends that run before starting another, so a test suite
    // run on a developer's machine killed another project's bench six times in fifty minutes,
    // silently, while its owner bisected their own code looking for the cause.
    //
    // Here rather than in each fixture, because the fixture that forgets is the one that does it,
    // and what it costs is never its own run.
    this.runtimeDir = options.env?.['GDHARNESS_RUNTIME_DIR'] === undefined ? runtimeDirForTest() : null;
    this.child = spawn(process.execPath, [options.entry ?? 'build/index.js', ...(options.args ?? [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(this.runtimeDir === null ? {} : { GDHARNESS_RUNTIME_DIR: this.runtimeDir }),
        // No update check either, unless the fixture is about one. A server whose version is
        // behind whatever is published rides a second JSON document on its next answer, so every
        // fixture that parses an answer starts failing the moment a release goes out and keeps
        // failing until its branch takes the version bump. That is the suite depending on the
        // network and on today's date, and it cost an afternoon's confusion once.
        GDHARNESS_NO_UPDATE_CHECK: '1',
        ...options.env,
      },
    });
    this.child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      this.stdout += text;
      this.buffered += text;
      const lines = this.buffered.split('\n');
      this.buffered = lines.pop() ?? '';
      for (const message of parseJsonLines(lines.join('\n'))) {
        if (message.id === undefined || message.id === null) continue;
        const resolve = this.waiting.get(message.id);
        if (resolve) {
          this.waiting.delete(message.id);
          resolve(message);
        }
      }
    });
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    // One exit listener for every request in flight, rather than one per request: a test that
    // makes dozens of calls would otherwise pile listeners onto the child until Node warns.
    this.child.once('exit', () => {
      for (const reject of this.abandoned) {
        reject(new Error(`Server exited before answering.\n${this.stderr}`));
      }
      this.abandoned.clear();
      this.waiting.clear();
    });
  }

  get exited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** Sends a request and resolves with its response, or rejects when the server dies or stalls. */
  async request(method: string, params: unknown = {}, timeoutMs = 10_000): Promise<JsonRpcMessage> {
    const id = this.nextId;
    this.nextId += 1;
    if (this.exited) {
      throw new Error(`Server already exited; cannot send ${method}.\n${this.stderr}`);
    }
    const response = new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        settle();
        reject(new Error(`No response to ${method} (id ${id}) within ${timeoutMs} ms.\n${this.stderr}`));
      }, timeoutMs);
      timer.unref();
      const settle = (): void => {
        clearTimeout(timer);
        this.waiting.delete(id);
        this.abandoned.delete(reject);
      };
      this.abandoned.add(reject);
      this.waiting.set(id, (message) => {
        settle();
        resolve(message);
      });
    });
    this.write({ jsonrpc: '2.0', id, method, params });
    return await response;
  }

  /** The MCP handshake every session starts with. */
  async initialize(clientName = 'gdharness-test'): Promise<JsonRpcMessage> {
    const init = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: clientName, version: '1.0.0' },
    });
    this.notify('notifications/initialized');
    return init;
  }

  async stop(): Promise<void> {
    try {
      if (this.exited) return;
      this.child.stdin?.end();
      this.child.kill('SIGTERM');
      await delay(250);
      // `exited` is a getter over the child, so it can have turned true during the wait.
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    } finally {
      if (this.runtimeDir !== null) {
        rmSync(this.runtimeDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      }
    }
  }

  private write(payload: unknown): void {
    this.child.stdin?.write(`${JSON.stringify(payload)}\n`);
  }
}
