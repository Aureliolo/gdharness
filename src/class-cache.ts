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
import { join, posix } from 'node:path';
import { codeOf } from './gdscript-source.js';

/**
 * What a `class_name` line looks like, including the annotations that may share it.
 *
 * `@abstract class_name X` is one line in Godot 4.5 and later, and `@tool` and `@icon("...")` sit
 * there too. Anchoring on `class_name` alone read every one of those as not a declaration: a
 * project with gdUnit4 in it had 23 abstract classes reported as declared nowhere, and the answer
 * told the caller to restart the editor to drop them. They were all on disk.
 *
 * The same shape as the engine-side scanner in `operations/class_cache.gd`, which strips
 * annotations before looking, and which is why the cache itself was never short of them: the
 * reading that writes the file was right and the reading that reports on it was not.
 */
const DECLARATION = /^(?:@[a-z_]+(?:\([^)\n]*\))?\s+)*class_name\s+([A-Za-z_][A-Za-z0-9_]*)/m;

/**
 * A `@tool` annotation, alone on its line or among the annotations sharing one, the way
 * [DECLARATION] reads them: `@icon("res://i.svg") @tool class_name Foo` is a tool script. Read at
 * the start of the line alone, that one would pass for an ordinary script and be reloaded from
 * inside a call, which is what the test exists to prevent.
 */
const TOOL = /^[ \t]*(?:@[a-z_]+(?:\([^)\n]*\))?[ \t]+)*@tool\b/m;

/** Whether [param source] is a `@tool` script, which runs inside the editor. Read from its code. */
export function isToolScript(source: string): boolean {
  return TOOL.test(codeOf(source));
}

/**
 * Every `class_name` declared under the project, with the script that declares it.
 *
 * A directory holding a `.gdignore` is stepped over, because the engine steps over it: nothing
 * inside is imported and no declaration in there is ever a global class. Counting them makes a
 * correct project look like one whose editor has gone blind, every time it is asked.
 */
export function declaredClasses(projectPath: string): Map<string, string> {
  const declared = new Map<string, string>();
  eachScript(projectPath, (script, source) => {
    const found = DECLARATION.exec(source);
    if (found?.[1]) {
      declared.set(found[1], script);
    }
  });
  return declared;
}

/**
 * Every script under the project the engine would import, handed to [param each] as its `res://`
 * path and its source. A directory holding a `.gdignore` is stepped over, as the engine steps over it.
 */
export function eachScript(projectPath: string, each: (script: string, source: string) => void): void {
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
        each(`res://${prefix}${entry.name}`, readFileSync(path, 'utf8'));
      }
    }
  };
  visit(projectPath, '');
}

/** A script naming a class, and whether it is a `@tool` script, which runs inside the editor. */
export interface NamingScript {
  readonly script: string;
  readonly tool: boolean;
}

/**
 * The project's scripts whose code names any of [param classes], other than the ones declaring
 * them, in order of path.
 *
 * What an editor compiled from one of these while it could not resolve the class stays compiled
 * that way after a scan brings the class in: the scan updates what the editor knows about files,
 * not what it has already built from them. A script extending a new base class went on reporting
 * "Could not find base class" after a rescan had picked the class up, until it was reloaded.
 *
 * Code only, with comments and strings taken out, because what is found here gets reloaded: a
 * comment in the editor addon's tool executor that began with the word "Settings" had that script
 * reloaded while it was running the call, and the editor died of it on Linux.
 */
export function scriptsNaming(projectPath: string, classes: readonly string[]): NamingScript[] {
  const named = new Map(classes.map((name) => [name, '']));
  const naming: NamingScript[] = [];
  eachScript(projectPath, (script, source) => {
    const declares = DECLARATION.exec(source)?.[1];
    if (declares !== undefined && named.has(declares)) {
      return;
    }
    const code = codeOf(source);
    if (classesNamedIn(code, named).length > 0) {
      naming.push({ script, tool: TOOL.test(code) });
    }
  });
  return naming.sort((a, b) => a.script.localeCompare(b.script));
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

/**
 * [param rebuilt], a class cache rebuild's answer, with the classes an addon declares counted per
 * addon under `addedInAddons` and `changedInAddons` rather than named, and the project's own named
 * as before. [param listed] is the rebuilt cache, which says where each class is declared.
 *
 * For an answer whose subject is something else. A test run rebuilds the cache first so a suite
 * written a moment ago is found, and on the first run after gdUnit4 was copied in, the rebuild
 * named every one of its two hundred classes: the few lines a clean tier answers in came back
 * behind nine kilobytes of names nobody asked about.
 */
export function withAddonClassesCounted(
  rebuilt: Readonly<Record<string, unknown>>,
  listed: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const counted: Record<string, unknown> = { ...rebuilt };
  for (const key of ['added', 'changed']) {
    const names = rebuilt[key];
    if (!Array.isArray(names)) {
      continue;
    }
    const own: unknown[] = [];
    const perAddon: Record<string, number> = {};
    for (const name of names) {
      const addon = /^res:\/\/addons\/([^/]+)\//.exec(listed.get(String(name)) ?? '')?.[1];
      if (addon === undefined) {
        own.push(name);
      } else {
        perAddon[addon] = (perAddon[addon] ?? 0) + 1;
      }
    }
    if (Object.keys(perAddon).length > 0) {
      counted[key] = own;
      counted[`${key}InAddons`] = perAddon;
    }
  }
  return counted;
}

/**
 * A member a diagnostic says is missing, and the global class it says is missing it.
 *
 * `method` and `property` are looked for on an instance of the type, `member` and `static method`
 * on the class itself, as in `Charm.MAX` and `Charm.make()`, and `enum member` in one of its enums,
 * as in `Charm.Kind.ZZ_PROBE`, where `enum` names the enum.
 */
export interface MissingMember {
  readonly member: string;
  readonly type: string;
  readonly kind: 'method' | 'property' | 'member' | 'static method' | 'enum member';
  readonly enum?: string;
}

/**
 * The member and type a diagnostic says is missing, or null for any other diagnostic.
 *
 * Three shapes. "is not present on the inferred type" is about the analysed copy the language server
 * is holding rather than the file. "Cannot find member ... in base" is what Godot says of a name
 * looked up on a class, or on an enum of one, and "Static function ... not found in base" of a
 * function called on the class, measured on 4.7.2 as `Cannot find member "NEVER" in base
 * "Peal.Kind".`, `Cannot find member "NOWHERE" in base "Peal".` and `Static function "nope()" not
 * found in base "Peal".`. All three can be checked against the file without re-analysing anything,
 * which is what makes them worth reading out of the text.
 *
 * Only a class's own base is read, and one enum under it: Godot names an inner class's enum
 * `Peal::Inner.Kind`, and what is declared under an inner class is not looked for, so nothing past
 * those two parts could be checked.
 */
export function missingMemberIn(message: string): MissingMember | null {
  const inferred =
    /The (method|property) "([^"(]+)(?:\(\))?" is not present on the inferred type "([^"]+)"/.exec(message);
  if (inferred !== null) {
    return {
      kind: inferred[1] === 'property' ? 'property' : 'method',
      member: inferred[2] ?? '',
      type: inferred[3] ?? '',
    };
  }
  const called = /Static function "([A-Za-z_]\w*)\(\)" not found in base "([A-Za-z_]\w*)"/.exec(message);
  if (called !== null) {
    return { kind: 'static method', member: called[1] ?? '', type: called[2] ?? '' };
  }
  const inBase = /Cannot find member "([A-Za-z_]\w*)" in base "([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?"/.exec(
    message,
  );
  if (inBase === null) {
    return null;
  }
  const member = inBase[1] ?? '';
  const type = inBase[2] ?? '';
  const enumName = inBase[3];
  return enumName === undefined
    ? { kind: 'member', member, type }
    : { kind: 'enum member', member, type, enum: enumName };
}

/**
 * The member an "external class member" diagnostic says is missing, and the class it was looked up
 * on, read from [param line], the diagnosed script's line the diagnostic is on.
 *
 * Godot names only the member: `Could not resolve external class member "READ_BY_THE_RUN".` So the
 * class is the identifier before `.READ_BY_THE_RUN` on that line, taken only when it is one of
 * [param classes]. ostinato met 332 of these across 270 scripts, all stale, none of them checked,
 * because no type could be read from the message alone. A member reached through anything else,
 * such as a constant holding a preloaded script, is left unread rather than guessed.
 */
export function externalMemberIn(
  message: string,
  line: string | undefined,
  classes: ReadonlyMap<string, string>,
): MissingMember | null {
  const member = /Could not resolve external class member "([A-Za-z_]\w*)"/.exec(message)?.[1];
  if (member === undefined || line === undefined) {
    return null;
  }
  for (const [, type] of line.matchAll(new RegExp(String.raw`\b([A-Za-z_]\w*)\s*\.\s*${member}\b`, 'g'))) {
    if (type !== undefined && classes.has(type)) {
      return { kind: 'member', member, type };
    }
  }
  return null;
}

/**
 * The script [param source] extends, as a resource path, or undefined for a native base or none.
 * A class name is looked up in [param classes]; a quoted path is taken as written, and one without
 * `res://` is read against [param from], the script's own path, as Godot reads it.
 */
function baseScriptOf(
  source: string,
  from: string,
  classes: ReadonlyMap<string, string>,
): string | undefined {
  const found =
    /^(?:@\w+(?:\([^)]*\))?\s+)*(?:class_name\s+\w+\s+)?extends\s+(?:"([^"]+)"|'([^']+)'|([A-Za-z_]\w*))/m.exec(
      source,
    );
  const quoted = found?.[1] ?? found?.[2];
  if (quoted !== undefined) {
    return quoted.startsWith('res://')
      ? quoted
      : posix.join(posix.dirname(from), quoted).replace(/^res:\/(?!\/)/, 'res://');
  }
  const named = found?.[3];
  return named === undefined ? undefined : classes.get(named);
}

/**
 * Whether [param source] declares [param missing] itself.
 *
 * Only its own declarations, never a base class: {@link contradictedDiagnostics} walks the bases.
 * A member nothing in the chain declares says nothing either way: the diagnostic might be stale, or
 * the caller might be right. This exists to turn a diagnostic into a contradiction, and a
 * contradiction needs the member found rather than not found, so the conservative answer is the
 * only useful one.
 */
export function declaresMember(source: string, missing: MissingMember): boolean {
  const name = missing.member.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // At the start of a line with nothing before it but annotations: a global class's own members sit
  // at column 0, and one indented under `class Inner:` belongs to the inner class. `Peal.LIMIT` with
  // LIMIT declared only in Peal.Inner is denied rightly.
  const top = String.raw`^(?:@\w+(?:\([^)]*\))?\s+)*`;
  const declared = (kinds: string): boolean =>
    new RegExp(String.raw`${top}(?:${kinds})\s+${name}\b`, 'm').test(source);
  if (missing.kind === 'method') {
    return new RegExp(String.raw`${top}(?:static\s+)?func\s+${name}\s*\(`, 'm').test(source);
  }
  if (missing.kind === 'static method') {
    return new RegExp(String.raw`${top}static\s+func\s+${name}\s*\(`, 'm').test(source);
  }
  if (missing.kind === 'enum member') {
    return enumValues(source, missing.enum ?? '').includes(missing.member);
  }
  // What the class itself answers by name: a static variable or function, a constant, an enum or
  // inner class by its own name, and the values of an enum with no name, which land on the class. A
  // plain variable or a signal is not among them; Godot denies `Peal.speed` for `var speed`, and is
  // right to. An instance answers all of those and its variables, signals and functions besides.
  const kinds =
    missing.kind === 'property'
      ? String.raw`(?:static\s+)?(?:var|func)|const|enum|class|signal`
      : String.raw`static\s+(?:var|func)|const|enum|class`;
  return declared(kinds) || enumValues(source, null).includes(missing.member);
}

/**
 * The values of every enum at the top of [param source] called [param named], or of every one with
 * no name when it is null. Read from the braces, a line comment at a time, so a value on its own line
 * with a comment after it counts and a word inside the comment does not. An enum inside an inner
 * class is the inner class's, and is not read.
 */
function enumValues(source: string, named: string | null): string[] {
  const opening =
    named === null
      ? /^enum\s*\{([^}]*)\}/gm
      : new RegExp(String.raw`^enum\s+${named.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\s*\{([^}]*)\}`, 'gm');
  const values: string[] = [];
  for (const [, body] of source.matchAll(opening)) {
    const uncommented = (body ?? '')
      .split('\n')
      .map((line) => line.replace(/#.*$/, ''))
      .join('\n');
    for (const part of uncommented.split(',')) {
      const value = /^\s*([A-Za-z_]\w*)/.exec(part)?.[1];
      if (value !== undefined) {
        values.push(value);
      }
    }
  }
  return values;
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
 *
 * One entry per member however many diagnostics deny it. A static function called on the class is
 * denied twice where the unsafe method access warning is raised to an error, once as a static
 * function and once as a method of the inferred type. The static reading decides for that call
 * whether or not the file bears it out: it says the call was made on the class, so a file declaring
 * the function without `static` has the call wrong, and the method reading, which a plain `func`
 * satisfies, must not claim it.
 */
export function contradictedDiagnostics(
  messages: readonly string[],
  classes: ReadonlyMap<string, string>,
  sourceOf: (resourcePath: string) => string | null,
  alsoDenied: readonly MissingMember[] = [],
): Contradicted[] {
  const keyOf = (missing: MissingMember): string =>
    [missing.type, missing.enum ?? '', missing.member].join('.');
  const denials = [
    ...messages
      .map((message) => missingMemberIn(message))
      .filter((missing): missing is MissingMember => missing !== null),
    ...alsoDenied,
  ];
  const calledOnTheClass = new Set(
    denials.filter((missing) => missing.kind === 'static method').map((missing) => keyOf(missing)),
  );
  const read = new Map<string, string | null>();
  const sourceAt = (path: string): string | null => {
    if (!read.has(path)) {
      read.set(path, sourceOf(path));
    }
    return read.get(path) ?? null;
  };
  const found = new Map<string, Contradicted>();
  for (const missing of denials) {
    const key = keyOf(missing);
    if (found.has(key) || (missing.kind === 'method' && calledOnTheClass.has(key))) {
      continue;
    }
    // Up the chain of project scripts, because a member is the type's whether its own file declares
    // it or a base does: `Shop extends Tariff` has `piece_sells` from tariff.gd, and the 270 scripts
    // denying such members were exactly as stale as the four whose member sat in the named file.
    const seen = new Set<string>();
    let at = classes.get(missing.type);
    while (at !== undefined && !seen.has(at)) {
      seen.add(at);
      const source = sourceAt(at);
      if (source === null) {
        break;
      }
      if (declaresMember(source, missing)) {
        found.set(key, { ...missing, declaredIn: at });
        break;
      }
      at = baseScriptOf(source, at, classes);
    }
  }
  return [...found.values()];
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
 * somebody else's reading and is attributed rather than claimed. That is for methods and
 * properties; an enum member or a constant is answered the other way round, in {@link classRemedy}.
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
  // Counted by type rather than by diagnostic. Two members missing from one class is two entries
  // here and one stale type, which is the shape the second project reproduced first.
  const types = new Set(contradicted.map((one) => one.type));
  const onInstances = contradicted.filter((one) => one.kind === 'method' || one.kind === 'property');
  const onTheClass = contradicted.filter(
    (one) => one.kind === 'member' || one.kind === 'static method' || one.kind === 'enum member',
  );
  return [
    `The editor is reporting against an older copy of ${types.size === 1 ? 'a type' : 'some types'} ` +
      'named under contradictedByTheFile. Each member listed is declared in the script under its ' +
      'declaredIn, the class itself or a project class it extends, so those diagnostics are wrong ' +
      'however the code is written.',
    instanceRemedy(onInstances, dependsOn, onTheClass.length > 0),
    classRemedy(onTheClass),
  ]
    .filter((part) => part !== '')
    .join(' ');
}

/** How a contradicted entry is written in Godot's own terms: `Bell.toll`, `Charm.Kind.ZZ_PROBE`. */
function written(one: Contradicted): string {
  return [one.type, ...(one.enum === undefined ? [] : [one.enum]), one.member].join('.');
}

/** The scripts [param entries] are declared in, each once and in order. */
function declaringScripts(entries: readonly Contradicted[]): string[] {
  return [...new Set(entries.map((one) => one.declaredIn))].sort();
}

/**
 * The remedy for methods and properties the diagnostics deny, which the scan has cleared. Named by
 * member only when members of the class itself are listed beside them, since those are answered the
 * other way round.
 */
function instanceRemedy(
  entries: readonly Contradicted[],
  dependsOn: readonly string[],
  besideOthers: boolean,
): string {
  if (entries.length === 0) {
    return '';
  }
  const declaring = declaringScripts(entries);
  const lever =
    dependsOn.length === 0
      ? ', and the named types depend on no other global class, so that lever is not available here. ' +
        'That is the common case rather than the awkward one: an edit near a type that depends on ' +
        'something refreshes it before the fault is noticed, which is why a type with no ' +
        'dependencies is where this turns up'
      : `, so changing ${[...dependsOn].sort().join(' or ')} and then rescanning is worth a try`;
  return (
    `${besideOthers ? `For ${entries.map(written).join(', ')}, run` : 'Run'} editor_rescan first: ` +
    'it costs about half a second, and it has cleared this in every reproduction measured since the ' +
    'scan timing was fixed: both in one project, the scan returning in 243ms and 275ms, and one in ' +
    'another where the same call also rebuilt the copy. ' +
    'The fault behind it is that a script the editor has loaded keeps the copy it built, and nothing ' +
    `rebuilds that copy when the file changes; ${
      declaring.length === 1
        ? `editor_rescan with reloadScript set to ${declaring[0]} recompiles that copy`
        : `reloadScript takes one script, so a call each for ${declaring.join(' and ')} recompiles those copies`
    } from the file into the same ` +
    'object and answers with what that added under methodsAdded and constantsAdded. Read that and the ' +
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
 * The remedy for what the diagnostics deny on the class itself, enum members, constants and static
 * functions, which runs the other way: the reload first. The one measurement is ostinato's, of enum
 * members of global classes, twice on 1.1.14 and once on 1.1.19: the one plain rescan tried left the
 * diagnostic standing, and a reload of the declaring script cleared it at once each time. It has not
 * reproduced in this project's editor tier, where a member added
 * to the enum of a type the editor holds resolved with nothing asked, so the reading is attributed
 * rather than claimed. A constant or a static function on the class is looked up on the class the
 * same way and has not been measured, and the sentence says which one was.
 */
function classRemedy(entries: readonly Contradicted[]): string {
  if (entries.length === 0) {
    return '';
  }
  const declaring = declaringScripts(entries);
  const reload =
    declaring.length === 1
      ? `editor_rescan with reloadScript set to ${declaring[0]}`
      : `editor_rescan with reloadScript, a call each for ${declaring.join(' and ')} since it takes one script,`;
  // One at a time because a reload can cover the next: a rescan that brings in a class reloads
  // every script naming it, and ostinato's reload of rules.gd brought in Usurp and reloaded gear.gd,
  // the other script this note had sent it to.
  const oneAtATime =
    declaring.length === 1
      ? ''
      : ' Take them one at a time: a rescan that brings in a class also reloads every script naming it and lists them under dependentsReloaded, so a script listed there needs no call of its own.';
  return (
    `For ${entries.map(written).join(', ')}, run ${reload} first.${oneAtATime} In the one project ` +
    'that has reproduced a stale enum member, three times, the reload cleared it at once each time, ' +
    'and the one plain editor_rescan tried left the diagnostic standing.'
  );
}

/** A script naming a class a scan brought in that was not reloaded, and why. */
export interface NotReloaded {
  readonly scriptPath: string;
  readonly problem: string;
  /** Left alone for being a `@tool` script, rather than tried and refused. */
  readonly tool?: true;
}

/**
 * What a caller is told about the scripts naming a class the scan brought in that were not
 * reloaded, each with the remedy that fits it. One that was tried and refused is tried again with
 * `reloadScript`; a `@tool` script is not, because `reloadScript` refuses one for the same reason
 * the rescan left it alone, so sending the caller there would only earn the refusal.
 */
export function notReloadedNote(broughtIn: readonly string[], notReloaded: readonly NotReloaded[]): string {
  const tried = notReloaded.filter((one) => one.tool !== true).map((one) => one.scriptPath);
  const tools = notReloaded.filter((one) => one.tool === true).map((one) => one.scriptPath);
  const all = [...tried, ...tools];
  const remedies: string[] = [];
  if (tried.length > 0) {
    remedies.push(
      `For ${tried.join(', ')}: editor_rescan with reloadScript on ${tried.length === 1 ? 'it' : 'each'}, or editor_launch restart.`,
    );
  }
  if (tools.length > 0) {
    remedies.push(
      `For ${tools.join(', ')}, ${tools.length === 1 ? 'a @tool script' : '@tool scripts'}, which ${tools.length === 1 ? 'runs' : 'run'} inside the editor and ${tools.length === 1 ? 'is' : 'are'} not reloaded from inside a call: editor_launch restart.`,
    );
  }
  return `The scan brought in ${broughtIn.join(', ')}, and ${all.join(', ')} ${all.length === 1 ? 'names one of them and' : 'name them and'} could not be reloaded, so the editor still holds what it compiled while it could not see the class and reports that to the language server. ${remedies.join(' ')}`;
}

/** A reload the editor refused, and what the copy it holds had before and has now. */
export interface FailedReload {
  readonly script: string;
  readonly code: number;
  /** Godot's own name for [member code], empty when the editor gave none. */
  readonly codeName: string;
  readonly heldBefore: readonly string[];
  readonly heldAfter: readonly string[];
  readonly constantsBefore: readonly string[];
  readonly constantsAfter: readonly string[];
  /** The project's global classes the script's file names, other than its own. */
  readonly names: readonly string[];
  /**
   * Whether the editor compiled the copy again from the text it held before, which is what makes it
   * usable again, or null from an addon that does not say.
   */
  readonly restored: boolean | null;
  /** Godot's own name for why that compile failed too, when it did. */
  readonly restoredAs: string;
}

/**
 * What a reload changed in the copy the editor holds, from its member lists before and after, with
 * how many it holds afterwards. A reload is asked whether it brought the copy up to the file, which
 * is the difference; the count is there because a reload that compiled nothing and answered OK is
 * the failure worth catching, and it shows as a copy holding no methods. Enum values come as
 * `Kind.SHORT` among the constants, since a copy holds an enum member as a constant.
 */
export function reloadDifference(reloaded: {
  readonly methods?: readonly string[];
  readonly heldBefore?: readonly string[];
  readonly constants?: readonly string[];
  readonly heldConstantsBefore?: readonly string[];
}): Record<string, unknown> {
  const between = (
    before: readonly string[] | undefined,
    after: readonly string[] | undefined,
  ): { added: string[]; removed: string[] } | null => {
    if (before === undefined || after === undefined) {
      return null;
    }
    const was = new Set(before);
    const is = new Set(after);
    return { added: after.filter((name) => !was.has(name)), removed: before.filter((name) => !is.has(name)) };
  };
  const methods = between(reloaded.heldBefore, reloaded.methods);
  const constants = between(reloaded.heldConstantsBefore, reloaded.constants);
  return {
    ...(reloaded.methods === undefined ? {} : { methodsHeld: reloaded.methods.length }),
    ...(methods === null ? {} : { methodsAdded: methods.added, methodsRemoved: methods.removed }),
    ...(reloaded.constants === undefined ? {} : { constantsHeld: reloaded.constants.length }),
    ...(constants === null ? {} : { constantsAdded: constants.added, constantsRemoved: constants.removed }),
  };
}

/**
 * What to tell a caller whose reload did not compile.
 *
 * ostinato met one on a script whose held copy had, straight after, one method of the eleven it had
 * held for days, and could not tell whether the failed reload had done that. So the note reads the
 * copy's members before and after, and names what went.
 *
 * The members are not the whole of it. A failed reload leaves the copy unusable while its member
 * lists read as before, measured on 4.7.2: the editor can make no instance of it, and one it already
 * made has lost its methods. The addon compiles the text the copy was built from again, which puts
 * it back, and says whether that worked; the note says the copy is as it was only when it did.
 *
 * The advice on order is ostinato's: the script failed while a class it names was behind in the
 * editor, and reloading that class first and then the script cleared it. Named by the classes the
 * file names, since only the caller can read the errors and see which of them the diagnostics deny.
 */
export function failedReloadNote(failed: FailedReload): string {
  const missing = (before: readonly string[], after: readonly string[]): string[] =>
    before.filter((name) => !after.includes(name));
  const lost = [
    ...missing(failed.heldBefore, failed.heldAfter),
    ...missing(failed.constantsBefore, failed.constantsAfter),
  ];
  const unchanged =
    lost.length === 0 &&
    missing(failed.heldAfter, failed.heldBefore).length === 0 &&
    missing(failed.constantsAfter, failed.constantsBefore).length === 0;
  const answered =
    failed.codeName === '' ? `error ${failed.code}` : `error ${failed.code}, ${failed.codeName}`;
  const unusable =
    'A failed compile leaves the copy the editor holds unusable, measured on 4.7.2: the editor can make no instance of it, and one it already made has lost its methods, while its member lists read as before.';
  let copy: string;
  if (failed.restored === null) {
    copy = `${unusable} This editor's addon does not put it back, so it stays that way until the script compiles: reload it then, or restart the editor with editor_launch restart.`;
  } else if (!failed.restored) {
    copy = `${unusable} The editor compiled it again from the text it was built from, and that failed too${failed.restoredAs === '' ? '' : ` (${failed.restoredAs})`}, so it stays that way until the script compiles: reload it then, or restart the editor with editor_launch restart.`;
  } else if (unchanged) {
    copy =
      'The copy the editor holds was compiled again from the text it was built from, which puts it back as it was, with the members it held before, which listMembers lists.';
  } else {
    copy = `The copy the editor holds was compiled again from the text it was built from and changed even so${lost.length === 0 ? '' : `, and has lost ${lost.join(', ')}`}: anything diagnosed against it now is answered from what is left, and reloading it once it compiles rebuilds it.`;
  }
  const order =
    failed.names.length === 0
      ? ''
      : ` If they deny a member of ${failed.names.join(' or ')} that its file declares, the editor's copy of that class is behind: reload that class first with reloadScript and then this script, the order that cleared it in the one project that has met this.`;
  return (
    `${failed.script} did not compile: Godot answered ${answered}. ${copy} ` +
    `script_diagnostics on it gives the errors.${order}`
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

/**
 * Which of [param names] are declared by a script written after [param since].
 *
 * A class the cache lost is the editor's doing only if its file was there when the editor wrote
 * the cache. A file taken away and put back (a stash, a checkout, a move) is written fresh, so it
 * is newer than a cache the editor wrote while it was gone: that editor listed what was on disk,
 * and a rescan picks the class up as it does any class that has appeared. Read as a short list,
 * it sent a caller to a restart the rescan made unnecessary.
 */
export function declaredSince(
  projectPath: string,
  paths: ReadonlyMap<string, string>,
  names: readonly string[],
  since: number,
): string[] {
  return names.filter((name) => {
    const path = paths.get(name);
    if (path === undefined || !path.startsWith('res://')) {
      return false;
    }
    try {
      return statSync(join(projectPath, path.slice('res://'.length))).mtimeMs > since;
    } catch {
      return false;
    }
  });
}

/**
 * The classes a cache records at a path that is not on disk, by name.
 *
 * The one invariant a cache can be held to without asking anybody: every entry names a file. An
 * entry that does not is a script that was renamed or deleted while an editor went on holding its
 * class, written back by that editor's next scan, and the next engine to read it fails on
 * `Could not parse global class "Pace" from "res://ui/pace.gd"` in whichever correct script shares
 * the bare name.
 */
export function cachedAtMissingPaths(cached: Map<string, string>, projectPath: string): string[] {
  return [...cached]
    .filter(
      ([, path]) => path.startsWith('res://') && !existsSync(join(projectPath, path.slice('res://'.length))),
    )
    .map(([name]) => name)
    .sort();
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
  return (
    [...declaredClasses(projectPath)]
      .filter(([name]) => !held.has(name))
      .map(([className, path]) => ({ className, path }))
      // Sorted, as `heldButGone` beside it already is and for the same reason: this is a list a
      // caller reads in an answer, and the order it came out of a directory walk is the order the
      // filenames happened to be in. Renaming a file would otherwise reorder a note that is about
      // classes and says nothing about files.
      // The same comparison `heldButGone` uses rather than a locale-aware one, so two lists of class
      // names in the same answer cannot be ordered by two different rules.
      .sort((one, other) => (one.className < other.className ? -1 : one.className > other.className ? 1 : 0))
  );
}
