import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Paths that arrive as tool arguments and are then opened, written, or handed to Godot.
 *
 * Two kinds arrive, and they want opposite treatment. `projectPath` and `directory` name the
 * project or the search root this server was pointed at, so any absolute path is legitimate:
 * choosing it is the whole point of the argument, and there is no outer directory for it to sit
 * inside. Everything else (`resourcePath`, `scenePath`, `scriptPath`, `newPath`, `outputPath`,
 * a plugin's directory) is documented as a location inside that project, and is read as one: the
 * operations script prefixes `res://` and opens it, the export path is a destination the engine
 * writes to. A value that lands outside the project is one the caller has no claim on.
 *
 * A substring test for `..` is not that check. It refuses ordinary names such as
 * `archive..old.gd`, and it says nothing about the forms that spell no traversal at all:
 * `C:\Windows\win.ini`, `D:\other\payload`, `\\server\share\payload` and `/etc/passwd` contain
 * no `..` anywhere. What holds is to resolve the candidate against the project root and ask
 * `relative` where it landed, because that is the arithmetic the filesystem itself will do.
 * On Windows it also settles what a text comparison gets wrong: another drive letter and a UNC
 * path both come back absolute, `C:name` is relative to whatever the process has as its current
 * directory on that drive, and `C:\game-old` is not inside `C:\game` despite starting with it.
 *
 * Symlinks are not followed. The candidate is often a file that does not exist yet, such as a
 * script about to be created, and `realpath` has no answer for those. Where the file must
 * already exist and the boundary has to hold against a link out of the project, resolve the real
 * path first and hand that in, which is what the LSP tools do.
 */

/** How Godot spells the project root. Callers pass paths with and without it. */
const RESOURCE_SCHEME = 'res://';

/**
 * Anything else of the form `scheme://`. Two or more characters before the colon, so that a
 * Windows path written `C://Windows` is judged as the absolute path it is rather than reported
 * as an unknown scheme.
 */
const OTHER_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]+:\/\//;

export type Containment =
  | {
      readonly ok: true;
      /** Absolute, for this process to open. */
      readonly absolutePath: string;
      /** The same file as the project names it: forward slashes, no leading separator. */
      readonly relativePath: string;
    }
  | { readonly ok: false; readonly reason: string };

/** The path with every symlink on it resolved, or the path itself when there is nothing there. */
export function realPathOr(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * Whether two paths name the same directory.
 *
 * The same arithmetic as the containment test rather than a string comparison, and for the same
 * reasons: one side arrives from Godot as `C:/Users/x/game/` and the other from the config as
 * `C:\Users\x\game`, so separators, a trailing separator and the case of a Windows path all differ
 * between two spellings of one directory. `relative` settles every one of them and answers the
 * empty string when there is no step between them.
 *
 * Symlinks are resolved first, unlike everywhere else in this file, because both sides name a
 * directory that exists: a macOS temporary directory is reached as `/var/folders` and reported by
 * the engine as `/private/var/folders`, and the two are one directory. A path with nothing there
 * is compared as written, which is the old arithmetic and the right answer for it.
 *
 * Containment is the wrong question here. A project inside another project is a different project,
 * and this is asked where the answer decides whether two sides belong together.
 */
export function isSameDirectory(onePath: string, otherPath: string): boolean {
  return relative(realPathOr(resolve(onePath)), realPathOr(resolve(otherPath))) === '';
}

/** Whether `candidatePath` is `rootPath` or sits underneath it. */
export function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const step = relative(resolve(rootPath), resolve(candidatePath));

  // `..` on its own and `..` followed by a separator climb out; a name that merely begins with
  // two dots, such as `..config`, does not. An absolute answer means another drive or share.
  return step !== '..' && !step.startsWith(`..${sep}`) && !isAbsolute(step);
}

/**
 * A caller-supplied path read as a location inside the project.
 *
 * Both spellings of the same file are accepted, `res://scenes/main.tscn` and
 * `scenes/main.tscn`. Anything absolute is refused, a leading `/` or `\` included.
 *
 * Reading a leading `/` as the project root was tried and is worse on both counts. It makes
 * `/etc/passwd` quietly succeed as `<project>/etc/passwd`, when a caller who wrote that meant
 * something this must not do, and it answers differently per platform: `/x` is absolute to
 * node:path on POSIX and `\x` is absolute on Windows, so the same argument would be judged by
 * which machine read it. A boundary check has to give one answer everywhere.
 *
 * The one caller that legitimately holds a leading slash is the `godot://` URI reader, where
 * `URL` put it there. It strips it itself, being the only place that knows the string is a URL
 * pathname rather than something a caller typed.
 */
export function resolveWithinProject(projectPath: string, candidatePath: string): Containment {
  const trimmed = candidatePath.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'Path is empty.' };
  }

  // Node throws on a null byte at the point of use rather than where it arrived, and no path
  // worth serving contains one.
  if (trimmed.includes('\0')) {
    return { ok: false, reason: 'Path contains a null byte.' };
  }

  const withoutScheme = trimmed.startsWith(RESOURCE_SCHEME) ? trimmed.slice(RESOURCE_SCHEME.length) : trimmed;

  const scheme = OTHER_SCHEME.exec(withoutScheme);
  if (scheme) {
    return {
      ok: false,
      reason: `Path '${trimmed}' uses the '${scheme[0]}' scheme, which names somewhere other than this project.`,
    };
  }

  // Refused here rather than left to the containment check below, which would accept a leading
  // separator on the platform where node:path does not read it as absolute.
  if (withoutScheme.startsWith('/') || withoutScheme.startsWith('\\') || isAbsolute(withoutScheme)) {
    return {
      ok: false,
      reason: `Path '${trimmed}' is absolute; give a path inside the project, such as 'scenes/main.tscn'.`,
    };
  }

  // Windows reads a colon as a drive (`C:name` is relative to that drive's current directory,
  // which node:path resolves against the project instead) or as an alternate data stream
  // (`script.gd:hidden` writes beside the file where nothing lists it), and Godot refuses one in
  // any resource path, so nothing inside a project is ever spelled with it on any platform.
  if (withoutScheme.includes(':')) {
    return {
      ok: false,
      reason: `Path '${trimmed}' contains ':', which no file inside a project is named with.`,
    };
  }

  const root = resolve(projectPath);
  const absolutePath = resolve(root, withoutScheme);

  if (!isWithinRoot(root, absolutePath)) {
    return { ok: false, reason: `Path '${trimmed}' resolves outside the project directory.` };
  }

  const relativePath = relative(root, absolutePath).split(sep).join('/');
  if (relativePath === '') {
    return { ok: false, reason: `Path '${trimmed}' is the project directory itself, not a file in it.` };
  }

  return { ok: true, absolutePath, relativePath };
}
