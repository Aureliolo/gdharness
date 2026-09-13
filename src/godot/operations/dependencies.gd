extends RefCounted

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
	var depth: int = int(params.get("depth", 0))
	var max_depth: int = depth if depth > 0 else 1000
	var include_built_in: bool = bool(params.get("include_builtin", false))

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
		dep_count += _count_recursive(dependencies[key])

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


# Find all usages of a resource across the project
func find_resource_usages(params: Dictionary) -> Dictionary:
	var resource_path: String = str(params.get("resource_path", ""))
	var search_patterns: Array = params.get("search_patterns", [])
	var file_types: Array = params.get("file_types", ["tscn", "tres", "gd", "gdshader"])

	if not resource_path.begins_with("res://"):
		resource_path = "res://" + resource_path

	_log.info("Finding usages of: " + resource_path)

	var patterns_to_search: Array[String] = [resource_path]
	for pattern: Variant in search_patterns:
		patterns_to_search.append(str(pattern))

	# A reference written without the scheme still points at the same file.
	patterns_to_search.append(resource_path.substr(6))

	var all_files: Array[String] = []
	for ext: Variant in file_types:
		all_files.append_array(_files.find_files("res://", "." + str(ext)))

	var usages: Array[Dictionary] = []
	var total_usages: int = 0

	for file_path: String in all_files:
		if file_path == resource_path:
			continue

		var file: FileAccess = FileAccess.open(file_path, FileAccess.READ)
		if not file:
			continue

		var content: String = file.get_as_text()
		file.close()

		var file_usages: Array[Dictionary] = []
		var lines: PackedStringArray = content.split("\n")

		for i: int in range(lines.size()):
			var line: String = lines[i]
			for pattern: String in patterns_to_search:
				if pattern in line:
					file_usages.append(
						{"line_number": i + 1, "line_content": line.strip_edges(), "pattern_matched": pattern}
					)
					break

		if file_usages.size() > 0:
			usages.append({"file": file_path, "occurrences": file_usages})
			total_usages += file_usages.size()

	return {
		"resource_path": resource_path,
		"usages": usages,
		"summary":
		{
			"total_files_searched": all_files.size(),
			"files_with_usages": usages.size(),
			"total_usages": total_usages
		}
	}


func _count_recursive(deps: Array[Dictionary]) -> int:
	var count: int = deps.size()
	for dep: Dictionary in deps:
		if dep.has("dependencies"):
			count += _count_recursive(dep["dependencies"])
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
			var regex: RegEx = RegEx.new()
			regex.compile(pattern)
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
	var inner: RegEx = RegEx.new()
	if "preload" in matched or "load" in matched:
		inner.compile('"([^"]+)"')
	elif "ext_resource" in matched:
		inner.compile('path="([^"]+)"')
	else:
		return matched
	var inner_match: RegExMatch = inner.search(matched)
	return inner_match.get_string(1) if inner_match else matched
