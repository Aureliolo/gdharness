extends SceneTree

## A click on a toggle says the state either side of it. Reported from game-a: the
## game clock's switch clicked three times answered clicked each time, and a wait for the clock to
## move ran out on a clock left stopped. Each toggle here is checked beside a plain button, which
## answers no state, so a check that wrote the field everywhere fails too.
##
## Everything sits in the 64 by 64 viewport a script run with no window has.

const Checked = preload("checked.gd")
const InputCommands = preload("res://addons/gdharness_runtime/runtime_input.gd")
const Values = preload("res://addons/gdharness_runtime/runtime_values.gd")

var failures: Array[String] = []
var input: InputCommands = null
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
	input = InputCommands.new(host, Values.new())

	await _check_a_switch_both_ways()
	await _check_a_switch_the_game_puts_back()
	await _check_a_check_box_and_a_plain_button()
	await _check_a_toggle_that_leaves()

	host.queue_free()
	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return
	printerr("\n".join(failures))
	quit(1)


func _fail(message: String) -> void:
	failures.append(message)


func _placed(made: BaseButton, named: String, at: Vector2) -> void:
	made.name = named
	made.custom_minimum_size = Vector2(10, 10)
	made.position = at
	made.size = Vector2(10, 10)
	root.add_child(made)


func _switch(named: String, at: Vector2) -> Button:
	var made: Button = Button.new()
	made.toggle_mode = true
	made.flat = true
	_placed(made, named, at)
	return made


## Whether [param answer] landed and says the toggle went from [param before] to [param after].
func _went(answer: Dictionary, before: Variant, after: Variant) -> bool:
	var state: Dictionary = answer.get("pressed", {})
	return (
		answer.get("landed") == true
		and state.has("before")
		and state.has("after")
		and state["before"] == before
		and state["after"] == after
	)


func _check_a_switch_both_ways() -> void:
	var running: Button = _switch("Running", Vector2(2, 2))
	await process_frame
	var on: Dictionary = await input.click({"path": "/root/Running"})
	if not _went(on, false, true) or not running.button_pressed:
		_fail("a switch clicked on says off then on: %s" % JSON.stringify(on))
	var off: Dictionary = await input.click({"path": "/root/Running"})
	if not _went(off, true, false) or running.button_pressed:
		_fail("and clicked again says on then off: %s" % JSON.stringify(off))
	running.queue_free()
	await process_frame


## The game refuses the toggle and sets it back as it is pressed, so the click toggled nothing, and
## the answer has to say so rather than leave it to the next wait.
func _check_a_switch_the_game_puts_back() -> void:
	var locked: Button = _switch("Locked", Vector2(2, 2))
	var refuse: Callable = func(on: bool) -> void:
		if on:
			locked.set_pressed_no_signal(false)
	Checked.done(locked.toggled.connect(refuse) as Error, "putting the switch back")
	await process_frame
	var tried: Dictionary = await input.click({"path": "/root/Locked"})
	if not _went(tried, false, false) or locked.button_pressed:
		_fail("a switch the game puts back says off then off: %s" % JSON.stringify(tried))
	locked.queue_free()
	await process_frame


func _check_a_check_box_and_a_plain_button() -> void:
	var box: CheckBox = CheckBox.new()
	_placed(box, "Box", Vector2(2, 2))
	var plain: Button = Button.new()
	plain.flat = true
	_placed(plain, "Plain", Vector2(34, 2))
	await process_frame
	var ticked: Dictionary = await input.click({"path": "/root/Box"})
	if not _went(ticked, false, true) or not box.button_pressed:
		_fail("a check box is a toggle as it comes: %s" % JSON.stringify(ticked))
	var pushed: Dictionary = await input.click({"path": "/root/Plain"})
	if pushed.get("landed") != true or pushed.has("pressed"):
		_fail("a button that toggles nothing answers no state: %s" % JSON.stringify(pushed))
	box.queue_free()
	plain.queue_free()
	await process_frame


## Toggled on, it takes itself away, so there is no state after the click to read.
func _check_a_toggle_that_leaves() -> void:
	var leaving: Button = _switch("Leaving", Vector2(2, 2))
	var go: Callable = func(_on: bool) -> void: leaving.queue_free()
	Checked.done(leaving.toggled.connect(go) as Error, "freeing the switch as it toggles")
	await process_frame
	var gone: Dictionary = await input.click({"path": "/root/Leaving"})
	if not _went(gone, false, null) or gone.get("control_afterwards") != "freed":
		_fail("a toggle freed by its own click has no state after: %s" % JSON.stringify(gone))
