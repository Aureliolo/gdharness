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

/**
 * The tool result's text blocks joined, or null when the result carries no text at all.
 *
 * Without the feedback block the server adds to every two hundred and fiftieth answer, which is
 * about no answer: a refusal it landed on failed an assertion anchored on the refusal's last
 * sentence, at whichever call the suite had reached. Without the block saying a call waited for
 * engine slots too, which comes of whatever else holds the machine's slots at the time.
 */
export function textOf(response: JsonRpcMessage | null | undefined): string | null {
  const result = response?.result;
  if (!isRecord(result) || !Array.isArray(result['content'])) return null;
  const text = (result['content'] as ToolContentBlock[])
    .filter((chunk) => !isFeedbackBlock(chunk) && slotWaitOf(chunk) === null)
    .map((chunk) => chunk.text ?? '')
    .join('');
  return text || null;
}

/** Whether [chunk] is the block asking, now and then, for the tool that is missing. */
export function isFeedbackBlock(chunk: ToolContentBlock): boolean {
  return soleKeyOf(chunk, 'gdharness_feedback') !== null;
}

/** The block saying how long a call waited for engine slots, or null when [chunk] is another. */
export function slotWaitOf(chunk: ToolContentBlock): unknown {
  return soleKeyOf(chunk, 'engine_slot_wait');
}

function soleKeyOf(chunk: ToolContentBlock, key: string): unknown {
  try {
    const parsed: unknown = JSON.parse(chunk.text ?? '');
    return isRecord(parsed) && Object.keys(parsed).length === 1 && key in parsed ? parsed[key] : null;
  } catch {
    return null;
  }
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
