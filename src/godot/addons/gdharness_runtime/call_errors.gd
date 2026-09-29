extends Logger

## What the engine reports on the main thread while one call runs, added for that call alone.
##
## A call the engine refuses, given too few arguments or one it will not convert, comes back from
## `callv` as null, which is also what a method that ran and returned nothing answers, and the
## engine's reason goes only to the game's output. Measured on 4.7.2: each refusal is one error from
## `callv` whose text begins with [constant REFUSED]. Anything else reported while the call runs is
## the method's own, raised on its way through.

const REFUSED: String = "Error calling method from 'callv': "

## The engine's reason for refusing the call, without [constant REFUSED], or "" when it ran.
var refused: String = ""
## What was reported while it ran, a line each, warnings marked as such.
var raised: Array[String] = []


func _log_message(_message: String, _error: bool) -> void:
	pass


# The engine's own signature for a Logger, eight parameters and not this project's to shape.
# gdlint:ignore = function-arguments-number
func _log_error(
	function: String,
	_file: String,
	_line: int,
	code: String,
	rationale: String,
	_editor_notify: bool,
	error_type: int,
	_script_backtraces: Array[ScriptBacktrace],
) -> void:
	# Another thread's report in the same moment is not the call's.
	if OS.get_thread_caller_id() != OS.get_main_thread_id():
		return
	var text: String = rationale if not rationale.is_empty() else code
	if function == "callv" and text.begins_with(REFUSED) and refused.is_empty():
		refused = text.trim_prefix(REFUSED)
		return
	raised.append(("WARNING: " if error_type == ERROR_TYPE_WARNING else "") + text)
