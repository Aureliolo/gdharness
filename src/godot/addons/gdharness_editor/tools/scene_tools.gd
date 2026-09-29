@tool
extends Node

## Scenes and their nodes, edited in the open editor and read back from what it holds.

const Read = preload("../reading.gd")
const PropertyValues = preload("../property_values.gd")
const SceneFile = preload("../scene_file.gd")
const Serialisation = preload("../serialisation.gd")

var _editor_plugin: EditorPlugin = null
var _values: Serialisation = Serialisation.new()
var _properties: PropertyValues = PropertyValues.new()


func set_editor_plugin(plugin: EditorPlugin) -> void:
	_editor_plugin = plugin


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


## [param scene_path] opened for a tool, as [scene, refusal]: the refusal is {} when it opened.
func _open(scene_path: String, for_writing: bool) -> Array:
	var scene: SceneFile = SceneFile.new()
	return [scene, scene.open(scene_path, for_writing)]


func _find_node(root: Node, path: String) -> Node:
	if path == "." or path.is_empty():
		return root
	return root.get_node_or_null(path)


## Why the property or signal [param missing] could not be found on [param node], adding the one
## cause the name alone does not show: a script that does not compile leaves the editor holding a
## placeholder with no properties or signals at all, and the refusal named the property instead.
func _missing_on(node: Node, missing: String) -> String:
	var script: Script = node.get_script()
	if script == null or not script.has_source_code():
		return missing
	var probe: GDScript = GDScript.new()
	probe.source_code = script.source_code
	if probe.reload() == OK:
		return missing
	return (
		"%s. Its script, %s, does not compile, so the editor knows none of what it declares."
		% [missing, script.resource_path]
	)


## Whether each of [param names] reads the same off [param saved] as off [param node], answering
## the first that does not, or "".
func _kept(scene: SceneFile, saved: Node, node: Node, names: Array) -> String:
	var at: String = scene.path_of(node)
	var copy: Node = saved.get_node_or_null(at)
	if copy == null:
		return "%s is not in the scene as it would be saved." % at
	for key: Variant in names:
		var property: String = str(key)
		var loaded: Variant = copy.get(property)
		if not scene.kept(saved, loaded, node.get(property)):
			return (
				(
					"%s.%s would load from the file as %s: the scene does not keep it, because the property "
					+ "is not one a scene stores or the node belongs to another scene."
				)
				% [at, property, JSON.stringify(_values.serialize_value(loaded))]
			)
	return ""


## Owns [param node] and the nodes under it to [param root], except those an instanced scene
## inside it owns: giving those to the root made the pack write the instance's own nodes into this
## scene as overrides.
func _own(node: Node, root: Node) -> void:
	node.owner = root
	for child: Node in node.get_children():
		if child.owner == null or child.owner == root:
			_own(child, root)


## [param node]'s stored properties as a read answers them. A property holding a node is answered
## as the path to it: the copy read here is never in the tree, and an object description named a
## node that was freed when the call ended.
func _properties_of(node: Node, include_defaults: bool, set_here: Dictionary) -> Dictionary:
	var script: Script = node.get_script()
	var scripted: Dictionary = {}
	if script != null:
		for declared: Dictionary in script.get_script_property_list():
			scripted[str(declared.get("name", ""))] = true
	var props: Dictionary = {}
	for p: Dictionary in node.get_property_list():
		if not (Read.as_int(p.get("usage", 0)) & PROPERTY_USAGE_STORAGE):
			continue
		var property: String = str(p.get("name", ""))
		if property.is_empty():
			continue
		var value: Variant = node.get(property)
		if not include_defaults and not set_here.has(property):
			var default: Variant = (
				script.get_property_default_value(property)
				if scripted.has(property)
				else ClassDB.class_get_property_default_value(node.get_class(), property)
			)
			if PropertyValues.same(value, default):
				continue
		props[property] = _readable(node, value)
	return props


func _readable(node: Node, value: Variant) -> Variant:
	if value is Node:
		var target: Node = value
		return _values.serialize_value(node.get_path_to(target))
	if value is Array:
		var items: Array = value
		return items.map(func(item: Variant) -> Variant: return _readable(node, item))
	return _values.serialize_value(value)


func _parse_properties_arg(raw_properties: Variant) -> Dictionary:
	if typeof(raw_properties) == TYPE_DICTIONARY:
		return raw_properties
	if typeof(raw_properties) == TYPE_STRING:
		var text: String = str(raw_properties)
		if text.strip_edges().is_empty():
			return {}
		var parsed: Variant = Read.json_or_null(text)
		if typeof(parsed) == TYPE_DICTIONARY:
			return parsed
	return {}


func _build_node_tree(
	node: Node, include_properties: bool, depth: int, current_depth: int, node_path: String
) -> Dictionary:
	var children: Array[Dictionary] = []
	var data: Dictionary = {
		"name": str(node.name), "type": node.get_class(), "path": node_path, "children": children
	}

	if include_properties:
		data["properties"] = _properties_of(node, true, {})

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
	# A class that is not a node went into a Node variable, which is a runtime error the caller
	# heard about only as "Invalid tool result".
	if not ClassDB.class_exists(root_node_type) or not ClassDB.is_parent_class(root_node_type, "Node"):
		return {
			"ok": false, "error": "rootNodeType must be a node class, and %s is not one." % root_node_type
		}
	if not ClassDB.can_instantiate(root_node_type):
		return {"ok": false, "error": "%s cannot be instantiated." % root_node_type}
	# Saving over a scene that is there replaced it, nodes and all, and answered as a new scene.
	if FileAccess.file_exists(scene_path):
		return {
			"ok": false,
			"error":
			(
				(
					"%s already exists, and scene_create op=create would replace everything in it. Edit it "
					+ "with scene_node, or create the scene under another path."
				)
				% scene_path
			)
		}

	var root: Node = ClassDB.instantiate(root_node_type)
	root.name = root_node_type

	if not script_path.is_empty():
		var full_script_path: String = _to_scene_res_path(project_path, script_path)
		var script: Script = load(full_script_path) as Script
		if script == null:
			root.free()
			return {"ok": false, "error": "No script loads from " + full_script_path}
		var base: String = str(script.get_instance_base_type())
		if not ClassDB.is_parent_class(root_node_type, base):
			root.free()
			return {
				"ok": false,
				"error":
				"%s extends %s, so it cannot be on a %s root." % [full_script_path, base, root_node_type]
			}
		root.set_script(script)

	var scene: SceneFile = SceneFile.new()
	scene.root = root
	scene.path = scene_path
	var written: Dictionary = scene.write()
	if not written.is_empty():
		return written

	return {"ok": true, "scenePath": scene_path, "rootNodeType": root_node_type}


func list_scene_nodes(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = _to_scene_res_path(project_path, str(args.get("scenePath", "")))
	var depth: int = Read.as_int(args.get("depth", -1), -1)
	var include_properties: bool = Read.as_bool(args.get("includeProperties", false))

	var opened: Array = _open(scene_path, false)
	var scene: SceneFile = opened[0]
	var refused: Dictionary = opened[1]
	if not refused.is_empty():
		return refused

	var tree: Dictionary = _build_node_tree(scene.root, include_properties, depth, 0, ".")
	scene.close()
	return {"ok": true, "tree": tree, "unsavedInEditor": SceneFile.unsaved(scene_path)}


func add_node(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = _to_scene_res_path(project_path, str(args.get("scenePath", "")))
	var node_type: String = str(args.get("nodeType", ""))
	var node_name: String = str(args.get("nodeName", ""))
	var parent_node_path: String = str(args.get("parentNodePath", "."))
	var properties: Dictionary = _parse_properties_arg(args.get("properties", {}))

	if node_type.is_empty() or node_name.is_empty():
		return {"ok": false, "error": "Missing nodeType or nodeName"}
	if not ClassDB.class_exists(node_type) or not ClassDB.is_parent_class(node_type, "Node"):
		return {"ok": false, "error": "nodeType must be a node class, and %s is not one." % node_type}
	if not ClassDB.can_instantiate(node_type):
		return {"ok": false, "error": "%s cannot be instantiated." % node_type}

	var opened: Array = _open(scene_path, true)
	var scene: SceneFile = opened[0]
	var refused: Dictionary = opened[1]
	if not refused.is_empty():
		return refused

	var root: Node = scene.root
	var parent: Node = _find_node(root, parent_node_path)
	if not parent:
		return scene.refuse("Parent node not found: " + parent_node_path)
	var foreign: String = scene.foreign(parent)
	if not foreign.is_empty():
		return scene.refuse(foreign)
	var unusable: String = scene.unusable_name(parent, node_name)
	if not unusable.is_empty():
		return scene.refuse(unusable)

	# In the tree before its properties, so a property holding a node can find it by path.
	var new_node: Node = ClassDB.instantiate(node_type)
	new_node.name = node_name
	parent.add_child(new_node)
	_own(new_node, root)
	var refused_property: String = _properties.write_all(new_node, properties)
	if not refused_property.is_empty():
		return scene.refuse(refused_property)

	var new_path: String = scene.path_of(new_node)
	var written: Dictionary = scene.write(
		func(saved: Node) -> String: return _kept(scene, saved, new_node, properties.keys())
	)
	if not written.is_empty():
		return written

	return {"ok": true, "nodeName": node_name, "nodeType": node_type, "nodePath": new_path}


func delete_node(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = _to_scene_res_path(project_path, str(args.get("scenePath", "")))
	var node_path: String = str(args.get("nodePath", ""))

	if node_path.is_empty() or node_path == ".":
		return {"ok": false, "error": "Cannot delete root node"}

	var opened: Array = _open(scene_path, true)
	var scene: SceneFile = opened[0]
	var refused: Dictionary = opened[1]
	if not refused.is_empty():
		return refused

	var node: Node = _find_node(scene.root, node_path)
	if not node:
		return scene.refuse("Node not found: " + node_path)
	var fixed: String = scene.fixed(node)
	if not fixed.is_empty():
		return scene.refuse(fixed)

	var at: String = scene.path_of(node)
	node.get_parent().remove_child(node)
	node.free()

	var written: Dictionary = scene.write(
		func(saved: Node) -> String:
			if saved.get_node_or_null(at) != null:
				return "%s would still be in the scene when it loads." % at
			return ""
	)
	if not written.is_empty():
		return written

	return {"ok": true, "deletedNodePath": at}


func duplicate_node(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = _to_scene_res_path(project_path, str(args.get("scenePath", "")))
	var node_path: String = str(args.get("nodePath", ""))
	var new_name: String = str(args.get("newName", ""))
	var parent_path: String = str(args.get("parentPath", ""))

	if node_path.is_empty() or new_name.is_empty():
		return {"ok": false, "error": "Missing nodePath or newName"}

	var opened: Array = _open(scene_path, true)
	var scene: SceneFile = opened[0]
	var refused: Dictionary = opened[1]
	if not refused.is_empty():
		return refused

	var root: Node = scene.root
	var source: Node = _find_node(root, node_path)
	if not source:
		return scene.refuse("Node not found: " + node_path)
	if source == root:
		return scene.refuse("The root of %s cannot be copied into its own scene." % scene_path)
	var foreign: String = scene.foreign(source)
	if not foreign.is_empty():
		return scene.refuse(foreign)

	var target_parent: Node = source.get_parent()
	if not parent_path.is_empty():
		target_parent = _find_node(root, parent_path)
	if not target_parent:
		return scene.refuse("Parent not found: " + parent_path)
	foreign = scene.foreign(target_parent)
	if not foreign.is_empty():
		return scene.refuse(foreign)
	var unusable: String = scene.unusable_name(target_parent, new_name)
	if not unusable.is_empty():
		return scene.refuse(unusable)

	var duplicated_node: Node = source.duplicate()
	if not duplicated_node:
		return scene.refuse("Failed to duplicate node: " + node_path)

	duplicated_node.name = new_name
	target_parent.add_child(duplicated_node)
	_own(duplicated_node, root)

	var new_path: String = scene.path_of(duplicated_node)
	var written: Dictionary = scene.write(
		func(saved: Node) -> String:
			if saved.get_node_or_null(new_path) == null:
				return "the copy would not be in the scene when it loads."
			return ""
	)
	if not written.is_empty():
		return written

	return {"ok": true, "nodePath": node_path, "newName": new_name, "newNodePath": new_path}


func reparent_node(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = _to_scene_res_path(project_path, str(args.get("scenePath", "")))
	var node_path: String = str(args.get("nodePath", ""))
	var new_parent_path: String = str(args.get("newParentPath", ""))

	if node_path.is_empty() or node_path == ".":
		return {"ok": false, "error": "Cannot reparent root node"}
	if new_parent_path.is_empty():
		return {"ok": false, "error": "Missing newParentPath"}

	var opened: Array = _open(scene_path, true)
	var scene: SceneFile = opened[0]
	var refused: Dictionary = opened[1]
	if not refused.is_empty():
		return refused

	var root: Node = scene.root
	var node: Node = _find_node(root, node_path)
	var new_parent: Node = _find_node(root, new_parent_path)
	if not node:
		return scene.refuse("Node not found: " + node_path)
	if not new_parent:
		return scene.refuse("New parent not found: " + new_parent_path)
	var fixed: String = scene.fixed(node)
	if not fixed.is_empty():
		return scene.refuse(fixed)
	# Removed first and then refused by add_child, the node and everything under it were saved as
	# gone.
	if new_parent == node or node.is_ancestor_of(new_parent):
		return scene.refuse(
			"%s cannot go under %s, which is itself or inside it." % [node_path, new_parent_path]
		)
	var foreign: String = scene.foreign(new_parent)
	if not foreign.is_empty():
		return scene.refuse(foreign)
	var unusable: String = scene.unusable_name(new_parent, str(node.name), node)
	if not unusable.is_empty():
		return scene.refuse(unusable)

	var old_path: String = scene.path_of(node)
	node.get_parent().remove_child(node)
	new_parent.add_child(node)
	_own(node, root)

	var new_path: String = scene.path_of(node)
	var written: Dictionary = scene.write(
		func(saved: Node) -> String:
			if saved.get_node_or_null(new_path) == null:
				return "%s would not be in the scene when it loads." % new_path
			if old_path != new_path and saved.get_node_or_null(old_path) != null:
				return "%s would still be in the scene as well when it loads." % old_path
			return ""
	)
	if not written.is_empty():
		return written

	return {"ok": true, "nodePath": old_path, "newParentPath": new_parent_path, "newNodePath": new_path}


func set_node_properties(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = _to_scene_res_path(project_path, str(args.get("scenePath", "")))
	var node_path: String = str(args.get("nodePath", "."))
	var properties: Dictionary = _parse_properties_arg(args.get("properties", {}))

	var opened: Array = _open(scene_path, true)
	var scene: SceneFile = opened[0]
	var refused: Dictionary = opened[1]
	if not refused.is_empty():
		return refused

	var node: Node = _find_node(scene.root, node_path)
	if not node:
		return scene.refuse("Node not found: " + node_path)
	var foreign: String = scene.foreign(node)
	if not foreign.is_empty():
		return scene.refuse(foreign)
	if properties.has("name") and node != scene.root:
		var fixed: String = scene.fixed(node)
		if not fixed.is_empty():
			return scene.refuse(fixed)
		var unusable: String = scene.unusable_name(node.get_parent(), str(properties["name"]), node)
		if not unusable.is_empty():
			return scene.refuse(unusable)

	var refused_property: String = _properties.write_all(node, properties)
	if not refused_property.is_empty():
		return scene.refuse(_missing_on(node, refused_property))

	var held: Dictionary = {}
	for key: Variant in properties:
		held[str(key)] = _readable(node, node.get(str(key)))
	var new_path: String = scene.path_of(node)
	var written: Dictionary = scene.write(
		func(saved: Node) -> String: return _kept(scene, saved, node, properties.keys())
	)
	if not written.is_empty():
		return written

	return {"ok": true, "nodePath": new_path, "properties": held}


func get_node_properties(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = _to_scene_res_path(project_path, str(args.get("scenePath", "")))
	var node_path: String = str(args.get("nodePath", "."))
	var include_defaults: bool = Read.as_bool(args.get("includeDefaults", false))

	var opened: Array = _open(scene_path, false)
	var scene: SceneFile = opened[0]
	var refused: Dictionary = opened[1]
	if not refused.is_empty():
		return refused

	var node: Node = _find_node(scene.root, node_path)
	if not node:
		return scene.refuse("Node not found: " + node_path)

	# Against the default the node would have in no scene: its script's for what the script
	# declares, the class's for the rest. Compared with a bare instance of the class, every exported
	# variable read as changed; and a value this scene sets back to the default was hidden, so the
	# names this scene's file sets are always answered.
	var props: Dictionary = _properties_of(node, include_defaults, scene.set_here(node))
	scene.close()
	return {
		"ok": true,
		"nodePath": node_path,
		"properties": props,
		"unsavedInEditor": SceneFile.unsaved(scene_path)
	}


func save_scene(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = _to_scene_res_path(project_path, str(args.get("scenePath", "")))
	var new_path_raw: String = str(args.get("newPath", ""))
	var target_path: String = scene_path
	if not new_path_raw.is_empty():
		target_path = _to_scene_res_path(project_path, new_path_raw)

	if target_path != scene_path:
		var unsaved: String = SceneFile.unsaved_in_editor(target_path)
		if not unsaved.is_empty():
			return {"ok": false, "error": unsaved}

	var open_root: Node = null
	for open: Node in EditorInterface.get_open_scene_roots():
		if open.scene_file_path == scene_path:
			open_root = open
	if open_root == null and target_path == scene_path:
		if not FileAccess.file_exists(scene_path):
			return {"ok": false, "error": "Scene not found: " + scene_path}
		return {
			"ok": true,
			"scenePath": scene_path,
			"saved": false,
			"note":
			(
				(
					"%s is not open in the editor, so the file is the scene: every scene tool writes it as "
					+ "it goes, and there was nothing else to save."
				)
				% scene_path
			)
		}
	if open_root != null and target_path == scene_path:
		return _save_open_scene(scene_path)

	# A copy under a new path: of the editor's scene when it is open, since that is what a save
	# means, and of the file otherwise. The editor's scene is packed where it is, as the editor's own
	# save packs it; packing leaves the nodes as they were.
	var written: Dictionary = {}
	if open_root != null:
		var packed: PackedScene = PackedScene.new()
		var packing: Error = packed.pack(open_root)
		if packing != OK:
			return {"ok": false, "error": "Failed to pack %s: %s" % [scene_path, error_string(packing)]}
		written = SceneFile.save_packed(packed, target_path)
	else:
		var scene: SceneFile = SceneFile.new()
		var refused: Dictionary = scene.open(scene_path, false)
		if not refused.is_empty():
			return refused
		scene.path = target_path
		written = scene.write()
	if not written.is_empty():
		return written

	return {
		"ok": true,
		"scenePath": scene_path,
		"savedPath": target_path,
		"saved": true,
		"from": "editor" if open_root != null else "file"
	}


## Saves the editor's own copy of [param scene_path] through the editor, which is what its Save
## does. Loading the file and writing it back, as this did, saved the disk version, and the reload
## after it discarded every unsaved change in the editor.
func _save_open_scene(scene_path: String) -> Dictionary:
	var current: Node = EditorInterface.get_edited_scene_root()
	var previous: String = current.scene_file_path if current != null else ""
	if previous != scene_path:
		EditorInterface.open_scene_from_path(scene_path)
	var now: Node = EditorInterface.get_edited_scene_root()
	if now == null or now.scene_file_path != scene_path:
		return {"ok": false, "error": "The editor did not switch to %s to save it." % scene_path}
	var saving: Error = EditorInterface.save_scene()
	if not previous.is_empty() and previous != scene_path:
		EditorInterface.open_scene_from_path(previous)
	if saving != OK:
		return {"ok": false, "error": "The editor failed to save %s: %s" % [scene_path, error_string(saving)]}
	return {
		"ok": true,
		"scenePath": scene_path,
		"savedPath": scene_path,
		"saved": true,
		"from": "editor",
		"unsavedInEditor": SceneFile.unsaved(scene_path)
	}


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

	var opened: Array = _open(scene_path, true)
	var scene: SceneFile = opened[0]
	var refused: Dictionary = opened[1]
	if not refused.is_empty():
		return refused

	var ends: Array = _connection_ends(scene, source_node_path, signal_name, target_node_path)
	if ends[0] == null:
		return scene.refuse(str(ends[1]))
	var source: Node = ends[0]
	var target: Node = ends[1]

	# Reconnected rather than left alone when the flags differ, so the connection saved is the one
	# asked for. Left alone, the answer gave the flags asked for and the file kept the old ones.
	var callable: Callable = Callable(target, method_name)
	var method_found: bool = target.has_method(method_name)
	if source.is_connected(signal_name, callable):
		source.disconnect(signal_name, callable)
	var connect_result: Error = source.connect(signal_name, callable, flags)
	if connect_result != OK:
		return scene.refuse("Failed to connect signal: " + error_string(connect_result))

	var from: String = scene.path_of(source)
	var to: String = scene.path_of(target)
	var saved_flags: Array = [-1]
	var written: Dictionary = scene.write(
		func(saved: Node) -> String:
			saved_flags[0] = _connection_flags(saved, from, signal_name, to, method_name)
			if saved_flags[0] < 0:
				return "the connection would not be in the scene when it loads."
			return ""
	)
	if not written.is_empty():
		return written

	return {
		"ok": true,
		"sourceNodePath": from,
		"signalName": signal_name,
		"targetNodePath": to,
		"methodName": method_name,
		"flags": saved_flags[0],
		# Connected either way, as the editor's own dialog allows, since the method may be written
		# next; a caller told nothing learnt of a misspelt one only when the signal fired.
		"methodFound": method_found
	}


## The two ends of a connection in [param scene], as [source, target], or [null, why not].
func _connection_ends(
	scene: SceneFile, source_node_path: String, signal_name: String, target_node_path: String
) -> Array:
	var source: Node = _find_node(scene.root, source_node_path)
	var target: Node = _find_node(scene.root, target_node_path)
	if not source:
		return [null, "Source node not found: " + source_node_path]
	if not target:
		return [null, "Target node not found: " + target_node_path]
	# pack drops a connection with either end inside an instanced scene, and the answer said it was
	# made or removed.
	for end: Node in [source, target]:
		var foreign: String = scene.foreign(end)
		if not foreign.is_empty():
			return [null, foreign]
	if not source.has_signal(signal_name):
		return [null, _missing_on(source, "%s has no signal %s" % [source_node_path, signal_name])]
	return [source, target]


## The flags of the persistent connection from [param from]'s [param signal_name] to
## [param method] on [param to] in the tree under [param root], or -1 when there is none.
func _connection_flags(root: Node, from: String, signal_name: String, to: String, method: String) -> int:
	var source: Node = root.get_node_or_null(from)
	var target: Node = root.get_node_or_null(to)
	if source == null or target == null or not source.has_signal(signal_name):
		return -1
	for conn: Dictionary in source.get_signal_connection_list(signal_name):
		var flags: int = Read.as_int(conn.get("flags", 0))
		var callable: Callable = conn.get("callable", Callable())
		if (
			flags & Object.CONNECT_PERSIST
			and callable.get_object() == target
			and str(callable.get_method()) == method
		):
			return flags
	return -1


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

	var opened: Array = _open(scene_path, true)
	var scene: SceneFile = opened[0]
	var refused: Dictionary = opened[1]
	if not refused.is_empty():
		return refused

	var ends: Array = _connection_ends(scene, source_node_path, signal_name, target_node_path)
	if ends[0] == null:
		return scene.refuse(str(ends[1]))
	var source: Node = ends[0]
	var target: Node = ends[1]

	var from: String = scene.path_of(source)
	var to: String = scene.path_of(target)
	# A connection that was never there saved the scene unchanged and answered as removed, so a
	# typo in either name read as success.
	if _connection_flags(scene.root, from, signal_name, to, method_name) < 0:
		return scene.refuse(
			"%s has no connection from %s.%s to %s.%s." % [scene_path, from, signal_name, to, method_name]
		)
	source.disconnect(signal_name, Callable(target, method_name))

	var written: Dictionary = scene.write(
		func(saved: Node) -> String:
			if _connection_flags(saved, from, signal_name, to, method_name) >= 0:
				return "the connection would still be in the scene when it loads."
			return ""
	)
	if not written.is_empty():
		return written

	return {
		"ok": true,
		"sourceNodePath": from,
		"signalName": signal_name,
		"targetNodePath": to,
		"methodName": method_name
	}


func list_connections(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = _to_scene_res_path(project_path, str(args.get("scenePath", "")))
	var filter_path: String = str(args.get("nodePath", ""))

	var opened: Array = _open(scene_path, false)
	var scene: SceneFile = opened[0]
	var refused: Dictionary = opened[1]
	if not refused.is_empty():
		return refused

	var root: Node = scene.root
	var filtered: Node = null
	if not filter_path.is_empty():
		filtered = _find_node(root, filter_path)
		if filtered == null:
			return scene.refuse("Node not found: " + filter_path)
	var nodes: Array = []
	_collect_nodes_recursive(root, ".", nodes)

	# Only persistent connections, which are the ones a scene file holds: a Container connects
	# signals of each child to itself as the child is added, and those were answered as if the file
	# held them. Matched on either end, since the filter is for connections involving the node.
	var connections: Array = []
	for entry: Dictionary in nodes:
		var path: String = str(entry["path"])
		var node: Node = entry["node"]
		for signal_info: Dictionary in node.get_signal_list():
			var signal_name: String = str(signal_info.get("name", ""))
			if signal_name.is_empty():
				continue
			for conn: Dictionary in node.get_signal_connection_list(signal_name):
				var flags: int = Read.as_int(conn.get("flags", 0))
				if not flags & Object.CONNECT_PERSIST:
					continue
				var callable: Callable = conn.get("callable", Callable())
				var target_obj: Object = callable.get_object()
				if filtered != null and node != filtered and target_obj != filtered:
					continue
				var target_path: String = ""
				var editable: bool = scene.foreign(node).is_empty()
				if target_obj is Node:
					target_path = str(root.get_path_to(target_obj as Node))
					editable = editable and scene.foreign(target_obj as Node).is_empty()
				(
					connections
					. append(
						{
							"sourceNodePath": path,
							"signalName": signal_name,
							"targetNodePath": target_path,
							"methodName": str(callable.get_method()),
							"flags": flags,
							# False for a connection an instanced scene makes inside itself, which only that
							# scene can change.
							"editable": editable
						}
					)
				)

	scene.close()
	return {"ok": true, "connections": connections, "unsavedInEditor": SceneFile.unsaved(scene_path)}
