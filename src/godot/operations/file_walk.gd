extends RefCounted

# Two walks rather than one because they disagree about hidden entries on purpose: a suffix
# walk descends into every visible directory and matches whole names, while the extension walk
# skips anything beginning with a dot, including .import sidecars that would otherwise answer
# for the resource they belong to.


# Files under `path` whose name ends with `extension`, which is passed with its dot.
func find_files(path: String, extension: String) -> Array:
	var files = []
	var dir = DirAccess.open(path)

	if dir:
		dir.list_dir_begin()
		var file_name = dir.get_next()

		while file_name != "":
			if dir.current_is_dir() and not file_name.begins_with("."):
				files.append_array(find_files(path + file_name + "/", extension))
			elif file_name.ends_with(extension):
				files.append(path + file_name)

			file_name = dir.get_next()

	return files


# Files under `path` whose extension is in `extensions`, which are passed without their dot.
func find_files_with_extensions(path: String, extensions: Array) -> Array:
	var files = []
	var dir = DirAccess.open(path)

	if dir:
		dir.list_dir_begin()
		var file_name = dir.get_next()

		while file_name != "":
			if file_name.begins_with("."):
				file_name = dir.get_next()
				continue

			var full_path = path + file_name
			if dir.current_is_dir():
				files.append_array(find_files_with_extensions(full_path + "/", extensions))
			else:
				var ext = file_name.get_extension().to_lower()
				if ext in extensions:
					files.append(full_path)

			file_name = dir.get_next()

		dir.list_dir_end()

	return files
