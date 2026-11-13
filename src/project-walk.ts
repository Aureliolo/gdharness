/**
 * One walk of a project's folders, in the engine's scan rule and order: what a reader of the project
 * lists, counts or searches comes from here, so that no two readers disagree about what is in it.
 */

import { type Dirent, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileNoCaseCompare } from './file-order.js';
import { bytesOf, entriesOf, statOf } from './listed-reads.js';
import { isGodotProject, realAsFarAsItExists, relativeWithin } from './paths.js';

/** Written into each addon gdharness installs, so it can be told from one the project wrote. */
export const VERSION_MARKER = '.gdharness-version';

/** A folder the walk left out, and why. */
export interface LeftOut {
  /** Relative to what the call was asked about, with forward slashes. Empty for that folder itself. */
  readonly folder: string;
  readonly why: 'gdignore' | 'project' | 'gdharness' | 'link' | 'outside';
}

/** A file of a walked folder. */
export interface WalkedFile {
  readonly name: string;
  /** The folder's real path with the name, or a file link's target. */
  readonly real: string;
  /** Whether another path of the walk stands for this file, so that a reader counts it once. */
  readonly twin: boolean;
}

export interface WalkedFolder {
  readonly path: string;
  /** Relative to the start with forward slashes, empty for the start. */
  readonly folder: string;
  readonly files: readonly WalkedFile[];
}

export interface ProjectWalk {
  readonly folders: Iterable<WalkedFolder>;
  /** Whole once `folders` has been read to its end. */
  readonly leftOut: readonly LeftOut[];
}

export interface WalkOptions {
  /** Walk gdharness's own addons too, as the engine scans them. */
  readonly withOurs?: boolean;
  /** The scan's order, reversed. */
  readonly reversed?: boolean;
  /** The project: a link whose real place lies outside it is not entered. */
  readonly inside?: string;
}

type Rule = 'gdignore' | 'project' | 'gdharness';

/** What [param entry] of [param directory] is, a link taken as what it points at. */
function kindOf(directory: string, entry: Dirent): 'directory' | 'file' | 'other' {
  if (entry.isDirectory()) {
    return 'directory';
  }
  if (entry.isFile()) {
    return 'file';
  }
  if (!entry.isSymbolicLink()) {
    return 'other';
  }
  try {
    const target = statSync(join(directory, entry.name));
    return target.isDirectory() ? 'directory' : target.isFile() ? 'file' : 'other';
  } catch {
    return 'other';
  }
}

/** Whether [param file] is a file, as `statSync` reads it: a folder of the name is none. */
function isFileAt(file: string): boolean {
  try {
    return statOf(file)?.isFile() === true;
  } catch {
    return false;
  }
}

/** Why the scan leaves [param folder] out, or null. gdharness's addons count unless [param withOurs]. */
function ruleOf(folder: string, withOurs: boolean): Rule | null {
  if (isFileAt(join(folder, '.gdignore'))) {
    return 'gdignore';
  }
  if (isGodotProject(folder)) {
    return 'project';
  }
  return !withOurs && existsSync(join(folder, VERSION_MARKER)) ? 'gdharness' : null;
}

const HIDDEN_DATA_OFF = /^[ \t]*config\/use_hidden_project_data_directory[ \t]*=[ \t]*false[ \t]*$/m;

/** Whether the project data folder is `godot`, which its settings choose over the hidden `.godot`. */
function dataFolderIsVisible(projectPath: string): boolean {
  const settings = bytesOf(join(projectPath, 'project.godot'));
  return settings !== null && HIDDEN_DATA_OFF.test(settings.toString('utf8').replaceAll('\r', ''));
}

/**
 * The topmost folder on [param relativePath] below [param projectPath], the path itself included,
 * that the scan leaves out and names. Null for the project's own folder.
 */
export function leftOutAt(projectPath: string, relativePath: string): LeftOut | null {
  return leftOutsOnPath(projectPath, relativePath)[0] ?? null;
}

/** Each folder on [param relativePath] that the scan leaves out and names, topmost first. */
export function leftOutsOnPath(projectPath: string, relativePath: string): LeftOut[] {
  const steps = relativePath.split('/').filter((step) => step !== '');
  const visibleData = dataFolderIsVisible(projectPath);
  const found: LeftOut[] = [];
  let at = projectPath;
  for (const [index, step] of steps.entries()) {
    at = join(at, step);
    if (!statOf(at)?.isDirectory()) {
      break;
    }
    if (step.startsWith('.') || (index === 0 && visibleData && step === 'godot')) {
      continue;
    }
    const why = ruleOf(at, false);
    if (why !== null) {
      found.push({ folder: steps.slice(0, index + 1).join('/'), why });
    }
  }
  return found;
}

/** What a walk carries from folder to folder. */
interface Plan {
  readonly withOurs: boolean;
  readonly reversed: boolean;
  readonly realInside: string | null;
  readonly dataFolderIsVisible: boolean;
  readonly leftOut: LeftOut[];
}

interface RawFile {
  readonly name: string;
  readonly real: string;
  readonly viaLink: boolean;
}

interface RawFolder {
  readonly path: string;
  readonly folder: string;
  readonly files: readonly RawFile[];
}

interface Sub {
  readonly path: string;
  readonly folder: string;
  readonly real: string;
  readonly viaLink: boolean;
}

/** A folder of the walk, with the real paths of the folders above it and itself. */
interface Here extends Sub {
  readonly chain: readonly string[];
}

function spelledUnder(folder: string, name: string): string {
  return folder === '' ? name : `${folder}/${name}`;
}

/** Whether [param real] lies outside the project the walk is held inside. */
function isOutside(plan: Plan, real: string): boolean {
  return plan.realInside !== null && relativeWithin(plan.realInside, real) === null;
}

/** One folder's entries sorted into the subfolders to enter and the files to list, leaving the rest out. */
function sortedEntries(plan: Plan, here: Here, atRoot: boolean): { subs: Sub[]; files: RawFile[] } {
  const subs: Sub[] = [];
  const files: RawFile[] = [];
  const entries = entriesOf(here.path).toSorted((a, b) => fileNoCaseCompare(a.name, b.name));
  for (const entry of entries) {
    const taken = takeIn(plan, here, entry, atRoot);
    if (taken === null) {
      continue;
    }
    if ('file' in taken) {
      files.push(taken.file);
    } else {
      subs.push(taken.sub);
    }
  }
  return { subs, files };
}

/** What the walk makes of [param entry]: a file to list, a folder to enter, or null after leaving it out. */
function takeIn(
  plan: Plan,
  here: Here,
  entry: Dirent,
  atRoot: boolean,
): { file: RawFile } | { sub: Sub } | null {
  if (isUnnamedLeftOut(plan, entry.name, atRoot)) {
    return null;
  }
  const path = join(here.path, entry.name);
  const folder = spelledUnder(here.folder, entry.name);
  const kind = kindOf(here.path, entry);
  const isLink = entry.isSymbolicLink();
  if (kind === 'other' && !isLink) {
    return null;
  }
  const real = isLink ? realAsFarAsItExists(path) : join(here.real, entry.name);
  const why =
    kind === 'other'
      ? 'link'
      : whyNotEntered(plan, here, { path, real, isLink, isFolder: kind === 'directory' });
  if (why !== null) {
    plan.leftOut.push({ folder, why });
    return null;
  }
  const viaLink = here.viaLink || isLink;
  return kind === 'file'
    ? { file: { name: entry.name, real, viaLink } }
    : { sub: { path, folder, real, viaLink } };
}

/** Whether the scan leaves the entry [param name] out without a word: a dot name or the project data folder. */
function isUnnamedLeftOut(plan: Plan, name: string, atRoot: boolean): boolean {
  return name.startsWith('.') || (atRoot && plan.dataFolderIsVisible && name === 'godot');
}

/** Why the walk leaves the entry at [param at] out, or null when it takes it in. */
function whyNotEntered(
  plan: Plan,
  here: Here,
  at: { path: string; real: string; isLink: boolean; isFolder: boolean },
): LeftOut['why'] | null {
  if (at.isLink && isOutside(plan, at.real)) {
    return 'outside';
  }
  if (!at.isFolder) {
    return null;
  }
  if (at.isLink && here.chain.includes(at.real)) {
    return 'link';
  }
  return ruleOf(at.path, plan.withOurs);
}

/**
 * The folders under [param here] in the scan's order: a folder's subfolders before its own files,
 * or all of it reversed. A link to a folder the walk is inside is left out.
 */
function* foldersOf(plan: Plan, here: Here, atRoot: boolean): Generator<RawFolder> {
  const { subs, files } = sortedEntries(plan, here, atRoot);
  const own: RawFolder = {
    path: here.path,
    folder: here.folder,
    files: plan.reversed ? files.toReversed() : files,
  };
  if (plan.reversed) {
    yield own;
  }
  for (const sub of plan.reversed ? subs.toReversed() : subs) {
    yield* foldersOf(plan, { ...sub, chain: [...here.chain, sub.real] }, false);
  }
  if (!plan.reversed) {
    yield own;
  }
}

interface Standing {
  readonly first: string;
  direct: boolean;
}

/**
 * Which path of the walk stands for each real file: its own, where the walk reaches that, else the
 * first path in the scan's order. Read from a walk of its own, since a link's folder can come
 * before the folder it leads to.
 */
function standingOf(start: string, realStart: string, plan: Plan): Map<string, Standing> {
  const standing = new Map<string, Standing>();
  const scout: Plan = { ...plan, reversed: false, leftOut: [] };
  for (const folder of foldersOf(
    scout,
    { path: start, folder: '', real: realStart, chain: [realStart], viaLink: false },
    true,
  )) {
    for (const file of folder.files) {
      const known = standing.get(file.real);
      if (known === undefined) {
        standing.set(file.real, { first: join(folder.path, file.name), direct: !file.viaLink });
      } else if (!file.viaLink) {
        known.direct = true;
      }
    }
  }
  return standing;
}

/**
 * The folders of the project at [param start] as the engine scans them, below the start: a name with
 * a leading dot, the project data folder, a folder holding a `.gdignore` and one holding a
 * `project.godot` of its own are left out and named. The start is walked whatever it holds.
 */
export function walkProject(start: string, options: WalkOptions = {}): ProjectWalk {
  const leftOut: LeftOut[] = [];
  const realStart = realAsFarAsItExists(start);
  const realInside = options.inside === undefined ? null : realAsFarAsItExists(options.inside);
  if (realInside !== null && relativeWithin(realInside, realStart) === null) {
    leftOut.push({ folder: '', why: 'outside' });
    return { folders: [], leftOut };
  }
  const plan: Plan = {
    withOurs: options.withOurs === true,
    reversed: options.reversed === true,
    realInside,
    dataFolderIsVisible: dataFolderIsVisible(options.inside ?? start),
    leftOut,
  };
  const atRoot = realInside === null || realInside === realStart;
  const folders = function* (): Generator<WalkedFolder> {
    let standing: Map<string, Standing> | null = null;
    for (const raw of foldersOf(
      plan,
      { path: start, folder: '', real: realStart, chain: [realStart], viaLink: false },
      atRoot,
    )) {
      const files = raw.files.map((file): WalkedFile => {
        if (!file.viaLink) {
          return { name: file.name, real: file.real, twin: false };
        }
        standing ??= standingOf(start, realStart, plan);
        const known = standing.get(file.real);
        const twin = known !== undefined && (known.direct || known.first !== join(raw.path, file.name));
        return { name: file.name, real: file.real, twin };
      });
      yield { path: raw.path, folder: raw.folder, files };
    }
  };
  return { folders: folders(), leftOut };
}
