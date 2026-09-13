extends RefCounted

## Input handed to the running game as if a player had given it: actions, keys, the mouse, and
## a whole click on a Control found by path.

const Values = preload("runtime_values.gd")

var _host: Node
var _values: Values


func _init(host: Node, values: Values) -> void:
	_host = host
	_values = values


func inject_action(params: Dictionary) -> Dictionary:
	var action: String = String(params.get("action", ""))
	var pressed: bool = bool(params.get("pressed", true))
	var strength: float = float(params.get("strength", 1.0))

	if action.is_empty():
		return {"type": "error", "message": "Action name required"}

	if not InputMap.has_action(action):
		return {"type": "error", "message": "Action not found: " + action}

	var event := InputEventAction.new()
	event.action = action
	event.pressed = pressed
	event.strength = strength
	Input.parse_input_event(event)

	return {"type": "input_injected", "input_type": "action", "action": action, "pressed": pressed}


func inject_key(params: Dictionary) -> Dictionary:
	var keycode_raw: Variant = params.get("keycode", 0)
	var pressed: bool = bool(params.get("pressed", true))
	var key_label: String = String(params.get("key_label", ""))

	if keycode_raw is String:
		var named: String = keycode_raw
		if not named.is_empty() and key_label.is_empty():
			key_label = named
	var keycode: int = 0 if keycode_raw is String else int(keycode_raw)

	var event := InputEventKey.new()
	event.pressed = pressed

	if not key_label.is_empty():
		event.keycode = OS.find_keycode_from_string(key_label)
		if event.keycode == KEY_NONE:
			return {"type": "error", "message": "Invalid key_label: " + key_label}
	elif keycode > 0:
		event.keycode = keycode as Key
	else:
		return {"type": "error", "message": "keycode or key_label required"}

	# A key event from a real keyboard carries all three, and InputMap consults whichever one
	# the bound event declares: keycode first, then physical_keycode, then key_label. An
	# injected event with only keycode set can therefore never match an action bound by
	# physical key, which is how a rebinding UI normally stores one, so inject_key silently
	# did nothing for those actions.
	event.physical_keycode = event.keycode
	event.key_label = event.keycode

	event.shift_pressed = bool(params.get("shift", false))
	event.ctrl_pressed = bool(params.get("ctrl", false))
	event.alt_pressed = bool(params.get("alt", false))

	Input.parse_input_event(event)

	return {
		"type": "input_injected",
		"input_type": "key",
		"keycode": event.keycode,
		"physical_keycode": event.physical_keycode,
		"shift": event.shift_pressed,
		"ctrl": event.ctrl_pressed,
		"alt": event.alt_pressed,
		"pressed": pressed
	}


## A point the tool schema sends as two flat numbers, or the older form of one [x, y] value.
## Answers a Vector2, or the String that says what was wrong with it.
func _read_point(params: Dictionary, x_key: String, y_key: String, pair_key: String) -> Variant:
	if params.has(x_key) and params.has(y_key):
		return Vector2(float(params[x_key]), float(params[y_key]))
	var raw: Variant = params.get(pair_key, Vector2.ZERO)
	if raw is Vector2:
		return raw
	if raw is Array:
		var pair: Array = raw
		if pair.size() < 2:
			return "%s array must contain [x, y]" % pair_key
		return Vector2(float(pair[0]), float(pair[1]))
	return "%s must be Vector2 or [x, y]" % pair_key


func inject_mouse_click(params: Dictionary) -> Dictionary:
	var point: Variant = _read_point(params, "x", "y", "position")
	if point is String:
		return {"type": "error", "message": point}
	var position: Vector2 = point
	var button: int = _resolve_mouse_button(params.get("button", MOUSE_BUTTON_LEFT))
	var pressed: bool = bool(params.get("pressed", true))
	var double: bool = bool(params.get("doubleClick", false))

	Input.parse_input_event(_button(position, button, pressed, double))

	return {
		"type": "input_injected",
		"input_type": "mouse_click",
		"position": [position.x, position.y],
		"button": button,
		"pressed": pressed,
		"double": double
	}


func inject_mouse_motion(params: Dictionary) -> Dictionary:
	var point: Variant = _read_point(params, "x", "y", "position")
	if point is String:
		return {"type": "error", "message": point}
	var position: Vector2 = point
	var movement: Variant = _read_point(params, "relativeX", "relativeY", "relative")
	if movement is String:
		return {"type": "error", "message": movement}
	var relative: Vector2 = movement

	Input.parse_input_event(_motion(position, relative))

	return {
		"type": "input_injected",
		"input_type": "mouse_motion",
		"position": [position.x, position.y],
		"relative": [relative.x, relative.y]
	}


## A whole click on a Control: the pointer moves onto it, the button goes down, a frame passes,
## the button comes up. BaseButton fires on the release, which is why a single injected press
## never pressed anything. The position is the control's centre carried into window pixels, so
## the caller never has to do that arithmetic.
func click(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	if node_path.is_empty():
		return {"type": "error", "message": "Node path required"}

	var node: Node = _host.get_tree().root.get_node_or_null(node_path)
	if node == null:
		return {"type": "error", "message": "Node not found: " + node_path}
	if not node is Control:
		return {"type": "error", "message": "%s is a %s, not a Control" % [node_path, node.get_class()]}
	var control: Control = node
	if not control.is_visible_in_tree():
		return {"type": "error", "message": "%s is not visible, so nothing can click it" % node_path}

	var viewport: Viewport = control.get_viewport()
	var centre: Vector2 = control.get_global_transform_with_canvas() * (control.size * 0.5)
	var position: Vector2 = viewport.get_final_transform() * centre
	# The GUI only delivers to what is inside the viewport, so a centre outside it would be a
	# click that silently reached nothing.
	if not viewport.get_visible_rect().has_point(centre):
		return {
			"type": "error",
			"message":
			(
				"%s has its centre at %s, outside the viewport %s, so nothing can click it"
				% [node_path, centre, viewport.get_visible_rect()]
			)
		}
	var button: int = _resolve_mouse_button(params.get("button", MOUSE_BUTTON_LEFT))
	var double: bool = bool(params.get("double", false))

	# Pushed into the viewport rather than through Input: Input hands an event to the window
	# it names, and a headless engine has no window to hand it to, so a click sent that way
	# reaches nothing. The viewport delivers it to the GUI the same way a real one arrives.
	viewport.push_input(_motion(position, Vector2.ZERO))
	# What the engine itself thinks is under the pointer, which is the answer to "did it land",
	# read before the press so the caller learns about a control on top rather than a click
	# that went to it.
	var hovered: Control = viewport.gui_get_hovered_control()

	viewport.push_input(_button(position, button, true, double))
	await _host.get_tree().process_frame
	viewport.push_input(_button(position, button, false, false))

	var hovered_path: Variant = null
	if hovered != null:
		hovered_path = str(hovered.get_path())
	return {
		"type": "clicked",
		"path": node_path,
		"position": _values.serialize(position),
		"button": button,
		"double": double,
		"hovered": hovered_path,
		"landed": hovered == control or (hovered != null and control.is_ancestor_of(hovered)),
	}


func _motion(position: Vector2, relative: Vector2) -> InputEventMouseMotion:
	var event := InputEventMouseMotion.new()
	event.position = position
	event.global_position = position
	event.relative = relative
	return event


func _button(position: Vector2, button: int, pressed: bool, double: bool) -> InputEventMouseButton:
	var event := InputEventMouseButton.new()
	event.position = position
	event.global_position = position
	event.button_index = button as MouseButton
	event.pressed = pressed
	event.double_click = double
	return event


func _resolve_mouse_button(raw: Variant) -> int:
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
				return MOUSE_BUTTON_LEFT
	return int(raw)
