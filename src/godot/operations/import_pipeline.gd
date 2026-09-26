extends RefCounted

const Read = preload("reading.gd")
const FileWalk = preload("file_walk.gd")
const Log = preload("logger.gd")

## What the engine imports with no tool outside it, for finding what has not been imported yet;
## everything imported already is found by its sidecar whatever its extension.
const IMPORTABLE_EXTENSIONS: Array[String] = [
	"png",
	"jpg",
	"jpeg",
	"webp",
	"svg",
	"bmp",
	"tga",
	"exr",
	"hdr",
	"dds",
	"ktx",
	"wav",
	"mp3",
	"ogg",
	"ttf",
	"otf",
	"ttc",
	"otc",
	"woff",
	"woff2",
	"pfb",
	"pfm",
	"fnt",
	"font",
	"glb",
	"gltf",
	"fbx",
	"obj",
	"dae",
]
const EDITOR_DIRECTORY: String = "res://.godot/editor"
const EDITOR_CACHE_PREFIX: String = "filesystem_cache"

var _log: Log
var _files: FileWalk = FileWalk.new()
var _sidecar_md5s: Variant = null


func _init(p_log: Log) -> void:
	_log = p_log


# Get import status for resources
func get_import_status(params: Dictionary) -> Dictionary:
	var resource_path: String = str(params.get("resource_path", ""))
	var include_up_to_date: bool = Read.as_bool(params.get("include_up_to_date", false))

	_log.info(
		(
			"Getting import status"
			+ (" for: " + resource_path if not resource_path.is_empty() else " for all resources")
		)
	)

	var resources: Array[Dictionary] = []
	var summary: Dictionary = {
		"total": 0, "needs_reimport": 0, "failed": 0, "up_to_date": 0, "missing_source": 0
	}

	if not resource_path.is_empty():
		var full_path: String = resource_path
		if not full_path.begins_with("res://"):
			full_path = "res://" + full_path

		var status: Dictionary = _import_status_of(full_path, full_path + ".import")
		resources.append(status)
		_tally(summary, status)
	else:
		# Sources by extension, for what has never been imported, and sidecars, for what was imported
		# from a type the list does not name and for a sidecar whose source is gone.
		var found: Dictionary[String, bool] = {}
		for res_path: String in _files.find_files_with_extensions("res://", IMPORTABLE_EXTENSIONS):
			found[res_path] = true
		for sidecar: String in _files.find_files_with_extensions("res://", ["import"]):
			found[sidecar.trim_suffix(".import")] = true
		var paths: Array[String] = []
		paths.assign(found.keys())
		paths.sort()
		for res_path: String in paths:
			var status: Dictionary = _import_status_of(res_path, res_path + ".import")

			if include_up_to_date or status["status"] != "up_to_date":
				resources.append(status)

			_tally(summary, status)

	return {"resources": resources, "summary": summary}


# Get import options for a resource
func get_import_options(params: Dictionary) -> Dictionary:
	var resource_path: String = str(params.get("resource_path", ""))
	if not resource_path.begins_with("res://"):
		resource_path = "res://" + resource_path

	_log.info("Getting import options for: " + resource_path)

	var import_file_path: String = resource_path + ".import"

	if not FileAccess.file_exists(import_file_path):
		_log.error("Import file does not exist: " + import_file_path)
		return _log.failure("This resource may not have been imported yet")

	var config: ConfigFile = ConfigFile.new()
	var err: Error = config.load(import_file_path)

	if err != OK:
		return _log.failure("Failed to parse import file: " + str(err))

	var result: Dictionary = {
		"resource_path": resource_path, "import_file": import_file_path, "remap": {}, "deps": {}, "params": {}
	}

	for section: String in ["remap", "deps", "params"]:
		if config.has_section(section):
			var values: Dictionary = result[section]
			for key: String in config.get_section_keys(section):
				values[key] = config.get_value(section, key)

	return result


# Set import options for a resource
func set_import_options(params: Dictionary) -> Dictionary:
	var resource_path: String = str(params.get("resource_path", ""))
	if not resource_path.begins_with("res://"):
		resource_path = "res://" + resource_path

	var options: Dictionary = params.get("options", {})

	_log.info("Setting import options for: " + resource_path)

	var import_file_path: String = resource_path + ".import"

	if not FileAccess.file_exists(import_file_path):
		_log.error("Import file does not exist: " + import_file_path)
		return _log.failure("This resource may not have been imported yet")

	var config: ConfigFile = ConfigFile.new()
	var err: Error = config.load(import_file_path)

	if err != OK:
		return _log.failure("Failed to parse import file: " + str(err))

	var updated_keys: Array[String] = []
	for key: Variant in options:
		var name: String = str(key)
		var value: Variant = _as_option(options[key], config.get_value("params", name, null))
		config.set_value("params", name, value)
		updated_keys.append(name)
		_log.debug("Set " + name + " = " + str(value))

	err = config.save(import_file_path)
	if err != OK:
		return _log.failure("Failed to save import file: " + str(err))

	# The reimport that applies them is the server's, through the editor or the engine's import.
	return {"resource_path": resource_path, "updated_options": updated_keys}


## [param given] as the option holds it. Every JSON number arrives as a float, and an enum option
## such as compress/mode written as 1.0 is kept that way by the import, so a whole number becomes
## an int unless the option already holds a float.
static func _as_option(given: Variant, held: Variant) -> Variant:
	if given is float and not held is float:
		var number: float = given
		if number == floorf(number):
			return int(number)
	return given


# List export presets
func list_export_presets(_params: Dictionary) -> Dictionary:
	_log.info("Listing export presets")

	var presets_file: String = "res://export_presets.cfg"

	if not FileAccess.file_exists(presets_file):
		return {
			"presets": [],
			"presets_file_exists": false,
			"note": "No export_presets.cfg found. Configure export presets in the Godot editor."
		}

	var config: ConfigFile = ConfigFile.new()
	var err: Error = config.load(presets_file)

	if err != OK:
		return _log.failure("Failed to parse export_presets.cfg: " + str(err))

	# Export presets are stored as [preset.0], [preset.1], etc.
	var presets: Array[Dictionary] = []
	var preset_idx: int = 0
	while config.has_section("preset." + str(preset_idx)):
		var section: String = "preset." + str(preset_idx)
		var preset: Dictionary = {
			"index": preset_idx,
			"name": config.get_value(section, "name", "Unknown"),
			"platform": config.get_value(section, "platform", "Unknown"),
			"runnable": config.get_value(section, "runnable", false),
			"export_path": config.get_value(section, "export_path", ""),
			"export_filter": config.get_value(section, "export_filter", "all_resources"),
			"include_filter": config.get_value(section, "include_filter", ""),
			"exclude_filter": config.get_value(section, "exclude_filter", "")
		}

		if config.has_section_key(section, "custom_features"):
			preset["custom_features"] = config.get_value(section, "custom_features", "")

		presets.append(preset)
		preset_idx += 1

	return {"presets": presets, "presets_file_exists": true, "total_presets": preset_idx}


# Validate project for export
func validate_project(params: Dictionary) -> Dictionary:
	var preset_name: String = str(params.get("preset", ""))
	var include_suggestions: bool = Read.as_bool(params.get("include_suggestions", true), true)

	_log.info("Validating project" + (" for preset: " + preset_name if not preset_name.is_empty() else ""))

	var issues: Array[Dictionary] = []
	var warnings: Array[Dictionary] = []
	var checks_performed: Array[String] = []

	checks_performed.append("project_file")
	if not FileAccess.file_exists("res://project.godot"):
		issues.append(
			_finding(
				"error",
				"project_file",
				"project.godot not found",
				"Ensure you are running this from a valid Godot project directory",
				include_suggestions
			)
		)

	checks_performed.append("main_scene")
	var main_scene: String = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if main_scene.is_empty():
		issues.append(
			_finding(
				"error",
				"main_scene",
				"No main scene set",
				"Set a main scene in Project Settings > Application > Run > Main Scene",
				include_suggestions
			)
		)
	elif not FileAccess.file_exists(main_scene):
		issues.append(
			_finding(
				"error",
				"main_scene",
				"Main scene file does not exist: " + main_scene,
				"Update the main scene setting or create the missing scene file",
				include_suggestions
			)
		)

	checks_performed.append("export_presets")
	if not FileAccess.file_exists("res://export_presets.cfg"):
		warnings.append(
			_finding(
				"warning",
				"export_presets",
				"No export presets configured",
				"Configure export presets in Godot editor: Project > Export",
				include_suggestions
			)
		)

	checks_performed.append("icon")
	var icon_path: String = str(ProjectSettings.get_setting("application/config/icon", ""))
	if icon_path.is_empty():
		warnings.append(
			_finding(
				"warning",
				"icon",
				"No application icon set",
				"Set an icon in Project Settings > Application > Config > Icon",
				include_suggestions
			)
		)
	elif not FileAccess.file_exists(icon_path):
		warnings.append(
			_finding(
				"warning",
				"icon",
				"Icon file does not exist: " + icon_path,
				"Update the icon path or add the missing icon file",
				include_suggestions
			)
		)

	checks_performed.append("project_name")
	var project_name: String = str(ProjectSettings.get_setting("application/config/name", ""))
	if project_name.is_empty():
		warnings.append(
			_finding(
				"warning",
				"project_name",
				"No project name set",
				"Set a project name in Project Settings > Application > Config > Name",
				include_suggestions
			)
		)

	checks_performed.append("scripts")
	var script_files: Array[String] = _files.find_files_with_extensions("res://", ["gd"])
	var scripts_checked: int = 0
	var script_issues: Array[Dictionary] = []

	# A hundred scripts is enough to say whether the project is tidy without a large one
	# turning validation into a full read of its source tree.
	for script_path: String in script_files:
		scripts_checked += 1
		if scripts_checked > 100:
			break

		var file: FileAccess = FileAccess.open(script_path, FileAccess.READ)
		if file:
			var content: String = file.get_as_text()
			file.close()

			if "# TODO" in content or "# FIXME" in content:
				script_issues.append({"path": script_path, "issue": "Contains TODO/FIXME comments"})
			if "pass # TODO" in content:
				script_issues.append({"path": script_path, "issue": "Contains unimplemented functions"})

	if script_issues.size() > 0:
		var warning: Dictionary = _finding(
			"warning",
			"scripts",
			str(script_issues.size()) + " script issues found",
			"Review and resolve TODO/FIXME items before release",
			include_suggestions
		)
		warning["details"] = script_issues.slice(0, 5)
		warnings.append(warning)

	return {
		"valid": issues.is_empty(),
		"issues": issues,
		"warnings": warnings,
		"checks_performed": checks_performed,
		"scripts_checked": scripts_checked,
		"issue_count": issues.size(),
		"warning_count": warnings.size()
	}


func _finding(
	type: String, check: String, message: String, suggestion: String, include_suggestion: bool
) -> Dictionary:
	var finding: Dictionary = {"type": type, "check": check, "message": message}
	if include_suggestion:
		finding["suggestion"] = suggestion
	return finding


func _tally(summary: Dictionary, status: Dictionary) -> void:
	summary["total"] += 1
	var state: String = status["status"]
	if summary.has(state):
		summary[state] += 1


# Whether a resource is imported, out of date, or has lost its source file.
func _import_status_of(resource_path: String, import_file_path: String) -> Dictionary:
	var source_exists: bool = FileAccess.file_exists(resource_path)
	if not source_exists:
		return {
			"path": resource_path,
			"status": "missing_source",
			"import_file_exists": FileAccess.file_exists(import_file_path),
			"source_exists": false
		}

	var import_file_exists: bool = FileAccess.file_exists(import_file_path)
	if not import_file_exists:
		return {
			"path": resource_path,
			"status": "needs_reimport",
			"reason": "it has not been imported",
			"import_file_exists": false,
			"source_exists": true
		}

	var status: Dictionary = {
		"path": resource_path, "status": "up_to_date", "import_file_exists": true, "source_exists": true
	}

	# The checks are the ones EditorFileSystem::_test_for_reimport makes, in its order, so a resource
	# reads as needing an import exactly when the editor's next scan would import it.
	var sidecar: ConfigFile = ConfigFile.new()
	var stale: Dictionary = (
		_stale("its import file cannot be read")
		if sidecar.load(import_file_path) != OK
		else _sidecar_staleness(resource_path, import_file_path, sidecar)
	)
	var kept: bool = str(sidecar.get_value("remap", "importer", "")) in ["keep", "skip"]
	if stale.is_empty() and not kept:
		stale = _import_staleness(resource_path, sidecar)
	status.merge(stale, true)
	return status


static func _stale(reason: String) -> Dictionary:
	return {"status": "needs_reimport", "reason": reason}


## What the editor reads off the sidecar before looking at the import: an answer for a stale or
## failed resource, empty otherwise.
func _sidecar_staleness(resource_path: String, import_file_path: String, sidecar: ConfigFile) -> Dictionary:
	# The editor compares the sidecar with the one it last imported from before reading anything in
	# it, so an option set without a reimport is imported on its next scan, and not before.
	var imported_from: String = _imported_sidecar_md5s().get(resource_path, "")
	if not imported_from.is_empty() and FileAccess.get_md5(import_file_path) != imported_from:
		return _stale("its import file changed after it was imported, as setting an option does")

	# A failed import is never tried again on its own: the editor skips it to avoid a loop of
	# reimports, so it stays failed after its source is fixed until something asks for a reimport.
	var valid: Variant = sidecar.get_value("remap", "valid", true)
	if valid is bool and not valid:
		return {
			"status": "failed",
			"reason": "its last import failed, and the editor does not try a failed import again on its own",
		}
	return {}


## Whether the import itself is still the one its sidecar and source describe: an answer for a
## stale resource, empty for a current one.
static func _import_staleness(resource_path: String, sidecar: ConfigFile) -> Dictionary:
	if not sidecar.has_section_key("remap", "uid"):
		return _stale("its import file has no uid, which the import writes")

	# The sidecar alone does not say the import is there: deleting the outputs under
	# .godot/imported is the ordinary way to force one, and a resource whose output is gone was
	# answered as current, which is what a reimport is then skipped on.
	var outputs: Array[String] = _outputs_of(sidecar)
	var missing: Array[String] = []
	for output: String in outputs:
		if not FileAccess.file_exists(output):
			missing.append(output)
	if not missing.is_empty():
		var gone: Dictionary = _stale("its imported output is not on disk")
		gone["missing_outputs"] = missing
		return gone

	var source_file: String = str(sidecar.get_value("deps", "source_file", ""))
	if not source_file.is_empty() and source_file != resource_path:
		return _stale("its import file was written for " + source_file)

	# By content, as the editor judges it: the hash of the source the import recorded, against the
	# file. By time, an installer that rewrote 31 images byte for byte made every one read as changed,
	# and the editor, which compares the hash, rightly imported none of them.
	var recorded: Dictionary = _recorded_md5s(resource_path)
	var recorded_source: String = recorded.get("source_md5", "")
	if recorded_source.is_empty():
		return _stale("its import recorded no hash of its source")
	if FileAccess.get_md5(resource_path) != recorded_source:
		return _stale("the source changed after it was imported")

	var recorded_outputs: String = recorded.get("dest_md5", "")
	if (
		not outputs.is_empty()
		and not recorded_outputs.is_empty()
		and _md5_of_all(outputs) != recorded_outputs
	):
		return _stale("its imported output changed after it was imported")

	# A scene built without an image it names: it loads each one as it imports, so one imported
	# before the image was is built without it. Read off what the imported scene depends on, not off
	# file times: a texture a 3D scene uses is reimported compressed after the scene, so its outputs
	# are always the newer, and 33 correct scenes read as stale when judged that way.
	#
	# Followed through the resources the scene depends on, since a post-import script that swaps each
	# material for a saved one leaves the scene depending on the material and only the material on
	# the image: 211 correct scenes read as stale when only the scene's own list was read. And not
	# held against a scene an import script shaped at all, since the script may replace a material
	# with one using other images entirely, which is the scene it was meant to build.
	var without: Array[String] = []
	var images: Array[String] = _images_of(resource_path)
	if not images.is_empty() and not _shaped_by_a_script(sidecar):
		var depended: Dictionary[String, bool] = _depended_on(resource_path)
		for image: String in images:
			if FileAccess.file_exists(image + ".import") and not depended.has(image):
				without.append(image)
	if without.is_empty():
		return {}
	var built: Dictionary = _stale("it was imported without images it uses, which were not imported yet")
	built["imported_without"] = without
	return built


## The hashes [param resource_path]'s last import recorded, [code]source_md5[/code] of its source
## and [code]dest_md5[/code] of its outputs, empty when there is no record: the editor keeps them
## beside the outputs, under the same base name with [code].md5[/code].
static func _recorded_md5s(resource_path: String) -> Dictionary:
	var record: String = (
		"res://.godot/imported/%s-%s.md5" % [resource_path.get_file(), resource_path.md5_text()]
	)
	var config: ConfigFile = ConfigFile.new()
	if config.load(record) != OK:
		return {}
	return {
		"source_md5": str(config.get_value("", "source_md5", "")),
		"dest_md5": str(config.get_value("", "dest_md5", "")),
	}


## One md5 over the contents of [param paths] in turn, as [code]FileAccess::get_multiple_md5[/code]
## computes the [code]dest_md5[/code] an import records.
static func _md5_of_all(paths: Array[String]) -> String:
	var hashing: HashingContext = HashingContext.new()
	if hashing.start(HashingContext.HASH_MD5) != OK:
		return ""
	for path: String in paths:
		var file: FileAccess = FileAccess.open(path, FileAccess.READ)
		if file == null:
			continue
		while not file.eof_reached():
			var chunk: PackedByteArray = file.get_buffer(32768)
			if chunk.is_empty():
				break
			if hashing.update(chunk) != OK:
				return ""
	return hashing.finish().hex_encode()


## The md5 of each resource's sidecar as the editor last imported it, keyed by path, from the cache
## the editor writes under .godot/editor; empty when there is no cache or it cannot be read.
func _imported_sidecar_md5s() -> Dictionary:
	if _sidecar_md5s != null:
		return _sidecar_md5s
	var found: Dictionary = {}
	_sidecar_md5s = found
	var cache: String = _editor_cache_path()
	var file: FileAccess = null if cache.is_empty() else FileAccess.open(cache, FileAccess.READ)
	if file == null:
		return found
	# The first line is the import settings version; then a "::<dir>::<time>" line opens each
	# directory, and each file line is nine fields split by "::", the last holding the file's
	# dependencies, which may contain the splitter. The eighth field is "<>"-separated, with the
	# sidecar's md5 sixth.
	var directory: String = "res://"
	var first: bool = true
	while not file.eof_reached():
		var line: String = file.get_line().strip_edges()
		if first:
			first = false
			continue
		if line.is_empty():
			continue
		if line.begins_with("::"):
			var opened: PackedStringArray = line.split("::")
			if opened.size() == 3:
				directory = opened[1]
			continue
		var fields: PackedStringArray = line.split("::", true, 8)
		if fields.size() < 9:
			continue
		var slices: PackedStringArray = fields[7].split("<>")
		if slices.size() >= 7 and not slices[5].is_empty():
			found[directory.path_join(fields[0])] = slices[5]
	return found


## The editor's filesystem cache, the newest version of it when an engine upgrade has left an older
## one beside it, or "" when the project has none. Its name carries a format version that the
## engine raises when the layout changes: 4.7.2 writes filesystem_cache10.
static func _editor_cache_path() -> String:
	var newest: int = -1
	if not DirAccess.dir_exists_absolute(EDITOR_DIRECTORY):
		return ""
	for name: String in DirAccess.get_files_at(EDITOR_DIRECTORY):
		if name.begins_with(EDITOR_CACHE_PREFIX) and name.trim_prefix(EDITOR_CACHE_PREFIX).is_valid_int():
			newest = maxi(newest, name.trim_prefix(EDITOR_CACHE_PREFIX).to_int())
	return "" if newest < 0 else EDITOR_DIRECTORY.path_join(EDITOR_CACHE_PREFIX + str(newest))


## The path of one entry [method ResourceLoader.get_dependencies] lists, past any uid and type.
static func _path_of(entry: String) -> String:
	var at: int = entry.rfind("::")
	return entry if at < 0 else entry.substr(at + 2)


## Every path [param resource_path] depends on, through the resources it depends on in turn; a set,
## keyed by path.
static func _depended_on(resource_path: String) -> Dictionary[String, bool]:
	var found: Dictionary[String, bool] = {}
	var pending: Array[String] = [resource_path]
	# Every path is followed once, which ends the walk and survives a cycle; a cap or a list of
	# extensions would leave out a material behind a long chain or in a saved .mesh.
	while not pending.is_empty():
		var next: String = pending.pop_back()
		for entry: String in ResourceLoader.get_dependencies(next):
			var path: String = _path_of(entry)
			if not found.has(path):
				found[path] = true
				pending.append(path)
	return found


## Whether the import [param sidecar] describes runs a post-import script.
static func _shaped_by_a_script(sidecar: ConfigFile) -> bool:
	return not str(sidecar.get_value("params", "import_script/path", "")).is_empty()


## The files an import wrote, from its sidecar's [code]dest_files[/code]; empty when it lists none.
static func _outputs_of(sidecar: ConfigFile) -> Array[String]:
	var outputs: Array[String] = []
	var listed: Variant = sidecar.get_value("deps", "dest_files", [])
	if listed is Array:
		for one: Variant in listed:
			outputs.append(str(one))
	return outputs


## The image files a glTF scene refers to by path, resolved against the scene's own directory.
## Embedded images and every other scene format answer nothing.
static func _images_of(scene_path: String) -> Array[String]:
	var images: Array[String] = []
	var text: String = ""
	match scene_path.get_extension().to_lower():
		"gltf":
			text = FileAccess.get_file_as_string(scene_path)
		"glb":
			# A 12-byte header, then the first chunk: its length, its type, and for "JSON" the text.
			var bytes: PackedByteArray = FileAccess.get_file_as_bytes(scene_path)
			if bytes.size() >= 20 and bytes.decode_u32(16) == 0x4E4F534A:
				var length: int = bytes.decode_u32(12)
				text = bytes.slice(20, mini(20 + length, bytes.size())).get_string_from_utf8()
	if text.is_empty():
		return images
	var parsed: Variant = JSON.parse_string(text)
	if not parsed is Dictionary:
		return images
	var document: Dictionary = parsed
	var listed: Variant = document.get("images", [])
	if not listed is Array:
		return images
	for image: Variant in listed:
		if not image is Dictionary:
			continue
		var entry: Dictionary = image
		var uri: String = str(entry.get("uri", ""))
		if uri.is_empty() or uri.begins_with("data:"):
			continue
		images.append(scene_path.get_base_dir().path_join(uri.uri_decode()).simplify_path())
	return images
