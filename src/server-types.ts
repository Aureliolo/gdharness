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
  /**
   * The game's process id, which outlives the handle to it.
   *
   * A run picked back up after the server restarted has a number and no handle: the process
   * belongs to nobody now, and a number is all that is left to ask after it or end it with.
   * Null only for a game the editor is playing, which is the editor's to end.
   */
  pid: number | null;
  log: GameLog;
  /**
   * The file this run's output is being written to, and how much of it has been read.
   *
   * A run this server spawned writes both its streams here rather than down a pipe, so the
   * output survives the server and the game never blocks on a reader that has gone. Null for a
   * game the editor plays, whose console arrives over the debug adapter.
   */
  transcript: string | null;
  readOffset: number;
  /**
   * The project this run was started on, for a run read back off disk.
   *
   * Two servers on one machine share a runtime directory and so share the note a run leaves
   * behind. Naming the project in the answer is what lets a caller see that the run being
   * reported is one of theirs, rather than having it silently reported as this project's.
   */
  projectPath: string | null;
  startedAt: number;
  /** Set once the process has ended; null while it runs. */
  exitCode: number | null;
  /**
   * True for a run found already over, with nobody having been there to see it end.
   *
   * The difference between this and a clean `exitCode` is the difference between "it exited 0"
   * and "it is not there any more, and what it exited with is recorded nowhere": a server that
   * was restarted mid-run was never waiting on the process, so no code was ever collected. Said
   * rather than guessed, because a guessed zero reads as a run that finished its work.
   */
  endedUnwatched?: boolean;
  /** True when the editor was asked to play it, so stopping it is the editor's job too. */
  throughEditor: boolean;
  /**
   * True for an editor-played run this server found already going rather than started.
   *
   * A reconnect takes the adapter buffer with the old server, so what the run printed before that
   * is nowhere: the log here begins where this server picked it up. Said in the answer, because a
   * short log reads as a quiet run, and a caller who started a bench an hour ago and is handed six
   * lines has no way to tell "it has printed six lines" from "six lines is what I can see".
   */
  pickedUpPlaying?: boolean;
  /**
   * True once the debug adapter that carries an editor-played run's console has gone.
   *
   * That adapter is the only source such a run has, and its loss is silent: nothing arrives, which
   * is exactly what a run between prints looks like. A run reported clean with no entries is then
   * two different things, one of which is a game printing steadily into a console nobody is
   * holding, so the one that happened is written down rather than left to the reader.
   */
  consoleLost?: boolean;
  /**
   * The process the game announced itself as.
   *
   * For a run the editor is playing it is the only process the run has: there is no handle and no
   * `pid`, so whether it is still up can otherwise only be asked of the editor, and the editor is
   * not always there to ask and is not always right: it went on saying it was playing a game whose
   * process had been ended from outside. A game carrying the runtime addon announces its own
   * process id, and that number can be asked of the operating system.
   *
   * For a run started here it is usually `pid` and not always: the Windows console build is a
   * wrapper that starts the engine as its child, so the game the handle stands for announces a
   * number of its own, and that number is the one a runtime call, a cpu reading and a listing of
   * what the game started all need.
   *
   * Used to find a run over, and to ask the operating system what the run has used. A number that
   * has come round to something else reads as alive, which is the answer the record gives anyway,
   * so this can correct a wrong yes and never invents one.
   *
   * Tied when the game announces, which is usually inside the start's wait and sometimes after
   * it: `announcedBefore` is what the start saw announced before it played, so a later tie can
   * tell this run's game from one that was already there.
   */
  announcedPid?: number;
  announcedBefore?: ReadonlySet<number>;
  /**
   * Why this server ended the run, or null when it did not.
   *
   * A run that vanished and a run this tool killed look the same from outside: the process is
   * gone and the output stops. They call for different things, and the caller cannot tell them
   * apart by looking, so the one party that knows says which it was.
   */
  endedHere?: string | null;
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
