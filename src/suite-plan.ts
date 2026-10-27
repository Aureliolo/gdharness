/**
 * Which suites a project has, what each case cost last time, and how they are dealt to engines.
 *
 * Read from the scripts on disk rather than asked of an engine, because the plan has to exist
 * before any engine starts, and because the case list read here is what each engine's run is held
 * to afterwards: a suite that stopped partway, or a case gdUnit4 never reached, shows up as a case
 * that was planned and never reported.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { declaredClassOf, eachScript } from './class-cache.js';
import { codeOf, shapeOf } from './gdscript-source.js';
import { parseProjectGodot } from './resources.js';
import type { HandedSuite, RowShare, RunPrinted } from './suite-judge.js';
import { writeWhole } from './whole-file.js';

/** The class every gdUnit4 suite extends, by name. */
const SUITE_BASE = 'GdUnitTestSuite';
/** What a case's function is called, as gdUnit4 finds them: `get_script_method_list` and the prefix. */
const CASE_PREFIX = 'test_';
/** A suite saying whether it needs a real window, as a constant so the runner can read it too. */
const NEEDS_WINDOW = /^const\s+GDHARNESS_NEEDS_WINDOW\b[^=\n]*=\s*(true|false)\b/m;
/** Where suites are looked for when none are named, by gdharness test and project_test alike. */
export const TEST_DIRECTORIES = ['tests', 'test'];

/**
 * gdUnit4's scene runner, whose input events go nowhere in a headless engine. A guess, since many
 * suites use it only to stand a scene up, so a suite's own declaration overrides it.
 */
const SCENE_RUNNER = /\bscene_runner\s*\(/;

/**
 * The folders no search for suites goes into, a `PackedStringArray` of `res://` paths: benches
 * written as suites, run by hand. A suite in one still runs when it, or a folder at or inside the
 * one listed, is named.
 */
export const NOT_SEARCHED_SETTING = 'gdharness/tests/not_searched';
/**
 * Whether a suite calling scene_runner and declaring nothing is given a window, true unless set. A
 * project whose scene runner suites pass headless turns the guess off here rather than in each.
 */
export const GUESS_WINDOW_SETTING = 'gdharness/tests/scene_runner_needs_window';

/** [param path] at or inside the folder [param folder], both `res://` paths. */
function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

export interface DeclaredSuite {
  readonly path: string;
  /** Its case functions, its own and those of the project's scripts it extends, sorted. */
  readonly cases: readonly string[];
  /**
   * Whether it needs an engine with a window: it says so, or it drives a scene through gdUnit4 and
   * says nothing either way.
   */
  readonly windowed: boolean;
  /**
   * Whether it says it runs headless, which keeps it out of the windowed engine: a suite sizing the
   * root viewport itself gets that size headless, and the window's own size with a window.
   */
  readonly headless: boolean;
}

/** One script as read for discovery. */
interface ReadScript {
  readonly source: string;
  readonly extendsAs: string | null;
  readonly funcs: readonly string[];
  readonly code: string;
}

/** The project's scripts by `res://` path, and its global classes by name, read once. */
export class ProjectScripts {
  readonly sources = new Map<string, string>();
  readonly classes = new Map<string, string>();
  private readonly read = new Map<string, ReadScript>();
  readonly projectPath: string;
  /** The folders [constant NOT_SEARCHED_SETTING] names, without a trailing slash. */
  readonly notSearched: readonly string[];
  private readonly guessWindow: boolean;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    let settings: Record<string, unknown> = {};
    try {
      settings =
        parseProjectGodot(readFileSync(join(projectPath, 'project.godot'), 'utf8'))['gdharness'] ?? {};
    } catch {
      // A project with no readable project.godot has no settings to read; whatever runs it says so.
    }
    const [section, key] = [NOT_SEARCHED_SETTING, GUESS_WINDOW_SETTING].map((setting) =>
      setting.slice('gdharness/'.length),
    );
    const listed = settings[section ?? ''];
    this.notSearched =
      typeof listed === 'string'
        ? [...listed.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((found) => (found[1] ?? '').replace(/\/+$/, ''))
        : [];
    this.guessWindow = settings[key ?? ''] !== false;
    eachScript(projectPath, (script, source) => {
      this.sources.set(script, source);
      const declared = declaredClassOf(source);
      if (declared !== null) {
        this.classes.set(declared, script);
      }
    });
  }

  script(path: string): ReadScript | undefined {
    const known = this.read.get(path);
    if (known !== undefined) {
      return known;
    }
    const source = this.sources.get(path);
    if (source === undefined) {
      return undefined;
    }
    const shape = shapeOf(source);
    const read: ReadScript = {
      source,
      extendsAs: shape.body.extendsAs,
      funcs: shape.body.declarations.filter((d) => d.kind === 'func').map((d) => d.name),
      code: codeOf(source),
    };
    this.read.set(path, read);
    return read;
  }

  /** The script [param path] extends, as a path in the project, the base class's name, or null. */
  base(path: string): { readonly path: string } | { readonly name: string } | null {
    const extendsAs = this.script(path)?.extendsAs ?? null;
    if (extendsAs === null) {
      return null;
    }
    const quote = extendsAs[0];
    if (quote === '"' || quote === "'") {
      const target = extendsAs.slice(1, -1);
      return {
        path: target.startsWith('res://')
          ? target
          : `res://${posix.join(posix.dirname(path.slice(6)), target)}`,
      };
    }
    const name = extendsAs.split('.')[0] ?? extendsAs;
    const declaring = this.classes.get(name);
    return declaring === undefined ? { name } : { path: declaring };
  }

  /** [param path] as a suite, or null when it does not extend gdUnit4's or declares no case. */
  suite(path: string): DeclaredSuite | null {
    const cases = new Set<string>();
    // The nearest script in the chain to declare it decides, as the nearest declaration of a constant
    // is the one GDScript reads.
    let said: boolean | undefined;
    let guessed = false;
    const seen = new Set<string>();
    let at = path;
    while (!seen.has(at)) {
      seen.add(at);
      const read = this.script(at);
      if (read === undefined) {
        return null;
      }
      for (const func of read.funcs.filter((name) => name.startsWith(CASE_PREFIX))) {
        cases.add(func);
      }
      const declared = NEEDS_WINDOW.exec(read.code)?.[1];
      said ??= declared === undefined ? undefined : declared === 'true';
      guessed ||= this.guessWindow && SCENE_RUNNER.test(read.code);
      const base = this.base(at);
      if (base === null) {
        return null;
      }
      // By name, or by the script declaring it: gdUnit4's own class is a global class of the project.
      if ('name' in base ? base.name === SUITE_BASE : base.path === this.classes.get(SUITE_BASE)) {
        return cases.size > 0
          ? { path, cases: [...cases].sort(), windowed: said ?? guessed, headless: said === false }
          : null;
      }
      if ('name' in base) {
        return null;
      }
      at = base.path;
    }
    return null;
  }

  /**
   * Every suite under the directories [param roots] name, as `res://` paths, sorted by path, past
   * the folders [constant NOT_SEARCHED_SETTING] names unless the root is at or inside one.
   */
  suitesUnder(roots: readonly string[]): DeclaredSuite[] {
    return this.searched(roots).flatMap((path) => this.suite(path) ?? []);
  }

  /**
   * The scripts under [param roots], searched as [method suitesUnder] searches them, that declare a
   * case and are no suite, each with the cases it declares. gdUnit4 never runs them and says nothing
   * of it, so a suite whose `extends` names the wrong class passes with none of its cases run.
   */
  uncollectedUnder(roots: readonly string[]): { readonly path: string; readonly cases: readonly string[] }[] {
    return this.searched(roots).flatMap((path) => {
      const cases = this.script(path)?.funcs.filter((name) => name.startsWith(CASE_PREFIX)) ?? [];
      return cases.length === 0 || this.suite(path) !== null ? [] : [{ path, cases: [...cases].sort() }];
    });
  }

  private searched(roots: readonly string[]): string[] {
    const trimmed = roots.map((root) => root.replace(/\/+$/, ''));
    return [...this.sources.keys()]
      .filter((path) =>
        trimmed.some(
          (root) =>
            path.startsWith(`${root}/`) &&
            !this.notSearched.some((folder) => within(path, folder) && !within(root, folder)),
        ),
      )
      .sort();
  }

  /**
   * [param paths], files and directories as `res://` paths, with each directory that holds a folder
   * [constant NOT_SEARCHED_SETTING] names replaced by the suites found in it, for a runner that
   * searches directories itself.
   */
  searchedAsTold(paths: readonly string[]): string[] {
    return [
      ...new Set(
        paths.flatMap((path) => {
          const root = path.replace(/\/+$/, '');
          return path.endsWith('.gd') ||
            !this.notSearched.some((folder) => folder.startsWith(`${root}/`) && !within(root, folder))
            ? [path]
            : this.suitesUnder([root]).map((suite) => suite.path);
        }),
      ),
    ];
  }
}

/** What one suite cost the last time it ran: the whole of it, and each case. */
export interface SuiteTime {
  /** Its cases and its hooks together, as it costs when it runs whole. */
  readonly seconds: number;
  /** Each case function's own time, the rows of a parameterised one together. */
  readonly cases: Readonly<Record<string, number>>;
  /**
   * Each row's own time, by its index, for a parameterised case whose rows a run printed: what a
   * case too slow for one engine is dealt out by.
   */
  readonly rows?: Readonly<Record<string, readonly number[]>>;
}

export type SuiteTimes = Readonly<Record<string, SuiteTime>>;

/** The times kept in [param file], or none when it is missing or unreadable. */
export function readTimes(file: string): SuiteTimes {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as SuiteTimes) : {};
  } catch {
    return {};
  }
}

/**
 * Writes [param value] as JSON to [param file] whole, since another game's tools read these files
 * while a run writes them. A write a reader held off leaves the earlier file, which only costs a
 * plan made from older times.
 */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeWhole(file, `${JSON.stringify(value, null, 1)}\n`);
}

/**
 * [param times] with what [param runs] measured of [param suites] put in, and with what [param now]
 * no longer finds left out: a suite deleted or renamed, and a case its suite no longer declares.
 * Nothing else took them out, so a project's file held 1709 suites for its 147, and a renamed suite
 * went on being named among the slowest by whatever read the file.
 */
export function timesAfter(
  times: SuiteTimes,
  suites: readonly DeclaredSuite[],
  runs: readonly RunPrinted[],
  now: (path: string) => DeclaredSuite | null,
  cutShort: ReadonlySet<string> = new Set(),
): Record<string, SuiteTime> {
  const next: Record<string, SuiteTime> = {};
  for (const [path, time] of Object.entries(times)) {
    const suite = now(path);
    if (suite === null) {
      continue;
    }
    const cases = Object.fromEntries(
      Object.entries(time.cases).filter(([func]) => suite.cases.includes(func)),
    );
    const dropped = Object.entries(time.cases)
      .filter(([func]) => !(func in cases))
      .reduce((sum, [, seconds]) => sum + seconds, 0);
    const rows = Object.fromEntries(
      Object.entries(time.rows ?? {}).filter(([func]) => suite.cases.includes(func)),
    );
    next[path] = {
      seconds: round(Math.max(0, time.seconds - dropped)),
      cases,
      ...(Object.keys(rows).length > 0 ? { rows } : {}),
    };
  }
  const declared = new Map(suites.map((suite) => [suite.path, suite]));
  const measured = new Map<
    string,
    { cases: Map<string, number>; rows: Map<string, Map<number, number>>; around: number }
  >();
  for (const run of runs) {
    for (const printed of run.suites.values()) {
      if (printed.closed === null || !declared.has(printed.path)) {
        continue;
      }
      const entry = measured.get(printed.path) ?? {
        cases: new Map<string, number>(),
        rows: new Map<string, Map<number, number>>(),
        around: 0,
      };
      const own = new Map<string, number>();
      for (const ran of printed.cases) {
        own.set(ran.func, (own.get(ran.func) ?? 0) + ran.seconds);
        if (ran.row !== null) {
          const rows = entry.rows.get(ran.func) ?? new Map<number, number>();
          rows.set(ran.row, ran.seconds);
          entry.rows.set(ran.func, rows);
        }
      }
      const inCases = [...own.values()].reduce((sum, seconds) => sum + seconds, 0);
      entry.around = Math.max(entry.around, printed.closed.seconds - inCases);
      // Added rather than set: a case dealt by its rows ran some of them in each of several engines.
      for (const [func, seconds] of own) {
        entry.cases.set(func, (entry.cases.get(func) ?? 0) + seconds);
      }
      measured.set(printed.path, entry);
    }
  }
  for (const [path, entry] of measured) {
    const suite = declared.get(path);
    const cases: Record<string, number> = {};
    const rows: Record<string, number[]> = {};
    for (const func of suite?.cases ?? []) {
      const measuredRows = entry.rows.get(func);
      const keptRows =
        measuredRows === undefined
          ? times[path]?.rows?.[func]
          : rowsAfter(times[path]?.rows?.[func], measuredRows, cutShort.has(`${path}:${func}`));
      if (keptRows !== undefined) {
        rows[func] = keptRows.map(round);
      }
      const seconds =
        measuredRows === undefined || keptRows === undefined
          ? (entry.cases.get(func) ?? times[path]?.cases[func])
          : keptRows.reduce((sum, row) => sum + row, 0);
      if (seconds !== undefined) {
        cases[func] = round(seconds);
      }
    }
    const inCases = Object.values(cases).reduce((sum, seconds) => sum + seconds, 0);
    next[path] = {
      seconds: round(entry.around + inCases),
      cases,
      ...(Object.keys(rows).length > 0 ? { rows } : {}),
    };
  }
  return next;
}

/**
 * A case's row times after a run that printed [param measured] of its rows. Every row from 0 up,
 * with each engine holding the case having finished it, is the case as it is now, whatever it had
 * before. When [param cutShort], an engine holding some of its rows having stopped before the end,
 * the rows printed replace their old times and the rest keep theirs: the rows that engine never
 * reached may be the last ones, which the printed rows alone cannot tell from a case that shrank.
 */
function rowsAfter(
  before: readonly number[] | undefined,
  measured: ReadonlyMap<number, number>,
  cutShort: boolean,
): number[] {
  const count = Math.max(...measured.keys()) + 1;
  const whole = !cutShort && measured.size === count;
  const length = whole ? count : Math.max(count, before?.length ?? 0);
  return Array.from({ length }, (_, row) => measured.get(row) ?? before?.[row] ?? 0);
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

/** What a case nobody has timed is taken to cost when nothing has been timed at all. */
const UNTIMED_CASE = 0.02;
/** A suite costing more than this is dealt out case by case, so one slow suite cannot set the run's length. */
export const SPLIT_PAST_SECONDS = 10;

/**
 * About what starting an engine and loading gdUnit4 costs before its first case: an engine more is
 * worth it only for at least this much work, so a run of a few quick suites stays in one.
 */
const ENGINE_START_SECONDS = 5;

/** Some of one suite's cases, dealt to an engine together. */
export interface Unit {
  readonly suite: string;
  readonly cases: readonly string[];
  /**
   * For one row of a parameterised case, the only case in [member cases]: which row, and whether
   * this is its last known row, whose engine also takes every row the case has grown since.
   */
  readonly row?: { readonly index: number; readonly rest: boolean };
  readonly cost: number;
  /** Whether every case in it has a time of its own, rather than [member cost] being a guess. */
  readonly timed: boolean;
  readonly windowed: boolean;
  readonly headless: boolean;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * [param suites] as units: each suite whole, or case by case when it costs more than
 * [param splitPast] seconds and has more than one case, and a parameterised case costing more than
 * that row by row, once a run has printed its rows. A single case of 110 to 400 s otherwise set
 * the length of a whole run, however many engines it had. A suite needing a window stays whole,
 * since all of those go to the one windowed engine anyway.
 */
export function unitsOf(
  suites: readonly DeclaredSuite[],
  times: SuiteTimes,
  splitPast = SPLIT_PAST_SECONDS,
): Unit[] {
  const known = Object.values(times);
  const caseCost = median(known.flatMap((time) => Object.values(time.cases))) ?? UNTIMED_CASE;
  const aroundCost =
    median(known.map((time) => time.seconds - Object.values(time.cases).reduce((sum, s) => sum + s, 0))) ?? 0;
  return suites.flatMap((suite) => {
    const time = times[suite.path];
    const costOf = (func: string): number => time?.cases[func] ?? caseCost;
    const timedCase = (func: string): boolean => time?.cases[func] !== undefined;
    const around =
      time === undefined
        ? aroundCost
        : Math.max(0, time.seconds - Object.values(time.cases).reduce((sum, s) => sum + s, 0));
    const whole = around + suite.cases.reduce((sum, func) => sum + costOf(func), 0);
    const wholly: Unit = {
      suite: suite.path,
      cases: suite.cases,
      cost: whole,
      timed: suite.cases.every(timedCase),
      windowed: suite.windowed,
      headless: suite.headless,
    };
    if (suite.windowed || whole <= splitPast) {
      return [wholly];
    }
    const units = suite.cases.flatMap((func): Unit[] => {
      const rows = time?.rows?.[func] ?? [];
      if (rows.length < 2 || around + costOf(func) <= splitPast) {
        return [
          {
            suite: suite.path,
            cases: [func],
            cost: around + costOf(func),
            timed: timedCase(func),
            windowed: false,
            headless: suite.headless,
          },
        ];
      }
      return rows.map((seconds, index) => ({
        suite: suite.path,
        cases: [func],
        row: { index, rest: index === rows.length - 1 },
        cost: around + seconds,
        timed: true,
        windowed: false,
        headless: suite.headless,
      }));
    });
    return units.length < 2 ? [wholly] : units;
  });
}

/** What one engine is handed. */
export interface EnginePlan {
  readonly suites: readonly HandedSuite[];
  /** `res://suite.gd:test_case` for each case of a suite it holds part of that it is not to run. */
  readonly skipping: readonly string[];
  readonly cost: number;
  readonly windowed: boolean;
  /**
   * The slot it runs in. The engines of one lane run one after another without giving the slot
   * back, which is how a headless engine follows the windowed one.
   */
  readonly lane: number;
}

/** Every case function of each suite, by path, which the cases an engine leaves out are read against. */
export type CasesBySuite = ReadonlyMap<string, readonly string[]>;

/**
 * [param units] dealt to at most [param most] lanes, slowest first, each to the lane with least so
 * far, and no more lanes than it takes to keep each one busy for as long as the slowest unit takes.
 * The windowed units all go to one windowed engine holding nothing else: a suite dealt there meets
 * the machine's display, its keyboard layout and screen among it, and runs about a tenth slower for
 * drawing frames. A headless engine follows it in its lane, dealt as though it began when the
 * windowed one ends, so the slot never sits idle once the windowed suites are done.
 *
 * A headless unit with no time of its own adds a lane: what it costs is a guess at the project's
 * median case, and a suite just split out of a slow one or a project's first run is anything but.
 * Priced at the guess, three suites of 80 s each, two of them new, went to one engine of the three
 * asked for.
 */
export function dealt(units: readonly Unit[], declared: CasesBySuite, most: number): EnginePlan[] {
  if (units.length === 0) {
    return [];
  }
  const windowed = units.filter((unit) => unit.windowed);
  const headless = units.filter((unit) => !unit.windowed).sort(slowestFirst);
  // The windowed units stay together, so for the count they are one unit as slow as all of them.
  const together = windowed.reduce((sum, unit) => sum + unit.cost, 0);
  // A headless engine following them in their lane starts afresh.
  const restart = windowed.length > 0 ? ENGINE_START_SECONDS : 0;
  const total = units.reduce((sum, unit) => sum + unit.cost, 0);
  const slowest = Math.max(together, headless[0]?.cost ?? 0);
  const count = Math.max(
    1,
    Math.min(
      most,
      headless.length + (windowed.length > 0 ? 1 : 0),
      Math.ceil(total / Math.max(slowest, ENGINE_START_SECONDS)) +
        headless.filter((unit) => !unit.timed).length,
    ),
  );
  const bins: Unit[][] = Array.from({ length: count }, () => []);
  const loads = Array.from({ length: count }, (_, lane) => (lane === 0 ? together + restart : 0));
  for (const unit of headless) {
    const lightest = loads.indexOf(Math.min(...loads));
    bins[lightest]?.push(unit);
    loads[lightest] = (loads[lightest] ?? 0) + unit.cost;
  }
  return [
    ...(windowed.length > 0 ? [planOf(windowed, declared, true, 0, units)] : []),
    ...bins.flatMap((bin, lane) => (bin.length === 0 ? [] : [planOf(bin, declared, false, lane, units)])),
  ];
}

/** Slowest first, a tie in cost going to the suite first by path, then by case and row. */
function slowestFirst(a: Unit, b: Unit): number {
  return (
    b.cost - a.cost ||
    a.suite.localeCompare(b.suite) ||
    (a.cases[0] ?? '').localeCompare(b.cases[0] ?? '') ||
    (a.row?.index ?? 0) - (b.row?.index ?? 0)
  );
}

/**
 * The least work a share holds, while there is that much left: a share is an engine started, which
 * costs about [constant ENGINE_START_SECONDS] before its first case.
 */
const SHARE_FLOOR_SECONDS = 6 * ENGINE_START_SECONDS;

/**
 * [param units] handed out a share at a time, to lanes that start at different moments.
 *
 * Dealt once, every lane is handed its part at the start, which is right when every lane starts then
 * and leaves nothing for a lane whose slot comes free later. Measured on a gate whose export takes
 * one of three slots for about 121 s: the engine starting once the export ends runs its third of the
 * suites from there, and the run ends as late as running the suites after the export. Here each
 * lane, as it starts or finishes an engine, is handed a share of what is left: the windowed units
 * first and whole, then the slowest headless units up to [param lanes] parts of what is left, never
 * less than [constant SHARE_FLOOR_SECONDS] while that much remains. The shares shrink as the work
 * runs out, so the lanes end close together however late each began.
 */
export class Shares {
  private windowed: readonly Unit[];
  private headless: readonly Unit[];
  private readonly declared: CasesBySuite;
  private readonly all: readonly Unit[];
  private readonly lanes: number;

  constructor(units: readonly Unit[], declared: CasesBySuite, lanes: number) {
    this.windowed = units.filter((unit) => unit.windowed);
    this.headless = units.filter((unit) => !unit.windowed).sort(slowestFirst);
    this.declared = declared;
    this.all = units;
    this.lanes = Math.max(1, lanes);
  }

  /** Whether every unit has been handed out. */
  get empty(): boolean {
    return this.windowed.length === 0 && this.headless.length === 0;
  }

  /** The next share, for an engine in [param lane], or null when nothing is left. */
  next(lane: number): EnginePlan | null {
    if (this.windowed.length > 0) {
      const windowed = this.windowed;
      this.windowed = [];
      return planOf(windowed, this.declared, true, lane, this.all);
    }
    if (this.headless.length === 0) {
      return null;
    }
    const left = this.headless.reduce((sum, unit) => sum + unit.cost, 0);
    const target = Math.max(SHARE_FLOOR_SECONDS, left / this.lanes);
    const share: Unit[] = [];
    const rest: Unit[] = [];
    let cost = 0;
    for (const unit of this.headless) {
      if (share.length === 0 || cost + unit.cost <= target) {
        share.push(unit);
        cost += unit.cost;
      } else {
        rest.push(unit);
      }
    }
    this.headless = rest;
    return planOf(share, this.declared, false, lane, this.all);
  }
}

/** How many slots [param plans] take at once: one a lane. */
export function lanesOf(plans: readonly EnginePlan[]): number {
  return new Set(plans.map((plan) => plan.lane)).size;
}

/** What the line announcing a run says of its window, after the number of engines. */
export function windowedSaid(plans: readonly EnginePlan[]): string {
  if (!plans.some((plan) => plan.windowed)) {
    return '';
  }
  if (plans.length === 1) {
    return ', with a window';
  }
  const followed = plans.some((plan) => !plan.windowed && plan.lane === 0);
  return followed
    ? ', one of them windowed and followed in its slot by a headless one'
    : ', one of them windowed';
}

/**
 * The suites saying they run headless that a windowed engine holds, which happens only in an
 * ordered run, one engine, with a suite in it needing a window.
 */
export function headlessInAWindow(plans: readonly EnginePlan[], units: readonly Unit[]): string[] {
  const said = new Set(units.filter((unit) => unit.headless).map((unit) => unit.suite));
  return plans
    .filter((plan) => plan.windowed)
    .flatMap((plan) => plan.suites.map((suite) => suite.path))
    .filter((path) => said.has(path));
}

/** Every unit in one engine, in the order given. */
export function inOneEngine(units: readonly Unit[], declared: CasesBySuite): EnginePlan {
  return planOf(
    units,
    declared,
    units.some((unit) => unit.windowed),
    0,
    units,
  );
}

/**
 * The engine [param bin] makes, among [param all] the units dealt. Of a case dealt by its rows it
 * runs only the rows it holds, unless it holds the case's last known row, when it runs every row
 * the other engines were not dealt: a row the case has grown since then runs there, and once.
 */
function planOf(
  bin: readonly Unit[],
  declared: CasesBySuite,
  windowed: boolean,
  lane: number,
  all: readonly Unit[],
): EnginePlan {
  const held = new Map<string, string[]>();
  for (const unit of bin) {
    // A case dealt by its rows comes in a unit a row, and is one case.
    const cases = held.get(unit.suite) ?? [];
    held.set(unit.suite, [...cases, ...unit.cases.filter((func) => !cases.includes(func))]);
  }
  const skipping = [...held].flatMap(([path, cases]) =>
    (declared.get(path) ?? []).filter((func) => !cases.includes(func)).map((func) => `${path}:${func}`),
  );
  const rowsOf = (units: readonly Unit[], path: string, func: string): number[] =>
    units.flatMap((unit) =>
      unit.suite === path && unit.cases[0] === func && unit.row !== undefined ? [unit.row.index] : [],
    );
  const sharesOf = (path: string, cases: readonly string[]): Record<string, RowShare> => {
    const shares: Record<string, RowShare> = {};
    for (const func of cases) {
      const mine = rowsOf(bin, path, func);
      const dealtOut = rowsOf(all, path, func);
      if (mine.length === 0 || mine.length === dealtOut.length) {
        continue;
      }
      const rest = bin.some(
        (unit) => unit.suite === path && unit.cases[0] === func && unit.row?.rest === true,
      );
      shares[func] = rest
        ? { besides: dealtOut.filter((row) => !mine.includes(row)) }
        : { only: mine.sort((a, b) => a - b) };
    }
    return shares;
  };
  return {
    suites: [...held].map(([path, cases]) => {
      const rows = sharesOf(path, cases);
      return { path, cases: [...cases].sort(), ...(Object.keys(rows).length > 0 ? { rows } : {}) };
    }),
    skipping,
    cost: bin.reduce((sum, unit) => sum + unit.cost, 0),
    windowed,
    lane,
  };
}

/**
 * The suites under [param paths], files or directories as `res://` paths, that gdharness test deals
 * to its windowed engine, and those among them saying they run headless, each sorted by path.
 */
export function windowNeedsOf(
  scripts: ProjectScripts,
  paths: readonly string[],
): { readonly needing: string[]; readonly headless: string[] } {
  const suites = new Map(
    paths
      .flatMap((path) => (path.endsWith('.gd') ? (scripts.suite(path) ?? []) : scripts.suitesUnder([path])))
      .map((suite) => [suite.path, suite]),
  );
  const sorted = [...suites.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    needing: sorted.filter((suite) => suite.windowed).map((suite) => suite.path),
    headless: sorted.filter((suite) => suite.headless).map((suite) => suite.path),
  };
}

/** The window size a project asks for, from its viewport settings, or null for Godot's own default. */
export function viewportOf(projectPath: string): { width: number; height: number } | null {
  const file = `${projectPath}/project.godot`;
  if (!existsSync(file)) {
    return null;
  }
  const text = readFileSync(file, 'utf8');
  const width = /^window\/size\/viewport_width\s*=\s*(\d+)/m.exec(text)?.[1];
  const height = /^window\/size\/viewport_height\s*=\s*(\d+)/m.exec(text)?.[1];
  return width === undefined || height === undefined
    ? null
    : { width: Number(width), height: Number(height) };
}
