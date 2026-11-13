import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { acceptsConnections } from '../../src/port-probe.js';
import { type ChildProcess, spawnHidden } from '../../src/spawn.js';
import { isRecord, type JsonRpcMessage, parseJsonLines } from './json-rpc.js';
import { slotsSaid } from './slots.js';
import { fixtureNow, sweep } from './sweep.js';

/** A runtime directory nothing else on this machine is using. */
function runtimeDirForTest(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gdharness-test-runtime-'));
  runtimeDirsMade.push({ directory, during: fixtureNow() });
  return directory;
}

/**
 * Every runtime directory and server made, with the fixture each was made for. A fixture its
 * deadline cut short never reaches its own stops and sweeps, and the engines it started name only
 * their projects on their command lines. Which projects those were is in the run and editor notes
 * its servers kept in these directories.
 */
const runtimeDirsMade: { directory: string; during: string | null }[] = [];
let serversStarted: { server: ServerProcess; during: string | null }[] = [];

function started(server: ServerProcess): void {
  // Each holds everything its server printed, and about ninety fixtures start one.
  serversStarted = serversStarted.filter((entry) => !entry.server.exited);
  serversStarted.push({ server, during: fixtureNow() });
}

/**
 * Stops the servers [param fixture] started, so they start nothing more, and answers the runtime
 * directories made for it with every project their notes name.
 */
export async function stopServersOf(fixture: string): Promise<string[]> {
  const found = new Set<string>();
  const ended = serversStarted.filter((entry) => entry.during === fixture).map(({ server }) => server);
  await Promise.all(
    ended.map(async (server) => {
      await server.end();
    }),
  );
  for (const { directory, during } of runtimeDirsMade) {
    if (during !== fixture) {
      continue;
    }
    found.add(directory);
    for (const projectPath of projectsNamedIn(directory)) {
      found.add(projectPath);
    }
  }
  for (const server of ended) {
    sweep(server.runtimeDir);
  }
  return [...found];
}

/** The projects the run notes in [param directory] name. */
function projectsNamedIn(directory: string): string[] {
  let notes: string[];
  try {
    notes = readdirSync(join(directory, 'runs')).filter((entry) => entry.endsWith('.json'));
  } catch {
    return [];
  }
  const projects: string[] = [];
  for (const note of notes) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(directory, 'runs', note), 'utf8'));
      const projectPath =
        typeof parsed === 'object' && parsed !== null && 'projectPath' in parsed ? parsed.projectPath : null;
      if (typeof projectPath === 'string') {
        projects.push(projectPath);
      }
    } catch {
      // A note half written as its server was stopped names nothing yet.
    }
  }
  return projects;
}

/**
 * Ports this process has already handed out.
 * The walk repeats only after every number of its blocks, but a stand-in `offer` can repeat at once.
 */
const handedOut = new Set<number>();

/**
 * A port in the band that nothing held or answered on 127.0.0.1 when it was proved, and that this
 * process has not given away. [offer] stands in for the band, so a repeating source can be written
 * down.
 */
export async function reservePort(offer: () => Promise<number> = unheldPort): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = await offer();
    if (!handedOut.has(port)) {
      handedOut.add(port);
      return port;
    }
  }
  throw new Error('could not reserve a port that was not already offered');
}

/**
 * [param listener] listening on a port from [method reservePort], which it answers. Nobody has been
 * told the number yet, so one found in use is given up for the next.
 */
export async function listenOnAReservedPort(
  listener: Server,
  host = '127.0.0.1',
  offer: () => Promise<number> = unheldPort,
): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await reservePort(offer);
    const up = await new Promise<Error | null>((ready) => {
      const failed = (error: Error): void => {
        ready(error);
      };
      listener.once('error', failed);
      listener.listen(port, host, () => {
        listener.off('error', failed);
        ready(null);
      });
    });
    if (up === null) {
      return port;
    }
    if ((up as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
      throw up;
    }
  }
  throw new Error('no reserved port could be listened on');
}

/**
 * The ports a fixture names before its listener exists. Kernels hand out port-zero picks from
 * 32768 or above on every platform CI runs, so no such pick lands on a number drawn from here.
 * A process draws only from blocks of `block` numbers whose first number a listener of
 * its own holds until it ends.
 */
export const PORT_BAND = { first: 10_000, last: 29_999, block: 100 } as const;

const BLOCKS = (PORT_BAND.last - PORT_BAND.first + 1) / PORT_BAND.block;

/** The listeners holding the first numbers of this process's blocks, kept so none is collected. */
const blockListeners: Server[] = [];

/**
 * True once a listener on 127.0.0.1 and [param first] is up, false for any bind error. The listener
 * is unreferenced, so it never keeps the process alive, and it turns away every connection.
 */
async function holdBlock(first: number): Promise<boolean> {
  const listener = createServer((socket) => {
    socket.on('error', () => undefined);
    socket.destroy();
  });
  listener.unref();
  listener.on('error', () => undefined);
  try {
    await once(listener.listen(first, '127.0.0.1'), 'listening');
  } catch {
    return false;
  }
  blockListeners.push(listener);
  return true;
}

const firstOfBlock = (port: number): number =>
  PORT_BAND.first + Math.floor((port - PORT_BAND.first) / PORT_BAND.block) * PORT_BAND.block;

const afterPort = (port: number): number => (port >= PORT_BAND.last ? PORT_BAND.first : port + 1);

/**
 * A walk from [param start] through the blocks [param hold] takes, one number a call.
 * It gives no block's first number and answers calls made together one at a time.
 */
export function bandWalk(
  start: number,
  hold: (first: number) => Promise<boolean> = holdBlock,
): () => Promise<number> {
  let next = start;
  const held = new Set<number>();
  let turn: Promise<unknown> = Promise.resolve();

  const holds = async (first: number): Promise<boolean> => {
    if (held.has(first)) {
      return true;
    }
    if (!(await hold(first))) {
      return false;
    }
    held.add(first);
    return true;
  };

  // A refused block moves the walk to the next block, and a call that has been refused by every
  // block gives up.
  const take = async (): Promise<number> => {
    let refused = 0;
    for (;;) {
      const first = firstOfBlock(next);
      if (!(await holds(first))) {
        refused += 1;
        if (refused >= BLOCKS) {
          throw new Error(
            `none of the ${BLOCKS} blocks from ${PORT_BAND.first} to ${PORT_BAND.last} could be held on 127.0.0.1`,
          );
        }
        next = afterPort(first + PORT_BAND.block - 1);
        continue;
      }
      const port = next;
      next = afterPort(port);
      if (port !== first) {
        return port;
      }
    }
  };

  return () => {
    const result = turn.then(take);
    turn = result.catch(() => undefined);
    return result;
  };
}

const processWalk = bandWalk(randomInt(PORT_BAND.first, PORT_BAND.last + 1));

const DRAWS_LIMIT = 2000;
const UNANSWERED_LIMIT = 3;

/** The error binding [param port] on 127.0.0.1 gives, or null when the bind took and was closed. */
async function bindOnce(port: number): Promise<NodeJS.ErrnoException | null> {
  const listener = createServer();
  listener.unref();
  try {
    await once(listener.listen(port, '127.0.0.1'), 'listening');
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  await new Promise<void>((settle) => {
    listener.close(() => {
      settle();
    });
  });
  return null;
}

/**
 * The next number of the walk that a bind on 127.0.0.1 took and nothing answered a dial on.
 *
 * The dial catches a holder on 0.0.0.0 or :: that the bind does not see. A dial that neither
 * answers nor refuses leaves the number unproven, and a third in one call means no dial is being
 * answered at all.
 */
export async function unheldPort(
  draw: () => number | Promise<number> = processWalk,
  bind: (port: number) => Promise<NodeJS.ErrnoException | null> = bindOnce,
  dial: (port: number) => Promise<boolean | null> = acceptsConnections,
): Promise<number> {
  let last = 'nothing was drawn';
  let unanswered = 0;
  for (let attempt = 0; attempt < DRAWS_LIMIT; attempt += 1) {
    const port = await draw();
    const failure = await bind(port);
    if (failure) {
      last = `${port}: ${failure.code ?? failure.message}`;
      continue;
    }
    const answer = await dial(port);
    if (answer === false) {
      return port;
    }
    if (answer === true) {
      last = `${port}: something answered`;
      continue;
    }
    unanswered += 1;
    last = `${port}: the dial was not answered`;
    if (unanswered >= UNANSWERED_LIMIT) {
      throw new Error(`port ${port} neither answered nor refused a dial, so none can be proved free`);
    }
  }
  throw new Error(
    `no port from ${PORT_BAND.first} to ${PORT_BAND.last} was proved free in ${DRAWS_LIMIT} draws, last ${last}`,
  );
}

/**
 * Bridge ports reserved ahead for a server whose fixture names none, topped up after each is taken.
 *
 * Left to the default, two servers of this suite took 6505 while a real editor of another project
 * was dialling its own server there: the editor reached the test servers, they turned it away, and
 * the server that project started next found 6505 held and moved. Only the bridge: the language
 * server and debug adapter variables are pins that override the port a connected editor reports,
 * so setting them changes what a fixture tests rather than only where it reaches.
 * Reserved ahead because a server's environment is fixed when it is spawned, which the constructor
 * does, and a reservation is asynchronous.
 */
const sparePorts: number[] = [];
const SPARE_PORTS = 24;

async function topUpSparePorts(offer: () => Promise<number> = unheldPort): Promise<void> {
  while (sparePorts.length < SPARE_PORTS) {
    sparePorts.push(await reservePort(offer));
  }
}

await topUpSparePorts();

/** The message of the last top-up that failed in the background, which an empty pool reports. */
let failedTopUp: string | undefined;

/**
 * A bridge port from the pool, which a top-up then refills in the background. A top-up that fails is
 * kept and not thrown, since the pool is a head start and every reservation proves its own number.
 * [offer] stands in for the band.
 */
export function sparePort(offer: () => Promise<number> = unheldPort): number {
  const port = sparePorts.shift();
  if (port === undefined) {
    const kept = failedTopUp === undefined ? '' : `, or a top-up failed: ${failedTopUp}`;
    throw new Error(
      `no reserved port left for a test server; more were started at once than are kept${kept}`,
    );
  }
  void topUpSparePorts(offer).catch((error: unknown) => {
    failedTopUp = error instanceof Error ? error.message : String(error);
  });
  return port;
}

/**
 * A reserved bridge port unless [param named] names one. The fixture's own value wins, and one that
 * wants the default on purpose names the variable as an empty string, which the server reads as
 * unset.
 */
function reservedPortsFor(named: Record<string, string> | undefined): Record<string, string> {
  return named?.['GDHARNESS_BRIDGE_PORT'] === undefined ? { GDHARNESS_BRIDGE_PORT: String(sparePort()) } : {};
}

export interface ServerOptions {
  entry?: string;
  env?: Record<string, string>;
  args?: string[];
  /** The directory the server runs in, which is the suite's own unless a fixture is about it. */
  cwd?: string;
}

const MODERN_REVISION = '2026-07-28';

/** The `_meta` a 2026-07-28 client puts on every request, with the two keys the revision requires. */
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': MODERN_REVISION,
  'io.modelcontextprotocol/clientInfo': { name: 'gdharness-test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

/** [params] with the 2026 envelope merged into its `_meta`. What the caller put there stays. */
function enveloped(params: unknown): unknown {
  if (params === undefined) return { _meta: { ...ENVELOPE } };
  if (!isRecord(params) || Array.isArray(params)) return params;
  const meta = isRecord(params['_meta']) ? params['_meta'] : {};
  return { ...params, _meta: { ...ENVELOPE, ...meta } };
}

/** How a child ended, as Node reports it: a signal when one ended it, otherwise its exit code. */
function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal !== null) return `killed by signal ${signal}`;
  return `exit code ${code === null ? 'unknown' : String(code)}`;
}

/** The name and version a server gave in the `_meta` of its opening answer. */
export function serverIdentity(opening: JsonRpcMessage): Record<string, unknown> {
  const meta = isRecord(opening.result) ? opening.result['_meta'] : undefined;
  const found = isRecord(meta) ? meta['io.modelcontextprotocol/serverInfo'] : undefined;
  return isRecord(found) ? found : {};
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
 * The environment a test server is spawned with, and the runtime directory it was given, or null
 * when [param named] names its own. It is for a fixture that spawns the server some other way,
 * such as through an SDK client's transport, and that sweeps the directory itself when done.
 */
export function testServerEnvironment(named: Record<string, string> | undefined): {
  env: Record<string, string>;
  runtimeDir: string | null;
} {
  // A runtime directory of its own, unless the fixture names one. The default is shared by
  // everything on this machine that speaks gdharness: one directory per user, holding the note
  // that says which process a run is. A server started without a project of its own reads any
  // note it finds there as its own and ends that run before starting another, so a test suite
  // run on a developer's machine killed another project's bench six times in fifty minutes,
  // silently, while its owner bisected their own code looking for the cause.
  //
  // Here rather than in each fixture, because the fixture that forgets is the one that does it,
  // and what it costs is never its own run.
  const runtimeDir = named?.['GDHARNESS_RUNTIME_DIR'] === undefined ? runtimeDirForTest() : null;
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    env: {
      ...inherited,
      ...(runtimeDir === null ? {} : { GDHARNESS_RUNTIME_DIR: runtimeDir }),
      // No update check either, unless the fixture is about one. A server whose version is
      // behind whatever is published rides a second JSON document on its next answer, so every
      // fixture that parses an answer starts failing the moment a release goes out and keeps
      // failing until its branch takes the version bump. That is the suite depending on the
      // network and on today's date, and it cost an afternoon's confusion once.
      GDHARNESS_NO_UPDATE_CHECK: '1',
      ...reservedPortsFor(named),
      ...named,
    },
    runtimeDir,
  };
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
  /** Every notification the server has sent, in order: a message with no id. */
  readonly notifications: JsonRpcMessage[] = [];
  private nextId = 1;
  private readonly waiting = new Map<number | string, (message: JsonRpcMessage) => void>();
  private readonly abandoned = new Set<(reason: Error) => void>();
  private buffered = '';

  /** The runtime directory this server was given, or null when the fixture named its own. */
  readonly runtimeDir: string | null;

  constructor(options: ServerOptions = {}) {
    const entry = options.entry ?? 'build/cli.js';
    refuseAStaleBuild(entry);
    const { env, runtimeDir } = testServerEnvironment(options.env);
    this.runtimeDir = runtimeDir;
    started(this);
    this.child = spawnHidden(process.execPath, [resolvePath(entry), ...(options.args ?? [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    this.child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      this.stdout += text;
      this.buffered += text;
      const lines = this.buffered.split('\n');
      this.buffered = lines.pop() ?? '';
      for (const message of parseJsonLines(lines.join('\n'))) {
        if (message.id === undefined || message.id === null) {
          this.notifications.push(message);
          continue;
        }
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
    this.child.once('exit', (code, signal) => {
      for (const reject of this.abandoned) {
        reject(new Error(`Server exited before answering, ${describeExit(code, signal)}.\n${this.stderr}`));
      }
      this.abandoned.clear();
      this.waiting.clear();
    });
  }

  get exited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params: enveloped(params) });
  }

  /** The id the next request will carry, so a fixture can cancel a request it has sent. */
  get nextRequestId(): number {
    return this.nextId;
  }

  /**
   * Sends a request and resolves with its response, or rejects when the server dies or stalls.
   *
   * The default outlasts the server's own deadlines, ten seconds for a runtime or language server
   * request, so a slow call is answered by the server, with the game's late reply or its own timeout
   * saying which, rather than cut off here first: at an equal ten seconds this always gave up a
   * moment before the server could answer, and a slow click on a loaded runner read only as "no
   * response".
   */
  async request(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<JsonRpcMessage> {
    const id = this.nextId;
    this.nextId += 1;
    if (this.exited) {
      throw new Error(
        `Server already exited, ${describeExit(this.child.exitCode, this.child.signalCode)}, so it cannot send ${method}.\n${this.stderr}`,
      );
    }
    const response = new Promise<JsonRpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        settle();
        reject(
          new Error(
            `No response to ${method} (id ${id}) within ${timeoutMs} ms.\n${slotsSaid()}\n${this.stderr}`,
          ),
        );
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
    this.write({ jsonrpc: '2.0', id, method, params: enveloped(params) });
    return await response;
  }

  /** The opening a session starts with, `server/discover`, which has no handshake to finish. */
  async initialize(clientName = 'gdharness-test'): Promise<JsonRpcMessage> {
    return await this.request('server/discover', {
      _meta: { 'io.modelcontextprotocol/clientInfo': { name: clientName, version: '1.0.0' } },
    });
  }

  async stop(): Promise<void> {
    try {
      await this.end();
    } finally {
      sweep(this.runtimeDir);
    }
  }

  /** The stop without the sweep, so what the server wrote in its runtime directory can be read. */
  async end(): Promise<void> {
    if (this.exited) return;
    const gone = new Promise<void>((done) => {
      this.child.once('exit', () => {
        done();
      });
    });
    this.child.stdin?.end();
    this.child.kill('SIGTERM');
    // Over as soon as it exits, and killed if it has not within the quarter second: about ninety
    // fixtures start a server, and the whole wait on every stop was time spent on nothing.
    await Promise.race([gone, delay(250)]);
    // `exited` is a getter over the child, so it can have turned true during the wait.
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
  }

  private write(payload: unknown): void {
    this.child.stdin?.write(`${JSON.stringify(payload)}\n`);
  }
}
