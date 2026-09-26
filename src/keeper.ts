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

import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { throughHelper } from './desktop.js';
import {
  KEEPER_SCRIPT,
  readLaunched,
  receivedSpec,
  type SentSpec,
  sendSpec,
  withChanges,
} from './outside.js';
import { recordRunEnded, writeRunRecord } from './run-record.js';

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
): Promise<{ child: ChildProcess; pid: number } | { error: string }> {
  return await new Promise((resolve) => {
    const child = spawn(spec.command, [...spec.args], {
      stdio: ['ignore', output, errors],
      detached,
      windowsHide: hidden,
      env: withChanges(process.env, spec.envChanges),
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
): Promise<{ child: ChildProcess; pid: number } | { error: string }> {
  const scratch = mkdtempSync(join(tmpdir(), 'gdharness-desktop-'));
  const pidFile = join(scratch, 'pid');
  const errorFile = join(scratch, 'error');
  const where = spec.desktop === undefined ? 'without activation' : `on the ${spec.desktop} desktop`;
  try {
    const wrapper = throughHelper(spec, spec.command, spec.args, pidFile, errorFile);
    const started = await startDirectly(
      { ...spec, command: wrapper.command, args: wrapper.args },
      output,
      true,
      false,
      'ignore',
    );
    if ('error' in started) {
      return started;
    }
    const exited = { now: false };
    started.child.once('exit', () => {
      exited.now = true;
    });
    // Compiling the helper takes a few seconds the first time, and an engine is quick to start after.
    for (let waited = 0; waited < DESKTOP_START_MS; waited += 50) {
      const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : Number.NaN;
      if (Number.isInteger(pid) && pid > 0) {
        return { child: started.child, pid };
      }
      if (exited.now) {
        const why = existsSync(errorFile)
          ? readFileSync(errorFile, 'utf8').trim()
          : 'it exited saying nothing';
        return { error: `it could not be started ${where}: ${why}` };
      }
      await delay(50);
    }
    started.child.kill();
    return { error: `it was not started ${where} within ${DESKTOP_START_MS} ms` };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** How long a start through the helper is given to name the process it started. */
const DESKTOP_START_MS = 60_000;

/**
 * Through the helper where Windows is asked for a desktop or a start without activation, which Node
 * cannot name when it starts a process, and directly otherwise.
 */
async function startDetached(
  spec: SentSpec,
  output: number | 'ignore',
  hidden: boolean,
): Promise<{ child: ChildProcess; pid: number } | { error: string }> {
  return process.platform === 'win32' && (spec.desktop !== undefined || spec.noActivate === true)
    ? await startThroughHelper(spec, output)
    : await startDirectly(spec, output, hidden);
}

/**
 * Whether [param spec] needs its helper kept for as long as it runs, which only a keeper does: one
 * on a desktop of its own, for the desktop's sake, and one started without activation, whose helper
 * holds the foreground while it starts.
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
  const keeper = spawn(process.execPath, [KEEPER_SCRIPT, 'keep'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    windowsHide: true,
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
    process.stdout.write(
      `error the keeper ended before it said anything${complained ? `: ${complained.trim()}` : ''}\n`,
    );
    process.exit(0);
  });
}

async function keep(): Promise<void> {
  const spec = await receivedSpec();
  const run = spec.run;
  if (run === undefined && !needsItsHelperKept(spec)) {
    process.stdout.write('error a keeper was started without a run or a helper to keep\n');
    process.exit(1);
  }
  const transcript = run === undefined ? 'ignore' : openSync(run.transcript, 'a');
  let started: Awaited<ReturnType<typeof startDetached>>;
  try {
    started = await startDetached(spec, transcript, run === undefined);
  } finally {
    // The game holds its own copy from here on.
    if (transcript !== 'ignore') {
      closeSync(transcript);
    }
  }
  if ('error' in started) {
    process.stdout.write(`error ${started.error}\n`);
    process.exit(1);
  }
  const { child, pid } = started;
  if (run !== undefined) {
    // Before the pid goes back: a game that ends at once would otherwise exit before any record held
    // its pid, and the exit would have nowhere to go.
    writeRunRecord({
      pid,
      transcript: run.transcript,
      startedAt: run.startedAt,
      projectPath: run.projectPath,
      arguments: spec.args,
      command: spec.command,
    });
  }
  child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    if (run !== undefined) {
      recordRunEnded(run.projectPath, pid, { exitCode: code, exitSignal: code === null ? signal : null });
    }
    process.exit(0);
  });
  process.stdout.write(`pid ${pid}\n`);
  // Nobody reads this once the launcher has gone, and a write to a pipe with no reader is an error.
  process.stdout.end();
}

const mode = process.argv[2];
if (mode === 'launch') {
  await launch();
} else if (mode === 'keep') {
  await keep();
} else {
  process.stderr.write('keeper.js launch|keep, with the spec on stdin\n');
  process.exit(2);
}
