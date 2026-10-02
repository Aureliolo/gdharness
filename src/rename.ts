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

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
import type { ProjectText } from './project-scan.js';

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
 * view of a script; scene is a scene or resource file; text is any other file; ignored is any file
 * under a directory holding a `.gdignore`.
 */
type MentionKind = RegionKind | 'scene' | 'text' | 'ignored';

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

  constructor(scripts: ReadonlyMap<string, Script>, declared: ReadonlyMap<string, string>) {
    this.declared = declared;
    for (const script of scripts.values()) {
      const add = (body: ClassBody, inner: string[]): void => {
        const id = classId(script.path, inner);
        this.nodes.set(id, { id, file: script.path, inner, body, parent: null, native: null });
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
    for (const node of this.nodes.values()) {
      if (
        node.file === file &&
        node.inner.length > depth &&
        node.body.start <= offset &&
        offset <= node.body.end
      ) {
        best = node.id;
        depth = node.inner.length;
      }
    }
    return best;
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
  /** method, member, signal, constant or enum; null for a bare class reference. */
  readonly kind: string | null;
  readonly parts: readonly string[];
  /** Which dotted part the occurrence is. */
  readonly index: number;
}

/**
 * The documentation comment holding [param offset], its `##` lines joined by a space the way Godot
 * reads one, with where in [param text] each joined character came from (-1 for a joining space).
 * Null when the offset is not on a `##` line.
 */
function docBlockAt(text: string, offset: number): { joined: string; from: number[] } | null {
  const lineStartOf = (at: number): number => text.lastIndexOf('\n', at - 1) + 1;
  const contentOf = (lineStart: number): number | null => {
    let at = lineStart;
    while (text[at] === ' ' || text[at] === '\t') {
      at += 1;
    }
    return text.startsWith('##', at) ? at + 2 : null;
  };
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
    let end = nextBreak < 0 ? text.length : nextBreak;
    if (text[end - 1] === '\r') {
      end -= 1;
    }
    if (joined.length > 0) {
      joined += ' ';
      from.push(-1);
    }
    for (let at = content; at < end; at += 1) {
      joined += text[at];
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
 * was renamed, leaving a reference to nothing after a rename that answered ok.
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

/** Collects edits and mentions, keeping one edit per place however many reasons found it. */
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
      const occurrences =
        script?.occurrences(this.oldName) ??
        occurrencesOf(file.text, this.oldName, [{ kind: 'code', start: 0, end: file.text.length }]);
      for (const occurrence of occurrences) {
        if (this.edited(file.path, occurrence.offset)) {
          continue;
        }
        const kind: MentionKind =
          script !== undefined ? occurrence.kind : /\.(tscn|tres)$/.test(file.path) ? 'scene' : 'text';
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

  build(): Plan {
    const edits = [...this.edits.values()].sort(
      (a, b) => a.file.localeCompare(b.file) || a.offset - b.offset,
    );
    const mentions = [...this.mentions].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    return { edits, mentions };
  }
}

type WhyFor = (file: string, occurrence: Occurrence, kind: MentionKind) => string | undefined;

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

export interface ClassRenameArguments {
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
  for (const script of scripts.values()) {
    const ownDeclaration = script.path === declaring.path ? declarationAt : null;
    const shadowed = declaresItsOwn(script, oldName, ownDeclaration);
    for (const occurrence of script.occurrences(oldName)) {
      if (occurrence.kind === 'code') {
        if (occurrence.offset === ownDeclaration) {
          plan.edit(script.path, occurrence.offset, 'declaration');
        } else if (!shadowed && !occurrence.afterDot && occurrence.declaredAs === null) {
          plan.edit(script.path, occurrence.offset, 'code');
        }
      } else if (occurrence.kind === 'doc') {
        const link = docLinkAt(script.text, occurrence.offset);
        if (link?.index === 0 && !shadowed) {
          plan.edit(script.path, occurrence.offset, 'doc link');
        }
      }
    }
  }
  for (const file of texts) {
    if (!/\.(tscn|tres)$/.test(file.path)) {
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
  plan.mentionTheRest(texts, scripts, (file, occurrence, kind) => {
    const script = scripts.get(file);
    if (kind !== 'code' || script === undefined) {
      return undefined;
    }
    if (occurrence.declaredAs === 'class_name') {
      return `this script declares a class of the same name`;
    }
    if (occurrence.declaredAs !== null || declaresItsOwn(script, oldName, null)) {
      return `this script declares something of its own named ${oldName}, so which uses mean the class cannot be told from the text`;
    }
    if (occurrence.afterDot) {
      return `after a dot, a member of something else rather than the class`;
    }
    return undefined;
  });
  return plan.build();
}

/** A place the language server resolved to the member, in a file of the project. */
export interface Resolved {
  readonly file: string;
  readonly offset: number;
}

export interface MemberRenameArguments {
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
}

/**
 * The edits renaming a member: what the language server resolved to it in code, its declarations,
 * doc links naming it on this class or one inheriting from it, and what scenes and resources record
 * by its name on nodes whose script is one of those classes.
 */
export function planMemberRename(args: MemberRenameArguments): Plan {
  const { texts, scripts, graph, root, family, kind, oldName, newName, resolved } = args;
  const plan = new PlanBuilder(oldName, newName);
  const heirs = graph.descendants(root);
  const docKind = DOC_KIND[kind];
  const familyAt = new Set(family.map((one) => `${one.file}:${one.offset}`));

  for (const one of family) {
    plan.edit(one.file, one.offset, 'declaration');
  }
  for (const one of resolved) {
    const script = scripts.get(one.file);
    if (script === undefined || script.text.slice(one.offset, one.offset + oldName.length) !== oldName) {
      continue;
    }
    const occurrence = script.occurrences(oldName).find((each) => each.offset === one.offset);
    if (occurrence === undefined) {
      continue;
    }
    if (occurrence.kind === 'code') {
      plan.edit(one.file, one.offset, familyAt.has(`${one.file}:${one.offset}`) ? 'declaration' : 'code');
    } else if (occurrence.kind === 'doc' && docLinkAt(script.text, one.offset) !== null) {
      plan.edit(one.file, one.offset, 'doc link');
    } else {
      plan.mention(
        one.file,
        script.lines,
        one.offset,
        occurrence.kind,
        `the language server resolved this to the ${kind === 'func' ? 'method' : 'member'}, and it is inside ${occurrence.kind === 'string' ? 'a string' : occurrence.kind === 'nodePath' ? 'a node path' : 'a comment'}, so it is left for you`,
      );
    }
  }

  // Doc links the language server does not follow: one naming the member through a class that
  // inherits it, or in a script other than the declaring one.
  for (const script of scripts.values()) {
    for (const occurrence of script.occurrences(oldName)) {
      if (occurrence.kind !== 'doc') {
        continue;
      }
      const link = docLinkAt(script.text, occurrence.offset);
      if (
        link === null ||
        link.index !== link.parts.length - 1 ||
        link.kind !== docKind ||
        docKind === null
      ) {
        continue;
      }
      const qualifiers = link.parts.slice(0, -1);
      let owner: ClassId | null = null;
      if (qualifiers.length === 0) {
        owner = graph.bodyAt(script.path, occurrence.offset);
      } else {
        const [first = '', ...rest] = qualifiers;
        const file = graph.declared.get(first);
        owner = file === undefined ? null : `${file}#${rest.join('.')}`;
      }
      if (owner !== null && heirs.has(owner)) {
        plan.edit(script.path, occurrence.offset, 'doc link');
      }
    }
  }

  planScenes(texts, heirs, kind, oldName, plan);

  plan.mentionTheRest(texts, scripts, (_file, occurrence, mentionKind) =>
    mentionKind === 'code'
      ? occurrence.afterDot
        ? 'not resolved to this member by the language server: another class with a member of the same name, or a value whose type the analyser could not tell'
        : 'not resolved to this member by the language server'
      : undefined,
  );
  return plan.build();
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
  let depth = 0;
  let inString = false;
  let offset = 0;
  for (const line of text.split('\n')) {
    const atTop = depth === 0 && !inString;
    const header = atTop ? /^\[([a-z_]+)(.*)\]\s*$/.exec(line.replace(/\r$/, '')) : null;
    if (header !== null) {
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
      current = { kind: header[1] ?? '', attributes, properties: [] };
      sections.push(current);
    } else if (atTop && current !== null) {
      const property = /^([A-Za-z_][\w/:]*) = (.*)$/.exec(line.replace(/\r$/, ''));
      if (property !== null) {
        current.properties.push({ key: property[1] ?? '', offset, value: property[2] ?? '' });
      }
    }
    for (let at = 0; at < line.length; at += 1) {
      const character = line[at];
      if (inString) {
        if (character === '\\') {
          at += 1;
        } else if (character === '"') {
          inString = false;
        }
      } else if (character === '"') {
        inString = true;
      } else if (character === '[' || character === '{' || character === '(') {
        depth += 1;
      } else if (character === ']' || character === '}' || character === ')') {
        depth = Math.max(0, depth - 1);
      }
    }
    if (header !== null) {
      depth = 0;
    }
    offset += line.length + 1;
  }
  return sections;
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

  /** The script a section of [param path] runs, following an instanced scene to its root. */
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
  const reader = new SceneReader(byPath, uids);
  const inherits = (script: string | null): boolean => script !== null && heirs.has(`${script}#`);
  for (const file of texts) {
    if (!/\.(tscn|tres)$/.test(file.path) || !file.text.includes(oldName)) {
      continue;
    }
    const sections = reader.sections(file.path);
    if (kind === 'var') {
      for (const section of sections) {
        if (!['node', 'resource', 'sub_resource'].includes(section.kind)) {
          continue;
        }
        const property = section.properties.find((one) => one.key === oldName);
        if (property !== undefined && inherits(reader.scriptOf(file.path, section))) {
          plan.edit(file.path, property.offset, 'scene property');
        }
      }
    }
    if (kind === 'signal' || kind === 'func') {
      const nodes = reader.nodesByPath(file.path);
      for (const section of sections) {
        if (section.kind !== 'connection') {
          continue;
        }
        const attribute = section.attributes.get(kind === 'signal' ? 'signal' : 'method');
        const node = nodes.get(section.attributes.get(kind === 'signal' ? 'from' : 'to')?.value ?? '');
        if (
          attribute?.value === oldName &&
          node !== undefined &&
          inherits(reader.scriptOf(file.path, node))
        ) {
          plan.edit(file.path, attribute.offset, 'scene connection');
        }
      }
    }
  }
}

export interface MoveArguments {
  readonly texts: readonly ProjectText[];
  readonly scripts: ReadonlyMap<string, Script>;
  readonly from: string;
  readonly to: string;
  /** Whether a `res://` path names a file, text or not. */
  readonly exists: (path: string) => boolean;
}

/** Every string literal of [param file], with where its contents start. */
function literalsOf(file: ProjectText, script: Script | undefined): { offset: number; value: string }[] {
  const found: { offset: number; value: string }[] = [];
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
      found.push({ offset: region.start + quote.index + 1, value: literal.slice(quote.index + 1, -1) });
    }
    return found;
  }
  for (const match of file.text.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    found.push({ offset: match.index + 1, value: match[1] ?? '' });
  }
  return found;
}

/**
 * The edits moving a script: every string naming it by path, as a res:// path or relative to the
 * file it is in, written to name the new place in the same style; and in the moved script itself,
 * every relative path, which names a different file once the script is somewhere else.
 */
export function planMove(args: MoveArguments, plan: Plan): Plan {
  const { texts, scripts, from, to, exists } = args;
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
    for (const literal of literalsOf(file, script)) {
      const autoload = literal.value.startsWith('*') ? '*' : '';
      const written = literal.value.slice(autoload.length);
      if (written === '' || written.startsWith('uid://') || written.includes('\n')) {
        continue;
      }
      const isAbsolute = written.startsWith('res://');
      const target = resolvedPath(written, file.path);
      if (target === from) {
        const replacement = isAbsolute ? to : relativeTo(to, file.path === from ? to : file.path);
        add(file.path, literal.offset + autoload.length, written.length, replacement);
      } else if (file.path === from && !isAbsolute && /\.[a-z0-9]+$/i.test(written) && exists(target)) {
        add(file.path, literal.offset, written.length, relativeTo(target, to));
      }
    }
    const lines = script?.lines ?? new Lines(file.text);
    for (const match of file.text.matchAll(new RegExp(from.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'g'))) {
      const offset = match.index;
      const covered = edits.some(
        (one) => one.file === file.path && one.offset <= offset && offset < one.offset + one.length,
      );
      if (!covered) {
        const region = script?.regions.find((one) => one.start <= offset && offset < one.end);
        mentions.push({
          file: file.path,
          line: lines.positionOf(offset).line + 1,
          kind: region !== undefined ? region.kind : /\.(tscn|tres)$/.test(file.path) ? 'scene' : 'text',
          text: lines.lineAt(offset).trim(),
          why: `names ${from} outside a string the engine reads as a path`,
        });
      }
    }
  }
  return {
    edits: edits.sort((a, b) => a.file.localeCompare(b.file) || a.offset - b.offset),
    mentions: mentions.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
  };
}

/**
 * The plan with every occurrence of [param name], and of [param movedFrom] when the script moves,
 * in [param ignored] added as a mention. Those files are not changed: the engine does not load
 * them, so nothing says which of their words are uses, but a copy kept there to be shipped or
 * vendored back is broken by the rename all the same, and is answered rather than passed over.
 */
export function mentionIgnored(
  plan: Plan,
  ignored: readonly ProjectText[],
  name: string,
  movedFrom: string | null,
): Plan {
  const mentions = [...plan.mentions];
  const why = 'under a directory holding a .gdignore, which the engine does not load, so it was not changed';
  for (const file of ignored) {
    const lines = new Lines(file.text);
    const offsets = occurrencesOf(file.text, name, [{ kind: 'code', start: 0, end: file.text.length }]).map(
      (one) => one.offset,
    );
    if (movedFrom !== null) {
      let at = file.text.indexOf(movedFrom);
      while (at >= 0) {
        offsets.push(at);
        at = file.text.indexOf(movedFrom, at + movedFrom.length);
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
    mentions: mentions.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
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
    for (const edit of [...edits].sort((a, b) => b.offset - a.offset)) {
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
  return rewrites.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Writes every rewrite or none. Each file is checked against what the plan was made from before
 * anything is written, so an edit made in between is not overwritten with a plan that never saw
 * it; and a write that fails part of the way puts back every file already written.
 */
export function applyRewrites(rewrites: readonly Rewrite[]): void {
  for (const rewrite of rewrites) {
    const now = readFileSync(rewrite.absolute, 'utf8');
    if (now !== rewrite.before) {
      throw new Error(
        `${rewrite.path} changed on disk while the rename was being worked out; nothing was written`,
      );
    }
    if (rewrite.writeTo !== rewrite.absolute && existsSync(rewrite.writeTo)) {
      throw new Error(`${rewrite.writeTo} already exists; nothing was written`);
    }
  }
  const done: { rewrite: Rewrite; movedUid: boolean }[] = [];
  try {
    for (const rewrite of rewrites) {
      mkdirSync(dirname(rewrite.writeTo), { recursive: true });
      const staging = `${rewrite.writeTo}.gdharness-rename`;
      writeFileSync(staging, rewrite.after, 'utf8');
      renameSync(staging, rewrite.writeTo);
      let movedUid = false;
      if (rewrite.writeTo !== rewrite.absolute) {
        unlinkSync(rewrite.absolute);
        if (existsSync(`${rewrite.absolute}.uid`)) {
          renameSync(`${rewrite.absolute}.uid`, `${rewrite.writeTo}.uid`);
          movedUid = true;
        }
      }
      done.push({ rewrite, movedUid });
    }
  } catch (error) {
    for (const { rewrite, movedUid } of done.reverse()) {
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
        // rest; the error below says the write failed, which is the thing to act on.
      }
    }
    throw error;
  }
}
