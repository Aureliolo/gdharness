/**
 * Which suites a project has, what each case cost last time, and how they are dealt to engines.
 *
 * Read from the scripts on disk rather than asked of an engine, because the plan has to exist
 * before any engine starts, and because the case list read here is what each engine's run is held
 * to afterwards: a suite that stopped partway, or a case gdUnit4 never reached, shows up as a case
 * that was planned and never reported.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { declaredClassOf, eachScript } from './class-cache.js';
import { codeOf, shapeOf } from './gdscript-source.js';
import type { RunPrinted } from './suite-judge.js';
import { writeWhole } from './whole-file.js';

/** The class every gdUnit4 suite extends, by name. */
const SUITE_BASE = 'GdUnitTestSuite';
/** What a case's function is called, as gdUnit4 finds them: `get_script_method_list` and the prefix. */
const CASE_PREFIX = 'test_';
/** A suite saying it needs a real window, declared as a constant so the runner can read it too. */
const NEEDS_WINDOW = /^const\s+GDHARNESS_NEEDS_WINDOW\b[^=\n]*=\s*true\b/m;
/** Where suites are looked for when none are named, by gdharness test and project_test alike. */
export const TEST_DIRECTORIES = ['tests', 'test'];

/** gdUnit4's scene runner, whose input events go nowhere in a headless engine. */
const SCENE_RUNNER = /\bscene_runner\s*\(/;

export interface DeclaredSuite {
  readonly path: string;
  /** Its case functions, its own and those of the project's scripts it extends, sorted. */
  readonly cases: readonly string[];
  /** Whether it needs an engine with a window: it says so, or it drives a scene through gdUnit4. */
  readonly windowed: boolean;
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

  constructor(projectPath: string) {
    this.projectPath = projectPath;
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
    let windowed = false;
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
      windowed ||= NEEDS_WINDOW.test(read.code) || SCENE_RUNNER.test(read.code);
      const base = this.base(at);
      if (base === null) {
        return null;
      }
      // By name, or by the script declaring it: gdUnit4's own class is a global class of the project.
      if ('name' in base ? base.name === SUITE_BASE : base.path === this.classes.get(SUITE_BASE)) {
        return cases.size > 0 ? { path, cases: [...cases].sort(), windowed } : null;
      }
      if ('name' in base) {
        return null;
      }
      at = base.path;
    }
    return null;
  }

  /** Every suite under the directories [param roots] name, as `res://` paths, sorted by path. */
  suitesUnder(roots: readonly string[]): DeclaredSuite[] {
    const prefixes = roots.map((root) => (root.endsWith('/') ? root : `${root}/`));
    return [...this.sources.keys()]
      .filter((path) => prefixes.some((prefix) => path.startsWith(prefix)))
      .sort()
      .flatMap((path) => this.suite(path) ?? []);
  }
}

/** What one suite cost the last time it ran: the whole of it, and each case. */
export interface SuiteTime {
  /** Its cases and its hooks together, as it costs when it runs whole. */
  readonly seconds: number;
  /** Each case function's own time, the rows of a parameterised one together. */
  readonly cases: Readonly<Record<string, number>>;
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

/** [param times] with what [param runs] measured of [param suites] put in. */
export function timesAfter(
  times: SuiteTimes,
  suites: readonly DeclaredSuite[],
  runs: readonly RunPrinted[],
): Record<string, SuiteTime> {
  const next: Record<string, SuiteTime> = { ...times };
  const declared = new Map(suites.map((suite) => [suite.path, suite]));
  const measured = new Map<string, { cases: Map<string, number>; around: number }>();
  for (const run of runs) {
    for (const printed of run.suites.values()) {
      if (printed.closed === null || !declared.has(printed.path)) {
        continue;
      }
      const entry = measured.get(printed.path) ?? { cases: new Map<string, number>(), around: 0 };
      const own = new Map<string, number>();
      for (const ran of printed.cases) {
        own.set(ran.func, (own.get(ran.func) ?? 0) + ran.seconds);
      }
      const inCases = [...own.values()].reduce((sum, seconds) => sum + seconds, 0);
      entry.around = Math.max(entry.around, printed.closed.seconds - inCases);
      for (const [func, seconds] of own) {
        entry.cases.set(func, seconds);
      }
      measured.set(printed.path, entry);
    }
  }
  for (const [path, entry] of measured) {
    const suite = declared.get(path);
    const cases: Record<string, number> = {};
    for (const func of suite?.cases ?? []) {
      const seconds = entry.cases.get(func) ?? times[path]?.cases[func];
      if (seconds !== undefined) {
        cases[func] = round(seconds);
      }
    }
    const inCases = Object.values(cases).reduce((sum, seconds) => sum + seconds, 0);
    next[path] = { seconds: round(entry.around + inCases), cases };
  }
  return next;
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
  readonly cost: number;
  readonly windowed: boolean;
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
 * [param splitPast] seconds and has more than one case. A suite needing a window stays whole, since
 * all of those go to the one windowed engine anyway.
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
    const around =
      time === undefined
        ? aroundCost
        : Math.max(0, time.seconds - Object.values(time.cases).reduce((sum, s) => sum + s, 0));
    const whole = around + suite.cases.reduce((sum, func) => sum + costOf(func), 0);
    if (suite.windowed || whole <= splitPast || suite.cases.length < 2) {
      return [{ suite: suite.path, cases: suite.cases, cost: whole, windowed: suite.windowed }];
    }
    return suite.cases.map((func) => ({
      suite: suite.path,
      cases: [func],
      cost: around + costOf(func),
      windowed: false,
    }));
  });
}

/** What one engine is handed. */
export interface EnginePlan {
  readonly suites: ReadonlyArray<{ readonly path: string; readonly cases: readonly string[] }>;
  /** `res://suite.gd:test_case` for each case of a suite it holds part of that it is not to run. */
  readonly skipping: readonly string[];
  readonly cost: number;
  readonly windowed: boolean;
}

/** Every case function of each suite, by path, which the cases an engine leaves out are read against. */
export type CasesBySuite = ReadonlyMap<string, readonly string[]>;

/**
 * [param units] dealt to engines, slowest first, each to the engine with least so far: the windowed
 * ones to one engine of their own, the rest over at most [param most] engines, and no more of those
 * than it takes to keep each one busy for as long as the slowest unit takes.
 */
export function dealt(units: readonly Unit[], declared: CasesBySuite, most: number): EnginePlan[] {
  const windowed = units.filter((unit) => unit.windowed);
  const headless = units
    .filter((unit) => !unit.windowed)
    .sort(
      (a, b) =>
        b.cost - a.cost ||
        a.suite.localeCompare(b.suite) ||
        (a.cases[0] ?? '').localeCompare(b.cases[0] ?? ''),
    );
  const total = headless.reduce((sum, unit) => sum + unit.cost, 0);
  const slowest = headless[0]?.cost ?? 0;
  const room = Math.max(1, most - (windowed.length > 0 && most > 1 ? 1 : 0));
  const count =
    headless.length === 0
      ? 0
      : Math.max(
          1,
          Math.min(room, headless.length, Math.ceil(total / Math.max(slowest, ENGINE_START_SECONDS))),
        );
  const bins: Unit[][] = Array.from({ length: count }, () => []);
  const loads = Array.from({ length: count }, () => 0);
  for (const unit of headless) {
    const lightest = loads.indexOf(Math.min(...loads));
    bins[lightest]?.push(unit);
    loads[lightest] = (loads[lightest] ?? 0) + unit.cost;
  }
  const plans = bins.map((bin) => planOf(bin, declared, false));
  return windowed.length > 0 ? [planOf(windowed, declared, true), ...plans] : plans;
}

/** Every unit in one engine, in the order given. */
export function inOneEngine(units: readonly Unit[], declared: CasesBySuite): EnginePlan {
  return planOf(
    units,
    declared,
    units.some((unit) => unit.windowed),
  );
}

function planOf(bin: readonly Unit[], declared: CasesBySuite, windowed: boolean): EnginePlan {
  const held = new Map<string, string[]>();
  for (const unit of bin) {
    held.set(unit.suite, [...(held.get(unit.suite) ?? []), ...unit.cases]);
  }
  const skipping = [...held].flatMap(([path, cases]) =>
    (declared.get(path) ?? []).filter((func) => !cases.includes(func)).map((func) => `${path}:${func}`),
  );
  return {
    suites: [...held].map(([path, cases]) => ({ path, cases: [...cases].sort() })),
    skipping,
    cost: bin.reduce((sum, unit) => sum + unit.cost, 0),
    windowed,
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
