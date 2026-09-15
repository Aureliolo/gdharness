extends RefCounted

## Input handed to the running game as if a player had given it: actions, keys, the mouse, and
## a whole click on a Control or a 3D node found by path.

const Values = preload("runtime_values.gd")

## Where a 3D node is drawn, which is what a click aimed at one has to work out first. Asked of the
## query module rather than worked out again here, so the place this aims at and the place a rect
## reports are the same place by construction rather than by agreement.
const Queries = preload("runtime_queries.gd")

## The distance from a capital letter to its small one in Unicode. A keycode holds the capital.
const TO_SMALL: int = 32

## The two characters a field reads as keys rather than as text.
const NEWLINE: int = 10
const TAB: int = 9

## What a game started without a window gets whatever the project settings say, and the usual
## reason a control is out of reach. Only worth telling somebody when it is what they have.
const HEADLESS_VIEWPORT: Vector2 = Vector2(64, 64)

var _host: Node
var _values: Values


func _init(host: Node, values: Values) -> void:
	_host = host
	_values = values


## Presses [param params].action, and lets go of it again unless asked to hold it.
##
## The whole press by default, for the reason [method click] is the whole click: an action left
## down is not a press that did nothing, it is a press that never ends, and everything reading
## [method Input.is_action_pressed] goes on seeing it for the rest of the session. Answering a
## dialog with `ui_accept` took two calls and left the first one held, which is the shape that
## found this.
##
## `pressed` is how a caller says otherwise: true holds it down, false lets go of one being held.
func inject_action(params: Dictionary) -> Dictionary:
	var action: String = String(params.get("action", ""))
	var held: bool = bool(params.get("pressed", true))
	var whole: bool = not params.has("pressed")
	var strength: float = float(params.get("strength", 1.0))

	if action.is_empty():
		return {"type": "error", "message": "Action name required"}

	if not InputMap.has_action(action):
		return {"type": "error", "message": "Action not found: " + action}

	_say_action(action, whole or held, strength)
	if whole:
		# A frame between the halves, as a click has: a listener that acts on the press and a
		# listener that acts on the release both get their own frame to do it in.
		await _host.get_tree().process_frame
		_say_action(action, false, strength)
		await _host.get_tree().process_frame

	return {
		"type": "input_injected",
		"input_type": "action",
		"action": action,
		"pressed": held and not whole,
		"whole": whole,
	}


func _say_action(action: String, down: bool, strength: float) -> void:
	var event: InputEventAction = InputEventAction.new()
	event.action = action
	event.pressed = down
	event.strength = strength
	Input.parse_input_event(event)


## Presses one key, and lets go of it again unless asked to hold it. See [method inject_action].
func inject_key(params: Dictionary) -> Dictionary:
	var keycode_raw: Variant = params.get("keycode", 0)
	var held: bool = bool(params.get("pressed", true))
	var whole: bool = not params.has("pressed")
	var key_label: String = String(params.get("key_label", ""))

	if keycode_raw is String:
		var named: String = keycode_raw
		if not named.is_empty() and key_label.is_empty():
			key_label = named
	var keycode: int = 0 if keycode_raw is String else int(keycode_raw)

	var event: InputEventKey = InputEventKey.new()
	event.pressed = whole or held

	if not key_label.is_empty():
		event.keycode = OS.find_keycode_from_string(key_label)
		if event.keycode == KEY_NONE:
			return {"type": "error", "message": "Invalid key_label: " + key_label}
	elif keycode > 0:
		event.keycode = keycode as Key
	else:
		return {"type": "error", "message": "keycode or key_label required"}

	# A key event from a real keyboard carries all three, and InputMap consults whichever one
	# the bound event declares: keycode first, then physical_keycode, then key_label. An
	# injected event with only keycode set can therefore never match an action bound by
	# physical key, which is how a rebinding UI normally stores one, so inject_key silently
	# did nothing for those actions.
	event.physical_keycode = event.keycode
	event.key_label = event.keycode

	event.shift_pressed = bool(params.get("shift", false))
	event.ctrl_pressed = bool(params.get("ctrl", false))
	event.alt_pressed = bool(params.get("alt", false))

	# The fourth thing a real event carries, and the only one a text field reads: LineEdit and
	# TextEdit insert `unicode` and never consult the keycode, so an injected key could press any
	# action in the map and still type nothing into a search box. Godot's keycodes for printable
	# keys are the code points themselves, which is what makes this a mapping and not a table.
	event.unicode = _glyph_of(event.keycode, event.shift_pressed)

	Input.parse_input_event(event)
	if whole:
		await _host.get_tree().process_frame
		var up: InputEventKey = event.duplicate()
		up.pressed = false
		Input.parse_input_event(up)
		await _host.get_tree().process_frame

	return {
		"type": "input_injected",
		"input_type": "key",
		"keycode": event.keycode,
		"physical_keycode": event.physical_keycode,
		"shift": event.shift_pressed,
		"ctrl": event.ctrl_pressed,
		"alt": event.alt_pressed,
		"unicode": event.unicode,
		"pressed": held and not whole,
		"whole": whole,
	}


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
## Pushed into the viewport for the reason [method click] is, and it matters more here: the focus
## is what decides where a character lands, so a caller that clicked a field and then typed would
## otherwise have both waiting in the same queue with nothing said about the order.
func inject_text(params: Dictionary) -> Dictionary:
	var text: String = String(params.get("text", ""))
	if text.is_empty():
		return {"type": "error", "message": "text required"}

	var viewport: Viewport = _host.get_tree().root
	for index: int in text.length():
		var down: InputEventKey = _typed(text.unicode_at(index))
		viewport.push_input(down)
		# The release as well, so nothing is left held down behind the caller.
		var up: InputEventKey = down.duplicate()
		up.pressed = false
		viewport.push_input(up)

	return {"type": "input_injected", "input_type": "text", "text": text, "characters": text.length()}


## The key press that produces [param glyph], as a keyboard would send it.
func _typed(glyph: int) -> InputEventKey:
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


## The character a key produces, or nothing for a key that produces none.
##
## Godot's keycodes below [constant KEY_SPECIAL] are the Unicode code points of the keys that
## print something, so the mapping is the value itself. Letters are held as their capitals, which
## is the one place the shift a caller asked for changes the answer rather than the key.
func _glyph_of(keycode: Key, shifted: bool) -> int:
	if keycode >= KEY_SPECIAL:
		return 0
	if keycode >= KEY_A and keycode <= KEY_Z and not shifted:
		return keycode + TO_SMALL
	return keycode


## A point the tool schema sends as two flat numbers, or the older form of one [x, y] value.
## Answers a Vector2, or the String that says what was wrong with it.
func _read_point(params: Dictionary, x_key: String, y_key: String, pair_key: String) -> Variant:
	if params.has(x_key) and params.has(y_key):
		return Vector2(float(params[x_key]), float(params[y_key]))
	var raw: Variant = params.get(pair_key, Vector2.ZERO)
	if raw is Vector2:
		return raw
	if raw is Array:
		var pair: Array = raw
		if pair.size() < 2:
			return "%s array must contain [x, y]" % pair_key
		return Vector2(float(pair[0]), float(pair[1]))
	return "%s must be Vector2 or [x, y]" % pair_key


func inject_mouse_click(params: Dictionary) -> Dictionary:
	var point: Variant = _read_point(params, "x", "y", "position")
	if point is String:
		return {"type": "error", "message": point}
	var position: Vector2 = point
	var button: int = _resolve_mouse_button(params.get("button", MOUSE_BUTTON_LEFT))
	var pressed: bool = bool(params.get("pressed", true))
	var double: bool = bool(params.get("doubleClick", false))

	Input.parse_input_event(_button(position, button, pressed, double))

	return {
		"type": "input_injected",
		"input_type": "mouse_click",
		"position": [position.x, position.y],
		"button": button,
		"pressed": pressed,
		"double": double
	}


func inject_mouse_motion(params: Dictionary) -> Dictionary:
	var point: Variant = _read_point(params, "x", "y", "position")
	if point is String:
		return {"type": "error", "message": point}
	var position: Vector2 = point
	var movement: Variant = _read_point(params, "relativeX", "relativeY", "relative")
	if movement is String:
		return {"type": "error", "message": movement}
	var relative: Vector2 = movement

	Input.parse_input_event(_motion(position, relative))

	return {
		"type": "input_injected",
		"input_type": "mouse_motion",
		"position": [position.x, position.y],
		"relative": [relative.x, relative.y]
	}


## The viewport a click aimed at [param control] has to be pushed into.
##
## Its own, unless that is an embedded [Window]. A ConfirmationDialog is a Window, and under
## `gui_embed_subwindows` a Window is drawn inside its parent rather than given one by the
## desktop: pushing into its own viewport delivers nothing, measured, with the pointer reading as
## over no control at all. What reaches it is the parent, which is what the engine does with a
## real pointer. Walked rather than stepped once, because a dialog can open a dialog.
static func _clicking_viewport(control: Control) -> Viewport:
	var viewport: Viewport = control.get_viewport()
	var window: Window = viewport as Window
	while window != null and window.is_embedded() and window.get_parent() != null:
		viewport = window.get_parent().get_viewport()
		window = viewport as Window
	return viewport


## Where [param control]'s centre is in the viewport [method _clicking_viewport] names.
##
## The transform is against the control's own viewport, so every embedded window between it and
## that one contributes its offset. The same walk, because the two answers have to agree about
## which viewport they are describing.
static func _centre_of(control: Control) -> Vector2:
	var centre: Vector2 = control.get_global_transform_with_canvas() * (control.size * 0.5)
	var window: Window = control.get_viewport() as Window
	while window != null and window.is_embedded() and window.get_parent() != null:
		centre += Vector2(window.position)
		window = window.get_parent().get_viewport() as Window
	return centre


## Scrolls whatever is holding [param control] until it is on screen, and answers whether
## anything moved.
##
## Innermost container first and outwards, because ensuring visibility inside an inner one moves
## the control within the outer one, so the outer has to be asked after the inner has finished
## moving it. A control with no ScrollContainer over it moves nothing and answers false, which is
## what keeps the refusal below saying the right thing about a control that is simply off screen.
static func _scroll_into_view(control: Control) -> bool:
	var moved: bool = false
	var walking: Node = control.get_parent()
	while walking != null:
		var holder: ScrollContainer = walking as ScrollContainer
		if holder != null:
			holder.ensure_control_visible(control)
			moved = true
		walking = walking.get_parent()
	return moved


## A whole click on a Control: the pointer moves onto it, the button goes down, a frame passes,
## the button comes up. BaseButton fires on the release, which is why a single injected press
## never pressed anything. The position is the control's centre carried into window pixels, so
## the caller never has to do that arithmetic.
##
## A control out of sight inside a ScrollContainer is scrolled to first; the answer says so under
## `scrolled_into_view`, because the view having moved is a thing that happened to the screen and
## the caller is the only one who can tell whether that matters.
func click(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	if node_path.is_empty():
		return {"type": "error", "message": "Node path required"}

	var node: Node = _host.get_tree().root.get_node_or_null(node_path)
	if node == null:
		return {"type": "error", "message": "Node not found: " + node_path}
	if node is Node3D:
		return await _click_in_the_world(node_path, node, params)
	if not node is Control:
		return {
			"type": "error",
			"message": "%s is a %s, not a Control or a Node3D" % [node_path, node.get_class()]
		}
	var control: Control = node
	if not control.is_visible_in_tree():
		return {"type": "error", "message": "%s is not visible, so nothing can click it" % node_path}

	var viewport: Viewport = _clicking_viewport(control)
	var centre: Vector2 = _centre_of(control)

	# A control below the fold of a ScrollContainer is not out of reach, it is one scroll away,
	# which is what a person does without thinking about it before they click. Refusing it
	# instead sent callers to emit the button's own signal, which presses nothing, runs none of
	# the input path and reports success.
	var scrolled: bool = false
	if not viewport.get_visible_rect().has_point(centre):
		scrolled = _scroll_into_view(control)
		if scrolled:
			# A container moves its child on the next layout pass rather than inside the call.
			await _host.get_tree().process_frame
			centre = control.get_global_transform_with_canvas() * (control.size * 0.5)

	var position: Vector2 = viewport.get_final_transform() * centre
	# The GUI only delivers to what is inside the viewport, so a centre outside it would be a
	# click that silently reached nothing. A game with no window has a 64 by 64 viewport
	# whatever the project settings say, which is the usual reason to be here and is not
	# something the caller can read off the rect on its own.
	if not viewport.get_visible_rect().has_point(centre):
		var why: String = _no_window_note(viewport)
		if scrolled:
			why = ". It was scrolled as far as what holds it goes and is still out there"
		return {
			"type": "error",
			"message":
			(
				"%s has its centre at %s, outside the viewport %s, so nothing can click it%s"
				% [node_path, centre, viewport.get_visible_rect(), why]
			)
		}
	var button: int = _resolve_mouse_button(params.get("button", MOUSE_BUTTON_LEFT))
	var double: bool = bool(params.get("double", false))

	# Pushed into the viewport rather than through Input: Input accumulates events and flushes
	# them at the next frame, so the hovered control read below would be the one from before
	# the pointer moved. The viewport delivers it to the GUI the same way a real one arrives.
	viewport.push_input(_motion(position, Vector2.ZERO))
	# What the engine itself thinks is under the pointer, which is the answer to "did it land",
	# read before the press so the caller learns about a control on top rather than a click
	# that went to it. Read in full here, path included, because nothing about that control
	# is guaranteed to survive the release: a button that opens the next screen takes the
	# whole menu out of the tree, and a node that has left the tree has no path to give.
	# Asked of the control's own viewport rather than the one the event went into, and for an
	# embedded window those are two different objects: the parent takes the event and hands it on,
	# and the window keeps the GUI state. Reading the parent reported every dialog as not landed
	# while the button it was aimed at pressed perfectly well, which is the worst shape an answer
	# can have, since the caller believes the miss over what the game just did.
	var hovered: Control = control.get_viewport().gui_get_hovered_control()
	var hovered_path: Variant = null
	if hovered != null:
		hovered_path = str(hovered.get_path())
	var landed: bool = hovered == control or (hovered != null and control.is_ancestor_of(hovered))

	viewport.push_input(_button(position, button, true, double))
	await _host.get_tree().process_frame
	viewport.push_input(_button(position, button, false, false))
	# The release is what a button acts on, and a queue_free it causes lands at the end of
	# this frame; the frame passes so the answer describes the control as the click left it.
	await _host.get_tree().process_frame

	# What became of the control: still in the tree, taken out of it, or freed. A button that
	# opened another screen is the second or the third, and the caller wants to hear that
	# rather than guess it from a tree that has changed shape. A freed reference cannot be
	# handed to anything typed, so the question is asked here.
	var afterwards: String = "freed"
	if is_instance_valid(control):
		afterwards = "in_tree" if control.is_inside_tree() else "removed"

	return {
		"type": "clicked",
		"path": node_path,
		"position": _values.serialize(position),
		"button": button,
		"double": double,
		"hovered": hovered_path,
		"landed": landed,
		"control_afterwards": afterwards,
		"scrolled_into_view": scrolled,
	}


## What to add to a refusal about a point outside the viewport, when the reason is that nobody
## gave this game a window. The rect on its own does not say it, and it is the usual reason.
##
## The size is only claimed where it is true: the rect is printed beside this, so naming 64 by 64
## over a viewport somebody has resized says two different things in one sentence.
func _no_window_note(viewport: Viewport) -> String:
	if _host.get_tree().root.can_draw():
		return ""
	if viewport.get_visible_rect().size == HEADLESS_VIEWPORT:
		return (
			". This game has no window, and a game with no window has a 64 by 64 viewport whatever "
			+ "the project settings say: run it with a window to reach this control"
		)
	return ". This game has no window: run it with a window to reach this control"


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
## Chosen the way a keyboard chooses: the item takes the focus and then Enter presses it, which is
## the same route through [PopupMenu] a pointer takes and which needs no geometry, so it works in a
## game with no window as well.
##
## [param path] may be the menu or the button in front of it. Naming the button is what a caller
## has, since the menu is an internal child with a generated name that changes between runs.
func choose(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	if node_path.is_empty():
		return {"type": "error", "message": "Node path required"}
	var node: Node = _host.get_tree().root.get_node_or_null(node_path)
	if node == null:
		return {"type": "error", "message": "Node not found: " + node_path}

	var menu: PopupMenu = _menu_of(node)
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
				% [node_path, ", ".join(_items_of(menu))]
			)
		}

	var index: int = _wanted_item(menu, params)
	if index < 0:
		return {
			"type": "error",
			"message": "%s has no such item. It holds: %s" % [node_path, ", ".join(_items_of(menu))]
		}
	if menu.is_item_separator(index):
		return {"type": "error", "message": "%s item %d is a separator, not a choice" % [node_path, index]}
	if menu.is_item_disabled(index):
		return {
			"type": "error",
			"message": "%s item %d, %s, is disabled" % [node_path, index, menu.get_item_text(index)]
		}

	# Shown first, because a menu nobody has opened has no focus to move and Enter would go to
	# whatever is behind it. An OptionButton opens its own; a bare PopupMenu is popped where it
	# already sits, which leaves a menu that was already open where it is.
	var opened: bool = _open_the_menu(node, menu)
	await _host.get_tree().process_frame

	menu.scroll_to_item(index)
	menu.set_focused_item(index)
	# Through Input rather than pushed at the menu, which is how a keyboard reaches an open one: a
	# popup is a Window, it takes the focus when it opens, and Input delivers to whichever window
	# has it. Pushed straight at the menu the event arrived and nothing happened.
	Input.parse_input_event(_accept(true))
	await _host.get_tree().process_frame
	Input.parse_input_event(_accept(false))
	await _host.get_tree().process_frame

	var answer: Dictionary = {
		"type": "chosen",
		"path": node_path,
		"index": index,
		"text": menu.get_item_text(index),
		"id": menu.get_item_id(index),
		"opened": opened,
		"menu": str(menu.get_path()),
	}
	# What the button in front of the menu reads now, which is the answer to "did it take": a menu
	# item that fired changes the thing holding it, and nothing else about the press says so.
	var chooser: OptionButton = node as OptionButton
	if chooser != null:
		answer["selected"] = chooser.get_selected()
		answer["shows"] = chooser.text
	return answer


## The menu [param node] is, or the one it holds. An [OptionButton] and a [MenuButton] both keep
## theirs as an internal child, which is a node a caller cannot name and should not have to.
static func _menu_of(node: Node) -> PopupMenu:
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
static func _wanted_item(menu: PopupMenu, params: Dictionary) -> int:
	if params.has("index"):
		var asked: int = int(params.get("index", -1))
		return asked if asked >= 0 and asked < menu.get_item_count() else -1
	var wanted: String = str(params.get("text", ""))
	if wanted.is_empty():
		return -1
	for index: int in menu.get_item_count():
		if menu.get_item_text(index) == wanted:
			return index
	for index: int in menu.get_item_count():
		if menu.get_item_text(index).nocasecmp_to(wanted) == 0:
			return index
	return -1


## What the menu says, for a refusal that names the choices rather than the miss.
static func _items_of(menu: PopupMenu) -> PackedStringArray:
	var said: PackedStringArray = PackedStringArray()
	for index: int in menu.get_item_count():
		said.append("%d: %s" % [index, menu.get_item_text(index)])
	return said


## Opens the menu if it is not already, and answers whether anything opened.
static func _open_the_menu(node: Node, menu: PopupMenu) -> bool:
	if menu.visible:
		return false
	if node.has_method("show_popup"):
		node.call("show_popup")
		return true
	menu.popup()
	return true


func _accept(pressed: bool) -> InputEventKey:
	var event: InputEventKey = InputEventKey.new()
	event.keycode = KEY_ENTER
	event.physical_keycode = KEY_ENTER
	event.key_label = KEY_ENTER
	event.pressed = pressed
	return event


## A whole click aimed at where a 3D node is drawn, for a game that picks with a ray out of the
## cursor rather than with a Control.
##
## The alternative was three calls: read the node's position, find the camera, unproject it, then
## push raw mouse events at the answer. Anything that walks has walked by the third, so the click
## lands where it used to be, which is a miss that looks exactly like a game that ignored it.
##
## What this can honestly say is where the click went and whether the interface took it: a Control
## under the pointer swallows the press and the room never hears it, and that is the failure worth
## naming. Whether the game's own picking then chose this node is the game's rule rather than
## anything the engine can be asked, so it is not claimed.
func _click_in_the_world(node_path: String, item: Node3D, params: Dictionary) -> Dictionary:
	if not item.is_visible_in_tree():
		return {"type": "error", "message": "%s is not visible, so nothing can click it" % node_path}

	var found: Dictionary = Queries.in_frame(item)
	if found.is_empty():
		return {
			"type": "error",
			"message":
			"%s is not in a viewport with a current Camera3D, so there is nowhere to click it" % node_path
		}
	if not found.has("aim"):
		return {
			"type": "error",
			"message": "%s is behind the camera drawing it, so it is not on screen to click" % node_path
		}

	var viewport: Viewport = item.get_viewport()
	var aim: Vector2 = found["aim"]
	if not viewport.get_visible_rect().has_point(aim):
		return {
			"type": "error",
			"message":
			(
				"%s is drawn at %s, outside the viewport %s, so nothing can click it%s"
				% [node_path, aim, viewport.get_visible_rect(), _no_window_note(viewport)]
			)
		}

	var position: Vector2 = viewport.get_final_transform() * aim
	var button: int = _resolve_mouse_button(params.get("button", MOUSE_BUTTON_LEFT))
	var double: bool = bool(params.get("double", false))

	viewport.push_input(_motion(position, Vector2.ZERO))
	# Read before the press, for the reason the Control click reads it: what the caller needs to
	# know is whether a panel is sitting over the room, and the press is what would change it.
	var hovered: Control = viewport.gui_get_hovered_control()
	var hovered_path: Variant = null
	if hovered != null:
		hovered_path = str(hovered.get_path())

	viewport.push_input(_button(position, button, true, double))
	await _host.get_tree().process_frame
	viewport.push_input(_button(position, button, false, false))
	await _host.get_tree().process_frame

	return {
		"type": "clicked",
		"path": node_path,
		"position": _values.serialize(position),
		"button": button,
		"double": double,
		"hovered": hovered_path,
		# The interface did not take it, so it reached the game's own input. As close to "it
		# landed" as anything outside the game can get, and said in the same word the Control
		# click says it in.
		"landed": hovered == null,
		"camera": found["camera"],
	}


func _motion(position: Vector2, relative: Vector2) -> InputEventMouseMotion:
	var event: InputEventMouseMotion = InputEventMouseMotion.new()
	event.position = position
	event.global_position = position
	event.relative = relative
	return event


func _button(position: Vector2, button: int, pressed: bool, double: bool) -> InputEventMouseButton:
	var event: InputEventMouseButton = InputEventMouseButton.new()
	event.position = position
	event.global_position = position
	event.button_index = button as MouseButton
	event.pressed = pressed
	event.double_click = double
	return event


func _resolve_mouse_button(raw: Variant) -> int:
	if raw is String:
		var named: String = raw
		match named.to_lower():
			"left":
				return MOUSE_BUTTON_LEFT
			"right":
				return MOUSE_BUTTON_RIGHT
			"middle":
				return MOUSE_BUTTON_MIDDLE
			"wheel_up", "wheelup":
				return MOUSE_BUTTON_WHEEL_UP
			"wheel_down", "wheeldown":
				return MOUSE_BUTTON_WHEEL_DOWN
			_:
				return MOUSE_BUTTON_LEFT
	return int(raw)
