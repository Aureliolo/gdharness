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
		'[ext_resource type="PackedScene"%s path="%s" id="1_base"]' % [_uid_of(base_path), base_path],
	]
	if script != null:
		var _resourced: bool = lines.append(
			(
				'[ext_resource type="Script"%s path="%s" id="2_script"]'
				% [_uid_of(script.resource_path), script.resource_path]
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


## The uid attribute an ext_resource line gives [param path], or "" when the file has none to read
## or its uid leads to another file.
static func _uid_of(path: String) -> String:
	var id: int = SceneFile.uid_in(path)
	if id == ResourceUID.INVALID_ID:
		id = ResourceLoader.get_resource_uid(path)
	# A file copied whole keeps the uid in its header, which the loader follows to the original.
	if id == ResourceUID.INVALID_ID or (ResourceUID.has_id(id) and ResourceUID.get_id_path(id) != path):
		return ""
	return ' uid="%s"' % ResourceUID.id_to_text(id)


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
