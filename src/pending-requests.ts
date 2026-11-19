/**
 * Requests sent to a peer and not yet settled, by the id each went out under. A request settles
 * once: on its answer, on a failure, at its deadline, or when its connection is dropped. A reply
 * for an id that is not waiting changes nothing, and the caller is told so.
 */

interface Wait<Answer, Tag> {
  readonly resolve: (answer: Answer) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly tag: Tag;
}

export class PendingRequests<Id, Answer, Tag = undefined> {
  // A Map iterates in insertion order, which is the order the waits began in.
  private readonly waits = new Map<Id, Wait<Answer, Tag>>();

  /**
   * Holds a wait under [param id] for [param withinMs]. At the deadline the wait goes and rejects
   * with what [param late] makes then. Two waits cannot share a reply, so an id already waiting throws.
   */
  public wait(id: Id, withinMs: number, late: () => Error, tag?: Tag): Promise<Answer> {
    if (this.waits.has(id)) {
      throw new Error(`A request is already waiting under id ${String(id)}`);
    }
    return new Promise<Answer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waits.delete(id);
        reject(late());
      }, withinMs);
      this.waits.set(id, { resolve, reject, timer, tag: tag as Tag });
    });
  }

  /** Settles the wait under [param id] with its answer, and says whether one was waiting. */
  public answer(id: Id, answer: Answer): boolean {
    const wait = this.take(id);
    wait?.resolve(answer);
    return wait !== undefined;
  }

  /** Settles the wait under [param id] with [param error], and says whether one was waiting. */
  public fail(id: Id, error: Error): boolean {
    const wait = this.take(id);
    wait?.reject(error);
    return wait !== undefined;
  }

  /** Rejects every wait with [param error], oldest first. The table stays usable. */
  public drop(error: Error): void {
    const dropped = [...this.waits.values()];
    this.waits.clear();
    for (const wait of dropped) {
      clearTimeout(wait.timer);
      wait.reject(error);
    }
  }

  /** The tags of the waits, oldest first. */
  public waiting(): readonly Tag[] {
    return [...this.waits.values()].map((wait) => wait.tag);
  }

  private take(id: Id): Wait<Answer, Tag> | undefined {
    const wait = this.waits.get(id);
    if (wait === undefined) {
      return undefined;
    }
    this.waits.delete(id);
    clearTimeout(wait.timer);
    return wait;
  }
}

/** A count that answers [param first], then one more with each call. */
export function counting(first = 1): () => number {
  let next = first;
  return () => next++;
}
