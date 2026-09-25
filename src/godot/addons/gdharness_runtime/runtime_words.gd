extends RefCounted

## What a node says to a player, read the way it is drawn: the parsed words of rich text, as much of
## a line as is typed out so far, the translation rather than its key, a mask over a secret, and the
## items of the controls that draw a list.
##
## One module because three questions are the same question: what a screen reads as, which nodes say
## a given word, and whether anything has come to say it yet. Two copies of what a node says is how
## the three of them come to disagree about a SpinBox.


## What one node says, or "" for a node that says nothing. Anything with a `text` property, which
## is every label, button and field the interface is built out of.
##
## Read rather than looked up in the property list, which the engine builds afresh on every call: a
## wait asks this of every node on the screen every frame, and on a hall of 3,500 nodes the lookup
## took the game it was watching from 60 frames a second to 11. A node without the property reads
## as null, which is not a string.
##
## A label is asked about first and read directly, because a screen is mostly labels and this runs
## for each of them on every look a wait takes.
static func said_by(node: Node) -> String:
	var label: Label = node as Label
	if label != null:
		return _label_says(label)
	if _draws_a_list(node):
		return "\n".join(lines_said_by(node))
	return _text_of(node)


## Every line [param node] draws for a player to read, one to an entry: a label's one line, or each
## item of a control that draws a list of them. Tab titles, list items, tree rows, menu titles and
## the items of an open menu are held by the control rather than in any `text`, so a screen read as
## every label on it and none of those, and a wait for a tab's title or a list item was never met.
static func lines_said_by(node: Node) -> Array[String]:
	var lines: Array[String] = []
	if node is TabBar:
		var bar: TabBar = node
		for tab: int in bar.tab_count:
			if not bar.is_tab_hidden(tab):
				_keep(node.atr(bar.get_tab_title(tab)), lines)
	elif node is MenuBar:
		var menus: MenuBar = node
		for menu: int in menus.get_menu_count():
			if not menus.is_menu_hidden(menu):
				_keep(node.atr(menus.get_menu_title(menu)), lines)
	elif node is ItemList:
		var list: ItemList = node
		for item: int in list.item_count:
			_keep(_as_drawn(node, list.get_item_text(item), list.get_item_auto_translate_mode(item)), lines)
	elif node is PopupMenu:
		# A separator too, by its title: the popup draws a titled one as a heading over the items
		# below it, and one without a title says nothing and is dropped as an empty line.
		var menu: PopupMenu = node
		for item: int in menu.item_count:
			_keep(item_says(menu, item), lines)
	elif node is Tree:
		var tree: Tree = node
		if tree.column_titles_visible:
			var titles: Array[String] = []
			for column: int in tree.columns:
				_keep(node.atr(tree.get_column_title(column)), titles)
			_keep("  ".join(titles), lines)
		_tree_rows(tree, tree.get_root(), tree.hide_root, lines)
	else:
		_keep(_text_of(node), lines)
	return lines


## What item [param index] of [param menu] shows: the translation where the item has one. A menu is
## chosen from by these words, since they are the ones a caller has read off the screen.
static func item_says(menu: PopupMenu, index: int) -> String:
	return _as_drawn(menu, menu.get_item_text(index), menu.get_item_auto_translate_mode(index))


## What a secret [param field] draws: one mask character for each character it holds. Reading the
## words back would hand a password to whoever reads the answer, which the player cannot see either.
static func masked(field: LineEdit) -> String:
	return field.secret_character.repeat(field.text.length())


static func _draws_a_list(node: Node) -> bool:
	return node is TabBar or node is MenuBar or node is ItemList or node is PopupMenu or node is Tree


static func _keep(line: String, into: Array[String]) -> void:
	var trimmed: String = line.strip_edges()
	if not trimmed.is_empty():
		into.append(trimmed)


## [param words] as [param node] draws them, which for a game with translations is the translation
## rather than the key it holds: a control set to `UI_HIRE` shows "Hire", and a wait for "Hire" was
## never met. [param mode] is an item's own setting, which the engine reads before the node's.
static func _as_drawn(
	node: Node, words: String, mode: Node.AutoTranslateMode = Node.AUTO_TRANSLATE_MODE_INHERIT
) -> String:
	match mode:
		Node.AUTO_TRANSLATE_MODE_ALWAYS:
			return node.tr(words)
		Node.AUTO_TRANSLATE_MODE_DISABLED:
			return words
	return node.atr(words)


## The rows of a tree from [param item] down, a row being its columns' text side by side, and
## nothing under a collapsed row or a hidden one, since neither is drawn. A hidden root is only the
## place its children hang from.
static func _tree_rows(tree: Tree, item: TreeItem, skip: bool, into: Array[String]) -> void:
	if item == null or not item.visible:
		return
	if not skip:
		var cells: Array[String] = []
		for column: int in tree.columns:
			_keep(_as_drawn(tree, item.get_text(column), item.get_auto_translate_mode(column)), cells)
		_keep("  ".join(cells), into)
		if item.collapsed:
			return
	var child: TreeItem = item.get_first_child()
	while child != null:
		_tree_rows(tree, child, false, into)
		child = child.get_next()


## What a node with a `text` says, as it is drawn.
static func _text_of(node: Node) -> String:
	var label: Label = node as Label
	if label != null:
		return _label_says(label)
	# A RichTextLabel's text is its markup when it reads BBCode, and nobody reads the tags: a
	# dossier line came back as "[b][color=#4fc2d4]Mollum Telken[/color], [/b]..." and a phrase
	# running across a tag could not be found or waited for. The parsed text is what is drawn, and
	# it also holds what a game added with append_text(), which the property never shows. It is
	# parsed from the translation already.
	if node is RichTextLabel:
		var rich: RichTextLabel = node
		return _shown_part(rich.get_parsed_text(), rich.visible_characters)
	var text: Variant = node.get("text")
	if not text is String:
		return ""
	var words: String = text
	# What somebody typed is drawn as typed, never translated.
	if node is LineEdit:
		var field: LineEdit = node
		return masked(field) if field.secret else words.strip_edges()
	if node is TextEdit:
		return words.strip_edges()
	words = node.atr(words)
	if node is Label3D:
		var sign_text: Label3D = node
		return (words.to_upper() if sign_text.uppercase else words).strip_edges()
	return words.strip_edges()


static func _label_says(label: Label) -> String:
	var words: String = label.atr(label.text)
	return _shown_part(words.to_upper() if label.uppercase else words, label.visible_characters)


## As much of [param words] as is drawn: a label typing a line out shows [param drawn] characters
## of it, and -1 is all of them. Read whole, a words wait was met on the first frame of a line being
## typed out, before the player could read any of it.
static func _shown_part(words: String, drawn: int) -> String:
	return (words if drawn < 0 else words.substr(0, drawn)).strip_edges()
