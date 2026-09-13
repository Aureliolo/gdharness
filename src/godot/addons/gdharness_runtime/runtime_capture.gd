extends RefCounted

## A picture of the running game, as a PNG written where the server asked for it.

var _host: Node


func _init(host: Node) -> void:
	_host = host


func capture_screenshot(params: Dictionary) -> Dictionary:
	return _capture(_host.get_tree().root, params)


func capture_viewport(params: Dictionary) -> Dictionary:
	var viewport_path: String = String(params.get("viewportPath", ""))
	if viewport_path.is_empty():
		return capture_screenshot(params)

	var node: Node = _host.get_tree().root.get_node_or_null(viewport_path)
	if node == null:
		return {"type": "error", "message": "Viewport not found: " + viewport_path}
	if not node is Viewport:
		return {"type": "error", "message": "Node is not a Viewport: " + viewport_path}
	return _capture(node, params)


## The server names the file, so a game cannot point it at a path of its own choosing; a call
## with no path is a call the server did not make.
func _capture(viewport: Viewport, params: Dictionary) -> Dictionary:
	var requested_path: String = String(params.get("output_path", ""))
	if requested_path.is_empty():
		return {"type": "error", "message": "output_path required"}

	# Godot draws nothing to a minimised window and nothing at all without one, and the
	# texture keeps whatever was drawn last. A capture then comes back byte for byte the same
	# every time, with a success payload, and a game running perfectly well reads as a game
	# that has frozen. A frame nobody drew is not evidence of anything, so it is refused.
	if not _host.get_tree().root.can_draw():
		return {
			"type": "error",
			"message":
			(
				"Nothing is being drawn to the game's window: it is minimised, or this engine "
				+ "has no window. The texture still holds the last frame that was drawn, so this "
				+ "and every capture after it would be that frame. Restore the window and ask again."
			),
		}

	var viewport_texture: ViewportTexture = viewport.get_texture()
	if viewport_texture == null:
		return {"type": "error", "message": "No viewport texture available"}

	var image: Image = viewport_texture.get_image()
	if image == null:
		return {"type": "error", "message": "Failed to capture viewport image"}

	var width: int = int(params.get("width", 0))
	var height: int = int(params.get("height", 0))
	if width > 0 and height > 0:
		image.resize(width, height)

	var screenshot_path: String = requested_path
	if screenshot_path.begins_with("user://") or screenshot_path.begins_with("res://"):
		screenshot_path = ProjectSettings.globalize_path(screenshot_path)
	var save_error: Error = image.save_png(screenshot_path)
	if save_error != OK:
		return {"type": "error", "message": "Failed to save screenshot as PNG: " + str(save_error)}

	return {
		"type": "screenshot_file",
		"format": "png",
		"width": image.get_width(),
		"height": image.get_height(),
		"path": screenshot_path
	}
