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
}

/**
 * The engine's argument list for running a project under the debugger.
 *
 * `-d` is present either way: the opt-out was once written as a shift() off the front of the
 * headless argv, which took -d with it and launched a game the debugger never attached to. The
 * scene goes last as a res:// path rather than the text that arrived, because the engine reads
 * that argument positionally and a value beginning with a dash would be another option to it.
 */
export function runArguments(options: RunOptions): string[] {
  const args = options.headless
    ? ['--headless', '-d', '--path', options.projectPath]
    : ['-d', '--path', options.projectPath];
  if (options.scene !== null) {
    args.push(`res://${options.scene}`);
  }
  return args;
}
