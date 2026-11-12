extends RefCounted

const GdhDependencies = preload("dependencies.gd")
const GdhFileWalk = preload("file_walk.gd")
const GdhImportPipeline = preload("import_pipeline.gd")
const GdhInputActions = preload("input_actions.gd")
const GdhLog = preload("logger.gd")
const GdhPatterns = preload("patterns.gd")
const GdhProjectConfig = preload("project_config.gd")
const GdhRead = preload("reading.gd")
const GdhSceneConnections = preload("scene_connections.gd")
const GdhScriptCheck = preload("script_check.gd")
## Every category the health check reads, in the order its answer lists them.
const CATEGORIES: Array[String] = [
	"structure", "resources", "scripts", "references", "scenes", "config",
]

var _log: GdhLog
var _files: GdhFileWalk = GdhFileWalk.new()


func _init(p_log: GdhLog) -> void:
	_log = p_log


# Get comprehensive project health check with scoring
func get_project_health(params: Dictionary) -> Dictionary:
	_log.info("Performing project health check")

	var checks: Dictionary = {}
	var recommendations: Array[String] = []
	var deductions: int = 0
	for category: String in CATEGORIES:
		var found: Array = _checked(category, params, recommendations)
		checks[category] = found[0]
		deductions += GdhRead.as_int(found[1])

	var score: int = maxi(0, 100 - deductions)
	if score < 70:
		recommendations.append("Address critical issues to improve project stability")
	# A project still being made has no presets yet, which is no fault in it.
	if not FileAccess.file_exists("res://export_presets.cfg"):
		recommendations.append(
			"No export presets are configured: project_export add_preset adds one before exporting"
		)
	return {
		"score": score,
		"grade": _grade(score),
		"checks": checks,
		"issues": _issues(checks),
		"recommendations": recommendations,
	}


## [code][check, points lost][/code] for [param category]. A note for later that fails nothing
## goes to [param recommendations].
func _checked(category: String, params: Dictionary, recommendations: Array[String]) -> Array:
	match category:
		"structure":
			return _structure()
		"resources":
			return _resources()
		"scripts":
			return _scripts(params, recommendations)
		"references":
			return _references()
		"scenes":
			return _scenes()
	return _config()


## A check named [param check_name] holding [param details], passed when it holds none.
static func _check(check_name: String, details: Array[String]) -> Dictionary:
	return { "name": check_name, "passed": details.is_empty(), "details": details }


func _structure() -> Array:
	var details: Array[String] = []
	var cost: int = 0
	if not FileAccess.file_exists("res://project.godot"):
		details.append("Missing project.godot file")
		cost += 30
	# No layout is asked for. A project without res://scenes, res://scripts and res://assets
	# failed this check and lost points, while Godot's own guidance is to keep a scene's files
	# together by feature, so the check failed projects for following the engine's advice.
	return [_check("Project Structure", details), cost]


func _resources() -> Array:
	var details: Array[String] = []
	var cost: int = 0
	# Every format the engine imports, the list the import status reads: five of them were
	# checked here, so a project of glTF models, fonts and WebP textures had nothing to
	# reimport.
	var resources: Array[String] = _files.find_files_with_extensions(
		"res://", GdhImportPipeline.IMPORTABLE_EXTENSIONS
	)
	var missing_imports: Array[String] = []
	for res: String in resources:
		if not FileAccess.file_exists(res + ".import"):
			missing_imports.append(res)
	if not missing_imports.is_empty():
		missing_imports.sort()
		details.append(GdhImportPipeline.never_imported_line(missing_imports))
		cost += missing_imports.size()
	var check: Dictionary = _check("Resources", details)
	# What the check read: files the engine imports. A .tres is a resource and was counted
	# under this name as none, beside a project holding one.
	check["importable_files"] = resources.size()
	return [check, cost]


func _scripts(params: Dictionary, recommendations: Array[String]) -> Array:
	var details: Array[String] = []
	var cost: int = 0
	var script_files: Array[String] = _files.find_files("res://", ".gd")
	# Work noted for later, which no script fails on, so said rather than failed. A count of
	# "empty functions" read off a script ending in `pass` went with it: a virtual left for an
	# override to fill ends that way and is exactly right.
	var todo_count: int = _noted_work_count(script_files)
	if todo_count > 0:
		recommendations.append(
			"%d scripts outside addons/ have TODO or FIXME comments to look at" % todo_count
		)

	# Compiled by the server before this runs, since an engine stops at the first script that
	# fails, and handed in. Without it the check read only comments and said "passed" beside
	# scripts the engine refused.
	var compiled: Dictionary = params.get("compiled", {})
	var failures: Array = compiled.get("failures", [])
	for failure: Dictionary in failures:
		details.append(GdhScriptCheck.failure_line(failure))
		cost += 10

	var scripts: Dictionary = _check("Scripts", details)
	scripts["total_scripts"] = script_files.size()
	if compiled.has("checked"):
		# The ones that compiled: each failure is one of the scripts checked.
		scripts["compiled"] = GdhRead.as_int(compiled["checked"]) - failures.size()
	else:
		scripts["not_compiled"] = str(compiled.get("not_checked", "no compile was asked for"))
	return [scripts, cost]


## How many of [param script_files] outside addons/ note work for later. An addon's notes are its
## authors' work, not the project's.
static func _noted_work_count(script_files: Array[String]) -> int:
	var count: int = 0
	for script_path: String in script_files:
		if script_path.begins_with("res://addons/"):
			continue
		var file: FileAccess = FileAccess.open(script_path, FileAccess.READ)
		if file:
			var content: String = file.get_as_text()
			file.close()
			if not GdhPatterns.noted_work(content).is_empty():
				count += 1
	return count


func _references() -> Array:
	var details: Array[String] = []
	for entry: Dictionary in GdhDependencies.new(_log).missing_references():
		details.append(GdhDependencies.missing_line(entry))
	for entry: Dictionary in GdhInputActions.new(_log).undefined_in_scripts():
		details.append(GdhInputActions.undefined_line(entry))
	return [_check("References", details), details.size() * 5]


func _scenes() -> Array:
	var details: Array[String] = []
	var cost: int = 0
	# Binary scenes too, which a project may save instead and which counted as none.
	var scene_files: Array[String] = _files.find_files_with_extensions("res://", ["tscn", "scn"])
	if scene_files.size() == 0:
		details.append("No scene files found in project")
		cost += 5
	for entry: Dictionary in GdhSceneConnections.new(_log).broken():
		details.append(GdhSceneConnections.broken_line(entry))
		cost += 5
	var check: Dictionary = _check("Scenes", details)
	check["total_scenes"] = scene_files.size()
	return [check, cost]


func _config() -> Array:
	var details: Array[String] = []
	var cost: int = 0
	var main_scene: String = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if main_scene.is_empty():
		details.append("No main scene configured")
		cost += 10
	elif not GdhFileWalk.missing_reason(main_scene).is_empty():
		details.append("Main scene " + GdhFileWalk.missing_reason(main_scene))
		cost += 15
	var untranslated: String = GdhProjectConfig.project_text_translations()
	if not untranslated.is_empty():
		details.append(untranslated)
		cost += 10
	var project_name: String = str(ProjectSettings.get_setting("application/config/name", ""))
	if project_name.is_empty():
		details.append("No project name set")
		cost += 2
	return [_check("Configuration", details), cost]


static func _grade(score: int) -> String:
	if score >= 90:
		return "A"
	if score >= 80:
		return "B"
	if score >= 70:
		return "C"
	if score >= 60:
		return "D"
	return "F"


## Every detail of [param checks] as an issue. Every detail costs points, so each is an issue:
## `issues` was always empty beside them, and a category said passed next to the failure it had
## just found.
static func _issues(checks: Dictionary) -> Array[Dictionary]:
	var issues: Array[Dictionary] = []
	for category: String in checks:
		var check: Dictionary = checks[category]
		var found: Array[String] = check["details"]
		for detail: String in found:
			issues.append({ "check": category, "detail": detail })
	return issues
