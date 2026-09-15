/**
 * How the game is started: the decision to open a window and the argument list the engine
 * receives. Both are pure so that they can be asserted directly, because the argv of a spawned
 * process is not visible from any tool's response.
 */

/**
 * An environment variable's value, treating the empty string as unset.
 *
 * A variable exported with nothing in it is how a shell says "not configured", and reading it
 * as a configured empty value picks a tool profile of "" or a page size that will not parse.
 */
export function envValue(name: string, variables: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = variables[name];
  return value === undefined || value === '' ? undefined : value;
}

export interface LaunchHost {
  readonly platform: NodeJS.Platform;
  readonly variables: NodeJS.ProcessEnv;
}

/**
 * Whether to launch the game without a window.
 *
 * A headless Godot renders nothing, so capture_screenshot, capture_viewport and the input
 * injection tools cannot work against a game started that way: they fail in the dummy texture
 * storage, and run_project is the only way to start a game over MCP.
 *
 * Left to itself this follows the environment. CI is both the place that needs headless and
 * the place with no display, so deciding on the display keeps every existing headless run
 * headless while letting the visual tools work on a desktop with no configuration. An explicit
 * true or false overrides it. Windows and macOS always have a display.
 */
export function resolveHeadless(requested: unknown, host: LaunchHost): boolean {
  if (typeof requested === 'boolean') {
    return requested;
  }
  if (host.platform === 'win32' || host.platform === 'darwin') {
    return false;
  }
  // Through envValue because a display variable exported empty means no display, the same as
  // one that was never exported: a bare `??` here would read `DISPLAY=""` as a desktop.
  return (
    envValue('DISPLAY', host.variables) === undefined &&
    envValue('WAYLAND_DISPLAY', host.variables) === undefined
  );
}

export interface RunOptions {
  readonly projectPath: string;
  readonly headless: boolean;
  /** The scene as the project names it, `scenes/main.tscn`, or null for the main scene. */
  readonly scene: string | null;
  /** Frames to run before the engine quits on its own, or null to run until stopped. */
  readonly quitAfter?: number | null;
}

/**
 * The engine's argument list for running a project.
 *
 * Never `-d`: it turns on the engine's own stdin debugger, which breaks into a `debug>` prompt
 * on the first script error and, on a process with no stdin, prints that prompt in a loop
 * forever instead of the error. Without it the error is printed and the game carries on, which
 * is what the log reads. The scene goes last as a res:// path rather than the text that arrived,
 * because the engine reads that argument positionally and a value beginning with a dash would be
 * another option to it.
 */
export function runArguments(options: RunOptions): string[] {
  const args = options.headless
    ? ['--headless', '--path', options.projectPath]
    : ['--path', options.projectPath];
  if (options.quitAfter !== undefined && options.quitAfter !== null) {
    args.push('--quit-after', String(options.quitAfter));
  }
  if (options.scene !== null) {
    args.push(`res://${options.scene}`);
  }
  return args;
}

/** Where an editor is told to serve its language server and its debug adapter. */
export interface EditorPorts {
  readonly lsp: number;
  readonly dap: number;
}

/**
 * The engine's argument list for opening the editor on a project.
 *
 * Never `--headless`: this one exists to put an editor in front of a person, and one nobody can
 * see is not that. Pure for the same reason as the rest of this file, since the editor is
 * spawned detached and its argv appears in no tool's answer.
 *
 * The two ports are named rather than left to the editor settings, which are one file for every
 * editor on the machine: without this the second editor to open binds neither, and every script
 * and debug tool behind it is answered by the first one about a different project.
 */
export function editorArguments(projectPath: string, ports: EditorPorts): string[] {
  return ['-e', '--path', projectPath, '--lsp-port', String(ports.lsp), '--dap-port', String(ports.dap)];
}

/**
 * What a server puts in the environment of an editor it opens, so that the editor can say who
 * opened it and the answer decides who may open it again.
 *
 * Set to anything rather than to a particular word: the addon reads whether it is there. The other
 * half of the pair is `OPENED_BY_A_SERVER` in bridge_client.gd.
 */
export const OPENED_BY_A_SERVER = 'GDHARNESS_OPENED_BY_A_SERVER';

/**
 * An environment whose `user://` is `home`, so an engine writes its saves nowhere anybody keeps
 * theirs.
 *
 * A test tier is the case that matters. Godot resolves `user://` from the environment, so a suite
 * that saves a game writes into the same folder as the copy of that game somebody plays: run the
 * tier while a guild is open and the tier's own files land in the player's save list, and a suite
 * that tidies up after itself rewrites every real save on the way out. Found by using this tool on
 * a project whose own gate had guarded against it for months, which is the sort of thing a harness
 * should not leave to each project to discover.
 *
 * Windows reads `APPDATA` and Linux `XDG_DATA_HOME`. macOS reads neither: its user directory hangs
 * off `HOME`, and moving that moves far more than saves, so a run there still writes where it
 * always did.
 */
export function userDataIn(home: string, variables: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const moved = ['APPDATA', 'XDG_DATA_HOME'];
  const carried: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(variables)) {
    // Windows compares variable names without case but a copied object does not, so a machine
    // spelling it AppData would hand the child both that and the one set below, and which of
    // them the engine reads is nobody's decision.
    if (!moved.some((named) => named.toLowerCase() === name.toLowerCase())) {
      carried[name] = value;
    }
  }
  for (const named of moved) {
    carried[named] = home;
  }
  return carried;
}
