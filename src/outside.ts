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

import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** What to start, and for a run, where its output goes and how its record reads. */
export interface OutsideSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** The environment it starts with; absent is the launcher's own, which is the server's. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly run?: {
    readonly transcript: string;
    readonly startedAt: number;
    readonly projectPath: string;
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
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as SentSpec;
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
    const launcher = spawn(runtime, [keeper, 'launch'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
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
