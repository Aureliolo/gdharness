extends SceneTree

## The runtime's input injection, driven the way the socket drives it and asserted on what the
## engine does with the event rather than on what the command echoes back.
##
## All of it on a host inside the tree, like the autoload the game runs. A press and the release
## after it are a frame apart, and a character goes wherever the focus is, so a module built on a
## bare node has no tree to wait on and no viewport to deliver into. `_initialize` looks like the
## place for the rest and is not: the root is not inside the tree yet there, measured rather than
## assumed.

const InputCommands = preload("res://addons/gdharness_runtime/runtime_input.gd")
const Values = preload("res://addons/gdharness_runtime/runtime_values.gd")


## Counts both halves of a press, which is the only way to see one that is over by the time the
## call answering it returns.
class Watcher:
	extends Node

	var action: String = ""
	var downs: int = 0
	var ups: int = 0

	func _unhandled_input(event: InputEvent) -> void:
		if action.is_empty() or not event.is_action(action):
			return
		if event.is_action_pressed(action):
			downs += 1
		elif event.is_action_released(action):
			ups += 1


var failures: Array[String] = []

var _field: LineEdit = null
var _typing: InputCommands = null
var _begun: bool = false


func _process(_delta: float) -> bool:
	if _begun:
		return false
	_begun = true
	# Through a Callable, because this frame's `_process` cannot wait on a coroutine and still
	# answer whether the tree should carry on.
	_everything.call_deferred()
	return false


## Every check, in order, and the verdict. A coroutine rather than a frame counter: it waits where
## it needs a frame and says so there, which is the whole reason the counter existed.
func _everything() -> void:
	var host: Node = Node.new()
	root.add_child(host)
	var input: InputCommands = InputCommands.new(host, Values.new())
	_typing = input

	await _check_keys(input)
	_check_mouse(input)
	await _check_actions(input)
	_check_typing(input)
	await _type_with_keys(input)
	_check_what_the_keys_typed()

	host.queue_free()
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


func _check_keys(input: InputCommands) -> void:
	# A string keycode is a key label, and the label is what names the key.
	var by_string: Dictionary = await input.inject_key({"keycode": "A"})
	if by_string.get("type", "") != "input_injected":
		_fail("string keycode: %s" % JSON.stringify(by_string))
	elif by_string.get("keycode", 0) != KEY_A or by_string.get("physical_keycode", 0) != KEY_A:
		_fail("string keycode should carry keycode and physical_keycode: %s" % JSON.stringify(by_string))

	var by_number: Dictionary = await input.inject_key({"keycode": KEY_B})
	if by_number.get("keycode", 0) != KEY_B:
		_fail("numeric keycode: %s" % JSON.stringify(by_number))

	var bad_label: Dictionary = await input.inject_key({"key_label": "NoSuchKey"})
	if bad_label.get("type", "") != "error":
		_fail("an unknown key label should be refused: %s" % JSON.stringify(bad_label))

	var nothing: Dictionary = await input.inject_key({})
	if nothing.get("type", "") != "error":
		_fail("a key event needs a key: %s" % JSON.stringify(nothing))

	var modified: Dictionary = await input.inject_key(
		{"key_label": "Escape", "shift": true, "ctrl": true, "alt": true}
	)
	if not (modified.get("shift", false) and modified.get("ctrl", false) and modified.get("alt", false)):
		_fail("modifiers should reach the event: %s" % JSON.stringify(modified))

	_bind("fixture_physical", KEY_C, KEY_NONE)
	await input.inject_key({"keycode": "C", "pressed": true})
	if not _pressed("fixture_physical"):
		_fail("a key injected by label should press an action bound by physical key")
	await input.inject_key({"keycode": "C", "pressed": false})
	if _pressed("fixture_physical"):
		_fail("releasing the key should release the action")

	# And the shape a caller gets by saying nothing: the key goes down and comes back up, so the
	# action it is bound to is not left held for the rest of the session.
	var whole: Dictionary = await input.inject_key({"keycode": "C"})
	if not bool(whole.get("whole", false)):
		_fail("a key with no `pressed` should be the whole press: %s" % JSON.stringify(whole))
	if _pressed("fixture_physical"):
		_fail("the whole press should leave the action released")

	_bind("fixture_label", KEY_NONE, KEY_D)
	await input.inject_key({"keycode": KEY_D, "pressed": true})
	if not _pressed("fixture_label"):
		_fail("a key injected by keycode should press an action bound by label")
	await input.inject_key({"keycode": KEY_D, "pressed": false})


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

	# A spelling nobody recognises used to come back as the left button, so a right click asked for
	# by the wrong word went left and said it went left.
	var unknown: Dictionary = input.inject_mouse_click({"x": 1, "y": 1, "button": "scroll_up"})
	if unknown.get("type", "") != "error":
		_fail("a button name that is not one should be refused: %s" % JSON.stringify(unknown))


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
	# Where it went, which is the one thing a caller cannot see from their side of the socket.
	if str(typed.get("into", "")) != str(field.get_path()):
		_fail("typing should say what it landed in: %s" % JSON.stringify(typed))

	# What the field holds afterwards, read off the field rather than echoed back from the request.
	# Without it the answer to a field that took the text somewhere unhelpful looks exactly like the
	# answer to one that took it: a spin box reading 2.1 typed "0.3" at reported four characters in
	# and parsed itself straight back to 2.1.
	if str(typed.get("holds", "")) != "Ash & Marek, 12!":
		_fail("typing should say what the field holds: %s" % JSON.stringify(typed))
	if bool(typed.get("replaced", true)):
		_fail("and should not claim to have replaced anything: %s" % JSON.stringify(typed))

	# Filling a field in, which is what a caller means nearly every time and could not be asked
	# for: typing lands at the caret, so whatever the field already said stayed where it was.
	var over: Dictionary = input.inject_text({"text": "8", "replace": true})
	if field.text != "8":
		_fail("replace should write over what the field said: %s" % field.text)
	if not bool(over.get("replaced", false)) or str(over.get("holds", "")) != "8":
		_fail("and should say so: %s" % JSON.stringify(over))

	var appended: Dictionary = input.inject_text({"text": "9"})
	if field.text != "89":
		_fail("and without it typing still lands at the caret: %s" % field.text)
	if str(appended.get("holds", "")) != "89":
		_fail("which the answer says: %s" % JSON.stringify(appended))
	field.clear()

	var empty: Dictionary = input.inject_text({})
	if empty.get("type", "") != "error":
		_fail("typing nothing should be refused: %s" % JSON.stringify(empty))


## The key op types too, which is the half that was missing rather than the whole command.
func _type_with_keys(input: InputCommands) -> void:
	_field.clear()
	await input.inject_key({"keycode": "K"})
	await input.inject_key({"keycode": "K", "shift": true})


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

	# And the state that leaves behind, which this fixture has had to work around since it was
	# written: the field keeps the focus and stops being edited, so the next thing typed reaches
	# nothing at all. It is refused with what to do about it rather than counted as typed.
	var shut: Dictionary = _typing.inject_text({"text": "more"})
	if shut.get("type", "") != "error":
		_fail("typing into a field that is not being edited is refused: %s" % JSON.stringify(shut))
	if not str(shut.get("message", "")).contains("not being edited"):
		_fail("and the refusal says why: %s" % JSON.stringify(shut))
	if _field.text != "kK":
		_fail("and nothing lands in it: %s" % _field.text)

	_field.queue_free()


func _check_actions(input: InputCommands) -> void:
	var missing: Dictionary = await input.inject_action({"action": "fixture_missing"})
	if missing.get("type", "") != "error":
		_fail("an unknown action should be refused: %s" % JSON.stringify(missing))

	await input.inject_action({"action": "fixture_physical", "pressed": true})
	if not _pressed("fixture_physical"):
		_fail("an injected action should read as pressed")
	await input.inject_action({"action": "fixture_physical", "pressed": false})
	if _pressed("fixture_physical"):
		_fail("an injected release should read as released")

	# What a caller gets by saying nothing, and the reason it is the default: an action left down
	# is a press that never ends, and answering a dialog with `ui_accept` took two calls to do at
	# all. Counted rather than sampled: a press that was never sent would leave the action
	# released as surely as a press that was let go of.
	var watcher: Watcher = Watcher.new()
	watcher.action = "fixture_physical"
	root.add_child(watcher)

	var whole: Dictionary = await input.inject_action({"action": "fixture_physical"})

	if not bool(whole.get("whole", false)):
		_fail("an action with no `pressed` should be the whole press: %s" % JSON.stringify(whole))
	if _pressed("fixture_physical"):
		_fail("the whole press should leave the action released")
	if watcher.downs != 1 or watcher.ups != 1:
		_fail(
			(
				"the whole press should be one press and one release: %d down, %d up"
				% [watcher.downs, watcher.ups]
			)
		)
	watcher.queue_free()
