#!/usr/bin/env node

/**
 * The launcher and the keeper `outside.ts` starts, so nothing the server starts is its child.
 *
 * `launch` starts the target detached and exits once it has the pid; for a run it starts a keeper
 * instead, which is what becomes the game's parent. `keep` starts the game on its transcript,
 * writes the run's record, hands the pid back, and waits: a server can wait only on its own
 * children and none is the game's, so this process is what sees the exit and writes it where the
 * next server reads it.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { decodeSpec, KEEPER_SCRIPT, type OutsideSpec, readLaunched } from './outside.js';
import { recordRunEnded, writeRunRecord } from './run-record.js';

/**
 * The target started detached, so it is in no job object and no process group of this process;
 * its streams go to [param output], the transcript for a run and nowhere otherwise, since a pipe
 * with no reader fills and then blocks the writer.
 */
async function startDetached(
  spec: OutsideSpec,
  output: number | 'ignore',
): Promise<{ child: ChildProcess; pid: number } | { error: string }> {
  return await new Promise((resolve) => {
    const child = spawn(spec.command, [...spec.args], {
      stdio: ['ignore', output, output],
      detached: true,
      ...(spec.env === undefined ? {} : { env: spec.env }),
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

async function launch(encoded: string): Promise<void> {
  const spec = decodeSpec(encoded);
  if (spec.run === undefined) {
    const started = await startDetached(spec, 'ignore');
    if ('error' in started) {
      process.stdout.write(`error ${started.error}\n`);
    } else {
      started.child.unref();
      process.stdout.write(`pid ${started.pid}\n`);
    }
    process.exit(0);
  }
  const keeper = spawn(process.execPath, [KEEPER_SCRIPT, 'keep', encoded], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    windowsHide: true,
  });
  let printed = '';
  let complained = '';
  keeper.once('error', (error: Error) => {
    process.stdout.write(`error the keeper did not start: ${error.message}\n`);
    process.exit(0);
  });
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

async function keep(encoded: string): Promise<void> {
  const spec = decodeSpec(encoded);
  if (spec.run === undefined) {
    process.stdout.write('error a keeper was started without a run\n');
    process.exit(1);
  }
  const run = spec.run;
  const transcript = openSync(run.transcript, 'a');
  let started: Awaited<ReturnType<typeof startDetached>>;
  try {
    started = await startDetached(spec, transcript);
  } finally {
    // The game holds its own copy from here on.
    closeSync(transcript);
  }
  if ('error' in started) {
    process.stdout.write(`error ${started.error}\n`);
    process.exit(1);
  }
  const { child, pid } = started;
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
  child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    recordRunEnded(pid, { exitCode: code, exitSignal: code === null ? signal : null });
    process.exit(0);
  });
  process.stdout.write(`pid ${pid}\n`);
  // Nobody reads this once the launcher has gone, and a write to a pipe with no reader is an error.
  process.stdout.end();
}

const [mode, encoded] = process.argv.slice(2);
if (mode === 'launch' && encoded !== undefined) {
  await launch(encoded);
} else if (mode === 'keep' && encoded !== undefined) {
  await keep(encoded);
} else {
  process.stderr.write('keeper.js launch|keep <spec>\n');
  process.exit(2);
}
