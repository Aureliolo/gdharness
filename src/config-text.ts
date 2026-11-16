/**
 * Whether Godot's ConfigFile reads a file, as `ConfigFile.load` decides it: `[section]` lines,
 * `;` comments and `key=value` assignments, each value as the engine's VariantParser takes it.
 * Strings, StringNames, NodePaths, numbers, arrays, dictionaries and constructor calls are read.
 * A trailing comma before a closing bracket is taken, as the parser takes it. A file cut short or
 * missing a comma is not.
 */
export function configFileReads(text: string): boolean {
  try {
    new ConfigReader(text).file();
    return true;
  } catch {
    return false;
  }
}

const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/y;
const SPACE = /\s*/y;
const KEY = /[^=\n[;]+/y;
const SECTION = /\[[^\]\n]*\]/y;

class ConfigReader {
  private at = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  file(): void {
    this.space();
    while (this.at < this.text.length) {
      const next = this.text[this.at];
      if (next === ';') {
        const end = this.text.indexOf('\n', this.at);
        this.at = end === -1 ? this.text.length : end;
      } else if (next === '[') {
        this.take(SECTION);
      } else {
        this.assignment();
      }
      this.space();
    }
  }

  private assignment(): void {
    if (this.text[this.at] === '"') {
      this.string();
    } else {
      this.take(KEY);
    }
    this.space();
    this.expect('=');
    this.value();
  }

  private value(): void {
    this.space();
    const next = this.text[this.at] ?? '';
    if (next === '[' || next === '{') {
      this.at += 1;
      this.items(next === '[' ? ']' : '}', next === '{');
    } else if (next === '"') {
      this.string();
    } else if (next === '&' || next === '^') {
      this.at += 1;
      this.string();
    } else if (/[-.\d]/.test(next)) {
      this.take(NUMBER);
    } else {
      this.take(IDENTIFIER);
      if (this.text[this.at] === '(') {
        this.at += 1;
        this.items(')', false);
      }
    }
  }

  /** The values up to [param close], each a key, a colon and a value where [param pairs]. */
  private items(close: string, pairs: boolean): void {
    let needComma = false;
    for (;;) {
      this.space();
      const next = this.text[this.at];
      if (next === undefined) {
        throw new Error('the file ends inside a value');
      }
      if (next === close) {
        this.at += 1;
        return;
      }
      if (needComma) {
        this.expect(',');
        needComma = false;
        continue;
      }
      this.value();
      if (pairs) {
        this.space();
        this.expect(':');
        this.value();
      }
      needComma = true;
    }
  }

  private string(): void {
    this.expect('"');
    while (this.at < this.text.length) {
      const next = this.text[this.at];
      this.at += next === '\\' ? 2 : 1;
      if (next === '"') {
        return;
      }
    }
    throw new Error('the file ends inside a string');
  }

  private expect(character: string): void {
    if (this.text[this.at] !== character) {
      throw new Error(`expected ${character}`);
    }
    this.at += 1;
  }

  private take(pattern: RegExp): void {
    pattern.lastIndex = this.at;
    const found = pattern.exec(this.text);
    if (found === null || found[0] === '') {
      throw new Error(`expected ${pattern.source}`);
    }
    this.at += found[0].length;
  }

  private space(): void {
    SPACE.lastIndex = this.at;
    this.at += SPACE.exec(this.text)?.[0].length ?? 0;
  }
}
