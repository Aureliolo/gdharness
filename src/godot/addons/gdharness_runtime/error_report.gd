extends Logger

## The console of a game the editor plays, errors and prints in the order the engine made them,
## written to a file beside the announcement in the lines the engine itself prints.
##
## A game the editor plays prints to the editor's own stderr, which nobody reads: a `push_error`
## raised in one reached neither `editor_output` nor the run's transcript, and the run was
## answered clean while the game had just refused something out loud. The debug adapter relays
## what the game prints and not what it reports, so the report is taken where it is made, in
## the game, and left where the server already looks. The lines are the engine's own so the
## server reads them the way it reads a run it started itself.
##
## Prints as well, once [method take_the_console] is called: the adapter's prints and this file's
## errors are two streams, and read side by side a warning raised before a print was put after
## it. One file written from inside the game has one order, the engine's.

var _path: String
var _file: FileAccess = null
var _console: bool = false
## Held across a write, because the engine logs from whichever thread printed.
var _mutex: Mutex = Mutex.new()
## Set while writing, so a failure the write itself logs does not come straight back in here.
var _writing: bool = false


func _init(path: String) -> void:
	_path = path


## Writes every print from here on as well as the errors, and prints [param boundary], which is
## therefore the first print in the file and the last one the server takes from the adapter.
func take_the_console(boundary: String) -> void:
	_mutex.lock()
	_console = true
	_mutex.unlock()
	print(boundary)


## Lets go of the file, once the Logger has been removed and nothing more will be written.
func close() -> void:
	_mutex.lock()
	if _file != null:
		_file.close()
		_file = null
	_mutex.unlock()


func _log_message(message: String, _error: bool) -> void:
	_mutex.lock()
	if _console:
		_write(message if message.ends_with("\n") else message + "\n")
	_mutex.unlock()


# The engine's own signature for a Logger, eight parameters and not this project's to shape.
# gdlint:ignore = function-arguments-number
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
	_mutex.lock()
	_write("\n".join(lines) + "\n")
	_mutex.unlock()


## Appends [param text] and flushes it, so the file is whole on disk after every entry: the last
## thing a game reports is the one a caller most needs, and the game may be gone the moment after.
## Held open rather than opened for each entry, because a game printing every frame would open the
## file sixty times a second. Called with the mutex held.
func _write(text: String) -> void:
	if _writing:
		return
	_writing = true
	if _file == null:
		_file = (
			FileAccess.open(_path, FileAccess.READ_WRITE)
			if FileAccess.file_exists(_path)
			else FileAccess.open(_path, FileAccess.WRITE)
		)
		if _file != null:
			_file.seek_end()
	if _file != null:
		# A line the disk would not take is a report lost, and nothing here may report that.
		var _stored: bool = _file.store_string(text)
		_file.flush()
	_writing = false
