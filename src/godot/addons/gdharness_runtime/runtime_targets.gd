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
	# Whether the words are only inside longer words there, "out" in "Scout".
	var inside: Array[bool] = []
	var hidden: int = 0
	# Controls saying exactly the words that a click cannot reach, kept to say what a match on screen
	# that only says them as part of more stands in for.
	var exact_out_of_reach: Array[Node] = []
	var out_of_reach_as: Array[String] = []
	var pending: Array[Node] = [reached["node"]]
	while not pending.is_empty():
		var node: Node = pending.pop_front()
		if node is Control and Says.says(node, wanted):
			if not Queries.shown(node):
				hidden += 1
				if _says_exactly(Words.said_by(node), wanted):
					exact_out_of_reach.append(node)
					out_of_reach_as.append("hidden")
			else:
				var control: Control = node
				var target: Control = _pressed_through(control)
				var words: String = Words.said_by(node)
				var whole: bool = _says_exactly(words, wanted)
				var buried: bool = not whole and _inside_a_word(words, wanted)
				var at: int = matched.find(target)
				if at == -1:
					matched.append(target)
					said.append(words)
					exact.append(whole)
					inside.append(buried)
				elif (whole and not exact[at]) or (inside[at] and not buried):
					said[at] = words
					exact[at] = whole
					inside[at] = buried
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
			if exact[index]:
				exact_out_of_reach.append(matched[index])
				out_of_reach_as.append("outside what the screen shows")
			continue
		var over: Node = _cover_of(matched[index], drawn, areas)
		if over == null:
			open.append(index)
		else:
			covered += 1
			if exact[index]:
				exact_out_of_reach.append(matched[index])
				out_of_reach_as.append("under %s, which is drawn over it" % over.get_path())
			if cover == null:
				cover = over
	# Stable, so matches of one rank keep the order they are drawn in. Words only inside longer words
	# come after everything else: ranked as a button saying them as part of more, "Scout, 90" was
	# pressed for "Out" over a control saying exactly "Out", and spent a game's silver.
	open.sort_custom(
		func(a: int, b: int) -> bool:
			if inside[a] != inside[b]:
				return inside[b]
			var first: int = _rank(matched[a], exact[a])
			var second: int = _rank(matched[b], exact[b])
			return first > second or (first == second and a < b)
	)
	var targets: Array[Control] = []
	var ranks: Array[int] = []
	var lines: Array[String] = []
	var wholes: Array[bool] = []
	var insides: Array[bool] = []
	for index: int in open:
		targets.append(matched[index])
		ranks.append(_rank(matched[index], exact[index]))
		lines.append(said[index])
		wholes.append(exact[index])
		insides.append(inside[index])

	var under: String = "" if root_path == "/root" else " under %s" % root_path
	if targets.is_empty():
		return {
			"type": "error",
			"message":
			(
				'no control on screen%s says "%s", so nothing was clicked%s%s%s%s'
				% [
					under,
					wanted,
					_hidden_note(hidden),
					_outside_note(outside),
					_covered_note(covered, cover),
					_open_menu_note(root, wanted),
				]
			)
		}
	var best: int = 0
	for at: int in targets.size():
		if ranks[at] == ranks[0] and insides[at] == insides[0]:
			best += 1
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
	# A match saying the words as part of more, while another control says exactly them, is a stand-in
	# for that one, not the control meant: a tab reading "Out" sat in a collapsed drawer and a dispatch
	# saying somebody "fell out in the hall" was pressed, and with the tab's own words on screen in a
	# control that is not a button, a card reading "Scout, 90" was. Pressed only when asked for by
	# index, which is the caller saying the match is what they meant.
	var exact_elsewhere: Array[Node] = exact_out_of_reach.duplicate()
	var elsewhere_as: Array[String] = out_of_reach_as.duplicate()
	# On screen only when it takes clicks itself: a heading saying exactly "Onward" beside a button
	# saying "Onward now" is not what a click on "Onward" is for, and the button is pressed.
	for other: int in targets.size():
		var taking: bool = targets[other].get_mouse_filter_with_override() != Control.MOUSE_FILTER_IGNORE
		if other != index and wholes[other] and taking:
			exact_elsewhere.append(targets[other])
			elsewhere_as.append("on screen, taking clicks but not an enabled button")
	var best_one: String = "the one on screen," if targets.size() == 1 else "the best match on screen,"
	if which == null and not wholes[index] and not exact_elsewhere.is_empty():
		return {
			"type": "error",
			"message":
			(
				(
					'no %s on screen%s says exactly "%s", so nothing was clicked: %s %s says it as part of'
					+ ' "%s", while %s; pass index %d to press that one anyway'
				)
				% [
					"button" if exact_elsewhere.size() > exact_out_of_reach.size() else "control",
					under,
					wanted,
					best_one,
					targets[index].get_path(),
					_shortened(lines[index]),
					_out_of_reach_exactly(exact_elsewhere, elsewhere_as),
					index,
				]
			)
		}
	if which == null and insides[index]:
		return {
			"type": "error",
			"message":
			(
				(
					'no control on screen%s says "%s" as a word of its own, so nothing was clicked: %s %s has'
					+ ' it only inside a longer word, "%s"; pass index %d to press that one anyway'
				)
				% [under, wanted, best_one, targets[index].get_path(), _shortened(lines[index]), index]
			)
		}
	# Words in a sentence on a control that lets the pointer through: the press lands on whatever is
	# under it, which is nothing the words name. A line saying what "is out there" was the best match
	# left for "Out" once the cards saying "Scout" were passed over.
	if (
		which == null
		and not wholes[index]
		and targets[index].get_mouse_filter_with_override() == Control.MOUSE_FILTER_IGNORE
	):
		return {
			"type": "error",
			"message":
			(
				(
					'no control on screen%s that takes a click says "%s", so nothing was clicked: %s %s says it'
					+ ' as part of "%s" and lets the pointer through to what is under it; pass index %d to'
					+ " click there anyway"
				)
				% [under, wanted, best_one, targets[index].get_path(), _shortened(lines[index]), index]
			)
		}
	var found: Dictionary = {"says": wanted, "index": index, "of": targets.size()}
	if not wholes[index]:
		found["partOf"] = _shortened(lines[index])
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
static func _says_exactly(written: String, wanted: String) -> bool:
	var said: String = Says.spaced(written)
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


## Whether [param written] has the plain words [param wanted] asks for only inside longer words,
## never starting where a word starts: "out" in "Scout". Words starting a longer one count as said,
## "Recruit" in "Recruits", and so does anything matched by a pattern.
static func _inside_a_word(written: String, wanted: String) -> bool:
	var said: String = Says.spaced(written).to_lower()
	var found: bool = false
	for words: String in Says.alternatives(wanted):
		var looked_for: String = words.to_lower()
		if not Says.is_plain(words) or not _in_a_word(looked_for.unicode_at(0)):
			return false
		var at: int = said.find(looked_for)
		while at >= 0:
			found = true
			if at == 0 or not _in_a_word(said.unicode_at(at - 1)):
				return false
			at = said.find(looked_for, at + 1)
	return found


## Whether the character [param code] is part of a word: a letter, a digit or an underscore. A letter
## is told by having a case, which leaves scripts without one counted as breaks between words.
static func _in_a_word(code: int) -> bool:
	var character: String = String.chr(code)
	return character.to_lower() != character.to_upper() or character.is_valid_int() or character == "_"


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
	while walk != null and not (walk is Viewport):
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
## Whatever else the scroll holds moves with it and is judged where it goes. Judged where it sat, the
## card at the top of a tray scrolled down was drawn over a button above the view, because a later
## card is drawn over an earlier one, and a button below the view was passed by the same card only
## because the cards beside the bottom edge come before it.
##
## [param areas] holds the box around each of [param drawn], so everything whose box misses the
## point is passed over before anything costlier is asked of it. A window's box is in the space of
## the viewport it is embedded in, which is not the target's when the target is in another window,
## so a window is judged by [method _window_over] instead.
static func _cover_of(target: Control, drawn: Array[Node], areas: Array[Rect2]) -> Node:
	var viewport: Viewport = target.get_viewport()
	var moves: Dictionary[ScrollContainer, Vector2] = _scrolls_for(target)
	var point: Vector2 = _centre_of(target) + _moved_by(target, moves)
	var layer: int = _layer_of(target)
	for at: int in drawn.size():
		var other: Node = drawn[at]
		var window: Window = other as Window
		if window != null:
			if _window_over(target, point, window):
				return window
			continue
		var control: Control = other
		# The point where this control is now, which is where the scroll will carry it to the point.
		var before: Vector2 = point - _moved_by(control, moves)
		if not areas[at].has_point(before):
			continue
		if control == target or control.is_ancestor_of(target) or target.is_ancestor_of(control):
			continue
		if control.get_viewport() != viewport:
			continue
		var its_layer: int = _layer_of(control)
		if its_layer < layer or (its_layer == layer and not control.is_greater_than(target)):
			continue
		if _holds(control, before) and not _clipped_away(control, point, moves):
			return control
	return null


## [param target]'s centre in its viewport, where it is now.
static func _centre_of(target: Control) -> Vector2:
	return target.get_global_transform_with_canvas() * (target.size * 0.5)


## How far the click moves what each ScrollContainer holding [param target] holds, to bring it into
## view: empty when no container clips it away, as nothing is scrolled then.
static func _scrolls_for(target: Control) -> Dictionary[ScrollContainer, Vector2]:
	var none: Dictionary[ScrollContainer, Vector2] = {}
	var centre: Vector2 = _centre_of(target)
	if not _clipped_away(target, centre, none):
		return none
	return _where_it_lands(target, centre)


## How far the scrolls in [param moves] carry [param node]: the sum over the containers holding it,
## and nothing for a container itself, which stays where it is while what it holds moves.
static func _moved_by(node: Node, moves: Dictionary[ScrollContainer, Vector2]) -> Vector2:
	var moved: Vector2 = Vector2.ZERO
	for holder: ScrollContainer in moves:
		if holder.is_ancestor_of(node):
			moved += moves[holder]
	return moved


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


## How far each ScrollContainer holding [param target] moves what it holds once the click has
## scrolled [param target], centred at [param point], into view: as little as puts the whole of it
## inside each, innermost first, which is how one brings a control into view. A target larger than a
## container is centred in it. Only a ScrollContainer, because that is all a click scrolls: another
## container clipping what it holds, a collapsed section for one, leaves the target where it is.
static func _where_it_lands(target: Control, point: Vector2) -> Dictionary[ScrollContainer, Vector2]:
	var drawn: Transform2D = target.get_global_transform_with_canvas()
	var half: Vector2 = (drawn * Rect2(Vector2.ZERO, target.size)).size * 0.5
	var moves: Dictionary[ScrollContainer, Vector2] = {}
	var landed: Vector2 = point
	var walk: Node = target.get_parent()
	while walk != null and not (walk is Viewport):
		var holder: ScrollContainer = walk as ScrollContainer
		if holder != null:
			var shown: Rect2 = holder.get_global_transform_with_canvas() * Rect2(Vector2.ZERO, holder.size)
			var low: Vector2 = shown.position + half
			var high: Vector2 = shown.end - half
			var next: Vector2 = Vector2(
				shown.get_center().x if low.x > high.x else clampf(landed.x, low.x, high.x),
				shown.get_center().y if low.y > high.y else clampf(landed.y, low.y, high.y)
			)
			if next != landed:
				moves[holder] = next - landed
			landed = next
		walk = walk.get_parent()
	return moves


## Whether a click could not reach [param target] however it scrolled: its centre, where the click
## would bring it, outside its viewport or the one showing that on the screen, or clipped away by a
## container the click does not scroll. A drawer parked off the side of the screen, or anything
## outside the 64 by 64 viewport of a game with no window, was listed among the controls on screen.
static func _off_screen(target: Control) -> bool:
	var moves: Dictionary[ScrollContainer, Vector2] = _scrolls_for(target)
	var point: Vector2 = _centre_of(target) + _moved_by(target, moves)
	if _clipped_away(target, point, moves) or not target.get_viewport().get_visible_rect().has_point(point):
		return true
	var reached: Dictionary = Screen.reach(target.get_viewport(), point)
	var viewport: Viewport = reached["viewport"]
	var there: Vector2 = reached["point"]
	return not viewport.get_visible_rect().has_point(there)


## Whether a container clipping what it holds cuts [param point] off from [param control], once the
## scrolls in [param moves] have carried each container wherever they carry it.
##
## Only up to the viewport [param control] is in. A dialog is a window, and the containers the game
## added it under are in another space: judged against a clipping one of those, every button of a
## confirmation was refused as off the screen while it sat in plain view.
static func _clipped_away(
	control: Control, point: Vector2, moves: Dictionary[ScrollContainer, Vector2]
) -> bool:
	var walk: Node = control.get_parent()
	while walk != null and not (walk is Viewport):
		var holder: Control = walk as Control
		if holder != null and holder.clip_contents and not _holds(holder, point - _moved_by(holder, moves)):
			return true
		walk = walk.get_parent()
	return false


## Where [param label] draws the words [param wanted] matched in it, in the label's own space, when
## they are part of its text: {"point"} on their middle, {"unplaced"} saying why there is none, or
## {} when the words are the whole text, whose middle is the label's.
##
## A line of a dispatch names two people, each a link to their page, and a press on the label's
## middle landed on the second name when the first was asked for, so the game opened the wrong page.
## Godot answers which line a character is on, where that line is and how wide it is drawn, and
## nothing narrower, so the place along the line is the font's measure of the text before the
## words. A line in another font or holding an image measures off from what is drawn, which a wide
## line with nothing between the words and its start hardly does.
static func point_on_words(label: RichTextLabel, wanted: String) -> Dictionary:
	var text: String = Says.spaced(Words.said_by(label))
	var start: int = -1
	var length: int = 0
	for words: String in Says.alternatives(wanted):
		if not Says.is_plain(words):
			continue
		var at: int = text.findn(words)
		if at >= 0 and (start < 0 or at < start):
			start = at
			length = words.length()
	if start < 0:
		return {"unplaced": "the words were matched as a pattern, which names no one place in the text"}
	if text.strip_edges().length() == length:
		return {}
	var line: int = label.get_character_line(start)
	var shown: Vector2i = label.get_line_range(line)
	if line < 0 or shown.x > start:
		return {"unplaced": "the label could not say which line the words are on"}
	var on_line: int = mini(length, shown.y - start) if shown.y > start else length
	var font: Font = label.get_theme_font("normal_font")
	var font_size: int = label.get_theme_font_size("normal_font_size")
	var before: float = _width(font, font_size, text.substr(shown.x, start - shown.x))
	var across: float = _width(font, font_size, text.substr(start, on_line))
	var frame: StyleBox = label.get_theme_stylebox("normal")
	var left: float = frame.get_margin(SIDE_LEFT)
	var room: float = label.size.x - left - frame.get_margin(SIDE_RIGHT)
	var spare: float = maxf(room - label.get_line_width(line), 0.0)
	var aligned: float = 0.0
	if label.horizontal_alignment == HORIZONTAL_ALIGNMENT_CENTER:
		aligned = spare * 0.5
	elif label.horizontal_alignment == HORIZONTAL_ALIGNMENT_RIGHT:
		aligned = spare
	var scrolled: float = label.get_v_scroll_bar().value if label.scroll_active else 0.0
	var x: float = clampf(left + aligned + before + across * 0.5, left, left + room)
	var top: float = frame.get_margin(SIDE_TOP) + label.get_line_offset(line) - scrolled
	return {"point": Vector2(x, top + label.get_line_height(line) * 0.5)}


## How wide [param font] at [param font_size] draws [param words] on one line.
static func _width(font: Font, font_size: int, words: String) -> float:
	return font.get_string_size(words, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size).x


## The canvas layer [param control] is drawn on, 0 for the viewport's own canvas.
static func _layer_of(control: Control) -> int:
	var layer: CanvasLayer = control.get_canvas_layer_node()
	return 0 if layer == null else layer.layer


## The controls a click by words could mean, each with its index, its path and the words that
## matched, [param said] holding those in the same order.
static func _candidates(targets: Array[Control], said: Array[String]) -> String:
	var named: Array[String] = []
	for index: int in mini(targets.size(), LISTED_CANDIDATES):
		named.append('%d %s ("%s")' % [index, targets[index].get_path(), _shortened(said[index])])
	if targets.size() > LISTED_CANDIDATES:
		named.append("and %d more" % (targets.size() - LISTED_CANDIDATES))
	return "; ".join(named)


## What to add to a refusal that found nothing on screen, when an open menu has an item saying the
## words: a menu draws its items rather than holding a control for each, so a click finds none, while
## a wait for the words finds the item. A wait met on "Leave the hall" was followed by a click on it
## refused as nothing on screen saying it, with no word of the call that chooses it.
static func _open_menu_note(root: Node, wanted: String) -> String:
	var pending: Array[Node] = [root]
	while not pending.is_empty():
		var node: Node = pending.pop_back()
		var menu: PopupMenu = node as PopupMenu
		if menu != null and menu.visible:
			for item: int in menu.item_count:
				var text: String = menu.get_item_text(item)
				if Says.matches(text, wanted):
					var owner: Node = menu.get_parent()
					var named: Node = owner if owner is MenuButton or owner is OptionButton else menu
					return (
						(
							'; the open menu %s has an item saying it, "%s", which a click cannot reach:'
							+ ' choose it with runtime_input choose, path %s and text "%s"'
						)
						% [menu.get_path(), text, named.get_path(), text]
					)
		pending.append_array(node.get_children(true))
	return ""


## [param words] on one line and at most sixty characters, for naming a control by what it says.
static func _shortened(words: String) -> String:
	var flat: String = words.replace("\n", " ").strip_edges()
	return flat if flat.length() <= 60 else flat.substr(0, 57) + "..."


## The controls in [param nodes], each saying the words exactly and out of a click's reach for the
## reason [param why] holds at the same place, as the end of a sentence.
static func _out_of_reach_exactly(nodes: Array[Node], why: Array[String]) -> String:
	var first: String = "%s, %s" % [nodes[0].get_path(), why[0]]
	if nodes.size() == 1:
		return "1 control says exactly that and cannot be clicked: %s" % first
	return "%d controls say exactly that and cannot be clicked, such as %s" % [nodes.size(), first]
