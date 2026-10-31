import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

/** What freeing a project's library copies did, for the debug log. */
export interface FreedCopies {
  /** The copies an engine still had mapped, renamed aside so the next engine can make its own. */
  readonly setAside: readonly string[];
  /** Copies and leftovers no engine held any more, deleted. */
  readonly swept: readonly string[];
}

/**
 * Clears the way for an engine running as the editor to load the project's GDExtension libraries.
 *
 * On Windows such an engine (the editor, an import, an export) loads each reloadable library from
 * a copy beside it named `~` and the library's name, deleting any copy already there first, and
 * the name is the same in every process. A copy another engine has mapped can be neither deleted
 * nor written over, so the second engine printed "Error copying library" and ran without the
 * extension: every export straight after an editor restart failed, and every import beside an
 * open editor loaded nothing until it was run again. Windows does let a mapped file be renamed,
 * and the engine holding it runs on from the new name, so the copy is moved aside rather than
 * deleted. Leftovers named after the copy (copies set aside earlier, and the `~RF….TMP` files a
 * failed copy leaves) are deleted once nothing holds them; one still held is left for a later
 * run.
 *
 * Elsewhere a mapped file can be replaced, so nothing collides and nothing is done.
 */
export function freeLibraryCopies(
  projectPath: string,
  platform: NodeJS.Platform = process.platform,
): FreedCopies {
  const setAside: string[] = [];
  const swept: string[] = [];
  if (platform !== 'win32') {
    return { setAside, swept };
  }
  for (const library of windowsLibraries(projectPath)) {
    const folder = dirname(library);
    const copy = `~${basename(library)}`;
    if (existsSync(join(folder, copy))) {
      const aside = join(folder, `${copy}.aside-${process.pid}-${Date.now()}`);
      try {
        renameSync(join(folder, copy), aside);
        setAside.push(aside);
      } catch {
        // Not checked further: the engine says "Error copying library" if it still cannot copy,
        // and the answer reads that.
      }
    }
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      // The copy set aside a moment ago included: an engine that has let it go since is done with it.
      if (name.length > copy.length && name.toLowerCase().startsWith(copy.toLowerCase())) {
        try {
          unlinkSync(join(folder, name));
          swept.push(join(folder, name));
        } catch {
          // Still mapped by the engine that made it, which is the one case left for a later run.
        }
      }
    }
  }
  return { setAside, swept };
}

/**
 * Writes `.godot/extension_list.cfg` for a project that has none, naming every `.gdextension`
 * manifest in it, and answers the `res://` paths written, or null when the list was there already.
 *
 * The engine loads the extensions that list names as it starts, and the list is written by the
 * scan of an editor-mode run, after that. On a fresh clone the first import therefore ran with no
 * extension loaded, so every script
 * using a class an extension adds failed to compile in it, and the class cache it wrote left
 * those scripts out. Walked past names starting with a dot and folders holding a `.gdignore`, as
 * the editor's scan walks.
 */
export function seedExtensionList(projectPath: string): string[] | null {
  const list = join(projectPath, '.godot', 'extension_list.cfg');
  if (existsSync(list)) {
    return null;
  }
  const found = unlistedExtensions(projectPath);
  if (found.length === 0) {
    return [];
  }
  mkdirSync(dirname(list), { recursive: true });
  writeFileSync(list, `${found.join('\n')}\n`);
  return found;
}

/**
 * The `res://` paths of every `.gdextension` manifest in the project when it has no
 * `.godot/extension_list.cfg`, sorted, or none when it has one: the engine loads only what the list
 * names, so without it none of them.
 */
export function unlistedExtensions(projectPath: string): string[] {
  if (existsSync(join(projectPath, '.godot', 'extension_list.cfg'))) {
    return [];
  }
  const found: string[] = [];
  const visit = (directory: string, resDirectory: string): void => {
    if (existsSync(join(directory, '.gdignore'))) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      if (entry.isDirectory()) {
        visit(join(directory, entry.name), `${resDirectory}${entry.name}/`);
      } else if (entry.name.endsWith('.gdextension')) {
        found.push(`${resDirectory}${entry.name}`);
      }
    }
  };
  visit(projectPath, 'res://');
  return found.sort();
}

/**
 * Every Windows library the project's extensions name, as absolute paths, read off the manifests
 * `.godot/extension_list.cfg` lists. A project no editor has opened has no list and no copies.
 */
function windowsLibraries(projectPath: string): string[] {
  const listed = readOrNull(join(projectPath, '.godot', 'extension_list.cfg'));
  if (listed === null) {
    return [];
  }
  const libraries = new Set<string>();
  for (const line of listed.split(/\r?\n/)) {
    const manifest = resolveResource(projectPath, projectPath, line.trim());
    const text = manifest === null ? null : readOrNull(manifest);
    if (manifest === null || text === null) {
      continue;
    }
    let inLibraries = false;
    for (const row of text.split(/\r?\n/)) {
      const section = /^\s*\[([^\]]+)\]/.exec(row)?.[1];
      if (section !== undefined) {
        inLibraries = section.trim() === 'libraries';
        continue;
      }
      const named = inLibraries ? /^\s*windows[\w.]*\s*=\s*"([^"]+)"/.exec(row)?.[1] : undefined;
      // A path without res:// is the engine's to read beside the manifest.
      const library = named === undefined ? null : resolveResource(projectPath, dirname(manifest), named);
      if (library !== null) {
        libraries.add(library);
      }
    }
  }
  return [...libraries];
}

function resolveResource(projectPath: string, relativeTo: string, path: string): string | null {
  if (path === '') {
    return null;
  }
  if (path.startsWith('res://')) {
    return join(projectPath, path.slice('res://'.length));
  }
  return isAbsolute(path) ? path : join(relativeTo, path);
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
