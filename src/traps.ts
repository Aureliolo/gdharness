/**
 * The Godot behaviours that are still the reader's to handle.
 *
 * One source, two readers: the skill written into a project, and the page on the site. They are
 * the same five facts, and a fact worth telling an agent is not worth maintaining twice.
 *
 * What is not here is the long list of behaviours gdharness handles on the reader's behalf. Those
 * are not operating knowledge, because nobody using the tool ever meets them.
 */

interface Trap {
  /** The behaviour, as a heading. */
  readonly title: string;
  /** What Godot does. */
  readonly what: string;
  /** What to do about it, which is the half that changes how somebody works. */
  readonly instead: string;
}

const TRAPS: readonly Trap[] = [
  {
    title: 'The class list goes stale',
    what: 'Godot fixes its list of global classes when the editor starts, and refreshes it only on a filesystem scan. Until then a script naming a `class_name` written since reports "Could not find type", and the editor writes that stale list into `.godot/global_script_class_cache.cfg`, so the next game it launches cannot resolve them either. Focusing the window does not reliably trigger the scan, and `workspace/didChangeWatchedFiles` is ignored: [godotengine/godot#42786](https://github.com/godotengine/godot/issues/42786).',
    instead:
      'Call `project_import refresh_classes` after writing a `class_name` and before running the game. `project_test` does it first, and `gdharness doctor` reports a stale cache.',
  },
  {
    title: 'A game started as its own process has no debugger',
    what: 'Breakpoints never hit and the stack is empty, because the debug session belongs to whoever launched the game.',
    instead:
      '`editor_run start` asks the open editor to play, so the game belongs to the editor’s debugger and every `debug_*` tool has something to talk to. Set breakpoints with `debug_breakpoint set` before the run.',
  },
  {
    title: 'There is no pause, and no step out',
    what: "Godot's debug adapter answers a pause request, sends a stopped event, and leaves the game running. It implements no `stepOut` at all, so that request is never answered and the call waits out its timeout.",
    instead:
      '`debug_control` has `continue`, `step_over` and `step_into`. Stop the game with a breakpoint, read what is in scope with `debug_state variables`, and step over from inside a function to run it to its end.',
  },
  {
    title: 'Headless has no window, and a 64 by 64 viewport',
    what: 'Input works headless, but the GUI only delivers inside the viewport, which is 64 by 64 whatever the project settings say. A control at (400, 20) cannot be clicked.',
    instead:
      '`runtime_capture` refuses headless rather than handing back the last frame anything drew. Drive a windowed run when the interface is the thing under test.',
  },
  {
    title: 'One editor',
    what: 'Ports 6005 and 6006 hold one client each. A second editor takes them from the first, which gives up without retrying, and the answers start coming from a process nobody can see.',
    instead: 'Never start a second editor while one is open. `editor_status` says which one is answering.',
  },
];

/** The traps as markdown, for the skill and for the page that shows the same five. */
export function renderTraps(depth: '##' | '###' = '###'): string {
  return TRAPS.map((trap) =>
    [`${depth} ${trap.title}`, '', trap.what, '', `**${trap.instead}**`].join('\n'),
  ).join('\n\n');
}
