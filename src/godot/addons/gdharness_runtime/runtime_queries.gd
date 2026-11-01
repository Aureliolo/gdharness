extends RefCounted
## What the server asks about the running tree: its shape, one node, the nodes matching a
## question, where one is on screen, a property's value, the metrics. What it changes, a property
## written or a method called, is in runtime_changes.gd.

const GdhFrames = preload("runtime_frames.gd")
const GdhPaths = preload("runtime_paths.gd")
const GdhRead = preload("reading.gd")
const GdhSays = preload("runtime_says.gd")
const GdhScreen = preload("runtime_screen.gd")
const GdhValues = preload("runtime_values.gd")
const GdhWords = preload("runtime_words.gd")
## The most nodes one find answers with, unless asked for fewer: enough for any real query and
## far short of the tree dump a query exists to avoid.
const FIND_LIMIT: int = 100
## What a find can be narrowed by, which is also what it refuses to answer without. Named once so
## the refusal lists the same set the walk reads.
const FILTERS: PackedStringArray = ["class", "script", "name", "group", "says"]
## The most lines one read answers with, unless asked for fewer. A screen is a few dozen. A
## thousand is a tree somebody pointed this at by mistake.
const READ_LIMIT: int = 500
## The most either can be asked for. A limit above it is refused rather than cut to it: the ceiling
## was the default for a read, so the remedy its own answer gave, raising the limit, changed nothing
## and said nothing, and a caller told to raise a number that stays put concludes the screen moved.
const LIMIT_CEILING: int = 5000

var _host: Node
var _values: GdhValues
var _frames: GdhFrames


## The host is the autoload, which is how the tree is reached: it is not in one when the
## modules are built, and a fixture may put it in one later. [param frames] is the autoload's,
## timing the frames since the runtime's first.
func _init(host: Node, values: GdhValues, frames: GdhFrames) -> void:
	_host = host
	_values = values
	_frames = frames


## The tree under a node, to a depth, with every stored property on each node when asked for all
## of them or the named ones when a list is given.
##
## The list is the shape most questions about a screen take: the `text` of every label and
## button under a panel. All of them for one row of a form answered seventy-six thousand
## characters, and the same question as a find with one property answered two.
func get_tree(params: Dictionary) -> Dictionary:
	var root_path: String = str(params.get("root", "/root"))
	var max_depth: int = GdhRead.as_int(params.get("depth", 3), 3)
	var include_properties: bool = GdhRead.as_bool(params.get("include_properties", false))
	var named: Array[String] = []
	var listed: Variant = params.get("properties", [])
	if listed is Array:
		for each: Variant in listed:
			named.append(str(each))
	else:
		return { "type": "error", "message": "properties must be a list of property names" }

	var reached: Dictionary = GdhValues.node_at(_host.get_tree().root, root_path)
	if reached.has("message"):
		return reached
	var root: Node = reached["node"]

	# A game whose first scene hands over to another shows a tree that names neither, so which
	# scene is showing was guessed from the project's documentation.
	var scene: Node = _host.get_tree().current_scene
	var showing: Variant = null
	if scene != null:
		showing = { "path": str(scene.get_path()), "file": scene.scene_file_path }
	return {
		"type": "tree",
		"root": _serialize_node_tree(root, 0, max_depth, include_properties, named),
		"current_scene": showing,
	}


## Nodes matching every filter given, as paths, so a caller can name what it wants without
## reading the whole tree to find it. `class` matches native classes and their subclasses, and
## the global name of a script class; `name` is a case-insensitive glob, or several separated by `|`
## the way `says` takes them, with `\|` for a bar in a name; `script` is a path;
## `says` is what the node has written on it.
##
## `property` names one to read off each of them, which is the difference between one question and
## one call per answer. A panel of a dozen labels took thirteen calls to read, and a tree that
## rebuilds between them, which any HUD following a clock does, hands back paths that are gone by
## the time they are asked about. A node without that property says so rather than answering null,
## because null is what a node holding null answers.
##
## `include_hidden` defaults to true, because a find is a question about the tree and a caller
## naming a class or a group means the node whether or not it is on screen. Passing false asks the
## other question, the one a screen is checked against: a panel that keeps a label for every line
## that might apply and hides the ones that do not answers with what the player is reading, rather
## than with every line it is holding in case. How many matches that left out is counted and said,
## because "none" and "four, all hidden" are different answers and used to read the same.
func find_nodes(params: Dictionary) -> Dictionary:
	var root_path: String = str(params.get("root", "/root"))
	var wanted: Dictionary[String, String] = {}
	for filter: String in FILTERS:
		wanted[filter] = str(params.get(filter, ""))
	var wanted_property: String = str(params.get("property", ""))
	var include_hidden: bool = GdhRead.as_bool(params.get("include_hidden", true), true)
	var limit: int = GdhRead.as_int(params.get("limit", FIND_LIMIT), FIND_LIMIT)
	if limit < 1 or limit > LIMIT_CEILING:
		return {
			"type": "error",
			"message": "limit is from 1 to %d, and %d was asked for" % [LIMIT_CEILING, limit],
		}

	if not _anything_asked(wanted):
		return {
			"type": "error", "message": "find_nodes needs at least one of " + ", ".join(FILTERS),
		}
	if not wanted["script"].is_empty() and not wanted["script"].begins_with("res://"):
		wanted["script"] = "res://" + wanted["script"]

	# Split once here rather than for each node the walk passes.
	var names: Array[String] = GdhSays.split_at_bars(wanted["name"])
	if not wanted["name"].is_empty() and names.is_empty():
		var bars_only: String = (
			'name "%s" is only bars, so it names no node. Write the names between them'
		)
		return { "type": "error", "message": bars_only % wanted["name"] }

	var reached: Dictionary = GdhValues.node_at(_host.get_tree().root, root_path)
	if reached.has("message"):
		return reached
	var root: Node = reached["node"]

	var found: Array[Dictionary] = []
	var found_nodes: Array[Node] = []
	var pending: Array[Node] = [root]
	var truncated: bool = false
	# Counted while the tree is already being walked, for the answer below: how many nodes this
	# find would have matched if the name had been read the way it was probably meant.
	var plain_names: Array[String] = []
	for named: String in names:
		if GdhSays.is_plain(named):
			plain_names.append(named)
	var nearly: int = 0
	# The same for the words: a glob is matched against the whole text, and one written as a prefix
	# by habit, "Taken together*", missed the label whose sentence those words are in the middle of.
	# Nothing found then read as the words not being on screen, which is the wrong conclusion when
	# checking that a change to the text landed.
	var widened_says: String = GdhSays.widened(wanted["says"])
	var widened: Dictionary[String, String] = {}
	for filter: String in wanted:
		widened[filter] = widened_says if filter == "says" else wanted[filter]
	var nearly_said: int = 0
	# The near misses the same find would leave out as hidden, kept apart: the note says what a
	# query would find, and counting these in it named a query that, asked, found none of them.
	var nearly_hidden: int = 0
	var nearly_said_hidden: int = 0
	var hidden: int = 0
	var out_of_view: int = 0
	while not pending.is_empty():
		var node: Node = pending.pop_front()
		var rest: bool = _matches_apart_from_name(node, wanted)
		if rest and _named(node, names):
			if not include_hidden and not shown(node):
				hidden += 1
			elif not include_hidden and not GdhScreen.in_view(node):
				out_of_view += 1
			elif found.size() >= limit:
				truncated = true
				break
			else:
				found.append(_found(node, wanted_property))
				found_nodes.append(node)
		elif rest and _contains_any(str(node.name), plain_names):
			if include_hidden or readable(node):
				nearly += 1
			else:
				nearly_hidden += 1
		elif (
			not widened_says.is_empty()
			and _named(node, names)
			and _matches_apart_from_name(node, widened)
		):
			if include_hidden or readable(node):
				nearly_said += 1
			else:
				nearly_said_hidden += 1
		# Internal children included, which they were not. A ConfirmationDialog builds its Yes and
		# its No as internal nodes, and a ScrollContainer its bars, so a find over a screen for
		# every Button came back without the two buttons the player is being asked to press:
		# nothing here could see the dialog at all, and the way past it was to emit `confirmed`.
		# A filtered query carries no cost for including them, because they only appear when they
		# are what was asked for.
		var children: Array[Node] = node.get_children(true)
		for index: int in range(children.size() - 1, -1, -1):
			pending.push_front(children[index])

	var answer: Dictionary = {
		"type": "nodes", "count": found.size(), "truncated": truncated, "nodes": found,
	}
	var notes: Array[String] = []
	# Each still listed, since a caller may mean one of them, and marked, so one sign drawn as a
	# label and its outline copies is not read as four signs. The outermost match it copies, since a
	# find under one of the copies has left the label they all copy outside it.
	var copies: int = 0
	for index: int in range(found_nodes.size()):
		var at: int = -1
		for original: Node in GdhWords.copied_through(found_nodes[index]):
			var matched: int = found_nodes.find(original)
			if matched != -1:
				at = matched
		if at != -1:
			found[index]["copyOf"] = found[at]["path"]
			copies += 1
	if copies > 0:
		answer["distinct"] = found.size() - copies
		(
			notes
			. append(
				(
					(
						"%d of the %d matches %s drawn under a match saying the same words, as an "
						+ "outline or a glow is drawn, and %s it under copyOf: %d distinct"
					)
					% [
						copies,
						found.size(),
						"is a copy" if copies == 1 else "are copies",
						"names" if copies == 1 else "name",
						found.size() - copies,
					]
				)
			)
		)
	# Nothing found is the one answer that cannot be told apart from having asked the wrong
	# question, and a name written without a wildcard is the way an agent writes "contains".
	# Said only when it changes the answer, so a genuine nothing stays a plain nothing.
	if found.is_empty() and nearly + nearly_hidden > 0:
		var named_near: int = nearly if nearly > 0 else nearly_hidden
		var holding: String = "names contain" if named_near > 1 else "name contains"
		var near_words: Array[String] = []
		for named: String in plain_names:
			near_words.append('"%s"' % named)
		var opened: Array[String] = []
		for named: String in names:
			opened.append("*%s*" % named if GdhSays.is_plain(named) else named)
		(
			notes
			. append(
				(
					(
						"name is matched as a glob against the whole name. %d %snode %s %s, which "
						+ '"%s"%s would find'
					)
					% [
						named_near,
						"" if nearly > 0 else "hidden or out-of-view ",
						holding,
						" or ".join(PackedStringArray(near_words)),
						GdhSays.joined_at_bars(opened),
						"" if nearly > 0 else " with includeHidden true",
					]
				)
			)
		)
	if found.is_empty() and nearly_said + nearly_said_hidden > 0:
		var said_near: int = nearly_said if nearly_said > 0 else nearly_said_hidden
		(
			notes
			. append(
				(
					(
						"says with a wildcard is matched as a glob against a node\'s whole text. "
						+ '"%s"%s would find %d %snode%s'
					)
					% [
						widened_says,
						"" if nearly_said > 0 else " with includeHidden true",
						said_near,
						"" if nearly_said > 0 else "hidden or out-of-view ",
						"" if said_near == 1 else "s",
					]
				)
			)
		)
	# How many the filter took out, so a short answer is not read as a small screen. Left out
	# entirely when nothing was hidden, which keeps a plain answer plain.
	if hidden > 0:
		answer["hidden"] = hidden
		notes.append(
			(
				"%d matching node%s hidden and left out. includeHidden true answers with them too"
				% [hidden, "" if hidden == 1 else "s"]
			)
		)
	if out_of_view > 0:
		answer["out_of_view"] = out_of_view
		(
			notes
			. append(
				(
					(
						"%d matching node%s drawn outside the viewport or scrolled out of a "
						+ "ScrollContainer and left out. includeHidden true answers with them too"
					)
					% [out_of_view, "" if out_of_view == 1 else "s"]
				)
			)
		)
	if not notes.is_empty():
		answer["note"] = ". ".join(notes) + "."
	return answer


## Whether the player can see [param node], by the rule the engine draws by.
##
## A CanvasItem's visibility comes down through CanvasItem parents only, and one whose parent is not
## a CanvasItem starts again from its canvas: measured on 4.7.2, a Label under a plain Node under a
## hidden panel, and one under a hidden Node3D, both answer visible in tree, while one straight
## under the panel does not. Walking every ancestor called those two hidden, so their words were
## left off a screen that showed them and a wait on them ran out. What a CanvasItem's rule leaves
## out is its canvas: a hidden layer hides everything drawn on it while each item keeps its own
## flag, and a hidden window everything in it. A wait on words asks the same, so it reads this too.
static func shown(node: Node) -> bool:
	var item: CanvasItem = node as CanvasItem
	if item != null:
		return item.is_visible_in_tree() and _on_a_shown_canvas(item)
	var spatial: Node3D = node as Node3D
	if spatial != null:
		return spatial.is_visible_in_tree() and _in_shown_windows(spatial)
	var layer: CanvasLayer = node as CanvasLayer
	if layer != null:
		return layer.visible and _in_shown_windows(layer)
	var window: Window = node as Window
	if window != null:
		return window.visible and _in_shown_windows(window.get_parent())
	# A node that draws nothing is shown when what it sits in is.
	var parent: Node = node.get_parent()
	return parent == null or shown(parent)


## Whether the player can read [param node]: [method shown], and drawn inside its viewport and every
## ScrollContainer holding it, see [method GdhScreen.in_view]. A click by words asks [method shown]
## alone, since it scrolls what it presses into view.
static func readable(node: Node) -> bool:
	return shown(node) and GdhScreen.in_view(node)


## Whether the canvas [param item] is drawn on is showing: its layer, and the windows around it.
static func _on_a_shown_canvas(item: CanvasItem) -> bool:
	var walk: Node = item.get_parent()
	while walk != null:
		var layer: CanvasLayer = walk as CanvasLayer
		if layer != null:
			return layer.visible and _in_shown_windows(layer)
		if walk is Viewport:
			return _in_shown_windows(walk)
		walk = walk.get_parent()
	return true


## Whether every window [param node] sits in is showing, itself included when it is one.
static func _in_shown_windows(node: Node) -> bool:
	var walk: Node = node
	while walk != null:
		var window: Window = walk as Window
		if window != null and not window.visible:
			return false
		walk = walk.get_parent()
	return true


## One match, with the named property on it when one was named.
##
## `has_property` alongside the value, because a node that has not got it and a node holding null
## are different answers and a bare null reads as the second. The same distinction the `property`
## op makes by refusing, which it cannot do here: a find over a panel matches nodes of several
## classes on purpose, and refusing the whole answer because one of them has no `text` would make
## the question unaskable.
func _found(node: Node, wanted_property: String) -> Dictionary:
	var entry: Dictionary = _serialize_node(node, false)
	if wanted_property.is_empty():
		return entry
	entry["property"] = wanted_property
	# Through a path as well, for the reason [method GdhPaths.walk_to] gives. A step that is not
	# there on this node reads as not having the property rather than as a refusal, which is the
	# rule this whole function is written to: a find matches nodes of several classes on purpose.
	var reached: Dictionary = GdhPaths.walk_to(node, str(entry["path"]), wanted_property)
	if reached.has("message"):
		entry["has_property"] = false
		return entry
	var holder: Variant = reached["holder"]
	var named: String = reached["name"]
	var has: bool = GdhPaths.can_read(holder, named)
	entry["has_property"] = has
	if has:
		entry["value"] = _values.serialize(GdhPaths.read_under(holder, named))
	return entry


## Whether the caller named anything to match on, since every filter left out matches everything
## and a find with none of them is the whole tree by another name.
static func _anything_asked(wanted: Dictionary[String, String]) -> bool:
	for filter: String in wanted:
		if not wanted[filter].is_empty():
			return true
	return false


## Whether [param node] carries one of the names a find asked for. None matches everything, which is
## what makes leaving a filter out the same as not having one.
static func _named(node: Node, names: Array[String]) -> bool:
	if names.is_empty():
		return true
	var called: String = str(node.name)
	for pattern: String in names:
		if called.matchn(pattern):
			return true
	return false


static func _contains_any(called: String, words: Array[String]) -> bool:
	for word: String in words:
		if called.containsn(word):
			return true
	return false


## Every filter but the name, so a find that came back empty can say how many nodes the name was
## the only thing standing between it and.
func _matches_apart_from_name(node: Node, wanted: Dictionary[String, String]) -> bool:
	if not wanted["group"].is_empty() and not node.is_in_group(wanted["group"]):
		return false
	# What this node says, rather than everything said underneath it. A row is then found by the
	# label in it, and the path answered is that label's, which is where the words a caller is
	# looking at actually are: matching every container above it would answer with the screen.
	if not wanted["says"].is_empty() and not GdhSays.says(node, wanted["says"]):
		return false
	var script: Variant = node.get_script()
	if not wanted["script"].is_empty():
		if not script is Script:
			return false
		var attached: Script = script
		if attached.resource_path != wanted["script"]:
			return false
	if not wanted["class"].is_empty() and not node.is_class(wanted["class"]):
		if not script is Script:
			return false
		var attached: Script = script
		if not _script_is(attached, wanted["class"]):
			return false
	return true


## Whether [param attached] is the script class [param wanted], the way a typed `is` reads it: its
## own class_name, or one it extends at any distance.
##
## The class_name alone answered 0 for `Card` over a tree of rows whose scripts extend Card two
## steps down, IntakeRow extends DocketCard extends Card, while `is_class` reaches every native
## subclass. A caller naming a class means what extends it, whichever side of the line the class
## is declared on.
static func _script_is(attached: Script, wanted: String) -> bool:
	var walk: Script = attached
	while walk != null:
		if walk.get_global_name() == wanted:
			return true
		walk = walk.get_base_script()
	return false


## Every line of text under a node, in the order somebody reads the screen.
##
## The question a caller asks most often, and the one that cost the most to answer: reading a panel
## was a find for every label with the path of each beside it, a few hundred characters apiece to
## carry a sentence of six words. Long is the smaller half of it. A find answers off nodes nobody
## can see, and a panel keeps its empty state in the tree beside its rows, so "Nothing posted" came
## back next to the three things posted and was believed twice in one session.
##
## A hidden node is left out and so is everything under it, because what a player reads is what is
## drawn. [param include_hidden] asks for the lot instead, which is what a caller checking that
## something is not showing wants.
##
## [param limit] is the first few lines rather than all of them, which is how the top of a screen
## is read without the hall under it: the bar along the top of a guild is eleven lines and the
## panel it sits on is two hundred. `omitted` says how many lines that left behind, so a screen
## whose interesting half is below the cut says so in a number rather than in a flag.
func read_text(params: Dictionary) -> Dictionary:
	var root_path: String = str(params.get("root", "/root"))
	var include_hidden: bool = GdhRead.as_bool(params.get("include_hidden", false))
	var limit: int = GdhRead.as_int(params.get("limit", READ_LIMIT), READ_LIMIT)
	if limit < 1 or limit > LIMIT_CEILING:
		return {
			"type": "error",
			"message": "limit is from 1 to %d, and %d was asked for" % [LIMIT_CEILING, limit],
		}

	var reached: Dictionary = GdhValues.node_at(_host.get_tree().root, root_path)
	if reached.has("message"):
		return reached
	var root: Node = reached["node"]

	# The rest of the subtree is walked and counted rather than stopped at. A flag on its own gets
	# read as a footnote: a screen answered with its first few hundred lines and the dialog the
	# player is being asked to answer below them reads exactly like a dialog that is not there,
	# and a bare `truncated: true` was looked straight past twice before the limit was suspected.
	# A number is what sends somebody back.
	var lines: Array[String] = []
	var tally: Dictionary[String, int] = { "omitted": 0, "out_of_view": 0, "copies": 0 }
	_read_into(root, include_hidden, limit, lines, tally)
	var answer: Dictionary = {
		"type": "text",
		"root": root_path,
		"lines": lines,
		"count": lines.size(),
		"truncated": tally["omitted"] > 0,
		"omitted": tally["omitted"],
	}
	var notes: Array[String] = []
	if tally["out_of_view"] > 0:
		answer["out_of_view"] = tally["out_of_view"]
		(
			notes
			. append(
				(
					(
						"%d line%s drawn outside the viewport or scrolled out of a "
						+ "ScrollContainer, where the player cannot read them, left out. "
						+ "includeHidden true answers with them too"
					)
					% [tally["out_of_view"], "" if tally["out_of_view"] == 1 else "s"]
				)
			)
		)
	if tally["copies"] > 0:
		answer["copies"] = tally["copies"]
		(
			notes
			. append(
				(
					(
						"%d line%s drawn as a copy under a node saying the same words, as an "
						+ "outline or a glow is drawn, read once with the words %s"
					)
					% [
						tally["copies"],
						"" if tally["copies"] == 1 else "s",
						"it copies" if tally["copies"] == 1 else "they copy",
					]
				)
			)
		)
	if not notes.is_empty():
		answer["note"] = ". ".join(notes) + "."
	return answer


## Walks [param node] depth first, which is the order the screen is laid out in and the order a
## person reads it.
##
## Internal children as well, because the number in a SpinBox is one: the field a player reads it in
## is a LineEdit the engine builds inside the box and leaves out of `get_children()`, so a screen
## full of forms answered with every label on it and none of the values in it. The hidden check
## covers a [Window] for the same walk: a dropdown's popup is a child that is not drawn until it is
## opened, and reading a closed menu would put every item on the screen. Fills [param into] up to
## [param most] lines and counts in [param tally] how many further lines the rest of the subtree
## says, under omitted, and how many it says out of view, under out_of_view, which is what the
## caller is told rather than left to infer.
##
## Asked of each node rather than cut off at the first hidden one, since a hidden panel does not
## hide a label reached through a plain Node: see [method shown].
func _read_into(
	node: Node, include_hidden: bool, most: int, into: Array[String], tally: Dictionary[String, int]
) -> void:
	if include_hidden or shown(node):
		var said: Array[String] = GdhWords.lines_said_by(node)
		# A copy drawn under the words it copies, as an outline or a glow is, reads once. Only while
		# what it copies is itself read, so an original hidden or drawn out of view does not take
		# the words with it.
		var original: Node = GdhWords.copied_from(node) if not said.is_empty() else null
		if original != null and (include_hidden or readable(original)):
			tally["copies"] += said.size()
		elif not include_hidden and not GdhScreen.in_view(node):
			tally["out_of_view"] += said.size()
		else:
			for line: String in said:
				if into.size() < most:
					into.append(line)
				else:
					tally["omitted"] += 1
	for child: Node in node.get_children(true):
		_read_into(child, include_hidden, most, into, tally)


## Where a node is on screen: a Control's rectangle, a Node2D's position, or the place a 3D node
## is drawn in, in both the canvas coordinates the node reports and the window pixels input
## arrives in. The two differ whenever the project stretches its viewport, which is what made a
## rect unusable for a click.
func get_rect(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	if node_path.is_empty():
		return { "type": "error", "message": "Node path required" }

	var standing: Dictionary = GdhValues.node_at(_host.get_tree().root, node_path)
	if standing.has("message"):
		return standing
	var node: Node = standing["node"]

	# In the window's pixels, which is what a mouse event names, through every embedded window and
	# SubViewport between the node and the window: multiplied by its own viewport's transform alone,
	# a control in a dialog lost the dialog's offset and one in a SubViewport was given its place in
	# the SubViewport, and a mouse event sent there missed it.
	if node is Control:
		var control: Control = node
		var canvas_rect: Rect2 = control.get_global_rect()
		var answer: Dictionary = {
			"type": "rect",
			"path": node_path,
			"visible": control.is_visible_in_tree(),
			"in_view": GdhScreen.in_view(control),
			"canvas": _values.serialize(canvas_rect),
			"window":
			_values.serialize(
				GdhScreen.rect_in_window(
					control.get_viewport(),
					control.get_global_transform_with_canvas() * Rect2(Vector2.ZERO, control.size)
				)
			),
		}
		# Visible and in view read as clickable for a button under a dialog covering the screen,
		# which a click by its words refused. Loaded here, since runtime_targets preloads this
		# script.
		if answer["visible"] and answer["in_view"]:
			var own: Script = get_script()
			var targets: GDScript = load(
				own.resource_path.get_base_dir().path_join("runtime_targets.gd")
			)
			var over: Variant = targets.call("drawn_over", control)
			if over is Node:
				var cover: Node = over
				answer["drawn_over"] = str(cover.get_path())
		return answer
	if node is Node2D:
		var item: Node2D = node
		var canvas_position: Vector2 = item.get_global_transform_with_canvas().origin
		var window_position: Vector2 = GdhScreen.in_window(item.get_viewport(), canvas_position)
		var at: Dictionary = {
			"type": "point",
			"path": node_path,
			"visible": item.is_visible_in_tree(),
			"canvas": _values.serialize(canvas_position),
			"window": _values.serialize(window_position),
		}
		for local: Rect2 in _drawn_rect(item):
			var covered: Rect2 = item.get_global_transform_with_canvas() * local
			at["covers"] = {
				"canvas": _values.serialize(covered),
				"window": _values.serialize(GdhScreen.rect_in_window(item.get_viewport(), covered)),
			}
		return at
	if node is Node3D:
		var spatial: Node3D = node
		return _in_the_frame(node_path, spatial)
	return {
		"type": "error",
		"message": "%s is a %s, which has no place on screen" % [node_path, node.get_class()],
	}


## The rectangle a 2D node's own geometry takes up in its own coordinates, as the one entry of the
## list, which is empty for a node that has none of its own: a sprite's texture, a collision shape's
## shape, the points of a polygon or a line. A Node2D answered only where it stands, so the extent
## of a floor or a sprite to aim inside was a read of its shape and some arithmetic.
static func _drawn_rect(item: Node2D) -> Array[Rect2]:
	var drawn: Array[Rect2] = []
	var sprite: Sprite2D = item as Sprite2D
	if sprite != null:
		if sprite.texture != null:
			drawn.append(sprite.get_rect())
		return drawn
	var shaped: CollisionShape2D = item as CollisionShape2D
	if shaped != null:
		if shaped.shape != null:
			drawn.append(shaped.shape.get_rect())
		return drawn
	var points: PackedVector2Array = []
	var offset: Vector2 = Vector2.ZERO
	if item is Polygon2D:
		var polygon: Polygon2D = item
		points = polygon.polygon
		offset = polygon.offset
	elif item is CollisionPolygon2D:
		var outline: CollisionPolygon2D = item
		points = outline.polygon
	elif item is Line2D:
		var line: Line2D = item
		points = line.points
	if points.is_empty():
		return drawn
	var bounds: Rect2 = Rect2(points[0] + offset, Vector2.ZERO)
	for point: Vector2 in points:
		bounds = bounds.expand(point + offset)
	drawn.append(bounds)
	return drawn


## Where a 3D node is in the frame drawing it: the point to aim at, and the rectangle its own
## geometry covers, each in canvas coordinates and in window pixels.
##
## A 3D node had no answer here at all, so placing one meant reading its position, finding the
## camera and calling unproject_position by hand. Three calls, and anything that walks has walked
## between the first and the third: the aim lands where the thing used to be.
##
## The camera is named in the answer, because "where is it on screen" is a question about a camera
## and a game with two of them has two answers.
func _in_the_frame(node_path: String, item: Node3D) -> Dictionary:
	var found: Dictionary = in_frame(item)
	if found.is_empty():
		return {
			"type": "error",
			"message":
			"%s is not in a viewport with a current Camera3D, so nothing is drawing it" % node_path,
		}

	var drawn_in: Viewport = item.get_viewport()
	var answer: Dictionary = {
		"type": "point",
		"path": node_path,
		"visible": item.is_visible_in_tree(),
		"camera": found["camera"],
		"behind_camera": found["behind"],
	}
	if found.has("aim"):
		var aim: Vector2 = found["aim"]
		answer["canvas"] = _values.serialize(aim)
		answer["window"] = _values.serialize(GdhScreen.in_window(drawn_in, aim))
	if found.has("rect"):
		var covered: Rect2 = found["rect"]
		answer["covers"] = {
			"canvas": _values.serialize(covered),
			"window": _values.serialize(GdhScreen.rect_in_window(drawn_in, covered)),
		}
	return answer


## What anything aiming at a 3D node needs: the camera that draws it, whether it is behind that
## camera, the point on screen to aim at, and the rectangle it covers. Empty when no camera is
## drawing it at all.
##
## The aim is the middle of what the node draws rather than its origin, because a person clicking
## a character clicks the character and a character's origin is on the floor under their feet. A
## node that draws nothing has no middle and falls back to the origin, which is still a place.
##
## Absent keys rather than nulls: nothing drawn, or behind the camera, and each of those is a
## different answer from a coordinate that happens to be zero. Public and static because the click
## has to aim at the same point this reports, and two copies of the arithmetic would be two places
## on screen for one node the first time either changed.
static func in_frame(item: Node3D) -> Dictionary:
	var viewport: Viewport = item.get_viewport()
	if viewport == null:
		return {}
	var camera: Camera3D = viewport.get_camera_3d()
	if camera == null:
		return {}

	var origin: Vector3 = item.global_transform.origin
	var found: Dictionary = {
		"camera": str(camera.get_path()), "behind": camera.is_position_behind(origin),
	}
	var box: AABB = drawn_box(item)
	var draws: bool = box.size != Vector3.ZERO
	var middle: Vector3 = box.get_center() if draws else origin
	if not camera.is_position_behind(middle):
		found["aim"] = camera.unproject_position(middle)
	if draws:
		found.merge(_around(box, camera))
	return found


## The rectangle [param box] covers on screen, under the key `rect`, or nothing when any of it is
## behind the camera.
##
## All eight corners, because a box in space is not a box in the frame: an orthographic camera
## looking down a diagonal draws a cube as a hexagon, and the rectangle worth answering is the one
## around every corner of it. Nothing rather than a guess when a corner is behind the camera,
## because [method Camera3D.unproject_position] mirrors those back into view and a rectangle built
## from one is a rectangle somewhere else entirely.
static func _around(box: AABB, camera: Camera3D) -> Dictionary:
	var seen: Rect2 = Rect2()
	for index: int in 8:
		var corner: Vector3 = box.get_endpoint(index)
		if camera.is_position_behind(corner):
			return {}
		var point: Vector2 = camera.unproject_position(corner)
		seen = Rect2(point, Vector2.ZERO) if index == 0 else seen.expand(point)
	return { "rect": seen }


## The box everything drawn under [param item] fits in, in world space, or a box with no size when
## nothing under it draws.
##
## Walked rather than asked of [param item] itself, because the node a caller names is the one that
## moves and the thing on screen is the mesh hanging off it: a character is a Node3D with a
## skeleton and a mesh under it, and the Node3D has no extent of its own at all.
static func drawn_box(item: Node3D) -> AABB:
	var merged: AABB = AABB()
	var found: bool = false
	var pending: Array[Node] = [item]
	while not pending.is_empty():
		var node: Node = pending.pop_back()
		var visual: VisualInstance3D = node as VisualInstance3D
		if visual != null and visual.is_visible_in_tree():
			var box: AABB = visual.global_transform * visual.get_aabb()
			merged = box if not found else merged.merge(box)
			found = true
		for child: Node in node.get_children(true):
			pending.push_back(child)
	return merged


func get_property(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var property: String = str(params.get("property", ""))

	if node_path.is_empty() or property.is_empty():
		return { "type": "error", "message": "Node path and property required" }

	var standing: Dictionary = GdhValues.target_at(_host.get_tree().root, node_path)
	if standing.has("message"):
		return standing
	var target: Object = standing["object"]

	var reached: Dictionary = GdhPaths.walk_to(target, node_path, property)
	if reached.has("message"):
		return reached

	var holder: Variant = reached["holder"]
	var named: String = reached["name"]
	# Asked of the holder rather than read and compared to null, because a property the holder does
	# not have and a property that is null both read as null.
	if not GdhPaths.can_read(holder, named):
		return {
			"type": "error",
			"message": GdhPaths.nothing_there(holder, named, str(reached["called"])),
		}

	return {
		"type": "property",
		"path": node_path,
		"property": property,
		"value": _values.serialize(GdhPaths.read_under(holder, named)),
	}


## Whether the frame waits for the display, which sets its floor: a game with vsync on cannot
## finish a frame sooner than the display refreshes, however little it does.
static func _vsync() -> String:
	if DisplayServer.get_name() == "headless":
		return "none, headless"
	match DisplayServer.window_get_vsync_mode():
		DisplayServer.VSYNC_DISABLED:
			return "disabled"
		DisplayServer.VSYNC_ADAPTIVE:
			return "adaptive"
		DisplayServer.VSYNC_MAILBOX:
			return "mailbox"
		_:
			return "enabled"


func get_metrics(params: Dictionary) -> Dictionary:
	var metrics: Array = params.get("metrics", [])
	var timed: int = _frames.usec.size()
	var total_usec: int = 0
	var slowest_usec: int = 0
	for one: int in _frames.usec:
		total_usec += one
		slowest_usec = maxi(slowest_usec, one)
	# Null rather than zero before a frame has been timed: no frame took no time.
	var steps: int = 0
	for one: int in _frames.physics:
		steps += one
	var frame_time: Variant = null
	var frame_time_max: Variant = null
	var physics_steps_per_second: Variant = null
	if timed > 0:
		frame_time = float(total_usec) / timed / 1_000_000.0
		frame_time_max = slowest_usec / 1_000_000.0
		if total_usec > 0:
			physics_steps_per_second = steps * 1_000_000.0 / total_usec
	var all: Dictionary = {
		"fps": Engine.get_frames_per_second(),
		"frame_time": frame_time,
		"frame_time_max": frame_time_max,
		"frames_timed": timed,
		"process_frames": Engine.get_process_frames(),
		"physics_frames": Engine.get_physics_frames(),
		"physics_steps_per_second": physics_steps_per_second,
		"physics_ticks_per_second": Engine.physics_ticks_per_second,
		"max_physics_steps_per_frame": Engine.max_physics_steps_per_frame,
		"time_scale": Engine.time_scale,
		"process_time_max": Performance.get_monitor(Performance.TIME_PROCESS),
		"physics_time": Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS),
		"vsync": _vsync(),
		"max_fps": Engine.max_fps,
		"memory_static": Performance.get_monitor(Performance.MEMORY_STATIC),
		"memory_static_max": Performance.get_monitor(Performance.MEMORY_STATIC_MAX),
		"object_count": Performance.get_monitor(Performance.OBJECT_COUNT),
		"object_resource_count": Performance.get_monitor(Performance.OBJECT_RESOURCE_COUNT),
		"object_node_count": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
		"object_orphan_node_count": Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT),
		"render_total_objects": Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME),
		"render_total_primitives":
		Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME),
		"render_total_draw_calls":
		# The GPU's half of the game's memory, in bytes, which memory_static does not count: a game
		Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
		# committing 2.3 GB answered 298 MB there, and the rest could not be asked about.
		"render_video_mem_used": Performance.get_monitor(Performance.RENDER_VIDEO_MEM_USED),
		"render_texture_mem_used": Performance.get_monitor(Performance.RENDER_TEXTURE_MEM_USED),
		"render_buffer_mem_used": Performance.get_monitor(Performance.RENDER_BUFFER_MEM_USED),
	}

	if metrics.is_empty():
		return { "type": "metrics", "data": all }

	# A caller that names metrics gets those and no others, and hears about a name that is
	# not one rather than getting everything back as if the list had not been sent.
	var unknown: Array[String] = []
	var selected: Dictionary = {}
	for metric: Variant in metrics:
		if all.has(metric):
			selected[metric] = all[metric]
		else:
			unknown.append(str(metric))
	if not unknown.is_empty():
		return {
			"type": "error",
			"message":
			"Unknown metrics: %s. Available: %s" % [", ".join(unknown), ", ".join(all.keys())],
		}
	return { "type": "metrics", "data": selected }


func _serialize_node_tree(
	node: Node, depth: int, max_depth: int, include_properties: bool, named: Array[String]
) -> Dictionary:
	var result: Dictionary = _serialize_node(node, include_properties)
	if not named.is_empty():
		result["properties"] = _named_properties_of(node, str(result["path"]), named)

	if depth < max_depth:
		var children: Array = []
		# Internal ones too, for the reason `find` takes them: a tree that answers "no children"
		# over a ConfirmationDialog holding a Yes and a No is not tidier than one that says so,
		# it is wrong, and it is what sends somebody looking for another way to press the button.
		# `depth` is what keeps the answer a size worth reading.
		for child: Node in node.get_children(true):
			children.append(
				_serialize_node_tree(child, depth + 1, max_depth, include_properties, named)
			)
		result["children"] = children

	return result


## The named properties a node has, read the way a find reads its one: through a colon path as
## well, and a name this node has not got is left out rather than answered null, since a tree
## holds nodes of every class and a label's `text` is not a container's.
func _named_properties_of(node: Node, path: String, named: Array[String]) -> Dictionary:
	var properties: Dictionary = {}
	for wanted: String in named:
		var reached: Dictionary = GdhPaths.walk_to(node, path, wanted)
		if reached.has("message"):
			continue
		var holder: Variant = reached["holder"]
		var name: String = reached["name"]
		if GdhPaths.can_read(holder, name):
			properties[wanted] = _values.serialize(GdhPaths.read_under(holder, name))
	return properties


func _serialize_node(node: Node, include_properties: bool) -> Dictionary:
	var result: Dictionary = {
		"name": node.name, "type": node.get_class(), "path": str(node.get_path()),
	}

	var script: Variant = node.get_script()
	if script is Script:
		var attached: Script = script
		result["script"] = attached.resource_path

	if include_properties:
		var properties: Dictionary = {}
		# A script's own variables as well as what the node stores: a plain `var health` is not
		# stored, so a tree read of a running game answered every engine property and none of the
		# game's state.
		for prop: Dictionary in node.get_property_list():
			if prop["usage"] & (PROPERTY_USAGE_STORAGE | PROPERTY_USAGE_SCRIPT_VARIABLE):
				var property_name: String = prop["name"]
				if not property_name.begins_with("_"):
					properties[property_name] = _values.serialize(node.get(property_name))
		result["properties"] = properties

	return result
