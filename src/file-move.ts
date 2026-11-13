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
 * rewrite, so it is answered instead. It still finds a file that has a UID.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { bytesOf, entriesOf } from './listed-reads.js';
import { relativeWithin } from './paths.js';
import { ignoredTexts, installedByUs, linksOut, projectTexts, spellingsOf } from './project-scan.js';
import { leftOutsOnPath, walkProject } from './project-walk.js';
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
  linkOutOf,
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
  return entriesOf(directory).flatMap((entry) => {
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
  const left = leftOutsOnPath(projectPath, steps.slice(0, -1).join('/')).find(
    (one) => one.why === 'gdignore' || one.why === 'project',
  );
  const leftAt = left === undefined ? Number.POSITIVE_INFINITY : left.folder.split('/').length - 1;
  const dotAt = steps.findIndex((step) => step.startsWith('.'));
  if (dotAt >= 0 && dotAt <= leftAt) {
    return `${path} is under ${steps[dotAt]}, and the engine passes over every directory whose name starts with a dot`;
  }
  if (left?.why === 'gdignore') {
    return `${path} is under a directory holding a .gdignore, which the engine does not load`;
  }
  if (left?.why === 'project') {
    return `${path} is under a directory holding a project.godot of its own, which the engine does not load as part of this project`;
  }
  return null;
}

/** The addon gdharness installed that [param path] is inside, or null. */
function installedAddonOf(projectPath: string, path: string): string | null {
  const steps = path.slice('res://'.length).split('/');
  if (steps[0] !== 'addons' || steps[1] === undefined) {
    return null;
  }
  return installedByUs(join(projectPath, 'addons', steps[1])) ? `res://addons/${steps[1]}` : null;
}

/** The addon gdharness installed that [param path], a directory, holds, or null. */
function holdingAddonOf(projectPath: string, path: string): string | null {
  if (path !== 'res://addons') {
    return null;
  }
  const held = entriesOf(join(projectPath, 'addons')).find(
    (entry) => entry.isDirectory() && installedByUs(join(projectPath, 'addons', entry.name)),
  );
  return held === undefined ? null : `res://addons/${held.name}`;
}

/** The nearest part of [param absolute]'s parent chain that exists and is a file, or null. */
function fileInTheWay(absolute: string): string | null {
  for (let at = dirname(absolute); ; at = dirname(at)) {
    if (existsSync(at)) {
      return statSync(at).isDirectory() ? null : at;
    }
    if (dirname(at) === at) {
      return null;
    }
  }
}

/** Every .scn and .res in the project the engine sees, none behind a link out of the project. */
function binaryResources(projectPath: string): string[] {
  const found: string[] = [];
  for (const folder of walkProject(projectPath, { withOurs: true, inside: projectPath }).folders) {
    const prefix = folder.folder === '' ? 'res://' : `res://${folder.folder}/`;
    for (const file of folder.files) {
      if (!file.twin && /\.(scn|res)$/i.test(file.name)) {
        found.push(`${prefix}${file.name}`);
      }
    }
  }
  return found;
}

/**
 * [param absolute] as a `res://` path with its last step spelled as given. Resolved whole, a target
 * differing from the source only in case is spelled as the source on a file system that does not
 * tell the two apart, and the rename reads as a move to where the file already is.
 */
function targetPathOf(projectPath: string, absolute: string): string | null {
  const inside = relativeWithin(
    onDiskSpelling(projectPath),
    join(onDiskSpelling(dirname(absolute)), basename(absolute)),
  );
  return inside === null || inside === '' ? null : `res://${inside}`;
}

/** A move that can go ahead, or the reason it cannot. */
type CheckedMove = { from: string; to: string; isDirectory: boolean } | { reason: string };

function checkedMove(projectPath: string, absoluteFrom: string, absoluteTo: string): CheckedMove {
  const from = resourcePathOf(projectPath, absoluteFrom);
  const to = targetPathOf(projectPath, absoluteTo);
  if (from === null) {
    const link = linkOutOf(projectPath, absoluteFrom);
    return {
      reason:
        link === null
          ? 'The project directory itself cannot be moved. Give a file or a directory in it.'
          : `${absoluteFrom} is behind the link ${link}, which leads out of the project, so it is not moved from here. Move it in the folder it lives in.`,
    };
  }
  if (to === null) {
    return { reason: `newPath must be a path inside the project, and ${absoluteTo} is not.` };
  }
  if (!existsSync(absoluteFrom)) {
    return { reason: `There is nothing at ${from} to move.` };
  }
  if (from === to) {
    return { reason: `${from} is already there, so there is nothing to move.` };
  }
  const isDirectory = statSync(absoluteFrom).isDirectory();
  const reason =
    keptInPlaceReason(projectPath, from) ??
    destinationReason(projectPath, { from, to, absoluteFrom, absoluteTo, isDirectory }) ??
    (isDirectory ? null : fileMoveReason(projectPath, from, to));
  return reason === null ? { from, to, isDirectory } : { reason };
}

/** Why [param from] stays where it is, because the engine or gdharness owns it there, or null. */
function keptInPlaceReason(projectPath: string, from: string): string | null {
  if (from === 'res://project.godot') {
    return `${from} belongs to the engine where it is: it marks the project's root, so the project is wherever it sits.`;
  }
  if (from === 'res://.godot' || from.startsWith('res://.godot/')) {
    return `${from} belongs to the engine where it is: .godot is the engine's own cache, which it rebuilds from the project's files.`;
  }
  const addon = installedAddonOf(projectPath, from);
  if (addon !== null) {
    return `${from} is inside ${addon}, which gdharness installs and upgrades in place, so it stays there.`;
  }
  const holding = holdingAddonOf(projectPath, from);
  if (holding !== null) {
    return `${from} holds ${holding}, which gdharness installs and upgrades in place, so it stays there.`;
  }
  return null;
}

/** Why nothing can be moved to [param move].to, or null. */
function destinationReason(
  projectPath: string,
  move: { from: string; to: string; absoluteFrom: string; absoluteTo: string; isDirectory: boolean },
): string | null {
  const { from, to, absoluteFrom, absoluteTo, isDirectory } = move;
  if (isDirectory && to.startsWith(`${from}/`)) {
    return `${from} cannot be moved into itself.`;
  }
  if (existsSync(absoluteTo) && !sameFile(absoluteFrom, absoluteTo)) {
    return `${to} already exists, so nothing was moved there.`;
  }
  const blocker = fileInTheWay(absoluteTo);
  if (blocker !== null) {
    return `${resourcePathOf(projectPath, blocker) ?? blocker} is a file, so ${to} cannot go below it: pick a newPath whose parents are directories.`;
  }
  const unseen = unseenByTheEngine(projectPath, to);
  return unseen === null ? null : `${unseen}, so nothing there could load what was moved.`;
}

/** Why the file [param from] cannot become [param to], when it moves with another file or changes extension. */
function fileMoveReason(projectPath: string, from: string, to: string): string | null {
  const owner = SIDECARS.map((sidecar) =>
    from.endsWith(sidecar) ? from.slice(0, -sidecar.length) : null,
  ).find((path) => path !== null && existsSync(join(projectPath, path.slice('res://'.length))));
  if (owner !== undefined && owner !== null) {
    return `${from} belongs to ${owner} and moves with it: move ${owner} instead.`;
  }
  if (extname(from).toLowerCase() !== extname(to).toLowerCase()) {
    return `${from} would become ${to}, and the engine picks how to read a file by its extension: give newPath the extension it has, ${extname(from) || 'none'}.`;
  }
  return null;
}

/** Every file that moves, from its `res://` path to where it goes. */
function movesOf(
  projectPath: string,
  move: { from: string; to: string; absoluteFrom: string; isDirectory: boolean },
): Map<string, string> {
  const { from, to, absoluteFrom, isDirectory } = move;
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
  return moves;
}

/** The reason a file of [param moves] would land on one that is already there, or null. */
function collisionReason(projectPath: string, moves: ReadonlyMap<string, string>): string | null {
  for (const [source, target] of moves) {
    const taken = join(projectPath, target.slice('res://'.length));
    if (existsSync(taken) && !sameFile(join(projectPath, source.slice('res://'.length)), taken)) {
      return `${target} already exists, so nothing was moved there.`;
    }
  }
  return null;
}

/** A mention for each binary resource that names a file of [param moves]. */
function binaryMentions(projectPath: string, moves: ReadonlyMap<string, string>): Mention[] {
  const binaries: Mention[] = [];
  for (const path of binaryResources(projectPath)) {
    const bytes = bytesOf(join(projectPath, path.slice('res://'.length)));
    const names = bytes === null ? undefined : [...moves.keys()].find((moving) => bytes.includes(moving));
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
  return binaries;
}

export function planFileMove(projectPath: string, absoluteFrom: string, absoluteTo: string): MoveOutcome {
  const checked = checkedMove(projectPath, absoluteFrom, absoluteTo);
  if ('reason' in checked) {
    return { ok: false, reason: checked.reason };
  }
  const { from, to, isDirectory } = checked;
  const moves = movesOf(projectPath, { from, to, absoluteFrom, isDirectory });
  const collision = collisionReason(projectPath, moves);
  if (collision !== null) {
    return { ok: false, reason: collision };
  }

  const texts = projectTexts(projectPath).map((file) =>
    file.realPath !== undefined && moves.has(file.realPath) && !moves.has(file.path)
      ? { ...file, path: file.realPath, alsoAt: [file.path, ...(file.alsoAt ?? [])] }
      : file,
  );
  const scripts = scriptsOf(texts);
  // A file reached by more than one path is named by any of them, and each must follow it. The files
  // that move on disk stay those of `moves`.
  const references = new Map(moves);
  for (const text of texts) {
    const target = moves.get(text.path);
    if (target === undefined) {
      continue;
    }
    for (const other of spellingsOf(texts, text.path)) {
      if (!references.has(other)) {
        references.set(other, target);
      }
    }
  }
  let plan = planMove(
    {
      texts,
      scripts,
      moves: references,
      named: [from],
      exists: (path) => existsSync(join(projectPath, path.slice('res://'.length))),
    },
    { edits: [], mentions: [] },
  );
  plan = mentionIgnored(plan, ignoredTexts(projectPath), null, [from], linksOut(projectPath));
  const binaries = binaryMentions(projectPath, references);
  const afterwards = (path: string): string => moves.get(path) ?? path;
  const rewrites = rewritesOf(plan, texts, null);
  // A rewrite is written as UTF-8 text, so a file holding any other byte would lose it silently.
  for (const rewrite of rewrites) {
    if (!readFileSync(rewrite.absolute).equals(Buffer.from(rewrite.before, 'utf8'))) {
      return {
        ok: false,
        reason: `${rewrite.path} is not valid UTF-8, so rewriting it would change bytes outside the edit: save it as UTF-8 and move again.`,
      };
    }
  }
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
 * never saw it. A write that fails part of the way puts back everything already done.
 */
export function applyFileMove(outcome: Extract<MoveOutcome, { ok: true }>): void {
  checkUnchangedOnDisk(outcome);
  const undo: (() => void)[] = [];
  const staged: string[] = [];
  try {
    for (const rewrite of outcome.inPlace) {
      const staging = `${rewrite.absolute}.gdharness-move`;
      staged.push(staging);
      writeFileSync(staging, rewrite.after, 'utf8');
      renameSync(staging, rewrite.absolute);
      undo.push(() => {
        writeFileSync(rewrite.absolute, rewrite.before, 'utf8');
      });
    }
    // A directory in one rename, so its empty directories and the case of its name go with it,
    // and then the files in it whose text changed are written where they now are.
    if (outcome.directory !== null) {
      renameNoting(outcome.directory.absoluteFrom, outcome.directory.absoluteTo, undo);
    }
    for (const file of outcome.moved) {
      if (outcome.directory === null) {
        renameNoting(file.absoluteFrom, file.absoluteTo, undo);
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
    rollBack(staged, undo);
    throw error;
  }
}

/** Refuses to write when the plan no longer matches the disk. */
function checkUnchangedOnDisk(outcome: Extract<MoveOutcome, { ok: true }>): void {
  for (const rewrite of outcome.inPlace) {
    if (readFileSync(rewrite.absolute, 'utf8') !== rewrite.before) {
      throw new Error(
        `${rewrite.path} changed on disk while the move was being worked out, so nothing was written`,
      );
    }
  }
  for (const file of outcome.moved) {
    if (!existsSync(file.absoluteFrom)) {
      throw new Error(`${file.from} is gone from disk, so nothing was written`);
    }
    if (file.text !== null && readFileSync(file.absoluteFrom, 'utf8') !== file.text.before) {
      throw new Error(
        `${file.from} changed on disk while the move was being worked out, so nothing was written`,
      );
    }
    if (existsSync(file.absoluteTo) && !sameFile(file.absoluteFrom, file.absoluteTo)) {
      throw new Error(`${file.to} already exists, so nothing was written`);
    }
  }
}

/** Renames [param source] to [param target], creating its parents, and adds to [param undo] how to put it all back. */
function renameNoting(source: string, target: string, undo: (() => void)[]): void {
  // Found by walking up from the target rather than from what mkdirSync answers, which Bun on
  // Windows spells with a `\\?\` prefix that no path built from the target compares equal to.
  let created: string | null = null;
  for (let at = dirname(target); !existsSync(at); at = dirname(at)) {
    created = at;
  }
  mkdirSync(dirname(target), { recursive: true });
  if (created !== null) {
    const top = created;
    // Pushed first, so it runs after the rename is put back and finds the directories empty.
    undo.push(() => {
      for (let at = dirname(target); ; at = dirname(at)) {
        rmdirSync(at);
        if (at === top) break;
      }
    });
  }
  renameSync(source, target);
  undo.push(() => {
    renameSync(target, source);
  });
}

/** Removes the staging files and runs [param undo] last to first. */
function rollBack(staged: readonly string[], undo: (() => void)[]): void {
  for (const staging of staged) {
    rmSync(staging, { force: true });
  }
  for (const step of undo.reverse()) {
    try {
      step();
    } catch {
      // Putting back is best done for every file, so one that will not go back does not stop the
      // rest. The error below says the move failed, which is the thing to act on.
    }
  }
}
