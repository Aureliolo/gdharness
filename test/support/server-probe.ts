/**
 * Starts a server in this process, drives one of its private calls and prints what it answered as
 * one line of JSON. The server takes process-wide handlers as it is made, so a case that needs one
 * runs here, in a process of its own.
 *
 * Usage: `bun server-probe.ts lost-connection | port-move`
 */

import { createServer, type Server, type Socket } from 'node:net';
import { FrameReader, frame } from '../../src/framing.js';
import { EditorDisconnected } from '../../src/godot-bridge.js';
import { GodotServer } from '../../src/server.js';

function privateCall(server: GodotServer, name: string, args: unknown[]): unknown {
  const call: unknown = Reflect.get(server, name);
  if (typeof call !== 'function') {
    throw new Error(`The server has no ${name}`);
  }
  return Reflect.apply(call, server, args) as unknown;
}

function textOf(answer: unknown): string {
  const text = (answer as { content: { text: string }[] }).content[0]?.text;
  return text ?? '';
}

/** What a call to the editor answers when its connection dropped, and when the editor answered with an error. */
function lostConnection(server: GodotServer): unknown {
  const call = { toolName: 'scene_tree', callName: 'scene_tree', open: undefined };
  return {
    lost: textOf(privateCall(server, 'bridgeErrorAnswer', [new EditorDisconnected('Godot disconnected during request'), call])),
    answered: textOf(privateCall(server, 'bridgeErrorAnswer', [new Error('no such node'), call])),
  };
}

interface LanguageServerStandIn {
  readonly port: number;
  readonly connections: () => number;
  readonly stop: () => void;
}

/** A listener that answers every request with its own port. */
async function languageServerStandIn(): Promise<LanguageServerStandIn> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    const reader = new FrameReader();
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      for (const received of reader.push(chunk)) {
        const message = received.kind === 'message' ? (received.value as { id?: number }) : {};
        if (typeof message.id === 'number') {
          socket.write(frame({ jsonrpc: '2.0', id: message.id, result: { port } }));
        }
      }
    });
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    connections: () => sockets.size,
    stop: () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
    },
  };
}

/** Two calls at once over a move of the editor's language server port. */
async function portMove(server: GodotServer): Promise<unknown> {
  const before = await languageServerStandIn();
  const after = await languageServerStandIn();
  const client = (): Promise<object> => privateCall(server, 'lsp', []) as Promise<object>;
  const ask = async (held: object): Promise<unknown> => {
    const send: unknown = Reflect.get(held, 'sendRequest');
    if (typeof send !== 'function') {
      throw new Error('The client has no sendRequest');
    }
    return (await Reflect.apply(send, held, ['ping', {}, 5000])) as unknown;
  };
  process.env['GDHARNESS_LSP_PORT'] = String(before.port);
  await ask(await client());
  process.env['GDHARNESS_LSP_PORT'] = String(after.port);
  const [first, second] = await Promise.all([client(), client()]);
  const answers = await Promise.allSettled([ask(first), ask(second)]);
  const out = {
    same: first === second,
    wantedPort: after.port,
    answers: answers.map((answer) =>
      answer.status === 'fulfilled' ? answer.value : `rejected: ${String(answer.reason)}`,
    ),
    connectionsAfter: after.connections(),
  };
  before.stop();
  after.stop();
  return out;
}

const server = new GodotServer();
const mode = process.argv[2];
const printed = mode === 'port-move' ? await portMove(server) : lostConnection(server);
console.log(JSON.stringify(printed));
process.exit(0);
