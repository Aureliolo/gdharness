extends RefCounted

const Log = preload("logger.gd")

# The key names a caller may write, and what the engine calls them.
const KEY_NAMES = {
	"A": KEY_A,
	"B": KEY_B,
	"C": KEY_C,
	"D": KEY_D,
	"E": KEY_E,
	"F": KEY_F,
	"G": KEY_G,
	"H": KEY_H,
	"I": KEY_I,
	"J": KEY_J,
	"K": KEY_K,
	"L": KEY_L,
	"M": KEY_M,
	"N": KEY_N,
	"O": KEY_O,
	"P": KEY_P,
	"Q": KEY_Q,
	"R": KEY_R,
	"S": KEY_S,
	"T": KEY_T,
	"U": KEY_U,
	"V": KEY_V,
	"W": KEY_W,
	"X": KEY_X,
	"Y": KEY_Y,
	"Z": KEY_Z,
	"0": KEY_0,
	"1": KEY_1,
	"2": KEY_2,
	"3": KEY_3,
	"4": KEY_4,
	"5": KEY_5,
	"6": KEY_6,
	"7": KEY_7,
	"8": KEY_8,
	"9": KEY_9,
	"F1": KEY_F1,
	"F2": KEY_F2,
	"F3": KEY_F3,
	"F4": KEY_F4,
	"F5": KEY_F5,
	"F6": KEY_F6,
	"F7": KEY_F7,
	"F8": KEY_F8,
	"F9": KEY_F9,
	"F10": KEY_F10,
	"F11": KEY_F11,
	"F12": KEY_F12,
	"Space": KEY_SPACE,
	"Escape": KEY_ESCAPE,
	"Tab": KEY_TAB,
	"Enter": KEY_ENTER,
	"Return": KEY_ENTER,
	"Backspace": KEY_BACKSPACE,
	"Delete": KEY_DELETE,
	"Up": KEY_UP,
	"Down": KEY_DOWN,
	"Left": KEY_LEFT,
	"Right": KEY_RIGHT,
	"Home": KEY_HOME,
	"End": KEY_END,
	"PageUp": KEY_PAGEUP,
	"PageDown": KEY_PAGEDOWN,
	"Insert": KEY_INSERT,
	"Shift": KEY_SHIFT,
	"Ctrl": KEY_CTRL,
	"Alt": KEY_ALT,
	"CapsLock": KEY_CAPSLOCK,
	"NumLock": KEY_NUMLOCK,
	"KP0": KEY_KP_0,
	"KP1": KEY_KP_1,
	"KP2": KEY_KP_2,
	"KP3": KEY_KP_3,
	"KP4": KEY_KP_4,
	"KP5": KEY_KP_5,
	"KP6": KEY_KP_6,
	"KP7": KEY_KP_7,
	"KP8": KEY_KP_8,
	"KP9": KEY_KP_9,
	"Comma": KEY_COMMA,
	"Period": KEY_PERIOD,
	"Slash": KEY_SLASH,
	"Backslash": KEY_BACKSLASH,
	"Semicolon": KEY_SEMICOLON,
	"Apostrophe": KEY_APOSTROPHE,
	"BracketLeft": KEY_BRACKETLEFT,
	"BracketRight": KEY_BRACKETRIGHT,
	"Minus": KEY_MINUS,
	"Equal": KEY_EQUAL,
}

var _log: Log


func _init(p_log: Log) -> void:
	_log = p_log


# Add an input action to the InputMap
func add_input_action(params) -> Dictionary:
	var action_name = params.action_name
	var events = params.events
	var deadzone = params.get("deadzone", 0.5)

	_log.info("Adding input action: " + action_name)
	_log.debug("Events: " + JSON.stringify(events))
	_log.debug("Deadzone: " + str(deadzone))

	# Read project.godot
	var config = ConfigFile.new()
	var err = config.load("res://project.godot")
	if err != OK:
		return _log.failure("Failed to load project.godot: " + str(err))

	# Build the input action configuration
	var events_config = []

	for event in events:
		var event_type = event.get("type", "")

		match event_type:
			"key":
				var keycode = event.get("keycode", "")
				if keycode.is_empty():
					_log.error("Keycode is required for key events")
					continue

				var event_config = {"class_name": "InputEventKey", "keycode": _keycode_value(keycode)}

				# Add modifiers
				if event.get("ctrl", false):
					event_config["ctrl_pressed"] = true
				if event.get("alt", false):
					event_config["alt_pressed"] = true
				if event.get("shift", false):
					event_config["shift_pressed"] = true

				events_config.append(event_config)

			"mouse_button":
				events_config.append(
					{"class_name": "InputEventMouseButton", "button_index": event.get("button", 1)}
				)

			"joypad_button":
				events_config.append(
					{"class_name": "InputEventJoypadButton", "button_index": event.get("button", 0)}
				)

			"joypad_axis":
				events_config.append(
					{
						"class_name": "InputEventJoypadMotion",
						"axis": event.get("axis", 0),
						"axis_value": event.get("axis_value", event.get("axisValue", 1))
					}
				)

			_:
				_log.error("Unknown event type: " + event_type)

	if events_config.size() == 0:
		return _log.failure("No valid events provided")

	var action = build_input_action(deadzone, events_config)
	if action.is_empty():
		return {}

	config.set_value("input", action_name, action)

	# Save project.godot
	err = config.save("res://project.godot")
	if err != OK:
		return _log.failure("Failed to save project.godot: " + str(err))

	return {
		"action_name": action_name,
		"events_count": events_config.size(),
		"deadzone": deadzone,
		"events": events_config
	}


# The value project.godot stores for one input action.
#
# It has to be a Dictionary holding real InputEvent objects. ConfigFile writes those as the
# unquoted expression Godot parses back into an action; hand it the same thing as assembled
# text and it writes a quoted, escaped string, which loads as a String and leaves InputMap
# with no action at all while add_input_action still reports the events it was given.
func build_input_action(deadzone: float, events: Array) -> Dictionary:
	var built: Array = []

	for event in events:
		var evt_class = event.get("class_name", "")

		match evt_class:
			"InputEventKey":
				var key := InputEventKey.new()
				key.keycode = int(event.get("keycode", 0))
				key.ctrl_pressed = bool(event.get("ctrl_pressed", false))
				key.alt_pressed = bool(event.get("alt_pressed", false))
				key.shift_pressed = bool(event.get("shift_pressed", false))
				built.append(key)

			"InputEventMouseButton":
				var mouse := InputEventMouseButton.new()
				mouse.button_index = int(event.get("button_index", MOUSE_BUTTON_LEFT))
				built.append(mouse)

			"InputEventJoypadButton":
				var pad := InputEventJoypadButton.new()
				pad.button_index = int(event.get("button_index", 0))
				built.append(pad)

			"InputEventJoypadMotion":
				var motion := InputEventJoypadMotion.new()
				motion.axis = int(event.get("axis", 0))
				motion.axis_value = float(event.get("axis_value", 1.0))
				built.append(motion)

			_:
				return _log.failure("Unknown input event class: " + str(evt_class))

	return {"deadzone": deadzone, "events": built}


func _keycode_value(key_name: String) -> int:
	var upper_key = key_name.to_upper()
	if KEY_NAMES.has(upper_key):
		return KEY_NAMES[upper_key]
	if KEY_NAMES.has(key_name):
		return KEY_NAMES[key_name]

	# If not found, try to find by exact match or lowercase version
	for k in KEY_NAMES:
		if k.to_lower() == key_name.to_lower():
			return KEY_NAMES[k]

	_log.error("Unknown key: " + key_name)
	return 0
