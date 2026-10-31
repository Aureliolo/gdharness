/**
 * How a server asks the keeper holding a run to end it.
 *
 * Ending a run by its pid means first proving the pid is still the run, and on Windows that takes a
 * query PowerShell answers and a `tasklist` behind it. A machine loaded by the game itself, a
 * windowed engine rendering in software on a runner with no GPU, started neither in time, and the
 * stop refused to end its own game three times in one day. The keeper needs no proof: it started the
 * game, or started the helper that did, and the handle held there names that one process for as long
 * as it is held. So the keeper listens here, and the stop is asked of it first.
 *
 * A named pipe on Windows, whose default access lets only its creator's account and administrators
 * write to it, and a socket in a directory only this user can enter elsewhere. The name is random,
 * so nothing can be waiting on it before the keeper is.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import type { DebugAnswer, DebugRequest } from './game-debugger.js';
import { isRecord } from './records.js';

/** How a question for the game's debugger starts its line; the JSON of the request follows. */
const DEBUG_PREFIX = 'debug ';

/** What the keeper did when asked: ended the game, or found it already gone. */
export type KeeperAnswer = 'signalled' | 'gone';

export interface KeeperListening {
  readonly address: string;
  close(): void;
}

/**
 * What [param end] did, or why it could not, which the asking server reads as a keeper it could not
 * reach and ends the run by its pid instead. Caught here because a throw from inside the listener
 * ends the keeper, and the game it holds would run on held by nobody.
 */
function endedOrWhyNot(end: () => KeeperAnswer): string {
  try {
    return end();
  } catch (error) {
    return `could not end it: ${error instanceof Error ? error.message : String(error)}`.replaceAll(
      '\n',
      ' ',
    );
  }
}

/** What the keeper's debugger answers, as one line of JSON. */
async function debuggedOrWhyNot(
  debug: ((request: DebugRequest) => Promise<DebugAnswer>) | null,
  asked: string,
): Promise<string> {
  if (debug === null) {
    return JSON.stringify({ refused: 'This run has no debugger.' });
  }
  try {
    const request = debugRequestOf(JSON.parse(asked));
    if (request === null) {
      return JSON.stringify({ refused: `The debugger takes no request like ${asked.slice(0, 200)}.` });
    }
    return JSON.stringify(await debug(request));
  } catch (error) {
    return JSON.stringify({ refused: `The debugger could not answer: ${errorText(error)}` });
  }
}

const RESUMED_HOW = ['continue', 'next', 'step', 'out'] as const;

/** The request [param asked] is, or null when it is not one the debugger takes. */
function debugRequestOf(asked: unknown): DebugRequest | null {
  if (!isRecord(asked)) {
    return null;
  }
  const { op, script, line, set, how, frame, expression } = asked;
  switch (op) {
    case 'breakpoint':
      return typeof script === 'string' && typeof line === 'number' && typeof set === 'boolean'
        ? { op, script, line, set }
        : null;
    case 'pause':
    case 'stack':
    case 'output':
    case 'state':
      return { op };
    case 'resume': {
      const resumed = RESUMED_HOW.find((one) => one === how);
      return resumed === undefined ? null : { op, how: resumed };
    }
    case 'variables':
      return typeof frame === 'number' ? { op, frame } : null;
    case 'evaluate':
      return typeof frame === 'number' && typeof expression === 'string' ? { op, frame, expression } : null;
    default:
      return null;
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replaceAll('\n', ' ');
}

/**
 * Listens for the server: a stop, answered with what [param end] did, and a question for the game's
 * debugger, answered by [param debug]. Null when it cannot listen, which leaves a stop to the check
 * it makes without a keeper.
 */
export async function listenForTheServer(
  end: () => KeeperAnswer,
  debug: ((request: DebugRequest) => Promise<DebugAnswer>) | null,
): Promise<KeeperListening | null> {
  let directory: string | null = null;
  try {
    directory = process.platform === 'win32' ? null : mkdtempSync(join(tmpdir(), 'gdharness-keeper-'));
    const address =
      directory === null ? `\\\\.\\pipe\\gdharness-keeper-${randomUUID()}` : join(directory, 'keeper.sock');
    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('error', () => {
        // A server that gave up waiting, which leaves nothing here to answer.
      });
      let asked = '';
      let answering = false;
      socket.on('data', (chunk: string) => {
        asked += chunk;
        const line = asked.split('\n')[0] ?? '';
        if (answering || !asked.includes('\n')) {
          return;
        }
        answering = true;
        if (line === 'stop') {
          socket.end(`${endedOrWhyNot(end)}\n`);
        } else if (line.startsWith(DEBUG_PREFIX)) {
          void debuggedOrWhyNot(debug, line.slice(DEBUG_PREFIX.length)).then((answer) => {
            socket.end(`${answer}\n`);
          });
        } else {
          socket.end('unknown\n');
        }
      });
    });
    await listening(server, address);
    const made = directory;
    return {
      address,
      close: () => {
        server.close();
        if (made !== null) {
          rmSync(made, { recursive: true, force: true });
        }
      },
    };
  } catch {
    if (directory !== null) {
      rmSync(directory, { recursive: true, force: true });
    }
    return null;
  }
}

function listening(server: Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/**
 * Asks the keeper at [param address] to end its game, or says why it could not be asked. A keeper
 * that has gone took its game with it or saw it go, but a stop does not rest on that: whoever answers,
 * the caller still waits for the process itself to go.
 */
export async function askTheKeeperToStop(
  address: string,
  withinMs: number,
): Promise<KeeperAnswer | { readonly unreached: string }> {
  const answered = await askTheKeeper(address, 'stop', withinMs);
  if (typeof answered !== 'string') {
    return answered;
  }
  return answered === 'signalled' || answered === 'gone'
    ? answered
    : { unreached: `it answered ${JSON.stringify(answered)}` };
}

/** Asks the debugger of the game the keeper at [param address] holds. */
export async function askTheKeepersDebugger(
  address: string,
  request: DebugRequest,
  withinMs: number,
): Promise<DebugAnswer | { readonly unreached: string }> {
  const answered = await askTheKeeper(address, `${DEBUG_PREFIX}${JSON.stringify(request)}`, withinMs);
  if (typeof answered !== 'string') {
    return answered;
  }
  try {
    const parsed: unknown = JSON.parse(answered);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Said below.
  }
  return { unreached: `it answered ${JSON.stringify(answered.slice(0, 200))}` };
}

/** The first line the keeper at [param address] answers [param line] with, or why there was none. */
function askTheKeeper(
  address: string,
  line: string,
  withinMs: number,
): Promise<string | { readonly unreached: string }> {
  return new Promise((resolve) => {
    let said = '';
    let settled = false;
    const settle = (answer: string | { readonly unreached: string }): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(answer);
      }
    };
    const socket = connect(address);
    const timer = setTimeout(() => {
      settle({ unreached: `it did not answer within ${withinMs} ms` });
    }, withinMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${line}\n`);
    });
    socket.on('data', (chunk: string) => {
      said += chunk;
      if (said.includes('\n')) {
        settle(said.split('\n')[0] ?? '');
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      settle({ unreached: error.code ?? error.message });
    });
    socket.on('close', () => {
      settle({ unreached: 'it closed the connection without answering' });
    });
  });
}
