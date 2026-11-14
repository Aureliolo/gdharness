/**
 * Object counts by class, read from the engine's own object snapshot, and the snapshots kept here.
 *
 * Read from `modules/objectdb_profiler` at 4.7.2. An engine built with debug features, an editor or
 * a debug export template, registers the `snapshot` capture in every game it runs. Asked to prepare
 * one, the game serialises every object it holds, deflates the lot and answers its size, then sends
 * the bytes in the slices asked for. Inflated, they are one Array: a header Dictionary, then four
 * entries for each object. Those are its id, its engine class, its properties and a Dictionary the
 * collector adds, holding ref_count for a RefCounted and node_name for a Node.
 */

import { inflateSync } from 'node:zlib';
import { declaredClasses } from './class-cache.js';
import { decodeVariant, type GodotValue } from './godot-variant.js';
import { isRecord } from './records.js';

/**
 * How many bytes each slice asks for. The game queues at most 8 MiB to send, so a slice stays well
 * under it, and a small one costs only a frame more per slice.
 */
export const SNAPSHOT_SLICE_BYTES = 64 << 10;

/** What kind of object a class's instances are, from what the collector adds to each. */
type ObjectKind = 'RefCounted' | 'Node' | 'Object';

/** How many objects of one engine class with one script the game held. */
interface CountedClass {
  readonly engineClass: string;
  /** The script's path, or null for an object with none. */
  readonly script: string | null;
  readonly kind: ObjectKind;
  readonly count: number;
}

/** A snapshot as the game's keeper reads it, with no project to name its scripts from. */
export interface SnapshotCounts {
  readonly classes: readonly CountedClass[];
  /** How many deflated bytes the game sent it in. */
  readonly bytes: number;
  /** The engine's own reading of the memory it had in use, in bytes, when the header has one. */
  readonly memoryBytes?: number;
}

type Entries = readonly (readonly [GodotValue, GodotValue])[];

// A type guard, because Array.isArray does not narrow a union holding a readonly array.
function isList(value: GodotValue | undefined): value is readonly GodotValue[] {
  return Array.isArray(value);
}

function entriesOf(value: GodotValue | undefined): Entries | null {
  if (value === undefined || value === null || typeof value !== 'object' || isList(value)) {
    return null;
  }
  return value.kind === 'dictionary' && 'entries' in value ? value.entries : null;
}

function hasKey(entries: Entries, key: string): boolean {
  return entries.some(([name]) => name === key);
}

/** The path of the script a property list names, or null. A script with a path is sent as it. */
function scriptOf(properties: GodotValue | undefined): string | null {
  if (!isList(properties)) {
    return null;
  }
  for (const property of properties) {
    if (isList(property) && property[0] === 'script' && typeof property[5] === 'string') {
      return property[5] === '' ? null : property[5];
    }
  }
  return null;
}

function kindOf(extra: Entries): ObjectKind {
  if (hasKey(extra, 'ref_count')) {
    return 'RefCounted';
  }
  return hasKey(extra, 'node_name') ? 'Node' : 'Object';
}

/** Every object [param compressed] holds, counted by engine class and script. */
export function countSnapshot(compressed: Uint8Array): SnapshotCounts {
  const all = decodeVariant(inflateSync(compressed));
  if (!isList(all) || entriesOf(all[0]) === null || (all.length - 1) % 4 !== 0) {
    throw new RangeError('the snapshot is not a header followed by four entries for each object');
  }
  const counted = new Map<
    string,
    { engineClass: string; script: string | null; kind: ObjectKind; count: number }
  >();
  for (let at = 1; at < all.length; at += 4) {
    const engineClass = all[at + 1];
    const extra = entriesOf(all[at + 3]);
    if (typeof engineClass !== 'string' || extra === null) {
      throw new RangeError(
        `object ${(at - 1) / 4} of the snapshot is not an id, class, properties and extra`,
      );
    }
    const script = scriptOf(all[at + 2]);
    const key = `${engineClass}\n${script ?? ''}`;
    const one = counted.get(key) ?? { engineClass, script, kind: kindOf(extra), count: 0 };
    one.count += 1;
    counted.set(key, one);
  }
  const memory = entriesOf(all[0])?.find(([name]) => name === 'mem_usage')?.[1];
  return {
    classes: [...counted.values()],
    bytes: compressed.length,
    ...(typeof memory === 'number' ? { memoryBytes: memory } : {}),
  };
}

/** Whether [param value], as it crossed the keeper's channel, is the counts of a snapshot. */
export function isSnapshotCounts(value: unknown): value is SnapshotCounts {
  return isRecord(value) && Array.isArray(value['classes']) && typeof value['bytes'] === 'number';
}

/** One class as an answer names it: by its class_name, its script's path, or its engine class. */
interface NamedClass {
  readonly class: string;
  readonly kind: ObjectKind;
  readonly count: number;
  /** The engine class under a script, when the name is the script's. */
  readonly engineClass?: string;
}

interface Totals {
  readonly objects: number;
  readonly refCounted: number;
  readonly nodes: number;
}

/** A snapshot kept here, named by its id, with the run it was taken in. */
export interface KeptSnapshot {
  readonly id: string;
  /** Which run it came from: the address of that run's keeper, which no other run has. */
  readonly run: string;
  readonly pid: number | null;
  readonly takenAt: string;
  readonly classes: readonly NamedClass[];
  readonly totals: Totals;
  readonly bytes: number;
  readonly memoryBytes?: number;
}

/**
 * [param counts] by the names a caller knows its classes by. The engine names a scripted object by
 * its engine class alone, so the script's class_name, read from the project, is what tells one
 * custom Resource from another.
 */
function namedClasses(counts: SnapshotCounts, projectPath: string): NamedClass[] {
  const names = new Map<string, string>();
  if (projectPath !== '') {
    for (const [name, script] of declaredClasses(projectPath)) {
      names.set(script, name);
    }
  }
  const named = new Map<string, NamedClass>();
  for (const one of counts.classes) {
    const name = one.script === null ? one.engineClass : (names.get(one.script) ?? one.script);
    const before = named.get(name);
    named.set(name, {
      class: name,
      kind: one.kind,
      count: (before?.count ?? 0) + one.count,
      ...(one.script === null ? {} : { engineClass: one.engineClass }),
    });
  }
  return [...named.values()].toSorted((a, b) => b.count - a.count || a.class.localeCompare(b.class));
}

function totalsOf(classes: readonly NamedClass[]): Totals {
  const sum = (kind?: ObjectKind): number =>
    classes.filter((one) => kind === undefined || one.kind === kind).reduce((all, one) => all + one.count, 0);
  return { objects: sum(), refCounted: sum('RefCounted'), nodes: sum('Node') };
}

/** Why a diff of two kept snapshots cannot be answered, with what to do. */
export interface DiffRefusal {
  readonly refused: string;
  readonly solutions: readonly string[];
}

const TAKE_ONE = 'debug_objects snapshot takes a snapshot of the running game and names its id';

/** The snapshots taken while this server runs, by id. */
export class SnapshotStore {
  private readonly kept = new Map<string, KeptSnapshot>();
  private taken = 0;

  keep(run: string, pid: number | null, counts: SnapshotCounts, projectPath: string): KeptSnapshot {
    this.taken += 1;
    const classes = namedClasses(counts, projectPath);
    const snapshot: KeptSnapshot = {
      id: `s${this.taken}`,
      run,
      pid,
      takenAt: new Date().toISOString(),
      classes,
      totals: totalsOf(classes),
      bytes: counts.bytes,
      ...(counts.memoryBytes === undefined ? {} : { memoryBytes: counts.memoryBytes }),
    };
    this.kept.set(snapshot.id, snapshot);
    return snapshot;
  }

  /** The kept snapshot [param id] names, or why there is none for a diff. */
  find(id: string): KeptSnapshot | DiffRefusal {
    const found = this.kept.get(id);
    if (found !== undefined) {
      return found;
    }
    const held = [...this.kept.keys()];
    return {
      refused: `No snapshot is kept as ${JSON.stringify(id)}. ${
        held.length === 0
          ? 'None has been taken since this server started.'
          : `The ones kept are ${held.join(', ')}.`
      }`,
      solutions: [TAKE_ONE],
    };
  }
}

/** Why [param before] and [param after] cannot be compared, or null when they can. */
export function mismatchedRuns(before: KeptSnapshot, after: KeptSnapshot): DiffRefusal | null {
  if (before.run === after.run) {
    return null;
  }
  return {
    refused: `${before.id} was taken in an earlier run of the game than ${after.id}${
      before.pid === null || after.pid === null ? '' : ` (process ${before.pid}, then ${after.pid})`
    }. Each run makes its objects afresh, so counts from two runs do not show what one action kept.`,
    solutions: [`${TAKE_ONE}. Take one before the action and one after it, in the same run`],
  };
}

/** A kept snapshot as its answer. */
export function snapshotAnswer(snapshot: KeptSnapshot): Record<string, unknown> {
  return {
    snapshot: snapshot.id,
    pid: snapshot.pid,
    takenAt: snapshot.takenAt,
    ...snapshot.totals,
    bytes: snapshot.bytes,
    ...(snapshot.memoryBytes === undefined ? {} : { memoryBytes: snapshot.memoryBytes }),
    classes: snapshot.classes,
  };
}

/** Each class whose count moved from [param before] to [param after], biggest move first. */
export function diffAnswer(before: KeptSnapshot, after: KeptSnapshot): Record<string, unknown> {
  const was = new Map(before.classes.map((one) => [one.class, one]));
  const now = new Map(after.classes.map((one) => [one.class, one]));
  const changed = [...new Set([...was.keys(), ...now.keys()])]
    .map((name) => {
      const then = was.get(name)?.count ?? 0;
      const later = now.get(name)?.count ?? 0;
      const kind = now.get(name)?.kind ?? was.get(name)?.kind ?? 'Object';
      return { class: name, kind, before: then, after: later, change: later - then };
    })
    .filter((one) => one.change !== 0)
    .toSorted((a, b) => Math.abs(b.change) - Math.abs(a.change) || a.class.localeCompare(b.class));
  const move = (field: keyof Totals): Record<string, number> => ({
    before: before.totals[field],
    after: after.totals[field],
    change: after.totals[field] - before.totals[field],
  });
  return {
    before: before.id,
    after: after.id,
    objects: move('objects'),
    refCounted: move('refCounted'),
    nodes: move('nodes'),
    changed,
    unchangedClasses: new Set([...was.keys(), ...now.keys()]).size - changed.length,
  };
}
