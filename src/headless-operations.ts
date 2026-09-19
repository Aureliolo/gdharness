import { dictionary } from './dictionary.js';

/**
 * The tools and ops that answer from a short-lived headless engine: no editor window, no port, no
 * running game.
 *
 * Kept apart from the server because it is the fact a caller most needs before wiring gdharness
 * into anything automatic. A push gate cannot depend on an editor being open, because an editor is
 * a person's window, so these are the only calls a gate can make. The tool reference renders the
 * list from here rather than describing it in prose, which is how it stays true.
 */
export const HEADLESS_OPERATIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = dictionary({
  project_settings: dictionary({
    get: 'get_project_setting',
    set: 'set_project_setting',
    add_autoload: 'add_autoload',
    remove_autoload: 'remove_autoload',
    set_main_scene: 'set_main_scene',
    add_input_action: 'add_input_action',
    enable_plugin: 'enable_plugin',
    disable_plugin: 'disable_plugin',
    add_audio_bus: 'create_audio_bus',
    set_audio_bus_effect: 'set_audio_bus_effect',
    set_audio_bus_volume: 'set_audio_bus_volume',
  }),
  project_import: dictionary({
    status: 'get_import_status',
    options: 'get_import_options',
    set_options: 'set_import_options',
    reimport: 'reimport_resource',
    uid: 'get_uid',
    refresh_classes: 'refresh_class_cache',
  }),
  project_export: dictionary({ list: 'list_export_presets' }),
  script_edit: dictionary({ create: 'create_script', modify: 'modify_script' }),
  script_info: dictionary({ structure: 'get_script_info' }),
  editor_classes: dictionary({
    query: 'query_classes',
    info: 'query_class_info',
    inheritance: 'inspect_inheritance',
  }),
});

/**
 * Ops that are a headless engine boot with no operations script: the engine's own passes.
 *
 * Kept apart from the table above because that one maps an op to a command the operations script
 * answers, and a guard holds it to that on both sides. These have no such command and never could:
 * minting a `.uid` is something only the engine's import does, so an op that promises one has to be
 * that boot rather than a script asking the engine nicely. Still headless, so the reference lists
 * them with the rest.
 */
export const ENGINE_PASSES: Readonly<Record<string, Readonly<Record<string, string>>>> = dictionary({
  project_import: dictionary({ refresh_uids: 'import' }),
});

/**
 * The same reads answered by the open editor instead, for a caller that asked for `from: "editor"`.
 *
 * Reads only, and only the ones an editor can answer as well as a file can. A write goes to the
 * file whichever way it is phrased, so there is nothing to choose between. An op with no entry here
 * is refused rather than quietly answered from disk, because a caller who asked the editor and got
 * the file would have no way to tell which one they were reading.
 *
 * The name on the right is the addon's command, which is the same name the engine operation has:
 * one question, asked of whichever of the two is holding the answer the caller wants.
 */
export const EDITOR_READS: Readonly<Record<string, Readonly<Record<string, string>>>> = dictionary({
  project_settings: dictionary({ get: 'get_project_setting' }),
});
