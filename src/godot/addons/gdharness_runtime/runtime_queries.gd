extends RefCounted

## What the server asks about the running tree: its shape, one node, the nodes matching a
## question, where one is on screen, a property set, a method called, the metrics.

const Values = preload("runtime_values.gd")

## The most nodes one find answers with, unless asked for fewer: enough for any real query and
## far short of the tree dump a query exists to avoid.
const FIND_LIMIT: int = 100
const FIND_LIMIT_CEILING: int = 1000

## The most lines one read answers with. A screen is a few dozen; a thousand is a tree somebody
## pointed this at by mistake.
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
	var max_depth: int = int(params.get("depth", 3))
	var include_properties: bool = bool(params.get("include_properties", false))

	var root: Node = _host.get_tree().root.get_node_or_null(root_path)
	if root == null:
		return {"type": "error", "message": "Node not found: " + root_path}

	return {"type": "tree", "root": _serialize_node_tree(root, 0, max_depth, include_properties)}


## Nodes matching every filter given, as paths, so a caller can name what it wants without
## reading the whole tree to find it. `class` matches native classes and their subclasses, and
## the global name of a script class; `name` is a case-insensitive glob; `script` is a path.
##
## `property` names one to read off each of them, which is the difference between one question and
## one call per answer. A panel of a dozen labels took thirteen calls to read, and a tree that
## rebuilds between them, which any HUD following a clock does, hands back paths that are gone by
## the time they are asked about. A node without that property says so rather than answering null,
## because null is what a node holding null answers.
func find_nodes(params: Dictionary) -> Dictionary:
	var root_path: String = str(params.get("root", "/root"))
	var wanted_class: String = str(params.get("class", ""))
	var wanted_script: String = str(params.get("script", ""))
	var wanted_name: String = str(params.get("name", ""))
	var wanted_group: String = str(params.get("group", ""))
	var wanted_property: String = str(params.get("property", ""))
	var limit: int = clampi(int(params.get("limit", FIND_LIMIT)), 1, FIND_LIMIT_CEILING)

	if (
		wanted_class.is_empty()
		and wanted_script.is_empty()
		and wanted_name.is_empty()
		and wanted_group.is_empty()
	):
		return {"type": "error", "message": "find_nodes needs at least one of class, script, name, group"}
	if not wanted_script.is_empty() and not wanted_script.begins_with("res://"):
		wanted_script = "res://" + wanted_script

	var root: Node = _host.get_tree().root.get_node_or_null(root_path)
	if root == null:
		return {"type": "error", "message": "Node not found: " + root_path}

	var found: Array[Dictionary] = []
	var pending: Array[Node] = [root]
	var truncated: bool = false
	while not pending.is_empty():
		var node: Node = pending.pop_front()
		if _matches(node, wanted_class, wanted_script, wanted_name, wanted_group):
			if found.size() >= limit:
				truncated = true
				break
			found.append(_found(node, wanted_property))
		# Internal children included, which they were not. A ConfirmationDialog builds its Yes and
		# its No as internal nodes, and a ScrollContainer its bars, so a find over a screen for
		# every Button came back without the two buttons the player is being asked to press:
		# nothing here could see the dialog at all, and the way past it was to emit `confirmed`.
		# A filtered query carries no cost for including them, because they only appear when they
		# are what was asked for.
		var children: Array[Node] = node.get_children(true)
		for index: int in range(children.size() - 1, -1, -1):
			pending.push_front(children[index])

	return {"type": "nodes", "count": found.size(), "truncated": truncated, "nodes": found}


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
	var has: bool = false
	for prop: Dictionary in node.get_property_list():
		if str(prop["name"]) == wanted_property:
			has = true
			break
	entry["property"] = wanted_property
	entry["has_property"] = has
	if has:
		entry["value"] = _values.serialize(node.get(wanted_property))
	return entry


func _matches(
	node: Node, wanted_class: String, wanted_script: String, wanted_name: String, wanted_group: String
) -> bool:
	if not wanted_group.is_empty() and not node.is_in_group(wanted_group):
		return false
	if not wanted_name.is_empty() and not str(node.name).matchn(wanted_name):
		return false
	var script: Variant = node.get_script()
	if not wanted_script.is_empty():
		if not script is Script:
			return false
		var attached: Script = script
		if attached.resource_path != wanted_script:
			return false
	if not wanted_class.is_empty() and not node.is_class(wanted_class):
		if not script is Script:
			return false
		var attached: Script = script
		if attached.get_global_name() != wanted_class:
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
func read_text(params: Dictionary) -> Dictionary:
	var root_path: String = str(params.get("root", "/root"))
	var include_hidden: bool = bool(params.get("include_hidden", false))

	var root: Node = _host.get_tree().root.get_node_or_null(root_path)
	if root == null:
		return {"type": "error", "message": "Node not found: " + root_path}

	var lines: PackedStringArray = PackedStringArray()
	_read_into(root, include_hidden, lines)
	return {
		"type": "text",
		"root": root_path,
		"lines": lines,
		"count": lines.size(),
		"truncated": lines.size() >= READ_LIMIT,
	}


## Walks [param node] depth first, which is the order the screen is laid out in and the order a
## person reads it.
##
## Internal children as well, because the number in a SpinBox is one: the field a player reads it
## in is a LineEdit the engine builds inside the box and leaves out of `get_children()`, so a
## screen full of forms answered with every label on it and none of the values in it. The hidden
## check covers a [Window] for the same walk: a dropdown's popup is a child that is not drawn
## until it is opened, and reading a closed menu would put every item on the screen.
func _read_into(node: Node, include_hidden: bool, into: PackedStringArray) -> void:
	if into.size() >= READ_LIMIT:
		return
	if not include_hidden and not _drawn(node):
		return
	var said: String = _said_by(node)
	if not said.is_empty():
		into.append(said)
	for child: Node in node.get_children(true):
		_read_into(child, include_hidden, into)


## Whether [param node] is on the screen at all, for the two kinds of thing that can be hidden.
static func _drawn(node: Node) -> bool:
	var control: CanvasItem = node as CanvasItem
	if control != null:
		return control.visible
	var window: Window = node as Window
	return window == null or window.visible


## What one node says, or "" for a node that says nothing. Anything with a `text` property, which
## is every label, button and field the interface is built out of.
static func _said_by(node: Node) -> String:
	for property: Dictionary in node.get_property_list():
		if str(property.get("name", "")) == "text" and int(property.get("type", 0)) == TYPE_STRING:
			return str(node.get("text")).strip_edges()
	return ""


func get_rect(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	if node_path.is_empty():
		return {"type": "error", "message": "Node path required"}

	var node: Node = _host.get_tree().root.get_node_or_null(node_path)
	if node == null:
		return {"type": "error", "message": "Node not found: " + node_path}

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
		return _in_the_frame(node_path, node)
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

	var node: Node = _host.get_tree().root.get_node_or_null(node_path)
	if node == null:
		return {"type": "error", "message": "Node not found: " + node_path}

	# Asked of the property list rather than read and compared to null, because a property the
	# node does not have and a property that is null both read as null.
	var known: bool = false
	for entry: Dictionary in node.get_property_list():
		if str(entry["name"]) == property:
			known = true
			break
	if not known:
		return {"type": "error", "message": "%s has no property %s" % [node_path, property]}

	return {
		"type": "property",
		"path": node_path,
		"property": property,
		"value": _values.serialize(node.get(property)),
	}


func set_property(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var property: String = str(params.get("property", ""))
	var value: Variant = params.get("value")

	if node_path.is_empty() or property.is_empty():
		return {"type": "error", "message": "Node path and property required"}

	var node: Node = _host.get_tree().root.get_node_or_null(node_path)
	if node == null:
		return {"type": "error", "message": "Node not found: " + node_path}

	var old_value: Variant = node.get(property)
	node.set(property, _values.fitted(value, typeof(old_value)))

	return {
		"type": "property_set",
		"path": node_path,
		"property": property,
		"old_value": _values.serialize(old_value),
		"new_value": _values.serialize(node.get(property))
	}


func call_method(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	var method: String = str(params.get("method", ""))
	var args: Array = params.get("args", [])

	if node_path.is_empty() or method.is_empty():
		return {"type": "error", "message": "Node path and method required"}

	var node: Node = _host.get_tree().root.get_node_or_null(node_path)
	if node == null:
		return {"type": "error", "message": "Node not found: " + node_path}

	if not node.has_method(method):
		return {"type": "error", "message": "Method not found: " + method}

	var deserialized_args: Array = []
	for index: int in args.size():
		deserialized_args.append(_values.fitted(args[index], _values.parameter_type(node, method, index)))

	var result: Variant = node.callv(method, deserialized_args)

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
