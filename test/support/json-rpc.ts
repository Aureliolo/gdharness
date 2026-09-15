interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

/** One block of an MCP tool result as it arrives over the wire. */
export interface ToolContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Every complete JSON object on its own line; anything that is not one is dropped. */
export function parseJsonLines(data: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  for (const raw of data.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) messages.push(parsed);
    } catch {
      // A partial line from a chunked read is not a message yet.
    }
  }
  return messages;
}

/** The tool result's text blocks joined, or null when the result carries no text at all. */
export function textOf(response: JsonRpcMessage | null | undefined): string | null {
  const result = response?.result;
  if (!isRecord(result) || !Array.isArray(result['content'])) return null;
  const text = (result['content'] as ToolContentBlock[]).map((chunk) => chunk.text ?? '').join('');
  return text || null;
}

/**
 * The tool result's answer parsed as JSON, or null when it is not JSON.
 *
 * The first block rather than all of them joined, because a notice is a block of its own on the
 * end, and two JSON documents end to end are not one document. Joined, an answer that happened to
 * land on the two hundred and fiftieth call parsed as nothing and read here as a tool that
 * answered with no content, which is a green suite failing on the count it was run at rather than
 * on anything it measured. A server that answers JSON answers it in one block; the answers with
 * two lead with a sentence, and those were never JSON to begin with.
 */
export function parseTextContent(response: JsonRpcMessage | null | undefined): unknown {
  const result = response?.result;
  if (!isRecord(result) || !Array.isArray(result['content'])) return null;
  const answer = (result['content'] as ToolContentBlock[])[0]?.text;
  if (answer === undefined || answer === '') return null;
  try {
    return JSON.parse(answer) as unknown;
  } catch {
    return null;
  }
}
