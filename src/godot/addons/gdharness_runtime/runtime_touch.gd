extends RefCounted
## What reaches the running game the way a touchscreen reaches it: a finger pressed, held, lifted
## and dragged, as InputEventScreenTouch and InputEventScreenDrag.
##
## The events themselves rather than a mouse standing in for them: input code tells a finger from a
## mouse by the event's class, or by the mouse events the engine makes from a touch, which carry
## InputEvent.DEVICE_ID_EMULATION. A mouse_click carries the mouse's own device, so a game switching
## its glyphs or focus on a touch never saw one. Sent through Input for the game's window, so the
## engine makes those mouse events itself where input_devices/pointing/emulate_mouse_from_touch is
## on.

const GdhRead = preload("reading.gd")
const GdhValues = preload("runtime_values.gd")
const GdhMouse = preload("runtime_mouse.gd")
const EMULATE_SETTING: String = "input_devices/pointing/emulate_mouse_from_touch"

var _host: Node
# The finger the engine makes mouse events from, as Input keeps it for the touches sent here: the
# first one pressed while none is, until it lifts. -1 for none.
var _emulating: int = -1


func _init(host: Node) -> void:
	_host = host


## Presses a finger at a position, and lifts it a frame later unless asked to hold it, as
## inject_mouse_click does a button: a finger left down is a touch that never ends.
func inject_touch(params: Dictionary) -> Dictionary:
	var root: Window = _host.get_tree().root
	var aimed: Variant = GdhMouse.aim_of(params, root)
	if aimed is String:
		return { "type": "error", "message": aimed }
	var aim: Dictionary = aimed
	var point: Variant = GdhMouse.read_point(params, "x", "y")
	if point is String:
		return { "type": "error", "message": point }
	var finger: Variant = _finger_of(params)
	if finger is String:
		return { "type": "error", "message": finger }
	var index: int = finger
	var holding: Variant = GdhValues.held_for(params)
	if holding is String:
		return { "type": "error", "message": holding }
	var frames: int = holding
	var local: Vector2 = point
	var placed: Dictionary = GdhMouse.carried(aim, local, root)
	var viewport: Viewport = placed["viewport"]
	var position: Vector2 = placed["position"]
	var held: bool = GdhRead.as_bool(params.get("pressed", true), true)
	var whole: bool = not params.has("pressed")

	var at: Array[Vector2] = [position]
	var where: Dictionary = GdhMouse.where(aim, viewport, at)
	var emulates: bool = _send(viewport, _touch(position, index, whole or held))
	var lasted: Variant = null
	if whole:
		lasted = await GdhValues.hold(_host.get_tree(), frames)
		var _lifted: bool = _send(viewport, _touch(position, index, false))
	await _host.get_tree().process_frame

	var answer: Dictionary = {
		"type": "input_injected",
		"input_type": "touch",
		"index": index,
		"position": [position.x, position.y],
		"held_frames": GdhValues.held_answer(whole, frames),
		"held_for": lasted,
		"pressed": held and not whole,
		"whole": whole,
		"emulates_mouse": emulates,
	}
	answer.merge(where)
	return answer


## Drags a finger from one point to another through any between: the touch, one drag each process
## frame along the stroke, and the lift where the last drag left it, a frame after it. Each drag
## goes in a frame of its own because the engine merges the drags it is given within one frame, as
## it merges a mouse's motions.
func inject_touch_drag(params: Dictionary) -> Dictionary:
	var root: Window = _host.get_tree().root
	var aimed: Variant = GdhMouse.aim_of(params, root)
	if aimed is String:
		return { "type": "error", "message": aimed }
	var aim: Dictionary = aimed
	var stroke: Variant = GdhMouse.stroke_of(params, "touch_drag")
	if stroke is String:
		return { "type": "error", "message": stroke }
	var finger: Variant = _finger_of(params)
	if finger is String:
		return { "type": "error", "message": finger }
	var index: int = finger
	var frames: int = GdhRead.as_int(params.get("frames", 0), 0)
	if frames < 1 or frames > GdhValues.MOST_HELD:
		return {
			"type": "error",
			"message": "frames is %d, and it takes 1 to %d." % [frames, GdhValues.MOST_HELD],
		}
	# Carried once, before the touch: a finger drags across the screen, not along a node that moves.
	var named: Array[Vector2] = stroke
	var points: Array[Vector2] = []
	var viewport: Viewport = root
	for local: Vector2 in named:
		var placed: Dictionary = GdhMouse.carried(aim, local, root)
		viewport = placed["viewport"]
		points.append(placed["position"])

	var lengths: Array[float] = GdhMouse.lengths_of(points)
	var start: Vector2 = points[0]
	var end: Vector2 = points[points.size() - 1]
	var where: Dictionary = GdhMouse.where(aim, viewport, points)
	var emulates: bool = _send(viewport, _touch(start, index, true))
	var last: Vector2 = start
	var travelled: Vector2 = Vector2.ZERO
	for step: int in range(1, frames + 1):
		await _host.get_tree().process_frame
		if not is_instance_valid(viewport):
			return {
				"type": "error",
				"message":
				(
					(
						"%s was freed after the touch and %d of %d drags, so the rest of the stroke"
						+ " and the lift went nowhere"
					)
					% [where.get("window", "The window"), step - 1, frames]
				),
			}
		var at: Vector2 = GdhMouse.along(points, lengths, float(step) / frames)
		var relative: Vector2 = at - last
		last = at
		travelled += relative
		var _dragged: bool = _send(viewport, _drag(at, relative, index))
	await _host.get_tree().process_frame
	var _lifted: bool = _send(viewport, _touch(end, index, false))
	await _host.get_tree().process_frame

	var answer: Dictionary = {
		"type": "input_injected",
		"input_type": "touch_drag",
		"index": index,
		"from": [start.x, start.y],
		"to": [end.x, end.y],
		"motions": frames,
		"relative_total": [travelled.x, travelled.y],
		"emulates_mouse": emulates,
	}
	answer.merge(where)
	return answer


## The finger [param params].index names, 0 when none is given, or the String refusing it.
static func _finger_of(params: Dictionary) -> Variant:
	if not params.has("index"):
		return 0
	var given: Variant = params["index"]
	var number: float = GdhRead.as_float(given)
	if not (given is int or given is float) or number != roundf(number):
		return "index is the finger, a whole number from 0, and was %s." % JSON.stringify(given)
	var index: int = roundi(number)
	if index < 0:
		return "index is the finger, a whole number from 0, and was %d." % index
	return index


## Sends [param event] into [param viewport]: through Input for the game's window, and pushed into
## any other, since Input reaches only the game's window. Answers whether the engine makes a mouse
## event from it, which it does in Input, with the setting on, for one finger at a time.
func _send(viewport: Viewport, event: InputEvent) -> bool:
	if viewport != _host.get_tree().root:
		if is_instance_valid(viewport):
			viewport.push_input(event)
		return false
	Input.parse_input_event(event)
	if not GdhRead.as_bool(ProjectSettings.get_setting(EMULATE_SETTING, true), true):
		return false
	var touch: InputEventScreenTouch = event as InputEventScreenTouch
	if touch == null:
		return (event as InputEventScreenDrag).index == _emulating
	if touch.pressed:
		if _emulating != -1:
			return false
		_emulating = touch.index
		return true
	if touch.index != _emulating:
		return false
	_emulating = -1
	return true


static func _touch(position: Vector2, index: int, pressed: bool) -> InputEventScreenTouch:
	var event: InputEventScreenTouch = InputEventScreenTouch.new()
	event.index = index
	event.position = position
	event.pressed = pressed
	return event


## A drag carrying [param relative] as the movement since the last, and the speed that is at the
## frame rate the game runs at.
func _drag(position: Vector2, relative: Vector2, index: int) -> InputEventScreenDrag:
	var event: InputEventScreenDrag = InputEventScreenDrag.new()
	event.index = index
	event.position = position
	event.relative = relative
	event.screen_relative = relative
	var seconds: float = maxf(_host.get_process_delta_time(), 1.0 / 60.0)
	event.velocity = relative / seconds
	event.screen_velocity = event.velocity
	return event
