/**
 * Ports that can be moved, read from the environment.
 *
 * Every port here belongs to something outside this process: the bridge the editor addon dials,
 * the language server the editor serves, the debug adapter behind it. Godot lets a user move the
 * last two in its editor settings and takes them on its own command line, so a server that can
 * only ever talk to the default is one that stops working the moment somebody does.
 */

/**
 * The port in this variable, or the fallback when it is unset.
 *
 * A value that is not a port throws rather than falling back: it is a configuration to fix, and
 * quietly using the default instead would leave the server talking to the wrong place, or to
 * nothing, while reporting that whatever it wanted was unavailable.
 */
export function portFromEnv(variable: string, fallback: number): number {
  const raw = process.env[variable]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535 || String(parsed) !== raw) {
    throw new Error(`${variable} is "${raw}", not a port between 1 and 65535.`);
  }
  return parsed;
}
