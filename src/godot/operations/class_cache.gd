extends RefCounted

# The editor keeps the list of global classes it knows in .godot/global_script_class_cache.cfg
# and refreshes it only on a filesystem scan, which it does not always do (godotengine/godot#42786).
# A game started from a stale editor then cannot resolve any class_name written since, and the
# engine reads the same file headless, so the list is rebuilt here from the scripts themselves.

const FileWalk = preload("file_walk.gd")
const Log = preload("logger.gd")

const CACHE_PATH: String = "res://.godot/global_script_class_cache.cfg"

var _log: Log
var _files: FileWalk = FileWalk.new()


func _init(p_log: Log) -> void:
	_log = p_log


func refresh_class_cache(_params: Dictionary) -> Dictionary:
	var before: Dictionary = _entries_by_class(_read_cache())

	var entries: Array = []
	var skipped: Array[Dictionary] = []
	for path: String in _files.find_files("res://", ".gd"):
		var entry: Dictionary = _entry_for(path, skipped)
		if not entry.is_empty():
			entries.append(entry)
	# By name as text: StringName's own order is by identity, not by spelling.
	entries.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return str(a["class"]) < str(b["class"]))

	var after: Dictionary = _entries_by_class(entries)
	var config: ConfigFile = ConfigFile.new()
	config.set_value("", "list", entries)
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(CACHE_PATH.get_base_dir()))
	var err: Error = config.save(CACHE_PATH)
	if err != OK:
		return _log.failure("Failed to write " + CACHE_PATH + ": " + error_string(err))

	var added: Array[String] = []
	var removed: Array[String] = []
	var changed: Array[String] = []
	for name: String in after:
		if not before.has(name):
			added.append(name)
		elif before[name] != after[name]:
			changed.append(name)
	for name: String in before:
		if not after.has(name):
			removed.append(name)

	return {
		"path": CACHE_PATH,
		"classes": entries.size(),
		"added": added,
		"removed": removed,
		"changed": changed,
		"skipped": skipped,
	}


# The cache entry for one script, or empty for a script with no class_name.
#
# Read from the source rather than by loading the script, as the editor does: loading a script
# that extends a class_name resolves that name through the very list being rebuilt, so a stale
# list would fail every script written against a newer class and leave the list stale.
func _entry_for(path: String, skipped: Array[Dictionary]) -> Dictionary:
	var header: Dictionary = _header_of(path)
	var declared: String = str(header.get("class_name", ""))
	if declared.is_empty():
		return {}

	var base: String = _base_of(path, header, skipped)
	if base.is_empty():
		return {}

	# The field order is the editor's, so a rebuilt file reads as one the editor wrote.
	return {
		"base": StringName(base),
		"class": StringName(declared),
		"icon": str(header.get("icon", "")),
		"is_abstract": bool(header.get("abstract", false)),
		"is_tool": bool(header.get("tool", false)),
		"language": StringName("GDScript"),
		"path": path,
	}


# What the editor records as the base: the nearest ancestor with a class_name, else the native
# class at the top of the chain. A script that extends by path is followed to its own header.
func _base_of(path: String, header: Dictionary, skipped: Array[Dictionary]) -> String:
	var visited: Array[String] = [path]
	var current: Dictionary = header
	while true:
		var extends_what: String = str(current.get("extends", ""))
		if extends_what.is_empty():
			return "RefCounted"
		if not (extends_what.begins_with('"') or extends_what.begins_with("'")):
			return extends_what
		var parent_path: String = extends_what.substr(1, extends_what.length() - 2)
		if not parent_path.begins_with("res://"):
			parent_path = visited[visited.size() - 1].get_base_dir().path_join(parent_path)
		if not FileAccess.file_exists(parent_path):
			skipped.append({"path": path, "reason": "extends a script that does not exist: " + parent_path})
			return ""
		if parent_path in visited:
			skipped.append({"path": path, "reason": "extends itself through " + parent_path})
			return ""
		visited.append(parent_path)
		current = _header_of(parent_path)
		var parent_name: String = str(current.get("class_name", ""))
		if not parent_name.is_empty():
			return parent_name
	return ""


# The declarations at the top of a script: class_name, what it extends (a class name, or a
# quoted path), and the @tool, @abstract and @icon annotations. Reading stops at the first
# statement that is none of those, which is where the body begins.
func _header_of(path: String) -> Dictionary:
	var header: Dictionary = {}
	var file: FileAccess = FileAccess.open(path, FileAccess.READ)
	if not file:
		return header
	var annotation: RegEx = RegEx.new()
	annotation.compile('^@([a-z_]+)(?:\\(\\s*(?:"([^"]*)")?[^)]*\\))?\\s*')
	var class_line: RegEx = RegEx.new()
	class_line.compile("^class_name\\s+([A-Za-z_][A-Za-z0-9_]*)(?:\\s+extends\\s+(\\S+))?")
	var extends_line: RegEx = RegEx.new()
	extends_line.compile("^extends\\s+(\\S+)")
	while not file.eof_reached():
		var rest: String = file.get_line().strip_edges()
		# Annotations may share a line with what they annotate, as in `@abstract class_name X`.
		var annotated: RegExMatch = annotation.search(rest)
		while annotated != null:
			var name: String = annotated.get_string(1)
			if name == "tool":
				header["tool"] = true
			elif name == "abstract":
				header["abstract"] = true
			elif name == "icon":
				header["icon"] = annotated.get_string(2)
			rest = rest.substr(annotated.get_end())
			annotated = annotation.search(rest)
		if rest.is_empty() or rest.begins_with("#"):
			continue
		if rest.begins_with("class_name"):
			var declared: RegExMatch = class_line.search(rest)
			if declared != null:
				header["class_name"] = declared.get_string(1)
				if not declared.get_string(2).is_empty():
					header["extends"] = declared.get_string(2)
		elif rest.begins_with("extends"):
			var parent: RegExMatch = extends_line.search(rest)
			if parent != null:
				header["extends"] = parent.get_string(1)
		else:
			break
	file.close()
	return header


func _read_cache() -> Array:
	var config: ConfigFile = ConfigFile.new()
	if config.load(CACHE_PATH) != OK:
		return []
	var list: Variant = config.get_value("", "list", [])
	if list is Array:
		return list
	return []


func _entries_by_class(entries: Array) -> Dictionary:
	var by_class: Dictionary = {}
	for entry: Variant in entries:
		if entry is Dictionary:
			var fields: Dictionary = entry
			by_class[str(fields.get("class", ""))] = fields
	return by_class
