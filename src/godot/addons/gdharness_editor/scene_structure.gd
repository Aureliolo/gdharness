@tool
extends RefCounted
## Puts a scene's nodes back where its file holds them after a headless engine ran its scripts.
##
## The editor gives a script that is not a tool a placeholder, and a headless engine runs it as the
## scene loads. A root's script reacting to [constant Node.NOTIFICATION_SCENE_INSTANTIATED] can then
## move, add or free the scene's nodes before any path is looked up. Each node the scene's
## [SceneState] lists is found again by its name: under its parent in the file, else anywhere the
## scene owns it. A node found elsewhere goes back under that parent, and the file's order among its
## siblings is restored. One no longer anywhere is made again from the state, keeping the unique_id
## the file gives it. A node no entry names goes only when a scene put back owns it, which is how a
## save keeps a node. Nothing else that exists is freed or made again: a node's own engine children,
## such as a container's scroll bars, are owned by no scene and held by the node.
##
## An instanced scene is put back against its own state. A scene whose scripts are all tools, or
## whose root's script is a tool, is left as it loads, as is every scene instanced inside one with
## a tool root, since an editor runs those scripts too and saves what they leave.

const GdhFileReads = preload("file_reads.gd")

## The unique_id the file gives each node made again, by the node's instance id. The engine gives a
## new node a new one as it packs it, and a script cannot set it.
var remade_ids: Dictionary = {}
var _root: Node = null
## The node of each entry, found or made, by instance id.
var _claimed: Dictionary = {}
## The top of each scene put back, by instance id. A node one owns that no entry names is a
## script's.
var _put_back: Dictionary = {}
## Each node made again, by instance id.
var _remade: Dictionary = {}
## The file's children of each parent in the file's order, by the parent's instance id, as
## {parent, children, putting}, where putting marks one a scene put back gives children.
var _ordered: Dictionary = {}
## The values of nodes made again that hold nodes, which the state names by path, set once every
## node is in place, as {node, property, value}.
var _deferred: Array[Dictionary] = []
## Each scene put back, as {top, state}, for the connections of the nodes made again.
var _levels: Array[Dictionary] = []
## The unique_ids and parent_id_paths of each scene file's entries, by its path, read once, as
## {ids, parents}.
var _filed_by_path: Dictionary = {}
## Each node in the scene by its name, as arrays, for finding a node a script moved away. A node
## renamed or freed since stays listed, so each use checks the node again.
var _by_name: Dictionary = {}
var _indexed: bool = false
var _editable: PackedStringArray = []


## Puts back what the scripts that ran as [param top] was instanced from [param packed] did to its
## nodes.
func put_back(top: Node, packed: PackedScene) -> void:
	_root = top
	_editable = _editable_of(packed)
	var _at: Dictionary = _level(top, packed.get_state(), false)
	_strip()
	_arrange()
	_resolve_deferred()
	if not _remade.is_empty():
		for level: Dictionary in _levels:
			var level_top: Node = level["top"]
			var level_state: SceneState = level["state"]
			_reconnect(level_top, level_state)


## Puts back the scene [param state] makes at [param top], answering each node of it by its path
## from [param top]. [param kept] marks a scene inside one whose root's script is a tool.
func _level(top: Node, state: SceneState, kept: bool) -> Dictionary:
	var tool_root: bool = kept or _tool_at_root(state)
	var putting: bool = not tool_root and _runs_untooled(state)
	if putting:
		_put_back[top.get_instance_id()] = true
		_levels.append({ "top": top, "state": state })
	_claimed[top.get_instance_id()] = true
	var at: Dictionary = { "": top }
	for entry: Dictionary in _entries(state):
		if entry["overrides"]:
			if putting:
				_override(top, entry)
			continue
		var parent: Node = _parent_of(top, at, entry)
		if parent == null:
			continue
		var node: Node = _node_of(top, parent, entry) if putting else _unclaimed(parent, entry)
		if node == null:
			continue
		_claimed[node.get_instance_id()] = true
		_order(parent, node, entry, putting)
		var key: String = _key(str(entry["parent"]), str(entry["name"]))
		at[key] = node
		var placed: PackedScene = entry["instance"]
		if placed != null:
			var inner: Dictionary = _level(node, placed.get_state(), tool_root)
			for path: Variant in inner:
				if not str(path).is_empty():
					at[_key(key, str(path))] = inner[path]
	return at


static func _key(parent: String, named: String) -> String:
	return named if parent.is_empty() else parent + "/" + named


## Whether a script that is not a tool is given to a node [param state] or a scene it inherits
## makes, which an editor would not have run.
static func _runs_untooled(state: SceneState) -> bool:
	var scripts: Array[Script] = []
	_scripts_of(state, scripts)
	for script: Script in scripts:
		if not script.is_tool():
			return true
	return false


## Whether the root of [param state], or of a scene it inherits, is given a tool script. That
## script reacts last as the scene is instanced and can reach any node in it.
static func _tool_at_root(state: SceneState) -> bool:
	var at: SceneState = state
	while at != null:
		for property: int in at.get_node_property_count(0):
			var held: Variant = at.get_node_property_value(0, property)
			if at.get_node_property_name(0, property) == &"script" and held is Script:
				var script: Script = held
				if script.is_tool():
					return true
		at = at.get_base_scene_state()
	return false


## Each node entry of [param state], those of the scene it inherits first. An entry that only
## changes a node another file makes is marked overrides.
static func _entries(state: SceneState) -> Array[Dictionary]:
	var entries: Array[Dictionary] = []
	var base: SceneState = state.get_base_scene_state()
	if base != null:
		entries.append_array(_entries(base))
	for index: int in range(1, state.get_node_count()):
		var type: String = str(state.get_node_type(index))
		var placed: PackedScene = state.get_node_instance(index)
		var placeholder: bool = state.is_node_instance_placeholder(index)
		entries.append(
			{
				"state": state,
				"index": index,
				"name": str(state.get_node_name(index)),
				"parent": _plain(str(state.get_node_path(index, true))),
				"path": _plain(str(state.get_node_path(index))),
				"type": type,
				"instance": placed,
				"placeholder": placeholder,
				"overrides": type.is_empty() and placed == null and not placeholder,
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
			var held: Variant = state.get_node_property_value(index, property)
			if state.get_node_property_name(index, property) == &"script" and held is Script:
				var script: Script = held
				into.append(script)


## The parent the file gives [param entry], from the nodes of the scene found so far, or null. A
## parent gone from its path, such as a node its own scene renamed, is found by the unique ids the
## file also gives it, as the engine finds it.
func _parent_of(top: Node, at: Dictionary, entry: Dictionary) -> Node:
	var found: Node = _at_path(top, at, str(entry["parent"]))
	if found != null:
		return found
	var recovered: String = _recovered_parent(entry)
	return null if recovered.is_empty() else _at_path(top, at, recovered)


static func _at_path(top: Node, at: Dictionary, path: String) -> Node:
	var held: Variant = at.get(path)
	if held is Node:
		var found: Node = held
		return found
	return top.get_node_or_null(NodePath(path))


## The path from the top of [param entry]'s scene to the parent its parent_id_path names, or "".
## Each id is looked for in the state reached so far, then in the scenes it inherits, and each id
## before the last names an instance whose own state holds the next, as SceneState walks them.
func _recovered_parent(entry: Dictionary) -> String:
	var state: SceneState = entry["state"]
	var index: int = entry["index"]
	var parents: Array[PackedInt32Array] = _filed(state)["parents"]
	if index >= parents.size() or parents[index].is_empty():
		return ""
	var id_path: PackedInt32Array = parents[index]
	var at: SceneState = state
	var path: String = ""
	for step: int in id_path.size():
		var found: int = -1
		while at != null:
			var ids: Array[int] = _filed(at)["ids"]
			found = ids.find(id_path[step])
			if found >= 0:
				break
			at = at.get_base_scene_state()
		if at == null:
			return ""
		path = _key(path, _plain(str(at.get_node_path(found))))
		if step < id_path.size() - 1:
			var placed: PackedScene = at.get_node_instance(found)
			if placed == null:
				return ""
			at = placed.get_state()
	return path


## The child of [param parent] named as [param entry] names its node, unless an entry has it.
func _unclaimed(parent: Node, entry: Dictionary) -> Node:
	var child: Node = _child_called(parent, str(entry["name"]))
	return null if child == null or _claimed.has(child.get_instance_id()) else child


## The child of [param parent] called [param named], found by name since siblings' names differ.
## A name a node path would read as more than one name is matched child by child.
static func _child_called(parent: Node, named: String) -> Node:
	if not _one_name(named):
		for child: Node in parent.get_children():
			if str(child.name) == named:
				return child
		return null
	var found: Node = parent.get_node_or_null(NodePath(named))
	# A node no scene owns may be one the parent keeps for itself, which get_children leaves out.
	if found != null and found.owner == null and not parent.get_children().has(found):
		return null
	return found


static func _one_name(named: String) -> bool:
	if named.is_empty() or named == "." or named == ".." or named.begins_with("%"):
		return false
	return not (named.contains("/") or named.contains(":"))


## The node of [param entry] under [param parent], moved back there or made again.
func _node_of(top: Node, parent: Node, entry: Dictionary) -> Node:
	var direct: Node = _unclaimed(parent, entry)
	if direct != null and _fits(direct, entry):
		return direct
	var elsewhere: Node = _owned_named(top, entry)
	if elsewhere == null:
		return direct if direct != null else _remake(top, parent, entry)
	if not elsewhere.is_ancestor_of(parent):
		_make_room(parent, str(entry["name"]), elsewhere)
		elsewhere.reparent(parent, false)
	return elsewhere


## A node [param top] owns anywhere in the scene that [param entry] could name, or null.
func _owned_named(top: Node, entry: Dictionary) -> Node:
	if not _indexed:
		_indexed = true
		_index(_root)
	var named: String = str(entry["name"])
	var listed: Array = _by_name.get(named, [])
	for held: Variant in listed:
		if not is_instance_valid(held):
			continue
		var node: Node = held
		if (
			node.owner == top
			and str(node.name) == named
			and not _claimed.has(node.get_instance_id())
			and _fits(node, entry)
		):
			return node
	return null


## Lists [param from] and every node under it in [member _by_name], in the order a walk from the
## scene's root meets them.
func _index(from: Node) -> void:
	var pending: Array[Node] = [from]
	while not pending.is_empty():
		var node: Node = pending.pop_back()
		pending.append_array(node.get_children())
		var listed: Array = _by_name.get_or_add(str(node.name), [])
		listed.append(node)


static func _fits(node: Node, entry: Dictionary) -> bool:
	var placed: PackedScene = entry["instance"]
	if placed != null:
		return placed.resource_path.is_empty() or node.scene_file_path == placed.resource_path
	if entry["placeholder"]:
		return node is InstancePlaceholder
	return node.get_class() == str(entry["type"])


## Frees the name [param named] under [param parent] for [param node]: a node a script added there
## goes if a scene put back owns it, else takes another name.
func _make_room(parent: Node, named: String, node: Node) -> void:
	var child: Node = _child_called(parent, named)
	if child == null or child == node:
		return
	if _strippable(child):
		parent.remove_child(child)
		child.free()
	else:
		child.name = StringName("%sAddedByScript%d" % [named, child.get_instance_id()])


## The node of [param entry] made again under [param parent] as the file holds it, or null when its
## class or scene cannot be made.
func _remake(top: Node, parent: Node, entry: Dictionary) -> Node:
	var made: Node = _made(entry)
	if made == null:
		return null
	var named: String = str(entry["name"])
	made.name = StringName(named)
	_store(made, entry)
	_make_room(parent, named, made)
	parent.add_child(made)
	made.owner = top
	if _indexed:
		_index(made)
	var state: SceneState = entry["state"]
	var index: int = entry["index"]
	for group: String in state.get_node_groups(index):
		made.add_to_group(group, true)
	_remade[made.get_instance_id()] = true
	var filed: int = _id_of(entry)
	if filed >= 0:
		remade_ids[made.get_instance_id()] = filed
	if entry["instance"] != null and _editable.has(str(_root.get_path_to(made))):
		_root.set_editable_instance(made, true)
	return made


static func _made(entry: Dictionary) -> Node:
	var placed: PackedScene = entry["instance"]
	if placed != null:
		return placed.instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE)
	if entry["placeholder"]:
		# As the instance itself, marked, which is how the scene puts back every placeholder it
		# opens with outside an editor.
		var state: SceneState = entry["state"]
		var index: int = entry["index"]
		var held: String = state.get_node_instance_placeholder(index)
		var scene: PackedScene = ResourceLoader.load(held, "PackedScene") as PackedScene
		var instance: Node = (
			scene.instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE) if scene != null else null
		)
		if instance != null:
			instance.set_scene_instance_load_placeholder(true)
		return instance
	var type: String = str(entry["type"])
	if not ClassDB.can_instantiate(type):
		return null
	var object: Object = ClassDB.instantiate(type)
	return object as Node


## Sets on [param node] what the state stores for [param entry]. A value that holds nodes waits
## until every node is in place.
func _store(node: Node, entry: Dictionary) -> void:
	var state: SceneState = entry["state"]
	var index: int = entry["index"]
	for property: int in state.get_node_property_count(index):
		var named: StringName = state.get_node_property_name(index, property)
		var value: Variant = state.get_node_property_value(index, property)
		if (value is NodePath or value is Array) and _holds_nodes(node, named):
			_deferred.append({ "node": node, "property": named, "value": value })
		else:
			node.set(named, value)


## Whether [param named] on [param node] is typed to hold a node or an array of objects.
static func _holds_nodes(node: Node, named: StringName) -> bool:
	for declared: Dictionary in node.get_property_list():
		if str(declared.get("name", "")) != str(named):
			continue
		var type: int = declared.get("type", TYPE_NIL)
		var hint: String = str(declared.get("hint_string", ""))
		return type == TYPE_OBJECT or (type == TYPE_ARRAY and hint.begins_with("%d/" % TYPE_OBJECT))
	return false


## Sets each value [method _store] held back, with the nodes its paths name from its node.
func _resolve_deferred() -> void:
	for one: Dictionary in _deferred:
		var node: Node = one["node"]
		var property: StringName = one["property"]
		var value: Variant = one["value"]
		if value is NodePath:
			var named: NodePath = value
			node.set(property, node.get_node_or_null(named))
			continue
		var paths: Array = value
		var held: Variant = node.get(property)
		var array: Array = []
		if held is Array:
			var current: Array = held
			array = current.duplicate()
		var _sized: int = array.resize(paths.size())
		for position: int in paths.size():
			var path: Variant = paths[position]
			if path is NodePath:
				var named: NodePath = path
				array[position] = node.get_node_or_null(named)
			else:
				array[position] = path
		node.set(property, array)


## Sets what an entry changing a node another file makes stores, where that node was made again
## or lies inside an instance made again, which the engine would otherwise have set.
func _override(top: Node, entry: Dictionary) -> void:
	var node: Node = top.get_node_or_null(NodePath(str(entry["path"])))
	if node == null or not _within_remade(node, top):
		return
	_store(node, entry)
	var state: SceneState = entry["state"]
	var index: int = entry["index"]
	for group: String in state.get_node_groups(index):
		node.add_to_group(group, true)


func _within_remade(node: Node, top: Node) -> bool:
	var at: Node = node
	while at != null and at != top:
		if _remade.has(at.get_instance_id()):
			return true
		at = at.get_parent()
	return false


## The unique_id the file gives [param entry]'s node, or -1.
func _id_of(entry: Dictionary) -> int:
	var ids: Array[int] = _filed(entry["state"])["ids"]
	var index: int = entry["index"]
	return ids[index] if index < ids.size() else -1


## The unique_id and parent_id_path the text scene of [param state] gives each entry, in the order
## its state holds them, as {ids, parents}. SceneState gives neither to a script. Both are empty
## for a binary scene, and for a file whose entries do not number the state's.
func _filed(state: SceneState) -> Dictionary:
	var file: String = state.get_path()
	if _filed_by_path.has(file):
		return _filed_by_path[file]
	var ids: Array[int] = []
	var parents: Array[PackedInt32Array] = []
	if file.ends_with(".tscn") and FileAccess.file_exists(file):
		for line: String in FileAccess.get_file_as_string(file).split("\n"):
			if line.begins_with("[node "):
				ids.append(GdhFileReads.unique_id_of(line))
				parents.append(_parent_ids_of(line))
	if ids.size() != state.get_node_count():
		ids.clear()
		parents.clear()
	var filed: Dictionary = { "ids": ids, "parents": parents }
	_filed_by_path[file] = filed
	return filed


## The ids a text scene's entry [param line] gives its parent's path, empty where it gives none.
static func _parent_ids_of(line: String) -> PackedInt32Array:
	var ids: PackedInt32Array = []
	var start: int = line.find(" parent_id_path=PackedInt32Array(")
	if start < 0:
		return ids
	start = line.find("(", start) + 1
	var end: int = line.find(")", start)
	if end < 0:
		return ids
	for part: String in line.substr(start, end - start).split(",", false):
		var _added: bool = ids.append(int(part.strip_edges()))
	return ids


## Notes [param node] as the next child the file gives [param parent], moved to the index the file
## gives it as the engine moves it.
func _order(parent: Node, node: Node, entry: Dictionary, putting: bool) -> void:
	var order: Dictionary = _ordered.get_or_add(
		parent.get_instance_id(), { "parent": parent, "children": [], "putting": false }
	)
	var was_putting: bool = order["putting"]
	order["putting"] = was_putting or putting
	var children: Array = order["children"]
	children.append(node)
	var state: SceneState = entry["state"]
	var index: int = entry["index"]
	var wanted: int = state.get_node_index(index)
	if wanted >= 0 and wanted < children.size() - 1:
		children.erase(node)
		var _inserted: int = children.insert(wanted, node)


## Whether [param node] is one no entry names, owned by a scene put back, which a save would keep.
func _strippable(node: Node) -> bool:
	return (
		not _claimed.has(node.get_instance_id())
		and node.owner != null
		and _put_back.has(node.owner.get_instance_id())
	)


## Frees each node a script added that a scene put back owns.
func _strip() -> void:
	var pending: Array[Node] = [_root]
	while not pending.is_empty():
		var node: Node = pending.pop_back()
		for child: Node in node.get_children():
			if _strippable(child):
				node.remove_child(child)
				child.free()
			else:
				pending.append(child)


## Puts the file's children of each parent a scene put back gives children in the file's order,
## in the places they hold among the others.
func _arrange() -> void:
	for key: Variant in _ordered:
		var order: Dictionary = _ordered[key]
		if not order["putting"]:
			continue
		var parent: Node = order["parent"]
		var wanted: Array[Node] = []
		var filed: Dictionary = {}
		for child: Variant in order["children"]:
			var node: Node = child
			if node.get_parent() == parent:
				wanted.append(node)
				filed[node.get_instance_id()] = true
		var layout: Array[Node] = parent.get_children()
		var next: int = 0
		for position: int in layout.size():
			if filed.has(layout[position].get_instance_id()):
				layout[position] = wanted[next]
				next += 1
		for position: int in layout.size():
			if layout[position].get_index() != position:
				parent.move_child(layout[position], position)


## Makes again each connection the scene of [param state] at [param top] holds from or to a node
## made again, as the engine makes it. One the engine cannot make stays for the write to keep. A
## pack tells the connections an instanced or inherited scene makes by its state, not by a flag.
func _reconnect(top: Node, state: SceneState) -> void:
	var base: SceneState = state.get_base_scene_state()
	if base != null:
		_reconnect(top, base)
	for index: int in state.get_connection_count():
		var source: Node = top.get_node_or_null(state.get_connection_source(index))
		var target: Node = top.get_node_or_null(state.get_connection_target(index))
		if source == null or target == null:
			continue
		if not (_remade.has(source.get_instance_id()) or _remade.has(target.get_instance_id())):
			continue
		var method: StringName = state.get_connection_method(index)
		var signal_name: StringName = state.get_connection_signal(index)
		if not source.has_signal(signal_name) or not target.has_method(method):
			continue
		var callable: Callable = Callable(target, method)
		var binds: Array = state.get_connection_binds(index)
		if not binds.is_empty():
			callable = callable.bindv(binds)
		var unbinds: int = state.get_connection_unbinds(index)
		if unbinds > 0:
			callable = callable.unbind(unbinds)
		if source.is_connected(signal_name, callable):
			continue
		var flags: int = CONNECT_PERSIST | state.get_connection_flags(index)
		var _connected: int = source.connect(signal_name, callable, flags)


## The paths of the instances [param packed] opens with their children editable.
static func _editable_of(packed: PackedScene) -> PackedStringArray:
	var found: PackedStringArray = []
	var given: Variant = packed.get("_bundled")
	if not given is Dictionary:
		return found
	var bundled: Dictionary = given
	var listed: Variant = bundled.get("editable_instances", [])
	if listed is Array:
		var paths: Array = listed
		for one: Variant in paths:
			var _kept: bool = found.append(str(one))
	return found
