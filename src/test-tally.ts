/**
 * What a test run's piped streams said, read an entry at a time as its log lets each one go, so a run
 * of any length is judged without holding every line it printed.
 *
 * Each reading is the one the answer would take from the whole log. The lists an answer carries are
 * kept to a few thousand distinct entries, and below that they are exact. Past it, `capped` says
 * which were cut.
 */

import { autoloadNotCompiled } from './autoload-failure.js';
import { EXIT_LEAK, HeldAtExitRead, WalkRead } from './engine-leaks.js';
import { answersTo, type FoldedEntry, FoldedRepeats, type LogEntry } from './game-log.js';
import {
  DiscoveryRead,
  HookFailuresRead,
  NoReportRead,
  OrphansRead,
  RowsIgnoredRead,
  type ScriptError,
  SuitesRead,
} from './junit.js';
import { owned } from './log-read.js';
import { compileErrorsIn, withoutListed } from './script-origins.js';
import { nestedError } from './suite-judge.js';

/** The most distinct entries a folded list holds before it is cut. */
export const DISTINCT_KEPT = 4096;

/** The most entries of other lists kept: the compile errors, the nested errors and the first entries. */
const LISTED_KEPT = 1000;

/** How many of the newest entries naming a phrase an answer echoes. */
const ECHOED_MOST = 200;

/** One script error a run printed over and over: its text, where it was raised, and how often. */
export interface RepeatedError {
  readonly text: string;
  readonly where: string | null;
  readonly times: number;
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
  overflowed = false;
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
      this.newest(this.whole, owned(entry.text), entryOwned(entry));
    }
    const key = JSON.stringify([entry.text, entry.detail[0] ?? null]);
    this.newest(this.times, key, (this.times.get(key) ?? 0) + 1);
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

  private newest<Value>(map: Map<string, Value>, key: string, value: Value): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > this.most) {
      this.overflowed = true;
      const oldest = map.keys().next();
      if (oldest.done !== true) {
        map.delete(oldest.value);
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

/** Every reading of a test run's piped streams its answer takes. */
export class TestRunTally {
  /** The first autoload the run said did not compile. */
  notCompiled: { name: string; path: string } | null = null;
  readonly engine: FoldedRepeats;
  /** Every entry, folded, the oldest distinct ones kept, for the answer of a run that wrote no report. */
  readonly printedFolded = new FoldedRepeats(DISTINCT_KEPT, 'oldest');
  /** The first entries in full, for that answer when it leaves out the script errors it lists. */
  readonly printedFirst: LogEntry[] = [];
  printedCount = 0;
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
  private readonly cut = new Set<string>();
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
    if (answersTo(entry, asked.verbose ? 'info' : 'warning', undefined)) {
      this.engine.take(asked.shown(entry));
    }
    this.printedCount += 1;
    this.printedFolded.take(asked.shown(entry));
    if (this.printedFirst.length < LISTED_KEPT) {
      this.printedFirst.push(entryOwned(entry));
    }
    if (asked.uncaught(entry, byScript)) {
      this.takeUncaught(entry);
    }
    const { text } = entry;
    for (const fold of [this.noReport, this.discovery, this.suites, this.orphans, this.hooks, this.rowsIgnored]) {
      fold.take(text);
    }
    this.repeats.take(entry, byScript);
    for (const error of entry.severity === 'error' ? compileErrorsIn([entry]) : []) {
      this.keep(this.compileErrors, error, 'compile errors');
    }
    if (EXIT_LEAK.test(text) && !this.leaked.has(text)) {
      if (this.leaked.size < DISTINCT_KEPT) {
        this.leaked.add(owned(text));
      } else {
        this.cut.add('leaks at exit');
      }
    }
    this.walk.take(text);
    this.held.take(text);
    this.echoed?.take(entry);
  }

  private takeUncaught(entry: LogEntry): void {
    const { uncaught } = this;
    uncaught.count += 1;
    uncaught.first ??= entryOwned(entry);
    if (!uncaught.texts.has(entry.text)) {
      if (uncaught.texts.size < DISTINCT_KEPT) {
        uncaught.texts.add(owned(entry.text));
      } else {
        this.cut.add('uncaught script errors');
      }
    }
    uncaught.folded.take(this.asked.shown(entry));
  }

  /** Adds [param item] to [param list] while it holds fewer than its most, else notes [param what] cut. */
  private keep<Item>(list: Item[], item: Item, what: string): void {
    if (list.length < LISTED_KEPT) {
      list.push(item);
    } else {
      this.cut.add(what);
    }
  }

  /**
   * The first [param most] distinct entries the run printed, folded, less what the answer lists
   * under [param errors]. With no errors to leave out the oldest distinct entries are kept whole,
   * however long the run. Otherwise they come from its first entries, and a run that printed more
   * than those and left fewer than [param most] is noted cut.
   */
  entriesWithout(errors: readonly ScriptError[], most: number): FoldedEntry[] {
    if (errors.length === 0) {
      return this.printedFolded.result().slice(0, most);
    }
    const folded = new FoldedRepeats();
    for (const entry of withoutListed(this.printedFirst, errors, this.discovery.result())) {
      folded.take(this.asked.shown(entry));
    }
    const kept = folded.result();
    if (kept.length < most && this.printedCount > this.printedFirst.length) {
      this.cut.add('entries');
    }
    return kept.slice(0, most);
  }

  /** What was cut for the bounds, each named in words, in a stable order. */
  capped(): string[] {
    const folds: [FoldedRepeats | ScriptErrorRepeats, string][] = [
      [this.engine, 'engine entries'],
      [this.uncaught.folded, 'uncaught script errors'],
      [this.repeats, 'repeated script errors'],
    ];
    const cut = new Set(this.cut);
    for (const [fold, what] of folds) {
      if (fold.overflowed) {
        cut.add(what);
      }
    }
    if (this.hooks.cut) {
      cut.add('hook failure messages');
    }
    return [...cut].toSorted();
  }
}
