/**
 * script_edit rename, up to the writes: which symbol is meant, whether the new name is free, the
 * plan, and the report a caller reads. The server does the writing and what the editor and the
 * class cache need afterwards; the engine and the language server are handed in, so every refusal
 * here can be reached without either.
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { type DeclarationKind, isIdentifier, type Position } from './gdscript-source.js';
import { type ProjectText, projectTexts } from './project-scan.js';
import {
  ClassGraph,
  type ClassId,
  declaredIn,
  type Edit,
  type EditKind,
  fileOf,
  type Mention,
  type Plan,
  planClassRename,
  planMemberRename,
  planMove,
  type Resolved,
  type Rewrite,
  rewritesOf,
  type Script,
  scriptsOf,
} from './rename.js';
import { parseProjectGodot } from './resources.js';

export interface RenameRequest {
  readonly projectPath: string;
  /** The declaring script, absolute. */
  readonly scriptPath: string;
  readonly symbol: string;
  readonly newName: string;
  /** Where to move the declaring script to, absolute, or null to leave it where it is. */
  readonly newScriptPath: string | null;
}

/** What the engine says a name already is, and which native class in a chain declares it. */
export interface NameTaken {
  readonly as: readonly string[];
  readonly declaredBy: string | null;
}

export interface RenameServices {
  /** Throws when the engine cannot be asked. */
  namesTaken(names: readonly string[], base: string | null): Promise<Record<string, NameTaken>>;
  /** Every place the language server resolves to the symbol at a position. Throws when unavailable. */
  references(absolute: string, text: string, at: Position): Promise<Located[]>;
  /** Where the language server says the symbol at a position is declared. Throws when unavailable. */
  definitions(absolute: string, text: string, at: Position): Promise<Located[]>;
}

/** A position in a file, as the language server answers with one. */
interface Located {
  readonly file: string;
  readonly line: number;
  readonly character: number;
}

export type RenameOutcome =
  | {
      readonly ok: true;
      readonly report: Record<string, unknown>;
      readonly rewrites: Rewrite[];
      readonly isClass: boolean;
      readonly moved: { readonly from: string; readonly to: string } | null;
      /**
       * The changed scripts as they are spelled afterwards: the ones declaring what was renamed
       * first, each after the scripts it inherits from, then the rest. An editor reloading a script
       * type-checks it against the copies it holds of everything it uses, so a script reloaded
       * before what it uses is checked against the old names and fails.
       */
      readonly scriptsInOrder: string[];
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly advice?: string[];
      readonly conflicts?: string[];
    };

const WHAT: Record<DeclarationKind, string> = {
  func: 'method',
  var: 'variable',
  const: 'constant',
  signal: 'signal',
  enum: 'enum',
  class: 'inner class',
  enumValue: 'enum value',
};

/** [param absolute] as the `res://` path the walk spells it with, or null outside the project. */
function resourcePathOf(projectPath: string, absolute: string): string | null {
  const inside = relative(onDiskSpelling(projectPath), onDiskSpelling(absolute));
  if (inside === '' || inside.startsWith('..') || /^[A-Za-z]:/.test(inside)) {
    return null;
  }
  return `res://${inside.replace(/\\/g, '/')}`;
}

/**
 * [param path] as the file system spells it, for a path whose tail does not exist yet too: the
 * nearest directory that exists is resolved and the rest appended. Resolving only paths that exist
 * left a move's target in the spelling it was given, and on Windows that can be an 8.3 short name
 * (`C:\Users\RUNNER~1\...`) against a project root resolved to its long one, so a target inside
 * the project read as outside it.
 */
function onDiskSpelling(path: string): string {
  const missing: string[] = [];
  let at = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(at), ...missing.reverse());
    } catch {
      const parent = dirname(at);
      if (parent === at) {
        return resolve(path);
      }
      missing.push(basename(at));
      at = parent;
    }
  }
}

/** Up to [param most] places [param name] is already an identifier in code, other than after a dot. */
function usedAsIdentifier(scripts: ReadonlyMap<string, Script>, name: string, most: number): string[] {
  const found: string[] = [];
  for (const script of scripts.values()) {
    for (const occurrence of script.occurrences(name)) {
      if (occurrence.kind === 'code' && !occurrence.afterDot) {
        found.push(`${script.path}:${script.lines.positionOf(occurrence.offset).line + 1}`);
        if (found.length >= most) {
          return found;
        }
      }
    }
  }
  return found;
}

/** The autoload names project.godot registers, which are global names as much as a class is. */
function autoloadNames(texts: readonly ProjectText[]): string[] {
  const settings = texts.find((file) => file.path === 'res://project.godot');
  return settings === undefined ? [] : Object.keys(parseProjectGodot(settings.text)['autoload'] ?? {});
}

export async function renameSymbol(request: RenameRequest, services: RenameServices): Promise<RenameOutcome> {
  const { projectPath, symbol, newName } = request;
  if (!isIdentifier(newName)) {
    return {
      ok: false,
      reason: `${newName} is not a name GDScript accepts: a letter or underscore, then letters, digits and underscores, and not a keyword.`,
    };
  }
  if (newName === symbol) {
    return { ok: false, reason: `${symbol} is already called ${newName}; nothing to rename.` };
  }
  const declaringPath = resourcePathOf(projectPath, request.scriptPath);
  if (declaringPath === null) {
    return { ok: false, reason: `${request.scriptPath} is not inside the project.` };
  }
  let moveTo: string | null = null;
  if (request.newScriptPath !== null) {
    moveTo = resourcePathOf(projectPath, request.newScriptPath);
    if (moveTo === null || !moveTo.endsWith('.gd')) {
      return {
        ok: false,
        reason: `newScriptPath must be a .gd path inside the project, and ${request.newScriptPath} is not.`,
      };
    }
    if (existsSync(request.newScriptPath)) {
      return { ok: false, reason: `${moveTo} already exists, so the script cannot be moved there.` };
    }
  }

  const texts = projectTexts(projectPath);
  const scripts = scriptsOf(texts);
  const declaring = scripts.get(declaringPath);
  if (declaring === undefined) {
    return {
      ok: false,
      reason: `${declaringPath} is not among the scripts the engine sees: it is under a directory holding a .gdignore, or one spelled with a dot.`,
    };
  }
  const declared = declaredIn(scripts);
  const isClass = declaring.shape.className?.name === symbol;

  let plan: Plan;
  let what: string;
  let resolvedBy: string;
  let overrides: string[] = [];
  // The scripts whose own interface the rename changes, which every other script is checked against.
  let declaringFiles: string[] = [declaringPath];
  if (isClass) {
    what = 'class';
    resolvedBy = 'the files';
    const conflicts: string[] = [];
    const holder = declared.get(newName);
    if (holder !== undefined) {
      conflicts.push(`${newName} is already the class_name of ${holder}`);
    }
    if (autoloadNames(texts).includes(newName)) {
      conflicts.push(`${newName} is already an autoload in project.godot`);
    }
    for (const place of usedAsIdentifier(scripts, newName, 10)) {
      conflicts.push(`${newName} is already an identifier at ${place}`);
    }
    const taken = (await services.namesTaken([newName], null))[newName];
    if (taken !== undefined && taken.as.length > 0) {
      conflicts.push(`${newName} is ${taken.as.join(' and ')}`);
    }
    if (conflicts.length > 0) {
      return {
        ok: false,
        reason: `${symbol} cannot be renamed to ${newName}: the name is taken.`,
        conflicts,
      };
    }
    plan = planClassRename({ texts, scripts, declaring, oldName: symbol, newName });
  } else {
    const declaration = declaring.shape.body.declarations.find((one) => one.name === symbol);
    if (declaration === undefined) {
      const names = [
        ...(declaring.shape.className === null ? [] : [declaring.shape.className.name]),
        ...declaring.shape.body.declarations.map((one) => one.name),
      ];
      return {
        ok: false,
        reason: `${declaringPath} declares no ${symbol} at its top level. What it declares there: ${names.join(', ') || 'nothing'}. A local variable or a member of an inner class is not renamed by this call.`,
      };
    }
    const kind = declaration.kind;
    what = WHAT[kind];
    resolvedBy = "the editor's language server";
    const graph = new ClassGraph(scripts, declared);
    const own: ClassId = `${declaringPath}#`;
    let root = own;
    if (kind === 'func') {
      for (const ancestor of graph.ancestors(own)) {
        if (graph.declaration(ancestor, symbol)?.kind === 'func') {
          root = ancestor;
        }
      }
    }
    const native = graph.nativeBase(root);
    const taken = await services.namesTaken([symbol, newName], native);
    const engineOwned = taken[symbol]?.declaredBy ?? null;
    if (engineOwned !== null) {
      return {
        ok: false,
        reason: `${symbol} is declared by the engine's ${engineOwned}, which ${root === own ? declaringPath : fileOf(root)} inherits from, so the script ${kind === 'func' ? 'overrides' : 'shadows'} an engine name rather than declaring its own, and the engine calls it by that name.`,
      };
    }
    const conflicts: string[] = [];
    const newOwner = taken[newName]?.declaredBy ?? null;
    if (newOwner !== null) {
      conflicts.push(`${newName} is declared by the engine's ${newOwner}, which this class inherits from`);
    }
    for (const id of new Set([root, ...graph.ancestors(root), ...graph.descendants(root)])) {
      if (graph.declaration(id, newName) !== undefined) {
        conflicts.push(
          `${newName} is already declared in ${id.endsWith('#') ? fileOf(id) : `${fileOf(id)}, class ${id.slice(id.lastIndexOf('#') + 1)}`}`,
        );
      }
    }
    if (conflicts.length > 0) {
      return {
        ok: false,
        reason: `${symbol} cannot be renamed to ${newName}: the name is taken.`,
        conflicts,
      };
    }

    const family: Resolved[] = [];
    if (kind === 'func') {
      for (const id of graph.descendants(root)) {
        const found = graph.declaration(id, symbol);
        if (found?.kind === 'func') {
          family.push({ file: fileOf(id), offset: found.offset });
        }
      }
    } else {
      family.push({ file: declaringPath, offset: declaration.offset });
    }
    overrides = family.map((one) => one.file).filter((file) => file !== fileOf(root));
    declaringFiles = family.map((one) => one.file);

    const resolved = await resolveMember(projectPath, texts, scripts, family, symbol, services);
    if (resolved === null) {
      const first = family[0];
      const script = first === undefined ? undefined : scripts.get(first.file);
      const line =
        first === undefined || script === undefined ? 0 : script.lines.positionOf(first.offset).line + 1;
      return {
        ok: false,
        reason: `The language server resolved nothing at ${first?.file ?? declaringPath}:${line}, where ${symbol} is declared, not even the declaration, so it is not analysing that script and its answer would rename nothing.`,
        advice: [
          'script_diagnostics on that script says whether the editor can parse it',
          "editor_status says whether the editor connected is this project's",
        ],
      };
    }
    plan = planMemberRename({
      texts,
      scripts,
      graph,
      root,
      family,
      kind,
      oldName: symbol,
      newName,
      resolved,
    });
  }

  if (moveTo !== null) {
    plan = planMove(
      {
        texts,
        scripts,
        from: declaringPath,
        to: moveTo,
        exists: (path) => existsSync(`${projectPath}/${path.slice('res://'.length)}`),
      },
      plan,
    );
  }
  const rewrites = rewritesOf(
    plan,
    texts,
    moveTo === null || request.newScriptPath === null
      ? null
      : { from: declaringPath, to: moveTo, absoluteTo: request.newScriptPath },
  );
  const graph = new ClassGraph(scripts, declared);
  const rank = (path: string): number =>
    (declaringFiles.includes(path) ? 0 : 1000) + graph.ancestors(`${path}#`).length;
  const scriptsInOrder = rewrites
    .map((rewrite) => rewrite.path)
    .filter((path) => path.endsWith('.gd'))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((path) => (path === declaringPath && moveTo !== null ? moveTo : path));
  return {
    ok: true,
    isClass,
    moved: moveTo === null ? null : { from: declaringPath, to: moveTo },
    scriptsInOrder,
    rewrites,
    report: {
      renamed: { what, from: symbol, to: newName, declaredIn: declaringPath, resolvedBy },
      ...(overrides.length > 0 ? { overridesRenamed: overrides } : {}),
      ...(moveTo === null ? {} : { moved: { from: declaringPath, to: moveTo } }),
      changed: changedReport(plan.edits, rewrites),
      leftAlone: plan.mentions,
      summary: summaryOf(plan.edits, plan.mentions, rewrites),
    },
  };
}

/**
 * Every place in code the language server resolves to the member, found in two passes.
 *
 * The first asks for the references of the topmost declaration. That misses an override's own
 * uses, measured on 4.7.2: asked at an override's declaration, Godot resolves to the method it
 * overrides and answers that method's references, while a bare call inside the overriding class,
 * or one on a value typed as that class, resolves to the override and is in neither answer. So the
 * second pass asks where every other occurrence of the name in code is declared. One answer naming
 * a declaration being renamed makes it a use, and that occurrence's own references are then asked
 * for, which is the override's whole set in one request; one answer naming anything else settles
 * that symbol's references as not this member. More than one answer is the analyser offering every
 * declaration of the name for a value whose type it does not know, and that occurrence is left.
 *
 * Null when the first pass resolves nothing at all, not even the declaration it was asked about.
 */
async function resolveMember(
  projectPath: string,
  texts: readonly ProjectText[],
  scripts: ReadonlyMap<string, Script>,
  family: readonly Resolved[],
  name: string,
  services: RenameServices,
): Promise<Resolved[] | null> {
  const absoluteOf = new Map(texts.map((file) => [file.path, file.absolute]));
  const key = (place: Resolved): string => `${place.file}:${place.offset}`;
  const toResolved = (located: Located): Resolved | null => {
    const file = resourcePathOf(projectPath, located.file);
    const offset = file === null ? null : scripts.get(file)?.lines.offsetOf(located);
    return file === null || offset === null || offset === undefined ? null : { file, offset };
  };
  const ask = async (question: 'references' | 'definitions', place: Resolved): Promise<Resolved[]> => {
    const script = scripts.get(place.file);
    const absolute = absoluteOf.get(place.file);
    if (script === undefined || absolute === undefined) {
      return [];
    }
    const answered = await services[question](absolute, script.text, script.lines.positionOf(place.offset));
    return answered.map(toResolved).filter((one): one is Resolved => one !== null);
  };

  const ours = new Map<string, Resolved>();
  const settled = new Set<string>();
  const root = family[0];
  if (root === undefined) {
    return [];
  }
  const seeded = await ask('references', root);
  if (seeded.length === 0) {
    return null;
  }
  for (const place of seeded) {
    ours.set(key(place), place);
  }
  const declarations = new Set(family.map(key));
  for (const script of scripts.values()) {
    for (const occurrence of script.occurrences(name)) {
      const place = { file: script.path, offset: occurrence.offset };
      if (occurrence.kind !== 'code' || ours.has(key(place)) || settled.has(key(place))) {
        continue;
      }
      const declared = await ask('definitions', place);
      const only = declared.length === 1 ? declared[0] : undefined;
      if (only === undefined) {
        settled.add(key(place));
        continue;
      }
      const isOurs = declarations.has(key(only));
      const same = [place, ...(await ask('references', place))];
      for (const one of same) {
        if (isOurs) {
          ours.set(key(one), one);
        } else {
          settled.add(key(one));
        }
      }
    }
  }
  return [...ours.values()];
}

/** Each changed file with its changed lines as they now read. */
function changedReport(edits: readonly Edit[], rewrites: readonly Rewrite[]): Record<string, unknown>[] {
  return rewrites.map((rewrite) => {
    const lines = rewrite.after.split('\n');
    const byLine = new Map<number, Set<EditKind>>();
    const starts: number[] = [0];
    for (let at = rewrite.before.indexOf('\n'); at !== -1; at = rewrite.before.indexOf('\n', at + 1)) {
      starts.push(at + 1);
    }
    let count = 0;
    for (const edit of edits) {
      if (edit.file !== rewrite.path) {
        continue;
      }
      count += 1;
      let line = 0;
      while (line + 1 < starts.length && (starts[line + 1] ?? 0) <= edit.offset) {
        line += 1;
      }
      byLine.set(line, (byLine.get(line) ?? new Set()).add(edit.kind));
    }
    return {
      file: rewrite.path,
      edits: count,
      lines: [...byLine.entries()]
        .sort(([a], [b]) => a - b)
        .map(([line, kinds]) => ({
          line: line + 1,
          kinds: [...kinds],
          text: (lines[line] ?? '').replace(/\r$/, '').trim(),
        })),
    };
  });
}

function summaryOf(
  edits: readonly Edit[],
  mentions: readonly Mention[],
  rewrites: readonly Rewrite[],
): Record<string, unknown> {
  const count = (values: readonly string[]): Record<string, number> => {
    const counted: Record<string, number> = {};
    for (const value of values) {
      counted[value] = (counted[value] ?? 0) + 1;
    }
    return counted;
  };
  return {
    filesChanged: rewrites.length,
    edits: edits.length,
    editsByKind: count(edits.map((edit) => edit.kind)),
    leftAlone: mentions.length,
    leftAloneByKind: count(mentions.map((mention) => mention.kind)),
  };
}
