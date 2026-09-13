#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { GodotDAPClient } from '../src/dap_client.js';
import { dictionary, emptyRecord } from '../src/dictionary.js';
import { createBridge } from '../src/godot-bridge.js';
import { envValue, resolveHeadless, runArguments } from '../src/launch.js';
import { GodotLSPClient } from '../src/lsp_client.js';
import { isWithinRoot, resolveWithinProject } from '../src/paths.js';
import { parseProjectGodot } from '../src/resources.js';
import { asArray, get, text } from './support/json.js';
import { isRecord, type JsonRpcMessage, parseTextContent, textOf } from './support/json-rpc.js';
import { ServerProcess } from './support/server.js';

async function withOccupiedBridgePort<T>(run: () => Promise<T>): Promise<T> {
  const blocker = createServer();
  const blockerState = await new Promise<{ alreadyOccupied: boolean }>((resolve, reject) => {
    blocker.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        resolve({ alreadyOccupied: true });
        return;
      }
      reject(error);
    });
    blocker.listen(6505, '127.0.0.1', () => {
      resolve({ alreadyOccupied: false });
    });
  });

  try {
    return await run();
  } finally {
    if (!blockerState.alreadyOccupied) {
      await new Promise<void>((resolve, reject) => {
        blocker.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }
}

/**
 * The slice of a ws WebSocket the bridge touches. The bridge's connection handler is private
 * and typed against the real class, so the fake is handed over through the seam below rather
 * than by pretending to be one.
 */
class FakeSocket extends EventEmitter {
  readonly name: string;
  readyState = 1;
  readonly sent: unknown[] = [];

  constructor(name: string) {
    super();
    this.name = name;
  }

  send(payload: unknown): void {
    this.sent.push(payload);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }
}

function connectFake(bridge: ReturnType<typeof createBridge>, socket: FakeSocket): void {
  (bridge as unknown as { handleConnection: (socket: FakeSocket) => void }).handleConnection(socket);
}

function resolveGodotPath(): string | null {
  const candidate = process.env['GODOT_PATH'];
  return candidate && existsSync(candidate) ? candidate : null;
}

function testStaleDisconnectRegression(): void {
  const bridge = createBridge(0, 1000, '127.0.0.1');
  const first = new FakeSocket('first');
  const second = new FakeSocket('second');

  connectFake(bridge, first);
  assert.equal(bridge.getStatus().connected, true, 'first socket should be connected');

  first.readyState = 3;
  connectFake(bridge, second);
  assert.equal(bridge.getStatus().connected, true, 'second socket should be connected');

  first.emit('close', 1000, Buffer.from('late close from stale socket'));
  assert.equal(bridge.getStatus().connected, true, 'stale close must not disconnect the replacement socket');

  second.emit('close', 1000, Buffer.from('active socket closed'));
  assert.equal(bridge.getStatus().connected, false, 'active socket close should disconnect bridge');
}

function testSceneToolsVectorRegression(): void {
  const godotPath = resolveGodotPath();
  if (!godotPath) {
    // A skip is fine on a machine with no engine and never fine where the job exists to run
    // this: the engine job sets the flag so a missing install reads as a failure, not a pass.
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and GODOT_PATH names no existing file.');
    }
    console.log('scene tools vector regression skipped (Godot not found)');
    return;
  }

  const projectDir = mkdtempSync(join(tmpdir(), 'gopeak-regression-'));
  try {
    mkdirSync(join(projectDir, 'addons', 'godot_mcp_editor', 'tools'), { recursive: true });
    mkdirSync(join(projectDir, 'scenes'), { recursive: true });
    cpSync(
      'src/godot/addons/godot_mcp_editor/tools/scene_tools.gd',
      join(projectDir, 'addons', 'godot_mcp_editor', 'tools', 'scene_tools.gd'),
    );

    writeFileSync(
      join(projectDir, 'project.godot'),
      `; Engine configuration file.\n; It's best edited using the editor.\nconfig_version=5\n\n[application]\nconfig/name="GopeakRegression"\n`,
    );

    writeFileSync(
      join(projectDir, 'runner.gd'),
      `extends SceneTree\n\nfunc _fail(message: String) -> void:\n\tprinterr(message)\n\tquit(1)\n\nfunc _init() -> void:\n\tvar root := Node2D.new()\n\troot.name = "Root"\n\tvar packed := PackedScene.new()\n\tif packed.pack(root) != OK:\n\t\t_fail("failed to pack root scene")\n\t\treturn\n\tif ResourceSaver.save(packed, "res://scenes/Test.tscn") != OK:\n\t\t_fail("failed to save root scene")\n\t\treturn\n\troot.queue_free()\n\n\tvar scene_tools = load("res://addons/godot_mcp_editor/tools/scene_tools.gd").new()\n\tvar project_path := ProjectSettings.globalize_path("res://")\n\n\tvar add_result: Dictionary = scene_tools.add_node({\n\t\t"projectPath": project_path,\n\t\t"scenePath": "res://scenes/Test.tscn",\n\t\t"nodeType": "Node2D",\n\t\t"nodeName": "TestNode",\n\t\t"parentNodePath": ".",\n\t\t"properties": {\n\t\t\t"position": {"x": 100, "y": 200},\n\t\t\t"scale": {"_type": "Vector2", "x": 2, "y": 2}\n\t\t}\n\t})\n\tif not add_result.get("ok", false):\n\t\t_fail("add_node failed: %s" % JSON.stringify(add_result))\n\t\treturn\n\n\tvar set_result: Dictionary = scene_tools.set_node_properties({\n\t\t"projectPath": project_path,\n\t\t"scenePath": "res://scenes/Test.tscn",\n\t\t"nodePath": "TestNode",\n\t\t"properties": {\n\t\t\t"position": [300, 400]\n\t\t}\n\t})\n\tif not set_result.get("ok", false):\n\t\t_fail("set_node_properties failed: %s" % JSON.stringify(set_result))\n\t\treturn\n\n\t# A tagged Resource class is built on the spot, which is how a region gets its polygon and a\n\t# tree its root without a wrapper tool per node class.\n\tvar nav_result: Dictionary = scene_tools.add_node({\n\t\t"projectPath": project_path,\n\t\t"scenePath": "res://scenes/Test.tscn",\n\t\t"nodeType": "NavigationRegion2D",\n\t\t"nodeName": "Walkable",\n\t\t"parentNodePath": ".",\n\t\t"properties": {"navigation_polygon": {"_type": "NavigationPolygon"}}\n\t})\n\tif not nav_result.get("ok", false):\n\t\t_fail("add_node NavigationRegion2D failed: %s" % JSON.stringify(nav_result))\n\t\treturn\n\tvar tree_result: Dictionary = scene_tools.add_node({\n\t\t"projectPath": project_path,\n\t\t"scenePath": "res://scenes/Test.tscn",\n\t\t"nodeType": "AnimationTree",\n\t\t"nodeName": "Tree",\n\t\t"parentNodePath": ".",\n\t\t"properties": {\n\t\t\t"anim_player": {"_type": "NodePath", "path": "../TestNode"},\n\t\t\t"tree_root": {"_type": "AnimationNodeStateMachine"}\n\t\t}\n\t})\n\tif not tree_result.get("ok", false):\n\t\t_fail("add_node AnimationTree failed: %s" % JSON.stringify(tree_result))\n\t\treturn\n\n\tvar loaded := load("res://scenes/Test.tscn") as PackedScene\n\tif loaded == null:\n\t\t_fail("failed to reload saved scene")\n\t\treturn\n\n\tvar instance := loaded.instantiate()\n\tvar node := instance.get_node_or_null("TestNode") as Node2D\n\tif node == null:\n\t\t_fail("saved node missing")\n\t\treturn\n\n\tif node.position != Vector2(300, 400):\n\t\t_fail("position mismatch: %s" % node.position)\n\t\treturn\n\tif node.scale != Vector2(2, 2):\n\t\t_fail("scale mismatch: %s" % node.scale)\n\t\treturn\n\tvar walkable := instance.get_node_or_null("Walkable") as NavigationRegion2D\n\tif walkable == null or walkable.navigation_polygon == null:\n\t\t_fail("the tagged NavigationPolygon should be built and saved")\n\t\treturn\n\tvar tree := instance.get_node_or_null("Tree") as AnimationTree\n\tif tree == null or not (tree.tree_root is AnimationNodeStateMachine) or tree.anim_player != NodePath("../TestNode"):\n\t\t_fail("the tagged AnimationNodeStateMachine and NodePath should be built and saved")\n\t\treturn\n\n\tprint(JSON.stringify({"ok": true, "position": [node.position.x, node.position.y], "scale": [node.scale.x, node.scale.y]}))\n\tinstance.queue_free()\n\tquit(0)\n`,
    );

    const run = spawnSync(
      godotPath,
      ['--headless', '--path', projectDir, '--script', join(projectDir, 'runner.gd')],
      {
        encoding: 'utf8',
        timeout: 120000,
      },
    );

    if (run.status !== 0) {
      throw new Error((run.stderr || run.stdout || `godot exited ${run.status}`).trim());
    }

    const output = `${run.stdout}\n${run.stderr}`;
    assert.match(output, /"ok"\s*:\s*true/, 'runner should report success JSON');
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

/**
 * A stand-in for Godot's language server.
 *
 * `reply` decides what URI it publishes diagnostics under, which is the whole point: Godot
 * does not echo back the URI the client sent, it builds its own.
 */
/** The port a listening server landed on, which `address()` only answers once it is up. */
function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('The server is not listening on a TCP port.');
  }
  return address.port;
}

async function withFakeLanguageServer<T>(
  publishUri: (uri: string) => string | null,
  handler: (port: number) => Promise<T>,
): Promise<T> {
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = '';

    const send = (message: unknown): void => {
      const body = JSON.stringify(message);
      socket.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    };

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (;;) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const length = Number(/content-length:\s*(\d+)/i.exec(buffer.slice(0, headerEnd))?.[1]);
        if (!Number.isFinite(length)) return;
        const start = headerEnd + 4;
        if (buffer.length < start + length) return;

        const message = JSON.parse(buffer.slice(start, start + length)) as JsonRpcMessage;
        buffer = buffer.slice(start + length);

        if (message.method === 'initialize') {
          send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
        } else if (message.method === 'textDocument/didOpen') {
          const uri = publishUri(String(get(message.params, 'textDocument', 'uri')));
          if (uri !== null) {
            send({
              jsonrpc: '2.0',
              method: 'textDocument/publishDiagnostics',
              params: {
                uri,
                diagnostics: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                    message: 'Could not find type "Missing" in the current scope.',
                    severity: 1,
                    source: 'gdscript',
                  },
                ],
              },
            });
          }
        }
      }
    });
    socket.on('error', () => {
      // The stub only has to not crash the suite when a client drops.
    });
  });

  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));

  try {
    return await handler(portOf(server));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((closed) =>
      server.close(() => {
        closed();
      }),
    );
  }
}

/**
 * Godot builds its own file URI rather than echoing the client's, and since 4.5 it encodes
 * per RFC 3986, which escapes characters Node's pathToFileURL leaves bare. On Windows the
 * real case is the drive colon: the client sends `file:///C:/game/player.gd` and Godot
 * answers `file:///C%3A/game/player.gd`. Both name the same file and are not equal as
 * strings, so a waiter keyed on one is never found under the other, the wait times out and
 * every file comes back with no problems.
 *
 * Re-encoding one character of the basename reproduces exactly that mismatch on any
 * platform, without needing a Windows drive letter to do it.
 */
async function testDiagnosticsSurviveUriReEncoding(): Promise<void> {
  const reEncodeFirstLetter = (uri: string): string => {
    const at = uri.lastIndexOf('/') + 1;
    const code = uri.charCodeAt(at).toString(16).toUpperCase();
    return `${uri.slice(0, at)}%${code}${uri.slice(at + 1)}`;
  };

  await withFakeLanguageServer(reEncodeFirstLetter, async (port) => {
    const client = new GodotLSPClient(port, '127.0.0.1');
    const diagnostics = await client.getDiagnostics(
      join(tmpdir(), 'gopeak-lsp-regression', 'player.gd'),
      'extends Node\n',
    );

    assert.equal(
      diagnostics.length,
      1,
      'diagnostics published under a differently encoded but identical URI should still reach the caller',
    );
    await client.disconnect();
  });
}

/**
 * Godot publishes an empty diagnostics array for a file that really is clean, so a wait
 * that gives up must not answer with one too. Reporting a dead language server as a clean
 * file is the failure that hides itself.
 */
async function testDiagnosticsTimeoutIsNotAnEmptyResult(): Promise<void> {
  await withFakeLanguageServer(
    () => null,
    async (port) => {
      const client = new GodotLSPClient(port, '127.0.0.1');
      await assert.rejects(
        () => client.getDiagnostics(join(tmpdir(), 'gopeak-lsp-regression', 'silent.gd'), 'extends Node\n'),
        /published no diagnostics/,
        'a diagnostics wait that times out should fail rather than report an empty result',
      );
      await client.disconnect();
    },
  );
}

/**
 * Every shape of character that separates a byte count from a code-unit count: 'é' and 'ü'
 * are two bytes and one UTF-16 unit, '字' and '幕' are three and one, and '🎮' is four bytes
 * and a surrogate pair. A body carrying these is longer in bytes than in units, which is the
 * gap that walks a stream framed by Content-Length off its own message boundaries.
 */
const MULTIBYTE = 'café 字幕 🎮 Ünterstützung';

function frameJsonRpc(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/** Both protocols frame the same way; what the body is (JSON-RPC or DAP) is the handler's business. */
type FramedPeerHandler = (message: Record<string, unknown>, socket: Socket) => void;

/**
 * A peer speaking the Content-Length framing both the LSP and the DAP client read.
 *
 * The writing side is left to `onMessage`, which is handed the socket and decides what bytes
 * go back and how they are split across writes: a fixture for a framing bug has to control
 * chunk boundaries, not just message contents.
 */
async function withFramedPeer<T>(
  onMessage: FramedPeerHandler,
  handler: (port: number) => Promise<T>,
): Promise<T> {
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const header = buffer.toString('latin1', 0, headerEnd);
        const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1]);
        if (!Number.isFinite(length)) return;
        const start = headerEnd + 4;
        if (buffer.length < start + length) return;

        const message: unknown = JSON.parse(buffer.toString('utf8', start, start + length));
        buffer = buffer.subarray(start + length);
        onMessage(isRecord(message) ? message : {}, socket);
      }
    });
    socket.on('error', () => {
      // The stub only has to not crash the suite when a client drops.
    });
  });

  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));

  try {
    return await handler(portOf(server));
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((closed) =>
      server.close(() => {
        closed();
      }),
    );
  }
}

/**
 * Content-Length is a count of bytes and every string index in JavaScript is a count of
 * UTF-16 code units, so a client that buffers decoded text reads the end of a message that
 * holds one accent in the wrong place. The body it hands to JSON.parse is short, the parse
 * fails, and the bytes it did not consume are read as the next message's header: the stream
 * is desynchronised from then on and never recovers.
 *
 * Two messages arrive in one write for that reason. The first carries the multi-byte text
 * and is one the client ignores; the second is the one under assertion, and it can only be
 * found at all if the first was measured in bytes.
 */
async function testLspFramesBodiesByBytes(): Promise<void> {
  const diagnosticMessage = `Could not find type "${MULTIBYTE}" in the current scope.`;

  const respond: FramedPeerHandler = (message, socket) => {
    if (message['method'] === 'initialize') {
      socket.write(frameJsonRpc({ jsonrpc: '2.0', id: message['id'], result: { capabilities: {} } }));
      return;
    }

    if (message['method'] === 'textDocument/didOpen') {
      socket.write(
        Buffer.concat([
          frameJsonRpc({
            jsonrpc: '2.0',
            method: 'window/logMessage',
            params: { type: 3, message: MULTIBYTE.repeat(8) },
          }),
          frameJsonRpc({
            jsonrpc: '2.0',
            method: 'textDocument/publishDiagnostics',
            params: {
              uri: get(message['params'], 'textDocument', 'uri'),
              diagnostics: [
                {
                  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                  message: diagnosticMessage,
                  severity: 1,
                  source: 'gdscript',
                },
              ],
            },
          }),
        ]),
      );
    }
  };

  await withFramedPeer(respond, async (port) => {
    const client = new GodotLSPClient(port, '127.0.0.1');
    const diagnostics = await client.getDiagnostics(
      join(tmpdir(), 'gopeak-lsp-framing', 'player.gd'),
      'extends Node\n',
    );

    assert.equal(
      diagnostics.length,
      1,
      'a message following a multi-byte one must still be found, or the stream has desynchronised',
    );
    assert.equal(
      get(diagnostics[0], 'message'),
      diagnosticMessage,
      'a diagnostic quoting non-ASCII text must arrive with that text intact',
    );
    await client.disconnect();
  });
}

/**
 * The same pair, cut in two between the bytes of one character. TCP splits where it likes,
 * so a client has to hold bytes until the announced count is complete rather than decode
 * whatever a single read happened to deliver.
 *
 * The cut falls inside the body under assertion and the message before it is multi-byte, so
 * this fails on either fault: a body assembled wrongly across the chunk boundary, or a length
 * read in code units, which walks past the end of the first message and loses the second.
 */
async function testLspReassemblesBodySplitMidCharacter(): Promise<void> {
  const diagnosticMessage = `Invalid operand "${MULTIBYTE}"`;

  const respond: FramedPeerHandler = (message, socket) => {
    if (message['method'] === 'initialize') {
      socket.write(frameJsonRpc({ jsonrpc: '2.0', id: message['id'], result: { capabilities: {} } }));
      return;
    }

    if (message['method'] === 'textDocument/didOpen') {
      const log = frameJsonRpc({
        jsonrpc: '2.0',
        method: 'window/logMessage',
        params: { type: 3, message: MULTIBYTE.repeat(8) },
      });
      const framed = Buffer.concat([
        log,
        frameJsonRpc({
          jsonrpc: '2.0',
          method: 'textDocument/publishDiagnostics',
          params: {
            uri: get(message['params'], 'textDocument', 'uri'),
            diagnostics: [{ message: diagnosticMessage, severity: 1, source: 'gdscript' }],
          },
        }),
      ]);

      // Two bytes into the four the emoji is spelled with, so neither half is valid UTF-8.
      const split = framed.indexOf(Buffer.from('🎮', 'utf8'), log.length) + 2;
      socket.write(framed.subarray(0, split));
      setTimeout(() => socket.write(framed.subarray(split)), 20);
    }
  };

  await withFramedPeer(respond, async (port) => {
    const client = new GodotLSPClient(port, '127.0.0.1');
    const diagnostics = await client.getDiagnostics(
      join(tmpdir(), 'gopeak-lsp-framing', 'split.gd'),
      'extends Node\n',
    );

    assert.equal(diagnostics.length, 1, 'a body split across two reads must still be assembled');
    assert.equal(
      get(diagnostics[0], 'message'),
      diagnosticMessage,
      'a character split across two reads must decode to itself, not to replacement characters',
    );
    await client.disconnect();
  });
}

/**
 * The debug adapter client frames identically and had the identical fault. Godot prints
 * through it, so the non-ASCII case here is an ordinary `print()` of a translated string.
 */
async function testDapFramesBodiesByBytes(): Promise<void> {
  const outputLine = `print: ${MULTIBYTE}`;
  const marker = MULTIBYTE.repeat(8);

  const respond: FramedPeerHandler = (message, socket) => {
    if (message['command'] === 'initialize') {
      socket.write(
        Buffer.concat([
          frameJsonRpc({
            seq: 1,
            type: 'response',
            request_seq: message['seq'],
            command: 'initialize',
            success: true,
            body: { marker },
          }),
          frameJsonRpc({
            seq: 2,
            type: 'event',
            event: 'output',
            body: { category: 'console', output: `${outputLine}\n` },
          }),
        ]),
      );
      return;
    }

    socket.write(
      frameJsonRpc({
        seq: 3,
        type: 'response',
        request_seq: message['seq'],
        command: message['command'],
        success: true,
        body: {},
      }),
    );
  };

  await withFramedPeer(respond, async (port) => {
    const client = new GodotDAPClient(port, '127.0.0.1');
    const body = await client.initialize();

    assert.equal(get(body, 'marker'), marker, 'a response body holding non-ASCII text must arrive intact');
    assert.deepEqual(
      client.getOutput(),
      [outputLine],
      'an event following a multi-byte response must still be found, or the stream has desynchronised',
    );
    await client.disconnect();
  });
}

/**
 * A peer that announces a body and never sends it. Buffering it away quietly is how a
 * process grows until it is killed with nothing on any log, so both clients cap what they
 * will hold and drop the connection with the size in the message.
 */
async function testFramingCeilingFailsLoudly(): Promise<void> {
  const announceTooMuch: FramedPeerHandler = (_message, socket) => {
    socket.write(Buffer.from('Content-Length: 999999999\r\n\r\n', 'ascii'));
  };

  await withFramedPeer(announceTooMuch, async (port) => {
    const client = new GodotLSPClient(port, '127.0.0.1');
    await assert.rejects(
      () => client.initialize(tmpdir()),
      /exceeded the 33554432 byte ceiling/,
      'an LSP peer announcing more than the ceiling should fail the request, naming the size',
    );
    await client.disconnect();
  });

  await withFramedPeer(announceTooMuch, async (port) => {
    const client = new GodotDAPClient(port, '127.0.0.1');
    await assert.rejects(
      () => client.initialize(),
      /exceeded the 33554432 byte ceiling/,
      'a DAP adapter announcing more than the ceiling should fail the request, naming the size',
    );
  });
}

/**
 * Section names and keys come out of project.godot, which is a file the project supplies. On
 * an ordinary object `result['constructor']` is the Object function and `result['__proto__']`
 * is Object.prototype, so a parser that indexes its result with those names writes the file's
 * keys onto one of them: every object in the process gains a property, and the section the
 * caller asked for is a function that JSON.stringify drops on the floor.
 */
function testProjectGodotResistsPrototypeKeys(): void {
  const parsed = parseProjectGodot(
    [
      '[application]',
      'config/name="Pollution"',
      '',
      '[constructor]',
      'polluted="yes"',
      '',
      '[__proto__]',
      'polluted="yes"',
      '',
      '[misc]',
      '__proto__="data"',
      'kept="value"',
    ].join('\n'),
  );

  assert.equal(
    get(Object.prototype, 'polluted'),
    undefined,
    'a [__proto__] section must not put a property on every object in the process',
  );
  assert.equal(
    (Object as unknown as Record<string, unknown>)['polluted'],
    undefined,
    'a [constructor] section must not write onto the Object constructor',
  );

  assert.equal(
    Object.getPrototypeOf(parsed),
    null,
    'the parsed project must carry no prototype for a section name to reach through',
  );
  assert.equal(
    Object.getPrototypeOf(parsed['misc']),
    null,
    'each section must carry no prototype for a key name to reach through',
  );

  assert.equal(typeof parsed.constructor, 'object', 'a [constructor] section must parse to data');
  assert.equal(
    get(parsed, 'constructor', 'polluted'),
    'yes',
    'a [constructor] section must keep its own keys',
  );
  // Through the descriptor rather than the accessor: reading it as a property would answer
  // with whatever prototype is behind the object when the section is not there as data.
  const protoSection: unknown = Object.getOwnPropertyDescriptor(parsed, '__proto__')?.value;
  assert.equal(get(protoSection, 'polluted'), 'yes', 'a [__proto__] section must keep its own keys');
  assert.equal(
    Object.getOwnPropertyDescriptor(parsed['misc'], '__proto__')?.value,
    'data',
    'a __proto__ key must land on the section as data',
  );
  assert.equal(get(parsed, 'misc', 'kept'), 'value', 'a key after a __proto__ key must survive');
  assert.equal(
    get(parsed, 'application', 'config/name'),
    'Pollution',
    'ordinary sections must be unaffected',
  );

  // What the resource handler returns. JSON.stringify drops a function value outright, so a
  // section parsed onto the Object constructor leaves the client a project with a hole in it.
  const serialised: unknown = JSON.parse(JSON.stringify(parsed));
  assert.equal(
    get(serialised, 'constructor', 'polluted'),
    'yes',
    'a [constructor] section must survive the JSON the resource handler hands back',
  );
}

async function testEditorStatusPortConflict(): Promise<void> {
  await withOccupiedBridgePort(async () => {
    const server = new ServerProcess();
    try {
      await delay(500);
      assert.equal(server.exited, false, 'server should stay alive when the bridge port is occupied');
      await server.initialize('regression-test');

      const response = await server.request('tools/call', { name: 'editor_status', arguments: {} });
      const payload = get(parseTextContent(response), 'editor');
      assert.equal(get(payload, 'bridgeAvailable'), false);
      assert.match(text(get(payload, 'startupError')), /EADDRINUSE/i);
      assert.match(text(get(payload, 'note')), /Another gdharness instance may own the editor bridge/i);
    } finally {
      await server.stop();
    }
  });
}

type ToolCall = (name: string, args: unknown, timeoutMs?: number) => Promise<string>;
type RawRequest = (method: string, params: unknown, timeoutMs?: number) => Promise<JsonRpcMessage>;

/** Long enough for a headless engine to start, run one operation and exit on a slow runner. */
const ENGINE_CALL_TIMEOUT_MS = 120_000;

/**
 * Runs the built server over stdio, initialised and ready for tools/call, and hands `call` and
 * `request` to the body. The transport is the point: these fixtures are about what a peer can
 * put on the wire, and reaching into the class directly would not carry a `__proto__` through
 * JSON.parse.
 */
async function withStdioServer(
  body: (call: ToolCall, request: RawRequest) => Promise<void>,
  env: Record<string, string> = {},
): Promise<void> {
  const server = new ServerProcess({ env });

  const request: RawRequest = async (method, params, timeoutMs) =>
    await server.request(method, params, timeoutMs);

  // The text rather than a parsed payload: a refusal comes back as a sentence, and a fixture
  // about refusals must not fall over on the thing it is there to see.
  const call: ToolCall = async (name, args, timeoutMs) => {
    const response = await request('tools/call', { name, arguments: args }, timeoutMs);
    const text = textOf(response);
    assert.ok(text !== null, `${name} answered with no text content: ${JSON.stringify(response)}`);
    return text;
  };

  try {
    await server.initialize('regression-test');
    await body(call, request);
  } finally {
    await server.stop();
  }
}

/**
 * The dictionaries every untrusted name is looked up in have nothing behind them.
 *
 * This is the one mechanism every lookup site in index.ts relies on, so it is asserted
 * directly rather than only through whichever of them a fixture can reach. A name
 * belonging to Object.prototype must read as absent, and writing `__proto__` must store a key
 * rather than re-parent the object.
 */
function testDictionariesHaveNothingBehindThem(): void {
  const table = dictionary({ real: 'yes' });
  const blank = emptyRecord<unknown>();

  assert.equal(table['real'], 'yes', 'a dictionary must still answer for its own keys');

  for (const inherited of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
    assert.equal(table[inherited], undefined, `${inherited} must not resolve in a filled dictionary`);
    assert.equal(blank[inherited], undefined, `${inherited} must not resolve in an empty one`);
  }

  // Copied key by key out of parsed JSON, which is how such a name arrives in the first place:
  // JSON.parse makes __proto__ an own enumerable property rather than a prototype.
  const hostile = JSON.parse('{"__proto__": {"injected": true}}') as Record<string, unknown>;
  for (const key of Object.keys(hostile)) {
    blank[key] = hostile[key];
  }

  assert.deepEqual(
    Object.getOwnPropertyDescriptor(blank, '__proto__')?.value,
    { injected: true },
    '__proto__ must land as an ordinary key',
  );
  assert.equal(blank['injected'], undefined, 'writing __proto__ must not re-parent the dictionary');
  assert.equal(Object.getPrototypeOf(blank), null, 'the dictionary must still have no prototype');
}

/**
 * The tool table, the op table and the project_info sections are indexed by names off the wire,
 * so a name belonging to Object.prototype must not resolve. `constructor` is truthy on a plain
 * literal, so an existence check passes and the server dispatches on a function.
 */
async function testToolAndOpLookupsCannotReachThePrototype(): Promise<void> {
  await withStdioServer(async (call, request) => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const unknownTool = await request('tools/call', { name, arguments: {} });
      assert.match(unknownTool.error?.message ?? '', /Unknown tool/, `${name} must not resolve to a tool`);

      const unknownOp = await call('scene_node', { projectPath: '/p', scenePath: 'a.tscn', op: name });
      assert.match(unknownOp, /has no op/, `${name} must not resolve to an op`);

      const unknownSection = await call('project_info', { projectPath: process.cwd(), include: [name] });
      assert.match(unknownSection, /cannot include/, `${name} must not resolve to a section`);
    }
  });
}

function testProjectGodotMultilineValues(): void {
  const parsed = parseProjectGodot(
    [
      '[input]',
      '',
      'move_left={',
      '"deadzone": 0.2,',
      '"events": [Object(InputEventKey,"physical_keycode":65)]',
      '}',
      '',
      '[rendering]',
      '',
      'renderer/rendering_method="gl_compatibility"',
      '',
      '[misc]',
      '',
      'brace_in_string="{"',
      'after_brace_in_string="kept"',
      'inline_dict={"x": [1, 2], "y": {"z": 3}}',
      'after_inline_dict=7',
    ].join('\n'),
  );

  assert.equal(
    get(parsed, 'input', 'move_left'),
    '{\n"deadzone": 0.2,\n"events": [Object(InputEventKey,"physical_keycode":65)]\n}',
    'multi-line dictionary values should be joined rather than truncated to their first line',
  );
  assert.equal(
    get(parsed, 'rendering', 'renderer/rendering_method'),
    'gl_compatibility',
    'a section following a multi-line value should still be parsed',
  );
  assert.equal(
    get(parsed, 'misc', 'brace_in_string'),
    '{',
    'a brace inside a quoted string should not start a continuation',
  );
  assert.equal(
    get(parsed, 'misc', 'after_brace_in_string'),
    'kept',
    'a key after a quoted brace should survive',
  );
  assert.equal(
    get(parsed, 'misc', 'inline_dict'),
    '{"x": [1, 2], "y": {"z": 3}}',
    'a balanced single-line dictionary should be left alone',
  );
  assert.equal(
    get(parsed, 'misc', 'after_inline_dict'),
    7,
    'a key after an inline dictionary should survive',
  );

  const unterminated = parseProjectGodot('[s]\nbroken={\n"k": 1\n');
  assert.equal(typeof get(unterminated, 's', 'broken'), 'string', 'an unterminated value should not hang');
}

/**
 * A path read as a location inside the project has to land inside it.
 *
 * The guard this replaces was `path.includes('..')`, which is neither necessary nor sufficient:
 * it refused ordinary names such as `archive..old.gd`, and it had nothing to say about the
 * spellings that carry no dots at all. Those are platform-shaped, so the hostile set is too: a
 * drive letter and a UNC share are absolute on Windows and ordinary filenames on Linux.
 */
function testProjectPathsAreContained(): void {
  const onWindows = process.platform === 'win32';
  const root = onWindows ? 'C:\\game' : '/srv/game';

  const refused = [
    '../../../../etc/passwd',
    'scenes/../../outside.tscn',
    'res://../../outside.gd',
    'user://savegame.dat',
    '',
    '.',
    // Refused on both platforms, not on whichever one node:path happens to call absolute. A
    // leading `/` is absolute to node:path on POSIX and a leading `\` is on Windows, so a rule
    // leaning on isAbsolute alone would judge the same argument by which machine read it.
    '/etc/shadow/../passwd',
    '/../etc/passwd',
    '/etc/passwd',
    '\\Windows\\win.ini',
    'res:///etc/passwd',
    ...(onWindows
      ? ['C:\\Windows\\win.ini', 'C:/Windows/win.ini', 'D:\\other\\payload.gd', '\\\\server\\share\\x.gd']
      : []),
  ];

  for (const candidate of refused) {
    const answer = resolveWithinProject(root, candidate);
    assert.ok(!answer.ok, `${JSON.stringify(candidate)} should not resolve inside ${root}`);
    assert.match(
      answer.reason,
      /empty|null byte|scheme|absolute|outside the project|project directory itself/,
      `${JSON.stringify(candidate)} should be refused with a reason that says why`,
    );
  }

  // The other half, or the fixture above passes against a function that refuses everything.
  const accepted: [string, string][] = [
    ['scenes/main.tscn', 'scenes/main.tscn'],
    ['res://scenes/main.tscn', 'scenes/main.tscn'],
    ['scenes/./main.tscn', 'scenes/main.tscn'],
    ['scenes/sub/../main.tscn', 'scenes/main.tscn'],
    ['archive..old.gd', 'archive..old.gd'],
    ['..config/player.gd', '..config/player.gd'],
    ...(onWindows ? [['scenes\\main.tscn', 'scenes/main.tscn'] as [string, string]] : []),
  ];

  for (const [candidate, expected] of accepted) {
    const answer = resolveWithinProject(root, candidate);
    assert.ok(answer.ok, `${JSON.stringify(candidate)} names a file inside the project`);
    assert.equal(
      answer.relativePath,
      expected,
      `${JSON.stringify(candidate)} should reach the engine as a project-relative path`,
    );
    assert.equal(
      answer.absolutePath,
      join(root, ...expected.split('/')),
      `${JSON.stringify(candidate)} should resolve to the file under the project root`,
    );
  }

  // A sibling directory whose path merely begins with the project's text is not inside it,
  // which is what a prefix comparison gets wrong and `relative` does not.
  assert.equal(
    isWithinRoot(root, `${root}-old${onWindows ? '\\' : '/'}player.gd`),
    false,
    'a sibling directory sharing the project name prefix is outside the project',
  );
  assert.equal(
    isWithinRoot(root, join(root, 'scenes', 'main.tscn')),
    true,
    'a file under the project root is inside it',
  );
}

/**
 * The same, through the tools, because the check is only worth anything where it is called.
 *
 * Every argument below is documented as a path inside the project and is read as one: the
 * operations script prefixes `res://` and opens it, the export path is a destination the engine
 * writes. Several of these were not checked at all, and the rest were checked by a substring
 * test that an absolute path walks straight past.
 */
async function testToolsRefusePathsOutsideTheProject(): Promise<void> {
  const sandbox = mkdtempSync(join(tmpdir(), 'gdharness-containment-'));
  const projectPath = join(sandbox, 'project');
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(join(projectPath, 'project.godot'), 'config_version=5\n');
  writeFileSync(join(projectPath, 'inside.gd'), 'extends Node\n');
  writeFileSync(join(sandbox, 'outside.gd'), 'extends Node\n');
  writeFileSync(join(sandbox, 'outside.png'), 'not a png');

  const outsideScript = '../outside.gd';
  const hostile: [string, Record<string, unknown>][] = [
    ['script_edit', { op: 'create', scriptPath: '../escaped.gd' }],
    [
      'script_edit',
      { op: 'modify', scriptPath: outsideScript, modifications: [{ type: 'add_signal', name: 'died' }] },
    ],
    ['script_info', { scriptPath: outsideScript }],
    ['project_import', { op: 'uid', resourcePath: '../outside.png' }],
    ['project_import', { op: 'status', resourcePath: '../outside.png' }],
    ['project_import', { op: 'options', resourcePath: '../outside.png' }],
    ['project_import', { op: 'set_options', resourcePath: '../outside.png', options: { flag: true } }],
    ['project_import', { op: 'reimport', resourcePath: '../outside.png' }],
    ['project_dependencies', { resourcePath: outsideScript }],
    ['project_dependencies', { direction: 'reverse', resourcePath: '../outside.png' }],
    ['project_settings', { op: 'add_autoload', name: 'Escaped', path: outsideScript }],
    ['project_settings', { op: 'set_main_scene', scenePath: '../outside.tscn' }],
    ['editor_run', { scene: '../outside.tscn' }],
    ['project_export', { op: 'run', preset: 'Linux', outputPath: '../escaped.bin' }],
    ['project_settings', { op: 'enable_plugin', pluginName: '../../outsideplugin' }],
    ['project_settings', { op: 'disable_plugin', pluginName: '../../outsideplugin' }],
    // The editor-side tools are judged here before the editor is even asked for.
    ['scene_tree', { scenePath: '../outside.tscn' }],
    ['scene_node', { op: 'get', scenePath: '../outside.tscn', nodePath: '.' }],
    [
      'scene_node',
      { op: 'load_sprite', scenePath: 'inside.tscn', nodePath: 'S', texturePath: '../outside.png' },
    ],
    ['scene_create', { op: 'save_as', scenePath: 'inside.tscn', newPath: '../copy.tscn' }],
    ['resource_edit', { op: 'create', resourcePath: '../outside.tres', resourceType: 'Resource' }],
    [
      'resource_edit',
      { op: 'create', resourcePath: 'inside.tres', resourceType: 'Resource', script: '/etc/x.gd' },
    ],
  ];

  // An absolute destination is the one that matters most for the export: the engine writes it,
  // and no amount of looking for `..` in it finds anything.
  const absoluteOutput = process.platform === 'win32' ? 'C:\\Windows\\Temp\\pwn.exe' : '/tmp/pwn.bin';

  try {
    await withStdioServer(
      async (call, request) => {
        for (const [tool, args] of hostile) {
          const answer = await call(tool, { projectPath, ...args });
          assert.match(
            answer,
            /is absolute|resolves outside the project directory/,
            `${tool} should refuse ${JSON.stringify(args)}`,
          );
        }

        assert.match(
          await call('project_export', {
            projectPath,
            op: 'run',
            preset: 'Linux',
            outputPath: absoluteOutput,
          }),
          /is absolute|resolves outside the project directory/,
          'project_export should refuse an absolute destination outside the project',
        );

        // The accepting half. These reach the engine, which is not Godot here, so the answer is
        // whatever that failure says; what matters is that containment was not the thing that
        // stopped them.
        const accepted: [string, Record<string, unknown>][] = [
          ['script_edit', { op: 'create', scriptPath: 'scripts/player.gd' }],
          ['project_import', { op: 'uid', resourcePath: 'inside.gd' }],
          ['script_info', { scriptPath: 'inside.gd' }],
          ['project_export', { op: 'run', preset: 'Linux', outputPath: 'builds/game.bin' }],
        ];
        for (const [tool, args] of accepted) {
          assert.doesNotMatch(
            await call(tool, { projectPath, ...args }),
            /is absolute|resolves outside the project directory/,
            `${tool} should accept ${JSON.stringify(args)}`,
          );
        }

        // The LSP tools ask the same question of the same helper, before they open a socket, so
        // the refusal is observable with no language server anywhere. Only the refusal: the
        // accepting side would connect to whatever editor is serving 6005 on this machine.
        assert.match(
          await call('script_diagnostics', { projectPath, scriptPath: '../outside.gd' }),
          /outside the project root boundary/,
          'script_diagnostics should refuse a script outside the project',
        );

        // The resource handler reads the same kind of path out of a URI. The URL parser folds
        // away a plain `..`, so the traversal that reaches it is the encoded one.
        const escaped = await request('resources/read', {
          uri: 'godot://script/..%2f..%2foutside.gd',
        });
        assert.match(
          escaped.error?.message ?? text(get(escaped.result, 'contents', 0, 'text')),
          /is absolute|resolves outside the project directory/,
          'a godot:// URI with an encoded traversal should be refused',
        );
      },
      { GODOT_PATH: process.execPath },
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/**
 * The engine's argument list is not visible from any response, so it is asserted directly.
 * Both branches, because the opt-out was once written as a shift() off the front of the headless
 * argv, which took -d with it and launched a game the debugger never attached to.
 */
function testRunArgumentsCarryTheDebuggerEitherWay(): void {
  assert.deepEqual(runArguments({ projectPath: '/p', headless: true, scene: null }), [
    '--headless',
    '-d',
    '--path',
    '/p',
  ]);
  assert.deepEqual(runArguments({ projectPath: '/p', headless: false, scene: null }), ['-d', '--path', '/p']);
  // The scene as a res:// path and last: the engine reads it positionally, so text beginning
  // with a dash would otherwise be another option to it.
  assert.deepEqual(runArguments({ projectPath: '/p', headless: false, scene: 'scenes/-odd.tscn' }), [
    '-d',
    '--path',
    '/p',
    'res://scenes/-odd.tscn',
  ]);
}

/**
 * CI is both the place that needs headless and the place with no display, so with no explicit
 * argument the display decides. An exported-but-empty display variable is no display.
 */
function testHeadlessFollowsTheDisplay(): void {
  const linux = (variables: NodeJS.ProcessEnv) => ({ platform: 'linux' as const, variables });

  assert.equal(resolveHeadless(true, linux({ DISPLAY: ':0' })), true, 'an explicit true wins over a desktop');
  assert.equal(resolveHeadless(false, linux({})), false, 'an explicit false wins over no display');
  assert.equal(resolveHeadless(undefined, linux({})), true, 'no display means headless');
  assert.equal(resolveHeadless(undefined, linux({ DISPLAY: '' })), true, 'an empty DISPLAY is no display');
  assert.equal(resolveHeadless(undefined, linux({ DISPLAY: ':0' })), false, 'an X display is a desktop');
  assert.equal(resolveHeadless(undefined, linux({ WAYLAND_DISPLAY: 'wayland-0' })), false, 'so is Wayland');
  assert.equal(resolveHeadless('yes', linux({})), true, 'anything but a boolean is left to the environment');
  for (const platform of ['win32', 'darwin'] as const) {
    assert.equal(
      resolveHeadless(undefined, { platform, variables: {} }),
      false,
      `${platform} always has a display`,
    );
  }

  assert.equal(envValue('X', { X: '' }), undefined, 'exported empty reads as unset');
  assert.equal(envValue('X', {}), undefined);
  assert.equal(envValue('X', { X: 'set' }), 'set');
}

/**
 * Parameters cross from the server into the engine through a temp file and a case conversion,
 * and neither is visible from a response that reads "updated". So a tagged value is written
 * into project.godot and read back off disk, and the depth limit is checked by what the walk
 * returns: `depth` has to arrive as the `max_depth` the operation reads, or the walk ignores it.
 */
async function testParametersReachTheEngine(): Promise<void> {
  const godotPath = resolveGodotPath();
  if (!godotPath) {
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and GODOT_PATH names no existing file.');
    }
    console.log('engine parameter regression skipped (Godot not found)');
    return;
  }

  const projectDir = mkdtempSync(join(tmpdir(), 'gdharness-engine-params-'));
  try {
    writeFileSync(
      join(projectDir, 'project.godot'),
      '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="ParamsRegression"\n',
    );
    mkdirSync(join(projectDir, 'chain'));
    writeFileSync(join(projectDir, 'chain', 'leaf.gd'), 'extends Node\n');
    writeFileSync(
      join(projectDir, 'chain', 'middle.gd'),
      'extends Node\n\nconst Leaf = preload("res://chain/leaf.gd")\n',
    );
    writeFileSync(
      join(projectDir, 'chain', 'top.gd'),
      'extends Node\n\nconst Middle = preload("res://chain/middle.gd")\n',
    );

    await withStdioServer(
      async (call) => {
        const updated = await call(
          'project_settings',
          {
            projectPath: projectDir,
            op: 'set',
            setting: 'fixture/anchor',
            value: { _type: 'Vector2', x: 3, y: 4 },
          },
          ENGINE_CALL_TIMEOUT_MS,
        );
        assert.match(updated, /Setting updated/, updated);
        const written = readFileSync(join(projectDir, 'project.godot'), 'utf8');
        assert.match(
          written,
          /\[fixture\]\s+anchor=Vector2\(3, 4\)/,
          `the tagged value should land as an engine value:\n${written}`,
        );

        const namesAt = async (depth: number): Promise<string[]> => {
          const answer = await call(
            'project_dependencies',
            { projectPath: projectDir, resourcePath: 'chain/top.gd', depth },
            ENGINE_CALL_TIMEOUT_MS,
          );
          const walk: unknown = JSON.parse(answer);
          const names: string[] = [];
          const collect = (entries: unknown): void => {
            for (const entry of asArray(entries)) {
              names.push(text(get(entry, 'path')));
              collect(get(entry, 'dependencies') ?? []);
            }
          };
          collect(get(walk, 'dependencies', 'res://chain/top.gd'));
          return names;
        };

        const shallow = await namesAt(1);
        assert.ok(shallow.includes('res://chain/middle.gd'), `depth 1 reaches middle: ${shallow.join(', ')}`);
        assert.ok(
          !shallow.includes('res://chain/leaf.gd'),
          `depth 1 stops before leaf: ${shallow.join(', ')}`,
        );

        const deep = await namesAt(3);
        assert.ok(deep.includes('res://chain/leaf.gd'), `depth 3 reaches leaf: ${deep.join(', ')}`);
      },
      { GODOT_PATH: godotPath },
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  testStaleDisconnectRegression();
  testSceneToolsVectorRegression();
  testRunArgumentsCarryTheDebuggerEitherWay();
  testHeadlessFollowsTheDisplay();
  await testParametersReachTheEngine();

  testProjectGodotMultilineValues();
  testProjectGodotResistsPrototypeKeys();

  await testEditorStatusPortConflict();
  await testDiagnosticsSurviveUriReEncoding();
  await testDiagnosticsTimeoutIsNotAnEmptyResult();
  await testLspFramesBodiesByBytes();
  await testLspReassemblesBodySplitMidCharacter();
  await testDapFramesBodiesByBytes();
  await testFramingCeilingFailsLoudly();
  testDictionariesHaveNothingBehindThem();
  testProjectPathsAreContained();
  await testToolAndOpLookupsCannotReachThePrototype();
  await testToolsRefusePathsOutsideTheProject();
  console.log('regression tests passed');
}

await main();
