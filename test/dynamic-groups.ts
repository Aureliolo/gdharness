#!/usr/bin/env node

import assert from 'node:assert/strict';
import process from 'node:process';
import { asArray, get } from './support/json.js';
import { isRecord, type JsonRpcMessage, parseTextContent } from './support/json-rpc.js';
import { ServerProcess } from './support/server.js';
import { sanitizeToolName } from './support/tool-name.js';

// A guard against the default surface growing by accident. Moving it is fine; moving it
// without meaning to is what this catches.
const COMPACT_TOOL_COUNT = 33;

const OPENAI_COMPATIBLE_TOOL_NAME_PATTERN = /^[a-zA-Z0-9-]{1,128}$/;

function payloadOf(response: JsonRpcMessage, what: string): unknown {
  assert.equal(
    response.error,
    undefined,
    `${what} answered with a JSON-RPC error: ${response.error?.message}`,
  );
  const payload = parseTextContent(response);
  assert.ok(payload !== null, `${what} did not return JSON text content`);
  return payload;
}

async function listAllTools(server: ServerProcess): Promise<string[]> {
  const names: string[] = [];
  let cursor: unknown;

  for (let page = 0; page < 20; page += 1) {
    const response = await server.request('tools/list', cursor ? { cursor } : {});
    assert.equal(response.error, undefined, `tools/list failed: ${response.error?.message}`);
    const result = isRecord(response.result) ? response.result : {};
    for (const tool of asArray(result['tools'] ?? [], 'tools/list tools')) {
      names.push(String(get(tool, 'name')));
    }
    cursor = result['nextCursor'];
    if (!cursor) break;
  }

  return names;
}

async function main(): Promise<void> {
  const server = new ServerProcess({
    env: {
      GODOT_PATH: process.env['GODOT_PATH'] ?? process.execPath,
      GDHARNESS_TOOL_PROFILE: 'compact',
    },
  });

  try {
    const init = await server.initialize('dynamic-group-test');
    assert.equal(init.error, undefined, `initialize failed: ${init.error?.message}`);

    const initialTools = await listAllTools(server);
    const initialToolNames = new Set(initialTools);
    const invalidInitialToolNames = initialTools.filter(
      (name) => !OPENAI_COMPATIBLE_TOOL_NAME_PATTERN.test(name),
    );

    assert.equal(
      initialTools.length,
      COMPACT_TOOL_COUNT,
      `the default compact profile should expose exactly ${COMPACT_TOOL_COUNT} tools`,
    );
    assert.deepEqual(invalidInitialToolNames, [], 'initial tools/list names should be OpenAI-compatible');
    assert.ok(
      initialToolNames.has(sanitizeToolName('tool.groups')),
      'the compact alias for tool.groups is listed',
    );
    assert.ok(
      !initialToolNames.has(sanitizeToolName('create_animation')),
      'an animation tool should be hidden before its group is activated',
    );

    const catalog = payloadOf(
      await server.request('tools/call', { name: 'tool.catalog', arguments: { query: 'animation' } }),
      'tool.catalog',
    );
    assert.ok(
      asArray(get(catalog, 'newlyActivated'), 'newlyActivated').includes('animation'),
      `tool_catalog should activate the animation group for the query "animation", got ${JSON.stringify(get(catalog, 'newlyActivated'))}`,
    );
    assert.ok(
      asArray(get(catalog, 'activeGroups'), 'activeGroups').includes('animation'),
      'tool_catalog should report the animation group as active',
    );

    const multiWord = payloadOf(
      await server.request('tools/call', {
        name: 'tool.catalog',
        arguments: { query: 'inject mouse click viewport capture' },
      }),
      'tool.catalog (multi-word)',
    );
    const multiWordNames = asArray(get(multiWord, 'tools'), 'catalog tools').map((entry) =>
      get(entry, 'tool'),
    );
    assert.ok(
      multiWordNames.includes('inject_mouse_click') && multiWordNames.includes('capture_viewport'),
      `tool_catalog should answer a multi-word query with the tools it describes, got ${JSON.stringify(multiWordNames)}`,
    );

    const postActivationNames = new Set(await listAllTools(server));
    const animationGroupTools = [
      'create_animation',
      'add_animation_track',
      'create_animation_tree',
      'add_animation_state',
      'connect_animation_states',
    ];
    const missingAfterActivation = animationGroupTools.filter(
      (name) => !postActivationNames.has(sanitizeToolName(name)),
    );
    assert.deepEqual(missingAfterActivation, [], 'after activation every animation tool should be exposed');

    const status = payloadOf(
      await server.request('tools/call', { name: 'tool.groups', arguments: { action: 'status' } }),
      'tool.groups status',
    );
    const statusActiveNames = asArray(get(status, 'dynamicGroups', 'groups') ?? []).map((group) =>
      get(group, 'name'),
    );
    assert.ok(
      statusActiveNames.includes('animation'),
      'manage_tool_groups status should show animation as active',
    );

    const reset = payloadOf(
      await server.request('tools/call', { name: 'tool.groups', arguments: { action: 'reset' } }),
      'tool.groups reset',
    );
    assert.deepEqual(
      get(reset, 'activeGroups'),
      [],
      'manage_tool_groups reset should deactivate every group',
    );

    const afterResetTools = await listAllTools(server);
    const afterResetNames = new Set(afterResetTools);
    assert.equal(
      afterResetTools.length,
      COMPACT_TOOL_COUNT,
      `after reset the compact profile should expose exactly ${COMPACT_TOOL_COUNT} tools again`,
    );
    const stillExposed = animationGroupTools.filter((name) => afterResetNames.has(sanitizeToolName(name)));
    assert.deepEqual(stillExposed, [], 'after reset no animation tool should still be exposed');

    console.log('dynamic tool group tests passed');
  } finally {
    await server.stop();
    if (process.exitCode && server.stderr.trim()) {
      console.log('\n[Server stderr excerpt]');
      console.log(server.stderr.trim().split('\n').slice(-10).join('\n'));
    }
  }
}

await main();
