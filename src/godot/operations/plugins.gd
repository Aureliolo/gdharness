extends RefCounted

const Log = preload("logger.gd")

var _log: Log


func _init(p_log: Log) -> void:
	_log = p_log


# List all plugins in the project with their status
func list_plugins(_params) -> Dictionary:
	_log.info("Listing plugins")

	var result = {"plugins": [], "addons_directory_exists": false, "enabled_count": 0, "disabled_count": 0}

	# Check if addons directory exists
	var addons_path = "res://addons/"
	if not DirAccess.dir_exists_absolute(ProjectSettings.globalize_path(addons_path)):
		result["message"] = "No addons directory found in the project"
		return result

	result["addons_directory_exists"] = true

	var config = ConfigFile.new()
	var enabled_plugins = []
	if config.load("res://project.godot") == OK:
		enabled_plugins = _enabled_plugin_names(config)

	_log.debug("Enabled plugins: " + str(enabled_plugins))

	# Scan addons directory
	var dir = DirAccess.open(addons_path)
	if dir:
		dir.list_dir_begin()
		var folder_name = dir.get_next()

		while folder_name != "":
			if dir.current_is_dir() and not folder_name.begins_with("."):
				var plugin_cfg_path = addons_path + folder_name + "/plugin.cfg"

				if FileAccess.file_exists(plugin_cfg_path):
					var plugin_info = {
						"name": folder_name,
						"path": addons_path + folder_name,
						"enabled": folder_name in enabled_plugins
					}

					# Read plugin.cfg for additional info
					var plugin_config = ConfigFile.new()
					if plugin_config.load(plugin_cfg_path) == OK:
						plugin_info["display_name"] = plugin_config.get_value("plugin", "name", folder_name)
						plugin_info["description"] = plugin_config.get_value("plugin", "description", "")
						plugin_info["author"] = plugin_config.get_value("plugin", "author", "")
						plugin_info["version"] = plugin_config.get_value("plugin", "version", "")
						plugin_info["script"] = plugin_config.get_value("plugin", "script", "")

					result["plugins"].append(plugin_info)

					if plugin_info["enabled"]:
						result["enabled_count"] += 1
					else:
						result["disabled_count"] += 1

			folder_name = dir.get_next()

		dir.list_dir_end()

	return result


# Enable a plugin
func enable_plugin(params) -> Dictionary:
	var plugin_name = params.plugin_name

	_log.info("Enabling plugin: " + plugin_name)

	# Check if plugin exists
	var plugin_cfg_path = "res://addons/" + plugin_name + "/plugin.cfg"
	if not FileAccess.file_exists(plugin_cfg_path):
		_log.error("Plugin not found: " + plugin_name)
		return _log.failure("Expected plugin.cfg at: " + plugin_cfg_path)

	# Read project.godot
	var config = ConfigFile.new()
	var err = config.load("res://project.godot")
	if err != OK:
		return _log.failure("Failed to load project.godot: " + str(err))

	var enabled_plugins = _enabled_plugin_names(config)

	# Check if already enabled
	if plugin_name in enabled_plugins:
		return {
			"plugin_name": plugin_name, "action": "already_enabled", "message": "Plugin is already enabled"
		}

	enabled_plugins.append(plugin_name)
	_write_enabled_plugins(config, enabled_plugins)

	err = config.save("res://project.godot")
	if err != OK:
		return _log.failure("Failed to save project.godot: " + str(err))

	return {"plugin_name": plugin_name, "action": "enabled", "enabled_plugins": enabled_plugins}


# Disable a plugin
func disable_plugin(params) -> Dictionary:
	var plugin_name = params.plugin_name

	_log.info("Disabling plugin: " + plugin_name)

	# Read project.godot
	var config = ConfigFile.new()
	var err = config.load("res://project.godot")
	if err != OK:
		return _log.failure("Failed to load project.godot: " + str(err))

	var enabled_plugins = _enabled_plugin_names(config)

	# Check if plugin is in enabled list
	if not plugin_name in enabled_plugins:
		return {
			"plugin_name": plugin_name,
			"action": "already_disabled",
			"message": "Plugin is not currently enabled"
		}

	enabled_plugins.erase(plugin_name)
	_write_enabled_plugins(config, enabled_plugins)

	err = config.save("res://project.godot")
	if err != OK:
		return _log.failure("Failed to save project.godot: " + str(err))

	return {"plugin_name": plugin_name, "action": "disabled", "enabled_plugins": enabled_plugins}


# The addon directory names in [editor_plugins], which project.godot stores as the engine
# expression PackedStringArray("res://addons/<name>/plugin.cfg", ...).
func _enabled_plugin_names(config: ConfigFile) -> Array:
	var names = []

	if not config.has_section("editor_plugins"):
		return names

	var enabled_value = config.get_value("editor_plugins", "enabled", "")
	if not enabled_value is String or enabled_value.is_empty():
		return names

	var regex = RegEx.new()
	regex.compile("res://addons/([^/]+)/plugin.cfg")
	for m in regex.search_all(enabled_value):
		names.append(m.get_string(1))

	return names


func _write_enabled_plugins(config: ConfigFile, names: Array) -> void:
	if names.is_empty():
		if config.has_section_key("editor_plugins", "enabled"):
			config.erase_section_key("editor_plugins", "enabled")
		return

	var enabled_paths = []
	for p in names:
		enabled_paths.append("res://addons/" + p + "/plugin.cfg")

	config.set_value("editor_plugins", "enabled", 'PackedStringArray("' + '", "'.join(enabled_paths) + '")')
