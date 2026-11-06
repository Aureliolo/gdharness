@tool
extends Node
## Scenes and their nodes, edited in the open editor and read back from what it holds.

const GdhDeclared = preload("../declared_values.gd")
const GdhFileReads = preload("../file_reads.gd")
const GdhRead = preload("../reading.gd")
const GdhGroups = preload("scene_groups.gd")
const GdhHeadlessCheck = preload("../headless_check.gd")
const GdhKin = preload("scene_kin.gd")
const GdhNavigationBake = preload("navigation_bake.gd")
const GdhPaths = preload("scene_paths.gd")
const GdhPlacing = preload("scene_placing.gd")
const GdhPropertyValues = preload("../property_values.gd")
const GdhSame = preload("../same_values.gd")
const GdhSceneFile = preload("../scene_file.gd")
const GdhSceneSharing = preload("scene_sharing.gd")
const GdhScriptPaths = preload("script_paths.gd")
const GdhSerialisation = preload("../serialisation.gd")
const GdhTilesetTools = preload("tileset_tools.gd")

var _editor_plugin: EditorPlugin = null
var _values: GdhSerialisation = GdhSerialisation.new()
var _properties: GdhPropertyValues = GdhPropertyValues.new()


func set_editor_plugin(plugin: EditorPlugin) -> void:
	_editor_plugin = plugin


## [param scene_path] opened for a tool, as [scene, refusal]: the refusal is {} when it opened.
func _open(scene_path: String, for_writing: bool) -> Array:
	var scene: GdhSceneFile = GdhSceneFile.new()
	return [scene, scene.open(scene_path, for_writing)]


## Whether each of [param names] reads the same off [param saved] as off [param node], answering
## the first that does not, or "".
func _kept(scene: GdhSceneFile, saved: Node, node: Node, names: Array) -> String:
	var at: String = scene.path_of(node)
	var copy: Node = saved.get_node_or_null(at)
	if copy == null:
		return "%s is not in the scene as it would be saved." % at
	for key: Variant in names:
		var property: String = str(key)
		var loaded: Variant = _properties.read_at(copy, property)
		var given: Variant = _properties.read_at(node, property)
		if not scene.kept(saved, loaded, given):
			# The file holds it, and the copy's own script set it again as the copy loaded, as it
			# will wherever the scene loads. An editor saves the same.
			if scene.stores(at, property, given):
				var on: Dictionary = scene.loads_as.get_or_add(at, {})
				if GdhHeadlessCheck.untooled(copy.get_script()):
					scene.loads_untooled[at] = true
				on[property] = _values.serialize_value(loaded)
				continue
			return (
				(
					"%s.%s would load from the file as %s: the scene does not keep it, because the "
					+ "property is not one a scene stores or the node belongs to another scene."
				)
				% [at, property, JSON.stringify(_values.serialize_value(loaded), "", false)]
			)
	return ""


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
		if not (GdhRead.as_int(p.get("usage", 0)) & PROPERTY_USAGE_STORAGE):
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
			if GdhSame.same(value, default):
				continue
		props[property] = _readable(node, value)
	return props


func _readable(node: Node, value: Variant) -> Variant:
	if value is Node:
		var target: Node = value
		return _values.serialize_value(node.get_path_to(target))
	if value is Array:
		var items: Array = value
		var typed: bool = items.is_typed()
		return items.map(
			func(item: Variant) -> Variant:
				return (
					_readable(node, item)
					if item is Node or item is Array
					else _values.serialize_member(item, typed)
				)
		)
	return _values.serialize_value(value)


func _parse_properties_arg(raw_properties: Variant) -> Dictionary:
	if typeof(raw_properties) == TYPE_DICTIONARY:
		return raw_properties
	if typeof(raw_properties) == TYPE_STRING:
		var text: String = str(raw_properties)
		if text.strip_edges().is_empty():
			return {}
		var parsed: Variant = GdhRead.json_or_null(text)
		if typeof(parsed) == TYPE_DICTIONARY:
			return parsed
	return {}


func _inherited(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var script_path: String = str(args.get("script", ""))
	return GdhKin.inherited(
		args,
		_new_scene_path(args),
		GdhSceneFile.res_path(project_path, str(args.get("inherits", ""))),
		"" if script_path.is_empty() else GdhSceneFile.res_path(project_path, script_path)
	)


## The res:// path [param args] give under [param argument] for a new scene, given .tscn when it
## has no extension, or "".
func _new_scene_path(args: Dictionary, argument: String = "scenePath") -> String:
	var scene_path: String = GdhSceneFile.res_path(
		str(args.get("projectPath", "")), str(args.get(argument, ""))
	)
	if scene_path == "res://":
		return ""
	return scene_path if scene_path.ends_with(".tscn") else scene_path + ".tscn"


func create_scene(args: Dictionary) -> Dictionary:
	if str(args.get("inherits", "")).is_empty():
		return _create_of_a_class(args)
	return _inherited(args)


func _create_of_a_class(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = _new_scene_path(args)
	var root_node_type: String = str(args.get("rootNodeType", "Node"))
	var root_node_name: String = str(args.get("rootNodeName", root_node_type))
	var script_path: String = str(args.get("script", ""))

	if scene_path.is_empty():
		return { "ok": false, "error": "Missing scenePath" }
	var made: Dictionary = GdhSceneFile.made_as(
		root_node_type,
		"" if script_path.is_empty() else GdhSceneFile.res_path(project_path, script_path),
		"Node",
		"rootNodeType"
	)
	if made.has("error"):
		return { "ok": false, "error": made["error"] }
	root_node_type = str(made["type"])
	script_path = str(made["script"])
	# A class that is not a node went into a Node variable, which is a runtime error the caller
	# heard about only as "Invalid tool result".
	if (
		not ClassDB.class_exists(root_node_type)
		or not ClassDB.is_parent_class(root_node_type, "Node")
	):
		return { "ok": false, "error": GdhPlacing.not_a_node_class("rootNodeType", root_node_type) }
	if not ClassDB.can_instantiate(root_node_type):
		return { "ok": false, "error": "%s cannot be instantiated." % root_node_type }
	var unfit: String = GdhSceneFile.unfit_name(root_node_name)
	if not unfit.is_empty():
		return { "ok": false, "error": unfit }
	if FileAccess.file_exists(scene_path):
		return GdhKin.taken(scene_path)

	var root: Node = ClassDB.instantiate(root_node_type)
	root.name = root_node_name
	var scene: GdhSceneFile = GdhSceneFile.new()
	scene.root = root
	scene.path = scene_path
	scene.asked(root, ["script"])

	if not script_path.is_empty():
		var full_script_path: String = GdhSceneFile.res_path(project_path, script_path)
		var found: Variant = GdhSceneFile.script_at(full_script_path)
		if found is String:
			root.free()
			return { "ok": false, "error": found }
		var script: Script = found
		var uncompiled: String = GdhSceneFile.uncompiled(script, full_script_path)
		if not uncompiled.is_empty():
			root.free()
			return { "ok": false, "error": uncompiled }
		var base: String = str(script.get_instance_base_type())
		if not ClassDB.is_parent_class(root_node_type, base):
			root.free()
			return {
				"ok": false,
				"error":
				(
					"%s extends %s, so it cannot be on a %s root."
					% [full_script_path, base, root_node_type]
				),
			}
		root.set_script(script)
		# Named again, since a headless engine runs the script's _init as it is attached, and a
		# node's name is no property the write compares.
		root.name = root_node_name

	var had_folder: bool = DirAccess.dir_exists_absolute(scene_path.get_base_dir())
	var folder: String = GdhSceneFile.make_folder_for(scene_path)
	if not folder.is_empty():
		root.free()
		return { "ok": false, "error": folder }
	# Read before the write, which frees the root.
	var root_class: Dictionary = GdhSceneFile.class_of(root)
	var written: Dictionary = scene.write()
	if not written.is_empty():
		return written

	var answer: Dictionary = {
		"ok": true,
		"scenePath": scene_path,
		"rootNodeType": root_class["nodeType"],
		"rootNodeName": root_node_name,
	}
	if root_class.has("scriptClass"):
		answer["scriptClass"] = root_class["scriptClass"]
	if not script_path.is_empty():
		answer["script"] = script_path
	if not had_folder:
		answer["madeFolder"] = scene_path.get_base_dir()
	return answer


func list_scene_nodes(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = GdhSceneFile.res_path(project_path, str(args.get("scenePath", "")))
	var depth: int = GdhRead.as_int(args.get("depth", -1), -1)
	var include_properties: bool = GdhRead.as_bool(args.get("includeProperties", false))
	var include_defaults: bool = GdhRead.as_bool(args.get("includeDefaults", false))

	# Read as a headless engine reads it with no editor connected, so the answer does not depend on
	# whether one is.
	var read: Dictionary = GdhFileReads.scene_tree(
		scene_path, depth, include_properties, include_defaults
	)
	if read.get("ok", false):
		read["unsavedInEditor"] = GdhSceneFile.unsaved(scene_path)
	return read


func add_node(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = GdhSceneFile.res_path(project_path, str(args.get("scenePath", "")))
	var node_type: String = str(args.get("nodeType", ""))
	var instance_path: String = str(args.get("instancePath", ""))
	var node_name: String = str(args.get("nodeName", ""))
	var parent_node_path: String = str(args.get("parentNodePath", "."))
	var properties: Dictionary = _parse_properties_arg(args.get("properties", {}))
	var adding: Array = GdhGroups.asked(args, "addGroups")
	var placeholder: bool = GdhRead.as_bool(args.get("placeholder", false))

	if node_name.is_empty():
		return { "ok": false, "error": "Missing nodeName" }
	if placeholder and instance_path.is_empty():
		return {
			"ok": false,
			"error": "placeholder marks an instance of a scene, so add takes it with instancePath.",
		}
	var class_script: Script = null
	if not node_type.is_empty() and not ClassDB.class_exists(node_type):
		var declared: Dictionary = GdhSceneFile.script_class(node_type, "Node")
		if declared.has("error"):
			return { "ok": false, "error": declared["error"] }
		var held: Variant = declared.get("script")
		if held is Script:
			class_script = held
			node_type = str(declared["base"])
	var making: Array = GdhPlacing.what_to_add(node_type, instance_path, scene_path)
	var packed: PackedScene = making[0]
	if not str(making[1]).is_empty():
		return { "ok": false, "error": making[1] }

	var opened: Array = _open(scene_path, true)
	var scene: GdhSceneFile = opened[0]
	var refused: Dictionary = opened[1]
	if not refused.is_empty():
		return refused

	var root: Node = scene.root
	var parent: Node = GdhSceneFile.node_at(root, parent_node_path)
	if not parent:
		return scene.refuse(
			scene.not_found("Parent node not found: " + parent_node_path, parent_node_path)
		)
	var foreign: String = scene.foreign(parent)
	if not foreign.is_empty():
		return scene.refuse(foreign)
	var unusable: String = scene.unusable_name(parent, node_name)
	if not unusable.is_empty():
		return scene.refuse(unusable)
	var place: Variant = args.get("index")
	var unplaceable: String = GdhPlacing.unplaceable(parent, null, place)
	if not unplaceable.is_empty():
		return scene.refuse(unplaceable)

	# In the tree before its properties, so a property holding a node can find it by path. The
	# script goes on once the node is in place, as an add and then a set of the script would put
	# it. What the parent gives the node, such as a Container's layout mode, is then what the node
	# held before its script, and only what the script's _init changed is put back.
	var new_node: Node = GdhPlacing.made(packed, node_type)
	new_node.name = node_name
	parent.add_child(new_node)
	GdhPlacing.place(new_node, place)
	GdhPlacing.own(new_node, root)
	if placeholder:
		new_node.set_scene_instance_load_placeholder(true)
	if class_script != null:
		scene.asked(new_node, ["script"])
		new_node.set_script(class_script)
		# The script's _init can name the node, and the call's name is the one kept.
		new_node.name = node_name
	var unsettled: String = scene.settle()
	if not unsettled.is_empty():
		return scene.refuse("Nothing was written: " + unsettled)
	if GdhPlacing.cornered(new_node, packed):
		scene.asked(new_node, ["layout_mode"])
		new_node.set("layout_mode", GdhPlacing.ANCHORS_MODE)
	scene.asked(new_node, properties.keys())
	var unwritten: String = _properties.write_all(new_node, properties)
	scene.asked(new_node, _properties.moved_by_engine.keys())
	if not unwritten.is_empty():
		unwritten = GdhHeadlessCheck.setter_ran(new_node, _properties.unheld, unwritten)
	if unwritten.is_empty():
		unwritten = GdhGroups.change(scene, new_node, adding, [])
	if not unwritten.is_empty():
		return scene.refuse(unwritten)

	var new_path: String = scene.path_of(new_node)
	# Read before the write, which frees the scene it was added to.
	var answer: Dictionary = { "ok": true, "nodeName": node_name }
	answer.merge(GdhSceneFile.class_of(new_node))
	answer.merge({ "nodePath": new_path, "index": new_node.get_index() })
	if not properties.is_empty():
		var held: Dictionary = {}
		for key: Variant in properties:
			held[str(key)] = _readable(new_node, _properties.read_at(new_node, str(key)))
		answer["properties"] = held
	_properties.note_write(answer, new_node)
	if not adding.is_empty():
		answer.merge(GdhGroups.read_added(new_node, adding))
	var id: int = new_node.get_instance_id()
	var written: Dictionary = scene.write(
		func(saved: Node) -> String:
			var unkept: String = _kept(
				scene,
				saved,
				new_node,
				properties.keys() + (["script"] if class_script != null else [])
			)
			if unkept.is_empty() and saved.get_node_or_null(new_path) != null:
				unkept = GdhGroups.unkept(saved.get_node(new_path), adding, [])
			if unkept.is_empty() and placeholder:
				unkept = _placeholder_unkept(saved, new_path, true)
			return unkept
	)
	if not written.is_empty():
		return written

	_note_put_back(answer, scene, id, new_path)
	_note_loads_as(answer, scene, new_path)
	if packed != null:
		answer["instanceOf"] = instance_path
		answer["placeholder"] = placeholder
	return answer


## Why the node at [param at] in [param saved], the scene as written, would not load with
## placeholder [param wanted], or "" when it would.
static func _placeholder_unkept(saved: Node, at: String, wanted: bool) -> String:
	var node: Node = saved.get_node_or_null(at)
	if node == null or _placeholder_of(node) == wanted:
		return ""
	return "%s would load with placeholder %s." % [at, not wanted]


## Whether [param node] is an instance saved as a placeholder. An engine with no editor opens one as
## an InstancePlaceholder even in an edit state, and an editor opens the instance itself, marked.
static func _placeholder_of(node: Node) -> bool:
	return node is InstancePlaceholder or node.get_scene_instance_load_placeholder()


func delete_node(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = GdhSceneFile.res_path(project_path, str(args.get("scenePath", "")))
	var node_path: String = str(args.get("nodePath", ""))

	if node_path.is_empty() or node_path == ".":
		return {
			"ok": false,
			"error":
			(
				"The root cannot be deleted, since a scene has exactly one. Delete the nodes under "
				+ "it, or make a scene with another root with scene_create."
			),
		}

	var opened: Array = _open(scene_path, true)
	var scene: GdhSceneFile = opened[0]
	var refused: Dictionary = opened[1]
	if not refused.is_empty():
		return refused

	var node: Node = GdhSceneFile.node_at(scene.root, node_path)
	if not node:
		return scene.refuse(scene.not_found("Node not found: " + node_path, node_path))
	var fixed: String = scene.fixed(node, true)
	if not fixed.is_empty():
		return scene.refuse(fixed)

	var at: String = scene.path_of(node)
	var went: Array[String] = []
	for under: Node in node.find_children("*", "", true, false):
		if under.owner == scene.root:
			went.append(scene.path_of(under))
	var cut: Array[Dictionary] = _connections_with(scene, at)
	node.get_parent().remove_child(node)
	node.free()
	var carried: GdhPaths = GdhPaths.new()
	var _rewritten: int = carried.carry(scene, { at: "" })

	var written: Dictionary = scene.write(
		func(saved: Node) -> String:
			if saved.get_node_or_null(at) != null:
				return "%s would still be in the scene when it loads." % at
			return ""
	)
	if not written.is_empty():
		return written

	var answer: Dictionary = { "ok": true, "deletedNodePath": at }
	if not went.is_empty():
		answer["deletedWithIt"] = went
	if not cut.is_empty():
		answer["connectionsRemoved"] = cut
	answer.merge(GdhKin.follow(scene_path, at, "", carried))
	return answer


## The connections [param scene]'s file holds from or to [param at] or a node under it, which go
## with the node. One an instanced scene makes inside itself is that scene's, and stays there.
static func _connections_with(scene: GdhSceneFile, at: String) -> Array[Dictionary]:
	var cut: Array[Dictionary] = []
	for held: Dictionary in scene.held_connections():
		var ends: Array[String] = [str(held["sourceNodePath"]), str(held["targetNodePath"])]
		for end: String in ends:
			if end == at or end.begins_with(at + "/"):
				cut.append(held)
				break
	return cut


func duplicate_node(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = GdhSceneFile.res_path(project_path, str(args.get("scenePath", "")))
	var node_path: String = str(args.get("nodePath", ""))
	var new_name: String = str(args.get("newName", ""))
	var parent_path: String = str(args.get("parentNodePath", ""))

	if node_path.is_empty() or new_name.is_empty():
		return { "ok": false, "error": "Missing nodePath or newName" }

	var opened: Array = _open(scene_path, true)
	var scene: GdhSceneFile = opened[0]
	var refused: Dictionary = opened[1]
	if not refused.is_empty():
		return refused

	var root: Node = scene.root
	var source: Node = GdhSceneFile.node_at(root, node_path)
	if not source:
		return scene.refuse(scene.not_found("Node not found: " + node_path, node_path))
	if source == root:
		return scene.refuse("The root of %s cannot be copied into its own scene." % scene_path)
	var foreign: String = scene.foreign(source)
	if not foreign.is_empty():
		return scene.refuse(foreign)

	var target_parent: Node = source.get_parent()
	if not parent_path.is_empty():
		target_parent = GdhSceneFile.node_at(root, parent_path)
	if not target_parent:
		return scene.refuse(scene.not_found("Parent not found: " + parent_path, parent_path))
	foreign = scene.foreign(target_parent)
	if not foreign.is_empty():
		return scene.refuse(foreign)
	var unusable: String = scene.unusable_name(target_parent, new_name)
	if not unusable.is_empty():
		return scene.refuse(unusable)
	var place: Variant = args.get("index")
	var unplaceable: String = GdhPlacing.unplaceable(target_parent, null, place)
	if not unplaceable.is_empty():
		return scene.refuse(unplaceable)
	# The editor's Duplicate puts the copy right after the original.
	if place == null and target_parent == source.get_parent():
		place = source.get_index() + 1

	var copies: Dictionary = {}
	var duplicated_node: Node = GdhPlacing.copied(source, root, copies)
	if not duplicated_node:
		return scene.refuse("Failed to duplicate node: " + node_path)

	duplicated_node.name = new_name
	target_parent.add_child(duplicated_node)
	GdhPlacing.place(duplicated_node, place)
	var made: Dictionary = {}
	for copy: Variant in copies.values():
		made[copy] = true
	GdhPlacing.own(duplicated_node, root, made)
	GdhPlacing.reconnect(copies, source)
	scene.copied(copies)

	var new_path: String = scene.path_of(duplicated_node)
	var placed: Array = [scene.path_of(target_parent), duplicated_node.get_index()]
	var written: Dictionary = scene.write(
		func(saved: Node) -> String:
			var copy: Node = saved.get_node_or_null(new_path)
			if copy == null:
				return "the copy would not be in the scene when it loads."
			if copy.get_index() != placed[1]:
				return (
					"%s would load at index %d, not %d." % [new_path, copy.get_index(), placed[1]]
				)
			return ""
	)
	if not written.is_empty():
		return written

	return {
		"ok": true,
		"nodePath": node_path,
		"newName": new_name,
		"newNodePath": new_path,
		"parentNodePath": placed[0],
		"index": placed[1],
	}


func reparent_node(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = GdhSceneFile.res_path(project_path, str(args.get("scenePath", "")))
	var node_path: String = str(args.get("nodePath", ""))
	var new_parent_path: String = str(args.get("newParentPath", ""))

	if node_path.is_empty() or node_path == ".":
		return { "ok": false, "error": "Cannot reparent root node" }
	if new_parent_path.is_empty():
		return { "ok": false, "error": "Missing newParentPath" }

	var opened: Array = _open(scene_path, true)
	var scene: GdhSceneFile = opened[0]
	var refused: Dictionary = opened[1]
	if not refused.is_empty():
		return refused

	var root: Node = scene.root
	var node: Node = GdhSceneFile.node_at(root, node_path)
	var new_parent: Node = GdhSceneFile.node_at(root, new_parent_path)
	if not node:
		return scene.refuse(scene.not_found("Node not found: " + node_path, node_path))
	if not new_parent:
		return scene.refuse(
			scene.not_found("New parent not found: " + new_parent_path, new_parent_path)
		)
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
	var place: Variant = args.get("index")
	var unplaceable: String = GdhPlacing.unplaceable(new_parent, node, place)
	if not unplaceable.is_empty():
		return scene.refuse(unplaceable)

	var old_path: String = scene.path_of(node)
	var old_parent: Node = node.get_parent()
	var drawn_at: Dictionary = {}
	for property: String in GdhPlacing.placing(node):
		drawn_at[property] = _properties.read_at(node, property)
	var held_at: Transform3D = (
		(node as Node3D).transform if node is Node3D else Transform3D.IDENTITY
	)
	var stored_before: Dictionary = GdhHeadlessCheck.stored(node)
	# Unowned while it moves: a node taken out of the tree keeps its owner, and adding it under the
	# new parent warned that the owner was not above it. Node.reparent warns the same way.
	node.owner = null
	old_parent.remove_child(node)
	new_parent.add_child(node)
	GdhPlacing.place(node, place)
	GdhPlacing.own(node, root)
	if GdhRead.as_bool(args.get("keepGlobalTransform", true)):
		GdhPlacing.keep_in_place(node, old_parent)
	# Unasked, a headless write takes the move on a node whose script is not a tool for the script's
	# doing and puts the node back as the file held it. A new parent changes more than where the
	# node is drawn: a container gives a Control its own layout mode.
	var placed: Array[String] = GdhHeadlessCheck.differing(node, stored_before, {})
	if not placed.is_empty():
		scene.asked(node, placed)
	var also_changed: Dictionary = {}
	for property: String in drawn_at:
		var now: Variant = _properties.read_at(node, property)
		if not GdhSame.same(now, drawn_at[property]):
			also_changed[property] = {
				"was": _readable(node, drawn_at[property]), "now": _readable(node, now),
			}
	var drawn_in: Array[String] = GdhPlacing.placed_in(node)
	for property: String in placed:
		if property in drawn_in or also_changed.has(property):
			continue
		var was: Variant = (
			stored_before[property]
			if stored_before.has(property)
			else GdhHeadlessCheck.default_of(node, property)
		)
		also_changed[property] = {
			"was": _readable(node, was), "now": _readable(node, node.get(property)),
		}
	var sheared: String = ""
	if node is Node3D and GdhPlacing.sheared((node as Node3D).basis):
		var spatial: Node3D = node
		also_changed["transform"] = {
			"was": _readable(node, held_at), "now": _readable(node, spatial.transform),
		}
		sheared = (
			(
				"%s keeps where it is drawn under %s, which is scaled unevenly across the way it "
				+ "is turned, so its basis is sheared: no position, rotation and scale describe "
				+ "it, and transform is what it holds. keepGlobalTransform false keeps its own "
				+ "transform instead."
			)
			% [str(node.name), new_parent_path]
		)

	var new_path: String = scene.path_of(node)
	var index: int = node.get_index()
	var carried: GdhPaths = GdhPaths.new()
	var _rewritten: int = carried.carry(
		scene,
		{ old_path: new_path } if new_path != old_path else {},
	)
	var written: Dictionary = scene.write(
		func(saved: Node) -> String:
			var copy: Node = saved.get_node_or_null(new_path)
			if copy == null:
				return "%s would not be in the scene when it loads." % new_path
			if old_path != new_path and saved.get_node_or_null(old_path) != null:
				return "%s would still be in the scene as well when it loads." % old_path
			if copy.get_index() != index:
				return "%s would load at index %d, not %d." % [new_path, copy.get_index(), index]
			return _kept(scene, saved, node, also_changed.keys())
	)
	if not written.is_empty():
		carried.put_back(scene_path)
		return written

	var answer: Dictionary = {
		"ok": true,
		"nodePath": old_path,
		"newParentPath": new_parent_path,
		"newNodePath": new_path,
		"index": index,
	}
	if not also_changed.is_empty():
		answer["alsoChanged"] = also_changed
	if not sheared.is_empty():
		answer["sheared"] = sheared
	if new_path != old_path:
		answer.merge(GdhKin.follow(scene_path, old_path, new_path, carried))
	return answer


## Saves the branch at nodePath as a scene of its own at newScenePath and puts an instance of that
## scene where the branch was, as the editor's Save Branch as Scene does. The new file holds the
## branch's nodes, values, resources, groups and the connections among them, with its root's
## position reset as the editor resets it. The instance keeps the branch's name, place, position,
## rotation and scale. The rest of the scene keeps what it named in the branch: the connections to
## its nodes, the properties holding them and the %unique paths, which no longer reach a node
## unique only in the new scene.
func save_branch(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = GdhSceneFile.res_path(project_path, str(args.get("scenePath", "")))
	var node_path: String = str(args.get("nodePath", ""))
	var branch_path: String = _new_scene_path(args, "newScenePath")
	if node_path.is_empty() or node_path == ".":
		return {
			"ok": false,
			"error":
			"The root is the whole scene, which scene_create save_as copies to a new file.",
		}
	if branch_path.is_empty():
		return { "ok": false, "error": "Missing newScenePath" }
	if branch_path == scene_path:
		return {
			"ok": false, "error": "newScenePath is %s, the scene the branch is in." % scene_path,
		}
	if FileAccess.file_exists(branch_path):
		return {
			"ok": false,
			"error": "%s already exists, and save_branch writes a new scene only." % branch_path,
		}

	var opened: Array = _open(scene_path, true)
	var scene: GdhSceneFile = opened[0]
	var refused: Dictionary = opened[1]
	if not refused.is_empty():
		return refused
	var root: Node = scene.root
	var top: Node = GdhSceneFile.node_at(root, node_path)
	if top == null:
		return scene.refuse(scene.not_found("Node not found: " + node_path, node_path))
	var fixed: String = scene.fixed(top)
	if not fixed.is_empty():
		return scene.refuse(fixed)
	if not top.scene_file_path.is_empty():
		return scene.refuse(
			"%s is an instance of %s, its scene already." % [node_path, top.scene_file_path]
		)

	var at: String = scene.path_of(top)
	var top_name: StringName = top.name
	var parent: Node = top.get_parent()
	var index: int = top.get_index()
	var unique: bool = top.unique_name_in_owner
	var placed_at: Dictionary = {}
	if top is Node2D or top is Node3D:
		for property: String in ["position", "rotation", "scale"]:
			placed_at[property] = top.get(property)
	var outside: Array[Node] = [root]
	var inside: Array[Node] = [top]
	for node: Node in root.find_children("*", "", true, false):
		if node.owner == root and node != top:
			if top.is_ancestor_of(node):
				inside.append(node)
			else:
				outside.append(node)

	var answer: Dictionary = { "ok": true, "nodePath": at, "newScenePath": branch_path }
	var enclosed: Dictionary = {}
	for node: Node in inside:
		if node != top and node.unique_name_in_owner:
			enclosed[str(node.name)] = scene.path_of(node)
	var held: Array[Array] = _holding_the_branch(outside, top)
	var crossing: Array[Array] = _crossing(outside, inside, top)
	_named_outside(scene, inside, top, answer)
	var scripts_out: Array[Dictionary] = _scripts_naming_outside(inside, top, branch_path)

	var split: Array = scene.split_off(top, branch_path)
	var branch: GdhSceneFile = split[0]
	var crossing_unmade: Array[Dictionary] = split[1]
	var editable: Array[Node] = []
	for node: Node in inside:
		if node != top and not node.scene_file_path.is_empty() and root.is_editable_instance(node):
			editable.append(node)
	var below: Array[String] = []
	for node: Node in inside:
		below.append(str(top.get_path_to(node)))
	branch.asked(top, ["unique_name_in_owner"] + placed_at.keys())
	parent.remove_child(top)
	top.unique_name_in_owner = false
	top.owner = null
	for node: Node in inside:
		if node != top:
			node.owner = top
	for node: Node in editable:
		top.set_editable_instance(node, true)
	if top is Node2D:
		(top as Node2D).position = Vector2.ZERO
	elif top is Node3D:
		(top as Node3D).position = Vector3.ZERO
	var written: Dictionary = branch.write(
		func(saved: Node) -> String:
			for one: String in below:
				if saved.get_node_or_null(one) == null:
					return "%s would not be in %s when it loads." % [one, branch_path]
			return ""
	)
	if not written.is_empty():
		scene.close()
		return written

	var packed: PackedScene = ResourceLoader.load(branch_path, "PackedScene") as PackedScene
	var instance: Node = (
		packed.instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE) if packed != null else null
	)
	if instance == null:
		return _unwritten(scene, branch_path, "%s did not instance once written." % branch_path)
	instance.name = top_name
	parent.add_child(instance)
	parent.move_child(instance, index)
	instance.owner = root
	# Before the scene is next packed, which reads the path to every node a property holds.
	for one: Array in held:
		var holder: Node = one[0]
		var holding: String = one[1]
		scene.asked(holder, [holding])
		holder.set(holding, _unmarked(one[2], instance))
	var unsettled: String = scene.settle()
	if not unsettled.is_empty():
		return _unwritten(scene, branch_path, unsettled)
	scene.asked(instance, ["unique_name_in_owner"] + placed_at.keys())
	instance.unique_name_in_owner = unique
	for property: String in placed_at:
		instance.set(property, placed_at[property])
	scene.rejoin_unmade(crossing_unmade, instance)
	var lost: Array[Dictionary] = _rejoined(scene, crossing, instance)
	if not lost.is_empty():
		answer["connectionsLost"] = lost
	var carried: GdhPaths = GdhPaths.new()
	var _rewritten: int = carried.carry_enclosed(scene, enclosed)

	written = scene.write(
		func(saved: Node) -> String:
			var copy: Node = saved.get_node_or_null(at)
			if copy == null or copy.scene_file_path != branch_path:
				return "%s would not load as an instance of %s." % [at, branch_path]
			if copy.get_index() != index:
				return "%s would load at index %d, not %d." % [at, copy.get_index(), index]
			return ""
	)
	if not written.is_empty():
		carried.put_back(scene_path)
		return _unwritten(null, branch_path, str(written.get("error", "")))
	answer["index"] = index
	answer.merge(carried.answer())
	answer.merge(GdhKin.enclose(scene_path, at))
	if not scripts_out.is_empty():
		var naming: Array = answer.get_or_add("scriptsNaming", [])
		naming.append_array(scripts_out)
	return answer


## Removes the scene [method save_branch] wrote at [param branch_path] and answers [param why] as
## its refusal. [param scene] is closed when it is still open.
static func _unwritten(scene: GdhSceneFile, branch_path: String, why: String) -> Dictionary:
	if scene != null:
		scene.close()
	var _removed: Error = DirAccess.remove_absolute(branch_path)
	if Engine.is_editor_hint():
		GdhSceneFile.scan_later()
	return { "ok": false, "error": why }


## Each property of the nodes [param outside] the branch at [param top] that holds a node of it, as
## [holder, property, the value with each such node marked by its path from [param top]], for
## [method _unmarked] to give the instance's node at that path.
static func _holding_the_branch(outside: Array[Node], top: Node) -> Array[Array]:
	var held: Array[Array] = []
	for node: Node in outside:
		for property: Dictionary in node.get_property_list():
			if not GdhRead.as_int(property.get("usage", 0)) & PROPERTY_USAGE_STORAGE:
				continue
			var called: String = str(property["name"])
			var marked: Array = _marked(node.get(called), top)
			if marked[0]:
				held.append([node, called, marked[1]])
	return held


## [param value] with each node of the branch at [param top] in it as a [GdhBranchMark], as
## [whether it held one, the value].
static func _marked(value: Variant, top: Node) -> Array:
	if typeof(value) == TYPE_OBJECT and is_instance_valid(value) and value is Node:
		var node: Node = value
		if node == top or top.is_ancestor_of(node):
			return [true, GdhBranchMark.new(top.get_path_to(node))]
	elif value is Array:
		var items: Array = value
		var changed: bool = false
		var copy: Array = items.duplicate()
		for at: int in items.size():
			var one: Array = _marked(items[at], top)
			if one[0]:
				copy[at] = one[1]
				changed = true
		return [changed, copy if changed else value]
	elif value is Dictionary:
		var pairs: Dictionary = value
		var changed: bool = false
		var copy: Dictionary = pairs.duplicate()
		for key: Variant in pairs:
			var one: Array = _marked(pairs[key], top)
			if one[0]:
				copy[key] = one[1]
				changed = true
		return [changed, copy if changed else value]
	return [false, value]


## [param value] with each [GdhBranchMark] in it as the node at its path below [param instance].
static func _unmarked(value: Variant, instance: Node) -> Variant:
	if value is GdhBranchMark:
		var mark: GdhBranchMark = value
		return instance.get_node_or_null(mark.below)
	if value is Array:
		var items: Array = value
		return items.map(func(item: Variant) -> Variant: return _unmarked(item, instance))
	if value is Dictionary:
		var pairs: Dictionary = value
		var copy: Dictionary = pairs.duplicate()
		for key: Variant in pairs:
			copy[key] = _unmarked(pairs[key], instance)
		return copy
	return value


## Each node path and node the nodes [param inside] the branch at [param top] hold that reaches a
## node outside it, answered under namesOutside as {nodePath, property, path, names} with nodePath
## the holder's path in the new scene and names the node's path here. A path is kept, and names
## that node only where the new scene is instanced as here. A node is cleared, with cleared: true,
## since the new scene's file can only save it as a path within itself.
func _named_outside(
	scene: GdhSceneFile, inside: Array[Node], top: Node, answer: Dictionary
) -> void:
	var named: Array[Dictionary] = []
	for node: Node in inside:
		for property: Dictionary in node.get_property_list():
			if not GdhRead.as_int(property.get("usage", 0)) & PROPERTY_USAGE_STORAGE:
				continue
			var called: String = str(property["name"])
			if GdhHeadlessCheck.at_default(node, called):
				continue
			var record: Dictionary = {
				"nodePath": str(top.get_path_to(node)), "property": called,
			}
			var kept: Array = _outside_of(node.get(called), node, top, scene, record, named)
			if kept[0]:
				scene.asked(node, [called])
				node.set(called, kept[1])
	if not named.is_empty():
		answer["namesOutside"] = named


## [param value], held by [param holder] in the branch at [param top], with each node outside the
## branch in it cleared, each such node and each path reaching one recorded from [param record] in
## [param named], as [whether a node was cleared, the value].
static func _outside_of(
	value: Variant,
	holder: Node,
	top: Node,
	scene: GdhSceneFile,
	record: Dictionary,
	named: Array[Dictionary]
) -> Array:
	if value is NodePath:
		var path: NodePath = value
		var target: Node = (
			holder.get_node_or_null(NodePath(path.get_concatenated_names()))
			if path.get_name_count() > 0
			else null
		)
		if target != null and target != top and not top.is_ancestor_of(target):
			var entry: Dictionary = record.duplicate()
			entry["path"] = str(path)
			entry["names"] = scene.path_of(target)
			named.append(entry)
		return [false, value]
	if typeof(value) == TYPE_OBJECT and is_instance_valid(value) and value is Node:
		var node: Node = value
		if node == top or top.is_ancestor_of(node):
			return [false, value]
		var entry: Dictionary = record.duplicate()
		entry["names"] = scene.path_of(node)
		entry["cleared"] = true
		named.append(entry)
		return [true, null]
	if value is Array:
		var items: Array = value
		var changed: bool = false
		var copy: Array = items.duplicate()
		for at: int in items.size():
			var one: Array = _outside_of(items[at], holder, top, scene, record, named)
			if one[0]:
				copy[at] = one[1]
				changed = true
		return [changed, copy if changed else value]
	if value is Dictionary:
		var pairs: Dictionary = value
		var changed: bool = false
		var copy: Dictionary = pairs.duplicate()
		for key: Variant in pairs:
			var one: Array = _outside_of(pairs[key], holder, top, scene, record, named)
			if one[0]:
				copy[key] = one[1]
				changed = true
		return [changed, copy if changed else value]
	return [false, value]


## The persistent connections between a node [param outside] the branch at [param top] and one
## [param inside] it, each taken off its source and answered as [source, signal, callable, flags,
## the source's path from [param top] or "", the target's path from [param top] or ""]. The source
## is given only when it is outside, since a node of the branch is freed with it.
static func _crossing(outside: Array[Node], inside: Array[Node], top: Node) -> Array[Array]:
	var crossing: Array[Array] = []
	for from_inside: bool in [false, true]:
		var sources: Array[Node] = inside if from_inside else outside
		for source: Node in sources:
			for info: Dictionary in source.get_signal_list():
				var signal_name: String = str(info.get("name", ""))
				for conn: Dictionary in source.get_signal_connection_list(signal_name):
					var flags: int = GdhRead.as_int(conn.get("flags", 0))
					var callable: Callable = conn.get("callable", Callable())
					var target: Node = callable.get_object() as Node
					if not flags & Object.CONNECT_PERSIST or target == null:
						continue
					if (target == top or top.is_ancestor_of(target)) == from_inside:
						continue
					crossing.append(
						[
							null if from_inside else source,
							signal_name,
							callable,
							flags,
							str(top.get_path_to(source)) if from_inside else "",
							"" if from_inside else str(top.get_path_to(target)),
						]
					)
					source.disconnect(signal_name, callable)
	return crossing


## Makes each of [param crossing], from [method _crossing], again between the node outside and the
## node at its path below [param instance]. Answers each that the scene's file would not hold, as
## {sourceNodePath, signalName, targetNodePath, methodName}: one from a node inside an instance is
## saved only once the instance's children are editable.
func _rejoined(scene: GdhSceneFile, crossing: Array[Array], instance: Node) -> Array[Dictionary]:
	var made: Array[Array] = []
	for one: Array in crossing:
		var callable: Callable = one[2]
		var source: Node = one[0]
		if not str(one[4]).is_empty():
			source = instance.get_node_or_null(NodePath(str(one[4])))
		# The node of the branch a callable aims at has been freed with the branch.
		var target: Object = (
			instance.get_node_or_null(NodePath(str(one[5])))
			if not str(one[5]).is_empty()
			else callable.get_object()
		)
		if source == null or target == null:
			continue
		var aimed: Callable = GdhPlacing.aimed(callable, target)
		if source.connect(str(one[1]), aimed, GdhRead.as_int(one[3])) == OK:
			made.append([source, str(one[1]), aimed, target])
	var lost: Array[Dictionary] = []
	if made.is_empty():
		return lost
	var probe: PackedScene = PackedScene.new()
	if probe.pack(scene.root) != OK:
		return lost
	var state: SceneState = probe.get_state()
	var saved: Dictionary = {}
	for at: int in state.get_connection_count():
		var key: String = "%s|%s|%s|%s" % [
			str(state.get_connection_source(at)).trim_prefix("./"),
			state.get_connection_signal(at),
			str(state.get_connection_target(at)).trim_prefix("./"),
			state.get_connection_method(at),
		]
		saved[key] = true
	for one: Array in made:
		var source: Node = one[0]
		var aimed: Callable = one[2]
		var target: Node = one[3]
		var held: Dictionary = {
			"sourceNodePath": scene.path_of(source),
			"signalName": one[1],
			"targetNodePath": scene.path_of(target),
			"methodName": str(aimed.get_method()),
		}
		var key: String = "%s|%s|%s|%s" % held.values()
		if not saved.has(key):
			source.disconnect(str(one[1]), aimed)
			lost.append(held)
	return lost


## Each line of a script on a node [param inside] the branch at [param top] that names a node
## outside it through a %unique node, which is not unique in the new scene at [param branch_path],
## as scriptsNaming gives it with no to: {scenePath, nodePath, script, line, from}, nodePath the
## node's path in the new scene.
static func _scripts_naming_outside(
	inside: Array[Node], top: Node, branch_path: String
) -> Array[Dictionary]:
	var found: Array[Dictionary] = []
	var seen: Dictionary = {}
	for node: Node in inside:
		var script: Script = node.get_script()
		while script is GDScript:
			var file: String = script.resource_path
			var source: String = (script as GDScript).source_code
			if source.is_empty() and FileAccess.file_exists(file):
				source = FileAccess.get_file_as_string(file)
			for named: Dictionary in GdhScriptPaths.named(source):
				var path: String = named["path"]
				if not path.begins_with("%"):
					continue
				var through: Node = node.get_node_or_null(NodePath(path.get_slice("/", 0)))
				if through == null or through == top or top.is_ancestor_of(through):
					continue
				var record: Dictionary = {
					"scenePath": branch_path,
					"nodePath": str(top.get_path_to(node)),
					"script": file,
					"line": named["line"],
					"from": path,
				}
				var key: String = "%s:%d:%s:%s" % [file, named["line"], path, record["nodePath"]]
				if not seen.has(key):
					seen[key] = true
					found.append(record)
			script = script.get_base_script()
	return found


func set_node_properties(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = GdhSceneFile.res_path(project_path, str(args.get("scenePath", "")))
	var node_path: String = str(args.get("nodePath", "."))
	var properties: Dictionary = _parse_properties_arg(args.get("properties", {}))
	var editable: Variant = args.get("editableChildren")
	var adding: Array = GdhGroups.asked(args, "addGroups")
	var removing: Array = GdhGroups.asked(args, "removeGroups")
	var placeholder: Variant = args.get("placeholder")
	if (
		properties.is_empty()
		and editable == null
		and placeholder == null
		and adding.is_empty()
		and removing.is_empty()
	):
		return {
			"ok": false,
			"error":
			"set takes properties, editableChildren, placeholder, addGroups or removeGroups.",
		}

	var opened: Array = _open(scene_path, true)
	var scene: GdhSceneFile = opened[0]
	var refused: Dictionary = opened[1]
	if not refused.is_empty():
		return refused

	var node: Node = GdhSceneFile.node_at(scene.root, node_path)
	if not node:
		return scene.refuse(scene.not_found("Node not found: " + node_path, node_path))
	# A rename is refused for the scene that makes the node before anything else, since editable
	# children would let this scene keep values on it and still never rename it.
	if properties.has("name") and node != scene.root:
		var fixed: String = scene.fixed(node)
		if not fixed.is_empty():
			return scene.refuse(fixed)
		var unusable: String = scene.unusable_name(node.get_parent(), str(properties["name"]), node)
		if not unusable.is_empty():
			return scene.refuse(unusable)
	var foreign: String = scene.foreign(node)
	if not foreign.is_empty():
		return scene.refuse(foreign)

	# A placeholder loads without its children, so the editor never keeps both settings on.
	var wants_placeholder: bool = placeholder != null and GdhRead.as_bool(placeholder)
	var wants_editable: bool = editable != null and GdhRead.as_bool(editable)
	if wants_placeholder and wants_editable:
		return scene.refuse(
			(
				"placeholder and editableChildren cannot both be true, "
				+ "since a placeholder loads without its children."
			)
		)
	# The engine asks the root whether it is an editable instance of itself only with an error.
	var children_open: bool = node != scene.root and scene.root.is_editable_instance(node)
	if wants_placeholder and editable == null and children_open:
		return scene.refuse(
			(
				(
					"%s has editable children, which a placeholder cannot keep. Pass "
					+ "editableChildren false with placeholder true to drop their saved values."
				)
				% scene.path_of(node)
			)
		)
	if wants_editable and placeholder == null and node.get_scene_instance_load_placeholder():
		return scene.refuse(
			(
				(
					"%s is a placeholder, which loads without its children. "
					+ "Pass placeholder false with editableChildren true."
				)
				% scene.path_of(node)
			)
		)

	var dropped: Dictionary = {}
	if editable != null:
		var not_an_instance: String = GdhKin.set_editable(scene, node, GdhRead.as_bool(editable))
		if not not_an_instance.is_empty():
			return scene.refuse(not_an_instance)
		if not GdhRead.as_bool(editable):
			dropped = scene.held_under(scene.path_of(node))
	if placeholder != null:
		# The editor offers Load as Placeholder only on an instance this scene places itself.
		if node == scene.root or node.owner != scene.root or node.scene_file_path.is_empty():
			return scene.refuse(
				(
					"placeholder is a setting of an instance this scene places, and %s is not one."
					% scene.path_of(node)
				)
			)
		node.set_scene_instance_load_placeholder(GdhRead.as_bool(placeholder))

	var old_path: String = scene.path_of(node)
	scene.asked(node, properties.keys())
	var refused_property: String = _properties.write_all(node, properties)
	scene.asked(node, _properties.moved_by_engine.keys())
	if not refused_property.is_empty():
		return scene.refuse(
			GdhHeadlessCheck.setter_ran(
				node, _properties.unheld, GdhSceneFile.missing_on(node, refused_property)
			)
		)
	var ungrouped: String = GdhGroups.change(scene, node, adding, removing)
	if not ungrouped.is_empty():
		return scene.refuse(ungrouped)

	var held: Dictionary = {}
	var removed: Array[String] = _properties.metadata_removed.duplicate()
	for key: Variant in properties:
		if not removed.has(str(key)):
			held[str(key)] = _readable(node, _properties.read_at(node, str(key)))
	var new_path: String = scene.path_of(node)
	var answer: Dictionary = { "ok": true, "nodePath": new_path, "properties": held }
	_properties.note_write(answer, node)
	var shared: Dictionary = {}
	for key: Variant in properties:
		var holders: Array[Dictionary] = GdhSceneSharing.holders(scene, node, str(key))
		if not holders.is_empty():
			shared[str(key)] = holders
	if not shared.is_empty():
		answer["sharedWith"] = shared
	if not adding.is_empty() or not removing.is_empty():
		answer["groups"] = GdhGroups.read(scene, node).get("groups", [])
	var named: Array[String] = []
	for key: Variant in properties:
		var property: String = str(key).get_slice(":", 0)
		if property != "name" and property in node and not named.has(property):
			named.append(property)
	var source: String = scene.values_from(node, old_path)
	# Read before the write, which frees the node.
	var unsaved: Array[String] = []
	for declared: Dictionary in node.get_property_list():
		var declared_name: String = str(declared.get("name", ""))
		if (
			named.has(declared_name)
			and not GdhRead.as_int(declared.get("usage", 0)) & PROPERTY_USAGE_STORAGE
		):
			unsaved.append(declared_name)
	var carried: GdhPaths = GdhPaths.new()
	var _rewritten: int = carried.carry(
		scene,
		{ old_path: new_path } if new_path != old_path else {},
	)
	var id: int = node.get_instance_id()
	var written: Dictionary = scene.write(
		func(saved: Node) -> String:
			var unkept: String = _kept(scene, saved, node, properties.keys())
			if unkept.is_empty():
				unkept = GdhGroups.unkept(saved.get_node(new_path), adding, removing)
			if unkept.is_empty() and editable != null:
				if (
					saved.is_editable_instance(saved.get_node(new_path))
					!= GdhRead.as_bool(editable)
				):
					return (
						"%s would load with editableChildren %s."
						% [new_path, not GdhRead.as_bool(editable)]
					)
			if unkept.is_empty() and placeholder != null:
				unkept = _placeholder_unkept(saved, new_path, GdhRead.as_bool(placeholder))
			return unkept
	)
	if not written.is_empty():
		carried.put_back(scene_path)
		return written

	if editable != null:
		answer["editableChildren"] = GdhRead.as_bool(editable)
	if placeholder != null:
		answer["placeholder"] = GdhRead.as_bool(placeholder)
	if not dropped.is_empty():
		answer["droppedValues"] = dropped["values"]
		answer["droppedNodes"] = dropped["nodes"]
	_note_put_back(answer, scene, id, new_path)
	_note_loads_as(answer, scene, new_path)
	_note_left_out(answer, scene.written_pack, new_path, named, unsaved, source)
	if new_path != old_path:
		answer.merge(GdhKin.follow(scene_path, old_path, new_path, carried))
	return answer


## Puts under loadsAs in [param answer] each value given that the file holds and the script of the
## node at [param at] changes as the scene loads, as it loads.
static func _note_loads_as(answer: Dictionary, scene: GdhSceneFile, at: String) -> void:
	var on: Dictionary = scene.loads_as.get(at, {})
	if on.is_empty():
		return
	answer["loadsAs"] = on
	var names: Array = on.keys()
	var pronoun: String = "it" if names.size() == 1 else "them"
	if scene.loads_untooled.has(at):
		answer["loadsAsNote"] = (
			(
				"The file holds %s as given, which the editor shows. %s's script is not a tool, so "
				+ "in the game it runs as the scene loads and changes %s to what loadsAs gives."
			)
			% [", ".join(names), at, pronoun]
		)
	else:
		answer["loadsAsNote"] = (
			(
				"The file holds %s as given. %s's script runs as the scene loads, in the editor "
				+ "and in the game, and changes %s to what loadsAs gives."
			)
			% [", ".join(names), at, pronoun]
		)


## Moves out of alsoChanged in [param answer] what the last write of [param scene] put back on the
## node with instance id [param id], at [param at], to setByScript.
static func _note_put_back(answer: Dictionary, scene: GdhSceneFile, id: int, at: String) -> void:
	var restored: Dictionary = scene.restored_by_write.get(id, {})
	GdhHeadlessCheck.move_script_set(answer, restored.keys(), at)


## Notes under notStored each of [param named] the file saved from [param pack] does not set on the
## node at [param at]: a set gave it the value the node has without it, so the packer leaves it out,
## as the editor does, and it follows [param source], or its default, from then on. [param unsaved]
## are those of them the node never stores by name.
static func _note_left_out(
	answer: Dictionary,
	pack: PackedScene,
	at: String,
	named: Array[String],
	unsaved: Array[String],
	source: String
) -> void:
	var stored: Dictionary = {}
	var state: SceneState = pack.get_state()
	for index: int in state.get_node_count():
		if str(state.get_node_path(index)).trim_prefix("./") == at:
			for property: int in state.get_node_property_count(index):
				stored[str(state.get_node_property_name(index, property))] = true
	# A property the file never holds by name, as a Control's position, which its offsets hold, is
	# stored when what changed with it is.
	var also: Dictionary = answer.get("alsoChanged", {})
	var held_with_it: bool = also.keys().any(func(other: Variant) -> bool: return stored.has(other))
	var left: Array[String] = []
	for asked: String in named:
		if not stored.has(asked) and not (held_with_it and unsaved.has(asked)):
			left.append(asked)
	if left.is_empty():
		return
	answer["notStored"] = left
	var names: String = ", ".join(left)
	var verb: String = "holds" if left.size() == 1 else "hold"
	var pronoun: String = "it" if left.size() == 1 else "them"
	if source.is_empty():
		answer["notStoredNote"] = (
			"%s now %s the default, so the file does not store %s." % [names, verb, pronoun]
		)
	else:
		answer["notStoredNote"] = (
			(
				"%s now %s what %s gives this node, so the file does not store %s, and a change "
				+ "there reaches this node."
			)
			% [names, verb, source, pronoun]
		)


func get_node_properties(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = GdhSceneFile.res_path(project_path, str(args.get("scenePath", "")))
	var node_path: String = str(args.get("nodePath", "."))
	var include_defaults: bool = GdhRead.as_bool(args.get("includeDefaults", false))

	var opened: Array = _open(scene_path, false)
	var scene: GdhSceneFile = opened[0]
	var refused: Dictionary = opened[1]
	if not refused.is_empty():
		return refused

	var node: Node = GdhSceneFile.node_at(scene.root, node_path)
	if not node:
		return scene.refuse(scene.not_found("Node not found: " + node_path, node_path))

	# Against the default the node would have in no scene: its script's for what the script
	# declares, the class's for the rest. Compared with a bare instance of the class, every exported
	# variable read as changed, and a value this scene sets back to the default was hidden, so the
	# names this scene's file sets are always answered.
	var set_here: Dictionary = scene.set_here(node)
	var props: Dictionary = _properties_of(node, include_defaults, set_here)
	var cells: Dictionary = GdhTilesetTools.cells_of(node)
	var at: String = scene.path_of(node)
	var here: Array = set_here.keys()
	here.sort()
	var answer: Dictionary = { "ok": true, "nodePath": at, "properties": props, "setHere": here }
	# A Node3D stores only its transform, a matrix, while a set takes the position, rotation and
	# scale the inspector shows, so a node turned 45 degrees down read back as nine numbers. A
	# sheared one has no such three, and is left to its transform.
	var placed: Node3D = node as Node3D
	var rebuilt: Transform3D = Transform3D()
	if placed != null:
		var turned: Basis = Basis.from_euler(placed.rotation, placed.rotation_order)
		rebuilt = Transform3D(turned * Basis.from_scale(placed.scale), placed.position)
	if placed != null and props.has("transform") and rebuilt.is_equal_approx(placed.transform):
		# Rounded, since a node never scaled came back with a scale of 0.99999994 out of the matrix.
		# The transform beside it is exact.
		var step: Vector3 = Vector3.ONE * 0.00001
		answer["placement"] = {
			"position": _readable(node, placed.position.snapped(step)),
			"rotation_degrees": _readable(node, placed.rotation_degrees.snapped(step)),
			"scale": _readable(node, placed.scale.snapped(step)),
		}
	# A player's getter answers Master for a bus the layout does not have, while the file keeps the
	# name, so a player left on a renamed or removed bus read as one put on Master.
	var bus: String = str(set_here.get("bus", ""))
	var plays: bool = (
		node is AudioStreamPlayer or node is AudioStreamPlayer2D or node is AudioStreamPlayer3D
	)
	if plays and not bus.is_empty() and AudioServer.get_bus_index(bus) == -1:
		props["bus"] = bus
		var buses: PackedStringArray = []
		for index: int in AudioServer.bus_count:
			var _added: bool = buses.append(AudioServer.get_bus_name(index))
		answer["busNote"] = (
			(
				"%s names the bus %s, which the project's bus layout does not have, so it plays on "
				+ "%s. The buses are %s."
			)
			% [
				str(node.name) if at == "." else at,
				bus,
				AudioServer.get_bus_name(0),
				", ".join(buses),
			]
		)
	# A mask reads as a number, and which layers it holds, under the names the project gives them,
	# is what a caller reads it for.
	var layers: Dictionary = {}
	for declared: Dictionary in node.get_property_list():
		var hint: int = GdhRead.as_int(declared.get("hint", PROPERTY_HINT_NONE))
		var named: String = str(declared.get("name", ""))
		var mask: Variant = node.get(named) if props.has(named) else null
		if hint in GdhDeclared.LAYER_NAMES and mask is int:
			layers[named] = GdhDeclared.layers_in(hint, GdhRead.as_int(mask))
	if not layers.is_empty():
		answer["layers"] = layers
	answer.merge(GdhSceneFile.class_of(node))
	answer.merge(GdhGroups.read(scene, node))
	var from: String = scene.values_from(node, at)
	if not from.is_empty():
		answer["valuesFrom"] = from
	if node != scene.root and node.owner != null and not node.scene_file_path.is_empty():
		answer["instanceOf"] = node.scene_file_path
		answer["editableChildren"] = scene.root.is_editable_instance(node)
		answer["placeholder"] = node.get_scene_instance_load_placeholder()
	scene.close()
	# Only an editor holds anything unsaved. A headless engine answering false would say it looked.
	if Engine.is_editor_hint():
		answer["unsavedInEditor"] = GdhSceneFile.unsaved(scene_path)
	answer.merge(cells)
	# An empty answer read as a node with nothing on it, rather than one with nothing changed.
	if props.is_empty() and not include_defaults:
		answer["note"] = (
			"Every property of this node is at its default, so none is listed. "
			+ "includeDefaults: true lists them all."
		)
	return answer


func bake_navigation(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = GdhSceneFile.res_path(project_path, str(args.get("scenePath", "")))
	var node_path: String = str(args.get("nodePath", "."))
	var opened: Array = _open(scene_path, true)
	var scene: GdhSceneFile = opened[0]
	var refused: Dictionary = opened[1]
	if not refused.is_empty():
		return refused
	var node: Node = GdhSceneFile.node_at(scene.root, node_path)
	if not node:
		return scene.refuse(scene.not_found("Node not found: " + node_path, node_path))
	var foreign: String = scene.foreign(node)
	if not foreign.is_empty():
		return scene.refuse(foreign)
	return GdhNavigationBake.bake(scene, node)


func save_scene(args: Dictionary) -> Dictionary:
	var project_path: String = str(args.get("projectPath", ""))
	var scene_path: String = GdhSceneFile.res_path(project_path, str(args.get("scenePath", "")))
	var new_path_raw: String = str(args.get("newPath", ""))
	var target_path: String = scene_path
	if not new_path_raw.is_empty():
		target_path = GdhSceneFile.res_path(project_path, new_path_raw)

	if target_path != scene_path:
		var unsaved: String = GdhSceneFile.unsaved_in_editor(target_path)
		if not unsaved.is_empty():
			return { "ok": false, "error": unsaved }

	var open_root: Node = null
	var open_roots: Array[Node] = []
	if Engine.is_editor_hint():
		open_roots = EditorInterface.get_open_scene_roots()
	for open: Node in open_roots:
		if open.scene_file_path == scene_path:
			open_root = open
	if open_root != null and target_path == scene_path:
		return _save_open_scene(scene_path)

	# Of the editor's scene when it is open, since that is what a save means, and of the file as it
	# loads otherwise. The editor's scene is packed where it is, as the editor's own save packs it.
	# Packing leaves the nodes as they were.
	var written: Dictionary = {}
	if open_root != null:
		var packed: PackedScene = PackedScene.new()
		var packing: Error = packed.pack(open_root)
		if packing != OK:
			return {
				"ok": false, "error": "Failed to pack %s: %s" % [scene_path, error_string(packing)],
			}
		written = GdhSceneFile.save_packed(packed, target_path)
	else:
		var scene: GdhSceneFile = GdhSceneFile.new()
		var refused: Dictionary = scene.open(scene_path, true)
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
		"from": "editor" if open_root != null else "file",
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
		return { "ok": false, "error": "The editor did not switch to %s to save it." % scene_path }
	var saving: Error = EditorInterface.save_scene()
	if not previous.is_empty() and previous != scene_path:
		EditorInterface.open_scene_from_path(previous)
	if saving != OK:
		return {
			"ok": false,
			"error": "The editor failed to save %s: %s" % [scene_path, error_string(saving)],
		}
	return {
		"ok": true,
		"scenePath": scene_path,
		"savedPath": scene_path,
		"from": "editor",
		"unsavedInEditor": GdhSceneFile.unsaved(scene_path),
	}


## A node of a branch being saved as its own scene, held by a property outside it, by its path from
## the branch's top, until the instance replacing the branch gives the node at that path.
class GdhBranchMark:
	var below: NodePath

	func _init(at: NodePath) -> void:
		below = at
