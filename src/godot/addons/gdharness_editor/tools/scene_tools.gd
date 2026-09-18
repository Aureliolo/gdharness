@tool
extends Node

## Scenes and their nodes, edited in the open editor and read back from what it holds.

const Read = preload("../reading.gd")

var _editor_plugin: EditorPlugin = null


func set_editor_plugin(plugin: EditorPlugin) -> void:
	_editor_plugin = plugin


func _refresh_and_reload(scene_path: String) -> void:
	_refresh_filesystem()
	_reload_scene_in_editor(scene_path)


func _refresh_filesystem() -> void:
	if _editor_plugin:
		EditorInterface.get_resource_filesystem().scan()


func _reload_scene_in_editor(scene_path: String) -> void:
	if not _editor_plugin:
		return
	var edited: Node = EditorInterface.get_edited_scene_root()
	if edited and edited.scene_file_path == scene_path:
		EditorInterface.reload_scene_from_path(scene_path)


func _ensure_res_path(path: String) -> String:
	if not path.begins_with("res://"):
		return "res://" + path
	return path


func _to_scene_res_path(project_path: String, scene_path: String) -> String:
	var p: String = scene_path.strip_edges()
	if p.begins_with("res://"):
		return p

	if project_path.strip_edges() != "":
		var normalized_project: String = project_path.replace("\\", "/")
		var normalized_scene: String = p.replace("\\", "/")
		if normalized_scene.begins_with(normalized_project):
			var rel: String = normalized_scene.substr(normalized_project.length())
			if rel.begins_with("/"):
				rel = rel.substr(1)
			return _ensure_res_path(rel)

	return _ensure_res_path(p)


func _load_scene(scene_path: String) -> Array:
	if not FileAccess.file_exists(scene_path):
		return [null, {"ok": false, "error": "Scene not found: " + scene_path}]
	var packed: PackedScene = load(scene_path)
	if not packed:
		return [null, {"ok": false, "error": "Failed to load: " + scene_path}]
	var root: Node = packed.instantiate()
	if not root:
		return [null, {"ok": false, "error": "Failed to instantiate: " + scene_path}]
	return [root, {}]


func _save_scene(scene_root: Node, scene_path: String) -> Dictionary:
	var packed: PackedScene = PackedScene.new()
	if packed.pack(scene_root) != OK:
		scene_root.queue_free()
		return {"ok": false, "error": "Failed to pack scene"}
	if ResourceSaver.save(packed, scene_path) != OK:
		scene_root.queue_free()
		return {"ok": false, "error": "Failed to save scene"}
	scene_root.queue_free()
	_refresh_and_reload(scene_path)
	return {}


func _find_node(root: Node, path: String) -> Node:
	if path == "." or path.is_empty():
		return root
	return root.get_node_or_null(path)


## Turns what arrived over the wire into the Godot value a property wants.
##
## Three separate questions, asked in order, because a caller may say what it means in three
## ways: a dictionary that names its own type, a dictionary shaped like the type the property
## declares, or a bare array positional for a vector. Each is its own function; asking all three
## in one was twenty-four exits deep and impossible to follow.
func _parse_value(value: Variant, expected_type: int = TYPE_NIL) -> Variant:
	if value is Dictionary:
		var fields: Dictionary = value
		var tagged: Array = _parse_tagged_dictionary(fields)
		if tagged[0]:
			return tagged[1]
		return _parse_shaped_dictionary(fields, expected_type)
	if value is Array:
		var items: Array = value
		return _parse_array(items, expected_type)
	return value


## A dictionary carrying its own type name, as the serialiser writes it.
##
## Answers [handled, value] rather than just the value, because a handled tag may legitimately
## produce null: a Resource with no path is "this is nothing", not "this is not mine". A tag
## that names a type but lacks the keys to build it is left unhandled on purpose, so the caller
## can still read it against the type the property declares.
func _parse_tagged_dictionary(value: Dictionary) -> Array:
	var type_tag: String = ""
	if value.has("type"):
		type_tag = str(value["type"])
	elif value.has("_type"):
		type_tag = str(value["_type"])

	match type_tag:
		"Vector2":
			return [true, Vector2(Read.as_float(value.get("x", 0)), Read.as_float(value.get("y", 0)))]
		"Vector3":
			return [
				true,
				Vector3(
					Read.as_float(value.get("x", 0)),
					Read.as_float(value.get("y", 0)),
					Read.as_float(value.get("z", 0))
				)
			]
		"Color":
			return [
				true,
				Color(
					Read.as_float(value.get("r", 1), 1.0),
					Read.as_float(value.get("g", 1), 1.0),
					Read.as_float(value.get("b", 1), 1.0),
					Read.as_float(value.get("a", 1), 1.0)
				)
			]
		"Vector2i":
			return [true, Vector2i(Read.as_int(value.get("x", 0)), Read.as_int(value.get("y", 0)))]
		"Vector3i":
			return [
				true,
				Vector3i(
					Read.as_int(value.get("x", 0)),
					Read.as_int(value.get("y", 0)),
					Read.as_int(value.get("z", 0))
				)
			]
		"Rect2":
			return [
				true,
				Rect2(
					Read.as_float(value.get("x", 0)),
					Read.as_float(value.get("y", 0)),
					Read.as_float(value.get("width", 0)),
					Read.as_float(value.get("height", 0))
				)
			]
		"Transform2D":
			return _parse_transform2d(value)
		"Transform3D":
			return _parse_transform3d(value)
		"NodePath":
			return [true, NodePath(str(value.get("path", "")))]
		"Resource":
			var resource_path: String = str(value.get("path", ""))
			return [true, null if resource_path.is_empty() else load(resource_path)]
		_:
			return _parse_new_resource(type_tag, value)


## A tag naming a Resource class builds a fresh one, its other keys set as properties, so a
## NavigationRegion2D can arrive with its NavigationPolygon and an AnimationTree with its root
## state machine in the same add as any other property.
func _parse_new_resource(type_tag: String, value: Dictionary) -> Array:
	if (
		type_tag.is_empty()
		or not ClassDB.class_exists(type_tag)
		or not ClassDB.is_parent_class(type_tag, "Resource")
		or not ClassDB.can_instantiate(type_tag)
	):
		return [false, null]

	var built: Resource = ClassDB.instantiate(type_tag)
	for key: Variant in value:
		var property: String = str(key)
		if property == "_type" or property == "type":
			continue
		built.set(property, _parse_value(value[key], typeof(built.get(property))))
	return [true, built]


func _parse_transform2d(value: Dictionary) -> Array:
	if not (value.has("x") and value.has("y") and value.has("origin")):
		return [false, null]

	var basis_x: Dictionary = value["x"]
	var basis_y: Dictionary = value["y"]
	var origin: Dictionary = value["origin"]
	return [
		true,
		Transform2D(
			Vector2(Read.as_float(basis_x.get("x", 1), 1.0), Read.as_float(basis_x.get("y", 0))),
			Vector2(Read.as_float(basis_y.get("x", 0)), Read.as_float(basis_y.get("y", 1), 1.0)),
			Vector2(Read.as_float(origin.get("x", 0)), Read.as_float(origin.get("y", 0)))
		)
	]


func _parse_transform3d(value: Dictionary) -> Array:
	if not (value.has("basis") and value.has("origin")):
		return [false, null]

	var b: Dictionary = value["basis"]
	var o: Dictionary = value["origin"]
	var x: Dictionary = b.get("x", {})
	var y: Dictionary = b.get("y", {})
	var z: Dictionary = b.get("z", {})
	var basis: Basis = Basis(
		Vector3(
			Read.as_float(x.get("x", 1), 1.0), Read.as_float(x.get("y", 0)), Read.as_float(x.get("z", 0))
		),
		Vector3(
			Read.as_float(y.get("x", 0)), Read.as_float(y.get("y", 1), 1.0), Read.as_float(y.get("z", 0))
		),
		Vector3(Read.as_float(z.get("x", 0)), Read.as_float(z.get("y", 0)), Read.as_float(z.get("z", 1), 1.0))
	)
	var origin: Vector3 = Vector3(
		Read.as_float(o.get("x", 0)), Read.as_float(o.get("y", 0)), Read.as_float(o.get("z", 0))
	)
	return [true, Transform3D(basis, origin)]


## A dictionary with no tag, read against the type the property declares. Falls back to the
## dictionary itself, since a property may genuinely want one.
func _parse_shaped_dictionary(value: Dictionary, expected_type: int) -> Variant:
	match expected_type:
		TYPE_VECTOR2:
			if value.has("x") and value.has("y"):
				return Vector2(Read.as_float(value["x"]), Read.as_float(value["y"]))
		TYPE_VECTOR2I:
			if value.has("x") and value.has("y"):
				return Vector2i(Read.as_int(value["x"]), Read.as_int(value["y"]))
		TYPE_VECTOR3:
			if value.has("x") and value.has("y") and value.has("z"):
				return Vector3(
					Read.as_float(value["x"]), Read.as_float(value["y"]), Read.as_float(value["z"])
				)
		TYPE_VECTOR3I:
			if value.has("x") and value.has("y") and value.has("z"):
				return Vector3i(Read.as_int(value["x"]), Read.as_int(value["y"]), Read.as_int(value["z"]))
		TYPE_COLOR:
			if value.has("r") and value.has("g") and value.has("b"):
				return Color(
					Read.as_float(value["r"]),
					Read.as_float(value["g"]),
					Read.as_float(value["b"]),
					Read.as_float(value.get("a", 1), 1.0)
				)
		TYPE_RECT2:
			if value.has("x") and value.has("y") and value.has("width") and value.has("height"):
				return Rect2(
					Read.as_float(value["x"]),
					Read.as_float(value["y"]),
					Read.as_float(value["width"]),
					Read.as_float(value["height"])
				)
		TYPE_NODE_PATH:
			if value.has("path"):
				return NodePath(str(value["path"]))
	return value


## An array, either positional for a vector the property declares, or a list to parse per item.
func _parse_array(value: Array, expected_type: int) -> Variant:
	match expected_type:
		TYPE_VECTOR2:
			if value.size() >= 2:
				return Vector2(Read.as_float(value[0]), Read.as_float(value[1]))
		TYPE_VECTOR2I:
			if value.size() >= 2:
				return Vector2i(Read.as_int(value[0]), Read.as_int(value[1]))
		TYPE_VECTOR3:
			if value.size() >= 3:
				return Vector3(Read.as_float(value[0]), Read.as_float(value[1]), Read.as_float(value[2]))
		TYPE_VECTOR3I:
			if value.size() >= 3:
				return Vector3i(Read.as_int(value[0]), Read.as_int(value[1]), Read.as_int(value[2]))
	return value.map(func(item: Variant) -> Variant: return _parse_value(item))


func _get_property_type(node: Node, prop_name: String) -> int:
	for prop: Dictionary in node.get_property_list():
		if str(prop.get("name", "")) == prop_name:
			return Read.as_int(prop.get("type", TYPE_NIL), TYPE_NIL)
	return TYPE_NIL


func _serialize_value(value: Variant) -> Variant:
	match typeof(value):
		TYPE_VECTOR2:
			return {"type": "Vector2", "x": value.x, "y": value.y}
		TYPE_VECTOR3:
			return {"type": "Vector3", "x": value.x, "y": value.y, "z": value.z}
		TYPE_COLOR:
			return {"type": "Color", "r": value.r, "g": value.g, "b": value.b, "a": value.a}
		TYPE_VECTOR2I:
			return {"type": "Vector2i", "x": value.x, "y": value.y}
		TYPE_VECTOR3I:
			return {"type": "Vector3i", "x": value.x, "y": value.y, "z": value.z}
		TYPE_RECT2:
			return {
				"type": "Rect2",
				"x": value.position.x,
				"y": value.position.y,
				"width": value.size.x,
				"height": value.size.y
			}
		TYPE_NODE_PATH:
			return {"type": "NodePath", "path": str(value)}
		TYPE_TRANSFORM2D:
			return {
				"type": "Transform2D",
				"x": {"x": value.x.x, "y": value.x.y},
				"y": {"x": value.y.x, "y": value.y.y},
				"origin": {"x": value.origin.x, "y": value.origin.y}
			}
		TYPE_TRANSFORM3D:
			return {
				"type": "Transform3D",
				"basis":
				{
					"x": {"x": value.basis.x.x, "y": value.basis.x.y, "z": value.basis.x.z},
					"y": {"x": value.basis.y.x, "y": value.basis.y.y, "z": value.basis.y.z},
					"z": {"x": value.basis.z.x, "y": value.basis.z.y, "z": value.basis.z.z}
				},
				"origin": {"x": value.origin.x, "y": value.origin.y, "z": value.origin.z}
			}
		TYPE_OBJECT:
			if value and value is Resource and value.resource_path:
				return {"type": "Resource", "path": value.resource_path}
			return null
		_:
			return value


## Set each property, answering with what went wrong or "" when nothing did.
##
## A property the node does not have, and a resource path nothing is at, are both refused: Object
## .set ignores an unknown name and stores null for a resource that would not load, so either one
## saves a scene that quietly did not change and reports it as a change that did.
func _set_node_properties(node: Node, properties: Dictionary) -> String:
	for prop_name: Variant in properties:
		var property: String = str(prop_name)
		if not _has_property(node, property):
			return "%s has no property %s" % [node.get_class(), property]

		var expected_type: int = _get_property_type(node, property)
		var raw: Variant = properties[prop_name]

		# A resource-valued property takes the path of one, which is how a caller names a
		# TileSet, a material or a theme: there is no other way to hand a tool a Resource.
		if expected_type == TYPE_OBJECT and typeof(raw) == TYPE_STRING:
			var path: String = str(raw)
			# The project boundary is enforced here as well as on the server, because only the
			# engine knows that this property is one holding a path: an absolute path and a
			# user:// one both load, and neither names a file this project owns.
			if not (path.begins_with("res://") or path.begins_with("uid://")):
				return "%s takes a res:// or uid:// path, not %s" % [property, path]
			if path.split("/").has(".."):
				return "%s leaves the project: %s" % [property, path]
			if not ResourceLoader.exists(path):
				return "No resource at %s for %s" % [path, property]
			node.set(property, load(path))
			continue

		node.set(property, _parse_value(raw, expected_type))
	return ""


func _has_property(node: Node, prop_name: String) -> bool:
	for prop: Dictionary in node.get_property_list():
		if str(prop.get("name", "")) == prop_name:
			return true
	return false


func _parse_properties_arg(raw_properties: Variant) -> Dictionary:
	if typeof(raw_properties) == TYPE_DICTIONARY:
		return raw_properties
	if typeof(raw_properties) == TYPE_STRING:
		var text: String = str(raw_properties)
		if text.strip_edges().is_empty():
			return {}
		var parsed: Variant = JSON.parse_string(text)
		if typeof(parsed) == TYPE_DICTIONARY:
			return parsed
	return {}


func _ensure_parent_dir_for_scene(scene_path: String) -> void:
	var base_dir: String = scene_path.get_base_dir()
	if not DirAccess.dir_exists_absolute(base_dir):
		var made: Error = DirAccess.make_dir_recursive_absolute(base_dir)
		if made != OK:
			push_error("gdharness: could not create " + base_dir + ": " + error_string(made))


func _set_owner_recursive(node: Node, scene_owner: Node) -> void:
	node.owner = scene_owner
	for child: Node in node.get_children():
		_set_owner_recursive(child, scene_owner)


func _build_node_tree(
	node: Node, include_properties: bool, depth: int, current_depth: int, node_path: String
) -> Dictionary:
	var children: Array[Dictionary] = []
	var data: Dictionary = {
		"name": str(node.name), "type": node.get_class(), "path": node_path, "children": children
	}

	if include_properties:
		var props: Dictionary = {}
		for p: Dictionary in node.get_property_list():
			if not (Read.as_int(p.get("usage", 0)) & PROPERTY_USAGE_STORAGE):
				continue
			var pn: String = str(p.get("name", ""))
			if pn.is_empty():
				continue
			props[pn] = _serialize_value(node.get(pn))
		data["properties"] = props

	if depth >= 0 and current_depth >= depth:
		return data

	for child: Node in node.get_children():
		var child_path: String = str(child.name) if node_path == "." else node_path + "/" + str(child.name)
		children.append(_build_node_tree(child, include_properties, depth, current_depth + 1, child_path))

	return data


func _collect_nodes_recursive(node: Node, path: String, out_nodes: Array) -> void:
	out_nodes.append({"path": path, "node": node})
	for child: Node in node.get_children():
		var child_path: String = str(child.name) if path == "." else path + "/" + str(child.name)
		_collect_nodes_recursive(child, child_path, out_nodes)


func create_scene(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = _to_scene_res_path(project_path, str(args.get("scenePath", "")))
	var root_node_type: String = str(args.get("rootNodeType", "Node"))
	var script_path: String = str(args.get("scriptPath", ""))

	if scene_path == "res://":
		return {"ok": false, "error": "Missing scenePath"}
	if not scene_path.ends_with(".tscn"):
		scene_path += ".tscn"
	if not ClassDB.class_exists(root_node_type):
		return {"ok": false, "error": "Invalid rootNodeType: " + root_node_type}

	_ensure_parent_dir_for_scene(scene_path)

	var root: Node = ClassDB.instantiate(root_node_type)
	if not root:
		return {"ok": false, "error": "Failed to instantiate root node: " + root_node_type}
	root.name = root_node_type

	if not script_path.is_empty():
		var full_script_path: String = _to_scene_res_path(project_path, script_path)
		var script: Resource = load(full_script_path)
		if not script:
			root.queue_free()
			return {"ok": false, "error": "Failed to load script: " + full_script_path}
		root.set_script(script)

	var err: Dictionary = _save_scene(root, scene_path)
	if not err.is_empty():
		return err

	return {"ok": true, "scenePath": scene_path, "rootNodeType": root_node_type}


func list_scene_nodes(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = _to_scene_res_path(project_path, str(args.get("scenePath", "")))
	var depth: int = Read.as_int(args.get("depth", -1), -1)
	var include_properties: bool = Read.as_bool(args.get("includeProperties", false))

	var loaded: Array = _load_scene(scene_path)
	var refused: Dictionary = loaded[1]
	if not refused.is_empty():
		return refused

	var root: Node = loaded[0]
	var tree: Dictionary = _build_node_tree(root, include_properties, depth, 0, ".")
	root.queue_free()
	return {"ok": true, "tree": tree}


func add_node(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = _to_scene_res_path(project_path, str(args.get("scenePath", "")))
	var node_type: String = str(args.get("nodeType", ""))
	var node_name: String = str(args.get("nodeName", ""))
	var parent_node_path: String = str(args.get("parentNodePath", "."))
	var properties: Dictionary = _parse_properties_arg(args.get("properties", {}))

	if node_type.is_empty() or node_name.is_empty():
		return {"ok": false, "error": "Missing nodeType or nodeName"}
	if not ClassDB.class_exists(node_type):
		return {"ok": false, "error": "Invalid nodeType: " + node_type}

	var loaded: Array = _load_scene(scene_path)
	var refused: Dictionary = loaded[1]
	if not refused.is_empty():
		return refused

	var root: Node = loaded[0]
	var parent: Node = _find_node(root, parent_node_path)
	if not parent:
		root.queue_free()
		return {"ok": false, "error": "Parent node not found: " + parent_node_path}

	var new_node: Node = ClassDB.instantiate(node_type)
	if not new_node:
		root.queue_free()
		return {"ok": false, "error": "Failed to instantiate nodeType: " + node_type}

	new_node.name = node_name
	var refused_property: String = _set_node_properties(new_node, properties)
	if not refused_property.is_empty():
		new_node.queue_free()
		root.queue_free()
		return {"ok": false, "error": refused_property}

	parent.add_child(new_node)
	_set_owner_recursive(new_node, root)

	var err: Dictionary = _save_scene(root, scene_path)
	if not err.is_empty():
		return err

	return {"ok": true, "nodeName": node_name, "nodeType": node_type}


func delete_node(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = _to_scene_res_path(project_path, str(args.get("scenePath", "")))
	var node_path: String = str(args.get("nodePath", ""))

	if node_path.is_empty() or node_path == ".":
		return {"ok": false, "error": "Cannot delete root node"}

	var loaded: Array = _load_scene(scene_path)
	var refused: Dictionary = loaded[1]
	if not refused.is_empty():
		return refused

	var root: Node = loaded[0]
	var node: Node = _find_node(root, node_path)
	if not node:
		root.queue_free()
		return {"ok": false, "error": "Node not found: " + node_path}

	var parent: Node = node.get_parent()
	if not parent:
		root.queue_free()
		return {"ok": false, "error": "Cannot delete root node"}

	parent.remove_child(node)
	node.queue_free()

	var err: Dictionary = _save_scene(root, scene_path)
	if not err.is_empty():
		return err

	return {"ok": true, "deletedNodePath": node_path}


func duplicate_node(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = _to_scene_res_path(project_path, str(args.get("scenePath", "")))
	var node_path: String = str(args.get("nodePath", ""))
	var new_name: String = str(args.get("newName", ""))
	var parent_path: String = str(args.get("parentPath", ""))

	if node_path.is_empty() or new_name.is_empty():
		return {"ok": false, "error": "Missing nodePath or newName"}

	var loaded: Array = _load_scene(scene_path)
	var refused: Dictionary = loaded[1]
	if not refused.is_empty():
		return refused

	var root: Node = loaded[0]
	var source: Node = _find_node(root, node_path)
	if not source:
		root.queue_free()
		return {"ok": false, "error": "Node not found: " + node_path}

	var target_parent: Node = source.get_parent()
	if not parent_path.is_empty():
		target_parent = _find_node(root, parent_path)
	if not target_parent:
		root.queue_free()
		return {"ok": false, "error": "Parent not found: " + parent_path}

	var duplicated_node: Node = source.duplicate()
	if not duplicated_node:
		root.queue_free()
		return {"ok": false, "error": "Failed to duplicate node: " + node_path}

	duplicated_node.name = new_name
	target_parent.add_child(duplicated_node)
	_set_owner_recursive(duplicated_node, root)

	var err: Dictionary = _save_scene(root, scene_path)
	if not err.is_empty():
		return err

	return {"ok": true, "nodePath": node_path, "newName": new_name}


func reparent_node(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = _to_scene_res_path(project_path, str(args.get("scenePath", "")))
	var node_path: String = str(args.get("nodePath", ""))
	var new_parent_path: String = str(args.get("newParentPath", ""))

	if node_path.is_empty() or node_path == ".":
		return {"ok": false, "error": "Cannot reparent root node"}
	if new_parent_path.is_empty():
		return {"ok": false, "error": "Missing newParentPath"}

	var loaded: Array = _load_scene(scene_path)
	var refused: Dictionary = loaded[1]
	if not refused.is_empty():
		return refused

	var root: Node = loaded[0]
	var node: Node = _find_node(root, node_path)
	var new_parent: Node = _find_node(root, new_parent_path)
	if not node:
		root.queue_free()
		return {"ok": false, "error": "Node not found: " + node_path}
	if not new_parent:
		root.queue_free()
		return {"ok": false, "error": "New parent not found: " + new_parent_path}

	var old_parent: Node = node.get_parent()
	if not old_parent:
		root.queue_free()
		return {"ok": false, "error": "Cannot reparent root node"}

	old_parent.remove_child(node)
	new_parent.add_child(node)
	_set_owner_recursive(node, root)

	var err: Dictionary = _save_scene(root, scene_path)
	if not err.is_empty():
		return err

	return {"ok": true, "nodePath": node_path, "newParentPath": new_parent_path}


func set_node_properties(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = _to_scene_res_path(project_path, str(args.get("scenePath", "")))
	var node_path: String = str(args.get("nodePath", "."))
	var properties: Dictionary = _parse_properties_arg(args.get("properties", {}))

	var loaded: Array = _load_scene(scene_path)
	var refused: Dictionary = loaded[1]
	if not refused.is_empty():
		return refused

	var root: Node = loaded[0]
	var node: Node = _find_node(root, node_path)
	if not node:
		root.queue_free()
		return {"ok": false, "error": "Node not found: " + node_path}

	var refused_property: String = _set_node_properties(node, properties)
	if not refused_property.is_empty():
		root.queue_free()
		return {"ok": false, "error": refused_property}

	var err: Dictionary = _save_scene(root, scene_path)
	if not err.is_empty():
		return err

	return {"ok": true, "nodePath": node_path}


func get_node_properties(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = _to_scene_res_path(project_path, str(args.get("scenePath", "")))
	var node_path: String = str(args.get("nodePath", "."))
	var include_defaults: bool = Read.as_bool(args.get("includeDefaults", false))

	var loaded: Array = _load_scene(scene_path)
	var refused: Dictionary = loaded[1]
	if not refused.is_empty():
		return refused

	var root: Node = loaded[0]
	var node: Node = _find_node(root, node_path)
	if not node:
		root.queue_free()
		return {"ok": false, "error": "Node not found: " + node_path}

	var defaults: Node = null
	if not include_defaults and ClassDB.class_exists(node.get_class()):
		defaults = ClassDB.instantiate(node.get_class())

	var props: Dictionary = {}
	for p: Dictionary in node.get_property_list():
		var usage: int = Read.as_int(p.get("usage", 0))
		if not (usage & PROPERTY_USAGE_STORAGE):
			continue
		var prop_name: String = str(p.get("name", ""))
		if prop_name.is_empty():
			continue
		var current_val: Variant = node.get(prop_name)
		if not include_defaults and defaults:
			var default_val: Variant = defaults.get(prop_name)
			if current_val == default_val:
				continue
		props[prop_name] = _serialize_value(current_val)

	if defaults:
		defaults.queue_free()
	root.queue_free()
	return {"ok": true, "nodePath": node_path, "properties": props}


func save_scene(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = _to_scene_res_path(project_path, str(args.get("scenePath", "")))
	var new_path_raw: String = str(args.get("newPath", ""))
	var target_path: String = scene_path
	if not new_path_raw.is_empty():
		target_path = _to_scene_res_path(project_path, new_path_raw)

	var loaded: Array = _load_scene(scene_path)
	var refused: Dictionary = loaded[1]
	if not refused.is_empty():
		return refused

	_ensure_parent_dir_for_scene(target_path)
	var root: Node = loaded[0]
	var err: Dictionary = _save_scene(root, target_path)
	if not err.is_empty():
		return err

	return {"ok": true, "scenePath": scene_path, "savedPath": target_path}


func connect_signal(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = _to_scene_res_path(project_path, str(args.get("scenePath", "")))
	var source_node_path: String = str(args.get("sourceNodePath", ""))
	var signal_name: String = str(args.get("signalName", ""))
	var target_node_path: String = str(args.get("targetNodePath", ""))
	var method_name: String = str(args.get("methodName", ""))
	# A connection without CONNECT_PERSIST is a runtime one, and PackedScene.pack drops those on
	# the way out: without this the scene saves unchanged and this answers success over nothing.
	var flags: int = Read.as_int(args.get("flags", 0)) | Object.CONNECT_PERSIST

	if (
		source_node_path.is_empty()
		or signal_name.is_empty()
		or target_node_path.is_empty()
		or method_name.is_empty()
	):
		return {"ok": false, "error": "Missing required signal connection arguments"}

	var loaded: Array = _load_scene(scene_path)
	var refused: Dictionary = loaded[1]
	if not refused.is_empty():
		return refused

	var root: Node = loaded[0]
	var source: Node = _find_node(root, source_node_path)
	var target: Node = _find_node(root, target_node_path)
	if not source:
		root.queue_free()
		return {"ok": false, "error": "Source node not found: " + source_node_path}
	if not target:
		root.queue_free()
		return {"ok": false, "error": "Target node not found: " + target_node_path}
	if not source.has_signal(signal_name):
		root.queue_free()
		return {"ok": false, "error": "Signal not found on source: " + signal_name}

	var callable: Callable = Callable(target, method_name)
	if not source.is_connected(signal_name, callable):
		var connect_result: Error = source.connect(signal_name, callable, flags)
		if connect_result != OK:
			root.queue_free()
			return {"ok": false, "error": "Failed to connect signal: " + error_string(connect_result)}

	var err: Dictionary = _save_scene(root, scene_path)
	if not err.is_empty():
		return err

	return {
		"ok": true,
		"sourceNodePath": source_node_path,
		"signalName": signal_name,
		"targetNodePath": target_node_path,
		"methodName": method_name,
		"flags": flags
	}


func disconnect_signal(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = _to_scene_res_path(project_path, str(args.get("scenePath", "")))
	var source_node_path: String = str(args.get("sourceNodePath", ""))
	var signal_name: String = str(args.get("signalName", ""))
	var target_node_path: String = str(args.get("targetNodePath", ""))
	var method_name: String = str(args.get("methodName", ""))

	if (
		source_node_path.is_empty()
		or signal_name.is_empty()
		or target_node_path.is_empty()
		or method_name.is_empty()
	):
		return {"ok": false, "error": "Missing required signal disconnection arguments"}

	var loaded: Array = _load_scene(scene_path)
	var refused: Dictionary = loaded[1]
	if not refused.is_empty():
		return refused

	var root: Node = loaded[0]
	var source: Node = _find_node(root, source_node_path)
	var target: Node = _find_node(root, target_node_path)
	if not source:
		root.queue_free()
		return {"ok": false, "error": "Source node not found: " + source_node_path}
	if not target:
		root.queue_free()
		return {"ok": false, "error": "Target node not found: " + target_node_path}

	var callable: Callable = Callable(target, method_name)
	if source.is_connected(signal_name, callable):
		source.disconnect(signal_name, callable)

	var err: Dictionary = _save_scene(root, scene_path)
	if not err.is_empty():
		return err

	return {
		"ok": true,
		"sourceNodePath": source_node_path,
		"signalName": signal_name,
		"targetNodePath": target_node_path,
		"methodName": method_name
	}


func list_connections(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = _to_scene_res_path(project_path, str(args.get("scenePath", "")))
	var filter_path: String = str(args.get("nodePath", ""))

	var loaded: Array = _load_scene(scene_path)
	var refused: Dictionary = loaded[1]
	if not refused.is_empty():
		return refused

	var root: Node = loaded[0]
	var nodes: Array = []
	_collect_nodes_recursive(root, ".", nodes)

	var connections: Array = []
	for entry: Dictionary in nodes:
		var path: String = str(entry["path"])
		if not filter_path.is_empty() and filter_path != path:
			continue
		var node: Node = entry["node"]
		for signal_info: Dictionary in node.get_signal_list():
			var signal_name: String = str(signal_info.get("name", ""))
			if signal_name.is_empty():
				continue
			for conn: Dictionary in node.get_signal_connection_list(signal_name):
				var callable: Callable = conn.get("callable", Callable())
				var target_obj: Object = callable.get_object()
				var target_path: String = ""
				if target_obj is Node:
					target_path = str(root.get_path_to(target_obj as Node))
				connections.append(
					{
						"sourceNodePath": path,
						"signalName": signal_name,
						"targetNodePath": target_path,
						"methodName": str(callable.get_method()),
						"flags": Read.as_int(conn.get("flags", 0))
					}
				)

	root.queue_free()
	return {"ok": true, "connections": connections}


## Rescan the project filesystem, and report whether a scan is still running.
##
## The editor rescans when its window regains focus, so a script written by anything other
## than the editor stays invisible until someone clicks on Godot. Until then its
## `class_name` is missing from the global class list and the language server reports every
## use of it as an unknown type, which is godotengine/godot#42786.
##
## Returns as soon as the scan is queued rather than awaiting it, because the tool executor
## takes a Dictionary and not a coroutine. Pass `statusOnly` to poll without starting
## another scan.
func rescan_filesystem(args: Dictionary) -> Dictionary:
	if not _editor_plugin:
		return {"ok": false, "error": "Editor plugin unavailable"}

	var filesystem: EditorFileSystem = EditorInterface.get_resource_filesystem()
	if not Read.as_bool(args.get("statusOnly", false)):
		filesystem.scan()

	# Importing is reported separately from scanning, and a class is not registered until
	# both are done, so a caller watching only one of them can look too early.
	return {"ok": true, "scanning": filesystem.is_scanning(), "importing": filesystem.is_importing()}
