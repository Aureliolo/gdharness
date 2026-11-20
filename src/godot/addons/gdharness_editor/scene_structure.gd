@tool
extends RefCounted
## Puts a scene's nodes back where its file holds them after a headless engine ran its scripts.
##
## The editor gives a script that is not a tool a placeholder and a headless engine runs it as the
## scene loads, so a script reacting to [constant Node.NOTIFICATION_SCENE_INSTANTIATED] can move,
## add or free the scene's nodes before any path is looked up. A scene's [SceneState] lists the
## nodes the file holds, and each is found again by its name among the nodes its scene owns, moved
## back under its parent in the file's order, or made again from the state when a script freed it.
## A node no entry names is one a script added and goes. An instanced scene is put back against its
## own state, since its scripts ran as it loaded.
##
## A scene holding a tool script is left as it loads, since an editor runs that script too and
## saves what it leaves.

const GdhHeadlessCheck = preload("headless_check.gd")

## The nodes that have a place in a file, by instance id.
var _claimed: Dictionary = {}
## The root of each scene put back, the opened one and each instance in it, by instance id.
var _scenes: Dictionary = {}
## The nodes the file holds under each parent, in its order, by the parent's instance id, as
## {parent, children}.
var _ordered: Dictionary = {}
var _problems: Array[String] = []
var _scripts: Dictionary = {}


## Answers "" once [param top] holds the nodes [param state] files where it files them, or why a
## node could not be put back.
func put_back(top: Node, state: SceneState) -> String:
	_level(top, state)
	_arrange()
	if _problems.is_empty():
		return ""
	var named: PackedStringArray = PackedStringArray(_scripts.keys())
	return (
		(
			"A script of the scene changed its nodes as a headless engine loaded it, and what it "
			+ "did cannot be put back as the file holds it: %s. The scripts that ran are %s. "
		)
		% [", ".join(PackedStringArray(_problems)), ", ".join(named)]
		+ GdhHeadlessCheck.REMEDY
	)


func _level(top: Node, state: SceneState) -> void:
	var entries: Array[Dictionary] = _entries(state)
	_scenes[top.get_instance_id()] = true
	_claimed[top.get_instance_id()] = true
	var scripts: Array[Script] = []
	_scripts_of(state, scripts)
	var tooled: bool = scripts.is_empty()
	for script: Script in scripts:
		tooled = tooled or script.is_tool()
	if not tooled:
		for script: Script in scripts:
			_scripts[script.resource_path] = true
	var at: Dictionary = { "": top }
	for entry: Dictionary in entries:
		var node: Node = _node_of(top, at, entry, tooled)
		if node == null:
			continue
		var named: String = str(entry["name"])
		var shown: String = str(entry["parent"])
		at[named if shown.is_empty() else shown + "/" + named] = node
		var placed: PackedScene = entry["instance"]
		if placed != null:
			_level(node, placed.get_state())
	if not tooled:
		_clear(top)


## The node of [param entry] under [param top], placed where the file has it unless [param tooled].
func _node_of(top: Node, at: Dictionary, entry: Dictionary, tooled: bool) -> Node:
	var parent: Node = at.get(str(entry["parent"]))
	if parent == null:
		parent = top.get_node_or_null(NodePath(str(entry["parent"])))
	if parent == null:
		if not tooled:
			_problems.append("%s, whose parent %s is gone" % [entry["name"], entry["parent"]])
		return null
	var node: Node = _find(top, parent, entry)
	if tooled:
		return node
	if node == null:
		node = _remake(entry)
		if node == null:
			_problems.append("%s was freed and has no class to make it again from" % entry["name"])
			return null
	_place(node, parent, top, entry)
	_claimed[node.get_instance_id()] = true
	var order: Dictionary = _ordered.get_or_add(
		parent.get_instance_id(), { "parent": parent, "children": [] }
	)
	var children: Array = order["children"]
	children.append(node)
	return node


## Each node the file holds in [param state] that has an entry of its own, those of the scene it
## inherits first.
static func _entries(state: SceneState) -> Array[Dictionary]:
	var entries: Array[Dictionary] = []
	var base: SceneState = state.get_base_scene_state()
	if base != null:
		entries.append_array(_entries(base))
	for index: int in range(1, state.get_node_count()):
		var type: String = str(state.get_node_type(index))
		var placed: PackedScene = state.get_node_instance(index)
		var placeholder: bool = state.is_node_instance_placeholder(index)
		# A node of an instanced scene that the file only changes has no entry to put back.
		if type.is_empty() and placed == null and not placeholder:
			continue
		entries.append(
			{
				"state": state,
				"index": index,
				"name": str(state.get_node_name(index)),
				"parent": _plain(str(state.get_node_path(index, true))),
				"type": type,
				"instance": placed,
				"placeholder": placeholder,
			}
		)
	return entries


static func _plain(node_path: String) -> String:
	return "" if node_path == "." else node_path.trim_prefix("./")


## Adds to [param into] each script [param state] gives a node, or the scene it inherits does.
static func _scripts_of(state: SceneState, into: Array[Script]) -> void:
	var base: SceneState = state.get_base_scene_state()
	if base != null:
		_scripts_of(base, into)
	for index: int in state.get_node_count():
		for property: int in state.get_node_property_count(index):
			if state.get_node_property_name(index, property) != &"script":
				continue
			var held: Variant = state.get_node_property_value(index, property)
			if held is Script:
				var script: Script = held
				into.append(script)


## The node [param entry] names: where the file has it, else any node the scene owns by that name
## and kind, else null.
func _find(top: Node, parent: Node, entry: Dictionary) -> Node:
	var named: String = str(entry["name"])
	for child: Node in parent.get_children(true):
		if str(child.name) == named and not _claimed.has(child.get_instance_id()):
			return child
	var pending: Array[Node] = [top]
	while not pending.is_empty():
		var node: Node = pending.pop_back()
		pending.append_array(node.get_children(true))
		if (
			str(node.name) == named
			and node.owner == top
			and not _claimed.has(node.get_instance_id())
			and _fits(node, entry)
		):
			return node
	return null


static func _fits(node: Node, entry: Dictionary) -> bool:
	var placed: PackedScene = entry["instance"]
	if placed != null:
		return placed.resource_path.is_empty() or node.scene_file_path == placed.resource_path
	if entry["placeholder"]:
		return node is InstancePlaceholder
	return node.get_class() == str(entry["type"])


## A node made from [param entry] as the file holds it, or null when its class or scene is gone.
static func _remake(entry: Dictionary) -> Node:
	var made: Node = null
	var placed: PackedScene = entry["instance"]
	var type: String = str(entry["type"])
	if placed != null:
		made = placed.instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE)
	elif not type.is_empty() and ClassDB.can_instantiate(type):
		var object: Object = ClassDB.instantiate(type)
		made = object as Node
	if made == null:
		return null
	made.name = StringName(str(entry["name"]))
	var state: SceneState = entry["state"]
	var index: int = entry["index"]
	for property: int in state.get_node_property_count(index):
		made.set(
			state.get_node_property_name(index, property),
			state.get_node_property_value(index, property)
		)
	for group: String in state.get_node_groups(index):
		made.add_to_group(group, true)
	return made


## Puts [param node] under [param parent] with the name and owner the file gives it.
static func _place(node: Node, parent: Node, top: Node, entry: Dictionary) -> void:
	var named: String = str(entry["name"])
	if node.get_parent() != parent:
		# A node a script added and kept under the name must not take the file's node's.
		for sibling: Node in parent.get_children(true):
			if str(sibling.name) == named and sibling != node:
				sibling.name = StringName("AddedByScript%d" % sibling.get_instance_id())
		var held: Node = node.get_parent()
		if held != null:
			held.remove_child(node)
		parent.add_child(node)
	if str(node.name) != named:
		node.name = StringName(named)
	if node.owner != top:
		node.owner = top


## Frees what [param node] holds that no entry of the file names, short of another scene's own.
func _clear(node: Node) -> void:
	for child: Node in node.get_children(true):
		var id: int = child.get_instance_id()
		if not _claimed.has(id):
			node.remove_child(child)
			child.free()
		elif not _scenes.has(id):
			_clear(child)


## Puts each parent's children that the file holds in the file's order.
func _arrange() -> void:
	for key: Variant in _ordered:
		var order: Dictionary = _ordered[key]
		var parent: Node = order["parent"]
		var wanted: Array = order["children"]
		var next: int = 0
		var layout: Array[Node] = []
		for child: Node in parent.get_children(true):
			if wanted.has(child):
				var chosen: Node = wanted[next]
				layout.append(chosen)
				next += 1
			else:
				layout.append(child)
		for position: int in layout.size():
			if layout[position].get_index(true) != position:
				parent.move_child(layout[position], position)
