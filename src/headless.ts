/**
 * A headless operation: the engine run on a project with the operations script, one JSON object
 * written to a file as the answer.
 *
 * Every tool that needs no editor and no running game goes through here, so the contract with
 * the script lives in one place: parameters cross as snake_case in a file, the answer comes back in
 * another, and a run that wrote no answer failed, with the reason in what it printed.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { emptyRecord } from './dictionary.js';
import { docCacheCrash, docCachesWritten, editorCacheDirectory } from './doc-cache.js';
import { EXIT_LEAK, projectSelfTypedExports, selfTypedSentence } from './engine-leaks.js';
import { type EngineRun, howItEnded, runEngine } from './engine-run.js';
import type { GameLog, LogEntry } from './game-log.js';
import { IMPORTABLE_EXTENSIONS } from './import-freshness.js';
import { freeLibraryCopies } from './library-copies.js';
import { realAsFarAsItExists } from './paths.js';
import { forceNextImport } from './reimport.js';
import { discard, scratchDirectory } from './scratch.js';
import { notCompiledIn } from './script-origins.js';
import type { OperationParams } from './server-types.js';

export interface HeadlessEngine {
  readonly godotPath: string;
  /** The operations script, an absolute path outside the project. */
  readonly script: string;
  /** Ask the script for its own debug lines. */
  readonly debug: boolean;
  /** Start the engine as an editor, which is the only engine that can make an exporter. */
  readonly editor?: boolean;
  /** How long an operation's engine may run before it is ended; ten minutes when not given. */
  readonly ceiling?: { readonly ms: number; readonly said: string };
}

/** The problems a run reported, as many as an answer carries, and how many older ones it left out. */
interface Reported {
  /** What the engine and the script reported on the way, as problems rather than lines. */
  readonly messages: readonly LogEntry[];
  readonly messagesOmitted?: number;
  /** What was reported once the answer was written, which is not the operation's. */
  readonly afterAnswerMessages?: readonly LogEntry[];
  readonly afterAnswerOmitted?: number;
  /**
   * What those messages mean when the caller knows better than the default note, which takes an
   * autoload that failed to compile as broken: a rebuild of the class list compiles the autoloads
   * against the list the engine started with, and that list lacks every class the rebuild added.
   */
  readonly afterAnswerNote?: string;
  /** The project's scripts the engine never frees, when it reported at exit what it still held. */
  readonly exitLeakNote?: string;
  /** What the autoloads reported while an operation waited for them, which is not its own either. */
  readonly beforeOperationMessages?: readonly LogEntry[];
  readonly beforeOperationOmitted?: number;
}

export type HeadlessOutcome =
  | (Reported & {
      readonly ok: true;
      readonly payload: OperationParams;
      /** How the engine ended when it did not exit cleanly after writing its answer. */
      readonly afterAnswer?: string;
    })
  | (Reported & { readonly ok: false; readonly message: string });

/**
 * The script reads its parameters in snake_case, the tools take them in camelCase. Only the
 * parameters themselves are renamed: what they hold (a setting value, import options, a list of
 * events) is the engine's own vocabulary, or the tool schema's, and crosses as written.
 */
function snakeCased(params: OperationParams): OperationParams {
  const result: OperationParams = emptyRecord();
  for (const [key, value] of Object.entries(params)) {
    const name = key.startsWith('_') ? key : key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    result[name] = value;
  }
  return result;
}

/**
 * What an answer carries of [param outcome] besides its payload: the problems reported on the way,
 * how many older ones were left out, and an engine that did not exit cleanly after answering.
 */
export function engineExtras(
  outcome: Reported & { readonly afterAnswer?: string | undefined },
): Record<string, unknown> {
  const after = outcome.afterAnswerMessages ?? [];
  const before = outcome.beforeOperationMessages ?? [];
  // Beside whichever list holds the engine's report at exit: after the answer when there is one,
  // among the operation's own when it refused and wrote none.
  const leakIn = (entries: readonly LogEntry[]): string | undefined =>
    entries.some((entry) => EXIT_LEAK.test(entry.text)) ? outcome.exitLeakNote : undefined;
  const notes = (...parts: (string | undefined)[]): string | undefined =>
    parts.filter((part) => part !== undefined).join(' ') || undefined;
  const ownNote = notes(notImportedNote(outcome.messages), leakIn(outcome.messages));
  return {
    ...(outcome.messages.length > 0 ? { engine_messages: outcome.messages } : {}),
    ...(ownNote === undefined ? {} : { engine_messages_note: ownNote }),
    ...(before.length > 0
      ? {
          engine_messages_before_operation: before,
          engine_messages_before_operation_note: withNotCompiled(BEFORE_OPERATION_NOTE, before),
        }
      : {}),
    ...(outcome.beforeOperationOmitted === undefined
      ? {}
      : { engine_messages_before_operation_omitted: outcome.beforeOperationOmitted }),
    ...(outcome.messagesOmitted === undefined ? {} : { engine_messages_omitted: outcome.messagesOmitted }),
    ...(after.length > 0
      ? {
          engine_messages_after_answer: after,
          engine_messages_after_answer_note: notes(
            outcome.afterAnswerNote ?? withNotCompiled(AFTER_ANSWER_NOTE, after),
            leakIn(after),
          ),
        }
      : {}),
    ...(outcome.afterAnswerOmitted === undefined
      ? {}
      : { engine_messages_after_answer_omitted: outcome.afterAnswerOmitted }),
    ...(outcome.afterAnswer === undefined ? {} : { engine_after_answer: outcome.afterAnswer }),
  };
}

/**
 * Why the messages printed after an operation answered are kept apart from its own.
 *
 * Godot starts a project's autoloads in every script run, after the script's `_init`, and has no
 * switch to leave them out; the operation is finished by then. Mixed in with the operation's own,
 * an autoload's errors read as the operation's: a settings read on a project with a failing
 * autoload came back carrying that autoload's errors, every time, and a caller took the read to
 * have gone wrong.
 */
const AFTER_ANSWER_NOTE =
  "Printed after this operation had written its answer, while the engine ran the project's autoloads and shut down: Godot starts a project's autoloads in every script run and cannot be told not to. An error raised in a project script here is that autoload's own, and none of these changes the answer.";

/**
 * [param note] with what a script the autoloads could not compile means for the project, when
 * [param entries] hold one. The note says none of the messages changes the answer, which is true of
 * the operation and left a caller who had just registered a broken autoload with `saved: true` to
 * guess that every run of the project now starts without it.
 */
export function withNotCompiled(note: string, entries: readonly LogEntry[]): string {
  const path = entries.map(notCompiledIn).find((found) => found !== undefined);
  return path === undefined
    ? note
    : `${note} ${path} did not compile, so every run of this project starts its autoloads without it until it is fixed; its errors are among these.`;
}

/**
 * What "No loader found" means for a file the engine imports, which its own words hide. Such a file
 * is loaded from its import rather than read as it is, so until it is first imported the engine has
 * no loader for it, and a scene using it reports a non-existent resource that is there on disk.
 */
export function notImportedNote(entries: readonly LogEntry[]): string | undefined {
  const paths = [
    ...new Set(
      entries.flatMap((entry) => {
        const path = /^No loader found for resource: (res:\/\/\S+)/.exec(entry.text)?.[1];
        const extension = path?.split('.').pop()?.toLowerCase() ?? '';
        return path !== undefined && IMPORTABLE_EXTENSIONS.includes(extension) ? [path] : [];
      }),
    ),
  ];
  if (paths.length === 0) {
    return undefined;
  }
  const one = paths.length === 1;
  return `${paths.join(', ')} ${one ? 'has' : 'have'} no import the engine can load, which is how a file it imports stands before it is first imported, so what uses ${one ? 'it' : 'them'} reads ${one ? 'it' : 'them'} as missing although ${one ? 'it is' : 'they are'} on disk: project_import reimport imports ${one ? 'it' : 'them'}.`;
}

const BEFORE_OPERATION_NOTE =
  "Printed while the engine started the project's autoloads, before this operation ran: an operation that compiles the project's scripts waits for them, because the engine knows an autoload's name only once it is in the tree. An error raised in a project script here is that autoload's own.";

/** How the operations script marks its own errors, which are otherwise ordinary lines to the engine. */
const OWN_ERROR = '[ERROR] ';

/**
 * What the operations script prints once its answer is written. Kept in step with `ANSWERED` in
 * godot_operations.gd.
 */
export const ANSWERED = '[gdharness] answered';

/**
 * What the operations script prints in `_init` for an operation that waits for the project's
 * autoloads, and when that operation begins. Kept in step with godot_operations.gd.
 */
export const WAITING = '[gdharness] waiting for the autoloads';
export const BEGUN = '[gdharness] begun';

/**
 * What the operations script prints around engine output it provokes for a question of its own,
 * such as whether a script parsed before a change. Those errors are about a file the answer does
 * not describe, so they are left out of it. Kept in step with logger.gd.
 */
export const ASIDE = '[gdharness] aside';
export const RESUMED = '[gdharness] resumed';

/** [param entries] without the stretches between an `ASIDE` mark and the `RESUMED` after it. */
function withoutAsides(entries: readonly LogEntry[]): LogEntry[] {
  const kept: LogEntry[] = [];
  let aside = false;
  for (const entry of entries) {
    const mark = entry.source === 'stderr' ? entry.text : '';
    if (mark === ASIDE || mark === RESUMED) {
      aside = mark === ASIDE;
    } else if (!aside) {
      kept.push(entry);
    }
  }
  return kept;
}

/** At most this many of the newest problems ride on an answer; the rest are counted. */
const MESSAGES_KEPT = 200;
/** How long one operation's engine may run, twice what an export is given. */
const OPERATION_CEILING = { ms: 600_000, said: 'ten minutes' } as const;

/** Of the engine's errors, how many a reason names before counting the rest. */
const ERRORS_NAMED = 3;

/**
 * Every problem [param log] holds: the engine's warnings and errors, and the script's own `[ERROR]`
 * lines as errors. Those are the script refusing, or giving up on part of what it was asked, and read
 * as ordinary lines they were dropped from an answer that went on to say it had succeeded.
 */
function problemsIn(log: GameLog): LogEntry[] {
  return problemsAmong(log.everything());
}

function problemsAmong(entries: readonly LogEntry[]): LogEntry[] {
  return entries.flatMap((entry): LogEntry[] => {
    if (entry.severity !== 'info') {
      return [entry];
    }
    if (entry.source === 'stderr' && entry.text.startsWith(OWN_ERROR)) {
      return [{ ...entry, severity: 'error', text: entry.text.slice(OWN_ERROR.length) }];
    }
    return [];
  });
}

function reported(problems: readonly LogEntry[]): Reported {
  const omitted = Math.max(0, problems.length - MESSAGES_KEPT);
  return omitted === 0
    ? { messages: problems }
    : { messages: problems.slice(omitted), messagesOmitted: omitted };
}

/**
 * The reason a run failed, as the script or the engine gave it. The script's own refusals come
 * first, then the engine's first errors, which are the cause more often than what they set off, and
 * stdout's last words are the fallback for a run that reported nothing.
 */
function reason(log: GameLog, problems: readonly LogEntry[]): string {
  const own = refusalsIn(log);
  if (own.length > 0) {
    return own.map((entry) => entry.text.slice(OWN_ERROR.length)).join('; ');
  }
  const errors = problems.filter((entry) => entry.severity === 'error').map((entry) => entry.text);
  if (errors.length > 0) {
    const rest = errors.length - ERRORS_NAMED;
    return rest > 0
      ? `${errors.slice(0, ERRORS_NAMED).join('; ')}; and ${rest} more error${rest === 1 ? '' : 's'}`
      : errors.join('; ');
  }
  const printed = log.everything().filter((entry) => entry.source === 'stdout');
  return printed.at(-1)?.text ?? 'no output at all';
}

/** The operations script's own `[ERROR]` lines in [param log], as the engine logged them. */
function refusalsIn(log: GameLog): LogEntry[] {
  return log
    .everything()
    .filter(
      (entry) => entry.source === 'stderr' && entry.severity === 'info' && entry.text.startsWith(OWN_ERROR),
    );
}

/**
 * The first runtime error raised inside the operations script itself, if any.
 *
 * The engine aborts only the function that raised it and hands its caller a default value, so an
 * operation that hit one still writes an answer and exits 0, with part of the answer missing or
 * empty. Read from the error's own location, not its backtrace: a project script that fails while
 * an operation calls it has operation frames further down, and that failure is the project's.
 */
function scriptFault(problems: readonly LogEntry[], script: string): LogEntry | undefined {
  const spelled = (path: string): string => `(${path.replaceAll('\\', '/').toLowerCase()}/`;
  // Both spellings, because the engine may print the resolved one: a temporary directory on macOS
  // is reached through the /var link to /private/var.
  const directories = [...new Set([spelled(dirname(script)), spelled(realAsFarAsItExists(dirname(script)))])];
  return problems.find((entry) => {
    const at = entry.detail
      .find((line) => line.startsWith('at: '))
      ?.replaceAll('\\', '/')
      .toLowerCase();
    return (
      entry.severity === 'error' &&
      at !== undefined &&
      directories.some((directory) => at.includes(directory))
    );
  });
}

/** One import pass's outcome, and the extension libraries a first pass could not load, if any. */
export type ImportOutcome = (
  | (Reported & { readonly ok: true })
  | (Reported & { readonly ok: false; readonly message: string })
) & {
  readonly librariesRetried?: readonly string[];
  /** Of those, the ones the second pass could not load either. */
  readonly librariesNotLoaded?: readonly string[];
  /** What a caller is told about the second pass, present whenever there was one. */
  readonly extensionNote?: string;
  /** Present when a pass crashed on its way out over a stale class reference cache: see {@link docCacheCrash}. */
  readonly docCacheNote?: string;
};

/**
 * The GDExtension libraries an engine could not load because it could not make its own copy of
 * them, read from what it printed.
 *
 * On Windows an engine running with the editor hint, which an import pass is, loads each extension
 * from a `~` copy made beside the library, and the running editor holds its own copy at that path.
 * Measured on 4.7.2 with GodotSteam: an import started beside a headless editor printed "Error
 * copying library" and ran without the extension, and the same import run again loaded it, because
 * the failed attempt had moved the editor's copy aside as a `~RF….TMP` file. Each pass moves the
 * copy aside first ({@link freeLibraryCopies}), so what is left to collide is an engine that took
 * the name between that and its own load.
 */
export function librariesNotCopied(messages: readonly LogEntry[]): string[] {
  const found = new Set<string>();
  for (const entry of messages) {
    const library = /Error copying library: (.+)$/.exec(entry.text)?.[1]?.trim();
    if (library !== undefined && library !== '') {
      found.add(library);
    }
  }
  return [...found];
}

/** What a caller is told when an import pass was run a second time for [param libraries]. */
function extensionRetryNote(libraries: readonly string[], stillNotLoaded: readonly string[] = []): string {
  const second =
    stillNotLoaded.length === 0
      ? 'so the import was run again and loaded the extension, and the messages are from that second run.'
      : `so the import was run again, and it still could not load ${stillNotLoaded.join(' and ')}: this answer is from an import without ${stillNotLoaded.length === 1 ? 'it' : 'them'}, and its messages say what the engine hit.`;
  return (
    `The first import could not load ${libraries.join(' and ')}: on Windows an engine running as the editor ` +
    'loads a GDExtension from a ~ copy beside the library, and the editor open on this project holds its own ' +
    'copy there, so the first engine started beside it cannot make one. That failed attempt moves the ' +
    `editor's copy aside, ${second} The editor's copy is left beside the library as a ~RF….TMP file, which ` +
    'the next import, export or editor this server starts on the project deletes once the editor has exited.'
  );
}

/**
 * The engine's own import pass over a project, which is what mints a missing `.uid`, run a second
 * time when the first could not copy an extension library (see {@link librariesNotCopied}) or
 * crashed on its way out over a stale class reference cache (see {@link docCacheCrash}).
 *
 * Not an operation: there is no script and no answer to parse, only the exit status and whatever
 * the engine complained about. It is here rather than in the server because it is the same engine
 * boot as every other headless call, and wants the same log-file treatment: the project's own
 * `user://logs/godot.log` is rotated on start, so a boot that used it would rotate a running
 * bench's log out from under it.
 */
export async function runImport(
  godotPath: string,
  projectPath: string,
  options: {
    /**
     * `res://` paths every pass reimports whatever the engine would judge of them. Armed before the
     * second pass as well as the first: the first imported them without the extension, and a
     * resource it has imported reads as up to date to the second, which would then pass it over.
     */
    readonly forcing?: readonly string[];
    readonly once?: (godotPath: string, projectPath: string) => Promise<ImportOutcome>;
  } = {},
): Promise<ImportOutcome> {
  const once = options.once ?? importOnce;
  const pass = (): Promise<ImportOutcome> => {
    for (const target of options.forcing ?? []) {
      forceNextImport(projectPath, target);
    }
    freeLibraryCopies(projectPath);
    return once(godotPath, projectPath);
  };
  const first = await pass();
  const collided = librariesNotCopied(first.messages);
  const crash = first.docCacheNote;
  if (collided.length === 0 && crash === undefined) {
    return first;
  }
  const { docCacheNote: _, ...again } = await pass();
  // A refusal is answered by its message alone, so the note travels inside it.
  const second =
    again.ok || crash === undefined
      ? again
      : { ...again, message: `${again.message.replace(/[.\s]+$/, '')}. ${crash}` };
  const still = librariesNotCopied(second.messages);
  return {
    ...second,
    ...(collided.length === 0
      ? {}
      : {
          librariesRetried: collided,
          ...(still.length === 0 ? {} : { librariesNotLoaded: still }),
          extensionNote: extensionRetryNote(collided, still),
        }),
    ...(crash === undefined ? {} : { docCacheNote: crash }),
  };
}

/** What the engine prints when a .blend file is to be imported and no Blender is set. */
const NO_BLENDER = 'Blender path is invalid or not set';

const BLENDER_STOPPED =
  'the import pass stopped at a .blend file and imported nothing: the engine imports .blend files through Blender, which the editor setting filesystem/import/blender/blender_path names, and here it names none. Set it in an editor, or set the project setting filesystem/import/blender/enabled to false with project_settings set, which has the engine leave .blend files unimported.';

async function importOnce(godotPath: string, projectPath: string): Promise<ImportOutcome> {
  const logDir = scratchDirectory('import');
  const caches = editorCacheDirectory(godotPath);
  const cachesBefore = docCachesWritten(caches);
  let ran: EngineRun;
  try {
    ran = await runEngine(godotPath, [
      '--headless',
      '--log-file',
      join(logDir, 'engine.log'),
      '--path',
      projectPath,
      '--import',
    ]);
  } finally {
    discard(logDir);
  }
  const problems = problemsIn(ran.log);
  const crash = docCacheCrash(ran, cachesBefore, docCachesWritten(caches), 'import');
  // The engine exits 0 having imported nothing at all, the files before the .blend in the scan
  // included, so the pass is a failure whatever the exit code says.
  if (problems.some((entry) => entry.text.startsWith(NO_BLENDER))) {
    return {
      ok: false,
      message: BLENDER_STOPPED,
      ...reported(problems),
      ...(crash === null ? {} : { docCacheNote: crash }),
    };
  }
  if (ran.exitCode === 0 && ran.failure === null) {
    return { ok: true, ...reported(problems), ...(crash === null ? {} : { docCacheNote: crash }) };
  }
  return {
    ok: false,
    message: `the import pass failed (${howItEnded(ran)}): ${reason(ran.log, problems)}`,
    ...reported(problems),
    ...(crash === null ? {} : { docCacheNote: crash }),
  };
}

/**
 * [param operation] run by the operations script on the project at [param projectPath], with the
 * project's scripts the engine never frees named when it reported at exit what it still held.
 */
export async function runOperation(
  engine: HeadlessEngine,
  operation: string,
  params: OperationParams,
  projectPath: string,
): Promise<HeadlessOutcome> {
  const outcome = await operationOutcome(engine, operation, params, projectPath);
  const heldAtExit = [...outcome.messages, ...(outcome.afterAnswerMessages ?? [])].some((entry) =>
    EXIT_LEAK.test(entry.text),
  );
  const note = heldAtExit ? selfTypedSentence(projectSelfTypedExports(projectPath)) : undefined;
  return note === undefined ? outcome : { ...outcome, exitLeakNote: note };
}

async function operationOutcome(
  engine: HeadlessEngine,
  operation: string,
  params: OperationParams,
  projectPath: string,
): Promise<HeadlessOutcome> {
  // Parameters go via a file rather than the command line: a JSON blob on argv runs into
  // Windows command-line parsing of \t, \r and \" whatever the quoting.
  const paramsDir = scratchDirectory('params');
  const paramsFile = join(paramsDir, `${operation}.json`);
  const answerFile = join(paramsDir, 'answer.json');
  writeFileSync(paramsFile, JSON.stringify(snakeCased(params)), 'utf8');
  const args = [
    '--headless',
    ...(engine.editor === true ? ['--editor'] : []),
    // Away from the project's own user://logs/godot.log, which a project with file logging on
    // has a run writing to. The engine renames that file when a process starts, so a boot here
    // rotated a running bench's log out from under it and the bench went on writing at the
    // offset it still believed it was at: measured as the operation's few hundred bytes, a
    // zero-filled gap, then the bench's next row. These runs answer one question and exit, so
    // the log they write is of no use to anybody and goes where the parameters go.
    '--log-file',
    join(paramsDir, 'engine.log'),
    '--path',
    projectPath,
    '--script',
    engine.script,
    operation,
    `@file:${paramsFile}`,
    answerFile,
    ...(engine.debug ? ['--debug-godot'] : []),
  ];

  let ran: EngineRun;
  let answer: ReturnType<typeof answerIn>;
  try {
    // Every operation answers one question about the project, and one that never finishes holds
    // an engine slot and a core for as long as the server lives: a dependency walk that never
    // answered spun for nearly four hours with nothing to end it.
    ran = await runEngine(engine.godotPath, args, { timeout: engine.ceiling ?? OPERATION_CEILING });
    answer = answerIn(answerFile);
  } finally {
    discard(paramsDir);
  }
  const everything = withoutAsides(ran.log.everything());
  const marked = (text: string): number =>
    everything.findIndex((entry) => entry.source === 'stderr' && entry.text === text);
  const answered = marked(ANSWERED);
  const waiting = marked(WAITING);
  const begun = marked(BEGUN);
  const ended = answered === -1 ? everything.length : answered;
  // An operation that waited for the autoloads ran between the two marks; what came before the
  // first is its own start, and what came between them is the autoloads'.
  const problems =
    waiting === -1
      ? problemsAmong(everything.slice(0, ended))
      : problemsAmong([
          ...everything.slice(0, waiting),
          ...(begun === -1 ? [] : everything.slice(begun + 1, ended)),
        ]);
  const startup =
    waiting === -1 ? [] : problemsAmong(everything.slice(waiting + 1, begun === -1 ? ended : begun));
  const after = answered === -1 ? [] : problemsAmong(everything.slice(answered + 1));
  const afterAnswered = {
    ...(after.length === 0 ? {} : { afterAnswerMessages: after.slice(-MESSAGES_KEPT) }),
    ...(after.length > MESSAGES_KEPT ? { afterAnswerOmitted: after.length - MESSAGES_KEPT } : {}),
    ...(startup.length === 0 ? {} : { beforeOperationMessages: startup.slice(-MESSAGES_KEPT) }),
    ...(startup.length > MESSAGES_KEPT ? { beforeOperationOmitted: startup.length - MESSAGES_KEPT } : {}),
  };

  if (answer.kind === 'unreadable') {
    return {
      ok: false,
      message: `${operation} wrote an answer that could not be read (${answer.why})`,
      ...reported(problems),
      ...afterAnswered,
    };
  }
  // No answer is an operation that refused or an engine that never reached the script, whatever
  // the exit status says.
  if (answer.kind === 'none') {
    if (waiting !== -1 && begun === -1) {
      return {
        ok: false,
        message:
          `${operation} never ran: the engine ended (${howItEnded(ran)}) while it started the project's ` +
          `autoloads, which this operation waits for. The last it reported: ${reason(ran.log, startup)}`,
        ...reported(problems),
        ...afterAnswered,
      };
    }
    // A refusal the script made is the whole message. Prefixed with the script's own name for the
    // operation and its exit status, it read as a crash in something the caller never called, and
    // it came back a second time under engine_messages.
    const refusals = refusalsIn(ran.log);
    if (refusals.length > 0) {
      const said = new Set(refusals.map((entry) => entry.index));
      return {
        ok: false,
        message: refusals.map((entry) => entry.text.slice(OWN_ERROR.length)).join('; '),
        ...reported(problems.filter((entry) => !said.has(entry.index))),
      };
    }
    const ending =
      ran.exitCode === 0 && ran.failure === null ? 'produced no result' : `failed (${howItEnded(ran)})`;
    return {
      ok: false,
      message: `${operation} ${ending}: ${reason(ran.log, problems)}`,
      ...reported(problems),
    };
  }
  const fault = scriptFault(problems, engine.script);
  if (fault !== undefined) {
    return {
      ok: false,
      message:
        `${operation} hit an error in the operations script, so its answer is left out: part of it was ` +
        `never computed. ${fault.text} (${fault.detail[0]?.slice('at: '.length) ?? 'no location given'})`,
      ...reported(problems),
      ...afterAnswered,
    };
  }
  // The answer is written before the engine shuts down and the project's autoloads run, so a
  // failure after it did not undo it: a setting it answered as saved is saved.
  const onTheWayOut = answered === -1 ? problems : after;
  const afterAnswer =
    ran.exitCode === 0 && ran.failure === null
      ? undefined
      : `The operation finished and wrote this answer, and then the engine did not exit cleanly (${howItEnded(ran)}). ${
          onTheWayOut.length === 0
            ? 'It printed no error or warning on the way out.'
            : `What it reported on the way out is under ${answered === -1 ? 'engine_messages' : 'engine_messages_after_answer'}.`
        }`;
  return {
    ok: true,
    payload: answer.payload,
    ...reported(problems),
    ...afterAnswered,
    ...(afterAnswer === undefined ? {} : { afterAnswer }),
  };
}

/** The answer the script wrote, null when it wrote none, or why what it wrote is not one. */
function answerIn(
  file: string,
):
  | { readonly kind: 'none' }
  | { readonly kind: 'answer'; readonly payload: OperationParams }
  | { readonly kind: 'unreadable'; readonly why: string } {
  if (!existsSync(file)) {
    return { kind: 'none' };
  }
  const text = readFileSync(file, 'utf8');
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? { kind: 'answer', payload: parsed as OperationParams }
      : { kind: 'unreadable', why: `it is JSON but not an object: ${text.slice(0, 200)}` };
  } catch (error) {
    return {
      kind: 'unreadable',
      why: `${error instanceof Error ? error.message : String(error)}: ${text.slice(0, 200)}`,
    };
  }
}
