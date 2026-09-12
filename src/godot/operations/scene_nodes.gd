extends RefCounted

const Log = preload("logger.gd")
const Serialisation = preload("serialisation.gd")

var _log: Log
var _values := Serialisation.new()


func _init(p_log: Log) -> void:
	_log = p_log


# List all nodes in a scene with their hierarchy
func list_scene_nodes(params) -> Dictionary:
	var scene_path = _normalise_scene_path(params.scene_path)
	_log.info("Listing nodes in scene: " + scene_path)
	_log.debug("Scene path (with res://): " + scene_path)

	if not FileAccess.file_exists(scene_path):
		return _log.failure("Scene file does not exist: " + scene_path)

	var scene = load(scene_path)
	if not scene:
		return _log.failure("Failed to load scene: " + scene_path)

	var scene_root = scene.instantiate()
	if not scene_root:
		return _log.failure("Failed to instantiate scene")

	_log.debug("Scene loaded and instantiated successfully")

	var max_depth = params.get("depth", -1)
	var include_properties = params.get("include_properties", false)

	_log.debug("Max depth: " + str(max_depth))
	_log.debug("Include properties: " + str(include_properties))

	var result = {
		"scene_path": params.scene_path,
		"root": _build_node_tree(scene_root, 0, max_depth, include_properties)
	}

	scene_root.queue_free()
	return result


# Set properties on a node
func set_node_properties(params) -> Dictionary:
	var scene_path = _normalise_scene_path(params.scene_path)
	var node_path = params.node_path
	var properties = params.properties
	var save_scene_after = params.get("save_scene", true)

	_log.info("Setting properties on node: " + node_path + " in scene: " + scene_path)
	_log.debug("Properties to set: " + JSON.stringify(properties))

	if not FileAccess.file_exists(scene_path):
		return _log.failure("Scene file does not exist: " + scene_path)

	var scene = load(scene_path)
	if not scene:
		return _log.failure("Failed to load scene: " + scene_path)

	var scene_root = scene.instantiate()
	if not scene_root:
		return _log.failure("Failed to instantiate scene")

	var target_node = node_at_path(scene_root, node_path)
	if not target_node:
		scene_root.queue_free()
		return _log.failure("Node not found: " + node_path)

	_log.debug("Found node: " + target_node.name + " of type: " + target_node.get_class())

	var set_count = 0

	for prop_name in properties:
		var value = _values.deserialize_value(properties[prop_name])
		_log.debug("Setting property: " + prop_name + " = " + str(value))

		target_node.set(prop_name, value)
		set_count += 1

	if save_scene_after:
		var packed_scene = PackedScene.new()
		var pack_result = packed_scene.pack(scene_root)

		if pack_result != OK:
			scene_root.queue_free()
			return _log.failure("Failed to pack scene: " + str(pack_result))

		var save_error = ResourceSaver.save(packed_scene, scene_path)
		if save_error != OK:
			scene_root.queue_free()
			return _log.failure("Failed to save scene: " + str(save_error))

		_log.debug("Scene saved successfully")

	var result = {
		"scene_path": params.scene_path,
		"node_path": node_path,
		"properties_set": set_count,
		"failed_properties": [],
		"scene_saved": save_scene_after
	}

	scene_root.queue_free()
	return result


func _normalise_scene_path(path: String) -> String:
	if not path.begins_with("res://"):
		return "res://" + path
	return path


# The node a caller means by "root", "root/Child" or "Child", or null when there is none.
func node_at_path(scene_root: Node, node_path: String) -> Node:
	if node_path == "root" or node_path == "":
		return scene_root

	# Remove "root/" prefix if present
	var clean_path = node_path
	if clean_path.begins_with("root/"):
		clean_path = clean_path.substr(5)
	elif clean_path.begins_with("root"):
		clean_path = clean_path.substr(4)
		if clean_path.begins_with("/"):
			clean_path = clean_path.substr(1)

	if clean_path.is_empty():
		return scene_root

	return scene_root.get_node_or_null(clean_path)


func set_owner_recursive(node: Node, owner: Node) -> void:
	for child in node.get_children():
		child.owner = owner
		set_owner_recursive(child, owner)


func _build_node_tree(node: Node, current_depth: int, max_depth: int, include_properties: bool) -> Dictionary:
	var result = {
		"name": node.name,
		"type": node.get_class(),
		"path": str(node.get_path()) if node.is_inside_tree() else node.name
	}

	if include_properties:
		result["properties"] = _non_default_properties(node)

	# Add children if within depth limit
	if max_depth == -1 or current_depth < max_depth:
		var children = []
		for child in node.get_children():
			children.append(_build_node_tree(child, current_depth + 1, max_depth, include_properties))
		if children.size() > 0:
			result["children"] = children

	return result


func _non_default_properties(node: Node) -> Dictionary:
	var props = {}

	for prop in node.get_property_list():
		var prop_name = prop["name"]
		var prop_usage = prop["usage"]

		# Skip internal properties and script/metadata
		if prop_usage & PROPERTY_USAGE_STORAGE == 0:
			continue
		if prop_name.begins_with("_") or prop_name == "script" or prop_name == "metadata":
			continue

		props[prop_name] = _values.serialize_value(node.get(prop_name))

	return props
