import { cpSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A copy of the engine at [param godotPath] in [param home], marked self-contained, so it keeps its
 * editor data, export templates included, in `home/editor_data` rather than in the user's. Answers
 * the copy's executable.
 *
 * A macOS engine is copied as its whole bundle and marked beside it, which is where an editor whose
 * bundle is read-only looks for the marker. The Windows console executable is copied with the one
 * it starts, the same name without the suffix.
 */
export function containedEngine(godotPath: string, home: string): string {
  const bundle = /^(.*\.app)[\\/]Contents[\\/]MacOS[\\/][^\\/]+$/.exec(godotPath)?.[1];
  let engine: string;
  if (bundle !== undefined) {
    const copied = join(home, 'Godot.app');
    cpSync(bundle, copied, { recursive: true });
    engine = join(copied, godotPath.slice(bundle.length));
  } else {
    engine = join(home, godotPath.split(/[\\/]/).pop() ?? 'godot');
    cpSync(godotPath, engine);
    const windowed = godotPath.replace(/_console(\.exe)$/i, '$1');
    if (windowed !== godotPath && existsSync(windowed)) {
      cpSync(windowed, join(home, windowed.split(/[\\/]/).pop() ?? 'godot.exe'));
    }
  }
  writeFileSync(join(home, '._sc_'), '');
  return engine;
}
