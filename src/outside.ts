/**
 * Starting a process outside the server's process tree.
 *
 * The harness ends a server by killing its process tree, which walks parent pids, at every
 * reconnect and every session end. `detached` keeps a child out of the server's job object on
 * Windows and out of its process group elsewhere, but the server is still its parent, so the walk
 * reached the editor `editor_launch` opened and the game `editor_run start` spawned, both of which
 * are meant to outlive the server. Measured on Windows: a detached child died with a `taskkill /T`
 * of its parent, and the same child started through a process that had already exited did not.
 *
 * So the server starts `keeper.js` as a launcher, which starts the target (or, for a run, a keeper
 * that holds the game) and exits as soon as it has the pid: nothing the server started is left for
 * the walk to follow.
 */

import process from 'node:process';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { isRecord, isStringList } from './records.js';
import { type ChildProcess, spawnHidden } from './spawn.js';

/** What to start, and for a run, where its output goes and how its record reads. */
export interface OutsideSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** The environment it starts with. Absent is the launcher's own, which is the server's. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly run?: {
    readonly transcript: string;
    readonly startedAt: number;
    readonly projectPath: string;
    /** The project the server that started the run serves, where it names one. */
    readonly servedBy?: string;
    /**
     * Where the keeper writes the run's script profile, when the run is profiled: the keeper is the
     * game's debugger then, since it outlives the server that started the run.
     */
    readonly profile?: string;
    /**
     * The breakpoints the game starts with, as `res://path:line`. The keeper is its debugger, for
     * the same reason it is a profiled run's.
     */
    readonly breakpoints?: readonly string[];
    /**
     * False for a game that must not be given the debugger's flags: a release export, which
     * refuses `--remote-debug` and quits ("compiled without debug. Aborting.").
     */
    readonly debugged?: boolean;
    /**
     * The engine slot the server took for the run, which the keeper takes over once the game has
     * started and gives back when the run ends, since the run outlives the server. [member from] is
     * the pid the lock names until then, and [member by] what the keeper's names it held for.
     */
    readonly slot?: { readonly lock: string; readonly from: number; readonly by: string };
  };
  /** A Windows desktop to start it on, where its windows neither show nor take the focus. */
  readonly desktop?: string;
  /** Windows: show its first window without activating it, so it takes nobody's keyboard. */
  readonly noActivate?: boolean;
}

/**
 * What crosses to the launcher and the keeper: the spec with its environment as the changes from
 * the server's own, null for a variable taken away.
 *
 * Only the changes, because each process down the line inherits the rest the ordinary way, and the
 * whole environment is the server's, API keys and harness tokens included. Over stdin rather than as
 * an argument, because a command line is readable by every process on the machine for as long as the
 * process lives, and the keeper lives as long as the run: the environment sat in one, whole.
 */
export interface SentSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly envChanges: Readonly<Record<string, string | null>>;
  readonly run?: OutsideSpec['run'];
  readonly desktop?: string;
  readonly noActivate?: boolean;
}

function changesFrom(env: OutsideSpec['env'], base: NodeJS.ProcessEnv): Record<string, string | null> {
  const changes: Record<string, string | null> = {};
  if (env === undefined) {
    return changes;
  }
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && base[name] !== value) {
      changes[name] = value;
    }
  }
  for (const name of Object.keys(base)) {
    if (env[name] === undefined) {
      changes[name] = null;
    }
  }
  return changes;
}

/** [param changes] applied over [param base], which is what the started process is given. */
export function withChanges(
  base: NodeJS.ProcessEnv,
  changes: Readonly<Record<string, string | null>>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }
  return env;
}

/** Hands [param spec] to [param child] down its stdin, which is then closed. */
export function sendSpec(child: ChildProcess, spec: SentSpec): void {
  child.stdin?.end(JSON.stringify(spec), 'utf8');
}

/** The spec handed down this process's stdin. */
export async function receivedSpec(): Promise<SentSpec> {
  const received = await text(process.stdin);
  const spec = sentSpecOf(JSON.parse(received));
  if (spec === null) {
    throw new Error(`What came down stdin is not a spec a server sends: ${received.slice(0, 200)}`);
  }
  return spec;
}

/** [param value] as the environment changes a spec carries, or null when it is not that. */
function envChangesOf(value: unknown): Record<string, string | null> | null {
  if (!isRecord(value)) {
    return null;
  }
  const changes: Record<string, string | null> = {};
  for (const [name, change] of Object.entries(value)) {
    if (typeof change !== 'string' && change !== null) {
      return null;
    }
    changes[name] = change;
  }
  return changes;
}

/** [param value] as the run part of a spec, or null when it is not that. */
function runOf(value: unknown): NonNullable<OutsideSpec['run']> | null {
  if (!isRecord(value)) {
    return null;
  }
  const { transcript, startedAt, projectPath, servedBy, profile, breakpoints, debugged, slot } = value;
  const held = slot === undefined ? undefined : slotOf(slot);
  if (
    typeof transcript !== 'string' ||
    typeof startedAt !== 'number' ||
    typeof projectPath !== 'string' ||
    (servedBy !== undefined && typeof servedBy !== 'string') ||
    (profile !== undefined && typeof profile !== 'string') ||
    (breakpoints !== undefined && !isStringList(breakpoints)) ||
    (debugged !== undefined && typeof debugged !== 'boolean') ||
    held === null
  ) {
    return null;
  }
  return {
    transcript,
    startedAt,
    projectPath,
    ...(servedBy === undefined ? {} : { servedBy }),
    ...(profile === undefined ? {} : { profile }),
    ...(breakpoints === undefined ? {} : { breakpoints }),
    ...(debugged === undefined ? {} : { debugged }),
    ...(held === undefined ? {} : { slot: held }),
  };
}

/** [param value] as the engine slot a run part hands over, or null when it is not that. */
function slotOf(
  value: unknown,
): { readonly lock: string; readonly from: number; readonly by: string } | null {
  const { lock, from, by }: Record<string, unknown> = isRecord(value) ? value : {};
  return typeof lock === 'string' && typeof from === 'number' && typeof by === 'string'
    ? { lock, from, by }
    : null;
}

/** [param value] as a spec, or null when any part of it is not the shape [method sendSpec] writes. */
function sentSpecOf(value: unknown): SentSpec | null {
  if (!isRecord(value)) {
    return null;
  }
  const { command, args, envChanges, run, desktop, noActivate } = value;
  const changes = envChangesOf(envChanges);
  const ran = run === undefined ? undefined : runOf(run);
  if (
    typeof command !== 'string' ||
    !isStringList(args) ||
    changes === null ||
    ran === null ||
    (desktop !== undefined && typeof desktop !== 'string') ||
    (noActivate !== undefined && typeof noActivate !== 'boolean')
  ) {
    return null;
  }
  return {
    command,
    args,
    envChanges: changes,
    ...(ran === undefined ? {} : { run: ran }),
    ...(desktop === undefined ? {} : { desktop }),
    ...(noActivate === undefined ? {} : { noActivate }),
  };
}

/** What the launcher handed back: the pid of what it started, or why it could not. */
export type Launched = { readonly pid: number } | { readonly error: string };

/** Beside the bundle that imports this, which is where the build puts it. */
export const KEEPER_SCRIPT = fileURLToPath(new URL('./keeper.js', import.meta.url));

/** The one line a launcher or a keeper hands back up: `pid N`, or `error` and why. */
export function readLaunched(printed: string): Launched {
  const line =
    printed
      .split('\n')
      .find((one) => one.trim() !== '')
      ?.trim() ?? '';
  const pid = /^pid (\d+)$/.exec(line);
  if (pid?.[1] !== undefined) {
    return { pid: Number(pid[1]) };
  }
  return { error: line.replace(/^error /, '') || 'the launcher said nothing' };
}

/**
 * Starts [param spec] outside the calling process's tree, and answers once it is running.
 *
 * [param runtime] is the interpreter the server runs under, which runs the keeper too, and
 * [param keeper] the script, for a caller that is not the bundle.
 */
export async function launchOutsideTheTree(
  spec: OutsideSpec,
  runtime = process.execPath,
  keeper = KEEPER_SCRIPT,
): Promise<Launched> {
  return await new Promise<Launched>((resolve) => {
    const launcher = spawnHidden(runtime, [keeper, 'launch'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    sendSpec(launcher, {
      command: spec.command,
      args: spec.args,
      envChanges: changesFrom(spec.env, process.env),
      ...(spec.run === undefined ? {} : { run: spec.run }),
      ...(spec.desktop === undefined ? {} : { desktop: spec.desktop }),
      ...(spec.noActivate === true ? { noActivate: true } : {}),
    });
    let printed = '';
    let complained = '';
    launcher.stdout.on('data', (chunk: Buffer) => {
      printed += chunk.toString();
    });
    launcher.stderr.on('data', (chunk: Buffer) => {
      complained += chunk.toString();
    });
    launcher.once('error', (error: Error) => {
      resolve({ error: `the launcher did not start: ${error.message}` });
    });
    launcher.once('close', () => {
      const launched = readLaunched(printed);
      resolve(
        'error' in launched && complained.trim() !== ''
          ? { error: `${launched.error}: ${complained.trim()}` }
          : launched,
      );
    });
  });
}
