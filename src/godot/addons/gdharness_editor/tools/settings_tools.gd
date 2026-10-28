@tool
extends Node
## Project settings read from the open editor, for a caller that asked for the editor's answer, and
## taken up by it after a write to the file.
##
## The same question answered headless starts an engine, loads project.godot from disk and exits.
## This answers from the ProjectSettings the editor already has, which costs nothing and is not the
## same thing: an editor holds what it has been told, including changes nobody has saved yet. Which
## of the two a caller wants is theirs to say, so the server only comes here when asked, and the
## difference is the reason the argument exists rather than an inconvenience to paper over.
##
## Every answer is built by the same reads the headless answer uses, because the two are one
## question asked of two places: a value spelled differently here would read as the editor and the
## file disagreeing about something they agree about.

const GdhSerialisation = preload("../serialisation.gd")
const GdhSettingReads = preload("../setting_reads.gd")

var _values: GdhSerialisation = GdhSerialisation.new()


func get_project_setting(args: Dictionary) -> Dictionary:
	var prefix: String = str(args.get("prefix", ""))
	if not prefix.is_empty():
		var family: Dictionary = GdhSettingReads.under(prefix, _values)
		family["ok"] = true
		return family

	var setting: String = str(args.get("setting", ""))
	if setting.is_empty():
		return {
			"ok": false, "error": "setting is required, or prefix to read every setting under one",
		}

	var result: Dictionary = GdhSettingReads.one(setting, _values)
	result["ok"] = true
	return result


## Takes the named settings from project.godot as it is on disk, after something else wrote it.
##
## The editor loads the file once, at startup. Written from outside, it goes on holding the old
## values, answers them when asked, and writes them back over the new ones the next time it saves
## the project settings. A setting gone from the file goes back to its default, or goes altogether
## when the engine declares none, as an autoload does once it is removed.
func adopt_project_settings(args: Dictionary) -> Dictionary:
	var file: ConfigFile = ConfigFile.new()
	var loaded: Error = file.load("res://project.godot")
	if loaded != OK:
		return { "ok": false, "error": "Could not read project.godot: " + error_string(loaded) }
	var adopted: Array[String] = []
	var named: Variant = args.get("settings", [])
	if not named is Array:
		return { "ok": false, "error": "settings must be a list of setting names" }
	var settings: Array = named
	for entry: Variant in settings:
		var setting: String = str(entry)
		var at: int = setting.find("/")
		if at <= 0:
			continue
		var section: String = setting.substr(0, at)
		var key: String = setting.substr(at + 1)
		if file.has_section_key(section, key):
			ProjectSettings.set_setting(setting, file.get_value(section, key))
		elif ProjectSettings.property_can_revert(setting):
			ProjectSettings.set_setting(setting, ProjectSettings.property_get_revert(setting))
		else:
			ProjectSettings.set_setting(setting, null)
		adopted.append(setting)
	return { "ok": true, "adopted": adopted }


## Loads the bus layout the project names into the editor's audio server, after something else
## wrote it: the editor holds the layout it loaded and saves that one when its audio panel changes.
func adopt_audio_bus_layout(_args: Dictionary) -> Dictionary:
	var path: String = str(
		ProjectSettings.get_setting(
			"audio/buses/default_bus_layout", "res://default_bus_layout.tres"
		)
	)
	var layout: AudioBusLayout = ResourceLoader.load(
		path, "AudioBusLayout", ResourceLoader.CACHE_MODE_REPLACE
	)
	if layout == null:
		return { "ok": false, "error": "Could not load the bus layout at " + path }
	AudioServer.set_bus_layout(layout)
	return { "ok": true, "layout": path }
