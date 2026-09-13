/**
 * Where the engine is. GODOT_PATH when it is set, else the first conventional location that
 * answers `--version`; nothing is guessed, because a guessed path is a tool that fails later
 * with a message about the wrong thing.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { normalize } from 'node:path';
import { promisify } from 'node:util';
import { godotCandidates, resolveHomeDirectory } from './detection.js';
import { envValue } from './launch.js';

const run = promisify(execFile);

export class GodotLocator {
  private readonly answered = new Map<string, boolean>();
  private found: string | null = null;

  /** The engine, or null when neither GODOT_PATH nor any conventional location has one. */
  async find(): Promise<string | null> {
    if (this.found !== null && (await this.answers(this.found))) {
      return this.found;
    }
    this.found = null;

    const named = envValue('GODOT_PATH');
    if (named !== undefined) {
      const path = normalize(named);
      if (await this.answers(path)) {
        this.found = path;
      }
      // A GODOT_PATH that does not answer is a configuration to fix, not a reason to go looking
      // elsewhere and run some other engine in silence.
      return this.found;
    }

    for (const candidate of godotCandidates(process.platform, resolveHomeDirectory())) {
      const path = normalize(candidate);
      if (await this.answers(path)) {
        this.found = path;
        return path;
      }
    }
    return null;
  }

  /** What to tell a caller when no engine was found. */
  static readonly ADVICE = [
    'Set GODOT_PATH to the Godot 4 executable',
    'Or install Godot where it is usually found, such as /usr/bin/godot or C:\\Program Files\\Godot',
  ];

  private async answers(path: string): Promise<boolean> {
    const known = this.answered.get(path);
    if (known !== undefined) {
      return known;
    }
    let ok = false;
    if (path === 'godot' || existsSync(path)) {
      try {
        await run(path, ['--version']);
        ok = true;
      } catch {
        ok = false;
      }
    }
    this.answered.set(path, ok);
    return ok;
  }
}
