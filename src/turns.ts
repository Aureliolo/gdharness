/**
 * Calls served one at a time, in the order they were made, one queue to a key.
 *
 * A call that fails never holds up the next, and a key's entry goes once its last call has settled,
 * so a long-lived queue keeps nothing for a key no call is waiting on.
 */
export class Turns<Key = undefined> {
  private readonly tails = new Map<Key | undefined, Promise<void>>();

  /** Runs [param task] once every call made before it on [param key] has settled. */
  run<T>(task: () => Promise<T>, key?: Key): Promise<T> {
    const done = (this.tails.get(key) ?? Promise.resolve()).then(task);
    // The caller gets `done` itself, which the tail already handles: a caller that attaches its
    // handler late raises no unhandled rejection, and it resumes before the next call starts.
    const forget = (): void => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    };
    const tail = done.then(forget, forget);
    this.tails.set(key, tail);
    return done;
  }

  /** How many keys have a call waiting or running. */
  get waiting(): number {
    return this.tails.size;
  }

  /** Forgets every key, so the next call on each starts at once. */
  clear(): void {
    this.tails.clear();
  }
}
