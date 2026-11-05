/**
 * Opening a project's editor, shared by `editor_launch open` and `gdharness editor open`, so an
 * editor opened from the command line is the one the server would have opened: on the same ports,
 * with its console paired to its pid, and under the same turn, so two opens at once make one editor.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { alive } from './alive.js';
import { DEFAULT_DAP_PORT } from './dap_client.js';
import { HIDDEN_DESKTOP } from './desktop.js';
import { placeEmptyScriptDocs } from './doc-cache.js';
import { clearEditorLog, editorLogPath, writeEditorLogNote } from './editor-log.js';
import { EngineUsageError } from './engine-launch.js';
import { type EditorPorts, editorArguments, envValue, OPENED_BY_A_SERVER, startedAs } from './launch.js';
import { freeLibraryCopies } from './library-copies.js';
import { DEFAULT_LSP_PORT } from './lsp_client.js';
import { launchOutsideTheTree } from './outside.js';
import { freePort, portFromEnvOrNull } from './ports.js';
import { editorsOfProjectIn, processTree, startTimesOf } from './process-children.js';
import { type RestartNote, restartOwed, restartSettled } from './restart-note.js';
import { runtimeDirectory } from './runtime-client.js';
import { gdharnessCommand, SERVER_VERSION } from './server-version.js';
import {
  inspectProject,
  installedAddonVersion,
  installedEditorDigest,
  installedRuntimeDigest,
  installedRuntimeVersion,
  shippedEditorDigest,
  shippedRuntimeDigest,
} from './setup.js';
import { isNewer } from './update-check.js';
import { inTurnFor } from './write-turns.js';

/**
 * How long a restart waits for the old editor to go, and then for the new one to come back.
 *
 * Ninety seconds is long enough for an editor to save, close, start again and rescan a large
 * project. An editor that has not come back by then is stuck on something a person has to look at,
 * usually a dialog. A project whose import runs past it sets GDHARNESS_EDITOR_RESTART_TIMEOUT_MS.
 */
export function editorRestartTimeoutMs(): number {
  const override = Number.parseInt(envValue('GDHARNESS_EDITOR_RESTART_TIMEOUT_MS') ?? '', 10);
  return Number.isInteger(override) && override > 0 ? override : 90_000;
}

/**
 * Whether the restart a note records can still be in progress. A note older than the exit wait and
 * a launch whose writer's pid answers names a process that reused the number.
 */
export function restartUnderway(note: RestartNote, now = Date.now()): boolean {
  return alive(note.byPid) && now - Date.parse(note.quitAt) < editorRestartTimeoutMs() + 30_000;
}

/**
 * Why no editor of [param projectPath] would ever dial in, read off the project's own addon, or
 * null when the addon is installed and enabled, or there is no project there to read.
 */
export function editorAddonMissing(projectPath: string): { why: string; remedies: string[] } | null {
  if (!existsSync(join(projectPath, 'project.godot'))) {
    return null;
  }
  const report = inspectProject(projectPath);
  const installed = report.addons.some((addon) => addon.name === 'gdharness_editor' && addon.installed);
  if (installed && report.pluginsEnabled.includes('gdharness_editor')) {
    return null;
  }
  return {
    why: `the gdharness editor addon is not ${installed ? 'enabled' : 'installed'} in ${projectPath}`,
    remedies: installed
      ? [
          'project_settings enable_plugin with pluginName gdharness_editor enables it',
          'Or enable it under Project Settings, Plugins, in an editor opened by hand',
        ]
      : [
          `No gdharness tool installs the addon: run  ${gdharnessCommand(SERVER_VERSION, `setup "${projectPath}" --no-connect`)}  in a shell, which installs and enables the addons and writes no harness configuration`,
        ],
  };
}

/**
 * Why an editor opened on [param projectPath] would be asked nothing but to quit, read off the
 * digest its editor addon was installed with, or null when that is this server's or unmarked.
 *
 * Opened anyway, the launch answered launched, the editor imported the project and connected, and
 * only then did editor_status say every call was refused until an upgrade.
 */
export function editorAddonOfAnotherRelease(projectPath: string): { why: string; remedies: string[] } | null {
  return addonOfAnotherRelease(projectPath, 'editor', {
    onDisk: installedEditorDigest(projectPath),
    shipped: shippedEditorDigest(),
    version: installedAddonVersion(projectPath),
  });
}

/**
 * Why a game started on [param projectPath] would be asked nothing, read off the digest its runtime
 * addon was installed with, or null when that is this server's or unmarked. Started anyway, the
 * game ran and every runtime call was refused, and the start said so only when the game announced
 * inside its wait.
 */
export function runtimeAddonOfAnotherRelease(
  projectPath: string,
): { why: string; remedies: string[] } | null {
  return addonOfAnotherRelease(projectPath, 'runtime', {
    onDisk: installedRuntimeDigest(projectPath),
    shipped: shippedRuntimeDigest(),
    version: installedRuntimeVersion(projectPath),
  });
}

function addonOfAnotherRelease(
  projectPath: string,
  which: 'editor' | 'runtime',
  marked: { readonly onDisk: string | null; readonly shipped: string; readonly version: string | null },
): { why: string; remedies: string[] } | null {
  const { onDisk, shipped, version } = marked;
  if (onDisk === null || onDisk === shipped) {
    return null;
  }
  const addon =
    version === null || version === SERVER_VERSION
      ? `a different build of the ${which} addon from the one this ${SERVER_VERSION} server ships`
      : `the ${version} ${which} addon while this server ships ${SERVER_VERSION}`;
  return {
    why: `${projectPath} holds ${addon}`,
    remedies:
      version !== null && isNewer(version, SERVER_VERSION)
        ? [`This server is the older half: reconnect it in your harness so it spawns ${version}`]
        : [
            `Run  ${gdharnessCommand(SERVER_VERSION, `upgrade "${projectPath}"`)}  in a shell, which installs this server's addons, then ${which === 'editor' ? 'open' : 'start'} again`,
          ],
  };
}

/**
 * The ports to open an editor on: the defaults whenever they are free, and anything else when
 * they are not. Godot serves one language server and one debug adapter port each for the whole
 * machine, so a second editor on the defaults binds neither. A port named in the environment is
 * somebody's decision and is passed on rather than moved.
 */
export async function portsForAnEditor(): Promise<EditorPorts> {
  const lsp = portFromEnvOrNull('GDHARNESS_LSP_PORT') ?? (await freePort(DEFAULT_LSP_PORT));
  const dap = portFromEnvOrNull('GDHARNESS_DAP_PORT') ?? (await freePort(DEFAULT_DAP_PORT));
  return { lsp, dap };
}

/** The editors of [param projectPath] running, or undefined when the platform would not list them. */
async function editorsOfProject(projectPath: string): Promise<number[] | undefined> {
  const tree = await processTree();
  // A process ended a moment ago can still be listed on Windows until its termination finishes.
  return tree === undefined ? undefined : editorsOfProjectIn(tree, projectPath).filter((pid) => alive(pid));
}

/**
 * Runs [param open] once no other open of [param projectPath]'s editor is under way, from any
 * server or command on the machine. The check for a running editor goes inside it, so the second
 * of two opens at once finds the editor the first started.
 */
export async function inTurnToOpen<T>(projectPath: string, open: () => Promise<T>): Promise<T> {
  return await inTurnFor(projectPath, join(projectPath, '.godot', 'gdharness-editor-open'), open);
}

/** How an editor is to be started. */
export interface EditorStart {
  readonly hidden: boolean;
  readonly silent: boolean;
  /** A process whose end the editor saves and quits at, or null for one that stays. */
  readonly until: number | null;
}

/** An editor started, or why it was not. */
export interface EditorOpened {
  readonly pid: number | null;
  readonly startedAt: number | null;
  readonly error: string | null;
  readonly arguments: readonly string[];
}

/**
 * Starts an editor on a project, on the ports named, through a launcher that exits once the editor
 * is up, so the editor is nobody's child here. The harness ends a server by killing its process
 * tree at every reconnect, and an editor spawned as its child went with it.
 *
 * TMP and the runtime directory are passed down because a game the editor plays inherits the
 * editor's environment, not this process's. The ports go in the environment too because the engine
 * keeps what it was told to itself, and OPENED_BY_A_SERVER says that whatever wrote these arguments
 * can write them again, which decides who may restart the editor.
 */
export async function openEditorProcess(
  engine: string,
  projectPath: string,
  ports: EditorPorts,
  start: EditorStart,
): Promise<EditorOpened> {
  clearEditorLog(projectPath);
  // An editor being restarted may not have let its library copies go yet.
  freeLibraryCopies(projectPath);
  if (start.hidden) {
    const unplaced = await placeEmptyScriptDocs(engine, projectPath);
    if (unplaced !== null) {
      console.error(
        `[SERVER] The hidden editor starts without an empty script reference cache: ${unplaced}.`,
      );
    }
  }
  const args = editorArguments(
    projectPath,
    ports,
    editorLogPath(projectPath),
    start.hidden,
    start.silent,
    process.platform,
    start.until,
  );
  const launched = await launchOutsideTheTree({
    command: engine,
    args,
    env: {
      ...process.env,
      GDHARNESS_RUNTIME_DIR: runtimeDirectory(),
      GDHARNESS_LSP_PORT: String(ports.lsp),
      GDHARNESS_DAP_PORT: String(ports.dap),
      [OPENED_BY_A_SERVER]: '1',
    },
    // A hidden editor is on a desktop of its own, because the games it plays are its children and
    // land where it is. A visible one is shown without being activated, so it takes nobody's keyboard.
    ...(start.hidden ? { desktop: HIDDEN_DESKTOP } : { noActivate: true }),
  });
  if ('error' in launched) {
    return { pid: null, startedAt: null, error: launched.error, arguments: args };
  }
  // As soon as the pid is known, since whoever opened it can be ended at any moment after, and a
  // note written later leaves an editor writing a console nothing can claim. Again with the start
  // time, which tells the editor from a later process holding its pid.
  writeEditorLogNote(projectPath, launched.pid);
  const startedAt = (await startTimesOf([launched.pid])).get(launched.pid) ?? null;
  if (startedAt !== null) {
    writeEditorLogNote(projectPath, launched.pid, startedAt);
  }
  return { pid: launched.pid, startedAt, error: null, arguments: args };
}

/** `gdharness editor open [project] [--hidden] [--silent] [--until PID]`, read. */
export interface EditorOpenOptions {
  readonly projectPath: string;
  readonly start: EditorStart;
}

const EDITOR_OPEN_USAGE = 'gdharness editor open [project] [--hidden] [--silent] [--until PID]';

/** The options of `gdharness editor` from [param args], the words after `editor`. */
export function editorOpenOptionsOf(args: readonly string[], cwd: string): EditorOpenOptions {
  if (args[0] !== 'open') {
    throw new EngineUsageError(
      `gdharness editor takes open, not ${args[0] ?? 'nothing'}. Usage: ${EDITOR_OPEN_USAGE}`,
    );
  }
  let named: string | undefined;
  let hidden = false;
  let silent = false;
  let until: number | null = null;
  for (let at = 1; at < args.length; at += 1) {
    const arg = args[at] ?? '';
    if (arg === '--hidden') {
      hidden = true;
    } else if (arg === '--silent') {
      silent = true;
    } else if (arg === '--until') {
      const value = Number(args[at + 1]);
      if (args[at + 1] === undefined || !Number.isInteger(value) || value <= 0) {
        throw new EngineUsageError(`--until takes a process id, not ${args[at + 1] ?? 'nothing'}.`);
      }
      until = value;
      at += 1;
    } else if (arg.startsWith('--')) {
      throw new EngineUsageError(`Unknown option ${arg}. Usage: ${EDITOR_OPEN_USAGE}`);
    } else if (named === undefined) {
      named = arg;
    } else {
      throw new EngineUsageError(
        `gdharness editor open takes one project, and was given ${named} and ${arg}.`,
      );
    }
  }
  const projectPath = resolve(cwd, named ?? '.');
  if (!existsSync(join(projectPath, 'project.godot'))) {
    throw new EngineUsageError(
      `Not a Godot project: ${projectPath} holds no project.godot. Run from the project directory, or name it on the command line.`,
    );
  }
  if (until !== null && !alive(until)) {
    throw new EngineUsageError(
      `Process ${String(until)} is not running, so an editor held by it would quit at once.`,
    );
  }
  return { projectPath, start: { hidden, silent: silent || hidden, until } };
}

/**
 * What `gdharness editor open` did: an editor opened, one already running, or a refusal. An editor
 * opened to quit with a process says under [param unheld] why nothing will close it, when nothing will.
 */
export type EditorOpenOutcome =
  | { readonly opened: number; readonly unheld: string | null }
  | { readonly running: number }
  | { readonly refused: string };

/** The folder under a project's .godot where a holder asks an editor to save and quit. */
const QUITS_FOLDER = 'gdharness-editor-quits';

/** How often a holder looks whether its process has gone, and asks its editors again once it has. */
const HOLD_LOOK_MS = 1_000;

/**
 * Where the holder asks the editor [param editorPid] of [param projectPath] to save and quit. Kept
 * in step with `QUITS_FOLDER` in the editor addon's plugin.gd.
 */
export function editorQuitRequestPath(projectPath: string, editorPid: number): string {
  return join(projectPath, '.godot', QUITS_FOLDER, String(editorPid));
}

/** Whether [param pid] is still the process that started at [param startedAt], when that is known. */
async function stillThe(pid: number, startedAt: number | null): Promise<boolean> {
  return alive(pid) && (startedAt === null || (await startTimesOf([pid])).get(pid) === startedAt);
}

/** The editors of [param projectPath] running that were opened to quit once [param until] has gone. */
async function editorsHeldBy(projectPath: string, until: number): Promise<number[]> {
  const tree = await processTree();
  if (tree === undefined) {
    return [];
  }
  return editorsOfProjectIn(tree, projectPath).filter(
    (pid) => alive(pid) && startedAs(tree.get(pid)?.command ?? '').until === until,
  );
}

/**
 * `gdharness editor hold`: waits for [param until] to go, then asks every editor of the project
 * opened to quit with it to save and quit, and waits for them as long as a restart waits.
 *
 * A process of its own outside every tree, because Godot can ask only after its own children: its
 * `OS.is_process_running` answers false for any other pid. The editors are found by their command
 * line at the end rather than remembered at the start, since a restart replaces the editor with
 * one carrying the same mark. The request is written again while they run, so an editor that
 * loaded its addon after the first one still sees a request newer than itself.
 */
export async function holdTheEditors(
  projectPath: string,
  until: number,
  startedAt: number | null,
): Promise<void> {
  for (let looked = 0; await stillThe(until, startedAt); looked += 1) {
    if (looked === 0) {
      console.log(`Holding the editors of ${projectPath} until pid ${String(until)} has gone.`);
    }
    await delay(HOLD_LOOK_MS);
  }
  const asked = new Set<number>();
  const deadline = Date.now() + editorRestartTimeoutMs();
  for (let held = await editorsHeldBy(projectPath, until); held.length > 0 && Date.now() < deadline; ) {
    mkdirSync(join(projectPath, '.godot', QUITS_FOLDER), { recursive: true });
    for (const pid of held) {
      writeFileSync(editorQuitRequestPath(projectPath, pid), `${String(until)}\n`);
      asked.add(pid);
    }
    await delay(HOLD_LOOK_MS);
    held = await editorsHeldBy(projectPath, until);
  }
  for (const pid of asked) {
    rmSync(editorQuitRequestPath(projectPath, pid), { force: true });
  }
}

/**
 * Starts the holder that closes the editors held by the options' process once it has gone, outside
 * the caller's tree so a session ending its own processes does not take the holder first. Answers
 * why it could not, or null.
 */
async function startTheHolder(
  projectPath: string,
  until: number,
  holderScript: string,
): Promise<string | null> {
  const startedAt = (await startTimesOf([until])).get(until) ?? null;
  const launched = await launchOutsideTheTree({
    command: process.execPath,
    args: [holderScript, 'editor', 'hold', projectPath, String(until), String(startedAt ?? 0)],
  });
  return 'error' in launched ? launched.error : null;
}

/**
 * Opens the editor of the options' project unless one is running, under the turn
 * `editor_launch open` takes, with [param engine] as the engine. An editor opened to quit with a
 * process gets a holder started from [param holderScript], this program's own entry point.
 */
export async function openTheEditor(
  options: EditorOpenOptions,
  engine: string,
  holderScript: string,
): Promise<EditorOpenOutcome> {
  const { projectPath, start } = options;
  const missing = editorAddonMissing(projectPath);
  if (missing !== null) {
    return {
      refused: `${missing.why}, so an editor opened on it would never reach a server. ${missing.remedies.join('. ')}.`,
    };
  }
  return await inTurnToOpen(projectPath, async (): Promise<EditorOpenOutcome> => {
    const owed = restartOwed(projectPath);
    if (owed !== null && restartUnderway(owed)) {
      return {
        refused: `A restart of this project's editor is under way: gdharness server pid ${String(owed.byPid)} asked it to quit at ${owed.quitAt} and is starting it again.`,
      };
    }
    const running = await editorsOfProject(projectPath);
    if (running === undefined) {
      return {
        refused:
          'The operating system would not list its processes, so whether an editor of this project runs cannot be told.',
      };
    }
    const [first] = running;
    if (first !== undefined) {
      return { running: first };
    }
    const opened = await openEditorProcess(engine, projectPath, await portsForAnEditor(), start);
    if (opened.pid === null) {
      return { refused: `Could not start the editor: ${opened.error ?? 'no reason given'}` };
    }
    // The launch a restart ended before its start was owed, and this is it.
    restartSettled(projectPath);
    const unheld = start.until === null ? null : await startTheHolder(projectPath, start.until, holderScript);
    return { opened: opened.pid, unheld };
  });
}
