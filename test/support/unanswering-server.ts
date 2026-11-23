/**
 * A stand-in server that answers every request but a tool call, which it hears and never answers.
 * It writes a line on stderr for each request, and ends when its input closes or after a minute.
 */
import process from 'node:process';
import { createInterface } from 'node:readline';
import { isRecord } from './json-rpc.js';

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message: unknown = JSON.parse(line);
  if (!isRecord(message)) {
    return;
  }
  process.stderr.write(`heard ${String(message['method'])}\n`);
  if (message['id'] !== undefined && message['method'] !== 'tools/call') {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message['id'], result: {} })}\n`);
  }
});
lines.on('close', () => {
  process.exit(0);
});
setTimeout(() => {
  process.exit(0);
}, 60_000);
