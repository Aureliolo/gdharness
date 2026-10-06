/**
 * The script whose parse error the others could not get past, which gdUnit4 never names.
 *
 * A parse error in a `class_name` script reaches a test run as every script using that class
 * failing with `Could not resolve class "Motif", because of a parser error.`, and the script
 * declaring the class is in none of it: the run stops at discovery before loading it on its own,
 * so the engine prints no line naming it. One missing colon in `core/motif.gd` answered with
 * twenty-nine scripts, every one of them fine, and the reader had to map the class to its file by
 * hand. That mapping is made here from the sources, and the declaring script is then put to the
 * engine's own check to find its line.
 */
import { join } from 'node:path';
import { howItEnded, runEngine } from './engine-run.js';
import type { LogEntry } from './game-log.js';
import { discoveryListing, type ScriptError } from './junit.js';
import { discard, scratchDirectory } from './scratch.js';

const UNRESOLVED = /Could not resolve class "([A-Za-z_][A-Za-z0-9_]*)", because of a parser error/;

/** An error the engine's check found in a script declaring a class others could not resolve. */
export interface ScriptOrigin extends ScriptError {
  /** The class it declares, which the scripts that failed through it name. */
  readonly declares: string;
}

/** A script declaring a class others could not resolve, in which the engine's check found nothing. */
export interface UnconfirmedOrigin {
  readonly path: string;
  readonly declares: string;
  /** Why nothing was found, as the end of a sentence. */
  readonly why: string;
}

/** The class [param message] says could not be resolved because of a parser error in it, or null. */
export function unresolvedClassIn(message: string): string | null {
  return UNRESOLVED.exec(message)?.[1] ?? null;
}

/** What one script holds by the engine's own check of it: its errors, or why it could not say. */
export type CheckScript = (path: string) => Promise<{ errors: ScriptError[]; failure: string | null }>;

/**
 * The longest chain of classes followed back. Each step is one engine start of a second or two,
 * and a chain is a class failing because of another class failing: a project nests a handful at
 * most, so a longer one is a cycle the visited set has not caught or a project worth stopping on.
 */
const MOST_CHECKED = 8;

/**
 * The scripts declaring a class [param errors] could not resolve: under `origins` each error the
 * engine's check found in one, in the order they were reached, and under `unconfirmed` those it
 * found nothing in, or could not finish. A script already among [param errors] is
 * named there with its own error and is not checked again; one declaring a class that could not
 * itself be resolved is followed to the script declaring that one, which is the one to open.
 *
 * A class [param declared] does not hold is left unnamed rather than guessed: a script that declares
 * it in a way the sources do not show is beyond what can be said without the engine's own cache.
 */
export async function originsOf(
  errors: readonly ScriptError[],
  declared: ReadonlyMap<string, string>,
  check: CheckScript,
): Promise<{ origins: ScriptOrigin[]; unconfirmed: UnconfirmedOrigin[] }> {
  const listed = new Set(errors.map((error) => error.path));
  const origins: ScriptOrigin[] = [];
  const unconfirmed: UnconfirmedOrigin[] = [];
  const asked = new Set<string>();
  const waiting = errors.map((error) => unresolvedClassIn(error.message)).filter((name) => name !== null);
  while (waiting.length > 0 && asked.size < MOST_CHECKED) {
    const name = waiting.shift() ?? '';
    const path = declared.get(name);
    if (path === undefined || listed.has(path) || asked.has(path)) {
      continue;
    }
    asked.add(path);
    const checked = await check(path);
    const own = checked.errors.filter((error) => error.path === path);
    if (own.length === 0) {
      unconfirmed.push({
        path,
        declares: name,
        why:
          checked.failure === null
            ? "the engine's check of it found no error"
            : `the engine's check of it did not finish (${checked.failure})`,
      });
      continue;
    }
    for (const error of own) {
      origins.push({ ...error, declares: name });
      const deeper = unresolvedClassIn(error.message);
      if (deeper !== null) {
        waiting.push(deeper);
      }
    }
  }
  return { origins, unconfirmed };
}

const RELOADED_AT = /GDScript::reload \((res:\/\/.+):(\d+)\)$/;

/** Where an engine error says a script failed to compile, read off the `at` line under it. */
function reloadedAt(entry: LogEntry): { path: string; line: number | null } | null {
  for (const line of entry.detail) {
    const at = RELOADED_AT.exec(line.trim());
    if (at !== null) {
      return { path: at[1] ?? '', line: Number(at[2]) === 0 ? null : Number(at[2]) };
    }
  }
  return null;
}

/**
 * The engine's own check of the script at [param path], which parses it and the scripts it uses
 * without running anything. Away from the project's own log, which the engine rotates when it starts
 * and a running game may still be writing to.
 */
export function checkWithEngine(godotPath: string, projectPath: string): CheckScript {
  return async (path) => {
    const logDir = scratchDirectory('tests');
    try {
      const ran = await runEngine(
        godotPath,
        [
          '--headless',
          '--log-file',
          join(logDir, 'engine.log'),
          '--path',
          projectPath,
          '--check-only',
          '-s',
          path,
        ],
        { timeout: { ms: 60_000, said: 'minute' } },
      );
      const errors = ran.log
        .select({ severity: 'error', sinceLastCall: false, limit: 50 })
        .entries.flatMap((entry) => {
          const at = reloadedAt(entry);
          return at === null ? [] : [{ ...at, message: entry.text }];
        });
      return { errors, failure: ran.failure === null ? null : howItEnded(ran) };
    } finally {
      discard(logDir);
    }
  };
}

/**
 * [param entries] without what the answer already says under `scriptErrors`: gdUnit4's list of the
 * scripts it could not load, each listed error as the engine printed it with its backtrace, and the
 * load failure that follows each. A parse error in a core script took nineteen dependents down
 * with it, and their entries alone ran the answer past fifteen kilobytes after the head had already
 * folded them into one list.
 */
export function withoutListed(entries: readonly LogEntry[], errors: readonly ScriptError[]): LogEntry[] {
  if (errors.length === 0) {
    return [...entries];
  }
  const listing = discoveryListing(entries.map((entry) => entry.text));
  const paths = new Set(errors.map((error) => error.path));
  return entries.filter((entry, at) => {
    if (listing !== null && at >= listing.from && at < listing.to) {
      return false;
    }
    const reloaded = reloadedAt(entry);
    if (
      reloaded !== null &&
      errors.some(
        (error) =>
          error.path === reloaded.path && error.line === reloaded.line && error.message === entry.text,
      )
    ) {
      return false;
    }
    const failedToLoad = /^Failed to load script "(res:\/\/[^"]+)" with error "[^"]+"\.$/.exec(entry.text);
    return failedToLoad === null || !paths.has(failedToLoad[1] ?? '');
  });
}
