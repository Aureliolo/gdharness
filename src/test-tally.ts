/**
 * What a test run's piped streams said, read an entry at a time as its log lets each one go, so a run
 * of any length is judged without holding every line it printed.
 *
 * Each reading is the one the answer would take from the whole log, and each count is of every
 * entry. The lists an answer carries keep at most {@link DISTINCT_KEPT} distinct entries each, and
 * below that they are exact. Past it, `capped` names each list cut and how many entries it left out.
 */

import { autoloadNotCompiled } from './autoload-failure.js';
import { EXIT_LEAK, HeldAtExitRead, WalkRead } from './engine-leaks.js';
import { answersTo, type FoldedEntry, FoldedRepeats, type GameLog, type LogEntry } from './game-log.js';
import {
  DiscoveryRead,
  finishesASuite,
  HookFailuresRead,
  NoReportRead,
  OrphansRead,
  RowsIgnoredRead,
  type ScriptError,
  type SuitesPrinted,
  SuitesRead,
} from './junit.js';
import { owned } from './log-read.js';
import { compileErrorsIn, type ListedMarks, listedMarks, listedUnder } from './script-origins.js';
import { nestedError, type ReasonHeadline, withoutReasonHeadlines } from './suite-judge.js';

/** The most distinct entries each list an answer carries holds before it is cut. */
export const DISTINCT_KEPT = 4096;

/** How many of the newest entries naming a phrase an answer echoes. */
const ECHOED_MOST = 200;

/** One script error a run printed over and over: its text, where it was raised, and how often. */
export interface RepeatedError {
  readonly text: string;
  readonly where: string | null;
  readonly times: number;
}

/** A list an answer carries that was cut for its bound, and how many entries it left out. */
export interface Capped {
  readonly list: string;
  readonly leftOut: number;
}

/**
 * The script error the last entry is, with how many entries before it were the same error raised
 * at the same place, read an entry at a time. A map of each kind holds at most [param most] texts,
 * the least recently printed let go first.
 */
export class ScriptErrorRepeats {
  private last: { entry: LogEntry; byScript: boolean } | null = null;
  /** The newest whole copy of each script error, by text. */
  private readonly whole = new Map<string, LogEntry>();
  /** How many copies of each script error at each place, by text and place. */
  private readonly times = new Map<string, number>();
  /** How many entries were let go for the bound: the copies counted, and the whole copies kept. */
  leftOut = 0;
  private readonly most: number;

  constructor(most = Number.POSITIVE_INFINITY) {
    this.most = most;
  }

  take(entry: LogEntry, byScript: boolean): void {
    this.last = { entry, byScript };
    if (!byScript) {
      return;
    }
    if (entry.detail.length > 0) {
      this.newest(this.whole, owned(entry.text), entryOwned(entry), () => 1);
    }
    const key = JSON.stringify([entry.text, entry.detail[0] ?? null]);
    this.newest(this.times, key, (this.times.get(key) ?? 0) + 1, (times) => times);
  }

  /** The repeated error, or null when the last entry is no script error. */
  result(): RepeatedError | null {
    const last = this.last;
    if (last === null || !last.byScript) {
      return null;
    }
    const whole = last.entry.detail.length > 0 ? last.entry : (this.whole.get(last.entry.text) ?? last.entry);
    const where = whole.detail[0] ?? null;
    const times = this.times.get(JSON.stringify([last.entry.text, where])) ?? 0;
    return { text: last.entry.text, where, times };
  }

  /** Sets [param key] as the newest of [param map], letting the oldest go past the bound. */
  private newest<Value>(
    map: Map<string, Value>,
    key: string,
    value: Value,
    entries: (value: Value) => number,
  ): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > this.most) {
      const oldest = map.entries().next();
      if (oldest.done !== true) {
        map.delete(oldest.value[0]);
        this.leftOut += entries(oldest.value[1]);
      }
    }
  }
}

/** The newest entries naming a phrase, as `select` with that phrase and a limit answers. */
class Echoed {
  private readonly entries: LogEntry[] = [];
  private matched = 0;
  private readonly phrase: string;

  constructor(phrase: string) {
    this.phrase = phrase;
  }

  take(entry: LogEntry): void {
    if (!answersTo(entry, 'info', this.phrase)) {
      return;
    }
    this.matched += 1;
    this.entries.push(entryOwned(entry));
    if (this.entries.length > ECHOED_MOST) {
      this.entries.shift();
    }
  }

  result(): { entries: LogEntry[]; omitted: number } {
    return { entries: [...this.entries], omitted: this.matched - this.entries.length };
  }
}

/** [param entry] in strings of its own. */
function entryOwned(entry: LogEntry): LogEntry {
  return { ...entry, text: owned(entry.text), detail: entry.detail.map(owned) };
}

/**
 * The entries outside gdUnit4's list of the scripts it could not load, folded as the answer folds
 * them once it leaves out the script errors it lists. Which errors those are is known only once the
 * run is over, so each entry is held with what ties it to one, and two entries the answer shows alike
 * are held apart when those differ. The oldest {@link DISTINCT_KEPT} are held.
 */
class UnlistedEntries {
  private readonly held = new Map<string, { entry: LogEntry; marks: ListedMarks; times: number }>();
  /** How many entries were not held for the bound. */
  leftOut = 0;

  take(shown: LogEntry, entry: LogEntry): void {
    const marks = listedMarks(entry);
    const key = JSON.stringify([
      shown.severity,
      shown.source,
      shown.text,
      shown.detail,
      marks.reloaded,
      marks.failedToLoad,
    ]);
    const seen = this.held.get(key);
    if (seen !== undefined) {
      seen.times += 1;
    } else if (this.held.size < DISTINCT_KEPT) {
      this.held.set(key, { entry: entryOwned(shown), marks, times: 1 });
    } else {
      this.leftOut += 1;
    }
  }

  /** The entries held, less those of [param errors], folded in the order each was first printed. */
  without(errors: readonly ScriptError[]): FoldedRepeats {
    const folded = new FoldedRepeats();
    for (const { entry, marks, times } of this.held.values()) {
      if (!listedUnder(marks, errors)) {
        folded.take(entry, times);
      }
    }
    return folded;
  }
}

/** What a test run's tally is told before the run starts. */
export interface TallyAsked {
  /** The scripts the project autoloads, by path. */
  readonly autoloaded: ReadonlyMap<string, string>;
  /** Whether the engine runs verbose, which puts its ordinary lines among the entries an answer shows. */
  readonly verbose: boolean;
  /** The phrase the caller asked to have echoed, if any. */
  readonly echo: string | undefined;
  /** An entry as an answer shows it. */
  readonly shown: (entry: LogEntry) => LogEntry;
  /** Whether [param entry] is a script error no case failed on. */
  readonly uncaught: (entry: LogEntry, byScript: boolean) => boolean;
}

/** The script errors no case failed on, as an answer reads them. */
export interface UncaughtRead {
  readonly count: number;
  readonly first: LogEntry | FoldedEntry | null;
  readonly texts: ReadonlySet<string>;
  readonly folded: { result(): FoldedEntry[] };
}

/** Every reading of a test run's piped streams its answer takes. */
export class TestRunTally {
  /** The first autoload the run said did not compile. */
  notCompiled: { name: string; path: string } | null = null;
  readonly engine: FoldedRepeats;
  /** Every entry, folded, the oldest distinct ones kept, for the answer of a run that wrote no report. */
  readonly printedFolded = new FoldedRepeats(DISTINCT_KEPT, 'oldest');
  /** The same outside gdUnit4's list of the scripts it could not load, for that answer when it lists them. */
  private readonly unlisted = new UnlistedEntries();
  readonly uncaught = {
    count: 0,
    first: null as LogEntry | null,
    texts: new Set<string>(),
    folded: new FoldedRepeats(DISTINCT_KEPT, 'oldest'),
  };
  readonly noReport = new NoReportRead();
  readonly discovery = new DiscoveryRead();
  readonly suites = new SuitesRead();
  readonly orphans = new OrphansRead();
  readonly hooks = new HookFailuresRead();
  readonly rowsIgnored = new RowsIgnoredRead();
  readonly repeats = new ScriptErrorRepeats(DISTINCT_KEPT);
  readonly compileErrors: ScriptError[] = [];
  readonly nested: string[] = [];
  readonly leaked = new Set<string>();
  readonly walk = new WalkRead();
  readonly held = new HeldAtExitRead();
  readonly echoed: Echoed | null;
  private previous: LogEntry | null = null;
  /** How many entries each list not folded left out for its bound, by the list's name. */
  private readonly cut = new Map<string, number>();
  private readonly asked: TallyAsked;

  constructor(asked: TallyAsked) {
    this.asked = asked;
    this.engine = new FoldedRepeats(DISTINCT_KEPT, 'newest');
    this.echoed = asked.echo === undefined ? null : new Echoed(asked.echo);
  }

  /** Reads [param entry], one the log will not change again, and whether it was a script error. */
  take(entry: LogEntry, byScript: boolean): void {
    const { asked } = this;
    this.notCompiled ??= autoloadNotCompiled(entry, asked.autoloaded);
    const nested = this.previous === null ? null : nestedError(this.previous, entry);
    if (nested !== null) {
      this.keep(this.nested, owned(nested), 'nested errors');
    }
    this.previous = entry;
    const shown = asked.shown(entry);
    if (answersTo(entry, asked.verbose ? 'info' : 'warning', undefined)) {
      this.engine.take(shown);
    }
    this.printedFolded.take(shown);
    if (asked.uncaught(entry, byScript)) {
      this.takeUncaught(entry, shown);
    }
    const { text } = entry;
    for (const fold of [this.noReport, this.suites, this.orphans, this.hooks, this.rowsIgnored]) {
      fold.take(text);
    }
    this.discovery.take(text);
    if (!this.discovery.listed) {
      this.unlisted.take(shown, entry);
    }
    this.repeats.take(entry, byScript);
    for (const error of entry.severity === 'error' ? compileErrorsIn([entry]) : []) {
      this.keep(this.compileErrors, error, 'compile errors');
    }
    if (EXIT_LEAK.test(text)) {
      this.distinct(this.leaked, text, 'leaks at exit');
    }
    this.walk.take(text);
    this.held.take(text);
    this.echoed?.take(entry);
  }

  private takeUncaught(entry: LogEntry, shown: LogEntry): void {
    const { uncaught } = this;
    uncaught.count += 1;
    uncaught.first ??= entryOwned(entry);
    this.distinct(uncaught.texts, entry.text, null);
    uncaught.folded.take(shown);
  }

  /**
   * Adds [param text] to [param set] while it holds fewer than its most, else counts it left out of
   * the list [param what] names, when the answer shows the set as one.
   */
  private distinct(set: Set<string>, text: string, what: string | null): void {
    if (set.has(text)) {
      return;
    }
    if (set.size < DISTINCT_KEPT) {
      set.add(owned(text));
    } else if (what !== null) {
      this.leftOut(what);
    }
  }

  /** Adds [param item] to [param list] while it holds fewer than its most, else counts it left out of [param what]. */
  private keep<Item>(list: Item[], item: Item, what: string): void {
    if (list.length < DISTINCT_KEPT) {
      list.push(item);
    } else {
      this.leftOut(what);
    }
  }

  private leftOut(what: string): void {
    this.cut.set(what, (this.cut.get(what) ?? 0) + 1);
  }

  /**
   * The first [param most] distinct entries the run printed, folded, less what the answer lists
   * under [param errors]: gdUnit4's list of the scripts it could not load, each listed error, and
   * the load failure that follows each.
   */
  entriesWithout(
    errors: readonly ScriptError[],
    most: number,
    reasons: readonly ReasonHeadline[] = [],
  ): FoldedEntry[] {
    const folded = errors.length === 0 ? this.printedFolded : this.unlisted.without(errors);
    const leftOut = errors.length === 0 ? this.printedFolded.leftOut : this.unlisted.leftOut;
    if (leftOut > 0) {
      this.cut.set('entries', leftOut);
    }
    return withoutReasonHeadlines(folded.result(), reasons).slice(0, most);
  }

  /**
   * The script errors no case failed on, less each print of a skip reason's line headed
   * `SCRIPT ERROR:` in [param reasons], which is the reason's text.
   */
  uncaughtWithout(reasons: readonly ReasonHeadline[]): UncaughtRead {
    const { uncaught } = this;
    const taken = reasons.reduce((sum, one) => sum + (one.script ? one.times : 0), 0);
    if (taken === 0) {
      return uncaught;
    }
    const folded = withoutReasonHeadlines(uncaught.folded.result(), reasons, true);
    const left = new Set(folded.map((entry) => entry.text));
    const gone = new Set(reasons.filter((one) => one.script && !left.has(one.text)).map((one) => one.text));
    return {
      count: Math.max(0, uncaught.count - taken),
      first: folded[0] ?? null,
      texts: new Set([...uncaught.texts].filter((text) => !gone.has(text))),
      folded: { result: () => folded },
    };
  }

  /** Each list cut for its bound, with how many entries it left out, in a stable order. */
  capped(): Capped[] {
    const folds: [{ readonly leftOut: number }, string][] = [
      [this.engine, 'engine entries'],
      [this.uncaught.folded, 'uncaught script errors'],
      [this.repeats, 'repeated script errors'],
    ];
    const cut = new Map(this.cut);
    for (const [fold, list] of folds) {
      if (fold.leftOut > 0) {
        cut.set(list, fold.leftOut);
      }
    }
    return [...cut]
      .map(([list, leftOut]) => ({ list, leftOut }))
      .toSorted((a, b) => (a.list < b.list ? -1 : a.list > b.list ? 1 : 0));
  }
}

/**
 * What a test run's progress reads off [param log] while it fills: the suites printed so far, and
 * whether one finished at or past position [param read]. [param tally] has read what the log let
 * go, and what it still holds is read on from there. The `read` returned is the next look's.
 */
export function progressRead(
  log: GameLog,
  tally: TestRunTally,
  read: number,
): { suites: SuitesPrinted; finishedOne: boolean; read: number } {
  const suites = tally.suites.copy();
  for (const entry of log.all) {
    suites.take(entry.text);
  }
  const fresh = log.heldFrom(read);
  return {
    suites: suites.result(),
    finishedOne: fresh.entries.some((entry) => finishesASuite(entry.text)),
    read: fresh.next,
  };
}
