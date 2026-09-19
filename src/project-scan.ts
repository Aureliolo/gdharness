/**
 * What can be learnt about a project by reading its directory, with no engine involved: what
 * kinds of file it holds, and where a piece of text occurs.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Directories that are never part of a project's own files, and are not spelled with a dot. */
const SKIPPED = new Set(['node_modules']);

/** Whether this entry is one both walks here step over, so that they cannot disagree. */
function skipped(name: string): boolean {
  return name.startsWith('.') || SKIPPED.has(name);
}

/**
 * A directory holding a `.gdignore` is stepped over, because the engine steps over it.
 *
 * A vendored engine, an export directory, somebody else's project kept for reference: what is
 * under one is not imported, so it is not this project's content and counting or searching it
 * answers about files the engine will never load. A hundred megabytes of exported binary is the
 * cheap half of getting this wrong; the expensive half is a search that finds a match in a copy
 * of the code nobody is running.
 */
function steppedOver(directory: string): boolean {
  return existsSync(join(directory, '.gdignore'));
}

/** File counts for a project, by kind. */
export interface ProjectStructure {
  scenes: number;
  scripts: number;
  assets: number;
  other: number;
}

const ASSET_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg', 'ttf', 'otf', 'wav', 'mp3', 'ogg']);

export function projectStructure(projectPath: string): ProjectStructure {
  const structure: ProjectStructure = { scenes: 0, scripts: 0, assets: 0, other: 0 };
  const visit = (directory: string): void => {
    if (steppedOver(directory)) {
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (skipped(entry.name)) {
        continue;
      }
      if (entry.isDirectory()) {
        visit(join(directory, entry.name));
      } else if (entry.isFile()) {
        const extension = entry.name.split('.').pop()?.toLowerCase() ?? '';
        if (extension === 'tscn') {
          structure.scenes += 1;
        } else if (extension === 'gd' || extension === 'cs') {
          structure.scripts += 1;
        } else if (ASSET_EXTENSIONS.has(extension)) {
          structure.assets += 1;
        } else {
          structure.other += 1;
        }
      }
    }
  };
  visit(projectPath);
  return structure;
}

/** The extensions Godot mints a `.uid` sidecar for. */
const CARRIES_A_UID = new Set(['gd', 'shader', 'gdshader']);

/**
 * The scripts and shaders with no `.uid` beside them, project-relative and sorted.
 *
 * A file added since the last import has no sidecar, and nothing about the file itself says so:
 * the engine mints one when it walks the project, and until then every reference to that script by
 * UID has nothing to resolve. Counting them is a question about the directory, so it is answered
 * here rather than by booting an engine to look.
 */
export function scriptsWithoutUid(projectPath: string): string[] {
  const found: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    if (steppedOver(directory)) {
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (skipped(entry.name)) {
        continue;
      }
      const spelled = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(join(directory, entry.name), spelled);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const extension = entry.name.split('.').pop()?.toLowerCase() ?? '';
      if (CARRIES_A_UID.has(extension) && !existsSync(join(directory, `${entry.name}.uid`))) {
        found.push(spelled);
      }
    }
  };
  visit(projectPath, '');
  return found.sort();
}

export interface SearchOptions {
  readonly query: string;
  readonly fileTypes: readonly string[];
  readonly regex: boolean;
  readonly caseSensitive: boolean;
  readonly maxResults: number;
}

interface SearchMatch {
  readonly line: number;
  readonly content: string;
  readonly match: string;
}

export interface SearchResult {
  readonly query: string;
  readonly results: { file: string; matches: SearchMatch[] }[];
  readonly summary: {
    files_searched: number;
    files_with_matches: number;
    total_matches: number;
    truncated: boolean;
  };
}

/** Where the query occurs in the project's text files, as res:// paths with line numbers. */
export function searchProject(projectPath: string, options: SearchOptions): SearchResult {
  const extensions = new Set(
    options.fileTypes.map((ext) => ext.replace(/^\./, '').toLowerCase()).filter(Boolean),
  );
  const result: SearchResult = {
    query: options.query,
    results: [],
    summary: { files_searched: 0, files_with_matches: 0, total_matches: 0, truncated: false },
  };
  const regex = options.regex ? new RegExp(options.query, options.caseSensitive ? '' : 'i') : null;
  const needle = options.caseSensitive ? options.query : options.query.toLowerCase();
  const full = (): boolean => {
    if (result.summary.total_matches >= options.maxResults) {
      result.summary.truncated = true;
      return true;
    }
    return false;
  };

  const visit = (directory: string): void => {
    if (steppedOver(directory)) {
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (full()) {
        return;
      }
      if (skipped(entry.name)) {
        continue;
      }
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      const extension = entry.name.includes('.') ? (entry.name.split('.').pop()?.toLowerCase() ?? '') : '';
      if (!entry.isFile() || !extensions.has(extension)) {
        continue;
      }

      result.summary.files_searched += 1;
      const matches: SearchMatch[] = [];
      for (const [index, line] of readFileSync(entryPath, 'utf8').split('\n').entries()) {
        if (full()) {
          break;
        }
        const match = regex
          ? regex.exec(line)?.[0]
          : (options.caseSensitive ? line : line.toLowerCase()).includes(needle)
            ? options.query
            : '';
        if (match) {
          matches.push({ line: index + 1, content: line.trim(), match });
          result.summary.total_matches += 1;
        }
      }
      if (matches.length > 0) {
        const relativePath = entryPath.slice(projectPath.length + 1).replace(/\\/g, '/');
        result.results.push({ file: `res://${relativePath}`, matches });
        result.summary.files_with_matches += 1;
      }
    }
  };
  visit(projectPath);
  return result;
}
