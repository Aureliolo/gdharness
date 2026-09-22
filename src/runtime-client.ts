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

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { envValue } from './launch.js';
import { isSameDirectory, realPathOr } from './paths.js';
import { startTimesOf } from './process-children.js';
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
  /**
   * The editor that played this game, when the game was played by one running the editor addon:
   * the addon puts its process id into its environment and the game announces what it inherited.
   * Absent for a game started any other way, and for one carrying a runtime addon from before
   * this was announced.
   */
  readonly editorPid?: number;
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

/**
 * The file a game the editor plays writes the engine's error reports to, beside its announcement
 * and named the same way. Kept in step with `ERROR_REPORT_NAME` in the runtime autoload.
 */
const ERROR_REPORT_PATTERN = /^runtime-(\d+)\.log$/;

/** The error report of the game with [param pid], in whichever directory it announced in. */
export function errorReportOf(
  pid: number,
  directories: readonly string[] = runtimeDirectories(),
): string | null {
  for (const directory of directories) {
    const path = join(directory, `runtime-${pid}.log`);
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
}

/**
 * How long a report outlives its game before the sweep takes it. Long enough for the server that
 * was reading the run to take the last of it after the game has gone, which is when the last
 * errors matter most, and short enough that a machine playing games all day does not keep them.
 */
const ERROR_REPORT_KEEP_MS = 60 * 60 * 1000;

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
  const editorPid = readNumber(fields, 'editor_pid');
  return {
    kind: 'runtime',
    endpoint: {
      pid,
      port,
      address,
      project: named,
      file,
      ...(editorPid !== undefined && Number.isInteger(editorPid) && editorPid > 0 ? { editorPid } : {}),
    },
  };
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
  return gone.filter((one) => one.noticedAt >= since && isSameDirectory(one.project, projectPath));
}

/**
 * How long after an announcement was written a process may have started and still be the game
 * that wrote it.
 *
 * The game starts, boots, and writes the announcement in its first frames, so its start is before
 * the file's time by the boot and never after it. What this absorbs is the second the platforms
 * round a start time to and the granularity of a file time, and nothing else. A process that
 * began later than that is one that took the number after the game had gone, which is what a
 * shell did downstream: an announcement of a game ended an hour before read as a game "still
 * starting, or shutting down" for as long as the shell lived, because a number the operating
 * system has handed out again answers to a signal exactly as the game did.
 */
export const STARTED_AFTER_ANNOUNCING_MS = 2_000;

/**
 * How long a process confirmed as its announcement's game is believed before it is asked again.
 *
 * Confirmed once, the number is the game's until the game goes, and the sweep takes the file the
 * moment the number answers to nobody. A game that goes and has its number taken between two
 * sweeps is the gap this bounds: a stale yes lasts at most this long, and asking the operating
 * system costs an interpreter start on Windows, so it is not asked on every look.
 */
export const CONFIRMED_FOR_MS = 60_000;

/**
 * How old an announcement has to be before the process behind it is asked about at all.
 *
 * The question costs an interpreter start on Windows, and the sweep that asks it is the one the
 * start's wait runs every fifty milliseconds while a game boots: asked of a fresh announcement it
 * held that wait for half a second at the moment the game announced, and a fixture that needs the
 * announcement found inside seven hundred milliseconds read the delay as the fault it guards. A
 * number taken over inside a minute of the game announcing needs the game to have died and the
 * number to have come round again within that minute, and the sweep after the minute asks anyway,
 * so what this costs is a stale yes of at most a minute on a run that short.
 */
export const JUDGED_AFTER_MS = 60_000;

/** What was decided about the process behind one announcement, and when the file said it. */
interface Verdict {
  readonly writtenAt: number;
  readonly judgedAt: number;
  readonly stranger: boolean;
}

const verdicts = new Map<string, Verdict>();

/**
 * Whether each announced process is the game that wrote its announcement, from when it started.
 *
 * Asked of the operating system once per file, and again once the confirmation has aged, in one
 * question for all of them. A platform that will not say leaves the announcement believed, which
 * is what it was before anything asked. [param startTimes] is the operating system's answer, an
 * argument so a case can supply the disagreement rather than wait to meet one.
 */
export function strangersAmong(
  candidates: readonly { file: string; pid: number; writtenAt: number }[],
  now: number,
  startTimes: (pids: readonly number[]) => Map<number, number> = startTimesOf,
): Set<string> {
  const toJudge = candidates.filter((one) => {
    if (now - one.writtenAt < JUDGED_AFTER_MS) {
      return false;
    }
    const known = verdicts.get(one.file);
    return (
      known === undefined ||
      known.writtenAt !== one.writtenAt ||
      (!known.stranger && now - known.judgedAt > CONFIRMED_FOR_MS)
    );
  });
  if (toJudge.length > 0) {
    const began = startTimes(toJudge.map((one) => one.pid));
    for (const one of toJudge) {
      const at = began.get(one.pid);
      const stranger = at !== undefined && at - one.writtenAt > STARTED_AFTER_ANNOUNCING_MS;
      verdicts.set(one.file, { writtenAt: one.writtenAt, judgedAt: now, stranger });
    }
  }
  return new Set(
    candidates.filter((one) => verdicts.get(one.file)?.stranger === true).map((one) => one.file),
  );
}

function announcedIn(directory: string): Announced[] {
  if (!existsSync(directory)) {
    return [];
  }
  const found: Announced[] = [];
  const candidates: { file: string; pid: number; writtenAt: number }[] = [];
  const entries: { file: string; pid: number; alive: boolean }[] = [];
  for (const entry of readdirSync(directory)) {
    const report = ERROR_REPORT_PATTERN.exec(entry);
    if (report) {
      sweepErrorReport(join(directory, entry), Number.parseInt(report[1] ?? '', 10));
      continue;
    }
    const match = ANNOUNCEMENT_PATTERN.exec(entry);
    if (!match) {
      continue;
    }
    const file = join(directory, entry);
    const pid = Number.parseInt(match[1] ?? '', 10);
    const alive = processAlive(pid);
    entries.push({ file, pid, alive });
    if (alive) {
      try {
        candidates.push({ file, pid, writtenAt: statSync(file).mtimeMs });
      } catch {
        // Taken by another reader between the listing and this; the parse below says rubbish.
      }
    }
  }
  const strangers = strangersAmong(candidates, Date.now());
  for (const { file, pid, alive } of entries) {
    // A number answering to a signal is not the game unless the process behind it is the one that
    // wrote the file; one that is not is swept as a game that has gone, which is what it is.
    const gone = !alive || strangers.has(file);
    const announced: Announced = gone ? { kind: 'rubbish' } : parseAnnouncement(file, pid);
    if (announced.kind === 'rubbish') {
      // A file that will not parse under a live number is one being written: the game opens it
      // empty and fills it in the same instant, and a look between the two reads nothing. The
      // next look reads it whole, and a sweep here takes an announcement the game has made and
      // will not make again, so its run is never found under any wait.
      if (!gone) {
        continue;
      }
      // A game that announced and whose process has since gone, remembered before the file naming
      // it is removed. The sweep is what destroys the evidence: afterwards a refusal can only say
      // nothing is running, which is the same sentence a project with no addon gets and a project
      // nobody started gets. The one that matters is the game that was there and died, and it is
      // the only one of the three the caller has to act on.
      wentAway(file, pid);
      try {
        unlinkSync(file);
      } catch {
        // Another reader may have cleaned it first, which is the same outcome.
      }
      verdicts.delete(file);
      continue;
    }
    found.push(announced);
  }
  // A verdict about a file this directory no longer holds goes with the file, so a machine playing
  // games all day does not keep one per game it ever saw: a game that quits removes its own
  // announcement, and that removal is not a sweep.
  const held = new Set(entries.map((one) => one.file));
  const here = join(directory, '.');
  for (const file of verdicts.keys()) {
    if (dirname(file) === here && !held.has(file)) {
      verdicts.delete(file);
    }
  }
  return found;
}

/**
 * The longest a stop waits for the game it ended to go before taking its announcement down. The
 * editor ends a game with a kill and the operating system reaps it inside a second; a process
 * still there after this is one the stop did not end, and its announcement stays with it.
 */
const ENDED_WITHIN_MS = 3_000;

/**
 * The announcement of the game [param pid] taken down by the server that ended it, once the
 * process has gone, wherever the game announced.
 *
 * The next sweep would take it the same way, and what this closes is the gap before that sweep.
 * A number the operating system hands out again inside the gap answers to a signal as the game
 * did, and the file then reads as a game "still starting, or shutting down" for as long as the
 * newcomer lives: a shell downstream held one for an hour after a stop, through two further runs
 * and a restart of the editor. The server that ended the game is the one place that knows both
 * the number and that ending it was meant, so it takes the file the moment the number falls
 * silent rather than leaving it for whatever looks next. Only once the process has gone, because
 * a stop the editor did not carry out is a game still running, and the sweep judges that one by
 * when it started.
 */
export async function announcementEnded(
  pid: number,
  directories: readonly string[] = runtimeDirectories(),
): Promise<void> {
  const files = directories
    .map((directory) => join(directory, `runtime-${pid}.json`))
    .filter((file) => existsSync(file));
  const first = files[0];
  if (first === undefined) {
    return;
  }
  const until = Date.now() + ENDED_WITHIN_MS;
  while (processAlive(pid)) {
    const left = until - Date.now();
    if (left <= 0) {
      return;
    }
    await delay(Math.min(LOOK_EVERY_MS, left));
  }
  // Remembered once however many directories held it: a game writes one file, and the refusal
  // this feeds counts games rather than copies.
  wentAway(first, pid);
  for (const file of files) {
    try {
      unlinkSync(file);
    } catch {
      // A sweep took it between the look and this, which is the same outcome.
    }
    verdicts.delete(file);
  }
}

/**
 * A report whose game is gone and that has sat for longer than the keep is removed. Not with the
 * announcement, which goes the moment the game does: the report is what the run's last errors are
 * read from, and the server reading the run may not look until after the game has gone.
 */
function sweepErrorReport(path: string, pid: number, now = Date.now()): void {
  if (processAlive(pid)) {
    return;
  }
  try {
    if (now - statSync(path).mtimeMs >= ERROR_REPORT_KEEP_MS) {
      unlinkSync(path);
    }
  } catch {
    // Taken by another reader first, or still held open, which the next sweep will get.
  }
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
  /**
   * Whether a fresh announcement of the project is the game waited for. Everything is, unless
   * this says otherwise: a game that names an editor other than the one that was asked to play
   * is somebody else's, however fresh.
   */
  readonly accept?: (endpoint: RuntimeEndpoint) => boolean;
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
  const directories = waiting.directories ?? runtimeDirectories();
  const until = Date.now() + Math.max(waiting.budgetMs ?? ANNOUNCE_BUDGET_MS, 0);
  for (;;) {
    // Through links, because the engine announces the path it resolved and a caller names the
    // one they typed: on macOS the temporary directory is a link into /private, and a project
    // under it announced a path this compared unequal to, so its game was never found.
    const fresh = discoverRuntimes(directories).find(
      (endpoint) =>
        !before.has(endpoint.pid) &&
        isSameDirectory(endpoint.project.path, projectPath) &&
        (waiting.accept?.(endpoint) ?? true),
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

/** The same, for a list whose project the sentence around it has already named. */
function describeWithin(endpoint: RuntimeEndpoint): string {
  return `pid ${endpoint.pid} on ${endpoint.address}:${endpoint.port}`;
}

/**
 * The one project every one of [param endpoints] is running, when they are running one.
 *
 * Which argument can settle a choice depends on this and on nothing else, so it is asked before
 * the refusal is written rather than left to the reader to work out from a list.
 */
function theOneProject(endpoints: readonly RuntimeEndpoint[]): string | undefined {
  // An announcement carrying no project path is allowed through the parser as an empty one, and
  // `resolve('')` is this server's working directory: two of those would agree on a path neither
  // game has ever heard of and put it in the answer as the project both are running.
  if (endpoints.some((endpoint) => endpoint.project.path === '')) {
    return undefined;
  }
  const paths = new Set(endpoints.map((endpoint) => realPathOr(resolve(endpoint.project.path))));
  const only = [...paths][0];
  return paths.size === 1 ? only : undefined;
}

/**
 * Several games, all of one project, and the argument that tells them apart.
 *
 * Said the same way whether the caller named the project or not, because the situation is the
 * same either way: naming it again narrows nothing. The project is in the sentence, so each game
 * carries only what differs, which for a bench of thirty-one workers is the difference between a
 * line and three kilobytes of the same path.
 */
function severalFrom(project: string, games: readonly RuntimeEndpoint[]): string {
  return (
    `${games.length} games are running from ${project}: ${games.map(describeWithin).join('; ')}. ` +
    'Pass pid to choose one; projectPath cannot, because every one of them has this one. ' +
    'editor_status lists them under runtimes.'
  );
}

/**
 * What to say when the only games running speak a protocol this server was not built for.
 *
 * Which half is behind, and what to do about it, because "no game is running" is the one answer
 * that is certainly false here and it sends the reader to start a second game.
 */
/**
 * Which half is behind, and what to do about it, for games announcing [param unspoken].
 *
 * One function because the sentence is said in two places, here and in the refusal `editor_run`
 * gives for a game of this server's project it cannot read, and a remedy written twice is a
 * remedy that ends up said two ways.
 *
 * Both halves at once is a real state rather than a tidy-up: an editor-played game from an older
 * addon outlives an upgrade that moves this number, while a game started after it is ahead of the
 * server. One remedy cannot serve both, and naming only one leaves the other game unmentioned in
 * the answer that is about it.
 */
export function whichHalfIsBehind(unspoken: readonly UnspokenRuntime[]): string {
  const pids = (games: readonly UnspokenRuntime[]): string =>
    games.map((game) => `pid ${game.pid}`).join(', ');
  const ahead = unspoken.filter((game) => game.protocol > RUNTIME_PROTOCOL);
  const behind = unspoken.filter((game) => game.protocol < RUNTIME_PROTOCOL);
  if (ahead.length > 0 && behind.length > 0) {
    return (
      `they are on both sides of it: reconnect this server for ${pids(ahead)}, and reinstall the ` +
      `addon and restart ${pids(behind)}`
    );
  }
  if (ahead.length > 0) {
    return 'this server is the older half: reconnect it so it spawns the installed version';
  }
  return `the addon is the older half: reinstall it and restart ${behind.length === 1 ? 'the game' : 'those games'}`;
}

function tooNew(unspoken: readonly UnspokenRuntime[]): string {
  const named = unspoken
    .map(
      (game) =>
        `pid ${game.pid} speaks ${game.protocol} (${game.project.name || 'unnamed'} at ${game.project.path})`,
    )
    .join('; ');
  const count = unspoken.length === 1 ? 'A game is running' : `${unspoken.length} games are running`;
  // Two games on either side of this server announce two different protocols, and calling that
  // "a protocol" reads as one number the reader could go and look up.
  const spoken = new Set(unspoken.map((game) => game.protocol)).size === 1 ? 'a protocol' : 'protocols';
  return `${count}, in ${spoken} this server does not speak: ${named}. This server speaks ${RUNTIME_PROTOCOL}, so ${whichHalfIsBehind(unspoken)}.`;
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
      if (projectPath !== undefined && !isSameDirectory(named.project.path, projectPath)) {
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
    if (endpoints.length > 0) {
      return {
        problem: `No running game has pid ${pid}. Running: ${endpoints.map(describe).join('; ')}. editor_status lists them under runtimes as they come and go.`,
      };
    }
    // A pid nobody is running, with games announcing a protocol this server cannot read, is not
    // "no game is running": that sentence is certainly false here and sends the reader to start a
    // second game beside the ones already going. The pid is gone either way, and what to do about
    // the games that are there is the same thing it is when no pid was named.
    if (unspoken.length > 0) {
      return { problem: `No game reachable from here has pid ${pid}. ${tooNew(unspoken)}` };
    }
    return {
      problem: `No game with the runtime addon is running, so there is none with pid ${pid}. Start one with editor_run, or play the project from the editor with the addon enabled.`,
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
    const matching = endpoints.filter((endpoint) => isSameDirectory(endpoint.project.path, wanted));
    if (matching.length === 0) {
      return {
        problem: `No running game is from ${wanted}. Running: ${endpoints.map(describe).join('; ')}.`,
      };
    }
    if (matching.length === 1 && matching[0]) {
      return { endpoint: matching[0] };
    }
    return { problem: severalFrom(wanted, matching) };
  }
  if (endpoints.length === 1 && endpoints[0]) {
    return { endpoint: endpoints[0] };
  }
  // A bench and its workers are several games and one project, and the refusal used to lead with
  // `projectPath`, which lands on the refusal above rather than on a game: the one argument that
  // works came second and behind a condition the reader had to check for themselves.
  const shared = theOneProject(endpoints);
  if (shared !== undefined) {
    return { problem: severalFrom(shared, endpoints) };
  }
  return {
    problem: `Several games are running: ${endpoints.map(describe).join('; ')}. Pass pid to choose one, or projectPath when the project you mean is running only one.`,
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
