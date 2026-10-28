extends RefCounted
## What a pointer call names: a point, the stroke of a drag, a mouse button and its mask bit. Read
## here and sent from runtime_input.gd, which keeps where the pointer is.

const GdhRead = preload("reading.gd")
const GdhScreen = preload("runtime_screen.gd")
const GdhTargets = preload("runtime_targets.gd")
const GdhValues = preload("runtime_values.gd")


## A point the tool schema sends as two flat numbers. Answers a Vector2, or the String that says
## which was missing.
static func read_point(params: Dictionary, x_key: String, y_key: String) -> Variant:
	if not params.has(x_key) or not params.has(y_key):
		return "%s and %s are both needed." % [x_key, y_key]
	return Vector2(GdhRead.as_float(params[x_key]), GdhRead.as_float(params[y_key]))


## The point a click names in [param node]'s own space, null when it names none, or the String
## refusing it: a 3D node is clicked where it is drawn, and an item found by its words, a tab or a
## row, where the control draws it.
##
## For a control that draws its parts itself and hit-tests them in _gui_input, whose centre was all
## a click could press; in a native window, where the game's window pixels do not reach, nothing
## else could press the rest.
static func point_in(params: Dictionary, node: Node, node_path: String, has_item: bool) -> Variant:
	if not params.has("x") and not params.has("y"):
		return null
	if node is Node3D:
		return (
			(
				"%s is a 3D node, clicked where it is drawn; x and y name a point in a Control's "
				+ "own space"
			)
			% node_path
		)
	if has_item:
		return (
			(
				"the words name an item %s draws, which is pressed where it is drawn, and x and y "
				+ "a point in it: give one of them"
			)
			% node_path
		)
	return read_point(params, "x", "y")


## The node a mouse_click, mouse_motion or mouse_drag names its points in, as {"node", "path"}, an
## empty Dictionary for the game's window, or the String refusing it.
##
## A point in a node's own space is the only way to press part of a control in a native window,
## where the game's window pixels do not reach: a game that draws its buttons itself and hit-tests
## them in _gui_input had nothing a click could aim at but the control's centre.
static func aim_of(params: Dictionary, root: Window) -> Variant:
	var path: String = str(params.get("nodePath", ""))
	if path.is_empty():
		return {}
	var standing: Dictionary = GdhValues.node_at(root, path)
	if standing.has("message"):
		return standing["message"]
	var node: Node = standing["node"]
	if node is CanvasItem or node is Viewport:
		return { "node": node, "path": path }
	return (
		"%s is a %s, and the points are in a Control's, a Node2D's or a Window's own space"
		% [path, node.get_class()]
	)


## Where [param local], in the space of the node [param aim] names, arrives: {"viewport",
## "position"}, the viewport the pointer reaches it through and the point in that viewport's pixels,
## which is what an event sent there names. A Window's space is its own pixels, as the game's window
## pixels are the root's; a canvas item's is its own, the one it draws and reads _gui_input in.
static func carried(aim: Dictionary, local: Vector2, root: Window) -> Dictionary:
	var node: Node = aim.get("node", root)
	var reached: Dictionary = {}
	if node is Viewport:
		var viewport: Viewport = node
		reached = GdhScreen.reach(viewport, viewport.get_final_transform().affine_inverse() * local)
	else:
		var item: CanvasItem = node
		reached = GdhScreen.reach(
			item.get_viewport(), item.get_global_transform_with_canvas() * local
		)
	var arriving: Viewport = reached["viewport"]
	var point: Vector2 = reached["point"]
	return { "viewport": arriving, "position": arriving.get_final_transform() * point }


## What a pointer answer says of where [param points] went in [param viewport]: the node they were
## named in, the window when it is not the game's own, and any of them outside its viewport. Read
## before the first event, since a release can close the window it went to.
static func where(aim: Dictionary, viewport: Viewport, points: Array[Vector2]) -> Dictionary:
	var said: Dictionary = outside_noted({}, viewport, points)
	if aim.has("path"):
		said["path"] = aim["path"]
	if viewport != viewport.get_tree().root:
		said["window"] = str(viewport.get_path())
	return said


## The points of a drag: x, y, then each of via, then toX, toY. Answers the String saying what is
## wrong instead, since a point left out would otherwise read as the window's corner. [param op] is
## the drag the refusal names.
static func stroke_of(params: Dictionary, op: String = "mouse_drag") -> Variant:
	for key: String in ["x", "y", "toX", "toY"]:
		if not params.has(key):
			return "%s needs x, y, toX and toY: %s is missing." % [op, key]
	var points: Array[Vector2] = [
		Vector2(GdhRead.as_float(params["x"]), GdhRead.as_float(params["y"])),
	]
	var via: Variant = params.get("via", [])
	if not via is Array:
		return "via must be a list of [x, y] points."
	var between: Array = via
	for point: Variant in between:
		var pair: Array = point if point is Array else []
		if pair.size() < 2:
			return "via must be a list of [x, y] points, and holds %s." % JSON.stringify(point)
		points.append(Vector2(GdhRead.as_float(pair[0]), GdhRead.as_float(pair[1])))
	points.append(Vector2(GdhRead.as_float(params["toX"]), GdhRead.as_float(params["toY"])))
	return points


## The distance along [param points] to each of them from the first.
static func lengths_of(points: Array[Vector2]) -> Array[float]:
	var lengths: Array[float] = [0.0]
	for at: int in range(1, points.size()):
		lengths.append(lengths[at - 1] + points[at - 1].distance_to(points[at]))
	return lengths


## The point [param share] of the way along the stroke through [param points], by distance, with
## [param lengths] from [method lengths_of].
static func along(points: Array[Vector2], lengths: Array[float], share: float) -> Vector2:
	var total: float = lengths[lengths.size() - 1]
	if total == 0.0:
		return points[0]
	var wanted: float = total * share
	for at: int in range(1, points.size()):
		if lengths[at] >= wanted:
			var span: float = lengths[at] - lengths[at - 1]
			var part: float = 0.0 if span == 0.0 else (wanted - lengths[at - 1]) / span
			return points[at - 1].lerp(points[at], part)
	return points[points.size() - 1]


## The mask bit for a button, which is the engine's own mapping: left 1, right 2, middle 4, the
## two extra buttons 128 and 256. The wheel steps between have none.
static func mask_of(button: int) -> int:
	if button >= MOUSE_BUTTON_WHEEL_UP and button <= MOUSE_BUTTON_WHEEL_RIGHT:
		return 0
	return 1 << (button - 1)


## A button event carries the buttons held once it has happened: the pressed one among them, the
## released one out. A wheel step is a button with no mask, as it is from a real mouse. [param held]
## is what was held before it, which Input knows for the game's window.
static func button_event(
	position: Vector2, button: int, pressed: bool, double: bool, held: int = -1
) -> InputEventMouseButton:
	var event: InputEventMouseButton = InputEventMouseButton.new()
	event.position = position
	event.global_position = position
	event.button_index = button as MouseButton
	event.pressed = pressed
	event.double_click = double
	if held < 0:
		held = Input.get_mouse_button_mask()
	var own: int = mask_of(button)
	event.button_mask = (held | own) if pressed else (held & ~own)
	return event


## [param answer], saying so when one of [param points] lies outside [param viewport]: the GUI picks
## what is under the pointer only inside it, so such a press or motion reaches no control, and its
## answer read the same as one that landed.
##
## The points are window pixels and the visible rect is canvas units, which differ by the window's
## content scale and any letterbox offset, so the rect is taken into window pixels first.
static func outside_noted(
	answer: Dictionary, viewport: Viewport, points: Array[Vector2]
) -> Dictionary:
	var shown: Rect2 = viewport.get_final_transform() * viewport.get_visible_rect()
	var which: String = (
		"the window's" if viewport == viewport.get_tree().root else "%s's" % viewport.get_path()
	)
	for point: Vector2 in points:
		if not shown.has_point(point):
			answer["outside_viewport"] = (
				(
					"%s is outside %s viewport, %s in window pixels, so no control there receives"
					% [point, which, shown]
				)
				+ " it; the game's _input and _unhandled_input still do."
			)
			break
	return answer


## What to say about a name that is not a mouse button, with the ones that are.
static func no_such_button(named: Variant) -> Dictionary:
	return {
		"type": "error",
		"message":
		(
			(
				"%s is not a mouse button. It takes: left, right, middle, wheel_up, wheel_down, or "
				+ "the number of one."
			)
			% JSON.stringify(named)
		),
	}


## The button [param raw] names, or -1 for a name that is not one of them.
##
## A name nobody recognises used to come back as the left button, so a right click asked for by a
## spelling this does not know went to the left button and reported the left button. The caller
## reads the answer and believes it, which is the whole reason nothing here guesses.
static func button_of(raw: Variant) -> int:
	if raw is String:
		var named: String = raw
		match named.to_lower():
			"left":
				return MOUSE_BUTTON_LEFT
			"right":
				return MOUSE_BUTTON_RIGHT
			"middle":
				return MOUSE_BUTTON_MIDDLE
			"wheel_up", "wheelup":
				return MOUSE_BUTTON_WHEEL_UP
			"wheel_down", "wheeldown":
				return MOUSE_BUTTON_WHEEL_DOWN
			_:
				return -1
	# The engine's buttons run from 1 to 9: 0 is MOUSE_BUTTON_NONE, which no event carries, and a
	# number past the two extra buttons names nothing a mask bit can be made for.
	var number: int = GdhRead.as_int(raw, -1)
	return number if number >= MOUSE_BUTTON_LEFT and number <= MOUSE_BUTTON_XBUTTON2 else -1


## Why [param control] would take no click a player gave it, or "" when it would.
##
## The last two answered landed, since the pointer reaches the control, while the press did nothing,
## measured on 4.7.2: a disabled button keeps its mouse filter and ignores the press, and a control
## that does not process while the game is paused is hovered and never handed the event.
## A control whose pointer a `mouse_behavior_recursive` above it has turned off is passed through to
## what is underneath, which answered `landed: false` with nothing saying why. [param paused] is
## whether the game is.
static func takes_no_click(control: Control, node_path: String, paused: bool) -> String:
	if not control.is_visible_in_tree():
		return (
			"%s is not visible%s, so nothing can click it"
			% [node_path, GdhTargets.why_hidden(control)]
		)
	var button: BaseButton = control as BaseButton
	if button != null and button.disabled:
		return "%s is disabled, so clicking it presses nothing" % node_path
	var turned_off: Control = GdhTargets.pointer_turned_off_by(control)
	if turned_off != null:
		var on: String = "itself" if turned_off == control else str(turned_off.get_path())
		return (
			(
				"%s takes no pointer input, since mouse_behavior_recursive is disabled on %s,"
				+ " so clicking it presses nothing"
			)
			% [node_path, on]
		)
	if not control.can_process():
		var why: String = GdhTargets.why_it_does_not_process(control, node_path)
		var over: Node = GdhTargets.drawn_over(control)
		var cover: String = "" if over == null else "; %s is drawn over it" % over.get_path()
		if paused:
			return (
				(
					"the game is paused and %s does not process while it is (%s), so clicking it "
					+ "does nothing%s"
				)
				% [node_path, why, cover]
			)
		return "%s does not process (%s), so clicking it does nothing%s" % [node_path, why, cover]
	return ""
