extends RefCounted

## Scenes and resources read from their files, by the editor's tools and by a headless engine with
## none connected, so a read answers the same either way.
##
## A scene is read off its SceneState rather than instantiated. Instantiating outside the editor
## runs every script's member initialisers and _init (measured on 4.7.2, with or without -e), so a
## read with no editor would have run the game's code on every node; the editor gets placeholders
## and runs none. The state holds everything the file says, and the scenes it instances theirs,
## without making a node. Loading the file still does what loading does in the game: static
## initialisers run, and a resource with a script is made with it.

const PropertyValues = preload("property_values.gd")
const Read = preload("reading.gd")
const Serialisation = preload("serialisation.gd")


## The nodes of [param scene_path] as {name, type, path, children}, with instanceOf on a node that
## instances another scene and every stored property when [param include_properties] is set, the
## file's value or the default where it sets none. [param depth] -1 reads every level.
static func scene_tree(scene_path: String, depth: int, include_properties: bool) -> Dictionary:
	if not FileAccess.file_exists(scene_path):
		return {"ok": false, "error": "Scene not found: " + scene_path}
	# Loaded without naming the type, so a resource handed in by mistake loads as what it is and the
	# refusal can say so, where asking for a PackedScene printed the loader's error and a backtrace.
	var loaded: Resource = ResourceLoader.load(scene_path, "", ResourceLoader.CACHE_MODE_IGNORE)
	if loaded == null:
		return {"ok": false, "error": "Failed to load %s as a scene" % scene_path}
	if not loaded is PackedScene:
		return {
			"ok": false,
			"error":
			(
				"%s is a %s, not a scene: resource_edit read reads its properties."
				% [scene_path, loaded.get_class()]
			)
		}
	var packed: PackedScene = loaded
	var nodes: Dictionary = {}
	var refused: String = _lay(packed.get_state(), ".", nodes, [scene_path])
	if not refused.is_empty():
		return {"ok": false, "error": refused}
	if not nodes.has("."):
		return {"ok": false, "error": "%s holds no nodes" % scene_path}
	return {"ok": true, "tree": _entry(nodes, ".", include_properties, depth, 0)}


## Lays the nodes of [param state] into [param nodes] under [param prefix], keyed by their path
## from the outermost root, each instanced scene laid where it is instanced and the instancing
## file's own entries for it applied over it. Answers a refusal, or "".
##
## [param within] is the files being laid, outermost first, so a scene that instances one of them
## is refused rather than laid forever; the engine refuses to load such a scene, so this is only
## reached through a state built some other way.
static func _lay(state: SceneState, prefix: String, nodes: Dictionary, within: Array) -> String:
	var base: SceneState = state.get_base_scene_state()
	if base != null and not nodes.has(prefix):
		var refused: String = _lay(base, prefix, nodes, within)
		if not refused.is_empty():
			return refused
	for index: int in state.get_node_count():
		var path: String = _joined(prefix, str(state.get_node_path(index)))
		var fresh: bool = not nodes.has(path)
		if fresh:
			var instance: PackedScene = state.get_node_instance(index)
			if instance != null:
				if within.has(instance.resource_path):
					return "%s instances %s, which holds it" % [within.back(), instance.resource_path]
				var refused: String = _lay(
					instance.get_state(), path, nodes, within + [instance.resource_path]
				)
				if not refused.is_empty():
					return refused
				if not nodes.has(path):
					return "%s holds no nodes" % instance.resource_path
				nodes[path]["instanceOf"] = instance.resource_path
			elif state.is_node_instance_placeholder(index):
				nodes[path] = _made("InstancePlaceholder")
				nodes[path]["instanceOf"] = state.get_node_instance_placeholder(index)
			elif str(state.get_node_type(index)).is_empty():
				# An entry for a node of an instance that no longer has it, which the engine skips too.
				continue
			else:
				nodes[path] = _made(str(state.get_node_type(index)))
		# The name is the state's even for an entry laid already, since an inherited scene names its
		# root itself; a root instanced inside another scene is renamed by that scene once laid.
		nodes[path]["name"] = str(state.get_node_name(index))
		if fresh:
			# The root of what is laid here is placed by whoever instanced it.
			if path != prefix:
				_place(
					nodes,
					_joined(prefix, str(state.get_node_path(index, true))),
					path,
					state.get_node_index(index)
				)
		var held: Dictionary = nodes[path]["properties"]
		for property: int in state.get_node_property_count(index):
			held[str(state.get_node_property_name(index, property))] = state.get_node_property_value(
				index, property
			)
	return ""


static func _made(type: String) -> Dictionary:
	var children: Array[String] = []
	return {"name": "", "type": type, "properties": {}, "children": children}


## Puts [param path] among [param parent]'s children, at [param at] when the file says where (a node
## added inside an instance) and last when it does not.
static func _place(nodes: Dictionary, parent: String, path: String, at: int) -> void:
	if not nodes.has(parent):
		return
	var children: Array[String] = nodes[parent]["children"]
	if at >= 0 and at < children.size():
		var _placed: int = children.insert(at, path)
	else:
		children.append(path)


## [param given], a path as a SceneState gives it ("." or "./Body/Tail"), under [param prefix].
static func _joined(prefix: String, given: String) -> String:
	var relative: String = given.trim_prefix("./")
	if relative == "." or relative.is_empty():
		return prefix
	if prefix == ".":
		return relative
	return prefix + "/" + relative


static func _entry(
	nodes: Dictionary, path: String, include_properties: bool, depth: int, current_depth: int
) -> Dictionary:
	var node: Dictionary = nodes[path]
	var children: Array[Dictionary] = []
	var data: Dictionary = {"name": node["name"], "type": node["type"], "path": path, "children": children}
	# The root's file is the scene being read, so only another node's names a second scene.
	if path != "." and node.has("instanceOf"):
		data["instanceOf"] = node["instanceOf"]
	if include_properties:
		var given: Dictionary = node["properties"]
		data["properties"] = _stored(str(node["type"]), given)
	if depth >= 0 and current_depth >= depth:
		return data
	for child: String in node["children"]:
		children.append(_entry(nodes, child, include_properties, depth, current_depth + 1))
	return data


## Every property a node of [param type] stores, with the value [param given] sets or the default,
## read as a node holding those values would answer them.
##
## The engine's half is read off a bare node of the class with the file's values set on it, which
## runs no script: what a node lists depends on its values (a thread group's settings appear only
## once it has one) and some setters set others (a Control's anchors preset sets how it grows), so
## the class's defaults and the file's entries alone answered neither. The script's half is its
## declared defaults under the file's values.
static func _stored(type: String, given: Dictionary) -> Dictionary:
	var attached: Variant = given.get("script")
	var script: Script = attached if attached is Script else null
	var scripted: Dictionary = {}
	if script != null:
		for declared: Dictionary in script.get_script_property_list():
			var property: String = str(declared.get("name", ""))
			if not property.is_empty() and Read.as_int(declared.get("usage", 0)) & PROPERTY_USAGE_STORAGE:
				scripted[property] = script.get_property_default_value(property)
	var values: Dictionary = {}
	if ClassDB.class_exists(type) and ClassDB.can_instantiate(type):
		var bare: Object = ClassDB.instantiate(type)
		for property: Variant in given:
			if property != "script" and not scripted.has(property):
				bare.set(str(property), given[property])
		for declared: Dictionary in bare.get_property_list():
			var property: String = str(declared.get("name", ""))
			if not property.is_empty() and Read.as_int(declared.get("usage", 0)) & PROPERTY_USAGE_STORAGE:
				values[property] = bare.get(property)
		if bare is Node:
			bare.free()
	for property: String in scripted:
		values[property] = scripted[property]
	# Given last, which keeps what a bare node cannot hold: the script itself, and a path to a node
	# for a property that holds the node once it is in a tree.
	values.merge(given, true)
	var serialiser: Serialisation = Serialisation.new()
	var answered: Dictionary = {}
	for property: Variant in values:
		answered[property] = serialiser.serialize_value(values[property])
	return answered


## What a resource file holds, in the form modify takes, so a value read here can be written back.
## Read from the file rather than a cached copy, since the file is what the writes change and what
## the project loads.
static func resource(res_path: String, include_defaults: bool) -> Dictionary:
	if not FileAccess.file_exists(res_path):
		return {"ok": false, "error": "No resource at " + res_path}
	var loaded: Resource = ResourceLoader.load(res_path, "", ResourceLoader.CACHE_MODE_IGNORE)
	if loaded == null:
		return {"ok": false, "error": "%s did not load as a resource." % res_path}
	# A scene's own properties are its packed bundle, which says nothing a caller can use.
	if loaded is PackedScene:
		return {
			"ok": false,
			"error":
			"%s is a scene: scene_tree reads its nodes, and scene_node get one node's properties." % res_path
		}

	var script: Script = loaded.get_script()
	var scripted: Dictionary = {}
	if script != null:
		for declared: Dictionary in script.get_script_property_list():
			scripted[str(declared.get("name", ""))] = true
	var serialiser: Serialisation = Serialisation.new()
	var properties: Dictionary = {}
	for p: Dictionary in loaded.get_property_list():
		var property: String = str(p.get("name", ""))
		if property.is_empty() or property == "script":
			continue
		if not (Read.as_int(p.get("usage", 0)) & PROPERTY_USAGE_STORAGE):
			continue
		var value: Variant = loaded.get(property)
		if not include_defaults:
			var default: Variant = (
				script.get_property_default_value(property)
				if scripted.has(property)
				else ClassDB.class_get_property_default_value(loaded.get_class(), property)
			)
			if PropertyValues.same(value, default):
				continue
		properties[property] = serialiser.serialize_value(value)
	var answer: Dictionary = {
		"ok": true, "resourcePath": res_path, "resourceType": loaded.get_class(), "properties": properties
	}
	if script != null:
		answer["script"] = script.resource_path
	return answer
