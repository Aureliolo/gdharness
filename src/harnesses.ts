/**
 * The agent harnesses gdharness can wire itself into, and how each one spells a stdio server.
 *
 * There are hundreds of harnesses and one thing they agree on, which is that a server is a
 * command to spawn. The disagreement is only ever the file, the key and the shape, so this is a
 * table rather than an integration per harness.
 *
 * Every path here was read from that harness's own documentation. A guessed path is worse than no
 * row: it fails silently, in a file the reader then has to find themselves.
 *
 * JSON, TOML and YAML are all written rather than printed, because a block to paste is a step that
 * gets skipped or pasted into the wrong file. Each shape here was read from that harness's own
 * documentation too: a guessed shape writes a file that silently does nothing.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import type { AnnouncedServer } from './bridge-announce.js';
import {
  parsedYamlHas,
  removeToml,
  removeYaml,
  type TomlEntry,
  writeToml,
  writeYaml,
} from './config-formats.js';
import { Refusal } from './errors.js';
import { currentRunner, type Runner, spawnFor } from './runner.js';

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
export function launchFor(
  version: string,
  godotPath: string,
  projectPath: string,
  runner: Runner = currentRunner(),
): Launch {
  const spawn = spawnFor(runner, version);
  // The project as well, because a server that knows which one it serves can announce its editor
  // bridge inside it, and an editor can then find that bridge wherever it landed. Without it the
  // port is a number every project wants and one of them gets: two open at once and the second
  // editor has no bridge at all.
  return {
    command: spawn.command,
    args: spawn.args,
    env: { GODOT_PATH: godotPath, GDHARNESS_PROJECT: projectPath },
  };
}

/**
 * The shape of one server entry.
 *
 * `plain` is what most of them took from Claude Desktop. `typed` is the same with the transport
 * named, which VS Code and Factory both document. opencode disagrees about every key.
 */
export type Shape = 'plain' | 'typed' | 'opencode';

/** A home-scoped path that is not in the same place on every platform. */
interface PlatformPaths {
  readonly win32: HomePath;
  readonly darwin: HomePath;
  readonly linux: HomePath;
}

/** Relative to the home directory, or to roaming application data where Windows keeps it. */
type HomePath = string | { readonly appData: string };

export interface Harness {
  /** The flag that selects it, and what `setup` prints. */
  readonly id: string;
  readonly name: string;
  /**
   * Where the entry goes. Project wherever the harness has a project file: gdharness is
   * per-project, since it carries that project's Godot path and installed its addons.
   */
  readonly scope: 'project' | 'home';
  /** Relative to the project, or to the home directory. */
  readonly file: string | PlatformPaths;
  /** The top-level key the servers hang off. */
  readonly container: string;
  readonly shape: Shape;
  /**
   * A directory under home that says this harness is on the machine, for a project-scoped one
   * that this project has not used yet. Read only: nothing is ever written here. Set only where
   * the harness documents the path, because a wrong marker offers somebody a harness they do not
   * have.
   */
  readonly home?: string;
  /**
   * The harness's own directory beside its config, for one whose config file sits at the root of
   * the project or of the home directory and therefore has no parent of its own to look for.
   */
  readonly marker?: string;
  /**
   * Where this harness looks for skills, when the shared `.agents/skills` is not the whole story.
   * Absent means it reads the shared directory and only that, which is true of most of them and is
   * the reason there is one skill rather than one per harness.
   */
  readonly skills?: {
    /** Its own directory, relative to the project. */
    readonly dir: string;
    /** Whether it reads the shared directory as well. False means its own is the only one. */
    readonly shared: boolean;
  };
  /** For a harness whose config is TOML: the block to write, and how to find an older one. */
  readonly toml?: TomlEntry;
  /** For a harness whose config is YAML: the key path our entry sits at, and the entry. */
  readonly yaml?: {
    readonly path: readonly string[];
    readonly entry: (launch: Launch) => Record<string, unknown>;
  };
  /**
   * What the reader still has to do themselves, for a harness that will not take our word for it.
   * Named rather than glossed over: a trust prompt nobody mentions is an install that looks done
   * and answers nothing.
   */
  readonly manual?: string;
  /**
   * What to put in the file by hand, for a harness whose file is documented but whose shape is
   * not. Shown rather than guessed at: writing an invented key produces a config that parses,
   * loads, and does nothing.
   */
  readonly snippet?: (launch: Launch) => string;
}

/** A TOML array of strings, which is the one value shape every one of these files needs. */
function tomlArray(values: readonly string[]): string {
  return `[${values.map((value) => `"${value}"`).join(', ')}]`;
}

/**
 * The environment as an inline table rather than its own `[x.env]` header.
 *
 * Both are valid TOML and mean the same thing. Inline keeps our entry one contiguous block, which
 * is what lets it be found and replaced without touching the tables around it.
 */
function tomlEnv(launch: Launch): string {
  const pairs = Object.entries(launch.env).map(([name, value]) => `${name} = "${value}"`);
  return `env = { ${pairs.join(', ')} }`;
}

function jsonSnippet(launch: Launch, container: string, shape: Shape): string {
  return JSON.stringify({ [container]: { [SERVER_KEY]: entryFor(shape, launch) } }, null, 2);
}

/** Everything that shows up on a config path we can name exactly. */
export const HARNESSES: readonly Harness[] = [
  // Four harnesses read this one file, so writing it once serves all of them.
  {
    id: 'claude-code',
    name: 'Claude Code',
    scope: 'project',
    file: '.mcp.json',
    container: 'mcpServers',
    shape: 'plain',
    home: '.claude',
    marker: '.claude',
    skills: { dir: join('.claude', 'skills'), shared: false },
  },
  {
    id: 'copilot-cli',
    name: 'Copilot CLI',
    scope: 'project',
    file: '.mcp.json',
    container: 'mcpServers',
    shape: 'plain',
    home: '.copilot',
    skills: { dir: join('.github', 'skills'), shared: true },
    // It walks from the working directory up to the repository root loading each .mcp.json it
    // passes, and the first launch in a folder asks whether to trust it before any of that.
    manual: 'Trust the folder when Copilot CLI first asks, or it reads no config here.',
  },
  {
    id: 'qoder',
    name: 'Qoder',
    scope: 'project',
    file: '.mcp.json',
    container: 'mcpServers',
    shape: 'plain',
    home: '.qoder',
    marker: '.qoder',
  },
  {
    id: 'command-code',
    name: 'Command Code',
    scope: 'project',
    file: '.mcp.json',
    container: 'mcpServers',
    shape: 'plain',
    home: '.commandcode',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    scope: 'project',
    file: join('.cursor', 'mcp.json'),
    container: 'mcpServers',
    shape: 'plain',
    home: '.cursor',
    skills: { dir: join('.cursor', 'skills'), shared: true },
    manual: 'Cursor asks before each tool call by default, and the server can be toggled off.',
  },
  {
    id: 'vscode',
    name: 'VS Code',
    scope: 'project',
    file: join('.vscode', 'mcp.json'),
    container: 'servers',
    shape: 'typed',
    home: '.vscode',
    skills: { dir: join('.github', 'skills'), shared: true },
    manual: 'VS Code asks you to trust a server the first time it starts one.',
  },
  {
    id: 'opencode',
    name: 'opencode',
    scope: 'project',
    file: 'opencode.json',
    container: 'mcp',
    shape: 'opencode',
    home: join('.config', 'opencode'),
    marker: '.opencode',
    skills: { dir: join('.opencode', 'skills'), shared: true },
  },
  {
    id: 'junie',
    name: 'Junie',
    scope: 'project',
    file: join('.junie', 'mcp', 'mcp.json'),
    container: 'mcpServers',
    shape: 'plain',
    home: '.junie',
    skills: { dir: join('.junie', 'skills'), shared: true },
  },
  {
    id: 'kiro',
    name: 'Kiro',
    scope: 'project',
    file: join('.kiro', 'settings', 'mcp.json'),
    container: 'mcpServers',
    shape: 'plain',
    home: '.kiro',
    skills: { dir: join('.kiro', 'skills'), shared: false },
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    scope: 'project',
    file: join('.gemini', 'settings.json'),
    container: 'mcpServers',
    shape: 'plain',
    home: '.gemini',
    skills: { dir: join('.gemini', 'skills'), shared: true },
  },
  {
    id: 'roo',
    name: 'Roo Code',
    scope: 'project',
    file: join('.roo', 'mcp.json'),
    container: 'mcpServers',
    shape: 'plain',
  },
  {
    id: 'kilo',
    name: 'Kilo Code',
    scope: 'project',
    file: join('.kilocode', 'mcp.json'),
    container: 'mcpServers',
    shape: 'plain',
  },
  {
    id: 'amazon-q',
    name: 'Amazon Q Developer CLI',
    scope: 'project',
    file: join('.amazonq', 'mcp.json'),
    container: 'mcpServers',
    shape: 'plain',
    home: join('.aws', 'amazonq'),
  },
  {
    id: 'zed',
    name: 'Zed',
    scope: 'project',
    file: join('.zed', 'settings.json'),
    container: 'context_servers',
    shape: 'plain',
  },
  {
    // Amp hangs its servers off a dotted key at the top level rather than a nested object.
    id: 'amp',
    name: 'Amp',
    scope: 'project',
    file: join('.amp', 'settings.json'),
    container: 'amp.mcpServers',
    shape: 'plain',
    home: join('.config', 'amp'),
  },
  {
    id: 'warp',
    name: 'Warp',
    scope: 'project',
    file: join('.warp', '.mcp.json'),
    container: 'mcpServers',
    shape: 'plain',
    home: '.warp',
    manual: 'Warp starts a project server only once you toggle it on, on its MCP servers page.',
  },
  {
    id: 'trae',
    name: 'Trae',
    scope: 'project',
    file: join('.trae', 'mcp.json'),
    container: 'mcpServers',
    shape: 'plain',
    home: '.trae',
  },
  {
    id: 'factory',
    name: 'Factory Droid',
    scope: 'project',
    file: join('.factory', 'mcp.json'),
    container: 'mcpServers',
    shape: 'typed',
    home: '.factory',
  },
  {
    id: 'tabnine',
    name: 'Tabnine',
    scope: 'project',
    file: join('.tabnine', 'mcp_servers.json'),
    container: 'mcpServers',
    shape: 'plain',
    home: '.tabnine',
  },
  {
    id: 'firebender',
    name: 'Firebender',
    scope: 'project',
    file: 'firebender.json',
    container: 'mcpServers',
    shape: 'plain',
  },
  {
    id: 'pi',
    name: 'pi',
    scope: 'project',
    file: join('.pi', 'mcp.json'),
    container: 'mcpServers',
    shape: 'plain',
    home: '.pi',
  },

  // Project-scoped, but the file is TOML or YAML, so it is printed rather than written.
  {
    id: 'mistral-vibe',
    name: 'Mistral Vibe',
    scope: 'project',
    file: join('.vibe', 'config.toml'),
    container: 'mcp_servers',
    shape: 'plain',
    toml: {
      header: '[[mcp_servers]]',
      identity: `name = "${SERVER_KEY}"`,
      block: (launch) =>
        [
          '[[mcp_servers]]',
          `name = "${SERVER_KEY}"`,
          'transport = "stdio"',
          `command = "${launch.command}"`,
          `args = ${tomlArray(launch.args)}`,
          tomlEnv(launch),
        ].join('\n'),
    },
  },
  {
    id: 'vtcode',
    name: 'VT Code',
    scope: 'project',
    file: 'vtcode.toml',
    container: 'mcp.providers',
    shape: 'plain',
    marker: '.vtcode',
    toml: {
      header: '[[mcp.providers]]',
      identity: `name = "${SERVER_KEY}"`,
      enable: { header: '[mcp]', line: 'enabled = true' },
      block: (launch) =>
        [
          '[[mcp.providers]]',
          `name = "${SERVER_KEY}"`,
          'enabled = true',
          `command = "${launch.command}"`,
          `args = ${tomlArray(launch.args)}`,
          tomlEnv(launch),
        ].join('\n'),
    },
  },
  {
    id: 'fast-agent',
    name: 'fast-agent',
    scope: 'project',
    file: 'fastagent.config.yaml',
    container: 'mcp',
    shape: 'plain',
    yaml: {
      path: ['mcp', 'servers', SERVER_KEY],
      entry: (launch) => ({ command: launch.command, args: [...launch.args], env: { ...launch.env } }),
    },
  },

  // Machine-wide: these harnesses have no project-level config at all, so the only way to wire
  // one up is outside the project. Never written without a flag or an answered prompt.
  {
    id: 'codex',
    name: 'Codex CLI',
    scope: 'home',
    file: join('.codex', 'config.toml'),
    container: 'mcp_servers',
    shape: 'plain',
    manual: 'Codex reads its config at startup, so restart it.',
    toml: {
      header: `[mcp_servers.${SERVER_KEY}]`,
      block: (launch) =>
        [
          `[mcp_servers.${SERVER_KEY}]`,
          `command = "${launch.command}"`,
          `args = ${tomlArray(launch.args)}`,
          tomlEnv(launch),
        ].join('\n'),
    },
  },
  {
    // Cline keeps rules, skills, hooks and agents per project but not servers: cline/cline#2418.
    id: 'cline',
    name: 'Cline',
    scope: 'home',
    file: join('.cline', 'data', 'settings', 'cline_mcp_settings.json'),
    container: 'mcpServers',
    shape: 'plain',
    marker: '.cline',
    skills: { dir: join('.cline', 'skills'), shared: false },
  },
  {
    id: 'goose',
    name: 'Goose',
    scope: 'home',
    file: {
      win32: { appData: join('Block', 'goose', 'config', 'config.yaml') },
      darwin: join('.config', 'goose', 'config.yaml'),
      linux: join('.config', 'goose', 'config.yaml'),
    },
    container: 'extensions',
    shape: 'plain',
    yaml: {
      path: ['extensions', SERVER_KEY],
      entry: (launch) => ({
        name: SERVER_KEY,
        type: 'stdio',
        enabled: true,
        cmd: launch.command,
        args: [...launch.args],
        envs: { ...launch.env },
        timeout: 300,
      }),
    },
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    scope: 'home',
    file: join('.codeium', 'windsurf', 'mcp_config.json'),
    container: 'mcpServers',
    shape: 'plain',
    skills: { dir: join('.windsurf', 'skills'), shared: true },
  },
  {
    id: 'hermes',
    name: 'Hermes',
    scope: 'home',
    file: join('.hermes', 'config.yaml'),
    container: 'mcp_servers',
    shape: 'plain',
    skills: { dir: join('.hermes', 'skills'), shared: true },
    yaml: {
      path: ['mcp_servers', SERVER_KEY],
      entry: (launch) => ({
        command: launch.command,
        args: [...launch.args],
        env: { ...launch.env },
        enabled: true,
      }),
    },
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    scope: 'home',
    file: join('.openclaw', 'openclaw.json'),
    container: 'mcpServers',
    shape: 'plain',
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    scope: 'home',
    file: {
      win32: { appData: join('Claude', 'claude_desktop_config.json') },
      darwin: join('Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      linux: join('.config', 'Claude', 'claude_desktop_config.json'),
    },
    container: 'mcpServers',
    shape: 'plain',
  },
  {
    id: 'zeroclaw',
    name: 'ZeroClaw',
    scope: 'home',
    file: join('.zeroclaw', 'config.toml'),
    container: 'mcp.servers',
    shape: 'plain',
    toml: {
      header: '[[mcp.servers]]',
      identity: `name = "${SERVER_KEY}"`,
      enable: { header: '[mcp]', line: 'enabled = true' },
      block: (launch) =>
        [
          '[[mcp.servers]]',
          `name = "${SERVER_KEY}"`,
          `command = "${launch.command}"`,
          `args = ${tomlArray(launch.args)}`,
          tomlEnv(launch),
        ].join('\n'),
    },
  },
  {
    id: 'deepcode',
    name: 'Deep Code',
    scope: 'home',
    file: join('.deepcode', 'settings.json'),
    container: 'mcpServers',
    shape: 'plain',
  },
  {
    // The file is documented, the key it holds servers under is not, so it is printed.
    id: 'nanobot',
    name: 'nanobot',
    scope: 'home',
    file: join('.nanobot', 'config.json'),
    container: 'mcpServers',
    shape: 'plain',
    snippet: (launch) => jsonSnippet(launch, 'mcpServers', 'plain'),
  },
  {
    id: 'autohand',
    name: 'Autohand',
    scope: 'home',
    file: join('.autohand', 'config.json'),
    container: 'mcpServers',
    shape: 'plain',
    snippet: (launch) => jsonSnippet(launch, 'mcpServers', 'plain'),
  },
  // bub is deliberately absent: neither its config path nor its `bub mcp add` flags are
  // documented well enough to write or to print, and a guess would fail in a file nobody can find.
];

/** Roaming application data, which is where Windows keeps what other platforms put under home. */
function appDataRoot(): string {
  return process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
}

function homePath(path: HomePath): string {
  return typeof path === 'string' ? join(homedir(), path) : join(appDataRoot(), path.appData);
}

/** The harness's file for this platform, relative to wherever its scope puts it. */
function fileFor(harness: Harness, platform: NodeJS.Platform = process.platform): string | HomePath {
  if (typeof harness.file === 'string') {
    return harness.file;
  }
  return platform === 'win32'
    ? harness.file.win32
    : platform === 'darwin'
      ? harness.file.darwin
      : harness.file.linux;
}

/** Where a harness's config actually is, for a given project. */
export function configPath(harness: Harness, projectPath: string): string {
  const file = fileFor(harness);
  if (harness.scope === 'project') {
    return join(projectPath, file as string);
  }
  return homePath(file);
}

/** The path as it should be read by a person, which for a home-scoped harness is not absolute. */
export function displayPath(harness: Harness, platform: NodeJS.Platform = process.platform): string {
  const file = fileFor(harness, platform);
  if (typeof file !== 'string') {
    return `%APPDATA%/${file.appData.replaceAll('\\', '/')}`;
  }
  return `${harness.scope === 'home' ? '~/' : ''}${file.replaceAll('\\', '/')}`;
}

/** The two variables the install decides. Everything else in an entry belongs to somebody else. */
const OURS: readonly string[] = ['GODOT_PATH', 'GDHARNESS_PROJECT'];

/**
 * The environment for the entry: whatever was already there, with the two the install owns over it.
 *
 * This block was rebuilt from nothing on every write, so an upgrade dropped anything a person had
 * put in it. The three that matter are `GDHARNESS_BRIDGE_PORT`, `GDHARNESS_LSP_PORT` and
 * `GDHARNESS_DAP_PORT`, and they are the worst ones to lose: nobody sets them until they already
 * have a port conflict, so the config that loses them is the one that needed them, and it loses
 * them to an upgrade that reported success. Reported from a project holding all three, where the
 * next editor would have come back on the defaults and collided with the project they avoided.
 */
function environmentFor(launch: Launch, held: unknown): Record<string, string> {
  const kept: Record<string, string> = {};
  if (typeof held === 'object' && held !== null && !Array.isArray(held)) {
    for (const [name, value] of Object.entries(held as Record<string, unknown>)) {
      if (typeof value === 'string' && !OURS.includes(name)) {
        kept[name] = value;
      }
    }
  }
  return { ...kept, ...launch.env };
}

/**
 * The server entry, in the shape the harness reads it in, built onto [param held] where there is
 * one already.
 *
 * What the install decides is written over: the command and the arguments carry the version, which
 * is the whole of what an upgrade is for. Everything else on the entry stays where it was, for the
 * same reason [method merged] leaves the rest of the file alone.
 */
export function entryFor(shape: Shape, launch: Launch, held?: unknown): Record<string, unknown> {
  const before: Record<string, unknown> =
    typeof held === 'object' && held !== null && !Array.isArray(held)
      ? { ...(held as Record<string, unknown>) }
      : {};
  if (shape === 'opencode') {
    return {
      ...before,
      type: 'local',
      command: [launch.command, ...launch.args],
      environment: environmentFor(launch, before['environment']),
      enabled: true,
    };
  }
  // A reader that sees the transport named is never left guessing which one was meant, and both
  // harnesses using this shape document it.
  return {
    ...before,
    ...(shape === 'typed' ? { type: 'stdio' } : {}),
    command: launch.command,
    args: [...launch.args],
    env: environmentFor(launch, before['env']),
  };
}

/**
 * The harness's config with gdharness in it, built from whatever was already there.
 *
 * Anything the file already held is kept, including other servers and any key this does not know
 * about: a harness config is the user's file that gdharness is a guest in.
 */
function merged(existing: unknown, harness: Harness, launch: Launch): Record<string, unknown> {
  const root: Record<string, unknown> =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const held = root[harness.container];
  const servers: Record<string, unknown> =
    typeof held === 'object' && held !== null && !Array.isArray(held)
      ? { ...(held as Record<string, unknown>) }
      : {};
  servers[SERVER_KEY] = entryFor(harness.shape, launch, servers[SERVER_KEY]);
  root[harness.container] = servers;
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
 * These are the ones with no project-level config at all, so wiring them up means writing outside
 * the project, and that is the reader's call rather than a side effect of installing one project.
 */
export function detectGlobal(projectPath: string): readonly Harness[] {
  return HARNESSES.filter((harness) => harness.scope === 'home' && present(harness, projectPath));
}

/**
 * Whether this harness is set up where its config would go.
 *
 * The config file counts, and so does the harness's own directory, because one that has been
 * opened has a directory before anything writes a server into it. The directory only counts when
 * it belongs to the harness: for a config that sits at the project root, the parent is the project
 * itself, and taking that as evidence would find every harness in every project.
 */
function present(harness: Harness, projectPath: string): boolean {
  const path = configPath(harness, projectPath);
  if (existsSync(path)) {
    return true;
  }
  const root = harness.scope === 'project' ? projectPath : homedir();
  const own = dirname(path);
  if (own !== root && existsSync(own)) {
    return true;
  }
  return harness.marker !== undefined && existsSync(join(root, harness.marker));
}

/** Why a harness is worth asking about. */
type Reason =
  /** Already configured in this project, so writing it is finishing what is there. */
  | 'configured'
  /** On this machine, but this project has not used it yet. */
  | 'installed'
  /** On this machine, and has nowhere but the machine to be configured. */
  | 'machine-wide';

export interface Candidate {
  readonly harness: Harness;
  readonly reason: Reason;
}

/**
 * Every harness worth offering, and why.
 *
 * Detection by project config alone misses the case somebody actually has: the harness is
 * installed, this project is new, and there is nothing to find yet. Its home directory answers
 * that, and is only ever read.
 */
export function candidates(projectPath: string): readonly Candidate[] {
  const found: Candidate[] = [];
  for (const harness of HARNESSES) {
    if (harness.scope === 'home') {
      if (present(harness, projectPath)) {
        found.push({ harness, reason: 'machine-wide' });
      }
      continue;
    }
    if (present(harness, projectPath)) {
      found.push({ harness, reason: 'configured' });
    } else if (harness.home !== undefined && existsSync(join(homedir(), harness.home))) {
      found.push({ harness, reason: 'installed' });
    }
  }
  return found;
}

/** One file, and every harness that reads it. */
export interface Group {
  readonly path: string;
  readonly harnesses: readonly Harness[];
  /** The one whose container and shape the write uses. The rest of the group agree with it. */
  readonly writer: Harness;
}

/**
 * The harnesses collapsed to one entry per file they share.
 *
 * Four harnesses read `.mcp.json`, so writing it once and naming all four is both less work and a
 * truer report than writing the same bytes four times.
 */
export function groupByFile(harnesses: readonly Harness[], projectPath: string): readonly Group[] {
  const groups = new Map<string, { path: string; harnesses: Harness[]; writer: Harness }>();
  for (const harness of harnesses) {
    const path = configPath(harness, projectPath);
    const key = `${path}\u0000${harness.container}\u0000${harness.shape}`;
    const held = groups.get(key);
    if (held === undefined) {
      groups.set(key, { path, harnesses: [harness], writer: harness });
    } else {
      held.harnesses.push(harness);
    }
  }
  return [...groups.values()];
}

export interface Removed {
  readonly harness: Harness;
  readonly path: string;
  /**
   * `removed` took our entry out, `deleted` took the file with it because nothing else was in it,
   * `absent` found nothing of ours, and `manual` is a file we cannot edit and must describe.
   */
  readonly action: 'removed' | 'deleted' | 'absent' | 'manual';
  /** For `manual`, the command that removes it, when the harness documents one. */
  readonly command?: readonly string[];
}

/**
 * Whether this harness already has a gdharness entry, whatever version it pins.
 *
 * What an upgrade goes by: a config with our entry in it is one we wrote and may rewrite, and a
 * config without one is a harness the reader never asked us to touch. A file we can only print a
 * snippet for cannot be read back either, so it answers false and is named instead.
 */
export function registered(harness: Harness, projectPath: string): boolean {
  const path = configPath(harness, projectPath);
  if (harness.snippet !== undefined || !existsSync(path)) {
    return false;
  }
  const text = readFileSync(path, 'utf8');
  if (harness.toml !== undefined) {
    return text.includes(harness.toml.identity ?? harness.toml.header);
  }
  if (harness.yaml !== undefined) {
    return parsedYamlHas(text, harness.yaml.path);
  }
  let existing: unknown;
  try {
    existing = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
    return false;
  }
  const held = (existing as Record<string, unknown>)[harness.container];
  return typeof held === 'object' && held !== null && !Array.isArray(held) && SERVER_KEY in held;
}

/**
 * The engine path this project's own configuration already records, or null for none.
 *
 * gdharness writes `GODOT_PATH` into every entry it makes, because a harness spawns the server
 * with no environment of its own. So a project that has been set up carries a record of where its
 * engine is, and for one whose engine is vendored under the project root and deliberately kept off
 * PATH, that record is the only one there is. Asking somebody to re-supply a value the command is
 * about to copy through unchanged is asking them to retype what it is holding.
 *
 * Project-scoped configs only. A machine-wide one may have been written for somebody else's
 * project, and an engine path taken from there is another project's engine.
 *
 * The entry has to be readable as JSON, which is what gdharness reads back everywhere else here.
 * A TOML or YAML config is written and never re-read, so a project with only one of those falls
 * through to the ordinary search rather than being guessed at.
 */
export function recordedEnginePath(projectPath: string): string | null {
  for (const harness of HARNESSES) {
    if (harness.scope !== 'project' || harness.toml || harness.yaml || harness.snippet) {
      continue;
    }
    const path = configPath(harness, projectPath);
    if (!existsSync(path)) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    const entry = reach(reach(parsed, harness.container), SERVER_KEY);
    const named = reach(reach(entry, harness.shape === 'opencode' ? 'environment' : 'env'), 'GODOT_PATH');
    if (typeof named === 'string' && named !== '' && existsSync(named)) {
      return named;
    }
  }
  return null;
}

/** One key of a value that may be anything at all, which is what a config file is until read. */
function reach(held: unknown, key: string): unknown {
  return typeof held === 'object' && held !== null && !Array.isArray(held)
    ? (held as Record<string, unknown>)[key]
    : undefined;
}

/**
 * gdharness taken back out of one harness's configuration.
 *
 * Only our own key is touched. A file that held other servers keeps them and stays; one that held
 * nothing but gdharness is removed, because a file we created and then emptied is litter.
 */
export function disconnect(harness: Harness, projectPath: string): Removed {
  const path = configPath(harness, projectPath);
  if (!existsSync(path)) {
    return { harness, path, action: 'absent' };
  }
  // A file we could not write we cannot read our way out of either, so the most this can say is
  // that the file is there and that our entry has to come out of it by hand.
  if (harness.snippet !== undefined) {
    return { harness, path, action: 'manual' };
  }

  const text = readFileSync(path, 'utf8');
  if (harness.toml !== undefined) {
    return taken(harness, path, text, removeToml(text, harness.toml));
  }
  if (harness.yaml !== undefined) {
    return taken(harness, path, text, removeYaml(text, harness.yaml.path));
  }

  let existing: unknown;
  try {
    existing = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // A config we cannot parse is one we never wrote to either, so there is nothing of ours in it.
    return { harness, path, action: 'absent' };
  }
  if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
    return { harness, path, action: 'absent' };
  }

  const root = { ...(existing as Record<string, unknown>) };
  const held = root[harness.container];
  if (typeof held !== 'object' || held === null || Array.isArray(held) || !(SERVER_KEY in held)) {
    return { harness, path, action: 'absent' };
  }

  const servers: Record<string, unknown> = { ...(held as Record<string, unknown>) };
  delete servers[SERVER_KEY];
  if (Object.keys(servers).length === 0) {
    delete root[harness.container];
  } else {
    root[harness.container] = servers;
  }

  if (Object.keys(root).length === 0) {
    rmSync(path, { force: true });
    return { harness, path, action: 'deleted' };
  }
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
  return { harness, path, action: 'removed' };
}

export interface Written {
  readonly harness: Harness;
  readonly path: string;
  /** `written` and `replaced` touched the file; the other two leave it to the reader. */
  readonly action: 'written' | 'replaced' | 'command' | 'snippet';
  /** For `command`, what to run. For `snippet`, what to put in the file. */
  readonly command?: readonly string[];
  readonly snippet?: string;
  /**
   * What launched gdharness before this write, when the write moved it. Absent when it did not.
   *
   * An install always writes the command and the arguments, because they carry the version and
   * that is what an upgrade is. So it also replaces one somebody set by hand, and "updated
   * .mcp.json" says nothing about that: the failure it hides is a session going on running a
   * different server from the one somebody chose, under a success message.
   */
  readonly wasLaunchedBy?: string;
}

/** What an upgrade managed to do to the harness configs it found. */
export interface Repinned {
  /** The launch lines it replaced, one per config that held something else. */
  readonly moved: readonly string[];
  /** How many configs it wrote, whether or not the line inside them changed. */
  readonly written: number;
  /** How many harnesses were handed back a command or a snippet, because this cannot write them. */
  readonly byHand: number;
}

/**
 * The second thing an upgrade cannot do for you, said off what the config actually held.
 *
 * Off [param repinned].moved, the launch lines this install replaced, rather than off the addon
 * version that was there before, and that is the whole of what was wrong with it. The two agree only
 * while a gdharness install is the thing that wrote the config: a command somebody set by hand, a
 * local build most of all, makes the addon version a number about the addons and not about the
 * server the harness spawned. Reported from a project running gdharness out of a working tree, where
 * the note named a version that appeared nowhere in its config.
 *
 * Nothing moved means there is nothing it can honestly name, so it says less rather than guessing:
 * what a harness is running is whichever server it spawned when the session started, and no process
 * can see into another one. The instruction is the same either way, which is exactly why a wrong
 * number here could have sat for good.
 *
 * An empty `moved` is three states and not one, and only the middle one has a config in it that
 * names this version: a config was rewritten and already held this exact line, or nothing was
 * written because the harnesses found here print a command instead, or nothing here names gdharness
 * at all. Telling the last two that their config already named this version contradicts the lines
 * printed above it and sends a caller to reconnect something that would come back on the same
 * server, since there is no config for the reconnect to read.
 */
export function harnessNote(
  repinned: Repinned,
  now: string,
  running: { readonly server: AnnouncedServer; readonly isThisVersion: boolean } | null = null,
): string {
  // Carried into the first two answers rather than branching again: a project can hold a config this
  // writes and a harness it cannot, and the config's own answer is still the true one.
  const alsoByHand =
    repinned.byHand === 0
      ? ''
      : `\n     ${repinned.byHand === 1 ? 'One harness above was' : `${repinned.byHand} harnesses above were`} handed a command to run instead; run it too.`;
  // What is running is read from the server's own announcement for the project, when a live one has
  // made one. The config's previous line is what the harness would spawn next, not what it spawned:
  // after two upgrades without a reconnect it named a version that had never run (#622).
  const serving =
    running === null
      ? '     No gdharness server is announcing itself for this project, so which one your harness\n' +
        '     is running cannot be read from here.\n'
      : `     The server serving this project is gdharness ${running.server.version} (pid ${running.server.pid})${running.isThisVersion ? ', which is already this version.' : '.'}\n`;
  if (
    running?.isThisVersion === true &&
    repinned.byHand === 0 &&
    (repinned.moved.length > 0 || repinned.written > 0)
  ) {
    return `  2. Nothing for the harness: the server serving this project is gdharness ${running.server.version}\n     (pid ${running.server.pid}), which is already this version.`;
  }
  if (repinned.moved.length > 0) {
    return (
      `  2. Your harness config held ${repinned.moved.join(', ')} before this upgrade.\n` +
      `     It names ${now} now.\n` +
      serving +
      `     Reconnect the MCP server, or restart the harness.${alsoByHand}`
    );
  }
  if (repinned.written > 0) {
    return (
      '  2. Your harness config already named this version.\n' +
      serving +
      `     Reconnect the MCP server, or restart the harness.${alsoByHand}`
    );
  }
  if (repinned.byHand > 0) {
    return (
      '  2. None of the harness configs found here can be written for you, so nothing was\n' +
      `     re-pinned and a reconnect on its own would come back on the same server.\n` +
      '     Run what is printed above, then reconnect the MCP server or restart the harness.'
    );
  }
  return (
    '  2. No harness config here names gdharness, so nothing was re-pinned and there is no\n' +
    '     config for a reconnect to read. Run  gdharness setup  to write one, or point your\n' +
    `     harness at  ${now}  yourself, then restart it.`
  );
}

/** How a held entry says gdharness is launched, or nothing when it does not say. */
function launchedBy(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return undefined;
  }
  const held = entry as Record<string, unknown>;
  // opencode carries the whole line in `command`; everything else splits it across two keys.
  const whole = held['command'];
  const args: unknown[] = Array.isArray(held['args']) ? (held['args'] as unknown[]) : [];
  const parts: unknown[] = Array.isArray(whole) ? (whole as unknown[]) : [whole, ...args];
  const said = parts.filter((part): part is string => typeof part === 'string');
  return said.length === 0 ? undefined : said.join(' ');
}

/**
 * gdharness put into one harness's configuration.
 *
 * A malformed config is left alone rather than replaced: the file belongs to the harness, and
 * discarding it because it did not parse would be the worst possible reading of "install".
 */
export function connect(harness: Harness, projectPath: string, launch: Launch): Written {
  const path = configPath(harness, projectPath);
  if (harness.snippet !== undefined) {
    return { harness, path, action: 'snippet', snippet: harness.snippet(launch) };
  }

  const held = existsSync(path) ? readFileSync(path, 'utf8') : '';

  if (harness.toml !== undefined) {
    const already = held.includes(harness.toml.identity ?? harness.toml.header);
    return put(harness, path, writeToml(held, harness.toml, launch), already);
  }
  if (harness.yaml !== undefined) {
    const already = parsedYamlHas(held, harness.yaml.path);
    return put(harness, path, writeYaml(held, harness.yaml.path, harness.yaml.entry(launch)), already);
  }

  let existing: unknown = {};
  if (held.trim() !== '') {
    try {
      existing = JSON.parse(held);
    } catch (cause) {
      throw new Refusal(`${path} is not valid JSON, so gdharness was not added to it.`, { cause });
    }
  }
  const container =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)[harness.container]
      : undefined;
  const already = typeof container === 'object' && container !== null && SERVER_KEY in container;

  const written = put(
    harness,
    path,
    `${JSON.stringify(merged(existing, harness, launch), null, 2)}\n`,
    already,
  );
  const was = launchedBy((container as Record<string, unknown> | undefined)?.[SERVER_KEY]);
  const now = launchedBy(entryFor(harness.shape, launch));
  return was === undefined || was === now ? written : { ...written, wasLaunchedBy: was };
}

/** One file written, and the one line that says whether it was new. */
function put(harness: Harness, path: string, contents: string, already: boolean): Written {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
  return { harness, path, action: already ? 'replaced' : 'written' };
}

/**
 * One entry taken out of a file that is not JSON.
 *
 * Unchanged means there was nothing of ours in it. Emptied means the file held only our entry, and
 * a file we created and then emptied is litter.
 */
function taken(harness: Harness, path: string, held: string, stripped: string): Removed {
  if (stripped === held) {
    return { harness, path, action: 'absent' };
  }
  if (stripped.trim() === '' || stripped.trim() === '{}') {
    rmSync(path, { force: true });
    return { harness, path, action: 'deleted' };
  }
  writeFileSync(path, stripped, 'utf8');
  return { harness, path, action: 'removed' };
}
