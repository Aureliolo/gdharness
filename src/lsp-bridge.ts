/**
 * `gdharness lsp`: a stdio client's bytes to the GDScript language server of the project's editor,
 * and its bytes back, so a harness that speaks LSP over stdio reads the engine's own type checker.
 *
 * Nothing is parsed on the way through. The bridge connects to an editor that is already open and
 * never starts one: an editor started here would take the port from the one on the desk, which
 * then gives up on it without trying again, and every answer would come from a process nobody can
 * see. Before the first byte goes through, the port is asked whether it serves this project, since
 * Godot binds one language server a machine by default and the editor holding it may be another
 * project's.
 */
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { alive } from './alive.js';
import { EngineUsageError } from './engine-launch.js';
import { DEFAULT_LSP_PORT, GodotLSPClient } from './lsp_client.js';
import { oneShotOptionOf, startTimesOf } from './process-children.js';
import { isRecord } from './records.js';

/** Kept in step with `EDITORS_RECORDED_PROTOCOL` in the editor addon's bridge_client.gd. */
const EDITOR_RECORD_PROTOCOL = 1;

/** How long to wait for an editor of the project to serve, by default. */
export const LSP_WAIT_SECONDS = 20;

const HOST = '127.0.0.1';
const LOOK_AGAIN_MS = 500;

/** The ports one editor of the project says it serves. */
export interface EditorRecord {
  readonly file: string;
  readonly pid: number;
  readonly lspPort: number;
  readonly writtenAtMs: number;
}

/**
 * What every editor of the project at [param projectPath] wrote about its ports, newest first,
 * kept in `.godot/gdharness-editors/<pid>.json` by the editor addon. A file that is not the shape
 * it writes is passed over.
 */
export function editorRecordsIn(projectPath: string): EditorRecord[] {
  const directory = join(projectPath, '.godot', 'gdharness-editors');
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => /^\d+\.json$/.test(name));
  } catch {
    return [];
  }
  const records: EditorRecord[] = [];
  for (const name of names) {
    const file = join(directory, name);
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const said: Record<string, unknown> = isRecord(parsed) ? parsed : {};
      const { protocol, pid, lsp_port: lspPort, written_at_ms: writtenAtMs } = said;
      if (
        protocol === EDITOR_RECORD_PROTOCOL &&
        typeof pid === 'number' &&
        typeof lspPort === 'number' &&
        lspPort > 0 &&
        typeof writtenAtMs === 'number'
      ) {
        records.push({ file, pid, lspPort, writtenAtMs });
      }
    } catch {
      // Half written, or something else's: the next look reads it again.
    }
  }
  return records.toSorted((a, b) => b.writtenAtMs - a.writtenAtMs);
}

/**
 * The records among [param records] written by an editor still running, judged by
 * [param startedAt] and [param oneShotOf].
 *
 * A pid is handed out again once its holder has gone, so the process under it has to have started
 * before the record was written, give or take the second some platforms round a start to. One
 * whose command line makes it a single job, a gate's `--import` or an export, loaded the addon and
 * wrote a record of the ports it would have served, and is nobody's editor.
 */
export function liveEditorRecords(
  records: readonly EditorRecord[],
  startedAt: ReadonlyMap<number, number>,
  oneShotOf: ReadonlyMap<number, string | null | undefined>,
): EditorRecord[] {
  return records.filter((record) => heldByItsWriter(record, startedAt) && oneShotOf.get(record.pid) === null);
}

/** Whether the process under [param record]'s pid is the one that wrote it. */
function heldByItsWriter(record: EditorRecord, startedAt: ReadonlyMap<number, number>): boolean {
  const began = startedAt.get(record.pid);
  return began !== undefined && began <= record.writtenAtMs + 1000;
}

/**
 * Deletes each of [param records] whose writer has gone, and answers how many: its pid is held by
 * nothing, or by a process that started after the record was written. An editor removes its own as
 * it closes, so these are the ones a crash or a kill left behind, which would otherwise be read on
 * every start for as long as the project's `.godot` lasts. A pid missing from [param startedAt] is
 * one the platform would not say about, and is not taken as gone.
 */
export function removeLeftRecords(
  records: readonly EditorRecord[],
  startedAt: ReadonlyMap<number, number>,
  held: (pid: number) => boolean = alive,
): number {
  let removed = 0;
  const left = records.filter((one) => {
    const began = startedAt.get(one.pid);
    return began === undefined ? !held(one.pid) : began > one.writtenAtMs + 1000;
  });
  for (const record of left) {
    try {
      unlinkSync(record.file);
      removed += 1;
    } catch {
      // Removed by another reader first, or not ours to remove: either way it is not read again.
    }
  }
  return removed;
}

/** Where `gdharness lsp` looks for the language server, in order. */
export interface LspPortChoice {
  readonly port: number;
  readonly from: string;
}

/**
 * The ports to try, in order: one named by [param named] or the GDHARNESS_LSP_PORT in
 * [param variable] alone, since a port somebody named is the only one meant. Otherwise each live
 * editor's, newest first, then Godot's default.
 */
export function lspPortChoices(
  named: number | undefined,
  variable: string | undefined,
  editors: readonly EditorRecord[],
): LspPortChoice[] {
  if (named !== undefined) {
    return [{ port: named, from: '--port' }];
  }
  const fromVariable = Number(variable);
  if (variable !== undefined && variable !== '' && Number.isInteger(fromVariable) && fromVariable > 0) {
    return [{ port: fromVariable, from: 'GDHARNESS_LSP_PORT' }];
  }
  const choices = editors.map((editor) => ({
    port: editor.lspPort,
    from: `the editor with pid ${editor.pid}`,
  }));
  if (!choices.some((choice) => choice.port === DEFAULT_LSP_PORT)) {
    choices.push({ port: DEFAULT_LSP_PORT, from: "Godot's default" });
  }
  return choices;
}

/** What asking a port about the project found. */
type Probe = { serves: true } | { serves: false; why: string };

/**
 * Whether the language server on [param port] serves [param projectPath]: one that answers an
 * initialize for this project without telling the client to move to another workspace.
 */
async function probe(port: number, projectPath: string): Promise<Probe> {
  const client = new GodotLSPClient(port, HOST, {
    requestMs: 10_000,
    referencesMs: 10_000,
    initializeMs: 10_000,
    listenMs: 0,
  });
  try {
    await client.connect();
    await client.initialize(projectPath);
    return { serves: true };
  } catch (error) {
    return { serves: false, why: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

/** Options of `gdharness lsp`. */
export interface LspOptions {
  readonly projectPath: string;
  readonly port: number | undefined;
  readonly waitSeconds: number;
}

/** `gdharness lsp [project] [--port N] [--wait S]` read from [param args], relative to [param cwd]. */
export function lspOptionsOf(args: readonly string[], cwd: string): LspOptions {
  let named: string | undefined;
  let port: number | undefined;
  let waitSeconds = LSP_WAIT_SECONDS;
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] ?? '';
    if (arg === '--port' || arg === '--wait') {
      const value = Number(args[at + 1]);
      const whole = arg === '--port' ? Number.isInteger(value) && value > 0 && value < 65536 : value >= 0;
      if (args[at + 1] === undefined || !whole) {
        throw new EngineUsageError(
          `${arg} takes ${arg === '--port' ? 'a port, 1 to 65535' : 'a number of seconds'}, not ${args[at + 1] ?? 'nothing'}.`,
        );
      }
      if (arg === '--port') {
        port = value;
      } else {
        waitSeconds = value;
      }
      at += 1;
    } else if (arg.startsWith('--')) {
      throw new EngineUsageError(`Unknown option ${arg}. gdharness lsp takes --port N and --wait S.`);
    } else if (named === undefined) {
      named = arg;
    } else {
      throw new EngineUsageError(`gdharness lsp takes one project, and was given ${named} and ${arg}.`);
    }
  }
  const projectPath = resolve(cwd, named ?? '.');
  if (!existsSync(join(projectPath, 'project.godot'))) {
    throw new EngineUsageError(
      `Not a Godot project: ${projectPath} holds no project.godot. Run from the project directory, or name it on the command line.`,
    );
  }
  return { projectPath, port, waitSeconds };
}

/** A line on standard error, which is the only place anything but LSP traffic may go. */
function note(message: string): void {
  process.stderr.write(`gdharness lsp: ${message}\n`);
}

/**
 * Finds the language server of the project's editor, waiting up to the option's seconds for one,
 * then pipes standard input to it and it to standard output until either side ends. Answers the
 * exit code: 0 when the client or the editor ended the session, 1 when no editor of the project
 * served in time.
 */
export async function runLspBridge(options: LspOptions): Promise<number> {
  const deadline = Date.now() + options.waitSeconds * 1000;
  const said = new Set<string>();
  const sayOnce = (message: string): void => {
    if (!said.has(message)) {
      said.add(message);
      note(message);
    }
  };
  let last: string[] = [];
  for (;;) {
    const records = editorRecordsIn(options.projectPath);
    const pids = records.map((record) => record.pid);
    const startedAt = await startTimesOf(pids);
    removeLeftRecords(records, startedAt);
    const oneShotOf = new Map<number, string | null | undefined>();
    for (const pid of pids.filter((one) => startedAt.has(one))) {
      oneShotOf.set(pid, await oneShotOptionOf(pid));
    }
    const choices = lspPortChoices(
      options.port,
      process.env['GDHARNESS_LSP_PORT'],
      liveEditorRecords(records, startedAt, oneShotOf),
    );
    last = [];
    for (const choice of choices) {
      const found = await probe(choice.port, options.projectPath);
      if (found.serves) {
        return await pipe(choice.port);
      }
      last.push(`port ${choice.port} (${choice.from}): ${found.why}`);
    }
    if (Date.now() >= deadline) {
      break;
    }
    sayOnce(`no language server of ${options.projectPath} yet, waiting for its editor`);
    await new Promise((settle) => setTimeout(settle, LOOK_AGAIN_MS));
  }
  note(
    [
      `no language server of ${options.projectPath} answered in ${options.waitSeconds} s.`,
      ...last.map((line) => `  ${line}`),
      '  Open the project in the Godot editor, which serves it. This does not start one, since a second',
      '  editor would take the port from yours. An editor serving another project holds the port when',
      '  two are open: start this one through gdharness, which moves it to a free port.',
    ].join('\n'),
  );
  return 1;
}

/** Connects to [param port] and passes the bytes both ways until either side ends. */
async function pipe(port: number): Promise<number> {
  const socket: Socket = connect({ host: HOST, port });
  socket.setNoDelay(true);
  return await new Promise<number>((exitWith) => {
    socket.once('connect', () => {
      process.stdin.pipe(socket);
      socket.pipe(process.stdout);
    });
    process.stdin.once('end', () => socket.end());
    socket.once('error', (error) => {
      note(`the connection to port ${port} failed: ${error.message}`);
      exitWith(1);
    });
    socket.once('close', () => {
      exitWith(0);
    });
  });
}
