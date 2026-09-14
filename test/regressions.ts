#!/usr/bin/env node
import assert from 'node:assert/strict';
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { staleClassNames } from '../src/class-cache.js';
import { GodotDAPClient } from '../src/dap_client.js';
import { dictionary, emptyRecord } from '../src/dictionary.js';
import { createBridge } from '../src/godot-bridge.js';
import { editorArguments, envValue, resolveHeadless, runArguments, userDataIn } from '../src/launch.js';
import { GodotLSPClient } from '../src/lsp_client.js';
import { isWithinRoot, resolveWithinProject } from '../src/paths.js';
import { parseProjectGodot } from '../src/resources.js';
import {
  chooseRuntime,
  discoverRuntimes,
  RUNTIME_PROTOCOL,
  runtimeDirectories,
  runtimesAnnounced,
} from '../src/runtime-client.js';
import { HEADLESS_OPERATIONS } from '../src/server.js';
import { addonMismatch } from '../src/server-version.js';
import { TOOL_SPECS } from '../src/tool-definitions.js';
import { cacheFile, isNewer } from '../src/update-check.js';
import { asArray, asNumber, get, text } from './support/json.js';
import { isRecord, type JsonRpcMessage, parseTextContent, textOf } from './support/json-rpc.js';
import { reservePort, ServerProcess } from './support/server.js';

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
    mkdirSync(join(projectDir, 'addons', 'gdharness_editor', 'tools'), { recursive: true });
    mkdirSync(join(projectDir, 'scenes'), { recursive: true });
    cpSync(
      'src/godot/addons/gdharness_editor/tools/scene_tools.gd',
      join(projectDir, 'addons', 'gdharness_editor', 'tools', 'scene_tools.gd'),
    );

    writeFileSync(
      join(projectDir, 'project.godot'),
      `; Engine configuration file.\n; It's best edited using the editor.\nconfig_version=5\n\n[application]\nconfig/name="GopeakRegression"\n`,
    );

    writeFileSync(
      join(projectDir, 'runner.gd'),
      `extends SceneTree\n\nfunc _fail(message: String) -> void:\n\tprinterr(message)\n\tquit(1)\n\nfunc _init() -> void:\n\tvar root := Node2D.new()\n\troot.name = "Root"\n\tvar packed := PackedScene.new()\n\tif packed.pack(root) != OK:\n\t\t_fail("failed to pack root scene")\n\t\treturn\n\tif ResourceSaver.save(packed, "res://scenes/Test.tscn") != OK:\n\t\t_fail("failed to save root scene")\n\t\treturn\n\troot.queue_free()\n\n\tvar scene_tools = load("res://addons/gdharness_editor/tools/scene_tools.gd").new()\n\tvar project_path := ProjectSettings.globalize_path("res://")\n\n\tvar add_result: Dictionary = scene_tools.add_node({\n\t\t"projectPath": project_path,\n\t\t"scenePath": "res://scenes/Test.tscn",\n\t\t"nodeType": "Node2D",\n\t\t"nodeName": "TestNode",\n\t\t"parentNodePath": ".",\n\t\t"properties": {\n\t\t\t"position": {"x": 100, "y": 200},\n\t\t\t"scale": {"_type": "Vector2", "x": 2, "y": 2}\n\t\t}\n\t})\n\tif not add_result.get("ok", false):\n\t\t_fail("add_node failed: %s" % JSON.stringify(add_result))\n\t\treturn\n\n\tvar set_result: Dictionary = scene_tools.set_node_properties({\n\t\t"projectPath": project_path,\n\t\t"scenePath": "res://scenes/Test.tscn",\n\t\t"nodePath": "TestNode",\n\t\t"properties": {\n\t\t\t"position": [300, 400]\n\t\t}\n\t})\n\tif not set_result.get("ok", false):\n\t\t_fail("set_node_properties failed: %s" % JSON.stringify(set_result))\n\t\treturn\n\n\t# A tagged Resource class is built on the spot, which is how a region gets its polygon and a\n\t# tree its root without a wrapper tool per node class.\n\tvar nav_result: Dictionary = scene_tools.add_node({\n\t\t"projectPath": project_path,\n\t\t"scenePath": "res://scenes/Test.tscn",\n\t\t"nodeType": "NavigationRegion2D",\n\t\t"nodeName": "Walkable",\n\t\t"parentNodePath": ".",\n\t\t"properties": {"navigation_polygon": {"_type": "NavigationPolygon"}}\n\t})\n\tif not nav_result.get("ok", false):\n\t\t_fail("add_node NavigationRegion2D failed: %s" % JSON.stringify(nav_result))\n\t\treturn\n\tvar tree_result: Dictionary = scene_tools.add_node({\n\t\t"projectPath": project_path,\n\t\t"scenePath": "res://scenes/Test.tscn",\n\t\t"nodeType": "AnimationTree",\n\t\t"nodeName": "Tree",\n\t\t"parentNodePath": ".",\n\t\t"properties": {\n\t\t\t"anim_player": {"_type": "NodePath", "path": "../TestNode"},\n\t\t\t"tree_root": {"_type": "AnimationNodeStateMachine"}\n\t\t}\n\t})\n\tif not tree_result.get("ok", false):\n\t\t_fail("add_node AnimationTree failed: %s" % JSON.stringify(tree_result))\n\t\treturn\n\n\tvar loaded := load("res://scenes/Test.tscn") as PackedScene\n\tif loaded == null:\n\t\t_fail("failed to reload saved scene")\n\t\treturn\n\n\tvar instance := loaded.instantiate()\n\tvar node := instance.get_node_or_null("TestNode") as Node2D\n\tif node == null:\n\t\t_fail("saved node missing")\n\t\treturn\n\n\tif node.position != Vector2(300, 400):\n\t\t_fail("position mismatch: %s" % node.position)\n\t\treturn\n\tif node.scale != Vector2(2, 2):\n\t\t_fail("scale mismatch: %s" % node.scale)\n\t\treturn\n\tvar walkable := instance.get_node_or_null("Walkable") as NavigationRegion2D\n\tif walkable == null or walkable.navigation_polygon == null:\n\t\t_fail("the tagged NavigationPolygon should be built and saved")\n\t\treturn\n\tvar tree := instance.get_node_or_null("Tree") as AnimationTree\n\tif tree == null or not (tree.tree_root is AnimationNodeStateMachine) or tree.anim_player != NodePath("../TestNode"):\n\t\t_fail("the tagged AnimationNodeStateMachine and NodePath should be built and saved")\n\t\treturn\n\n\tprint(JSON.stringify({"ok": true, "position": [node.position.x, node.position.y], "scale": [node.scale.x, node.scale.y]}))\n\tinstance.queue_free()\n\tquit(0)\n`,
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
 * Windows hands out two names for the same directory, and Godot answers with the one it was
 * given while the server asks with the one the filesystem resolves to.
 *
 * A runner's TEMP holds the 8.3 name, so the editor publishes under `RUNNER~1` while the client
 * waits under `runneradmin`, and diagnostics simply never arrive: every other request answers,
 * and the caller is told the language server may not be running. Measured on a Windows runner,
 * and reproduced here by publishing under the short name of a real directory.
 */
async function testDiagnosticsSurviveAnotherSpellingOfTheSamePath(): Promise<void> {
  if (process.platform !== 'win32') {
    console.log('path spelling diagnostics regression skipped (one spelling off Windows)');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'gdharness-spelling-'));
  try {
    const scriptPath = join(root, 'player.gd');
    writeFileSync(scriptPath, 'extends Node\n');

    // Upper case here, the 8.3 name on a runner: either way it is a second spelling of the same
    // file, and a key that compares the strings finds neither.
    await withFakeLanguageServer(
      () => pathToFileURL(join(root, 'player.gd').toUpperCase()).href,
      async (port) => {
        const client = new GodotLSPClient(port, '127.0.0.1');
        const diagnostics = await client.getDiagnostics(scriptPath, 'extends Node\n');
        assert.equal(
          diagnostics.length,
          1,
          'diagnostics published under another spelling of the same path should still arrive',
        );
        await client.disconnect();
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

/**
 * How long a server gets to end after its stdin closes before this calls it a hang.
 *
 * Long enough that what fails is a shutdown that never finishes rather than one that took a
 * moment longer than expected on a loaded runner.
 */
const SHUTDOWN_LIMIT_MS = 15_000;

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
      assert.match(text(get(payload, 'note')), /Another gdharness instance owns the editor bridge/i);
    } finally {
      await server.stop();
    }
  });
}

/**
 * The bridge takes its port the moment whoever held it lets go, with nothing restarted.
 *
 * One server owns the port and the rest get nothing, and the usual way that happens is a harness
 * reconnecting: the replacement starts while the server it replaces is still on its way out.
 * Binding once at startup made that permanent, so a session that lost the race had every editor
 * tool refusing for the rest of its life, `editor_launch restart` among them, and the only way out
 * was a person finding the older process and ending it. Seen exactly that way on a real reconnect.
 *
 * Its own port rather than 6505, because the machine this runs on may be somebody's and what is
 * being proved is the handover rather than the number.
 */
async function testTheBridgeTakesThePortWhenItIsFreed(): Promise<void> {
  const port = await reservePort();
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(port, '127.0.0.1', resolve);
  });
  let holding = true;
  const letGo = async (): Promise<void> => {
    if (!holding) {
      return;
    }
    holding = false;
    await new Promise<void>((resolve, reject) => {
      blocker.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  const server = new ServerProcess({ env: { GDHARNESS_BRIDGE_PORT: String(port) } });
  const editorStatus = async (): Promise<unknown> => {
    const response = await server.request('tools/call', { name: 'editor_status', arguments: {} });
    return get(parseTextContent(response), 'editor');
  };
  try {
    await server.initialize('regression-test');

    const blocked = await editorStatus();
    assert.equal(get(blocked, 'bridgeAvailable'), false, 'the port is held, so the bridge is not up');
    assert.equal(get(blocked, 'retryingBridge'), true, 'and it should say it is still asking');
    assert.match(text(get(blocked, 'suggestion')), /on their own/i, 'and say so to whoever reads it');

    await letGo();

    // Asked over several of the retry's own intervals rather than once: what is proved here is
    // that it comes back by itself, not how quickly.
    let live = false;
    for (let attempt = 0; attempt < 15 && !live; attempt += 1) {
      await delay(1000);
      live = get(await editorStatus(), 'bridgeAvailable') === true;
    }
    assert.ok(live, 'the bridge should take the port once it is free, with nothing restarted');
  } finally {
    await server.stop();
    await letGo();
  }
}

/**
 * A server told to go ends, with an editor still holding the bridge.
 *
 * Written to catch a hang and it found none, which is worth saying plainly: `http.Server.close`
 * calls back only once every connection has gone, and an editor on the bridge is an upgraded
 * socket, so a close that waited on it would never settle and the process would sit there
 * holding the port for good. It settles. Two abandoned servers were found holding 6505 in one
 * day and neither of them was this.
 *
 * So it stays as what it turned out to be: the thing nobody had pinned. Its stdin is closed and
 * nothing else, because that is what a harness going away looks like and it is the only shutdown
 * nobody finishes for us. Every other fixture here kills the server outright, so none of them
 * says anything about the path a real harness takes.
 */
async function testAServerEndsWithAnEditorStillOnTheBridge(): Promise<void> {
  const port = await reservePort();
  const server = new ServerProcess({ env: { GDHARNESS_BRIDGE_PORT: String(port) } });
  let editor: WebSocket | null = null;
  try {
    await server.initialize('regression-test');

    const opened = new WebSocket(`ws://127.0.0.1:${port}/godot`);
    editor = opened;
    await new Promise<void>((resolve, reject) => {
      opened.once('open', () => {
        resolve();
      });
      opened.once('error', reject);
    });

    const status = await server.request('tools/call', { name: 'editor_status', arguments: {} });
    assert.equal(
      get(parseTextContent(status), 'editor', 'connected'),
      true,
      'the fixture editor should be on the bridge, or this proves nothing',
    );

    server.child.stdin?.end();

    let ended = false;
    for (let waited = 0; waited < SHUTDOWN_LIMIT_MS && !ended; waited += 250) {
      await delay(250);
      ended = server.exited;
    }
    assert.ok(ended, `the server should have ended within ${SHUTDOWN_LIMIT_MS}ms of its stdin closing`);
  } finally {
    editor?.terminate();
    await server.stop();
  }
}

/**
 * A port variable holding something that is not a port is said so, rather than fallen back on.
 *
 * Three of them now name a port outside this process, and the failure they share is the quiet
 * one: a server that used the default instead would talk to whatever holds it, or to nothing,
 * and report the editor unavailable while the value the user set sat there being ignored.
 */
async function testABadPortIsReported(): Promise<void> {
  const server = new ServerProcess({ env: { GDHARNESS_LSP_PORT: 'banana' } });
  try {
    await server.initialize('regression-test');
    const response = await server.request('tools/call', {
      name: 'script_diagnostics',
      arguments: { projectPath: process.cwd(), scriptPath: 'src/godot/operations/logger.gd' },
    });
    assert.match(
      text(get(response, 'error', 'message')),
      /GDHARNESS_LSP_PORT is "banana"/,
      'the answer should name the variable and what is wrong with it',
    );
    assert.equal(server.exited, false, 'and the server should still be serving everything else');
  } finally {
    await server.stop();
  }
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
    // A path inside `properties`, which no argument name announces as one. The server cannot know
    // which properties hold a Resource, so what it judges is the one thing a caption never does:
    // walk out of the project.
    [
      'scene_node',
      {
        op: 'set',
        scenePath: 'inside.tscn',
        nodePath: 'S',
        properties: { texture: 'res://../outside.png' },
      },
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
          /resolves outside the project directory/,
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
 * A debug tool with nothing to debug refuses, rather than answering with an empty stack.
 *
 * An empty array was the answer to three different situations: no game, a game this server
 * spawned and no debugger behind it, and a game running freely. None of them is a stack, and
 * a caller cannot tell which one it got, which is the shape of a check that agrees with
 * everything. The console is the exception: the adapter buffers it, and that buffer outlives
 * the game it came from.
 */
async function testDebugToolsRefuseWithoutASession(): Promise<void> {
  await withStdioServer(async (call) => {
    for (const [tool, args] of [
      ['debug_state', { op: 'stack' }],
      ['debug_state', { op: 'variables' }],
      ['debug_control', { op: 'continue' }],
      ['debug_control', { op: 'step_over' }],
      ['debug_control', { op: 'step_into' }],
    ] as [string, Record<string, unknown>][]) {
      assert.match(
        await call(tool, args),
        /No game is running[\s\S]*editor_run start/,
        `${tool} ${JSON.stringify(args)} should refuse and name the command that starts one`,
      );
    }

    assert.doesNotMatch(
      await call('debug_state', { op: 'output' }),
      /No game is running/,
      'the buffered console is readable without a session, because it outlives the game',
    );
  });
}

/**
 * Whether the engine's class list has fallen behind the scripts, read from files alone.
 *
 * Godot fixes its global class list when it starts, so a game launched after a `class_name` was
 * written dies at its first screen. editor_run asks this before every run and rebuilds the cache
 * when the answer is not empty, which is why it must cost no engine and must not answer "current"
 * for a cache recording the right name at the wrong path.
 */
function testStaleClassesAreReadFromDisk(): void {
  const sandbox = mkdtempSync(join(tmpdir(), 'gdharness-class-cache-'));
  const cache = join(sandbox, '.godot', 'global_script_class_cache.cfg');
  const entry = (name: string, path: string): string =>
    `list=[{\n"base": &"Node",\n"class": &"${name}",\n"icon": "",\n"is_abstract": false,\n"is_tool": false,\n"language": &"GDScript",\n"path": "${path}"\n}]\n`;
  try {
    mkdirSync(join(sandbox, 'scripts'), { recursive: true });
    writeFileSync(join(sandbox, 'scripts', 'hero.gd'), 'class_name Hero\nextends Node\n');
    writeFileSync(join(sandbox, 'scripts', 'plain.gd'), 'extends Node\n');

    assert.deepEqual(
      staleClassNames(sandbox),
      ['Hero'],
      'with no cache at all the engine knows no class_name, so every declaration is stale',
    );

    mkdirSync(join(sandbox, '.godot'), { recursive: true });
    writeFileSync(cache, entry('Hero', 'res://scripts/hero.gd'));
    assert.deepEqual(staleClassNames(sandbox), [], 'a cache listing it where it is is current');

    // The half a name check misses: the class was moved, the cache still names it, and the
    // engine loads the script that is no longer there.
    writeFileSync(cache, entry('Hero', 'res://old/hero.gd'));
    assert.deepEqual(
      staleClassNames(sandbox),
      ['Hero'],
      'a cache recording it at a path it has left is stale, not current',
    );

    writeFileSync(join(sandbox, 'scripts', 'squire.gd'), 'class_name Squire\nextends Hero\n');
    writeFileSync(cache, entry('Hero', 'res://scripts/hero.gd'));
    assert.deepEqual(staleClassNames(sandbox), ['Squire'], 'and a declaration written since is too');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/**
 * No project named means the one you are standing in, and only if it is one.
 *
 * `doctor` is the command to prove it with: it reads the project directory and starts no engine,
 * so this holds on a machine with no Godot on it. The refusal matters as much as the default,
 * because a command that acts on the working directory has to be sure what the working directory
 * is before it acts.
 */
function testProjectDefaultsToTheWorkingDirectory(): void {
  const sandbox = mkdtempSync(join(tmpdir(), 'gdharness-cwd-'));
  const project = join(sandbox, 'game');
  const elsewhere = join(sandbox, 'not-a-project');
  const cli = (cwd: string): { status: number | null; output: string } => {
    const run = spawnSync(process.execPath, [join(process.cwd(), 'build', 'cli.js'), 'doctor'], {
      encoding: 'utf8',
      cwd,
      timeout: 60000,
    });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  };
  try {
    mkdirSync(project, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(project, 'project.godot'), 'config_version=5\n');

    const here = cli(project);
    assert.match(
      here.output,
      /addons\/gdharness_editor is not installed/,
      `doctor with no argument should report on the directory it ran in: ${here.output}`,
    );

    // A flag where the path used to be. With the directory optional this is the natural thing to
    // type, and it is what the install guide tells people to run; taken positionally, `--json`
    // was resolved as a directory and the command refused itself.
    const flagged = spawnSync(
      process.execPath,
      [join(process.cwd(), 'build', 'cli.js'), 'doctor', '--json'],
      { encoding: 'utf8', cwd: project, timeout: 60000 },
    );
    // Parsing at all is half the assertion: a flag taken as the path refuses with a sentence.
    // The directory it settled on is compared by name rather than in full, because the spelling
    // of a temporary directory is the platform's business: macOS resolves /var/folders to
    // /private/var/folders, and a Windows runner reports Temp under an 8.3 short name.
    const report: unknown = JSON.parse(flagged.stdout);
    assert.equal(
      basename(text(get(report, 'projectPath'))),
      'game',
      `a flag is not a path: ${flagged.stdout}${flagged.stderr}`,
    );
    assert.ok(
      asArray(get(report, 'problems')).length > 0,
      'and the report is about that project, not an empty answer',
    );

    // A flag nobody recognises stops the command before it starts. `setup --curser` used to
    // install the addons, enable the plugins, register the autoload and rebuild the class list,
    // and refuse the option afterwards, leaving the project half configured.
    for (const typo of [
      ['setup', '--curser'],
      ['doctor', '--jsonn'],
      ['uninstall', '--claude'],
    ]) {
      const refused = spawnSync(process.execPath, [join(process.cwd(), 'build', 'cli.js'), ...typo], {
        encoding: 'utf8',
        cwd: project,
        timeout: 60000,
      });
      assert.match(
        `${refused.stdout}${refused.stderr}`,
        /Unknown option/,
        `${typo.join(' ')} should be refused`,
      );
      assert.equal(refused.status, 2, 'as a usage error');
      assert.ok(
        !existsSync(join(project, 'addons')),
        `${typo.join(' ')} should have written nothing before refusing`,
      );
    }

    const nowhere = cli(elsewhere);
    assert.match(
      nowhere.output,
      /Not a Godot project/,
      `and refuse where there is no project.godot: ${nowhere.output}`,
    );
    // 2 is what a usage error exits with, as against 1 for a project that has problems: telling
    // the two apart is the point, because only one of them means "you are in the wrong place".
    assert.equal(nowhere.status, 2, 'as a usage error rather than a project with problems');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/**
 * The ordering an update notice is decided by.
 *
 * Getting this wrong in either direction is bad in its own way: too eager and every session is
 * told to install something it already has, too shy and a release goes unmentioned forever.
 */
function testVersionOrdering(): void {
  const newer: [string, string][] = [
    ['0.4.3', '0.4.2'],
    ['0.5.0', '0.4.9'],
    ['1.0.0', '0.99.99'],
    ['0.4.10', '0.4.9'],
    ['1.0.0', '1.0.0-rc.1'],
  ];
  for (const [candidate, current] of newer) {
    assert.ok(isNewer(candidate, current), `${candidate} should count as newer than ${current}`);
  }
  const notNewer: [string, string][] = [
    ['0.4.2', '0.4.2'],
    ['0.4.1', '0.4.2'],
    ['0.4.2-rc.1', '0.4.2'],
    ['0.4.2+build.7', '0.4.2'],
    ['0.9.9', '1.0.0'],
  ];
  for (const [candidate, current] of notNewer) {
    assert.ok(!isNewer(candidate, current), `${candidate} should not count as newer than ${current}`);
  }
}

/**
 * A test run writes its saves nowhere near the ones somebody keeps.
 *
 * Godot resolves `user://` from the environment, so a suite that saves a game writes into the same
 * folder as the copy of that game being played. Found by using this server on a project whose own
 * gate had been overriding these two variables for months to keep its test tier out of the saves
 * directory, which is a workaround every project would otherwise have to find for itself.
 */
function testATestRunKeepsOutOfThePlayersSaves(): void {
  const home = join(tmpdir(), 'gdharness-tests-fixture');
  const theirs = { AppData: join('C', 'Users', 'somebody', 'AppData', 'Roaming'), TERM: 'dumb' };
  const environment = userDataIn(home, theirs);

  assert.equal(environment['APPDATA'], home, 'Windows reads the user directory out of APPDATA');
  assert.equal(environment['XDG_DATA_HOME'], home, 'and Linux out of XDG_DATA_HOME');
  assert.equal(environment['TERM'], 'dumb', 'everything else is the environment we were handed');
  assert.deepEqual(
    Object.keys(environment).filter((name) => name.toLowerCase() === 'appdata'),
    ['APPDATA'],
    'and a machine spelling it another way is left holding one of it rather than two',
  );
}

/**
 * A game is found wherever it announced itself, not only where this server would have.
 *
 * The two sides derive the path the same way and do not share an environment, which is the whole
 * bug: a game is started by the editor and inherits its variables, not the server's. Measured on
 * Windows, where an editor opened without TMP or TEMP set put its games in the Windows directory
 * while the server watched the user's and answered that no game was running.
 */
function testAGameIsFoundWhereverItAnnounced(): void {
  const withOverride = runtimeDirectories({ GDHARNESS_RUNTIME_DIR: join(tmpdir(), 'chosen') });
  assert.equal(withOverride[0], resolve(join(tmpdir(), 'chosen')), 'an explicit directory leads');

  const directories = runtimeDirectories({});
  assert.ok(directories.length > 1, 'and the places a differently started editor would put one follow');
  assert.equal(new Set(directories).size, directories.length, 'each listed once');
  for (const directory of directories) {
    assert.equal(basename(directory), 'gdharness', `${directory} is a gdharness directory`);
  }

  const root = mkdtempSync(join(tmpdir(), 'gdharness-announce-'));
  try {
    const elsewhere = join(root, 'elsewhere', 'gdharness');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(
      join(elsewhere, `runtime-${process.pid}.json`),
      JSON.stringify({
        protocol: 2,
        pid: process.pid,
        port: 51_234,
        address: '127.0.0.1',
        project: { name: 'Fixture', path: root },
      }),
      'utf8',
    );

    const empty = join(root, 'empty', 'gdharness');
    assert.deepEqual(discoverRuntimes([empty]), [], 'the directory this server watches holds nothing');
    const found = discoverRuntimes([empty, elsewhere]);
    assert.equal(found.length, 1, 'and the one the editor actually used is read as well');
    assert.equal(found[0]?.port, 51_234);
    assert.equal(
      discoverRuntimes([elsewhere, elsewhere]).length,
      1,
      'a game announced once is one game however many directories are searched',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * A game too new to talk to is still a game, and its announcement survives being read.
 *
 * The failure this stops is quiet and it is the upgrade path's own doing. `setup.py` writes the
 * new addon the moment a pin moves; the server a session already spawned stays as it was until the
 * harness reconnects, so every upgrade has a window where the game speaks a protocol the server
 * does not. The older server used to delete that announcement on the way past and answer that
 * nobody was playing anything, which is the one answer that is certainly false, and the deletion
 * took the game away from the newer server about to replace it as well.
 */
function testAGameTooNewToTalkToIsStillAGame(): void {
  const root = mkdtempSync(join(tmpdir(), 'gdharness-unspoken-'));
  try {
    const directory = join(root, 'gdharness');
    mkdirSync(directory, { recursive: true });
    const announcement = join(directory, `runtime-${process.pid}.json`);
    writeFileSync(
      announcement,
      JSON.stringify({
        protocol: RUNTIME_PROTOCOL + 1,
        pid: process.pid,
        port: 51_235,
        address: '127.0.0.1',
        project: { name: 'Fixture', path: root },
      }),
      'utf8',
    );

    const announced = runtimesAnnounced([directory]);

    assert.deepEqual(announced.running, [], 'there is nothing this server can talk to');
    assert.equal(announced.unspoken.length, 1, 'but the game is reported rather than dropped');
    assert.equal(announced.unspoken[0]?.protocol, RUNTIME_PROTOCOL + 1);
    assert.ok(existsSync(announcement), 'and its announcement is still there for the next server');

    const choice = chooseRuntime(announced.running, undefined, announced.unspoken);
    assert.ok('problem' in choice, 'the call still fails');
    const problem = 'problem' in choice ? choice.problem : '';
    assert.ok(!problem.includes('No game'), `the answer does not claim nobody is playing: ${problem}`);
    assert.ok(problem.includes('this server is the older half'), `it names the older half: ${problem}`);

    // The check earning its keep: a dead process's announcement is still rubbish, and is still
    // swept. Without this the one above passes on a function that never deletes anything.
    const dead = join(directory, 'runtime-999999999.json');
    writeFileSync(dead, '{}', 'utf8');
    runtimesAnnounced([directory]);
    assert.ok(!existsSync(dead), 'an announcement nobody is behind is still deleted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * A version mismatch sends the reader at whichever half is actually behind.
 *
 * Both directions happen, and the second is the one that got told to do the wrong thing: upgrading
 * a project mid-session writes the new addon while the harness carries on spawning the server it
 * already started, so the editor holds the newer half and restarting it widens the gap.
 */
function testTheStaleHalfIsNamedCorrectly(): void {
  assert.equal(addonMismatch('0.5.0', '0.5.0'), undefined, 'agreeing versions say nothing');

  const behind = addonMismatch('0.4.2', '0.5.0') ?? '';
  assert.match(behind, /editor_launch restart/, 'an old editor is restarted');
  assert.doesNotMatch(behind, /reconnect/, 'and reconnecting the server would not help it');

  const ahead = addonMismatch('0.6.0', '0.5.0') ?? '';
  assert.match(ahead, /reconnect/, 'an old server is reconnected');
  assert.doesNotMatch(ahead, /editor_launch restart/, 'and restarting the editor would widen it');
  assert.match(ahead, /0\.6\.0/, 'naming the version the harness should be spawning');

  const unversioned = addonMismatch('', '0.5.0') ?? '';
  assert.match(unversioned, /before versions were reported/, 'a pre-0.4.0 addon is named as one');
  assert.match(unversioned, /editor_launch restart/, 'and it is the old half by definition');
  assert.equal(addonMismatch(undefined, '0.5.0'), unversioned, 'so is a bridge reporting nothing');
}

/**
 * The update notice reaches the agent, once, and says what to do about it.
 *
 * Driven off a seeded cache rather than the registry: the point is the answer a tool carries, and
 * a fixture that needs the network to make that assertion is one that fails on a train. A fresh
 * timestamp is also what stops the server making a request during the test.
 */
async function testUpdateNoticeRidesOnAnAnswer(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gdharness-update-home-'));
  const environment = { HOME: home, LOCALAPPDATA: home, XDG_CACHE_HOME: home };
  try {
    writeFileSync(
      cacheFile(environment),
      JSON.stringify({ checkedAt: Date.now(), latest: '99.9.9' }),
      'utf8',
    );
    await withStdioServer(async (call) => {
      const first = await call('editor_status', {});
      assert.match(first, /update_available/, 'the first answer should carry the notice');
      assert.match(first, /99\.9\.9/, 'naming the version that is out');
      assert.match(first, /releases\/tag\/v99\.9\.9/, 'and where the notes for it are');
      // Under the runner that is actually running, and with no path: the reader who installed
      // with bunx may have no Node, and upgrade takes the directory it is run in.
      assert.match(
        first,
        /(?:npx -y|bunx) gdharness@99\.9\.9 upgrade/,
        'and the command that takes it, spelled for this runtime',
      );
      assert.doesNotMatch(first, /upgrade <project>/, 'without a placeholder path to fill in');

      assert.doesNotMatch(
        await call('editor_status', {}),
        /update_available/,
        'and the next answer should not repeat it',
      );
    }, environment);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * The check can be turned off, and off means no cache is even read.
 *
 * It is one request to one host and nothing about the project goes with it, but a dev machine
 * that is not supposed to talk to the internet is a real thing, and a switch that only silences
 * the message would not be one.
 */
async function testUpdateCheckHasAnOffSwitch(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gdharness-update-off-'));
  const environment = {
    HOME: home,
    LOCALAPPDATA: home,
    XDG_CACHE_HOME: home,
    GDHARNESS_NO_UPDATE_CHECK: '1',
  };
  try {
    writeFileSync(
      cacheFile(environment),
      JSON.stringify({ checkedAt: Date.now(), latest: '99.9.9' }),
      'utf8',
    );
    await withStdioServer(async (call) => {
      assert.doesNotMatch(
        await call('editor_status', {}),
        /update_available/,
        'GDHARNESS_NO_UPDATE_CHECK should stop the notice as well as the request',
      );
    }, environment);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * The engine's argument list is not visible from any response, so it is asserted directly.
 * No -d in either branch: the local debugger it turns on breaks into a `debug>` prompt on the
 * first script error and, with no stdin to read a command from, loops on that prompt forever.
 */
function testRunArgumentsLeaveTheLocalDebuggerOff(): void {
  assert.deepEqual(runArguments({ projectPath: '/p', headless: true, scene: null }), [
    '--headless',
    '--path',
    '/p',
  ]);
  assert.deepEqual(runArguments({ projectPath: '/p', headless: false, scene: null }), ['--path', '/p']);

  // editor_launch spawns detached with its output dropped, so the only thing that can be
  // asserted about it is the argv, and the only thing that can go wrong quietly is the argv.
  assert.deepEqual(editorArguments('/p'), ['-e', '--path', '/p']);
  // The scene as a res:// path and last: the engine reads it positionally, so text beginning
  // with a dash would otherwise be another option to it.
  assert.deepEqual(runArguments({ projectPath: '/p', headless: false, scene: 'scenes/-odd.tscn' }), [
    '--path',
    '/p',
    'res://scenes/-odd.tscn',
  ]);
  // A boot check quits on its own, and the option goes before the scene for the same reason.
  assert.deepEqual(runArguments({ projectPath: '/p', headless: true, scene: 'a.tscn', quitAfter: 3 }), [
    '--headless',
    '--path',
    '/p',
    '--quit-after',
    '3',
    'res://a.tscn',
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
        assert.equal(get(JSON.parse(updated), 'saved'), true, updated);
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

        // Detail levels, while the project still has something to complain about: summary names
        // the finding, full says what to do about it, and the two have to differ or the argument
        // is decoration.
        const complaint = async (detail: string): Promise<unknown> =>
          JSON.parse(
            await call(
              'project_info',
              { projectPath: projectDir, include: ['validation'], detail },
              ENGINE_CALL_TIMEOUT_MS,
            ),
          );
        const finding = (report: unknown): unknown =>
          asArray(get(report, 'validation', 'issues')).find((issue) => get(issue, 'check') === 'main_scene');
        const summarised = finding(await complaint('summary'));
        const full = finding(await complaint('full'));
        assert.ok(summarised, 'a project with no main scene should be an issue at either detail');
        assert.equal(get(summarised, 'suggestion'), undefined, 'summary should stop at the finding');
        assert.match(text(get(full, 'suggestion')), /Main Scene/, 'and full should say what to do');

        // Export presets, which this project has none of: the answer is that there are none,
        // rather than an empty list that reads the same as a project with no presets configured.
        const presets: unknown = JSON.parse(
          await call('project_export', { projectPath: projectDir, op: 'list' }, ENGINE_CALL_TIMEOUT_MS),
        );
        assert.equal(get(presets, 'presets_file_exists'), false, JSON.stringify(presets));
        assert.match(text(get(presets, 'note')), /No export_presets\.cfg/);

        // The boot check. With no main scene the engine would block on a modal box rather than
        // exit, so that is refused before anything is spawned.
        const noScene = await call(
          'editor_run',
          { projectPath: projectDir, op: 'check' },
          ENGINE_CALL_TIMEOUT_MS,
        );
        assert.match(noScene, /no main scene/, `a project with nothing to run is refused: ${noScene}`);

        // Then a project that comes up clean, then the same project with an autoload that cannot
        // parse, which is the one kind of break a green test tier never sees.
        writeFileSync(
          join(projectDir, 'main.tscn'),
          '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n',
        );
        const chosen = await call(
          'project_settings',
          { projectPath: projectDir, op: 'set_main_scene', scenePath: 'main.tscn' },
          ENGINE_CALL_TIMEOUT_MS,
        );
        assert.equal(get(JSON.parse(chosen), 'new_main_scene'), 'res://main.tscn', chosen);
        const clean: unknown = JSON.parse(
          await call('editor_run', { projectPath: projectDir, op: 'check' }, ENGINE_CALL_TIMEOUT_MS),
        );
        assert.equal(get(clean, 'booted'), true, `a bare project boots clean: ${JSON.stringify(clean)}`);
        assert.equal(get(clean, 'exitCode'), 0);
        assert.equal(get(clean, 'errors'), 0);
        assert.equal(get(clean, 'hung'), false);

        // The audio bus layout lives in a file the engine loads at startup, and each of these
        // is a separate engine process: the name and the volume have to survive between them.
        // The name once did not, because the operation read a spelling the server never sent.
        const bus: unknown = JSON.parse(
          await call(
            'project_settings',
            { projectPath: projectDir, op: 'add_audio_bus', busName: 'Music' },
            ENGINE_CALL_TIMEOUT_MS,
          ),
        );
        assert.equal(get(bus, 'bus', 'name'), 'Music', JSON.stringify(bus));
        const busIndex = asNumber(get(bus, 'bus', 'index'));
        const quieter: unknown = JSON.parse(
          await call(
            'project_settings',
            { projectPath: projectDir, op: 'set_audio_bus_volume', busIndex, volumeDb: -6 },
            ENGINE_CALL_TIMEOUT_MS,
          ),
        );
        assert.equal(get(quieter, 'bus', 'name'), 'Music', JSON.stringify(quieter));
        const listed: unknown = JSON.parse(
          await call(
            'project_info',
            { projectPath: projectDir, include: ['audio_buses'] },
            ENGINE_CALL_TIMEOUT_MS,
          ),
        );
        const music = asArray(get(listed, 'audio_buses', 'buses')).find(
          (entry) => get(entry, 'name') === 'Music',
        );
        assert.ok(music, `the bus is still there in a fresh process:\n${JSON.stringify(listed, null, 2)}`);
        assert.equal(asNumber(get(music, 'volume_db')), -6, 'and so is its volume');
        assert.equal(get(listed, 'mainScene'), 'res://main.tscn');

        writeFileSync(
          join(projectDir, 'broken.gd'),
          'extends Node\n\nfunc _ready() -> void:\n\tthis is not gdscript\n',
        );
        writeFileSync(
          join(projectDir, 'project.godot'),
          `${readFileSync(join(projectDir, 'project.godot'), 'utf8')}\n[autoload]\n\nBroken="*res://broken.gd"\n`,
        );
        const broken: unknown = JSON.parse(
          await call('editor_run', { projectPath: projectDir, op: 'check' }, ENGINE_CALL_TIMEOUT_MS),
        );
        assert.equal(
          get(broken, 'booted'),
          false,
          `a broken autoload fails the boot: ${JSON.stringify(broken)}`,
        );
        assert.ok(asNumber(get(broken, 'errors')) > 0, 'the parse error is counted');
        const mentions = asArray(get(broken, 'entries')).filter(
          (entry) =>
            get(entry, 'severity') === 'error' &&
            [text(get(entry, 'text')), ...asArray(get(entry, 'detail')).map(text)].some((line) =>
              line.includes('broken.gd'),
            ),
        );
        assert.ok(mentions.length > 0, `the error names the script:\n${JSON.stringify(broken, null, 2)}`);
      },
      { GODOT_PATH: godotPath },
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

/**
 * project_test against a real gdUnit4: a suite with a pass, a failure and a skip, read back as
 * cases rather than a console. The failing case has to be named with what the assertion said,
 * a project without the runner has to be refused, and nothing of the run may be left behind.
 */
async function testGdUnitRunner(): Promise<void> {
  const godotPath = resolveGodotPath();
  const gdunit = process.env['GDUNIT4_PATH'];
  if (!godotPath || !gdunit || !existsSync(join(gdunit, 'bin', 'GdUnitCmdTool.gd'))) {
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and GODOT_PATH or GDUNIT4_PATH names nothing usable.');
    }
    console.log('gdUnit4 runner regression skipped (Godot or gdUnit4 not found)');
    return;
  }

  const projectDir = mkdtempSync(join(tmpdir(), 'gdharness-gdunit-'));
  try {
    writeFileSync(
      join(projectDir, 'project.godot'),
      '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="GdUnitRegression"\n',
    );
    mkdirSync(join(projectDir, 'test'));
    writeFileSync(
      join(projectDir, 'test', 'sums_test.gd'),
      [
        'extends GdUnitTestSuite',
        '',
        '',
        'func test_two_and_two() -> void:',
        '\tassert_int(2 + 2).is_equal(4)',
        '',
        '',
        'func test_two_and_two_is_not_five() -> void:',
        '\tassert_int(2 + 2).is_equal(5)',
        '',
        '',
        'func test_skipped_for_now(_do_skip: bool = true, _skip_reason: String = "not today") -> void:',
        '\tassert_bool(true).is_true()',
        '',
      ].join('\n'),
    );

    await withStdioServer(
      async (call) => {
        const missing = await call('project_test', { projectPath: projectDir }, ENGINE_CALL_TIMEOUT_MS);
        assert.match(missing, /gdUnit4 is not installed/, missing);

        cpSync(gdunit, join(projectDir, 'addons', 'gdUnit4'), { recursive: true });
        const run: unknown = JSON.parse(
          await call('project_test', { projectPath: projectDir }, ENGINE_CALL_TIMEOUT_MS * 3),
        );
        assert.equal(get(run, 'passed'), false, JSON.stringify(run, null, 2));
        assert.equal(get(run, 'verdict'), 'failures');
        assert.deepEqual(
          {
            tests: get(run, 'tests'),
            failures: get(run, 'failures'),
            errors: get(run, 'errors'),
            skipped: get(run, 'skipped'),
          },
          { tests: 3, failures: 1, errors: 0, skipped: 1 },
        );
        const [failed] = asArray(get(run, 'failed'));
        assert.equal(get(failed, 'name'), 'test_two_and_two_is_not_five');
        assert.equal(get(failed, 'path'), 'res://test/sums_test.gd');
        assert.match(text(get(failed, 'message')), /sums_test\.gd:9/);
        assert.match(text(get(failed, 'detail')), /Expecting:\s+5\s+but was\s+4/);
        assert.ok(
          asArray(get(run, 'classes', 'added')).includes('GdUnitTestCIRunner'),
          'the runner was made resolvable by the class list rebuild',
        );
        assert.equal(
          existsSync(join(projectDir, '.godot', 'gdharness-reports')),
          false,
          'the report is cleaned up',
        );

        const only: unknown = JSON.parse(
          await call(
            'project_test',
            { projectPath: projectDir, ignore: ['sums_test:test_two_and_two_is_not_five'] },
            ENGINE_CALL_TIMEOUT_MS * 3,
          ),
        );
        assert.equal(get(only, 'passed'), true, JSON.stringify(only, null, 2));
        assert.equal(get(only, 'tests'), 2);
      },
      { GODOT_PATH: godotPath },
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

/**
 * The CLI against a real engine: setup puts the addons in and turns the editor ones on,
 * runtime on and off registers and removes the autoload, and doctor says so, then says what
 * is wrong once something is.
 */
function testCommandLineSetup(): void {
  const godotPath = resolveGodotPath();
  if (!godotPath) {
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and GODOT_PATH names no existing file.');
    }
    console.log('command line setup regression skipped (Godot not found)');
    return;
  }

  const projectDir = mkdtempSync(join(tmpdir(), 'gdharness-cli-'));
  const cli = (...cliArgs: string[]): { status: number | null; stdout: string; stderr: string } => {
    const run = spawnSync(process.execPath, ['build/cli.js', ...cliArgs], {
      encoding: 'utf8',
      timeout: 180000,
      env: { ...process.env, GODOT_PATH: godotPath },
    });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  };
  try {
    writeFileSync(
      join(projectDir, 'project.godot'),
      '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="CliRegression"\n',
    );

    const before = cli('doctor', projectDir);
    assert.equal(before.status, 1, `doctor fails a bare project:\n${before.stdout}${before.stderr}`);
    assert.match(before.stdout, /addons\/gdharness_editor is not installed/);

    const setup = cli('setup', projectDir);
    assert.equal(setup.status, 0, `setup:\n${setup.stdout}${setup.stderr}`);
    for (const addon of ['gdharness_editor', 'gdharness_runtime', 'auto_reload']) {
      assert.ok(existsSync(join(projectDir, 'addons', addon, '.gdharness-version')), `${addon} is installed`);
    }
    const written = readFileSync(join(projectDir, 'project.godot'), 'utf8');
    assert.match(written, /res:\/\/addons\/gdharness_editor\/plugin\.cfg/, 'the editor plugin is enabled');
    assert.match(written, /res:\/\/addons\/auto_reload\/plugin\.cfg/, 'and auto reload');
    assert.match(
      written,
      /GdharnessRuntime="\*res:\/\/addons\/gdharness_runtime\/runtime_autoload\.gd"/,
      'the runtime autoload is registered, in this project and nowhere else',
    );
    assert.match(setup.stdout, /gdharness runtime off/, 'and setup says how to take it out of an export');

    const healthy = cli('doctor', projectDir, '--json');
    assert.equal(healthy.status, 0, `doctor after setup:\n${healthy.stdout}${healthy.stderr}`);
    const report: unknown = JSON.parse(healthy.stdout);
    assert.deepEqual(get(report, 'problems'), []);
    assert.equal(get(report, 'runtimeAutoload'), true);

    assert.equal(cli('runtime', 'off', projectDir).status, 0);
    assert.doesNotMatch(readFileSync(join(projectDir, 'project.godot'), 'utf8'), /GdharnessRuntime/);
    assert.equal(get(JSON.parse(cli('doctor', projectDir, '--json').stdout), 'runtimeAutoload'), false);
    assert.equal(cli('runtime', 'on', projectDir).status, 0);
    assert.match(
      readFileSync(join(projectDir, 'project.godot'), 'utf8'),
      /GdharnessRuntime="\*res:\/\/addons\/gdharness_runtime\/runtime_autoload\.gd"/,
    );

    // The opt-out, in its own project, because the flag only means anything on a fresh install.
    const bare = mkdtempSync(join(tmpdir(), 'gdharness-cli-bare-'));
    try {
      writeFileSync(
        join(bare, 'project.godot'),
        '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="NoRuntime"\n',
      );
      const withoutRuntime = cli('setup', bare, '--no-runtime');
      assert.equal(withoutRuntime.status, 0, `setup --no-runtime:\n${withoutRuntime.stdout}`);
      assert.doesNotMatch(readFileSync(join(bare, 'project.godot'), 'utf8'), /GdharnessRuntime/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }

    // An upgrade puts the same things back in the same places. It once wrote the skill into every
    // directory any harness could read it from, rather than the ones an install chose, so running
    // it created two directories that setup had deliberately not created. Nothing new appears.
    const skillDirs = (): string[] =>
      ['.agents', '.claude', '.github', '.cursor', '.kiro', '.cline', '.opencode']
        .map((dir) => join(projectDir, dir, 'skills', 'gdharness'))
        .filter((path) => existsSync(path))
        .sort();
    const beforeUpgrade = skillDirs();
    const upgraded = cli('upgrade', projectDir);
    assert.equal(upgraded.status, 0, `upgrade:\n${upgraded.stdout}${upgraded.stderr}`);
    assert.deepEqual(
      skillDirs(),
      beforeUpgrade,
      'an upgrade should write the skill where the install put it, and nowhere else',
    );
    assert.equal(get(JSON.parse(cli('doctor', projectDir, '--json').stdout), 'runtimeAutoload'), true);

    // A class written after the cache was built is what doctor is for.
    writeFileSync(join(projectDir, 'late.gd'), 'class_name LateArrival\nextends Node\n');
    const stale = cli('doctor', projectDir);
    assert.equal(stale.status, 1, 'a stale class cache is a problem');
    assert.match(stale.stdout, /class cache: stale for LateArrival/);
    assert.equal(cli('classes', projectDir).status, 0);
    assert.equal(cli('doctor', projectDir).status, 0, 'and rebuilding it is the cure');

    // Everything back out, with the reader's own file left holding what was theirs.
    const shared = join(projectDir, '.cursor', 'mcp.json');
    mkdirSync(dirname(shared), { recursive: true });
    writeFileSync(shared, JSON.stringify({ mcpServers: { other: { command: 'theirs' } } }), 'utf8');
    assert.equal(cli('setup', projectDir, '--cursor').status, 0);
    assert.ok(existsSync(join(projectDir, '.agents', 'skills', 'gdharness', 'SKILL.md')), 'the skill is in');

    const removed = cli('uninstall', projectDir);
    assert.equal(removed.status, 0, `uninstall:\n${removed.stdout}${removed.stderr}`);
    for (const addon of ['gdharness_editor', 'gdharness_runtime', 'auto_reload']) {
      assert.equal(existsSync(join(projectDir, 'addons', addon)), false, `${addon} is gone`);
    }
    const stripped = readFileSync(join(projectDir, 'project.godot'), 'utf8');
    assert.doesNotMatch(stripped, /GdharnessRuntime/, 'the autoload is gone');
    assert.doesNotMatch(stripped, /gdharness_editor\/plugin\.cfg/, 'and the editor plugin is off');
    assert.equal(existsSync(join(projectDir, '.agents')), false, 'the directory the skill made is gone');
    const theirs = JSON.parse(readFileSync(shared, 'utf8')) as Record<string, Record<string, unknown>>;
    assert.deepEqual(theirs['mcpServers'], { other: { command: 'theirs' } }, 'their server survives ours');

    // Twice. The engine refuses to remove an autoload that is not registered and to disable a
    // plugin that is not enabled, so a second uninstall failed where the first had succeeded, and
    // one on a project that never had gdharness failed outright while reporting removals it had
    // not made.
    const again = cli('uninstall', projectDir);
    assert.equal(again.status, 0, `a second uninstall:\n${again.stdout}${again.stderr}`);
    assert.match(again.stdout, /Nothing of gdharness was in this project/, 'and says so plainly');
    assert.doesNotMatch(again.stdout, /autoload removed/, 'rather than reporting work it did not do');
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

/**
 * Whether a program answers `--version`, which both runners do.
 *
 * A Windows `.cmd` is a script rather than an image, so CreateProcess refuses it and it has to go
 * through the command interpreter. Its path holds a space on every GitHub runner, so the line is
 * quoted and handed over verbatim rather than left to be re-split.
 */
function answersVersion(command: string): SpawnSyncReturns<string> {
  const options = { encoding: 'utf8' as const, timeout: 60000 };
  if (process.platform === 'win32' && command.toLowerCase().endsWith('.cmd')) {
    return spawnSync(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', `"${command}" --version`], {
      ...options,
      windowsVerbatimArguments: true,
    });
  }
  return spawnSync(command, ['--version'], options);
}

/**
 * What setup wrote into a harness config is a program the operating system can start.
 *
 * Everything else about an install can be right while this one thing is wrong, and then setup
 * reports success and the harness silently starts nothing: it spawns what the config names, the
 * way the system does, through PATH. `bunx` went in as a bare name and a Bun installed under a
 * project ships no `bunx` beside its `bun`, so the entry named a program that was not there.
 *
 * The unit test covers which spelling each runner gets. This covers the only claim that matters
 * to somebody who ran the documented line: the thing in their config starts.
 */
function testTheWrittenConfigNamesAProgramThatStarts(): void {
  const godotPath = resolveGodotPath();
  if (!godotPath) {
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and GODOT_PATH names no existing file.');
    }
    console.log('written config regression skipped (Godot not found)');
    return;
  }

  const projectDir = mkdtempSync(join(tmpdir(), 'gdharness-config-'));
  try {
    writeFileSync(
      join(projectDir, 'project.godot'),
      '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="ConfigRegression"\n',
    );

    const setup = spawnSync(process.execPath, ['build/cli.js', 'setup', projectDir, '--claude-code'], {
      encoding: 'utf8',
      timeout: 180000,
      env: { ...process.env, GODOT_PATH: godotPath },
    });
    assert.equal(setup.status, 0, `setup --claude-code:\n${setup.stdout}${setup.stderr}`);

    const written: unknown = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8'));
    const entry = get(get(written, 'mcpServers'), 'gdharness');
    const command = text(get(entry, 'command'));
    const spawnArgs = asArray(get(entry, 'args')).map((one) => text(one));

    assert.ok(
      isAbsolute(command) && existsSync(command),
      `the runner that installed us should be named by its path, got ${command}`,
    );
    assert.match(
      spawnArgs.at(-1) ?? '',
      /^gdharness@\d+\.\d+\.\d+/,
      `and the pinned version should be the last argument, got ${JSON.stringify(spawnArgs)}`,
    );

    // Starting it is the assertion the bug would have failed: every runner answers --version, and
    // one that is not there answers nothing at all.
    const started = answersVersion(command);
    assert.equal(started.status, 0, `${command} --version: ${started.error?.message ?? started.stderr}`);

    const godotForTheServer = text(get(get(entry, 'env'), 'GODOT_PATH'));
    assert.ok(
      isAbsolute(godotForTheServer) && existsSync(godotForTheServer),
      `and the engine it carries should exist, got ${godotForTheServer}`,
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}

/** The first group of a match, which a pattern written with one group always has. */
function captured(match: RegExpMatchArray): string {
  return match[1] ?? '';
}

/** A tool's argument name as the engine operations spell it, which is the one rule between them. */
function snakeCased(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** The names in one table of a GDScript file, by the shape that table is written in. */
function namesIn(path: string, pattern: RegExp, what: string, least: number): Set<string> {
  const found = new Set([...readFileSync(path, 'utf8').matchAll(pattern)].map(captured));
  // The reader is a regex over source, so it can come back empty for a table that was merely
  // reformatted, and an empty set agrees with everything. A floor is what makes it speak up.
  assert.ok(found.size >= least, `only ${found.size} of the ${what} were read from ${path}`);
  return found;
}

/** Every name the server sends, by the call that sends it, with its multi-line spellings. */
function namesSent(pattern: RegExp, what: string, least: number): Set<string> {
  const source = readFileSync('src/server.ts', 'utf8');
  const found = new Set([...source.matchAll(pattern)].map(captured));
  assert.ok(found.size >= least, `only ${found.size} of the ${what} were read from src/server.ts`);
  return found;
}

/**
 * Every name quoted in the arguments of one kind of call.
 *
 * Wider than reading the first argument, because the name is sometimes chosen in place: a
 * ternary, a section table, a template. Used only to ask whether anything reaches a name at
 * all, so reaching too far costs nothing but a name that would have been reported as dead.
 */
function namesPassedTo(opener: RegExp, what: string, least: number): Set<string> {
  const source = readFileSync('src/server.ts', 'utf8');
  const found = new Set<string>();
  for (const call of source.matchAll(opener)) {
    for (const quoted of source.slice(call.index, call.index + 200).matchAll(/'([a-z][a-z_]+)'/g)) {
      found.add(captured(quoted));
    }
  }
  assert.ok(found.size >= least, `only ${found.size} of the ${what} were read from src/server.ts`);
  return found;
}

/**
 * Every name the server sends is one the other end answers to, and every name the other end
 * answers to is one the server sends.
 *
 * Each side is covered on its own: the engine operations and the addon commands against a real
 * engine, the tools from the outside. The table between them is not, and it is three tables: a
 * misspelling in one of them is a tool that refuses at run time with every test on both sides
 * still green. The other direction matters as much, because a command nothing sends is dead
 * code no coverage report can see, GDScript being invisible to the dead-code linter.
 */
function testEveryDispatchedNameExistsOnBothSides(): void {
  const engine = namesIn(
    'src/godot/operations/godot_operations.gd',
    /^\t\t"([a-z_]+)":$/gm,
    'engine operations',
    30,
  );
  for (const [tool, operations] of Object.entries(HEADLESS_OPERATIONS)) {
    for (const [op, operation] of Object.entries(operations)) {
      assert.ok(
        engine.has(operation),
        `${tool} ${op} is dispatched to ${operation}, which the engine has not`,
      );
    }
  }
  const dispatched = new Set(Object.values(HEADLESS_OPERATIONS).flatMap((ops) => Object.values(ops)));
  // project_info's sections and the CLI reach operations no tool op names, so those are read
  // from the source that names them rather than assumed.
  const otherwise = namesPassedTo(/this\.(?:headless|operation)\(|operation: '/g, 'engine operations', 10);
  const fromCli = namesIn('src/cli.ts', /'([a-z_]+)'/g, 'names in the CLI', 5);
  for (const operation of engine) {
    assert.ok(
      dispatched.has(operation) || otherwise.has(operation) || fromCli.has(operation),
      `the engine answers ${operation}, which nothing asks for`,
    );
  }

  const addon = namesIn(
    'src/godot/addons/gdharness_editor/tool_executor.gd',
    /^\t\t"([a-z_]+)": \[/gm,
    'editor commands',
    25,
  );
  const bridged = namesSent(/(?:[Bb]ridge|invokeTool)\(\s*'([a-z_]+)'/g, 'editor commands', 25);
  for (const command of bridged) {
    assert.ok(addon.has(command), `the server sends ${command}, which the editor addon has not`);
  }
  for (const command of addon) {
    assert.ok(bridged.has(command), `the editor addon answers ${command}, which nothing sends`);
  }

  const runtime = namesIn(
    'src/godot/addons/gdharness_runtime/runtime_autoload.gd',
    /^\t\t"([a-z_]+)": (?:_ping|_[a-z]+\.[a-z_]+),$/gm,
    'runtime commands',
    15,
  );
  const asked = namesSent(
    /(?:handleRuntimeCommand|runtimeRequest)\([^,]*,?\s*'([a-z_]+)'/g,
    'runtime commands',
    6,
  );
  // runtime_input builds the command from the op, so the op list is what has to line up.
  const input = TOOL_SPECS.find((spec) => spec.name === 'runtime_input');
  assert.ok(input, 'runtime_input should be a tool');
  const injected = new Set(
    Object.keys(input.operations ?? {})
      .filter((op) => op !== 'click')
      .map((op) => `inject_${op}`),
  );
  const captured = new Set(['capture_screenshot', 'capture_viewport']);
  const sent = new Set([...asked, ...injected, ...captured]);
  for (const command of sent) {
    assert.ok(runtime.has(command), `the server sends ${command}, which the runtime addon has not`);
  }
  for (const command of runtime) {
    assert.ok(sent.has(command), `the runtime addon answers ${command}, which nothing sends`);
  }
}

/**
 * Every key an engine operation reads is one a tool can actually send.
 *
 * The conversion from the tool's arguments to the operation's is one rule for every operation,
 * so what breaks is not the rule but the spelling: an operation reading a name no tool declares
 * is a parameter that can never arrive, and it reads as a working tool with a setting that does
 * nothing. That has happened here once, to an audio bus name.
 */
function testEveryEngineParameterCanBeSent(): void {
  const dispatcher = readFileSync('src/godot/operations/godot_operations.gd', 'utf8');
  const files = new Map(
    [...dispatcher.matchAll(/const ([A-Za-z]+) = preload\("([a-z_]+\.gd)"\)/g)].map((match) => [
      captured(match),
      readFileSync(join('src/godot/operations', match[2] ?? ''), 'utf8'),
    ]),
  );

  const declared = new Set(
    [...readFileSync('src/tool-definitions.ts', 'utf8').matchAll(/^ {6}([A-Za-z]+):/gm)].map((match) =>
      snakeCased(captured(match)),
    ),
  );
  assert.ok(declared.size >= 40, `only ${declared.size} tool parameters were read`);
  // What the server adds on the way through, which no tool declares.
  const added = new Set(
    [...readFileSync('src/server.ts', 'utf8').matchAll(/\b([a-z][A-Za-z0-9]*): /g)].map((match) =>
      snakeCased(captured(match)),
    ),
  );

  let read = 0;
  for (const route of dispatcher.matchAll(
    /"([a-z_]+)":\s*\n[^\n]*?([A-Za-z]+)\.new\([^)]*\)\.([a-z_]+)\(/g,
  )) {
    const [, operation = '', module = '', method = ''] = route;
    const source = files.get(module);
    assert.ok(source, `${operation} is answered by ${module}, which is not preloaded`);
    const at = source.indexOf(`\nfunc ${method}(`);
    assert.ok(at !== -1, `${module} has no ${method} for ${operation}`);
    const next = source.indexOf('\nfunc ', at + 1);
    const body = source.slice(at, next === -1 ? source.length : next);
    for (const key of body.matchAll(/params(?:\.get\(|\[)"([a-z_]+)"/g)) {
      read += 1;
      const name = captured(key);
      assert.ok(
        declared.has(name) || added.has(name),
        `${operation} reads ${name}, which no tool parameter spells`,
      );
    }
  }
  assert.ok(read >= 40, `only ${read} parameter reads were found, so this proved little`);
}

/** The parameter names of one tool: the top-level keys of its own parameters block. */
function parametersOf(block: string): string[] {
  const open = block.indexOf('parameters: {');
  if (open === -1) return [];
  let depth = 0;
  let end = block.length;
  for (let at = block.indexOf('{', open); at < block.length; at += 1) {
    if (block[at] === '{') depth += 1;
    if (block[at] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = at;
        break;
      }
    }
  }
  return [...block.slice(open, end).matchAll(/^ {6}([A-Za-z]+):/gm)].map(captured);
}

/**
 * Every parameter a tool declares is read by something.
 *
 * The other half of the question above, and the one that reads as a working tool for longest:
 * a declared argument nothing looks at is a setting a caller can pass, watch accepted, and
 * never see obeyed. `scene_node` had one, and there was nothing to notice it with.
 */
/**
 * Every tool is named by a fixture, which is the rule this repository is built to and the claim
 * the README makes about it.
 *
 * Nothing held it before now: the consistency checks prove a tool's dispatch name exists on both
 * sides and that its arguments are read, all of which a tool nobody ever calls would pass. A tool
 * added with no fixture is the one shape of change this project says it does not ship.
 */
function testEveryToolIsDrivenSomewhere(): void {
  const fixtures = ['editor.ts', 'engine-gdscript.ts', 'bridge.ts', 'regressions.ts', 'smoke.ts']
    .map((name) => readFileSync(join('test', name), 'utf8'))
    .join('\n');
  const undriven = TOOL_SPECS.filter((spec) => !fixtures.includes(`'${spec.name}'`)).map((spec) => spec.name);
  assert.deepEqual(undriven, [], 'every tool should be called by a fixture, not only declared');
}

function testEveryToolParameterIsRead(): void {
  const named = new Set<string>();
  const snaked = new Set<string>();
  const remember = (source: string, pattern: RegExp, into: Set<string>): void => {
    for (const match of source.matchAll(pattern)) into.add(captured(match));
  };

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (path.endsWith('tool-definitions.ts')) continue;
      const source = (): string => readFileSync(path, 'utf8');
      // The addon is handed the arguments under the names the tool gave them; the headless
      // operations are handed them snake_cased, and those are the only files where that
      // spelling counts as a read.
      if (path.endsWith('.gd')) {
        remember(source(), /"([A-Za-z_]+)"/g, path.includes('operations') ? snaked : named);
      }
      if (path.endsWith('.ts')) {
        const code = source();
        remember(code, /read[A-Za-z]*\(\s*\w*[Aa]rgs\w*\s*,\s*'([A-Za-z]+)'/g, named);
        remember(code, /\w*[Aa]rgs\w*\[\s*'([A-Za-z]+)'\s*\]/g, named);
        remember(code, /\b(?:safeArgs|args|arguments_)\.([A-Za-z]+)\b/g, named);
        remember(code, /\{\s*(?:[A-Za-z]+(?:: \w+)?,\s*)*([A-Za-z]+)(?:: \w+)?[^}]*\}\s*=\s*args/g, named);
      }
    }
  };
  walk('src');
  assert.ok(named.size >= 40, `only ${named.size} argument reads were found, so this proved little`);

  const definitions = readFileSync('src/tool-definitions.ts', 'utf8');
  let checked = 0;
  for (const block of definitions.split(/\n {2}\{\n/)) {
    const tool = /name: '([a-z_]+)',/.exec(block)?.[1];
    if (tool === undefined) continue;
    for (const parameter of parametersOf(block)) {
      checked += 1;
      assert.ok(
        named.has(parameter) || snaked.has(snakeCased(parameter)),
        `${tool} declares ${parameter}, which nothing reads`,
      );
    }
  }
  assert.ok(checked >= 60, `only ${checked} tool parameters were checked, so this proved little`);
}

/**
 * Every script in an installed addon carries the `.uid` that fixes its identity.
 *
 * Godot 4.4 writes one beside each script and reads it back so a reference survives a rename.
 * An addon shipped without them is re-identified by whichever editor opens it: a warning per
 * script at every start, a different identity on every machine, and, because installing deletes
 * the directory and copies it again, the same warnings back after every upgrade. Fourteen of them
 * turned up in one project's console. The operations scripts run from outside a project, so
 * nothing scans them and they have none.
 */
function testEveryAddonScriptKeepsItsIdentity(): void {
  const scripts: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith('.gd')) {
        scripts.push(path);
      }
    }
  };
  walk('src/godot/addons');
  assert.ok(scripts.length >= 14, `only ${scripts.length} addon scripts were found, so this proved little`);

  const identities = new Map<string, string>();
  for (const script of scripts) {
    const beside = `${script}.uid`;
    assert.ok(existsSync(beside), `${script} ships without the ${basename(beside)} that names it`);
    const uid = readFileSync(beside, 'utf8').trim();
    assert.match(uid, /^uid:\/\/[0-9a-z]+$/, `${beside} should hold one uid:// line`);
    const taken = identities.get(uid);
    assert.equal(taken, undefined, `${script} and ${taken} both claim ${uid}`);
    identities.set(uid, script);
  }
}

async function main(): Promise<void> {
  testEveryAddonScriptKeepsItsIdentity();
  testEveryDispatchedNameExistsOnBothSides();
  testEveryEngineParameterCanBeSent();
  testEveryToolParameterIsRead();
  testEveryToolIsDrivenSomewhere();
  testStaleDisconnectRegression();
  testSceneToolsVectorRegression();
  testRunArgumentsLeaveTheLocalDebuggerOff();
  testHeadlessFollowsTheDisplay();
  testStaleClassesAreReadFromDisk();
  testProjectDefaultsToTheWorkingDirectory();
  testVersionOrdering();
  testTheStaleHalfIsNamedCorrectly();
  testAGameIsFoundWhereverItAnnounced();
  testAGameTooNewToTalkToIsStillAGame();
  testATestRunKeepsOutOfThePlayersSaves();
  await testParametersReachTheEngine();
  await testGdUnitRunner();
  testCommandLineSetup();
  testTheWrittenConfigNamesAProgramThatStarts();

  testProjectGodotMultilineValues();
  testProjectGodotResistsPrototypeKeys();

  await testEditorStatusPortConflict();
  await testTheBridgeTakesThePortWhenItIsFreed();
  await testAServerEndsWithAnEditorStillOnTheBridge();
  await testABadPortIsReported();
  await testDiagnosticsSurviveUriReEncoding();
  await testDiagnosticsSurviveAnotherSpellingOfTheSamePath();
  await testDiagnosticsTimeoutIsNotAnEmptyResult();
  await testLspFramesBodiesByBytes();
  await testLspReassemblesBodySplitMidCharacter();
  await testDapFramesBodiesByBytes();
  await testFramingCeilingFailsLoudly();
  testDictionariesHaveNothingBehindThem();
  testProjectPathsAreContained();
  await testToolAndOpLookupsCannotReachThePrototype();
  await testToolsRefusePathsOutsideTheProject();
  await testDebugToolsRefuseWithoutASession();
  await testUpdateNoticeRidesOnAnAnswer();
  await testUpdateCheckHasAnOffSwitch();
  console.log('regression tests passed');
}

await main();
