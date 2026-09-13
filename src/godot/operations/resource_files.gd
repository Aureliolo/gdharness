extends RefCounted

const FileWalk = preload("file_walk.gd")
const Log = preload("logger.gd")

var _log: Log
var _files: FileWalk = FileWalk.new()


func _init(p_log: Log) -> void:
	_log = p_log


# The UID the engine gave a file, from the .uid sidecar it writes beside scripts and shaders.
func get_uid(params: Dictionary) -> Dictionary:
	var file_path: String = str(params.get("resource_path", ""))
	if file_path.is_empty():
		return _log.failure("resource_path is required")
	if not file_path.begins_with("res://"):
		file_path = "res://" + file_path

	_log.info("Getting UID for file: " + file_path)

	var absolute_path: String = ProjectSettings.globalize_path(file_path)
	if not FileAccess.file_exists(file_path):
		return _log.failure("File does not exist: " + file_path)

	var uid_path: String = file_path + ".uid"
	var f: FileAccess = FileAccess.open(uid_path, FileAccess.READ)
	if not f:
		return {
			"file": file_path,
			"absolute_path": absolute_path,
			"exists": false,
			"message": "No .uid sidecar. refresh_uids writes one for every script and shader."
		}

	var uid_content: String = f.get_as_text()
	f.close()

	return {
		"file": file_path, "absolute_path": absolute_path, "uid": uid_content.strip_edges(), "exists": true
	}


# Resave every scene, script and shader so that UID references are current.
func resave_resources(_params: Dictionary) -> Dictionary:
	_log.info("Resaving all resources to update UID references...")
	var project_path: String = "res://"

	var scenes: Array[String] = _files.find_files(project_path, ".tscn")
	_log.debug("Found " + str(scenes.size()) + " scenes")

	# Resave each scene
	var success_count: int = 0
	var error_count: int = 0

	for scene_path: String in scenes:
		_log.debug("Processing scene: " + scene_path)

		if not FileAccess.file_exists(scene_path):
			_log.error("Scene file does not exist at: " + scene_path)
			error_count += 1
			continue

		var scene: Resource = load(scene_path)
		if not scene:
			error_count += 1
			_log.error("Failed to load: " + scene_path)
			continue

		var error: Error = ResourceSaver.save(scene, scene_path)
		if error != OK:
			error_count += 1
			_log.error("Failed to save: " + scene_path + ", error: " + str(error))
			continue

		success_count += 1
		if _log.debug_mode:
			_log.debug("Scene saved successfully: " + scene_path)
			var file_check_after: bool = FileAccess.file_exists(scene_path)
			_log.debug("File exists check after save: " + str(file_check_after))
			if not file_check_after:
				_log.error("File reported as saved but does not exist at: " + scene_path)

	# A UID sits beside every script and shader as a .uid file. Outside the editor the save
	# below answers OK and writes no sidecar, so what comes back is what was resaved and how
	# many are still without one, rather than a count of UIDs this made.
	var scripts: Array[String] = (
		_files.find_files(project_path, ".gd")
		+ _files.find_files(project_path, ".shader")
		+ _files.find_files(project_path, ".gdshader")
	)
	_log.debug("Found " + str(scripts.size()) + " scripts/shaders")

	var missing_uids: int = 0
	var resaved_scripts: int = 0

	for script_path: String in scripts:
		_log.debug("Checking UID for: " + script_path)
		var uid_path: String = script_path + ".uid"

		var f: FileAccess = FileAccess.open(uid_path, FileAccess.READ)
		if f:
			_log.debug("UID file already exists for: " + script_path)
			continue

		missing_uids += 1
		_log.debug("Missing UID file for: " + script_path + ", resaving...")

		var res: Resource = load(script_path)
		if not res:
			_log.error("Failed to load resource: " + script_path)
			continue

		var error: Error = ResourceSaver.save(res, script_path)
		if error != OK:
			_log.error("Failed to resave: " + script_path + ", error: " + str(error))
			continue

		resaved_scripts += 1
		_log.debug("Resaved: " + script_path)

	_log.info("Resave operation complete")

	return {
		"scenes_processed": scenes.size(),
		"scenes_saved": success_count,
		"scenes_with_errors": error_count,
		"scripts_missing_uids": missing_uids,
		"scripts_resaved": resaved_scripts
	}
