/**
 * Engine slots granted by another program. When {@link SLOT_COMMAND_VARIABLE} holds a command line,
 * every slot gdharness would take is asked of that command instead, and gdharness's own taker makes,
 * reads and removes nothing in the slot folder for it.
 *
 * The command is started without a shell, hidden, with `--project <absolute path>` where the take
 * has a project. Its first line on standard output is
 * `held <absolute lock path>` once the slot is granted, or `refused <reason>`. A command that cannot
 * grant at once may print `queued` before either, and a run that starts several engines then counts
 * the request as a busy slot, which it does not wait for. The command keeps the
 * slot for as long as its standard input is open and gives it back at end of input, so a gdharness
 * that is killed frees it too. A slot for a process that outlives gdharness is handed on with the
 * line `hand <pid> <start ms>` on its standard input: the command rewrites the lock to that holder,
 * prints `handed` and exits 0 without releasing, and the scheduler frees the slot once that process
 * has gone.
 */

import { isAbsolute, resolve } from 'node:path';
import { Refusal } from './errors.js';
import { commandLineWords } from './launch.js';
import { type ChildProcess, spawnHidden } from './spawn.js';

/** The variable naming the command that grants every engine slot, as a full command line. */
export const SLOT_COMMAND_VARIABLE = 'GODOT_ENGINE_SLOT_COMMAND';

/**
 * How long a command that was told to give its slot back has to exit, past which it is ended. A
 * command given back its slot leaves at once, so a longer wait is a command that no longer listens.
 */
const EXIT_WAIT_MS = 5000;

/** How long after `held` a command that exits is still counted as never having held the slot. */
const GRANT_SETTLE_MS = 100;

/**
 * What a command prints, before `held`, when it cannot grant the slot at once and the request waits
 * for a busy one.
 */
const QUEUED_LINE = 'queued';

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

/** A slot the command granted, held until it is released, handed on or the command's input ends. */
export class SlotGrant {
  readonly lock: string;
  /** Settles once the command has exited, which is within {@link EXIT_WAIT_MS} of its release. */
  readonly gone: Promise<void>;
  private readonly child: ChildProcess;
  private readonly answers: CommandAnswers;
  private readonly command: string;
  private ended = false;
  private handing = false;
  private handed = false;
  private lostWith: string | null = null;

  /** [param onLost] is told when the command exits while it still holds the slot. */
  constructor(
    lock: string,
    child: ChildProcess,
    answers: CommandAnswers,
    command: string,
    onLost: (said: string) => void,
  ) {
    this.lock = lock;
    this.child = child;
    this.answers = answers;
    this.command = command;
    this.gone = answers.gone;
    void answers.gone.then(() => {
      if (!this.ended && !this.handing && !this.handed) {
        this.lostWith = `The engine slot command \`${command}\` exited while it held ${lock}, so the slot is no longer held.${answers.describe()}`;
        onLost(this.lostWith);
      }
    });
  }

  /** What the command's exit while it held the slot says, or null while it holds it. */
  lostSaid(): string | null {
    return this.lostWith;
  }

  /** Gives the slot back: the command sees end of input and exits. A handed slot is not given back. */
  release(): void {
    if (!this.ended) {
      this.ended = true;
      if (!this.handed) {
        closed(this.child, this.gone);
      }
    }
  }

  /**
   * Hands the slot to the process [param pid], started at [param started] in milliseconds, which
   * keeps it until it has gone: the command is sent `hand <pid> <started>`, rewrites the lock and
   * answers `handed` and exits 0 without releasing. Answers null once it has, or why it has not.
   */
  async hand(pid: number, started: number): Promise<string | null> {
    if (this.ended || this.handed || this.lostWith !== null) {
      return this.lostWith ?? `The engine slot command \`${this.command}\` no longer holds ${this.lock}.`;
    }
    this.handing = true;
    this.child.stdin?.write(`hand ${String(pid)} ${String(started)}\n`);
    const waiting = setTimeout(() => {
      this.child.kill();
    }, EXIT_WAIT_MS);
    await this.gone;
    clearTimeout(waiting);
    if (this.answers.exitedCleanly() && this.answers.linesAfterTheFirst()[0] === 'handed') {
      this.handed = true;
      return null;
    }
    this.handing = false;
    this.ended = true;
    return `The engine slot command \`${this.command}\` did not hand ${this.lock} to process ${String(pid)}, which needs \`handed\` and an exit with code 0.${this.answers.describe()}`;
  }
}

/** What a take asks of the command, and how it reports a long wait. */
export interface SlotRequest {
  readonly command: string;
  /** The Godot project the take is for. A take with none passes no `--project`. */
  readonly project?: string | undefined;
  /** A cancelled call or a deadline: it stops the wait and gives the command's input end. */
  readonly signal?: AbortSignal | undefined;
  readonly firstNoteMs: number;
  readonly noteEveryMs: number;
  readonly note: (waitedMs: number) => void;
  /** Told when the command exits while it still holds a slot that was granted. */
  readonly onLost: (said: string) => void;
  /** Told once if the command says it queued the request for a busy slot. */
  readonly onQueued?: (() => void) | undefined;
}

function printedSaid(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > PRINTED_KEPT ? `${trimmed.slice(0, PRINTED_KEPT)}...` : trimmed;
}

/** What a started command has said and how it ended, read once its first line or its end is in. */
export class CommandAnswers {
  readonly gone: Promise<void>;
  /** The command's first line of output, or null when it ended without one. */
  readonly firstLine: Promise<string | null>;
  private exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private startError: Error | undefined;
  private printed = '';
  private written = '';

  /** [param queued] is called once, when the command says it cannot grant at once. */
  constructor(child: ReturnType<typeof startedCommand>, queued?: () => void) {
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
      let wasQueued = false;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        this.printed = `${this.printed}${chunk}`.slice(0, PRINTED_KEPT * 4);
        const lines = this.completeLines();
        if (!wasQueued && lines[0]?.trim() === QUEUED_LINE) {
          wasQueued = true;
          queued?.();
        }
        const answer = lines.find((line) => line.trim() !== QUEUED_LINE);
        if (!lined && answer !== undefined) {
          lined = true;
          resolveLine(answer);
        }
      });
      void this.gone.then(() => {
        resolveLine(null);
      });
    });
  }

  /** How the command ended, as a sentence, or nothing while it runs. */
  exitSaid(): string {
    if (this.exit === undefined) {
      return '';
    }
    return this.exit.signal === null
      ? ` It exited with code ${String(this.exit.code)}.`
      : ` It was ended by ${this.exit.signal}.`;
  }

  private printedSaid(): string {
    return this.printed.trim() === '' ? '' : ` It printed ${JSON.stringify(printedSaid(this.printed))}.`;
  }

  private writtenSaid(): string {
    return this.written.trim() === ''
      ? ''
      : ` Its error output was ${JSON.stringify(printedSaid(this.written))}.`;
  }

  /** What the command printed and how it ended, as the tail of an error. */
  describe(): string {
    return `${this.exitSaid()}${this.printedSaid()}${this.writtenSaid()}`;
  }

  /** Whether the command has exited with code 0. */
  exitedCleanly(): boolean {
    return this.exit?.code === 0 && this.exit.signal === null;
  }

  /** The lines the command has printed whole, without a `\r` at their ends. */
  private completeLines(): string[] {
    const cut = this.printed.lastIndexOf('\n');
    return cut === -1
      ? []
      : this.printed
          .slice(0, cut)
          .split('\n')
          .map((line) => line.replace(/\r$/, ''));
  }

  /** The lines the command printed after its answer, which `queued` lines before it do not count as. */
  linesAfterTheFirst(): string[] {
    const lines = this.completeLines();
    const answer = lines.findIndex((line) => line.trim() !== QUEUED_LINE);
    return lines
      .slice(answer + 1)
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }

  /** The error for [param first], the command's first line or null for none, which gave no grant. */
  failureOf(command: string, first: string | null): Refusal {
    const said = (what: string): string => `The engine slot command \`${command}\` ${what}`;
    const exited = this.exitSaid();
    const written = this.writtenSaid();
    if (first === null) {
      return new Refusal(
        said(
          this.startError === undefined
            ? `exited before it answered.${this.describe()}`
            : `could not be started: ${this.startError.message}`,
        ),
      );
    }
    const refused = /^refused(?: (.*))?$/.exec(first);
    if (refused !== null) {
      const why = refused[1]?.trim();
      return new Refusal(
        said(`refused the slot: ${why === undefined || why === '' ? 'no reason given' : why}.${exited}`),
      );
    }
    return new Refusal(
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
    throw new Refusal(
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
  const { command, project, signal } = request;
  const [program, ...given] = commandLineWords(command);
  if (program === undefined) {
    throw new Refusal(`${SLOT_COMMAND_VARIABLE} holds no command.`);
  }
  signal?.throwIfAborted();
  const args = [...given, ...(project === undefined ? [] : ['--project', resolve(project)])];
  const child = startedCommand(command, program, args);
  const answers = new CommandAnswers(child, request.onQueued);
  const first = await firstLineOf(request, child, answers);
  const lock = first === null ? undefined : /^held (.+)$/.exec(first)?.[1]?.trim();
  if (lock !== undefined && isAbsolute(lock)) {
    let started = false;
    const grant = new SlotGrant(lock, child, answers, command, (said) => {
      if (started) {
        request.onLost(said);
      }
    });
    // A command that prints `held` and exits holds nothing, and says so within a moment of it.
    await Promise.race([answers.gone, new Promise((settled) => setTimeout(settled, GRANT_SETTLE_MS))]);
    const lost = grant.lostSaid();
    if (lost !== null) {
      throw new Refusal(lost);
    }
    if (signal?.aborted === true) {
      // Cancelled while the grant settled: given back, since the caller will not take it.
      grant.release();
      await answers.gone;
      signal.throwIfAborted();
    }
    started = true;
    return grant;
  }
  closed(child, answers.gone);
  await answers.gone;
  throw answers.failureOf(command, first);
}
