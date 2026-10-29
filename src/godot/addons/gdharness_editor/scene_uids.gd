@tool
extends RefCounted
## How a scene or resource a tool saves keeps naming files by uid, as the editor's saves do.

## The files a headless save named by path alone because the uid cache holds no uid for them,
## gathered for the answer to the call that saved, the one call its engine runs.
static var by_path: PackedStringArray = []


## Saves [param resource] at [param file_path], keeping the uid the file already has.
##
## The editor saves through its uid cache, which knows every file's. A headless engine that has not
## imported the project has none, and a resave dropped the uid from the header, so every reference
## made through it stopped resolving. Read from the file itself, since the loader does not answer it
## for a text scene there, and a new file is given one as the editor gives it.
static func save_keeping_uid(resource: Resource, file_path: String) -> Error:
	if Engine.is_editor_hint():
		return ResourceSaver.save(resource, file_path)
	var uid: int = uid_in(file_path)
	var saving: Error = ResourceSaver.save(resource, file_path)
	if saving != OK:
		return saving
	if uid == ResourceUID.INVALID_ID:
		uid = ResourceUID.create_id()
	var marked: Error = ResourceSaver.set_uid(file_path, uid)
	if marked != OK:
		return marked
	return _as_the_editor_writes(file_path)


## Writes the text file at [param file_path] as the editor's save would have.
##
## Only the editor's file system tells the saver a path's uid, so a headless save writes every
## reference by path alone, and each breaks when the file it names is moved: the uid is put back on
## each external resource.
##
## The saver leaves out a shader parameter holding the default the renderer gives it, and a headless
## engine's renderer gives none, so every parameter a ShaderMaterial never set was written as null.
## Loading null clears the parameter, so the line changes nothing, and the editor drops it again.
static func _as_the_editor_writes(file_path: String) -> Error:
	if not (file_path.ends_with(".tscn") or file_path.ends_with(".tres")):
		return OK
	var lines: PackedStringArray = FileAccess.get_file_as_string(file_path).split("\n")
	var pattern: RegEx = RegEx.create_from_string(' path="([^"]+)"')
	var unset: RegEx = RegEx.create_from_string("^shader_parameter/\\S+ = null$")
	var kept: PackedStringArray = []
	var changed: bool = false
	for line: String in lines:
		if unset.search(line) != null:
			changed = true
			continue
		var named: RegExMatch = (
			pattern.search(line)
			if line.begins_with("[ext_resource ") and not line.contains(' uid="')
			else null
		)
		var uid: String = "" if named == null else reference_uid(named.get_string(1))
		if not uid.is_empty():
			line = line.replace(' path="', uid + ' path="')
			changed = true
		var _added: bool = kept.append(line)
	lines = kept
	if not changed:
		return OK
	var file: FileAccess = FileAccess.open(file_path, FileAccess.WRITE)
	if file == null:
		return FileAccess.get_open_error()
	if not file.store_string("\n".join(lines)):
		return ERR_FILE_CANT_WRITE
	file.close()
	return OK


## [method uid_attribute] for a reference about to be written, noting [param named] under
## [member by_path] when it is left to be named by path.
static func reference_uid(named: String) -> String:
	var uid: String = uid_attribute(named)
	if uid.is_empty():
		note_by_path(named)
	return uid


## Notes [param named], a reference just written by path alone, under [member by_path] when the uid
## cache holds nothing for it: a file made since the project was last scanned, whose uid the cache
## learns from the next scan. Not a file whose uid the cache gives to another, which a scan leaves.
static func note_by_path(named: String) -> void:
	if Engine.is_editor_hint() or not FileAccess.file_exists(named) or by_path.has(named):
		return
	var own: int = uid_in(named)
	if own == ResourceUID.INVALID_ID and FileAccess.file_exists(named + ".uid"):
		own = ResourceUID.text_to_id(FileAccess.get_file_as_string(named + ".uid").strip_edges())
	if own == ResourceUID.INVALID_ID or not ResourceUID.has_id(own):
		var _noted: bool = by_path.append(named)


## The uid attribute a reference to [param named] is written with, as ' uid="uid://..."', or "".
##
## Only a uid the uid cache gives that path, which is what the loader resolves it by. A uid the
## cache does not know (a file made with no editor since the last scan) is answered with a warning
## on every load, and one it gives another file (a scene copied whole keeps its original's) loads
## that file.
static func uid_attribute(named: String) -> String:
	var id: int = ResourceLoader.get_resource_uid(named)
	if (
		id == ResourceUID.INVALID_ID
		or not ResourceUID.has_id(id)
		or ResourceUID.get_id_path(id) != named
	):
		return ""
	return ' uid="%s"' % ResourceUID.id_to_text(id)


## The uid the file at [param file_path] declares, or [constant ResourceUID.INVALID_ID].
static func uid_in(file_path: String) -> int:
	if not FileAccess.file_exists(file_path):
		return ResourceUID.INVALID_ID
	var file: FileAccess = FileAccess.open(file_path, FileAccess.READ)
	if file != null:
		var header: RegExMatch = RegEx.create_from_string('uid="(uid://[a-z0-9]+)"').search(
			file.get_line()
		)
		file.close()
		if header != null:
			return ResourceUID.text_to_id(header.get_string(1))
	return ResourceLoader.get_resource_uid(file_path)
