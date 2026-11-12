/**
 * The order Godot's editor gives a folder's names when it scans a project, `String.filenocasecmp_to`.
 * Leading underscores sort below every name but one starting with a dot. Then leading dots sort
 * first, a run of digits compares by its number, digits sort before other characters, and the rest
 * compare without case.
 */
export function fileNoCaseCompare(a: string, b: string): number {
  const names = new Names(a, b);
  return names.underscores() ?? names.dots() ?? names.rest();
}

const END = 0;
const DOT = 0x2e;
const UNDERSCORE = 0x5f;
const ZERO = 0x30;
const NINE = 0x39;

function isDigit(point: number): boolean {
  return point >= ZERO && point <= NINE;
}

/** A code point's capital, where the capital is one code point, as the engine's own table gives. */
function upper(point: number): number {
  const capital = Array.from(String.fromCodePoint(point).toUpperCase());
  return capital.length === 1 ? (capital[0]?.codePointAt(0) ?? point) : point;
}

/** Two names read side by side, each as code points ended by a 0 as the engine's strings are. */
class Names {
  private readonly left: number[];
  private readonly right: number[];
  private i = 0;
  private j = 0;

  constructor(a: string, b: string) {
    this.left = Array.from(a, (character) => character.codePointAt(0) ?? END);
    this.right = Array.from(b, (character) => character.codePointAt(0) ?? END);
  }

  private get l(): number {
    return this.left[this.i] ?? END;
  }

  private get r(): number {
    return this.right[this.j] ?? END;
  }

  /** The leading underscores, which sort below everything but a dot. */
  underscores(): number | null {
    while ((this.l === UNDERSCORE && this.r !== END) || (this.l !== END && this.r === UNDERSCORE)) {
      if (this.l !== UNDERSCORE) {
        return this.l === DOT ? -1 : 1;
      }
      if (this.r !== UNDERSCORE) {
        return this.r === DOT ? 1 : -1;
      }
      this.i += 1;
      this.j += 1;
    }
    return null;
  }

  /** The leading dots, where the name with more sorts first. */
  dots(): number | null {
    while (this.l === DOT || this.r === DOT) {
      const leftDot = this.l === DOT;
      this.i += 1;
      if (!leftDot) {
        return 1;
      }
      const rightDot = this.r === DOT;
      this.j += 1;
      if (!rightDot) {
        return -1;
      }
      if (this.right[this.j] === undefined) {
        return 1;
      }
      if (this.left[this.i] === undefined) {
        return -1;
      }
    }
    return null;
  }

  rest(): number {
    while (this.l !== END) {
      if (this.r === END) {
        return 1;
      }
      const order = isDigit(this.l) || isDigit(this.r) ? this.numbers() : this.letters();
      if (order !== 0) {
        return order;
      }
    }
    return this.r === END ? 0 : -1;
  }

  private letters(): number {
    const order = Math.sign(upper(this.l) - upper(this.r));
    this.i += 1;
    this.j += 1;
    return order;
  }

  /** Two runs of digits, by their length without leading zeros, then digit by digit. */
  private numbers(): number {
    if (!isDigit(this.l)) {
      return 1;
    }
    if (!isDigit(this.r)) {
      return -1;
    }
    let leftEnd = this.i;
    while (isDigit(this.left[leftEnd] ?? END)) {
      leftEnd += 1;
    }
    let rightEnd = this.j;
    while (isDigit(this.right[rightEnd] ?? END)) {
      rightEnd += 1;
    }
    let i = this.i;
    while (this.left[i] === ZERO) {
      i += 1;
    }
    let j = this.j;
    while (this.right[j] === ZERO) {
      j += 1;
    }
    this.i = leftEnd;
    this.j = rightEnd;
    return Math.sign(leftEnd - i - (rightEnd - j)) || digitByDigit(this.left, i, leftEnd, this.right, j);
  }
}

function digitByDigit(
  left: readonly number[],
  i: number,
  leftEnd: number,
  right: readonly number[],
  j: number,
): number {
  for (let k = 0; i + k < leftEnd; k += 1) {
    const order = Math.sign((left[i + k] ?? END) - (right[j + k] ?? END));
    if (order !== 0) {
      return order;
    }
  }
  return 0;
}
