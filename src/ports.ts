/**
 * Ports that can be moved, read from the environment or taken from the machine.
 *
 * Every port here belongs to something outside this process: the bridge the editor addon dials,
 * the language server the editor serves, the debug adapter behind it. Godot lets a user move the
 * last two in its editor settings and takes them on its own command line, so a server that can
 * only ever talk to the default is one that stops working the moment somebody does.
 */

import { createServer } from 'node:net';
import { Refusal } from './errors.js';

/**
 * The port in this variable, or null when nothing set it.
 *
 * A default and a choice are different facts, and a caller that cannot tell them apart cannot
 * follow the editor it is connected to without overriding somebody who named a port on purpose.
 *
 * A value that is not a port throws rather than falling back: it is a configuration to fix, and
 * quietly using the default instead would leave the server talking to the wrong place, or to
 * nothing, while reporting that whatever it wanted was unavailable.
 */
export function portFromEnvOrNull(variable: string): number | null {
  const raw = process.env[variable]?.trim();
  if (!raw) {
    return null;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535 || String(parsed) !== raw) {
    throw new Refusal(`${variable} is "${raw}", not a port between 1 and 65535.`);
  }
  return parsed;
}

/** The port in this variable, or the fallback when it is unset. */
export function portFromEnv(variable: string, fallback: number): number {
  return portFromEnvOrNull(variable) ?? fallback;
}

/**
 * A port nothing is listening on, the one asked for whenever that one is free.
 *
 * Godot keeps the language server and the debug adapter on one port each, in editor settings that
 * are shared by every editor on the machine, so two editors open at once both want the same two
 * and the second binds neither. Every script and debug tool in the session behind it is then
 * answered by the first editor, about a different project, which is worse than not answering.
 *
 * The one asked for is kept whenever it is free, because an external client configured by hand
 * looks for the default and a machine with one editor on it should be the case that never moves.
 *
 * Asked by binding rather than by reading a list, since a port is free only if it can be taken.
 * Nothing holds it between here and the editor starting, which is a race with no better answer:
 * the alternative is the editor binding a port this server never learns.
 */
export async function freePort(preferred: number, host = '127.0.0.1'): Promise<number> {
  const asked = await bindable(preferred, host);
  if (asked !== null) {
    return asked;
  }
  const spare = await bindable(0, host);
  if (spare === null) {
    throw new Refusal(`No port could be bound on ${host}.`);
  }
  return spare;
}

/** The port that was bound and then let go, or null when it could not be taken. */
function bindable(port: number, host: string): Promise<number | null> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => {
      resolve(null);
    });
    probe.once('listening', () => {
      const bound = probe.address();
      const taken = typeof bound === 'object' && bound !== null ? bound.port : port;
      probe.close(() => {
        resolve(taken);
      });
    });
    probe.listen(port, host);
  });
}
