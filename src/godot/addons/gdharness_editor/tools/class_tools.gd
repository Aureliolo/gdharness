@tool
extends Node

## The global classes the running editor is holding.
##
## The editor fixes this list when it starts and adds to it only from a filesystem scan, and
## that scan is change-detecting: a file another engine has already imported looks settled, so
## the walk goes past it without reading the declaration inside. The class is then declared on
## disk, listed in `.godot/global_script_class_cache.cfg`, and absent from the editor, whose
## analyser reports every use of it as an unknown identifier. Rebuilding the cache does not
## help, because nothing rereads it.
##
## Every check there was compares one file on disk against another, so all of them call that
## state clean. The editor is the only thing that can say otherwise, so it is asked.
##
## Read off the editor's own filesystem entries rather than from
## `ProjectSettings.get_global_class_list()`. The entries are what the scan itself recorded, so
## nothing but a scan can change them; the settings list is loaded from the cache file when it is
## first asked for, which makes it a poor witness against a cache that was just rewritten, and
## rewriting the cache is the call most in need of an honest answer here.
##
## A file the scan skipped is either missing from the tree or recorded with no class name against
## it, and both come back as a class the editor does not have, which is the whole of the question.

var _editor_plugin: EditorPlugin = null


func set_editor_plugin(plugin: EditorPlugin) -> void:
	_editor_plugin = plugin


## Recompiles a script the editor is already holding, in place.
##
## The fault this exists for: a script the editor has loaded keeps the copy it compiled, and that
## copy is refreshed when one of its own dependencies changes rather than when it changes itself.
## So a method added to a loaded class is reported missing at every caller until something
## recompiles it, and a filesystem scan does not, because the scan updates what the editor knows
## about files rather than what it has already built from them.
##
## `reload` is the only call that reaches the built copy. It recompiles from source into the same
## object, so everything holding a reference sees the new version rather than a second one, which
## is the whole point: the holders are why the stale copy survived a scan.
##
## `keep_state` is true so instances that already exist keep their properties. A caller asking for
## this is mid-edit with a scene open, and dropping the state of every node using the script would
## be a larger surprise than the wrong diagnostic it is here to clear.
##
## The list of methods afterwards is the evidence rather than an `ok` beside it. A reload that
## returned OK and compiled nothing is exactly the failure worth catching, and the members it now
## has are the only thing that can tell those apart.
func reload_script(args: Dictionary) -> Dictionary:
	var path: String = str(args.get("scriptPath", ""))
	if path.is_empty():
		return {"ok": false, "error": "scriptPath is required"}
	if not ResourceLoader.exists(path):
		return {"ok": false, "error": "No script at " + path}

	var loaded: Resource = load(path)
	var script: GDScript = loaded as GDScript
	if script == null:
		return {"ok": false, "error": path + " is not a GDScript"}

	# What the copy had before anything touched it, which is the reading that shows the fault rather
	# than the one that mends it. Without it a caller cannot tell a copy that was already current
	# from one this call repaired, and those are different facts about their editor.
	var held: Array[String] = _method_names(script)

	# The source is read off disk and put back before reloading, which is the whole of the fix and
	# is not obvious. `reload` recompiles from the object's own `source_code`, not from the file, so
	# a script the editor loaded before the change recompiles the text it was holding and comes back
	# with exactly the members it already had. Measured: reloading without this answers OK and the
	# method added since is still absent from the method list.
	var reader: FileAccess = FileAccess.open(path, FileAccess.READ)
	if reader == null:
		return {"ok": false, "error": "Could not read " + path + ": " + str(FileAccess.get_open_error())}
	script.source_code = reader.get_as_text()
	reader.close()

	var failed: Error = script.reload(true)
	if failed != OK:
		return {"ok": false, "error": "Reloading " + path + " answered error " + str(failed)}

	return {"ok": true, "script": path, "heldBefore": held, "methods": _method_names(script)}


func _method_names(script: GDScript) -> Array[String]:
	var names: Array[String] = []
	for entry: Dictionary in script.get_script_method_list():
		names.append(str(entry.get("name", "")))
	names.sort()
	return names


func global_classes(_args: Dictionary) -> Dictionary:
	if not _editor_plugin:
		return {"ok": false, "error": "Editor plugin unavailable"}

	var filesystem: EditorFileSystem = EditorInterface.get_resource_filesystem()
	var names: Array[String] = []
	_walk(filesystem.get_filesystem(), names)
	names.sort()
	return {
		"ok": true,
		"classes": names,
		"scanning": filesystem.is_scanning(),
		"importing": filesystem.is_importing(),
	}


# Array[String] rather than PackedStringArray: appending to a packed array answers with whether it
# worked, and a project holding return_value_discarded at error level refuses a script that drops
# that answer. Both reach the caller as the same list of strings.
func _walk(directory: EditorFileSystemDirectory, into: Array[String]) -> void:
	if directory == null:
		return
	for index: int in range(directory.get_file_count()):
		var declared: String = directory.get_file_script_class_name(index)
		if not declared.is_empty():
			into.append(declared)
	for index: int in range(directory.get_subdir_count()):
		_walk(directory.get_subdir(index), into)
