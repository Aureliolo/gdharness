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

const GdhRead = preload("reading.gd")
const GdhSame = preload("same_values.gd")
const GdhSerialisation = preload("serialisation.gd")


## The nodes of [param scene_path] as {name, type, path, children}, with instanceOf and
## editableChildren on a node that instances another scene and every stored property when
## [param include_properties] is set, the file's value or the default where it sets none, and on a
## node another file makes setHere, the properties this file sets on it.
## [param depth] -1 reads every level.
static func scene_tree(scene_path: String, depth: int, include_properties: bool) -> Dictionary:
	var laid: Dictionary = _laid(scene_path)
	if not laid.get("ok", false):
		return laid
	var nodes: Dictionary = laid["nodes"]
	return {"ok": true, "tree": _entry(nodes, ".", include_properties, depth, 0)}


## The node at [param node_path] in [param scene_path] as {ok, name, type, properties}, laid as
## [method scene_tree] lays it, with only the properties the files set; {} when the scene has no
## node there, and a refusal when the file does not read as a scene.
static func scene_node(scene_path: String, node_path: String) -> Dictionary:
	var laid: Dictionary = _laid(scene_path)
	if not laid.get("ok", false):
		return laid
	var nodes: Dictionary = laid["nodes"]
	var path: String = _joined(".", node_path)
	if not nodes.has(path):
		return {}
	var found: Dictionary = nodes[path]
	return {"ok": true, "name": found["name"], "type": found["type"], "properties": found["properties"]}


## The node at [param node_path] in [param scene_path] as [method scene_node] answers it, when it is
## a [param kind]; otherwise a refusal saying what the scene has there and where its nodes of that
## kind are, so the caller has the path to pass. The file is read once, because every load prints
## the engine's warnings about it again.
static func scene_node_of_kind(scene_path: String, node_path: String, kind: String) -> Dictionary:
	var laid: Dictionary = _laid(scene_path)
	if not laid.get("ok", false):
		return laid
	var nodes: Dictionary = laid["nodes"]
	var path: String = _joined(".", node_path)
	var said: String = "%s not found at: %s" % [kind, node_path]
	var found: String = ""
	if nodes.has(path):
		found = str(nodes[path]["type"])
		if ClassDB.class_exists(found) and ClassDB.is_parent_class(found, kind):
			return {
				"ok": true,
				"name": nodes[path]["name"],
				"type": found,
				"properties": nodes[path]["properties"]
			}
	else:
		var hinted: String = said
		if not nodes.has(_joined(".", node_path.get_slice("/", 0))):
			hinted = GdhRead.from_the_root(said, node_path, str(nodes["."]["name"]))
		said = hinted if hinted != said else _missing_in(nodes, said, node_path)
	var held: PackedStringArray = []
	for at: Variant in nodes:
		var type: String = str(nodes[at]["type"])
		if ClassDB.class_exists(type) and ClassDB.is_parent_class(type, kind):
			var _held: bool = held.append(str(at))
	return {"ok": false, "error": GdhRead.not_of_kind(said, node_path, found, kind, held)}


## [param said], the refusal for [param node_path], which the scene laid as [param nodes] does not
## have, with where the path leaves the scene as [method GdhRead.missing_below] says it.
static func _missing_in(nodes: Dictionary, said: String, node_path: String) -> String:
	var parts: PackedStringArray = node_path.trim_prefix("./").split("/", false)
	var at: String = "."
	var reached: PackedStringArray = []
	for part: String in parts:
		var below: String = _joined(at, part)
		if not nodes.has(below):
			break
		at = below
		var _walked: bool = reached.append(part)
	if reached.size() >= parts.size():
		return said
	var names: PackedStringArray = []
	var children: Array[String] = nodes[at]["children"]
	for child: String in children:
		var _named: bool = names.append(str(nodes[child]["name"]))
	return GdhRead.missing_below(said, str(nodes["."]["name"]), reached, parts[reached.size()], names)


## Every node of [param scene_path] as {ok, nodes}, keyed by path, or a refusal.
static func _laid(scene_path: String) -> Dictionary:
	if not FileAccess.file_exists(scene_path):
		return {"ok": false, "error": "Scene not found: " + scene_path}
	# Loaded without naming the type, so a resource handed in by mistake loads as what it is and the
	# refusal can say so, where asking for a PackedScene printed the loader's error and a backtrace.
	var loaded: Resource = ResourceLoader.load(scene_path, "", ResourceLoader.CACHE_MODE_IGNORE)
	if loaded == null:
		return {"ok": false, "error": "Failed to load %s as a scene" % scene_path}
	if not loaded is PackedScene:
		var sort: String = GdhRead.with_article(loaded.get_class())
		return {
			"ok": false,
			"error": "%s is %s, not a scene: resource_edit read reads its properties." % [scene_path, sort]
		}
	var packed: PackedScene = loaded
	var nodes: Dictionary = {}
	var refused: String = _lay(packed.get_state(), ".", nodes, [scene_path], packed)
	if not refused.is_empty():
		return {"ok": false, "error": refused}
	if not nodes.has("."):
		return {"ok": false, "error": "%s holds no nodes" % scene_path}
	var base: SceneState = packed.get_state().get_base_scene_state()
	if base != null:
		nodes["."]["inherits"] = base.get_path()
	return {"ok": true, "nodes": nodes}


## Lays the nodes of [param state] into [param nodes] under [param prefix], keyed by their path
## from the outermost root, each instanced scene laid where it is instanced and the instancing
## file's own entries for it applied over it. Answers a refusal, or "".
##
## [param within] is the files being laid, outermost first, so a scene that instances one of them
## is refused rather than laid forever; the engine refuses to load such a scene, so this is only
## reached through a state built some other way. [param loaded] is the scene [param state] is read
## from, when the caller has it loaded already.
static func _lay(
	state: SceneState, prefix: String, nodes: Dictionary, within: Array, loaded: PackedScene = null
) -> String:
	var base: SceneState = state.get_base_scene_state()
	if base != null and not nodes.has(prefix):
		var refused: String = _lay(base, prefix, nodes, within)
		if not refused.is_empty():
			return refused
	var ids: Array[int] = _unique_ids(state.get_path(), state.get_node_count())
	for index: int in state.get_node_count():
		var path: String = _joined(prefix, str(state.get_node_path(index)))
		var recovered: bool = false
		if not nodes.has(path) and index > 0 and _overrides(state, index) and ids[index] >= 0:
			# The engine finds an entry whose node was renamed or moved in the scene it comes from by
			# the node's unique_id, and keeps the node's new name.
			var parent: String = _joined(prefix, str(state.get_node_path(index, true)))
			var found: String = _by_id(nodes, _owner_of(nodes, parent, prefix), ids[index])
			recovered = not found.is_empty()
			if recovered:
				path = found
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
				nodes[path]["editableChildren"] = false
			elif state.is_node_instance_placeholder(index):
				nodes[path] = _made("InstancePlaceholder")
				nodes[path]["instanceOf"] = state.get_node_instance_placeholder(index)
			elif str(state.get_node_type(index)).is_empty():
				# An entry for a node of an instance that no longer has it, which the engine skips too.
				continue
			else:
				nodes[path] = _made(str(state.get_node_type(index)))
				nodes[path]["madeHere"] = loaded != null
			if ids[index] >= 0:
				nodes[path]["uniqueId"] = ids[index]
			# Laid at the root with no scene handed in is a scene the one being read inherits, and the
			# deepest is laid first, so this is the file that makes the node.
			if prefix == "." and loaded == null:
				nodes[path]["inheritedFrom"] = state.get_path()
		# The name is the state's even for an entry laid already, since an inherited scene names its
		# root itself; a root instanced inside another scene is renamed by that scene once laid.
		if not recovered:
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
		# Every file on the way puts the node in its own groups: the scene making it, and each scene
		# instancing or inheriting that one.
		var grouped: Array[String] = nodes[path]["groups"]
		for group: StringName in state.get_node_groups(index):
			if not grouped.has(str(group)):
				grouped.append(str(group))
		var held: Dictionary = nodes[path]["properties"]
		# What the file being read sets, kept apart for a node another file makes, whose values read
		# the same whether this scene changed them or that one gave them.
		var laid: Dictionary = nodes[path]
		var set_here: Array = laid.get_or_add("setHere", [])
		for property: int in state.get_node_property_count(index):
			var named: String = str(state.get_node_property_name(index, property))
			held[named] = state.get_node_property_value(index, property)
			if loaded != null and not set_here.has(named):
				set_here.append(named)
	# Only the scene being read and the scenes it inherits share its root, the owner whose editable
	# instances a write here sets; a file instanced below makes its own owner's editable.
	if prefix == ".":
		for editable: String in _editable_in(state.get_path(), loaded):
			var at: String = _joined(prefix, editable)
			var marked: Dictionary = nodes.get(at, {})
			if marked.has("editableChildren"):
				marked["editableChildren"] = true
	return ""


## The paths of the instances [param scene_path] gives editable children, from its root. SceneState
## does not give them to a script, so they are read off the scene's bundle: [param given_scene]'s,
## when the caller has the file loaded, since loading it again prints its warnings again.
static func _editable_in(scene_path: String, given_scene: PackedScene = null) -> PackedStringArray:
	var found: PackedStringArray = []
	var loaded: Resource = given_scene
	if loaded == null:
		loaded = ResourceLoader.load(scene_path, "", ResourceLoader.CACHE_MODE_IGNORE)
	if not loaded is PackedScene:
		return found
	var given: Variant = loaded.get("_bundled")
	if not given is Dictionary:
		return found
	var bundled: Dictionary = given
	var listed: Variant = bundled.get("editable_instances", [])
	if listed is Array:
		for one: Variant in listed:
			var _kept: bool = found.append(str(one))
	return found


## The unique_id of each node entry in the text scene at [param scene_path], in the order its state
## holds them, -1 where an entry has none. All -1 for a binary scene, and for a file whose entries do
## not number [param count], since SceneState does not give the ids to a script.
static func _unique_ids(scene_path: String, count: int) -> Array[int]:
	var ids: Array[int] = []
	var _sized: int = ids.resize(count)
	ids.fill(-1)
	if not scene_path.ends_with(".tscn") or not FileAccess.file_exists(scene_path):
		return ids
	var read: Array[int] = []
	var pattern: RegEx = RegEx.create_from_string(" unique_id=(\\d+)")
	for line: String in FileAccess.get_file_as_string(scene_path).split("\n"):
		if line.begins_with("[node "):
			var found: RegExMatch = pattern.search(line)
			read.append(int(found.get_string(1)) if found != null else -1)
	return read if read.size() == count else ids


## Whether entry [param index] of [param state] only sets values on a node another file makes.
static func _overrides(state: SceneState, index: int) -> bool:
	return (
		state.get_node_instance(index) == null
		and not state.is_node_instance_placeholder(index)
		and str(state.get_node_type(index)).is_empty()
	)


## The node whose file owns what sits under [param parent]: the nearest instance at or above it, or
## [param prefix], the root of what is being laid, as the engine searches.
static func _owner_of(nodes: Dictionary, parent: String, prefix: String) -> String:
	var at: String = parent
	while at != prefix and at != "." and nodes.has(at):
		var entry: Dictionary = nodes[at]
		if entry.has("instanceOf"):
			break
		at = "." if not at.contains("/") else at.get_base_dir()
	return at if nodes.has(at) else prefix


## The path of the node [param owner] owns whose unique_id is [param id], or "": one under an instance
## nested below [param owner] belongs to that instance's file, whose ids are numbered apart.
static func _by_id(nodes: Dictionary, owner: String, id: int) -> String:
	for path: String in nodes:
		if path == owner or not (owner == "." or path.begins_with(owner + "/")):
			continue
		var entry: Dictionary = nodes[path]
		if GdhRead.as_int(entry.get("uniqueId", -1), -1) != id:
			continue
		var above: String = "." if not path.contains("/") else path.get_base_dir()
		if _owner_of(nodes, above, owner) == owner:
			return path
	return ""


static func _made(type: String) -> Dictionary:
	var children: Array[String] = []
	var groups: Array[String] = []
	return {"name": "", "type": type, "properties": {}, "children": children, "groups": groups}


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
		if node.has("editableChildren"):
			data["editableChildren"] = node["editableChildren"]
	# An inherited scene's file holds only what it changes, so the read says what it inherits and
	# which nodes come from there, as the editor greys them.
	if node.has("inherits"):
		data["inherits"] = node["inherits"]
	elif node.has("inheritedFrom"):
		data["inheritedFrom"] = node["inheritedFrom"]
	var groups: Array[String] = node["groups"]
	if not groups.is_empty():
		var sorted: Array[String] = groups.duplicate()
		sorted.sort()
		data["groups"] = sorted
	if include_properties:
		var given: Dictionary = node["properties"]
		data["properties"] = _stored(str(node["type"]), given)
		if not node.get("madeHere", false):
			var kept: Array = node.get("setHere", [])
			var set_here: Array = kept.duplicate()
			set_here.sort()
			data["setHere"] = set_here
	var below: Array[String] = node["children"]
	# Counted rather than left as an empty list, which reads as a node with no children.
	if depth >= 0 and current_depth >= depth:
		if not below.is_empty():
			data["childrenNotListed"] = below.size()
		return data
	for child: String in below:
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
			if not property.is_empty() and GdhRead.as_int(declared.get("usage", 0)) & PROPERTY_USAGE_STORAGE:
				scripted[property] = script.get_property_default_value(property)
	var values: Dictionary = {}
	if ClassDB.class_exists(type) and ClassDB.can_instantiate(type):
		var bare: Object = ClassDB.instantiate(type)
		for property: Variant in given:
			if property != "script" and not scripted.has(property):
				bare.set(str(property), given[property])
		for declared: Dictionary in bare.get_property_list():
			var property: String = str(declared.get("name", ""))
			if not property.is_empty() and GdhRead.as_int(declared.get("usage", 0)) & PROPERTY_USAGE_STORAGE:
				values[property] = bare.get(property)
		if bare is Node:
			bare.free()
	for property: String in scripted:
		values[property] = scripted[property]
	# Given last, which keeps what a bare node cannot hold: the script itself, and a path to a node
	# for a property that holds the node once it is in a tree.
	values.merge(given, true)
	var serialiser: GdhSerialisation = GdhSerialisation.new()
	var answered: Dictionary = {}
	for property: Variant in values:
		answered[property] = serialiser.serialize_value(values[property])
	return answered


## What a resource file holds, in the form modify takes, so a value read here can be written back.
## Read from the file rather than a cached copy, since the file is what the writes change and what
## the project loads.
##
## [param res_path] may name a resource kept inside a file, as "res://hero.tscn::Animation_jump",
## the path a property holding one is read back with.
static func resource(res_path: String, include_defaults: bool) -> Dictionary:
	var file: String = res_path.get_slice("::", 0)
	if not FileAccess.file_exists(file):
		return {"ok": false, "error": "No resource at " + file}
	var loaded: Resource = ResourceLoader.load(file, "", ResourceLoader.CACHE_MODE_IGNORE)
	if loaded == null:
		return {"ok": false, "error": "%s did not load as a resource." % file}
	if file != res_path:
		var id: String = res_path.trim_prefix(file + "::")
		var inner: Resource = _kept_in(loaded, file, id, {})
		if inner == null:
			return {"ok": false, "error": "%s keeps no resource with the id %s." % [file, id]}
		loaded = inner
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
	var serialiser: GdhSerialisation = GdhSerialisation.new()
	var properties: Dictionary = {}
	for p: Dictionary in loaded.get_property_list():
		var property: String = str(p.get("name", ""))
		if property.is_empty() or property == "script":
			continue
		if not (GdhRead.as_int(p.get("usage", 0)) & PROPERTY_USAGE_STORAGE):
			continue
		var value: Variant = loaded.get(property)
		if not include_defaults:
			var default: Variant = (
				script.get_property_default_value(property)
				if scripted.has(property)
				else ClassDB.class_get_property_default_value(loaded.get_class(), property)
			)
			if GdhSame.same(value, default):
				continue
		properties[property] = serialiser.serialize_value(value)
	var answer: Dictionary = {
		"ok": true, "resourcePath": res_path, "resourceType": loaded.get_class(), "properties": properties
	}
	if script != null:
		answer["script"] = script.resource_path
		# resourceType is the engine class under the script, which for a class the project declares
		# is Resource whatever create was given.
		var declared_class: String = str(script.get_global_name())
		if not declared_class.is_empty():
			answer["scriptClass"] = declared_class
	return answer


## The resource [param file] keeps under [param id], found in [param value] or anything it holds.
## The engine loads such a path only while the file is cached, and a read loads the file uncached,
## so it is looked for among what the file holds. A resource of another file is neither taken nor
## walked into: ids are unique only within one file, and a scene instancing another holds that
## file's resources under ids of the other file's.
static func _kept_in(value: Variant, file: String, id: String, seen: Dictionary) -> Resource:
	if value is Resource:
		var held: Resource = value
		if seen.has(held.get_instance_id()):
			return null
		seen[held.get_instance_id()] = true
		var at: String = held.resource_path
		if not at.is_empty() and at.get_slice("::", 0) != file:
			return null
		if held.resource_scene_unique_id == id:
			return held
		for p: Dictionary in held.get_property_list():
			if GdhRead.as_int(p.get("usage", 0)) & PROPERTY_USAGE_STORAGE:
				var found: Resource = _kept_in(held.get(str(p.get("name", ""))), file, id, seen)
				if found != null:
					return found
	elif value is Array:
		var items: Array = value
		for item: Variant in items:
			var found: Resource = _kept_in(item, file, id, seen)
			if found != null:
				return found
	elif value is Dictionary:
		var entries: Dictionary = value
		for key: Variant in entries:
			for side: Variant in [key, entries[key]]:
				var found: Resource = _kept_in(side, file, id, seen)
				if found != null:
					return found
	return null
