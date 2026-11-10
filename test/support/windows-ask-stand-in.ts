/**
 * Runs `src/windows-ask.ts` against stand-in helpers and prints what happened as one JSON line.
 *
 * The module asks Windows through `powershell.exe`, which a case must never start. This script
 * replaces `src/spawn.ts` before the module loads, so every helper is an object here. It is run
 * as a child of the case under Bun, and it refuses to ask anything if the stand-in did not load.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

Object.defineProperty(process, 'platform', { value: 'win32' });

interface StandIn extends EventEmitter {
  command: string;
  exitCode: number | null;
  signalCode: string | null;
  killed: boolean;
  asked: string[];
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => boolean;
  unref: () => void;
}

const children: StandIn[] = [];
let onStart: (child: StandIn) => void = () => undefined;

const SPAWN_SOURCE = String.raw`export function spawnHidden(command, args, options) { return globalThis.__standInSpawn(command, args, options); }`;

Bun.plugin({
  name: 'stand-in spawn',
  setup(build) {
    build.onLoad({ filter: /[\\/]src[\\/]spawn\.ts$/ }, () => ({ contents: SPAWN_SOURCE, loader: 'js' }));
  },
});

Reflect.set(globalThis, '__standInSpawn', (command: string): StandIn => {
  const child = new EventEmitter() as StandIn;
  Object.assign(child, {
    command,
    exitCode: null,
    signalCode: null,
    killed: false,
    asked: [] as string[],
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => {
      child.killed = true;
      return true;
    },
    unref: () => undefined,
  });
  child.stdin.on('data', (chunk: Buffer) => {
    for (const line of String(chunk).split('\n').filter(Boolean)) {
      child.asked.push(line);
      child.emit('asked', line);
    }
  });
  children.push(child);
  onStart(child);
  return child;
});

const direct = (await import('../../src/spawn.js')) as Record<string, unknown>;
if (!String(direct['spawnHidden']).includes('__standInSpawn')) {
  throw new Error('the stand-in is not loaded, so nothing may be asked');
}
const { askWindows } = await import('../../src/windows-ask.js');

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const told = (pending: Promise<string>): Promise<string> =>
  pending.then(
    (value) => `answered ${value.trim()}`,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
const idOf = (child: StandIn, index: number): string => (child.asked[index] ?? '').split(' ')[0] ?? '';
const answerAs = (child: StandIn, id: string, text: string): void => {
  child.stdout.write(`${id} OK ${b64(text)}\n`);
};
const finish = (child: StandIn): void => {
  child.exitCode = 1;
  child.emit('exit', 1, null);
};

const result: Record<string, unknown> = {};

// A helper that has answered once is ended on a timeout, and the tail of its half-written answer
// arriving later must not join the line the next helper answers on.
{
  const before = children.length;
  const warm = told(askWindows('warm', 5000));
  await sleep(10);
  const old = children[before] as StandIn;
  answerAs(old, idOf(old, 0), 'warm');
  result['warm'] = await warm;
  const first = told(askWindows('first', 100));
  const second = told(askWindows('second', 1000));
  await sleep(20);
  const answer = `${idOf(old, 1)} OK ${b64('a long process listing')}`;
  old.stdout.write(answer.slice(0, 12));
  await sleep(130);
  result['tailFirstEnded'] = old.killed;
  result['tailSecondStarted'] = children.length === before + 2;
  old.stdout.write(answer.slice(12, 20));
  await sleep(20);
  const fresh = children.at(-1) as StandIn;
  answerAs(fresh, idOf(fresh, 0), 'right');
  result['tailFirst'] = await first;
  result['tailSecond'] = await second;
  await sleep(20);
  for (const child of children) finish(child);
}

// A helper that needs 400 ms to start must answer questions of 300 ms, and is not replaced.
{
  const before = children.length;
  onStart = (child) => {
    const born = Date.now();
    child.on('asked', (line: string) => {
      setTimeout(
        () => {
          if (!child.killed) answerAs(child, line.split(' ')[0] ?? '', 'ready');
        },
        Math.max(0, 400 - (Date.now() - born)),
      );
    });
  };
  const said: string[] = [];
  for (let count = 0; count < 5; count += 1) {
    said.push(await told(askWindows(`q${count}`, 300)));
  }
  result['slowStart'] = said;
  result['slowStartHelpers'] = children.length - before;
  onStart = () => undefined;
  for (const child of children) finish(child);
}

// A helper that has answered and then goes quiet is still ended at the budget, and replaced.
{
  const before = children.length;
  const warm = told(askWindows('warm', 5000));
  await sleep(10);
  const quiet = children[before] as StandIn;
  answerAs(quiet, idOf(quiet, 0), 'warm');
  await warm;
  result['quiet'] = await told(askWindows('stuck', 100));
  result['quietEnded'] = quiet.killed;
  const next = told(askWindows('again', 1000));
  await sleep(10);
  const fresh = children.at(-1) as StandIn;
  answerAs(fresh, idOf(fresh, 0), 'back');
  result['quietNext'] = await next;
  result['quietHelpers'] = children.length - before;
  for (const child of children) finish(child);
}

console.log(JSON.stringify(result));
process.exit(0);
