extends RefCounted

# The server reads one JSON object off stdout and everything else as diagnostics, so the
# prefixes are what let a human tell the two apart in a log without parsing it.
#
# Every module preloads this as `Log`. `Logger` is a native class from Godot 4.5 on, and a
# constant of that name is a parse error rather than a shadowing warning.

var debug_mode: bool = false


func _init(p_debug_mode: bool = false) -> void:
	debug_mode = p_debug_mode


func debug(message: String) -> void:
	if debug_mode:
		print("[DEBUG] " + message)


func info(message: String) -> void:
	print("[INFO] " + message)


func error(message: String) -> void:
	printerr("[ERROR] " + message)


# The empty result an operation hands back when it cannot answer. Every payload an operation
# builds has at least one key, so emptiness is unambiguous and the reason is already on stderr.
func failure(message: String) -> Dictionary:
	error(message)
	return {}
