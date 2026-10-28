extends RefCounted
## What reaches the running game the way a controller reaches it: a button pressed and a stick or
## trigger moved, as the events a pad sends.
##
## The events themselves rather than the actions bound to them: a game reading the pad in _input or
## _unhandled_input looks for InputEventJoypadButton and InputEventJoypadMotion, and an action
## reached it as an InputEventAction it never reads, so a controller layout could only be driven by
## calling the game's own methods. The engine still fires the actions bound to a button from these.

const GdhRead = preload("reading.gd")
const GdhValues = preload("runtime_values.gd")
## Controller buttons by the names Godot gives them, for a caller naming one rather than numbering
## it.
const JOY_BUTTONS: Dictionary[String, int] = {
	"a": JOY_BUTTON_A,
	"b": JOY_BUTTON_B,
	"x": JOY_BUTTON_X,
	"y": JOY_BUTTON_Y,
	"back": JOY_BUTTON_BACK,
	"guide": JOY_BUTTON_GUIDE,
	"start": JOY_BUTTON_START,
	"left_stick": JOY_BUTTON_LEFT_STICK,
	"right_stick": JOY_BUTTON_RIGHT_STICK,
	"left_shoulder": JOY_BUTTON_LEFT_SHOULDER,
	"right_shoulder": JOY_BUTTON_RIGHT_SHOULDER,
	"dpad_up": JOY_BUTTON_DPAD_UP,
	"dpad_down": JOY_BUTTON_DPAD_DOWN,
	"dpad_left": JOY_BUTTON_DPAD_LEFT,
	"dpad_right": JOY_BUTTON_DPAD_RIGHT,
	"misc1": JOY_BUTTON_MISC1,
	"paddle1": JOY_BUTTON_PADDLE1,
	"paddle2": JOY_BUTTON_PADDLE2,
	"paddle3": JOY_BUTTON_PADDLE3,
	"paddle4": JOY_BUTTON_PADDLE4,
	"touchpad": JOY_BUTTON_TOUCHPAD,
}
## Stick and trigger axes by the names Godot gives them.
const JOY_AXES: Dictionary[String, int] = {
	"left_x": JOY_AXIS_LEFT_X,
	"left_y": JOY_AXIS_LEFT_Y,
	"right_x": JOY_AXIS_RIGHT_X,
	"right_y": JOY_AXIS_RIGHT_Y,
	"trigger_left": JOY_AXIS_TRIGGER_LEFT,
	"trigger_right": JOY_AXIS_TRIGGER_RIGHT,
}

var _host: Node


func _init(host: Node) -> void:
	_host = host


## Presses a controller button, and lets go of it again unless asked to hold it, as a key press
## does: a button left down is a press that never ends, and everything reading it goes on seeing it.
func inject_joypad_button(params: Dictionary) -> Dictionary:
	var given: Variant = params.get("button", null)
	var button: int = _named_or_numbered(given, JOY_BUTTONS, JOY_BUTTON_MAX)
	if button < 0:
		return {
			"type": "error", "message": _not_one_of("button", given, JOY_BUTTONS, JOY_BUTTON_MAX),
		}
	var device: int = GdhRead.as_int(params.get("device", 0), 0)
	var held: bool = GdhRead.as_bool(params.get("pressed", true), true)
	var whole: bool = not params.has("pressed")
	var holding: Variant = GdhValues.held_for(params)
	if holding is String:
		return { "type": "error", "message": holding }
	var frames: int = holding

	var focused: String = GdhValues.focus_path(_host)
	var event: InputEventJoypadButton = _button(button, device, whole or held)
	Input.parse_input_event(event)
	var lasted: Variant = null
	if whole:
		# A frame between the halves at least, as a key has, so a game that acts on the press and
		# one that acts on the release each get a frame to do it in.
		lasted = await GdhValues.hold(_host.get_tree(), frames)
		Input.parse_input_event(_button(button, device, false))
	# The engine hands a parsed event on at the next frame, so the focus is read after one.
	await _host.get_tree().process_frame

	var answer: Dictionary = {
		"type": "input_injected",
		"input_type": "joypad_button",
		"held_frames": GdhValues.held_answer(whole, frames),
		"held_for": lasted,
		"button": button,
		"button_name": _name_of(button, JOY_BUTTONS),
		"device": device,
		"actions": GdhValues.actions_of(event),
		"pressed": held and not whole,
		"whole": whole,
	}
	return GdhValues.focus_noted(answer, focused, _host)


## Moves a stick or trigger axis to a value, where it stays until another motion moves it, as a
## stick held over does.
func inject_joypad_motion(params: Dictionary) -> Dictionary:
	var given: Variant = params.get("axis", null)
	var axis: int = _named_or_numbered(given, JOY_AXES, JOY_AXIS_MAX)
	if axis < 0:
		return { "type": "error", "message": _not_one_of("axis", given, JOY_AXES, JOY_AXIS_MAX) }
	if not params.has("value"):
		return {
			"type": "error",
			"message": "joypad_motion needs value, where the axis is, -1 to 1",
		}
	var value: float = GdhRead.as_float(params.get("value"), 0.0)
	if value < -1.0 or value > 1.0:
		return {
			"type": "error",
			"message": "value %s is outside -1 to 1, the whole travel of an axis" % value,
		}
	var device: int = GdhRead.as_int(params.get("device", 0), 0)

	var event: InputEventJoypadMotion = InputEventJoypadMotion.new()
	event.axis = axis as JoyAxis
	event.axis_value = value
	event.device = device
	var focused: String = GdhValues.focus_path(_host)
	Input.parse_input_event(event)
	await _host.get_tree().process_frame

	var answer: Dictionary = {
		"type": "input_injected",
		"input_type": "joypad_motion",
		"axis": axis,
		"axis_name": _name_of(axis, JOY_AXES),
		"value": value,
		"device": device,
		"actions": GdhValues.actions_of(event),
	}
	return GdhValues.focus_noted(answer, focused, _host)


static func _button(button: int, device: int, down: bool) -> InputEventJoypadButton:
	var event: InputEventJoypadButton = InputEventJoypadButton.new()
	event.button_index = button as JoyButton
	event.pressed = down
	event.device = device
	return event


## [param given] as one of [param names], or as a number below [param count], or -1 for neither.
static func _named_or_numbered(given: Variant, names: Dictionary[String, int], count: int) -> int:
	if given is String:
		var named: String = given
		return GdhRead.as_int(names.get(named.strip_edges().to_lower(), -1), -1)
	if given is int or given is float:
		var number: int = GdhRead.as_int(given, -1)
		return number if number >= 0 and number < count else -1
	return -1


static func _not_one_of(
	argument: String, given: Variant, names: Dictionary[String, int], count: int
) -> String:
	return (
		"%s %s is not one: give its name, one of %s, or its number, 0 to %d"
		% [argument, JSON.stringify(given), ", ".join(PackedStringArray(names.keys())), count - 1]
	)


## The name [param number] goes by in [param names], or empty for a number with none.
static func _name_of(number: int, names: Dictionary[String, int]) -> String:
	for named: String in names:
		if names[named] == number:
			return named
	return ""
