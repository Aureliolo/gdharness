import { alive } from './alive.js';
import { amendRunRecord, type RunRecord, readRunRecord, sameRun } from './run-record.js';

/**
 * How long a run may go with no server alive before its keeper ends the game. A reconnect starts the
 * next server within seconds, and that server takes the run over and writes its own pid into the
 * note. A game nobody took over holds its engine slot for as long as it runs, and a windowed one
 * keeps drawing, so no other rule ends it.
 */
const ORPHANED_AFTER_MS = 10 * 60_000;
const ORPHANED_AFTER_VARIABLE = 'GDHARNESS_ORPHANED_AFTER_MS';

/** [constant ORPHANED_AFTER_MS], or the whole number of milliseconds a test set to shorten it. */
function orphanedAfterMs(): number {
  const set = Number(process.env[ORPHANED_AFTER_VARIABLE]);
  return Number.isInteger(set) && set > 0 ? set : ORPHANED_AFTER_MS;
}

/**
 * Whether a run whose server went at [param since] has gone unclaimed for long enough, and the time
 * it has been without one, or null when a server is there. The state of one look, kept apart from
 * the timer so the clock can be handed in.
 */
export function orphanedSince(
  serverPid: number | undefined,
  since: number | null,
  now: number,
  isAlive: (pid: number) => boolean = alive,
): { readonly since: number | null; readonly orphaned: boolean } {
  if (serverPid === undefined || isAlive(serverPid)) {
    return { since: null, orphaned: false };
  }
  const from = since ?? now;
  return { since: from, orphaned: now - from >= orphanedAfterMs() };
}

/**
 * Writes [param pid], the server taking [param record]'s run over, into the run's note, so the
 * run's keeper sees a server has it. Left alone for a run that has ended or is not going.
 */
export function claimRun(record: RunRecord, pid: number): void {
  if (record.endedAt !== undefined || record.serverPid === pid || !alive(record.pid)) {
    return;
  }
  try {
    amendRunRecord({ ...record, serverPid: pid });
  } catch {
    // The keeper then ends the game after its limit, which a note that cannot be written is owed.
  }
}

/**
 * Calls [param end] once the server named by [param record] has been gone for the limit with no
 * other server having put its own pid in the run's note. Answers the function that stops watching.
 * A note with no server pid is for a keeper that was started for none, and is not watched.
 */
export function endWhenOrphaned(record: RunRecord, end: () => void): () => void {
  if (record.serverPid === undefined) {
    return () => undefined;
  }
  let since: number | null = null;
  const look = setInterval(
    () => {
      const noted = readRunRecord(record.projectPath, undefined, record.savesIn);
      const server = noted !== null && sameRun(noted, record) ? noted.serverPid : record.serverPid;
      const seen = orphanedSince(server, since, Date.now());
      since = seen.since;
      if (seen.orphaned) {
        clearInterval(look);
        end();
      }
    },
    Math.min(30_000, Math.max(250, orphanedAfterMs() / 4)),
  );
  return () => {
    clearInterval(look);
  };
}
