import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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

type Containment =
  | {
      readonly ok: true;
      /** Absolute, for this process to open. */
      readonly absolutePath: string;
      /** The same file as the project names it: forward slashes, no leading separator. */
      readonly relativePath: string;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * [param path] with the links in whatever part of it exists resolved, and the rest as written.
 *
 * Resolved only when the whole path exists, a key changes when a file comes or goes wherever the
 * path runs through a link (a macOS temporary directory under `/var`, an 8.3 short name on
 * Windows). A server creates its project's `.godot` as it starts, so a run note written for the
 * project before that and one read after it named two files. And a breakpoint set on a script is
 * held under the script's real path, so once the script was deleted a remove looked it up under
 * the spelling given and answered that nothing was held while listing it as held.
 */
export function realAsFarAsItExists(path: string): string {
  const missing: string[] = [];
  let at = path;
  for (;;) {
    try {
      return join(realpathSync.native(at), ...missing);
    } catch {
      const parent = dirname(at);
      if (parent === at) {
        return path;
      }
      missing.unshift(basename(at));
      at = parent;
    }
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
 * the engine as `/private/var/folders`, and the two are one directory. Whatever part of a path is
 * not there is compared as written.
 *
 * Containment is the wrong question here. A project inside another project is a different project,
 * and this is asked where the answer decides whether two sides belong together.
 */
export function isSameDirectory(onePath: string, otherPath: string): boolean {
  // An empty path names no directory, though resolve() would read it as the working directory.
  if (onePath === '' || otherPath === '') {
    return false;
  }
  return relative(realAsFarAsItExists(resolve(onePath)), realAsFarAsItExists(resolve(otherPath))) === '';
}

/**
 * [param candidatePath] relative to [param rootPath] with forward slashes, empty for the root
 * itself, or null when it is not underneath it.
 */
export function relativeWithin(rootPath: string, candidatePath: string): string | null {
  const step = relative(resolve(rootPath), resolve(candidatePath));

  // `..` on its own and `..` followed by a separator climb out. A name that merely begins with
  // two dots, such as `..config`, does not. An absolute answer means another drive or share.
  if (step === '..' || step.startsWith(`..${sep}`) || isAbsolute(step)) {
    return null;
  }
  return step.split(sep).join('/');
}

/** Whether `candidatePath` is `rootPath` or sits underneath it. */
export function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  return relativeWithin(rootPath, candidatePath) !== null;
}

/** The id Godot gives a resource kept inside a scene or resource file, as written after `::`. */
const KEPT_ID = /^[A-Za-z0-9_]+$/;

/**
 * A path naming a resource kept inside a file, as a read answers a property holding one
 * (`res://hero.tscn::Animation_jump`): the file and the id. A path naming a file has no id.
 */
export function keptInside(given: string): { file: string; inner: string | undefined } {
  const at = given.indexOf('::');
  const inner = at === -1 ? '' : given.slice(at + 2);
  return KEPT_ID.test(inner) ? { file: given.slice(0, at), inner } : { file: given, inner: undefined };
}

/**
 * Why [param projectPath] holds no Godot project, as the end of a sentence naming it, or null when
 * it holds one. A project is a project.godot file. A folder of that name is not one, and every read
 * of it as the project's settings fails.
 */
export function notAGodotProject(projectPath: string): string | null {
  let found: ReturnType<typeof statSync>;
  try {
    found = statSync(join(projectPath, 'project.godot'), { throwIfNoEntry: false });
  } catch (error) {
    return `has a project.godot that cannot be read (${error instanceof Error ? error.message : String(error)})`;
  }
  if (found === undefined) {
    return 'holds no project.godot';
  }
  return found.isFile() ? null : 'holds a folder named project.godot where the project file belongs';
}

/** Whether [param projectPath] holds a Godot project. */
export function isGodotProject(projectPath: string): boolean {
  return notAGodotProject(projectPath) === null;
}

/** The refusal for a command run on [param projectPath], or null when it holds a Godot project. */
export function commandProjectRefusal(projectPath: string): string | null {
  const why = notAGodotProject(projectPath);
  return why === null
    ? null
    : `Not a Godot project: ${projectPath} ${why}. Run from the project directory, or name it on the command line.`;
}

/**
 * Whether [param path] is a file on this machine's own disks. A network path is not asked about,
 * since a share that does not answer holds the call for as long as the network takes to give up.
 */
function isLocalFile(path: string): boolean {
  if (/^[\\/]{2}/.test(path)) {
    return false;
  }
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/**
 * [param candidate], an absolute path, as a project-relative path with forward slashes, or null when
 * it is not one inside [param root]. Judged as written first. A spelling that is text-wise elsewhere
 * is judged again with the links in both resolved, since a `\\?\` prefix, a Windows short name or a
 * linked folder above the project each name a file of the project that the text does not show.
 */
function insideProject(root: string, candidate: string): string | null {
  if (!isAbsolute(candidate)) {
    return null;
  }
  return (
    relativeWithin(root, candidate) ??
    relativeWithin(realAsFarAsItExists(root), realAsFarAsItExists(resolve(candidate)))
  );
}

/** Why a path starting with the scheme [param scheme] is refused. */
function otherSchemeReason(trimmed: string, scheme: string): string {
  // Said for user:// above all, which is where a game writes its saves and settings: a caller
  // checking what one wrote had nothing to go on.
  const elsewhere =
    scheme.toLowerCase() === 'user://'
      ? " A game's user:// is a directory of its own outside the project: a running game's is under userDir in editor_status runtimes and in editor_run start's runtime, where a file reader of your own reads it."
      : '';
  return `Path '${trimmed}' uses the '${scheme}' scheme, which names somewhere other than this project.${elsewhere}`;
}

/** Why an absolute path is refused, with an example of a path that would be taken. */
function absolutePathReason(trimmed: string, withoutScheme: string, root: string): string {
  // A file that is there is one the caller meant, such as a game's save under its user://, so an
  // example made of its path's end names a project file that is not.
  if (isAbsolute(trimmed) && isLocalFile(trimmed)) {
    return `Path '${trimmed}' names a file outside the project, and only paths inside it are taken here. Read that file with a file reader of your own, or give a path inside the project.`;
  }
  // The example is the end of the path given, so a build output is offered a build path and a
  // scene a scene path. A fixed scene path was offered for an export's .exe.
  // A file beside the project or above it keeps only its name: its folder holds the project, so
  // offered as one inside it, it names a folder the project does not have. Compared with the links
  // in both resolved: a macOS temporary directory given under /var holds a project under /private/var.
  const tail = withoutScheme.split(/[\\/]+/).filter((step) => step !== '' && !step.endsWith(':'));
  const besideIt =
    isAbsolute(trimmed) &&
    isWithinRoot(realAsFarAsItExists(dirname(resolve(trimmed))), realAsFarAsItExists(root));
  const example = tail.slice(besideIt ? -1 : -2).join('/') || 'scenes/main.tscn';
  return `Path '${trimmed}' is absolute and outside the project. Give a path inside it, such as '${example}'.`;
}

/** Why a UID or another scheme's path is refused, or null when [param withoutScheme] is neither. */
function schemeRefusal(trimmed: string, withoutScheme: string): string | null {
  // A UID names a file in this project, and where it is on disk is known only to the engine that
  // resolves it, so containment, which is a question about where, cannot be answered for one here.
  if (withoutScheme.startsWith('uid://')) {
    return `Path '${trimmed}' is a UID, and a file is judged here by where it is on disk, which a UID does not say. Give the file's res:// path.`;
  }
  const scheme = OTHER_SCHEME.exec(withoutScheme);
  return scheme ? otherSchemeReason(trimmed, scheme[0]) : null;
}

/** Why a path with a colon is refused, or null when [param withoutScheme] has none. */
function colonRefusal(trimmed: string, withoutScheme: string): string | null {
  // Windows reads a colon as a drive (`C:name` is relative to that drive's current directory,
  // which node:path resolves against the project instead) or as an alternate data stream
  // (`script.gd:hidden` writes beside the file where nothing lists it), and Godot refuses one in
  // any resource path, so nothing inside a project is ever spelled with it on any platform.
  const kept = keptInside(trimmed);
  if (kept.inner !== undefined) {
    return `Path '${trimmed}' names the resource ${kept.inner} kept inside ${kept.file}, not a file. resource_edit read reads one by that path, and this argument takes a file.`;
  }
  return withoutScheme.includes(':')
    ? `Path '${trimmed}' contains ':', which no file inside a project is named with.`
    : null;
}

/**
 * A caller-supplied path read as a location inside the project.
 *
 * Both spellings of the same file are accepted, `res://scenes/main.tscn` and
 * `scenes/main.tscn`, and so is the file's absolute path when it is inside the project, which a
 * caller holding the project's path writes naturally and which was refused with "give a path
 * inside the project" while being one. Any other absolute path is refused, a leading `/` or `\`
 * included.
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
 *
 * The project directory itself is refused unless [param options] allows it, for a caller asking
 * about a folder, where the whole project is one: "res://" given to such a caller was refused as
 * not a file while every folder inside it was taken.
 */
export function resolveWithinProject(
  projectPath: string,
  candidatePath: string,
  options: { root?: boolean } = {},
): Containment {
  const trimmed = candidatePath.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'Path is empty.' };
  }

  // Node throws on a null byte at the point of use rather than where it arrived, and no path
  // worth serving contains one.
  if (trimmed.includes('\0')) {
    return { ok: false, reason: 'Path contains a null byte.' };
  }

  const root = resolve(projectPath);
  // Made relative before anything else reads it, since a Windows path's drive colon is refused
  // below as the stream marker it would otherwise be.
  const withoutScheme = trimmed.startsWith(RESOURCE_SCHEME)
    ? trimmed.slice(RESOURCE_SCHEME.length)
    : (insideProject(root, trimmed) ?? trimmed);

  const schemeReason = schemeRefusal(trimmed, withoutScheme);
  if (schemeReason !== null) {
    return { ok: false, reason: schemeReason };
  }

  // Refused here rather than left to the containment check below, which would accept a leading
  // separator on the platform where node:path does not read it as absolute.
  if (withoutScheme.startsWith('/') || withoutScheme.startsWith('\\') || isAbsolute(withoutScheme)) {
    return { ok: false, reason: absolutePathReason(trimmed, withoutScheme, root) };
  }

  const colonReason = colonRefusal(trimmed, withoutScheme);
  if (colonReason !== null) {
    return { ok: false, reason: colonReason };
  }

  const absolutePath = resolve(root, withoutScheme);

  if (!isWithinRoot(root, absolutePath)) {
    return { ok: false, reason: `Path '${trimmed}' resolves outside the project directory.` };
  }

  const relativePath = relative(root, absolutePath).split(sep).join('/');
  if (relativePath === '' && options.root !== true) {
    return { ok: false, reason: `Path '${trimmed}' is the project directory itself, not a file in it.` };
  }

  return { ok: true, absolutePath, relativePath };
}

/**
 * An exported build to start, which must already be a file inside the project, judged by where it
 * really is. Followed through links because this is a file this server will run: a link inside the
 * project pointing at any program on the machine would otherwise be started as the game.
 */
export function exportedBuild(projectPath: string, candidatePath: string): Containment {
  const found = resolveWithinProject(projectPath, candidatePath);
  if (!found.ok) {
    return found;
  }
  let real: string;
  try {
    real = realpathSync.native(found.absolutePath);
  } catch {
    return {
      ok: false,
      reason: `There is no ${found.relativePath} in the project to start: export the build first, with project_export run.`,
    };
  }
  if (!isWithinRoot(realAsFarAsItExists(projectPath), real)) {
    return {
      ok: false,
      reason: `${found.relativePath} leads outside the project, to ${real}, so it is not started.`,
    };
  }
  if (!statSync(real).isFile()) {
    return { ok: false, reason: `${found.relativePath} is not a file, so there is nothing to start.` };
  }
  return { ok: true, absolutePath: real, relativePath: found.relativePath };
}
