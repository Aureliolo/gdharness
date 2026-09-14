#!/usr/bin/env bun
/**
 * The shipped bundle, started by Node.
 *
 * Every harness spawns a server as `npx -y gdharness@VERSION`, and npx is Node, so a bundle that
 * only Bun can start is one nothing installs. The build targeted Bun until it was measured that
 * the embedded `ws` serves the editor socket under both, and this is what keeps that true.
 *
 * The code half only: Node is named here, so the shebang is never consulted. Which runtime the
 * published file asks for is asserted in `packaging-consistency.ts` and typed out for real by the
 * release's install job, because that half is what decides whether npx starts it at all.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

const HOST = '127.0.0.1';
const ENTRY = 'build/index.js';

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

function upgrades(port: number, path: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://${HOST}:${port}${path}`);
    const settle = (opened: boolean): void => {
      clearTimeout(timer);
      socket.close();
      resolve(opened);
    };
    const timer = setTimeout(() => {
      settle(false);
    }, timeoutMs);
    socket.on('open', () => {
      settle(true);
    });
    socket.on('error', () => {
      settle(false);
    });
  });
}

const port = await freePort();
// stdin stays open: the server speaks MCP over stdio and stops the moment it reads EOF.
const child = spawn('node', [ENTRY], {
  env: { ...process.env, GDHARNESS_BRIDGE_PORT: String(port), GDHARNESS_BRIDGE_HOST: HOST },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let answered = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => {
  answered += chunk;
});

try {
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'node-runtime-test', version: '1' },
      },
    })}\n`,
  );

  // A refused connection fails instantly, so the attempts are spaced: without this the whole
  // budget is spent before the server has finished binding.
  let opened = false;
  for (let attempt = 0; attempt < 60 && !opened; attempt += 1) {
    opened = await upgrades(port, '/godot', 1000);
    if (!opened) {
      await delay(250);
    }
  }
  assert.ok(opened, 'Node serves the editor socket at /godot');
  assert.equal(await upgrades(port, '/visualizer', 1500), false, 'and refuses a socket to any other path');

  assert.match(answered, /"serverInfo"/, 'Node answers the MCP handshake over stdio');
  assert.match(answered, /"protocolVersion"/, 'with a protocol version');
} finally {
  child.kill();
}

console.log(`node runtime test passed: ${ENTRY} starts under node and serves the editor socket`);
