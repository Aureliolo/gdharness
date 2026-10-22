extends RefCounted

## export_presets.cfg, read and written in the format the editor's Project > Export saves it in.

const GdhRead = preload("reading.gd")
const GdhLog = preload("logger.gd")

const PRESETS_FILE: String = "res://export_presets.cfg"
## Where the editor names the one preset of each platform it runs on a device.
const RUNNABLE_SECTION: String = "runnable_presets"
## The platforms the editor's exporter offers, by the name a preset gives its platform, each with
## how the names of its files in the export templates directory begin.
const PLATFORMS: Dictionary[String, String] = {
	"Windows Desktop": "windows_",
	"Linux": "linux_",
	"macOS": "macos",
	"Android": "android_",
	"iOS": "ios",
	"Web": "web_",
}

## Each platform's exporter, which only an editor can make: the options a preset of it takes are its.
const EXPORTERS: Dictionary[String, String] = {
	"Windows Desktop": "EditorExportPlatformWindows",
	"Linux": "EditorExportPlatformLinuxBSD",
	"macOS": "EditorExportPlatformMacOS",
	"Android": "EditorExportPlatformAndroid",
	"iOS": "EditorExportPlatformIOS",
	"Web": "EditorExportPlatformWeb",
}
## What export_filter takes, as the Export dialog's Resources tab names them: everything, the scenes
## listed under export_files and what they use, the resources listed, or everything but those listed.
const FILTERS: Array[String] = ["all_resources", "scenes", "resources", "exclude"]
## The types of option a value is written for. An option of another type is left to the editor.
const WRITABLE: Array[int] = [TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING, TYPE_PACKED_STRING_ARRAY]

var _log: GdhLog


func _init(p_log: GdhLog) -> void:
	_log = p_log


## The names of the project's export presets, in the order export_presets.cfg holds them.
static func names() -> Array[String]:
	var named: Array[String] = []
	var config: ConfigFile = ConfigFile.new()
	if config.load(PRESETS_FILE) != OK:
		return named
	var index: int = 0
	while config.has_section("preset." + str(index)):
		named.append(str(config.get_value("preset." + str(index), "name", "")))
		index += 1
	return named


func list_export_presets(_params: Dictionary) -> Dictionary:
	if not FileAccess.file_exists(PRESETS_FILE):
		return {
			"presets": [],
			"presets_file_exists": false,
			"note":
			(
				"No export_presets.cfg found. project_export add_preset adds a preset, as the editor's "
				+ "Project > Export does."
			)
		}
	var config: ConfigFile = ConfigFile.new()
	var err: Error = config.load(PRESETS_FILE)
	if err != OK:
		return _log.failure("Failed to parse export_presets.cfg: " + error_string(err))

	var templates: String = _templates_dir()
	var presets: Array[Dictionary] = []
	var index: int = 0
	while config.has_section("preset." + str(index)):
		var section: String = "preset." + str(index)
		var platform: String = str(config.get_value(section, "platform", "Unknown"))
		var preset: Dictionary = {
			"index": index,
			"name": config.get_value(section, "name", "Unknown"),
			"platform": platform,
			"runnable": _runnable(config, section),
			"export_path": config.get_value(section, "export_path", ""),
			"export_filter": config.get_value(section, "export_filter", "all_resources"),
			"include_filter": config.get_value(section, "include_filter", ""),
			"exclude_filter": config.get_value(section, "exclude_filter", "")
		}
		if config.has_section_key(section, "custom_features"):
			preset["custom_features"] = config.get_value(section, "custom_features", "")
		# Left out for a platform this file names and the exporter does not know, which has no
		# templates to look for.
		if platform in PLATFORMS:
			preset["templates_installed"] = _installed(templates, platform)
		presets.append(preset)
		index += 1
	return {"presets": presets, "presets_file_exists": true, "total_presets": index, "templates": templates}


## Whether the preset in [param section] is the one its platform runs. The editor names that preset
## in a section of its own, and kept a key in the preset's section only in files saved before that.
static func _runnable(config: ConfigFile, section: String) -> bool:
	var platform: String = str(config.get_value(section, "platform", ""))
	if config.has_section_key(RUNNABLE_SECTION, platform):
		return str(config.get_value(RUNNABLE_SECTION, platform)) == str(config.get_value(section, "name", ""))
	return GdhRead.as_bool(config.get_value(section, "runnable", false))


## Adds an export preset to export_presets.cfg, written with the keys the editor's Project > Export
## writes for a new one. The editor's exporter fills every platform option the file leaves out with
## its default when it loads the file, which is what a preset fresh from that dialog holds too.
func add_export_preset(params: Dictionary) -> Dictionary:
	var preset_name: String = str(params.get("preset", "")).strip_edges()
	var platform: String = str(params.get("platform", ""))
	var export_path: String = str(params.get("output_path", "")).trim_prefix("res://")
	if preset_name.is_empty():
		return _log.failure("preset is required: the name the preset is exported by")
	if platform not in PLATFORMS:
		return _log.failure(
			"Unknown platform '%s'. The platforms are %s." % [platform, ", ".join(PLATFORMS.keys())]
		)
	var config: ConfigFile = ConfigFile.new()
	if FileAccess.file_exists(PRESETS_FILE):
		var loading: Error = config.load(PRESETS_FILE)
		if loading != OK:
			return _log.failure("Failed to parse export_presets.cfg: " + error_string(loading))
	var index: int = 0
	while config.has_section("preset." + str(index)):
		var held: String = "preset." + str(index)
		if str(config.get_value(held, "name", "")) == preset_name:
			var path: String = str(config.get_value(held, "export_path", ""))
			var to: String = "with no export path set" if path.is_empty() else "exporting to '%s'" % path
			return _log.failure(
				(
					(
						"There is already an export preset named '%s', for %s, %s. "
						+ "project_export run exports with it; give another name to add a second."
					)
					% [preset_name, config.get_value(held, "platform", ""), to]
				)
			)
		index += 1
	# A platform with no preset to run takes the new one, as the editor's dialog does.
	var runnable: bool = not config.has_section_key(RUNNABLE_SECTION, platform)
	if runnable:
		config.set_value(RUNNABLE_SECTION, platform, preset_name)

	var section: String = "preset." + str(index)
	var values: Dictionary = {
		"name": preset_name,
		"platform": platform,
		"dedicated_server": false,
		"custom_features": "",
		"export_filter": "all_resources",
		"include_filter": "",
		"exclude_filter": "",
		"export_path": export_path,
		"patches": PackedStringArray(),
		"encryption_include_filters": "",
		"encryption_exclude_filters": "",
		"seed": 0,
		"encrypt_pck": false,
		"encrypt_directory": false,
		"script_export_mode": 2,
	}
	for key: String in values:
		config.set_value(section, key, values[key])
	# A section with nothing in it is not written, and the editor's loader reports a missing options
	# section as an error; these two are options of every platform, empty in a new preset.
	config.set_value(section + ".options", "custom_template/debug", "")
	config.set_value(section + ".options", "custom_template/release", "")
	var saving: Error = config.save(PRESETS_FILE)
	if saving != OK:
		return _log.failure("Failed to save export_presets.cfg: " + error_string(saving))

	var templates: String = _templates_dir()
	var installed: bool = _installed(templates, platform)
	var answer: Dictionary = {
		"preset": preset_name,
		"platform": platform,
		"index": index,
		"runnable": runnable,
		"export_path": export_path,
		"file": PRESETS_FILE,
		"templates": templates,
		"templates_installed": installed,
	}
	if not installed:
		answer["templates_note"] = (
			(
				"No %s export templates for this engine are at %s, and an export for %s needs them. The "
				+ "editor installs them in Editor > Manage Export Templates, or they can be unpacked "
				+ "there from the export templates archive of this engine's release."
			)
			% [platform, templates, platform]
		)
	return answer


## Where the editor of this engine keeps its export templates: beside the executable for a
## self-contained one, otherwise in the user's data directory, as the editor's own paths have it.
static func _templates_dir() -> String:
	var version: Dictionary = Engine.get_version_info()
	var named: String = (
		"%d.%d" % [GdhRead.as_int(version.get("major", 0)), GdhRead.as_int(version.get("minor", 0))]
	)
	if GdhRead.as_int(version.get("patch", 0)) != 0:
		named += "." + str(GdhRead.as_int(version.get("patch", 0)))
	named += "." + str(version.get("status", ""))
	if ClassDB.class_exists("CSharpScript"):
		named += ".mono"
	var beside: String = OS.get_executable_path().get_base_dir()
	var contained: bool = _marks_self_contained(beside)
	# A macOS bundle is read-only, so its editor looks for the marker beside the bundle too, and keeps
	# its data there whichever of the two places had it.
	if (
		OS.has_feature("macos")
		and beside.ends_with("MacOS")
		and beside.path_join("..").simplify_path().ends_with("Contents")
	):
		beside = beside.path_join("../../..").simplify_path()
		contained = contained or _marks_self_contained(beside)
	if contained:
		return beside.path_join("editor_data").path_join("export_templates").path_join(named)
	var home: String = (
		"godot" if OS.get_name() in ["Linux", "FreeBSD", "NetBSD", "OpenBSD", "BSD"] else "Godot"
	)
	return OS.get_data_dir().path_join(home).path_join("export_templates").path_join(named)


## Whether [param templates] holds any of [param platform]'s templates. The directory is one per
## engine version and holds whichever platforms were installed into it, so its being there says
## nothing about this platform.
static func _installed(templates: String, platform: String) -> bool:
	if not DirAccess.dir_exists_absolute(templates):
		return false
	for file: String in DirAccess.get_files_at(templates):
		if file.begins_with(PLATFORMS[platform]):
			return true
	return false


static func _marks_self_contained(directory: String) -> bool:
	return (
		FileAccess.file_exists(directory.path_join("._sc_"))
		or FileAccess.file_exists(directory.path_join("_sc_"))
	)


## Every option of [param params]'s platform, as its exporter gives a new preset them: the name, the
## type, the hint and hint string of one that is an enum or a list, and the default.
func export_options(params: Dictionary) -> Dictionary:
	var platform: String = str(params.get("platform", ""))
	if platform not in EXPORTERS:
		return _log.failure(
			"Unknown platform '%s'. The platforms are %s." % [platform, ", ".join(EXPORTERS.keys())]
		)
	if not Engine.is_editor_hint():
		return _log.failure("The export options are read in an engine started with --editor.")
	var exporter: Variant = ClassDB.instantiate(EXPORTERS[platform])
	if not exporter is Object:
		return _log.failure("The engine made no %s exporter." % platform)
	var made: Object = exporter
	var preset: Variant = made.call("create_preset")
	if not preset is Object:
		return _log.failure("The %s exporter made no preset." % platform)
	var fresh: Object = preset
	var options: Array[Dictionary] = []
	for property: Dictionary in fresh.get_property_list():
		var usage: int = GdhRead.as_int(property.get("usage", 0))
		var name: String = str(property.get("name", ""))
		if usage & PROPERTY_USAGE_CATEGORY or usage & PROPERTY_USAGE_GROUP or not name.contains("/"):
			continue
		(
			options
			. append(
				{
					"name": name,
					"type": GdhRead.as_int(property.get("type", TYPE_NIL)),
					"hint": GdhRead.as_int(property.get("hint", PROPERTY_HINT_NONE)),
					"hintString": str(property.get("hint_string", "")),
					"default": fresh.get(name),
				}
			)
		)
	return {"platform": platform, "options": options}


## Changes what [param params] gives of a preset in export_presets.cfg: its export path, its
## resource filter and the files it names, its include and exclude filters, its custom features and
## its platform's options, each option checked against [code]known_options[/code], the list
## [method export_options] answers for the preset's platform. Nothing is written when any of it is
## refused.
func set_export_preset(params: Dictionary) -> Dictionary:
	var loaded: Variant = _preset_named(str(params.get("preset", "")).strip_edges())
	if loaded is String:
		return _log.failure(str(loaded))
	var found: Dictionary = loaded
	var config: ConfigFile = found["config"]
	var section: String = found["section"]
	var platform: String = str(config.get_value(section, "platform", ""))
	var top: Dictionary = {}
	if params.has("output_path"):
		top["export_path"] = str(params["output_path"]).trim_prefix("res://")
	for key: String in ["include_filter", "exclude_filter", "custom_features"]:
		if params.has(key):
			top[key] = str(params[key])
	var filter: String = str(
		params.get("export_filter", config.get_value(section, "export_filter", "all_resources"))
	)
	if params.has("export_filter"):
		if filter not in FILTERS:
			return _log.failure(GdhRead.offered("export_filter takes no %s" % filter, filter, FILTERS) + ".")
		top["export_filter"] = filter
	if params.has("files"):
		var listed: Variant = _files_for(filter, params["files"])
		if listed is String:
			return _log.failure(str(listed))
		top["export_files"] = listed
	elif filter != "all_resources" and params.has("export_filter"):
		var kept: Variant = config.get_value(section, "export_files", PackedStringArray())
		var kept_files: PackedStringArray = kept if kept is PackedStringArray else PackedStringArray()
		if kept is PackedStringArray and kept_files.is_empty():
			return (
				_log
				. failure(
					(
						"export_filter %s exports the files the preset lists, and it lists none: give them in files."
						% filter
					)
				)
			)
	var options: Variant = params.get("options", {})
	if not options is Dictionary:
		return _log.failure("options is an object of option names and values.")
	var asked: Dictionary = options
	var known: Variant = params.get("known_options", [])
	var written: Variant = _options_for(platform, asked, known)
	if written is String:
		return _log.failure(str(written))
	var values: Dictionary = written
	if top.is_empty() and values.is_empty():
		return _log.failure(
			(
				"Nothing to change: give outputPath, exportFilter, files, includeFilter, excludeFilter, "
				+ "customFeatures or options."
			)
		)
	var changed: Dictionary = {}
	for key: String in top:
		var before: Variant = config.get_value(section, key) if config.has_section_key(section, key) else null
		changed[key] = {"before": before, "now": top[key]}
		config.set_value(section, key, top[key])
	var defaults: Dictionary = {}
	if known is Array:
		for option: Variant in known:
			if option is Dictionary:
				var described: Dictionary = option
				defaults[str(described.get("name", ""))] = described.get("default")
	for name: String in values:
		var held: Variant = defaults.get(name)
		if config.has_section_key(section + ".options", name):
			held = config.get_value(section + ".options", name)
		changed[name] = {"before": held, "now": values[name]}
		config.set_value(section + ".options", name, values[name])
	var saving: Error = config.save(PRESETS_FILE)
	if saving != OK:
		return _log.failure("Failed to save export_presets.cfg: " + error_string(saving))
	return {
		"preset": config.get_value(section, "name"),
		"platform": platform,
		"changed": changed,
		"file": PRESETS_FILE,
	}


## Removes a preset from export_presets.cfg, numbering those after it down by one as the editor
## saves them, and gives its platform's runnable mark to the first other preset of that platform.
func remove_export_preset(params: Dictionary) -> Dictionary:
	var preset_name: String = str(params.get("preset", "")).strip_edges()
	var loaded: Variant = _preset_named(preset_name)
	if loaded is String:
		return _log.failure(str(loaded))
	var found: Dictionary = loaded
	var config: ConfigFile = found["config"]
	var index: int = found["index"]
	var section: String = found["section"]
	var platform: String = str(config.get_value(section, "platform", ""))
	var last: int = index
	while config.has_section("preset." + str(last + 1)):
		last += 1
	for at: int in range(index, last + 1):
		for part: String in ["", ".options"]:
			var into: String = "preset.%d%s" % [at, part]
			var from: String = "preset.%d%s" % [at + 1, part]
			if config.has_section(into):
				config.erase_section(into)
			if at < last and config.has_section(from):
				for key: String in config.get_section_keys(from):
					config.set_value(into, key, config.get_value(from, key))
	var answer: Dictionary = {"removed": preset_name, "platform": platform, "file": PRESETS_FILE}
	if str(config.get_value(RUNNABLE_SECTION, platform, "")) == preset_name:
		config.set_value(RUNNABLE_SECTION, platform, null)
		var at: int = 0
		while config.has_section("preset." + str(at)):
			if str(config.get_value("preset." + str(at), "platform", "")) == platform:
				var next: String = str(config.get_value("preset." + str(at), "name", ""))
				config.set_value(RUNNABLE_SECTION, platform, next)
				answer["runnableNow"] = next
				break
			at += 1
	var saving: Error = config.save(PRESETS_FILE)
	if saving != OK:
		return _log.failure("Failed to save export_presets.cfg: " + error_string(saving))
	answer["presets"] = names()
	return answer


## export_presets.cfg loaded, with the section and index of the preset called [param preset_name],
## or why there is none.
static func _preset_named(preset_name: String) -> Variant:
	if preset_name.is_empty():
		return "preset is required: the name of the preset in export_presets.cfg"
	if not FileAccess.file_exists(PRESETS_FILE):
		return "This project has no export_presets.cfg; project_export add_preset adds a preset."
	var config: ConfigFile = ConfigFile.new()
	var loading: Error = config.load(PRESETS_FILE)
	if loading != OK:
		return "Failed to parse export_presets.cfg: " + error_string(loading)
	var held: Array[String] = names()
	var index: int = held.find(preset_name)
	if index == -1:
		if held.is_empty():
			return "export_presets.cfg has no preset, so none called %s." % preset_name
		return GdhRead.offered("There is no export preset %s" % preset_name, preset_name, held) + "."
	return {"config": config, "section": "preset." + str(index), "index": index}


## The files a preset exporting by [param filter] lists, from [param given], or why they are not.
static func _files_for(filter: String, given: Variant) -> Variant:
	if filter == "all_resources":
		return (
			"files are what a preset exports when export_filter is scenes, resources or exclude, and "
			+ "this one exports all_resources: give exportFilter too."
		)
	if not given is Array:
		return "files is a list of res:// paths."
	var listed: PackedStringArray = []
	var missing: PackedStringArray = []
	var not_scenes: PackedStringArray = []
	for entry: Variant in given:
		var path: String = str(entry)
		if not path.begins_with("res://"):
			path = "res://" + path
		if not FileAccess.file_exists(path):
			var _missing: bool = missing.append(path)
		elif filter == "scenes" and path.get_extension() not in ["tscn", "scn"]:
			var _not_scene: bool = not_scenes.append(path)
		elif not listed.has(path):
			var _listed: bool = listed.append(path)
	if not missing.is_empty():
		return (
			"Nothing was written: %s %s not in the project."
			% [", ".join(missing), "is" if missing.size() == 1 else "are"]
		)
	if not not_scenes.is_empty():
		return (
			"Nothing was written: export_filter scenes lists scenes, and %s %s not one; resources lists any file."
			% [", ".join(not_scenes), "is" if not_scenes.size() == 1 else "are"]
		)
	return listed


## The values [param asked] gives [param platform]'s options, each fitted to the option's type in
## [param known], or why one is refused.
static func _options_for(platform: String, asked: Dictionary, known: Variant) -> Variant:
	var values: Dictionary = {}
	if asked.is_empty():
		return values
	var by_name: Dictionary = {}
	if known is Array:
		for option: Variant in known:
			if option is Dictionary:
				var described: Dictionary = option
				by_name[str(described.get("name", ""))] = described
	for key: Variant in asked:
		var name: String = str(key)
		if not by_name.has(name):
			return (
				GdhRead.offered("A %s preset has no option %s" % [platform, name], name, by_name.keys()) + "."
			)
		var option: Dictionary = by_name[name]
		var fitted: Variant = _fitted(name, asked[key], option)
		if fitted is Dictionary:
			var refusal: Dictionary = fitted
			if refusal.has("refused"):
				return str(refusal["refused"])
		values[name] = fitted
	return values


## [param value] as option [param name], described by [param option], holds it, or {refused} saying
## why it cannot.
static func _fitted(name: String, value: Variant, option: Dictionary) -> Variant:
	var type: int = GdhRead.as_int(option.get("type", TYPE_NIL))
	var hint: int = GdhRead.as_int(option.get("hint", PROPERTY_HINT_NONE))
	var choices: PackedStringArray = str(option.get("hintString", "")).split(",", false)
	var shown: String = JSON.stringify(value)
	if type not in WRITABLE:
		return {
			"refused":
			(
				"%s is a %s, which this tool does not write; the editor's Export dialog does."
				% [name, type_string(type)]
			)
		}
	if type == TYPE_BOOL:
		return value if value is bool else {"refused": "%s is true or false, not %s." % [name, shown]}
	if type == TYPE_INT and hint == PROPERTY_HINT_ENUM:
		var named: PackedStringArray = []
		for at: int in choices.size():
			var choice: String = choices[at].get_slice(":", 0)
			var number: int = int(choices[at].get_slice(":", 1)) if choices[at].contains(":") else at
			var _named: bool = named.append(choice)
			if str(value) == choice or ((value is int or value is float) and value == number):
				return number
		return {"refused": "%s is one of %s, not %s." % [name, ", ".join(named), shown]}
	if type == TYPE_INT:
		if value is int:
			return value
		if value is float:
			var whole: float = value
			if whole == floorf(whole):
				return int(whole)
		return {"refused": "%s is a whole number, not %s." % [name, shown]}
	if type == TYPE_FLOAT:
		if value is int or value is float:
			var amount: float = value
			return amount
		return {"refused": "%s is a number, not %s." % [name, shown]}
	if type == TYPE_STRING:
		if not value is String:
			return {"refused": "%s is text, not %s." % [name, shown]}
		if hint == PROPERTY_HINT_ENUM and not choices.is_empty() and str(value) not in choices:
			return {"refused": "%s is one of %s, not %s." % [name, ", ".join(choices), shown]}
		return value
	if not value is Array:
		return {"refused": "%s is a list of text, not %s." % [name, shown]}
	var items: Array = value
	return PackedStringArray(items)
