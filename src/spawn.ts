import {
  type ChildProcess,
  type ChildProcessByStdio,
  type ChildProcessWithoutNullStreams,
  type ExecFileOptions,
  type ExecFileSyncOptionsWithStringEncoding,
  execFile,
  execFileSync,
  type SpawnOptions,
  type SpawnOptionsWithoutStdio,
  type SpawnOptionsWithStdioTuple,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
  type StdioNull,
  type StdioPipe,
  spawn,
  spawnSync,
} from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/**
 * The one way this package and its tests start a process, so every one starts with no window.
 *
 * A process with no console, which this server is under a harness and a gate run is when detached,
 * gives every console program it starts a console window of its own on the desktop in use: a gate
 * run detached after a push opened about twenty Godot console windows on the screen of the person
 * at the machine. `windowsHide` is what keeps them off it, and it is set here rather than left to
 * each call to remember; a regression refuses `child_process` and `Bun.spawn` anywhere else.
 */

export type { ChildProcess, ChildProcessWithoutNullStreams, SpawnSyncReturns } from 'node:child_process';

type Stdio = StdioNull | StdioPipe;
type Piped<S extends Stdio, Stream> = S extends StdioPipe ? Stream : null;

/** A child with no window, typed by which of its streams are piped, as Node's own `spawn` is. */
export function spawnHidden<I extends Stdio, O extends Stdio, E extends Stdio>(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithStdioTuple<I, O, E>,
): ChildProcessByStdio<Piped<I, Writable>, Piped<O, Readable>, Piped<E, Readable>>;
export function spawnHidden(
  command: string,
  args: readonly string[],
  options?: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams;
export function spawnHidden(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
export function spawnHidden(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  return spawn(command, [...args], { ...options, windowsHide: true });
}

/**
 * A game, whose window is what it is run for: Windows applies the hiding flag to the first window a
 * program shows as well as to its console, so hiding the start would hide the game. The keeper
 * starts it detached, which gives a console program no console at all.
 */
export function spawnShown(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  return spawn(command, [...args], { ...options, windowsHide: false });
}

/**
 * How [param child] ended, including an end that came before this was asked. Node tells an exit once,
 * to the listeners there at the time, so one added after it is never called: a keeper whose game
 * quit while its start was still reading the pid held the ended run for as long as the machine
 * stayed up.
 */
export function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      resolve({ code, signal });
    });
  });
}

/** What a hidden child printed, as text. A failure rejects with what it printed attached. */
export function runHidden(
  command: string,
  args: readonly string[],
  options: ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { ...options, encoding: 'utf8', windowsHide: true },
      (error: Error | null, stdout: string, stderr: string) => {
        if (error !== null) {
          Object.assign(error, { stdout, stderr });
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/** What a hidden child printed, waited for; it throws as `execFileSync` does when the child fails. */
export function runSyncHidden(
  command: string,
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding,
): string {
  return execFileSync(command, [...args], { ...options, windowsHide: true });
}

/** A hidden child run to its end before this returns, typed by its encoding as `spawnSync` is. */
export function spawnSyncHidden(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string>;
export function spawnSyncHidden(
  command: string,
  args: readonly string[],
  options?: SpawnSyncOptions,
): SpawnSyncReturns<Buffer>;
export function spawnSyncHidden(
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<string | Buffer> {
  return spawnSync(command, [...args], { ...options, windowsHide: true });
}
