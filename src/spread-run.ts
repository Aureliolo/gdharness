/**
 * `gdharness spread`: a bench's runs played by several engines at once, and gathered back whole.
 *
 * The bench is a scene whose arms ask GdhShare (addons/gdharness_tests/share.gd) for their
 * outcomes. Each worker engine plays every Nth run of every arm and leaves what each run answered.
 * Once every worker has played its whole share, one more engine runs the scene to gather, and that
 * engine's output, the bench's table, is printed. A worker that failed, played a share other than
 * its own, or went another way through the arms than the rest fails the run before anything is
 * gathered, since a table over some of the runs reads like a table over all of them. Every engine
 * holds one of the machine's engine slots, as `gdharness test`'s do. docs/spread.md describes it
 * for the games.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import {
  CONTROL_SEQUENCE,
  coresNamed,
  type EngineLaunch,
  EngineUsageError,
  godotNamed,
  inTurns,
  KEPT_RUN_DIRECTORIES,
  memoryAvailable,
  plural,
  resPathOf,
  roomFor,
  SILENCE_FLOOR_SECONDS,
  sweepRunDirectories,
  versionNamed,
  watchedEngine,
  wholeFlag,
} from './engine-launch.js';
import { EngineSlots, machineSlots, ownStart } from './engine-slots.js';
import { readLog } from './log-read.js';
import { isRecord } from './records.js';
import { SHARE_SCRIPT } from './setup.js';
import { type EngineEnd, exitNamed, readRun, versionFault } from './suite-judge.js';

/** The user arguments GdhShare reads, kept in step with its constants. */
const SHARE = '--gdh-share=';
const GATHER = '--gdh-share-gather=';
const INTO = '--gdh-share-dir=';
/** What a worker prints as it plays, `<arm> <played> of <share> runs`. */
const PROGRESS = /^gdharness share: (.+) (\d+) of (\d+) runs$/gm;
/** How often a run says how far its workers have got, between the lines saying one has finished. */
const PROGRESS_EVERY_MS = 60_000;
/** The least exit code that is a Windows exception status, read unsigned. */
const WINDOWS_EXCEPTION = 0xc0000000;

const VALUED = new Set([
  '--workers',
  '--slots',
  '--slot-count',
  '--silence',
  '--deadline',
  '--godot',
  '--godot-version',
  '--cores',
]);

export interface SpreadOptions {
  readonly projectPath: string;
  /** The bench's scene, as a `res://` path. */
  readonly scene: string;
  /** How many workers, or null for as many as the machine has room for. */
  readonly workers: number | null;
  readonly slotsDirectory: string | null;
  readonly slotCount: number | null;
  readonly silenceSeconds: number;
  readonly deadlineSeconds: number | null;
  readonly godotPath: string | null;
  readonly godotVersion: string | null;
  readonly cores: number | null;
  /** What follows `--`, handed to every engine of the run as the bench's own arguments. */
  readonly benchArguments: readonly string[];
}

/** One arm as a worker's line says it played it. */
export interface ArmPlayed {
  readonly arm: string;
  readonly runs: number;
  readonly played: number;
}

/** [param args], everything after `spread`, read into options. Relative paths are read from [param cwd]. */
export function spreadOptionsOf(args: readonly string[], cwd: string): SpreadOptions {
  const dashes = args.indexOf('--');
  const own = dashes === -1 ? args : args.slice(0, dashes);
  const valued = new Map<string, string>();
  const positional: string[] = [];
  for (let at = 0; at < own.length; at += 1) {
    const arg = own[at] ?? '';
    if (!arg.startsWith('--')) {
      positional.push(arg);
    } else if (VALUED.has(arg)) {
      const value = own[at + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new EngineUsageError(`${arg} needs a value.`);
      }
      valued.set(arg, value);
      at += 1;
    } else {
      throw new EngineUsageError(`Unknown option ${arg} for gdharness spread. Run gdharness help.`);
    }
  }
  const first = positional[0];
  const named = first === undefined ? null : resolve(cwd, first);
  const projectNamed = named !== null && existsSync(join(named, 'project.godot'));
  const projectPath = projectNamed ? named : resolve(cwd);
  if (!existsSync(join(projectPath, 'project.godot'))) {
    throw new EngineUsageError(`Not a Godot project: ${projectPath} holds no project.godot.`);
  }
  const scenes = positional.slice(projectNamed ? 1 : 0);
  if (scenes.length !== 1) {
    throw new EngineUsageError(
      scenes.length === 0
        ? 'gdharness spread needs the scene of the bench to play.'
        : `gdharness spread plays one scene, and was given ${String(scenes.length)}: ${scenes.join(', ')}.`,
    );
  }
  const scene = resPathOf(scenes[0] ?? '', projectPath, cwd);
  if (!existsSync(join(projectPath, scene.slice('res://'.length)))) {
    throw new EngineUsageError(`Nothing at ${scene} in the project at ${projectPath}.`);
  }
  const benchArguments = dashes === -1 ? [] : args.slice(dashes + 1);
  const ours = benchArguments.find((arg) => arg.startsWith('--gdh-share'));
  if (ours !== undefined) {
    throw new EngineUsageError(
      `${ours} is gdharness spread's own to hand each engine, so it cannot be given.`,
    );
  }
  return {
    projectPath,
    scene,
    workers: wholeFlag(valued.get('--workers'), '--workers'),
    slotsDirectory: valued.has('--slots') ? resolve(cwd, valued.get('--slots') ?? '') : null,
    slotCount: wholeFlag(valued.get('--slot-count'), '--slot-count'),
    silenceSeconds: wholeFlag(valued.get('--silence'), '--silence') ?? SILENCE_FLOOR_SECONDS,
    deadlineSeconds: wholeFlag(valued.get('--deadline'), '--deadline'),
    godotPath: godotNamed(valued.get('--godot'), cwd),
    godotVersion: versionNamed(valued.get('--godot-version')),
    cores: coresNamed(valued.get('--cores')),
    benchArguments,
  };
}

/** The arms a worker's [param text], one JSON line each, says it played. Null for a line it cannot read. */
export function armsPlayed(text: string): ArmPlayed[] | null {
  const arms: ArmPlayed[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      const { arm, runs, played }: Record<string, unknown> = isRecord(parsed) ? parsed : {};
      if (
        typeof arm !== 'string' ||
        typeof runs !== 'number' ||
        !Number.isInteger(runs) ||
        typeof played !== 'number' ||
        !Number.isInteger(played)
      ) {
        return null;
      }
      arms.push({ arm, runs, played });
    } catch {
      return null;
    }
  }
  return arms;
}

/** How many of [param runs] runs the worker at [param index] of [param workers] plays. */
export function shareOf(runs: number, index: number, workers: number): number {
  return index >= runs ? 0 : Math.ceil((runs - index) / workers);
}

/**
 * What is wrong with the arms each worker says it played, [param played] in worker order: a worker
 * that played no arm, played a share other than its own, or went another way through the arms than
 * worker 0. Empty when every worker played its own share of the same arms.
 */
export function shareFaults(played: ReadonlyArray<readonly ArmPlayed[] | null>): string[] {
  const faults: string[] = [];
  const workers = played.length;
  const shape = (arms: readonly ArmPlayed[]): string =>
    arms.map((arm) => `${arm.arm} (${plural(arm.runs, 'run')})`).join(', ');
  const first = played[0];
  for (const [index, arms] of played.entries()) {
    if (arms === null) {
      faults.push(`worker ${String(index)} left a line about its arms that cannot be read`);
      continue;
    }
    if (arms.length === 0) {
      faults.push(
        `worker ${String(index)} played no arm: the scene never asked GdhShare.outcomes for one, or quit before it did`,
      );
      continue;
    }
    for (const arm of arms) {
      const own = shareOf(arm.runs, index, workers);
      if (arm.played !== own) {
        faults.push(
          `worker ${String(index)} played ${String(arm.played)} of ${arm.arm}'s ${String(arm.runs)} runs, and its share is ${String(own)}`,
        );
      }
    }
    if (
      index > 0 &&
      first !== null &&
      first !== undefined &&
      first.length > 0 &&
      shape(arms) !== shape(first)
    ) {
      faults.push(
        `worker ${String(index)} played ${shape(arms)}, and worker 0 played ${shape(first)}: which arms a bench plays must depend on its command line alone`,
      );
    }
  }
  return faults;
}

/** What one engine of the run left behind. */
interface EngineLeft {
  readonly name: string;
  readonly log: string;
  readonly end: EngineEnd;
  readonly seconds: number;
}

/** Plays [param options]'s bench with the engine at [param godotPath]. Answers the exit code. */
export async function runSpreadCommand(options: SpreadOptions, godotPath: string): Promise<number> {
  if (!existsSync(join(options.projectPath, SHARE_SCRIPT))) {
    throw new EngineUsageError(
      `res://${SHARE_SCRIPT} is not in the project, so its bench cannot ask GdhShare for outcomes. Run gdharness setup.`,
    );
  }
  const startedAt = Date.now();
  const spreadRuns = join(options.projectPath, '.godot', 'gdharness', 'spread-runs');
  sweepRunDirectories(spreadRuns);
  const runDirectory = join(spreadRuns, `${String(startedAt)}-${String(process.pid)}`);
  const shareDirectory = join(runDirectory, 'share');
  mkdirSync(shareDirectory, { recursive: true });
  const chosen = machineSlots({ directory: options.slotsDirectory, count: options.slotCount });
  const slotCount = chosen.count;
  const slots = new EngineSlots(
    chosen.directory,
    slotCount,
    { pid: process.pid, started: await ownStart(), by: `gdharness spread of ${options.projectPath}` },
    (line) => {
      console.log(`[spread] ${line}`);
    },
  );
  const launch: EngineLaunch = {
    godotPath,
    projectPath: options.projectPath,
    deadlineSeconds: options.deadlineSeconds,
    running: new Set(),
    cores: options.cores,
  };
  const interrupted = (): void => {
    for (const end of launch.running) {
      end();
    }
    slots.releaseAll();
    process.exit(130);
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    let workers = options.workers;
    if (workers === null) {
      const memory = await memoryAvailable();
      const processors = options.cores ?? availableParallelism();
      const room = roomFor(slotCount, processors, memory.bytes, memory.said);
      workers = room.engines;
      console.log(
        `${options.scene} over ${plural(workers, 'worker')}${room.held === undefined ? '' : `, since ${room.held}`}.`,
      );
    } else {
      console.log(`${options.scene} over ${plural(workers, 'worker')}.`);
    }
    const engine = (name: string, share: string): Promise<EngineLeft> =>
      enginePlayed(launch, slots, options, runDirectory, name, [
        ...options.benchArguments,
        share,
        `${INTO}${shareDirectory}`,
      ]);
    const logs = Array.from({ length: workers }, (_, index) =>
      join(runDirectory, `worker-${String(index)}`, 'engine.log'),
    );
    let done = 0;
    const heartbeat = setInterval(() => {
      console.log(`[spread] ${progressOf(logs)}`);
    }, PROGRESS_EVERY_MS);
    let left: EngineLeft[];
    try {
      left = await inTurns(
        Array.from({ length: workers }, (_, index) => index),
        workers,
        async (index) => {
          const worker = await engine(
            `worker-${String(index)}`,
            `${SHARE}${String(index)}/${String(workers)}`,
          );
          done += 1;
          console.log(
            `[spread] ${String(done)} of ${plural(workers, 'worker')} done, worker ${String(index)} in ${worker.seconds.toFixed(1)} s`,
          );
          return worker;
        },
      );
    } finally {
      clearInterval(heartbeat);
    }
    const faults = left.flatMap((worker) => engineFaults(worker, options.godotVersion));
    const arms = left.map((_, index) => {
      const file = join(shareDirectory, `worker-${String(index)}.arms`);
      return existsSync(file) ? armsPlayed(readFileSync(file, 'utf8')) : [];
    });
    faults.push(...shareFaults(arms));
    if (faults.length > 0) {
      return failed(faults, left, runDirectory, 'so nothing was gathered');
    }
    const gather = await engine('gather', `${GATHER}${String(workers)}`);
    console.log(readLog(gather.log).replace(CONTROL_SEQUENCE, '').trimEnd());
    const gatherFaults = engineFaults(gather, options.godotVersion);
    const gatheredFile = join(shareDirectory, 'gathered.arms');
    const gathered = new Set(
      (existsSync(gatheredFile) ? (armsPlayed(readFileSync(gatheredFile, 'utf8')) ?? []) : []).map(
        (arm) => arm.arm,
      ),
    );
    const ungathered = (arms[0] ?? []).filter((arm) => !gathered.has(arm.arm)).map((arm) => arm.arm);
    if (ungathered.length > 0) {
      gatherFaults.push(
        `the gathering run never asked for ${ungathered.join(', ')}, which the workers played: it went another way through the arms than they did`,
      );
    }
    if (gatherFaults.length > 0) {
      return failed(gatherFaults, [gather], runDirectory, 'so the table above is not to be trusted');
    }
    const runs = (arms[0] ?? []).reduce((sum, arm) => sum + arm.runs, 0);
    const longest = Math.max(0, ...left.map((worker) => worker.seconds));
    console.log('');
    console.log(
      `Spread: ${plural(runs, 'run')} in ${plural((arms[0] ?? []).length, 'arm')} over ${plural(workers, 'worker')}, ${((Date.now() - startedAt) / 1000).toFixed(1)} s; the longest worker took ${longest.toFixed(1)} s.`,
    );
    rmSync(runDirectory, { recursive: true, force: true });
    return 0;
  } finally {
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
  }
}

/** One engine of the run, the scene with [param benchArguments], in a slot of its own. */
async function enginePlayed(
  launch: EngineLaunch,
  slots: EngineSlots,
  options: SpreadOptions,
  runDirectory: string,
  name: string,
  benchArguments: readonly string[],
): Promise<EngineLeft> {
  const directory = join(runDirectory, name);
  mkdirSync(join(directory, 'user'), { recursive: true });
  const log = join(directory, 'engine.log');
  const args = [
    '--headless',
    '--audio-driver',
    'Dummy',
    '--path',
    options.projectPath,
    options.scene,
    '--',
    ...benchArguments,
  ];
  const lock = await slots.take();
  const began = Date.now();
  try {
    const end = await watchedEngine(launch, lock, args, directory, log, options.silenceSeconds);
    return { name, log, end, seconds: (Date.now() - began) / 1000 };
  } finally {
    slots.release(lock);
  }
}

/** What is wrong with how [param engine] ended and what it printed, each naming the engine. */
function engineFaults(engine: EngineLeft, godotVersion: string | null): string[] {
  const faults: string[] = [];
  const { code, ended } = engine.end;
  if (ended !== null) {
    faults.push(`${engine.name}: ${ended}`);
  } else if (code !== 0) {
    const said =
      code === null
        ? 'without an exit code'
        : code >>> 0 >= WINDOWS_EXCEPTION
          ? exitNamed(code)
          : String(code);
    faults.push(`${engine.name}: the engine exited ${said}`);
  }
  if (!existsSync(engine.log)) {
    return faults;
  }
  const printed = readRun(readLog(engine.log));
  const wrongEngine = godotVersion === null ? null : versionFault(printed.engineVersion, godotVersion);
  if (wrongEngine !== null) {
    faults.push(`${engine.name}: ${wrongEngine}`);
  }
  const errors = printed.errors.filter((error) => !error.warning);
  if (errors.length > 0) {
    faults.push(
      `${engine.name}: it printed ${errors.length === 1 ? 'an engine error' : `${String(errors.length)} engine errors`}, the first ${JSON.stringify(errors[0]?.text ?? '')}`,
    );
  }
  return faults;
}

/** How far each worker whose log is at [param logs] has got, by the last progress line it printed. */
function progressOf(logs: readonly string[]): string {
  const each = logs.map((log, index) => {
    const text = existsSync(log) ? readLog(log) : '';
    const last = [...text.matchAll(PROGRESS)].at(-1);
    return last === undefined
      ? `worker ${String(index)} has played no arm yet`
      : `worker ${String(index)} at ${last[1] ?? ''} ${last[2] ?? ''} of ${last[3] ?? ''}`;
  });
  return `still playing: ${each.join(', ')}`;
}

function failed(
  faults: readonly string[],
  engines: readonly EngineLeft[],
  runDirectory: string,
  so: string,
): number {
  console.log('');
  console.log(`Failed, ${so}:`);
  for (const fault of faults) {
    console.log(`  ${fault}`);
  }
  for (const engine of engines) {
    console.log(`what ${engine.name} printed: ${engine.log}`);
  }
  console.log(
    `Every engine's output is kept under ${runDirectory} until ${String(KEPT_RUN_DIRECTORIES)} later runs have failed.`,
  );
  return 1;
}
