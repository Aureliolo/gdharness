extends RefCounted

const FileWalk = preload("file_walk.gd")
const Log = preload("logger.gd")

var _log: Log
var _files := FileWalk.new()


# Everything one dependency walk carries: the settings it was started with, and the state it
# accumulates as it recurses. Kept together so the recursion passes one object rather than
# six positional arguments that have to stay in the same order at every call site.
class DependencyWalk:
	var max_depth: int
	var include_built_in: bool
	var visited: Dictionary = {}
	var path_stack: Array = []
	var result: Dictionary

	func _init(p_max_depth: int, p_include_built_in: bool, p_result: Dictionary) -> void:
		max_depth = p_max_depth
		include_built_in = p_include_built_in
		result = p_result


func _init(p_log: Log) -> void:
	_log = p_log


# Get dependencies for a resource with circular reference detection
func get_dependencies(params) -> Dictionary:
	var resource_path = params.get("resource_path", "")
	var max_depth = params.get("max_depth", 10)
	var include_built_in = params.get("include_built_in", false)

	_log.info(
		(
			"Getting dependencies"
			+ (" for: " + resource_path if not resource_path.is_empty() else " for all resources")
		)
	)

	var result = {
		"dependencies": {},
		"circular_references": [],
		"summary": {"total_resources": 0, "total_dependencies": 0, "circular_count": 0}
	}

	if not resource_path.is_empty():
		# Analyze single resource
		var full_path = resource_path
		if not full_path.begins_with("res://"):
			full_path = "res://" + full_path

		if not FileAccess.file_exists(full_path):
			return _log.failure("Resource file does not exist: " + full_path)

		var walk = DependencyWalk.new(max_depth, include_built_in, result)
		result["dependencies"][full_path] = _analyze_resource(full_path, 0, walk)
		result["summary"]["total_resources"] = 1
	else:
		# Analyze all project resources
		var resource_extensions = ["tscn", "tres", "gd", "gdshader", "shader"]
		var all_resources = []
		for ext in resource_extensions:
			all_resources.append_array(_files.find_files("res://", "." + ext))

		for res_path in all_resources:
			var walk = DependencyWalk.new(max_depth, include_built_in, result)
			var deps = _analyze_resource(res_path, 0, walk)
			if deps.size() > 0:
				result["dependencies"][res_path] = deps

		result["summary"]["total_resources"] = all_resources.size()

	# Count total dependencies
	var dep_count = 0
	for key in result["dependencies"]:
		dep_count += _count_recursive(result["dependencies"][key])
	result["summary"]["total_dependencies"] = dep_count
	result["summary"]["circular_count"] = result["circular_references"].size()

	return result


# Find all usages of a resource across the project
func find_resource_usages(params) -> Dictionary:
	var resource_path = params.resource_path
	var search_patterns = params.get("search_patterns", [])
	var file_types = params.get("file_types", ["tscn", "tres", "gd", "gdshader"])

	if not resource_path.begins_with("res://"):
		resource_path = "res://" + resource_path

	_log.info("Finding usages of: " + resource_path)

	var result = {
		"resource_path": resource_path,
		"usages": [],
		"summary": {"total_files_searched": 0, "files_with_usages": 0, "total_usages": 0}
	}

	# Build search patterns
	var patterns_to_search = [resource_path]
	if search_patterns.size() > 0:
		patterns_to_search.append_array(search_patterns)

	# Also search for relative variants
	var relative_path = resource_path.substr(6) if resource_path.begins_with("res://") else resource_path
	patterns_to_search.append(relative_path)

	# Get all searchable files
	var all_files = []
	for ext in file_types:
		all_files.append_array(_files.find_files("res://", "." + ext))

	result["summary"]["total_files_searched"] = all_files.size()

	for file_path in all_files:
		# Skip the resource itself
		if file_path == resource_path:
			continue

		var file = FileAccess.open(file_path, FileAccess.READ)
		if not file:
			continue

		var content = file.get_as_text()
		file.close()

		var file_usages = []
		var lines = content.split("\n")

		for i in range(lines.size()):
			var line = lines[i]
			for pattern in patterns_to_search:
				if pattern in line:
					file_usages.append(
						{"line_number": i + 1, "line_content": line.strip_edges(), "pattern_matched": pattern}
					)
					break

		if file_usages.size() > 0:
			result["usages"].append({"file": file_path, "occurrences": file_usages})
			result["summary"]["files_with_usages"] += 1
			result["summary"]["total_usages"] += file_usages.size()

	return result


func _count_recursive(deps: Array) -> int:
	var count = deps.size()
	for dep in deps:
		if dep is Dictionary and dep.has("dependencies"):
			count += _count_recursive(dep["dependencies"])
	return count


func _analyze_resource(path: String, current_depth: int, walk: DependencyWalk) -> Array:
	var deps = []

	if current_depth >= walk.max_depth:
		return deps

	# Check for circular reference
	if path in walk.path_stack:
		var cycle = walk.path_stack.slice(walk.path_stack.find(path))
		cycle.append(path)
		if not cycle in walk.result["circular_references"]:
			walk.result["circular_references"].append(cycle)
		return [{"path": path, "circular": true}]

	# Skip if already fully visited
	if walk.visited.has(path):
		return walk.visited[path]

	walk.path_stack.append(path)

	# Parse the file to find dependencies
	var file = FileAccess.open(path, FileAccess.READ)
	if file:
		var content = file.get_as_text()
		file.close()

		# Find resource references
		var patterns = [
			"res://[^\"'\\s\\]\\)]+",  # res:// paths
			'preload\\("([^"]+)"\\)',  # preload
			'load\\("([^"]+)"\\)',  # load
			'ext_resource.*path="([^"]+)"'  # external resources in tscn/tres
		]

		var regex = RegEx.new()
		for pattern in patterns:
			regex.compile(pattern)
			var matches = regex.search_all(content)
			for m in matches:
				var dep_path = m.get_string()

				# Extract path from preload/load patterns
				if "preload" in dep_path or "load" in dep_path:
					var inner_regex = RegEx.new()
					inner_regex.compile('"([^"]+)"')
					var inner_match = inner_regex.search(dep_path)
					if inner_match:
						dep_path = inner_match.get_string(1)
				elif "ext_resource" in dep_path:
					var inner_regex = RegEx.new()
					inner_regex.compile('path="([^"]+)"')
					var inner_match = inner_regex.search(dep_path)
					if inner_match:
						dep_path = inner_match.get_string(1)

				# Clean up path
				if not dep_path.begins_with("res://"):
					continue

				# Skip engine-internal resources unless requested. `addons/` is not one of
				# them: it is ordinary project content, and often shipping content, so
				# treating it as built-in dropped every dependency of anything living there.
				if not walk.include_built_in and dep_path.begins_with("res://."):
					continue

				# Skip if same as source
				if dep_path == path:
					continue

				var dep_info = {"path": dep_path, "exists": FileAccess.file_exists(dep_path)}

				# Recursively analyze if exists and not yet added
				if dep_info["exists"] and current_depth + 1 < walk.max_depth:
					var sub_deps = _analyze_resource(dep_path, current_depth + 1, walk)
					if sub_deps.size() > 0:
						dep_info["dependencies"] = sub_deps

				# Avoid duplicates
				var already_added = false
				for existing in deps:
					if existing is Dictionary and existing.get("path", "") == dep_path:
						already_added = true
						break
				if not already_added:
					deps.append(dep_info)

	walk.path_stack.pop_back()
	walk.visited[path] = deps
	return deps
