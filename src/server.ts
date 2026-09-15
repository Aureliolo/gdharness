/**
 * The MCP server: one tool call in, one answer out.
 *
 * Every tool is answered by one of four things. A headless operation runs the engine on the
 * project with the operations script and answers with its JSON; the editor addon answers over
 * the bridge; a running game answers over the runtime socket; and a few are answered here, by
 * reading the project directory or driving a game process. Which is which is decided in
 * `dispatch`, and the arguments have been checked against the tool's spec before it is reached.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, normalize } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { announceBridge, announcementPath, readAnnouncement, withdrawBridge } from './bridge-announce.js';
import { staleClassNames } from './class-cache.js';
import { DEFAULT_DAP_PORT, GodotDAPClient, handleDAPTool } from './dap_client.js';
import { dictionary, emptyRecord } from './dictionary.js';
import { errorMessage, Refusal } from './errors.js';
import { GameLog, type LogEntry } from './game-log.js';
import { type GodotBridge, getDefaultBridge } from './godot-bridge.js';
import { GodotLocator } from './godot-path.js';
import { type HeadlessOutcome, runOperation } from './headless.js';
import { defectReport, feedbackNotice } from './issues.js';
import { parseJUnit, type TestReport } from './junit.js';
import {
  type EditorPorts,
  editorArguments,
  envValue,
  resolveHeadless,
  runArguments,
  userDataIn,
} from './launch.js';
import { DEFAULT_LSP_PORT, GodotLSPClient, handleLSPTool } from './lsp_client.js';
import { resolveWithinProject } from './paths.js';
import { freePort, portFromEnvOrNull } from './ports.js';
import { projectStructure, searchProject } from './project-scan.js';
import { parseProjectGodot, setupResourceHandlers } from './resources.js';
import {
  chooseRuntime,
  discoverRuntimes,
  runtimeDirectory,
  runtimeRequest,
  runtimesAnnounced,
} from './runtime-client.js';
import type {
  GodotProcess,
  MCPToolDefinition,
  OperationParams,
  SpawnedGame,
  ToolResponse,
} from './server-types.js';
import { addonMismatch, DEBUG_MODE, GODOT_DEBUG_MODE_DEFAULT, SERVER_VERSION } from './server-version.js';
import { installedAddonVersion } from './setup.js';
import {
  asParams,
  readArray,
  readBoolean,
  readNonEmptyString,
  readNumber,
  readPositiveNumber,
  readString,
  readStringArray,
} from './tool-args.js';
import {
  argumentsOf,
  buildToolDefinitions,
  opTakes,
  TOOL_SPECS,
  type ToolSpec,
  toolSpec,
} from './tool-definitions.js';
import { UpdateCheck } from './update-check.js';

/**
 * How many answers pass between one update notice and the next.
 *
 * A session long enough to run through this many tool calls is one where the first notice has
 * scrolled well out of anybody's reading, and a session shorter than it gets exactly one.
 */
const UPDATE_NOTICE_EVERY = 500;

/**
 * How many answers pass between one invitation to report a gap and the next.
 *
 * Only whoever is driving the harness can notice that a tool which should exist does not, and
 * they will not think to say so unasked. Often enough that a long session is asked more than
 * once, rare enough that it is never the reason an answer got longer.
 */
const FEEDBACK_NOTICE_EVERY = 250;

// execFile, not exec: no shell means no quoting, and no quoting means no way to escape out
// of it. Every argument below is an array element, so a path full of backslashes, spaces or
// quotes is just a path.
const run = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Long enough for an editor to save, close, start again and rescan a large project.
 *
 * Not longer: an editor that has not come back by now is stuck on something a person has to
 * look at, usually a dialog, and saying so beats holding the caller's call open in silence.
 */
const EDITOR_RESTART_TIMEOUT_MS = 90_000;

/**
 * The frame rate a wait counts at, which is deliberately lower than any game draws.
 *
 * Only a bound on patience: the answer comes when the frames have passed, whatever rate they
 * passed at. Twenty is slow enough to cover a game working through a day turn and fast enough
 * that a game which has stopped drawing is still called stuck rather than waited on for a minute.
 */
const SLOWEST_FRAME_RATE = 20;

/**
 * How long a wait of this many frames is given before the game is called stuck, which is never
 * less than [param atLeast], the patience every other command gets.
 */
export function patienceForFrames(frames: number, atLeast: number): number {
  return Math.max(atLeast, (frames / SLOWEST_FRAME_RATE) * 1000 + atLeast);
}

/** Whether [param value] is the [param kind] a schema asked for. An unknown kind asks nothing. */
function isOfType(value: unknown, kind: unknown): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

/** What arrived, in the words the refusal uses, so a caller can see the two side by side. */
const VALUE_NAMES: Readonly<Record<string, string>> = {
  string: 'a string',
  number: 'a number',
  boolean: 'a boolean',
  object: 'an object',
};

function describeValue(value: unknown): string {
  if (Array.isArray(value)) {
    return 'a list';
  }
  return VALUE_NAMES[typeof value] ?? typeof value;
}

/**
 * Which arguments are not the type their schema declares.
 *
 * An argument a tool does not name is refused already, and one it names but cannot use is the
 * same mistake wearing the right word: `includeProperties` given the list of properties to
 * include was taken, ignored, and answered as though it had been read, which is exactly the shape
 * a refusal exists to prevent.
 *
 * A schema naming no type asks nothing, because some arguments genuinely have none: a value being
 * fitted to a property is whatever that property holds, and that is the engine's business.
 */
function wrongTypes(spec: ToolSpec, args: OperationParams): string[] {
  const complaints: string[] = [];
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined || value === null) {
      continue;
    }
    const declared = spec.parameters[name]?.['type'];
    const wanted = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : [];
    if (wanted.length === 0 || wanted.some((kind) => isOfType(value, kind))) {
      continue;
    }
    complaints.push(`${name} as ${wanted.join(' or ')}, not ${describeValue(value)}`);
  }
  return complaints;
}

/**
 * How often to ask again for a bridge port somebody else is holding.
 *
 * Two seconds: the wait is nearly always a server on its way out, which takes a moment, and the
 * cost of asking is one bind that fails immediately.
 */
const BRIDGE_RETRY_MS = 2_000;

/**
 * How often a server asks whether its project has a newer one.
 *
 * A poll rather than a watch on the file, because the failure modes are not the same size: a watch
 * that misses its event never stands the server down at all, and a read that comes back torn or
 * unreadable is simply asked again ten seconds later.
 *
 * Ten seconds because what a superseded server is holding is the default bridge port, and an
 * editor with nothing announced falls into whoever has it. The cost is one small file read on an
 * unreferenced timer.
 */
const SUCCESSOR_CHECK_MS = 10_000;

/** What to tell a caller whose file, scene, script or resource path landed outside the project. */
const PATH_SOLUTIONS = [
  'Give the path relative to the project, such as "scenes/main.tscn" or "res://scenes/main.tscn"',
  'Point projectPath at the project the file belongs to',
];

/**
 * The arguments that name a file inside the project, on every tool that has them. Each is
 * judged before the engine or the editor sees it and handed over as the `res://` path the
 * project knows it by: both read `../outside.tscn` as a file to open and an absolute path as a
 * project file, so the boundary belongs on this side.
 */
const PROJECT_FILE_ARGUMENTS = ['scenePath', 'scriptPath', 'resourcePath', 'newPath', 'path', 'script'];

/**
 * The first value in `properties` that walks out of the project, if there is one.
 *
 * A `..` segment in something that is also shaped like a path is the whole test: a caption reading
 * "and/or" has no `..`, and a resource path has no reason to hold one. Anything subtler than that
 * would have to know which properties take a Resource, which only the engine does.
 */
function escapingPropertyValue(properties: unknown): string | undefined {
  if (typeof properties !== 'object' || properties === null) {
    return undefined;
  }
  for (const value of Object.values(properties as Record<string, unknown>)) {
    if (typeof value !== 'string' || !value.includes('/')) {
      continue;
    }
    if (value.split(/[/\\]/).includes('..')) {
      return JSON.stringify(value);
    }
  }
  return undefined;
}

/** Which debug adapter call each debug_state op is. */
const DEBUG_STATE_CALLS: Readonly<Record<string, string>> = dictionary({
  stack: 'dap_get_stack_trace',
  output: 'dap_get_output',
  variables: 'dap_get_variables',
});

/** The headless operation behind each tool and op that needs neither the editor nor a game. */
export const HEADLESS_OPERATIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = dictionary({
  project_settings: dictionary({
    get: 'get_project_setting',
    set: 'set_project_setting',
    add_autoload: 'add_autoload',
    remove_autoload: 'remove_autoload',
    set_main_scene: 'set_main_scene',
    add_input_action: 'add_input_action',
    enable_plugin: 'enable_plugin',
    disable_plugin: 'disable_plugin',
    add_audio_bus: 'create_audio_bus',
    set_audio_bus_effect: 'set_audio_bus_effect',
    set_audio_bus_volume: 'set_audio_bus_volume',
  }),
  project_import: dictionary({
    status: 'get_import_status',
    options: 'get_import_options',
    set_options: 'set_import_options',
    reimport: 'reimport_resource',
    uid: 'get_uid',
    refresh_uids: 'resave_resources',
    refresh_classes: 'refresh_class_cache',
  }),
  project_export: dictionary({ list: 'list_export_presets' }),
  script_edit: dictionary({ create: 'create_script', modify: 'modify_script' }),
  script_info: dictionary({ structure: 'get_script_info' }),
  editor_classes: dictionary({
    query: 'query_classes',
    info: 'query_class_info',
    inheritance: 'inspect_inheritance',
  }),
});

/** The sections project_info can add, each a headless operation, with what it is asked. */
const PROJECT_INFO_SECTIONS: Readonly<
  Record<string, { operation: string; params: (args: OperationParams, detailed: boolean) => OperationParams }>
> = dictionary({
  autoloads: { operation: 'list_autoloads', params: () => ({}) },
  plugins: { operation: 'list_plugins', params: () => ({}) },
  export_presets: { operation: 'list_export_presets', params: () => ({}) },
  audio_buses: { operation: 'get_audio_buses', params: () => ({}) },
  health: { operation: 'get_project_health', params: () => ({}) },
  validation: {
    operation: 'validate_project',
    params: (args, detailed) => ({ preset: readString(args, 'preset') ?? '', includeSuggestions: detailed }),
  },
});

/** The path with every symlink on it resolved, or the path itself when there is nothing there. */
function realPathOr(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** Where gdUnit4 lives, which is where a backtrace stops being about the game. */
const RUNNER_DIRECTORY = 'addons/gdUnit4/';

/**
 * One engine message with the runner's own frames taken off the bottom of its backtrace.
 *
 * An error pushed inside a test carries the twenty frames gdUnit4 took to reach it, and they are
 * the same twenty every time: twenty-eight messages from one tier came back as seven hundred lines
 * of stage, execution stage and test case. What is above them is the game, ending in the test that
 * caused it, which is the whole of what anybody reads. Said rather than dropped, so a backtrace
 * that looks short is one that says why.
 */
function aboveTheRunner(entry: LogEntry): LogEntry {
  const runner = entry.detail.findIndex((line) => line.includes(RUNNER_DIRECTORY));
  if (runner < 0) {
    return entry;
  }
  const cut = entry.detail.length - runner;
  return {
    ...entry,
    detail: [...entry.detail.slice(0, runner), `[and ${cut} frames inside ${RUNNER_DIRECTORY}]`],
  };
}

/** Whether project.godot names a scene for the game to start in. */
function hasMainScene(projectFile: string): boolean {
  const scene = parseProjectGodot(readFileSync(projectFile, 'utf8'))['application']?.['run/main_scene'];
  return typeof scene === 'string' && scene !== '';
}

/**
 * Whether the editor would play this project without a window.
 *
 * The editor appends `editor/run/main_run_args` to the game it starts, so a project that carries
 * `--headless` there is one the editor plays headless. It is the only way a game the editor owns
 * can be known to open no window, and it is what lets a headless request still go through the
 * editor, which is the only route with a debugger attached.
 */
function editorPlaysHeadless(projectFile: string): boolean {
  const runArgs = parseProjectGodot(readFileSync(projectFile, 'utf8'))['editor']?.['run/main_run_args'];
  return typeof runArgs === 'string' && /(?:^|\s)--headless(?:\s|$)/.test(runArgs);
}

/**
 * Tool arguments with their keys in camelCase, whichever spelling the client used. Only the
 * arguments themselves: what they hold (node properties, import options, a setting value) is
 * the engine's own vocabulary, where `custom_minimum_size` has to stay as it is.
 */
function camelCased(params: unknown): OperationParams {
  // The keys are the `arguments` member of a tools/call, straight off the wire. JSON.parse
  // makes `__proto__` an own enumerable property, so it survives the hasOwn guard below and
  // a write to it would re-parent this object onto caller-supplied data rather than store a key.
  const result: OperationParams = emptyRecord();
  const source = asParams(params);
  for (const key of Object.keys(source)) {
    const name = key.startsWith('_')
      ? key
      : key.replace(/_([a-zA-Z0-9])/g, (_, letter: string) => letter.toUpperCase());
    result[name] = source[key];
  }
  return result;
}

type Checked<T> = { ok: true; value: T } | { ok: false; response: ToolResponse };

class GodotServer {
  // Registration goes through the protocol object rather than McpServer's registerTool: the
  // schemas are authored as data in tool-definitions.ts and validated against the same data
  // before dispatch, which is the "advanced use case" McpServer's own docs point at `.server` for.
  private readonly mcp: McpServer;
  private readonly locator = new GodotLocator();
  private readonly operationsScript = join(__dirname, 'godot', 'operations', 'godot_operations.gd');
  private readonly godotBridge: GodotBridge;
  private readonly tools: MCPToolDefinition[] = buildToolDefinitions();
  private activeProcess: GodotProcess | null = null;
  private readonly updates = new UpdateCheck(SERVER_VERSION);
  private noticedUpdate = false;
  private callsSinceNotice = 0;
  private callsSinceFeedback = 0;
  private lspClient: GodotLSPClient | null = null;
  private dapClient: GodotDAPClient | null = null;
  private bridgeStartupError: string | null = null;
  private bridgeRetry: NodeJS.Timeout | null = null;
  private successorWatch: NodeJS.Timeout | null = null;
  private lastProjectPath: string | null = null;
  private shutdownInitiated = false;

  /**
   * The project this server was set up for, from the config `setup` wrote, or null.
   *
   * Null is every config written before this existed and every one written by hand, and it is
   * what keeps those working exactly as they did: without it there is nowhere to announce a
   * bridge, so the port stays the whole contract and the server holds out for it.
   */
  private readonly ownProject: string | null;
  private announcedAt: string | null = null;

  constructor() {
    this.ownProject = envValue('GDHARNESS_PROJECT') ?? null;
    this.godotBridge = getDefaultBridge(this.ownProject);
    this.mcp = new McpServer(
      { name: 'gdharness', version: SERVER_VERSION },
      { capabilities: { tools: {}, resources: {} } },
    );
    this.setupToolHandlers();
    setupResourceHandlers(this.mcp, () => this.lastProjectPath);
    this.mcp.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };
    this.setupShutdownHandlers();
  }

  /** Debug lines go to stderr, since stdout is the JSON-RPC stream. */
  private logDebug(message: string): void {
    if (DEBUG_MODE) {
      console.error(`[DEBUG] ${message}`);
    }
  }

  private createErrorResponse(message: string, possibleSolutions: string[] = []): ToolResponse {
    console.error(`[SERVER] Error response: ${message}`);
    const response: ToolResponse = { content: [{ type: 'text', text: message }], isError: true };
    if (possibleSolutions.length > 0) {
      response.content.push({
        type: 'text',
        text: `Possible solutions:\n- ${possibleSolutions.join('\n- ')}`,
      });
    }
    return response;
  }

  private jsonTextResponse(payload: unknown): ToolResponse {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  async run(): Promise<void> {
    const godotPath = await this.locator.find();
    if (godotPath === null) {
      console.error(
        '[SERVER] No Godot found. Set GODOT_PATH; until then every tool that runs the engine will say so.',
      );
    } else {
      console.error(`[SERVER] Using Godot at: ${godotPath}`);
    }

    const transport = new StdioServerTransport();
    await this.mcp.server.connect(transport);
    process.stdin.once('end', () => {
      void this.handleShutdown('stdin:end', 0);
    });
    console.error('gdharness running on stdio');

    // A bridge that cannot bind must not take the stdio server down with it: the tools that
    // need no editor still work, and editor_status says what happened.
    try {
      await this.godotBridge.start();
      this.bridgeStartupError = null;
      const bridgeStatus = this.godotBridge.getStatus();
      console.error(`[SERVER] Godot Editor Bridge started on ${bridgeStatus.host}:${bridgeStatus.port}`);
      this.announceTheBridge();
    } catch (bridgeError) {
      const code =
        bridgeError instanceof Error && 'code' in bridgeError && typeof bridgeError.code === 'string'
          ? bridgeError.code
          : null;
      const reason = errorMessage(bridgeError);
      this.bridgeStartupError = code && !reason.includes(code) ? `${code}: ${reason}` : reason;
      console.error(`[SERVER] Warning: Godot Editor Bridge failed to start: ${this.bridgeStartupError}`);
      console.error('[SERVER] Continuing without bridge-backed editor tools, and trying again.');
      this.keepTryingTheBridge();
    }
  }

  /**
   * Keeps asking for the bridge port, because the reason it is busy is nearly always temporary.
   *
   * One server owns the port and the rest get nothing, and the usual way that happens is a
   * harness reconnecting: the replacement starts while the server it replaces is still on its way
   * out. Binding once at startup made that permanent. The session then had every editor tool
   * refusing for the rest of its life, `editor_launch restart` among them, and the only way out
   * was somebody finding the old process and ending it by hand. Nothing should need that.
   *
   * It runs until it succeeds or the server stops, and unref'd, so it never holds the process
   * open on its own.
   */
  private keepTryingTheBridge(): void {
    if (this.bridgeRetry !== null || this.shutdownInitiated) {
      return;
    }
    this.bridgeRetry = setInterval(() => {
      void this.tryTheBridgeAgain();
    }, BRIDGE_RETRY_MS);
    this.bridgeRetry.unref();
  }

  private async tryTheBridgeAgain(): Promise<void> {
    if (this.shutdownInitiated) {
      this.stopTryingTheBridge();
      return;
    }
    try {
      await this.godotBridge.start();
    } catch {
      // Still somebody else's. The next tick asks again, and until then editor_status says so.
      return;
    }
    this.bridgeStartupError = null;
    this.stopTryingTheBridge();
    const bridgeStatus = this.godotBridge.getStatus();
    console.error(
      `[SERVER] Godot Editor Bridge came up on ${bridgeStatus.host}:${bridgeStatus.port}; editor tools are live.`,
    );
    this.announceTheBridge();
  }

  /**
   * Says where the bridge is, inside the project, so the editor can find it wherever it landed.
   *
   * Written after every start, which is what makes the newest server the one the editor ends up
   * on: an abandoned predecessor holding the old port has an older announcement, and the editor
   * moves off it by itself rather than waiting for somebody to end a process.
   */
  private announceTheBridge(): void {
    if (this.ownProject === null) {
      return;
    }
    const status = this.godotBridge.getStatus();
    this.announcedAt = announceBridge(this.ownProject, {
      host: status.host,
      port: status.port,
      version: SERVER_VERSION,
    });
    this.watchForASuccessor();
  }

  private stopTryingTheBridge(): void {
    if (this.bridgeRetry !== null) {
      clearInterval(this.bridgeRetry);
      this.bridgeRetry = null;
    }
  }

  /**
   * Stops this server once another one has taken over its project.
   *
   * A stdio server's life is its stdin, and there is a handler for the end of it. It never
   * arrives: a harness that reconnects spawns the replacement and leaves this process running as
   * its child, still holding the pipe open, so nothing here is ever told it is finished. Six of
   * them were found alive on one machine, one for every version a project had moved through in a
   * day, the oldest from nine hours earlier.
   *
   * None of them is reachable. The editor follows the announcement and the replacement has
   * rewritten it. What they do instead is worse than nothing: the first one started took the
   * default bridge port and the rest moved off it, so the oldest, most out of date server on the
   * machine is the one every editor with nothing announced falls back to, and it answers them.
   *
   * The announcement is the signal because it is already the one both sides read, and it carries
   * the process that wrote it. A successor has to still be running to count, so that a
   * replacement which died without withdrawing does not take the last server with it.
   */
  private watchForASuccessor(): void {
    if (this.ownProject === null || this.successorWatch !== null) {
      return;
    }
    const watch = setInterval(() => {
      const successor = this.supersededBy();
      if (successor === null) {
        return;
      }
      console.error(
        `[SERVER] pid ${successor} now serves ${this.ownProject}; this server is finished and is stopping.`,
      );
      void this.handleShutdown(`superseded by ${successor}`, 0);
    }, SUCCESSOR_CHECK_MS);
    // Never a reason on its own for the process to stay up.
    watch.unref();
    this.successorWatch = watch;
  }

  /** The live server that has taken this project's announcement, or null while it is still ours. */
  private supersededBy(): number | null {
    if (this.ownProject === null) {
      return null;
    }
    const announced = readAnnouncement(announcementPath(this.ownProject));
    if (announced === null || announced.pid === process.pid) {
      return null;
    }
    try {
      // Signal 0 asks whether it could be signalled rather than signalling it.
      process.kill(announced.pid, 0);
      return announced.pid;
    } catch {
      return null;
    }
  }

  private stopWatchingForASuccessor(): void {
    if (this.successorWatch !== null) {
      clearInterval(this.successorWatch);
      this.successorWatch = null;
    }
  }

  private async cleanup(): Promise<void> {
    this.logDebug('Cleaning up resources');
    this.stopTryingTheBridge();
    this.stopWatchingForASuccessor();
    withdrawBridge(this.announcedAt);
    this.announcedAt = null;
    if (this.activeProcess) {
      // Killed rather than stopped through the editor: a shutdown cannot wait on a round trip,
      // and a game the editor plays outlives this server anyway, which is the editor's to end.
      this.activeProcess.process?.kill();
      this.activeProcess = null;
    }
    // Each of these is allowed to fail without stopping the rest of the shutdown, but a
    // failure has to leave a trace: a stop that did not release the language server port is
    // indistinguishable from one that did until the next run cannot bind.
    if (this.lspClient) {
      try {
        await this.lspClient.disconnect();
      } catch (error) {
        this.logDebug(`LSP client did not disconnect cleanly: ${errorMessage(error)}`);
      }
      this.lspClient = null;
    }
    if (this.dapClient) {
      try {
        await this.dapClient.disconnect();
      } catch (error) {
        this.logDebug(`DAP client did not disconnect cleanly: ${errorMessage(error)}`);
      }
      this.dapClient = null;
    }
    try {
      await this.godotBridge.stop();
    } catch (error) {
      this.logDebug(`Godot bridge did not stop cleanly: ${errorMessage(error)}`);
    }
    await this.mcp.server.close();
  }

  private setupShutdownHandlers(): void {
    const requestShutdown = (source: string, exitCode?: number): void => {
      void this.handleShutdown(source, exitCode);
    };
    process.once('SIGINT', () => {
      requestShutdown('SIGINT', 0);
    });
    process.once('SIGTERM', () => {
      requestShutdown('SIGTERM', 0);
    });
    process.once('SIGHUP', () => {
      requestShutdown('SIGHUP', 0);
    });
    process.once('beforeExit', (code: number) => {
      requestShutdown(`beforeExit:${code}`);
    });
    process.once('exit', () => {
      this.forceCleanupOnExit();
    });
  }

  private async handleShutdown(source: string, exitCode?: number): Promise<void> {
    if (this.shutdownInitiated) {
      return;
    }
    this.shutdownInitiated = true;
    this.logDebug(`Shutting down server via ${source}`);
    try {
      await this.cleanup();
    } catch (error) {
      console.error(`[SERVER] Shutdown cleanup failed (${source}):`, error);
    } finally {
      if (typeof exitCode === 'number') {
        process.exit(exitCode);
      }
    }
  }

  private forceCleanupOnExit(): void {
    if (this.shutdownInitiated) {
      return;
    }
    this.shutdownInitiated = true;
    // 'exit' runs synchronously and the process is gone the moment this returns, so the child
    // kill is the only thing that can still happen here. The bridge's close is a promise that
    // would never settle, and the sockets go with the process anyway; the paths that can
    // await it are SIGINT, SIGTERM, SIGHUP and beforeExit, which all go through cleanup().
    if (this.activeProcess) {
      try {
        this.activeProcess.process?.kill();
      } catch (error) {
        console.error('[SERVER] Failed to kill the Godot process on exit:', errorMessage(error));
      }
      this.activeProcess = null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------------------------

  private setupToolHandlers(): void {
    this.mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: this.tools }));
    this.mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      this.logDebug(`Handling tool request: ${request.params.name}`);
      const spec = toolSpec(request.params.name);
      if (!spec) {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}. Tools: ${TOOL_SPECS.map((tool) => tool.name).join(', ')}`,
        );
      }

      const args = camelCased(request.params.arguments);
      const checked = this.validateArguments(spec, args);
      if (!checked.ok) {
        return checked.response;
      }
      if (typeof args['projectPath'] === 'string') {
        this.lastProjectPath = args['projectPath'];
      }
      // Started here and not waited for: whatever it learns lands on a later call, and a
      // registry that never answers costs this one nothing.
      this.updates.refresh();
      const answer = await this.answered(spec.name, checked.op ?? '', args);
      return this.withFeedbackNotice(this.withUpdateNotice(answer));
    });
  }

  /**
   * The dispatch, and what a throw out of it answers with.
   *
   * Nearly every failure a tool anticipates is returned rather than thrown, and the few that are
   * thrown say so by their type, so anything else arriving here is a state the code does not
   * model. That is worth saying plainly: an exception message handed straight to an agent reads
   * as something it did wrong, and it will spend three turns rephrasing a call that was right the
   * first time. A {@link Refusal} passes through as the caller's answer, and an `McpError` as
   * itself, since the protocol has its own place for "no such tool".
   */
  private async answered(tool: string, op: string, args: OperationParams): Promise<ToolResponse> {
    try {
      return await this.dispatch(tool, op, args);
    } catch (error) {
      if (error instanceof McpError || error instanceof Refusal) {
        throw error;
      }
      const where = op === '' ? tool : `${tool} op=${op}`;
      console.error(`[SERVER] Unmodelled failure in ${where}:`, error);
      return { content: [{ type: 'text', text: defectReport(where, error) }], isError: true };
    }
  }

  /**
   * Adds the "there is a newer one" block to an answer, at most once a session and then rarely.
   *
   * On every answer it would stop being read by the third call, and on one answer only it would
   * be missed by a session that started before the check came back. So: the first answer after
   * an update is known, and then one in every {@link UPDATE_NOTICE_EVERY} after that, for a
   * session long enough to have forgotten.
   */
  private withUpdateNotice(answer: ToolResponse): ToolResponse {
    this.callsSinceNotice += 1;
    if (this.callsSinceNotice < UPDATE_NOTICE_EVERY && this.noticedUpdate) {
      return answer;
    }

    // Before the one about npm, because this one is certain and about this project rather than
    // about the world, and because it is the state where the rest of the answer may be wrong.
    const moved = this.projectHasMovedOn();
    if (moved !== null) {
      this.noticedUpdate = true;
      this.callsSinceNotice = 0;
      return this.saying(answer, {
        project_upgraded_under_this_server: {
          server_is: SERVER_VERSION,
          project_is: moved,
          what_to_do:
            'The project was upgraded while this server has been running, so it is still answering ' +
            'as the version it was started as. Tell the user to reconnect the MCP server, which is ' +
            'the only thing that replaces it: a server cannot restart itself.',
        },
      });
    }

    const notice = this.updates.notice();
    if (notice === null) {
      return answer;
    }
    this.noticedUpdate = true;
    this.callsSinceNotice = 0;
    return this.saying(answer, {
      update_available: {
        ...notice,
        what_to_do:
          'Tell the user a newer gdharness is out, with what changed, and offer to take it. ' +
          'Only run the upgrade command if they say yes: it restarts their editor and the ' +
          'MCP server has to be reconnected afterwards.',
      },
    });
  }

  /** One more block on the end of an answer, which is how both notices reach the agent. */
  private saying(answer: ToolResponse, block: Record<string, unknown>): ToolResponse {
    return {
      ...answer,
      content: [...answer.content, { type: 'text', text: JSON.stringify(block, null, 2) }],
    };
  }

  /**
   * What the project's addons say they are, when that is not what this server is.
   *
   * Read from disk rather than from the editor, so it is true whether or not an editor is open,
   * and cheap enough to ask on the same schedule as the update notice. Only a server that knows
   * its project can ask at all, which is the same thing that lets it announce its bridge.
   */
  private projectHasMovedOn(): string | null {
    if (this.ownProject === null) {
      return null;
    }
    const installed = installedAddonVersion(this.ownProject);
    return installed === null || installed === SERVER_VERSION ? null : installed;
  }

  /**
   * Asks, now and then, for the thing that is missing.
   *
   * A gap in the tool surface is invisible from in here: the server answers what it was asked and
   * never hears about the call somebody wanted to make and could not. The one party that does
   * know is whatever just worked around it, and it will not volunteer that unprompted. So it is
   * asked, rarely enough to never be the reason an answer got longer, and told to put it to the
   * user rather than file anything itself.
   */
  private withFeedbackNotice(answer: ToolResponse): ToolResponse {
    this.callsSinceFeedback += 1;
    if (this.callsSinceFeedback < FEEDBACK_NOTICE_EVERY) {
      return answer;
    }
    this.callsSinceFeedback = 0;
    return {
      ...answer,
      content: [...answer.content, { type: 'text', text: feedbackNotice() }],
    };
  }

  /**
   * The arguments of a call checked against the tool's spec: nothing the schema does not name,
   * each one of the type it is declared as, an op from the enum, and every argument the tool and
   * its op require. Returns the op to dispatch on, or the refusal to send back. Own properties
   * only: a required argument satisfied by something inherited from Object.prototype is not
   * supplied.
   */
  private validateArguments(
    spec: ToolSpec,
    args: OperationParams,
  ): { ok: true; op: string | null } | { ok: false; response: ToolResponse } {
    const known = new Set([...Object.keys(spec.parameters), ...(spec.operations ? ['op'] : [])]);
    const unknown = Object.keys(args).filter((key) => !known.has(key));
    if (unknown.length > 0) {
      return {
        ok: false,
        response: this.createErrorResponse(
          `${spec.name} does not take ${unknown.join(', ')}. It takes: ${[...known].join(', ')}.`,
        ),
      };
    }

    const wrong = wrongTypes(spec, args);
    if (wrong.length > 0) {
      return { ok: false, response: this.createErrorResponse(`${spec.name} takes ${wrong.join('; ')}.`) };
    }

    let op: string | null = null;
    if (spec.operations) {
      const valid = Object.keys(spec.operations);
      const requested = args['op'];
      if (requested === undefined) {
        if (!spec.defaultOperation) {
          return {
            ok: false,
            response: this.createErrorResponse(`${spec.name} needs op, one of: ${valid.join(', ')}.`),
          };
        }
        op = spec.defaultOperation;
      } else if (typeof requested === 'string' && Object.hasOwn(spec.operations, requested)) {
        op = requested;
      } else {
        return {
          ok: false,
          response: this.createErrorResponse(
            `${spec.name} has no op ${JSON.stringify(requested)}. Valid ops: ${valid.join(', ')}.`,
          ),
        };
      }
    }

    // An argument named for a different op. The tool-level check above passes it, because the tool
    // does take it, and then the op reads nothing of the sort and answers as though it had: a limit
    // on a screen read, a property list on a find. That is the same fault as an argument nothing
    // names, and it is worse, because the caller has read the schema and believes they got it right.
    if (op !== null) {
      const elsewhere = Object.keys(args).filter((key) => key !== 'op' && !opTakes(spec, op, key));
      if (elsewhere.length > 0) {
        return {
          ok: false,
          response: this.createErrorResponse(
            `${spec.name} ${op} does not take ${elsewhere.join(', ')}. ${op} takes: ${argumentsOf(spec, op).join(', ')}.`,
          ),
        };
      }
    }

    const required = [...spec.requires, ...(op !== null ? (spec.operations?.[op]?.requires ?? []) : [])];
    const missing = required.filter((field) => {
      const value = Object.hasOwn(args, field) ? args[field] : undefined;
      if (value === undefined || value === null) {
        return true;
      }
      // Blank is an argument somebody meant to fill in, everywhere but the few that carry content
      // rather than name something: emptying a field and writing "" to a property are both calls a
      // caller means, and refusing them as missing tells them they forgot what they deliberately
      // sent. See `blank` in tool-definitions.
      const blank = typeof value === 'string' && value.trim() === '';
      return blank && spec.parameters[field]?.blank !== true;
    });
    if (missing.length > 0) {
      const where = op !== null ? `${spec.name} ${op}` : spec.name;
      return { ok: false, response: this.createErrorResponse(`${where} needs ${missing.join(', ')}.`) };
    }
    return { ok: true, op };
  }

  /**
   * One tool call to the code that does it. The editor addon and the runtime addon keep their
   * command names, so an op that renamed an argument hands it over under the old name here.
   * `op` is empty for a tool that has none.
   */
  private async dispatch(tool: string, op: string, args: OperationParams): Promise<ToolResponse> {
    const headless = HEADLESS_OPERATIONS[tool]?.[op];
    if (headless !== undefined) {
      return await this.headless(headless, args);
    }

    const { op: _op, ...arguments_ } = args;
    const bridge = async (command: string, extra: OperationParams = {}): Promise<ToolResponse> => {
      const contained = this.containProjectFiles({ ...arguments_, ...extra });
      return contained.ok ? await this.handleViaBridge(command, contained.value) : contained.response;
    };

    switch (tool) {
      case 'project_info':
        return await this.handleProjectInfo(args);
      case 'project_search':
        return this.handleSearchProject(args);
      case 'project_dependencies':
        return await this.headless(
          args['direction'] === 'reverse' ? 'find_resource_usages' : 'get_dependencies',
          args,
        );
      case 'project_export':
        return await this.handleExportProject(args);
      case 'project_test':
        return await this.handleRunTests(args);

      case 'scene_create':
        return op === 'create' ? await bridge('create_scene') : await bridge('save_scene');
      case 'scene_tree':
        return await bridge('list_scene_nodes');
      case 'scene_node':
        switch (op) {
          case 'add':
            return await bridge('add_node');
          case 'get':
            return await bridge('get_node_properties');
          case 'set':
            return await bridge('set_node_properties');
          case 'duplicate':
            return await bridge('duplicate_node', { parentPath: args['parentNodePath'] });
          case 'reparent':
            return await bridge('reparent_node');
          case 'delete':
            return await bridge('delete_node');
          default:
            return await bridge('set_tilemap_cells', { tilemapNodePath: args['nodePath'] });
        }
      case 'scene_signal':
        switch (op) {
          case 'connect':
            return await bridge('connect_signal');
          case 'disconnect':
            return await bridge('disconnect_signal');
          default:
            return await bridge('list_connections');
        }
      case 'scene_animation':
        switch (op) {
          case 'create':
            return await bridge('create_animation');
          case 'add_track':
            return await bridge('add_animation_track');
          case 'add_state':
            return await bridge('add_animation_state');
          default:
            return await bridge('connect_animation_states');
        }

      case 'script_info':
        switch (op) {
          case 'symbols':
            return await this.handleLSP('lsp_get_symbols', args);
          case 'completion':
            return await this.handleLSP('lsp_get_completions', args);
          default:
            return await this.handleLSP('lsp_get_hover', args);
        }
      case 'script_diagnostics':
        return await this.handleScriptDiagnostics(args);

      case 'resource_edit':
        switch (op) {
          case 'create':
            return await bridge('create_resource');
          case 'modify':
            return await bridge('modify_resource');
          case 'create_shader':
            return await bridge('create_shader', { shaderPath: args['resourcePath'] });
          case 'create_tileset':
            return await bridge('create_tileset', { tilesetPath: args['resourcePath'] });
          case 'set_theme_color':
            return await bridge('set_theme_color', { themePath: args['resourcePath'] });
          default:
            return await bridge('set_theme_font_size', { themePath: args['resourcePath'] });
        }

      case 'editor_launch':
        return op === 'restart' ? await this.handleRestartEditor() : await this.handleLaunchEditor(args);
      case 'editor_run':
        return op === 'stop' ? await this.handleStopProject() : await this.handleRunProject(args, op);
      case 'editor_output':
        return this.handleGetDebugOutput(args);
      case 'editor_status':
        return await this.handleEditorStatus();
      case 'editor_rescan':
        return await this.handleRescanFilesystem(args);

      case 'runtime_inspect':
        switch (op) {
          case 'tree':
            return await this.handleRuntimeCommand('get_tree', {
              projectPath: args['projectPath'],
              root: readNonEmptyString(args, 'nodePath') ?? '/root',
              depth: readPositiveNumber(args, 'depth') ?? 3,
              include_properties: readBoolean(args, 'includeProperties') ?? false,
            });
          case 'find':
            return await this.handleFindRuntimeNodes(args);
          case 'text':
            return await this.handleRuntimeCommand('read_text', {
              projectPath: args['projectPath'],
              root: readNonEmptyString(args, 'nodePath') ?? '/root',
              include_hidden: readBoolean(args, 'includeHidden') ?? false,
              limit: readPositiveNumber(args, 'limit') ?? 500,
            });
          case 'rect':
            return await this.handleRuntimeCommand('get_rect', {
              projectPath: args['projectPath'],
              path: readNonEmptyString(args, 'nodePath') ?? '',
            });
          case 'property':
            return await this.handleRuntimeCommand('get_property', {
              projectPath: args['projectPath'],
              path: readNonEmptyString(args, 'nodePath') ?? '',
              property: readNonEmptyString(args, 'property') ?? '',
            });
          default:
            return await this.handleRuntimeCommand('get_metrics', {
              projectPath: args['projectPath'],
              metrics: readArray(args, 'metrics') ?? [],
            });
        }
      case 'runtime_invoke':
        // The value and the arguments are fitted to the property's or the method's own types
        // on the game's side.
        return op === 'set'
          ? await this.handleRuntimeCommand('set_property', {
              projectPath: args['projectPath'],
              path: readNonEmptyString(args, 'nodePath') ?? '',
              property: readString(args, 'property') ?? '',
              value: args['value'],
            })
          : await this.handleRuntimeCommand('call_method', {
              projectPath: args['projectPath'],
              path: readNonEmptyString(args, 'nodePath') ?? '',
              method: readString(args, 'method') ?? '',
              args: readArray(args, 'args') ?? [],
            });
      case 'runtime_capture':
        return await this.handleRuntimeCommand(
          op === 'screenshot' ? 'capture_screenshot' : 'capture_viewport',
          args,
        );
      case 'runtime_input':
        if (op === 'click') {
          return await this.handleRuntimeCommand('click', {
            projectPath: args['projectPath'],
            path: readNonEmptyString(args, 'nodePath') ?? '',
            button: readString(args, 'button') ?? 'left',
            double: readBoolean(args, 'doubleClick') ?? false,
          });
        }
        if (op === 'choose') {
          // `index` is passed on only when it was given, because the addon reads whether it is
          // there as which of the two ways the caller named the item.
          return await this.handleRuntimeCommand('choose', {
            projectPath: args['projectPath'],
            path: readNonEmptyString(args, 'nodePath') ?? '',
            text: readString(args, 'text') ?? '',
            ...(args['index'] === undefined ? {} : { index: args['index'] }),
          });
        }
        return await this.handleRuntimeCommand(`inject_${op}`, args);
      case 'runtime_wait':
        return await this.handleRuntimeWait(op, args);

      case 'debug_breakpoint': {
        // The adapter names the file the way this machine spells it, not the way the project
        // does, so the projectPath every other tool takes is what turns `res://main.gd` into one.
        const project = this.project(args);
        if (!project.ok) {
          return project.response;
        }
        const located = resolveWithinProject(project.value.path, readString(args, 'scriptPath') ?? '');
        if (!located.ok) {
          return this.createErrorResponse(located.reason, PATH_SOLUTIONS);
        }
        // Resolved, because the adapter refuses a path that does not start with the project as
        // it holds it, and a symlink on the way makes two spellings of the same file: on macOS
        // every /var/folders path is really /private/var/folders.
        return await this.handleDAP(op === 'set' ? 'dap_set_breakpoint' : 'dap_remove_breakpoint', {
          ...args,
          scriptPath: realPathOr(located.absolutePath),
        });
      }
      case 'debug_control':
      case 'debug_state': {
        // The console the adapter buffered outlives the game it came from, so reading it needs
        // no session. A stack, a scope and a step all need one, and one that is stopped.
        if (tool === 'debug_state' && op === 'output') {
          return await this.handleDAP('dap_get_output', args);
        }
        const held = await this.debuggedGame();
        if (!held.ok) {
          return held.response;
        }
        return tool === 'debug_control'
          ? await this.handleDAP(`dap_${op}`, args)
          : await this.handleDAP(DEBUG_STATE_CALLS[op] ?? 'dap_get_stack_trace', args);
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${tool}`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // What every engine-backed tool checks first
  // -------------------------------------------------------------------------------------------

  /** The engine, or the refusal to send when there is none. */
  private async engine(): Promise<Checked<string>> {
    const godotPath = await this.locator.find();
    if (godotPath === null) {
      return {
        ok: false,
        response: this.createErrorResponse('No Godot executable found.', GodotLocator.ADVICE),
      };
    }
    return { ok: true, value: godotPath };
  }

  /** The project the call names, checked to be one. */
  private project(args: OperationParams): Checked<{ path: string; file: string }> {
    const path = readNonEmptyString(args, 'projectPath');
    if (path === undefined) {
      return { ok: false, response: this.createErrorResponse('projectPath is required.') };
    }
    const file = join(path, 'project.godot');
    if (!existsSync(file)) {
      return {
        ok: false,
        response: this.createErrorResponse(`Not a Godot project: ${path}`, [
          'Point projectPath at the directory holding project.godot',
        ]),
      };
    }
    return { ok: true, value: { path, file } };
  }

  /**
   * The game the editor's debugger is holding, stopped, or the refusal saying which part is
   * missing.
   *
   * Every one of these used to answer with an empty stack, and an empty stack reads the same
   * whether nothing is running, the game this server spawned has no debugger behind it, or the
   * game is running freely and was never going to have a frame to show.
   */
  private async debuggedGame(): Promise<Checked<GodotProcess>> {
    const game = this.activeProcess;
    if (game === null) {
      return {
        ok: false,
        response: this.createErrorResponse(
          'No game is running, so there is no debug session to answer for.',
          ['Start one with editor_run start, which has the editor play it'],
        ),
      };
    }
    if (!game.throughEditor) {
      return {
        ok: false,
        response: this.createErrorResponse(
          'The running game is its own process, so no debugger is holding it: breakpoints never hit and there is no stack to read.',
          [
            'editor_run start plays it through the open editor, whose debugger the debug_* tools speak to',
            'editor_status says whether an editor has reached this server',
          ],
        ),
      };
    }
    // Godot's adapter sends no stopped event until a session has been opened on it, so asking
    // whether the game is stopped before this has run would answer "no" forever.
    try {
      await this.dap().attach();
    } catch (error) {
      return {
        ok: false,
        response: this.createErrorResponse(
          `The editor is playing the game but its debug adapter did not answer: ${errorMessage(error)}`,
          [
            `This asked on port ${this.dap().port}, which is where the connected editor says it serves`,
            'GDHARNESS_DAP_PORT points this server at another one',
          ],
        ),
      };
    }
    if (!this.dap().isStopped()) {
      return {
        ok: false,
        response: this.createErrorResponse(
          'The game is running, not stopped, so it has no stack and no scope to read.',
          [
            'debug_breakpoint set puts a breakpoint on before the run, and it is waiting when the game starts',
            'editor_output reads what the running game is printing',
          ],
        ),
      };
    }
    return { ok: true, value: game };
  }

  /**
   * Rebuilds the engine's class cache when the declarations on disk have outgrown it, and
   * answers with the names that were missing from it.
   *
   * The staleness is read from files, so a project whose cache is current pays a directory walk
   * and starts no engine.
   */
  private async refreshStaleClasses(projectPath: string): Promise<Checked<readonly string[]>> {
    const stale = staleClassNames(projectPath);
    if (stale.length === 0) {
      return { ok: true, value: [] };
    }
    const refreshed = await this.operation('refresh_class_cache', {}, projectPath);
    if (!refreshed.ok) {
      return { ok: false, response: this.answer(refreshed) };
    }
    return { ok: true, value: stale };
  }

  /**
   * Every file argument judged against the project and rewritten as its `res://` path, and a
   * plugin name judged as the directory under addons/ it names.
   */
  private containProjectFiles(args: OperationParams): Checked<OperationParams> {
    const projectPath = readString(args, 'projectPath');
    if (!projectPath) {
      return { ok: true, value: args };
    }
    const contained: OperationParams = { ...args };
    for (const key of PROJECT_FILE_ARGUMENTS) {
      const value = readNonEmptyString(args, key);
      if (value === undefined) {
        continue;
      }
      const location = resolveWithinProject(projectPath, value);
      if (!location.ok) {
        return { ok: false, response: this.createErrorResponse(location.reason, PATH_SOLUTIONS) };
      }
      contained[key] = `res://${location.relativePath}`;
    }
    // A property whose type is a Resource takes the path of one, so `properties` carries file
    // paths that no argument name announces. Only the engine knows which of them are paths, so
    // what is judged here is the one thing a path can do that a caption cannot: leave the
    // project. The engine refuses anything that is not a res:// or uid:// path once it knows the
    // type, and the two together keep `properties` inside the same boundary as scenePath.
    const escaping = escapingPropertyValue(args['properties']);
    if (escaping !== undefined) {
      return {
        ok: false,
        response: this.createErrorResponse(
          `The property value ${escaping} resolves outside the project directory.`,
          PATH_SOLUTIONS,
        ),
      };
    }

    const pluginName = readNonEmptyString(args, 'pluginName');
    if (pluginName !== undefined) {
      const plugin = resolveWithinProject(projectPath, `addons/${pluginName}/plugin.cfg`);
      if (!plugin.ok) {
        return {
          ok: false,
          response: this.createErrorResponse(plugin.reason, [
            'Give the plugin directory name as it appears under addons/, such as "my_plugin"',
          ]),
        };
      }
    }
    return { ok: true, value: contained };
  }

  /**
   * A tool answered by the operations script: the project checked, the file arguments
   * contained, the engine found, and the script's answer handed on as it is. Whatever the
   * engine said on stderr along the way comes back with it under `engine_messages`.
   */
  private async headless(operation: string, args: OperationParams): Promise<ToolResponse> {
    const project = this.project(args);
    if (!project.ok) {
      return project.response;
    }
    // Before the engine is looked for, so that a path the server will not open is refused as
    // such rather than as a missing Godot.
    const contained = this.containProjectFiles(args);
    if (!contained.ok) {
      return contained.response;
    }
    const { op: _op, projectPath: _projectPath, ...params } = contained.value;
    return this.answer(await this.operation(operation, params, project.value.path));
  }

  private async operation(
    operation: string,
    params: OperationParams,
    projectPath: string,
  ): Promise<HeadlessOutcome> {
    const engine = await this.engine();
    if (!engine.ok) {
      return { ok: false, message: 'No Godot executable found.', messages: [] };
    }
    this.logDebug(`Running ${operation} in ${projectPath}: ${JSON.stringify(params)}`);
    return await runOperation(
      { godotPath: engine.value, script: this.operationsScript, debug: GODOT_DEBUG_MODE_DEFAULT },
      operation,
      params,
      projectPath,
    );
  }

  private answer(outcome: HeadlessOutcome): ToolResponse {
    if (!outcome.ok) {
      const response = this.createErrorResponse(outcome.message);
      if (outcome.messages.length > 0) {
        response.content.push({
          type: 'text',
          text: JSON.stringify({ engine_messages: outcome.messages }, null, 2),
        });
      }
      return response;
    }
    return this.jsonTextResponse(
      outcome.messages.length > 0
        ? { ...outcome.payload, engine_messages: outcome.messages }
        : outcome.payload,
    );
  }

  // -------------------------------------------------------------------------------------------
  // project
  // -------------------------------------------------------------------------------------------

  /**
   * project_info: the project's own metadata, then whichever sections were asked for, each the
   * answer the matching operation gives on its own, so a section that fails says so without
   * hiding the rest.
   */
  private async handleProjectInfo(args: OperationParams): Promise<ToolResponse> {
    const include = readStringArray(args, 'include') ?? [];
    const unknown = include.filter((name) => PROJECT_INFO_SECTIONS[name] === undefined);
    if (unknown.length > 0) {
      return this.createErrorResponse(
        `project_info cannot include ${unknown.join(', ')}. Sections: ${Object.keys(PROJECT_INFO_SECTIONS).join(', ')}.`,
      );
    }
    const project = this.project(args);
    if (!project.ok) {
      return project.response;
    }
    const engine = await this.engine();
    if (!engine.ok) {
      return engine.response;
    }

    const application = parseProjectGodot(readFileSync(project.value.file, 'utf8'))['application'] ?? {};
    const name = application['config/name'];
    const mainScene = application['run/main_scene'];
    const info: Record<string, unknown> = {
      name: typeof name === 'string' && name !== '' ? name : basename(project.value.path),
      path: project.value.path,
      mainScene: typeof mainScene === 'string' && mainScene !== '' ? mainScene : null,
      godotVersion: await this.godotVersion(engine.value),
      structure: projectStructure(project.value.path),
    };

    const detailed = args['detail'] === 'full';
    for (const section of include) {
      const spec = PROJECT_INFO_SECTIONS[section];
      if (spec === undefined) {
        continue;
      }
      const outcome = await this.operation(spec.operation, spec.params(args, detailed), project.value.path);
      info[section] = outcome.ok
        ? outcome.messages.length > 0
          ? { ...outcome.payload, engine_messages: outcome.messages }
          : outcome.payload
        : { error: outcome.message, engine_messages: outcome.messages };
    }
    return this.jsonTextResponse(info);
  }

  private handleSearchProject(args: OperationParams): ToolResponse {
    const project = this.project(args);
    if (!project.ok) {
      return project.response;
    }
    try {
      return this.jsonTextResponse(
        searchProject(project.value.path, {
          query: readString(args, 'query') ?? '',
          fileTypes: readStringArray(args, 'fileTypes') ?? [
            'gd',
            'tscn',
            'tres',
            'gdshader',
            'cfg',
            'md',
            'txt',
            'json',
          ],
          regex: readBoolean(args, 'regex') ?? false,
          caseSensitive: readBoolean(args, 'caseSensitive') ?? false,
          maxResults: readPositiveNumber(args, 'maxResults') ?? 100,
        }),
      );
    } catch (error) {
      return this.createErrorResponse(`Search failed: ${errorMessage(error)}`);
    }
  }

  /**
   * project_export run: the engine's own export, which is not an operation of the script. The
   * destination is documented as inside the project and is contained like every other path.
   */
  private async handleExportProject(args: OperationParams): Promise<ToolResponse> {
    const project = this.project(args);
    if (!project.ok) {
      return project.response;
    }
    const preset = readNonEmptyString(args, 'preset') ?? '';
    const output = resolveWithinProject(project.value.path, readString(args, 'outputPath') ?? '');
    if (!output.ok) {
      return this.createErrorResponse(output.reason, PATH_SOLUTIONS);
    }
    const engine = await this.engine();
    if (!engine.ok) {
      return engine.response;
    }

    const debug = readBoolean(args, 'debug') ?? false;
    const exportArgs = [
      '--headless',
      '--path',
      project.value.path,
      debug ? '--export-debug' : '--export-release',
      preset,
      output.absolutePath,
    ];
    this.logDebug(`Exporting: ${engine.value} ${exportArgs.join(' ')}`);

    const log = new GameLog();
    let exitCode = 0;
    try {
      // An export of a real project is slow, so it gets five minutes rather than the default.
      const { stdout, stderr } = await run(engine.value, exportArgs, { timeout: 300000 });
      log.append('stdout', stdout);
      log.append('stderr', stderr);
    } catch (error) {
      if (!(error instanceof Error && 'stdout' in error && 'stderr' in error)) {
        return this.createErrorResponse(`Export could not be run: ${errorMessage(error)}`);
      }
      const failed = error as Error & { stdout: string; stderr: string; code?: number | string };
      log.append('stdout', failed.stdout);
      log.append('stderr', failed.stderr);
      exitCode = typeof failed.code === 'number' ? failed.code : -1;
    }
    log.finish();

    const problems = log.select({ severity: 'warning', sinceLastCall: false, limit: 200 });
    const verdict = {
      exported: exitCode === 0 && log.count('error') === 0 && existsSync(output.absolutePath),
      preset,
      outputPath: output.relativePath,
      debug,
      exitCode,
      errors: log.count('error'),
      warnings: log.count('warning'),
      entries: problems.entries,
    };
    if (!verdict.exported) {
      return {
        content: [
          { type: 'text', text: `Export with preset '${preset}' did not produce ${output.relativePath}.` },
          { type: 'text', text: JSON.stringify(verdict, null, 2) },
        ],
        isError: true,
      };
    }
    return this.jsonTextResponse(verdict);
  }

  /**
   * project_test: gdUnit4's command line runner, driven the way its own runtest script does
   * and read through the JUnit report it writes rather than its console. The class list is
   * rebuilt first because the runner is itself a set of class_names the engine has to resolve,
   * and so is any suite written since the editor last scanned.
   */
  private async handleRunTests(args: OperationParams): Promise<ToolResponse> {
    const project = this.project(args);
    if (!project.ok) {
      return project.response;
    }
    const contained = this.containProjectFiles({ ...args, path: readNonEmptyString(args, 'path') ?? 'test' });
    if (!contained.ok) {
      return contained.response;
    }
    const runner = 'addons/gdUnit4/bin/GdUnitCmdTool.gd';
    if (!existsSync(join(project.value.path, runner))) {
      return this.createErrorResponse(`gdUnit4 is not installed in this project: no ${runner}.`, [
        'Install gdUnit4 under addons/gdUnit4, from https://github.com/godot-gdunit-labs/gdUnit4',
      ]);
    }
    const engine = await this.engine();
    if (!engine.ok) {
      return engine.response;
    }

    const classes = await this.operation('refresh_class_cache', {}, project.value.path);
    if (!classes.ok) {
      return this.answer(classes);
    }

    const reports = 'res://.godot/gdharness-reports';
    const ignored = readStringArray(args, 'ignore') ?? [];
    const cmdArgs = [
      '--headless',
      '--path',
      project.value.path,
      '-s',
      `res://${runner}`,
      '--ignoreHeadlessMode',
      ...(readBoolean(args, 'failFast') === true ? [] : ['-c']),
      '-a',
      readString(contained.value, 'path') ?? 'res://test',
      ...ignored.flatMap((entry) => ['-i', entry]),
      '-rd',
      reports,
      '-rc',
      '1',
    ];
    const timeoutMs = readPositiveNumber(args, 'timeoutMs') ?? 600000;
    this.logDebug(`Running tests: ${engine.value} ${cmdArgs.join(' ')}`);
    const userData = mkdtempSync(join(tmpdir(), 'gdharness-tests-'));
    const run = this.spawnGame(engine.value, cmdArgs, userDataIn(userData));
    const hung = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        run.process.kill();
        resolve(true);
      }, timeoutMs);
      run.process.once('exit', () => {
        clearTimeout(timer);
        resolve(false);
      });
      run.process.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });

    const reportsDir = join(project.value.path, '.godot', 'gdharness-reports');
    let report: TestReport | null = null;
    let reportProblem: string | null = null;
    try {
      const written = existsSync(reportsDir)
        ? readdirSync(reportsDir)
            .filter((name) => name.startsWith('report_'))
            .sort((a, b) => Number(a.slice('report_'.length)) - Number(b.slice('report_'.length)))
        : [];
      const newest = written.at(-1);
      if (newest !== undefined) {
        report = parseJUnit(readFileSync(join(reportsDir, newest, 'results.xml'), 'utf8'));
      }
    } catch (error) {
      reportProblem = errorMessage(error);
    } finally {
      rmSync(reportsDir, { recursive: true, force: true });
      rmSync(userData, { recursive: true, force: true });
    }

    const engineEntries = run.log
      .select({ severity: 'warning', sinceLastCall: false, limit: 200 })
      .entries.map(aboveTheRunner);
    const verdicts: Readonly<Record<number, string>> = {
      0: 'passed',
      100: 'failures',
      101: 'warnings',
      103: 'headless not supported by this gdUnit4',
      104: 'Godot version not supported by this gdUnit4',
      105: 'script errors',
    };
    const exitCode = run.exitCode;
    const verdict = hung
      ? `hung: killed after ${timeoutMs} ms`
      : (verdicts[exitCode ?? -1] ?? `exit ${exitCode ?? 'unknown'}`);

    if (report === null) {
      return {
        content: [
          {
            type: 'text',
            text: `The test run wrote no report (${verdict}${reportProblem ? `; ${reportProblem}` : ''}).`,
          },
          {
            type: 'text',
            text: JSON.stringify(
              {
                exitCode,
                hung,
                arguments: cmdArgs,
                entries: run.log.select({ severity: 'info', sinceLastCall: false, limit: 60 }).entries,
              },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }

    const failed = report.suites.flatMap((suite) =>
      suite.cases
        .filter((entry) => entry.status === 'failed' || entry.status === 'error')
        .map((entry) => ({ ...entry, path: suite.path })),
    );
    // A suite that passed every case has nothing to say that the totals do not, and a whole tier
    // of them is most of the answer: a hundred and three clean suites came back as fifteen
    // kilobytes of names and timings around the one line saying it passed. Counted instead, so the
    // answer is the size of what went wrong.
    const unclean = report.suites.filter(
      (suite) => suite.failures > 0 || suite.errors > 0 || suite.skipped > 0,
    );
    return this.jsonTextResponse({
      passed: !hung && exitCode === 0 && report.failures === 0 && report.errors === 0,
      verdict,
      exitCode,
      tests: report.tests,
      failures: report.failures,
      errors: report.errors,
      skipped: report.skipped,
      time: report.time,
      failed,
      suites: unclean.map((suite) => ({
        name: suite.name,
        path: suite.path,
        tests: suite.tests,
        failures: suite.failures,
        errors: suite.errors,
        skipped: suite.skipped,
        time: suite.time,
      })),
      suitesPassed: report.suites.length - unclean.length,
      engineErrors: run.log.count('error'),
      engineWarnings: run.log.count('warning'),
      engineEntries,
      classes: classes.payload,
    });
  }

  private async godotVersion(godotPath: string): Promise<string | null> {
    try {
      const { stdout } = await run(godotPath, ['--version'], { timeout: 10000 });
      return stdout.trim();
    } catch (error) {
      this.logDebug(`Godot did not answer --version: ${errorMessage(error)}`);
      return null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // script
  // -------------------------------------------------------------------------------------------

  /** script_diagnostics: what the language server reports, and the verdict that follows. */
  private async handleScriptDiagnostics(args: OperationParams): Promise<ToolResponse> {
    const answer = await this.handleLSP('lsp_get_diagnostics', args);
    const payload = asParams(JSON.parse(answer.content[0]?.text ?? '{}'));
    if (payload['error'] !== undefined) {
      const reason = payload['error'];
      return this.createErrorResponse(
        `Diagnostics unavailable: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`,
        [
          `Ensure the Godot editor is running with its language server enabled, on port ${this.editorServes('lspPort', 'GDHARNESS_LSP_PORT', DEFAULT_LSP_PORT)}`,
          'GDHARNESS_LSP_PORT points this server at another one',
        ],
      );
    }

    const diagnostics = readArray(payload, 'diagnostics') ?? [];
    const errors = diagnostics.filter((entry) => {
      const severity = asParams(entry)['severity'];
      return severity === 1 || severity === 'error' || severity === 'ERROR';
    }).length;
    return this.jsonTextResponse({
      scriptPath: readString(args, 'scriptPath'),
      clean: errors === 0,
      errors,
      warnings: diagnostics.length - errors,
      diagnostics,
    });
  }

  private async handleLSP(
    toolName: string,
    args: unknown,
  ): Promise<{ content: { type: string; text: string }[] }> {
    const port = this.editorServes('lspPort', 'GDHARNESS_LSP_PORT', DEFAULT_LSP_PORT);
    if (this.lspClient !== null && this.lspClient.port !== port) {
      await this.lspClient.disconnect();
      this.lspClient = null;
    }
    this.lspClient ??= new GodotLSPClient(port);
    return handleLSPTool(this.lspClient, toolName, args);
  }

  private async handleDAP(
    toolName: string,
    args: unknown,
  ): Promise<{ content: { type: string; text: string }[] }> {
    return handleDAPTool(this.dap(), toolName, args);
  }

  /** The one debug adapter client, which the debug tools and an editor-played game share. */
  private dap(): GodotDAPClient {
    const port = this.editorServes('dapPort', 'GDHARNESS_DAP_PORT', DEFAULT_DAP_PORT);
    if (this.dapClient !== null && this.dapClient.port !== port) {
      // Not disconnected first: the client whose port has moved is one whose editor is gone, so
      // there is nothing on the other end of it to say goodbye to.
      this.dapClient = null;
    }
    this.dapClient ??= new GodotDAPClient(port);
    return this.dapClient;
  }

  /**
   * Which port to talk to: one named on purpose, then the one the connected editor says it serves,
   * then the default.
   *
   * Godot keeps the language server and the debug adapter on one port each for the whole machine,
   * so a second editor is moved off them when this server opens it. Following what the editor
   * reports is what makes that work for an editor this server did not open, and across a harness
   * reconnect, where the assignment was made by a process that is gone.
   */
  private editorServes(field: 'lspPort' | 'dapPort', variable: string, fallback: number): number {
    const named = portFromEnvOrNull(variable);
    if (named !== null) {
      return named;
    }
    const status = this.godotBridge.getStatus();
    return (status.connected ? status[field] : undefined) ?? fallback;
  }

  // -------------------------------------------------------------------------------------------
  // editor
  // -------------------------------------------------------------------------------------------

  private getEditorStatusPayload() {
    const status = this.godotBridge.getStatus();
    const isPortConflict = this.bridgeStartupError?.includes('EADDRINUSE') ?? false;
    // The addon an editor loaded at startup, against the one this server ships. An install
    // replaces the files under a running editor without changing what it is serving, and the
    // only other sign of that is a tool answering as the old version did.
    const stale = status.connected && status.addonVersion !== SERVER_VERSION;
    return {
      ...status,
      serverVersion: SERVER_VERSION,
      addonIsStale: status.connected ? stale : undefined,
      bridgeAvailable: this.bridgeStartupError === null,
      startupError: this.bridgeStartupError,
      staleNote: stale ? addonMismatch(status.addonVersion, SERVER_VERSION) : undefined,
      retryingBridge: this.bridgeRetry === null ? undefined : true,
      // Where the editor was told to look, when this server knows which project to tell. Worth
      // reporting because it is the difference between an editor that cannot find this server
      // and one that has not been restarted: both look like an editor that is not there.
      announcedAt: this.announcedAt ?? undefined,
      // The third version in play. `addonIsStale` catches an editor that has not been restarted;
      // this catches the other way round, a project upgraded while this server kept running, and
      // nothing reported that at all: the answer was that everything was fine.
      projectIs: this.projectHasMovedOn() ?? undefined,
      note: isPortConflict
        ? 'Bridge port is already in use. Another gdharness instance owns the editor bridge, so this server cannot reach the editor. Usually the server this one replaced, still on its way out.'
        : undefined,
      suggestion: isPortConflict
        ? `This server is asking for the port again every ${BRIDGE_RETRY_MS / 1000}s and takes it the moment the other one lets go, so editor tools come back on their own. Ask again, or end the older gdharness process to have it now.`
        : undefined,
    };
  }

  /**
   * What the editor is playing, which is the half this server cannot see for itself.
   *
   * A game started from the editor's own play button belongs to no process here, so without
   * asking, editor_status reports nothing running while a game is on screen. Answered only by
   * an editor holding this version's addon: an older one has no such command, and the staleness
   * in the same payload is what says why the answer is missing.
   */
  private async editorPlayingState(): Promise<{
    playing: boolean;
    scene: string;
    debugPort: number | undefined;
  } | null> {
    const status = this.godotBridge.getStatus();
    if (!status.connected || status.addonVersion !== SERVER_VERSION) {
      return null;
    }
    try {
      const answer = await this.godotBridge.invokeTool('playing_status', {});
      return {
        playing: readBoolean(asParams(answer), 'playing') ?? false,
        scene: readString(asParams(answer), 'scenePath') ?? '',
        debugPort: readNumber(asParams(answer), 'debugPort'),
      };
    } catch {
      // The editor is there but did not answer this one, which the connection fields already
      // describe; a status call is not the place to fail over its own extra question.
      return null;
    }
  }

  /** editor_status: the three things an agent asks before doing anything else, in one answer. */
  private async handleEditorStatus(): Promise<ToolResponse> {
    const godotPath = await this.locator.find();

    // Every announced game is pinged, so a game that announced and then hung is reported as
    // such rather than counted as reachable on the strength of its announcement.
    const games = await Promise.all(
      discoverRuntimes().map(async (endpoint) => {
        const reply = await runtimeRequest(endpoint, 'ping', {}, this.runtimeTimeoutMs());
        return {
          pid: endpoint.pid,
          port: endpoint.port,
          project: endpoint.project,
          reachable: reply.ok,
          problem: reply.ok ? null : reply.message,
        };
      }),
    );

    const playing = await this.editorPlayingState();
    return this.jsonTextResponse({
      editor: {
        ...this.getEditorStatusPayload(),
        // Asked of the editor rather than remembered from when it greeted this server: the
        // debugger takes a port again before every play, so the one in the greeting is a number
        // it has already moved off.
        debugPort: playing?.debugPort ?? this.godotBridge.getStatus().debugPort,
      },
      godot: {
        path: godotPath,
        version: godotPath === null ? null : await this.godotVersion(godotPath),
      },
      game: {
        processActive: this.activeProcess !== null,
        playingInEditor: playing,
        runtimeConnected: games.some((game) => game.reachable),
        runtimes: games,
      },
    });
  }

  /**
   * editor_launch restart: the editor restarts itself, and this waits to see it come back.
   *
   * Installing over a running editor leaves it serving the code it read at startup, so an
   * upgrade is not in effect until somebody restarts it, and the only sign is a tool behaving
   * like the old version. The answer is the version that reconnected rather than the one that
   * was asked for: what matters is which addon the editor is holding now.
   */
  private async handleRestartEditor(): Promise<ToolResponse> {
    const before = this.godotBridge.getStatus();
    if (!before.connected) {
      return this.createErrorResponse('No editor is connected, so there is nothing to restart.', [
        'editor_launch opens one on a project',
        'editor_status says whether the bridge is up and what has reached it',
      ]);
    }

    const asked = await this.handleViaBridge('restart_editor', {});
    if (asked.isError === true) {
      return asked;
    }

    // A connection newer than the one that was there, rather than one that is merely up: the
    // editor that answered is on its way out, and an editor that ignored the request looks
    // exactly like one that came straight back.
    const startedAt = before.connectedAt?.getTime() ?? 0;
    const began = Date.now();
    const back = await this.waitForBridge(() => {
      const status = this.godotBridge.getStatus();
      return status.connected && (status.connectedAt?.getTime() ?? 0) > startedAt;
    }, began + EDITOR_RESTART_TIMEOUT_MS);

    if (!back) {
      return this.createErrorResponse(
        `The editor was asked to restart and has not come back within ${EDITOR_RESTART_TIMEOUT_MS / 1000}s.`,
        [
          'It may be asking what to do about an unsaved scene: look at the editor window',
          'An addon that no longer parses stops the editor reaching this server',
          'editor_status says whether anything has reached the bridge since',
        ],
      );
    }

    const now = this.godotBridge.getStatus();
    return this.jsonTextResponse({
      restarted: true,
      editorPid: now.editorPid,
      addonVersion: now.addonVersion,
      serverVersion: SERVER_VERSION,
      addonIsStale: now.addonVersion !== SERVER_VERSION,
      staleNote: addonMismatch(now.addonVersion, SERVER_VERSION),
      tookMs: Date.now() - began,
    });
  }

  /** Polls until the bridge is in the state asked for, or until the deadline passes. */
  private async waitForBridge(reached: () => boolean, deadline: number): Promise<boolean> {
    for (;;) {
      if (reached()) {
        return true;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await delay(250);
    }
  }

  /**
   * editor_launch: the editor as its own process, detached and with its output dropped. A pipe
   * nobody reads fills up and blocks the editor at the first 64KB it prints, and the editor is
   * meant to outlive this server.
   */
  private async handleLaunchEditor(args: OperationParams): Promise<ToolResponse> {
    const project = this.project(args);
    if (!project.ok) {
      return project.response;
    }
    // One server, one editor: the bridge carries a single connection, and a second editor opened
    // here would be a second project answering on it rather than a second editor to talk to.
    if (this.godotBridge.isConnected()) {
      return this.createErrorResponse('An editor is already connected to this server.', [
        'editor_status says which editor is answering, and for which project',
        'editor_launch restart replaces the connected editor rather than joining it',
        'Another project wants its own gdharness server, which is its own harness session',
      ]);
    }
    const engine = await this.engine();
    if (!engine.ok) {
      return engine.response;
    }
    this.logDebug(`Launching Godot editor for project: ${project.value.path}`);
    const ports = await this.portsForAnEditor();
    // Told rather than left to derive. A game is started by the editor and inherits its
    // environment, not this server's, so an editor opened without TMP or TEMP set announces its
    // games somewhere this server never looks first. Passing the directory down makes the two
    // agree by construction for every editor gdharness opened. The two ports are in the
    // environment as well as on the command line, because the engine keeps what it was told to
    // itself: this is how the addon knows what to write into the settings a restart reads.
    const editor = spawn(engine.value, editorArguments(project.value.path, ports), {
      stdio: 'ignore',
      detached: true,
      env: {
        ...process.env,
        GDHARNESS_RUNTIME_DIR: runtimeDirectory(),
        GDHARNESS_LSP_PORT: String(ports.lsp),
        GDHARNESS_DAP_PORT: String(ports.dap),
      },
    });
    const started = await new Promise<string | null>((resolve) => {
      editor.once('spawn', () => {
        resolve(null);
      });
      editor.once('error', (error: Error) => {
        resolve(error.message);
      });
    });
    if (started !== null) {
      return this.createErrorResponse(`Could not start the editor: ${started}`);
    }
    editor.unref();
    return this.jsonTextResponse({
      launched: true,
      pid: editor.pid ?? null,
      projectPath: project.value.path,
      lspPort: ports.lsp,
      dapPort: ports.dap,
    });
  }

  /**
   * The ports to open an editor on: the defaults whenever they are free, and anything else when
   * they are not.
   *
   * Godot serves the language server and the debug adapter on one port each for the whole machine,
   * so the second editor open binds neither and every script and debug tool behind it is answered
   * by the first editor, about a different project. A port named in the environment is somebody's
   * decision and is passed on rather than moved.
   */
  private async portsForAnEditor(): Promise<EditorPorts> {
    const lsp = portFromEnvOrNull('GDHARNESS_LSP_PORT') ?? (await freePort(DEFAULT_LSP_PORT));
    const dap = portFromEnvOrNull('GDHARNESS_DAP_PORT') ?? (await freePort(DEFAULT_DAP_PORT));
    return { lsp, dap };
  }

  private async handleRunProject(args: OperationParams, op: string): Promise<ToolResponse> {
    const project = this.project(args);
    if (!project.ok) {
      return project.response;
    }
    // Before the engine is looked for, so that a scene the server will not run is refused as
    // such rather than as a missing Godot.
    const scene = readNonEmptyString(args, 'scene');
    const sceneToRun = scene !== undefined ? resolveWithinProject(project.value.path, scene) : null;
    if (sceneToRun && !sceneToRun.ok) {
      return this.createErrorResponse(sceneToRun.reason, PATH_SOLUTIONS);
    }
    // Asked to run a project with no main scene, the engine puts up a modal box and waits for
    // a click, even headless on Windows: a process on a pipe that never exits.
    if (!sceneToRun && !hasMainScene(project.value.file)) {
      return this.createErrorResponse('The project sets no main scene, so there is nothing to run.', [
        'Pass scene to run one scene',
        'Choose the main scene with project_settings set_main_scene',
      ]);
    }
    const engine = await this.engine();
    if (!engine.ok) {
      return engine.response;
    }

    // The engine fixes its list of global classes when it starts and the editor writes that
    // list back over the cache, so a game launched after a `class_name` was written dies at its
    // first screen on "Could not find type". Rebuilt here from the declarations on disk rather
    // than reported: the caller asked for a game, and this is what it takes to have one.
    const refreshed = await this.refreshStaleClasses(project.value.path);
    if (!refreshed.ok) {
      return refreshed.response;
    }

    const sceneArgument = sceneToRun?.ok ? sceneToRun.relativePath : null;
    if (op === 'check') {
      return await this.checkBoot(engine.value, project.value.path, sceneArgument, args);
    }

    if (this.activeProcess) {
      this.logDebug('Ending the running game before starting another');
      await this.endActiveGame();
    }

    // The editor when it is there: a game it plays is a game its debugger is holding, and that
    // session is the only thing the debug tools can reach. A game started here as its own
    // process is invisible to them, whatever port they are pointed at.
    //
    // A headless run goes through the editor only when the project's own run arguments say the
    // editor would play it headless too. Otherwise it is spawned: answering a request for no
    // window with a window would be answering a different question.
    const headless = resolveHeadless(args['headless'], {
      platform: process.platform,
      variables: process.env,
    });
    if (this.godotBridge.isConnected() && (!headless || editorPlaysHeadless(project.value.file))) {
      return await this.playThroughEditor(sceneArgument, refreshed.value);
    }

    const cmdArgs = runArguments({
      projectPath: project.value.path,
      headless,
      scene: sceneArgument,
    });
    this.logDebug(`Running Godot project: ${engine.value} ${cmdArgs.join(' ')}`);
    const started = this.spawnGame(engine.value, cmdArgs);
    this.activeProcess = started;
    started.process.on('exit', () => {
      if (this.activeProcess === started) {
        this.activeProcess = null;
      }
    });
    return this.jsonTextResponse({
      started: true,
      through: 'gdharness',
      pid: started.process.pid ?? null,
      arguments: cmdArgs,
      refreshedClasses: refreshed.value,
      message: 'Use editor_output for what it prints and editor_run stop to end it.',
    });
  }

  /**
   * The editor plays the game, and the debug adapter is connected first so nothing is missed.
   *
   * The adapter is where an editor-played game's console comes from: there is no pipe to read,
   * and the editor's own Output dock is not something a server can see. Connecting before the
   * game starts is what puts its first lines in the log rather than losing them, and the
   * breakpoints a caller set earlier are already registered by then.
   */
  private async playThroughEditor(
    scene: string | null,
    refreshedClasses: readonly string[],
  ): Promise<ToolResponse> {
    const log = new GameLog();
    try {
      await this.dap().connect();
    } catch (error) {
      return this.createErrorResponse(
        `The editor is connected but its debug adapter is not: ${errorMessage(error)}`,
        [
          `This asked on port ${this.dap().port}, which is where the connected editor says it serves`,
          'GDHARNESS_DAP_PORT points this server at another one',
        ],
      );
    }

    const answer = await this.handleViaBridge(
      'play_scene',
      scene === null ? {} : { scenePath: `res://${scene}` },
    );
    if (answer.isError === true) {
      return answer;
    }

    const played: GodotProcess = {
      process: null,
      log,
      startedAt: Date.now(),
      exitCode: null,
      throughEditor: true,
      brokeOn: null,
    };
    this.activeProcess = played;

    return this.jsonTextResponse({
      started: true,
      through: 'editor',
      scene: scene === null ? 'the main scene' : `res://${scene}`,
      refreshedClasses,
      // Which port the editor's debugger took, since it is the one port Godot has no command
      // line option for and the addon moves itself off when another editor is holding it.
      debugPort: readNumber(asParams(JSON.parse(answer.content[0]?.text ?? '{}')), 'debugPort'),
      message:
        'The editor is playing it, so its debugger holds it: the debug_* tools can reach it, ' +
        'editor_output reads its console through the debug adapter, and editor_run stop ends it.',
    });
  }

  /**
   * Moves what the debug adapter has heard into the game's log.
   *
   * Pulled when somebody asks rather than pushed as it arrives, so the one buffer the adapter
   * keeps is read in order and nothing is counted twice. A game this server spawned has a pipe
   * instead and nothing to drain.
   */
  private drainEditorOutput(game: GodotProcess): void {
    if (!game.throughEditor || !this.dapClient) {
      return;
    }
    for (const line of this.dapClient.getOutput(true)) {
      game.log.append('stdout', line.endsWith('\n') ? line : `${line}\n`);
    }
    this.recordWhatItBrokeOn(game);
  }

  /**
   * The error the editor broke the game on, written into the log the way a printed one would be.
   *
   * Godot prints none of it. It halts the game and names the error in the `stopped` event alone,
   * so a log built from what the adapter printed held no trace of it: a game sitting dead at a
   * script error counted zero errors and answered `clean`, while every runtime call against it
   * timed out with nothing anywhere saying why. Measured against a real editor, where a save
   * carrying one bad field broke the game on load and editor_output reported a clean run.
   */
  private recordWhatItBrokeOn(game: GodotProcess): void {
    const halt = this.dapClient?.whereItStopped() ?? null;
    if (halt?.reason !== 'exception' || halt.text === '' || game.brokeOn === halt.text) {
      return;
    }
    game.brokeOn = halt.text;
    game.log.record('error', halt.text);
  }

  /** Ends whatever is running, whichever way it was started. */
  private async endActiveGame(): Promise<void> {
    const running = this.activeProcess;
    this.activeProcess = null;
    if (!running) {
      return;
    }
    if (running.throughEditor) {
      await this.handleViaBridge('stop_playing', {});
      return;
    }
    running.process?.kill();
  }

  /** The engine as a child process, with everything it prints read into a log as it comes. */
  private spawnGame(godotPath: string, cmdArgs: string[], env?: NodeJS.ProcessEnv): SpawnedGame {
    const child = spawn(godotPath, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) });
    const log = new GameLog();
    const started: SpawnedGame = {
      process: child,
      log,
      startedAt: Date.now(),
      exitCode: null,
      throughEditor: false,
      brokeOn: null,
    };
    child.stdout.on('data', (data: Buffer) => {
      log.append('stdout', data);
    });
    child.stderr.on('data', (data: Buffer) => {
      log.append('stderr', data);
    });
    child.on('exit', (code: number | null) => {
      this.logDebug(`Godot process exited with code ${code ?? 'none'}`);
      log.finish();
      started.exitCode = code ?? -1;
    });
    child.on('error', (err: Error) => {
      console.error('Failed to start Godot process:', err);
      log.append('stderr', `${err.message}\n`);
      started.exitCode = -1;
    });
    return started;
  }

  /**
   * editor_run check: the project booted headless and left to quit after a few frames, which
   * is what a commit gate does by hand. A project that will not quit is killed and reported as
   * hung rather than waited on forever.
   */
  private async checkBoot(
    godotPath: string,
    projectPath: string,
    scene: string | null,
    args: OperationParams,
  ): Promise<ToolResponse> {
    const frames = readPositiveNumber(args, 'frames') ?? 3;
    const timeoutMs = readPositiveNumber(args, 'timeoutMs') ?? 60000;
    const cmdArgs = runArguments({ projectPath, headless: true, scene, quitAfter: frames });
    const boot = this.spawnGame(godotPath, cmdArgs);

    const hung = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        boot.process.kill();
        resolve(true);
      }, timeoutMs);
      boot.process.once('exit', () => {
        clearTimeout(timer);
        resolve(false);
      });
      boot.process.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });

    const errors = boot.log.count('error');
    const warnings = boot.log.count('warning');
    return this.jsonTextResponse({
      booted: !hung && boot.exitCode === 0 && errors === 0,
      hung,
      exitCode: boot.exitCode,
      durationMs: Date.now() - boot.startedAt,
      frames,
      errors,
      warnings,
      entries: boot.log.select({ severity: 'warning', sinceLastCall: false, limit: 200 }).entries,
    });
  }

  /** editor_output: the log as entries, filtered the way the caller asked. */
  private handleGetDebugOutput(args: OperationParams): ToolResponse {
    if (!this.activeProcess) {
      return this.createErrorResponse('No game is running. Start one with editor_run.');
    }
    this.drainEditorOutput(this.activeProcess);
    const severity = readString(args, 'severity');
    const selected = this.activeProcess.log.select({
      severity: severity === 'error' || severity === 'warning' ? severity : 'info',
      sinceLastCall: readBoolean(args, 'sinceLastCall') ?? false,
      contains: readNonEmptyString(args, 'contains'),
      limit: readPositiveNumber(args, 'limit') ?? 200,
    });
    // A game held at a breakpoint is running in the sense the process is alive and in no sense
    // that matters to a caller: it draws nothing, answers no runtime call, and the timeouts that
    // follow read like a hung engine. Said here because this is where somebody asks what it did.
    const halt = this.activeProcess.throughEditor ? (this.dapClient?.whereItStopped() ?? null) : null;
    return this.jsonTextResponse({
      running: this.activeProcess.exitCode === null,
      exitCode: this.activeProcess.exitCode,
      through: this.activeProcess.throughEditor ? 'editor' : 'gdharness',
      pid: this.activeProcess.process?.pid ?? null,
      errors: this.activeProcess.log.count('error'),
      warnings: this.activeProcess.log.count('warning'),
      clean: this.activeProcess.log.count('error') === 0,
      heldAt: halt,
      omitted: selected.omitted,
      entries: selected.entries,
    });
  }

  /** editor_run stop: the game is ended and its verdict answered, errors and warnings kept. */
  private async handleStopProject(): Promise<ToolResponse> {
    if (!this.activeProcess) {
      return this.createErrorResponse('No game is running. Start one with editor_run.');
    }
    const stopped = this.activeProcess;
    this.drainEditorOutput(stopped);
    this.logDebug('Stopping the running game');
    await this.endActiveGame();
    return this.jsonTextResponse({
      stopped: true,
      through: stopped.throughEditor ? 'editor' : 'gdharness',
      exitedBeforeStop: stopped.exitCode !== null,
      exitCode: stopped.exitCode,
      errors: stopped.log.count('error'),
      warnings: stopped.log.count('warning'),
      clean: stopped.log.count('error') === 0,
      entries: stopped.log.select({ severity: 'warning', sinceLastCall: false, limit: 200 }).entries,
    });
  }

  /**
   * editor_rescan: the scan started, then waited for. The waiting is here rather than in the
   * addon because the editor-side tool executor takes a Dictionary back and not a coroutine,
   * so the addon can only start the scan and report whether one is running. A caller that has
   * just written a script needs the scan to have landed before the new class_name resolves.
   */
  private async handleRescanFilesystem(args: OperationParams): Promise<ToolResponse> {
    const timeoutMs = readPositiveNumber(args, 'timeoutMs') ?? 30000;
    const started = Date.now();

    const first = await this.handleViaBridge('rescan_filesystem', args);
    if (first.isError) {
      return first;
    }

    let busy = true;
    while (busy && Date.now() - started < timeoutMs) {
      await new Promise((settle) => setTimeout(settle, 100));
      const status = asParams(
        await this.godotBridge.invokeTool('rescan_filesystem', { ...args, statusOnly: true }),
      );
      busy = Boolean(status['scanning']) || Boolean(status['importing']);
    }

    return this.jsonTextResponse({
      ok: !busy,
      stillWorking: busy,
      waitedMs: Date.now() - started,
      note: busy
        ? 'The editor was still scanning or importing when the wait ran out, so new files may not be visible yet.'
        : undefined,
    });
  }

  private async handleViaBridge(toolName: string, args: OperationParams): Promise<ToolResponse> {
    if (!this.godotBridge.isConnected()) {
      return this.createErrorResponse(
        'Editor not connected: no Godot editor with the gdharness editor addon has reached this server.',
        [
          'Open the project in the editor with editor_launch, or by hand',
          'Enable the addon under Project > Project Settings > Plugins',
          'editor_status says whether the bridge is up and what it is listening on',
        ],
      );
    }
    try {
      return this.jsonTextResponse(await this.godotBridge.invokeTool(toolName, args));
    } catch (error) {
      return this.createErrorResponse(
        `The editor answered ${toolName} with an error: ${errorMessage(error)}`,
      );
    }
  }

  // -------------------------------------------------------------------------------------------
  // runtime
  // -------------------------------------------------------------------------------------------

  /** How long one runtime request may take. Ten seconds, unless the environment says otherwise. */
  private runtimeTimeoutMs(): number {
    const override = Number.parseInt(envValue('GDHARNESS_RUNTIME_TIMEOUT_MS') ?? '', 10);
    return Number.isInteger(override) && override > 0 ? override : 10000;
  }

  /**
   * One command to the running game, and its answer as a tool result.
   *
   * `op` and `projectPath` are the server's business and stay here: the first chose the
   * command, the second chooses the game when more than one is running. A capture is answered
   * through a file the server names, so a game cannot point the reader at a path of its own
   * choosing, and the file is gone again before the image is returned.
   */
  private async handleRuntimeCommand(
    command: string,
    args: unknown,
    timeoutMs: number = this.runtimeTimeoutMs(),
  ): Promise<ToolResponse> {
    const { op: _op, projectPath, ...params } = asParams(args);
    const announced = runtimesAnnounced();
    // A server set up for a project answers about that project's game and no other. Two
    // projects open in two harness sessions are two games announced on the same machine, and
    // without this the second one to start is a game this server would talk to as readily as
    // its own, with nothing in the answer saying which it reached.
    const choice = chooseRuntime(
      announced.running,
      typeof projectPath === 'string' ? projectPath : (this.ownProject ?? undefined),
      announced.unspoken,
    );
    if ('problem' in choice) {
      return this.createErrorResponse(choice.problem);
    }

    const expectsScreenshot = command === 'capture_screenshot' || command === 'capture_viewport';
    const screenshotDir = expectsScreenshot
      ? mkdtempSync(join(tmpdir(), 'gdharness-runtime-screenshot-'))
      : null;
    const screenshotPath = screenshotDir ? join(screenshotDir, 'capture.png') : null;
    try {
      const reply = await runtimeRequest(
        choice.endpoint,
        command,
        screenshotPath ? { ...params, output_path: screenshotPath } : params,
        timeoutMs,
      );
      if (!reply.ok) {
        return this.createErrorResponse(reply.message);
      }

      const { id: _id, ...payload } = reply.payload;
      if (!expectsScreenshot) {
        return this.jsonTextResponse(payload);
      }

      const returnedPath = readString(payload, 'path');
      if (readString(payload, 'type') !== 'screenshot_file' || !returnedPath || !screenshotPath) {
        return this.createErrorResponse(`The game answered a capture with ${JSON.stringify(payload)}`);
      }
      if (normalize(returnedPath) !== normalize(screenshotPath)) {
        return this.createErrorResponse(
          `Rejected screenshot file path outside the managed capture path: '${returnedPath}'`,
        );
      }
      const dimensions = `${readNumber(payload, 'width') ?? 0}x${readNumber(payload, 'height') ?? 0} ${
        readString(payload, 'format') ?? 'unknown'
      }`;
      return {
        content: [
          { type: 'text', text: `Screenshot captured: ${dimensions}` },
          { type: 'image', data: readFileSync(screenshotPath).toString('base64'), mimeType: 'image/png' },
        ],
      };
    } finally {
      if (screenshotDir) {
        rmSync(screenshotDir, { recursive: true, force: true });
      }
    }
  }

  /** runtime_inspect find: only the filters that were given are sent, so the game decides. */
  private async handleFindRuntimeNodes(args: OperationParams): Promise<ToolResponse> {
    const filters: Record<string, unknown> = {};
    const className = readNonEmptyString(args, 'className');
    const script = readNonEmptyString(args, 'script');
    const namePattern = readNonEmptyString(args, 'namePattern');
    const group = readNonEmptyString(args, 'group');
    const says = readNonEmptyString(args, 'says');
    if (className !== undefined) filters['class'] = className;
    if (script !== undefined) filters['script'] = script;
    if (namePattern !== undefined) filters['name'] = namePattern;
    if (group !== undefined) filters['group'] = group;
    if (says !== undefined) filters['says'] = says;
    if (Object.keys(filters).length === 0) {
      return this.createErrorResponse(
        'runtime_inspect find needs at least one of className, script, namePattern, group, says.',
      );
    }
    // One property off every node found, when the caller names one. A panel of a dozen labels is
    // one question and was a dozen calls: find the labels, then read each one, by which time the
    // panel had been rebuilt and half the paths were gone.
    const property = readNonEmptyString(args, 'property');
    return await this.handleRuntimeCommand('find_nodes', {
      ...filters,
      projectPath: args['projectPath'],
      root: readNonEmptyString(args, 'nodePath') ?? '/root',
      limit: readPositiveNumber(args, 'limit') ?? 100,
      ...(property === undefined ? {} : { property }),
    });
  }

  /**
   * runtime_wait: the game is given as long as the wait asks for, and a little longer for the
   * answer to travel, before it is called busy.
   */
  private async handleRuntimeWait(op: string, args: OperationParams): Promise<ToolResponse> {
    if (op === 'frames') {
      const frames = readPositiveNumber(args, 'frames') ?? 1;
      // Long enough for the frames themselves, which the flat patience is not: 600 frames is ten
      // seconds at sixty a second and the answer arrived as the call gave up on it, twice in one
      // session. Counted at a rate no game running at all falls under, because a game busy enough
      // to be worth waiting on is exactly the one drawing slowly. Off the standing patience rather
      // than off `timeoutMs`, which this op does not take: how long a run of frames is worth
      // waiting for is the count, and a second knob on it is one nobody could set correctly.
      const waited = patienceForFrames(frames, this.runtimeTimeoutMs());
      return await this.handleRuntimeCommand(
        'wait_frames',
        { projectPath: args['projectPath'], frames },
        waited,
      );
    }

    const timeoutMs = readPositiveNumber(args, 'timeoutMs') ?? 5000;
    const nodePath = readNonEmptyString(args, 'nodePath') ?? '';
    const patience = Math.max(this.runtimeTimeoutMs(), timeoutMs + 5000);
    return op === 'signal'
      ? await this.handleRuntimeCommand(
          'wait_signal',
          {
            projectPath: args['projectPath'],
            path: nodePath,
            signal: readString(args, 'signal') ?? '',
            timeout_ms: timeoutMs,
          },
          patience,
        )
      : await this.handleRuntimeCommand(
          'wait_until',
          {
            projectPath: args['projectPath'],
            path: nodePath,
            property: readString(args, 'property') ?? '',
            value: args['value'],
            // Only when asked for, so a caller waiting on a property is not also asking about
            // words: the game reads whichever of the two it was given and refuses neither.
            ...(readNonEmptyString(args, 'says') === undefined
              ? {}
              : { says: readNonEmptyString(args, 'says') }),
            timeout_ms: timeoutMs,
          },
          patience,
        );
  }
}

export async function runGodotServer(): Promise<void> {
  const server = new GodotServer();
  await server.run();
}
