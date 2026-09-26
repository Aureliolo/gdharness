import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Makes the engine's next import pass reimport `resourcePath` (a `res://` path), whatever it would
 * judge of it.
 *
 * The pass looks closer at a resource only when its sidecar's time differs from the one the editor
 * cached, and file times count whole seconds, so a sidecar rewritten in the second of its import
 * would be passed over: its time is moved on explicitly. The closer look reimports a resource with
 * no record of its import's hashes, so the record goes; and it stops at `valid=false` before
 * reaching the record, which keeps a failed import from being tried again, so that line goes too.
 * The import rewrites the sidecar and the record whole.
 */
export function forceNextImport(projectPath: string, resourcePath: string): void {
  const relative = resourcePath.replace(/^res:\/\//, '');
  const sidecar = join(projectPath, `${relative}.import`);
  // Never imported, which the pass imports on its own.
  if (!existsSync(sidecar)) {
    return;
  }
  const { atime, mtimeMs } = statSync(sidecar);
  writeFileSync(sidecar, readFileSync(sidecar, 'utf8').replace(/^valid=false\r?\n/m, ''));
  utimesSync(sidecar, atime, new Date(mtimeMs + 2000));
  rmSync(importRecord(projectPath, resourcePath), { force: true });
}

/** Where the editor records the hashes of `resourcePath`'s last import. */
function importRecord(projectPath: string, resourcePath: string): string {
  const digest = createHash('md5').update(resourcePath).digest('hex');
  return join(projectPath, '.godot', 'imported', `${basename(resourcePath)}-${digest}.md5`);
}
