#!/usr/bin/env node
/**
 * The dynamic tool group flow as an MCP client sees it, with real tool execution at the end:
 * initialise and list the compact surface, activate groups through tool_catalog and through
 * manage_tool_groups, call tools that only exist once their group is active, deactivate, reset,
 * and refuse a group that does not exist.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_TOOL_GROUPS, TOOL_GROUPS } from '../src/tool-groups.js';
import { asArray, asNumber, get, text } from './support/json.js';
import { isRecord, type JsonRpcMessage, parseTextContent } from './support/json-rpc.js';
import { ServerProcess } from './support/server.js';
import { sanitizeToolName } from './support/tool-name.js';

const EXPECTED_CORE_GROUPS = Object.keys(CORE_TOOL_GROUPS).length;
const EXPECTED_DYNAMIC_GROUPS = Object.keys(TOOL_GROUPS).length;
const EXPECTED_TOTAL_GROUPS = EXPECTED_CORE_GROUPS + EXPECTED_DYNAMIC_GROUPS;
const COMPACT_TOOL_COUNT = 33;

/**
 * A project of its own, because the tool calls below are real ones and a path on the machine of
 * whoever wrote this is not a fixture. A project.godot is all the operations reached from here
 * need; the engine reads the rest from defaults.
 */
const TEST_PROJECT = mkdtempSync(join(tmpdir(), 'gdharness-groups-'));
writeFileSync(
  join(TEST_PROJECT, 'project.godot'),
  '; Engine configuration file.\nconfig_version=5\n\n[application]\nconfig/name="GdharnessGroupsFixture"\n',
);

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

async function toolNames(server: ServerProcess): Promise<string[]> {
  const response = await server.request('tools/list', {});
  assert.equal(response.error, undefined, `tools/list failed: ${response.error?.message}`);
  const result = isRecord(response.result) ? response.result : {};
  assert.equal(
    result['nextCursor'],
    undefined,
    'the page size is set large enough to list every tool at once',
  );
  return asArray(result['tools'], 'tools/list tools').map((tool) => String(get(tool, 'name')));
}

async function call(server: ServerProcess, name: string, args: unknown, what = name): Promise<unknown> {
  return payloadOf(await server.request('tools/call', { name, arguments: args }, 15000), what);
}

async function run(): Promise<void> {
  const server = new ServerProcess({
    env: { GDHARNESS_TOOL_PROFILE: 'compact', GDHARNESS_TOOLS_PAGE_SIZE: '200' },
  });

  try {
    const init = await server.initialize('e2e-test');
    assert.equal(
      get(init.result, 'capabilities', 'tools', 'listChanged'),
      true,
      'the server advertises listChanged',
    );

    // The compact surface, with the meta tools present and the grouped ones hidden.
    const initial = await toolNames(server);
    assert.equal(initial.length, COMPACT_TOOL_COUNT, 'the initial tool count');
    assert.ok(initial.includes(sanitizeToolName('tool.catalog')), 'tool.catalog is exposed');
    assert.ok(initial.includes(sanitizeToolName('tool.groups')), 'tool.groups is exposed');
    for (const hidden of ['create_animation', 'create_audio_bus', 'dap_set_breakpoint']) {
      assert.ok(!initial.includes(sanitizeToolName(hidden)), `${hidden} is hidden before activation`);
    }

    // tool_catalog activates the group its query names.
    const catalog = await call(server, 'tool.catalog', { query: 'animation' });
    assert.ok(
      asArray(get(catalog, 'newlyActivated')).includes('animation'),
      'the animation group is activated by the catalog query',
    );
    assert.ok(asArray(get(catalog, 'activeGroups')).includes('animation'), 'animation is in activeGroups');

    const afterAnimation = await toolNames(server);
    const animationTools = [
      'create_animation',
      'add_animation_track',
      'create_animation_tree',
      'add_animation_state',
      'connect_animation_states',
    ];
    for (const name of animationTools) {
      assert.ok(afterAnimation.includes(sanitizeToolName(name)), `${name} is exposed after activation`);
    }
    assert.equal(afterAnimation.length, COMPACT_TOOL_COUNT + 5, 'the tool count after animation activation');

    // Several groups at once, one through the catalog and one by hand.
    const audio = await call(server, 'tool.catalog', { query: 'audio' });
    assert.ok(
      asArray(get(audio, 'newlyActivated')).includes('audio'),
      'the audio group is activated by the catalog',
    );

    const dap = await call(server, 'tool.groups', { action: 'activate', group: 'dap' });
    assert.equal(get(dap, 'activated'), 'dap', 'the dap group is activated by hand');
    assert.equal(get(dap, 'wasAlreadyActive'), false, 'dap was newly activated');

    const withThree = await toolNames(server);
    assert.ok(
      withThree.includes(sanitizeToolName('create_audio_bus')),
      'create_audio_bus is exposed (audio group)',
    );
    assert.ok(
      withThree.includes(sanitizeToolName('dap_set_breakpoint')),
      'dap_set_breakpoint is exposed (dap group)',
    );
    assert.ok(
      withThree.includes(sanitizeToolName('dap_get_stack_trace')),
      'dap_get_stack_trace is exposed (dap group)',
    );
    assert.equal(withThree.length, COMPACT_TOOL_COUNT + 5 + 4 + 6, 'the tool count with three groups active');

    // status and list report the same state.
    const status = await call(server, 'tool.groups', { action: 'status' });
    assert.equal(get(status, 'dynamicGroups', 'activeCount'), 3, 'the active group count');
    const activeNames = asArray(get(status, 'dynamicGroups', 'groups'))
      .map((group) => String(get(group, 'name')))
      .sort();
    assert.deepEqual(activeNames, ['animation', 'audio', 'dap'], 'the active groups');

    const listed = await call(server, 'tool.groups', { action: 'list' });
    // Counted off the tables the server is built from rather than written out here. The three
    // numbers that used to be literals were 34, 12 and 22 against tables holding 31, 11 and 20,
    // so the test had been reporting on a shape the code left behind.
    assert.equal(get(listed, 'totalGroups'), EXPECTED_TOTAL_GROUPS, 'the total group count');
    assert.equal(get(listed, 'coreGroups'), EXPECTED_CORE_GROUPS, 'the core group count');
    assert.equal(get(listed, 'dynamicGroups'), EXPECTED_DYNAMIC_GROUPS, 'the dynamic group count');
    const groups = asArray(get(listed, 'groups'));
    const named = (name: string): unknown => groups.find((group) => get(group, 'name') === name);
    assert.equal(get(named('animation'), 'active'), true, 'animation shows as active in the list');
    assert.equal(get(named('navigation'), 'active'), false, 'navigation shows as inactive in the list');
    assert.equal(get(named('core_scene'), 'alwaysVisible'), true, 'core_scene is alwaysVisible');
    assert.equal(get(named('core_scene'), 'type'), 'core', 'core_scene has type core');

    // Deactivating one group leaves the others exposed.
    const deactivated = await call(server, 'tool.groups', { action: 'deactivate', group: 'audio' });
    assert.equal(get(deactivated, 'deactivated'), 'audio', 'the audio group is deactivated');
    assert.equal(get(deactivated, 'wasActive'), true, 'audio was active before');

    const afterDeactivation = await toolNames(server);
    assert.ok(
      !afterDeactivation.includes(sanitizeToolName('create_audio_bus')),
      'create_audio_bus is hidden again',
    );
    assert.ok(
      afterDeactivation.includes(sanitizeToolName('create_animation')),
      'create_animation is still exposed',
    );
    assert.ok(
      afterDeactivation.includes(sanitizeToolName('dap_set_breakpoint')),
      'dap_set_breakpoint is still exposed',
    );
    assert.equal(
      afterDeactivation.length,
      COMPACT_TOOL_COUNT + 5 + 6,
      'the tool count after deactivating audio',
    );

    // Reset takes everything back to the compact surface.
    const reset = await call(server, 'tool.groups', { action: 'reset' });
    assert.equal(get(reset, 'reset'), true, 'reset is confirmed');
    assert.equal(asArray(get(reset, 'deactivated')).length, 2, 'reset deactivated animation and dap');
    assert.equal((await toolNames(server)).length, COMPACT_TOOL_COUNT, 'the tool count after reset');

    // Tools that only exist once their group is active, called for real against the fixture
    // project. The absence of a JSON-RPC error says nothing on its own, so the assertion is on
    // the shape the tool promises, which only a real run produces.
    const autoload = await call(server, 'tool.groups', { action: 'activate', group: 'autoload' });
    assert.equal(get(autoload, 'activated'), 'autoload', 'the autoload group is activated');
    const autoloads = await call(server, 'list_autoloads', { projectPath: TEST_PROJECT });
    assert.ok(Array.isArray(get(autoloads, 'autoloads')), 'list_autoloads returned its autoloads');

    const dx = await call(server, 'tool.groups', { action: 'activate', group: 'dx_tools' });
    assert.equal(get(dx, 'activated'), 'dx_tools', 'the dx_tools group is activated');
    const health = await call(server, 'get_project_health', { projectPath: TEST_PROJECT });
    assert.ok(isRecord(get(health, 'checks')), 'get_project_health returned its checks');
    assert.ok(asNumber(get(health, 'score')) >= 0, 'get_project_health returned a score');

    // A group that does not exist is refused by name, and activating twice is idempotent.
    const unknown = await call(server, 'tool.groups', { action: 'activate', group: 'nonexistent_group' });
    assert.match(text(get(unknown, 'error')), /Unknown group/, 'an unknown group is refused');
    const again = await call(server, 'tool.groups', { action: 'activate', group: 'autoload' });
    assert.equal(get(again, 'wasAlreadyActive'), true, 'a duplicate activation is idempotent');

    // Keyword matching activates the group a query alludes to without naming it.
    await call(server, 'tool.groups', { action: 'reset' });
    const breakpoint = await call(server, 'tool.catalog', { query: 'breakpoint' });
    assert.ok(
      asArray(get(breakpoint, 'activeGroups')).includes('dap'),
      '"breakpoint" activates the dap group',
    );
    const theme = await call(server, 'tool.catalog', { query: 'theme' });
    assert.ok(
      asArray(get(theme, 'activeGroups')).includes('theme_ui'),
      '"theme" activates the theme_ui group',
    );
    const pathfinding = await call(server, 'tool.catalog', { query: 'pathfinding' });
    assert.ok(
      asArray(get(pathfinding, 'activeGroups')).includes('navigation'),
      '"pathfinding" activates the navigation group',
    );

    console.log('dynamic tool group end-to-end tests passed');
  } finally {
    await server.stop();
    rmSync(TEST_PROJECT, { recursive: true, force: true });
  }
}

await run();
