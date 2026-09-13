#!/usr/bin/env node
import process from 'node:process';
import { WebSocket } from 'ws';
import { isRecord } from './support/json-rpc.js';
import { reservePort, ServerProcess } from './support/server.js';

/** domain_verb, which every client accepts: no dots, no case, nothing a strict client rejects. */
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

async function connectWebSocket(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`timeout connecting to ${url}`));
    }, 3000);

    ws.once('open', () => {
      clearTimeout(timer);
      ws.close();
      resolve();
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
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
    if (!isRecord(capabilities) || !capabilities['prompts']) {
      throw new Error('missing prompts capability');
    }

    const prompts = await server.request('prompts/list');
    if (listOf(prompts.result, 'prompts').length < 2) {
      throw new Error('missing prompts/list response');
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

    await connectWebSocket(`ws://${host}:${port}/visualizer`);
    await connectWebSocket(`ws://${host}:${port}/godot`);

    console.log(`ci smoke passed with ${tools.length} tools on ${host}:${port}`);
    await server.stop();
  } catch (error) {
    await server.stop();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

await main();
