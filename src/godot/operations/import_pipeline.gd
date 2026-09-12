extends RefCounted

const FileWalk = preload("file_walk.gd")
const Log = preload("logger.gd")

const IMPORTABLE_EXTENSIONS = [
	"png", "jpg", "jpeg", "webp", "svg", "wav", "mp3", "ogg", "ttf", "otf", "glb", "gltf", "fbx", "obj"
]

var _log: Log
var _files := FileWalk.new()


func _init(p_log: Log) -> void:
	_log = p_log


# Get import status for resources
func get_import_status(params) -> Dictionary:
	var resource_path = params.get("resource_path", "")
	var include_up_to_date = params.get("include_up_to_date", false)

	_log.info(
		(
			"Getting import status"
			+ (" for: " + resource_path if not resource_path.is_empty() else " for all resources")
		)
	)

	var result = {
		"resources": [], "summary": {"total": 0, "needs_reimport": 0, "up_to_date": 0, "missing_source": 0}
	}

	if not resource_path.is_empty():
		# Check specific resource
		var full_path = resource_path
		if not full_path.begins_with("res://"):
			full_path = "res://" + full_path

		var status = _import_status_of(full_path, full_path + ".import")
		result["resources"].append(status)
		result["summary"]["total"] = 1
		if status["status"] == "needs_reimport":
			result["summary"]["needs_reimport"] = 1
		elif status["status"] == "up_to_date":
			result["summary"]["up_to_date"] = 1
		elif status["status"] == "missing_source":
			result["summary"]["missing_source"] = 1
	else:
		# Scan all importable resources
		for res_path in _files.find_files_with_extensions("res://", IMPORTABLE_EXTENSIONS):
			var status = _import_status_of(res_path, res_path + ".import")

			if include_up_to_date or status["status"] != "up_to_date":
				result["resources"].append(status)

			result["summary"]["total"] += 1
			if status["status"] == "needs_reimport":
				result["summary"]["needs_reimport"] += 1
			elif status["status"] == "up_to_date":
				result["summary"]["up_to_date"] += 1
			elif status["status"] == "missing_source":
				result["summary"]["missing_source"] += 1

	return result


# Get import options for a resource
func get_import_options(params) -> Dictionary:
	var resource_path = params.resource_path
	if not resource_path.begins_with("res://"):
		resource_path = "res://" + resource_path

	_log.info("Getting import options for: " + resource_path)

	var import_file_path = resource_path + ".import"

	if not FileAccess.file_exists(import_file_path):
		_log.error("Import file does not exist: " + import_file_path)
		return _log.failure("This resource may not have been imported yet")

	# Parse the .import file
	var config = ConfigFile.new()
	var err = config.load(import_file_path)

	if err != OK:
		return _log.failure("Failed to parse import file: " + str(err))

	var result = {
		"resource_path": resource_path, "import_file": import_file_path, "remap": {}, "deps": {}, "params": {}
	}

	for section in ["remap", "deps", "params"]:
		if config.has_section(section):
			for key in config.get_section_keys(section):
				result[section][key] = config.get_value(section, key)

	return result


# Set import options for a resource
func set_import_options(params) -> Dictionary:
	var resource_path = params.resource_path
	if not resource_path.begins_with("res://"):
		resource_path = "res://" + resource_path

	var options = params.options
	var do_reimport = params.get("reimport", true)

	_log.info("Setting import options for: " + resource_path)

	var import_file_path = resource_path + ".import"

	if not FileAccess.file_exists(import_file_path):
		_log.error("Import file does not exist: " + import_file_path)
		return _log.failure("This resource may not have been imported yet")

	# Parse existing .import file
	var config = ConfigFile.new()
	var err = config.load(import_file_path)

	if err != OK:
		return _log.failure("Failed to parse import file: " + str(err))

	# Update options in params section
	var updated_keys = []
	for key in options:
		config.set_value("params", key, options[key])
		updated_keys.append(key)
		_log.debug("Set " + key + " = " + str(options[key]))

	# Save the updated config
	err = config.save(import_file_path)
	if err != OK:
		return _log.failure("Failed to save import file: " + str(err))

	var result = {
		"resource_path": resource_path, "updated_options": updated_keys, "reimport_triggered": do_reimport
	}

	# A headless engine has no importer to run, so the .import file is as far as this goes.
	if do_reimport:
		result["note"] = "Import file updated. Run the editor or use 'reimport_resource' to apply changes."

	return result


# Reimport a resource or all resources
func reimport_resource(params) -> Dictionary:
	var resource_path = params.get("resource_path", "")
	var force = params.get("force", false)

	_log.info(
		(
			"Reimporting"
			+ (" resource: " + resource_path if not resource_path.is_empty() else " all modified resources")
		)
	)

	# A full reimport is editor work; headless can only report what the state is.
	var result = {
		"status": "requested",
		"resource_path": resource_path if not resource_path.is_empty() else "all",
		"force": force,
		"note": "Reimport in headless mode is limited. For full reimport, open the project in the editor."
	}

	# We can at least verify the resource exists and check its status
	if not resource_path.is_empty():
		var full_path = resource_path
		if not full_path.begins_with("res://"):
			full_path = "res://" + full_path

		if not FileAccess.file_exists(full_path):
			return _log.failure("Resource file does not exist: " + full_path)

		result["current_status"] = _import_status_of(full_path, full_path + ".import")["status"]

	return result


# List export presets
func list_export_presets(params) -> Dictionary:
	var include_template_status = params.get("include_template_status", true)

	_log.info("Listing export presets")

	var presets_file = "res://export_presets.cfg"

	var result = {"presets": [], "presets_file_exists": FileAccess.file_exists(presets_file)}

	if not result["presets_file_exists"]:
		result["note"] = "No export_presets.cfg found. Configure export presets in the Godot editor."
		return result

	# Parse export_presets.cfg
	var config = ConfigFile.new()
	var err = config.load(presets_file)

	if err != OK:
		return _log.failure("Failed to parse export_presets.cfg: " + str(err))

	# Export presets are stored as [preset.0], [preset.1], etc.
	var preset_idx = 0
	while config.has_section("preset." + str(preset_idx)):
		var section = "preset." + str(preset_idx)
		var preset = {
			"index": preset_idx,
			"name": config.get_value(section, "name", "Unknown"),
			"platform": config.get_value(section, "platform", "Unknown"),
			"runnable": config.get_value(section, "runnable", false),
			"export_path": config.get_value(section, "export_path", ""),
			"export_filter": config.get_value(section, "export_filter", "all_resources"),
			"include_filter": config.get_value(section, "include_filter", ""),
			"exclude_filter": config.get_value(section, "exclude_filter", "")
		}

		# Get custom features if present
		if config.has_section_key(section, "custom_features"):
			preset["custom_features"] = config.get_value(section, "custom_features", "")

		# Whether a template is installed is a runtime question the editor answers, not this.
		if include_template_status:
			preset["template_status"] = "unknown (headless mode)"

		result["presets"].append(preset)
		preset_idx += 1

	result["total_presets"] = preset_idx
	return result


# Validate project for export
func validate_project(params) -> Dictionary:
	var preset_name = params.get("preset", "")
	var include_suggestions = params.get("include_suggestions", true)

	_log.info("Validating project" + (" for preset: " + preset_name if not preset_name.is_empty() else ""))

	var result = {"valid": true, "issues": [], "warnings": [], "checks_performed": []}

	# Check 1: project.godot exists
	result["checks_performed"].append("project_file")
	if not FileAccess.file_exists("res://project.godot"):
		result["valid"] = false
		var issue = {"type": "error", "check": "project_file", "message": "project.godot not found"}
		if include_suggestions:
			issue["suggestion"] = "Ensure you are running this from a valid Godot project directory"
		result["issues"].append(issue)

	# Check 2: Main scene is set
	result["checks_performed"].append("main_scene")
	var main_scene = ProjectSettings.get_setting("application/run/main_scene", "")
	if main_scene.is_empty():
		result["valid"] = false
		var issue = {"type": "error", "check": "main_scene", "message": "No main scene set"}
		if include_suggestions:
			issue["suggestion"] = "Set a main scene in Project Settings > Application > Run > Main Scene"
		result["issues"].append(issue)
	elif not FileAccess.file_exists(main_scene):
		result["valid"] = false
		var issue = {
			"type": "error", "check": "main_scene", "message": "Main scene file does not exist: " + main_scene
		}
		if include_suggestions:
			issue["suggestion"] = "Update the main scene setting or create the missing scene file"
		result["issues"].append(issue)

	# Check 3: Export presets exist
	result["checks_performed"].append("export_presets")
	if not FileAccess.file_exists("res://export_presets.cfg"):
		var warning = {
			"type": "warning", "check": "export_presets", "message": "No export presets configured"
		}
		if include_suggestions:
			warning["suggestion"] = "Configure export presets in Godot editor: Project > Export"
		result["warnings"].append(warning)

	# Check 4: Icon is set
	result["checks_performed"].append("icon")
	var icon_path = ProjectSettings.get_setting("application/config/icon", "")
	if icon_path.is_empty():
		var warning = {"type": "warning", "check": "icon", "message": "No application icon set"}
		if include_suggestions:
			warning["suggestion"] = "Set an icon in Project Settings > Application > Config > Icon"
		result["warnings"].append(warning)
	elif not FileAccess.file_exists(icon_path):
		var warning = {
			"type": "warning", "check": "icon", "message": "Icon file does not exist: " + icon_path
		}
		if include_suggestions:
			warning["suggestion"] = "Update the icon path or add the missing icon file"
		result["warnings"].append(warning)

	# Check 5: Project name is set
	result["checks_performed"].append("project_name")
	var project_name = ProjectSettings.get_setting("application/config/name", "")
	if project_name.is_empty():
		var warning = {"type": "warning", "check": "project_name", "message": "No project name set"}
		if include_suggestions:
			warning["suggestion"] = "Set a project name in Project Settings > Application > Config > Name"
		result["warnings"].append(warning)

	# Check 6: Look for common issues in scripts (basic check)
	result["checks_performed"].append("scripts")
	var script_files = _files.find_files_with_extensions("res://", ["gd"])
	var scripts_checked = 0
	var script_issues = []

	for script_path in script_files:
		scripts_checked += 1
		if scripts_checked > 100:  # Limit to prevent long execution
			break

		var file = FileAccess.open(script_path, FileAccess.READ)
		if file:
			var content = file.get_as_text()
			file.close()

			# Check for common issues
			if "# TODO" in content or "# FIXME" in content:
				script_issues.append({"path": script_path, "issue": "Contains TODO/FIXME comments"})
			if "pass # TODO" in content:
				script_issues.append({"path": script_path, "issue": "Contains unimplemented functions"})

	if script_issues.size() > 0:
		var warning = {
			"type": "warning",
			"check": "scripts",
			"message": str(script_issues.size()) + " script issues found",
			"details": script_issues.slice(0, 5)
		}
		if include_suggestions:
			warning["suggestion"] = "Review and resolve TODO/FIXME items before release"
		result["warnings"].append(warning)

	result["scripts_checked"] = scripts_checked
	result["issue_count"] = result["issues"].size()
	result["warning_count"] = result["warnings"].size()

	return result


# Whether a resource is imported, out of date, or has lost its source file.
func _import_status_of(resource_path: String, import_file_path: String) -> Dictionary:
	var status = {
		"path": resource_path, "status": "unknown", "import_file_exists": false, "source_exists": false
	}

	# Check if source file exists
	status["source_exists"] = FileAccess.file_exists(resource_path)
	if not status["source_exists"]:
		status["status"] = "missing_source"
		return status

	# Check if .import file exists
	status["import_file_exists"] = FileAccess.file_exists(import_file_path)
	if not status["import_file_exists"]:
		status["status"] = "needs_reimport"
		return status

	# Compare modification times
	var source_modified = FileAccess.get_modified_time(resource_path)
	var import_modified = FileAccess.get_modified_time(import_file_path)

	if source_modified > import_modified:
		status["status"] = "needs_reimport"
	else:
		status["status"] = "up_to_date"

	return status
