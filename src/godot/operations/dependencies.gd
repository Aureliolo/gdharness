extends RefCounted

const Patterns = preload("patterns.gd")
const Read = preload("reading.gd")
const FileWalk = preload("file_walk.gd")
const Log = preload("logger.gd")
const ResourceFiles = preload("resource_files.gd")

## What a reverse search reads unless told otherwise: the resource and code files, and the settings
## files that name resources, "godot" for project.godot, "cfg" for plugin.cfg and export_presets.cfg,
## and "import" for the sidecars that name import scripts and external materials.
const DEFAULT_USAGE_KINDS: Array[String] = ["tscn", "tres", "gd", "gdshader", "godot", "cfg", "import"]
## One string literal of either quote, its contents captured by the one it opened with.
const STRING_LITERAL: String = "\"((?:[^\"\\\\]|\\\\.)*)\"|'((?:[^'\\\\]|\\\\.)*)'"

# What a dependency reference looks like in source, and how the path is read out of each form.
const REFERENCE_PATTERNS: Array[String] = [
	"res://[^\"'\\s\\]\\)]+",
	'preload\\("([^"]+)"\\)',
	'load\\("([^"]+)"\\)',
	'ext_resource.*path="([^"]+)"',
]

var _log: Log
var _files: FileWalk = FileWalk.new()


# Everything one dependency walk carries: the settings it was started with, and the state it
# accumulates as it recurses. Kept together so the recursion passes one object rather than
# six positional arguments that have to stay in the same order at every call site.
class DependencyWalk:
	var max_depth: int
	var include_built_in: bool
	var visited: Dictionary = {}
	var path_stack: Array[String] = []
	var circular_references: Array

	func _init(p_max_depth: int, p_include_built_in: bool, p_circular_references: Array) -> void:
		max_depth = p_max_depth
		include_built_in = p_include_built_in
		circular_references = p_circular_references


func _init(p_log: Log) -> void:
	_log = p_log


# Get dependencies for a resource with circular reference detection
func get_dependencies(params: Dictionary) -> Dictionary:
	var resource_path: String = str(params.get("resource_path", ""))
	# No depth, or a depth of zero or less, means the whole chain; the walk stops at cycles.
	var depth: int = Read.as_int(params.get("depth", 0))
	var max_depth: int = depth if depth > 0 else 1000
	var include_built_in: bool = Read.as_bool(params.get("include_builtin", false))

	_log.info(
		(
			"Getting dependencies"
			+ (" for: " + resource_path if not resource_path.is_empty() else " for all resources")
		)
	)

	var dependencies: Dictionary = {}
	var circular_references: Array = []
	var total_resources: int = 0

	if not resource_path.is_empty():
		var full_path: String = resource_path
		if not full_path.begins_with("res://"):
			full_path = "res://" + full_path

		if not FileAccess.file_exists(full_path):
			return _log.failure("Resource file does not exist: " + full_path)

		var walk: DependencyWalk = DependencyWalk.new(max_depth, include_built_in, circular_references)
		dependencies[full_path] = _analyze_resource(full_path, 0, walk)
		total_resources = 1
	else:
		var resource_extensions: Array[String] = ["tscn", "tres", "gd", "gdshader", "shader"]
		var all_resources: Array[String] = []
		for ext: String in resource_extensions:
			all_resources.append_array(_files.find_files("res://", "." + ext))

		# Each root gets a fresh walk so a cycle is reported from every resource it passes
		# through, rather than only from whichever one happened to be walked first.
		for res_path: String in all_resources:
			var walk: DependencyWalk = DependencyWalk.new(max_depth, include_built_in, circular_references)
			var deps: Array[Dictionary] = _analyze_resource(res_path, 0, walk)
			if deps.size() > 0:
				dependencies[res_path] = deps

		total_resources = all_resources.size()

	var dep_count: int = 0
	for key: String in dependencies:
		# Through a typed local: what comes out of a Dictionary is Variant, and a project that
		# errors on handing one to a typed parameter will not compile this script at all.
		var walked: Array[Dictionary] = dependencies[key]
		dep_count += _count_recursive(walked)

	return {
		"dependencies": dependencies,
		"circular_references": circular_references,
		"summary":
		{
			"total_resources": total_resources,
			"total_dependencies": dep_count,
			"circular_count": circular_references.size()
		}
	}


# What refers to a resource, and how: the scenes that instance it, the scripts that extend or
# preload it, and for a script with a class_name, every use of that name.
func find_resource_usages(params: Dictionary) -> Dictionary:
	var resource_path: String = str(params.get("resource_path", ""))
	var file_types: Array = params.get("file_types", DEFAULT_USAGE_KINDS)

	if not resource_path.begins_with("res://"):
		resource_path = "res://" + resource_path
	if not FileAccess.file_exists(resource_path):
		return _log.failure("Resource file does not exist: " + resource_path)

	_log.info("Finding usages of: " + resource_path)

	var class_name_declared: String = _declared_class_name(resource_path)
	var by_class: RegEx = null
	if not class_name_declared.is_empty():
		by_class = Patterns.compiled("\\b" + _regex_escaped(class_name_declared) + "\\b")
	var target: Dictionary = {
		"path": resource_path, "uid": str(ResourceFiles.uid_of(resource_path).get("uid", ""))
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
		var lines: PackedStringArray = file.get_as_text().split("\n")
		file.close()
		# A class is used by name only in code. In a scene or a resource the same word is a node's
		# name or a caption, and each was counted as a use of the class.
		var code: bool = file_path.get_extension() in ["gd", "gdshader"]

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
			if not by_its_path and not by_its_name and not name_in_comment:
				continue
			var trimmed: String = line.strip_edges()
			var kind: String = ""
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
			elif by_its_path:
				kind = _path_reference_kind(line, file_path)
			else:
				kind = (
					"extends" if Patterns.without_annotations(line).begins_with("extends ") else "class_name"
				)
			references.append({"line": i + 1, "kind": kind, "text": trimmed})
			by_kind[kind] = Read.as_int(by_kind.get(kind, 0)) + 1
			if kind != "doc" and kind != "comment":
				in_code += 1

		if not references.is_empty():
			usages.append({"file": file_path, "references": references})
			total += references.size()

	var declared: Variant = null
	if not class_name_declared.is_empty():
		declared = class_name_declared
	return {
		"resource_path": resource_path,
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


# The class_name a script declares, or empty for a scene, a resource or a script without one.
func _declared_class_name(path: String) -> String:
	if not path.ends_with(".gd"):
		return ""
	var file: FileAccess = FileAccess.open(path, FileAccess.READ)
	if not file:
		return ""
	while not file.eof_reached():
		# Annotations first, since `@abstract class_name X` is one line and this read it as none.
		var found: RegExMatch = Patterns.declared_class(Patterns.without_annotations(file.get_line()))
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
		match str(kind):
			"godot":
				found.append("res://project.godot")
			"cfg":
				found.append_array(_files.find_files("res://", "plugin.cfg"))
				if FileAccess.file_exists("res://export_presets.cfg"):
					found.append("res://export_presets.cfg")
			_:
				found.append_array(_files.find_files("res://", "." + str(kind)))
	return found


# Whether [param line], in [param file_path], names the target by path or by UID. Every string on the
# line is read as a path the way the engine reads it: a res:// path as it is, a uid:// by what it
# names, and anything else relative to the file it is in, which is how `preload("sibling.gd")` and a
# plugin.cfg's `script="plugin.gd"` name their files. Only the quoted form of the project path was
# looked for, so neither of those was found, and nor was a scene named by its UID.
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
	for m: RegExMatch in Patterns.compiled(STRING_LITERAL).search_all(line):
		literals.append(m.get_string(1) if not m.get_string(1).is_empty() else m.get_string(2))
	return literals


# [param line] with its strings emptied and its comment taken off: the part a class can be used in.
static func _code_of(line: String) -> String:
	var bare: String = Patterns.compiled(STRING_LITERAL).sub(line, '""', true)
	var mark: int = bare.find("#")
	return bare if mark == -1 else bare.substr(0, mark)


# The comment on [param line], strings emptied first so a # inside one does not start it.
static func _comment_of(line: String) -> String:
	var bare: String = Patterns.compiled(STRING_LITERAL).sub(line, '""', true)
	var mark: int = bare.find("#")
	return "" if mark == -1 else bare.substr(mark)


# How a line that names the resource by path uses it.
func _path_reference_kind(line: String, file_path: String) -> String:
	match file_path.get_file():
		"project.godot":
			return "project_setting"
		"plugin.cfg":
			return "plugin"
		"export_presets.cfg":
			return "export_preset"
	if file_path.ends_with(".import"):
		return "import"
	var trimmed: String = Patterns.without_annotations(line)
	if trimmed.begins_with("extends "):
		return "extends"
	if trimmed.begins_with("[ext_resource"):
		return "ext_resource"
	if "preload(" in trimmed:
		return "preload"
	if "load(" in trimmed:
		return "load"
	return "path"


func _regex_escaped(text: String) -> String:
	var escaped: String = ""
	for character: String in text:
		if character in "\\^$.|?*+()[]{}/":
			escaped += "\\"
		escaped += character
	return escaped


func _count_recursive(deps: Array[Dictionary]) -> int:
	var count: int = deps.size()
	for dep: Dictionary in deps:
		if dep.has("dependencies"):
			var deeper: Array[Dictionary] = dep["dependencies"]
			count += _count_recursive(deeper)
	return count


func _analyze_resource(path: String, current_depth: int, walk: DependencyWalk) -> Array[Dictionary]:
	var deps: Array[Dictionary] = []

	if current_depth >= walk.max_depth:
		return deps

	if path in walk.path_stack:
		var cycle: Array[String] = walk.path_stack.slice(walk.path_stack.find(path))
		cycle.append(path)
		if not cycle in walk.circular_references:
			walk.circular_references.append(cycle)
		return [{"path": path, "circular": true}]

	# Reused only when it was walked with as much depth left as now. A resource first reached deep in
	# the walk has a list cut short at the limit, and handing that to a nearer reach answered with a
	# chain that stopped where nothing stopped it.
	var remaining: int = walk.max_depth - current_depth
	if walk.visited.has(path):
		var cached: Dictionary = walk.visited[path]
		if Read.as_int(cached["remaining"]) == remaining:
			var cached_deps: Array[Dictionary] = cached["deps"]
			return cached_deps

	walk.path_stack.append(path)

	var file: FileAccess = FileAccess.open(path, FileAccess.READ)
	if file:
		var content: String = file.get_as_text()
		file.close()

		for pattern: String in REFERENCE_PATTERNS:
			var regex: RegEx = Patterns.compiled(pattern)
			for m: RegExMatch in regex.search_all(content):
				var dep_path: String = _resolved(_referenced_path(m.get_string()), path)

				if not dep_path.begins_with("res://"):
					continue

				# Skip engine-internal resources unless requested. `addons/` is not one of
				# them: it is ordinary project content, and often shipping content, so
				# treating it as built-in dropped every dependency of anything living there.
				if not walk.include_built_in and dep_path.begins_with("res://."):
					continue

				if dep_path == path:
					continue

				var dep_info: Dictionary = {"path": dep_path, "exists": FileAccess.file_exists(dep_path)}

				if dep_info["exists"] and current_depth + 1 < walk.max_depth:
					var sub_deps: Array[Dictionary] = _analyze_resource(dep_path, current_depth + 1, walk)
					if sub_deps.size() > 0:
						dep_info["dependencies"] = sub_deps

				var already_added: bool = false
				for existing: Dictionary in deps:
					if existing.get("path", "") == dep_path:
						already_added = true
						break
				if not already_added:
					deps.append(dep_info)

	walk.path_stack.pop_back()
	walk.visited[path] = {"deps": deps, "remaining": remaining}
	return deps


# [param written] as the res:// path the engine would load from [param from]: a uid:// by what the
# project's uid cache says it names, and a relative path against the referring file's directory.
# Both were passed over as not being res:// paths, so a script's `preload("sibling.gd")` was no
# dependency at all.
static func _resolved(written: String, from: String) -> String:
	if written.begins_with("res://"):
		return written
	if written.begins_with("uid://"):
		var id: int = ResourceUID.text_to_id(written)
		return ResourceUID.get_id_path(id) if ResourceUID.has_id(id) else written
	if written.contains("://"):
		return written
	return from.get_base_dir().path_join(written).simplify_path()


# The path inside a preload(), load() or ext_resource match; a bare res:// match is the path.
func _referenced_path(matched: String) -> String:
	var expression: String = ""
	if "preload" in matched or "load" in matched:
		expression = '"([^"]+)"'
	elif "ext_resource" in matched:
		expression = 'path="([^"]+)"'
	else:
		return matched
	var inner: RegEx = Patterns.compiled(expression)
	var inner_match: RegExMatch = inner.search(matched)
	return inner_match.get_string(1) if inner_match else matched
