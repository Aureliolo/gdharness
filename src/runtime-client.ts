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
import { setTimeout as delay } from 'node:timers/promises';
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

/**
 * What one announcement turned out to be: a game to talk to, a game speaking a protocol this
 * server does not, or nothing worth keeping.
 */
type Announced =
  | { readonly kind: 'runtime'; readonly endpoint: RuntimeEndpoint }
  | { readonly kind: 'unspoken'; readonly unspoken: UnspokenRuntime }
  | { readonly kind: 'rubbish' };

/** A game that is running and announcing, in a protocol this server was not built to speak. */
export interface UnspokenRuntime {
  readonly pid: number;
  readonly protocol: number;
  readonly project: { readonly name: string; readonly path: string };
}

function parseAnnouncement(file: string, pid: number): Announced {
  let fields: Record<string, unknown>;
  try {
    fields = asParams(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return { kind: 'rubbish' };
  }
  const project = readParams(fields, 'project');
  const port = readNumber(fields, 'port');
  const address = readString(fields, 'address');
  const protocol = readNumber(fields, 'protocol');
  if (
    readNumber(fields, 'pid') !== pid ||
    port === undefined ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    address === undefined ||
    project === undefined
  ) {
    return { kind: 'rubbish' };
  }
  const named = {
    name: readString(project, 'name') ?? '',
    path: readString(project, 'path') ?? '',
  };
  // A protocol this server does not speak is a running game, not rubbish, and the difference
  // decides whether its announcement survives. Deleting it takes the game away from the newer
  // server that is about to replace this one as well: `setup.py` upgrades the addon on disk the
  // moment a pin moves while the server a session already spawned stays as it was, so an upgrade
  // that moves this number leaves the game ahead of the server until the reconnect. Only one that
  // moves it, which is the minority of them. Kept and named instead, so the answer is which half is
  // behind rather than that nobody is playing anything.
  if (protocol !== RUNTIME_PROTOCOL) {
    return { kind: 'unspoken', unspoken: { pid, protocol: protocol ?? 0, project: named } };
  }
  return { kind: 'runtime', endpoint: { pid, port, address, project: named, file } };
}

/** What a sweep of the announcement directories found: games to talk to, and games too new. */
export interface RuntimesAnnounced {
  readonly running: RuntimeEndpoint[];
  readonly unspoken: UnspokenRuntime[];
}

/**
 * Every game announced anywhere one could have announced itself, whose process still exists.
 *
 * An announcement whose process is gone, or that cannot be read as one, is deleted on the way
 * past: a game that crashed never removed its own, and nothing else will. One whose protocol this
 * server does not speak is kept and reported, for the reason written on [parseAnnouncement]. The
 * same process id found in two directories is one game, since a game writes one file and only its
 * own.
 */
export function runtimesAnnounced(directories: readonly string[] = runtimeDirectories()): RuntimesAnnounced {
  const running = new Map<number, RuntimeEndpoint>();
  const unspoken = new Map<number, UnspokenRuntime>();
  for (const directory of directories) {
    for (const found of announcedIn(directory)) {
      if (found.kind === 'runtime' && !running.has(found.endpoint.pid)) {
        running.set(found.endpoint.pid, found.endpoint);
      } else if (found.kind === 'unspoken' && !unspoken.has(found.unspoken.pid)) {
        unspoken.set(found.unspoken.pid, found.unspoken);
      }
    }
  }
  const newest = (a: { pid: number }, b: { pid: number }): number => b.pid - a.pid;
  return { running: [...running.values()].sort(newest), unspoken: [...unspoken.values()].sort(newest) };
}

/** Only the games this server can talk to, for a caller with nothing to say about the rest. */
export function discoverRuntimes(directories: readonly string[] = runtimeDirectories()): RuntimeEndpoint[] {
  return runtimesAnnounced(directories).running;
}

function announcedIn(directory: string): Announced[] {
  if (!existsSync(directory)) {
    return [];
  }
  const found: Announced[] = [];
  for (const entry of readdirSync(directory)) {
    const match = ANNOUNCEMENT_PATTERN.exec(entry);
    if (!match) {
      continue;
    }
    const file = join(directory, entry);
    const pid = Number.parseInt(match[1] ?? '', 10);
    const announced: Announced = processAlive(pid) ? parseAnnouncement(file, pid) : { kind: 'rubbish' };
    if (announced.kind === 'rubbish') {
      try {
        unlinkSync(file);
      } catch {
        // Another reader may have cleaned it first, which is the same outcome.
      }
      continue;
    }
    found.push(announced);
  }
  return found;
}

/** How often the wait below looks, and the longest it will wait at all. */
const LOOK_EVERY_MS = 50;
export const ANNOUNCE_BUDGET_MS = 5_000;

/** How the wait below is bounded: how long, where to look, and when to stop early. */
export interface WaitingForRuntime {
  readonly budgetMs?: number;
  readonly directories?: readonly string[];
  /** Answered on every look. True ends the wait: a game held at a breakpoint is not booting. */
  readonly giveUp?: () => boolean;
}

/**
 * The game from [projectPath] that announced itself while this waited, or nothing.
 *
 * Starting a game and being able to talk to it are two moments, and everything treated them as
 * one. The editor answers `play_scene` as soon as it has asked the engine to play; the engine
 * then boots, and the runtime binds a port and writes its announcement somewhere inside that. So
 * the call straight after a start was answered "No game with the runtime addon is running", about
 * a game that was starting, and the way through was to make the same call again a moment later.
 *
 * By process id rather than by counting, because the game that was just stopped can still be
 * dying with its announcement on disk: what this waits for is a game nobody had seen before.
 */
export async function announcedSince(
  projectPath: string,
  before: ReadonlySet<number>,
  waiting: WaitingForRuntime = {},
): Promise<RuntimeEndpoint | null> {
  const wanted = resolve(projectPath);
  const directories = waiting.directories ?? runtimeDirectories();
  const until = Date.now() + Math.max(waiting.budgetMs ?? ANNOUNCE_BUDGET_MS, 0);
  for (;;) {
    const fresh = discoverRuntimes(directories).find(
      (endpoint) => !before.has(endpoint.pid) && resolve(endpoint.project.path) === wanted,
    );
    if (fresh !== undefined) {
      return fresh;
    }
    const left = until - Date.now();
    if (left <= 0 || waiting.giveUp?.() === true) {
      return null;
    }
    await delay(Math.min(LOOK_EVERY_MS, left));
  }
}

export type RuntimeChoice = { endpoint: RuntimeEndpoint } | { problem: string };

function describe(endpoint: RuntimeEndpoint): string {
  return `pid ${endpoint.pid} on ${endpoint.address}:${endpoint.port} (${endpoint.project.name || 'unnamed'} at ${endpoint.project.path})`;
}

/**
 * What to say when the only games running speak a protocol this server was not built for.
 *
 * Which half is behind, and what to do about it, because "no game is running" is the one answer
 * that is certainly false here and it sends the reader to start a second game.
 */
function tooNew(unspoken: readonly UnspokenRuntime[]): string {
  const named = unspoken
    .map(
      (game) =>
        `pid ${game.pid} speaks ${game.protocol} (${game.project.name || 'unnamed'} at ${game.project.path})`,
    )
    .join('; ');
  const half = unspoken.some((game) => game.protocol > RUNTIME_PROTOCOL)
    ? 'this server is the older half: reconnect it so it spawns the installed version'
    : 'the addon is the older half: reinstall it and restart the game';
  return `A game is running, in a protocol this server does not speak ${named}. This server speaks ${RUNTIME_PROTOCOL}, so ${half}.`;
}

/**
 * The one game to talk to. With a project path, the game running that project; without one,
 * the only game running. Two games and no project path is a question this cannot answer, and
 * the answer names both so the caller can.
 */
export function chooseRuntime(
  endpoints: readonly RuntimeEndpoint[],
  projectPath?: string,
  unspoken: readonly UnspokenRuntime[] = [],
): RuntimeChoice {
  if (endpoints.length === 0) {
    if (unspoken.length > 0) {
      return { problem: tooNew(unspoken) };
    }
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
