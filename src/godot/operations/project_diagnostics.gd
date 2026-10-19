extends RefCounted

const GdhDependencies = preload("dependencies.gd")
const GdhFileWalk = preload("file_walk.gd")
const GdhImportPipeline = preload("import_pipeline.gd")
const GdhLog = preload("logger.gd")
const GdhRead = preload("reading.gd")
const GdhScriptCheck = preload("script_check.gd")

var _log: GdhLog
var _files: GdhFileWalk = GdhFileWalk.new()


func _init(p_log: GdhLog) -> void:
	_log = p_log


# Get comprehensive project health check with scoring
func get_project_health(params: Dictionary) -> Dictionary:
	var check_categories: Array = params.get(
		"categories", ["structure", "resources", "scripts", "references", "scenes", "config"]
	)

	_log.info("Performing project health check")

	var checks: Dictionary = {}
	var recommendations: Array[String] = []
	var deductions: int = 0

	# 1. Project Structure Check
	if "structure" in check_categories:
		var details: Array[String] = []

		if not FileAccess.file_exists("res://project.godot"):
			details.append("Missing project.godot file")
			deductions += 30
		# No layout is asked for. A project without res://scenes, res://scripts and res://assets
		# failed this check and lost points, while Godot's own guidance is to keep a scene's files
		# together by feature, so the check failed projects for following the engine's advice.

		checks["structure"] = {"name": "Project Structure", "passed": details.is_empty(), "details": details}

	# 2. Resource Check
	if "resources" in check_categories:
		var details: Array[String] = []

		# Every format the engine imports, the list the import status reads: five of them were checked
		# here, so a project of glTF models, fonts and WebP textures had nothing to reimport.
		var resources: Array[String] = _files.find_files_with_extensions(
			"res://", GdhImportPipeline.IMPORTABLE_EXTENSIONS
		)

		var missing_imports: int = 0
		for res: String in resources:
			if not FileAccess.file_exists(res + ".import"):
				missing_imports += 1

		if missing_imports > 0:
			details.append(str(missing_imports) + " resources may need reimporting")
			deductions += missing_imports

		checks["resources"] = {
			"name": "Resources",
			"passed": details.is_empty(),
			"details": details,
			# What the check read: files the engine imports. A .tres is a resource and was counted
			# under this name as none, beside a project holding one.
			"importable_files": resources.size()
		}

	# 3. Scripts Check
	if "scripts" in check_categories:
		var details: Array[String] = []

		var script_files: Array[String] = _files.find_files("res://", ".gd")
		var todo_count: int = 0

		for script_path: String in script_files:
			var file: FileAccess = FileAccess.open(script_path, FileAccess.READ)
			if file:
				var content: String = file.get_as_text()
				file.close()

				if "# TODO" in content or "# FIXME" in content:
					todo_count += 1

		# Work noted for later, which no script fails on, so said rather than failed. A count of
		# "empty functions" read off a script ending in `pass` went with it: a virtual left for an
		# override to fill ends that way and is exactly right.
		if todo_count > 0:
			recommendations.append("%d scripts have TODO or FIXME comments to look at" % todo_count)

		# Compiled by the server before this runs, since an engine stops at the first script that
		# fails, and handed in. Without it the check read only comments and said "passed" beside
		# scripts the engine refused.
		var compiled: Dictionary = params.get("compiled", {})
		var failures: Array = compiled.get("failures", [])
		for failure: Dictionary in failures:
			details.append(GdhScriptCheck.failure_line(failure))
			deductions += 10

		var scripts: Dictionary = {
			"name": "Scripts",
			"passed": details.is_empty(),
			"details": details,
			"total_scripts": script_files.size()
		}
		if compiled.has("checked"):
			scripts["compiled"] = GdhRead.as_int(compiled["checked"])
		else:
			scripts["not_compiled"] = str(compiled.get("not_checked", "no compile was asked for"))
		checks["scripts"] = scripts

	# 3b. References
	if "references" in check_categories:
		var details: Array[String] = []
		for entry: Dictionary in GdhDependencies.new(_log).missing_references():
			details.append(GdhDependencies.missing_line(entry))
			deductions += 5
		checks["references"] = {"name": "References", "passed": details.is_empty(), "details": details}

	# 4. Scenes Check
	if "scenes" in check_categories:
		var details: Array[String] = []

		# Binary scenes too, which a project may save instead and which counted as none.
		var scene_files: Array[String] = _files.find_files_with_extensions("res://", ["tscn", "scn"])
		if scene_files.size() == 0:
			details.append("No scene files found in project")
			deductions += 5

		checks["scenes"] = {
			"name": "Scenes",
			"passed": details.is_empty(),
			"details": details,
			"total_scenes": scene_files.size()
		}

	# 5. Configuration Check
	if "config" in check_categories:
		var details: Array[String] = []

		var main_scene: String = str(ProjectSettings.get_setting("application/run/main_scene", ""))
		if main_scene.is_empty():
			details.append("No main scene configured")
			deductions += 10
		elif not GdhFileWalk.missing_reason(main_scene).is_empty():
			details.append("Main scene " + GdhFileWalk.missing_reason(main_scene))
			deductions += 15

		var project_name: String = str(ProjectSettings.get_setting("application/config/name", ""))
		if project_name.is_empty():
			details.append("No project name set")
			deductions += 2

		checks["config"] = {"name": "Configuration", "passed": details.is_empty(), "details": details}

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

	if score < 70:
		recommendations.append("Address critical issues to improve project stability")
	# A project still being made has no presets yet, which is no fault in it.
	if "config" in check_categories and not FileAccess.file_exists("res://export_presets.cfg"):
		recommendations.append(
			"No export presets are configured: project_export add_preset adds one before exporting"
		)

	# Every detail costs points, so each is an issue; `issues` was always empty beside them, and a
	# category said passed next to the failure it had just found.
	var issues: Array[Dictionary] = []
	for category: String in checks:
		var check: Dictionary = checks[category]
		var found: Array[String] = check["details"]
		for detail: String in found:
			issues.append({"check": category, "detail": detail})
	return {
		"score": score, "grade": grade, "checks": checks, "issues": issues, "recommendations": recommendations
	}
