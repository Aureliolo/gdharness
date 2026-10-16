@tool
extends RefCounted

## What a new node in a scene is made or copied from, what the scene owns of it, and where among its
## siblings a node may go.

const Read = preload("../reading.gd")
const PropertyValues = preload("../property_values.gd")


## The scene to instance for an add, or null for a node of a class, beside why neither can be made
## ("" when one can), as [PackedScene, String].
static func what_to_add(node_type: String, instance_path: String, scene_path: String) -> Array:
	if node_type.is_empty() == instance_path.is_empty():
		return [
			null,
			"add takes nodeType for a node of a class, or instancePath for a scene, and one of them only."
		]
	if not instance_path.is_empty():
		var cycle: String = _instancing_cycle(scene_path, instance_path)
		if not cycle.is_empty():
			return [null, cycle]
		if not ResourceLoader.exists(instance_path, "PackedScene"):
			return [null, "No scene at %s to instance." % instance_path]
		var packed: PackedScene = ResourceLoader.load(instance_path, "PackedScene") as PackedScene
		if packed == null or not packed.can_instantiate():
			return [null, "%s does not load as a scene that can be instanced." % instance_path]
		return [packed, ""]
	if node_type.begins_with("res://") or node_type.get_extension() in ["tscn", "scn"]:
		return [
			null,
			(
				"nodeType must be a node class, and %s is a scene: pass it as instancePath to instance it."
				% node_type
			)
		]
	if not ClassDB.class_exists(node_type) or not ClassDB.is_parent_class(node_type, "Node"):
		return [null, "nodeType must be a node class, and %s is not one." % node_type]
	if not ClassDB.can_instantiate(node_type):
		return [null, "%s cannot be instantiated." % node_type]
	return [null, ""]


## A new node of [param node_type], or an instance of [param packed] when there is one. The instance
## is made in the editor's edit state, so the pack writes it as an instance of its file, and owning
## its root leaves its own nodes to the instanced scene.
static func made(packed: PackedScene, node_type: String) -> Node:
	if packed != null:
		return packed.instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE)
	var node: Object = ClassDB.instantiate(node_type)
	return node as Node


## A copy of [param source] and the nodes under it that [param root] owns, each copy recorded in
## [param copies] against its source, or null when an instance in it no longer loads.
static func copied(source: Node, root: Node, copies: Dictionary) -> Node:
	var copy: Node = null
	if not source.scene_file_path.is_empty():
		# An instanced scene made again from its file, so the copy is an instance too. Node.duplicate
		# makes a plain node of the instance's class, and the pack saved it with every property of the
		# instance's root frozen into this scene.
		var packed: PackedScene = ResourceLoader.load(source.scene_file_path, "PackedScene") as PackedScene
		if packed == null:
			return null
		copy = packed.instantiate(PackedScene.GEN_EDIT_STATE_INSTANCE)
		for declared: Dictionary in source.get_property_list():
			if not (Read.as_int(declared.get("usage", 0)) & PROPERTY_USAGE_STORAGE):
				continue
			var property: String = str(declared.get("name", ""))
			var value: Variant = source.get(property)
			if not PropertyValues.same(copy.get(property), value):
				copy.set(property, value)
		for group: StringName in source.get_groups():
			if not copy.is_in_group(group):
				copy.add_to_group(group, true)
	else:
		copy = source.duplicate(Node.DUPLICATE_GROUPS | Node.DUPLICATE_SCRIPTS)
		for child: Node in copy.get_children():
			copy.remove_child(child)
			child.free()
	copy.name = source.name
	copies[source] = copy
	# Only what this scene owns: an instance's own nodes come with the instance.
	for child: Node in source.get_children():
		if child.owner == root:
			var under: Node = copied(child, root, copies)
			if under == null:
				return null
			copy.add_child(under)
	return copy


## Gives each copy in [param copies] the persistent connections its source has, to the copy of the
## target when the target was copied too. A connection an instance makes inside itself is skipped:
## the instance made again from its file already has it.
static func reconnect(copies: Dictionary, top: Node) -> void:
	for key: Variant in copies:
		var source: Node = key
		var copy: Node = copies[key]
		for info: Dictionary in source.get_signal_list():
			var signal_name: String = str(info.get("name", ""))
			for conn: Dictionary in source.get_signal_connection_list(signal_name):
				var flags: int = Read.as_int(conn.get("flags", 0))
				var callable: Callable = conn.get("callable", Callable())
				var target: Object = callable.get_object()
				if not flags & Object.CONNECT_PERSIST or target == null:
					continue
				var to: Object = copies.get(target, target)
				if to == target and target is Node and (target == top or top.is_ancestor_of(target as Node)):
					continue
				var aimed: Callable = Callable(to, callable.get_method())
				if (
					not copy.is_connected(signal_name, aimed)
					and copy.connect(signal_name, aimed, flags) != OK
				):
					push_error(
						"gdharness: could not copy the connection %s of %s" % [signal_name, source.name]
					)


## Owns [param node] and the nodes under it to [param root], except those an instanced scene
## inside it owns: giving those to the root made the pack write the instance's own nodes into this
## scene as overrides.
static func own(node: Node, root: Node) -> void:
	node.owner = root
	for child: Node in node.get_children():
		if child.owner == null or child.owner == root:
			own(child, root)


## Why [param asked] is not a position [param node] can take among [param parent]'s children, or ""
## when it is, or when none was asked for. [param node] is null for a node not yet added.
static func unplaceable(parent: Node, node: Node, asked: Variant) -> String:
	if asked == null:
		return ""
	var others: int = parent.get_child_count() - (1 if node != null and node.get_parent() == parent else 0)
	var at: int = Read.as_int(asked, -1)
	if at < 0 or at > others:
		return (
			"index %s is not a place among the %d other children of %s: give 0 to %d, 0 for first."
			% [
				str(at) if asked is int or asked is float else JSON.stringify(asked),
				others,
				parent.name,
				others
			]
		)
	return ""


## Moves [param node] to [param asked] among its siblings, when a place was asked for.
static func place(node: Node, asked: Variant) -> void:
	if asked != null:
		node.get_parent().move_child(node, Read.as_int(asked))


## Why [param instanced] cannot be instanced into [param scene_path], or "" when it can: a scene
## inside itself, directly or through the scenes it instances, which Godot's own dialog refuses and
## which never finishes loading.
static func _instancing_cycle(scene_path: String, instanced: String) -> String:
	var seen: Dictionary[String, bool] = {}
	var waiting: Array[String] = [instanced]
	while not waiting.is_empty():
		var at: String = waiting.pop_back()
		if at == scene_path:
			return (
				"%s cannot be instanced into %s: it %s, so the scene would hold itself."
				% [instanced, scene_path, "is that scene" if at == instanced else "instances it"]
			)
		if seen.has(at):
			continue
		seen[at] = true
		for dependency: String in ResourceLoader.get_dependencies(at):
			# Slices joined by "::", the UID, the type and the path, some of them empty.
			for part: String in dependency.split("::"):
				if part.begins_with("res://") and part.get_extension() in ["tscn", "scn"]:
					waiting.append(part)
	return ""
