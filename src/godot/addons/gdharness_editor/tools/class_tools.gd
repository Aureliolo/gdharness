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
	var asked: String = str(args.get("scriptPath", ""))
	if asked.is_empty():
		return {"ok": false, "error": "scriptPath is required"}
	var path: String = _spelled_as_on_disk(asked)
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
	var held_constants: Array[String] = _constant_names(script)

	# The source is read off disk and put back before reloading, which is the whole of the fix and
	# is not obvious. `reload` recompiles from the object's own `source_code`, not from the file, so
	# a script the editor loaded before the change recompiles the text it was holding and comes back
	# with exactly the members it already had. Measured: reloading without this answers OK and the
	# method added since is still absent from the method list.
	var reader: FileAccess = FileAccess.open(path, FileAccess.READ)
	if reader == null:
		return {"ok": false, "error": "Could not read " + path + ": " + str(FileAccess.get_open_error())}
	var previous: String = script.source_code
	script.source_code = reader.get_as_text()
	reader.close()

	# A reload that fails is still answered as a call that ran, because the readings are what a
	# caller needs then: a failure travels back as its message alone, and a project met one and
	# could not tell whether the copy had been damaged by it or before it.
	#
	# And the old text is compiled again. A failed reload leaves the object unusable while its member
	# lists read as before, measured on 4.7.2: it can make no instance, and an instance it already made
	# has lost its methods, and the old text put back uncompiled leaves it that way. Compiling the text
	# it was built from puts it back, and whether that worked is said, since the text may no longer
	# compile against what it names.
	var failed: Error = script.reload(true)
	var answer: Dictionary = {
		"ok": true,
		"script": path,
		"failed": failed,
		"failedAs": error_string(failed) if failed != OK else "",
		"heldBefore": held,
		"heldConstantsBefore": held_constants,
	}
	if failed != OK:
		script.source_code = previous
		var restored: Error = script.reload(true)
		answer["restored"] = restored == OK
		if restored != OK:
			answer["restoredAs"] = error_string(restored)
	answer["methods"] = _method_names(script)
	answer["constants"] = _constant_names(script)
	return answer


## [param path] as the files on disk spell it, a step at a time, or as given where a step is not
## there. On a filesystem that ignores case, `res://Core/Rules.gd` opens the file at
## `res://core/rules.gd`, but the editor holds its copy under the spelling on disk, and a load by
## another spelling misses that copy and compiles a new one: reloading that answers with a fresh
## compile's members and leaves the copy the editor holds as it was.
static func _spelled_as_on_disk(path: String) -> String:
	var local: String = ProjectSettings.localize_path(path)
	if not local.begins_with("res://"):
		return local
	var spelled: String = "res://"
	for step: String in local.trim_prefix("res://").split("/", false):
		var listing: DirAccess = DirAccess.open(spelled)
		if listing == null:
			return local
		var found: String = ""
		for entry: String in listing.get_directories() + listing.get_files():
			if entry == step:
				found = entry
				break
			if found.is_empty() and entry.nocasecmp_to(step) == 0:
				found = entry
		if found.is_empty():
			return local
		spelled = spelled.path_join(found)
	return spelled


func _method_names(script: GDScript) -> Array[String]:
	var names: Array[String] = []
	for entry: Dictionary in script.get_script_method_list():
		names.append(str(entry.get("name", "")))
	names.sort()
	return names


## The script's own constants, and the keys of each one that is a Dictionary as `Kind.SHORT`, which
## is how the copy holds a named enum: a stale enum member is denied as a member of the enum rather
## than of the class. A constant Dictionary that is not an enum is listed the same way, since the
## map does not tell the two apart.
func _constant_names(script: GDScript) -> Array[String]:
	var names: Array[String] = []
	var constants: Dictionary = script.get_script_constant_map()
	for named: Variant in constants:
		var value: Variant = constants[named]
		names.append(str(named))
		if value is Dictionary:
			var values: Dictionary = value
			for member: Variant in values:
				names.append("%s.%s" % [named, member])
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
