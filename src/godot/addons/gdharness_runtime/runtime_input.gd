extends RefCounted

## Input handed to the running game as if a player had given it: actions, keys, the mouse, and
## a whole click on a Control or a 3D node found by path. Typing and choosing from a menu, which
## reach the game the way a keyboard does, are in runtime_typing.gd.

const GdhValues = preload("runtime_values.gd")

## Where a 3D node is drawn, which is what a click aimed at one has to work out first. Asked of the
## query module rather than worked out again here, so the place this aims at and the place a rect
## reports are the same place by construction rather than by agreement.
const GdhQueries = preload("runtime_queries.gd")
const GdhRead = preload("reading.gd")
const GdhHover = preload("runtime_hover.gd")
const GdhItems = preload("runtime_items.gd")
const GdhScreen = preload("runtime_screen.gd")
const GdhTargets = preload("runtime_targets.gd")
const GdhMouse = preload("runtime_mouse.gd")

## Set, to the desktop's name, for a process gdharness started on a desktop of its own and for
## everything that process starts. Kept in step with `DESKTOP_VARIABLE` in src/desktop.ts.
const DESKTOP_VARIABLE: String = "GDHARNESS_DESKTOP"

## Whether this run has had the pointer note in full; the game process is the run.
static var _pointer_explained: bool = false

## Whether this run has had the note on a supplied hover in full.
static var _hover_explained: bool = false

var _host: Node
var _values: GdhValues
var _hover: GdhHover = GdhHover.new()

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


func _init(host: Node, values: GdhValues) -> void:
	_host = host
	_values = values


## [param answer], saying what a desktop of gdharness's own does to the game's own reading of the
## pointer when the game is on one.
##
## For the root window the engine asks Windows where the pointer is, and GetCursorPos refuses a
## process on a desktop that is not in use: measured on one of gdharness's own, it answered false
## with access denied and left the point unwritten. The engine does not check, so a game driven
## there read get_mouse_position() as x 836852416 after a motion to 1310, 314. Nothing here can
## put a pointer on that desktop: Windows moves one only on the desktop in use, and making this one
## that would take the screen. What reads the injected event is right, tooltips included, since the
## engine places a tooltip from the motion that reached the control.
static func _pointer_noted(answer: Dictionary) -> Dictionary:
	if OS.get_environment(DESKTOP_VARIABLE) == "":
		return answer
	# The fact on every answer and the explanation on the first of the run: a session sends dozens of
	# pointer calls to one game, and the same four hundred characters on each was most of what came
	# back.
	answer["pointer_on_hidden_desktop"] = true
	if not _pointer_explained:
		_pointer_explained = true
		answer["pointer_note"] = (
			"This game is on gdharness's own desktop, where Windows refuses to say where the"
			+ " pointer is, so get_mouse_position() on the root window, and get_global_mouse_position()"
			+ " and get_local_mouse_position() on what is drawn there, read a meaningless position"
			+ " rather than where this put it. What reads the event itself gets this position: the"
			+ " control under the pointer, its hover and tooltip, and the game's input handlers. Said"
			+ " once a run; pointer_on_hidden_desktop marks every answer it applies to."
		)
	return answer


## [param answer], saying that the hover it reports was supplied here, when [param supplied]: see
## runtime_hover.gd.
static func _hover_noted(answer: Dictionary, supplied: bool) -> Dictionary:
	if not supplied:
		return answer
	answer["hover_supplied"] = true
	if not _hover_explained:
		_hover_explained = true
		answer["hover_note"] = (
			"This window has had no pointer enter from the operating system, and with subwindow"
			+ " embedding off Godot hovers nothing in a native window until it has, so a Button there"
			+ " takes no press. The runtime gave the controls under the pointer the hover the engine"
			+ " would have: their mouse_entered and mouse_exited, and the hover a Button presses on."
			+ " Viewport.gui_get_hovered_control() still answers null in this window. Said once a run;"
			+ " hover_supplied marks every answer it applies to."
		)
	return answer


## Hovers what is under [param position] in the game's window, where the pointer events Input is
## given go, when the engine cannot: see runtime_hover.gd.
func _follow_in_the_window(position: Vector2) -> bool:
	var root: Window = _host.get_tree().root
	return _hover.follow(root, root.get_final_transform().affine_inverse() * position)


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
	var held: bool = GdhRead.as_bool(params.get("pressed", true), true)
	var whole: bool = not params.has("pressed")
	var strength: float = GdhRead.as_float(params.get("strength", 1.0), 1.0)

	if action.is_empty():
		return {"type": "error", "message": "Action name required"}

	if not InputMap.has_action(action):
		return {"type": "error", "message": GdhValues.no_action(action)}
	var holding: Variant = GdhValues.held_for(params)
	if holding is String:
		return {"type": "error", "message": holding}
	var frames: int = holding

	var focused: String = GdhValues.focus_path(_host)
	_say_action(action, whole or held, strength)
	var shortcuts: Dictionary = {"shortcuts": [], "shortcut_pressed": null}
	if whole or held:
		shortcuts = await GdhValues.press_shortcuts(_host.get_tree().root, action)
	var lasted: Variant = null
	if whole:
		# A frame between the halves at least, as a click has: a listener that acts on the press and
		# a listener that acts on the release both get their own frame to do it in.
		lasted = await GdhValues.hold(_host.get_tree(), frames)
		_say_action(action, false, strength)
	# The engine hands a parsed event on at the next frame, so the focus is read after one.
	await _host.get_tree().process_frame

	var answer: Dictionary = {
		"type": "input_injected",
		"input_type": "action",
		"action": action,
		"shortcuts": shortcuts["shortcuts"],
		"shortcut_pressed": shortcuts["shortcut_pressed"],
		"pressed": held and not whole,
		"whole": whole,
		"held_frames": GdhValues.held_answer(whole, frames),
		"held_for": lasted,
	}
	return GdhValues.focus_noted(answer, focused, _host)


func _say_action(action: String, down: bool, strength: float) -> void:
	var event: InputEventAction = InputEventAction.new()
	event.action = action
	event.pressed = down
	event.strength = strength
	Input.parse_input_event(event)


## Presses one key, and lets go of it again unless asked to hold it. See [method inject_action].
func inject_key(params: Dictionary) -> Dictionary:
	var keycode_raw: Variant = params.get("keycode", 0)
	var held: bool = GdhRead.as_bool(params.get("pressed", true), true)
	var whole: bool = not params.has("pressed")
	var named: String = keycode_raw if keycode_raw is String else ""
	var keycode: int = 0 if keycode_raw is String else GdhRead.as_int(keycode_raw)
	var holding: Variant = GdhValues.held_for(params)
	if holding is String:
		return {"type": "error", "message": holding}
	var frames: int = holding

	var event: InputEventKey = InputEventKey.new()
	event.pressed = whole or held

	if not named.is_empty():
		event.keycode = OS.find_keycode_from_string(named)
		if event.keycode == KEY_NONE:
			return {"type": "error", "message": GdhValues.unknown_key(named)}
	elif keycode > 0:
		event.keycode = keycode as Key
	else:
		return {
			"type": "error",
			"message": 'keycode is required: a key name, such as "Space" or "A", or its Godot keycode.'
		}

	# A key event from a real keyboard carries all three, and InputMap consults whichever one
	# the bound event declares: keycode first, then physical_keycode, then key_label. An
	# injected event with only keycode set can therefore never match an action bound by
	# physical key, which is how a rebinding UI normally stores one, so inject_key silently
	# did nothing for those actions.
	event.physical_keycode = event.keycode
	event.key_label = event.keycode

	event.shift_pressed = GdhRead.as_bool(params.get("shift", false))
	event.ctrl_pressed = GdhRead.as_bool(params.get("ctrl", false))
	event.alt_pressed = GdhRead.as_bool(params.get("alt", false))

	# The fourth thing a real event carries, and the only one a text field reads: LineEdit and
	# TextEdit insert `unicode` and never consult the keycode, so an injected key could press any
	# action in the map and still type nothing into a search box. Godot's keycodes for printable
	# keys are the code points themselves, which is what makes this a mapping and not a table.
	event.unicode = GdhValues.glyph_of(event.keycode, event.shift_pressed)

	var focused: String = GdhValues.focus_path(_host)
	Input.parse_input_event(event)
	var lasted: Variant = null
	if whole:
		lasted = await GdhValues.hold(_host.get_tree(), frames)
		var up: InputEventKey = event.duplicate()
		up.pressed = false
		Input.parse_input_event(up)
	await _host.get_tree().process_frame

	var answer: Dictionary = {
		"type": "input_injected",
		"input_type": "key",
		"held_frames": GdhValues.held_answer(whole, frames),
		"held_for": lasted,
		"keycode": event.keycode,
		"physical_keycode": event.physical_keycode,
		"shift": event.shift_pressed,
		"ctrl": event.ctrl_pressed,
		"alt": event.alt_pressed,
		"unicode": event.unicode,
		"actions": GdhValues.actions_of(event),
		"pressed": held and not whole,
		"whole": whole,
	}
	return GdhValues.focus_noted(answer, focused, _host)


## Clicks a mouse button at a position, and lets go of it again unless asked to hold it.
##
## The whole click by default, for the reason [method inject_action] is the whole press, and
## because much of a UI acts on the release: a rich label opens its link then, so a click on one
## answered input_injected and opened nothing, while the same op on the wheel was already whole.
##
## `pressed` is how a caller asks for one half, the way a drag is made: true holds the button down,
## false lets go of one being held.
func inject_mouse_click(params: Dictionary) -> Dictionary:
	var point: Variant = GdhMouse.read_point(params, "x", "y")
	if point is String:
		return {"type": "error", "message": point}
	var position: Vector2 = point
	var button: int = GdhMouse.button_of(params.get("button", MOUSE_BUTTON_LEFT))
	if button < 0:
		return GdhMouse.no_such_button(params.get("button"))
	var held: bool = GdhRead.as_bool(params.get("pressed", true), true)
	var double: bool = GdhRead.as_bool(params.get("doubleClick", false))
	# A wheel step is a press and a release together, as a mouse sends one: there is no holding a
	# wheel. A lone wheel press left the viewport's mouse focus on the control that took it, with
	# the wheel's bit in the focus mask, and every click after it landed on that control rather
	# than under the pointer, landing true and doing nothing, until a release was sent by hand.
	var notch: bool = held and GdhMouse.mask_of(button) == 0
	var whole: bool = notch or not params.has("pressed")
	var holding: Variant = GdhValues.held_for(params)
	if holding is String:
		return {"type": "error", "message": holding}
	var frames: int = holding
	if notch and params.has("holdFrames"):
		return {
			"type": "error",
			"message": "A wheel step is pressed and let go at once, so holdFrames cannot hold one."
		}

	# A button pressed somewhere puts the pointer there: the motion after a held press measures
	# its drag from the press, which is where a real pointer would be.
	var _moved: Vector2 = _arrive(position)
	var supplied: bool = _follow_in_the_window(position)
	# A double click's first click goes whole before it, as [method _click_button] sends one.
	if double and held and not notch:
		Input.parse_input_event(GdhMouse.button_event(position, button, true, false))
		await _host.get_tree().process_frame
		Input.parse_input_event(GdhMouse.button_event(position, button, false, false))
		await _host.get_tree().process_frame
	var press: InputEventMouseButton = GdhMouse.button_event(position, button, whole or held, double)
	Input.parse_input_event(press)
	var lasted: Variant = null
	if notch:
		Input.parse_input_event(GdhMouse.button_event(position, button, false, false))
	elif whole:
		# A frame between the halves at least, as inject_action has, so a control that acts on the
		# press and one that acts on the release each get a frame to do it in.
		lasted = await GdhValues.hold(_host.get_tree(), frames)
		Input.parse_input_event(GdhMouse.button_event(position, button, false, false))
	# Input hands the events on at the next frame, so the control under the pointer is read after it.
	await _host.get_tree().process_frame
	var hovered: Control = _hover.hovered_in(_host.get_viewport())
	var hovered_path: Variant = null
	if hovered != null:
		hovered_path = str(hovered.get_path())

	var at: Array[Vector2] = [position]
	var said: Dictionary = _pointer_noted(
		_hover_noted(
			{
				"type": "input_injected",
				"input_type": "mouse_click",
				"held_frames": GdhValues.held_answer(whole and not notch, frames),
				"held_for": lasted,
				"position": [position.x, position.y],
				"button": button,
				"hovered": hovered_path,
				"actions": GdhValues.actions_of(press),
				"pressed": held and not whole,
				"whole": whole,
				"double": double
			},
			supplied
		)
	)
	return GdhMouse.outside_noted(said, _host.get_viewport(), at)


## Moves the pointer to a position, with the movement the event carries taken from where the
## last injected event put it unless the caller says otherwise.
##
## A real pointer never arrives without a `relative`, and a control that drags reads that field
## rather than the position, so a motion carrying none leaves a grip where it was however far the
## position moved. The distance from where the bridge last put the pointer is what a real move
## would have carried. A relative the caller gives is kept, since a game may want to read a motion
## the position does not show.
func inject_mouse_motion(params: Dictionary) -> Dictionary:
	var point: Variant = GdhMouse.read_point(params, "x", "y")
	if point is String:
		return {"type": "error", "message": point}
	var position: Vector2 = point
	var relative: Vector2 = _arrive(position)
	if params.has("relativeX") or params.has("relativeY"):
		relative = Vector2(
			GdhRead.as_float(params.get("relativeX", 0.0)), GdhRead.as_float(params.get("relativeY", 0.0))
		)

	var supplied: bool = _follow_in_the_window(position)
	Input.parse_input_event(_motion(position, relative))

	var at: Array[Vector2] = [position]
	var said: Dictionary = _pointer_noted(
		_hover_noted(
			{
				"type": "input_injected",
				"input_type": "mouse_motion",
				"position": [position.x, position.y],
				"relative": [relative.x, relative.y]
			},
			supplied
		)
	)
	return GdhMouse.outside_noted(said, _host.get_viewport(), at)


## Drags with a mouse button from one point to another, through any points between, as a hand does:
## the press, one motion each process frame along the stroke, and the release where the last motion
## left the pointer, a frame after it. A game acting on every motion it gets sees as many as a real
## stroke over that many frames sends. Made of calls, a stroke cost a round trip a motion, so the
## one a caller could afford was three or four motions where a hand sends dozens, and a stir that
## moves a few cells a motion moved two for a stroke.
##
## Each motion goes in a frame of its own because the engine merges the motions it is given within
## one frame into a single event, as it does a real mouse's, and a game counting motions counts one.
func inject_mouse_drag(params: Dictionary) -> Dictionary:
	var stroke: Variant = GdhMouse.stroke_of(params)
	if stroke is String:
		return {"type": "error", "message": stroke}
	var points: Array[Vector2] = stroke
	var button: int = GdhMouse.button_of(params.get("button", MOUSE_BUTTON_LEFT))
	if button < 0:
		return GdhMouse.no_such_button(params.get("button"))
	var own: int = GdhMouse.mask_of(button)
	if own == 0:
		return {
			"type": "error",
			"message": "A wheel step has no held position to drag from: give left, right or middle."
		}
	var frames: int = GdhRead.as_int(params.get("frames", 0), 0)
	if frames < 1 or frames > GdhValues.MOST_HELD:
		return {
			"type": "error", "message": "frames is %d, and it takes 1 to %d." % [frames, GdhValues.MOST_HELD]
		}

	var lengths: Array[float] = GdhMouse.lengths_of(points)
	var start: Vector2 = points[0]
	var end: Vector2 = points[points.size() - 1]
	var _moved: Vector2 = _arrive(start)
	var supplied: bool = _follow_in_the_window(start)
	Input.parse_input_event(GdhMouse.button_event(start, button, true, false))
	var travelled: Vector2 = Vector2.ZERO
	for step: int in range(1, frames + 1):
		await _host.get_tree().process_frame
		var at: Vector2 = GdhMouse.along(points, lengths, float(step) / frames)
		var relative: Vector2 = _arrive(at)
		travelled += relative
		supplied = _follow_in_the_window(at) or supplied
		Input.parse_input_event(_motion(at, relative))
	await _host.get_tree().process_frame
	Input.parse_input_event(GdhMouse.button_event(end, button, false, false))
	await _host.get_tree().process_frame

	var said: Dictionary = _pointer_noted(
		_hover_noted(
			{
				"type": "input_injected",
				"input_type": "mouse_drag",
				"from": [start.x, start.y],
				"to": [end.x, end.y],
				"button": button,
				"motions": frames,
				"relative_total": [travelled.x, travelled.y],
			},
			supplied
		)
	)
	return GdhMouse.outside_noted(said, _host.get_viewport(), points)


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
	var item: Variant = null
	if not wanted.is_empty():
		var picked: Dictionary = GdhTargets.control_saying(
			_host.get_tree().root, "/root" if node_path.is_empty() else node_path, wanted, params.get("index")
		)
		if picked.has("message"):
			return picked
		node_path = picked["path"]
		found = picked["found"]
		item = picked.get("item")
	if node_path.is_empty():
		return {"type": "error", "message": "click needs a path, or says to find the control by its words"}

	var standing: Dictionary = GdhValues.node_at(_host.get_tree().root, node_path)
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

	# Words that are part of a rich label are pressed where they are drawn, since its middle can be on
	# other words, a link among them. Said either way, so a press on the middle is never read as one
	# on the words.
	var aim: Vector2 = control.size * 0.5
	var at_centre: bool = true
	var item_scrolled: bool = false
	if item != null:
		var found_by_words: Dictionary = found
		var placed_item: Dictionary = await GdhItems.in_view(
			_host.get_tree(), control, node_path, item, wanted, found_by_words
		)
		if placed_item.has("message"):
			return placed_item
		aim = placed_item["point"]
		at_centre = false
		item_scrolled = placed_item["scrolled"]
	var rich: RichTextLabel = control as RichTextLabel
	if found != null and rich != null:
		var placed: Dictionary = GdhTargets.point_on_words(rich, wanted)
		var found_here: Dictionary = found
		if placed.has("point"):
			aim = placed["point"]
			at_centre = false
			found_here["pressedOn"] = "the words"
		elif placed.has("unplaced"):
			found_here["pressedOn"] = "the middle of the label"
			found_here["note"] = (
				"the words are part of a longer label and %s, so the press went to its middle"
				% placed["unplaced"]
			)

	# In the control's own viewport first, which is the space its scrolling happens in.
	var own: Viewport = control.get_viewport()
	var local: Vector2 = control.get_global_transform_with_canvas() * aim

	# A control out of sight inside a ScrollContainer is not out of reach, it is one scroll away,
	# which is what a person does without thinking about it before they click. Refusing it
	# instead sent callers to emit the button's own signal, which presses nothing, runs none of
	# the input path and reports success.
	#
	# Out of sight against what it is clipped to rather than against the viewport: a row scrolled
	# off the top of its container is inside the viewport, behind whatever is drawn up there, so
	# the click went to that instead and said so. Measured on a hall whose staff panel had been
	# scrolled past: the button was at y 69 and its container started at y 166.
	var scrolled: bool = item_scrolled
	if not _in_sight(control, own, local):
		scrolled = await _scroll_into_view(control) or item_scrolled
		var left: String = GdhValues.afterwards(control)
		if left != "in_tree":
			return {
				"type": "error",
				"message":
				(
					"%s was %s while it was being scrolled into view, so nothing was clicked"
					% [node_path, "freed" if left == "freed" else "taken out of the tree"]
				)
			}
		local = control.get_global_transform_with_canvas() * aim

	# A control taller or wider than what shows it has its centre out of sight at every scroll, and
	# a player clicks the part they can see. Refused, it was called a control nothing could click.
	var on_part: bool = false
	if at_centre and not _in_sight(control, own, local):
		var part: Variant = GdhScreen.shown_part(control)
		if part is Rect2:
			var seen: Rect2 = part
			var middle: Vector2 = seen.get_center()
			# The box of a turned control is wider than the control, so its middle may be off it.
			var back: Vector2 = control.get_global_transform_with_canvas().affine_inverse() * middle
			if seen.has_area() and Rect2(Vector2.ZERO, control.size).has_point(back):
				local = middle
				on_part = true

	var reached: Dictionary = GdhScreen.reach(own, local)
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
	var button: int = GdhMouse.button_of(params.get("button", MOUSE_BUTTON_LEFT))
	if button < 0:
		return GdhMouse.no_such_button(params.get("button"))
	var double: bool = GdhRead.as_bool(params.get("double", false))

	# Pushed into the viewport rather than through Input: Input accumulates events and flushes
	# them at the next frame, so the hovered control read below would be the one from before
	# the pointer moved. The viewport delivers it to the GUI the same way a real one arrives.
	viewport.push_input(_motion(position, _arrive(position)))
	var supplied: bool = _hover.follow(viewport, centre)
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
	var hovered: Control = _hover.hovered_in(control.get_viewport())
	var hovered_path: Variant = null
	if hovered != null:
		hovered_path = str(hovered.get_path())
	var landed: bool = hovered == control or (hovered != null and control.is_ancestor_of(hovered))

	# The link a rich label says was pressed, which is its own word for what the press reached.
	var links: Array = []
	var heard: Callable = func(meta: Variant) -> void: links.append(meta)
	# Read before the press, which may free the label.
	var on_rich_text: bool = rich != null
	if on_rich_text:
		var _listening: int = rich.meta_clicked.connect(heard)
	# A toggle's state either side of the press, since landing says nothing of it: a game clock's
	# switch clicked three times answered clicked each time, and a wait for the clock to move then
	# ran out on a clock left stopped. A click the game undid reads the same before and after.
	var toggle: BaseButton = control as BaseButton
	var was_pressed: Variant = null
	if toggle != null and toggle.toggle_mode:
		was_pressed = toggle.button_pressed
	var press: InputEventMouseButton = await _click_button(viewport, position, button, double)
	# The release is what a button acts on, and a queue_free it causes lands at the end of
	# this frame; the frame passes so the answer describes the control as the click left it.
	await _host.get_tree().process_frame
	if rich != null and is_instance_valid(rich) and rich.meta_clicked.is_connected(heard):
		rich.meta_clicked.disconnect(heard)

	# What became of the control: still in the tree, taken out of it, or freed. A button that
	# opened another screen is the second or the third, and the caller wants to hear that
	# rather than guess it from a tree that has changed shape.
	var afterwards: String = GdhValues.afterwards(control)

	var answer: Dictionary = {
		"type": "clicked",
		"path": node_path,
		"position": _values.serialize(position),
		"button": button,
		"double": double,
		"hovered": hovered_path,
		"landed": landed,
		"actions": GdhValues.actions_of(press),
		"control_afterwards": afterwards,
		"scrolled_into_view": scrolled,
	}
	if on_part:
		answer["pressed_on"] = "the middle of the part on screen, since no scroll brings its centre into view"
	# A Label and a TextureRect ignore the pointer unless told otherwise, so the click goes to what is
	# under them, and landed false with that control as hovered said nothing of why.
	if not landed and control.mouse_filter == Control.MOUSE_FILTER_IGNORE:
		answer["why_not_landed"] = (
			"%s's mouse_filter is ignore, so the pointer passes through it to what is under it" % node_path
		)
	if found != null:
		answer["found"] = found
	if was_pressed != null:
		var now_pressed: Variant = null
		if is_instance_valid(toggle):
			now_pressed = toggle.button_pressed
		answer["pressed"] = {"before": was_pressed, "after": now_pressed}
	# Whether a link was pressed apart from what it carries: a bare [url] reports an empty meta,
	# and given as the meta alone that press read exactly like one that reached no link.
	if on_rich_text:
		answer["link_pressed"] = not links.is_empty()
		if not links.is_empty():
			answer["link_meta"] = _values.serialize(links.back())
	return _pointer_noted(_hover_noted(answer, supplied))


## Why [param control] would take no click a player gave it, or "" when it would.
##
## The last two answered landed, since the pointer reaches the control, while the press did nothing,
## measured on 4.7.2: a disabled button keeps its mouse filter and ignores the press, and a control
## that does not process while the game is paused is hovered and never handed the event.
## A control whose pointer a `mouse_behavior_recursive` above it has turned off is passed through to
## what is underneath, which answered `landed: false` with nothing saying why.
func _takes_no_click(control: Control, node_path: String) -> String:
	if not control.is_visible_in_tree():
		return "%s is not visible%s, so nothing can click it" % [node_path, GdhTargets.why_hidden(control)]
	var button: BaseButton = control as BaseButton
	if button != null and button.disabled:
		return "%s is disabled, so clicking it presses nothing" % node_path
	var turned_off: Control = GdhTargets.pointer_turned_off_by(control)
	if turned_off != null:
		var on: String = "itself" if turned_off == control else str(turned_off.get_path())
		return (
			(
				"%s takes no pointer input, since mouse_behavior_recursive is disabled on %s,"
				+ " so clicking it presses nothing"
			)
			% [node_path, on]
		)
	if not control.can_process():
		var why: String = GdhTargets.why_it_does_not_process(control, node_path)
		var over: Node = GdhTargets.drawn_over(control)
		var cover: String = "" if over == null else "; %s is drawn over it" % over.get_path()
		if _host.get_tree().paused:
			return (
				"the game is paused and %s does not process while it is (%s), so clicking it does nothing%s"
				% [node_path, why, cover]
			)
		return "%s does not process (%s), so clicking it does nothing%s" % [node_path, why, cover]
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


func _no_window_note(viewport: Viewport) -> String:
	return GdhTargets.no_window_note(viewport, _host.get_tree().root)


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
## viewport with no place on the screen, since `GdhScreen.reach` carries every other one there.
## A press and its release a frame apart, answering with the press. A double click arrives as the
## engine gets one from the system: a whole click, then a second press marked as a double click and
## its release. Sent as the marked press alone, it pressed a button once where a player's presses it
## twice.
func _click_button(viewport: Viewport, position: Vector2, button: int, double: bool) -> InputEventMouseButton:
	if double:
		_press_button(viewport, GdhMouse.button_event(position, button, true, false))
		await _host.get_tree().process_frame
		_press_button(viewport, GdhMouse.button_event(position, button, false, false))
		await _host.get_tree().process_frame
	var press: InputEventMouseButton = GdhMouse.button_event(position, button, true, double)
	_press_button(viewport, press)
	await _host.get_tree().process_frame
	_press_button(viewport, GdhMouse.button_event(position, button, false, false))
	return press


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
		return {
			"type": "error",
			"message":
			"%s is not visible%s, so nothing can click it" % [node_path, GdhTargets.why_hidden(item)]
		}

	var found: Dictionary = GdhQueries.in_frame(item)
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

	var out: Array[Dictionary] = GdhScreen.steps_out(viewport, aim)
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
	var button: int = GdhMouse.button_of(params.get("button", MOUSE_BUTTON_LEFT))
	if button < 0:
		return GdhMouse.no_such_button(params.get("button"))
	var double: bool = GdhRead.as_bool(params.get("double", false))

	arriving.push_input(_motion(position, _arrive(position)))
	var supplied: bool = _hover.follow(arriving, reached_point)
	# Read before the press, for the reason the Control click reads it: what the caller needs to
	# know is whether a panel is sitting over the room, and the press is what would change it.
	var through: Dictionary = _through_the_interface(out)
	var hovered_path: Variant = through["hovered"]

	var _press: InputEventMouseButton = await _click_button(arriving, position, button, double)
	await _host.get_tree().process_frame

	return _pointer_noted(
		_hover_noted(
			{
				"type": "clicked",
				"path": node_path,
				"position": _values.serialize(position),
				"button": button,
				"double": double,
				"hovered": hovered_path,
				# The interface did not take it, so it reached the game's own input. As close to "it
				# landed" as anything outside the game can get, and said in the same word the
				# Control click says it in.
				"landed": through["landed"],
				"camera": found["camera"],
			},
			supplied
		)
	)


## Whether a pointer on its way out through [param out], the steps [method GdhScreen.steps_out]
## answers, gets past the interface in every viewport, as {"landed", "hovered"}: the path of the
## control that took it, or of the one under it that let it by, or null.
##
## In the viewport the node is drawn in, a control under the pointer takes it unless it and every
## control holding it let the pointer pass. In each viewport outside that one, the pointer has to be
## over what shows the one inside: the SubViewportContainer, with nothing drawn over it, or inside
## the embedded window. Read in the first viewport alone, a click beside a container that is smaller
## than what it shows, or under a panel drawn over the container, answered landed.
func _through_the_interface(out: Array[Dictionary]) -> Dictionary:
	var first_under: Variant = null
	for step: Dictionary in out:
		var viewport: Viewport = step["viewport"]
		var through: Variant = step["through"]
		var hovered: Control = _hover.hovered_in(viewport)
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
