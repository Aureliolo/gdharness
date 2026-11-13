/**
 * Whether a project's imports are behind its files, read off the files with no engine involved,
 * so a run can bring them up to date before it starts and pay nothing when they already are.
 *
 * An editor takes in a file changed on disk only when its window regains focus, and an editor
 * an agent drives never does: a game played or tested after a picture was redrawn by a script
 * read the old import in `.godot/imported` and said nothing (reported from game-b).
 */

import { createHash } from 'node:crypto';
import { type Dirent, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { installedByUs } from './project-scan.js';
import { kindOf } from './project-walk.js';
import { importRecord } from './reimport.js';

/** One file whose import is behind it, by its `res://` path, with why. */
interface StaleImport {
  readonly path: string;
  readonly reason: string;
}

/**
 * The extensions the engine imports without a plugin, which `import_pipeline.gd` holds as
 * `IMPORTABLE_EXTENSIONS`. A case holds the two lists equal.
 */
export const IMPORTABLE_EXTENSIONS: readonly string[] = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'svg',
  'bmp',
  'tga',
  'exr',
  'hdr',
  'dds',
  'ktx',
  'wav',
  'mp3',
  'ogg',
  'ttf',
  'otf',
  'ttc',
  'otc',
  'woff',
  'woff2',
  'pfb',
  'pfm',
  'fnt',
  'font',
  'glb',
  'gltf',
  'fbx',
  'obj',
  'dae',
  'csv',
  'glsl',
];

const IMPORTABLE = new Set(IMPORTABLE_EXTENSIONS);

/**
 * Hashes kept by the size and modification time they were taken at, so a run after the first
 * hashes only what changed since. The judgement is still the content's: a file rewritten byte
 * for byte is current, as the editor, which compares the hash, takes it to be.
 */
const hashes = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; md5: string }>();

function md5Of(file: string): string | null {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(file);
  } catch {
    return null;
  }
  const known = hashes.get(file);
  // The change time too, which a write moves and a program setting the modification time back does
  // not, so a file rewritten at the same size inside one clock step is read again.
  if (
    known !== undefined &&
    known.size === stats.size &&
    known.mtimeMs === stats.mtimeMs &&
    known.ctimeMs === stats.ctimeMs
  ) {
    return known.md5;
  }
  let md5: string;
  try {
    md5 = createHash('md5').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
  hashes.set(file, { size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, md5 });
  return md5;
}

/** The keys of one `[section]` of an import file, with their values as written. */
function sectionOf(text: string, section: string): Map<string, string> {
  const keys = new Map<string, string>();
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\[([^\]]+)\]\s*$/.exec(line);
    if (header !== null) {
      inside = header[1] === section;
      continue;
    }
    const pair = inside ? /^([A-Za-z0-9_./]+)=(.*)$/.exec(line) : null;
    if (pair?.[1] !== undefined && pair[2] !== undefined) {
      keys.set(pair[1], pair[2]);
    }
  }
  return keys;
}

function unquoted(value: string | undefined): string {
  return value === undefined ? '' : value.replace(/^"(.*)"$/, '$1');
}

/** The `res://` paths a `dest_files=[...]` value lists. */
function listed(value: string | undefined): string[] {
  return [...(value ?? '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1] ?? '');
}

/**
 * What the import of each of [param resPaths] wrote into the project itself rather than under
 * `.godot`, by source. A source that wrote nothing there is left out. A CSV's import writes one
 * `.translation` per language beside it, which version control sees and
 * internationalization/locale/translations has to name, and no answer said which files it made.
 */
export function importedIntoTheProject(
  projectPath: string,
  resPaths: readonly string[],
): Record<string, string[]> {
  const wrote: Record<string, string[]> = {};
  for (const resPath of resPaths) {
    let sidecar: string;
    try {
      sidecar = readFileSync(`${onDisk(projectPath, resPath)}.import`, 'utf8');
    } catch {
      continue;
    }
    const outputs = listed(sectionOf(sidecar, 'deps').get('dest_files')).filter(
      (output) => output.startsWith('res://') && !output.startsWith('res://.godot/'),
    );
    if (outputs.length > 0) {
      wrote[resPath] = outputs;
    }
  }
  return wrote;
}

/** A `res://` path as a path on disk under [param projectPath]. */
function onDisk(projectPath: string, resPath: string): string {
  return join(projectPath, resPath.slice('res://'.length));
}

/**
 * The md5 of each sidecar as the editor last imported it, keyed by `res://` path, from the newest
 * filesystem cache under `.godot/editor`, read as `import_pipeline.gd` reads it, or empty without one.
 */
function importedSidecarMd5s(projectPath: string): Map<string, string> {
  const editor = join(projectPath, '.godot', 'editor');
  const newest = newestFilesystemCache(editor);
  if (newest < 0) {
    return new Map<string, string>();
  }
  let text: string;
  try {
    text = readFileSync(join(editor, `filesystem_cache${newest}`), 'utf8');
  } catch {
    return new Map<string, string>();
  }
  return sidecarMd5sIn(text);
}

/** The highest number a `filesystem_cache<number>` file in [param editor] carries, or -1 without one. */
function newestFilesystemCache(editor: string): number {
  let newest = -1;
  try {
    for (const name of readdirSync(editor)) {
      const version = /^filesystem_cache(\d+)$/.exec(name)?.[1];
      if (version !== undefined) {
        newest = Math.max(newest, Number(version));
      }
    }
  } catch {
    return -1;
  }
  return newest;
}

function sidecarMd5sIn(text: string): Map<string, string> {
  const found = new Map<string, string>();
  // The first line is the import settings version. Then a "::<dir>::<time>" line opens each
  // directory, and each file line has nine "::" fields, the eighth "<>"-separated with the
  // sidecar's md5 sixth.
  let directory = 'res://';
  for (const line of text
    .split(/\r?\n/)
    .slice(1)
    .map((one) => one.trim())) {
    if (line === '') {
      continue;
    }
    const fields = line.split('::');
    if (line.startsWith('::')) {
      if (fields.length === 3) {
        directory = fields[1] ?? directory;
      }
      continue;
    }
    const md5 = sidecarMd5Of(fields);
    if (md5 !== undefined) {
      found.set(`${directory}${directory.endsWith('/') ? '' : '/'}${fields[0]}`, md5);
    }
  }
  return found;
}

/** The sidecar's md5 in the fields of a file line, or undefined when the line has none. */
function sidecarMd5Of(fields: readonly string[]): string | undefined {
  const slices = fields.length < 9 ? [] : (fields[7] ?? '').split('<>');
  const md5 = slices[5];
  return slices.length >= 7 && md5 !== undefined && md5 !== '' ? md5 : undefined;
}

/**
 * Why the import of [param resPath] is behind it, or null when it is current or kept or skipped.
 *
 * The checks are the ones `project_import status` makes that need no importer and read no import,
 * in its order and in its words, so a file flagged here is one that status calls `needs_reimport`.
 * A failed import records the hash of the source it failed on and writes no output, so it is
 * behind only once its source changes, which is when importing it again can succeed.
 */
function behind(
  projectPath: string,
  resPath: string,
  sidecarFile: string,
  sidecar: string,
  importedFrom: ReadonlyMap<string, string>,
): string | null {
  const imported = importedFrom.get(resPath);
  if (imported !== undefined && md5Of(sidecarFile) !== imported) {
    return 'its import file changed after it was imported, as setting an option does';
  }
  const remap = sectionOf(sidecar, 'remap');
  const importer = unquoted(remap.get('importer'));
  if (importer === 'keep' || importer === 'skip') {
    return null;
  }
  const deps = sectionOf(sidecar, 'deps');
  const outputs = listed(deps.get('dest_files'));
  const incomplete = incompleteSidecar(remap, outputs);
  if (incomplete !== null) {
    return incomplete;
  }
  if (outputs.some((output) => !existsSync(onDisk(projectPath, output)))) {
    return 'its imported output is not on disk';
  }
  const source = unquoted(deps.get('source_file'));
  if (source !== '' && source !== resPath) {
    return `its import file was written for ${source}`;
  }
  const recorded = recordedSourceMd5(projectPath, resPath);
  if (recorded === '') {
    return 'its import recorded no hash of its source';
  }
  const current = md5Of(onDisk(projectPath, resPath));
  return current === null || current === recorded ? null : 'the source changed after it was imported';
}

/** What a valid import file lacks, or null when it holds a uid and an output. */
function incompleteSidecar(remap: ReadonlyMap<string, string>, outputs: readonly string[]): string | null {
  if (remap.get('valid') === 'false') {
    return null;
  }
  if (!remap.has('uid')) {
    return 'its import file has no uid, which the import writes';
  }
  if (outputs.length === 0 && ![...remap.keys()].some((key) => key.startsWith('path'))) {
    return 'its import file names no imported output, as one written before the engine imports from it does';
  }
  return null;
}

/** The hash of the source the import of [param resPath] recorded, or an empty string without one. */
function recordedSourceMd5(projectPath: string, resPath: string): string {
  try {
    return (
      /^source_md5="([0-9a-f]*)"/m.exec(readFileSync(importRecord(projectPath, resPath), 'utf8'))?.[1] ?? ''
    );
  } catch {
    return '';
  }
}

/**
 * Every file under [param projectPath] whose import is behind it, walked as `project_import
 * status` walks: past names starting with a dot, folders holding a `.gdignore`, and addons
 * gdharness installed. A file with an importable extension and no import file has not been
 * imported. A sidecar whose source has gone is left to `project_import status`, since no import
 * can bring it back.
 */
export function staleImports(projectPath: string): StaleImport[] {
  const stale: StaleImport[] = [];
  const importedFrom = importedSidecarMd5s(projectPath);
  // The folders entered, by what a link resolves to, since the engine follows links and a link back
  // up the tree would otherwise be walked for good.
  const entered = new Set<string>();
  collectStale({ projectPath, importedFrom, entered, stale }, projectPath, 'res://');
  return stale.toSorted((one, other) => one.path.localeCompare(other.path));
}

/** What a walk of the project carries from folder to folder. */
interface Walk {
  readonly projectPath: string;
  readonly importedFrom: ReadonlyMap<string, string>;
  readonly entered: Set<string>;
  readonly stale: StaleImport[];
}

function collectStale(walk: Walk, directory: string, resDirectory: string): void {
  const entries = entriesToWalk(directory, walk.entered);
  if (entries === null) {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    const resPath = `${resDirectory}${entry.name}`;
    const kind = kindOf(directory, entry);
    if (kind === 'directory') {
      collectStale(walk, join(directory, entry.name), `${resPath}/`);
      continue;
    }
    if (kind !== 'file' || entry.name.endsWith('.import')) {
      continue;
    }
    const reason = staleReasonOfFile(walk.projectPath, directory, entry.name, resPath, walk.importedFrom);
    if (reason !== null) {
      walk.stale.push({ path: resPath, reason });
    }
  }
}

/** The entries of [param directory], or null when the walk leaves it out, enters it again or cannot read it. */
function entriesToWalk(directory: string, entered: Set<string>): Dirent[] | null {
  if (existsSync(join(directory, '.gdignore')) || installedByUs(directory)) {
    return null;
  }
  try {
    const real = realpathSync(directory);
    if (entered.has(real)) {
      return null;
    }
    entered.add(real);
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
}

/** Why the file [param name] in [param directory] is behind its import, or null when it is not. */
function staleReasonOfFile(
  projectPath: string,
  directory: string,
  name: string,
  resPath: string,
  importedFrom: ReadonlyMap<string, string>,
): string | null {
  // The sidecar is asked of the file system, which spells names as it opens them: Windows and
  // macOS open `Hero.png.import` and `hero.png.import` as one file.
  const sidecarFile = join(directory, `${name}.import`);
  if (existsSync(sidecarFile)) {
    let sidecar: string;
    try {
      sidecar = readFileSync(sidecarFile, 'utf8');
    } catch {
      return null;
    }
    return behind(projectPath, resPath, sidecarFile, sidecar, importedFrom);
  }
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return IMPORTABLE.has(extension) ? 'it has not been imported' : null;
}
