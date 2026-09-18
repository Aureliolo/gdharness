extends RefCounted

# Two walks rather than one because they disagree about hidden entries on purpose: a suffix
# walk descends into every visible directory and matches whole names, while the extension walk
# skips anything beginning with a dot, including .import sidecars that would otherwise answer
# for the resource they belong to.
#
# Both stop at a `.gdignore`, because the engine does: nothing under one is imported, so what is
# in there is not a resource, not a dependency and not a global class. Walking in anyway hands
# every caller files the engine will never answer for.


# A directory the engine steps over, marker file and all.
func is_stepped_over(path: String) -> bool:
	return FileAccess.file_exists(path + ".gdignore")


# Files under `path` whose name ends with `extension`, which is passed with its dot.
func find_files(path: String, extension: String) -> Array[String]:
	var files: Array[String] = []
	if is_stepped_over(path):
		return files

	var dir: DirAccess = DirAccess.open(path)

	if dir:
		if dir.list_dir_begin() != OK:
			return files
		var file_name: String = dir.get_next()

		while file_name != "":
			if dir.current_is_dir() and not file_name.begins_with("."):
				files.append_array(find_files(path + file_name + "/", extension))
			elif file_name.ends_with(extension):
				files.append(path + file_name)

			file_name = dir.get_next()

	return files


# Files under `path` whose extension is in `extensions`, which are passed without their dot.
func find_files_with_extensions(path: String, extensions: Array) -> Array[String]:
	var files: Array[String] = []
	if is_stepped_over(path):
		return files

	var dir: DirAccess = DirAccess.open(path)

	if dir:
		if dir.list_dir_begin() != OK:
			return files
		var file_name: String = dir.get_next()

		while file_name != "":
			if file_name.begins_with("."):
				file_name = dir.get_next()
				continue

			var full_path: String = path + file_name
			if dir.current_is_dir():
				files.append_array(find_files_with_extensions(full_path + "/", extensions))
			else:
				var ext: String = file_name.get_extension().to_lower()
				if ext in extensions:
					files.append(full_path)

			file_name = dir.get_next()

		dir.list_dir_end()

	return files
