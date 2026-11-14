/**
 * GDScript read as text, the way its tokenizer reads it: which characters are code, which are a
 * string, a comment, a documentation comment or a node path, and what a script declares at the top
 * of each class body.
 *
 * Read without an engine, because the answers are needed by calls that run with none: a word in a
 * comment and the same word in code look alike to a search, and only the tokenizer's view of the
 * line tells a use of a class from the first word of a sentence about it.
 */

/**
 * What a run of characters is to the tokenizer. `doc` is a `##` comment alone on its line, which
 * Godot builds documentation from; `nodePath` is the bare `$Path/To/Node` and `%Unique` forms, whose
 * words are node names rather than identifiers.
 */
export type RegionKind = 'code' | 'string' | 'comment' | 'doc' | 'nodePath';

export interface Region {
  readonly kind: RegionKind;
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
}

const IDENTIFIER_START = /[\p{L}_]/u;
const IDENTIFIER_PART = /[\p{L}\p{N}_]/u;

function isIdentifierStart(character: string | undefined): boolean {
  return character !== undefined && IDENTIFIER_START.test(character);
}

function isIdentifierPart(character: string | undefined): boolean {
  return character !== undefined && IDENTIFIER_PART.test(character);
}

/**
 * Whether a `%` at [param at] starts a unique node name rather than taking a remainder. The parser
 * decides by position: in front of an operand it is the shorthand, after one it is the operator, so
 * `a % Told.LOUD` is arithmetic on a class constant and `%Told` is a node.
 */
function percentIsUniqueNode(source: string, at: number): boolean {
  const next = source[at + 1];
  if (!isIdentifierStart(next) && next !== '"' && next !== "'") {
    return false;
  }
  let back = at - 1;
  while (back >= 0 && (source[back] === ' ' || source[back] === '\t')) {
    back -= 1;
  }
  const before = source[back];
  if (before === undefined || before === '\n') {
    return true;
  }
  if (endsAnOperand(before)) {
    // An operand ends here, unless the word is a keyword that takes an expression after it.
    return takesAnExpression(source.slice(wordStartAt(source, back), back + 1));
  }
  return true;
}

/** Whether [param character] can be the last one of an operand. */
function endsAnOperand(character: string): boolean {
  return (
    isIdentifierPart(character) ||
    character === ')' ||
    character === ']' ||
    character === '"' ||
    character === "'"
  );
}

/** Where the identifier word ending at [param back] starts. */
function wordStartAt(source: string, back: number): number {
  let wordStart = back;
  while (wordStart > 0 && isIdentifierPart(source[wordStart - 1])) {
    wordStart -= 1;
  }
  return wordStart;
}

/** Whether [param word] is a keyword that takes an expression after it. */
function takesAnExpression(word: string): boolean {
  return ['return', 'and', 'or', 'not', 'in', 'is', 'as', 'if', 'elif', 'else', 'while', 'await'].includes(
    word,
  );
}

/** The end of the string literal whose opening quote is at [param at]. */
function stringEnd(source: string, at: number): number {
  const quote = source[at] ?? '"';
  const fence = source.startsWith(quote.repeat(3), at) ? quote.repeat(3) : quote;
  let end = at + fence.length;
  while (end < source.length && !source.startsWith(fence, end)) {
    // A single-quoted string ends at its line. An unterminated one is the tokenizer's error to
    // report, and treating the rest of the file as a string would hide every use after it.
    if (fence.length === 1 && source[end] === '\n') {
      return end;
    }
    // Raw strings keep the backslash but still do not end at an escaped quote, so both skip two.
    end += source[end] === '\\' ? 2 : 1;
  }
  return Math.min(end + fence.length, source.length);
}

/** The `#` comment starting at [param at], which is a `doc` comment when it is alone on its line. */
function commentRegion(source: string, at: number): Region {
  const lineEnd = source.indexOf('\n', at);
  const lineStart = source.lastIndexOf('\n', at - 1) + 1;
  const alone = source.slice(lineStart, at).trim() === '';
  return {
    kind: alone && source.startsWith('##', at) ? 'doc' : 'comment',
    start: at,
    end: lineEnd === -1 ? source.length : lineEnd,
  };
}

/** The string literal whose opening quote is at [param at], with its prefix and any `$` or `%`. */
function stringRegion(source: string, at: number): Region {
  // A prefix belongs to the literal: r for raw, & for a StringName, ^ for a NodePath.
  const prefixed =
    at > 0 && ['r', '&', '^'].includes(source[at - 1] ?? '') && !isIdentifierPart(source[at - 2]);
  const start = prefixed ? at - 1 : at;
  const dollar =
    source[start - 1] === '$' || (source[start - 1] === '%' && percentIsUniqueNode(source, start - 1));
  return {
    kind: dollar ? 'nodePath' : 'string',
    start: dollar ? start - 1 : start,
    end: stringEnd(source, at),
  };
}

function isNodePathPart(character: string | undefined): boolean {
  return isIdentifierPart(character) || character === '/' || character === '%';
}

/** The bare node path starting at the `$` or `%` at [param at], or null when no name follows it. */
function nodePathRegion(source: string, at: number): Region | null {
  let end = at + 1;
  while (end < source.length && isNodePathPart(source[end])) {
    end += 1;
  }
  return end > at + 1 ? { kind: 'nodePath', start: at, end } : null;
}

/** The comment, string or node path that starts at [param at], or null when code goes on there. */
function regionStartingAt(source: string, at: number): Region | null {
  const here = source[at];
  if (here === '#') {
    return commentRegion(source, at);
  }
  if (here === '"' || here === "'") {
    return stringRegion(source, at);
  }
  if (here === '$' || (here === '%' && percentIsUniqueNode(source, at))) {
    return nodePathRegion(source, at);
  }
  return null;
}

/** The offset after the identifier starting at [param at]. */
function identifierEnd(source: string, at: number): number {
  let end = at;
  while (end < source.length && isIdentifierPart(source[end])) {
    end += 1;
  }
  return end;
}

/** Every region of [param source], in order and covering it without gaps. */
export function regionsOf(source: string): Region[] {
  const regions: Region[] = [];
  let codeStart = 0;
  let at = 0;
  while (at < source.length) {
    const region = regionStartingAt(source, at);
    if (region === null) {
      // A whole identifier is skipped at once, so a quote or `#` is never read from inside a word.
      at = isIdentifierStart(source[at]) ? identifierEnd(source, at) : at + 1;
      continue;
    }
    if (codeStart < region.start) {
      regions.push({ kind: 'code', start: codeStart, end: region.start });
    }
    regions.push(region);
    codeStart = region.end;
    at = region.end;
  }
  if (codeStart < source.length) {
    regions.push({ kind: 'code', start: codeStart, end: source.length });
  }
  return regions;
}

/**
 * [param source] with everything but code blanked to spaces, line breaks kept, so every offset and
 * line still lines up with the original and a pattern run over it sees no prose and no string.
 */
export function codeOf(source: string, regions: readonly Region[] = regionsOf(source)): string {
  let code = '';
  for (const region of regions) {
    const text = source.slice(region.start, region.end);
    code += region.kind === 'code' ? text : text.replace(/[^\n]/g, ' ');
  }
  return code;
}

/** Where an offset is, as the language server protocol counts: zero-based line and column. */
export interface Position {
  readonly line: number;
  readonly character: number;
}

/** Turns offsets into positions and back for one text. */
export class Lines {
  private readonly starts: number[] = [0];
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
    for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
      this.starts.push(at + 1);
    }
  }

  positionOf(offset: number): Position {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((this.starts[middle] ?? 0) <= offset) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return { line: low, character: offset - (this.starts[low] ?? 0) };
  }

  offsetOf(position: Position): number | null {
    const start = this.starts[position.line];
    if (start === undefined) {
      return null;
    }
    const offset = start + position.character;
    return offset > this.text.length ? null : offset;
  }

  /** The text of the line holding [param offset], without its line break. */
  lineAt(offset: number): string {
    const { line } = this.positionOf(offset);
    const start = this.starts[line] ?? 0;
    const end = this.starts[line + 1] ?? this.text.length + 1;
    return this.text.slice(start, end - 1).replace(/\r$/, '');
  }
}

/** One whole-word occurrence of a name, and what the tokenizer makes of the place it is in. */
export interface Occurrence {
  readonly offset: number;
  readonly kind: RegionKind;
  /** In code, straight after a `.`: a member of something, never a global name. */
  readonly afterDot: boolean;
  /** In code, the keyword declaring it there, such as var or func, when it is being declared. */
  readonly declaredAs: string | null;
}

const DECLARING = new Set(['var', 'const', 'func', 'signal', 'enum', 'class', 'for', 'class_name']);

function escapedForPattern(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/** A pattern matching [param name] as a whole word. */
function wholeWord(name: string, flags = 'gu'): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapedForPattern(name)}(?![\\p{L}\\p{N}_])`, flags);
}

/** The word of [param code] ending at [param end] after any spaces, and where it starts. */
function wordBefore(code: string, end: number): { word: string; start: number } {
  let last = end;
  while (last >= 0 && /\s/.test(code[last] ?? '')) {
    last -= 1;
  }
  let start = last + 1;
  while (start > 0 && isIdentifierPart(code[start - 1])) {
    start -= 1;
  }
  return { word: code.slice(start, last + 1), start };
}

/**
 * Whether a name whose code before it ends at [param back] opens a parameter: it follows the `(` or
 * a `,` of a parameter list, as in `func h(Foe: int)` or a lambda's `func(Foe)`.
 */
function isParameterAt(code: string, back: number): boolean {
  if (code[back] !== '(' && code[back] !== ',') {
    return false;
  }
  const open = openingParenBefore(code, back);
  if (open < 0) {
    return false;
  }
  const callee = wordBefore(code, open - 1);
  return callee.word === 'func' || (callee.word !== '' && wordBefore(code, callee.start - 1).word === 'func');
}

/** Where the bracket group holding [param back] opens, or -1 when it sits in a `[` or `{`. */
function openingParenBefore(code: string, back: number): number {
  let depth = 0;
  for (let open = back; open >= 0; open -= 1) {
    const at = code[open];
    if (at === ')' || at === ']' || at === '}') {
      depth += 1;
    } else if (at === '(' && depth === 0) {
      return open;
    } else if (at === '[' || at === '{') {
      if (depth === 0) {
        return -1;
      }
      depth -= 1;
    } else if (at === '(') {
      depth -= 1;
    }
  }
  return -1;
}

/** What the code before the name at [param offset] says about it, read off [param code]. */
function codeContextOf(code: string, offset: number): Pick<Occurrence, 'afterDot' | 'declaredAs'> {
  let back = offset - 1;
  while (back >= 0 && /[\s\\]/.test(code[back] ?? '')) {
    back -= 1;
  }
  let wordStart = back + 1;
  while (wordStart > 0 && isIdentifierPart(code[wordStart - 1])) {
    wordStart -= 1;
  }
  const word = code.slice(wordStart, back + 1);
  return {
    afterDot: code[back] === '.' && code[back - 1] !== '.',
    declaredAs: DECLARING.has(word) ? word : isParameterAt(code, back) ? 'parameter' : null,
  };
}

/** Every whole-word occurrence of [param name] in [param source], in any region. */
export function occurrencesOf(
  source: string,
  name: string,
  regions: readonly Region[] = regionsOf(source),
): Occurrence[] {
  const found: Occurrence[] = [];
  let index = 0;
  // What comes before a name is read off the code alone, comments and strings blanked: read off
  // the text, a full stop ending a comment line makes a class used at the start of the next line
  // read as a member after a dot.
  let code: string | null = null;
  for (const match of source.matchAll(wholeWord(name))) {
    const offset = match.index;
    while (index < regions.length - 1 && (regions[index]?.end ?? 0) <= offset) {
      index += 1;
    }
    const kind = regions[index]?.kind ?? 'code';
    if (kind === 'code') {
      code ??= codeOf(source, regions);
      found.push({ offset, kind, ...codeContextOf(code, offset) });
    } else {
      found.push({ offset, kind, afterDot: false, declaredAs: null });
    }
  }
  return found;
}

/** What a class body declares at its own level. */
export type DeclarationKind = 'func' | 'var' | 'const' | 'signal' | 'enum' | 'class' | 'enumValue';

interface Declaration {
  readonly name: string;
  readonly kind: DeclarationKind;
  /** Where the name itself is, which is where a language server is asked about it. */
  readonly offset: number;
  readonly isStatic: boolean;
}

/** A class body: the script's own, or an inner class, with what it extends as written. */
export interface ClassBody {
  /** Null for the script's own body. */
  readonly name: string | null;
  /** The extends clause as written: an identifier, a dotted name, or a quoted path. Null for none. */
  readonly extendsAs: string | null;
  readonly declarations: Declaration[];
  readonly inner: ClassBody[];
  /** Where the body's lines start and end, as offsets. */
  readonly start: number;
  readonly end: number;
}

export interface ScriptShape {
  readonly className: { readonly name: string; readonly offset: number } | null;
  readonly body: ClassBody;
}

const NAME = '[\\p{L}_][\\p{L}\\p{N}_]*';
const ANNOTATIONS = '(?:@[\\p{L}_][\\p{L}\\p{N}_]*(?:\\([^)]*\\))?\\s+)*';
/** The keywords a declaration line opens with, each the kind of what it declares. */
const DECLARATION_KEYWORDS = [
  'func',
  'var',
  'const',
  'signal',
  'enum',
  'class',
] as const satisfies readonly DeclarationKind[];
const DECLARATION_LINE = new RegExp(
  `^(${ANNOTATIONS})(static\\s+)?(${DECLARATION_KEYWORDS.join('|')})\\s+(${NAME})`,
  'u',
);
const CLASS_NAME_LINE = new RegExp(`^${ANNOTATIONS}class_name\\s+(${NAME})`, 'u');
const EXTENDS_LINE = new RegExp(`^${ANNOTATIONS}(?:class_name\\s+${NAME}\\s+)?extends\\s`, 'u');
const EXTENDS_CLAUSE = /\bextends(?=\s)/u;

/** The extends target written at [param from] in the original text: a quoted path or a dotted name. */
function extendsTarget(source: string, code: string, after: number): string | null {
  // Skipped in the original text, since in the code a quoted path is blanked to the same spaces.
  let from = after;
  while (source[from] === ' ' || source[from] === '\t') {
    from += 1;
  }
  const quote = source[from];
  if (quote === '"' || quote === "'") {
    const end = source.indexOf(quote, from + 1);
    return end === -1 ? null : source.slice(from, end + 1);
  }
  const dotted = new RegExp(`^${NAME}(?:\\.${NAME})*`, 'u').exec(code.slice(from));
  return dotted?.[0] ?? null;
}

interface SourceLine {
  readonly start: number;
  readonly text: string;
  readonly indent: number;
}

/** What reading a script's lines needs, and the class_name found along the way. */
interface ShapeReader {
  readonly source: string;
  readonly code: string;
  readonly lines: readonly SourceLine[];
  className: ScriptShape['className'];
}

/** A body being read: what it holds so far and the line the reader is at. */
interface BodyState {
  readonly declarations: Declaration[];
  readonly inner: ClassBody[];
  openEnum: { from: number; text: string } | null;
  index: number;
  extendsAs: string | null;
}

/** A line at its body's own level, with the text after its indentation and where that starts. */
interface MemberLine {
  readonly line: SourceLine;
  readonly text: string;
  readonly at: number;
}

/** The enum as it stands: its values collected where it holds the closing brace, else still open. */
function settleEnum(
  open: { from: number; text: string },
  declarations: Declaration[],
): BodyState['openEnum'] {
  if (!open.text.includes('}')) {
    return open;
  }
  collectEnumValues(open.text, open.from, declarations);
  return null;
}

/** Adds one more line to an enum left open. */
function continueEnum(
  open: { from: number; text: string },
  lineText: string,
  declarations: Declaration[],
): BodyState['openEnum'] {
  open.text += `\n${lineText}`;
  return settleEnum(open, declarations);
}

/** Starts reading the enum whose opening brace is at [param brace] of the member's text. */
function startEnum(member: MemberLine, brace: number, declarations: Declaration[]): BodyState['openEnum'] {
  return settleEnum({ from: member.at + brace, text: member.text.slice(brace) }, declarations);
}

/**
 * Reads a line of the script's own body for its class_name and extends clause. The first extends
 * clause wins, and the class_name of the last line naming one.
 */
function readHeaderLine(reader: ShapeReader, member: MemberLine, extendsAs: string | null): string | null {
  const { text, at } = member;
  const named = CLASS_NAME_LINE.exec(text);
  if (named?.[1] !== undefined) {
    reader.className = { name: named[1], offset: at + named[0].length - named[1].length };
  }
  if (extendsAs !== null || !(EXTENDS_LINE.test(text) || named !== null)) {
    return extendsAs;
  }
  return extendsOn(reader, member);
}

/** The class [param member]'s `extends` clause names, or null where the line holds none. */
function extendsOn(reader: ShapeReader, member: MemberLine): string | null {
  const clause = EXTENDS_CLAUSE.exec(member.text);
  return clause === null
    ? null
    : extendsTarget(reader.source, reader.code, member.at + clause.index + clause[0].length);
}

/** Reads the inner class declared on [param member], and returns the index of the line after it. */
function readInnerClass(
  reader: ShapeReader,
  state: BodyState,
  member: MemberLine,
  declared: RegExpExecArray,
  name: string,
  indent: number,
): number {
  const [whole] = declared;
  const clause = EXTENDS_CLAUSE.exec(member.text.slice(whole.length));
  const innerExtends =
    clause === null
      ? null
      : extendsTarget(reader.source, reader.code, member.at + whole.length + clause.index + clause[0].length);
  const childIndent =
    reader.lines.slice(state.index + 1).find((next) => next.text.trim() !== '')?.indent ?? indent + 1;
  if (childIndent > indent) {
    const parsed = parseBody(reader, name, innerExtends, state.index + 1, childIndent, member.line.start);
    state.inner.push(parsed.body);
    return parsed.next;
  }
  state.inner.push({
    name,
    extendsAs: innerExtends,
    declarations: [],
    inner: [],
    start: member.line.start,
    end: member.line.start + member.line.text.length,
  });
  return state.index + 1;
}

/** Reads the declaration on [param member] into [param state], and returns the next line's index. */
function readDeclaration(
  reader: ShapeReader,
  state: BodyState,
  member: MemberLine,
  declared: RegExpExecArray,
  indent: number,
): number {
  const [whole, , isStatic, keyword, name] = declared;
  const kind = DECLARATION_KEYWORDS.find((one) => one === keyword);
  if (kind === undefined || name === undefined) {
    return state.index + 1;
  }
  const offset = member.at + whole.length - name.length;
  state.declarations.push({ name, kind, offset, isStatic: isStatic !== undefined });
  if (kind === 'class') {
    return readInnerClass(reader, state, member, declared, name, indent);
  }
  const brace = member.text.indexOf('{');
  if (kind === 'enum' && brace !== -1) {
    state.openEnum = startEnum(member, brace, state.declarations);
  }
  return state.index + 1;
}

/** Reads one line at the body's own level into [param state], and moves it to the next line. */
function readMemberLine(
  reader: ShapeReader,
  state: BodyState,
  line: SourceLine,
  isScriptBody: boolean,
  indent: number,
): void {
  const member: MemberLine = { line, text: line.text.slice(line.indent), at: line.start + line.indent };
  if (isScriptBody) {
    state.extendsAs = readHeaderLine(reader, member, state.extendsAs);
  } else if (state.extendsAs === null && EXTENDS_LINE.test(member.text)) {
    // An inner class may name its base on the line after its own, as `extends Base`.
    state.extendsAs = extendsOn(reader, member);
  }
  const declared = DECLARATION_LINE.exec(member.text);
  if (declared !== null) {
    state.index = readDeclaration(reader, state, member, declared, indent);
    return;
  }
  if (/^enum\s*\{/u.test(member.text)) {
    // An unnamed enum's values are constants of the class itself.
    state.openEnum = startEnum(member, member.text.indexOf('{'), state.declarations);
  }
  state.index += 1;
}

/** Reads the class body whose members sit at [param indent], from line [param from] onwards. */
function parseBody(
  reader: ShapeReader,
  name: string | null,
  extendsAs: string | null,
  from: number,
  indent: number,
  bodyStart: number,
): { body: ClassBody; next: number } {
  const state: BodyState = { declarations: [], inner: [], openEnum: null, index: from, extendsAs };
  while (state.index < reader.lines.length) {
    const line = reader.lines[state.index];
    if (line === undefined) {
      break;
    }
    // Before blank lines are passed over, because the enum's text has to keep every line for its
    // offsets to stay those of the file.
    if (state.openEnum !== null) {
      state.openEnum = continueEnum(state.openEnum, line.text, state.declarations);
      state.index += 1;
    } else if (line.text.trim() === '' || line.indent > indent) {
      state.index += 1;
    } else if (line.indent < indent) {
      break;
    } else {
      readMemberLine(reader, state, line, name === null, indent);
    }
  }
  const last = reader.lines[state.index - 1];
  return {
    body: {
      name,
      extendsAs: state.extendsAs,
      declarations: state.declarations,
      inner: state.inner,
      start: bodyStart,
      end: last === undefined ? bodyStart : last.start + last.text.length,
    },
    next: state.index,
  };
}

/** What [param source] declares: its class_name, its own members, and its inner classes, nested. */
export function shapeOf(source: string): ScriptShape {
  const code = codeOf(source, regionsOf(source));
  const lines: SourceLine[] = [];
  let start = 0;
  for (const text of code.split('\n')) {
    lines.push({ start, text, indent: indentOf(text) });
    start += text.length + 1;
  }
  const reader: ShapeReader = { source, code, lines, className: null };
  const { body } = parseBody(reader, null, null, 0, 0, 0);
  return { className: reader.className, body };
}

const FUNC_LINE = new RegExp(`^[ \\t]*${ANNOTATIONS}(?:static\\s+)?func\\s+(${NAME})\\s*\\(`, 'u');

function indentOf(text: string): number {
  return /^[ \t]*/.exec(text)?.[0].length ?? 0;
}

/**
 * The named function holding one-based [param line] of [param source], or null for a line at a
 * class's own level.
 *
 * Found by walking up to each line indented less than the last, so a lambda's own `func(` line and
 * the blocks around it are passed through on the way to the declaration holding them all. Read off
 * the code, so a line of a multi-line string that begins `func` is not taken for a declaration.
 */
export function enclosingFunction(source: string, line: number, code = codeOf(source)): string | null {
  const lines = code.split('\n');
  const at = lines[line - 1];
  if (at === undefined) {
    return null;
  }
  // A function written on one line holds what is on that line.
  const own = FUNC_LINE.exec(at);
  if (own?.[1] !== undefined) {
    return own[1];
  }
  let indent = indentOf(at);
  for (let index = line - 2; index >= 0 && indent > 0; index -= 1) {
    const text = lines[index] ?? '';
    if (text.trim() === '' || indentOf(text) >= indent) {
      continue;
    }
    indent = indentOf(text);
    const declared = FUNC_LINE.exec(text);
    if (declared?.[1] !== undefined) {
      return declared[1];
    }
  }
  return null;
}

const SUPER_CALL = /(?<![\p{L}\p{N}_.])super\s*[.(]/u;
const LAMBDA_HEADER = new RegExp(`(?<![\\p{L}\\p{N}_])func(?:\\s+${NAME})?\\s*\\(`, 'u');

/**
 * Where the body of the function header starting at [param from] in [param text] begins: past the
 * parameters' closing bracket, a return type and the colon. -1 when the header does not end there.
 */
function afterHeader(text: string, from: number): number {
  let depth = 0;
  for (let at = text.indexOf('(', from); at !== -1 && at < text.length; at += 1) {
    if (text[at] === '(') {
      depth += 1;
    } else if (text[at] === ')') {
      depth -= 1;
      if (depth === 0) {
        const colon = text.indexOf(':', at);
        return colon === -1 ? -1 : colon + 1;
      }
    }
  }
  return -1;
}

/** Why a line holding code is one the engine never stops on. */
type NoStop =
  | { readonly kind: 'declaration' | 'else' }
  | { readonly kind: 'continuation'; readonly of: number };

/**
 * Per zero-based line of [param lines], the zero-based line of the statement it continues, or null
 * where it continues none: a line within brackets left open, or after a line ending in a
 * backslash. A lambda written inside brackets has statements of its own on the lines after it, so
 * from one onwards only a line opening with the closing bracket is a continuation.
 */
function continuationLines(lines: readonly string[]): Array<number | null> {
  const inside: Array<number | null> = [];
  let depth = 0;
  let lambda = false;
  let backslash = false;
  let start = 0;
  for (const [index, text] of lines.entries()) {
    const continues = backslash || (depth > 0 && (!lambda || /^\s*[)\]}]/u.test(text)));
    inside.push(continues ? start : null);
    if (!backslash && depth === 0) {
      start = index;
    }
    const scanned = scanBrackets(text, depth, lambda);
    depth = scanned.depth;
    lambda = depth > 0 && scanned.lambda;
    backslash = text.trimEnd().endsWith('\\');
  }
  return inside;
}

/** +1 for an opening bracket, -1 for a closing one, 0 for anything else. */
function bracketDelta(character: string | undefined): number {
  if (character === '(' || character === '[' || character === '{') {
    return 1;
  }
  return character === ')' || character === ']' || character === '}' ? -1 : 0;
}

/** Whether the word `func` starting at [param at] of [param text] opens a lambda. */
function lambdaStartsAt(text: string, at: number): boolean {
  return (
    text[at] === 'f' &&
    !/[\p{L}\p{N}_]/u.test(text[at - 1] ?? '') &&
    LAMBDA_HEADER.exec(text.slice(at))?.index === 0
  );
}

/** The bracket depth after [param text], and whether a lambda opened inside brackets on the way. */
function scanBrackets(text: string, depth: number, lambda: boolean): { depth: number; lambda: boolean } {
  let open = depth;
  let inLambda = lambda;
  for (let at = 0; at < text.length; at += 1) {
    open = Math.max(0, open + bracketDelta(text[at]));
    if (open > 0 && lambdaStartsAt(text, at)) {
      inLambda = true;
    }
  }
  return { depth: open, lambda: inLambda };
}

/**
 * Whether zero-based [param index] of [param lines] is at a class's own level: not in the body of
 * a function or a lambda. False wherever that cannot be told, since it only ever leads to a refusal.
 */
function atClassLevel(lines: readonly string[], index: number): boolean {
  let indent = indentOf(lines[index] ?? '');
  for (let at = index - 1; at >= 0 && indent > 0; at -= 1) {
    const text = lines[at] ?? '';
    if (text.trim() === '' || indentOf(text) >= indent) {
      continue;
    }
    indent = indentOf(text);
    // A property's get and set are function bodies too.
    if (FUNC_LINE.test(text) || LAMBDA_HEADER.test(text) || /^[ \t]*(?:get|set)\s*[(:]/u.test(text)) {
      return false;
    }
    if (new RegExp(`^[ \\t]*class\\s+${NAME}`, 'u').test(text)) {
      return true;
    }
  }
  return indent === 0;
}

const ANNOTATIONS_ONLY = new RegExp(`^${ANNOTATIONS}@?${NAME}?(?:\\([^)]*\\))?\\s*$`, 'u');

/**
 * Why the engine never stops on one-based [param line] of [param source], a line holding code, or
 * null where it may.
 *
 * Godot's compiler marks the line each statement starts on, each match branch, and each member
 * variable with a type or a value, and a breakpoint stops only on a marked line
 * (modules/gdscript/gdscript_compiler.cpp). A function's header, an else, a declaration and the
 * later lines of a statement are never marked. A line this cannot read for certain is null.
 */
export function neverStopsOn(source: string, line: number, code = codeOf(source)): NoStop | null {
  const lines = code.split('\n');
  const text = lines[line - 1];
  if (text === undefined || text.trim() === '') {
    return null;
  }
  const of = continuationLines(lines)[line - 1];
  if (of !== null && of !== undefined) {
    return { kind: 'continuation', of: of + 1 };
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('@') && ANNOTATIONS_ONLY.test(trimmed)) {
    return { kind: 'declaration' };
  }
  const rest = trimmed.replace(new RegExp(`^${ANNOTATIONS}`, 'u'), '');
  const word = /^(?:static\s+)?([a-z_]+)/u.exec(rest)?.[1] ?? '';
  return NO_STOP_BY_WORD.get(word)?.(rest, { code, lines, index: line - 1 }) ?? null;
}

interface NoStopContext {
  readonly code: string;
  readonly lines: readonly string[];
  /** Zero-based. */
  readonly index: number;
}

/** The answer for a line whose first word decides it, [param rest] being the line after annotations. */
type NoStopRule = (rest: string, context: NoStopContext) => NoStop | null;

function declarationWhen(applies: boolean): NoStop | null {
  return applies ? { kind: 'declaration' } : null;
}

// The class's own line is marked for a call of _static_init.
const classHeadingRule: NoStopRule = (_rest, { code }) => declarationWhen(!/\b_static_init\b/u.test(code));

const classRule: NoStopRule = (rest) =>
  declarationWhen(new RegExp(`^class\\s+${NAME}[^:]*:\\s*$`, 'u').test(rest));

const funcRule: NoStopRule = (rest) => {
  if (!new RegExp(`^(?:static\\s+)?func\\s+${NAME}`, 'u').test(rest)) {
    return null;
  }
  const body = afterHeader(rest, 0);
  return declarationWhen(body === -1 || rest.slice(body).trim() === '');
};

// A property's get or set header, which no call ends with a colon alone on its line.
const accessorRule: NoStopRule = (rest) => declarationWhen(/^(?:get|set\s*\([^)]*\))\s*:\s*$/u.test(rest));

const elseRule: NoStopRule = (rest) => (/^else\s*:\s*$/u.test(rest) ? { kind: 'else' } : null);

const constRule: NoStopRule = (_rest, { lines, index }) => declarationWhen(atClassLevel(lines, index));

const varRule: NoStopRule = (rest, { lines, index }) =>
  declarationWhen(
    atClassLevel(lines, index) && new RegExp(`^(?:static\\s+)?var\\s+${NAME}\\s*$`, 'u').test(rest),
  );

const NO_STOP_BY_WORD: ReadonlyMap<string, NoStopRule> = new Map([
  ['signal', () => declarationWhen(true)],
  ['enum', () => declarationWhen(true)],
  ['extends', classHeadingRule],
  ['class_name', classHeadingRule],
  ['class', classRule],
  ['func', funcRule],
  ['get', accessorRule],
  ['set', accessorRule],
  ['else', elseRule],
  ['const', constRule],
  ['var', varRule],
]);

/**
 * Whether the function whose body's first statement is on one-based [param line] of [param code]
 * calls through `super` in its own body, not in a lambda written in it. [param code] is a script as
 * `codeOf` gives it, so `super` in a comment or a string is not read; [param lambda] says which of a
 * named function and a lambda starting on the same line is meant, since both are recorded there.
 */
export function bodyCallsSuper(code: string, line: number, lambda: boolean): boolean {
  const lines = code.split('\n');
  const first = lines[line - 1];
  if (first === undefined) {
    return false;
  }
  const inline = bodyOnHeaderLine(first, lambda);
  if (inline !== null) {
    return SUPER_CALL.test(inline);
  }
  return superInBlock(lines, line - 1, indentOf(first));
}

/** Whether `super` is called in the block at [param indent] that starts at zero-based [param from]. */
function superInBlock(lines: readonly string[], from: number, indent: number): boolean {
  let lambdaIndent: number | null = null;
  for (let index = from; index < lines.length; index += 1) {
    const text = lines[index] ?? '';
    if (text.trim() === '') {
      continue;
    }
    const at = indentOf(text);
    if (at < indent) {
      break;
    }
    if (lambdaIndent !== null && at > lambdaIndent) {
      continue;
    }
    lambdaIndent = null;
    // A lambda's code is its own row: what comes before its header is this function's.
    const inner = LAMBDA_HEADER.exec(text);
    if (SUPER_CALL.test(text.slice(0, inner?.index))) {
      return true;
    }
    if (inner !== null && headerEndsLine(text, inner.index)) {
      lambdaIndent = at;
    }
  }
  return false;
}

/** The body written after the function or lambda header on [param first], or null when it has none. */
function bodyOnHeaderLine(first: string, lambda: boolean): string | null {
  // A body written on its header's line, which is then the line recorded for it.
  const header = lambda ? LAMBDA_HEADER.exec(first) : FUNC_LINE.exec(first);
  if (header === null) {
    return null;
  }
  const body = afterHeader(first, header.index);
  return body !== -1 && first.slice(body).trim() !== '' ? first.slice(body) : null;
}

/** Whether the header at [param from] in [param text] is all of its line, its body starting below. */
function headerEndsLine(text: string, from: number): boolean {
  const body = afterHeader(text, from);
  return body !== -1 && text.slice(body).trim() === '';
}

/** A place in a script that names a function, outside its declaration. */
export interface CallSite {
  /** One-based. */
  readonly line: number;
  /** The named function the place is in, or null at a class's own level. */
  readonly within: string | null;
  /**
   * For a function: true when it is called there, false when it is named without a call, as a
   * Callable passed on. Absent for a property, which is never called.
   */
  readonly called?: boolean;
  /** For a property: whether the place assigns it, which runs its set block, or reads it. */
  readonly access?: 'read' | 'write';
}

/** An assignment to what comes before it, compound ones included: `=` and `+=` but not `==`. */
const ASSIGNED = /^(?:\*\*|<<|>>|[-+*/%&|^])?=(?!=)/;

/** The names a function or lambda header starting at [param from] in [param text] takes. */
function parametersOf(text: string, from: number): string[] {
  const open = text.indexOf('(', from);
  if (open === -1) {
    return [];
  }
  const names: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let at = open; at < text.length; at += 1) {
    const here = text[at];
    depth += bracketDelta(here);
    if ((here === ',' && depth === 1) || depth === 0) {
      const named = new RegExp(`^\\s*(${NAME})`, 'u').exec(text.slice(start, at));
      if (named?.[1] !== undefined) {
        names.push(named[1]);
      }
      start = at + 1;
      if (depth === 0) {
        break;
      }
    }
  }
  return names;
}

const DOTTED = `${NAME}(?:\\.${NAME})*`;

/**
 * The class [param text], a line declaring [param name], gives it: written after a colon, the class
 * whose `new()` it is assigned, or the class it is cast to with `as`. Its last part for a dotted
 * inner class, and null when the line says none.
 */
function declaredClass(text: string, name: string): string | null {
  const word = `(?<![\\p{L}\\p{N}_.])${escapedForPattern(name)}`;
  const found =
    new RegExp(`${word}\\s*:\\s*(${DOTTED})`, 'u').exec(text)?.[1] ??
    new RegExp(`${word}\\s*:=\\s*(${DOTTED})\\.new\\s*\\(`, 'u').exec(text)?.[1] ??
    new RegExp(`${word}\\s*:?=[^\\n]*?\\bas\\s+(${DOTTED})\\s*$`, 'u').exec(text)?.[1];
  return found ?? null;
}

/**
 * [param name] as a local at zero-based [param index] of [param lines], the script's code split by
 * line, with the class its declaration gives it, or null when it is not one. A local is a parameter
 * of the function or a lambda around it, a `for` variable, a `var` or `const` declared earlier in a
 * block still open, or a `var` a match pattern binds.
 *
 * Walked upwards: a line indented less than the last is a block holding this one, and a line at the
 * same depth is an earlier statement of the same block, whose declarations are in scope. Lines more
 * deeply indented belong to blocks already closed, so what they declare is not.
 */
function localAt(lines: readonly string[], index: number, name: string): { type: string | null } | null {
  const word = escapedForPattern(name);
  const declares = new RegExp(`(?<![\\p{L}\\p{N}_.])(?:var|const)\\s+${word}(?![\\p{L}\\p{N}_])`, 'u');
  const iterates = new RegExp(`^\\s*for\\s+${word}(?![\\p{L}\\p{N}_])`, 'u');
  const local = (text: string): { type: string | null } => ({ type: declaredClass(text, name) });
  const own = lines[index] ?? '';
  const headerOnOwnLine = FUNC_LINE.exec(own) ?? LAMBDA_HEADER.exec(own);
  if (headerOnOwnLine !== null && parametersOf(own, headerOnOwnLine.index).includes(name)) {
    return local(own);
  }
  if (FUNC_LINE.test(own)) {
    return null;
  }
  let depth = indentOf(own);
  for (let at = index - 1; at >= 0; at -= 1) {
    const text = lines[at] ?? '';
    const indent = indentOf(text);
    if (text.trim() === '' || indent > depth) {
      continue;
    }
    const enclosing = indent < depth;
    depth = indent;
    const verdict = scopeVerdict(text, name, enclosing, depth === 0, { declares, iterates });
    if (verdict === 'binds') {
      return local(text);
    }
    if (verdict === 'ends') {
      return null;
    }
  }
  return null;
}

/**
 * What the line [param text], above the line asked about, says of the local [param name]: that it
 * binds it, that the walk upwards ends there, or neither. [param enclosing] is whether the line
 * holds the asked-about line in a block, and [param atTop] whether it is at a class's own level.
 */
function scopeVerdict(
  text: string,
  name: string,
  enclosing: boolean,
  atTop: boolean,
  patterns: { readonly declares: RegExp; readonly iterates: RegExp },
): 'binds' | 'ends' | 'passes' {
  const named = FUNC_LINE.exec(text);
  if (named !== null) {
    return enclosing && parametersOf(text, named.index).includes(name) ? 'binds' : 'ends';
  }
  const lambda = LAMBDA_HEADER.exec(text);
  const bindsAsHeader =
    enclosing &&
    ((lambda !== null && parametersOf(text, lambda.index).includes(name)) || patterns.iterates.test(text));
  if (bindsAsHeader) {
    return 'binds';
  }
  if (atTop) {
    return 'ends';
  }
  return patterns.declares.test(text) ? 'binds' : 'passes';
}

/** The index of the last character before [param at] in [param code] that is not white space. */
function backOverSpace(code: string, at: number): number {
  let index = at;
  while (index >= 0 && /\s/.test(code[index] ?? '')) {
    index -= 1;
  }
  return index;
}

/**
 * The names joined by dots that end with the receiver starting at [param start], as `Alpha.Box`, or
 * null where something other than a name comes before a dot.
 */
function receiverPath(code: string, start: number, name: string): string | null {
  let path = name;
  let dot = backOverSpace(code, start - 1);
  while (code[dot] === '.') {
    const end = backOverSpace(code, dot - 1);
    let from = end + 1;
    while (from > 0 && isIdentifierPart(code[from - 1])) {
      from -= 1;
    }
    if (from > end) {
      return null;
    }
    path = `${code.slice(from, end + 1)}.${path}`;
    dot = backOverSpace(code, from - 1);
  }
  return path;
}

/**
 * The identifier written before the dot that ends just before [param offset] in [param code],
 * whether it is itself a member of something written before it, and the whole dotted path it ends.
 */
function receiverBefore(
  code: string,
  offset: number,
): { name: string; dotted: boolean; path: string | null } | null {
  const dot = backOverSpace(code, offset - 1);
  if (code[dot] !== '.') {
    return null;
  }
  const at = backOverSpace(code, dot - 1);
  let start = at + 1;
  while (start > 0 && isIdentifierPart(code[start - 1])) {
    start -= 1;
  }
  if (start > at) {
    return null;
  }
  const name = code.slice(start, at + 1);
  const dotted = code[backOverSpace(code, start - 1)] === '.';
  return { name, dotted, path: receiverPath(code, start, name) };
}

/** What a class declares by a name that, written bare in it, means that member and no function. */
const MEMBER_KINDS: ReadonlySet<DeclarationKind> = new Set(['var', 'const', 'signal', 'enum', 'enumValue']);

/** The innermost class body under [param body] holding [param offset]. */
function bodyHolding(body: ClassBody, offset: number): ClassBody {
  const inner = body.inner.find((one) => one.start <= offset && offset <= one.end);
  return inner === undefined ? body : bodyHolding(inner, offset);
}

/**
 * Where [param source] names [param name] in code, other than declaring it: as a call, a member
 * call on anything, or a Callable handed to something that calls it later. Comments and strings are
 * not code, so a function named in prose or by a string is not found.
 *
 * A bare name that is something else at that place is not the function: a parameter or local of
 * that name, or a variable, constant, signal or enum the class itself declares by it. Read as the
 * function, `made.bare_lift = lift` in a helper taking `lift: int` was listed as `lift` handed on
 * as a Callable.
 *
 * With [param property] the name is a variable's, whose get and set blocks run wherever it is read or
 * assigned, so the class's own variable of that name is what is being looked for rather than
 * something to pass over, and each place says which of the two it does. Inside those blocks the
 * name is the value stored, which the engine reads and writes without running them again, so
 * `sinks = value` in the set block of `sinks` is not a place that sets it.
 *
 * A use runs whichever function of that name the engine dispatches it to, and [param dispatch]
 * says whether that can be the one asked about: a bare `_settle()` in a script of an unrelated
 * class calls that script's own, and `made.lift(by)` with `var made: Outcome` above it is Outcome's.
 */
export function callSitesOf(
  source: string,
  name: string,
  property = false,
  dispatch: CallDispatch = EVERY_USE,
): CallSite[] {
  const regions = regionsOf(source);
  const code = codeOf(source, regions);
  const codeLines = code.split('\n');
  const lines = new Lines(source);
  const shape = shapeOf(source);
  const scan: CallScan = {
    source,
    name,
    property,
    code,
    codeLines,
    lines,
    shape,
    accessors: property ? accessorsIn(codeLines, lines, name, shape.body) : [],
    dispatch,
  };
  return occurrencesOf(source, name, regions)
    .filter((one) => one.kind === 'code' && one.declaredAs === null)
    .filter((one) => isCallSiteKept(scan, one))
    .map((one) => callSiteAt(scan, one));
}

/** Whether the uses of a name can reach the function asked about, by how each is written. */
export interface CallDispatch {
  /** A use at [param offset] written bare, through `self` or through `super`. */
  onSelf(offset: number, how: 'bare' | 'self' | 'super'): boolean;
  /**
   * A use through class [param name], or on a variable declared as it when [param onVariable].
   * Null where [param name] is no class the project declares.
   */
  throughClass(name: string, onVariable: boolean): boolean | null;
}

/** Every use reaches the function, as when no class was asked about. */
export const EVERY_USE: CallDispatch = { onSelf: () => true, throughClass: () => null };

/** What one `callSitesOf` call reads from, worked out once. */
interface CallScan {
  readonly source: string;
  readonly name: string;
  readonly property: boolean;
  readonly code: string;
  readonly codeLines: readonly string[];
  readonly lines: Lines;
  readonly shape: ScriptShape;
  /** The zero-based line ranges of the property's own get and set blocks. */
  readonly accessors: readonly (readonly [number, number])[];
  readonly dispatch: CallDispatch;
}

/**
 * A variable of the class body holding [param at], with the class it is declared as, read off its
 * own line, or null when the body declares none by that name.
 */
function memberAt(scan: CallScan, member: string, at: number): { type: string | null } | null {
  const declared = bodyHolding(scan.shape.body, at).declarations.find(
    (one) => one.name === member && (one.kind === 'var' || one.kind === 'const'),
  );
  return declared === undefined
    ? null
    : { type: declaredClass(scan.codeLines[scan.lines.positionOf(declared.offset).line] ?? '', member) };
}

/** The lines of the property's own get and set blocks: those indented under its declaration. */
function blockUnder(codeLines: readonly string[], declared: number): readonly [number, number] {
  const indent = (codeLines[declared] ?? '').search(/\S|$/);
  let last = declared;
  for (let index = declared + 1; index < codeLines.length; index += 1) {
    const text = codeLines[index] ?? '';
    if (text.trim() === '') {
      continue;
    }
    if (text.search(/\S/) <= indent) {
      break;
    }
    last = index;
  }
  return [declared, last];
}

function accessorsIn(
  codeLines: readonly string[],
  lines: Lines,
  name: string,
  body: ClassBody,
): (readonly [number, number])[] {
  return [
    ...body.declarations
      .filter((one) => one.kind === 'var' && one.name === name)
      .map((one) => blockUnder(codeLines, lines.positionOf(one.offset).line)),
    ...body.inner.flatMap((inner) => accessorsIn(codeLines, lines, name, inner)),
  ];
}

/** Whether a member call can reach the function asked about, by the class its receiver names. */
function isOwnMemberCall(scan: CallScan, offset: number, index: number): boolean {
  const receiver = receiverBefore(scan.code, offset);
  if (receiver === null) {
    return true;
  }
  // A local or a variable of the class shadows a class of the same name.
  const variable = receiver.dotted
    ? null
    : (localAt(scan.codeLines, index, receiver.name) ?? memberAt(scan, receiver.name, offset));
  if (variable !== null) {
    return variable.type === null || scan.dispatch.throughClass(variable.type, true) !== false;
  }
  return receiver.path === null || scan.dispatch.throughClass(receiver.path, false) !== false;
}

/** Whether a bare use of the name at [param offset] is the function, not a local or another member. */
function isBareFunctionUse(scan: CallScan, offset: number, index: number): boolean {
  if (localAt(scan.codeLines, index, scan.name) !== null) {
    return false;
  }
  return !bodyHolding(scan.shape.body, offset).declarations.some(
    (declared) =>
      declared.name === scan.name &&
      MEMBER_KINDS.has(declared.kind) &&
      !(scan.property && declared.kind === 'var'),
  );
}

function isCallSiteKept(scan: CallScan, one: Occurrence): boolean {
  const index = scan.lines.positionOf(one.offset).line;
  if (!one.afterDot && scan.accessors.some(([declared, last]) => index > declared && index <= last)) {
    return false;
  }
  if (!one.afterDot) {
    return isBareFunctionUse(scan, one.offset, index) && scan.dispatch.onSelf(one.offset, 'bare');
  }
  const receiver = receiverBefore(scan.code, one.offset);
  if (receiver !== null && !receiver.dotted && (receiver.name === 'self' || receiver.name === 'super')) {
    return scan.dispatch.onSelf(one.offset, receiver.name);
  }
  return isOwnMemberCall(scan, one.offset, index);
}

function callSiteAt(scan: CallScan, one: Occurrence): CallSite {
  const line = scan.lines.positionOf(one.offset).line + 1;
  const after = scan.code.slice(one.offset + scan.name.length).trimStart();
  const within = enclosingFunction(scan.source, line, scan.code);
  return scan.property
    ? { line, within, access: ASSIGNED.test(after) ? 'write' : 'read' }
    : { line, within, called: after.startsWith('(') };
}

/** The values of an enum whose braces open at [param from], as declarations of their own. */
function collectEnumValues(text: string, from: number, into: Declaration[]): void {
  const close = text.indexOf('}');
  const inside = text.slice(1, close === -1 ? text.length : close);
  for (const match of inside.matchAll(new RegExp(`(^|,)\\s*(${NAME})`, 'gu'))) {
    const valueName = match[2];
    if (valueName === undefined) {
      continue;
    }
    const offset = from + 1 + match.index + match[0].length - valueName.length;
    into.push({ name: valueName, kind: 'enumValue', offset, isStatic: true });
  }
}

/** GDScript's reserved words, which no class or member may be named. */
const KEYWORDS: ReadonlySet<string> = new Set([
  'and',
  'as',
  'assert',
  'await',
  'break',
  'breakpoint',
  'class',
  'class_name',
  'const',
  'continue',
  'elif',
  'else',
  'enum',
  'extends',
  'false',
  'for',
  'func',
  'if',
  'in',
  'is',
  'match',
  'namespace',
  'not',
  'null',
  'or',
  'pass',
  'preload',
  'return',
  'self',
  'signal',
  'static',
  'super',
  'trait',
  'true',
  'var',
  'void',
  'when',
  'while',
  'yield',
  'INF',
  'NAN',
  'PI',
  'TAU',
]);

/** Whether GDScript accepts [param name] as the name of a class or a member. */
export function isIdentifier(name: string): boolean {
  return new RegExp(`^${NAME}$`, 'u').test(name) && !KEYWORDS.has(name);
}
