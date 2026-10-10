extends RefCounted

## What reaches the running game the way a keyboard reaches it: text typed into the field that has
## the focus, and an item chosen out of a menu the way a keyboard chooses one.

const Menus = preload("runtime_menus.gd")
const Read = preload("reading.gd")
const Targets = preload("runtime_targets.gd")
const Values = preload("runtime_values.gd")
const Words = preload("runtime_words.gd")

## The two characters a field reads as keys rather than as text.
const NEWLINE: int = 10
const TAB: int = 9

var _host: Node


func _init(host: Node) -> void:
	_host = host


## Types [param text] wherever the focus is, one key event per character.
##
## A key on its own cannot do this and should not try: which character a key produces is the
## keyboard layout's business, and shift over a digit is an exclamation mark on one layout and
## something else on the next. Given the character instead there is nothing to guess, so a field
## can be filled with anything a player could type, this project's own two typefaces included.
##
## A newline and a tab are the two characters a field reads as keys rather than as text, so they
## are sent as those keys and carry no character of their own: typing a name and submitting it is
## one call rather than two.
##
## Pushed into the viewport for the reason a click is, and it matters more here: the focus is what
## decides where a character lands, so a caller that clicked a field and then typed would otherwise
## have both waiting in the same queue with nothing said about the order.
##
## [code]replace[/code] is for a field that already says something, which is most of them: typing
## lands at the caret, so a spin box reading 2.1 typed "0.3" at reads 2.10.3 and parses back to
## 2.1, and the answer said four characters had gone in. What the field holds afterwards is read
## back now rather than echoed from the request, so a call that typed somewhere unhelpful says so.
func inject_text(params: Dictionary) -> Dictionary:
	var text: String = str(params.get("text", ""))
	var over: bool = Read.as_bool(params.get("replace", false))
	if text.is_empty() and not over:
		return {"type": "error", "message": "text needs something to type, or replace to empty a field"}

	var viewport: Viewport = _host.get_tree().root
	var focused: Control = focus_owner(viewport)
	var shut: String = _shut_to_typing(focused)
	if not shut.is_empty():
		return {"type": "error", "message": shut}

	# Where it goes, which is the one thing a caller cannot see from here, read before the keys: a
	# name field that swaps its panel out on Enter has left the tree by the time the keys are done,
	# and a node out of the tree has no path to give. Null is a game reading keys for itself with
	# nothing focused, which is a real thing to be typing at.
	var into: Variant = null
	if focused != null:
		into = str(focused.get_path())

	var replaced: bool = over and _select_everything(focused)
	# Emptying a field is a real thing to ask for and the one shape of filling one in that types no
	# characters. The selection is standing, so the key a player presses over one is what clears it.
	if replaced and text.is_empty():
		_press(viewport, _held_down(KEY_DELETE))
	for index: int in text.length():
		_press(viewport, _typed(text.unicode_at(index)))

	var holds: Variant = null
	if is_instance_valid(focused):
		holds = _what_it_holds(focused)
	return {
		"type": "input_injected",
		"input_type": "text",
		"text": text,
		"characters": text.length(),
		"into": into,
		"replaced": replaced,
		"holds": holds,
	}


## The control keys pushed into [param viewport] go to: its focus, or the focus of the window
## embedded in it that has the focus, followed down.
##
## The game's own viewport keeps the control it had focused when a dialog took the focus, and keys
## pushed at it go on to the dialog, measured on 4.7.2: a root field was reported as typed into and
## stayed empty while the characters landed in the dialog's field.
static func focus_owner(viewport: Viewport) -> Control:
	var at: Viewport = viewport
	var deeper: bool = true
	while deeper:
		deeper = false
		for window: Window in at.get_embedded_subwindows():
			if window.has_focus():
				at = window
				deeper = true
				break
	return at.gui_get_focus_owner()


## Selects everything in [param focused] so the next character typed writes over it, and answers
## whether there was a field to select in.
##
## Through the control rather than through a Ctrl+A, which is the one part of filling a field that
## cannot honestly be sent as a key: the shortcut is Cmd+A on macOS and is an [InputMap] action a
## project is free to unbind, and a caller asking for the field to be replaced would then be typing
## on the end of what was there. The replacement itself is still every character a player types.
static func _select_everything(focused: Control) -> bool:
	var field: LineEdit = focused as LineEdit
	if field != null:
		field.select_all()
		return true
	var box: TextEdit = focused as TextEdit
	if box == null:
		return false
	box.select_all()
	return true


## What the field says now, or null where the focus is not a field at all.
##
## A spin box rewrites its own text out of the number it parsed, so this is the only thing that
## says whether what was typed became what the field means. A secret field answers with its mask,
## which still says how many characters it took.
static func _what_it_holds(focused: Control) -> Variant:
	var field: LineEdit = focused as LineEdit
	if field != null:
		return Words.masked(field) if field.secret else field.text
	var box: TextEdit = focused as TextEdit
	if box == null:
		return null
	return box.text


## Why nothing typed would reach [param focused], or "" when it would.
##
## A field that is not editable takes no characters however it is reached, and a click does not
## open a read-only [LineEdit] for editing, measured on 4.7.2, so sending the caller to click it
## would not help.
##
## Having the focus is not the same as being edited. Since Godot 4.4 a field is focused and shut
## until something opens it, which is what a click does and what submitting undoes: press Enter in
## a box and it keeps the focus and drops every key that arrives afterwards. Typing into one
## answered that the characters had gone in and put nothing anywhere, which is the shape a refusal
## exists to prevent. Measured on a spin box in a real game: `has_focus` true, `is_editing` false,
## three characters reported and the field unchanged. Only a [LineEdit] is refused for that: it is
## the one control the engine will say it about, since [TextEdit] has no editing state of its own.
## A game reading keys for itself is typed at with nothing focused at all, and that is not this
## tool's business to judge.
static func _shut_to_typing(focused: Control) -> String:
	var field: LineEdit = focused as LineEdit
	var box: TextEdit = focused as TextEdit
	if (field != null and not field.editable) or (box != null and not box.editable):
		return "%s has the focus and is read-only, so nothing typed lands in it." % focused.get_path()
	if field == null or field.is_editing():
		return ""
	return (
		"%s has the focus and is not being edited, so nothing typed lands in it. Click it first."
		% focused.get_path()
	)


## A whole key press into [param viewport]: down, then the release, so nothing is left held down
## behind the caller.
static func _press(viewport: Viewport, down: InputEventKey) -> void:
	viewport.push_input(down)
	var up: InputEventKey = down.duplicate()
	up.pressed = false
	viewport.push_input(up)


## A key held down by its keycode, for the ones that stand for an edit rather than a character.
static func _held_down(code: Key) -> InputEventKey:
	var event: InputEventKey = InputEventKey.new()
	event.pressed = true
	event.keycode = code
	event.physical_keycode = code
	event.key_label = code
	return event


## The key press that produces [param glyph], as a keyboard would send it.
static func _typed(glyph: int) -> InputEventKey:
	var event: InputEventKey = InputEventKey.new()
	event.pressed = true
	if glyph == NEWLINE:
		event.keycode = KEY_ENTER
	elif glyph == TAB:
		event.keycode = KEY_TAB
	else:
		var capital: int = String.chr(glyph).to_upper().unicode_at(0)
		event.keycode = capital as Key
		event.shift_pressed = capital != glyph
		event.unicode = glyph
	event.physical_keycode = event.keycode
	event.key_label = event.keycode
	return event


## Chooses an item out of a menu, by what it says or by where it is in the list.
##
## A menu's items are drawn rather than built, so there is no node under the pointer to aim at and
## no rectangle to ask for: [PopupMenu] exposes their text, their ids and which one has the focus,
## and nothing about where any of them is. So a click cannot reach one, and a whole click on the
## [OptionButton] in front of it opens the menu on the press and closes it again on the release.
## Every language picker, every filter and every dropdown in a game was unreachable, and the way
## past it was to call `select` and emit `item_selected`, which sets a number and runs none of the
## engine's own path.
##
## Chosen the way a keyboard chooses: the item takes the focus and then `ui_accept` presses it,
## which is the same route through [PopupMenu] a pointer takes and which needs no geometry, so it
## works in a game with no window as well.
##
## [param path] may be the menu or the button in front of it. Naming the button is what a caller
## has, since the menu is an internal child with a generated name that changes between runs.
func choose(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	if node_path.is_empty():
		return {"type": "error", "message": "Node path required"}
	var standing: Dictionary = Values.node_at(_host.get_tree().root, node_path)
	if standing.has("message"):
		return standing
	var node: Node = standing["node"]

	var menu: PopupMenu = Menus.menu_of(node)
	if menu == null:
		return {
			"type": "error",
			"message":
			(
				"%s is a %s, which is neither a PopupMenu nor something holding one"
				% [node_path, node.get_class()]
			)
		}

	if not params.has("index") and str(params.get("text", "")).is_empty():
		return {
			"type": "error",
			"message":
			(
				"%s needs the item named, by text or index. It holds: %s"
				% [node_path, ", ".join(Menus.items_of(menu))]
			)
		}

	# A button a player cannot use is refused, as a click refuses one: the engine opens the menu of a
	# disabled or hidden OptionButton when asked to, measured on 4.7.2, and the pick then changed a
	# selection no player could have changed.
	var holder: BaseButton = node as BaseButton
	if holder != null and holder.disabled:
		return {"type": "error", "message": "%s is disabled, so its menu cannot be opened" % node_path}
	if holder != null and not holder.is_visible_in_tree():
		return {
			"type": "error",
			"message":
			"%s is not visible%s, so its menu cannot be opened" % [node_path, Targets.why_hidden(holder)]
		}

	# Shown first, because a menu nobody has opened has no focus to move and the press would go to
	# whatever is behind it, and before the item is looked for, because opening is when a game fills
	# a menu: one rebuilt on about_to_popup was read as it stood before, measured on 4.7.2, and the
	# index found in the old items chose another item of the new ones. An OptionButton opens its own;
	# a bare PopupMenu is popped where it already sits, which leaves a menu already open where it is.
	var opened: bool = Menus.open_the_menu(node, menu)
	await _host.get_tree().process_frame

	var found: Array[int] = Menus.wanted_items(menu, params)
	if found.size() > 1:
		await _shut(menu, opened)
		var tied: Array[String] = []
		for at: int in found:
			tied.append("%d: %s" % [at, Words.item_says(menu, at)])
		return {
			"type": "error",
			"message":
			(
				"%s has %d items that say %s, so nothing was chosen: %s. Name one by its whole text or by index"
				% [node_path, found.size(), JSON.stringify(str(params.get("text", ""))), ", ".join(tied)]
			)
		}
	var index: int = found[0] if found.size() == 1 else -1
	var refused: String = _not_a_choice(node_path, menu, index)
	if not refused.is_empty():
		await _shut(menu, opened)
		return {"type": "error", "message": refused}

	# Read before the press, because the press can take the menu away: a game that rebuilds its
	# settings screen on item_selected frees the button and its menu inside the pick, and reading
	# the item afterwards was an engine error in the game's log and an empty answer to a pick that
	# had taken.
	var answer: Dictionary = {
		"type": "chosen",
		"path": node_path,
		"index": index,
		"text": Words.item_says(menu, index),
		"id": menu.get_item_id(index),
		"opened": opened,
		"menu": str(menu.get_path()),
	}
	# Heard rather than assumed: an item pressed is the only evidence the menu took it.
	var fired: Array[int] = []
	var hear: Callable = func(at: int) -> void: fired.append(at)
	var _listening: int = menu.index_pressed.connect(hear)
	menu.scroll_to_item(index)
	menu.set_focused_item(index)
	# Through Input rather than pushed at the menu, which is how a keyboard reaches an open one: a
	# popup is a Window, it takes the focus when it opens, and Input delivers to whichever window
	# has it. Pushed straight at the menu the event arrived and nothing happened.
	Input.parse_input_event(_accept(true))
	await _host.get_tree().process_frame
	Input.parse_input_event(_accept(false))
	await _host.get_tree().process_frame
	if is_instance_valid(menu) and menu.index_pressed.is_connected(hear):
		menu.index_pressed.disconnect(hear)

	if not fired.has(index):
		await _shut(menu, opened)
		return {
			"type": "error",
			"message":
			(
				(
					"%s item %d, %s, had the focus and ui_accept was pressed, and the menu did not take it,"
					+ " so nothing was chosen"
				)
				% [node_path, index, answer["text"]]
			)
		}

	answer["control_afterwards"] = Values.afterwards(node)
	# What the button in front of the menu reads now: a menu item that fired changes the thing
	# holding it. A button the pick took away has nothing to read, and that it went is the answer.
	if answer["control_afterwards"] == "in_tree" and node is OptionButton:
		var chooser: OptionButton = node
		answer["selected"] = chooser.get_selected()
		answer["shows"] = Words.said_by(chooser)
	return answer


## Shuts a menu this call opened, and lets the frame pass in which the engine finishes shutting it.
## A choice asked for in the frame a refusal shut the menu found it half shut, and the press it sent
## went nowhere: measured on 4.7.2, a MenuButton refused and at once asked again answered that the
## menu did not take the item.
func _shut(menu: PopupMenu, opened: bool) -> void:
	if opened and is_instance_valid(menu) and menu.visible:
		menu.hide()
		await _host.get_tree().process_frame


## Why item [param index] of [param menu] is not something to choose, or "" when it is.
static func _not_a_choice(node_path: String, menu: PopupMenu, index: int) -> String:
	if index < 0:
		return "%s has no such item. It holds: %s" % [node_path, ", ".join(Menus.items_of(menu))]
	if menu.is_item_separator(index):
		var heading: String = Words.item_says(menu, index).strip_edges()
		if heading.is_empty():
			return "%s item %d is a separator, not a choice" % [node_path, index]
		return (
			"%s item %d, %s, is a separator heading the items below it, not a choice"
			% [node_path, index, heading]
		)
	if menu.is_item_disabled(index):
		return "%s item %d, %s, is disabled" % [node_path, index, Words.item_says(menu, index)]
	return ""


## The press or release of `ui_accept`, which is what [PopupMenu] takes its focused item on.
##
## The action rather than the Enter key it is usually bound to: a project is free to bind it to
## something else, and with Enter taken off it the key did nothing, measured on 4.7.2, while the
## action chose the item.
static func _accept(pressed: bool) -> InputEventAction:
	var event: InputEventAction = InputEventAction.new()
	event.action = "ui_accept"
	event.pressed = pressed
	return event
