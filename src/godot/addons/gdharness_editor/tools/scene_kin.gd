@tool
extends RefCounted

## The two ways a scene keeps its own values for nodes another scene makes: by inheriting that scene,
## or by instancing it with its children editable.

const FileReads = preload("../file_reads.gd")
const SceneFile = preload("../scene_file.gd")


## Why a create at [param scene_path] is refused when a file is there already, which saving over
## would replace nodes and all.
static func taken(scene_path: String) -> Dictionary:
	return {
		"ok": false,
		"error":
		(
			(
				"%s already exists, and scene_create op=create would replace everything in it. Edit it "
				+ "with scene_node, or create the scene under another path."
			)
			% scene_path
		)
	}


## scene_create for [param args] naming a scene to inherit: [param scene_path], [param base_path]
## and [param script_path] are the res:// paths it gives, the last "" when it gives no script.
static func inherited(
	args: Dictionary, scene_path: String, base_path: String, script_path: String
) -> Dictionary:
	if scene_path.is_empty():
		return {"ok": false, "error": "Missing scenePath"}
	if args.has("rootNodeType"):
		return {
			"ok": false,
			"error":
			"inherits takes the root's class from %s, so rootNodeType is not given with it." % base_path
		}
	if FileAccess.file_exists(scene_path):
		return taken(scene_path)
	var script: Script = null
	if not script_path.is_empty():
		script = load(script_path) as Script
		if script == null:
			return {"ok": false, "error": "No script loads from " + script_path}
		var uncompiled: String = SceneFile.uncompiled(script, script_path)
		if not uncompiled.is_empty():
			return {"ok": false, "error": uncompiled}
	return inherit(scene_path, base_path, str(args.get("rootNodeName", "")), script)


## Writes [param scene_path] as a scene inheriting [param base_path], its root named
## [param root_name] (the base root's name when empty) and carrying [param script] when one is
## given. Answers what scene_create answers, or a refusal.
##
## Written as the text the editor's New Inherited Scene saves rather than packed from an instance of
## the base: a headless engine making that instance runs every script in the base, and the pack would
## keep what they set as this scene's own values.
static func inherit(scene_path: String, base_path: String, root_name: String, script: Script) -> Dictionary:
	var base: Dictionary = FileReads.scene_node(base_path, ".")
	if not base.get("ok", false):
		return {"ok": false, "error": "inherits: " + str(base.get("error", "%s holds no nodes" % base_path))}
	var root_type: String = str(base["type"])
	var name: String = str(base["name"]) if root_name.is_empty() else root_name
	var unfit: String = SceneFile.unfit_name(name)
	if not unfit.is_empty():
		return {"ok": false, "error": unfit}
	if script != null:
		var extended: String = str(script.get_instance_base_type())
		if not ClassDB.is_parent_class(root_type, extended):
			return {
				"ok": false,
				"error":
				(
					"%s extends %s, so it cannot be on the %s root %s inherits."
					% [script.resource_path, extended, root_type, base_path]
				)
			}
	var folder: String = SceneFile.make_folder_for(scene_path)
	if not folder.is_empty():
		return {"ok": false, "error": folder}

	var lines: PackedStringArray = [
		'[gd_scene format=3 uid="%s"]' % ResourceUID.id_to_text(ResourceUID.create_id()),
		"",
		(
			'[ext_resource type="PackedScene"%s path="%s" id="1_base"]'
			% [SceneFile.reference_uid(base_path), base_path]
		),
	]
	if script != null:
		var _resourced: bool = lines.append(
			(
				'[ext_resource type="Script"%s path="%s" id="2_script"]'
				% [SceneFile.reference_uid(script.resource_path), script.resource_path]
			)
		)
	lines.append_array(["", '[node name="%s" instance=ExtResource("1_base")]' % name])
	if script != null:
		var _attached: bool = lines.append('script = ExtResource("2_script")')
	var file: FileAccess = FileAccess.open(scene_path, FileAccess.WRITE)
	if file == null or not file.store_string("\n".join(lines) + "\n"):
		return {
			"ok": false,
			"error": "Could not write %s: %s" % [scene_path, error_string(FileAccess.get_open_error())]
		}
	file.close()

	var loaded: PackedScene = ResourceLoader.load(scene_path, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE)
	var instanced: PackedScene = loaded.get_state().get_node_instance(0) if loaded != null else null
	if instanced == null or instanced.resource_path != base_path:
		var _removed: Error = DirAccess.remove_absolute(scene_path)
		return {
			"ok": false,
			"error":
			"%s did not load back as a scene inheriting %s, so it was removed." % [scene_path, base_path]
		}
	SceneFile.refresh(scene_path)
	return {
		"ok": true,
		"scenePath": scene_path,
		"inherits": base_path,
		"rootNodeType": root_type,
		"rootNodeName": name
	}


## Makes the children of [param node], an instance in [param scene], editable or not, answering why
## it cannot or "". With them editable the scene keeps its own values for them, as the editor's
## Editable Children does; made not editable again, the values it kept for them are dropped. The
## caller has had [method SceneFile.foreign] refuse a node inside an instance that is not editable.
static func set_editable(scene: SceneFile, node: Node, editable: bool) -> String:
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
## node and for what is below it, and its connections are rewritten to the new path. The engine finds
## a moved node's entries by its unique_id, but an editable instance only by its path, so a scene
## saved after the move lost the values it kept below one. Answers followed, the scenes rewritten,
## and notFollowed, each one left as it was with why, each only when it names any.
static func follow(changed: String, old_path: String, new_path: String) -> Dictionary:
	var texts: Dictionary = {}
	_read_scenes("res://", texts)
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
	var followed: Array[String] = []
	var not_followed: Array[Dictionary] = []
	for scene_path: String in kin:
		if scene_path == changed:
			continue
		var moves: Dictionary = {}
		if _inherits(scene_path, changed, texts):
			moves[old_path] = new_path
		var read: Dictionary = FileReads.scene_tree(scene_path, -1, false)
		if not read.get("ok", false):
			not_followed.append({"scenePath": scene_path, "reason": str(read.get("error", ""))})
			continue
		var tree: Dictionary = read["tree"]
		_instances_of(tree, changed, old_path, new_path, moves)
		var text: String = texts[scene_path]
		var rewritten: String = _rewritten(text, moves)
		if rewritten == text:
			continue
		var unsaved: String = SceneFile.unsaved_in_editor(scene_path)
		if not unsaved.is_empty():
			not_followed.append({"scenePath": scene_path, "reason": unsaved})
			continue
		var file: FileAccess = FileAccess.open(scene_path, FileAccess.WRITE)
		if file == null or not file.store_string(rewritten):
			not_followed.append(
				{"scenePath": scene_path, "reason": error_string(FileAccess.get_open_error())}
			)
			continue
		file.close()
		SceneFile.refresh(scene_path)
		followed.append(scene_path)
	var answer: Dictionary = {}
	if not followed.is_empty():
		answer["followed"] = followed
	if not not_followed.is_empty():
		answer["notFollowed"] = not_followed
	return answer


## The text of every .tscn under [param directory] into [param texts], keyed by res:// path, leaving
## out the engine's own folder and hidden ones.
static func _read_scenes(directory: String, texts: Dictionary) -> void:
	for name: String in DirAccess.get_directories_at(directory):
		if not name.begins_with("."):
			_read_scenes(directory.path_join(name), texts)
	for name: String in DirAccess.get_files_at(directory):
		if name.ends_with(".tscn"):
			texts[directory.path_join(name)] = FileAccess.get_file_as_string(directory.path_join(name))


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


## The scene the root of [param text] inherits, or "": a root entry naming an instance and no parent.
static func _base_of(text: String) -> String:
	for line: String in text.split("\n"):
		if not line.begins_with("[node "):
			continue
		var instanced: RegExMatch = RegEx.create_from_string('instance=ExtResource\\("([^"]+)"\\)').search(
			line
		)
		if instanced == null or line.contains(" parent="):
			return ""
		var named: RegExMatch = (
			RegEx
			. create_from_string('\\[ext_resource [^\\n]*path="([^"]+)" id="%s"\\]' % instanced.get_string(1))
			. search(text)
		)
		return named.get_string(1) if named != null else ""
	return ""


## Into [param moves], the path below each instance of [param changed] in [param entry]'s tree that
## [param old_path] was at, with where it is now.
static func _instances_of(
	entry: Dictionary, changed: String, old_path: String, new_path: String, moves: Dictionary
) -> void:
	if str(entry.get("instanceOf", "")) == changed:
		var at: String = str(entry["path"])
		moves[_under(at, old_path)] = _under(at, new_path)
	var children: Array = entry.get("children", [])
	for child: Variant in children:
		if child is Dictionary:
			var below: Dictionary = child
			_instances_of(below, changed, old_path, new_path, moves)


## [param text] with every path [param moves] names, and every path below one, moved.
static func _rewritten(text: String, moves: Dictionary) -> String:
	if moves.is_empty():
		return text
	var lines: PackedStringArray = text.split("\n")
	for at: int in lines.size():
		var line: String = lines[at]
		if line.begins_with("[editable "):
			line = _attribute_moved(line, "path", moves)
		elif line.begins_with("[connection "):
			line = _attribute_moved(_attribute_moved(line, "from", moves), "to", moves)
		elif line.begins_with("[node ") and line.contains(' parent="'):
			var parent: String = _attribute(line, "parent")
			var whole: String = _under(parent, _attribute(line, "name"))
			if moves.has(whole):
				var moved: String = moves[whole]
				var moved_parent: String = moved.get_base_dir()
				line = _attribute_set(line, "name", moved.get_file())
				line = _attribute_set(line, "parent", "." if moved_parent.is_empty() else moved_parent)
			else:
				line = _attribute_moved(line, "parent", moves)
		lines[at] = line
	return "\n".join(lines)


## [param path] below [param at], a path in the text's own spelling, "." for the root.
static func _under(at: String, path: String) -> String:
	return path if at == "." else at + "/" + path


## [param given] moved by [param moves]: to where a path it names went, or below it.
static func _moved(given: String, moves: Dictionary) -> String:
	for old: String in moves:
		if given == old:
			return moves[old]
		if given.begins_with(old + "/"):
			return str(moves[old]) + given.substr(old.length())
	return given


static func _attribute(line: String, attribute: String) -> String:
	var found: RegExMatch = RegEx.create_from_string(' %s="([^"]*)"' % attribute).search(line)
	return found.get_string(1) if found != null else ""


static func _attribute_set(line: String, attribute: String, value: String) -> String:
	var found: RegExMatch = RegEx.create_from_string(' %s="([^"]*)"' % attribute).search(line)
	if found == null:
		return line
	return line.substr(0, found.get_start(1)) + value + line.substr(found.get_end(1))


static func _attribute_moved(line: String, attribute: String, moves: Dictionary) -> String:
	var found: RegExMatch = RegEx.create_from_string(' %s="([^"]*)"' % attribute).search(line)
	if found == null:
		return line
	return _attribute_set(line, attribute, _moved(found.get_string(1), moves))
