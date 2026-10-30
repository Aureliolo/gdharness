@tool
extends EditorExportPlugin
## Leaves gdharness out of a release export: the runtime autoload's entry, its loader and the
## addons, none of which does anything in a release build, so no player's build carries them. A
## debug export keeps them, since the runtime serves a debug build.

## The loader the runtime autoload's entry names, as `gdharness setup` writes it.
const LOADER: String = "res://gdharness/loader.gd"
## The folders a release export leaves out: the loader's and the addons that never run there.
const LEFT_OUT: Array[String] = [
	"res://gdharness/",
	"res://addons/gdharness_runtime/",
	"res://addons/gdharness_editor/",
	"res://addons/auto_reload/",
]

## Each autoload entry taken out for the export, by setting name, with its value and its order.
var _values: Dictionary[String, Variant] = {}
var _orders: Dictionary[String, int] = {}
var _release: bool = false


## Before "GDScript", by which the export orders its plugins: a file stops at the first that skips
## or replaces it, and that one turns every script into tokens, so a later skip leaves them in.
func _get_name() -> String:
	return "GDHarness"


func _export_begin(
	_features: PackedStringArray, is_debug: bool, _path: String, _flags: int
) -> void:
	_release = not is_debug
	_values.clear()
	_orders.clear()
	if not _release:
		return
	# The export writes project.binary from the settings as they stand once this returns, and the
	# editor saves project.godot only for an edit made in its settings dialog.
	for property: Dictionary in ProjectSettings.get_property_list():
		var setting: String = property["name"]
		if not setting.begins_with("autoload/"):
			continue
		var value: Variant = ProjectSettings.get_setting(setting)
		if value is String and str(value).trim_prefix("*") == LOADER:
			_values[setting] = value
			_orders[setting] = ProjectSettings.get_order(setting)
	for setting: String in _values:
		ProjectSettings.set_setting(setting, null)


func _export_file(path: String, _type: String, _features: PackedStringArray) -> void:
	if not _release:
		return
	for folder: String in LEFT_OUT:
		if path.begins_with(folder):
			skip()
			return


func _export_end() -> void:
	for setting: String in _values:
		ProjectSettings.set_setting(setting, _values[setting])
		ProjectSettings.set_order(setting, _orders[setting])
	_values.clear()
	_orders.clear()
	_release = false
