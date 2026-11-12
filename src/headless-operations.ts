import { dictionary } from './dictionary.js';

/**
 * The tools and ops that answer from a short-lived headless engine: no editor window, no port, no
 * running game.
 *
 * Kept apart from the server because it is the fact a caller most needs before wiring gdharness
 * into anything automatic. A push gate cannot depend on an editor being open, because an editor is
 * a person's window. These calls never need one. The tool reference renders the list from here
 * rather than describing it in prose, which is how it stays true.
 */
export const HEADLESS_OPERATIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = dictionary({
  project_settings: dictionary({
    get: 'get_project_setting',
    set: 'set_project_setting',
    unset: 'unset_project_setting',
    add_autoload: 'add_autoload',
    remove_autoload: 'remove_autoload',
    set_main_scene: 'set_main_scene',
    add_input_action: 'add_input_action',
    remove_input_action: 'remove_input_action',
    enable_plugin: 'enable_plugin',
    disable_plugin: 'disable_plugin',
    add_audio_bus: 'create_audio_bus',
    remove_audio_bus: 'remove_audio_bus',
    set_audio_bus_effect: 'set_audio_bus_effect',
    set_audio_bus_volume: 'set_audio_bus_volume',
    rename_audio_bus: 'rename_audio_bus',
    set_audio_bus_send: 'set_audio_bus_send',
  }),
  project_import: dictionary({
    status: 'get_import_status',
    options: 'get_import_options',
    set_options: 'set_import_options',
    uid: 'get_uid',
    refresh_classes: 'refresh_class_cache',
  }),
  project_export: dictionary({ list: 'list_export_presets', add_preset: 'add_export_preset' }),
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
export const ENGINE_PASSES: Readonly<Record<string, readonly string[]>> = dictionary({
  project_import: ['refresh_uids', 'reimport'],
});

/** The engine operation `project_dependencies` sends for each `direction`. */
export const DEPENDENCY_OPERATIONS = {
  forward: 'get_dependencies',
  reverse: 'find_resource_usages',
} as const;

/**
 * Tools with no op that always answer from a short-lived headless engine, with the operations each
 * sends. Apart from the table above, which is keyed by op, so the reference lists these too.
 */
export const HEADLESS_TOOLS: Readonly<Record<string, readonly string[]>> = dictionary({
  project_dependencies: Object.values(DEPENDENCY_OPERATIONS),
});

/**
 * What the open editor answers for a caller that asked for `from: "editor"`: a read of what it
 * holds, or a save of its copy of a scene.
 *
 * A read is here when the editor answers it as well as a file can, and the save because only the
 * editor holds what its @tool scripts and layout made. An op with no entry is refused rather than
 * quietly answered from the file, because a caller could not tell which one answered.
 *
 * The name on the right is the addon's command, which is the same name the engine operation has:
 * one question, asked of whichever of the two is holding the answer the caller wants.
 */
export const EDITOR_ANSWERS: Readonly<Record<string, Readonly<Record<string, string>>>> = dictionary({
  project_settings: dictionary({ get: 'get_project_setting' }),
  scene_create: dictionary({ save: 'save_scene' }),
});

/** An editor command, and whether it only reads what the editor or the file holds or writes it. */
type EditorCall = readonly [command: string, effect: 'reads' | 'writes'];

/**
 * The command each op of the scene and resource tools runs, in the open editor where there is one
 * and in a headless engine where there is not. Every op those tools take is listed, apart from the
 * reads and the move, which the server answers from the file itself.
 */
export const EDITOR_CALLS: Readonly<Record<string, Readonly<Record<string, EditorCall>>>> = dictionary({
  scene_node: dictionary<EditorCall>({
    add: ['add_node', 'writes'],
    get: ['get_node_properties', 'reads'],
    set: ['set_node_properties', 'writes'],
    duplicate: ['duplicate_node', 'writes'],
    reparent: ['reparent_node', 'writes'],
    save_branch: ['save_branch', 'writes'],
    delete: ['delete_node', 'writes'],
    change_type: ['change_node_type', 'writes'],
    bake_navigation: ['bake_navigation', 'writes'],
    set_tilemap_cells: ['set_tilemap_cells', 'writes'],
  }),
  scene_signal: dictionary<EditorCall>({
    connect: ['connect_signal', 'writes'],
    disconnect: ['disconnect_signal', 'writes'],
    list: ['list_connections', 'reads'],
  }),
  scene_animation: dictionary<EditorCall>({
    create: ['create_animation', 'writes'],
    add_track: ['add_animation_track', 'writes'],
    remove_track: ['remove_animation_track', 'writes'],
    set: ['set_animation', 'writes'],
    rename: ['rename_animation', 'writes'],
    remove: ['remove_animation', 'writes'],
    add_state: ['add_animation_state', 'writes'],
    remove_state: ['remove_animation_state', 'writes'],
    connect_states: ['connect_animation_states', 'writes'],
    disconnect_states: ['disconnect_animation_states', 'writes'],
  }),
  resource_edit: dictionary<EditorCall>({
    create: ['create_resource', 'writes'],
    modify: ['modify_resource', 'writes'],
    create_shader: ['create_shader', 'writes'],
    create_tileset: ['create_tileset', 'writes'],
    set_theme_color: ['set_theme_color', 'writes'],
    set_theme_font_size: ['set_theme_font_size', 'writes'],
    remove_theme_item: ['remove_theme_item', 'writes'],
  }),
});
