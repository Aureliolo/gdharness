@tool
extends RefCounted

## Where else in a scene a resource built into it is held, since such a resource is one object
## wherever the scene uses it.

const GdhPropertyPaths = preload("../property_paths.gd")
const GdhRead = preload("../reading.gd")
const GdhSceneFile = preload("../scene_file.gd")


## Every other place in [param scene] holding a resource that [param key] was written through on
## [param node], as {node, property}. A copy made by duplicate shares its original's resources, so
## the write changed each of them too.
static func holders(scene: GdhSceneFile, node: Node, key: String) -> Array[Dictionary]:
	var found_at: Array[Dictionary] = []
	var through: Array = GdhPropertyPaths.holder_of(node, key, GdhPropertyPaths.home_of(node))[2]
	if through.is_empty():
		return found_at
	var wanted: Dictionary = {}
	for reached: Resource in through:
		wanted[reached.get_instance_id()] = true
	var nodes: Array[Node] = [scene.root]
	nodes.append_array(scene.root.find_children("*", "", true, false))
	for at: Node in nodes:
		for declared: Dictionary in at.get_property_list():
			var property: String = str(declared.get("name", ""))
			if property.is_empty() or not (GdhRead.as_int(declared.get("usage", 0)) & PROPERTY_USAGE_STORAGE):
				continue
			for found: String in _paths_to(at.get(property), property, wanted, {}):
				if at != node or not key.begins_with(found + "/"):
					found_at.append({"node": scene.path_of(at), "property": found})
	return found_at


## The paths below [param path] at which [param value] holds a resource of [param wanted], by
## instance id, stepping into lists and into resources built into a scene.
static func _paths_to(value: Variant, path: String, wanted: Dictionary, seen: Dictionary) -> Array[String]:
	var paths: Array[String] = []
	if value is Array:
		var items: Array = value
		for index: int in items.size():
			paths.append_array(_paths_to(items[index], "%s/%d" % [path, index], wanted, seen))
		return paths
	if not value is Resource:
		return paths
	var held: Resource = value
	var id: int = held.get_instance_id()
	if wanted.has(id):
		paths.append(path)
	var built_in: bool = held.resource_path.is_empty() or held.resource_path.contains("::")
	if seen.has(id) or not built_in:
		return paths
	seen[id] = true
	for declared: Dictionary in held.get_property_list():
		var property: String = str(declared.get("name", ""))
		if not property.is_empty() and GdhRead.as_int(declared.get("usage", 0)) & PROPERTY_USAGE_STORAGE:
			paths.append_array(_paths_to(held.get(property), path + "/" + property, wanted, seen))
	return paths
