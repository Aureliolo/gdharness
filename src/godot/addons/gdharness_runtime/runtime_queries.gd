extends RefCounted

## What the server asks about the running tree: its shape, one node, the nodes matching a
## question, where one is on screen, a property set, a method called, the metrics.

const Paths = preload("runtime_paths.gd")
const Read = preload("reading.gd")
const Values = preload("runtime_values.gd")

## The most nodes one find answers with, unless asked for fewer: enough for any real query and
## far short of the tree dump a query exists to avoid.
const FIND_LIMIT: int = 100
const FIND_LIMIT_CEILING: int = 1000

## What a find can be narrowed by, which is also what it refuses to answer without. Named once so
## the refusal lists the same set the walk reads.
const FILTERS: PackedStringArray = ["class", "script", "name", "group", "says"]

## The most lines one read answers with, unless asked for fewer. A screen is a few dozen; a
## thousand is a tree somebody pointed this at by mistake.
const READ_LIMIT: int = 500

var _host: Node
var _values: Values


## The host is the autoload, which is how the tree is reached: it is not in one when the
## modules are built, and a fixture may put it in one later.
func _init(host: Node, values: Values) -> void:
	_host = host
	_values = values


## The tree under a node, to a depth, with every stored property on each node when asked for all
## of them or the named ones when a list is given.
##
## The list is the shape most questions about a screen take: the `text` of every label and
## button under a panel. All of them for one row of a form answered seventy-six thousand
## characters, and the same question as a find with one property answered two.
func get_tree(params: Dictionary) -> Dictionary:
	var root_path: String = str(params.get("root", "/root"))
	var max_depth: int = Read.as_int(params.get("depth", 3), 3)
	var include_properties: bool = Read.as_bool(params.get("include_properties", false))
	var named: Array[String] = []
	var listed: Variant = params.get("properties", [])
	if listed is Array:
		for each: Variant in listed:
			named.append(str(each))
	else:
		return {"type": "error", "message": "properties must be a list of property names"}

	var reached: Dictionary = Values.node_at(_host.get_tree().root, root_path)
	if reached.has("message"):
		return reached
	var root: Node = reached["node"]

	return {
		"type": "tree",
		"root": _serialize_node_tree(root, 0, max_depth, include_properties, named),
	}


## Nodes matching every filter given, as paths, so a caller can name what it wants without
## reading the whole tree to find it. `class` matches native classes and their subclasses, and
## the global name of a script class; `name` is a case-insensitive glob; `script` is a path;
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
	var include_hidden: bool = Read.as_bool(params.get("include_hidden", true), true)
	var limit: int = clampi(Read.as_int(params.get("limit", FIND_LIMIT), FIND_LIMIT), 1, FIND_LIMIT_CEILING)

	if not _anything_asked(wanted):
		return {"type": "error", "message": "find_nodes needs at least one of " + ", ".join(FILTERS)}
	if not wanted["script"].is_empty() and not wanted["script"].begins_with("res://"):
		wanted["script"] = "res://" + wanted["script"]

	var reached: Dictionary = Values.node_at(_host.get_tree().root, root_path)
	if reached.has("message"):
		return reached
	var root: Node = reached["node"]

	var found: Array[Dictionary] = []
	var pending: Array[Node] = [root]
	var truncated: bool = false
	# Counted while the tree is already being walked, for the answer below: how many nodes this
	# find would have matched if the name had been read the way it was probably meant.
	var literal: bool = _is_literal(wanted["name"])
	var nearly: int = 0
	var hidden: int = 0
	while not pending.is_empty():
		var node: Node = pending.pop_front()
		var rest: bool = _matches_apart_from_name(node, wanted)
		if rest and _named(node, wanted["name"]):
			if not include_hidden and not shown(node):
				hidden += 1
			elif found.size() >= limit:
				truncated = true
				break
			else:
				found.append(_found(node, wanted_property))
		elif rest and literal and str(node.name).containsn(wanted["name"]):
			nearly += 1
		# Internal children included, which they were not. A ConfirmationDialog builds its Yes and
		# its No as internal nodes, and a ScrollContainer its bars, so a find over a screen for
		# every Button came back without the two buttons the player is being asked to press:
		# nothing here could see the dialog at all, and the way past it was to emit `confirmed`.
		# A filtered query carries no cost for including them, because they only appear when they
		# are what was asked for.
		var children: Array[Node] = node.get_children(true)
		for index: int in range(children.size() - 1, -1, -1):
			pending.push_front(children[index])

	var answer: Dictionary = {"type": "nodes", "count": found.size(), "truncated": truncated, "nodes": found}
	var notes: Array[String] = []
	# Nothing found is the one answer that cannot be told apart from having asked the wrong
	# question, and a name written without a wildcard is the way an agent writes "contains".
	# Said only when it changes the answer, so a genuine nothing stays a plain nothing.
	if found.is_empty() and nearly > 0:
		var holding: String = "names contain" if nearly > 1 else "name contains"
		notes.append(
			(
				'name is matched as a glob against the whole name; %d node %s "%s", which "*%s*" would find'
				% [nearly, holding, wanted["name"], wanted["name"]]
			)
		)
	# How many the filter took out, so a short answer is not read as a small screen. Left out
	# entirely when nothing was hidden, which keeps a plain answer plain.
	if hidden > 0:
		answer["hidden"] = hidden
		notes.append(
			(
				"%d matching node%s hidden and left out; includeHidden true answers with them too"
				% [hidden, "" if hidden == 1 else "s"]
			)
		)
	if not notes.is_empty():
		answer["note"] = " ".join(notes)
	return answer


## Whether the player can see [param node], its ancestors counted.
##
## Not [method CanvasItem.is_visible_in_tree] on its own, because only the nodes that draw have it:
## a plain Node sitting between a hidden panel and a label has no visibility to ask about, and the
## label answers that it is visible while nothing of it is on screen. Walking up is what makes a
## row hidden because the panel holding it is hidden, which is what somebody checking a screen is
## asking about. A wait on words asks the same, so it reads this too.
static func shown(node: Node) -> bool:
	var walk: Node = node
	while walk != null:
		if not _drawn(walk):
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
	# Through a path as well, for the reason [method Paths.walk_to] gives. A step that is not there on
	# this node reads as not having the property rather than as a refusal, which is the rule this
	# whole function is written to: a find matches nodes of several classes on purpose.
	var reached: Dictionary = Paths.walk_to(node, str(entry["path"]), wanted_property)
	if reached.has("message"):
		entry["has_property"] = false
		return entry
	var holder: Variant = reached["holder"]
	var named: String = reached["name"]
	var has: bool = Paths.can_read(holder, named)
	entry["has_property"] = has
	if has:
		entry["value"] = _values.serialize(Paths.read_under(holder, named))
	return entry


## Whether the caller named anything to match on, since every filter left out matches everything
## and a find with none of them is the whole tree by another name.
static func _anything_asked(wanted: Dictionary[String, String]) -> bool:
	for filter: String in wanted:
		if not wanted[filter].is_empty():
			return true
	return false


## Whether [param node] carries the name a find asked for. Empty matches everything, which is what
## makes leaving a filter out the same as not having one.
static func _named(node: Node, pattern: String) -> bool:
	return pattern.is_empty() or str(node.name).matchn(pattern)


## Whether [param pattern] is a name written as a whole word rather than as a glob, which is how a
## caller writes one when they mean "contains". [method String.matchn] answers nothing to it, and
## nothing is also what a name that is simply not there answers.
static func _is_literal(pattern: String) -> bool:
	return not pattern.is_empty() and not pattern.contains("*") and not pattern.contains("?")


## Whether [param said] is what a find asked for in [param wanted].
##
## A plain word is a contains, which is what somebody looking for the row about a person means. A
## pattern is a glob, because [code]namePattern[/code] beside it is one and nobody writes `*Still*`
## in one field meaning a glob and in the other meaning those characters. Written as a contains
## only, a glob matched nothing at all and an empty answer reads as a control that is not on the
## screen: twice in one session here, over a button that was.
static func _says(said: String, wanted: String) -> bool:
	var words: String = as_said(wanted)
	return said.containsn(words) if _is_literal(words) else said.matchn(words)


## [param wanted] as words on a screen: a backslash followed by n is a line break.
##
## A button with two lines on it was asked for with the break written as the two characters, the
## way it is typed into a JSON string one escape short, and was answered as not there: 0 found,
## which reads as a control that is not on the screen. Nothing on a screen says a backslash and
## an n, so the two characters mean the break to everybody who writes them.
static func as_said(wanted: String) -> String:
	return wanted.replace("\\n", "\n")


## Every filter but the name, so a find that came back empty can say how many nodes the name was
## the only thing standing between it and.
func _matches_apart_from_name(node: Node, wanted: Dictionary[String, String]) -> bool:
	if not wanted["group"].is_empty() and not node.is_in_group(wanted["group"]):
		return false
	# What this node says, rather than everything said underneath it. A row is then found by the
	# label in it, and the path answered is that label's, which is where the words a caller is
	# looking at actually are: matching every container above it would answer with the screen.
	if not wanted["says"].is_empty() and not _says(said_by(node), wanted["says"]):
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


## Where a node is on screen: a Control's rectangle, a Node2D's position, or the place a 3D node
## is drawn in, in both the canvas coordinates the node reports and the window pixels input
## arrives in. The two differ whenever the project stretches its viewport, which is what made a
## rect unusable for a click.
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
	var include_hidden: bool = Read.as_bool(params.get("include_hidden", false))
	var limit: int = clampi(Read.as_int(params.get("limit", READ_LIMIT), READ_LIMIT), 1, READ_LIMIT)

	var reached: Dictionary = Values.node_at(_host.get_tree().root, root_path)
	if reached.has("message"):
		return reached
	var root: Node = reached["node"]

	# The rest of the subtree is walked and counted rather than stopped at. A flag on its own gets
	# read as a footnote: a screen answered with its first few hundred lines and the dialog the
	# player is being asked to answer below them reads exactly like a dialog that is not there,
	# and a bare `truncated: true` was looked straight past twice before the limit was suspected.
	# A number is what sends somebody back.
	var lines: Array[String] = []
	var left_out: int = _read_into(root, include_hidden, limit, lines)
	return {
		"type": "text",
		"root": root_path,
		"lines": lines,
		"count": lines.size(),
		"truncated": left_out > 0,
		"omitted": left_out,
	}


## Walks [param node] depth first, which is the order the screen is laid out in and the order a
## person reads it.
##
## Internal children as well, because the number in a SpinBox is one: the field a player reads it
## in is a LineEdit the engine builds inside the box and leaves out of `get_children()`, so a
## screen full of forms answered with every label on it and none of the values in it. The hidden
## check covers a [Window] for the same walk: a dropdown's popup is a child that is not drawn
## until it is opened, and reading a closed menu would put every item on the screen.
## Fills [param into] up to [param most] lines and answers with how many further lines the rest of
## the subtree says, which is what the caller is told rather than left to infer.
func _read_into(node: Node, include_hidden: bool, most: int, into: Array[String]) -> int:
	if not include_hidden and not _drawn(node):
		return 0
	var left_out: int = 0
	var said: String = said_by(node)
	if not said.is_empty():
		if into.size() < most:
			into.append(said)
		else:
			left_out += 1
	for child: Node in node.get_children(true):
		left_out += _read_into(child, include_hidden, most, into)
	return left_out


## Whether [param node] is on the screen at all, for the three kinds of thing that can be hidden.
##
## A Node3D among them because a hidden one draws nothing, Label3D included: reading a screen or
## finding what is on it counted a hidden 3D subtree as showing, which is the one answer neither
## question wants.
static func _drawn(node: Node) -> bool:
	var control: CanvasItem = node as CanvasItem
	if control != null:
		return control.visible
	var spatial: Node3D = node as Node3D
	if spatial != null:
		return spatial.visible
	var window: Window = node as Window
	return window == null or window.visible


## What one node says, or "" for a node that says nothing. Anything with a `text` property, which
## is every label, button and field the interface is built out of.
##
## Public because three questions are the same question: what a screen reads as, which nodes say a
## given word, and whether anything has come to say it yet. Two copies of what a node says is how
## the three of them come to disagree about a SpinBox.
##
## Read rather than looked up in the property list, which the engine builds afresh on every call: a
## wait asks this of every node on the screen every frame, and on a hall of 3,500 nodes the lookup
## took the game it was watching from 60 frames a second to 11. A node without the property reads
## as null, which is not a string.
static func said_by(node: Node) -> String:
	# A RichTextLabel's text is its markup when it reads BBCode, and nobody reads the tags: a
	# dossier line came back as "[b][color=#4fc2d4]Mollum Telken[/color], [/b]..." and a phrase
	# running across a tag could not be found or waited for. The parsed text is what is drawn, and
	# it also holds what a game added with append_text(), which the property never shows.
	if node is RichTextLabel:
		var rich: RichTextLabel = node
		return rich.get_parsed_text().strip_edges()
	var text: Variant = node.get("text")
	if not text is String:
		return ""
	var words: String = text
	return words.strip_edges()


func get_rect(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	if node_path.is_empty():
		return {"type": "error", "message": "Node path required"}

	var standing: Dictionary = Values.node_at(_host.get_tree().root, node_path)
	if standing.has("message"):
		return standing
	var node: Node = standing["node"]

	if node is Control:
		var control: Control = node
		var to_window: Transform2D = control.get_viewport().get_final_transform()
		var canvas_rect: Rect2 = control.get_global_rect()
		return {
			"type": "rect",
			"path": node_path,
			"visible": control.is_visible_in_tree(),
			"canvas": _values.serialize(canvas_rect),
			"window": _values.serialize(to_window * canvas_rect),
		}
	if node is Node2D:
		var item: Node2D = node
		var canvas_position: Vector2 = item.get_global_transform_with_canvas().origin
		var window_position: Vector2 = item.get_viewport().get_final_transform() * canvas_position
		return {
			"type": "point",
			"path": node_path,
			"visible": item.is_visible_in_tree(),
			"canvas": _values.serialize(canvas_position),
			"window": _values.serialize(window_position),
		}
	if node is Node3D:
		var spatial: Node3D = node
		return _in_the_frame(node_path, spatial)
	return {
		"type": "error", "message": "%s is a %s, which has no place on screen" % [node_path, node.get_class()]
	}


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
			"message": "%s is not in a viewport with a current Camera3D, so nothing is drawing it" % node_path
		}

	var to_window: Transform2D = item.get_viewport().get_final_transform()
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
		answer["window"] = _values.serialize(to_window * aim)
	if found.has("rect"):
		var covered: Rect2 = found["rect"]
		answer["covers"] = {
			"canvas": _values.serialize(covered),
			"window": _values.serialize(to_window * covered),
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
	var found: Dictionary = {"camera": str(camera.get_path()), "behind": camera.is_position_behind(origin)}
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
	return {"rect": seen}


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
		return {"type": "error", "message": "Node path and property required"}

	var standing: Dictionary = Values.node_at(_host.get_tree().root, node_path)
	if standing.has("message"):
		return standing
	var node: Node = standing["node"]

	var reached: Dictionary = Paths.walk_to(node, node_path, property)
	if reached.has("message"):
		return reached

	var holder: Variant = reached["holder"]
	var named: String = reached["name"]
	# Asked of the holder rather than read and compared to null, because a property the holder does
	# not have and a property that is null both read as null.
	if not Paths.can_read(holder, named):
		return {"type": "error", "message": Paths.nothing_there(holder, named, str(reached["called"]))}

	return {
		"type": "property",
		"path": node_path,
		"property": property,
		"value": _values.serialize(Paths.read_under(holder, named)),
	}


func set_property(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var property: String = str(params.get("property", ""))
	var value: Variant = params.get("value")

	if node_path.is_empty() or property.is_empty():
		return {"type": "error", "message": "Node path and property required"}

	var standing: Dictionary = Values.node_at(_host.get_tree().root, node_path)
	if standing.has("message"):
		return standing
	var node: Node = standing["node"]

	# Through a path as well, for the reason [method Paths.walk_to] gives, and read back off the same
	# holder afterwards: a set that does not take says so by answering with the old value, which is
	# how a typed container refusing a write is told from one accepting it.
	var reached: Dictionary = Paths.walk_to(node, node_path, property)
	if reached.has("message"):
		return reached

	var holder: Variant = reached["holder"]
	var named: String = reached["name"]
	# A call can be walked through and read, and is not a place: what it returns is the method's
	# to hand out, and writing "into" it would set nothing the game keeps.
	if not Paths.method_of(named).is_empty():
		return {
			"type": "error",
			"message":
			(
				"%s:%s is a call, and a call is not a place to write: name a property"
				% [reached["called"], named]
			)
		}
	if not Paths.can_read(holder, named):
		return {"type": "error", "message": Paths.nothing_there(holder, named, str(reached["called"]))}
	var old_value: Variant = Paths.read_under(holder, named)
	# The same rule the call path holds: a value that cannot become what the property holds is
	# refused rather than written. Writing it means the engine picks something, and what it picks
	# for a word where a number goes is zero, which the answer then reports as the new value.
	var slot: Dictionary = Values.slot_declared(holder, named)
	var wanted: int = slot["type"] if slot["type"] != TYPE_NIL else typeof(old_value)
	var given: Variant
	if wanted == TYPE_OBJECT and (value is String or value is Dictionary):
		var named_object: Dictionary = _object_named(node, node_path, value, str(slot["class"]))
		if named_object.has("message"):
			return {
				"type": "error",
				"message": "%s.%s holds an object: %s" % [reached["called"], named, named_object["message"]]
			}
		given = named_object["object"]
	else:
		given = _values.fitted(value, wanted)
		if not Values.acceptable(given, wanted):
			return {
				"type": "error",
				"message":
				(
					"%s.%s holds %s and the value given is %s, which cannot become one."
					% [reached["called"], named, type_string(wanted), type_string(typeof(given))]
				)
			}
		var typed: Dictionary = _values.typed_like(given, old_value, _element_object.bind(node, node_path))
		if typed.has("message"):
			return {
				"type": "error",
				"message":
				"%s.%s is a typed %s: %s." % [reached["called"], named, _sort_of(old_value), typed["message"]]
			}
		given = typed["value"]
	Paths.write(holder, named, given)
	var now: Variant = Paths.read_under(holder, named)
	# Read back rather than trusted. The engine drops a write it will not take without a word, and
	# the answer then showed the old value as the new one, shaped as a success: a typed container
	# refusing a plain list did exactly that. A value the property changed on the way in, a setter
	# clamping it, still changed it, so only a write that left the property as it was is refused.
	if (
		Values.comparable(given, old_value)
		and given != old_value
		and Values.comparable(now, old_value)
		and now == old_value
	):
		return {
			"type": "error",
			"message":
			(
				(
					"%s.%s was given %s and still holds %s: the engine kept what it had,"
					+ " which a property it will not write does."
				)
				% [
					reached["called"],
					named,
					JSON.stringify(_values.serialize(given)),
					JSON.stringify(_values.serialize(now))
				]
			)
		}

	return {
		"type": "property_set",
		"path": node_path,
		"property": property,
		"old_value": _values.serialize(old_value),
		"new_value": _values.serialize(now)
	}


func call_method(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var method: String = str(params.get("method", ""))
	var args: Array = params.get("args", [])

	if node_path.is_empty() or method.is_empty():
		return {"type": "error", "message": "Node path and method required"}

	var standing: Dictionary = Values.node_at(_host.get_tree().root, node_path)
	if standing.has("message"):
		return standing
	var node: Node = standing["node"]

	# Through a path as well, for the reason [method Paths.walk_to] gives. What a game does hangs off its
	# nodes as much as its state does, so reading `_game:run:day` while being unable to call
	# `_game:run:advance` answers half of what a node holds and refuses the other half.
	var reached: Dictionary = Paths.walk_to(node, node_path, method)
	if reached.has("message"):
		return reached

	# A list or a map answers the calls a path makes on one, and nothing else: said in those terms
	# rather than as "has no method", which reads as a misspelling of a method that was never going
	# to be there, and with the element spelled out, since a method on what it holds is the usual aim.
	if not reached["holder"] is Object:
		var sort: String = "a list"
		if reached["holder"] is Dictionary:
			sort = "a map"
		elif Paths.packed(reached["holder"]):
			sort = "a packed list"
		var spelled: String = str(reached["name"])
		if Paths.method_of(spelled).is_empty():
			spelled += "()"
		if args.is_empty() and Paths.can_read(reached["holder"], spelled):
			var answered: Variant = Paths.read_under(reached["holder"], spelled)
			return {
				"type": "method_result",
				"path": node_path,
				"method": method,
				"result": _values.serialize(answered),
			}
		var why: String = (
			"%s:%s takes no arguments" % [reached["called"], spelled]
			if Paths.can_read(reached["holder"], spelled)
			else Paths.nothing_there(reached["holder"], spelled, str(reached["called"]))
		)
		return {
			"type": "error",
			"message":
			(
				"%s. A method of what %s holds is called on the element, as in %s:0:%s"
				% [why, sort, reached["called"], reached["name"]]
			)
		}
	var holder: Object = reached["holder"]
	var named: String = reached["name"]
	# The method a call ends on is the one being called whether or not it carries the brackets a
	# step along the way would: "get_viewport():gui_get_focus_owner()" is the same call as without
	# the last pair.
	if not Paths.method_of(named).is_empty():
		named = Paths.method_of(named)
	if not holder.has_method(named):
		return {"type": "error", "message": "%s has no method %s" % [reached["called"], named]}

	# Checked before the call rather than left to it. `callv` raises inside the game when an
	# argument cannot be converted, and an error raised in a game somebody is playing holds it at a
	# debugger break: every later call then reports a game that is not responding, which points
	# nowhere near the argument. A wrong argument costs a refusal, never the session's game.
	var deserialized_args: Array = []
	for index: int in args.size():
		var wants: int = _values.parameter_type(holder, named, index)
		if wants == TYPE_OBJECT and (args[index] is String or args[index] is Dictionary):
			var declared: String = _values.parameter_class(holder, named, index)
			var named_object: Dictionary = _object_named(node, node_path, args[index], declared)
			if named_object.has("message"):
				return {
					"type": "error",
					"message":
					"%s.%s argument %d: %s" % [reached["called"], named, index + 1, named_object["message"]]
				}
			deserialized_args.append(named_object["object"])
			continue
		var given: Variant = _values.fitted(args[index], wants)
		if not Values.acceptable(given, wants):
			return {
				"type": "error",
				"message":
				(
					"%s.%s takes %s as argument %d and was given %s, which cannot be converted."
					% [reached["called"], named, type_string(wants), index + 1, type_string(typeof(given))]
				)
			}
		# A typed list or map is built as one, since a plain one handed to such a parameter raises
		# inside the game, which is what every check here exists to stop.
		var container: Variant = _values.parameter_container(holder, named, index)
		if container != null:
			var typed: Dictionary = _values.typed_like(
				given, container, _element_object.bind(node, node_path)
			)
			if typed.has("message"):
				return {
					"type": "error",
					"message":
					(
						"%s.%s takes a typed %s as argument %d: %s."
						% [reached["called"], named, _sort_of(container), index + 1, typed["message"]]
					)
				}
			given = typed["value"]
		deserialized_args.append(given)

	var result: Variant = holder.callv(named, deserialized_args)

	return {"type": "method_result", "path": node_path, "method": method, "result": _values.serialize(result)}


## [method _object_named] with the path first, which is the order [method Values.typed_like] calls
## an element resolver in.
func _element_object(given: Variant, declared: String, node: Node, node_path: String) -> Dictionary:
	return _object_named(node, node_path, given, declared)


## "list" or "map", for a refusal about a typed container.
static func _sort_of(container: Variant) -> String:
	return "list" if container is Array else "map"


## The object [param given] names for a slot or a parameter declared as [param declared], as
## `{"object": ...}`, or `{"message": ...}` saying why it names none that fits.
##
## JSON cannot carry an object, so one the game holds is named by its path, read from the node the
## call or the write was made on, and handed over as that instance rather than a copy: a method
## given a piece of the game's state acts on the piece the game keeps, and a slot written with one
## holds the game's own.
func _object_named(node: Node, node_path: String, given: Variant, declared: String) -> Dictionary:
	var found: Dictionary = Paths.object_at(_host.get_tree().root, node, node_path, given)
	if found.has("message"):
		return found
	var instance: Object = found["object"]
	if not declared.is_empty() and not Values.is_a(instance, declared):
		return {"message": "%s is %s, not a %s" % [str(given), Values.class_of(instance), declared]}
	return found


func get_metrics(params: Dictionary) -> Dictionary:
	var metrics: Array = params.get("metrics", [])
	var all: Dictionary = {
		"fps": Engine.get_frames_per_second(),
		"frame_time": Performance.get_monitor(Performance.TIME_PROCESS),
		"physics_time": Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS),
		"memory_static": Performance.get_monitor(Performance.MEMORY_STATIC),
		"memory_static_max": Performance.get_monitor(Performance.MEMORY_STATIC_MAX),
		"object_count": Performance.get_monitor(Performance.OBJECT_COUNT),
		"object_resource_count": Performance.get_monitor(Performance.OBJECT_RESOURCE_COUNT),
		"object_node_count": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
		"object_orphan_node_count": Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT),
		"render_total_objects": Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME),
		"render_total_primitives": Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME),
		"render_total_draw_calls": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
	}

	if metrics.is_empty():
		return {"type": "metrics", "data": all}

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
			"message": "Unknown metrics: %s. Available: %s" % [", ".join(unknown), ", ".join(all.keys())]
		}
	return {"type": "metrics", "data": selected}


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
			children.append(_serialize_node_tree(child, depth + 1, max_depth, include_properties, named))
		result["children"] = children

	return result


## The named properties a node has, read the way a find reads its one: through a colon path as
## well, and a name this node has not got is left out rather than answered null, since a tree
## holds nodes of every class and a label's `text` is not a container's.
func _named_properties_of(node: Node, path: String, named: Array[String]) -> Dictionary:
	var properties: Dictionary = {}
	for wanted: String in named:
		var reached: Dictionary = Paths.walk_to(node, path, wanted)
		if reached.has("message"):
			continue
		var holder: Variant = reached["holder"]
		var name: String = reached["name"]
		if Paths.can_read(holder, name):
			properties[wanted] = _values.serialize(Paths.read_under(holder, name))
	return properties


func _serialize_node(node: Node, include_properties: bool) -> Dictionary:
	var result: Dictionary = {"name": node.name, "type": node.get_class(), "path": str(node.get_path())}

	var script: Variant = node.get_script()
	if script is Script:
		var attached: Script = script
		result["script"] = attached.resource_path

	if include_properties:
		var properties: Dictionary = {}
		for prop: Dictionary in node.get_property_list():
			if prop["usage"] & PROPERTY_USAGE_STORAGE:
				var property_name: String = prop["name"]
				if not property_name.begins_with("_"):
					properties[property_name] = _values.serialize(node.get(property_name))
		result["properties"] = properties

	return result
