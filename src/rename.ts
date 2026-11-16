/**
 * Renaming a class or a member across a project: which occurrences of the name are uses of the
 * thing being renamed, which are only the same word, and the writes that change the first kind and
 * nothing else.
 *
 * A class is renamed from the files. A global class is the only thing a bare identifier in code can
 * name, unless the file declares something of its own by that name or the word follows a dot, and
 * both are visible in the text. A member is renamed from the occurrences the editor's language
 * server resolves to it, which the server hands in: which `say` in `thing.say()` is this class's
 * depends on what `thing` is, and only the engine's analyser knows that.
 *
 * Everything not changed is answered as a mention, so a person can read what was left alone rather
 * than find it later as a test failing on a node it cannot find.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, posix } from 'node:path';
import {
  type ClassBody,
  type DeclarationKind,
  Lines,
  type Occurrence,
  occurrencesOf,
  type Region,
  type RegionKind,
  regionsOf,
  type ScriptShape,
  shapeOf,
} from './gdscript-source.js';
import type { IgnoredText, ProjectText } from './project-scan.js';

/** What an edit changes, which says why it was made. */
export type EditKind =
  | 'declaration'
  | 'code'
  | 'doc link'
  | 'scene property'
  | 'scene connection'
  | 'resource class'
  | 'path';

export interface Edit {
  readonly file: string;
  readonly offset: number;
  readonly length: number;
  readonly replacement: string;
  readonly kind: EditKind;
}

/**
 * Where an occurrence was left alone. code, string, comment, doc and nodePath are the tokenizer's
 * view of a script. scene is a scene or resource file, and text is any other file. ignored is any
 * file under a directory holding a `.gdignore`. binary is a scene or resource saved as .scn or
 * .res, which names its dependencies in bytes this cannot rewrite.
 */
type MentionKind = RegionKind | 'scene' | 'text' | 'ignored' | 'binary';

export interface Mention {
  readonly file: string;
  readonly line: number;
  readonly kind: MentionKind;
  readonly text: string;
  readonly why?: string;
}

export interface Plan {
  readonly edits: Edit[];
  readonly mentions: Mention[];
}

/** One script, read once. */
export class Script {
  readonly path: string;
  readonly text: string;
  readonly regions: Region[];
  readonly shape: ScriptShape;
  readonly lines: Lines;

  constructor(path: string, text: string) {
    this.path = path;
    this.text = text;
    this.regions = regionsOf(text);
    this.shape = shapeOf(text);
    this.lines = new Lines(text);
  }

  occurrences(name: string): Occurrence[] {
    return occurrencesOf(this.text, name, this.regions);
  }
}

/** A class body's identity: its script's path, then the inner class names leading to it. */
export type ClassId = string;

function classId(file: string, inner: readonly string[]): ClassId {
  return `${file}#${inner.join('.')}`;
}

/** The script path a class identity is in. */
export function fileOf(id: ClassId): string {
  return id.slice(0, id.lastIndexOf('#'));
}

interface ClassNode {
  readonly id: ClassId;
  readonly file: string;
  readonly inner: readonly string[];
  readonly body: ClassBody;
  parent: ClassId | null;
  native: string | null;
}

/**
 * Every class body in the project's scripts, inner ones included, with what each extends resolved
 * the way the engine resolves it: an inner class in scope first, then a global class, then a native
 * one, and a quoted path relative to the script naming it.
 */
export class ClassGraph {
  readonly nodes = new Map<ClassId, ClassNode>();
  readonly declared: ReadonlyMap<string, string>;
  /** Each script's classes, its own body first. */
  private readonly inFile = new Map<string, ClassNode[]>();

  constructor(scripts: ReadonlyMap<string, Script>, declared: ReadonlyMap<string, string>) {
    this.declared = declared;
    for (const script of scripts.values()) {
      const held: ClassNode[] = [];
      this.inFile.set(script.path, held);
      const add = (body: ClassBody, inner: string[]): void => {
        const id = classId(script.path, inner);
        const node: ClassNode = { id, file: script.path, inner, body, parent: null, native: null };
        this.nodes.set(id, node);
        held.push(node);
        for (const child of body.inner) {
          if (child.name !== null) {
            add(child, [...inner, child.name]);
          }
        }
      };
      add(script.shape.body, []);
    }
    for (const node of this.nodes.values()) {
      const resolved = this.resolve(node, node.body.extendsAs);
      node.parent = resolved.id;
      node.native = resolved.native;
    }
  }

  private resolve(node: ClassNode, written: string | null): { id: ClassId | null; native: string | null } {
    if (written === null) {
      return { id: null, native: 'RefCounted' };
    }
    if (written.startsWith('"') || written.startsWith("'")) {
      const path = resolvedPath(written.slice(1, -1), node.file);
      const id = classId(path, []);
      return this.nodes.has(id) ? { id, native: null } : { id: null, native: null };
    }
    const [first = '', ...rest] = written.split('.');
    for (let depth = node.inner.length; depth >= 0; depth -= 1) {
      const scope = this.nodes.get(classId(node.file, node.inner.slice(0, depth)));
      if (scope?.body.inner.some((child) => child.name === first) === true) {
        const id = classId(node.file, [...node.inner.slice(0, depth), first, ...rest]);
        return this.nodes.has(id) ? { id, native: null } : { id: null, native: null };
      }
    }
    const globalFile = this.declared.get(first);
    if (globalFile !== undefined) {
      const id = classId(globalFile, rest);
      return this.nodes.has(id) ? { id, native: null } : { id: null, native: null };
    }
    return { id: null, native: rest.length === 0 ? first : null };
  }

  /** The project classes [param id] inherits from, nearest first. */
  ancestors(id: ClassId): ClassId[] {
    const found: ClassId[] = [];
    let at = this.nodes.get(id)?.parent ?? null;
    while (at !== null && !found.includes(at)) {
      found.push(at);
      at = this.nodes.get(at)?.parent ?? null;
    }
    return found;
  }

  /** The class a global name such as `Outer.Inner` names, or null where no script declares it. */
  named(name: string): ClassId | null {
    const [first = '', ...rest] = name.split('.');
    const file = this.declared.get(first);
    const id = file === undefined ? null : classId(file, rest);
    return id !== null && this.nodes.has(id) ? id : null;
  }

  /**
   * The class whose own [param name] a use resolved from [param id] reaches: [param id] or the
   * nearest class above it declaring the name as [param kind]. Undefined where none does, and null
   * where the chain breaks before one does.
   */
  resolvedFrom(id: ClassId, name: string, kind: DeclarationKind): ClassId | null | undefined {
    const found = [id, ...this.ancestors(id)].find((one) => this.declaration(one, name)?.kind === kind);
    if (found !== undefined) {
      return found;
    }
    return this.nativeBase(id) === null ? null : undefined;
  }

  /** The project class [param id] extends, or null where it extends a native class or a missing script. */
  parentOf(id: ClassId): ClassId | null {
    return this.nodes.get(id)?.parent ?? null;
  }

  /** Whether [param id] declares a static function named [param name]. */
  declaresStatic(id: ClassId, name: string): boolean {
    return (
      this.nodes
        .get(id)
        ?.body.declarations.some((one) => one.name === name && one.kind === 'func' && one.isStatic) === true
    );
  }

  /** The native class at the bottom of [param id]'s chain, or null where the chain is broken. */
  nativeBase(id: ClassId): string | null {
    const chain = [id, ...this.ancestors(id)];
    return this.nodes.get(chain[chain.length - 1] ?? id)?.native ?? null;
  }

  /** [param id] and every class inheriting from it. */
  descendants(id: ClassId): Set<ClassId> {
    const found = new Set<ClassId>([id]);
    for (const node of this.nodes.values()) {
      if (this.ancestors(node.id).includes(id)) {
        found.add(node.id);
      }
    }
    return found;
  }

  /** The innermost class body of [param file] holding [param offset]. */
  bodyAt(file: string, offset: number): ClassId {
    let best = classId(file, []);
    let depth = 0;
    for (const node of this.inFile.get(file) ?? []) {
      if (node.inner.length > depth && node.body.start <= offset && offset <= node.body.end) {
        best = node.id;
        depth = node.inner.length;
      }
    }
    return best;
  }

  /** The inner class [param name] that [param id] declares, or null. */
  innerOf(id: ClassId, name: string): ClassId | null {
    const node = this.nodes.get(id);
    const inner = node === undefined ? null : classId(node.file, [...node.inner, name]);
    return inner !== null && this.nodes.has(inner) ? inner : null;
  }

  /** The class [param id] is declared inside, or null for a script's own class. */
  outerOf(id: ClassId): ClassId | null {
    const node = this.nodes.get(id);
    return node === undefined || node.inner.length === 0 ? null : classId(node.file, node.inner.slice(0, -1));
  }

  /** The script's class at [param written], a path as [param from]'s script spells it, or null. */
  scriptAt(written: string, from: ClassId): ClassId | null {
    const id = classId(resolvedPath(written, fileOf(from)), []);
    return this.nodes.has(id) ? id : null;
  }

  /** What [param id] declares by [param name], or undefined. */
  declaration(id: ClassId, name: string): { kind: DeclarationKind; offset: number } | undefined {
    const found = this.nodes.get(id)?.body.declarations.find((one) => one.name === name);
    return found === undefined ? undefined : { kind: found.kind, offset: found.offset };
  }
}

/** [param written], a path as a script or a scene spells it, as the `res://` path it names. */
function resolvedPath(written: string, from: string): string {
  if (written.startsWith('res://')) {
    return `res://${posix.normalize(written.slice('res://'.length))}`;
  }
  const directory = posix.dirname(from.slice('res://'.length));
  return `res://${posix.normalize(posix.join(directory, written))}`;
}

/** [param target] spelled relative to the directory of [param from], both `res://` paths. */
function relativeTo(target: string, from: string): string {
  return posix.relative(posix.dirname(from.slice('res://'.length)), target.slice('res://'.length));
}

/** The scripts among [param texts], each read once. */
export function scriptsOf(texts: readonly ProjectText[]): Map<string, Script> {
  const scripts = new Map<string, Script>();
  for (const file of texts) {
    if (file.path.endsWith('.gd')) {
      scripts.set(file.path, new Script(file.path, file.text));
    }
  }
  return scripts;
}

/** Every class_name the scripts declare, with the script declaring it. */
export function declaredIn(scripts: ReadonlyMap<string, Script>): Map<string, string> {
  const declared = new Map<string, string>();
  for (const script of scripts.values()) {
    if (script.shape.className !== null) {
      declared.set(script.shape.className.name, script.path);
    }
  }
  return declared;
}

const DOC_LINK_KINDS = new Set([
  'method',
  'member',
  'signal',
  'constant',
  'enum',
  'annotation',
  'theme_item',
]);

/** A `[...]` reference in documentation around an occurrence, read as Godot's doc markup reads it. */
interface DocLink {
  /** method, member, signal, constant or enum, or null for a bare class reference. */
  readonly kind: string | null;
  readonly parts: readonly string[];
  /** Which dotted part the occurrence is. */
  readonly index: number;
}

/** Where the text of a `##` line starting at [param lineStart] begins, or null for any other line. */
function docContentAt(text: string, lineStart: number): number | null {
  let at = lineStart;
  while (text[at] === ' ' || text[at] === '\t') {
    at += 1;
  }
  return text.startsWith('##', at) ? at + 2 : null;
}

/** [param end], one earlier when a carriage return sits before it. */
function withoutReturn(text: string, end: number): number {
  return text[end - 1] === '\r' ? end - 1 : end;
}

/**
 * The documentation comment holding [param offset], its `##` lines joined by a space the way Godot
 * reads one, with where in [param text] each joined character came from (-1 for a joining space).
 * Null when the offset is not on a `##` line.
 */
function docBlockAt(text: string, offset: number): { joined: string; from: number[] } | null {
  const lineStartOf = (at: number): number => text.lastIndexOf('\n', at - 1) + 1;
  const contentOf = (lineStart: number): number | null => docContentAt(text, lineStart);
  let top = lineStartOf(offset);
  if (contentOf(top) === null) {
    return null;
  }
  while (top > 0 && contentOf(lineStartOf(top - 1)) !== null) {
    top = lineStartOf(top - 1);
  }
  let joined = '';
  const from: number[] = [];
  for (let line = top; ; ) {
    const content = contentOf(line);
    if (content === null) {
      break;
    }
    const nextBreak = text.indexOf('\n', line);
    const end = withoutReturn(text, nextBreak < 0 ? text.length : nextBreak);
    if (joined.length > 0) {
      joined += ' ';
      from.push(-1);
    }
    joined += text.slice(content, end);
    for (let at = content; at < end; at += 1) {
      from.push(at);
    }
    if (nextBreak < 0) {
      break;
    }
    line = nextBreak + 1;
  }
  return { joined, from };
}

/**
 * The doc link [param offset] is inside, or null. Read across the lines of its documentation
 * comment, because a link wraps where the prose does: `[constant` ending one `##` line and
 * `Folk.SKILL_MAX]` starting the next is one link, and read a line at a time only its first half
 * was renamed. That left a reference to nothing after a rename that answered ok.
 */
function docLinkAt(text: string, offset: number): DocLink | null {
  const block = docBlockAt(text, offset);
  const at = block?.from.indexOf(offset) ?? -1;
  if (block === null || at < 0) {
    return null;
  }
  const { joined } = block;
  const open = joined.lastIndexOf('[', at);
  const close = joined.indexOf(']', at);
  if (open < 0 || close < 0) {
    return null;
  }
  const inside = joined.slice(open + 1, close);
  if (inside.includes('[') || inside.includes(']')) {
    return null;
  }
  const match = /^\s*(?:([a-z_]+)\s+)?([\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*)\s*$/u.exec(
    inside,
  );
  if (match === null || (match[1] !== undefined && !DOC_LINK_KINDS.has(match[1]))) {
    return null;
  }
  const path = match[2] ?? '';
  const parts = path.split('.');
  let partAt = open + 1 + inside.trimEnd().length - path.length;
  for (const [index, part] of parts.entries()) {
    if (partAt === at) {
      return { kind: match[1] ?? null, parts, index };
    }
    partAt += part.length + 1;
  }
  return null;
}

/** Which doc link keyword names a member of each kind. */
const DOC_KIND: Readonly<Record<DeclarationKind, string | null>> = {
  func: 'method',
  var: 'member',
  signal: 'signal',
  const: 'constant',
  enumValue: 'constant',
  enum: 'enum',
  class: null,
};

/** Collects edits and mentions, with one edit per place however many reasons found it. */
class PlanBuilder {
  private readonly edits = new Map<string, Edit>();
  private readonly mentions: Mention[] = [];
  private readonly oldName: string;
  private readonly newName: string;

  constructor(oldName: string, newName: string) {
    this.oldName = oldName;
    this.newName = newName;
  }

  edit(
    file: string,
    offset: number,
    kind: EditKind,
    length = this.oldName.length,
    replacement = this.newName,
  ): void {
    const key = `${file}:${offset}`;
    if (!this.edits.has(key)) {
      this.edits.set(key, { file, offset, length, replacement, kind });
    }
  }

  edited(file: string, offset: number): boolean {
    return this.edits.has(`${file}:${offset}`);
  }

  mention(file: string, lines: Lines, offset: number, kind: MentionKind, why?: string): void {
    this.mentions.push({
      file,
      line: lines.positionOf(offset).line + 1,
      kind,
      text: lines.lineAt(offset).trim(),
      ...(why === undefined ? {} : { why }),
    });
  }

  /**
   * Every whole-word occurrence of the old name in [param texts] that no edit covers, as a mention.
   * Run last, so nothing is answered as both changed and left alone.
   */
  mentionTheRest(texts: readonly ProjectText[], scripts: ReadonlyMap<string, Script>, whyFor: WhyFor): void {
    const already = new Set(this.mentions.map((one) => `${one.file}:${one.line}:${one.kind}:${one.text}`));
    for (const file of texts) {
      const script = scripts.get(file.path);
      const lines = script?.lines ?? new Lines(file.text);
      for (const occurrence of this.unedited(file, script)) {
        const kind: MentionKind = script !== undefined ? occurrence.kind : sceneOrText(file.path);
        const why = whyFor(file.path, occurrence, kind);
        const key = `${file.path}:${lines.positionOf(occurrence.offset).line + 1}:${kind}:${lines.lineAt(occurrence.offset).trim()}`;
        if (already.has(key)) {
          continue;
        }
        already.add(key);
        this.mention(file.path, lines, occurrence.offset, kind, why);
      }
    }
  }

  /** The whole-word occurrences of the old name in [param file] that no edit covers. */
  private unedited(file: ProjectText, script: Script | undefined): Occurrence[] {
    const occurrences =
      script?.occurrences(this.oldName) ??
      occurrencesOf(file.text, this.oldName, [{ kind: 'code', start: 0, end: file.text.length }]);
    return occurrences.filter((occurrence) => !this.edited(file.path, occurrence.offset));
  }

  build(): Plan {
    const edits = [...this.edits.values()].toSorted(
      (a, b) => a.file.localeCompare(b.file) || a.offset - b.offset,
    );
    const mentions = [...this.mentions].toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    return { edits, mentions };
  }
}

type WhyFor = (file: string, occurrence: Occurrence, kind: MentionKind) => string | undefined;

/**
 * Whether the string holding [param offset] is [param name] and nothing else: `"Stamp"`, or the
 * StringName `&"Stamp"`. Code that writes a name whole is usually handing it to something that
 * looks the name up at run time, which no compile checks.
 */
function isWholeString(text: string, offset: number, name: string): boolean {
  const before = text[offset - 1];
  if ((before !== '"' && before !== "'") || text[offset + name.length] !== before) {
    return false;
  }
  // A colon after it makes it a dictionary key or a match pattern, `{"found": found}` or
  // `"found":` under a match, which is the word as data rather than a name handed to call or get.
  // Flagged, three dictionary keys were sent to be checked as uses of a method.
  let after = offset + name.length + 1;
  while (text[after] === ' ' || text[after] === '\t') {
    after += 1;
  }
  return text[after] !== ':';
}

/** Why a string that is the class's whole name was left, for the class rename. */
const WHOLE_CLASS_NAME =
  "the whole string is the class's name, as find_children's type, a comparison with get_global_name() or a list of accepted type names takes it, and it was not changed: if it names this class, it no longer matches anything after the rename, and no compile says so";

/** Why a string that is the member's whole name was left, for the member rename. */
const WHOLE_MEMBER_NAME =
  "the whole string is the member's name, as call, connect, has_method, get, set or a subscript on an object take it, and it was not changed: if it names this member, it no longer finds it after the rename, and no compile says so";

/**
 * Whether [param name] at [param offset] is a key of a dictionary in its second form, `{Foe = 1}`,
 * where the key is the string "Foe" and no name at all.
 */
function isWrittenKey(text: string, offset: number, name: string): boolean {
  let before = offset - 1;
  while (before >= 0 && /\s/.test(text[before] ?? '')) {
    before -= 1;
  }
  let after = offset + name.length;
  while (after < text.length && (text[after] === ' ' || text[after] === '\t')) {
    after += 1;
  }
  return (text[before] === '{' || text[before] === ',') && text[after] === '=' && text[after + 1] !== '=';
}

/** Why a script names the old name as something of its own, if it does, for the mentions there. */
function declaresItsOwn(script: Script, name: string, except: number | null): boolean {
  return script
    .occurrences(name)
    .some(
      (occurrence) =>
        occurrence.kind === 'code' &&
        occurrence.offset !== except &&
        occurrence.declaredAs !== null &&
        occurrence.declaredAs !== 'class_name',
    );
}

interface ClassRenameArguments {
  readonly texts: readonly ProjectText[];
  readonly scripts: ReadonlyMap<string, Script>;
  readonly declaring: Script;
  readonly oldName: string;
  readonly newName: string;
}

/**
 * The edits renaming a global class: every bare use in code, the declaration, doc links naming it,
 * and the `script_class` a resource file records for it.
 */
export function planClassRename(args: ClassRenameArguments): Plan {
  const { texts, scripts, declaring, oldName, newName } = args;
  const plan = new PlanBuilder(oldName, newName);
  const declarationAt = declaring.shape.className?.offset ?? null;
  const graph = new ClassGraph(scripts, declaredIn(scripts));
  const inherits = (script: Script): boolean => inheritsMember(graph, script, oldName);
  for (const script of scripts.values()) {
    const ownDeclaration = script.path === declaring.path ? declarationAt : null;
    const shadowed = declaresItsOwn(script, oldName, ownDeclaration) || inherits(script);
    for (const occurrence of script.occurrences(oldName)) {
      const kind = classUseKind(script, occurrence, oldName, ownDeclaration, shadowed);
      if (kind !== null) {
        plan.edit(script.path, occurrence.offset, kind);
      }
    }
  }
  planResourceClasses(plan, texts, oldName);
  plan.mentionTheRest(texts, scripts, (file, occurrence, kind) =>
    classMentionWhy(scripts.get(file), occurrence, kind, oldName, inherits),
  );
  return plan.build();
}

/** Whether a class [param script] holds inherits a member named [param name]. */
function inheritsMember(graph: ClassGraph, script: Script, name: string): boolean {
  return [...graph.nodes.values()].some(
    (node) =>
      node.file === script.path &&
      graph.ancestors(node.id).some((id) => graph.declaration(id, name) !== undefined),
  );
}

/** What renaming the class does to one occurrence of its name in a script, or null for nothing. */
function classUseKind(
  script: Script,
  occurrence: Occurrence,
  oldName: string,
  ownDeclaration: number | null,
  shadowed: boolean,
): EditKind | null {
  if (occurrence.kind === 'code') {
    if (occurrence.offset === ownDeclaration) {
      return 'declaration';
    }
    // A member a script inherits hides the class from a bare name, as one it declares itself does.
    const isBareUse =
      !shadowed &&
      !occurrence.afterDot &&
      occurrence.declaredAs === null &&
      !isWrittenKey(script.text, occurrence.offset, oldName);
    return isBareUse ? 'code' : null;
  }
  if (occurrence.kind === 'doc') {
    const link = docLinkAt(script.text, occurrence.offset);
    return link?.index === 0 && !shadowed ? 'doc link' : null;
  }
  return null;
}

/** The `script_class` a scene or resource file records for the class. */
function planResourceClasses(plan: PlanBuilder, texts: readonly ProjectText[], oldName: string): void {
  for (const file of texts) {
    if (!SCENE_OR_RESOURCE.test(file.path)) {
      continue;
    }
    for (const section of sectionsOf(file.text)) {
      if (section.kind === 'gd_resource' || section.kind === 'gd_scene') {
        const recorded = section.attributes.get('script_class');
        if (recorded?.value === oldName) {
          plan.edit(file.path, recorded.offset, 'resource class');
        }
      }
    }
  }
}

/** Why an occurrence of the class's name that the rename left alone was left. */
function classMentionWhy(
  script: Script | undefined,
  occurrence: Occurrence,
  kind: MentionKind,
  oldName: string,
  inherits: (script: Script) => boolean,
): string | undefined {
  if (kind === 'string' && script !== undefined && isWholeString(script.text, occurrence.offset, oldName)) {
    return WHOLE_CLASS_NAME;
  }
  if (kind !== 'code' || script === undefined) {
    return undefined;
  }
  if (occurrence.declaredAs === 'class_name') {
    return `this script declares a class of the same name`;
  }
  if (occurrence.declaredAs !== null || declaresItsOwn(script, oldName, null)) {
    return `this script declares something of its own named ${oldName}, so which uses mean the class cannot be told from the text`;
  }
  if (inherits(script)) {
    return `a class this script inherits from declares something named ${oldName}, so a bare ${oldName} here means that, not the class`;
  }
  if (isWrittenKey(script.text, occurrence.offset, oldName)) {
    return `{${oldName} = ...} writes the string "${oldName}" as a dictionary key, not the class`;
  }
  if (occurrence.afterDot) {
    return `after a dot, a member of something else rather than the class`;
  }
  return undefined;
}

/** A place the language server resolved to the member, in a file of the project. */
export interface Resolved {
  readonly file: string;
  readonly offset: number;
}

interface MemberRenameArguments {
  readonly texts: readonly ProjectText[];
  readonly scripts: ReadonlyMap<string, Script>;
  readonly graph: ClassGraph;
  /** The class declaring the member highest in the chain. */
  readonly root: ClassId;
  /** Every declaration being renamed: the root's and each override's. */
  readonly family: readonly Resolved[];
  readonly kind: DeclarationKind;
  readonly oldName: string;
  readonly newName: string;
  readonly resolved: readonly Resolved[];
  /** Places in code the language server resolved to exactly one other declaration, `file:offset`. */
  readonly elsewhere: ReadonlySet<string>;
  /** The files holding a class that inherits the member, where a bare name can be it. */
  readonly heirFiles: ReadonlySet<string>;
}

/** Why a bare name in a file with no class inheriting the member was left. */
export const NOT_INHERITED =
  "no class in this file inherits the member, so a bare name here is that class's own local, parameter or member, or a global";

/** Why a name the language server resolved to one other declaration was left. */
export const RESOLVED_ELSEWHERE = 'the language server resolved this to another declaration of the name';

/**
 * The edits renaming a member: what the language server resolved to it in code, its declarations,
 * doc links naming it on this class or one inheriting from it, and what scenes and resources record
 * by its name on nodes whose script is one of those classes.
 */
export function planMemberRename(args: MemberRenameArguments): Plan {
  const { texts, scripts, graph, root, family, kind, oldName, newName, resolved, elsewhere, heirFiles } =
    args;
  const plan = new PlanBuilder(oldName, newName);
  const heirs = graph.descendants(root);
  const docKind = DOC_KIND[kind];
  const familyAt = new Set(family.map((one) => `${one.file}:${one.offset}`));

  for (const one of family) {
    plan.edit(one.file, one.offset, 'declaration');
  }
  for (const one of resolved) {
    const script = scripts.get(one.file);
    const occurrence = script === undefined ? undefined : occurrenceAt(script, one.offset, oldName);
    if (script !== undefined && occurrence !== undefined) {
      planResolved(plan, script, occurrence, familyAt.has(`${one.file}:${one.offset}`), kind);
    }
  }

  // Doc links the language server does not follow: one naming the member through a class that
  // inherits it, or in a script other than the declaring one.
  for (const script of scripts.values()) {
    planInheritedDocLinks(plan, graph, script, heirs, docKind, oldName);
  }

  planScenes(texts, heirs, kind, oldName, plan);

  plan.mentionTheRest(texts, scripts, (file, occurrence, mentionKind) => {
    const script = scripts.get(file);
    if (
      mentionKind === 'string' &&
      script !== undefined &&
      isWholeString(script.text, occurrence.offset, oldName)
    ) {
      return WHOLE_MEMBER_NAME;
    }
    if (mentionKind !== 'code') {
      return undefined;
    }
    return codeMentionWhy(file, occurrence, heirFiles, elsewhere);
  });
  return plan.build();
}

/** An edit for each doc link in [param script] naming the member through one of [param heirs]. */
function planInheritedDocLinks(
  plan: PlanBuilder,
  graph: ClassGraph,
  script: Script,
  heirs: ReadonlySet<ClassId>,
  docKind: string | null,
  oldName: string,
): void {
  for (const occurrence of script.occurrences(oldName)) {
    const owner = occurrence.kind === 'doc' ? docLinkOwner(graph, script, occurrence, docKind) : null;
    if (owner !== null && heirs.has(owner)) {
      plan.edit(script.path, occurrence.offset, 'doc link');
    }
  }
}

/** The occurrence of [param name] that starts at [param offset] of [param script], if there is one. */
function occurrenceAt(script: Script, offset: number, name: string): Occurrence | undefined {
  if (script.text.slice(offset, offset + name.length) !== name) {
    return undefined;
  }
  return script.occurrences(name).find((each) => each.offset === offset);
}

/** The edit, or the mention, for a place the language server resolved to the member. */
function planResolved(
  plan: PlanBuilder,
  script: Script,
  occurrence: Occurrence,
  isDeclaration: boolean,
  kind: DeclarationKind,
): void {
  const { offset } = occurrence;
  if (occurrence.kind === 'code') {
    plan.edit(script.path, offset, isDeclaration ? 'declaration' : 'code');
  } else if (occurrence.kind === 'doc' && docLinkAt(script.text, offset) !== null) {
    plan.edit(script.path, offset, 'doc link');
  } else {
    const noun = kind === 'func' ? 'method' : 'member';
    plan.mention(
      script.path,
      script.lines,
      offset,
      occurrence.kind,
      `the language server resolved this word to the ${noun}, but it is inside ${insideWhat(occurrence.kind)}, which no rename changes: read it, and change the word by hand if it names the ${noun}`,
    );
  }
}

function insideWhat(kind: RegionKind): string {
  if (kind === 'string') {
    return 'a string';
  }
  return kind === 'nodePath' ? 'a node path' : 'a comment';
}

/**
 * The class a doc link at [param occurrence] names the member through, or null where it is not a
 * link to a member of [param docKind]'s kind written on its last part.
 */
function docLinkOwner(
  graph: ClassGraph,
  script: Script,
  occurrence: Occurrence,
  docKind: string | null,
): ClassId | null {
  const link = docLinkAt(script.text, occurrence.offset);
  if (link === null || link.index !== link.parts.length - 1 || link.kind !== docKind || docKind === null) {
    return null;
  }
  const qualifiers = link.parts.slice(0, -1);
  if (qualifiers.length === 0) {
    return graph.bodyAt(script.path, occurrence.offset);
  }
  const [first = '', ...rest] = qualifiers;
  const file = graph.declared.get(first);
  return file === undefined ? null : `${file}#${rest.join('.')}`;
}

/** Why a code occurrence the language server did not resolve to the member was left. */
function codeMentionWhy(
  file: string,
  occurrence: Occurrence,
  heirFiles: ReadonlySet<string>,
  elsewhere: ReadonlySet<string>,
): string {
  if (!occurrence.afterDot && !heirFiles.has(file)) {
    return NOT_INHERITED;
  }
  if (elsewhere.has(`${file}:${String(occurrence.offset)}`)) {
    return RESOLVED_ELSEWHERE;
  }
  return occurrence.afterDot
    ? 'not resolved to this member by the language server: a value whose type the analyser could not tell, so it may be this member and is left for you'
    : 'not resolved to this member by the language server, which gave no single declaration for it';
}

/** A section of a scene or resource file: its header's attributes and its property lines. */
interface Section {
  readonly kind: string;
  readonly attributes: Map<string, { value: string; offset: number }>;
  readonly properties: { key: string; offset: number; value: string }[];
}

/** The sections of a `.tscn` or `.tres`, as the engine's text format writes them. */
function sectionsOf(text: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  const scan: BracketState = { depth: 0, inString: false };
  let offset = 0;
  for (const line of text.split('\n')) {
    const atTop = scan.depth === 0 && !scan.inString;
    const header = atTop ? /^\[([a-z_]+)(.*)\]\s*$/.exec(line.replace(/\r$/, '')) : null;
    if (header !== null) {
      current = sectionOfHeader(header, offset);
      sections.push(current);
    } else if (atTop && current !== null) {
      const property = propertyOf(line, offset);
      if (property !== null) {
        current.properties.push(property);
      }
    }
    scanBrackets(line, scan);
    if (header !== null) {
      scan.depth = 0;
    }
    offset += line.length + 1;
  }
  return sections;
}

/** The `key = value` property a line of a section holds, with the offset of the line. */
function propertyOf(line: string, offset: number): Section['properties'][number] | null {
  const property = /^([A-Za-z_][\w/:]*) = (.*)$/.exec(line.replace(/\r$/, ''));
  return property === null ? null : { key: property[1] ?? '', offset, value: property[2] ?? '' };
}

/** The section a header line opens, with the offset of each attribute's value. */
function sectionOfHeader(header: RegExpExecArray, offset: number): Section {
  const attributes = new Map<string, { value: string; offset: number }>();
  const rest = header[2] ?? '';
  const restAt = offset + 1 + (header[1]?.length ?? 0);
  for (const attribute of rest.matchAll(
    /([a-z_]+)=("(?:[^"\\]|\\.)*"|[A-Za-z]+\("(?:[^"\\]|\\.)*"\)|[^\s\]]+)/g,
  )) {
    const raw = attribute[2] ?? '';
    const quoted = raw.startsWith('"');
    attributes.set(attribute[1] ?? '', {
      value: quoted ? raw.slice(1, -1) : raw,
      offset: restAt + attribute.index + (attribute[1]?.length ?? 0) + 1 + (quoted ? 1 : 0),
    });
  }
  return { kind: header[1] ?? '', attributes, properties: [] };
}

/** How deep in brackets a scan is, and whether it is inside a string, carried between lines. */
interface BracketState {
  depth: number;
  inString: boolean;
}

const OPENING_BRACKETS = new Set(['[', '{', '(']);
const CLOSING_BRACKETS = new Set([']', '}', ')']);

/** Moves [param state] across [param line], so a value wrapping onto later lines stays one value. */
function scanBrackets(line: string, state: BracketState): void {
  for (let at = 0; at < line.length; at += 1) {
    const character = line.charAt(at);
    if (state.inString) {
      if (character === '\\') {
        at += 1;
      } else if (character === '"') {
        state.inString = false;
      }
    } else if (character === '"') {
      state.inString = true;
    } else if (OPENING_BRACKETS.has(character)) {
      state.depth += 1;
    } else if (CLOSING_BRACKETS.has(character)) {
      state.depth = Math.max(0, state.depth - 1);
    }
  }
}

/** The id inside `ExtResource("id")` or `SubResource("id")`, with which of the two it is. */
function resourceReference(value: string): { external: boolean; id: string } | null {
  const match = /^(Ext|Sub)Resource\(\s*"([^"]*)"\s*\)$/.exec(value.trim());
  return match === null ? null : { external: match[1] === 'Ext', id: match[2] ?? '' };
}

/** What a scene or resource file says each of its nodes and resources runs, read for renames. */
class SceneReader {
  private readonly cache = new Map<string, Section[]>();
  private readonly texts: ReadonlyMap<string, string>;
  private readonly uids: ReadonlyMap<string, string>;

  constructor(texts: ReadonlyMap<string, string>, uids: ReadonlyMap<string, string>) {
    this.texts = texts;
    this.uids = uids;
  }

  sections(path: string): Section[] {
    let found = this.cache.get(path);
    if (found === undefined) {
      const text = this.texts.get(path);
      found = text === undefined ? [] : sectionsOf(text);
      this.cache.set(path, found);
    }
    return found;
  }

  /** The `res://` path an ext_resource of [param path] names, by its path or else its UID. */
  external(path: string, id: string): string | null {
    const entry = this.sections(path).find(
      (section) => section.kind === 'ext_resource' && section.attributes.get('id')?.value === id,
    );
    if (entry === undefined) {
      return null;
    }
    const written = entry.attributes.get('path')?.value;
    if (written !== undefined) {
      return resolvedPath(written, path);
    }
    const uid = entry.attributes.get('uid')?.value;
    return uid === undefined ? null : (this.uids.get(uid) ?? null);
  }

  /** The script a section of [param path] runs. An instanced scene is followed to its root. */
  scriptOf(path: string, section: Section, depth = 0): string | null {
    const script = section.properties.find((property) => property.key === 'script');
    if (script !== undefined) {
      const reference = resourceReference(script.value);
      return reference?.external === true ? this.external(path, reference.id) : null;
    }
    const instance = section.attributes.get('instance')?.value;
    const reference = instance === undefined ? null : resourceReference(instance);
    if (reference?.external !== true || depth > 8) {
      return null;
    }
    const scene = this.external(path, reference.id);
    if (scene === null) {
      return null;
    }
    const rootNode = this.sections(scene).find(
      (candidate) => candidate.kind === 'node' && !candidate.attributes.has('parent'),
    );
    return rootNode === undefined ? null : this.scriptOf(scene, rootNode, depth + 1);
  }

  /** The node sections of [param path] by their path from the scene's root, `.` for the root. */
  nodesByPath(path: string): Map<string, Section> {
    const nodes = new Map<string, Section>();
    for (const section of this.sections(path)) {
      if (section.kind !== 'node') {
        continue;
      }
      const name = section.attributes.get('name')?.value ?? '';
      const parent = section.attributes.get('parent')?.value;
      nodes.set(parent === undefined ? '.' : parent === '.' ? name : `${parent}/${name}`, section);
    }
    return nodes;
  }
}

/**
 * What scenes and resources record by a member's name: a property's saved value under its name on
 * a node or resource whose script inherits it, and a connection naming the signal on its emitter or
 * the method on its receiver.
 */
function planScenes(
  texts: readonly ProjectText[],
  heirs: ReadonlySet<ClassId>,
  kind: DeclarationKind,
  oldName: string,
  plan: PlanBuilder,
): void {
  const byPath = new Map(texts.map((file) => [file.path, file.text]));
  const uids = new Map<string, string>();
  for (const file of texts) {
    if (file.path.endsWith('.uid')) {
      uids.set(file.text.trim(), file.path.slice(0, -'.uid'.length));
    }
  }
  const scene: SceneRename = {
    reader: new SceneReader(byPath, uids),
    inherits: (script) => script !== null && heirs.has(`${script}#`),
    oldName,
    plan,
  };
  for (const file of texts) {
    if (!SCENE_OR_RESOURCE.test(file.path) || !file.text.includes(oldName)) {
      continue;
    }
    if (kind === 'var') {
      planSceneProperties(scene, file.path);
    }
    if (kind === 'signal' || kind === 'func') {
      planSceneConnections(scene, file.path, kind);
    }
  }
}

interface SceneRename {
  readonly reader: SceneReader;
  /** Whether the script at a `res://` path is one of the classes inheriting the member. */
  readonly inherits: (script: string | null) => boolean;
  readonly oldName: string;
  readonly plan: PlanBuilder;
}

/** A property saved under the member's name on a node or resource running an inheriting script. */
function planSceneProperties(scene: SceneRename, path: string): void {
  for (const section of scene.reader.sections(path)) {
    if (!['node', 'resource', 'sub_resource'].includes(section.kind)) {
      continue;
    }
    const property = section.properties.find((one) => one.key === scene.oldName);
    if (property !== undefined && scene.inherits(scene.reader.scriptOf(path, section))) {
      scene.plan.edit(path, property.offset, 'scene property');
    }
  }
}

/** A connection naming the signal on its emitter or the method on its receiver. */
function planSceneConnections(scene: SceneRename, path: string, kind: 'signal' | 'func'): void {
  const nodes = scene.reader.nodesByPath(path);
  for (const section of scene.reader.sections(path)) {
    if (section.kind !== 'connection') {
      continue;
    }
    const attribute = section.attributes.get(kind === 'signal' ? 'signal' : 'method');
    const node = nodes.get(section.attributes.get(kind === 'signal' ? 'from' : 'to')?.value ?? '');
    if (
      attribute?.value === scene.oldName &&
      node !== undefined &&
      scene.inherits(scene.reader.scriptOf(path, node))
    ) {
      scene.plan.edit(path, attribute.offset, 'scene connection');
    }
  }
}

interface MoveArguments {
  readonly texts: readonly ProjectText[];
  readonly scripts: ReadonlyMap<string, Script>;
  /** Each file that moves, by its `res://` path, to where it goes. */
  readonly moves: ReadonlyMap<string, string>;
  /**
   * The paths whose every other occurrence is answered as a mention: the file moved, or the
   * directory, whose path also opens strings that build a path inside it at run time.
   */
  readonly named: readonly string[];
  /** Whether a `res://` path names a file, text or not. */
  readonly exists: (path: string) => boolean;
}

interface Literal {
  readonly offset: number;
  readonly value: string;
  /**
   * What a relative path here is read against: the file's folder or the project's root. Null where
   * it is no path.
   */
  readonly base: 'file' | 'root' | null;
}

/**
 * What precedes a string handed to `ResourceLoader`, which reads a relative path from the root,
 * with the type argument C# puts after the name, any space or line break before the string and the
 * prefix of a raw, StringName, NodePath or verbatim string.
 */
const FROM_THE_ROOT =
  /(?:(?<![.\w])load|\bResourceLoader\s*\.\s*\w+|\bGD\s*\.\s*Load|\b(?:change_scene_to_file|ChangeSceneToFile))\s*(?:<[^()]*>)?\s*\(\s*[rR&^@]*$/;
/** What precedes a string in a scene that holds text or a name, which is never a path. */
const TEXT_IN_A_SCENE =
  /^(?:\s*(?:text|tooltip_text|placeholder_text|resource_name)\s*=\s*|\[node\b.*\s(?:name=|groups=\[(?:"[^"]*",\s*)*))$/;
/** The files of Godot's text formats, where a line starting with `;` is a comment. */
const SEMICOLON_COMMENTS = /\/(?:project\.godot|override\.cfg)$|\.(?:tscn|escn|tres|cfg|gdextension)$/;
/** Godot's text scene and resource files. */
export const SCENE_OR_RESOURCE_EXTENSIONS = ['.tscn', '.escn', '.tres'] as const;
const SCENE_OR_RESOURCE = new RegExp(
  `(?:${SCENE_OR_RESOURCE_EXTENSIONS.join('|').replaceAll('.', '\\.')})$`,
  'i',
);

/**
 * Whether an open editor can read [param path] again after a rewrite. An `.escn` is an imported
 * scene: told to reload one, the editor closes its tab instead.
 */
export function reloadableInTheEditor(path: string): boolean {
  return /\.(?:tscn|tres)$/i.test(path);
}

/**
 * What a relative string at [param offset] of [param file] is read against. A kind of file nobody
 * listed reads it against the file, the way a move always has.
 *
 * - `.import` files hold no relative path, nor do comment lines of Godot's text formats.
 * - In a scene, the text and names it holds are no path.
 * - The argument of `load` and a `ResourceLoader` method is read from the root.
 */
function relativeBase(file: ProjectText, offset: number): Literal['base'] {
  // The opening quote sits just before the contents.
  const quoteAt = offset - 1;
  const before = file.text.slice(file.text.lastIndexOf('\n', quoteAt - 1) + 1, quoteAt);
  if (file.path.endsWith('.import') || (SEMICOLON_COMMENTS.test(file.path) && /^\s*;/.test(before))) {
    return null;
  }
  if (SCENE_OR_RESOURCE.test(file.path) && TEXT_IN_A_SCENE.test(before)) {
    return null;
  }
  return FROM_THE_ROOT.test(file.text.slice(Math.max(0, quoteAt - 200), quoteAt)) ? 'root' : 'file';
}

const PLAIN_STRING = /"((?:[^"\\\n]|\\.)*)"/g;

/** Every string literal of [param file], with where its contents start. */
function literalsOf(file: ProjectText, script: Script | undefined): Literal[] {
  const found: Literal[] = [];
  if (script !== undefined) {
    for (const region of script.regions) {
      if (region.kind !== 'string') {
        continue;
      }
      const literal = file.text.slice(region.start, region.end);
      const quote = /["']/.exec(literal);
      if (
        quote === null ||
        literal.startsWith('"""', quote.index) ||
        literal.startsWith("'''", quote.index)
      ) {
        continue;
      }
      const offset = region.start + quote.index + 1;
      found.push({
        offset,
        value: literal.slice(quote.index + 1, -1),
        base: relativeBase(file, offset),
      });
    }
    return found;
  }
  for (const match of file.text.matchAll(PLAIN_STRING)) {
    found.push({
      offset: match.index + 1,
      value: match[1] ?? '',
      base: relativeBase(file, match.index + 1),
    });
  }
  return found;
}

/**
 * Whether GDScript or a scene reads [param written] with an escape such as `\t`: a doubled
 * backslash is a backslash, and any other is the start of one.
 */
function readWithAnEscape(written: string): boolean {
  return written.replaceAll('\\\\', '').includes('\\');
}

/**
 * The res:// path [param literal] of the file [param from] names, or null where it names none: a
 * path written in full, or a relative one a file or `load` reads, against its base. A relative
 * string the engine reads with an escape names no path of this disk's.
 */
function targetOf(literal: Literal, from: string): string | null {
  const written = literal.value.startsWith('*') ? literal.value.slice(1) : literal.value;
  if (written === '' || written.includes('\n')) {
    return null;
  }
  if (written.startsWith('res://')) {
    return resolvedPath(written, from);
  }
  if (literal.base === null || written.startsWith('uid://') || readWithAnEscape(written)) {
    return null;
  }
  const target = resolvedPath(written, literal.base === 'root' ? 'res://_' : from);
  return target.startsWith('res://..') ? null : target;
}

/** Every path the string literals of [param texts] name as a res:// path, each once. */
export function literalTargets(
  texts: readonly ProjectText[],
  scripts: ReadonlyMap<string, Script>,
): Set<string> {
  const targets = new Set<string>();
  for (const file of texts) {
    for (const literal of literalsOf(file, scripts.get(file.path))) {
      const target = targetOf(literal, file.path);
      if (target !== null) {
        targets.add(target);
      }
    }
  }
  return targets;
}

/** The arguments of [function joinedByTheDisk]. */
export interface JoinArguments {
  readonly projectPath: string;
  /** What the string literals write as res:// paths, from [function literalTargets]. */
  readonly targets: ReadonlySet<string>;
  /** Every path that names a moved file, where it goes. Spellings the disk joins are added. */
  readonly references: Map<string, string>;
  /** Where the entry at an absolute path really is, or null where nothing is: [function reachedAt]. */
  readonly resolve: (absolute: string) => string | null;
  /** Which directory entry an absolute path names, a link itself rather than what it leads to: [function entryAt]. */
  readonly entry: (absolute: string) => string | null;
}

/** The directory entry at [param absolute], a link not followed, as an id, or null where nothing is. */
export function entryAt(absolute: string): string | null {
  try {
    const found = lstatSync(absolute, { bigint: true });
    return `${found.dev}:${found.ino}`;
  } catch {
    return null;
  }
}

/** Where the entry at [param absolute] really is, each link followed and each name as stored, or null. */
export function reachedAt(absolute: string): string | null {
  try {
    return realpathSync.native(absolute);
  } catch {
    return null;
  }
}

/**
 * Whether [param target] is [param moved] spelt another way, not a second route to the same file:
 * each folder above the last name, and the name itself, is the same directory entry in both. A
 * path through another link to the file reaches it too, and is a different path.
 */
function sameRoute(target: string, moved: string, entry: (path: string) => string | null): boolean {
  const names = (path: string): string[] => path.slice('res://'.length).split('/').filter(Boolean);
  const [wanted, own] = [names(target), names(moved)];
  if (wanted.length !== own.length) {
    return false;
  }
  return wanted.every((_name, at) => {
    const last = at === wanted.length - 1;
    const prefix = (path: string, parts: string[]): string =>
      last ? path : `res://${parts.slice(0, at + 1).join('/')}`;
    const there = entry(prefix(target, wanted));
    return there !== null && there === entry(prefix(moved, own));
  });
}

/**
 * Adds to [param args].references each res:// spelling in [param args].targets that reaches the
 * same directory entry as a moved file, as `res://DESK.tscn` reaches `res://desk.tscn` on Windows
 * and macOS, or a path through a link spelt in another case. The file system answers every
 * spelling, since no fold of the letters is its own and the disk also joins a trailing slash, a
 * stream suffix or a short name: where it keeps two spellings apart, as Linux does, or where a name
 * is a hard link, which reaches its own entry, nothing is added. The spelling goes where the exact
 * path goes, for a relative string as for an absolute one. Each distinct spelling is resolved once.
 */
export function joinedByTheDisk(args: JoinArguments): void {
  const { targets, references, resolve } = args;
  const asked = (ask: (absolute: string) => string | null): ((path: string) => string | null) => {
    const answers = new Map<string, string | null>();
    return (path) => {
      if (!answers.has(path)) {
        answers.set(path, ask(`${args.projectPath}/${path.slice('res://'.length)}`));
      }
      return answers.get(path) ?? null;
    };
  };
  const reach = asked(resolve);
  const entry = asked(args.entry);
  const folderOf = (path: string): string => {
    const parts = path.slice('res://'.length).split('/').filter(Boolean);
    return parts.length < 2 ? 'res://' : `res://${parts.slice(0, -1).join('/')}`;
  };
  type Moved = { path: string; goesTo: string };
  const group = <T>(map: Map<string, T[]>, key: string, one: T): void => {
    const found = map.get(key);
    if (found === undefined) {
      map.set(key, [one]);
    } else {
      found.push(one);
    }
  };
  // A spelling reaches a moved file only from the file's real folder, so one question per folder
  // rules out every target elsewhere. The files of a folder are asked once a target is in it.
  const inFolder = new Map<string, Moved[]>();
  for (const [path, goesTo] of references) {
    const folder = reach(folderOf(path));
    if (folder !== null) {
      group(inFolder, folder, { path, goesTo });
    }
  }
  const movedAt = new Map<string, Map<string, Moved[]>>();
  const movedIn = (folder: string): Map<string, Moved[]> => {
    let moved = movedAt.get(folder);
    if (moved === undefined) {
      moved = new Map();
      for (const one of inFolder.get(folder) ?? []) {
        const at = reach(one.path);
        if (at !== null) {
          group(moved, at, one);
        }
      }
      movedAt.set(folder, moved);
    }
    return moved;
  };
  for (const target of targets) {
    const folder = references.has(target) ? null : reach(folderOf(target));
    const at = folder === null || !inFolder.has(folder) ? null : reach(target);
    const goesTo =
      at === null || folder === null
        ? undefined
        : movedIn(folder)
            .get(at)
            ?.find((one) => sameRoute(target, one.path, entry))?.goesTo;
    if (goesTo !== undefined) {
      references.set(target, goesTo);
    }
  }
}

/**
 * The edits moving files: every string naming one by path, as a res:// path or relative to the
 * file it is in, written to name the new place in the same style, and in each moved file, every
 * relative path, which names a different file once it is somewhere else.
 */
export function planMove(args: MoveArguments, plan: Plan): Plan {
  const { texts, scripts, moves, named, exists } = args;
  const edits = [...plan.edits];
  const mentions = [...plan.mentions];
  const editedAt = new Set(edits.map((one) => `${one.file}:${one.offset}`));
  const add = (file: string, offset: number, length: number, replacement: string): void => {
    if (!editedAt.has(`${file}:${offset}`)) {
      editedAt.add(`${file}:${offset}`);
      edits.push({ file, offset, length, replacement, kind: 'path' });
    }
  };
  for (const file of texts) {
    const script = scripts.get(file.path);
    const goesTo = moves.get(file.path);
    for (const literal of literalsOf(file, script)) {
      const moved = movedLiteral(literal, file.path, goesTo, moves, exists);
      if (moved !== null) {
        add(file.path, moved.offset, moved.length, moved.replacement);
      }
    }
    mentionNamedPaths(file, script, named, edits, mentions);
  }
  return {
    edits: edits.toSorted((a, b) => a.file.localeCompare(b.file) || a.offset - b.offset),
    mentions: mentions.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
  };
}

/** Adds a mention to [param mentions] for each place [param file] names a path of [param named] unedited. */
function mentionNamedPaths(
  file: ProjectText,
  script: Script | undefined,
  named: readonly string[],
  edits: readonly Edit[],
  mentions: Mention[],
): void {
  const lines = script?.lines ?? new Lines(file.text);
  for (const path of named) {
    for (const { pattern, why } of namedSpellings(path)) {
      for (const match of file.text.matchAll(pattern)) {
        const offset = match.index;
        if (isEdited(edits, file.path, offset)) {
          continue;
        }
        mentions.push({
          file: file.path,
          line: lines.positionOf(offset).line + 1,
          kind: mentionKindAt(script, file.path, offset),
          text: lines.lineAt(offset).trim(),
          why,
        });
      }
    }
  }
}

/** The path edit for a string literal of [param from], or null where it needs none. */
function movedLiteral(
  literal: Literal,
  from: string,
  goesTo: string | undefined,
  moves: ReadonlyMap<string, string>,
  exists: (path: string) => boolean,
): { offset: number; length: number; replacement: string } | null {
  const autoload = literal.value.startsWith('*') ? '*' : '';
  const written = literal.value.slice(autoload.length);
  if (written === '' || written.startsWith('uid://') || written.includes('\n')) {
    return null;
  }
  const replacement = movedPath(written, literal.base, from, goesTo, moves, exists);
  // A relative path between two files that moved together reads the same afterwards, and is
  // not an edit: counted as one, the answer listed files as changed that were written as they were.
  if (replacement === null || replacement === written) {
    return null;
  }
  return { offset: literal.offset + autoload.length, length: written.length, replacement };
}

/** [param written] as it must read once [param from] or the file it names has moved, or null. */
function movedPath(
  written: string,
  base: Literal['base'],
  from: string,
  goesTo: string | undefined,
  moves: ReadonlyMap<string, string>,
  exists: (path: string) => boolean,
): string | null {
  const isAbsolute = written.startsWith('res://');
  if (!isAbsolute && base === null) {
    return null;
  }
  const fromRoot = base === 'root' && !isAbsolute;
  const target = resolvedPath(written, fromRoot ? 'res://_' : from);
  const targetGoesTo = moves.get(target);
  if (targetGoesTo !== undefined) {
    if (fromRoot) {
      return targetGoesTo.slice('res://'.length);
    }
    return isAbsolute ? targetGoesTo : relativeTo(targetGoesTo, goesTo ?? from);
  }
  if (goesTo !== undefined && !isAbsolute && !fromRoot && /\.[a-z0-9]+$/i.test(written) && exists(target)) {
    return relativeTo(target, goesTo);
  }
  return null;
}

function escapedForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** The ways a text can name [param path] outside a string the engine reads as a path. */
function namedSpellings(path: string): { pattern: RegExp; why: string }[] {
  // Not a longer name that only begins with it: res://levels is not res://levels_old or
  // res://levels.old, and a full stop ending a sentence after it is not part of it.
  const after = String.raw`(?![\w-]|\.\w)`;
  const spellings = [
    {
      pattern: new RegExp(`${escapedForPattern(path)}${after}`, 'g'),
      why: `names ${path} outside a string the engine reads as a path`,
    },
  ];
  // And as a path from the project's root, the way a build script or a note names a file: a
  // move left a game's Python gate naming the folder it had moved, with nothing under leftAlone.
  // Not the end of a longer path, which is another file or the res:// spelling above.
  const fromRoot = path.startsWith('res://') ? path.slice('res://'.length) : '';
  if (fromRoot !== '') {
    spellings.push({
      pattern: new RegExp(`(?<![\\w./-])${escapedForPattern(fromRoot)}${after}`, 'g'),
      why: `names ${path} as ${fromRoot}, a path from the project's root without res://, which the engine does not read as one`,
    });
  }
  return spellings;
}

/** Whether an edit of [param file] covers [param offset]. */
function isEdited(edits: readonly Edit[], file: string, offset: number): boolean {
  return edits.some((one) => one.file === file && one.offset <= offset && offset < one.offset + one.length);
}

/** Where [param offset] of [param file] sits: the script's region there, else its file kind. */
function mentionKindAt(script: Script | undefined, file: string, offset: number): MentionKind {
  const region = script?.regions.find((one) => one.start <= offset && offset < one.end);
  return region !== undefined ? region.kind : sceneOrText(file);
}

function sceneOrText(file: string): 'scene' | 'text' {
  return SCENE_OR_RESOURCE.test(file) ? 'scene' : 'text';
}

/**
 * The plan with every occurrence of [param name], when something is renamed, and of each path in
 * [param movedFrom] in [param ignored] added as a mention. Those files are not changed: the engine
 * does not load them, so nothing says which of their words are uses, but a copy kept there to be
 * shipped or vendored back is broken by the change all the same, and is answered rather than
 * passed over. A link out of the project is named once, since nothing behind it is read.
 */
export function mentionIgnored(
  plan: Plan,
  ignored: readonly IgnoredText[],
  name: string | null,
  movedFrom: readonly string[],
  linksOut: readonly string[],
): Plan {
  const mentions = [...plan.mentions];
  const whys: Record<IgnoredText['why'], string> = {
    gdignore: 'under a directory holding a .gdignore, which the engine does not load, so it was not changed',
    project:
      'in a folder holding a project.godot of its own, which the engine does not load as part of this project, so it was not changed',
  };
  for (const link of linksOut) {
    mentions.push({
      file: link,
      line: 0,
      kind: 'ignored',
      text: '',
      why: 'a link that leads out of the project, so nothing behind it was read or changed',
    });
  }
  for (const file of ignored) {
    const why = whys[file.why];
    const lines = new Lines(file.text);
    const offsets =
      name === null
        ? []
        : occurrencesOf(file.text, name, [{ kind: 'code', start: 0, end: file.text.length }]).map(
            (one) => one.offset,
          );
    for (const path of movedFrom) {
      let at = file.text.indexOf(path);
      while (at >= 0) {
        offsets.push(at);
        at = file.text.indexOf(path, at + path.length);
      }
    }
    const seen = new Set<number>();
    for (const offset of offsets) {
      const line = lines.positionOf(offset).line + 1;
      if (!seen.has(line)) {
        seen.add(line);
        mentions.push({ file: file.path, line, kind: 'ignored', text: lines.lineAt(offset).trim(), why });
      }
    }
  }
  return {
    edits: plan.edits,
    mentions: mentions.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
  };
}

/** One file's contents before and after a plan, and where it is written. */
export interface Rewrite {
  readonly path: string;
  readonly absolute: string;
  readonly before: string;
  readonly after: string;
  /** Set for the moved script: where it is written instead. */
  readonly writeTo: string;
}

/** The text of each file [param plan] changes, with every edit made. */
export function rewritesOf(
  plan: Plan,
  texts: readonly ProjectText[],
  move: { from: string; to: string; absoluteTo: string } | null,
): Rewrite[] {
  const byPath = new Map(texts.map((file) => [file.path, file]));
  const byFile = new Map<string, Edit[]>();
  for (const edit of plan.edits) {
    byFile.set(edit.file, [...(byFile.get(edit.file) ?? []), edit]);
  }
  if (move !== null && !byFile.has(move.from)) {
    byFile.set(move.from, []);
  }
  const rewrites: Rewrite[] = [];
  for (const [path, edits] of byFile) {
    const file = byPath.get(path);
    if (file === undefined) {
      continue;
    }
    let after = file.text;
    let lastStart = Number.POSITIVE_INFINITY;
    for (const edit of [...edits].toSorted((a, b) => b.offset - a.offset)) {
      if (edit.offset + edit.length > lastStart) {
        throw new Error(`two edits overlap in ${path} at offset ${edit.offset}`);
      }
      after = after.slice(0, edit.offset) + edit.replacement + after.slice(edit.offset + edit.length);
      lastStart = edit.offset;
    }
    rewrites.push({
      path,
      absolute: file.absolute,
      before: file.text,
      after,
      writeTo: move?.from === path ? move.absoluteTo : file.absolute,
    });
  }
  return rewrites.toSorted((a, b) => a.path.localeCompare(b.path));
}

/**
 * Writes every rewrite or none. Each file is checked against what the plan was made from before
 * anything is written, so an edit made in between is not overwritten with a plan that never saw
 * it. A write that fails part of the way puts back every file already written.
 */
export function applyRewrites(rewrites: readonly Rewrite[]): void {
  for (const rewrite of rewrites) {
    refuseIfStale(rewrite);
  }
  const done: { rewrite: Rewrite; movedUid: boolean }[] = [];
  try {
    for (const rewrite of rewrites) {
      done.push({ rewrite, movedUid: writeRewrite(rewrite) });
    }
  } catch (error) {
    for (const { rewrite, movedUid } of done.reverse()) {
      putBack(rewrite, movedUid);
    }
    throw error;
  }
}

/** Throws when [param rewrite] was made from a file that has changed, or would land on another. */
function refuseIfStale(rewrite: Rewrite): void {
  const now = readFileSync(rewrite.absolute, 'utf8');
  if (now !== rewrite.before) {
    throw new Error(
      `${rewrite.path} changed on disk while the rename was being worked out, so nothing was written`,
    );
  }
  if (rewrite.writeTo !== rewrite.absolute && existsSync(rewrite.writeTo)) {
    throw new Error(`${rewrite.writeTo} already exists, so nothing was written`);
  }
}

/** Writes one rewrite through a staging file, and whether its `.uid` file moved with it. */
function writeRewrite(rewrite: Rewrite): boolean {
  mkdirSync(dirname(rewrite.writeTo), { recursive: true });
  const staging = `${rewrite.writeTo}.gdharness-rename`;
  writeFileSync(staging, rewrite.after, 'utf8');
  renameSync(staging, rewrite.writeTo);
  if (rewrite.writeTo === rewrite.absolute) {
    return false;
  }
  unlinkSync(rewrite.absolute);
  if (!existsSync(`${rewrite.absolute}.uid`)) {
    return false;
  }
  renameSync(`${rewrite.absolute}.uid`, `${rewrite.writeTo}.uid`);
  return true;
}

function putBack(rewrite: Rewrite, movedUid: boolean): void {
  try {
    writeFileSync(rewrite.absolute, rewrite.before, 'utf8');
    if (rewrite.writeTo !== rewrite.absolute) {
      unlinkSync(rewrite.writeTo);
      if (movedUid) {
        renameSync(`${rewrite.writeTo}.uid`, `${rewrite.absolute}.uid`);
      }
    }
  } catch {
    // Putting back is best done for every file, so one that will not go back does not stop the
    // rest. The write error rethrown by the caller is the thing to act on.
  }
}
