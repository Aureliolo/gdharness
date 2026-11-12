@tool
extends Node
## Pictures of a scene as the editor draws it, with what its @tool scripts draw only there.
##
## A game never runs a script's editor branch, so runtime_capture cannot show it, and a headless
## engine draws nothing at all. The editor's own 2D and 3D views are the one place it is drawn.

const GdhRead = preload("../reading.gd")
const GdhFileWalk = preload("../file_walk.gd")
const GdhSceneFile = preload("../scene_file.gd")
const GdhShownScene = preload("../shown_scene.gd")
const GdhPictures = preload("../picture_saves.gd")
const HEADLESS_DISPLAY: String = "headless"

var _editor_plugin: EditorPlugin = null
## The main screen the editor shows, as it last said, or "" before it has said.
var _screen: String = ""


func set_editor_plugin(plugin: EditorPlugin) -> void:
	_editor_plugin = plugin
	if not plugin.main_screen_changed.is_connected(_on_main_screen_changed):
		var joined: int = plugin.main_screen_changed.connect(_on_main_screen_changed)
		if joined != OK:
			push_warning("gdharness: following the editor's main screen: %s" % error_string(joined))


func _on_main_screen_changed(screen_name: String) -> void:
	_screen = screen_name


## The scene at scenePath as the editor's 2D or 3D view draws it, saved at output_path, which the
## server names. The editor is left showing the scene and the screen it showed before.
func capture_editor_view(args: Dictionary) -> Dictionary:
	var output_path: String = str(args.get("output_path", ""))
	var scene_path: String = GdhSceneFile.res_path(str(args.get("scenePath", "")))
	var unavailable: Dictionary = _capture_unavailable(output_path, scene_path)
	if not unavailable.is_empty():
		return unavailable
	var view: String = str(args.get("view", ""))
	var screen_before: String = _screen

	var refusal: String = await GdhShownScene.show(scene_path, "capturing its view")
	if not refusal.is_empty():
		return { "ok": false, "error": refusal }
	if view.is_empty():
		view = "3d" if EditorInterface.get_edited_scene_root() is Node3D else "2d"
	await _switch_view(view)
	if not GdhShownScene.in_front(scene_path):
		var kept_open: String = "" if await GdhShownScene.leave() else " It still holds it open."
		_restore_screen(screen_before, view)
		return {
			"ok": false,
			"error": "The editor did not keep %s in front.%s" % [scene_path, kept_open],
		}
	var viewport: SubViewport = (
		EditorInterface.get_editor_viewport_3d(0)
		if view == "3d"
		else EditorInterface.get_editor_viewport_2d()
	)
	var image: Image = viewport.get_texture().get_image()
	var unsaved: bool = GdhSceneFile.unsaved(scene_path)

	var left: bool = await GdhShownScene.leave()
	_restore_screen(screen_before, view)
	if not left:
		push_warning("gdharness: %s is still open after its capture" % scene_path)

	return _save_capture(image, args, output_path, [scene_path, view], unsaved)


## Sets the editor's main screen for [param view] and lets the screen draw.
static func _switch_view(view: String) -> void:
	EditorInterface.set_main_screen_editor("3D" if view == "3d" else "2D")
	await GdhShownScene.settled()


## The refusal when no capture of [param scene_path] can be saved at [param output_path], or an
## empty answer.
static func _capture_unavailable(output_path: String, scene_path: String) -> Dictionary:
	if output_path.is_empty():
		return { "ok": false, "error": "output_path required" }
	if DisplayServer.get_name() == HEADLESS_DISPLAY:
		return {
			"ok": false,
			"error":
			(
				"This editor runs headless, so it draws nothing to capture. Use a visible "
				+ "editor, or a hidden one on Windows."
			),
		}
	if not ResourceLoader.exists(scene_path, "PackedScene"):
		return {
			"ok": false,
			"error":
			GdhFileWalk.new().with_nearest_files("Scene not found: " + scene_path, scene_path),
		}
	return {}


## Puts the screen [param screen_before] back, unless it is the one [param view] needs.
static func _restore_screen(screen_before: String, view: String) -> void:
	if not screen_before.is_empty() and screen_before != ("3D" if view == "3d" else "2D"):
		EditorInterface.set_main_screen_editor(screen_before)


## Scales [param image] to the width and height of [param args], saves it at [param output_path] and
## answers where it went. [param shown] holds the scene path and the view that were captured, and
## [param unsaved] whether the editor held edits to the scene.
static func _save_capture(
	image: Image, args: Dictionary, output_path: String, shown: Array[String], unsaved: bool
) -> Dictionary:
	if image == null or image.is_empty():
		return {
			"ok": false,
			"error": "The editor's %s view held no picture." % shown[1].to_upper(),
		}
	var drawn: Vector2i = image.get_size()
	var target: Vector2i = GdhPictures.scaled_to(
		drawn, GdhRead.as_int(args.get("width", 0)), GdhRead.as_int(args.get("height", 0))
	)
	if target != drawn:
		image.resize(target.x, target.y)
	# The server makes the folder for each capture and takes it away when it stops waiting.
	if not DirAccess.dir_exists_absolute(output_path.get_base_dir()):
		return {
			"ok": false,
			"error":
			(
				"The folder to save the capture in, %s, is gone because the server that asked "
				+ "for it stopped waiting."
			)
			% output_path.get_base_dir(),
		}
	var answer: Dictionary = GdhPictures.saved(image, output_path)
	if answer.get("type", "") == "error":
		return { "ok": false, "error": str(answer.get("message", "")) }
	answer["ok"] = true
	answer["scenePath"] = shown[0]
	answer["view"] = shown[1]
	if target != drawn:
		answer["drawnAt"] = { "width": drawn.x, "height": drawn.y }
	if unsaved:
		answer["unsavedInEditor"] = true
	return answer
