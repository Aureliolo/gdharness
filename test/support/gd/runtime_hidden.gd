extends SceneTree

## Refusals for a control or a 3D node that is not visible, which name what hides it. The node's own
## visible reads true when only an ancestor is hidden, so a refusal saying only "is not visible" left
## a caller nothing to unhide. Reported from fantasy-guild-manager: a ledger tab under a hall hidden
## while the game's menu was open. Each refusal is checked beside the call that works once nothing
## hides the node, so a check refusing everything fails too.
##
## Everything sits in the 64 by 64 viewport a game with no window has.

const Checked = preload("checked.gd")
const InputCommands = preload("res://addons/gdharness_runtime/runtime_input.gd")
const Typing = preload("res://addons/gdharness_runtime/runtime_typing.gd")
const Values = preload("res://addons/gdharness_runtime/runtime_values.gd")

const TAB: String = "/root/Main/Hall/Rail/Tab"

var failures: Array[String] = []
var pressed: Dictionary = {}
var input: InputCommands = null
var typing: Typing = null
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
	typing = Typing.new(host)

	await _check_a_tab_under_a_hidden_hall()
	await _check_a_screen_drawn_over_a_hidden_one()
	await _check_a_button_on_a_hidden_layer()
	await _check_a_dropdown_under_a_hidden_panel()
	await _check_a_node_in_a_hidden_world()

	host.queue_free()
	if failures.is_empty():
		print(JSON.stringify({"ok": true}))
		quit(0)
		return
	printerr("\n".join(failures))
	quit(1)


func _fail(message: String) -> void:
	failures.append(message)


func _count(named: String) -> void:
	var so_far: int = pressed.get(named, 0)
	pressed[named] = so_far + 1


func _presses(named: String) -> int:
	return pressed.get(named, 0)


func _control(named: String, parent: Node) -> Control:
	var made: Control = Control.new()
	made.name = named
	parent.add_child(made)
	return made


## A small flat button, so several fit in the viewport a game with no window has.
func _button(named: String, at: Vector2, parent: Node) -> Button:
	var made: Button = Button.new()
	made.name = named
	made.flat = true
	made.custom_minimum_size = Vector2(10, 10)
	made.position = at
	made.size = Vector2(10, 10)
	parent.add_child(made)
	Checked.done(made.pressed.connect(_count.bind(named)) as Error, "counting presses of %s" % named)
	return made


func _says(answer: Dictionary, words: String) -> bool:
	return answer.get("type") == "error" and str(answer.get("message", "")).contains(words)


## The hall and the menu shown beside it, then two and four shown beside it, both hidden nodes when
## the hall's parent is hidden too, the tab alone when it is its own flag, and a hidden control above
## a plain Node left out, since by the engine's rule it hides nothing below that Node.
func _check_a_tab_under_a_hidden_hall() -> void:
	var main: Control = _control("Main", root)
	var hall: Control = _control("Hall", main)
	var _menu: Control = _control("Menu", main)
	var tab: Button = _button("Tab", Vector2(2, 2), _control("Rail", hall))
	await process_frame

	hall.visible = false
	var hidden: Dictionary = await input.click({"path": TAB})
	var expected: String = (
		"%s is not visible (/root/Main/Hall is hidden;" % TAB
		+ " /root/Main/Menu is shown beside /root/Main/Hall), so nothing can click it"
	)
	if not _says(hidden, expected) or _presses("Tab") != 0:
		_fail("a tab under a hidden hall names the hall and what is shown: %s" % JSON.stringify(hidden))
	var beside: Array[Control] = []
	for named: String in ["Ledger", "Purse", "Roster"]:
		beside.append(_control(named, main))
		if beside.size() == 1:
			var two: Dictionary = await input.click({"path": TAB})
			if not _says(two, "; /root/Main/Menu and /root/Main/Ledger are shown beside /root/Main/Hall)"):
				_fail("two shown beside the hall are both named: %s" % JSON.stringify(two))
	var four: Dictionary = await input.click({"path": TAB})
	var counted: String = (
		"; /root/Main/Menu, /root/Main/Ledger, /root/Main/Purse"
		+ " and 1 more are shown beside /root/Main/Hall)"
	)
	if not _says(four, counted):
		_fail("past three shown beside the hall, the rest are counted: %s" % JSON.stringify(four))
	for shown_too: Control in beside:
		shown_too.free()

	main.visible = false
	var both: Dictionary = await input.click({"path": TAB})
	main.visible = true
	if not _says(both, "(/root/Main/Hall is hidden, and /root/Main is hidden too)"):
		_fail("both hidden nodes are named, nearest first: %s" % JSON.stringify(both))

	# The rail hidden inside the hidden hall: what is shown beside the rail is hidden with it, and
	# the menu is what stands beside the hall.
	var rail: Control = root.get_node("Main/Hall/Rail")
	rail.visible = false
	var nested: Dictionary = await input.click({"path": TAB})
	rail.visible = true
	var outer: String = (
		"(/root/Main/Hall/Rail is hidden, and /root/Main/Hall is hidden too;"
		+ " /root/Main/Menu is shown beside /root/Main/Hall)"
	)
	if not _says(nested, outer):
		_fail("what is shown is read beside the outermost hidden node: %s" % JSON.stringify(nested))

	hall.visible = true
	tab.visible = false
	var own: Dictionary = await input.click({"path": TAB})
	tab.visible = true
	if not _says(own, "%s is not visible (its own visible is false)" % TAB):
		_fail("a tab hidden by its own flag says so: %s" % JSON.stringify(own))

	var shown: Dictionary = await input.click({"path": TAB})
	if shown.get("landed") != true or _presses("Tab") != 1:
		_fail("and the tab is pressed once nothing hides it: %s" % JSON.stringify(shown))

	var cover: Control = _control("Cover", main)
	cover.visible = false
	var plain: Node = Node.new()
	plain.name = "Plain"
	cover.add_child(plain)
	var lone: Button = _button("Lone", Vector2(34, 34), plain)
	lone.visible = false
	await process_frame
	var alone: Dictionary = await input.click({"path": "/root/Main/Cover/Plain/Lone"})
	if not _says(alone, "/root/Main/Cover/Plain/Lone is not visible (its own visible is false), so"):
		_fail("a hidden control above a plain Node is not named: %s" % JSON.stringify(alone))

	main.queue_free()
	await process_frame


## The shape fantasy-guild-manager reported on 1.2.1: the hall stays visible and a screen inside it is
## hidden, while a menu beside the hall is drawn where the tab was. Named by what is drawn at the
## tab's place, the topmost there: the menu's button over the menu, and not the hall, which covers
## the place by holding the tab. The menu comes before the hall in the tree, so the hall is drawn
## above it and only its holding the tab keeps it from being named.
func _check_a_screen_drawn_over_a_hidden_one() -> void:
	var shown: Control = _control("Shown", root)
	shown.size = Vector2(64, 64)
	var menu: Control = _control("Menu", shown)
	menu.size = Vector2(64, 64)
	var _resume: Button = _button("Resume", Vector2(0, 0), menu)
	_resume.size = Vector2(20, 20)
	var hall: Control = _control("Hall", shown)
	hall.size = Vector2(64, 64)
	var screen: Control = _control("Screen", hall)
	screen.size = Vector2(64, 64)
	var _books: Button = _button("Books", Vector2(2, 2), screen)
	await process_frame
	screen.visible = false
	var covered: Dictionary = await input.click({"path": "/root/Shown/Hall/Screen/Books"})
	var expected: String = (
		"/root/Shown/Hall/Screen/Books is not visible (/root/Shown/Hall/Screen is hidden;"
		+ " /root/Shown/Menu/Resume is drawn where it would be), so nothing can click it"
	)
	if not _says(covered, expected) or _presses("Books") != 0 or _presses("Resume") != 0:
		_fail("a tab on a hidden screen names what is drawn in its place: %s" % JSON.stringify(covered))
	# A dialog open over the place is above everything in the viewport holding it.
	var dialog: Window = Window.new()
	dialog.name = "Dialog"
	dialog.position = Vector2i(0, 0)
	dialog.size = Vector2i(30, 30)
	root.add_child(dialog)
	await process_frame
	var under: Dictionary = await input.click({"path": "/root/Shown/Hall/Screen/Books"})
	dialog.queue_free()
	await process_frame
	if not _says(under, "(/root/Shown/Hall/Screen is hidden; /root/Dialog is drawn where it would be)"):
		_fail("a dialog over a hidden tab is what is drawn there: %s" % JSON.stringify(under))
	screen.visible = true
	var reached: Dictionary = await input.click({"path": "/root/Shown/Hall/Screen/Books"})
	if reached.get("landed") != true or _presses("Books") != 1:
		_fail("and is pressed once the screen is shown: %s" % JSON.stringify(reached))
	shown.queue_free()
	await process_frame


## A button straight on a hidden canvas layer, which is what hides it, with the control shown
## beside the layer named as well.
func _check_a_button_on_a_hidden_layer() -> void:
	var _beside: Control = _control("Beside", root)
	var layer: CanvasLayer = CanvasLayer.new()
	layer.name = "Layer"
	root.add_child(layer)
	var _drawn: Button = _button("Drawn", Vector2(34, 2), layer)
	await process_frame
	layer.visible = false
	await process_frame
	var on_layer: Dictionary = await input.click({"path": "/root/Layer/Drawn"})
	var by_layer: String = (
		"/root/Layer/Drawn is not visible (/root/Layer is hidden;"
		+ " /root/Beside is shown beside /root/Layer), so nothing can click it"
	)
	if not _says(on_layer, by_layer) or _presses("Drawn") != 0:
		_fail("a button on a hidden canvas layer names the layer: %s" % JSON.stringify(on_layer))
	layer.visible = true
	var on_shown_layer: Dictionary = await input.click({"path": "/root/Layer/Drawn"})
	if on_shown_layer.get("landed") != true or _presses("Drawn") != 1:
		_fail("and is pressed once the layer is shown: %s" % JSON.stringify(on_shown_layer))
	_beside.queue_free()
	layer.queue_free()
	await process_frame


## A dropdown whose menu cannot be opened because the panel holding it is hidden.
func _check_a_dropdown_under_a_hidden_panel() -> void:
	var panel: Control = _control("Panel", root)
	var option: OptionButton = OptionButton.new()
	option.name = "Option"
	option.add_item("one")
	option.add_item("two")
	panel.add_child(option)
	await process_frame
	panel.visible = false
	var unseen: Dictionary = await typing.choose({"path": "/root/Panel/Option", "index": 1})
	var expected: String = (
		"/root/Panel/Option is not visible (/root/Panel is hidden)" + ", so its menu cannot be opened"
	)
	if not _says(unseen, expected) or option.selected != 0:
		_fail("a dropdown under a hidden panel names the panel: %s" % JSON.stringify(unseen))
	panel.visible = true
	var chosen: Dictionary = await typing.choose({"path": "/root/Panel/Option", "index": 1})
	if chosen.get("type") == "error" or option.selected != 1:
		_fail("and it is chosen from once the panel is shown: %s" % JSON.stringify(chosen))
	panel.queue_free()
	await process_frame


## A 3D node in a hidden world, the world named, beside the same node clicked once it is shown.
func _check_a_node_in_a_hidden_world() -> void:
	var world: Node3D = Node3D.new()
	world.name = "World"
	root.add_child(world)
	var camera: Camera3D = Camera3D.new()
	camera.position = Vector3(0, 0, 5)
	world.add_child(camera)
	camera.make_current()
	var target: MeshInstance3D = MeshInstance3D.new()
	target.name = "Target"
	target.mesh = BoxMesh.new()
	world.add_child(target)
	await process_frame
	world.visible = false
	var unseen: Dictionary = await input.click({"path": "/root/World/Target"})
	if not _says(unseen, "/root/World/Target is not visible (/root/World is hidden), so nothing can"):
		_fail("a 3D node in a hidden world names the world: %s" % JSON.stringify(unseen))
	world.visible = true
	var reached: Dictionary = await input.click({"path": "/root/World/Target"})
	if reached.get("landed") != true:
		_fail("and is clicked once the world is shown: %s" % JSON.stringify(reached))
	world.queue_free()
	await process_frame
