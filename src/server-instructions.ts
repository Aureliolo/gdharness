/**
 * What a client puts in front of its agent when it connects, for an agent that has never read the
 * gdharness skill: the handful of habits that decide whether a session goes well, and what every
 * tool of a family would otherwise repeat in its description. Short, because it costs every
 * session that reads it.
 */

import { projectPathSentence, THE_GAME_PICKED_IN_SHORT } from './tool-definitions.js';

export function serverInstructions(): string {
  return [
    'gdharness drives a Godot 4 project: the open editor, the running game and the files.',
    `${projectPathSentence()}.`,
    'projectPath is the absolute path of the project folder.',
    'A path inside it is written either way, "scenes/main.tscn" or "res://scenes/main.tscn".',
    'Call editor_status first: it says whether an editor is connected and its addon matches.',
    'Start the game with editor_run start, never by spawning an engine, and wait with editor_run wait.',
    'Judge every run by editor_output, its clean verdict and its errors.',
    'The runtime_* tools work on the running game, which needs the runtime addon.',
    'The debug_* tools work on its debugger, whether this server started the game or the editor plays it.',
    THE_GAME_PICKED_IN_SHORT,
    'Scene and resource writes go through the editor when one serves the project, else a headless engine.',
    'writtenBy says which, and alsoSaved lists lines changed on other nodes.',
    'A refusal names what would have worked.',
  ].join(' ');
}
