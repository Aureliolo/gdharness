/**
 * resource_edit move, up to the writes: where each file goes, what in the project names one of them
 * and is rewritten to name the new place, and the report a caller reads. The server does the
 * writing and what the editor or the engine needs afterwards.
 *
 * What Godot's FileSystem dock does on a move, worked out from the files: a file goes with its
 * `.import` and `.uid`, a directory with everything in it, and every path naming one of them in a
 * scene, resource, script or project.godot is rewritten, where the dock asks each dependent's loader
 * to rename its dependencies. A relative path inside a moved file is rewritten too, which the dock
 * does not do. A scene or resource saved as .scn or .res names its dependencies in bytes this cannot
 * rewrite, so it is answered instead; it still finds a file that has a UID.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { ignoredTexts, projectTexts, VERSION_MARKER } from './project-scan.js';
import {
  ClassGraph,
  declaredIn,
  type Mention,
  mentionIgnored,
  planMove,
  type Rewrite,
  rewritesOf,
  scriptsOf,
} from './rename.js';
import {
  asWritten,
  changedReport,
  type LeftAloneDetail,
  leftAloneReport,
  onDiskSpelling,
  resourcePathOf,
  summaryOf,
} from './rename-symbol.js';

/** The sidecars Godot keeps beside a file and moves with it. */
const SIDECARS = ['.uid', '.import'];

/** One file moving, with the text it is written with when what it names moved too. */
interface MovedFile {
  readonly from: string;
  readonly to: string;
  readonly absoluteFrom: string;
  readonly absoluteTo: string;
  /** The text it was planned from and the text it is written with, or null to move its bytes. */
  readonly text: { readonly before: string; readonly after: string } | null;
}

export type MoveOutcome =
  | {
      readonly ok: true;
      readonly report: Record<string, unknown>;
      /** Files that stay where they are and are rewritten. */
      readonly inPlace: readonly Rewrite[];
      readonly moved: readonly MovedFile[];
      /** The directory moved, which goes in one rename with everything in it, or null for a file. */
      readonly directory: { readonly absoluteFrom: string; readonly absoluteTo: string } | null;
      /** Every changed script as it is spelled afterwards, each after the scripts it inherits from. */
      readonly scriptsInOrder: readonly string[];
      /** Every scene or resource rewritten, as it is spelled afterwards. */
      readonly scenesChanged: readonly string[];
      readonly detail: LeftAloneDetail | null;
    }
  | { readonly ok: false; readonly reason: string; readonly advice?: string[] };

/** Every file under [param directory]. */
function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

/** Whether two paths are one file, as a rename that changes only the case of a name sees them. */
function sameFile(one: string, other: string): boolean {
  try {
    const a = statSync(one);
    const b = statSync(other);
    return a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

/** Why [param path], a `res://` path, is somewhere the engine does not look, or null. */
function unseenByTheEngine(projectPath: string, path: string): string | null {
  const steps = path.slice('res://'.length).split('/');
  let directory = projectPath;
  for (const [at, step] of steps.entries()) {
    if (step.startsWith('.')) {
      return `${path} is under ${step}, and the engine passes over every directory whose name starts with a dot`;
    }
    if (at < steps.length - 1) {
      directory = join(directory, step);
      if (existsSync(join(directory, '.gdignore'))) {
        return `${path} is under a directory holding a .gdignore, which the engine does not load`;
      }
    }
  }
  return null;
}

/** The addon gdharness installed that [param path] is inside, or null. */
function installedAddonOf(projectPath: string, path: string): string | null {
  const steps = path.slice('res://'.length).split('/');
  if (steps[0] !== 'addons' || steps[1] === undefined) {
    return null;
  }
  return existsSync(join(projectPath, 'addons', steps[1], VERSION_MARKER))
    ? `res://addons/${steps[1]}`
    : null;
}

/** Every .scn and .res in the project the engine sees. */
function binaryResources(projectPath: string): string[] {
  const found: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    if (existsSync(join(directory, '.gdignore'))) {
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        visit(join(directory, entry.name), `${path}/`);
      } else if (/\.(scn|res)$/i.test(entry.name)) {
        found.push(path);
      }
    }
  };
  visit(projectPath, 'res://');
  return found;
}

/**
 * [param absolute] as a `res://` path with its last step spelled as given. Resolved whole, a target
 * differing from the source only in case is spelled as the source on a file system that does not
 * tell the two apart, and the rename reads as a move to where the file already is.
 */
function targetPathOf(projectPath: string, absolute: string): string | null {
  const inside = relative(
    onDiskSpelling(projectPath),
    join(onDiskSpelling(dirname(absolute)), basename(absolute)),
  );
  if (inside === '' || inside.startsWith('..') || /^[A-Za-z]:/.test(inside)) {
    return null;
  }
  return `res://${inside.replace(/\\/g, '/')}`;
}

export function planFileMove(projectPath: string, absoluteFrom: string, absoluteTo: string): MoveOutcome {
  const from = resourcePathOf(projectPath, absoluteFrom);
  const to = targetPathOf(projectPath, absoluteTo);
  if (from === null) {
    return {
      ok: false,
      reason: 'The project directory itself cannot be moved; give a file or a directory in it.',
    };
  }
  if (to === null) {
    return { ok: false, reason: `newPath must be a path inside the project, and ${absoluteTo} is not.` };
  }
  if (!existsSync(absoluteFrom)) {
    return { ok: false, reason: `There is nothing at ${from} to move.` };
  }
  if (from === to) {
    return { ok: false, reason: `${from} is already there; nothing to move.` };
  }
  const isDirectory = statSync(absoluteFrom).isDirectory();
  if (from === 'res://project.godot') {
    return {
      ok: false,
      reason: `${from} belongs to the engine where it is: it marks the project's root, so the project is wherever it sits.`,
    };
  }
  if (from === 'res://.godot' || from.startsWith('res://.godot/')) {
    return {
      ok: false,
      reason: `${from} belongs to the engine where it is: .godot is the engine's own cache, which it rebuilds from the project's files.`,
    };
  }
  const addon = installedAddonOf(projectPath, from);
  if (addon !== null) {
    return {
      ok: false,
      reason: `${from} is inside ${addon}, which gdharness installs and upgrades in place, so it stays there.`,
    };
  }
  if (isDirectory && to.startsWith(`${from}/`)) {
    return { ok: false, reason: `${from} cannot be moved into itself.` };
  }
  if (existsSync(absoluteTo) && !sameFile(absoluteFrom, absoluteTo)) {
    return { ok: false, reason: `${to} already exists, so nothing was moved there.` };
  }
  const unseen = unseenByTheEngine(projectPath, to);
  if (unseen !== null) {
    return { ok: false, reason: `${unseen}, so nothing there could load what was moved.` };
  }
  if (!isDirectory) {
    const owner = SIDECARS.map((sidecar) =>
      from.endsWith(sidecar) ? from.slice(0, -sidecar.length) : null,
    ).find((path) => path !== null && existsSync(join(projectPath, path.slice('res://'.length))));
    if (owner !== undefined && owner !== null) {
      return { ok: false, reason: `${from} belongs to ${owner} and moves with it: move ${owner} instead.` };
    }
    if (extname(from).toLowerCase() !== extname(to).toLowerCase()) {
      return {
        ok: false,
        reason: `${from} would become ${to}, and the engine picks how to read a file by its extension: give newPath the extension it has, ${extname(from) || 'none'}.`,
      };
    }
  }

  const moves = new Map<string, string>();
  if (isDirectory) {
    for (const file of filesUnder(absoluteFrom)) {
      const path = resourcePathOf(projectPath, file);
      if (path !== null) {
        moves.set(path, `${to}${path.slice(from.length)}`);
      }
    }
  } else {
    moves.set(from, to);
    for (const sidecar of SIDECARS) {
      if (existsSync(`${absoluteFrom}${sidecar}`)) {
        moves.set(`${from}${sidecar}`, `${to}${sidecar}`);
      }
    }
  }

  const texts = projectTexts(projectPath);
  const scripts = scriptsOf(texts);
  let plan = planMove(
    {
      texts,
      scripts,
      moves,
      named: [from],
      exists: (path) => existsSync(join(projectPath, path.slice('res://'.length))),
    },
    { edits: [], mentions: [] },
  );
  plan = mentionIgnored(plan, ignoredTexts(projectPath), null, [from]);
  const binaries: Mention[] = [];
  for (const path of binaryResources(projectPath)) {
    const bytes = readFileSync(join(projectPath, path.slice('res://'.length)));
    const names = [...moves.keys()].find((moving) => bytes.includes(moving));
    if (names !== undefined) {
      binaries.push({
        file: path,
        line: 0,
        kind: 'binary',
        text: names,
        why: 'saved in binary, which this cannot rewrite: the engine still finds a moved file by its UID when it has one, and loses one that has none',
      });
    }
  }
  const afterwards = (path: string): string => moves.get(path) ?? path;
  const rewrites = rewritesOf(plan, texts, null);
  // Each file named where a caller finds it once the move is made, as under changed.
  const mentions = asWritten([...plan.mentions, ...binaries], rewrites).map((mention) => ({
    ...mention,
    file: afterwards(mention.file),
  }));

  const left = leftAloneReport(
    mentions,
    [from, ...moves.keys()].flatMap((path) => [path, path.replace(/^res:\/\//, '')]),
  );
  const absoluteOf = (path: string): string => join(projectPath, path.slice('res://'.length));
  const rewritten = new Map(rewrites.map((rewrite) => [rewrite.path, rewrite]));
  const moved: MovedFile[] = [...moves].map(([source, target]) => {
    const rewrite = rewritten.get(source);
    return {
      from: source,
      to: target,
      absoluteFrom: absoluteOf(source),
      absoluteTo: absoluteOf(target),
      text: rewrite === undefined ? null : { before: rewrite.before, after: rewrite.after },
    };
  });
  const inPlace = rewrites.filter((rewrite) => !moves.has(rewrite.path));

  const graph = new ClassGraph(scripts, declaredIn(scripts));
  const scriptsInOrder = rewrites
    .map((rewrite) => rewrite.path)
    .filter((path) => path.endsWith('.gd'))
    .toSorted(
      (a, b) => graph.ancestors(`${a}#`).length - graph.ancestors(`${b}#`).length || a.localeCompare(b),
    )
    .map(afterwards);
  const scenesChanged = rewrites
    .map((rewrite) => rewrite.path)
    .filter((path) => /\.(tscn|tres)$/i.test(path))
    .map(afterwards);
  const changed = changedReport(plan.edits, rewrites).map((entry) => ({
    ...entry,
    file: afterwards(String(entry['file'])),
  }));
  return {
    ok: true,
    inPlace,
    moved,
    directory: isDirectory ? { absoluteFrom, absoluteTo } : null,
    scriptsInOrder,
    scenesChanged,
    detail: left.detail,
    report: {
      moved: {
        from,
        to,
        ...(isDirectory
          ? { files: moves.size, paths: [...moves.keys()].map(afterwards).toSorted() }
          : { alongside: [...moves.keys()].filter((path) => path !== from).map(afterwards) }),
      },
      changed,
      ...left.lists,
      summary: summaryOf(plan.edits, mentions, rewrites, left.counts),
    },
  };
}

/**
 * Makes every write of a planned move or none. Each file is checked against what the plan was made
 * from before anything is written, so an edit made in between is not overwritten with a plan that
 * never saw it; and a write that fails part of the way puts back everything already done.
 */
export function applyFileMove(outcome: Extract<MoveOutcome, { ok: true }>): void {
  for (const rewrite of outcome.inPlace) {
    if (readFileSync(rewrite.absolute, 'utf8') !== rewrite.before) {
      throw new Error(
        `${rewrite.path} changed on disk while the move was being worked out; nothing was written`,
      );
    }
  }
  for (const file of outcome.moved) {
    if (!existsSync(file.absoluteFrom)) {
      throw new Error(`${file.from} is gone from disk; nothing was written`);
    }
    if (file.text !== null && readFileSync(file.absoluteFrom, 'utf8') !== file.text.before) {
      throw new Error(
        `${file.from} changed on disk while the move was being worked out; nothing was written`,
      );
    }
    if (existsSync(file.absoluteTo) && !sameFile(file.absoluteFrom, file.absoluteTo)) {
      throw new Error(`${file.to} already exists; nothing was written`);
    }
  }
  const undo: (() => void)[] = [];
  const rename = (source: string, target: string): void => {
    mkdirSync(dirname(target), { recursive: true });
    renameSync(source, target);
    undo.push(() => {
      renameSync(target, source);
    });
  };
  try {
    for (const rewrite of outcome.inPlace) {
      const staging = `${rewrite.absolute}.gdharness-move`;
      writeFileSync(staging, rewrite.after, 'utf8');
      renameSync(staging, rewrite.absolute);
      undo.push(() => {
        writeFileSync(rewrite.absolute, rewrite.before, 'utf8');
      });
    }
    // A directory in one rename, so its empty directories and the case of its name go with it,
    // and then the files in it whose text changed are written where they now are.
    if (outcome.directory !== null) {
      rename(outcome.directory.absoluteFrom, outcome.directory.absoluteTo);
    }
    for (const file of outcome.moved) {
      if (outcome.directory === null) {
        rename(file.absoluteFrom, file.absoluteTo);
      }
      if (file.text !== null) {
        const { before, after } = file.text;
        writeFileSync(file.absoluteTo, after, 'utf8');
        undo.push(() => {
          writeFileSync(file.absoluteTo, before, 'utf8');
        });
      }
    }
  } catch (error) {
    for (const step of undo.reverse()) {
      try {
        step();
      } catch {
        // Putting back is best done for every file, so one that will not go back does not stop the
        // rest; the error below says the move failed, which is the thing to act on.
      }
    }
    throw error;
  }
}
