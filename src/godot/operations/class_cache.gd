extends RefCounted

# The editor keeps the list of global classes it knows in .godot/global_script_class_cache.cfg
# and refreshes it only on a filesystem scan, which it does not always do (godotengine/godot#42786).
# A game started from a stale editor then cannot resolve any class_name written since, and the
# engine reads the same file headless, so the list is rebuilt here from the scripts themselves.

const GdhPatterns = preload("patterns.gd")
const GdhRead = preload("reading.gd")
const GdhFileWalk = preload("file_walk.gd")
const GdhLog = preload("logger.gd")
const CACHE_PATH: String = "res://.godot/global_script_class_cache.cfg"

var _log: GdhLog
var _files: GdhFileWalk = GdhFileWalk.new()


func _init(p_log: GdhLog) -> void:
	_log = p_log


func refresh_class_cache(_params: Dictionary) -> Dictionary:
	var read: Variant = read_list()
	var cached: Array = []
	if read is Array:
		cached = read
	var before: Dictionary = _entries_by_class(cached)

	var skipped: Array[Dictionary] = []
	var declarers: Dictionary = {}
	for path: String in _files.find_files("res://", ".gd", true):
		var entry: Dictionary = _entry_for(path, skipped)
		if not entry.is_empty():
			_add_declarer(declarers, entry)
	# Another language's classes are kept while their files are there. Only GDScript is read here
	# and the list is written whole, so a C# project's global classes were dropped from it and
	# answered as removed, and nothing started next could resolve them.
	for entry: Variant in cached:
		if not entry is Dictionary:
			continue
		var listed: Dictionary = entry
		if _is_carried(listed):
			_add_declarer(declarers, listed)
	var carried: Array[String] = []
	var twice_declared: Array[Dictionary] = []
	var entries: Array = _kept_entries(declarers, before, carried, twice_declared)
	# By name as text: StringName's own order is by identity, not by spelling.
	entries.sort_custom(
		func(a: Dictionary, b: Dictionary) -> bool: return str(a["class"]) < str(b["class"])
	)

	var after: Dictionary = _entries_by_class(entries)
	var config: ConfigFile = ConfigFile.new()
	config.set_value("", "list", entries)
	var made: Error = DirAccess.make_dir_recursive_absolute(
		ProjectSettings.globalize_path(CACHE_PATH.get_base_dir())
	)
	if made != OK and made != ERR_ALREADY_EXISTS:
		return _log.failure(
			"Could not make " + CACHE_PATH.get_base_dir() + ": " + error_string(made)
		)
	var err: Error = config.save(CACHE_PATH)
	if err != OK:
		return _log.failure("Failed to write " + CACHE_PATH + ": " + error_string(err))

	var differences: Dictionary = _differences(before, after)
	var answer: Dictionary = {
		"path": CACHE_PATH,
		"classes": entries.size(),
		"added": differences["added"],
		"removed": differences["removed"],
		"changed": differences["changed"],
		"skipped": skipped,
	}
	if not carried.is_empty():
		answer["carried"] = carried
	# A list the engine could not read gave it none of its classes, so each is answered added.
	if read == null:
		answer["unreadableList"] = true
	# The engine refuses each of these scripts but the one kept, with "Class hides a global script
	# class" (modules/gdscript/gdscript_analyzer.cpp).
	if not twice_declared.is_empty():
		answer["twiceDeclared"] = twice_declared
	return answer


# The classes [param after] gained, lost and holds otherwise than [param before], by name.
static func _differences(before: Dictionary, after: Dictionary) -> Dictionary:
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
	return { "added": added, "removed": removed, "changed": changed }


static func _add_declarer(declarers: Dictionary, entry: Dictionary) -> void:
	var name: String = str(entry.get("class", ""))
	if not declarers.has(name):
		declarers[name] = []
	var all: Array = declarers[name]
	all.append(entry)


static func _is_gdscript(entry: Dictionary) -> bool:
	return str(entry.get("language", "GDScript")) == "GDScript"


# Another language's entry is carried while its file is there, and a C# one only at a .cs file. The
# extension of a language a GDExtension adds is not known here, so its entry is taken at any file.
static func _is_carried(entry: Dictionary) -> bool:
	var path: String = str(entry.get("path", ""))
	var language: String = str(entry.get("language", "GDScript"))
	if language == "GDScript" or (language == "C#" and path.get_extension() != "cs"):
		return false
	return FileAccess.file_exists(path)


# One entry per name, the declarer that holds it, naming in [param carried] each kept from another
# language and in [param twice_declared] each name more than one script declares.
static func _kept_entries(
	declarers: Dictionary,
	before: Dictionary,
	carried: Array[String],
	twice_declared: Array[Dictionary]
) -> Array:
	var entries: Array = []
	for name: String in declarers:
		var all: Array = declarers[name]
		all.sort_custom(_scans_before)
		var cached: Dictionary = before.get(name, {})
		var kept: Dictionary = _kept_of(all, str(cached.get("path", "")))
		entries.append(kept)
		if not _is_gdscript(kept):
			carried.append(name)
		if all.size() > 1:
			twice_declared.append(_twice_declared(name, all, str(kept["path"])))
	return entries


# A class more than one script declares, which is an error in the project, not a list to repair:
# the engine fails every declarer but the one it holds with "Class hides a global script class"
# (modules/gdscript/gdscript_analyzer.cpp), and which one it holds can change from one editor
# start to the next (editor/file_system/editor_file_system.cpp, _process_file_system).
static func _twice_declared(name: String, all: Array, kept: String) -> Dictionary:
	var scripts: Array[String] = []
	for one: Dictionary in all:
		scripts.append(str(one["path"]))
	var listed: String = ", ".join(scripts.slice(0, -1)) + " and " + str(scripts.back())
	var note: String = (
		(
			'%s is declared by %s. Godot fails all but one of them with "Class "%s" hides a global'
			+ ' script class". The list keeps %s, and the editor may keep another at its next'
			+ " start. Rename the class in all but one script."
		)
		% [name, listed, name, kept]
	)
	return { "class": name, "scripts": scripts, "kept": kept, "note": note }


# Which of a name's declarers, in the scan's order, the list keeps: the one it holds while that
# still declares the name, so a rebuild does not move it, and otherwise the last, as a first scan
# registers them in turn and each registration replaces the path (_first_scan_process_scripts,
# ScriptServer::add_global_class).
static func _kept_of(all: Array, held: String) -> Dictionary:
	for one: Dictionary in all:
		if str(one["path"]) == held:
			return one
	var last: Dictionary = all.back()
	return last


# Whether the scan reaches [param a] before [param b]: a folder's subfolders before its own files,
# each sorted with the engine's FileNoCaseComparator (editor_file_system.cpp, _scan_new_dir), which
# is String.filenocasecmp_to. find_files lists by code point, as DirAccess sorts.
static func _scans_before(a: Dictionary, b: Dictionary) -> bool:
	var left: PackedStringArray = str(a["path"]).trim_prefix("res://").split("/")
	var right: PackedStringArray = str(b["path"]).trim_prefix("res://").split("/")
	var at: int = 0
	while at < left.size() - 1 and at < right.size() - 1 and left[at] == right[at]:
		at += 1
	var left_is_folder: bool = at < left.size() - 1
	if left_is_folder != (at < right.size() - 1):
		return left_is_folder
	return left[at].filenocasecmp_to(right[at]) < 0


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

	var base: Variant = _base_of(path, header, skipped)
	if base == null:
		return {}

	# The field order is the editor's, so a rebuilt file reads as one the editor wrote.
	return {
		"base": StringName(str(base)),
		"class": StringName(declared),
		"icon": str(header.get("icon", "")),
		"is_abstract": GdhRead.as_bool(header.get("abstract", false)),
		"is_tool": GdhRead.as_bool(header.get("tool", false)),
		"language": StringName("GDScript"),
		"path": path,
	}


# What the editor records as the base, worked out as the engine's own class scan works it out,
# measured on 4.7.2 against `--import`, so a rebuilt list is the one the editor would write and a
# rebuild over a current list changes nothing:
#
# - nothing extended: RefCounted;
# - one name, a global class or a native one: that name, unresolved;
# - a dotted name, `Outer.Inner`, an inner class of a global class: nothing, as the scan does not
#   look names up;
# - a path: what that script's class records, after walking into the inner classes named after
#   the path, `"res://outer.gd".Inner`, so a parent with a class_name is passed over for its own
#   base. A path the engine cannot open records nothing, and it opens a relative one from the
#   project root rather than from the script's folder.
#
# Null for a script that extends itself, which is left out of the list and named in [param skipped].
func _base_of(path: String, header: Dictionary, skipped: Array[Dictionary]) -> Variant:
	var visited: Array[String] = [path + ":"]
	var extends_what: Variant = header.get("extends", null)
	while true:
		if extends_what == null:
			return "RefCounted"
		var parts: Dictionary = _extends_parts(str(extends_what))
		var parent_path: String = parts["path"]
		var names: Array[String] = parts["names"]
		if parent_path.is_empty():
			return names[0] if names.size() == 1 else ""
		var opened: String = _as_the_engine_opens(parent_path)
		if not FileAccess.file_exists(opened):
			return ""
		var reached: String = opened + ":" + ".".join(PackedStringArray(names))
		if reached in visited:
			skipped.append({ "path": path, "reason": "extends itself through " + parent_path })
			return null
		visited.append(reached)
		var lines: PackedStringArray = FileAccess.get_file_as_string(opened).split("\n")
		if names.is_empty():
			extends_what = _header_in(lines).get("extends", null)
			continue
		var inner: Dictionary = _inner_class(lines, names)
		if inner.is_empty():
			return ""
		extends_what = inner.get("extends", null)
	return ""


# The path and the class names an `extends` names, from the text after the keyword:
# `"res://outer.gd".Inner` is the path and ["Inner"], `Outer.Inner` no path and two names. The
# reading stops at whatever follows, a colon or a comment.
static func _extends_parts(text: String) -> Dictionary:
	var rest: String = text.strip_edges()
	var path: String = ""
	if rest.begins_with('"') or rest.begins_with("'"):
		var closing: int = rest.find(rest[0], 1)
		if closing == -1:
			return { "path": "", "names": [] as Array[String] }
		path = rest.substr(1, closing - 1)
		rest = rest.substr(closing + 1)
	var names: Array[String] = []
	var name_at: RegEx = GdhPatterns.compiled("^([A-Za-z_][A-Za-z0-9_]*)")
	var dotted: bool = not path.is_empty()
	while true:
		if dotted:
			if not rest.begins_with("."):
				break
			rest = rest.substr(1)
		dotted = true
		var found: RegExMatch = name_at.search(rest)
		if found == null:
			break
		names.append(found.get_string(1))
		rest = rest.substr(found.get_end())
	return { "path": path, "names": names }


# The file the engine's class scan reads for an `extends` path. It opens the path as written, and
# the engine runs from the project root, so a relative path is read from there.
static func _as_the_engine_opens(path: String) -> String:
	if path.is_absolute_path():
		return path
	var absolute: String = ProjectSettings.globalize_path("res://").path_join(path).simplify_path()
	return ProjectSettings.localize_path(absolute)


# The inner class [param names] reaches in a script of [param lines], one class inside the
# previous, as {"found": true, "extends": the text after its keyword} with no "extends" for one that
# extends nothing, or {} when one of them is not there.
func _inner_class(lines: PackedStringArray, names: Array[String]) -> Dictionary:
	var class_line: RegEx = GdhPatterns.compiled("^class\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*(.*)$")
	var inline_extends: RegEx = GdhPatterns.compiled("^extends\\s+(.*)$")
	var start: int = 0
	var end: int = lines.size()
	var depth: int = 0
	var found: Dictionary = {}
	for name: String in names:
		var at: int = -1
		found = { "found": true }
		for index: int in range(start, end):
			var text: String = lines[index].strip_edges()
			if text.is_empty() or text.begins_with("#") or _indent(lines[index]) != depth:
				continue
			var declared: RegExMatch = class_line.search(text)
			if declared == null or declared.get_string(1) != name:
				continue
			at = index
			var inline: RegExMatch = inline_extends.search(declared.get_string(2).strip_edges())
			if inline != null:
				found["extends"] = inline.get_string(1)
			break
		if at == -1:
			return {}
		start = at + 1
		var body_end: int = start
		var body_depth: int = -1
		for index: int in range(start, end):
			var text: String = lines[index].strip_edges()
			if not text.is_empty() and not text.begins_with("#"):
				var width: int = _indent(lines[index])
				if width <= depth:
					break
				if body_depth == -1:
					body_depth = width
			body_end = index + 1
		end = body_end
		depth = body_depth
		if not found.has("extends"):
			var body: Dictionary = _header_in(lines.slice(start, end))
			if body.has("extends"):
				found["extends"] = body["extends"]
	return found


static func _indent(line: String) -> int:
	return line.length() - line.lstrip(" \t").length()


func _header_of(path: String) -> Dictionary:
	if not FileAccess.file_exists(path):
		return {}
	return _header_in(FileAccess.get_file_as_string(path).split("\n"))


# The declarations at the top of a script: class_name, what it extends (the text after the
# keyword, a class name or a quoted path, either followed by inner class names), and the @tool,
# @abstract and @icon annotations. Reading stops at the first statement that is none of those,
# which is where the body begins.
func _header_in(lines: PackedStringArray) -> Dictionary:
	var header: Dictionary = {}
	var annotation: RegEx = GdhPatterns.compiled(
		'^@([a-z_]+)(?:\\(\\s*(?:"([^"]*)")?[^)]*\\))?\\s*'
	)
	var extends_line: RegEx = GdhPatterns.compiled("^extends\\s+(.*)$")
	var same_line: RegEx = GdhPatterns.compiled("^\\s+extends\\s+(.*)$")
	for line: String in lines:
		var rest: String = line.strip_edges()
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
			var declared: RegExMatch = GdhPatterns.declared_class(rest)
			if declared != null:
				header["class_name"] = declared.get_string(1)
				var after: RegExMatch = same_line.search(rest.substr(declared.get_end(1)))
				if after != null:
					header["extends"] = after.get_string(1)
		elif rest.begins_with("extends"):
			var parent: RegExMatch = extends_line.search(rest)
			if parent != null:
				header["extends"] = parent.get_string(1)
		else:
			break
	return header


# Whether the engine started with no class from a list file that holds something.
static func list_unreadable() -> bool:
	return read_list() == null


# The list's entries, or null for a file the engine starts with no class from though it holds
# something. ProjectSettings::get_global_class_list reads the top-level `list` key once the file
# loads, so a file cut short or edited by hand gives none, and so does one that loads with no such
# key: a byte order mark or a stray word joins the key's name, and a [section] header above it
# moves it out of the top level.
static func read_list() -> Variant:
	if not FileAccess.file_exists(CACHE_PATH):
		return []
	var config: ConfigFile = ConfigFile.new()
	if config.load(CACHE_PATH) != OK:
		return null
	if not config.has_section_key("", "list"):
		if FileAccess.get_file_as_string(CACHE_PATH).strip_edges().is_empty():
			return []
		return null
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
