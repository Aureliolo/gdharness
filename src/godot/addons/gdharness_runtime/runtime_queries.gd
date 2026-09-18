extends RefCounted

## What the server asks about the running tree: its shape, one node, the nodes matching a
## question, where one is on screen, a property set, a method called, the metrics.

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


func get_tree(params: Dictionary) -> Dictionary:
	var root_path: String = str(params.get("root", "/root"))
	var max_depth: int = Read.as_int(params.get("depth", 3), 3)
	var include_properties: bool = Read.as_bool(params.get("include_properties", false))

	var reached: Dictionary = Values.node_at(_host.get_tree().root, root_path)
	if reached.has("message"):
		return reached
	var root: Node = reached["node"]

	return {"type": "tree", "root": _serialize_node_tree(root, 0, max_depth, include_properties)}


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
			if not include_hidden and not _shown(node):
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
## asking about.
static func _shown(node: Node) -> bool:
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
	# Through a path as well, for the reason [method _reached] gives. A step that is not there on
	# this node reads as not having the property rather than as a refusal, which is the rule this
	# whole function is written to: a find matches nodes of several classes on purpose.
	var reached: Dictionary = _reached(node, str(entry["path"]), wanted_property)
	if reached.has("message"):
		entry["has_property"] = false
		return entry
	var holder: Variant = reached["holder"]
	var named: String = reached["name"]
	var has: bool = _can_read(holder, named)
	entry["has_property"] = has
	if has:
		entry["value"] = _values.serialize(_read(holder, named))
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
	return said.containsn(wanted) if _is_literal(wanted) else said.matchn(wanted)


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
		if attached.get_global_name() != wanted["class"]:
			return false
	return true


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
static func said_by(node: Node) -> String:
	for property: Dictionary in node.get_property_list():
		if str(property.get("name", "")) == "text" and Read.as_int(property.get("type", 0)) == TYPE_STRING:
			return str(node.get("text")).strip_edges()
	return ""


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

	var reached: Dictionary = _reached(node, node_path, property)
	if reached.has("message"):
		return reached

	var holder: Variant = reached["holder"]
	var named: String = reached["name"]
	# Asked of the holder rather than read and compared to null, because a property the holder does
	# not have and a property that is null both read as null.
	if not _can_read(holder, named):
		return {"type": "error", "message": _nothing_there(holder, named, str(reached["called"]))}

	return {
		"type": "property",
		"path": node_path,
		"property": property,
		"value": _values.serialize(_read(holder, named)),
	}


## What [param reaching] names something on, which is the node itself until the name has a colon
## in it, and the last name along that path.
##
## A game's state does not sit on nodes, it hangs off them: the speed of the clock is a property of
## a [RefCounted] held by a [RefCounted] held by the root, and that is what an agent asks about.
## What a game does hangs off them the same way, so the last name is a property to read, a property
## to write or a method to call, and the walk to it is one walk.
##
## Colons, because that is the separator [method Object.get_indexed] already takes. Walked a step
## at a time rather than handed to that method, which answers null for a path that goes wrong
## halfway along and for one that ends on null.
##
## Answers with a `message` instead when a step along the way is not there or holds something that
## is not an object, naming the step rather than the whole path: "/root/Main:_game has no property
## clocks" is a typo found, and "no property _game:clocks:speed" is a puzzle.
func _reached(node: Node, node_path: String, reaching: String) -> Dictionary:
	var parts: PackedStringArray = reaching.split(":")
	var holder: Variant = node
	var called: String = node_path
	for step: int in parts.size() - 1:
		var named: String = parts[step]
		if not _can_read(holder, named):
			return {"type": "error", "message": _nothing_there(holder, named, called)}
		holder = _read(holder, named)
		called = "%s:%s" % [called, named]
		if not _can_hold(holder):
			var wanted: String = parts[step + 1]
			return {"type": "error", "message": "%s holds no object to read %s off" % [called, wanted]}
	return {"holder": holder, "name": parts[parts.size() - 1], "called": called}


## Whether a step can be taken into [param value] at all: an object, a list or a map can be walked
## into, and a number or a string is where a path ends whether the caller meant it to or not.
static func _can_hold(value: Variant) -> bool:
	return value is Object or value is Array or value is Dictionary


## Whether [param named] is something [param holder] has.
##
## Three kinds of holder, because the state a game keeps is not all properties of objects: a roster
## is a list and an in-tray is a map, and a path that could not step into either stopped at the
## first one. An index reads the way a property does, and a negative one counts from the end the
## way GDScript's own does, so reading the last of something does not mean asking how many first.
static func _can_read(holder: Variant, named: String) -> bool:
	if holder is Array:
		var items: Array = holder
		return _index_in(named, items.size()) != -1
	if holder is Dictionary:
		var map: Dictionary = holder
		return map.has(named) or map.has(StringName(named))
	if holder is Object:
		var object: Object = holder
		return _has_property(object, named)
	return false


## Put [param value] where [param named] points. Only ever called once [method _can_read] agrees,
## and lists and maps are reference types, so writing into one reaches the game's own copy.
static func _write(holder: Variant, named: String, value: Variant) -> void:
	if holder is Array:
		var items: Array = holder
		items[_index_in(named, items.size())] = value
		return
	if holder is Dictionary:
		var map: Dictionary = holder
		# Written back under the key it was found under, since a map keyed by StringName and one
		# keyed by String both read the same way and a write to the wrong one adds a second entry.
		if map.has(named):
			map[named] = value
		else:
			map[StringName(named)] = value
		return
	var object: Object = holder
	object.set(named, value)


## What [param holder] holds under [param named]. Only ever called once [method _can_read] agrees.
static func _read(holder: Variant, named: String) -> Variant:
	if holder is Array:
		var items: Array = holder
		return items[_index_in(named, items.size())]
	if holder is Dictionary:
		var map: Dictionary = holder
		if map.has(named):
			return map[named]
		return map[StringName(named)]
	var object: Object = holder
	return object.get(named)


## Where [param named] lands in a list of [param size], or -1 for a step that is not in it.
##
## -1 for "nowhere" is safe because every answer this gives is an index into a list that long, so a
## real one is never negative by the time it is returned.
static func _index_in(named: String, size: int) -> int:
	if not named.is_valid_int():
		return -1
	var index: int = int(named)
	if index < 0:
		index += size
	return index if index >= 0 and index < size else -1


## Why a step could not be taken, said in the terms of what was actually there.
##
## "has no property 0" about a list is a true sentence that sends somebody looking for a property,
## so a list says how long it is and a map says what it is keyed by. The step is named rather than
## the whole path, because the step is the typo.
static func _nothing_there(holder: Variant, named: String, called: String) -> String:
	if holder is Array:
		var items: Array = holder
		return "%s is a list of %d, so there is no %s in it" % [called, items.size(), named]
	if holder is Dictionary:
		var map: Dictionary = holder
		var keys: Array = map.keys()
		# Eight of them, because a map keyed by something unexpected is told by the first few and a
		# map of two hundred would bury the sentence saying which key was missing.
		var some: Array[String] = []
		for key: Variant in keys.slice(0, 8):
			some.append(str(key))
		var rest: String = ""
		if keys.size() > 8:
			rest = " and %d more" % [keys.size() - 8]
		return "%s has no key %s; it is keyed by %s%s" % [called, named, ", ".join(some), rest]
	return "%s has no property %s" % [called, named]


## Whether [param holder] declares [param named]. Its own function because three ops ask it and a
## property read back as null answers it wrongly.
static func _has_property(holder: Object, named: String) -> bool:
	for entry: Dictionary in holder.get_property_list():
		if str(entry["name"]) == named:
			return true
	return false


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

	# Through a path as well, for the reason [method _reached] gives, and read back off the same
	# holder afterwards: a set that does not take says so by answering with the old value, which is
	# how a typed container refusing a write is told from one accepting it.
	var reached: Dictionary = _reached(node, node_path, property)
	if reached.has("message"):
		return reached

	var holder: Variant = reached["holder"]
	var named: String = reached["name"]
	if not _can_read(holder, named):
		return {"type": "error", "message": _nothing_there(holder, named, str(reached["called"]))}
	var old_value: Variant = _read(holder, named)
	_write(holder, named, _values.fitted(value, typeof(old_value)))

	return {
		"type": "property_set",
		"path": node_path,
		"property": property,
		"old_value": _values.serialize(old_value),
		"new_value": _values.serialize(_read(holder, named))
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

	# Through a path as well, for the reason [method _reached] gives. What a game does hangs off its
	# nodes as much as its state does, so reading `_game:run:day` while being unable to call
	# `_game:run:advance` answers half of what a node holds and refuses the other half.
	var reached: Dictionary = _reached(node, node_path, method)
	if reached.has("message"):
		return reached

	# A list or a map can be stepped through on the way, and is not a thing with methods when the
	# path stops on one: said in those terms rather than as "has no method", which reads as a
	# misspelling of a method that was never going to be there.
	if not reached["holder"] is Object:
		var sort: String = "a list" if reached["holder"] is Array else "a map"
		return {
			"type": "error",
			"message":
			(
				"%s is %s, which has no methods: name the element to call it on, as in %s:0:%s"
				% [reached["called"], sort, reached["called"], reached["name"]]
			)
		}
	var holder: Object = reached["holder"]
	var named: String = reached["name"]
	if not holder.has_method(named):
		return {"type": "error", "message": "%s has no method %s" % [reached["called"], named]}

	var deserialized_args: Array = []
	for index: int in args.size():
		deserialized_args.append(_values.fitted(args[index], _values.parameter_type(holder, named, index)))

	var result: Variant = holder.callv(named, deserialized_args)

	return {"type": "method_result", "path": node_path, "method": method, "result": _values.serialize(result)}


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


func _serialize_node_tree(node: Node, depth: int, max_depth: int, include_properties: bool) -> Dictionary:
	var result: Dictionary = _serialize_node(node, include_properties)

	if depth < max_depth:
		var children: Array = []
		# Internal ones too, for the reason `find` takes them: a tree that answers "no children"
		# over a ConfirmationDialog holding a Yes and a No is not tidier than one that says so,
		# it is wrong, and it is what sends somebody looking for another way to press the button.
		# `depth` is what keeps the answer a size worth reading.
		for child: Node in node.get_children(true):
			children.append(_serialize_node_tree(child, depth + 1, max_depth, include_properties))
		result["children"] = children

	return result


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
