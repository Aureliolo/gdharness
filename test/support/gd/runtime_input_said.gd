extends SceneTree
## What the runtime's input answers say beyond what went in: the actions an event stands for, the
## control under a mouse_click, why a click on a control that lets the pointer through did not
## land, and the actions a refusal for an unknown one offers. Each answer is held against what the
## engine did with the event: the action counted by a listener, the button pressed.

const GdhInputCommands = preload("res://addons/gdharness_runtime/runtime_input.gd")
const GdhRead = preload("res://addons/gdharness_runtime/reading.gd")
const GdhValues = preload("res://addons/gdharness_runtime/runtime_values.gd")
const Checked = preload("checked.gd")

var failures: Array[String] = []
var _begun: bool = false


func _process(_delta: float) -> bool:
	if _begun:
		return false
	_begun = true
	_everything.call_deferred()
	return false


func _everything() -> void:
	var host: Node = Node.new()
	root.add_child(host)
	var input: GdhInputCommands = GdhInputCommands.new(host, GdhValues.new())
	# Bound out of order, so a refusal listing them in the order the map holds them is told apart.
	var left: InputEventMouseButton = InputEventMouseButton.new()
	left.button_index = MOUSE_BUTTON_LEFT
	_bind("shoot", left)
	var space: InputEventKey = InputEventKey.new()
	space.keycode = KEY_SPACE
	_bind("leap", space)

	await _check_refusals(input)
	await _check_keys(input)
	await _check_shortcuts(input)
	await _check_clicks(input)

	InputMap.erase_action("leap")
	InputMap.erase_action("shoot")
	var bare: Dictionary = await input.inject_action({ "action": "dance" })
	var none: String = (
		"Action not found: dance. The project defines no actions of its own, and the engine's are "
		+ "the ui_ ones."
	)
	if str(bare.get("message", "")) != none:
		_fail("a project with no actions of its own says so: %s" % JSON.stringify(bare))

	host.queue_free()
	if failures.is_empty():
		print(JSON.stringify({ "ok": true }))
		quit(0)
		return
	printerr("\n".join(failures))
	quit(1)


func _fail(message: String) -> void:
	failures.append(message)


func _bind(action: String, event: InputEvent) -> void:
	InputMap.add_action(action)
	InputMap.action_add_event(action, event)


func _watching(action: String) -> Watcher:
	var watcher: Watcher = Watcher.new()
	watcher.action = action
	root.add_child(watcher)
	return watcher


## An action the input map lacks is refused with the project's nearest, or with all of the
## project's own, and with the engine's ui_ ones only for a name that starts like one.
func _check_refusals(input: GdhInputCommands) -> void:
	var cases: Array[Array] = [
		["leapp", "Action not found: leapp. The nearest is leap."],
		[
			"dance",
			"Action not found: dance. The project's own actions are leap, shoot, beside the "
			+ "engine's ui_ ones.",
		],
	]
	for case: Array in cases:
		var answer: Dictionary = await input.inject_action({ "action": case[0] })
		if answer.get("type", "") != "error" or str(answer.get("message", "")) != str(case[1]):
			_fail("%s should be refused as %s: %s" % [case[0], case[1], JSON.stringify(answer)])
	var engine: Dictionary = await input.inject_action({ "action": "ui_cancle" })
	var said: String = str(engine.get("message", ""))
	if (
		not said.begins_with("Action not found: ui_cancle. The nearest ")
		or not said.contains("ui_cancel")
	):
		_fail("a ui_ name should be offered the engine's nearest: %s" % JSON.stringify(engine))
	var known: Dictionary = await input.inject_action({ "action": "leap" })
	if known.get("type", "") != "input_injected":
		_fail("an action the map has goes in: %s" % JSON.stringify(known))


## A key names the actions it is bound to, as the game counted one of them, and an unbound key none.
func _check_keys(input: GdhInputCommands) -> void:
	var watcher: Watcher = _watching("leap")
	var space: Dictionary = await input.inject_key({ "keycode": "Space" })
	var actions: Array = space.get("actions", [])
	if not actions.has("leap") or watcher.downs != 1:
		_fail(
			"Space is bound to leap, which counted %d: %s" % [watcher.downs, JSON.stringify(space)]
		)
	var unbound: Dictionary = await input.inject_key({ "keycode": "Q" })
	if unbound.get("actions") != []:
		_fail("Q is bound to nothing: %s" % JSON.stringify(unbound))
	watcher.queue_free()


## An action presses a button whose Shortcut holds it, as the key bound to it does, and names it
## under shortcut_pressed. A Viewport never hands an InputEventAction to a shortcut, so the press
## read input_injected and the button stayed as it was. Like the key, it presses one button: the
## last in the tree that takes it, then the next when that one is disabled, across buttons holding
## the same Shortcut and buttons holding their own. A button whose Shortcut is the key itself is not
## pressed by the action.
func _check_shortcuts(input: GdhInputCommands) -> void:
	var spare: Button = _counted("Spare")
	spare.shortcut = Shortcut.new()
	spare.shortcut.events = [_leap()]
	var by_action: Button = _counted("By action")
	by_action.shortcut = Shortcut.new()
	by_action.shortcut.events = [_leap()]
	var twin: Button = _counted("Twin")
	twin.shortcut = by_action.shortcut
	var by_key: Button = _counted("By key")
	var key: InputEventKey = InputEventKey.new()
	key.keycode = KEY_SPACE
	by_key.shortcut = Shortcut.new()
	by_key.shortcut.events = [key]
	await process_frame
	var holding: Array[String] = [
		str(spare.get_path()), str(by_action.get_path()), str(twin.get_path()),
	]

	var takers: Array[Button] = [twin, by_action, spare, null]
	for turn: int in takers.size():
		var pressed: Dictionary = await input.inject_action({ "action": "leap" })
		var taking: Button = takers[turn]
		var expected: Variant = null
		if taking != null:
			expected = str(taking.get_path())
		if pressed.get("shortcuts") != holding or pressed.get("shortcut_pressed") != expected:
			_fail(
				"leap names %s as the button it pressed: %s" % [expected, JSON.stringify(pressed)]
			)
		var counts: Array[int] = []
		for button: Button in [spare, by_action, twin, by_key]:
			counts.append(GdhRead.as_int(button.get_meta("presses"), 0))
		if counts != ([[0, 0, 1, 0], [0, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0]] as Array)[turn]:
			_fail("leap presses one button at most, %s: %s" % [expected, JSON.stringify(counts)])
		if taking != null:
			taking.disabled = true
	var _keyed: Dictionary = await input.inject_key({ "keycode": "Space" })
	if by_key.get_meta("presses") != 1:
		_fail("Space presses its own button: %d" % GdhRead.as_int(by_key.get_meta("presses"), 0))
	var other: Dictionary = await input.inject_action({ "action": "shoot" })
	if other.get("shortcuts") != [] or other.get("shortcut_pressed") != null:
		_fail("shoot is no button's shortcut: %s" % JSON.stringify(other))
	for button: Button in [spare, by_action, twin, by_key]:
		button.queue_free()


func _leap() -> InputEventAction:
	var bound: InputEventAction = InputEventAction.new()
	bound.action = "leap"
	bound.pressed = true
	return bound


func _counted(words: String) -> Button:
	var button: Button = Button.new()
	button.text = words
	button.size = Vector2(20, 10)
	button.set_meta("presses", 0)
	var count: Callable = func() -> void:
		button.set_meta("presses", GdhRead.as_int(button.get_meta("presses"), 0) + 1)
	Checked.done(button.pressed.connect(count), "counting presses on %s" % words)
	root.add_child(button)
	return button


## A mouse_click names the control under it and the actions its button is bound to, and a click on a
## Label, which lets the pointer through to what is under it, says so beside landed false.
func _check_clicks(input: GdhInputCommands) -> void:
	var button: Button = Button.new()
	button.position = Vector2(4, 4)
	button.size = Vector2(56, 20)
	var presses: Array[int] = [0]
	Checked.done(button.pressed.connect(func() -> void: presses[0] += 1), "counting presses")
	root.add_child(button)
	var panel: Panel = Panel.new()
	# Inside the 64 by 64 viewport a game with no window has.
	panel.position = Vector2(0, 30)
	panel.size = Vector2(60, 30)
	root.add_child(panel)
	var label: Label = Label.new()
	label.text = "Clicks: 0"
	label.size = Vector2(50, 20)
	panel.add_child(label)
	await process_frame

	var watcher: Watcher = _watching("shoot")
	var at: Dictionary = await input.inject_mouse_click({ "x": 32, "y": 14 })
	if (
		at.get("hovered") != str(button.get_path())
		or at.get("actions") != ["shoot"]
		or presses[0] != 1
	):
		_fail("a mouse_click on the button: presses %d, %s" % [presses[0], JSON.stringify(at)])
	if watcher.downs != 1:
		_fail("and the button it pressed is bound to shoot, which counted %d" % watcher.downs)
	var nowhere: Dictionary = await input.inject_mouse_click({ "x": 62, "y": 2, "button": "right" })
	if nowhere.get("hovered") != null or nowhere.get("actions") != []:
		_fail("a right click on nothing: %s" % JSON.stringify(nowhere))
	# A held press is read a frame on too, since Input hands it on then: read at once, it answered
	# what was under the pointer before, here nothing.
	var held: Dictionary = await input.inject_mouse_click({ "x": 32, "y": 14, "pressed": true })
	if held.get("hovered") != str(button.get_path()):
		_fail("a held press on the button: %s" % JSON.stringify(held))
	var _let_go: Dictionary = await input.inject_mouse_click({ "x": 32, "y": 14, "pressed": false })
	await process_frame
	if presses[0] != 2:
		_fail("and its release presses the button: presses %d" % presses[0])

	var on_label: Dictionary = await input.click({ "path": str(label.get_path()) })
	var why: String = (
		"%s's mouse_filter is ignore, so the pointer passes through it to what is under it"
	)
	if (
		on_label.get("landed") != false
		or on_label.get("hovered") != str(panel.get_path())
		or on_label.get("why_not_landed") != why % label.get_path()
	):
		_fail(
			(
				"a click on a label goes to what is under it, and says why: %s"
				% JSON.stringify(on_label)
			)
		)
	var on_button: Dictionary = await input.click({ "path": str(button.get_path()) })
	if (
		on_button.get("landed") != true
		or on_button.has("why_not_landed")
		or on_button.get("actions") != ["shoot"]
		or presses[0] != 3
	):
		_fail(
			"a click on the button lands: presses %d, %s" % [presses[0], JSON.stringify(on_button)]
		)
	watcher.queue_free()
	button.queue_free()
	panel.queue_free()


## Counts the presses of one action, which is what a game counting it sees. In _input, which sees an
## event before the interface takes it, as Input.is_action_just_pressed does.
class Watcher:
	extends Node

	var action: String = ""
	var downs: int = 0

	func _input(event: InputEvent) -> void:
		if event.is_action_pressed(action):
			downs += 1
