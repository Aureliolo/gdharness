/**
 * The agent harnesses gdharness can wire itself into, and how each one spells a stdio server.
 *
 * There are hundreds of harnesses and one thing they agree on, which is that a server is a
 * command to spawn. The disagreement is only ever the file, the key and the shape, so this is a
 * table rather than an integration per harness.
 *
 * Nothing here parses TOML or YAML. A harness whose config is either gets the command that its
 * own CLI documents, because rewriting a file we cannot round-trip would cost somebody their
 * comments to save them one paste.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** What gdharness is called wherever it is registered. */
export const SERVER_KEY = 'gdharness';

/** The command a harness spawns, which is the same everywhere and is the point of publishing. */
export interface Launch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The version is pinned rather than left as `latest` because the server and the addons it
 * installed into the project have to be the same version: `editor_status` reports a mismatch as
 * `addonIsStale`, and `latest` is how a project silently acquires one.
 */
export function launchFor(version: string, godotPath: string): Launch {
  return {
    command: 'npx',
    args: ['-y', `gdharness@${version}`],
    env: { GODOT_PATH: godotPath },
  };
}

/**
 * How a harness holds its servers.
 *
 * `mcpServers` is the shape most of them took from Claude Desktop. VS Code named the same thing
 * `servers`, and opencode disagrees about every key, which is why the shape is a function rather
 * than a key name.
 */
export type Dialect = 'mcpServers' | 'servers' | 'opencode';

export interface Harness {
  /** The flag that selects it, and what `init` prints. */
  readonly id: string;
  readonly name: string;
  /**
   * Where the entry goes. A project path is preferred wherever the harness has one: gdharness is
   * per-project, since it carries that project's Godot path and installed its addons.
   */
  readonly scope: 'project' | 'home';
  /** Relative to the project, or to the home directory. */
  readonly file: string;
  readonly dialect: Dialect;
  /**
   * Its own command for adding a server, for a harness whose config this cannot safely write.
   * Present means the file is TOML or YAML, or the harness only configures through a GUI.
   */
  readonly addCommand?: (launch: Launch) => readonly string[];
  /**
   * What to put in the file by hand, for a harness with neither a config this can write nor a
   * documented command. Shown rather than guessed at: a command invented from a blog post is the
   * one thing worse than asking somebody to paste six lines.
   */
  readonly snippet?: (launch: Launch) => string;
}

/** Everything that shows up on a config path we can name exactly. */
export const HARNESSES: readonly Harness[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    scope: 'project',
    file: '.mcp.json',
    dialect: 'mcpServers',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    scope: 'project',
    file: join('.cursor', 'mcp.json'),
    dialect: 'mcpServers',
  },
  {
    id: 'vscode',
    name: 'VS Code',
    scope: 'project',
    file: join('.vscode', 'mcp.json'),
    dialect: 'servers',
  },
  {
    id: 'opencode',
    name: 'opencode',
    scope: 'project',
    file: 'opencode.json',
    dialect: 'opencode',
  },
  {
    id: 'junie',
    name: 'Junie',
    scope: 'project',
    file: join('.junie', 'mcp', 'mcp.json'),
    dialect: 'mcpServers',
  },
  {
    id: 'kiro',
    name: 'Kiro',
    scope: 'project',
    file: join('.kiro', 'settings', 'mcp.json'),
    dialect: 'mcpServers',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    scope: 'home',
    file: join('.gemini', 'settings.json'),
    dialect: 'mcpServers',
  },
  {
    id: 'copilot-cli',
    name: 'Copilot CLI',
    scope: 'home',
    file: join('.copilot', 'mcp-config.json'),
    dialect: 'mcpServers',
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    scope: 'home',
    file: join('.codeium', 'windsurf', 'mcp_config.json'),
    dialect: 'mcpServers',
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    scope: 'home',
    file: join('.codex', 'config.toml'),
    dialect: 'mcpServers',
    addCommand: (launch) => [
      'codex',
      'mcp',
      'add',
      SERVER_KEY,
      ...Object.entries(launch.env).flatMap(([name, value]) => ['--env', `${name}=${value}`]),
      '--',
      launch.command,
      ...launch.args,
    ],
  },
  {
    id: 'hermes',
    name: 'Hermes',
    scope: 'home',
    file: join('.hermes', 'config.yaml'),
    dialect: 'mcpServers',
    snippet: (launch) =>
      [
        'mcp_servers:',
        `  ${SERVER_KEY}:`,
        `    command: ${launch.command}`,
        '    args:',
        ...launch.args.map((argument) => `      - "${argument}"`),
        '    env:',
        ...Object.entries(launch.env).map(([name, value]) => `      ${name}: "${value}"`),
        '    enabled: true',
      ].join('\n'),
  },
];

/** Where a harness's config actually is, for a given project. */
export function configPath(harness: Harness, projectPath: string): string {
  return join(harness.scope === 'project' ? projectPath : homedir(), harness.file);
}

/** The server entry, in the shape the harness reads it in. */
export function entryFor(dialect: Dialect, launch: Launch): Record<string, unknown> {
  if (dialect === 'opencode') {
    return {
      type: 'local',
      command: [launch.command, ...launch.args],
      environment: { ...launch.env },
      enabled: true,
    };
  }
  // VS Code defaults an entry with no type to stdio, but writes the type itself, and a reader
  // that sees one is never left guessing which transport was meant.
  return {
    ...(dialect === 'servers' ? { type: 'stdio' } : {}),
    command: launch.command,
    args: [...launch.args],
    env: { ...launch.env },
  };
}

/** The top-level key the entry hangs off. */
export function containerKey(dialect: Dialect): string {
  return dialect === 'opencode' ? 'mcp' : dialect;
}

/**
 * The harness's config with gdharness in it, built from whatever was already there.
 *
 * Anything the file already held is kept, including other servers and any key this does not know
 * about: a harness config is the user's file that gdharness is a guest in.
 */
function merged(existing: unknown, dialect: Dialect, launch: Launch): Record<string, unknown> {
  const root: Record<string, unknown> =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const key = containerKey(dialect);
  const held = root[key];
  const servers: Record<string, unknown> =
    typeof held === 'object' && held !== null && !Array.isArray(held)
      ? { ...(held as Record<string, unknown>) }
      : {};
  servers[SERVER_KEY] = entryFor(dialect, launch);
  root[key] = servers;
  return root;
}

/** What a harness is by its flag, or nothing if no such harness is known. */
export function harnessById(id: string): Harness | undefined {
  return HARNESSES.find((harness) => harness.id === id);
}

/**
 * The harnesses already set up inside this project, which are the only ones written without being
 * asked. Everything they write is a file in the project directory, so installing gdharness into
 * one project changes nothing outside it.
 *
 * A harness's own directory counts as much as its config file, because one that has been opened
 * once has a directory and may not have a config until something writes one.
 */
export function detect(projectPath: string): readonly Harness[] {
  return HARNESSES.filter((harness) => harness.scope === 'project' && present(harness, projectPath));
}

/**
 * The machine-wide harnesses on this computer, which are named and never written to unasked.
 *
 * Their configuration belongs to the machine rather than to the project, so writing one on
 * detection would put this project's Godot path in front of every other project the reader opens
 * with that harness. Installing one project is not consent to that, so these take their own flag.
 */
export function detectGlobal(projectPath: string): readonly Harness[] {
  return HARNESSES.filter((harness) => harness.scope === 'home' && present(harness, projectPath));
}

function present(harness: Harness, projectPath: string): boolean {
  const path = configPath(harness, projectPath);
  return existsSync(path) || existsSync(dirname(path));
}

export interface Written {
  readonly harness: Harness;
  readonly path: string;
  /** `written` and `replaced` touched the file; the other two leave it to the reader. */
  readonly action: 'written' | 'replaced' | 'command' | 'snippet';
  /** For `command`, what to run. For `snippet`, what to put in the file. */
  readonly command?: readonly string[];
  readonly snippet?: string;
}

/**
 * gdharness put into one harness's configuration.
 *
 * A malformed config is left alone rather than replaced: the file belongs to the harness, and
 * discarding it because it did not parse would be the worst possible reading of "install".
 */
export function connect(harness: Harness, projectPath: string, launch: Launch): Written {
  const path = configPath(harness, projectPath);
  if (harness.addCommand !== undefined) {
    return { harness, path, action: 'command', command: harness.addCommand(launch) };
  }
  if (harness.snippet !== undefined) {
    return { harness, path, action: 'snippet', snippet: harness.snippet(launch) };
  }

  const held = existsSync(path) ? readFileSync(path, 'utf8') : '';
  let existing: unknown = {};
  if (held.trim() !== '') {
    try {
      existing = JSON.parse(held);
    } catch (cause) {
      throw new Error(`${path} is not valid JSON, so gdharness was not added to it.`, { cause });
    }
  }
  const container =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)[containerKey(harness.dialect)]
      : undefined;
  const already = typeof container === 'object' && container !== null && SERVER_KEY in container;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(merged(existing, harness.dialect, launch), null, 2)}\n`, 'utf8');
  return { harness, path, action: already ? 'replaced' : 'written' };
}
