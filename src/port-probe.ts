/**
 * Whether the editor's language server and debug adapter are listening, asked of the ports rather
 * than taken from what the editor says it serves.
 *
 * The editor reports the ports it was told to use, and Godot binds each once, as the editor starts,
 * reporting a failure only to the editor's own log panel (`DebugAdapterServer::start` in the
 * engine's editor sources), never to stdout. A restarted editor
 * came back with its language server up and nothing on its debug adapter port, and every answer
 * still named the port.
 */

import { connect } from 'node:net';

/**
 * Whether something on this machine accepts a connection on [param port], or null when it neither
 * accepted nor refused within [param withinMs]. On loopback the kernel accepts for a listener before
 * the program does, so a listener answers at once however loaded the machine is, and a port with
 * nothing on it is refused at once.
 */
export function acceptsConnections(port: number, withinMs = 2000): Promise<boolean | null> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const settle = (answer: boolean | null): void => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(withinMs, () => {
      settle(null);
    });
    socket.once('connect', () => {
      settle(true);
    });
    socket.once('error', () => {
      settle(false);
    });
  });
}

/** One of the editor's servers: the port it names, and whether anything accepts connections there. */
export interface ServedPort {
  readonly port: number;
  readonly listening: boolean | null;
}

/** How long after its greeting an editor may still be starting its servers. */
const STARTING_MS = 20_000;

/**
 * What a caller is told when the editor names a port that nothing accepts connections on, or
 * undefined when both are listening or neither could be asked. [param greetedAgoMs] is how long ago
 * the editor greeted: its language server comes up a few seconds after that, so a young editor's
 * closed port may only be one still starting.
 */
export function notListeningNote(
  servers: { readonly lsp: ServedPort; readonly dap: ServedPort },
  greetedAgoMs: number | null,
): string | undefined {
  const down = [
    ...(servers.lsp.listening === false ? [{ name: 'language server', port: servers.lsp.port }] : []),
    ...(servers.dap.listening === false ? [{ name: 'debug adapter', port: servers.dap.port }] : []),
  ];
  if (down.length === 0) {
    return undefined;
  }
  const named = down.map((one) => `its ${one.name} on port ${one.port}`).join(' and ');
  const needs = down
    .map((one) =>
      one.name === 'debug adapter'
        ? 'played runs and the debug tools need the debug adapter'
        : 'diagnostics, symbols and renames need the language server',
    )
    .join(', and ');
  const starting =
    greetedAgoMs !== null && greetedAgoMs < STARTING_MS
      ? ` The editor greeted ${Math.round(greetedAgoMs / 1000)}s ago, so ${down.length === 1 ? 'it' : 'they'} may still be starting: ask again in a few seconds.`
      : '';
  return `The editor names ${named}, and nothing accepts connections there. Godot binds each once, as the editor starts, and reports a failure only in the editor's own log panel; ${needs}. editor_launch restart binds ${down.length === 1 ? 'it' : 'them'} again.${starting}`;
}
