/**
 * Whether a project's imports are behind its files, read off the files with no engine involved,
 * so a run can bring them up to date before it starts and pay nothing when they already are.
 *
 * An editor takes in a file changed on disk only when its window regains focus, and an editor
 * an agent drives never does: a game played or tested after a picture was redrawn by a script
 * read the old import in `.godot/imported` and said nothing (reported from game-b).
 */

import { createHash } from 'node:crypto';
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION_MARKER } from './project-scan.js';

/** One file whose import is behind it, by its `res://` path, with why. */
export interface StaleImport {
  readonly path: string;
  readonly reason: string;
}

/**
 * The extensions the engine imports without a plugin, which `import_pipeline.gd` holds as
 * `IMPORTABLE_EXTENSIONS`; a case holds the two lists equal.
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
const hashes = new Map<string, { size: number; mtimeMs: number; md5: string }>();

function md5Of(file: string): string | null {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(file);
  } catch {
    return null;
  }
  const known = hashes.get(file);
  if (known !== undefined && known.size === stats.size && known.mtimeMs === stats.mtimeMs) {
    return known.md5;
  }
  let md5: string;
  try {
    md5 = createHash('md5').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
  hashes.set(file, { size: stats.size, mtimeMs: stats.mtimeMs, md5 });
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
 * `.godot`, by source, leaving out a source that wrote nothing there. A CSV's import writes one
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
 * filesystem cache under `.godot/editor`, read as `import_pipeline.gd` reads it; empty without one.
 */
function importedSidecarMd5s(projectPath: string): Map<string, string> {
  const found = new Map<string, string>();
  const editor = join(projectPath, '.godot', 'editor');
  let newest = -1;
  try {
    for (const name of readdirSync(editor)) {
      const version = /^filesystem_cache(\d+)$/.exec(name)?.[1];
      if (version !== undefined) {
        newest = Math.max(newest, Number(version));
      }
    }
  } catch {
    return found;
  }
  if (newest < 0) {
    return found;
  }
  let text: string;
  try {
    text = readFileSync(join(editor, `filesystem_cache${newest}`), 'utf8');
  } catch {
    return found;
  }
  // The first line is the import settings version; then a "::<dir>::<time>" line opens each
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
    const slices = fields.length < 9 ? [] : (fields[7] ?? '').split('<>');
    const md5 = slices[5];
    if (slices.length >= 7 && md5 !== undefined && md5 !== '') {
      found.set(`${directory}${directory.endsWith('/') ? '' : '/'}${fields[0]}`, md5);
    }
  }
  return found;
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
  if (remap.get('valid') !== 'false') {
    if (!remap.has('uid')) {
      return 'its import file has no uid, which the import writes';
    }
    if (outputs.length === 0 && ![...remap.keys()].some((key) => key.startsWith('path'))) {
      return 'its import file names no imported output, as one written before the engine imports from it does';
    }
  }
  if (outputs.some((output) => !existsSync(onDisk(projectPath, output)))) {
    return 'its imported output is not on disk';
  }
  const source = unquoted(deps.get('source_file'));
  if (source !== '' && source !== resPath) {
    return `its import file was written for ${source}`;
  }
  const name = resPath.slice(resPath.lastIndexOf('/') + 1);
  const record = join(
    projectPath,
    '.godot',
    'imported',
    `${name}-${createHash('md5').update(resPath, 'utf8').digest('hex')}.md5`,
  );
  let recorded = '';
  try {
    recorded = /^source_md5="([0-9a-f]*)"/m.exec(readFileSync(record, 'utf8'))?.[1] ?? '';
  } catch {
    recorded = '';
  }
  if (recorded === '') {
    return 'its import recorded no hash of its source';
  }
  const current = md5Of(onDisk(projectPath, resPath));
  return current === null || current === recorded ? null : 'the source changed after it was imported';
}

/**
 * Every file under [param projectPath] whose import is behind it, walked as `project_import
 * status` walks: past names starting with a dot, folders holding a `.gdignore`, and addons
 * gdharness installed. A file with an importable extension and no import file has not been
 * imported; a sidecar whose source has gone is left to `project_import status`, since no import
 * can bring it back.
 */
export function staleImports(projectPath: string): StaleImport[] {
  const stale: StaleImport[] = [];
  const importedFrom = importedSidecarMd5s(projectPath);
  const visit = (directory: string, resDirectory: string): void => {
    if (existsSync(join(directory, '.gdignore')) || existsSync(join(directory, VERSION_MARKER))) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.map((entry) => entry.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const resPath = `${resDirectory}${entry.name}`;
      if (entry.isDirectory()) {
        visit(join(directory, entry.name), `${resPath}/`);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (entry.name.endsWith('.import')) {
        const source = resPath.slice(0, -'.import'.length);
        if (!names.has(entry.name.slice(0, -'.import'.length))) {
          continue;
        }
        const sidecarFile = join(directory, entry.name);
        let sidecar: string;
        try {
          sidecar = readFileSync(sidecarFile, 'utf8');
        } catch {
          continue;
        }
        const reason = behind(projectPath, source, sidecarFile, sidecar, importedFrom);
        if (reason !== null) {
          stale.push({ path: source, reason });
        }
        continue;
      }
      const extension = entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase();
      if (IMPORTABLE.has(extension) && !names.has(`${entry.name}.import`)) {
        stale.push({ path: resPath, reason: 'it has not been imported' });
      }
    }
  };
  visit(projectPath, 'res://');
  return stale.sort((one, other) => one.path.localeCompare(other.path));
}
