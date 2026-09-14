extends SceneTree

## The commands that take time: a click that presses and releases a frame apart, and the
## waits for frames, a signal and a property. They need the main loop running, so the checks
## start on the first frame rather than in _init, and the fixture quits when they are done.

const Runtime = preload("res://addons/gdharness_runtime/runtime_autoload.gd")

var failures: Array[String] = []
var node: Runtime
var button: Button
var frames_seen: int = 0
var presses: int = 0


func _init() -> void:
	# In the tree, because the commands ask it for the tree; announced somewhere private, so the
	# fixture does not look like a game to a server running on this machine.
	OS.set_environment(
		"GDHARNESS_RUNTIME_DIR", OS.get_temp_dir().path_join("gdharness-wait-%d" % OS.get_process_id())
	)
	node = Runtime.new()
	root.add_child(node)

	var panel: Panel = Panel.new()
	panel.name = "Panel"
	panel.position = Vector2(10, 20)
	panel.size = Vector2(300, 200)
	root.add_child(panel)

	button = Button.new()
	button.name = "Go"
	button.position = Vector2(30, 40)
	button.size = Vector2(80, 30)
	button.pressed.connect(func() -> void: presses += 1)
	panel.add_child(button)

	process_frame.connect(func() -> void: frames_seen += 1)
	process_frame.connect(_run, CONNECT_ONE_SHOT)


func _fail(message: String) -> void:
	failures.append(message)


func _run() -> void:
	# A headless window is 64 by 64 and the GUI delivers nothing outside the window; the new
	# size is only in force from the next frame.
	root.size = Vector2i(640, 480)
	await process_frame

	await _check_click()
	await _check_frames()
	await _check_signal()
	await _check_until()

	node._cleanup()
	DirAccess.remove_absolute(OS.get_environment("GDHARNESS_RUNTIME_DIR"))
	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return

	printerr("\n".join(failures))
	quit(1)


func _check_click() -> void:
	var clicked: Dictionary = await node._execute_command("click", {"path": "/root/Panel/Go"})
	if clicked.get("type") != "clicked":
		_fail("click: %s" % str(clicked))
		return
	if clicked.get("landed") != true or clicked.get("hovered") != "/root/Panel/Go":
		_fail("the click should land on the button it was aimed at: %s" % str(clicked))
	var position: Dictionary = clicked.get("position", {})
	if position.get("x") != 80.0 or position.get("y") != 75.0:
		_fail("the click should be at the button's centre in window pixels: %s" % str(clicked))
	if presses != 1:
		_fail("one click should press the button once, pressed %d times" % presses)

	var doubled: Dictionary = await node._execute_command("click", {"path": "/root/Panel/Go", "double": true})
	if doubled.get("double") != true:
		_fail("a double click should say so: %s" % str(doubled))

	button.hide()
	var hidden: Dictionary = await node._execute_command("click", {"path": "/root/Panel/Go"})
	if hidden.get("type") != "error":
		_fail("a hidden control cannot be clicked: %s" % str(hidden))
	button.show()

	var not_control: Dictionary = await node._execute_command("click", {"path": "/root"})
	if not_control.get("type") != "error":
		_fail("a node that is not a Control cannot be clicked: %s" % str(not_control))

	var far: Button = Button.new()
	far.name = "Far"
	far.position = Vector2(900, 900)
	far.size = Vector2(80, 30)
	button.get_parent().add_child(far)
	var off_screen: Dictionary = await node._execute_command("click", {"path": "/root/Panel/Far"})
	if (
		off_screen.get("type") != "error"
		or not str(off_screen.get("message", "")).contains("outside the viewport")
	):
		_fail("a control outside the window cannot be clicked, and the answer says so: %s" % str(off_screen))
	# This engine is headless, so a window is what it would take to reach anything out there and
	# the refusal has to say so: the rect on its own does not. It does not claim 64 by 64 here,
	# because this fixture resized the root and the rect printed beside it would contradict it.
	if not str(off_screen.get("message", "")).contains("run it with a window"):
		_fail("and names the window as what it would take: %s" % str(off_screen))
	if str(off_screen.get("message", "")).contains("64 by 64"):
		_fail("and does not claim a size the rect beside it disagrees with: %s" % str(off_screen))
	far.free()

	await _check_below_the_fold()
	await _check_a_dialog()

	if clicked.get("control_afterwards") != "in_tree":
		_fail("a button that stays put should be reported in the tree: %s" % str(clicked))

	# A button that acts on its own release the way a menu button does: the whole panel goes,
	# and the button with it. The click has to answer rather than trip over the node it aimed
	# at, and say what became of it.
	var freed: Dictionary = await _click_a_button_that(
		func(going: Button) -> void: going.get_parent().queue_free()
	)
	if freed.get("type") != "clicked" or freed.get("landed") != true:
		_fail("a click on a button that frees its panel should still land: %s" % str(freed))
	if freed.get("control_afterwards") != "freed":
		_fail("a button freed by its own click should be reported freed: %s" % str(freed))

	var removed: Dictionary = await _click_a_button_that(
		func(going: Button) -> void: going.get_parent().remove_child(going)
	)
	if removed.get("control_afterwards") != "removed":
		_fail("a button taken out of the tree by its own click should be reported removed: %s" % str(removed))


## The Yes on a confirmation dialog, which is what stands between a player and every destructive
## thing a game offers.
##
## Two separate faults met here. A dialog builds its buttons as internal children, so nothing
## walking `get_children()` could see them: a find over the screen for every Button came back
## without the two the player is being asked to press. And a dialog is a [Window], drawn inside
## its parent under `gui_embed_subwindows`, so a click pushed into its own viewport reached no
## control at all. Between them the only way to answer a dialog was to emit `confirmed`, which
## asks nothing and presses nothing.
func _check_a_dialog() -> void:
	var dialog: ConfirmationDialog = ConfirmationDialog.new()
	dialog.name = "AreYouSure"
	dialog.dialog_text = "Do the irreversible thing?"
	var confirmed: Array[int] = []
	dialog.confirmed.connect(func() -> void: confirmed.append(1))
	root.add_child(dialog)
	dialog.popup_centered(Vector2i(240, 120))
	await process_frame

	var buttons: Dictionary = await node._execute_command(
		"find_nodes", {"class": "Button", "root": "/root/AreYouSure"}
	)
	if int(buttons.get("count", 0)) < 2:
		_fail("a dialog's own buttons should be findable: %s" % str(buttons))

	var answered: Dictionary = await node._execute_command(
		"click", {"path": str(dialog.get_ok_button().get_path())}
	)
	if answered.get("type") != "clicked" or answered.get("landed") != true:
		_fail("a click on a dialog's Yes should land on it: %s" % str(answered))
	if confirmed.size() != 1:
		_fail("and should confirm it once, confirmed %d times" % confirmed.size())

	dialog.free()


## A button parked far below the fold of a ScrollContainer, which is where the ledger of a game
## with more in it than fits keeps most of its buttons.
##
## Out of sight is not out of reach: what a person does here is scroll and then click, and a
## refusal instead is what sends a caller to emit the button's own signal, which presses nothing
## and reports success. The tall column is the whole of the fixture, because a ScrollContainer
## only scrolls when what is in it does not fit.
func _check_below_the_fold() -> void:
	var scroller: ScrollContainer = ScrollContainer.new()
	scroller.name = "Ledger"
	# Clear of the panel the rest of this fixture clicks, or the scroller would sit over its
	# button and every click aimed at it would land on this instead.
	scroller.position = Vector2(350, 20)
	scroller.size = Vector2(200, 120)
	root.add_child(scroller)
	var column: VBoxContainer = VBoxContainer.new()
	column.name = "Column"
	scroller.add_child(column)
	for filler: int in 20:
		var spacer: Control = Control.new()
		spacer.custom_minimum_size = Vector2(180, 40)
		column.add_child(spacer)
	var buried: Button = Button.new()
	buried.name = "Buried"
	buried.custom_minimum_size = Vector2(180, 40)
	var pressed: Array[int] = []
	buried.pressed.connect(func() -> void: pressed.append(1))
	column.add_child(buried)
	await process_frame

	var reached: Dictionary = await node._execute_command("click", {"path": "/root/Ledger/Column/Buried"})

	if reached.get("type") != "clicked" or reached.get("landed") != true:
		_fail("a button below the fold should be scrolled to and clicked: %s" % str(reached))
	if reached.get("scrolled_into_view") != true:
		_fail("and the answer should say the view moved: %s" % str(reached))
	if pressed.size() != 1:
		_fail("a button below the fold should be pressed once, pressed %d times" % pressed.size())

	# The control that was already on screen is the other half: nothing should scroll for it, or
	# every click would be reported as having moved the view.
	var on_screen: Dictionary = await node._execute_command("click", {"path": "/root/Panel/Go"})
	if on_screen.get("scrolled_into_view") != false:
		_fail("a control already on screen should not report a scroll: %s" % str(on_screen))

	scroller.free()


## A fresh panel with one button whose press does `to_it`, clicked; the panel is cleared away
## afterwards whatever the press did to it.
func _click_a_button_that(to_it: Callable) -> Dictionary:
	var panel: Panel = Panel.new()
	panel.name = "Doomed"
	panel.position = Vector2(10, 250)
	panel.size = Vector2(300, 100)
	root.add_child(panel)
	var going: Button = Button.new()
	going.name = "Go"
	going.position = Vector2(30, 20)
	going.size = Vector2(80, 30)
	going.pressed.connect(func() -> void: to_it.call(going))
	panel.add_child(going)
	await process_frame

	var answer: Dictionary = await node._execute_command("click", {"path": "/root/Doomed/Go"})
	if is_instance_valid(going) and not going.is_inside_tree():
		going.free()
	if is_instance_valid(panel):
		panel.free()
	return answer


func _check_frames() -> void:
	var before: int = frames_seen
	var waited: Dictionary = await node._execute_command("wait_frames", {"frames": 3})
	if waited.get("frames") != 3 or frames_seen - before != 3:
		_fail(
			(
				"wait_frames should let exactly that many frames pass: %s, saw %d"
				% [str(waited), frames_seen - before]
			)
		)


func _check_signal() -> void:
	var timer: Timer = Timer.new()
	timer.name = "Fuse"
	timer.one_shot = true
	timer.wait_time = 0.05
	root.add_child(timer)
	timer.start()
	var fired: Dictionary = await node._execute_command(
		"wait_signal", {"path": "/root/Fuse", "signal": "timeout"}
	)
	if fired.get("fired") != true:
		_fail("a signal that fires should be reported as fired: %s" % str(fired))

	var expired: Dictionary = await node._execute_command(
		"wait_signal", {"path": "/root/Fuse", "signal": "timeout", "timeout_ms": 60}
	)
	if expired.get("fired") != false or int(expired.get("elapsed_ms", 0)) < 60:
		_fail(
			"a signal that never fires should be reported as not fired after the timeout: %s" % str(expired)
		)
	if not timer.timeout.get_connections().is_empty():
		_fail("the catcher should be disconnected once the wait gives up")

	var with_args: Dictionary = await node._execute_command(
		"wait_signal", {"path": "/root/Panel/Go", "signal": "toggled", "timeout_ms": 500}
	)
	if with_args.get("fired") != false:
		_fail("toggled should not fire on its own: %s" % str(with_args))

	var unknown: Dictionary = await node._execute_command(
		"wait_signal", {"path": "/root/Fuse", "signal": "nonesuch"}
	)
	if unknown.get("type") != "error":
		_fail("a signal the node does not have is refused: %s" % str(unknown))
	timer.free()


func _check_until() -> void:
	var late: Callable = func() -> void:
		await process_frame
		await process_frame
		button.visible = false
	late.call()
	var met: Dictionary = await node._execute_command(
		"wait_until", {"path": "/root/Panel/Go", "property": "visible", "value": false}
	)
	if met.get("met") != true or met.get("value") != false:
		_fail("wait_until should see the property change: %s" % str(met))

	var unmet: Dictionary = await node._execute_command(
		"wait_until", {"path": "/root/Panel/Go", "property": "visible", "value": true, "timeout_ms": 60}
	)
	if unmet.get("met") != false or unmet.get("value") != false:
		_fail("wait_until should report the last value when the time runs out: %s" % str(unmet))

	var no_value: Dictionary = await node._execute_command(
		"wait_until", {"path": "/root/Panel/Go", "property": "visible"}
	)
	if no_value.get("type") != "error":
		_fail("wait_until without a value is refused: %s" % str(no_value))
