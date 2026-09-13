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
import {
  parsedYamlHas,
  removeToml,
  removeYaml,
  type TomlEntry,
  writeToml,
  writeYaml,
} from './config-formats.js';

/** What gdharness is called wherever it is registered. */
export const SERVER_KEY = 'gdharness';

/** The command a harness spawns, which is the same everywhere and is the point of publishing. */
export interface Launch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** The two runners that fetch and run a published package without installing it first. */
export type Runner = 'npx' | 'bunx';

/**
 * Whichever runner is running us.
 *
 * Somebody who installed with `bunx` may not have Node at all, so writing `npx` into their config
 * would leave them an entry nothing can spawn.
 */
function currentRunner(): Runner {
  // Bun's own types declare versions.bun as always present, which it is not under Node.
  const versions: Readonly<Record<string, string | undefined>> = process.versions;
  return versions['bun'] === undefined ? 'npx' : 'bunx';
}

/** What a runner is typed as, which is the same line the config holds. */
export function runLine(runner: Runner, version: string, rest = ''): string {
  const flag = runner === 'npx' ? '-y ' : '';
  return `${runner} ${flag}gdharness@${version}${rest === '' ? '' : ` ${rest}`}`;
}

/**
 * The version is pinned rather than left as `latest` because the server and the addons it
 * installed into the project have to be the same version: `editor_status` reports a mismatch as
 * `addonIsStale`, and `latest` is how a project silently acquires one.
 */
export function launchFor(version: string, godotPath: string, runner: Runner = currentRunner()): Launch {
  return {
    command: runner,
    // `-y` is npm's "do not stop and ask before fetching this"; bunx has no such prompt.
    args: runner === 'npx' ? ['-y', `gdharness@${version}`] : [`gdharness@${version}`],
    env: { GODOT_PATH: godotPath },
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

/** The server entry, in the shape the harness reads it in. */
export function entryFor(shape: Shape, launch: Launch): Record<string, unknown> {
  if (shape === 'opencode') {
    return {
      type: 'local',
      command: [launch.command, ...launch.args],
      environment: { ...launch.env },
      enabled: true,
    };
  }
  // A reader that sees the transport named is never left guessing which one was meant, and both
  // harnesses using this shape document it.
  return {
    ...(shape === 'typed' ? { type: 'stdio' } : {}),
    command: launch.command,
    args: [...launch.args],
    env: { ...launch.env },
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
  servers[SERVER_KEY] = entryFor(harness.shape, launch);
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
      throw new Error(`${path} is not valid JSON, so gdharness was not added to it.`, { cause });
    }
  }
  const container =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)[harness.container]
      : undefined;
  const already = typeof container === 'object' && container !== null && SERVER_KEY in container;

  return put(harness, path, `${JSON.stringify(merged(existing, harness, launch), null, 2)}\n`, already);
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
