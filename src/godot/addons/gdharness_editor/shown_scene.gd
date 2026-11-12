@tool
extends RefCounted
## A scene brought to the front of the editor for one call, confirmed there, given its frames and
## left as found.
##
## The editor lays a scene out and runs its @tool scripts over the frames after it opens, so a save
## or a picture taken in the frame of the open holds a scene not yet in its shape. A switch the
## editor makes of its own, such as a restored session putting an earlier tab back when its first
## scan ends, can also take the scene out of the front after the open. Both are why each step
## waits, and why the scene is confirmed in front before it is used.

const GdhSceneFile = preload("scene_file.gd")
## Frames let pass after each step: the first lays the screen out, and the next run the redraws
## and layouts the scene's @tool scripts queued as they entered the tree.
const SETTLING_FRAMES: int = 3
## How many times the scene is opened again when the editor does not keep it in front.
const OPEN_ATTEMPTS: int = 3

## What the one call showing a scene holds, built at first use.
static var _held: GdhHeld = null


## Brings [param scene_path] to the front for a call that [param label] names, and
## answers a refusal, or "" once the scene is in front. The editor turns other calls away until
## [method leave] runs. A scene the editor does not keep in front through [constant OPEN_ATTEMPTS]
## opens is left again before the refusal.
static func show(scene_path: String, label: String) -> String:
	var held: GdhHeld = _hold()
	held.label = label
	held.scene = scene_path
	await settled()
	var current: Node = EditorInterface.get_edited_scene_root()
	held.previous = current.scene_file_path if current != null else ""
	held.opened = not EditorInterface.get_open_scenes().has(scene_path)
	var opens: int = 0
	while not in_front(scene_path) and opens < OPEN_ATTEMPTS:
		EditorInterface.open_scene_from_path(scene_path)
		opens += 1
		await settled()
	if in_front(scene_path):
		return ""
	var showing: String = _front_path()
	var refusal: String = (
		"The editor did not keep %s in front: after %d opens it showed %s."
		% [scene_path, opens, showing if not showing.is_empty() else "no scene"]
	)
	if not await leave():
		refusal += " It still holds %s open." % scene_path
	return refusal


## Lets [constant SETTLING_FRAMES] frames pass, then every frame while the editor scans, imports
## or runs a task.
static func settled() -> void:
	var tree: SceneTree = Engine.get_main_loop() as SceneTree
	for frame: int in SETTLING_FRAMES:
		await tree.process_frame
	var filesystem: EditorFileSystem = EditorInterface.get_resource_filesystem()
	while (
		GdhSceneFile.scan_unfinished(filesystem)
		or filesystem.is_importing()
		or GdhSceneFile.in_a_task()
	):
		await tree.process_frame


## Whether the scene in front of the editor is [param scene_path].
static func in_front(scene_path: String) -> bool:
	return _front_path() == scene_path


## What the editor holds a scene in front for, or "" when it shows none.
static func doing() -> String:
	return _hold().label


## Leaves the editor as [method show] found it, and answers whether it did. A scene [method show]
## opened is opened again while the editor has switched away, at most [constant OPEN_ATTEMPTS]
## times, and closed in the frame that confirms it in front, since a close of any other tab would
## drop that tab's unsaved edits without a prompt. The tab that was in front comes back after.
## False only when that scene is still open.
static func leave() -> bool:
	var held: GdhHeld = _hold()
	await settled()
	if held.opened:
		var opens: int = 0
		while not in_front(held.scene) and opens < OPEN_ATTEMPTS:
			EditorInterface.open_scene_from_path(held.scene)
			opens += 1
			await settled()
		if in_front(held.scene):
			_close_front(held.scene)
		await settled()
	if not held.previous.is_empty() and not in_front(held.previous):
		EditorInterface.open_scene_from_path(held.previous)
		await settled()
	var still_open: bool = held.opened and EditorInterface.get_open_scenes().has(held.scene)
	held.label = ""
	return not still_open


## {} when [param scene_path] is open in the editor or loads as a scene, otherwise the refusal.
## The editor answers a scene that does not load with a dialog that stays up, so it is not asked.
## [param for_writing] says whether the call writes: a read answers a gone file in a read's words.
static func loads(scene_path: String, for_writing: bool) -> Dictionary:
	if EditorInterface.get_open_scenes().has(scene_path):
		return {}
	if not for_writing and FileAccess.file_exists(scene_path):
		var as_text: String = (
			FileAccess.get_file_as_string(scene_path) if scene_path.ends_with(".tscn") else ""
		)
		var gone: String = GdhSceneFile.missing_said(scene_path, as_text, false)
		if not gone.is_empty():
			return { "ok": false, "error": gone }
	var scene: GdhSceneFile = GdhSceneFile.new()
	var refused: Dictionary = scene.open(scene_path, for_writing)
	scene.close()
	return refused


static func _close_front(scene_path: String) -> void:
	var closing: Error = EditorInterface.close_scene()
	if closing != OK:
		push_warning("gdharness: closing %s: %s" % [scene_path, error_string(closing)])


static func _front_path() -> String:
	var root: Node = EditorInterface.get_edited_scene_root()
	return root.scene_file_path if root != null else ""


static func _hold() -> GdhHeld:
	if _held == null:
		_held = GdhHeld.new()
	return _held


## What the call showing a scene holds.
class GdhHeld:
	## What the call is doing, or "" when none shows a scene.
	var label: String = ""
	## The scene shown.
	var scene: String = ""
	## The scene that was in front before.
	var previous: String = ""
	## Whether the scene was closed before it was shown.
	var opened: bool = false
