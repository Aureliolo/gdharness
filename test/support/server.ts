import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { type JsonRpcMessage, parseJsonLines } from './json-rpc.js';
import { sweep } from './sweep.js';

/** A runtime directory nothing else on this machine is using. */
function runtimeDirForTest(): string {
  return mkdtempSync(join(tmpdir(), 'gdharness-test-runtime-'));
}

/**
 * Ports this process has already handed out, which the kernel is free to offer again.
 *
 * A reservation binds port zero, reads the number and closes, so the port is back in the pool
 * before whoever asked for it has bound anything. Two calls in a row can therefore come back with
 * the same number, and a fixture that asks for three gets a bridge, a language server and a debug
 * adapter that are not necessarily three ports. The failure that follows is nowhere near here: the
 * server binds the bridge, the editor comes up, and the check on who really holds the debug adapter
 * port finds the harness's own server on it and refuses to play the game, naming two pids that are
 * one apart because they were spawned in a row.
 */
const handedOut = new Set<number>();

/**
 * A TCP port nothing is listening on right now, and that this process has not already given away.
 *
 * [offer] is the kernel, apart from asking it, so that a pool which repeats itself is a case that
 * can be written down rather than a machine to be lucky on. Waiting for a real repeat is not a
 * check: it passes on a host that does not give one, which reads exactly like a reservation that
 * never deduplicated at all.
 */
export async function reservePort(offer: () => Promise<number> = freePort): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = await offer();
    if (!handedOut.has(port)) {
      handedOut.add(port);
      return port;
    }
  }
  throw new Error('could not reserve a port the kernel had not already offered');
}

function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
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
 * Refuses to run a suite against a bundle older than the source it was built from.
 *
 * These fixtures drive the built server rather than the TypeScript, so a change to src that nobody
 * rebuilt is a change these tests cannot see: the suite goes green against the old behaviour, and
 * CI, which builds first, is the one that finds out. That happened, and the shape of it is the same
 * as every other silent pass, an instrument reporting on something other than what it was pointed
 * at.
 *
 * Checked once per process and only against what the build is made from. The fix is one command, so
 * the message says it rather than leaving a timestamp comparison to be worked out.
 */
let buildChecked = false;
function refuseAStaleBuild(entry: string): void {
  if (buildChecked || !entry.startsWith('build/')) {
    return;
  }
  buildChecked = true;
  const built = statSync(entry, { throwIfNoEntry: false })?.mtimeMs;
  assert.ok(built !== undefined, `${entry} is not there: run bun run build`);
  let newest = 0;
  let newestPath = '';
  for (const file of readdirSync('src', { recursive: true, encoding: 'utf8' })) {
    if (!file.endsWith('.ts')) {
      continue;
    }
    const when = statSync(join('src', file), { throwIfNoEntry: false })?.mtimeMs ?? 0;
    if (when > newest) {
      newest = when;
      newestPath = file;
    }
  }
  assert.ok(
    built >= newest,
    `${entry} was built before src/${newestPath} was last changed, so this suite would be testing the previous behaviour: run bun run build`,
  );
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
    const entry = options.entry ?? 'build/index.js';
    refuseAStaleBuild(entry);
    this.child = spawn(process.execPath, [entry, ...(options.args ?? [])], {
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

  /** The id the next request will carry, so a fixture can cancel a request it has sent. */
  get nextRequestId(): number {
    return this.nextId;
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
      sweep(this.runtimeDir);
    }
  }

  private write(payload: unknown): void {
    this.child.stdin?.write(`${JSON.stringify(payload)}\n`);
  }
}
