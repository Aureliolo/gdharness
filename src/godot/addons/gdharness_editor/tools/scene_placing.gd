@tool
extends RefCounted

## What a new node in a scene is made from, and where among its siblings a node may go.

const Read = preload("../reading.gd")


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
