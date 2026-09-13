import type { ChildProcess } from 'node:child_process';
import type { GameLog } from './game-log.js';

/** The game editor_run started, and everything it has said. */
export interface GodotProcess {
  process: ChildProcess;
  log: GameLog;
  startedAt: number;
  /** Set once the process has ended; null while it runs. */
  exitCode: number | null;
}

export interface GodotServerConfig {
  godotPath?: string;
  debugMode?: boolean;
  godotDebugMode?: boolean;
  strictPathValidation?: boolean;
}

/**
 * Tool arguments as they arrive over MCP: keys chosen by the caller, values not yet checked.
 * `unknown` rather than `any` so that every read has to say what it expects the value to be;
 * the readers in `tool-args.ts` are where that happens.
 */
export type OperationParams = Record<string, unknown>;

/** File counts for a project, by kind. `error` is set when the walk could not finish. */
export interface ProjectStructure {
  scenes: number;
  scripts: number;
  assets: number;
  other: number;
  error?: string;
}

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
