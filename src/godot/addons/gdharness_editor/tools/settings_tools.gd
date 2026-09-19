@tool
extends Node

## Project settings read from the open editor, for a caller that asked for the editor's answer.
##
## The same question answered headless starts an engine, loads project.godot from disk and exits.
## This answers from the ProjectSettings the editor already has, which costs nothing and is not the
## same thing: an editor holds what it has been told, including changes nobody has saved yet. Which
## of the two a caller wants is theirs to say, so the server only comes here when asked, and the
## difference is the reason the argument exists rather than an inconvenience to paper over.
##
## Every value goes through the same serialiser the headless answer uses, because the two are one
## question asked of two places: a value spelled differently here would read as the editor and the
## file disagreeing about something they agree about.

const Read = preload("../reading.gd")
const Serialisation = preload("../serialisation.gd")

var _values: Serialisation = Serialisation.new()


func get_project_setting(args: Dictionary) -> Dictionary:
	var prefix: String = str(args.get("prefix", ""))
	if not prefix.is_empty():
		return _settings_under(prefix)

	var setting: String = str(args.get("setting", ""))
	if setting.is_empty():
		return {"ok": false, "error": "setting is required, or prefix to read every setting under one"}

	var exists: bool = ProjectSettings.has_setting(setting)
	var result: Dictionary = {"ok": true, "setting_path": setting, "exists": exists, "value": null}
	if exists:
		result["value"] = _values.serialize_value(ProjectSettings.get_setting(setting))
	else:
		result["message"] = "Setting does not exist"
	return result


## Every setting under [prefix] with the type the engine registers for each, which is the half a
## name hides: a family of levels can hold a setting that is a bool, and writing a level over it
## looks like it worked.
func _settings_under(prefix: String) -> Dictionary:
	var found: Array[Dictionary] = []
	for property: Dictionary in ProjectSettings.get_property_list():
		var setting: String = str(property.get("name", ""))
		if not setting.begins_with(prefix):
			continue
		var kind: int = Read.as_int(property.get("type", TYPE_NIL), TYPE_NIL)
		var described: Dictionary = {
			"setting": setting,
			"type": type_string(kind),
			"value": _values.serialize_value(ProjectSettings.get_setting(setting)),
		}
		found.append(described)

	found.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return a["setting"] < b["setting"])
	return {"ok": true, "prefix": prefix, "count": found.size(), "settings": found}
