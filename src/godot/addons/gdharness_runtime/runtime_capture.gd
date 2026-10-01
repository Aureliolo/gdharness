extends RefCounted

## A picture of the running game, as a PNG written where the server asked for it.

const Read = preload("reading.gd")
const Values = preload("runtime_values.gd")
const Queries = preload("runtime_queries.gd")
const Screen = preload("runtime_screen.gd")

## How far zoom enlarges at most. Sixteen makes a 3-pixel ring 48 pixels across, past any need to
## see it, and a 200-pixel region 3200, past the size anybody reads a picture at.
const ZOOM_MOST: int = 16

var _host: Node
var _values: Values


func _init(host: Node, values: Values) -> void:
	_host = host
	_values = values


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


## What part of the picture a capture is cut to and how far it is enlarged, from what was asked, or
## a refusal saying what is wrong with the asking. Read before a frame is waited for, so a call that
## cannot be answered costs no wait.
##
## A region and a node are asked for because width and height scale the whole picture, and a
## question about a 3-pixel ring in a 1600-pixel window was answered by capturing the window, saving
## it and cropping it with a script of the caller's own, three calls for every look.
func _cut_asked(params: Dictionary, in_window: bool) -> Dictionary:
	var region_given: Variant = params.get("region")
	var node_path: String = str(params.get("nodePath", ""))
	var zoom: int = Read.as_int(params.get("zoom", 1), 1)
	var sized: bool = Read.as_int(params.get("width", 0)) > 0 or Read.as_int(params.get("height", 0)) > 0
	if region_given != null and not node_path.is_empty():
		return _refused("region and nodePath each name the part to capture; give one of them")
	if (region_given != null or not node_path.is_empty()) and not in_window:
		return _refused(
			(
				"region and nodePath are in the window's pixels, and this viewport's texture is in its "
				+ "own: capture the screen with them, or this viewport whole"
			)
		)
	if zoom < 1 or zoom > ZOOM_MOST:
		return _refused("zoom is a whole factor from 1 to %d, and %d was asked for" % [ZOOM_MOST, zoom])
	if zoom > 1 and sized:
		return _refused(
			(
				"zoom enlarges by a whole factor and keeps every pixel square, and width and height "
				+ "scale to a size; give one or the other"
			)
		)
	var asked: Dictionary = {"zoom": zoom}
	if region_given != null:
		var region: Variant = region_of(_values, region_given)
		if region == null:
			var shape: String = (
				"region is a rectangle in window pixels with an area: x, y, width and height, or the "
				+ "window rectangle runtime_inspect rect answers, passed back as it came. %s is neither"
			)
			return _refused(shape % JSON.stringify(region_given))
		asked["region"] = region
	if not node_path.is_empty():
		asked["node_path"] = node_path
	return asked


static func _refused(message: String) -> Dictionary:
	return {"type": "error", "message": message}


## The rectangle [param given] names: the four numbers x, y, width and height, or a rectangle as the
## runtime answers one, its two corners tagged with their type, passed back as it came. Null when it
## is neither or has no area.
static func region_of(values: Values, given: Variant) -> Variant:
	if not given is Dictionary:
		return null
	var fields: Dictionary = given
	fields = fields.duplicate()
	if not fields.has("_type"):
		fields["_type"] = "Rect2"
	var rebuilt: Variant = values.deserialize(fields)
	var region: Rect2
	if rebuilt is Rect2:
		region = rebuilt
	elif rebuilt is Rect2i:
		var whole: Rect2i = rebuilt
		region = Rect2(whole)
	else:
		return null
	if not region.has_area():
		return null
	return region


## Where [param node] is drawn, in window pixels, as runtime_inspect rect answers it: a Control's
## rectangle, what a 3D node's geometry covers, or what a 2D node that knows its own rectangle draws.
## A refusal's message when it has no extent on screen.
static func drawn_rect_of(node: Node) -> Variant:
	if node is Control:
		var control: Control = node
		return Screen.rect_in_window(
			control.get_viewport(),
			control.get_global_transform_with_canvas() * Rect2(Vector2.ZERO, control.size)
		)
	if node is Node3D:
		var spatial: Node3D = node
		var found: Dictionary = Queries.in_frame(spatial)
		if not found.has("rect"):
			return "%s is not drawn by any current camera, so it covers nothing on screen" % node.get_path()
		var covered: Rect2 = found["rect"]
		return Screen.rect_in_window(spatial.get_viewport(), covered)
	if node is Node2D and node.has_method("get_rect"):
		var item: Node2D = node
		var own: Rect2 = item.call("get_rect")
		return Screen.rect_in_window(item.get_viewport(), item.get_global_transform_with_canvas() * own)
	var no_extent: String = (
		"%s is a %s, which has a position on screen and no extent; give region around the point "
		+ "runtime_inspect rect answers for it"
	)
	return no_extent % [node.get_path(), node.get_class()]


## [param region], in window pixels, as pixels of a picture drawn at [param drawn] in a window
## [param window] pixels across: the same rectangle when the two match, scaled when the project draws
## at its own size and stretches that to the window. Widened to whole pixels, so an edge falling
## inside a pixel keeps that pixel, and cut to the picture. Without area when none of it is in it.
static func in_picture(region: Rect2, window: Vector2i, drawn: Vector2i) -> Rect2i:
	return widened(region, window, drawn).intersection(Rect2i(Vector2i.ZERO, drawn))


## [param region] in the picture's pixels as [method in_picture] takes it, before it is cut to the
## picture, which is what tells a region that was clipped from one that fitted.
static func widened(region: Rect2, window: Vector2i, drawn: Vector2i) -> Rect2i:
	var scale: Vector2 = Vector2.ONE
	if window.x > 0 and window.y > 0:
		scale = Vector2(drawn) / Vector2(window)
	var start: Vector2 = (region.position * scale).floor()
	var end: Vector2 = (region.end * scale).ceil()
	return Rect2i(Vector2i(start), Vector2i(end - start))


## [param picture], pixels of a picture drawn at [param drawn], as the window pixels it covers in a
## window [param window] pixels across: what an answer names, since the region was asked for in them.
static func in_window_pixels(picture: Rect2i, window: Vector2i, drawn: Vector2i) -> Dictionary:
	var scale: Vector2 = Vector2.ONE
	if drawn.x > 0 and drawn.y > 0 and window.x > 0 and window.y > 0:
		scale = Vector2(window) / Vector2(drawn)
	var start: Vector2 = Vector2(picture.position) * scale
	var size: Vector2 = Vector2(picture.size) * scale
	return {"x": start.x, "y": start.y, "width": size.x, "height": size.y}


## [param image] cut to [param picture] and enlarged [param zoom] times, each pixel made a square of
## them rather than blended with its neighbours, so a pixel in the answer is a pixel the game drew.
static func cut(image: Image, picture: Rect2i, zoom: int) -> Image:
	var part: Image = image.get_region(picture)
	if zoom > 1:
		part.resize(part.get_width() * zoom, part.get_height() * zoom, Image.INTERPOLATE_NEAREST)
	return part


## The server names the file, so a game cannot point it at a path of its own choosing; a call
## with no path is a call the server did not make.
func _capture(viewport: Viewport, params: Dictionary, with_windows: bool = false) -> Dictionary:
	var requested_path: String = str(params.get("output_path", ""))
	if requested_path.is_empty():
		return {"type": "error", "message": "output_path required"}
	var asked: Dictionary = _cut_asked(params, with_windows)
	if asked.has("message"):
		return asked

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

	var described: Dictionary = {}
	var region: Variant = asked.get("region")
	if asked.has("node_path"):
		var node_path: String = asked["node_path"]
		var standing: Dictionary = Values.node_at(_host.get_tree().root, node_path)
		if standing.has("message"):
			return standing
		var node: Node = standing["node"]
		var placed: Variant = drawn_rect_of(node)
		if placed is String:
			var why: String = placed
			return _refused(why)
		region = placed
		# A hidden node's rectangle is still a place, and what is drawn there is whatever is behind it.
		if not Queries.shown(node):
			described["note"] = (
				"%s is hidden, so this is what is drawn where it would be rather than the node" % node_path
			)
	if region != null:
		var asked_region: Rect2 = region
		var window: Vector2i = _host.get_tree().root.size
		var picture_size: Vector2i = image.get_size()
		var whole: Rect2i = widened(asked_region, window, picture_size)
		var picture: Rect2i = whole.intersection(Rect2i(Vector2i.ZERO, picture_size))
		if not picture.has_area():
			return _refused(
				(
					"The region at %s, %s pixels across, is outside the window, which is %dx%d pixels"
					% [asked_region.position, asked_region.size, window.x, window.y]
				)
			)
		image = cut(image, picture, 1)
		described["region"] = in_window_pixels(picture, window, picture_size)
		if picture != whole:
			described["clipped"] = true
		# The project draws at its own size and stretches that to the window, so the picture's pixels
		# are not the window's: said, because a caller sizing a region by window pixels gets fewer.
		if picture_size != window:
			described["drawnAt"] = {"width": picture_size.x, "height": picture_size.y}

	var zoom: int = asked["zoom"]
	if zoom > 1:
		image = cut(image, Rect2i(Vector2i.ZERO, image.get_size()), zoom)
		described["zoom"] = zoom
	else:
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

	var answer: Dictionary = {
		"type": "screenshot_file",
		"format": "png",
		"width": image.get_width(),
		"height": image.get_height(),
		"path": screenshot_path
	}
	answer.merge(described)
	return answer
