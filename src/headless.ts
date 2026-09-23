/**
 * A headless operation: the engine run on a project with the operations script, one JSON object
 * on stdout as the answer.
 *
 * Every tool that needs no editor and no running game goes through here, so the contract with
 * the script lives in one place: parameters cross as snake_case in a file, a failure is a
 * non-zero exit with the reason on stderr, and an answer is the last JSON line printed.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { callSignal } from './call-signal.js';
import { emptyRecord } from './dictionary.js';
import { GameLog, type LogEntry } from './game-log.js';
import { discard } from './scratch.js';
import type { OperationParams } from './server-types.js';

// execFile, not exec: no shell means no quoting, and no quoting means no way to escape out of
// it. Every argument is an array element, so a path full of backslashes or spaces is a path.
const run = promisify(execFile);

export interface HeadlessEngine {
  readonly godotPath: string;
  /** The operations script, an absolute path outside the project. */
  readonly script: string;
  /** Ask the script for its own debug lines. */
  readonly debug: boolean;
}

export type HeadlessOutcome =
  | {
      readonly ok: true;
      readonly payload: OperationParams;
      /** What the engine put on stderr on the way, as problems rather than lines. */
      readonly messages: readonly LogEntry[];
    }
  | { readonly ok: false; readonly message: string; readonly messages: readonly LogEntry[] };

/**
 * The script reads its parameters in snake_case, the tools take them in camelCase. Only the
 * parameters themselves are renamed: what they hold (a setting value, import options, a list of
 * events) is the engine's own vocabulary, or the tool schema's, and crosses as written.
 */
function snakeCased(params: OperationParams): OperationParams {
  const result: OperationParams = emptyRecord();
  for (const [key, value] of Object.entries(params)) {
    const name = key.startsWith('_') ? key : key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    result[name] = value;
  }
  return result;
}

/** The last line of stdout that parses as a JSON object, which is where the script's answer is. */
function lastJsonObject(stdout: string): OperationParams | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'));
  for (const line of lines.reverse()) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as OperationParams;
      }
    } catch {
      // A line that begins with a brace and is not JSON is something printed, not the answer.
    }
  }
  return null;
}

function problems(stderr: string): LogEntry[] {
  const log = new GameLog();
  log.append('stderr', stderr);
  log.finish();
  return log.select({ severity: 'warning', sinceLastCall: false, limit: 200 }).entries;
}

/**
 * The reason a run failed, as the script or the engine gave it. The script writes its own
 * refusals as `[ERROR] ...`; anything else on stderr is the engine's, and stdout's last words
 * are the fallback for a run that said nothing there either.
 */
function reason(stdout: string, stderr: string): string {
  const own = stderr
    .split(/\r?\n/)
    .filter((line) => line.startsWith('[ERROR] '))
    .map((line) => line.slice('[ERROR] '.length));
  if (own.length > 0) {
    return own.join('; ');
  }
  const engine = problems(stderr)
    .filter((entry) => entry.severity === 'error')
    .map((entry) => entry.text);
  if (engine.length > 0) {
    return engine.join('; ');
  }
  return stdout.trim().split(/\r?\n/).at(-1) ?? 'no output at all';
}

/**
 * The engine's own import pass over a project, which is what mints a missing `.uid`.
 *
 * Not an operation: there is no script and no answer to parse, only the exit status and whatever
 * the engine complained about. It is here rather than in the server because it is the same engine
 * boot as every other headless call, and wants the same log-file treatment: the project's own
 * `user://logs/godot.log` is rotated on start, so a boot that used it would rotate a running
 * bench's log out from under it.
 */
export async function runImport(
  godotPath: string,
  projectPath: string,
): Promise<
  { ok: true; messages: readonly LogEntry[] } | { ok: false; message: string; messages: readonly LogEntry[] }
> {
  const logDir = mkdtempSync(join(tmpdir(), 'gdharness-import-'));
  try {
    const { stderr } = await run(
      godotPath,
      ['--headless', '--log-file', join(logDir, 'engine.log'), '--path', projectPath, '--import'],
      { signal: callSignal() },
    );
    return { ok: true, messages: problems(stderr) };
  } catch (error) {
    if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
      const failed = error as Error & { stdout: string; stderr: string; code?: number | string };
      return {
        ok: false,
        message: `the import pass failed (exit ${failed.code ?? 'unknown'}): ${reason(failed.stdout, failed.stderr)}`,
        messages: problems(failed.stderr),
      };
    }
    return {
      ok: false,
      message: `the import pass could not be run: ${error instanceof Error ? error.message : String(error)}`,
      messages: [],
    };
  } finally {
    discard(logDir);
  }
}

export async function runOperation(
  engine: HeadlessEngine,
  operation: string,
  params: OperationParams,
  projectPath: string,
): Promise<HeadlessOutcome> {
  // Parameters go via a file rather than the command line: a JSON blob on argv runs into
  // Windows command-line parsing of \t, \r and \" whatever the quoting.
  const paramsDir = mkdtempSync(join(tmpdir(), 'gdharness-params-'));
  const paramsFile = join(paramsDir, `${operation}.json`);
  writeFileSync(paramsFile, JSON.stringify(snakeCased(params)), 'utf8');
  const args = [
    '--headless',
    // Away from the project's own user://logs/godot.log, which a project with file logging on
    // has a run writing to. The engine renames that file when a process starts, so a boot here
    // rotated a running bench's log out from under it and the bench went on writing at the
    // offset it still believed it was at: measured as the operation's few hundred bytes, a
    // zero-filled gap, then the bench's next row. These runs answer one question and exit, so
    // the log they write is of no use to anybody and goes where the parameters go.
    '--log-file',
    join(paramsDir, 'engine.log'),
    '--path',
    projectPath,
    '--script',
    engine.script,
    operation,
    `@file:${paramsFile}`,
    ...(engine.debug ? ['--debug-godot'] : []),
  ];

  let stdout: string;
  let stderr: string;
  try {
    // Ended with the call when the caller cancels it, rather than left to finish for nobody.
    ({ stdout, stderr } = await run(engine.godotPath, args, { signal: callSignal() }));
  } catch (error) {
    if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
      const failed = error as Error & { stdout: string; stderr: string; code?: number | string };
      return {
        ok: false,
        message: `${operation} failed (exit ${failed.code ?? 'unknown'}): ${reason(failed.stdout, failed.stderr)}`,
        messages: problems(failed.stderr),
      };
    }
    return {
      ok: false,
      message: `${operation} could not be run: ${error instanceof Error ? error.message : String(error)}`,
      messages: [],
    };
  } finally {
    discard(paramsDir);
  }

  // A run that exited cleanly but printed no answer is an engine that never reached the
  // script, and handing on whatever it did print is how that reads as a tool that succeeded.
  const payload = lastJsonObject(stdout);
  if (payload === null) {
    return {
      ok: false,
      message: `${operation} produced no result: ${reason(stdout, stderr)}`,
      messages: problems(stderr),
    };
  }
  return { ok: true, payload, messages: problems(stderr) };
}
