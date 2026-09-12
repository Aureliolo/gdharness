extends RefCounted

const FileWalk = preload("file_walk.gd")
const Log = preload("logger.gd")

# What an error line is taken to mean, and what to tell the caller about it. Substring matches
# rather than expressions: the engine writes these prefixes verbatim.
const ERROR_PATTERNS = {
	"script_error":
	{
		"pattern": "SCRIPT ERROR:",
		"category": "Script",
		"suggestion": "Check the script file at the mentioned line for syntax or logic errors"
	},
	"parse_error":
	{
		"pattern": "Parse Error:",
		"category": "Syntax",
		"suggestion": "Review the syntax at the mentioned location, check for typos or missing punctuation"
	},
	"null_reference":
	{
		"pattern": "Attempt to call function.*on a null instance",
		"category": "Null Reference",
		"suggestion": "Ensure the object is properly initialized before calling methods on it"
	},
	"invalid_call":
	{
		"pattern": "Invalid call.*Nonexistent function",
		"category": "Invalid Call",
		"suggestion": "Check if the function exists and is spelled correctly"
	},
	"type_error":
	{
		"pattern": "Cannot convert.*to.*",
		"category": "Type Error",
		"suggestion": "Ensure you're using compatible types or add explicit type conversion"
	},
	"resource_not_found":
	{
		"pattern": "res://.*not found",
		"category": "Missing Resource",
		"suggestion": "Verify the resource path is correct and the file exists"
	},
	"cyclic_reference":
	{
		"pattern": "Cyclic reference",
		"category": "Cyclic Reference",
		"suggestion": "Break the circular dependency between resources"
	}
}

var _log: Log
var _files := FileWalk.new()


func _init(p_log: Log) -> void:
	_log = p_log


# Parse Godot error log and provide suggestions
func parse_error_log(params) -> Dictionary:
	var log_path = params.get("log_path", "")
	var log_content = params.get("log_content", "")
	var include_suggestions = params.get("include_suggestions", true)

	_log.info("Parsing error log")

	var result = {
		"errors": [],
		"warnings": [],
		"summary": {"total_errors": 0, "total_warnings": 0, "error_categories": {}}
	}

	var content = ""

	if not log_path.is_empty():
		var file = FileAccess.open(log_path, FileAccess.READ)
		if not file:
			return _log.failure("Failed to open log file: " + log_path)
		content = file.get_as_text()
		file.close()
	elif not log_content.is_empty():
		content = log_content
	else:
		# Try default Godot log location
		var default_paths = ["user://logs/godot.log", OS.get_user_data_dir() + "/logs/godot.log"]
		for path in default_paths:
			var file = FileAccess.open(path, FileAccess.READ)
			if file:
				content = file.get_as_text()
				file.close()
				result["log_source"] = path
				break

	if content.is_empty():
		result["message"] = "No log content provided and default log file not found"
		return result

	var lines = content.split("\n")

	for i in range(lines.size()):
		var line = lines[i]
		var line_lower = line.to_lower()

		# Check for errors
		if "error" in line_lower or "failed" in line_lower:
			var error_entry = {"line_number": i + 1, "message": line.strip_edges(), "category": "General"}

			# Match specific error patterns
			for pattern_name in ERROR_PATTERNS:
				var pattern_info = ERROR_PATTERNS[pattern_name]
				if pattern_info["pattern"].to_lower() in line_lower:
					error_entry["category"] = pattern_info["category"]
					if include_suggestions:
						error_entry["suggestion"] = pattern_info["suggestion"]
					break

			result["errors"].append(error_entry)

			# Count by category
			if not result["summary"]["error_categories"].has(error_entry["category"]):
				result["summary"]["error_categories"][error_entry["category"]] = 0
			result["summary"]["error_categories"][error_entry["category"]] += 1

		# Check for warnings
		elif "warning" in line_lower:
			result["warnings"].append({"line_number": i + 1, "message": line.strip_edges()})

	result["summary"]["total_errors"] = result["errors"].size()
	result["summary"]["total_warnings"] = result["warnings"].size()

	return result


# Get comprehensive project health check with scoring
func get_project_health(params) -> Dictionary:
	var check_categories = params.get("categories", ["structure", "resources", "scripts", "scenes", "config"])

	_log.info("Performing project health check")

	var result = {"score": 100, "grade": "A", "checks": {}, "issues": [], "recommendations": []}

	var deductions = 0

	# 1. Project Structure Check
	if "structure" in check_categories:
		var structure_check = {"name": "Project Structure", "passed": true, "details": []}

		# Check for project.godot
		if not FileAccess.file_exists("res://project.godot"):
			structure_check["passed"] = false
			structure_check["details"].append("Missing project.godot file")
			deductions += 30

		# Check for common directories
		var recommended_dirs = ["res://scenes", "res://scripts", "res://assets"]
		var missing_dirs = []
		for dir in recommended_dirs:
			if not DirAccess.dir_exists_absolute(ProjectSettings.globalize_path(dir)):
				missing_dirs.append(dir)

		if missing_dirs.size() > 0:
			structure_check["details"].append(
				"Consider organizing with directories: " + ", ".join(missing_dirs)
			)
			deductions += 2 * missing_dirs.size()

		result["checks"]["structure"] = structure_check

	# 2. Resource Check
	if "resources" in check_categories:
		var resource_check = {"name": "Resources", "passed": true, "details": []}

		# Check for orphaned imports
		var importable_extensions = ["png", "jpg", "wav", "mp3", "ogg"]
		var resources = []
		for ext in importable_extensions:
			resources.append_array(_files.find_files("res://", "." + ext))

		var missing_imports = 0
		for res in resources:
			var import_file = res + ".import"
			if not FileAccess.file_exists(import_file):
				missing_imports += 1

		if missing_imports > 0:
			resource_check["details"].append(str(missing_imports) + " resources may need reimporting")
			deductions += missing_imports

		resource_check["total_resources"] = resources.size()
		result["checks"]["resources"] = resource_check

	# 3. Scripts Check
	if "scripts" in check_categories:
		var scripts_check = {"name": "Scripts", "passed": true, "details": []}

		var script_files = _files.find_files("res://", ".gd")
		var todo_count = 0
		var empty_functions = 0

		for script_path in script_files:
			var file = FileAccess.open(script_path, FileAccess.READ)
			if file:
				var content = file.get_as_text()
				file.close()

				if "# TODO" in content or "# FIXME" in content:
					todo_count += 1
				if "pass # " in content or content.ends_with("pass\n"):
					empty_functions += 1

		if todo_count > 0:
			scripts_check["details"].append(str(todo_count) + " scripts have TODO/FIXME comments")
			deductions += todo_count

		if empty_functions > 0:
			scripts_check["details"].append(str(empty_functions) + " scripts may have empty functions")
			deductions += empty_functions

		scripts_check["total_scripts"] = script_files.size()
		result["checks"]["scripts"] = scripts_check

	# 4. Scenes Check
	if "scenes" in check_categories:
		var scenes_check = {"name": "Scenes", "passed": true, "details": []}

		var scene_files = _files.find_files("res://", ".tscn")
		scenes_check["total_scenes"] = scene_files.size()

		if scene_files.size() == 0:
			scenes_check["details"].append("No scene files found in project")
			deductions += 5

		result["checks"]["scenes"] = scenes_check

	# 5. Configuration Check
	if "config" in check_categories:
		var config_check = {"name": "Configuration", "passed": true, "details": []}

		# Check main scene
		var main_scene = ProjectSettings.get_setting("application/run/main_scene", "")
		if main_scene.is_empty():
			config_check["details"].append("No main scene configured")
			deductions += 10
		elif not FileAccess.file_exists(main_scene):
			config_check["details"].append("Main scene file does not exist: " + main_scene)
			deductions += 15

		# Check project name
		var project_name = ProjectSettings.get_setting("application/config/name", "")
		if project_name.is_empty():
			config_check["details"].append("No project name set")
			deductions += 2

		# Check for export presets
		if not FileAccess.file_exists("res://export_presets.cfg"):
			config_check["details"].append("No export presets configured")
			deductions += 3

		result["checks"]["config"] = config_check

	# Calculate final score
	result["score"] = max(0, 100 - deductions)

	# Determine grade
	if result["score"] >= 90:
		result["grade"] = "A"
	elif result["score"] >= 80:
		result["grade"] = "B"
	elif result["score"] >= 70:
		result["grade"] = "C"
	elif result["score"] >= 60:
		result["grade"] = "D"
	else:
		result["grade"] = "F"

	# Generate recommendations based on issues
	if deductions > 0:
		if result["score"] < 70:
			result["recommendations"].append("Address critical issues to improve project stability")
		if not FileAccess.file_exists("res://export_presets.cfg"):
			result["recommendations"].append("Configure export presets for your target platforms")

	return result


# Search for text or patterns across project files
func search_project(params) -> Dictionary:
	var query = params.query
	var file_types = params.get("file_types", ["gd", "tscn", "tres"])
	var use_regex = params.get("regex", false)
	var case_sensitive = params.get("case_sensitive", false)
	var max_results = params.get("max_results", 100)

	_log.info("Searching project for: " + query)
	_log.debug("File types: " + str(file_types))
	_log.debug("Use regex: " + str(use_regex))
	_log.debug("Case sensitive: " + str(case_sensitive))
	_log.debug("Max results: " + str(max_results))

	var result = {
		"query": query,
		"results": [],
		"summary": {"files_searched": 0, "files_with_matches": 0, "total_matches": 0, "truncated": false}
	}

	# Compile regex if needed
	var regex: RegEx = null
	if use_regex:
		regex = RegEx.new()
		if regex.compile(query) != OK:
			return _log.failure("Invalid regex pattern: " + query)

	# Get all files to search
	var files_to_search = []
	for ext in file_types:
		files_to_search.append_array(_files.find_files("res://", "." + ext))

	result["summary"]["files_searched"] = files_to_search.size()
	_log.debug("Files to search: " + str(files_to_search.size()))

	# Search each file
	for file_path in files_to_search:
		if result["summary"]["total_matches"] >= max_results:
			result["summary"]["truncated"] = true
			break

		var file = FileAccess.open(file_path, FileAccess.READ)
		if not file:
			continue

		var content = file.get_as_text()
		file.close()

		var lines = content.split("\n")
		var file_matches = []

		for i in range(lines.size()):
			if result["summary"]["total_matches"] >= max_results:
				result["summary"]["truncated"] = true
				break

			var line = lines[i]
			var line_to_check = line if case_sensitive else line.to_lower()
			var query_to_check = query if case_sensitive else query.to_lower()
			var matched = false
			var match_content = ""

			if use_regex:
				var match_result = regex.search(line)
				if match_result:
					matched = true
					match_content = match_result.get_string()
			else:
				if query_to_check in line_to_check:
					matched = true
					match_content = query

			if matched:
				file_matches.append({"line": i + 1, "content": line.strip_edges(), "match": match_content})
				result["summary"]["total_matches"] += 1

		if file_matches.size() > 0:
			result["results"].append({"file": file_path, "matches": file_matches})
			result["summary"]["files_with_matches"] += 1

	return result
