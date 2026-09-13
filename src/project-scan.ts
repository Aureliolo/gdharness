/**
 * What can be learnt about a project by reading its directory, with no engine involved: what
 * kinds of file it holds, and where a piece of text occurs.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Directories that are never part of a project's own files. */
const SKIPPED = new Set(['.git', '.godot', '.import', 'node_modules']);

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
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) {
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
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (full()) {
        return;
      }
      if (SKIPPED.has(entry.name)) {
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
