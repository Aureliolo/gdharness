extends RefCounted

const Patterns = preload("patterns.gd")
const Read = preload("reading.gd")
const FileWalk = preload("file_walk.gd")
const Log = preload("logger.gd")

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
	var file_types: Array = params.get("file_types", ["tscn", "tres", "gd", "gdshader"])

	if not resource_path.begins_with("res://"):
		resource_path = "res://" + resource_path
	if not FileAccess.file_exists(resource_path):
		return _log.failure("Resource file does not exist: " + resource_path)

	_log.info("Finding usages of: " + resource_path)

	var class_name_declared: String = _declared_class_name(resource_path)
	var by_path: RegEx = Patterns.compiled('"(res://)?' + _regex_escaped(resource_path.substr(6)) + '"')
	var by_class: RegEx = null
	if not class_name_declared.is_empty():
		by_class = Patterns.compiled("\\b" + _regex_escaped(class_name_declared) + "\\b")

	var all_files: Array[String] = []
	for ext: Variant in file_types:
		all_files.append_array(_files.find_files("res://", "." + str(ext)))

	var usages: Array[Dictionary] = []
	var by_kind: Dictionary = {}
	var total: int = 0

	for file_path: String in all_files:
		if file_path == resource_path:
			continue
		var file: FileAccess = FileAccess.open(file_path, FileAccess.READ)
		if not file:
			continue
		var lines: PackedStringArray = file.get_as_text().split("\n")
		file.close()

		var references: Array[Dictionary] = []
		for i: int in range(lines.size()):
			var line: String = lines[i]
			var kind: String = ""
			if by_path.search(line) != null:
				kind = _path_reference_kind(line)
			elif by_class != null and by_class.search(line) != null:
				kind = "extends" if line.strip_edges().begins_with("extends ") else "class_name"
			if kind.is_empty():
				continue
			references.append({"line": i + 1, "kind": kind, "text": line.strip_edges()})
			by_kind[kind] = Read.as_int(by_kind.get(kind, 0)) + 1

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


# How a line that names the resource by path uses it.
func _path_reference_kind(line: String) -> String:
	var trimmed: String = line.strip_edges()
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

	if walk.visited.has(path):
		var cached: Array[Dictionary] = walk.visited[path]
		return cached

	walk.path_stack.append(path)

	var file: FileAccess = FileAccess.open(path, FileAccess.READ)
	if file:
		var content: String = file.get_as_text()
		file.close()

		for pattern: String in REFERENCE_PATTERNS:
			var regex: RegEx = Patterns.compiled(pattern)
			for m: RegExMatch in regex.search_all(content):
				var dep_path: String = _referenced_path(m.get_string())

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
	walk.visited[path] = deps
	return deps


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
