extends RefCounted

const Log = preload("logger.gd")

var _log: Log


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
