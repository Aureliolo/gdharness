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

/** What the keeper did when asked: ended the game, or found it already gone. */
export type KeeperAnswer = 'signalled' | 'gone';

export interface KeeperListening {
  readonly address: string;
  close(): void;
}

/**
 * Listens for a stop, answering it with what [param end] did. Null when it cannot listen, which
 * leaves a stop to the check it makes without a keeper.
 */
export async function listenForAStop(end: () => KeeperAnswer): Promise<KeeperListening | null> {
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
      socket.on('data', (chunk: string) => {
        asked += chunk;
        if (asked.includes('\n')) {
          socket.end(asked.startsWith('stop\n') ? `${end()}\n` : 'unknown\n');
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
export function askTheKeeperToStop(
  address: string,
  withinMs: number,
): Promise<KeeperAnswer | { readonly unreached: string }> {
  return new Promise((resolve) => {
    let said = '';
    let settled = false;
    const settle = (answer: KeeperAnswer | { readonly unreached: string }): void => {
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
      socket.write('stop\n');
    });
    socket.on('data', (chunk: string) => {
      said += chunk;
      const line = said.split('\n')[0] ?? '';
      if (said.includes('\n')) {
        settle(
          line === 'signalled' || line === 'gone'
            ? line
            : { unreached: `it answered ${JSON.stringify(line)}` },
        );
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
