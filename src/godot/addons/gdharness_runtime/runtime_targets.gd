extends RefCounted

## Which control a click means when it names the control by the words on it rather than by path.

const Queries = preload("runtime_queries.gd")
const Read = preload("reading.gd")
const Says = preload("runtime_says.gd")
const Screen = preload("runtime_screen.gd")
const Values = preload("runtime_values.gd")
const Words = preload("runtime_words.gd")

## How many of the controls saying the same words a refusal names, with the index for each.
const LISTED_CANDIDATES: int = 10


## The control a click by [param wanted] words presses, found under [param root_path] in the tree
## [param root] heads, or the refusal saying why there is none or which of several:
## {"path", "found"} or {"type", "message"}.
##
## Matched the way a find matches `says`, against a control's own words, and only among controls
## the player can see. A match inside a button presses the button, because the label is what says
## the words and the button is what takes the click: aimed at the label, the pointer lands on the
## button and the answer would call the click a miss.
##
## The matches are ranked the way a person reads a screen for the thing to press: a button before
## text that cannot be pressed, and a control whose words are exactly these before one saying them
## as part of a sentence. A plain word is matched anywhere in a text, so on a screen full of prose
## "Back" was said by ten labels as well as the one button reading "Back", and the refusal listing
## eleven sent the caller to an index that moved every time the prose did. Several matches at the
## best rank are refused rather than guessed, each named with the [param which] that picks it,
## counting from 0 in rank order.
##
## A control with something drawn over its centre that a pointer there would reach instead is not
## on screen for a player, and a click at it lands on the thing on top. The screen a game shows
## over its hall covers the hall's drawers without hiding them, so their words matched as well.
static func control_saying(root: Node, root_path: String, wanted: String, which: Variant) -> Dictionary:
	var reached: Dictionary = Values.node_at(root, root_path)
	if reached.has("message"):
		return reached
	var matched: Array[Control] = []
	# The words of the control that matched, which a button pressed on a label's behalf has none of.
	var said: Array[String] = []
	var exact: Array[bool] = []
	var hidden: int = 0
	var pending: Array[Node] = [reached["node"]]
	while not pending.is_empty():
		var node: Node = pending.pop_front()
		if node is Control and Says.says(node, wanted):
			if not Queries.shown(node):
				hidden += 1
			else:
				var control: Control = node
				var target: Control = _pressed_through(control)
				var words: String = Words.said_by(node)
				var whole: bool = _says_exactly(words, wanted)
				var at: int = matched.find(target)
				if at == -1:
					matched.append(target)
					said.append(words)
					exact.append(whole)
				elif whole and not exact[at]:
					said[at] = words
					exact[at] = true
		var children: Array[Node] = node.get_children(true)
		for index: int in range(children.size() - 1, -1, -1):
			pending.push_front(children[index])

	var drawn: Array[Node] = _pointer_takers(root)
	var areas: Array[Rect2] = _areas_of(drawn)
	var covered: int = 0
	var cover: Node = null
	var outside: int = 0
	var open: Array[int] = []
	for index: int in matched.size():
		if _off_screen(matched[index]):
			outside += 1
			continue
		var over: Node = _cover_of(matched[index], drawn, areas)
		if over == null:
			open.append(index)
		else:
			covered += 1
			if cover == null:
				cover = over
	# Stable, so matches of one rank keep the order they are drawn in.
	open.sort_custom(
		func(a: int, b: int) -> bool:
			var first: int = _rank(matched[a], exact[a])
			var second: int = _rank(matched[b], exact[b])
			return first > second or (first == second and a < b)
	)
	var targets: Array[Control] = []
	var ranks: Array[int] = []
	var lines: Array[String] = []
	for index: int in open:
		targets.append(matched[index])
		ranks.append(_rank(matched[index], exact[index]))
		lines.append(said[index])

	var under: String = "" if root_path == "/root" else " under %s" % root_path
	if targets.is_empty():
		return {
			"type": "error",
			"message":
			(
				'no control on screen%s says "%s", so nothing was clicked%s%s%s'
				% [under, wanted, _hidden_note(hidden), _outside_note(outside), _covered_note(covered, cover)]
			)
		}
	var best: int = ranks.count(ranks[0])
	if which == null and best > 1:
		var order: String = "" if best == targets.size() else ", best matches first"
		return {
			"type": "error",
			"message":
			(
				"%s, so which to click is not clear; pass index, counting from 0%s: %s"
				% [_described(best, ranks[0], wanted, under), order, _candidates(targets, lines)]
			)
		}
	var index: int = 0 if which == null else Read.as_int(which, -1)
	if index < 0 or index >= targets.size():
		var plural: String = "" if targets.size() == 1 else "s"
		return {
			"type": "error",
			"message":
			(
				'index %s is not one of the %d control%s on screen%s saying "%s": %s'
				% [str(which), targets.size(), plural, under, wanted, _candidates(targets, lines)]
			)
		}
	var found: Dictionary = {"says": wanted, "index": index, "of": targets.size()}
	if which == null and targets.size() > 1:
		var others: String = (
			"the other one on screen %s" % _passed_over(ranks[0], true)
			if targets.size() == 2
			else "the other %d on screen %s" % [targets.size() - 1, _passed_over(ranks[0], false)]
		)
		found["picked"] = "%s; %s" % [_described(1, ranks[0], wanted, under), others]
	if covered > 0:
		found["covered"] = covered
	return {"path": str(targets[index].get_path()), "found": found}


## How good a match [param target] is for a click: an enabled button over anything else, and then
## the whole of its words over a part of them. A disabled button ranks with what is not a button,
## since a click on it presses nothing: counted as a button, one tied with an enabled button saying
## the same words and the click was refused as not clear.
static func _rank(target: Control, whole: bool) -> int:
	var button: BaseButton = target as BaseButton
	return (2 if button != null and not button.disabled else 0) + (1 if whole else 0)


## Whether one of [param wanted]'s alternatives is the whole of [param said], or the whole of one of
## its lines. A glob is matched against the whole text already, so every match of one is whole.
##
## A line counts because a card is a title over a description: "WARD" over "wards 3" is the card
## named WARD, and read as its words run together it said WARD only as part of more, level with
## "WARDSPITE" over its own description, and a click on WARD was refused as not clear.
static func _says_exactly(said: String, wanted: String) -> bool:
	for words: String in Says.alternatives(wanted):
		if not Says.is_plain(words):
			if said.matchn(words):
				return true
			continue
		var looked_for: String = words.strip_edges()
		if said.strip_edges().nocasecmp_to(looked_for) == 0:
			return true
		for line: String in said.split("\n"):
			if line.strip_edges().nocasecmp_to(looked_for) == 0:
				return true
	return false


## [param count] matches of [param rank], as the start of a sentence.
static func _described(count: int, rank: int, wanted: String, under: String) -> String:
	var what: String = "button" if rank >= 2 else "control"
	var how: String = '"%s"' % wanted
	var plain: bool = true
	for words: String in Says.alternatives(wanted):
		plain = plain and Says.is_plain(words)
	if plain:
		how = ('exactly "%s"' if rank % 2 == 1 else '"%s" as part of more') % wanted
	if count == 1:
		return "the one %s on screen%s saying %s" % [what, under, how]
	return "%d %ss on screen%s say %s" % [count, what, under, how]


## Why the matches below [param rank] were passed over, said of one of them when [param one]. As
## what the code knows, which is whether a control is an enabled button: a card taking clicks in its
## own `gui_input` is not one, and calling it something that cannot be pressed was a guess.
static func _passed_over(rank: int, one: bool) -> String:
	var says: String = "says" if one else "say"
	var is_not: String = "is not an enabled button" if one else "are not enabled buttons"
	match rank:
		3:
			return "%s or %s it as part of more" % [is_not, says]
		2:
			return is_not
		_:
			return "%s it as part of more" % says


## What to add to a refusal that found nothing on screen, when words matched controls out of sight.
static func _hidden_note(hidden: int) -> String:
	if hidden == 0:
		return ""
	return "; %d hidden control%s" % [hidden, " says it" if hidden == 1 else "s say it"]


## What to add to a refusal that found nothing on screen, when words matched controls a click cannot
## reach: off the viewport, or clipped away by a container it does not scroll.
static func _outside_note(outside: int) -> String:
	if outside == 0:
		return ""
	return "; %d control%s it outside what the screen shows" % [outside, " says" if outside == 1 else "s say"]


## What to add to a refusal that found nothing on screen, when the controls saying it are covered.
static func _covered_note(covered: int, cover: Node) -> String:
	if covered == 0:
		return ""
	if covered == 1:
		return "; 1 control says it under %s, which is drawn over it" % cover.get_path()
	return "; %d controls say it under what is drawn over them, such as %s" % [covered, cover.get_path()]


## [param control], or the button holding it when it is not one itself, which is what a click on
## its words means.
static func _pressed_through(control: Control) -> Control:
	var walk: Node = control
	while walk != null:
		if walk is BaseButton:
			var pressed: BaseButton = walk
			return pressed
		walk = walk.get_parent()
	return control


## Everything in the tree [param root] heads that a pointer can land on: each control on screen
## that does not let the pointer through, and each window embedded in another.
static func _pointer_takers(root: Node) -> Array[Node]:
	var found: Array[Node] = []
	var pending: Array[Node] = [root]
	while not pending.is_empty():
		var node: Node = pending.pop_back()
		var control: Control = node as Control
		var window: Window = node as Window
		if control != null:
			if not control.is_visible_in_tree():
				continue
			if control.get_mouse_filter_with_override() != Control.MOUSE_FILTER_IGNORE:
				found.append(control)
		elif window != null and window != root:
			if not window.visible:
				continue
			if window.is_embedded():
				found.append(window)
		pending.append_array(node.get_children(true))
	return found


## The box each of [param drawn] takes up in its viewport: a window's rectangle, and the box around
## a control's however it is turned or scaled.
##
## Worked out once for a click rather than once for each match. A plain word on a screen of prose
## matches a hundred labels, and asking all four thousand controls of a hall for their transform
## for each of them took a click by words 80 ms, where the matching alone takes half that.
static func _areas_of(drawn: Array[Node]) -> Array[Rect2]:
	var areas: Array[Rect2] = []
	for each: Node in drawn:
		var window: Window = each as Window
		if window != null:
			areas.append(Rect2(window.position, window.size))
		else:
			var control: Control = each
			areas.append(control.get_global_transform_with_canvas() * Rect2(Vector2.ZERO, control.size))
	return areas


## What a pointer at [param target]'s centre reaches instead of it, or null when nothing does.
##
## The engine's own order for which control takes the pointer: an embedded window over everything
## in the viewport that holds it, then the higher canvas layer, then the later in the tree. A
## control holding the target or held by it is part of the same click.
##
## A target whose centre its own container clips away is judged where the click will put it, since
## the click scrolls it into view first: what is drawn over its place now is not what it will land
## under. Judged not covered at all instead, a button below the fold of a roster that a full-screen
## page covered was picked over the ones in view, scrolled up under the page and pressed there.
##
## [param areas] holds the box around each of [param drawn], so everything whose box misses the
## point is passed over before anything costlier is asked of it. A window's box is in the space of
## the viewport it is embedded in, which is not the target's when the target is in another window,
## so a window is judged by [method _window_over] instead.
static func _cover_of(target: Control, drawn: Array[Node], areas: Array[Rect2]) -> Node:
	var viewport: Viewport = target.get_viewport()
	var point: Vector2 = _where_it_is_clicked(target)
	var layer: int = _layer_of(target)
	for at: int in drawn.size():
		var other: Node = drawn[at]
		var window: Window = other as Window
		if window != null:
			if _window_over(target, point, window):
				return window
			continue
		if not areas[at].has_point(point):
			continue
		var control: Control = other
		if control == target or control.is_ancestor_of(target) or target.is_ancestor_of(control):
			continue
		if control.get_viewport() != viewport:
			continue
		var its_layer: int = _layer_of(control)
		if its_layer < layer or (its_layer == layer and not control.is_greater_than(target)):
			continue
		if _holds(control, point) and not _clipped_away(control, point):
			return control
	return null


## Where a click at [param target] lands in its viewport: its centre, or where scrolling will bring
## the centre when a ScrollContainer holding it clips it away, as the click scrolls it first.
static func _where_it_is_clicked(target: Control) -> Vector2:
	var point: Vector2 = target.get_global_transform_with_canvas() * (target.size * 0.5)
	if _clipped_away(target, point):
		point = _where_it_lands(target, point)
	return point


## Whether the embedded [param window] is drawn over [param point], [param target]'s centre in its
## own viewport, with that point carried out to the viewport the window is embedded in.
##
## Over it when the window holds the point there and is not the window the target is in, and, when
## the target is in another window embedded in the same place, when it is stacked above that one:
## the embedder's list of windows runs from the bottom up, measured on 4.7.2. Judged only in the
## target's own viewport, a confirmation over a settings dialog did not cover the dialog's OK, and
## a click by words tied it with the confirmation's own.
static func _window_over(target: Control, point: Vector2, window: Window) -> bool:
	if window.get_parent() == null or window.is_ancestor_of(target):
		return false
	var host: Viewport = window.get_parent().get_viewport()
	for step: Dictionary in Screen.steps_out(target.get_viewport(), point):
		if step["viewport"] != host:
			continue
		var there: Vector2 = step["point"]
		if not Rect2(window.position, window.size).has_point(there):
			return false
		var through: Variant = step["through"]
		if not through is Window:
			return true
		var own: Window = through
		var stacked: Array[Window] = host.get_embedded_subwindows()
		return stacked.find(window) > stacked.find(own)
	return false


## Whether [param control] holds [param point], given in its viewport's coordinates.
static func _holds(control: Control, point: Vector2) -> bool:
	var placed: Transform2D = control.get_global_transform_with_canvas()
	# A control scaled to nothing holds no point, and inverting its transform is an engine error.
	if is_zero_approx(placed.determinant()):
		return false
	# The rectangle, which is the engine's own answer unless a script overrides `_has_point`; the
	# engine does not offer the overridden answer to scripts.
	return Rect2(Vector2.ZERO, control.size).has_point(placed.affine_inverse() * point)


## Where [param target]'s centre, now at [param point], will be once the click has scrolled it into
## view: moved as little as puts the whole of it inside each ScrollContainer holding it, innermost
## first, which is how one brings a control into view. A target larger than a container is centred
## in it. Only a ScrollContainer, because that is all a click scrolls: another container clipping
## what it holds, a collapsed section for one, leaves the target where it is.
static func _where_it_lands(target: Control, point: Vector2) -> Vector2:
	var drawn: Transform2D = target.get_global_transform_with_canvas()
	var half: Vector2 = (drawn * Rect2(Vector2.ZERO, target.size)).size * 0.5
	var landed: Vector2 = point
	var walk: Node = target.get_parent()
	while walk != null:
		var holder: ScrollContainer = walk as ScrollContainer
		if holder != null:
			var shown: Rect2 = holder.get_global_transform_with_canvas() * Rect2(Vector2.ZERO, holder.size)
			var low: Vector2 = shown.position + half
			var high: Vector2 = shown.end - half
			landed = Vector2(
				shown.get_center().x if low.x > high.x else clampf(landed.x, low.x, high.x),
				shown.get_center().y if low.y > high.y else clampf(landed.y, low.y, high.y)
			)
		walk = walk.get_parent()
	return landed


## Whether a click could not reach [param target] however it scrolled: its centre, where the click
## would bring it, outside its viewport or the one showing that on the screen, or clipped away by a
## container the click does not scroll. A drawer parked off the side of the screen, or anything
## outside the 64 by 64 viewport of a game with no window, was listed among the controls on screen.
static func _off_screen(target: Control) -> bool:
	var point: Vector2 = _where_it_is_clicked(target)
	if _clipped_away(target, point) or not target.get_viewport().get_visible_rect().has_point(point):
		return true
	var reached: Dictionary = Screen.reach(target.get_viewport(), point)
	var viewport: Viewport = reached["viewport"]
	var there: Vector2 = reached["point"]
	return not viewport.get_visible_rect().has_point(there)


## Whether a container clipping what it holds cuts [param point] off from [param control].
static func _clipped_away(control: Control, point: Vector2) -> bool:
	var walk: Node = control.get_parent()
	while walk != null:
		var holder: Control = walk as Control
		if holder != null and holder.clip_contents and not _holds(holder, point):
			return true
		walk = walk.get_parent()
	return false


## The canvas layer [param control] is drawn on, 0 for the viewport's own canvas.
static func _layer_of(control: Control) -> int:
	var layer: CanvasLayer = control.get_canvas_layer_node()
	return 0 if layer == null else layer.layer


## The controls a click by words could mean, each with its index, its path and the words that
## matched, [param said] holding those in the same order.
static func _candidates(targets: Array[Control], said: Array[String]) -> String:
	var named: Array[String] = []
	for index: int in mini(targets.size(), LISTED_CANDIDATES):
		var words: String = said[index].replace("\n", " ")
		if words.length() > 60:
			words = words.substr(0, 57) + "..."
		named.append('%d %s ("%s")' % [index, targets[index].get_path(), words])
	if targets.size() > LISTED_CANDIDATES:
		named.append("and %d more" % (targets.size() - LISTED_CANDIDATES))
	return "; ".join(named)
