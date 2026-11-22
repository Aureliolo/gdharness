#!/usr/bin/env node

/**
 * The launcher and the keeper `outside.ts` starts, so nothing the server starts is its child.
 *
 * `launch` starts the target detached and exits once it has the pid. For a run it starts a keeper
 * instead, which is what becomes the game's parent. `keep` starts the game on its transcript,
 * writes the run's record, hands the pid back, and waits: a server can wait only on its own
 * children and none is the game's, so this process is what sees the exit and writes it where the
 * next server reads it.
 *
 * Both are handed their spec down stdin, never on the command line: see `SentSpec`.
 */

import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { exitOf } from './alive.js';
import { copiedInto } from './copied-into.js';
import {
  ensureHelperCompiled,
  HelperRefused,
  helperExit,
  helperFailure,
  helperStep,
  spawnOnDesktop,
} from './desktop.js';
import { ceilingFor, MemoryWatch } from './engine-memory.js';
import { giveBackSlotAsync, handSlot, nameSlotEngine, ownStart, raiseSlotMemory } from './engine-slots.js';
import { sampled } from './engine-spent.js';
import { letWindowsReportCrashes } from './error-mode.js';
import { GameDebugger } from './game-debugger.js';
import { raisedMark } from './game-log.js';
import { type KeeperListening, listenForTheServer } from './keeper-channel.js';
import {
  KEEPER_SCRIPT,
  readLaunched,
  receivedSpec,
  type SentSpec,
  sendSpec,
  withChanges,
} from './outside.js';
import { belowNormal } from './priority.js';
import { startTimesOf } from './process-children.js';
import {
  amendRunRecord,
  type RestartedFrom,
  type RunRecord,
  recordRunEnded,
  writeRunRecord,
} from './run-record.js';
import { discard, scratchDirectory } from './scratch.js';
import {
  ProfileObserver,
  profileFileWriter,
  profileFrameFunctions,
  withEngineArguments,
  writeProfileFile,
} from './script-profile.js';
import { type ChildProcess, spawnHidden, spawnShown } from './spawn.js';
import { type ExitWatch, followSuccessor, watchExit } from './successor.js';
import { holdChildExit, holdExit, prepareWholeExits, type WholeExit } from './whole-exit.js';

/**
 * A started target: its process, its pid and its whole exit code. [param copied] settles once what
 * the target wrote to its pipes is in the file, and is there only for a target given pipes.
 */
interface StartedGame {
  readonly child: ChildProcess;
  readonly pid: number;
  readonly whole: WholeExit;
  readonly copied?: Promise<void> | undefined;
}

/**
 * The target started detached, so it is in no job object and no process group of this process.
 * Its streams go to [param output], the transcript for a run and nowhere otherwise, since a pipe
 * with no reader fills and then blocks the writer. [param hidden] for the editor, which is headless
 * and so opens no window, but whose console an engine built as a console program would show. Never
 * for a game, whose window is what it is run for. [param detached] false and [param errors]
 * dropped only for the helper that starts a process through Win32: Windows PowerShell will not
 * run detached, and writes its own progress to its error stream.
 */
async function startDirectly(
  spec: SentSpec,
  output: number | 'ignore',
  hidden: boolean,
  detached = true,
  errors: number | 'ignore' = output,
  directory: string = process.cwd(),
): Promise<StartedGame | { error: string }> {
  return await new Promise((resolve) => {
    const child = (hidden ? spawnHidden : spawnShown)(spec.command, spec.args, {
      stdio: ['ignore', output, errors],
      detached,
      env: withChanges(process.env, spec.envChanges),
      cwd: directory,
    });
    belowNormal(child);
    const whole = holdExit(child.pid);
    child.once('error', (error: Error) => {
      resolve({ error: error.message });
    });
    child.once('spawn', () => {
      resolve(
        child.pid === undefined
          ? { error: 'the operating system gave it no pid' }
          : { child, pid: child.pid, whole },
      );
    });
  });
}

/**
 * [param spec] started through `spawnOnDesktop`, on the desktop it names or shown without
 * activation: the child is the process that waits for it and exits with its code, and the pid is
 * the target's own, read from the file that process writes once the target has started.
 *
 * The helper is this process's own, so a keeper's lasts as long as its target, and it holds the
 * desktop a process the target starts on a desktop of its own needs, as an editor does when it plays
 * a game. The target's job is named and only counts, so the target's lifetime is its own and it runs
 * on when the helper goes. A start without activation needs the helper to hold the foreground.
 */
async function startThroughHelper(
  spec: SentSpec,
  output: number | 'ignore',
  stopFile: string,
  exitFile: string,
): Promise<StartedGame | { error: string }> {
  try {
    return await startedThroughHelper(spec, output, stopFile, exitFile);
  } catch (error) {
    // A system that will not run the helper program is a start that failed, and no defect.
    if (error instanceof HelperRefused) {
      return { error: error.message };
    }
    throw error;
  }
}

/**
 * Null once [param child] has spawned or ended, or why it could not be. A start the helper answers
 * before it is given to it never spawns, and ends with its reason in the helper's error file.
 */
function spawnedOrEnded(child: ChildProcess): Promise<string | null> {
  return new Promise((resolve) => {
    child.once('error', (error: Error) => {
      resolve(error.message);
    });
    child.once('spawn', () => {
      resolve(child.pid === undefined ? 'the operating system gave it no pid' : null);
    });
    child.once('exit', () => {
      resolve(null);
    });
  });
}

/**
 * [param output] is where the game's output is written, and 'ignore' where it has none. The game is
 * given pipes for it and this process writes the file, since a game on Windows flushes a file to
 * disk after every line it writes. This process owns [param output] from here and closes it once the
 * pipes have ended.
 */
async function startedThroughHelper(
  spec: SentSpec,
  output: number | 'ignore',
  stopFile: string,
  exitFile: string,
): Promise<StartedGame | { error: string }> {
  const piped = output !== 'ignore';
  let copying = false;
  const scratch = scratchDirectory('desktop');
  const where =
    spec.desktop !== undefined
      ? `on the ${spec.desktop} desktop`
      : spec.noActivate === true
        ? 'without activation'
        : 'through the desktop helper';
  try {
    // Under its own budget, before the start's, so a slow compile is neither counted as a slow
    // start nor ended halfway by one.
    const compiled = await ensureHelperCompiled();
    if (compiled !== null) {
      return { error: `it could not be started ${where}: ${compiled}` };
    }
    // The helper's environment is what it starts inherits, since the start names no other. In the
    // temporary directory, with the target given the directory explicitly: Windows PowerShell saves
    // its module cache relative to where it runs when the profile does not resolve, and this process
    // runs in the server's directory, which is usually somebody's project.
    const onDesktop = spawnOnDesktop(
      {
        ...(spec.desktop === undefined ? {} : { desktop: spec.desktop }),
        ...(spec.noActivate === undefined ? {} : { noActivate: spec.noActivate }),
        directory: process.cwd(),
        scratch,
        stop: stopFile,
        exit: exitFile,
      },
      spec.command,
      spec.args,
      {
        stdio: ['ignore', piped ? 'pipe' : 'ignore', piped ? 'pipe' : 'ignore'],
        env: withChanges(process.env, spec.envChanges),
        cwd: tmpdir(),
      },
    );
    const { child } = onDesktop;
    belowNormal(child);
    const whole = holdChildExit(child);
    const spawned = await spawnedOrEnded(child);
    if (spawned !== null) {
      return { error: spawned };
    }
    // Reading at once, since a game that fills the pipe's buffer waits for it to be read.
    const copied = output === 'ignore' ? undefined : copiedIntoFile(output, child);
    copying = copied !== undefined;
    const named = await pidFromTheHelper(onDesktop, where);
    return 'error' in named ? named : { child, pid: named.pid, whole, copied };
  } finally {
    if (piped && !copying) {
      closeSync(output);
    }
    discard(scratch);
  }
}

/** The pid the helper of [param onDesktop] writes for its target, or why none came within the start's time. */
async function pidFromTheHelper(
  onDesktop: ReturnType<typeof spawnOnDesktop>,
  where: string,
): Promise<{ pid: number } | { error: string }> {
  const { child } = onDesktop;
  for (let waited = 0; waited < DESKTOP_START_MS; waited += 50) {
    const pid = onDesktop.pid();
    if (pid !== undefined) {
      return { pid };
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      const why = helperFailure(onDesktop.files.error) ?? 'it exited saying nothing';
      return { error: `it could not be started ${where}: ${why}` };
    }
    await delay(50);
  }
  child.kill();
  return {
    error: `it was not started ${where} within ${DESKTOP_START_MS} ms, and ${helperStep(onDesktop.files.step)}`,
  };
}

/** Whether [param stream] is one of a child's, which are null where the child was given none. */
function isStream(stream: Readable | null): stream is Readable {
  return stream !== null;
}

/** What [param child] writes to its pipes, written to [param output], which is closed once they end. */
function copiedIntoFile(output: number, child: ChildProcess): Promise<void> {
  return copiedInto(output, [child.stdout, child.stderr].filter(isStream), exitOf(child)).then(() => {
    closeSync(output);
  });
}

/** The profiler of a profiled run, writing what it sums to [param path] as the game runs and exits. */
function profiledBy(
  path: string,
  projectPath: string,
  engineCalls: boolean,
): { observer: ProfileObserver; finish: () => void } {
  const writer = profileFileWriter(path);
  const observer = new ProfileObserver(writer.changed, profileFrameFunctions(projectPath), engineCalls);
  writeProfileFile(path, { connected: false, listeningSince: Date.now() });
  return {
    observer,
    finish: () => {
      writer.finish(observer.totals());
    },
  };
}

/**
 * How long the keeper of an exited game waits for the game's debugger connection to close before it
 * finishes: an exited process's socket closes at once, so this is only a game that left a child
 * holding a copy of it.
 */
const DRAIN_MS = 2000;

/** How long a start through the helper is given to name the process it started. */
const DESKTOP_START_MS = 60_000;

/**
 * Through the helper on Windows, and directly otherwise. [param stopFile] is where a helper
 * is told to end what it started, and is empty for a start nothing will be asked to end.
 * [param exitFile] is where the helper writes the whole exit code, and is empty for none.
 */
async function startDetached(
  spec: SentSpec,
  output: number | 'ignore',
  hidden: boolean,
  stopFile = '',
  exitFile = '',
): Promise<StartedGame | { error: string }> {
  return throughTheHelper(spec)
    ? await startThroughHelper(spec, output, stopFile, exitFile)
    : await startDirectly(spec, output, hidden);
}

/**
 * Every start on Windows, since the helper puts the process in the job its processor time is read
 * from, and clears the bit that keeps a crash from being reported where this process could not.
 */
function throughTheHelper(spec: SentSpec): boolean {
  return needsItsHelperKept(spec) || process.platform === 'win32';
}

/**
 * Whether [param spec] needs its helper kept for as long as it runs, which only a keeper does: one
 * on a desktop of its own, for the desktop's sake, and one started without activation, whose helper
 * holds the foreground while it starts. A launcher that starts neither exits once the pid is known,
 * and the helper it started detached stays with the target.
 */
function needsItsHelperKept(spec: SentSpec): boolean {
  return process.platform === 'win32' && (spec.desktop !== undefined || spec.noActivate === true);
}

async function launch(): Promise<void> {
  const spec = await receivedSpec();
  if (spec.run === undefined && !needsItsHelperKept(spec) && spec.exitNote === undefined) {
    const started = await startDetached(spec, 'ignore', true);
    if ('error' in started) {
      process.stdout.write(`error ${started.error}\n`);
    } else {
      started.child.unref();
      process.stdout.write(`pid ${started.pid}\n`);
    }
    process.exit(0);
  }
  const keeper = spawnHidden(process.execPath, [KEEPER_SCRIPT, 'keep'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  let printed = '';
  let complained = '';
  keeper.once('error', (error: Error) => {
    process.stdout.write(`error the keeper did not start: ${error.message}\n`);
    process.exit(0);
  });
  sendSpec(keeper, spec);
  keeper.stderr.on('data', (chunk: Buffer) => {
    complained += chunk.toString();
  });
  keeper.stdout.on('data', (chunk: Buffer) => {
    printed += chunk.toString();
    if (!printed.includes('\n')) {
      return;
    }
    const launched = readLaunched(printed);
    process.stdout.write(
      'pid' in launched
        ? `pid ${launched.pid}${launched.keeperPid === undefined ? '' : ` keeper ${launched.keeperPid}`}\n`
        : `error ${launched.error}\n`,
    );
    keeper.unref();
    process.exit(0);
  });
  keeper.once('close', () => {
    // On one line, since one line is all that is read back: a runtime's error prints its source
    // before its message, and what came back was the line `536 | }` and nothing that said why.
    const why = complained.trim().split(/\r?\n/).filter(Boolean).join(' | ');
    process.stdout.write(`error the keeper ended before it said anything${why ? `: ${why}` : ''}\n`);
    process.exit(0);
  });
}

/**
 * The run's note, written where it can be. The game is running by the time this is asked, so a note
 * that cannot be written leaves a run no later server can find, and a keeper that ended over it
 * would leave the game held by nobody as well.
 */
function writeNoteIfItCan(record: Parameters<typeof writeRunRecord>[0]): void {
  try {
    writeRunRecord(record);
  } catch {
    // The server that started the run has its pid from the line printed below, and stops it by that.
  }
}

/**
 * What the run says after its start, written only where no later run's note is, and never fatal for
 * the same reason the start's is not.
 */
function amendNoteIfItCan(record: RunRecord): void {
  try {
    amendRunRecord(record);
  } catch {
    // The note then stays as the last write left it.
  }
}

type KeptRun = NonNullable<SentSpec['run']>;
type KeptSlot = NonNullable<KeptRun['slot']>;
type Started = Awaited<ReturnType<typeof startDetached>>;
type Followed = NonNullable<Awaited<ReturnType<typeof followSuccessor>>>;

/**
 * What a stop ends: the game, through what this process holds rather than through the pid (the
 * game's own handle, or the helper's, which ends the game through the handle it holds. Neither can
 * reach a later process given the same number), and then whatever it restarted itself into.
 * Held in an object, since the stop the channel hears sets it, which no flow analysis follows.
 */
interface Ender {
  stop: boolean;
  end: () => 'signalled' | 'gone';
}

/** How the game stands after each exit that is followed, from the first process to the last. */
interface KeptEnd {
  readonly note: RunRecord | null;
  readonly pid: number;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly notTold: boolean;
  readonly exitedAt: number;
}

/** What the loop that follows a game's restarts is given and does not change. */
interface Following {
  readonly command: string;
  readonly exitNotes: string | null;
  readonly transcript: string | undefined;
  readonly slot: KeptSlot | undefined;
  readonly ender: Ender;
  readonly raising: SlotRaising;
}

/** The raise of a run's slot, moved onto each process the game restarts into. */
interface SlotRaising {
  /** Raises the slot from the readings of [param pid], and no longer from the process before. */
  readonly onto: (pid: number) => void;
  readonly stop: () => void;
}

/**
 * How often the keeper reads its game for the slot's figure. The server reads the game every second
 * to guard it, and the figure moves in steps of 256 MiB.
 */
const SLOT_READ_MS = 5000;

/** The keeper's readings of its game, from the sample every guard reads. */
const gameMemory = new MemoryWatch(sampled, SLOT_READ_MS);

/**
 * Raises the slot of [param run] as its game grows past what the slot counts, so the machine's
 * budget counts what the game holds. The keeper holds the lock, so it is the process that rewrites
 * it. No higher than the project's ceiling, past which the server ends the game. A run with no slot
 * of the keeper's, or whose ceiling cannot be read, is not raised.
 */
function raisingTheSlot(run: KeptRun | undefined): SlotRaising {
  let stop = (): void => undefined;
  const slot = run?.slot;
  let cap: number | null = null;
  try {
    cap = run === undefined ? null : ceilingFor(run.projectPath).bytes;
  } catch {
    // A setting that is not a size refused the start, so there is no game to raise for.
  }
  return {
    onto: (pid) => {
      stop();
      if (slot !== undefined && cap !== null) {
        const { lock } = slot;
        stop = gameMemory.follow(pid, cap, (bytes) => raiseSlotMemory(lock, bytes));
      }
    },
    stop: () => {
      stop();
    },
  };
}

/**
 * The game's debugger, opened before the game so it is listening when the game dials it: the
 * engine dials once, as it starts, and runs with no debugger if nobody answers.
 */
async function openDebuggerFor(
  run: KeptRun | undefined,
  profiled: { observer: ProfileObserver } | null,
): Promise<GameDebugger | null> {
  if (run === undefined || run.debugged === false) {
    return null;
  }
  return await GameDebugger.open(
    run.breakpoints ?? [],
    profiled === null ? [] : [profiled.observer],
    (by, text, file) => {
      try {
        appendFileSync(run.transcript, raisedMark(by, text, file));
      } catch {
        // The run's errors then count this one too, as the engine printed it.
      }
    },
  );
}

/** [param spec] with the exit notes folder named in its environment and the debugger's flags added. */
function specToStart(spec: SentSpec, exitNotes: string | null, debuggerPeer: GameDebugger | null): SentSpec {
  const noted =
    exitNotes === null
      ? spec
      : { ...spec, envChanges: { ...spec.envChanges, [EXIT_NOTES_VARIABLE]: exitNotes } };
  return debuggerPeer === null
    ? noted
    : { ...noted, args: withEngineArguments(noted.args, debuggerPeer.engineArguments) };
}

/** The game started, with what the keeper made for the helper to watch and for the later reads. */
async function startTheGame(
  spec: SentSpec,
  toStart: SentSpec,
  run: KeptRun | undefined,
): Promise<{
  started: Started;
  own: string | null;
  stopFile: string;
  exitFile: string;
  keeperStarted: Promise<number> | undefined;
  spawnedAt: number;
}> {
  const outputFile = run === undefined ? spec.output : run.transcript;
  const transcript = outputFile === undefined ? 'ignore' : openSync(outputFile, 'a');
  // Private to this keeper, for the file a helper watches for its stop.
  const own = run !== undefined && throughTheHelper(spec) ? scratchDirectory('keeper-stop') : null;
  const stopFile = own === null ? '' : join(own, 'stop');
  const exitFile = own === null ? '' : join(own, 'exit');
  let started: Started;
  // Read beside the start rather than after it: on Windows it is a query of its own.
  const keeperStarted = run?.slot === undefined ? undefined : ownStart();
  // Before the game exists, so anything listed as started after it can be the game's own.
  const spawnedAt = Date.now();
  try {
    started = await startDetached(toStart, transcript, run === undefined, stopFile, exitFile);
  } finally {
    // The game holds its own copy from here on, unless it was given pipes and this process writes
    // the file, which closes it.
    if (transcript !== 'ignore' && !throughTheHelper(toStart)) {
      closeSync(transcript);
    }
  }
  return { started, own, stopFile, exitFile, keeperStarted, spawnedAt };
}

/** The note a run starts with, or null for a start that is no run. */
function startingNote(
  run: KeptRun | undefined,
  spec: SentSpec,
  pid: number,
  args: readonly string[],
): RunRecord | null {
  if (run === undefined) {
    return null;
  }
  return {
    pid,
    transcript: run.transcript,
    startedAt: run.startedAt,
    startedBy: Date.now(),
    projectPath: run.projectPath,
    keeperPid: process.pid,
    ...(run.servedBy === undefined ? {} : { servedBy: run.servedBy }),
    ...(run.savesIn === undefined ? {} : { savesIn: run.savesIn }),
    ...(run.profile === undefined ? {} : { profile: run.profile }),
    ...(run.debugged === false ? { exported: true as const } : {}),
    arguments: args,
    command: spec.command,
  };
}

/** Ends the game through the helper's stop file where there is one, and through the child's handle otherwise. */
function endingTheGame(child: ChildProcess, stopFile: string): () => 'signalled' | 'gone' {
  return () => {
    if (stopFile !== '') {
      writeFileSync(stopFile, '');
      return 'signalled';
    }
    return child.kill() ? 'signalled' : 'gone';
  };
}

/** Listens for the server's stop, and notes where, once someone is listening. */
async function listenAndNote(
  record: RunRecord,
  ender: Ender,
  debuggerPeer: GameDebugger | null,
): Promise<KeeperListening | null> {
  const listening = await listenForTheServer(
    () => {
      // Only the stop that reaches a live game is `signalled`. A later one answers `gone` even in
      // the moments before the exit is handled, so two servers never both claim the end.
      const first = !ender.stop;
      ender.stop = true;
      return first ? ender.end() : 'gone';
    },
    debuggerPeer === null ? null : (request) => debuggerPeer.ask(request),
  );
  if (listening !== null) {
    amendNoteIfItCan({ ...record, keeper: listening.address });
  }
  return listening;
}

/**
 * Nobody reads this once the launcher has gone, and a write to a pipe with no reader is an error.
 * Sent before the end is acted on, so a game that has already quit still has its pid answered.
 */
async function sayPid(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdout.once('error', () => {
      resolve();
    });
    process.stdout.end(`pid ${pid} keeper ${process.pid}\n`, resolve);
  });
}

/**
 * After the pid has gone back, since on Windows reading this process's start is a query of its
 * own, and a start held up by it answered after a game that announces at once had done so.
 * The pid in the lock is this process's, since a game that restarts itself comes back under
 * another, so the label says whose it is: a wait would otherwise name it as the game's. The game
 * is named beside it, so what the game starts runs on its slot rather than taking a second.
 */
async function handTheSlot(
  slot: KeptSlot | undefined,
  keeperStarted: Promise<number> | undefined,
  pid: number,
): Promise<void> {
  if (slot === undefined || keeperStarted === undefined) {
    return;
  }
  const gameStarted = (await startTimesOf([pid])).get(pid);
  await handSlot(slot.lock, slot.from, {
    pid: process.pid,
    started: await keeperStarted,
    by: `${slot.by}, through the keeper process that runs it`,
    ...(gameStarted === undefined ? {} : { engine: { pid, started: gameStarted } }),
  });
}

/**
 * The look for a successor of [param pid], unless the game said it does not restart. It is dated
 * against [param watch]'s kernel exit time where there is one, since the sighting [param exitedAt]
 * comes late on a loaded machine.
 */
function lookForSuccessor(
  following: Following,
  pid: number,
  notBefore: number,
  exitedAt: number,
  watch?: ExitWatch,
): Promise<Followed | null> | null {
  return restartSaid(following.exitNotes, pid) === false
    ? null
    : followSuccessor(pid, following.command, notBefore, exitedAt, following.transcript, watch);
}

/** One process in a chain of restarts, from the game's first to the one it restarted into. */
function restartedFromOf(ended: KeptEnd): RestartedFrom {
  return {
    pid: ended.pid,
    endedAt: ended.exitedAt,
    ...(ended.code === null ? {} : { exitCode: ended.code }),
    ...(ended.code === null && ended.signal !== null ? { exitSignal: ended.signal } : {}),
  };
}

/** The note moved onto the successor, with the process it replaced added to its chain. */
async function followRestart(
  ended: KeptEnd,
  note: RunRecord,
  followed: Followed,
  following: Following,
): Promise<KeptEnd> {
  const next = followed.successor;
  const moved: RunRecord = {
    ...note,
    pid: next.pid,
    startedBy: next.startedAt,
    restartedFrom: [...(note.restartedFrom ?? []), restartedFromOf(ended)],
  };
  amendNoteIfItCan(moved);
  if (following.slot !== undefined) {
    await nameSlotEngine(following.slot.lock, process.pid, { pid: next.pid, started: next.startedAt });
  }
  following.raising.onto(next.pid);
  following.ender.end = () => {
    try {
      process.kill(next.pid);
      return 'signalled';
    } catch {
      return 'gone';
    }
  };
  // Asked while the restart was being looked for, and answered as nothing to end then.
  if (following.ender.stop) {
    following.ender.end();
  }
  const over = await followed.ended;
  const exitedAt = Date.now();
  amendNoteIfItCan({ ...moved, endingAt: exitedAt });
  return { note: moved, pid: next.pid, code: over.code, signal: null, notTold: over.code === null, exitedAt };
}

/** Follows the game through each restart it made, and returns how the last process ended. */
async function followRestarts(
  first: KeptEnd,
  firstLook: Promise<Followed | null> | null,
  following: Following,
): Promise<KeptEnd> {
  let ended = first;
  let looked = firstLook;
  while (ended.note !== null && looked !== null) {
    const followed = await looked;
    if (followed === null) {
      break;
    }
    ended = await followRestart(ended, ended.note, followed, following);
    const next = followed.successor;
    looked = lookForSuccessor(following, next.pid, next.startedAt, ended.exitedAt);
  }
  return ended;
}

/** After the profile, so a server told the run ended reads the profile it ended with. */
function recordTheEnd(ended: KeptEnd): void {
  if (ended.note === null) {
    return;
  }
  try {
    recordRunEnded(ended.note, {
      exitCode: ended.code,
      exitSignal: ended.code === null ? ended.signal : null,
      notTold: ended.notTold,
    });
  } catch {
    // The run then has no recorded end, which every reader handles.
  }
}

/** Writes how the process exited into [param file], for a reader of a process that has no run note. */
function noteTheExit(file: string | undefined, pid: number, code: number | null): void {
  if (file === undefined || code === null) {
    return;
  }
  try {
    // With the pid, so a reader never takes the note of an editor before for this one's.
    writeFileSync(file, `${String(pid)} ${String(code >>> 0)}`);
  } catch {
    // The reader then says the exit was not recorded.
  }
}

async function keep(): Promise<void> {
  const spec = await receivedSpec();
  const run = spec.run;
  const profiled =
    run?.profile === undefined ? null : profiledBy(run.profile, run.projectPath, run.engineCalls === true);
  const debuggerPeer = await openDebuggerFor(run, profiled);
  const exitNotes = run === undefined ? null : scratchDirectory('keeper-exit');
  const toStart = specToStart(spec, exitNotes, debuggerPeer);
  const { started, own, stopFile, exitFile, keeperStarted, spawnedAt } = await startTheGame(
    spec,
    toStart,
    run,
  );
  if ('error' in started) {
    debuggerPeer?.close();
    process.stdout.write(`error ${started.error}\n`);
    process.exit(1);
  }
  const { child, pid, whole, copied } = started;
  const watch = run === undefined ? undefined : watchExit(pid, spawnedAt);
  const record = startingNote(run, spec, pid, toStart.args);
  if (record !== null) {
    // Before the pid goes back, and in the same turn as the exit is listened for: a game that ends at
    // once would otherwise exit before any record held its pid, and the exit would have nowhere to go.
    writeNoteIfItCan(record);
  }
  const exited = exitOf(child);
  const ender: Ender = { stop: false, end: endingTheGame(child, stopFile) };
  const listening = record === null ? null : await listenAndNote(record, ender, debuggerPeer);
  await sayPid(pid);
  const slot = run?.slot;
  await handTheSlot(slot, keeperStarted, pid);
  // Once the lock is the keeper's, which is the only process that rewrites it from then on.
  const raising = raisingTheSlot(run);
  raising.onto(pid);
  const told = await exited;
  // Before the exit is noted: whoever reads the note then reads a transcript with the game's last lines.
  await copied;
  const code = exitFile === '' ? whole(told.code) : helperExit(exitFile, whole(told.code));
  const exitedAt = Date.now();
  noteTheExit(spec.exitNote, pid, code);
  const note: RunRecord | null =
    record === null ? null : listening === null ? record : { ...record, keeper: listening.address };
  if (note !== null) {
    amendNoteIfItCan({ ...note, endingAt: exitedAt });
  }
  // The game's restart, if it made one, is not this process's child, so the handle is no way to end it.
  ender.end = () => 'gone';
  const following: Following = {
    command: spec.command,
    exitNotes,
    transcript: run?.transcript,
    slot,
    ender,
    raising,
  };
  // Looked for at once, beside the drain: a successor that ends before the listing sees it is not
  // followed, and the run ends with the first process's exit.
  const looked = note === null ? null : lookForSuccessor(following, pid, spawnedAt, exitedAt, watch);
  // The profile is finished from everything the game sent, which is read after its exit is told.
  if (debuggerPeer !== null) {
    await debuggerPeer.drained(DRAIN_MS);
  }
  profiled?.finish();
  const last = await followRestarts(
    { note, pid, code, signal: told.signal, notTold: false, exitedAt },
    looked,
    following,
  );
  recordTheEnd(last);
  raising.stop();
  if (slot !== undefined) {
    await giveBackSlotAsync(slot.lock, process.pid);
  }
  debuggerPeer?.close();
  listening?.close();
  discard(own, exitNotes);
  process.exit(0);
}

/**
 * Where the runtime addon in a game this keeper holds says, once its tree has gone, whether it set
 * a restart. Kept in step with `EXIT_NOTES_VARIABLE` in the runtime addon.
 */
const EXIT_NOTES_VARIABLE = 'GDHARNESS_EXIT_NOTES';

/**
 * Whether [param pid] said as it exited that it restarts, or null when it said nothing: a game with
 * no runtime addon, or one that did not end its tree, and the successor is then looked for by what
 * the platform lists alone. Only a game can tell a restart from a worker it started in its last
 * moments: one of those was taken for a successor, and the stop that asked the game to close ended
 * the worker as the run.
 */
function restartSaid(notes: string | null, pid: number): boolean | null {
  if (notes === null) {
    return null;
  }
  try {
    const said: unknown = JSON.parse(readFileSync(join(notes, `exit-${String(pid)}.json`), 'utf8'));
    return typeof said === 'object' && said !== null && 'restart' in said && typeof said.restart === 'boolean'
      ? said.restart
      : null;
  } catch {
    return null;
  }
}

await letWindowsReportCrashes();
await prepareWholeExits();
const mode = process.argv[2];
if (mode === 'launch') {
  await launch();
} else if (mode === 'keep') {
  await keep();
} else {
  process.stderr.write('keeper.js launch|keep, with the spec on stdin\n');
  process.exit(2);
}
