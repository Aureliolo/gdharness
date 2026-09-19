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
function declaredClasses(projectPath: string): Map<string, string> {
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
