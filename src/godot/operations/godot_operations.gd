#!/usr/bin/env -S godot --headless --script
extends SceneTree

# The command line the server runs is `godot --headless --path <project> --script <this>
# <operation> @file:<params.json> <answer.json>`, and the one JSON object written to the answer
# file is the answer. Everything an operation does lives in a sibling module; this file is the
# command table and the wire format.
#
# A file rather than a line on stdout, because the project's autoloads run after `_init` and print
# into the same stream: an autoload printing a dictionary in `_process` was the last JSON line out
# and was taken as the answer. Nothing the project prints can reach the file.
#
# Each module is preloaded by a path relative to this script rather than a res:// one, because
# the operations directory ships inside the server package and is handed to the engine as an
# absolute path outside the project. A res:// path would only resolve in the test fixture.

const GdhAnimationReads = preload("animation_reads.gd")
const GdhAudioBuses = preload("audio_buses.gd")
const GdhClassCache = preload("class_cache.gd")
const GdhClassDbQueries = preload("classdb_queries.gd")
const GdhDependencies = preload("dependencies.gd")
const GdhExportPresets = preload("export_presets.gd")
const GdhFileReads = preload("file_reads.gd")
const GdhGdscriptAnalysis = preload("gdscript_analysis.gd")
const GdhGdscriptAuthoring = preload("gdscript_authoring.gd")
const GdhImportPipeline = preload("import_pipeline.gd")
const GdhInputActions = preload("input_actions.gd")
const GdhLog = preload("logger.gd")
const GdhPlugins = preload("plugins.gd")
const GdhProjectConfig = preload("project_config.gd")
const GdhProjectDiagnostics = preload("project_diagnostics.gd")
const GdhRead = preload("reading.gd")
const GdhRenameChecks = preload("rename_checks.gd")
const GdhResourceFiles = preload("resource_files.gd")
const GdhScriptCheck = preload("script_check.gd")

## Printed once the answer is written, after which the engine runs the project's autoloads. Kept in
## step with `ANSWERED` in src/headless.ts.
const ANSWERED: String = "[gdharness] answered"

## Printed in `_init` by an operation that runs once the project's autoloads are in the tree, and
## when it begins there. Kept in step with `WAITING` and `BEGUN` in src/headless.ts, which files
## what the autoloads print in between as theirs rather than the operation's.
const WAITING: String = "[gdharness] waiting for the autoloads"
const BEGUN: String = "[gdharness] begun"

## The operations that compile the project's scripts. The engine knows an autoload's name only once
## the autoload is in the tree, which is after `_init`, so a script naming one compiled here failed
## with "Identifier not found" while the game and the editor ran it. A scene tool, and a read of a
## scene or a resource, loads the scripts of the file it opens.
const AFTER_THE_AUTOLOADS: Array[String] = [
	"check_scripts",
	"create_script",
	"modify_script",
	"read_animation_states",
	"read_animations",
	"read_resource",
	"read_scene_tree",
	"run_editor_tool",
]

var _log: GdhLog


func _init() -> void:
	var args: PackedStringArray = OS.get_cmdline_args()
	_log = GdhLog.new("--debug-godot" in args)

	# The script path is the argument after --script, so the operation and its parameters are
	# the two that follow it.
	var script_index: int = args.find("--script")
	if script_index == -1:
		_log.error("Could not find --script argument")
		quit(1)
		return

	var params_index: int = script_index + 3
	var answer_index: int = script_index + 4
	if args.size() <= answer_index:
		_log.error("Usage: godot_operations.gd <operation> @file:<params.json> <answer.json>")
		_log.error("Not enough command-line arguments provided.")
		quit(1)
		return

	_log.debug("All arguments: " + str(args))

	var operation: String = args[script_index + 2]
	var read: Variant = _read_params(args[params_index])
	if not read is Dictionary:
		quit(1)
		return
	# Through a typed local rather than straight into the call. The check above proves the type to
	# a reader and not to the analyser, so the call handed a Variant to a Dictionary parameter, and
	# a project holding unsafe_call_argument at error level then refused to compile this script at
	# all. It is compiled under the target project's warning levels, not under this package's.
	var params: Dictionary = read

	_log.info("Executing operation: " + operation)

	var answer_path: String = args[answer_index]
	if operation in AFTER_THE_AUTOLOADS:
		printerr(WAITING)
		var waiting: int = process_frame.connect(
			_answer_after_the_autoloads.bind(operation, params, answer_path), CONNECT_ONE_SHOT
		)
		if waiting != OK:
			_log.error("Could not wait for the project's autoloads: " + error_string(waiting))
			quit(1)
		return
	_answer(operation, params, answer_path)


func _answer_after_the_autoloads(operation: String, params: Dictionary, answer_path: String) -> void:
	printerr(BEGUN)
	_answer(operation, params, answer_path)


## Runs [param operation] and writes its answer to [param answer_path], then quits.
func _answer(operation: String, params: Dictionary, answer_path: String) -> void:
	var payload: Dictionary = _run(operation, params)
	if payload.is_empty():
		quit(1)
		return

	var answer: FileAccess = FileAccess.open(answer_path, FileAccess.WRITE)
	if answer == null:
		_log.error(
			"Could not write the answer to " + answer_path + ": " + error_string(FileAccess.get_open_error())
		)
		quit(1)
		return
	# Keys in the order they were put in, which for a map read is the order the resource keeps.
	var written: bool = answer.store_string(JSON.stringify(payload, "", false))
	answer.close()
	if not written:
		_log.error("Could not write the answer to " + answer_path)
		quit(1)
		return
	# On stderr, where the engine's errors go, so the server can tell what the project's autoloads
	# report after this from what the operation reported before it.
	printerr(ANSWERED)
	quit()


# The operation parameters. They arrive as a path to a JSON file rather than as JSON on argv
# because a blob on the command line runs into Windows parsing of \t, \r and \" whatever the
# quoting. Null means the parameters could not be read, and the reason is already on stderr.
func _read_params(argument: String) -> Variant:
	var params_json: String = argument

	if params_json.begins_with("@file:"):
		var params_file_path: String = params_json.substr(6)
		var params_file: FileAccess = FileAccess.open(params_file_path, FileAccess.READ)
		if params_file == null:
			_log.error("Failed to open params file: " + params_file_path)
			return null
		params_json = params_file.get_as_text()
		params_file.close()

	_log.debug("Params JSON: " + params_json)

	var json: JSON = JSON.new()
	if json.parse(params_json) != OK:
		_log.error("Failed to parse JSON parameters: " + params_json)
		_log.error("JSON Error: " + json.get_error_message() + " at line " + str(json.get_error_line()))
		return null

	var params: Variant = json.get_data()
	if not params is Dictionary:
		_log.error("Parameters must be a JSON object: " + params_json)
		return null
	return params


# The payload one operation answers with, or an empty dictionary when it failed or nobody
# owns the name.
func _run(operation: String, params: Dictionary) -> Dictionary:
	var payload: Dictionary = {}

	match operation:
		# Resource files
		"get_uid":
			payload = GdhResourceFiles.new(_log).get_uid(params)
		"refresh_class_cache":
			payload = GdhClassCache.new(_log).refresh_class_cache(params)
		"read_scene_tree":
			payload = _read(
				GdhFileReads.scene_tree(
					str(params.get("scene_path", "")),
					GdhRead.as_int(params.get("depth", -1), -1),
					GdhRead.as_bool(params.get("include_properties", false))
				)
			)
		"read_resource":
			payload = _read(
				GdhFileReads.resource(
					str(params.get("resource_path", "")),
					GdhRead.as_bool(params.get("include_defaults", false))
				)
			)
		"read_animations":
			payload = _read(
				GdhAnimationReads.scene_animations(
					str(params.get("scene_path", "")),
					str(params.get("player_node_path", ".")),
					str(params.get("animation_name", ""))
				)
			)
		"read_animation_states":
			payload = _read(
				GdhAnimationReads.scene_states(
					str(params.get("scene_path", "")),
					str(params.get("anim_tree_path", "")),
					str(params.get("state_machine_path", ""))
				)
			)

		"run_editor_tool":
			payload = _read(_editor_tool(params))

		# Import and export pipeline
		"get_import_status":
			payload = GdhImportPipeline.new(_log).get_import_status(params)
		"get_import_options":
			payload = GdhImportPipeline.new(_log).get_import_options(params)
		"set_import_options":
			payload = GdhImportPipeline.new(_log).set_import_options(params)
		"list_export_presets":
			payload = GdhExportPresets.new(_log).list_export_presets(params)
		"add_export_preset":
			payload = GdhExportPresets.new(_log).add_export_preset(params)
		"validate_project":
			payload = GdhImportPipeline.new(_log).validate_project(params)

		# Dependencies and project inspection
		"get_dependencies":
			payload = GdhDependencies.new(_log).get_dependencies(params)
		"find_resource_usages":
			payload = GdhDependencies.new(_log).find_resource_usages(params)
		"list_script_classes":
			payload = GdhDependencies.new(_log).list_script_classes(params)
		"get_project_health":
			payload = GdhProjectDiagnostics.new(_log).get_project_health(params)

		# project.godot
		"get_project_setting":
			payload = GdhProjectConfig.new(_log).get_project_setting(params)
		"set_project_setting":
			payload = GdhProjectConfig.new(_log).set_project_setting(params)
		"add_autoload":
			payload = GdhProjectConfig.new(_log).add_autoload(params)
		"remove_autoload":
			payload = GdhProjectConfig.new(_log).remove_autoload(params)
		"list_autoloads":
			payload = GdhProjectConfig.new(_log).list_autoloads(params)
		"set_main_scene":
			payload = GdhProjectConfig.new(_log).set_main_scene(params)

		# GDScript files
		"create_script":
			payload = GdhGdscriptAuthoring.new(_log).create_gdscript(params)
		"modify_script":
			payload = GdhGdscriptAuthoring.new(_log).modify_gdscript(params)
		"get_script_info":
			payload = GdhGdscriptAnalysis.new(_log).get_gdscript_info(params)
		"names_taken":
			payload = GdhRenameChecks.new(_log).names_taken(params)
		"check_scripts":
			payload = GdhScriptCheck.new(_log).check_scripts(params)

		# Plugins and input
		"list_plugins":
			payload = GdhPlugins.new(_log).list_plugins(params)
		"enable_plugin":
			payload = GdhPlugins.new(_log).enable_plugin(params)
		"disable_plugin":
			payload = GdhPlugins.new(_log).disable_plugin(params)
		"add_input_action":
			payload = GdhInputActions.new(_log).add_input_action(params)
		"remove_input_action":
			payload = GdhInputActions.new(_log).remove_input_action(params)
		"list_input_actions":
			payload = GdhInputActions.new(_log).list_input_actions(params)

		# Audio
		"create_audio_bus":
			payload = GdhAudioBuses.new(_log).create_audio_bus(params)
		"remove_audio_bus":
			payload = GdhAudioBuses.new(_log).remove_audio_bus(params)
		"get_audio_buses":
			payload = GdhAudioBuses.new(_log).get_audio_buses(params)
		"set_audio_bus_effect":
			payload = GdhAudioBuses.new(_log).set_audio_bus_effect(params)
		"set_audio_bus_volume":
			payload = GdhAudioBuses.new(_log).set_audio_bus_volume(params)

		# ClassDB
		"query_classes":
			payload = GdhClassDbQueries.new(_log).query_classes(params)
		"query_class_info":
			payload = GdhClassDbQueries.new(_log).query_class_info(params)
		"inspect_inheritance":
			payload = GdhClassDbQueries.new(_log).inspect_inheritance(params)

		_:
			_log.error("Unknown operation: " + operation)

	return payload


## A scene or resource tool of the editor addon, run as editor_tools.gd runs it. Loaded for this op
## alone, because the tools bring the editor addon's scene and resource scripts with them: preloaded
## here, every op compiled them, and an operations directory without the addons beside it lost every
## op rather than this one.
func _editor_tool(params: Dictionary) -> Dictionary:
	var own: Script = get_script()
	var path: String = own.resource_path.get_base_dir().path_join("editor_tools.gd")
	var tools: Script = ResourceLoader.load(path, "Script")
	if tools == null or not tools.can_instantiate():
		return {"ok": false, "error": "The editor tools did not load from %s." % path}
	var answer: Dictionary = tools.call("run", params)
	return answer


## A read the editor answers too, in the shape an operation answers: its refusal as the run's error.
func _read(read: Dictionary) -> Dictionary:
	if not read.get("ok", false):
		return _log.failure(str(read.get("error", "the read failed")))
	var _answered: bool = read.erase("ok")
	return read
