extends RefCounted
## Whether a project is ready to run and export: its settings, main scene, imports, presets,
## scripts, references and signal connections, each named under checks_performed.

const GdhDependencies = preload("dependencies.gd")
const GdhExportPresets = preload("export_presets.gd")
const GdhFileWalk = preload("file_walk.gd")
const GdhImportPipeline = preload("import_pipeline.gd")
const GdhInputActions = preload("input_actions.gd")
const GdhLog = preload("logger.gd")
const GdhRead = preload("reading.gd")
const GdhSceneConnections = preload("scene_connections.gd")
const GdhScriptCheck = preload("script_check.gd")
const CONNECTION_FIX: String = (
	"Write the method or signal, or point the connection at the one that replaced it with"
	+ " scene_signal"
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

	var issues: Array[Dictionary] = []
	var warnings: Array[Dictionary] = []
	var checks_performed: Array[String] = []

	checks_performed.append("project_file")
	if not FileAccess.file_exists("res://project.godot"):
		issues.append(
			_finding(
				"error",
				"project_file",
				"project.godot not found",
				"Ensure you are running this from a valid Godot project directory",
				include_suggestions
			)
		)

	checks_performed.append("main_scene")
	var main_scene: String = str(ProjectSettings.get_setting("application/run/main_scene", ""))
	if main_scene.is_empty():
		issues.append(
			_finding(
				"error",
				"main_scene",
				"No main scene set",
				"Set a main scene in Project Settings > Application > Run > Main Scene",
				include_suggestions
			)
		)
	elif not GdhFileWalk.missing_reason(main_scene).is_empty():
		issues.append(
			_finding(
				"error",
				"main_scene",
				"Main scene " + GdhFileWalk.missing_reason(main_scene),
				"Update the main scene setting or create the missing scene file",
				include_suggestions
			)
		)

	# A file never imported is on disk, so the reference checks pass it, and still nothing loads it:
	# a scene using one fails to load in a run or an export.
	checks_performed.append("imports")
	var never: Array[String] = []
	for path: String in _files.find_files_with_extensions(
		"res://", GdhImportPipeline.IMPORTABLE_EXTENSIONS
	):
		if not FileAccess.file_exists(path + ".import"):
			never.append(path)
	if not never.is_empty():
		never.sort()
		(
			warnings
			. append(
				_finding(
					"warning",
					"imports",
					GdhImportPipeline.never_imported_line(never),
					"Run project_import reimport, or open the project in the editor, whose scan "
					+ "imports them",
					include_suggestions
				)
			)
		)

	checks_performed.append("export_presets")
	if not FileAccess.file_exists("res://export_presets.cfg"):
		warnings.append(
			_finding(
				"warning",
				"export_presets",
				"No export presets configured",
				"Add a preset with project_export add_preset, or in the editor: Project > Export",
				include_suggestions
			)
		)

	# The preset asked about is looked for rather than only logged: validating "for" a preset that
	# does not exist answered valid, as though it had been checked.
	if not preset_name.is_empty():
		checks_performed.append("export_preset")
		var named: Array[String] = GdhExportPresets.names()
		if preset_name not in named:
			(
				issues
				. append(
					_finding(
						"error",
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
						"Pass one of the preset names, or add the preset with project_export "
						+ "add_preset",
						include_suggestions
					)
				)
			)
		else:
			var gone: Array[String] = GdhExportPresets.missing_named(preset_name)
			if not gone.is_empty():
				(
					warnings
					. append(
						_finding(
							"warning",
							"export_preset_files",
							(
								"The preset %s names files that are not there: %s"
								% [preset_name, "; ".join(gone)]
							),
							"Add the files, or point the options at others with project_export "
							+ "set_preset",
							include_suggestions
						)
					)
				)

	checks_performed.append("icon")
	var icon_path: String = str(ProjectSettings.get_setting("application/config/icon", ""))
	if icon_path.is_empty():
		warnings.append(
			_finding(
				"warning",
				"icon",
				"No application icon set",
				"Set an icon in Project Settings > Application > Config > Icon",
				include_suggestions
			)
		)
	elif not FileAccess.file_exists(icon_path):
		warnings.append(
			_finding(
				"warning",
				"icon",
				"Icon file does not exist: " + icon_path,
				"Update the icon path or add the missing icon file",
				include_suggestions
			)
		)

	checks_performed.append("project_name")
	var project_name: String = str(ProjectSettings.get_setting("application/config/name", ""))
	if project_name.is_empty():
		warnings.append(
			_finding(
				"warning",
				"project_name",
				"No project name set",
				"Set a project name in Project Settings > Application > Config > Name",
				include_suggestions
			)
		)

	checks_performed.append("scripts")
	var script_files: Array[String] = _files.find_files_with_extensions("res://", ["gd"])
	var scripts_checked: int = 0
	var script_issues: Array[Dictionary] = []

	# A hundred scripts is enough to say whether the project is tidy without a large one
	# turning validation into a full read of its source tree.
	for script_path: String in script_files.slice(0, 100):
		scripts_checked += 1
		var file: FileAccess = FileAccess.open(script_path, FileAccess.READ)
		if file:
			var content: String = file.get_as_text()
			file.close()

			if "# TODO" in content or "# FIXME" in content:
				script_issues.append(
					{ "path": script_path, "issue": "Contains TODO/FIXME comments" }
				)
			if "pass # TODO" in content:
				script_issues.append(
					{ "path": script_path, "issue": "Contains unimplemented functions" }
				)

	# Compiled by the server and handed in, as for the health check: a script the engine refuses
	# stops the export's game at the first scene using it, which the comment check above never saw.
	var compiled: Dictionary = params.get("compiled", {})
	if compiled.has("checked"):
		checks_performed.append("compiles")
	var failures: Array = compiled.get("failures", [])
	for failure: Dictionary in failures:
		issues.append(
			_finding(
				"error",
				"compiles",
				GdhScriptCheck.failure_line(failure),
				"script_diagnostics gives every error in it with its line",
				include_suggestions
			)
		)

	checks_performed.append("references")
	for entry: Dictionary in GdhDependencies.new(_log).missing_references():
		issues.append(
			_finding(
				"error",
				"references",
				GdhDependencies.missing_line(entry),
				"Restore the file, or point the reference at the file that replaced it",
				include_suggestions
			)
		)

	# An action read by a name the input map lacks answers false on every frame, so the input it was
	# for never works, and the engine says so only while the game runs.
	checks_performed.append("input_actions")
	for entry: Dictionary in GdhInputActions.new(_log).undefined_in_scripts():
		(
			issues
			. append(
				_finding(
					"error",
					"input_actions",
					GdhInputActions.undefined_line(entry),
					"Add it with project_settings add_input_action, or correct the name the script "
					+ "reads",
					include_suggestions
				)
			)
		)

	# A connection whose method or signal is not there loads without a word and fails only once the
	# game runs, on every emission or not at all; the references check sees files, not members.
	checks_performed.append("connections")
	for entry: Dictionary in GdhSceneConnections.new(_log).broken():
		warnings.append(
			_finding(
				"warning",
				"connections",
				GdhSceneConnections.broken_line(entry),
				CONNECTION_FIX,
				include_suggestions
			)
		)

	if script_issues.size() > 0:
		var warning: Dictionary = _finding(
			"warning",
			"scripts",
			str(script_issues.size()) + " script issues found",
			"Review and resolve TODO/FIXME items before release",
			include_suggestions
		)
		warning["details"] = script_issues.slice(0, 5)
		warnings.append(warning)

	return {
		"valid": issues.is_empty(),
		"issues": issues,
		"warnings": warnings,
		"checks_performed": checks_performed,
		"scripts_checked": scripts_checked,
		# Said beside the count, so a project of four hundred scripts is not read as checked whole.
		"scripts_total": script_files.size(),
		"issue_count": issues.size(),
		"warning_count": warnings.size(),
	}


func _finding(
	type: String, check: String, message: String, suggestion: String, include_suggestion: bool
) -> Dictionary:
	var finding: Dictionary = { "type": type, "check": check, "message": message }
	if include_suggestion:
		finding["suggestion"] = suggestion
	return finding
