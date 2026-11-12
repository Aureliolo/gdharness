extends RefCounted
## Whether a project is ready to run and export: its settings, main scene, imports, presets,
## scripts, references and signal connections, each named under checks_performed.

const GdhDependencies = preload("dependencies.gd")
const GdhExportPresets = preload("export_presets.gd")
const GdhFileWalk = preload("file_walk.gd")
const GdhImportPipeline = preload("import_pipeline.gd")
const GdhInputActions = preload("input_actions.gd")
const GdhLog = preload("logger.gd")
const GdhPatterns = preload("patterns.gd")
const GdhProjectConfig = preload("project_config.gd")
const GdhRead = preload("reading.gd")
const GdhSceneConnections = preload("scene_connections.gd")
const GdhScriptCheck = preload("script_check.gd")
const CONNECTION_FIX: String = (
	"Write the method or signal, give the method the arguments the connection passes, or point"
	+ " the connection at the one that replaced it with scene_signal"
)

var _log: GdhLog
var _files: GdhFileWalk = GdhFileWalk.new()


func _init(p_log: GdhLog) -> void:
	_log = p_log


func validate_project(params: Dictionary) -> Dictionary:
	var preset_name: String = str(params.get("preset", ""))
	var include_suggestions: bool = GdhRead.as_bool(params.get("include_suggestions", true), true)

	_log.info(
		"Validating project" + (" for preset: " + preset_name if not preset_name.is_empty() else "")
	)

	var found: GdhFindings = GdhFindings.new(include_suggestions)
	_check_settings(found)
	_check_imports(found)
	_check_presets(found, preset_name)
	_check_identity(found)
	found.checks.append("scripts")
	var script_files: Array[String] = _files.find_files_with_extensions("res://", ["gd"])
	_check_code(found, params)
	# Every script, as health reads them: cut at the first hundred in walk order, the count sat
	# beside a compile check of all 803 scripts of a game and read as how many were compiled.
	var script_issues: Array[Dictionary] = _script_notes(script_files)
	if script_issues.size() > 0:
		found.warn(
			"scripts",
			str(script_issues.size()) + " script issues found",
			"Review and resolve TODO/FIXME items before release"
		)
		var warning: Dictionary = found.warnings.back()
		warning["details"] = script_issues.slice(0, 5)

	return {
		"valid": found.issues.is_empty(),
		"issues": found.issues,
		"warnings": found.warnings,
		"checks_performed": found.checks,
		"scripts_checked": script_files.size(),
		"scripts_total": script_files.size(),
		"issue_count": found.issues.size(),
		"warning_count": found.warnings.size(),
	}


## The project file, the main scene and the text translations.
func _check_settings(found: GdhFindings) -> void:
	found.checks.append("project_file")
	if not FileAccess.file_exists("res://project.godot"):
		found.fail(
			"project_file",
			"project.godot not found",
			"Ensure you are running this from a valid Godot project directory"
		)

	found.checks.append("main_scene")
	var main_scene: String = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if main_scene.is_empty():
		found.fail(
			"main_scene",
			"No main scene set",
			"Set a main scene in Project Settings > Application > Run > Main Scene"
		)
	elif not GdhFileWalk.missing_reason(main_scene).is_empty():
		found.fail(
			"main_scene",
			"Main scene " + GdhFileWalk.missing_reason(main_scene),
			"Update the main scene setting or create the missing scene file"
		)

	found.checks.append("translations")
	var untranslated: String = GdhProjectConfig.project_text_translations()
	if not untranslated.is_empty():
		found.fail(
			"translations",
			untranslated,
			"resource_edit create each Translation at a .res path, then name that in the setting"
		)


## A file never imported is on disk, so the reference checks pass it, and still nothing loads it:
## a scene using one fails to load in a run or an export.
func _check_imports(found: GdhFindings) -> void:
	found.checks.append("imports")
	var never: Array[String] = []
	for path: String in _files.find_files_with_extensions(
		"res://", GdhImportPipeline.IMPORTABLE_EXTENSIONS
	):
		if not FileAccess.file_exists(path + ".import"):
			never.append(path)
	if not never.is_empty():
		never.sort()
		found.warn(
			"imports",
			GdhImportPipeline.never_imported_line(never),
			(
				"Run project_import reimport, or open the project in the editor, whose scan "
				+ "imports them"
			)
		)


## Whether any preset is there, and the one [param preset_name] asks about. The preset asked
## about is looked for rather than only logged: validating "for" a preset that does not exist
## answered valid, as though it had been checked.
func _check_presets(found: GdhFindings, preset_name: String) -> void:
	found.checks.append("export_presets")
	if not FileAccess.file_exists("res://export_presets.cfg"):
		found.warn(
			"export_presets",
			"No export presets configured",
			"Add a preset with project_export add_preset, or in the editor: Project > Export"
		)
	if preset_name.is_empty():
		return
	found.checks.append("export_preset")
	var named: Array[String] = GdhExportPresets.names()
	if preset_name not in named:
		found.fail(
			"export_preset",
			(
				"No export preset is named "
				+ preset_name
				+ (
					": the project has none"
					if named.is_empty()
					else ": the presets are " + ", ".join(named)
				)
			),
			"Pass one of the preset names, or add the preset with project_export add_preset"
		)
		return
	var gone: Array[String] = GdhExportPresets.missing_named(preset_name)
	if not gone.is_empty():
		found.warn(
			"export_preset_files",
			"The preset %s names files that are not there: %s" % [preset_name, "; ".join(gone)],
			"Add the files, or point the options at others with project_export set_preset"
		)


## The application's icon and name.
func _check_identity(found: GdhFindings) -> void:
	found.checks.append("icon")
	var icon_path: String = str(ProjectSettings.get_setting("application/config/icon", ""))
	if icon_path.is_empty():
		found.warn(
			"icon",
			"No application icon set",
			"Set an icon in Project Settings > Application > Config > Icon"
		)
	elif not FileAccess.file_exists(icon_path):
		found.warn(
			"icon",
			"Icon file does not exist: " + icon_path,
			"Update the icon path or add the missing icon file"
		)

	found.checks.append("project_name")
	var project_name: String = str(ProjectSettings.get_setting("application/config/name", ""))
	if project_name.is_empty():
		found.warn(
			"project_name",
			"No project name set",
			"Set a project name in Project Settings > Application > Config > Name"
		)


## What the scripts and scenes name that does not compile or is not there.
func _check_code(found: GdhFindings, params: Dictionary) -> void:
	# Compiled by the server and handed in, as for the health check: a script the engine refuses
	# stops the export's game at the first scene using it, which the comment check never saw.
	var compiled: Dictionary = params.get("compiled", {})
	if compiled.has("checked"):
		found.checks.append("compiles")
	var failures: Array = compiled.get("failures", [])
	for failure: Dictionary in failures:
		found.fail(
			"compiles",
			GdhScriptCheck.failure_line(failure),
			"script_diagnostics gives every error in it with its line"
		)

	found.checks.append("references")
	for entry: Dictionary in GdhDependencies.new(_log).missing_references():
		found.fail(
			"references",
			GdhDependencies.missing_line(entry),
			"Restore the file, or point the reference at the file that replaced it"
		)

	# An action read by a name the input map lacks answers false on every frame, so the input it
	# was for never works, and the engine says so only while the game runs.
	found.checks.append("input_actions")
	for entry: Dictionary in GdhInputActions.new(_log).undefined_in_scripts():
		found.fail(
			"input_actions",
			GdhInputActions.undefined_line(entry),
			"Add it with project_settings add_input_action, or correct the name the script reads"
		)

	# A connection whose method or signal is not there loads without a word and fails only once
	# the game runs, on every emission or not at all. The references check sees files, not members.
	found.checks.append("connections")
	for entry: Dictionary in GdhSceneConnections.new(_log).broken():
		found.warn("connections", GdhSceneConnections.broken_line(entry), CONNECTION_FIX)


## The notes each of [param script_files] holds for later work.
static func _script_notes(script_files: Array[String]) -> Array[Dictionary]:
	var script_issues: Array[Dictionary] = []
	for script_path: String in script_files:
		# An addon's notes are its authors' work, not the project's.
		if script_path.begins_with("res://addons/"):
			continue
		var file: FileAccess = FileAccess.open(script_path, FileAccess.READ)
		if not file:
			continue
		var content: String = file.get_as_text()
		file.close()
		var noted: Array[String] = GdhPatterns.noted_work(content)
		if not noted.is_empty():
			script_issues.append({ "path": script_path, "issue": "Contains TODO/FIXME comments" })
		if "pass" in noted:
			script_issues.append(
				{ "path": script_path, "issue": "Contains unimplemented functions" }
			)
	return script_issues


## What the checks found: errors that fail the project, warnings that do not, and the checks run.
class GdhFindings:
	var issues: Array[Dictionary] = []
	var warnings: Array[Dictionary] = []
	var checks: Array[String] = []
	var _suggest: bool

	func _init(suggest: bool) -> void:
		_suggest = suggest

	func fail(check: String, message: String, suggestion: String) -> void:
		issues.append(_finding("error", check, message, suggestion))

	func warn(check: String, message: String, suggestion: String) -> void:
		warnings.append(_finding("warning", check, message, suggestion))

	func _finding(type: String, check: String, message: String, suggestion: String) -> Dictionary:
		var finding: Dictionary = { "type": type, "check": check, "message": message }
		if _suggest:
			finding["suggestion"] = suggestion
		return finding
