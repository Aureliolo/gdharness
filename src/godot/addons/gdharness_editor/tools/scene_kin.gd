@tool
extends RefCounted
## The two ways a scene keeps its own values for nodes another scene makes: by inheriting that
## scene, or by instancing it with its children editable.

const GdhFileReads = preload("../file_reads.gd")
const GdhFileWalk = preload("../file_walk.gd")
const GdhPaths = preload("scene_paths.gd")
const GdhSceneFile = preload("../scene_file.gd")
const GdhSceneUids = preload("../scene_uids.gd")


## Why a create at [param scene_path] is refused when a file is there already, which saving over
## would replace nodes and all.
static func taken(scene_path: String) -> Dictionary:
	return {
		"ok": false,
		"error":
		(
			(
				"%s already exists, and scene_create op=create would replace everything in it. "
				+ "Edit it with scene_node (op=change_type changes its root class), or "
				+ "create the scene under another path."
			)
			% scene_path
		),
	}


## scene_create for [param args] naming a scene to inherit: [param scene_path], [param base_path]
## and [param script_path] are the res:// paths it gives, the last "" when it gives no script.
static func inherited(
	args: Dictionary, scene_path: String, base_path: String, script_path: String
) -> Dictionary:
	if scene_path.is_empty():
		return { "ok": false, "error": "Missing scenePath" }
	if args.has("rootNodeType"):
		return {
			"ok": false,
			"error":
			(
				"inherits takes the root's class from %s, so rootNodeType is not given with it."
				% base_path
			),
		}
	if FileAccess.file_exists(scene_path):
		return taken(scene_path)
	var script: Script = null
	if not script_path.is_empty():
		var found: Variant = GdhSceneFile.script_at(script_path)
		if found is String:
			return { "ok": false, "error": found }
		script = found
		var uncompiled: String = GdhSceneFile.uncompiled(script, script_path)
		if not uncompiled.is_empty():
			return { "ok": false, "error": uncompiled }
	return inherit(scene_path, base_path, str(args.get("rootNodeName", "")), script)


## Writes [param scene_path] as a scene inheriting [param base_path], its root named
## [param root_name] (the base root's name when empty) and carrying [param script] when one is
## given. Answers what scene_create answers, or a refusal.
##
## Written as the text the editor's New Inherited Scene saves rather than packed from an instance of
## the base: a headless engine making that instance runs every script in the base, and the pack
## would keep what they set as this scene's own values.
static func inherit(
	scene_path: String, base_path: String, root_name: String, script: Script
) -> Dictionary:
	var base: Dictionary = GdhFileReads.scene_node(base_path, ".")
	if not base.get("ok", false):
		return {
			"ok": false,
			"error": "inherits: " + str(base.get("error", "%s holds no nodes" % base_path)),
		}
	var root_type: String = str(base["type"])
	var name: String = str(base["name"]) if root_name.is_empty() else root_name
	var unfit: String = GdhSceneFile.unfit_name(name)
	if not unfit.is_empty():
		return { "ok": false, "error": unfit }
	if script != null:
		var extended: String = str(script.get_instance_base_type())
		if not ClassDB.is_parent_class(root_type, extended):
			return {
				"ok": false,
				"error":
				(
					"%s extends %s, so it cannot be on the %s root %s inherits."
					% [script.resource_path, extended, root_type, base_path]
				),
			}
	var folder: String = GdhSceneFile.make_folder_for(scene_path)
	if not folder.is_empty():
		return { "ok": false, "error": folder }

	var lines: PackedStringArray = [
		'[gd_scene format=3 uid="%s"]' % ResourceUID.id_to_text(ResourceUID.create_id()),
		"",
		(
			'[ext_resource type="PackedScene"%s path="%s" id="1_base"]'
			% [GdhSceneUids.reference_uid(base_path), base_path]
		),
	]
	if script != null:
		var _resourced: bool = lines.append(
			(
				'[ext_resource type="Script"%s path="%s" id="2_script"]'
				% [GdhSceneUids.reference_uid(script.resource_path), script.resource_path]
			)
		)
	lines.append_array(["", '[node name="%s" instance=ExtResource("1_base")]' % name])
	if script != null:
		var _attached: bool = lines.append('script = ExtResource("2_script")')
	var file: FileAccess = FileAccess.open(scene_path, FileAccess.WRITE)
	if file == null or not file.store_string("\n".join(lines) + "\n"):
		return {
			"ok": false,
			"error":
			"Could not write %s: %s" % [scene_path, error_string(FileAccess.get_open_error())],
		}
	file.close()

	var loaded: PackedScene = ResourceLoader.load(
		scene_path, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE
	)
	var instanced: PackedScene = loaded.get_state().get_node_instance(0) if loaded != null else null
	if instanced == null or instanced.resource_path != base_path:
		var _removed: Error = DirAccess.remove_absolute(scene_path)
		return {
			"ok": false,
			"error":
			(
				"%s did not load back as a scene inheriting %s, so it was removed."
				% [scene_path, base_path]
			),
		}
	GdhSceneFile.refresh(scene_path)
	var answer: Dictionary = {
		"ok": true,
		"scenePath": scene_path,
		"inherits": base_path,
		"rootNodeType": root_type,
		"rootNodeName": name,
	}
	var properties: Dictionary = base["properties"]
	var carried: Variant = script if script != null else properties.get("script")
	if carried is Script:
		var carried_script: Script = carried
		answer["script"] = carried_script.resource_path
		if not str(carried_script.get_global_name()).is_empty():
			answer["scriptClass"] = str(carried_script.get_global_name())
	return answer


## Makes the children of [param node], an instance in [param scene], editable or not, answering why
## it cannot or "". With them editable the scene keeps its own values for them, as the editor's
## Editable Children does. Made not editable again, the values it kept for them are dropped. The
## caller has had [method GdhSceneFile.foreign] refuse a node inside an instance that is not
## editable.
static func set_editable(scene: GdhSceneFile, node: Node, editable: bool) -> String:
	if node.owner == null or node.scene_file_path.is_empty():
		return (
			"editableChildren is a setting of an instance in this scene, and %s is not one."
			% scene.path_of(node)
		)
	scene.root.set_editable_instance(node, editable)
	return ""


## Carries the move of a node of [param changed] from [param old_path] to [param new_path], both
## from its root, into each other text scene of the project that names the node by path: one that
## instances or inherits [param changed], at any depth. Its editable instances, its entries for the
## node and for what is below it (their names and parents), and its connections are rewritten to
## the new path. The engine finds
## a moved node's entries by its unique_id, but an editable instance only by its path, so a scene
## saved after the move lost the values it kept below one. The node paths each holds are carried
## into [param carried], which holds those of [param changed] already. With [param new_path] "",
## for a node deleted, the node paths are only named, and the entries are dropped as
## [method _without_vanished] says. Answers followed, the scenes rewritten, notFollowed, each one
## left as it was with why, and dropped, each only when it names any, with what [param carried]
## gives.
static func follow(
	changed: String, old_path: String, new_path: String, carried: GdhPaths
) -> Dictionary:
	var run: GdhFollow = GdhFollow.new(changed, old_path, new_path, carried)
	_read_scenes(run.texts)
	var kin: Array[String] = _kin_of(changed, run.texts)
	for scene_path: String in kin:
		_follow_scene(scene_path, run)
	var answer: Dictionary = carried.answer()
	if not run.followed.is_empty():
		answer["followed"] = run.followed
	if not run.not_followed.is_empty():
		answer["notFollowed"] = run.not_followed
	if not run.dropped.is_empty():
		answer["dropped"] = run.dropped
	return answer


## Follows the move into the scene at [param scene_path], which [param run] records.
static func _follow_scene(scene_path: String, run: GdhFollow) -> void:
	if scene_path == run.changed:
		return
	var read: Dictionary = GdhFileReads.scene_tree(scene_path, -1, false, false)
	if not read.get("ok", false):
		run.not_followed.append({ "scenePath": scene_path, "reason": str(read.get("error", "")) })
		return
	var tree: Dictionary = read["tree"]
	var moves: Dictionary = {}
	for at: String in _placements(scene_path, tree, run.changed, run.texts):
		var moved_to: String = "" if run.new_path.is_empty() else _under(at, run.new_path)
		moves[_under(at, run.old_path)] = moved_to
	var text: String = run.texts[scene_path]
	var unsaved: String = GdhSceneFile.unsaved_in_editor(scene_path)
	var vanished: Array[Dictionary] = []
	var rewritten: String = text
	if not run.new_path.is_empty():
		rewritten = _rewritten(
			text, moves, run.old_path.get_base_dir() != run.new_path.get_base_dir()
		)
	if run.new_path.is_empty() and not moves.is_empty():
		rewritten = _without_vanished(text, moves, scene_path, vanished)
	if rewritten != text:
		if not _store_scene(scene_path, rewritten, unsaved, run):
			return
		run.dropped.append_array(vanished)
	_carry_paths(scene_path, text, moves, unsaved, run)


## Writes [param rewritten] over the scene at [param scene_path] and records it as followed. Answers
## false, with the scene recorded as left, when [param unsaved] says the editor holds changes to it
## or the file cannot be written.
static func _store_scene(
	scene_path: String, rewritten: String, unsaved: String, run: GdhFollow
) -> bool:
	if not unsaved.is_empty():
		run.not_followed.append({ "scenePath": scene_path, "reason": unsaved })
		return false
	var file: FileAccess = FileAccess.open(scene_path, FileAccess.WRITE)
	if file == null or not file.store_string(rewritten):
		run.not_followed.append(
			{ "scenePath": scene_path, "reason": error_string(FileAccess.get_open_error()) }
		)
		return false
	file.close()
	GdhSceneFile.refresh(scene_path)
	run.followed.append(scene_path)
	return true


## Carries the node paths and script lines of the scene at [param scene_path], whose text is
## [param text], by [param moves].
static func _carry_paths(
	scene_path: String, text: String, moves: Dictionary, unsaved: String, run: GdhFollow
) -> void:
	var holds_paths: bool = text.contains("NodePath(")
	# A script is only read, for the lines naming the node, so it does not need the file
	# written.
	if moves.is_empty() or not (holds_paths or text.contains('Script"')):
		return
	if holds_paths and not unsaved.is_empty() and not run.new_path.is_empty():
		run.not_followed.append({ "scenePath": scene_path, "reason": unsaved })
		return
	var before: int = run.carried.retargeted.size()
	var unwritten: String = run.carried.carry_into(scene_path, moves)
	if not unwritten.is_empty() and not run.followed.has(scene_path):
		run.not_followed.append({ "scenePath": scene_path, "reason": unwritten })
	elif run.carried.retargeted.size() > before and not run.followed.has(scene_path):
		run.followed.append(scene_path)


## [param text] without the entries it kept for a node a delete took, or one below it, which
## [param moves] maps to "": the values it set there, a node it added there, its connections from
## or to one, and its mark making one editable. The engine skips each as it loads, with a warning
## on every load, and the editor's next save leaves it out. Each goes into [param dropped], as
## {scenePath, nodePath, entry}, with the signal and method of a connection.
static func _without_vanished(
	text: String, moves: Dictionary, scene_path: String, dropped: Array[Dictionary]
) -> String:
	var lines: PackedStringArray = text.split("\n")
	var kept: PackedStringArray = []
	var dropping: bool = false
	for at: int in lines.size():
		var line: String = lines[at]
		# The saver writes connections and editable marks one to a line with nothing between them,
		# and starts any other entry after an empty line, which a value running over several lines
		# does not.
		var one_line: bool = line.begins_with("[connection ") or line.begins_with("[editable ")
		if one_line or (line.begins_with("[") and (at == 0 or lines[at - 1].is_empty())):
			var record: Dictionary = _vanished(line, moves)
			dropping = not record.is_empty()
			if dropping:
				record["scenePath"] = scene_path
				dropped.append(record)
				# A node entry's values run on to its empty line, which goes with them.
				dropping = line.begins_with("[node ")
				continue
		elif dropping:
			if line.is_empty():
				dropping = false
			continue
		var _kept: bool = kept.push_back(line)
	return "\n".join(kept)


## The record of what [param line], an entry's first line, kept for a node [param moves] took, or
## an empty one when it names none.
static func _vanished(line: String, moves: Dictionary) -> Dictionary:
	if line.begins_with("[node ") and line.contains(' parent="'):
		var whole: String = _under(_attribute(line, "parent"), _attribute(line, "name"))
		if not _gone(whole, moves):
			return {}
		var made: bool = line.contains(" type=") or line.contains(" instance=")
		return { "nodePath": whole, "entry": "node" if made else "values" }
	if line.begins_with("[editable "):
		var path: String = _attribute(line, "path")
		return { "nodePath": path, "entry": "editable" } if _gone(path, moves) else {}
	if line.begins_with("[connection "):
		for end: String in ["from", "to"]:
			var path: String = _attribute(line, end)
			if _gone(path, moves):
				return {
					"nodePath": path,
					"entry": "connection",
					"signal": _attribute(line, "signal"),
					"method": _attribute(line, "method"),
				}
	return {}


## Whether [param path], a path from the root in the text's own spelling, is a node [param moves]
## deleted, or one below it.
static func _gone(path: String, moves: Dictionary) -> bool:
	return not path.is_empty() and GdhPaths.moved(path, moves).is_empty()


## Marks the instance a branch at [param at] in [param changed] became editable in every other
## .tscn that instances or inherits [param changed] at any depth, wherever that scene keeps values
## on a node inside it or adds one below it. Those still load, and the next save of that scene
## dropped them, since the packer skips every node under an instance whose children are not
## editable. Answers followed, the scenes marked, and notFollowed, each left with why, each only
## when it names any.
static func enclose(changed: String, at: String) -> Dictionary:
	var texts: Dictionary = {}
	_read_scenes(texts)
	var followed: Array[String] = []
	var not_followed: Array[Dictionary] = []
	for scene_path: String in _kin_of(changed, texts):
		if scene_path == changed:
			continue
		var read: Dictionary = GdhFileReads.scene_tree(scene_path, -1, false, false)
		if not read.get("ok", false):
			not_followed.append({ "scenePath": scene_path, "reason": str(read.get("error", "")) })
			continue
		var tree: Dictionary = read["tree"]
		var moves: Dictionary = {}
		for root: String in _placements(scene_path, tree, changed, texts):
			moves[_under(root, at)] = _under(root, at)
		var text: String = texts[scene_path]
		var marks: PackedStringArray = []
		for path: String in moves:
			var mark: String = '[editable path="%s"]' % path
			if not text.contains(mark) and _holds_below(text, path):
				var _marked: bool = marks.append(mark)
		if marks.is_empty():
			continue
		var unsaved: String = GdhSceneFile.unsaved_in_editor(scene_path)
		if not unsaved.is_empty():
			not_followed.append({ "scenePath": scene_path, "reason": unsaved })
			continue
		var file: FileAccess = FileAccess.open(scene_path, FileAccess.WRITE)
		if (file == null
				or not file.store_string(text.rstrip("\n") + "\n\n" + "\n".join(marks) + "\n")):
			not_followed.append(
				{ "scenePath": scene_path, "reason": error_string(FileAccess.get_open_error()) }
			)
			continue
		file.close()
		GdhSceneFile.refresh(scene_path)
		followed.append(scene_path)
	var answer: Dictionary = {}
	if not followed.is_empty():
		answer["followed"] = followed
	if not not_followed.is_empty():
		answer["notFollowed"] = not_followed
	return answer


## Whether [param text], a scene's file, has a node entry below [param path], one setting values on
## a node there or adding one.
static func _holds_below(text: String, path: String) -> bool:
	for line: String in text.split("\n"):
		if not line.begins_with("[node "):
			continue
		var parent: String = _attribute(line, "parent")
		if parent.is_empty():
			continue
		var full: String = _under(parent, _attribute(line, "name"))
		if full.begins_with(path + "/"):
			return true
	return false


## [param changed] and every scene in [param texts] that instances or inherits it at any depth.
static func _kin_of(changed: String, texts: Dictionary) -> Array[String]:
	var kin: Array[String] = [changed]
	var grew: bool = true
	while grew:
		grew = false
		for scene_path: String in texts:
			if kin.has(scene_path):
				continue
			var text: String = texts[scene_path]
			for one: String in kin:
				if text.contains(' path="%s"' % one):
					kin.append(scene_path)
					grew = true
					break
	return kin


## The text of every .tscn the engine scans into [param texts], keyed by res:// path. The shared
## walk leaves out the folders the engine steps over, so a build's copies are not read, and takes in
## the addons gdharness installed, which the engine loads.
static func _read_scenes(texts: Dictionary) -> void:
	for path: String in GdhFileWalk.new().find_files("res://", ".tscn", true):
		texts[path] = FileAccess.get_file_as_string(path)


## Whether the scene at [param scene_path] inherits [param changed], through any number of scenes.
static func _inherits(scene_path: String, changed: String, texts: Dictionary) -> bool:
	var seen: Array[String] = [scene_path]
	var base: String = _base_of(str(texts.get(scene_path, "")))
	while not base.is_empty() and not seen.has(base):
		if base == changed:
			return true
		seen.append(base)
		base = _base_of(str(texts.get(base, "")))
	return false


## The scene the root of [param text] inherits, or "": a root entry naming an instance and no
## parent.
static func _base_of(text: String) -> String:
	for line: String in text.split("\n"):
		if not line.begins_with("[node "):
			continue
		var instanced: RegExMatch = (
			RegEx.create_from_string('instance=ExtResource\\("([^"]+)"\\)').search(line)
		)
		if instanced == null or line.contains(" parent="):
			return ""
		var named: RegExMatch = (
			RegEx
			. create_from_string(
				'\\[ext_resource [^\\n]*path="([^"]+)" id="%s"\\]' % instanced.get_string(1)
			)
			. search(text)
		)
		return named.get_string(1) if named != null else ""
	return ""


## Every path in [param tree], the scene at [param scene_path], where the root of [param changed]
## sits, "." for the root: its own root when it inherits [param changed], and each instance of
## [param changed] or of a scene inheriting it. The tree lays out every instance inside another, so
## those are found by walking it.
static func _placements(
	scene_path: String, tree: Dictionary, changed: String, texts: Dictionary
) -> Array[String]:
	var placements: Array[String] = []
	if _inherits(scene_path, changed, texts):
		placements.append(".")
	_instances_in(tree, changed, texts, placements)
	return placements


static func _instances_in(
	entry: Dictionary, changed: String, texts: Dictionary, placements: Array[String]
) -> void:
	var instanced: String = str(entry.get("instanceOf", ""))
	if instanced == changed or (not instanced.is_empty() and _inherits(instanced, changed, texts)):
		placements.append(str(entry["path"]))
	var children: Array = entry.get("children", [])
	for child: Variant in children:
		if child is Dictionary:
			var below: Dictionary = child
			_instances_in(below, changed, texts, placements)


## [param text] with every path [param moves] names, and every path below one, moved.
##
## Beside a path the saver writes the unique_ids of the nodes along it, which the loader follows
## when the path has vanished. A rename leaves those ids as they were. With [param reparented] they
## run through the old parent, which still exists, so a recovery would find the wrong node. They are
## left out of each path moved, as a hand-written scene leaves them, and the next save writes them
## anew.
static func _rewritten(text: String, moves: Dictionary, reparented: bool) -> String:
	if moves.is_empty():
		return text
	var lines: PackedStringArray = text.split("\n")
	for at: int in lines.size():
		var line: String = lines[at]
		if line.begins_with("[editable "):
			line = _attribute_moved(line, "path", "", moves, reparented)
		elif line.begins_with("[connection "):
			line = _attribute_moved(line, "from", "from_uid_path", moves, reparented)
			line = _attribute_moved(line, "to", "to_uid_path", moves, reparented)
		elif line.begins_with("[node ") and line.contains(' parent="'):
			var parent: String = _attribute(line, "parent")
			var whole: String = _under(parent, _attribute(line, "name"))
			if moves.has(whole):
				var moved: String = moves[whole]
				var moved_parent: String = moved.get_base_dir()
				line = _attribute_set(line, "name", moved.get_file())
				var placed: String = _attribute_set(
					line, "parent", "." if moved_parent.is_empty() else moved_parent
				)
				line = (
					_without_ids(placed, "parent_id_path")
					if placed != line and reparented
					else placed
				)
			else:
				line = _attribute_moved(line, "parent", "parent_id_path", moves, reparented)
		lines[at] = line
	return "\n".join(lines)


## [param path] below [param at], a path in the text's own spelling, "." for the root.
static func _under(at: String, path: String) -> String:
	return path if at == "." else at + "/" + path


static func _attribute(line: String, attribute: String) -> String:
	var found: RegExMatch = RegEx.create_from_string(' %s="([^"]*)"' % attribute).search(line)
	return found.get_string(1) if found != null else ""


static func _attribute_set(line: String, attribute: String, value: String) -> String:
	var found: RegExMatch = RegEx.create_from_string(' %s="([^"]*)"' % attribute).search(line)
	if found == null:
		return line
	return line.substr(0, found.get_start(1)) + value + line.substr(found.get_end(1))


## [param line] with the path under [param attribute] moved by [param moves], and, when that moved
## it and the move was a reparent, without the ids under [param ids] that went along the old path.
static func _attribute_moved(
	line: String, attribute: String, ids: String, moves: Dictionary, reparented: bool
) -> String:
	var found: RegExMatch = RegEx.create_from_string(' %s="([^"]*)"' % attribute).search(line)
	if found == null:
		return line
	var moved: String = GdhPaths.moved(found.get_string(1), moves)
	if moved == found.get_string(1):
		return line
	var placed: String = _attribute_set(line, attribute, moved)
	return _without_ids(placed, ids) if reparented and not ids.is_empty() else placed


static func _without_ids(line: String, ids: String) -> String:
	return RegEx.create_from_string(" %s=PackedInt32Array\\([^)]*\\)" % ids).sub(line, "")


## What [method follow] works on and records: the move, the text of every scene, and the scenes
## followed, left as they were with why, and the entries dropped.
class GdhFollow:
	var changed: String
	var old_path: String
	var new_path: String
	var carried: GdhPaths
	var texts: Dictionary = {}
	var followed: Array[String] = []
	var not_followed: Array[Dictionary] = []
	var dropped: Array[Dictionary] = []


	func _init(
		changed_scene: String, from_path: String, to_path: String, paths: GdhPaths
	) -> void:
		changed = changed_scene
		old_path = from_path
		new_path = to_path
		carried = paths
