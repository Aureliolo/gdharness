@tool
extends RefCounted
## The groups a node of a scene is in. A scene's own file puts a node in a group and can take it
## out of one it put it in. A group the scene that makes the node puts it in, the one it is
## instanced from or one this scene inherits, can be changed only there, as the editor's group dock
## shows it locked.

const GdhSceneFile = preload("../scene_file.gd")


## The groups of [param node], sorted, as {groups, groupsHere}: groupsHere, those this scene's file
## puts it in, is given only where another scene puts it in some of them. Empty for a node in none.
static func read(scene: GdhSceneFile, node: Node) -> Dictionary:
	var all: Array = _sorted(node.get_groups())
	if all.is_empty():
		return {}
	var answer: Dictionary = { "groups": all }
	var here: Array = _sorted(scene.groups_at(scene.path_of(node)))
	if here.size() != all.size():
		answer["groupsHere"] = here
	return answer


## The groups of [param node], just added to this scene and put in [param adding] there, in the
## shape [method read] answers: this scene's file does not hold the node until it is saved.
static func read_added(node: Node, adding: Array) -> Dictionary:
	var all: Array = _sorted(node.get_groups())
	if all.is_empty():
		return {}
	var answer: Dictionary = { "groups": all }
	var here: Array = []
	for group: String in _sorted(adding):
		if not here.has(group):
			here.append(group)
	if here.size() != all.size():
		answer["groupsHere"] = here
	return answer


## The group names under [param key] of [param args], which the server has checked are strings, or
## none when not given.
static func asked(args: Dictionary, key: String) -> Array:
	var given: Variant = args.get(key)
	return given if given is Array else []


## Puts [param node] in each group of [param adding] and takes it out of each of [param removing],
## or answers why not with nothing changed.
static func change(scene: GdhSceneFile, node: Node, adding: Array, removing: Array) -> String:
	for group: Variant in adding + removing:
		if str(group).strip_edges().is_empty():
			return (
				"%s names no group: a group's name has something in it besides spaces."
				% JSON.stringify(group)
			)
	for group: Variant in adding:
		if removing.has(group):
			return "%s is in both addGroups and removeGroups." % str(group)
	var at: String = scene.path_of(node)
	var here: PackedStringArray = scene.groups_at(at)
	for group: Variant in removing:
		var name: String = str(group)
		if not node.is_in_group(name):
			var held: Array = _sorted(node.get_groups())
			return (
				"%s is in no group %s; %s."
				% [
					node.name,
					name,
					"it is in " + ", ".join(held) if not held.is_empty() else "it is in none",
				]
			)
		if not here.has(name):
			var from: String = scene.values_from(node, at)
			if from.is_empty():
				return (
					(
						"%s is in %s, which no scene file puts it in: something puts it there as "
						+ "it is made, such as its script."
					)
					% [node.name, name]
				)
			return (
				(
					"%s is in %s because %s puts it there, and no scene using that one can take it "
					+ "out: remove the group in %s, which takes it out in every scene using that "
					+ "one."
				)
				% [node.name, name, from, from]
			)
	for group: Variant in adding:
		node.add_to_group(str(group), true)
	for group: Variant in removing:
		node.remove_from_group(str(group))
	return ""


## Why [param saved], the node as the written file loads it, is not in the groups asked, or "".
static func unkept(saved: Node, adding: Array, removing: Array) -> String:
	for group: Variant in adding:
		if not saved.is_in_group(str(group)):
			return "%s would load in no group %s." % [saved.name, str(group)]
	for group: Variant in removing:
		if saved.is_in_group(str(group)):
			return "%s would still load in the group %s." % [saved.name, str(group)]
	return ""


static func _sorted(groups: Variant) -> Array:
	var names: Array = []
	for group: Variant in groups:
		names.append(str(group))
	names.sort()
	return names
