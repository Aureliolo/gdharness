extends RefCounted

const Read = preload("reading.gd")
const Log = preload("logger.gd")
const Serialisation = preload("serialisation.gd")

var _log: Log
var _values: Serialisation = Serialisation.new()


func _init(p_log: Log) -> void:
	_log = p_log


# Get a project setting value
func get_project_setting(params: Dictionary) -> Dictionary:
	var setting_path: String = str(params.get("setting", ""))

	_log.info("Getting project setting: " + setting_path)

	var result: Dictionary = {
		"setting_path": setting_path, "exists": ProjectSettings.has_setting(setting_path)
	}

	if result["exists"]:
		result["value"] = _values.serialize_value(ProjectSettings.get_setting(setting_path))
	else:
		result["value"] = null
		result["message"] = "Setting does not exist"

	return result


# Set a project setting value
func set_project_setting(params: Dictionary) -> Dictionary:
	var setting_path: String = str(params.get("setting", ""))
	if setting_path.is_empty():
		return _log.failure("setting is required")
	var value: Variant = params.get("value")

	_log.info("Setting project setting: " + setting_path)

	var old_value: Variant = null
	var had_value: bool = ProjectSettings.has_setting(setting_path)
	if had_value:
		old_value = ProjectSettings.get_setting(setting_path)

	var final_value: Variant = _values.deserialize_value(value)
	var wanted: int = _wanted_type(setting_path, old_value if had_value else null)
	if wanted > TYPE_NIL and final_value != null and typeof(final_value) != wanted:
		if not _converts_faithfully(final_value, wanted):
			return _log.failure(
				(
					"%s is declared as %s, and %s (%s) cannot be written as that without losing something."
					% [setting_path, type_string(wanted), str(final_value), type_string(typeof(final_value))]
				)
			)
		final_value = type_convert(final_value, wanted)

	ProjectSettings.set_setting(setting_path, final_value)
	var err: Error = ProjectSettings.save()
	if err != OK:
		return _log.failure("Failed to save project.godot: " + error_string(err))

	return {
		"setting_path": setting_path,
		"old_value": _values.serialize_value(old_value) if had_value else null,
		"new_value": _values.serialize_value(final_value),
		"was_new": not had_value,
		"saved": true,
	}


# The type a setting wants, or TYPE_NIL where the engine names none and there is nothing to go on.
#
# JSON carries one number type, so every number arrives as a float and an int setting was written
# to project.godot as "50.0". Every reader casts it back, so the tool, the editor and the running
# game all answer 50 afterwards and only the committed file says otherwise, where it reads as
# something having gone wrong.
#
# The engine's own property list is what is asked, rather than the value that is there: a setting
# already written as "50.0" reads back as a float, so the value on hand agrees with the mistake and
# no project that has made it once could be set right again. The property list still says int.
# A setting the engine does not declare has only its current value to go on, and a new one has
# neither, which is the caller's type to choose.
func _wanted_type(setting_path: String, current: Variant) -> int:
	for info: Dictionary in ProjectSettings.get_property_list():
		if str(info.get("name", "")) == setting_path:
			return Read.as_int(info.get("type", TYPE_NIL), TYPE_NIL)
	return typeof(current)


# What separates a narrowing from a guess: 50.0 through int and out again is 50.0, so it was an int
# all along, while 50.5 comes back as 50.0 and "loud" comes back as "0". Those are a caller meaning
# something the setting cannot hold, and are refused rather than written as whatever the cast
# happened to produce.
func _converts_faithfully(value: Variant, to: int) -> bool:
	return type_convert(type_convert(value, to), typeof(value)) == value


# Add an autoload singleton
func add_autoload(params: Dictionary) -> Dictionary:
	var name: String = str(params.get("name", ""))
	var path: String = str(params.get("path", ""))
	var enabled: bool = Read.as_bool(params.get("enabled", true), true)

	if not path.begins_with("res://"):
		path = "res://" + path

	_log.info("Adding autoload: " + name + " -> " + path)

	if not FileAccess.file_exists(path):
		return _log.failure("Autoload file does not exist: " + path)

	# Through ProjectSettings so the file is saved the way the editor saves it, header and
	# every other line kept; a ConfigFile of project.godot drops the comments on the way out.
	var setting: String = "autoload/" + name
	var was_updated: bool = ProjectSettings.has_setting(setting)

	# An asterisk in front of the path is how project.godot marks an autoload as enabled.
	ProjectSettings.set_setting(setting, ("*" if enabled else "") + path)
	var err: Error = ProjectSettings.save()
	if err != OK:
		return _log.failure("Failed to save project.godot: " + error_string(err))

	return {"name": name, "path": path, "enabled": enabled, "action": "updated" if was_updated else "added"}


# Remove an autoload singleton
func remove_autoload(params: Dictionary) -> Dictionary:
	var name: String = str(params.get("name", ""))

	_log.info("Removing autoload: " + name)

	var setting: String = "autoload/" + name
	if not ProjectSettings.has_setting(setting):
		return _log.failure("Autoload not found: " + name)

	var old_value: String = str(ProjectSettings.get_setting(setting))
	ProjectSettings.set_setting(setting, null)
	var err: Error = ProjectSettings.save()
	if err != OK:
		return _log.failure("Failed to save project.godot: " + error_string(err))

	return {"name": name, "removed": true, "old_path": old_value.trim_prefix("*")}


# List all autoload singletons
func list_autoloads(_params: Dictionary) -> Dictionary:
	_log.info("Listing autoloads")

	var autoloads: Array[Dictionary] = []

	for property: Dictionary in ProjectSettings.get_property_list():
		var setting: String = str(property.get("name", ""))
		if not setting.begins_with("autoload/"):
			continue
		var value: String = str(ProjectSettings.get_setting(setting))
		var path: String = value.trim_prefix("*")

		var autoload_info: Dictionary = {
			"name": setting.trim_prefix("autoload/"),
			"path": path,
			"enabled": value.begins_with("*"),
			"file_exists": FileAccess.file_exists(path),
		}
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
