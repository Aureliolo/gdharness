extends RefCounted

const Read = preload("reading.gd")
const Log = preload("logger.gd")
const ProjectFile = preload("project_file.gd")
const Serialisation = preload("serialisation.gd")

var _log: Log
var _values: Serialisation = Serialisation.new()


func _init(p_log: Log) -> void:
	_log = p_log


# Get a project setting value, or every setting under a prefix.
func get_project_setting(params: Dictionary) -> Dictionary:
	var prefix: String = str(params.get("prefix", ""))
	if not prefix.is_empty():
		return _settings_under(prefix)

	var setting_path: String = str(params.get("setting", ""))
	if setting_path.is_empty():
		return _log.failure("setting is required, or prefix to read every setting under one")

	_log.info("Getting project setting: " + setting_path)

	var result: Dictionary = {
		"setting_path": setting_path, "exists": ProjectSettings.has_setting(setting_path)
	}

	if result["exists"]:
		var value: Variant = ProjectSettings.get_setting(setting_path)
		result["value"] = _values.serialize_value(value)
		# A setting the engine registers exists whether or not the project sets it, so exists did
		# not say whether project.godot has a line for it. At its default it has none: the engine
		# drops such a key when it saves.
		var default_value: Variant = ProjectSettings.property_get_revert(setting_path)
		if default_value != null:
			result["at_default"] = value == default_value
	else:
		result["value"] = null
		result["message"] = "Setting does not exist"

	# The value under this name is not the one every build reads: `name.windows` replaces it on
	# Windows, `name.editor` in the editor. Read alone, a caller saw the plain value and not the one
	# their game showed.
	var overrides: Dictionary = {}
	for info: Dictionary in ProjectSettings.get_property_list():
		var name: String = str(info.get("name", ""))
		if name.begins_with(setting_path + "."):
			overrides[name.substr(setting_path.length() + 1)] = _values.serialize_value(
				ProjectSettings.get_setting(name)
			)
	if not overrides.is_empty():
		result["overrides"] = overrides

	return result


# Every setting whose name starts with [prefix], with the type the engine registers for each.
#
# A caller after a whole family, "everything under debug/gdscript/warnings", had no way to ask: a get
# takes one name, and the engine is the only thing that knows what the family contains. The way round
# it was to walk ProjectSettings.get_property_list() from a script written for the purpose, which is
# an engine start to answer a question the engine was already open for.
#
# The type is here because it is the half a name hides. A setting sitting among a family of levels
# can be a bool, and a caller that assumes otherwise writes a level over it and sees nothing go
# wrong: 2 is as true as true is. Reading it out of the property list is how that is caught.
func _settings_under(prefix: String) -> Dictionary:
	_log.info("Listing project settings under: " + prefix)

	var found: Array[Dictionary] = []
	for property: Dictionary in ProjectSettings.get_property_list():
		var name: String = str(property.get("name", ""))
		if not name.begins_with(prefix):
			continue
		var kind: int = Read.as_int(property.get("type", TYPE_NIL), TYPE_NIL)
		var value: Variant = ProjectSettings.get_setting(name)
		var described: Dictionary = {
			"setting": name,
			"type": type_string(kind),
			"value": _values.serialize_value(value),
		}
		# As a single get says it, so a family read can be told apart into what the project sets
		# and the engine's defaults: "input/" is ninety actions the engine ships and the project's few.
		var default_value: Variant = ProjectSettings.property_get_revert(name)
		if default_value != null:
			described["at_default"] = value == default_value
		found.append(described)

	found.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return a["setting"] < b["setting"])
	return {"prefix": prefix, "count": found.size(), "settings": found}


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
	# A setting the engine registers is there with its default whether or not project.godot sets it,
	# so has_setting alone called the description of a project that had never set one an old value.
	# At its default, the file does not set it: the engine drops a key at its default when it saves.
	var default_value: Variant = ProjectSettings.property_get_revert(setting_path)
	var was_default: bool = had_value and default_value != null and old_value == default_value

	var final_value: Variant = _values.deserialize_value(value)
	var wanted: int = _wanted_type(setting_path, old_value if had_value else null)
	if wanted > TYPE_NIL and final_value != null and typeof(final_value) != wanted:
		if not _converts_faithfully(final_value, wanted):
			return _log.failure(_cannot_hold(setting_path, wanted, final_value))
		final_value = type_convert(final_value, wanted)

	var answer: Dictionary = {
		"setting_path": setting_path,
		"old_value": _values.serialize_value(old_value) if had_value else null,
		"new_value": _values.serialize_value(final_value),
		"was_new": not had_value or was_default,
		"was_default": was_default,
		"saved": true,
	}
	# The same value in the same type is no change, and the file is left alone: a save rewrites it
	# whole. The type is compared as well, so an int setting the file holds as 50.0 is still put right.
	if had_value and typeof(old_value) == typeof(final_value) and old_value == final_value:
		answer["saved"] = false
		answer["unchanged"] = true
		return answer

	ProjectSettings.set_setting(setting_path, final_value)
	var err: Error = ProjectFile.save()
	if err != OK:
		return _log.failure("Failed to save project.godot: " + error_string(err))
	return answer


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


# Why [param value] cannot be written to a setting declared as [param wanted], in the words the
# editor's property writes use for the same two cases. One sentence for both read "without losing
# something" about a word given for a number, where nothing would be lost: it cannot become one.
static func _cannot_hold(setting_path: String, wanted: int, value: Variant) -> String:
	var numbers: Array[int] = [TYPE_INT, TYPE_FLOAT]
	var declared: String = "%s is declared as %s" % [setting_path, type_string(wanted)]
	var cost: String = " Setting it would save a different value than the one asked for."
	if wanted == TYPE_INT and typeof(value) == TYPE_FLOAT:
		return "%s, which holds whole numbers, and %s would be cut to fit.%s" % [declared, str(value), cost]
	if wanted in numbers and typeof(value) in numbers:
		return "%s, and %s is not the same number as one.%s" % [declared, str(value), cost]
	var given: String = type_string(typeof(value))
	return "%s, and %s (%s) cannot become one." % [declared, JSON.stringify(value), given]


# Add an autoload singleton
func add_autoload(params: Dictionary) -> Dictionary:
	var name: String = str(params.get("name", ""))
	var path: String = str(params.get("path", ""))
	var global: bool = Read.as_bool(params.get("global", true), true)

	# There is no disabled autoload in Godot 4: every entry in the list is loaded under the root at
	# every start. `enabled: false` used to write the entry without its asterisk and answer that it
	# was disabled, and the autoload ran all the same.
	if not Read.as_bool(params.get("enabled", true), true):
		return _log.failure(
			(
				"An autoload cannot be added disabled: Godot loads every autoload in the list at every"
				+ " start. global: false keeps its name out of the global scope and still loads it;"
				+ " remove_autoload is what stops it loading"
			)
		)

	if not path.begins_with("res://"):
		path = "res://" + path

	_log.info("Adding autoload: " + name + " -> " + path)

	if not FileAccess.file_exists(path):
		return _log.failure("Autoload file does not exist: " + path)

	# Through ProjectSettings so the file is saved the way the editor saves it, which includes
	# putting Godot's header back and dropping any comment somebody wrote into the file by hand.
	var setting: String = "autoload/" + name
	var was_updated: bool = ProjectSettings.has_setting(setting)

	# An asterisk in front of the path makes the autoload's name a global variable, the editor's
	# "Global Variable" column. Without it the node still comes up under the root; only the name
	# stops resolving.
	ProjectSettings.set_setting(setting, ("*" if global else "") + path)
	var err: Error = ProjectFile.save()
	if err != OK:
		return _log.failure("Failed to save project.godot: " + error_string(err))

	return {
		"name": name,
		"path": path,
		"enabled": true,
		"global": global,
		"action": "updated" if was_updated else "added",
	}


# Remove an autoload singleton
func remove_autoload(params: Dictionary) -> Dictionary:
	var name: String = str(params.get("name", ""))

	_log.info("Removing autoload: " + name)

	var setting: String = "autoload/" + name
	if not ProjectSettings.has_setting(setting):
		return _log.failure("Autoload not found: " + name)

	var old_value: String = str(ProjectSettings.get_setting(setting))
	ProjectSettings.set_setting(setting, null)
	var err: Error = ProjectFile.save()
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

		# Enabled whatever the asterisk says, because every autoload listed is loaded; the asterisk
		# is whether its name is a global variable.
		var autoload_info: Dictionary = {
			"name": setting.trim_prefix("autoload/"),
			"path": path,
			"enabled": true,
			"global": value.begins_with("*"),
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
	var err: Error = ProjectFile.save()

	if err != OK:
		return _log.failure("Failed to save project settings: " + str(err))

	return {"old_main_scene": old_main_scene, "new_main_scene": scene_path, "saved": true}
