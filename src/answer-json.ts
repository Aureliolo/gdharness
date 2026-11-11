/**
 * How a tool answer is written as JSON: indented for reading, with every array of numbers or
 * booleans kept on one line.
 *
 * Indented one value to a line, a list of line numbers spent more on newlines and indentation than
 * on the numbers: a rename answer of 81,855 characters was 38,508 written compactly, and a caller's
 * client saved it to a file instead of showing it, since what it counts is tokens. Objects and
 * strings stay one to a line, where the layout is what makes an answer readable.
 */

/**
 * One block of a tool result. `text` carries JSON or prose; `data` plus `mimeType` carry a
 * base64 payload, which is how a screenshot comes back. An image declares `text` as absent so
 * that reading the first block's text needs no narrowing.
 */
type ToolResponseContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; text?: never };

/**
 * What every tool handler returns. `isError` marks a handled failure, not a thrown one. A type
 * rather than an interface so that it satisfies the SDK's indexed result type as it is.
 *
 * No `structuredContent`: Claude Code hands the model that field alone when a result carries it,
 * so the prose an answer leads with and every notice appended after it would never be read.
 */
export type ToolResponse = {
  content: ToolResponseContent[];
  isError?: boolean;
};

const SCALAR = String.raw`(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)`;
const SCALAR_ARRAY = new RegExp(String.raw`\[\n\s+(${SCALAR}(?:,\n\s+${SCALAR})*)\n\s*\]`, 'g');

export function answerJson(value: unknown): string {
  // Safe on the text, because JSON escapes a newline inside a string: every newline here is layout.
  return JSON.stringify(value, null, 2).replace(
    SCALAR_ARRAY,
    (_whole, items: string) => `[${items.split(/,\n\s+/).join(', ')}]`,
  );
}
