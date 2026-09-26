#!/usr/bin/env -S godot --headless --script
extends SceneTree

# The command line the server runs is `godot --headless --path <project> --script <this>
# <operation> @file:<params.json>`, and one JSON object on stdout is the answer. Everything an
# operation does lives in a sibling module; this file is the command table and the wire format.
#
# Each module is preloaded by a path relative to this script rather than a res:// one, because
# the operations directory ships inside the server package and is handed to the engine as an
# absolute path outside the project. A res:// path would only resolve in the test fixture.

const AudioBuses = preload("audio_buses.gd")
const ClassCache = preload("class_cache.gd")
const ClassDbQueries = preload("classdb_queries.gd")
const Dependencies = preload("dependencies.gd")
const GdscriptAnalysis = preload("gdscript_analysis.gd")
const GdscriptAuthoring = preload("gdscript_authoring.gd")
const ImportPipeline = preload("import_pipeline.gd")
const InputActions = preload("input_actions.gd")
const Log = preload("logger.gd")
const Plugins = preload("plugins.gd")
const ProjectConfig = preload("project_config.gd")
const ProjectDiagnostics = preload("project_diagnostics.gd")
const ResourceFiles = preload("resource_files.gd")

var _log: Log


func _init() -> void:
	var args: PackedStringArray = OS.get_cmdline_args()
	_log = Log.new("--debug-godot" in args)

	# The script path is the argument after --script, so the operation and its parameters are
	# the two that follow it.
	var script_index: int = args.find("--script")
	if script_index == -1:
		_log.error("Could not find --script argument")
		quit(1)
		return

	var params_index: int = script_index + 3
	if args.size() <= params_index:
		_log.error("Usage: godot --headless --script godot_operations.gd <operation> <json_params>")
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

	var payload: Dictionary = _run(operation, params)
	if payload.is_empty():
		quit(1)
		return

	print(JSON.stringify(payload))
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
			payload = ResourceFiles.new(_log).get_uid(params)
		"refresh_class_cache":
			payload = ClassCache.new(_log).refresh_class_cache(params)

		# Import and export pipeline
		"get_import_status":
			payload = ImportPipeline.new(_log).get_import_status(params)
		"get_import_options":
			payload = ImportPipeline.new(_log).get_import_options(params)
		"set_import_options":
			payload = ImportPipeline.new(_log).set_import_options(params)
		"list_export_presets":
			payload = ImportPipeline.new(_log).list_export_presets(params)
		"validate_project":
			payload = ImportPipeline.new(_log).validate_project(params)

		# Dependencies and project inspection
		"get_dependencies":
			payload = Dependencies.new(_log).get_dependencies(params)
		"find_resource_usages":
			payload = Dependencies.new(_log).find_resource_usages(params)
		"get_project_health":
			payload = ProjectDiagnostics.new(_log).get_project_health(params)

		# project.godot
		"get_project_setting":
			payload = ProjectConfig.new(_log).get_project_setting(params)
		"set_project_setting":
			payload = ProjectConfig.new(_log).set_project_setting(params)
		"add_autoload":
			payload = ProjectConfig.new(_log).add_autoload(params)
		"remove_autoload":
			payload = ProjectConfig.new(_log).remove_autoload(params)
		"list_autoloads":
			payload = ProjectConfig.new(_log).list_autoloads(params)
		"set_main_scene":
			payload = ProjectConfig.new(_log).set_main_scene(params)

		# GDScript files
		"create_script":
			payload = GdscriptAuthoring.new(_log).create_gdscript(params)
		"modify_script":
			payload = GdscriptAuthoring.new(_log).modify_gdscript(params)
		"get_script_info":
			payload = GdscriptAnalysis.new(_log).get_gdscript_info(params)

		# Plugins and input
		"list_plugins":
			payload = Plugins.new(_log).list_plugins(params)
		"enable_plugin":
			payload = Plugins.new(_log).enable_plugin(params)
		"disable_plugin":
			payload = Plugins.new(_log).disable_plugin(params)
		"add_input_action":
			payload = InputActions.new(_log).add_input_action(params)

		# Audio
		"create_audio_bus":
			payload = AudioBuses.new(_log).create_audio_bus(params)
		"get_audio_buses":
			payload = AudioBuses.new(_log).get_audio_buses(params)
		"set_audio_bus_effect":
			payload = AudioBuses.new(_log).set_audio_bus_effect(params)
		"set_audio_bus_volume":
			payload = AudioBuses.new(_log).set_audio_bus_volume(params)

		# ClassDB
		"query_classes":
			payload = ClassDbQueries.new(_log).query_classes(params)
		"query_class_info":
			payload = ClassDbQueries.new(_log).query_class_info(params)
		"inspect_inheritance":
			payload = ClassDbQueries.new(_log).inspect_inheritance(params)

		_:
			_log.error("Unknown operation: " + operation)

	return payload
