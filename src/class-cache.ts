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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Every `class_name` declared under the project, with the script that declares it. */
function declaredClasses(projectPath: string): Map<string, string> {
  const declared = new Map<string, string>();
  const visit = (directory: string, prefix: string): void => {
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
