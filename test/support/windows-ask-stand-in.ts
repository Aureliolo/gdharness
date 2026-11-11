/**
 * Runs `src/windows-ask.ts` against stand-in helpers and prints what happened as one JSON line.
 *
 * The module asks Windows through `powershell.exe`, which a case must never start. Run as a script
 * under Bun, this replaces `src/spawn.ts` before the module loads, so every helper is an object
 * here, and it refuses to ask anything if the stand-in did not load.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

/** The path a case runs under Bun. */
export const WINDOWS_ASK_STAND_IN = fileURLToPath(import.meta.url);

class StandIn extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  readonly asked: string[] = [];
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        this.asked.push(line);
        this.emit('asked', line);
      }
    });
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  unref(): void {
    // A stand-in holds nothing open.
  }

  /** The id of the [param index]th question this helper was sent. */
  idOf(index: number): string {
    return (this.asked[index] ?? '').split(' ')[0] ?? '';
  }

  answer(id: string, text: string): void {
    this.stdout.write(`${id} OK ${Buffer.from(text, 'utf8').toString('base64')}\n`);
  }

  finish(): void {
    this.exitCode = 1;
    this.emit('exit', 1, null);
  }
}

const SPAWN_SOURCE =
  'export function spawnHidden(command, args, options) { return globalThis.__standInSpawn(command, args, options); }';

async function run(): Promise<void> {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const children: StandIn[] = [];
  let onStart: (child: StandIn) => void = () => undefined;

  Bun.plugin({
    name: 'stand-in spawn',
    setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/]spawn\.ts$/ }, () => ({ contents: SPAWN_SOURCE, loader: 'js' }));
    },
  });
  Reflect.set(globalThis, '__standInSpawn', (): StandIn => {
    const child = new StandIn();
    children.push(child);
    onStart(child);
    return child;
  });

  const direct: Record<string, unknown> = await import('../../src/spawn.js');
  if (!String(direct['spawnHidden']).includes('__standInSpawn')) {
    throw new Error('the stand-in is not loaded, so nothing may be asked');
  }
  const { askWindows } = await import('../../src/windows-ask.js');

  const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
  const told = (pending: Promise<string>): Promise<string> =>
    pending.then(
      (value) => `answered ${value.trim()}`,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  const helper = (index: number): StandIn => {
    const found = children[index];
    if (found === undefined) {
      throw new Error(`no helper ${String(index)} was started`);
    }
    return found;
  };
  const newest = (): StandIn => helper(children.length - 1);
  const finishAll = (): void => {
    for (const child of children) {
      child.finish();
    }
  };

  const result: Record<string, unknown> = {};

  // A helper that has answered once is ended on a timeout, and the tail of its half-written answer
  // arriving later must not join the line the next helper answers on.
  {
    const before = children.length;
    const warm = told(askWindows('warm', 5000));
    await sleep(10);
    const old = helper(before);
    old.answer(old.idOf(0), 'warm');
    result['warm'] = await warm;
    const first = told(askWindows('first', 100));
    const second = told(askWindows('second', 1000));
    await sleep(20);
    const answer = `${old.idOf(1)} OK ${Buffer.from('a long process listing', 'utf8').toString('base64')}`;
    old.stdout.write(answer.slice(0, 12));
    await sleep(130);
    result['tailFirstEnded'] = old.killed;
    result['tailSecondStarted'] = children.length === before + 2;
    old.stdout.write(answer.slice(12, 20));
    await sleep(20);
    const fresh = newest();
    fresh.answer(fresh.idOf(0), 'right');
    result['tailFirst'] = await first;
    result['tailSecond'] = await second;
    await sleep(20);
    finishAll();
  }

  // A helper that needs 400 ms to start must answer questions of 300 ms, and is not replaced.
  {
    const before = children.length;
    onStart = (child) => {
      const born = Date.now();
      child.on('asked', (line: string) => {
        setTimeout(
          () => {
            if (!child.killed) {
              child.answer(line.split(' ')[0] ?? '', 'ready');
            }
          },
          Math.max(0, 400 - (Date.now() - born)),
        );
      });
    };
    const said: string[] = [];
    for (let count = 0; count < 5; count += 1) {
      said.push(await told(askWindows(`q${String(count)}`, 300)));
    }
    result['slowStart'] = said;
    result['slowStartHelpers'] = children.length - before;
    onStart = () => undefined;
    finishAll();
  }

  // A helper that has answered and then goes quiet is still ended at the budget, and replaced.
  {
    const before = children.length;
    const warm = told(askWindows('warm', 5000));
    await sleep(10);
    const quiet = helper(before);
    quiet.answer(quiet.idOf(0), 'warm');
    await warm;
    result['quiet'] = await told(askWindows('stuck', 100));
    result['quietEnded'] = quiet.killed;
    const next = told(askWindows('again', 1000));
    await sleep(10);
    const fresh = newest();
    fresh.answer(fresh.idOf(0), 'back');
    result['quietNext'] = await next;
    result['quietHelpers'] = children.length - before;
    finishAll();
  }

  console.log(JSON.stringify(result));
  process.exit(0);
}

if (process.argv[1] === WINDOWS_ASK_STAND_IN) {
  await run();
}
