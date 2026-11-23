import { isAbsolute } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { alive } from '../../src/alive.js';
import { processTree, whyTheProcessTreeFailed } from '../../src/process-children.js';

/** One engine ended because it was still holding a fixture's directory, and the directory it held. */
export interface EndedEngine {
  pid: number;
  under: string;
}

/**
 * Ends every process whose command line names one of [param paths], whoever started it, and waits
 * for each to be gone.
 *
 * Asked of the operating system rather than tracked, because the processes worth ending here are
 * the ones nothing has a handle to: an editor a restart brought up, a game the editor played, or a
 * game a server started and handed to its keeper, which outlives the server by design. Each path is
 * a temporary directory a fixture made, so nothing outside the run can match it.
 */
export async function endEnginesUnder(...given: string[]): Promise<EndedEngine[]> {
  // A relative path names nothing in particular: "demo" is inside half the command lines on a
  // machine, the other projects' engines among them.
  const paths = given.filter((path) => isAbsolute(path));
  if (paths.length === 0) {
    return [];
  }
  const listing = await listProcesses();

  // A listing that did not happen is the failure this had for months, and it looks exactly like a
  // machine with nothing to clean up. Said out loud, because the cost of it lands on the next run
  // and on whoever is using the machine, not on this one.
  if (listing === undefined || listing.trim() === '') {
    console.warn(
      `could not list processes to clean up engines under ${paths.join(', ')}: ${whyTheProcessTreeFailed() ?? 'no output'}`,
    );
    return [];
  }

  const ended = endListed(listing, paths);

  // Waited for, because a signal is not an exit, and an engine on its way out still holds the files
  // and the ports it had: the next fixture reserves a port, is handed that number because nothing
  // has released it yet, and is refused by the guard that asks who is really listening.
  const deadline = Date.now() + 10_000;
  while (ended.some(({ pid }) => alive(pid)) && Date.now() < deadline) {
    await delay(100);
  }
  const holding = ended.filter(({ pid }) => alive(pid)).map(({ pid }) => pid);
  if (holding.length > 0) {
    console.warn(`engines ${holding.join(', ')} were signalled and are still up; the next case may collide`);
  }
  return ended;
}

/**
 * Waits up to [param withinMs] for every process whose command line names [param path] to have
 * exited, and answers whether none is left. Ends nothing.
 *
 * For a fixture whose server has stopped and whose editor has gone: the keeper that held the editor
 * and the helper that started it end themselves a moment later, and a listing taken in that moment
 * reads them as an engine the fixture left running. An entry the table still lists for a process
 * that has exited, which a handle on it keeps, is not running.
 */
export async function untilNothingRunsUnder(path: string, withinMs: number): Promise<boolean> {
  const spelled = spelledForMatching(path);
  const deadline = Date.now() + withinMs;
  for (;;) {
    const tree = await processTree();
    const running =
      tree === undefined
        ? []
        : [...tree].filter(
            ([pid, { command }]) =>
              pid !== process.pid && names(spelledForMatching(command), spelled) && alive(pid),
          );
    if (running.length === 0) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(100);
  }
}

/**
 * Every process, matched on its command line alone. Filtering by `Name='godot.exe'` first meant
 * this found nothing at all wherever the engine is not called that, which is every machine using
 * the pinned build: it is `Godot_v4.7.2-stable_win64.exe` on Windows. Nineteen fixture projects
 * and eleven engines were left running on this machine before anybody looked. The path is the
 * discriminator anyway, and a name filter can only subtract from that.
 *
 * Read from the server's own process table, which this process asks through the one PowerShell it
 * keeps. A PowerShell of its own per listing cost half a second of processor time each, and a run
 * lists after every fixture that leaves a directory behind.
 */
async function listProcesses(): Promise<string | undefined> {
  const tree = await processTree();
  return tree === undefined
    ? undefined
    : [...tree].map(([pid, { command }]) => `${String(pid)} ${command}`).join('\n');
}

/** Signals every process of [param listing] whose command line names one of [param paths]. */
function endListed(listing: string, paths: string[]): EndedEngine[] {
  const wanted = paths.map((path) => ({ path, spelled: spelledForMatching(path) }));
  const ended: EndedEngine[] = [];
  for (const line of listing.split('\n')) {
    const [, pid, rest] = /^\s*(\d+)\s+(.*)$/.exec(line.trim()) ?? [];
    if (pid === undefined || rest === undefined || Number(pid) === process.pid) continue;
    const named = spelledForMatching(rest);
    const held = wanted.find(({ spelled }) => names(named, spelled));
    if (held === undefined) continue;
    try {
      process.kill(Number(pid));
      ended.push({ pid: Number(pid), under: held.path });
    } catch {
      // Gone between the listing and here, which is the outcome this is for.
    }
  }
  return ended;
}

function spelledForMatching(path: string): string {
  return path.replaceAll('\\', '/').toLowerCase();
}

/**
 * Whether [param commandLine] names [param path] itself rather than a longer name that begins with
 * it: two directories from one `mkdtemp` prefix differ only in their last characters, and one can be
 * the start of the other.
 */
function names(commandLine: string, path: string): boolean {
  for (let at = commandLine.indexOf(path); at !== -1; at = commandLine.indexOf(path, at + 1)) {
    const after = commandLine[at + path.length];
    if (after === undefined || after === '/' || after === '"' || after === "'" || after === ' ') {
      return true;
    }
  }
  return false;
}
