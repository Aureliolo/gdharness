/**
 * The name a tool is exported under on the MCP wire.
 *
 * Its own module so the tests can import the shipped function instead of keeping a second
 * copy of the rules: two sanitisers stop agreeing the moment one of them is edited, and the
 * test is then asserting against itself rather than against the server.
 */
export function sanitizeExportedToolName(toolName: string): string {
  const sanitized = toolName
    .normalize('NFKD')
    // \x00 is the lower bound of an ASCII range, not a control character matched for its own
    // sake. Biome has no spelling of "strip everything outside ASCII" that it accepts, and
    // dropping the guard would put arbitrary bytes in a wire-visible tool name.
    // Each suppression has to sit where its own linter looks for it, hence two spellings.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: range bound, not a match target
    .replace(/[^\x00-\x7F]/g, '') // oxlint-disable-line no-control-regex
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);

  return sanitized.length > 0 ? sanitized : 'tool';
}
