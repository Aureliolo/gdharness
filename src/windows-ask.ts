import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { Socket } from 'node:net';
import process from 'node:process';

/**
 * One PowerShell for every question this process asks Windows about processes.
 *
 * Windows keeps parent links, start times and command lines out of reach of anything but a query,
 * and the query is PowerShell's. Asked in a PowerShell of its own each time, every question paid
 * for the interpreter starting: about 800 ms on an idle machine, and on one with every core taken
 * past the fifteen seconds a listing is given, so a stop asked to end a bench's workers ended none
 * of them while the bench was loading the machine. Inside a PowerShell already running, the whole
 * listing took about 150 ms on that same machine.
 *
 * The helper reads one question per line and answers each on one line, and it ends when its input
 * does: a server killed without warning closes the pipe on its way out, and the helper goes with it.
 * The runtime ends it as well, since both runtimes put a child that is not detached in a job object
 * that ends with the parent. Nothing about it keeps this process alive except a question waiting
 * for its answer.
 */

// UTF-8 out, because Windows PowerShell writes a pipe in the console's code page: a command line
// with a character outside ASCII arrived read as UTF-8 with that character replaced, `Müller` as
// `M�ller`, and no comparison against the project path or the engine path could match it. Measured
// on this machine, where a process carries a 0x81 in its command line. The questions go in as
// base64 of UTF-8 and the answers come out the same way, so a line break in either is not a frame.
const SCRIPT = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$in = [Console]::In',
  'while ($null -ne ($line = $in.ReadLine())) {',
  '  $parts = $line.Split(" ", 2)',
  '  try {',
  '    $asked = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))',
  '    $said = (& ([ScriptBlock]::Create($asked)) | Out-String -Width 1000000)',
  '    $tag = "OK"',
  '  } catch {',
  '    $said = $_.Exception.Message',
  '    $tag = "ERR"',
  '  }',
  '  [Console]::Out.Write($parts[0] + " " + $tag + " " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($said)) + "`n")',
  '  [Console]::Out.Flush()',
  '}',
].join('\n');

/**
 * A question the helper did not answer, and how: a timeout, the helper going, and PowerShell
 * refusing are three causes with three different next steps.
 */
export class WindowsAskFailure extends Error {
  constructor(how: string) {
    super(`PowerShell ${how}`);
  }
}

interface Question {
  readonly script: string;
  readonly withinMs: number;
  readonly resolve: (said: string) => void;
  readonly reject: (error: Error) => void;
}

interface Asked {
  readonly id: number;
  readonly question: Question;
  readonly timer: NodeJS.Timeout;
}

let helper: ChildProcessWithoutNullStreams | null = null;
let buffered = '';
let next = 1;
/**
 * The question out now, and the ones waiting behind it. One at a time, because PowerShell answers
 * one at a time and a budget has to measure the question rather than the queue: timed from when it
 * was asked, a reading given six seconds behind a listing that took ten would run out while it
 * waited, and ending the helper for it would take the listing with it.
 */
let out: Asked | null = null;
const queued: Question[] = [];

/**
 * A pipe as Node hands it over, where it can be let go of. Bun's pipes have no such calls, and
 * asked for them regardless every question threw before it was asked.
 */
type Releasable = Partial<Pick<Socket, 'ref' | 'unref'>>;

/** Whether the helper's output is holding this process open, so each change is made once. */
let held = false;

/**
 * Whether anything is out or waiting, which is what keeps this process alive for the answer. Only
 * on a change: Bun counts its refs, so two questions sent back to back and one release at the end
 * left the pipe held and the process running after its last answer.
 */
function holding(child: ChildProcessWithoutNullStreams, wanted: boolean): void {
  if (held === wanted) {
    return;
  }
  held = wanted;
  const stdout = child.stdout as Releasable;
  if (wanted) {
    stdout.ref?.();
  } else {
    stdout.unref?.();
  }
}

function running(): ChildProcessWithoutNullStreams {
  if (helper?.exitCode === null && helper.signalCode === null) {
    return helper;
  }
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(SCRIPT, 'utf16le').toString('base64'),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    for (let end = buffered.indexOf('\n'); end !== -1; end = buffered.indexOf('\n')) {
      answered(buffered.slice(0, end).trim());
      buffered = buffered.slice(end + 1);
    }
  });
  child.stderr.resume();
  child.stdin.on('error', () => {
    // A helper that went while a question was being written: its exit answers for the question.
  });
  const gone = (): void => {
    if (helper !== child) {
      return;
    }
    helper = null;
    if (out !== null) {
      clearTimeout(out.timer);
      out.question.reject(new WindowsAskFailure('exited before it answered'));
      out = null;
    }
    sendNext();
  };
  child.once('exit', gone);
  child.once('error', gone);
  child.unref();
  (child.stdin as Releasable).unref?.();
  (child.stderr as Releasable).unref?.();
  // A new pipe holds the process until it is let go of.
  held = true;
  holding(child, false);
  helper = child;
  return child;
}

function answered(line: string): void {
  const [id, tag, body] = line.split(' ');
  if (out === null || out.id !== Number(id)) {
    return;
  }
  const { question, timer } = out;
  clearTimeout(timer);
  out = null;
  const said = Buffer.from(body ?? '', 'base64').toString('utf8');
  if (tag === 'OK') {
    question.resolve(said);
  } else {
    question.reject(new WindowsAskFailure(`refused the question: ${said.trim() || 'no reason given'}`));
  }
  sendNext();
}

function sendNext(): void {
  const question = queued.shift();
  if (question === undefined) {
    if (helper !== null) {
      holding(helper, false);
    }
    return;
  }
  const child = running();
  holding(child, true);
  const id = next;
  next += 1;
  const timer = setTimeout(() => {
    if (out?.id !== id) {
      return;
    }
    out = null;
    question.reject(new WindowsAskFailure(`did not answer within ${question.withinMs}ms`));
    // Ended rather than waited on: a PowerShell stuck on one question answers none after it. The
    // next question starts another.
    if (helper === child) {
      helper = null;
    }
    child.kill();
    sendNext();
  }, question.withinMs);
  out = { id, question, timer };
  child.stdin.write(`${id} ${Buffer.from(question.script, 'utf8').toString('base64')}\n`);
}

/**
 * What [param script] prints, run in the helper once the questions ahead of it are answered. It
 * has [param withinMs] from being sent, after which it is refused and the helper ended.
 */
export function askWindows(script: string, withinMs: number): Promise<string> {
  if (process.platform !== 'win32') {
    return Promise.reject(new WindowsAskFailure('is asked only on Windows'));
  }
  return new Promise<string>((resolve, reject) => {
    queued.push({ script, withinMs, resolve, reject });
    if (out === null) {
      sendNext();
    }
  });
}
