extends RefCounted

const GdhRead = preload("reading.gd")
const GdhSerialisation = preload("serialisation.gd")
const GdhFileWalk = preload("file_walk.gd")
const GdhLog = preload("logger.gd")

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
	"csv",
	"glsl",
]
## What the engine imports through Blender, which it finds only through an editor setting. With the
## setting unset, a headless import stops at the first of these and imports nothing after it.
const BLENDER_EXTENSIONS: Array[String] = ["blend"]
const BLENDER_SETTING: String = "filesystem/import/blender/blender_path"
const BLENDER_ENABLED: String = "filesystem/import/blender/enabled"
## The format version each importer writes as `importer_version` where it is above 0, which the
## editor reimports anything older than. Read off sidecars 4.7.2 writes: scene and animation_library
## write 1, and the texture importers write none. A case imports one fresh and compares, so an engine
## that raises one fails it rather than leaving this behind.
const IMPORTER_VERSIONS: Dictionary[String, int] = {"scene": 1, "animation_library": 1}
## The VRAM compression formats a project can ask for, each behind its
## `rendering/textures/vram_compression/import_<format>` setting.
const VRAM_FORMATS: Array[String] = ["s3tc_bptc", "etc2_astc"]
## Options keyed by OpenType tags, by the importer that holds them. The engine keys them by the tag as
## an int, which a caller can also name, as "liga" for ligatures.
const OPENTYPE_OPTIONS: Dictionary[String, Array] = {"font_data_dynamic": ["opentype_features"]}
const EDITOR_DIRECTORY: String = "res://.godot/editor"
const EDITOR_CACHE_PREFIX: String = "filesystem_cache"

var _log: GdhLog
var _files: GdhFileWalk = GdhFileWalk.new()
var _values: GdhSerialisation = GdhSerialisation.new()
var _sidecar_md5s: Variant = null


func _init(p_log: GdhLog) -> void:
	_log = p_log


# Get import status for resources
func get_import_status(params: Dictionary) -> Dictionary:
	var resource_path: String = str(params.get("resource_path", ""))
	var include_up_to_date: bool = GdhRead.as_bool(params.get("include_up_to_date", false))

	_log.info(
		(
			"Getting import status"
			+ (" for: " + resource_path if not resource_path.is_empty() else " for all resources")
		)
	)

	var resources: Array[Dictionary] = []
	var summary: Dictionary = {
		"total": 0, "needs_reimport": 0, "failed": 0, "up_to_date": 0, "missing_source": 0, "not_imported": 0
	}

	if not resource_path.is_empty():
		var full_path: String = resource_path
		if not full_path.begins_with("res://"):
			full_path = "res://" + full_path

		# missing_source is a sidecar whose source has gone; with neither, the path names nothing the
		# engine ever imported, and answering it as a lost source sent a caller to restore a file.
		if not FileAccess.file_exists(full_path) and not FileAccess.file_exists(full_path + ".import"):
			return _log.failure(
				_files.with_nearest_files(
					"Nothing is at %s, and no import sidecar names it" % full_path, full_path
				)
			)
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

	var answer: Dictionary = {"resources": resources, "summary": summary}
	# A total of none reads as a walk that found nothing when the project is full of scripts and
	# scenes, which the engine loads as they are and never imports.
	if resource_path.is_empty() and summary["total"] == 0:
		answer["note"] = (
			"Nothing in this project is imported: the engine imports images, audio, fonts, models and"
			+ " the like, found by extension or by a .import sidecar beside them, and loads scripts and"
			+ " scenes as they are."
		)
	return answer


# Get import options for a resource
func get_import_options(params: Dictionary) -> Dictionary:
	var resource_path: String = str(params.get("resource_path", ""))
	if not resource_path.begins_with("res://"):
		resource_path = "res://" + resource_path

	_log.info("Getting import options for: " + resource_path)

	var import_file_path: String = resource_path + ".import"

	if not FileAccess.file_exists(import_file_path):
		return _log.failure(_no_sidecar(resource_path))

	var config: ConfigFile = ConfigFile.new()
	var err: Error = config.load(import_file_path)

	if err != OK:
		return _log.failure("Failed to parse import file: " + str(err))

	var result: Dictionary = {
		"resource_path": resource_path, "import_file": import_file_path, "remap": {}, "deps": {}, "params": {}
	}

	# Through the serialiser, as every other read answers: an engine type written straight into
	# JSON is its own text, so a Vector3 option came back as "(1, 1, 1)", and writing that back put
	# a string in the sidecar where the importer reads a vector.
	for section: String in ["remap", "deps", "params"]:
		if config.has_section(section):
			var values: Dictionary = result[section]
			for key: String in config.get_section_keys(section):
				values[key] = _values.serialize_value(config.get_value(section, key))

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
		return _log.failure(_no_sidecar(resource_path))
	# A sidecar left behind by a source that has gone takes options that nothing will ever apply.
	if not FileAccess.file_exists(resource_path):
		return _log.failure(
			resource_path + " is not on disk, so there is nothing its import options apply to"
		)

	var config: ConfigFile = ConfigFile.new()
	var err: Error = config.load(import_file_path)

	if err != OK:
		return _log.failure("Failed to parse import file: " + str(err))

	# Every option checked before any is written, so a refused one leaves the sidecar as it was.
	var importer: String = str(config.get_value("remap", "importer", ""))
	var fitted_values: Dictionary = {}
	var refused: Array[String] = []
	for key: Variant in options:
		var name: String = str(key)
		var held: Variant = config.get_value("params", name, null)
		var given: Variant = _values.deserialize_value(options[key])
		var value: Variant = _as_option(_values.fitted(options[key], typeof(held)), held)
		if value is Dictionary:
			var entries: Dictionary = value
			var keyed: Dictionary = _keyed_as_option(name, entries, held, importer)
			if keyed.has("refused"):
				refused.append(str(keyed["refused"]))
				continue
			value = keyed["value"]
		# A number the option cannot hold whole is refused rather than truncated: 2.5 fitted to an
		# enum option became 2, which is another setting.
		var lossy: bool = (
			(given is int or given is float)
			and (value is int or value is float)
			and type_convert(value, typeof(given)) != given
		)
		if held != null and (lossy or not GdhSerialisation.acceptable(value, typeof(held))):
			var held_type: String = type_string(typeof(held))
			var article: String = "an" if held_type.to_lower()[0] in "aeiou" else "a"
			refused.append(
				"%s holds %s %s, and %s is not one" % [name, article, held_type, JSON.stringify(options[key])]
			)
			continue
		fitted_values[name] = value
	if not refused.is_empty():
		return _log.failure("Nothing was written: " + "; ".join(refused))

	# One already holding the value given changes nothing, and listing it as updated said it had.
	var updated_keys: Array[String] = []
	var unchanged_keys: Array[String] = []
	var changes: Dictionary = {}
	for name: String in fitted_values:
		var held: Variant = config.get_value("params", name, null)
		var value: Variant = fitted_values[name]
		if held != null and typeof(held) == typeof(value) and held == value:
			unchanged_keys.append(name)
			continue
		config.set_value("params", name, value)
		updated_keys.append(name)
		changes[name] = {
			"was": null if held == null else _values.serialize_value(held),
			"now": _values.serialize_value(value),
		}
		_log.debug("Set " + name + " = " + str(value))

	if not updated_keys.is_empty():
		err = config.save(import_file_path)
		if err != OK:
			return _log.failure("Failed to save import file: " + str(err))

	# The reimport that applies them is the server's, through the editor or the engine's import.
	var answer: Dictionary = {"resource_path": resource_path, "updated_options": updated_keys}
	if not changes.is_empty():
		answer["changed"] = changes
	if not unchanged_keys.is_empty():
		answer["unchanged_options"] = unchanged_keys
	return answer


## [param given] as the option holds it. Every JSON number arrives as a float, and an enum option
## such as compress/mode written as 1.0 is kept that way by the import, so a whole number becomes
## an int unless the option already holds a float.
static func _as_option(given: Variant, held: Variant) -> Variant:
	if given is float and not held is float:
		var number: float = given
		if number == floorf(number):
			return int(number)
	return given


## [param given] with the keys and values a dictionary option holds as ints made ints again.
##
## JSON names every key as a string and every number as a float, so a font's opentype_features was
## written as {"1818847073": 0.0}. The importer hands that to FontFile.opentype_feature_overrides,
## which keys features by their tag as an int, so the call reported success and the font kept its
## ligatures. A key is an int where the importer keys the option by OpenType tags, or where every key
## the option holds already is one; a value is an int where every value held is, or for a tag.
## Answers the dictionary under value, or why it cannot be written under refused.
static func _keyed_as_option(name: String, given: Dictionary, held: Variant, importer: String) -> Dictionary:
	var tag_options: Array = OPENTYPE_OPTIONS.get(importer, [])
	var tagged: bool = name in tag_options
	var numbered_keys: bool = tagged or _all_ints(held, true)
	var whole_values: bool = tagged or _all_ints(held, false)
	if not numbered_keys and not whole_values:
		return {"value": given}
	var keyed: Dictionary = {}
	for key: Variant in given:
		var as_key: Variant = key
		if numbered_keys:
			as_key = _int_key(key, tagged)
			if as_key == null:
				var wanted: String = (
					'OpenType tags, by name such as "liga" or as the number TextServer.name_to_tag gives'
					if tagged
					else "ints"
				)
				return {
					"refused": "%s is keyed by %s, and %s is not one" % [name, wanted, JSON.stringify(key)]
				}
		var value: Variant = given[key]
		if whole_values and value is float:
			var number: float = value
			if number == floorf(number):
				value = int(number)
		keyed[as_key] = value
	return {"value": keyed}


## [param key] as an int key, or null when it is not one: a whole number, written as a number or as
## a string of digits, or where [param tagged], an OpenType tag's four characters.
static func _int_key(key: Variant, tagged: bool) -> Variant:
	if key is int:
		return key
	if key is float:
		var number: float = key
		if number != floorf(number):
			return null
		return int(number)
	if not key is String:
		return null
	var text: String = key
	if text.is_valid_int():
		return text.to_int()
	# Exactly four printable characters, since the engine reads a longer name by its first four and
	# "ligatures" would quietly become "liga".
	if tagged and text.length() == 4 and _printable(text):
		return TextServerManager.get_primary_interface().name_to_tag(text)
	return null


static func _printable(text: String) -> bool:
	for i: int in text.length():
		var code: int = text.unicode_at(i)
		if code < 0x20 or code > 0x7e:
			return false
	return true


## Whether [param held] is a dictionary that is not empty and whose keys, or values, are all ints.
static func _all_ints(held: Variant, keys: bool) -> bool:
	if not held is Dictionary:
		return false
	var dictionary: Dictionary = held
	if dictionary.is_empty():
		return false
	for item: Variant in dictionary.keys() if keys else dictionary.values():
		if not item is int:
			return false
	return true


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
		# A file with no sidecar has not been imported only if it is something the engine imports.
		# A scene answered as needing an import, and a reimport of it ran a pass and then reported
		# the scene as not reimported, which reads as the import failing.
		var never: String = _never_imported(resource_path)
		return {
			"path": resource_path,
			"status": "needs_reimport" if never.is_empty() else "not_imported",
			"reason": "it has not been imported" if never.is_empty() else never,
			"import_file_exists": false,
			"source_exists": true
		}

	var status: Dictionary = {
		"path": resource_path, "status": "up_to_date", "import_file_exists": true, "source_exists": true
	}

	# The checks are the ones EditorFileSystem::_test_for_reimport makes, in its order, so a resource
	# reads as needing an import when the editor's next scan would import it. The importer's own two
	# cannot be asked here, where no importer is loaded, so they are made from what was measured of
	# the built-in ones; an importer a plugin adds is judged by its files alone.
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


# Why [param resource_path] has no import file, with what to do about it where anything can be done.
func _no_sidecar(resource_path: String) -> String:
	if not FileAccess.file_exists(resource_path):
		return GdhFileWalk.new().with_nearest_files(resource_path + " is not on disk", resource_path)
	var never: String = _never_imported(resource_path)
	if not never.is_empty():
		return resource_path + " has no import options: " + never
	return (
		resource_path
		+ " has not been imported yet, so it has no import file: project_import reimport imports"
		+ " it with the importer's defaults and writes that file"
	)


## [param paths], files the engine imports and never has, as health and validation say it: at most
## five named, since a project never opened in an editor has every one of its assets here.
static func never_imported_line(paths: Array[String]) -> String:
	var named: String = ", ".join(paths.slice(0, 5))
	if paths.size() > 5:
		named += " and %d more" % (paths.size() - 5)
	if paths.size() == 1:
		return (
			named
			+ " has never been imported, so nothing can load it until project_import reimport imports it"
		)
	return (
		"%d files have never been imported, so nothing can load them until project_import reimport imports them: %s"
		% [paths.size(), named]
	)


# Why the engine will never import [param resource_path], or empty when it would.
func _never_imported(resource_path: String) -> String:
	var folder: String = resource_path.get_base_dir()
	while folder.begins_with("res://"):
		if _files.is_stepped_over(folder if folder.ends_with("/") else folder + "/"):
			return "a .gdignore in " + folder + " keeps the engine from importing anything under it"
		if folder == "res://":
			break
		folder = folder.get_base_dir()
	var extension: String = resource_path.get_extension().to_lower()
	if extension in IMPORTABLE_EXTENSIONS:
		return ""
	if extension in BLENDER_EXTENSIONS:
		if not ProjectSettings.get_setting(BLENDER_ENABLED, true):
			return "the project sets " + BLENDER_ENABLED + " to false, so the engine leaves them unimported"
		return (
			"the engine imports ."
			+ extension
			+ " files through Blender, which it finds through the editor setting "
			+ BLENDER_SETTING
			+ ". An editor with it set imports them on its scan; an import pass with it unset stops at"
			+ " the first one and imports nothing, and setting "
			+ BLENDER_ENABLED
			+ " to false has the engine leave them unimported"
		)
	# Loadable without a sidecar is what a scene, a script or a saved resource is: read as it is.
	if ResourceLoader.exists(resource_path):
		return "the engine loads ." + extension + " files as they are, without importing them"
	return (
		"no importer built into the engine takes ."
		+ extension
		+ " files; one added by a plugin or an extension is known only to the editor, whose scan imports them"
	)


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
	# The importer is asked first, as the editor asks it: whether it still writes this format, and
	# whether the settings the import was made under still hold. Both are true of an import whose
	# files are all current, so they were answered as up to date while the editor's next scan
	# imported them again: every scene after an engine upgrade raised the importer's version, and
	# every VRAM texture once the project asked for another compression format.
	var importer: String = str(sidecar.get_value("remap", "importer", ""))
	var version: int = GdhRead.as_int(sidecar.get_value("remap", "importer_version", 0))
	var current: int = GdhRead.as_int(IMPORTER_VERSIONS.get(importer, 0))
	if current > version:
		return _stale(
			(
				"it was imported at version %d of the %s importer, and this engine imports at version %d"
				% [version, importer, current]
			)
		)
	var lacking: Array[String] = _vram_formats_lacking(sidecar.get_value("remap", "metadata", {}))
	if not lacking.is_empty():
		return _stale(
			"the project now asks for " + ", ".join(lacking) + " textures, and this import did not write them"
		)

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


## The VRAM formats the project asks textures to be imported in that an import recorded in
## [param metadata] did not write, as the texture importers judge whether their settings still hold.
## Measured on 4.7.2 for the texture and texture array importers: turning a format on reimports every
## VRAM texture without it, and turning one off reimports nothing.
static func _vram_formats_lacking(metadata: Variant) -> Array[String]:
	var lacking: Array[String] = []
	if not metadata is Dictionary:
		return lacking
	var meta: Dictionary = metadata
	if not GdhRead.as_bool(meta.get("vram_texture", false)):
		return lacking
	var written: Variant = meta.get("imported_formats", [])
	var formats: Array = written if written is Array else []
	for format: String in VRAM_FORMATS:
		var asked: bool = GdhRead.as_bool(
			ProjectSettings.get_setting("rendering/textures/vram_compression/import_" + format, false)
		)
		if asked and format not in formats:
			lacking.append(format)
	return lacking


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
	var parsed: Variant = GdhRead.json_or_null(text)
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
