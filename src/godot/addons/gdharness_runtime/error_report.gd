extends Logger

## Every error the engine reports inside this game, written to a file beside the announcement,
## in the lines the engine itself prints to stderr.
##
## A game the editor plays prints to the editor's own stderr, which nobody reads: a `push_error`
## raised in one reached neither `editor_output` nor the run's transcript, and the run was
## answered clean while the game had just refused something out loud. The debug adapter relays
## what the game prints and not what it reports, so the report is taken where it is made, in
## the game, and left where the server already looks. The lines are the engine's own so the
## server reads them the way it reads a run it started itself.

var _path: String


func _init(path: String) -> void:
	_path = path


func _log_error(
	function: String,
	file: String,
	line: int,
	code: String,
	rationale: String,
	_editor_notify: bool,
	error_type: int,
	script_backtraces: Array[ScriptBacktrace],
) -> void:
	var kind: String
	match error_type:
		ERROR_TYPE_WARNING:
			kind = "WARNING"
		ERROR_TYPE_SCRIPT:
			kind = "SCRIPT ERROR"
		ERROR_TYPE_SHADER:
			kind = "SHADER ERROR"
		_:
			kind = "ERROR"
	var lines: Array[String] = [
		"%s: %s" % [kind, rationale if not rationale.is_empty() else code],
		"   at: %s (%s:%d)" % [function, file, line],
	]
	for backtrace: ScriptBacktrace in script_backtraces:
		lines.append(backtrace.format(3))
	# Opened for each report rather than held, so the file is whole on disk after every one:
	# the last error a game reports is the one a caller most needs, and the game may be gone the
	# moment after. Nothing here may report an error of its own, which would come straight back.
	var report: FileAccess = (
		FileAccess.open(_path, FileAccess.READ_WRITE)
		if FileAccess.file_exists(_path)
		else FileAccess.open(_path, FileAccess.WRITE)
	)
	if report == null:
		return
	report.seek_end()
	for each: String in lines:
		# A line the disk would not take is a report lost, and nothing here may report that.
		var _stored: bool = report.store_line(each)
	report.close()
