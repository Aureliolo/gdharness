/**
 * The MCP server: one tool call in, one answer out.
 *
 * Every tool is answered by one of four things. A headless operation runs the engine on the
 * project with the operations script and answers with its JSON; the editor addon answers over
 * the bridge; a running game answers over the runtime socket; and a few are answered here, by
 * reading the project directory or driving a game process. Which is which is decided in
 * `dispatch`, and the arguments have been checked against the tool's spec before it is reached.
 */

import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
} from 'node:fs';
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
import { staleClassNames, type UnseenClass, unseenByEditor } from './class-cache.js';
import { DEFAULT_DAP_PORT, GodotDAPClient, handleDAPTool, type StoppedAt } from './dap_client.js';
import { dictionary, emptyRecord } from './dictionary.js';
import { errorMessage, Refusal } from './errors.js';
import { forAnswer, GameLog, type LogEntry } from './game-log.js';
import { type GodotBridge, getDefaultBridge, mayYetConnect } from './godot-bridge.js';
import { GodotLocator } from './godot-path.js';
import { type HeadlessOutcome, runOperation } from './headless.js';
import { HEADLESS_OPERATIONS } from './headless-operations.js';
import { defectReport, feedbackNotice } from './issues.js';
import { orphansPrinted, parseJUnit, type TestReport, whyNoReport } from './junit.js';
import {
  type EditorPorts,
  editorArguments,
  envValue,
  OPENED_BY_A_SERVER,
  resolveHeadless,
  runArguments,
  userDataIn,
} from './launch.js';
import { DEFAULT_LSP_PORT, GodotLSPClient, handleLSPTool } from './lsp_client.js';
import { resolveWithinProject } from './paths.js';
import { freePort, portFromEnvOrNull } from './ports.js';
import { cpuSecondsOf } from './process-time.js';
import { projectStructure, searchProject } from './project-scan.js';
import { parseProjectGodot, setupResourceHandlers } from './resources.js';
import {
  clearRunRecord,
  couldStillBeTheRecordedRun,
  openTranscript,
  readRunRecord,
  recordRunEnded,
  stillTheRecordedRun,
  sweepTranscripts,
  writeRunRecord,
} from './run-record.js';
import {
  ANNOUNCE_BUDGET_MS,
  announcedSince,
  chooseRuntime,
  discoverRuntimes,
  type RuntimeEndpoint,
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
import {
  addonMismatch,
  DEBUG_MODE,
  GODOT_DEBUG_MODE_DEFAULT,
  markIfStale,
  SERVER_VERSION,
} from './server-version.js';
import { installedAddonVersion, RUNTIME_AUTOLOAD } from './setup.js';
import {
  asParams,
  readArray,
  readBoolean,
  readNonEmptyString,
  readNonNegativeNumber,
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

/**
 * Whether a process is still running, which is asked of two things this server is waiting on: a
 * server that may have replaced it, and an editor that was asked to go.
 *
 * Undefined reads as gone, because a caller that has no process to name has nothing to wait for.
 */
/**
 * Whether a run is still going.
 *
 * Three states rather than two: going, finished with a code somebody collected, and found already
 * over with no code anywhere because no server was waiting on it. Only the first is running, and
 * the third must never read as the second.
 */
function stillRunning(run: GodotProcess | null): boolean {
  if (run?.exitCode !== null || run.endedUnwatched === true) {
    return false;
  }
  // A run with no handle is one this server did not start, so nothing here is listening for it to
  // exit. Asked of the operating system on every answer rather than remembered from the moment it
  // was picked up, or a bench that finished an hour ago goes on being reported as running and
  // whoever is polling for it to end never hears that it has.
  if (!run.throughEditor && run.process === null && run.pid !== null) {
    return alive(run.pid);
  }
  return true;
}

/**
 * Whether a run is still up, taking the editor's word for the runs it is playing.
 *
 * A run this server spawned has a process to ask the operating system about. A run the editor
 * plays has none: there is no handle here, `exitCode` stays null for as long as the record lasts,
 * and reading that as "still going" turns a game that died during boot into one that may yet
 * announce, which is the answer this was written to stop giving. The editor knows, and is already
 * asked this by `editor_status`. [param editorSays] is null when it will not say, and then the
 * record is what is left.
 */
export function runIsUp(run: GodotProcess | null, editorSays: boolean | null): boolean {
  if (run?.throughEditor !== true) {
    return stillRunning(run);
  }
  return editorSays ?? stillRunning(run);
}

/** What was true when the wait for an announcement ran out. */
interface AfterWaiting {
  /** Whether the addon is on disk at all, since a project without it can never announce. */
  readonly addon: boolean;
  readonly budgetMs: number;
  readonly heldAt: StoppedAt | null;
  readonly running: boolean;
}

/**
 * What a start says about the runtime it waited for.
 *
 * `listening: false` is four situations, and three of them are not "there is no runtime". A
 * project that boots slower than the budget was told the same thing as a project with no addon
 * installed, so the honest answer, one more call, looked like the hopeless one. `mayYetAnnounce`
 * is the field that separates them: false is final, true means ask again rather than give up.
 */
export function runtimeVerdict(
  endpoint: RuntimeEndpoint | null,
  after: AfterWaiting,
): Record<string, unknown> {
  if (endpoint !== null) {
    return { listening: true, pid: endpoint.pid, port: endpoint.port };
  }
  if (!after.addon) {
    return {
      listening: false,
      mayYetAnnounce: false,
      note: 'this project has no gdharness_runtime addon, so the runtime_* tools have nothing to talk to',
    };
  }
  if (after.heldAt !== null) {
    return {
      listening: false,
      mayYetAnnounce: true,
      note: 'the game stopped before its runtime came up, so the runtime_* tools have nothing to talk to yet: debug_control continue lets it carry on',
      heldAt: after.heldAt,
    };
  }
  return {
    listening: false,
    mayYetAnnounce: after.running,
    note: after.running
      ? `nothing announced itself within ${after.budgetMs}ms and the game is still running, so it may announce a moment from now: editor_status says whether it has, and editor_run start takes runtimeWaitMs to wait longer than this`
      : `nothing announced itself within ${after.budgetMs}ms and the game is no longer running, so nothing is going to: editor_output has what it printed on the way down`,
    heldAt: null,
  };
}

export function alive(pid: number | undefined | null): boolean {
  if (pid === undefined || pid === null) {
    return false;
  }
  try {
    // Signal 0 asks whether it could be signalled rather than signalling it.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is a process that is there and is somebody else's, which is still there. Only ESRCH
    // says there is nothing under that number, and reading the two the same way reports a run
    // started by another user as one that has ended.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
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
/**
 * How long `editor_run wait` waits by default, and how often it looks.
 *
 * The budget matches `project_test`, because the run being waited on is the same kind of thing: a
 * bench or a suite that takes minutes. The interval is what the caller's own shell loops used, and
 * is cheap because looking is a liveness check on a pid rather than anything that touches the game.
 */
const WAIT_FOR_RUN_MS = 600_000;
const RUN_POLL_MS = 250;

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
export const PROJECT_FILE_ARGUMENTS = [
  'scenePath',
  'scriptPath',
  'resourcePath',
  'newPath',
  'path',
  'script',
];

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

/**
 * Whether two paths name the same directory, symlinks, drive letters and trailing slashes aside.
 *
 * The editor announces where it is open as the engine globalises it, which is not spelled the way
 * a caller spells the same directory: a trailing slash on one side, a different case on the drive
 * letter on Windows, a symlinked temporary directory on macOS.
 */
function samePath(one: string, other: string): boolean {
  const settled = (path: string): string =>
    realPathOr(path).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  return settled(one) === settled(other);
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

/**
 * Where a run that found nothing might have meant instead, as a sentence, or nothing to add.
 *
 * A test path that is not there is usually one letter off one that is: `test` against `tests` is
 * the whole of what this tool's default and the plural convention disagree about, and the caller
 * who met it read a clean exit as a green tier. Only directories that are actually there are
 * named, and only when the one asked for is not, so a project whose suites are simply empty is
 * never told where else to look.
 */
function elsewhereIn(projectPath: string, asked: string): string {
  const wanted = asked.replace(/^res:\/\//, '').replace(/\/+$/, '');
  if (wanted === '' || existsSync(join(projectPath, wanted))) {
    return '';
  }
  const root = (wanted.split('/')[0] ?? '').toLowerCase();
  let near: string[] = [];
  try {
    near = readdirSync(projectPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase() !== root)
      .map((entry) => entry.name)
      .filter((name) => name.toLowerCase().startsWith('test') || root.startsWith(name.toLowerCase()));
  } catch {
    return '';
  }
  const there = near.map((name) => `res://${name}`).join(' and ');
  return near.length === 0 ? '' : ` The project does have ${there}.`;
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
    return alive(announced.pid) ? announced.pid : null;
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
    // The run is left running. It is spawned detached and its output goes to a file precisely so
    // that this server going away is not the end of it: the harness restarts this process on its
    // own schedule, and killing the game here would be this server doing by hand exactly what
    // detaching was for. A game the editor plays is the editor's to end and was never killed
    // here anyway. The note on disk is what the next server picks it back up by, and
    // `editor_run stop` is what ends it.
    this.activeProcess = null;
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
    // Nothing left to do here. 'exit' runs synchronously and the process is gone the moment this
    // returns, so killing the game was the only thing that could still happen; it no longer
    // should, for the reason cleanup() gives. The bridge's close is a promise that would never
    // settle, and the sockets go with the process anyway.
    this.activeProcess = null;
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
      // A tool that takes nothing read "It takes: ." and left the caller to work out whether the
      // list was missing or empty. editor_status is one of them, and it is the tool a session calls
      // first, so it is the first refusal anybody sees.
      //
      // Named for the op when one was asked for, because a tool's whole argument list answers a
      // question nobody asked: a caller who wrote `get` wants to know what `get` takes, not the
      // twenty arguments the other ten ops between them accept.
      const asked = readString(args, 'op');
      const named = asked !== undefined && spec.operations?.[asked] !== undefined ? asked : null;
      const wanted = named === null ? [...known] : [...argumentsOf(spec, named), 'op'];
      const takes = wanted.length === 0 ? 'It takes no arguments.' : `It takes: ${wanted.join(', ')}.`;
      // And the version, because "this tool has no such argument" and "the server you are talking
      // to does not have it yet" are the same sentence, and a server left running through an
      // upgrade says the second while sounding like the first. Without it the caller spends two
      // more calls working out which, and the answer only arrives when something else mentions the
      // version in passing.
      const where = named === null ? spec.name : `${spec.name} ${named}`;
      return {
        ok: false,
        response: this.createErrorResponse(
          `${where} does not take ${unknown.join(', ')}. ${takes} This is gdharness ${SERVER_VERSION}, which is what decides whether an argument exists.`,
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
      const answered = await this.headless(headless, args);
      // The one answer that reads most like a clean bill of health and is not: "added: []" means
      // the file on disk was already right, which is exactly the state an editor goes blind in.
      return headless === 'refresh_class_cache' && this.godotBridge.isConnected()
        ? await this.alsoSayWhatTheEditorCannotSee(answered, args)
        : answered;
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
        if (op === 'stop') {
          return await this.handleStopProject();
        }
        if (op === 'wait') {
          return await this.handleWaitForRun(args);
        }
        return await this.handleRunProject(args, op);
      case 'editor_output':
        return await this.handleGetDebugOutput(args);
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

  /** What the game itself is to be handed, or the refusal saying why this list cannot be. */
  private gameArguments(args: OperationParams): Checked<readonly string[]> {
    if (args['args'] === undefined) {
      return { ok: true, value: [] };
    }
    const given = readStringArray(args, 'args');
    if (given === undefined) {
      return {
        ok: false,
        response: this.createErrorResponse('args must be a list of strings.', [
          'Pass the game\'s own flags, such as ["--level=2"]',
        ]),
      };
    }
    return { ok: true, value: given };
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
    // A finished run is kept so its output can still be read, and a readable log is not a debug
    // session. Said apart from "nothing is running", because the two are answered by different
    // things: one wants a run started, the other has its answer waiting in editor_output.
    if (game !== null && game.exitCode !== null) {
      return {
        ok: false,
        response: this.createErrorResponse(
          `The last run has already finished (exit code ${game.exitCode}), so there is no debug session to answer for.`,
          [
            'editor_output still reads what it printed, until the next run starts',
            'editor_run start plays another, which the debugger can hold',
          ],
        ),
      };
    }
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

    // Godot's command-line exporter does not create the directory it is told to write into, where
    // the editor's own export dialog does, and what it says when it is missing is "The given export
    // path doesn't exist", which reads as a wrong path in the preset and sends the caller to check
    // the preset. The tool was handed the path and has already contained it inside the project, so
    // it knows exactly which directory it is about to need. Reported for the first export of two
    // separate projects, each of which lost the same five minutes to the same message.
    const folder = dirname(output.absolutePath);
    try {
      mkdirSync(folder, { recursive: true });
    } catch (error) {
      return this.createErrorResponse(
        `Cannot create ${dirname(output.relativePath)} to export into: ${errorMessage(error)}`,
      );
    }

    const debug = readBoolean(args, 'debug') ?? false;
    // Away from the project's own user://logs/, for the reason the operations are: the engine
    // renames that file when a process starts, so an export beside a running game rotated the
    // game's log out from under it. What this run printed is read off its streams just below and
    // answered with, so the file it writes is of no use to anybody either.
    const exportLogs = mkdtempSync(join(tmpdir(), 'gdharness-export-'));
    const exportArgs = [
      '--headless',
      '--log-file',
      join(exportLogs, 'engine.log'),
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
    } finally {
      rmSync(exportLogs, { recursive: true, force: true });
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
      entries: forAnswer(problems.entries),
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

    // Under a name of this run's own. The directory is a path in the project rather than in this
    // process, so a second run against the same project wrote its report_1 beside the first's,
    // and the reading below takes the highest-numbered one it finds: whichever run finished first
    // read the other's results as its own and then removed the lot, leaving the run still going
    // with nothing to report. A project is allowed more than one thing happening to it at once.
    const ours = `gdharness-reports/${randomUUID()}`;
    const reports = `res://.godot/${ours}`;
    const ignored = readStringArray(args, 'ignore') ?? [];
    const asked = readString(contained.value, 'path') ?? 'res://test';
    const cmdArgs = [
      '--headless',
      '--path',
      project.value.path,
      '-s',
      `res://${runner}`,
      '--ignoreHeadlessMode',
      ...(readBoolean(args, 'failFast') === true ? [] : ['-c']),
      '-a',
      asked,
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

    const reportsDir = join(project.value.path, '.godot', ...ours.split('/'));
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
      // Named rather than left as the bare word: with no errors and no failures, gdUnit4 reaches
      // this state for orphan nodes and nothing else, and "warnings" on its own sent a session
      // guessing and re-running a tier that takes minutes to find out which kind it meant.
      101: 'warnings: orphan nodes',
      103: 'headless not supported by this gdUnit4',
      104: 'Godot version not supported by this gdUnit4',
      105: 'script errors',
    };
    const exitCode = run.exitCode;
    const printed = run.log.select({ severity: 'info', sinceLastCall: false, limit: 200 }).entries;
    // Before the exit code, because gdUnit4 leaves it at zero for a run that found nothing to do,
    // and `passed` is the one word a skimming reader must never be handed for one of those.
    const said = printed.map((entry) => entry.text);
    const nothingRan = hung ? null : whyNoReport(said, asked);
    const verdict = hung
      ? `hung: killed after ${timeoutMs} ms`
      : (nothingRan ?? verdicts[exitCode ?? -1] ?? `exit ${exitCode ?? 'unknown'}`);

    if (report === null) {
      const note =
        nothingRan === null
          ? `The test run wrote no report (${verdict}${reportProblem ? `; ${reportProblem}` : ''}).`
          : `No tests ran: ${verdict}.${elsewhereIn(project.value.path, asked)}`;
      return {
        content: [
          { type: 'text', text: note },
          {
            type: 'text',
            text: JSON.stringify(
              {
                passed: false,
                verdict,
                tests: 0,
                exitCode,
                hung,
                arguments: cmdArgs,
                entries: forAnswer(printed.slice(0, 60)),
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
    // What the report cannot say. gdUnit4 decides the run's state on orphan nodes and writes none
    // of that into its XML, so a tier that passed every case and left nodes behind arrived as the
    // word "warnings" and nothing else: no failure, no entry, nothing naming a suite. Read off
    // what it printed, which is where the counts are.
    const orphans = orphansPrinted(said);
    const leftBehind = new Map(orphans.suites.map((suite) => [suite.path, suite.orphans]));
    const orphansIn = (path: string | null): number => (path === null ? 0 : (leftBehind.get(path) ?? 0));
    const warnings = orphans.suites.map((suite) => ({
      kind: 'orphans',
      path: suite.path,
      name: report.suites.find((entry) => entry.path === suite.path)?.name ?? suite.path,
      orphans: suite.orphans,
      message: `${suite.orphans} node${suite.orphans === 1 ? '' : 's'} were still in the tree when this suite finished. A node built in a test and neither freed nor added to the tree is the usual cause; free it, or add it with auto_free().`,
    }));
    // A suite that passed every case has nothing to say that the totals do not, and a whole tier
    // of them is most of the answer: a hundred and three clean suites came back as fifteen
    // kilobytes of names and timings around the one line saying it passed. Counted instead, so the
    // answer is the size of what went wrong.
    const unclean = report.suites.filter(
      (suite) => suite.failures > 0 || suite.errors > 0 || suite.skipped > 0 || orphansIn(suite.path) > 0,
    );
    // gdUnit4 stops a suite at its first failing case unless told otherwise, which is what
    // `failFast` asks for. The counts are then of what ran, and the cases after the failure are
    // neither passes nor failures. Unsaid, that reads as a tier where each run finds one more
    // fault than the last: a project fixing what was named and running again met the next case
    // along three times in one afternoon, and read its own suite as flaky.
    const notRun = report.suites.reduce((sum, suite) => sum + Math.max(0, suite.discovered - suite.tests), 0);
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
      // Alongside `failed` rather than folded into it: a suite that left nodes behind failed
      // nothing, and an agent reading `failed` for what to fix must not find a passing test in it.
      warnings: warnings.length > 0 ? warnings : undefined,
      orphans: orphans.total > 0 ? orphans.total : undefined,
      notRun: notRun > 0 ? notRun : undefined,
      // The word on its own was the whole answer, and it named neither what was warned nor where.
      note:
        verdict.startsWith('warnings') && warnings.length === 0
          ? 'gdUnit4 exits 101 for orphan nodes when nothing failed, and this run printed no count of them: orphan reporting may be off in the project settings.'
          : notRun > 0
            ? `This run stopped at the first failure in each suite it failed in, so ${notRun} case${notRun === 1 ? '' : 's'} never ran and count as neither passed nor failed. Leave failFast out to run every case.`
            : undefined,
      suites: unclean.map((suite) => ({
        name: suite.name,
        path: suite.path,
        tests: suite.tests,
        // Only when they differ, and named rather than left to be inferred from the counts: a
        // suite that stopped has cases nobody ran, and they are neither passes nor failures.
        notRun: suite.discovered > suite.tests ? suite.discovered - suite.tests : undefined,
        failures: suite.failures,
        errors: suite.errors,
        skipped: suite.skipped,
        orphans: orphansIn(suite.path) > 0 ? orphansIn(suite.path) : undefined,
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
    // Marked stale the way a bridge answer is, because this one is worth marking most. These come
    // from the language server of an editor that has been running since before the addon it holds
    // was replaced, and a project reported four confident errors naming lines that were not in the
    // file, all four gone after a restart. Every other answer is wrong about something a caller can
    // check; this is a tool whose whole job is being right about a file, so it says what it
    // depended on rather than leaving that to a status call nobody makes first.
    return this.jsonTextResponse(
      markIfStale(
        {
          scriptPath: readString(args, 'scriptPath'),
          clean: errors === 0,
          errors,
          warnings: diagnostics.length - errors,
          diagnostics,
        },
        this.godotBridge.getStatus().addonVersion,
        SERVER_VERSION,
      ),
    );
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
      // Whether a `connected: false` is final. The editor dials in rather than being dialled, and
      // it backs off between tries, so for the first half-minute of a bridge's life "nothing has
      // connected" and "there is no editor" are the same answer to two different questions. A
      // downstream session read the first as the second straight after an upgrade respawned the
      // server, and went looking through the machine's processes to find the editor still up.
      mayYetConnect: status.connected ? undefined : mayYetConnect(status.listeningSince),
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
        // The record too, or "is something running" answers no about a run this server did not
        // start, which after a reconnect is every run.
        processActive: stillRunning(this.currentRun()),
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

    // An editor a server opened is started again rather than restarting itself, because only the
    // side that wrote its arguments can write them a second time. One opened by hand is on the
    // ports its own settings name and comes back on them, so Godot's restart is right for it.
    const mine = before.openedByAServer === true && before.projectPath !== undefined;
    const asked = mine
      ? await this.startItAgain(before.projectPath ?? '', before.editorPid)
      : await this.handleViaBridge('restart_editor', {});
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

  /**
   * Restarts an editor this server opened, by asking it to go and then starting it again.
   *
   * Godot's own restart cannot do it. The engine consumes the arguments an editor was started with
   * and hands none of them back, so an editor that restarts itself comes up without the ports it
   * was moved to. That used to be answered by writing those ports into Godot's editor settings, and
   * there is one of those for every editor of an engine version on the machine: a port chosen for
   * one project became the number every other project's editor came up on, so an editor opened by
   * hand for something else inherited it and collided with the editor it was moved away from.
   * Nothing is written anywhere now, because whatever wrote the arguments writes them again.
   *
   * The same ports rather than fresh ones, so that everything already pointed at this editor still
   * is. They are this editor's own and nothing else can be holding them once it has gone, which is
   * what the wait below is for.
   */
  private async startItAgain(projectPath: string, editorPid: number | undefined): Promise<ToolResponse> {
    const engine = await this.engine();
    if (!engine.ok) {
      return engine.response;
    }
    const ports = {
      lsp: this.editorServes('lspPort', 'GDHARNESS_LSP_PORT', DEFAULT_LSP_PORT),
      dap: this.editorServes('dapPort', 'GDHARNESS_DAP_PORT', DEFAULT_DAP_PORT),
    };

    const asked = await this.handleViaBridge('quit_editor', {});
    if (asked.isError === true) {
      return asked;
    }
    // Waited for rather than assumed. The editor saves on its way out, so it is not gone the moment
    // it answers, and starting the replacement while it still holds its ports is how the new one
    // comes up on neither of them.
    await this.waitForBridge(() => !alive(editorPid), Date.now() + EDITOR_RESTART_TIMEOUT_MS);

    const opened = await this.openAnEditor(engine.value, projectPath, ports);
    if (opened.error !== null) {
      return this.createErrorResponse(
        `The editor was asked to go and could not be started again: ${opened.error}`,
        [`editor_launch opens one on ${projectPath}`],
      );
    }
    return this.jsonTextResponse({ restarting: true, pid: opened.pid });
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
    const opened = await this.openAnEditor(engine.value, project.value.path, ports);
    if (opened.error !== null) {
      return this.createErrorResponse(`Could not start the editor: ${opened.error}`);
    }
    return this.jsonTextResponse({
      launched: true,
      pid: opened.pid,
      projectPath: project.value.path,
      lspPort: ports.lsp,
      dapPort: ports.dap,
    });
  }

  /**
   * Starts an editor on a project, on the ports named, and answers the process or what stopped it.
   *
   * Shared with the restart, because they are the same act. The engine consumes the arguments an
   * editor was started with and hands none of them back, so the only thing that can bring one back
   * as itself is whatever wrote those arguments in the first place.
   */
  private async openAnEditor(
    engine: string,
    projectPath: string,
    ports: EditorPorts,
  ): Promise<{ pid: number | null; error: string | null }> {
    // Told rather than left to derive. A game is started by the editor and inherits its
    // environment, not this server's, so an editor opened without TMP or TEMP set announces its
    // games somewhere this server never looks first. Passing the directory down makes the two
    // agree by construction for every editor gdharness opened. The two ports are in the environment
    // as well as on the command line because the engine keeps what it was told to itself, and the
    // third variable is this server saying it opened this editor, which is what decides who may
    // open it again.
    const editor = spawn(engine, editorArguments(projectPath, ports), {
      stdio: 'ignore',
      detached: true,
      env: {
        ...process.env,
        GDHARNESS_RUNTIME_DIR: runtimeDirectory(),
        GDHARNESS_LSP_PORT: String(ports.lsp),
        GDHARNESS_DAP_PORT: String(ports.dap),
        [OPENED_BY_A_SERVER]: '1',
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
      return { pid: null, error: started };
    }
    editor.unref();
    return { pid: editor.pid ?? null, error: null };
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
    const given = this.gameArguments(args);
    if (!given.ok) {
      return given.response;
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
      return await this.checkBoot(engine.value, project.value.path, sceneArgument, args, given.value);
    }

    // Asked of the record as well as of this server, because a run started before a reconnect is
    // one this process has never heard of. Starting a second engine beside it would leave the
    // first running with nothing holding it and its note overwritten, which is the one way
    // detaching a run could turn into a leak.
    // Kept so the answer can say it. A start that quietly ends the run somebody was reading is
    // the same silence as a run dying on its own, and the caller reads the second as the first:
    // a bench that stops mid-measurement with nothing said sends them looking at their engine.
    let ended: number | null = null;
    if (stillRunning(this.currentRun())) {
      this.logDebug('Ending the running game before starting another');
      ended = this.currentRun()?.pid ?? null;
      await this.endActiveGame(
        'editor_run start, which ends the run that was going before it starts another',
      );
    }

    // Taken before anything starts, so the game waited for below is one nobody had seen: a game
    // that has just been ended can still be dying with its announcement on disk.
    const alreadyPlaying = new Set(discoverRuntimes().map((endpoint) => endpoint.pid));

    // The editor when it is there: a game it plays is a game its debugger is holding, and that
    // session is the only thing the debug tools can reach. A game started here as its own
    // process is invisible to them, whatever port they are pointed at.
    //
    // A headless run goes through the editor only when the project's own run arguments say the
    // editor would play it headless too. Otherwise it is spawned: answering a request for no
    // window with a window would be answering a different question.
    //
    // And a run carrying the game's own arguments is spawned whatever else is true, because the
    // editor cannot be given any: it builds the game's command line out of
    // `editor/run/main_run_args`, which it reads when it opens the project. Measured against
    // 4.7.2, and both halves: a value the addon wrote into the live settings was not on the
    // command line of the game played a moment later, saving it to disk did not change that, and
    // the same value put there before the editor started arrived. So the choice is the debugger
    // or the arguments, and which one a caller wanted is not this server's to guess.
    const headless = resolveHeadless(args['headless'], {
      platform: process.platform,
      variables: process.env,
    });
    const runtimeWaitMs = readNonNegativeNumber(args, 'runtimeWaitMs') ?? ANNOUNCE_BUDGET_MS;
    const editorWouldPlay = !headless || editorPlaysHeadless(project.value.file);
    if (this.godotBridge.isConnected() && editorWouldPlay && given.value.length === 0) {
      return await this.playThroughEditor(
        sceneArgument,
        refreshed.value,
        project.value.path,
        alreadyPlaying,
        runtimeWaitMs,
        ended,
      );
    }

    const cmdArgs = runArguments({
      projectPath: project.value.path,
      headless,
      scene: sceneArgument,
      userArgs: given.value,
    });
    this.logDebug(`Running Godot project: ${engine.value} ${cmdArgs.join(' ')}`);
    const started = this.spawnKeptGame(engine.value, cmdArgs, project.value.path);
    // Kept after it exits rather than dropped, because a run that quits on its own is the whole
    // point of a headless one: a bench, a report, a tool scene. Dropping the reference on exit
    // threw its output away before anybody could read it, and left editor_output answering "no
    // game is running" about a run that had just printed its answer. Whether a run is *active* is
    // exitCode === null, which is what the callers below now ask.
    this.activeProcess = started;
    // Said rather than left to be noticed: a caller who has an editor open and asked for
    // arguments has been handed a game that editor is not holding, so the debug tools will not
    // answer about it however connected the editor is.
    const spawnedInstead =
      this.godotBridge.isConnected() && editorWouldPlay && given.value.length > 0
        ? ' The editor cannot be handed arguments for a game it plays, so this one was started ' +
          'here: the debug_* tools answer only for a game the editor is playing.'
        : '';
    const endedForThis =
      ended === null
        ? ''
        : ` The run that was going, pid ${ended}, was ended to start this one; its output is no longer what editor_output answers about.`;
    return this.jsonTextResponse({
      started: true,
      through: 'gdharness',
      pid: started.process.pid ?? null,
      arguments: cmdArgs,
      refreshedClasses: refreshed.value,
      // Which run this start ended, when it ended one, so a bench that stopped is answered for
      // here rather than looked for in the engine.
      endedPreviousRun: ended ?? undefined,
      runtime: await this.runtimeUp(project.value.path, alreadyPlaying, runtimeWaitMs),
      message: `Use editor_output for what it prints and editor_run stop to end it.${spawnedInstead}${endedForThis}`,
    });
  }

  /** Whether the game is still up, asking the editor only about a game the editor is playing. */
  private async gameIsUp(): Promise<boolean> {
    const run = this.currentRun();
    const editorSays =
      run?.throughEditor === true ? ((await this.editorPlayingState())?.playing ?? null) : null;
    return runIsUp(run, editorSays);
  }

  /**
   * Waits for the game just started to be something the runtime tools can talk to, and says so.
   *
   * A start answered the moment the engine was asked to play, and the runtime binds its port and
   * announces itself some way into the boot after that, so the first `runtime_*` call after a
   * start was routinely answered "No game with the runtime addon is running" about a game that
   * was starting. Twice in one session the way through was to make the same call again.
   *
   * A project with no runtime addon on disk can never announce, so it is not waited for: the
   * autoload is deliberately not asked about, because a project is free to bring the addon up
   * through a script of its own rather than by registering the addon's path.
   *
   * `listening: false` alone is two situations spelled the same way: a runtime that is never
   * coming, and one that announced a moment after the budget ran out. A project whose boot takes
   * longer than the budget was being told its runtime was not there, when one more call would
   * have found it. `mayYetAnnounce` separates them, and is the field to read before giving up:
   * false is final, true is not yet. `runtimeWaitMs` waits longer for a project that needs it.
   */
  private async runtimeUp(
    projectPath: string,
    before: ReadonlySet<number>,
    budgetMs: number,
  ): Promise<Record<string, unknown>> {
    if (!existsSync(join(projectPath, RUNTIME_AUTOLOAD.path))) {
      return runtimeVerdict(null, { addon: false, budgetMs, heldAt: null, running: false });
    }
    const endpoint = await announcedSince(projectPath, before, {
      budgetMs,
      // A game held at a breakpoint set before the run is not booting any more, and waiting out
      // the budget on one says nothing. It cannot announce until it is let go. Nor is there
      // anything to wait for once the process is over: a boot that fails on a parse error is
      // gone in half a second, and sitting out the rest of the budget delays the answer that
      // says so. The announcement is looked for before this is asked, so a game that announced
      // and then quit is still found.
      giveUp: () => this.dapClient?.isStopped() === true || !stillRunning(this.currentRun()),
    });
    return runtimeVerdict(endpoint, {
      addon: true,
      budgetMs,
      heldAt: this.dapClient?.whereItStopped() ?? null,
      running: await this.gameIsUp(),
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
    projectPath: string,
    alreadyPlaying: ReadonlySet<number>,
    runtimeWaitMs: number,
    ended: number | null,
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
      pid: null,
      log,
      transcript: null,
      readOffset: 0,
      projectPath,
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
      endedPreviousRun: ended ?? undefined,
      runtime: await this.runtimeUp(projectPath, alreadyPlaying, runtimeWaitMs),
      message:
        'The editor is playing it, so its debugger holds it: the debug_* tools can reach it, ' +
        'editor_output reads its console through the debug adapter, and editor_run stop ends it.' +
        (ended === null
          ? ''
          : ` The run that was going, pid ${ended}, was ended to start this one; its output is no longer what editor_output answers about.`),
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

  /** Ends whatever is running, whichever way it was started, and says so on the run it ended. */
  private async endActiveGame(reason: string): Promise<void> {
    const running = this.activeProcess;
    this.activeProcess = null;
    // Read before the note is taken away, because it is what says the pid below still means this
    // run: the number alone does not.
    const recorded = running?.process === null ? readRunRecord() : null;
    // A run somebody has ended is not one the next server should offer to pick back up, and the
    // note outlives this process unless it is taken away here. Only this project's, because the
    // directories it is looked for in are shared with whatever else is running on this machine.
    clearRunRecord((record) => this.couldBeOurs(record.projectPath));
    if (!running) {
      return;
    }
    running.endedHere = reason;
    if (running.throughEditor) {
      await this.handleViaBridge('stop_playing', {});
      return;
    }
    if (running.process !== null) {
      // Started here, so there is a handle, and a handle cannot come to mean another process.
      running.process.kill();
      return;
    }
    if (running.pid === null) {
      return;
    }
    // A run picked back up after a restart: the handle belonged to a server that is gone and the
    // number is all that is left. A number is not an identity, though. The operating system hands
    // a pid out again as soon as it is free, so signalling on the strength of it is how a stop
    // ends up killing whatever came after the run, which is not something that can be taken back.
    if (recorded === null || recorded.pid !== running.pid || !stillTheRecordedRun(recorded)) {
      running.endedHere = null;
      running.log.record(
        'warning',
        `This run was not ended here: pid ${running.pid} no longer answers as the run that was recorded, so nothing was signalled. If that process is still the game, end it yourself; if it is not, it belongs to something else.`,
      );
      return;
    }
    try {
      process.kill(running.pid);
    } catch {
      // Ended between being read and being stopped, which is the state this asks for.
    }
  }

  /**
   * The engine as a child process, with everything it prints read into a log as it comes.
   *
   * For the runs a caller is waiting on: a test tier, a boot check. These are held rather than
   * detached on purpose. The answer is the point of them, and an answer belongs to the call that
   * asked, so a server that goes away mid-run takes the only reader with it; outliving it would
   * leave an engine nobody is reading and nobody will ever end.
   */
  private spawnGame(godotPath: string, cmdArgs: string[], env?: NodeJS.ProcessEnv): SpawnedGame {
    const child = spawn(godotPath, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) });
    const log = new GameLog();
    const started: SpawnedGame = {
      process: child,
      pid: child.pid ?? null,
      log,
      transcript: null,
      readOffset: 0,
      projectPath: null,
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
      // Into the note as well as into this process, because this process is the one the harness
      // replaces without warning: an exit seen and not written down is an exit nobody can read.
      if (started.pid !== null) {
        recordRunEnded(started.pid, started.exitCode);
      }
    });
    child.on('error', (err: Error) => {
      console.error('Failed to start Godot process:', err);
      log.append('stderr', `${err.message}\n`);
      started.exitCode = -1;
    });
    return started;
  }

  /**
   * The engine as a process of its own, printing into a file this server reads rather than into
   * a pipe this server holds.
   *
   * For `editor_run start`, whose whole promise is a run that keeps going and keeps printing
   * while the caller does other things. The harness restarts this server whenever it likes, and
   * an ordinary child goes down with its parent: a bench forty minutes into a sweep was killed
   * twice in one session by a reconnect nobody asked for. Detaching is what makes the run the
   * operating system's rather than this process's.
   *
   * Its output goes to a file for that reason and one more. A pipe with no reader fills and then
   * blocks whatever is writing into it, so surviving the server down a pipe would only trade a
   * killed run for a wedged one. A file is read by offset whenever somebody asks, which is also
   * what leaves the bytes there for the next server to read.
   */
  private spawnKeptGame(
    godotPath: string,
    cmdArgs: string[],
    projectPath: string,
    env?: NodeJS.ProcessEnv,
  ): SpawnedGame {
    const startedAt = Date.now();
    const transcript = openTranscript(startedAt);
    let child: ChildProcess;
    try {
      child = spawn(godotPath, cmdArgs, {
        stdio: ['ignore', transcript.fd, transcript.fd],
        detached: true,
        ...(env ? { env } : {}),
      });
    } finally {
      // The child holds its own copy from here on, and this server only ever reads the file.
      closeSync(transcript.fd);
    }
    // So this server exiting is not itself a reason for the run to end.
    child.unref();
    const log = new GameLog();
    const started: SpawnedGame = {
      process: child,
      pid: child.pid ?? null,
      log,
      transcript: transcript.path,
      readOffset: 0,
      projectPath,
      startedAt,
      exitCode: null,
      throughEditor: false,
      brokeOn: null,
    };
    child.on('exit', (code: number | null) => {
      this.logDebug(`Godot process exited with code ${code ?? 'none'}`);
      this.drainTranscript(started);
      log.finish();
      started.exitCode = code ?? -1;
    });
    child.on('error', (err: Error) => {
      console.error('Failed to start Godot process:', err);
      log.append('stderr', `${err.message}\n`);
      started.exitCode = -1;
    });
    if (started.pid !== null) {
      writeRunRecord({
        pid: started.pid,
        transcript: transcript.path,
        startedAt,
        projectPath,
        arguments: cmdArgs,
        command: godotPath,
      });
    }
    sweepTranscripts();
    return started;
  }

  /**
   * Read whatever the run has printed since this was last asked.
   *
   * By offset rather than by watching, because the file is written by a process this server may
   * not have started and may not have been running when the lines were printed. Reading from
   * where it left off is the same act whether the run is this server's or one it has picked up.
   */
  private drainTranscript(game: GodotProcess): void {
    if (game.transcript === null) {
      return;
    }
    let handle: number;
    try {
      handle = openSync(game.transcript, 'r');
    } catch {
      // A transcript that is not there yet, or has been swept: neither is worth failing a read
      // of the log over, and both answer the same as a run that has printed nothing.
      return;
    }
    try {
      const size = fstatSync(handle).size;
      if (size <= game.readOffset) {
        return;
      }
      const buffer = Buffer.alloc(size - game.readOffset);
      const read = readSync(handle, buffer, 0, buffer.length, game.readOffset);
      game.readOffset += read;
      game.log.append('transcript', buffer.subarray(0, read));
    } finally {
      closeSync(handle);
    }
  }

  /**
   * The run some earlier server started, picked back up.
   *
   * What was lost in a reconnect is recovered here: the record names the process and the file, so
   * a run still going goes on being reported as running and one that ended is answered with
   * everything it printed. Both beat "No game is running", which was the answer to either.
   */
  private adoptRecordedRun(): GodotProcess | null {
    const record = readRunRecord();
    if (record === null || !this.couldBeOurs(record.projectPath)) {
      return null;
    }
    const adopted: GodotProcess = {
      process: null,
      pid: record.pid,
      log: new GameLog(),
      transcript: record.transcript,
      readOffset: 0,
      projectPath: record.projectPath === '' ? null : record.projectPath,
      startedAt: record.startedAt,
      exitCode: null,
      throughEditor: false,
      brokeOn: null,
    };
    this.drainTranscript(adopted);
    // Alive, and still the run this record describes. The second half is asked once, here, where
    // a run is picked up: a pid that came back around belongs to something else, and taking it
    // for the run would report a finished bench as running and offer its number to be killed.
    if (!alive(record.pid) || !couldStillBeTheRecordedRun(record)) {
      adopted.log.finish();
      // The code the server that started it wrote down, when there was one to write. Without it
      // nobody was waiting on the process and what it exited with is nowhere, which is said as
      // unknown rather than guessed at.
      adopted.exitCode = record.exitCode ?? null;
      adopted.endedUnwatched = record.exitCode === undefined;
    }
    this.activeProcess = adopted;
    return adopted;
  }

  /**
   * Whether a run left on disk belongs to the project this server serves.
   *
   * The note lives in the runtime directory, which is per machine rather than per project, so two
   * servers running beside each other share it. Answering about the other one's run would be the
   * worst kind of wrong answer: the right shape, about the wrong game, and nothing in it saying
   * so. Compared against the project this server was told to serve, then against the one the
   * editor on the bridge has open.
   *
   * With neither, the answer is no. It used to be yes, on the reasoning that a server which
   * cannot name a project has nothing to compare against and the run was probably its own. That
   * reads "I do not know whose this is" as "it is mine", about a note whose whole purpose is to
   * let a server pick a run back up and end it. A regression suite, whose servers are started
   * with no project and no editor, adopted a bench belonging to another project on the same
   * machine and killed it before starting its own run: six times in fifty minutes, silently,
   * while its owner bisected their own code looking for the cause.
   *
   * A server that cannot say whose a run is answers "No game is running" about it, which is the
   * true answer to the question it can actually ask.
   */
  /**
   * What to say when this server has no run to answer about.
   *
   * "No game is running" is two situations now that a server only claims what it can show is its
   * own: nothing is running anywhere, and something is running that belongs to somebody else.
   * They call for different things, and a caller who has just started a game and is being told
   * nothing is running needs the second one spelled out rather than left to be inferred from a
   * sentence that is true about this server and false about the machine.
   */
  private nothingOfOursIsRunning(): string {
    const record = readRunRecord();
    if (record === null) {
      return 'No game is running. Start one with editor_run.';
    }
    const status = this.godotBridge.getStatus();
    const mine = this.ownProject ?? (status.connected ? (status.projectPath ?? null) : null);
    const whose = record.projectPath === '' ? 'a project it does not name' : record.projectPath;
    const ours =
      mine === null
        ? 'this server was started without GDHARNESS_PROJECT and has no editor connected, so it cannot say whose that run is'
        : `this server serves ${mine}`;
    return `No game of this server's is running. A run started from ${whose} is recorded on this machine, and ${ours}, so it is not this server's to answer for or to end. Start one with editor_run.`;
  }

  private couldBeOurs(project: string): boolean {
    const status = this.godotBridge.getStatus();
    const mine = this.ownProject ?? (status.connected ? (status.projectPath ?? null) : null);
    if (mine === null) {
      return false;
    }
    // A note from a version that did not record the project. It cannot be shown to be this
    // server's, and the reason to keep reading it is the same reason it is not killed by pid
    // alone: the cost of being wrong lands on somebody else.
    return project !== '' && samePath(mine, project);
  }

  /**
   * Whichever run this server should answer about: the one it is holding, or one left on disk.
   *
   * Asked before every answer about a run, because a reconnect is invisible from here: this
   * server has no memory of having started anything, and the only sign that something is running
   * is the record the server before it left.
   */
  private currentRun(): GodotProcess | null {
    return this.activeProcess ?? this.adoptRecordedRun();
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
    userArgs: readonly string[],
  ): Promise<ToolResponse> {
    const frames = readPositiveNumber(args, 'frames') ?? 3;
    const timeoutMs = readPositiveNumber(args, 'timeoutMs') ?? 60000;
    const cmdArgs = runArguments({ projectPath, headless: true, scene, quitAfter: frames, userArgs });
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
      entries: forAnswer(boot.log.select({ severity: 'warning', sinceLastCall: false, limit: 200 }).entries),
    });
  }

  /** editor_output: the log as entries, filtered the way the caller asked. */
  /**
   * Waits for the run to end, then answers exactly as editor_output does.
   *
   * Without this a caller watching a headless run had to poll the process from a shell, once per
   * session, and that loop is easy to write inside out: a test with its polarity reversed returns
   * at once on a live run and reads as a run that finished. The pid and the liveness check are
   * both already here, so the waiting belongs here too.
   *
   * A wait that runs out is not a failure. The answer says `running` either way, and the note says
   * which of the two happened so that "still going" is never read as "ended and printed nothing".
   */
  private async handleWaitForRun(args: OperationParams): Promise<ToolResponse> {
    const run = this.currentRun();
    if (!run) {
      return this.createErrorResponse(this.nothingOfOursIsRunning());
    }
    const budgetMs = readPositiveNumber(args, 'timeoutMs') ?? WAIT_FOR_RUN_MS;
    const until = Date.now() + budgetMs;
    // Drained as it goes rather than once at the end: the pipes are what the output is read from,
    // and a run that fills them while nobody reads blocks on its own print.
    while (stillRunning(run) && Date.now() < until) {
      this.drainEditorOutput(run);
      this.drainTranscript(run);
      await delay(RUN_POLL_MS);
    }
    return await this.handleGetDebugOutput(args, stillRunning(run) ? budgetMs : undefined);
  }

  private async handleGetDebugOutput(args: OperationParams, waitedMs?: number): Promise<ToolResponse> {
    const run = this.currentRun();
    if (!run) {
      return this.createErrorResponse(this.nothingOfOursIsRunning());
    }
    this.drainEditorOutput(run);
    this.drainTranscript(run);
    // A run picked up alive and since ended, caught here rather than left reading as running. The
    // last of its output is already in, because the drain above ran first.
    if (run.endedUnwatched !== true && !stillRunning(run)) {
      run.log.finish();
      run.endedUnwatched = run.exitCode === null;
    }
    const severity = readString(args, 'severity');
    const selected = run.log.select({
      severity: severity === 'error' || severity === 'warning' ? severity : 'info',
      sinceLastCall: readBoolean(args, 'sinceLastCall') ?? false,
      contains: readNonEmptyString(args, 'contains'),
      limit: readPositiveNumber(args, 'limit') ?? 200,
    });
    // A game held at a breakpoint is running in the sense the process is alive and in no sense
    // that matters to a caller: it draws nothing, answers no runtime call, and the timeouts that
    // follow read like a hung engine. Said here because this is where somebody asks what it did.
    const halt = run.throughEditor ? (this.dapClient?.whereItStopped() ?? null) : null;
    // Asked for rather than always, because asking costs a subprocess and on Windows that is a
    // PowerShell start: seconds under load, on every read, on the one platform where the answer is
    // dearest. Put in the hot path it slowed every call enough to time others out, and the tests
    // that ask Windows about a process were the ones that failed. A caller wanting to tell a wedged
    // run from a slow one asks then, which is rarely and deliberately.
    //
    // Only while it is going: a process that has exited has no processor time left to report, and
    // asking after a pid that is gone answers about whatever holds that number next.
    const wanted = readBoolean(args, 'cpu') ?? false;
    const cpuSeconds =
      wanted && run.pid !== null && stillRunning(run) ? await cpuSecondsOf(run.pid) : undefined;
    const notes: string[] = [];
    if (waitedMs !== undefined) {
      notes.push(
        `The wait of ${waitedMs}ms ran out and the run is still going, so this is what it had printed by then rather than everything it will print. editor_run wait again to keep waiting.`,
      );
    }
    if (run.endedUnwatched === true) {
      notes.push(
        'This run outlived the server that started it and is over now, so its exit code was never collected. Everything it printed is below, read back from its transcript.',
      );
    }
    // Which of the two silences this is. A run gdharness ended and a run that stopped being there
    // print the same nothing and answer with the same exit code, and the difference is the whole
    // question when a bench dies mid-measurement: one of them is this tool's doing and is on the
    // record here, and the other sends the reader to look at their own machine.
    if (typeof run.endedHere === 'string') {
      notes.push(`This run was ended here, by ${run.endedHere}.`);
    } else if (!stillRunning(run) && !run.throughEditor && run.exitCode !== null) {
      // A zero exit is not one of the two silences: nothing kills a process into exiting cleanly,
      // so the game reached its own end and said so. Reported as the same open question it used to
      // be, it read as an incident on every clean finish, which for a bench that prints and quits
      // is every finish it has.
      notes.push(
        run.exitCode === 0
          ? 'This run quit on its own, cleanly: exit code 0.'
          : 'Nothing here ended this run: it stopped on its own or something outside this server stopped it.',
      );
    }
    // Where the rest of it is, which nothing said. A long run is capped at `limit` entries and the
    // answer said how many it left out without saying that the whole thing is in a file, uncapped,
    // and readable while the run is still going. A project watching a fifty-minute bench reached
    // instead for Godot's own log, which every engine start rotates away: two of them, started by
    // an upgrade, left it holding 239 bytes of somebody else's output while this file was intact.
    // And what that file cannot answer, since handing somebody a path is also an invitation to
    // watch it. A run is alive or not by the operating system, which is what `running` above is
    // asked of; a file that has stopped growing is a run between prints, and an arm of a bench
    // that prints one row at its end is legitimately silent for minutes. A watcher built on the
    // file declared a bench dead while its process sat there doing what it was asked, which is
    // the shape of every liveness proxy: it fails in the direction of the proxy rather than the
    // direction of the truth.
    if (run.transcript !== null && selected.omitted > 0) {
      notes.push(
        `Everything this run has printed is in ${run.transcript}, uncapped and still being written. Read it for output, not for whether the run is alive: running above is asked of the operating system, and a transcript that stops growing is a run between prints.`,
      );
    }
    return this.jsonTextResponse({
      running: stillRunning(run),
      exitCode: run.exitCode,
      through: run.throughEditor ? 'editor' : 'gdharness',
      pid: run.pid,
      errors: run.log.count('error'),
      warnings: run.log.count('warning'),
      clean: run.log.count('error') === 0,
      heldAt: halt,
      // Which of the two ways of not running this is, since they call for different things. A
      // run that ended while nothing was watching printed everything below and then stopped
      // being there, and no exit code was collected because nobody was waiting on it.
      endedUnwatched: run.endedUnwatched === true ? true : undefined,
      // What ended it, when that was this server. Null says the run was not ended here, which is
      // an answer rather than the absence of one.
      endedBy: stillRunning(run) ? undefined : (run.endedHere ?? null),
      // Named for a run this server did not start, because the note a run leaves behind is
      // shared by every server using this runtime directory: a caller can see whose run it is.
      project: !run.throughEditor && run.process === null ? (run.projectPath ?? undefined) : undefined,
      // The file this run's output is written to, so watching a long one is reading a file meant
      // to be read rather than racing the engine for one that is not.
      transcript: run.transcript ?? undefined,
      // How long it has been going, and, when asked for, how much of that it spent working. A run
      // that is wedged and a run that is merely slow look the same from outside, and processor
      // time is what separates them: elapsed climbing while it stands still is a game that has
      // stopped doing anything. Absent unless `cpu` asked, and absent where the platform will not
      // say, rather than guessed at.
      startedAt: new Date(run.startedAt).toISOString(),
      elapsedMs: Date.now() - run.startedAt,
      cpuSeconds,
      note: notes.length > 0 ? notes.join(' ') : undefined,
      omitted: selected.omitted,
      entries: forAnswer(selected.entries),
    });
  }

  /** editor_run stop: the game is ended and its verdict answered, errors and warnings kept. */
  private async handleStopProject(): Promise<ToolResponse> {
    const stopped = this.currentRun();
    if (!stopped) {
      return this.createErrorResponse(this.nothingOfOursIsRunning());
    }
    this.drainEditorOutput(stopped);
    this.drainTranscript(stopped);
    this.logDebug('Stopping the running game');
    await this.endActiveGame('editor_run stop');
    return this.jsonTextResponse({
      stopped: true,
      through: stopped.throughEditor ? 'editor' : 'gdharness',
      exitedBeforeStop: stopped.exitCode !== null,
      exitCode: stopped.exitCode,
      errors: stopped.log.count('error'),
      warnings: stopped.log.count('warning'),
      clean: stopped.log.count('error') === 0,
      entries: forAnswer(
        stopped.log.select({ severity: 'warning', sinceLastCall: false, limit: 200 }).entries,
      ),
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

    const checked = busy ? { unseen: [] } : await this.classesTheEditorCannotSee(args);
    const unseen = checked.unseen;
    return this.jsonTextResponse({
      ok: !busy && unseen.length === 0 && checked.unchecked === undefined,
      stillWorking: busy,
      waitedMs: Date.now() - started,
      unseenByEditor: unseen.length > 0 ? unseen : undefined,
      classesUnchecked: checked.unchecked,
      note: busy
        ? 'The editor was still scanning or importing when the wait ran out, so new files may not be visible yet.'
        : unseen.length > 0
          ? 'The scan finished and these classes are still not in the list the editor resolves against, so every use of them reads as an unknown identifier. Its walk skips a file another engine has already imported. Change the declaring script and rescan, or restart the editor with editor_launch restart.'
          : undefined,
    });
  }

  /**
   * A rebuilt class cache, with what the editor holding the project still cannot resolve.
   *
   * Rebuilding the cache writes a file and nothing rereads it, so an editor that had gone blind
   * to a class is exactly as blind afterwards and the answer says `added: []`. That sentence is
   * true and reads as "nothing was wrong", which is how two projects were sent away from the one
   * call that could have told them. A refusal is left alone: it has its own thing to say.
   */
  private async alsoSayWhatTheEditorCannotSee(
    answered: ToolResponse,
    args: OperationParams,
  ): Promise<ToolResponse> {
    const first = answered.content[0];
    if (answered.isError || first?.type !== 'text' || typeof first.text !== 'string') {
      return answered;
    }
    const checked = await this.classesTheEditorCannotSee(args);
    if (checked.unseen.length === 0 && checked.unchecked === undefined) {
      return answered;
    }
    return this.jsonTextResponse({
      ...asParams(JSON.parse(first.text)),
      unseenByEditor: checked.unseen.length > 0 ? checked.unseen : undefined,
      classesUnchecked: checked.unchecked,
      note:
        checked.unseen.length > 0
          ? 'The cache on disk is right now, and the editor holding this project is still not resolving these: rewriting the file does not reach the list it already loaded. Change the declaring script and editor_rescan, or restart the editor with editor_launch restart.'
          : undefined,
    });
  }

  /**
   * The project's own classes a connected editor is not holding, after a scan has finished.
   *
   * Asked of the editor rather than of the cache, because the cache is on disk and the state
   * worth reporting is the one where disk is right and the editor is not.
   *
   * An editor that will not answer says so under `unchecked` rather than answering with nothing.
   * Nothing is what a clean project answers, and a check whose failure is spelled the same as its
   * pass is a check that stops being read: this one exists because two projects were told they
   * were clean by three things in a row that were only silent.
   */
  private async classesTheEditorCannotSee(
    args: OperationParams,
  ): Promise<{ unseen: UnseenClass[]; unchecked?: string }> {
    const projectPath = typeof args['projectPath'] === 'string' ? args['projectPath'] : '';
    if (projectPath === '') {
      return { unseen: [], unchecked: 'no projectPath, so there was nothing to read the cache from' };
    }
    // An editor open on something else holds a list for that project, and every class here would
    // be missing from it. Comparing them names the whole project as unseen, which is a wrong
    // answer said loudly, and the failure this exists to end was a wrong answer said quietly.
    const open = this.godotBridge.getStatus().projectPath;
    if (open === undefined || !samePath(open, projectPath)) {
      return {
        unseen: [],
        unchecked: `the connected editor is open on ${open ?? 'a project it did not name'}, not this one`,
      };
    }
    // The list itself is the evidence, rather than an `ok` beside it: the editor plugin erases
    // that key from every result it reports as a success, so a caller waiting to see one waits
    // for ever and calls the project clean while doing it. A refusal arrives as a rejection.
    let held: OperationParams;
    try {
      held = asParams(await this.godotBridge.invokeTool('global_classes', args));
    } catch (error) {
      return {
        unseen: [],
        unchecked: `the editor would not say what classes it is holding: ${errorMessage(error)}`,
      };
    }
    if (!Array.isArray(held['classes'])) {
      return { unseen: [], unchecked: 'the editor answered without a class list in it' };
    }
    return { unseen: unseenByEditor(projectPath, held['classes'].map(String)) };
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
      return this.jsonTextResponse(
        markIfStale(
          await this.godotBridge.invokeTool(toolName, args),
          this.godotBridge.getStatus().addonVersion,
          SERVER_VERSION,
        ),
      );
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
    const includeHidden = readBoolean(args, 'includeHidden');
    return await this.handleRuntimeCommand('find_nodes', {
      ...filters,
      projectPath: args['projectPath'],
      root: readNonEmptyString(args, 'nodePath') ?? '/root',
      limit: readPositiveNumber(args, 'limit') ?? 100,
      ...(property === undefined ? {} : { property }),
      // Sent only when asked for, so what goes over the wire stays what the caller named. The
      // default lives on the addon side and is true there, unlike the same argument on text: a
      // find names a class or a group and means the node whether or not it is drawn, while text
      // is what somebody reads off the screen.
      ...(includeHidden === undefined ? {} : { include_hidden: includeHidden }),
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
