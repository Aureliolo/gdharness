/**
 * What a client puts in front of its agent when it connects, for an agent that has never read the
 * gdharness skill: the handful of habits that decide whether a session goes well, and what every
 * tool of a family would otherwise repeat in its description. Short, because it costs every
 * session that reads it.
 */

import { projectPathSentence } from './tool-definitions.js';

export function serverInstructions(): string {
  return [
    'gdharness drives a Godot 4 project: the editor that is open, the game that is running and the project on disk.',
    `${projectPathSentence()}. There is no ambient project.`,
    'projectPath is the absolute path of the project folder.',
    'A path inside the project is written either way, "scenes/main.tscn" or "res://scenes/main.tscn".',
    'Call editor_status first: it says whether an editor is connected and whether its addon matches this server.',
    'Start the game with editor_run start, never by spawning an engine, and read editor_output after every run:',
    'its clean verdict and its error entries are how a run is judged, and editor_run wait is how to wait for one.',
    'The runtime_* tools work on the running game, which needs the runtime addon.',
    'The debug_* tools work on its debugger, whether this server started the game or the editor plays it.',
    'Scene and resource writes go through the editor when one serves the project, and otherwise through a headless engine.',
    'writtenBy says which. A scene save can change lines on nodes it was not asked about, listed under alsoSaved.',
    'A refusal names what would have worked, so read it before calling again.',
    'A call that waited for an engine slot says how long, and who held the slots, in a last engine_slot_wait block.',
  ].join(' ');
}
