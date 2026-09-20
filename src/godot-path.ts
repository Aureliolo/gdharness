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
import { errorMessage } from './errors.js';
import { envValue } from './launch.js';

const run = promisify(execFile);

/**
 * The engine, or why there is none, which is two answers and not one.
 *
 * A GODOT_PATH that names something which does not answer is a configuration to fix, and nothing
 * else on the machine is consulted, because running some other engine in silence would be worse.
 * Nothing set and nothing found is a machine with no engine on it. Both used to arrive as null and
 * so as one sentence, "No Godot executable found. Set GODOT_PATH", which told somebody who had set
 * it to set it, and never named the path they had set or what was wrong with it.
 */
export type Located =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly named: string; readonly reason: string }
  | { readonly ok: false; readonly named: null };

export class GodotLocator {
  /** Why a path does not answer, or null for one that does. */
  private readonly answered = new Map<string, string | null>();
  private found: string | null = null;

  async find(): Promise<Located> {
    if (this.found !== null && (await this.whyNot(this.found)) === null) {
      return { ok: true, path: this.found };
    }
    this.found = null;

    const named = envValue('GODOT_PATH');
    if (named !== undefined) {
      const path = normalize(named);
      const reason = await this.whyNot(path);
      if (reason === null) {
        this.found = path;
        return { ok: true, path };
      }
      return { ok: false, named: path, reason };
    }

    for (const candidate of godotCandidates(process.platform, resolveHomeDirectory())) {
      const path = normalize(candidate);
      if ((await this.whyNot(path)) === null) {
        this.found = path;
        return { ok: true, path };
      }
    }
    return { ok: false, named: null };
  }

  /** The sentence for a locator that found nothing, and what to do about it. */
  static refusal(located: { readonly ok: false; readonly named: string | null; readonly reason?: string }): {
    readonly message: string;
    readonly advice: readonly string[];
  } {
    if (located.named === null) {
      return {
        message: 'No Godot executable found.',
        advice: [
          'Set GODOT_PATH to the Godot 4 executable',
          'Or install Godot where it is usually found, such as /usr/bin/godot or C:\\Program Files\\Godot',
        ],
      };
    }
    return {
      message: `GODOT_PATH is set to ${located.named}, which ${located.reason ?? 'does not answer'}.`,
      advice: [
        'Point GODOT_PATH at a Godot 4 executable that answers --version',
        'Or unset it, and the usual install locations are searched instead',
      ],
    };
  }

  /** Why [param path] is not an engine that answers, or null because it is. */
  private async whyNot(path: string): Promise<string | null> {
    const known = this.answered.get(path);
    if (known !== undefined) {
      return known;
    }
    let reason: string | null;
    if (path !== 'godot' && !existsSync(path)) {
      reason = 'does not exist';
    } else {
      try {
        await run(path, ['--version']);
        reason = null;
      } catch (error) {
        reason = `does not answer --version: ${errorMessage(error)}`;
      }
    }
    this.answered.set(path, reason);
    return reason;
  }
}
