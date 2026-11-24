/**
 * A stand-in server that answers every request but a tool call, which it hears and never answers.
 * It writes a line on stderr for each request, and ends when its input closes or after a minute.
 * Given `--opening-ms <n>`, it answers `server/discover` n milliseconds after hearing it.
 * Usage: unanswering-server.ts [--opening-ms <n>]
 */
import process from 'node:process';
import { createInterface } from 'node:readline';
import { isRecord } from './json-rpc.js';

const openingAt = process.argv.indexOf('--opening-ms');
const openingMs = openingAt === -1 ? 0 : Number(process.argv[openingAt + 1]);

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message: unknown = JSON.parse(line);
  if (!isRecord(message)) {
    return;
  }
  const method = message['method'];
  process.stderr.write(`heard ${String(method)}\n`);
  if (message['id'] === undefined || method === 'tools/call') {
    return;
  }
  const answer = `${JSON.stringify({ jsonrpc: '2.0', id: message['id'], result: {} })}\n`;
  setTimeout(
    () => {
      process.stdout.write(answer);
    },
    method === 'server/discover' ? openingMs : 0,
  );
});
lines.on('close', () => {
  process.exit(0);
});
setTimeout(() => {
  process.exit(0);
}, 60_000);
