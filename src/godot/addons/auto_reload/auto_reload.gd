@tool
extends EditorPlugin

## Reloads the open scene and the scripts it carries when they change on disk, without the
## editor's confirmation popup. Every edit made through gdharness lands on disk, and an editor
## that keeps showing the old file is how a change reads as one that never happened. The
## files are polled once a second; the editor's own watcher only fires on window focus.

const CHECK_INTERVAL_SECONDS: float = 1.0

var _timer: Timer
## The last modification time seen, by path.
var _watched_files: Dictionary = {}


func _enter_tree() -> void:
	_timer = Timer.new()
	_timer.wait_time = CHECK_INTERVAL_SECONDS
	_timer.timeout.connect(_check_for_changes)
	add_child(_timer)
	_timer.start()
	_update_watched_files()


func _exit_tree() -> void:
	if _timer:
		_timer.stop()
		_timer.queue_free()


func _update_watched_files() -> void:
	var edited_scene: Node = EditorInterface.get_edited_scene_root()
	if edited_scene and edited_scene.scene_file_path:
		var path: String = edited_scene.scene_file_path
		if not _watched_files.has(path):
			_watched_files[path] = _get_modified_time(path)
		_watch_node_scripts(edited_scene)


func _watch_node_scripts(node: Node) -> void:
	var script: Variant = node.get_script()
	if script is Script:
		var attached: Script = script
		var path: String = attached.resource_path
		if not path.is_empty() and not _watched_files.has(path):
			_watched_files[path] = _get_modified_time(path)
	for child: Node in node.get_children():
		_watch_node_scripts(child)


func _get_modified_time(path: String) -> int:
	var global_path: String = ProjectSettings.globalize_path(path)
	if FileAccess.file_exists(global_path):
		return FileAccess.get_modified_time(global_path)
	return 0


func _check_for_changes() -> void:
	_update_watched_files()

	var scenes_to_reload: Array[String] = []
	var scripts_to_reload: Array[String] = []
	for path: String in _watched_files.keys():
		var current_time: int = _get_modified_time(path)
		var last_time: int = _watched_files[path]
		if current_time > last_time:
			if path.ends_with(".gd"):
				scripts_to_reload.append(path)
			else:
				scenes_to_reload.append(path)
			_watched_files[path] = current_time

	# Scripts first, so a scene reloaded after them instantiates the new code.
	for path: String in scripts_to_reload:
		_reload_script(path)
	for path: String in scenes_to_reload:
		_reload_scene(path)


func _reload_script(path: String) -> void:
	print("[gdharness] Script changed on disk, reloading: ", path)
	ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_REPLACE)


func _reload_scene(path: String) -> void:
	var edited_scene: Node = EditorInterface.get_edited_scene_root()
	if edited_scene and edited_scene.scene_file_path == path:
		print("[gdharness] Scene changed on disk, reloading: ", path)
		EditorInterface.reload_scene_from_path(path)
