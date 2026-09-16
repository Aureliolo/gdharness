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
## `ProjectSettings.get_global_class_list()` is the list rather than a walk of the filesystem
## entries, because it is the one the editor hands to the script server: the analyser resolves
## a bare identifier against that, so it is what decides whether a use of the class is an error.

var _editor_plugin: EditorPlugin = null


func set_editor_plugin(plugin: EditorPlugin) -> void:
	_editor_plugin = plugin


func global_classes(_args: Dictionary) -> Dictionary:
	if not _editor_plugin:
		return {"ok": false, "error": "Editor plugin unavailable"}

	var names: PackedStringArray = []
	for entry: Variant in ProjectSettings.get_global_class_list():
		if entry is Dictionary:
			var fields: Dictionary = entry
			names.append(str(fields.get("class", "")))
	names.sort()

	var filesystem: EditorFileSystem = EditorInterface.get_resource_filesystem()
	return {
		"ok": true,
		"classes": names,
		"scanning": filesystem.is_scanning(),
		"importing": filesystem.is_importing(),
	}
