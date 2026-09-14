import type { ChildProcess } from 'node:child_process';
import type { GameLog } from './game-log.js';

/** The game editor_run started, and everything it has said. */
export interface GodotProcess {
  /**
   * The game's own process, or null when the editor is playing it.
   *
   * A game the editor plays belongs to the editor's debugger, which is what makes the debug
   * tools answer at all. Nothing here holds a handle to it, and its console arrives over the
   * debug adapter rather than down a pipe.
   */
  process: ChildProcess | null;
  log: GameLog;
  startedAt: number;
  /** Set once the process has ended; null while it runs. */
  exitCode: number | null;
  /** True when the editor was asked to play it, so stopping it is the editor's job too. */
  throughEditor: boolean;
  /**
   * The last error the editor broke this game on, once it has been written into the log.
   *
   * Held so it is written down once. The adapter goes on reporting the same stop for as long as
   * the game sits at it, and every ask for the console drains the adapter, so without this one
   * error became one more error on every call.
   */
  brokeOn: string | null;
}

/** A game this server started itself, which therefore always has a process behind it. */
export interface SpawnedGame extends GodotProcess {
  process: ChildProcess;
  throughEditor: false;
}

/**
 * Tool arguments as they arrive over MCP: keys chosen by the caller, values not yet checked.
 * `unknown` rather than `any` so that every read has to say what it expects the value to be;
 * the readers in `tool-args.ts` are where that happens.
 */
export type OperationParams = Record<string, unknown>;

/**
 * One block of a tool result. `text` carries JSON or prose; `data` plus `mimeType` carry a
 * base64 payload, which is how a screenshot comes back.
 */
interface ToolResponseContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/**
 * What every tool handler returns. `isError` marks a handled failure, not a thrown one. A type
 * rather than an interface so that it satisfies the SDK's indexed result type as it is.
 */
export type ToolResponse = {
  content: ToolResponseContent[];
  isError?: boolean;
};

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
