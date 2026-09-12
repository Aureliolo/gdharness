extends RefCounted

const Log = preload("logger.gd")
const Serialisation = preload("serialisation.gd")

var _log: Log
var _values := Serialisation.new()


func _init(p_log: Log) -> void:
	_log = p_log


# Get a project setting value
func get_project_setting(params) -> Dictionary:
	var setting_path = params.setting
	var include_metadata = params.get("include_metadata", false)

	_log.info("Getting project setting: " + setting_path)

	var result = {"setting_path": setting_path, "exists": ProjectSettings.has_setting(setting_path)}

	if result["exists"]:
		var value = ProjectSettings.get_setting(setting_path)
		result["value"] = _values.serialize_value(value)

		if include_metadata:
			result["type"] = typeof(value)
			result["type_name"] = type_string(typeof(value))
	else:
		result["value"] = null
		result["message"] = "Setting does not exist"

	return result


# Set a project setting value
func set_project_setting(params) -> Dictionary:
	var setting_path = params.setting
	var value = params.value
	var save_immediately = params.get("save", true)

	_log.info("Setting project setting: " + setting_path)

	var old_value = null
	var had_value = ProjectSettings.has_setting(setting_path)
	if had_value:
		old_value = ProjectSettings.get_setting(setting_path)

	# Deserialize value if needed
	var final_value = _values.deserialize_value(value)

	ProjectSettings.set_setting(setting_path, final_value)

	var result = {
		"setting_path": setting_path,
		"old_value": _values.serialize_value(old_value) if had_value else null,
		"new_value": _values.serialize_value(final_value),
		"was_new": not had_value
	}

	if save_immediately:
		var err = ProjectSettings.save()
		result["saved"] = err == OK
		if err != OK:
			result["save_error"] = str(err)

	return result


# Add an autoload singleton
func add_autoload(params) -> Dictionary:
	var name = params.name
	var path = params.path
	var enabled = params.get("enabled", true)

	if not path.begins_with("res://"):
		path = "res://" + path

	_log.info("Adding autoload: " + name + " -> " + path)

	# Verify the script/scene exists
	if not FileAccess.file_exists(path):
		return _log.failure("Autoload file does not exist: " + path)

	# Read project.godot file
	var config = ConfigFile.new()
	var err = config.load("res://project.godot")
	if err != OK:
		return _log.failure("Failed to load project.godot: " + str(err))

	# Check if autoload already exists
	var existing_autoloads = []
	if config.has_section("autoload"):
		for key in config.get_section_keys("autoload"):
			existing_autoloads.append(key)

	var was_updated = name in existing_autoloads

	# Format: "*res://path/to/script.gd" (asterisk means enabled)
	config.set_value("autoload", name, ("*" if enabled else "") + path)

	err = config.save("res://project.godot")
	if err != OK:
		return _log.failure("Failed to save project.godot: " + str(err))

	return {"name": name, "path": path, "enabled": enabled, "action": "updated" if was_updated else "added"}


# Remove an autoload singleton
func remove_autoload(params) -> Dictionary:
	var name = params.name

	_log.info("Removing autoload: " + name)

	# Read project.godot file
	var config = ConfigFile.new()
	var err = config.load("res://project.godot")
	if err != OK:
		return _log.failure("Failed to load project.godot: " + str(err))

	var existed = false
	var old_value = ""

	if config.has_section("autoload"):
		if config.has_section_key("autoload", name):
			existed = true
			old_value = config.get_value("autoload", name, "")
			config.erase_section_key("autoload", name)

	if not existed:
		return _log.failure("Autoload not found: " + name)

	err = config.save("res://project.godot")
	if err != OK:
		return _log.failure("Failed to save project.godot: " + str(err))

	return {"name": name, "removed": true, "old_path": old_value.trim_prefix("*")}


# List all autoload singletons
func list_autoloads(params) -> Dictionary:
	var include_status = params.get("include_status", true)

	_log.info("Listing autoloads")

	# Read project.godot file
	var config = ConfigFile.new()
	var err = config.load("res://project.godot")
	if err != OK:
		return _log.failure("Failed to load project.godot: " + str(err))

	var autoloads = []

	if config.has_section("autoload"):
		for key in config.get_section_keys("autoload"):
			var value = config.get_value("autoload", key, "")
			var path = value.trim_prefix("*")

			var autoload_info = {"name": key, "path": path, "enabled": value.begins_with("*")}

			if include_status:
				autoload_info["file_exists"] = FileAccess.file_exists(path)

			autoloads.append(autoload_info)

	return {"autoloads": autoloads, "count": autoloads.size()}


# Set the main scene
func set_main_scene(params) -> Dictionary:
	var scene_path = params.scene_path

	if not scene_path.begins_with("res://"):
		scene_path = "res://" + scene_path

	_log.info("Setting main scene: " + scene_path)

	# Verify the scene exists
	if not FileAccess.file_exists(scene_path):
		return _log.failure("Scene file does not exist: " + scene_path)

	var old_main_scene = ProjectSettings.get_setting("application/run/main_scene", "")

	ProjectSettings.set_setting("application/run/main_scene", scene_path)
	var err = ProjectSettings.save()

	if err != OK:
		return _log.failure("Failed to save project settings: " + str(err))

	return {"old_main_scene": old_main_scene, "new_main_scene": scene_path, "saved": true}


# Name one physics collision layer
func configure_physics_layer(params: Dictionary) -> Dictionary:
	var layer_type = params.get("layerType", "2d")
	var layer_idx = int(params.get("layerIndex", 1))
	var layer_name = params.get("layerName", "")

	ProjectSettings.set_setting("layer_names/" + layer_type + "_physics/layer_" + str(layer_idx), layer_name)
	ProjectSettings.save()

	return {"success": true, "layer_type": layer_type, "layer_index": layer_idx, "layer_name": layer_name}


# Name one navigation layer
func configure_navigation_layers(params: Dictionary) -> Dictionary:
	var is_3d = params.get("is3D", false)
	var layer_idx = int(params.get("layerIndex", 1))
	var layer_name = params.get("layerName", "")

	var type_str = "3d" if is_3d else "2d"
	ProjectSettings.set_setting("layer_names/" + type_str + "_navigation/layer_" + str(layer_idx), layer_name)
	ProjectSettings.save()

	return {"success": true, "is_3d": is_3d, "layer_index": layer_idx, "layer_name": layer_name}
