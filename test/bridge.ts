#!/usr/bin/env node
/**
 * The bridge end to end: the MCP protocol over stdio, the tool list, the tools that
 * relay to the runtime addon over its socket, and the editor addon's WebSocket, driven by a mock
 * Godot on each side so that what is asserted is the relay and not the engine.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { type RawData, WebSocket } from 'ws';
import { RUNTIME_PROTOCOL } from '../src/runtime-client.js';
import { asArray, get, text } from './support/json.js';
import {
  isRecord,
  type JsonRpcMessage,
  parseTextContent,
  type ToolContentBlock,
  textOf,
} from './support/json-rpc.js';
import { reservePort, ServerProcess } from './support/server.js';

const BRIDGE_HOST = process.env['GDHARNESS_BRIDGE_HOST'] ?? '127.0.0.1';
const GODOT_PATH = resolveGodotPath(process.env['GODOT_PATH']);
const HAS_USABLE_GODOT = Boolean(GODOT_PATH && isExecutableFile(GODOT_PATH));
/** domain_verb, which every client accepts: no dots, no case, nothing a strict client rejects. */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const TOOL_COUNT = 30;
const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0r0AAAAASUVORK5CYII=';

function isExecutableFile(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutableInPath(names: string[]): string {
  const pathEntries = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean);
  for (const name of names) {
    for (const pathEntry of pathEntries) {
      const candidate = join(pathEntry, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return '';
}

function resolveGodotPath(explicitPath: string | undefined): string {
  if (explicitPath) {
    if (isExecutableFile(explicitPath)) return explicitPath;
    if (!explicitPath.includes('/') && !explicitPath.includes('\\')) {
      return findExecutableInPath([explicitPath]) || explicitPath;
    }
    return explicitPath;
  }
  return findExecutableInPath(['godot', 'godot4', 'Godot']);
}

function createTestProjectFixture(): string {
  const projectPath = mkdtempSync(join(tmpdir(), 'gdharness-bridge-'));
  writeFileSync(
    join(projectPath, 'project.godot'),
    ['; Engine configuration file.', '', '[application]', 'config/name="Gdharness Bridge Test"', ''].join(
      '\n',
    ),
  );
  writeFileSync(
    join(projectPath, 'player.gd'),
    ['extends CharacterBody2D', '', 'func _ready():', '    pass', ''].join('\n'),
  );
  return projectPath;
}

function contentOf(response: JsonRpcMessage): ToolContentBlock[] {
  const content = isRecord(response.result) ? response.result['content'] : undefined;
  return Array.isArray(content) ? (content as ToolContentBlock[]) : [];
}

interface MockRuntimeOptions {
  /** The process the announcement claims to be. It has to be alive or the server drops it. */
  pid: number;
  projectPath: string;
  name: string;
  /** What the welcome claims to speak. The announcement always says the real one. */
  protocol?: number;
  /** Accept connections and never answer, which is what a game paused at a breakpoint does. */
  silent?: boolean;
}

interface MockRuntime {
  port: number;
  announcement: string;
  close(): Promise<void>;
}

/**
 * A mock of the runtime addon: it announces itself the way the addon does, greets a client
 * with a welcome, and answers each request by id on the same line-delimited socket.
 */
function startMockRuntime(directory: string, options: MockRuntimeOptions): Promise<MockRuntime> {
  // Every connection is remembered so that closing the mock tears them down, rather than
  // waiting on a peer that has already given up on it.
  const open = new Set<Socket>();
  const runtime = createServer((socket: Socket) => {
    open.add(socket);
    socket.once('close', () => {
      open.delete(socket);
    });
    socket.setEncoding('utf8');
    const reply = (payload: unknown): void => {
      socket.write(`${JSON.stringify(payload)}\n`);
    };
    reply({
      type: 'welcome',
      protocol: options.protocol ?? RUNTIME_PROTOCOL,
      pid: options.pid,
      commands: ['ping', 'get_tree'],
    });
    if (options.silent) {
      socket.resume();
      return;
    }

    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line) {
          answer(line);
        }
      }
    });

    const answer = (line: string): void => {
      const request = JSON.parse(line) as Record<string, unknown>;
      const id = request['id'];
      const params = isRecord(request['params']) ? request['params'] : {};
      switch (request['command']) {
        case 'ping':
          reply({ type: 'pong', id, timestamp: Date.now() });
          break;
        case 'get_tree': {
          const root = typeof params['root'] === 'string' ? params['root'] : '/root';
          reply({
            type: 'tree',
            id,
            root: {
              name: options.name,
              type: 'Node',
              path: root,
              children: [{ name: 'Player', type: 'CharacterBody2D', path: `${root}/Player` }],
            },
          });
          break;
        }
        case 'set_property':
          reply({
            type: 'property_set',
            id,
            path: params['path'],
            property: params['property'],
            old_value: false,
            new_value: params['value'],
          });
          break;
        case 'call_method':
          reply({
            type: 'method_result',
            id,
            path: params['path'],
            method: params['method'],
            result: { echoed_args: params['args'] ?? [] },
          });
          break;
        case 'get_metrics':
          reply({ type: 'metrics', id, data: { fps: 60, object_node_count: 42 } });
          break;
        case 'find_nodes':
          reply({
            type: 'nodes',
            id,
            count: 1,
            truncated: false,
            nodes: [{ name: 'Player', type: 'CharacterBody2D', path: '/root/Player' }],
            // Echoed so the test can see the filters arrived under the names the addon reads.
            asked: params,
          });
          break;
        case 'click':
          reply({
            type: 'clicked',
            id,
            path: params['path'],
            hovered: params['path'],
            landed: true,
            control_afterwards: 'in_tree',
            asked: params,
          });
          break;
        case 'wait_signal':
          reply({ type: 'signal', id, fired: true, args: [3], elapsed_ms: 12, asked: params });
          break;
        case 'capture_screenshot':
        case 'capture_viewport': {
          const screenshotPath = text(params['output_path']);
          writeFileSync(screenshotPath, Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'));
          reply({ type: 'screenshot_file', id, path: screenshotPath, width: 1, height: 1, format: 'png' });
          break;
        }
        default:
          reply({ type: 'error', id, message: `Unknown command: ${String(request['command'])}` });
      }
    };
  });

  return new Promise<MockRuntime>((resolve, reject) => {
    runtime.once('error', reject);
    runtime.listen(0, '127.0.0.1', () => {
      const address = runtime.address();
      if (!address || typeof address === 'string') {
        reject(new Error('the mock runtime has no port'));
        return;
      }
      const announcement = join(directory, `runtime-${options.pid}.json`);
      writeFileSync(
        announcement,
        JSON.stringify({
          protocol: RUNTIME_PROTOCOL,
          pid: options.pid,
          port: address.port,
          address: '127.0.0.1',
          project: { name: options.name, path: options.projectPath },
        }),
      );
      resolve({
        port: address.port,
        announcement,
        close: () =>
          new Promise<void>((done, fail) => {
            rmSync(announcement, { force: true });
            for (const socket of open) {
              socket.destroy();
            }
            runtime.close((error) => {
              if (error) fail(error);
              else done();
            });
          }),
      });
    });
  });
}

/** The id of a process that has already exited, for an announcement nobody is behind. */
function deadProcessId(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', () => {
      if (child.pid === undefined) {
        reject(new Error('the short-lived child had no pid'));
        return;
      }
      resolve(child.pid);
    });
  });
}

async function connect(url: string): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      reject(new Error(`${url}: connect timeout`));
    }, 3000);
    socket.on('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function parseFrame(data: RawData): Record<string, unknown> | null {
  try {
    const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const bridgePort = await reservePort();
  const projectPath = createTestProjectFixture();
  // Announcements go to a directory of this test's own, so a game running on the machine is
  // neither found by the server under test nor confused by the mocks.
  const runtimeDir = mkdtempSync(join(tmpdir(), 'gdharness-runtime-'));
  const server = new ServerProcess({
    env: {
      DEBUG: 'true',
      GDHARNESS_BRIDGE_PORT: String(bridgePort),
      GDHARNESS_BRIDGE_HOST: BRIDGE_HOST,
      GDHARNESS_RUNTIME_DIR: runtimeDir,
      GDHARNESS_RUNTIME_TIMEOUT_MS: '1500',
      ...(GODOT_PATH ? { GODOT_PATH } : {}),
    },
  });

  const call = async (name: string, args: unknown): Promise<JsonRpcMessage> =>
    await server.request('tools/call', { name, arguments: args }, 15000);
  const payload = async (name: string, args: unknown): Promise<unknown> => {
    const response = await call(name, args);
    const parsed = parseTextContent(response);
    assert.ok(parsed !== null, `${name} should answer with JSON text, got ${JSON.stringify(response)}`);
    return parsed;
  };

  try {
    // The protocol handshake.
    const init = await server.initialize('bridge-test');
    assert.ok(get(init.result, 'serverInfo', 'name'), 'initialize reports a server name');
    // An advertised capability is one a client will call, so advertising prompts the server does
    // not serve is a promise it breaks on the first request.
    assert.equal(
      get(init.result, 'capabilities', 'prompts'),
      undefined,
      'the server does not advertise prompts',
    );

    // The whole surface in one page, under names a strict client accepts, each refusing what
    // it does not name.
    const tools = asArray(get((await server.request('tools/list')).result, 'tools'), 'tools/list');
    const names = tools.map((tool) => String(get(tool, 'name')));
    assert.equal(names.length, TOOL_COUNT, `tools/list carries the whole surface: ${names.join(', ')}`);
    assert.deepEqual(
      names.filter((name) => !TOOL_NAME_PATTERN.test(name)),
      [],
      'every name is domain_verb',
    );
    assert.equal(new Set(names).size, names.length, 'no name is listed twice');
    for (const tool of tools) {
      assert.equal(
        get(tool, 'inputSchema', 'additionalProperties'),
        false,
        `${text(get(tool, 'name'))} is closed`,
      );
    }

    // Refusals come from the spec, before anything is looked up or spawned.
    const unknownTool = await call('scene_nodes', {});
    assert.match(
      unknownTool.error?.message ?? '',
      /Unknown tool: scene_nodes\. Tools: /,
      'an unknown tool is named with the list',
    );
    const unknownOp =
      textOf(await call('scene_node', { projectPath, scenePath: 'a.tscn', op: 'paint' })) ?? '';
    assert.match(
      unknownOp,
      /has no op "paint"\. Valid ops: add, get, set/,
      'an unknown op is refused with the valid set',
    );
    const noOp = textOf(await call('scene_node', { projectPath, scenePath: 'a.tscn' })) ?? '';
    assert.match(noOp, /scene_node needs op, one of: add/, 'a tool with no default op says so');
    const stray = textOf(await call('project_search', { projectPath, query: 'x', depth: 2 })) ?? '';
    assert.match(stray, /project_search does not take depth\. It takes: /, 'a stray argument is refused');
    const missing = textOf(await call('runtime_invoke', { op: 'set', nodePath: '/root' })) ?? '';
    assert.match(missing, /runtime_invoke set needs property, value/, 'a missing op argument is named');

    // ClassDB introspection and the project search, which reach the engine.
    if (HAS_USABLE_GODOT) {
      const classes = await payload('editor_classes', {
        projectPath,
        category: 'node2d',
        filter: 'sprite',
        instantiableOnly: true,
      });
      assert.ok(asArray(get(classes, 'classes')).length > 0, 'editor_classes query returns classes');
      const info = await payload('editor_classes', { projectPath, op: 'info', className: 'Node2D' });
      assert.equal(get(info, 'class_name'), 'Node2D');
      assert.ok(asArray(get(info, 'methods')).length > 0, 'editor_classes info returns methods');
    } else if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and no executable Godot was found.');
    }

    const search = textOf(
      await call('project_search', {
        projectPath,
        query: 'extends CharacterBody2D',
        fileTypes: ['gd'],
        maxResults: 10,
      }),
    );
    assert.ok(
      search?.includes('player.gd'),
      `project_search finds the file that carries the match, got ${search}`,
    );

    // The runtime tools, relayed to a mock addon found through its announcement.
    const notRunning = await payload('editor_status', {});
    assert.equal(
      get(notRunning, 'game', 'runtimeConnected'),
      false,
      'editor_status reports no runtime without an announcement',
    );
    assert.equal(get(notRunning, 'game', 'processActive'), false);
    assert.match(
      textOf(await call('runtime_inspect', {})) ?? '',
      /No game with the runtime addon is running/,
      'a runtime tool with no game says so',
    );

    // An announcement left behind by a game that is gone is dropped, and deleted on the way.
    const stale = join(runtimeDir, `runtime-${await deadProcessId()}.json`);
    writeFileSync(
      stale,
      JSON.stringify({ protocol: RUNTIME_PROTOCOL, pid: 0, port: 1, address: '127.0.0.1' }),
    );
    assert.equal(get(await payload('editor_status', {}), 'game', 'runtimeConnected'), false);
    assert.ok(!existsSync(stale), 'a stale announcement is deleted when it is found');

    const runtime = await startMockRuntime(runtimeDir, {
      pid: process.pid,
      projectPath,
      name: 'fixture',
    });
    try {
      const connected = await payload('editor_status', {});
      assert.equal(
        get(connected, 'game', 'runtimeConnected'),
        true,
        'editor_status reports the runtime once the addon answers a ping',
      );
      assert.equal(get(connected, 'game', 'runtimes', 0, 'pid'), process.pid, 'the game is named by pid');
      assert.equal(get(connected, 'game', 'runtimes', 0, 'port'), runtime.port);

      const tree = await payload('runtime_inspect', { nodePath: '/root', depth: 2 });
      assert.equal(get(tree, 'type'), 'tree');
      assert.equal(get(tree, 'root', 'path'), '/root', 'runtime_inspect relays the addon tree');
      assert.equal(get(tree, 'id'), undefined, 'the request id is the relay business, not the answer');

      const set = await payload('runtime_invoke', {
        op: 'set',
        nodePath: '/root/Player',
        property: 'visible',
        value: true,
      });
      assert.equal(get(set, 'type'), 'property_set');
      assert.equal(get(set, 'new_value'), true, 'runtime_invoke set relays the addon property update');

      const called = await payload('runtime_invoke', {
        op: 'call',
        nodePath: '/root/Player',
        method: 'jump',
        args: [1, 2],
      });
      assert.equal(get(called, 'type'), 'method_result');
      assert.deepEqual(
        get(called, 'result', 'echoed_args'),
        [1, 2],
        'runtime_invoke call relays the method result',
      );

      const metrics = await payload('runtime_inspect', { op: 'metrics', metrics: ['fps'] });
      assert.equal(get(metrics, 'type'), 'metrics');
      assert.equal(get(metrics, 'data', 'fps'), 60, 'runtime_inspect metrics relays the addon metrics');

      // The newer questions, each carried to the addon under the names it reads.
      const found = await payload('runtime_inspect', {
        op: 'find',
        className: 'CharacterBody2D',
        namePattern: 'Play*',
        limit: 5,
      });
      assert.equal(get(found, 'nodes', 0, 'path'), '/root/Player', 'runtime_inspect find relays the paths');
      assert.deepEqual(
        get(found, 'asked'),
        { class: 'CharacterBody2D', name: 'Play*', root: '/root', limit: 5 },
        'only the filters given are sent, under the addon names',
      );
      assert.match(
        textOf(await call('runtime_inspect', { op: 'find' })) ?? '',
        /needs at least one of className, script, namePattern, group/,
        'a find with nothing to find by is refused before the game is asked',
      );

      const clicked = await payload('runtime_input', { op: 'click', nodePath: '/root/Menu/Play' });
      assert.equal(get(clicked, 'landed'), true, 'runtime_input click relays the addon answer');
      assert.deepEqual(
        get(clicked, 'asked'),
        { path: '/root/Menu/Play', button: 'left', double: false },
        'click carries the path, the button and whether it is a double click',
      );

      const waited = await payload('runtime_wait', {
        op: 'signal',
        nodePath: '/root/Player',
        signal: 'died',
        timeoutMs: 250,
      });
      assert.equal(get(waited, 'fired'), true, 'runtime_wait signal relays the addon answer');
      assert.deepEqual(
        get(waited, 'asked'),
        { path: '/root/Player', signal: 'died', timeout_ms: 250 },
        'the wait carries its timeout to the game',
      );

      for (const args of [{}, { op: 'viewport', viewportPath: '/root' }] as const) {
        const label = `runtime_capture ${JSON.stringify(args)}`;
        const image = contentOf(await call('runtime_capture', args)).find((chunk) => chunk.type === 'image');
        assert.ok(image, `${label} answers with an image block`);
        assert.equal(image.mimeType, 'image/png');
        assert.ok(image.data, `${label} carries the image bytes`);
        assert.ok(
          !('text' in image),
          `${label} image block carries no text field, as the MCP schema requires`,
        );
      }

      // A second game: the tools refuse to guess between the two, and projectPath picks one.
      const otherProject = join(tmpdir(), 'gdharness-other-project');
      const serverPid = server.child.pid ?? 0;
      assert.ok(serverPid > 0, 'the server child has a pid to announce under');
      const other = await startMockRuntime(runtimeDir, {
        pid: serverPid,
        projectPath: otherProject,
        name: 'other',
      });
      try {
        assert.match(
          textOf(await call('runtime_inspect', {})) ?? '',
          /Several games are running: .*Pass projectPath/,
          'two games and no projectPath is refused with both named',
        );
        const chosen = await payload('runtime_inspect', { projectPath: otherProject });
        assert.equal(get(chosen, 'root', 'name'), 'other', 'projectPath picks the game running that project');
        const first = await payload('runtime_inspect', { projectPath });
        assert.equal(get(first, 'root', 'name'), 'fixture');
        assert.match(
          textOf(await call('runtime_inspect', { projectPath: join(tmpdir(), 'nowhere') })) ?? '',
          /No running game is from /,
          'a projectPath no game runs is refused with the games that are',
        );
      } finally {
        await other.close();
      }
    } finally {
      await runtime.close();
    }

    // The three ways a game that exists can still fail to answer.
    const silent = await startMockRuntime(runtimeDir, {
      pid: process.pid,
      projectPath,
      name: 'silent',
      silent: true,
    });
    try {
      assert.match(
        textOf(await call('runtime_inspect', {})) ?? '',
        /did not answer 'get_tree' within \d+ms/,
        'a game that accepts and says nothing is reported as busy',
      );
    } finally {
      await silent.close();
    }

    const older = await startMockRuntime(runtimeDir, {
      pid: process.pid,
      projectPath,
      name: 'older',
      protocol: 1,
    });
    try {
      assert.match(
        textOf(await call('runtime_inspect', {})) ?? '',
        /speaks runtime protocol 1 and this server speaks 2/,
        'an addon from before this protocol is told apart from a broken one',
      );
    } finally {
      await older.close();
    }

    const closedPort = await reservePort();
    const nobody = join(runtimeDir, `runtime-${process.pid}.json`);
    writeFileSync(
      nobody,
      JSON.stringify({
        protocol: RUNTIME_PROTOCOL,
        pid: process.pid,
        port: closedPort,
        address: '127.0.0.1',
        project: { name: 'nobody', path: projectPath },
      }),
    );
    try {
      assert.match(
        textOf(await call('runtime_inspect', {})) ?? '',
        /nothing answered on its port/,
        'an announced port nobody listens on is reported as refused',
      );
    } finally {
      rmSync(nobody, { force: true });
    }

    // The editor bridge over WebSocket.
    const disconnected = await payload('editor_status', {});
    assert.equal(
      get(disconnected, 'editor', 'connected'),
      false,
      'editor_status reports disconnected before any editor connects',
    );

    const noEditor =
      textOf(
        await call('scene_create', {
          project_path: projectPath,
          scene_path: 'res://test.tscn',
          root_node_type: 'Node2D',
        }),
      ) ?? '';
    assert.match(noEditor, /Editor not connected/, 'scene_create refuses when no editor is connected');

    // Only the editor's path is served: the bridge port is not a place for a browser tab to
    // reach anything, over WebSocket or over HTTP.
    await assert.rejects(
      connect(`ws://${BRIDGE_HOST}:${bridgePort}/visualizer`),
      'a socket to another path is closed',
    );
    const page = await fetch(`http://${BRIDGE_HOST}:${bridgePort}/`);
    assert.equal(page.status, 404, 'a plain request gets nothing');
    assert.equal(page.headers.get('access-control-allow-origin'), null, 'and no CORS header inviting one');

    const godot = await connect(`ws://${BRIDGE_HOST}:${bridgePort}/godot`);
    try {
      godot.send(JSON.stringify({ type: 'godot_ready', project_path: projectPath }));
      await delay(300);
      const afterReady = await payload('editor_status', {});
      assert.equal(
        get(afterReady, 'editor', 'connected'),
        true,
        'editor_status reports connected after godot_ready',
      );

      // A tool call becomes a tool_invoke on the editor side, with its arguments normalised.
      const invoked = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('No tool_invoke received within 5 s'));
        }, 5000);
        godot.on('message', (data) => {
          const frame = parseFrame(data);
          if (frame?.['type'] === 'tool_invoke') {
            clearTimeout(timer);
            resolve(frame);
          }
        });
      });
      const pendingCreate = call('scene_create', {
        project_path: projectPath,
        scene_path: 'res://test_bridge.tscn',
        root_node_type: 'Node2D',
      });
      const invoke = await invoked;
      assert.equal(invoke['tool'], 'create_scene', 'the tool is routed to the editor command it stands for');
      assert.deepEqual(
        {
          projectPath: get(invoke, 'args', 'projectPath'),
          scenePath: get(invoke, 'args', 'scenePath'),
          rootNodeType: get(invoke, 'args', 'rootNodeType'),
        },
        { projectPath, scenePath: 'res://test_bridge.tscn', rootNodeType: 'Node2D' },
        'bridge arguments are normalised to camelCase before dispatch',
      );

      godot.send(
        JSON.stringify({
          type: 'tool_result',
          id: invoke['id'],
          success: true,
          result: {
            message: 'Scene created successfully',
            scene_path: 'res://test_bridge.tscn',
            root_type: 'Node2D',
          },
        }),
      );
      const created = textOf(await pendingCreate) ?? '';
      assert.ok(
        created.includes('test_bridge'),
        `the editor's result reaches the MCP caller, got ${created}`,
      );

      // Missing arguments are refused before anything reaches the editor.
      const unexpected: Record<string, unknown>[] = [];
      const capture = (data: RawData): void => {
        const frame = parseFrame(data);
        if (frame?.['type'] === 'tool_invoke') unexpected.push(frame);
      };
      godot.on('message', capture);
      const startedAt = Date.now();
      const bare = await call('scene_create', {});
      const elapsed = Date.now() - startedAt;
      godot.off('message', capture);
      assert.match(
        textOf(bare) ?? '',
        /scene_create create needs projectPath, scenePath/,
        `scene_create with no arguments is refused, got ${JSON.stringify(bare)}`,
      );
      assert.ok(elapsed < 1000, `the refusal is immediate rather than a timeout (${elapsed} ms)`);
      assert.deepEqual(unexpected, [], 'a refused call emits no tool_invoke');
    } finally {
      godot.close();
    }

    console.log('bridge integration tests passed');
  } finally {
    await server.stop();
    rmSync(projectPath, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

await main();
