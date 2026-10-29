extends RefCounted

const GdhPatterns = preload("patterns.gd")
const GdhRead = preload("reading.gd")
const GdhFileWalk = preload("file_walk.gd")
const GdhLog = preload("logger.gd")
const GdhResourceFiles = preload("resource_files.gd")
## What a reverse search reads unless told otherwise: the resource and code files, and the settings
## files that name resources, "godot" for project.godot, "cfg" for plugin.cfg and
## export_presets.cfg, and "import" for the sidecars that name import scripts and external
## materials.
const PROJECT_FILE: String = "res://project.godot"
const DEFAULT_USAGE_KINDS: Array[String] = [
	"tscn", "tres", "gd", "gdshader", "gdshaderinc", "godot", "cfg", "import",
]
## The files written in the shader language, whose comments are // and /* */ rather than #, which in
## a shader starts a preprocessor directive.
const SHADER_KINDS: Array[String] = ["gdshader", "gdshaderinc"]
## One string literal of either quote, its contents captured by the one it opened with.
const STRING_LITERAL: String = "\"((?:[^\"\\\\]|\\\\.)*)\"|'((?:[^'\\\\]|\\\\.)*)'"
# What a dependency reference looks like in source, and how the path is read out of each form.
const REFERENCE_PATTERNS: Array[String] = [
	"res://[^\"'\\s\\]\\)]+",
	'preload\\("([^"]+)"\\)',
	'load\\("([^"]+)"\\)',
	'ext_resource.*path="([^"]+)"',
	# The shader preprocessor reads a relative include against the including file, and only the bare
	# res:// form was read, so a shader including its sibling depended on nothing.
	'#include\\s+"([^"]+)"',
]

var _log: GdhLog
var _files: GdhFileWalk = GdhFileWalk.new()
## The project's class names and the scripts declaring them, read the first time a script is walked
## and kept for the call: walking every resource starts a walk per root, and each reading every
## script again made the whole-project answer quadratic in the number of scripts.
var _classes_declared: Dictionary = {}
var _classes_read: bool = false
var _uids_declared: Dictionary = {}
var _uids_read: bool = false


func _init(p_log: GdhLog) -> void:
	_log = p_log


# Get dependencies for a resource with circular reference detection
func get_dependencies(params: Dictionary) -> Dictionary:
	var resource_path: String = str(params.get("resource_path", ""))
	# No depth, or a depth of zero or less, means the whole chain; the walk stops at cycles.
	var depth: int = GdhRead.as_int(params.get("depth", 0))
	var max_depth: int = depth if depth > 0 else 1000
	var include_built_in: bool = GdhRead.as_bool(params.get("include_builtin", false))

	if resource_path.is_empty():
		return _log.failure("resource_path is required")
	_log.info("Getting dependencies for: " + resource_path)

	var dependencies: Dictionary = {}
	var circular_references: Array = []
	var full_path: String = resource_path
	if not full_path.begins_with("res://"):
		full_path = "res://" + full_path
	if DirAccess.dir_exists_absolute(full_path):
		return _log.failure(_folder_refusal(full_path))
	if not FileAccess.file_exists(full_path):
		return _log.failure(
			_files.with_nearest_files("Resource file does not exist: " + full_path, full_path)
		)
	var walk: GdhDependencyWalk = GdhDependencyWalk.new(
		max_depth, include_built_in, circular_references
	)
	dependencies[full_path] = _analyze_resource(full_path, 0, walk)

	var references: int = 0
	var distinct: Dictionary = {}
	var missing: Dictionary = {}
	for key: String in dependencies:
		# Through a typed local: what comes out of a Dictionary is Variant, and a project that
		# errors on handing one to a typed parameter will not compile this script at all.
		var walked: Array[Dictionary] = dependencies[key]
		references += _count_recursive(walked)
		_gather_paths(walked, key, distinct)
		_gather_missing(walked, key, missing)
	# Said in the summary as well as in the tree, where a file that is not there was one
	# `exists: false` among the entries, which a caller reading the summary never met.
	var missing_files: Array[Dictionary] = []
	for path: String in missing:
		missing_files.append({ "path": path, "referenced_by": missing[path] })

	return {
		"dependencies": dependencies,
		"circular_references": circular_references,
		"summary":
		{
			# The file the walk starts from, which a call always names one of.
			"total_resources": 1,
			# The files depended on, each once. The tree names a file again under everything that
			# loads it, and counting its entries answered 11 for a scene with six dependencies.
			"total_dependencies": distinct.size(),
			"total_references": references,
			"circular_count": circular_references.size(),
			"missing": missing_files,
		},
	}


## Every file a scene or resource of the project loads through an ext_resource that is not there,
## by its path or its uid, and every one a script hands load() as written, each with the files
## loading it. Not any path a script names: one may be asking whether the file exists, and the
## shipped addons check for files they write, so every project was told its addons referred to
## files that are missing. A load() of a file the script also asks exists() about is left out for
## the same reason, and a script's preloads are the compile's to judge.
func missing_references() -> Array[Dictionary]:
	var missing: Dictionary = {}
	for file: String in _files.find_files("res://", ".gd"):
		for path: String in _loaded_and_missing(file):
			var naming: Array = missing.get_or_add(path, [])
			if not file in naming:
				naming.append(file)
	for file: String in _files.find_files_with_extensions(
		"res://", GdhResourceFiles.TEXT_RESOURCE_KINDS
	):
		var content: String = FileAccess.get_file_as_string(file)
		var moved: Dictionary = _moved_by_uid(content)
		for line: RegExMatch in GdhPatterns.compiled("\\[ext_resource[^\\]]*\\]").search_all(
			content
		):
			var at: RegExMatch = GdhPatterns.compiled('path="([^"]+)"').search(line.get_string())
			if at == null or moved.has(at.get_string(1)):
				continue
			var path: String = _resolved(at.get_string(1), file)
			if FileAccess.file_exists(path):
				continue
			var naming: Array = missing.get_or_add(path, [])
			if not file in naming:
				naming.append(file)
	for path: String in _named_by_settings():
		var naming: Array = missing.get_or_add(path, [])
		if not PROJECT_FILE in naming:
			naming.append(PROJECT_FILE)
	# Sorted, since the walk meets files in the order the filesystem lists them, which differs
	# between platforms.
	var paths: Array = missing.keys()
	paths.sort()
	var found: Array[Dictionary] = []
	for path: String in paths:
		var naming: Array = missing[path]
		naming.sort()
		found.append({ "path": path, "referenced_by": naming })
	return found


## The files [param script] loads with load() or ResourceLoader.load() by a path written in the call
## that are not on disk. A load called on another object, such as a ConfigFile's, reads a file that
## object's owner may write, so only the bare call and the ResourceLoader's count. A path the script
## names anywhere else, asking whether it exists, writing it or removing it, is one it looks after
## itself, and a `load(` inside a string is not a call: read across lines, one in a string literal
## took the rest of the file up to the next quote as a path.
func _loaded_and_missing(script: String) -> Array[String]:
	var loaded: Array[String] = []
	var named: Dictionary = {}
	for code: String in code_by_line(FileAccess.get_file_as_string(script)):
		if not code.contains("load("):
			for literal: String in _string_literals(code):
				named[_resolved(literal, script)] = true
			continue
		var calls: Dictionary = {}
		for loading: RegExMatch in (
			GdhPatterns
			. compiled("(?:(?<![\\w.])|ResourceLoader\\.)load\\(\\s*(?=[\"'])")
			. search_all(code)
		):
			calls[loading.get_end()] = true
		for literal: RegExMatch in GdhPatterns.compiled(STRING_LITERAL).search_all(code):
			var single: String = literal.get_string(2)
			var path: String = _resolved(
				literal.get_string(1) if single.is_empty() else single, script
			)
			if calls.has(literal.get_start()):
				loaded.append(path)
			else:
				named[path] = true
	var missing: Array[String] = []
	for path: String in loaded:
		# Left as written by the resolution, which is a uid the project does not know.
		if path.begins_with("uid://"):
			if not named.has(path) and not missing.has(path):
				missing.append(path)
			continue
		if (
			not path.begins_with("res://")
			or path.begins_with("res://.")
			or path.get_extension().is_empty()
		):
			continue
		if not named.has(path) and not FileAccess.file_exists(path) and not missing.has(path):
			missing.append(path)
	return missing


## The files project.godot's settings name that are not on disk: an autoload, a registered
## translation, an icon, an enabled plugin. Not the main scene, which has a check of its own, and
## the engine reports each of the rest on every boot.
static func _named_by_settings() -> Array[String]:
	var named: Array[String] = []
	for line: String in FileAccess.get_file_as_string(PROJECT_FILE).split("\n"):
		var held: String = line.strip_edges()
		if held.begins_with(";") or held.begins_with("run/main_scene="):
			continue
		for found: RegExMatch in GdhPatterns.compiled('"\\*?(res://[^"]+)"').search_all(held):
			var path: String = found.get_string(1)
			if FileAccess.file_exists(path) or DirAccess.dir_exists_absolute(path):
				continue
			named.append(path)
	return named


## The refusal for [param path], a folder: a walk follows one file, and a folder was refused as a
## file that does not exist, about a folder the caller could see.
static func _folder_refusal(path: String) -> String:
	return (
		"%s is a folder, and project_dependencies follows one file: name a file in it."
		% path.trim_suffix("/")
	)


## One line for [param entry], one of [method missing_references].
static func missing_line(entry: Dictionary) -> String:
	var referring: Array = entry.get("referenced_by", [])
	var naming: PackedStringArray = PackedStringArray(referring)
	return (
		"%s does not exist, and %s %s to it"
		% [
			str(entry.get("path", "")),
			", ".join(naming),
			"refers" if naming.size() == 1 else "refer",
		]
	)


# What refers to a resource, and how: the scenes that instance it, the scripts that extend or
# preload it, and for a script with a class_name, every use of that name.
func find_resource_usages(params: Dictionary) -> Dictionary:
	var resource_path: String = str(params.get("resource_path", ""))
	var file_types: Array = params.get("file_types", DEFAULT_USAGE_KINDS)

	if not resource_path.begins_with("res://"):
		resource_path = "res://" + resource_path
	if DirAccess.dir_exists_absolute(resource_path):
		return _log.failure(_folder_refusal(resource_path))
	# A file that is gone is searched for all the same, since what still refers to it is what a
	# caller asks about one, and the forward walk of a scene had just named it missing. Refused only
	# when nothing refers to it either, which is a path written wrong.
	var exists: bool = FileAccess.file_exists(resource_path)

	_log.info("Finding usages of: " + resource_path)

	var class_name_declared: String = _declared_class_name(resource_path)
	var by_class: RegEx = null
	if not class_name_declared.is_empty():
		by_class = GdhPatterns.compiled("\\b" + _regex_escaped(class_name_declared) + "\\b")
	# The script of an autoload is used wherever code names the autoload, and asked what uses it,
	# the answer was its line in project.godot alone, beside the scripts calling it.
	var autoload_named: String = ""
	var autoloads: Dictionary = autoloads_declared()
	for name: String in autoloads:
		if str(autoloads[name]) == resource_path:
			autoload_named = name
	var by_autoload: RegEx = null
	if not autoload_named.is_empty():
		by_autoload = GdhPatterns.compiled("\\b" + _regex_escaped(autoload_named) + "\\b")
	var target: Dictionary = {
		"path": resource_path,
		"uid": str(GdhResourceFiles.uid_of(resource_path).get("uid", "")) if exists else "",
	}

	var all_files: Array[String] = _usage_files(file_types)

	var usages: Array[Dictionary] = []
	var by_kind: Dictionary = {}
	var total: int = 0
	var in_code: int = 0

	for file_path: String in all_files:
		# Its own sidecar names it as the file it was imported from, which is not a use of it.
		if file_path == resource_path or file_path == resource_path + ".import":
			continue
		var file: FileAccess = FileAccess.open(file_path, FileAccess.READ)
		if not file:
			continue
		var text: String = file.get_as_text()
		file.close()
		var lines: PackedStringArray = text.split("\n")
		# A class is used by name only in a script's code. In a scene or a resource the same word is
		# a node's name or a caption, and each was counted as a use of the class; a shader has no
		# use for one at all.
		var code: bool = file_path.get_extension() == "gd"
		# In a shader # opens a directive, so an #include was answered as a comment, and its
		# comments are // and /* */.
		var shader_lines: PackedStringArray = []
		if file_path.get_extension() in SHADER_KINDS:
			shader_lines = _shader_code(text).split("\n")

		var references: Array[Dictionary] = []
		for i: int in range(lines.size()):
			var line: String = lines[i]
			var by_its_path: bool = _names_target(line, file_path, target)
			var by_its_name: bool = false
			var name_in_comment: bool = false
			if not by_its_path and code and by_class != null:
				# Strings are text, so a class named in one is not a use of it.
				by_its_name = by_class.search(_code_of(line)) != null
				name_in_comment = not by_its_name and by_class.search(_comment_of(line)) != null
			var by_its_autoload: bool = false
			if not by_its_path and not by_its_name and code and by_autoload != null:
				by_its_autoload = by_autoload.search(_code_of(line)) != null
				if not by_its_autoload and not name_in_comment:
					name_in_comment = by_autoload.search(_comment_of(line)) != null
			if not by_its_path and not by_its_name and not by_its_autoload and not name_in_comment:
				continue
			var trimmed: String = line.strip_edges()
			var kind: String = ""
			var extra: Dictionary = {}
			var loaded: String = (
				_loaded_by_uid(line) if trimmed.begins_with("[ext_resource") else ""
			)
			var written: RegExMatch = GdhPatterns.compiled('path="([^"]+)"').search(line)
			var written_path: String = (
				"" if written == null else _resolved(written.get_string(1), file_path)
			)
			# A mention in a comment is not a use, and both were answered as one. The question a
			# reverse walk is asked is whether anything still uses a class, and a project that
			# documents itself names its collaborators in `##` links: four references to one class,
			# three of them prose, all counted as code. The more carefully a project is documented
			# the worse that ratio gets. `##` and `#` are kept apart because renaming the class
			# breaks Godot's generated documentation and leaves the prose merely stale.
			if code and trimmed.begins_with("##"):
				kind = "doc"
			elif (code and trimmed.begins_with("#")) or name_in_comment:
				kind = "comment"
			elif (
				not shader_lines.is_empty()
				and not _names_target(shader_lines[i], file_path, target)
			):
				kind = "comment"
			elif by_its_path and not loaded.is_empty() and loaded != target["path"]:
				# The engine loads the file the uid names, so the path written here is used by
				# nothing.
				kind = "stale_path"
				extra["loads"] = loaded
			elif by_its_path:
				kind = _path_reference_kind(line, file_path)
				if not loaded.is_empty() and written_path != loaded:
					extra["stale_path"] = written_path
				var unknown_uid: String = (
					_unknown_uid_of(line) if trimmed.begins_with("[ext_resource") else ""
				)
				if not unknown_uid.is_empty():
					extra["unknown_uid"] = unknown_uid
			elif by_its_autoload:
				kind = "autoload"
			else:
				kind = (
					"extends"
					if GdhPatterns.without_annotations(line).begins_with("extends ")
					else "class_name"
				)
			var found: Dictionary = { "line": i + 1, "kind": kind, "text": trimmed }
			found.merge(extra)
			references.append(found)
			by_kind[kind] = GdhRead.as_int(by_kind.get(kind, 0)) + 1
			if not kind in ["doc", "comment", "stale_path"]:
				in_code += 1

		if not references.is_empty():
			usages.append({ "file": file_path, "references": references })
			total += references.size()

	if not exists and usages.is_empty():
		return _log.failure(
			_files.with_nearest_files(
				(
					"Resource file does not exist: %s, and nothing in the project refers to it"
					% resource_path
				),
				resource_path
			)
		)
	var declared: Variant = null
	if not class_name_declared.is_empty():
		declared = class_name_declared
	var answer: Dictionary = {
		"resource_path": resource_path,
		"exists": exists,
		"class_name": declared,
		"usages": usages,
		"summary":
		{
			"files_searched": all_files.size(),
			"files_with_usages": usages.size(),
			"total": total,
			# The arithmetic done here rather than left to the caller, because the caller who most
			# needs it is the one asking whether a class is dead, and that caller reads one number.
			"in_code": in_code,
			"by_kind": by_kind,
		},
	}
	if not autoload_named.is_empty():
		answer["autoload"] = autoload_named
	return answer


# The class_name a script declares, or empty for a scene, a resource or a script without one.
func _declared_class_name(path: String) -> String:
	if not path.ends_with(".gd"):
		return ""
	var file: FileAccess = FileAccess.open(path, FileAccess.READ)
	if not file:
		return ""
	while not file.eof_reached():
		# Annotations first, since `@abstract class_name X` is one line and this read it as none.
		var found: RegExMatch = GdhPatterns.declared_class(
			GdhPatterns.without_annotations(file.get_line())
		)
		if found != null:
			file.close()
			return found.get_string(1)
	file.close()
	return ""


# The files a reverse search reads, for the kinds asked for. The settings files are kinds of their
# own because what they name is used as surely as a preload is: an autoload script, the main scene
# and a plugin's script are named only in project.godot and plugin.cfg, and a search that left those
# out answered that each was used by nothing, which is the answer a caller deletes a file on.
func _usage_files(kinds: Array) -> Array[String]:
	var found: Array[String] = []
	for kind: Variant in kinds:
		# As project_search reads an extension: ".tscn" searched no file, and the answer said
		# nothing used a script its scene attaches.
		var named: String = str(kind).trim_prefix(".").to_lower()
		match named:
			"godot":
				found.append("res://project.godot")
			"cfg":
				found.append_array(_files.find_files("res://", "plugin.cfg"))
				if FileAccess.file_exists("res://export_presets.cfg"):
					found.append("res://export_presets.cfg")
			_:
				found.append_array(_files.find_files("res://", "." + named))
	return found


# Whether [param line], in [param file_path], names the target by path or by UID. Every string on
# the line is read as a path the way the engine reads it: a res:// path as it is, a uid:// by what
# it names, and anything else relative to the file it is in, which is how `preload("sibling.gd")`
# and a plugin.cfg's `script="plugin.gd"` name their files. Only the quoted form of the project path
# was looked for, so neither of those was found, and nor was a scene named by its UID.
func _names_target(line: String, file_path: String, target: Dictionary) -> bool:
	var path: String = target["path"]
	var uid: String = target["uid"]
	for quoted: String in _string_literals(line):
		# An autoload is written "*res://path" when its name is global.
		var literal: String = quoted.trim_prefix("*")
		if not uid.is_empty() and literal == uid:
			return true
		if literal.get_extension() != path.get_extension():
			continue
		var resolved: String = literal
		if not literal.begins_with("res://"):
			resolved = file_path.get_base_dir().path_join(literal).simplify_path()
		if resolved == path:
			return true
	return false


# The contents of each string literal on [param line], of either quote.
static func _string_literals(line: String) -> Array[String]:
	var literals: Array[String] = []
	for m: RegExMatch in GdhPatterns.compiled(STRING_LITERAL).search_all(line):
		literals.append(m.get_string(1) if not m.get_string(1).is_empty() else m.get_string(2))
	return literals


# [param line] with its strings emptied and its comment taken off: the part a class can be used in.
static func _code_of(line: String) -> String:
	var bare: String = GdhPatterns.compiled(STRING_LITERAL).sub(line, '""', true)
	var mark: int = bare.find("#")
	return bare if mark == -1 else bare.substr(0, mark)


# [param content] with each line's comment taken off and its strings kept, which is where the paths
# a script loads are written.
static func _code_lines(content: String) -> String:
	return "\n".join(code_by_line(content))


## Each line of [param content] as code: its comment off, and the text of a string running across
## lines left out. Read as code, a test suite template's example
## `load("res://folder/my_class.gd")` was a call of a file that does not exist, which made the
## project invalid.
static func code_by_line(content: String) -> Array[String]:
	var lines: Array[String] = []
	var in_string: bool = false
	for line: String in content.split("\n"):
		if in_string:
			if GdhPatterns.triple_quotes(line) % 2 == 1:
				in_string = false
			lines.append("")
			continue
		var code: String = GdhPatterns.without_comment(line)
		if GdhPatterns.triple_quotes(code) % 2 == 1:
			in_string = true
			var opened: int = code.find('"""')
			var apostrophes: int = code.find("'''")
			if opened < 0 or (apostrophes >= 0 and apostrophes < opened):
				opened = apostrophes
			code = code.substr(0, opened)
		lines.append(code)
	return lines


# The comment on [param line], strings emptied first so a # inside one does not start it.
static func _comment_of(line: String) -> String:
	var bare: String = GdhPatterns.compiled(STRING_LITERAL).sub(line, '""', true)
	var mark: int = bare.find("#")
	return "" if mark == -1 else bare.substr(mark)


# How a line that names the resource by path uses it.
func _path_reference_kind(line: String, file_path: String) -> String:
	var placed: String = _placed_kind(line, file_path)
	if not placed.is_empty():
		return placed
	var trimmed: String = GdhPatterns.without_annotations(line)
	if "preload(" in trimmed:
		return "preload"
	if "load(" in trimmed:
		return "load"
	return "path"


# The kind a reference on [param line] has by the file it is in or by how the line starts, or ""
# when neither says.
static func _placed_kind(line: String, file_path: String) -> String:
	match file_path.get_file():
		"project.godot":
			return "setting"
		"plugin.cfg":
			return "plugin"
		"export_presets.cfg":
			return "export_preset"
	if file_path.ends_with(".import"):
		return "import"
	var trimmed: String = GdhPatterns.without_annotations(line)
	if trimmed.begins_with("extends "):
		return "extends"
	if trimmed.begins_with("[ext_resource"):
		return "ext_resource"
	if trimmed.begins_with("#include"):
		return "include"
	return ""


# The kind of the reference [param found] is in [param content], read from [param path], by the
# call its path is handed to rather than by the line, which can name a second file another way: a
# path only written in a string, which nothing in the file may load, read as a load.
static func _forward_kind(content: String, found: RegExMatch, path: String) -> String:
	var matched: String = found.get_string()
	if matched.begins_with("preload("):
		return "preload"
	if matched.begins_with("load("):
		return "load"
	var start: int = found.get_start()
	var line_start: int = content.rfind("\n", start) + 1
	var line_end: int = content.find("\n", start)
	var line: String = content.substr(
		line_start, (content.length() if line_end == -1 else line_end) - line_start
	)
	var before: String = content.substr(line_start, start - line_start).rstrip("\"'")
	if before.ends_with("preload("):
		return "preload"
	if before.ends_with("load("):
		return "load"
	var placed: String = _placed_kind(line, path)
	return "path" if placed.is_empty() else placed


func _regex_escaped(text: String) -> String:
	var escaped: String = ""
	for character: String in text:
		if character in "\\^$.|?*+()[]{}/":
			escaped += "\\"
		escaped += character
	return escaped


# [param root] is left out: a cycle leads back to it, and it is not one of its own dependencies.
func _gather_paths(deps: Array[Dictionary], root: String, into: Dictionary) -> void:
	for dep: Dictionary in deps:
		var path: String = str(dep.get("path", ""))
		if path != root:
			into[path] = true
		if dep.has("dependencies"):
			var deeper: Array[Dictionary] = dep["dependencies"]
			_gather_paths(deeper, root, into)


# Each file in [param deps] that does not exist, into [param into] with the files naming it, once
# each however often the tree reaches them; [param parent] names the entries of [param deps].
func _gather_missing(deps: Array[Dictionary], parent: String, into: Dictionary) -> void:
	for dep: Dictionary in deps:
		var path: String = str(dep.get("path", ""))
		if not dep.get("exists", true):
			var naming: Array = into.get_or_add(path, [])
			if not parent in naming:
				naming.append(parent)
		if dep.has("dependencies"):
			var deeper: Array[Dictionary] = dep["dependencies"]
			_gather_missing(deeper, path, into)


func _count_recursive(deps: Array[Dictionary]) -> int:
	var count: int = 0
	for dep: Dictionary in deps:
		count += 1
		if dep.has("dependencies"):
			var deeper: Array[Dictionary] = dep["dependencies"]
			count += _count_recursive(deeper)
	return count


func _analyze_resource(
	path: String, current_depth: int, walk: GdhDependencyWalk
) -> Array[Dictionary]:
	var deps: Array[Dictionary] = []
	if current_depth >= walk.max_depth:
		return deps

	walk.path_stack.append(path)
	var cut: bool = false
	for named: Dictionary in _references(path, walk):
		var dep_info: Dictionary = named.duplicate()
		cut = _depend(dep_info, current_depth, walk) or cut
		deps.append(dep_info)
	walk.path_stack.pop_back()

	var remaining: int = walk.max_depth - current_depth
	var shown: Dictionary = walk.shown.get(path, {})
	if shown.is_empty() or remaining > GdhRead.as_int(shown["remaining"]):
		walk.shown[path] = { "remaining": remaining, "cut": cut }
	return deps


# Walks [param dep_info], one entry of what the file at [param current_depth] names, and answers
# whether the depth cut short what it shows. Its dependencies are listed at its first entry, which
# every later one says is above it: listed in full under every file loading it, a game of a
# hundred scripts typed by class_name answered half a megabyte at depth six and nothing at all
# unlimited, the tree growing about sixfold a level. A list the depth cut short is listed again
# where more depth is left, since pointing a nearer reach at it answered a chain that stopped
# where nothing stopped it. A list is recorded once walked, so what a later entry points at is
# always above it.
func _depend(dep_info: Dictionary, current_depth: int, walk: GdhDependencyWalk) -> bool:
	var dep_path: String = dep_info["path"]
	# Marked where the reference closing the cycle is. Marked inside the file reached again, the
	# tree answered that file as a dependency of itself.
	if dep_path in walk.path_stack:
		var cycle: Array[String] = walk.path_stack.slice(walk.path_stack.find(dep_path))
		# Kept by a key that is the same wherever the walk entered the cycle: compared as written,
		# one cycle met from two of its files was listed twice, and comparing each against every
		# cycle found so far grew with the square of their number, sixteen thousand on three
		# hundred scripts typed by each other's class names.
		var key: String = _cycle_key(cycle)
		if not walk.cycles_seen.has(key):
			walk.cycles_seen[key] = true
			cycle.append(dep_path)
			walk.circular_references.append(cycle)
		dep_info["circular"] = true
		return false
	if not dep_info["exists"]:
		return false
	var named: int = _references(dep_path, walk).size()
	if named == 0:
		return false
	if current_depth + 1 >= walk.max_depth:
		# A file the depth stopped at read the same as one naming nothing, and a missing file past
		# it went unsaid.
		dep_info["beyond_depth"] = named
		return true
	var shown: Dictionary = walk.shown.get(dep_path, {})
	if not shown.is_empty():
		var shown_cut: bool = shown["cut"]
		var remaining: int = walk.max_depth - current_depth - 1
		if not shown_cut or remaining <= GdhRead.as_int(shown["remaining"]):
			dep_info["dependencies_listed_above"] = true
			return shown_cut
	dep_info["dependencies"] = _analyze_resource(dep_path, current_depth + 1, walk)
	var walked: Dictionary = walk.shown[dep_path]
	return walked["cut"]


## [param cycle], the files of one cycle in the order the walk met them, turned to start at the
## first of them in sorting order, so the cycle met from any of its files keys the same.
static func _cycle_key(cycle: Array[String]) -> String:
	var first: int = 0
	for at: int in cycle.size():
		if cycle[at] < cycle[first]:
			first = at
	return "\n".join(PackedStringArray(cycle.slice(first) + cycle.slice(0, first)))


## What [param path] names, each file once, as the entries the tree lists it by; read once a walk.
func _references(path: String, walk: GdhDependencyWalk) -> Array[Dictionary]:
	if walk.references.has(path):
		var known: Array[Dictionary] = walk.references[path]
		return known
	var deps: Array[Dictionary] = []
	walk.references[path] = deps

	var file: FileAccess = FileAccess.open(path, FileAccess.READ)
	if file:
		var content: String = file.get_as_text()
		file.close()
		# A script's comments name paths as examples, and read as references they were answered as
		# dependencies, one of a file that does not exist: the shipped serialisation module's
		# comment about `["res://addons/x/plugin.cfg"]` was a dependency of every project with the
		# addon.
		if path.get_extension() == "gd":
			content = _code_lines(content)
		elif path.get_extension() in SHADER_KINDS:
			content = _shader_code(content)
		var moved: Dictionary = _moved_by_uid(content)
		var unknown: Dictionary = _unknown_uids(content, path)

		for pattern: String in REFERENCE_PATTERNS:
			var regex: RegEx = GdhPatterns.compiled(pattern)
			for m: RegExMatch in regex.search_all(content):
				var written: String = _resolved(_referenced_path(m.get_string()), path)
				var dep_path: String = str(moved.get(written, written))
				var kind: String = _forward_kind(content, m, path)

				# A uid the project does not know names no file, and loading it fails: passed over
				# as no res:// path, a script's load of one went unsaid while the game printed
				# "Unrecognized UID" at that line.
				if dep_path.begins_with("uid://"):
					_name(deps, path, dep_path, { "kind": kind })
					continue
				if not dep_path.begins_with("res://"):
					continue
				# A literal naming a directory, or the start of a path a script builds as it runs
				# ("res://levels/" + name), names no file, and walked as one it was a missing
				# dependency.
				if dep_path.get_extension().is_empty():
					continue

				# Skip engine-internal resources unless requested. `addons/` is not one of
				# them: it is ordinary project content, and often shipping content, so
				# treating it as built-in dropped every dependency of anything living there.
				if not walk.include_built_in and dep_path.begins_with("res://."):
					continue

				var named_by: Dictionary = { "kind": kind }
				if dep_path != written:
					named_by["stale_path"] = written
				if unknown.has(dep_path):
					named_by["unknown_uid"] = unknown[dep_path]
				_name(deps, path, dep_path, named_by)

		# A script uses another by its class_name as surely as by a preload, and only the reverse
		# walk looked for that: asked what a script depends on, the answer left out the script it
		# typed a variable with, while asking what used that script named this one. An autoload's
		# global name is the same kind of use, of the script registered under it.
		if path.get_extension() == "gd":
			var classes: Dictionary = classes_declared()
			for used: String in classes_used_in(content, classes):
				_name(deps, path, str(classes[used]), { "by_class": used })
			var autoloads: Dictionary = autoloads_declared()
			for used: String in classes_used_in(content, autoloads):
				_name(deps, path, str(autoloads[used]), { "by_autoload": used })
	return deps


# Adds [param dep_path] to [param deps], what [param path] depends on, once however many times it
# is named. [param named_by] is the class or autoload name it was named by, as by_class or
# by_autoload, or for a path its kind, with the path written when the engine loads another as
# stale_path.
func _name(deps: Array[Dictionary], path: String, dep_path: String, named_by: Dictionary) -> void:
	if dep_path == path:
		return
	for existing: Dictionary in deps:
		if existing.get("path", "") == dep_path:
			return
	# A uid still written as one is one the project does not know, and asked about, the engine
	# prints an error for it.
	var dep_info: Dictionary = {
		"path": dep_path,
		"exists": not dep_path.begins_with("uid://") and FileAccess.file_exists(dep_path),
	}
	dep_info.merge(named_by)
	deps.append(dep_info)


## Every autoload the project registers as a global name, with its script. One that is not global
## is no name code can use.
func autoloads_declared() -> Dictionary:
	var autoloads: Dictionary = {}
	for property: Dictionary in ProjectSettings.get_property_list():
		var setting: String = str(property.get("name", ""))
		if not setting.begins_with("autoload/"):
			continue
		var value: String = str(ProjectSettings.get_setting(setting))
		if value.begins_with("*"):
			autoloads[setting.trim_prefix("autoload/")] = _resolved(
				value.trim_prefix("*"), "res://project.godot"
			)
	return autoloads


## Every class_name the project's scripts declare, with the script declaring it.
func classes_declared() -> Dictionary:
	if _classes_read:
		return _classes_declared
	_classes_read = true
	for script: String in _files.find_files("res://", ".gd"):
		var declared: String = _declared_class_name(script)
		if not declared.is_empty():
			_classes_declared[declared] = script
	return _classes_declared


## Every class the project's scripts declare with class_name, sorted by name, with the script
## declaring it. Read from the files rather than the class cache, which only a scan rewrites.
func list_script_classes(_params: Dictionary) -> Dictionary:
	var declared: Dictionary = classes_declared()
	var names: Array = declared.keys()
	names.sort()
	var classes: Array[Dictionary] = []
	for name: Variant in names:
		classes.append({ "name": str(name), "path": str(declared[name]) })
	return { "classes": classes, "count": classes.size() }


## The names in [param classes] that the code in [param content] uses, in the order first used:
## words outside strings and comments, so a class named in prose or in a message is not a use of it.
static func classes_used_in(content: String, classes: Dictionary) -> Array[String]:
	var used: Array[String] = []
	if classes.is_empty():
		return used
	var word: RegEx = GdhPatterns.compiled("[A-Za-z_][A-Za-z0-9_]*")
	for line: String in content.split("\n"):
		for m: RegExMatch in word.search_all(_code_of(line)):
			var name: String = m.get_string()
			if classes.has(name) and not name in used:
				used.append(name)
	return used


# [param written] as the res:// path the engine would load from [param from]: a uid:// by the file
# it names, and a relative path against the referring file's directory. Both were passed over as not
# being res:// paths, so a script's `preload("sibling.gd")` was no dependency at all.
func _resolved(written: String, from: String) -> String:
	if written.begins_with("res://"):
		return written
	if written.begins_with("uid://"):
		var found: String = _uid_path(written)
		return written if found.is_empty() else found
	if written.contains("://"):
		return written
	return from.get_base_dir().path_join(written).simplify_path()


# The file the uid:// [param text] names, or empty when nothing does: the engine's uid cache first,
# then the uids the project's files declare. Only an import writes the cache, so on a fresh clone
# every uid was answered as naming no file, and a scene moved outside the editor was missing under
# its old path, although the first import loads it by its uid. A cached path with no file there
# gives way to a file declaring the uid, and is the answer when none does.
func _uid_path(text: String) -> String:
	var id: int = ResourceUID.text_to_id(text)
	if id == ResourceUID.INVALID_ID:
		return ""
	var cached: String = ResourceUID.get_id_path(id) if ResourceUID.has_id(id) else ""
	if FileAccess.file_exists(cached):
		return cached
	return str(_files_by_uid().get(id, cached))


# Every file of the project that declares a uid, by its uid's id: in a .uid sidecar, an import
# sidecar or the header of a text resource, as GdhResourceFiles reads them. Read once for the call,
# the first time the cache does not know a uid.
func _files_by_uid() -> Dictionary:
	if _uids_read:
		return _uids_declared
	_uids_read = true
	var declaring: Dictionary = {}
	for file: String in _files.find_files_with_extensions(
		"res://", ["uid", "import"] + GdhResourceFiles.TEXT_RESOURCE_KINDS
	):
		var sidecar: bool = file.get_extension() in ["uid", "import"]
		declaring[file.get_basename() if sidecar else file] = true
	for file: String in declaring:
		if not FileAccess.file_exists(file):
			continue
		var id: int = ResourceUID.text_to_id(str(GdhResourceFiles.uid_of(file).get("uid", "")))
		if id != ResourceUID.INVALID_ID:
			_uids_declared[id] = file
	return _uids_declared


# The ext_resource paths in [param content] whose uid leads elsewhere, each with the file the uid
# names. The engine loads an ext_resource by its uid whenever the uid is known, whatever the path
# says, so a file moved outside the editor still loads, and the walk called it missing; every
# pattern reads the old path, the bare res:// one included, so the paths are mapped before any of
# them runs.
func _moved_by_uid(content: String) -> Dictionary:
	var moved: Dictionary = {}
	for line: RegExMatch in GdhPatterns.compiled("\\[ext_resource[^\\]]*\\]").search_all(content):
		var found: String = _loaded_by_uid(line.get_string())
		var at: RegExMatch = GdhPatterns.compiled('path="([^"]+)"').search(line.get_string())
		if at != null and not found.is_empty() and found != at.get_string(1):
			moved[at.get_string(1)] = found
	return moved


# The ext_resource paths in [param content], read from [param from], whose uid names no file the
# project has, each with that uid. The engine warns that the uid is invalid and loads the path, and
# the walk followed the path saying nothing, so an export was the first to mention it.
func _unknown_uids(content: String, from: String) -> Dictionary:
	var unknown: Dictionary = {}
	for line: RegExMatch in GdhPatterns.compiled("\\[ext_resource[^\\]]*\\]").search_all(content):
		var uid: String = _unknown_uid_of(line.get_string())
		var at: RegExMatch = GdhPatterns.compiled('path="([^"]+)"').search(line.get_string())
		if at != null and not uid.is_empty():
			unknown[_resolved(at.get_string(1), from)] = uid
	return unknown


# The uid an ext_resource [param entry] carries when it names no file the project has, or empty.
func _unknown_uid_of(entry: String) -> String:
	var uid: RegExMatch = GdhPatterns.compiled('uid="(uid://[^"]+)"').search(entry)
	return "" if uid == null or not _loaded_by_uid(entry).is_empty() else uid.get_string(1)


# The file an ext_resource [param entry] is loaded from by its uid, or empty when it carries none
# the project knows, and the engine falls back to the path.
func _loaded_by_uid(entry: String) -> String:
	var uid: RegExMatch = GdhPatterns.compiled('uid="(uid://[^"]+)"').search(entry)
	if uid == null:
		return ""
	var found: String = _uid_path(uid.get_string(1))
	return found if FileAccess.file_exists(found) else ""


# [param content], a shader's code, with its // and /* */ comments emptied and its lines kept, so a
# path written in one is no include.
static func _shader_code(content: String) -> String:
	var kept: Array[String] = []
	var length: int = content.length()
	var copied: int = 0
	var at: int = 0
	while at < length:
		var pair: String = content.substr(at, 2)
		if content[at] == '"':
			# Stepped over whole, since an include's res:// holds the // that opens a comment.
			var close: int = content.find('"', at + 1)
			var line_end: int = content.find("\n", at + 1)
			var ends: int = close + 1 if close != -1 else length
			at = line_end if line_end != -1 and line_end < ends else ends
		elif pair == "//" or pair == "/*":
			kept.append(content.substr(copied, at - copied))
			var block: bool = pair == "/*"
			var close: int = content.find("*/" if block else "\n", at + 2)
			var resumes: int = length if close == -1 else (close + 2 if block else close)
			if block:
				kept.append("\n".repeat(content.substr(at, resumes - at).count("\n")))
			at = resumes
			copied = at
		else:
			at += 1
	kept.append(content.substr(copied))
	return "".join(PackedStringArray(kept))


# The path inside a preload(), load(), #include or ext_resource match; a bare res:// match is the
# path. An ext_resource is read first, since its type or its path can hold the word load.
func _referenced_path(matched: String) -> String:
	var expression: String = ""
	if matched.begins_with("ext_resource"):
		expression = 'path="([^"]+)"'
	elif "load" in matched or matched.begins_with("#include"):
		expression = '"([^"]+)"'
	else:
		return matched
	var inner: RegEx = GdhPatterns.compiled(expression)
	var inner_match: RegExMatch = inner.search(matched)
	return inner_match.get_string(1) if inner_match else matched


# Everything one dependency walk carries: the settings it was started with, and the state it
# accumulates as it recurses. Kept together so the recursion passes one object rather than
# six positional arguments that have to stay in the same order at every call site.
class GdhDependencyWalk:
	var max_depth: int

	var include_built_in: bool

	## What each file read names, by its path.
	var references: Dictionary = {}

	## For each file whose dependencies the tree lists, the depth left where they are listed and
	## whether the depth cut that list short.
	var shown: Dictionary = {}

	var path_stack: Array[String] = []

	var circular_references: Array

	## Each cycle in circular_references, by [method _cycle_key].
	var cycles_seen: Dictionary[String, bool] = {}

	func _init(p_max_depth: int, p_include_built_in: bool, p_circular_references: Array) -> void:
		max_depth = p_max_depth
		include_built_in = p_include_built_in
		circular_references = p_circular_references
