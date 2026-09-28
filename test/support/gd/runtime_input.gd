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
const Checked = preload("checked.gd")
const Read = preload("res://addons/gdharness_runtime/reading.gd")
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


## Counts the button events a control is handed, by button and by half, which is what says where
## the viewport delivered a click rather than where the command said it sent one.
class Counter:
	extends Control

	var presses: Dictionary = {}
	var releases: Dictionary = {}

	func _gui_input(event: InputEvent) -> void:
		if event is not InputEventMouseButton:
			return
		var button: InputEventMouseButton = event
		var tally: Dictionary = presses if button.pressed else releases
		var so_far: int = Read.as_int(tally.get(button.button_index, 0), 0)
		tally[button.button_index] = so_far + 1


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
	await _check_a_wheel_step(input)
	await _check_actions(input)
	_check_typing(input)
	await _type_with_keys(input)
	_check_what_the_keys_typed()
	await _check_a_dialog(input)
	await _check_a_click_by_words(input)
	await _check_a_click_by_words_ranked(input)
	await _check_a_click_opening_a_menu_over_itself(input)

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
	if not Read.as_bool(whole.get("whole", false)):
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
	# Released, because a button left down holds the viewport's mouse focus on whatever took it,
	# and the wheel check after this one is about exactly that.
	var _right_up: Dictionary = input.inject_mouse_click(
		{"x": 10, "y": 20, "button": "right", "pressed": false}
	)
	var _middle_up: Dictionary = input.inject_mouse_click({"x": 1, "y": 2, "button": 3, "pressed": false})

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
	# And a number that is not a button: 0 is MOUSE_BUTTON_NONE, which no event carries, and past
	# the two extra buttons there is nothing to press.
	for number: int in [0, 10, -3]:
		var none: Dictionary = input.inject_mouse_click({"x": 1, "y": 1, "button": number})
		if none.get("type", "") != "error":
			_fail("button %d is not a button and should be refused: %s" % [number, JSON.stringify(none)])


## A wheel step is a press and a release together, the way a mouse sends one.
##
## A lone wheel press over a control leaves the viewport's mouse focus on that control with the
## wheel's bit in its mask, and every click after it is handed to that control rather than to the
## one under the pointer: a project scrolled a slider with wheel_down and then clicked Back twice,
## landed true, and nothing happened, until it sent a release for the wheel by hand. Asserted on
## what the two controls were handed rather than on the echo, since a lone press echoes exactly
## like a whole step. The click on the second control is the positive: with the wheel released,
## the viewport looks under the pointer again.
func _check_a_wheel_step(input: InputCommands) -> void:
	var taker: Counter = Counter.new()
	taker.position = Vector2(0, 0)
	taker.size = Vector2(100, 100)
	root.add_child(taker)
	var other: Counter = Counter.new()
	other.position = Vector2(200, 0)
	other.size = Vector2(100, 100)
	root.add_child(other)
	await process_frame

	var notch: Dictionary = input.inject_mouse_click({"x": 50, "y": 50, "button": "wheel_down"})
	await process_frame
	if notch.get("released") != true:
		_fail("a wheel click says it was released as well as pressed: %s" % JSON.stringify(notch))
	if (
		taker.presses.get(MOUSE_BUTTON_WHEEL_DOWN, 0) != 1
		or taker.releases.get(MOUSE_BUTTON_WHEEL_DOWN, 0) != 1
	):
		_fail(
			(
				"the control under a wheel click is handed both halves of the step: presses %s, releases %s"
				% [JSON.stringify(taker.presses), JSON.stringify(taker.releases)]
			)
		)

	var _down: Dictionary = input.inject_mouse_click({"x": 250, "y": 50})
	var _up: Dictionary = input.inject_mouse_click({"x": 250, "y": 50, "pressed": false})
	await process_frame
	if other.presses.get(MOUSE_BUTTON_LEFT, 0) != 1 or taker.presses.get(MOUSE_BUTTON_LEFT, 0) != 0:
		_fail(
			(
				(
					"a click after a wheel step lands under the pointer rather than on the control"
					+ " that took the wheel: other %s, taker %s"
				)
				% [JSON.stringify(other.presses), JSON.stringify(taker.presses)]
			)
		)

	taker.queue_free()
	other.queue_free()


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
	if Read.as_bool(typed.get("replaced", true), true):
		_fail("and should not claim to have replaced anything: %s" % JSON.stringify(typed))

	# Filling a field in, which is what a caller means nearly every time and could not be asked
	# for: typing lands at the caret, so whatever the field already said stayed where it was.
	var over: Dictionary = input.inject_text({"text": "8", "replace": true})
	if field.text != "8":
		_fail("replace should write over what the field said: %s" % field.text)
	if not Read.as_bool(over.get("replaced", false)) or str(over.get("holds", "")) != "8":
		_fail("and should say so: %s" % JSON.stringify(over))

	var appended: Dictionary = input.inject_text({"text": "9"})
	if field.text != "89":
		_fail("and without it typing still lands at the caret: %s" % field.text)
	if str(appended.get("holds", "")) != "89":
		_fail("which the answer says: %s" % JSON.stringify(appended))

	# Emptying a field, which is filling one in with nothing and the one shape of it that types no
	# characters. Refused as a missing argument, the only way left was a select-all nobody can send
	# honestly and a key event of the caller's own.
	var cleared: Dictionary = input.inject_text({"text": "", "replace": true})
	if field.text != "":
		_fail("replace with nothing should empty the field: %s" % field.text)
	if not Read.as_bool(cleared.get("replaced", false)) or str(cleared.get("holds", "x")) != "":
		_fail("and should say so: %s" % JSON.stringify(cleared))

	var empty: Dictionary = input.inject_text({})
	if empty.get("type", "") != "error":
		_fail("typing nothing over nothing should still be refused: %s" % JSON.stringify(empty))

	# A password field answers with its mask, which still counts the characters, and never with
	# the password: here one the field held before anything was typed, which the caller never sent.
	field.secret = true
	field.text = "hunter"
	field.caret_column = field.text.length()
	var hidden: Dictionary = input.inject_text({"text": "2"})
	if field.text != "hunter2":
		_fail("a secret field should take what is typed like any other: %s" % field.text)
	if str(hidden.get("holds", "")) != field.secret_character.repeat(7):
		_fail("and say what it holds as its mask: %s" % JSON.stringify(hidden))
	if JSON.stringify(hidden).contains("hunter"):
		_fail("and never the words behind it: %s" % JSON.stringify(hidden))
	field.secret = false


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
	Checked.done(
		_field.text_submitted.connect(func(said: String) -> void: submitted.append(said)) as Error,
		"listening for the field being submitted"
	)
	var newline: Dictionary = _typing.inject_text({"text": "\n"})
	if newline.get("type") == "error":
		_fail("typing a newline was refused: %s" % JSON.stringify(newline))
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

	if not Read.as_bool(whole.get("whole", false)):
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


## How a dialog is answered, which is not by the action that looks like it.
##
## Godot's own [AcceptDialog] reads the Escape key itself and never asks the [InputMap], so
## `ui_cancel` goes in, is a perfectly good action, and leaves the question standing. Found
## driving a game: the answer said the action had landed and the dialog was still on screen.
## Written down here because the tool cannot say it: an action nobody listened for looks exactly
## like one somebody did.
func _check_a_dialog(input: InputCommands) -> void:
	var asking: AcceptDialog = AcceptDialog.new()
	root.add_child(asking)
	asking.popup_centered()
	await root.get_tree().process_frame

	await input.inject_action({"action": "ui_cancel"})
	await root.get_tree().process_frame
	if not asking.visible:
		_fail("ui_cancel closing a dialog would be news: Godot's own reads the key instead")

	await input.inject_key({"keycode": "Escape"})
	await root.get_tree().process_frame
	if asking.visible:
		_fail("the Escape key should close a dialog, which is how a player answers one")
	asking.queue_free()


## A button placed inside the 64 by 64 viewport a headless game has, its words clipped so the text
## does not widen it past the edge, counting its presses under the meta `presses`.
func _small_button(parent: Node, words: String, at: Vector2) -> Button:
	var button: Button = Button.new()
	button.text = words
	button.clip_text = true
	button.position = at
	button.size = Vector2(26, 12)
	button.set_meta("presses", 0)
	Checked.done(
		button.pressed.connect(
			func() -> void: button.set_meta("presses", Read.as_int(button.get_meta("presses"), 0) + 1)
		),
		"counting presses on %s" % words
	)
	parent.add_child(button)
	return button


func _presses(button: Button) -> int:
	return Read.as_int(button.get_meta("presses"), 0)


## A click that names its control by the words on it, found and pressed in the same frame: one
## match, several refused with an index for each and picked by index, narrowed by path, words on a
## label pressing the button holding it, a glob, and words only a hidden control says.
func _check_a_click_by_words(input: InputCommands) -> void:
	var screen: Control = Control.new()
	screen.size = Vector2(64, 64)
	root.add_child(screen)
	var new_guild: Button = _small_button(screen, "New guild", Vector2(2, 2))
	var left: Control = Control.new()
	left.name = "Left"
	screen.add_child(left)
	var right: Control = Control.new()
	right.name = "Right"
	screen.add_child(right)
	var send_left: Button = _small_button(left, "Send back", Vector2(2, 18))
	var send_right: Button = _small_button(right, "Send back", Vector2(34, 18))
	var recruit: Button = _small_button(screen, "", Vector2(2, 34))
	var words: Label = Label.new()
	words.text = "Recruit"
	words.clip_text = true
	words.size = Vector2(26, 12)
	recruit.add_child(words)
	var secret: Button = _small_button(screen, "Secret", Vector2(34, 34))
	secret.visible = false
	await root.get_tree().process_frame

	var once: Dictionary = await input.click({"says": "New guild"})
	var found: Dictionary = once.get("found", {})
	if once.get("type") != "clicked" or _presses(new_guild) != 1 or once.get("landed") != true:
		_fail("a click by words presses the one control saying them: %s" % JSON.stringify(once))
	elif found.get("of") != 1 or found.get("index") != 0 or once.get("path") != str(new_guild.get_path()):
		_fail("and says which match it pressed: %s" % JSON.stringify(once))

	var unclear: Dictionary = await input.click({"says": "Send back"})
	var listed: String = str(unclear.get("message", ""))
	if (
		unclear.get("type") != "error"
		or not listed.contains('2 buttons on screen say exactly "Send back"')
		or not listed.contains('0 %s ("Send back")' % send_left.get_path())
		or not listed.contains('1 %s ("Send back")' % send_right.get_path())
	):
		_fail(
			"two controls saying the words are refused with an index for each: %s" % JSON.stringify(unclear)
		)
	if _presses(send_left) + _presses(send_right) != 0:
		_fail("and neither is pressed")

	var second: Dictionary = await input.click({"says": "Send back", "index": 1})
	if _presses(send_right) != 1 or _presses(send_left) != 0:
		_fail("index 1 presses the second one listed: %s" % JSON.stringify(second))
	var narrowed: Dictionary = await input.click({"says": "Send back", "path": str(left.get_path())})
	if _presses(send_left) != 1 or narrowed.get("type") != "clicked":
		_fail("a path narrows where the words are looked for: %s" % JSON.stringify(narrowed))
	var beyond: Dictionary = await input.click({"says": "Send back", "index": 2})
	if (
		beyond.get("type") != "error"
		or not str(beyond.get("message", "")).contains("index 2 is not one of the 2")
	):
		_fail("an index past the matches is refused: %s" % JSON.stringify(beyond))

	var through: Dictionary = await input.click({"says": "Recruit"})
	if (
		_presses(recruit) != 1
		or through.get("path") != str(recruit.get_path())
		or through.get("landed") != true
	):
		_fail("words on a label press the button holding it: %s" % JSON.stringify(through))

	var globbed: Dictionary = await input.click({"says": "New g*"})
	if _presses(new_guild) != 2:
		_fail("a glob in says is matched as a find matches one: %s" % JSON.stringify(globbed))

	var hidden: Dictionary = await input.click({"says": "Secret"})
	var hidden_said: String = str(hidden.get("message", ""))
	if hidden.get("type") != "error" or not hidden_said.contains("1 hidden control says it"):
		_fail(
			(
				"words only a hidden control says are refused and the hidden one counted: %s"
				% JSON.stringify(hidden)
			)
		)
	if _presses(secret) != 0:
		_fail("and the hidden control is not pressed")
	screen.queue_free()
	await root.get_tree().process_frame


## Several controls saying a word, ranked the way a person picks the one to press: a button over
## text, the whole of what a control says over a part of it, and nothing covered by a screen drawn
## over it.
## A click on a dropdown near the bottom of the screen, whose menu has no room below it and opens
## over it, under the pointer. A player's click opens the menu and leaves it open with nothing
## chosen; the release of a click held for one frame landed on the item the menu opened under the
## pointer and chose it.
func _check_a_click_opening_a_menu_over_itself(input: InputCommands) -> void:
	var dropdown: OptionButton = OptionButton.new()
	dropdown.position = Vector2(2, 30)
	dropdown.size = Vector2(60, 20)
	dropdown.add_item("Windowed", 1)
	dropdown.add_item("Fullscreen", 2)
	var picked: Array[int] = []
	var note: Callable = func(index: int) -> void: picked.append(index)
	Checked.done(dropdown.item_selected.connect(note) as Error, "noting a pick")
	root.add_child(dropdown)
	await root.get_tree().process_frame

	var opened: Dictionary = await input.click({"path": str(dropdown.get_path())})
	var menu: PopupMenu = dropdown.get_popup()
	var centre: Vector2 = dropdown.get_global_rect().get_center()
	var over: bool = Rect2(Vector2(menu.position), Vector2(menu.size)).has_point(centre)
	if not over:
		_fail(
			(
				"the menu should open over the button for this case to mean anything: menu %s, button centre %s"
				% [Rect2(Vector2(menu.position), Vector2(menu.size)), centre]
			)
		)
	if not picked.is_empty() or dropdown.selected != 0:
		_fail(
			(
				"a click opening a menu over itself chooses nothing: %s, picked %s"
				% [JSON.stringify(opened), picked]
			)
		)
	if not menu.visible:
		_fail("and leaves the menu open, as a player's click does: %s" % JSON.stringify(opened))
	menu.hide()
	dropdown.queue_free()
	await root.get_tree().process_frame

	# The same dropdown inside a SubViewport shown through a container, which is a viewport of its
	# own and not the game's window.
	var frame: SubViewportContainer = SubViewportContainer.new()
	frame.stretch = true
	frame.size = Vector2(64, 64)
	root.add_child(frame)
	var inner: SubViewport = SubViewport.new()
	frame.add_child(inner)
	var nested: OptionButton = OptionButton.new()
	nested.position = Vector2(2, 30)
	nested.size = Vector2(60, 20)
	nested.add_item("Windowed", 1)
	nested.add_item("Fullscreen", 2)
	var nested_picked: Array[int] = []
	var nested_note: Callable = func(index: int) -> void: nested_picked.append(index)
	Checked.done(nested.item_selected.connect(nested_note) as Error, "noting a nested pick")
	inner.add_child(nested)
	await root.get_tree().process_frame
	await root.get_tree().process_frame
	var inside: Dictionary = await input.click({"path": str(nested.get_path())})
	var nested_menu: PopupMenu = nested.get_popup()
	if not nested_picked.is_empty() or not nested_menu.visible:
		_fail(
			(
				"a dropdown in a SubViewport opens its menu and chooses nothing: %s, picked %s, open %s"
				% [JSON.stringify(inside), nested_picked, nested_menu.visible]
			)
		)
	nested_menu.hide()
	frame.queue_free()
	await root.get_tree().process_frame

	# Shrunk: the SubViewport is half the container's size and drawn at twice its own, so a point in
	# it lands at twice its coordinates on the screen. Placed where the point read at its own
	# coordinates misses it.
	var halved: SubViewportContainer = SubViewportContainer.new()
	halved.stretch = true
	halved.stretch_shrink = 2
	halved.size = Vector2(64, 64)
	root.add_child(halved)
	var small: SubViewport = SubViewport.new()
	halved.add_child(small)
	var corner: Button = _small_button(small, "", Vector2(20, 20))
	corner.size = Vector2(8, 8)
	await root.get_tree().process_frame
	await root.get_tree().process_frame
	var pressed: Dictionary = await input.click({"path": str(corner.get_path())})
	if _presses(corner) != 1 or pressed.get("landed") != true:
		_fail("a button in a shrunk SubViewport is pressed where it is drawn: %s" % JSON.stringify(pressed))
	halved.queue_free()
	await root.get_tree().process_frame


func _check_a_click_by_words_ranked(input: InputCommands) -> void:
	# Placed by centre, and a button in the default theme grows to about 31 pixels tall whatever size
	# it is given: the page covers the top 48 rows, so the hall's two buttons have their centres
	# under it and the button saying more has its centre below it.
	var hall: Control = Control.new()
	hall.size = Vector2(64, 64)
	root.add_child(hall)
	var _sentence: Label = _small_label(hall, "Word back", Vector2(2, 2))
	var hall_back: Button = _small_button(hall, "Back", Vector2(34, 2))
	var hall_only: Button = _small_button(hall, "Drawer", Vector2(2, 18))
	var page: Panel = Panel.new()
	page.name = "Page"
	page.size = Vector2(64, 48)
	root.add_child(page)
	var page_back: Button = _small_button(page, "Back", Vector2(34, 16))
	var _told: Label = _small_label(page, "is back off a hunt", Vector2(2, 16))
	var partly: Button = _small_button(root, "Back to hall", Vector2(2, 34))
	# Drawn over the page's button and the one below it, and neither covers anything: a label lets
	# the pointer through, and the panel reaches past the strip it is clipped to.
	var caption: Label = _small_label(root, "Title", Vector2(34, 26))
	var strip: Control = Control.new()
	strip.clip_contents = true
	strip.position = Vector2(0, 54)
	strip.size = Vector2(64, 10)
	root.add_child(strip)
	var beyond_strip: Panel = Panel.new()
	beyond_strip.position = Vector2(0, -30)
	beyond_strip.size = Vector2(64, 40)
	strip.add_child(beyond_strip)
	await root.get_tree().process_frame

	var back: Dictionary = await input.click({"says": "Back"})
	var found: Dictionary = back.get("found", {})
	if back.get("type") != "clicked" or _presses(page_back) != 1 or _presses(hall_back) != 0:
		_fail(
			(
				(
					"the button saying exactly the word is pressed over a button saying more, labels saying it"
					+ " in a sentence and a button covered by the page: %s"
				)
				% JSON.stringify(back)
			)
		)
	elif (
		not str(found.get("picked", "")).contains('the one button on screen saying exactly "Back"')
		or found.get("covered") != 2
		or found.get("of") != 3
	):
		_fail("and says why it was picked and how many were covered: %s" % JSON.stringify(back))
	if _presses(partly) != 0:
		_fail("a button saying the word as part of more is passed over for one saying only it")

	var under: Dictionary = await input.click({"says": "Drawer"})
	var refused: String = str(under.get("message", ""))
	if (
		under.get("type") != "error"
		or not refused.contains("1 control says it under %s, which is drawn over it" % page.get_path())
		or _presses(hall_only) != 0
	):
		_fail("a control the page covers is not on screen and is not pressed: %s" % JSON.stringify(under))

	page.visible = false
	await root.get_tree().process_frame
	var uncovered: Dictionary = await input.click({"says": "Back"})
	if _presses(hall_back) != 1 or uncovered.get("path") != str(hall_back.get_path()):
		_fail("with the page gone the hall's button is on screen again: %s" % JSON.stringify(uncovered))
	for each: Node in [hall, page, partly, caption, strip]:
		each.queue_free()
	await root.get_tree().process_frame

	# Cards: a title over a description. The card whose title is exactly the words is the exact match,
	# over the one whose title only starts with them.
	var ward: Button = _small_button(root, "WARD\nwards 3", Vector2(2, 2))
	var spite: Button = _small_button(root, "WARDSPITE\ntwo words", Vector2(34, 2))
	await root.get_tree().process_frame
	var titled: Dictionary = await input.click({"says": "WARD"})
	if _presses(ward) != 1 or _presses(spite) != 0:
		_fail(
			(
				"a card whose title line is exactly the words is pressed over one saying more: %s"
				% JSON.stringify(titled)
			)
		)
	ward.queue_free()
	spite.queue_free()
	await root.get_tree().process_frame

	# A cover away from the origin and scaled, so it covers the button only where it is drawn: its own
	# rectangle at the origin misses the button's centre, and so does the same rectangle placed but
	# not scaled.
	var aside: Button = _small_button(root, "Aside", Vector2(34, 2))
	var side: Panel = Panel.new()
	side.position = Vector2(32, 0)
	side.size = Vector2(8, 12)
	side.scale = Vector2(4, 2)
	root.add_child(side)
	await root.get_tree().process_frame
	var beside: Dictionary = await input.click({"says": "Aside"})
	if (
		_presses(aside) != 0
		or not str(beside.get("message", "")).contains("under %s, which is drawn over it" % side.get_path())
	):
		_fail(
			(
				"a control under a cover placed and scaled away from the origin is covered: %s"
				% JSON.stringify(beside)
			)
		)
	aside.queue_free()
	side.queue_free()
	await root.get_tree().process_frame

	# A button scrolled out of its container sits, for now, under whatever is drawn below the
	# container, and the click scrolls it into view before pressing, so it is not covered.
	var scroll: ScrollContainer = ScrollContainer.new()
	scroll.size = Vector2(64, 32)
	root.add_child(scroll)
	var column: VBoxContainer = VBoxContainer.new()
	scroll.add_child(column)
	var spacer: Control = Control.new()
	spacer.custom_minimum_size = Vector2(40, 100)
	column.add_child(spacer)
	var far: Button = _small_button(column, "Far", Vector2.ZERO)
	var footer: Panel = Panel.new()
	footer.position = Vector2(0, 32)
	footer.size = Vector2(64, 200)
	root.add_child(footer)
	await root.get_tree().process_frame
	var scrolled: Dictionary = await input.click({"says": "Far"})
	if _presses(far) != 1 or scrolled.get("scrolled_into_view") != true:
		_fail("a button scrolled out of view is scrolled back and pressed: %s" % JSON.stringify(scrolled))

	# The same container under a page drawn over all of it: the button in view is covered, and so is
	# the one below the fold, since wherever the click scrolls it to is under the page too. Judged
	# where it sat, below the container and so clipped away, it was not covered at all, and the click
	# scrolled it up under the page and pressed there.
	var near: Button = _small_button(column, "Far", Vector2.ZERO)
	column.move_child(near, 0)
	var over_all: Panel = Panel.new()
	over_all.size = Vector2(64, 64)
	root.add_child(over_all)
	scroll.scroll_vertical = 0
	await root.get_tree().process_frame
	var paged: Dictionary = await input.click({"says": "Far"})
	if (
		paged.get("type") != "error"
		or not str(paged.get("message", "")).contains("2 controls say it under what is drawn over them")
		or _presses(far) != 1
		or _presses(near) != 0
	):
		_fail(
			(
				"a button below the fold of a container a page covers is covered, as the one in view is: %s"
				% JSON.stringify(paged)
			)
		)
	over_all.queue_free()
	scroll.queue_free()
	footer.queue_free()
	await root.get_tree().process_frame

	# A higher canvas layer is drawn over the game, and takes the pointer first, wherever it is in
	# the tree.
	var overlay: CanvasLayer = CanvasLayer.new()
	overlay.layer = 5
	root.add_child(overlay)
	var veil: Panel = Panel.new()
	veil.size = Vector2(64, 64)
	overlay.add_child(veil)
	var below: Button = _small_button(root, "Below", Vector2(2, 2))
	await root.get_tree().process_frame
	var veiled: Dictionary = await input.click({"says": "Below"})
	if (
		_presses(below) != 0
		or not str(veiled.get("message", "")).contains("under %s, which is drawn over it" % veil.get_path())
	):
		_fail("a control under a higher canvas layer is covered by it: %s" % JSON.stringify(veiled))
	overlay.queue_free()
	below.queue_free()
	await root.get_tree().process_frame

	# A window embedded in the game is drawn over all of it and takes the pointer first.
	var behind: Button = _small_button(root, "Behind", Vector2(2, 2))
	var dialog: Window = Window.new()
	dialog.position = Vector2i(0, 0)
	dialog.size = Vector2i(64, 64)
	root.add_child(dialog)
	await root.get_tree().process_frame
	var windowed: Dictionary = await input.click({"says": "Behind"})
	if (
		not dialog.is_embedded()
		or _presses(behind) != 0
		or not str(windowed.get("message", "")).contains(
			"under %s, which is drawn over it" % dialog.get_path()
		)
	):
		_fail("a control under an embedded window is covered by it: %s" % JSON.stringify(windowed))
	dialog.queue_free()
	behind.queue_free()
	await root.get_tree().process_frame

	var exactly: Label = _small_label(root, "Onward", Vector2(2, 2))
	var onward: Button = _small_button(root, "Onward now", Vector2(34, 2))
	await root.get_tree().process_frame
	var over_text: Dictionary = await input.click({"says": "Onward"})
	var over_found: Dictionary = over_text.get("found", {})
	var why: String = str(over_found.get("picked", ""))
	if _presses(onward) != 1 or over_text.get("path") != str(onward.get_path()):
		_fail(
			(
				"a button saying the word as part of more is pressed over a label saying exactly it: %s"
				% JSON.stringify(over_text)
			)
		)
	elif (
		why
		!= 'the one button on screen saying "Onward" as part of more; the other one on screen cannot be pressed'
	):
		_fail("and says why, of the one it passed over: %s" % why)
	exactly.queue_free()
	onward.queue_free()
	await root.get_tree().process_frame


## A label inside the 64 by 64 viewport a headless game has, clipped to the size of a small button.
func _small_label(parent: Node, words: String, at: Vector2) -> Label:
	var label: Label = Label.new()
	label.text = words
	label.clip_text = true
	label.position = at
	label.size = Vector2(26, 12)
	parent.add_child(label)
	return label
