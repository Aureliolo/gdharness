extends SceneTree

## Clicks, typing and menu choices on the controls whose answers were wrong: a disabled button, a
## paused game, a field in a dialog, a read-only field, a menu that rebuilds itself or will not take
## the press, a control that has to be scrolled to, and a 3D node behind the interface. Each refusal
## is checked beside the call that works, so a check refusing everything fails too.
##
## Everything sits in the 64 by 64 viewport a game with no window has.

const Checked = preload("checked.gd")
const InputCommands = preload("res://addons/gdharness_runtime/runtime_input.gd")
const Typing = preload("res://addons/gdharness_runtime/runtime_typing.gd")
const Values = preload("res://addons/gdharness_runtime/runtime_values.gd")


## Counts presses that reach the game's own input past the interface.
class Unhandled:
	extends Node

	var presses: int = 0

	func _unhandled_input(event: InputEvent) -> void:
		var button: InputEventMouseButton = event as InputEventMouseButton
		if button != null and button.pressed:
			presses += 1


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

	await _check_a_button_that_presses_nothing()
	await _check_typing_where_the_keys_go()
	await _check_choosing()
	await _check_scrolling_to_a_control()
	await _check_a_control_in_a_subviewport()
	await _check_the_world_behind_the_interface()
	await _check_words_nobody_can_click()
	await _check_a_dialog_over_a_dialog()

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


## A small flat button, so four of them fit in the viewport a game with no window has.
func _button(named: String, at: Vector2, parent: Node, words: String = "") -> Button:
	var made: Button = Button.new()
	made.name = named
	made.text = words
	made.flat = true
	made.clip_text = true
	made.add_theme_font_size_override("font_size", 4)
	made.custom_minimum_size = Vector2(10, 10)
	made.position = at
	made.size = Vector2(10, 10)
	parent.add_child(made)
	Checked.done(made.pressed.connect(_count.bind(named)) as Error, "counting presses of %s" % named)
	return made


## [method _button] for one nothing is asked of afterwards.
func _put(named: String, at: Vector2, parent: Node, words: String = "") -> void:
	var _made: Button = _button(named, at, parent, words)


func _says(answer: Dictionary, words: String) -> bool:
	return answer.get("type") == "error" and str(answer.get("message", "")).contains(words)


## A disabled button and a game that is paused: the pointer reaches the button and the press does
## nothing, which answered landed. Refused now, beside the same button pressed when it can be.
func _check_a_button_that_presses_nothing() -> void:
	var off: Button = _button("Off", Vector2(2, 2), root, "Go")
	off.disabled = true
	var on: Button = _button("On", Vector2(34, 2), root, "Go")
	await process_frame

	var refused: Dictionary = await input.click({"path": "/root/Off"})
	if not _says(refused, "is disabled") or _presses("Off") != 0:
		_fail("a disabled button is refused: %s" % JSON.stringify(refused))
	# By its words, the enabled one of the two is the one meant, rather than a tie.
	var by_words: Dictionary = await input.click({"says": "Go"})
	if by_words.get("path") != "/root/On" or _presses("On") != 1:
		_fail("words on a disabled and an enabled button mean the enabled one: %s" % JSON.stringify(by_words))

	paused = true
	var held: Dictionary = await input.click({"path": "/root/On"})
	paused = false
	if not _says(held, "the game is paused") or _presses("On") != 1:
		_fail("a button that does not run while the game is paused is refused: %s" % JSON.stringify(held))
	var again: Dictionary = await input.click({"path": "/root/On"})
	if again.get("landed") != true or _presses("On") != 2:
		_fail("and pressed once the game runs: %s" % JSON.stringify(again))
	on.process_mode = Node.PROCESS_MODE_DISABLED
	var stopped: Dictionary = await input.click({"path": "/root/On"})
	on.process_mode = Node.PROCESS_MODE_INHERIT
	if not _says(stopped, "has its processing disabled") or _presses("On") != 2:
		_fail("a button whose processing is off is refused as that: %s" % JSON.stringify(stopped))
	off.queue_free()
	on.queue_free()
	await process_frame


## Keys go to the field a focused dialog holds, and the answer says that field; a read-only field is
## refused; a field that leaves the tree on Enter is still named.
func _check_typing_where_the_keys_go() -> void:
	var outside: LineEdit = LineEdit.new()
	outside.name = "Outside"
	root.add_child(outside)
	outside.grab_focus()
	var box: AcceptDialog = AcceptDialog.new()
	box.name = "Box"
	root.add_child(box)
	var inside: LineEdit = LineEdit.new()
	inside.name = "Inside"
	box.add_child(inside)
	box.popup(Rect2i(0, 0, 60, 60))
	await process_frame
	inside.grab_focus()
	inside.edit()
	await process_frame
	var typed: Dictionary = typing.inject_text({"text": "ab"})
	if typed.get("into") != str(inside.get_path()) or typed.get("holds") != "ab" or inside.text != "ab":
		_fail("typing says the dialog's field it went into: %s" % JSON.stringify(typed))
	if outside.text != "":
		_fail("and nothing lands in the field behind it: %s" % outside.text)
	box.hide()
	box.queue_free()

	for field: Control in [LineEdit.new(), TextEdit.new()]:
		field.name = "Fixed"
		field.set("editable", false)
		field.set("text", "fixed")
		root.add_child(field)
		field.grab_focus()
		await process_frame
		var shut: Dictionary = typing.inject_text({"text": "x", "replace": true})
		if not _says(shut, "is read-only") or field.get("text") != "fixed":
			_fail("a read-only %s is refused: %s" % [field.get_class(), JSON.stringify(shut)])
		field.queue_free()
		await process_frame

	# Named before the keys: its Enter takes it out of the tree, which has no path to give after.
	var leaving: LineEdit = LineEdit.new()
	leaving.name = "Leaving"
	root.add_child(leaving)
	var gone: Callable = func(_said: String) -> void: root.remove_child(leaving)
	Checked.done(leaving.text_submitted.connect(gone) as Error, "taking the field away on Enter")
	leaving.grab_focus()
	leaving.edit()
	await process_frame
	var submitted: Dictionary = typing.inject_text({"text": "Ada\n"})
	if submitted.get("into") != "/root/Leaving" or leaving.is_inside_tree():
		_fail("a field that leaves on Enter is named: %s" % JSON.stringify(submitted))
	leaving.free()
	outside.queue_free()
	await process_frame


func _rebuild(menu: PopupMenu) -> void:
	menu.clear()
	menu.add_item("zero")
	menu.add_item("new first")
	menu.add_item("new second")


## A disabled dropdown, a project whose ui_accept is not Enter, a menu filled as it opens, and one
## that shuts before the press reaches it.
func _check_choosing() -> void:
	var option: OptionButton = OptionButton.new()
	option.name = "Option"
	option.add_item("one")
	option.add_item("two")
	root.add_child(option)
	option.disabled = true
	await process_frame
	var shut: Dictionary = await typing.choose({"path": "/root/Option", "index": 1})
	if not _says(shut, "is disabled") or option.selected != 0:
		_fail("a disabled dropdown is refused: %s" % JSON.stringify(shut))
	option.disabled = false
	option.visible = false
	var unseen: Dictionary = await typing.choose({"path": "/root/Option", "index": 1})
	if not _says(unseen, "is not visible") or option.selected != 0:
		_fail("and so is a hidden one: %s" % JSON.stringify(unseen))
	option.visible = true

	var saved: Array[InputEvent] = InputMap.action_get_events("ui_accept")
	InputMap.action_erase_events("ui_accept")
	var picked: Dictionary = await typing.choose({"path": "/root/Option", "index": 1})
	for event: InputEvent in saved:
		InputMap.action_add_event("ui_accept", event)
	if picked.get("type") != "chosen" or option.selected != 1:
		_fail("an item is chosen whatever ui_accept is bound to: %s" % JSON.stringify(picked))
	option.queue_free()

	var recent: MenuButton = MenuButton.new()
	recent.name = "Recent"
	root.add_child(recent)
	var menu: PopupMenu = recent.get_popup()
	menu.add_item("old first")
	menu.add_item("old second")
	Checked.done(recent.about_to_popup.connect(_rebuild.bind(menu)) as Error, "filling the menu as it opens")
	await process_frame
	var fired: Array[int] = []
	var heard: Callable = func(at: int) -> void: fired.append(at)
	Checked.done(menu.index_pressed.connect(heard) as Error, "hearing the item pressed")
	var fresh: Dictionary = await typing.choose({"path": "/root/Recent", "text": "new second"})
	if fresh.get("text") != "new second" or fired != [2]:
		_fail(
			(
				"an item of a menu filled as it opens is found in the new items: %s %s"
				% [JSON.stringify(fresh), fired]
			)
		)
	var stale: Dictionary = await typing.choose({"path": "/root/Recent", "text": "old second"})
	if not _says(stale, "has no such item") or menu.visible:
		_fail("an item only the old list had is refused and the menu shut again: %s" % JSON.stringify(stale))
	recent.queue_free()

	var closing: MenuButton = MenuButton.new()
	closing.name = "Closing"
	root.add_child(closing)
	var closing_menu: PopupMenu = closing.get_popup()
	closing_menu.add_item("only")
	var shut_it: Callable = func() -> void: closing_menu.hide.call_deferred()
	Checked.done(closing.about_to_popup.connect(shut_it) as Error, "shutting the menu as it opens")
	await process_frame
	var untaken: Dictionary = await typing.choose({"path": "/root/Closing", "index": 0})
	if not _says(untaken, "did not take it"):
		_fail("a press the menu did not take is not answered as chosen: %s" % JSON.stringify(untaken))
	closing.queue_free()
	await process_frame


func _scroller(named: String, at: Vector2, size: Vector2, parent: Node) -> VBoxContainer:
	var scroll: ScrollContainer = ScrollContainer.new()
	scroll.name = named
	scroll.position = at
	scroll.size = size
	parent.add_child(scroll)
	var column: VBoxContainer = VBoxContainer.new()
	column.name = "Column"
	scroll.add_child(column)
	var spacer: Control = Control.new()
	spacer.custom_minimum_size = Vector2(10, 100)
	column.add_child(spacer)
	return column


## A control scrolled to, one that nothing scrolls but the viewport cuts off, one in a list inside a
## list, and one that goes while it is being scrolled to.
func _check_scrolling_to_a_control() -> void:
	var column: VBoxContainer = _scroller("Scroll", Vector2(0, 0), Vector2(30, 30), root)
	_put("Below", Vector2.ZERO, column)
	await process_frame
	var below: Dictionary = await input.click({"path": "/root/Scroll/Column/Below"})
	if below.get("scrolled_into_view") != true or below.get("landed") != true or _presses("Below") != 1:
		_fail("a control below the fold is scrolled to and pressed: %s" % JSON.stringify(below))
	var shown: Dictionary = await input.click({"path": "/root/Scroll/Column/Below"})
	if shown.get("scrolled_into_view") != false or _presses("Below") != 2:
		_fail("and a second click scrolls nothing and says so: %s" % JSON.stringify(shown))
	root.get_node("Scroll").queue_free()

	# In view of what holds it and past the viewport, which nothing scrolls: the refusal is about the
	# window the game does not have, not a scroll that did not happen.
	var cut: VBoxContainer = _scroller("Cut", Vector2(40, 40), Vector2(40, 40), root)
	(cut.get_child(0) as Control).custom_minimum_size = Vector2(10, 25)
	_put("Past", Vector2.ZERO, cut)
	await process_frame
	var past: Dictionary = await input.click({"path": "/root/Cut/Column/Past"})
	if not _says(past, "has no window") or _says(past, "was scrolled"):
		_fail(
			"a control past the viewport is refused for the window, not the scroll: %s" % JSON.stringify(past)
		)
	root.get_node("Cut").queue_free()

	var outer: VBoxContainer = _scroller("Outer", Vector2(0, 0), Vector2(40, 40), root)
	var inner: VBoxContainer = _scroller("Inner", Vector2.ZERO, Vector2(30, 30), outer)
	(inner.get_parent() as Control).custom_minimum_size = Vector2(30, 30)
	_put("Deep", Vector2.ZERO, inner)
	# Room below the inner list, so the outer one can scroll past it: asked in the same frame as the
	# inner, the outer scrolls to where the button was before the inner moved it, which is far below.
	var after: Control = Control.new()
	after.custom_minimum_size = Vector2(10, 300)
	outer.add_child(after)
	await process_frame
	var deep: Dictionary = await input.click({"path": "/root/Outer/Column/Inner/Column/Deep"})
	if deep.get("landed") != true or _presses("Deep") != 1:
		_fail("a control in a list inside a list is scrolled to through both: %s" % JSON.stringify(deep))
	root.get_node("Outer").queue_free()

	var going: VBoxContainer = _scroller("Going", Vector2(0, 0), Vector2(30, 30), root)
	var doomed: Button = _button("Doomed", Vector2.ZERO, going)
	var scroll_bar: VScrollBar = (going.get_parent() as ScrollContainer).get_v_scroll_bar()
	# Held in a map rather than captured, since a lambda capturing a node that has gone is an engine
	# error each later scroll.
	var held: Dictionary = {"node": doomed}
	var free_it: Callable = func(_value: float) -> void:
		if is_instance_valid(held["node"]):
			var node: Node = held["node"]
			node.queue_free()
	Checked.done(scroll_bar.value_changed.connect(free_it) as Error, "freeing the button as it scrolls")
	await process_frame
	var vanished: Dictionary = await input.click({"path": "/root/Going/Column/Doomed"})
	if not _says(vanished, "was freed while it was being scrolled into view"):
		_fail(
			(
				"a control freed while it is scrolled to is refused, not left unanswered: %s"
				% JSON.stringify(vanished)
			)
		)
	root.get_node("Going").queue_free()
	await process_frame


## A control outside the SubViewport it is drawn in: the refusal names that viewport, its rect and
## the point in it, and nothing about a window.
func _check_a_control_in_a_subviewport() -> void:
	var shown: SubViewportContainer = SubViewportContainer.new()
	shown.name = "Shown"
	shown.size = Vector2(60, 60)
	root.add_child(shown)
	var inner: SubViewport = SubViewport.new()
	inner.name = "Inner"
	inner.size = Vector2i(60, 60)
	shown.add_child(inner)
	var aside: Button = _button("Aside", Vector2(70, 5), inner)
	await process_frame
	var refused: Dictionary = await input.click({"path": str(aside.get_path())})
	if not _says(refused, "outside the viewport of %s" % inner.get_path()) or _says(refused, "window"):
		_fail("a control outside its SubViewport is refused naming it: %s" % JSON.stringify(refused))
	var inside: Button = _button("Within", Vector2(5, 5), inner)
	await process_frame
	var taken: Dictionary = await input.click({"path": str(inside.get_path())})
	if taken.get("landed") != true or _presses("Within") != 1:
		_fail("and one inside it is pressed: %s" % JSON.stringify(taken))
	shown.queue_free()
	await process_frame


func _room(parent: Node) -> MeshInstance3D:
	var world: Node3D = Node3D.new()
	world.name = "World"
	parent.add_child(world)
	var camera: Camera3D = Camera3D.new()
	camera.position = Vector3(0, 0, 5)
	world.add_child(camera)
	camera.make_current()
	var target: MeshInstance3D = MeshInstance3D.new()
	target.name = "Target"
	target.mesh = BoxMesh.new()
	world.add_child(target)
	return target


## A 3D node under a HUD that lets the pointer pass, and one under a HUD that stops it; and a room in
## a SubViewport larger than what shows it.
func _check_the_world_behind_the_interface() -> void:
	var target: MeshInstance3D = _room(root)
	var hud: Control = Control.new()
	hud.name = "Hud"
	hud.size = Vector2(64, 64)
	hud.mouse_filter = Control.MOUSE_FILTER_PASS
	root.add_child(hud)
	var game: Unhandled = Unhandled.new()
	root.add_child(game)
	await process_frame
	var passed: Dictionary = await input.click({"path": str(target.get_path())})
	if passed.get("landed") != true or game.presses != 1:
		_fail("a click past a HUD letting the pointer pass lands: %s" % JSON.stringify(passed))
	hud.mouse_filter = Control.MOUSE_FILTER_STOP
	var stopped: Dictionary = await input.click({"path": str(target.get_path())})
	if stopped.get("landed") != false or game.presses != 1:
		_fail("and one under a HUD stopping it does not: %s" % JSON.stringify(stopped))
	hud.queue_free()
	root.get_node("World").queue_free()

	# Shown by a container smaller than the room: the room's middle is past the container's edge.
	var small: SubViewportContainer = SubViewportContainer.new()
	small.name = "Small"
	small.size = Vector2(20, 20)
	root.add_child(small)
	var view: SubViewport = SubViewport.new()
	view.size = Vector2i(60, 60)
	small.add_child(view)
	var hidden_target: MeshInstance3D = _room(view)
	await process_frame
	var missed: Dictionary = await input.click({"path": str(hidden_target.get_path())})
	if missed.get("landed") != false:
		_fail(
			(
				"a click past the edge of the container showing the room does not land: %s"
				% JSON.stringify(missed)
			)
		)
	small.size = Vector2(60, 60)
	await process_frame
	var reached: Dictionary = await input.click({"path": str(hidden_target.get_path())})
	if reached.get("landed") != true:
		_fail("and one inside it does: %s" % JSON.stringify(reached))
	# Moved so the room's middle is off the screen altogether: refused rather than sent nowhere.
	small.position = Vector2(40, 40)
	await process_frame
	var off: Dictionary = await input.click({"path": str(hidden_target.get_path())})
	if not _says(off, "on the screen, outside the viewport"):
		_fail("a room drawn past the screen is refused: %s" % JSON.stringify(off))
	small.queue_free()
	game.queue_free()
	await process_frame


## Words on a control under a hidden layer, off the side of the screen, or in a collapsed section
## are not on screen: counted apart, and not clicked.
func _check_words_nobody_can_click() -> void:
	var layer: CanvasLayer = CanvasLayer.new()
	layer.name = "Paused"
	layer.visible = false
	root.add_child(layer)
	_put("Quit", Vector2(2, 2), layer, "Quit")
	await process_frame
	var hidden: Dictionary = await input.click({"says": "Quit"})
	if not _says(hidden, "1 hidden control says it") or _presses("Quit") != 0:
		_fail("words under a hidden layer are hidden: %s" % JSON.stringify(hidden))
	layer.queue_free()

	_put("Far", Vector2(200, 2), root, "Tucked")
	var fold: Control = Control.new()
	fold.name = "Fold"
	fold.clip_contents = true
	# A section showing its top ten pixels, the button below them: nothing a click does brings it
	# into view, since only a ScrollContainer is scrolled.
	fold.position = Vector2(2, 40)
	fold.size = Vector2(20, 10)
	root.add_child(fold)
	_put("Folded", Vector2(0, 12), fold, "Tucked")
	await process_frame
	var tucked: Dictionary = await input.click({"says": "Tucked"})
	if not _says(tucked, "2 controls say it outside what the screen shows"):
		_fail("words off the screen or folded away are not on it: %s" % JSON.stringify(tucked))
	_put("Near", Vector2(34, 2), root, "Tucked")
	await process_frame
	var near: Dictionary = await input.click({"says": "Tucked"})
	if near.get("path") != "/root/Near" or _presses("Near") != 1:
		_fail("and the one on screen is clicked without a tie: %s" % JSON.stringify(near))
	for named: String in ["Far", "Fold", "Near"]:
		root.get_node(named).queue_free()
	await process_frame


## A second dialog over the first covers the first's button saying the same words.
func _check_a_dialog_over_a_dialog() -> void:
	var under: AcceptDialog = AcceptDialog.new()
	under.name = "Under"
	root.add_child(under)
	_put("Proceed", Vector2(4, 4), under, "Proceed")
	var over: AcceptDialog = AcceptDialog.new()
	over.name = "Over"
	over.exclusive = false
	root.add_child(over)
	_put("Proceed", Vector2(4, 4), over, "Proceed")
	under.popup(Rect2i(0, 0, 40, 40))
	over.popup(Rect2i(0, 0, 40, 40))
	await process_frame
	await process_frame
	var clicked: Dictionary = await input.click({"says": "Proceed"})
	if clicked.get("path") != "/root/Over/Proceed":
		_fail("the button of the dialog on top is the one meant: %s" % JSON.stringify(clicked))
	over.hide()
	under.hide()
	over.queue_free()
	under.queue_free()
	await process_frame
