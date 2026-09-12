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

/** The tool result's text parsed as JSON, or null when there is none or it is not JSON. */
export function parseTextContent(response: JsonRpcMessage | null | undefined): unknown {
  const text = textOf(response);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
