#!/usr/bin/env node
/**
 * The bridge end to end: the MCP protocol over stdio, the prompts, the tool list, the tools that
 * relay to the runtime addon over its socket, and the editor addon's WebSocket, driven by a mock
 * Godot on each side so that what is asserted is the relay and not the engine.
 */
import assert from 'node:assert/strict';
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { type RawData, WebSocket } from 'ws';
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
// The runtime addon listens on a fixed port, so the mock of it has to as well.
const RUNTIME_PORT = 7777;
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

/** A mock of the runtime addon's socket protocol: one request per connection, answered by command. */
function startMockRuntime(): Promise<Server> {
  const runtime = createServer((socket: Socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;

      const line = (buffer.split('\n')[0] ?? '').trim();
      if (!line) {
        socket.end();
        return;
      }

      const reply = (payload: unknown): void => {
        socket.write(`${JSON.stringify(payload)}\n`);
      };

      try {
        const request = JSON.parse(line) as Record<string, unknown>;
        const id = request['id'];
        const params = isRecord(request['params']) ? request['params'] : {};
        reply({ type: 'welcome', protocol: 'godot_mcp_runtime', version: '1.0.0' });
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
                name: 'root',
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
          case 'capture_screenshot':
            reply({ type: 'screenshot', id, data: ONE_PIXEL_PNG_BASE64, width: 1, height: 1, format: 'png' });
            break;
          case 'capture_viewport': {
            const screenshotPath = text(params['output_path'] ?? params['outputPath']);
            writeFileSync(screenshotPath, Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'));
            reply({ type: 'screenshot_file', id, path: screenshotPath, width: 1, height: 1, format: 'png' });
            break;
          }
          default:
            reply({ type: 'error', id, error: `unknown command ${String(request['command'])}` });
        }
      } catch {
        reply({ error: 'invalid_json' });
      }
      socket.end();
    });
  });

  return new Promise<Server>((resolve, reject) => {
    runtime.once('error', reject);
    runtime.listen(RUNTIME_PORT, '127.0.0.1', () => {
      resolve(runtime);
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
  const server = new ServerProcess({
    env: {
      DEBUG: 'true',
      GDHARNESS_BRIDGE_PORT: String(bridgePort),
      GODOT_BRIDGE_HOST: BRIDGE_HOST,
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
    // The protocol handshake and the prompts.
    const init = await server.initialize('bridge-test');
    assert.ok(get(init.result, 'serverInfo', 'name'), 'initialize reports a server name');
    assert.ok(get(init.result, 'capabilities', 'prompts'), 'the server advertises the prompts capability');

    const prompts = asArray(get((await server.request('prompts/list')).result, 'prompts'), 'prompts');
    const promptNames = new Set(prompts.map((prompt) => get(prompt, 'name')));
    assert.ok(
      promptNames.has('godot.scene_bootstrap') && promptNames.has('godot.debug_triage'),
      'the two prompts are listed',
    );

    const bootstrap = await server.request('prompts/get', {
      name: 'godot.scene_bootstrap',
      arguments: { project_path: '/tmp/demo-project', scene_path: 'res://scenes/Player.tscn' },
    });
    const promptText = asArray(get(bootstrap.result, 'messages'), 'prompt messages')
      .map((message) => text(get(message, 'content', 'text')))
      .join('\n');
    assert.ok(
      promptText.includes('/tmp/demo-project') && promptText.includes('res://scenes/Player.tscn'),
      'prompts/get returns the template with its arguments filled in',
    );

    const unknownPrompt = await server.request('prompts/get', {
      name: 'godot.unknown_prompt',
      arguments: {},
    });
    assert.match(
      unknownPrompt.error?.message ?? '',
      /Unknown prompt/,
      'an unknown prompt is refused by name',
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
    const stray =
      textOf(await call('project_list', { directory: projectPath, recursive: true, depth: 2 })) ?? '';
    assert.match(
      stray,
      /project_list does not take depth\. It takes: directory, recursive/,
      'a stray argument is refused',
    );
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

    // The runtime tools, relayed to a mock addon over its socket.
    const notRunning = await payload('editor_status', {});
    assert.equal(
      get(notRunning, 'game', 'runtimeConnected'),
      false,
      'editor_status reports no runtime without an addon',
    );
    assert.equal(get(notRunning, 'game', 'processActive'), false);

    const runtime = await startMockRuntime();
    try {
      const connected = await payload('editor_status', {});
      assert.equal(
        get(connected, 'game', 'runtimeConnected'),
        true,
        'editor_status reports the runtime once the addon answers a ping',
      );

      const tree = await payload('runtime_inspect', { nodePath: '/root', depth: 2 });
      assert.equal(get(tree, 'type'), 'tree');
      assert.equal(get(tree, 'root', 'path'), '/root', 'runtime_inspect relays the addon tree');

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
    } finally {
      await new Promise<void>((resolve, reject) => {
        runtime.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
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

    const visualizer = await connect(`ws://${BRIDGE_HOST}:${bridgePort}/visualizer`);
    visualizer.close();

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
  }
}

await main();
