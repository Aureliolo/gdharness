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
			return _log.failure(
				(
					(
						"There is already an export preset named '%s', for %s, exporting to '%s'. "
						+ "project_export run exports with it; give another name to add a second."
					)
					% [
						preset_name,
						config.get_value(held, "platform", ""),
						config.get_value(held, "export_path", "")
					]
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
