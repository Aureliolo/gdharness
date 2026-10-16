extends RefCounted

## What a pointer call names: a point, the stroke of a drag, a mouse button and its mask bit. Read
## here and sent from runtime_input.gd, which keeps where the pointer is.

const Read = preload("reading.gd")


## A point the tool schema sends as two flat numbers, or the older form of one [x, y] value.
## Answers a Vector2, or the String that says what was wrong with it.
static func read_point(params: Dictionary, x_key: String, y_key: String, pair_key: String) -> Variant:
	if params.has(x_key) and params.has(y_key):
		return Vector2(Read.as_float(params[x_key]), Read.as_float(params[y_key]))
	var raw: Variant = params.get(pair_key, Vector2.ZERO)
	if raw is Vector2:
		return raw
	if raw is Array:
		var pair: Array = raw
		if pair.size() < 2:
			return "%s array must contain [x, y]" % pair_key
		return Vector2(Read.as_float(pair[0]), Read.as_float(pair[1]))
	return "%s must be Vector2 or [x, y]" % pair_key


## The points of a drag: x, y, then each of via, then toX, toY. Answers the String saying what is
## wrong instead, since a point left out would otherwise read as the window's corner.
static func stroke_of(params: Dictionary) -> Variant:
	for key: String in ["x", "y", "toX", "toY"]:
		if not params.has(key):
			return "mouse_drag needs x, y, toX and toY: %s is missing." % key
	var points: Array[Vector2] = [Vector2(Read.as_float(params["x"]), Read.as_float(params["y"]))]
	var via: Variant = params.get("via", [])
	if not via is Array:
		return "via must be a list of [x, y] points."
	var between: Array = via
	for point: Variant in between:
		var pair: Array = point if point is Array else []
		if pair.size() < 2:
			return "via must be a list of [x, y] points, and holds %s." % JSON.stringify(point)
		points.append(Vector2(Read.as_float(pair[0]), Read.as_float(pair[1])))
	points.append(Vector2(Read.as_float(params["toX"]), Read.as_float(params["toY"])))
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


## What to say about a name that is not a mouse button, with the ones that are.
static func no_such_button(named: Variant) -> Dictionary:
	return {
		"type": "error",
		"message":
		(
			"%s is not a mouse button. It takes: left, right, middle, wheel_up, wheel_down, or the number of one."
			% JSON.stringify(named)
		)
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
	var number: int = Read.as_int(raw, -1)
	return number if number >= MOUSE_BUTTON_LEFT and number <= MOUSE_BUTTON_XBUTTON2 else -1
