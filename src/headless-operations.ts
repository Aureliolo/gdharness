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
    refresh_uids: 'resave_resources',
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
