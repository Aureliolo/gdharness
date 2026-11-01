extends RefCounted
## Project settings read the same way headless and from the open editor, because the two are one
## question asked of two places: a field one of them left out read as the editor and the file
## disagreeing about something they agree about.

const GdhRead = preload("reading.gd")
const GdhSerialisation = preload("serialisation.gd")


## One setting: whether the engine knows it, its value, whether that is the engine's default, and
## the feature overrides that replace it in some builds.
static func one(setting_path: String, values: GdhSerialisation) -> Dictionary:
	var result: Dictionary = {
		"setting_path": setting_path, "exists": ProjectSettings.has_setting(setting_path),
	}

	if result["exists"]:
		var value: Variant = ProjectSettings.get_setting(setting_path)
		var laid: Dictionary = laid_over(setting_path, override_files())
		if not laid.is_empty():
			if not Engine.is_editor_hint():
				value = laid["project"]
			result["overridden_in"] = {
				"file": laid["file"], "value": values.serialize_value(laid["value"]),
			}
		result["value"] = values.serialize_value(value)
		# A setting the engine registers exists whether or not the project sets it, so exists did
		# not say whether project.godot has a line for it. At its default it has none: the engine
		# drops such a key when it saves.
		var default_value: Variant = ProjectSettings.property_get_revert(setting_path)
		if default_value != null:
			result["at_default"] = value == default_value
	else:
		result["value"] = null
		result["message"] = "Setting does not exist"

	# An override exists only while project.godot sets it, so one the file does not set read as a
	# setting nobody had heard of, when a build with that feature reads its base setting instead.
	var base: String = override_base(setting_path)
	if not base.is_empty():
		result["override_of"] = base
		if not result["exists"] and ProjectSettings.has_setting(base):
			result["holds"] = values.serialize_value(ProjectSettings.get_setting(base))
			result["message"] = overridden_by_none(setting_path, values)

	# The value under this name is not the one every build reads: `name.windows` replaces it on
	# Windows, `name.editor` in the editor. Read alone, a caller saw the plain value and not the one
	# their game showed.
	var overrides: Dictionary = overrides_of(setting_path, values)
	if not overrides.is_empty():
		result["overrides"] = overrides

	return result


## Every setting whose name starts with [param prefix], with the type the engine registers for
## each.
##
## The type is here because it is the half a name hides. A setting sitting among a family of levels
## can be a bool, and a caller that assumes otherwise writes a level over it and sees nothing go
## wrong: 2 is as true as true is.
static func under(prefix: String, values: GdhSerialisation) -> Dictionary:
	var found: Array[Dictionary] = []
	var overrides: Array[Dictionary] = override_files()
	for property: Dictionary in ProjectSettings.get_property_list():
		var name: String = str(property.get("name", ""))
		if not name.begins_with(prefix):
			continue
		var kind: int = GdhRead.as_int(property.get("type", TYPE_NIL), TYPE_NIL)
		var value: Variant = ProjectSettings.get_setting(name)
		var laid: Dictionary = laid_over(name, overrides)
		if not laid.is_empty() and not Engine.is_editor_hint():
			value = laid["project"]
		var described: Dictionary = {
			"setting": name,
			"type": type_named(kind, value),
			"value": values.serialize_value(value),
		}
		if not laid.is_empty():
			described["overridden_in"] = {
				"file": laid["file"], "value": values.serialize_value(laid["value"]),
			}
		# As a single get says it, so a family read can be told apart into what the project sets and
		# the engine's defaults: "input/" is ninety actions the engine ships and the project's few.
		var default_value: Variant = ProjectSettings.property_get_revert(name)
		if default_value != null:
			described["at_default"] = value == default_value
		var base: String = override_base(name)
		if not base.is_empty():
			described["override_of"] = base
		# Kept in the engine's order: its own settings as it registers them, so layer_2 comes
		# before layer_10, then the project's as project.godot lists them, the order autoloads
		# load in.
		found.append(described)

	return { "prefix": prefix, "count": found.size(), "settings": found }


## The files a run lays over project.godot, loaded, in the order the engine lays them, each as
## {"file", "config"}: res://override.cfg, then the file
## application/config/project_settings_override
## names. The editor lays neither, so a game keeping a player's window size in user:// had that size
## answered headless as the project's own setting, while the editor answered the project's.
static func override_files() -> Array[Dictionary]:
	var files: Array[Dictionary] = []
	var named: String = str(
		ProjectSettings.get_setting("application/config/project_settings_override", "")
	)
	for file: String in ["res://override.cfg", named]:
		var config: ConfigFile = ConfigFile.new()
		if not file.is_empty() and config.load(file) == OK:
			files.append({ "file": file, "config": config })
	return files


## What the last of [param overrides], from [method override_files], to set [param setting_path]
## sets it to, as {"file", "value", "project"}, where project is what project.godot holds, or the
## engine's default where it has no line: the value the editor holds, unsaved changes aside. Empty
## when none sets it.
static func laid_over(setting_path: String, overrides: Array[Dictionary]) -> Dictionary:
	var at: int = setting_path.find("/")
	if at <= 0:
		return {}
	var section: String = setting_path.left(at)
	var key: String = setting_path.substr(at + 1)
	for index: int in range(overrides.size() - 1, -1, -1):
		var config: ConfigFile = overrides[index]["config"]
		if not config.has_section_key(section, key):
			continue
		var project: ConfigFile = ConfigFile.new()
		var held: Variant = ProjectSettings.property_get_revert(setting_path)
		if project.load("res://project.godot") == OK and project.has_section_key(section, key):
			held = project.get_value(section, key)
		return {
			"file": overrides[index]["file"],
			"value": config.get_value(section, key),
			"project": held,
		}
	return {}


## The type [param kind] names, with what [param value] holds when it is a typed array or
## dictionary, as project.godot writes it: a `Dictionary[String, bool]` was answered as Dictionary,
## which hides what its keys and values must be.
static func type_named(kind: int, value: Variant) -> String:
	if kind == TYPE_ARRAY and value is Array:
		var list: Array = value
		if list.is_typed():
			var element: String = _held(
				list.get_typed_builtin(), list.get_typed_class_name(), list.get_typed_script()
			)
			return "Array[%s]" % element
	elif kind == TYPE_DICTIONARY and value is Dictionary:
		var table: Dictionary = value
		if table.is_typed():
			var key: String = _held(
				table.get_typed_key_builtin(),
				table.get_typed_key_class_name(),
				table.get_typed_key_script()
			)
			var held: String = _held(
				table.get_typed_value_builtin(),
				table.get_typed_value_class_name(),
				table.get_typed_value_script()
			)
			return "Dictionary[%s, %s]" % [key, held]
	return type_string(kind)


## One side of a typed collection: a built-in type, a class, or a script by its class_name.
static func _held(builtin: int, named: StringName, script: Variant) -> String:
	if builtin == TYPE_NIL:
		return "Variant"
	if builtin != TYPE_OBJECT:
		return type_string(builtin)
	if script is Script:
		var declared: Script = script
		if not declared.get_global_name().is_empty():
			return declared.get_global_name()
	return str(named)


## The setting [param setting_path] overrides for builds with one feature, as
## `application/run/max_fps.mobile` does `application/run/max_fps`, or "" for a plain setting.
static func override_base(setting_path: String) -> String:
	var dot: int = setting_path.find(".", setting_path.rfind("/") + 1)
	return "" if dot == -1 else setting_path.substr(0, dot)


## The overrides project.godot sets for [param setting_path], by feature.
static func overrides_of(setting_path: String, values: GdhSerialisation) -> Dictionary:
	var overrides: Dictionary = {}
	for info: Dictionary in ProjectSettings.get_property_list():
		var name: String = str(info.get("name", ""))
		if name.begins_with(setting_path + "."):
			overrides[name.substr(setting_path.length() + 1)] = values.serialize_value(
				ProjectSettings.get_setting(name)
			)
	return overrides


## What a build with the feature of [param setting_path], an override project.godot does not set,
## reads in its place.
static func overridden_by_none(setting_path: String, values: GdhSerialisation) -> String:
	var base: String = override_base(setting_path)
	var feature: String = setting_path.substr(base.length() + 1)
	var said: String = (
		(
			"project.godot sets no %s override of %s, so a build with the %s feature reads %s, "
			+ "the value under holds"
		)
		% [feature, base, feature, base]
	)
	var others: Array[String] = []
	for name: String in overrides_of(base, values).keys():
		if name != feature:
			others.append(name)
	if others.is_empty():
		return said + "."
	others.sort()
	return said + (", unless it also has a feature with an override: %s." % ", ".join(others))
