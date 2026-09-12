#!/usr/bin/env node
/**
 * The bridge end to end: the MCP protocol over stdio, the prompts, the tool catalog, the tools
 * that relay to the runtime addon over its socket, and the editor addon's WebSocket, driven by
 * a mock Godot on each side so that what is asserted is the relay and not the engine.
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
import { sanitizeToolName } from './support/tool-name.js';

const BRIDGE_HOST = process.env['GDHARNESS_BRIDGE_HOST'] ?? '127.0.0.1';
const GODOT_PATH = resolveGodotPath(process.env['GODOT_PATH']);
const HAS_USABLE_GODOT = Boolean(GODOT_PATH && isExecutableFile(GODOT_PATH));
// The runtime addon listens on a fixed port, so the mock of it has to as well.
const RUNTIME_PORT = 7777;
const OPENAI_COMPATIBLE_TOOL_NAME_PATTERN = /^[a-zA-Z0-9-]{1,128}$/;
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
      GDHARNESS_TOOL_PROFILE: 'compact',
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

    // The catalog answers before tools/list has ever been called.
    const catalog = await payload('tool.catalog', { limit: 20 });
    assert.ok(
      Number(get(catalog, 'totalTools')) > 0,
      'tool.catalog reports a non-zero total before tools/list',
    );
    const sceneCatalog = await payload('tool.catalog', { query: 'scene', limit: 20 });
    const catalogTools = asArray(get(sceneCatalog, 'tools')).map((entry) => get(entry, 'tool'));
    assert.ok(catalogTools.includes('create_scene'), 'a catalog query for "scene" lists create_scene');

    // Every page of tools/list, with names a strict client accepts.
    const names: string[] = [];
    let cursor: unknown;
    for (let page = 1; page <= 20; page += 1) {
      const result = (await server.request('tools/list', cursor ? { cursor } : {})).result;
      for (const tool of asArray(get(result, 'tools'), `tools/list page ${page}`))
        names.push(String(get(tool, 'name')));
      cursor = get(result, 'nextCursor');
      if (!cursor) break;
    }
    assert.ok(names.length > 0, 'tools/list returned tools');
    assert.deepEqual(
      names.filter((name) => !OPENAI_COMPATIBLE_TOOL_NAME_PATTERN.test(name)),
      [],
      'every listed name is OpenAI-compatible',
    );
    const listed = new Set(names);
    for (const alias of ['editor.status', 'runtime.status', 'scene.create', 'scene.node.add']) {
      assert.ok(listed.has(sanitizeToolName(alias)), `${alias} is listed under its sanitized alias`);
    }
    for (const hidden of ['list_scene_nodes', 'create_resource', 'create_animation']) {
      assert.ok(!listed.has(sanitizeToolName(hidden)), `${hidden} is not on the compact surface`);
    }

    // ClassDB introspection and the project search, which reach the engine.
    if (HAS_USABLE_GODOT) {
      const classes = await payload('query_classes', {
        projectPath,
        category: 'node2d',
        filter: 'sprite',
        instantiableOnly: true,
      });
      assert.ok(asArray(get(classes, 'classes')).length > 0, 'query_classes returns classes');
      const info = await payload('query_class_info', { projectPath, className: 'Node2D' });
      assert.equal(get(info, 'class_name'), 'Node2D');
      assert.ok(asArray(get(info, 'methods')).length > 0, 'query_class_info returns methods');
    } else if (process.env['GDHARNESS_REQUIRE_GODOT']) {
      throw new Error('GDHARNESS_REQUIRE_GODOT is set and no executable Godot was found.');
    }

    const search = textOf(
      await call('search_project', {
        projectPath,
        query: 'extends CharacterBody2D',
        fileTypes: ['gd'],
        maxResults: 10,
      }),
    );
    assert.ok(
      search?.includes('player.gd'),
      `search_project finds the file that carries the match, got ${search}`,
    );

    // The runtime tools, relayed to a mock addon over its socket.
    const notRunning = await payload('runtime.status', { projectPath });
    assert.equal(get(notRunning, 'connected'), false, 'runtime.status reports disconnected without an addon');
    assert.equal(get(notRunning, 'status'), 'not_running');

    const runtime = await startMockRuntime();
    try {
      const connected = await payload('runtime.status', { projectPath });
      assert.equal(
        get(connected, 'connected'),
        true,
        'runtime.status reports connected once the addon answers a ping',
      );
      assert.equal(get(connected, 'runtimeAddon'), 'connected');

      const tree = await payload('inspect_runtime_tree', { projectPath, nodePath: '/root', depth: 2 });
      assert.equal(get(tree, 'type'), 'tree');
      assert.equal(get(tree, 'root', 'path'), '/root', 'inspect_runtime_tree relays the addon tree');

      const set = await payload('set_runtime_property', {
        projectPath,
        nodePath: '/root/Player',
        property: 'visible',
        value: true,
      });
      assert.equal(get(set, 'type'), 'property_set');
      assert.equal(get(set, 'new_value'), true, 'set_runtime_property relays the addon property update');

      const called = await payload('call_runtime_method', {
        projectPath,
        nodePath: '/root/Player',
        method: 'jump',
        args: [1, 2],
      });
      assert.equal(get(called, 'type'), 'method_result');
      assert.deepEqual(
        get(called, 'result', 'echoed_args'),
        [1, 2],
        'call_runtime_method relays the method result',
      );

      const metrics = await payload('get_runtime_metrics', { projectPath, metrics: ['fps'] });
      assert.equal(get(metrics, 'type'), 'metrics');
      assert.equal(get(metrics, 'data', 'fps'), 60, 'get_runtime_metrics relays the addon metrics');

      for (const [tool, args] of [
        ['capture_screenshot', {}],
        ['capture_viewport', { viewportPath: '/root' }],
      ] as const) {
        const image = contentOf(await call(tool, args)).find((chunk) => chunk.type === 'image');
        assert.ok(image, `${tool} answers with an image block`);
        assert.equal(image.mimeType, 'image/png');
        assert.ok(image.data, `${tool} carries the image bytes`);
        assert.ok(
          !('text' in image),
          `${tool} image block carries no text field, as the MCP schema requires`,
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
    const disconnected = await payload('editor.status', {});
    assert.equal(
      get(disconnected, 'connected'),
      false,
      'editor.status reports disconnected before any editor connects',
    );

    const noEditor =
      textOf(await call('scene.create', { scene_path: 'res://test.tscn', root_type: 'Node2D' })) ?? '';
    assert.match(noEditor, /not connected|editor|error/i, 'scene.create refuses when no editor is connected');

    const visualizer = await connect(`ws://${BRIDGE_HOST}:${bridgePort}/visualizer`);
    visualizer.close();

    const godot = await connect(`ws://${BRIDGE_HOST}:${bridgePort}/godot`);
    try {
      godot.send(JSON.stringify({ type: 'godot_ready', project_path: projectPath }));
      await delay(300);
      const afterReady = await payload('editor.status', {});
      assert.equal(get(afterReady, 'connected'), true, 'editor.status reports connected after godot_ready');

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
      const pendingCreate = call('scene.create', {
        project_path: projectPath,
        scene_path: 'res://test_bridge.tscn',
        root_type: 'Node2D',
      });
      const invoke = await invoked;
      assert.equal(
        invoke['tool'],
        'create_scene',
        'the compact alias is routed to the bridge command it stands for',
      );
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
      const missing = await call('scene.create', {});
      const elapsed = Date.now() - startedAt;
      godot.off('message', capture);
      const refused = Boolean(missing.error) || /missing required arguments/i.test(textOf(missing) ?? '');
      assert.ok(refused, `scene.create with no arguments is refused, got ${JSON.stringify(missing)}`);
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
