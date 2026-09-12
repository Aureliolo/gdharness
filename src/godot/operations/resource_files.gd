extends RefCounted

const FileWalk = preload("file_walk.gd")
const Log = preload("logger.gd")

var _log: Log
var _files := FileWalk.new()


func _init(p_log: Log) -> void:
	_log = p_log


# Export a scene as a MeshLibrary resource
func export_mesh_library(params) -> Dictionary:
	_log.info("Exporting MeshLibrary from scene: " + params.scene_path)

	# Ensure the scene path starts with res:// for Godot's resource system
	var full_scene_path = params.scene_path
	if not full_scene_path.begins_with("res://"):
		full_scene_path = "res://" + full_scene_path

	_log.debug("Full scene path (with res://): " + full_scene_path)

	# Ensure the output path starts with res:// for Godot's resource system
	var full_output_path = params.output_path
	if not full_output_path.begins_with("res://"):
		full_output_path = "res://" + full_output_path

	_log.debug("Full output path (with res://): " + full_output_path)

	if not FileAccess.file_exists(full_scene_path):
		_log.error("Scene file does not exist at: " + full_scene_path)
		return _log.failure(
			"Absolute file path that doesn't exist: " + ProjectSettings.globalize_path(full_scene_path)
		)

	var scene = load(full_scene_path)
	if not scene:
		return _log.failure("Failed to load scene: " + full_scene_path)

	var scene_root = scene.instantiate()
	var mesh_library = MeshLibrary.new()

	# Get mesh item names if provided
	var mesh_item_names = params.mesh_item_names if params.has("mesh_item_names") else []
	var use_specific_items = mesh_item_names.size() > 0

	var item_id = 0

	for child in scene_root.get_children():
		# Skip if not using all items and this item is not in the list
		if use_specific_items and not (child.name in mesh_item_names):
			_log.debug("Skipping node " + child.name + " (not in specified items list)")
			continue

		var mesh_instance = _mesh_instance_of(child)
		if mesh_instance == null or mesh_instance.mesh == null:
			_log.debug("Node " + child.name + " has no valid mesh")
			continue

		mesh_library.create_item(item_id)
		mesh_library.set_item_name(item_id, child.name)
		mesh_library.set_item_mesh(item_id, mesh_instance.mesh)
		mesh_library.set_item_preview(item_id, mesh_instance.mesh)

		# Add collision shape if available
		for collision_child in child.get_children():
			if collision_child is CollisionShape3D and collision_child.shape:
				mesh_library.set_item_shapes(item_id, [collision_child.shape])
				break

		item_id += 1

	scene_root.queue_free()

	if item_id == 0:
		return _log.failure("No valid meshes found in the scene")

	# Create directory if it doesn't exist
	var dir = DirAccess.open("res://")
	if dir == null:
		_log.error("DirAccess error: " + str(DirAccess.get_open_error()))
		return _log.failure("Failed to open res:// directory")

	var output_dir = full_output_path.get_base_dir()
	if output_dir != "res://" and not dir.dir_exists(output_dir.substr(6)):
		var dir_error = dir.make_dir_recursive(output_dir.substr(6))
		if dir_error != OK:
			return _log.failure("Failed to create directory: " + output_dir + ", error: " + str(dir_error))

	var save_error = ResourceSaver.save(mesh_library, full_output_path)
	if save_error != OK:
		return _log.failure("Failed to save MeshLibrary: " + str(save_error))

	# A save that reports OK and leaves nothing on disk would otherwise answer as a success.
	if not FileAccess.file_exists(full_output_path):
		return _log.failure("File reported as saved but does not exist at: " + full_output_path)

	return {
		"success": true,
		"items": item_id,
		"output_path": full_output_path,
		"absolute_path": ProjectSettings.globalize_path(full_output_path)
	}


# Get UID for a specific file
func get_uid(params) -> Dictionary:
	if not params.has("file_path"):
		return _log.failure("File path is required")

	# Ensure the file path starts with res:// for Godot's resource system
	var file_path = params.file_path
	if not file_path.begins_with("res://"):
		file_path = "res://" + file_path

	_log.info("Getting UID for file: " + file_path)

	var absolute_path = ProjectSettings.globalize_path(file_path)
	_log.debug("Absolute file path: " + absolute_path)

	if not FileAccess.file_exists(file_path):
		_log.error("File does not exist at: " + file_path)
		return _log.failure("Absolute file path that doesn't exist: " + absolute_path)

	var uid_path = file_path + ".uid"
	_log.debug("UID file path: " + uid_path)

	var f = FileAccess.open(uid_path, FileAccess.READ)
	if not f:
		_log.debug("UID file does not exist or could not be opened")
		return {
			"file": file_path,
			"absolutePath": absolute_path,
			"exists": false,
			"message": "UID file does not exist for this file. Use resave_resources to generate UIDs."
		}

	var uid_content = f.get_as_text()
	f.close()

	return {
		"file": file_path, "absolutePath": absolute_path, "uid": uid_content.strip_edges(), "exists": true
	}


# Resave all resources to update UID references
func resave_resources(params) -> Dictionary:
	_log.info("Resaving all resources to update UID references...")

	# Get project path if provided
	var project_path = "res://"
	if params.has("project_path"):
		project_path = params.project_path
		if not project_path.begins_with("res://"):
			project_path = "res://" + project_path
		if not project_path.ends_with("/"):
			project_path += "/"

	_log.debug("Using project path: " + project_path)

	var scenes = _files.find_files(project_path, ".tscn")
	_log.debug("Found " + str(scenes.size()) + " scenes")

	# Resave each scene
	var success_count = 0
	var error_count = 0

	for scene_path in scenes:
		_log.debug("Processing scene: " + scene_path)

		if not FileAccess.file_exists(scene_path):
			_log.error("Scene file does not exist at: " + scene_path)
			error_count += 1
			continue

		var scene = load(scene_path)
		if not scene:
			error_count += 1
			_log.error("Failed to load: " + scene_path)
			continue

		var error = ResourceSaver.save(scene, scene_path)
		if error != OK:
			error_count += 1
			_log.error("Failed to save: " + scene_path + ", error: " + str(error))
			continue

		success_count += 1
		if _log.debug_mode:
			_log.debug("Scene saved successfully: " + scene_path)
			var file_check_after = FileAccess.file_exists(scene_path)
			_log.debug("File exists check after save: " + str(file_check_after))
			if not file_check_after:
				_log.error("File reported as saved but does not exist at: " + scene_path)

	# A UID sits beside every script and shader as a .uid file. Outside the editor the save
	# below answers OK and writes no sidecar, so what comes back is what was resaved and how
	# many are still without one, rather than a count of UIDs this made.
	var scripts = (
		_files.find_files(project_path, ".gd")
		+ _files.find_files(project_path, ".shader")
		+ _files.find_files(project_path, ".gdshader")
	)
	_log.debug("Found " + str(scripts.size()) + " scripts/shaders")

	var missing_uids = 0
	var resaved_scripts = 0

	for script_path in scripts:
		_log.debug("Checking UID for: " + script_path)
		var uid_path = script_path + ".uid"

		var f = FileAccess.open(uid_path, FileAccess.READ)
		if f:
			_log.debug("UID file already exists for: " + script_path)
			continue

		missing_uids += 1
		_log.debug("Missing UID file for: " + script_path + ", resaving...")

		var res = load(script_path)
		if not res:
			_log.error("Failed to load resource: " + script_path)
			continue

		var error = ResourceSaver.save(res, script_path)
		if error != OK:
			_log.error("Failed to resave: " + script_path + ", error: " + str(error))
			continue

		resaved_scripts += 1
		_log.debug("Resaved: " + script_path)

	_log.info("Resave operation complete")

	return {
		"scenes_processed": scenes.size(),
		"scenes_saved": success_count,
		"scenes_with_errors": error_count,
		"scripts_missing_uids": missing_uids,
		"scripts_resaved": resaved_scripts
	}


# The MeshInstance3D a library item is built from: the child itself, or the first one under it.
func _mesh_instance_of(child: Node) -> MeshInstance3D:
	if child is MeshInstance3D:
		return child as MeshInstance3D

	for descendant in child.get_children():
		if descendant is MeshInstance3D:
			return descendant as MeshInstance3D

	return null
