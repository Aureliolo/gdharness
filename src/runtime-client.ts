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

/** A game that announced itself and whose process was gone by the time anything looked. */
interface WentAway {
  readonly pid: number;
  readonly project: string;
  /** When the sweep noticed, which is an upper bound on when the game went rather than the moment. */
  readonly noticedAt: number;
}

/**
 * The games this server has watched go, newest first.
 *
 * Held in memory rather than on disk because the file is the thing being removed, and because what
 * it is for is the next sentence this server says: a refusal a minute later that can tell a game
 * that crashed from a project that never had the addon. A server that restarts has nothing to add
 * and says the ordinary thing, which is honest.
 *
 * Bounded both ways. Older than the window is not evidence about a call happening now, and a machine
 * running a fan-out would otherwise accumulate one of these per worker for as long as the process
 * lives.
 */
const GONE_WINDOW_MS = 120_000;
const GONE_KEPT = 32;
const gone: WentAway[] = [];

function wentAway(file: string, pid: number): void {
  // Read before the file goes, because the project is what decides whose game this was and
  // afterwards there is nowhere to get it.
  //
  // Nothing is kept for an announcement that cannot be read. "A game was here" without a project is
  // a fact that can only be reported to somebody it may not belong to, and these directories are
  // shared by every server on the machine: a crash in one project told to another is the right
  // shape about the wrong game, which is the mistake that once had a suite ending somebody else's
  // bench six times in fifty minutes.
  let project = '';
  try {
    const fields = asParams(JSON.parse(readFileSync(file, 'utf8')));
    project = readString(readParams(fields, 'project') ?? {}, 'path') ?? '';
  } catch {
    return;
  }
  if (project === '') {
    return;
  }
  gone.unshift({ pid, project, noticedAt: Date.now() });
  gone.length = Math.min(gone.length, GONE_KEPT);
}

/**
 * The games seen to go within the window, for the caller deciding what a refusal should say.
 *
 * Only this project's, and only when the caller says which project it is asking about. Without one
 * there is nothing to compare against, and answering anyway is how a shared directory turns into a
 * report about a stranger's game.
 */
function announcedAndGone(projectPath?: string): WentAway[] {
  if (projectPath === undefined) {
    return [];
  }
  const since = Date.now() - GONE_WINDOW_MS;
  const wanted = resolve(projectPath);
  return gone.filter((one) => one.noticedAt >= since && resolve(one.project) === wanted);
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
    const alive = processAlive(pid);
    const announced: Announced = alive ? parseAnnouncement(file, pid) : { kind: 'rubbish' };
    if (announced.kind === 'rubbish') {
      // A game that announced and whose process has since gone, remembered before the file naming
      // it is removed. The sweep is what destroys the evidence: afterwards a refusal can only say
      // nothing is running, which is the same sentence a project with no addon gets and a project
      // nobody started gets. The one that matters is the game that was there and died, and it is
      // the only one of the three the caller has to act on.
      if (!alive) {
        wentAway(file, pid);
      }
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
 * The one game to talk to. With a process id, that game; with a project path, the game running
 * that project; without either, the only game running. Two games and nothing to tell them apart
 * is a question this cannot answer, and the answer names both so the caller can.
 *
 * The process id is for a project running several games at once, which a bench fanning out to
 * thirty-one workers does: "stop all but one" was the only advice, and it is not advice a bench
 * can take. `editor_status` lists every game under `runtimes` with the number to pass.
 */
export function chooseRuntime(
  endpoints: readonly RuntimeEndpoint[],
  projectPath?: string,
  unspoken: readonly UnspokenRuntime[] = [],
  pid?: number,
): RuntimeChoice {
  if (pid !== undefined) {
    const named = endpoints.find((endpoint) => endpoint.pid === pid);
    if (named !== undefined) {
      if (projectPath !== undefined && resolve(named.project.path) !== resolve(projectPath)) {
        return {
          problem: `The game with pid ${pid} is running ${named.project.path}, not ${resolve(projectPath)}. Running: ${endpoints.map(describe).join('; ')}.`,
        };
      }
      return { endpoint: named };
    }
    const tooNewToo = unspoken.find((game) => game.pid === pid);
    if (tooNewToo !== undefined) {
      return { problem: tooNew([tooNewToo]) };
    }
    return {
      problem:
        endpoints.length === 0
          ? `No game with the runtime addon is running, so there is none with pid ${pid}. Start one with editor_run, or play the project from the editor with the addon enabled.`
          : `No running game has pid ${pid}. Running: ${endpoints.map(describe).join('; ')}. editor_status lists them under runtimes as they come and go.`,
    };
  }
  if (endpoints.length === 0) {
    if (unspoken.length > 0) {
      return { problem: tooNew(unspoken) };
    }
    // A game that was here and went is a different answer from one that never started, and the
    // caller can only act on the first: the game crashed or was ended, and its output is worth
    // reading. Without this both are the same sentence, which is what a downstream run hit on a
    // game that announced on a port and died seconds later.
    const went = announcedAndGone(projectPath);
    const first = went[0];
    if (first !== undefined) {
      const ago = Math.max(1, Math.round((Date.now() - first.noticedAt) / 1000));
      // The most recent is the one whose output is worth reading, and the rest are counted so that
      // a game which has crashed three times this minute is not reported as one that crashed once.
      const others = went.length - 1;
      const earlier =
        others === 0 ? '' : ` ${others} earlier ${others === 1 ? 'one' : 'ones'} went the same way.`;
      return {
        problem:
          `A game with the runtime addon announced itself and its process is gone: pid ${first.pid}` +
          `${first.project === '' ? '' : ` for ${first.project}`}, noticed ${ago}s ago.${earlier}` +
          ' It quit or was ended rather than never starting, so editor_output has what it printed' +
          ' on the way, including whatever it broke on. Start another with editor_run once you have read it.',
      };
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
      problem: `Several games are running from ${wanted}: ${matching.map(describe).join('; ')}. Pass pid to choose one.`,
    };
  }
  if (endpoints.length === 1 && endpoints[0]) {
    return { endpoint: endpoints[0] };
  }
  return {
    problem: `Several games are running: ${endpoints.map(describe).join('; ')}. Pass projectPath to choose one, or pid when they are from one project.`,
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
