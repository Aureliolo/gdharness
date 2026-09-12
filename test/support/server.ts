import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { type JsonRpcMessage, parseJsonLines } from './json-rpc.js';

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

  constructor(options: ServerOptions = {}) {
    this.child = spawn(process.execPath, [options.entry ?? 'build/index.js', ...(options.args ?? [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
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
    if (this.exited) return;
    this.child.stdin?.end();
    this.child.kill('SIGTERM');
    await delay(250);
    // `exited` is a getter over the child, so it can have turned true during the wait.
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
  }

  private write(payload: unknown): void {
    this.child.stdin?.write(`${JSON.stringify(payload)}\n`);
  }
}
