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

import { spawn } from 'node:child_process';
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
}

/** What the launcher handed back: the pid of what it started, or why it could not. */
export type Launched = { readonly pid: number } | { readonly error: string };

/** Beside the bundle that imports this, which is where the build puts it. */
export const KEEPER_SCRIPT = fileURLToPath(new URL('./keeper.js', import.meta.url));

/**
 * The spec as one argument. JSON in base64url, so no quoting rule of any shell or platform can bend
 * it on the way through a command line.
 */
function encodeSpec(spec: OutsideSpec): string {
  return Buffer.from(JSON.stringify(spec), 'utf8').toString('base64url');
}

export function decodeSpec(encoded: string): OutsideSpec {
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as OutsideSpec;
}

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
    const launcher = spawn(runtime, [keeper, 'launch', encodeSpec(spec)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
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
