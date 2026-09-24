extends RefCounted

## A picture of the running game, as a PNG written where the server asked for it.

const Read = preload("reading.gd")
const Values = preload("runtime_values.gd")

var _host: Node


func _init(host: Node) -> void:
	_host = host


func capture_screenshot(params: Dictionary) -> Dictionary:
	return _capture(_host.get_tree().root, params)


func capture_viewport(params: Dictionary) -> Dictionary:
	var viewport_path: String = str(params.get("viewportPath", ""))
	if viewport_path.is_empty():
		return capture_screenshot(params)

	var standing: Dictionary = Values.node_at(_host.get_tree().root, viewport_path)
	if standing.has("message"):
		return standing
	var node: Node = standing["node"]
	if not node is Viewport:
		return {"type": "error", "message": "Node is not a Viewport: " + viewport_path}
	var viewport: Viewport = node
	return _capture(viewport, params)


## The server names the file, so a game cannot point it at a path of its own choosing; a call
## with no path is a call the server did not make.
## The size a capture drawn at [param drawn] is scaled to, from the width and height asked for, 0
## being not asked. One side alone keeps the picture's proportions, since that is what asking for a
## smaller picture means: it was ignored unless both came, so the full-size picture was sent back.
static func scaled_to(drawn: Vector2i, width: int, height: int) -> Vector2i:
	if width > 0 and height > 0:
		return Vector2i(width, height)
	if width > 0 and drawn.x > 0:
		return Vector2i(width, maxi(1, roundi(float(drawn.y) * width / drawn.x)))
	if height > 0 and drawn.y > 0:
		return Vector2i(maxi(1, roundi(float(drawn.x) * height / drawn.y)), height)
	return drawn


func _capture(viewport: Viewport, params: Dictionary) -> Dictionary:
	var requested_path: String = str(params.get("output_path", ""))
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

	var drawn: Vector2i = Vector2i(image.get_width(), image.get_height())
	var target: Vector2i = scaled_to(
		drawn, Read.as_int(params.get("width", 0)), Read.as_int(params.get("height", 0))
	)
	if target != drawn:
		image.resize(target.x, target.y)

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
