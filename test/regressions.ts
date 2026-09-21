#!/usr/bin/env node
import assert from 'node:assert/strict';
import { type ChildProcess, type SpawnSyncReturns, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { serviceDidNotAnswer } from '../scripts/audit-production.js';
import { pullRequestNumbers, shipsToUsers } from '../scripts/release-notes.js';
import { sharedCopies } from '../scripts/sync-shared-gd.js';
import { breakpointNotePath, readBreakpointNote, writeBreakpointNote } from '../src/breakpoint-note.js';
import { announcementPath, BRIDGE_ANNOUNCE_PROTOCOL, readAnnouncement } from '../src/bridge-announce.js';
import {
  type Contradicted,
  cachedClasses,
  cacheWrittenAt,
  classesNamedIn,
  contradictedDiagnostics,
  declaresMember,
  heldButGone,
  missingMemberIn,
  staleAnalysisNote,
  staleClassNames,
  uncachedClassNote,
  unknownTypeIn,
  unloadedTypes,
  unseenByEditor,
} from '../src/class-cache.js';
import { GodotDAPClient, type HeldBreakpoint, handleDAPTool } from '../src/dap_client.js';
import { dictionary, emptyRecord } from '../src/dictionary.js';
import { forAnswer, GameLog } from '../src/game-log.js';
import {
  anEditorIsStillComing,
  CONNECT_WINDOW_MS,
  createBridge,
  mayYetConnect,
  theEditorHasComeBack,
} from '../src/godot-bridge.js';
import { EDITOR_READS, HEADLESS_OPERATIONS } from '../src/headless-operations.js';
import {
  editorArguments,
  envValue,
  OPENED_BY_A_SERVER,
  resolveHeadless,
  runArguments,
  SAVES_NOT_MOVED_NOTE,
  savesStayPut,
  userDataIn,
} from '../src/launch.js';
import { GodotLSPClient } from '../src/lsp_client.js';
import { isWithinRoot, resolveWithinProject } from '../src/paths.js';
import { freePort } from '../src/ports.js';
import {
  ancestorsIn,
  childrenOf,
  descendantsIn,
  parseProcessTable,
  processTree,
  readCommandLine,
  startTimesOf,
} from '../src/process-children.js';
import { secondsFromClock } from '../src/process-time.js';
import { projectStructure, searchProject } from '../src/project-scan.js';
import { parseProjectGodot, settingKeys, settingsDroppedReport } from '../src/resources.js';
import { noteRestartBegun, restartNotePath, restartOwed, restartSettled } from '../src/restart-note.js';
import {
  couldStillBeTheRecordedRun,
  judgeRun,
  listeningPid,
  listeningPidInNetstat,
  readRunRecord,
  recordRunEnded,
  runningAs,
  stillTheRecordedRun,
  writeEditorRunNote,
  writeRunRecord,
} from '../src/run-record.js';
import {
  announcedSince,
  CONFIRMED_FOR_MS,
  chooseRuntime,
  discoverRuntimes,
  errorReportOf,
  JUDGED_AFTER_MS,
  RUNTIME_PROTOCOL,
  type RuntimeEndpoint,
  runtimeDirectories,
  runtimeDirectory,
  runtimesAnnounced,
  STARTED_AFTER_ANNOUNCING_MS,
  strangersAmong,
} from '../src/runtime-client.js';
import { discardWith } from '../src/scratch.js';
import {
  alive,
  PLAY_STARTS_WITHIN_MS,
  PROJECT_FILE_ARGUMENTS,
  patienceForFrames,
  runIsUp,
  runtimeVerdict,
} from '../src/server.js';
import type { GodotProcess } from '../src/server-types.js';
import { addonMismatch, markIfStale, SERVER_VERSION } from '../src/server-version.js';
import {
  ADDONS,
  autoloadIsOurs,
  installAddons,
  RUNTIME_AUTOLOAD,
  SCRIPT_RUNS_SETTING,
} from '../src/setup.js';
import { skillFiles } from '../src/skill.js';
import { readNonNegativeNumber, readPositiveNumber } from '../src/tool-args.js';
import {
  argumentsOf,
  callsWithoutProjectPath,
  opTakes,
  projectPathSentence,
  TOOL_SPECS,
  toolSpec,
} from '../src/tool-definitions.js';
import { namedType, renderToolsMarkdown } from '../src/tool-reference.js';
import { CACHE_MS, cacheFile, isNewer, registryFor, UpdateCheck } from '../src/update-check.js';
import { asArray, asNumber, get, text } from './support/json.js';
import { isRecord, type JsonRpcMessage, parseTextContent, textOf } from './support/json-rpc.js';
import { reservePort, ServerProcess } from './support/server.js';
import { reportUnswept, sweep } from './support/sweep.js';

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
  /** What the bridge closed it with, for a refusal whose code and reason are the answer. */
  closedWith: { code: number; reason: string } | null = null;

  constructor(name: string) {
    super();
    this.name = name;
  }

  send(payload: unknown): void {
    this.sent.push(payload);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.emit('close', code, Buffer.from(reason));
  }
}

function connectFake(bridge: ReturnType<typeof createBridge>, socket: FakeSocket): void {
  (bridge as unknown as { handleConnection: (socket: FakeSocket) => void }).handleConnection(socket);
}

/** The hello an editor sends once connected, which is where it says whose editor it is. */
function saysHello(socket: FakeSocket, projectPath: string): void {
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'godot_ready', project_path: projectPath })));
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

/**
 * A server that knows its project serves that project's editor and turns away every other one.
 *
 * The addon falls back to the default port whenever its own project holds no announcement, which
 * is every project whose server has not run yet, so any server on that port took the connection
 * and served it. Tool calls reached an editor showing another project's scenes and both sides
 * called the bridge healthy. The addon has always said which project it has open; nothing read it.
 */
function testOneServerOneProjectRegression(): void {
  const mine = join(tmpdir(), 'gdharness-one-server-mine');
  const theirs = join(tmpdir(), 'gdharness-one-server-theirs');

  const bridge = createBridge(0, 1000, '127.0.0.1', mine);
  const stranger = new FakeSocket('stranger');
  connectFake(bridge, stranger);
  saysHello(stranger, theirs);

  assert.equal(bridge.getStatus().connected, false, "another project's editor is not served");
  const turnedAway = stranger.closedWith;
  assert.ok(turnedAway, 'and is closed rather than left half connected');
  assert.equal(turnedAway.code, 4001, 'with its own close code, which the addon reads');
  assert.match(
    turnedAway.reason,
    /this server serves .*and that editor has .* open/,
    'and a reason naming both projects, since neither side can see the other',
  );

  // The same project as Godot spells it: forward slashes and a trailing one, against a config
  // holding a Windows path. A comparison that failed this would refuse the editor it exists for.
  const own = new FakeSocket('own');
  connectFake(bridge, own);
  saysHello(own, `${mine.replaceAll('\\', '/')}/`);
  assert.equal(bridge.getStatus().connected, true, "its own project's editor is served");
  assert.equal(own.closedWith, null, 'and is not closed on the way');

  // A project inside another project is a different project, so containment is not the question.
  const nested = createBridge(0, 1000, '127.0.0.1', mine);
  const inside = new FakeSocket('inside');
  connectFake(nested, inside);
  saysHello(inside, join(mine, 'demo'));
  assert.equal(nested.getStatus().connected, false, 'a project under this one is still another one');

  // Nothing said which project, which is every hand-written config: the port stays the contract.
  const anywhere = createBridge(0, 1000, '127.0.0.1');
  const guest = new FakeSocket('guest');
  connectFake(anywhere, guest);
  saysHello(guest, theirs);
  assert.equal(anywhere.getStatus().connected, true, 'a server with no project takes whoever comes');

  // Every socket the bridge took is holding a keepalive timer, and a timer nobody stopped keeps
  // the whole run from ever ending. Only the two that were served: a refused one was closed by
  // the bridge as it turned it away, which is the thing being checked above.
  own.close();
  guest.close();
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
    mkdirSync(join(projectDir, 'scenes'), { recursive: true });
    // The whole addon rather than the tools file and a list of what it preloads. The list was
    // written by hand, so a helper added beside the others is one the fixture does not copy, and
    // what it fails on is a preload of a file that is not there rather than anything it tests.
    cpSync('src/godot/addons/gdharness_editor', join(projectDir, 'addons', 'gdharness_editor'), {
      recursive: true,
    });

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
    sweep(projectDir);
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
  seen?: JsonRpcMessage[],
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
        seen?.push(message);

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
 * An editor that restarts is a language server with no record of what this client has opened.
 *
 * Diagnostics arrive as a publish rather than an answer, and Godot publishes in response to a
 * document being opened or changed. The client tracks which documents it has opened so that the
 * second ask about one sends didChange rather than didOpen, and that bookkeeping was kept across
 * a connection ending: after `editor_launch restart` every file asked about earlier got a
 * didChange naming a document the new server had never opened, which publishes nothing, so every
 * call timed out with "the language server may not be running" while documentSymbol on the same
 * file over the same socket answered completely and currently. Reported by another project on
 * 0.9.5 and reproduced here on 0.9.6: `guild.gd` answered clean in about a second, and after a
 * restart the same call timed out.
 *
 * The stub publishes on didOpen alone, which is what Godot does, so the second ask is answered
 * only if the connection ending forgot the document.
 */
async function testDiagnosticsSurviveTheEditorRestarting(): Promise<void> {
  await withFakeLanguageServer(
    (uri) => uri,
    async (port) => {
      const script = join(tmpdir(), 'gdharness-lsp-restart', 'player.gd');
      const client = new GodotLSPClient(port, '127.0.0.1');

      const first = await client.getDiagnostics(script, 'extends Node\n');
      assert.equal(first.length, 1, 'the first ask opens the document and is published to');

      // The editor going away and coming back, as this client sees it: the socket ends, and the
      // next call connects again to something with no memory of the document.
      await client.disconnect();

      const afterwards = await client.getDiagnostics(script, 'extends Node\n');
      assert.equal(afterwards.length, 1, 'and so is the ask after the connection was replaced');
      await client.disconnect();
    },
  );
}

/**
 * A document left open is a dependency frozen at the version it had when it was opened.
 *
 * Godot answers about a file the client has opened from the copy the client handed it, and keeps
 * that parse alive for as long as the document is open. The parse holds the parses of everything
 * the file depends on, so a `class_name` script edited outside the editor stays at its old text
 * for every open file that uses it. A project hit this on 0.10.0 after adding a static method and
 * a constant to `components.gd` from outside the editor: `script_diagnostics` on two files that
 * use them answered `Static function "opening()" not found in base "Components"` and four more of
 * the same shape, about code the engine had just compiled and run green.
 *
 * Nothing on the editor side reaches it. `editor_rescan` answered `ok` and changed nothing, and
 * asking again re-parsed only the file asked about while the other open document went on pinning
 * the stale copy, so the two files held each other's answer wrong.
 *
 * Closing after each answer is what releases it. Asserted on the wire rather than on a symbol,
 * because the stub has no analyser: what went wrong is that the client owned documents it was
 * not tracking changes to, and what fixes it is owning none between asks.
 */
async function testDiagnosticsLeaveNoDocumentOpen(): Promise<void> {
  const seen: JsonRpcMessage[] = [];
  await withFakeLanguageServer(
    (uri) => uri,
    async (port) => {
      const script = join(tmpdir(), 'gdharness-lsp-close', 'set_test.gd');
      const client = new GodotLSPClient(port, '127.0.0.1');

      await client.getDiagnostics(script, 'extends Node\n');
      await client.getDiagnostics(script, 'extends Node\n');
      await client.disconnect();
    },
    seen,
  );

  const documentMethods = seen
    .map((message) => message.method)
    .filter((method) => typeof method === 'string' && method.startsWith('textDocument/'));

  assert.deepEqual(
    documentMethods,
    ['textDocument/didOpen', 'textDocument/didClose', 'textDocument/didOpen', 'textDocument/didClose'],
    'each ask opens the document and gives it back, so the server owns none between asks',
  );

  const opened = seen.find((message) => message.method === 'textDocument/didOpen');
  const closed = seen.find((message) => message.method === 'textDocument/didClose');
  assert.equal(
    get(closed?.params, 'textDocument', 'uri'),
    get(opened?.params, 'textDocument', 'uri'),
    'the close names the document that was opened',
  );
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
    sweep(root);
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

/**
 * How long a superseded server is given to notice and go.
 *
 * Its own figure because it covers a wait this server chooses rather than a shutdown: it asks
 * whether it has been replaced on a timer, so the answer cannot arrive before that comes round.
 */
const SUPERSEDED_LIMIT_MS = 30_000;

function frameJsonRpc(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/** Whether [condition] comes true within [patienceMs], for a state that arrives over a socket. */
async function cameTrue(condition: () => boolean, patienceMs = 2000): Promise<boolean> {
  const deadline = Date.now() + patienceMs;
  while (!condition() && Date.now() < deadline) {
    await delay(20);
  }
  return condition();
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
  onConnect: (socket: Socket) => void = () => {},
): Promise<T> {
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    onConnect(socket);
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
    await client.abandon();
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
 * Letting go of the debug adapter sends it nothing.
 *
 * Godot stops the game it is playing when this session sends the protocol's `disconnect`, and it
 * does so with `terminateDebuggee: false` on the request: the standard way of asking to be let go
 * without taking the debuggee with you is not one this adapter honours. This runs in the server's
 * own shutdown, which a harness performs on every reconnect, so saying goodbye politely was ending
 * an editor-played game every time somebody reconnected.
 *
 * Measured against a real editor by `testAPlayedRunOutlivesTheServerUnderIt` in the editor tier,
 * which is where the claim lives. This case holds the shape of it cheaply: the request is not sent
 * at all, and the transport closes anyway.
 *
 * The existing run-outlives-server case never reached this. It starts its run with no editor
 * connected, so the server spawns the game itself and there is no adapter session to say goodbye
 * to. Server-spawned and editor-played are two shapes and it covers one.
 */
async function testLettingGoOfTheAdapterSendsItNothing(): Promise<void> {
  const requests: Record<string, unknown>[] = [];
  const respond: FramedPeerHandler = (message, socket) => {
    requests.push(message);
    socket.write(
      frameJsonRpc({
        seq: requests.length + 100,
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
    await client.initialize();
    await client.abandon();
  });

  const commands = requests.map((request) => request['command']);
  // The positive first: a session that never opened would send no disconnect either, and would
  // satisfy the absence below exactly as well as one that opened and then kept quiet.
  assert.ok(commands.includes('initialize'), `the session should have opened: ${commands.join(', ')}`);
  assert.deepEqual(
    commands.filter((command) => command === 'disconnect'),
    [],
    `letting go should tell the adapter nothing: ${commands.join(', ')}`,
  );
}

/**
 * A stop is known to the connection it was sent on, attached or not, and the reason it was sent
 * with is the one an attach afterwards keeps.
 *
 * The adapter sends `stopped` to every client connected when the game halts, and a server that has
 * played a scene through the editor is connected and nothing more: it attaches on its first stack
 * read. Counting the event only on an attached session sent every such server to the runtime for an
 * answer it had already been given, and the runtime's answer for a held game is "unanswered", which
 * is what the editor tier then read in place of "exception" on all three platforms. The attach that
 * follows has to keep what the connection was told, because asking the adapter again is answered
 * frames, and frames learned by asking say "attached" and not why. A connection opened after the
 * stop has to ask, since the adapter repeats nothing, and what a connection knew ends with it.
 *
 * The editor tier holds the same three states against a real adapter; this holds each line of the
 * client on its own, with the adapter's answers under the fixture's control.
 */
async function testAStopIsKnownToTheConnectionItWasSentTo(): Promise<void> {
  const commands: string[] = [];
  let frames: unknown[] = [{ id: 0, name: 'main', line: 7 }];
  const respond: FramedPeerHandler = (message, socket) => {
    const command = String(message['command']);
    commands.push(command);
    const body =
      command === 'threads'
        ? { threads: [{ id: 1, name: 'main' }] }
        : command === 'stackTrace'
          ? { stackFrames: frames, totalFrames: frames.length }
          : {};
    socket.write(
      frameJsonRpc({
        seq: commands.length + 100,
        type: 'response',
        request_seq: message['seq'],
        command,
        success: true,
        body,
      }),
    );
  };
  const stopped = frameJsonRpc({
    seq: 1,
    type: 'event',
    event: 'stopped',
    body: { reason: 'exception', description: 'Division by zero', text: '', threadId: 1 },
  });
  // Only the first connection is there when the game stops; the ones after it arrive late.
  let connections = 0;
  const tellTheFirst = (socket: Socket): void => {
    if (connections++ === 0) {
      socket.write(stopped);
    }
  };

  await withFramedPeer(
    respond,
    async (port) => {
      const told = new GodotDAPClient(port, '127.0.0.1');
      await told.connect();
      assert.ok(
        await cameTrue(() => told.holdIsKnown()),
        'a stop sent to a connection that never attached is known to it',
      );
      assert.equal(told.whereItStopped()?.reason, 'exception', 'with the reason it was sent with');

      await told.attach();
      assert.ok(commands.includes('attach'), `the session attached: ${commands.join(', ')}`);
      assert.equal(
        told.whereItStopped()?.reason,
        'exception',
        'and attaching kept what the connection was told rather than asking for what it could see',
      );
      assert.ok(
        !commands.includes('stackTrace'),
        `a connection that was told has nothing to ask: ${commands.join(', ')}`,
      );
      told.learnedRunning();
      assert.equal(
        told.whereItStopped()?.reason,
        'exception',
        'a ping answered before the stop arrived does not overrule the stop',
      );
      await told.abandon();
      assert.equal(told.holdIsKnown(), false, 'what a connection knew ends with the connection');

      // Opened after the stop, while the holder is still there: asks, and is answered frames.
      const late = new GodotDAPClient(port, '127.0.0.1');
      await late.attach();
      assert.ok(commands.includes('stackTrace'), `a connection opened late asks: ${commands.join(', ')}`);
      assert.ok(late.holdIsKnown(), 'and frames are an answer');
      assert.equal(late.whereItStopped()?.reason, 'attached', 'which says how it came to know');
      await late.abandon();

      // Opened after the holder has gone: a thread and no frames, which is not an answer either way.
      frames = [];
      const later = new GodotDAPClient(port, '127.0.0.1');
      await later.attach();
      assert.equal(later.holdIsKnown(), false, 'no frames for a late connection is not "running"');
      assert.equal(later.whereItStopped(), null, 'and nothing is claimed about where it stopped');
      later.learnedRunning();
      assert.ok(later.holdIsKnown(), 'the runtime answering is what settles it');
      assert.equal(later.whereItStopped(), null, 'as running');
      await later.abandon();
    },
    tellTheFirst,
  );
}

/**
 * A stop reported while the attach was asking about it is the answer, not the frames.
 *
 * The attach asks for the stack when the connection has been told nothing, and a game that reaches
 * its breakpoint between the question and the answer puts frames in the answer and its reason in an
 * event that lands in the same window. Frames learned by asking say "attached" and not why, so
 * taking them over the event replaced `breakpoint` with `attached` on the session that had been
 * told. Measured on macOS in the editor tier, where the first stack read after a play and the stop
 * at a breakpoint in `_ready` land close enough together to cross; the adapter here crosses them on
 * purpose, with the event written just ahead of the frames.
 */
async function testAStopThatLandsWhileAttachAsksIsTheAnswer(): Promise<void> {
  const stopped = frameJsonRpc({
    seq: 1,
    type: 'event',
    event: 'stopped',
    body: { reason: 'breakpoint', description: 'Breakpoint', threadId: 1 },
  });
  const respond: FramedPeerHandler = (message, socket) => {
    const command = String(message['command']);
    if (command === 'stackTrace') {
      socket.write(stopped);
    }
    const body =
      command === 'threads'
        ? { threads: [{ id: 1, name: 'main' }] }
        : command === 'stackTrace'
          ? { stackFrames: [{ id: 0, name: '_ready', line: 7 }], totalFrames: 1 }
          : {};
    socket.write(
      frameJsonRpc({
        seq: Number(message['seq']) + 100,
        type: 'response',
        request_seq: message['seq'],
        command,
        success: true,
        body,
      }),
    );
  };

  await withFramedPeer(respond, async (port) => {
    const session = new GodotDAPClient(port, '127.0.0.1');
    await session.attach();
    assert.ok(session.holdIsKnown(), 'the session knows the game is held, or the rest is moot');
    assert.equal(
      session.whereItStopped()?.reason,
      'breakpoint',
      'and knows it from the event, which names the reason, rather than from the frames it asked for',
    );
    await session.abandon();
  });
}

/**
 * A game let go by somebody else is known here to be running.
 *
 * The session cleared its hold on its own `continue` request and on nothing else, on the strength
 * of a comment saying the adapter sends no `continued`. It does: measured on 4.7.2, a second client
 * sending `continue` put a `continued` event on the connection of the session that had been told
 * of the stop, and that session went on answering held about a game that was running, since the
 * editor's own debugger and any other client resume the game without asking it. This holds the
 * event's effect against a scripted adapter; the editor tier holds its arrival from a real one.
 */
async function testAContinueByAnotherClientIsKnownHere(): Promise<void> {
  const respond: FramedPeerHandler = (message, socket) => {
    socket.write(
      frameJsonRpc({
        seq: Number(message['seq']) + 100,
        type: 'response',
        request_seq: message['seq'],
        command: message['command'],
        success: true,
        body: {},
      }),
    );
  };
  const stopped = frameJsonRpc({
    seq: 1,
    type: 'event',
    event: 'stopped',
    body: { reason: 'breakpoint', description: 'Breakpoint', threadId: 1 },
  });
  const continued = frameJsonRpc({ seq: 2, type: 'event', event: 'continued', body: { threadId: 1 } });
  let peer: Socket | null = null;

  await withFramedPeer(
    respond,
    async (port) => {
      const told = new GodotDAPClient(port, '127.0.0.1');
      await told.connect();
      assert.ok(
        await cameTrue(() => told.isStopped()),
        'the stop reaches the session, or nothing below is a test',
      );
      assert.equal(told.whereItStopped()?.reason, 'breakpoint', 'and it knows why the game is held');

      // Somebody else lets the game go. Nothing here asked for it.
      assert.ok(peer !== null, 'the adapter holds the connection it will send the event on');
      peer.write(continued);
      assert.ok(
        await cameTrue(() => !told.isStopped()),
        'a continue by another client is a game this session knows is running',
      );
      assert.equal(told.whereItStopped(), null, 'so nothing is claimed about where it is held');
      assert.ok(told.holdIsKnown(), 'and that is an answer rather than a default');
      await told.abandon();
    },
    (socket) => {
      peer = socket;
      socket.write(stopped);
    },
  );
}

/**
 * Every breakpoint held is sent again before a play, whoever set it, and a file the adapter will
 * not take back is reported rather than allowed to stop the play.
 *
 * Measured on 4.7.2: a breakpoint set through the adapter stops the play after it and not the one
 * after that, and sending it again before the play is what makes the second play stop. Held by the
 * editor tier against a real adapter; this holds what the client sends, and the two things the
 * real one cannot show on demand. Breakpoints taken on from a note are sent nowhere until a play
 * asks for them, since a server that has just started has no play to send them for, and a file
 * the adapter refuses is dropped from the set with its reason in the answer, because a script the
 * project no longer has is no reason to keep the play from starting.
 */
async function testBreakpointsAreSentAgainBeforeAPlay(): Promise<void> {
  const sent: { path: string; lines: number[] }[] = [];
  const respond: FramedPeerHandler = (message, socket) => {
    const command = String(message['command']);
    const arguments_ = isRecord(message['arguments']) ? message['arguments'] : {};
    const source = isRecord(arguments_['source']) ? arguments_['source'] : {};
    const path = text(source['path']);
    if (command === 'setBreakpoints') {
      sent.push({
        path,
        lines: asArray(arguments_['breakpoints']).map((one) => Number(get(one, 'line'))),
      });
    }
    const refused = command === 'setBreakpoints' && path.endsWith('gone.gd');
    socket.write(
      frameJsonRpc({
        seq: Number(message['seq']) + 100,
        type: 'response',
        request_seq: message['seq'],
        command,
        success: !refused,
        ...(refused ? { message: 'Unable to find file at: gone.gd' } : { body: { breakpoints: [] } }),
      }),
    );
  };

  await withFramedPeer(respond, async (port) => {
    const session = new GodotDAPClient(port, '127.0.0.1');
    await session.setBreakpoint('/game/main.gd', 12);
    await session.setBreakpoint('/game/main.gd', 30);
    await session.setBreakpoint('/game/other.gd', 4);
    // Taken on from a note, as a successor does: nothing is sent for it yet.
    session.holdBreakpoints([{ scriptPath: '/game/gone.gd', lines: [9] }]);
    const before = sent.length;
    assert.deepEqual(
      session.breakpointsHeld(),
      [
        { scriptPath: '/game/main.gd', lines: [12, 30] },
        { scriptPath: '/game/other.gd', lines: [4] },
        { scriptPath: '/game/gone.gd', lines: [9] },
      ],
      'the set holds what was set here and what was taken on',
    );
    assert.equal(sent.length, before, 'and taking a note on sends nothing until a play asks');

    const again = await session.reapplyBreakpoints();
    assert.deepEqual(
      sent.slice(before),
      [
        { path: '/game/main.gd', lines: [12, 30] },
        { path: '/game/other.gd', lines: [4] },
        { path: '/game/gone.gd', lines: [9] },
      ],
      `a play sends every file's whole list again: ${JSON.stringify(sent)}`,
    );
    assert.deepEqual(
      again.applied,
      [
        { scriptPath: '/game/main.gd', lines: [12, 30] },
        { scriptPath: '/game/other.gd', lines: [4] },
      ],
      'and answers with what the adapter took',
    );
    assert.deepEqual(
      again.refused.map((one) => one.scriptPath),
      ['/game/gone.gd'],
      `and names what it would not: ${JSON.stringify(again.refused)}`,
    );
    assert.match(text(again.refused[0]?.reason), /Unable to find file/, "with the adapter's own words");
    assert.deepEqual(
      session.breakpointsHeld().map((one) => one.scriptPath),
      ['/game/main.gd', '/game/other.gd'],
      'a file the adapter refused is not sent again before the next play',
    );

    // A line the adapter refuses is not held either: the set is what the editor has taken.
    const held = session.breakpointsHeld().length;
    await assert.rejects(() => session.setBreakpoint('/game/gone.gd', 2), /Unable to find file/);
    assert.equal(session.breakpointsHeld().length, held, 'a refused set leaves the set as it was');
    await session.abandon();
  });
}

/**
 * Setting a breakpoint here never takes away the ones set in the editor by hand, and a breakpoint
 * of this side's clicked off there is not held here either.
 *
 * The adapter takes a file's whole list and removes what is not in it, so a list carrying only
 * this side's lines cleared the user's own breakpoints in that file. With breakpoint syncing on,
 * the editor names every breakpoint to a session as it opens and echoes every toggle after, as
 * `breakpoint` events, so what is sent is the union of the two, less the one being removed, and
 * removing a line here clears it whoever set it. What the editor said is learned per connection,
 * and a removal it reports takes the line out of what is held and tells the note.
 */
async function testABreakpointSetHereKeepsTheEditorsOwn(): Promise<void> {
  const sent: { path: string; lines: number[] }[] = [];
  let peer: Socket | null = null;
  const toggled = (path: string, line: number, reason: 'new' | 'removed'): Buffer =>
    frameJsonRpc({
      seq: 1,
      type: 'event',
      event: 'breakpoint',
      body: { reason, breakpoint: { id: line, verified: true, line, source: { path } } },
    });
  const respond: FramedPeerHandler = (message, socket) => {
    const command = String(message['command']);
    const arguments_ = isRecord(message['arguments']) ? message['arguments'] : {};
    const source = isRecord(arguments_['source']) ? arguments_['source'] : {};
    const path = text(source['path']);
    const lines =
      command === 'setBreakpoints'
        ? asArray(arguments_['breakpoints']).map((one) => Number(get(one, 'line')))
        : [];
    if (command === 'setBreakpoints') {
      sent.push({ path, lines });
    }
    socket.write(
      frameJsonRpc({
        seq: Number(message['seq']) + 100,
        type: 'response',
        request_seq: message['seq'],
        command,
        success: true,
        body: {},
      }),
    );
    // Echoed the way Godot echoes a toggle, after the answer.
    for (const line of lines) {
      socket.write(toggled(path, line, 'new'));
    }
  };

  await withFramedPeer(
    respond,
    async (port) => {
      const session = new GodotDAPClient(port, '127.0.0.1');
      const noted: HeldBreakpoint[][] = [];
      session.setBreakpointsSink((held) => {
        noted.push(held);
      });
      await session.connect();
      assert.ok(
        await cameTrue(() => session.breakpointsInEditor().length === 1),
        'the editor names its own breakpoints to a session as it opens',
      );
      assert.deepEqual(session.breakpointsInEditor(), [{ scriptPath: '/game/main.gd', lines: [5, 9] }]);

      await session.setBreakpoint('/game/main.gd', 12);
      assert.deepEqual(
        sent.at(-1),
        { path: '/game/main.gd', lines: [5, 9, 12] },
        `setting a line sends the editor's own lines with it: ${JSON.stringify(sent)}`,
      );
      assert.deepEqual(
        session.breakpointsHeld(),
        [{ scriptPath: '/game/main.gd', lines: [12] }],
        'held: mine',
      );
      assert.deepEqual(
        session.breakpointsInEditor(),
        [{ scriptPath: '/game/main.gd', lines: [5, 9] }],
        "and the editor's own stay the editor's, echo or no echo",
      );

      await session.removeBreakpoint('/game/main.gd', 9);
      assert.deepEqual(
        sent.at(-1),
        { path: '/game/main.gd', lines: [5, 12] },
        `removing a line clears it whoever set it: ${JSON.stringify(sent)}`,
      );
      assert.deepEqual(session.breakpointsInEditor(), [{ scriptPath: '/game/main.gd', lines: [5] }]);

      // The user clicks this side's breakpoint off in the gutter: the editor says so, and it is
      // not held here any more, which the note is told.
      assert.ok(peer !== null, 'the adapter holds the connection it will send the event on');
      peer.write(toggled('/game/main.gd', 12, 'removed'));
      assert.ok(
        await cameTrue(() => session.breakpointsHeld().length === 0),
        'a breakpoint of this side clicked off in the editor is not held here',
      );
      assert.deepEqual(noted.at(-1), [], 'and the note is told the set is empty');
      const before = sent.length;
      const again = await session.reapplyBreakpoints();
      assert.equal(sent.length, before, 'so nothing is sent for it before the next play');
      assert.deepEqual(again.applied, []);

      await session.abandon();
      assert.deepEqual(session.breakpointsInEditor(), [], 'what the editor said ends with the connection');
    },
    (socket) => {
      peer = socket;
      socket.write(toggled('/game/main.gd', 5, 'new'));
      socket.write(toggled('/game/main.gd', 9, 'new'));
    },
  );
}

/**
 * A breakpoint the adapter refuses is refused about the editor and the file, not about a game.
 *
 * Every debug tool's failure closed with "start one with editor_run", and a breakpoint is set on
 * the editor's adapter with no game running: a caller whose script the adapter could not find was
 * sent to start a game that would not have helped. The stack tools keep the sentence, since a
 * session is what they need.
 */
async function testABreakpointRefusalNamesTheEditor(): Promise<void> {
  const respond: FramedPeerHandler = (message, socket) => {
    const command = String(message['command']);
    const refused = command === 'setBreakpoints' || command === 'attach';
    socket.write(
      frameJsonRpc({
        seq: Number(message['seq']) + 100,
        type: 'response',
        request_seq: message['seq'],
        command,
        success: !refused,
        ...(refused
          ? { message: command === 'attach' ? 'Not running' : 'Unable to find file at: gone.gd' }
          : { body: {} }),
      }),
    );
  };
  await withFramedPeer(respond, async (port) => {
    const client = new GodotDAPClient(port, '127.0.0.1');
    const missing = await handleDAPTool(client, 'dap_set_breakpoint', {
      scriptPath: '/game/gone.gd',
      line: 3,
    });
    assert.equal(missing.isError, true, JSON.stringify(missing));
    assert.match(
      text(missing.content[0]?.text),
      /Unable to find file at: gone\.gd/,
      "the adapter's own words",
    );
    assert.match(
      text(missing.content[0]?.text),
      /Breakpoints need the editor open, not a running game/,
      `and the cure is about the editor and the file: ${missing.content[0]?.text}`,
    );
    const noGame = await handleDAPTool(client, 'dap_get_stack_trace', {});
    assert.equal(noGame.isError, true, JSON.stringify(noGame));
    assert.match(
      text(noGame.content[0]?.text),
      /start one with editor_run/,
      `a stack read with no game is still sent to start one: ${noGame.content[0]?.text}`,
    );
    await client.abandon();
  });
}

/**
 * The breakpoint note round-trips through the project and refuses what is not the project's.
 *
 * Kept relative so the note is the project's rather than this machine's, read back resolved the
 * way the adapter wants it, taken down when nothing is held, and a script written into it from
 * outside the project, or by a hand editing the file, is not one a play is told to stop on.
 */
function testTheBreakpointNoteIsTheProjects(): void {
  // Spelt the way the adapter spells them, with every symlink and short name resolved, which on a
  // Windows runner turns RUNNER~1 into the account's name: the note compares against that spelling
  // and hands it back, and a fixture comparing against the other one is testing its own temp dir.
  const project = realpathSync.native(mkdtempSync(join(tmpdir(), 'gdharness-breakpoints-')));
  const elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), 'gdharness-elsewhere-')));
  try {
    writeBreakpointNote(project, [
      { scriptPath: join(project, 'scripts', 'main.gd'), lines: [30, 12] },
      { scriptPath: join(elsewhere, 'theirs.gd'), lines: [1] },
      { scriptPath: join(project, 'empty.gd'), lines: [] },
    ]);
    const written = JSON.parse(readFileSync(breakpointNotePath(project), 'utf8')) as unknown;
    assert.deepEqual(
      get(written, 'breakpoints'),
      [{ script: 'scripts/main.gd', lines: [30, 12] }],
      "the note holds the project's own files, relative and forward-slashed, and nothing outside",
    );
    assert.deepEqual(
      readBreakpointNote(project),
      [{ scriptPath: join(project, 'scripts', 'main.gd'), lines: [30, 12] }],
      'and reads back spelt for the adapter',
    );

    // Hand-written, or written by something else: a path that leaves the project is dropped, and
    // so is a line that is not one.
    writeFileSync(
      breakpointNotePath(project),
      JSON.stringify({
        breakpoints: [
          { script: '../theirs.gd', lines: [1] },
          { script: '/abs/theirs.gd', lines: [1] },
          { script: 'main.gd', lines: [0, -1, 'seven', 7] },
          { script: 'none.gd', lines: [] },
        ],
      }),
    );
    assert.deepEqual(
      readBreakpointNote(project),
      [{ scriptPath: join(project, 'main.gd'), lines: [7] }],
      'only lines inside the project, on positive whole lines, are taken on',
    );
    writeFileSync(breakpointNotePath(project), 'not json');
    assert.deepEqual(readBreakpointNote(project), [], 'a note that cannot be read holds nothing');

    writeBreakpointNote(project, []);
    assert.equal(existsSync(breakpointNotePath(project)), false, 'nothing held takes the note down');
    assert.deepEqual(readBreakpointNote(project), [], 'and a missing note holds nothing');
  } finally {
    sweep(project);
    sweep(elsewhere);
  }
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

/**
 * An answer out of the editor says when the addon that produced it is not this server's.
 *
 * `editor_status` has carried `addonIsStale` all along, and every other answer that came back
 * through the bridge said nothing at all: a caller who never asks about versions is served by
 * whatever code the editor loaded at startup, confidently, with no sign of it in the answer. A
 * downstream project has a recorded incident of exactly that, four errors from a stale addon that
 * were not errors and vanished on restart, and reported an editor three releases behind today.
 *
 * The half that has to hold as firmly is the quiet one: a project whose halves agree must see
 * nothing added, or every answer gdharness gives grows a key that means nothing.
 */
function testAnAnswerFromAStaleAddonSaysSo(): void {
  const answer = { nodes: ['Main'], count: 1 };

  const agreed = markIfStale(answer, '9.9.9', '9.9.9');
  assert.deepEqual(agreed, answer, 'halves that agree add nothing to the answer');
  assert.equal(get(agreed, 'addonIsStale'), undefined, 'not even as false, which would read as news');

  const behind = markIfStale(answer, '0.12.4', '0.12.16');
  assert.equal(get(behind, 'count'), 1, "the editor's own answer is still all there");
  assert.equal(get(behind, 'addonIsStale'), true, 'and it says which half is behind');
  assert.match(
    text(get(behind, 'staleNote')),
    /0\.12\.4 addon while this server ships 0\.12\.16.*editor_launch restart/s,
    'naming both versions and what fixes it',
  );

  // The other direction: a server behind its addon is told to reconnect rather than restart, and
  // an addon too old to say which version it is still reads as not this one.
  assert.match(
    text(get(markIfStale(answer, '0.12.16', '0.12.4'), 'staleNote')),
    /reconnect it in your harness/,
  );
  assert.equal(get(markIfStale(answer, undefined, '0.12.16'), 'addonIsStale'), true);

  // An answer that is not an object has nowhere to put this, and inventing somewhere would change
  // the shape of what the editor said.
  assert.deepEqual(markIfStale([1, 2], '0.12.4', '0.12.16'), [1, 2], 'a list comes back a list');
  assert.equal(markIfStale(7, '0.12.4', '0.12.16'), 7, 'and a number a number');
}

/**
 * A `connected: false` says whether it is final.
 *
 * The editor dials this server rather than the other way round, and backs off between tries up to
 * thirty seconds, so for the first half-minute of a bridge's life "nothing has connected" and
 * "there is no editor" are one answer to two questions. A downstream session read it as the second
 * straight after an upgrade respawned its server, and went through the machine's process list to
 * find the editor still up and its own answer wrong. `editor_run start` has said `mayYetAnnounce`
 * about the runtime for exactly this reason; the editor's own connection had nothing.
 *
 * The decision is judged apart from a clock, because the half worth having is the one that takes
 * over half a minute to reach and no fixture should be waiting for it.
 */
async function testAnEditorNotReachedYetIsNotAnEditorThatIsGone(): Promise<void> {
  const started = new Date(1_000_000);
  assert.equal(
    mayYetConnect(undefined, started.getTime()),
    true,
    'a bridge on no port has had no chance yet',
  );
  assert.equal(
    mayYetConnect(started, started.getTime() + 1_000),
    true,
    'a second in, an editor is still coming',
  );
  assert.equal(
    mayYetConnect(started, started.getTime() + CONNECT_WINDOW_MS - 1),
    true,
    'and up to the window, because the addon doubles its wait to thirty seconds',
  );
  assert.equal(
    mayYetConnect(started, started.getTime() + CONNECT_WINDOW_MS),
    false,
    'past it, nothing having connected is an editor that is not there',
  );

  // An editor this server started is the other reason the answer can be true, and it is the one the
  // window cannot express. The window runs from the bridge taking its port, so a launch on a server
  // that has been up longer than the window read as final the moment it returned: measured
  // downstream at nine minutes of "an editor that is not there" about an editor that server had
  // just started, because an editor imports the project before it loads any plugin.
  const longAfter = started.getTime() + CONNECT_WINDOW_MS * 20;
  assert.equal(
    anEditorIsStillComing(started, true, longAfter),
    true,
    'a launched editor still alive is coming, however long the import takes',
  );
  assert.equal(
    anEditorIsStillComing(started, false, longAfter),
    false,
    'and with nothing launched and the window closed, the answer is still final',
  );
  // Either reason alone is enough, so a window that is still open does not depend on a launch.
  assert.equal(
    anEditorIsStillComing(started, false, started.getTime() + 1_000),
    true,
    'inside the window it answers as the window does, with nothing launched',
  );

  // And the answer carries it, which is the half that would otherwise be computed and dropped.
  // On a bridge port of its own: the default one is held by whatever else this suite has running,
  // and a server whose bridge never listened is the other case entirely, with nothing to time from.
  const server = new ServerProcess({
    env: { GDHARNESS_BRIDGE_PORT: String(await freePort(0)) },
  });
  try {
    await server.initialize('regression-test');
    const payload = get(
      parseTextContent(await server.request('tools/call', { name: 'editor_status', arguments: {} })),
      'editor',
    );
    assert.equal(get(payload, 'connected'), false, 'no editor is running against this fixture');
    assert.equal(
      get(payload, 'mayYetConnect'),
      true,
      `a bridge this new cannot say otherwise: ${text(payload)}`,
    );
    // Spelled the way connectedAt beside it is spelled. It reaches the answer either way, so the
    // choice was between a timestamp and the epoch milliseconds it started life as.
    assert.match(
      text(get(payload, 'listeningSince')),
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/,
      `and says when the bridge took the port: ${text(payload)}`,
    );
  } finally {
    await server.stop();
  }
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
 * A project upgraded under a running server is said, rather than answered over.
 *
 * `upgrade` replaces the addons and re-pins the config while the server it replaces goes on
 * running, because a stdio server is the harness's process and cannot restart itself. Until this,
 * nothing anywhere said so: `addonIsStale` compares an editor's loaded addon against the server,
 * which is the other direction, and it reported false. The session carried on at the old version
 * with every sign saying it was fine.
 */
async function testAProjectUpgradedUnderTheServerIsSaid(): Promise<void> {
  const project = mkdtempSync(join(tmpdir(), 'gdharness-moved-'));
  const addon = join(project, 'addons', 'gdharness_editor');
  mkdirSync(addon, { recursive: true });
  writeFileSync(join(addon, '.gdharness-version'), '99.99.99\n');

  const server = new ServerProcess({ env: { GDHARNESS_PROJECT: project } });
  try {
    await server.initialize('regression-test');

    // Read as text rather than parsed, because an answer carrying a notice is two content blocks
    // and the two of them joined are not one JSON document. That is what a notice is: a block of
    // its own beside the answer, which is how the update one has always arrived.
    const said = textOf(await server.request('tools/call', { name: 'editor_status', arguments: {} }));
    assert.match(
      said ?? '',
      /"projectIs": "99\.99\.99"/,
      'editor_status should say what the project has moved on to',
    );

    // And unasked, because what makes it matter is that the agent is acting on answers from a
    // version the project has left behind.
    assert.match(said ?? '', /project_upgraded_under_this_server/, 'and say so on the answer');
    assert.match(said ?? '', /reconnect/i, 'and say what replaces it');
  } finally {
    await server.stop();
    sweep(project);
  }
}

/**
 * A restart another server began and could not finish is said, and settled by an editor arriving.
 *
 * A restart of an editor this server opened is a quit, a wait and a launch, and the server can be
 * ended between the first and the last: a caller restarts the editor to take an upgrade while the
 * user reconnects the harness for the same upgrade. The quit lands, the launch never runs, and the
 * successor is a young server with nothing connected, so it answered `mayYetConnect: true` from its
 * own age. A process listing showed nothing for the project at all. Reported downstream with the
 * pids.
 *
 * Both readings are taken from the same shape of server, seconds old, differing only in whether the
 * note is there: without it the young server's `true` is the right answer and is asserted as such,
 * so the `false` below is the note and not the window having closed.
 */
async function testARestartLeftHalfDoneIsSaid(): Promise<void> {
  const project = mkdtempSync(join(realpathSync(tmpdir()), 'gdharness-half-restart-'));
  const port = await reservePort();
  let editor: WebSocket | null = null;
  const server = new ServerProcess({
    env: { GDHARNESS_PROJECT: project, GDHARNESS_BRIDGE_PORT: String(port) },
  });
  const uninformed = new ServerProcess({ env: { GDHARNESS_PROJECT: project } });
  try {
    writeFileSync(
      join(project, 'project.godot'),
      '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="HalfRestart"\n',
    );
    // What the predecessor wrote before asking its editor to quit.
    noteRestartBegun({
      projectPath: project,
      editorPid: 27040,
      ports: { lsp: 6005, dap: 6006 },
      quitAt: '2026-09-20T19:39:30.000Z',
      byPid: 4242,
    });
    assert.deepEqual(restartOwed(project)?.editorPid, 27040, 'the note reads back');

    await server.initialize('regression-test');
    const status = parseTextContent(
      await server.request('tools/call', { name: 'editor_status', arguments: {} }),
    );
    assert.equal(get(status, 'editor', 'connected'), false, 'nothing is connected');
    assert.equal(
      get(status, 'editor', 'mayYetConnect'),
      false,
      `a server that knows the launch never ran says nothing is coming: ${JSON.stringify(get(status, 'editor'))}`,
    );
    const interrupted = get(status, 'editor', 'restartInterrupted');
    assert.equal(get(interrupted, 'quitEditorPid'), 27040, 'and names the editor that was quit');
    assert.equal(get(interrupted, 'quitAt'), '2026-09-20T19:39:30.000Z', 'and when');
    assert.equal(get(interrupted, 'byServerPid'), 4242, 'and which server began it');
    assert.match(text(get(interrupted, 'note')), /editor_launch open/, 'and what finishes it');

    // The contrast, from a server just as young with no note to read: its `true` is the window,
    // and is the right answer there.
    restartSettled(project);
    await uninformed.initialize('regression-test');
    const plain = parseTextContent(
      await uninformed.request('tools/call', { name: 'editor_status', arguments: {} }),
    );
    assert.equal(
      get(plain, 'editor', 'mayYetConnect'),
      true,
      'without the note a young server may yet be reached',
    );
    assert.equal(get(plain, 'editor', 'restartInterrupted'), undefined, 'and reports no restart');

    // An editor arriving settles it, whoever opened it: the note is gone from disk, not merely
    // unreported, so the server after this one does not report a debt that was paid.
    noteRestartBegun({
      projectPath: project,
      editorPid: 27040,
      ports: { lsp: 6005, dap: 6006 },
      quitAt: '2026-09-20T19:39:30.000Z',
      byPid: 4242,
    });
    const socket = new WebSocket(`ws://127.0.0.1:${port}/godot`);
    editor = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', reject);
    });
    socket.on('message', (raw: Buffer) => {
      const message: unknown = JSON.parse(String(raw));
      if (isRecord(message) && message['type'] === 'tool_invoke') {
        socket.send(
          JSON.stringify({ type: 'tool_result', id: message['id'], success: true, result: { ok: true } }),
        );
      }
    });
    socket.send(
      JSON.stringify({
        type: 'godot_ready',
        project_path: project,
        addon_version: SERVER_VERSION,
        dap_port: 6006,
      }),
    );
    let connected = false;
    for (let waited = 0; waited < 10_000 && !connected; waited += 100) {
      await delay(100);
      const now = parseTextContent(
        await server.request('tools/call', { name: 'editor_status', arguments: {} }),
      );
      connected = get(now, 'editor', 'connected') === true;
    }
    assert.ok(connected, 'the fake editor should have been greeted');
    const settled = parseTextContent(
      await server.request('tools/call', { name: 'editor_status', arguments: {} }),
    );
    assert.equal(get(settled, 'editor', 'restartInterrupted'), undefined, 'an editor being there settles it');
    assert.equal(
      existsSync(restartNotePath(project)),
      false,
      'and the note is taken down, not just unreported',
    );
  } finally {
    editor?.close();
    await server.stop();
    await uninformed.stop();
    sweep(project);
  }
}

/**
 * A server whose project has a newer server stands down instead of sitting there holding a port.
 *
 * A stdio server's life is its stdin and there is a handler for the end of it, which never
 * arrives: a harness that reconnects spawns the replacement and leaves this one running as its
 * child, still holding the pipe open. Six were found alive on one machine, one for every version a
 * project had moved through in a day, the oldest nine hours old. None of them was reachable,
 * because the editor follows the announcement, but the first one started held the default bridge
 * port and every later one had moved off it, so the oldest and most out of date server on the
 * machine was the one an editor with nothing announced fell back to. An editor belonging to an
 * entirely different project was found attached to one.
 *
 * Both halves matter. The predecessor goes, and the announcement it leaves behind is the live
 * server's rather than a file it took down on its way out.
 */
async function testASupersededServerStandsDown(): Promise<void> {
  const project = mkdtempSync(join(tmpdir(), 'gdharness-superseded-'));
  const announced = announcementPath(project);

  const first = new ServerProcess({ env: { GDHARNESS_PROJECT: project } });
  let second: ServerProcess | null = null;
  try {
    await first.initialize('regression-test');
    const mine = readAnnouncement(announced);
    assert.ok(mine, 'the first server should announce, or this proves nothing');

    second = new ServerProcess({ env: { GDHARNESS_PROJECT: project } });
    await second.initialize('regression-test');
    const theirs = readAnnouncement(announced);
    assert.notEqual(theirs?.pid, mine.pid, 'the second server should take the announcement over');

    let ended = false;
    for (let waited = 0; waited < SUPERSEDED_LIMIT_MS && !ended; waited += 250) {
      await delay(250);
      ended = first.exited;
    }
    assert.ok(ended, `the superseded server should have stopped within ${SUPERSEDED_LIMIT_MS}ms`);

    assert.equal(
      readAnnouncement(announced)?.pid,
      theirs?.pid,
      'and should leave the live announcement where the editor reads it',
    );
    assert.equal(second.exited, false, 'while the server that replaced it carries on');
  } finally {
    await first.stop();
    await second?.stop();
    sweep(project);
  }
}

/**
 * The two ends of the bridge announcement agree about where it is and what it says.
 *
 * The server writes it and the editor addon reads it, in different languages, with nothing but
 * two constants holding them together. A path that drifts is an editor that finds no
 * announcement and falls back to the port, which is the behaviour this replaced: it would read as
 * working right up until two projects were open at once.
 */
function testBothEndsAgreeAboutTheAnnouncement(): void {
  const addon = readFileSync('src/godot/addons/gdharness_editor/bridge_client.gd', 'utf8');

  const announced = /const ANNOUNCEMENT: String = "res:\/\/(.+)"/.exec(addon)?.[1];
  assert.ok(announced, 'the addon should name the announcement it reads');
  assert.equal(
    announcementPath('project').split(/[\\/]/).slice(1).join('/'),
    announced,
    'the server should write the announcement where the addon reads it',
  );

  const protocol = /const ANNOUNCE_PROTOCOL: int = (\d+)/.exec(addon)?.[1];
  assert.equal(
    Number(protocol),
    BRIDGE_ANNOUNCE_PROTOCOL,
    'the addon should read the protocol the server writes',
  );

  // The same pair again, for the variable that says who opened the editor. A name that drifts
  // reads as an editor nobody opened, which is the one a restart hands to Godot: it comes back
  // without the ports it was moved to, and every tool behind them is answered by another editor.
  const opened = /const OPENED_BY_A_SERVER: String = "(.+)"/.exec(addon)?.[1];
  assert.equal(opened, OPENED_BY_A_SERVER, 'the addon should read the variable the server sets');
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
/**
 * An editor a server opened is restarted by starting it again; one opened by hand restarts itself.
 *
 * Godot consumes the arguments an editor was started with and hands none of them back, so an editor
 * that restarts itself comes up without the ports it was moved to. That was answered by writing
 * those ports into Godot's editor settings, and there is one of those per engine version per
 * machine: a port chosen for one project became the number every other project's editor came up on,
 * and an editor opened by hand for something else inherited it and collided with the one it was
 * moved away from. Reported by another session, whose editor for one project was attached to a
 * server for another.
 *
 * Driven on the wire, because which of the two an editor gets is the whole of the fix: the fake
 * editor says whether a server opened it, and which way the server went is read off what it did
 * next. The engine is pointed at nothing on purpose. Starting an editor again needs one and looks
 * it up first, so an editor a server opened stops there and says so, which is the answer no editor
 * restarting itself could ever produce; and nothing here puts a real editor on anybody's desk.
 */
async function testAnEditorAServerOpenedIsStartedAgain(): Promise<void> {
  for (const opened of [true, false]) {
    const port = await reservePort();
    const server = new ServerProcess({
      env: {
        GDHARNESS_BRIDGE_PORT: String(port),
        GODOT_PATH: join(tmpdir(), 'gdharness-no-such-engine'),
      },
    });
    let editor: WebSocket | null = null;
    try {
      await server.initialize('regression-test');
      const opening = new WebSocket(`ws://127.0.0.1:${port}/godot`);
      editor = opening;
      await new Promise<void>((resolve, reject) => {
        opening.once('open', () => {
          resolve();
        });
        opening.once('error', reject);
      });

      const asked: string[] = [];
      opening.on('message', (data: Buffer) => {
        const message = JSON.parse(data.toString('utf8')) as { type?: string; tool?: string };
        if (message.type === 'tool_invoke' && typeof message.tool === 'string') {
          asked.push(message.tool);
        }
      });
      opening.send(
        JSON.stringify({
          type: 'godot_ready',
          project_path: process.cwd(),
          editor_pid: process.pid,
          opened_by_a_server: opened,
        }),
      );

      // The greeting goes over the socket and the call over stdio, so the server can answer the
      // call before it has read the greeting: an editor it has not been told about is one it
      // restarts the other way, and this fixture then asserts the wrong half. Asked rather than
      // assumed, which is also what says the flag travelled.
      let greeted: Record<string, unknown> | null = null;
      for (let waited = 0; waited < 10_000; waited += 100) {
        const status = parseTextContent(
          await server.request('tools/call', { name: 'editor_status', arguments: {} }, 20_000),
        );
        const said = isRecord(status) ? status['editor'] : null;
        if (isRecord(said) && typeof said['projectPath'] === 'string') {
          greeted = said;
          break;
        }
        await delay(100);
      }
      assert.ok(greeted, 'the server should read the greeting the editor sent');
      assert.equal(greeted['openedByAServer'], opened, 'and take the editor at its word about it');

      const restart = server
        .request('tools/call', { name: 'editor_launch', arguments: { op: 'restart' } }, 20_000)
        .catch(() => null);

      if (opened) {
        assert.match(
          textOf(await restart) ?? '',
          /GODOT_PATH is set to .*gdharness-no-such-engine, which does not exist/,
          'an editor a server opened is started again, so it is the engine that stops it, and the refusal names the path this fixture set',
        );
        assert.equal(asked.includes('restart_editor'), false, 'and it is never asked to restart itself');
        continue;
      }

      // The other way round waits for an editor to come back, which no fixture editor does, so the
      // answer is never awaited: what was asked for has already gone down the socket.
      let sent = false;
      for (let waited = 0; waited < 10_000 && !sent; waited += 100) {
        await delay(100);
        sent = asked.includes('restart_editor');
      }
      assert.ok(sent, 'an editor opened by hand is asked to restart itself');
      assert.equal(asked.includes('quit_editor'), false, 'and is never asked to go');
    } finally {
      editor?.terminate();
      await server.stop();
    }
  }
}

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

/**
 * The port an editor is opened on is the default until somebody else has it.
 *
 * Godot serves the language server and the debug adapter on one port each for the whole machine,
 * so the second editor open binds neither and every script and debug tool behind it is answered
 * by the first editor, about another project. Keeping the default whenever it is free is what
 * leaves a machine with one editor on it exactly where it was, and an external client that was
 * pointed at 6005 by hand still looking at the right place.
 */
async function testAnEditorPortMovesOnlyWhenItIsHeld(): Promise<void> {
  const holder = createServer();
  const held = await new Promise<number>((resolve) => {
    holder.listen(0, '127.0.0.1', () => {
      const bound = holder.address();
      resolve(typeof bound === 'object' && bound !== null ? bound.port : 0);
    });
  });
  try {
    const moved = await freePort(held);
    assert.notEqual(moved, held, 'a port somebody is holding is not the one handed back');
    assert.ok(moved > 0 && moved <= 65535, `and what is handed back is a port: ${moved}`);
  } finally {
    await new Promise<void>((resolve) => {
      holder.close(() => {
        resolve();
      });
    });
  }
  assert.equal(await freePort(held), held, 'and the port asked for is kept once nobody holds it');
}

/**
 * A server set up for a project answers about that project's game and no other.
 *
 * Two projects open in two harness sessions are two games announced on the same machine, and a
 * server that took whichever one it found would answer about somebody else's project with nothing
 * in the answer saying so. A caller naming a project still wins; this is only the default.
 */
async function testAServerOnlyAnswersAboutItsOwnGame(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gdharness-own-'));
  const announced = join(root, 'announced');
  const mine = join(root, 'mine');
  mkdirSync(announced, { recursive: true });
  mkdirSync(mine, { recursive: true });
  writeFileSync(
    join(announced, `runtime-${process.pid}.json`),
    JSON.stringify({
      protocol: RUNTIME_PROTOCOL,
      pid: process.pid,
      port: 51_234,
      address: '127.0.0.1',
      project: { name: 'Elsewhere', path: join(root, 'elsewhere') },
    }),
    'utf8',
  );

  const server = new ServerProcess({
    env: {
      GDHARNESS_PROJECT: mine,
      GDHARNESS_RUNTIME_DIR: announced,
      GDHARNESS_RUNTIME_TIMEOUT_MS: '1500',
    },
  });
  try {
    await server.initialize('regression-test');
    const said = textOf(await server.request('tools/call', { name: 'runtime_inspect', arguments: {} })) ?? '';
    assert.match(
      said,
      /No running game is from /,
      `the one game running is another project's and should not be answered about: ${said}`,
    );
    assert.match(said, /Elsewhere/, 'and the refusal names the game that is running');
  } finally {
    await server.stop();
    sweep(root);
  }
}

/**
 * The longest wait the tool offers has to be one it can actually wait out.
 *
 * `runtime_wait frames` takes up to 600, which is ten seconds at sixty a second, and every runtime
 * command was given a flat ten seconds: the answer arrived as the call gave up on it, twice in one
 * session of driving a game. A wait is given the time those frames take at a rate no game falls
 * under now, which is a bound on patience rather than a delay: the answer still comes the moment
 * the frames have passed.
 */
function testTheLongestWaitCanBeWaitedOut(): void {
  const flat = 10_000;
  const one = patienceForFrames(1, flat);
  assert.ok(one >= flat && one < flat * 2, `a wait of one frame is given about the usual patience: ${one}`);
  assert.ok(
    patienceForFrames(600, flat) > 30_000,
    `the longest wait is given longer than the frames take: ${patienceForFrames(600, flat)}`,
  );
  assert.ok(
    patienceForFrames(600, flat) > patienceForFrames(60, flat),
    'and a longer wait is given longer than a shorter one',
  );
}

type ToolCall = (name: string, args: unknown, timeoutMs?: number) => Promise<string>;
type RawRequest = (method: string, params: unknown, timeoutMs?: number) => Promise<JsonRpcMessage>;

/** Long enough for a headless engine to start, run one operation and exit on a slow runner. */
const ENGINE_CALL_TIMEOUT_MS = 120_000;

/**
 * How long a windowed engine is given to announce on a runner with a display.
 *
 * The first windowed boot in a run is the slow one, and the runner decides how slow: on the macOS
 * leg the second windowed boot of one run announced in 9750ms and the first had not announced in
 * 60000ms, with the game still running when the wait gave up, twice in one evening. The
 * compatibility renderer is already asked for. What the second boot has that the first has not is
 * the shader cache the first one filled, since every project these fixtures play is named the
 * same and so shares a user:// directory, and compiling the engine's built-in shaders on a runner
 * with no GPU is the cost that lands on whichever fixture plays first. Not this project's to
 * shorten. Measured rather than guessed: each fixture prints what its boot took, so this can be
 * read against what the legs actually do.
 */
const WINDOWED_BOOT_MS = 150_000;

/**
 * Runs the built server over stdio, initialised and ready for tools/call, and hands `call` and
 * `request` to the body. The transport is the point: these fixtures are about what a peer can
 * put on the wire, and reaching into the class directly would not carry a `__proto__` through
 * JSON.parse.
 */
/**
 * JSON.parse, with the answer in the failure when it is not JSON.
 *
 * A refusal is a sentence, so a fixture expecting an answer and getting one fails with
 * `SyntaxError: Unable to parse JSON string` and no sign of what the server said, which is a
 * fixture reporting that it cannot read rather than what it read.
 */
/** The environment with any runtime-directory override taken out, to find the shared default. */
function withoutRuntimeDir(variables: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...variables };
  delete copy['GDHARNESS_RUNTIME_DIR'];
  return copy;
}

function jsonOf(answer: string, what: string): unknown {
  try {
    return JSON.parse(answer);
  } catch {
    return assert.fail(`${what} answered text rather than JSON: ${answer}`);
  }
}

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

      // Named as a section rather than merely refused, because every one of these is refused by
      // something: what this asks is that it was turned away for not being a section, with the
      // sections there are listed beside it, rather than reaching the table and finding a function.
      const unknownSection = await call('project_info', { projectPath: process.cwd(), include: [name] });
      assert.match(
        unknownSection,
        /autoloads, plugins, export_presets, audio_buses, health, validation/,
        `${name} must not resolve to a section`,
      );
    }
  });
}

/**
 * An argument of the wrong type is refused rather than quietly dropped.
 *
 * `includeProperties` given the list of properties to include was taken, ignored, and answered as
 * though it had been read, so a caller saw nodes with no properties on them and no reason why. An
 * argument the tool does not name has always been refused; one it names and cannot use is the same
 * mistake wearing the right word.
 */
async function testArgumentsOfTheWrongTypeAreRefused(): Promise<void> {
  await withStdioServer(async (call) => {
    assert.match(
      await call('runtime_inspect', { op: 'tree', includeProperties: ['text'] }),
      /includeProperties as boolean, not a list/,
      'a boolean given a list should be refused',
    );
    assert.match(
      await call('scene_tree', { projectPath: '/p', scenePath: 'a.tscn', depth: '3' }),
      /depth as number, not a string/,
      'a number given a string should be refused',
    );

    // The other half, or the two above pass against a server that refuses everything. A key is
    // named or numbered and the schema says both, so neither may be turned away. What an accepted
    // one reaches is the runtime, which is not there, and that sentence is asserted rather than
    // the absence of a refusal: "not the complaint I named" is also what a crash answers.
    for (const keycode of ['Space', 32]) {
      assert.match(
        await call('runtime_input', { op: 'key', keycode }),
        /No game with the runtime addon is running/,
        `${JSON.stringify(keycode)} is a keycode the tool accepts`,
      );
    }
  });
}

/**
 * An argument meant for another op is refused too.
 *
 * The third way past the same door. The tool takes the word, so the tool-level check waves it
 * through, and then the op reads nothing of the sort and answers as though it had: `limit` on a
 * screen read was named in the schema, sent by every caller who wanted the top of a panel, and
 * thrown away, so two hundred lines came back with truncated saying false.
 */
async function testAnArgumentMeantForAnotherOpIsRefused(): Promise<void> {
  await withStdioServer(async (call) => {
    assert.match(
      await call('runtime_inspect', { op: 'text', includeProperties: true }),
      /runtime_inspect text does not take includeProperties/,
      'an argument named for tree should be refused on text',
    );
    // And the refusal spells out what the op does take, which is what saves the second wrong call.
    assert.match(
      await call('runtime_inspect', { op: 'text', depth: 2 }),
      /text takes: projectPath, pid, nodePath, limit, includeHidden/,
      'and should say what text takes instead',
    );
    // The run tools ask it of three ops that share a schema, where the wrong-op argument is the
    // likelier mistake: only one of them boots a fixed number of frames, only one of them can be
    // told to take a window, and the third takes nothing at all.
    assert.match(
      await call('editor_run', { op: 'check', projectPath: '/p', headless: true }),
      /editor_run check does not take headless/,
      'an argument only a start reads should be refused on check',
    );
    assert.match(
      await call('editor_run', { op: 'start', projectPath: '/p', frames: 3 }),
      /start takes: projectPath, scene, args, headless, runtimeWaitMs/,
      'and the refusal says what start takes instead',
    );
    assert.match(
      await call('editor_run', { op: 'start', projectPath: '/p', runtimeWaitMs: 30_000 }),
      /Not a Godot project/,
      'while the argument start does read reaches the project check',
    );

    // One rule across the editor_* family, and it is not "all or none": an op takes projectPath
    // where it is being told which project, and does not where it is about the editor or the run
    // already in hand. Getting that boundary wrong cost a downstream session two calls, one in
    // each direction, so the boundary itself is asserted rather than left to whoever edits next.
    for (const [tool, op] of [
      ['editor_run', 'stop'],
      ['editor_run', 'wait'],
      ['editor_launch', 'restart'],
    ]) {
      assert.match(
        await call(String(tool), { op, projectPath: '/p' }),
        new RegExp(`${tool} ${op} does not take projectPath`),
        `${tool} ${op} is about what is already connected, so it should refuse being told the project`,
      );
    }
    for (const [tool, op] of [
      ['editor_run', 'start'],
      ['editor_run', 'check'],
      ['editor_launch', 'open'],
    ]) {
      assert.match(
        await call(String(tool), { op }),
        new RegExp(`${tool} ${op} needs projectPath`),
        `${tool} ${op} is being told which project, so it should ask for one`,
      );
    }

    // The other half, or this passes against a server that refuses every op-specific argument.
    // Accepted means reaching the runtime and finding nothing there, which is one sentence; the
    // absence of "does not take" is every sentence in the program except one.
    for (const call_ of [
      { op: 'text', limit: 3 },
      { op: 'find', className: 'Label', limit: 3 },
      { op: 'tree', depth: 2, includeProperties: true },
    ]) {
      assert.match(
        await call('runtime_inspect', call_),
        /No game with the runtime addon is running/,
        `${JSON.stringify(call_)} is a call the op understands`,
      );
    }
  });
}

/**
 * Every op an argument claims is an op its tool has.
 *
 * A typo here is the refusal firing on a call that was right, which is worse than the silence it
 * replaced, and nothing else would catch it: a name nothing matches simply never passes.
 */
function testEveryArgumentNamesOpsItsToolHas(): void {
  for (const spec of TOOL_SPECS) {
    const ops = new Set(Object.keys(spec.operations ?? {}));
    for (const [name, schema] of Object.entries(spec.parameters)) {
      const named = schema.ops;
      if (named === undefined) {
        continue;
      }
      assert.ok(ops.size > 0, `${spec.name} has no ops, so ${name} cannot name any`);
      assert.ok(named.length > 0, `${spec.name}.${name} names an empty list of ops`);
      for (const op of named) {
        assert.ok(ops.has(op), `${spec.name}.${name} names op ${op}, which ${spec.name} has not`);
      }
    }
    for (const op of ops) {
      for (const needed of spec.operations?.[op]?.requires ?? []) {
        assert.ok(opTakes(spec, op, needed), `${spec.name} ${op} requires ${needed} and does not take it`);
      }
    }
  }
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

        // The accepting half. These reach the engine, which is not Godot here, so each answer is
        // that run failing, named after the operation that was asked for. Naming it is the point:
        // an answer that merely fails to be the containment refusal is also what a crash, a
        // timeout or an unrelated refusal looks like.
        const accepted: [string, Record<string, unknown>, RegExp][] = [
          ['script_edit', { op: 'create', scriptPath: 'scripts/player.gd' }, /create_script failed \(exit/],
          ['project_import', { op: 'uid', resourcePath: 'inside.gd' }, /get_uid failed \(exit/],
          ['script_info', { scriptPath: 'inside.gd' }, /get_script_info failed \(exit/],
          [
            'project_export',
            { op: 'run', preset: 'Linux', outputPath: 'builds/game.bin' },
            /did not produce builds\/game\.bin/,
          ],
        ];
        for (const [tool, args, reached] of accepted) {
          assert.match(
            await call(tool, { projectPath, ...args }),
            reached,
            `${tool} should accept ${JSON.stringify(args)} and ask the engine`,
          );
        }

        // And the export made the directory it was told to write into. Godot's command-line
        // exporter does not, where its own export dialog does, and what it says about a missing one
        // is "The given export path doesn't exist", which reads as a wrong path in the preset. Two
        // projects lost their first export to that message. Asserted here rather than in a suite of
        // its own because the directory is made before the engine is asked, so it happens whether
        // the engine is Godot or, as here, something that is not going to export anything.
        assert.ok(
          existsSync(join(projectPath, 'builds')),
          'project_export should create the directory its outputPath names',
        );

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
    sweep(sandbox);
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

    // The buffer answers with itself, empty, rather than with a refusal. Asserted as the buffer
    // it is: "does not say no game is running" is true of every other refusal there is.
    assert.match(
      await call('debug_state', { op: 'output' }),
      /"lines": 0[\s\S]*"output": \[\]/,
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
    sweep(sandbox);
  }
}

/**
 * The two walks over a project directory answer about the same set of files.
 *
 * `project_info` counted what it found and `project_search` searched somewhere else: one skipped
 * every directory spelled with a dot and the other skipped four of them by name, so a vendored
 * engine under `.tools/` was absent from the counts and searched anyway. Neither honoured a
 * `.gdignore`, which the class cache and the engine-side walks both do, so a project with one was
 * answered about three different ways depending on which question was asked.
 *
 * The match that should be found is asserted beside the two that should not, because a search
 * that had stopped reading files at all satisfies the absences perfectly.
 */
function testTheProjectWalksAgreeAboutWhatIsInIt(): void {
  const sandbox = mkdtempSync(join(tmpdir(), 'gdharness-walks-'));
  try {
    const needle = 'extends Node\n\nconst WORD = "findable"\n';
    mkdirSync(join(sandbox, 'scripts'), { recursive: true });
    writeFileSync(join(sandbox, 'scripts', 'hero.gd'), needle);

    // Hidden, so the engine's own scanner never looks inside it either.
    mkdirSync(join(sandbox, '.tools', 'godot'), { recursive: true });
    writeFileSync(join(sandbox, '.tools', 'godot', 'vendored.gd'), needle);

    // Marked, which is the project saying the same thing about a directory that is not hidden.
    mkdirSync(join(sandbox, 'export'), { recursive: true });
    writeFileSync(join(sandbox, 'export', '.gdignore'), '');
    writeFileSync(join(sandbox, 'export', 'shipped.gd'), needle);

    const found = searchProject(sandbox, {
      query: 'findable',
      fileTypes: ['gd'],
      regex: false,
      caseSensitive: false,
      maxResults: 100,
    });
    assert.deepEqual(
      found.results.map((entry) => entry.file),
      ['res://scripts/hero.gd'],
      'the search should read the project and nothing standing beside it',
    );
    assert.equal(found.summary.files_searched, 1, 'and should not have opened the other two');
    assert.equal(projectStructure(sandbox).scripts, 1, 'the count should agree with the search');
  } finally {
    sweep(sandbox);
  }
}

/**
 * The staleness no file on disk records: the editor is the one that has fallen behind.
 *
 * A class declared in a script and listed in the cache passes every check above, and the editor
 * can still be unable to resolve it, because its scan skipped a file another engine had already
 * imported. So the reading that matters is against the list the editor is holding, and a project
 * where the disk is entirely correct has to come back with the class named rather than empty.
 */
function testClassesAnEditorIsNotHolding(): void {
  const sandbox = mkdtempSync(join(tmpdir(), 'gdharness-editor-classes-'));
  try {
    mkdirSync(join(sandbox, 'scripts'), { recursive: true });
    mkdirSync(join(sandbox, '.godot'), { recursive: true });
    writeFileSync(join(sandbox, 'scripts', 'hero.gd'), 'class_name Hero\nextends Node\n');
    writeFileSync(join(sandbox, 'scripts', 'squire.gd'), 'class_name Squire\nextends Node\n');
    writeFileSync(
      join(sandbox, '.godot', 'global_script_class_cache.cfg'),
      'list=[{\n"class": &"Hero",\n"path": "res://scripts/hero.gd"\n}, {\n"class": &"Squire",\n"path": "res://scripts/squire.gd"\n}]\n',
    );

    assert.deepEqual(staleClassNames(sandbox), [], 'the disk agrees with itself, which is the trap');
    assert.deepEqual(
      unseenByEditor(sandbox, ['Hero', 'Squire']),
      [],
      'an editor holding both has nothing to report',
    );
    assert.deepEqual(
      unseenByEditor(sandbox, ['Hero']),
      [{ className: 'Squire', path: 'res://scripts/squire.gd' }],
      'and one holding only the older class names the newer one, with the script that declares it',
    );

    // A class the cache has lost is the one an editor is likeliest to have lost with it, and
    // reading the cache first is what kept those out: the file that is wrong decided what could
    // be reported as wrong, so the worst state of the three was the one that answered clean.
    writeFileSync(
      join(sandbox, '.godot', 'global_script_class_cache.cfg'),
      'list=[{\n"class": &"Hero",\n"path": "res://scripts/hero.gd"\n}]\n',
    );
    assert.deepEqual(
      unseenByEditor(sandbox, ['Hero']),
      [{ className: 'Squire', path: 'res://scripts/squire.gd' }],
      'a declaration missing from the cache and from the editor is still named',
    );
    writeFileSync(
      join(sandbox, '.godot', 'global_script_class_cache.cfg'),
      'list=[{\n"class": &"Hero",\n"path": "res://scripts/hero.gd"\n}, {\n"class": &"Squire",\n"path": "res://scripts/squire.gd"\n}]\n',
    );

    // A class the editor is not holding because nothing declares it any more is the editor being
    // ahead rather than behind, and saying so would send somebody after a file that is not there.
    assert.deepEqual(
      unseenByEditor(sandbox, ['Hero', 'Squire', 'Departed']),
      [],
      'a name only the editor has is not a class it cannot see',
    );

    // The engine imports nothing under a .gdignore, so no declaration in there is ever a global
    // class and no editor will ever hold one. Counted, they make a correct project look blind.
    mkdirSync(join(sandbox, 'vendor'), { recursive: true });
    writeFileSync(join(sandbox, 'vendor', '.gdignore'), '');
    writeFileSync(join(sandbox, 'vendor', 'stowaway.gd'), 'class_name Stowaway\nextends Node\n');
    assert.deepEqual(
      unseenByEditor(sandbox, ['Hero', 'Squire']),
      [],
      'a declaration the engine itself skips is not one the editor is missing',
    );
    assert.deepEqual(staleClassNames(sandbox), [], 'and it is not missing from the cache either');

    // What a rescan has to compare to know it has taken something away. The editor writes this
    // file from the list it holds, so a shorter list writes a shorter file, and the only record
    // that the longer one existed is the reading taken before the scan.
    const cache = join(sandbox, '.godot', 'global_script_class_cache.cfg');
    const before = cachedClasses(sandbox);
    assert.deepEqual(
      [...(before?.keys() ?? [])],
      ['Hero', 'Squire'],
      'the cache reader should name what the file holds, in the order it holds it',
    );
    const wasWritten = cacheWrittenAt(sandbox);
    assert.ok(typeof wasWritten === 'number' && wasWritten > 0, 'and say when it was written');

    writeFileSync(cache, 'list=[{\n"class": &"Hero",\n"path": "res://scripts/hero.gd"\n}]\n');
    const after = cachedClasses(sandbox);
    assert.deepEqual(
      [...(before?.keys() ?? [])].filter((name) => !after?.has(name)),
      ['Squire'],
      'and a class that was there before and is not now is the one to name',
    );
    assert.equal(cachedClasses(join(sandbox, 'nowhere')), null, 'a project with no cache has no list');
    assert.equal(cacheWrittenAt(join(sandbox, 'nowhere')), null, 'and no time it was written');
  } finally {
    sweep(sandbox);
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
    sweep(sandbox);
  }
}

/**
 * An autoload naming a file the repository does not carry.
 *
 * project.godot is committed and what it names may not be. `setup` registers the runtime addon by
 * its path under addons/, and a project that installs its addons rather than committing them, the
 * way it treats gdUnit4, is then one line away from a clone that boots with a missing script.
 * Nothing said so at the moment it was created, on either of the two projects it happened to.
 *
 * Three states, because the question is what a clone gets and only one of the three is about
 * .gitignore: a file a rule ignores, a file nobody ever added, and a file a rule ignores that
 * somebody added anyway. Asking git whether a path is ignored gets the middle one wrong in one
 * direction and the last one wrong in the other, and the middle one is every project between
 * installing an addon and committing it.
 *
 * Engine-free, like the doctor test above it: this is git and project.godot and nothing else.
 */
/**
 * Every GDScript in the tree is somewhere the GDScript gates look, and every place they look holds
 * some.
 *
 * `gdlint` and `gdformat --check` both exit 0 when handed a directory with no GDScript in it, and
 * `gdformat` says "0 files would be left unchanged" while doing it, which reads like a pass. So the
 * paths in `package.json` are a list nothing holds against the tree: move a directory, add one, or
 * mistype one, and the gate goes on reporting success over less than it did, or over nothing.
 *
 * Reported by a downstream project that asked every gate it has what it says about a directory
 * holding nothing of its language. `ruff`, `ty`, `gdlint`, `gdformat` and `markdownlint-cli2` all
 * answered 0.
 *
 * Both directions, because each alone is satisfied by a mistake in the other. A script outside
 * every named path is one nothing checks. A named path with nothing under it is a gate checking
 * nothing and saying so in the language of success, and it is also the positive here: a walk that
 * had stopped finding files would satisfy the first assertion perfectly.
 *
 * The three commands are held level too. They are written out separately, and a directory added to
 * the linter and not to the formatter is a directory only half of them reads.
 */
function testEveryGdscriptIsUnderTheGatesAndEveryGateHasSome(): void {
  const manifest: unknown = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  // Everything after the tool that is not a flag. Reading only the words with a slash in them
  // looked equivalent and is not: it cannot see a directory at the top level, which is the one a
  // mistyped or moved path is most likely to be, and the disarm that adds one passed because of it.
  const pathsIn = (script: string): string[] => {
    const line = get(manifest, 'scripts', script);
    assert.equal(typeof line, 'string', `package.json should define the ${script} script`);
    return String(line)
      .split(/\s+/)
      .slice(1)
      .filter((word) => word !== '' && !word.startsWith('-'));
  };

  const gated = pathsIn('lint:gd');
  assert.ok(
    gated.length > 0,
    `lint:gd should name the directories it checks: ${String(get(manifest, 'scripts', 'lint:gd'))}`,
  );
  for (const other of ['format:gd', 'format:gd:check']) {
    assert.deepEqual(
      pathsIn(other),
      gated,
      `${other} reads the same directories as lint:gd, or one of them is only half checked`,
    );
  }

  const found: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'build') {
        continue;
      }
      const here = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(directory, entry.name), `${here}/`);
      } else if (entry.name.endsWith('.gd')) {
        found.push(here);
      }
    }
  };
  walk(process.cwd(), '');

  const outside = found.filter((path) => !gated.some((where) => path.startsWith(`${where}/`)));
  assert.deepEqual(outside, [], `every .gd belongs to a directory the gates name, and these do not`);

  for (const where of gated) {
    const under = found.filter((path) => path.startsWith(`${where}/`));
    assert.ok(
      under.length > 0,
      `${where} is named by the gates and holds no .gd, so both tools pass over nothing there`,
    );
  }
}

/**
 * The bumps the release button offers are the bumps both documents describe.
 *
 * `CLAUDE.md` tells the owner how to choose a bump and says `.github/CONTRIBUTING.md` states the
 * same thing publicly, so keep the two in step. That instruction was stated and held by nothing,
 * which is its own shape: a project can write a rule into its working agreement, act on it, and
 * still have no case that fails when the two drift.
 *
 * What is held here is the part that has an artefact behind it. The three documents that have to
 * agree are two prose files and one `type: choice` in a workflow, and the choice is the one a
 * person actually clicks: a bump offered by the button and described in neither file is one nobody
 * can decide correctly, and a bump described in one file only is the drift the instruction is about.
 *
 * What is not held, and deliberately: which level each kind of change belongs to. The two files say
 * that in different words on purpose, one addressing the owner and one the public, so `removal` in
 * one is `taken away` in the other. A check pairing phrase to phrase would be a copy of both texts
 * that rots when either is reworded, which is the fault it would be pretending to catch.
 */
function testTheReleaseButtonOffersWhatBothDocumentsDescribe(): void {
  const workflow = readFileSync(join(process.cwd(), '.github', 'workflows', 'release-prepare.yml'), 'utf8');
  const choices = workflow
    .slice(workflow.indexOf('bump:'))
    .split('options:')[1]
    ?.split(/\n\s*\n|\njobs:/)[0];
  assert.ok(choices !== undefined, 'the prepare workflow should offer a bump as a list of options');
  const offered = [...choices.matchAll(/^\s*-\s*(\w+)\s*$/gm)].map((found) => found[1]);
  assert.deepEqual(
    offered,
    ['patch', 'minor', 'major'],
    `the button offers these three, and both documents are held against them: ${choices}`,
  );

  // The section rather than the file. `major` appears in CONTRIBUTING's Renovate paragraph as
  // well, so a whole-file search passes on a Versions section that has lost it, which is a check
  // reading the right document and the wrong part of it.
  const sections: [string, string][] = [
    ['CLAUDE.md', '## Releasing'],
    [join('.github', 'CONTRIBUTING.md'), '## Versions'],
  ];
  for (const [file, heading] of sections) {
    const text = readFileSync(join(process.cwd(), file), 'utf8');
    const start = text.indexOf(heading);
    assert.ok(start >= 0, `${file} should still have its ${heading} section`);
    const after = text.slice(start + heading.length);
    const ends = after.indexOf('\n## ');
    const section = (ends < 0 ? after : after.slice(0, ends)).toLowerCase();
    for (const bump of offered) {
      assert.ok(
        section.includes(String(bump)),
        `${file}'s ${heading} should say what ${String(bump)} means, since the button offers it`,
      );
    }
  }
}

/**
 * A GODOT_PATH that names something broken is refused as that, naming the path and what is wrong.
 *
 * The locator answered null for two states: nothing set and nothing found, and a variable set to
 * something that does not answer. Both became "No Godot executable found. Set GODOT_PATH", which
 * told somebody who had set it to set it, and never named what they had set or why it was refused.
 * The two states also call for opposite next steps, since the first is a machine without an engine
 * and the second is one line in a config.
 *
 * Both broken shapes, because they fail in different places: a path that is not there never
 * reaches the engine, and a file that is there and is not an engine fails inside `--version`, and a
 * fixture holding only the first would pass a locator that had gone back to null for the second.
 * The nothing-set answer is held beside them as the positive, from the same server shape.
 */
async function testAnEngineThatDoesNotAnswerIsNamed(): Promise<void> {
  const missing = join(tmpdir(), 'gdharness-no-such-engine');
  const notAnEngine = join(process.cwd(), 'package.json');
  const project = mkdtempSync(join(tmpdir(), 'gdharness-no-engine-'));
  writeFileSync(join(project, 'project.godot'), 'config_version=5\n');

  for (const [label, path, reason] of [
    ['a path that is not there', missing, /does not exist/],
    ['a file that is not an engine', notAnEngine, /does not answer --version/],
  ] as const) {
    const server = new ServerProcess({ env: { GODOT_PATH: path } });
    try {
      await server.initialize('regression-test');
      const status = parseTextContent(
        await server.request('tools/call', { name: 'editor_status', arguments: {} }),
      );
      assert.equal(get(status, 'godot', 'path'), null, `${label}: no engine is reported`);
      const problem = text(get(status, 'godot', 'problem'));
      assert.match(problem, /GODOT_PATH is set to/, `${label}: and why is said in editor_status: ${problem}`);
      assert.ok(problem.includes(path), `${label}: naming the path that was set: ${problem}`);
      assert.match(problem, reason, `${label}: and what is wrong with it: ${problem}`);

      const refused =
        textOf(
          await server.request('tools/call', {
            name: 'project_import',
            arguments: { projectPath: project, op: 'refresh_classes' },
          }),
        ) ?? '';
      assert.match(
        refused,
        /GODOT_PATH is set to/,
        `${label}: a tool that needs the engine says the same: ${refused}`,
      );
      assert.match(
        refused,
        /Point GODOT_PATH at a Godot 4 executable/,
        `${label}: and what to do: ${refused}`,
      );
      assert.doesNotMatch(
        refused,
        /No Godot executable found/,
        `${label}: rather than the answer for nothing set`,
      );
    } finally {
      await server.stop();
    }
  }
  sweep(project);
}

function testAnAutoloadGitWillNotCarry(): void {
  const project = mkdtempSync(join(tmpdir(), 'gdharness-ignored-'));
  const git = (...gitArgs: string[]): SpawnSyncReturns<string> =>
    spawnSync('git', gitArgs, { cwd: project, encoding: 'utf8', timeout: 60000 });
  const troubles = (where: string): string[] => {
    const run = spawnSync(process.execPath, [join(process.cwd(), 'build', 'cli.js'), 'doctor', '--json'], {
      encoding: 'utf8',
      cwd: where,
      timeout: 60000,
    });
    return asArray(get(JSON.parse(run.stdout), 'problems'))
      .map(text)
      .filter((problem) => problem.includes('autoload names'));
  };
  try {
    if (git('init').status !== 0) {
      console.log('autoload tracking regression skipped (no git)');
      return;
    }
    writeFileSync(join(project, '.gitignore'), 'addons/\n');
    writeFileSync(
      join(project, 'project.godot'),
      'config_version=5\n\n[autoload]\n\nIgnored="*res://addons/thing/autoload.gd"\n' +
        'NeverAdded="*res://scripts/forgotten.gd"\n' +
        'Committed="*res://scripts/loader.gd"\n',
    );
    mkdirSync(join(project, 'addons', 'thing'), { recursive: true });
    mkdirSync(join(project, 'scripts'), { recursive: true });
    writeFileSync(join(project, 'addons', 'thing', 'autoload.gd'), 'extends Node\n');
    writeFileSync(join(project, 'scripts', 'forgotten.gd'), 'extends Node\n');
    writeFileSync(join(project, 'scripts', 'loader.gd'), 'extends Node\n');
    assert.equal(git('add', 'scripts/loader.gd').status, 0);

    const said = troubles(project);
    assert.equal(said.length, 2, `two of the three are lost, not one and not all: ${said.join(' | ')}`);
    assert.match(said.join(' '), /Ignored autoload names res:\/\/addons\/thing\/autoload\.gd/);
    assert.match(said.join(' '), /NeverAdded autoload names res:\/\/scripts\/forgotten\.gd/);
    assert.doesNotMatch(said.join(' '), /Committed/, 'a file in the index is carried');

    // And a rule matching a file somebody added anyway is not the question either: -f puts it in
    // the index, a clone gets it, and doctor has nothing to say about it.
    assert.equal(git('add', '-f', 'addons/thing/autoload.gd').status, 0);
    const forced = troubles(project);
    assert.equal(forced.length, 1, `only the one nobody added is left: ${forced.join(' | ')}`);
    assert.match(forced[0] ?? '', /NeverAdded/);

    // Outside a repository there is no answer, and a missing answer is not a clean bill: doctor
    // says nothing rather than reporting every autoload as lost. Every file the entries name is
    // put on disk first, because a file that is not there is reported whether or not there is a
    // repository, and this case is about git having no answer rather than about absent files.
    const elsewhere = mkdtempSync(join(tmpdir(), 'gdharness-nogit-'));
    try {
      const outside = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: elsewhere, encoding: 'utf8' });
      if (outside.status !== 0) {
        cpSync(join(project, 'project.godot'), join(elsewhere, 'project.godot'));
        mkdirSync(join(elsewhere, 'addons', 'thing'), { recursive: true });
        mkdirSync(join(elsewhere, 'scripts'), { recursive: true });
        writeFileSync(join(elsewhere, 'addons', 'thing', 'autoload.gd'), 'extends Node\n');
        writeFileSync(join(elsewhere, 'scripts', 'forgotten.gd'), 'extends Node\n');
        writeFileSync(join(elsewhere, 'scripts', 'loader.gd'), 'extends Node\n');
        assert.deepEqual(troubles(elsewhere), [], 'no repository is no verdict');
      }
    } finally {
      sweep(elsewhere);
    }
  } finally {
    sweep(project);
  }
}

/**
 * An autoload naming a file that is not there is reported, and the loader line says so too.
 *
 * The section of doctor about autoloads exists because a clone boots with a missing script, and it
 * was silent about the project in front of it doing exactly that. A loader recognised by its
 * filename is recognised whether or not the file is on disk, so a project whose loader had gone
 * read `runtime autoload: registered through res://tools/gdharness_loader.gd`, with no problem
 * line and exit 0, while the comment beside the swallowed read error said doctor reported it
 * elsewhere. Nothing did.
 *
 * Our own addon's script is the one exception, because the addon line has already said the addon
 * is not installed and a second sentence about the same absence is noise. Asserted as an absence
 * beside the positives, so it cannot pass by the whole check having gone quiet.
 */
function testAnAutoloadNamingAFileThatIsNotThere(): void {
  const project = mkdtempSync(join(tmpdir(), 'gdharness-gone-'));
  const doctor = (...more: string[]): SpawnSyncReturns<string> =>
    spawnSync(process.execPath, [join(process.cwd(), 'build', 'cli.js'), 'doctor', ...more], {
      encoding: 'utf8',
      cwd: project,
      timeout: 60000,
    });
  try {
    mkdirSync(join(project, '.godot'), { recursive: true });
    writeFileSync(join(project, '.godot', 'global_script_class_cache.cfg'), 'list=Array[Dictionary]([])\n');
    writeFileSync(
      join(project, 'project.godot'),
      'config_version=5\n\n[autoload]\n\n' +
        'GdharnessLoader="*res://tools/gdharness_loader.gd"\n' +
        'Gone="*res://tools/not_here.gd"\n' +
        `${RUNTIME_AUTOLOAD.name}="*res://${RUNTIME_AUTOLOAD.path}"\n`,
    );

    const json = doctor('--json');
    assert.equal(json.status, 1, `a project that boots with a missing script is not clean: ${json.stdout}`);
    const report: unknown = JSON.parse(json.stdout);
    const said = asArray(get(report, 'problems')).map(text);
    assert.match(
      said.join('\n'),
      /GdharnessLoader autoload names res:\/\/tools\/gdharness_loader\.gd, which is not in this project/,
      'the loader that is gone is named',
    );
    assert.match(
      said.join('\n'),
      /Gone autoload names res:\/\/tools\/not_here\.gd, which is not in this project/,
      'and so is any other entry naming nothing',
    );
    assert.equal(
      said.filter((problem) => problem.includes(RUNTIME_AUTOLOAD.path)).length,
      0,
      `our own script is covered by the addon line and not said twice: ${said.join(' | ')}`,
    );
    assert.equal(
      said.filter((problem) => problem.includes('is not installed')).length,
      3,
      'which is the line that covers it',
    );
    const loader = get(report, 'runtimeLoaderAutoload');
    assert.equal(get(loader, 'exists'), false, 'and the loader entry says its file is not there');

    const plain = doctor();
    assert.match(
      plain.stdout,
      /runtime autoload: registered through res:\/\/tools\/gdharness_loader\.gd, as GdharnessLoader, and that file is not in this project/,
      'the status line says so as well, rather than naming a file as though it could be opened',
    );

    // The positive: put the loader back and the loader line is clean, so the sentence above is
    // this check and not the whole command going quiet.
    mkdirSync(join(project, 'tools'), { recursive: true });
    writeFileSync(join(project, 'tools', 'gdharness_loader.gd'), 'extends Node\n');
    const restored: unknown = JSON.parse(doctor('--json').stdout);
    assert.equal(get(get(restored, 'runtimeLoaderAutoload'), 'exists'), true, 'restored, the file is there');
    assert.doesNotMatch(
      asArray(get(restored, 'problems')).map(text).join('\n'),
      /gdharness_loader\.gd, which is not in this project/,
      'and is no longer reported as missing',
    );
    assert.match(
      asArray(get(restored, 'problems')).map(text).join('\n'),
      /Gone autoload names res:\/\/tools\/not_here\.gd, which is not in this project/,
      'while the one still missing still is',
    );
  } finally {
    sweep(project);
  }
}

/**
 * Which changelog section a change is listed under, by the files it touched.
 *
 * The split exists because a pull request title says what changed and not how far it reaches. Two
 * projects downstream read one flat list of titles on the same day and both took a release for a
 * fixture that changes nothing they install, while the one that answered their problem sat
 * unmentioned a number below.
 *
 * Asserted in both directions in one place, because the failure that matters is a shipped change
 * filed as repository-only: that is the one nobody upgrades for. The reverse is noise.
 */
function testChangelogReach(): void {
  const installed: string[][] = [
    ['src/server.ts'],
    ['src/godot/addons/gdharness_runtime/runtime_queries.gd'],
    ['package.json', 'bun.lock'],
    ['README.md'],
    ['LICENSE'],
    ['scripts/build-release.ts'],
    // One shipped file is enough: a fix and the fixture proving it is a change you install.
    ['src/junit.ts', 'test/regressions.ts'],
  ];
  for (const files of installed) {
    assert.equal(shipsToUsers(files), true, `${files.join(', ')} reaches an installed copy`);
  }

  const repositoryOnly: string[][] = [
    ['test/regressions.ts'],
    ['test/support/server.ts'],
    ['CLAUDE.md'],
    ['.github/workflows/ci.yml'],
    ['.github/CONTRIBUTING.md'],
    ['docs/architecture.md'],
    ['scripts/install-godot.ts'],
    ['biome.json', 'tsconfig.json'],
  ];
  for (const files of repositoryOnly) {
    assert.equal(shipsToUsers(files), false, `${files.join(', ')} stays in the repository`);
  }

  // The version-bump pull request is not something a release carries, it is the release, and it
  // touches two shipped files. It is dropped by its label before reach is ever asked.
  assert.equal(shipsToUsers(['package.json', 'server.json']), true);

  // Every squash subject carries its number, and a range that landed nothing lists nothing rather
  // than throwing, which is what an empty compare answers with.
  assert.deepEqual(pullRequestNumbers(['A thing that happened (#274)', 'Another (#275)']), [274, 275]);
  assert.deepEqual(pullRequestNumbers(['Body lines mention (#99) but the subject does not\n\n(#98)']), []);
  assert.deepEqual(pullRequestNumbers([]), []);
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
 * The engine, handed that environment, puts `user://` where it was told to.
 *
 * The fixture above checks the variables are set and says nothing about whether the engine reads
 * them, and the comment on `userDataIn` said macOS reads neither, so that a tier there writes into
 * the player's saves with nothing telling the caller. That is a claim about the engine made from
 * memory of its source, and the engine tier runs on all three platforms, so it is asked instead:
 * a script prints `OS.get_user_data_dir()` under the moved environment and the answer has to sit
 * under the directory it was moved to.
 *
 * It was first held for every platform, because the platform on which the comment was wrong either
 * way was the reading this existed to take. macOS answered `/Users/runner/Library/Application
 * Support/Godot/app_userdata/...` on Godot 4.7.2 with the variable set, so the comment was right and
 * the memory of the engine's source that was going to correct it was wrong. Now the expectation is
 * read off `savesStayPut`, which is the same function the test answer's note reads, so an engine
 * that starts honouring the variable fails here and the change that makes it pass is the change
 * that stops the note.
 */
function testTheEngineWritesItsSavesWhereItWasTold(): void {
  const godotPath = resolveGodotPath();
  if (!godotPath) {
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and GODOT_PATH names no existing file.');
    }
    console.log('user directory regression skipped (Godot not found)');
    return;
  }

  const projectDir = mkdtempSync(join(realpathSync(tmpdir()), 'gdharness-user-dir-'));
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'gdharness-user-home-'));
  try {
    writeFileSync(
      join(projectDir, 'project.godot'),
      'config_version=5\n\n[application]\nconfig/name="UserDirRegression"\n',
    );
    writeFileSync(
      join(projectDir, 'probe.gd'),
      'extends SceneTree\n\n\nfunc _init() -> void:\n\tprint("USER_DATA_DIR=" + OS.get_user_data_dir())\n\tquit()\n',
    );
    const run = spawnSync(godotPath, ['--headless', '--path', projectDir, '--script', 'res://probe.gd'], {
      encoding: 'utf8',
      env: userDataIn(home),
      timeout: ENGINE_CALL_TIMEOUT_MS,
    });
    const printed = /USER_DATA_DIR=(.+)/.exec(run.stdout)?.[1]?.trim();
    assert.ok(printed, `the probe should print where user:// is:\n${run.stdout}\n${run.stderr}`);
    // Compared as spellings rather than resolved, because the engine may not have created the
    // directory yet. `home` is already the real path, and separators and case are the two things
    // Windows spells differently from what it was handed.
    const spelled = (path: string): string => path.replaceAll('\\', '/').toLowerCase();
    const moved = spelled(printed).startsWith(spelled(home));
    if (savesStayPut()) {
      assert.equal(
        moved,
        false,
        `${process.platform}: the engine has started honouring the moved environment, ${printed}; savesStayPut and the note it drives should say so`,
      );
      assert.ok(
        spelled(printed).includes('/library/application support/'),
        `${process.platform}: and it wrote where the player keeps theirs, not ${printed}`,
      );
    } else {
      assert.ok(
        moved,
        `${process.platform}: user:// should be under the directory it was moved to, ${home}, not ${printed}`,
      );
    }
  } finally {
    sweep(projectDir);
    sweep(home);
  }
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
        protocol: RUNTIME_PROTOCOL,
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
    sweep(root);
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
/**
 * A game that announced and went is not a project that never had one.
 *
 * Those are the same sentence today, and only one of them is something a caller can act on: the
 * game was there, it quit or was ended, and what it printed on the way is worth reading. A run
 * downstream announced on a port and its process was gone seconds later, and all the answer said
 * was that no game with the runtime addon is running, which is also what a project with no addon
 * installed is told.
 *
 * The sweep is what destroys the evidence. An announcement whose process has gone is deleted on the
 * way past, correctly, and after that nothing anywhere knows a game was ever there. So the going is
 * remembered as it happens rather than reconstructed, and the refusal reads that.
 *
 * A dead pid is the whole setup: no engine, and nothing that could still be running when the
 * assertions are made.
 */
function testAGameThatAnnouncedAndWentIsSaidSo(): void {
  const root = mkdtempSync(join(tmpdir(), 'gdharness-went-'));
  try {
    const directory = join(root, 'gdharness');
    mkdirSync(directory, { recursive: true });
    // A process that has certainly ended: spawned to exit at once and waited for right here, so the
    // number names nothing by the time the sweep reads it.
    const ended: SpawnSyncReturns<string> = spawnSync(process.execPath, ['--eval', ''], {
      encoding: 'utf8',
    });
    assert.ok(ended.pid > 0, 'the fixture needs a process that has been and gone');
    const announcement = join(directory, `runtime-${ended.pid}.json`);
    writeFileSync(
      announcement,
      JSON.stringify({
        protocol: RUNTIME_PROTOCOL,
        pid: ended.pid,
        port: 51_777,
        address: '127.0.0.1',
        project: { name: 'Went', path: root },
      }),
      'utf8',
    );

    const announced = runtimesAnnounced([directory]);
    // The instrument: the sweep ran and did its job. Without this the refusal below could be the
    // one for an announcement nobody ever wrote.
    assert.deepEqual(announced.running, [], 'a game whose process is gone is not one to talk to');
    assert.equal(existsSync(announcement), false, 'and its announcement is swept');

    const choice = chooseRuntime(announced.running, root, announced.unspoken);
    assert.ok('problem' in choice, 'the call still fails, because there is nothing to talk to');
    const problem = 'problem' in choice ? choice.problem : '';
    assert.match(
      problem,
      new RegExp(`announced itself and its process is gone: pid ${ended.pid}`),
      `the game that went is named: ${problem}`,
    );
    assert.match(problem, /quit or was ended rather than never starting/, `and told apart: ${problem}`);
    assert.match(problem, /editor_output/, `with where its output is: ${problem}`);
    assert.doesNotMatch(problem, /earlier/, `one gone game is reported as one: ${problem}`);

    // A second and a third that went the same way are counted, so a game crashing three times in a
    // minute is not answered as one crash. The most recent is still the one named, because its
    // output is the one worth reading, and the count is what says the others happened.
    const again: SpawnSyncReturns<string> = spawnSync(process.execPath, ['--eval', ''], { encoding: 'utf8' });
    const third: SpawnSyncReturns<string> = spawnSync(process.execPath, ['--eval', ''], { encoding: 'utf8' });
    for (const pid of [again.pid, third.pid]) {
      writeFileSync(
        join(directory, `runtime-${pid}.json`),
        JSON.stringify({
          protocol: RUNTIME_PROTOCOL,
          pid,
          port: 51_777,
          address: '127.0.0.1',
          project: { name: 'Went', path: root },
        }),
        'utf8',
      );
      runtimesAnnounced([directory]);
    }
    const repeated = chooseRuntime([], root, []);
    const thrice = 'problem' in repeated ? repeated.problem : '';
    assert.match(thrice, new RegExp(`gone: pid ${third.pid}`), `the most recent is the one named: ${thrice}`);
    assert.match(thrice, /2 earlier ones went the same way/, `and the others are counted: ${thrice}`);

    // The other project's game is not this project's answer. These directories are shared, and a
    // refusal about somebody else's crash would be the right shape about the wrong game.
    const elsewhere = chooseRuntime([], join(root, 'another'), []);
    const other = 'problem' in elsewhere ? elsewhere.problem : '';
    assert.match(
      other,
      /No game with the runtime addon is running/,
      `a project this game did not belong to gets the ordinary answer: ${other}`,
    );
  } finally {
    sweep(root);
  }
}

/**
 * An announcement whose number has come round again is not a running game.
 *
 * The sweep read "a process with this pid exists" as "the game that wrote this is running", and
 * a number the operating system has handed out again satisfies the first exactly as the game did.
 * A shell downstream took the number of a game ended an hour before, and `editor_status` listed
 * that game as "still starting, or shutting down" through two further runs and a restart of the
 * editor. What a newcomer cannot have is the game's start: a game starts, boots and announces, so
 * its process began before its file was written, and a process that began after the file is one
 * that took the number afterwards.
 *
 * The operating system's answer is handed in, so the disagreement is supplied rather than waited
 * for. The rest of the judgement is held here too: the second the platforms round a start to
 * does not make a game a stranger, a platform that will not say leaves the announcement believed,
 * a fresh announcement is not asked about at all, a confirmation is believed for a while and asked
 * again once it has aged, a verdict is kept while the file is the same one, and a stranger stays
 * one without being asked again.
 */
function testAnAnnouncementIsItsOwnProcess(): void {
  const now = Date.now();
  const asked: number[][] = [];
  const began = new Map<number, number>();
  const startTimes = (pids: readonly number[]): Map<number, number> => {
    asked.push([...pids]);
    return new Map([...pids].filter((pid) => began.has(pid)).map((pid) => [pid, began.get(pid) ?? 0]));
  };
  const file = (pid: number): string => join('announced', `runtime-${pid}.json`);
  const anHourAgo = now - 60 * 60 * 1000;
  const twoMinutesAgo = now - 2 * JUDGED_AFTER_MS;
  const candidates = [
    // Ended an hour ago; the number now belongs to something that started ten minutes ago.
    { file: file(101), pid: 101, writtenAt: anHourAgo },
    // Booted five seconds before it announced, the ordinary shape.
    { file: file(102), pid: 102, writtenAt: twoMinutesAgo },
    // Rounded to a second after its own announcement by a platform that rounds starts.
    { file: file(103), pid: 103, writtenAt: twoMinutesAgo },
    // A platform that will not say when it started.
    { file: file(104), pid: 104, writtenAt: twoMinutesAgo },
    // Announced ten seconds ago, by a process the platform would call a stranger if asked.
    { file: file(105), pid: 105, writtenAt: now - 10_000 },
  ];
  began.set(101, now - 10 * 60 * 1000);
  began.set(102, twoMinutesAgo - 5_000);
  began.set(103, twoMinutesAgo + STARTED_AFTER_ANNOUNCING_MS - 500);
  began.set(105, now - 1_000);

  const strangers = strangersAmong(candidates, now, startTimes);
  assert.deepEqual(
    [...strangers],
    [file(101)],
    'the announcement whose process began after it was written is the stranger, and only it',
  );
  assert.deepEqual(
    asked,
    [[101, 102, 103, 104]],
    'every aged announcement is asked about in one question, and the fresh one is not asked about at all',
  );

  // Believed for a while: the same sweep a second later asks nobody, and the stranger is still one.
  const again = strangersAmong(candidates, now + 1_000, startTimes);
  assert.deepEqual([...again], [file(101)], 'a verdict holds without being asked again');
  assert.equal(asked.length, 1, 'nobody is asked again inside the window');

  // Once the confirmation has aged, the confirmed ones are asked again and the stranger is not: a
  // number that was somebody else's does not become the game's by waiting. The fresh one has aged
  // into the question by now, and is judged the moment it is.
  const later = strangersAmong(candidates, now + CONFIRMED_FOR_MS + 1_000, startTimes);
  assert.deepEqual(
    [...later],
    [file(101), file(105)],
    'the stranger is still one, and the aged one is judged',
  );
  assert.deepEqual(
    asked[1],
    [102, 103, 104, 105],
    `the confirmed announcements are asked about again, the stranger is not, and the fresh one is now aged into the question: ${JSON.stringify(asked)}`,
  );
  assert.equal(asked.length, 2, JSON.stringify(asked));

  // A file written again is a new announcement, whatever was decided about the old one: the game
  // that took the number back is asked about afresh, and it is the game.
  began.set(101, now - 30_000);
  const rewritten = [{ file: file(101), pid: 101, writtenAt: now - 20_000 }];
  assert.deepEqual(
    [...strangersAmong(rewritten, now + CONFIRMED_FOR_MS + 2_000, startTimes)],
    [],
    'an announcement written after the verdict is judged afresh, and a process older than it is its game',
  );
  assert.deepEqual(asked[2], [101], JSON.stringify(asked));
}

/**
 * The platform says when a process started, and the sweep acts on it.
 *
 * The case above supplies the operating system's answer; this one requires that there is one, for
 * a real process, on this platform. Every judgement above passes on a platform that never answers,
 * because an announcement nobody can judge is believed, so the answer is a dependency to assert
 * rather than assume. And the sweep is run against the real answer once: a live process whose
 * announcement is older than the process itself is swept as a game that has gone, and the same
 * process announced afresh is listed, so the sweep is what dropped it and not the file.
 */
function testAStaleAnnouncementWhoseNumberCameRoundIsSwept(): void {
  const before = Date.now();
  const newcomer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const root = mkdtempSync(join(tmpdir(), 'gdharness-came-round-'));
  try {
    const pid = newcomer.pid;
    assert.ok(typeof pid === 'number', 'the fixture needs a live process to have taken the number');
    const ended: SpawnSyncReturns<string> = spawnSync(process.execPath, ['--eval', ''], { encoding: 'utf8' });
    assert.ok(ended.pid > 0, 'and one that has gone, to be left out of the answer');

    const said = startTimesOf([pid, process.pid, ended.pid]);
    const at = said.get(pid);
    assert.ok(at !== undefined, `the platform says when pid ${pid} started: ${JSON.stringify([...said])}`);
    assert.ok(
      at >= before - STARTED_AFTER_ANNOUNCING_MS && at <= Date.now() + STARTED_AFTER_ANNOUNCING_MS,
      `and the start it gives is the one just seen, to the second the platform rounds to: ${at} against ${before}`,
    );
    const own = said.get(process.pid);
    assert.ok(own !== undefined, 'this process is answered about in the same question');
    assert.ok(own <= at, 'and began no later than the child it just started');
    assert.equal(said.has(ended.pid), false, 'a process that has gone is left out rather than made up');

    const directory = join(root, 'gdharness');
    mkdirSync(directory, { recursive: true });
    const announcement = join(directory, `runtime-${pid}.json`);
    const announce = (): void => {
      writeFileSync(
        announcement,
        JSON.stringify({
          protocol: RUNTIME_PROTOCOL,
          pid,
          port: 51_778,
          address: '127.0.0.1',
          project: { name: 'CameRound', path: root },
        }),
        'utf8',
      );
    };
    // The announcement of a game ended an hour ago, whose number the process above then took.
    announce();
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(announcement, anHourAgo, anHourAgo);
    const swept = runtimesAnnounced([directory]);
    assert.deepEqual(
      swept.running,
      [],
      `a process that began after the announcement is not its game: ${JSON.stringify(swept)}`,
    );
    assert.equal(existsSync(announcement), false, 'and the announcement is swept');
    const choice = chooseRuntime(swept.running, root, swept.unspoken);
    assert.match(
      'problem' in choice ? choice.problem : '',
      new RegExp(`announced itself and its process is gone: pid ${pid}`),
      `the game that went is reported as gone: ${JSON.stringify(choice)}`,
    );

    // The same process announced now is a game: the sweep dropped the file for its age against the
    // process, not for the process or the file.
    announce();
    const listed = runtimesAnnounced([directory]);
    assert.deepEqual(
      listed.running.map((one) => one.pid),
      [pid],
      `a fresh announcement of the same process is listed: ${JSON.stringify(listed)}`,
    );
  } finally {
    newcomer.kill();
    sweep(root);
  }
}

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
    sweep(root);
  }
}

/**
 * A game's error report outlives the game by an hour, and no longer.
 *
 * The announcement goes the moment the game does, because it is what says a game is there to
 * talk to. The report is different: it is what the run's last errors are read from, and the
 * server reading the run may not look until after the game has gone, so a report is kept until
 * its game has been gone for an hour. One belonging to a live process is never touched, whatever
 * its age. Found by `errorReportOf` in whichever directory the game announced in.
 */
function testAnErrorReportOutlivesItsGameForAnHour(): void {
  const root = mkdtempSync(join(tmpdir(), 'gdharness-report-sweep-'));
  try {
    const directory = join(root, 'gdharness');
    mkdirSync(directory, { recursive: true });
    const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 60 * 60 * 1000);
    const stale = join(directory, 'runtime-999999998.log');
    const recent = join(directory, 'runtime-999999999.log');
    const living = join(directory, `runtime-${process.pid}.log`);
    for (const [path, age] of [
      [stale, 2],
      [recent, 0.5],
      [living, 48],
    ] as const) {
      writeFileSync(path, 'ERROR: something\n   at: somewhere (res://x.gd:1)\n', 'utf8');
      utimesSync(path, hoursAgo(age), hoursAgo(age));
    }
    assert.equal(errorReportOf(process.pid, [join(root, 'elsewhere'), directory]), living);
    assert.equal(errorReportOf(999999997, [directory]), null, 'a game that reported nothing has no file');

    const announced = runtimesAnnounced([directory]);
    assert.deepEqual(announced.running, [], 'a report is not an announcement');
    assert.ok(!existsSync(stale), 'a report whose game has been gone for two hours is swept');
    assert.ok(existsSync(recent), 'one whose game went half an hour ago is kept for the reader');
    assert.ok(existsSync(living), "a live game's report is kept whatever its age");
  } finally {
    sweep(root);
  }
}

/**
 * A process id picks one game out of several running from one project.
 *
 * A bench fans out to thirty-one workers from the same project, every one of them announcing, and
 * a runtime call with the project path was refused with "stop all but one", which is not advice a
 * bench can take. The pid on every runtime tool is what picks one, and the refusals name it. A pid
 * nobody is running, or one running another project than the path names, is refused with what is
 * running, since a number guessed from a stale listing must not reach a different game.
 */
function testAPidPicksOneOfSeveralGames(): void {
  const project = join(tmpdir(), 'gdharness-bench');
  const other = join(tmpdir(), 'gdharness-other');
  const game = (pid: number, path: string): RuntimeEndpoint => ({
    pid,
    port: 50_000 + pid,
    address: '127.0.0.1',
    project: { name: basename(path), path },
    file: join(path, `runtime-${pid}.json`),
  });
  const workers = [game(11, project), game(12, project), game(13, project)];
  const all = [...workers, game(21, other)];

  const several = chooseRuntime(all, project);
  assert.ok('problem' in several, 'three games from one project is a question the path cannot settle');
  assert.match(text(get(several, 'problem')), /Several games are running from .*Pass pid to choose one/);
  const none = chooseRuntime(all);
  assert.match(text(get(none, 'problem')), /Pass projectPath to choose one, or pid/);

  const picked = chooseRuntime(all, project, [], 12);
  assert.deepEqual(picked, { endpoint: workers[1] }, 'the pid picks the worker, with the path agreeing');
  const alone = chooseRuntime(all, undefined, [], 13);
  assert.deepEqual(alone, { endpoint: workers[2] }, 'and on its own');

  const wrong = chooseRuntime(all, project, [], 21);
  assert.match(
    text(get(wrong, 'problem')),
    /pid 21 is running .*gdharness-other, not .*gdharness-bench/,
    `a pid from another project is refused rather than reached: ${JSON.stringify(wrong)}`,
  );
  const gone = chooseRuntime(all, project, [], 99);
  assert.match(
    text(get(gone, 'problem')),
    /No running game has pid 99\. Running: pid 11/,
    JSON.stringify(gone),
  );
  const nothing = chooseRuntime([], undefined, [], 99);
  assert.match(text(get(nothing, 'problem')), /none with pid 99/, JSON.stringify(nothing));
  const tooNewOne = chooseRuntime(
    [],
    undefined,
    [{ pid: 7, protocol: RUNTIME_PROTOCOL + 1, project: { name: 'x', path: project } }],
    7,
  );
  assert.match(
    text(get(tooNewOne, 'problem')),
    /protocol this server does not speak/,
    JSON.stringify(tooNewOne),
  );
}

/**
 * A runtime that is not listening says whether that is the end of it.
 *
 * The wait has a budget, and a project whose first frame arrives after it was told `listening:
 * false` in the same words as a project with no addon installed: one wanted another call, the
 * other wanted an install, and the answer was the same sentence. A start on a big project is
 * exactly where the difference matters, since that is the boot most likely to outlast a budget.
 */
function testANotYetRuntimeIsNotTheSameAsNoRuntime(): void {
  // Who is asked whether the game is still up, which is what "may yet announce" rests on. A run
  // the editor plays has no handle and no exit code here, so the record says "going" for as long
  // as it exists, including for a game that died in its first frame.
  const played: GodotProcess = {
    process: null,
    pid: null,
    log: new GameLog(),
    transcript: null,
    readOffset: 0,
    projectPath: '/p',
    startedAt: Date.now(),
    exitCode: null,
    throughEditor: true,
    brokeOn: null,
    seenPlaying: true,
  };
  assert.equal(runIsUp(played, false), false, 'the editor saying it is not playing settles it');
  assert.equal(runIsUp(played, true), true, 'and so does the editor saying it is');
  assert.equal(runIsUp(played, null), true, 'an editor that will not say leaves the record');

  // Only once the editor has reported the run playing. Before that, "not playing" is a play the
  // editor has not started yet, which a restarted editor answers until its scan is over, and it
  // is taken as the play still on its way for as long as a play can reasonably take to start.
  const unstarted = { ...played, seenPlaying: false };
  assert.equal(runIsUp(unstarted, false), true, 'a play the editor has not started yet is on its way');
  assert.equal(
    runIsUp(unstarted, false, played.startedAt + PLAY_STARTS_WITHIN_MS),
    false,
    'and an editor that has not started it within the grace is believed',
  );
  assert.equal(
    runIsUp(unstarted, false, played.startedAt + PLAY_STARTS_WITHIN_MS - 1),
    true,
    'up to the last moment of it',
  );

  // The number the game gave for itself, which a played run has whenever it carries the runtime
  // addon. It is the only thing here that can contradict the editor, and the editor needs
  // contradicting: downstream it went on reporting a game it was playing for fifteen seconds after
  // that process had been ended from outside, with an empty runtime list in the same answer.
  const announced = { ...played, announcedPid: 999_999_999 };
  assert.equal(
    runIsUp(announced, true),
    false,
    'a game whose own process is gone is over, whatever the editor still believes',
  );
  assert.equal(
    runIsUp(announced, null),
    false,
    'and an editor that will not say is not the last word either, once the game has announced',
  );
  // The other side, so this is not a check that simply answers false once the field is set: the
  // process asked about here is this one, which is certainly alive.
  assert.equal(
    runIsUp({ ...played, announcedPid: process.pid }, null),
    true,
    'a game whose process is still there stays up when nothing else can say',
  );
  assert.equal(
    runIsUp({ ...played, announcedPid: process.pid }, false),
    false,
    'and the editor saying it has stopped playing still settles it',
  );
  assert.equal(
    runIsUp({ ...played, throughEditor: false, pid: 999_999_999 }, true),
    false,
    'a run this server spawned is asked of the operating system, whatever the editor is playing',
  );
  assert.equal(runIsUp(null, true), false, 'and no run at all is not a run that is up');

  const listening = runtimeVerdict(
    {
      pid: 4242,
      port: 51_300,
      address: '127.0.0.1',
      project: { name: 'F', path: '/p' },
      file: 'runtime-4242.json',
    },
    { addon: true, budgetMs: 5_000, heldAt: null, running: true, withArgs: false },
  );
  assert.deepEqual(listening, { listening: true, pid: 4242, port: 51_300 }, 'a runtime that answered');

  const none = runtimeVerdict(null, {
    addon: false,
    budgetMs: 5_000,
    heldAt: null,
    running: true,
    withArgs: false,
  });
  assert.equal(none['listening'], false);
  assert.equal(none['mayYetAnnounce'], false, 'a project with no addon is never going to announce');

  const booting = runtimeVerdict(null, {
    addon: true,
    budgetMs: 5_000,
    heldAt: null,
    running: true,
    withArgs: false,
  });
  assert.equal(booting['listening'], false);
  assert.equal(booting['mayYetAnnounce'], true, 'a game still running may still announce');
  assert.match(String(booting['note']), /runtimeWaitMs/, 'and the answer names the way to wait longer');

  // The reason the wait ran out is often the caller's own arguments, and from where they sit that
  // is invisible: the same project answers straight away without them. Reported from a run given
  // `--days=600`, which simulates six years before it draws anything.
  const carrying = runtimeVerdict(null, {
    addon: true,
    budgetMs: 5_000,
    heldAt: null,
    running: true,
    withArgs: true,
  });
  assert.match(
    String(carrying['note']),
    /arguments/,
    'a run given arguments of its own is told they are inside the wait',
  );
  assert.doesNotMatch(
    String(booting['note']),
    /arguments/,
    'and a run given none is not told about arguments it did not pass',
  );

  const over = runtimeVerdict(null, {
    addon: true,
    budgetMs: 5_000,
    heldAt: null,
    running: false,
    withArgs: false,
  });
  assert.equal(over['listening'], false);
  assert.equal(over['mayYetAnnounce'], false, 'a game that has ended is not going to announce');
  assert.match(String(over['note']), /editor_output/, 'and the answer says where its output went');

  // Held at a breakpoint is the one case where waiting alone is not enough and the caller has
  // something to do, so it must not read as either of the two above.
  const held = runtimeVerdict(null, {
    addon: true,
    budgetMs: 5_000,
    heldAt: { reason: 'breakpoint', description: 'Paused on breakpoint', text: 'res://main.gd:12' },
    running: true,
    withArgs: false,
  });
  assert.equal(held['mayYetAnnounce'], true, 'a held game announces once it is let go');
  assert.match(String(held['note']), /debug_control continue/, 'and the answer says what lets it go');
}

/**
 * A start says what it left running, when it left something running.
 *
 * The refusal for a game this server cannot read is one call too late to help here: by the time it
 * is given, the caller has already started a second game. Measured before this: `editor_run start`
 * answered `started: true` with a new pid while the announced game went on running, with nothing in
 * the answer naming it, so the project had two games and the server could speak for one.
 *
 * The engine is this process, as the neighbouring bench fixture does it. What is under test is what
 * the answer says, and a start that reaches the answer has gone through every decision above it;
 * needing a real engine would put this in the tier that only CI runs.
 */
async function testAStartSaysWhatItLeftRunning(): Promise<void> {
  // Both protocols, because the two refusals that made this claim are different branches and both
  // were wrong the same way. A game this server cannot read and a game it can read but did not
  // start are the same thing to a spawned start: neither is replaced.
  for (const protocol of [RUNTIME_PROTOCOL, RUNTIME_PROTOCOL + 1]) {
    await aStartLeaves(protocol);
  }
}

async function aStartLeaves(protocol: number): Promise<void> {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'gdharness-stranded-'));
  const project = join(runtimeDir, 'mine');
  const announcements = join(runtimeDir, 'gdharness');
  mkdirSync(announcements, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, 'project.godot'),
    '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="Mine"\n' +
      'run/main_scene="res://main.tscn"\n',
  );
  writeFileSync(join(project, 'main.gd'), 'extends Node\n');
  writeFileSync(
    join(project, 'main.tscn'),
    '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n' +
      '[node name="Main" type="Node"]\nscript = ExtResource("1")\n',
  );
  // This process's pid, so the announcement is of something genuinely alive: a dead one is swept by
  // the reader and the start would then have nothing to report, passing for the wrong reason.
  writeFileSync(
    join(announcements, `runtime-${process.pid}.json`),
    JSON.stringify({
      protocol,
      pid: process.pid,
      port: 51_993,
      address: '127.0.0.1',
      project: { name: 'Mine', path: project },
    }),
    'utf8',
  );

  try {
    let answer = '';
    await withStdioServer(
      async (call) => {
        answer = await call('editor_run', { op: 'start', projectPath: project, headless: true });
      },
      {
        GDHARNESS_RUNTIME_DIR: announcements,
        GDHARNESS_PROJECT: project,
        GODOT_PATH: process.execPath,
      },
    );

    // The positive first: the start went through, so the assertions below are about an answer that
    // was built rather than about a refusal that never reached them.
    assert.match(
      answer,
      /"started":\s*true/,
      `the start should have gone through on protocol ${protocol}: ${answer}`,
    );
    assert.match(
      answer,
      new RegExp(`"alsoRunning":\\s*\\[\\s*${process.pid}`),
      `and should name the game it left running on protocol ${protocol}: ${answer}`,
    );
    assert.match(
      answer,
      /Starting this one did not end it/,
      `and say that starting did not end it on protocol ${protocol}: ${answer}`,
    );
    assert.match(
      answer,
      /End it yourself/,
      `and what the caller can do about it on protocol ${protocol}: ${answer}`,
    );
    // The run it did start, named apart from the one it left, so an answer that reported the new
    // game as something stranded would fail rather than read as a pass.
    assert.doesNotMatch(
      answer,
      new RegExp(`"pid":\\s*${process.pid}\\b`),
      `and not report this process as the run it started: ${answer}`,
    );
  } finally {
    sweep(runtimeDir);
  }
}

/**
 * A test server writes its run where no real run is, and is shown to have written one.
 *
 * The isolation this asserts was added after a suite run on a developer's machine ended another
 * project's bench, six times in fifty minutes, by adopting the note it found in the runtime
 * directory every gdharness on a machine shares. The fix was checked by running the suite and
 * seeing that directory not grow, which is the weakest kind of evidence there is: a suite that
 * stopped starting servers leaves it exactly as untouched.
 *
 * So both halves are asserted here, and the positive one first. The server must write a record
 * naming the run it started, which is the instrument reporting that it fired, and that record must
 * be in the directory this server was given rather than the shared one.
 */
/**
 * A refusal about a run this server cannot reach does not deny the runtime it can see.
 *
 * Reported from a project whose editor was playing a scene while its addon was a version behind the
 * server: the editor did not report `playingInEditor`, so both `editor_run stop` and `editor_output`
 * answered `No game is running. Start one with editor_run.`, in the same session where
 * `editor_status` listed that game's runtime as reachable and every `runtime_*` tool drove it.
 *
 * The advice is the part that had to change whatever puts a server in that state. `editor_run start`
 * replaces the game that is playing rather than adding one, measured downstream as one process
 * before and one after with the old pid gone, so a caller following the sentence ends the run it
 * has just been told is not there. A refusal that is merely unhelpful is a different thing from one
 * that hands out a destructive instruction.
 *
 * The runtime here is forged rather than played, because what is under test is what the server says
 * when it cannot see a game that has announced itself, and an engine is not needed to be unable to
 * see something. The pid is this process, so the announcement is of something genuinely alive: a
 * dead pid is swept by the reader and would leave this asserting the ordinary refusal by accident.
 */
async function testARefusalDoesNotDenyTheRuntimeItCanSee(): Promise<void> {
  const project = mkdtempSync(join(tmpdir(), 'gdharness-adopted-'));
  const runtimeDir = mkdtempSync(join(tmpdir(), 'gdharness-adopted-rt-'));
  const announcements = join(runtimeDir, 'gdharness');
  mkdirSync(announcements, { recursive: true });
  const server = new ServerProcess({
    env: { GDHARNESS_PROJECT: project, GDHARNESS_RUNTIME_DIR: announcements },
  });
  try {
    writeFileSync(
      join(project, 'project.godot'),
      '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="Adopted"\n',
    );
    writeFileSync(
      join(announcements, `runtime-${process.pid}.json`),
      JSON.stringify({
        protocol: RUNTIME_PROTOCOL,
        pid: process.pid,
        port: 51_987,
        address: '127.0.0.1',
        project: { name: 'Adopted', path: project },
      }),
      'utf8',
    );

    await server.initialize('regression-test');
    const refused = textOf(
      await server.request('tools/call', {
        name: 'editor_run',
        arguments: { op: 'stop' },
      }),
    );
    assert.ok(refused !== null, 'the refusal should say something');
    const said = refused;

    // What it must say: the game is there, which tools reach it, and what a start would leave.
    assert.match(said, /A game is running/, `the runtime it can see is not denied: ${said}`);
    assert.match(said, new RegExp(String(process.pid)), `and is named by its pid: ${said}`);
    assert.match(said, /runtime_\*/, `with the tools that do reach it: ${said}`);
    // Not that a start would end it. This branch is reached only when nothing here is holding the
    // game, so the start is spawned and a spawned start is a second process: measured, with a
    // runtime announced for this project and no editor, `started: true` with a new pid and the
    // announced game still running. The reading it used to carry came from a game the editor was
    // playing, which is the one case this branch cannot be about.
    assert.match(said, /leaves this game running as well/, `and what a start would leave: ${said}`);
    assert.doesNotMatch(
      said,
      /replaces the game that is playing/,
      `not the sentence for a game the editor is holding: ${said}`,
    );

    // And what it must not: the advice that ends the run. Paired with the four above rather than
    // standing alone, since a refusal that failed to render at all would satisfy this perfectly.
    assert.doesNotMatch(said, /Start one with editor_run/, `the advice that would end it is gone: ${said}`);

    // The other half, and the one that matters more: a runtime for somebody else's project is not
    // this server's to report on either. The containment this sits beside exists because a server
    // that adopted whatever it found in a shared runtime directory ended another project's bench
    // six times in fifty minutes, so a change widening what a server speaks for has to be shown not
    // to have widened that. Same directory, different project.
    const neighbour = mkdtempSync(join(tmpdir(), 'gdharness-neighbour-'));
    try {
      writeFileSync(
        join(announcements, `runtime-${process.pid}.json`),
        JSON.stringify({
          protocol: RUNTIME_PROTOCOL,
          pid: process.pid,
          port: 51_988,
          address: '127.0.0.1',
          project: { name: 'Neighbour', path: neighbour },
        }),
        'utf8',
      );
      const aboutTheirs = String(
        textOf(await server.request('tools/call', { name: 'editor_run', arguments: { op: 'stop' } })),
      );
      assert.match(
        aboutTheirs,
        /No game is running/,
        `a run of another project's is not one this server reports: ${aboutTheirs}`,
      );
      assert.doesNotMatch(
        aboutTheirs,
        new RegExp(neighbour.replaceAll('\\', '\\\\')),
        `and it is not named in the refusal either: ${aboutTheirs}`,
      );
    } finally {
      sweep(neighbour);
    }

    // The same game, announcing a protocol this server was not built to read, which is what an
    // upgrade window looks like from here: installing moves the addon on disk when the pin moves
    // and a server already spawned stays the version it was. The sweep that finds games to talk to
    // drops these, so the refusal could not see it and reached for the sentence that ends it.
    //
    // Found by bumping the protocol under the fixture above rather than by reading anything: the
    // arm only renders when the two halves disagree, and nothing that agrees will produce it.
    for (const protocol of [RUNTIME_PROTOCOL + 1, RUNTIME_PROTOCOL - 1]) {
      writeFileSync(
        join(announcements, `runtime-${process.pid}.json`),
        JSON.stringify({
          protocol,
          pid: process.pid,
          port: 51_989,
          address: '127.0.0.1',
          project: { name: 'Adopted', path: project },
        }),
        'utf8',
      );
      const far = String(
        textOf(await server.request('tools/call', { name: 'editor_run', arguments: { op: 'stop' } })),
      );
      assert.match(far, /A game is running/, `a game too far off to read is still running: ${far}`);
      assert.match(far, new RegExp(String(process.pid)), `and is named by its pid: ${far}`);
      assert.match(far, new RegExp(`protocol ${protocol}`), `with the protocol it speaks: ${far}`);
      assert.match(
        far,
        protocol > RUNTIME_PROTOCOL ? /this server is the older half/ : /the addon is the older half/,
        `and which half is behind: ${far}`,
      );
      // What a start actually does here, which is not what the branch above this one says. That one
      // is about a game the editor is playing, where a start replaces it. This game is announced
      // and unreadable, a run started here is a separate process, and the measurement was
      // `started: true` with a new pid while the announced game went on running.
      assert.match(
        far,
        /separate process rather than a replacement/,
        `and what a start would leave behind: ${far}`,
      );
      assert.doesNotMatch(
        far,
        /replaces the game that is playing/,
        `not the sentence for a game the editor is playing: ${far}`,
      );
      assert.doesNotMatch(
        far,
        /Start one with editor_run/,
        `the advice that would end it is gone here too: ${far}`,
      );

      // And the call an agent makes before any other says the same thing. Asserted from the answer
      // rather than from the sweep behind it: the two disagreed, `runtime_*` naming the game and
      // `editor_status` reporting an empty list of runtimes about the same moment, and reading
      // either one alone shows something that looks complete.
      const status = parseTextContent(
        await server.request('tools/call', { name: 'editor_status', arguments: {} }),
      );
      const unreadable = asArray(get(status, 'game', 'unreadable'));
      assert.equal(unreadable.length, 1, `the game it cannot read is reported: ${JSON.stringify(status)}`);
      assert.equal(asNumber(get(unreadable[0], 'pid')), process.pid, 'by its pid');
      assert.equal(asNumber(get(unreadable[0], 'protocol')), protocol, 'with the protocol it speaks');
      assert.equal(
        text(get(unreadable[0], 'behind')),
        protocol > RUNTIME_PROTOCOL ? 'server' : 'addon',
        'and which half is behind',
      );
      // Beside it rather than instead of it: a game this server cannot speak to is not a runtime it
      // can reach, and folding the two together would offer tools that do not work.
      assert.deepEqual(get(status, 'game', 'runtimes'), [], 'and is not counted among the ones it can reach');
      assert.equal(get(status, 'game', 'runtimeConnected'), false, 'nor reported as connected');
    }
  } finally {
    await server.stop();
    sweep(project);
    sweep(runtimeDir);
  }
}

async function testATestServerWritesWhereNoRealRunIs(): Promise<void> {
  const project = mkdtempSync(join(tmpdir(), 'gdharness-isolation-'));
  const shared = join(runtimeDirectory(withoutRuntimeDir(process.env)), 'runs', 'run.json');
  // Read rather than removed: something of this machine's may be running, and a fixture that
  // cleared it would be doing the very thing it is here to prove cannot happen.
  const before = existsSync(shared) ? readFileSync(shared, 'utf8') : null;
  const server = new ServerProcess({ env: { GODOT_PATH: process.execPath } });
  try {
    writeFileSync(
      join(project, 'project.godot'),
      '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="Alone"\n' +
        'run/main_scene="res://main.tscn"\n',
    );
    writeFileSync(join(project, 'main.tscn'), '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n');

    await server.initialize('regression-test');
    const started = jsonOf(
      textOf(
        await server.request('tools/call', {
          name: 'editor_run',
          arguments: { projectPath: project, op: 'start', headless: true },
        }),
      ) ?? '',
      'editor_run start',
    );
    const pid = asNumber(get(started, 'pid'));
    assert.ok(pid > 0, `the fixture needs a run to have been started: ${JSON.stringify(started)}`);

    assert.ok(server.runtimeDir !== null, 'a server given no runtime directory is given one here');
    const ours = join(server.runtimeDir, 'runs', 'run.json');
    assert.ok(existsSync(ours), `the run is recorded in this server's own directory: ${ours}`);
    assert.equal(
      get(JSON.parse(readFileSync(ours, 'utf8')), 'pid'),
      pid,
      'and the record is this run, so the write above is the one being checked',
    );

    const after = existsSync(shared) ? readFileSync(shared, 'utf8') : null;
    assert.equal(after, before, 'while the directory every gdharness shares is left as it was');
  } finally {
    await server.stop();
    sweep(project);
  }
}

/**
 * A start does not sit out its budget on a game that is already over.
 *
 * The wait is for an announcement, and a process that has exited is not going to make one. A boot
 * that dies on a parse error is gone in half a second, and waiting the rest of the budget out
 * delays the very answer that says so. Driven with a fake engine, which exits at once, so what is
 * measured is the waiting rather than anything Godot does.
 *
 * The budget is ten seconds here and the answer has to arrive well inside it, which is also the
 * only assertion that runtimeWaitMs reaches the wait at all: the default is five.
 */
async function testAStartStopsWaitingForAGameThatIsOver(): Promise<void> {
  const project = mkdtempSync(join(tmpdir(), 'gdharness-over-'));
  const runtimeDir = mkdtempSync(join(tmpdir(), 'gdharness-over-runtime-'));
  try {
    writeFileSync(
      join(project, 'project.godot'),
      '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="Over"\n' +
        'run/main_scene="res://main.tscn"\n',
    );
    writeFileSync(join(project, 'main.tscn'), '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n');
    // The wait only happens for a project that could announce, which is one with the addon on
    // disk. Its contents do not matter: nothing runs it here.
    mkdirSync(join(project, 'addons', 'gdharness_runtime'), { recursive: true });
    writeFileSync(join(project, 'addons', 'gdharness_runtime', 'runtime_autoload.gd'), 'extends Node\n');

    await withStdioServer(
      async (call) => {
        const started = Date.now();
        const answer: unknown = JSON.parse(
          await call('editor_run', {
            projectPath: project,
            op: 'start',
            headless: true,
            runtimeWaitMs: 10_000,
          }),
        );
        const waited = Date.now() - started;
        const runtime = get(answer, 'runtime');
        assert.equal(get(runtime, 'listening'), false, JSON.stringify(answer));
        assert.equal(
          get(runtime, 'mayYetAnnounce'),
          false,
          `a game that is over is not going to announce: ${JSON.stringify(runtime)}`,
        );
        assert.match(String(get(runtime, 'note')), /no longer running/, JSON.stringify(runtime));
        assert.ok(waited < 8_000, `the answer should not wait out the budget: ${waited}ms`);
      },
      { GODOT_PATH: process.execPath, GDHARNESS_RUNTIME_DIR: runtimeDir },
    );
  } finally {
    sweep(project);
    sweep(runtimeDir);
  }
}

/**
 * Starting a game and being able to talk to it are two moments, and a start waits for both.
 *
 * The editor answers `play_scene` as soon as it has asked the engine to play, so the call right
 * after a start was answered "No game with the runtime addon is running" about a game that was
 * starting, and the way through was to make the same call again. Twice in one session.
 */
async function testAStartWaitsForTheGameToAnnounceItself(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'gdharness-waiting-'));
  try {
    const directory = join(root, 'gdharness');
    mkdirSync(directory, { recursive: true });
    const announce = (pid: number, port: number): void => {
      writeFileSync(
        join(directory, `runtime-${pid}.json`),
        JSON.stringify({
          protocol: RUNTIME_PROTOCOL,
          pid,
          port,
          address: '127.0.0.1',
          project: { name: 'Fixture', path: root },
        }),
        'utf8',
      );
    };

    // The game already playing when the start was asked for, which is what a game that has just
    // been stopped looks like while it is still dying.
    announce(process.pid, 51_240);
    const before = new Set([process.pid]);

    const late = setTimeout(() => {
      announce(process.ppid, 51_241);
    }, 120);
    try {
      const found = await announcedSince(root, before, { budgetMs: 4_000, directories: [directory] });
      assert.equal(found?.port, 51_241, 'the wait ends on the game that was not there before');
    } finally {
      clearTimeout(late);
    }

    const elsewhere = await announcedSince(join(root, 'elsewhere'), new Set(), {
      budgetMs: 60,
      directories: [directory],
    });
    assert.equal(elsewhere, null, 'a game from another project is not the one being waited for');

    const started = Date.now();
    const seen = new Set([process.pid, process.ppid]);
    const nothing = await announcedSince(root, seen, { budgetMs: 120, directories: [directory] });
    assert.equal(nothing, null, 'and a game that never announces is given up on');
    assert.ok(Date.now() - started >= 100, 'after the budget rather than at once');

    // A game held at a breakpoint cannot announce until it is let go, so the wait ends rather
    // than sitting out the budget on a game that has stopped booting.
    const gaveUp = Date.now();
    const held = await announcedSince(root, seen, {
      budgetMs: 4_000,
      directories: [directory],
      giveUp: () => true,
    });
    assert.equal(held, null, 'a game that has stopped is not waited for');
    assert.ok(Date.now() - gaveUp < 1_000, 'and the wait ends at once rather than at the budget');
  } finally {
    sweep(root);
  }
}

/**
 * A version mismatch sends the reader at whichever half is actually behind.
 *
 * Both directions happen, and the second is the one that got told to do the wrong thing: upgrading
 * a project mid-session writes the new addon while the harness carries on spawning the server it
 * already started, so the editor holds the newer half and restarting it widens the gap.
 */
/**
 * Everywhere that names the cure for an editor gone blind to a class names the cheap one first.
 *
 * The cure is `editor_rescan` on its own. A restart also works and costs somebody their window, so
 * both are named and the order matters.
 *
 * This check used to enforce the opposite, and that is the part worth keeping. It required all three
 * places to say "change the declaring script, then rescan", because that was what one downstream
 * report had measured. The report was retracted: its rescans had answered before the scan started,
 * which is a timing this tool no longer has. Meanwhile a fixture here asserted the rescan alone is
 * the cure and failed when the rescan was removed, on three platforms, and a second project
 * reproduced that against its own case in 203ms.
 *
 * So the suite held one answer while the suite held the other, and this check is why the wrong
 * sentence survived being corrected everywhere else: it defended it in three files. A test that
 * encodes a claim keeps the claim alive after the evidence for it is gone, which is worse than
 * having no test, because it takes a deliberate act to overrule.
 *
 * Then it missed a fourth place for a release, and the way it missed it is the second half of the
 * lesson. It gathered lines of source containing `editor_launch restart` and matched each line for
 * the claim. The skill's *Editing* paragraph said "Change the declaring script, or restart the
 * editor": not that phrase, so never gathered, and split across two source lines at "Change the",
 * so a line could not have held it anyway. A downstream session read it in the installed SKILL.md,
 * which is where every session reads it first. The check was reading ingredients, and the file a
 * caller receives is assembled from them in a shape no line of source has.
 *
 * So the skill and the tool reference are rendered here, whole, the way `setup` writes them, and
 * the claim is matched across whitespace rather than within a line. The source lines are still
 * read for the answers built at run time, which no rendering reaches without an editor.
 */
function testTheCureIsWrittenWhole(): void {
  const rescan = toolSpec('editor_rescan')?.description ?? '';
  assert.match(rescan, /The cure is this call on its own/, 'the tool that is the cure says so');
  assert.match(rescan, /editor_launch restart/, 'and names the restart for when it is not enough');

  // What a caller receives, as it is written: every file of the installed skill, whole.
  const installed = [...skillFiles('0.0.0-test').entries()].map(([path, text]) => ({ where: path, text }));
  assert.ok(
    installed.some(({ where }) => where === 'SKILL.md') &&
      installed.some(({ where }) => where.endsWith('tools.md')),
    'the skill renders both of its files',
  );
  // The paragraph that carried the fourth wrong sentence, held as a positive so the sweep below is
  // known to be reading the paragraph rather than a skill that stopped mentioning the fault.
  const skill = installed.find(({ where }) => where === 'SKILL.md')?.text ?? '';
  assert.match(skill, /Could not find type/, 'the skill still explains the fault');
  assert.match(
    skill,
    /needs no change to the declaring script/,
    'and its Editing paragraph names the cure the rescan description names',
  );

  // Every place that offers a remedy, whichever fault it is about. The claim being held is not
  // about any one of them: it is that none of them sends a caller to edit source that is already
  // correct, which is what all three used to do and what a check like this used to require.
  const offered = [
    { where: 'editor_rescan description', text: rescan },
    // Rendered rather than read out of the file it is built in, because it is built in parts and a
    // line of source holds no whole sentence. Reading lines would pass it over in silence.
    {
      where: 'staleAnalysisNote',
      text: staleAnalysisNote(
        [{ kind: 'method', member: 'silence', type: 'Bell', declaredIn: 'res://bell.gd' }],
        [],
      ),
    },
    ...installed,
    ...readdirSync('src')
      .filter((name) => name.endsWith('.ts'))
      .flatMap((name) =>
        readFileSync(join('src', name), 'utf8')
          .split('\n')
          .filter((line) => line.includes('editor_launch restart'))
          .map((line) => ({ where: name, text: line })),
      ),
  ];
  // What the tree holds today and not a comfortable minimum, so one place going quiet lowers this
  // in the same change and somebody confirms it was meant.
  assert.equal(offered.length, 24, `the places offering a remedy should all be found, not ${offered.length}`);

  // Across whitespace, because a rendered file wraps where the source did not and a sentence that
  // breaks at "the" is the same sentence. Change, edit and touch, because the claim is about what
  // the caller is told to do to the file and not about one verb for it.
  for (const { where, text } of offered) {
    const found =
      /\b(?:[Cc]hang(?:e|ing)|[Ee]dit(?:ing)?|[Tt]ouch(?:ing)?)\s+the\s+declaring\s+script\b/.exec(text);
    assert.equal(
      found,
      null,
      `${where} should not tell a caller to edit correct source: ${text.slice(Math.max(0, (found?.index ?? 0) - 60), (found?.index ?? 0) + 80)}`,
    );
  }
}

/**
 * Every place that chooses a remedy for a class the editor cannot see leads with the scan, and every
 * place that describes what the scan does to the cache says it is rebuilt.
 *
 * `testTheCureIsWrittenWhole` holds one claim, that nothing sends a caller to edit correct source,
 * and the ostinato session found two neighbours it cannot see by construction because each is a
 * different claim. The skill said the scan drops an unresolved class out of the cache and *the next
 * fresh engine, CI run or clone starts from the narrower one*, while the rescan description beside
 * it says the loss is named under `cacheLost`, the cache is rebuilt, and nothing inherits the short
 * file: the skill described the fault the tool fixes as the tool's behaviour, and a session reading
 * it would refuse a scan the reference says to make. And `script_diagnostics` ended by saying a
 * stale type *needs* `editor_launch restart` and a missing class *needs* `project_import
 * refresh_classes`, while the notes a caller receives lead with `editor_rescan` for both; the
 * description is what a session reads before any call, so it booted a headless engine beside a
 * running bench for the state the note was rewritten to keep it from.
 *
 * Held as claims rather than sentences. Which remedy is first is read off where each remedy's name
 * first appears, so a rewording that keeps the order passes and one that moves the restart or the
 * headless pass ahead of the scan fails, whatever words it uses. The rescan's own description is
 * left out of the ordering, since it names itself as "this call" rather than by its tool name, and
 * is held by its own sentence in the case above. The cache claim is held on the skill's *Editing*
 * section, as the field the answer carries and as an absence beside it.
 */
function testEveryRemedyLeadsWithTheScan(): void {
  const remedies = ['editor_rescan', 'editor_launch restart', 'project_import refresh_classes'] as const;
  const skill = skillFiles('0.0.0-test').get('SKILL.md') ?? '';
  const editing = skill.slice(skill.indexOf('## Editing'), skill.indexOf('## Refusals are useful'));
  assert.ok(editing.length > 200, 'the Editing section is found and holds its paragraphs');

  const choosing: { where: string; text: string }[] = [
    { where: 'script_diagnostics description', text: toolSpec('script_diagnostics')?.description ?? '' },
    {
      where: 'staleAnalysisNote',
      text: staleAnalysisNote(
        [{ kind: 'method', member: 'silence', type: 'Bell', declaredIn: 'res://bell.gd' }],
        [],
      ),
    },
    { where: 'uncachedClassNote', text: uncachedClassNote(['Bell']) },
    // Backticks off and whitespace folded, because the rendered skill wraps `editor_launch restart`
    // across a line and a name split at a line break is the same name.
    { where: 'SKILL.md Editing', text: editing.replaceAll('`', '').replaceAll(/\s+/g, ' ') },
  ];
  for (const { where, text } of choosing) {
    const named = remedies
      .map((remedy) => ({ remedy, at: text.indexOf(remedy) }))
      .filter(({ at }) => at >= 0)
      .sort((one, other) => one.at - other.at);
    assert.ok(named.length >= 2, `${where} chooses between remedies, naming ${named.length}`);
    assert.equal(
      named[0]?.remedy,
      'editor_rescan',
      `${where} should lead with the scan, not ${named[0]?.remedy}: ${text.slice(Math.max(0, (named[0]?.at ?? 0) - 80), (named[0]?.at ?? 0) + 60)}`,
    );
  }

  // What the scan does to the cache, as the skill tells it. The field is the positive; the absence
  // beside it is the retracted claim, matched as a claim about who inherits what rather than as the
  // sentence that carried it.
  assert.match(editing, /cacheRestored/, 'the Editing section names the field that says the cache came back');
  // Every sentence about a fresh engine, CI run or clone and the short cache has to be the negated
  // claim. The affirmative and the negation share every word but one, so the check reads the
  // sentence for the negation rather than looking for the words the two have in common.
  const folded = editing.replaceAll(/\s+/g, ' ');
  const aboutInheriting = folded
    .split(/(?<=\.)\s/)
    .filter(
      (sentence) => /(?:engine|CI run|clone)/.test(sentence) && /(?:starts? from|inherits?)/.test(sentence),
    );
  assert.ok(aboutInheriting.length >= 1, 'the Editing section still says who inherits the cache');
  for (const sentence of aboutInheriting) {
    const verb = /(?:starts? from|inherits?)/.exec(sentence)?.index ?? 0;
    assert.match(
      sentence.slice(0, verb),
      /\b(?:no|nothing|neither)\b/,
      `a sentence about who inherits the cache should say nobody does, not: ${sentence}`,
    );
  }
}

/**
 * The note a caller reads when the editor is reporting against an older copy names the call that
 * rebuilds it, and names the script to point it at.
 *
 * This is the answer that arrives at the moment the fault fires, and for three releases it offered a
 * scan that works one time in five, a dependency to go and touch, and a restart, while the call
 * built for exactly this went unmentioned. A remedy nothing reaches is not shipped.
 *
 * Held over the rendered note rather than over the source that builds it: the sentence is assembled
 * from parts, so no line of the file contains it and a check reading lines would report nothing
 * wrong about a note that said nothing at all.
 */
function testTheStaleNoteNamesTheCallThatRebuildsTheCopy(): void {
  const bell: Contradicted = {
    kind: 'method',
    member: 'silence',
    type: 'Bell',
    declaredIn: 'res://bell.gd',
  };
  const alone = staleAnalysisNote([bell], []);
  assert.match(alone, /Run editor_rescan first/, 'the remedy that has cleared this comes first');
  assert.match(alone, /reloadScript/, 'the note should name the argument that rebuilds the built copy');
  assert.match(alone, /res:\/\/bell\.gd/, 'and the script to point it at, which only the caller can know');
  assert.match(alone, /reloadedMethods/, 'and the reading that says the rebuild happened');
  assert.match(alone, /editor_launch restart/, 'with the restart kept as the one that always worked');
  assert.match(alone, /depend on no other global class/, 'and no lever invented where there is none');
  // The reload is offered without being credited with the clearing, and the note now says why
  // rather than hedging: testAMethodAddedToAnAnalysedTypeIsPickedUp in the editor tier takes both
  // readings in one window and finds the analyser resolving a call to a newly added method while
  // the built copy of that script has not got it. One stale and one current at the same moment is
  // two objects. This assertion held "is not known to be what clears these" until that reading
  // existed, and changing it took measuring the thing rather than rewording the sentence.
  assert.match(alone, /the analyser resolved a call to a newly added method/, 'the divergence is stated');
  assert.match(alone, /is not what clears these; the scan is/, 'and the reload is not credited with it');
  assert.match(
    alone,
    /where this turns up/,
    'and the empty lever says why it is empty, since a leaf type is where the fault is easiest to make',
  );
  // Every figure quoted is of the tool as it is now. One clearing in five attempts was taken
  // against a version where the rescan answered before the scan had started, so it measures that
  // timing rather than a scan, and beside the current readings it argued the opposite of what the
  // current readings say. The project that took those five is the one that noticed.
  assert.match(alone, /since the scan timing was fixed/, 'the readings are of the tool as it is now');
  assert.doesNotMatch(alone, /one of five/, 'and the count of the old timing is not quoted as the new');
  assert.doesNotMatch(alone, /measured here/, 'nor is anybody else’s reading claimed as this bench’s');
  // The milliseconds are the scan's own waitedMs. A duration written beside a cure is read as the
  // duration of the cure, and nobody timed the gap between the scan returning and the re-read, so
  // the figures are held to the phrasing that says what they timed rather than to their absence.
  assert.match(alone, /the scan returning in 243ms and 275ms/, 'the timing says what it timed');

  // The lever is a dependency of the stale type, never the stale type itself: sending a caller to
  // edit the file the diagnostics are already wrong about is the retracted cure, and the one thing
  // every one of these sentences has to keep out. See testTheCureIsWrittenWhole.
  const withLever = staleAnalysisNote([bell], ['Rope', 'Clapper']);
  // "or" between the levers and "then" before the scan, because "changing Clapper, Rope and
  // rescanning" read as three things to do, the last of them a file called rescanning.
  assert.match(
    withLever,
    /changing Clapper or Rope and then rescanning/,
    'named in order, so the note is stable, and as alternatives followed by the scan',
  );
  assert.doesNotMatch(withLever, /depend on no other global class/, 'and the no-lever half is gone');

  const pair = staleAnalysisNote(
    [bell, { ...bell, member: 'toll' }, { ...bell, type: 'Rope', declaredIn: 'res://rope.gd' }],
    [],
  );
  assert.match(pair, /some types/, 'more than one type reads as more than one');
  assert.match(pair, /those copies/, 'and the plural carries through the sentence');
  // reloadScript takes one script. A list of them behind it is a call that gets refused, which is
  // worse than saying nothing: the note is read at the moment a caller has already been misled once.
  assert.match(
    pair,
    /reloadScript takes one script, so a call each for res:\/\/bell\.gd and res:\/\/rope\.gd/,
    'two declaring scripts are two calls, said as two calls',
  );
  assert.equal(
    toolSpec('editor_rescan')?.parameters['reloadScript']?.['type'],
    'string',
    'and that is what the argument is, so the sentence above is checkable rather than a habit',
  );

  // Two members missing from one class: two entries, one stale type, one script. This is the shape
  // the second project reproduced first, and every plural in the note has to count what it is about
  // rather than how many diagnostics arrived.
  const twoMembers = staleAnalysisNote([bell, { ...bell, member: 'toll' }], []);
  assert.match(twoMembers, /an older copy of a type/, 'one class is one type however many members');
  assert.match(twoMembers, /reloadScript set to res:\/\/bell\.gd recompiles that copy/, 'and one call');

  // Nothing contradicted has nothing to say. The server only builds this when something is, so the
  // empty answer is unreachable from there and reachable from anywhere else that calls the function.
  assert.equal(staleAnalysisNote([], []), '', 'an empty list gets no sentence rather than a hollow one');
  assert.equal(staleAnalysisNote([], ['Rope']), '', 'and a lever with nothing to apply it to is still none');
}

/**
 * The note for a class the cache has not got says which remedy starts an engine.
 *
 * It named `project_import refresh_classes` alone, which is correct and is a headless engine pass.
 * A project running a bench or a fan-out may forbid a second engine against the same project, so in
 * the one situation where this fault is most likely the note pointed at the remedy that cannot be
 * used and said nothing about the one that can. Measured in a second project: `editor_rescan`
 * cleared it in 314ms with 31 workers still importing, and the fan-out finished unharmed.
 *
 * The scan is offered with its own limit rather than as the better answer, because a file another
 * engine has already imported reads as settled and the walk skips it. Availability and correctness
 * are different questions and the note now answers both.
 */
function testTheUncachedNoteSaysWhichRemedyStartsAnEngine(): void {
  const note = uncachedClassNote(['ProbeStale']);
  assert.match(note, /Try editor_rescan first/, 'the remedy that starts nothing comes first');
  assert.match(note, /starts nothing/, 'and says so, because that is what decides whether it can be used');
  assert.match(note, /not always enough/, 'with the limit that makes the other one necessary');
  assert.match(note, /a short headless engine/, 'and the other one named as the engine it is');
  assert.match(note, /project_import refresh_classes/, 'which is still the remedy that reaches that case');
  assert.match(note, /is declared/, 'one class reads as one');

  const two = uncachedClassNote(['ProbeStale', 'Outcome']);
  assert.match(two, /ProbeStale, Outcome are declared/, 'and two read as two, in the order given');
  assert.match(two, /resolve them/, 'with the pronoun carried through');

  assert.equal(uncachedClassNote([]), '', 'nothing missing from the cache gets no sentence');
}

/**
 * A restart waits for the editor to say who it is, not merely to connect.
 *
 * The socket connects first and the addon's version, the editor's pid and its ports arrive a moment
 * later with `godot_ready`. Waiting only for the connection read that gap as the restart being
 * done: the answer came back with no version and no pid, `addonIsStale` compared undefined against
 * the shipped version and said true, and the note told the caller to restart a healthy editor
 * again. Reported downstream on a restart onto the current addon, and it cost them nothing only
 * because they call `editor_status` after a restart out of a habit an earlier issue gave them.
 *
 * Held here rather than in the editor tier because that tier cannot reach it: its editor is
 * headless, a headless editor refuses to restart, and the refusal is what that case asserts.
 */
function testARestartWaitsForTheEditorToSayWhoItIs(): void {
  const startedAt = 1_000_000;
  const newer = new Date(startedAt + 5_000);
  const older = new Date(startedAt - 5_000);

  assert.equal(
    theEditorHasComeBack({ connected: false, connectedAt: newer, addonVersion: '0.9.0' }, startedAt),
    false,
    'nothing connected is not an editor that has come back',
  );
  assert.equal(
    theEditorHasComeBack({ connected: true, connectedAt: older, addonVersion: '0.9.0' }, startedAt),
    false,
    'and the connection that was already there is the one being replaced',
  );
  // The branch nothing produced before: connected, newer, and not yet a word out of it.
  assert.equal(
    theEditorHasComeBack({ connected: true, connectedAt: newer, addonVersion: undefined }, startedAt),
    false,
    'a socket that has connected and said nothing yet is not an answer',
  );
  assert.equal(
    theEditorHasComeBack({ connected: true, connectedAt: newer, addonVersion: '0.9.0' }, startedAt),
    true,
    'and one that has reported its version is',
  );
  // The empty string is an addon too old to report one, recorded when godot_ready lands. Waiting
  // for a non-empty version would hang on exactly the editors the staleness note exists for.
  assert.equal(
    theEditorHasComeBack({ connected: true, connectedAt: newer, addonVersion: '' }, startedAt),
    true,
    'so is one too old to have a version to report',
  );
}

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

  // Read as the sentences they are, because each half was written to fit a template that also
  // supplied a noun: the unversioned name ended in "addon" and so did the template, and the two
  // met as "the addon from before versions were reported addon". Both branches rendered fine to a
  // check reading them for the version they name, which is what every case above does.
  // Each of these names the addon once. The unversioned name was a phrase ending in "addon" put
  // into a template that supplied "addon" itself, and the two met as "the addon from before
  // versions were reported addon while this server ships 0.5.0". The words are not adjacent, so a
  // doubled-word check reads it as clean, which is what a first attempt at this asserted and what
  // a disarm then passed. Counting the noun is the thing that bites.
  for (const [what, said] of [
    ['a version', behind],
    ['no version', unversioned],
    ['a newer version', ahead],
  ] as const) {
    assert.equal(
      said.match(/\baddon\b/g)?.length,
      1,
      `the note for ${what} should name the addon once: ${said}`,
    );
    assert.match(said, /^The editor is running (an|the) \S/, `and should read as a sentence: ${said}`);
  }
}

/**
 * A version the checker has already judged too old to use is not handed to the caller.
 *
 * The cache outlives the process that wrote it, so a restarted server starts holding an answer
 * obtained hours earlier. On its first tool call `refresh()` runs, sees the window has passed and
 * starts a fetch, and `notice()` used to answer with the stale version anyway, upgrade command and
 * release-notes link included. A project on a machine where four releases went out in a day was
 * told by a freshly started server to install a version and a half behind, and the call after that
 * named the right one.
 *
 * Asserted without the network in either direction: `refresh()` sets `checking` before it awaits
 * anything, so both readings below are taken in the same tick and do not depend on the registry
 * answering, or existing. The registry stands in as a request that never settles, which holds the
 * checker in the one state this is about for as long as the assertions take.
 */
function testAStaleUpdateAnswerIsNotHandedOut(): void {
  const home = mkdtempSync(join(tmpdir(), 'gdharness-stale-notice-'));
  const environment = {
    HOME: home,
    LOCALAPPDATA: home,
    XDG_CACHE_HOME: home,
    GDHARNESS_NO_UPDATE_CHECK: '',
  };
  const seed = (checkedAt: number): void => {
    writeFileSync(cacheFile(environment), JSON.stringify({ checkedAt, latest: '99.9.9' }), 'utf8');
  };
  // The window itself rather than a second copy of it, so that shortening one does not leave this
  // fixture seeding a timestamp on the other side of a boundary it no longer describes.
  const window = CACHE_MS;
  const pending = (): Promise<string | null> => new Promise<string | null>(() => {});

  try {
    // The witness first: an answer inside the window is reported, so the silence below is this
    // guard and not the notice having stopped working altogether.
    seed(Date.now());
    const fresh = new UpdateCheck('0.1.0', environment, pending);
    fresh.refresh();
    assert.equal(fresh.notice()?.latest, '99.9.9', 'an answer still inside the window is reported');

    seed(Date.now() - window - 60_000);
    const stale = new UpdateCheck('0.1.0', environment, pending);
    assert.equal(
      stale.notice()?.latest,
      '99.9.9',
      'the cache is read at construction, which is what makes it available to say',
    );
    stale.refresh();
    assert.equal(stale.notice(), null, 'and it is withheld once a refresh for it is in flight');
  } finally {
    sweep(home);
  }
}

/**
 * A server that has just started asks the registry, whatever answer the machine already holds.
 *
 * The cache is one file per user, not per session, so whichever process asked first decides what
 * every server started afterwards believes for the rest of the window. Measured on this machine
 * while the window was four hours: the file named 0.13.34, taken 102 minutes earlier, and 0.13.35
 * and 0.13.36 shipped under it. A session running 0.13.34 was told nothing, because the answer in
 * hand was not newer than the version it was running, and a reconnect, which is the one moment
 * somebody is deliberately finding out whether they are current, started a server that read the
 * same file and asked nobody.
 *
 * The registry is counted rather than reached. Whether a check was started is the whole of what
 * this is about, and a server that asked and one that quoted somebody else's answer are the same
 * object from outside.
 */
async function testAFreshServerAsksRatherThanInheritingAnAnswer(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gdharness-fresh-ask-'));
  const environment = {
    HOME: home,
    LOCALAPPDATA: home,
    XDG_CACHE_HOME: home,
    GDHARNESS_NO_UPDATE_CHECK: '',
  };

  try {
    // Written now, so nothing about it is stale and the old rule would have declined to ask.
    writeFileSync(
      cacheFile(environment),
      JSON.stringify({ checkedAt: Date.now(), latest: '0.13.34' }),
      'utf8',
    );

    let asks = 0;
    const registry = (): Promise<string | null> => {
      asks += 1;
      return Promise.resolve('0.13.36');
    };
    const check = new UpdateCheck('0.13.34', environment, registry);

    assert.equal(check.notice(), null, 'the inherited answer is not newer, so there is nothing to say');
    check.refresh();
    assert.equal(asks, 1, 'and the server asks anyway, because it has just started');

    // Settled, so what the registry said is taken up rather than merely requested.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(check.notice()?.latest, '0.13.36', 'the release published since is what it reports');

    check.refresh();
    assert.equal(asks, 1, 'and a second call inside the window asks nothing further');
  } finally {
    sweep(home);
  }
}

/**
 * The window an answer stands for is short enough that a release is worth publishing at all.
 *
 * This is the only automatic path by which a running session learns a newer gdharness exists, and
 * the project publishes several times in a day. Every hour on this number is an hour in which a
 * downstream session goes on working against a version that has been superseded, having been told
 * nothing, and the fix is already on npm. Raising it means saying so here in the same change.
 */
function testTheUpdateWindowTracksHowOftenThisShips(): void {
  assert.ok(
    CACHE_MS <= 15 * 60 * 1000,
    `an answer stands for ${Math.round(CACHE_MS / 60_000)} minutes, which is longer than the gap ` +
      'between releases here; a session would miss most of them',
  );
  // And not so short that a working session is asking on most of its tool calls.
  assert.ok(CACHE_MS >= 60 * 1000, 'but not so short that it asks on every other call');
}

/**
 * The registry is npm, or somewhere else over https, and never anything but those.
 *
 * Naming a mirror is the operator's own file rather than anything a tool call can reach, but the
 * value still arrives as a string and the property worth keeping is that this module talks over
 * https or not at all. A mistyped one falls back rather than stopping the server, because refusing
 * to start over a misspelt mirror is worse than asking npm.
 */
function testTheRegistryIsHttpsOrNpm(): void {
  const npm = 'https://registry.npmjs.org/gdharness/latest';
  assert.equal(registryFor({}), npm, 'nothing named is npm');
  assert.equal(registryFor({ GDHARNESS_REGISTRY: '' }), npm, 'and so is an empty one');
  assert.equal(
    registryFor({ GDHARNESS_REGISTRY: 'https://npm.inside.example/' }),
    'https://npm.inside.example/gdharness/latest',
    'an https mirror is asked instead, for the same document',
  );
  for (const wrong of ['http://npm.inside.example', 'file:///etc/passwd', 'npm.inside.example', '::']) {
    assert.equal(registryFor({ GDHARNESS_REGISTRY: wrong }), npm, `${wrong} falls back to npm`);
  }
}

/**
 * The update notice reaches the agent, once, and says what to do about it.
 *
 * Driven off a seeded cache rather than the registry: the point is the answer a tool carries, and
 * a fixture that needs the network to make that assertion is one that fails on a train. The server
 * is pointed at a port nothing listens on, because a server that has just started asks whatever the
 * cache holds, and npm answering first would replace the seeded version with the real one and leave
 * nothing to report. So this also holds for a check that failed: an answer already in hand is still
 * worth saying, and offline and behind is the state where it is worth saying most.
 *
 * The dead port on its own proves nothing about whether the variable was read, since npm being slow
 * looks the same from here; that is why this failed on one platform of three and passed on the other
 * two. What the variable maps to is asserted in `testTheRegistryIsHttpsOrNpm`, and that the
 * environment reaches a spawned server's checker at all is what the off-switch fixture below shows.
 */
async function testUpdateNoticeRidesOnAnAnswer(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gdharness-update-home-'));
  // The empty string is how a fixture asks for the check that every other server here has turned
  // off: this is the one fixture that is about the notice, so it opts back in explicitly.
  const environment = {
    HOME: home,
    LOCALAPPDATA: home,
    XDG_CACHE_HOME: home,
    GDHARNESS_NO_UPDATE_CHECK: '',
    GDHARNESS_REGISTRY: 'https://127.0.0.1:1',
  };
  try {
    writeFileSync(
      cacheFile(environment),
      JSON.stringify({ checkedAt: Date.now(), latest: '99.9.9' }),
      'utf8',
    );
    await withStdioServer(async (_call, request) => {
      const carrying = await request('tools/call', { name: 'editor_status', arguments: {} });
      const first = textOf(carrying) ?? '';
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

      // A notice is a block of its own, so the answer it rides on has to still read as the
      // answer. Anything that takes the blocks as one document gets two JSON documents end to
      // end and reads a tool that answered perfectly well as one that answered nothing.
      const answer = parseTextContent(carrying);
      assert.ok(
        isRecord(answer) && isRecord(answer['editor']) && isRecord(answer['godot']),
        `the answer under the notice should still be readable: ${first}`,
      );

      // The second answer is read as an answer before it is read for the absence of the notice.
      // "Does not mention update_available" is true of a crash and of a refusal, so on its own it
      // would pass against a server that had stopped answering editor_status at all.
      const again = await request('tools/call', { name: 'editor_status', arguments: {} });
      const second = textOf(again) ?? '';
      const payload = parseTextContent(again);
      assert.ok(
        isRecord(payload) && isRecord(payload['editor']) && isRecord(payload['godot']),
        `the second answer should still be an editor_status answer: ${second}`,
      );
      assert.doesNotMatch(second, /update_available/, 'and it should not repeat the notice');
    }, environment);
  } finally {
    sweep(home);
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
    await withStdioServer(async (_call, request) => {
      // Read as an answer first. A server that refused editor_status outright would carry no
      // notice either, and this fixture is about a switch, not about the tool going quiet.
      const answered = await request('tools/call', { name: 'editor_status', arguments: {} });
      const said = textOf(answered) ?? '';
      const payload = parseTextContent(answered);
      assert.ok(
        isRecord(payload) && isRecord(payload['editor']) && isRecord(payload['godot']),
        `editor_status should still answer with the switch on: ${said}`,
      );
      assert.doesNotMatch(
        said,
        /update_available/,
        'GDHARNESS_NO_UPDATE_CHECK should stop the notice as well as the request',
      );
    }, environment);
  } finally {
    sweep(home);
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
  // The two ports are named on it because Godot keeps one language server and one debug adapter
  // per machine rather than per editor, and the second editor open otherwise binds neither.
  assert.deepEqual(editorArguments('/p', { lsp: 6005, dap: 6006 }), [
    '-e',
    '--path',
    '/p',
    '--lsp-port',
    '6005',
    '--dap-port',
    '6006',
  ]);
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
  // The game's own arguments go behind a bare `--`, which is where the engine stops reading them
  // as its own and OS.get_cmdline_user_args() starts. Without the separator every one of them is
  // an option the engine has never heard of, and the game is handed nothing.
  assert.deepEqual(
    runArguments({ projectPath: '/p', headless: true, scene: null, userArgs: ['--screen=hall'] }),
    ['--headless', '--path', '/p', '--', '--screen=hall'],
  );
  // And no separator at all when there are none: a bare `--` is itself something a game can see,
  // so a run nobody gave arguments to should look exactly like one from before there were any.
  assert.deepEqual(runArguments({ projectPath: '/p', headless: false, scene: null, userArgs: [] }), [
    '--path',
    '/p',
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
    sweep(projectDir);
  }
}

/**
 * A headless run that quits on its own still has its output read back.
 *
 * That is the ordinary shape of a headless run, not an edge case: a bench, a report, a one-shot
 * tool scene all print an answer and call quit. editor_run dropped its reference to the process
 * the moment it exited, so the log went with it and editor_output answered "No game is running"
 * about a run that had just finished printing. Everything needed was already there: spawnGame
 * keeps the log and records exitCode, and editor_output reports `running: false` off it.
 */
async function testAFinishedRunCanStillBeRead(): Promise<void> {
  const godotPath = resolveGodotPath();
  if (!godotPath) {
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and GODOT_PATH names no existing file.');
    }
    console.log('finished-run output regression skipped (Godot not found)');
    return;
  }

  const projectDir = mkdtempSync(join(tmpdir(), 'gdharness-finished-run-'));
  try {
    writeFileSync(
      join(projectDir, 'project.godot'),
      '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="FinishedRun"\nrun/main_scene="res://main.tscn"\n',
    );
    writeFileSync(
      join(projectDir, 'main.gd'),
      'extends Node\n\n\nfunc _ready() -> void:\n\tprint("the answer is 42")\n\tget_tree().quit()\n',
    );
    writeFileSync(
      join(projectDir, 'main.tscn'),
      '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n[node name="Main" type="Node"]\nscript = ExtResource("1")\n',
    );

    await withStdioServer(
      async (call) => {
        const started: unknown = JSON.parse(
          await call(
            'editor_run',
            { projectPath: projectDir, op: 'start', headless: true },
            ENGINE_CALL_TIMEOUT_MS,
          ),
        );
        assert.equal(get(started, 'started'), true, JSON.stringify(started));

        // It quits itself, so there is nothing to stop and nothing to wait on but the exit.
        let output: unknown = null;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          await delay(200);
          const answered = await call('editor_output', { limit: 200 }, ENGINE_CALL_TIMEOUT_MS);
          assert.doesNotMatch(
            answered,
            /No game is running/,
            'a finished run is still the run editor_output answers about',
          );
          output = JSON.parse(answered);
          if (get(output, 'running') === false) {
            break;
          }
        }

        assert.equal(
          get(output, 'running'),
          false,
          `it should report as finished: ${JSON.stringify(output)}`,
        );
        assert.equal(get(output, 'exitCode'), 0, JSON.stringify(output));
        const printed = asArray(get(output, 'entries')).map((entry) => text(get(entry, 'text')));
        assert.ok(
          printed.some((line) => line.includes('the answer is 42')),
          `what it printed before quitting survives:\n${JSON.stringify(output, null, 2)}`,
        );

        // And a readable log is not a debug session. The refusal names which of the two states it
        // is in, because "nothing ran" and "it finished" are answered by different things.
        const refused = await call('debug_state', { op: 'stack' });
        assert.match(
          refused,
          /already finished \(exit code 0\)/,
          'a finished run is not something the debugger can answer for',
        );
        assert.match(refused, /editor_output still reads what it printed/, refused);

        // editor_status agrees it is not active, so "is something running" stays a real question.
        const status: unknown = JSON.parse(await call('editor_status', {}, ENGINE_CALL_TIMEOUT_MS));
        assert.equal(get(status, 'game', 'processActive'), false, JSON.stringify(status));

        // And who ended it, which is the question a bench that stopped mid-measurement asks. This
        // one quit on its own, and the answer says so rather than leaving the two silences to be
        // told apart by guesswork: a run gdharness ended looks exactly like one that died.
        assert.equal(get(output, 'endedBy'), null, `nothing ended it: ${JSON.stringify(output)}`);
        // A clean exit is not one of the two silences, so the note says that rather than leaving
        // the question open: this scene printed its answer and quit, which is what exit code 0
        // means and what reading it as an incident got wrong on every finish.
        assert.match(
          text(get(output, 'note')),
          /quit on its own, cleanly: exit code 0/,
          `and the note says so: ${JSON.stringify(output)}`,
        );

        // The start names the file it is writing, so a watch can be armed off the start. Learning
        // it from a second call is where a name gets reconstructed from the clock instead, and a
        // tail on a path that does not exist reports nothing, which reads exactly like a run that
        // has not printed yet. Both calls naming the same file is the part that matters: two
        // answers about where the output is would be the same guess wearing a different hat.
        const named = text(get(started, 'transcript'));
        assert.equal(named, text(get(output, 'transcript')), JSON.stringify(started));
        assert.ok(
          readFileSync(named, 'utf8').includes('the answer is 42'),
          `and the file it named holds what the run printed: ${named}`,
        );
      },
      { GODOT_PATH: godotPath },
    );
  } finally {
    sweep(projectDir);
  }
}

/**
 * Which autoload entries this tool may rewrite, which is only the one it wrote.
 *
 * Covered without an engine as well as through the CLI, because the engine-backed test is skipped
 * on any machine without Godot and this is the rule that decides whether a socket reaches a
 * shipped build. Nothing else in a project can see the difference: the wrapper stays on disk and
 * correct, and a suite that exercises the script rather than reading project.godot passes either
 * way.
 */
function testOnlyOurOwnAutoloadIsRewritten(): void {
  assert.equal(autoloadIsOurs('res://addons/gdharness_runtime/runtime_autoload.gd'), true);
  assert.equal(autoloadIsOurs(null), true, 'nothing registered is ours to register');
  assert.equal(
    autoloadIsOurs('res://boot/gdharness_loader.gd'),
    false,
    'a project that brings the runtime up its own way owns that line',
  );
  assert.equal(
    autoloadIsOurs('res://addons/gdharness_runtime/runtime_autoload.gd.uid'),
    false,
    'and a path that merely starts the same is not the same path',
  );
}

/**
 * The restart reports the settings its editor dropped, end to end.
 *
 * The diff itself is asserted beside this, over two readings of a file. What that cannot reach is
 * whether the answer carries it, and the tier that drives a real editor cannot reach it either: an
 * editor with no window refuses to restart, because the engine hands back none of the arguments it
 * consumed, and the tier's editor is headless. That refusal is the addon's, so a fixture editor
 * that answers `restart_editor` goes straight past it and through the whole handler.
 *
 * A restart is modelled the way one happens: the editor answers, goes, and a newer connection
 * arrives. `project.godot` loses a line in between, which is what Godot does to a key named at its
 * own default value.
 */
/**
 * An open and a restart say the same thing about what the editor saved away.
 *
 * Only the restart did. Godot drops a key sitting at its own default whenever it saves, which it
 * does on an open just as much as on the way out, and `editor_launch open` answered with `launched`,
 * a pid and two ports and nothing else. Reported downstream as a sixth strip of the same key and the
 * first from an open.
 *
 * The comparison is one function for both now. What differs is when each call can make it: a
 * restart waits for the editor to come back and says so in its own answer, while an open returns as
 * soon as the process exists and the save happens during the import, so `editor_status` makes the
 * reading once there is an editor to have done the saving.
 */
function testWhatTheEditorSavedAwayIsReportedTheSameWay(): void {
  const before = new Map<string, unknown>([
    ['debug/gdscript/warnings/return_value_discarded', 0],
    ['debug/gdscript/warnings/unsafe_call_argument', 2],
    ['application/config/name', 'Kept'],
  ]);
  const after = new Map<string, unknown>([
    ['debug/gdscript/warnings/unsafe_call_argument', 2],
    ['application/config/name', 'Kept'],
  ]);

  const said = settingsDroppedReport(before, after);
  assert.deepEqual(
    said.settingsDropped,
    [{ setting: 'debug/gdscript/warnings/return_value_discarded', was: 0 }],
    'the key that went is named, with the value it held',
  );
  assert.match(text(said.settingsNote), /project_settings set puts one back/, 'and the call to undo it');
  assert.match(
    text(said.settingsNote),
    /writes only what differs from its own defaults/,
    'with the mechanism, since the key going is not the editor misbehaving',
  );
  assert.match(
    text(said.settingsNote),
    /value 0/,
    'and the value inside the sentence, not only in the list beside it',
  );

  // Nothing dropped says nothing, rather than an empty list a caller has to test for. The positive
  // above is what shows this is the same function answering and not one that never reports.
  assert.deepEqual(settingsDroppedReport(after, after), {}, 'a save that took nothing says nothing');
  assert.deepEqual(
    settingsDroppedReport(new Map(), after),
    {},
    'and a project that named nothing cannot have lost anything',
  );

  // The third answer, which used to be the second. A file that could not be read arrived here as a
  // map naming nothing, and a comparison against nothing finds nothing missing, so the caller was
  // told their settings survived a save on the strength of a reading that never happened. That is
  // the worst place for it: this report is the only thing that ever names a key Godot drops, and its
  // own sentence says nothing else will say it has gone until something depends on one.
  for (const [what, gap] of [
    ['before', settingsDroppedReport(null, after)],
    ['after', settingsDroppedReport(before, null)],
  ] as const) {
    assert.equal(
      gap.settingsDropped,
      undefined,
      `nothing is claimed to have gone when the ${what} reading failed`,
    );
    assert.match(
      text(gap.settingsNote),
      /could not be read/,
      `and the answer says the comparison did not happen: ${text(gap.settingsNote)}`,
    );
    assert.match(
      text(gap.settingsNote),
      new RegExp(`could not be read ${what} this`),
      `naming which end could not be read, since that is what a caller would go and look at`,
    );
    assert.doesNotMatch(
      text(gap.settingsNote),
      /project_settings set puts one back/,
      'and does not offer the remedy for a key it cannot name',
    );
  }
}

async function testARestartSaysWhatTheEditorDropped(): Promise<void> {
  const port = await reservePort();
  const server = new ServerProcess({ env: { GDHARNESS_BRIDGE_PORT: String(port) } });
  const project = mkdtempSync(join(realpathSync(tmpdir()), 'gdharness-restarting-'));
  let editor: WebSocket | null = null;
  let second: WebSocket | null = null;
  try {
    const settings = join(project, 'project.godot');
    writeFileSync(
      settings,
      'config_version=5\n\n[debug]\n\ngdscript/warnings/return_value_discarded=0\ngdscript/warnings/unsafe_call_argument=2\n',
    );

    await server.initialize('regression-test');
    const greet = async (socket: WebSocket): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => {
          resolve();
        });
        socket.once('error', reject);
      });
      socket.on('message', (raw: Buffer) => {
        const message: unknown = JSON.parse(String(raw));
        if (!isRecord(message) || message['type'] !== 'tool_invoke') {
          return;
        }
        socket.send(
          JSON.stringify({ type: 'tool_result', id: message['id'], success: true, result: { ok: true } }),
        );
      });
      socket.send(
        JSON.stringify({
          type: 'godot_ready',
          project_path: project,
          addon_version: SERVER_VERSION,
          editor_pid: process.pid,
        }),
      );
    };

    editor = new WebSocket(`ws://127.0.0.1:${port}/godot`);
    await greet(editor);
    let knows = false;
    for (let waited = 0; waited < 10_000 && !knows; waited += 100) {
      await delay(100);
      const status = await server.request('tools/call', { name: 'editor_status', arguments: {} });
      knows = text(get(parseTextContent(status), 'editor', 'projectPath')) === project;
    }
    assert.ok(knows, 'the fixture editor should have reached the server, or this proves nothing');

    // The restart itself: the file loses the key that was at its default, the editor goes, and a
    // newer connection takes its place. Sequenced off the call rather than raced against it.
    const restarting = server.request(
      'tools/call',
      { name: 'editor_launch', arguments: { op: 'restart' } },
      60_000,
    );
    await delay(500);
    writeFileSync(settings, 'config_version=5\n\n[debug]\n\ngdscript/warnings/unsafe_call_argument=2\n');
    editor.close();
    await delay(1100);
    second = new WebSocket(`ws://127.0.0.1:${port}/godot`);
    await greet(second);

    const answer = parseTextContent(await restarting);
    const said = JSON.stringify(answer);
    assert.equal(get(answer, 'restarted'), true, said);
    const gone = asArray(get(answer, 'settingsDropped') ?? []);
    assert.equal(gone.length, 1, `the key the save took out is named: ${said}`);
    assert.equal(get(gone[0], 'setting'), 'debug/gdscript/warnings/return_value_discarded', said);
    // The value with it, because the line it was on is not in the file any more: a caller told only
    // the name has to go and find what it held somewhere that no longer holds it.
    assert.equal(get(gone[0], 'was'), 0, `with the value it held: ${said}`);
    assert.match(
      text(get(answer, 'settingsNote')),
      /project_settings set puts one back/,
      `and the call that puts it back: ${said}`,
    );
    assert.match(
      text(get(answer, 'settingsNote')),
      /writes only what differs from its own defaults/,
      `with the mechanism, since the key going is not the editor misbehaving: ${said}`,
    );
  } finally {
    editor?.terminate();
    second?.terminate();
    await server.stop();
    sweep(project);
  }
}

/**
 * A diagnostic the file contradicts is read out of the message and checked, rather than passed on.
 *
 * Adding a method to an existing `class_name` leaves the language server handing dependents the
 * type it analysed at startup, so every caller is told the method is not present on the inferred
 * type while `script_info symbols` lists it from that same server at the same moment. Three files
 * reported it, against a method that compiles, and the answer said nothing to separate it from a
 * real finding. What makes that expensive is not the wrong answer: it is that getting past it means
 * deciding the tool is wrong, and that decision is cheaper the second time.
 *
 * Both halves are asserted because the reporting is only worth having if it is right in both
 * directions. Naming a genuine finding as contradicted is worse than silence, so the method that is
 * absent has to come back absent from the same reading that finds the one that is present.
 */
function testADiagnosticTheFileContradictsIsNamed(): void {
  const present = missingMemberIn(
    'The method "is_finished()" is not present on the inferred type "Game" (but may be present on a subtype).',
  );
  assert.deepEqual(
    present,
    { kind: 'method', member: 'is_finished', type: 'Game' },
    'the member and the type are what the check needs, and they are only in the text',
  );
  assert.deepEqual(missingMemberIn('The property "score" is not present on the inferred type "Game".'), {
    kind: 'property',
    member: 'score',
    type: 'Game',
  });
  // Every other diagnostic goes through untouched, including the one that names a method and is
  // about something else entirely.
  assert.equal(missingMemberIn('The identifier "foo" is not declared in the current scope.'), null);
  assert.equal(missingMemberIn('Function "is_finished()" has no return value.'), null);

  const game = [
    'class_name Game',
    'extends Node',
    '',
    'const ROUNDS := 3',
    'var score := 0',
    '',
    '',
    'static func make() -> Game:',
    '\treturn Game.new()',
    '',
    '',
    'func is_finished() -> bool:',
    '\treturn score >= ROUNDS',
    '',
    '',
    'func _unfinished_helper() -> void:',
    '\tpass',
  ].join('\n');

  assert.equal(declaresMember(game, present), true, 'the method is there, so the diagnostic is wrong');
  assert.equal(declaresMember(game, { kind: 'method', member: 'make', type: 'Game' }), true, 'static too');
  assert.equal(declaresMember(game, { kind: 'property', member: 'score', type: 'Game' }), true, 'var too');
  assert.equal(declaresMember(game, { kind: 'property', member: 'ROUNDS', type: 'Game' }), true, 'const too');

  // The direction that must not be got wrong: a member the file does not declare stays unclaimed,
  // because calling a real finding stale is worse than saying nothing about it.
  assert.equal(
    declaresMember(game, { kind: 'method', member: 'is_started', type: 'Game' }),
    false,
    'a method that is genuinely absent is not reported as contradicted by the file',
  );
  // And a name that merely occurs in the file is not a declaration of it. `is_finished` appears in
  // the call inside the body above; `ROUNDS` appears there too.
  assert.equal(
    declaresMember('func other() -> void:\n\tis_finished()\n', present),
    false,
    'a call to the method in a body is not a declaration of it',
  );
  assert.equal(
    declaresMember(game, { kind: 'method', member: 'new', type: 'Game' }),
    false,
    'Game.new() in a body is a call, not a declaration',
  );

  // The whole decision, which is otherwise only reachable through a running editor: the cache
  // lookup, the one read per script however many diagnostics name it, and the three ways a message
  // is passed over rather than claimed.
  const classes = new Map([
    ['Game', 'res://scripts/game.gd'],
    ['Unreadable', 'res://scripts/gone.gd'],
  ]);
  const asked: string[] = [];
  const sourceOf = (path: string): string | null => {
    asked.push(path);
    return path === 'res://scripts/game.gd' ? game : null;
  };
  const contradicted = contradictedDiagnostics(
    [
      'The method "is_finished()" is not present on the inferred type "Game" (but may be present on a subtype).',
      'The property "score" is not present on the inferred type "Game".',
      'The method "is_started()" is not present on the inferred type "Game".',
      'The method "anything()" is not present on the inferred type "Unreadable".',
      'The method "whatever()" is not present on the inferred type "NotInTheCache".',
      'The identifier "foo" is not declared in the current scope.',
    ],
    classes,
    sourceOf,
  );

  assert.deepEqual(
    contradicted,
    [
      { kind: 'method', member: 'is_finished', type: 'Game', declaredIn: 'res://scripts/game.gd' },
      { kind: 'property', member: 'score', type: 'Game', declaredIn: 'res://scripts/game.gd' },
    ],
    'only the two the file disproves, each naming the script that disproves it',
  );
  assert.deepEqual(
    asked,
    ['res://scripts/game.gd', 'res://scripts/gone.gd'],
    'each script is read once however many diagnostics name it, and one outside the cache is not looked for',
  );
}

/**
 * The sentence about which calls need a projectPath is generated, and names every call that does
 * not take one: a tool that declares none, and an op whose tool's `projectPath` belongs to other
 * ops.
 *
 * Both the skill and the tool reference open with it, and both said it in prose naming the
 * `runtime_*` and `debug_*` families. `editor_status` takes no arguments at all and `editor_output`
 * takes its own, and an argument a tool does not declare is refused rather than ignored, so a
 * session following that sentence failed on what is often its first call. Generated by tool, it
 * named four and stood beside per-op lines that refused what it promised: `editor_run stop` and
 * `wait` and `editor_launch restart` take none, and a session following the sentence was refused
 * twice in an hour with "stop takes: andChildren". A call is an op, so the list is by op.
 *
 * Held against the schemas rather than reread by eye, because the sentence was true when written
 * and stopped being true when a tool was added. Rewriting it by hand would buy the same sentence
 * wrong again on the next one. The list is compared whole against a walk of every op's declared
 * arguments, so an op that stops taking the argument, or starts, moves the sentence with it.
 */
function testTheProjectPathSentenceNamesEveryCallThatTakesNone(): void {
  const without = callsWithoutProjectPath();
  assert.ok(
    without.includes('editor_status') && without.includes('editor_output'),
    `the two that started this should be in the list: ${without.join(', ')}`,
  );
  assert.ok(
    without.includes('editor_run stop') &&
      without.includes('editor_run wait') &&
      without.includes('editor_launch restart'),
    `and the ops of a tool that takes one elsewhere: ${without.join(', ')}`,
  );
  // The whole set, walked from every op's own arguments rather than from the function under test:
  // a call takes projectPath when its op does, and a tool without ops when the tool does.
  const walked: string[] = [];
  for (const spec of TOOL_SPECS) {
    const ops = Object.keys(spec.operations ?? {});
    if (ops.length === 0) {
      if (!argumentsOf(spec, '').includes('projectPath')) walked.push(spec.name);
      continue;
    }
    for (const op of ops) {
      if (!argumentsOf(spec, op).includes('projectPath')) {
        walked.push(Object.hasOwn(spec.parameters, 'projectPath') ? `${spec.name} ${op}` : spec.name);
      }
    }
  }
  assert.deepEqual(
    without,
    [...new Set(walked)].sort(),
    'the sentence names exactly the calls whose op takes none',
  );
  // Every one of them genuinely refuses the argument, which is what makes the sentence matter. A
  // call that merely ignored it would leave the old wording harmless.
  for (const call of without) {
    const [name, op] = call.split(' ');
    const spec = toolSpec(name ?? '');
    assert.ok(spec, `${name} should be a tool`);
    if (op === undefined) {
      assert.equal(
        Object.hasOwn(spec.parameters, 'projectPath'),
        false,
        `${name} is listed as taking no projectPath and declares one`,
      );
    } else {
      assert.equal(
        opTakes(spec, op, 'projectPath'),
        false,
        `${call} is listed as taking no projectPath and its op reads one`,
      );
    }
  }

  const shared = projectPathSentence();
  for (const [what, text] of [
    ['the tool reference', renderToolsMarkdown()],
    ['the skill', skillFiles('0.0.0').get('SKILL.md') ?? ''],
  ] as const) {
    const sentence = text.split('\n').find((line) => line.includes('Every call takes'));
    assert.ok(sentence, `${what} should still open by saying which calls need a projectPath`);
    // The clause verbatim, not the names in it. Two renderings building the same sentence is the
    // arrangement that let one of them escape every backtick while the other did not, and a check
    // reading the names out of each reads through exactly the part that differed.
    assert.ok(sentence.includes(shared), `${what} should carry the generated clause unaltered: ${sentence}`);
    for (const name of without) {
      assert.ok(
        sentence.includes(`\`${name}\``),
        `${what} should name ${name} as a code span among the calls that take none: ${sentence}`,
      );
    }
  }
  assert.match(shared, /which take none$/, 'four of them read as plural');
  // The branches the surface does not currently produce. At none the list-joining version said
  // "except , which take none", which would ship in the skill every agent reads.
  assert.equal(
    projectPathSentence([]),
    'Every call takes `projectPath`',
    'with nothing to except, the sentence is the rule on its own',
  );
  assert.match(
    projectPathSentence(['editor_status']),
    /except `editor_status`, which takes none$/,
    'and one of them reads as one',
  );
}

/**
 * Every argument in the reference says what it is for.
 *
 * Ten did not, and the renderer put the colon after the name rather than in front of the
 * description, so each came out as a line ending in a colon: `signalName` (string): and nothing
 * after it, in the published page and in the skill an agent reads before its first call. An
 * argument with no description is a gap whichever way it renders, and the reference is generated,
 * so the only place to close it is the schema.
 *
 * Both halves are held. The count is not a floor because it is zero, which is the one count that
 * does not need raising when something is added.
 */
function testEveryArgumentInTheReferenceIsDescribed(): void {
  const undescribed: string[] = [];
  for (const tool of TOOL_SPECS) {
    for (const [name, schema] of Object.entries(tool.parameters)) {
      if (typeof schema['description'] !== 'string' || schema['description'].trim() === '') {
        undescribed.push(`${tool.name}.${name}`);
      }
    }
  }
  assert.deepEqual(undescribed, [], 'every argument should say what it is for');

  const markdown = renderToolsMarkdown();
  const dangling = markdown.split('\n').filter((line) => /^- `[^`]+` \([^)]+\):\s*$/.test(line));
  assert.deepEqual(dangling, [], 'and no argument line should end on a colon with nothing after it');
  // The positive: the list is rendered at all, and rendered with the descriptions attached rather
  // than merely without empty ones. A reference with no argument lines passes both checks above.
  const described = markdown.split('\n').filter((line) => /^- `[^`]+` \([^)]+\): \S/.test(line));
  assert.ok(
    described.length > 100,
    `the reference should be full of described arguments: ${described.length}`,
  );
}

/**
 * Every arm of the type the reference prints, including the one two arguments reach.
 *
 * `namedType` has three: a plain type, a union written as a list, and a fallback for an argument
 * that declares no type at all because it takes any JSON value. 190 arguments reach the first, three
 * reach the third, and two reach the second. Two of a hundred and ninety-five is the arm that reads
 * as covered because the others plainly are, and losing it would print `(any)` where the schema says
 * `string or number`, which is a reference entry that is wrong rather than missing.
 *
 * The two are named rather than counted. A count would also have to move when a third union is
 * added, and what wants confirming is a union going away, not one arriving.
 */
function testTheReferencePrintsEveryShapeOfType(): void {
  assert.equal(namedType('string'), 'string', 'a plain type is itself');
  assert.equal(namedType(['string', 'number']), 'string or number', 'a union reads as one');
  assert.equal(namedType(undefined), 'any', 'and an argument with no declared type takes any value');
  assert.equal(namedType({ oneOf: [] }), 'any', 'as does a shape this does not read');
  assert.equal(namedType(['string', 7]), 'any', 'a list that is not all names is not a union');

  const markdown = renderToolsMarkdown();
  for (const name of ['keycode', 'button']) {
    const line = markdown.split('\n').find((entry) => entry.startsWith(`- \`${name}\` `));
    assert.ok(line, `${name} should be in the reference`);
    assert.match(line, /\(string or number\)/, `${name} should print both types it takes: ${line}`);
  }
  // The positive for the fallback, so that an arm printing `any` for everything would be caught by
  // the lines above rather than satisfying this one too.
  const anyLines = markdown.split('\n').filter((line) => line.includes('` (any):'));
  assert.equal(anyLines.length, 3, `three arguments take any value: ${anyLines.join(' | ')}`);
}

/**
 * The skill says a script run can be served, and names the setting the addon actually reads.
 *
 * It said a `godot -s` script run does not answer, full stop. That is the default and not the rule:
 * the autoload stands down in a script run unless `serve_script_runs` is set, which is there for
 * somebody driving a `-s` script on purpose. The setting was in `docs/` and in neither the skill nor
 * any tool description, so the one sentence an agent reads before its first call was the half that
 * is wrong, and a downstream project had copied it into its own documentation as unconditional.
 * That is the half a consumer builds a guard on.
 *
 * Held against the addon's own constant rather than spelled twice. A rename in the GDScript would
 * otherwise leave the skill naming a setting nothing reads, which is worse than not naming one:
 * a caller sets it, nothing happens, and the sentence says it should have.
 */
function testTheSkillNamesEverySettingTheAddonsRead(): void {
  const read = new Set<string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith('.gd')) {
        for (const found of readFileSync(path, 'utf8').matchAll(/"(gdharness\/[a-z_/]+)"/g)) {
          read.add(found[1] ?? '');
        }
      }
    }
  };
  walk('src/godot/addons');

  // The list comes from the addons rather than from here, so a setting added there is covered by
  // this the day it lands and nobody has to remember. Two were read and written down nowhere a
  // caller looks, one of them the bind address, which is the only one with a security answer.
  assert.ok(read.size >= 3, `the addons should read the settings they document: ${[...read].join(', ')}`);
  const skill = skillFiles('0.0.0').get('SKILL.md') ?? '';
  const unsaid = [...read].filter((setting) => !skill.includes(setting)).sort();
  assert.deepEqual(unsaid, [], 'every setting the addons read should be named in the skill');

  // The bind address with its reason rather than only its name. A caller who reads that it exists
  // and not why it is loopback is one who moves it to reach a game on another machine.
  assert.match(skill, /none of it authenticated/, 'and the bind address should say what it guards');
}

function testTheSkillNamesTheSettingThatServesAScriptRun(): void {
  const addon = readFileSync('src/godot/addons/gdharness_runtime/runtime_autoload.gd', 'utf8');
  const declared = /SCRIPT_RUNS_SETTING\s*:\s*String\s*=\s*"([^"]+)"/.exec(addon)?.[1];
  assert.ok(declared, 'the addon should declare the setting it reads');
  assert.equal(SCRIPT_RUNS_SETTING, declared, 'and the skill should name that one rather than a copy');
  // The addon reads it where it decides, not merely declares it. A constant nothing consults would
  // satisfy the line above while the sentence describes a setting with no effect.
  assert.match(
    addon,
    /_script_run\(\)\s*and\s*not\s*Read\.as_bool\(ProjectSettings\.get_setting\(SCRIPT_RUNS_SETTING/,
    'and the script-run refusal should be the thing that consults it',
  );

  const skill = skillFiles('0.0.0').get('SKILL.md') ?? '';
  const sentence = skill.split('\n\n').find((block) => block.includes('`godot -s` script run'));
  assert.ok(sentence, 'the skill should still say what a script run does');
  assert.match(sentence, /by default/, 'as a default rather than as a property of script runs');
  assert.ok(sentence.includes(SCRIPT_RUNS_SETTING), `and name the setting that changes it: ${sentence}`);
}

/**
 * Nothing the skill writes escapes a backtick.
 *
 * A generated name went into `SKILL.md` as `\`debug_control\``, rendering the backslashes rather
 * than a code span, while the same generated sentence in `references/tools.md` was clean. The cause
 * is that a `${}` substitution is ordinary JavaScript and owes the template around it no escaping,
 * so a nested template that escapes as if it did emits the backslash it meant to hide.
 *
 * Held over every file rather than that one line, and as an absence with nothing in it to list, so
 * a substitution added later is covered without anybody remembering this.
 */
function testTheSkillWritesNoEscapedBackticks(): void {
  const written = skillFiles('0.0.0');
  assert.ok(written.size >= 2, `the skill should write the page and its reference: ${written.size}`);
  for (const [name, contents] of written) {
    const offending = contents.split('\n').filter((line) => line.includes('\\`'));
    assert.deepEqual(offending, [], `${name} renders backslashes where it means code spans`);
    // The positive half, on the line that broke rather than as a count: a pair of files with no
    // backticks in them at all satisfies the absence above exactly as well as a pair that renders
    // every one of them, and a count over the whole reference moves whenever a tool does.
    const sentence = contents.split('\n').find((line) => line.includes('Every call takes'));
    assert.ok(sentence, `${name} should carry the generated sentence`);
    assert.match(sentence, /`projectPath`/, `${name} should render its code spans as code spans`);
  }
}

/**
 * What a stale type depends on, which is the lever rather than a detail.
 *
 * Measured against a real editor by the project that reproduces the fault: a held copy of a type is
 * refreshed when one of its own dependencies changes, and not when it changes itself. With a
 * dependent stuck on a new method through four rescans, adding a method to a third class the stale
 * type holds cleared it on the next rescan. So the useful thing to hand a caller is the list of
 * files worth touching, and nothing in the engine will say what they are.
 *
 * Read by name against the class list rather than by parsing GDScript. A name in a comment or a
 * string can match, which costs one wasted touch on a file that was already fine; missing one costs
 * a restart, so the loose direction is the cheap one and is chosen deliberately.
 */
function testWhatAStaleTypeDependsOnIsNamed(): void {
  const known = new Map([
    ['Clapper', 'res://clapper.gd'],
    ['Rope', 'res://rope.gd'],
    ['Bell', 'res://bell.gd'],
  ]);
  const bell = [
    'class_name Bell',
    'extends Node',
    '',
    'var clapper: Clapper = Clapper.new()',
    'var rope := Rope.new()',
    '',
    '',
    'func toll() -> int:',
    '\treturn clapper.weight()',
    '',
  ].join('\n');

  assert.deepEqual(
    classesNamedIn(bell, known),
    ['Bell', 'Clapper', 'Rope'],
    'every global class the file names, including its own, which the caller filters',
  );
  assert.deepEqual(
    classesNamedIn('extends Node\n\nvar n: int = 0\n', known),
    [],
    'a script naming no global class has no lever, which is the case that must not invent one',
  );
  // Node, RefCounted and the rest are engine types and not in the project's list, so they are not
  // offered as something to touch. Only a file somebody could edit is worth naming.
  assert.deepEqual(
    classesNamedIn('extends Node\n\nvar timer: Timer = Timer.new()\n', known),
    [],
    'an engine type is not a file in this project and is not a lever',
  );
}

/**
 * A class the editor still holds after its script is gone, which is the dangerous direction.
 *
 * Deleting a script with a `class_name` and rebuilding rewrites the cache without it and reports it
 * `removed`, which is true of the file for exactly as long as the editor leaves it alone. The editor
 * has not noticed, writes its own list back over the cache, and the entry returns pointing at a
 * script that is gone: the next engine to walk `get_global_class_list()` dies on "File not found" in
 * a project nobody has touched since. That is a red suite on a change that could not have caused it.
 *
 * A rescan does not clear this one. It picks up a class that has appeared and does not drop one that
 * has gone, so the two directions of the same fault need different answers and only one was given.
 *
 * Both directions are asserted here because each is the other's control: a project where both are
 * empty would satisfy a one-sided test of whichever happened to be empty.
 */
function testAClassTheEditorHoldsAfterItsScriptIsGoneIsNamed(): void {
  const project = mkdtempSync(join(tmpdir(), 'gdharness-held-'));
  try {
    writeFileSync(join(project, 'kept.gd'), 'class_name Kept\nextends Node\n');
    writeFileSync(join(project, 'plain.gd'), 'extends Node\n');
    // Annotations share the line with what they annotate. `@abstract class_name X` is one line in
    // Godot 4.5 and later, and a scanner anchored on `class_name` alone reads it as no declaration
    // at all: a project with gdUnit4 in it had 23 abstract classes reported as declared nowhere,
    // with the answer telling the caller to restart the editor to drop them, and every one was on
    // disk. The engine-side scanner strips annotations first, which is why the cache itself was
    // never short of them and only the report was wrong.
    writeFileSync(join(project, 'assert.gd'), '@abstract class_name GdUnitAssert\nextends RefCounted\n');
    writeFileSync(join(project, 'stage.gd'), '@tool @abstract class_name IGdUnitExecutionStage\n');
    writeFileSync(join(project, 'iconed.gd'), '@icon("res://icon.svg") class_name Iconed\nextends Node\n');
    writeFileSync(join(project, 'own_line.gd'), '@abstract\nclass_name OnItsOwnLine\nextends Node\n');

    const annotated = ['GdUnitAssert', 'IGdUnitExecutionStage', 'Iconed', 'OnItsOwnLine'];
    assert.deepEqual(
      heldButGone(project, ['Kept', ...annotated]),
      [],
      'an annotated declaration is a declaration, and none of these is gone',
    );
    assert.deepEqual(
      heldButGone(project, ['Kept', 'Gone']),
      ['Gone'],
      'the one with no declaration left is the one the editor will write back over the cache',
    );
    assert.deepEqual(
      heldButGone(project, ['Kept']),
      [],
      'and an editor holding exactly what is declared has nothing to report',
    );
    assert.deepEqual(
      heldButGone(project, ['Gone', 'AlsoGone', 'Kept']),
      ['AlsoGone', 'Gone'],
      'several are named, sorted, so the note reads the same whatever order the editor listed them',
    );

    assert.deepEqual(
      unseenByEditor(project, ['Gone']).map((one) => one.className),
      ['GdUnitAssert', 'IGdUnitExecutionStage', 'Iconed', 'Kept', 'OnItsOwnLine'],
      'the editor missing a declared class is still the other answer, and still separate from this one',
    );
  } finally {
    sweep(project);
  }
}

/**
 * A class the editor cannot resolve is separated from one the cache has not got, because the
 * remedies differ.
 *
 * The same staleness reaches a caller in a second shape that mentions no inferred type at all: two
 * brand new `class_name`s came back as "Could not find base class" and "not declared in the current
 * scope", so the check that reads an inferred type out of a message finds nothing in them. Whether
 * the project declares the class is what makes those diagnostics wrong, and whether the class cache
 * lists it is what decides the answer: a launched game reads that cache, which is why the game ran
 * and resolved both classes while the editor's diagnostics denied they existed.
 *
 * Asserted as the two groups rather than one list, since telling a caller only "it is declared"
 * leaves them to work out which of `refresh_classes` and a restart they need, which is the ten
 * minutes this is meant to remove.
 */
function testAClassTheEditorHasNotLoadedIsToldApartFromOneTheCacheLacks(): void {
  for (const message of [
    'Could not find base class "EndingLine".',
    'Identifier "EndingLines" not declared in the current scope.',
    'Could not find type "Game" in the current scope.',
    'Cannot find class "Game"',
  ]) {
    assert.ok(unknownTypeIn(message) !== null, `${message} names a type this can check`);
  }
  assert.equal(unknownTypeIn('Could not find base class "EndingLine".'), 'EndingLine');
  assert.equal(unknownTypeIn('Identifier "EndingLines" not declared in the current scope.'), 'EndingLines');
  assert.equal(
    unknownTypeIn('The method "is_finished()" is not present on the inferred type "Game".'),
    null,
    'the member shape is the other check, and reading it here would answer it twice',
  );

  const declared = new Map([
    ['EndingLine', 'res://scripts/ending_line.gd'],
    ['EndingLines', 'res://scripts/ending_lines.gd'],
    ['Settled', 'res://scripts/settled.gd'],
  ]);
  const cached = new Map([['Settled', 'res://scripts/settled.gd']]);

  const found = unloadedTypes(
    [
      'Could not find base class "EndingLine".',
      'Identifier "EndingLines" not declared in the current scope.',
      'Identifier "EndingLines" not declared in the current scope.',
      'Could not find base class "Settled".',
      'Identifier "some_local" not declared in the current scope.',
    ],
    declared,
    cached,
  );

  assert.deepEqual(
    found,
    [
      { type: 'EndingLine', declaredIn: 'res://scripts/ending_line.gd', inTheClassCache: false },
      { type: 'EndingLines', declaredIn: 'res://scripts/ending_lines.gd', inTheClassCache: false },
      { type: 'Settled', declaredIn: 'res://scripts/settled.gd', inTheClassCache: true },
    ],
    'each declared class once, with the cache answer that picks the remedy',
  );

  // The direction that must not be got wrong. An identifier the project does not declare is an
  // ordinary undeclared name, and claiming it is a loading problem would send a caller to restart
  // the editor over their own typo.
  assert.equal(
    found.some((type) => type.type === 'some_local'),
    false,
    'a name the project declares nowhere is left alone',
  );
  assert.deepEqual(
    unloadedTypes(['Could not find base class "EndingLine".'], new Map(), null),
    [],
    'and a project that declares nothing yields nothing rather than everything',
  );
}

/**
 * An audit that could not reach the advisories is not an audit that passed.
 *
 * `bun audit` exits 1 for two unrelated things: a dependency with a known vulnerability, and
 * registry.npmjs.org not answering. The workflows ran it bare, so a 503 read as a failed audit and
 * stopped a build, on the same afternoon a different third-party outage stopped a release. Retrying
 * the outage is the fix, and it is the retry that has to be got right rather than the command:
 * classify a real finding as an outage and the build retries three times and then fails, which is
 * merely slow, but classify an outage as clean and a release ships having cleared nothing.
 *
 * So both directions are asserted with the real output of each, and the finding is the one that
 * matters. Matching on the transport rather than on "printed no advisories" is what keeps them
 * apart: a clean audit and an unreachable one both name no advisory.
 */
function testAnAuditThatCouldNotAskIsNotAnAuditThatPassed(): void {
  assert.equal(
    serviceDidNotAnswer('error: POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - 503'),
    true,
    'the 503 that stopped a build is an outage',
  );
  for (const transport of [
    'error: POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - 429',
    'error: connect ECONNREFUSED 104.16.0.35:443',
    'error: fetch failed',
    'error: socket hang up',
  ]) {
    assert.equal(serviceDidNotAnswer(transport), true, `${transport} is the service, not the tree`);
  }

  // A real finding, which must never be retried and never be taken for an outage. The version is
  // the trap, and it caught this classifier rather than being invented for the fixture: a package
  // at 1.502.0 puts a bare 502 between two word boundaries, so a status code matched anywhere in
  // the output reads a genuine advisory as an outage and waits it out instead of failing.
  const finding = [
    'bun audit v1.4.2 (744846f84)',
    '',
    'some-package  1.502.0',
    'Severity: high - Prototype Pollution in some-package',
    'https://github.com/advisories/GHSA-p6mc-m468-83gg',
    '',
    '1 vulnerability (1 high)',
  ].join('\n');
  assert.equal(
    serviceDidNotAnswer(finding),
    false,
    'a reported vulnerability is the audit working, and retrying it would be waiting out a real finding',
  );
}

/**
 * Refreshing UIDs makes the missing sidecar and writes no scene.
 *
 * The op used to load every scene and resave it. Outside the editor that round trip rebuilds the
 * header from what the engine could see, so `load_steps` went, and so did the scene's own `uid=`:
 * an op whose entire purpose is keeping UID references resolvable was deleting the UID that other
 * resources point at, in every scene in the project, on a call that named no scene at all. A project
 * with 47 scenes got a 31-file diff to revert. It also reported `scripts_resaved: 1` for a script
 * whose sidecar it had not made, because `ResourceSaver.save` on a script answers OK headlessly and
 * writes nothing, and the count was taken from the return rather than from the disk.
 *
 * Both halves are asserted together on purpose, and the scene is compared byte for byte rather than
 * by `load_steps` alone, because the uid line was the half nobody noticed. The made sidecar is the
 * positive that keeps the untouched scene meaningful: an op that had stopped running at all would
 * leave every scene alone just as well.
 */
/**
 * An annotation sharing the line with a declaration does not hide it, on any of the paths.
 *
 * `@abstract class_name X` is one line in Godot 4.5 and later, and `@tool` and `@icon("...")` sit
 * there too. Five readers here matched `class_name` at the start of a line and saw none of them.
 * The reported half cost a project 23 classes named as declared nowhere, with the answer telling
 * the caller to restart the editor to drop them. The half nobody had hit is worse and is why this
 * runs an engine: the insertion points that place a new `var` or `signal` found the header only
 * where some other line carried it, so a script whose whole header is the annotated declaration
 * took the new line above the `class_name`, where it does not parse.
 *
 * Driven through the engine rather than asserted against the parser, because what is being claimed
 * is that the file Godot is handed afterwards is one Godot accepts.
 */
async function testAnAnnotatedDeclarationIsStillADeclaration(): Promise<void> {
  const godotPath = resolveGodotPath();
  if (!godotPath) {
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and GODOT_PATH names no existing file.');
    }
    console.log('annotated declaration regression skipped (Godot not found)');
    return;
  }

  const project = mkdtempSync(join(tmpdir(), 'gdharness-annotated-'));
  try {
    writeFileSync(
      join(project, 'project.godot'),
      '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="Annotated"\n',
    );
    writeFileSync(
      join(project, 'shape.gd'),
      '@abstract class_name Shape\nextends RefCounted\n\n\nfunc area() -> float:\n\treturn 0.0\n',
    );
    // A script whose whole header is the annotated declaration. `shape.gd` cannot show where an
    // insertion lands, because its `extends` line is found with or without the annotations off and
    // fixes the insertion point at 2 either way. Here there is nothing else to find, so a reader
    // that cannot see through `@abstract` puts the new line at 0, above the declaration.
    writeFileSync(
      join(project, 'marker.gd'),
      '@abstract class_name Marker\n\n\nfunc mark() -> void:\n\tpass\n',
    );
    // A use of the class, so the reverse walk has something to classify. The annotation shares the
    // line with the `extends` here rather than with a declaration, which is the same fault one step
    // on: unstripped it is not an `extends` line, so the use is labelled with the catch-all.
    //
    // The two comments name the class as well, and they are not uses. A project that documents
    // itself names its collaborators in `##` links, so the better documented it is the further
    // `total` drifts from the answer to "does anything still use this".
    writeFileSync(
      join(project, 'user.gd'),
      [
        '@tool extends Shape',
        '',
        '## Built on [Shape], which is where every figure comes from.',
        '# A plain comment naming Shape, which is prose rather than a use.',
        '',
        '',
        'func use() -> void:',
        '\tpass',
        '',
      ].join('\n'),
    );
    // For `after_ready`, which has to find one annotated function and stop at the next. Reading
    // the raw line missed both ends: an annotated `_ready` was never found, so the answer went to
    // the end of the file, and an annotated function after it was not the boundary it is.
    writeFileSync(
      join(project, 'place.gd'),
      [
        'extends Node',
        '',
        '',
        '@warning_ignore("unused_parameter") func _ready() -> void:',
        '\tpass',
        '',
        '',
        '@abstract func later() -> void',
        '',
        '',
        'func last() -> void:',
        '\tpass',
        '',
      ].join('\n'),
    );
    // The same use written as a path, which is classified by a different line reading the same way.
    writeFileSync(
      join(project, 'by_path.gd'),
      '@tool extends "res://shape.gd"\n\n\nfunc use() -> void:\n\tpass\n',
    );
    // The base on the declaration line, which GDScript also allows. `Node2D` rather than a
    // `RefCounted` descendant, because `RefCounted` is what the reader falls back to when it finds
    // no `extends` at all, and a fixture using it cannot tell a reading from a default.
    // Every other thing an annotation can sit in front of, in one script. A declaration is only
    // the shape that was reported: `@abstract func` and `@warning_ignore(...) func` are the same
    // fault on the branch nobody named, and gdUnit4 alone declares 248 methods that way.
    writeFileSync(
      join(project, 'blade.gd'),
      [
        '@abstract class_name Blade extends Node2D',
        '',
        '@warning_ignore("unused_signal") signal hit(power: int)',
        '',
        '@export_range(0, 10) var ratio: float = 1.0',
        '@onready var body: Node = self',
        '',
        '',
        '@abstract func swing() -> void',
        '',
        '',
        '@warning_ignore("unused_parameter") func parry(other: Node) -> bool:',
        '\treturn true',
        '',
      ].join('\n'),
    );

    const server = new ServerProcess({ env: { GODOT_PATH: godotPath } });
    try {
      await server.initialize('regression-test');
      const call = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
        parseTextContent(
          await server.request('tools/call', { name, arguments: args }, ENGINE_CALL_TIMEOUT_MS),
        );

      const read = await call('script_info', {
        projectPath: project,
        op: 'structure',
        scriptPath: 'res://shape.gd',
      });
      assert.equal(
        get(read, 'class_name'),
        'Shape',
        `the declared class is found behind its annotation: ${JSON.stringify(read)}`,
      );

      const oneLine = await call('script_info', {
        projectPath: project,
        op: 'structure',
        scriptPath: 'res://blade.gd',
      });
      assert.equal(
        get(oneLine, 'class_name'),
        'Blade',
        `the name stops where the name stops: ${JSON.stringify(oneLine)}`,
      );
      assert.equal(
        get(oneLine, 'extends'),
        'Node2D',
        `and the base on the same line is the base: ${JSON.stringify(oneLine)}`,
      );
      // The whole list rather than a search through it: a reader that drops one declaration drops
      // it silently, and a check that looks for the ones it expects cannot see what went missing.
      assert.deepEqual(
        asArray(get(oneLine, 'functions')).map((each) => get(each, 'name')),
        ['swing', 'parry'],
        `both annotated functions are functions: ${JSON.stringify(oneLine)}`,
      );
      assert.equal(
        get(asArray(get(oneLine, 'functions'))[0], 'is_abstract'),
        true,
        `and the abstract one says so, since it has no body to read: ${JSON.stringify(oneLine)}`,
      );
      assert.equal(
        get(asArray(get(oneLine, 'functions'))[1], 'is_abstract'),
        false,
        `while the one behind another annotation does not: ${JSON.stringify(oneLine)}`,
      );
      assert.deepEqual(
        asArray(get(oneLine, 'signals')).map((each) => get(each, 'name')),
        ['hit'],
        `the annotated signal is a signal: ${JSON.stringify(oneLine)}`,
      );
      assert.deepEqual(
        asArray(get(oneLine, 'variables')).map((each) => [
          get(each, 'name'),
          get(each, 'is_export'),
          get(each, 'export_hint'),
          get(each, 'is_onready'),
        ]),
        [
          // The hint whole: splitting an annotation on whitespace cut this one at the space
          // inside its parentheses and answered `range(0,`.
          ['ratio', true, 'range(0, 10)', false],
          ['body', false, '', true],
        ],
        `and the annotations on a variable are the answer about it: ${JSON.stringify(oneLine)}`,
      );

      // The reverse walk reads the declaration itself, to find the uses that name the class rather
      // than the path, so it has its own answer to what a declaration looks like.
      const used = await call('project_dependencies', {
        projectPath: project,
        direction: 'reverse',
        resourcePath: 'res://shape.gd',
      });
      assert.equal(
        get(used, 'class_name'),
        'Shape',
        `the reverse walk knows what the script declares: ${JSON.stringify(used)}`,
      );
      // The whole tally rather than one entry of it: a use that goes to the catch-all is only
      // wrong because it is not counted as the extends it is, and a count of the one kind cannot
      // see where the missing one went.
      assert.deepEqual(
        get(used, 'summary', 'by_kind'),
        { extends: 2, doc: 1, comment: 1 },
        `both uses extend it behind an annotation, and neither mention is one: ${JSON.stringify(used)}`,
      );
      assert.equal(
        get(used, 'summary', 'in_code'),
        2,
        `and the count that answers whether anything uses it leaves the prose out: ${JSON.stringify(used)}`,
      );
      assert.equal(
        get(used, 'summary', 'total'),
        4,
        `while total still counts everything found, so neither number has to be derived: ${JSON.stringify(used)}`,
      );

      const written = await call('script_edit', {
        projectPath: project,
        op: 'modify',
        scriptPath: 'res://marker.gd',
        modifications: [
          { type: 'add_variable', name: 'sides', varType: 'int', defaultValue: '3' },
          { type: 'add_signal', name: 'marked' },
        ],
      });
      // Read back rather than trusted. An answer that did not say `ok: false` is not an answer
      // that wrote anything, which is how a first version of this case passed the call and then
      // found the file untouched: the arguments were wrong and nothing said so loudly enough.
      assert.equal(get(written, 'success'), true, `both should be added: ${JSON.stringify(written)}`);

      // Where they landed, which is the whole point: above the class_name is a file that does not
      // parse, and the answer would say it wrote a variable either way. The signal has its own
      // insertion point in the engine, with its own reading of the header.
      const after = readFileSync(join(project, 'marker.gd'), 'utf8').split('\n');
      const declaration = after.findIndex((line) => line.includes('class_name Marker'));
      const variable = after.findIndex((line) => line.includes('sides'));
      const declared = after.findIndex((line) => line.includes('signal marked'));
      assert.ok(declaration >= 0, `the declaration should still be there: ${after.join('\\n')}`);
      assert.ok(variable > declaration, `the variable below it, not above: ${after.join('\\n')}`);
      assert.ok(declared > declaration, `and the signal below it too: ${after.join('\\n')}`);

      const placed = await call('script_edit', {
        projectPath: project,
        op: 'modify',
        scriptPath: 'res://place.gd',
        modifications: [{ type: 'add_function', name: 'placed', body: 'pass', position: 'after_ready' }],
      });
      assert.equal(get(placed, 'success'), true, `the function should be added: ${JSON.stringify(placed)}`);
      const laidOut = readFileSync(join(project, 'place.gd'), 'utf8').split('\n');
      const ready = laidOut.findIndex((line) => line.includes('func _ready'));
      const abstract = laidOut.findIndex((line) => line.includes('func later'));
      const added = laidOut.findIndex((line) => line.includes('func placed'));
      assert.ok(
        added > ready && added < abstract,
        `after_ready means between the two, not at the end: ${laidOut.join('\\n')}`,
      );
      assert.equal(laidOut[added - 1], '', `with a blank line above it: ${laidOut.join('\\n')}`);
      assert.equal(
        laidOut[abstract - 1],
        '',
        `and one below, rather than two declarations touching: ${laidOut.join('\\n')}`,
      );

      // And Godot agrees it is a script, which is the claim those line numbers stand for.
      const reread = await call('script_info', {
        projectPath: project,
        op: 'structure',
        scriptPath: 'res://marker.gd',
      });
      assert.equal(
        get(reread, 'class_name'),
        'Marker',
        `still readable afterwards: ${JSON.stringify(reread)}`,
      );
      assert.ok(
        asArray(get(reread, 'variables') ?? []).length >= 1,
        `and the variable is in it: ${JSON.stringify(reread)}`,
      );
      assert.ok(
        asArray(get(reread, 'signals') ?? []).length >= 1,
        `and the signal is in it: ${JSON.stringify(reread)}`,
      );
    } finally {
      await server.stop();
    }
  } finally {
    sweep(project);
  }
}

/**
 * A structure read describes the script it read, in every shape a declaration comes in.
 *
 * One engine and one project for all of it, because the boot is the slow part and each of these is
 * a different reading of the same call. What it holds, in the order the assertions come: what a
 * script inherits when asked for it, which functions the engine actually calls, a rest parameter's
 * name, a parameter list that ends where the signature does rather than at the first comma or the
 * first line break, and a trailing comment that does not become part of a value.
 *
 * `includeInherited` was described in the schema and read by nothing: the op maps to
 * `get_script_info`, which took `script_path` and no other parameter, so the two answers were byte
 * for byte the same and a caller who set it believed they had the base's members. Found by reading
 * the surface against what answers it rather than by a call that went wrong, which is what a
 * parameter that fails silently leaves as the only way to find it.
 *
 * The lists are compared whole, with each member paired to the file it came from. A check that
 * looks for the inherited names it expects passes on an answer that also carries names from
 * somewhere else, and the name a leaf overrides is the case that separates a walk that tags its
 * findings from one that merely concatenates: `shared` is declared twice and must appear twice,
 * once as the leaf's own and once as the base's.
 */
async function testAStructureReadDescribesTheScriptItRead(): Promise<void> {
  const godotPath = resolveGodotPath();
  if (!godotPath) {
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and GODOT_PATH names no existing file.');
    }
    console.log('inherited structure regression skipped (Godot not found)');
    return;
  }

  const project = mkdtempSync(join(tmpdir(), 'gdharness-inherited-'));
  try {
    writeFileSync(
      join(project, 'project.godot'),
      '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="Inherited"\n',
    );
    writeFileSync(
      join(project, 'base.gd'),
      [
        'class_name ProbeBase',
        'extends RefCounted',
        '',
        'signal base_fired',
        '',
        'const BASE_MAX: int = 3',
        '',
        'var base_held: int = 1',
        '',
        '',
        'func base_method() -> void:',
        '\tpass',
        '',
        '',
        'func shared() -> String:',
        '\treturn "base"',
        '',
      ].join('\n'),
    );
    // Two levels, so the walk has to keep going after the first base rather than stopping at it.
    writeFileSync(
      join(project, 'middle.gd'),
      [
        'class_name ProbeMiddle',
        'extends ProbeBase',
        '',
        'var middle_held: float = 2.0',
        '',
        '',
        'func middle_method() -> void:',
        '\tpass',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(project, 'leaf.gd'),
      [
        'class_name ProbeLeaf',
        'extends ProbeMiddle',
        '',
        '',
        'func shared() -> String:',
        '\treturn "leaf"',
        '',
      ].join('\n'),
    );
    // For `is_virtual`, which said "starts with an underscore" and so reported every private
    // helper as something the engine calls. `_draw` is on `Node2D` rather than on `Node`, so a
    // lookup that stopped at the wrong ancestor would find `_ready` and miss it.
    writeFileSync(
      join(project, 'virtuals.gd'),
      [
        'extends Node2D',
        '',
        '',
        'func _ready() -> void:',
        '\tpass',
        '',
        '',
        'func _draw() -> void:',
        '\tpass',
        '',
        '',
        'func _compute_damage() -> int:',
        '\treturn 1',
        '',
        '',
        'func visible_helper() -> void:',
        '\tpass',
        '',
        '',
        // A rest parameter, where the dots are syntax rather than part of the name.
        'func collect(first: int, ...rest: Array) -> void:',
        '\tprint(first, rest)',
        '',
      ].join('\n'),
    );
    // Commas that are not separators, and a bracket that is not the end of the signature. Each of
    // these is ordinary Godot and each one used to add parameters the function does not have.
    writeFileSync(
      join(project, 'defaults.gd'),
      [
        'extends RefCounted',
        '',
        'signal changed(d: Dictionary[String, int])',
        '',
        'const LABEL: String = "hash # inside"  # and a real comment',
        '',
        'var held: int = 5  # a trailing note',
        '',
        '',
        'func place(at: Vector2 = Vector2(1, 2), tint: Color = Color(1, 0, 0, 1), name: String = "a,b") -> void:',
        '\tprint(at, tint, name)',
        '',
        '',
        // A body on the declaration's own line, carrying a bracket and a colon of its own. The
        // trailing-comment version of this cannot separate the two fixes, because taking the
        // comment off first leaves the last bracket on the line where it belongs.
        'func noted(a: int) -> void: print(a, ")")',
        '',
        '',
        // A comma inside a typed collection, which is not a separator either. Reported from a game
        // project where 13 single-line signatures carry one and the pinned gdUnit4 has a single
        // instance, so the addon barely exercises this and an ordinary project has them everywhere.
        'func from_dict(saved: Dictionary, roster: Dictionary[String, int]) -> bool:',
        '\treturn saved.size() + roster.size() > 0',
        '',
        '',
        // Wrapped, which `gdformat` does to anything past the line length. Read one line at a time
        // this answered with no parameters and no return type, both of them on lines it never saw.
        'func spread(',
        '\tfirst: int,',
        '\tsecond: String = "x",',
        ') -> bool:',
        '\treturn first > 0 and second != ""',
        '',
        '',
        // Every one of them at once: an annotation on the first line of a declaration that wraps,
        // a comma inside a typed collection, and a rest parameter, in a signature whose return
        // type is on the closing line. Each has a case of its own above and none of those carries
        // a second, which is the gap a suite of single-feature cases leaves by construction.
        '@abstract func later(',
        '\tonly: Dictionary[String, int],',
        '\t...rest: Array,',
        ') -> void',
        '',
      ].join('\n'),
    );
    // A wrapped enum, the other half of the same fault: 23 of them in the pinned gdUnit4.
    writeFileSync(
      join(project, 'wrapped.gd'),
      [
        'extends RefCounted',
        '',
        'enum Mode {',
        '\tFAST,',
        '\tSLOW,',
        '}',
        '',
        // The brace opens before the comment and closes on a later line, which is the only shape
        // that separates the comment stripper from its neighbours: it counts no brackets, because
        // a `#` starts a comment wherever it is. Give it the depth the others have and the comment
        // lands inside the value.
        'var table := {  # keyed by name',
        '\t"a": 1,',
        '\t"b": 2,',
        '}',
        '',
      ].join('\n'),
    );
    // A file mid-edit, which is the state an agent is most likely to ask about. Joining lines until
    // the brackets balance made this worse before it was bounded to declarations: an unclosed
    // `print(` in a body ran to the end of the file and took `after` with it.
    writeFileSync(
      join(project, 'broken.gd'),
      [
        'extends RefCounted',
        '',
        'var kept: int = 1',
        '',
        '',
        'func half_written() -> void:',
        '\tprint(',
        '',
        '',
        'func after() -> void:',
        '\tpass',
        '',
      ].join('\n'),
    );

    const server = new ServerProcess({ env: { GODOT_PATH: godotPath } });
    try {
      await server.initialize('regression-test');
      const call = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
        parseTextContent(
          await server.request('tools/call', { name, arguments: args }, ENGINE_CALL_TIMEOUT_MS),
        );

      // The chain is resolved through the project's class list, so it has to exist before the read.
      const scanned = await call('project_import', { projectPath: project, op: 'refresh_classes' });
      assert.equal(get(scanned, 'classes'), 3, `all three declare a class: ${JSON.stringify(scanned)}`);

      const named = (answer: unknown, list: string): unknown[] =>
        asArray(get(answer, list) ?? []).map((each) => [
          get(each, 'name'),
          get(each, 'inherited_from') ?? null,
        ]);

      const own = await call('script_info', {
        projectPath: project,
        op: 'structure',
        scriptPath: 'res://leaf.gd',
      });
      assert.deepEqual(
        named(own, 'functions'),
        [['shared', null]],
        `unasked, a script is its own members only: ${JSON.stringify(own)}`,
      );
      assert.equal(
        get(own, 'inherits_from'),
        undefined,
        `and no chain was walked to report: ${JSON.stringify(own)}`,
      );

      const all = await call('script_info', {
        projectPath: project,
        op: 'structure',
        scriptPath: 'res://leaf.gd',
        includeInherited: true,
      });
      assert.deepEqual(
        get(all, 'inherits_from'),
        ['res://middle.gd', 'res://base.gd'],
        `the chain is walked in order and named: ${JSON.stringify(all)}`,
      );
      assert.deepEqual(
        named(all, 'functions'),
        [
          ['shared', null],
          ['middle_method', 'res://middle.gd'],
          ['base_method', 'res://base.gd'],
          // Overridden, so declared at two lines and listed at both.
          ['shared', 'res://base.gd'],
        ],
        `every function, each said to come from where it does: ${JSON.stringify(all)}`,
      );
      assert.deepEqual(
        named(all, 'variables'),
        [
          ['middle_held', 'res://middle.gd'],
          ['base_held', 'res://base.gd'],
        ],
        `and the variables: ${JSON.stringify(all)}`,
      );
      assert.deepEqual(
        named(all, 'signals'),
        [['base_fired', 'res://base.gd']],
        `and the signals: ${JSON.stringify(all)}`,
      );
      assert.deepEqual(
        named(all, 'constants'),
        [['BASE_MAX', 'res://base.gd']],
        `and the constants: ${JSON.stringify(all)}`,
      );

      // Asked of the engine rather than guessed from the name. The whole table, because the claim
      // is about which functions are virtual and which are not, and reading only the two that are
      // passes on an answer that calls everything virtual.
      const engineCalls = await call('script_info', {
        projectPath: project,
        op: 'structure',
        scriptPath: 'res://virtuals.gd',
      });
      assert.deepEqual(
        asArray(get(engineCalls, 'functions')).map((each) => [get(each, 'name'), get(each, 'is_virtual')]),
        [
          ['_ready', true],
          // On `Node2D`, not on `Node`, so the whole chain to the native class has to be walked.
          ['_draw', true],
          // Private by convention, which is what the old reading mistook for virtual.
          ['_compute_damage', false],
          ['visible_helper', false],
          ['collect', false],
        ],
        `only what the engine calls is virtual: ${JSON.stringify(engineCalls)}`,
      );
      assert.deepEqual(
        get(asArray(get(engineCalls, 'functions'))[4], 'params'),
        [
          { name: 'first', type: 'int', default: '', is_rest: false },
          // The dots are the syntax, so a caller building a call site gets a name it can use.
          { name: 'rest', type: 'Array', default: '', is_rest: true },
        ],
        `a rest parameter is named without its dots and says it is one: ${JSON.stringify(engineCalls)}`,
      );

      // A comma inside a default value is the same character as the one between parameters, and
      // splitting on every comma invented one parameter per comma it should not have seen. The
      // whole table, because the fault adds entries rather than losing them: an assertion naming
      // the three that should be there passes on an answer that also carries five that should not.
      const bracketed = await call('script_info', {
        projectPath: project,
        op: 'structure',
        scriptPath: 'res://defaults.gd',
      });
      assert.deepEqual(
        asArray(get(bracketed, 'functions')).map((each) => [
          get(each, 'name'),
          get(each, 'return_type'),
          asArray(get(each, 'params')).map((p) => [get(p, 'name'), get(p, 'type'), get(p, 'default')]),
        ]),
        [
          [
            'place',
            'void',
            [
              ['at', 'Vector2', 'Vector2(1, 2)'],
              ['tint', 'Color', 'Color(1, 0, 0, 1)'],
              // The comma here is inside the string, so it separates nothing.
              ['name', 'String', '"a,b"'],
            ],
          ],
          // The last bracket on this line belongs to the body, not to the signature, and the last
          // colon does too: read to the end of the line this answered with a parameter typed
          // `int) -> void`, a second one named `")"`, and no return type at all.
          ['noted', 'void', [['a', 'int', '']]],
          [
            'from_dict',
            'bool',
            [
              ['saved', 'Dictionary', ''],
              // The comma is inside the type's own brackets, so it separates nothing. Split on it,
              // this answered with a third parameter named `int]` and a truncated second type.
              ['roster', 'Dictionary[String, int]', ''],
            ],
          ],
          [
            // Wrapped across four lines, and the `-> bool` is on the last of them.
            'spread',
            'bool',
            [
              ['first', 'int', ''],
              ['second', 'String', '"x"'],
            ],
          ],
          [
            'later',
            'void',
            [
              ['only', 'Dictionary[String, int]', ''],
              ['rest', 'Array', ''],
            ],
          ],
        ],
        `every parameter list ends where the signature does: ${JSON.stringify(bracketed)}`,
      );
      // The annotation is on the first line of a declaration that runs to the fourth, so whether it
      // is seen at all depends on the joining happening before the annotations are read.
      const combined = asArray(get(bracketed, 'functions')).at(-1);
      assert.equal(
        get(combined, 'name'),
        'later',
        `the combined declaration is the last one: ${JSON.stringify(bracketed)}`,
      );
      assert.equal(
        get(combined, 'is_abstract'),
        true,
        `an annotation on a wrapped declaration is still read: ${JSON.stringify(bracketed)}`,
      );
      assert.equal(
        get(asArray(get(combined, 'params'))[1], 'is_rest'),
        true,
        `and so is a rest parameter three lines below it: ${JSON.stringify(bracketed)}`,
      );

      const wrapped = await call('script_info', {
        projectPath: project,
        op: 'structure',
        scriptPath: 'res://wrapped.gd',
      });
      assert.deepEqual(
        asArray(get(wrapped, 'enums')).map((each) => [
          get(each, 'name'),
          get(each, 'values'),
          get(each, 'line'),
        ]),
        // The line is where the declaration starts, not where its closing brace is.
        [['Mode', ['FAST', 'SLOW'], 3]],
        `a wrapped enum has the members it declares: ${JSON.stringify(wrapped)}`,
      );
      assert.deepEqual(
        asArray(get(wrapped, 'variables')).map((each) => [get(each, 'name'), get(each, 'default_value')]),
        [['table', '{ "a": 1, "b": 2, }']],
        `and a comment beside an opening brace is not part of the value: ${JSON.stringify(wrapped)}`,
      );

      const halfWritten = await call('script_info', {
        projectPath: project,
        op: 'structure',
        scriptPath: 'res://broken.gd',
      });
      assert.deepEqual(
        asArray(get(halfWritten, 'functions')).map((each) => get(each, 'name')),
        // Both of them: the one holding the unclosed bracket and the one below it. The second is
        // the whole point, since joining to the end of the file leaves the first exactly as it is.
        ['half_written', 'after'],
        `an unclosed bracket in a body costs nothing below it: ${JSON.stringify(halfWritten)}`,
      );
      assert.deepEqual(
        asArray(get(halfWritten, 'variables')).map((each) => get(each, 'name')),
        ['kept'],
        `and the variable above it is still read: ${JSON.stringify(halfWritten)}`,
      );
      assert.deepEqual(
        asArray(get(bracketed, 'signals')).map((each) => [
          get(each, 'name'),
          asArray(get(each, 'params')).map((p) => [get(p, 'name'), get(p, 'type')]),
        ]),
        // A signal's parameters are written like a function's, and the comma inside the type is
        // not a separator either.
        [['changed', [['d', 'Dictionary[String, int]']]]],
        `and a signal's list is read the same way: ${JSON.stringify(bracketed)}`,
      );
      assert.deepEqual(
        asArray(get(bracketed, 'variables')).map((each) => [get(each, 'name'), get(each, 'default_value')]),
        [['held', '5']],
        `a trailing comment is not part of a default: ${JSON.stringify(bracketed)}`,
      );
      assert.deepEqual(
        asArray(get(bracketed, 'constants')).map((each) => [get(each, 'name'), get(each, 'value')]),
        // The `#` inside the string is not a comment, and the one after it is.
        [['LABEL', '"hash # inside"']],
        `nor of a constant, and a hash inside a string is not a comment: ${JSON.stringify(bracketed)}`,
      );

      // A native base declares nothing in a file, so the walk has nothing to do and says so with an
      // empty chain rather than by refusing the call.
      const atTheTop = await call('script_info', {
        projectPath: project,
        op: 'structure',
        scriptPath: 'res://base.gd',
        includeInherited: true,
      });
      assert.deepEqual(
        get(atTheTop, 'inherits_from'),
        [],
        `a RefCounted base is not a script to read: ${JSON.stringify(atTheTop)}`,
      );
      assert.deepEqual(
        named(atTheTop, 'functions'),
        [
          ['base_method', null],
          ['shared', null],
        ],
        `and its own members are still all there: ${JSON.stringify(atTheTop)}`,
      );
    } finally {
      await server.stop();
    }
  } finally {
    sweep(project);
  }
}

async function testRefreshingUidsMakesTheSidecarAndWritesNoScene(): Promise<void> {
  const godotPath = resolveGodotPath();
  if (!godotPath) {
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and GODOT_PATH names no existing file.');
    }
    console.log('refresh_uids regression skipped (Godot not found)');
    return;
  }

  const project = mkdtempSync(join(tmpdir(), 'gdharness-uids-'));
  try {
    writeFileSync(
      join(project, 'project.godot'),
      '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="Uids"\n',
    );
    writeFileSync(join(project, 'hero.gd'), 'extends Node2D\n\n\nfunc _ready() -> void:\n\tpass\n');
    // A header carrying both of the things the resave used to throw away.
    const scene =
      '[gd_scene load_steps=2 format=3 uid="uid://b3gdharnessuids"]\n\n' +
      '[ext_resource type="Script" path="res://hero.gd" id="1_hero"]\n\n' +
      '[node name="Main" type="Node2D"]\n' +
      'script = ExtResource("1_hero")\n';
    writeFileSync(join(project, 'main.tscn'), scene);

    // Nothing here has been imported, which is the state a script added since the last import is
    // in: the engine has never walked it, so nothing has minted its sidecar.
    mkdirSync(join(project, 'tests'), { recursive: true });
    writeFileSync(join(project, 'tests', 'late.gd'), 'extends Node\n\n\nfunc _ready() -> void:\n\tpass\n');
    const sidecar = join(project, 'tests', 'late.gd.uid');
    assert.equal(existsSync(sidecar), false, 'the fixture starts with the sidecar genuinely absent');

    const server = new ServerProcess({ env: { GODOT_PATH: godotPath } });
    try {
      await server.initialize('regression-test');
      const answered: unknown = parseTextContent(
        await server.request(
          'tools/call',
          { name: 'project_import', arguments: { projectPath: project, op: 'refresh_uids' } },
          ENGINE_CALL_TIMEOUT_MS,
        ),
      );

      assert.deepEqual(
        asArray(get(answered, 'uidsCreated')),
        ['hero.gd', 'tests/late.gd'],
        `the sidecars the op made are the ones that were missing: ${JSON.stringify(answered)}`,
      );
      assert.ok(existsSync(sidecar), 'and it is on disk, which is where the caller will look for it');
      assert.deepEqual(asArray(get(answered, 'stillWithoutUid')), [], JSON.stringify(answered));

      assert.equal(
        readFileSync(join(project, 'main.tscn'), 'utf8'),
        scene,
        'no scene is rewritten, header and uid included',
      );
    } finally {
      await server.stop();
    }
  } finally {
    sweep(project);
  }
}

/**
 * A cleanup that cannot finish still finishes everything else, and still lets the call speak.
 *
 * The server makes a scratch directory per headless operation, export and test run, hands it to an
 * engine, reads it back and removes it in a `finally`. On Windows that removal genuinely fails: the
 * engine keeps a handle on the directory after it is killed and lets go on its own schedule, so the
 * remove answers EBUSY. Thrown from a `finally`, that errno becomes the answer, so a test run that
 * finished and had its report parsed is returned to the caller as an error about a directory, with
 * the report dropped on the way out. It also abandons every path queued behind it, which is how the
 * run that swept its reports directory leaked the user data directory on the next line. The fixtures
 * in this file share the same sweep and had leaked on six separate days before anyone looked.
 *
 * Asserted with a remove that refuses rather than a locked handle, which has no portable spelling:
 * the part under test is that one refusal decides nothing about the paths either side of it. Hence
 * the attempted list, and not merely the absence of a throw. A sweep that quietly skipped everything
 * would satisfy "did not throw" perfectly, and would be exactly the wrong fix.
 */
function testACleanupThatCannotFinishStillFinishes(): void {
  const attempted: string[] = [];
  const left = discardWith(
    (path) => {
      attempted.push(path);
      if (path === 'locked') {
        throw new Error('EBUSY: resource busy or locked');
      }
    },
    ['first', null, 'locked', undefined, 'last'],
  );

  assert.deepEqual(
    attempted,
    ['first', 'locked', 'last'],
    'the path after the failing one is swept, and a path that was never made is not attempted',
  );
  assert.deepEqual(
    left.map(({ path }) => path),
    ['locked'],
    'the one that survived is the one named',
  );
  assert.match(
    left[0]?.reason ?? '',
    /EBUSY/,
    'and it carries why, because "a directory is still there" alone says nothing about what to fix',
  );
}

/**
 * Who is listening on a port, which is what says a debug adapter is the connected editor's.
 *
 * Godot gives every editor the same debug adapter port by default, and the addon reports the port
 * its editor's settings name rather than the one it managed to bind. Two editors opened by hand
 * both answer 6006, one of them holds it, and nothing in the answer says which. A server that
 * connects on that number reads a console belonging to another project, with every field of the
 * reply well-formed. That is not a worry: a fixture in this file did it, to a real editor of
 * another project on this machine, and read its game's output.
 *
 * What is asserted here is the reading itself, because the refusal built on it is only as good as
 * this is, and because the answer that matters most is the one meaning "I cannot tell". Not knowing
 * who holds a port has to stay distinct from knowing it is somebody else: the first is no grounds
 * to refuse anything and the second is.
 */
async function testWhoIsHoldingAPortIsAskable(): Promise<void> {
  // The Windows table as netstat prints it, with the header, both address families, a
  // connection that is not listening on the port asked about, and a UDP line with no state.
  const table = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234',
    '  TCP    127.0.0.1:6006         127.0.0.1:51000        ESTABLISHED     4321',
    '  TCP    127.0.0.1:6006         0.0.0.0:0              LISTENING       4321',
    '  TCP    [::]:16006             [::]:0                 LISTENING       5555',
    '  UDP    0.0.0.0:6006           *:*                                    7777',
  ].join('\r\n');
  assert.equal(
    listeningPidInNetstat(table, 6006),
    4321,
    'the listener on the port, not the connection on it',
  );
  assert.equal(listeningPidInNetstat(table, 16006), 5555, 'an IPv6 listener reads the same way');
  assert.equal(listeningPidInNetstat(table, 135), 1234);
  assert.equal(listeningPidInNetstat(table, 6007), null, 'a port nobody listens on names nobody');
  assert.equal(listeningPidInNetstat(table, 600), null, 'and a port that is a prefix of one is not it');

  const port = await reservePort();
  assert.equal(listeningPid(port), null, 'a port nobody is listening on has no holder to name');

  const held = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      held.once('error', reject);
      held.listen(port, '127.0.0.1', () => {
        resolve();
      });
    });
    const askedAt = Date.now();
    const holder = listeningPid(port);
    const took = Date.now() - askedAt;
    // Null is allowed: a platform that will not say is a case this has to have, and reading it as
    // "somebody else" would refuse every working setup on that platform. Windows says, through
    // netstat, and the time it takes is printed, since the ask sits on the play path in a call
    // that holds every other request: PowerShell's answer took a second here and nine on a runner.
    if (process.platform === 'win32') {
      assert.equal(holder, process.pid, `Windows names the holder of a port, through netstat: ${holder}`);
    } else if (holder !== null) {
      assert.equal(holder, process.pid, 'and the holder of one this process took is this process');
    } else {
      console.log('port holder regression: this platform would not say who is listening');
    }
    console.log(`port holder regression: the platform answered in ${took}ms`);
  } finally {
    await new Promise<void>((resolve) => {
      held.close(() => {
        resolve();
      });
    });
  }
}

/**
 * A setting the editor dropped on its way out is one the answer names.
 *
 * Godot writes only what differs from its own defaults, so a key a project names deliberately at
 * its default value is redundant to the editor and is stripped the next time it saves. A project
 * names one there to keep "off by decision" and "not set" apart, and losing it hands the choice
 * back to the engine. Downstream, one `editor_launch restart` took
 * `gdscript/warnings/return_value_discarded=0` out of project.godot and changed nothing else; their
 * own gate caught it, which is not something this tool can rely on.
 *
 * The comparison rather than the restart, because an editor with no window refuses to restart at
 * all: the engine hands back none of the arguments it consumed, so the tier's headless editor is
 * the one case that cannot drive this end to end. What can go wrong here is the reading of the
 * file, so that is what is asked.
 */
function testASettingTheEditorDroppedIsNamed(): void {
  const named = [
    'config_version=5',
    '',
    '[debug]',
    '',
    'gdscript/warnings/return_value_discarded=0',
    'gdscript/warnings/unsafe_call_argument=2',
  ].join('\n');
  const saved = ['config_version=5', '', '[debug]', '', 'gdscript/warnings/unsafe_call_argument=2'].join(
    '\n',
  );

  const before = settingKeys(named);
  const after = settingKeys(saved);
  assert.deepEqual(
    [...before].filter(([key]) => !after.has(key)),
    [['debug/gdscript/warnings/return_value_discarded', 0]],
    'the key that went is named, with the section it was in and the value it held',
  );
  assert.ok(before.has('root/config_version'), 'a key outside any section is read as one too');
  assert.deepEqual(
    [...after].filter(([key]) => !before.has(key)),
    [],
    'and a save that only drops things adds nothing',
  );
  // The same file twice is the ordinary case and must name nothing, or every restart would report
  // a loss and the field would stop being read.
  assert.deepEqual(
    [...before].filter(([key]) => !settingKeys(named).has(key)),
    [],
    'a file that did not change reports no loss',
  );
}

/**
 * The run the editor is playing is the run that gets answered for, not the last one on disk.
 *
 * A reconnect leaves a server with no memory of anything. The note on disk is written by runs this
 * server spawns, so an editor-played run leaves none, and what was picked up instead was the last
 * spawned run of the same project. Downstream, a session started one bench through the editor, the
 * server was replaced, and `editor_output` handed back forty rows of a different bench: its scene,
 * its pid, its transcript, `through` flipped from `editor` to `gdharness`, and every number in it
 * well-formed. Their run was alive throughout, thirty workers at a core each. A bench's output is a
 * table somebody attributes to the change they just made, so another run's rows read as your own
 * are a confident wrong measurement with nothing in the payload to argue with.
 *
 * So the editor is asked before the note is read: it is on the bridge and it is holding the run.
 * What is asserted is the whole of the fault, that no field of the other run appears, and beside it
 * that the answer is about the right one and says its log does not start at the beginning.
 */
/**
 * An editor running an addon from another version is still asked what it is playing.
 *
 * The server used to require the addon's version to equal its own before asking `playing_status`,
 * which is a reasonable guard on an answer whose shape might have moved and the wrong one for this
 * answer: it is a bool and two optional fields, the reader tolerates either being absent, and an
 * addon too old to know the call at all throws and is handled. What the guard bought was nothing.
 *
 * What it cost was that `playingInEditor` was null for the whole time an addon was behind, so a game
 * the editor was playing could not be picked up, and a server that had not started that game itself
 * then answered `No game is running` about one on screen. That window is the ordinary one: upgrading
 * moves the pin, and the editor keeps the old addon until somebody restarts it.
 *
 * Measured before the fix, one editor and one server against the same engine, changing only the
 * addon: 0.13.30 answered `playingInEditor: null` and 0.13.32 answered the scene it was playing.
 * Here the addon reports an older version in its greeting and answers the call normally, which is
 * the state the guard keyed on rather than an old addon's behaviour, because the guard read the
 * number and nothing else.
 */
async function testAnEditorOnAnotherVersionIsStillAskedWhatItIsPlaying(): Promise<void> {
  const project = mkdtempSync(join(tmpdir(), 'gdharness-stale-addon-'));
  const port = await reservePort();
  let editor: WebSocket | null = null;
  const server = new ServerProcess({ env: { GDHARNESS_BRIDGE_PORT: String(port) } });
  try {
    writeFileSync(
      join(project, 'project.godot'),
      '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="Stale"\n',
    );
    await server.initialize('regression-test');

    const socket = new WebSocket(`ws://127.0.0.1:${port}/godot`);
    editor = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', reject);
    });
    socket.on('message', (raw: Buffer) => {
      const message: unknown = JSON.parse(String(raw));
      if (!isRecord(message) || message['type'] !== 'tool_invoke') {
        return;
      }
      const result =
        String(message['tool']) === 'playing_status'
          ? { ok: true, playing: true, scenePath: 'res://duel.tscn', debugPort: 63_073 }
          : { ok: true };
      socket.send(JSON.stringify({ type: 'tool_result', id: message['id'], success: true, result }));
    });
    // A version that is not this server's, which is the whole condition. The addon answers the call
    // perfectly well; the server was deciding not to ask on the strength of this string.
    socket.send(
      JSON.stringify({
        type: 'godot_ready',
        project_path: project,
        addon_version: '0.0.1-behind',
        dap_port: 63_073,
      }),
    );

    let knows = false;
    for (let waited = 0; waited < 10_000 && !knows; waited += 100) {
      await delay(100);
      const status = await server.request('tools/call', { name: 'editor_status', arguments: {} });
      knows = text(get(parseTextContent(status), 'editor', 'projectPath')) === project;
    }
    assert.ok(knows, 'the fake editor should have been greeted');

    const status = parseTextContent(
      await server.request('tools/call', { name: 'editor_status', arguments: {} }),
    );
    // The staleness is still reported, because the caller should still be told to restart: what
    // changed is that being stale no longer costs them the answer as well as the warning.
    assert.equal(
      get(status, 'editor', 'addonIsStale'),
      true,
      `still called stale: ${JSON.stringify(status)}`,
    );
    assert.deepEqual(
      [get(status, 'game', 'playingInEditor', 'playing'), get(status, 'game', 'playingInEditor', 'scene')],
      [true, 'res://duel.tscn'],
      `and the scene it is playing is read off it anyway: ${JSON.stringify(status)}`,
    );
  } finally {
    editor?.close();
    await server.stop();
    sweep(project);
  }
}

/**
 * An editor that clears its breakpoints when a session opens is said so, and one that keeps them
 * is not.
 *
 * Godot's adapter answers `initialize` by clearing every breakpoint in the script editor unless
 * `network/debug_adapter/sync_breakpoints` is on, and it is off by default, so a harness session
 * took the user's breakpoints away on its first debug call. The addon turns the setting on as it
 * loads and says in its greeting whether it holds; an editor saying it does not is running an
 * older addon than the one on disk, and one saying nothing is older still. Both are told apart in
 * the advice, since one is a restart and the other might be a setting.
 *
 * Three greetings on one server, each from a fresh socket the way a restarted editor greets.
 */
async function testAnEditorThatClearsBreakpointsIsSaidSo(): Promise<void> {
  const project = mkdtempSync(join(tmpdir(), 'gdharness-sync-'));
  const port = await reservePort();
  const server = new ServerProcess({ env: { GDHARNESS_BRIDGE_PORT: String(port) } });
  const editor: { socket: WebSocket | null } = { socket: null };
  try {
    writeFileSync(join(project, 'project.godot'), 'config_version=5\n');
    await server.initialize('regression-test');
    const status = async (): Promise<unknown> =>
      parseTextContent(await server.request('tools/call', { name: 'editor_status', arguments: {} }));
    // Each greeting waits for the last editor to be gone from the server's point of view before
    // the next dials in, and then for a greeting that is its own: the bridge takes a moment to
    // notice a socket closing, and a status read in that moment answers about the editor before.
    let greetedAt = '';
    const greet = async (saying: Record<string, unknown>): Promise<unknown> => {
      if (editor.socket !== null) {
        editor.socket.close();
        let gone = false;
        for (let waited = 0; waited < 10_000 && !gone; waited += 100) {
          await delay(100);
          gone = get(await status(), 'editor', 'connected') === false;
        }
        assert.ok(gone, 'the previous fixture editor should have been seen leaving');
      }
      const socket = new WebSocket(`ws://127.0.0.1:${port}/godot`);
      editor.socket = socket;
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => {
          resolve();
        });
        socket.once('error', reject);
      });
      socket.on('message', (raw: Buffer) => {
        const message: unknown = JSON.parse(String(raw));
        if (isRecord(message) && message['type'] === 'tool_invoke') {
          socket.send(
            JSON.stringify({ type: 'tool_result', id: message['id'], success: true, result: { ok: true } }),
          );
        }
      });
      socket.send(
        JSON.stringify({
          type: 'godot_ready',
          project_path: project,
          addon_version: SERVER_VERSION,
          ...saying,
        }),
      );
      let seen: unknown = null;
      for (let waited = 0; waited < 10_000; waited += 100) {
        await delay(100);
        seen = await status();
        if (
          get(seen, 'editor', 'connected') === true &&
          text(get(seen, 'editor', 'connectedAt')) !== greetedAt
        ) {
          break;
        }
      }
      assert.equal(get(seen, 'editor', 'connected'), true, 'the fixture editor should be greeted');
      greetedAt = text(get(seen, 'editor', 'connectedAt'));
      return seen;
    };

    const clearing = await greet({ syncs_breakpoints: false });
    assert.equal(get(clearing, 'editor', 'syncsBreakpoints'), false, JSON.stringify(clearing));
    assert.match(
      text(get(clearing, 'editor', 'breakpointsAtRisk')),
      /clears every breakpoint .*sync_breakpoints is off.*editor_launch restart/s,
      `an editor with syncing off is said to clear breakpoints, with the restart as the remedy: ${JSON.stringify(clearing)}`,
    );

    const silent = await greet({});
    assert.equal(get(silent, 'editor', 'syncsBreakpoints'), undefined, JSON.stringify(silent));
    assert.match(
      text(get(silent, 'editor', 'breakpointsAtRisk')),
      /cannot be told.*predates the report.*editor_launch restart/s,
      `an addon too old to say is said to be that: ${JSON.stringify(silent)}`,
    );

    const keeping = await greet({ syncs_breakpoints: true });
    assert.equal(get(keeping, 'editor', 'syncsBreakpoints'), true, JSON.stringify(keeping));
    assert.equal(
      get(keeping, 'editor', 'breakpointsAtRisk'),
      undefined,
      `an editor that keeps its breakpoints has nothing said about them: ${JSON.stringify(keeping)}`,
    );
  } finally {
    editor.socket?.terminate();
    await server.stop();
    sweep(project);
  }
}

/**
 * A game the editor has stopped playing stops being reported as active.
 *
 * A run the editor plays has no handle and no pid here, so the only thing that can say whether it
 * is still up is the editor. `editor_output` asks it. `editor_status` asked it too, for
 * `playingInEditor`, and then answered `processActive` from the record alone, which for a played
 * run is true for as long as the record lasts. So one answer carried the editor saying it was
 * playing nothing beside a field saying a game was active, and a bench that had quit went on
 * reading as running for the caller polling for it to end.
 *
 * Reported downstream twice: a bench whose process was gone by a `Win32_Process` listing while the
 * server said running, and a game ended from outside that went on reading as active with an empty
 * `runtimes` beside it.
 *
 * The editor here is a socket rather than an engine, because what is under test is which source the
 * answer is taken from, and a real editor can only be asked to stop playing by stopping.
 */
async function testAGameTheEditorHasStoppedPlayingIsNotStillActive(): Promise<void> {
  const project = mkdtempSync(join(tmpdir(), 'gdharness-played-gone-'));
  const runtimeDir = mkdtempSync(join(tmpdir(), 'gdharness-played-gone-rt-'));
  const port = await reservePort();
  let editor: WebSocket | null = null;
  let playing = true;
  const server = new ServerProcess({
    env: { GDHARNESS_BRIDGE_PORT: String(port), GDHARNESS_RUNTIME_DIR: runtimeDir },
  });
  try {
    writeFileSync(
      join(project, 'project.godot'),
      '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="Played"\n',
    );
    await server.initialize('regression-test');

    const socket = new WebSocket(`ws://127.0.0.1:${port}/godot`);
    editor = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', reject);
    });
    socket.on('message', (raw: Buffer) => {
      const message: unknown = JSON.parse(String(raw));
      if (!isRecord(message) || message['type'] !== 'tool_invoke') {
        return;
      }
      const result =
        String(message['tool']) === 'playing_status'
          ? { ok: true, playing, scenePath: playing ? 'res://played.tscn' : '', debugPort: 63_411 }
          : { ok: true };
      socket.send(JSON.stringify({ type: 'tool_result', id: message['id'], success: true, result }));
    });
    socket.send(
      JSON.stringify({
        type: 'godot_ready',
        project_path: project,
        addon_version: SERVER_VERSION,
        dap_port: 63_411,
      }),
    );

    let greeted = false;
    for (let waited = 0; waited < 10_000 && !greeted; waited += 100) {
      await delay(100);
      const seen = await server.request('tools/call', { name: 'editor_status', arguments: {} });
      greeted = text(get(parseTextContent(seen), 'editor', 'projectPath')) === project;
    }
    assert.ok(greeted, 'the fake editor should have been greeted');

    // The positive: while the editor says it is playing, the run is picked up and reported active.
    // Without this the assertion below is satisfied by a server that never noticed a run at all.
    const whilePlaying = parseTextContent(
      await server.request('tools/call', { name: 'editor_status', arguments: {} }),
    );
    assert.equal(
      get(whilePlaying, 'game', 'playingInEditor', 'playing'),
      true,
      `the editor should be playing something: ${JSON.stringify(whilePlaying)}`,
    );
    assert.equal(
      get(whilePlaying, 'game', 'processActive'),
      true,
      `and that run should read as active: ${JSON.stringify(whilePlaying)}`,
    );
    // Whether it is held cannot be told: no session has been told of a stop and the game announced
    // no runtime to ask. That is the honest answer about a game that is up, and the positive for
    // the assertion below, which wants this note gone once the game is not.
    assert.equal(
      get(whilePlaying, 'game', 'heldUnknown'),
      true,
      `whether a played game with no runtime is held cannot be told while it is up: ${JSON.stringify(whilePlaying)}`,
    );
    const debugState = async (): Promise<string> =>
      textOf(await server.request('tools/call', { name: 'debug_state', arguments: { op: 'stack' } })) ?? '';
    const whileUp = await debugState();
    assert.match(
      whileUp,
      /debug adapter did not answer/,
      `while the game is up, a stack read goes to the adapter, which nothing here serves: ${whileUp}`,
    );

    // The game quits. Nothing else changes: the record is still there and still names the run.
    playing = false;
    const afterwards = parseTextContent(
      await server.request('tools/call', { name: 'editor_status', arguments: {} }),
    );
    assert.equal(
      get(afterwards, 'game', 'playingInEditor', 'playing'),
      false,
      `the editor should now say it is playing nothing: ${JSON.stringify(afterwards)}`,
    );
    assert.equal(
      get(afterwards, 'game', 'processActive'),
      false,
      `and the run should not still be reported as active: ${JSON.stringify(afterwards)}`,
    );
    // A run that is over is held nowhere, in the same answer: the hold used to be judged from the
    // record alone, so this call said the game might be sitting at a breakpoint beside the field
    // saying it was gone.
    assert.equal(
      get(afterwards, 'game', 'heldAt'),
      null,
      `and a run that is over is held nowhere: ${JSON.stringify(afterwards)}`,
    );
    assert.equal(
      get(afterwards, 'game', 'heldUnknown'),
      undefined,
      `with nothing left unknown about it: ${JSON.stringify(afterwards)}`,
    );
    // The debug tools say the same, rather than reporting the adapter of a game that has gone as
    // one that did not answer about a game the editor is playing.
    const afterGone = await debugState();
    assert.match(
      afterGone,
      /The last run has already ended, so there is no debug session/,
      `a stack read on a run the editor says is over is refused as a run that is over: ${afterGone}`,
    );

    // The same answer from the two calls that used to have their own: editor_output said running
    // about this game for the rest of the session, and editor_run wait sat out its whole budget,
    // because both read a record that no process number could ever contradict. A game the editor
    // plays and that announced no runtime is the editor's to report on, and it said it had stopped.
    const began = Date.now();
    const waited = parseTextContent(
      await server.request(
        'tools/call',
        { name: 'editor_run', arguments: { op: 'wait', timeoutMs: 20_000 } },
        30_000,
      ),
    );
    assert.equal(
      get(waited, 'running'),
      false,
      `a wait on a run the editor says is over ends at once: ${JSON.stringify(waited)}`,
    );
    assert.ok(Date.now() - began < 5000, `and does not sit out its budget: ${Date.now() - began}ms of 20000`);
    const output = parseTextContent(
      await server.request('tools/call', { name: 'editor_output', arguments: {} }),
    );
    assert.equal(get(output, 'running'), false, `and editor_output says the same: ${JSON.stringify(output)}`);
    assert.equal(
      get(output, 'endedUnwatched'),
      true,
      `as a run that ended with nobody collecting its code: ${JSON.stringify(output)}`,
    );
    const stop = async (): Promise<unknown> =>
      parseTextContent(await server.request('tools/call', { name: 'editor_run', arguments: { op: 'stop' } }));
    const afterReading = await stop();
    assert.equal(
      get(afterReading, 'exitedBeforeStop'),
      true,
      `and a stop finds it over: ${JSON.stringify(afterReading)}`,
    );

    // The editor plays again and the game goes again, and this time the stop is the first call
    // after it went: nothing has read the run, so the stop has only the editor's word to go on,
    // and it used to claim it had ended a game that had ended itself.
    playing = true;
    let pickedUp = false;
    for (let waited = 0; waited < 10_000 && !pickedUp; waited += 100) {
      await delay(100);
      const seen = parseTextContent(
        await server.request('tools/call', { name: 'editor_status', arguments: {} }),
      );
      pickedUp = get(seen, 'game', 'processActive') === true;
    }
    assert.ok(pickedUp, 'the second play should be picked up, or the stop below is about nothing');
    playing = false;
    const first = await stop();
    assert.equal(
      get(first, 'exitedBeforeStop'),
      true,
      `a stop as the first call after the editor says the game went takes the editor's word: ${JSON.stringify(first)}`,
    );
    assert.match(
      text(get(first, 'note')),
      /over before the stop, so nothing was ended here/,
      JSON.stringify(first),
    );
  } finally {
    editor?.close();
    await server.stop();
    sweep(project);
    sweep(runtimeDir);
  }
}

/**
 * A start through the editor does not sit out its announce budget on a game that died on boot.
 *
 * `testAStartStopsWaitingForAGameThatIsOver` holds this for a run this server spawned, which has
 * a process to ask. A run the editor plays has none, and the wait for its announcement read the
 * record, which says a played run is going for as long as it lasts. So a scene that died on a
 * parse error was waited for the whole budget and then reported, correctly, as no longer
 * running: the right answer, five seconds late by default and as late as `runtimeWaitMs` asks.
 * The editor is what knows, and the wait asks it the way `editor_run wait` does.
 *
 * The first start is the positive: while the editor says it is playing, the wait runs its
 * budget out and says the game may yet announce. Without it the second half is satisfied by a
 * wait that gives up on every played run at once.
 *
 * A socket for the editor and a scripted adapter, because what is under test is which source the
 * wait reads, and a real editor can only be made to play a game that dies by being given one.
 */
/** What a fixture is handed by `withAPlayingEditor`. */
interface PlayingEditorStage {
  readonly server: ServerProcess;
  readonly project: string;
  readonly runtimeDir: string;
  /** The port the scripted adapter serves, which the editor greeted the server with. */
  readonly adapter: number;
  /** One `editor_run start` through the editor, timed. */
  readonly start: (runtimeWaitMs: number) => Promise<{ answer: unknown; waitedMs: number }>;
}

/** How a fake editor answers one tool call: the result, at once or after a wait. */
type EditorToolAnswer = (tool: string) => Record<string, unknown> | Promise<Record<string, unknown>>;

/**
 * The process id the fake editor greets the server with, which its games would announce. This
 * process, because the server checks that the debug adapter port the editor names is held by the
 * editor it is talking to, and the scripted adapter is served from here.
 */
const FAKE_EDITOR_PID = process.pid;

/**
 * A server with a fake editor on its bridge and a scripted adapter that answers everything, for
 * a project with the runtime addon on disk, so a start waits for an announcement, and nothing
 * running to make one unless the fixture writes it into `runtimeDir` itself.
 *
 * The editor is a socket, because what these fixtures measure is which source an answer is taken
 * from and how long it waits, and a real editor can only be made to play a game that dies by being
 * given one. [param answer] is the editor: it is handed each tool the server invokes and its
 * result is sent back, so a fixture decides what the editor says it is playing, and when.
 *
 * The addon on disk is a stub unless [param options.realAddon] asks for the one this repository
 * ships, which is what says whether games of the project announce the editor that played them;
 * with it the addon is registered as the project's autoload too, so a real engine given the
 * project by [param options.engine] runs it and announces.
 */
async function withAPlayingEditor(
  answer: (where: Pick<PlayingEditorStage, 'adapter' | 'project' | 'runtimeDir'>) => EditorToolAnswer,
  body: (stage: PlayingEditorStage) => Promise<void>,
  options: { realAddon?: boolean; engine?: string } = {},
): Promise<void> {
  const project = mkdtempSync(join(realpathSync(tmpdir()), 'gdharness-played-over-'));
  const runtimeDir = mkdtempSync(join(realpathSync(tmpdir()), 'gdharness-played-over-rt-'));
  const port = await reservePort();
  const answerEverything: FramedPeerHandler = (message, socket) => {
    const command = String(message['command']);
    socket.write(
      frameJsonRpc({
        seq: Number(message['seq']) + 1000,
        type: 'response',
        request_seq: message['seq'],
        command,
        success: true,
        body: command === 'threads' ? { threads: [] } : {},
      }),
    );
  };
  const server = new ServerProcess({
    env: {
      GDHARNESS_BRIDGE_PORT: String(port),
      GDHARNESS_RUNTIME_DIR: runtimeDir,
      GODOT_PATH: options.engine ?? process.execPath,
      // The server's own account of a start, kept in its stderr for the fixture that fails on
      // how long one took: without it a start that sat nine seconds on a played game left
      // nothing behind to say where the time went.
      DEBUG: 'true',
    },
  });
  const editor: { socket: WebSocket | null } = { socket: null };
  try {
    await withFramedPeer(answerEverything, async (adapter) => {
      const registered =
        options.realAddon === true
          ? '\n[autoload]\n\nGdharnessRuntime="*res://addons/gdharness_runtime/runtime_autoload.gd"\n'
          : '';
      writeFileSync(
        join(project, 'project.godot'),
        '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="Played"\n' +
          `run/main_scene="res://main.tscn"\n${registered}`,
      );
      writeFileSync(join(project, 'main.tscn'), '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n');
      // The wait only happens for a project that could announce, which is one with the addon on
      // disk. A stub, unless the fixture wants the real one run by a real engine.
      const addon = join(project, 'addons', 'gdharness_runtime');
      if (options.realAddon === true) {
        cpSync(join('src', 'godot', 'addons', 'gdharness_runtime'), addon, { recursive: true });
      } else {
        mkdirSync(addon, { recursive: true });
        writeFileSync(join(addon, 'runtime_autoload.gd'), 'extends Node\n');
      }
      await server.initialize('regression-test');

      const socket = new WebSocket(`ws://127.0.0.1:${port}/godot`);
      editor.socket = socket;
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => {
          resolve();
        });
        socket.once('error', reject);
      });
      const answers = answer({ adapter, project, runtimeDir });
      socket.on('message', (raw: Buffer) => {
        const message: unknown = JSON.parse(String(raw));
        if (!isRecord(message) || message['type'] !== 'tool_invoke') {
          return;
        }
        void Promise.resolve(answers(String(message['tool']))).then((result) => {
          socket.send(JSON.stringify({ type: 'tool_result', id: message['id'], success: true, result }));
        });
      });
      socket.send(
        JSON.stringify({
          type: 'godot_ready',
          project_path: project,
          addon_version: SERVER_VERSION,
          dap_port: adapter,
          editor_pid: FAKE_EDITOR_PID,
        }),
      );
      let greeted = false;
      for (let waited = 0; waited < 10_000 && !greeted; waited += 100) {
        await delay(100);
        const seen = parseTextContent(
          await server.request('tools/call', { name: 'editor_status', arguments: {} }),
        );
        greeted = text(get(seen, 'editor', 'projectPath')) === project;
      }
      assert.ok(greeted, 'the fake editor should have been greeted, or nothing below is reached');

      // Windowed, said outright: a start on a host with no display is headless unless told
      // otherwise, and a headless start is spawned rather than played, which is a different case.
      const start = async (runtimeWaitMs: number): Promise<{ answer: unknown; waitedMs: number }> => {
        const began = Date.now();
        // The request outlives the wait it asks for, so a game that boots slowly is reported as
        // one that has not announced rather than as a request that timed out.
        const response = await server.request(
          'tools/call',
          {
            name: 'editor_run',
            arguments: { projectPath: project, op: 'start', headless: false, runtimeWaitMs },
          },
          runtimeWaitMs + 30_000,
        );
        // A refusal is plain text, and a fixture reading fields off null learns nothing from it.
        const answered = parseTextContent(response) ?? { refused: textOf(response) };
        return { answer: answered, waitedMs: Date.now() - began };
      };
      await body({ server, project, runtimeDir, adapter, start });
    });
  } finally {
    editor.socket?.terminate();
    await server.stop();
    sweep(project);
    sweep(runtimeDir);
  }
}

async function testAPlayedStartStopsWaitingForAGameThatIsOver(): Promise<void> {
  let playing = false;
  let diesOnBoot = false;
  let stops = 0;
  await withAPlayingEditor(
    ({ adapter }) =>
      (tool) => {
        if (tool === 'play_scene') {
          // Answered as the editor answers it, with the game just spawned. Whether that game is
          // still there by the time anybody asks is the variable below.
          playing = !diesOnBoot;
          return { ok: true, playing: true, scenePath: 'res://main.tscn', debugPort: adapter };
        }
        if (tool === 'stop_playing') {
          playing = false;
          stops += 1;
          return { ok: true };
        }
        if (tool === 'playing_status') {
          return { ok: true, playing, scenePath: playing ? 'res://main.tscn' : '', debugPort: adapter };
        }
        return { ok: true };
      },
    async ({ server, start }) => {
      // The editor is playing a game this server has never heard of, the way a replacement server
      // after a reconnect finds one, and the start is the first call to notice. It ends that game
      // to play its own and says so: a played run that announced no runtime has no number of any
      // kind, and the answer used to say nothing about it, as though the caller's game had stopped
      // on its own. The replacement's start said nothing either way, because it never asked the
      // editor what was playing before deciding there was nothing to end.
      playing = true;
      const going = await start(1_500);
      assert.equal(get(going.answer, 'through'), 'editor', JSON.stringify(going.answer));
      assert.equal(stops, 1, 'the start should have had the editor stop the game it was playing');
      assert.equal(
        get(going.answer, 'endedPreviousRun'),
        true,
        `and should say a run with no number was ended: ${JSON.stringify(going.answer)}`,
      );
      assert.match(
        text(get(going.answer, 'message')),
        /The game the editor was playing was ended to start this one/,
        JSON.stringify(going.answer),
      );
      assert.equal(
        get(going.answer, 'runtime', 'mayYetAnnounce'),
        true,
        `a played game the editor still reports may yet announce: ${JSON.stringify(going.answer)}`,
      );
      assert.ok(
        going.waitedMs >= 1_500,
        `and is waited for the whole budget while the editor says it is playing: ${going.waitedMs}ms of 1500`,
      );

      diesOnBoot = true;
      const over = await start(10_000);
      assert.equal(get(over.answer, 'through'), 'editor', JSON.stringify(over.answer));
      assert.equal(stops, 2, 'the start should have had the editor stop the game this server played');
      assert.equal(
        get(over.answer, 'endedPreviousRun'),
        true,
        `and should say so: ${JSON.stringify(over.answer)}`,
      );
      assert.equal(
        get(over.answer, 'runtime', 'mayYetAnnounce'),
        false,
        `a played game the editor says is over is not going to announce: ${JSON.stringify(over.answer)}`,
      );
      assert.match(
        text(get(over.answer, 'runtime', 'note')),
        /no longer running/,
        JSON.stringify(over.answer),
      );
      // Printed on every run, since the Windows leg once answered in 8930ms with nothing else in
      // the log to say where the time went: the number on the runs that pass is what that one
      // has to be read against.
      console.log(`played start over: the start answered after ${over.waitedMs}ms`);
      for (const line of server.stderr.split('\n')) {
        if (
          /announce wait ended|playing_status did not|playing_status answered after|Tool (stop_playing|play_scene)/.test(
            line,
          )
        ) {
          console.log(`played start over: ${line.trim()}`);
        }
      }
      assert.ok(
        over.waitedMs < 5_000,
        `and the answer does not wait out the budget: ${over.waitedMs}ms of 10000\nthe server said:\n${server.stderr.slice(-4000)}`,
      );
      // With an adapter that answers everything, so the refusal can only come from the editor's
      // word: attached and read, the adapter would say the game is running with no stack.
      const stack =
        textOf(await server.request('tools/call', { name: 'debug_state', arguments: { op: 'stack' } })) ?? '';
      assert.match(
        stack,
        /The last run has already ended, so there is no debug session/,
        `a stack read on the run that died is refused as a run that is over: ${stack}`,
      );
      // A start after a game that died ends nothing, and says nothing about ending one: the
      // record alone read as a run still going, so the editor was told to stop and the answer
      // reported a run ended that had ended itself.
      const afterOver = await start(1_500);
      assert.equal(get(afterOver.answer, 'through'), 'editor', JSON.stringify(afterOver.answer));
      assert.equal(stops, 2, 'a start after a game that died has nothing to have the editor stop');
      assert.equal(
        get(afterOver.answer, 'endedPreviousRun'),
        undefined,
        `and reports no run ended: ${JSON.stringify(afterOver.answer)}`,
      );
    },
  );
}

/**
 * The announce wait is not held up by an editor that is slow to say whether it is playing.
 *
 * The wait asks the editor about a played run so a game that died on boot is not waited for.
 * Asked in line with the looks for the announcement, a question the editor holds for a second
 * (an addon that does not serve it, an editor busy with something else) held the looks with it,
 * and a runtime that announced inside that second was found only when the editor let go. The
 * question is asked beside the looks, and the last answer is what each look reads.
 *
 * The editor here answers `playing_status` after 900 ms and the game announces 300 ms after the
 * play; the start has to find it well before the editor's first answer arrives.
 */
async function testTheAnnounceWaitIsNotHeldByASlowEditor(): Promise<void> {
  const answersAfterMs = 700;
  const announcesAfterMs = 300;
  // Measured from the play rather than from the call: the start asks the editor what it is playing
  // before it plays anything, and that question is held for the same 700 ms.
  let playedAt = 0;
  await withAPlayingEditor(
    ({ adapter, project, runtimeDir }) =>
      async (tool) => {
        if (tool === 'play_scene') {
          playedAt = Date.now();
          // The announcement lands a moment after the play, from a process that is alive: a dead
          // one is swept by the reader and the start would have nothing to find.
          setTimeout(() => {
            writeFileSync(
              join(runtimeDir, `runtime-${process.pid}.json`),
              JSON.stringify({
                protocol: RUNTIME_PROTOCOL,
                pid: process.pid,
                port: 51_994,
                address: '127.0.0.1',
                project: { name: 'Played', path: project },
              }),
              'utf8',
            );
          }, announcesAfterMs);
          return { ok: true, playing: true, scenePath: 'res://main.tscn', debugPort: adapter };
        }
        if (tool === 'playing_status') {
          await delay(answersAfterMs);
          return { ok: true, playing: true, scenePath: 'res://main.tscn', debugPort: adapter };
        }
        return { ok: true };
      },
    async ({ start }) => {
      const found = await start(10_000);
      const sincePlayMs = Date.now() - playedAt;
      assert.equal(get(found.answer, 'through'), 'editor', JSON.stringify(found.answer));
      assert.ok(playedAt > 0, 'the editor should have been asked to play');
      assert.equal(
        get(found.answer, 'runtime', 'listening'),
        true,
        `the announcement should have been found: ${JSON.stringify(found.answer)}`,
      );
      assert.equal(get(found.answer, 'runtime', 'pid'), process.pid, JSON.stringify(found.answer));
      assert.ok(
        sincePlayMs < answersAfterMs,
        `and found before the editor's first answer arrived: ${sincePlayMs}ms after the play, against ${answersAfterMs}ms`,
      );
    },
  );
}

/**
 * A play the editor has not started yet is not a game that has gone.
 *
 * A restarted editor plays once its scan is over: it answered the play with "not playing", went
 * on saying so for a moment, and then the game came up. Read as the editor's word on the run,
 * that said "the game is no longer running" about a game that had not yet begun, and the answer
 * was final where the truth was one more call away. Until the editor has reported the run playing
 * once, its "not playing" is the play still on its way, and the start keeps waiting for the
 * announcement. The editor here says "not playing" to the play and for 600 ms after, then plays,
 * and the game announces from a live process; the start has to find it. The other side stays:
 * the case beside this one, whose editor reported playing and then not, is still answered "gone"
 * at once.
 */
async function testAPlayTheEditorHasNotStartedIsNotAGameThatHasGone(): Promise<void> {
  const startsPlayingAfterMs = 600;
  let playedAt = 0;
  let statusAsked = 0;
  await withAPlayingEditor(
    ({ adapter, project, runtimeDir }) =>
      (tool) => {
        if (tool === 'play_scene') {
          playedAt = Date.now();
          setTimeout(() => {
            writeFileSync(
              join(runtimeDir, `runtime-${process.pid}.json`),
              JSON.stringify({
                protocol: RUNTIME_PROTOCOL,
                pid: process.pid,
                port: 51_993,
                address: '127.0.0.1',
                project: { name: 'Played', path: project },
              }),
              'utf8',
            );
          }, startsPlayingAfterMs + 200);
          // The editor's answer to the play, as a restarted one gave it: not playing yet.
          return { ok: true, playing: false, scenePath: '', debugPort: adapter };
        }
        if (tool === 'playing_status') {
          statusAsked += 1;
          const playing = playedAt > 0 && Date.now() - playedAt >= startsPlayingAfterMs;
          return { ok: true, playing, scenePath: playing ? 'res://main.tscn' : '', debugPort: adapter };
        }
        return { ok: true };
      },
    async ({ start }) => {
      const found = await start(10_000);
      assert.equal(get(found.answer, 'through'), 'editor', JSON.stringify(found.answer));
      assert.ok(statusAsked > 0, 'the editor should have been asked whether it was playing');
      assert.equal(
        get(found.answer, 'runtime', 'listening'),
        true,
        `the start waits through an editor that has not started playing yet: ${JSON.stringify(found.answer)}`,
      );
      assert.equal(get(found.answer, 'runtime', 'pid'), process.pid, JSON.stringify(found.answer));
      assert.ok(
        found.waitedMs >= startsPlayingAfterMs,
        `and the announcement it found came after the editor began: ${found.waitedMs}ms`,
      );
    },
  );
}

/**
 * A game that announces after the start's wait is tied to its run when it does.
 *
 * A game announcing inside the wait is tied there, and that number is what a played run is asked
 * of the operating system by: whether it is still there, and what it has used. One announcing
 * after the wait, a project that boots for longer than the budget, was never tied at all, so the
 * run went on being judged from the editor's word alone and `editor_output` answered cpu with
 * "nothing here has its process id" while the same call listed the game under runtimes.
 *
 * The cpu reading is the observable: absent with the note while nothing has announced, which is
 * the positive for the untied state, and a number once the announcement has landed. The process
 * announced is this one, so the number is real.
 */
async function testALateAnnouncementIsTiedToThePlayedRun(): Promise<void> {
  const announcesAfterMs = 600;
  let announcement: string | null = null;
  await withAPlayingEditor(
    ({ adapter, project, runtimeDir }) =>
      (tool) => {
        if (tool === 'play_scene') {
          announcement = join(runtimeDir, `runtime-${process.pid}.json`);
          const file = announcement;
          setTimeout(() => {
            writeFileSync(
              file,
              JSON.stringify({
                protocol: RUNTIME_PROTOCOL,
                pid: process.pid,
                port: 51_995,
                address: '127.0.0.1',
                project: { name: 'Played', path: project },
              }),
              'utf8',
            );
          }, announcesAfterMs);
          return { ok: true, playing: true, scenePath: 'res://main.tscn', debugPort: adapter };
        }
        if (tool === 'playing_status') {
          return { ok: true, playing: true, scenePath: 'res://main.tscn', debugPort: adapter };
        }
        return { ok: true };
      },
    async ({ server, start }) => {
      const started = await start(200);
      assert.equal(get(started.answer, 'through'), 'editor', JSON.stringify(started.answer));
      assert.equal(
        get(started.answer, 'runtime', 'mayYetAnnounce'),
        true,
        `the wait should have run out before the announcement: ${JSON.stringify(started.answer)}`,
      );
      const cpu = async (): Promise<unknown> =>
        parseTextContent(
          await server.request('tools/call', { name: 'editor_output', arguments: { cpu: true } }, 60_000),
        );
      const untied = await cpu();
      assert.equal(
        get(untied, 'cpuSeconds'),
        undefined,
        `nothing has announced yet: ${JSON.stringify(untied)}`,
      );
      assert.match(
        text(get(untied, 'note')),
        /the game announced no runtime, so nothing here has its process id/,
        `and the answer says why: ${JSON.stringify(untied)}`,
      );
      assert.equal(get(untied, 'pid'), null, `and names no process: ${JSON.stringify(untied)}`);

      assert.ok(
        await cameTrue(() => announcement !== null && existsSync(announcement), 5_000),
        'the announcement should have landed',
      );
      const tied = await cpu();
      assert.equal(
        get(tied, 'pid'),
        process.pid,
        `once the game has announced, the run is named by that number: ${JSON.stringify(tied)}`,
      );
      // And asked by it. The reading is best effort by design, a PowerShell start on Windows that
      // a loaded runner can hold past its budget, so what is held is that the question was put to
      // that process: a number, or the note that the platform would not answer about it.
      const cpuSeconds = get(tied, 'cpuSeconds');
      assert.ok(
        (typeof cpuSeconds === 'number' && cpuSeconds >= 0) ||
          text(get(tied, 'note')).includes('this platform would not say what the run has used'),
        `and asked by it: ${JSON.stringify(tied)}`,
      );

      // The stop names the same number. A played run has no pid here, and the stop answered null
      // under endedPid about a process the same server had been reading cpu for.
      const stopped = parseTextContent(
        await server.request('tools/call', { name: 'editor_run', arguments: { op: 'stop' } }, 60_000),
      );
      assert.equal(get(stopped, 'stopped'), true, JSON.stringify(stopped));
      assert.equal(
        get(stopped, 'endedPid'),
        process.pid,
        `the stop names the process the game announced: ${JSON.stringify(stopped)}`,
      );
      assert.equal(get(stopped, 'exitedBeforeStop'), false, JSON.stringify(stopped));
    },
  );
}

/**
 * The editor's game is told apart from another game of the same project announced beside it.
 *
 * A played run is tied to the process its game announced, and the tie went by freshness alone:
 * the one game of the project announced since the play. A game of the same project that some
 * other server started in that window is exactly as fresh, and the start took it for its own,
 * answering listening about a process it did not start while its game was still booting; the
 * tie after the wait did the same. Freshness is a property every game of the project shares, so
 * the mark is one they cannot: the editor addon puts its process id into its environment, every
 * game the editor plays inherits it, and the runtime announces it. A game announcing another
 * editor, or none where the project's addon announces one, is somebody else's.
 *
 * Two rounds, because the tie is made in two places. In the first the foreign game announces
 * first and inside the start's wait, naming no editor, and the wait has to pass over it for the
 * editor's own. In the second both announce after the wait, the foreign one naming another
 * editor, and the tie made on the next answer has to pick the editor's own. Real processes stand
 * in for the games, since an announcement of a process that is gone is swept before it is read.
 */
async function testTheEditorsGameIsToldFromAnotherOfTheSameProject(): Promise<void> {
  const games: ChildProcess[] = [];
  const aGame = (): number => {
    const game = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    games.push(game);
    assert.ok(typeof game.pid === 'number', 'the fixture needs live processes to announce');
    return game.pid;
  };
  const announce = (runtimeDir: string, project: string, pid: number, editorPid?: number): void => {
    writeFileSync(
      join(runtimeDir, `runtime-${pid}.json`),
      JSON.stringify({
        protocol: RUNTIME_PROTOCOL,
        pid,
        port: 51_996,
        address: '127.0.0.1',
        project: { name: 'Played', path: project },
        ...(editorPid === undefined ? {} : { editor_pid: editorPid }),
      }),
      'utf8',
    );
  };
  let round = 0;
  let ours = 0;
  let theirs = 0;
  try {
    await withAPlayingEditor(
      ({ adapter, project, runtimeDir }) =>
        (tool) => {
          if (tool === 'play_scene') {
            round += 1;
            theirs = aGame();
            ours = aGame();
            if (round === 1) {
              // Theirs first and unmarked, ours 300 ms later: both inside the first wait.
              announce(runtimeDir, project, theirs);
              setTimeout(() => {
                announce(runtimeDir, project, ours, FAKE_EDITOR_PID);
              }, 300);
            } else {
              // Both after the second wait, theirs naming an editor that is not this one.
              setTimeout(() => {
                announce(runtimeDir, project, theirs, FAKE_EDITOR_PID + 1);
                announce(runtimeDir, project, ours, FAKE_EDITOR_PID);
              }, 600);
            }
            return { ok: true, playing: true, scenePath: 'res://main.tscn', debugPort: adapter };
          }
          if (tool === 'playing_status') {
            return { ok: true, playing: true, scenePath: 'res://main.tscn', debugPort: adapter };
          }
          return { ok: true };
        },
      async ({ server, runtimeDir, start }) => {
        const first = await start(3_000);
        assert.equal(get(first.answer, 'through'), 'editor', JSON.stringify(first.answer));
        assert.equal(
          get(first.answer, 'runtime', 'listening'),
          true,
          `the editor's own game should have been found: ${JSON.stringify(first.answer)}`,
        );
        assert.equal(
          get(first.answer, 'runtime', 'pid'),
          ours,
          `and it is the game the editor played, not the one announced first: ${JSON.stringify(first.answer)}`,
        );

        const second = await start(200);
        assert.equal(
          get(second.answer, 'runtime', 'mayYetAnnounce'),
          true,
          `the second wait should run out before either announces: ${JSON.stringify(second.answer)}`,
        );
        assert.ok(
          await cameTrue(() => existsSync(join(runtimeDir, `runtime-${ours}.json`)), 5_000),
          'both announcements should have landed',
        );
        const output = parseTextContent(
          await server.request('tools/call', { name: 'editor_output', arguments: {} }, 60_000),
        );
        assert.equal(
          get(output, 'pid'),
          ours,
          `the run is tied to the game the editor played, not the one naming another editor: ${JSON.stringify(output)}`,
        );
      },
      { realAddon: true },
    );
  } finally {
    for (const game of games) {
      if (game.exitCode === null) {
        game.kill();
      }
    }
  }
}

/**
 * A game this server spawned beside a connected editor is still its own, though it names no editor.
 *
 * The rule that tells the editor's game from a stranger's reads an announcement naming no editor,
 * in a project whose addon announces editors, as somebody else's. That is right for a run the
 * editor plays and wrong for a run this server started: a spawned game inherited no editor to
 * name, so under the played rule a spawned start waited its whole budget on its own game and
 * answered that nothing had announced. The editor tier found it on the first run, with a real
 * engine, which is why this one runs a real engine too: the announcement has to come from the
 * addon as it is, in the environment a spawned game actually gets.
 */
async function testASpawnedGameBesideAnEditorIsStillItsOwn(): Promise<void> {
  const engine = resolveGodotPath();
  if (!engine) {
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and GODOT_PATH names no existing file.');
    }
    console.log('spawned game beside an editor regression skipped (Godot not found)');
    return;
  }
  await withAPlayingEditor(
    ({ adapter }) =>
      (tool) =>
        tool === 'playing_status'
          ? { ok: true, playing: false, scenePath: '', debugPort: adapter }
          : { ok: true },
    async ({ server, project }) => {
      const answer = parseTextContent(
        await server.request(
          'tools/call',
          {
            name: 'editor_run',
            arguments: { projectPath: project, op: 'start', headless: true, runtimeWaitMs: 20_000 },
          },
          ENGINE_CALL_TIMEOUT_MS,
        ),
      );
      try {
        assert.equal(
          get(answer, 'through'),
          'gdharness',
          `a headless start is spawned: ${JSON.stringify(answer)}`,
        );
        assert.equal(
          get(answer, 'runtime', 'listening'),
          true,
          `the spawned game's own announcement is the one waited for: ${JSON.stringify(answer)}`,
        );
        const status = parseTextContent(
          await server.request(
            'tools/call',
            { name: 'editor_status', arguments: {} },
            ENGINE_CALL_TIMEOUT_MS,
          ),
        );
        assert.equal(
          get(status, 'game', 'runtimes', 0, 'editorPid'),
          undefined,
          `and it names no editor, having been started here: ${JSON.stringify(status)}`,
        );
      } finally {
        await server.request(
          'tools/call',
          { name: 'editor_run', arguments: { op: 'stop' } },
          ENGINE_CALL_TIMEOUT_MS,
        );
      }
    },
    { realAddon: true, engine },
  );
}

/**
 * An injected mouse motion carries the distance from where the last injected event put the pointer.
 *
 * A control that drags reads the event's `relative` rather than its position, and every motion
 * sent through the bridge said it had moved by nothing, so a grip under a bridge drag stood still
 * through the whole drag. The distance from where the bridge last put the pointer is what a real
 * move would carry, and the first motion has nowhere to have come from; a relative the caller
 * gives is kept. Read off a script in the game that records what the events said, since the
 * answer's own `relative` only says what was sent.
 *
 * Windowed wherever the host has a display, because the reading that is wrong is only wrong
 * there: the root viewport answers its mouse position from the operating system's pointer, which
 * an injected event never moves, so a bridge that took its last position from the viewport
 * answered the distance from wherever the user's mouse sat, another monitor included, off by
 * thousands on a played game while a headless run, with no pointer to read, measured it right. A
 * host with no display runs it headless and holds the arithmetic alone.
 *
 * The other thing a drag reads is which buttons are down as the pointer moves, and a motion
 * between a held click and its release carried none, so a drag written as "moved with the left
 * button down" never began. The mask is what Input holds, which the injected click sets; the
 * click's own events carry it too, the pressed button in on the press and out on the release.
 */
async function testAnInjectedMotionCarriesHowFarThePointerMoved(): Promise<void> {
  const engine = resolveGodotPath();
  if (!engine) {
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and GODOT_PATH names no existing file.');
    }
    console.log('injected motion regression skipped (Godot not found)');
    return;
  }
  const headless = resolveHeadless(undefined, { platform: process.platform, variables: process.env });
  console.log(`injected motion regression runs ${headless ? 'headless: no display here' : 'windowed'}`);
  await withAPlayingEditor(
    ({ adapter }) =>
      (tool) =>
        tool === 'playing_status'
          ? { ok: true, playing: false, scenePath: '', debugPort: adapter }
          : { ok: true },
    async ({ server, project }) => {
      writeFileSync(
        join(project, 'main.gd'),
        'extends Node\n\nvar last_relative: Vector2 = Vector2.ZERO\nvar last_mask: int = 0\n' +
          'var last_button_mask: int = 0\nvar arrived: Array[Vector2] = []\n\n\n' +
          'func _input(event: InputEvent) -> void:\n' +
          '\tif event is InputEventMouseMotion:\n' +
          '\t\tvar motion: InputEventMouseMotion = event\n' +
          '\t\tlast_relative = motion.relative\n' +
          '\t\tlast_mask = motion.button_mask\n' +
          '\t\tarrived.append(motion.position)\n' +
          '\tif event is InputEventMouseButton:\n' +
          '\t\tvar button: InputEventMouseButton = event\n' +
          '\t\tlast_button_mask = button.button_mask\n',
      );
      writeFileSync(
        join(project, 'main.tscn'),
        '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n' +
          '[node name="Main" type="Node"]\nscript = ExtResource("1")\n',
      );
      const began = Date.now();
      const started = parseTextContent(
        await server.request(
          'tools/call',
          {
            name: 'editor_run',
            arguments: {
              projectPath: project,
              op: 'start',
              headless,
              // The compatibility renderer where there is a window, for the reason the opened
              // menu fixture asks for it: the window is what this needs, not the pipelines.
              ...(headless ? {} : { args: ['--rendering-method', 'gl_compatibility'] }),
              runtimeWaitMs: headless ? 60_000 : WINDOWED_BOOT_MS,
            },
          },
          WINDOWED_BOOT_MS + 30_000,
        ),
      );
      try {
        assert.equal(get(started, 'runtime', 'listening'), true, JSON.stringify(started));
        console.log(`injected motion: the engine announced after ${Date.now() - began}ms`);
        const call = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
          parseTextContent(
            await server.request('tools/call', { name, arguments: args }, ENGINE_CALL_TIMEOUT_MS),
          );
        const read = async (property: string): Promise<unknown> =>
          get(await call('runtime_inspect', { op: 'property', nodePath: '/root/Main', property }), 'value');
        const lastRelative = async (): Promise<[unknown, unknown]> => {
          const value = await read('last_relative');
          return [get(value, 'x'), get(value, 'y')];
        };
        // The first motion has nowhere to have come from, wherever the real pointer sits.
        const first = await call('runtime_input', { op: 'mouse_motion', x: 10, y: 10 });
        assert.deepEqual(
          get(first, 'relative'),
          [0, 0],
          `the first motion moves from nowhere: ${JSON.stringify(first)}`,
        );
        const moved = await call('runtime_input', { op: 'mouse_motion', x: 40, y: 30 });
        assert.deepEqual(
          get(moved, 'relative'),
          [30, 20],
          `the motion says how far the pointer moved: ${JSON.stringify(moved)}`,
        );
        await call('runtime_wait', { op: 'frames', frames: 2 });
        assert.deepEqual(await lastRelative(), [30, 20], 'and the game read the same distance off the event');
        // Both injected motions reached the game at the points they were sent to. Named by
        // position rather than counted, since a real pointer resting inside a new window is a
        // motion of its own on the Windows runner, and a count would be about that as well.
        const arrived = asArray(await read('arrived')).map((point) => [get(point, 'x'), get(point, 'y')]);
        for (const point of [
          [10, 10],
          [40, 30],
        ]) {
          assert.ok(
            arrived.some((at) => at[0] === point[0] && at[1] === point[1]),
            `the motion to ${JSON.stringify(point)} reached the game: ${JSON.stringify(arrived)}`,
          );
        }
        // A relative the caller gives is what the event carries, whatever the position says.
        const told = await call('runtime_input', {
          op: 'mouse_motion',
          x: 40,
          y: 30,
          relativeX: 5,
          relativeY: -5,
        });
        assert.deepEqual(get(told, 'relative'), [5, -5], JSON.stringify(told));
        await call('runtime_wait', { op: 'frames', frames: 2 });
        assert.deepEqual(await lastRelative(), [5, -5], 'a given relative is kept');
        // One axis given says the motion on it, and nothing on the other, rather than nothing at
        // all: the pair fallback answers zero for a missing pair, which would swallow the axis.
        const oneAxis = await call('runtime_input', { op: 'mouse_motion', x: 40, y: 30, relativeX: 7 });
        assert.deepEqual(get(oneAxis, 'relative'), [7, 0], JSON.stringify(oneAxis));
        // A motion while a button is held carries that button, as a real drag's does: a drag
        // written as "moved with the left button down" reads the mask and not the click before.
        await call('runtime_wait', { op: 'frames', frames: 2 });
        assert.equal(await read('last_mask'), 0, 'no button held, none carried');
        // Sent as fast as a caller can, with no wait between: an answer that came back before
        // the event was delivered would let the next event read the state from before it. The
        // press lands somewhere the pointer was not, since a press puts the pointer where it
        // pressed and the drag after it measures from there.
        await call('runtime_input', { op: 'mouse_click', x: 50, y: 40, pressed: true });
        const dragged = await call('runtime_input', { op: 'mouse_motion', x: 60, y: 30 });
        assert.deepEqual(
          get(dragged, 'relative'),
          [10, -10],
          `the drag measures from the press: ${JSON.stringify(dragged)}`,
        );
        await call('runtime_input', { op: 'mouse_click', x: 60, y: 30, pressed: false });
        assert.equal(await read('last_button_mask'), 0, 'the release carries the button no longer');
        assert.equal(await read('last_mask'), 1, 'the left button was held through the motion before it');
        await call('runtime_input', { op: 'mouse_click', x: 60, y: 30, pressed: true });
        assert.equal(await read('last_button_mask'), 1, 'the press carries the button it presses');
        await call('runtime_input', { op: 'mouse_click', x: 60, y: 30, pressed: false });
        await call('runtime_input', { op: 'mouse_motion', x: 80, y: 30 });
        assert.equal(await read('last_mask'), 0, 'and a motion after the release carries none');
      } finally {
        await server.request(
          'tools/call',
          { name: 'editor_run', arguments: { op: 'stop' } },
          ENGINE_CALL_TIMEOUT_MS,
        );
      }
    },
    { realAddon: true, engine },
  );
}

/**
 * A key sent to the game does not choose from a menu a click has opened; choose does.
 *
 * An OptionButton's menu opens as a window of its own, and an injected key is delivered to the
 * game's main window, so it never reaches the menu: the item under the pointer stays where it
 * was, and Enter, which presses the button that owns the menu, closes it without choosing. The
 * key op's description sends a caller to choose for this, and this is what holds the description
 * to what the engine does. A windowed run played through the fake editor, the shape downstream
 * has: a headless engine has no windows and a click there opens nothing, and a host with no
 * display cannot run one and says so. The compatibility renderer, since the window is what this
 * needs and Forward+ on the macOS runner's paravirtual device spends the first twenty seconds
 * compiling pipelines. The scene counts what the button and its menu did and logs their focus
 * and visibility events by frame, which is what separated a menu the click never opened from
 * one that opened and shut on its own; every assertion about the menu carries that account.
 */
async function testAKeyDoesNotChooseFromAnOpenedMenu(): Promise<void> {
  const engine = resolveGodotPath();
  if (!engine) {
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and GODOT_PATH names no existing file.');
    }
    console.log('opened menu regression skipped (Godot not found)');
    return;
  }
  if (resolveHeadless(undefined, { platform: process.platform, variables: process.env })) {
    console.log('opened menu regression skipped (no display for a windowed run)');
    return;
  }
  const held: { game: ChildProcess | null } = { game: null };
  const said: string[] = [];
  try {
    await withAPlayingEditor(
      ({ adapter, project, runtimeDir }) =>
        (tool) => {
          if (tool === 'play_scene') {
            // The compatibility renderer, since the window is what this needs and not the
            // renderer: Forward+ on a macOS runner's paravirtual Metal device spent twenty
            // seconds compiling its pipelines before the scene ran, with nothing said but the
            // device's name. What the engine says is kept for the next time it does not announce.
            held.game = spawn(engine, ['--path', project, '--rendering-method', 'gl_compatibility'], {
              stdio: ['ignore', 'pipe', 'pipe'],
              env: {
                ...process.env,
                GDHARNESS_RUNTIME_DIR: runtimeDir,
                GDHARNESS_EDITOR_PID: String(FAKE_EDITOR_PID),
              },
            });
            held.game.stdout?.on('data', (chunk: Buffer) => {
              said.push(String(chunk));
            });
            held.game.stderr?.on('data', (chunk: Buffer) => {
              said.push(String(chunk));
            });
            return { ok: true, playing: true, scenePath: 'res://main.tscn', debugPort: adapter };
          }
          if (tool === 'playing_status') {
            return {
              ok: true,
              playing: held.game?.exitCode === null,
              scenePath: 'res://main.tscn',
              debugPort: adapter,
            };
          }
          if (tool === 'stop_playing') {
            held.game?.kill();
            return { ok: true };
          }
          return { ok: true };
        },
      async ({ server, project, start }) => {
        // The scene counts what the button and its menu did, so a menu that reads as closed can
        // be told apart from a click that never pressed the button and from a menu that opened
        // and shut again on its own.
        writeFileSync(
          join(project, 'main.gd'),
          'extends Control\n\nvar presses: int = 0\nvar openings: int = 0\nvar closings: int = 0\n' +
            'var log: Array[String] = []\nvar focus_changed_at: int = 0\n\n\n' +
            'func _ready() -> void:\n' +
            '\tvar pick: OptionButton = $Pick\n' +
            '\tvar menu: PopupMenu = pick.get_popup()\n' +
            '\tpick.pressed.connect(func() -> void:\n\t\tpresses += 1\n\t\t_note("pressed"))\n' +
            '\tmenu.about_to_popup.connect(func() -> void:\n\t\topenings += 1\n\t\t_note("about_to_popup"))\n' +
            '\tmenu.popup_hide.connect(func() -> void:\n\t\tclosings += 1\n\t\t_note("popup_hide"))\n' +
            '\tmenu.focus_entered.connect(func() -> void: _note("menu focus_entered"))\n' +
            '\tmenu.focus_exited.connect(func() -> void: _note("menu focus_exited"))\n' +
            '\tmenu.visibility_changed.connect(func() -> void: _note("menu visible %s" % menu.visible))\n' +
            '\tget_window().focus_entered.connect(func() -> void: _focus("window focus_entered"))\n' +
            '\tget_window().focus_exited.connect(func() -> void: _focus("window focus_exited"))\n' +
            '\tget_window().size_changed.connect(func() -> void: _note("window size %s" % get_window().size))\n\n\n' +
            'func _note(what: String) -> void:\n' +
            '\tlog.append("%d %s" % [Engine.get_process_frames(), what])\n\n\n' +
            'func _focus(what: String) -> void:\n' +
            '\tfocus_changed_at = Engine.get_process_frames()\n' +
            '\t_note(what)\n\n\n' +
            'func focus_settled() -> bool:\n' +
            '\treturn get_window().has_focus() and Engine.get_process_frames() - focus_changed_at >= 30\n',
        );
        writeFileSync(
          join(project, 'main.tscn'),
          '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n' +
            '[node name="Main" type="Control"]\nanchors_preset = 15\n' +
            'anchor_right = 1.0\nanchor_bottom = 1.0\nscript = ExtResource("1")\n\n' +
            '[node name="Pick" type="OptionButton" parent="."]\noffset_left = 20.0\n' +
            'offset_top = 20.0\noffset_right = 200.0\noffset_bottom = 60.0\nselected = 0\n' +
            'item_count = 3\npopup/item_0/text = "One"\npopup/item_0/id = 0\n' +
            'popup/item_1/text = "Two"\npopup/item_1/id = 1\n' +
            'popup/item_2/text = "Three"\npopup/item_2/id = 2\n',
        );
        const started = await start(WINDOWED_BOOT_MS);
        assert.equal(
          get(started.answer, 'runtime', 'listening'),
          true,
          `${JSON.stringify(started.answer)}\nthe engine said:\n${said.join('')}`,
        );
        // Printed so the wait above can be sized to what a windowed boot takes on each leg.
        console.log(`opened menu: the windowed engine announced after ${started.waitedMs}ms`);
        const call = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
          parseTextContent(
            await server.request('tools/call', { name, arguments: args }, ENGINE_CALL_TIMEOUT_MS),
          );
        const property = async (nodePath: string, name: string): Promise<unknown> =>
          get(await call('runtime_inspect', { op: 'property', nodePath, property: name }), 'value');
        const settle = async (): Promise<unknown> => call('runtime_wait', { op: 'frames', frames: 3 });
        const account = async (): Promise<string> => {
          const counted = await Promise.all(
            ['presses', 'openings', 'closings'].map(
              async (name) => `${name} ${String(await property('/root/Main', name))}`,
            ),
          );
          const focused = await call('runtime_invoke', {
            op: 'call',
            nodePath: '/root',
            method: 'has_focus',
          });
          const noted = asArray(await property('/root/Main', 'log'))
            .map(text)
            .join('; ');
          return `${counted.join(', ')}, window focused ${JSON.stringify(get(focused, 'result'))}, noted: ${noted}`;
        };

        // The window has to be the focused one before the menu is opened, and to have been so
        // for a while. The macOS runner focuses it a frame or two after the game announces, and
        // an embedded popup closes when its window's focus moves: a menu opened on the frame
        // before that focus arrived was read as closed, with the log showing focus_entered on the
        // window, focus_exited on the menu and popup_hide on the same frame. Held for thirty
        // frames rather than read once, because the runner's focus also flickers: a window read as
        // focused lost it on frame 3 and got it back on frame 7, and the menu opened on frame 6
        // was closed by the return. A player's window is focused long before they click, so this
        // is the fixture catching up with that, not the click. Through the wait, which walks the
        // call again every frame.
        const settled = await call('runtime_wait', {
          op: 'until',
          nodePath: '/root/Main',
          property: 'focus_settled()',
          value: true,
          timeoutMs: 15_000,
        });
        assert.equal(
          get(settled, 'met'),
          true,
          `the window should have held the focus for thirty frames before anything is clicked: ${JSON.stringify(settled)}, ${await account()}`,
        );

        const clicked = await call('runtime_input', { op: 'click', nodePath: '/root/Main/Pick' });
        assert.equal(get(clicked, 'landed'), true, JSON.stringify(clicked));
        await settle();
        const menus = asArray(
          get(await call('runtime_inspect', { op: 'find', className: 'PopupMenu' }), 'nodes'),
        );
        assert.equal(menus.length, 1, 'the button owns one menu');
        const menu = text(get(menus[0], 'path'));
        assert.equal(
          await property(menu, 'visible'),
          true,
          `the click opened the menu: ${await account()}, click ${JSON.stringify(clicked)}`,
        );
        // Printed on a pass too, so a leg where it fails has a working leg's reading beside it.
        console.log(`opened menu: after the click, ${await account()}`);

        await call('runtime_input', { op: 'key', keycode: 'Down' });
        await settle();
        assert.equal(
          await property(menu, 'visible'),
          true,
          `an arrow key leaves the menu open: ${await account()}`,
        );
        await call('runtime_input', { op: 'key', keycode: 'Enter' });
        await settle();
        assert.equal(await property(menu, 'visible'), false, `Enter closes it: ${await account()}`);
        assert.equal(await property('/root/Main/Pick', 'selected'), 0, 'having chosen nothing');

        const chosen = await call('runtime_input', { op: 'choose', nodePath: '/root/Main/Pick', index: 2 });
        assert.equal(get(chosen, 'type'), 'chosen', JSON.stringify(chosen));
        await settle();
        assert.equal(await property('/root/Main/Pick', 'selected'), 2, 'choose is what selects');
        assert.equal(await property('/root/Main/Pick', 'text'), 'Three', 'and the button shows it');

        await server.request(
          'tools/call',
          { name: 'editor_run', arguments: { op: 'stop' } },
          ENGINE_CALL_TIMEOUT_MS,
        );
      },
      { realAddon: true, engine },
    );
  } finally {
    if (held.game?.exitCode === null) {
      held.game.kill();
    }
  }
}

/**
 * A find by className reaches the nodes whose script extends that class, at any distance.
 *
 * `className Card` answered 0 over a tree of rows whose scripts extend Card two steps down,
 * IntakeRow extends DocketCard extends Card: the match read the script's own class_name alone,
 * while a native class reaches every subclass through `is_class`. A caller naming a class means
 * what extends it, the way a typed `is` reads it, whichever side of the line the class is declared
 * on. Under the engine, since the matching is the addon's; the scripts extend by path so the
 * fixture does not depend on the class cache an editor would have written.
 */
async function testAFindByClassReachesWhatExtendsIt(): Promise<void> {
  const engine = resolveGodotPath();
  if (!engine) {
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and GODOT_PATH names no existing file.');
    }
    console.log('find by class regression skipped (Godot not found)');
    return;
  }
  await withAPlayingEditor(
    ({ adapter }) =>
      (tool) =>
        tool === 'playing_status'
          ? { ok: true, playing: false, scenePath: '', debugPort: adapter }
          : { ok: true },
    async ({ server, project }) => {
      writeFileSync(join(project, 'card.gd'), 'class_name Card\nextends Node\n');
      writeFileSync(join(project, 'docket_card.gd'), 'class_name DocketCard\nextends "res://card.gd"\n');
      writeFileSync(join(project, 'intake_row.gd'), 'class_name IntakeRow\nextends "res://docket_card.gd"\n');
      writeFileSync(
        join(project, 'main.tscn'),
        '[gd_scene load_steps=4 format=3]\n\n' +
          '[ext_resource type="Script" path="res://card.gd" id="1"]\n' +
          '[ext_resource type="Script" path="res://docket_card.gd" id="2"]\n' +
          '[ext_resource type="Script" path="res://intake_row.gd" id="3"]\n\n' +
          '[node name="Main" type="Node"]\n\n' +
          '[node name="Plain" type="Node" parent="."]\nscript = ExtResource("1")\n\n' +
          '[node name="Docket" type="Node" parent="."]\nscript = ExtResource("2")\n\n' +
          '[node name="Intake" type="Node" parent="."]\nscript = ExtResource("3")\n\n' +
          '[node name="Buy" type="Button" parent="."]\ntext = "Buy"\n',
      );
      const started = parseTextContent(
        await server.request(
          'tools/call',
          {
            name: 'editor_run',
            arguments: { projectPath: project, op: 'start', headless: true, runtimeWaitMs: 20_000 },
          },
          ENGINE_CALL_TIMEOUT_MS,
        ),
      );
      try {
        assert.equal(get(started, 'runtime', 'listening'), true, JSON.stringify(started));
        const found = async (className: string): Promise<string[]> =>
          asArray(
            get(
              parseTextContent(
                await server.request(
                  'tools/call',
                  { name: 'runtime_inspect', arguments: { op: 'find', className } },
                  ENGINE_CALL_TIMEOUT_MS,
                ),
              ),
              'nodes',
            ),
          )
            .map((node) => text(get(node, 'path')))
            .sort();
        assert.deepEqual(
          await found('Card'),
          ['/root/Main/Docket', '/root/Main/Intake', '/root/Main/Plain'],
          'the base script class reaches everything that extends it',
        );
        assert.deepEqual(
          await found('DocketCard'),
          ['/root/Main/Docket', '/root/Main/Intake'],
          'a class in the middle reaches itself and what extends it',
        );
        assert.deepEqual(await found('IntakeRow'), ['/root/Main/Intake'], 'the leaf reaches itself alone');
        assert.deepEqual(
          await found('BaseButton'),
          ['/root/Main/Buy'],
          'and a native class still reaches its subclasses, as before',
        );
      } finally {
        await server.request(
          'tools/call',
          { name: 'editor_run', arguments: { op: 'stop' } },
          ENGINE_CALL_TIMEOUT_MS,
        );
      }
    },
    { realAddon: true, engine },
  );
}

/**
 * A line break written as a backslash and an n finds a label with the break in it.
 *
 * A button with two lines on it was asked for by `runtime_inspect find` with `says` carrying the
 * break as the two characters, the way it is typed into a JSON string one escape short, and was
 * answered as not there: 0 found, which reads as a control that is not on the screen. Nothing on a
 * screen says a backslash and an n, so the two characters mean the break. The same words on a
 * `runtime_wait until` are met rather than timed out. Under the engine, since the matching is the
 * addon's.
 */
async function testAWrittenLineBreakMatchesATwoLineLabel(): Promise<void> {
  const engine = resolveGodotPath();
  if (!engine) {
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and GODOT_PATH names no existing file.');
    }
    console.log('written line break regression skipped (Godot not found)');
    return;
  }
  await withAPlayingEditor(
    ({ adapter }) =>
      (tool) =>
        tool === 'playing_status'
          ? { ok: true, playing: false, scenePath: '', debugPort: adapter }
          : { ok: true },
    async ({ server, project }) => {
      writeFileSync(
        join(project, 'main.tscn'),
        '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n\n' +
          '[node name="Ward" type="Button" parent="."]\ntext = "WARD\\nshields 3"\n',
      );
      const started = parseTextContent(
        await server.request(
          'tools/call',
          {
            name: 'editor_run',
            arguments: { projectPath: project, op: 'start', headless: true, runtimeWaitMs: 20_000 },
          },
          ENGINE_CALL_TIMEOUT_MS,
        ),
      );
      try {
        assert.equal(get(started, 'runtime', 'listening'), true, JSON.stringify(started));
        const call = async (name: string, args: Record<string, unknown>): Promise<unknown> =>
          parseTextContent(
            await server.request('tools/call', { name, arguments: args }, ENGINE_CALL_TIMEOUT_MS),
          );
        // The two characters, which is what a caller writing the break one escape short sends.
        const written = await call('runtime_inspect', { op: 'find', says: 'WARD\\nshields 3' });
        assert.equal(
          asArray(get(written, 'nodes'))
            .map((node) => text(get(node, 'path')))
            .join(','),
          '/root/Main/Ward',
          `the break written as two characters finds the two-line button: ${JSON.stringify(written)}`,
        );
        // And the break itself, which the two characters are read as.
        const broken = await call('runtime_inspect', { op: 'find', says: 'WARD\nshields 3' });
        assert.equal(
          asArray(get(broken, 'nodes'))
            .map((node) => text(get(node, 'path')))
            .join(','),
          '/root/Main/Ward',
          `and so does the break itself: ${JSON.stringify(broken)}`,
        );
        const waited = await call('runtime_wait', {
          op: 'until',
          nodePath: '/root/Main',
          says: 'ward\\nSHIELDS',
          timeoutMs: 2_000,
        });
        assert.equal(get(waited, 'met'), true, `a wait on the same words is met: ${JSON.stringify(waited)}`);
        const absent = await call('runtime_inspect', { op: 'find', says: 'WARD\\nshields 4' });
        assert.deepEqual(
          asArray(get(absent, 'nodes')),
          [],
          `words the button does not say are still not found: ${JSON.stringify(absent)}`,
        );
      } finally {
        await server.request(
          'tools/call',
          { name: 'editor_run', arguments: { op: 'stop' } },
          ENGINE_CALL_TIMEOUT_MS,
        );
      }
    },
    { realAddon: true, engine },
  );
}

/**
 * What a game the editor plays reports reaches editor_output and the transcript.
 *
 * The editor's game prints to the editor's own stderr, which nobody reads, and the debug adapter
 * relays what the game prints and not what it reports: a `push_error` raised in one reached
 * neither `editor_output` nor the transcript, and a run whose game had just refused something
 * out loud was answered `clean: true`. Every clean verdict a project had read off a played run
 * was in question. The runtime addon now takes the report where it is made, with a Logger in the
 * game, and the server reads it beside the announcement.
 *
 * A real engine stands in for the editor's game: the fake editor starts it on `play_scene` with
 * the editor's mark in its environment, the way a real editor's game inherits it, so the addon
 * announces the editor and writes the report. One error and one warning at boot, and an error
 * raised later through a runtime call, so the report is read both on the first look and after.
 */
async function testAPlayedGamesReportsReachTheOutput(): Promise<void> {
  const engine = resolveGodotPath();
  if (!engine) {
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and GODOT_PATH names no existing file.');
    }
    console.log('played game reports regression skipped (Godot not found)');
    return;
  }
  const held: { game: ChildProcess | null } = { game: null };
  try {
    await withAPlayingEditor(
      ({ adapter, project, runtimeDir }) =>
        (tool) => {
          if (tool === 'play_scene') {
            held.game = spawn(engine, ['--headless', '--path', project], {
              stdio: 'ignore',
              env: {
                ...process.env,
                GDHARNESS_RUNTIME_DIR: runtimeDir,
                GDHARNESS_EDITOR_PID: String(FAKE_EDITOR_PID),
              },
            });
            return { ok: true, playing: true, scenePath: 'res://main.tscn', debugPort: adapter };
          }
          if (tool === 'playing_status') {
            return {
              ok: true,
              playing: held.game?.exitCode === null,
              scenePath: 'res://main.tscn',
              debugPort: adapter,
            };
          }
          if (tool === 'stop_playing') {
            held.game?.kill();
            return { ok: true };
          }
          return { ok: true };
        },
      async ({ server, project, start }) => {
        writeFileSync(
          join(project, 'main.gd'),
          'extends Node\n\n\nfunc _ready() -> void:\n' +
            '\tpush_error("clock: 7.5 is not one of the speeds on offer")\n' +
            '\tpush_warning("the ladder has five rungs")\n\n\n' +
            'func refuse(value: float) -> void:\n' +
            '\tpush_error("refused %s at runtime" % value)\n',
        );
        writeFileSync(
          join(project, 'main.tscn'),
          '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n' +
            '[node name="Main" type="Node"]\nscript = ExtResource("1")\n',
        );
        const started = await start(20_000);
        assert.equal(get(started.answer, 'through'), 'editor', JSON.stringify(started.answer));
        assert.equal(get(started.answer, 'runtime', 'listening'), true, JSON.stringify(started.answer));

        const output = async (args: Record<string, unknown>): Promise<unknown> =>
          parseTextContent(
            await server.request(
              'tools/call',
              { name: 'editor_output', arguments: args },
              ENGINE_CALL_TIMEOUT_MS,
            ),
          );
        const lines = (answer: unknown): string[] =>
          asArray(get(answer, 'entries')).map(
            (entry) => `${text(get(entry, 'severity'))}: ${text(get(entry, 'text'))}`,
          );
        // The boot's error and warning, with the engine's own `at:` line under the headline. Given a
        // moment to arrive: the runtime autoload announces in its own _ready and the main scene
        // reports in its, a frame later, so a read the instant the start answers can come before
        // the report is written, which it did once on macOS. What is held is that it arrives. Both
        // halves of it: the two are written as two lines, and a read between them has the error
        // and not yet the warning, which it did once on macOS as well.
        const deadline = Date.now() + 10_000;
        let first = await output({});
        while (
          (asNumber(get(first, 'errors')) === 0 || asNumber(get(first, 'warnings')) === 0) &&
          Date.now() < deadline
        ) {
          await delay(200);
          first = await output({});
        }
        assert.equal(
          get(first, 'clean'),
          false,
          `a run that reported an error is not clean: ${JSON.stringify(first)}`,
        );
        assert.equal(get(first, 'errors'), 1, JSON.stringify(lines(first)));
        assert.equal(get(first, 'warnings'), 1, JSON.stringify(lines(first)));
        assert.ok(
          lines(first).includes('error: clock: 7.5 is not one of the speeds on offer'),
          `the push_error is an error entry: ${JSON.stringify(lines(first))}`,
        );
        assert.ok(
          lines(first).includes('warning: the ladder has five rungs'),
          `and the push_warning a warning entry: ${JSON.stringify(lines(first))}`,
        );
        const errorEntry = asArray(get(first, 'entries')).find(
          (entry) => text(get(entry, 'text')) === 'clock: 7.5 is not one of the speeds on offer',
        );
        assert.match(
          asArray(get(errorEntry, 'detail')).map(text).join('\n'),
          /at: push_error/,
          `with where it was raised under it: ${JSON.stringify(errorEntry)}`,
        );
        const transcript = text(get(first, 'transcript'));
        assert.match(
          readFileSync(transcript, 'utf8'),
          /^ERROR: clock: 7\.5 is not one of the speeds on offer$/m,
          "and the transcript carries the report in the engine's own line",
        );

        // An error raised later, through a runtime call, is in the next read and nothing is read
        // twice.
        const refused = parseTextContent(
          await server.request(
            'tools/call',
            {
              name: 'runtime_invoke',
              arguments: { op: 'call', nodePath: '/root/Main', method: 'refuse', args: [7.5] },
            },
            ENGINE_CALL_TIMEOUT_MS,
          ),
        );
        assert.ok(refused !== null, 'the call reaches the game');
        const since = await output({ severity: 'error', sinceLastCall: true });
        assert.deepEqual(
          lines(since),
          ['error: refused 7.5 at runtime'],
          `only the new error, at error severity: ${JSON.stringify(lines(since))}`,
        );
        assert.equal(get(since, 'errors'), 2, JSON.stringify(since));
        assert.equal(get(since, 'clean'), false, JSON.stringify(since));
        const again = await output({ severity: 'error', sinceLastCall: true });
        assert.deepEqual(lines(again), [], `and nothing is reported twice: ${JSON.stringify(lines(again))}`);

        await server.request(
          'tools/call',
          { name: 'editor_run', arguments: { op: 'stop' } },
          ENGINE_CALL_TIMEOUT_MS,
        );
      },
      { realAddon: true, engine },
    );
  } finally {
    if (held.game?.exitCode === null) {
      held.game.kill();
    }
  }
}

/**
 * A stop with andChildren ends a worker a real game opened with OS.create_process.
 *
 * The regression beside this one measures the mechanism with Node processes standing in for the
 * games. This is the shape downstream actually has, under the engine: a bench scene that opens a
 * worker with `OS.create_process`, which opens a helper of its own, all three announcing through
 * the runtime addon as games of the project, the bench started headless by this server. The stop
 * has to list the worker and the helper under the bench by asking the operating system, end them,
 * and name them, and their announcements have to be gone afterwards because the processes are.
 *
 * Run under every shape of engine the machine has. The Windows console build is a wrapper that
 * starts the engine as its child, so the process this server holds is not the game, the game
 * announces a number the handle does not have, and the worker is the handle's grandchild: a
 * listing one level deep found the game and took it for a worker, and found no worker at all. The
 * archive the installer unpacks carries both builds, so the sibling is run when it is there.
 *
 * And twice under each: with the bench announcing inside the start's wait, which ties the run to
 * its game there, and with the wait too short for that, so that by the time anything asks, the
 * bench and its worker have both announced and neither is fresher than the other. Under the
 * wrapper that is the case only the process tree can decide, and the case a bench that boots
 * slowly puts every stop in.
 */
async function testARealBenchTakesItsWorkerWithIt(): Promise<void> {
  const engine = resolveGodotPath();
  if (!engine) {
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and GODOT_PATH names no existing file.');
    }
    console.log('real bench and worker regression skipped (Godot not found)');
    return;
  }
  for (const each of engineShapes(engine)) {
    for (const tiedAtStart of [true, false]) {
      await aRealBenchTakesItsWorkerWithIt(each, tiedAtStart);
    }
  }
}

/**
 * [param engine] and, on Windows, the console build beside it when there is one: a wrapper that
 * starts the engine as its child, which the installer's archive carries next to the other build.
 */
function engineShapes(engine: string): string[] {
  const consoleSibling = engine.replace(/(_console)?\.exe$/i, '_console.exe');
  return process.platform === 'win32' && consoleSibling !== engine && existsSync(consoleSibling)
    ? [engine, consoleSibling]
    : [engine];
}

async function aRealBenchTakesItsWorkerWithIt(engine: string, tiedAtStart: boolean): Promise<void> {
  const shape = `${basename(engine)}, ${tiedAtStart ? 'tied at the start' : 'announced after the start'}`;
  await withAPlayingEditor(
    ({ adapter }) =>
      (tool) =>
        tool === 'playing_status'
          ? { ok: true, playing: false, scenePath: '', debugPort: adapter }
          : { ok: true },
    async ({ server, project, runtimeDir }) => {
      // The bench works, every frame, so that its processor time is a number that separates it
      // from a wrapper standing in front of it.
      writeFileSync(
        join(project, 'bench.gd'),
        'extends Node\n\n\nfunc _ready() -> void:\n' +
          '\tvar worker := OS.create_process(\n' +
          '\t\tOS.get_executable_path(),\n' +
          '\t\t["--headless", "--path", ProjectSettings.globalize_path("res://"), "res://worker.tscn"]\n' +
          '\t)\n' +
          '\tprint("worker %d" % worker)\n\n\n' +
          'func _process(_delta: float) -> void:\n' +
          '\tvar until := Time.get_ticks_msec() + 12\n' +
          '\twhile Time.get_ticks_msec() < until:\n' +
          '\t\tpass\n',
      );
      writeFileSync(
        join(project, 'main.tscn'),
        '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://bench.gd" id="1"]\n\n' +
          '[node name="Bench" type="Node"]\nscript = ExtResource("1")\n',
      );
      // The worker opens a helper of its own, so the stop has a process two levels down to find:
      // one level would end the worker and leave the helper, and under the wrapper the helper is
      // three levels below the handle. Its pid goes into a file, since what a process opened with
      // OS.create_process prints reaches no transcript.
      writeFileSync(
        join(project, 'worker.gd'),
        'extends Node\n\n\nfunc _ready() -> void:\n' +
          '\tif "--leaf" in OS.get_cmdline_user_args():\n' +
          '\t\treturn\n' +
          '\tvar helper := OS.create_process(\n' +
          '\t\tOS.get_executable_path(),\n' +
          '\t\t["--headless", "--path", ProjectSettings.globalize_path("res://"), "res://worker.tscn", "--", "--leaf"]\n' +
          '\t)\n' +
          '\tvar note := FileAccess.open(ProjectSettings.globalize_path("res://helper.pid"), FileAccess.WRITE)\n' +
          '\tnote.store_string(str(helper))\n' +
          '\tnote.close()\n',
      );
      writeFileSync(
        join(project, 'worker.tscn'),
        '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://worker.gd" id="1"]\n\n' +
          '[node name="Worker" type="Node"]\nscript = ExtResource("1")\n',
      );

      const status = async (): Promise<unknown> =>
        parseTextContent(
          await server.request(
            'tools/call',
            { name: 'editor_status', arguments: {} },
            ENGINE_CALL_TIMEOUT_MS,
          ),
        );
      const startResponse = await server.request(
        'tools/call',
        {
          name: 'editor_run',
          arguments: {
            projectPath: project,
            op: 'start',
            headless: true,
            runtimeWaitMs: tiedAtStart ? 20_000 : 1,
          },
        },
        ENGINE_CALL_TIMEOUT_MS,
      );
      const started = parseTextContent(startResponse) ?? { refused: textOf(startResponse) };
      let workerPid = 0;
      let helperPid = 0;
      try {
        assert.equal(
          get(started, 'runtime', 'listening'),
          tiedAtStart,
          `${shape}: ${JSON.stringify(started)}`,
        );
        const benchPid = asNumber(get(started, 'pid'), 'the spawned bench has a pid');
        // The worker announces on its own boot, a moment after the bench's, and the helper after
        // that. Waited for on disk rather than through the server, because a status call in the
        // moment between the announcements would tie the run to the one game announced, and the
        // second shape is about the stop that finds several.
        const announcedFiles = (): string[] =>
          readdirSync(runtimeDir).filter((entry) => /^runtime-\d+\.json$/.test(entry));
        assert.ok(
          await cameTrue(() => announcedFiles().length === 3, 30_000),
          `${shape}: the bench, its worker and the helper should all announce: ${JSON.stringify(announcedFiles())}`,
        );
        const helperNote = join(project, 'helper.pid');
        assert.ok(
          await cameTrue(() => existsSync(helperNote), 5_000),
          `${shape}: the worker wrote the helper's pid`,
        );
        helperPid = Number(readFileSync(helperNote, 'utf8').trim());
        assert.ok(
          helperPid > 0,
          `${shape}: the helper's pid is a number: ${readFileSync(helperNote, 'utf8')}`,
        );
        const running = asArray(get(await status(), 'game', 'runtimes'));
        assert.equal(running.length, 3, `${shape}: ${JSON.stringify(running)}`);
        // Which of the two is the worker is what the bench printed, not the one that is not the
        // handle: under the Windows console build the handle is a wrapper and neither is it.
        const printed = parseTextContent(
          await server.request(
            'tools/call',
            { name: 'editor_output', arguments: {} },
            ENGINE_CALL_TIMEOUT_MS,
          ),
        );
        const printedAt = Date.now();
        const workerLine = asArray(get(printed, 'entries'))
          .map((entry) => /^worker (\d+)$/.exec(text(get(entry, 'text')).trim()))
          .find((match) => match !== null);
        assert.ok(workerLine, `${shape}: the bench printed the worker's pid: ${JSON.stringify(printed)}`);
        workerPid = Number(workerLine[1]);
        assert.ok(
          running.some((one) => asNumber(get(one, 'pid')) === workerPid),
          `${shape}: the worker the bench printed is one of the announced games: ${JSON.stringify(running)}`,
        );
        assert.ok(
          running.some((one) => asNumber(get(one, 'pid')) === helperPid),
          `${shape}: and so is the helper the worker opened: ${JSON.stringify(running)}`,
        );
        const benchGame = running
          .map((one) => asNumber(get(one, 'pid')))
          .find((pid) => pid !== workerPid && pid !== helperPid);
        assert.ok(benchGame !== undefined, `${shape}: the remaining announced game is the bench`);

        // A call naming no game reaches the bench, not its worker, and says so: with three games
        // of the project announced and the run tied to none yet, this is the tree's answer.
        const inspected = parseTextContent(
          await server.request(
            'tools/call',
            { name: 'runtime_inspect', arguments: { op: 'tree', nodePath: '/root' } },
            ENGINE_CALL_TIMEOUT_MS,
          ),
        );
        assert.equal(
          get(inspected, 'answeredBy'),
          benchGame,
          `${shape}: a call naming no pid reaches the bench: ${JSON.stringify(inspected)}`,
        );
        assert.match(JSON.stringify(inspected), /"Bench"/, `${shape}: and it is the bench's tree`);
        assert.doesNotMatch(JSON.stringify(inspected), /"Worker"/, `${shape}: not the worker's`);

        // Processor time is the bench's, which has been working every frame since it started,
        // and not a wrapper's, which does nothing and would read as a bench standing still. The
        // number when the platform gives one, or its note when it would not, since a loaded
        // Windows runner holds the ask past its budget. Two seconds in, so that a bench sharing
        // a runner with its own worker and helper has had a quarter of a core's worth to show.
        await delay(Math.max(0, 2_000 - asNumber(get(printed, 'elapsedMs')) - (Date.now() - printedAt)));
        const measured = parseTextContent(
          await server.request(
            'tools/call',
            { name: 'editor_output', arguments: { cpu: true } },
            ENGINE_CALL_TIMEOUT_MS,
          ),
        );
        const cpuSeconds = get(measured, 'cpuSeconds');
        if (cpuSeconds === undefined) {
          assert.match(
            text(get(measured, 'note')),
            /cpu was asked for and this platform would not say/,
            `${shape}: no number and no note: ${JSON.stringify(measured)}`,
          );
        } else {
          assert.ok(
            asNumber(cpuSeconds) >= 0.5,
            `${shape}: the bench has been working since it started, and the reading says so: ${JSON.stringify(measured)}`,
          );
        }

        const stopped = parseTextContent(
          await server.request(
            'tools/call',
            { name: 'editor_run', arguments: { op: 'stop', andChildren: true } },
            ENGINE_CALL_TIMEOUT_MS,
          ),
        );
        assert.equal(get(stopped, 'endedPid'), benchPid, `${shape}: ${JSON.stringify(stopped)}`);
        assert.deepEqual(
          get(stopped, 'endedChildren'),
          [workerPid, helperPid].sort((a, b) => a - b),
          `${shape}: the worker the bench opened and the helper the worker opened are ended with it: ${JSON.stringify(stopped)}`,
        );
        assert.equal(get(stopped, 'childrenLeft'), undefined, `${shape}: ${JSON.stringify(stopped)}`);
        assert.ok(
          await cameTrue(() => !alive(workerPid) && !alive(helperPid), 10_000),
          `${shape}: and both processes are gone`,
        );
        // Given a moment, since the stop signals and answers without waiting for the exit, and a
        // process that has been signalled is read as alive until the operating system is done
        // with it.
        const deadline = Date.now() + 10_000;
        let afterwards = asArray(get(await status(), 'game', 'runtimes'));
        while (afterwards.length > 0 && Date.now() < deadline) {
          await delay(250);
          afterwards = asArray(get(await status(), 'game', 'runtimes'));
        }
        assert.deepEqual(
          afterwards,
          [],
          `${shape}: nothing of the project is announced afterwards: ${JSON.stringify(afterwards)}`,
        );
      } finally {
        for (const pid of [workerPid, helperPid]) {
          if (pid > 0 && alive(pid)) {
            try {
              process.kill(pid);
            } catch {
              // Gone already.
            }
          }
        }
        await server.request(
          'tools/call',
          { name: 'editor_run', arguments: { op: 'stop' } },
          ENGINE_CALL_TIMEOUT_MS,
        );
      }
    },
    { realAddon: true, engine },
  );
}

/**
 * A stop with andChildren ends the workers of a bench that announce nothing.
 *
 * A project that keeps the runtime out of its benches on purpose, so that thirty-one workers do
 * not each bind a port, has workers that are never "announced as a game of this project", and
 * `andChildren` ended none of them: thirty engines named under childrenLeft as things that could
 * not be told apart, twice in a row, with the note saying so. They can be: each is the project's
 * own engine run with `--path` on the project, which its command line says. Here the project has
 * no runtime addon at all, the bench opens two workers and one process that is not an engine,
 * and the stop ends the two, names what identified each, and leaves the third named.
 *
 * Under every shape of engine the machine has, since under the console wrapper the workers'
 * executable is the engine's and not the handle's.
 */
async function testAStopEndsTheProjectsUnannouncedWorkers(): Promise<void> {
  const engine = resolveGodotPath();
  if (!engine) {
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and GODOT_PATH names no existing file.');
    }
    console.log('unannounced workers regression skipped (Godot not found)');
    return;
  }
  for (const each of engineShapes(engine)) {
    await aStopEndsTheProjectsUnannouncedWorkers(each);
  }
}

async function aStopEndsTheProjectsUnannouncedWorkers(engine: string): Promise<void> {
  const shape = basename(engine);
  await withAPlayingEditor(
    ({ adapter }) =>
      (tool) =>
        tool === 'playing_status'
          ? { ok: true, playing: false, scenePath: '', debugPort: adapter }
          : { ok: true },
    async ({ server, project }) => {
      // No runtime addon anywhere in the project, so nothing here can announce and the start
      // does not wait for it.
      rmSync(join(project, 'addons'), { recursive: true, force: true });
      // A third child that is not an engine, so that the answer has something to leave: this
      // process's own executable running a script that sleeps, given the project's `--path` as an
      // argument of its own, so that the path alone does not make it the project's engine. A
      // script file rather than `-e`, since `-e` is also how an editor is asked for.
      const bystander = process.execPath.replaceAll('\\', '/');
      writeFileSync(join(project, 'bystander.js'), 'setInterval(() => {}, 1000);\n');
      writeFileSync(
        join(project, 'bench.gd'),
        'extends Node\n\n\nfunc _ready() -> void:\n' +
          '\tfor i: int in 2:\n' +
          '\t\tvar worker := OS.create_process(\n' +
          '\t\t\tOS.get_executable_path(),\n' +
          '\t\t\t["--headless", "--path", ProjectSettings.globalize_path("res://"), "res://worker.tscn"]\n' +
          '\t\t)\n' +
          '\t\tprint("worker %d" % worker)\n' +
          `\tvar other := OS.create_process("${bystander}", [ProjectSettings.globalize_path("res://bystander.js"), "--path", ProjectSettings.globalize_path("res://")])\n` +
          '\tprint("other %d" % other)\n',
      );
      writeFileSync(
        join(project, 'main.tscn'),
        '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://bench.gd" id="1"]\n\n' +
          '[node name="Bench" type="Node"]\nscript = ExtResource("1")\n',
      );
      writeFileSync(
        join(project, 'worker.tscn'),
        '[gd_scene format=3]\n\n[node name="Worker" type="Node"]\n',
      );

      const startResponse = await server.request(
        'tools/call',
        { name: 'editor_run', arguments: { projectPath: project, op: 'start', headless: true } },
        ENGINE_CALL_TIMEOUT_MS,
      );
      const started = parseTextContent(startResponse) ?? { refused: textOf(startResponse) };
      const workers: number[] = [];
      let other = 0;
      try {
        assert.equal(
          get(started, 'runtime', 'mayYetAnnounce'),
          false,
          `${shape}: ${JSON.stringify(started)}`,
        );
        const benchPid = asNumber(get(started, 'pid'), 'the spawned bench has a pid');
        const printed = async (): Promise<string[]> =>
          asArray(
            get(
              parseTextContent(
                await server.request(
                  'tools/call',
                  { name: 'editor_output', arguments: {} },
                  ENGINE_CALL_TIMEOUT_MS,
                ),
              ),
              'entries',
            ),
          ).map((entry) => text(get(entry, 'text')).trim());
        const deadline = Date.now() + 30_000;
        let lines = await printed();
        while (!lines.some((line) => /^other \d+$/.test(line)) && Date.now() < deadline) {
          await delay(250);
          lines = await printed();
        }
        assert.ok(
          lines.some((line) => /^other \d+$/.test(line)),
          `${shape}: the bench prints what it opened: ${JSON.stringify(lines)}`,
        );
        for (const line of lines) {
          const worker = /^worker (\d+)$/.exec(line);
          if (worker) workers.push(Number(worker[1]));
          const bystanding = /^other (\d+)$/.exec(line);
          if (bystanding) other = Number(bystanding[1]);
        }
        workers.sort((a, b) => a - b);
        assert.equal(workers.length, 2, `${shape}: two workers: ${JSON.stringify(lines)}`);
        assert.ok(other > 0 && workers.every((pid) => pid > 0), `${shape}: every pid is a number`);
        assert.ok(
          await cameTrue(() => workers.every(alive) && alive(other), 5_000),
          `${shape}: all three are up before the stop`,
        );
        // Read while everything lives, to say afterwards what each process named was.
        const table = await processTree();
        assert.ok(table !== undefined, `${shape}: the platform lists its processes`);
        const executableOf = (pid: number): string =>
          readCommandLine(table.get(pid)?.command ?? '').executable;

        const stopped = parseTextContent(
          await server.request(
            'tools/call',
            { name: 'editor_run', arguments: { op: 'stop', andChildren: true } },
            ENGINE_CALL_TIMEOUT_MS,
          ),
        );
        assert.equal(get(stopped, 'endedPid'), benchPid, `${shape}: ${JSON.stringify(stopped)}`);
        assert.deepEqual(
          get(stopped, 'endedChildren'),
          workers,
          `${shape}: both workers are ended, announced or not: ${JSON.stringify(stopped)}`,
        );
        for (const worker of workers) {
          assert.match(
            text(get(stopped, 'identifiedBy', String(worker))),
            /run with --path .*, this project's engine on this project/,
            `${shape}: and what identified ${worker} is said: ${JSON.stringify(stopped)}`,
          );
        }
        // Named among what is left, rather than the whole of it: on Windows a console process
        // opened from a game brings a conhost of its own, which is a child of the run too.
        const left = asArray(get(stopped, 'childrenLeft')).map((pid) => asNumber(pid));
        assert.ok(
          left.includes(other),
          `${shape}: the process that is not an engine is left and named: ${JSON.stringify(stopped)}`,
        );
        assert.ok(
          workers.every((pid) => !left.includes(pid)),
          `${shape}: and no worker is: ${JSON.stringify(stopped)}`,
        );
        // Nor the run's own engine: under the console wrapper it sits under the handle, and it is
        // not something the game started. Read off the table taken before the stop, since by now
        // it is gone.
        const enginesLeft = left.filter((pid) => /godot/i.test(executableOf(pid)));
        assert.deepEqual(
          enginesLeft,
          [],
          `${shape}: no engine is left unaccounted for: ${JSON.stringify(left.map((pid) => [pid, executableOf(pid)]))}`,
        );
        assert.match(
          text(get(stopped, 'note')),
          /2 processes the game had started for itself were ended with it.*2 this project's engine run with --path on it, by their command line/,
        );
        assert.match(text(get(stopped, 'note')), /it had started (was|were) left, named under childrenLeft/);
        assert.ok(
          await cameTrue(() => workers.every((pid) => !alive(pid)), 10_000),
          `${shape}: and both worker processes are gone`,
        );
        // Under the console wrapper everything under it goes when it does, the bystander with the
        // rest, so whether it is still there is the platform's doing and not this stop's: what
        // the stop owes is that it was named and not signalled, which is held above.
        if (!/_console\.exe$/i.test(engine)) {
          assert.ok(alive(other), `${shape}: while the other child is still there`);
        }
      } finally {
        for (const pid of [...workers, other]) {
          if (pid > 0 && alive(pid)) {
            try {
              process.kill(pid);
            } catch {
              // Gone already.
            }
          }
        }
        await server.request(
          'tools/call',
          { name: 'editor_run', arguments: { op: 'stop' } },
          ENGINE_CALL_TIMEOUT_MS,
        );
      }
    },
    { engine },
  );
}

/**
 * A runtime call with no pid reaches the game this server holds when several are running.
 *
 * A bench fans out to workers from the same project, and every runtime call from the session that
 * started the bench was refused with "pass pid" from the moment the first worker announced: the
 * caller had started one game and was asked which of thirty-two it meant. The run this server
 * started or plays is the one meant when nothing says otherwise, and the answer says so under
 * `answeredBy` when it was a choice, so a worker's answer is never read as the bench's. A pid
 * still picks a worker.
 *
 * Fake games answer the calls: a socket each, since what is measured is which one was asked.
 */
async function testARuntimeCallReachesThisServersOwnGame(): Promise<void> {
  const processes: ChildProcess[] = [];
  const sockets: Server[] = [];
  const aGame = async (name: string): Promise<{ pid: number; port: number }> => {
    const process_ = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    processes.push(process_);
    assert.ok(typeof process_.pid === 'number', 'the fixture needs live processes to announce');
    const answering = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.write(`${JSON.stringify({ type: 'welcome', protocol: RUNTIME_PROTOCOL })}\n`);
      let buffered = '';
      socket.on('data', (chunk: string) => {
        buffered += chunk;
        let newline = buffered.indexOf('\n');
        while (newline !== -1) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf('\n');
          const asked = JSON.parse(line) as { id: number; command: string; params: { output_path?: string } };
          // A capture is answered through the file the server named, as the addon answers it.
          const into = asked.params.output_path;
          if (asked.command === 'capture_screenshot' && into !== undefined) {
            writeFileSync(into, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
            socket.write(
              `${JSON.stringify({ id: asked.id, type: 'screenshot_file', path: into, width: 1, height: 1, format: 'png' })}\n`,
            );
            continue;
          }
          socket.write(`${JSON.stringify({ id: asked.id, type: 'tree', game: name })}\n`);
        }
      });
      socket.on('error', () => {});
    });
    sockets.push(answering);
    await new Promise<void>((ready) => answering.listen(0, '127.0.0.1', ready));
    return { pid: process_.pid, port: portOf(answering) };
  };
  const announce = (runtimeDir: string, project: string, game: { pid: number; port: number }): void => {
    writeFileSync(
      join(runtimeDir, `runtime-${game.pid}.json`),
      JSON.stringify({
        protocol: RUNTIME_PROTOCOL,
        pid: game.pid,
        port: game.port,
        address: '127.0.0.1',
        project: { name: 'Played', path: project },
        editor_pid: FAKE_EDITOR_PID,
      }),
      'utf8',
    );
  };
  let bench: { pid: number; port: number } | null = null;
  let worker: { pid: number; port: number } | null = null;
  try {
    await withAPlayingEditor(
      ({ adapter, project, runtimeDir }) =>
        async (tool) => {
          if (tool === 'play_scene') {
            // The bench announces inside the wait and is tied to the run; its worker, which it
            // opened for itself and which inherited the same mark, announces a moment later.
            bench = await aGame('bench');
            worker = await aGame('worker');
            const [ours, spawned] = [bench, worker];
            setTimeout(() => {
              announce(runtimeDir, project, ours);
            }, 100);
            setTimeout(() => {
              announce(runtimeDir, project, spawned);
            }, 400);
            return { ok: true, playing: true, scenePath: 'res://main.tscn', debugPort: adapter };
          }
          if (tool === 'playing_status') {
            return { ok: true, playing: true, scenePath: 'res://main.tscn', debugPort: adapter };
          }
          return { ok: true };
        },
      async ({ server, runtimeDir, start }) => {
        const started = await start(3_000);
        assert.ok(bench !== null && worker !== null, 'the play should have opened both games');
        assert.equal(get(started.answer, 'runtime', 'pid'), bench.pid, JSON.stringify(started.answer));
        assert.ok(
          await cameTrue(
            () => worker !== null && existsSync(join(runtimeDir, `runtime-${worker.pid}.json`)),
            5_000,
          ),
          'the worker should have announced',
        );

        const inspect = async (extra: Record<string, unknown>): Promise<unknown> =>
          parseTextContent(
            await server.request(
              'tools/call',
              { name: 'runtime_inspect', arguments: { op: 'tree', nodePath: '/root', ...extra } },
              60_000,
            ),
          );
        const unnamed = await inspect({});
        assert.equal(
          get(unnamed, 'game'),
          'bench',
          `a call naming no pid reaches the game this server holds: ${JSON.stringify(unnamed)}`,
        );
        assert.equal(
          get(unnamed, 'answeredBy'),
          bench.pid,
          `and says which game that was, since there were several: ${JSON.stringify(unnamed)}`,
        );
        const named = await inspect({ pid: worker.pid });
        assert.equal(get(named, 'game'), 'worker', `a pid still picks the worker: ${JSON.stringify(named)}`);
        assert.equal(
          get(named, 'answeredBy'),
          undefined,
          `and a game the caller named is not reported as chosen for them: ${JSON.stringify(named)}`,
        );
        // A capture answers with an image and a sentence rather than a record, so the sentence
        // says which game it came from when that was a choice.
        const captured = await server.request(
          'tools/call',
          { name: 'runtime_capture', arguments: { op: 'screenshot' } },
          60_000,
        );
        assert.match(
          textOf(captured) ?? '',
          new RegExp(`Screenshot captured: 1x1 png from pid ${bench.pid}, the game this server holds`),
          `a capture names the game it came from: ${textOf(captured)}`,
        );
      },
      { realAddon: true },
    );
  } finally {
    for (const answering of sockets) {
      answering.close();
    }
    for (const process_ of processes) {
      if (process_.exitCode === null) {
        process_.kill();
      }
    }
  }
}

/**
 * A command line is read the way the engine reads its own, on both platforms' spellings.
 *
 * Windows quotes what has spaces in it and `ps` quotes nothing, so a project directory with a space
 * in its name arrives as one word on the one and two on the other; `--path` may be last or
 * followed by another flag or a scene; `-e` and `--editor` are both the editor; and the process
 * table is `pid ppid command` with whatever leading space the platform pads with, a header or a
 * blank line to be skipped, and a command that may be empty. Nothing under `andChildren` is right
 * unless this is, and the engine tier would only show it on the platform it happened to run on.
 */
function testACommandLineIsReadTheWayTheEngineReadsIt(): void {
  const windows = readCommandLine(
    '"C:\\Program Files\\Godot\\Godot_v4.7.2-stable_win64.exe" --headless --path "C:\\Users\\Me\\My Project" res://tests/bench.tscn',
  );
  assert.deepEqual(windows, {
    executable: 'Godot_v4.7.2-stable_win64.exe',
    projectPath: 'C:\\Users\\Me\\My Project',
    editor: false,
  });
  const posix = readCommandLine('/opt/godot/Godot --headless --path /home/me/My Project res://bench.tscn');
  assert.deepEqual(posix, { executable: 'Godot', projectPath: '/home/me/My Project', editor: false });
  assert.deepEqual(readCommandLine('godot --path /p'), {
    executable: 'godot',
    projectPath: '/p',
    editor: false,
  });
  assert.deepEqual(readCommandLine('godot --path /p --headless'), {
    executable: 'godot',
    projectPath: '/p',
    editor: false,
  });
  assert.equal(readCommandLine('godot -e --path /p').editor, true);
  assert.equal(readCommandLine('godot --editor --path /p').editor, true);
  assert.equal(readCommandLine('godot --path /p -- --editor').editor, true);
  assert.deepEqual(readCommandLine('node script.js'), {
    executable: 'node',
    projectPath: null,
    editor: false,
  });
  assert.deepEqual(readCommandLine(''), { executable: '', projectPath: null, editor: false });
  assert.equal(
    readCommandLine('godot --path').projectPath,
    null,
    'a --path with nothing after it names nothing',
  );

  const table = parseProcessTable(
    [
      '  PID  PPID COMMAND',
      '    1     0 /sbin/init',
      '  200     1 "C:\\x\\a b.exe" --path C:\\p',
      '  201   200',
      '',
      'junk line',
    ].join('\n'),
  );
  assert.deepEqual(
    [...table.entries()],
    [
      [1, { parent: 0, command: '/sbin/init' }],
      [200, { parent: 1, command: '"C:\\x\\a b.exe" --path C:\\p' }],
      [201, { parent: 200, command: '' }],
    ],
  );
  // A tree of a wrapper, its engine, a worker and the worker's helper, beside a stranger.
  const tree = parseProcessTable(
    ['10 1 wrapper', '11 10 engine', '12 11 worker', '13 12 helper', '20 1 stranger'].join('\n'),
  );
  assert.deepEqual(descendantsIn(tree, 10), [11, 12, 13]);
  assert.deepEqual(descendantsIn(tree, 12), [13]);
  assert.deepEqual(descendantsIn(tree, 20), []);
  assert.deepEqual(
    ancestorsIn(tree, 13, 10),
    [12, 11, 10],
    'up to the root, nearest first, the root included',
  );
  assert.deepEqual(ancestorsIn(tree, 13, 12), [12]);
  assert.deepEqual(
    ancestorsIn(tree, 20, 10),
    [1],
    'a chain that never reaches the root ends where the tree does',
  );

  // A listing that says when each began, as the Windows one does, and a link that is to a number
  // rather than to a process: 30 was left behind by whatever held 10 before this wrapper did, and
  // began before the wrapper, which no child of it could have. The positive is the engine, which
  // began after the wrapper and is still its child; and a process the system would not date is
  // linked by its number alone, as before.
  const dated = parseProcessTable(
    [
      '10 1 1000 wrapper',
      '11 10 1500 engine',
      '12 11 2000 worker',
      '30 10 500 orphan of an earlier 10',
      "31 30 600 the orphan's own child",
      '40 10 0 undated',
    ].join('\n'),
    true,
  );
  assert.deepEqual(
    [...dated.entries()].slice(0, 2),
    [
      [10, { parent: 1, command: 'wrapper', startedAt: 1000 }],
      [11, { parent: 10, command: 'engine', startedAt: 1500 }],
    ],
    'the third column is when each began',
  );
  assert.deepEqual(dated.get(40), { parent: 10, command: 'undated' }, 'zero is no time at all');
  assert.deepEqual(
    descendantsIn(dated, 10),
    [11, 40, 12],
    'a child that began before its parent is not its child, and takes its own children with it',
  );
  assert.deepEqual(ancestorsIn(dated, 12, 10), [11, 10], 'the chain up through real links is whole');
  assert.deepEqual(
    ancestorsIn(dated, 31, 10),
    [30],
    'and a chain up through a stale link stops at the process that was really there',
  );
}

/**
 * A process's children are listed while it lives, and on POSIX not after: the reason a stop asked
 * to end them lists them before ending the run.
 *
 * The listing is a thing the platform has to supply, and its absence would otherwise be a stop
 * that quietly ends nothing, so an answer is required of every platform. The second half is the
 * claim the ordering in `handleStopProject` rests on, measured rather than reasoned: a parent
 * started here with a child of its own is ended, and the child is asked for again. POSIX hands an
 * orphan to init, so the listing under the dead parent is empty; Windows keeps the dead parent's
 * number on the child, so the listing still names it there, which is why the ordering is written
 * for the platform that forgets rather than the one that remembers.
 */
async function testChildrenAreListedWhileTheParentLives(): Promise<void> {
  const probe = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    assert.ok(typeof probe.pid === 'number');
    const listed = await childrenOf(process.pid);
    assert.ok(listed !== undefined, "this platform has to list a process's children");
    assert.ok(listed.includes(probe.pid), `the child just spawned is listed: ${JSON.stringify(listed)}`);
    // Windows keeps a dead parent's number on its orphans, so its listing has to say when each
    // process began or a link cannot be told from a number that came round: required of the
    // platform rather than assumed, since a listing without times would keep every link and the
    // guard on them would be quietly gone.
    if (process.platform === 'win32') {
      const tree = await processTree();
      const dated = tree?.get(probe.pid)?.startedAt;
      assert.ok(
        dated !== undefined && dated > 0,
        `the Windows listing dates each process: ${JSON.stringify(tree?.get(probe.pid))}`,
      );
      const own = tree?.get(process.pid)?.startedAt;
      assert.ok(
        own !== undefined && own <= dated,
        'and this process began no later than the child it spawned',
      );
    }
  } finally {
    probe.kill();
  }

  // The grandchild is started detached, the way a game starts a worker: a child Node keeps in its
  // job object on Windows dies with its parent, which is Node's doing and not the platform's, and
  // what is measured here is what the platform does with an orphan.
  const parent = spawn(
    process.execPath,
    [
      '-e',
      "const { spawn } = require('node:child_process');" +
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });" +
        'child.unref();' +
        "process.stdout.write(String(child.pid) + '\\n');" +
        'setInterval(() => {}, 1000);',
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  let child = 0;
  try {
    assert.ok(typeof parent.pid === 'number');
    const printed = await new Promise<string>((resolve) => {
      let text = '';
      parent.stdout.setEncoding('utf8');
      parent.stdout.on('data', (chunk: string) => {
        text += chunk;
        if (text.includes('\n')) resolve(text);
      });
    });
    child = Number(printed.trim());
    assert.ok(child > 0 && alive(child), 'the grandchild is there to be listed');
    const alive_ = await childrenOf(parent.pid);
    assert.deepEqual(alive_, [child], `listed under the living parent: ${JSON.stringify(alive_)}`);

    parent.kill();
    assert.ok(
      await cameTrue(() => parent.exitCode !== null || parent.signalCode !== null, 5_000),
      'the parent should have ended',
    );
    assert.ok(alive(child), 'the orphan is still there');
    const afterwards = await childrenOf(parent.pid);
    assert.ok(afterwards !== undefined, 'the platform still answers about a number that is gone');
    if (process.platform === 'win32') {
      assert.deepEqual(
        afterwards,
        [child],
        `Windows keeps the dead parent on the child: ${JSON.stringify(afterwards)}`,
      );
    } else {
      assert.deepEqual(afterwards, [], `POSIX has handed the orphan to init: ${JSON.stringify(afterwards)}`);
    }
  } finally {
    if (child > 0 && alive(child)) {
      try {
        process.kill(child);
      } catch {
        // Gone already.
      }
    }
    if (parent.exitCode === null && parent.signalCode === null) {
      parent.kill();
    }
  }
}

/**
 * A stop asked to end what the game started ends the children that are games of the project, and
 * only those.
 *
 * A bench fans out to workers with OS.create_process, and a stop ended the bench and left the
 * workers grinding, as its note said; the session that hit it ended them by pid from a process
 * listing on the scene name, by hand, every time. Being under the run's process is the property a
 * stranger's bench cannot have, and being a game of the project, announced as one or the
 * project's engine run on it, is what says a child is a game at all: both are required before a
 * number is signalled, so a child that is neither is left and named. The listing is taken before
 * the run is ended, since ending it reparents the children on POSIX and the question has no
 * answer afterwards.
 *
 * The bench is a process of this fixture's that starts two children of its own, one announced as a
 * game and one not, and the editor stage ties the run to it. The positive is the other child still
 * there after the stop: a stop that ended every child would pass the first assertion as well. The
 * announced one goes as the run is ended, before the stop's own signal, and is named as ended all
 * the same.
 */
async function testAStopCanEndWhatTheGameStarted(): Promise<void> {
  const held: { bench: ChildProcess | null } = { bench: null };
  let worker = 0;
  let other = 0;
  try {
    await withAPlayingEditor(
      ({ adapter, project, runtimeDir }) =>
        async (tool) => {
          if (tool === 'play_scene') {
            const started = spawn(
              process.execPath,
              [
                '-e',
                "const { spawn } = require('node:child_process');" +
                  "const child = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });" +
                  'const worker = child(); const other = child();' +
                  "process.stdout.write(JSON.stringify({ worker: worker.pid, other: other.pid }) + '\\n');" +
                  'setInterval(() => {}, 1000);',
              ],
              { stdio: ['ignore', 'pipe', 'ignore'] },
            );
            held.bench = started;
            const benchPid = started.pid;
            assert.ok(typeof benchPid === 'number', 'the fixture needs a live bench');
            const printed = await new Promise<string>((resolve) => {
              let text = '';
              started.stdout.setEncoding('utf8');
              started.stdout.on('data', (chunk: string) => {
                text += chunk;
                if (text.includes('\n')) resolve(text);
              });
            });
            const pids = JSON.parse(printed.trim()) as { worker: number; other: number };
            worker = pids.worker;
            other = pids.other;
            const announce = (pid: number): void => {
              writeFileSync(
                join(runtimeDir, `runtime-${pid}.json`),
                JSON.stringify({
                  protocol: RUNTIME_PROTOCOL,
                  pid,
                  port: 51_997,
                  address: '127.0.0.1',
                  project: { name: 'Played', path: project },
                }),
                'utf8',
              );
            };
            // The bench first, inside the wait, so the run is tied to it; the worker after.
            setTimeout(() => {
              announce(benchPid);
            }, 100);
            setTimeout(() => {
              announce(pids.worker);
            }, 400);
            return { ok: true, playing: true, scenePath: 'res://main.tscn', debugPort: adapter };
          }
          if (tool === 'playing_status') {
            return { ok: true, playing: true, scenePath: 'res://main.tscn', debugPort: adapter };
          }
          if (tool === 'stop_playing') {
            // The worker goes as the run is ended, before the stop's own signal reaches it, as a
            // worker sharing its parent's job on Windows does, or one that exits as its slice
            // ends. Listed while the bench lived and gone when signalled, it is still one the
            // caller asked to be ended and is, so it is named as ended rather than dropped. The
            // bench itself is left to the fixture's end: on Windows a Node child dies with its
            // parent, and the other child has to be there afterwards to be reported as left.
            // Only once there is a worker: the start ends what this editor claims to be playing
            // before it plays, and a signal to pid 0 is a signal to this process's own group.
            if (worker > 0) {
              try {
                process.kill(worker);
              } catch {
                // Gone already.
              }
              assert.ok(await cameTrue(() => !alive(worker), 5_000), 'the worker went with the stop');
            }
            return { ok: true };
          }
          return { ok: true };
        },
      async ({ server, runtimeDir, start }) => {
        const started = await start(3_000);
        const benchPid = held.bench?.pid;
        assert.ok(typeof benchPid === 'number', 'the play should have started the bench');
        assert.equal(get(started.answer, 'runtime', 'pid'), benchPid, JSON.stringify(started.answer));
        assert.ok(
          await cameTrue(() => existsSync(join(runtimeDir, `runtime-${worker}.json`)), 5_000),
          'the worker should have announced',
        );
        const stopped = parseTextContent(
          await server.request(
            'tools/call',
            { name: 'editor_run', arguments: { op: 'stop', andChildren: true } },
            60_000,
          ),
        );
        assert.equal(get(stopped, 'endedPid'), benchPid, JSON.stringify(stopped));
        assert.deepEqual(
          get(stopped, 'endedChildren'),
          [worker],
          `the child announced as a game of the project is ended: ${JSON.stringify(stopped)}`,
        );
        assert.deepEqual(
          get(stopped, 'childrenLeft'),
          [other],
          `and the child that is not is left and named: ${JSON.stringify(stopped)}`,
        );
        assert.match(
          text(get(stopped, 'note')),
          /1 process the game had started for itself.*was ended with it/,
        );
        assert.match(
          text(get(stopped, 'note')),
          /1 process it had started was left, named under childrenLeft/,
        );
        assert.ok(await cameTrue(() => !alive(worker), 5_000), 'the worker is gone');
        assert.ok(alive(other), 'and the other child is still there');
        // The bench itself outlived the stop, so its announcement is not the stop's to take: a
        // file taken while its process runs hides a game, and the sweep judges this one by when
        // it started.
        assert.ok(alive(benchPid), 'the bench is still there');
        assert.ok(
          existsSync(join(runtimeDir, `runtime-${benchPid}.json`)),
          'and a stop that did not end the process leaves its announcement',
        );
      },
    );
  } finally {
    for (const pid of [worker, other]) {
      if (pid > 0 && alive(pid)) {
        try {
          process.kill(pid);
        } catch {
          // Gone already.
        }
      }
    }
    if (held.bench?.exitCode === null) {
      held.bench.kill();
    }
  }
}

/**
 * A stop takes the announcement of the game it ended down with it.
 *
 * The sweep would take it the next time anything looked, and the gap before that look is where
 * the number came round downstream: the stop was the last call of a session, a shell started
 * afterwards took the number, and every later look found a process behind the file and reported
 * a game still starting. The server that ended the game knows the number and that ending it was
 * meant, so the file goes as the process does, and a status read straight after the stop has
 * nothing to misread.
 *
 * The fake editor's game is a process of this fixture's, announced inside the start's wait and
 * killed when the editor is asked to stop; the file is read the moment the stop answers, before
 * anything else could sweep it. The positive is the announcement being there for the stop to
 * take, and the stop naming the process it ended.
 */
async function testAStopTakesTheEndedGamesAnnouncementDown(): Promise<void> {
  const held: { game: ChildProcess | null } = { game: null };
  try {
    await withAPlayingEditor(
      ({ adapter, project, runtimeDir }) =>
        (tool) => {
          if (tool === 'play_scene') {
            const game = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
            held.game = game;
            const pid = game.pid;
            assert.ok(typeof pid === 'number', 'the fixture needs a live game');
            setTimeout(() => {
              writeFileSync(
                join(runtimeDir, `runtime-${pid}.json`),
                JSON.stringify({
                  protocol: RUNTIME_PROTOCOL,
                  pid,
                  port: 51_998,
                  address: '127.0.0.1',
                  project: { name: 'Played', path: project },
                  editor_pid: FAKE_EDITOR_PID,
                }),
                'utf8',
              );
            }, 100);
            return { ok: true, playing: true, scenePath: 'res://main.tscn', debugPort: adapter };
          }
          if (tool === 'playing_status') {
            const playing = held.game?.exitCode === null;
            return { ok: true, playing, scenePath: playing ? 'res://main.tscn' : '', debugPort: adapter };
          }
          if (tool === 'stop_playing') {
            held.game?.kill();
            return { ok: true };
          }
          return { ok: true };
        },
      async ({ server, runtimeDir, start }) => {
        const started = await start(3_000);
        const pid = held.game?.pid;
        assert.ok(typeof pid === 'number', 'the play should have started the game');
        assert.equal(get(started.answer, 'runtime', 'pid'), pid, JSON.stringify(started.answer));
        const announcement = join(runtimeDir, `runtime-${pid}.json`);
        assert.ok(existsSync(announcement), 'the announcement is there for the stop to take');

        const stopped = parseTextContent(
          await server.request('tools/call', { name: 'editor_run', arguments: { op: 'stop' } }, 60_000),
        );
        assert.equal(get(stopped, 'endedPid'), pid, JSON.stringify(stopped));
        assert.equal(get(stopped, 'exitedBeforeStop'), false, JSON.stringify(stopped));
        assert.equal(alive(pid), false, 'the game is gone by the time the stop answers');
        assert.equal(
          existsSync(announcement),
          false,
          'and its announcement went with it, before anything else looked',
        );
      },
    );
  } finally {
    if (held.game?.exitCode === null) {
      held.game.kill();
    }
  }
}

/**
 * A stop takes the announcement down by the number the game announced under, which is not always
 * the run's own.
 *
 * The Windows console build is a wrapper: the run holds the wrapper's process and the engine is
 * its child, so the announcement is written under a number the run does not hold. A stop that
 * took announcements down by the run's number alone left this one to the sweep, which is the gap
 * the number can come round in. Measured before this was written: the engine was listed under the
 * wrapper, and gone two seconds after the wrapper was killed, so the file is the stop's to take.
 *
 * Only where that build is, beside the engine the tier was given; elsewhere the run's number and
 * the announced one are the same process and the case above holds it.
 */
async function testAStopTakesTheWrappedEnginesAnnouncementDown(): Promise<void> {
  const godotPath = resolveGodotPath();
  const wrapper = godotPath === null ? null : godotPath.replace(/\.exe$/i, '_console.exe');
  if (
    process.platform !== 'win32' ||
    godotPath === null ||
    wrapper === godotPath ||
    !existsSync(wrapper ?? '')
  ) {
    console.log('wrapped engine stop regression skipped (no console build beside GODOT_PATH)');
    return;
  }
  const runtimeDir = mkdtempSync(join(tmpdir(), 'gdharness-wrapped-runtime-'));
  const project = mkdtempSync(join(tmpdir(), 'gdharness-wrapped-'));
  try {
    writeFileSync(
      join(project, 'project.godot'),
      '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="Wrapped"\n' +
        'run/main_scene="res://main.tscn"\n\n[autoload]\n\n' +
        'GdharnessRuntime="*res://addons/gdharness_runtime/runtime_autoload.gd"\n',
    );
    writeFileSync(join(project, 'main.tscn'), '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n');
    cpSync(
      join('src', 'godot', 'addons', 'gdharness_runtime'),
      join(project, 'addons', 'gdharness_runtime'),
      {
        recursive: true,
      },
    );
    await withStdioServer(
      async (call) => {
        const started: unknown = JSON.parse(
          await call(
            'editor_run',
            { projectPath: project, op: 'start', headless: true, runtimeWaitMs: 60_000 },
            ENGINE_CALL_TIMEOUT_MS,
          ),
        );
        assert.equal(get(started, 'runtime', 'listening'), true, JSON.stringify(started));
        const runPid = asNumber(get(started, 'pid'), 'the run holds a process');
        const gamePid = asNumber(get(started, 'runtime', 'pid'), 'the game announced under a number');
        assert.notEqual(
          runPid,
          gamePid,
          'the console build holds the wrapper, and the engine announces as its child',
        );
        const announcement = join(runtimeDir, `runtime-${gamePid}.json`);
        assert.ok(existsSync(announcement), 'the announcement is there for the stop to take');

        const stopped: unknown = JSON.parse(await call('editor_run', { op: 'stop' }, 60_000));
        assert.equal(get(stopped, 'endedPid'), runPid, JSON.stringify(stopped));
        // Waited for rather than read once, so the assertion after it is about the file and not
        // about how quickly the engine follows its wrapper.
        assert.ok(await cameTrue(() => !alive(gamePid), 5_000), 'the engine goes with its wrapper');
        assert.equal(
          existsSync(announcement),
          false,
          'and its announcement went with it, taken by the number it announced under',
        );
      },
      { GODOT_PATH: wrapper ?? '', GDHARNESS_RUNTIME_DIR: runtimeDir, GDHARNESS_PROJECT: project },
    );
  } finally {
    sweep(project);
    sweep(runtimeDir);
  }
}

async function testTheEditorsRunIsTheOneAnsweredFor(): Promise<void> {
  const port = await reservePort();
  // Reserved and then left alone, so nothing is listening on it: the adapter this run's console
  // would arrive over is the thing the second half of this case is about not being there.
  const adapter = await reservePort();
  const runtimeDir = mkdtempSync(join(realpathSync(tmpdir()), 'gdharness-played-runs-'));
  const project = mkdtempSync(join(realpathSync(tmpdir()), 'gdharness-played-'));
  const server = new ServerProcess({
    env: { GDHARNESS_BRIDGE_PORT: String(port), GDHARNESS_RUNTIME_DIR: runtimeDir },
  });
  let editor: WebSocket | null = null;
  try {
    writeFileSync(join(project, 'project.godot'), 'config_version=5\n');
    // The note the other run left: same project, so it passes every test of whose it is, which is
    // what made it the one adopted. Its own pid and its own transcript, with output in it.
    const transcript = join(runtimeDir, 'other-run.log');
    writeFileSync(transcript, 'ostinato weld bench\nrow 1 of the wrong table\n');
    // What the editor-played run had printed before the server was replaced, in the file the
    // server that started it was writing. Recovering this is the difference between explaining
    // the loss and not losing it.
    const played = join(runtimeDir, 'runs', 'run-1.log');
    mkdirSync(join(runtimeDir, 'runs'), { recursive: true });
    writeFileSync(played, 'ostinato weld shortlist bench\n[slices] 31 of 31 workers started\n');

    // Written where the server under test will look for it, which is the whole point of the case:
    // a note somewhere else is a note nothing adopts, and the disarm then shows "no game running"
    // rather than the other run's table.
    const had = process.env['GDHARNESS_RUNTIME_DIR'];
    process.env['GDHARNESS_RUNTIME_DIR'] = runtimeDir;
    try {
      writeRunRecord({
        pid: process.pid,
        transcript,
        startedAt: Date.now() - 60_000,
        projectPath: project,
        arguments: ['--headless'],
        command: process.execPath,
      });
      writeEditorRunNote({ projectPath: project, transcript: played, startedAt: Date.now() - 60_000 });
    } finally {
      if (had === undefined) {
        delete process.env['GDHARNESS_RUNTIME_DIR'];
      } else {
        process.env['GDHARNESS_RUNTIME_DIR'] = had;
      }
    }

    await server.initialize('regression-test');
    const socket = new WebSocket(`ws://127.0.0.1:${port}/godot`);
    editor = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', reject);
    });

    socket.on('message', (raw: Buffer) => {
      const message: unknown = JSON.parse(String(raw));
      if (!isRecord(message) || message['type'] !== 'tool_invoke') {
        return;
      }
      const tool = String(message['tool']);
      const result =
        tool === 'playing_status'
          ? { ok: true, playing: true, scenePath: 'res://tests/bench_shortlist.tscn', debugPort: adapter }
          : { ok: true };
      socket.send(JSON.stringify({ type: 'tool_result', id: message['id'], success: true, result }));
    });
    // A port of its own rather than the default. Godot's default debug adapter port is one every
    // editor on the machine would take, so a case that leaves it unnamed connects to whichever
    // editor happens to be open and reads its console as this run's: this fixture passed on a
    // machine with a leftover editor and failed on one without, which is the wrong way round for
    // a case about a console that is not arriving.
    socket.send(
      JSON.stringify({
        type: 'godot_ready',
        project_path: project,
        addon_version: SERVER_VERSION,
        dap_port: adapter,
      }),
    );

    let knows = false;
    for (let waited = 0; waited < 10_000 && !knows; waited += 100) {
      await delay(100);
      const status = await server.request('tools/call', { name: 'editor_status', arguments: {} });
      knows = text(get(parseTextContent(status), 'editor', 'projectPath')) === project;
    }
    assert.ok(knows, 'the fixture editor should have reached the server, or this proves nothing');

    const output = await server.request('tools/call', { name: 'editor_output', arguments: {} });
    const said = textOf(output) ?? JSON.stringify(output);
    const answer = parseTextContent(output);
    assert.equal(get(answer, 'through'), 'editor', `the run answered for is the editor's: ${said}`);
    assert.equal(get(answer, 'pid'), null, `with no pid from the other run: ${said}`);
    assert.equal(get(answer, 'transcript'), played, `the transcript is its own, not the other's: ${said}`);
    assert.doesNotMatch(said, /wrong table/, `nor a line of its output: ${said}`);
    // And the run it is about is the one whose output comes back: an editor-played run writes a
    // transcript of its own, so a reconnect reads back what it printed rather than starting the
    // log again from where the new server arrived.
    assert.match(text(get(answer, 'note')), /already playing this when this server reached it/, said);
    assert.match(said, /31 of 31 workers started/, `its own earlier output is read back: ${said}`);
    assert.match(text(get(answer, 'note')), /read back from its transcript/, said);

    // The console of an editor-played run arrives over the debug adapter and nothing else, and
    // there is no adapter on the port this fixture editor names. That is the other half of the
    // same report: a run printing steadily was answered `clean: true`, `omitted: 0`, no entries,
    // for minutes at a time, which is what a quiet run looks like too. An unreachable console is
    // said rather than counted as silence.
    assert.equal(get(answer, 'consoleLost'), true, `the console is named as not arriving: ${said}`);
    assert.equal(get(answer, 'clean'), undefined, `so there is no verdict to read off it: ${said}`);
    assert.match(text(get(answer, 'note')), /hole in it/, `and the log is said to have a gap: ${said}`);
  } finally {
    editor?.terminate();
    await server.stop();
    sweep(project);
    sweep(runtimeDir);
  }
}

/**
 * A status call meeting a held game says held and does not wait the runtime timeout to say it,
 * and a picked-up run whose game has quit is over rather than held or running.
 *
 * `editor_status` pings every announced game, and a game held at a breakpoint accepts the
 * connection and never answers, so the first call an agent makes waited the whole runtime timeout,
 * ten seconds by default, on each held game before listing it as unreachable with "may be paused
 * at a breakpoint", while the session reporting on that run could have said so. Now the ping waits
 * as long as the hold check does, and the run's `heldAt` is answered here as it is by editor_output.
 *
 * The second half is the run after its game has gone. A run picked up after a reconnect had no
 * process number of any kind, so `running` stayed true for as long as the record lasted, and a
 * session that had never learned the hold went to the announcement for it, found the announcement
 * swept with the process, and answered that the run could not be told from held, about a run whose
 * exit the same answer reported. The pick-up ties the run to the one game announced for its project,
 * and a run that is over is held nowhere before anybody is asked.
 *
 * The game is a socket that accepts and says nothing, the process behind its announcement is a
 * child this fixture can end, and the adapter answers a late session a thread and no frames, which
 * is what a real one answers a replacement. The runtime timeout is set long so that the wait this
 * is about is unmistakable from the wait it replaced.
 */
async function testAStatusCallIsNotHeldByAHeldGame(): Promise<void> {
  await withAHeldGame({ toldOnConnect: null }, async ({ server, game, gamePid, project }) => {
    const status = async (): Promise<unknown> =>
      parseTextContent(await server.request('tools/call', { name: 'editor_status', arguments: {} }, 60_000));
    const began = Date.now();
    const found = await status();
    const took = Date.now() - began;
    const said = JSON.stringify(found);
    assert.equal(get(found, 'game', 'playingInEditor', 'playing'), true, `the run is playing: ${said}`);
    assert.equal(get(found, 'game', 'processActive'), true, `and its process is there: ${said}`);
    const listed = asArray(get(found, 'game', 'runtimes'), 'runtimes');
    assert.equal(get(listed[0], 'pid'), gamePid, `the game is listed under runtimes: ${said}`);
    assert.equal(get(listed[0], 'reachable'), false, `as unreachable, since it answers nothing: ${said}`);
    assert.match(text(get(listed[0], 'problem')), /did not answer/, `for the reason it is: ${said}`);
    assert.equal(
      get(found, 'game', 'heldAt', 'reason'),
      'unanswered',
      `and the run is said to be held, from the game not answering: ${said}`,
    );
    assert.ok(
      took < 15_000,
      `a held game does not cost the status call the runtime timeout: ${took}ms with the timeout at 30000`,
    );

    // A pid nobody is running is refused with what is, before anything is sent: the number reaches
    // the chooser through the tool, which is the half a unit fixture on the chooser cannot hold.
    const nobody = await server.request(
      'tools/call',
      {
        name: 'runtime_inspect',
        arguments: { projectPath: project, pid: 999_999_999, op: 'tree', nodePath: '/root' },
      },
      60_000,
    );
    assert.match(
      textOf(nobody) ?? JSON.stringify(nobody),
      new RegExp(`No running game has pid 999999999\\. Running: pid ${gamePid}`),
      `a pid that is nobody's is refused naming who is running: ${textOf(nobody)}`,
    );

    // Before the game goes: running, by the process the pick-up tied it to.
    const output = async (): Promise<unknown> =>
      parseTextContent(await server.request('tools/call', { name: 'editor_output', arguments: {} }, 60_000));
    const going = await output();
    assert.equal(
      get(going, 'running'),
      true,
      `the picked-up run is running while its process is: ${JSON.stringify(going)}`,
    );
    assert.equal(get(going, 'heldAt', 'reason'), 'unanswered', `and held: ${JSON.stringify(going)}`);

    game.kill();
    await new Promise<void>((gone) => {
      game.once('exit', () => {
        gone();
      });
    });
    const over = await output();
    const ended = JSON.stringify(over);
    assert.equal(get(over, 'running'), false, `a run whose process has gone is over: ${ended}`);
    assert.equal(get(over, 'heldAt'), null, `and held nowhere: ${ended}`);
    assert.equal(get(over, 'heldUnknown'), undefined, `with nothing left open about it: ${ended}`);

    // A stop of a run that is over says nothing was ended: a picked-up run has no exit code for
    // anybody to have collected, and the answer used to read as a game ended by this call.
    const stop = parseTextContent(
      await server.request('tools/call', { name: 'editor_run', arguments: { op: 'stop' } }, 60_000),
    );
    assert.equal(
      get(stop, 'exitedBeforeStop'),
      true,
      `a run that had gone was over before the stop: ${JSON.stringify(stop)}`,
    );
    assert.match(
      text(get(stop, 'note')),
      /over before the stop, so nothing was ended here/,
      JSON.stringify(stop),
    );
  });
}

/**
 * A runtime call to a game the session knows is held is refused at once, with why and what lets
 * it go, rather than waited out and guessed about.
 *
 * A held game accepts the connection and answers nothing, so every runtime tool waited the whole
 * runtime timeout on it and then said it may be paused at a breakpoint, when the session had been
 * told the moment the game stopped and had the engine's own words for why. Held here with the
 * adapter telling the server's connection of the stop as it opens, the way a real one tells the
 * server that played the scene; the editor tier holds the same refusal against a real engine.
 *
 * Knowledge and not a default: the status fixture above is the same stage without the event, and
 * there a runtime call goes to the game, since a session that has not been told has no business
 * refusing on its behalf.
 */
async function testARuntimeCallToAHeldGameIsRefusedAtOnce(): Promise<void> {
  const stopped = frameJsonRpc({
    seq: 1,
    type: 'event',
    event: 'stopped',
    body: {
      reason: 'exception',
      description: 'Exception',
      text: 'Division by zero in operator /.',
      threadId: 1,
    },
  });
  await withAHeldGame(
    { toldOnConnect: stopped },
    async ({ server, gamePid, project, connectionsToTheGame }) => {
      // Picked up during the greeting, which tied the run to its announcement and handed the session
      // to it, so this status call is one the session already knows the answer to: the game is
      // listed as held with the reason, and its socket is not connected to for a ping it cannot
      // answer.
      const beforeStatus = connectionsToTheGame();
      const status = parseTextContent(
        await server.request('tools/call', { name: 'editor_status', arguments: {} }, 60_000),
      );
      assert.equal(
        get(status, 'game', 'heldAt', 'reason'),
        'exception',
        `the session was told, with the reason: ${JSON.stringify(status)}`,
      );
      const listed = asArray(get(status, 'game', 'runtimes'), 'runtimes');
      assert.equal(
        get(listed[0], 'reachable'),
        false,
        `the game is listed as unreachable: ${JSON.stringify(listed)}`,
      );
      assert.match(
        text(get(listed[0], 'problem')),
        /held by the editor's debugger, on an error: Division by zero/,
        `and the reason is the one the session was told: ${JSON.stringify(listed)}`,
      );
      assert.equal(
        connectionsToTheGame(),
        beforeStatus,
        'without the status call having connected to the game to find out',
      );

      const beforeAsking = connectionsToTheGame();
      const began = Date.now();
      const refused = await server.request(
        'tools/call',
        { name: 'runtime_inspect', arguments: { projectPath: project, op: 'tree', nodePath: '/root' } },
        60_000,
      );
      const took = Date.now() - began;
      const said = textOf(refused) ?? JSON.stringify(refused);
      assert.equal(
        get(refused, 'result', 'isError'),
        true,
        `a runtime call to a held game is refused: ${said}`,
      );
      assert.match(said, new RegExp(`pid ${gamePid}\\) is held by the editor's debugger`), said);
      assert.match(
        said,
        /on an error: Division by zero in operator \/\./,
        `with the engine's own words: ${said}`,
      );
      assert.match(said, /debug_control continue lets it go/, `and what lets it go: ${said}`);
      assert.ok(
        took < 5000,
        `refused at once rather than after the runtime timeout: ${took}ms with the timeout at 30000`,
      );
      assert.equal(
        connectionsToTheGame(),
        beforeAsking,
        'and the game was not asked, since what it would have answered was already known',
      );
    },
  );
}

/** What the held-game stage hands a fixture. */
interface HeldGameStage {
  readonly server: ServerProcess;
  readonly game: ChildProcess;
  readonly gamePid: number;
  readonly project: string;
  /** How many times anything has connected to the game's socket, for saying whether it was asked. */
  readonly connectionsToTheGame: () => number;
}

/**
 * A server with a fake editor playing a game that is held: the game is a socket that accepts and
 * says nothing, the process behind its announcement is a child the fixture can end, and the
 * adapter answers a late session a thread and no frames, which is what a real one answers a
 * replacement. `toldOnConnect` is what the adapter writes to each connection as it opens, for a
 * fixture whose server has to have been told of a stop the way the server that played the scene
 * is. The runtime timeout is set long so that a wait this stage is about is unmistakable from the
 * wait it replaced. The body runs once the editor has been greeted.
 */
async function withAHeldGame(
  options: { toldOnConnect: Buffer | null },
  body: (stage: HeldGameStage) => Promise<void>,
): Promise<void> {
  const project = mkdtempSync(join(realpathSync(tmpdir()), 'gdharness-held-'));
  const runtimeDir = mkdtempSync(join(realpathSync(tmpdir()), 'gdharness-held-rt-'));
  const port = await reservePort();
  const answerNothing: FramedPeerHandler = (message, socket) => {
    const command = String(message['command']);
    const body =
      command === 'threads'
        ? { threads: [{ id: 1, name: 'main' }] }
        : command === 'stackTrace'
          ? { stackFrames: [], totalFrames: 0 }
          : {};
    socket.write(
      frameJsonRpc({
        seq: Number(message['seq']) + 1000,
        type: 'response',
        request_seq: message['seq'],
        command,
        success: true,
        body,
      }),
    );
  };
  let connections = 0;
  const held = createServer(() => {
    // Accepted and never answered, which is what a game sitting at a breakpoint does.
    connections += 1;
  });
  await new Promise<void>((ready) => held.listen(0, '127.0.0.1', ready));
  const game = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const gamePid = game.pid;
  assert.ok(typeof gamePid === 'number' && alive(gamePid), 'the fixture needs a live process to announce');
  const server = new ServerProcess({
    env: {
      GDHARNESS_BRIDGE_PORT: String(port),
      GDHARNESS_RUNTIME_DIR: runtimeDir,
      GDHARNESS_RUNTIME_TIMEOUT_MS: '30000',
    },
  });
  const editor: { socket: WebSocket | null } = { socket: null };
  try {
    await withFramedPeer(
      answerNothing,
      async (adapter) => {
        writeFileSync(join(project, 'project.godot'), 'config_version=5\n');
        writeFileSync(
          join(runtimeDir, `runtime-${gamePid}.json`),
          JSON.stringify({
            protocol: RUNTIME_PROTOCOL,
            pid: gamePid,
            port: portOf(held),
            address: '127.0.0.1',
            project: { name: 'Held', path: project },
          }),
          'utf8',
        );
        await server.initialize('regression-test');
        const socket = new WebSocket(`ws://127.0.0.1:${port}/godot`);
        editor.socket = socket;
        await new Promise<void>((resolve, reject) => {
          socket.once('open', () => {
            resolve();
          });
          socket.once('error', reject);
        });
        socket.on('message', (raw: Buffer) => {
          const message: unknown = JSON.parse(String(raw));
          if (!isRecord(message) || message['type'] !== 'tool_invoke') {
            return;
          }
          const result =
            String(message['tool']) === 'playing_status'
              ? { ok: true, playing: true, scenePath: 'res://held.tscn', debugPort: adapter }
              : { ok: true };
          socket.send(JSON.stringify({ type: 'tool_result', id: message['id'], success: true, result }));
        });
        socket.send(
          JSON.stringify({
            type: 'godot_ready',
            project_path: project,
            addon_version: SERVER_VERSION,
            dap_port: adapter,
          }),
        );
        let greeted = false;
        for (let waited = 0; waited < 10_000 && !greeted; waited += 100) {
          await delay(100);
          const seen = parseTextContent(
            await server.request('tools/call', { name: 'editor_status', arguments: {} }, 60_000),
          );
          greeted = text(get(seen, 'editor', 'projectPath')) === project;
        }
        assert.ok(greeted, 'the fake editor should have been greeted, or nothing below is reached');
        await body({ server, game, gamePid, project, connectionsToTheGame: () => connections });
      },
      (socket) => {
        if (options.toldOnConnect !== null) {
          socket.write(options.toldOnConnect);
        }
      },
    );
  } finally {
    editor.socket?.terminate();
    await server.stop();
    if (game.exitCode === null) {
      game.kill();
    }
    held.close();
    sweep(project);
    sweep(runtimeDir);
  }
}

/**
 * What a run ended with outlives the server that watched it end.
 *
 * A run is spawned detached so a reconnect cannot take it, and the next server reads the note on
 * disk rather than the process. The exit was seen, though: the server that started it is the
 * child's parent until it goes, and it learned the code and kept it in memory alone. So a bench
 * that had finished cleanly under a server the harness then replaced came back reported as one
 * whose exit code "was never collected", which is true of the reading and false of the run.
 *
 * The note is shared by every server on this machine, so the half that matters as much is the one
 * where the pid is not ours: writing an ending into somebody else's note ends their bench on paper.
 */
function testAnExitCodeOutlivesTheServerThatSawIt(): void {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'gdharness-ending-'));
  const had = process.env['GDHARNESS_RUNTIME_DIR'];
  process.env['GDHARNESS_RUNTIME_DIR'] = runtimeDir;
  try {
    writeRunRecord({
      pid: 4242,
      transcript: join(runtimeDir, 'run.log'),
      startedAt: Date.now(),
      projectPath: join(tmpdir(), 'a-game'),
      arguments: ['--headless'],
      command: 'godot',
    });
    assert.equal(readRunRecord()?.exitCode, undefined, 'a run still going has no ending to report');

    recordRunEnded(9999, 3);
    assert.equal(readRunRecord()?.exitCode, undefined, "another run's ending is not written into this note");

    recordRunEnded(4242, 3);
    const after = readRunRecord();
    assert.ok(after !== null, 'the note should still be there to read');
    assert.equal(after.exitCode, 3, 'the code its own server saw is kept for whoever reads next');
    assert.equal(after.pid, 4242, 'and the rest of the note is still there');
    assert.equal(after.command, 'godot');
  } finally {
    if (had === undefined) {
      delete process.env['GDHARNESS_RUNTIME_DIR'];
    } else {
      process.env['GDHARNESS_RUNTIME_DIR'] = had;
    }
    sweep(runtimeDir);
  }
}

/**
 * A pid is not an identity, and the one thing here that kills asks for an identity.
 *
 * A run picked back up after a reconnect has a number and no handle, and the number was signalled
 * on its own. The operating system hands a pid out again as soon as it is free, so a record that
 * outlived its run names whatever came next, and `editor_run stop` on it kills a stranger's
 * process: irreversible, silent, and on Windows indistinguishable from a crash, since terminating
 * a process there is an exit code of 1 with nothing printed.
 *
 * Driven against a real process rather than a fabricated pid, because what is being asserted is
 * that the operating system was actually asked: three platforms, three ways of asking, and a
 * fixture that mocked the asking would pass on all three without any of them working.
 */
async function testAPidIsNotAnIdentity(): Promise<void> {
  const marker = join(tmpdir(), `gdharness-identity-${process.pid}`);
  // Something that stays up and carries a word of ours on its command line, which is what a real
  // run has: the engine's path and the project it was pointed at.
  //
  // The long spelling of the eval flag, because `-e` is how the engine this stands in for is told
  // to come up as an editor, and a stand-in wearing it is judged one.
  const held = spawn(process.execPath, ['--eval', 'setTimeout(() => {}, 120_000)', marker], {
    stdio: 'ignore',
  });
  const pid = held.pid ?? 0;
  assert.ok(pid > 0, 'the fixture needs a process to ask about');
  const record = {
    pid,
    transcript: join(tmpdir(), 'none.log'),
    startedAt: Date.now(),
    projectPath: marker,
    arguments: [marker],
    command: process.execPath,
  };
  try {
    // A pid exists the moment spawn returns it, and the operating system is not necessarily ready
    // to be asked about it yet: on a loaded Windows runner the answer arrives a little later, and
    // asked too early it is no answer at all, which reads exactly like a record naming a process
    // that is not there. Waited for rather than assumed, and the wait is named in its own failure
    // so the next reader is told the platform never answered rather than that the record was wrong.
    const until = Date.now() + 10_000;
    while (runningAs(pid) === null && Date.now() < until) {
      await delay(100);
    }
    assert.ok(
      runningAs(pid) !== null,
      `this platform never answered about pid ${pid}, so nothing below is askable`,
    );

    // And answered when it started, which is the part of the identity a recycled number cannot
    // carry. Asserted here rather than left to the judging cases, because those hand the start time
    // in and would pass unchanged on a platform that never produces one: the guard would be quietly
    // Windows-only and every other machine would go on signalling a worker engine. A platform that
    // genuinely cannot say is a thing to find out about rather than to degrade into silently.
    const began = runningAs(pid)?.startedAt;
    assert.ok(
      began !== undefined && Date.now() - began >= 0 && Date.now() - began < 120_000,
      `this platform should say when pid ${pid} started; it said ${String(began)}`,
    );

    assert.equal(stillTheRecordedRun(record), true, 'the process the record describes is the one running');
    assert.equal(
      couldStillBeTheRecordedRun(record),
      true,
      'and it is one to go on calling running, which is the weaker question',
    );
    assert.equal(
      stillTheRecordedRun({ ...record, command: join('nowhere', 'godot.exe') }),
      false,
      'a pid running something else is not this run, however alive it is',
    );
    // Only where the whole command line can be read. A Windows process this server cannot open
    // is named by tasklist and no further, and CI has runners where the interpreter that reads a
    // command line does not answer at all: asserting the project is discriminated there is
    // asserting something the platform cannot do, which is how this failed on a docs-only change.
    if (runningAs(pid)?.kind === 'commandLine') {
      assert.equal(
        stillTheRecordedRun({ ...record, projectPath: join(tmpdir(), 'another-project') }),
        false,
        'nor is the same engine on another project, which shares this record directory',
      );
    }
    assert.equal(
      stillTheRecordedRun({ ...record, pid: 999_999_999 }),
      false,
      'and a pid nobody holds is nothing to signal',
    );

    // Every answer the operating system can give, judged apart from asking it, because which of
    // them a machine gives is the machine's business and all three have to be right. The image
    // case is the one that was wrong: it confirmed a record naming a project against an answer
    // carrying none, so a stop on a Windows box whose command lines this server cannot read would
    // have signalled another project's engine of the same build.
    const answers = { image: { kind: 'image', text: basename(process.execPath) } } as const;
    const elsewhere = { ...record, projectPath: join(tmpdir(), 'another-project') };
    assert.equal(
      judgeRun(elsewhere, answers.image, 'confirmed'),
      false,
      'an executable name is not a confirmation of which project it was started for',
    );
    assert.equal(
      judgeRun(elsewhere, answers.image, 'possible'),
      true,
      'and picking a run back up asks the weaker question, so a bench stays running',
    );
    assert.equal(
      judgeRun({ ...record, projectPath: '' }, answers.image, 'confirmed'),
      true,
      'a record naming no project has only the executable to be judged on, either way',
    );
    assert.equal(
      judgeRun(elsewhere, null, 'possible'),
      false,
      'and an operating system that will not answer is never a yes',
    );
  } finally {
    held.kill();
    await new Promise((done) => held.once('exit', done));
  }

  // The dead pid, asked after the process is gone rather than about a number that was never
  // anything: this is the state a stale record is actually in.
  assert.equal(stillTheRecordedRun(record), false, 'a run that has ended is not still the run');
}

/**
 * The editor holding a project is not a run of that project, however exactly the record fits it.
 *
 * The identity check compares the engine and the project, and an editor of that project carries
 * both: same binary, same `--path`. So a record whose pid has come round to an editor is confirmed
 * against it, and the caller that acts on a confirmation is the one that kills. The number gets
 * there by the ordinary route rather than a rare one, because a restart ends the game and opens an
 * editor seconds later, which is when a just-freed pid is handed out again. What it looks like
 * downstream is an editor going with no crash log and nothing in its own output, which is the
 * shape one was reported in.
 *
 * Judged against written-down command lines rather than a spawned editor: the discrimination is
 * between two strings the operating system can give, and a fixture that needed a real editor to be
 * running could only ever be skipped on the machines that lack one.
 */
function testTheEditorHoldingAProjectIsNotARunOfIt(): void {
  const project = join(tmpdir(), 'gdharness-editor-vs-run');
  const engine = join(tmpdir(), 'engines', 'Godot_v4.5-stable_win64.exe');
  const record = {
    pid: 4242,
    transcript: join(tmpdir(), 'none.log'),
    startedAt: Date.now(),
    projectPath: project,
    arguments: ['--path', project],
    command: engine,
  };
  const asked = (text: string): { kind: 'commandLine'; text: string } => ({ kind: 'commandLine', text });

  // The positive first, and from the same record: an instrument that had stopped judging anything
  // would report every refusal below just as well.
  assert.equal(
    judgeRun(record, asked(`${engine} --path ${project} res://main.tscn`), 'confirmed'),
    true,
    'a game of this project under this record is the run, which is what makes the refusals below mean anything',
  );

  for (const flag of ['-e', '--editor']) {
    assert.equal(
      judgeRun(
        record,
        asked(`${engine} ${flag} --path ${project} --lsp-port 6005 --dap-port 6006`),
        'confirmed',
      ),
      false,
      `an editor of the same project (${flag}) is not the run, so nothing may be signalled at its pid`,
    );
    assert.equal(
      judgeRun(record, asked(`${engine} ${flag} --path ${project}`), 'possible'),
      false,
      `nor is it a run to be picked back up and reported as the game (${flag})`,
    );
  }

  // A worker engine of the same project, which is what a recycled number lands on here more often
  // than an editor. A fan-out opens dozens of them with `OS.create_process`: same executable, same
  // `--path`, no `-e`, so every check above confirms one. What none of them has is a start at the
  // moment this run started, and a number cannot be handed out again until the process holding it
  // has gone, so the gap is at least the length of the run.
  const worker = `${engine} --headless --log-file user://slices/slice-7.log --path ${project} res://bench.tscn`;
  assert.equal(
    judgeRun(record, { ...asked(worker), startedAt: record.startedAt + 600_000 }, 'confirmed'),
    false,
    'a worker engine that started ten minutes into this run is not this run, so nothing may be signalled at it',
  );
  // The same process, asked about as the run it is. Without this the assertion above is satisfied by
  // a check that refuses everything once a start time is offered, which would stop every stop
  // working rather than stop the wrong one.
  assert.equal(
    judgeRun(record, { ...asked(worker), startedAt: record.startedAt + 200 }, 'confirmed'),
    true,
    'and a process that started when this run did is still the run, whatever else it carries',
  );
  // And the weaker question too, which is the one exception to that question being weaker. It is
  // weaker because an image name cannot tell two engines apart, not because picking a run back up
  // deserves less care, and this is not a guess that leans one way: a process that began after the
  // record cannot be the run it describes. Left out, a worker holding a recycled number is adopted
  // and reported as the run still going.
  assert.equal(
    judgeRun(record, { ...asked(worker), startedAt: record.startedAt + 600_000 }, 'possible'),
    false,
    'nor is it a run to be picked back up and reported as still going',
  );
  assert.equal(
    judgeRun(record, { ...asked(worker), startedAt: record.startedAt + 200 }, 'possible'),
    true,
    'while the run itself is still one to pick back up',
  );
  // The short run, which is the case a generous window is blind to and the one a busy machine
  // produces. A number cannot be handed out again until the first process has gone, so the gap a
  // recycle leaves is the run's whole length: a five-second run whose number is taken ten seconds
  // later clears any window measured in minutes. A gate elsewhere runs sixteen engines at once.
  assert.equal(
    judgeRun(record, { ...asked(worker), startedAt: record.startedAt + 30_000 }, 'confirmed'),
    false,
    'a worker that took the number half a minute in is not a five-second run, so nothing may be signalled at it',
  );
  // A platform that will not say when a process started is left with the checks it had.
  assert.equal(
    judgeRun(record, asked(worker), 'confirmed'),
    true,
    'and a platform that gives no start time is no worse off than before it was asked',
  );

  // The flag as a whole word. A project whose own directory spells one is still a project, and
  // reading it as the editor would refuse to end a run that is genuinely there.
  const named = join(tmpdir(), 'gdharness--editor-demo');
  assert.equal(
    judgeRun(
      { ...record, projectPath: named, arguments: ['--path', named] },
      asked(`${engine} --path ${named} res://main.tscn`),
      'confirmed',
    ),
    true,
    'a project named for the flag is not an editor, and its game is still endable',
  );
}

/**
 * A run whose server went away is answered with what it printed, not with "No game is running".
 *
 * The MCP server reconnects on its own schedule. Everything about a run used to live in that
 * process, so a reconnect killed the game and took the log with it, and `editor_output`
 * afterwards said no game was running: true about the process, and silent about the forty
 * minutes of bench output that had just been dropped. A project lost two sweeps this way in one
 * session, a six-setting one after a single row and a nine-cell one after five cells.
 *
 * Asserted from the disk side, with no engine in it, because the half worth pinning here is what
 * a fresh server does with a run it did not start: read the note, read the transcript, and say
 * which of the two kinds of not-running this is. A run that ended with nobody waiting on it has
 * no exit code anywhere, and saying so beats reporting a zero nobody collected.
 */
async function testARunEndedUnwatchedIsStillReadable(): Promise<void> {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'gdharness-unwatched-'));
  try {
    const runs = join(runtimeDir, 'runs');
    mkdirSync(runs, { recursive: true });
    const transcript = join(runs, 'run-1.log');
    writeFileSync(
      transcript,
      'row 1: 42 wins\nERROR: the bench fell over\n   at: res://bench.gd:12\nrow 2: 17 wins\n',
    );

    // A process that has certainly ended: spawned to exit at once and waited for right here, so
    // the number names nothing by the time the server reads it.
    const ended: SpawnSyncReturns<string> = spawnSync(process.execPath, ['-e', ''], {
      encoding: 'utf8',
    });
    assert.ok(ended.pid > 0, 'the fixture needs a process that has been and gone');

    writeFileSync(
      join(runs, 'run.json'),
      JSON.stringify({
        pid: ended.pid,
        transcript,
        startedAt: Date.now() - 60_000,
        projectPath: join(runtimeDir, 'project'),
        arguments: ['--headless', '--path', join(runtimeDir, 'project')],
      }),
      'utf8',
    );

    await withStdioServer(
      async (call) => {
        const answered = await call('editor_output', { limit: 200 });
        assert.doesNotMatch(
          answered,
          /No game/,
          `a run the server did not start is still a run it can answer about: ${answered}`,
        );
        const output: unknown = jsonOf(answered, 'editor_output');
        assert.equal(get(output, 'running'), false, JSON.stringify(output));
        assert.equal(get(output, 'endedUnwatched'), true, JSON.stringify(output));
        assert.equal(
          get(output, 'exitCode'),
          null,
          `nobody was waiting on it, so there is no code to report: ${JSON.stringify(output)}`,
        );
        assert.equal(get(output, 'errors'), 1, JSON.stringify(output));
        assert.equal(
          get(output, 'transcript'),
          transcript,
          `the file holding the whole run is named, since the entries are capped and it is not: ${JSON.stringify(output)}`,
        );

        // And when the cap actually drops something, the answer says where the rest is rather than
        // leaving a count of what it left out. A project watching a long bench went looking for a
        // second channel and found the engine's own log, which every engine start rotates away.
        const capped: unknown = JSON.parse(await call('editor_output', { limit: 1 }));
        assert.ok(asNumber(get(capped, 'omitted')) > 0, JSON.stringify(capped));
        assert.match(
          text(get(capped, 'note')),
          /Everything this run has printed is in .*run-1\.log/,
          `a capped answer points at the uncapped file: ${JSON.stringify(capped)}`,
        );

        const printed = asArray(get(output, 'entries')).map((entry) => text(get(entry, 'text')));
        assert.ok(
          printed.some((line) => line.includes('row 1: 42 wins')),
          `every row it printed is still readable:\n${JSON.stringify(output, null, 2)}`,
        );
        assert.ok(
          printed.some((line) => line.includes('row 2: 17 wins')),
          `including the ones after the error:\n${JSON.stringify(output, null, 2)}`,
        );
      },
      { GDHARNESS_RUNTIME_DIR: runtimeDir, GDHARNESS_PROJECT: join(runtimeDir, 'project') },
    );

    // A server that cannot name a project at all does not get to claim this one either, which is
    // the half that was missing. "I have no project" used to read as "any record is mine", so a
    // regression suite, whose servers are started exactly like this, adopted a bench belonging to
    // another project on this machine and ended it to start its own: six times in fifty minutes,
    // silently, while its owner bisected their own code. The note says whose the run is; a server
    // that cannot answer that question answers the one it can.
    await withStdioServer(
      async (call) => {
        const said = await call('editor_output', { limit: 200 });
        assert.match(
          said,
          /No game of this server's is running/,
          'a server with no project of its own owns no run it merely found',
        );
        // And says which of the two it is. "No game is running" would be true about this server
        // and false about the machine, which is how somebody who has just started a game reads an
        // answer about somebody else's run as an answer about theirs.
        assert.match(said, /is recorded on this machine/, `the run that is there is named: ${said}`);
        assert.match(said, /without GDHARNESS_PROJECT/, `and why it is not this server's: ${said}`);
      },
      { GDHARNESS_RUNTIME_DIR: runtimeDir },
    );

    // The note is per machine, not per project, so a server serving something else must not
    // answer about this run. The right shape about the wrong game is the worst answer available.
    await withStdioServer(
      async (call) => {
        const said = await call('editor_output', { limit: 200 });
        assert.match(
          said,
          /No game of this server's is running/,
          'a run recorded against another project is not this server’s to report',
        );
        assert.match(said, /this server serves .*elsewhere/, `naming what it does serve: ${said}`);
        // Ending it is the half that matters: this is the call that used to kill it.
        // Without a projectPath, because stop is about the run this server is holding and the
        // refusal comes from whose the recorded run is, not from what the caller said it was.
        const refused = await call('editor_run', { op: 'stop' });
        assert.match(refused, /not this server's to answer for or to end/, refused);
        // The third situation, which this answered as either of the other two. A game the editor
        // is playing is reached by asking the editor, so with none connected a run that is alive
        // on screen is invisible here. Ordinary rather than exotic now that a played game outlives
        // a reconnect: the addon takes up to half a minute to dial back in, and during that window
        // a caller is told nothing is running about a game they are watching. Reported downstream
        // by a session that killed its own game by pid rather than tell the two apart.
        assert.match(refused, /No editor is connected/, `the reason it cannot see one: ${refused}`);
        assert.match(
          refused,
          /editor_status says whether one is on its way/,
          `and what to read to know when it can: ${refused}`,
        );
      },
      { GDHARNESS_RUNTIME_DIR: runtimeDir, GDHARNESS_PROJECT: join(runtimeDir, 'elsewhere') },
    );
  } finally {
    sweep(runtimeDir);
  }
}

/**
 * A live run belonging to somewhere else is still printing after a start that is not its own.
 *
 * The ownership guard is asserted elsewhere against a record naming a process that has been and
 * gone, which proves the refusal is reachable and nothing more: a dead pid is refused by every
 * guard there is, including ones that are not about ownership at all, so that fixture would pass
 * against a build that signals every live foreign run it finds. The incident was a live one.
 *
 * `editor_run start` is the call that did it. It ends whatever `currentRun()` says is going before
 * it decides how to start anything, which is above the engine and above the editor, so this needs
 * neither: what is being measured is whether the foreign process is alive afterwards.
 *
 * Alive is asserted by what the bench writes, not by asking whether the pid is still there. The
 * fix's own `alive()` would be answering a question about itself, and a process can be a corpse
 * the operating system has not finished burying. A bench that has printed since the call is a
 * bench that was still running when the call went through it.
 */
async function testAForeignRunSurvivesAStart(): Promise<void> {
  const theirs = await benchThroughAStart('theirs');
  assert.doesNotMatch(
    theirs.answer,
    /endedPreviousRun/,
    `a start of this server's own project ends no run of anybody else's: ${theirs.answer}`,
  );
  assert.ok(theirs.keptPrinting, 'a bench recorded against another project should still be printing');
  assert.equal(theirs.exitCode, null, 'and should not have been signalled');

  // The same instrument against a run this server does own, which is what makes the assertions
  // above mean anything. Without it they are satisfied by a start that ends nothing at all: a
  // broken `endActiveGame`, an `editor_run` that refuses everything, a server that never read the
  // record. The guard is that this run is somebody else's, so the witness is the same call
  // killing the same bench when it is not.
  const ours = await benchThroughAStart('mine');
  assert.match(ours.answer, /endedPreviousRun/, `a start does end this server's own run: ${ours.answer}`);
  assert.equal(ours.keptPrinting, false, 'and the bench standing in for it stops printing');
}

/**
 * A live bench recorded as belonging to `owner`, put through one `editor_run start` of `mine`.
 *
 * Alive is reported by what the bench writes, not by asking whether the pid is still there. The
 * fix's own `alive()` would be answering a question about itself, and a process can be a corpse
 * the operating system has not finished burying.
 */
async function benchThroughAStart(
  owner: 'mine' | 'theirs',
): Promise<{ answer: string; keptPrinting: boolean; exitCode: number | null }> {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'gdharness-foreign-runtime-'));
  const mine = join(runtimeDir, 'mine');
  const ticks = join(runtimeDir, 'bench.log');
  mkdirSync(join(runtimeDir, 'runs'), { recursive: true });
  mkdirSync(mine, { recursive: true });
  mkdirSync(join(runtimeDir, 'theirs'), { recursive: true });
  // A runnable project, not just a directory with a project.godot in it. A start that refuses for
  // want of a main scene never reaches the block that ends the recorded run, so the foreign half
  // of this fixture would pass against a server that kills everything it finds.
  writeFileSync(
    join(mine, 'project.godot'),
    '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="Mine"\n' +
      'run/main_scene="res://main.tscn"\n',
  );
  writeFileSync(join(mine, 'main.gd'), 'extends Node\n');
  writeFileSync(
    join(mine, 'main.tscn'),
    '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n' +
      '[node name="Main" type="Node"]\nscript = ExtResource("1")\n',
  );

  // It prints as it goes and does not stop, which is the shape of the run that was being lost and
  // the only thing here that can testify to being alive. It carries the recorded project on its
  // command line because that is what makes it the recorded run rather than a pid that matches:
  // a bench the identity check disowns would be spared for a reason this fixture is not about.
  const recorded = join(runtimeDir, owner);
  const bench = spawn(
    process.execPath,
    [
      // The long spelling of the eval flag: `-e` is how the engine this stands in for is told to
      // come up as an editor, and an editor is disowned by the identity check for a reason this
      // fixture is not about.
      '--eval',
      "const {appendFileSync}=require('node:fs');" +
        `setInterval(() => appendFileSync(${JSON.stringify(ticks)}, 'tick\\n'), 25);`,
      recorded,
    ],
    { stdio: 'ignore' },
  );
  const benchPid = bench.pid;
  assert.ok(benchPid !== undefined, 'the fixture needs a live process to stand in for the bench');
  // When the bench actually started, rather than a round number in the past. A record is written by
  // the call that spawned the engine, so the two are the same moment, and a note claiming a run
  // began a minute before its own process describes a state that cannot occur. The identity check
  // reads exactly that gap to tell a run from a number that came round to something else, so a
  // fixture backdating it is asking to be disowned for a reason it is not about.
  const startedAt = Date.now();

  try {
    writeFileSync(
      join(runtimeDir, 'runs', 'run.json'),
      JSON.stringify({
        pid: benchPid,
        command: process.execPath,
        transcript: join(runtimeDir, 'recorded-run.log'),
        startedAt,
        projectPath: recorded,
        arguments: ['--headless', '--path', recorded],
      }),
      'utf8',
    );

    const printed = (): number => (existsSync(ticks) ? readFileSync(ticks, 'utf8').length : 0);
    // Waited for rather than assumed: a bench that had not yet written its first line would make
    // the comparison below read as dead whatever happened to it.
    for (let waited = 0; printed() === 0 && waited < 2000; waited += 25) await delay(25);
    assert.ok(printed() > 0, 'the bench should be printing before anything is asked of the server');

    let answer = '';
    await withStdioServer(
      async (call) => {
        answer = await call('editor_run', { op: 'start', projectPath: mine, headless: true });
      },
      { GDHARNESS_RUNTIME_DIR: runtimeDir, GDHARNESS_PROJECT: mine, GODOT_PATH: process.execPath },
    );

    const afterwards = printed();
    await delay(250);
    return { answer, keptPrinting: printed() > afterwards, exitCode: bench.exitCode };
  } finally {
    bench.kill('SIGKILL');
    sweep(runtimeDir);
  }
}

/**
 * The run keeps going when the server that started it is killed, and the next one picks it up.
 *
 * The reproduction as it was reported: start a headless run, have the server go away under it,
 * and find the game dead and its output gone. A run started through `editor_run start` outliving
 * a reconnect is the whole ask, so this kills the server outright, which is the worst version of
 * what a reconnect does, and then asks a fresh server what is running.
 */
async function testARunOutlivesItsServer(): Promise<void> {
  const godotPath = resolveGodotPath();
  if (!godotPath) {
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and GODOT_PATH names no existing file.');
    }
    console.log('run-outlives-server regression skipped (Godot not found)');
    return;
  }

  const runtimeDir = mkdtempSync(join(tmpdir(), 'gdharness-outlives-runtime-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'gdharness-outlives-'));
  // The project is named, as every configured server names it: picking a run back up is a claim
  // about whose run it is, and a server that cannot make that claim does not get to.
  const env = {
    GODOT_PATH: godotPath,
    GDHARNESS_RUNTIME_DIR: runtimeDir,
    GDHARNESS_PROJECT: projectDir,
  };
  let gamePid: number | null = null;
  try {
    writeFileSync(
      join(projectDir, 'project.godot'),
      '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="Outlives"\nrun/main_scene="res://main.tscn"\n',
    );
    // Prints as it goes and keeps going, which is the shape of the bench that was being lost:
    // rows land one at a time and the run is expected to still be there between them.
    writeFileSync(
      join(projectDir, 'main.gd'),
      'extends Node\n\nvar rows := 0\n\n\nfunc _process(_delta: float) -> void:\n\trows += 1\n\tif rows % 30 == 0:\n\t\tprint("row %d" % [rows / 30])\n',
    );
    writeFileSync(
      join(projectDir, 'main.tscn'),
      '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n[node name="Main" type="Node"]\nscript = ExtResource("1")\n',
    );

    const first = new ServerProcess({ env });
    try {
      await first.initialize('regression-test');
      const started: unknown = parseTextContent(
        await first.request(
          'tools/call',
          {
            name: 'editor_run',
            arguments: { projectPath: projectDir, op: 'start', headless: true },
          },
          ENGINE_CALL_TIMEOUT_MS,
        ),
      );
      assert.equal(get(started, 'started'), true, JSON.stringify(started));
      gamePid = asNumber(get(started, 'pid'), 'the run needs a process of its own');
      assert.ok(gamePid > 0, `the run needs a process: ${JSON.stringify(started)}`);
    } finally {
      // A reconnect as the harness actually performs one: stdin ends, and the server shuts itself
      // down through the same path a SIGINT takes. Not a kill, which is the weaker test and the
      // wrong one. A killed server runs no shutdown at all, so it cannot exercise the thing that
      // used to end these runs: the server killed the game itself on the way out, deliberately,
      // in its own cleanup. Reintroducing that line would leave a SIGKILL test green and every
      // real reconnect fatal, which is how this was shipped in the first place. Ending stdin is
      // also the only portable way to ask for a graceful stop: on Windows a SIGTERM through Node
      // is a TerminateProcess and runs no handlers either.
      first.child.stdin?.end();
    }
    await new Promise<void>((gone) => {
      if (first.exited) {
        gone();
        return;
      }
      first.child.once('exit', () => {
        gone();
      });
      // Not left to hang if the shutdown path is what broke: the assertions below say more about
      // why than a test that times out with nothing printed.
      setTimeout(() => {
        first.child.kill();
        gone();
      }, 15_000);
    });
    await delay(1500);

    assert.ok(
      alive(gamePid),
      'the game is the operating system’s, not the server’s: killing the server must not take it',
    );

    await withStdioServer(async (call) => {
      let output: unknown = null;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await delay(200);
        const answered = await call('editor_output', { limit: 200 }, ENGINE_CALL_TIMEOUT_MS);
        assert.doesNotMatch(
          answered,
          /No game is running/,
          'the run the previous server started is the run this one answers about',
        );
        output = JSON.parse(answered);
        if (asArray(get(output, 'entries')).length > 0) {
          break;
        }
      }

      assert.equal(get(output, 'running'), true, JSON.stringify(output));
      // A live run is the only time processor time could be answered, so it is the only time an
      // unasked read could go and get it. Answering it on every read costs a subprocess, and on
      // Windows that is a PowerShell start: in this path it slowed each call enough to time others
      // out, and what failed were the fixtures that ask Windows about a process, queueing behind
      // the same mechanism. Asserted here rather than beside a run that has finished, where the
      // field is absent whatever the default is and the check could never fail.
      assert.ok(
        !Object.hasOwn(output as Record<string, unknown>, 'cpuSeconds'),
        `a read that did not ask for processor time does not go and get it: ${JSON.stringify(output)}`,
      );
      const printed = asArray(get(output, 'entries')).map((entry) => text(get(entry, 'text')));
      assert.ok(
        printed.some((line) => /row \d+/.test(line)),
        `what it printed while no server was reading is there too:\n${JSON.stringify(output, null, 2)}`,
      );

      const stopped: unknown = JSON.parse(await call('editor_run', { op: 'stop' }, ENGINE_CALL_TIMEOUT_MS));
      assert.equal(get(stopped, 'stopped'), true, JSON.stringify(stopped));
      assert.equal(
        get(stopped, 'exitedBeforeStop'),
        false,
        `a run that was going when the stop came is said to have been ended by it: ${JSON.stringify(stopped)}`,
      );
    }, env);

    await delay(1000);
    assert.equal(alive(gamePid), false, 'and a run with no handle is still one that stop can end');
    gamePid = null;
  } finally {
    if (gamePid !== null && alive(gamePid)) {
      try {
        process.kill(gamePid);
      } catch {
        // Nothing left to clean up.
      }
    }
    sweep(projectDir, runtimeDir);
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
        '',
        'func test_the_game_said_something() -> void:',
        '\tpush_error("the game minded about something")',
        '\tassert_bool(true).is_true()',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(projectDir, 'test', 'quiet_test.gd'),
      [
        'extends GdUnitTestSuite',
        '',
        '',
        'func test_nothing_went_wrong() -> void:',
        '\tassert_bool(true).is_true()',
        '',
      ].join('\n'),
    );
    // A suite whose failures are only failures, with no error beside them, because that is the
    // shape gdUnit4 summarises as passed while reporting them. Measured on 4.7.2 with gdUnit4
    // v6.2.1, in a project built for the purpose:
    //
    //   Statistics: 7 test cases | 0 errors | 3 failures | 0 flaky | 0 skipped | 0 orphans | PASSED
    //
    // The counts on that line are right and the word at the end is not, so a verdict read off it
    // is wrong in the direction that matters. Nothing here reads it: the verdict comes from the
    // statuses in the JUnit report and the exit code, which was 100. This suite is here so that a
    // future reader of that console line is caught by a test rather than by a green tier.
    writeFileSync(
      join(projectDir, 'test', 'summary_lies_test.gd'),
      [
        'extends GdUnitTestSuite',
        '',
        '',
        'func test_the_summary_says_passed() -> void:',
        '\tassert_int(2 + 2).is_equal(5)',
        '',
        '',
        'func test_and_says_it_again() -> void:',
        '\tassert_int(2 + 2).is_equal(6)',
        '',
      ].join('\n'),
    );

    await withStdioServer(
      async (call) => {
        const missing = await call('project_test', { projectPath: projectDir }, ENGINE_CALL_TIMEOUT_MS);
        assert.match(missing, /gdUnit4 is not installed/, missing);

        cpSync(gdunit, join(projectDir, 'addons', 'gdUnit4'), { recursive: true });

        // A report from another run of this project, which is what a second project_test is.
        // Numbered above anything this run will write, because the reading takes the highest it
        // finds: while the directory was one path per project, this was read as this run's own
        // answer and then deleted along with the rest. The counts below are the other half of
        // the check, since reading this one instead would make them 99.
        const elsewhere = join(projectDir, '.godot', 'gdharness-reports', 'report_999');
        mkdirSync(elsewhere, { recursive: true });
        writeFileSync(
          join(elsewhere, 'results.xml'),
          '<testsuites tests="99" failures="99" errors="0" skipped="0">\n<testsuite name="not_ours" tests="99" failures="99" errors="0" skipped="0"/>\n</testsuites>\n',
        );

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
          { tests: 7, failures: 3, errors: 0, skipped: 1 },
        );
        assert.ok(
          existsSync(join(elsewhere, 'results.xml')),
          "and should leave the other run's report where it found it",
        );
        // Whether the run's saves were moved is said on the platform where they were not, and
        // left unsaid where they were: both halves from the same function the engine probe holds
        // its expectation against, so the three cannot disagree.
        assert.equal(
          get(run, 'savesNote'),
          savesStayPut() ? SAVES_NOT_MOVED_NOTE : undefined,
          `${process.platform}: the answer says whether its saves were moved: ${text(get(run, 'savesNote'))}`,
        );

        // By name rather than by position: two suites fail here, and which of them gdUnit4 runs
        // first is not something this fixture is about.
        const failed = asArray(get(run, 'failed')).find(
          (entry) => get(entry, 'name') === 'test_two_and_two_is_not_five',
        );
        assert.ok(failed !== undefined, JSON.stringify(get(run, 'failed'), null, 2));
        assert.equal(get(failed, 'path'), 'res://test/sums_test.gd');
        assert.match(text(get(failed, 'message')), /sums_test\.gd:9/);
        assert.match(text(get(failed, 'detail')), /Expecting:\s+5\s+but was\s+4/);
        // The suite whose own summary line calls itself passed is reported failed, because the
        // verdict is read from the statuses rather than from that word.
        assert.ok(
          asArray(get(run, 'failed')).some(
            (entry) => get(entry, 'path') === 'res://test/summary_lies_test.gd',
          ),
          JSON.stringify(get(run, 'failed'), null, 2),
        );
        // The suite that passed everything is counted, not listed: a tier of them is otherwise
        // most of the answer.
        const named = asArray(get(run, 'suites'))
          .map((suite) => text(get(suite, 'name')))
          .sort();
        assert.deepEqual(named, ['summary_lies_test', 'sums_test'], JSON.stringify(named));
        assert.equal(get(run, 'suitesPassed'), 1);
        // And an engine message keeps the frames above gdUnit4 and says how many it left inside.
        const said = asArray(get(run, 'engineEntries')).find((entry) =>
          text(get(entry, 'text')).includes('the game minded about something'),
        );
        assert.ok(said !== undefined, JSON.stringify(get(run, 'engineEntries')));
        const frames = asArray(get(said, 'detail')).map(text);
        assert.ok(
          frames.some((line) => line.includes('test_the_game_said_something')),
          frames.join('\n'),
        );
        assert.equal(
          frames.filter((line) => line.includes('addons/gdUnit4/src')).length,
          0,
          frames.join('\n'),
        );
        assert.match(frames.at(-1) ?? '', /^\[and \d+ frames inside addons\/gdUnit4\/\]$/);
        assert.ok(
          asArray(get(run, 'classes', 'added')).includes('GdUnitTestCIRunner'),
          'the runner was made resolvable by the class list rebuild',
        );
        // This run's report is cleaned up and the other run's is still there. Asserted as the
        // whole listing, because the way this read before was that the shared directory had gone
        // altogether, which was true only because a run took every other run's reports with it.
        assert.deepEqual(
          readdirSync(join(projectDir, '.godot', 'gdharness-reports')),
          ['report_999'],
          'the report this run wrote is cleaned up, and nothing else is',
        );

        const only: unknown = JSON.parse(
          await call(
            'project_test',
            {
              projectPath: projectDir,
              ignore: [
                'sums_test:test_two_and_two_is_not_five',
                'summary_lies_test:test_the_summary_says_passed',
                'summary_lies_test:test_and_says_it_again',
              ],
            },
            ENGINE_CALL_TIMEOUT_MS * 3,
          ),
        );
        assert.equal(get(only, 'passed'), true, JSON.stringify(only, null, 2));
        assert.equal(get(only, 'tests'), 4);
        // Nothing stopped early in the runs above, and the answer says so by leaving the field
        // out. Asserted here so the presence of it below means something.
        assert.equal(get(run, 'notRun'), undefined, JSON.stringify(run, null, 2));

        // gdUnit4 stops a suite at its first failing case unless it is told not to, and gdharness
        // asks it not to unless `failFast` says otherwise. The counts are then of what ran, which
        // an answer that reported the suite's own `tests` attribute contradicted: the totals said
        // two ran while the suite beside them said nine tests and one failure, which reads as
        // eight passes that never happened.
        const stopped: unknown = JSON.parse(
          await call('project_test', { projectPath: projectDir, failFast: true }, ENGINE_CALL_TIMEOUT_MS * 3),
        );
        assert.equal(get(stopped, 'passed'), false, JSON.stringify(stopped, null, 2));
        // Read before it is a number, so a run that omitted the field fails saying that rather
        // than failing inside asNumber about a type.
        const left = get(stopped, 'notRun');
        assert.ok(
          typeof left === 'number' && left > 0,
          `a run that stopped early says how many cases it left: ${JSON.stringify(stopped, null, 2)}`,
        );
        const leftOver = left;
        assert.ok(
          asNumber(get(stopped, 'tests')) < asNumber(get(run, 'tests')),
          `and runs fewer than the whole set: ${JSON.stringify(stopped, null, 2)}`,
        );
        assert.match(text(get(stopped, 'note')), /never ran/, text(get(stopped, 'note')));
        // Every suite's own numbers count what ran, so the totals and the suites agree.
        for (const suite of asArray(get(stopped, 'suites'))) {
          const ran = asNumber(get(suite, 'tests'));
          const missed = get(suite, 'notRun') === undefined ? 0 : asNumber(get(suite, 'notRun'));
          assert.ok(
            ran >= asNumber(get(suite, 'failures')) + asNumber(get(suite, 'errors')),
            `a suite never reports more failures than cases it ran: ${JSON.stringify(suite)}`,
          );
          assert.ok(missed >= 0, JSON.stringify(suite));
        }
        assert.equal(
          asArray(get(stopped, 'suites')).reduce<number>(
            (sum, suite) => sum + (get(suite, 'notRun') === undefined ? 0 : asNumber(get(suite, 'notRun'))),
            0,
          ),
          leftOver,
          'the total left behind is the sum of what each suite left',
        );

        // A path with nothing at it. gdUnit4 finds nothing, exits 0 and says why, so a verdict
        // read off the exit code called this a pass: the one word a skimming reader must never
        // be handed for a tier that never ran. Met in a project whose suites live in `tests`
        // while the default here is `test`, which is one letter and a whole false green.
        const nowhere = await call(
          'project_test',
          { projectPath: projectDir, path: 'res://tests' },
          ENGINE_CALL_TIMEOUT_MS * 3,
        );
        const note = nowhere.slice(0, nowhere.indexOf('{'));
        assert.doesNotMatch(note, /passed/, note);
        assert.match(note, /No tests ran/, note);
        assert.match(note, /res:\/\/test\b/, note);
        const empty: unknown = JSON.parse(nowhere.slice(nowhere.indexOf('{')));
        assert.equal(get(empty, 'passed'), false, nowhere);
        assert.equal(get(empty, 'verdict'), 'nothing at res://tests', nowhere);
        assert.equal(get(empty, 'tests'), 0, nowhere);
      },
      { GODOT_PATH: godotPath },
    );
  } finally {
    sweep(projectDir);
  }
}

/**
 * The CLI against a real engine: setup puts the addons in and turns the editor ones on,
 * runtime on and off registers and removes the autoload, and doctor says so, then says what
 * is wrong once something is.
 */
/**
 * A project whose engine is only in its own configuration is still upgradable.
 *
 * A project that vendors Godot under its own root, verified and kept off PATH deliberately, has
 * nowhere for the usual search to look: `.mcp.json`'s `env.GODOT_PATH` is the whole record of
 * where the engine is, and gdharness is what wrote it there. `upgrade` read that file, quoted it
 * back in its own output, refused for want of the value in it, and on the next attempt copied that
 * value through to the new config untouched.
 *
 * Driven with the variable unset, because the fault is only reachable when the search fails: with
 * `GODOT_PATH` in the environment every path here passes whether or not the config is ever read.
 */
function testAnUpgradeReadsTheEngineOutOfTheConfigItRewrites(): void {
  const godotPath = resolveGodotPath();
  if (!godotPath) {
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and GODOT_PATH names no existing file.');
    }
    console.log('config engine path regression skipped (Godot not found)');
    return;
  }
  const projectDir = mkdtempSync(join(tmpdir(), 'gdharness-vendored-'));
  // Every variable the search reads, taken away, so the only place the engine is named is the
  // file the command is about to rewrite.
  const { GODOT_PATH: _path, GODOT: _godot, PATH: _search, Path: _windowsPath, ...blind } = process.env;
  const cli = (...cliArgs: string[]): { status: number | null; output: string } => {
    const run = spawnSync(process.execPath, ['build/cli.js', ...cliArgs], {
      encoding: 'utf8',
      timeout: 180000,
      env: blind,
    });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  };
  try {
    writeFileSync(
      join(projectDir, 'project.godot'),
      '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="Vendored"\n',
    );
    const mcp = join(projectDir, '.mcp.json');
    writeFileSync(
      mcp,
      `${JSON.stringify(
        {
          mcpServers: {
            gdharness: {
              command: 'npx',
              args: ['-y', 'gdharness@0.0.1'],
              env: { GODOT_PATH: godotPath, GDHARNESS_PROJECT: projectDir },
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    // Installed, so upgrade has something to upgrade from, and written without the search too.
    const first = cli('setup', projectDir, '--no-connect');
    assert.equal(first.status, 0, `setup should find the engine in the config: ${first.output}`);

    const upgraded = cli('upgrade', projectDir);
    assert.equal(
      upgraded.status,
      0,
      `upgrade should not refuse for a path it is holding: ${upgraded.output}`,
    );
    assert.match(upgraded.output, /replaced .*gdharness_editor/, upgraded.output);
    // And the value it read is still the value it writes, which is what made the refusal absurd.
    assert.equal(
      text(get(JSON.parse(readFileSync(mcp, 'utf8')), 'mcpServers', 'gdharness', 'env', 'GODOT_PATH')),
      godotPath,
      'the engine path should come through the rewrite unchanged',
    );

    // A machine-wide config may have been written for another project, so its engine is not this
    // project's to borrow: with the entry gone from the project's own file there is nothing left
    // to read, and the refusal is the right answer again.
    rmSync(mcp);
    const refused = cli('classes', projectDir);
    assert.notEqual(
      refused.status,
      0,
      `with nothing recording the engine it should refuse: ${refused.output}`,
    );
    assert.match(refused.output, /No Godot executable found/, refused.output);
  } finally {
    sweep(projectDir);
  }
}

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
      sweep(bare);
    }

    // An upgrade puts the same things back in the same places. It once wrote the skill into every
    // directory any harness could read it from, rather than the ones an install chose, so running
    // it created two directories that setup had deliberately not created. Nothing new appears.
    const skillDirs = (): string[] =>
      ['.agents', '.claude', '.github', '.cursor', '.kiro', '.cline', '.opencode']
        .map((dir) => join(projectDir, dir, 'skills', 'gdharness'))
        .filter((path) => existsSync(path))
        .sort();
    // A project that brings the runtime up its own way keeps doing so across an upgrade.
    //
    // project.godot is committed and addons/ often is not, so the install guide tells projects to
    // point this entry at a script of their own that brings the addon up when it is there and does
    // nothing when it is not. Repointing it at the addon takes away the one refusal the addon
    // cannot make for itself, and does it to the file written to keep it. Nothing fails: the
    // wrapper is still on disk and correct, and no gate asks what project.godot registers, so one
    // project found it in git status after twelve green ones, having been told about five other
    // replacements and not this.
    const guard = join(projectDir, 'boot');
    mkdirSync(guard, { recursive: true });
    writeFileSync(
      join(guard, 'gdharness_loader.gd'),
      'extends Node\n\n\nfunc _ready() -> void:\n\tif OS.has_feature("template"):\n\t\treturn\n',
    );
    const project = join(projectDir, 'project.godot');
    writeFileSync(
      project,
      readFileSync(project, 'utf8').replace(
        /GdharnessRuntime="\*res:\/\/addons\/gdharness_runtime\/runtime_autoload\.gd"/,
        'GdharnessRuntime="*res://boot/gdharness_loader.gd"',
      ),
    );

    const beforeUpgrade = skillDirs();
    const upgraded = cli('upgrade', projectDir);
    assert.equal(upgraded.status, 0, `upgrade:\n${upgraded.stdout}${upgraded.stderr}`);
    assert.match(
      readFileSync(project, 'utf8'),
      /GdharnessRuntime="\*res:\/\/boot\/gdharness_loader\.gd"/,
      'an upgrade leaves an autoload it did not write where the project put it',
    );
    assert.match(
      upgraded.stdout,
      /boot\/gdharness_loader\.gd/,
      'and names it, since being specific about five replacements and silent about this one is what cost a project a day',
    );
    // The same guard reached through a name instead of a path. A project is free to call its
    // loader anything, and one calls it GdharnessLoader, so every check for "is the runtime
    // registered" answers no: registering would put the addon's own script in the tree beside the
    // guard rather than behind it. Found by the path, since the name is the part a project chooses.
    writeFileSync(
      project,
      readFileSync(project, 'utf8').replace(
        /GdharnessRuntime="\*res:\/\/boot\/gdharness_loader\.gd"/,
        'GdharnessLoader="*res://boot/gdharness_loader.gd"',
      ),
    );
    const underAnotherName = cli('runtime', 'on', projectDir);
    assert.equal(underAnotherName.status, 0, `runtime on:\n${underAnotherName.stdout}`);
    assert.doesNotMatch(
      readFileSync(project, 'utf8'),
      /GdharnessRuntime=/,
      'a loader registered under another name is not joined by a second entry',
    );
    assert.match(underAnotherName.stdout, /GdharnessLoader autoload already names/, underAnotherName.stdout);

    // And the doctor says the runtime is brought up, naming the file that does it. It used to
    // answer "not registered" about a runtime that was binding a port and serving queries, because
    // the only question it asked was whether an entry under our own name existed.
    const seen = cli('doctor', projectDir);
    assert.match(
      seen.stdout,
      /runtime autoload: registered through res:\/\/boot\/gdharness_loader\.gd, as GdharnessLoader/,
      `doctor names the entry that brings it up: ${seen.stdout}`,
    );

    // Turning it off when the project brings the runtime up its own way. There is nothing of ours
    // registered, and the engine refuses to remove an autoload that is not there, so this used to
    // fail with "Autoload not found: GdharnessRuntime": a command that could not succeed, about an
    // entry the project never had, run by somebody getting ready to ship. It succeeds and says
    // what is actually there, because the loader is the project's line and not this tool's.
    const off = cli('runtime', 'off', projectDir);
    assert.equal(off.status, 0, `runtime off:\n${off.stdout}${off.stderr}`);
    assert.match(off.stdout, /nothing to remove/, off.stdout);
    assert.match(
      off.stdout,
      /GdharnessLoader names res:\/\/boot\/gdharness_loader\.gd/,
      `the loader still bringing it up is said out loud: ${off.stdout}`,
    );

    writeFileSync(
      project,
      readFileSync(project, 'utf8').replace(
        /GdharnessLoader="\*res:\/\/boot\/gdharness_loader\.gd"/,
        'GdharnessRuntime="*res://boot/gdharness_loader.gd"',
      ),
    );

    // A wrapper that is not on disk is still not rewritten, because a file can be absent for a
    // moment and a rewritten line is gone for good. But it is said, since an entry naming nothing
    // boots the project with a missing script and "left as it is" alone would read as approval.
    rmSync(join(guard, 'gdharness_loader.gd'));
    const orphaned = cli('runtime', 'on', projectDir);
    assert.equal(orphaned.status, 0, `runtime on:\n${orphaned.stdout}${orphaned.stderr}`);
    assert.match(
      readFileSync(project, 'utf8'),
      /GdharnessRuntime="\*res:\/\/boot\/gdharness_loader\.gd"/,
      'a missing wrapper is still the project’s line to own',
    );
    assert.match(
      orphaned.stdout,
      /that file is not in this project/,
      'and the answer says the entry names nothing, rather than reading as approval',
    );

    // Back to ours, so everything after this reads the project the rest of the test expects.
    writeFileSync(
      project,
      readFileSync(project, 'utf8').replace(
        /GdharnessRuntime="\*res:\/\/boot\/gdharness_loader\.gd"/,
        'GdharnessRuntime="*res://addons/gdharness_runtime/runtime_autoload.gd"',
      ),
    );
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
    sweep(projectDir);
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
    sweep(projectDir);
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
  //
  // [param least] is what the file holds today, not a loose minimum, because a floor well under
  // the real count catches an emptied reading and not a shortened one. The sets read here drive
  // the checks that find a command nothing sends, so a reader quietly returning six fewer entries
  // stops looking for six of them and still passes. Adding an operation does not trip this;
  // removing one deliberately means lowering the number here in the same change, which is the
  // point at which somebody confirms the removal was meant.
  assert.ok(
    found.size >= least,
    `only ${found.size} of the ${what} were read from ${path}, which should hold at least ${least}: either the pattern no longer matches how they are written, or one was removed and this floor needs lowering with it`,
  );
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
    31,
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
    31,
  );
  // Most are sent by name at the call; the ones a caller reaches with `from: "editor"` are sent
  // out of a table, so the table is where they are read from rather than the source around it.
  const bridged = new Set([
    ...namesSent(/(?:[Bb]ridge|invokeTool)\(\s*'([a-z_]+)'/g, 'editor commands', 25),
    ...Object.values(EDITOR_READS).flatMap((ops) => Object.values(ops)),
  ]);
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
    21,
  );
  const asked = namesSent(
    /(?:handleRuntimeCommand|runtimeRequest)\([^,]*,?\s*'([a-z_]+)'/g,
    'runtime commands',
    6,
  );
  // runtime_input builds the command from the op, so the op list is what has to line up. The two
  // named here send a command of their own rather than an injected event, and both are already in
  // `asked` for that reason.
  const NAMED_THEMSELVES = new Set(['click', 'choose']);
  const input = TOOL_SPECS.find((spec) => spec.name === 'runtime_input');
  assert.ok(input, 'runtime_input should be a tool');
  // The exemption held against the thing it exempts, so it cannot outlive it. Subtracting a name
  // that is no longer an op removes nothing and says nothing, which is the quiet way for a list
  // like this to stop meaning anything: the op it was written for is gone and the entry survives.
  for (const op of NAMED_THEMSELVES) {
    assert.ok(
      Object.hasOwn(input.operations ?? {}, op),
      `${op} is exempted from the injected commands and is not an op of runtime_input`,
    );
    assert.ok(asked.has(op), `${op} is exempted because it sends a command of its own, and nothing sends it`);
  }
  const injected = new Set(
    Object.keys(input.operations ?? {})
      .filter((op) => !NAMED_THEMSELVES.has(op))
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
 * Every argument that names a file is one the project boundary reaches, and every exemption from
 * that names an argument some tool actually takes.
 *
 * `containProjectFiles` walks a list of argument names and skips anything not in it, so a tool
 * gaining a path argument is a tool whose path argument nothing judges: the engine reads
 * `../outside.tscn` as a file to open and an absolute path as a project file, and the boundary
 * lives on this side. Nothing held that the list had kept up with the schemas.
 *
 * The exemptions are checked in the same breath, because a list of names for things that exist
 * elsewhere rots the other way: rename the argument and the entry excuses nothing, while the real
 * argument goes uncontained and the suite stays green either way. Every key below has to be an
 * argument some tool declares.
 */
function testEveryFileArgumentIsContained(): void {
  // Arguments spelled like a path that do not name a file inside the project.
  const notAFile = new Map([
    ['projectPath', 'the project root itself: choosing it is what the argument is for'],
    ['nodePath', 'a path through the scene tree, which is not the filesystem'],
    ['parentNodePath', 'the same, for the parent'],
    ['newParentPath', 'the same, for the parent a node is moved to'],
    ['sourceNodePath', 'the same, for the node that emits a signal'],
    ['targetNodePath', 'the same, for the node whose method is called'],
    ['playerNodePath', 'the same, for an AnimationPlayer node'],
    ['animTreePath', 'the same, for an AnimationTree node'],
    ['stateMachinePath', 'a path of nested state machine names inside an AnimationTree'],
    ['viewportPath', 'a path through the scene tree of a running game, to a Viewport node'],
  ]);
  // Arguments judged where they are used rather than by the shared walk, which is fine as long as
  // somebody says so here and the judging is still there.
  const judgedAtTheCallSite = new Map([
    ['outputPath', 'project_export resolves it against the project before the engine is started'],
  ]);

  const declared = new Set<string>();
  for (const spec of TOOL_SPECS) {
    for (const name of Object.keys(spec.parameters)) {
      declared.add(name);
    }
  }

  const uncontained: string[] = [];
  let examined = 0;
  for (const name of declared) {
    const looksLikeAPath = name.endsWith('Path') || name === 'path' || name === 'script';
    if (!looksLikeAPath) {
      continue;
    }
    examined += 1;
    if (PROJECT_FILE_ARGUMENTS.includes(name) || notAFile.has(name) || judgedAtTheCallSite.has(name)) {
      continue;
    }
    uncontained.push(name);
  }
  // Counted, because "nothing was uncontained" is what a run that examined nothing says too. A
  // change to what counts as a path-shaped name, or to how the schemas are read, would empty this
  // loop and leave the check reading exactly as it does when it is working.
  assert.ok(examined >= 10, `only ${examined} path-shaped arguments were examined, so this proved little`);
  assert.deepEqual(
    uncontained,
    [],
    'these arguments name a file and nothing judges them against the project: add them to PROJECT_FILE_ARGUMENTS, or say here why they are not files',
  );

  for (const [name, why] of [...notAFile, ...judgedAtTheCallSite]) {
    assert.ok(declared.has(name), `no tool takes ${name}, so excusing it (${why}) excuses nothing`);
  }
  for (const name of PROJECT_FILE_ARGUMENTS) {
    assert.ok(declared.has(name), `no tool takes ${name}, so containing it contains nothing`);
  }

  // The export path is the one judged away from the shared walk, so the judging itself is read
  // rather than trusted: a call that lost it would still satisfy every list above.
  const server = readFileSync('src/server.ts', 'utf8');
  assert.match(
    server,
    /resolveWithinProject\(project\.value\.path, readString\(args, 'outputPath'\)/,
    'project_export should still resolve outputPath against the project',
  );
}

/**
 * A diagnostics answer says when it came from an editor older than this server.
 *
 * `addonIsStale` already rode on answers that come back over the bridge. Diagnostics do not come
 * that way: they come from the language server of the same editor, so they went unmarked, and a
 * caller was left to make a separate status call first to find out whether to believe them.
 *
 * The fault is that silence, rather than any claim that a behind editor answers wrongly. A project
 * recorded diagnostics naming lines that were not in the file, gone after a restart, and on their
 * own re-reading a class_name the editor's database had not caught up with explains it without
 * staleness being involved. What held either way is that two answers were believed before anybody
 * asked for status, and it cost nothing only because another tool disagreed loudly.
 *
 * Read out of the source because the behaviour needs an editor running an addon older than this
 * server, which is a state a fixture cannot honestly arrange. What `markIfStale` does with an
 * answer once it is handed one is covered by testAnAnswerFromAStaleAddonSaysSo.
 */
function testDiagnosticsSayWhenTheEditorIsBehind(): void {
  const source = readFileSync('src/server.ts', 'utf8');
  const handler = source.slice(source.indexOf('private async handleScriptDiagnostics('));
  const body = handler.slice(0, handler.indexOf('private async handleLSP('));
  assert.ok(body.length > 0, 'the diagnostics handler should have been found, so this proved something');
  assert.match(
    body,
    /markIfStale\(/,
    'a diagnostics answer should say when the editor behind it is older than this server',
  );
  assert.match(body, /diagnostics,/, 'and should still be carrying the diagnostics it was asked for');
}

/**
 * An argument this server has never heard of is refused with the op's own list and the version.
 *
 * "This tool has no such argument" and "the server you are talking to does not have it yet" are the
 * same sentence, and a server left running through an upgrade says the second while sounding like
 * the first. A caller who asked for an argument a newer gdharness has could not tell whether they
 * had misspelled it, invented it, or were talking to a server from before it existed, and the
 * answer only arrived when a later call happened to mention the version.
 *
 * The list is the op's, not the tool's: a caller who wrote `get` is asking what `get` takes, and
 * being handed every argument the other ten ops accept between them answers a question nobody put.
 */
async function testAnUnknownArgumentSaysWhichServerSaysSo(): Promise<void> {
  const server = new ServerProcess();
  try {
    await server.initialize('regression-test');
    const response = await server.request('tools/call', {
      name: 'project_settings',
      arguments: { projectPath: '/p', op: 'get', setting: 'a/b', nosuchargument: 1 },
    });
    const said = text(get(parseTextContent(response), 'error') ?? JSON.stringify(response));
    assert.match(said, /nosuchargument/, `the refusal names what was not taken: ${said}`);
    assert.match(said, /project_settings get does not take/, `and names the op it was asked of: ${said}`);
    assert.match(
      said,
      new RegExp(SERVER_VERSION.replaceAll('.', '\\.')),
      `and which server says so: ${said}`,
    );
    // The list is what this op actually accepts, which is what makes it worth printing: an
    // argument declaring no ops is read by all of them, so a long list here is the schema being
    // loose rather than the refusal being careless. `prefix` is on it because `get` takes it, and
    // `frames` is not because it belongs to a different tool entirely.
    assert.match(said, /prefix/, `the list is what the op takes: ${said}`);
    assert.doesNotMatch(said, /frames/, `and nothing from another tool: ${said}`);
  } finally {
    await server.stop();
  }
}

/**
 * Processor time is read off whichever clock `ps` felt like printing.
 *
 * It prints `MM:SS` for a young process, `HH:MM:SS` once it has been going an hour, and
 * `DD-HH:MM:SS` after a day, so a reader that assumes one shape is wrong about the other two, and
 * wrong in the direction that matters: a long run is the one somebody is asking about.
 */
function testProcessorTimeIsReadOffEveryClockFormat(): void {
  assert.equal(secondsFromClock('00:12'), 12);
  assert.equal(secondsFromClock('01:02:03'), 3723);
  assert.equal(secondsFromClock('2-03:04:05'), 2 * 86_400 + 3 * 3600 + 4 * 60 + 5);
  // Nothing to report reads as nothing rather than as zero, which would say a live process had
  // used no processor time at all.
  assert.equal(secondsFromClock(''), undefined);
  assert.equal(secondsFromClock('not a clock'), undefined);
}

/**
 * A budget of zero is an answer, and an argument that cannot carry it cannot turn the wait off.
 *
 * `runtimeWaitMs` is documented as how long to wait for a game to announce itself. Read as a
 * positive number, zero was indistinguishable from the argument being absent, so the default came
 * back and the wait happened anyway: a scene that announces nothing by construction paid five
 * seconds on every start and the only escape was to stop using the tool.
 */
function testAWaitOfNothingIsAWaitOfNothing(): void {
  assert.equal(readNonNegativeNumber({ runtimeWaitMs: 0 }, 'runtimeWaitMs'), 0);
  assert.equal(readPositiveNumber({ runtimeWaitMs: 0 }, 'runtimeWaitMs'), undefined);
  // And the rest of what it read before still reads the same way.
  assert.equal(readNonNegativeNumber({ runtimeWaitMs: 250 }, 'runtimeWaitMs'), 250);
  assert.equal(readNonNegativeNumber({ runtimeWaitMs: '250' }, 'runtimeWaitMs'), 250);
  assert.equal(readNonNegativeNumber({ runtimeWaitMs: -1 }, 'runtimeWaitMs'), undefined);
  assert.equal(readNonNegativeNumber({}, 'runtimeWaitMs'), undefined);
}

/**
 * An entry with nothing under it does not carry an empty list saying so.
 *
 * Almost every line an engine prints has no indented detail, so `"detail":[]` rode on nearly every
 * entry of every answer, and a caller watching a run reads that answer over and over. The lines are
 * what they came for; the empty list is thirteen characters of envelope each time.
 */
function testAnEntryWithNoDetailDoesNotCarryAnEmptyOne(): void {
  const log = new GameLog();
  const eol = String.fromCharCode(10);
  log.append(
    'stdout',
    ['a plain line', 'ERROR: something went wrong', '   at: somewhere.gd:12', ''].join(eol),
  );
  log.finish();
  const reported = forAnswer(log.select({ severity: 'info', sinceLastCall: false, limit: 50 }).entries);
  assert.ok(reported.length >= 2, `the log should have kept what it was given: ${JSON.stringify(reported)}`);

  const plain = reported.find((entry) => entry.text === 'a plain line');
  assert.ok(plain, 'the plain line should be there');
  assert.ok(
    !Object.hasOwn(plain, 'detail'),
    `a line with nothing under it carries no detail: ${JSON.stringify(plain)}`,
  );

  // Paired with the positive, because an answer that dropped every detail would satisfy the check
  // above exactly as well as one that dropped only the empty ones.
  const withDetail = reported.find((entry) => entry.detail !== undefined);
  assert.ok(withDetail, `an entry with detail should still carry it: ${JSON.stringify(reported)}`);
  assert.deepEqual(withDetail.detail, ['at: somewhere.gd:12']);
}

/**
 * Every addon the package ships is one an install puts in the project.
 *
 * `installAddons` copies the directories `ADDONS` names, one at a time. A name in that list with no
 * directory behind it already fails loudly, with "The package holds no X addon", so that direction
 * is held. The other one is silent: a directory added under `src/godot/addons` and not added to the
 * list is an addon that ships inside the package and is never installed by anything, and the only
 * symptom is a tool that answers as though the addon were simply not there.
 *
 * What counts as an addon is the same test the install uses, rather than "every directory", so a
 * directory of shared files added beside them does not read as one.
 */
function testEveryShippedAddonIsInstalled(): void {
  const shipped = readdirSync('src/godot/addons', { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(
      (name) =>
        existsSync(join('src/godot/addons', name, 'plugin.cfg')) ||
        existsSync(join('src/godot/addons', name, 'runtime_autoload.gd')),
    );
  assert.ok(shipped.length >= 3, `only ${shipped.length} addons were found, so this proved little`);
  for (const name of shipped) {
    assert.ok(
      (ADDONS as readonly string[]).includes(name),
      `${name} ships in the package and no install puts it in a project: add it to ADDONS`,
    );
  }

  // And the list is read by an install rather than only compared against, because a list that
  // matches the directory and installs none of them satisfies everything above.
  const projectDir = mkdtempSync(join(tmpdir(), 'gdharness-addons-'));
  try {
    const installed = installAddons(projectDir);
    assert.deepEqual(
      installed.map((addon) => addon.name).sort(),
      [...ADDONS].sort(),
      'an install should have put every addon in the list into the project',
    );
    for (const name of shipped) {
      assert.ok(
        existsSync(join(projectDir, 'addons', name)),
        `${name} should be in the project after an install`,
      );
    }
  } finally {
    sweep(projectDir);
  }
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

/**
 * Each shared helper is byte for byte the original it was copied from.
 *
 * `reading.gd` and `serialisation.gd` each live beside the operations and again inside both addons,
 * because an addon is installed as a directory and cannot preload out of one. Copies of one
 * conversion with nothing holding them together is how an argument comes back as a number in the
 * editor and as zero in an exported game, and the call that exposes it is the one that went to the
 * copy nobody edited. The serialiser matters twice over, because the same setting can be asked of
 * the editor or of the file and the two answers compared: spelled one way here and another there,
 * they would read as a disagreement about a value the two sides agree about.
 *
 * `bun run sync:gd` writes the copies, so what this asks is that somebody ran it.
 */
function testTheCopiedHelperReadsTheSameEverywhere(): void {
  const copies = sharedCopies();
  assert.ok(copies.length >= 4, `only ${copies.length} copies were listed, so this proved little`);

  for (const { original, copy } of copies) {
    const wanted = readFileSync(original, 'utf8');
    assert.match(wanted, /^(?:static )?func /m, `${original} should hold the code this compares`);
    assert.ok(wanted.split('\n').length >= 30, `${original} is ${wanted.split('\n').length} lines`);
    assert.equal(
      readFileSync(copy, 'utf8'),
      wanted,
      `${copy} has drifted from ${original}: run bun run sync:gd`,
    );
    assert.ok(existsSync(`${copy}.uid`), `${copy} ships without the .uid that names it`);
  }
}

/**
 * Two reservations are two ports.
 *
 * A reservation binds port zero, reads the number and closes it, so the number is back in the
 * kernel's pool before the caller has bound anything and the next call can be handed it again. A
 * fixture asking for a bridge, a language server and a debug adapter then gets two of something,
 * and what fails is somewhere else entirely: the harness's own server binds the bridge, the editor
 * comes up, and the check on who really holds the debug adapter port finds the server on it and
 * refuses to play the game. That reached CI as an editor fixture failing over two pids one apart,
 * which is what spawning a server and an editor in a row gives you.
 *
 * The repeating pool is written down rather than waited for. Asking the real kernel for forty ports
 * and finding them all different is a trial with no other side to it: a host that does not repeat
 * gives that reading whether or not anything deduplicates, which is the same answer as no guard at
 * all. Numbers below the ephemeral range, so nothing a real reservation could return collides with
 * them.
 */
async function testEveryReservedPortIsItsOwn(): Promise<void> {
  const offers = [1100, 1100, 1101];
  let asked = 0;
  const repeating = (): Promise<number> => Promise.resolve(offers[Math.min(asked++, offers.length - 1)] ?? 0);

  assert.equal(await reservePort(repeating), 1100, 'the first reservation takes what it is offered');
  assert.equal(await reservePort(repeating), 1101, 'and the second is offered 1100 again and declines it');

  // A pool with nothing else to give is an error rather than a duplicate, because handing the same
  // number to two callers is the outcome this exists to prevent.
  await assert.rejects(
    async () => await reservePort(() => Promise.resolve(1101)),
    /already offered/,
    'a pool that only repeats should fail rather than hand out a duplicate',
  );

  // The real one still answers, so what is asserted above is not the only thing that runs.
  const real = await reservePort();
  assert.ok(real > 1024 && real < 65_536, `a real reservation should come back a port: ${real}`);
}

/**
 * How many tool names the tree mentions today, as a floor under the reading below.
 *
 * Set to what is there rather than to a round number, so removing mentions means lowering this in
 * the same change and somebody confirms the removal was meant.
 */
const TOOL_NAME_MENTIONS = 520;

/** The same, for phrases naming a tool and one of its multi-word ops. */
const TOOL_OP_MENTIONS = 18;

/**
 * Every tool this server names in something it says is a tool it has.
 *
 * The refusals here are full of tool names, because a refusal that does not say what to call
 * instead is half an answer. A rename or a removal leaves those sentences reading perfectly and
 * pointing at nothing, and the caller who follows one is sent to make a call that will be refused
 * for a second reason. Nothing else catches it: the schemas are checked against each other, the
 * prose is checked against nobody, and a sentence is as fluent wrong as right.
 *
 * Read out of the string literals rather than out of whole lines, because the sentence that matters
 * is often assembled from parts and no single line of the file contains it. The rendered surfaces
 * are read as themselves, since that is what an agent is given.
 *
 * The families come from the schemas, so a tool in a new family is covered the day it lands rather
 * than when somebody remembers this list.
 */
function testEveryToolNamedInProseIsATool(): void {
  const names = new Set(TOOL_SPECS.map((spec) => spec.name));
  const families = [...new Set(TOOL_SPECS.map((spec) => spec.name.split('_')[0]))];
  // Words this project owns that are shaped like a tool and are not one: the fields the bridge
  // sends the addon, the autoload the runtime installs, and a section of project.godot. Named one
  // by one rather than matched by a pattern, so a new word of this shape has to be looked at once
  // and called a tool or called vocabulary.
  const notTools = new Set([
    'project_path',
    'scene_path',
    'resource_path',
    'script_path',
    'script_class',
    'project_file',
    'project_name',
    'project_config',
    'project_diagnostics',
    'resource_files',
    'scene_tools',
    'resource_tools',
    'editor_pid',
    'debug_port',
    'debug_adapter',
    'editor_plugins',
  ]);
  // The addon's own modules, taken from the files rather than written down, because a module added
  // tomorrow is named in a string the day it lands and a list would not know about it.
  const modules = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        modules(join(directory, entry.name));
      } else if (entry.name.endsWith('.gd')) {
        notTools.add(entry.name.slice(0, -3));
      }
    }
  };
  modules(join('src', 'godot'));
  // The wildcard a sentence uses to mean a whole family, which is a real thing to say and not a
  // tool: `runtime_*` reaches it. Judged as the family so a family that goes away is still caught.
  const wildcard = new RegExp(`\\b(${families.join('|')})_\\*`, 'g');
  const shaped = new RegExp(`\\b(${families.join('|')})_[a-z][a-z0-9_]*\\b`, 'g');

  // What the server says, not what it is written with. A bare read of the file also sees its own
  // identifiers and the field names of the bridge protocol, which are the same shape as a tool and
  // are nobody's instruction to make a call.
  const quoted = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  const sources: [string, string][] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.gd')) {
        sources.push([
          path,
          [...readFileSync(path, 'utf8').matchAll(quoted)].map((one) => one[0]).join('\n'),
        ]);
      } else if (entry.name.endsWith('.md')) {
        sources.push([path, readFileSync(path, 'utf8')]);
      }
    }
  };
  // Walked rather than listed. A rule counted over a named set is a rule the next file escapes by
  // being somewhere nobody listed, and the three documents this used to name were three of five.
  // The addon's GDScript is here for the same reason: it tells a caller which tool to use too.
  walk('src');
  walk('docs');
  walk('.github');
  for (const entry of readdirSync('.', { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      sources.push([entry.name, readFileSync(entry.name, 'utf8')]);
    }
  }
  sources.push(['the tool reference', renderToolsMarkdown()]);
  // Every file the skill installs, not the one that is usually the whole of it. The reference beside
  // it is generated and is what a rename rewrites, so leaving it out reads a skill that cannot drift
  // and calls the pair checked.
  for (const [name, text] of skillFiles('0.0.0')) {
    sources.push([`the skill: ${name}`, text]);
  }

  let seen = 0;
  const wrong: string[] = [];
  for (const [where, text] of sources) {
    for (const found of text.matchAll(shaped)) {
      // A real tool first, whatever else shares its spelling. Two modules here are named after the
      // tool they implement, so vocabulary taken from the filenames covers `runtime_capture` and
      // `runtime_input` as well, and skipping on that would stop checking two of the tools this is
      // for. Being vocabulary somewhere is not grounds to stop reading it as a tool.
      const tool = names.has(found[0]);
      if (!tool && notTools.has(found[0])) {
        continue;
      }
      seen += 1;
      if (!tool) {
        wrong.push(`${where} names ${found[0]}, which is not a tool`);
      }
    }
    for (const found of text.matchAll(wildcard)) {
      seen += 1;
      if (!families.includes(found[1] ?? '')) {
        wrong.push(`${where} names the family ${found[0]}, which has no tools`);
      }
    }
  }

  // An op named after its tool, which is how these sentences tell a caller what to do: the words
  // are next to each other because the call is `editor_run stop`. Only the ones carrying an
  // underscore, because a one-word op is the same shape as the next English word and `editor_status
  // says` would read as an op called `says`. That leaves `start` and `stop` unheld here and it is
  // the honest half to take: the multi-word ops are the ones nobody can check by eye.
  const opsOf = new Map(TOOL_SPECS.map((spec) => [spec.name, new Set(Object.keys(spec.operations ?? {}))]));
  const called = new RegExp(`\\b(${[...names].join('|')})\\s+([a-z][a-z0-9]*_[a-z0-9_]*)\\b`, 'g');
  let ops = 0;
  for (const [where, text] of sources) {
    for (const found of text.matchAll(called)) {
      const [, tool, op] = found;
      const known = opsOf.get(tool ?? '');
      if (known === undefined || known.size === 0 || names.has(`${op}`)) {
        continue;
      }
      ops += 1;
      if (!known.has(op ?? '')) {
        wrong.push(`${where} says ${tool} ${op}, which is not an op of ${tool}`);
      }
    }
  }

  // The instrument first. A pattern that had stopped matching reports every prose file clean, and
  // this check is otherwise an assertion that nothing was found, which a broken regex satisfies
  // perfectly. The floor is what the tree holds today rather than a comfortable minimum, so
  // dropping a mention below it has to be confirmed in the same change.
  assert.ok(seen >= TOOL_NAME_MENTIONS, `only ${seen} tool names were read; the pattern is not matching`);
  assert.ok(
    ops >= TOOL_OP_MENTIONS,
    `only ${ops} tool-and-op phrases were read; the pattern is not matching`,
  );
  assert.deepEqual(wrong, [], `every tool and op named in prose should exist:\n${wrong.join('\n')}`);
}

/**
 * `from` is offered exactly where there is an editor to ask.
 *
 * The schema says which ops take the argument and `EDITOR_READS` says which ops the editor can
 * answer, and they are written in different files. Offered where there is no editor side, a caller
 * reads the schema, asks for the editor and is refused by something they had every reason to think
 * would work; missing where there is one, the editor's answer is unreachable and the entry is dead.
 */
function testTheEditorIsOfferedWhereItCanAnswer(): void {
  const offered = new Set<string>();
  for (const spec of TOOL_SPECS) {
    if (spec.parameters['from'] === undefined) {
      continue;
    }
    for (const op of Object.keys(spec.operations ?? {})) {
      if (opTakes(spec, op, 'from')) {
        offered.add(`${spec.name} ${op}`);
      }
    }
  }
  const answerable = new Set(
    Object.entries(EDITOR_READS).flatMap(([tool, ops]) => Object.keys(ops).map((op) => `${tool} ${op}`)),
  );
  assert.ok(answerable.size >= 1, 'no op has an editor side, so this compared two empty sets');
  assert.deepEqual([...offered].sort(), [...answerable].sort());
}

/**
 * A read asked of the editor is refused rather than answered from disk.
 *
 * The two are not the same reading, which is the whole reason for saying which one you want: disk
 * is what the file holds, the editor is what it has been told, unsaved changes and all. Answering
 * from disk when no editor is there would be the file's answer wearing the editor's name, and the
 * caller would have nothing to tell them apart by.
 */
async function testAReadAskedOfTheEditorIsNotAnsweredFromDisk(): Promise<void> {
  const server = new ServerProcess();
  try {
    await server.initialize('regression-test');
    const asked = await server.request('tools/call', {
      name: 'project_settings',
      arguments: { projectPath: '/p', op: 'get', setting: 'application/config/name', from: 'editor' },
    });
    const refused = textOf(asked) ?? JSON.stringify(asked);
    assert.match(refused, /no editor has reached this server/, `it says why it cannot: ${refused}`);
    assert.match(refused, /from: "disk"/, `and what to pass to read the file instead: ${refused}`);

    // Beside it, the same question with nothing said about where: it goes to disk, gets as far as
    // the project and stops there. Without this the fixture is satisfied by a server that refuses
    // everything, which is what a broken one does.
    const unasked = await server.request('tools/call', {
      name: 'project_settings',
      arguments: { projectPath: '/p', op: 'get', setting: 'application/config/name' },
    });
    const went = textOf(unasked) ?? JSON.stringify(unasked);
    assert.match(went, /Not a Godot project: \/p/, `the default reading is disk: ${went}`);
  } finally {
    await server.stop();
  }
}

/**
 * The editor answers for the project it has open, and a call naming another one is told so.
 *
 * An editor has one project open and no way to look in a second, so it answers about its own
 * whatever path the call names. A server with no project of its own takes whichever editor reaches
 * it, which is every server configured by port alone, and from then on a call naming another
 * project was served from the open one: the caller read their own project's name back in an answer
 * describing somebody else's scenes. The bridge already turns away an editor from elsewhere on the
 * way in; this is the same rule read from the caller's end.
 */
async function testTheEditorAnswersOnlyForItsOwnProject(): Promise<void> {
  const port = await reservePort();
  const server = new ServerProcess({ env: { GDHARNESS_BRIDGE_PORT: String(port) } });
  const open = join(tmpdir(), 'gdharness-editor-has-this');
  const elsewhere = join(tmpdir(), 'gdharness-editor-has-not');
  let editor: WebSocket | null = null;
  try {
    await server.initialize('regression-test');
    const socket = new WebSocket(`ws://127.0.0.1:${port}/godot`);
    editor = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', reject);
    });

    const asked: string[] = [];
    socket.on('message', (raw: Buffer) => {
      const message: unknown = JSON.parse(String(raw));
      if (!isRecord(message) || message['type'] !== 'tool_invoke') {
        return;
      }
      asked.push(String(message['tool']));
      socket.send(
        JSON.stringify({
          type: 'tool_result',
          id: message['id'],
          success: true,
          result: { ok: true, nodes: [], answered_by: 'the fixture editor' },
        }),
      );
    });
    socket.send(JSON.stringify({ type: 'godot_ready', project_path: open, addon_version: SERVER_VERSION }));

    let knows = false;
    for (let waited = 0; waited < 10_000 && !knows; waited += 100) {
      await delay(100);
      const status = await server.request('tools/call', { name: 'editor_status', arguments: {} });
      knows = text(get(parseTextContent(status), 'editor', 'projectPath')) === open;
    }
    assert.ok(knows, 'the fixture editor should have told the server its project, or this proves nothing');

    const other = await server.request('tools/call', {
      name: 'scene_tree',
      arguments: { projectPath: elsewhere, scenePath: 'res://main.tscn' },
    });
    const refused = textOf(other) ?? JSON.stringify(other);
    assert.match(refused, /the editor on this bridge has/, `the refusal names the open project: ${refused}`);
    assert.match(refused, /gdharness-editor-has-not/, `and the one that was asked for: ${refused}`);
    assert.equal(
      asked.includes('list_scene_nodes'),
      false,
      'and the editor was never asked about a project it cannot see',
    );

    // Beside it, the project the editor does have: the same call reaches the editor and comes back
    // with the editor's own answer. Without this the fixture is satisfied by a bridge that refuses
    // everything, which is what a broken one does.
    const its = await server.request('tools/call', {
      name: 'scene_tree',
      arguments: { projectPath: open, scenePath: 'res://main.tscn' },
    });
    assert.equal(
      text(get(parseTextContent(its), 'answered_by')),
      'the fixture editor',
      `the editor's own project is served: ${textOf(its) ?? JSON.stringify(its)}`,
    );
    assert.deepEqual(
      asked.filter((one) => one === 'list_scene_nodes'),
      ['list_scene_nodes'],
      'and the call reached the editor exactly once',
    );
  } finally {
    editor?.terminate();
    await server.stop();
  }
}

/**
 * A config naming a version this server is not is said, rather than left to be worked out.
 *
 * Four versions surround a project and three of them were reported: the addon installed in it, the
 * server answering, and the newest on npm. The fourth is the one the project's own `.mcp.json`
 * names, which is what the client fetches the next time it spawns a server, and nothing looked at
 * it. A downstream project moved a pin it kept elsewhere, ran its reconnect twice, and got the old
 * server both times; two sessions went into working out which side was lying, and neither was.
 *
 * Silent while the two agree, because a notice that is always there is a notice nobody reads.
 */
async function testAConfigNamingAnotherVersionIsSaid(): Promise<void> {
  const project = mkdtempSync(join(realpathSync(tmpdir()), 'gdharness-pinned-'));
  try {
    writeFileSync(join(project, 'project.godot'), 'config_version=5\n');
    const named = (version: string): void => {
      writeFileSync(
        join(project, '.mcp.json'),
        JSON.stringify({
          mcpServers: { gdharness: { command: 'npx', args: ['-y', `gdharness@${version}`] } },
        }),
      );
    };

    named('0.0.1');
    const stale = new ServerProcess({ env: { GDHARNESS_PROJECT: project } });
    try {
      await stale.initialize('regression-test');
      const asked = await stale.request('tools/call', { name: 'editor_status', arguments: {} });
      // In the status itself, for a caller who went looking, and in the notice, for one who did
      // not: the whole point is that nobody thought to ask, so being asked cannot be the condition.
      const reported = text(get(parseTextContent(asked), 'editor', 'configIs'));
      assert.match(
        reported,
        /gdharness@0\.0\.1/,
        `the status should name what the config asks for: ${reported}`,
      );
      assert.match(
        reported,
        new RegExp(SERVER_VERSION.replaceAll('.', '\\.')),
        `beside the one that is answering: ${reported}`,
      );
      assert.match(reported, /reconnected/, `and what closes the gap: ${reported}`);
      const said = textOf(asked) ?? '';
      assert.match(said, /config_names_another_version/, `and the notice should carry it too: ${said}`);
    } finally {
      await stale.stop();
    }

    // The pairing: a config naming this very server says nothing at all. Without it the fixture is
    // satisfied by a server that reports a disagreement whatever the file holds.
    named(SERVER_VERSION);
    const agreed = new ServerProcess({ env: { GDHARNESS_PROJECT: project } });
    try {
      await agreed.initialize('regression-test');
      const settled = await agreed.request('tools/call', { name: 'editor_status', arguments: {} });
      const quiet = textOf(settled) ?? '';
      assert.equal(
        get(parseTextContent(settled), 'editor', 'configIs'),
        undefined,
        `nothing to say when the two agree: ${quiet}`,
      );
      assert.doesNotMatch(quiet, /config_names_another_version/, `and no notice either: ${quiet}`);
      assert.equal(
        text(get(parseTextContent(settled), 'editor', 'serverVersion')),
        SERVER_VERSION,
        `and it is still the whole status answer: ${quiet}`,
      );
    } finally {
      await agreed.stop();
    }
  } finally {
    sweep(project);
  }
}

/**
 * A value outside the set its schema lists is refused rather than quietly replaced by the default.
 *
 * It is the quietest of the argument faults: the name is right and the type is right, so every
 * check before this one passes it, and then the code reads a word it does not know and takes the
 * default. `direction: "reversed"` answered with what the resource depends on, which is the
 * opposite question, and the answer said `"direction": ""` in a field nobody reads.
 */
async function testAnUnlistedValueIsRefusedRatherThanDefaulted(): Promise<void> {
  const server = new ServerProcess();
  try {
    await server.initialize('regression-test');
    const misspelled = await server.request('tools/call', {
      name: 'project_dependencies',
      arguments: { projectPath: '/p', resourcePath: 'res://a.tscn', direction: 'reversed' },
    });
    const refused = textOf(misspelled) ?? JSON.stringify(misspelled);
    assert.match(refused, /direction as one of forward, reverse/, `the refusal lists the set: ${refused}`);
    assert.match(refused, /not "reversed"/, `and quotes what arrived: ${refused}`);

    // The spelling the schema does list is not refused at all: it reaches the project and stops
    // where every call with a project that is not there stops.
    const spelled = await server.request('tools/call', {
      name: 'project_dependencies',
      arguments: { projectPath: '/p', resourcePath: 'res://a.tscn', direction: 'reverse' },
    });
    const reached = textOf(spelled) ?? JSON.stringify(spelled);
    assert.match(reached, /Not a Godot project: \/p/, `a listed value is not refused: ${reached}`);

    // A set listed on the elements of a list is checked per element and named by where it sits. One
    // good section beside one typo is the call that would otherwise answer with the good one and
    // never mention that the other was thrown away.
    const sections = await server.request('tools/call', {
      name: 'project_info',
      arguments: { projectPath: '/p', include: ['plugins', 'plugin'] },
    });
    const named = textOf(sections) ?? JSON.stringify(sections);
    assert.match(named, /include\[1\] as one of/, `the stray element is named by position: ${named}`);
    assert.doesNotMatch(named, /include\[0\]/, `and the good one is not: ${named}`);
  } finally {
    await server.stop();
  }
}

/**
 * A scan that has been asked for and has not started is not a scan that has finished.
 *
 * `EditorFileSystem.scan()` queues rather than runs, so for the first frames after asking, both
 * flags the engine offers are false and a poll reads the scan as over. Downstream: a rescan of a
 * 376-class project answered `ok: true` 296ms in, and the editor then wrote its own stale class
 * list over the cache that had just been corrected; the loss surfaced an hour later in a separate
 * engine as an unknown identifier in a file nobody had touched. Measured here for comparison, a
 * headless editor of 400 scripts takes 1619ms and says so honestly, which is why the fault needs
 * an editor slow enough to be answering something else and cannot be reproduced by waiting.
 *
 * So the editor says `pending` and this is the half that reads it. A fixture editor holds the scan
 * un-started for three polls with every flag the engine has reading false, which is exactly the
 * state that used to answer "finished".
 */
async function testAScanThatHasNotStartedIsNotFinished(): Promise<void> {
  const port = await reservePort();
  const server = new ServerProcess({ env: { GDHARNESS_BRIDGE_PORT: String(port) } });
  const project = mkdtempSync(join(realpathSync(tmpdir()), 'gdharness-scanning-'));
  let editor: WebSocket | null = null;
  try {
    writeFileSync(join(project, 'project.godot'), 'config_version=5\n');
    await server.initialize('regression-test');
    const socket = new WebSocket(`ws://127.0.0.1:${port}/godot`);
    editor = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', reject);
    });

    let polls = 0;
    socket.on('message', (raw: Buffer) => {
      const message: unknown = JSON.parse(String(raw));
      if (!isRecord(message) || message['type'] !== 'tool_invoke') {
        return;
      }
      const tool = String(message['tool']);
      if (tool === 'rescan_filesystem') {
        polls += 1;
      }
      // Three polls of "asked for, not started", then finished. Every flag the engine itself
      // offers reads false throughout, which is what made this indistinguishable from over.
      const result =
        tool === 'rescan_filesystem'
          ? { ok: true, scanning: false, importing: false, pending: polls <= 4 }
          : { ok: true, classes: [] };
      socket.send(JSON.stringify({ type: 'tool_result', id: message['id'], success: true, result }));
    });
    socket.send(
      JSON.stringify({ type: 'godot_ready', project_path: project, addon_version: SERVER_VERSION }),
    );

    let knows = false;
    for (let waited = 0; waited < 10_000 && !knows; waited += 100) {
      await delay(100);
      const status = await server.request('tools/call', { name: 'editor_status', arguments: {} });
      knows = text(get(parseTextContent(status), 'editor', 'projectPath')) === project;
    }
    assert.ok(knows, 'the fixture editor should have reached the server, or this proves nothing');

    const scanned = await server.request('tools/call', {
      name: 'editor_rescan',
      arguments: { projectPath: project },
    });
    const answer = parseTextContent(scanned);
    assert.equal(get(answer, 'ok'), true, `the scan settles once it has run: ${textOf(scanned)}`);
    assert.equal(get(answer, 'stillWorking'), false, `and is not left hanging: ${textOf(scanned)}`);
    assert.ok(
      asNumber(get(answer, 'waitedMs')) >= 300,
      `it waited for the scan it asked for: ${asNumber(get(answer, 'waitedMs'))}ms over ${polls} polls`,
    );
    assert.ok(polls >= 4, `which takes more than one look: ${polls} polls`);
  } finally {
    editor?.terminate();
    await server.stop();
    sweep(project);
  }
}

/**
 * A repair that could not run is not reported as one.
 *
 * The editor writes the class cache at the end of a scan from the list it is holding, not from the
 * files, so an editor blind to a class the cache holds writes a cache without it over the correct
 * one. Downstream, an editor that had been short of the file since it started lost six classes to
 * one rescan. The answer now rebuilds the cache from the files rather than telling the caller to,
 * and names what came back under `cacheRestored`.
 *
 * The rebuild is a headless engine, so it is a thing that can fail: no engine on the machine, a
 * project it will not open, a script that no longer declares the class. Claiming the repair anyway
 * would be the same fault this whole area keeps producing, an answer accurate enough to be believed
 * and not accurate enough to be right, and worse than the loss because a caller who reads
 * `cacheRestored` stops looking. This server has no engine, so the rebuild cannot run, and what is
 * asserted is that the loss is named, the repair is not claimed, and `ok` is false.
 *
 * A scan that loses nothing sits beside it, because a server that had stopped scanning at all would
 * satisfy the first half on its own.
 */
async function testARepairThatCouldNotRunIsNotReported(): Promise<void> {
  const port = await reservePort();
  const server = new ServerProcess({
    // Named rather than left to the machine: with an engine on PATH the rebuild would run and the
    // case would be asserting the opposite of what it says, on some machines only.
    env: { GDHARNESS_BRIDGE_PORT: String(port), GODOT_PATH: join(tmpdir(), 'gdharness-no-such-godot') },
  });
  const project = mkdtempSync(join(realpathSync(tmpdir()), 'gdharness-shortening-'));
  let editor: WebSocket | null = null;
  try {
    writeFileSync(join(project, 'project.godot'), 'config_version=5\n');
    mkdirSync(join(project, '.godot'), { recursive: true });
    writeFileSync(join(project, 'hero.gd'), 'class_name Hero\nextends Node\n');
    writeFileSync(join(project, 'squire.gd'), 'class_name Squire\nextends Node\n');
    writeFileSync(
      join(project, '.godot', 'global_script_class_cache.cfg'),
      'list=[{\n"class": &"Hero",\n"path": "res://hero.gd"\n}, {\n"class": &"Squire",\n"path": "res://squire.gd"\n}]\n',
    );

    await server.initialize('regression-test');
    const socket = new WebSocket(`ws://127.0.0.1:${port}/godot`);
    editor = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', reject);
    });

    const cache = join(project, '.godot', 'global_script_class_cache.cfg');
    let scans = 0;
    // The editor is holding one of the two classes the cache holds, which is the state that costs
    // the other one. Told to hold both, the same editor is one a scan takes nothing from.
    let holds = ['Hero'];
    socket.on('message', (raw: Buffer) => {
      const message: unknown = JSON.parse(String(raw));
      if (!isRecord(message) || message['type'] !== 'tool_invoke') {
        return;
      }
      const tool = String(message['tool']);
      const args = isRecord(message['args']) ? message['args'] : {};
      // The polls that follow a scan carry statusOnly and start nothing, so counting them would
      // say a scan happened when what happened was a look at one. The scan itself writes the cache
      // from the list this editor is holding, which is the whole of what the real one does to it.
      if (tool === 'rescan_filesystem' && args['statusOnly'] !== true) {
        scans += 1;
        // At the path the script is at, as the editor writes it: an entry at a path that is not on
        // disk is a ghost the scan takes out, and a stand-in that spelt the path with a capital was
        // one on the Linux leg alone.
        const entries = holds.map(
          (name) => `{\n"class": &"${name}",\n"path": "res://${name.toLowerCase()}.gd"\n}`,
        );
        writeFileSync(cache, `list=[${entries.join(', ')}]\n`);
      }
      const result =
        tool === 'rescan_filesystem'
          ? { ok: true, scanning: false, importing: false, pending: false }
          : { ok: true, classes: holds };
      socket.send(JSON.stringify({ type: 'tool_result', id: message['id'], success: true, result }));
    });
    socket.send(
      JSON.stringify({ type: 'godot_ready', project_path: project, addon_version: SERVER_VERSION }),
    );

    let knows = false;
    for (let waited = 0; waited < 10_000 && !knows; waited += 100) {
      await delay(100);
      const status = await server.request('tools/call', { name: 'editor_status', arguments: {} });
      knows = text(get(parseTextContent(status), 'editor', 'projectPath')) === project;
    }
    assert.ok(knows, 'the fixture editor should have reached the server, or this proves nothing');

    const shortened = await server.request('tools/call', {
      name: 'editor_rescan',
      arguments: { projectPath: project },
    });
    const said = textOf(shortened) ?? JSON.stringify(shortened);
    const lost = parseTextContent(shortened);
    assert.deepEqual(asArray(get(lost, 'cacheLost') ?? []).map(String), ['Squire'], said);
    assert.equal(get(lost, 'cacheRestored'), undefined, `with no repair claimed: ${said}`);
    assert.equal(get(lost, 'ok'), false, `and the call is not a success: ${said}`);
    assert.match(text(get(lost, 'note')), /editor_launch restart/, `saying what to do: ${said}`);
    assert.equal(scans, 1, `the scan itself did happen: ${said}`);

    // An editor holding everything the cache holds writes the same list back, so there is nothing
    // to lose and nothing to repair. Without this, a server that had stopped scanning would satisfy
    // every assertion above.
    holds = ['Hero', 'Squire'];
    writeFileSync(
      cache,
      'list=[{\n"class": &"Hero",\n"path": "res://hero.gd"\n}, {\n"class": &"Squire",\n"path": "res://squire.gd"\n}]\n',
    );
    const kept = await server.request('tools/call', {
      name: 'editor_rescan',
      arguments: { projectPath: project },
    });
    const answer = parseTextContent(kept);
    assert.equal(get(answer, 'ok'), true, `a scan that takes nothing is clean: ${textOf(kept)}`);
    assert.equal(get(answer, 'cacheLost'), undefined, `with nothing lost: ${textOf(kept)}`);
    assert.equal(scans, 2, `and it was asked for again: ${textOf(kept)}`);
  } finally {
    editor?.terminate();
    await server.stop();
    sweep(project);
  }
}

/**
 * A scan that shortened the class cache has it rebuilt from the files.
 *
 * The other half of the case above, and the one that needs a real engine, because the rebuild is a
 * headless engine reading the scripts. Here rather than in the editor tier because the editor tier
 * cannot ask for the loss: whether a running editor has taken a newly written file in before
 * anybody tells it to scan is not the same on every platform, so on one of them the scan keeps
 * everything and the repair never runs. A fixture editor holding a short list produces the loss on
 * every platform, every time, which is what a repair has to be asserted against.
 */
async function testAShortenedCacheIsRebuilt(): Promise<void> {
  const godotPath = resolveGodotPath();
  if (!godotPath) {
    if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and GODOT_PATH names no existing file.');
    }
    console.log('cache rebuild regression skipped (Godot not found)');
    return;
  }

  const port = await reservePort();
  const server = new ServerProcess({ env: { GDHARNESS_BRIDGE_PORT: String(port), GODOT_PATH: godotPath } });
  const project = mkdtempSync(join(realpathSync(tmpdir()), 'gdharness-rebuilt-'));
  let editor: WebSocket | null = null;
  try {
    writeFileSync(join(project, 'project.godot'), 'config_version=5\n');
    mkdirSync(join(project, '.godot'), { recursive: true });
    writeFileSync(join(project, 'hero.gd'), 'class_name Hero\nextends Node\n');
    writeFileSync(join(project, 'squire.gd'), 'class_name Squire\nextends Node\n');
    const cache = join(project, '.godot', 'global_script_class_cache.cfg');
    writeFileSync(
      cache,
      'list=[{\n"class": &"Hero",\n"path": "res://hero.gd"\n}, {\n"class": &"Squire",\n"path": "res://squire.gd"\n}]\n',
    );

    await server.initialize('regression-test');
    const socket = new WebSocket(`ws://127.0.0.1:${port}/godot`);
    editor = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', reject);
    });

    socket.on('message', (raw: Buffer) => {
      const message: unknown = JSON.parse(String(raw));
      if (!isRecord(message) || message['type'] !== 'tool_invoke') {
        return;
      }
      const tool = String(message['tool']);
      const args = isRecord(message['args']) ? message['args'] : {};
      if (tool === 'rescan_filesystem' && args['statusOnly'] !== true) {
        writeFileSync(cache, 'list=[{\n"class": &"Hero",\n"path": "res://hero.gd"\n}]\n');
      }
      const result =
        tool === 'rescan_filesystem'
          ? { ok: true, scanning: false, importing: false, pending: false }
          : { ok: true, classes: ['Hero'] };
      socket.send(JSON.stringify({ type: 'tool_result', id: message['id'], success: true, result }));
    });
    socket.send(
      JSON.stringify({ type: 'godot_ready', project_path: project, addon_version: SERVER_VERSION }),
    );

    let knows = false;
    for (let waited = 0; waited < 10_000 && !knows; waited += 100) {
      await delay(100);
      const status = await server.request('tools/call', { name: 'editor_status', arguments: {} });
      knows = text(get(parseTextContent(status), 'editor', 'projectPath')) === project;
    }
    assert.ok(knows, 'the fixture editor should have reached the server, or this proves nothing');

    const scanned = await server.request('tools/call', {
      name: 'editor_rescan',
      arguments: { projectPath: project },
    });
    const answer = parseTextContent(scanned);
    const said = textOf(scanned) ?? JSON.stringify(scanned);
    assert.deepEqual(asArray(get(answer, 'cacheLost') ?? []).map(String), ['Squire'], said);
    assert.deepEqual(asArray(get(answer, 'cacheRestored') ?? []).map(String), ['Squire'], said);
    // The file itself, because the answer saying it was put back is the claim under test.
    assert.ok(readFileSync(cache, 'utf8').includes('Squire'), `and the file holds it again: ${said}`);
    // Still not ok, because the editor is holding the short list and the next scan drops it again.
    assert.match(text(get(answer, 'note')), /editor_launch restart/, said);
  } finally {
    editor?.terminate();
    await server.stop();
    sweep(project);
  }
}

/**
 * Every fixture in this file is in the list below.
 *
 * The list is written by hand, so a fixture can be added and left out of it, and nothing says so:
 * the suite passes, the count goes up by nothing, and the guard it was written for is unwatched
 * while its name sits in the file looking like coverage. Four fixtures were added here in one day
 * and each was registered by hand, which is four chances to have missed one.
 *
 * Read from this file's own source, because the thing being checked is exactly the gap between
 * what is written here and what is called. Anything named like a fixture and not called is either
 * a fixture nobody runs or a helper that should not be named `test...`, and both want the same
 * answer from whoever reads the failure.
 */
function testEveryFixtureIsCalled(): void {
  const source = readFileSync(join('test', 'regressions.ts'), 'utf8');
  const defined = [...source.matchAll(/^(?:async )?function (test[A-Za-z0-9_]*)\(/gm)].map((match) =>
    captured(match),
  );
  assert.ok(defined.length > 50, `the pattern should still find the fixtures: found ${defined.length}`);

  const listed = new Set(
    [...source.matchAll(/^ {2}(test[A-Za-z0-9_]*),$/gm)].map((match) => captured(match)),
  );
  const unreachable = defined.filter((name) => !listed.has(name));
  assert.deepEqual(unreachable, [], 'every fixture defined here should be in TESTS');
}

const TESTS: (() => void | Promise<void>)[] = [
  testEveryFileArgumentIsContained,
  testDiagnosticsSayWhenTheEditorIsBehind,
  testAnUnknownArgumentSaysWhichServerSaysSo,
  testProcessorTimeIsReadOffEveryClockFormat,
  testAWaitOfNothingIsAWaitOfNothing,
  testAnEntryWithNoDetailDoesNotCarryAnEmptyOne,
  testEveryShippedAddonIsInstalled,
  testEveryAddonScriptKeepsItsIdentity,
  testTheCopiedHelperReadsTheSameEverywhere,
  testEveryReservedPortIsItsOwn,
  testEveryToolNamedInProseIsATool,
  testTheEditorIsOfferedWhereItCanAnswer,
  testAReadAskedOfTheEditorIsNotAnsweredFromDisk,
  testAConfigNamingAnotherVersionIsSaid,
  testTheEditorAnswersOnlyForItsOwnProject,
  testAnUnlistedValueIsRefusedRatherThanDefaulted,
  testEveryFixtureIsCalled,
  testBothEndsAgreeAboutTheAnnouncement,
  testARestartLeftHalfDoneIsSaid,
  testASupersededServerStandsDown,
  testAProjectUpgradedUnderTheServerIsSaid,
  testEveryDispatchedNameExistsOnBothSides,
  testEveryEngineParameterCanBeSent,
  testEveryToolParameterIsRead,
  testEveryToolIsDrivenSomewhere,
  testStaleDisconnectRegression,
  testOneServerOneProjectRegression,
  testSceneToolsVectorRegression,
  testRunArgumentsLeaveTheLocalDebuggerOff,
  testHeadlessFollowsTheDisplay,
  testStaleClassesAreReadFromDisk,
  testTheProjectWalksAgreeAboutWhatIsInIt,
  testClassesAnEditorIsNotHolding,
  testAScanThatHasNotStartedIsNotFinished,
  testARepairThatCouldNotRunIsNotReported,
  testAShortenedCacheIsRebuilt,
  testTheEditorsRunIsTheOneAnsweredFor,
  testAStatusCallIsNotHeldByAHeldGame,
  testARuntimeCallToAHeldGameIsRefusedAtOnce,
  testAnEditorOnAnotherVersionIsStillAskedWhatItIsPlaying,
  testAGameTheEditorHasStoppedPlayingIsNotStillActive,
  testAPlayedStartStopsWaitingForAGameThatIsOver,
  testTheAnnounceWaitIsNotHeldByASlowEditor,
  testAPlayTheEditorHasNotStartedIsNotAGameThatHasGone,
  testALateAnnouncementIsTiedToThePlayedRun,
  testTheEditorsGameIsToldFromAnotherOfTheSameProject,
  testASpawnedGameBesideAnEditorIsStillItsOwn,
  testAFindByClassReachesWhatExtendsIt,
  testAnInjectedMotionCarriesHowFarThePointerMoved,
  testAKeyDoesNotChooseFromAnOpenedMenu,
  testAWrittenLineBreakMatchesATwoLineLabel,
  testAPlayedGamesReportsReachTheOutput,
  testARealBenchTakesItsWorkerWithIt,
  testAStopEndsTheProjectsUnannouncedWorkers,
  testARuntimeCallReachesThisServersOwnGame,
  testACommandLineIsReadTheWayTheEngineReadsIt,
  testChildrenAreListedWhileTheParentLives,
  testAStopCanEndWhatTheGameStarted,
  testAStopTakesTheEndedGamesAnnouncementDown,
  testAStopTakesTheWrappedEnginesAnnouncementDown,
  testASettingTheEditorDroppedIsNamed,
  testACleanupThatCannotFinishStillFinishes,
  testADiagnosticTheFileContradictsIsNamed,
  testAClassTheEditorHasNotLoadedIsToldApartFromOneTheCacheLacks,
  testAClassTheEditorHoldsAfterItsScriptIsGoneIsNamed,
  testWhatAStaleTypeDependsOnIsNamed,
  testTheProjectPathSentenceNamesEveryCallThatTakesNone,
  testEveryArgumentInTheReferenceIsDescribed,
  testTheReferencePrintsEveryShapeOfType,
  testTheSkillNamesEverySettingTheAddonsRead,
  testTheSkillNamesTheSettingThatServesAScriptRun,
  testTheSkillWritesNoEscapedBackticks,
  testAnAuditThatCouldNotAskIsNotAnAuditThatPassed,
  testAnAnnotatedDeclarationIsStillADeclaration,
  testAStructureReadDescribesTheScriptItRead,
  testRefreshingUidsMakesTheSidecarAndWritesNoScene,
  testWhoIsHoldingAPortIsAskable,
  testWhatTheEditorSavedAwayIsReportedTheSameWay,
  testARestartSaysWhatTheEditorDropped,
  testProjectDefaultsToTheWorkingDirectory,
  testAnEngineThatDoesNotAnswerIsNamed,
  testAnAutoloadGitWillNotCarry,
  testAnAutoloadNamingAFileThatIsNotThere,
  testEveryGdscriptIsUnderTheGatesAndEveryGateHasSome,
  testTheReleaseButtonOffersWhatBothDocumentsDescribe,
  testVersionOrdering,
  testChangelogReach,
  testTheCureIsWrittenWhole,
  testEveryRemedyLeadsWithTheScan,
  testTheStaleNoteNamesTheCallThatRebuildsTheCopy,
  testTheUncachedNoteSaysWhichRemedyStartsAnEngine,
  testARestartWaitsForTheEditorToSayWhoItIs,
  testTheStaleHalfIsNamedCorrectly,
  testAGameIsFoundWhereverItAnnounced,
  testAGameTooNewToTalkToIsStillAGame,
  testAnErrorReportOutlivesItsGameForAnHour,
  testAPidPicksOneOfSeveralGames,
  testAGameThatAnnouncedAndWentIsSaidSo,
  testAnAnnouncementIsItsOwnProcess,
  testAStaleAnnouncementWhoseNumberCameRoundIsSwept,
  testANotYetRuntimeIsNotTheSameAsNoRuntime,
  testARefusalDoesNotDenyTheRuntimeItCanSee,
  testAStartSaysWhatItLeftRunning,
  testATestServerWritesWhereNoRealRunIs,
  testAStartStopsWaitingForAGameThatIsOver,
  testAStartWaitsForTheGameToAnnounceItself,
  testATestRunKeepsOutOfThePlayersSaves,
  testTheEngineWritesItsSavesWhereItWasTold,
  testParametersReachTheEngine,
  testAFinishedRunCanStillBeRead,
  testOnlyOurOwnAutoloadIsRewritten,
  testAnExitCodeOutlivesTheServerThatSawIt,
  testAPidIsNotAnIdentity,
  testTheEditorHoldingAProjectIsNotARunOfIt,
  testARunEndedUnwatchedIsStillReadable,
  testAForeignRunSurvivesAStart,
  testARunOutlivesItsServer,
  testGdUnitRunner,
  testAnUpgradeReadsTheEngineOutOfTheConfigItRewrites,
  testCommandLineSetup,
  testTheWrittenConfigNamesAProgramThatStarts,

  testProjectGodotMultilineValues,
  testLettingGoOfTheAdapterSendsItNothing,
  testAStopIsKnownToTheConnectionItWasSentTo,
  testAStopThatLandsWhileAttachAsksIsTheAnswer,
  testAContinueByAnotherClientIsKnownHere,
  testBreakpointsAreSentAgainBeforeAPlay,
  testTheBreakpointNoteIsTheProjects,
  testABreakpointRefusalNamesTheEditor,
  testABreakpointSetHereKeepsTheEditorsOwn,
  testAnEditorThatClearsBreakpointsIsSaidSo,
  testProjectGodotResistsPrototypeKeys,

  testAnAnswerFromAStaleAddonSaysSo,
  testAnEditorNotReachedYetIsNotAnEditorThatIsGone,
  testEditorStatusPortConflict,
  testTheBridgeTakesThePortWhenItIsFreed,
  testAnEditorAServerOpenedIsStartedAgain,
  testAServerEndsWithAnEditorStillOnTheBridge,
  testABadPortIsReported,
  testAnEditorPortMovesOnlyWhenItIsHeld,
  testAServerOnlyAnswersAboutItsOwnGame,
  testTheLongestWaitCanBeWaitedOut,
  testDiagnosticsSurviveUriReEncoding,
  testDiagnosticsSurviveTheEditorRestarting,
  testDiagnosticsLeaveNoDocumentOpen,
  testDiagnosticsSurviveAnotherSpellingOfTheSamePath,
  testDiagnosticsTimeoutIsNotAnEmptyResult,
  testLspFramesBodiesByBytes,
  testLspReassemblesBodySplitMidCharacter,
  testDapFramesBodiesByBytes,
  testFramingCeilingFailsLoudly,
  testDictionariesHaveNothingBehindThem,
  testProjectPathsAreContained,
  testToolAndOpLookupsCannotReachThePrototype,
  testArgumentsOfTheWrongTypeAreRefused,
  testAnArgumentMeantForAnotherOpIsRefused,
  testEveryArgumentNamesOpsItsToolHas,
  testToolsRefusePathsOutsideTheProject,
  testDebugToolsRefuseWithoutASession,
  testUpdateNoticeRidesOnAnAnswer,
  testUpdateCheckHasAnOffSwitch,
  testAStaleUpdateAnswerIsNotHandedOut,
  testAFreshServerAsksRatherThanInheritingAnAnswer,
  testTheUpdateWindowTracksHowOftenThisShips,
  testTheRegistryIsHttpsOrNpm,
];

/**
 * Every regression above, each one run whether or not the one before it failed.
 *
 * The way a fixture here is checked is by disarming the line it guards and reading which tests
 * notice. A run that stops at the first failure answers only "something noticed", and everything
 * downstream of it never runs, so the four assertions a break should have reached look identical
 * to the one it did reach. Four disarms in a row had to be narrowed by hand until an unrelated
 * earlier test stopped firing, which is work spent on the runner rather than on the code.
 *
 * An argument names the tests to run, matched loosely against the function name, so a single
 * fixture can be run on its own while it is being written.
 */
async function main(): Promise<void> {
  const wanted = process.argv.slice(2).map((argument) => argument.toLowerCase());
  const chosen =
    wanted.length === 0
      ? TESTS
      : TESTS.filter((test) => wanted.some((word) => test.name.toLowerCase().includes(word)));
  if (chosen.length === 0) {
    console.error(`No regression is named ${process.argv.slice(2).join(' ')}.`);
    process.exitCode = 2;
    return;
  }

  const failed: string[] = [];
  for (const test of chosen) {
    try {
      await test();
    } catch (error) {
      failed.push(test.name);
      console.error(`\n${test.name} failed\n${error instanceof Error ? error.stack : String(error)}\n`);
    }
  }

  reportUnswept();

  if (failed.length > 0) {
    console.error(`${failed.length} of ${chosen.length} regressions failed:`);
    for (const name of failed) {
      console.error(`  ${name}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`regression tests passed (${chosen.length})`);
}

await main();
