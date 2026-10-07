extends SceneTree

## Clicks, typing and menu choices on the controls whose answers were wrong: a disabled button, a
## paused game, a field in a dialog, a read-only field, a menu that rebuilds itself or will not take
## the press, a control that has to be scrolled to, and a 3D node behind the interface. Each refusal
## is checked beside the call that works, so a check refusing everything fails too.
##
## Everything sits in the 64 by 64 viewport a game with no window has.

const Checked = preload("checked.gd")
const InputCommands = preload("res://addons/gdharness_runtime/runtime_input.gd")
const Says = preload("res://addons/gdharness_runtime/runtime_says.gd")
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
	await _check_choosing_by_what_it_says()
	await _check_scrolling_to_a_control()
	await _check_a_control_in_a_subviewport()
	await _check_the_world_behind_the_interface()
	await _check_words_nobody_can_click()
	await _check_words_in_a_rich_label()
	await _check_a_word_inside_a_sentence()
	await _check_a_word_said_inside_other_words()
	await _check_an_item_in_an_open_menu()
	await _check_a_field_by_its_placeholder()
	await _check_words_held_together_by_a_space_that_does_not_break()
	await _check_a_dialog_over_a_dialog()
	await _check_a_dialog_under_a_clipping_container()

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


## An item is chosen by the rules every `says` matches words by, after its whole words.
##
## A menu holding "Leave the hall" refused "Leave*" as no such item, where a click, a find and a
## wait all take the glob. Each rule is checked by what it chooses: a plain word as a contains, the
## whole words ahead of an item that contains them, an enabled item ahead of a disabled one; and a
## glob or alternatives matching two items equally are refused with both named.
func _check_choosing_by_what_it_says() -> void:
	var doors: MenuButton = MenuButton.new()
	doors.name = "Doors"
	root.add_child(doors)
	var menu: PopupMenu = doors.get_popup()
	for item: String in ["The guide", "Leave", "Leave the hall", "Leave quietly"]:
		menu.add_item(item)
	menu.set_item_disabled(3, true)
	await process_frame
	var fired: Array[int] = []
	var heard: Callable = func(at: int) -> void: fired.append(at)
	Checked.done(menu.index_pressed.connect(heard) as Error, "hearing the item pressed")
	# Refused first, on a menu never opened before, and then chosen from.
	var missing: Dictionary = await typing.choose({"path": "/root/Doors", "text": "Stay"})
	if not _says(missing, "has no such item"):
		_fail("words no item says are refused: %s" % JSON.stringify(missing))
	for case: Array in [["hall", 2], ["Leave", 1], ["quietly|hall", 2], ["The*", 0]]:
		fired.clear()
		var chosen: Dictionary = await typing.choose({"path": "/root/Doors", "text": case[0]})
		if chosen.get("index") != case[1] or fired != [case[1]]:
			_fail("%s chooses item %d: %s %s" % [case[0], case[1], JSON.stringify(chosen), fired])
	var ties: Dictionary[String, String] = {
		"Leave*": "1: Leave, 2: Leave the hall",
		"guide|hall": "0: The guide, 2: Leave the hall",
	}
	for tie: String in ties:
		fired.clear()
		var tied: Dictionary = await typing.choose({"path": "/root/Doors", "text": tie})
		var named: String = str(tied.get("message", ""))
		if not _says(tied, "items that say") or not fired.is_empty() or menu.visible:
			_fail("%s matching two items chooses neither: %s %s" % [tie, JSON.stringify(tied), fired])
		elif not named.contains(ties[tie]):
			_fail("and names both: %s" % named)
	# A refusal is followed by the call it asks for, on the same menu.
	fired.clear()
	var retried: Dictionary = await typing.choose({"path": "/root/Doors", "text": "Leave the hall"})
	if retried.get("index") != 2 or fired != [2]:
		_fail("a choice after a refusal is taken: %s %s" % [JSON.stringify(retried), fired])
	doors.queue_free()
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


## Words that are part of a rich label's line are pressed where they are drawn, so a link among them
## is the one pressed. #885: a line naming two people, each a link, was pressed in its middle, which
## was on the second name, and the game opened the wrong page. Here the line's middle is on plain
## words between the two links, so a press there reaches neither. A pattern names no one place, and
## the answer says the press went to the middle.
func _check_words_in_a_rich_label() -> void:
	var line: RichTextLabel = RichTextLabel.new()
	line.name = "Dispatch"
	line.bbcode_enabled = true
	line.autowrap_mode = TextServer.AUTOWRAP_OFF
	line.add_theme_font_size_override("normal_font_size", 4)
	line.position = Vector2(0, 20)
	line.size = Vector2(64, 12)
	line.text = "[url=first]Ab[/url] and a great deal more [url=second]Cd[/url]"
	root.add_child(line)
	await process_frame
	await process_frame
	if line.get_line_count() != 1 or line.get_content_width() > line.size.x:
		_fail(
			(
				"the line should fit the label on one line for this to mean anything: %d lines, %d wide"
				% [line.get_line_count(), line.get_content_width()]
			)
		)
	for case: Array in [["Ab", "first"], ["cd", "second"]]:
		var clicked: Dictionary = await input.click({"says": case[0]})
		var found: Dictionary = clicked.get("found", {})
		if (
			clicked.get("link_pressed") != true
			or clicked.get("link_meta") != case[1]
			or found.get("pressedOn") != "the words"
		):
			_fail("words in a rich label are pressed where they are drawn: %s" % JSON.stringify(clicked))
	var patterned: Dictionary = await input.click({"says": "Ab*Cd"})
	var told: Dictionary = patterned.get("found", {})
	if (
		told.get("pressedOn") != "the middle of the label"
		or not str(told.get("note", "")).contains("so the press went to its middle")
		or patterned.get("link_pressed") != false
		or patterned.has("link_meta")
	):
		_fail("a pattern is pressed in the middle and says so: %s" % JSON.stringify(patterned))
	# #913: a link with an empty meta, which given as the meta alone read as no link pressed.
	line.text = "[url=]Ab[/url] and a great deal more [url=second]Cd[/url]"
	await process_frame
	var bare: Dictionary = await input.click({"says": "Ab"})
	if bare.get("link_pressed") != true or bare.get("link_meta") != "":
		_fail("a link with an empty meta is said to be pressed: %s" % JSON.stringify(bare))
	line.queue_free()
	await process_frame


## A word inside a sentence is not pressed for a control saying exactly that word which is hidden.
## #895: a tab reading "Out" sat in a collapsed drawer, and a click on it pressed a dispatch saying
## somebody "fell out in the hall". Refused, naming both, and pressed when the caller asks for the
## sentence by index; with nothing else saying the word, pressed and said to be part of more.
func _check_a_word_inside_a_sentence() -> void:
	var tab: Button = _button("Tab", Vector2(2, 2), root, "Out")
	tab.visible = false
	var line: Button = _button("Line", Vector2(2, 20), root, "they fell out")
	line.size = Vector2(40, 10)
	await process_frame
	var refused: Dictionary = await input.click({"says": "Out"})
	var said: String = str(refused.get("message", ""))
	if (
		not _says(refused, 'no control on screen says exactly "Out"')
		or not said.contains("/root/Line")
		or not said.contains("/root/Tab, hidden")
		or not said.contains("pass index 0")
		or _presses("Line") != 0
	):
		_fail(
			"a word in a sentence is not pressed for a hidden control saying it: %s" % JSON.stringify(refused)
		)
	var asked: Dictionary = await input.click({"says": "Out", "index": 0})
	var found: Dictionary = asked.get("found", {})
	if _presses("Line") != 1 or found.get("partOf") != "they fell out":
		_fail("and is pressed when asked for by index, said to be part of more: %s" % JSON.stringify(asked))
	tab.queue_free()
	await process_frame
	var alone: Dictionary = await input.click({"says": "Out"})
	var alone_found: Dictionary = alone.get("found", {})
	if _presses("Line") != 2 or alone_found.get("partOf") != "they fell out":
		_fail(
			(
				"with nothing else saying it, the sentence is pressed and said to be part of more: %s"
				% JSON.stringify(alone)
			)
		)
	line.queue_free()
	await process_frame


## The screen #895 was reported from again on 1.1.46, built up from what was on it and taken away one
## piece at a time. No control's text said "Out": the tab saying it was a picture named for a player
## who cannot see it, once hidden in a drawer and once on the rail as "Open Out", beside cards saying
## "Scout, 90" and a line saying what "is out there". The card was pressed, and spent the game's
## silver.
func _check_a_word_said_inside_other_words() -> void:
	var drawer: Button = _button("DrawerOut", Vector2(2, 2), root)
	drawer.accessibility_name = "Out"
	drawer.visible = false
	var rail: Button = _button("RailOut", Vector2(2, 2), root)
	rail.accessibility_name = "Open Out"
	var card: Button = _button("Look", Vector2(20, 2), root, "Scout, 90")
	var there: Label = Label.new()
	there.name = "There"
	there.text = "what is out there"
	there.add_theme_font_size_override("font_size", 4)
	there.position = Vector2(2, 30)
	root.add_child(there)
	await process_frame

	var refused: Dictionary = await input.click({"says": "Out"})
	var said: String = str(refused.get("message", ""))
	if (
		not _says(refused, 'no control on screen says exactly "Out"')
		or not said.contains("/root/RailOut")
		or not said.contains("/root/DrawerOut, hidden")
		or _presses("RailOut") + _presses("Look") != 0
	):
		_fail(
			"a picture named for part of the words stands in for the hidden one: %s" % JSON.stringify(refused)
		)
	var asked: Dictionary = await input.click({"says": "Out", "index": 0})
	if _presses("RailOut") != 1 or _presses("Look") != 0:
		_fail("and is pressed by index, not the card: %s" % JSON.stringify(asked))

	drawer.queue_free()
	await process_frame
	var named: Dictionary = await input.click({"says": "Out"})
	var found: Dictionary = named.get("found", {})
	if _presses("RailOut") != 2 or _presses("Look") != 0 or found.get("partOf") != "Open Out":
		_fail("with nothing else saying it, the picture named for it is pressed: %s" % JSON.stringify(named))

	rail.queue_free()
	await process_frame
	var through: Dictionary = await input.click({"says": "Out"})
	if (
		not _says(through, "lets the pointer through")
		or not str(through.get("message", "")).contains("/root/There")
	):
		_fail(
			"a line the pointer passes through is not clicked for a word in it: %s" % JSON.stringify(through)
		)
	if _presses("Look") != 0:
		_fail("and the card saying Scout is not pressed in its place")

	there.queue_free()
	await process_frame
	var buried: Dictionary = await input.click({"says": "Out"})
	if not _says(buried, 'says "Out" as a word of its own') or not _says(buried, '"Scout, 90"'):
		_fail("words found only inside a longer word are refused: %s" % JSON.stringify(buried))
	var anyway: Dictionary = await input.click({"says": "Out", "index": 0})
	if _presses("Look") != 1:
		_fail("and pressed when asked for by index: %s" % JSON.stringify(anyway))
	card.queue_free()

	# Exact on screen in a control that takes clicks without being a button, beside a button saying
	# more. A heading letting the pointer through is passed over for the button, which the input
	# fixture holds with "Onward".
	var heading: Label = Label.new()
	heading.name = "Heading"
	heading.text = "Out"
	heading.mouse_filter = Control.MOUSE_FILTER_STOP
	heading.position = Vector2(2, 30)
	root.add_child(heading)
	_put("Beyond", Vector2(2, 2), root, "Out there")
	await process_frame
	var beside: Dictionary = await input.click({"says": "Out"})
	if not _says(beside, 'no button on screen says exactly "Out"') or _presses("Beyond") != 0:
		_fail("an exact match on screen that is not a button is named: %s" % JSON.stringify(beside))
	heading.queue_free()
	root.get_node("Beyond").queue_free()

	# A word starting a longer one is said, the way a plural says its singular.
	_put("Hire", Vector2(2, 2), root, "Recruits")
	await process_frame
	var plural: Dictionary = await input.click({"says": "Recruit"})
	if _presses("Hire") != 1:
		_fail("words starting a longer word are pressed: %s" % JSON.stringify(plural))
	root.get_node("Hire").queue_free()
	await process_frame


## An item of an open menu is drawn by the menu rather than held as a control, so a click by its
## words finds no control; the refusal names the menu and the call that chooses the item. #894: a
## wait was met on an item's words and the click after it was refused with no word of choose.
func _check_an_item_in_an_open_menu() -> void:
	var hall: MenuButton = MenuButton.new()
	hall.name = "Hall"
	root.add_child(hall)
	var menu: PopupMenu = hall.get_popup()
	for item: String in ["Stay", "Leave the hall"]:
		menu.add_item(item)
	await process_frame
	hall.show_popup()
	await process_frame
	var refused: Dictionary = await input.click({"says": "Leave the hall"})
	if not _says(refused, 'choose it with runtime_input choose, path /root/Hall and text "Leave the hall"'):
		_fail("an open menu's item is refused naming the menu and choose: %s" % JSON.stringify(refused))
	menu.hide()
	await process_frame
	var closed: Dictionary = await input.click({"says": "Leave the hall"})
	if _says(closed, "runtime_input choose"):
		_fail("and a closed menu is not named: %s" % JSON.stringify(closed))
	hall.queue_free()
	await process_frame


## An empty field draws its placeholder, and is found by it. #899: a search field was found by
## nothing it showed, and the click fell back to coordinates.
func _check_a_field_by_its_placeholder() -> void:
	var search: LineEdit = LineEdit.new()
	search.name = "Search"
	search.placeholder_text = "Search the reports"
	search.position = Vector2(2, 2)
	search.size = Vector2(60, 12)
	root.add_child(search)
	await process_frame
	var clicked: Dictionary = await input.click({"says": "Search the reports"})
	if clicked.get("path") != "/root/Search" or not search.has_focus():
		_fail("an empty field is clicked by its placeholder: %s" % JSON.stringify(clicked))
	search.text = "hall"
	await process_frame
	var filled: Dictionary = await input.click({"says": "Search the reports"})
	if not _says(filled, "no control on screen"):
		_fail("and not once it holds text, which is drawn instead: %s" % JSON.stringify(filled))
	search.queue_free()
	await process_frame


## Any space a game draws between words is the space a caller types. #906: a name kept on one line
## with a non-breaking space was not found by the name typed with a plain one, while the screen
## showed exactly those words. Each separator, a link inside a line pressed where it is drawn, and a
## button saying the words exactly, which ranks as the exact match it is.
func _check_words_held_together_by_a_space_that_does_not_break() -> void:
	for code: int in [0x00A0, 0x1680, 0x2000, 0x2007, 0x200A, 0x202F, 0x205F, 0x3000]:
		if not Says.matches("Ab%sCd" % String.chr(code), "ab cd"):
			_fail("a typed space matches U+%04X" % code)
	if Says.matches("Ab%sCd" % String.chr(0x200B), "ab cd"):
		_fail("and a zero-width space, which draws no space, is not one")
	# A space stands for any one character only while a text is sorted out cheaply; what matches is
	# still decided on the words spaced.
	var nbsp: String = String.chr(0x00A0)
	for case: Array in [
		["AbXCd", "ab cd", false],
		["Ab Cd", "ab cd", true],
		["Ab%sCd and more" % nbsp, "ab cd*", true],
		["AbXCd and more", "ab cd*", false],
		["first line\nsecond words", "second words", true],
		["Two\nlines", "two\\nlines", true],
		["We lost%sthe hall" % nbsp, "won|lost the", true],
		["We lostXthe hall", "won|lost the", false],
	]:
		var said: String = case[0]
		var wanted: String = case[1]
		var expected: bool = case[2]
		if Says.matches(said, wanted) != expected:
			_fail("%s says %s: %s" % [JSON.stringify(said), JSON.stringify(wanted), not expected])

	var line: RichTextLabel = RichTextLabel.new()
	line.name = "Dossier"
	line.bbcode_enabled = true
	line.autowrap_mode = TextServer.AUTOWRAP_OFF
	line.add_theme_font_size_override("normal_font_size", 4)
	line.position = Vector2(0, 20)
	line.size = Vector2(64, 12)
	line.text = "[url=named]Ab%sCd[/url] and a great deal more" % String.chr(0x00A0)
	root.add_child(line)
	await process_frame
	await process_frame
	var named: Dictionary = await input.click({"says": "Ab Cd"})
	var found: Dictionary = named.get("found", {})
	if (
		named.get("link_pressed") != true
		or named.get("link_meta") != "named"
		or found.get("pressedOn") != "the words"
	):
		_fail(
			(
				"a name held by a non-breaking space is found and pressed by its typed words: %s"
				% JSON.stringify(named)
			)
		)
	line.queue_free()

	var held: Button = _button("Held", Vector2(2, 2), root, "Leave%snow" % String.chr(0x202F))
	_put("Loose", Vector2(34, 2), root, "Leave now and then")
	await process_frame
	var exact: Dictionary = await input.click({"says": "leave now"})
	if exact.get("path") != "/root/Held" or _presses("Held") != 1:
		_fail(
			"and words held together say them exactly, over a button saying more: %s" % JSON.stringify(exact)
		)
	held.queue_free()
	root.get_node("Loose").queue_free()
	await process_frame


## A dialog a clipping container holds is its own viewport, and the container is not around it.
##
## The dialog is a window embedded in the root, so its buttons are placed in the dialog's space and
## drawn wherever the dialog is. With a clipping control above the dialog, a click by the dialog's
## words judged each button against that control's box in the root's space, found it outside, and
## refused it as off the screen. The container here scrolls as well, and a click inside the dialog
## must not scroll it.
func _check_a_dialog_under_a_clipping_container() -> void:
	var holder: ScrollContainer = ScrollContainer.new()
	holder.name = "Holder"
	holder.position = Vector2(50, 50)
	holder.size = Vector2(10, 10)
	root.add_child(holder)
	var inside: Control = Control.new()
	inside.name = "Inside"
	inside.custom_minimum_size = Vector2(10, 100)
	holder.add_child(inside)
	var asking: AcceptDialog = AcceptDialog.new()
	asking.name = "Asking"
	inside.add_child(asking)
	_put("Leave", Vector2(4, 4), asking, "Leave it")
	asking.popup(Rect2i(0, 0, 40, 40))
	await process_frame
	await process_frame
	var clicked: Dictionary = await input.click({"says": "Leave it"})
	if clicked.get("path") != "/root/Holder/Inside/Asking/Leave" or _presses("Leave") != 1:
		_fail("a dialog's button is clicked wherever the dialog sits: %s" % JSON.stringify(clicked))
	if holder.scroll_vertical != 0:
		_fail("and the container the dialog sits under is not scrolled: %d" % holder.scroll_vertical)

	# Below the fold of a list the dialog holds, where the click has to work out where scrolling
	# will bring it, by the dialog's own containers alone.
	var list: ScrollContainer = ScrollContainer.new()
	list.name = "List"
	list.position = Vector2(2, 16)
	list.size = Vector2(30, 14)
	asking.add_child(list)
	var column: VBoxContainer = VBoxContainer.new()
	column.name = "Column"
	list.add_child(column)
	var spacer: Control = Control.new()
	spacer.custom_minimum_size = Vector2(10, 40)
	column.add_child(spacer)
	_put("Further", Vector2.ZERO, column, "Further")
	# Scrolled already, so a scroll it was wrongly asked for would move it: at the top, asking it to
	# show something above and left of it changes nothing and would hide the fault.
	holder.scroll_vertical = 40
	await process_frame
	await process_frame
	var further: Dictionary = await input.click({"says": "Further"})
	if further.get("path") != "/root/Holder/Inside/Asking/List/Column/Further" or _presses("Further") != 1:
		_fail("a button below the dialog's own fold is clicked: %s" % JSON.stringify(further))
	if list.scroll_vertical == 0 or holder.scroll_vertical != 40:
		var scrolls: Array[int] = [list.scroll_vertical, holder.scroll_vertical]
		_fail("by scrolling the dialog's list and not the container outside: %d, %d" % scrolls)
	asking.hide()
	holder.queue_free()
	await process_frame

	# The engine's own confirmation, borderless and centred, pressed by its words through its own
	# buttons: the shape the report described, which clicks with nothing clipping above it too.
	var page: Control = Control.new()
	page.name = "Page"
	page.size = Vector2(64, 64)
	root.add_child(page)
	var confirm: ConfirmationDialog = ConfirmationDialog.new()
	confirm.name = "Confirm"
	confirm.borderless = true
	confirm.ok_button_text = "Go ahead"
	confirm.cancel_button_text = "Leave it"
	var small: Theme = Theme.new()
	small.default_font_size = 4
	confirm.theme = small
	page.add_child(confirm)
	confirm.popup_centered(Vector2i(40, 30))
	await process_frame
	await process_frame
	var cancelled: Array[int] = [0]
	var count_cancel: Callable = func() -> void: cancelled[0] += 1
	Checked.done(confirm.canceled.connect(count_cancel) as Error, "counting the confirmation's cancel")
	var left: Dictionary = await input.click({"says": "Leave it"})
	if cancelled[0] != 1:
		_fail("the confirmation's own cancel is pressed by its words: %s" % JSON.stringify(left))
	page.queue_free()
	await process_frame

	# Words in a dialog a button holds are the dialog's: a label there is not a way to press the
	# button the dialog was added under, which is in another viewport.
	var outer: Button = _button("Outer", Vector2(50, 2), root, "")
	var note: AcceptDialog = AcceptDialog.new()
	note.name = "Note"
	outer.add_child(note)
	var words: Label = Label.new()
	words.name = "Words"
	words.text = "Answer me"
	words.mouse_filter = Control.MOUSE_FILTER_STOP
	words.position = Vector2(4, 4)
	words.size = Vector2(20, 10)
	note.add_child(words)
	note.popup(Rect2i(0, 0, 40, 40))
	await process_frame
	await process_frame
	var answered: Dictionary = await input.click({"says": "Answer me"})
	if answered.get("path") != "/root/Outer/Note/Words" or _presses("Outer") != 0:
		_fail("words in a dialog a button holds do not press that button: %s" % JSON.stringify(answered))
	note.hide()
	outer.queue_free()
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
