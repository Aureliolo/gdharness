import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { alive } from '../../src/alive.js';
import { startTimesOf } from '../../src/process-children.js';

/**
 * Ends every process still running that announced in [param runtimeDir], whether or not the
 * fixture got as far as learning its number. Only one that began before its announcement was
 * written: a process given the number since cannot have written it. A second of slack, since some
 * platforms give the start to the second.
 */
export async function endWhatAnnouncedIn(runtimeDir: string): Promise<void> {
  const announced = new Map<number, number>();
  for (const entry of readdirSync(runtimeDir)) {
    const named = /^runtime-(\d+)\.json$/.exec(entry);
    const pid = named === null ? 0 : Number(named[1]);
    if (pid > 0 && alive(pid)) {
      announced.set(pid, statSync(join(runtimeDir, entry)).mtimeMs);
    }
  }
  const began = await startTimesOf([...announced.keys()]);
  for (const [pid, writtenAt] of announced) {
    const start = began.get(pid);
    if (start !== undefined && start <= writtenAt + 1000) {
      try {
        process.kill(pid);
      } catch {
        // Gone between the question and the signal.
      }
    }
  }
}

/**
 * The processes a fixture met, each by the start it had when the fixture first met it.
 *
 * Windows hands a freed pid out again within seconds, and the seconds after a stop are when the
 * server spawns its listings and ends what is left. A successor read as gone and, five seconds on,
 * as running, which was another process under its number; and a cleanup that ends whatever runs
 * under a remembered number can end somebody else's process. So a number is asked about together
 * with the start it was met with.
 */
export class MetProcesses {
  private readonly began = new Map<number, number | undefined>();
  private readonly meeting: Promise<void>[] = [];

  /**
   * Notes when each of [param pids] began; one already gone is noted as gone. A caller that cannot
   * wait, such as an output handler, need not: [method end] waits for every meeting first.
   */
  meet(...pids: readonly number[]): Promise<void> {
    const unmet = pids.filter((pid) => pid > 0 && !this.began.has(pid));
    for (const pid of unmet) {
      this.began.set(pid, undefined);
    }
    const met = startTimesOf(unmet.filter((pid) => alive(pid))).then((said) => {
      for (const pid of unmet) {
        this.began.set(pid, said.get(pid));
      }
    });
    this.meeting.push(met);
    return met;
  }

  /**
   * Whether [param pid] is still the process met under it: `'unsaid'` when something runs under
   * the number and the platform would not say when it began, which is neither answer.
   */
  async runs(pid: number): Promise<boolean | 'unsaid'> {
    // Zero is no process: a signal to it goes to this process's own group.
    if (pid <= 0 || !alive(pid)) {
      return false;
    }
    const now = (await startTimesOf([pid])).get(pid);
    if (now === undefined) {
      return alive(pid) ? 'unsaid' : false;
    }
    const began = this.began.get(pid);
    return began !== undefined && now === began;
  }

  /** Waits up to [param withinMs] for [param pid] to be gone, answering whether it went. */
  async gone(pid: number, withinMs = 0): Promise<boolean> {
    const until = Date.now() + withinMs;
    for (;;) {
      if ((await this.runs(pid)) === false) {
        return true;
      }
      if (Date.now() >= until) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** Ends every process still the one met, and nothing given its number since. */
  async end(): Promise<void> {
    await Promise.all(this.meeting);
    for (const pid of this.began.keys()) {
      if ((await this.runs(pid)) === true) {
        try {
          process.kill(pid);
        } catch {
          // Gone between the question and the signal.
        }
      }
    }
  }
}
