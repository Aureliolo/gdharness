/**
 * Which engine deaths are a start that a second start would not repeat. Apart from `engine-run.ts`
 * because the keeper reads the same rule, and loads little else.
 */

import { CONTROL_SEQUENCE } from './game-log.js';

/** How many times an engine that crashes as it starts is started in all. */
export const ENGINE_STARTS = 3;
/** The wait before the second start, doubled before each one after it. */
export const START_RETRY_MS = 500;

/**
 * How long after its start an engine can still be told to have died as it started. Windows takes
 * seconds to report a crash on a loaded machine, and an engine that ran for longer reached its
 * project.
 */
export const START_WINDOW_MS = 30_000;

/** The Windows status of a console closed or sent Ctrl+C, which ends a process without a fault. */
export const CONSOLE_CLOSED = 0xc000013a;

/**
 * The Windows statuses that end an engine for a reason a second start would meet again: its console
 * closed or Ctrl+C, and a library it needs that is not there.
 */
const NOT_A_START_RACE = new Set([CONSOLE_CLOSED, 0xc0000135]);

/**
 * The status Godot's input library hook raises on a start it races: the hook answers a null
 * procedure address for a few instructions while a worker of the library, started on load, calls
 * through it. The race is in the engine's constructor, before the project is read.
 */
const START_RACE = 0xc06d007f;

/**
 * The line Godot prints first, as `Main::print_header` writes it: its name, version, the build's
 * time when it has one, and its address. The colour codes of the rich form are stripped before this
 * is matched.
 */
const ENGINE_BANNER =
  /^Godot Engine v\d+\.\d+(?:\.\d+)?\.[a-z]+\d*(?:\.[\w-]+)* (?:\(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC\) )?- https:\/\/godotengine\.org$/;

/**
 * The lines of [param text] as a log keeps them: without colour codes, and with the empty ones
 * dropped.
 */
export function printedLinesOf(text: string): string[] {
  return text
    .replace(CONTROL_SEQUENCE, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
}

/**
 * Whether an engine that exited with [param code], and that nothing here ended, died as it started.
 * [param printed] is the lines it printed, without the empty ones.
 *
 * A Windows exception status before a line counts, and for the status of the race the banner alone
 * does too, since the engine's other threads run on while Windows reports the crash. The banner
 * comes once the engine is past its constructor, so any other exception status after it may be a
 * fault in the project's own start, which a second start meets again.
 */
export function diedAsItStarted(code: number | null, printed: readonly string[]): boolean {
  if (code === null || code >>> 0 < 0xc0000000 || NOT_A_START_RACE.has(code >>> 0)) {
    return false;
  }
  return (
    printed.length === 0 ||
    (code >>> 0 === START_RACE && printed.length === 1 && ENGINE_BANNER.test(printed[0] ?? ''))
  );
}
