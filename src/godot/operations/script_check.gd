extends RefCounted

## Compiles scripts the way the engine does when it loads them, and answers what it raised.
##
## The engine reports a script that does not compile as errors raised from GDScript::reload, each
## naming the file and line, and they reach a Logger as well as stderr. Measured on 4.7.2: a script
## whose dependency does not compile reports the dependency's errors at the dependency's path and one
## of its own at line 0, "Compile Error: Failed to compile depended scripts", and is still handed
## back as a script that can_instantiate() calls instantiable. Warnings are not among them: the engine
## sends those only to an editor or a debugger.
##
## A script that failed stays failed in the engine's script cache, which no ResourceLoader cache mode
## reaches, and every script loaded after it that depends on it compiles in silence, reload() and all.
## So a run ends at the first script that raised anything, and the rest go to a fresh engine.

const GdhRead = preload("reading.gd")
const GdhLog = preload("logger.gd")

## Where the engine raises a script's compile errors from.
const RELOAD: String = "GDScript::reload"

var _log: GdhLog


## Every compile error the engine raises while it is attached, in order.
class GdhCaught:
	extends Logger

	var raised: Array[Dictionary] = []

	func _log_message(_message: String, _error: bool) -> void:
		pass

	# The engine's own signature for a Logger, eight parameters and not this project's to shape.
	# gdlint:ignore = function-arguments-number
	func _log_error(
		function: String,
		file: String,
		line: int,
		code: String,
		rationale: String,
		_editor_notify: bool,
		_error_type: int,
		_script_backtraces: Array[ScriptBacktrace],
	) -> void:
		if function != RELOAD:
			return
		raised.append(
			{"path": file, "line": line, "message": rationale if not rationale.is_empty() else code}
		)


func _init(p_log: GdhLog) -> void:
	_log = p_log


## One line for [param failure], a script [method check_scripts] answered as failing, with its
## first error and the note the server put on it.
static func failure_line(failure: Dictionary) -> String:
	var errors: Array = failure.get("errors", [])
	var said: String = "%s does not compile" % str(failure.get("path", ""))
	if not errors.is_empty():
		var first: Dictionary = errors[0]
		var line: int = GdhRead.as_int(first.get("line", 0))
		var message: String = str(first.get("message", ""))
		said += ": line %d, %s" % [line, message] if line > 0 else ": " + message
		if errors.size() > 1:
			said += " (and %d more)" % (errors.size() - 1)
	var note: String = str(failure.get("note", ""))
	return said if note.is_empty() else "%s %s" % [said, note]


## Whether the scripts in [code]paths[/code] compile in a fresh engine, which reads the class cache
## as it starts and so resolves every class the cache lists, up to and including the first that
## raised an error. [code]checked[/code] names the scripts read, in order, and [code]failed[/code]
## those that did not compile; [code]scripts[/code] holds each failed one with the errors raised in
## its own file, and the other scripts that failed to compile while it was loaded. Read past the
## resource cache, so a script loaded for an earlier one is compiled again for its own entry.
func check_scripts(params: Dictionary) -> Dictionary:
	var asked: Array = params.get("paths", [])
	var caught: GdhCaught = GdhCaught.new()
	OS.add_logger(caught)
	var checked: Array[String] = []
	var failed: Array[String] = []
	var scripts: Array[Dictionary] = []
	for entry: Variant in asked:
		var path: String = str(entry)
		checked.append(path)
		caught.raised.clear()
		var loaded: Resource = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
		var errors: Array[Dictionary] = []
		var others: Array[String] = []
		for error: Dictionary in caught.raised:
			var at: String = str(error["path"])
			if at != path:
				if not at in others:
					others.append(at)
				continue
			var found: Dictionary = {"line": GdhRead.as_int(error["line"]), "message": str(error["message"])}
			if not found in errors:
				errors.append(found)
		if loaded == null and errors.is_empty():
			errors.append({"line": 0, "message": "The engine could not load it as a script."})
		if errors.is_empty() and others.is_empty():
			continue
		if not errors.is_empty():
			failed.append(path)
			var one: Dictionary = {"path": path, "errors": errors}
			if not others.is_empty():
				one["dependencies_with_errors"] = others
			scripts.append(one)
		break
	OS.remove_logger(caught)
	return {"checked": checked, "failed": failed, "scripts": scripts}
