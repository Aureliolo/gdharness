@tool
extends EditorPlugin

## Reloads the open scene and the scripts it carries when they change on disk, without the
## editor's confirmation popup. Every edit made through gdharness lands on disk, and an editor
## that keeps showing the old file is how a change reads as one that never happened. The
## files are polled once a second; the editor's own watcher only fires on window focus.


## What was last seen of a watched file.
class GdhSeen:
	## Its modification time, in whole seconds.
	var time: int
	## The MD5 of its contents.
	var md5: String

	func _init(seen_time: int, seen_md5: String) -> void:
		time = seen_time
		md5 = seen_md5


const CHECK_INTERVAL_SECONDS: float = 1.0
## How long after a file's modification time its contents are compared as well. The time is in
## whole seconds, so a second write inside the second of the first leaves it as it was and changes
## only the contents; past that second any write moves the time.
const SAME_SECOND_SECONDS: int = 5

var _timer: Timer
## What was last seen of each watched file, by path.
var _watched_files: Dictionary = {}


func _enter_tree() -> void:
	_timer = Timer.new()
	_timer.wait_time = CHECK_INTERVAL_SECONDS
	# int rather than Error: Signal.connect answers with a plain int, where Object.connect answers
	# with the enum, and a project holding int_as_enum_without_cast at error level refuses the
	# assignment that conflates them.
	var watching: int = _timer.timeout.connect(_check_for_changes)
	if watching != OK:
		push_error("gdharness: could not start watching for changes on disk")
	# A scene's files are watched from the moment it opens: found at the next poll instead, a file
	# written in between was first seen already changed, and its change was never reloaded.
	var opening: int = scene_changed.connect(_on_scene_changed)
	if opening != OK:
		push_error("gdharness: could not start watching the scenes the editor opens")
	add_child(_timer)
	_timer.start()
	_update_watched_files()


func _exit_tree() -> void:
	if _timer:
		_timer.stop()
		_timer.queue_free()


func _on_scene_changed(_scene_root: Node) -> void:
	_update_watched_files()


func _update_watched_files() -> void:
	var edited_scene: Node = EditorInterface.get_edited_scene_root()
	if edited_scene and edited_scene.scene_file_path:
		var path: String = edited_scene.scene_file_path
		if not _watched_files.has(path):
			_watched_files[path] = _seen(path)
		_watch_node_scripts(edited_scene)


func _watch_node_scripts(node: Node) -> void:
	var script: Variant = node.get_script()
	if script is Script:
		var attached: Script = script
		var path: String = attached.resource_path
		if not path.is_empty() and not _watched_files.has(path):
			_watched_files[path] = _seen(path)
	for child: Node in node.get_children():
		_watch_node_scripts(child)


func _seen(path: String) -> GdhSeen:
	return GdhSeen.new(_get_modified_time(path), _md5_of(path))


func _get_modified_time(path: String) -> int:
	var global_path: String = ProjectSettings.globalize_path(path)
	if FileAccess.file_exists(global_path):
		return FileAccess.get_modified_time(global_path)
	return 0


func _md5_of(path: String) -> String:
	var global_path: String = ProjectSettings.globalize_path(path)
	if FileAccess.file_exists(global_path):
		return FileAccess.get_md5(global_path)
	return ""


func _check_for_changes() -> void:
	_update_watched_files()

	var now: int = int(Time.get_unix_time_from_system())
	var scenes_to_reload: Array[String] = []
	var scripts_to_reload: Array[String] = []
	for path: String in _watched_files.keys():
		var last: GdhSeen = _watched_files[path]
		var current_time: int = _get_modified_time(path)
		if current_time == last.time and now - current_time >= SAME_SECOND_SECONDS:
			continue
		var current_md5: String = _md5_of(path)
		_watched_files[path] = GdhSeen.new(current_time, current_md5)
		if current_md5 == last.md5:
			continue
		if path.ends_with(".gd"):
			scripts_to_reload.append(path)
		else:
			scenes_to_reload.append(path)

	# Scripts first, so a scene reloaded after them instantiates the new code.
	for path: String in scripts_to_reload:
		_reload_script(path)
	for path: String in scenes_to_reload:
		_reload_scene(path)


func _reload_script(path: String) -> void:
	print("[gdharness] Script changed on disk, reloading: ", path)
	var reloaded: Resource = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_REPLACE)
	if reloaded == null:
		push_error("gdharness: could not reload " + path + " from disk")


func _reload_scene(path: String) -> void:
	var edited_scene: Node = EditorInterface.get_edited_scene_root()
	if not edited_scene or edited_scene.scene_file_path != path:
		return
	# A reload from the file drops the edits the editor holds, without a prompt. gdharness refuses to
	# write over them, so what is seen here is a write by somebody else or one the editor's tab has
	# already taken in, made just before an edit inside the same poll, and neither is worth the edit.
	if EditorInterface.get_unsaved_scenes().has(path):
		push_warning(
			(
				(
					"gdharness: %s changed on disk while the editor holds unsaved changes to it, so it "
					+ "was not reloaded; saving it writes the editor's copy over the file"
				)
				% path
			)
		)
		return
	print("[gdharness] Scene changed on disk, reloading: ", path)
	EditorInterface.reload_scene_from_path(path)
