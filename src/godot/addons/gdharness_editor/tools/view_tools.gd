@tool
extends Node
## Pictures of a scene as the editor draws it, with what its @tool scripts draw only there.
##
## A game never runs a script's editor branch, so runtime_capture cannot show it, and a headless
## engine draws nothing at all. The editor's own 2D and 3D views are the one place it is drawn.

const GdhRead = preload("../reading.gd")
const GdhSceneFile = preload("../scene_file.gd")
const GdhPictures = preload("../picture_saves.gd")
const HEADLESS_DISPLAY: String = "headless"
## Frames let pass once the scene is shown: the first lays the screen out, and the next run the
## redraws its @tool scripts queued as they entered the tree.
const SETTLING_FRAMES: int = 3

## Whether a capture is under way, during which the editor turns other calls away, since one that
## switched scenes between the open and the read would be what was captured.
var capturing: bool = false
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
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = GdhSceneFile.res_path(project_path, str(args.get("scenePath", "")))
	if not ResourceLoader.exists(scene_path, "PackedScene"):
		return { "ok": false, "error": "Scene not found: " + scene_path }
	var view: String = str(args.get("view", ""))
	var shown: Node = EditorInterface.get_edited_scene_root()
	var previous: String = shown.scene_file_path if shown != null else ""
	var was_open: bool = EditorInterface.get_open_scenes().has(scene_path)
	var screen_before: String = _screen

	capturing = true
	EditorInterface.open_scene_from_path(scene_path)
	var root: Node = EditorInterface.get_edited_scene_root()
	if root == null or root.scene_file_path != scene_path:
		capturing = false
		return { "ok": false, "error": "The editor did not open %s." % scene_path }
	if view.is_empty():
		view = "3d" if root is Node3D else "2d"
	EditorInterface.set_main_screen_editor("3D" if view == "3d" else "2D")
	for frame: int in SETTLING_FRAMES:
		await get_tree().process_frame
	var viewport: SubViewport = (
		EditorInterface.get_editor_viewport_3d(0)
		if view == "3d"
		else EditorInterface.get_editor_viewport_2d()
	)
	var image: Image = viewport.get_texture().get_image()
	var unsaved: bool = GdhSceneFile.unsaved(scene_path)

	if not was_open:
		var closing: Error = EditorInterface.close_scene()
		if closing != OK:
			push_warning(
				"gdharness: closing %s after its capture: %s" % [scene_path, error_string(closing)]
			)
	if not previous.is_empty() and previous != scene_path:
		EditorInterface.open_scene_from_path(previous)
	if not screen_before.is_empty() and screen_before != ("3D" if view == "3d" else "2D"):
		EditorInterface.set_main_screen_editor(screen_before)
	capturing = false

	if image == null or image.is_empty():
		return { "ok": false, "error": "The editor's %s view held no picture." % view.to_upper() }
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
	answer["scenePath"] = scene_path
	answer["view"] = view
	if target != drawn:
		answer["drawnAt"] = { "width": drawn.x, "height": drawn.y }
	if unsaved:
		answer["unsavedInEditor"] = true
	return answer
