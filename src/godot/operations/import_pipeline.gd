extends RefCounted

const Read = preload("reading.gd")
const FileWalk = preload("file_walk.gd")
const Log = preload("logger.gd")

const IMPORTABLE_EXTENSIONS: Array[String] = [
	"png", "jpg", "jpeg", "webp", "svg", "wav", "mp3", "ogg", "ttf", "otf", "glb", "gltf", "fbx", "obj"
]

var _log: Log
var _files: FileWalk = FileWalk.new()


func _init(p_log: Log) -> void:
	_log = p_log


# Get import status for resources
func get_import_status(params: Dictionary) -> Dictionary:
	var resource_path: String = str(params.get("resource_path", ""))
	var include_up_to_date: bool = Read.as_bool(params.get("include_up_to_date", false))

	_log.info(
		(
			"Getting import status"
			+ (" for: " + resource_path if not resource_path.is_empty() else " for all resources")
		)
	)

	var resources: Array[Dictionary] = []
	var summary: Dictionary = {"total": 0, "needs_reimport": 0, "up_to_date": 0, "missing_source": 0}

	if not resource_path.is_empty():
		var full_path: String = resource_path
		if not full_path.begins_with("res://"):
			full_path = "res://" + full_path

		var status: Dictionary = _import_status_of(full_path, full_path + ".import")
		resources.append(status)
		_tally(summary, status)
	else:
		for res_path: String in _files.find_files_with_extensions("res://", IMPORTABLE_EXTENSIONS):
			var status: Dictionary = _import_status_of(res_path, res_path + ".import")

			if include_up_to_date or status["status"] != "up_to_date":
				resources.append(status)

			_tally(summary, status)

	return {"resources": resources, "summary": summary}


# Get import options for a resource
func get_import_options(params: Dictionary) -> Dictionary:
	var resource_path: String = str(params.get("resource_path", ""))
	if not resource_path.begins_with("res://"):
		resource_path = "res://" + resource_path

	_log.info("Getting import options for: " + resource_path)

	var import_file_path: String = resource_path + ".import"

	if not FileAccess.file_exists(import_file_path):
		_log.error("Import file does not exist: " + import_file_path)
		return _log.failure("This resource may not have been imported yet")

	var config: ConfigFile = ConfigFile.new()
	var err: Error = config.load(import_file_path)

	if err != OK:
		return _log.failure("Failed to parse import file: " + str(err))

	var result: Dictionary = {
		"resource_path": resource_path, "import_file": import_file_path, "remap": {}, "deps": {}, "params": {}
	}

	for section: String in ["remap", "deps", "params"]:
		if config.has_section(section):
			var values: Dictionary = result[section]
			for key: String in config.get_section_keys(section):
				values[key] = config.get_value(section, key)

	return result


# Set import options for a resource
func set_import_options(params: Dictionary) -> Dictionary:
	var resource_path: String = str(params.get("resource_path", ""))
	if not resource_path.begins_with("res://"):
		resource_path = "res://" + resource_path

	var options: Dictionary = params.get("options", {})
	var do_reimport: bool = Read.as_bool(params.get("reimport", true), true)

	_log.info("Setting import options for: " + resource_path)

	var import_file_path: String = resource_path + ".import"

	if not FileAccess.file_exists(import_file_path):
		_log.error("Import file does not exist: " + import_file_path)
		return _log.failure("This resource may not have been imported yet")

	var config: ConfigFile = ConfigFile.new()
	var err: Error = config.load(import_file_path)

	if err != OK:
		return _log.failure("Failed to parse import file: " + str(err))

	var updated_keys: Array[String] = []
	for key: Variant in options:
		var name: String = str(key)
		config.set_value("params", name, options[key])
		updated_keys.append(name)
		_log.debug("Set " + name + " = " + str(options[key]))

	err = config.save(import_file_path)
	if err != OK:
		return _log.failure("Failed to save import file: " + str(err))

	var result: Dictionary = {
		"resource_path": resource_path, "updated_options": updated_keys, "reimport_triggered": do_reimport
	}

	# A headless engine has no importer to run, so the .import file is as far as this goes.
	if do_reimport:
		result["note"] = "Import file updated. Run the editor or use 'reimport_resource' to apply changes."

	return result


# Reimport a resource or all resources
func reimport_resource(params: Dictionary) -> Dictionary:
	var resource_path: String = str(params.get("resource_path", ""))
	var force: bool = Read.as_bool(params.get("force", false))

	_log.info(
		(
			"Reimporting"
			+ (" resource: " + resource_path if not resource_path.is_empty() else " all modified resources")
		)
	)

	# A full reimport is editor work; headless can only report what the state is.
	var result: Dictionary = {
		"status": "requested",
		"resource_path": resource_path if not resource_path.is_empty() else "all",
		"force": force,
		"note": "Reimport in headless mode is limited. For full reimport, open the project in the editor."
	}

	if not resource_path.is_empty():
		var full_path: String = resource_path
		if not full_path.begins_with("res://"):
			full_path = "res://" + full_path

		if not FileAccess.file_exists(full_path):
			return _log.failure("Resource file does not exist: " + full_path)

		result["current_status"] = _import_status_of(full_path, full_path + ".import")["status"]

	return result


# List export presets
func list_export_presets(_params: Dictionary) -> Dictionary:
	_log.info("Listing export presets")

	var presets_file: String = "res://export_presets.cfg"

	if not FileAccess.file_exists(presets_file):
		return {
			"presets": [],
			"presets_file_exists": false,
			"note": "No export_presets.cfg found. Configure export presets in the Godot editor."
		}

	var config: ConfigFile = ConfigFile.new()
	var err: Error = config.load(presets_file)

	if err != OK:
		return _log.failure("Failed to parse export_presets.cfg: " + str(err))

	# Export presets are stored as [preset.0], [preset.1], etc.
	var presets: Array[Dictionary] = []
	var preset_idx: int = 0
	while config.has_section("preset." + str(preset_idx)):
		var section: String = "preset." + str(preset_idx)
		var preset: Dictionary = {
			"index": preset_idx,
			"name": config.get_value(section, "name", "Unknown"),
			"platform": config.get_value(section, "platform", "Unknown"),
			"runnable": config.get_value(section, "runnable", false),
			"export_path": config.get_value(section, "export_path", ""),
			"export_filter": config.get_value(section, "export_filter", "all_resources"),
			"include_filter": config.get_value(section, "include_filter", ""),
			"exclude_filter": config.get_value(section, "exclude_filter", "")
		}

		if config.has_section_key(section, "custom_features"):
			preset["custom_features"] = config.get_value(section, "custom_features", "")

		presets.append(preset)
		preset_idx += 1

	return {"presets": presets, "presets_file_exists": true, "total_presets": preset_idx}


# Validate project for export
func validate_project(params: Dictionary) -> Dictionary:
	var preset_name: String = str(params.get("preset", ""))
	var include_suggestions: bool = Read.as_bool(params.get("include_suggestions", true), true)

	_log.info("Validating project" + (" for preset: " + preset_name if not preset_name.is_empty() else ""))

	var issues: Array[Dictionary] = []
	var warnings: Array[Dictionary] = []
	var checks_performed: Array[String] = []

	checks_performed.append("project_file")
	if not FileAccess.file_exists("res://project.godot"):
		issues.append(
			_finding(
				"error",
				"project_file",
				"project.godot not found",
				"Ensure you are running this from a valid Godot project directory",
				include_suggestions
			)
		)

	checks_performed.append("main_scene")
	var main_scene: String = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if main_scene.is_empty():
		issues.append(
			_finding(
				"error",
				"main_scene",
				"No main scene set",
				"Set a main scene in Project Settings > Application > Run > Main Scene",
				include_suggestions
			)
		)
	elif not FileAccess.file_exists(main_scene):
		issues.append(
			_finding(
				"error",
				"main_scene",
				"Main scene file does not exist: " + main_scene,
				"Update the main scene setting or create the missing scene file",
				include_suggestions
			)
		)

	checks_performed.append("export_presets")
	if not FileAccess.file_exists("res://export_presets.cfg"):
		warnings.append(
			_finding(
				"warning",
				"export_presets",
				"No export presets configured",
				"Configure export presets in Godot editor: Project > Export",
				include_suggestions
			)
		)

	checks_performed.append("icon")
	var icon_path: String = str(ProjectSettings.get_setting("application/config/icon", ""))
	if icon_path.is_empty():
		warnings.append(
			_finding(
				"warning",
				"icon",
				"No application icon set",
				"Set an icon in Project Settings > Application > Config > Icon",
				include_suggestions
			)
		)
	elif not FileAccess.file_exists(icon_path):
		warnings.append(
			_finding(
				"warning",
				"icon",
				"Icon file does not exist: " + icon_path,
				"Update the icon path or add the missing icon file",
				include_suggestions
			)
		)

	checks_performed.append("project_name")
	var project_name: String = str(ProjectSettings.get_setting("application/config/name", ""))
	if project_name.is_empty():
		warnings.append(
			_finding(
				"warning",
				"project_name",
				"No project name set",
				"Set a project name in Project Settings > Application > Config > Name",
				include_suggestions
			)
		)

	checks_performed.append("scripts")
	var script_files: Array[String] = _files.find_files_with_extensions("res://", ["gd"])
	var scripts_checked: int = 0
	var script_issues: Array[Dictionary] = []

	# A hundred scripts is enough to say whether the project is tidy without a large one
	# turning validation into a full read of its source tree.
	for script_path: String in script_files:
		scripts_checked += 1
		if scripts_checked > 100:
			break

		var file: FileAccess = FileAccess.open(script_path, FileAccess.READ)
		if file:
			var content: String = file.get_as_text()
			file.close()

			if "# TODO" in content or "# FIXME" in content:
				script_issues.append({"path": script_path, "issue": "Contains TODO/FIXME comments"})
			if "pass # TODO" in content:
				script_issues.append({"path": script_path, "issue": "Contains unimplemented functions"})

	if script_issues.size() > 0:
		var warning: Dictionary = _finding(
			"warning",
			"scripts",
			str(script_issues.size()) + " script issues found",
			"Review and resolve TODO/FIXME items before release",
			include_suggestions
		)
		warning["details"] = script_issues.slice(0, 5)
		warnings.append(warning)

	return {
		"valid": issues.is_empty(),
		"issues": issues,
		"warnings": warnings,
		"checks_performed": checks_performed,
		"scripts_checked": scripts_checked,
		"issue_count": issues.size(),
		"warning_count": warnings.size()
	}


func _finding(
	type: String, check: String, message: String, suggestion: String, include_suggestion: bool
) -> Dictionary:
	var finding: Dictionary = {"type": type, "check": check, "message": message}
	if include_suggestion:
		finding["suggestion"] = suggestion
	return finding


func _tally(summary: Dictionary, status: Dictionary) -> void:
	summary["total"] += 1
	var state: String = status["status"]
	if summary.has(state):
		summary[state] += 1


# Whether a resource is imported, out of date, or has lost its source file.
func _import_status_of(resource_path: String, import_file_path: String) -> Dictionary:
	var source_exists: bool = FileAccess.file_exists(resource_path)
	if not source_exists:
		return {
			"path": resource_path,
			"status": "missing_source",
			"import_file_exists": false,
			"source_exists": false
		}

	var import_file_exists: bool = FileAccess.file_exists(import_file_path)
	if not import_file_exists:
		return {
			"path": resource_path,
			"status": "needs_reimport",
			"import_file_exists": false,
			"source_exists": true
		}

	var source_modified: int = FileAccess.get_modified_time(resource_path)
	var import_modified: int = FileAccess.get_modified_time(import_file_path)

	return {
		"path": resource_path,
		"status": "needs_reimport" if source_modified > import_modified else "up_to_date",
		"import_file_exists": true,
		"source_exists": true
	}
