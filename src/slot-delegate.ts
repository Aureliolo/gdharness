/**
 * Engine slots granted by another program. When {@link SLOT_COMMAND_VARIABLE} holds a command line,
 * every slot gdharness would take is asked of that command instead, and gdharness's own taker makes,
 * reads and removes nothing in the slot folder for it.
 *
 * The command is started without a shell, hidden, with `--project <absolute path>` where the take
 * has a project and `--kind gate|side|one-off` appended. Its first line on standard output is
 * `held <absolute lock path>` once the slot is granted, or `refused <reason>`. The command keeps the
 * slot for as long as its standard input is open and gives it back at end of input, so a gdharness
 * that is killed frees it too.
 */

import { isAbsolute, resolve } from 'node:path';
import { alive } from './alive.js';
import { commandLineWords } from './launch.js';
import { type ChildProcess, spawnHidden } from './spawn.js';

/** The variable naming the command that grants every engine slot, as a full command line. */
export const SLOT_COMMAND_VARIABLE = 'GODOT_ENGINE_SLOT_COMMAND';

/** How the command classes a take: gdharness's own taker draws the same three lines. */
export type SlotKind = 'gate' | 'side' | 'one-off';

/**
 * How long a command that was told to give its slot back has to exit, past which it is ended. A
 * command given back its slot leaves at once, so a longer wait is a command that no longer listens.
 */
const EXIT_WAIT_MS = 5000;

/** How often a slot handed to a process that outlives the take is checked for that process. */
const FOLLOW_MS = 1000;

/** How much of what a command printed an error repeats. */
const PRINTED_KEPT = 300;

/** The command line in [param env], or undefined where the variable is unset or blank. */
export function slotCommandOf(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const line = env[SLOT_COMMAND_VARIABLE];
  return line === undefined || line.trim() === '' ? undefined : line;
}

/** What waiting [param waitedMs] for [param command] says to the client of the call that waits. */
export function delegateWaitSaid(waitedMs: number, command: string): string {
  return `Waiting ${String(Math.round(waitedMs / 1000))} s so far for an engine slot from \`${command}\`.`;
}

/** What a call's answer says of its wait for [param command]'s slots, [param waitedMs] in all. */
export function delegateWaitedSaid(waitedMs: number, command: string): string {
  return `This call waited ${String(Math.round(waitedMs / 1000))} s for an engine slot in all, from \`${command}\`.`;
}

/**
 * Ends [param child]'s hold on its slot: closes its standard input, and ends it if it has not
 * exited within {@link EXIT_WAIT_MS}.
 */
function closed(child: ChildProcess, exited: Promise<void>): void {
  child.stdin?.end();
  const ending = setTimeout(() => {
    child.kill();
  }, EXIT_WAIT_MS);
  ending.unref();
  void exited.then(() => {
    clearTimeout(ending);
  });
}

/** A slot the command granted, held until it is released or the command's input ends. */
export class SlotGrant {
  readonly lock: string;
  /** Settles once the command has exited, which is within {@link EXIT_WAIT_MS} of its release. */
  readonly gone: Promise<void>;
  private readonly child: ChildProcess;
  private ended = false;
  private following = false;

  constructor(lock: string, child: ChildProcess, gone: Promise<void>) {
    this.lock = lock;
    this.child = child;
    this.gone = gone;
  }

  /** Gives the slot back: the command sees end of input and exits. */
  release(): void {
    if (!this.ended) {
      this.ended = true;
      closed(this.child, this.gone);
    }
  }

  /**
   * Gives the slot back once the process [param pid] has gone, for an engine that outlives the call
   * that took the slot. A gdharness that ends first gives it back too, by its input closing.
   */
  releaseAfter(pid: number): void {
    if (this.ended || this.following) {
      return;
    }
    this.following = true;
    const look = setInterval(() => {
      if (!alive(pid)) {
        clearInterval(look);
        this.release();
      }
    }, FOLLOW_MS);
    look.unref();
  }
}

/** What a take asks of the command, and how it reports a long wait. */
export interface SlotRequest {
  readonly command: string;
  readonly kind: SlotKind;
  /** The Godot project the take is for. A take with none passes no `--project`. */
  readonly project?: string | undefined;
  /** A cancelled call or a deadline: it stops the wait and gives the command's input end. */
  readonly signal?: AbortSignal | undefined;
  readonly firstNoteMs: number;
  readonly noteEveryMs: number;
  readonly note: (waitedMs: number) => void;
}

function printedSaid(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > PRINTED_KEPT ? `${trimmed.slice(0, PRINTED_KEPT)}...` : trimmed;
}

/** What a started command has said and how it ended, read once its first line or its end is in. */
class CommandAnswers {
  readonly gone: Promise<void>;
  /** The command's first line of output, or null when it ended without one. */
  readonly firstLine: Promise<string | null>;
  private exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private startError: Error | undefined;
  private printed = '';
  private written = '';

  constructor(child: ReturnType<typeof startedCommand>) {
    this.gone = new Promise<void>((done) => {
      child.once('close', (code, signal) => {
        this.exit = { code, signal };
        done();
      });
      child.once('error', (error) => {
        this.startError = error;
        done();
      });
    });
    // A command that exited has no input left to end.
    child.stdin.on('error', () => undefined);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.written = `${this.written}${chunk}`.slice(-PRINTED_KEPT * 2);
    });
    this.firstLine = new Promise<string | null>((resolveLine) => {
      let lined = false;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (lined) {
          return;
        }
        this.printed += chunk;
        const end = this.printed.indexOf('\n');
        if (end !== -1) {
          lined = true;
          resolveLine(this.printed.slice(0, end).replace(/\r$/, ''));
        }
      });
      void this.gone.then(() => {
        resolveLine(null);
      });
    });
  }

  /** The error for [param first], the command's first line or null for none, which gave no grant. */
  failureOf(command: string, first: string | null): Error {
    const said = (what: string): string => `The engine slot command \`${command}\` ${what}`;
    const exited =
      this.exit === undefined
        ? ''
        : this.exit.signal === null
          ? ` It exited with code ${String(this.exit.code)}.`
          : ` It was ended by ${this.exit.signal}.`;
    const printed =
      this.printed.trim() === '' ? '' : ` It printed ${JSON.stringify(printedSaid(this.printed))}.`;
    const written =
      this.written.trim() === '' ? '' : ` Its error output was ${JSON.stringify(printedSaid(this.written))}.`;
    if (first === null) {
      return new Error(
        said(
          this.startError === undefined
            ? `exited before it answered.${exited}${printed}${written}`
            : `could not be started: ${this.startError.message}`,
        ),
      );
    }
    const refused = /^refused(?: (.*))?$/.exec(first);
    if (refused !== null) {
      const why = refused[1]?.trim();
      return new Error(
        said(`refused the slot: ${why === undefined || why === '' ? 'no reason given' : why}.${exited}`),
      );
    }
    return new Error(
      said(
        `answered with a first line in neither form, \`held <absolute lock path>\` nor \`refused <reason>\`: ${JSON.stringify(printedSaid(first))}.${exited}${written}`,
      ),
    );
  }
}

/** The command, started hidden with its three streams piped, or an error that says it could not be. */
function startedCommand(command: string, program: string, args: readonly string[]) {
  try {
    return spawnHidden(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    // A runtime that reports a missing program by throwing rather than by an error event.
    throw new Error(
      `The engine slot command \`${command}\` could not be started: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Waits for [param answers]' first line, saying a wait through [param request] on the schedule it
 * gives, and ends the command if the signal aborts first.
 */
async function firstLineOf(
  request: SlotRequest,
  child: ChildProcess,
  answers: CommandAnswers,
): Promise<string | null> {
  const { signal } = request;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      const reason: unknown = signal?.reason;
      reject(reason instanceof Error ? reason : new Error(String(reason)));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  const began = Date.now();
  let note: ReturnType<typeof setTimeout> | undefined;
  const noteIn = (ms: number): void => {
    note = setTimeout(() => {
      request.note(Date.now() - began);
      noteIn(request.noteEveryMs);
    }, ms);
  };
  noteIn(request.firstNoteMs);
  try {
    return await Promise.race([answers.firstLine, aborted]);
  } catch (error) {
    closed(child, answers.gone);
    await answers.gone;
    throw error;
  } finally {
    clearTimeout(note);
    if (onAbort !== undefined) {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * Asks [param request]'s command for a slot and waits for its first line. Rejects with the cause
 * when the command refuses, cannot be started, exits or answers in neither form, or with the abort
 * reason of the signal, having ended the command in each case. Never takes a slot of its own.
 */
export async function askForSlot(request: SlotRequest): Promise<SlotGrant> {
  const { command, kind, project, signal } = request;
  const [program, ...given] = commandLineWords(command);
  if (program === undefined) {
    throw new Error(`${SLOT_COMMAND_VARIABLE} holds no command.`);
  }
  signal?.throwIfAborted();
  const args = [...given, ...(project === undefined ? [] : ['--project', resolve(project)]), '--kind', kind];
  const child = startedCommand(command, program, args);
  const answers = new CommandAnswers(child);
  const first = await firstLineOf(request, child, answers);
  const lock = first === null ? undefined : /^held (.+)$/.exec(first)?.[1]?.trim();
  if (lock !== undefined && isAbsolute(lock)) {
    return new SlotGrant(lock, child, answers.gone);
  }
  closed(child, answers.gone);
  await answers.gone;
  throw answers.failureOf(command, first);
}
