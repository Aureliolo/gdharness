@tool
extends RefCounted

const GdhRead = preload("reading.gd")

# Two walks rather than one because they disagree about hidden entries on purpose: a suffix
# walk descends into every visible directory and matches whole names, while the extension walk
# skips anything beginning with a dot, including .import sidecars that would otherwise answer
# for the resource they belong to.
#
# Both stop at a `.gdignore` and at a directory below their start holding a project.godot, because
# the engine does: nothing under either is imported, so what is in there is not a resource, not a
# dependency and not a global class. Walking in anyway hands every caller files the engine will
# never answer for.


# Why [param path], a res:// or uid:// path a setting names, is not a file the engine can load, or
# empty when it is. A uid:// path resolves through the project's uid cache, which the import writes,
# so one that does not resolve is a file that has gone or a project not imported yet, and saying
# only that the file does not exist sent a caller looking for a scene that was there.
static func missing_reason(path: String) -> String:
	if path.begins_with("uid://"):
		var id: int = ResourceUID.text_to_id(path)
		if id == ResourceUID.INVALID_ID or not ResourceUID.has_id(id):
			return (
				path
				+ " does not resolve: no file in the project's uid cache has it, so the file has "
				+ "gone or the project has not been imported yet (project_import refresh_uids "
				+ "imports it)"
			)
		var resolved: String = ResourceUID.get_id_path(id)
		return (
			""
			if FileAccess.file_exists(resolved)
			else path + " names " + resolved + ", which does not exist"
		)
	return "" if FileAccess.file_exists(path) else path + " does not exist"


## [param said], the refusal for [param path], a res:// path nothing is at, with the files of its
## extension whose names are nearest its own, or every one when there are few and none is near, so
## the caller has a path to send instead. Files of the same name beside it come first, since a
## misspelt extension has no file of its own extension to be near.
func with_nearest_files(said: String, path: String) -> String:
	# One the refusal names is the file it refuses, as a script given for a scene is. Word by word,
	# since res://brain.gd is inside res://brain.gdd.
	var named: Array[String] = []
	for word: String in said.replace("\n", " ").replace(",", " ").replace(";", " ").split(
		" ", false
	):
		named.append(word.rstrip(".:"))
	var namesakes: Array[String] = []
	for file: String in _namesakes(path):
		if not file in named:
			namesakes.append(file)
	if not namesakes.is_empty():
		var alone: bool = namesakes.size() == 1
		return (
			"%s. %s %s that name with %s."
			% [
				said,
				", ".join(namesakes),
				"has" if alone else "have",
				"another extension" if alone else "other extensions",
			]
		)
	var extension: String = path.get_extension()
	if extension.is_empty():
		return said
	var files: Array[String] = find_files_with_extensions("res://", [extension])
	# The walk lists a directory in the order the filesystem keeps it, which differs between
	# platforms, so the same project was answered with its files in another order on Linux.
	files.sort()
	if files.is_empty():
		return "%s. The project holds no .%s file." % [said, extension]
	var names: PackedStringArray = []
	for file: String in files:
		var _named: bool = names.append(file.get_file().get_basename())
	var close: PackedStringArray = GdhRead.nearest(path.get_file().get_basename(), names)
	var offered: PackedStringArray = []
	for file: String in files:
		if file.get_file().get_basename() in close:
			var _offered: bool = offered.append(file)
	if not offered.is_empty():
		var one: bool = offered.size() == 1
		return (
			"%s. The nearest .%s %s %s."
			% [said, extension, "file is" if one else "files are", ", ".join(offered)]
		)
	if files.size() <= GdhRead.NAMED_CHILDREN:
		return "%s. The project's .%s files are %s." % [said, extension, ", ".join(files)]
	return (
		"%s. None of the project's %d .%s files is named like it." % [said, files.size(), extension]
	)


# The files in [param path]'s folder named as it is with another extension, leaving out the import
# and uid files the engine keeps beside a file, which are named after the whole file name.
static func _namesakes(path: String) -> Array[String]:
	var found: Array[String] = []
	var folder: String = path.get_base_dir()
	if not DirAccess.dir_exists_absolute(folder):
		return found
	var stem: String = path.get_file().get_basename()
	var files: PackedStringArray = DirAccess.get_files_at(folder)
	files.sort()
	for file: String in files:
		if file.get_basename() == stem and file != path.get_file():
			found.append(folder.path_join(file))
	return found


# A directory the engine steps over, marker file and all.
func is_stepped_over(path: String) -> bool:
	return FileAccess.file_exists(path + ".gdignore")


# Whether the directory [param path], which ends in a slash, holds a project of its own. A walk
# asks it of the directories below its start only, since the start is res://, which holds a
# project.godot too.
func holds_a_project(path: String) -> bool:
	return FileAccess.file_exists(path + "project.godot")


# An addon gdharness installed, told by the marker setup writes into it. The engine loads it, but
# nobody on the project wrote it: the health check counted its thirty-odd scripts as the project's,
# 39 beside the 5 project_info's own count gave, which the server's walks already step over.
func is_installed_by_gdharness(path: String) -> bool:
	return FileAccess.file_exists(path + ".gdharness-version")


# Files under `path` whose name ends with `extension`, which is passed with its dot. An addon
# gdharness installed is walked into when [param with_ours] is set, for a caller rebuilding what
# the engine itself would: the engine lists the global classes of every addon, and a list rebuilt
# without ours dropped the one class the tests addon declares.
func find_files(path: String, extension: String, with_ours: bool = false) -> Array[String]:
	var files: Array[String] = []
	if is_stepped_over(path) or (not with_ours and is_installed_by_gdharness(path)):
		return files
	# A link whose target is gone lists as a folder that does not open. DirAccess.open answers null
	# for it quietly, where DirAccess.get_directories_at prints an engine error.
	var at: DirAccess = DirAccess.open(path)
	if at == null:
		return files
	# A folder's folders and then its files, each sorted as DirAccess gives them, so a walk answers
	# in one order on every platform: in the order the file system kept them, Linux named the scenes
	# a branch save followed in another order than Windows.
	for folder: String in at.get_directories():
		var inner: String = path + folder + "/"
		if not folder.begins_with(".") and not holds_a_project(inner):
			files.append_array(find_files(inner, extension, with_ours))
	for file_name: String in at.get_files():
		if file_name.ends_with(extension):
			files.append(path + file_name)
	return files


# Files under `path` whose extension is in `extensions`, which are passed without their dot.
func find_files_with_extensions(path: String, extensions: Array) -> Array[String]:
	var files: Array[String] = []
	if is_stepped_over(path) or is_installed_by_gdharness(path):
		return files
	var at: DirAccess = DirAccess.open(path)
	if at == null:
		return files
	for folder: String in at.get_directories():
		var inner: String = path + folder + "/"
		if not folder.begins_with(".") and not holds_a_project(inner):
			files.append_array(find_files_with_extensions(inner, extensions))
	for file_name: String in at.get_files():
		if not file_name.begins_with(".") and file_name.get_extension().to_lower() in extensions:
			files.append(path + file_name)
	return files
