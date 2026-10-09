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
  if (isIdentifierPart(before) || before === ')' || before === ']' || before === '"' || before === "'") {
    // An operand ends here, unless the word is a keyword that takes an expression after it.
    let wordStart = back;
    while (wordStart > 0 && isIdentifierPart(source[wordStart - 1])) {
      wordStart -= 1;
    }
    const word = source.slice(wordStart, back + 1);
    return ['return', 'and', 'or', 'not', 'in', 'is', 'as', 'if', 'elif', 'else', 'while', 'await'].includes(
      word,
    );
  }
  return true;
}

/** The end of the string literal whose opening quote is at [param at]. */
function stringEnd(source: string, at: number): number {
  const quote = source[at] ?? '"';
  const fence = source.startsWith(quote.repeat(3), at) ? quote.repeat(3) : quote;
  let end = at + fence.length;
  while (end < source.length && !source.startsWith(fence, end)) {
    // A single-quoted string ends at its line; an unterminated one is the tokenizer's error to
    // report, and treating the rest of the file as a string would hide every use after it.
    if (fence.length === 1 && source[end] === '\n') {
      return end;
    }
    // Raw strings keep the backslash but still do not end at an escaped quote, so both skip two.
    end += source[end] === '\\' ? 2 : 1;
  }
  return Math.min(end + fence.length, source.length);
}

/** Every region of [param source], in order and covering it without gaps. */
export function regionsOf(source: string): Region[] {
  const regions: Region[] = [];
  let codeStart = 0;
  let at = 0;
  const close = (kind: RegionKind, start: number, end: number): void => {
    if (codeStart < start) {
      regions.push({ kind: 'code', start: codeStart, end: start });
    }
    regions.push({ kind, start, end });
    codeStart = end;
    at = end;
  };
  while (at < source.length) {
    const here = source[at];
    if (here === '#') {
      const lineEnd = source.indexOf('\n', at);
      const end = lineEnd === -1 ? source.length : lineEnd;
      const lineStart = source.lastIndexOf('\n', at - 1) + 1;
      const alone = source.slice(lineStart, at).trim() === '';
      close(alone && source.startsWith('##', at) ? 'doc' : 'comment', at, end);
      continue;
    }
    if (here === '"' || here === "'") {
      // A prefix belongs to the literal: r for raw, & for a StringName, ^ for a NodePath.
      const prefixed =
        at > 0 && ['r', '&', '^'].includes(source[at - 1] ?? '') && !isIdentifierPart(source[at - 2]);
      const start = prefixed ? at - 1 : at;
      const dollar =
        source[start - 1] === '$' || (source[start - 1] === '%' && percentIsUniqueNode(source, start - 1));
      close(dollar ? 'nodePath' : 'string', dollar ? start - 1 : start, stringEnd(source, at));
      continue;
    }
    if (here === '$' || (here === '%' && percentIsUniqueNode(source, at))) {
      if (source[at + 1] === '"' || source[at + 1] === "'") {
        at += 1;
        continue;
      }
      let end = at + 1;
      while (
        end < source.length &&
        (isIdentifierPart(source[end]) || source[end] === '/' || source[end] === '%')
      ) {
        end += 1;
      }
      if (end > at + 1) {
        close('nodePath', at, end);
        continue;
      }
    }
    if (isIdentifierStart(here)) {
      while (at < source.length && isIdentifierPart(source[at])) {
        at += 1;
      }
      continue;
    }
    at += 1;
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
    let afterDot = false;
    let declaredAs: string | null = null;
    if (kind === 'code') {
      code ??= codeOf(source, regions);
      let back = offset - 1;
      while (back >= 0 && /[\s\\]/.test(code[back] ?? '')) {
        back -= 1;
      }
      afterDot = code[back] === '.' && code[back - 1] !== '.';
      let wordStart = back + 1;
      while (wordStart > 0 && isIdentifierPart(code[wordStart - 1])) {
        wordStart -= 1;
      }
      const word = code.slice(wordStart, back + 1);
      declaredAs = DECLARING.has(word) ? word : null;
    }
    found.push({ offset, kind, afterDot, declaredAs });
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
const DECLARATION_LINE = new RegExp(
  `^(${ANNOTATIONS})(static\\s+)?(func|var|const|signal|enum|class)\\s+(${NAME})`,
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

/** What [param source] declares: its class_name, its own members, and its inner classes, nested. */
export function shapeOf(source: string): ScriptShape {
  const regions = regionsOf(source);
  const code = codeOf(source, regions);
  const lines: { start: number; text: string; indent: number }[] = [];
  let start = 0;
  for (const text of code.split('\n')) {
    const indent = /^[ \t]*/.exec(text)?.[0].length ?? 0;
    lines.push({ start, text, indent });
    start += text.length + 1;
  }

  let className: ScriptShape['className'] = null;
  const parseBody = (
    name: string | null,
    extendsAs: string | null,
    from: number,
    indent: number,
    bodyStart: number,
  ): { body: ClassBody; next: number } => {
    const declarations: Declaration[] = [];
    const inner: ClassBody[] = [];
    let index = from;
    let openEnum: { from: number; text: string } | null = null;
    let topExtends = extendsAs;
    while (index < lines.length) {
      const line = lines[index];
      if (line === undefined) {
        break;
      }
      // Before blank lines are passed over, because the enum's text has to keep every line for its
      // offsets to stay those of the file.
      if (openEnum !== null) {
        openEnum.text += `\n${line.text}`;
        if (line.text.includes('}')) {
          collectEnumValues(openEnum.text, openEnum.from, declarations);
          openEnum = null;
        }
        index += 1;
        continue;
      }
      if (line.text.trim() === '') {
        index += 1;
        continue;
      }
      if (line.indent < indent) {
        break;
      }
      if (line.indent > indent) {
        index += 1;
        continue;
      }
      const body = line.text.slice(line.indent);
      const at = line.start + line.indent;
      if (name === null) {
        const declared = CLASS_NAME_LINE.exec(body);
        if (declared?.[1] !== undefined) {
          className = { name: declared[1], offset: at + declared[0].length - declared[1].length };
        }
        if (EXTENDS_LINE.test(body) || CLASS_NAME_LINE.test(body)) {
          const clause = EXTENDS_CLAUSE.exec(body);
          if (clause !== null && topExtends === null) {
            topExtends = extendsTarget(source, code, at + clause.index + clause[0].length);
          }
        }
      }
      const declared = DECLARATION_LINE.exec(body);
      if (declared !== null) {
        const [whole, , isStatic, keyword, declaredName] = declared;
        if (keyword !== undefined && declaredName !== undefined) {
          const offset = at + whole.length - declaredName.length;
          const kind = keyword as DeclarationKind;
          declarations.push({ name: declaredName, kind, offset, isStatic: isStatic !== undefined });
          if (kind === 'enum') {
            const brace = body.indexOf('{');
            if (brace !== -1) {
              openEnum = { from: at + brace, text: body.slice(brace) };
              if (body.includes('}', brace)) {
                collectEnumValues(openEnum.text, openEnum.from, declarations);
                openEnum = null;
              }
            }
          }
          if (kind === 'class') {
            const rest = body.slice(whole.length);
            const clause = EXTENDS_CLAUSE.exec(rest);
            const innerExtends =
              clause === null
                ? null
                : extendsTarget(source, code, at + whole.length + clause.index + clause[0].length);
            const childIndent =
              lines.slice(index + 1).find((next) => next.text.trim() !== '')?.indent ?? indent + 1;
            if (childIndent > indent) {
              const parsed = parseBody(declaredName, innerExtends, index + 1, childIndent, line.start);
              inner.push(parsed.body);
              index = parsed.next;
              continue;
            }
            inner.push({
              name: declaredName,
              extendsAs: innerExtends,
              declarations: [],
              inner: [],
              start: line.start,
              end: line.start + line.text.length,
            });
          }
        }
      } else if (/^enum\s*\{/u.test(body)) {
        // An unnamed enum's values are constants of the class itself.
        const brace = body.indexOf('{');
        openEnum = { from: at + brace, text: body.slice(brace) };
        if (body.includes('}', brace)) {
          collectEnumValues(openEnum.text, openEnum.from, declarations);
          openEnum = null;
        }
      }
      index += 1;
    }
    const last = lines[index - 1];
    return {
      body: {
        name,
        extendsAs: topExtends,
        declarations,
        inner,
        start: bodyStart,
        end: last === undefined ? bodyStart : last.start + last.text.length,
      },
      next: index,
    };
  };

  const { body } = parseBody(null, null, 0, 0, 0);
  return { className, body };
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
  // A body written on its header's line, which is then the line recorded for it.
  const header = lambda ? LAMBDA_HEADER.exec(first) : FUNC_LINE.exec(first);
  if (header !== null) {
    const body = afterHeader(first, header.index);
    if (body !== -1 && first.slice(body).trim() !== '') {
      return SUPER_CALL.test(first.slice(body));
    }
  }
  const indent = indentOf(first);
  let lambdaIndent: number | null = null;
  for (let index = line - 1; index < lines.length; index += 1) {
    const text = lines[index] ?? '';
    if (text.trim() === '') {
      continue;
    }
    const at = indentOf(text);
    if (at < indent) {
      break;
    }
    if (lambdaIndent !== null) {
      if (at > lambdaIndent) {
        continue;
      }
      lambdaIndent = null;
    }
    // A lambda's code is its own row: what comes before its header is this function's.
    const inner = LAMBDA_HEADER.exec(text);
    if (SUPER_CALL.test(inner === null ? text : text.slice(0, inner.index))) {
      return true;
    }
    if (inner !== null) {
      const body = afterHeader(text, inner.index);
      if (body !== -1 && text.slice(body).trim() === '') {
        lambdaIndent = at;
      }
    }
  }
  return false;
}

/** A place in a script that names a function, outside its declaration. */
export interface CallSite {
  /** One-based. */
  readonly line: number;
  /** The named function the place is in, or null at a class's own level. */
  readonly within: string | null;
  /** True when it is called there; false when it is named without a call, as a Callable passed on. */
  readonly called: boolean;
}

/**
 * Where [param source] names [param name] in code, other than declaring it: as a call, a member
 * call on anything, or a Callable handed to something that calls it later. Comments and strings are
 * not code, so a function named in prose or by a string is not found.
 */
export function callSitesOf(source: string, name: string): CallSite[] {
  const regions = regionsOf(source);
  const code = codeOf(source, regions);
  const lines = new Lines(source);
  return occurrencesOf(source, name, regions)
    .filter((one) => one.kind === 'code' && one.declaredAs === null)
    .map((one) => {
      const line = lines.positionOf(one.offset).line + 1;
      const after = code.slice(one.offset + name.length).trimStart();
      return { line, within: enclosingFunction(source, line, code), called: after.startsWith('(') };
    });
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
