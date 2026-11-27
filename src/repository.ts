import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { realAsFarAsItExists } from './paths.js';

/** The checkout holding a folder, and the `.git` it shares with every other checkout of its repository. */
export interface GitCheckout {
  /** The first folder at or above the start that holds `.git`. */
  readonly top: string;
  /** The shared `.git` folder: the checkout's own, or the main repository's for a linked worktree. */
  readonly common: string;
  /** Whether the checkout is a linked worktree, whose `.git` is a file. */
  readonly linked: boolean;
  /**
   * Whether `.git` is a file pointing at a git folder of the checkout's own, made with
   * `--separate-git-dir`, which has no `commondir`: [member common] is that folder.
   */
  readonly separate?: true;
}

/** The first folder at or above [param start] that holds `.git`, or null when none does. */
export function gitTopOf(start: string): string | null {
  let top = resolve(start);
  while (!existsSync(join(top, '.git'))) {
    const up = dirname(top);
    if (up === top) {
      return null;
    }
    top = up;
  }
  return top;
}

/**
 * The checkout that holds [param start], or null when none does or its `.git` cannot be followed.
 *
 * A linked worktree's `.git` is a file pointing at its entry under the main repository's `.git`
 * (`gitdir:`, absolute or relative to the worktree), and that entry's `commondir` points at the main
 * `.git` itself. A `.git` file that cannot be read throws.
 */
export function gitCheckoutOf(start: string): GitCheckout | null {
  const top = gitTopOf(start);
  if (top === null) {
    return null;
  }
  const marker = join(top, '.git');
  if (statSync(marker).isDirectory()) {
    return { top, common: marker, linked: false };
  }
  const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(marker, 'utf8'))?.[1]?.trim();
  if (pointer === undefined) {
    return null;
  }
  const entry = resolve(top, pointer);
  const commonFile = join(entry, 'commondir');
  if (!existsSync(commonFile)) {
    return { top, common: entry, linked: true, separate: true };
  }
  return { top, common: resolve(entry, readFileSync(commonFile, 'utf8').trim()), linked: true };
}

/**
 * The name of the repository that holds [param start]: the folder holding the shared `.git`, so a
 * worktree has its repository's name. The path is resolved first, as the machine's other tools
 * resolve it, so another spelling or a link reaches the same name. Null where none holds it, the
 * shared folder is no `.git` (a bare repository has no checkout of its own) or it cannot be read.
 */
export function repositoryNameOf(start: string): string | null {
  try {
    const found = gitCheckoutOf(realAsFarAsItExists(resolve(start)));
    if (found === null) {
      return null;
    }
    const common = realAsFarAsItExists(found.common);
    return basename(common) === '.git' ? basename(dirname(common)) : null;
  } catch {
    return null;
  }
}
