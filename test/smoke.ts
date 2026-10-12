#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { WebSocket } from 'ws';
import { isRecord } from './support/json-rpc.js';
import { reservePort, ServerProcess, testServerEnvironment } from './support/server.js';
import { sweep } from './support/sweep.js';

/**
 * The protocol revision the README badge names, read from the badge, so the badge cannot claim a
 * revision this case does not connect in.
 */
function badgedRevision(): string {
  const badge = /\[!\[MCP (\d{4}-\d{2}-\d{2})\]\(https:\/\/img\.shields\.io\/badge\/MCP-([\d-]+)-/.exec(
    readFileSync('README.md', 'utf8'),
  );
  assert.ok(badge?.[1] !== undefined && badge[2] !== undefined, 'the README carries an MCP revision badge');
  // Shields escapes a dash in the label text by doubling it.
  assert.equal(badge[2].replaceAll('--', '-'), badge[1], 'whose image says the revision its alt text does');
  return badge[1];
}

/** domain_verb, which every client accepts: no dots, no case, nothing a strict client rejects. */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

/** Whether a WebSocket to the URL opens, or is refused, within a few seconds. */
async function webSocketOpens(url: string): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`timeout connecting to ${url}`));
    }, 3000);

    ws.once('open', () => {
      clearTimeout(timer);
      ws.close();
      resolve(true);
    });
    // A refused socket can report more than one error; the promise settles once and the rest
    // must still land on a listener.
    ws.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function listOf(result: unknown, key: string): unknown[] {
  if (!isRecord(result) || !Array.isArray(result[key])) {
    throw new Error(`response carries no ${key} array`);
  }
  return result[key] as unknown[];
}

async function main(): Promise<void> {
  const host = process.env['GDHARNESS_BRIDGE_HOST'] ?? '127.0.0.1';
  const configuredPort = Number.parseInt(process.env['GDHARNESS_BRIDGE_PORT'] ?? '', 10);
  const port = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : await reservePort();

  const server = new ServerProcess({
    env: {
      GODOT_PATH: process.env['GODOT_PATH'] ?? process.execPath,
      GDHARNESS_BRIDGE_PORT: String(port),
      GDHARNESS_BRIDGE_HOST: host,
    },
  });

  try {
    const init = await server.initialize('ci-smoke');
    const capabilities = isRecord(init.result) ? init.result['capabilities'] : undefined;
    if (!isRecord(capabilities) || !capabilities['tools'] || !capabilities['resources']) {
      throw new Error('missing tools or resources capability');
    }

    const tools = listOf((await server.request('tools/list')).result, 'tools');
    if (tools.length === 0) {
      throw new Error('missing tools/list response');
    }
    const invalidToolNames = tools
      .map((tool) => (isRecord(tool) ? tool['name'] : undefined))
      .filter((name) => typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name));
    if (invalidToolNames.length > 0) {
      throw new Error(`tools/list exposed names outside domain_verb: ${invalidToolNames.join(', ')}`);
    }

    // The bridge port carries the editor's socket and nothing else.
    if (!(await webSocketOpens(`ws://${host}:${port}/godot`))) {
      throw new Error('the editor socket at /godot did not open');
    }
    if (await webSocketOpens(`ws://${host}:${port}/visualizer`)) {
      throw new Error('a socket to a path other than /godot was accepted');
    }

    await server.stop();
    await servesTheModernEra(tools.length);
    console.log(`ci smoke passed with ${tools.length} tools on ${host}:${port}, in both protocol eras`);
  } catch (error) {
    await server.stop();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * A client that opens in the 2026-07-28 revision, from the SDK rather than hand-written frames, so
 * the opening it sends is the one real clients send: no `initialize`, a `server/discover`, and an
 * envelope on every request. The handshake above is the 2025 one, and passing it says nothing about
 * this: a server wired straight to a stdio transport answers it and refuses every modern opening.
 */
async function servesTheModernEra(legacyToolCount: number): Promise<void> {
  const revision = badgedRevision();
  const { env, runtimeDir } = testServerEnvironment({ GODOT_PATH: process.env['GODOT_PATH'] ?? process.execPath });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['build/index.js'],
    env,
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'ci-smoke-modern', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: revision } } },
  );
  try {
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), 'modern', 'the connection is in the 2026 era');
    assert.equal(client.getNegotiatedProtocolVersion(), revision, `at ${revision}`);
    // Stamped on every 2026 response by the SDK, from the name and version the server gives it.
    const identity = client.getServerVersion();
    assert.equal(identity?.name, 'gdharness', 'the server names itself in the 2026 era');
    assert.equal(identity.version, packageVersion(), 'with the version it was built as');

    const { tools } = await client.listTools();
    assert.equal(tools.length, legacyToolCount, 'the 2026 era lists the tools the 2025 era does');

    // A call that needs no editor and no engine, read for what it answers rather than for not
    // failing: the dispatch, the argument check and the response all run in this era.
    const status = await client.callTool({ name: 'editor_status', arguments: {} });
    assert.notEqual(status.isError, true, `editor_status answered in the 2026 era: ${JSON.stringify(status)}`);
    const first = Array.isArray(status.content) ? status.content[0] : undefined;
    assert.ok(isRecord(first) && first['type'] === 'text', 'with a text block');
    assert.ok(isRecord(JSON.parse(String(first['text']))), 'carrying a JSON report');
  } finally {
    await client.close();
    if (runtimeDir !== null) sweep(runtimeDir);
  }
}

function packageVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.ok(isRecord(parsed) && typeof parsed['version'] === 'string', 'package.json names a version');
  return parsed['version'];
}

await main();
