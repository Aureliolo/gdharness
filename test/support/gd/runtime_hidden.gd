extends SceneTree
## Refusals for a control or a 3D node that is not visible, or whose pointer a card above it has
## turned off, which name what hides it or turned it off. The node's own visible reads true when
## only an ancestor is hidden, so a refusal saying only "is not visible" left a caller nothing to
## unhide. Reported from game-a: a tab inside a hidden screen while the game's menu was open.
## Each refusal is checked beside the call that works once nothing hides the node, so a check
## refusing everything fails too.
##
## Everything sits in the 64 by 64 viewport a script run with no window has.

const Checked = preload("checked.gd")
const GdhInputCommands = preload("res://addons/gdharness_runtime/runtime_input.gd")
const GdhTyping = preload("res://addons/gdharness_runtime/runtime_typing.gd")
const GdhValues = preload("res://addons/gdharness_runtime/runtime_values.gd")
const TAB: String = "/root/Main/Screen/Bar/Tab"

var failures: Array[String] = []
var pressed: Dictionary = {}
var input: GdhInputCommands = null
var typing: GdhTyping = null
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
	input = GdhInputCommands.new(host, GdhValues.new())
	typing = GdhTyping.new(host)

	await _check_a_tab_under_a_hidden_screen()
	await _check_a_screen_drawn_over_a_hidden_one()
	await _check_a_button_on_a_hidden_layer()
	await _check_buttons_offered_for_words_nobody_shows()
	await _check_a_dropdown_under_a_hidden_panel()
	await _check_a_node_in_a_hidden_world()
	await _check_a_card_that_turned_the_pointer_off()

	host.queue_free()
	if failures.is_empty():
		print(JSON.stringify({ "ok": true }))
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
	Checked.done(
		made.pressed.connect(_count.bind(named)) as Error, "counting presses of %s" % named
	)
	return made


func _says(answer: Dictionary, words: String) -> bool:
	return answer.get("type") == "error" and str(answer.get("message", "")).contains(words)


## The screen and the menu shown beside it, then two and four shown beside it, both hidden nodes
## when the screen's parent is hidden too, the tab alone when it is its own flag, and a hidden
## control above a plain Node left out, since by the engine's rule it hides nothing below that Node.
func _check_a_tab_under_a_hidden_screen() -> void:
	var main: Control = _control("Main", root)
	var screen: Control = _control("Screen", main)
	var _menu: Control = _control("Menu", main)
	var tab: Button = _button("Tab", Vector2(2, 2), _control("Bar", screen))
	await process_frame

	screen.visible = false
	var hidden: Dictionary = await input.click({ "path": TAB })
	var expected: String = (
		"%s is not visible (/root/Main/Screen is hidden," % TAB
		+ " and /root/Main/Menu is shown beside /root/Main/Screen), so nothing can click it"
	)
	if not _says(hidden, expected) or _presses("Tab") != 0:
		_fail(
			(
				"a tab under a hidden screen names the screen and what is shown: %s"
				% JSON.stringify(hidden)
			)
		)
	var beside: Array[Control] = []
	for named: String in ["First", "Second", "Third"]:
		beside.append(_control(named, main))
		if beside.size() == 1:
			var two: Dictionary = await input.click({ "path": TAB })
			var two_named: String = (
				", and /root/Main/Menu and /root/Main/First"
				+ " are shown beside /root/Main/Screen)"
			)
			if not _says(two, two_named):
				_fail("two shown beside the screen are both named: %s" % JSON.stringify(two))
	var four: Dictionary = await input.click({ "path": TAB })
	var counted: String = (
		", and /root/Main/Menu, /root/Main/First, /root/Main/Second"
		+ " and 1 more are shown beside /root/Main/Screen)"
	)
	if not _says(four, counted):
		_fail("past three shown beside the screen, the rest are counted: %s" % JSON.stringify(four))
	for shown_too: Control in beside:
		shown_too.free()

	main.visible = false
	var both: Dictionary = await input.click({ "path": TAB })
	main.visible = true
	if not _says(both, "(/root/Main/Screen is hidden, and /root/Main is hidden too)"):
		_fail("both hidden nodes are named, nearest first: %s" % JSON.stringify(both))

	# The bar hidden inside the hidden screen: what is shown beside the bar is hidden with it, and
	# the menu is what stands beside the screen.
	var bar: Control = root.get_node("Main/Screen/Bar")
	bar.visible = false
	var nested: Dictionary = await input.click({ "path": TAB })
	bar.visible = true
	var outer: String = (
		"(/root/Main/Screen/Bar is hidden, and /root/Main/Screen is hidden too,"
		+ " and /root/Main/Menu is shown beside /root/Main/Screen)"
	)
	if not _says(nested, outer):
		_fail("what is shown is read beside the outermost hidden node: %s" % JSON.stringify(nested))

	screen.visible = true
	tab.visible = false
	var own: Dictionary = await input.click({ "path": TAB })
	tab.visible = true
	if not _says(own, "%s is not visible (its own visible is false)" % TAB):
		_fail("a tab hidden by its own flag says so: %s" % JSON.stringify(own))

	var shown: Dictionary = await input.click({ "path": TAB })
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
	var alone: Dictionary = await input.click({ "path": "/root/Main/Cover/Plain/Lone" })
	if not _says(
		alone, "/root/Main/Cover/Plain/Lone is not visible (its own visible is false), so"
	):
		_fail("a hidden control above a plain Node is not named: %s" % JSON.stringify(alone))

	main.queue_free()
	await process_frame


## The shape game-a reported on 1.2.1: the outer screen stays visible and a screen inside it is
## hidden, while a menu beside it is drawn where the tab was. Named by what is drawn at the tab's
## place, the topmost there. That is the menu's button over the menu, and not the outer screen,
## which covers the place by holding the tab. The menu comes before the outer screen in the tree,
## so the outer screen is drawn above it and only its holding the tab keeps it from being named.
func _check_a_screen_drawn_over_a_hidden_one() -> void:
	var shown: Control = _control("Shown", root)
	shown.size = Vector2(64, 64)
	var menu: Control = _control("Menu", shown)
	menu.size = Vector2(64, 64)
	var _resume: Button = _button("Resume", Vector2(0, 0), menu)
	_resume.size = Vector2(20, 20)
	var outer: Control = _control("Outer", shown)
	outer.size = Vector2(64, 64)
	var screen: Control = _control("Screen", outer)
	screen.size = Vector2(64, 64)
	var _item: Button = _button("Item", Vector2(2, 2), screen)
	await process_frame
	screen.visible = false
	var covered: Dictionary = await input.click({ "path": "/root/Shown/Outer/Screen/Item" })
	var expected: String = (
		"/root/Shown/Outer/Screen/Item is not visible (/root/Shown/Outer/Screen is hidden,"
		+ " and a click where it would be reaches /root/Shown/Menu/Resume), so nothing can click it"
	)
	if not _says(covered, expected) or _presses("Item") != 0 or _presses("Resume") != 0:
		_fail(
			(
				"a tab on a hidden screen names what is drawn in its place: %s"
				% JSON.stringify(covered)
			)
		)
	# A dialog open over the place is above everything in the viewport holding it.
	var dialog: Window = Window.new()
	dialog.name = "Dialog"
	dialog.position = Vector2i(0, 0)
	dialog.size = Vector2i(30, 30)
	root.add_child(dialog)
	await process_frame
	var under: Dictionary = await input.click({ "path": "/root/Shown/Outer/Screen/Item" })
	dialog.queue_free()
	await process_frame
	var drawn_there: String = (
		"(/root/Shown/Outer/Screen is hidden, and a click where it would be reaches /root/Dialog)"
	)
	if not _says(under, drawn_there):
		_fail("a dialog over a hidden tab is what is drawn there: %s" % JSON.stringify(under))
	screen.visible = true
	var reached: Dictionary = await input.click({ "path": "/root/Shown/Outer/Screen/Item" })
	if reached.get("landed") != true or _presses("Item") != 1:
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
	var on_layer: Dictionary = await input.click({ "path": "/root/Layer/Drawn" })
	var by_layer: String = (
		"/root/Layer/Drawn is not visible (/root/Layer is hidden,"
		+ " and /root/Beside is shown beside /root/Layer), so nothing can click it"
	)
	if not _says(on_layer, by_layer) or _presses("Drawn") != 0:
		_fail("a button on a hidden canvas layer names the layer: %s" % JSON.stringify(on_layer))
	layer.visible = true
	var on_shown_layer: Dictionary = await input.click({ "path": "/root/Layer/Drawn" })
	if on_shown_layer.get("landed") != true or _presses("Drawn") != 1:
		_fail("and is pressed once the layer is shown: %s" % JSON.stringify(on_shown_layer))
	_beside.queue_free()
	layer.queue_free()
	await process_frame


## Words only a hidden control says, with buttons on screen: the refusal offers the ones a player
## could press instead, and not one that is disabled or has something drawn over it. A click for
## words nothing on screen said named nothing, though Play, Options and Quit were all there.
func _check_buttons_offered_for_words_nobody_shows() -> void:
	var panel: Control = _control("Panel", root)
	panel.visible = false
	_button("Back", Vector2(2, 2), panel).text = "Back"
	# One a quarter of the viewport, its words clipped so they do not widen it over the next.
	var corners: Array[Vector2] = [Vector2(0, 0), Vector2(32, 0), Vector2(0, 32), Vector2(32, 32)]
	var named: Array[String] = ["Play", "Quit", "Later", "Buried"]
	for at: int in named.size():
		var made: Button = _button(named[at], corners[at], root)
		made.text = named[at]
		made.clip_text = true
		made.size = Vector2(30, 30)
	(root.get_node("Later") as Button).disabled = true
	var lid: Control = _control("Lid", root)
	lid.position = corners[3]
	lid.size = Vector2(32, 32)
	await process_frame
	var refused: Dictionary = await input.click({ "says": "Back" })
	var offered: String = str(refused.get("message", "")).get_slice("The buttons on screen say ", 1)
	if not _says(refused, "1 hidden control says it") or offered != '"Play", "Quit"':
		_fail(
			"words only a hidden control says offer what is on screen: %s" % JSON.stringify(refused)
		)
	# The control saying the words is not the node hidden, so both are named.
	if not _says(refused, "1 hidden control says it, /root/Panel/Back (/root/Panel is hidden"):
		_fail("and name the hidden one with what hides it: %s" % JSON.stringify(refused))
	# A click that lands says whether the button heard it: Quit takes only the right button.
	var play: Dictionary = await input.click({ "says": "Play" })
	if play.get("landed") != true or play.get("pressed_signal") != true or _presses("Play") != 1:
		_fail("a button that heard the click says so: %s" % JSON.stringify(play))
	(root.get_node("Quit") as Button).button_mask = MOUSE_BUTTON_MASK_RIGHT
	var quit_left: Dictionary = await input.click({ "says": "Quit" })
	if (
		quit_left.get("landed") != true
		or quit_left.get("pressed_signal") != false
		or _presses("Quit") != 0
	):
		_fail(
			"and one the click landed on without pressing says that: %s" % JSON.stringify(quit_left)
		)
	for gone: String in ["Panel", "Play", "Quit", "Later", "Buried", "Lid"]:
		root.get_node(gone).queue_free()
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
	var unseen: Dictionary = await typing.choose({ "path": "/root/Panel/Option", "index": 1 })
	var expected: String = (
		"/root/Panel/Option is not visible (/root/Panel is hidden)"
		+ ", so its menu cannot be opened"
	)
	if not _says(unseen, expected) or option.selected != 0:
		_fail("a dropdown under a hidden panel names the panel: %s" % JSON.stringify(unseen))
	panel.visible = true
	var chosen: Dictionary = await typing.choose({ "path": "/root/Panel/Option", "index": 1 })
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
	var unseen: Dictionary = await input.click({ "path": "/root/World/Target" })
	if not _says(
		unseen, "/root/World/Target is not visible (/root/World is hidden), so nothing can"
	):
		_fail("a 3D node in a hidden world names the world: %s" % JSON.stringify(unseen))
	world.visible = true
	var reached: Dictionary = await input.click({ "path": "/root/World/Target" })
	if reached.get("landed") != true:
		_fail("and is clicked once the world is shown: %s" % JSON.stringify(reached))
	world.queue_free()
	await process_frame


## A card on its way out turns the pointer off for itself and everything in it, through
## mouse_behavior_recursive, leaving its button enabled and its mouse_filter as it was. By words,
## the next card's button saying the same is the one meant rather than a tie. By path, the leaving
## one is refused with the node that turned it off, where it answered landed false. Alone, it is
## refused by words too. Turned back on, the same button is pressed, so the refusal is the
## setting's.
func _check_a_card_that_turned_the_pointer_off() -> void:
	var leaving: Panel = Panel.new()
	leaving.name = "Leaving"
	leaving.position = Vector2(0, 0)
	leaving.size = Vector2(30, 30)
	leaving.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(leaving)
	var gone: Button = _button("GonePost", Vector2(2, 2), leaving)
	gone.text = "Post"
	var next: Panel = Panel.new()
	next.name = "Next"
	next.position = Vector2(32, 0)
	next.size = Vector2(30, 30)
	next.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(next)
	var post: Button = _button("NextPost", Vector2(2, 2), next)
	post.text = "Post"
	leaving.mouse_behavior_recursive = Control.MOUSE_BEHAVIOR_DISABLED
	await process_frame

	var by_words: Dictionary = await input.click({ "says": "Post" })
	var found: Dictionary = by_words.get("found", {})
	var picked: String = str(found.get("picked", ""))
	if (
		by_words.get("path") != "/root/Next/NextPost"
		or _presses("NextPost") != 1
		or _presses("GonePost") != 0
	):
		_fail(
			(
				"words on a card that turned the pointer off and on the next mean the next: %s"
				% JSON.stringify(by_words)
			)
		)
	elif not picked.ends_with("the other one on screen takes no pointer input"):
		_fail("and say why the leaving one was passed over: %s" % picked)

	var by_path: Dictionary = await input.click({ "path": "/root/Leaving/GonePost" })
	var why: String = (
		"/root/Leaving/GonePost takes no pointer input, since mouse_behavior_recursive"
		+ " is disabled on /root/Leaving"
	)
	if not _says(by_path, why) or _presses("GonePost") != 0:
		_fail(
			(
				"a button whose card turned the pointer off is refused, naming the card: %s"
				% JSON.stringify(by_path)
			)
		)

	next.queue_free()
	await process_frame
	var alone: Dictionary = await input.click({ "says": "Post" })
	if not _says(alone, why) or _presses("GonePost") != 0:
		_fail("and refused by its words when it is the only one: %s" % JSON.stringify(alone))

	leaving.mouse_behavior_recursive = Control.MOUSE_BEHAVIOR_INHERITED
	await process_frame
	var back: Dictionary = await input.click({ "path": "/root/Leaving/GonePost" })
	if back.get("landed") != true or _presses("GonePost") != 1:
		_fail("and pressed once the card turns the pointer back on: %s" % JSON.stringify(back))
	gone.queue_free()
	leaving.queue_free()
	await process_frame
