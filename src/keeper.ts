#!/usr/bin/env node

/**
 * The launcher and the keeper `outside.ts` starts, so nothing the server starts is its child.
 *
 * `launch` starts the target detached and exits once it has the pid; for a run it starts a keeper
 * instead, which is what becomes the game's parent. `keep` starts the game on its transcript,
 * writes the run's record, hands the pid back, and waits: a server can wait only on its own
 * children and none is the game's, so this process is what sees the exit and writes it where the
 * next server reads it.
 *
 * Both are handed their spec down stdin, never on the command line: see `SentSpec`.
 */

import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { exitOf } from './alive.js';
import {
  DESKTOP_VARIABLE,
  ensureHelperCompiled,
  helperFailure,
  helperStep,
  throughHelper,
} from './desktop.js';
import { giveBackSlot, handSlot, ownStart } from './engine-slots.js';
import { crashesReported, letWindowsReportCrashes } from './error-mode.js';
import { GameDebugger } from './game-debugger.js';
import { type KeeperListening, listenForTheServer } from './keeper-channel.js';
import {
  KEEPER_SCRIPT,
  readLaunched,
  receivedSpec,
  type SentSpec,
  sendSpec,
  withChanges,
} from './outside.js';
import { type RestartedFrom, type RunRecord, recordRunEnded, writeRunRecord } from './run-record.js';
import { discard, scratchDirectory } from './scratch.js';
import {
  frameFunctionsFor,
  ProfileObserver,
  type ProfileTotals,
  queuedMessagesOf,
  withEngineArguments,
  writeProfileFile,
} from './script-profile.js';
import { type ChildProcess, spawnHidden, spawnShown } from './spawn.js';
import { followSuccessor } from './successor.js';

/**
 * The target started detached, so it is in no job object and no process group of this process;
 * its streams go to [param output], the transcript for a run and nowhere otherwise, since a pipe
 * with no reader fills and then blocks the writer. [param hidden] for the editor, which is headless
 * and so opens no window, but whose console an engine built as a console program would show; never
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
): Promise<{ child: ChildProcess; pid: number } | { error: string }> {
  return await new Promise((resolve) => {
    const child = (hidden ? spawnHidden : spawnShown)(spec.command, spec.args, {
      stdio: ['ignore', output, errors],
      detached,
      env: withChanges(process.env, spec.envChanges),
      cwd: directory,
    });
    child.once('error', (error: Error) => {
      resolve({ error: error.message });
    });
    child.once('spawn', () => {
      resolve(
        child.pid === undefined
          ? { error: 'the operating system gave it no pid' }
          : { child, pid: child.pid },
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
 * it plays a game; and a start without activation needs its helper to hold the foreground.
 */
async function startThroughHelper(
  spec: SentSpec,
  output: number | 'ignore',
  stopFile: string,
): Promise<{ child: ChildProcess; pid: number } | { error: string }> {
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
      const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : Number.NaN;
      if (Number.isInteger(pid) && pid > 0) {
        return { child: started.child, pid };
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
function profiledBy(path: string, projectPath: string): { observer: ProfileObserver; finish: () => void } {
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
  let projectGodot: string | null = null;
  try {
    projectGodot = readFileSync(join(projectPath, 'project.godot'), 'utf8');
  } catch {
    // The engine's default queue is what such a game runs with too.
  }
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
    frameFunctionsFor(queuedMessagesOf(projectGodot)),
  );
  writeProfileFile(path, { connected: false, listeningSince: Date.now() });
  return {
    observer,
    finish: () => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      latest = observer.totals() ?? latest;
      // The keeper exits after this, so there is no later write to fall back on, and the engine's
      // own totals arrive only now. Each try waits out a held file for a while of its own.
      let tries = 0;
      while (
        latest !== null &&
        !writeProfileFile(path, { ...latest, connected: true }) &&
        tries < LAST_WRITE_TRIES
      ) {
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
 */
async function startDetached(
  spec: SentSpec,
  output: number | 'ignore',
  hidden: boolean,
  stopFile = '',
): Promise<{ child: ChildProcess; pid: number } | { error: string }> {
  return throughTheHelper(spec)
    ? await startThroughHelper(spec, output, stopFile)
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

async function keep(): Promise<void> {
  const spec = await receivedSpec();
  const run = spec.run;
  if (run === undefined && !needsItsHelperKept(spec)) {
    process.stdout.write('error a keeper was started without a run or a helper to keep\n');
    process.exit(1);
  }
  // The game's debugger, opened before the game so it is listening when the game dials it: the
  // engine dials once, as it starts, and runs with no debugger if nobody answers.
  const profiled = run?.profile === undefined ? null : profiledBy(run.profile, run.projectPath);
  const debuggerPeer =
    run === undefined || run.debugged === false
      ? null
      : await GameDebugger.open(run.breakpoints ?? [], profiled === null ? [] : [profiled.observer]);
  const exitNotes = run === undefined ? null : mkdtempSync(join(tmpdir(), 'gdharness-exit-'));
  const noted =
    exitNotes === null
      ? spec
      : { ...spec, envChanges: { ...spec.envChanges, [EXIT_NOTES_VARIABLE]: exitNotes } };
  const toStart =
    debuggerPeer === null
      ? noted
      : { ...noted, args: withEngineArguments(noted.args, debuggerPeer.engineArguments) };
  const transcript = run === undefined ? 'ignore' : openSync(run.transcript, 'a');
  // Private to this keeper, for the file a helper watches for its stop.
  const own =
    run !== undefined && throughTheHelper(spec) ? mkdtempSync(join(tmpdir(), 'gdharness-stop-')) : null;
  const stopFile = own === null ? '' : join(own, 'stop');
  let started: Awaited<ReturnType<typeof startDetached>>;
  // Read beside the start rather than after it: on Windows it is a query of its own.
  const keeperStarted = run?.slot === undefined ? undefined : ownStart();
  // Before the game exists, so anything listed as started after it can be the game's own.
  const spawnedAt = Date.now();
  try {
    started = await startDetached(toStart, transcript, run === undefined, stopFile);
  } finally {
    // The game holds its own copy from here on.
    if (transcript !== 'ignore') {
      closeSync(transcript);
    }
  }
  if ('error' in started) {
    debuggerPeer?.close();
    process.stdout.write(`error ${started.error}\n`);
    process.exit(1);
  }
  const { child, pid } = started;
  const record =
    run === undefined
      ? null
      : {
          pid,
          transcript: run.transcript,
          startedAt: run.startedAt,
          startedBy: Date.now(),
          projectPath: run.projectPath,
          keeperPid: process.pid,
          ...(run.servedBy === undefined ? {} : { servedBy: run.servedBy }),
          ...(run.profile === undefined ? {} : { profile: run.profile }),
          arguments: toStart.args,
          command: spec.command,
        };
  if (record !== null) {
    // Before the pid goes back, and in the same turn as the exit is listened for: a game that ends at
    // once would otherwise exit before any record held its pid, and the exit would have nowhere to go.
    writeNoteIfItCan(record);
  }
  const exited = exitOf(child);
  let listening: KeeperListening | null = null;
  // What a stop ends: the game, through what this process holds rather than through the pid (the
  // game's own handle, or the helper's, which ends the game through the handle it holds; neither can
  // reach a later process given the same number), and then whatever it restarted itself into.
  let end = (): 'signalled' | 'gone' => {
    if (stopFile !== '') {
      writeFileSync(stopFile, '');
      return 'signalled';
    }
    return child.kill() ? 'signalled' : 'gone';
  };
  // Held in an object, since it is set by the stop the channel hears, which no flow analysis follows.
  const asked = { stop: false };
  if (record !== null) {
    listening = await listenForTheServer(
      () => {
        asked.stop = true;
        return end();
      },
      debuggerPeer === null ? null : (request) => debuggerPeer.ask(request),
    );
    if (listening !== null) {
      writeNoteIfItCan({ ...record, keeper: listening.address });
    }
  }
  // Nobody reads this once the launcher has gone, and a write to a pipe with no reader is an error.
  // Sent before the end is acted on, so a game that has already quit still has its pid answered.
  await new Promise<void>((resolve) => {
    process.stdout.once('error', () => {
      resolve();
    });
    process.stdout.end(`pid ${pid}\n`, resolve);
  });
  // After the pid has gone back, since on Windows reading this process's start is a query of its
  // own, and a start held up by it answered after a game that announces at once had done so.
  // The pid in the lock is this process's, since a game that restarts itself comes back under
  // another, so the label says whose it is: a wait would otherwise name it as the game's.
  const slot = run?.slot;
  if (slot !== undefined && keeperStarted !== undefined) {
    handSlot(slot.lock, slot.from, {
      pid: process.pid,
      started: await keeperStarted,
      by: `${slot.by}, through the keeper process that runs it`,
    });
  }
  let { code, signal } = await exited;
  let exitedAt = Date.now();
  let note: RunRecord | null =
    record === null ? null : listening === null ? record : { ...record, keeper: listening.address };
  if (note !== null) {
    writeNoteIfItCan({ ...note, endingAt: exitedAt });
  }
  // The game's restart, if it made one, is not this process's child, so the handle is no way to end it.
  end = () => 'gone';
  // Looked for at once, beside the drain: a successor that ends before the listing sees it is not
  // followed, and the run ends with the first process's exit.
  let looked =
    note === null || restartSaid(exitNotes, pid) === false
      ? null
      : followSuccessor(pid, spec.command, spawnedAt, exitedAt, run?.transcript);
  // The profile is finished from everything the game sent, which is read after its exit is told.
  if (debuggerPeer !== null) {
    await debuggerPeer.drained(DRAIN_MS);
  }
  profiled?.finish();
  let carried = pid;
  let notTold = false;
  while (note !== null && looked !== null) {
    const followed = await looked;
    if (followed === null) {
      break;
    }
    const next = followed.successor;
    const before: RestartedFrom = {
      pid: carried,
      endedAt: exitedAt,
      ...(code === null ? {} : { exitCode: code }),
      ...(code === null && signal !== null ? { exitSignal: signal } : {}),
    };
    note = {
      ...note,
      pid: next.pid,
      startedBy: next.startedAt,
      restartedFrom: [...(note.restartedFrom ?? []), before],
    };
    writeNoteIfItCan(note);
    end = () => {
      try {
        process.kill(next.pid);
        return 'signalled';
      } catch {
        return 'gone';
      }
    };
    // Asked while the restart was being looked for, and answered as nothing to end then.
    if (asked.stop) {
      end();
    }
    const ended = await followed.ended;
    carried = next.pid;
    code = ended.code;
    signal = null;
    notTold = ended.code === null;
    exitedAt = Date.now();
    writeNoteIfItCan({ ...note, endingAt: exitedAt });
    looked =
      restartSaid(exitNotes, next.pid) === false
        ? null
        : followSuccessor(next.pid, spec.command, next.startedAt, exitedAt, run?.transcript);
  }
  // After the profile, so a server told the run ended reads the profile it ended with.
  if (run !== undefined) {
    recordRunEnded(run.projectPath, carried, {
      exitCode: code,
      exitSignal: code === null ? signal : null,
      notTold,
    });
  }
  if (slot !== undefined) {
    giveBackSlot(slot.lock, process.pid);
  }
  debuggerPeer?.close();
  listening?.close();
  for (const made of [own, exitNotes]) {
    if (made !== null) {
      rmSync(made, { recursive: true, force: true });
    }
  }
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
const mode = process.argv[2];
if (mode === 'launch') {
  await launch();
} else if (mode === 'keep') {
  await keep();
} else {
  process.stderr.write('keeper.js launch|keep, with the spec on stdin\n');
  process.exit(2);
}
