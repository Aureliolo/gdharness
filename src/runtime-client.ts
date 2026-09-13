/**
 * The client side of the runtime addon's protocol: finding a running game, and asking it one
 * thing.
 *
 * A game announces itself by writing one file into a directory both sides derive the same way,
 * named by its process id and holding the port it chose. The port is ephemeral, so two games
 * can run at once and a headless operation never takes the port a game wanted. The server reads
 * the directory, drops entries whose process is gone, and connects to what is left.
 *
 * Every request carries an id and the reply echoes it, so a reply is matched rather than
 * assumed, and the three ways a request can fail are told apart: no game, a game that refused
 * the connection, and a game that accepted it and then said nothing.
 */

import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { envValue } from './launch.js';
import { asParams, readNumber, readParams, readString } from './tool-args.js';

/** The protocol version the addon has to speak. Bumped whenever a reply or request changes. */
export const RUNTIME_PROTOCOL = 2;

const ANNOUNCEMENT_PATTERN = /^runtime-(\d+)\.json$/;

export interface RuntimeEndpoint {
  readonly pid: number;
  readonly port: number;
  readonly address: string;
  readonly project: { readonly name: string; readonly path: string };
  readonly file: string;
}

/**
 * Where this server announces and looks first. The addon derives the same path with the same
 * precedence, so the two only meet if this stays in step with `_announcement_directory` in the
 * runtime autoload: an explicit override, the per-user runtime directory where the platform has
 * one, and otherwise the temporary directory.
 */
export function runtimeDirectory(variables: NodeJS.ProcessEnv = process.env): string {
  const explicit = envValue('GDHARNESS_RUNTIME_DIR', variables);
  if (explicit) {
    return explicit;
  }
  const perUser = envValue('XDG_RUNTIME_DIR', variables);
  return join(perUser ?? tmpdir(), 'gdharness');
}

/**
 * Every directory a game on this machine could have announced itself in.
 *
 * Deriving the path the same way on both sides is not enough, because the two sides do not share
 * an environment. A game is started by the editor, the editor by whoever opened it, and this
 * server by the harness: an editor launched without TMP or TEMP set puts its games in the
 * Windows directory's Temp while this server, started with them set, watches the user's. Measured
 * on Windows, where it cost a session: the game announced in C:\Windows\Temp\gdharness and the
 * server created and swept an empty C:\Users\<name>\AppData\Local\Temp\gdharness beside it,
 * answering that no game was running while one was.
 *
 * `editor_launch` now passes the first of these down, so an editor this server opened puts its
 * games where this server looks. The rest are for the editor it did not open, which is most of
 * them: a fallback list beats a silent empty answer, and a stale announcement is already handled
 * by the process check.
 */
export function runtimeDirectories(variables: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [runtimeDirectory(variables)];
  const fallbacks =
    process.platform === 'win32'
      ? [envValue('SystemRoot', variables) ?? envValue('windir', variables) ?? 'C:\\Windows']
      : ['/tmp', '/var/tmp'];
  for (const base of fallbacks) {
    candidates.push(join(base, process.platform === 'win32' ? 'Temp' : '', 'gdharness'));
  }
  return [...new Set(candidates.map((path) => resolve(path)))];
}

/** Whether a process with this id exists. Signal 0 delivers nothing and only checks. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Alive but owned by another user, which is still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseAnnouncement(file: string, pid: number): RuntimeEndpoint | null {
  let fields: Record<string, unknown>;
  try {
    fields = asParams(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
  const project = readParams(fields, 'project');
  const port = readNumber(fields, 'port');
  const address = readString(fields, 'address');
  if (
    readNumber(fields, 'protocol') !== RUNTIME_PROTOCOL ||
    readNumber(fields, 'pid') !== pid ||
    port === undefined ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    address === undefined ||
    project === undefined
  ) {
    return null;
  }
  return {
    pid,
    port,
    address,
    project: { name: readString(project, 'name') ?? '', path: readString(project, 'path') ?? '' },
    file,
  };
}

/**
 * Every game announced anywhere one could have announced itself, whose process still exists.
 *
 * An announcement whose process is gone, or that cannot be read as one, is deleted on the way
 * past: a game that crashed never removed its own, and nothing else will. The same process id
 * found in two directories is one game, since a game writes one file and only its own.
 */
export function discoverRuntimes(directories: readonly string[] = runtimeDirectories()): RuntimeEndpoint[] {
  const found = new Map<number, RuntimeEndpoint>();
  for (const directory of directories) {
    for (const endpoint of announcedIn(directory)) {
      if (!found.has(endpoint.pid)) {
        found.set(endpoint.pid, endpoint);
      }
    }
  }
  return [...found.values()].sort((a, b) => b.pid - a.pid);
}

function announcedIn(directory: string): RuntimeEndpoint[] {
  if (!existsSync(directory)) {
    return [];
  }
  const found: RuntimeEndpoint[] = [];
  for (const entry of readdirSync(directory)) {
    const match = ANNOUNCEMENT_PATTERN.exec(entry);
    if (!match) {
      continue;
    }
    const file = join(directory, entry);
    const pid = Number.parseInt(match[1] ?? '', 10);
    const endpoint = processAlive(pid) ? parseAnnouncement(file, pid) : null;
    if (endpoint) {
      found.push(endpoint);
    } else {
      try {
        unlinkSync(file);
      } catch {
        // Another reader may have cleaned it first, which is the same outcome.
      }
    }
  }
  return found;
}

export type RuntimeChoice = { endpoint: RuntimeEndpoint } | { problem: string };

function describe(endpoint: RuntimeEndpoint): string {
  return `pid ${endpoint.pid} on ${endpoint.address}:${endpoint.port} (${endpoint.project.name || 'unnamed'} at ${endpoint.project.path})`;
}

/**
 * The one game to talk to. With a project path, the game running that project; without one,
 * the only game running. Two games and no project path is a question this cannot answer, and
 * the answer names both so the caller can.
 */
export function chooseRuntime(endpoints: readonly RuntimeEndpoint[], projectPath?: string): RuntimeChoice {
  if (endpoints.length === 0) {
    return {
      problem:
        'No game with the runtime addon is running. Start one with editor_run, or play the project from the editor with the addon enabled.',
    };
  }
  if (projectPath !== undefined) {
    const wanted = resolve(projectPath);
    const matching = endpoints.filter((endpoint) => resolve(endpoint.project.path) === wanted);
    if (matching.length === 0) {
      return {
        problem: `No running game is from ${wanted}. Running: ${endpoints.map(describe).join('; ')}.`,
      };
    }
    if (matching.length === 1 && matching[0]) {
      return { endpoint: matching[0] };
    }
    return {
      problem: `Several games are running from ${wanted}: ${matching.map(describe).join('; ')}. Stop all but one.`,
    };
  }
  if (endpoints.length === 1 && endpoints[0]) {
    return { endpoint: endpoints[0] };
  }
  return {
    problem: `Several games are running: ${endpoints.map(describe).join('; ')}. Pass projectPath to choose one.`,
  };
}

export type RuntimeReply =
  | { readonly ok: true; readonly payload: Record<string, unknown>; readonly endpoint: RuntimeEndpoint }
  | {
      readonly ok: false;
      readonly reason: 'refused' | 'busy' | 'protocol' | 'error';
      readonly message: string;
    };

let nextRequestId = 1;

/**
 * One request to one game, answered by the reply that carries its id.
 *
 * The first line a game sends is its welcome, which names the protocol it speaks; a game built
 * against an older addon is told apart from one that answered wrongly. Anything else on the
 * wire that does not carry the id is somebody else's business and is skipped.
 */
export function runtimeRequest(
  endpoint: RuntimeEndpoint,
  command: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<RuntimeReply> {
  const id = nextRequestId++;
  return new Promise((settle) => {
    let done = false;
    let buffered = '';
    let welcomed = false;

    const socket = createConnection({ port: endpoint.port, host: endpoint.address });
    const finish = (reply: RuntimeReply): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      socket.destroy();
      settle(reply);
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        reason: 'busy',
        message: `The game (${describe(endpoint)}) accepted the connection but did not answer '${command}' within ${timeoutMs}ms. It may be paused at a breakpoint or stuck in a long frame.`,
      });
    }, timeoutMs);

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ id, command, params })}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline !== -1 && !done) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        if (line === '') {
          continue;
        }
        let message: Record<string, unknown>;
        try {
          message = asParams(JSON.parse(line));
        } catch {
          continue;
        }
        if (!welcomed) {
          welcomed = true;
          if (readString(message, 'type') === 'welcome') {
            const spoken = readNumber(message, 'protocol');
            if (spoken !== RUNTIME_PROTOCOL) {
              finish({
                ok: false,
                reason: 'protocol',
                message: `The game (${describe(endpoint)}) speaks runtime protocol ${spoken ?? 'unknown'} and this server speaks ${RUNTIME_PROTOCOL}. Reinstall the runtime addon into the project.`,
              });
              return;
            }
            continue;
          }
        }
        if (message['id'] !== id) {
          continue;
        }
        if (readString(message, 'type') === 'error') {
          finish({ ok: false, reason: 'error', message: readString(message, 'message') ?? 'unknown error' });
          return;
        }
        finish({ ok: true, payload: message, endpoint });
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        reason: 'refused',
        message: `The game (${describe(endpoint)}) is running but nothing answered on its port: ${error.code ?? error.message}. It may still be starting, or be shutting down.`,
      });
    });
    socket.on('close', () => {
      finish({
        ok: false,
        reason: 'refused',
        message: `The game (${describe(endpoint)}) closed the connection before answering '${command}'.`,
      });
    });
  });
}
