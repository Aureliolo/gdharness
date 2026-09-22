/**
 * The editor's own console: where an editor gdharness opened writes it, and how to read it back.
 *
 * Nothing else here can see it. A parse error the editor prints while it loads reaches no plugin,
 * so the addon cannot scrape it; `editor_output` answers about game runs; and an editor in
 * self-contained mode writes no log of its own. A project downstream opened an editor that printed
 * hundreds of `Could not parse global class` lines at startup, and every tool gdharness has agreed
 * the project was fine, because every tool was reading something else. The only way to the wall
 * was a person looking at the window.
 *
 * The engine will write it if asked. `--log-file` takes the whole console, measured against the
 * pinned 4.7.2: a probe printing one line each of `print`, `printerr`, `push_warning` and
 * `push_error` put all four in the file in order, with the same `WARNING:` and `ERROR:` prefixes
 * the console shows, and a second run replaced the file rather than rotating it. So one file is
 * one editor session from its first line, which is the half of this that matters: the interesting
 * output is startup output, printed before any harness has connected.
 *
 * It covers an editor this server opened and nothing else. An editor somebody opened by hand was
 * never asked for a log and has none, which is a refusal rather than an empty answer: an empty
 * console and an uncaptured one read the same, and the first is the reading that sent the project
 * downstream to conclude the wall had gone away.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GameLog, type LogEntry, type Severity } from './game-log.js';
import { asParams, readNumber, readString } from './tool-args.js';

/** Where the editor of [param projectPath] writes its console, beside the other notes gdharness keeps. */
export function editorLogPath(projectPath: string): string {
  return join(projectPath, '.godot', 'gdharness-editor.log');
}

/** Where the server records which editor that log belongs to. */
function editorLogNotePath(projectPath: string): string {
  return join(projectPath, '.godot', 'gdharness-editor.json');
}

/**
 * Which editor the log beside this note was written by.
 *
 * The pid is the whole point of the note. A log left by yesterday's editor is still on disk today,
 * and `opened_by_a_server` is true of an editor opened by any gdharness, including one from before
 * this was captured at all. Both of those would otherwise be read as the connected editor's
 * console, which is the one way this can answer with somebody else's output.
 */
interface EditorLogNote {
  readonly pid: number;
  readonly startedAt: string;
}

function readEditorLogNote(projectPath: string): EditorLogNote | null {
  try {
    const fields = asParams(JSON.parse(readFileSync(editorLogNotePath(projectPath), 'utf8')));
    const pid = readNumber(fields, 'pid');
    const startedAt = readString(fields, 'startedAt');
    return pid !== undefined && Number.isInteger(pid) && pid > 0 && startedAt !== undefined
      ? { pid, startedAt }
      : null;
  } catch {
    return null;
  }
}

/**
 * Takes away what the last editor left, and makes the directory the next one will write into.
 *
 * Before the spawn, and separate from the note below, which cannot be written until the editor
 * has a process id. The engine replaces the file when it opens it, so this is for the editor that
 * never gets that far: one that fails to open its log leaves the previous session's output on
 * disk, and the note written a moment later would say it was this editor's.
 */
export function clearEditorLog(projectPath: string): void {
  try {
    const path = editorLogPath(projectPath);
    mkdirSync(dirname(path), { recursive: true });
    rmSync(path, { force: true });
    rmSync(editorLogNotePath(projectPath), { force: true });
  } catch {
    // A project that cannot be written into gets the refusal for an uncaptured console, which is
    // the same answer it would get for an editor nothing opened.
  }
}

/** Notes that the editor whose console sits beside this note is [param pid]. */
export function writeEditorLogNote(projectPath: string, pid: number): void {
  try {
    const path = editorLogNotePath(projectPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ pid, startedAt: new Date().toISOString() }, null, 2), 'utf8');
  } catch {
    // As above: no note is the uncaptured answer, which is true of this editor.
  }
}

/** Why there is no console to read, or null when there is one. */
export type NoConsole =
  | { readonly kind: 'not ours' }
  | { readonly kind: 'older server'; readonly notedPid: number | null }
  | { readonly kind: 'not written' };

/**
 * Why there is nothing to read, said as the thing that is true rather than as an empty answer.
 *
 * An empty console and an uncaptured one look the same, and the first is the reading that matters:
 * a session downstream that had been shown a wall of parse errors would take an empty answer for
 * the wall having gone away. Each of these is a different editor and a different thing to do.
 */
export function theConsoleWasNotCaptured(why: NoConsole, projectPath: string): string {
  if (why.kind === 'not ours') {
    return (
      'This editor was not opened by gdharness, so its console was never captured and nothing ' +
      'here has it: an editor prints to a console no plugin can read, and the addon cannot get ' +
      'at it from inside. This is not an editor that printed nothing.'
    );
  }
  if (why.kind === 'older server') {
    return (
      `This editor was opened by a gdharness server, but the console beside ${projectPath} belongs ` +
      `to editor ${why.notedPid ?? 'none recorded'} rather than to this one, so it holds an ` +
      'earlier session and is not offered as this one. A server from before consoles were ' +
      'captured leaves exactly this.'
    );
  }
  return (
    'This editor was opened by gdharness and has written nothing to its console file yet, not ' +
    'even the engine version it prints first, so the file is missing rather than empty. An ' +
    'editor that could not open the file for writing leaves this.'
  );
}

/**
 * The console of the editor with [param editorPid], or why there is none.
 *
 * [param openedByAServer] is what the addon reports about its own environment, and it is the first
 * question rather than the last: an editor somebody opened by hand cannot have a console here
 * whatever is on disk, and saying so is a different answer from a session that printed nothing.
 */
export function editorConsole(
  projectPath: string,
  editorPid: number | null,
  openedByAServer: boolean,
): { readonly log: GameLog; readonly path: string } | NoConsole {
  if (!openedByAServer) {
    return { kind: 'not ours' };
  }
  const noted = readEditorLogNote(projectPath);
  if (noted === null || editorPid === null || noted.pid !== editorPid) {
    return { kind: 'older server', notedPid: noted?.pid ?? null };
  }
  const path = editorLogPath(projectPath);
  if (!existsSync(path)) {
    return { kind: 'not written' };
  }
  const log = new GameLog();
  log.append('transcript', readFileSync(path, 'utf8'));
  log.finish();
  return { log, path };
}

/**
 * One value the shape below replaced, and how many different ones stood there.
 *
 * The values are half the diagnosis and normalising them away loses it. Four hundred lines of one
 * shape is a wall; four hundred lines whose class names are twenty-three `core/` classes and whose
 * files are fifty-eight tests is a finding, and the second is what a reader goes on to ask about.
 *
 * `allDifferent` is the slot that says nothing: a line number that is never the same twice tells
 * the reader only that the lines were different, which they knew from the count. Named rather than
 * left to be inferred from two equal numbers, and its sample is left out.
 */
interface Slot {
  readonly distinct: number;
  readonly allDifferent?: true;
  readonly some?: readonly string[];
  readonly more?: number;
}

/** A message shape several lines share, with what stood in its slots and what came before it. */
export interface Repeated {
  readonly shape: string;
  readonly count: number;
  readonly severity: Severity;
  readonly first: { readonly index: number; readonly text: string };
  readonly slots: readonly Slot[];
  readonly before: readonly string[];
}

/** At most this many values of a slot are named, and the rest are counted. */
const NAMED_VALUES = 6;

/** How far back the search for a line that is not part of a burst will walk before giving up. */
const WALK_BACK_LIMIT = 500;

/**
 * A quoted string, a resource path, or a line and column stuck to the end of one.
 *
 * Conservative on purpose. Over-normalising merges messages that mean different things, and a
 * project downstream has two shapes one letter apart in effect: a class whose script would not
 * parse and a class whose name resolved to nothing. Collapsing those into one would answer the
 * wrong question with a bigger number.
 */
const SLOTS = [/"[^"]*"/g, /'[^']*'/g, /\b(?:res|user):\/\/\S+/g, /(?<=\.gd|\.tscn|\.cs):\d+(?::\d+)?/g];

/**
 * The shape of [param text], and the values that were taken out of it, left to right.
 *
 * Left to right across all the patterns at once rather than one pattern at a time, because the
 * values are reported alongside the shape and a reader matches the nth value to the nth `…` in it.
 * A pattern at a time puts them in the order the patterns are written: an engine line reading
 * `res://tests/x.gd:26 - ... global class "Run" from "res://core/run.gd"` renders three
 * placeholders and returned the two quoted values first and the location last, so the file the
 * error was found in was reported as though it were the script that would not parse.
 */
export function shapeOf(text: string): { shape: string; values: string[] } {
  const values: string[] = [];
  let shape = '';
  let at = 0;
  while (at < text.length) {
    let earliest: { index: number; value: string } | null = null;
    for (const pattern of SLOTS) {
      pattern.lastIndex = at;
      const found = pattern.exec(text);
      // The longer of two starting together, so a quoted path is one value rather than a quote
      // around a path: the patterns overlap by design and the widest reading is the honest one.
      if (
        found !== null &&
        (earliest === null ||
          found.index < earliest.index ||
          (found.index === earliest.index && found[0].length > earliest.value.length))
      ) {
        earliest = { index: found.index, value: found[0] };
      }
    }
    if (earliest === null) {
      shape += text.slice(at);
      break;
    }
    shape += `${text.slice(at, earliest.index)}…`;
    values.push(earliest.value);
    at = earliest.index + earliest.value.length;
  }
  return { shape, values };
}

/**
 * The bursts in [param entries]: a message shape several lines share, collapsed.
 *
 * A group of one is the entry itself and is left where it is. Everything else carries its count,
 * its first occurrence, what stood in each slot, and the lines above the burst that are not
 * themselves part of one: the only evidence of cause in the case this was built for was a plugin
 * announcing itself on the line before the wall began, which a severity filter would have thrown
 * away and a fixed count of lines would have missed as soon as the wall was longer.
 */
export function bursts(entries: readonly LogEntry[], before: number): readonly Repeated[] {
  const shapes = new Map<string, { readonly indices: number[]; readonly values: string[][] }>();
  const shaped = entries.map((entry) => shapeOf(entry.text));
  for (const [at, entry] of entries.entries()) {
    const key = `${entry.severity}\u0000${shaped[at]?.shape ?? entry.text}`;
    const group = shapes.get(key) ?? { indices: [], values: [] };
    group.indices.push(at);
    group.values.push(shaped[at]?.values ?? []);
    shapes.set(key, group);
  }
  const collapsed = new Set<number>();
  for (const group of shapes.values()) {
    if (group.indices.length > 1) {
      for (const at of group.indices) {
        collapsed.add(at);
      }
    }
  }
  const repeated: Repeated[] = [];
  for (const [key, group] of shapes) {
    const first = group.indices[0];
    if (group.indices.length < 2 || first === undefined) {
      continue;
    }
    const entry = entries[first];
    if (entry === undefined) {
      continue;
    }
    repeated.push({
      shape: key.slice(key.indexOf('\u0000') + 1),
      count: group.indices.length,
      severity: entry.severity,
      first: { index: entry.index, text: entry.text },
      slots: slotsOf(group.values, group.indices.length),
      before: linesBefore(entries, first, collapsed, before),
    });
  }
  return repeated.sort((one, other) => other.count - one.count);
}

function slotsOf(values: readonly (readonly string[])[], count: number): readonly Slot[] {
  const width = Math.max(0, ...values.map((row) => row.length));
  const slots: Slot[] = [];
  for (let at = 0; at < width; at += 1) {
    const seen = [...new Set(values.map((row) => row[at]).filter((one) => one !== undefined))];
    if (seen.length === count && count > 1) {
      slots.push({ distinct: seen.length, allDifferent: true });
      continue;
    }
    const some = seen.slice(0, NAMED_VALUES);
    slots.push({
      distinct: seen.length,
      some,
      ...(seen.length > some.length ? { more: seen.length - some.length } : {}),
    });
  }
  return slots;
}

/**
 * The [param wanted] lines above [param at] that are not themselves part of a burst.
 *
 * By what they are rather than by how far back they sit. The line that explains a wall is the last
 * ordinary line above it, and counting backwards a fixed number of lines finds it only while the
 * wall is shorter than the count.
 */
function linesBefore(
  entries: readonly LogEntry[],
  at: number,
  collapsed: ReadonlySet<number>,
  wanted: number,
): readonly string[] {
  const found: string[] = [];
  for (let back = at - 1; back >= 0 && at - back <= WALK_BACK_LIMIT && found.length < wanted; back -= 1) {
    const entry = entries[back];
    if (entry !== undefined && !collapsed.has(back)) {
      found.push(entry.text);
    }
  }
  return found.reverse();
}
