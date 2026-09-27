extends RefCounted

## Which control a click means when it names the control by the words on it rather than by path.

const Queries = preload("runtime_queries.gd")
const Read = preload("reading.gd")
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
		if node is Control and Queries.says(node, wanted):
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
	var open: Array[int] = []
	for index: int in matched.size():
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
				'no control on screen%s says "%s", so nothing was clicked%s%s'
				% [under, wanted, _hidden_note(hidden), _covered_note(covered, cover)]
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


## How good a match [param target] is for a click: a button over what cannot be pressed, and then
## the whole of its words over a part of them.
static func _rank(target: Control, whole: bool) -> int:
	return (2 if target is BaseButton else 0) + (1 if whole else 0)


## Whether [param said] is the whole of what [param wanted] asks for. A glob is matched against the
## whole text already, so every match of one is whole.
static func _says_exactly(said: String, wanted: String) -> bool:
	var words: String = Queries.as_said(wanted)
	if words.contains("*") or words.contains("?"):
		return true
	return said.strip_edges().nocasecmp_to(words.strip_edges()) == 0


## [param count] matches of [param rank], as the start of a sentence.
static func _described(count: int, rank: int, wanted: String, under: String) -> String:
	var what: String = "button" if rank >= 2 else "control"
	var how: String = '"%s"' % wanted
	if not Queries.as_said(wanted).contains("*") and not Queries.as_said(wanted).contains("?"):
		how = ('exactly "%s"' if rank % 2 == 1 else '"%s" as part of more') % wanted
	if count == 1:
		return "the one %s on screen%s saying %s" % [what, under, how]
	return "%d %ss on screen%s say %s" % [count, what, under, how]


## Why the matches below [param rank] were passed over, said of one of them when [param one].
static func _passed_over(rank: int, one: bool) -> String:
	var says: String = "says" if one else "say"
	match rank:
		3:
			return "cannot be pressed or %s it as part of more" % says
		2:
			return "cannot be pressed"
		_:
			return "%s it as part of more" % says


## What to add to a refusal that found nothing on screen, when words matched controls out of sight.
static func _hidden_note(hidden: int) -> String:
	if hidden == 0:
		return ""
	return "; %d hidden control%s" % [hidden, " says it" if hidden == 1 else "s say it"]


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
## control holding the target or held by it is part of the same click. A target whose centre its
## own container clips away is judged not covered, since the click scrolls it into view first and
## what is drawn there now is not what it will land on.
##
## [param areas] holds the box around each of [param drawn], so everything whose box misses the
## point is passed over before anything costlier is asked of it.
static func _cover_of(target: Control, drawn: Array[Node], areas: Array[Rect2]) -> Node:
	var viewport: Viewport = target.get_viewport()
	var point: Vector2 = target.get_global_transform_with_canvas() * (target.size * 0.5)
	if _clipped_away(target, point):
		return null
	var layer: int = _layer_of(target)
	for at: int in drawn.size():
		if not areas[at].has_point(point):
			continue
		var other: Node = drawn[at]
		var window: Window = other as Window
		if window != null:
			if (
				window.get_parent() != null
				and window.get_parent().get_viewport() == viewport
				and not window.is_ancestor_of(target)
			):
				return window
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


## Whether [param control] holds [param point], given in its viewport's coordinates.
static func _holds(control: Control, point: Vector2) -> bool:
	var placed: Transform2D = control.get_global_transform_with_canvas()
	# A control scaled to nothing holds no point, and inverting its transform is an engine error.
	if is_zero_approx(placed.determinant()):
		return false
	# The rectangle, which is the engine's own answer unless a script overrides `_has_point`; the
	# engine does not offer the overridden answer to scripts.
	return Rect2(Vector2.ZERO, control.size).has_point(placed.affine_inverse() * point)


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
