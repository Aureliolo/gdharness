/**
 * The one desktop helper a process keeps running, and the child each start through it is given.
 *
 * Starting the helper program for every engine cost a process launch on the path of every start.
 * One helper per process is started when the first engine needs it, takes a line a start on its
 * standard input and answers a line when the engine runs and another when it has ended. The engine's
 * own streams never pass through it: each start's output goes down a named pipe this process
 * listens on, which the helper hands the engine as its standard stream.
 *
 * A helper that dies leaves the engines it started running, since this process holds a copy of the
 * job of each that ends with its starter. The next start gets a new helper.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { PassThrough, type Writable } from 'node:stream';
import { alive } from './alive.js';
import { startTimesOf } from './process-children.js';
import { type ChildProcess, RelayedChild, spawnHidden } from './spawn.js';

/**
 * The system refused to run the helper program itself, as a policy that allows only some programs
 * does. That is a start that failed, which every caller answers as one, and no defect of this
 * server's. Where a runtime reports a refused spawn as an event, the same text arrives as the
 * child's error.
 */
export class HelperRefused extends Error {
  constructor(reason: string) {
    super(`the desktop helper could not be run: ${reason}`);
    this.name = 'HelperRefused';
  }
}

/** How long a start waits for the helper to say its engine runs, before the helper is taken for hung. */
const ANSWER_MS = 30_000;

/** The limit, which GDHARNESS_HELPER_ANSWER_MS shortens for a test of a helper that never answers. */
function answerMs(): number {
  const set = Number(process.env['GDHARNESS_HELPER_ANSWER_MS']);
  return Number.isInteger(set) && set > 0 ? set : ANSWER_MS;
}

/** How often the engine of a helper that has gone is looked for. */
const WATCH_MS = 250;

/** 1970 in the helper's start times, which count 100 ns steps from 1601. */
const UNIX_EPOCH_TICKS = 116_444_736_000_000_000n;

/**
 * When the engine began, in the milliseconds `startTimesOf` gives, from the helper's "pid began" in
 * [param made]. Undefined where the helper gave none.
 */
function engineBeganMs(made: string | undefined): number | undefined {
  const ticks = made?.split(' ')[1];
  if (ticks === undefined || !/^\d+$/.test(ticks)) {
    return undefined;
  }
  return Number((BigInt(ticks) - UNIX_EPOCH_TICKS) / 10_000n);
}

/** What a stream of a start is: closed to the engine, or read here. */
export type StreamKind = 'ignore' | 'pipe';

/** What a start is given for its streams, which the helper reads. */
export interface StreamPlan {
  readonly kinds: readonly [StreamKind, StreamKind, StreamKind];
  /** Where the output goes when it is not piped here, or none for the null device. */
  readonly outputFile?: string | undefined;
  /** The error stream is the engine's own, apart from its output. */
  readonly separateErrors: boolean;
}

interface Listening {
  readonly stream: PassThrough;
  readonly server: net.Server;
  connected: boolean;
}

function pipePath(name: string): string {
  return ['', '', '.', 'pipe', name].join('\\');
}

/**
 * Sets whether [param target], if it can be, keeps this process running. Node's pipes are sockets.
 * Bun's child output is a stream with its own `ref` and `unref`, which is what holds Bun open.
 */
function holdsProcess(target: unknown, held: boolean): void {
  const method = held ? 'ref' : 'unref';
  const call: unknown =
    target === null || typeof target !== 'object' ? undefined : Reflect.get(target, method);
  if (typeof call === 'function') {
    Reflect.apply(call, target, []);
  }
}

/** A start through the helper: the process the caller holds, whose events the helper's answers drive. */
export class HelpedChild extends RelayedChild {
  readonly id = randomBytes(6).toString('hex');
  /** Where the helper is to put the engine's input, output and error. */
  readonly streams: readonly [string, string, string];
  private readonly listening: Listening[] = [];
  private readonly ready: Promise<void>[] = [];
  private readonly closing: Promise<void>[] = [];
  private readonly unfed: PassThrough[] = [];
  private helper: ServedHelper | null = null;
  private enginePid: number | undefined;
  private copy = '0';
  /** The pid and start time the helper gave for the engine's process once it made it. */
  private madeProcess: string | undefined;
  private answered = false;
  private adopted = false;
  private done = false;
  private killRequested = false;
  /** How this process ended the engine itself, where no helper was left to. */
  private endedHere: 'kill' | 'stop' | null = null;
  /** Whether the process under the engine's pid began at another time, so the engine has gone. */
  private notTheEngine = false;
  private watchdog: NodeJS.Timeout | undefined;
  private watching: NodeJS.Timeout | undefined;
  private abort: (() => void) | undefined;
  private signal: AbortSignal | undefined;

  constructor(plan: StreamPlan, signal?: AbortSignal) {
    super();
    this.signal = signal;
    const output = plan.kinds[1] === 'pipe' ? this.piped() : null;
    // Without an error stream of its own the engine's errors go down its output, and the error
    // stream a caller holds only ends with the engine.
    let error: { stream: PassThrough; target: string } | null = null;
    if (plan.kinds[2] === 'pipe') {
      error = plan.separateErrors ? this.piped() : { stream: new PassThrough(), target: 'same' };
      if (!plan.separateErrors) {
        this.unfed.push(error.stream);
      }
    }
    this.streams = [
      'nul',
      output?.target ?? (plan.outputFile === undefined ? 'nul' : `file:${plan.outputFile}`),
      plan.separateErrors ? (error?.target ?? 'nul') : 'same',
    ];
    this.define('stdout', output?.stream ?? null);
    this.define('stderr', error?.stream ?? null);
    this.define('stdin', null);
    for (const stream of [output?.stream, error?.stream]) {
      if (stream !== undefined) {
        this.closing.push(
          new Promise((resolve) => {
            stream.once('close', resolve);
          }),
        );
      }
    }
  }

  private piped(): { stream: PassThrough; target: string } {
    const stream = new PassThrough();
    const name = `gdharness-${String(process.pid)}-${this.id}-${String(this.listening.length)}`;
    const listening: Listening = {
      stream,
      server: net.createServer((socket) => {
        listening.connected = true;
        socket.on('error', () => undefined);
        listening.server.close();
        socket.pipe(stream);
      }),
      connected: false,
    };
    this.listening.push(listening);
    this.ready.push(
      new Promise((resolve, reject) => {
        listening.server.once('error', reject);
        listening.server.listen(pipePath(name), resolve);
      }),
    );
    return { stream, target: `pipe:${name}` };
  }

  /** Sets one of the properties a started process has, which are read-only on the type. */
  private define(name: string, value: unknown): void {
    Object.defineProperty(this, name, { value, writable: true, configurable: true, enumerable: true });
  }

  /** Gives the start to [param helper] once its pipes are listening, and answers a start it could not give. */
  async deliver(helper: ServedHelper, request: string): Promise<void> {
    this.helper = helper;
    this.define('pid', helper.process.pid);
    if (this.signal !== undefined) {
      const signal = this.signal;
      this.abort = (): void => {
        this.kill();
        this.emit(
          'error',
          Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }),
        );
      };
      if (signal.aborted) {
        queueMicrotask(this.abort);
      } else {
        signal.addEventListener('abort', this.abort, { once: true });
      }
    }
    try {
      await Promise.all(this.ready);
    } catch (error) {
      this.failed(
        `a pipe for the engine's output could not be made: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (this.done) {
      return;
    }
    const limit = answerMs();
    this.watchdog = setTimeout(() => {
      this.watchdog = undefined;
      this.failed(`the desktop helper gave no answer within ${String(limit)} ms`);
      helper.abandon(this);
      helper.hang();
      this.release(helper);
    }, limit);
    this.watchdog.unref();
    if (!helper.write(`start ${this.id} ${request}`)) {
      // A helper that has not yet reported its end says why itself, as its error or exit.
      if (!helper.running) {
        this.failed('the desktop helper could not be written to');
      }
      return;
    }
    this.emit('spawn');
  }

  /** The engine's own pid once the helper has said it runs. The child's pid is the helper's. */
  get engine(): number | undefined {
    return this.enginePid;
  }

  /** The helper says the engine's process exists, suspended, and when it began. */
  made(pid: number, began: string): void {
    this.madeProcess = `${String(pid)} ${began}`;
  }

  /**
   * Has the next helper end the engine of a start its helper made but never answered, and close the
   * copy of its job this process was handed, once [param gone] has ended. Without that the engine
   * stays suspended while this process runs, and its output never closes.
   */
  private release(gone: ServedHelper): void {
    void Promise.all([gone.ended, gone.heardAll]).then(() => {
      // Read once the helper has ended and all it said is heard, since a hung one can still say it
      // made the engine.
      const made = this.madeProcess;
      if (made !== undefined) {
        tellAHelper(gone.assembly, `release ${made}`);
      }
    });
  }

  /**
   * Has a helper close this process's copy of the job of an engine no helper took over, once the
   * engine has gone. The copy keeps the job's name taken, and a later engine given the same pid
   * could not be started.
   */
  private letGoOfTheJob(): void {
    if (this.copy !== '0' && this.enginePid !== undefined && this.helper !== null) {
      tellAHelper(this.helper.assembly, `letgo ${String(this.enginePid)} ${this.copy}`);
    }
  }

  /** The helper says the engine runs, with its pid and the copy of its job this process holds. */
  started(pid: number, copy: string): void {
    this.answered = true;
    this.enginePid = pid;
    this.copy = copy;
    clearTimeout(this.watchdog);
    if (this.killRequested) {
      this.kill();
    }
  }

  /**
   * The helper says the engine has ended with [param code], whole. An engine it ended on request is
   * reported as one ended by SIGTERM, as a stopped child process is, and not by the code 1 that
   * ending it leaves, which an engine can exit with itself.
   */
  ended(code: number, stopped: boolean): void {
    if (stopped) {
      this.finish(null, 'SIGTERM');
      return;
    }
    this.finish(code, null);
  }

  /**
   * The helper is gone: a start it had not answered has failed. One it had is handed to
   * [param adopt], the next helper, which reads the engine's exit code from a handle opened while
   * the engine runs. Where none can take it, the engine is watched until it has gone and ends
   * without a code, and a stop asked meanwhile ends it by its pid.
   */
  helperGone(reason: string, adopt: (child: HelpedChild) => boolean, refused?: Error): void {
    if (this.done) {
      return;
    }
    if (!this.answered) {
      // A helper the system would not run is the child's error, as a refused spawn is, where the
      // caller listens for one.
      if (refused !== undefined && this.listenerCount('error') > 0) {
        this.emit('error', refused);
      }
      this.failed(reason);
      if (this.helper !== null) {
        this.release(this.helper);
      }
      return;
    }
    // One adoption a start: a helper that cannot run would otherwise be asked again for ever.
    if (!this.adopted && adopt(this)) {
      return;
    }
    this.watching = setInterval(() => {
      this.watch();
    }, WATCH_MS);
  }

  /** One look at the engine of a start no helper holds. */
  private watch(): void {
    if (this.notTheEngine || !alive(this.enginePid)) {
      this.letGoOfTheJob();
      // Told as a helper tells the same stop: code 1 for the stop file, SIGTERM for a kill.
      if (this.endedHere === 'stop') {
        this.finish(1, null);
      } else {
        this.finish(null, this.endedHere === 'kill' ? 'SIGTERM' : 'SIGKILL');
      }
      return;
    }
    if (this.endedHere !== null) {
      return;
    }
    if (this.killRequested) {
      void this.endByPid('kill');
    } else if (this.stopFile !== undefined && existsSync(this.stopFile)) {
      void this.endByPid('stop');
    }
  }

  /**
   * Ends the engine by its pid, where no helper is left to end it through its handle. A pid can name
   * a later process once the engine has gone, so it is ended only while the process there began
   * when the helper said the engine did. A look that gets no start time decides nothing, and the
   * next look asks again.
   */
  private async endByPid(how: 'kill' | 'stop'): Promise<void> {
    const pid = this.enginePid;
    const began = engineBeganMs(this.madeProcess);
    if (pid === undefined || began === undefined) {
      return;
    }
    try {
      const now = (await startTimesOf([pid])).get(pid);
      if (now === undefined) {
        return;
      }
      this.endedHere = how;
      if (now !== began) {
        this.notTheEngine = true;
        return;
      }
      process.kill(pid);
    } catch {
      // It ended on its own meanwhile, which the next look tells.
    }
  }

  /**
   * Makes [param helper] this start's, and says the engine and the copy of its job it is to wait on,
   * the stop file it is to watch and whether a stop the last helper may not have acted on was asked.
   */
  adoptedBy(helper: ServedHelper): string {
    this.helper = helper;
    this.adopted = true;
    const stop = Buffer.from(this.stopFile ?? '', 'utf8').toString('base64');
    // An answered start was made first, so the start time is known. -1 matches no process.
    const made = this.madeProcess ?? `${String(this.enginePid)} -1`;
    return `${made} ${this.copy} ${stop} ${this.killRequested ? '1' : '0'}`;
  }

  /** Ends the start with [param reason] where the helper's error file would have said it. */
  private failed(reason: string): void {
    const file = this.errorFile;
    if (file !== undefined) {
      try {
        writeFileSync(file, reason, { flag: 'wx' });
      } catch {
        // The helper wrote its own reason there, or the folder has gone.
      }
    }
    this.finish(1, null);
  }

  /** Where a reason for a start that failed is written, which the caller of the start sets. */
  errorFile: string | undefined;

  /** The file whose appearance stops the engine, where the start named one. */
  stopFile: string | undefined;

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.done) {
      return;
    }
    this.done = true;
    clearTimeout(this.watchdog);
    clearInterval(this.watching);
    if (this.abort !== undefined) {
      this.signal?.removeEventListener('abort', this.abort);
    }
    this.helper?.forget(this);
    for (const { stream, server, connected } of this.listening) {
      if (!connected) {
        server.close();
        stream.end();
      }
    }
    // Nothing is written to these, and nothing may read them, so they are drained to let them close.
    for (const stream of this.unfed) {
      stream.resume();
      stream.end();
    }
    this.define('exitCode', code);
    this.define('signalCode', signal);
    this.emit('exit', code, signal);
    // As a child process does, output nobody reads is let go so that the stream can close.
    for (const stream of [this.stdout, this.stderr]) {
      if (
        stream?.readableFlowing === null &&
        stream.listenerCount('data') === 0 &&
        stream.listenerCount('readable') === 0
      ) {
        stream.resume();
      }
    }
    void Promise.all(this.closing).then(() => {
      this.emit('close', code, signal);
    });
  }

  override kill(): boolean {
    if (this.done) {
      return false;
    }
    this.define('killed', true);
    // Kept once answered too, so a helper that takes over from one that died first ends the engine.
    this.killRequested = true;
    if (this.answered && this.helper !== null) {
      this.helper.write(`kill ${this.id}`);
    }
    return true;
  }

  override unref(): void {
    this.helper?.process.unref();
  }

  override ref(): void {
    this.helper?.process.ref();
  }
}

/** The helper program, running, and the starts it has been given. */
export class ServedHelper {
  readonly process: ChildProcess;
  private readonly input: Writable;
  readonly assembly: string;
  private readonly starts = new Map<string, HelpedChild>();
  private readonly abandoned = new Map<string, HelpedChild>();
  /**
   * The requests owed for other starts that this helper was told and has not yet answered "heard"
   * to, oldest first.
   */
  private readonly told: string[] = [];
  private open = true;
  private retiring = false;
  private holding = true;
  private heard = '';
  /** Settles once every line the helper wrote has been read, which can be after its exit is told. */
  readonly heardAll: Promise<void>;
  /** Settles once the helper's process has gone, or never ran. */
  readonly ended: Promise<void>;

  constructor(assembly: string) {
    this.assembly = assembly;
    try {
      this.process = spawnHidden(assembly, ['--serve', String(process.pid)], {
        stdio: ['pipe', 'pipe', 'ignore'],
        // Apart from its starter's process group and job, so a helper that holds the job of a kept
        // engine is not ended with a starter that is killed. It ends itself once its starter has
        // gone and no kept engine is left.
        detached: true,
      });
    } catch (error) {
      throw new HelperRefused(error instanceof Error ? error.message : String(error));
    }
    const { stdin, stdout } = this.process;
    if (stdin === null || stdout === null) {
      throw new HelperRefused('it was given no streams');
    }
    this.input = stdin;
    stdin.on('error', () => undefined);
    stdout.setEncoding('utf8');
    this.heardAll = new Promise((resolve) => {
      stdout.once('end', resolve);
      stdout.once('close', resolve);
    });
    stdout.on('data', (chunk: string) => {
      this.heard += chunk;
      for (let end = this.heard.indexOf('\n'); end >= 0; end = this.heard.indexOf('\n')) {
        this.answer(this.heard.slice(0, end).trim());
        this.heard = this.heard.slice(end + 1);
      }
    });
    this.ended = new Promise((resolve) => {
      // What it was told and never heard is owed again, for the next helper this process runs.
      this.process.once('exit', () => {
        owed.push(...this.told.splice(0));
        resolve();
      });
      // A helper whose spawn failed has no pid and tells only its error, never an exit. The system
      // refuses a program that is not there only after the spawn has returned.
      this.process.once('error', () => {
        if (this.process.pid === undefined) {
          owed.push(...this.told.splice(0));
          this.hold(false);
          resolve();
        }
      });
    });
    this.process.once('error', (error: Error) => {
      this.gone(new HelperRefused(error.message).message, error);
    });
    this.process.once('exit', (code, signal) => {
      this.gone(
        `the desktop helper ended (${code === null ? String(signal) : `exit code ${String(code)}`}) before it started the engine`,
      );
    });
  }

  get running(): boolean {
    return this.open;
  }

  /** How many starts are with the helper. */
  get busy(): number {
    return this.starts.size;
  }

  private answer(line: string): void {
    const [word, id, first, second] = line.split(' ');
    const start = this.starts.get(id ?? '') ?? this.abandoned.get(id ?? '');
    if (word === 'made') {
      start?.made(Number(first), second ?? '0');
    } else if (word === 'started') {
      start?.started(Number(first), second ?? '0');
    } else if (word === 'ended') {
      start?.ended(Number(first), second === 'stopped');
    } else if (word === 'heard') {
      this.told.shift();
      this.holdOnlyForWhatIsWith();
    }
  }

  /**
   * Lets this process end once the helper has no start and has heard every request it was told. A
   * job copy is closed only while this process lives, so a process ending sooner kills what the
   * engine left running.
   */
  private holdOnlyForWhatIsWith(): void {
    if (this.starts.size === 0 && this.told.length === 0) {
      this.hold(false);
    }
  }

  /** Gives [param child] the start that [param request] names. */
  give(child: HelpedChild, request: string): void {
    this.starts.set(child.id, child);
    this.hold(true);
    void child.deliver(this, request);
  }

  /** Has the helper act on [param line], a request owed for a start a helper before it held. */
  tell(line: string): void {
    if (!this.write(line)) {
      owed.push(line);
      return;
    }
    this.told.push(line);
    this.hold(true);
  }

  /** Keeps hearing what the helper says of [param child], a start that failed before the helper ended. */
  abandon(child: HelpedChild): void {
    this.abandoned.set(child.id, child);
  }

  forget(child: HelpedChild): void {
    this.starts.delete(child.id);
    if (this.starts.size === 0) {
      this.holdOnlyForWhatIsWith();
      if (this.retiring) {
        this.retire();
      }
    }
  }

  /** Writes a line to the helper, and says whether it could. */
  write(line: string): boolean {
    if (!this.open || this.input.destroyed) {
      return false;
    }
    this.input.write(`${line}\n`);
    return true;
  }

  /** Ends a helper that does not answer, so the next start gets a new one. */
  hang(): void {
    this.process.kill();
  }

  /** Ends the helper once nothing is with it. */
  retire(): void {
    this.retiring = true;
    if (this.starts.size === 0 && this.open) {
      this.input.end();
    }
  }

  /**
   * Bun counts every `ref`, so one made while the process is already held takes two `unref` to
   * release. A call that changes nothing is skipped.
   */
  private hold(held: boolean): void {
    if (held === this.holding) {
      return;
    }
    this.holding = held;
    holdsProcess(this.input, held);
    holdsProcess(this.process.stdout, held);
    if (held) {
      this.process.ref();
    } else {
      this.process.unref();
    }
  }

  private gone(reason: string, refused?: Error): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    const starts = [...this.starts.values()];
    this.starts.clear();
    for (const child of starts) {
      this.abandon(child);
      child.helperGone(reason, (orphan) => this.adopt(orphan), refused);
    }
  }

  /** Has the next helper wait for an engine this one started, so its whole exit code still arrives. */
  private adopt(child: HelpedChild): boolean {
    try {
      return helperFor(this.assembly).take(child);
    } catch {
      return false;
    }
  }

  /** Takes over the wait for the engine of [param child], which a helper that has gone started. */
  take(child: HelpedChild): boolean {
    this.starts.set(child.id, child);
    this.hold(true);
    if (this.write(`adopt ${child.id} ${child.adoptedBy(this)}`)) {
      return true;
    }
    this.starts.delete(child.id);
    return false;
  }
}

let current: ServedHelper | null = null;

/** Requests owed for starts a dead helper held, which no helper could be run to hear yet. */
const owed: string[] = [];

/**
 * Has a helper of [param assembly] act on [param line] now, or the next helper this process runs
 * where none can be run now.
 */
function tellAHelper(assembly: string, line: string): void {
  try {
    helperFor(assembly).tell(line);
  } catch {
    owed.push(line);
  }
}

/**
 * Ends the helper this process keeps once its starts have ended. A test that started it ends it, so
 * the run's own process is not left holding a helper no later test asked for.
 */
export async function retireHelper(): Promise<void> {
  const retiring = current;
  current = null;
  retiring?.retire();
  await retiring?.ended;
}

/** The helper running [param assembly], started when there is none. Throws [class HelperRefused] where the system will not run it. */
export function helperFor(assembly: string): ServedHelper {
  if (current?.running !== true || current.assembly !== assembly) {
    current?.retire();
    current = new ServedHelper(assembly);
  }
  for (const line of owed.splice(0)) {
    current.tell(line);
  }
  return current;
}
