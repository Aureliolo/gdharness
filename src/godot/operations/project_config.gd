extends RefCounted

const Log = preload("logger.gd")
const Serialisation = preload("serialisation.gd")

var _log: Log
var _values: Serialisation = Serialisation.new()


func _init(p_log: Log) -> void:
	_log = p_log


# Get a project setting value
func get_project_setting(params: Dictionary) -> Dictionary:
	var setting_path: String = str(params.get("setting", ""))
	var include_metadata: bool = bool(params.get("include_metadata", false))

	_log.info("Getting project setting: " + setting_path)

	var result: Dictionary = {
		"setting_path": setting_path, "exists": ProjectSettings.has_setting(setting_path)
	}

	if result["exists"]:
		var value: Variant = ProjectSettings.get_setting(setting_path)
		result["value"] = _values.serialize_value(value)

		if include_metadata:
			result["type"] = typeof(value)
			result["type_name"] = type_string(typeof(value))
	else:
		result["value"] = null
		result["message"] = "Setting does not exist"

	return result


# Set a project setting value
func set_project_setting(params: Dictionary) -> Dictionary:
	var setting_path: String = str(params.get("setting", ""))
	var value: Variant = params.get("value")
	var save_immediately: bool = bool(params.get("save", true))

	_log.info("Setting project setting: " + setting_path)

	var old_value: Variant = null
	var had_value: bool = ProjectSettings.has_setting(setting_path)
	if had_value:
		old_value = ProjectSettings.get_setting(setting_path)

	var final_value: Variant = _values.deserialize_value(value)

	ProjectSettings.set_setting(setting_path, final_value)

	var result: Dictionary = {
		"setting_path": setting_path,
		"old_value": _values.serialize_value(old_value) if had_value else null,
		"new_value": _values.serialize_value(final_value),
		"was_new": not had_value
	}

	if save_immediately:
		var err: Error = ProjectSettings.save()
		result["saved"] = err == OK
		if err != OK:
			result["save_error"] = str(err)

	return result


# Add an autoload singleton
func add_autoload(params: Dictionary) -> Dictionary:
	var name: String = str(params.get("name", ""))
	var path: String = str(params.get("path", ""))
	var enabled: bool = bool(params.get("enabled", true))

	if not path.begins_with("res://"):
		path = "res://" + path

	_log.info("Adding autoload: " + name + " -> " + path)

	if not FileAccess.file_exists(path):
		return _log.failure("Autoload file does not exist: " + path)

	var config: ConfigFile = ConfigFile.new()
	var err: Error = config.load("res://project.godot")
	if err != OK:
		return _log.failure("Failed to load project.godot: " + str(err))

	var was_updated: bool = config.has_section_key("autoload", name)

	# An asterisk in front of the path is how project.godot marks an autoload as enabled.
	config.set_value("autoload", name, ("*" if enabled else "") + path)

	err = config.save("res://project.godot")
	if err != OK:
		return _log.failure("Failed to save project.godot: " + str(err))

	return {"name": name, "path": path, "enabled": enabled, "action": "updated" if was_updated else "added"}


# Remove an autoload singleton
func remove_autoload(params: Dictionary) -> Dictionary:
	var name: String = str(params.get("name", ""))

	_log.info("Removing autoload: " + name)

	var config: ConfigFile = ConfigFile.new()
	var err: Error = config.load("res://project.godot")
	if err != OK:
		return _log.failure("Failed to load project.godot: " + str(err))

	if not config.has_section_key("autoload", name):
		return _log.failure("Autoload not found: " + name)

	var old_value: String = str(config.get_value("autoload", name, ""))
	config.erase_section_key("autoload", name)

	err = config.save("res://project.godot")
	if err != OK:
		return _log.failure("Failed to save project.godot: " + str(err))

	return {"name": name, "removed": true, "old_path": old_value.trim_prefix("*")}


# List all autoload singletons
func list_autoloads(params: Dictionary) -> Dictionary:
	var include_status: bool = bool(params.get("include_status", true))

	_log.info("Listing autoloads")

	var config: ConfigFile = ConfigFile.new()
	var err: Error = config.load("res://project.godot")
	if err != OK:
		return _log.failure("Failed to load project.godot: " + str(err))

	var autoloads: Array[Dictionary] = []

	if config.has_section("autoload"):
		for key: String in config.get_section_keys("autoload"):
			var value: String = str(config.get_value("autoload", key, ""))
			var path: String = value.trim_prefix("*")

			var autoload_info: Dictionary = {"name": key, "path": path, "enabled": value.begins_with("*")}

			if include_status:
				autoload_info["file_exists"] = FileAccess.file_exists(path)

			autoloads.append(autoload_info)

	return {"autoloads": autoloads, "count": autoloads.size()}


# Set the main scene
func set_main_scene(params: Dictionary) -> Dictionary:
	var scene_path: String = str(params.get("scene_path", ""))

	if not scene_path.begins_with("res://"):
		scene_path = "res://" + scene_path

	_log.info("Setting main scene: " + scene_path)

	if not FileAccess.file_exists(scene_path):
		return _log.failure("Scene file does not exist: " + scene_path)

	var old_main_scene: String = str(ProjectSettings.get_setting("application/run/main_scene", ""))

	ProjectSettings.set_setting("application/run/main_scene", scene_path)
	var err: Error = ProjectSettings.save()

	if err != OK:
		return _log.failure("Failed to save project settings: " + str(err))

	return {"old_main_scene": old_main_scene, "new_main_scene": scene_path, "saved": true}
