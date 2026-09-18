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
