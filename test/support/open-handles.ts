import {
  descendantsIn,
  type ProcessTree,
  parseProcessTable,
  processTree,
} from '../../src/process-children.js';
import { runHidden } from '../../src/spawn.js';
import { fixtureNow } from './sweep.js';

/**
 * What the run still holds open when its last test is done, named by the test that left it.
 *
 * Bun lists no open handles (`process.getActiveResourcesInfo()` answers an empty list beside a
 * live timer, child and server), so the two things that keep its loop alive are found otherwise.
 * A timer is found by wrapping the global timer calls, and a child process by asking the
 * operating system for the run's descendants and dating each against the tests' own windows. A
 * test's leftover that outlives the run holds the job until its limit, and a job its own limit
 * ends keeps no log.
 */

/** One timer that was set and has not fired or been cleared. */
interface PendingTimer {
  readonly kind: 'timeout' | 'interval';
  readonly delayMs: number;
  readonly during: string | null;
  readonly timer: NodeJS.Timeout;
}

/** A test's window on the clock, for dating a process against. */
interface TestWindow {
  readonly name: string;
  readonly began: number;
  ended: number | null;
}

/** Something the run still holds, with the test that left it where that is known. */
export interface OpenHandle {
  readonly what: string;
  readonly during: string | null;
}

const pending = new Set<PendingTimer>();
const windows: TestWindow[] = [];
let tracking = false;

/** Wraps the global timer calls so [function openTimers] can say which are still pending. Once only. */
export function trackTimers(): void {
  if (tracking) {
    return;
  }
  tracking = true;
  const {
    setTimeout: setOnce,
    setInterval: setRepeatedly,
    clearTimeout: clearOnce,
    clearInterval: clearRepeated,
  } = globalThis;
  const entryOf = (timer: unknown): PendingTimer | undefined =>
    [...pending].find((entry) => entry.timer === timer);
  const forget = (timer: unknown): void => {
    const entry = entryOf(timer);
    if (entry !== undefined) {
      pending.delete(entry);
    }
  };
  Reflect.set(
    globalThis,
    'setTimeout',
    (callback: (...args: unknown[]) => void, delayMs?: number, ...args: unknown[]) => {
      const timer = setOnce(
        (...given: unknown[]) => {
          forget(timer);
          callback(...given);
        },
        delayMs,
        ...args,
      );
      pending.add({ kind: 'timeout', delayMs: delayMs ?? 1, during: fixtureNow(), timer });
      return timer;
    },
  );
  Reflect.set(
    globalThis,
    'setInterval',
    (callback: (...args: unknown[]) => void, delayMs?: number, ...args: unknown[]) => {
      const timer = setRepeatedly(callback, delayMs, ...args);
      pending.add({ kind: 'interval', delayMs: delayMs ?? 1, during: fixtureNow(), timer });
      return timer;
    },
  );
  Reflect.set(globalThis, 'clearTimeout', (timer?: NodeJS.Timeout) => {
    forget(timer);
    clearOnce(timer);
  });
  Reflect.set(globalThis, 'clearInterval', (timer?: NodeJS.Timeout) => {
    forget(timer);
    clearRepeated(timer);
  });
}

/** Notes that [param name] has begun, for dating a process against. Returns what ends the window. */
export function beginWindow(name: string): () => void {
  const window: TestWindow = { name, began: Date.now(), ended: null };
  windows.push(window);
  return () => {
    window.ended = Date.now();
  };
}

/** The timers still pending that keep the run alive, which an unref'd one does not. */
export function openTimers(): OpenHandle[] {
  return [...pending]
    .filter((entry) => entry.timer.hasRef())
    .map((entry) => ({
      what: `${entry.kind} of ${entry.delayMs}ms`,
      during: entry.during,
    }));
}

/** The test whose window held [param startedAt], or null where none did. */
function testAt(startedAt: number | undefined): string | null {
  if (startedAt === undefined) {
    return null;
  }
  // A process dated a little before the test says it began is the test's own, since the clocks
  // behind the two readings differ by up to a second.
  const found = windows.findLast((window) => startedAt >= window.began - 1_000);
  return found?.name ?? null;
}

/** How far a process's listed start can sit from this process's own clock, either way. */
const LISTING_SKEW_MS = 1_000;

/**
 * The PowerShell every Windows question of the server is put to (`src/windows-ask.ts`). It stays up
 * between questions by design and holds nothing, so it is not something a test left.
 */
const SHARED_POWERSHELL =
  /^powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand /i;

/**
 * The process table on POSIX with each process's start, which `processTree` does not list there.
 * `etime` is `[[dd-]hh:]mm:ss`, so a start is known to the second, which the skew allows for.
 */
async function posixTableWithStarts(): Promise<ProcessTree | undefined> {
  try {
    const { stdout } = await runHidden('ps', ['-e', '-o', 'pid=,ppid=,etime=,args='], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const now = Date.now();
    const lines: string[] = [];
    for (const line of stdout.split('\n')) {
      const fields = /^\s*(\d+)\s+(\d+)\s+(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s+(.*)$/.exec(line);
      if (fields !== null) {
        const [, pid, parent, days, hours, minutes, seconds, command] = fields;
        const elapsed =
          ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds);
        lines.push(`${pid} ${parent} ${now - elapsed * 1000} ${command}`);
      }
    }
    return parseProcessTable(lines.join('\n'), true);
  } catch {
    return undefined;
  }
}

/** The processes still running under this one, other than the listing that found them. */
export async function openChildren(): Promise<OpenHandle[]> {
  const asked = Date.now();
  const tree = process.platform === 'win32' ? await processTree() : await posixTableWithStarts();
  if (tree === undefined) {
    return [];
  }
  // The listing is itself a child of this process, and the only one started after the ask.
  return descendantsIn(tree, process.pid)
    .filter((pid) => (tree.get(pid)?.startedAt ?? 0) < asked - LISTING_SKEW_MS)
    .filter((pid) => !SHARED_POWERSHELL.test(tree.get(pid)?.command ?? ''))
    .map((pid) => {
      const listed = tree.get(pid);
      return {
        what: `process ${pid} ${(listed?.command ?? '').slice(0, 160)}`,
        during: testAt(listed?.startedAt),
      };
    });
}

/** The lines that name each open handle and the test that left it. */
export function describeOpenHandles(handles: readonly OpenHandle[]): string[] {
  return handles.map((handle) => `  ${handle.what} (${handle.during ?? 'no test'})`);
}

/**
 * The tests to fail for the [param timers] left pending, each once, and the name of the run's own
 * end for a timer no test set. A child is told but never failed for, since a process that is
 * listed may be one the run does not wait on, and the engines a test leaves are failed elsewhere.
 */
export function testsThatLeftTimers(timers: readonly OpenHandle[]): string[] {
  return [...new Set(timers.map((timer) => timer.during ?? 'the end of the run'))];
}
