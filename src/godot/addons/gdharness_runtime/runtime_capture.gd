extends RefCounted

## A picture of the running game, as a PNG written where the server asked for it.

const Read = preload("reading.gd")
const Values = preload("runtime_values.gd")

var _host: Node


func _init(host: Node) -> void:
	_host = host


func capture_screenshot(params: Dictionary) -> Dictionary:
	return await _capture(_host.get_tree().root, params, true)


func capture_viewport(params: Dictionary) -> Dictionary:
	var viewport_path: String = str(params.get("viewportPath", ""))
	if viewport_path.is_empty():
		return await capture_screenshot(params)

	var standing: Dictionary = Values.node_at(_host.get_tree().root, viewport_path)
	if standing.has("message"):
		return standing
	var node: Node = standing["node"]
	if not node is Viewport:
		return {"type": "error", "message": "Node is not a Viewport: " + viewport_path}
	var viewport: Viewport = node
	if not viewport is SubViewport:
		return await _capture(viewport, params)
	# Drawn now rather than taken as it stands. A SubViewport the game does not redraw every frame
	# (disabled, a spent update-once, or update-when-visible behind a hidden container) keeps the
	# last frame it drew, and that frame was answered as the viewport now. One update is asked for
	# and the game's own mode put back after it.
	var sub: SubViewport = viewport
	var mode: SubViewport.UpdateMode = sub.render_target_update_mode
	# Nothing is drawn without a window, so the frame waited for below may never come; the capture
	# refuses that state itself.
	if mode == SubViewport.UPDATE_ALWAYS or not _host.get_tree().root.can_draw():
		return await _capture(viewport, params)
	sub.render_target_update_mode = SubViewport.UPDATE_ONCE
	await RenderingServer.frame_post_draw
	var answer: Dictionary = await _capture(viewport, params)
	sub.render_target_update_mode = mode
	return answer


## Lays the game's own windows that the root viewport does not draw over [param image], where
## they sit on screen.
##
## With subwindows not embedded, a dialog or a menu's popup is a window of the operating system's
## with a render target of its own, so a screenshot of the root viewport was the screen without the
## dialog the game was showing. In tree order, so a window added later lies over an earlier one.
func _lay_native_windows(image: Image) -> void:
	var root: Window = _host.get_tree().root
	if root.gui_embed_subwindows:
		return
	var pending: Array[Node] = [root]
	while not pending.is_empty():
		var node: Node = pending.pop_back()
		var children: Array[Node] = node.get_children(true)
		for index: int in range(children.size() - 1, -1, -1):
			pending.append(children[index])
		if node == root or not node is Window:
			continue
		var window: Window = node
		if not window.visible or window.is_embedded():
			continue
		var drawn: Image = window.get_texture().get_image()
		if drawn == null or drawn.is_empty():
			continue
		drawn.convert(image.get_format())
		image.blend_rect(drawn, Rect2i(Vector2i.ZERO, drawn.get_size()), window.position - root.position)


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


## The server names the file, so a game cannot point it at a path of its own choosing; a call
## with no path is a call the server did not make.
func _capture(viewport: Viewport, params: Dictionary, with_windows: bool = false) -> Dictionary:
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

	# The game announces itself before its first frame, and until a frame has been drawn the texture
	# holds nothing the game drew: blank on one machine, solid white on another, which a caller took
	# for the game flashing white on boot. Measured on 4.7.2 with both renderers, only the first
	# processed frame reads it so; the next one holds the scene.
	while Engine.get_frames_drawn() == 0:
		await _host.get_tree().process_frame

	var viewport_texture: ViewportTexture = viewport.get_texture()
	if viewport_texture == null:
		return {"type": "error", "message": "No viewport texture available"}

	var image: Image = viewport_texture.get_image()
	if image == null:
		return {"type": "error", "message": "Failed to capture viewport image"}
	if with_windows:
		_lay_native_windows(image)

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
