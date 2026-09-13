#!/usr/bin/env bun
/**
 * gdharness CLI entry point.
 *
 * Routes subcommands or falls through to the MCP server.
 */

import { getLocalVersion } from './version.js';

const args = process.argv.slice(2);
const command = args[0];

const CLI_COMMANDS = ['version', 'help', '--version', '-v', '--help', '-h'];

async function main(): Promise<void> {
  if (!command || !CLI_COMMANDS.includes(command)) {
    // Dynamic import so a CLI-only command never loads the MCP SDK.
    const { runGodotServer } = await import('./server.js');
    await runGodotServer();
    return;
  }

  switch (command) {
    case 'version':
    case '--version':
    case '-v': {
      console.log(`gdharness v${getLocalVersion()}`);
      break;
    }
    case 'help':
    case '--help':
    case '-h': {
      printHelp();
      break;
    }
  }
}

function printHelp(): void {
  console.log(
    `
gdharness v${getLocalVersion()}, a harness for driving a Godot 4 project from an agent

Usage:
  gdharness            Start the MCP server (default)
  gdharness version    Show the installed version
  gdharness help       Show this help

More info: https://github.com/Aureliolo/gdharness
`.trim(),
  );
}

await main().catch((error: unknown) => {
  console.error('gdharness:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
