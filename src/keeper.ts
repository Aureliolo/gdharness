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
import { setTimeout as delay } from 'node:timers/promises';
import { exitOf } from './alive.js';
import {
  DESKTOP_VARIABLE,
  ensureHelperCompiled,
  helperExit,
  helperFailure,
  helperPid,
  helperStep,
  throughHelper,
} from './desktop.js';
import { giveBackSlot, handSlot, nameSlotEngine, ownStart } from './engine-slots.js';
import { crashesReported, letWindowsReportCrashes } from './error-mode.js';
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
  type ProfileTotals,
  profileFrameFunctions,
  withEngineArguments,
  writeProfileFile,
} from './script-profile.js';
import { type ChildProcess, spawnHidden, spawnShown } from './spawn.js';
import { followSuccessor } from './successor.js';
import { holdExit, prepareWholeExits, type WholeExit } from './whole-exit.js';

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
): Promise<{ child: ChildProcess; pid: number; whole: WholeExit } | { error: string }> {
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
 * [param spec] started through `throughHelper`, on the desktop it names or shown without
 * activation: the child is the process that waits for it and exits with its code, and the pid is
 * the target's own, read from the file that process writes once the target has started.
 *
 * Windows PowerShell started detached exits at once and runs nothing, so the helper is this
 * process's own child, hidden, and in the job object Node gives its children: it goes when this
 * process does. The job lets its members' children leave it silently, so the target is in no job
 * and outlives both. So only a keeper starts one, since it waits for as long as the target runs.
 * A launcher that exited after the pid took the helper with it, and a process it had started on a
 * desktop of its own could no longer start one of its own there, which is what an editor does when
 * it plays a game. A start without activation also needs its helper to hold the foreground.
 */
async function startThroughHelper(
  spec: SentSpec,
  output: number | 'ignore',
  stopFile: string,
  exitFile: string,
): Promise<{ child: ChildProcess; pid: number; whole: WholeExit } | { error: string }> {
  const scratch = scratchDirectory('desktop');
  const pidFile = join(scratch, 'pid');
  const errorFile = join(scratch, 'error');
  const stepFile = join(scratch, 'step');
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
    const wrapper = throughHelper({ ...spec, directory: process.cwd() }, spec.command, spec.args, {
      spec: join(scratch, 'spec.json'),
      pid: pidFile,
      error: errorFile,
      stop: stopFile,
      step: stepFile,
      exit: exitFile,
    });
    // The helper's environment is what it starts inherits, since the start names no other.
    const envChanges =
      spec.desktop === undefined ? spec.envChanges : { ...spec.envChanges, [DESKTOP_VARIABLE]: spec.desktop };
    // In the temporary directory, with the target given this one explicitly: Windows PowerShell
    // saves its module cache relative to where it runs when the profile does not resolve, and this
    // process runs in the server's directory, which is usually somebody's project.
    const started = await startDirectly(
      { ...spec, command: wrapper.command, args: wrapper.args, envChanges },
      output,
      true,
      false,
      'ignore',
      tmpdir(),
    );
    if ('error' in started) {
      return started;
    }
    const exited = { now: false };
    started.child.once('exit', () => {
      exited.now = true;
    });
    for (let waited = 0; waited < DESKTOP_START_MS; waited += 50) {
      const pid = helperPid(pidFile);
      if (pid !== undefined) {
        return { child: started.child, pid, whole: started.whole };
      }
      if (exited.now) {
        const why = helperFailure(errorFile) ?? 'it exited saying nothing';
        return { error: `it could not be started ${where}: ${why}` };
      }
      await delay(50);
    }
    started.child.kill();
    return {
      error: `it was not started ${where} within ${DESKTOP_START_MS} ms, and ${helperStep(stepFile)}`,
    };
  } finally {
    discard(scratch);
  }
}

/** How often a profiled run's file is written at most while frames arrive. */
const PROFILE_WRITE_MS = 500;

/** How many times the write as the game exits is tried before what it carried is given up. */
const LAST_WRITE_TRIES = 5;

/**
 * The profiler of a profiled run, writing what it sums to [param path]: when the game connects, at
 * most every `PROFILE_WRITE_MS` while frames arrive, and once more as the game exits, so a server
 * reading the file mid-run is at most that far behind and one reading it after the exit has the lot.
 */
function profiledBy(
  path: string,
  projectPath: string,
  engineCalls: boolean,
): { observer: ProfileObserver; finish: () => void } {
  let latest: ProfileTotals | null = null;
  let timer: NodeJS.Timeout | null = null;
  // A write a reader held off past its wait is tried again later rather than dropped: the totals it
  // carried are only rewritten when the next frame arrives, and a game that has quit sends none.
  const write = (): void => {
    timer = null;
    if (latest !== null && !writeProfileFile(path, { ...latest, connected: true })) {
      timer = setTimeout(write, PROFILE_WRITE_MS);
    }
  };
  const observer = new ProfileObserver(
    (totals) => {
      const first = latest === null;
      latest = totals;
      if (first) {
        write();
      } else {
        timer ??= setTimeout(write, PROFILE_WRITE_MS);
      }
    },
    profileFrameFunctions(projectPath),
    engineCalls,
  );
  writeProfileFile(path, { connected: false, listeningSince: Date.now() });
  return {
    observer,
    finish: () => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      const last = observer.totals() ?? latest;
      latest = last;
      if (last === null) {
        return;
      }
      // The keeper exits after this, so there is no later write to fall back on, and the engine's
      // own totals arrive only now. Each try waits out a held file for a while of its own.
      let tries = 0;
      while (!writeProfileFile(path, { ...last, connected: true }) && tries < LAST_WRITE_TRIES) {
        tries += 1;
      }
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
 * Through the helper where Windows is asked for a desktop or a start without activation, which Node
 * cannot name when it starts a process, and directly otherwise. [param stopFile] is where a helper
 * is told to end what it started, and is empty for a start nothing will be asked to end.
 * [param exitFile] is where the helper writes the whole exit code, and is empty for none.
 */
async function startDetached(
  spec: SentSpec,
  output: number | 'ignore',
  hidden: boolean,
  stopFile = '',
  exitFile = '',
): Promise<{ child: ChildProcess; pid: number; whole: WholeExit } | { error: string }> {
  return throughTheHelper(spec)
    ? await startThroughHelper(spec, output, stopFile, exitFile)
    : await startDirectly(spec, output, hidden);
}

/**
 * Also wherever this process could not clear the bit that keeps a crash from being reported, since
 * the helper clears it in itself before it starts anything.
 */
function throughTheHelper(spec: SentSpec): boolean {
  return needsItsHelperKept(spec) || (process.platform === 'win32' && !crashesReported());
}

/**
 * Whether [param spec] needs its helper kept for as long as it runs, which only a keeper does: one
 * on a desktop of its own, for the desktop's sake, and one started without activation, whose helper
 * holds the foreground while it starts. A helper there only for the error mode may go once the
 * target has started, which it outlives.
 */
function needsItsHelperKept(spec: SentSpec): boolean {
  return process.platform === 'win32' && (spec.desktop !== undefined || spec.noActivate === true);
}

async function launch(): Promise<void> {
  const spec = await receivedSpec();
  if (spec.run === undefined && !needsItsHelperKept(spec)) {
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
    process.stdout.write('pid' in launched ? `pid ${launched.pid}\n` : `error ${launched.error}\n`);
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
  const transcript = run === undefined ? 'ignore' : openSync(run.transcript, 'a');
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
    // The game holds its own copy from here on.
    if (transcript !== 'ignore') {
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
    ...(run.profile === undefined ? {} : { profile: run.profile }),
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
      ender.stop = true;
      return ender.end();
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
    process.stdout.end(`pid ${pid}\n`, resolve);
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
  handSlot(slot.lock, slot.from, {
    pid: process.pid,
    started: await keeperStarted,
    by: `${slot.by}, through the keeper process that runs it`,
    ...(gameStarted === undefined ? {} : { engine: { pid, started: gameStarted } }),
  });
}

/** The look for a successor of [param pid], unless the game said it does not restart. */
function lookForSuccessor(
  following: Following,
  pid: number,
  notBefore: number,
  exitedAt: number,
): Promise<Followed | null> | null {
  return restartSaid(following.exitNotes, pid) === false
    ? null
    : followSuccessor(pid, following.command, notBefore, exitedAt, following.transcript);
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
    nameSlotEngine(following.slot.lock, process.pid, { pid: next.pid, started: next.startedAt });
  }
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
  const { child, pid, whole } = started;
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
  const told = await exited;
  const code = exitFile === '' ? whole(told.code) : helperExit(exitFile, whole(told.code));
  const exitedAt = Date.now();
  const note: RunRecord | null =
    record === null ? null : listening === null ? record : { ...record, keeper: listening.address };
  if (note !== null) {
    amendNoteIfItCan({ ...note, endingAt: exitedAt });
  }
  // The game's restart, if it made one, is not this process's child, so the handle is no way to end it.
  ender.end = () => 'gone';
  const following: Following = { command: spec.command, exitNotes, transcript: run?.transcript, slot, ender };
  // Looked for at once, beside the drain: a successor that ends before the listing sees it is not
  // followed, and the run ends with the first process's exit.
  const looked = note === null ? null : lookForSuccessor(following, pid, spawnedAt, exitedAt);
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
  if (slot !== undefined) {
    giveBackSlot(slot.lock, process.pid);
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
