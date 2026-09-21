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
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, normalize, relative } from 'node:path';
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
import { readBootNote, waitSizedTo, writeBootNote } from './boot-note.js';
import { readBreakpointNote, writeBreakpointNote } from './breakpoint-note.js';
import { announceBridge, announcementPath, readAnnouncement, withdrawBridge } from './bridge-announce.js';
import {
  cachedAtMissingPaths,
  cachedClasses,
  cacheWrittenAt,
  classesNamedIn,
  contradictedDiagnostics,
  declaredClasses,
  heldButGone,
  missingMemberIn,
  staleAnalysisNote,
  staleClassNames,
  type UnseenClass,
  uncachedClassNote,
  unknownTypeIn,
  unloadedTypes,
  unseenByEditor,
} from './class-cache.js';
import { configDisagrees } from './config-pin.js';
import {
  DEFAULT_DAP_PORT,
  GodotDAPClient,
  type HeldBreakpoint,
  handleDAPTool,
  type StoppedAt,
} from './dap_client.js';
import { dictionary, emptyRecord } from './dictionary.js';
import { errorMessage, Refusal } from './errors.js';
import { forAnswer, GameLog, type LogEntry } from './game-log.js';
import {
  anEditorIsStillComing,
  type GodotBridge,
  getDefaultBridge,
  theEditorHasComeBack,
} from './godot-bridge.js';
import { GodotLocator } from './godot-path.js';
import { type HeadlessOutcome, runImport, runOperation } from './headless.js';
import { EDITOR_READS, ENGINE_PASSES, HEADLESS_OPERATIONS } from './headless-operations.js';
import { DefectsSeen, defectReport, feedbackNotice } from './issues.js';
import { orphansPrinted, parseJUnit, type TestReport, whyNoReport } from './junit.js';
import {
  type EditorPorts,
  editorArguments,
  envValue,
  OPENED_BY_A_SERVER,
  resolveHeadless,
  runArguments,
  SAVES_NOT_MOVED_NOTE,
  savesStayPut,
  userDataIn,
} from './launch.js';
import { DEFAULT_LSP_PORT, GodotLSPClient, handleLSPTool } from './lsp_client.js';
import { isSameDirectory, realPathOr, resolveWithinProject } from './paths.js';
import { freePort, portFromEnvOrNull } from './ports.js';
import {
  ancestorsIn,
  type CommandLineRead,
  descendantsIn,
  type ProcessTree,
  processTree,
  readCommandLine,
} from './process-children.js';
import { cpuSecondsOf } from './process-time.js';
import { projectStructure, scriptsWithoutUid, searchProject } from './project-scan.js';
import { parseProjectGodot, settingKeys, settingsDroppedReport, setupResourceHandlers } from './resources.js';
import { noteRestartBegun, type RestartNote, restartOwed, restartSettled } from './restart-note.js';
import {
  clearRunRecord,
  couldStillBeTheRecordedRun,
  listeningPid,
  openTranscript,
  readEditorRunNote,
  readRunRecord,
  recordRunEnded,
  runningAs,
  stillTheRecordedRun,
  sweepTranscripts,
  writeEditorRunNote,
  writeRunRecord,
} from './run-record.js';
import {
  ANNOUNCE_BUDGET_MS,
  announcedSince,
  announcementEnded,
  chooseRuntime,
  discoverRuntimes,
  errorReportOf,
  RUNTIME_PROTOCOL,
  type RuntimeEndpoint,
  runtimeDirectory,
  runtimeRequest,
  runtimesAnnounced,
  type UnspokenRuntime,
} from './runtime-client.js';
import { discard } from './scratch.js';
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
  type ProjectInfoSection,
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
 * How long a game gets to answer a ping before it is taken for held. A running game answers in
 * milliseconds and a held one never does, so this is the wait for the second answer and it is paid
 * only by a session that could not learn the state from the adapter.
 */
const HOLD_PING_MS = 2_000;

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
 * A file under the project as the project spells it, which is how a caller names it.
 *
 * Both sides resolved, since the adapter's spelling has every symlink followed and the project's
 * as the bridge reports it may not: on macOS every /var/folders project is really under
 * /private/var/folders, and the unresolved root would put its own files outside it.
 */
function projectSpelling(projectPath: string, absolutePath: string): string {
  return `res://${relative(realPathOr(projectPath), realPathOr(absolutePath)).replaceAll('\\', '/')}`;
}

/**
 * The two arguments that pick a game for a runtime command, carried as the caller gave them.
 *
 * Every runtime tool takes them and every op forwards them, so they are lifted off the call in
 * one place rather than named at each of the thirteen sites, where one site forgetting `pid`
 * would be a tool that refuses a bench's workers while the others answer.
 */
function whichGame(args: OperationParams): { projectPath: unknown; pid: unknown } {
  return { projectPath: args['projectPath'], pid: args['pid'] };
}

/**
 * Why a game is sitting still, as a clause: the adapter's reason, and its own words for an error.
 *
 * Godot reports `breakpoint`, `step` and `exception`; `attached` is this side's word for a hold
 * found by asking rather than told. Anything else is passed through as the adapter said it.
 */
function describeHalt(halt: StoppedAt): string {
  switch (halt.reason) {
    case 'breakpoint':
      return 'at a breakpoint';
    case 'step':
      return 'after a step';
    case 'exception':
      return halt.text === '' ? 'on an error' : `on an error: ${halt.text}`;
    case 'attached':
      return 'held when this session attached';
    default:
      return `stopped with reason "${halt.reason}"`;
  }
}

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
  // A played run that announced itself, asked of the operating system. The editor is the usual
  // source for these and it is not always there and not always current: it went on reporting a game
  // whose process had been ended from outside. A process that is gone is gone whoever believes
  // otherwise, and this only ever turns a yes into a no: a number that has come round to something
  // else reads as alive, which is what the line below answers anyway.
  if (run.announcedPid !== undefined && !alive(run.announcedPid)) {
    return false;
  }
  return true;
}

/**
 * How long after a play the editor is given to start reporting the game as playing.
 *
 * An editor plays a scene when it is ready to, and a restarted one is not ready until its scan is
 * over: it answered the play with "not playing", went on saying so for a moment, and then the
 * game came up. Read as the editor's word on a run, "not playing" said "the game is no longer
 * running" about a game that had not yet begun. Until the editor has reported the run playing
 * once, its "not playing" is the play still on its way, for this long: an editor that has not
 * started a game within it is not going to, and its word stands from then on.
 */
export const PLAY_STARTS_WITHIN_MS = 30_000;

/**
 * Whether a run is still up, taking the editor's word for the runs it is playing.
 *
 * A run this server spawned has a process to ask the operating system about. A run the editor
 * plays has none: there is no handle here, `exitCode` stays null for as long as the record lasts,
 * and reading that as "still going" turns a game that died during boot into one that may yet
 * announce, which is the answer this was written to stop giving. The editor knows, and is already
 * asked this by `editor_status`. [param editorSays] is null when it will not say, and then the
 * record is what is left. [param now] is when the question is asked, for the play that has not
 * started yet.
 */
export function runIsUp(run: GodotProcess | null, editorSays: boolean | null, now = Date.now()): boolean {
  if (run?.throughEditor !== true) {
    return stillRunning(run);
  }
  // A process that is gone settles it before the editor is taken at its word. Godot went on
  // reporting a game it was playing whose process had been ended from outside, for fifteen seconds
  // and an empty runtime list, which is the editor being stale rather than wrong to consult.
  if (run.announcedPid !== undefined && !alive(run.announcedPid)) {
    return false;
  }
  if (editorSays === false && run.seenPlaying !== true && now - run.startedAt < PLAY_STARTS_WITHIN_MS) {
    return true;
  }
  return editorSays ?? stillRunning(run);
}

/**
 * The run a start ended to happen. The pid is the run's own or the one its game announced, and
 * null for a game the editor was playing that never announced one, which is the one kind of run
 * with no number of any sort.
 */
interface EndedRun {
  readonly pid: number | null;
}

/** The field on a start's answer: the number when there is one, true when a run was ended and has none. */
function endedPreviousRun(ended: EndedRun | null): number | true | undefined {
  if (ended === null) {
    return undefined;
  }
  return ended.pid ?? true;
}

/** A process under the run that is a game of its project, and what says so. */
interface GameUnderTheRun {
  readonly pid: number;
  readonly how: 'announced' | 'command line';
  /** The sentence for the answer: what identified this process as the project's game. */
  readonly identifiedBy: string;
}

/**
 * The processes under a run's, read while the run lived: the games of its project and the rest,
 * or why they could not be read.
 */
type StartedByTheRun =
  | { readonly unknown: 'platform' | 'no process' }
  | {
      readonly unknown: false;
      readonly games: readonly GameUnderTheRun[];
      readonly others: readonly number[];
    };

/** What a stop did about the processes under the run's, or why it could not do anything. */
interface ChildrenEnded {
  readonly ended: readonly GameUnderTheRun[];
  readonly left: readonly number[];
  readonly unknown: false | 'platform' | 'no process';
}

/**
 * Godot's Windows console build, by name: `X_console.exe` is a wrapper that starts `X.exe` beside
 * it as its child and forwards the console to it, so the wrapper is never the game.
 */
const CONSOLE_WRAPPER = /_console(\.exe)?$/i;

/** [param executable] and, when it is the console wrapper, the engine it starts. */
function engineNamesOf(executable: string): string[] {
  return CONSOLE_WRAPPER.test(executable)
    ? [executable, executable.replace(CONSOLE_WRAPPER, '$1')]
    : [executable];
}

/**
 * Whether one of [param games] stands between [param pid] and [param root] in [param tree], the
 * two ends excluded.
 */
function gameBetween(tree: ProcessTree, pid: number, root: number, games: ReadonlySet<number>): boolean {
  return ancestorsIn(tree, pid, root).some((one) => one !== root && games.has(one));
}

/**
 * The games among what the run started, ended; the rest named.
 *
 * Signalled after the run is, and a game that was gone before the signal reached it is ended all
 * the same: one that exits as its slice ends, or one the platform takes down with its parent. It
 * was listed while the run lived and it is gone now, which is the state the caller asked for,
 * whichever side brought it about, and it is not a worker left.
 */
function endChildrenAmong(started: StartedByTheRun): ChildrenEnded {
  if (started.unknown !== false) {
    return { ended: [], left: [], unknown: started.unknown };
  }
  for (const game of started.games) {
    try {
      process.kill(game.pid);
    } catch {
      // Gone between the listing and the signal, with the run.
    }
  }
  return { ended: started.games, left: [...started.others], unknown: false };
}

/**
 * What a stop says about the processes the game started for itself: left running unless the stop
 * was asked to end them, and then what it ended, what it left, or that the platform would not say.
 */
function aboutTheChildren(ended: ChildrenEnded | null, throughEditor: boolean): string {
  const reaches =
    "andChildren ends what it started that is a game of this project: announced as one, or this project's engine run with --path on it.";
  if (ended === null) {
    return throughEditor
      ? `Anything that game started for itself, with OS.create_process or otherwise, is not the editor's to stop and was not signalled; ${reaches}`
      : `Anything that game started for itself, with OS.create_process or otherwise, is a separate process this stop did not signal; ${reaches}`;
  }
  if (ended.unknown === 'platform') {
    return 'andChildren was asked for and this platform would not list what the game had started, so nothing else was ended.';
  }
  if (ended.unknown === 'no process') {
    return 'andChildren was asked for and this run has no process id to list under: the editor plays it and its game announced none, so nothing else was ended.';
  }
  const counted = (n: number): string => `${n} ${n === 1 ? 'process' : 'processes'}`;
  const announced = ended.ended.filter((one) => one.how === 'announced').length;
  const byCommandLine = ended.ended.length - announced;
  const how = [
    announced === 0
      ? ''
      : `${announced} announced as ${announced === 1 ? 'a game' : 'games'} of this project`,
    byCommandLine === 0
      ? ''
      : `${byCommandLine} this project's engine run with --path on it, by ${byCommandLine === 1 ? 'its' : 'their'} command line`,
  ]
    .filter((part) => part !== '')
    .join(' and ');
  const endedToo =
    ended.ended.length === 0
      ? "The game had started nothing that is a game of this project, announced as one or this project's engine run with --path on it, so nothing else was ended."
      : `${counted(ended.ended.length)} the game had started for itself ${ended.ended.length === 1 ? 'was' : 'were'} ended with it, named under endedChildren with what identified ${ended.ended.length === 1 ? 'it' : 'each'} under identifiedBy: ${how}.`;
  const leftToo =
    ended.left.length === 0
      ? ''
      : ` ${counted(ended.left.length)} it had started ${ended.left.length === 1 ? 'was' : 'were'} left, named under childrenLeft: neither announced as a game of this project nor this project's engine run with --path on it, so what ${ended.left.length === 1 ? 'it is' : 'they are'} cannot be told from here.`;
  return `${endedToo}${leftToo}`;
}

/** The sentence a start adds to its message when it ended a run to happen. */
function endedToStartThis(ended: EndedRun | null): string {
  if (ended === null) {
    return '';
  }
  const which =
    ended.pid === null ? 'The game the editor was playing' : `The run that was going, pid ${ended.pid},`;
  return ` ${which} was ended to start this one; its output is no longer what editor_output answers about.`;
}

/** The wait a start gives its game to announce, and the last boot it was sized to when it was. */
interface AnnounceBudget {
  readonly ms: number;
  readonly sizedToMs?: number;
}

/**
 * The longest boot a start notes for the next one. A game that spends ten minutes doing what its
 * arguments asked before its first frame is a run, not a boot, and the next start of the project
 * without those arguments should not wait for it.
 */
const LONGEST_BOOT_NOTED_MS = 5 * 60_000;

/** What was true when the wait for an announcement ran out. */
interface AfterWaiting {
  /** Whether the addon is on disk at all, since a project without it can never announce. */
  readonly addon: boolean;
  readonly budgetMs: number;
  /** The last boot the budget was sized to, when it was longer than usual for that reason. */
  readonly sizedToMs?: number;
  readonly heldAt: StoppedAt | null;
  readonly running: boolean;
  /**
   * Whether this run was given arguments of its own, which the note names as a reason it might be
   * late. A caller who asks for six years of simulation before the first frame is drawn has bought
   * the delay and has no way to see that from here: the same project announces promptly without it.
   */
  readonly withArgs: boolean;
  /**
   * For a run the editor plays, whether the editor has yet said it is playing it. `running` is
   * true either way while the play is within its grace, and the note says which it is: a game
   * that is up and slow to announce, or one the editor has not started yet.
   */
  readonly playingSeen?: boolean;
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
  const state =
    after.playingSeen === false
      ? 'the editor has not yet reported the game as playing, which a restarted editor does not until its scan is over'
      : 'the game is still running';
  // Said when the wait was already longer than usual for this project, so a caller reading the
  // note does not pass a runtimeWaitMs shorter than the one they just had.
  const sized =
    after.sizedToMs === undefined
      ? ''
      : `, half as long again as the ${after.sizedToMs}ms its last game took,`;
  return {
    listening: false,
    mayYetAnnounce: after.running,
    note: after.running
      ? `nothing announced itself within ${after.budgetMs}ms${sized} and ${state}, so it may announce a moment from now: editor_status says whether it has, and editor_run start takes runtimeWaitMs to wait longer than this${after.withArgs ? ', which a run carrying its own arguments may well need, since whatever they ask the game to do before its first frame is inside this wait' : ''}`
      : `nothing announced itself within ${after.budgetMs}ms${sized} and the game is no longer running, so nothing is going to: editor_output has what it printed on the way down`,
    heldAt: null,
  };
}

/**
 * Whether a process is still running, which is asked of two things this server is waiting on: a
 * server that may have replaced it, and an editor that was asked to go.
 *
 * Undefined reads as gone, because a caller that has no process to name has nothing to wait for.
 */
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
 * Which values are not one of the ones their schema lists, named by where they sit.
 *
 * A wrong type is at least visibly wrong. A value outside the listed set is the quieter fault: the
 * argument is spelled right and holds a string, so it survives every check above and then reaches
 * code that does not recognise it and takes the default. `direction: "reversed"` answers with what
 * the resource depends on, which is the opposite question, and nothing in the answer says so.
 *
 * Only strings, and only against a set the schema actually lists, because that is where a typo
 * costs something a caller cannot see. The walk follows the schema rather than the value, so a set
 * listed on an element of a list or on a field of an object is checked exactly as a top-level one
 * is, and a schema that lists nothing asks nothing.
 */
function unlistedValues(schema: unknown, value: unknown, path: string): string[] {
  if (typeof schema !== 'object' || schema === null) {
    return [];
  }
  const fields = schema as Readonly<Record<string, unknown>>;
  const listed = fields['enum'];
  if (Array.isArray(listed) && typeof value === 'string') {
    return listed.includes(value)
      ? []
      : [`${path} as one of ${listed.join(', ')}, not ${JSON.stringify(value)}`];
  }
  if (Array.isArray(value)) {
    return value.flatMap((element, index) => unlistedValues(fields['items'], element, `${path}[${index}]`));
  }
  const properties = fields['properties'];
  if (isPlainObject(properties) && isPlainObject(value)) {
    return Object.entries(value).flatMap(([field, held]) =>
      Object.hasOwn(properties, field) ? unlistedValues(properties[field], held, `${path}.${field}`) : [],
    );
  }
  return [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function outsideTheirLists(spec: ToolSpec, args: OperationParams): string[] {
  return Object.entries(args).flatMap(([name, value]) => unlistedValues(spec.parameters[name], value, name));
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

/**
 * How long to wait for the editor's own class-cache write after it reports a scan finished.
 *
 * The write is deferred past the scan, so the file read the instant the editor goes idle is the
 * one about to be replaced. Two seconds because it is a single small file written on the editor's
 * next idle frame, and because this wait only happens where the write can lose something: an
 * editor holding every class the cache holds writes the same file back.
 */
const CACHE_WRITE_MS = 2_000;

/**
 * How long `editor_status` waits for an editor to say what it is playing.
 *
 * Short because it is a status call over a local socket answered from a field the editor already
 * holds, and because the alternative is what the version check used to hide: an editor that does
 * not serve this tool leaves the request outstanding for the whole tool timeout and the status call
 * waits behind it. A second is many times longer than an answer takes and far less than a caller
 * would wait to be told nothing.
 */
const PLAYING_STATUS_MS = 1_000;

/**
 * How long a scan may take to start before the answer stops waiting on it.
 *
 * `EditorFileSystem.scan()` queues rather than runs, and the editor takes it up on a later frame,
 * so for the first of those frames both of the flags it offers are false and a poll reads the
 * scan as over. Two seconds is far past the frame or two a free editor needs and past what a busy
 * one needs, and it is the horizon on a flag rather than on the scan itself.
 */
const SCAN_START_MS = 2_000;

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

type Section = { operation: string; params: (args: OperationParams, detailed: boolean) => OperationParams };

/**
 * The sections project_info can add, each a headless operation, with what it is asked.
 *
 * `satisfies` against the list the schema offers is what makes the two agree: a section fetchable
 * here and not offered there is unreachable, and one offered there and missing here is refused
 * after the caller read that it existed.
 */
const PROJECT_INFO_SECTIONS: Readonly<Record<string, Section>> = dictionary<Section>({
  autoloads: { operation: 'list_autoloads', params: () => ({}) },
  plugins: { operation: 'list_plugins', params: () => ({}) },
  export_presets: { operation: 'list_export_presets', params: () => ({}) },
  audio_buses: { operation: 'get_audio_buses', params: () => ({}) },
  health: { operation: 'get_project_health', params: () => ({}) },
  validation: {
    operation: 'validate_project',
    params: (args, detailed) => ({ preset: readString(args, 'preset') ?? '', includeSuggestions: detailed }),
  },
} satisfies Record<ProjectInfoSection, Section>);

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
/**
 * Whether the runtime addon in the project announces which editor played a game, which the
 * addon does from the version that reads `GDHARNESS_EDITOR_PID` out of the game's environment.
 * Read from the file rather than remembered, since an upgrade rewrites it under a running server;
 * a project with no addon, or one this server cannot read, announces nothing of the kind.
 */
function runtimeAddonAnnouncesEditors(projectPath: string | null): boolean {
  if (projectPath === null) {
    return false;
  }
  try {
    return readFileSync(join(projectPath, RUNTIME_AUTOLOAD.path), 'utf8').includes('"editor_pid"');
  } catch {
    return false;
  }
}

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
  private readonly defectsSeen = new DefectsSeen();
  /**
   * The engine's version, from the last time anything here asked it.
   *
   * Kept because a defect report has a field for it and was filling it in with "not known at the
   * point this failed" every time: nothing passed it, and asking on the failure path would start a
   * subprocess at the worst possible moment. Whatever was learned earlier in the session is the
   * right answer for a report about that session.
   */
  private lastGodotVersion: string | null = null;
  private lspClient: GodotLSPClient | null = null;
  private dapClient: GodotDAPClient | null = null;
  /** Which client has taken on the project's breakpoint note. See [dapHoldingBreakpointsOf]. */
  private breakpointsSeededOn: GodotDAPClient | null = null;
  private bridgeStartupError: string | null = null;
  private bridgeRetry: NodeJS.Timeout | null = null;
  private successorWatch: NodeJS.Timeout | null = null;
  private lastProjectPath: string | null = null;
  private shutdownInitiated = false;

  /**
   * The editor this server started that has not dialled in yet, by pid, or null.
   *
   * An editor imports a project before it loads a plugin, and on a large one that is minutes. While
   * this process is alive and nothing has connected, the honest answer to "is an editor coming" is
   * yes, whatever the bridge's own grace window says: the window is measured from the port being
   * taken, which is the right reference for an editor that was already running and has to notice,
   * and no reference at all for one started afterwards.
   */
  private launchedEditor: ChildProcess | null = null;

  /**
   * What project.godot held when this server opened an editor on it, until that editor arrives.
   *
   * The restart reports what the editor saved away in its own answer, because it waits for the
   * editor to come back. An open cannot: it returns when the process exists and the save happens
   * during the import, minutes later. So the reading is kept here and `editor_status` makes it once
   * there is an editor to have done the saving, after which there is nothing left to compare.
   */
  private launchedFrom: { projectPath: string; before: Map<string, unknown> | null } | null = null;

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
    const located = await this.locator.find();
    if (!located.ok) {
      console.error(
        `[SERVER] ${GodotLocator.refusal(located).message} Until that is fixed every tool that runs the engine will say so.`,
      );
    } else {
      console.error(`[SERVER] Using Godot at: ${located.path}`);
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
        // Abandoned rather than disconnected. Godot stops the game it is playing when this session
        // sends the protocol's disconnect, `terminateDebuggee: false` and all, so saying goodbye
        // here ended an editor-played run on every reconnect a harness performed.
        await this.dapClient.abandon();
      } catch (error) {
        this.logDebug(`DAP client did not let go cleanly: ${errorMessage(error)}`);
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
      const seenBefore = this.defectsSeen.before(where, errorMessage(error));
      return {
        content: [
          {
            type: 'text',
            text: defectReport(where, error, {
              seenBefore,
              godotVersion: this.lastGodotVersion ?? undefined,
            }),
          },
        ],
        isError: true,
      };
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

    // Also before the one about npm, and for the same reason: a config naming a version this
    // server is not is a fact about this project, and it is the reason an upgrade somebody
    // believes they took has not arrived. It says nothing at all while the two agree.
    const disagreement = this.configDisagreement();
    if (disagreement !== null) {
      this.noticedUpdate = true;
      this.callsSinceNotice = 0;
      return this.saying(answer, {
        config_names_another_version: {
          server_is: SERVER_VERSION,
          said: disagreement,
          what_to_do:
            'Tell the user which version their config names and which one is answering, and that ' +
            'the two will not meet until .mcp.json is right and the MCP server is reconnected. Do ' +
            'not edit their config without asking: which of the two they meant is theirs to say.',
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

  /** What the project's own MCP config asks for, when it is not what is answering. */
  private configDisagreement(): string | null {
    return this.ownProject === null ? null : configDisagrees(this.ownProject, SERVER_VERSION);
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

    const wrong = [...wrongTypes(spec, args), ...outsideTheirLists(spec, args)];
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
        // An op that takes nothing said "takes: ." and left the caller deciding whether that was
        // the whole list or a sentence that had lost its end. The same fix the tool-level refusal
        // already had, which is where this wording came from.
        const takes = argumentsOf(spec, op);
        return {
          ok: false,
          response: this.createErrorResponse(
            `${spec.name} ${op} does not take ${elsewhere.join(', ')}. ${takes.length === 0 ? `${op} takes no arguments.` : `${op} takes: ${takes.join(', ')}.`}`,
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
    if (ENGINE_PASSES[tool]?.[op] !== undefined) {
      return await this.handleRefreshUids(args);
    }
    const headless = HEADLESS_OPERATIONS[tool]?.[op];
    if (headless !== undefined) {
      // Asked of the editor instead, when the caller said so. The two are not the same reading and
      // that is the point of saying: disk is what the file holds and what a check running without
      // anybody's window open can reproduce, the editor is what it has been told, unsaved changes
      // and all. Refused rather than quietly answered from disk when there is no editor, because a
      // caller who asked for the editor's answer and silently got the file's would have no way to
      // know, which is the ambiguity the argument exists to remove.
      const { from: asked, ...answerable } = args;
      if (asked === 'editor') {
        const editorSide = EDITOR_READS[tool]?.[op];
        if (editorSide === undefined) {
          return this.createErrorResponse(`${tool} ${op} cannot be read from the editor, only from disk.`, [
            'Leave from unset, or pass from: "disk"',
          ]);
        }
        if (!this.godotBridge.isConnected()) {
          return this.createErrorResponse(
            `${tool} ${op} was asked of the editor, and no editor has reached this server.`,
            [
              'editor_status says whether the bridge is up and whether an editor may yet connect',
              'Open the project with editor_launch, or pass from: "disk" to read the file instead',
            ],
          );
        }
        const { op: _dropped, ...asks } = answerable;
        const contained = this.containProjectFiles(asks);
        return contained.ok ? await this.handleViaBridge(editorSide, contained.value) : contained.response;
      }
      const answered = await this.headless(headless, answerable);
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
          return await this.handleStopProject(args);
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
              ...whichGame(args),
              root: readNonEmptyString(args, 'nodePath') ?? '/root',
              depth: readPositiveNumber(args, 'depth') ?? 3,
              include_properties: readBoolean(args, 'includeProperties') ?? false,
              properties: readArray(args, 'properties') ?? [],
            });
          case 'find':
            return await this.handleFindRuntimeNodes(args);
          case 'text':
            return await this.handleRuntimeCommand('read_text', {
              ...whichGame(args),
              root: readNonEmptyString(args, 'nodePath') ?? '/root',
              include_hidden: readBoolean(args, 'includeHidden') ?? false,
              limit: readPositiveNumber(args, 'limit') ?? 500,
            });
          case 'rect':
            return await this.handleRuntimeCommand('get_rect', {
              ...whichGame(args),
              path: readNonEmptyString(args, 'nodePath') ?? '',
            });
          case 'property':
            return await this.handleRuntimeCommand('get_property', {
              ...whichGame(args),
              path: readNonEmptyString(args, 'nodePath') ?? '',
              property: readNonEmptyString(args, 'property') ?? '',
            });
          default:
            return await this.handleRuntimeCommand('get_metrics', {
              ...whichGame(args),
              metrics: readArray(args, 'metrics') ?? [],
            });
        }
      case 'runtime_invoke':
        // The value and the arguments are fitted to the property's or the method's own types
        // on the game's side.
        return op === 'set'
          ? await this.handleRuntimeCommand('set_property', {
              ...whichGame(args),
              path: readNonEmptyString(args, 'nodePath') ?? '',
              property: readString(args, 'property') ?? '',
              value: args['value'],
            })
          : await this.handleRuntimeCommand('call_method', {
              ...whichGame(args),
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
            ...whichGame(args),
            path: readNonEmptyString(args, 'nodePath') ?? '',
            button: readString(args, 'button') ?? 'left',
            double: readBoolean(args, 'doubleClick') ?? false,
          });
        }
        if (op === 'choose') {
          // `index` is passed on only when it was given, because the addon reads whether it is
          // there as which of the two ways the caller named the item.
          return await this.handleRuntimeCommand('choose', {
            ...whichGame(args),
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
        const session = this.dapHoldingBreakpointsOf(project.value.path);
        const answered = await this.handleDAP(op === 'set' ? 'dap_set_breakpoint' : 'dap_remove_breakpoint', {
          ...args,
          scriptPath: realPathOr(located.absolutePath),
        });
        if (answered.isError === true) {
          return answered;
        }
        // Written after the adapter has taken it, so the note never claims a line the editor
        // refused, and beside the adapter's answer so the caller sees the whole set it now holds.
        const held = session.breakpointsHeld();
        writeBreakpointNote(project.value.path, held);
        return this.jsonTextResponse({
          ...asParams(JSON.parse(answered.content[0]?.text ?? '{}')),
          held: this.breakpointsAsProjectSpells(project.value.path, held),
          // The editor's own, as it reported them to this session, so a caller reading the whole
          // set sees the lines the user set by hand as well as the ones set here.
          setInEditor: this.breakpointsAsProjectSpells(project.value.path, session.breakpointsInEditor()),
          note: 'The editor keeps a breakpoint set this way for one play. Every breakpoint held here is sent again before each play editor_run starts, and kept in the project for the server after a reconnect.',
          ...this.breakpointsAtRisk(),
        });
      }
      case 'debug_control':
      case 'debug_state': {
        // The console the adapter buffered outlives the game it came from, so reading it needs
        // no session. A stack, a scope and a step all need one, and one that is stopped.
        if (tool === 'debug_state' && op === 'output') {
          return await this.handleDAP('dap_get_output', args);
        }
        const held = await this.debuggedGame(tool === 'debug_control' ? 'move' : 'read');
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
    const located = await this.locator.find();
    if (!located.ok) {
      const refusal = GodotLocator.refusal(located);
      return { ok: false, response: this.createErrorResponse(refusal.message, [...refusal.advice]) };
    }
    return { ok: true, value: located.path };
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
   *
   * [param intent] separates reading the game from moving it, for the one state where they part:
   * a game held at a stop this session was not told about. Its stack cannot be read from here,
   * and letting it go or stepping it is exactly what can be done, and what the next stop this
   * session is told about comes from.
   */
  private async debuggedGame(intent: 'read' | 'move'): Promise<Checked<GodotProcess>> {
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
    // A run the editor plays keeps `exitCode` null for as long as the record lasts, so the refusal
    // above never fires for one that has ended. The editor is asked instead: attaching to the
    // adapter of a game that has gone answered "the editor is playing the game but its debug
    // adapter did not answer", which is two things wrong about one game that was simply over.
    const going = await this.runStillGoing(game);
    if (!going) {
      return {
        ok: false,
        response: this.createErrorResponse(
          'The last run has already ended, so there is no debug session to answer for.',
          [
            'editor_output still reads what it printed, until the next run starts',
            'editor_run start plays another, which the debugger can hold',
          ],
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
    // A session, because the stack and the scopes are answered to one and a stop is not. The stop
    // reaches any connection open when it happens, attached or not, so a server that played the
    // scene already knows; what it cannot do without attaching is read where.
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
      // Not held as far as this session knows, and whether it knows is the question: a session
      // that attached after the stop is shown no stack by the adapter, so the runtime is asked
      // before "running" is said about a game that may be sitting at a breakpoint.
      const hold = await this.holdOf(game, going);
      if (hold.heldAt !== null) {
        if (intent === 'move') {
          return { ok: true, value: game };
        }
        return {
          ok: false,
          response: this.createErrorResponse(
            hold.heldAt === undefined
              ? `Whether the game is held cannot be told from here, so there is no stack to read. ${hold.heldNote ?? ''}`
              : `The game is held, and this server cannot read its stack: ${hold.heldAt.description}.`,
            [
              'debug_control continue lets a held game go, and the next stop is one this session is told about',
              'editor_output says what it printed on the way to where it is',
            ],
          ),
        };
      }
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

  /**
   * Gives every script and shader a current UID, by running the engine's own import pass.
   *
   * This used to load every scene and resave it, which is the one thing it must not do. Outside the
   * editor that round trip writes a header the engine rebuilt from what it could see, so `load_steps`
   * went and, worse, so did the scene's own `uid=`: an op whose whole purpose is keeping UID
   * references resolvable was deleting the UID that other resources point at, in every scene in the
   * project, on a call that named none of them. It reported `scripts_resaved` for those saves too,
   * while `ResourceSaver.save` on a script answers OK headlessly and writes no sidecar at all, so
   * the count said a UID had been made whenever none had.
   *
   * The import pass is what mints a `.uid`, and it leaves scenes byte for byte as they were. What is
   * reported is read off the directory either side of it rather than counted as the engine goes,
   * because the sidecar being there afterwards is the only thing a caller actually wanted to know.
   */
  private async handleRefreshUids(args: OperationParams): Promise<ToolResponse> {
    const project = this.project(args);
    if (!project.ok) {
      return project.response;
    }
    const engine = await this.engine();
    if (!engine.ok) {
      return engine.response;
    }
    const projectPath = project.value.path;

    const before = scriptsWithoutUid(projectPath);
    const imported = await runImport(engine.value, projectPath);
    if (!imported.ok) {
      return this.answer(imported);
    }
    const after = scriptsWithoutUid(projectPath);
    const given = before.filter((script) => !after.includes(script));

    return this.answer({
      ok: true,
      messages: imported.messages,
      payload: {
        uidsCreated: given,
        stillWithoutUid: after,
        // Said rather than implied: the op resaved every scene for as long as it existed, so a
        // caller who knows it by its diff needs telling that the diff is the bug and is gone.
        note:
          after.length > 0
            ? `${after.length} still have no .uid, which is the engine declining to import them rather than this op skipping them. No scene was written.`
            : 'No scene was written: this reads the project and imports it, and does not resave anything.',
      },
    });
  }

  private async operation(
    operation: string,
    params: OperationParams,
    projectPath: string,
  ): Promise<HeadlessOutcome> {
    const engine = await this.engine();
    if (!engine.ok) {
      // The refusal as built, with its reason and advice, rather than a sentence of its own: this
      // and the uid refresh both used to answer "No Godot executable found" over a GODOT_PATH that
      // was set, throwing away the one answer that named the path.
      return {
        ok: false,
        message: engine.response.content.map((block) => block.text).join(' '),
        messages: [],
      };
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
      discard(exportLogs);
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
      discard(reportsDir, userData);
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
    // Said on every answer from a run whose saves could not be moved, whichever way it ended: a
    // tier that failed still wrote wherever it wrote, and the run that found nothing to do is the
    // one exception, since it never started a game.
    const savesNote = savesStayPut() && nothingRan === null ? SAVES_NOT_MOVED_NOTE : undefined;

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
                savesNote,
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
      savesNote,
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
      this.lastGodotVersion = stdout.trim();
      return this.lastGodotVersion;
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
    // from the language server of an editor that may have been running since before the addon it
    // holds was replaced, and nothing in the answer said so: a caller had to make a status call
    // first to know whether to believe it, which nobody does before an answer looks wrong.
    //
    // That is the fault, rather than any claim that a behind editor answers wrongly. A project
    // recorded diagnostics naming lines that were not in the file, gone after a restart, and on
    // their own re-reading a class_name the editor's database had not caught up with explains it
    // without staleness being involved at all. Marked rather than refused for the same reason: a
    // suspicion is not a fault, and refusing would take a working tool away on one.
    const disagrees = this.whereTheFileDisagrees(diagnostics, args);
    return this.jsonTextResponse(
      markIfStale(
        {
          scriptPath: readString(args, 'scriptPath'),
          clean: errors === 0,
          errors,
          warnings: diagnostics.length - errors,
          diagnostics,
          ...disagrees,
        },
        this.godotBridge.getStatus().addonVersion,
        SERVER_VERSION,
      ),
    );
  }

  /**
   * What the project's own files disagree with in a set of diagnostics, and what clears it.
   *
   * Two shapes, because a caller meets both for the same underlying reason and the text connects
   * them not at all. A method added to an existing `class_name` comes back as "is not present on the
   * inferred type" at every caller, while `script_info symbols` lists it from that same language
   * server a moment later. A class the editor has never loaded comes back as a base class it cannot
   * find or an identifier not declared, and mentions no type at all. Both read exactly like real
   * findings, and the only way past either is to decide the tool is wrong, which is a decision that
   * gets cheaper every time it is made.
   *
   * The remedies differ, which is why they are answered separately rather than as one list. An
   * analysed type that has gone stale is only cleared by restarting the editor. A class missing from
   * the cache is what `refresh_classes` rewrites, and a class in the cache that the editor still
   * cannot see is the editor's loaded list being behind. A launched game reads that cache, so these
   * are also the states where the game runs and the diagnostics deny it.
   *
   * Nothing is claimed that the files do not show. A member not found says nothing, since it may be
   * inherited or the diagnostic may simply be right, and calling a real finding stale is the
   * expensive direction. No engine is asked and nothing is re-analysed.
   */
  private whereTheFileDisagrees(diagnostics: unknown[], args: OperationParams): OperationParams {
    const messages = diagnostics
      .map((entry) => asParams(entry)['message'])
      .filter((message): message is string => typeof message === 'string');
    // Before the project is resolved and anything is read, because a clean script is the ordinary
    // answer and this tool is called in a loop over a directory. Nothing below can find anything
    // when no message is of a shape that can be checked at all.
    const worthChecking = messages.some(
      (message) => missingMemberIn(message) !== null || unknownTypeIn(message) !== null,
    );
    const project = worthChecking ? this.project(args) : null;
    if (project === null || !project.ok) {
      return {};
    }
    const projectPath = project.value.path;
    const cached = cachedClasses(projectPath);

    const contradicted =
      cached === null
        ? []
        : contradictedDiagnostics(messages, cached, (resourcePath) => {
            const contained = resolveWithinProject(projectPath, resourcePath);
            if (!contained.ok || !existsSync(contained.absolutePath)) {
              return null;
            }
            try {
              return readFileSync(contained.absolutePath, 'utf8');
            } catch {
              // A script the cache names and the disk will not hand over contradicts nothing, and
              // the diagnostics beside it are still worth answering with.
              return null;
            }
          });

    // The walk of the project is the expensive half, so it happens only for a message that could
    // name a class at all rather than on every call that reached this far.
    const unloaded = messages.some((message) => unknownTypeIn(message) !== null)
      ? unloadedTypes(messages, declaredClasses(projectPath), cached)
      : [];

    const notes: string[] = [];
    if (contradicted.length > 0) {
      // What the stale types are built from, which is the lever rather than a detail: a held copy
      // is refreshed when one of its own dependencies changes and not when it changes itself, so
      // the useful thing to hand a caller is the list of files worth touching. Named from the
      // declaring scripts already read above, so this costs nothing further.
      const dependsOn = new Set<string>();
      for (const one of contradicted) {
        const source = cached === null ? null : this.sourceOfClass(projectPath, one.declaredIn);
        if (source === null || cached === null) {
          continue;
        }
        for (const name of classesNamedIn(source, cached)) {
          if (name !== one.type) {
            dependsOn.add(name);
          }
        }
      }
      notes.push(staleAnalysisNote(contradicted, [...dependsOn]));
    }
    const uncached = unloaded.filter((type) => !type.inTheClassCache);
    if (uncached.length > 0) {
      notes.push(uncachedClassNote(uncached.map((type) => type.type)));
    }
    const stale = unloaded.filter((type) => type.inTheClassCache);
    if (stale.length > 0) {
      notes.push(
        `${stale.map((type) => type.type).join(', ')} ${stale.length === 1 ? 'is' : 'are'} in the class cache and still unresolved here, which is the editor's loaded list being behind rather than anything on disk. A game launched now reads the cache and resolves ${stale.length === 1 ? 'it' : 'them'}, so the run and the diagnostics disagree. editor_rescan clears it, measured against a real editor with waiting the same length ruled out; editor_launch restart also does, and costs more.`,
      );
    }

    return {
      ...(contradicted.length === 0 ? {} : { contradictedByTheFile: contradicted }),
      ...(unloaded.length === 0 ? {} : { typesTheEditorHasNotLoaded: unloaded }),
      ...(notes.length === 0 ? {} : { staleAnalysis: notes.join(' ') }),
    };
  }

  /** A declaring script's text, or null when the path will not open. */
  private sourceOfClass(projectPath: string, resourcePath: string): string | null {
    const contained = resolveWithinProject(projectPath, resourcePath);
    if (!contained.ok || !existsSync(contained.absolutePath)) {
      return null;
    }
    try {
      return readFileSync(contained.absolutePath, 'utf8');
    } catch {
      return null;
    }
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

  private async handleDAP(toolName: string, args: unknown): Promise<ToolResponse> {
    return handleDAPTool(this.dap(), toolName, args);
  }

  /**
   * Why the debug adapter on the port this editor named is not this editor's, or null.
   *
   * Godot has one default debug adapter port and every editor on a machine would take it, so the
   * addon reporting the port its editor's settings name is not the same as that editor having
   * bound it: two editors opened by hand both answer 6006, one of them holds it, and the answer
   * does not say which. A server connecting on that number then reads a console belonging to
   * another project, which is the wrong answer said with every field well-formed. It happened
   * here, to a fixture in this repository, against a real editor of another project on this
   * machine.
   *
   * Null where the operating system will not say who is listening, and null where the editor did
   * not say its own process id. Not knowing whose it is has never been grounds to refuse anywhere
   * else in this server and is not grounds here: the cost of refusing a working setup is a caller
   * who cannot run their game at all.
   */
  private adapterBelongsElsewhere(): string | null {
    const status = this.godotBridge.getStatus();
    const ours = status.editorPid;
    if (ours === undefined) {
      return null;
    }
    const port = this.editorServes('dapPort', 'GDHARNESS_DAP_PORT', DEFAULT_DAP_PORT);
    const holder = listeningPid(port);
    if (holder === null || holder === ours) {
      return null;
    }
    return `The debug adapter on port ${port} belongs to process ${holder}, and the editor on this server's bridge is process ${ours}. Godot gives every editor the same debug adapter port by default, so the one this editor names in its settings is not necessarily the one it holds. Playing the game now would put another editor's console and another project's debugger under this project's name.`;
  }

  /**
   * Whether an editor could still reach this bridge, counting one this server started itself.
   *
   * Two reasons and either is enough. The bridge may be young, which covers an editor that was
   * already running and has to notice the port. Or this server launched one and that process is
   * still alive without having dialled in, which covers the import: an editor loads no plugin until
   * the project is imported, and on a large project that is minutes rather than the half-minute the
   * window allows. Measured downstream at nine minutes, over which the answer read "an editor that
   * is not there" about an editor the same server had just started.
   */
  private anEditorIsStillComing(listeningSince: Date | undefined): boolean {
    return anEditorIsStillComing(listeningSince, this.launchedEditorIsUp());
  }

  /**
   * Whether the editor this server started is still running, asked of the process it started.
   *
   * `exitCode === null && signalCode === null` is this process's own record of a child it holds,
   * which cannot be answered wrongly by the operating system reusing a number.
   *
   * No case disarms this, and that is worth saying rather than leaving for somebody to discover.
   * The old reading asked `alive()` of a remembered pid, and for a process that has exited the two
   * agree: both say no. They part only where the number has been handed to something else, which is
   * not a state a fixture can bring about on demand. What holds it is that the question is asked of
   * a handle this server owns rather than of a number anybody's process might be wearing.
   */
  private launchedEditorIsUp(): boolean {
    return this.launchedEditor?.exitCode === null && this.launchedEditor.signalCode === null;
  }

  /** The one debug adapter client, which the debug tools and an editor-played game share. */
  private dap(): GodotDAPClient {
    const port = this.editorServes('dapPort', 'GDHARNESS_DAP_PORT', DEFAULT_DAP_PORT);
    if (this.dapClient !== null && this.dapClient.port !== port) {
      // Not disconnected first: the client whose port has moved is one whose editor is gone, so
      // there is nothing on the other end of it to say goodbye to.
      this.dapClient = null;
    }
    if (this.dapClient === null) {
      this.dapClient = new GodotDAPClient(port);
      // Written where it lands rather than where it is polled. The sink reads the run in hand each
      // time it fires, so a second play and a run picked up after a reconnect both write to their
      // own file without anything having to remember to re-point it.
      this.dapClient.setOutputSink((line) => {
        this.writeToTranscript(line);
      });
      // The note follows the held set when it changes without a call: a breakpoint of this
      // server's clicked off in the editor's gutter, or a file the adapter would not take back
      // before a play. Without this the next server put back what the user had just removed.
      this.dapClient.setBreakpointsSink((held) => {
        const project = this.godotBridge.getStatus().projectPath ?? this.ownProject;
        if (project !== null) {
          writeBreakpointNote(project, held);
        }
      });
    }
    return this.dapClient;
  }

  /**
   * The adapter client, holding the breakpoints noted in [projectPath] as well as its own.
   *
   * Seeded once per client. What an earlier server set is taken on before this one's first
   * breakpoint call and before its first play, and a client replaced because its editor moved is
   * seeded again, since the set it held went with it.
   */
  private dapHoldingBreakpointsOf(projectPath: string): GodotDAPClient {
    const client = this.dap();
    if (this.breakpointsSeededOn !== client) {
      client.holdBreakpoints(readBreakpointNote(projectPath));
      this.breakpointsSeededOn = client;
    }
    return client;
  }

  /**
   * What a caller should know when the editor is one that clears its breakpoints as a session
   * opens, or when the addon is too old to say. Empty when the editor keeps them.
   *
   * Godot's adapter answers `initialize` by clearing every breakpoint in the script editor unless
   * `network/debug_adapter/sync_breakpoints` is on. The addon turns it on as it loads, so an editor
   * reporting it off is holding an older addon than the one on disk, and the remedy is a restart
   * rather than a setting; an addon that reports nothing is older still.
   */
  private breakpointsAtRisk(): { breakpointsAtRisk?: string } {
    const status = this.godotBridge.getStatus();
    if (!status.connected || status.syncsBreakpoints === true) {
      return {};
    }
    return {
      breakpointsAtRisk:
        status.syncsBreakpoints === false
          ? 'This editor clears every breakpoint in its script editor whenever a debug session opens on its adapter, which this server does for its first breakpoint or stack read: network/debug_adapter/sync_breakpoints is off. The installed addon turns it on as it loads, so the editor is running an older one; editor_launch restart puts the installed addon in, or turn the setting on in Editor Settings > Network > Debug Adapter.'
          : 'Whether this editor keeps its breakpoints when a debug session opens cannot be told: the addon it is running predates the report. Godot clears them unless network/debug_adapter/sync_breakpoints is on, which the installed addon turns on as it loads; editor_launch restart puts the installed addon in.',
    };
  }

  /** The held set as the project spells its files, which is how the caller named them. */
  private breakpointsAsProjectSpells(
    projectPath: string,
    held: readonly HeldBreakpoint[],
  ): { scriptPath: string; lines: readonly number[] }[] {
    return held.map((one) => ({
      scriptPath: projectSpelling(projectPath, one.scriptPath),
      lines: one.lines,
    }));
  }

  /**
   * Appends one console line to the editor-played run's own file, if there is one to write to.
   *
   * Failures are swallowed rather than raised: this runs on a socket event with no caller to
   * answer, and the buffer still has the line for whoever polls next.
   */
  private writeToTranscript(line: string): void {
    const run = this.activeProcess;
    if (run?.throughEditor !== true || run.transcript === null) {
      return;
    }
    try {
      appendFileSync(run.transcript, line.endsWith('\n') ? line : `${line}\n`);
    } catch (error) {
      this.logDebug(`Could not write an editor-played run's transcript: ${errorMessage(error)}`);
    }
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

  /**
   * A restart another server began on this project and was ended before finishing, or null.
   *
   * Only while nothing is connected: an editor being there settles the debt whoever opened it, and
   * the note is taken down here so it is not reported again by the next server after this one.
   */
  private restartLeftUnfinished(connected: boolean): RestartNote | null {
    if (this.ownProject === null) {
      return null;
    }
    const owed = restartOwed(this.ownProject);
    if (owed === null) {
      return null;
    }
    if (connected) {
      restartSettled(this.ownProject);
      return null;
    }
    return owed;
  }

  private getEditorStatusPayload() {
    const status = this.godotBridge.getStatus();
    const isPortConflict = this.bridgeStartupError?.includes('EADDRINUSE') ?? false;
    // The addon an editor loaded at startup, against the one this server ships. An install
    // replaces the files under a running editor without changing what it is serving, and the
    // only other sign of that is a tool answering as the old version did.
    const stale = status.connected && status.addonVersion !== SERVER_VERSION;
    const unfinished = this.restartLeftUnfinished(status.connected);
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
      //
      // Except when a restart was left half done, which is the one state where this server has
      // positive evidence about the editor it would otherwise be waiting for: it was asked to quit,
      // and the launch that would have replaced it never ran. Nothing is coming, and a young server
      // answering from its own age sent a caller into a wait that could not end.
      mayYetConnect: status.connected
        ? undefined
        : unfinished !== null
          ? false
          : this.anEditorIsStillComing(status.listeningSince),
      restartInterrupted:
        unfinished === null
          ? undefined
          : {
              quitEditorPid: unfinished.editorPid,
              quitAt: unfinished.quitAt,
              byServerPid: unfinished.byPid,
              note: "A restart begun by a previous gdharness server asked this project's editor to quit, and that server was ended before it could start the editor again, so nothing is coming. editor_launch open starts one, and clears this.",
            },
      // Which of the two reasons the line above is true, when it is the launch. A caller told only
      // "yes" cannot tell a window that will close in seconds from an import that will take
      // minutes, and the pid is the thing they can watch.
      awaitingLaunchedEditor:
        status.connected || !this.launchedEditorIsUp() ? undefined : (this.launchedEditor?.pid ?? undefined),
      // What the editor this server opened saved away on its way in, said once. The restart says
      // this in its own answer; an open cannot, because it returns before the save happens.
      ...(status.connected ? this.whatTheLaunchedEditorDropped() : {}),
      startupError: this.bridgeStartupError,
      staleNote: stale ? addonMismatch(status.addonVersion, SERVER_VERSION) : undefined,
      ...this.breakpointsAtRisk(),
      retryingBridge: this.bridgeRetry === null ? undefined : true,
      // Where the editor was told to look, when this server knows which project to tell. Worth
      // reporting because it is the difference between an editor that cannot find this server
      // and one that has not been restarted: both look like an editor that is not there.
      announcedAt: this.announcedAt ?? undefined,
      // The third version in play. `addonIsStale` catches an editor that has not been restarted;
      // this catches the other way round, a project upgraded while this server kept running, and
      // nothing reported that at all: the answer was that everything was fine.
      projectIs: this.projectHasMovedOn() ?? undefined,
      // And the fourth, which is the one nobody was looking at: the version the config names is
      // what the client fetches next time, and it is not moved by moving a pin kept elsewhere.
      configIs: this.configDisagreement() ?? undefined,
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
    // Asked of any connected editor, including one running an addon from another version. It used
    // to require the versions to match, and what that cost was that `playingInEditor` was null for
    // the whole time an addon was behind, so a game the editor was playing could not be picked up
    // and a server that had not started that game itself said "No game is running" about one on
    // screen. Measured: one editor, one server, the same engine, the 0.13.30 addon answering null
    // and the current one answering the scene it is playing.
    //
    // What the version check was buying, which was not nothing and is why the wait below exists: an
    // editor that does not answer this call at all leaves the request outstanding for the whole
    // tool timeout, and `editor_status` waits on it. Two fixtures with a greeting editor that
    // serves no tools went from answering at once to timing out at twenty seconds. So the question
    // is asked of everybody and the answer is waited for briefly: this is a status call on a local
    // socket, and an editor that has not replied in a moment is one with nothing to say here.
    if (!status.connected) {
      return null;
    }
    try {
      const askedAt = Date.now();
      const asked = this.godotBridge.invokeTool('playing_status', {});
      const answer = await Promise.race([asked, delay(PLAYING_STATUS_MS).then(() => null)]);
      if (answer === null) {
        // Logged with how late the answer was, when it comes, because a status the editor
        // answers late reads exactly like one it never answered, and the two send a reader to
        // different places: a start on the Windows leg sat nine seconds on a played game the
        // editor had already said was over, and nothing in the log said which.
        this.logDebug(`playing_status did not answer within ${PLAYING_STATUS_MS}ms`);
        asked
          .then(() => {
            this.logDebug(`playing_status answered after ${Date.now() - askedAt}ms`);
          })
          .catch(() => {});
        return null;
      }
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
    const located = await this.locator.find();

    // Every announced game is pinged, so a game that announced and then hung is reported as
    // such rather than counted as reachable on the strength of its announcement. With the short
    // wait, not the runtime timeout: a game held at a breakpoint accepts the connection and never
    // answers, and a status call that waited the full ten seconds on it was the first call an
    // agent makes taking longest exactly when the answer was already decided.
    const announced = runtimesAnnounced();
    const pinged = Promise.all(
      announced.running.map(async (endpoint) => {
        // Not asked when the session was told: a game it knows is held is listed as held, with
        // what lets it go, rather than pinged for the wait and listed as possibly paused.
        const held = this.knownHoldOn(endpoint, announced.running);
        const reply =
          held === null
            ? await runtimeRequest(endpoint, 'ping', {}, HOLD_PING_MS)
            : {
                ok: false as const,
                message: `The game is held by the editor's debugger, ${describeHalt(held)}, and answers no runtime call while it is. debug_control continue lets it go.`,
              };
        return {
          pid: endpoint.pid,
          port: endpoint.port,
          project: endpoint.project,
          // Which editor played it, as the game announced: a game the editor played, and
          // whatever that game started for itself, carries the editor's process id; a game
          // another server started carries none. Absent when the game announced none.
          editorPid: endpoint.editorPid,
          reachable: reply.ok,
          problem: reply.ok ? null : reply.message,
        };
      }),
    );
    // Whether the run is held, said here as well as by editor_output: the list above names a held
    // game as unreachable with a problem that says it may be paused, and the session can often say
    // rather than guess. Alongside the pings, since the one wait a held game costs is paid once.
    const asked = (async () => {
      const playing = await this.editorPlayingState();
      await this.pickUpWhatTheEditorIsPlaying();
      const current = this.currentRun();
      // Judged the same way `editor_output` judges `running`, and with the editor's answer that
      // this call has already gone and got. A run the editor plays has no handle and no pid here,
      // so `stillRunning` alone can only say yes for as long as the record lasts: a game that
      // quit went on being reported as active, in the same answer that carried the editor saying
      // it was playing nothing. Two fields about one question, one of them asking and one of them
      // remembering. The hold is judged from the same answer, so a run that is over is held
      // nowhere in the same call that says it is over.
      const active = current === null ? false : await this.runStillGoing(current, playing?.playing ?? null);
      return {
        playing,
        active,
        hold: current === null ? {} : await this.holdOf(current, active),
      };
    })();
    const [games, { playing, active, hold }] = await Promise.all([pinged, asked]);
    return this.jsonTextResponse({
      editor: {
        ...this.getEditorStatusPayload(),
        // Asked of the editor rather than remembered from when it greeted this server: the
        // debugger takes a port again before every play, so the one in the greeting is a number
        // it has already moved off.
        debugPort: playing?.debugPort ?? this.godotBridge.getStatus().debugPort,
      },
      godot: {
        path: located.ok ? located.path : null,
        version: located.ok ? await this.godotVersion(located.path) : null,
        // Why there is none, when GODOT_PATH names something: a null path beside a null version
        // reads as a machine with no engine, and a variable pointing at the wrong file is not that.
        problem: located.ok ? undefined : GodotLocator.refusal(located).message,
      },
      game: {
        // The record too, or "is something running" answers no about a run this server did not
        // start, which after a reconnect is every run.
        processActive: active,
        playingInEditor: playing,
        // The same three answers editor_output gives, for the same run: absent when there is no
        // run to ask about.
        ...hold,
        runtimeConnected: games.some((game) => game.reachable),
        runtimes: games,
        // Games announcing a protocol this server was not built to read. Apart from the list above
        // rather than folded into it, because nothing here can reach them and calling them runtimes
        // would offer tools that cannot work. Reported at all because the alternative is `runtimes:
        // []` during an upgrade window, which says nothing is running about a game that is, and the
        // runtime_* tools already name these: the call an agent makes before anything else should
        // not be the one that cannot see them.
        unreadable: announced.unspoken.map((game) => ({
          pid: game.pid,
          project: game.project,
          protocol: game.protocol,
          serverSpeaks: RUNTIME_PROTOCOL,
          behind: game.protocol > RUNTIME_PROTOCOL ? 'server' : 'addon',
        })),
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
  /**
   * What project.godot names right now, or null when it could not be read.
   *
   * Null rather than an empty map, because the two are opposite answers to the question this feeds.
   * An empty map says the file was read and names nothing, and a comparison against it reports that
   * nothing was dropped. A file that could not be read supports no such conclusion, and returning
   * the same value for both is how "nothing was lost" gets said about a reading that never happened.
   * What that costs is the one thing this report exists for: a key pinned at its own default is
   * dropped on save, and nothing else will ever say it has gone.
   */
  private settingKeysOf(projectPath: string | undefined): Map<string, unknown> | null {
    if (projectPath === undefined) {
      return null;
    }
    try {
      return settingKeys(readFileSync(join(projectPath, 'project.godot'), 'utf8'));
    } catch {
      return null;
    }
  }

  private async handleRestartEditor(): Promise<ToolResponse> {
    const before = this.godotBridge.getStatus();
    if (!before.connected) {
      return this.createErrorResponse('No editor is connected, so there is nothing to restart.', [
        'editor_launch opens one on a project',
        'editor_status says whether the bridge is up and what has reached it',
      ]);
    }

    // What project.godot says before the editor is asked to go, because saving it on the way out
    // is not a copy: Godot writes only what differs from its own defaults, so a key named on
    // purpose at its default value is redundant to the editor and is dropped. A project that pins
    // one there is doing it to keep "off by decision" and "absent" apart, and losing it silently
    // hands the choice back to the engine. Measured downstream: one restart took
    // `gdscript/warnings/return_value_discarded=0` out and changed nothing else.
    const settingsBefore = this.settingKeysOf(before.projectPath);
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
    const back = await this.waitForBridge(
      () => theEditorHasComeBack(this.godotBridge.getStatus(), startedAt),
      began + EDITOR_RESTART_TIMEOUT_MS,
    );

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
    const after = this.settingKeysOf(before.projectPath);
    // With the value each one had, because naming the key alone leaves the caller to go and find
    // what it was set to in a file that no longer has the line. Downstream this has fired on three
    // consecutive restarts of the same project, so it is not a curiosity to read once: it is the
    // only thing keeping that setting alive, and what it is worth depends on how few steps there
    // are between reading it and putting the value back.
    return this.jsonTextResponse({
      restarted: true,
      editorPid: now.editorPid,
      addonVersion: now.addonVersion,
      serverVersion: SERVER_VERSION,
      addonIsStale: now.addonVersion !== SERVER_VERSION,
      staleNote: addonMismatch(now.addonVersion, SERVER_VERSION),
      ...this.whatTheEditorDropped(settingsBefore, after),
      tookMs: Date.now() - began,
    });
  }

  /**
   * The settings an editor saved away, as the fields that report them.
   *
   * One home for the comparison and the sentence, because the same thing happens on an `open` and
   * the answer there said nothing at all about it. Godot does the stripping either way; the two
   * calls differ only in when they can notice, so they should not differ in what they say.
   *
   * With the value each one held, because naming the key alone leaves the caller to go and find
   * what it was set to in a file that no longer has the line. Downstream this has fired on six
   * launches of the same project, so it is not a curiosity to read once: it is the only thing
   * keeping that setting alive, and what it is worth depends on how few steps there are between
   * reading it and putting the value back.
   */
  /**
   * The same report for an editor this server opened, made once the editor is there.
   *
   * Cleared whether or not anything was dropped, because the question is answered either way and a
   * reading kept past its answer would be compared against a file somebody has since edited.
   */
  private whatTheLaunchedEditorDropped(): OperationParams {
    const watched = this.launchedFrom;
    if (watched === null) {
      return {};
    }
    this.launchedFrom = null;
    return this.whatTheEditorDropped(watched.before, this.settingKeysOf(watched.projectPath));
  }

  private whatTheEditorDropped(
    before: Map<string, unknown> | null,
    after: Map<string, unknown> | null,
  ): OperationParams {
    return settingsDroppedReport(before, after);
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

    // Written before the quit is sent, because the gap between the two acts is where this server
    // can be ended: a caller restarts the editor to take an upgrade, and the user reconnects the
    // harness for the same upgrade in the same minute. The successor then finds nothing connected
    // and no reason to think anything is owed, unless it is told.
    noteRestartBegun({
      projectPath,
      editorPid: editorPid ?? null,
      ports,
      quitAt: new Date().toISOString(),
      byPid: process.pid,
    });
    const asked = await this.handleViaBridge('quit_editor', {});
    if (asked.isError === true) {
      restartSettled(projectPath);
      return asked;
    }
    // Waited for rather than assumed. The editor saves on its way out, so it is not gone the moment
    // it answers, and starting the replacement while it still holds its ports is how the new one
    // comes up on neither of them.
    //
    // The number rather than the handle, which is the opposite of what `mayYetConnect` asks and is
    // deliberate. Both readings are unsound under pid reuse and they fail in opposite directions:
    // the number says an editor that has gone is still going, and waits out the timeout before
    // opening a replacement that then works, while a handle belonging to an earlier editor of ours
    // says gone about the editor actually on the bridge, and opens the replacement while that one
    // still holds the ports, which is the thing this wait exists to prevent. A deadline covers the
    // first and nothing covers the second.
    await this.waitForBridge(() => !alive(editorPid), Date.now() + EDITOR_RESTART_TIMEOUT_MS);

    const opened = await this.openAnEditor(engine.value, projectPath, ports);
    // Settled either way: a launch that failed is answered to the caller who asked, which is not
    // an interruption, and leaving the note would have the next server explain a failure this one
    // already explained.
    restartSettled(projectPath);
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
    // Read before the editor is started, for the same reason the restart reads it: opening a
    // project imports it and saves project.godot, and Godot drops a key that is at its own default.
    // A restart can say so in its own answer because it waits for the editor to come back. This
    // returns as soon as the process exists, minutes before the save, so what it can do is
    // remember and let editor_status say it once the editor is actually there.
    const before = this.settingKeysOf(project.value.path);
    // Read before the launch settles it, so the answer can say this open finished something
    // rather than started something.
    const unfinished = restartOwed(project.value.path);
    const opened = await this.openAnEditor(engine.value, project.value.path, ports);
    if (opened.error !== null) {
      return this.createErrorResponse(`Could not start the editor: ${opened.error}`);
    }
    restartSettled(project.value.path);
    this.launchedFrom = { projectPath: project.value.path, before };
    return this.jsonTextResponse({
      launched: true,
      pid: opened.pid,
      projectPath: project.value.path,
      lspPort: ports.lsp,
      dapPort: ports.dap,
      finishesRestart:
        unfinished === null
          ? undefined
          : `This is the launch half of a restart begun at ${unfinished.quitAt} by server pid ${unfinished.byPid}, which quit editor pid ${unfinished.editorPid ?? 'unknown'} and was ended before it could start one.`,
      settingsNote:
        before === null
          ? 'project.godot could not be read before this editor was opened, so nothing here will be able to say what the import saved away. Opening a project rewrites the file and drops any key sitting at its own default.'
          : before.size === 0
            ? undefined
            : 'Opening a project imports it and saves project.godot, and Godot drops any key sitting at its own default. editor_status names anything lost under settingsDropped once this editor has connected.',
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
    // Remembered so that "nothing is coming" and "the editor this server just started is still
    // importing" stop being the same answer. The grace window is measured from the bridge taking
    // its port, which is the right reference for an editor that was already up and has to notice,
    // and no reference at all for one started afterwards: a launch on a server that has been up
    // longer than the window reads as final the moment it returns.
    //
    // The process rather than its number, because the number is only good while the process holds
    // it. This was a bare pid asked `alive()`, set once and never cleared, so an editor that
    // exited without connecting left the pid behind and any later process the operating system
    // handed it to answered yes: the server would then report that an editor it started was still
    // on its way, and name a pid belonging to something else. A downstream reading of
    // `mayYetConnect: true` with a game running and `false` once the game stopped is consistent
    // with exactly that, and the same reasoning already forbids ending a run by pid alone here.
    // Only when it has a number, because a child with none never started, and a handle whose
    // `exitCode` has not been set yet would otherwise report an editor on its way that does not
    // exist. A spawn that failed outright has already returned above.
    this.launchedEditor = editor.pid === undefined ? null : editor;
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
    // Whether there is one to end is asked the way every other answer asks it, so a played run
    // the editor says is over is not "ended" here and then reported as ended; and a played run
    // that is going is named by the number its game announced, when it announced one. The editor
    // is asked what it is playing first, as every answer about a run asks it: a replacement
    // server had no record of the game the editor was playing, so its start had the editor stop
    // that game and said nothing about it.
    await this.pickUpWhatTheEditorIsPlaying();
    let ended: EndedRun | null = null;
    const before = this.currentRun();
    if (before !== null && (await this.runStillGoing(before))) {
      this.logDebug('Ending the running game before starting another');
      ended = { pid: before.pid ?? this.announcedPidOf(before) ?? null };
      await this.endActiveGame(
        'editor_run start, which ends the run that was going before it starts another',
      );
    }

    // Taken before anything starts, so the game waited for below is one nobody had seen: a game
    // that has just been ended can still be dying with its announcement on disk.
    const alreadyPlaying = new Set(discoverRuntimes().map((endpoint) => endpoint.pid));
    // Games of this project that were here before the start and that ending the previous run did
    // not take with it. Read now rather than afterwards, because the game about to start announces
    // itself too and would otherwise be reported as something it left behind.
    const wereHereFirst = this.everyRuntimeOfOurs();

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
    const runtimeWaitMs = this.announceBudget(args, project.value.path);
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
    // For a game that announces after the start's wait under a number the handle does not have,
    // which the Windows console build does: the tie then falls to freshness, as a played run's.
    started.announcedBefore = alreadyPlaying;
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
    const endedForThis = endedToStartThis(ended);
    // A game of this project that was already running and that this server cannot read. It is not
    // in `ended`, because ending a run goes through the sweep that drops these, so the start left
    // it running and said nothing: two games, one of them unmentioned and unreachable. Said on the
    // answer that caused it rather than only in the refusal a later call would have given.
    // Readable or not. A game announced for this project that this server did not start is one a
    // spawned start does not replace, whether the reason it cannot be reached is a protocol gap or
    // simply that nothing here holds it: the refusals for those two states both said a start would
    // end it, and a start measured against each left it running.
    const stranded = wereHereFirst.filter((one) => one.pid !== ended?.pid && alive(one.pid));
    const named = stranded
      .map((one) => (one.protocol === null ? `pid ${one.pid}` : `pid ${one.pid} on protocol ${one.protocol}`))
      .join(', ');
    const alsoRunning =
      stranded.length === 0
        ? ''
        : ` A game of this project was already running and still is: ${named}. Starting this one did not end it and nothing here can, because this server did not start it. End it yourself, or bring the halves to one version where a protocol is named.`;
    return this.jsonTextResponse({
      started: true,
      through: 'gdharness',
      alsoRunning: stranded.length === 0 ? undefined : stranded.map((one) => one.pid),
      pid: started.process.pid ?? null,
      arguments: cmdArgs,
      // Named here rather than only by editor_output, because a caller who wants to watch the
      // file had to make a second call to learn it and a reconstructed name is worse than no
      // name: a tail on a path that does not exist reports nothing, which is exactly what a run
      // that has not printed yet looks like.
      transcript: started.transcript,
      refreshedClasses: refreshed.value,
      // Which run this start ended, when it ended one, so a bench that stopped is answered for
      // here rather than looked for in the engine.
      endedPreviousRun: endedPreviousRun(ended),
      runtime: await this.runtimeUp(
        project.value.path,
        alreadyPlaying,
        runtimeWaitMs,
        given.value.length > 0,
      ),
      message: `Use editor_output for what it prints and editor_run stop to end it.${spawnedInstead}${endedForThis}${alsoRunning}`,
    });
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
    budget: AnnounceBudget,
    withArgs: boolean,
  ): Promise<Record<string, unknown>> {
    const budgetMs = budget.ms;
    if (!existsSync(join(projectPath, RUNTIME_AUTOLOAD.path))) {
      return runtimeVerdict(null, { addon: false, budgetMs, heldAt: null, running: false, withArgs });
    }
    // The editor is asked about a run it is playing no more often than the wait loop asks it, so
    // a look every fifty milliseconds does not become a request every fifty milliseconds, and
    // beside the looks rather than between them: an editor that does not answer holds the
    // question for a second, and an announcement that lands in that second should not wait it out.
    let asking: Promise<void> | null = null;
    let editorAskedAt = 0;
    let editorSaysGoing = true;
    let editorAsks = 0;
    const waitBegan = Date.now();
    // Read through a call rather than directly, since the variable is written from the closure
    // below and the type checker reads it as never changing.
    const lastSaid = (): string => (editorSaysGoing ? 'playing' : 'not playing');
    const endpoint = await announcedSince(projectPath, before, {
      budgetMs,
      // Not a game of this project that somebody else started: for a run the editor plays, one
      // naming another editor as the one that played it, or none where the project's games name
      // theirs; for a run started here, one naming the editor at all, since a game this server
      // spawned inherited no editor to name. A start that took a stranger's game for its own
      // answered listening about a process it did not start while its own was still booting,
      // and a spawned start judged by the played rule waited its whole budget on its own game.
      accept: (one) => this.isTheGameOf(this.currentRun(), one, projectPath),
      // A game held at a breakpoint set before the run is not booting any more, and waiting out
      // the budget on one says nothing. It cannot announce until it is let go. Nor is there
      // anything to wait for once the process is over: a boot that fails on a parse error is
      // gone in half a second, and sitting out the rest of the budget delays the answer that
      // says so. The announcement is looked for before this is asked, so a game that announced
      // and then quit is still found. A run the editor plays has no process to ask, so the editor
      // is asked instead: without that a played scene that died on boot was waited for the whole
      // budget and then reported, correctly, as no longer running.
      giveUp: () => {
        if (this.dapClient?.isStopped() === true) {
          return true;
        }
        const run = this.currentRun();
        if (run === null || !run.throughEditor) {
          return !stillRunning(run);
        }
        if (asking === null && Date.now() - editorAskedAt >= RUN_POLL_MS) {
          editorAskedAt = Date.now();
          editorAsks += 1;
          asking = this.runStillGoing(run)
            .then((going) => {
              editorSaysGoing = going;
            })
            .finally(() => {
              asking = null;
            });
        }
        return !editorSaysGoing;
      },
    });
    // How the wait ended, for the log a slow start is read back from: what it found, how long it
    // took, and how often the editor was asked on the way.
    this.logDebug(
      `announce wait ended after ${Date.now() - waitBegan}ms: ${
        endpoint === null ? 'nothing announced' : `pid ${endpoint.pid} announced`
      }, editor asked ${editorAsks} times, last said ${lastSaid()}`,
    );
    // Kept on the run: a number the game gave for itself, which is what the announcement was
    // waited for. For a run the editor plays it is the only process the run has, so its liveness
    // is the editor's word without it. For a run started here it is usually the handle's own
    // number and not always: the Windows console build is a wrapper that starts the engine as its
    // child, so the game announces a number the handle does not have, and a runtime call asking
    // for this server's own game found nothing under the handle's. Only when it is this run's:
    // `announcedSince` excludes everything that was already announced before the start.
    const going = this.currentRun();
    if (endpoint !== null && going !== null && going.announcedPid === undefined) {
      going.announcedPid = endpoint.pid;
      this.noteBootOf(going, endpoint);
    }
    return runtimeVerdict(endpoint, {
      addon: true,
      budgetMs,
      ...(budget.sizedToMs === undefined ? {} : { sizedToMs: budget.sizedToMs }),
      heldAt: this.dapClient?.whereItStopped() ?? null,
      // Only asked when there is no announcement to answer with: a game that announced is up, and
      // asking the editor about a played one costs a round trip the answer would not use.
      running: endpoint !== null || (going !== null && (await this.runStillGoing(going))),
      withArgs,
      ...(going?.throughEditor === true ? { playingSeen: going.seenPlaying === true } : {}),
    });
  }

  /**
   * The wait a start gives its game to announce: what the caller asked for, or else the usual
   * budget sized to the project's last boot, and which of the two it was.
   */
  private announceBudget(args: OperationParams, projectPath: string): AnnounceBudget {
    const asked = readNonNegativeNumber(args, 'runtimeWaitMs');
    if (asked !== undefined) {
      return { ms: asked };
    }
    const lastBoot = readBootNote(projectPath);
    const ms = waitSizedTo(lastBoot);
    return lastBoot !== null && ms > ANNOUNCE_BUDGET_MS ? { ms, sizedToMs: lastBoot } : { ms };
  }

  /**
   * How long [param run]'s game took to announce, noted for the next start of its project.
   *
   * From the announcement's own time rather than from when the tie was made, since a game tied
   * late, at the first status call after the start's wait ran out, announced well before that
   * call. Only a reading that can be one: a file older than the run is a stranger's, and a boot
   * of more than a few minutes is a run doing what it was asked before its first frame, which is
   * not what the next start should be sized to.
   */
  private noteBootOf(run: GodotProcess, endpoint: RuntimeEndpoint): void {
    if (run.projectPath === null) {
      return;
    }
    let announcedAt: number;
    try {
      announcedAt = statSync(endpoint.file).mtimeMs;
    } catch {
      return;
    }
    const took = announcedAt - run.startedAt;
    if (took > 0 && took <= LONGEST_BOOT_NOTED_MS) {
      writeBootNote(run.projectPath, took);
    }
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
    runtimeWaitMs: AnnounceBudget,
    ended: EndedRun | null,
  ): Promise<ToolResponse> {
    const log = new GameLog();
    try {
      await this.dap().connect();
      // Whatever the adapter is still holding belongs to the play before this one. Its buffer
      // survives the run that filled it, and the first drain after a new play took the lot: a
      // finished bench's ten-row table arrived at indices 0 to 29 of the new run's answer, under
      // the new run's startedAt, with the engine's banner in the middle as the only boundary. A
      // scene that cannot print a bench table was reported as having printed one. Dropped before
      // the editor is asked to play, so nothing of the new run's own is thrown away with it.
      this.dapClient?.getOutput(true);
    } catch (error) {
      return this.createErrorResponse(
        `The editor is connected but its debug adapter is not: ${errorMessage(error)}`,
        [
          `This asked on port ${this.dap().port}, which is where the connected editor says it serves`,
          'GDHARNESS_DAP_PORT points this server at another one',
        ],
      );
    }

    const stranger = this.adapterBelongsElsewhere();
    if (stranger !== null) {
      return this.createErrorResponse(stranger, [
        'editor_status names the editor on the bridge and the port it says it serves',
        'GDHARNESS_DAP_PORT points this server at the right one',
        'Closing the other editor, or moving its debug adapter port in its editor settings, frees this one',
      ]);
    }

    // Every breakpoint held, sent again: the editor keeps one set through the adapter for a
    // single play, measured, so the second play through a breakpoint ran straight past it.
    const breakpoints = await this.dapHoldingBreakpointsOf(projectPath).reapplyBreakpoints();

    const answer = await this.handleViaBridge(
      'play_scene',
      scene === null ? {} : { scenePath: `res://${scene}` },
    );
    if (answer.isError === true) {
      return answer;
    }

    // A file of its own for a run the editor plays. Its console comes over the adapter and used to
    // live only in the buffer of the server holding it, so a reconnect took the whole run's output
    // with it and the answer could explain the loss but not undo it. Written here as it is drained,
    // the run survives its server the way a spawned one does.
    const startedAt = Date.now();
    const transcript = openTranscript(startedAt);
    closeSync(transcript.fd);
    const playAnswer = asParams(JSON.parse(answer.content[0]?.text ?? '{}'));
    const played: GodotProcess = {
      process: null,
      pid: null,
      log,
      transcript: transcript.path,
      readOffset: 0,
      projectPath,
      startedAt,
      exitCode: null,
      throughEditor: true,
      brokeOn: null,
      announcedBefore: alreadyPlaying,
      seenPlaying: readBoolean(playAnswer, 'playing') === true,
    };
    this.activeProcess = played;
    writeEditorRunNote({ projectPath, transcript: transcript.path, startedAt });
    sweepTranscripts();

    return this.jsonTextResponse({
      started: true,
      through: 'editor',
      scene: scene === null ? 'the main scene' : `res://${scene}`,
      refreshedClasses,
      // Which port the editor's debugger took, since it is the one port Godot has no command
      // line option for and the addon moves itself off when another editor is holding it.
      debugPort: readNumber(playAnswer, 'debugPort'),
      endedPreviousRun: endedPreviousRun(ended),
      // What the game was told to stop on before it started, so a play that runs through a line
      // the caller asked for is checked against this rather than against memory. Absent when
      // nothing is held, and the refusals only when there were any.
      breakpoints:
        breakpoints.applied.length === 0
          ? undefined
          : this.breakpointsAsProjectSpells(projectPath, breakpoints.applied),
      breakpointsRefused:
        breakpoints.refused.length === 0
          ? undefined
          : breakpoints.refused.map((one) => ({
              scriptPath: projectSpelling(projectPath, one.scriptPath),
              reason: one.reason,
            })),
      // No arguments, by construction: a run carrying any is started by this server rather than
      // played by the editor, so the editor path cannot be the one that bought itself a long boot.
      runtime: await this.runtimeUp(projectPath, alreadyPlaying, runtimeWaitMs, false),
      message:
        'The editor is playing it, so its debugger holds it: the debug_* tools can reach it, ' +
        'editor_output reads its console through the debug adapter, and editor_run stop ends it.' +
        endedToStartThis(ended),
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
    if (!game.throughEditor) {
      return;
    }
    this.drainErrorReport(game);
    if (!this.dapClient) {
      return;
    }
    // With a file, the lines are already in it: the adapter writes them there as they arrive, and
    // the log is filled from the file by the transcript read, which is the same path a run this
    // server spawned takes from its pipe. Draining the buffer here as well would put every line in
    // twice. Without a file, the buffer is the only copy and this is the only thing that empties
    // it, which is a run picked up after a reconnect whose first server left no note.
    if (game.transcript === null) {
      for (const line of this.dapClient.getOutput(true)) {
        game.log.append('stdout', line.endsWith('\n') ? line : `${line}\n`);
      }
    }
    // An adapter that has gone is the only source an editor-played run has, and losing it is
    // silent from here: getOutput answers nothing, which is the same nothing a run between prints
    // gives. So a long run went on being reported clean with no entries and nothing saying the
    // console had stopped arriving, while the game's own log had every line. Silence that could
    // mean two things is recorded as the one it is.
    if (!this.dapClient.isConnected()) {
      game.consoleLost = true;
    }
    this.recordWhatItBrokeOn(game);
  }

  /**
   * Moves what the game has reported into the run, for a run the editor plays.
   *
   * The game the editor plays prints to the editor's own stderr, and the debug adapter relays
   * what the game prints and not what it reports: a `push_error` raised in one reached neither
   * `editor_output` nor the transcript, and the run was answered clean while the game had just
   * refused something out loud. The runtime addon takes the report where it is made, with a
   * Logger in the game, and writes it beside the announcement in the lines the engine itself
   * prints, so they are read here the way a run this server started is read from its transcript:
   * into the transcript when the run has one, which the transcript read then picks up, and
   * straight into the log when it has none. By offset, since the file is the game's and grows
   * while nobody is reading.
   */
  private drainErrorReport(game: GodotProcess): void {
    if (game.errorReport === undefined) {
      const its = this.announcedPidOf(game);
      const found = its === undefined ? null : errorReportOf(its);
      if (found === null) {
        return;
      }
      game.errorReport = found;
      game.errorReportOffset = 0;
    }
    let handle: number;
    try {
      handle = openSync(game.errorReport, 'r');
    } catch {
      // Swept, or not there yet: the same answer as a game that has reported nothing.
      return;
    }
    try {
      const from = game.errorReportOffset ?? 0;
      const size = fstatSync(handle).size;
      if (size <= from) {
        return;
      }
      const buffer = Buffer.alloc(size - from);
      const read = readSync(handle, buffer, 0, buffer.length, from);
      game.errorReportOffset = from + read;
      const reported = buffer.subarray(0, read);
      if (game.transcript !== null) {
        appendFileSync(game.transcript, reported);
      } else {
        game.log.append('stderr', reported);
      }
    } finally {
      closeSync(handle);
    }
  }

  /**
   * The error the editor broke the game on, written into the log the way a printed one would be.
   *
   * Godot prints none of it. It halts the game and names the error in the `stopped` event alone,
   * so a log built from what the adapter printed held no trace of it: a game sitting dead at a
   * script error counted zero errors and answered `clean`, while every runtime call against it
   * timed out with nothing anywhere saying why. Measured against a real editor, where a save
   * carrying one bad field broke the game on load and editor_output reported a clean run.
   *
   * Not when the game reports its own errors: the engine logs the error before it breaks on it,
   * measured against a real editor with the report read and the halt seen in one answer, so a
   * run with a report already has the error as an entry with its `at:` line and backtrace, and
   * recording the halt as well counted one error twice. The halt still says where the game is
   * held, under heldAt.
   */
  private recordWhatItBrokeOn(game: GodotProcess): void {
    const halt = this.dapClient?.whereItStopped() ?? null;
    if (
      halt?.reason !== 'exception' ||
      halt.text === '' ||
      game.brokeOn === halt.text ||
      game.errorReport !== undefined
    ) {
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
    // What was signalled, in the run's own log, with the command line the operating system gave for
    // it. A kill by number is the one act here that cannot be taken back, and three runs elsewhere
    // have died with nothing in them to read: a line naming the process this server ended, and what
    // that process said it was, turns "it just stopped" into something somebody can check against
    // the record it was made from.
    const signalled = runningAs(running.pid);
    const described = signalled === null ? 'nothing it would name' : `${signalled.kind}: ${signalled.text}`;
    let landed = true;
    try {
      process.kill(running.pid);
    } catch {
      // Ended between being read and being stopped, which is the state this asks for.
      landed = false;
    }
    // Written after the attempt rather than before it, so the line says what happened rather than
    // what was about to. A note that announces an act it has not performed is wrong for every run
    // that was already over by the time it was signalled, which is the ordinary way a run ends.
    running.log.record(
      'info',
      landed
        ? `gdharness ended pid ${running.pid}, which the operating system described as ${described}.`
        : `gdharness signalled pid ${running.pid} and it was already gone; the operating system had described it as ${described}.`,
    );
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
   * The run the connected editor is playing, picked back up after a reconnect.
   *
   * A reconnect leaves this server with no memory of anything, and the note on disk is written only
   * by runs this server spawns, so an editor-played run leaves none. What was adopted instead was
   * the last spawned run of the same project, and the answer then described that one: a different
   * scene, its own pid, its own transcript, forty rows of its output, and every number in it
   * plausible. A bench's output is a table somebody attributes to the change they just made, so
   * reading another run's rows as your own is a confident wrong measurement with nothing in the
   * payload to contradict it. Two fields did flip, `through` and `pid`, and they are exactly the
   * two a caller reads past when the shape is what they asked for.
   *
   * So the editor is asked first. It is on the bridge, it is holding the run, and it answers what
   * is playing right now, which beats a note about what was started once. Asked before every answer
   * about a run rather than at connect time, because the editor may be given a game to play by
   * somebody who is not this server at all.
   *
   * What it printed before the reconnect is gone: the adapter buffer went with the old server. The
   * answer says so rather than presenting a short log as the whole run.
   */
  private async pickUpWhatTheEditorIsPlaying(): Promise<void> {
    if (!this.godotBridge.isConnected()) {
      return;
    }
    const going = this.activeProcess;
    if (going !== null) {
      // An editor-played run whose adapter has gone, with the editor still playing it. Reconnected
      // here rather than left silent: the gap is already recorded and cannot be filled, and the
      // alternative to trying is a run that prints for another hour into nothing.
      if (going.throughEditor && going.consoleLost === true && (await this.editorPlayingState())?.playing) {
        try {
          await this.dap().connect();
          // The flag stays set. It says the log has a hole in it, which reconnecting does not
          // fill: whatever was printed while nobody was holding the console is gone for good, and
          // a caller reading the lines either side of this marker would otherwise read them as
          // consecutive.
          going.log.append('stdout', '[gdharness] the debug adapter was reconnected here\n');
        } catch (error) {
          this.logDebug(`Could not reconnect the adapter for a playing run: ${errorMessage(error)}`);
        }
      }
      return;
    }
    const playing = await this.editorPlayingState();
    if (playing?.playing !== true) {
      return;
    }
    // Best effort: the console of an editor-played run comes over the adapter and nothing else, so
    // a failure here costs the output rather than the answer, and the answer says which run it is
    // about either way. A session and not only a socket, because whether the run is held at a
    // breakpoint is learned by the session asking, and a picked-up run is exactly the one whose
    // stop was reported to a server that is gone: with a socket alone, editor_output said running
    // about a game sitting on a breakpoint until something else happened to attach.
    try {
      await this.dap().attach();
    } catch (error) {
      this.logDebug(`Picked up an editor-played run without its adapter: ${errorMessage(error)}`);
    }
    // The file the server that started this play was writing, when it left one. Only when it names
    // this editor's project: these directories are shared by every server on the machine, and a
    // note from another project's run would put its output under this one's heading, which is the
    // fault this whole method exists to end.
    const project = this.godotBridge.getStatus().projectPath ?? null;
    const left = readEditorRunNote();
    const note =
      left !== null && project !== null && isSameDirectory(left.projectPath, project) ? left : null;
    const picked: GodotProcess = {
      process: null,
      pid: null,
      log: new GameLog(),
      // The file the answer reads back from, which every path that reports on a run drains before
      // it answers. What is picked up here is where to read, not the reading.
      transcript: note?.transcript ?? null,
      readOffset: 0,
      projectPath: project,
      startedAt: note?.startedAt ?? Date.now(),
      exitCode: null,
      throughEditor: true,
      brokeOn: null,
      pickedUpPlaying: true,
    };
    // No `announcedBefore`: a picked-up run saw nothing announced, so `announcedPidOf` ties it to
    // the one game announced for this project, and the run is asked of the operating system the
    // way the run that started it was. Without a number `running` stayed true after the game had
    // quit for as long as the record lasted, beside a status call taking the editor's word that
    // nothing was playing.
    this.activeProcess = picked;
  }

  /**
   * The process the game of a run announced itself as, tied to the run when it has not been yet.
   *
   * A game that announces inside the start's wait is tied there. One that announces after it, a
   * project that boots for longer than the budget, was never tied at all: a played run went on
   * being judged from the editor's word alone and answered cpu with "nothing here has its process
   * id" while the same call listed the game under runtimes. Tied here to the process the run
   * holds when that is what announced, which is certain, and otherwise to the one game of this
   * project the start did not see announced before it played, and for a picked-up run, which saw
   * nothing, to the one game announced at all.
   *
   * One and not the first of several: a bench opens many workers from one project, and a run tied
   * to the wrong worker is reported over the moment that worker finishes.
   *
   * A game that says which editor played it is told apart from one that does not, or that names
   * another editor: the editor addon marks its environment with its process id and the runtime
   * announces what the game inherited, so a game of the same project that another server started
   * beside the editor's is not the one, however fresh its announcement. The mark reaches whatever
   * the game starts for itself too, so a bench and its workers all carry it and the count still
   * decides between them. Games from a runtime addon that announces no editor are judged by
   * freshness alone, as before.
   */
  private announcedPidOf(run: GodotProcess, announced?: readonly RuntimeEndpoint[]): number | undefined {
    if (run.announcedPid !== undefined) {
      return run.announcedPid;
    }
    // The caller's sweep when it has one: a status call asks this once per announced game, and a
    // bench with thirty workers announced would otherwise read the directory thirty times over.
    const ours = this.announcedOfTheRunsProject(run, announced ?? runtimesAnnounced().running);
    if (run.pid !== null && ours.some((one) => one.pid === run.pid)) {
      run.announcedPid = run.pid;
      return run.announcedPid;
    }
    const before = run.announcedBefore ?? new Set<number>();
    const candidates = ours.filter(
      (one) => !before.has(one.pid) && this.isTheGameOf(run, one, run.projectPath),
    );
    const theOne = candidates.length === 1 ? candidates[0] : undefined;
    if (theOne !== undefined) {
      run.announcedPid = theOne.pid;
      this.noteBootOf(run, theOne);
    }
    return run.announcedPid;
  }

  /**
   * The announced process of the run this server holds, when it is among [param running] and the
   * run is of [param projectPath] when one is named: the game a runtime call means when it names
   * none. A run that is over, or whose game is not announced, or of another project, is nobody's
   * answer here, and the call is judged as it was without this.
   */
  private ownGameAmong(
    running: readonly RuntimeEndpoint[],
    projectPath: string | undefined,
  ): number | undefined {
    const run = this.currentRun();
    if (run === null || !stillRunning(run)) {
      return undefined;
    }
    if (
      projectPath !== undefined &&
      run.projectPath !== null &&
      !isSameDirectory(run.projectPath, projectPath)
    ) {
      return undefined;
    }
    const its = this.announcedPidOf(run, running);
    return its !== undefined && running.some((one) => one.pid === its) ? its : undefined;
  }

  /**
   * `ownGameAmong` for the run that nothing else could tie, asked of the process tree.
   *
   * A bench that announces after the start's wait and opens a worker before anything asks is two
   * games of the project, both fresh, and freshness cannot pick between them: every runtime call
   * from the session that started the bench was refused with "pass pid" from then on. The tree
   * can, which costs an ask of the operating system, so it is asked here, where the answer is
   * needed, and once, since a tie is kept on the run. Nothing to ask when the run has been tied
   * already, which is `ownGameAmong` having judged the tie and found the game gone or elsewhere.
   */
  private async ownGameThroughTheTree(
    running: readonly RuntimeEndpoint[],
    projectPath: string | undefined,
  ): Promise<number | undefined> {
    const run = this.currentRun();
    if (run === null || !stillRunning(run) || run.announcedPid !== undefined) {
      return undefined;
    }
    if (
      projectPath !== undefined &&
      run.projectPath !== null &&
      !isSameDirectory(run.projectPath, projectPath)
    ) {
      return undefined;
    }
    const its = await this.tiedThroughTheTree(run, running);
    return its !== undefined && running.some((one) => one.pid === its) ? its : undefined;
  }

  /**
   * `announcedPidOf` continued through the process tree: the run's own game when nothing else
   * could tie it, at the cost of asking the operating system for the tree, which is a PowerShell
   * start on Windows. Asked only when there is something to decide between, and the tie sticks.
   */
  private async tiedThroughTheTree(
    run: GodotProcess,
    announced: readonly RuntimeEndpoint[],
  ): Promise<number | undefined> {
    if (run.announcedPid !== undefined) {
      return run.announcedPid;
    }
    const ours = this.announcedOfTheRunsProject(run, announced);
    if (ours.length === 0) {
      return undefined;
    }
    const tree = await processTree();
    if (tree === undefined) {
      return undefined;
    }
    return this.tieThroughTheTree(run, tree, new Set(ours.map((one) => one.pid)));
  }

  /**
   * The process doing [param run]'s work, announced or not: the announced game, tied through the
   * tree where it has to be, and otherwise the engine the command lines name under the handle,
   * which is what a run under the Windows console wrapper with no runtime addon has. Undefined
   * when it is the handle itself or nothing says. Kept on the run once found.
   */
  private async gameProcessOf(run: GodotProcess): Promise<number | undefined> {
    if (run.gamePid !== undefined) {
      return run.gamePid;
    }
    const announced = runtimesAnnounced().running;
    const tied = await this.tiedThroughTheTree(run, announced);
    if (tied !== undefined) {
      return tied;
    }
    const tree = await processTree();
    if (tree === undefined) {
      return undefined;
    }
    const found = this.gameByCommandLineIn(run, tree);
    if (found !== undefined) {
      run.gamePid = found;
    }
    return found;
  }

  /**
   * The game of [param run] found in [param tree], and tied to the run when found.
   *
   * The announced process under the run's own with no announced process between the two: a
   * worker has the game above it and a wrapper announces nothing, so with the Windows console
   * build, whose handle is a wrapper that starts the engine as its child, the engine is found and
   * its workers are not. For a run the editor plays, whose game the editor started, the editor's
   * process stands in for the handle. The handle itself when it is announced, which is the
   * ordinary engine. One and not the first of several, as everywhere a tie is made.
   */
  private tieThroughTheTree(
    run: GodotProcess,
    tree: ProcessTree,
    games: ReadonlySet<number>,
  ): number | undefined {
    const root = run.pid ?? (run.throughEditor ? this.godotBridge.getStatus().editorPid : undefined);
    if (root === undefined) {
      return undefined;
    }
    if (games.has(root)) {
      run.announcedPid = root;
      return root;
    }
    const nearest = descendantsIn(tree, root).filter(
      (one) => games.has(one) && !gameBetween(tree, one, root, games),
    );
    const theOne = nearest.length === 1 ? nearest[0] : undefined;
    if (theOne !== undefined) {
      run.announcedPid = theOne;
    }
    return theOne;
  }

  /**
   * Whether an announced game could be one the connected editor played.
   *
   * A game that names an editor is the editor's when it names this one. A game that names none
   * is the editor's only when the project's runtime addon does not announce editors at all, in
   * which case no game of the project does: with an addon that does, a game announcing no editor
   * was started by something other than the editor, whatever project it is from. Everything
   * passes when this server does not know which editor it has.
   */
  private playedByOurEditor(endpoint: RuntimeEndpoint, projectPath: string | null): boolean {
    const editor = this.godotBridge.getStatus().editorPid;
    if (editor === undefined) {
      return true;
    }
    if (endpoint.editorPid !== undefined) {
      return endpoint.editorPid === editor;
    }
    return !runtimeAddonAnnouncesEditors(projectPath ?? this.ownProject);
  }

  /**
   * Whether an announced game could be [param run]'s own: the editor's, for a run the editor
   * plays, and for a run started here one that names no editor, since a game this server spawned
   * inherited no editor to name and one that names the connected editor is that editor's game.
   * No run at all is nothing's game.
   */
  private isTheGameOf(
    run: GodotProcess | null,
    endpoint: RuntimeEndpoint,
    projectPath: string | null,
  ): boolean {
    if (run === null) {
      return false;
    }
    if (run.throughEditor) {
      return this.playedByOurEditor(endpoint, projectPath);
    }
    const editor = this.godotBridge.getStatus().editorPid;
    return endpoint.editorPid === undefined || endpoint.editorPid !== editor;
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
    const status = this.godotBridge.getStatus();
    // The third situation, and the one this used to answer as either of the others. A game the
    // editor is playing is reached by asking the editor, so while no editor is connected there is
    // nothing to ask and a run that is alive on screen is invisible here. That window is ordinary:
    // a reconnect replaces this process and the addon takes up to half a minute to dial back in,
    // and a played game now outlives that, so being told "no game is running" about one somebody
    // is watching is a thing that happens rather than a thing that might. Said first, because it
    // is the only one of the three a caller can act on by waiting.
    const noEditor = !status.connected
      ? ' No editor is connected, so a game the editor is playing cannot be seen from here at all:' +
        ' editor_status says whether one is on its way, and a run of yours that is still up is' +
        ' reachable again once it is.'
      : '';
    // A game this server did not start that has announced its runtime: neither of the two sources
    // above can see it, and the runtime directory can. Asked before anything else is said, because
    // the sentence this used to reach for tells the caller to start a game.
    //
    // What a start then does depends on who is holding the game, and this branch is reached when
    // nothing here is: a run the editor is playing would have been picked up above. So the start is
    // spawned, and a spawned start is a second process. Measured, with a runtime announced for this
    // project and no editor: `started: true` with a new pid, the announced game still running, and
    // nothing ended. The reading that a start replaces the game that is playing came from a game
    // the editor was playing, which is the one case this branch cannot be about.
    const live = this.aRuntimeOfOursIsAnswering();
    if (live !== null) {
      return (
        `A game is running for ${live.project.path} and has announced its runtime on port ${live.port}, pid ${live.pid},` +
        ' but this server did not start it and cannot reach it through the editor, so editor_run and' +
        ' editor_output have nothing to answer about. The runtime_* tools reach it now.' +
        ' A run started here is a separate process rather than a replacement, so starting one leaves' +
        ' this game running as well.' +
        (this.godotBridge.getStatus().connected
          ? ''
          : ' editor_status says whether an editor is on its way, and editor_run can end it once one is.')
      );
    }
    // The same game, announced in a protocol this server cannot speak. The sweep above drops those,
    // so nothing here could see it and the sentence below would tell the caller to start one, which
    // replaces the game that is playing. The state is an upgrade that moves the runtime protocol:
    // installing replaces the addon on disk the moment a pin moves, while a server already spawned
    // stays the version it was, so a game started in between announces something this server will
    // not read. Only that kind of upgrade, which is the minority. Measured downstream across
    // 0.13.31 to 0.13.35, where the protocol did not move and the game stayed reachable throughout.
    //
    // Without offering the runtime_* tools, because this server cannot reach it either. What it can
    // say is that the game is there and which half is behind.
    //
    // Not that starting another would end it, which is what the branch above says about a game the
    // editor is playing and is false here. A start this server spawns is a separate process:
    // measured, with a game announcing a protocol ahead of the server, and `editor_run start`
    // answered `started: true` with a new pid while the announced game went on running, unmentioned
    // and unreachable. The two branches look alike and the game underneath them is not the same one.
    const unreadable = this.aRuntimeOfOursIsTooFarOff();
    if (unreadable !== null) {
      const behind =
        unreadable.protocol > RUNTIME_PROTOCOL
          ? 'this server is the older half: reconnect it so it spawns the installed version'
          : 'the addon is the older half: reinstall it and restart the game';
      return (
        `A game is running for ${unreadable.project.path}, pid ${unreadable.pid}, announced in protocol` +
        ` ${unreadable.protocol}, which this server does not speak: it speaks ${RUNTIME_PROTOCOL}, so ${behind}.` +
        ' Until then neither editor_run nor the runtime_* tools can reach it.' +
        ' A run started here is a separate process rather than a replacement, so starting one leaves' +
        ' this game running as well.'
      );
    }
    const record = readRunRecord();
    if (record === null) {
      return `No game is running.${noEditor} Start one with editor_run.`;
    }
    const mine = this.ownProject ?? (status.connected ? (status.projectPath ?? null) : null);
    const whose = record.projectPath === '' ? 'a project it does not name' : record.projectPath;
    const ours =
      mine === null
        ? 'this server was started without GDHARNESS_PROJECT and has no editor connected, so it cannot say whose that run is'
        : `this server serves ${mine}`;
    return `No game of this server's is running.${noEditor} A run started from ${whose} is recorded on this machine, and ${ours}, so it is not this server's to answer for or to end. Start one with editor_run.`;
  }

  /**
   * An announced runtime for the project this server serves, or null.
   *
   * Only for this project, and only when this server can say which project that is. The containment
   * this sits beside exists because a server that adopts whatever it finds in a shared runtime
   * directory killed another project's bench six times in fifty minutes, so widening it to any
   * announcement would undo that: this reports rather than acts, and still declines to speak for a
   * run it cannot show is its own.
   */
  private aRuntimeOfOursIsAnswering(): RuntimeEndpoint | null {
    return this.announcedForOurProject(discoverRuntimes());
  }

  /**
   * An announced runtime for this project that this server was not built to read.
   *
   * Kept apart from the one above because what can be said about it is different: there is a game
   * and no way to reach it, so the answer names it and which half is behind rather than offering
   * tools that would not work.
   */
  private aRuntimeOfOursIsTooFarOff(): UnspokenRuntime | null {
    return this.announcedForOurProject(runtimesAnnounced().unspoken);
  }

  /** Whichever of the announced games is this server's own project, out of any of the lists. */
  private announcedForOurProject<T extends { project: { path: string } }>(announced: readonly T[]): T | null {
    return this.allAnnouncedForOurProject(announced)[0] ?? null;
  }

  /**
   * The announced games of [param run]'s project. A run started here names its project, which a
   * server started without one and with no editor connected has no other way of knowing; a run
   * that names none is judged by this server's, as everything else is.
   */
  private announcedOfTheRunsProject<T extends { project: { path: string } }>(
    run: GodotProcess,
    announced: readonly T[],
  ): T[] {
    const project = run.projectPath;
    if (project === null) {
      return this.allAnnouncedForOurProject(announced);
    }
    return announced.filter((one) => one.project.path !== '' && isSameDirectory(project, one.project.path));
  }

  private allAnnouncedForOurProject<T extends { project: { path: string } }>(announced: readonly T[]): T[] {
    const status = this.godotBridge.getStatus();
    const mine = this.ownProject ?? (status.connected ? (status.projectPath ?? null) : null);
    if (mine === null) {
      return [];
    }
    return announced.filter((one) => one.project.path !== '' && isSameDirectory(mine, one.project.path));
  }

  /**
   * Every game announced for this project, whether or not this server speaks its protocol.
   *
   * Both lists, because what makes a game something a start leaves behind is that it is running and
   * not this server's, and being readable has nothing to do with it.
   */
  private everyRuntimeOfOurs(): { pid: number; protocol: number | null }[] {
    const announced = runtimesAnnounced();
    return [
      ...this.allAnnouncedForOurProject(announced.running).map((one) => ({
        pid: one.pid,
        protocol: null,
      })),
      ...this.allAnnouncedForOurProject(announced.unspoken).map((one) => ({
        pid: one.pid,
        protocol: one.protocol,
      })),
    ];
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
    return project !== '' && isSameDirectory(mine, project);
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
    await this.pickUpWhatTheEditorIsPlaying();
    const run = this.currentRun();
    if (!run) {
      return this.createErrorResponse(this.nothingOfOursIsRunning());
    }
    const budgetMs = readPositiveNumber(args, 'timeoutMs') ?? WAIT_FOR_RUN_MS;
    const until = Date.now() + budgetMs;
    // Drained as it goes rather than once at the end: the pipes are what the output is read from,
    // and a run that fills them while nobody reads blocks on its own print.
    while ((await this.runStillGoing(run)) && Date.now() < until) {
      this.drainEditorOutput(run);
      this.drainTranscript(run);
      await delay(RUN_POLL_MS);
    }
    return await this.handleGetDebugOutput(args, (await this.runStillGoing(run)) ? budgetMs : undefined);
  }

  /**
   * Whether a run is still going, asked of whoever can say: `runIsUp`, with the editor asked
   * for its word when the operating system has not already settled it.
   *
   * The operating system, for every run with a process to ask about. The editor, for a run it is
   * playing: that run has no process number of its own, so `stillRunning` alone can only say yes
   * for as long as the record lasts, and editor_output said `running: true` about such a game for
   * the rest of the session while its own note claimed the editor had been asked. editor_run wait
   * sat out its whole budget on the same reading. Every answer about whether a run is going comes
   * through here, so no two fields of one answer disagree about it. [param editorSays] is the
   * editor's word when the caller has just asked for it, null when the editor would not say.
   *
   * The editor is asked only when there is no process to ask: a played run whose game announced
   * is judged by that process, and a wait polling four times a second for an hour would
   * otherwise put fourteen thousand questions to the editor for an answer the operating system
   * already gave. The editor's word is still taken when the caller has it in hand.
   */
  private async runStillGoing(run: GodotProcess, editorSays?: boolean | null): Promise<boolean> {
    if (!run.throughEditor) {
      return stillRunning(run);
    }
    const announced = this.announcedPidOf(run);
    if (announced !== undefined && !alive(announced)) {
      return false;
    }
    if (announced !== undefined && editorSays === undefined) {
      return stillRunning(run);
    }
    const said = editorSays === undefined ? ((await this.editorPlayingState())?.playing ?? null) : editorSays;
    if (said === true) {
      run.seenPlaying = true;
    }
    return runIsUp(run, said);
  }

  private async handleGetDebugOutput(args: OperationParams, waitedMs?: number): Promise<ToolResponse> {
    await this.pickUpWhatTheEditorIsPlaying();
    const run = this.currentRun();
    if (!run) {
      return this.createErrorResponse(this.nothingOfOursIsRunning());
    }
    this.drainEditorOutput(run);
    this.drainTranscript(run);
    // A run picked up alive and since ended, caught here rather than left reading as running. The
    // last of its output is already in, because the drain above ran first.
    const going = await this.runStillGoing(run);
    if (run.endedUnwatched !== true && !going) {
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
    const hold = await this.holdOf(run, going);
    // Asked for rather than always, because asking costs a subprocess and on Windows that is a
    // PowerShell start: seconds under load, on every read, on the one platform where the answer is
    // dearest. Put in the hot path it slowed every call enough to time others out, and the tests
    // that ask Windows about a process were the ones that failed. A caller wanting to tell a wedged
    // run from a slow one asks then, which is rarely and deliberately.
    //
    // Only while it is going: a process that has exited has no processor time left to report, and
    // asking after a pid that is gone answers about whatever holds that number next.
    //
    // The number the game announced for itself is asked first. For a run the editor plays it is
    // the only number there is: that run has no handle here, but a game with the runtime addon
    // has said which process it is, and a bench played from the editor was being told nothing
    // here had its process id while the same answer listed it under runtimes. For a run started
    // here it is the game rather than the handle, which differ under the Windows console build:
    // the handle is a wrapper that does no work, so its processor time stands still however hard
    // the engine under it is grinding, which is exactly the reading this exists to tell apart.
    // Found through the process tree when nothing else has tied it, since this ask already costs
    // what that costs and is made rarely.
    //
    // Read once for the whole answer. The tree is seconds to read on a loaded machine, and an
    // announcement landing inside that read tied the run for the `pid` field below and not for
    // the reading above it, so one answer said there was no process to ask and named one.
    const wanted = readBoolean(args, 'cpu') ?? false;
    const announced = this.announcedPidOf(run);
    const processToAsk = wanted
      ? (announced ?? (stillRunning(run) ? await this.gameProcessOf(run) : undefined) ?? run.pid ?? null)
      : null;
    const cpuSeconds =
      wanted && processToAsk !== null && stillRunning(run) ? await cpuSecondsOf(processToAsk) : undefined;
    const notes: string[] = [];
    // Asked for and not answerable, said rather than left out. This is the one reading that
    // separates a bench doing work from a bench parked, and an absent field reads as "the answer
    // is nothing" as easily as "the question could not be put": a caller watching for elapsed
    // climbing while processor time stands still is watching for a number that never arrives.
    // The wait in the same tool says when it cannot fully deliver, and this is the same property.
    if (wanted && cpuSeconds === undefined && stillRunning(run)) {
      notes.push(
        processToAsk === null
          ? 'cpu was asked for and there is no process to ask: the editor is playing this run and holds it, and the game announced no runtime, so nothing here has its process id. A game with the runtime addon announces one; editor_run start without a connected editor, or with args, starts the game here instead and that run answers cpuSeconds either way.'
          : 'cpu was asked for and this platform would not say what the run has used.',
      );
    }
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
    // A run found already playing, rather than one this server started. The log begins where it was
    // picked up, so what is below is not the run from its first line, and a caller who started a
    // bench an hour ago must not read six lines as six lines printed.
    if (run.pickedUpPlaying === true) {
      notes.push(
        run.transcript === null
          ? 'The editor was already playing this when this server reached it, and the server that started it left no transcript, so this is not the run from its start: what it printed before that is only in the editor. It is the run the editor is holding now, which is the one the debug_* tools answer for.'
          : 'The editor was already playing this when this server reached it, and what it printed before that has been read back from its transcript. It is the run the editor is holding now, which is the one the debug_* tools answer for.',
      );
    }
    if (run.consoleLost === true) {
      const back = this.dapClient?.isConnected() === true;
      notes.push(
        `The debug adapter this run's console arrives over went away while the run was going, so what is below has a hole in it and the counts are of what was heard rather than of what was printed. ${back ? 'It is connected again, and the line marking where is in the log.' : 'It is still gone, so nothing further will arrive here.'} The project's own user://logs/godot.log has the rest, and "no entries" here means "not heard" rather than a quiet run.`,
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
        `Everything this run has printed is in ${run.transcript}, uncapped and still being written. Read it for output, not for whether the run is alive: a transcript that stops growing is a run between prints. running above is asked of the operating system while there is a process to ask about, and for an editor-played run that announced no runtime it is the editor's answer instead, which can lag after the game has gone.`,
      );
    }
    return this.jsonTextResponse({
      running: going,
      exitCode: run.exitCode,
      through: run.throughEditor ? 'editor' : 'gdharness',
      // The number the game announced, for a run the editor plays: the process is the same one
      // whichever side started it, and null here read as "no process" beside a runtimes list
      // naming it. The reading taken above, or the tie the reading above made, and not a fresh
      // look, so this agrees with what cpu was asked of.
      pid: run.pid ?? announced ?? run.announcedPid ?? null,
      errors: run.log.count('error'),
      warnings: run.log.count('warning'),
      // Undefined rather than true once the console has gone, because clean is a claim about the
      // run and this is a count of what was heard. A verdict read off a source that stopped
      // arriving is the wrong answer said confidently, and clean is the field a gate reads.
      clean: run.consoleLost === true ? undefined : run.log.count('error') === 0,
      // Said as its own field as well as in the note, so a caller checking one value has one to
      // check: absent means the console was arriving throughout.
      consoleLost: run.consoleLost === true ? true : undefined,
      // Three answers and not two. Null is a game this session knows is running; an object is one
      // it knows is held, whether the adapter said so or the runtime did; and absent with
      // heldUnknown beside it is a session that connected after a stop, asked, and could not find
      // out, which is the state a replacement server is in until the game answers something.
      ...hold,
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
  private async handleStopProject(args: OperationParams): Promise<ToolResponse> {
    // Before anything is picked to end. A reconnect leaves the editor-played run unrecorded, and
    // what would otherwise be adopted here is the last run this project spawned: a pid belonging
    // to something nobody asked about, offered to be killed while the run the caller means goes on.
    await this.pickUpWhatTheEditorIsPlaying();
    const stopped = this.currentRun();
    if (!stopped) {
      return this.createErrorResponse(this.nothingOfOursIsRunning());
    }
    this.drainEditorOutput(stopped);
    this.drainTranscript(stopped);
    // Read before the stop, since a game that goes on the stop is one that was running.
    const wasRunning = await this.runStillGoing(stopped);
    // Read now rather than after the stop, since the sweep it may take is of the announcements
    // and the game's is about to go.
    const announcedPid = this.announcedPidOf(stopped) ?? null;
    const endedPid = stopped.pid ?? announcedPid;
    // Listed before the run is ended, because ending it is what makes them somebody else's
    // children: POSIX hands them to init the moment the parent goes, and the question "whose are
    // you" has no answer after that. Which of them are games is read now too, since a sweep taken
    // after the stop reads a worker that went down with its parent as never having been one.
    const children =
      readBoolean(args, 'andChildren') === true && wasRunning ? await this.whatTheRunStarted(stopped) : null;
    this.logDebug('Stopping the running game');
    await this.endActiveGame('editor_run stop');
    const ended = children === null ? null : endChildrenAmong(children);
    // The announcement of the game just ended goes with it, here rather than on the next sweep,
    // because a number the operating system hands out again before that sweep reads as the game
    // still starting for as long as the newcomer lives. By the number the game announced under
    // as well as by the run's own, since the two differ for the Windows console build: the run
    // holds the wrapper and the announcement is the engine's, the wrapper's child, which goes
    // with it. Measured: the child was listed under the wrapper and gone two seconds after the
    // wrapper was killed.
    if (wasRunning) {
      for (const pid of new Set([endedPid, announcedPid])) {
        if (pid !== null) {
          await announcementEnded(pid);
        }
      }
    }
    return this.jsonTextResponse({
      stopped: true,
      through: stopped.throughEditor ? 'editor' : 'gdharness',
      // What was ended, named. One run is one process, and a game that started others is not one
      // of them: a bench fanning out to thirty-one workers with OS.create_process had the process
      // that prints ended and thirty left grinding, which went on writing their slice files until
      // the next run of the same bench read their lines as its own and reported 107.9% of runs
      // won. A stop that says which process it ended is one a caller can compare against what they
      // know their game started; one that says "stopped" is not. For a run the editor plays the
      // number is the one its game announced, when it announced one: the process is the same
      // whichever side ended it.
      endedPid,
      // What the game had started for itself and is gone with it, when asked to: the processes the
      // operating system listed under the run's, to any depth, that are games of this project,
      // announced as one or this project's engine run with --path on it, signalled here or taken
      // down with the run before the signal reached them, each with what identified it. A process
      // under the run that is neither is left and named, since what it is cannot be told from
      // here and a number is not a licence to signal.
      ...(ended === null
        ? {}
        : {
            endedChildren: ended.ended.map((one) => one.pid),
            identifiedBy:
              ended.ended.length === 0
                ? undefined
                : Object.fromEntries(ended.ended.map((one) => [String(one.pid), one.identifiedBy])),
            childrenLeft: ended.left.length === 0 ? undefined : ended.left,
            childrenUnknown: ended.unknown === false ? undefined : true,
          }),
      // Whether there was anything left to stop. A run whose exit nobody collected, which is a
      // played run picked up after a reconnect and gone since, has no exit code and is over all
      // the same; answering false there said a game had been ended that had ended itself.
      exitedBeforeStop: stopped.exitCode !== null || !wasRunning,
      exitCode: stopped.exitCode,
      errors: stopped.log.count('error'),
      warnings: stopped.log.count('warning'),
      clean: stopped.log.count('error') === 0,
      note: !wasRunning
        ? 'This run was over before the stop, so nothing was ended here: editor_output has what it printed and how it ended. Anything that game started for itself, with OS.create_process or otherwise, is a separate process and may still be running.'
        : `${
            stopped.throughEditor
              ? 'The editor was asked to stop the scene it is playing.'
              : 'The process named under endedPid was ended.'
          } ${aboutTheChildren(ended, stopped.throughEditor)}`,
      entries: forAnswer(
        stopped.log.select({ severity: 'warning', sinceLastCall: false, limit: 200 }).entries,
      ),
    });
  }

  /**
   * What [param run] has started for itself, read while it is still there to be asked about:
   * every process under the run's, to any depth, sorted into the games of the run's project and
   * the rest.
   *
   * Being under the run is the property a stranger's bench cannot have, and what says a process
   * is a game at all rather than whatever else a game might start is one of two things: it is
   * announced as a game of the project, or its command line is the project's engine run with
   * `--path` on the project. The second is for the bench whose workers announce nothing on
   * purpose: a project that keeps the runtime out of its benches, so that thirty-one workers do
   * not each bind a port, was the fan-out this argument was written for and the one it could not
   * reach, thirty engines named under childrenLeft as things that could not be told apart. The
   * engine is the executable of the run's own process or of one between the child and it, since a
   * worker is started with the game's own executable and a wrapper's name differs from it, and an
   * editor is refused whatever its path says.
   *
   * To any depth rather than one, because the process the run holds is not always the game: the
   * Windows console build is a wrapper whose child is the engine, and a worker the engine opens is
   * the wrapper's grandchild. The run's own game is not something it started, so it is neither
   * listed nor, when it is under the handle, taken for a worker. Under the game as well as under
   * the handle, since a run the editor plays has no handle and its game is all there is to list
   * under.
   *
   * A platform that would not list its processes, and a run with no process to list under, are
   * each said rather than read as a game that started nothing.
   */
  private async whatTheRunStarted(run: GodotProcess): Promise<StartedByTheRun> {
    const tree = await processTree();
    if (tree === undefined) {
      return { unknown: 'platform' };
    }
    const announced = this.announcedOfTheRunsProject(run, runtimesAnnounced().running);
    const games = new Set(announced.map((one) => one.pid));
    const own =
      this.announcedPidOf(run, announced) ??
      this.tieThroughTheTree(run, tree, games) ??
      run.gamePid ??
      this.gameByCommandLineIn(run, tree);
    if (own !== undefined && run.announcedPid === undefined) {
      run.gamePid = own;
    }
    const roots = [run.pid, own].filter((one): one is number => one !== null && one !== undefined);
    if (roots.length === 0) {
      return { unknown: 'no process' };
    }
    const under = new Set(roots.flatMap((root) => descendantsIn(tree, root)));
    for (const root of roots) {
      under.delete(root);
    }
    const started = [...under].sort((a, b) => a - b);
    const found: GameUnderTheRun[] = [];
    const others: number[] = [];
    for (const pid of started) {
      if (games.has(pid)) {
        found.push({ pid, how: 'announced', identifiedBy: 'announced as a game of this project' });
        continue;
      }
      // The engine is what the run's own process is, or what stands between this one and it: a
      // worker is started with the game's own executable, and a wrapper's name differs from it.
      const engines = [...roots, ...roots.flatMap((root) => ancestorsIn(tree, pid, root))];
      const read = this.theProjectsEngine(run, tree, pid, engines);
      if (read !== null) {
        found.push({
          pid,
          how: 'command line',
          identifiedBy: `${read.executable} run with --path ${read.projectPath ?? ''}, this project's engine on this project`,
        });
        continue;
      }
      others.push(pid);
    }
    return { unknown: false, games: found, others };
  }

  /**
   * Whether [param pid]'s command line says it is [param run]'s project's engine run on that
   * project: `--path` resolving to the project, no editor flag, and an executable named as one of
   * [param engines] is, or as the engine Godot's Windows console wrapper starts, since
   * `X_console.exe` is a wrapper that runs `X.exe` beside it. The reading when it is, null when
   * it is not or the run names no project to compare.
   */
  private theProjectsEngine(
    run: GodotProcess,
    tree: ProcessTree,
    pid: number,
    engines: readonly number[],
  ): CommandLineRead | null {
    const project = run.projectPath;
    if (project === null) {
      return null;
    }
    const read = readCommandLine(tree.get(pid)?.command ?? '');
    if (
      read.executable === '' ||
      read.editor ||
      read.projectPath === null ||
      !isSameDirectory(read.projectPath, project)
    ) {
      return null;
    }
    const names = engines.flatMap((one) =>
      engineNamesOf(readCommandLine(tree.get(one)?.command ?? '').executable),
    );
    const sameName = (one: string, other: string): boolean =>
      one !== '' &&
      (process.platform === 'win32' ? one.toLowerCase() === other.toLowerCase() : one === other);
    return names.some((name) => sameName(name, read.executable)) ? read : null;
  }

  /**
   * The process doing [param run]'s work when that is not the process the run holds and nothing
   * announced it, found by command line: under the handle, or under the editor for a run it
   * plays, the project's engine with no such engine between the two. A worker has the game above
   * it, and the wrapper and the editor are not the game: the wrapper by its name, the editor by
   * its flag. Not asked when the handle is the game itself, which is the ordinary engine, since
   * then its one worker would be the only candidate.
   */
  private gameByCommandLineIn(run: GodotProcess, tree: ProcessTree): number | undefined {
    const root = run.pid ?? (run.throughEditor ? this.godotBridge.getStatus().editorPid : undefined);
    if (root === undefined || run.projectPath === null) {
      return undefined;
    }
    const rootRead = readCommandLine(tree.get(root)?.command ?? '');
    const rootIsTheGame =
      !rootRead.editor &&
      !CONSOLE_WRAPPER.test(rootRead.executable) &&
      rootRead.projectPath !== null &&
      isSameDirectory(rootRead.projectPath, run.projectPath);
    if (rootIsTheGame) {
      return undefined;
    }
    const isEngine = (pid: number): boolean => this.theProjectsEngine(run, tree, pid, [root]) !== null;
    const nearest = descendantsIn(tree, root).filter(
      (pid) => isEngine(pid) && !ancestorsIn(tree, pid, root).some((one) => one !== root && isEngine(one)),
    );
    return nearest.length === 1 ? nearest[0] : undefined;
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
    const projectPath = typeof args['projectPath'] === 'string' ? args['projectPath'] : '';

    // What the cache holds before the editor is asked to scan, because the editor writes that file
    // at the end of a scan from the list it is holding rather than from the file. An editor blind
    // to a class writes a cache without it, over the correct one, and the loss surfaces in the next
    // engine to read it as an unknown identifier in a file nobody touched.
    const before = projectPath === '' ? null : cachedClasses(projectPath);
    const writtenBefore = projectPath === '' ? null : cacheWrittenAt(projectPath);
    const blind = await this.classesTheEditorCannotSee(args);
    const atRisk = before === null ? [] : blind.unseen.filter((one) => before.has(one.className));
    // The other direction, and the more damaging one: a class the editor still holds for a script
    // that is gone. The scan writes the editor's list, so this comes back into the cache at a path
    // that is not there, and the next engine to read it fails on a correct script. Known before
    // the scan, from the editor's own list, so the write can be waited for and then undone.
    const ghosts = blind.stillHeld ?? [];

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
      // `pending` is a scan that has been asked for and has not started. Without it, the first
      // poll after asking reads two false flags off an editor that has not begun and calls the
      // scan finished, which is how a rescan of 376 classes answered in 296ms and the editor
      // then wrote its own stale class list over a cache that had just been corrected.
      //
      // Believed only for as long as a scan takes to start. The addon clears it on the editor's
      // own finished-scan signal, and a scan that both started and finished between two polls
      // would leave it set if that signal ever failed to arrive: waiting the whole budget on a
      // flag is a worse answer than the one this fixes, so the flag has a horizon and the engine's
      // own two have the rest.
      const pending = Boolean(status['pending']) && Date.now() - started < SCAN_START_MS;
      busy = Boolean(status['scanning']) || Boolean(status['importing']) || pending;
    }

    // The write lands after the scan says it has finished, so reading the file the moment the
    // editor goes idle reads the one that is about to be replaced. Waited for only where a class
    // is known to be at risk, because an editor holding every class the cache holds writes the
    // same list back and the old file and the new one then say the same thing.
    if (
      !busy &&
      projectPath !== '' &&
      (atRisk.length > 0 || ghosts.length > 0 || blind.unchecked !== undefined)
    ) {
      const until = Date.now() + CACHE_WRITE_MS;
      while (Date.now() < until && cacheWrittenAt(projectPath) === writtenBefore) {
        await new Promise((settle) => setTimeout(settle, 100));
      }
    }

    const after = projectPath === '' || busy ? null : cachedClasses(projectPath);
    const lost =
      before === null || after === null ? [] : [...before.keys()].filter((name) => !after.has(name));
    // What the scan wrote for a file that is not there, read off the cache itself rather than off
    // the editor's list: the invariant is the file, and an entry naming a path that does not exist
    // is wrong whoever put it there.
    const atMissingPaths = after === null ? [] : cachedAtMissingPaths(after, projectPath);

    // Put back rather than reported. The scan is worth running even when it costs the cache: on a
    // class the editor has simply not walked yet, scanning is the cure, and refusing on that
    // evidence refuses the call that fixes it. What is not worth leaving is the file, so the
    // rebuild that the note used to tell the caller to run is run here instead. It reads the files
    // rather than the editor, so a class genuinely deleted stays deleted, which is also what takes
    // an entry at a missing path out.
    const restored =
      lost.length > 0 || atMissingPaths.length > 0 ? await this.rebuildCacheAfterLoss(projectPath, lost) : [];
    const rebuilt = atMissingPaths.length > 0 ? cachedClasses(projectPath) : null;
    const dropped =
      rebuilt === null
        ? []
        : atMissingPaths.filter((name) => !cachedAtMissingPaths(rebuilt, projectPath).includes(name));
    const stillAtMissingPaths = atMissingPaths.filter((name) => !dropped.includes(name));

    // After the scan rather than before it. The scan settles what the editor knows about the files;
    // this settles what it has already built from one of them, and building from a file the scan
    // has not read yet would be recompiling the old source.
    const reloading = readNonEmptyString(args, 'reloadScript');
    let reloaded: { methods?: string[]; heldBefore?: string[]; problem?: string } = {};
    if (reloading !== undefined) {
      try {
        const answer = asParams(
          await this.godotBridge.invokeTool('reload_script', { ...args, scriptPath: reloading }),
        );
        const methods = readArray(answer, 'methods');
        const before = readArray(answer, 'heldBefore');
        reloaded = methods
          ? { methods: methods.map(String), ...(before ? { heldBefore: before.map(String) } : {}) }
          : { problem: `the editor would not say what ${reloading} has after reloading it` };
      } catch (error) {
        reloaded = { problem: `${reloading} could not be reloaded: ${errorMessage(error)}` };
      }
    }

    const checked = busy ? { unseen: [] } : await this.classesTheEditorCannotSee(args);
    const unseen = checked.unseen;
    const stillGone = lost.filter((name) => !restored.includes(name));
    const notes: string[] = [];
    if (busy) {
      notes.push(
        'The editor was still scanning or importing when the wait ran out, so new files may not be visible yet.',
      );
    } else if (stillGone.length > 0) {
      notes.push(
        'The scan wrote the class cache from the list this editor is holding, that list is shorter than the file was, and rebuilding the cache from the files did not bring these back. Every engine that reads the cache next, including a test run, will report them as unknown identifiers. Restart the editor with editor_launch restart before scanning again.',
      );
    } else if (lost.length > 0) {
      notes.push(
        'The scan wrote the class cache from the list this editor is holding, which is shorter than the file was, so the cache was rebuilt from the files and these classes are back in it. Nothing was lost, but this editor is still holding the short list: do not rescan again until it has been restarted with editor_launch restart, because it will write the same list over the file each time.',
      );
    } else if (unseen.length > 0) {
      notes.push(
        'The scan finished and these classes are still not in the list the editor resolves against, so every use of them reads as an unknown identifier. Its walk skips a file another engine has already imported. Rescan again on its own, which is the measured cure and needs no change to the declaring script, or restart the editor with editor_launch restart.',
      );
    }
    if (stillAtMissingPaths.length > 0) {
      notes.push(
        `The scan wrote the class cache with ${stillAtMissingPaths.join(', ')} at a path that is not on disk, and rebuilding the cache from the files did not take it out. The next engine to read the cache fails on "Could not parse global class" in whichever correct script shares the bare name. Restart the editor with editor_launch restart, then run project_import refresh_classes.`,
      );
    } else if (dropped.length > 0) {
      notes.push(
        `The scan wrote the class cache from the list this editor is holding, and that list still has ${dropped.join(', ')} for a script that is gone, so the cache was rebuilt from the files without it. The editor goes on holding it and writes it back on every scan until it is restarted with editor_launch restart; until then a scan is followed by this same rebuild.`,
      );
    }
    return this.jsonTextResponse({
      ok:
        !busy &&
        unseen.length === 0 &&
        stillGone.length === 0 &&
        stillAtMissingPaths.length === 0 &&
        checked.unchecked === undefined,
      stillWorking: busy,
      waitedMs: Date.now() - started,
      // Both readings, because they answer different questions. What the copy held before says
      // whether this editor had the fault at all, which is the thing a caller cannot otherwise
      // find out; what it holds after says whether the call mended it.
      heldBeforeReload: reloaded.heldBefore,
      reloadedMethods: reloaded.methods,
      reloadProblem: reloaded.problem,
      unseenByEditor: unseen.length > 0 ? unseen : undefined,
      cacheLost: lost.length > 0 ? lost : undefined,
      cacheRestored: restored.length > 0 ? restored : undefined,
      cacheDropped: dropped.length > 0 ? dropped : undefined,
      cacheAtMissingPaths: stillAtMissingPaths.length > 0 ? stillAtMissingPaths : undefined,
      classesUnchecked: checked.unchecked,
      note: notes.length > 0 ? notes.join(' ') : undefined,
    });
  }

  /**
   * Rebuilds the class cache from the files after a scan wrote a shorter one, and answers with
   * which of [param lost] came back.
   *
   * The same rebuild `project_import refresh_classes` runs, which reads the scripts rather than
   * asking any editor, so it restores a class that is still declared and leaves out one that is
   * not. A rebuild that will not run leaves the answer saying so rather than claiming a repair.
   */
  private async rebuildCacheAfterLoss(projectPath: string, lost: string[]): Promise<string[]> {
    if (projectPath === '') {
      return [];
    }
    const rebuilt = await this.operation('refresh_class_cache', {}, projectPath);
    if (!rebuilt.ok) {
      this.logDebug(`Could not rebuild the class cache after a scan: ${rebuilt.message}`);
      return [];
    }
    const now = cachedClasses(projectPath);
    return now === null ? [] : lost.filter((name) => now.has(name));
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
    const stillHeld = checked.stillHeld ?? [];
    if (checked.unseen.length === 0 && stillHeld.length === 0 && checked.unchecked === undefined) {
      return answered;
    }
    const notes: string[] = [];
    if (checked.unseen.length > 0) {
      notes.push(
        'The cache on disk is right now, and the editor holding this project is still not resolving these: rewriting the file does not reach the list it already loaded. editor_rescan does, on its own and with no change to the declaring script; editor_launch restart also does, and costs more.',
      );
    }
    if (stillHeld.length > 0) {
      notes.push(
        `The editor is still holding ${stillHeld.join(', ')}, which this project no longer declares, and it will write that list back over the cache this call just corrected. The entry returns pointing at a script that is gone, and the next engine to walk get_global_class_list() dies on "File not found". A rescan does not clear this one: it picks up a class that has appeared and does not drop one that has gone. editor_launch restart does.`,
      );
    }
    return this.jsonTextResponse({
      ...asParams(JSON.parse(first.text)),
      unseenByEditor: checked.unseen.length > 0 ? checked.unseen : undefined,
      stillHeldByEditor: stillHeld.length > 0 ? stillHeld : undefined,
      classesUnchecked: checked.unchecked,
      note: notes.length > 0 ? notes.join(' ') : undefined,
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
  ): Promise<{ unseen: UnseenClass[]; stillHeld?: string[]; unchecked?: string }> {
    const projectPath = typeof args['projectPath'] === 'string' ? args['projectPath'] : '';
    if (projectPath === '') {
      return { unseen: [], unchecked: 'no projectPath, so there was nothing to read the cache from' };
    }
    // An editor open on something else holds a list for that project, and every class here would
    // be missing from it. Comparing them names the whole project as unseen, which is a wrong
    // answer said loudly, and the failure this exists to end was a wrong answer said quietly.
    const open = this.godotBridge.getStatus().projectPath;
    if (open === undefined || !isSameDirectory(open, projectPath)) {
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
    const holds = held['classes'].map(String);
    return { unseen: unseenByEditor(projectPath, holds), stillHeld: heldButGone(projectPath, holds) };
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
    // A server serves one editor, and that editor answers about the project it has open whatever
    // path the call names: it has no other project to look in. So a call naming a different one
    // was answered about the editor's, under the caller's own project name, and nothing in the
    // answer said which project it described. The bridge already turns away an editor from
    // elsewhere; this is the same rule read from the other end.
    const open = this.godotBridge.getStatus().projectPath;
    const meant = readNonEmptyString(args, 'projectPath');
    if (open !== undefined && open !== '' && meant !== undefined && !isSameDirectory(open, meant)) {
      return this.createErrorResponse(
        `This call names ${meant}, and the editor on this bridge has ${open} open.`,
        [
          "editor_status names the project this server's editor is showing",
          'One server serves one editor: start a second server for the other project',
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
   * Whether an editor-played run is held at a breakpoint, from the session when it knows and from
   * the runtime when it does not.
   *
   * The debug session knows once it has been told by a `stopped` event, let the game go itself, or
   * found frames on attach. A session that connected after the stop is none of those: measured on a
   * real editor, the adapter answers such a session a thread and no frames while the game sits at
   * its breakpoint, and that is the session every replacement server has after a reconnect. Reading
   * its null as "running" is how a game that draws nothing and answers nothing was reported running,
   * and how `debug_state stack` refused with "running, not stopped" about a game that was stopped.
   *
   * The runtime can still tell. A game with the addon accepts a connection and answers a ping in
   * milliseconds while it runs, and accepts the connection and never answers while it is held,
   * which `editor_status` already reports per game. So when the session cannot say, the runtime is
   * asked once with a short wait, and its answer is recorded on the session so the next read does
   * not ask again. A game without the addon leaves the question open, and the answer says so
   * rather than guessing.
   */
  /**
   * Where the game at [endpoint] is held, when it is the run this server reports on and the
   * session has been told, else null.
   *
   * The session speaks for the run the editor is playing for this server and for no other game
   * on the machine, so a game announced by another project, or a run this server spawned, is
   * never read off it. And only knowledge counts: a session that has not been told answers null
   * here whether the game is held or not, and the caller goes on to ask the game itself.
   */
  private knownHoldOn(endpoint: RuntimeEndpoint, announced?: readonly RuntimeEndpoint[]): StoppedAt | null {
    const run = this.activeProcess;
    const session = this.dapClient;
    if (run === null || !run.throughEditor || !stillRunning(run) || session === null) {
      return null;
    }
    if (this.announcedPidOf(run, announced) !== endpoint.pid || !session.holdIsKnown()) {
      return null;
    }
    return session.whereItStopped();
  }

  private async holdOf(
    run: GodotProcess,
    going?: boolean,
  ): Promise<{ heldAt: StoppedAt | null | undefined; heldUnknown?: true; heldNote?: string }> {
    // A run that is over is held nowhere. Asked of the process before the session, because a
    // session that never learned the hold has only the announcement to ask, and a game that has
    // quit has none: the answer was "cannot be told from here, a game that answers nothing is
    // held", about a run whose exit the same answer was reporting. Whether it is over is asked
    // the way `editor_output` asks it, of the editor for a run the editor plays, and a caller
    // that has just asked hands the answer in rather than asking twice: the record alone says a
    // played run is going for as long as it lasts, and editor_status carried that note beside
    // its own `processActive: false`.
    if (!run.throughEditor || !(going ?? (await this.runStillGoing(run)))) {
      return { heldAt: null };
    }
    const session = this.dapClient;
    if (session?.holdIsKnown()) {
      return { heldAt: session.whereItStopped() };
    }
    // The run's own announcement, tied now when it was not before: a run picked up before its
    // game announced has no number yet, and the project is the one fact the pick-up and the
    // announcement share.
    const its = this.announcedPidOf(run);
    const endpoint =
      its === undefined ? undefined : runtimesAnnounced().running.find((one) => one.pid === its);
    if (endpoint === undefined) {
      return {
        heldAt: undefined,
        heldUnknown: true,
        heldNote:
          'Whether this run is held at a breakpoint cannot be told from here: this server connected to the debugger after any stop, the adapter reports a stop only to the sessions connected when it happened, and the run has announced no runtime to ask instead. A game that draws nothing and answers nothing is held; debug_control continue lets a held game go.',
      };
    }
    const reply = await runtimeRequest(endpoint, 'ping', {}, HOLD_PING_MS);
    if (reply.ok) {
      session?.learnedRunning();
      return { heldAt: session?.whereItStopped() ?? null };
    }
    if (reply.reason === 'busy') {
      return {
        heldAt: {
          reason: 'unanswered',
          description: `the game accepted a runtime connection and did not answer a ping within ${HOLD_PING_MS}ms, which is what a game held at a breakpoint does, and what one stuck in a long frame does. This server connected to the debugger after the stop, so the adapter will not show it the stack; debug_control continue lets a held game go`,
          text: '',
        },
      };
    }
    return { heldAt: undefined, heldUnknown: true, heldNote: reply.message };
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
    const { op: _op, projectPath, pid, ...params } = asParams(args);
    const announced = runtimesAnnounced();
    // A server set up for a project answers about that project's game and no other. Two
    // projects open in two harness sessions are two games announced on the same machine, and
    // without this the second one to start is a game this server would talk to as readily as
    // its own, with nothing in the answer saying which it reached. A pid picks one game out of
    // several running from one project, which is what a bench with workers is, and with none
    // given the game this server started or plays is the one meant when it is among them: a
    // caller who started a bench and asks about it was refused with "pass pid" the moment the
    // bench opened its first worker.
    const wanted = typeof projectPath === 'string' ? projectPath : (this.ownProject ?? undefined);
    const own =
      typeof pid === 'number'
        ? undefined
        : (this.ownGameAmong(announced.running, wanted) ??
          (await this.ownGameThroughTheTree(announced.running, wanted)));
    const choice = chooseRuntime(
      announced.running,
      wanted,
      announced.unspoken,
      typeof pid === 'number' ? pid : own,
    );
    if ('problem' in choice) {
      return this.createErrorResponse(choice.problem);
    }
    // Said when it was a choice: several games of the project are running and this one was
    // taken for being the run this server holds, which a caller reading a worker's answer as the
    // bench's would otherwise have no way to see.
    const ofProject = announced.running.filter(
      (one) => wanted === undefined || isSameDirectory(one.project.path, wanted),
    );
    const chosenAmongSeveral = own !== undefined && ofProject.length > 1;
    const answeredBy = chosenAmongSeveral ? { answeredBy: own } : {};

    // A game the session knows is held answers nothing, and what a caller got for asking was the
    // whole runtime timeout, ten seconds, and then a guess that it may be paused at a breakpoint.
    // The session was told, so it says so at once and says what lets the game go. Knowledge and
    // not a default: a session opened after the stop has not been told and asks nothing here.
    const held = this.knownHoldOn(choice.endpoint, announced.running);
    if (held !== null) {
      return this.createErrorResponse(
        `The game (pid ${choice.endpoint.pid}) is held by the editor's debugger, ${describeHalt(held)}, and answers no runtime call while it is.`,
        [
          'debug_control continue lets it go, after which this call answers',
          'debug_state stack reads where it is held, and debug_state scopes what it is holding there',
          'editor_output says heldAt for the run, and editor_run stop ends it',
        ],
      );
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
        return this.jsonTextResponse({ ...payload, ...answeredBy });
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
          {
            type: 'text',
            text: `Screenshot captured: ${dimensions}${chosenAmongSeveral ? ` from pid ${own}, the game this server holds` : ''}`,
          },
          { type: 'image', data: readFileSync(screenshotPath).toString('base64'), mimeType: 'image/png' },
        ],
      };
    } finally {
      discard(screenshotDir);
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
      ...whichGame(args),
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
      return await this.handleRuntimeCommand('wait_frames', { ...whichGame(args), frames }, waited);
    }

    const timeoutMs = readPositiveNumber(args, 'timeoutMs') ?? 5000;
    const nodePath = readNonEmptyString(args, 'nodePath') ?? '';
    const patience = Math.max(this.runtimeTimeoutMs(), timeoutMs + 5000);
    return op === 'signal'
      ? await this.handleRuntimeCommand(
          'wait_signal',
          {
            ...whichGame(args),
            path: nodePath,
            signal: readString(args, 'signal') ?? '',
            timeout_ms: timeoutMs,
          },
          patience,
        )
      : await this.handleRuntimeCommand(
          'wait_until',
          {
            ...whichGame(args),
            path: nodePath,
            property: readString(args, 'property') ?? '',
            value: args['value'],
            // Only when asked for, so a caller waiting on a property is not also asking about
            // words: the game reads whichever of the two it was given and refuses neither.
            ...(readNonEmptyString(args, 'says') === undefined
              ? {}
              : { says: readNonEmptyString(args, 'says') }),
            ...(readBoolean(args, 'includeHidden') === undefined
              ? {}
              : { include_hidden: readBoolean(args, 'includeHidden') }),
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
