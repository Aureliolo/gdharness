extends RefCounted

const Log = preload("logger.gd")
const Patterns = preload("patterns.gd")

## Where the engine keeps a file's UID, by what kind of file it is. Measured on 4.7.2: a script or
## shader has a `.uid` file beside it, an imported file has it in its `.import`, and a text scene or
## resource has it in its own header. `ResourceLoader.get_resource_uid` answers the first two in a
## headless run and not the third, so each place is read here rather than asking it.
const SIDECAR_KINDS: Array[String] = ["gd", "gdshader", "gdshaderinc", "cs"]
const TEXT_RESOURCE_KINDS: Array[String] = ["tscn", "tres", "escn"]

var _log: Log


func _init(p_log: Log) -> void:
	_log = p_log


# The UID the engine gave a file, read from wherever that kind of file keeps it.
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

	var answer: Dictionary = {"file": file_path, "absolute_path": absolute_path}
	var found: Dictionary = uid_of(file_path)
	if found.is_empty():
		answer["exists"] = false
		answer["message"] = _why_none(file_path)
		return answer
	answer["exists"] = true
	answer.merge(found)
	return answer


# The UID and where it was read, or empty when the file has none anywhere the engine keeps one.
static func uid_of(file_path: String) -> Dictionary:
	var sidecar: String = file_path + ".uid"
	if FileAccess.file_exists(sidecar):
		var text: String = FileAccess.get_file_as_string(sidecar).strip_edges()
		if not text.is_empty():
			return {"uid": text, "from": sidecar}
	var import_file: String = file_path + ".import"
	if FileAccess.file_exists(import_file):
		var config: ConfigFile = ConfigFile.new()
		if config.load(import_file) == OK and config.has_section_key("remap", "uid"):
			return {"uid": str(config.get_value("remap", "uid")), "from": import_file}
	if file_path.get_extension().to_lower() in TEXT_RESOURCE_KINDS:
		var file: FileAccess = FileAccess.open(file_path, FileAccess.READ)
		if file != null:
			var header: String = file.get_line()
			file.close()
			var matched: RegExMatch = Patterns.compiled('\\buid="(uid://[^"]+)"').search(header)
			if matched != null:
				return {"uid": matched.get_string(1), "from": "the file's header"}
	var id: int = ResourceLoader.get_resource_uid(file_path)
	if id != ResourceUID.INVALID_ID:
		return {"uid": ResourceUID.id_to_text(id), "from": "the engine"}
	return {}


# Why [param file_path] has no UID, and what gives it one, which depends on what kind of file it is:
# refresh_uids writes a .uid for scripts and shaders only, and was named for every file.
func _why_none(file_path: String) -> String:
	var kind: String = file_path.get_extension().to_lower()
	if kind in SIDECAR_KINDS:
		return "No .uid file beside it. refresh_uids writes one for every script and shader."
	if kind in TEXT_RESOURCE_KINDS:
		return (
			"Its header carries no uid. The editor writes one when it saves the file; refresh_uids does not,"
			+ " and a headless save does not either."
		)
	if ResourceLoader.exists(file_path):
		return "The engine keeps no UID for it."
	return "It has not been imported, and the import is what gives it a UID: project_import reimport imports it."
