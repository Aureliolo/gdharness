extends SceneTree

## Every shipped script parsed under the project's warning settings, where an untyped
## declaration is an error. A script that will not parse prints the reason to stderr, which is
## what the runner reads; this only reports which files did not load, and how many it tried,
## so the caller can tell a clean run from one that found nothing to check.

var failures: Array[String] = []


func _init() -> void:
	var scripts: Array[String] = _scripts("res://operations") + _scripts("res://addons")
	for path: String in scripts:
		var script: Script = load(path)
		if script == null or not script.can_instantiate():
			failures.append(path)

	if failures.is_empty():
		print(JSON.stringify({"ok": true, "checked": scripts.size()}))
		quit(0)
		return

	printerr("\n".join(failures))
	quit(1)


func _scripts(directory: String) -> Array[String]:
	var found: Array[String] = []
	var dir: DirAccess = DirAccess.open(directory)
	if dir == null:
		return found
	if dir.list_dir_begin() != OK:
		return found
	var entry: String = dir.get_next()
	while not entry.is_empty():
		var path: String = directory.path_join(entry)
		if dir.current_is_dir():
			found.append_array(_scripts(path))
		elif entry.ends_with(".gd"):
			found.append(path)
		entry = dir.get_next()
	dir.list_dir_end()
	return found
