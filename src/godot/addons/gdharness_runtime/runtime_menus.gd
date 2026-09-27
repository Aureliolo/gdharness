extends RefCounted

## The menu a choice is made from and the item in it, for a choice made by what an item says or by
## where it is in the list.

const Read = preload("reading.gd")
const Words = preload("runtime_words.gd")


## The menu [param node] is, or the one it holds. An [OptionButton] and a [MenuButton] both keep
## theirs as an internal child, which is a node a caller cannot name and should not have to.
static func menu_of(node: Node) -> PopupMenu:
	var menu: PopupMenu = node as PopupMenu
	if menu != null:
		return menu
	if node.has_method("get_popup"):
		var held: Variant = node.call("get_popup")
		if held is PopupMenu:
			return held
	return null


## Which item was asked for: `text`, matched exactly and then case-insensitively, or `index`.
## Minus one when neither names one that is there.
##
## `text` is matched against the words the item shows before the ones it holds. In a game with
## translations they differ, and the shown ones are what a caller has read off the screen: an item
## held as `ACT_ENGAGE` and shown as "Hire" refused "Hire" and listed the keys. The held words
## still count after them, for a caller that has the key from the source.
static func wanted_item(menu: PopupMenu, params: Dictionary) -> int:
	if params.has("index"):
		var asked: int = Read.as_int(params.get("index", -1), -1)
		return asked if asked >= 0 and asked < menu.get_item_count() else -1
	var wanted: String = str(params.get("text", ""))
	if wanted.is_empty():
		return -1
	# The items before the separators, because a heading can carry the same words as an item under
	# it, and finding the heading first refused the choice the caller meant. A separator is still
	# looked for after, so a heading asked for by name is refused as one rather than as missing.
	var order: Array[int] = []
	for separators: bool in [false, true]:
		for index: int in menu.get_item_count():
			if menu.is_item_separator(index) == separators:
				order.append(index)
	var shown: Array[String] = []
	var held: Array[String] = []
	for index: int in order:
		shown.append(Words.item_says(menu, index))
		held.append(menu.get_item_text(index))
	for words: Array[String] in [shown, held]:
		for at: int in words.size():
			if words[at] == wanted:
				return order[at]
		for at: int in words.size():
			if words[at].nocasecmp_to(wanted) == 0:
				return order[at]
	return -1


## What the menu shows, for a refusal that names the choices rather than the miss: a titled
## separator marked as the heading it is, and one with no title left out, since it shows nothing.
static func items_of(menu: PopupMenu) -> Array[String]:
	var said: Array[String] = []
	for index: int in menu.get_item_count():
		var words: String = Words.item_says(menu, index)
		if not menu.is_item_separator(index):
			said.append("%d: %s" % [index, words])
		elif not words.strip_edges().is_empty():
			said.append("%d: %s (a heading)" % [index, words])
	return said


## Opens the menu if it is not already, and answers whether anything opened.
static func open_the_menu(node: Node, menu: PopupMenu) -> bool:
	if menu.visible:
		return false
	if node.has_method("show_popup"):
		node.call("show_popup")
		return true
	menu.popup()
	return true
