extends RefCounted

const FileWalk = preload("file_walk.gd")
const Log = preload("logger.gd")

var _log: Log
var _files: FileWalk = FileWalk.new()


func _init(p_log: Log) -> void:
	_log = p_log


# Get comprehensive project health check with scoring
func get_project_health(params: Dictionary) -> Dictionary:
	var check_categories: Array = params.get(
		"categories", ["structure", "resources", "scripts", "scenes", "config"]
	)

	_log.info("Performing project health check")

	var checks: Dictionary = {}
	var recommendations: Array[String] = []
	var deductions: int = 0

	# 1. Project Structure Check
	if "structure" in check_categories:
		var passed: bool = true
		var details: Array[String] = []

		if not FileAccess.file_exists("res://project.godot"):
			passed = false
			details.append("Missing project.godot file")
			deductions += 30

		var recommended_dirs: Array[String] = ["res://scenes", "res://scripts", "res://assets"]
		var missing_dirs: Array[String] = []
		for dir: String in recommended_dirs:
			if not DirAccess.dir_exists_absolute(ProjectSettings.globalize_path(dir)):
				missing_dirs.append(dir)

		if missing_dirs.size() > 0:
			details.append("Consider organizing with directories: " + ", ".join(missing_dirs))
			deductions += 2 * missing_dirs.size()

		checks["structure"] = {"name": "Project Structure", "passed": passed, "details": details}

	# 2. Resource Check
	if "resources" in check_categories:
		var details: Array[String] = []

		var importable_extensions: Array[String] = ["png", "jpg", "wav", "mp3", "ogg"]
		var resources: Array[String] = []
		for ext: String in importable_extensions:
			resources.append_array(_files.find_files("res://", "." + ext))

		var missing_imports: int = 0
		for res: String in resources:
			if not FileAccess.file_exists(res + ".import"):
				missing_imports += 1

		if missing_imports > 0:
			details.append(str(missing_imports) + " resources may need reimporting")
			deductions += missing_imports

		checks["resources"] = {
			"name": "Resources", "passed": true, "details": details, "total_resources": resources.size()
		}

	# 3. Scripts Check
	if "scripts" in check_categories:
		var details: Array[String] = []

		var script_files: Array[String] = _files.find_files("res://", ".gd")
		var todo_count: int = 0
		var empty_functions: int = 0

		for script_path: String in script_files:
			var file: FileAccess = FileAccess.open(script_path, FileAccess.READ)
			if file:
				var content: String = file.get_as_text()
				file.close()

				if "# TODO" in content or "# FIXME" in content:
					todo_count += 1
				if "pass # " in content or content.ends_with("pass\n"):
					empty_functions += 1

		if todo_count > 0:
			details.append(str(todo_count) + " scripts have TODO/FIXME comments")
			deductions += todo_count

		if empty_functions > 0:
			details.append(str(empty_functions) + " scripts may have empty functions")
			deductions += empty_functions

		checks["scripts"] = {
			"name": "Scripts", "passed": true, "details": details, "total_scripts": script_files.size()
		}

	# 4. Scenes Check
	if "scenes" in check_categories:
		var details: Array[String] = []

		var scene_files: Array[String] = _files.find_files("res://", ".tscn")
		if scene_files.size() == 0:
			details.append("No scene files found in project")
			deductions += 5

		checks["scenes"] = {
			"name": "Scenes", "passed": true, "details": details, "total_scenes": scene_files.size()
		}

	# 5. Configuration Check
	if "config" in check_categories:
		var details: Array[String] = []

		var main_scene: String = str(ProjectSettings.get_setting("application/run/main_scene", ""))
		if main_scene.is_empty():
			details.append("No main scene configured")
			deductions += 10
		elif not FileAccess.file_exists(main_scene):
			details.append("Main scene file does not exist: " + main_scene)
			deductions += 15

		var project_name: String = str(ProjectSettings.get_setting("application/config/name", ""))
		if project_name.is_empty():
			details.append("No project name set")
			deductions += 2

		if not FileAccess.file_exists("res://export_presets.cfg"):
			details.append("No export presets configured")
			deductions += 3

		checks["config"] = {"name": "Configuration", "passed": true, "details": details}

	var score: int = maxi(0, 100 - deductions)

	var grade: String
	if score >= 90:
		grade = "A"
	elif score >= 80:
		grade = "B"
	elif score >= 70:
		grade = "C"
	elif score >= 60:
		grade = "D"
	else:
		grade = "F"

	if deductions > 0:
		if score < 70:
			recommendations.append("Address critical issues to improve project stability")
		if not FileAccess.file_exists("res://export_presets.cfg"):
			recommendations.append("Configure export presets for your target platforms")

	return {
		"score": score, "grade": grade, "checks": checks, "issues": [], "recommendations": recommendations
	}
