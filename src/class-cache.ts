/**
 * What the engine knows about the project's `class_name` declarations, against what is on disk.
 *
 * Godot fixes its list of global classes when it starts and refreshes it only on a filesystem
 * scan, and the editor writes the list it is holding back over
 * `.godot/global_script_class_cache.cfg`. A game launched in between cannot resolve a class
 * written since, and dies at its first screen on "Could not find type":
 * https://github.com/godotengine/godot/issues/42786.
 *
 * Read from files, never from an engine, because this is asked before every run.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every `class_name` declared under the project, with the script that declares it.
 *
 * A directory holding a `.gdignore` is stepped over, because the engine steps over it: nothing
 * inside is imported and no declaration in there is ever a global class. Counting them makes a
 * correct project look like one whose editor has gone blind, every time it is asked.
 */
export function declaredClasses(projectPath: string): Map<string, string> {
  const declared = new Map<string, string>();
  const visit = (directory: string, prefix: string): void => {
    if (existsSync(join(directory, '.gdignore'))) {
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path, `${prefix}${entry.name}/`);
      } else if (entry.isFile() && entry.name.endsWith('.gd')) {
        const found = /^class_name\s+([A-Za-z_][A-Za-z0-9_]*)/m.exec(readFileSync(path, 'utf8'));
        if (found?.[1]) {
          declared.set(found[1], `res://${prefix}${entry.name}`);
        }
      }
    }
  };
  visit(projectPath, '');
  return declared;
}

/** The classes the cache lists, with the path each is recorded at, or null when there is none. */
export function cachedClasses(projectPath: string): Map<string, string> | null {
  const cache = join(projectPath, '.godot', 'global_script_class_cache.cfg');
  if (!existsSync(cache)) {
    return null;
  }
  const listed = new Map<string, string>();
  const text = readFileSync(cache, 'utf8');
  for (const entry of text.matchAll(/"class":\s*&"([^"]+)"[\s\S]*?"path":\s*"([^"]+)"/g)) {
    listed.set(entry[1] ?? '', entry[2] ?? '');
  }
  return listed;
}

/** A member a diagnostic says is missing, and the type it says is missing it. */
export interface MissingMember {
  readonly member: string;
  readonly type: string;
  readonly kind: 'method' | 'property';
}

/**
 * The member and type in "is not present on the inferred type", or null for any other diagnostic.
 *
 * Godot phrases this one about the *inferred* type, which is the analysed copy the language server
 * is holding rather than the file. That makes it the one diagnostic whose truth can be checked
 * against the file without re-analysing anything, and so the one worth reading out of the text.
 */
export function missingMemberIn(message: string): MissingMember | null {
  const found =
    /The (method|property) "([^"(]+)(?:\(\))?" is not present on the inferred type "([^"]+)"/.exec(message);
  if (found === null) {
    return null;
  }
  return {
    kind: found[1] === 'property' ? 'property' : 'method',
    member: found[2] ?? '',
    type: found[3] ?? '',
  };
}

/**
 * Whether [param source] declares [param missing] itself.
 *
 * Only its own declarations, never a base class. An inherited member that this file does not
 * declare says nothing either way: the diagnostic might be stale, or the caller might be right that
 * nothing in the chain has it. This exists to turn a diagnostic into a contradiction, and a
 * contradiction needs the member found rather than not found, so the conservative answer is the
 * only useful one.
 */
export function declaresMember(source: string, missing: MissingMember): boolean {
  const name = missing.member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration =
    missing.kind === 'method'
      ? new RegExp(String.raw`^\s*(?:static\s+)?func\s+${name}\s*\(`, 'm')
      : new RegExp(String.raw`^\s*(?:static\s+)?(?:@export\s+)?(?:var|const)\s+${name}\b`, 'm');
  return declaration.test(source);
}

/**
 * The type name a diagnostic says it cannot resolve, or null for any other diagnostic.
 *
 * A separate shape from the member one and worth its own reading, because a caller sees it for the
 * same underlying reason and there is nothing in the text to connect them: a class the editor has
 * not loaded is reported as a base class it cannot find, or as an identifier that is not declared,
 * neither of which mentions an inferred type.
 *
 * "Not declared in the current scope" is the loose one, since it is also what an ordinary typo
 * produces. It is safe to read here only because nothing is claimed from the message alone: a global
 * `class_name` is in scope everywhere, so the name matching one declared on disk is what makes the
 * diagnostic wrong, whatever else the identifier might have been.
 */
export function unknownTypeIn(message: string): string | null {
  const found =
    /(?:Could not find (?:base class|type)|Cannot find class|Identifier) "?([A-Za-z_][A-Za-z0-9_]*)"?(?: not declared| in the current scope|\b)/.exec(
      message,
    );
  return found?.[1] ?? null;
}

/** A class the project declares that a diagnostic says cannot be resolved, and where to look. */
export interface UnloadedType {
  readonly type: string;
  readonly declaredIn: string;
  /** Whether the cache a launched game reads already lists it, which decides the remedy. */
  readonly inTheClassCache: boolean;
}

/**
 * The types a diagnostic could not resolve that the project declares anyway.
 *
 * Which of the two lists has it is the whole of the answer, because they have different remedies and
 * a caller told only "it is declared" has to work out which. The class cache is what a launched game
 * reads: a class listed there and unresolved by the editor is the editor's loaded list being behind,
 * which only a restart clears. A class declared on disk and missing from the cache is the cache
 * being behind, which `refresh_classes` rewrites. That difference is visible from two file reads and
 * is invisible from the diagnostic.
 */
export function unloadedTypes(
  messages: readonly string[],
  declared: ReadonlyMap<string, string>,
  cached: ReadonlyMap<string, string> | null,
): UnloadedType[] {
  const seen = new Set<string>();
  const found: UnloadedType[] = [];
  for (const message of messages) {
    const type = unknownTypeIn(message);
    const declaredIn = type === null ? undefined : declared.get(type);
    if (type === null || declaredIn === undefined || seen.has(type)) {
      continue;
    }
    seen.add(type);
    found.push({ type, declaredIn, inTheClassCache: cached?.has(type) === true });
  }
  return found;
}

/**
 * The global classes a script names, which are the types its own analysed copy is built from.
 *
 * What this is for: the editor's held copy of a type is refreshed when one of the things it depends
 * on changes, and not when it changes itself. So a caller looking at a stale type needs to know what
 * that type depends on, and the answer is in the file rather than anywhere the engine will say.
 *
 * Read by name against the class list rather than by parsing GDScript, because a name that is a
 * declared global class is the only kind worth reporting and everything else in the file is noise.
 * A word inside a string or a comment can match, which costs a caller one wasted touch on a file
 * that was already fine; missing one costs them a restart.
 */
export function classesNamedIn(source: string, known: ReadonlyMap<string, string>): string[] {
  const named = new Set<string>();
  for (const [word] of source.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g)) {
    if (known.has(word)) {
      named.add(word);
    }
  }
  return [...named].sort();
}

/** A diagnostic the file on disk disproves, and the script that disproves it. */
export interface Contradicted extends MissingMember {
  readonly declaredIn: string;
}

/**
 * The diagnostics among [param messages] that the files contradict.
 *
 * Takes the class list and a reader rather than a project path so that the whole decision is one
 * function with no filesystem of its own: what it does with a message, a cache that does not list
 * the type, and a file that will not open are otherwise only reachable through a running editor.
 *
 * A type the cache does not list is passed over rather than searched for. The cache is what the
 * editor itself resolved the name against, so a name missing from it is a different fault with its
 * own answer already, and guessing at the file here would put this one on top of it.
 */
export function contradictedDiagnostics(
  messages: readonly string[],
  classes: ReadonlyMap<string, string>,
  sourceOf: (resourcePath: string) => string | null,
): Contradicted[] {
  const read = new Map<string, string | null>();
  const found: Contradicted[] = [];
  for (const message of messages) {
    const missing = missingMemberIn(message);
    const declaredIn = missing === null ? undefined : classes.get(missing.type);
    if (missing === null || declaredIn === undefined) {
      continue;
    }
    if (!read.has(declaredIn)) {
      read.set(declaredIn, sourceOf(declaredIn));
    }
    const source = read.get(declaredIn) ?? null;
    if (source !== null && declaresMember(source, missing)) {
      found.push({ ...missing, declaredIn });
    }
  }
  return found;
}

/**
 * What to tell a caller whose diagnostics the files contradict.
 *
 * A function rather than a sentence built where it is returned, because the note is the whole of
 * what a caller does next and the only way to hold it otherwise is to read the server's source and
 * match on it. That check passes on any sentence containing the words it looks for.
 *
 * It leads with the scan because that is what has cleared this, in two projects. Neither of them is
 * this one: the diagnostic has never gone stale in this project's own bench, so every figure here is
 * somebody else's reading and is attributed rather than claimed.
 *
 * The count that used to sit here, one clearing in five attempts, is gone because it measured a
 * different tool. Those five were taken against a version where the rescan answered before the scan
 * had started, so the figure is about that timing and not about a scan, and quoted beside the
 * current one it read as evidence that the scan is unreliable. The project that took them is the one
 * that spotted it. A number that arrives inside a correction is the one least likely to get checked
 * again, and four things were wrong in drafts of this sentence: the count, the attribution, what the
 * milliseconds timed, and which version the count was of.
 *
 * The milliseconds are the scan's own `waitedMs`, which is how long the call took to return and not
 * a time to clear: the diagnostic was re-read in a separate call each time, and nobody timed the
 * gap. Written as the scan returning rather than the fault clearing, because a reader takes a
 * duration beside a cure as the duration of the cure.
 *
 * The
 * reload is named after it rather than ahead of it, because they fix different things. Measured in
 * one window on one editor: the analyser resolved a call to a newly added method, reading clean,
 * and the next call found the editor's built copy of that same script without the method in it. One
 * stale and one current at the same moment is two objects, so the reload cannot be what clears a
 * diagnostic and a caller reading one must not be told it is reading the other.
 *
 * That pairing is the whole of the evidence and it had to be taken as one reading. Before, the
 * clean diagnostic came from after the reload and the stale copy from before it, which is two
 * moments reported as a divergence, and the sentence claiming it was shipped for three releases.
 *
 * The no-lever branch says why it is empty rather than only that it is. A type that depends on
 * nothing is where this fault is easiest to produce, because an edit anywhere near a type that
 * depends on something cures it before anyone notices, so the fallback is missing in exactly the
 * case that reaches it. Measured from outside: a first attempt to reproduce this read clean because
 * a dependency of the declaring script had been edited in the same window, and moving the
 * declaration to a type that depends on nothing staled it immediately.
 *
 * Every plural here counts what it is about rather than how many diagnostics arrived. Two members
 * missing from one class is two entries and one stale type and one script to reload, and saying
 * "some types" to somebody looking at one is the same wrongness as the diagnostic they are already
 * holding. An empty list has nothing to say and says nothing, rather than a confident sentence with
 * no scripts in it.
 */
export function staleAnalysisNote(
  contradicted: readonly Contradicted[],
  dependsOn: readonly string[],
): string {
  if (contradicted.length === 0) {
    return '';
  }
  // Counted by type and by script rather than by diagnostic. Two members missing from one class is
  // two entries here and one stale type, which is the shape the second project reproduced first.
  const types = new Set(contradicted.map((one) => one.type));
  const declaring = [...new Set(contradicted.map((one) => one.declaredIn))].sort();
  const lever =
    dependsOn.length === 0
      ? ', and the named types depend on no other global class, so that lever is not available here. ' +
        'That is the common case rather than the awkward one: an edit near a type that depends on ' +
        'something refreshes it before the fault is noticed, which is why a type with no ' +
        'dependencies is where this turns up'
      : `, so changing ${[...dependsOn].sort().join(', ')} and rescanning is worth a try`;
  return (
    `The editor is reporting against an older copy of ${types.size === 1 ? 'a type' : 'some types'} ` +
    'named under contradictedByTheFile. Each member listed is declared in the file the class cache ' +
    'points at, so those diagnostics are wrong however the code is written. Run editor_rescan first: ' +
    'it costs about half a second, and it has cleared this in every reproduction measured since the ' +
    'scan timing was fixed: both in one project, the scan returning in 243ms and 275ms, and one in ' +
    'another where the same call also rebuilt the copy. ' +
    'The fault behind it is that a script the editor has loaded keeps the copy it built, and nothing ' +
    `rebuilds that copy when the file changes; ${
      declaring.length === 1
        ? `editor_rescan with reloadScript set to ${declaring[0]} recompiles that copy`
        : `reloadScript takes one script, so a call each for ${declaring.join(' and ')} recompiles those copies`
    } from the file into the same ` +
    'object and answers with the members it has afterwards under reloadedMethods. Read that and the ' +
    'next diagnostics as two readings, because they are of two things: measured in one window on ' +
    'one editor, the analyser resolved a call to a newly added method while the built copy of that ' +
    'same script did not have it. So the reload is worth doing and is not what clears these; the ' +
    'scan is. The other lever measured is that a held type is refreshed when something it ' +
    `depends on changes rather than when it changes itself${lever}. editor_launch restart has always ` +
    'worked and costs a window. project_import refresh_classes does not, and answers added: [] while ' +
    'this is happening.'
  );
}

/**
 * What to tell a caller whose diagnostics name a class the cache has not got.
 *
 * Separate from the contradicted note because it is a different fault with a different remedy, and
 * one of the two remedies starts an engine. That is the half this said nothing about, and it is the
 * half that decides whether a caller can use it at all: `project_import refresh_classes` is a short
 * headless engine pass, and a project running a bench or a fan-out may forbid a second engine
 * against the same project entirely. Measured in a second project: `editor_rescan` cleared this in
 * 314ms with a 31-worker fan-out still importing, starting nothing, and the fan-out finished
 * unharmed.
 *
 * The scan is offered first and with its own limit rather than as the better remedy. A file another
 * engine has already imported reads as settled, so the editor's walk does not look inside it and the
 * declaration stays out of the list however many times it scans; that is the case the reading above
 * did not hit, and the one `refresh_classes` is for.
 */
export function uncachedClassNote(types: readonly string[]): string {
  if (types.length === 0) {
    return '';
  }
  const one = types.length === 1;
  return (
    `${types.join(', ')} ${one ? 'is declared' : 'are declared'} in this project and missing from ` +
    `.godot/global_script_class_cache.cfg, so a game launched now would not resolve ${one ? 'it' : 'them'} ` +
    'either. Try editor_rescan first: it asks the editor already running and starts nothing, and it ' +
    'cleared this in 314ms in a second project with a 31-worker fan-out still importing. It is not ' +
    'always enough, because a file another engine has already imported reads as settled and the ' +
    'walk does not look inside it. project_import refresh_classes rewrites the cache from the ' +
    'declarations on disk and does reach that case, at the cost of a short headless engine, which ' +
    'is worth knowing when something else is already running against this project.'
  );
}

/**
 * When the cache was last written, or null when there is none.
 *
 * The editor rewrites the file at the end of a scan, from the list it is holding rather than from
 * the file, and that write lands after the scan reports itself finished. So "has it been written
 * since I looked" is the only way to know whether the answer about to be given is about the file
 * that will still be there a moment later.
 */
export function cacheWrittenAt(projectPath: string): number | null {
  const cache = join(projectPath, '.godot', 'global_script_class_cache.cfg');
  try {
    return statSync(cache).mtimeMs;
  } catch {
    return null;
  }
}

/** The declarations a given cache records at a different path, or does not record at all. */
export function staleAgainst(cached: Map<string, string>, projectPath: string): string[] {
  return [...declaredClasses(projectPath)]
    .filter(([name, path]) => cached.get(name) !== path)
    .map(([name]) => name);
}

/** The declarations on disk the engine's cache does not know about. */
export function staleClassNames(projectPath: string): string[] {
  const cached = cachedClasses(projectPath);
  return cached === null ? [...declaredClasses(projectPath).keys()] : staleAgainst(cached, projectPath);
}

/** A class the cache records and the editor is not holding, with the script that declares it. */
export interface UnseenClass {
  readonly className: string;
  readonly path: string;
}

/**
 * The classes a running editor is still holding that the project no longer declares.
 *
 * The other direction from {@link unseenByEditor} and the more damaging one. Deleting a script with
 * a `class_name` and running the rebuild rewrites the cache without it and reports it `removed`,
 * which is true of the file for as long as the editor leaves it alone. The editor has not noticed
 * and writes its own list back over the cache, so the entry returns pointing at a script that is
 * gone, and the next engine to walk `get_global_class_list()` dies on "File not found" in a project
 * nobody has touched since. A rescan does not help: it picks up a class that has appeared and does
 * not drop one that has gone.
 *
 * Named from the editor's list against the declarations rather than against the cache, because the
 * cache is the file the editor is about to overwrite and is the one thing here that cannot be
 * trusted to say what happens next.
 */
export function heldButGone(projectPath: string, editorHolds: readonly string[]): string[] {
  const declared = declaredClasses(projectPath);
  return editorHolds.filter((name) => !declared.has(name)).sort();
}

/**
 * The classes on disk a running editor cannot resolve, whatever the cache says.
 *
 * Every other check here compares one file on disk with another, so the state that costs people
 * a day passes all of them: the class is declared, the cache lists it, and the editor's own list
 * does not have it because its change-detecting scan walked past a file another engine had
 * already imported. The editor is the only thing that can report this, so it is asked.
 */
export function unseenByEditor(projectPath: string, editorHolds: readonly string[]): UnseenClass[] {
  const held = new Set(editorHolds);
  // The declarations rather than the cache, because a class the cache has lost is one the editor
  // is most likely to have lost too, and reading the cache first is what kept those out of this
  // answer: the one file that is wrong decided what could be reported as wrong.
  return [...declaredClasses(projectPath)]
    .filter(([name]) => !held.has(name))
    .map(([className, path]) => ({ className, path }));
}
