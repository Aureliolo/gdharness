/**
 * Scripts the engine keeps alive to the end of every run that loads them, named beside its report
 * of what was still alive as it exited.
 *
 * An exported variable typed as an array or a dictionary of its own script's class, such as
 * `@export var parts: Array[Item]` in the script declaring `Item`, keeps that class in the script's
 * own default values, and Godot never frees the script: loading it and nothing else ends the run
 * with two ObjectDB instances leaked and one resource still in use. Without `--verbose` the report
 * names nothing, so it read as a leak of the operation's or of a test's, and an answer said it came
 * from the project's autoloads.
 */
import { declaredClassOf, eachScript } from './class-cache.js';
import { codeOf } from './gdscript-source.js';

/**
 * The engine's own lines saying what it still held as it exited. One instance is "1 ObjectDB
 * instance was leaked", which a pattern for the plural let through, so a run keeping one object
 * passed. A server's own objects are counted apart, as `3 RIDs of type "CanvasItem" were leaked.`
 * for three Node2D never freed, and a RID made through a server and never freed shows only there.
 */
export const EXIT_LEAK =
  /ObjectDB instances? (?:was |were )?leaked at exit|resources? still in use at exit|Pages in use exist at exit|RIDs? of type ["'][^"']+["'] (?:was|were) leaked/;

/**
 * What the test runner's markers print as the engine's shutdown clears the newest script and the
 * oldest, on an engine below 4.8. Kept in step with WALK_BEGAN and WALK_ENDED in listed.gd.
 */
export const WALK_BEGAN = "gdharness: the engine's shutdown began clearing scripts";
export const WALK_ENDED = "gdharness: the engine's shutdown cleared every script";

/**
 * Whether [param lines] show the engine's shutdown stopping part way through its scripts: the
 * marker of the newest script printed and the marker of the oldest did not. Below 4.8 the walk
 * clearing them ends on freed memory when a script's release frees the next one, and every script
 * it never reached is reported as leaked at exit, whatever the run freed itself.
 */
export function walkStoppedPartWay(lines: Iterable<string>): boolean {
  let began = false;
  for (const line of lines) {
    if (line.includes(WALK_ENDED)) {
      return false;
    }
    began ||= line.includes(WALK_BEGAN);
  }
  return began;
}

const LEAKED_INSTANCE = /^Leaked instance: (\w+):/;
const STILL_IN_USE = /^Resource still in use: (.+?) \(\w+\)$/;
/** How many of the resources still in use a sentence names before counting the rest. */
const IN_USE_NAMED = 8;
/**
 * What keeps a RefCounted alive to the exit. The engine's own hint beside the list speaks of nodes
 * removed from the tree, which sent a reader after nodes for two RefCounted holding each other.
 */
const REFCOUNTED_HELD =
  'A RefCounted alive at exit is held by a cycle of references (two holding each other, or one ' +
  'holding a lambda that captures it) or by an Object never freed, rather than by a node left out ' +
  'of the tree; a WeakRef on one side of the cycle, or clearing the reference once done, frees it.';

/**
 * What an engine started with `--verbose` names among [param lines] as it exits: the objects still
 * alive, counted by class, and the resources still in use, the project's own before its addons'.
 * Unnamed, a leak was two counts: a game's suite leaving 1251 objects in reference cycles read as
 * the engine's shutdown fault until a verbose run by hand named the game's own scripts.
 */
export function heldAtExit(lines: Iterable<string>): string | undefined {
  const objects = new Map<string, number>();
  const inUse: string[] = [];
  for (const line of lines) {
    const object = LEAKED_INSTANCE.exec(line.trim())?.[1];
    if (object !== undefined) {
      objects.set(object, (objects.get(object) ?? 0) + 1);
    }
    const resource = STILL_IN_USE.exec(line.trim())?.[1];
    if (resource !== undefined) {
      inUse.push(resource);
    }
  }
  if (objects.size === 0 && inUse.length === 0) {
    return undefined;
  }
  const counted = [...objects].sort(([a, many], [b, more]) => more - many || a.localeCompare(b));
  const objectsSaid = counted.map(([name, many]) => `${String(many)} ${name}`);
  const ownFirst = [
    ...inUse.filter((path) => !path.startsWith('res://addons/')),
    ...inUse.filter((path) => path.startsWith('res://addons/')),
  ];
  const named = ownFirst.slice(0, IN_USE_NAMED);
  const more = ownFirst.length - named.length;
  const parts = [
    objectsSaid.length === 0 ? undefined : `objects left alive: ${objectsSaid.join(', ')}`,
    named.length === 0
      ? undefined
      : `resources still in use: ${named.join(', ')}${more > 0 ? `, and ${String(more)} more` : ''}`,
  ].filter((part) => part !== undefined);
  return `The engine named them: ${parts.join('; ')}.${objects.has('RefCounted') ? ` ${REFCOUNTED_HELD}` : ''}`;
}

/** Why a leak report beside a walk that stopped part way is not counted against the run. */
export const WALK_STOPPED_SENTENCE =
  "The engine's shutdown stopped part way through its scripts (godot#117991, fixed in 4.8 by " +
  'godot#120976), so it reported as leaked at exit what it never got to free, and the report is the ' +
  "engine's rather than the run's. gdharness holds every script loaded from a file past that walk, " +
  'which keeps it whole, so this one stopped on a script it could not hold, such as one made in code. ' +
  "A leak of the run's own is not told apart in such a run.";

/** One exported variable typed with its own script's class. */
export interface SelfTypedExport {
  readonly script: string;
  readonly className: string;
  readonly property: string;
}

const NAME = '[\\p{L}_][\\p{L}\\p{N}_]*';
// Any export annotation but the three that head a group in the inspector and export nothing, with
// any other annotation after it, then the variable and the first type argument list it is given.
const EXPORTED = new RegExp(
  `@export(?!_(?:group|subgroup|category)\\b)\\w*(?:\\([^)]*\\))?\\s+(?:@${NAME}(?:\\([^)]*\\))?\\s+)*` +
    `(?:static\\s+)?var\\s+(${NAME})\\s*:\\s*(?:Array|Dictionary)\\s*\\[([^\\]]*)\\]`,
  'gu',
);

/** Every exported variable in [param sources], by `res://` path, typed with its own script's class. */
export function selfTypedExports(sources: Iterable<readonly [string, string]>): SelfTypedExport[] {
  const found: SelfTypedExport[] = [];
  for (const [script, source] of sources) {
    const className = declaredClassOf(source);
    if (className === null) {
      continue;
    }
    for (const match of codeOf(source).matchAll(EXPORTED)) {
      const types = (match[2] ?? '').split(',').map((type) => type.trim());
      if (types.includes(className)) {
        found.push({ script, className, property: match[1] ?? '' });
      }
    }
  }
  return found.sort((a, b) => (a.script < b.script ? -1 : a.script > b.script ? 1 : 0));
}

/** [method selfTypedExports] for the scripts of the project at [param projectPath]. */
export function projectSelfTypedExports(projectPath: string): SelfTypedExport[] {
  const sources: [string, string][] = [];
  eachScript(projectPath, (script, source) => {
    sources.push([script, source]);
  });
  return selfTypedExports(sources);
}

/**
 * What [param found] means for a report of what the engine held at exit, or undefined when the
 * project has none. Said as what they can account for rather than as the cause, since the report
 * counts everything still alive and a leak of the project's own is counted in the same lines.
 */
export function selfTypedSentence(found: readonly SelfTypedExport[]): string | undefined {
  if (found.length === 0) {
    return undefined;
  }
  const listed = found.map((one) => `${one.script} (${one.className}.${one.property})`);
  const named =
    listed.length === 1 ? listed[0] : `${listed.slice(0, -1).join(', ')} and ${listed[listed.length - 1]}`;
  const one = found.length === 1;
  return (
    `Godot never frees a script exporting an array or dictionary typed with its own class once a run ` +
    `has loaded it, and reports it as leaked at exit: ${named} ${one ? 'does' : 'do'}, so a run loading ` +
    `${one ? 'it' : 'one'} ends with this report whatever else it frees. Typed with a class it extends ` +
    `instead, as Array[Resource], ${one ? 'it is' : 'each is'} freed.`
  );
}
