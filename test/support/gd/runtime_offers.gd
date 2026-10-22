extends SceneTree

## What the runtime offers beside an input or a refusal, so a caller can act on it without a second
## look: the Control a key, an action or a pad's event reached first, and the methods a node has when
## the one asked for is not among them. Each absence is checked beside the case that fills it.

const GdhInputCommands = preload("res://addons/gdharness_runtime/runtime_input.gd")
const GdhPad = preload("res://addons/gdharness_runtime/runtime_pad.gd")
const GdhPaths = preload("res://addons/gdharness_runtime/runtime_paths.gd")
const GdhValues = preload("res://addons/gdharness_runtime/runtime_values.gd")
const Checked = preload("checked.gd")

var failures: Array[String] = []


func _init() -> void:
	Checked.done(process_frame.connect(_run, CONNECT_ONE_SHOT) as Error, "waiting for the next frame")


func _fail(message: String) -> void:
	failures.append(message)


func _run() -> void:
	var host: Node = Node.new()
	root.add_child(host)
	await process_frame
	var input: GdhInputCommands = GdhInputCommands.new(host, GdhValues.new())

	await _check_focus(input)
	await _check_pad_focus(host)
	_check_methods_offered(input)

	host.queue_free()
	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return
	printerr("\n".join(failures))
	quit(1)


## A key or an action goes to the Control holding the focus before the game's own handler, so Space
## on a focused button presses it. The answer names that Control, and nothing when none has it.
func _check_focus(input: GdhInputCommands) -> void:
	var button: Button = Button.new()
	root.add_child(button)
	var presses: Array[int] = [0]
	Checked.done(button.pressed.connect(func() -> void: presses[0] += 1), "counting the presses")
	button.grab_focus()
	Input.flush_buffered_events()

	var spaced: Dictionary = await input.inject_key({"keycode": "Space"})
	if presses[0] != 1:
		_fail("Space on a focused button should press it, which is what the answer explains: %d" % presses[0])
	if str(spaced.get("focused", "")) != str(button.get_path()):
		_fail("a key should name the Control that had the focus: %s" % JSON.stringify(spaced))
	var accepted: Dictionary = await input.inject_action({"action": "ui_accept"})
	if str(accepted.get("focused", "")) != str(button.get_path()):
		_fail("and so should an action: %s" % JSON.stringify(accepted))

	button.release_focus()
	var unfocused: Dictionary = await input.inject_key({"keycode": "Space"})
	if unfocused.get("type", "") != "input_injected" or unfocused.has("focused"):
		_fail("with nothing focused a key names nothing: %s" % JSON.stringify(unfocused))
	var free_action: Dictionary = await input.inject_action({"action": "ui_accept"})
	if free_action.get("type", "") != "input_injected" or free_action.has("focused"):
		_fail("and nor does an action: %s" % JSON.stringify(free_action))
	button.queue_free()


## A stick or a dpad goes to the focused Control first as well, and a direction there moves the
## control's selection or the focus, so the game's _unhandled_input never hears it. The answer names
## that Control and the actions the event pressed, which is what explains the silence.
func _check_pad_focus(host: Node) -> void:
	var pad: GdhPad = GdhPad.new(host)
	var list: ItemList = ItemList.new()
	for named: String in ["Sword", "Shield", "Bow"]:
		var _at: int = list.add_item(named)
	root.add_child(list)
	list.select(0)
	list.grab_focus()
	Input.flush_buffered_events()

	var pushed: Dictionary = pad.inject_joypad_motion({"axis": "left_y", "value": 0.75})
	Input.flush_buffered_events()
	if list.get_selected_items() != PackedInt32Array([1]):
		_fail("a stick pushed down moves a focused list's selection: %s" % str(list.get_selected_items()))
	if str(pushed.get("focused", "")) != str(list.get_path()):
		_fail("a motion should name the Control that had the focus: %s" % JSON.stringify(pushed))
	if JSON.stringify(pushed.get("actions")) != '["ui_down"]':
		_fail("and the one action its direction pressed, not ui_up: %s" % JSON.stringify(pushed))

	var eased: Dictionary = pad.inject_joypad_motion({"axis": "left_y", "value": 0.2})
	Input.flush_buffered_events()
	if JSON.stringify(eased.get("actions")) != "[]" or str(eased.get("focused", "")) != str(list.get_path()):
		_fail("a motion inside the deadzone presses nothing: %s" % JSON.stringify(eased))

	var dpad: Dictionary = await pad.inject_joypad_button({"button": "dpad_down"})
	if list.get_selected_items() != PackedInt32Array([2]):
		_fail("the dpad moves it on as well: %s" % str(list.get_selected_items()))
	if (
		JSON.stringify(dpad.get("actions")) != '["ui_down"]'
		or str(dpad.get("focused", "")) != str(list.get_path())
	):
		_fail("a button names the focused Control and the action it pressed: %s" % JSON.stringify(dpad))

	list.release_focus()
	var free_motion: Dictionary = pad.inject_joypad_motion({"axis": "left_y", "value": 0.75})
	if JSON.stringify(free_motion.get("actions")) != '["ui_down"]' or free_motion.has("focused"):
		_fail("with nothing focused a motion names nothing: %s" % JSON.stringify(free_motion))
	var _settled: Dictionary = pad.inject_joypad_motion({"axis": "left_y", "value": 0.0})
	Input.flush_buffered_events()
	list.queue_free()


## The nearest methods an object has, its script's and the engine's alike, or the script's own when
## none is near, and never the engine's hundreds. The input commands are the scripted object.
func _check_methods_offered(scripted: GdhInputCommands) -> void:
	var plain: Node = Node.new()
	var near: String = GdhPaths.with_methods_offered("I has no method inject_kye", scripted, "inject_kye")
	if (
		not near.begins_with("I has no method inject_kye; the nearest it has")
		or not near.contains("inject_key")
	):
		_fail("a misspelt method names the nearest the object has: %s" % near)
	var far: String = GdhPaths.with_methods_offered("I has no method nobody", scripted, "nobody")
	if (
		not far.begins_with("I has no method nobody; its script declares ")
		or not far.contains("inject_mouse_drag, ")
		or far.contains("get_class")
	):
		_fail("with nothing near, the script's own methods and no engine one: %s" % far)
	var engine_near: String = GdhPaths.with_methods_offered("N has no method get_parnt", plain, "get_parnt")
	if not engine_near.contains("; the nearest it has") or not engine_near.contains("get_parent"):
		_fail("an engine method near the name is offered too: %s" % engine_near)
	var bare: String = GdhPaths.with_methods_offered("N has no method nobody", plain, "nobody")
	if bare != "N has no method nobody":
		_fail("an object with no script and nothing near is refused as it was: %s" % bare)
	plain.free()
