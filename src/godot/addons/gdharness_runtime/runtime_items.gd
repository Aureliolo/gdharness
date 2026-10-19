extends RefCounted

## Where a control drawing a list draws one of its items, for a click by words: a tab, a list entry,
## a tree row or a menu bar title. Each is drawn by the control rather than held as a node, so a click
## on the control's path presses its middle, which is whichever item happens to sit there.

const GdhSays = preload("runtime_says.gd")
const GdhValues = preload("runtime_values.gd")
const GdhWords = preload("runtime_words.gd")


## Where [param control] draws [param item], one of [method GdhWords.items_of], in the control's own
## space, or an empty rectangle while it draws it nowhere a pointer reaches: a tab scrolled off its
## bar, an entry or a row scrolled out of its list, a menu bar the operating system draws. A tree
## row is the cell saying [param wanted] when one does, and the whole row otherwise.
##
## Each one checked against the control's own answer to which item is under a point, where it has
## one, since an entry's rectangle is kept in the list's unscrolled space and a row's is computed
## from the scroll as of the last draw.
static func item_rect(control: Control, item: Variant, wanted: String) -> Rect2:
	var bounds: Rect2 = Rect2(Vector2.ZERO, control.size)
	var bar: TabBar = control as TabBar
	if bar != null:
		var tab: int = item
		var placed: Rect2 = bar.get_tab_rect(tab)
		return placed if bar.get_tab_idx_at_point(placed.get_center()) == tab else Rect2()
	var list: ItemList = control as ItemList
	if list != null:
		var entry: int = item
		var scrolled: Vector2 = Vector2(list.get_h_scroll_bar().value, list.get_v_scroll_bar().value)
		var placed: Rect2 = list.get_item_rect(entry, false)
		placed.position -= scrolled
		var reached: bool = bounds.has_point(placed.get_center())
		return (
			placed if reached and list.get_item_at_position(placed.get_center(), true) == entry else Rect2()
		)
	var tree: Tree = control as Tree
	if tree != null:
		var row: TreeItem = item
		var column: int = tree_column(tree, row, wanted)
		var placed: Rect2 = tree.get_item_area_rect(row, column)
		var centre: Vector2 = placed.get_center()
		if not bounds.has_point(centre) or tree.get_item_at_position(centre) != row:
			return Rect2()
		return placed if column == -1 or tree.get_column_at_position(centre) == column else Rect2()
	var menus: MenuBar = control as MenuBar
	if menus != null and not menus.is_native_menu():
		var menu: int = item
		return _menu_title_rect(menus, menu)
	return Rect2()


## The column of [param row] whose cell says [param wanted], or -1 when only the row as a whole
## does, its cells read together.
static func tree_column(tree: Tree, row: TreeItem, wanted: String) -> int:
	for column: int in tree.columns:
		if GdhSays.matches(GdhWords.cell_says(tree, row, column), wanted):
			return column
	return -1


## [param item] of [param control] as an answer names it: what it is, its number where the control
## numbers its items, and what it says.
static func item_named(control: Control, item: Variant, says: String) -> Dictionary:
	if control is Tree:
		return {"kind": "row", "says": says}
	var kind: String = "tab" if control is TabBar else ("menu" if control is MenuBar else "item")
	return {"kind": kind, "index": item, "says": says}


## Where in [param control] to press for [param item], the one of its items a click by
## [param wanted] matched, as {"point", "scrolled"}, or a refusal saying why there is nowhere.
##
## Scrolled into the control's own view first when it is drawn nowhere yet, the way a player brings
## a tab or an entry into view before pressing it. A disabled item is refused as a disabled button
## is. A tree row is pressed on the cell saying the words, whose column goes into [param found].
static func in_view(
	scene: SceneTree, control: Control, node_path: String, item: Variant, wanted: String, found: Dictionary
) -> Dictionary:
	var named: Dictionary = found.get("item", {})
	var naming: String = 'the %s "%s" of %s' % [named.get("kind", "item"), named.get("says", ""), node_path]
	var index: int = item if item is int else -1
	var bar: TabBar = control as TabBar
	var list: ItemList = control as ItemList
	var menus: MenuBar = control as MenuBar
	if (
		(bar != null and bar.is_tab_disabled(index))
		or (list != null and list.is_item_disabled(index))
		or (menus != null and menus.is_menu_disabled(index))
	):
		return {"type": "error", "message": "%s is disabled, so clicking it presses nothing" % naming}
	var placed: Rect2 = item_rect(control, item, wanted)
	var scrolled: bool = false
	if placed.size == Vector2.ZERO:
		scrolled = _scroll_to(control, item)
		if scrolled:
			# A tree places its rows by the scroll it last drew with.
			await scene.process_frame
			var left: String = GdhValues.afterwards(control)
			if left != "in_tree" or (typeof(item) == TYPE_OBJECT and not is_instance_valid(item)):
				return {
					"type": "error",
					"message":
					"%s went while it was being scrolled into view, so nothing was clicked" % naming
				}
			placed = item_rect(control, item, wanted)
	if placed.size == Vector2.ZERO:
		var tried: String = " even scrolled to" if scrolled else ""
		return {
			"type": "error",
			"message": "%s is drawn nowhere a pointer reaches%s, so nothing was clicked" % [naming, tried]
		}
	var tree: Tree = control as Tree
	if tree != null:
		var row: TreeItem = item
		var column: int = tree_column(tree, row, wanted)
		if column != -1:
			named["column"] = column
	return {"point": placed.get_center(), "scrolled": scrolled}


## Where [param menus] draws the title of [param menu], worked out as the engine works it out,
## since the bar keeps it to itself: each title shaped in the bar's font, padded by its normal style
## and spaced by its separation, counting only the menus it shows.
static func _menu_title_rect(menus: MenuBar, menu: int) -> Rect2:
	var style: StyleBox = menus.get_theme_stylebox("normal")
	var separation: int = menus.get_theme_constant("h_separation")
	var offset: int = 0
	for before: int in menu:
		if not menus.is_menu_hidden(before):
			offset += int(_menu_title_size(menus, before, style).x + separation)
	var size: Vector2 = _menu_title_size(menus, menu, style)
	var x: float = menus.size.x - offset - size.x if menus.is_layout_rtl() else float(offset)
	return Rect2(Vector2(x, 0), size)


static func _menu_title_size(menus: MenuBar, menu: int, style: StyleBox) -> Vector2:
	var line: TextLine = TextLine.new()
	var _shaped: bool = line.add_string(
		menus.atr(menus.get_menu_title(menu)),
		menus.get_theme_font("font"),
		menus.get_theme_font_size("font_size"),
		menus.language
	)
	return line.get_size() + style.get_minimum_size()


## Scrolls [param control] until it draws [param item], and answers whether it asked anything to
## move. A tab bar and a tree have a call for it; a list is scrolled by its own bar, by as little as
## brings the whole entry in.
static func _scroll_to(control: Control, item: Variant) -> bool:
	var index: int = item if item is int else -1
	var bar: TabBar = control as TabBar
	if bar != null:
		var before: int = bar.get_tab_offset()
		bar.ensure_tab_visible(index)
		return bar.get_tab_offset() != before
	var tree: Tree = control as Tree
	if tree != null:
		var row: TreeItem = item
		var was: float = tree.get_scroll().y
		tree.scroll_to_item(row)
		return tree.get_scroll().y != was
	var list: ItemList = control as ItemList
	if list == null:
		return false
	var rows: VScrollBar = list.get_v_scroll_bar()
	var entry: Rect2 = list.get_item_rect(index, false)
	var top: float = entry.position.y - list.get_theme_stylebox("panel").get_offset().y
	var was_at: float = rows.value
	if top < rows.value:
		rows.value = top
	elif top + entry.size.y > rows.value + rows.page:
		rows.value = top + entry.size.y - rows.page
	return rows.value != was_at
