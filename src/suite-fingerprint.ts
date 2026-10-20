/**
 * A fingerprint of everything a suite reaches, so a run asked for the changed suites alone can leave
 * out the ones that passed with all of it as it stands now.
 *
 * Read conservatively, since a suite left out wrongly is a fault nobody sees until the full gate: a
 * suite reaching anything named only at run time, a directory listed by a computed name, a load of a
 * computed path or a resource saved in binary, has no fingerprint and always runs. That is also why
 * nothing but an iteration run may leave a suite out: a gate runs every suite, every time.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { classesNamedIn } from './class-cache.js';
import type { DeclaredSuite, ProjectScripts } from './suite-plan.js';

const RES_LITERAL = /res:\/\/[^"'\s)\]<>]*/g;
const RELATIVE_LOAD = /\b(?:pre)?load\(\s*["']((?!res:\/\/|uid:\/\/)[^"']+)["']/g;
/** What makes a script reach something no file names: a directory walk, or a load of a computed path. */
const REACHES_AT_RUN_TIME = [
  /\bDirAccess\b/,
  /\blist_directory\b/,
  /\b(?:load|load_threaded_request)\(\s*(?=[^\s),])/,
];
/** A resource format whose dependencies cannot be read as text. */
const BINARY_RESOURCE = /\.(?:scn|res)$/;
/** The directory of the addon a path is in. */
const ADDON = /^res:\/\/addons\/[^/]+\//;
/** A path with a placeholder in it, which a script fills in at run time. */
const PLACEHOLDER = /[%{}]/;

interface Reached {
  readonly digest: string;
  readonly reaches: readonly string[];
  /** Why what it reaches cannot be read from files, or null when it can. */
  readonly unreadable: string | null;
}

/** The fingerprints of a project's suites, read once per run. */
export class SuiteFingerprints {
  private readonly reached = new Map<string, Reached>();
  private readonly scripts: ProjectScripts;
  private readonly everywhere: string[];
  private readonly alwaysDigest: string;

  /**
   * [param always] is what every suite depends on besides what its code names: the runner, the
   * gdharness version, the files a game names.
   */
  constructor(scripts: ProjectScripts, always: readonly string[]) {
    this.scripts = scripts;
    // project.godot is read like any other file, so the autoloads it names are reached from it.
    this.everywhere = ['res://project.godot', ...extensionsOf(scripts.projectPath)];
    this.alwaysDigest = createHash('sha256').update(always.join('\n')).digest('hex');
  }

  /** [param suite]'s fingerprint, or null when what it reaches cannot all be read from files. */
  of(suite: DeclaredSuite): string | null {
    const seen = new Set<string>();
    const pending = [suite.path, ...this.everywhere];
    for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
      if (seen.has(path)) {
        continue;
      }
      seen.add(path);
      const reached = this.read(path);
      if (reached.unreadable !== null) {
        return null;
      }
      pending.push(...reached.reaches);
    }
    const hash = createHash('sha256').update(this.alwaysDigest);
    for (const path of [...seen].sort()) {
      hash.update(`${path}\n${this.read(path).digest}\n`);
    }
    return hash.digest('hex');
  }

  private read(asked: string): Reached {
    const path = ADDON.exec(asked)?.[0] ?? asked;
    const known = this.reached.get(path);
    if (known !== undefined) {
      return known;
    }
    const reached = path === asked ? this.readAnew(path) : this.addon(path);
    this.reached.set(path, reached);
    return reached;
  }

  /**
   * An addon read whole, every file under it, rather than followed from script to script: gdUnit4
   * walks directories and loads computed paths, and following it would leave every suite without a
   * fingerprint, while an addon changes only when it is installed again.
   */
  private addon(root: string): Reached {
    const hash = createHash('sha256');
    const walk = (directory: string, under: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(file, `${under}${entry.name}/`);
        } else if (entry.isFile()) {
          hash.update(`${under}${entry.name}\n`).update(readFileSync(file));
        }
      }
    };
    const directory = join(this.scripts.projectPath, root.slice('res://'.length));
    if (existsSync(directory)) {
      walk(directory, '');
    }
    return { digest: hash.digest('hex'), reaches: [], unreadable: null };
  }

  private readAnew(path: string): Reached {
    if (PLACEHOLDER.test(path)) {
      return { digest: '', reaches: [], unreadable: `${path} is filled in at run time` };
    }
    const file = join(this.scripts.projectPath, path.slice('res://'.length));
    if (!existsSync(file)) {
      return { digest: 'missing', reaches: [], unreadable: null };
    }
    if (statSync(file).isDirectory()) {
      const inside = readdirSync(file, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith('.'))
        .map((entry) => `${path.endsWith('/') ? path : `${path}/`}${entry.name}`)
        .sort();
      return { digest: inside.join('\n'), reaches: inside, unreadable: null };
    }
    if (BINARY_RESOURCE.test(path)) {
      return { digest: '', reaches: [], unreadable: `${path} is a binary resource` };
    }
    const bytes = readFileSync(file);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const text = bytes.toString('latin1');
    const reaches = new Set<string>();
    for (const [literal] of text.matchAll(RES_LITERAL)) {
      reaches.add(literal);
    }
    if (existsSync(`${file}.import`)) {
      reaches.add(`${path}.import`);
    }
    if (path.endsWith('.gd')) {
      const script = this.scripts.script(path);
      const code = script?.code ?? '';
      const dynamic = REACHES_AT_RUN_TIME.find((pattern) => pattern.test(code));
      if (dynamic !== undefined) {
        return { digest, reaches: [], unreadable: `${path} reaches what it names at run time` };
      }
      for (const [, relative] of text.matchAll(RELATIVE_LOAD)) {
        reaches.add(`res://${posix.join(posix.dirname(path.slice('res://'.length)), relative ?? '')}`);
      }
      const base = this.scripts.base(path);
      if (base !== null && 'path' in base) {
        reaches.add(base.path);
      }
      for (const name of classesNamedIn(code, this.scripts.classes)) {
        reaches.add(this.scripts.classes.get(name) ?? '');
      }
      if (text.includes('uid://')) {
        return { digest, reaches: [], unreadable: `${path} loads by uid` };
      }
    }
    reaches.delete('');
    reaches.delete(path);
    return { digest, reaches: [...reaches], unreadable: null };
  }
}

/** The extensions the engine loads into every run of [param projectPath]. */
function extensionsOf(projectPath: string): string[] {
  const list = join(projectPath, '.godot', 'extension_list.cfg');
  return existsSync(list)
    ? readFileSync(list, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('res://'))
    : [];
}
