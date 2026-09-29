extends RefCounted

const Patterns = preload("patterns.gd")
const Log = preload("logger.gd")

var _log: Log


func _init(p_log: Log) -> void:
	_log = p_log


# List all plugins in the project with their status
func list_plugins(_params: Dictionary) -> Dictionary:
	_log.info("Listing plugins")

	var addons_path: String = "res://addons/"
	if not DirAccess.dir_exists_absolute(ProjectSettings.globalize_path(addons_path)):
		return {
			"plugins": [],
			"addons_directory_exists": false,
			"enabled_count": 0,
			"disabled_count": 0,
			"message": "No addons directory found in the project"
		}

	var enabled_paths: Array[String] = _enabled_paths()
	_log.debug("Enabled plugins: " + str(enabled_paths))

	var plugins: Array[Dictionary] = []
	var enabled_count: int = 0
	for folder: String in _plugin_folders(addons_path):
		var plugin_cfg_path: String = folder.path_join("plugin.cfg")
		var name: String = folder.trim_prefix(addons_path)
		var enabled: bool = plugin_cfg_path in enabled_paths
		var plugin_info: Dictionary = {"name": name, "path": folder, "enabled": enabled}

		var plugin_config: ConfigFile = ConfigFile.new()
		if plugin_config.load(plugin_cfg_path) == OK:
			plugin_info["display_name"] = plugin_config.get_value("plugin", "name", name)
			plugin_info["description"] = plugin_config.get_value("plugin", "description", "")
			plugin_info["author"] = plugin_config.get_value("plugin", "author", "")
			plugin_info["version"] = plugin_config.get_value("plugin", "version", "")
			plugin_info["script"] = plugin_config.get_value("plugin", "script", "")

		plugins.append(plugin_info)
		if enabled:
			enabled_count += 1

	var answer: Dictionary = {
		"plugins": plugins,
		"addons_directory_exists": true,
		"enabled_count": enabled_count,
		"disabled_count": plugins.size() - enabled_count
	}
	# Enabled in the project with no plugin.cfg where the entry points: the editor reports each one
	# as an error at every start and loads nothing for it.
	var missing: Array[String] = []
	for path: String in enabled_paths:
		if not FileAccess.file_exists(path):
			missing.append(path)
	if not missing.is_empty():
		answer["enabled_but_missing"] = missing
	return answer


# Every folder under [param root] holding a plugin.cfg, at any depth, the way the editor's plugin
# list finds them: a folder with one is a plugin and is not looked inside, and one without is
# searched. Only the top level was read, so a plugin one folder down was never listed.
func _plugin_folders(root: String) -> Array[String]:
	var found: Array[String] = []
	var dir: DirAccess = DirAccess.open(root)
	if dir == null:
		return found
	for folder_name: String in dir.get_directories():
		if folder_name.begins_with("."):
			continue
		var folder: String = root.path_join(folder_name)
		if FileAccess.file_exists(folder.path_join("plugin.cfg")):
			found.append(folder)
		else:
			found.append_array(_plugin_folders(folder))
	return found


# Enable a plugin
func enable_plugin(params: Dictionary) -> Dictionary:
	var plugin_name: String = str(params.get("plugin_name", ""))

	_log.info("Enabling plugin: " + plugin_name)

	var plugin_cfg_path: String = "res://addons/" + plugin_name + "/plugin.cfg"
	if not FileAccess.file_exists(plugin_cfg_path):
		_log.error("Plugin not found: " + plugin_name)
		return _log.failure("Expected plugin.cfg at: " + plugin_cfg_path)

	var enabled_paths: Array[String] = _enabled_paths()

	if plugin_cfg_path in enabled_paths:
		return {
			"plugin_name": plugin_name, "action": "already_enabled", "message": "Plugin is already enabled"
		}

	enabled_paths.append(plugin_cfg_path)
	var err: Error = _save_enabled_paths(enabled_paths)
	if err != OK:
		return _log.failure("Failed to save project.godot: " + error_string(err))

	return {"plugin_name": plugin_name, "action": "enabled", "enabled_plugins": _names_of(enabled_paths)}


# Disable a plugin
func disable_plugin(params: Dictionary) -> Dictionary:
	var plugin_name: String = str(params.get("plugin_name", ""))

	_log.info("Disabling plugin: " + plugin_name)

	var enabled_paths: Array[String] = _enabled_paths()
	var plugin_cfg_path: String = "res://addons/" + plugin_name + "/plugin.cfg"

	if not plugin_cfg_path in enabled_paths:
		return {
			"plugin_name": plugin_name,
			"action": "already_disabled",
			"message": "Plugin is not currently enabled"
		}

	enabled_paths.erase(plugin_cfg_path)
	var err: Error = _save_enabled_paths(enabled_paths)
	if err != OK:
		return _log.failure("Failed to save project.godot: " + error_string(err))

	return {"plugin_name": plugin_name, "action": "disabled", "enabled_plugins": _names_of(enabled_paths)}


# Every entry in [editor_plugins], as the plugin.cfg path the editor stores. Paths rather than
# folder names, because the list is written back whole: reading names off a pattern for
# `res://addons/<name>/plugin.cfg` dropped a plugin one folder down, and the next enable or disable
# wrote the list without it, disabling a plugin nobody named. The editor stores the engine
# expression PackedStringArray(...), which loads as that type; the String form is what an older
# hand-edited file can carry.
func _enabled_paths() -> Array[String]:
	var paths: Array[String] = []
	var enabled_value: Variant = ProjectSettings.get_setting("editor_plugins/enabled", PackedStringArray())
	if enabled_value is PackedStringArray:
		var packed: PackedStringArray = enabled_value
		paths.assign(packed)
	elif enabled_value is String:
		var listed: String = enabled_value
		for m: RegExMatch in Patterns.compiled("res://[^\"',)]+?plugin\\.cfg").search_all(listed):
			paths.append(m.get_string())
	return paths


# The names callers use for [param paths]: the folder under addons/, or the path itself for an
# entry somewhere else.
static func _names_of(paths: Array[String]) -> Array[String]:
	var names: Array[String] = []
	for path: String in paths:
		var inside: bool = path.begins_with("res://addons/") and path.ends_with("/plugin.cfg")
		names.append(path.trim_prefix("res://addons/").trim_suffix("/plugin.cfg") if inside else path)
	return names


# Written through ProjectSettings rather than a ConfigFile of project.godot: the engine saves
# the file the way the editor does, header comment and all, where ConfigFile drops every
# comment and reorders what it kept. A real PackedStringArray, because that is serialised as
# the unquoted expression the editor reads, whereas the same text handed over as a String is
# written quoted and loads as a String the editor does not recognise as a plugin list. An
# empty list is the setting removed, which is what the editor writes for no plugins.
func _save_enabled_paths(paths: Array[String]) -> Error:
	if paths.is_empty():
		ProjectSettings.set_setting("editor_plugins/enabled", null)
		return ProjectSettings.save()

	# Kept in an Array[String] and converted here, because appending to a packed array answers with
	# whether it worked and a project holding return_value_discarded at error level will not compile
	# a script that drops that answer. The conversion is what matters: an Array[String] handed to
	# set_setting is written as Array[String]([...]), which the editor does not read as a plugin list.
	ProjectSettings.set_setting("editor_plugins/enabled", PackedStringArray(paths))
	return ProjectSettings.save()
