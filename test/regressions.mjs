#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { GodotDAPClient } from '../build/dap_client.js';
import { dictionary, emptyRecord } from '../build/dictionary.js';
import { createBridge } from '../build/godot-bridge.js';
import { GodotLSPClient } from '../build/lsp_client.js';
import { parseProjectGodot } from '../build/resources.js';

const INDEX_SOURCE = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const OPERATIONS_SOURCE = readFileSync(
  new URL('../src/godot/operations/godot_operations.gd', import.meta.url),
  'utf8',
);
const RUNTIME_SOURCE = readFileSync(
  new URL('../src/godot/addons/godot_mcp_runtime/mcp_runtime_autoload.gd', import.meta.url),
  'utf8',
);

function makeRequest(method, params, id) {
  return `${JSON.stringify({ jsonrpc: '2.0', method, params, id })}\n`;
}

async function waitForJsonLine(stream, predicate, timeoutMs = 15000) {
  let buffer = '';
  const start = Date.now();

  return await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (predicate(parsed)) {
            cleanup();
            resolve(parsed);
            return;
          }
        } catch {
          // ignore partial/non-json lines
        }
      }

      if (Date.now() - start > timeoutMs) {
        cleanup();
        reject(new Error('Timed out waiting for JSON-RPC response'));
      }
    };

    const cleanup = () => {
      stream.off('data', onData);
    };

    stream.on('data', onData);
  });
}

async function withOccupiedBridgePort(run) {
  const blocker = createServer();
  const blockerState = await new Promise((resolve, reject) => {
    blocker.once('error', (error) => {
      if (error?.code === 'EADDRINUSE') {
        resolve({ alreadyOccupied: true });
        return;
      }
      reject(error);
    });
    blocker.listen(6505, '127.0.0.1', () => resolve({ alreadyOccupied: false }));
  });

  try {
    return await run();
  } finally {
    if (!blockerState.alreadyOccupied) {
      await new Promise((resolve, reject) => blocker.close((err) => (err ? reject(err) : resolve())));
    }
  }
}

class FakeSocket extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.readyState = 1;
    this.sent = [];
  }

  send(payload) {
    this.sent.push(payload);
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }
}

function resolveGodotPath() {
  const candidates = [
    process.env.GODOT_PATH,
    '/home/yun/.local/bin/godot4',
    '/home/yun/.local/bin/godot',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function testStaleDisconnectRegression() {
  const bridge = createBridge(0, 1000, '127.0.0.1');
  const first = new FakeSocket('first');
  const second = new FakeSocket('second');

  bridge.handleConnection(first);
  assert.equal(bridge.getStatus().connected, true, 'first socket should be connected');

  first.readyState = 3;
  bridge.handleConnection(second);
  assert.equal(bridge.getStatus().connected, true, 'second socket should be connected');

  first.emit('close', 1000, Buffer.from('late close from stale socket'));
  assert.equal(bridge.getStatus().connected, true, 'stale close must not disconnect the replacement socket');

  second.emit('close', 1000, Buffer.from('active socket closed'));
  assert.equal(bridge.getStatus().connected, false, 'active socket close should disconnect bridge');
}

function testSceneToolsVectorRegression() {
  const godotPath = resolveGodotPath();
  if (!godotPath) {
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
      `extends SceneTree\n\nfunc _fail(message: String) -> void:\n\tprinterr(message)\n\tquit(1)\n\nfunc _init() -> void:\n\tvar root := Node2D.new()\n\troot.name = "Root"\n\tvar packed := PackedScene.new()\n\tif packed.pack(root) != OK:\n\t\t_fail("failed to pack root scene")\n\t\treturn\n\tif ResourceSaver.save(packed, "res://scenes/Test.tscn") != OK:\n\t\t_fail("failed to save root scene")\n\t\treturn\n\troot.queue_free()\n\n\tvar scene_tools = load("res://addons/godot_mcp_editor/tools/scene_tools.gd").new()\n\tvar project_path := ProjectSettings.globalize_path("res://")\n\n\tvar add_result: Dictionary = scene_tools.add_node({\n\t\t"projectPath": project_path,\n\t\t"scenePath": "res://scenes/Test.tscn",\n\t\t"nodeType": "Node2D",\n\t\t"nodeName": "TestNode",\n\t\t"parentNodePath": ".",\n\t\t"properties": {\n\t\t\t"position": {"x": 100, "y": 200},\n\t\t\t"scale": {"_type": "Vector2", "x": 2, "y": 2}\n\t\t}\n\t})\n\tif not add_result.get("ok", false):\n\t\t_fail("add_node failed: %s" % JSON.stringify(add_result))\n\t\treturn\n\n\tvar set_result: Dictionary = scene_tools.set_node_properties({\n\t\t"projectPath": project_path,\n\t\t"scenePath": "res://scenes/Test.tscn",\n\t\t"nodePath": "TestNode",\n\t\t"properties": {\n\t\t\t"position": [300, 400]\n\t\t}\n\t})\n\tif not set_result.get("ok", false):\n\t\t_fail("set_node_properties failed: %s" % JSON.stringify(set_result))\n\t\treturn\n\n\tvar loaded := load("res://scenes/Test.tscn") as PackedScene\n\tif loaded == null:\n\t\t_fail("failed to reload saved scene")\n\t\treturn\n\n\tvar instance := loaded.instantiate()\n\tvar node := instance.get_node_or_null("TestNode") as Node2D\n\tif node == null:\n\t\t_fail("saved node missing")\n\t\treturn\n\n\tif node.position != Vector2(300, 400):\n\t\t_fail("position mismatch: %s" % node.position)\n\t\treturn\n\tif node.scale != Vector2(2, 2):\n\t\t_fail("scale mismatch: %s" % node.scale)\n\t\treturn\n\n\tprint(JSON.stringify({"ok": true, "position": [node.position.x, node.position.y], "scale": [node.scale.x, node.scale.y]}))\n\tinstance.queue_free()\n\tquit(0)\n`,
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
async function withFakeLanguageServer(publishUri, handler) {
  const sockets = new Set();

  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = '';

    const send = (message) => {
      const body = JSON.stringify(message);
      socket.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      while (true) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const length = Number(/content-length:\s*(\d+)/i.exec(buffer.slice(0, headerEnd))?.[1]);
        if (!Number.isFinite(length)) return;
        const start = headerEnd + 4;
        if (buffer.length < start + length) return;

        const message = JSON.parse(buffer.slice(start, start + length));
        buffer = buffer.slice(start + length);

        if (message.method === 'initialize') {
          send({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
        } else if (message.method === 'textDocument/didOpen') {
          const uri = publishUri(message.params.textDocument.uri);
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

  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));

  try {
    return await handler(server.address().port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((closed) => server.close(closed));
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
async function testDiagnosticsSurviveUriReEncoding() {
  const reEncodeFirstLetter = (uri) => {
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
    await client.disconnect?.();
  });
}

/**
 * Godot publishes an empty diagnostics array for a file that really is clean, so a wait
 * that gives up must not answer with one too. Reporting a dead language server as a clean
 * file is the failure that hides itself.
 */
async function testDiagnosticsTimeoutIsNotAnEmptyResult() {
  await withFakeLanguageServer(
    () => null,
    async (port) => {
      const client = new GodotLSPClient(port, '127.0.0.1');
      await assert.rejects(
        () => client.getDiagnostics(join(tmpdir(), 'gopeak-lsp-regression', 'silent.gd'), 'extends Node\n'),
        /published no diagnostics/,
        'a diagnostics wait that times out should fail rather than report an empty result',
      );
      await client.disconnect?.();
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

function frameJsonRpc(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/**
 * A peer speaking the Content-Length framing both the LSP and the DAP client read.
 *
 * The writing side is left to `onMessage`, which is handed the socket and decides what bytes
 * go back and how they are split across writes: a fixture for a framing bug has to control
 * chunk boundaries, not just message contents.
 */
async function withFramedPeer(onMessage, handler) {
  const sockets = new Set();

  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const header = buffer.toString('latin1', 0, headerEnd);
        const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1]);
        if (!Number.isFinite(length)) return;
        const start = headerEnd + 4;
        if (buffer.length < start + length) return;

        const message = JSON.parse(buffer.toString('utf8', start, start + length));
        buffer = buffer.subarray(start + length);
        onMessage(message, socket);
      }
    });
    socket.on('error', () => {
      // The stub only has to not crash the suite when a client drops.
    });
  });

  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));

  try {
    return await handler(server.address().port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((closed) => server.close(closed));
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
async function testLspFramesBodiesByBytes() {
  const diagnosticMessage = `Could not find type "${MULTIBYTE}" in the current scope.`;

  const respond = (message, socket) => {
    if (message.method === 'initialize') {
      socket.write(frameJsonRpc({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } }));
      return;
    }

    if (message.method === 'textDocument/didOpen') {
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
              uri: message.params.textDocument.uri,
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
      diagnostics[0].message,
      diagnosticMessage,
      'a diagnostic quoting non-ASCII text must arrive with that text intact',
    );
    await client.disconnect?.();
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
async function testLspReassemblesBodySplitMidCharacter() {
  const diagnosticMessage = `Invalid operand "${MULTIBYTE}"`;

  const respond = (message, socket) => {
    if (message.method === 'initialize') {
      socket.write(frameJsonRpc({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } }));
      return;
    }

    if (message.method === 'textDocument/didOpen') {
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
            uri: message.params.textDocument.uri,
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
      diagnostics[0].message,
      diagnosticMessage,
      'a character split across two reads must decode to itself, not to replacement characters',
    );
    await client.disconnect?.();
  });
}

/**
 * The debug adapter client frames identically and had the identical fault. Godot prints
 * through it, so the non-ASCII case here is an ordinary `print()` of a translated string.
 */
async function testDapFramesBodiesByBytes() {
  const outputLine = `print: ${MULTIBYTE}`;
  const marker = MULTIBYTE.repeat(8);

  const respond = (message, socket) => {
    if (message.command === 'initialize') {
      socket.write(
        Buffer.concat([
          frameJsonRpc({
            seq: 1,
            type: 'response',
            request_seq: message.seq,
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
        request_seq: message.seq,
        command: message.command,
        success: true,
        body: {},
      }),
    );
  };

  await withFramedPeer(respond, async (port) => {
    const client = new GodotDAPClient(port, '127.0.0.1');
    const body = await client.initialize();

    assert.equal(body.marker, marker, 'a response body holding non-ASCII text must arrive intact');
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
async function testFramingCeilingFailsLoudly() {
  const announceTooMuch = (_message, socket) => {
    socket.write(Buffer.from('Content-Length: 999999999\r\n\r\n', 'ascii'));
  };

  await withFramedPeer(announceTooMuch, async (port) => {
    const client = new GodotLSPClient(port, '127.0.0.1');
    await assert.rejects(
      () => client.initialize(tmpdir()),
      /exceeded the 33554432 byte ceiling/,
      'an LSP peer announcing more than the ceiling should fail the request, naming the size',
    );
    await client.disconnect?.();
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
function testProjectGodotResistsPrototypeKeys() {
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
    Object.prototype.polluted,
    undefined,
    'a [__proto__] section must not put a property on every object in the process',
  );
  assert.equal(
    Object.polluted,
    undefined,
    'a [constructor] section must not write onto the Object constructor',
  );

  assert.equal(
    Object.getPrototypeOf(parsed),
    null,
    'the parsed project must carry no prototype for a section name to reach through',
  );
  assert.equal(
    Object.getPrototypeOf(parsed.misc),
    null,
    'each section must carry no prototype for a key name to reach through',
  );

  assert.equal(typeof parsed.constructor, 'object', 'a [constructor] section must parse to data');
  assert.equal(parsed.constructor.polluted, 'yes', 'a [constructor] section must keep its own keys');
  // Through the descriptor rather than the accessor: reading it as a property would answer
  // with whatever prototype is behind the object when the section is not there as data.
  const protoSection = Object.getOwnPropertyDescriptor(parsed, '__proto__')?.value;
  assert.equal(protoSection?.polluted, 'yes', 'a [__proto__] section must keep its own keys');
  assert.equal(
    Object.getOwnPropertyDescriptor(parsed.misc, '__proto__')?.value,
    'data',
    'a __proto__ key must land on the section as data',
  );
  assert.equal(parsed.misc.kept, 'value', 'a key after a __proto__ key must survive');
  assert.equal(parsed.application['config/name'], 'Pollution', 'ordinary sections must be unaffected');

  // What the resource handler returns. JSON.stringify drops a function value outright, so a
  // section parsed onto the Object constructor leaves the client a project with a hole in it.
  const serialised = JSON.parse(JSON.stringify(parsed));
  assert.equal(
    serialised.constructor.polluted,
    'yes',
    'a [constructor] section must survive the JSON the resource handler hands back',
  );
}

async function testEditorStatusPortConflict() {
  await withOccupiedBridgePort(async () => {
    const proc = spawn(process.execPath, ['./build/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GDHARNESS_TOOL_PROFILE: 'compact',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stderrChunks = [];
    proc.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString()));

    try {
      await delay(500);
      assert.equal(proc.exitCode, null, 'server should stay alive when the bridge port is occupied');

      proc.stdin.write(
        makeRequest(
          'initialize',
          {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'regression-test', version: '1.0.0' },
          },
          1,
        ),
      );
      await waitForJsonLine(proc.stdout, (msg) => msg.id === 1);
      proc.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`,
      );

      proc.stdin.write(makeRequest('tools/call', { name: 'get_editor_status', arguments: {} }, 2));
      const response = await waitForJsonLine(proc.stdout, (msg) => msg.id === 2);
      const payload = JSON.parse(response.result.content[0].text);
      assert.equal(payload.bridgeAvailable, false);
      assert.match(payload.startupError ?? '', /EADDRINUSE/i);
      assert.match(payload.note ?? '', /Another gdharness instance may own the editor bridge/i);
    } finally {
      proc.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => proc.once('exit', resolve)), delay(2000)]);
      if (proc.exitCode === null) {
        proc.kill('SIGKILL');
      }
    }
  });
}

/**
 * Runs the built server over stdio, initialised and ready for tools/call, and hands `call` to
 * the body. The transport is the point: these fixtures are about what a peer can put on the
 * wire, and reaching into the class directly would not carry a `__proto__` through JSON.parse.
 */
async function withStdioServer(body) {
  const proc = spawn(process.execPath, ['./build/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, GDHARNESS_TOOL_PROFILE: 'compact' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let nextId = 1;
  // The text rather than a parsed payload: a refusal comes back as a sentence, and a fixture
  // about refusals must not fall over on the thing it is there to see.
  const call = async (name, args) => {
    nextId += 1;
    const id = nextId;
    proc.stdin.write(makeRequest('tools/call', { name, arguments: args }, id));
    const response = await waitForJsonLine(proc.stdout, (msg) => msg.id === id);
    return response.result.content[0].text;
  };

  try {
    proc.stdin.write(
      makeRequest(
        'initialize',
        {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'regression-test', version: '1.0.0' },
        },
        1,
      ),
    );
    await waitForJsonLine(proc.stdout, (msg) => msg.id === 1);
    proc.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`,
    );

    await body(call);
  } finally {
    proc.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => proc.once('exit', resolve)), delay(2000)]);
    if (proc.exitCode === null) {
      proc.kill('SIGKILL');
    }
  }
}

/**
 * The dictionaries every untrusted name is looked up in have nothing behind them.
 *
 * This is the one mechanism the sites in index.ts and tool-groups.ts all rely on, so it is
 * asserted directly rather than only through whichever of them a fixture can reach. A name
 * belonging to Object.prototype must read as absent, and writing `__proto__` must store a key
 * rather than re-parent the object.
 */
function testDictionariesHaveNothingBehindThem() {
  const table = dictionary({ real: 'yes' });
  const blank = emptyRecord();

  assert.equal(table['real'], 'yes', 'a dictionary must still answer for its own keys');

  for (const inherited of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
    assert.equal(table[inherited], undefined, `${inherited} must not resolve in a filled dictionary`);
    assert.equal(blank[inherited], undefined, `${inherited} must not resolve in an empty one`);
  }

  // Copied key by key out of parsed JSON, which is how such a name arrives in the first place:
  // JSON.parse makes __proto__ an own enumerable property rather than a prototype.
  const hostile = JSON.parse('{"__proto__": {"injected": true}}');
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
 * The tool-group tables are indexed by an argument off the wire, so a name belonging to
 * Object.prototype must not resolve to a group. `constructor` is truthy on a plain literal, so
 * the existence checks pass and the handler answers about a group that does not exist; with the
 * branches in the other order it dereferences a function looking for `.tools`.
 */
async function testToolGroupLookupsCannotReachThePrototype() {
  await withStdioServer(async (call) => {
    for (const group of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      for (const action of ['activate', 'deactivate']) {
        const answer = await call('manage_tool_groups', { action, group });
        assert.match(
          answer,
          /unknown/i,
          `${action} ${group} should be refused as unknown, not treated as a group`,
        );
        assert.doesNotMatch(answer, /core group/i, `${group} must not be reported as a core group`);
      }
    }
  });
}

function testProjectGodotMultilineValues() {
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
    parsed.input?.move_left,
    '{\n"deadzone": 0.2,\n"events": [Object(InputEventKey,"physical_keycode":65)]\n}',
    'multi-line dictionary values should be joined rather than truncated to their first line',
  );
  assert.equal(
    parsed.rendering?.['renderer/rendering_method'],
    'gl_compatibility',
    'a section following a multi-line value should still be parsed',
  );
  assert.equal(
    parsed.misc?.brace_in_string,
    '{',
    'a brace inside a quoted string should not start a continuation',
  );
  assert.equal(parsed.misc?.after_brace_in_string, 'kept', 'a key after a quoted brace should survive');
  assert.equal(
    parsed.misc?.inline_dict,
    '{"x": [1, 2], "y": {"z": 3}}',
    'a balanced single-line dictionary should be left alone',
  );
  assert.equal(parsed.misc?.after_inline_dict, 7, 'a key after an inline dictionary should survive');

  const unterminated = parseProjectGodot('[s]\nbroken={\n"k": 1\n');
  assert.equal(typeof unterminated.s?.broken, 'string', 'an unterminated value should not hang');
}

async function main() {
  testStaleDisconnectRegression();
  testSceneToolsVectorRegression();
  assert.match(
    INDEX_SOURCE,
    /key\.startsWith\('_'\)/,
    'index.ts should preserve sentinel keys like _type during parameter normalization',
  );
  assert.match(INDEX_SOURCE, /@file:/, 'index.ts should pass operation params via @file: temp payloads');
  // Both branches, because the opt-out was once written as a shift() off the front of the
  // headless argv, which took -d with it and launched a game the debugger never attached to.
  assert.match(
    INDEX_SOURCE,
    // The argument and the path may be read under any spelling; what matters is that the
    // two branches differ by --headless alone and that -d survives in both.
    /private async handleRunProject[\s\S]*?const cmdArgs = this\.resolveHeadless\([^)]+\)\s*\n\s*\? \['--headless', '-d', '--path', [\w.[\]']+\]\s*\n\s*: \['-d', '--path', [\w.[\]']+\];/,
    'run_project should pass --headless only when headless resolves true, and -d either way',
  );
  assert.match(
    INDEX_SOURCE,
    /private resolveHeadless[\s\S]*?if \(typeof requested === 'boolean'\) \{\s*\n\s*return requested;/,
    'an explicit headless argument should win over the environment',
  );
  assert.match(
    INDEX_SOURCE,
    // Either spelling of the lookup, read directly or through the env helper: which one is
    // written says nothing about whether the check is right. What must hold is that both
    // display variables are consulted and that neither being set means headless.
    /private resolveHeadless[\s\S]*?DISPLAY[\s\S]{0,80}?WAYLAND_DISPLAY[^\n]*\n\s*\}/,
    'with no explicit argument a display-less environment such as CI should stay headless',
  );
  assert.match(
    INDEX_SOURCE,
    // An exported-but-empty display variable means no display, so the check must not treat
    // the empty string as a desktop.
    /function envValue[\s\S]*?value === undefined \|\| value === ''/,
    'an empty environment variable should read as unset',
  );
  assert.match(
    OPERATIONS_SOURCE,
    /params_json\.begins_with\("@file:"\)/,
    'godot_operations.gd should load params from @file: payloads',
  );
  assert.match(
    INDEX_SOURCE,
    /export function scanDirectoryForGodotBinaries/,
    'index.ts should export scanDirectoryForGodotBinaries for versioned-binary detection',
  );
  assert.match(
    INDEX_SOURCE,
    /Godot_v4\.4\.1-stable_win64\.exe/,
    'index.ts detection scanner doc should reference versioned Windows binaries from Issue #67',
  );
  assert.match(
    INDEX_SOURCE,
    /scanDirectoryForGodotBinaries\(dir, osPlatform\)/,
    'detectGodotPath should call the versioned-binary scanner as a fallback before giving up',
  );
  assert.match(
    RUNTIME_SOURCE,
    /client\.poll\(\)\s*\n\s*if client\.get_status\(\) != StreamPeerTCP\.STATUS_CONNECTED:\s*\n\s*clients_to_remove\.append\(client\)\s*\n\s*continue\s*\n\s*var available = client\.get_available_bytes\(\)/m,
    'runtime autoload should re-check socket status after poll() before get_available_bytes()',
  );
  assert.match(
    RUNTIME_SOURCE,
    /if params\.has\("x"\) and params\.has\("y"\):\s*\n\s*position = Vector2\(float\(params\["x"\]\), float\(params\["y"\]\)\)/m,
    'runtime input injection should accept flat x/y coordinates from the MCP tool schema',
  );
  assert.match(
    RUNTIME_SOURCE,
    /if params\.has\("relativeX"\) and params\.has\("relativeY"\):\s*\n\s*relative = Vector2\(float\(params\["relativeX"\]\), float\(params\["relativeY"\]\)\)/m,
    'runtime mouse motion should accept flat relativeX/relativeY coordinates from the MCP tool schema',
  );
  assert.match(
    RUNTIME_SOURCE,
    /func _resolve_mouse_button\(raw: Variant\) -> int:/,
    'runtime mouse injection should resolve string button names before assigning button_index',
  );
  assert.match(
    RUNTIME_SOURCE,
    /if keycode_raw is String and not \(keycode_raw as String\)\.is_empty\(\) and key_label\.is_empty\(\):\s*\n\s*key_label = keycode_raw as String/m,
    'runtime key injection should treat string keycode values as key labels',
  );
  assert.match(
    RUNTIME_SOURCE,
    /event\.physical_keycode = event\.keycode\s*\n\s*event\.key_label = event\.keycode/m,
    'runtime key injection should set physical_keycode and key_label so actions bound by physical key or label match',
  );
  assert.match(
    RUNTIME_SOURCE,
    /event\.shift_pressed = bool\(params\.get\("shift", false\)\)\s*\n\s*event\.ctrl_pressed = bool\(params\.get\("ctrl", false\)\)\s*\n\s*event\.alt_pressed = bool\(params\.get\("alt", false\)\)/m,
    'runtime key injection should apply the shift/ctrl/alt modifiers the tool schema advertises',
  );

  testProjectGodotMultilineValues();
  testProjectGodotResistsPrototypeKeys();
  assert.doesNotMatch(
    OPERATIONS_SOURCE,
    /include_built_in and \(dep_path\.contains\("addons\/"\)/,
    'addons/ is project content and often ships, so dependency analysis must not skip it as built-in',
  );
  assert.match(
    INDEX_SOURCE,
    /maxDepth:[\s\S]*?includeBuiltIn:/,
    'get_dependencies must send the names the operation script reads, max_depth and include_built_in',
  );

  await testEditorStatusPortConflict();
  await testDiagnosticsSurviveUriReEncoding();
  await testDiagnosticsTimeoutIsNotAnEmptyResult();
  await testLspFramesBodiesByBytes();
  await testLspReassemblesBodySplitMidCharacter();
  await testDapFramesBodiesByBytes();
  await testFramingCeilingFailsLoudly();
  testDictionariesHaveNothingBehindThem();
  await testToolGroupLookupsCannotReachThePrototype();
  console.log('regression tests passed');
}

await main();
