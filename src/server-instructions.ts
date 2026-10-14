/**
 * What a client puts in front of its agent when it connects, for an agent that has never read the
 * gdharness skill: the handful of habits that decide whether a session goes well, and nothing a
 * tool's own description already says. Short, because it costs every session that reads it.
 */

import { projectPathSentence } from './tool-definitions.js';

export function serverInstructions(): string {
  return [
    'gdharness drives a Godot 4 project: the editor that is open, the game that is running and the project on disk.',
    `${projectPathSentence()}. There is no ambient project.`,
    'Call editor_status first: it says whether an editor is connected and whether its addon matches this server.',
    'Start the game with editor_run start, never by spawning an engine, and read editor_output after every run:',
    'its clean verdict and its error entries are how a run is judged, and editor_run wait is how to wait for one.',
    'The runtime_* tools work on the running game and the debug_* tools on its debugger.',
    'A refusal names what would have worked, so read it before calling again.',
  ].join(' ');
}
