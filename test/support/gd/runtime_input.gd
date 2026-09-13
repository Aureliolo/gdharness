extends SceneTree

## The runtime's input injection, driven the way the socket drives it and asserted on what the
## engine does with the event rather than on what the command echoes back. The autoload is a
## Node, so it instantiates without joining the tree and never starts its server.

const Runtime = preload("res://addons/godot_mcp_runtime/mcp_runtime_autoload.gd")

var failures: Array[String] = []


func _init() -> void:
	var node: Runtime = Runtime.new()

	_check_keys(node)
	_check_mouse(node)
	_check_actions(node)
	node.free()

	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return

	printerr("\n".join(failures))
	quit(1)


func _fail(message: String) -> void:
	failures.append(message)


## An action bound the way a rebinding screen stores one: by physical key, or by label, with
## no keycode at all. A real keyboard event carries all three and matches either.
func _bind(action: String, physical: Key, label: Key) -> void:
	InputMap.add_action(action)
	var event: InputEventKey = InputEventKey.new()
	event.physical_keycode = physical
	event.key_label = label
	InputMap.action_add_event(action, event)


func _pressed(action: String) -> bool:
	Input.flush_buffered_events()
	return Input.is_action_pressed(action)


func _check_keys(node: Runtime) -> void:
	# A string keycode is a key label, and the label is what names the key.
	var by_string: Dictionary = node._cmd_inject_key({"keycode": "A"})
	if by_string.get("type", "") != "input_injected":
		_fail("string keycode: %s" % JSON.stringify(by_string))
	elif by_string.get("keycode", 0) != KEY_A or by_string.get("physical_keycode", 0) != KEY_A:
		_fail("string keycode should carry keycode and physical_keycode: %s" % JSON.stringify(by_string))

	var by_number: Dictionary = node._cmd_inject_key({"keycode": KEY_B})
	if by_number.get("keycode", 0) != KEY_B:
		_fail("numeric keycode: %s" % JSON.stringify(by_number))

	var bad_label: Dictionary = node._cmd_inject_key({"key_label": "NoSuchKey"})
	if bad_label.get("type", "") != "error":
		_fail("an unknown key label should be refused: %s" % JSON.stringify(bad_label))

	var nothing: Dictionary = node._cmd_inject_key({})
	if nothing.get("type", "") != "error":
		_fail("a key event needs a key: %s" % JSON.stringify(nothing))

	var modified: Dictionary = node._cmd_inject_key(
		{"key_label": "Escape", "shift": true, "ctrl": true, "alt": true}
	)
	if not (modified.get("shift", false) and modified.get("ctrl", false) and modified.get("alt", false)):
		_fail("modifiers should reach the event: %s" % JSON.stringify(modified))

	_bind("fixture_physical", KEY_C, KEY_NONE)
	node._cmd_inject_key({"keycode": "C"})
	if not _pressed("fixture_physical"):
		_fail("a key injected by label should press an action bound by physical key")
	node._cmd_inject_key({"keycode": "C", "pressed": false})
	if _pressed("fixture_physical"):
		_fail("releasing the key should release the action")

	_bind("fixture_label", KEY_NONE, KEY_D)
	node._cmd_inject_key({"keycode": KEY_D})
	if not _pressed("fixture_label"):
		_fail("a key injected by keycode should press an action bound by label")


func _check_mouse(node: Runtime) -> void:
	# The tool schema sends flat x and y; the older nested form still has to work.
	var flat: Dictionary = node._cmd_inject_mouse_click({"x": 10, "y": 20, "button": "right"})
	if flat.get("position", []) != [10.0, 20.0] or flat.get("button", 0) != MOUSE_BUTTON_RIGHT:
		_fail("flat click: %s" % JSON.stringify(flat))

	var nested: Dictionary = node._cmd_inject_mouse_click({"position": [1, 2], "button": 3})
	if nested.get("position", []) != [1.0, 2.0] or nested.get("button", 0) != MOUSE_BUTTON_MIDDLE:
		_fail("nested click: %s" % JSON.stringify(nested))

	var short: Dictionary = node._cmd_inject_mouse_click({"position": [1]})
	if short.get("type", "") != "error":
		_fail("a one-element position should be refused: %s" % JSON.stringify(short))

	var motion: Dictionary = node._cmd_inject_mouse_motion({"x": 1, "y": 2, "relativeX": 3, "relativeY": 4})
	if motion.get("position", []) != [1.0, 2.0] or motion.get("relative", []) != [3.0, 4.0]:
		_fail("flat motion: %s" % JSON.stringify(motion))

	var nested_motion: Dictionary = node._cmd_inject_mouse_motion({"position": [5, 6], "relative": [7, 8]})
	if nested_motion.get("relative", []) != [7.0, 8.0]:
		_fail("nested motion: %s" % JSON.stringify(nested_motion))

	if node._resolve_mouse_button("WHEEL_UP") != MOUSE_BUTTON_WHEEL_UP:
		_fail("button names are read in any case")
	if node._resolve_mouse_button(2) != MOUSE_BUTTON_RIGHT:
		_fail("a numeric button is taken as it is")


func _check_actions(node: Runtime) -> void:
	var missing: Dictionary = node._cmd_inject_action({"action": "fixture_missing"})
	if missing.get("type", "") != "error":
		_fail("an unknown action should be refused: %s" % JSON.stringify(missing))

	node._cmd_inject_action({"action": "fixture_physical"})
	if not _pressed("fixture_physical"):
		_fail("an injected action should read as pressed")
	node._cmd_inject_action({"action": "fixture_physical", "pressed": false})
	if _pressed("fixture_physical"):
		_fail("an injected release should read as released")
