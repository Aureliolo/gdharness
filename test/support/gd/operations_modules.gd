extends SceneTree

## Loads every module in the operations directory.
##
## Most of them are reachable only through the command dispatch, so a parse error or a preload
## that does not resolve is invisible until the one operation that owns it is asked for.
## Compiling each module here catches both, and catches them for the modules no fixture drives.

# Below this the directory has lost files rather than been tidied, and an empty walk would
# otherwise report success.
const MINIMUM_MODULES := 15


func _init() -> void:
	var failures: Array[String] = []
	var loaded := 0

	var dir := DirAccess.open("res://operations")
	if dir == null:
		printerr("res://operations could not be opened")
		quit(1)
		return

	for file_name in dir.get_files():
		if not file_name.ends_with(".gd"):
			continue

		var path := "res://operations/" + file_name
		var script = load(path)
		if script == null:
			failures.append("%s did not load" % path)
			continue
		if not script is GDScript:
			failures.append("%s loaded as %s" % [path, script.get_class()])
			continue
		loaded += 1

	if loaded < MINIMUM_MODULES:
		failures.append("only %d modules loaded, expected at least %d" % [loaded, MINIMUM_MODULES])

	if failures.is_empty():
		print(JSON.stringify({"ok": true, "modules": loaded}))
		quit(0)
		return

	printerr("\n".join(failures))
	quit(1)
