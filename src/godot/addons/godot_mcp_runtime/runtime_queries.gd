extends RefCounted

## What the server asks about the running tree: its shape, one node, the nodes matching a
## question, where one is on screen, a property set, a method called, the metrics.

const Values = preload("runtime_values.gd")

## The most nodes one find answers with, unless asked for fewer: enough for any real query and
## far short of the tree dump a query exists to avoid.
const FIND_LIMIT: int = 100
const FIND_LIMIT_CEILING: int = 1000

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


func get_node(params: Dictionary) -> Dictionary:
	var node_path: String = str(params.get("path", ""))
	if node_path.is_empty():
		return {"type": "error", "message": "Node path required"}

	var node: Node = _host.get_tree().root.get_node_or_null(node_path)
	if node == null:
		return {"type": "error", "message": "Node not found: " + node_path}

	return {"type": "node", "data": _serialize_node(node, true)}


## Nodes matching every filter given, as paths, so a caller can name what it wants without
## reading the whole tree to find it. `class` matches native classes and their subclasses, and
## the global name of a script class; `name` is a case-insensitive glob; `script` is a path.
func find_nodes(params: Dictionary) -> Dictionary:
	var root_path: String = str(params.get("root", "/root"))
	var wanted_class: String = str(params.get("class", ""))
	var wanted_script: String = str(params.get("script", ""))
	var wanted_name: String = str(params.get("name", ""))
	var wanted_group: String = str(params.get("group", ""))
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
			found.append(_serialize_node(node, false))
		var children: Array[Node] = node.get_children()
		for index: int in range(children.size() - 1, -1, -1):
			pending.push_front(children[index])

	return {"type": "nodes", "count": found.size(), "truncated": truncated, "nodes": found}


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


## Where a node is on screen: a Control's rectangle, or a Node2D's position, in both the
## canvas coordinates the node reports and the window pixels input arrives in. The two differ
## whenever the project stretches its viewport, which is what made a rect unusable for a click.
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
	return {
		"type": "error", "message": "%s is a %s, which has no place on screen" % [node_path, node.get_class()]
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
		for child: Node in node.get_children():
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
