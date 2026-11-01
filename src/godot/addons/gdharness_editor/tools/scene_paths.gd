@tool
extends RefCounted
## The node paths scenes hold, carried after a node moves as the editor's own rename carries them:
## the NodePath values on their nodes, inside arrays, dictionaries and the resources built into the
## scene too, and the tracks of the animations their players play. After a delete they are named
## rather than changed, since what they named is gone and dropping a track would lose its keys.
##
## A path is worked out from where its holder was and where it pointed before the move, so it is
## followed in a scene loaded after the move as well, where the old path no longer resolves.

enum {
	UNCHANGED,
	REWRITTEN,
	DELETED,
}

const GdhHeadlessCheck = preload("../headless_check.gd")
const GdhRead = preload("../reading.gd")
const GdhSceneFile = preload("../scene_file.gd")
const GdhSceneUids = preload("../scene_uids.gd")
const GdhScriptPaths = preload("script_paths.gd")
## PROPERTY_HINT_NO_NODEPATH, which marks a property the editor's rename skips. It is not bound for
## scripts, and follows PROPERTY_HINT_ONESHOT in the engine's list.
const HINT_NO_NODEPATH: int = PROPERTY_HINT_ONESHOT + 1

## Each path rewritten, as {scenePath, nodePath, property or animation and track, from, to}.
var retargeted: Array[Dictionary] = []
## Each path that needed rewriting and was left, with why.
var not_retargeted: Array[Dictionary] = []
## Each path naming a deleted node, or a node below one, which now names nothing.
var still_naming: Array[Dictionary] = []
## Each line of a script on a node naming a node that moved or went by the path it had, as
## {scenePath, nodePath, script, line, from, to}, to absent for a deleted node. Code is left as it
## was, as the editor's own rename leaves it.
var scripts_naming: Array[Dictionary] = []
## The script lines already named, so one shared by an instance and its scene is named once.
var _lines: Dictionary = {}
## The paths each script names, by the script, read once however many nodes it is on.
var _named_in: Dictionary = {}
## The files beside a scene holding a rewritten track, each to the resource saved there.
var _homes: Dictionary = {}
## Each track rewritten in an animation one of [member _homes] keeps, as [animation, track, the path
## it had, its record, the file]. The editor shares such a resource with every scene using it, so a
## rewrite that is not saved is put back.
var _outside: Array[Array] = []
var _scene: GdhSceneFile = null
var _moves: Dictionary = {}
var _back: Dictionary = {}
var _seen: Dictionary = {}


## Where [param given] went under [param moves], each path a node was at to where it is now or ""
## when it was deleted: to where a path it names went, or below it.
static func moved(given: String, moves: Dictionary) -> String:
	for old: String in moves:
		var now: String = moves[old]
		if given == old:
			return now
		if given.begins_with(old + "/"):
			return "" if now.is_empty() else now + given.substr(old.length())
	return given


## Carries [param moves], from the root of [param scene], into the paths it holds. Called after the
## move and before the write. Answers how many paths it rewrote.
func carry(scene: GdhSceneFile, moves: Dictionary) -> int:
	if moves.is_empty():
		return 0
	_scene = scene
	_moves = moves
	_back = {}
	for old: String in moves:
		if not str(moves[old]).is_empty():
			_back[moves[old]] = old
	var before: int = retargeted.size()
	var nodes: Array[Node] = [scene.root]
	while not nodes.is_empty():
		var node: Node = nodes.pop_back()
		var children: Array[Node] = node.get_children()
		children.reverse()
		nodes.append_array(children)
		if not scene.foreign(node).is_empty():
			continue
		var now: String = scene.path_of(node)
		var was: String = moved(now, _back)
		# A value another file gives is in that file's terms, which its own pass carried already.
		var from: String = scene.values_from(node, was)
		var set_here: Dictionary = scene.set_at(was) if not from.is_empty() else {}
		var read_here: bool = not from.is_empty()
		for property: Dictionary in node.get_property_list():
			var name: String = str(property["name"])
			if not _may_hold_paths(property):
				continue
			var entry: Dictionary = { "scenePath": scene.path, "nodePath": now, "property": name }
			if _names_nodes(property):
				if not read_here:
					set_here = scene.set_at(was)
					read_here = true
				_carry_nodes(node, name, set_here.get(name), was, now, entry)
				continue
			var elsewhere: String = "" if set_here.has(name) else from
			var carried: Array = _carried(node.get(name), was, now, entry, elsewhere)
			if carried[0]:
				scene.asked(node, [name])
				node.set(name, carried[1])
		var mixer: AnimationMixer = node as AnimationMixer
		if mixer != null:
			_tracks(mixer, now)
		_scripts(node, was, now)
	return retargeted.size() - before


## Opens [param scene_path], carries [param moves] into it, and writes it when that rewrote a path.
## Answers "" or why it was left as it was.
func carry_into(scene_path: String, moves: Dictionary) -> String:
	var scene: GdhSceneFile = GdhSceneFile.new()
	var refused: Dictionary = scene.open(scene_path, true)
	if not refused.is_empty():
		return str(refused.get("error", ""))
	if carry(scene, moves) == 0:
		scene.close()
		return ""
	var written: Dictionary = scene.write()
	if written.is_empty():
		return ""
	var why: String = str(written.get("error", ""))
	put_back(scene_path, why)
	return why


## Undoes what was carried into [param scene_path] where it outlives the scene's own nodes, in the
## animations kept beside it, for a scene that was not written. With [param why], the paths
## rewritten there move to notRetargeted with it.
func put_back(scene_path: String, why: String = "") -> void:
	var _undone: Array[Dictionary] = _put_back(
		func(record: Dictionary) -> bool: return record["scenePath"] == scene_path
	)
	for record: Dictionary in retargeted.duplicate():
		if record["scenePath"] == scene_path:
			retargeted.erase(record)
			if not why.is_empty():
				not_retargeted.append(_left(record, why))


## The fields an answer gives for what was carried, each only when it names any, once the files
## beside the scenes holding rewritten tracks are saved. The tracks of a file that does not save are
## put back and move to notRetargeted.
func answer() -> Dictionary:
	for file: String in _homes:
		var resource: Resource = _homes[file]
		var saving: Error = GdhSceneUids.save_keeping_uid(resource, file)
		if saving == OK:
			if Engine.is_editor_hint():
				EditorInterface.get_resource_filesystem().update_file(file)
			continue
		var why: String = "Failed to save %s: %s" % [file, error_string(saving)]
		for record: Dictionary in _put_back(func(_record: Dictionary) -> bool: return false, file):
			retargeted.erase(record)
			not_retargeted.append(_left(record, why))
	_homes.clear()
	_outside.clear()
	var fields: Dictionary = {}
	if not retargeted.is_empty():
		fields["retargeted"] = retargeted
	if not not_retargeted.is_empty():
		fields["notRetargeted"] = not_retargeted
	if not still_naming.is_empty():
		fields["stillNaming"] = still_naming
	if not scripts_naming.is_empty():
		fields["scriptsNaming"] = scripts_naming
	return fields


## Names each line of the scripts on [param node], its own and those it extends, that names from
## where the node was a node the move took, by the path that no longer reaches it.
func _scripts(node: Node, was: String, now: String) -> void:
	var script: Script = node.get_script()
	while script is GDScript:
		var file: String = script.resource_path
		if not _named_in.has(script):
			var source: String = script.source_code
			if source.is_empty() and FileAccess.file_exists(file):
				source = FileAccess.get_file_as_string(file)
			_named_in[script] = GdhScriptPaths.named(source)
		var listed: Array[Dictionary] = _named_in[script]
		for named: Dictionary in listed:
			var path: String = named["path"]
			var key: String = "%s:%d:%s" % [file, named["line"], path]
			if _lines.has(key):
				continue
			var after: Array = _after(NodePath(path), was, now)
			if after[0] == UNCHANGED:
				continue
			_lines[key] = true
			var record: Dictionary = {
				"scenePath": _scene.path,
				"nodePath": now,
				"script": file,
				"line": named["line"],
				"from": path,
			}
			if after[0] == REWRITTEN:
				record["to"] = after[1]
			scripts_naming.append(record)
		script = script.get_base_script()


## Puts back each track rewritten outside the scene whose record [param matching] takes, or that is
## kept in [param file], and answers their records. A file left with none is not saved.
func _put_back(matching: Callable, file: String = "") -> Array[Dictionary]:
	var records: Array[Dictionary] = []
	var kept: Array[Array] = []
	for edit: Array in _outside:
		var record: Dictionary = edit[3]
		if edit[4] != file and not matching.call(record):
			kept.append(edit)
			continue
		var animation: Animation = edit[0]
		var track: int = edit[1]
		var had: NodePath = edit[2]
		animation.track_set_path(track, had)
		records.append(record)
	_outside = kept
	for home: String in _homes.keys():
		if not _outside.any(func(edit: Array) -> bool: return edit[4] == home):
			var _dropped: bool = _homes.erase(home)
	return records


## [param record] of a path that was not rewritten after all, with why.
static func _left(record: Dictionary, why: String) -> Dictionary:
	var left: Dictionary = record.duplicate()
	var _had_one: bool = left.erase("to")
	left["reason"] = why
	return left


## Whether [param property] can hold a node path the editor's rename would follow: one saved or
## shown, of a type that holds paths, and not marked as holding none.
static func _may_hold_paths(property: Dictionary) -> bool:
	if not GdhRead.as_int(property.get("usage")) & (PROPERTY_USAGE_STORAGE | PROPERTY_USAGE_EDITOR):
		return false
	if GdhRead.as_int(property.get("hint")) == HINT_NO_NODEPATH:
		return false
	return [TYPE_OBJECT, TYPE_NODE_PATH, TYPE_ARRAY, TYPE_DICTIONARY].has(
		GdhRead.as_int(property.get("type"))
	)


## Whether [param property] is typed as a node, or as an array or dictionary of nodes. It holds the
## nodes themselves, and the pack writes the path to each as it saves.
static func _names_nodes(property: Dictionary) -> bool:
	var hint: int = GdhRead.as_int(property.get("hint"))
	match GdhRead.as_int(property.get("type")):
		TYPE_OBJECT:
			return hint == PROPERTY_HINT_NODE_TYPE
		TYPE_ARRAY, TYPE_DICTIONARY:
			return (
				hint == PROPERTY_HINT_TYPE_STRING
				and str(property.get("hint_string", "")).contains(
					"%d/%d:" % [TYPE_OBJECT, PROPERTY_HINT_NODE_TYPE]
				)
			)
	return false


## Carries the property [param name] of [param node], typed as nodes, from [param held], the paths
## the file gives it. The nodes it holds moved with the move, so only what the file held is named.
## Marking it asked lets the write save the new paths the pack gives. A node the move deleted is
## cleared, as the editor's save clears it, since no path reaches it.
func _carry_nodes(
	node: Node, name: String, held: Variant, was: String, now: String, entry: Dictionary
) -> void:
	var naming: int = still_naming.size()
	var carried: Array = _carried(held, was, now, entry, "")
	if still_naming.size() > naming:
		for index: int in range(naming, still_naming.size()):
			still_naming[index]["cleared"] = true
		_scene.asked(node, [name])
		node.set(name, _unfreed(node.get(name)))
	elif carried[0]:
		_scene.asked(node, [name])


## [param value] with each freed node in it as null.
static func _unfreed(value: Variant) -> Variant:
	if typeof(value) == TYPE_OBJECT:
		return value if is_instance_valid(value) else null
	if typeof(value) == TYPE_ARRAY:
		var items: Array = value
		items = items.duplicate()
		for index: int in items.size():
			items[index] = _unfreed(items[index])
		return items
	if typeof(value) == TYPE_DICTIONARY:
		var pairs: Dictionary = value
		pairs = pairs.duplicate()
		for key: Variant in pairs.keys():
			pairs[key] = _unfreed(pairs[key])
		return pairs
	return value


## [param value], held by the node that was at [param was] and is at [param now], with each path in
## it carried, as [whether any was, the value]. A resource built into the scene is changed in place.
## [param entry] says where the value is held, for the record of each path. A path in a resource may
## be relative to something other than its holder, as the editor allows. It is followed only when it
## names a node from where its holder was, as one relative to the holder does. A value
## [param elsewhere], a file other than the scene's, gives is named only when it names nothing since
## the move, which its own file's pass could not see.
func _carried(
	value: Variant, was: String, now: String, entry: Dictionary, elsewhere: String
) -> Array:
	match typeof(value):
		TYPE_NODE_PATH:
			var path: NodePath = value
			var after: Array = _after(path, was, now)
			var record: Dictionary = entry.duplicate()
			record["from"] = str(path)
			if not elsewhere.is_empty():
				if after[0] == REWRITTEN and _names_nothing(path, now):
					not_retargeted.append(
						_left(
							record,
							(
								"The value is set in %s, and an edit here would not be saved there."
								% elsewhere
							)
						)
					)
			elif after[0] == DELETED:
				still_naming.append(record)
			elif after[0] == REWRITTEN:
				record["to"] = after[1]
				retargeted.append(record)
				return [true, NodePath(str(after[1]))]
		TYPE_ARRAY:
			var items: Array = value
			var changed: bool = false
			for index: int in items.size():
				var carried: Array = _carried(items[index], was, now, entry, elsewhere)
				if carried[0]:
					if not changed:
						items = items.duplicate()
						changed = true
					items[index] = carried[1]
			return [changed, items]
		TYPE_DICTIONARY:
			var pairs: Dictionary = value
			var changed: bool = false
			for key: Variant in pairs.keys():
				var carried: Array = _carried(pairs[key], was, now, entry, elsewhere)
				if carried[0]:
					if not changed:
						pairs = pairs.duplicate()
						changed = true
					pairs[key] = carried[1]
			return [changed, pairs]
		TYPE_OBJECT:
			var held: Object = value
			# The editor leaves animations to the tracks below, and materials for what it costs.
			if not held is Resource or held is Animation or held is Material:
				return [false, value]
			var resource: Resource = held
			var file: String = resource.resource_path.get_slice("::", 0)
			if not elsewhere.is_empty() or (not file.is_empty() and file != _scene.path):
				return [false, value]
			var reached: bool = false
			for property: Dictionary in resource.get_property_list():
				var name: String = str(property["name"])
				if not _may_hold_paths(property):
					continue
				var carried: Array = _carried(resource.get(name), was, now, entry, "")
				if carried[0]:
					resource.set(name, carried[1])
					reached = true
			if reached:
				_scene.reached_into(resource)
	return [false, value]


## What [param path], held by the node that was at [param was] and is at [param now], becomes, as
## [UNCHANGED, ""], [REWRITTEN, the new path] or [DELETED, ""].
func _after(path: NodePath, was: String, now: String) -> Array:
	if path.is_empty() or path.is_absolute() or path.get_name_count() == 0:
		return [UNCHANGED, ""]
	var names: PackedStringArray = []
	for index: int in path.get_name_count():
		var _named: bool = names.append(str(path.get_name(index)))
	var start: String = was
	var unique: bool = names[0].begins_with("%")
	if unique:
		start = _unique_was(names[0].substr(1), now)
		if start.is_empty():
			return [UNCHANGED, ""]
		names = names.slice(1)
	var target_was: String = _walked(start, names)
	if target_was.is_empty():
		return [UNCHANGED, ""]
	var target_now: String = moved(target_was, _moves)
	if target_now == target_was and now == was:
		return [UNCHANGED, ""]
	if target_now.is_empty():
		return [DELETED, ""]
	var holder: Node = _scene.root.get_node_or_null(now)
	var target: Node = _scene.root.get_node_or_null(target_now)
	if holder == null or target == null:
		return [UNCHANGED, ""]
	if holder.get_node_or_null(NodePath(path.get_concatenated_names())) == target:
		return [UNCHANGED, ""]
	var to: String = str(holder.get_path_to(target, unique))
	if unique:
		to = _unique_to(start, target, to)
	if path.get_subname_count() > 0:
		to += ":" + path.get_concatenated_subnames()
	return [REWRITTEN, to]


## Whether [param path], held by the node at [param now], names no node.
func _names_nothing(path: NodePath, now: String) -> bool:
	var holder: Node = _scene.root.get_node_or_null(now)
	return (
		holder != null and holder.get_node_or_null(NodePath(path.get_concatenated_names())) == null
	)


## The path to [param target] through the unique node that was at [param start], written through its
## unique name as the path being carried was, or [param otherwise] when it is no longer unique. The
## engine's own unique path is given only from a node with the same owner, so never from the root.
func _unique_to(start: String, target: Node, otherwise: String) -> String:
	var through: Node = _scene.root.get_node_or_null(moved(start, _moves))
	if through == null or not through.unique_name_in_owner:
		return otherwise
	var rest: String = str(through.get_path_to(target))
	return "%" + through.name + ("" if rest == "." else "/" + rest)


## Where the node a path held by the node at [param now] names as %[param name] was: one marked
## unique in the same owner that had that name before the move, or a deleted one that had it.
func _unique_was(name: String, now: String) -> String:
	var holder: Node = _scene.root.get_node_or_null(now)
	if holder == null:
		return ""
	var scope: Node = holder
	if holder.owner != null:
		scope = holder.owner
	var nodes: Array[Node] = [_scene.root]
	while not nodes.is_empty():
		var node: Node = nodes.pop_back()
		nodes.append_array(node.get_children())
		if node.unique_name_in_owner and node.owner == scope:
			var was: String = moved(_scene.path_of(node), _back)
			if was.get_file() == name:
				return was
	for old: String in _moves:
		if str(_moves[old]).is_empty() and old.get_file() == name:
			return old
	return ""


## The path from the root reached by walking [param names] from [param start], or "" when they
## climb out of the scene.
static func _walked(start: String, names: PackedStringArray) -> String:
	var parts: PackedStringArray = []
	if start != ".":
		parts = start.split("/")
	for name: String in names:
		if name == "..":
			if parts.is_empty():
				return ""
			parts.remove_at(parts.size() - 1)
		elif name != ".":
			var _added: bool = parts.append(name)
	return "." if parts.is_empty() else "/".join(parts)


## Carries the moves into the tracks of the animations [param mixer], at [param now], plays, which
## name nodes from its root node. That is read once the mixer's own root_node is carried, so it is
## the node the tracks were written against. An AnimationTree playing an AnimationPlayer's
## animations leaves them to the player. A track in a file nothing here writes is named only when it
## names nothing since the move, as a value another file gives is.
func _tracks(mixer: AnimationMixer, now: String) -> void:
	if mixer is AnimationTree:
		var tree: AnimationTree = mixer
		if tree.get_node_or_null(tree.anim_player) is AnimationPlayer:
			return
	var root: Node = mixer.get_node_or_null(mixer.root_node)
	if root == null:
		return
	var root_now: String = _scene.path_of(root)
	var root_was: String = moved(root_now, _back)
	for library_name: StringName in mixer.get_animation_library_list():
		var library: AnimationLibrary = mixer.get_animation_library(library_name)
		for animation_name: StringName in library.get_animation_list():
			var animation: Animation = library.get_animation(animation_name)
			var home: Dictionary = _home_of(animation, library)
			var why: String = home["why"]
			# Carried once, from the first scene playing it. One kept in a file of its own that this
			# call rewrote is held in _homes, so a later scene loading that file is given this same
			# copy.
			if _seen.has(animation):
				continue
			_seen[animation] = true
			var named: String = (
				str(animation_name)
				if str(library_name).is_empty()
				else "%s/%s" % [library_name, animation_name]
			)
			for track: int in animation.get_track_count():
				if animation.track_is_imported(track):
					continue
				var path: NodePath = animation.track_get_path(track)
				var after: Array = _after(path, root_was, root_now)
				var record: Dictionary = {
					"scenePath": _scene.path,
					"nodePath": now,
					"animation": named,
					"track": track,
					"from": str(path),
				}
				if home.get("theirs", false):
					if after[0] == REWRITTEN and _names_nothing(path, root_now):
						not_retargeted.append(_left(record, why))
				elif after[0] == DELETED:
					still_naming.append(record)
				elif after[0] == REWRITTEN and not why.is_empty():
					not_retargeted.append(_left(record, why))
				elif after[0] == REWRITTEN:
					var file: String = home["file"]
					if file.is_empty():
						_scene.reached_into(animation)
					else:
						_homes[file] = home["home"]
						_outside.append([animation, track, path, record, file])
					animation.track_set_path(track, NodePath(str(after[1])))
					record["to"] = after[1]
					retargeted.append(record)


## Where an edit to [param animation], played from [param library], is saved, as {file, home, why,
## theirs}: file "" with the scene, or the file of its own it or its library is kept in, with home
## the resource saved there, why when nothing written here would keep the edit, and theirs when that
## is because it is kept in another scene or an imported file, whose tracks are written in its
## terms.
func _home_of(animation: Animation, library: AnimationLibrary) -> Dictionary:
	var file: String = animation.resource_path.get_slice("::", 0)
	if file.is_empty() or file == _scene.path:
		return { "file": "", "why": "" }
	var home: Resource = animation
	if animation.resource_path.contains("::"):
		home = library if library.resource_path == file else null
	if home == null or not FileAccess.file_exists(file) or FileAccess.file_exists(file + ".import"):
		return {
			"why": "The animation is kept in %s, and an edit here would not be saved there." % file,
			"theirs": true,
		}
	if not Engine.is_editor_hint():
		var script: Script = home.get_script()
		if (
			(script != null and not script.is_tool())
			or GdhHeadlessCheck.holds_scripted_embedded(home, {})
		):
			return {
				"why":
				(
					(
						(
							"%s holds a resource with a script that is not a tool, which a "
							+ "headless engine runs as it loads the file. "
						)
						% file
					)
					+ GdhHeadlessCheck.REMEDY
				),
			}
	return { "file": file, "home": home, "why": "" }
