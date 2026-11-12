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
const GdhShownScene = preload("../shown_scene.gd")
const GdhSceneSharing = preload("scene_sharing.gd")
const GdhScriptPaths = preload("script_paths.gd")
const GdhSerialisation = preload("../serialisation.gd")
const GdhTilesetTools = preload("tileset_tools.gd")
const GdhUnset = preload("../unset_values.gd")
## What the editor says it is doing while a save holds a scene in front.
const SAVING: String = "saving a scene"

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
	_values.with_defaults = include_defaults
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
	_values.with_defaults = false
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
	var script_path: String = str(args.get("script", ""))
	return GdhKin.inherited(
		args,
		_new_scene_path(args),
		GdhSceneFile.res_path(str(args.get("inherits", ""))),
		"" if script_path.is_empty() else GdhSceneFile.res_path(script_path)
	)


## The res:// path [param args] give under [param argument] for a new scene, given .tscn when it
## has no extension, or "".
func _new_scene_path(args: Dictionary, argument: String = "scenePath") -> String:
	var scene_path: String = GdhSceneFile.res_path(str(args.get(argument, "")))
	if scene_path == "res://":
		return ""
	return scene_path if scene_path.ends_with(".tscn") else scene_path + ".tscn"


func create_scene(args: Dictionary) -> Dictionary:
	if str(args.get("inherits", "")).is_empty():
		return _create_of_a_class(args)
	return _inherited(args)


func _create_of_a_class(args: Dictionary) -> Dictionary:
	var scene_path: String = _new_scene_path(args)
	var root_node_type: String = str(args.get("rootNodeType", "Node"))
	var root_node_name: String = str(args.get("rootNodeName", root_node_type))
	var script_path: String = str(args.get("script", ""))

	if scene_path.is_empty():
		return { "ok": false, "error": "Missing scenePath" }
	var made: Dictionary = GdhSceneFile.made_as(
		root_node_type,
		"" if script_path.is_empty() else GdhSceneFile.res_path(script_path),
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
		var unusable: String = _script_on_root(root, GdhSceneFile.res_path(script_path))
		if not unusable.is_empty():
			root.free()
			return { "ok": false, "error": unusable }
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


## Puts the script at [param full_script_path] on the new scene's [param root]. Answers why it
## cannot be, or "".
static func _script_on_root(root: Node, full_script_path: String) -> String:
	var found: Variant = GdhSceneFile.script_at(full_script_path)
	if found is String:
		return str(found)
	var script: Script = found
	var uncompiled: String = GdhSceneFile.uncompiled(script, full_script_path)
	if not uncompiled.is_empty():
		return uncompiled
	var base: String = str(script.get_instance_base_type())
	var root_type: String = root.get_class()
	if not ClassDB.is_parent_class(root_type, base):
		return "%s extends %s, so it cannot be on a %s root." % [full_script_path, base, root_type]
	root.set_script(script)
	return ""


func list_scene_nodes(args: Dictionary) -> Dictionary:
	var scene_path: String = GdhSceneFile.res_path(str(args.get("scenePath", "")))
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
	var scene_path: String = GdhSceneFile.res_path(str(args.get("scenePath", "")))
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
	var resolved: Dictionary = _resolved_class(node_type)
	if resolved.has("error"):
		return { "ok": false, "error": resolved["error"] }
	node_type = str(resolved["type"])
	var class_script: Script = resolved["script"]
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
	var place: Variant = args.get("index")
	var barred: String = _barred_parent(scene, parent, parent_node_path, node_name, place)
	if not barred.is_empty():
		return scene.refuse(barred)

	# In the tree before its properties, so a property holding a node can find it by path. The
	# script goes on once the node is in place, as an add and then a set of the script would put
	# it. What the parent gives the node, such as a Container's layout mode, is then what the node
	# held before its script, and only what the script's _init changed is put back.
	var new_node: Node = GdhPlacing.made(packed, node_type)
	new_node.name = node_name
	parent.add_child(new_node)
	GdhPlacing.place(new_node, place)
	GdhPlacing.own(new_node, root)
	_mark_added(scene, new_node, [class_script, placeholder, node_name])
	var unsettled: String = scene.settle()
	if not unsettled.is_empty():
		return scene.refuse("Nothing was written: " + unsettled)
	if GdhPlacing.cornered(new_node, packed):
		scene.asked(new_node, ["layout_mode"])
		new_node.set("layout_mode", GdhPlacing.ANCHORS_MODE)
	var unwritten: String = _write_added(scene, new_node, properties, adding)
	if not unwritten.is_empty():
		return scene.refuse(unwritten)

	var new_path: String = scene.path_of(new_node)
	# Read before the write, which frees the scene it was added to.
	var answer: Dictionary = _added_answer(new_node, node_name, new_path, properties, adding)
	var id: int = new_node.get_instance_id()
	var kept_keys: Array = properties.keys() + (["script"] if class_script != null else [])
	var written: Dictionary = scene.write(
		func(saved: Node) -> String:
			var unkept: String = _kept(scene, saved, new_node, kept_keys)
			if unkept.is_empty():
				unkept = _unkept_added(saved, new_path, adding, placeholder)
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


## [param node_type] as an engine class, or as a class_name script's base class with that script,
## as {type, script}. {error} says why a named class is neither. An empty type stays as it is.
static func _resolved_class(node_type: String) -> Dictionary:
	if node_type.is_empty() or ClassDB.class_exists(node_type):
		return { "type": node_type, "script": null }
	var declared: Dictionary = GdhSceneFile.script_class(node_type, "Node")
	if declared.has("error"):
		return { "error": declared["error"] }
	var held: Variant = declared.get("script")
	if held is Script:
		return { "type": str(declared["base"]), "script": held }
	return { "type": node_type, "script": null }


## Why [param node_name] cannot be added at [param place] under [param parent] in [param scene], or
## "". [param parent] is null when [param parent_path] names no node.
func _barred_parent(
	scene: GdhSceneFile, parent: Node, parent_path: String, node_name: String, place: Variant
) -> String:
	if not parent:
		return scene.not_found("Parent node not found: " + parent_path, parent_path)
	var foreign: String = scene.foreign(parent)
	if not foreign.is_empty():
		return foreign
	var unusable: String = scene.unusable_name(parent, node_name)
	if not unusable.is_empty():
		return unusable
	return GdhPlacing.unplaceable(parent, null, place)


## Gives the added [param new_node] what [param marks] holds, as [class_name script or null,
## placeholder mark, node name]. The script is taken as the call's own.
static func _mark_added(scene: GdhSceneFile, new_node: Node, marks: Array) -> void:
	var class_script: Script = marks[0]
	var placeholder: bool = marks[1]
	if placeholder:
		new_node.set_scene_instance_load_placeholder(true)
	if class_script != null:
		scene.asked(new_node, ["script"])
		new_node.set_script(class_script)
		# The script's _init can name the node, and the call's name is the one kept.
		new_node.name = str(marks[2])


## Sets [param properties] and the groups [param adding] on the added [param new_node], taking each
## as the call's own. Answers why one cannot be set, or "".
func _write_added(
	scene: GdhSceneFile, new_node: Node, properties: Dictionary, adding: Array
) -> String:
	scene.asked(new_node, properties.keys())
	var unwritten: String = _properties.write_all(new_node, properties)
	scene.asked(new_node, _properties.moved_by_engine.keys())
	if not unwritten.is_empty():
		unwritten = GdhHeadlessCheck.setter_ran(new_node, _properties.unheld, unwritten)
	if unwritten.is_empty():
		unwritten = GdhGroups.change(scene, new_node, adding, [])
	return unwritten


## The answer to an add of [param new_node] at [param new_path]: what the node holds now.
func _added_answer(
	new_node: Node, node_name: String, new_path: String, properties: Dictionary, adding: Array
) -> Dictionary:
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
	return answer


## Why the node added at [param new_path] would not load from [param saved], the scene as written,
## with the groups [param adding] and the placeholder mark [param placeholder], or "".
static func _unkept_added(
	saved: Node, new_path: String, adding: Array, placeholder: bool
) -> String:
	var unkept: String = ""
	if saved.get_node_or_null(new_path) != null:
		unkept = GdhGroups.unkept(saved.get_node(new_path), adding, [])
	if unkept.is_empty() and placeholder:
		unkept = _placeholder_unkept(saved, new_path, true)
	return unkept


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
	var scene_path: String = GdhSceneFile.res_path(str(args.get("scenePath", "")))
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


## The editor's Change Type: the node at nodePath is made again as nodeType. It keeps its name,
## place, children, groups, the connections from and to it, the node values naming it and every
## value it stores that the new type has.
func change_node_type(args: Dictionary) -> Dictionary:
	var scene_path: String = GdhSceneFile.res_path(str(args.get("scenePath", "")))
	var node_path: String = str(args.get("nodePath", ""))
	var node_type: String = str(args.get("nodeType", ""))
	if node_type.is_empty():
		return { "ok": false, "error": "change_type takes nodeType, the class to make the node." }
	var resolved: Dictionary = _resolved_class(node_type)
	if resolved.has("error"):
		return { "ok": false, "error": resolved["error"] }
	node_type = str(resolved["type"])
	var class_script: Script = resolved["script"]
	var making: Array = GdhPlacing.what_to_add(node_type, "", scene_path)
	if not str(making[1]).is_empty():
		return { "ok": false, "error": making[1] }

	var opened: Array = _open(scene_path, true)
	var scene: GdhSceneFile = opened[0]
	var refused: Dictionary = opened[1]
	if not refused.is_empty():
		return refused
	var was: Node = GdhSceneFile.node_at(scene.root, node_path)
	if not was:
		return scene.refuse(scene.not_found("Node not found: " + node_path, node_path))
	var unchangeable: String = _type_fixed(scene, was)
	if not unchangeable.is_empty():
		return scene.refuse(unchangeable)
	var at: String = scene.path_of(was)
	var attached: Variant = was.get_script()
	var script: Script = attached if attached is Script else null
	var given: String = str(args.get("nodeType", ""))
	if class_script == script:
		class_script = null
	var conflict: String = _script_conflict(at, script, class_script, node_type, given)
	if not conflict.is_empty():
		return scene.refuse(conflict)
	if was.get_class() == node_type and class_script == null:
		return scene.refuse("%s is a %s already." % [at, given])

	var now: Node = GdhPlacing.made(null, node_type)
	now.name = was.name
	var dropped: Array[String] = _carried_values(was, now, class_script)
	if class_script != null:
		# Taken as asked once the values are carried, so a headless write keeps the script the file
		# never held and still puts back what the script's own code changes from here.
		scene.asked(now, ["script"])
	var cut: Array[Dictionary] = _connections_carried(scene, was, now)
	var was_type: String = was.get_class()
	var unheld: Array[Dictionary] = scene.replace(was, now)
	var written: Dictionary = scene.write(
		func(saved: Node) -> String:
			var copy: Node = saved.get_node_or_null(at)
			if copy == null or copy.get_class() != node_type:
				return "%s would not load as a %s." % [at, node_type]
			return ""
	)
	if not written.is_empty():
		return written
	var answer: Dictionary = {
		"ok": true, "nodePath": at, "nodeType": node_type, "wasType": was_type,
	}
	if class_script != null:
		answer["scriptClass"] = given
	_answer_if_any(answer, "dropped", dropped)
	_answer_if_any(answer, "connectionsRemoved", cut)
	_answer_if_any(answer, "cleared", unheld)
	return answer


## Sets [param key] in [param answer] to [param found] when it holds anything.
static func _answer_if_any(answer: Dictionary, key: String, found: Array) -> void:
	if not found.is_empty():
		answer[key] = found


## Why the node at [param at], holding [param script], cannot be made a [param node_type], or "".
## [param class_script] is the script a class_name [param given] brings, or null.
static func _script_conflict(
	at: String, script: Script, class_script: Script, node_type: String, given: String
) -> String:
	var clearing: String = 'scene_node set with properties {"script": null}'
	if class_script != null and script != null:
		return (
			(
				"%s has the script %s. The class_name %s brings its own. Clear the "
				+ "script with %s first, or give nodeType an engine class to keep it."
			)
			% [at, script.resource_path, given, clearing]
		)
	var base: String = "" if script == null else str(script.get_instance_base_type())
	if script != null and not ClassDB.is_parent_class(node_type, base):
		return (
			(
				"%s has the script %s, which extends %s. A %s does not inherit %s. Change the "
				+ "script's extends line to a class %s inherits, or clear the script with %s. "
				+ "Then change the type."
			)
			% [at, script.resource_path, base, node_type, base, node_type, clearing]
		)
	return ""


## Why [param node]'s type cannot change in [param scene], or "": its type is another scene's,
## since it is an instance, inside one, or made by a scene this one inherits.
static func _type_fixed(scene: GdhSceneFile, node: Node) -> String:
	var at: String = scene.path_of(node)
	if node == scene.root:
		if scene.inherits():
			return (
				"The root of %s takes its type from the scene it inherits. Change the type there."
			) % scene.path
		return ""
	var fixed: String = scene.fixed(node)
	if not fixed.is_empty():
		return fixed
	if not node.scene_file_path.is_empty():
		return (
			(
				"%s is an instance of %s, whose root gives its type. Change the type there, or "
				+ "delete the instance and add a node in its place."
			)
			% [at, node.scene_file_path]
		)
	return ""


## Gives [param now] what [param was] stores, as the editor's Change Type does: each value that is
## not its class's default, the script first so its variables take theirs. [param class_script] is
## the class_name script a type named, which [param now] takes instead of none. Answers the names
## of the values [param now]'s type has no property for.
static func _carried_values(was: Node, now: Node, class_script: Script) -> Array[String]:
	var plain: Object = ClassDB.instantiate(was.get_class())
	if class_script != null:
		now.set_script(class_script)
	elif was.get_script() != null:
		now.set_script(was.get_script())
	var has: Dictionary = {}
	for declared: Dictionary in now.get_property_list():
		has[str(declared["name"])] = true
	var dropped: Array[String] = []
	for declared: Dictionary in was.get_property_list():
		var named: String = str(declared["name"])
		if not GdhRead.as_int(declared.get("usage", 0)) & PROPERTY_USAGE_STORAGE:
			continue
		var value: Variant = was.get(named)
		if named in plain and GdhSame.same(plain.get(named), value):
			continue
		if has.has(named) or named.begins_with("metadata/"):
			now.set(named, value)
		else:
			dropped.append(named)
	if plain is Node:
		(plain as Node).free()
	return dropped


## Moves each persistent connection from and to [param was] onto [param now], with its flags, binds
## and unbinds. Answers each one [param now] cannot hold, a signal it lacks or a method it lacks, as
## {sourceNodePath, signalName, targetNodePath, methodName}, which is left out.
static func _connections_carried(scene: GdhSceneFile, was: Node, now: Node) -> Array[Dictionary]:
	var cut: Array[Dictionary] = []
	var at: String = scene.path_of(was)
	for info: Dictionary in was.get_signal_list():
		var signal_name: String = str(info["name"])
		for conn: Dictionary in was.get_signal_connection_list(signal_name):
			var flags: int = GdhRead.as_int(conn.get("flags", 0))
			var callable: Callable = conn["callable"]
			var target: Object = callable.get_object()
			if not flags & Object.CONNECT_PERSIST or target == null:
				continue
			var to: Object = now if target == was else target
			var target_path: String = at if target == was else scene.path_of(target as Node)
			if not now.has_signal(signal_name) or not to.has_method(callable.get_method()):
				cut.append(_connection(at, signal_name, target_path, callable.get_method()))
			else:
				var _joined: Error = now.connect(signal_name, GdhPlacing.aimed(callable, to), flags)
	# Moved here rather than by replace_by, which aims each at the method alone and so drops its
	# binds and unbinds.
	for conn: Dictionary in was.get_incoming_connections():
		var flags: int = GdhRead.as_int(conn.get("flags", 0))
		var source_signal: Signal = conn["signal"]
		var source: Object = source_signal.get_object()
		var callable: Callable = conn["callable"]
		if not flags & Object.CONNECT_PERSIST or source == was:
			continue
		source.disconnect(source_signal.get_name(), callable)
		if now.has_method(callable.get_method()):
			var aimed: Callable = GdhPlacing.aimed(callable, now)
			var _joined: Error = source.connect(source_signal.get_name(), aimed, flags)
		else:
			var from: String = scene.path_of(source as Node)
			cut.append(_connection(from, source_signal.get_name(), at, callable.get_method()))
	return cut


static func _connection(
	from: String,
	signal_name: String,
	to: String,
	method: String,
) -> Dictionary:
	return {
		"sourceNodePath": from,
		"signalName": signal_name,
		"targetNodePath": to,
		"methodName": method,
	}


func duplicate_node(args: Dictionary) -> Dictionary:
	var scene_path: String = GdhSceneFile.res_path(str(args.get("scenePath", "")))
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
	var barred_source: String = _barred_source(scene, source, node_path)
	if not barred_source.is_empty():
		return scene.refuse(barred_source)

	var target_parent: Node = source.get_parent()
	if not parent_path.is_empty():
		target_parent = GdhSceneFile.node_at(root, parent_path)
	var place: Variant = args.get("index")
	var barred: String = _barred_copy_parent(scene, target_parent, parent_path, new_name, place)
	if not barred.is_empty():
		return scene.refuse(barred)
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
	var plain: Array[Node] = _without_unique_names(copies, made)
	GdhPlacing.own(duplicated_node, root, made)
	GdhPlacing.reconnect(copies, source)
	scene.copied(copies)

	var new_path: String = scene.path_of(duplicated_node)
	var placed: Array = [scene.path_of(target_parent), duplicated_node.get_index()]
	var not_unique: Array[String] = []
	for copy: Node in plain:
		not_unique.append(scene.path_of(copy))
	var connected: Array[Dictionary] = _connections_copied(
		scene, scene.path_of(source), new_path
	)
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

	var answer: Dictionary = {
		"ok": true,
		"nodePath": node_path,
		"newName": new_name,
		"newNodePath": new_path,
		"parentNodePath": placed[0],
		"index": placed[1],
	}
	if not not_unique.is_empty():
		answer["notUnique"] = not_unique
	if not connected.is_empty():
		answer["connectionsCopied"] = connected
	return answer


## Why the node [param source] at [param node_path] cannot be duplicated in [param scene], or "".
## [param source] is null when the path names no node.
static func _barred_source(scene: GdhSceneFile, source: Node, node_path: String) -> String:
	if not source:
		return scene.not_found("Node not found: " + node_path, node_path)
	if source == scene.root:
		return "The root of %s cannot be copied into its own scene." % scene.path
	return scene.foreign(source)


## Why a copy named [param new_name] cannot go at [param place] under [param target_parent] in
## [param scene], or "". [param target_parent] is null when [param parent_path] names no node.
func _barred_copy_parent(
	scene: GdhSceneFile,
	target_parent: Node,
	parent_path: String,
	new_name: String,
	place: Variant,
) -> String:
	if not target_parent:
		return scene.not_found("Parent not found: " + parent_path, parent_path)
	var foreign: String = scene.foreign(target_parent)
	if not foreign.is_empty():
		return foreign
	var unusable: String = scene.unusable_name(target_parent, new_name)
	if not unusable.is_empty():
		return unusable
	return GdhPlacing.unplaceable(target_parent, null, place)


## Takes the unique name off each copy in [param copies] and answers those that had one, and marks
## each copy in [param made]. The original keeps its unique name, which a scene gives one node only.
## The engine took it off the copy with a warning saying the name was claimed, and the answer did
## not say so.
static func _without_unique_names(copies: Dictionary, made: Dictionary) -> Array[Node]:
	var plain: Array[Node] = []
	for value: Variant in copies.values():
		made[value] = true
		var copy: Node = value
		if copy.unique_name_in_owner:
			copy.unique_name_in_owner = false
			plain.append(copy)
	return plain


## The connections the file held from [param at] or a node under it, as
## {sourceNodePath, signalName, targetNodePath, methodName} with each end under [param at] moved
## under [param copy_at]: those the copy gets. One an instance makes inside itself is the instanced
## scene's, which the file does not hold.
static func _connections_copied(
	scene: GdhSceneFile, at: String, copy_at: String
) -> Array[Dictionary]:
	var copied: Array[Dictionary] = []
	for held: Dictionary in scene.held_connections():
		var from: String = str(held["sourceNodePath"])
		if from != at and not from.begins_with(at + "/"):
			continue
		var to: String = str(held["targetNodePath"])
		if to == at or to.begins_with(at + "/"):
			to = copy_at + to.substr(at.length())
		copied.append(
			{
				"sourceNodePath": copy_at + from.substr(at.length()),
				"signalName": held["signalName"],
				"targetNodePath": to,
				"methodName": held["methodName"],
			}
		)
	return copied


func reparent_node(args: Dictionary) -> Dictionary:
	var scene_path: String = GdhSceneFile.res_path(str(args.get("scenePath", "")))
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
	var place: Variant = args.get("index")
	var barred: String = _barred_move(scene, node, new_parent, [node_path, new_parent_path], place)
	if not barred.is_empty():
		return scene.refuse(barred)

	var old_path: String = scene.path_of(node)
	var old_parent: Node = node.get_parent()
	var drawn_at: Dictionary = _drawn_at(node)
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
	var also_changed: Dictionary = _changed_by_move(node, drawn_at, placed, stored_before)
	var sheared: String = _note_sheared(node, held_at, new_parent_path, also_changed)

	var new_path: String = scene.path_of(node)
	var index: int = node.get_index()
	var carried: GdhPaths = GdhPaths.new()
	var _rewritten: int = carried.carry(
		scene,
		{ old_path: new_path } if new_path != old_path else {},
	)
	var written: Dictionary = scene.write(
		func(saved: Node) -> String:
			var misplaced: String = _misplaced(saved, old_path, new_path, index)
			if not misplaced.is_empty():
				return misplaced
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


## Why [param node] cannot go under [param new_parent] at [param place] in [param scene], or "".
## Either is null when its path names no node. [param paths] holds the node's path and the new
## parent's, as the call gave them.
func _barred_move(
	scene: GdhSceneFile, node: Node, new_parent: Node, paths: Array[String], place: Variant
) -> String:
	if not node:
		return scene.not_found("Node not found: " + paths[0], paths[0])
	if not new_parent:
		return scene.not_found("New parent not found: " + paths[1], paths[1])
	var fixed: String = scene.fixed(node)
	if not fixed.is_empty():
		return fixed
	# Removed first and then refused by add_child, the node and everything under it were saved as
	# gone.
	if new_parent == node or node.is_ancestor_of(new_parent):
		return "%s cannot go under %s, which is itself or inside it." % [paths[0], paths[1]]
	var foreign: String = scene.foreign(new_parent)
	if not foreign.is_empty():
		return foreign
	var unusable: String = scene.unusable_name(new_parent, str(node.name), node)
	if not unusable.is_empty():
		return unusable
	return GdhPlacing.unplaceable(new_parent, node, place)


## The properties that place [param node] where it is drawn, as {property: value}.
func _drawn_at(node: Node) -> Dictionary:
	var drawn_at: Dictionary = {}
	for property: String in GdhPlacing.placing(node):
		drawn_at[property] = _properties.read_at(node, property)
	return drawn_at


## Why the moved node would not load at [param new_path] and [param index] from [param saved], the
## scene as written, with nothing left at [param old_path], or "".
static func _misplaced(saved: Node, old_path: String, new_path: String, index: int) -> String:
	var copy: Node = saved.get_node_or_null(new_path)
	if copy == null:
		return "%s would not be in the scene when it loads." % new_path
	if old_path != new_path and saved.get_node_or_null(old_path) != null:
		return "%s would still be in the scene as well when it loads." % old_path
	if copy.get_index() != index:
		return "%s would load at index %d, not %d." % [new_path, copy.get_index(), index]
	return ""


## What a move of [param node] changed besides its parent, as {property: {was, now}}: the drawn
## properties in [param drawn_at] that read differently now, and each of [param placed] the move
## changed that its placement does not already account for. [param stored_before] holds what the
## node stored before it moved.
func _changed_by_move(
	node: Node, drawn_at: Dictionary, placed: Array[String], stored_before: Dictionary
) -> Dictionary:
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
	return also_changed


## Where the move left [param node]'s basis sheared, under the parent at [param new_parent_path],
## the transform is recorded in [param also_changed] as it was in [param held_at]. Answers why the
## basis cannot be described otherwise, or "" when it is not sheared.
func _note_sheared(
	node: Node, held_at: Transform3D, new_parent_path: String, also_changed: Dictionary
) -> String:
	if not node is Node3D or not GdhPlacing.sheared((node as Node3D).basis):
		return ""
	var spatial: Node3D = node
	also_changed["transform"] = {
		"was": _readable(spatial, held_at), "now": _readable(spatial, spatial.transform),
	}
	return (
		(
			"%s keeps where it is drawn under %s, which is scaled unevenly across the way it "
			+ "is turned, so its basis is sheared: no position, rotation and scale describe "
			+ "it, and transform is what it holds. keepGlobalTransform false keeps its own "
			+ "transform instead."
		)
		% [str(spatial.name), new_parent_path]
	)


## Saves the branch at nodePath as a scene of its own at newScenePath and puts an instance of that
## scene where the branch was, as the editor's Save Branch as Scene does. The new file holds the
## branch's nodes, values, resources, groups and the connections among them, with its root's
## position reset as the editor resets it. The instance keeps the branch's name, place, position,
## rotation and scale. The rest of the scene keeps what it named in the branch: the connections to
## its nodes, the properties holding them and the %unique paths, which no longer reach a node
## unique only in the new scene.
func save_branch(args: Dictionary) -> Dictionary:
	var scene_path: String = GdhSceneFile.res_path(str(args.get("scenePath", "")))
	var node_path: String = str(args.get("nodePath", ""))
	var branch_path: String = _new_scene_path(args, "newScenePath")
	var unbranchable: String = _unbranchable(scene_path, node_path, branch_path)
	if not unbranchable.is_empty():
		return { "ok": false, "error": unbranchable }

	var opened: Array = _open(scene_path, true)
	var scene: GdhSceneFile = opened[0]
	var refused: Dictionary = opened[1]
	if not refused.is_empty():
		return refused
	var root: Node = scene.root
	var top: Node = GdhSceneFile.node_at(root, node_path)
	var barred: String = _barred_branch(scene, top, node_path)
	if not barred.is_empty():
		return scene.refuse(barred)

	var at: String = scene.path_of(top)
	var top_name: StringName = top.name
	var parent: Node = top.get_parent()
	var index: int = top.get_index()
	var unique: bool = top.unique_name_in_owner
	var placed_at: Dictionary = _placement_of(top)
	var sides: Array = _sides_of(root, top)
	var outside: Array[Node] = sides[0]
	var inside: Array[Node] = sides[1]

	var answer: Dictionary = { "ok": true, "nodePath": at, "newScenePath": branch_path }
	var enclosed: Dictionary = _enclosed_in(scene, inside, top)
	var held: Array[Array] = _holding_the_branch(outside, top)
	var crossing: Array[Array] = _crossing(outside, inside, top)
	_named_outside(scene, inside, top, answer)
	var scripts_out: Array[Dictionary] = _scripts_naming_outside(inside, top, branch_path)

	var split: Array = scene.split_off(top, branch_path)
	var branch: GdhSceneFile = split[0]
	var crossing_unmade: Array[Dictionary] = split[1]
	var editable: Array[Node] = _editable_in(root, inside, top)
	var below: Array[String] = []
	for node: Node in inside:
		below.append(str(top.get_path_to(node)))
	branch.asked(top, ["unique_name_in_owner"] + placed_at.keys())
	_detach_branch(parent, top, inside, editable)
	var written: Dictionary = branch.write(
		func(saved: Node) -> String: return _missing_below(saved, below, branch_path)
	)
	if not written.is_empty():
		scene.close()
		return written

	var instance: Node = _branch_instance(branch_path)
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
		func(saved: Node) -> String: return _instance_misplaced(saved, at, branch_path, index)
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


## Why a save_branch of the node at [param node_path] in the scene at [param scene_path] to
## [param branch_path] cannot start, or "".
static func _unbranchable(scene_path: String, node_path: String, branch_path: String) -> String:
	if node_path.is_empty() or node_path == ".":
		return "The root is the whole scene, which scene_create save_as copies to a new file."
	if branch_path.is_empty():
		return "Missing newScenePath"
	if branch_path == scene_path:
		return "newScenePath is %s, the scene the branch is in." % scene_path
	if FileAccess.file_exists(branch_path):
		return "%s already exists, and save_branch writes a new scene only." % branch_path
	return ""


## Why the node [param top] at [param node_path] in [param scene] cannot be saved as a branch, or
## "".
## [param top] is null when the path names no node.
static func _barred_branch(scene: GdhSceneFile, top: Node, node_path: String) -> String:
	if top == null:
		return scene.not_found("Node not found: " + node_path, node_path)
	var fixed: String = scene.fixed(top)
	if not fixed.is_empty():
		return fixed
	if not top.scene_file_path.is_empty():
		return "%s is an instance of %s, its scene already." % [node_path, top.scene_file_path]
	return ""


## The position, rotation and scale of [param top] when it is a 2D or 3D node, by property.
static func _placement_of(top: Node) -> Dictionary:
	var placed_at: Dictionary = {}
	if top is Node2D or top is Node3D:
		for property: String in ["position", "rotation", "scale"]:
			placed_at[property] = top.get(property)
	return placed_at


## The nodes of the scene at [param root] that [param top]'s branch leaves out and holds, as
## [outside, inside]. Each list starts with the node that roots it.
static func _sides_of(root: Node, top: Node) -> Array:
	var outside: Array[Node] = [root]
	var inside: Array[Node] = [top]
	for node: Node in root.find_children("*", "", true, false):
		if node.owner == root and node != top:
			if top.is_ancestor_of(node):
				inside.append(node)
			else:
				outside.append(node)
	return [outside, inside]


## The unique names of the nodes [param inside] the branch at [param top], each with its path in
## [param scene].
static func _enclosed_in(scene: GdhSceneFile, inside: Array[Node], top: Node) -> Dictionary:
	var enclosed: Dictionary = {}
	for node: Node in inside:
		if node != top and node.unique_name_in_owner:
			enclosed[str(node.name)] = scene.path_of(node)
	return enclosed


## The instances [param inside] the branch at [param top] whose children are editable in
## [param root]'s scene.
static func _editable_in(root: Node, inside: Array[Node], top: Node) -> Array[Node]:
	var editable: Array[Node] = []
	for node: Node in inside:
		if node != top and not node.scene_file_path.is_empty() and root.is_editable_instance(node):
			editable.append(node)
	return editable


## Takes [param top] out of [param parent] as the root of a scene of its own, with the nodes
## [param inside] under it and [param editable] of them editable, and its position reset.
static func _detach_branch(
	parent: Node, top: Node, inside: Array[Node], editable: Array[Node]
) -> void:
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


## Why the branch scene written would not hold each of [param below], paths from its root, or "".
static func _missing_below(saved: Node, below: Array[String], branch_path: String) -> String:
	for one: String in below:
		if saved.get_node_or_null(one) == null:
			return "%s would not be in %s when it loads." % [one, branch_path]
	return ""


## The scene at [param branch_path] instanced as an instance of it, or null.
static func _branch_instance(branch_path: String) -> Node:
	var packed: PackedScene = ResourceLoader.load(branch_path, "PackedScene") as PackedScene
	return packed.instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE) if packed != null else null


## Why the instance of [param branch_path] would not load at [param at] and [param index] from
## [param saved], the scene as written, or "".
static func _instance_misplaced(
	saved: Node, at: String, branch_path: String, index: int
) -> String:
	var copy: Node = saved.get_node_or_null(at)
	if copy == null or copy.scene_file_path != branch_path:
		return "%s would not load as an instance of %s." % [at, branch_path]
	if copy.get_index() != index:
		return "%s would load at index %d, not %d." % [at, copy.get_index(), index]
	return ""


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
	var scene_path: String = GdhSceneFile.res_path(str(args.get("scenePath", "")))
	var node_path: String = str(args.get("nodePath", "."))
	var properties: Dictionary = _parse_properties_arg(args.get("properties", {}))
	var editable: Variant = args.get("editableChildren")
	var adding: Array = GdhGroups.asked(args, "addGroups")
	var removing: Array = GdhGroups.asked(args, "removeGroups")
	var placeholder: Variant = args.get("placeholder")
	var unsetting: Array[String] = GdhUnset.asked(args)
	if _sets_nothing(properties, unsetting, [editable, placeholder], [adding, removing]):
		return {
			"ok": false,
			"error":
			(
				"set takes properties, unset, editableChildren, placeholder, addGroups or "
				+ "removeGroups."
			),
		}

	var opened: Array = _open(scene_path, true)
	var scene: GdhSceneFile = opened[0]
	var refused: Dictionary = opened[1]
	if not refused.is_empty():
		return refused

	var node: Node = GdhSceneFile.node_at(scene.root, node_path)
	var barred: String = _barred_set(scene, node, node_path, properties)
	if not barred.is_empty():
		return scene.refuse(barred)

	var conflict: String = _instance_modes_conflict(scene, node, editable, placeholder)
	if not conflict.is_empty():
		return scene.refuse(conflict)

	var dropped: Dictionary = {}
	var unmodal: String = _apply_instance_modes(scene, node, editable, placeholder, dropped)
	if not unmodal.is_empty():
		return scene.refuse(unmodal)

	var old_path: String = scene.path_of(node)
	var ungrouped: String = _set_and_group(scene, node, properties, [adding, removing])
	if not ungrouped.is_empty():
		return scene.refuse(ungrouped)
	var reverted: Dictionary = {}
	var followed: Array[String] = []
	var unrefused: String = _unset_on(scene, node, unsetting, properties, reverted, followed)
	if not unrefused.is_empty():
		return scene.refuse(unrefused)

	var new_path: String = scene.path_of(node)
	var answer: Dictionary = {
		"ok": true, "nodePath": new_path, "properties": _held_after(node, properties),
	}
	if not reverted.is_empty():
		answer["unset"] = reverted
	_properties.note_write(answer, node)
	_note_shared(answer, scene, node, properties.keys() + unsetting)
	if not adding.is_empty() or not removing.is_empty():
		answer["groups"] = GdhGroups.read(scene, node).get("groups", [])
	var named: Array[String] = _named_properties(node, properties)
	var source: String = scene.values_from(node, old_path)
	# Read before the write, which frees the node.
	var unsaved: Array[String] = _unsaved_names(node, named)
	var carried: GdhPaths = GdhPaths.new()
	var _rewritten: int = carried.carry(
		scene,
		{ old_path: new_path } if new_path != old_path else {},
	)
	var id: int = node.get_instance_id()
	var written: Dictionary = scene.write(
		func(saved: Node) -> String:
			var unkept: String = _kept(scene, saved, node, properties.keys() + unsetting)
			if unkept.is_empty():
				unkept = GdhGroups.unkept(saved.get_node(new_path), adding, removing)
			if unkept.is_empty():
				unkept = _modes_unkept(saved, new_path, editable, placeholder)
			return unkept
	)
	if not written.is_empty():
		carried.put_back(scene_path)
		return written

	_note_instance_modes(answer, editable, placeholder, dropped)
	_note_put_back(answer, scene, id, new_path)
	_note_loads_as(answer, scene, new_path)
	_note_left_out(answer, scene.written_pack, new_path, named, unsaved, source)
	_note_followed(answer, followed, source)
	if new_path != old_path:
		answer.merge(GdhKin.follow(scene_path, old_path, new_path, carried))
	return answer


## Whether a set gives nothing to do: no property, nothing to unset, neither of [param modes] (the
## editable children and the placeholder mark) and none of [param groups] (those to add and those
## to remove).
static func _sets_nothing(
	properties: Dictionary, unsetting: Array[String], modes: Array, groups: Array
) -> bool:
	var adding: Array = groups[0]
	var removing: Array = groups[1]
	return (
		properties.is_empty()
		and unsetting.is_empty()
		and modes[0] == null
		and modes[1] == null
		and adding.is_empty()
		and removing.is_empty()
	)


## Says in [param answer] that each of [param followed], the paths a set unset, now follows
## [param source] rather than holding a value, when it names one.
static func _note_followed(answer: Dictionary, followed: Array[String], source: String) -> void:
	if not followed.is_empty() and not source.is_empty():
		answer["unsetNote"] = (
			"%s now %s what %s gives this node, and a change there reaches it."
			% [", ".join(followed), "holds" if followed.size() == 1 else "hold", source]
		)


## Why [param properties] cannot be set on [param node] at [param node_path] in [param scene], or
## "".
## [param node] is null when the path names no node.
func _barred_set(
	scene: GdhSceneFile, node: Node, node_path: String, properties: Dictionary
) -> String:
	if not node:
		return scene.not_found("Node not found: " + node_path, node_path)
	# A rename is refused for the scene that makes the node before anything else, since editable
	# children would let this scene keep values on it and still never rename it.
	if properties.has("name") and node != scene.root:
		var fixed: String = scene.fixed(node)
		if not fixed.is_empty():
			return fixed
		var unusable: String = scene.unusable_name(node.get_parent(), str(properties["name"]), node)
		if not unusable.is_empty():
			return unusable
	return scene.foreign(node)


## Why [param editable] and [param placeholder], as a set gave them, cannot be put on [param node]
## together or on top of what it holds, or "". Either is null when the call leaves it alone.
func _instance_modes_conflict(
	scene: GdhSceneFile, node: Node, editable: Variant, placeholder: Variant
) -> String:
	# A placeholder loads without its children, so the editor never keeps both settings on.
	var wants_placeholder: bool = placeholder != null and GdhRead.as_bool(placeholder)
	var wants_editable: bool = editable != null and GdhRead.as_bool(editable)
	if wants_placeholder and wants_editable:
		return (
			"placeholder and editableChildren cannot both be true, "
			+ "since a placeholder loads without its children."
		)
	# The engine asks the root whether it is an editable instance of itself only with an error.
	var children_open: bool = node != scene.root and scene.root.is_editable_instance(node)
	if wants_placeholder and editable == null and children_open:
		return (
			(
				"%s has editable children, which a placeholder cannot keep. Pass "
				+ "editableChildren false with placeholder true to drop their saved values."
			)
			% scene.path_of(node)
		)
	if wants_editable and placeholder == null and node.get_scene_instance_load_placeholder():
		return (
			(
				"%s is a placeholder, which loads without its children. "
				+ "Pass placeholder false with editableChildren true."
			)
			% scene.path_of(node)
		)
	return ""


## Sets [param editable] and [param placeholder] on [param node], each only when the call gave it.
## What dropping its editable children dropped goes into [param dropped]. Answers why one cannot
## be set, or "".
func _apply_instance_modes(
	scene: GdhSceneFile, node: Node, editable: Variant, placeholder: Variant, dropped: Dictionary
) -> String:
	if editable != null:
		var not_an_instance: String = GdhKin.set_editable(scene, node, GdhRead.as_bool(editable))
		if not not_an_instance.is_empty():
			return not_an_instance
		if not GdhRead.as_bool(editable):
			dropped.merge(scene.held_under(scene.path_of(node)))
	if placeholder != null:
		# The editor offers Load as Placeholder only on an instance this scene places itself.
		if node == scene.root or node.owner != scene.root or node.scene_file_path.is_empty():
			return (
				"placeholder is a setting of an instance this scene places, and %s is not one."
				% scene.path_of(node)
			)
		node.set_scene_instance_load_placeholder(GdhRead.as_bool(placeholder))
	return ""


## Sets [param properties] on [param node], and the groups in [param groups], as [adding, removing],
## taking each as the call's own. Answers why one cannot be set, or "".
func _set_and_group(
	scene: GdhSceneFile, node: Node, properties: Dictionary, groups: Array
) -> String:
	scene.asked(node, properties.keys())
	var refused_property: String = _properties.write_all(node, properties)
	scene.asked(node, _properties.moved_by_engine.keys())
	if not refused_property.is_empty():
		return GdhHeadlessCheck.setter_ran(
			node, _properties.unheld, GdhSceneFile.missing_on(node, refused_property)
		)
	var adding: Array = groups[0]
	var removing: Array = groups[1]
	return GdhGroups.change(scene, node, adding, removing)


## What [param node] holds for each of [param properties] the call set, as the answer gives it.
## A metadata entry the write removed is left out.
func _held_after(node: Node, properties: Dictionary) -> Dictionary:
	var held: Dictionary = {}
	var removed: Array[String] = _properties.metadata_removed.duplicate()
	for key: Variant in properties:
		if not removed.has(str(key)):
			held[str(key)] = _readable(node, _properties.read_at(node, str(key)))
	return held


## Puts under sharedWith in [param answer] the scenes and resources that share a value of
## [param node] set or unset by [param keys], by key.
static func _note_shared(
	answer: Dictionary, scene: GdhSceneFile, node: Node, keys: Array
) -> void:
	var shared: Dictionary = {}
	for key: Variant in keys:
		var holders: Array[Dictionary] = GdhSceneSharing.holders(scene, node, str(key))
		if not holders.is_empty():
			shared[str(key)] = holders
	if not shared.is_empty():
		answer["sharedWith"] = shared


## The properties of [param node] that [param properties] set, without any path into one. It is
## what the node declares, not what it answers to: a MeshInstance3D reads any name under
## surface_material_override/0 as that slot, so a path into the slot's material read as the slot.
static func _named_properties(node: Node, properties: Dictionary) -> Array[String]:
	var declared_names: Dictionary = {}
	for declared: Dictionary in node.get_property_list():
		declared_names[str(declared.get("name", ""))] = true
	var named: Array[String] = []
	for key: Variant in properties:
		var property: String = str(key).get_slice(":", 0)
		if property != "name" and declared_names.has(property) and not named.has(property):
			named.append(property)
	return named


## Each of [param named] that [param node] declares but never stores.
static func _unsaved_names(node: Node, named: Array[String]) -> Array[String]:
	var unsaved: Array[String] = []
	for declared: Dictionary in node.get_property_list():
		var declared_name: String = str(declared.get("name", ""))
		if (
			named.has(declared_name)
			and not GdhRead.as_int(declared.get("usage", 0)) & PROPERTY_USAGE_STORAGE
		):
			unsaved.append(declared_name)
	return unsaved


## Why the node at [param new_path] would not load from [param saved], the scene as written, with
## the editable children [param editable] and the placeholder mark [param placeholder] given, or "".
## Either is null when the call left it alone.
static func _modes_unkept(
	saved: Node, new_path: String, editable: Variant, placeholder: Variant
) -> String:
	if editable != null:
		if saved.is_editable_instance(saved.get_node(new_path)) != GdhRead.as_bool(editable):
			return "%s would load with editableChildren %s." % [
				new_path,
				not GdhRead.as_bool(editable),
			]
	if placeholder != null:
		return _placeholder_unkept(saved, new_path, GdhRead.as_bool(placeholder))
	return ""


## Puts the editable children and placeholder mark the call gave, and what dropping the children
## dropped, in [param answer].
static func _note_instance_modes(
	answer: Dictionary, editable: Variant, placeholder: Variant, dropped: Dictionary
) -> void:
	if editable != null:
		answer["editableChildren"] = GdhRead.as_bool(editable)
	if placeholder != null:
		answer["placeholder"] = GdhRead.as_bool(placeholder)
	if not dropped.is_empty():
		answer["droppedValues"] = dropped["values"]
		answer["droppedNodes"] = dropped["nodes"]


## Takes each of [param paths] on [param node] back to what it holds when no line of this file sets
## it, or answers why not with nothing taken back. A value of the node's own goes back to what the
## scene it comes from gives, or its default, and its path is put in [param followed]. Each path
## goes into [param reverted] as the node reads it then. [param given] is what the call sets.
func _unset_on(
	scene: GdhSceneFile,
	node: Node,
	paths: Array[String],
	given: Dictionary,
	reverted: Dictionary,
	followed: Array[String],
) -> String:
	var at: String = scene.path_of(node)
	var places: Array[Array] = []
	for path: String in paths:
		var place: Array = GdhUnset.place_of(node, path, given)
		if place[0] == null:
			return str(place[1])
		var leaf: String = place[1]
		if place[0] == node:
			var here: Dictionary = scene.set_here(node)
			if here.has(leaf):
				places.append([node, leaf, scene.unset_value(node, leaf)])
				followed.append(path)
				continue
			var source: String = scene.values_from(node, at)
			var elsewhere: Variant = scene.unset_value(node, leaf)
			if (
				not source.is_empty()
				and not GdhSame.same(elsewhere, GdhHeadlessCheck.default_of(node, leaf))
			):
				return (
					(
						"%s holds no line for %s on %s: its value comes from %s, so it is unset "
						+ "there, with scene_node set on that scene."
					)
					% [scene.path, path, at, source]
				)
			return GdhUnset.not_stored(path, leaf, scene.path, here.keys())
		var resource: Resource = place[0]
		if not GdhUnset.resource_stores(scene.path, resource, null, leaf):
			var lines: Array = GdhUnset.resource_lines(scene.path, resource, null)
			return GdhUnset.not_stored(path, leaf, scene.path, lines)
		places.append([resource, leaf, GdhUnset.resource_default(resource, leaf)])
	scene.asked(node, paths)
	for place: Array in places:
		var holder: Object = place[0]
		holder.set(str(place[1]), place[2])
	for path: String in paths:
		reverted[path] = _readable(node, _properties.read_at(node, path))
	return ""


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
	var scene_path: String = GdhSceneFile.res_path(str(args.get("scenePath", "")))
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
	_note_placement(answer, node, props)
	_note_missing_bus(answer, node, props, set_here, at)
	var layers: Dictionary = _layers_of(node, props)
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


## Puts the position, rotation and scale of [param node] in [param answer] when it is a Node3D whose
## transform they describe, as [param props] holds it. A Node3D stores only its transform, a
## matrix, while a set takes the position, rotation and scale the inspector shows, so a node turned
## 45 degrees down read back as nine numbers. A sheared one has no such three, and is left to its
## transform.
func _note_placement(answer: Dictionary, node: Node, props: Dictionary) -> void:
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


## Notes in [param answer], and puts in [param props], a bus a player of [param node] names that
## the project's layout does not have. A player's getter answers Master for one, while the file
## keeps the name, so a player left on a renamed or removed bus read as one put on Master.
## [param set_here] holds what the file sets, and [param at] is the node's path.
func _note_missing_bus(
	answer: Dictionary, node: Node, props: Dictionary, set_here: Dictionary, at: String
) -> void:
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


## The layers each mask of [param node] in [param props] holds, under the names the project gives
## them. A mask reads as a number, and which layers it holds is what a caller reads it for.
static func _layers_of(node: Node, props: Dictionary) -> Dictionary:
	var layers: Dictionary = {}
	for declared: Dictionary in node.get_property_list():
		var hint: int = GdhRead.as_int(declared.get("hint", PROPERTY_HINT_NONE))
		var named: String = str(declared.get("name", ""))
		var mask: Variant = node.get(named) if props.has(named) else null
		if hint in GdhDeclared.LAYER_NAMES and mask is int:
			layers[named] = GdhDeclared.layers_in(hint, GdhRead.as_int(mask))
	return layers


func bake_navigation(args: Dictionary) -> Dictionary:
	var scene_path: String = GdhSceneFile.res_path(str(args.get("scenePath", "")))
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
	var scene_path: String = GdhSceneFile.res_path(str(args.get("scenePath", "")))
	var new_path_raw: String = str(args.get("newPath", ""))
	var target_path: String = scene_path
	if not new_path_raw.is_empty():
		target_path = GdhSceneFile.res_path(new_path_raw)

	if target_path != scene_path:
		if FileAccess.file_exists(target_path):
			return {
				"ok": false,
				"error":
				(
					(
						"%s already exists. save_as writes a new scene only. Give newPath a path "
						+ "with no file, or change that scene with scene_node."
					)
					% target_path
				),
			}
		var unsaved: String = GdhSceneFile.unsaved_in_editor(target_path)
		if not unsaved.is_empty():
			return { "ok": false, "error": unsaved }

	var open_root: Node = _open_root(scene_path)
	if target_path == scene_path and (open_root != null or _asked_of_the_editor(args)):
		var unloaded: Dictionary = (
			{} if open_root != null else GdhShownScene.loads(scene_path, true)
		)
		if not unloaded.is_empty():
			return unloaded
		return await _save_open_scene(scene_path)

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


## The root of [param scene_path] in the editor's tab for it, or null when no tab holds it.
static func _open_root(scene_path: String) -> Node:
	if not Engine.is_editor_hint():
		return null
	for open: Node in EditorInterface.get_open_scene_roots():
		if open.scene_file_path == scene_path:
			return open
	return null


## Whether [param args] ask for the editor's copy of a scene, which only an editor has.
static func _asked_of_the_editor(args: Dictionary) -> bool:
	return Engine.is_editor_hint() and str(args.get("from", "")) == "editor"


## Saves the editor's own copy of [param scene_path] through the editor, which is what its Save
## does. Loading the file and writing it back saved the disk version, and the reload after it
## discarded every unsaved change in the editor. A closed scene is opened for the save and closed
## after it. Each step gets its frames.
func _save_open_scene(scene_path: String) -> Dictionary:
	var was_open: bool = EditorInterface.get_open_scenes().has(scene_path)
	var refusal: String = await GdhShownScene.show(scene_path, SAVING)
	if not refusal.is_empty():
		return { "ok": false, "error": refusal }
	var saving: Error = EditorInterface.save_scene()
	var unsaved: bool = GdhSceneFile.unsaved(scene_path)
	var left: bool = await GdhShownScene.leave()
	if saving != OK:
		return {
			"ok": false,
			"error": "The editor failed to save %s: %s" % [scene_path, error_string(saving)],
		}
	var answer: Dictionary = {
		"ok": true,
		"scenePath": scene_path,
		"savedPath": scene_path,
		"from": "editor",
		"unsavedInEditor": unsaved,
	}
	if not was_open:
		answer["openedFirst" if left else "stillOpen"] = true
	return answer


## A node of a branch being saved as its own scene, held by a property outside it, by its path from
## the branch's top, until the instance replacing the branch gives the node at that path.
class GdhBranchMark:
	var below: NodePath

	func _init(at: NodePath) -> void:
		below = at
