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
	for property: Dictionary in ProjectSettings.get_property_list():
		var name: String = str(property.get("name", ""))
		if not name.begins_with(prefix):
			continue
		var kind: int = GdhRead.as_int(property.get("type", TYPE_NIL), TYPE_NIL)
		var value: Variant = ProjectSettings.get_setting(name)
		var described: Dictionary = {
			"setting": name,
			"type": type_string(kind),
			"value": values.serialize_value(value),
		}
		# As a single get says it, so a family read can be told apart into what the project sets and
		# the engine's defaults: "input/" is ninety actions the engine ships and the project's few.
		var default_value: Variant = ProjectSettings.property_get_revert(name)
		if default_value != null:
			described["at_default"] = value == default_value
		var base: String = override_base(name)
		if not base.is_empty():
			described["override_of"] = base
		found.append(described)

	found.sort_custom(
		func(a: Dictionary, b: Dictionary) -> bool: return a["setting"] < b["setting"]
	)
	return { "prefix": prefix, "count": found.size(), "settings": found }


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
