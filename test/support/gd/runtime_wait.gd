extends SceneTree

## The commands that take time: a click that presses and releases a frame apart, and the
## waits for frames, a signal and a property. They need the main loop running, so the checks
## start on the first frame rather than in _init, and the fixture quits when they are done.

const Runtime = preload("res://addons/gdharness_runtime/runtime_autoload.gd")

## How tall the room's camera sees, in metres. Against a 480 pixel viewport that is 48 pixels a
## metre, which is what makes every figure in [method _check_the_room] exact rather than read back
## off whatever the engine answered.
const ROOM_METRES: float = 10.0

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
	await _check_the_room()
	await _check_a_menu()
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


## Somebody standing in a 3D room, which is the other half of what a game puts on screen and had
## no answer at all: a rect refused a Node3D, and a click took Controls only.
##
## Everything here is arithmetic rather than a picture, so it works in an engine with nothing
## drawn. An orthographic camera is what makes the expected numbers exact: 480 pixels of viewport
## over ten metres of camera is 48 pixels a metre, and the figures below are read off that rather
## than off whatever the engine happened to answer.
##
## The body's origin is on the floor and its mesh is a metre above it, the way a character is
## built, because that gap is the whole reason the aim is the middle of what a node draws rather
## than the point it is standing on.
func _check_the_room() -> void:
	var eye: Camera3D = Camera3D.new()
	eye.name = "Eye"
	eye.projection = Camera3D.PROJECTION_ORTHOGONAL
	eye.size = ROOM_METRES
	eye.position = Vector3(0.0, 0.0, 10.0)
	root.add_child(eye)
	eye.make_current()

	var body: Node3D = Node3D.new()
	body.name = "Body"
	# Down and to the right of the middle, which is where the rest of this fixture's panels are
	# not. A click that landed on one of those would be reported as swallowed and be right.
	body.position = Vector3(2.5, -3.0, 0.0)
	root.add_child(body)
	var shape: MeshInstance3D = MeshInstance3D.new()
	shape.mesh = BoxMesh.new()
	shape.position = Vector3(0.0, 1.0, 0.0)
	body.add_child(shape)
	await process_frame

	await _check_the_body_is_placed()
	await _check_the_body_can_be_clicked()
	await _check_a_panel_over_the_room()
	await _check_a_body_behind_the_camera(body)

	body.free()
	eye.free()


func _check_the_body_is_placed() -> void:
	var placed: Dictionary = await node._execute_command("get_rect", {"path": "/root/Body"})
	if placed.get("type") != "point":
		_fail("a 3D node should have a place on screen: %s" % str(placed))
		return
	var canvas: Dictionary = placed.get("canvas", {})
	# The mesh's middle, a metre above the floor the body stands on, rather than the body's own
	# origin: that would be 384 here, and a click there lands at its feet.
	if canvas.get("x") != 440.0 or canvas.get("y") != 336.0:
		_fail("a 3D node is placed where its mesh is drawn: %s" % str(placed))
	if placed.get("behind_camera") != false or placed.get("camera") != "/root/Eye":
		_fail("and says which camera drew it and that it is in front of it: %s" % str(placed))
	# A one-metre box seen at 48 pixels a metre, centred on the same point.
	var covered: Dictionary = placed.get("covers", {})
	var covers: Dictionary = covered.get("canvas", {})
	var corner: Dictionary = covers.get("position", {})
	var across: Dictionary = covers.get("size", {})
	if corner.get("x") != 416.0 or corner.get("y") != 312.0:
		_fail("and the rectangle it covers starts at the corner of its box: %s" % str(placed))
	if across.get("x") != 48.0 or across.get("y") != 48.0:
		_fail("and is as wide as the box is: %s" % str(placed))


func _check_the_body_can_be_clicked() -> void:
	var clicked: Dictionary = await node._execute_command("click", {"path": "/root/Body"})
	if clicked.get("type") != "clicked":
		_fail("a 3D node should be clickable: %s" % str(clicked))
		return
	var at: Dictionary = clicked.get("position", {})
	if at.get("x") != 440.0 or at.get("y") != 336.0:
		_fail("and the click goes where the rect said it is: %s" % str(clicked))
	# Nothing on the interface took it, so it reached the game's own input, which is as close to
	# landing as anything outside the game can say.
	if clicked.get("landed") != true or clicked.get("hovered") != null:
		_fail("and lands when no panel is over it: %s" % str(clicked))


## A panel over the room, which is the failure worth naming: the press never reaches the floor and
## the game looks like one that ignored it.
func _check_a_panel_over_the_room() -> void:
	var over: Panel = Panel.new()
	over.name = "Over"
	over.position = Vector2(400, 300)
	over.size = Vector2(100, 100)
	root.add_child(over)
	await process_frame

	var swallowed: Dictionary = await node._execute_command("click", {"path": "/root/Body"})
	if swallowed.get("landed") != false or swallowed.get("hovered") != "/root/Over":
		_fail("a panel over the room should be named as what took the click: %s" % str(swallowed))
	over.free()


func _check_a_body_behind_the_camera(body: Node3D) -> void:
	body.position = Vector3(2.5, -3.0, 20.0)
	await process_frame

	var placed: Dictionary = await node._execute_command("get_rect", {"path": "/root/Body"})
	if placed.get("behind_camera") != true or placed.has("canvas"):
		_fail("a node behind the camera has no place on screen and says so: %s" % str(placed))

	var refused: Dictionary = await node._execute_command("click", {"path": "/root/Body"})
	if refused.get("type") != "error" or not str(refused.get("message", "")).contains("behind the camera"):
		_fail("and cannot be clicked: %s" % str(refused))
	body.position = Vector3(2.5, -3.0, 0.0)


## An [OptionButton], which is what a language picker, a filter and every dropdown in a game is.
##
## Nothing could work one. A menu's items are drawn rather than built, so there is no node under
## the pointer and no rectangle to ask for, and a whole click on the button in front of it opens
## the menu on the press and closes it again on the release: measured in a real game, where the
## popup came up and was gone by the time the answer came back. What was left was calling `select`
## and emitting `item_selected` by hand, which sets a number and runs none of the engine's path.
func _check_a_menu() -> void:
	var picker: OptionButton = OptionButton.new()
	picker.name = "Picker"
	picker.position = Vector2(350, 200)
	picker.size = Vector2(160, 30)
	picker.add_item("Everything", 10)
	picker.add_item("Word back", 20)
	picker.add_item("Trouble", 30)
	picker.set_item_disabled(2, true)
	var chosen: Array[int] = []
	picker.item_selected.connect(func(index: int) -> void: chosen.append(index))
	root.add_child(picker)
	await process_frame

	await _check_choosing_by_what_it_says(chosen)
	await _check_choosing_by_where_it_is()
	await _check_a_menu_says_no()

	picker.free()


func _check_choosing_by_what_it_says(chosen: Array[int]) -> void:
	var took: Dictionary = await node._execute_command(
		"choose", {"path": "/root/Picker", "text": "Word back"}
	)
	if took.get("type") != "chosen":
		_fail("an option should be choosable by what it says: %s" % str(took))
		return
	if took.get("index") != 1 or took.get("id") != 20:
		_fail("and answer with which one it was: %s" % str(took))
	# The button in front of the menu, because that is what the player is looking at and the one
	# thing a press that did nothing would leave unchanged.
	if took.get("selected") != 1 or took.get("shows") != "Word back":
		_fail("and the button should be showing it: %s" % str(took))
	if chosen != [1]:
		_fail("and the engine's own signal should have fired once: %s" % str(chosen))


func _check_choosing_by_where_it_is() -> void:
	var took: Dictionary = await node._execute_command("choose", {"path": "/root/Picker", "index": 0})
	if took.get("type") != "chosen" or took.get("text") != "Everything":
		_fail("an option should be choosable by where it is in the list: %s" % str(took))


## The three refusals worth having. A menu that answered "nothing happened" to all of them would
## be one nobody could tell a typo from a greyed-out row in.
func _check_a_menu_says_no() -> void:
	var greyed: Dictionary = await node._execute_command(
		"choose", {"path": "/root/Picker", "text": "Trouble"}
	)
	if greyed.get("type") != "error" or not str(greyed.get("message", "")).contains("disabled"):
		_fail("a disabled item should be refused and said to be: %s" % str(greyed))

	var missing: Dictionary = await node._execute_command(
		"choose", {"path": "/root/Picker", "text": "Nothing like it"}
	)
	if missing.get("type") != "error" or not str(missing.get("message", "")).contains("Everything"):
		_fail("an item that is not there should be refused with the ones that are: %s" % str(missing))

	var unasked: Dictionary = await node._execute_command("choose", {"path": "/root/Picker"})
	if unasked.get("type") != "error" or not str(unasked.get("message", "")).contains("by text or index"):
		_fail("naming no item at all should say how to name one: %s" % str(unasked))


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

	# And the other way past the fold. A row scrolled off the top is still inside the viewport, so
	# a click aimed at it went to whatever is drawn up there and reported that it had not landed.
	# Found in a real hall: the staff panel's button sat at y 69 with its container starting at 166.
	var first: Button = Button.new()
	first.name = "Topmost"
	first.custom_minimum_size = Vector2(180, 40)
	var early: Array[int] = []
	first.pressed.connect(func() -> void: early.append(1))
	column.add_child(first)
	column.move_child(first, 0)
	scroller.set_deferred("scroll_vertical", 400)
	await process_frame
	await process_frame

	var above: Dictionary = await node._execute_command("click", {"path": "/root/Ledger/Column/Topmost"})

	if above.get("type") != "clicked" or above.get("landed") != true:
		_fail("a button above the fold should be scrolled to and clicked: %s" % str(above))
	if early.size() != 1:
		_fail("a button above the fold should be pressed once, pressed %d times" % early.size())

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

	# More than it can wait for is refused rather than brought inside the range: 900 frames asked
	# for and 600 waited reads as 900 frames of the game having passed, and anything measured off
	# that is out by the difference.
	var too_many: Dictionary = await node._execute_command("wait_frames", {"frames": 900})
	if too_many.get("type") != "error" or not str(too_many.get("message", "")).contains("1 to 600"):
		_fail("more frames than it can wait for should be refused with the range: %s" % str(too_many))
	var none: Dictionary = await node._execute_command("wait_frames", {"frames": 0})
	if none.get("type") != "error":
		_fail("a wait of no frames should be refused: %s" % str(none))


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
