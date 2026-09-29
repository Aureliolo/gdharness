extends RefCounted

## Input handed to the running game as if a player had given it: actions, keys, the mouse, and
## a whole click on a Control or a 3D node found by path. Typing and choosing from a menu, which
## reach the game the way a keyboard does, are in runtime_typing.gd.

const Values = preload("runtime_values.gd")

## Where a 3D node is drawn, which is what a click aimed at one has to work out first. Asked of the
## query module rather than worked out again here, so the place this aims at and the place a rect
## reports are the same place by construction rather than by agreement.
const Queries = preload("runtime_queries.gd")
const Read = preload("reading.gd")
const Screen = preload("runtime_screen.gd")
const Targets = preload("runtime_targets.gd")

## The distance from a capital letter to its small one in Unicode. A keycode holds the capital.
const TO_SMALL: int = 32

## What a game started without a window gets whatever the project settings say, and the usual
## reason a control is out of reach. Only worth telling somebody when it is what they have.
const HEADLESS_VIEWPORT: Vector2 = Vector2(64, 64)

var _host: Node
var _values: Values

## Where the last injected pointer event put the pointer, once one has.
##
## Kept here rather than asked of the viewport: the root viewport answers get_mouse_position
## from the operating system's pointer, which an injected event never moves, so on a desktop it
## is wherever the user's mouse is, another monitor included, and every motion sent through the
## bridge carried the distance from there. Only a headless run, with no pointer to read, followed
## the injected events, which is why that reading measured right and a played game read it wrong.
var _pointer: Vector2 = Vector2.ZERO
var _pointer_placed: bool = false

## When the pointer last arrived, and how long it took over the arrival before that, in seconds: what
## turns a motion's distance into the speed a real one carries.
var _pointer_at_usec: int = 0
var _arrival_seconds: float = 1.0 / 60.0


func _init(host: Node, values: Values) -> void:
	_host = host
	_values = values


## The movement a pointer arriving at [param position] carries, which is the distance from where
## the last injected event put it, and none at all for the first. The arrival is recorded, with how
## long it took: at least a frame, since two motions sent in one frame did not cross the screen in
## no time at all.
func _arrive(position: Vector2) -> Vector2:
	var now: int = Time.get_ticks_usec()
	var relative: Vector2 = position - _pointer if _pointer_placed else Vector2.ZERO
	var took: float = float(now - _pointer_at_usec) / 1_000_000.0 if _pointer_placed else 0.0
	_arrival_seconds = maxf(took, 1.0 / 60.0)
	_pointer_at_usec = now
	_pointer = position
	_pointer_placed = true
	return relative


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
	var action: String = str(params.get("action", ""))
	var held: bool = Read.as_bool(params.get("pressed", true), true)
	var whole: bool = not params.has("pressed")
	var strength: float = Read.as_float(params.get("strength", 1.0), 1.0)

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
	var held: bool = Read.as_bool(params.get("pressed", true), true)
	var whole: bool = not params.has("pressed")
	var key_label: String = str(params.get("key_label", ""))

	if keycode_raw is String:
		var named: String = keycode_raw
		if not named.is_empty() and key_label.is_empty():
			key_label = named
	var keycode: int = 0 if keycode_raw is String else Read.as_int(keycode_raw)

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

	event.shift_pressed = Read.as_bool(params.get("shift", false))
	event.ctrl_pressed = Read.as_bool(params.get("ctrl", false))
	event.alt_pressed = Read.as_bool(params.get("alt", false))

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
		return Vector2(Read.as_float(params[x_key]), Read.as_float(params[y_key]))
	var raw: Variant = params.get(pair_key, Vector2.ZERO)
	if raw is Vector2:
		return raw
	if raw is Array:
		var pair: Array = raw
		if pair.size() < 2:
			return "%s array must contain [x, y]" % pair_key
		return Vector2(Read.as_float(pair[0]), Read.as_float(pair[1]))
	return "%s must be Vector2 or [x, y]" % pair_key


## Clicks a mouse button at a position, and lets go of it again unless asked to hold it.
##
## The whole click by default, for the reason [method inject_action] is the whole press, and
## because much of a UI acts on the release: a rich label opens its link then, so a click on one
## answered input_injected and opened nothing, while the same op on the wheel was already whole.
##
## `pressed` is how a caller asks for one half, the way a drag is made: true holds the button down,
## false lets go of one being held.
func inject_mouse_click(params: Dictionary) -> Dictionary:
	var point: Variant = _read_point(params, "x", "y", "position")
	if point is String:
		return {"type": "error", "message": point}
	var position: Vector2 = point
	var button: int = _resolve_mouse_button(params.get("button", MOUSE_BUTTON_LEFT))
	if button < 0:
		return _no_such_button(params.get("button"))
	var held: bool = Read.as_bool(params.get("pressed", true), true)
	var double: bool = Read.as_bool(params.get("doubleClick", false))
	# A wheel step is a press and a release together, as a mouse sends one: there is no holding a
	# wheel. A lone wheel press left the viewport's mouse focus on the control that took it, with
	# the wheel's bit in the focus mask, and every click after it landed on that control rather
	# than under the pointer, landing true and doing nothing, until a release was sent by hand.
	var notch: bool = held and _mask_of(button) == 0
	var whole: bool = notch or not params.has("pressed")

	# A button pressed somewhere puts the pointer there: the motion after a held press measures
	# its drag from the press, which is where a real pointer would be.
	var _moved: Vector2 = _arrive(position)
	Input.parse_input_event(_button(position, button, whole or held, double))
	if notch:
		Input.parse_input_event(_button(position, button, false, false))
	elif whole:
		# A frame between the halves, as inject_action has, so a control that acts on the press and
		# one that acts on the release each get a frame to do it in.
		await _host.get_tree().process_frame
		Input.parse_input_event(_button(position, button, false, false))
		await _host.get_tree().process_frame

	return {
		"type": "input_injected",
		"input_type": "mouse_click",
		"position": [position.x, position.y],
		"button": button,
		"pressed": held and not whole,
		"whole": whole,
		"double": double
	}


## Moves the pointer to a position, with the movement the event carries taken from where the
## last injected event put it unless the caller says otherwise.
##
## A real pointer never arrives without a `relative`, and a control that drags reads that field
## rather than the position, so a motion carrying none leaves a grip where it was however far the
## position moved. The distance from where the bridge last put the pointer is what a real move
## would have carried. A relative the caller gives is kept, since a game may want to read a motion
## the position does not show.
func inject_mouse_motion(params: Dictionary) -> Dictionary:
	var point: Variant = _read_point(params, "x", "y", "position")
	if point is String:
		return {"type": "error", "message": point}
	var position: Vector2 = point
	var relative: Vector2 = _arrive(position)
	if params.has("relativeX") or params.has("relativeY"):
		relative = Vector2(
			Read.as_float(params.get("relativeX", 0.0)), Read.as_float(params.get("relativeY", 0.0))
		)
	elif params.has("relative"):
		var movement: Variant = _read_point(params, "relativeX", "relativeY", "relative")
		if movement is String:
			return {"type": "error", "message": movement}
		relative = movement

	Input.parse_input_event(_motion(position, relative))

	return {
		"type": "input_injected",
		"input_type": "mouse_motion",
		"position": [position.x, position.y],
		"relative": [relative.x, relative.y]
	}


## Whether [param centre] is somewhere a click can reach it: inside the viewport, and inside every
## ScrollContainer between the control and the root, each of which clips what it holds.
static func _in_sight(control: Control, viewport: Viewport, centre: Vector2) -> bool:
	return viewport.get_visible_rect().has_point(centre) and _clipped_by(control, centre) == null


## The ScrollContainer between [param control] and its viewport that clips [param centre] away from
## it, or null when none does. Not past the viewport: one holding a dialog is in another space.
static func _clipped_by(control: Control, centre: Vector2) -> ScrollContainer:
	var walking: Node = control.get_parent()
	while walking != null and not (walking is Viewport):
		var holder: ScrollContainer = walking as ScrollContainer
		# Carried into the same space the centre is in, which is the canvas rather than the
		# container's own: the two are only the same while nothing above it is transformed.
		if holder != null:
			var seen: Rect2 = holder.get_global_transform_with_canvas() * Rect2(Vector2.ZERO, holder.size)
			if not seen.has_point(centre):
				return holder
		walking = walking.get_parent()
	return null


## Scrolls whatever is holding [param control] until it is on screen, and answers whether the view
## moved.
##
## Innermost container first and outwards, a frame apart. A container moves what it holds on the
## next layout pass rather than inside the call, and the next one out works out where the control is
## from where it is drawn, so asked in the same frame it scrolled to where the control had been.
## Moved means a scroll value changed: a container asked to show what it already shows moves
## nothing, and answering true for it said the view had moved when it had not. Only the containers in
## the control's own viewport: one holding a dialog scrolls the page behind it, not the dialog.
func _scroll_into_view(control: Control) -> bool:
	var moved: bool = false
	var walking: Variant = control.get_parent()
	while walking != null and not (walking is Viewport):
		var step: Node = walking
		var holder: ScrollContainer = step as ScrollContainer
		if holder != null:
			var before: Vector2i = Vector2i(holder.scroll_horizontal, holder.scroll_vertical)
			holder.ensure_control_visible(control)
			if Vector2i(holder.scroll_horizontal, holder.scroll_vertical) != before:
				moved = true
				await _host.get_tree().process_frame
				# A panel that rebuilds itself can go in the frame this waited.
				if not is_instance_valid(control) or not is_instance_valid(holder):
					return moved
		walking = step.get_parent()
	return moved


## A whole click on a Control: the pointer moves onto it, the button goes down, a frame passes,
## the button comes up. BaseButton fires on the release, which is why a single injected press
## never pressed anything. The position is the control's centre carried into window pixels, so
## the caller never has to do that arithmetic.
##
## A control out of sight inside a ScrollContainer is scrolled to first; the answer says so under
## `scrolled_into_view`, because the view having moved is a thing that happened to the screen and
## the caller is the only one who can tell whether that matters.
##
## `says` names the control by the words on it instead, under `path` when that is given as well,
## found and pressed in the same frame. A find and then a click by path was two round trips over a
## generated path copied whole, and a panel that rebuilt itself between them freed the button, so
## the click landed on nothing.
func click(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var wanted: String = str(params.get("says", ""))
	var found: Variant = null
	if not wanted.is_empty():
		var picked: Dictionary = Targets.control_saying(
			_host.get_tree().root, "/root" if node_path.is_empty() else node_path, wanted, params.get("index")
		)
		if picked.has("message"):
			return picked
		node_path = picked["path"]
		found = picked["found"]
	if node_path.is_empty():
		return {"type": "error", "message": "click needs a path, or says to find the control by its words"}

	var standing: Dictionary = Values.node_at(_host.get_tree().root, node_path)
	if standing.has("message"):
		return standing
	var node: Node = standing["node"]
	if node is Node3D:
		var spatial: Node3D = node
		return await _click_in_the_world(node_path, spatial, params)
	if not node is Control:
		return {
			"type": "error",
			"message": "%s is a %s, not a Control or a Node3D" % [node_path, node.get_class()]
		}
	var control: Control = node
	var unmoved: String = _takes_no_click(control, node_path)
	if not unmoved.is_empty():
		return {"type": "error", "message": unmoved}

	# In the control's own viewport first, which is the space its scrolling happens in.
	var own: Viewport = control.get_viewport()
	var local: Vector2 = control.get_global_transform_with_canvas() * (control.size * 0.5)

	# A control out of sight inside a ScrollContainer is not out of reach, it is one scroll away,
	# which is what a person does without thinking about it before they click. Refusing it
	# instead sent callers to emit the button's own signal, which presses nothing, runs none of
	# the input path and reports success.
	#
	# Out of sight against what it is clipped to rather than against the viewport: a row scrolled
	# off the top of its container is inside the viewport, behind whatever is drawn up there, so
	# the click went to that instead and said so. Measured on a hall whose staff panel had been
	# scrolled past: the button was at y 69 and its container started at y 166.
	var scrolled: bool = false
	if not _in_sight(control, own, local):
		scrolled = await _scroll_into_view(control)
		var left: String = Values.afterwards(control)
		if left != "in_tree":
			return {
				"type": "error",
				"message":
				(
					"%s was %s while it was being scrolled into view, so nothing was clicked"
					% [node_path, "freed" if left == "freed" else "taken out of the tree"]
				)
			}
		local = control.get_global_transform_with_canvas() * (control.size * 0.5)

	var reached: Dictionary = Screen.reach(own, local)
	var viewport: Viewport = reached["viewport"]
	var centre: Vector2 = reached["point"]
	var position: Vector2 = viewport.get_final_transform() * centre
	# The GUI only delivers to what is inside the viewport, so a centre outside it would be a click
	# that silently reached nothing: outside the viewport it is drawn in, outside the one that shows
	# that on the screen, or clipped away by a ScrollContainer that would not scroll it into view.
	# Each is said of the viewport or container at fault, with its own rect and the point in it.
	var out_there: String = _out_of_reach(control, node_path, local, reached, scrolled)
	if not out_there.is_empty():
		return {"type": "error", "message": out_there}
	var button: int = _resolve_mouse_button(params.get("button", MOUSE_BUTTON_LEFT))
	if button < 0:
		return _no_such_button(params.get("button"))
	var double: bool = Read.as_bool(params.get("double", false))

	# Pushed into the viewport rather than through Input: Input accumulates events and flushes
	# them at the next frame, so the hovered control read below would be the one from before
	# the pointer moved. The viewport delivers it to the GUI the same way a real one arrives.
	viewport.push_input(_motion(position, _arrive(position)))
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

	_press_button(viewport, _button(position, button, true, double))
	await _host.get_tree().process_frame
	_press_button(viewport, _button(position, button, false, false))
	# The release is what a button acts on, and a queue_free it causes lands at the end of
	# this frame; the frame passes so the answer describes the control as the click left it.
	await _host.get_tree().process_frame

	# What became of the control: still in the tree, taken out of it, or freed. A button that
	# opened another screen is the second or the third, and the caller wants to hear that
	# rather than guess it from a tree that has changed shape.
	var afterwards: String = Values.afterwards(control)

	var answer: Dictionary = {
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
	if found != null:
		answer["found"] = found
	return answer


## Why [param control] would take no click a player gave it, or "" when it would.
##
## The last two answered landed, since the pointer reaches the control, while the press did nothing,
## measured on 4.7.2: a disabled button keeps its mouse filter and ignores the press, and a control
## that does not process while the game is paused is hovered and never handed the event.
func _takes_no_click(control: Control, node_path: String) -> String:
	if not control.is_visible_in_tree():
		return "%s is not visible, so nothing can click it" % node_path
	var button: BaseButton = control as BaseButton
	if button != null and button.disabled:
		return "%s is disabled, so clicking it presses nothing" % node_path
	if not control.can_process():
		if _host.get_tree().paused:
			return (
				"the game is paused and %s does not process while it is, so clicking it does nothing"
				% node_path
			)
		return "%s has its processing disabled, so clicking it does nothing" % node_path
	return ""


## Why a click at [param control]'s centre would reach nothing, or "" when it would reach it: the
## centre outside the viewport it is drawn in, at [param local]; outside the viewport showing that
## one on the screen, which [param reached] holds with the centre there; or clipped away by a
## ScrollContainer holding it. A refusal names the viewport or container at fault and the point in
## that one's own space, since naming another printed a point inside the rect it was said to be
## outside. The note on a game with no window goes only on the viewport that is the window's.
func _out_of_reach(
	control: Control, node_path: String, local: Vector2, reached: Dictionary, scrolled: bool
) -> String:
	var after: String = (
		". It was scrolled as far as what holds it goes and is still out there" if scrolled else ""
	)
	for place: Array in [[control.get_viewport(), local], [reached["viewport"], reached["point"]]]:
		var viewport: Viewport = place[0]
		var point: Vector2 = place[1]
		if viewport.get_visible_rect().has_point(point):
			continue
		var which: String = "" if viewport == _host.get_tree().root else " of %s" % viewport.get_path()
		return (
			"%s has its centre at %s, outside the viewport%s %s, so nothing can click it%s%s"
			% [node_path, point, which, viewport.get_visible_rect(), after, _no_window_note(viewport)]
		)
	var holder: ScrollContainer = _clipped_by(control, local)
	if holder == null:
		return ""
	return (
		"%s has its centre at %s, outside the part of %s that shows it, so nothing can click it%s"
		% [
			node_path,
			local,
			holder.get_path(),
			after if scrolled else ". It could not be scrolled into view",
		]
	)


## What to add to a refusal about a point outside the viewport, when the reason is that nobody
## gave this game a window. The rect on its own does not say it, and it is the usual reason.
##
## The size is only claimed where it is true: the rect is printed beside this, so naming 64 by 64
## over a viewport somebody has resized says two different things in one sentence.
func _no_window_note(viewport: Viewport) -> String:
	if viewport != _host.get_tree().root or _host.get_tree().root.can_draw():
		return ""
	if viewport.get_visible_rect().size == HEADLESS_VIEWPORT:
		return (
			". This game has no window, and a game with no window has a 64 by 64 viewport whatever "
			+ "the project settings say: run it with a window to reach this control"
		)
	return ". This game has no window: run it with a window to reach this control"


## Sends a click's press or release into [param viewport], through Input when that is the game's
## own window.
##
## Through Input so that Input knows a button is held, which is what a real mouse tells it. A
## PopupMenu opened by a press asks Input whether a button is down, and when one is, it lets the
## release that ends that press go by rather than choosing the item under it. Pushed straight into
## the viewport, the press left Input thinking nothing was held, so a dropdown near the bottom of
## the screen, whose menu opens over it and under the pointer, had its first item chosen by the
## click meant to open it. Games read that state too, through Input.is_mouse_button_pressed.
##
## Any other viewport is pushed into directly: Input reaches only the game's window. That is a
## viewport with no place on the screen, since `Screen.reach` carries every other one there.
func _press_button(viewport: Viewport, event: InputEventMouseButton) -> void:
	if viewport == _host.get_tree().root:
		Input.parse_input_event(event)
		# Delivered now, as a push is, rather than at the next frame: the answer is read a frame
		# after the release, and a button that frees itself on it has to be gone by then.
		Input.flush_buffered_events()
	else:
		viewport.push_input(event)


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

	var out: Array[Dictionary] = Screen.steps_out(viewport, aim)
	var arriving: Viewport = out.back()["viewport"]
	var reached_point: Vector2 = out.back()["point"]
	# Checked where the pointer arrives as well as where the node is drawn: a room in a SubViewport
	# larger than the container or the window showing it has points inside the SubViewport that are
	# outside everything on the screen, and a click at one reached nothing.
	if arriving != viewport and not arriving.get_visible_rect().has_point(reached_point):
		return {
			"type": "error",
			"message":
			(
				"%s is drawn at %s, which is %s on the screen, outside the viewport %s, so nothing can click it%s"
				% [node_path, aim, reached_point, arriving.get_visible_rect(), _no_window_note(arriving)]
			)
		}
	var position: Vector2 = arriving.get_final_transform() * reached_point
	var button: int = _resolve_mouse_button(params.get("button", MOUSE_BUTTON_LEFT))
	if button < 0:
		return _no_such_button(params.get("button"))
	var double: bool = Read.as_bool(params.get("double", false))

	arriving.push_input(_motion(position, _arrive(position)))
	# Read before the press, for the reason the Control click reads it: what the caller needs to
	# know is whether a panel is sitting over the room, and the press is what would change it.
	var through: Dictionary = _through_the_interface(out)
	var hovered_path: Variant = through["hovered"]

	_press_button(arriving, _button(position, button, true, double))
	await _host.get_tree().process_frame
	_press_button(arriving, _button(position, button, false, false))
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
		"landed": through["landed"],
		"camera": found["camera"],
	}


## Whether a pointer on its way out through [param out], the steps [method Screen.steps_out]
## answers, gets past the interface in every viewport, as {"landed", "hovered"}: the path of the
## control that took it, or of the one under it that let it by, or null.
##
## In the viewport the node is drawn in, a control under the pointer takes it unless it and every
## control holding it let the pointer pass. In each viewport outside that one, the pointer has to be
## over what shows the one inside: the SubViewportContainer, with nothing drawn over it, or inside
## the embedded window. Read in the first viewport alone, a click beside a container that is smaller
## than what it shows, or under a panel drawn over the container, answered landed.
static func _through_the_interface(out: Array[Dictionary]) -> Dictionary:
	var first_under: Variant = null
	for step: Dictionary in out:
		var viewport: Viewport = step["viewport"]
		var through: Variant = step["through"]
		var hovered: Control = viewport.gui_get_hovered_control()
		if through is Window:
			var window: Window = through
			var point: Vector2 = step["point"]
			if not Rect2(window.position, window.size).has_point(point):
				return {"landed": false, "hovered": _path_or_null(hovered)}
			continue
		if through is SubViewportContainer:
			if hovered != through:
				return {"landed": false, "hovered": _path_or_null(hovered)}
			continue
		if hovered != null and not _passes_on(hovered):
			return {"landed": false, "hovered": str(hovered.get_path())}
		if hovered != null and first_under == null:
			first_under = str(hovered.get_path())
	return {"landed": true, "hovered": first_under}


## Whether a pointer over [param control] goes on past the interface: a control that lets it pass
## hands it to the one holding it, and one that stops it takes it, up to a control drawn on its own
## or something that is not a control. Measured on 4.7.2: a HUD over the room letting the pointer
## pass answered not landed while the game's own input took the press. A script on a control that
## lets it pass can still take the event for itself, which nothing outside it can see.
static func _passes_on(control: Control) -> bool:
	var walk: Node = control
	while walk is Control:
		var at: Control = walk
		if at.get_mouse_filter_with_override() == Control.MOUSE_FILTER_STOP:
			return false
		if at.top_level:
			break
		walk = at.get_parent()
	return true


static func _path_or_null(node: Node) -> Variant:
	if node == null:
		return null
	return str(node.get_path())


## The buttons a real pointer event carries are the ones held as it happens, and Input keeps that
## from every button event it is given, injected ones included, so a motion between a held click
## and its release is a drag to a control that reads the mask rather than remembering the click.
##
## And the speed, the distance over the time the pointer took, which only the platform fills in. A
## menu ignores a motion with none, so that one opening under a resting pointer lights nothing: a
## motion over an open drop-down's item answered as injected and the menu highlighted nothing. A
## motion that goes nowhere still has none, as a resting pointer does.
func _motion(position: Vector2, relative: Vector2) -> InputEventMouseMotion:
	var event: InputEventMouseMotion = InputEventMouseMotion.new()
	event.position = position
	event.global_position = position
	event.relative = relative
	event.screen_relative = relative
	event.velocity = relative / _arrival_seconds
	event.screen_velocity = event.velocity
	event.button_mask = Input.get_mouse_button_mask()
	return event


## A button event carries the buttons held once it has happened: the pressed one among them, the
## released one out. A wheel step is a button with no mask, as it is from a real mouse.
func _button(position: Vector2, button: int, pressed: bool, double: bool) -> InputEventMouseButton:
	var event: InputEventMouseButton = InputEventMouseButton.new()
	event.position = position
	event.global_position = position
	event.button_index = button as MouseButton
	event.pressed = pressed
	event.double_click = double
	var held: int = Input.get_mouse_button_mask()
	var own: int = _mask_of(button)
	event.button_mask = (held | own) if pressed else (held & ~own)
	return event


## The mask bit for a button, which is the engine's own mapping: left 1, right 2, middle 4, the
## two extra buttons 128 and 256. The wheel steps between have none.
func _mask_of(button: int) -> int:
	if button >= MOUSE_BUTTON_WHEEL_UP and button <= MOUSE_BUTTON_WHEEL_RIGHT:
		return 0
	return 1 << (button - 1)


## What to say about a name that is not a mouse button, with the ones that are.
func _no_such_button(named: Variant) -> Dictionary:
	return {
		"type": "error",
		"message":
		(
			"%s is not a mouse button. It takes: left, right, middle, wheel_up, wheel_down, or the number of one."
			% JSON.stringify(named)
		)
	}


## The button [param raw] names, or -1 for a name that is not one of them.
##
## A name nobody recognises used to come back as the left button, so a right click asked for by a
## spelling this does not know went to the left button and reported the left button. The caller
## reads the answer and believes it, which is the whole reason nothing here guesses.
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
				return -1
	# The engine's buttons run from 1 to 9: 0 is MOUSE_BUTTON_NONE, which no event carries, and a
	# number past the two extra buttons names nothing a mask bit can be made for.
	var number: int = Read.as_int(raw, -1)
	return number if number >= MOUSE_BUTTON_LEFT and number <= MOUSE_BUTTON_XBUTTON2 else -1
