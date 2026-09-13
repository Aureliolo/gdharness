extends RefCounted

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

	var enabled_plugins: Array[String] = _enabled_plugin_names()
	_log.debug("Enabled plugins: " + str(enabled_plugins))

	var plugins: Array[Dictionary] = []
	var enabled_count: int = 0

	var dir: DirAccess = DirAccess.open(addons_path)
	if dir:
		dir.list_dir_begin()
		var folder_name: String = dir.get_next()

		while folder_name != "":
			if dir.current_is_dir() and not folder_name.begins_with("."):
				var plugin_cfg_path: String = addons_path + folder_name + "/plugin.cfg"

				if FileAccess.file_exists(plugin_cfg_path):
					var enabled: bool = folder_name in enabled_plugins
					var plugin_info: Dictionary = {
						"name": folder_name, "path": addons_path + folder_name, "enabled": enabled
					}

					var plugin_config: ConfigFile = ConfigFile.new()
					if plugin_config.load(plugin_cfg_path) == OK:
						plugin_info["display_name"] = plugin_config.get_value("plugin", "name", folder_name)
						plugin_info["description"] = plugin_config.get_value("plugin", "description", "")
						plugin_info["author"] = plugin_config.get_value("plugin", "author", "")
						plugin_info["version"] = plugin_config.get_value("plugin", "version", "")
						plugin_info["script"] = plugin_config.get_value("plugin", "script", "")

					plugins.append(plugin_info)
					if enabled:
						enabled_count += 1

			folder_name = dir.get_next()

		dir.list_dir_end()

	return {
		"plugins": plugins,
		"addons_directory_exists": true,
		"enabled_count": enabled_count,
		"disabled_count": plugins.size() - enabled_count
	}


# Enable a plugin
func enable_plugin(params: Dictionary) -> Dictionary:
	var plugin_name: String = str(params.get("plugin_name", ""))

	_log.info("Enabling plugin: " + plugin_name)

	var plugin_cfg_path: String = "res://addons/" + plugin_name + "/plugin.cfg"
	if not FileAccess.file_exists(plugin_cfg_path):
		_log.error("Plugin not found: " + plugin_name)
		return _log.failure("Expected plugin.cfg at: " + plugin_cfg_path)

	var enabled_plugins: Array[String] = _enabled_plugin_names()

	if plugin_name in enabled_plugins:
		return {
			"plugin_name": plugin_name, "action": "already_enabled", "message": "Plugin is already enabled"
		}

	enabled_plugins.append(plugin_name)
	var err: Error = _save_enabled_plugins(enabled_plugins)
	if err != OK:
		return _log.failure("Failed to save project.godot: " + error_string(err))

	return {"plugin_name": plugin_name, "action": "enabled", "enabled_plugins": enabled_plugins}


# Disable a plugin
func disable_plugin(params: Dictionary) -> Dictionary:
	var plugin_name: String = str(params.get("plugin_name", ""))

	_log.info("Disabling plugin: " + plugin_name)

	var enabled_plugins: Array[String] = _enabled_plugin_names()

	if not plugin_name in enabled_plugins:
		return {
			"plugin_name": plugin_name,
			"action": "already_disabled",
			"message": "Plugin is not currently enabled"
		}

	enabled_plugins.erase(plugin_name)
	var err: Error = _save_enabled_plugins(enabled_plugins)
	if err != OK:
		return _log.failure("Failed to save project.godot: " + error_string(err))

	return {"plugin_name": plugin_name, "action": "disabled", "enabled_plugins": enabled_plugins}


# The addon directory names in [editor_plugins]. The editor stores them as the engine
# expression PackedStringArray("res://addons/<name>/plugin.cfg", ...), which loads as that
# type; the String form is what an older hand-edited file can carry.
func _enabled_plugin_names() -> Array[String]:
	var names: Array[String] = []
	var regex: RegEx = RegEx.new()
	regex.compile("res://addons/([^/]+)/plugin.cfg")

	var enabled_value: Variant = ProjectSettings.get_setting("editor_plugins/enabled", PackedStringArray())
	if enabled_value is PackedStringArray:
		var paths: PackedStringArray = enabled_value
		for path: String in paths:
			var m: RegExMatch = regex.search(path)
			if m:
				names.append(m.get_string(1))
	elif enabled_value is String:
		var listed: String = enabled_value
		for m: RegExMatch in regex.search_all(listed):
			names.append(m.get_string(1))

	return names


# Written through ProjectSettings rather than a ConfigFile of project.godot: the engine saves
# the file the way the editor does, header comment and all, where ConfigFile drops every
# comment and reorders what it kept. A real PackedStringArray, because that is serialised as
# the unquoted expression the editor reads, whereas the same text handed over as a String is
# written quoted and loads as a String the editor does not recognise as a plugin list. An
# empty list is the setting removed, which is what the editor writes for no plugins.
func _save_enabled_plugins(names: Array[String]) -> Error:
	if names.is_empty():
		ProjectSettings.set_setting("editor_plugins/enabled", null)
		return ProjectSettings.save()

	var enabled_paths: PackedStringArray = PackedStringArray()
	for name: String in names:
		enabled_paths.append("res://addons/" + name + "/plugin.cfg")

	ProjectSettings.set_setting("editor_plugins/enabled", enabled_paths)
	return ProjectSettings.save()
