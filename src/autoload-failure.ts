/**
 * An autoload that did not compile, read off a test run's log as it fills.
 *
 * The engine goes on after an autoload's script fails to compile, and so does gdUnit4: every suite
 * then runs with that autoload missing and every class that failed with it. A case calling into
 * one of those fails the same way on every pass, and a loop that waits for the call to succeed
 * prints the same script error until the run is killed. Game B's stepped suite printed one four
 * thousand times in thirty seconds and was called still running at its timeout. A run against
 * autoloads that did not compile answers nothing about the code, the way gdUnit4 itself runs no
 * suite when one fails to load.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LogEntry } from './game-log.js';
import { parseProjectGodot } from './resources.js';
import { autoloadPaths } from './setup.js';

/**
 * The scripts the project's autoloads load as the engine starts, each with the autoload's name:
 * an autoload's own script, or the scripts its scene names.
 */
export function scriptsAutoloaded(projectPath: string): Map<string, string> {
  const scripts = new Map<string, string>();
  let settings: Record<string, Record<string, unknown>>;
  try {
    settings = parseProjectGodot(readFileSync(join(projectPath, 'project.godot'), 'utf8'));
  } catch {
    return scripts;
  }
  for (const [name, path] of autoloadPaths(settings)) {
    if (!path.endsWith('.tscn')) {
      scripts.set(`res://${path}`, name);
      continue;
    }
    const scene = join(projectPath, path);
    if (!existsSync(scene)) {
      continue;
    }
    try {
      for (const named of readFileSync(scene, 'utf8').matchAll(
        /^\[ext_resource\b[^\]]*\btype="Script"[^\]]*\bpath="(res:\/\/[^"]+)"/gm,
      )) {
        scripts.set(named[1] ?? '', name);
      }
    } catch {
      // A scene that cannot be read names no script here, and the engine says why it did not load.
    }
  }
  return scripts;
}

const NOT_COMPILED = /^Failed to load script "(res:\/\/[^"]+)" with error "Compilation failed"/;

/** The autoload [param entry] says did not compile, by name and script, or null. */
export function autoloadNotCompiled(
  entry: LogEntry,
  autoloaded: ReadonlyMap<string, string>,
): { name: string; path: string } | null {
  const path = NOT_COMPILED.exec(entry.text)?.[1];
  const name = path === undefined ? undefined : autoloaded.get(path);
  return path === undefined || name === undefined ? null : { name, path };
}
