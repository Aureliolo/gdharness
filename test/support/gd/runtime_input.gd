extends SceneTree

## The runtime's input injection, driven the way the socket drives it and asserted on what the
## engine does with the event rather than on what the command echoes back. The input module
## needs no tree for any of this, so it is built on a bare node and never joins one.

const InputCommands = preload("res://addons/gdharness_runtime/runtime_input.gd")
const Values = preload("res://addons/gdharness_runtime/runtime_values.gd")

var failures: Array[String] = []

var _frames: int = 0
var _field: LineEdit = null
var _typing: InputCommands = null


func _init() -> void:
	var host: Node = Node.new()
	var input: InputCommands = InputCommands.new(host, Values.new())

	_check_keys(input)
	_check_mouse(input)
	_check_actions(input)
	host.free()


## Typing needs the tree the rest of this does not: a character goes wherever the focus is, and
## there is no focus until there is a viewport holding it. Measured rather than assumed, because
## `_initialize` looks like the place and is not: the root is not inside the tree yet there, so a
## control added to it cannot take the focus and a node added to it has no tree to ask.
##
## Two frames, because the two commands take different routes on purpose: text is pushed into the
## viewport and has landed by the time the call returns, while a key goes through Input and is
## delivered with everything else at the top of the next frame.
func _process(_delta: float) -> bool:
	_frames += 1
	if _frames == 1:
		var host: Node = Node.new()
		root.add_child(host)
		_typing = InputCommands.new(host, Values.new())
		_check_typing(_typing)
		_type_with_keys(_typing)
		return false

	_check_what_the_keys_typed()

	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return true

	printerr("\n".join(failures))
	quit(1)
	return true


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


func _check_keys(input: InputCommands) -> void:
	# A string keycode is a key label, and the label is what names the key.
	var by_string: Dictionary = input.inject_key({"keycode": "A"})
	if by_string.get("type", "") != "input_injected":
		_fail("string keycode: %s" % JSON.stringify(by_string))
	elif by_string.get("keycode", 0) != KEY_A or by_string.get("physical_keycode", 0) != KEY_A:
		_fail("string keycode should carry keycode and physical_keycode: %s" % JSON.stringify(by_string))

	var by_number: Dictionary = input.inject_key({"keycode": KEY_B})
	if by_number.get("keycode", 0) != KEY_B:
		_fail("numeric keycode: %s" % JSON.stringify(by_number))

	var bad_label: Dictionary = input.inject_key({"key_label": "NoSuchKey"})
	if bad_label.get("type", "") != "error":
		_fail("an unknown key label should be refused: %s" % JSON.stringify(bad_label))

	var nothing: Dictionary = input.inject_key({})
	if nothing.get("type", "") != "error":
		_fail("a key event needs a key: %s" % JSON.stringify(nothing))

	var modified: Dictionary = input.inject_key(
		{"key_label": "Escape", "shift": true, "ctrl": true, "alt": true}
	)
	if not (modified.get("shift", false) and modified.get("ctrl", false) and modified.get("alt", false)):
		_fail("modifiers should reach the event: %s" % JSON.stringify(modified))

	_bind("fixture_physical", KEY_C, KEY_NONE)
	input.inject_key({"keycode": "C"})
	if not _pressed("fixture_physical"):
		_fail("a key injected by label should press an action bound by physical key")
	input.inject_key({"keycode": "C", "pressed": false})
	if _pressed("fixture_physical"):
		_fail("releasing the key should release the action")

	_bind("fixture_label", KEY_NONE, KEY_D)
	input.inject_key({"keycode": KEY_D})
	if not _pressed("fixture_label"):
		_fail("a key injected by keycode should press an action bound by label")


func _check_mouse(input: InputCommands) -> void:
	# The tool schema sends flat x and y; the older nested form still has to work.
	var flat: Dictionary = input.inject_mouse_click({"x": 10, "y": 20, "button": "right"})
	if flat.get("position", []) != [10.0, 20.0] or flat.get("button", 0) != MOUSE_BUTTON_RIGHT:
		_fail("flat click: %s" % JSON.stringify(flat))

	var nested: Dictionary = input.inject_mouse_click({"position": [1, 2], "button": 3})
	if nested.get("position", []) != [1.0, 2.0] or nested.get("button", 0) != MOUSE_BUTTON_MIDDLE:
		_fail("nested click: %s" % JSON.stringify(nested))

	var short: Dictionary = input.inject_mouse_click({"position": [1]})
	if short.get("type", "") != "error":
		_fail("a one-element position should be refused: %s" % JSON.stringify(short))

	var motion: Dictionary = input.inject_mouse_motion({"x": 1, "y": 2, "relativeX": 3, "relativeY": 4})
	if motion.get("position", []) != [1.0, 2.0] or motion.get("relative", []) != [3.0, 4.0]:
		_fail("flat motion: %s" % JSON.stringify(motion))

	var nested_motion: Dictionary = input.inject_mouse_motion({"position": [5, 6], "relative": [7, 8]})
	if nested_motion.get("relative", []) != [7.0, 8.0]:
		_fail("nested motion: %s" % JSON.stringify(nested_motion))

	if input._resolve_mouse_button("WHEEL_UP") != MOUSE_BUTTON_WHEEL_UP:
		_fail("button names are read in any case")
	if input._resolve_mouse_button(2) != MOUSE_BUTTON_RIGHT:
		_fail("a numeric button is taken as it is")


## What a field ends up holding, which is the only thing that says a key typed anything. Every
## other assertion here reads the event back, and an event can carry a keycode, a physical
## keycode and a label and still put no character anywhere: LineEdit inserts `unicode` and
## consults nothing else, so for a year every injected key pressed actions and typed nothing.
func _check_typing(input: InputCommands) -> void:
	var field: LineEdit = LineEdit.new()
	root.add_child(field)
	field.grab_focus()
	# The keys the constructor injected are still queued in Input and would land in this field
	# the moment anything flushes them, so they are spent before anything here is asserted.
	Input.flush_buffered_events()
	field.clear()
	_field = field

	var typed: Dictionary = input.inject_text({"text": "Ash & Marek, 12!"})
	if typed.get("characters", 0) != 16:
		_fail("typing should report what it typed: %s" % JSON.stringify(typed))
	if field.text != "Ash & Marek, 12!":
		_fail("a field should hold what was typed into it: %s" % field.text)

	var empty: Dictionary = input.inject_text({})
	if empty.get("type", "") != "error":
		_fail("typing nothing should be refused: %s" % JSON.stringify(empty))


## The key op types too, which is the half that was missing rather than the whole command.
func _type_with_keys(input: InputCommands) -> void:
	_field.clear()
	input.inject_key({"keycode": "K"})
	input.inject_key({"keycode": "K", "pressed": false})
	input.inject_key({"keycode": "K", "shift": true})


## And what the two of them left, plus the submission, which comes last for a reason a player
## meets as well: a LineEdit stops editing when it is submitted, so anything typed after an Enter
## lands nowhere however the focus reads.
func _check_what_the_keys_typed() -> void:
	if _field.text != "kK":
		_fail("a key should carry the character it prints, shifted or not: %s" % _field.text)

	# Enter is a key rather than a character, so the field takes it as submission and keeps its
	# text rather than gaining a line break.
	var submitted: Array[String] = []
	_field.text_submitted.connect(func(said: String) -> void: submitted.append(said))
	_typing.inject_text({"text": "\n"})
	if submitted != ["kK"]:
		_fail("a newline should submit the field rather than land in it: %s" % str(submitted))
	if _field.text != "kK":
		_fail("and should leave the text alone: %s" % _field.text)

	_field.queue_free()


func _check_actions(input: InputCommands) -> void:
	var missing: Dictionary = input.inject_action({"action": "fixture_missing"})
	if missing.get("type", "") != "error":
		_fail("an unknown action should be refused: %s" % JSON.stringify(missing))

	input.inject_action({"action": "fixture_physical"})
	if not _pressed("fixture_physical"):
		_fail("an injected action should read as pressed")
	input.inject_action({"action": "fixture_physical", "pressed": false})
	if _pressed("fixture_physical"):
		_fail("an injected release should read as released")
