extends SceneTree
## Clicks by words on what a control draws as one of a list: a tab, a list entry, a tree row and a
## menu bar title. Each is pressed where the control draws it rather than at the control's middle,
## which is whichever item happens to sit there, and the answer names the one pressed. Each check
## first asserts that the middle is somewhere else, so a click at the middle fails it.
##
## Everything sits in the 64 by 64 viewport a script run with no window has, so the items are drawn
## small and unpadded.

const GdhInputCommands = preload("res://addons/gdharness_runtime/runtime_input.gd")
const GdhValues = preload("res://addons/gdharness_runtime/runtime_values.gd")

var failures: Array[String] = []
var input: GdhInputCommands = null
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

	await _check_tabs_by_their_titles()
	await _check_list_entries_by_their_words()
	await _check_tree_rows_by_their_words()
	await _check_a_menu_bar_title()

	host.queue_free()
	if failures.is_empty():
		print(JSON.stringify({ "ok": true }))
		quit(0)
		return
	printerr("\n".join(failures))
	quit(1)


func _fail(message: String) -> void:
	failures.append(message)


func _says(answer: Dictionary, words: String) -> bool:
	return answer.get("type") == "error" and str(answer.get("message", "")).contains(words)


func _small(control: Control, styles: Array[String]) -> void:
	control.add_theme_font_size_override("font_size", 4)
	for style: String in styles:
		control.add_theme_stylebox_override(style, StyleBoxEmpty.new())


## The item [param answer] says it pressed, or an empty map.
func _item_of(answer: Dictionary) -> Dictionary:
	var found: Dictionary = answer.get("found", {})
	return found.get("item", {})


## A tab is pressed where it is drawn, and named. A click on a tab's title pressed the middle of
## the bar, which was another tab or none, so the page asked for never opened. A tab scrolled off
## its bar is scrolled to first, and a disabled one is refused as a disabled button is.
func _check_tabs_by_their_titles() -> void:
	var tab_styles: Array[String] = [
		"tab_selected", "tab_unselected", "tab_hovered", "tab_disabled", "tab_focus",
	]
	var tabs: TabContainer = TabContainer.new()
	tabs.name = "Tabs"
	tabs.size = Vector2(64, 30)
	_small(tabs, tab_styles)
	for title: String in ["Ab", "Cd", "Ef", "Gh"]:
		var page: Control = Control.new()
		page.name = title
		tabs.add_child(page)
	root.add_child(tabs)
	await process_frame
	await process_frame
	var bar: TabBar = tabs.get_tab_bar()
	var middle: int = bar.get_tab_idx_at_point(bar.size * 0.5)
	if middle != -1 or bar.get_tab_rect(3).end.x >= bar.size.x * 0.5:
		_fail("the tabs should end before the bar's middle: %d, %s" % [middle, bar.get_tab_rect(3)])
	# Over the bar's empty half, so the tab is judged where it is drawn: judged at the bar's middle,
	# it was covered and refused.
	var cover: Panel = Panel.new()
	cover.name = "Cover"
	cover.position = bar.global_position + Vector2(bar.size.x * 0.5 - 2, 0)
	cover.size = Vector2(bar.size.x * 0.5 + 2, bar.size.y)
	root.add_child(cover)
	await process_frame
	var clicked: Dictionary = await input.click({ "says": "Ef" })
	var item: Dictionary = _item_of(clicked)
	if (
		tabs.current_tab != 2
		or clicked.get("landed") != true
		or item.get("kind") != "tab"
		or item.get("index") != 2
		or item.get("says") != "Ef"
	):
		_fail(
			(
				"a tab is pressed where it is drawn, and named: %d, %s"
				% [tabs.current_tab, JSON.stringify(clicked)]
			)
		)
	tabs.set_tab_disabled(3, true)
	var disabled: Dictionary = await input.click({ "says": "Gh" })
	if (
		tabs.current_tab != 2
		or not _says(disabled, 'the tab "Gh" of %s is disabled' % bar.get_path())
	):
		_fail("a disabled tab is refused: %s" % JSON.stringify(disabled))
	# A number arrives from JSON as a float, and the refusal quoted 5 back as 5.0.
	var past: Dictionary = await input.click({ "says": "Ef", "index": 5.0 })
	var only: String = (
		'index 5 picks nothing: the only match on screen saying "Ef" is index 0: 0 %s ("Ef")'
	)
	if tabs.current_tab != 2 or not _says(past, only % bar.get_path()):
		_fail("an index past the matches is refused as the number given: %s" % JSON.stringify(past))
	tabs.queue_free()
	cover.queue_free()

	var strip: TabBar = TabBar.new()
	strip.name = "Strip"
	strip.size = Vector2(64, 10)
	_small(strip, tab_styles)
	for number: int in 12:
		strip.add_tab("Tab number %d" % number)
	root.add_child(strip)
	await process_frame
	await process_frame
	if strip.get_tab_idx_at_point(strip.get_tab_rect(11).get_center()) == 11:
		_fail("the last tab should start off the bar: %s" % strip.get_tab_rect(11))
	var far: Dictionary = await input.click({ "says": "Tab number 11" })
	if (
		strip.current_tab != 11
		or far.get("scrolled_into_view") != true
		or _item_of(far).get("index") != 11
	):
		_fail(
			(
				"a tab off the bar is scrolled to and pressed: %d, %s"
				% [strip.current_tab, JSON.stringify(far)]
			)
		)
	strip.queue_free()
	await process_frame


## A list entry is pressed where it is drawn, and one scrolled out of the list, below it or above
## it, after the list scrolls to it.
func _check_list_entries_by_their_words() -> void:
	var list: ItemList = ItemList.new()
	list.name = "Entries"
	list.size = Vector2(64, 24)
	_small(list, ["panel", "focus", "selected", "selected_focus", "hovered"])
	for words: String in ["Ij", "Kl", "Mn", "Op", "Qr", "St", "Uv", "Wx"]:
		var _at: int = list.add_item(words)
	root.add_child(list)
	await process_frame
	await process_frame
	var middle: int = list.get_item_at_position(list.size * 0.5, true)
	if middle == 0 or list.get_item_at_position(Vector2(4, 22), true) == 7:
		_fail(
			"the list's middle should be off its first entry and its last out of view: %d" % middle
		)
	var near: Dictionary = await input.click({ "says": "Ij" })
	if (
		not list.is_selected(0)
		or _item_of(near).get("kind") != "item"
		or _item_of(near).get("index") != 0
	):
		_fail("a list entry is pressed where it is drawn: %s" % JSON.stringify(near))
	var far: Dictionary = await input.click({ "says": "Wx" })
	if not list.is_selected(7) or far.get("scrolled_into_view") != true:
		_fail("an entry out of view is scrolled to and pressed: %s" % JSON.stringify(far))
	var back: Dictionary = await input.click({ "says": "Ij" })
	if not list.is_selected(0) or back.get("scrolled_into_view") != true:
		_fail("and one scrolled off the top is scrolled back to: %s" % JSON.stringify(back))
	list.queue_free()
	await process_frame


## A tree row is pressed on the cell saying the words, and a row below the fold after the tree
## scrolls to it, which it places by the scroll it last drew with.
func _check_tree_rows_by_their_words() -> void:
	var tree: Tree = Tree.new()
	tree.name = "Rows"
	tree.size = Vector2(64, 60)
	tree.columns = 2
	tree.hide_root = true
	_small(tree, ["panel", "focus", "selected", "selected_focus", "cursor", "cursor_unfocused"])
	var top: TreeItem = tree.create_item()
	var rows: Array[TreeItem] = []
	var firsts: Array[String] = [
		"Ab", "Cd", "Ef", "Gh", "Ij", "Kl", "Mn", "Op", "Qr", "St", "Uv", "Wx",
	]
	var seconds: Array[String] = [
		"Ba", "Dc", "Fe", "Hg", "Ji", "Lk", "Nm", "Po", "Rq", "Ts", "Vu", "Xw",
	]
	for at: int in firsts.size():
		var row: TreeItem = tree.create_item(top)
		row.set_text(0, firsts[at])
		row.set_text(1, seconds[at])
		rows.append(row)
	root.add_child(tree)
	await process_frame
	await process_frame
	var centre: Vector2 = tree.size * 0.5
	if tree.get_item_at_position(centre) == rows[0] or tree.get_column_at_position(centre) == 0:
		_fail("the tree's middle should be off the first row's first cell: %s" % centre)
	var cell: Dictionary = await input.click({ "says": "Ab" })
	var named: Dictionary = _item_of(cell)
	if (
		tree.get_selected() != rows[0]
		or tree.get_selected_column() != 0
		or named.get("kind") != "row"
		or named.get("column") != 0
		or named.get("says") != "Ab  Ba"
	):
		_fail("a tree row is pressed on the cell saying the words: %s" % JSON.stringify(cell))
	if tree.get_item_at_position(tree.get_item_area_rect(rows[11]).get_center()) == rows[11]:
		_fail("the last row should start out of view: %s" % tree.get_item_area_rect(rows[11]))
	var low: Dictionary = await input.click({ "says": "Wx" })
	if tree.get_selected() != rows[11] or low.get("scrolled_into_view") != true:
		_fail("a row out of view is scrolled to and pressed: %s" % JSON.stringify(low))
	tree.queue_free()
	await process_frame


## A menu bar title opens its own menu. The bar keeps where it draws each title to itself, so the
## place is worked out as the engine works it out, and this is what holds that to the engine.
func _check_a_menu_bar_title() -> void:
	var menus: MenuBar = MenuBar.new()
	menus.name = "Menus"
	menus.size = Vector2(64, 10)
	_small(menus, ["normal", "hover", "pressed", "hover_pressed", "disabled"])
	for title: String in ["Hj", "Kp", "Mq"]:
		var menu: PopupMenu = PopupMenu.new()
		menu.name = title
		menu.add_item("an item of " + title)
		menus.add_child(menu)
	root.add_child(menus)
	await process_frame
	await process_frame
	var clicked: Dictionary = await input.click({ "says": "Kp" })
	var opened: Array[bool] = []
	for menu: int in menus.get_menu_count():
		opened.append(menus.get_menu_popup(menu).visible)
	if opened[0] or not opened[1] or opened[2] or _item_of(clicked).get("kind") != "menu":
		_fail(
			"a menu bar title opens its own menu: %s, %s" % [str(opened), JSON.stringify(clicked)]
		)
	menus.get_menu_popup(1).hide()
	menus.queue_free()
	await process_frame
