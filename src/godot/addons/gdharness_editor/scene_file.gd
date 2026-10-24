@tool
extends RefCounted

## One scene file opened for a tool, read past the resource cache and written back only once what
## would be saved has been checked.
##
## Every scene tool edits a copy of the file rather than the editor's open scene, so three things
## the editor does for its own copy have to be done here. Measured on 4.7.2:
##
## - [code]load[/code] answers from the resource cache, and a write saves a new PackedScene without
##   touching the cached one. While anything held the scene (a preload, an exported PackedScene), a
##   second write started from the cached copy and saved over the first.
## - [code]instantiate()[/code] without an edit state keeps no record of which nodes came from
##   another scene, so the pack wrote an inherited scene out as a standalone copy of its base and
##   froze the root properties of every instanced scene into the instancing one.
## - [code]pack[/code] keeps only what the scene itself owns, so a property set on a node inside an
##   instance, a node deleted from one and a node moved out of one were answered as done and were
##   not in the file.
##
## A headless engine writes for a project no editor serves, and there one more thing differs: the
## editor gives a script that is not a tool a placeholder, and anywhere else instancing a scene runs
## every script in it. Measured on 4.7.2, an [code]_init[/code] setting modulate and an exported
## setter setting scale were both saved into the file by a write to another node, and a root whose
## script failed in [code]_init[/code] was saved without it. Outside the editor, then, what a node
## stores is put back to what the file holds wherever the tool did not ask for a change, before
## anything is saved, and a write is refused when that does not hold. See [GdhHeadlessCheck].

const GdhHeadlessCheck = preload("headless_check.gd")

## How many times what scripts changed is put back before a write is refused for it.
const PUTTING_BACK_PASSES: int = 4
const GdhRead = preload("reading.gd")
const GdhSame = preload("same_values.gd")
const GdhSerialisation = preload("serialisation.gd")
const GdhSceneUids = preload("scene_uids.gd")

## Whether a scan asked for through [method scan_later] is still to start, which a caller waiting
## for the editor's files to settle has to wait through as well.
static var scan_due: bool = false
## What the saves of a call wrote on nodes it did not ask to change, differently from their file,
## gathered for that call's answer as [method _also_saved] finds them.
static var also_saved: Array[Dictionary] = []

var root: Node = null
var path: String = ""
## What the last write saved, for its answer to read what the file now stores.
var written_pack: PackedScene = null
## The path of each node a scene this one inherits gives, with the file that makes it.
var _base_paths: Dictionary = {}
var _state: SceneState = null
## What the file stores on each node it was opened with, by the node's instance id, so a node keeps
## its record when a tool moves or renames it. Only kept outside the editor.
var _filed: Dictionary = {}
## The properties a tool set on each node, by instance id: the differences it asked for.
var _asked: Dictionary = {}
## What each node a tool set properties on held before it did, by instance id.
var _before: Dictionary = {}
## Each copy a tool made, by instance id, to the instance id of the node it copies.
var _copied_from: Dictionary = {}
## What a tool wrote in the embedded resources it reached into, by their id in the file, as
## [method GdhHeadlessCheck.reached] answers it.
var _reached: Dictionary = {}
## The file as it was opened, to compare its embedded resources with what the write saves.
var _text: String = ""
## The engine properties a put back did not take on a node, as "id:name": the engine derives them
## from where the node is, as it keeps layout_mode at Container under a container, and stores the
## same from an editor.
var _engine_kept: Dictionary = {}


## Opens [param scene_path], answering a refusal, or {} with [member root] set.
##
## A write is refused while the editor holds unsaved changes to the scene: the file is reloaded
## into the editor after a write, which discards them without a prompt, and the editor saving its
## copy later would discard the write instead.
func open(scene_path: String, for_writing: bool) -> Dictionary:
	path = scene_path
	if not FileAccess.file_exists(path):
		return {"ok": false, "error": "Scene not found: " + path}
	if for_writing:
		var held_back: String = unsaved_in_editor(path)
		if not held_back.is_empty():
			return {"ok": false, "error": held_back}
	var packed: PackedScene = (
		ResourceLoader.load(path, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE) as PackedScene
	)
	if packed == null:
		return {"ok": false, "error": "Failed to load %s as a scene" % path}
	root = packed.instantiate(PackedScene.GEN_EDIT_STATE_MAIN)
	if root == null:
		return {"ok": false, "error": "Failed to instantiate " + path}
	_state = packed.get_state()
	_base_paths = makers(_state)
	# On a read as well, which would otherwise answer what the scripts set as what the file holds.
	if for_writing or not Engine.is_editor_hint():
		for index: int in _state.get_node_count():
			var node: Node = _node_at(str(_state.get_node_path(index)))
			if node != null:
				_filed[node.get_instance_id()] = _stored_at(_state, index)
	if not Engine.is_editor_hint():
		if for_writing:
			_text = FileAccess.get_file_as_string(path)
		var unsettled: String = settle()
		if not unsettled.is_empty():
			return refuse(("Nothing was written: " if for_writing else "Not read: ") + unsettled)
	return {}


## Puts back what the scene's scripts changed on every node a tool has not asked to change, as
## [method write] does, answering "" or why that did not hold. Called once a node has come into the
## scene, so what its scripts did on the way in is not taken for the tool's own change.
func settle() -> String:
	if Engine.is_editor_hint():
		return ""
	var packed: PackedScene = PackedScene.new()
	var packing: Error = packed.pack(root)
	if packing != OK:
		return "Failed to pack %s: %s" % [path, error_string(packing)]
	return _settled(packed)[1]


## Takes [param names] on [param node] as the tool's own changes, which a write saves as they are.
## Called before the tool sets them.
func asked(node: Node, names: Array) -> void:
	var id: int = node.get_instance_id()
	var on: Dictionary = _asked.get_or_add(id, {})
	if not _before.has(id):
		_before[id] = GdhHeadlessCheck.stored(node)
	for name: Variant in names:
		var property: String = str(name)
		on[property] = true
		on[property.get_slice(":", 0)] = true
		GdhHeadlessCheck.spare(_reached, GdhHeadlessCheck.reached(node, property))


## Takes [param resource], built into the scene, as one the tool changed, which a write saves as it is.
func reached_into(resource: Resource) -> void:
	var id: String = resource.get_scene_unique_id()
	if not id.is_empty():
		_reached[id] = true


## Takes each copy in [param copies], keyed by the node it was made from, as holding what that node's
## file entry holds.
func copied(copies: Dictionary) -> void:
	for source: Variant in copies:
		var original: Node = source
		var copy: Node = copies[source]
		_copied_from[copy.get_instance_id()] = original.get_instance_id()


## Why [param scene_path] cannot be written while the editor has it open, or "".
static func unsaved_in_editor(scene_path: String) -> String:
	if not Engine.is_editor_hint() or not EditorInterface.get_unsaved_scenes().has(scene_path):
		return ""
	return (
		(
			"%s has unsaved changes in the editor, and writing the file would discard them when the "
			+ "editor reloads it. Save it first (scene_create op=save) or close it without saving."
		)
		% scene_path
	)


## Frees [member root] and answers [param error] as a refusal.
func refuse(error: String) -> Dictionary:
	close()
	return {"ok": false, "error": error}


## [param said], the refusal for [param node_path] found nowhere in this scene, with how a path is
## read when it starts with the root's own name, and otherwise with the last node of the path the
## scene has and what is under it, as after a node was moved or renamed.
func not_found(said: String, node_path: String) -> String:
	if root == null:
		return said
	if not root.has_node(NodePath(node_path.get_slice("/", 0))):
		var hinted: String = GdhRead.from_the_root(said, node_path, str(root.name))
		if hinted != said:
			return hinted
	var parts: PackedStringArray = node_path.trim_prefix("./").split("/", false)
	var at: Node = root
	var reached: PackedStringArray = []
	for part: String in parts:
		var below: Node = at.get_node_or_null(NodePath(part))
		if below == null:
			break
		at = below
		var _walked: bool = reached.append(part)
	if reached.size() >= parts.size():
		return said
	var names: PackedStringArray = []
	for child: Node in at.get_children():
		var _named: bool = names.append(str(child.name))
	return GdhRead.missing_below(said, str(root.name), reached, parts[reached.size()], names)


func close() -> void:
	if root != null:
		root.free()
		root = null


## What the file holds under the instance at [param at] that goes once its children are not
## editable, as {values, nodes}: the paths of the instance's nodes it sets values on, which stay with
## the instance's own values, and of the nodes the scene added below one of them, which are gone,
## since the packer skips everything below a node of an instance that is not editable. A node added
## straight under [param at] is the scene's own and stays.
func held_under(at: String) -> Dictionary:
	var values: Array[String] = []
	var nodes: Array[String] = []
	for index: int in _state.get_node_count():
		var entry: String = _relative(str(_state.get_node_path(index)))
		var parent: String = _relative(str(_state.get_node_path(index, true)))
		var values_only: bool = (
			_state.get_node_instance(index) == null and str(_state.get_node_type(index)).is_empty()
		)
		if values_only and entry.begins_with(at + "/"):
			values.append(entry)
		elif not values_only and parent.begins_with(at + "/"):
			nodes.append(entry)
	return {"values": values, "nodes": nodes}


## The path of [param node] as a tool names it: "." for the root.
func path_of(node: Node) -> String:
	return str(root.get_path_to(node))


## The class of [param node] as a read answers it: nodeType the engine class, and scriptClass the
## class its script declares, when it declares one.
static func class_of(node: Node) -> Dictionary:
	var named: Dictionary = {"nodeType": node.get_class()}
	var script: Script = node.get_script()
	if script != null and not str(script.get_global_name()).is_empty():
		named["scriptClass"] = str(script.get_global_name())
	return named


## [param given] as a res:// path, one inside [param project_path] taken relative to it.
static func res_path(project_path: String, given: String) -> String:
	var p: String = given.strip_edges()
	if p.begins_with("res://"):
		return p
	if not project_path.strip_edges().is_empty():
		var normalized_project: String = project_path.replace("\\", "/")
		var normalized: String = p.replace("\\", "/")
		if normalized.begins_with(normalized_project):
			p = normalized.substr(normalized_project.length()).trim_prefix("/")
	return "res://" + p


## The node at [param at] under [param top], "." or "" naming [param top] itself, or null.
static func node_at(top: Node, at: String) -> Node:
	if at == "." or at.is_empty():
		return top
	return top.get_node_or_null(at)


## Why the property or signal [param missing] could not be found on [param node], adding the one
## cause the name alone does not show: a script that does not compile leaves the editor holding a
## placeholder with no properties or signals at all, and the refusal named the property instead.
## Such a script has no engine class beneath it. Compiling a copy of the source to find out failed on
## every script with a class_name, since the copy hides the global class the original declares.
static func missing_on(node: Node, missing: String) -> String:
	var script: Script = node.get_script()
	if script == null or not str(script.get_instance_base_type()).is_empty():
		return missing
	return (
		"%s. Its script, %s, does not compile, so none of what it declares is known here."
		% [missing.trim_suffix("."), script.resource_path]
	)


## Why [param node]'s own properties and connections cannot be written, or "". A node inside an
## instanced scene belongs to that scene's file unless its children were made editable here.
func foreign(node: Node) -> String:
	if node == root or node.owner == root:
		return ""
	if node.owner == null:
		return (
			"%s is made by a script as the scene is instanced, and no scene file saves anything about it."
			% path_of(node)
		)
	if root.is_editable_instance(node.owner):
		return ""
	var said: String = (
		(
			"%s belongs to the scene instanced at %s (%s), and this scene saves nothing about it. Edit "
			+ "that scene instead, which changes every instance of it"
		)
		% [path_of(node), path_of(node.owner), node.owner.scene_file_path]
	)
	var steps: PackedStringArray = []
	for closed: String in _closed_around(node):
		var _added: bool = steps.append("nodePath %s editableChildren true" % closed)
	if steps.is_empty():
		return said + "."
	return (
		said
		+ ", or have this scene keep its own values for this instance with scene_node set "
		+ ", then ".join(steps)
		+ "."
	)


## The instances around [param node] whose children are not editable, outermost first: each must be
## made editable, in that order, before this scene keeps values of its own for [param node], since
## the packer skips every node under an instance that is not. Empty when nothing would let it.
func _closed_around(node: Node) -> PackedStringArray:
	var closed: PackedStringArray = []
	var instance: Node = node.owner
	while instance != root:
		if instance == null:
			return []
		if not root.is_editable_instance(instance):
			var _at: int = closed.insert(0, path_of(instance))
		instance = instance.owner
	return closed


## Why [param node] cannot be moved, renamed, copied or deleted, or "": the scene may only
## restructure nodes it declares itself, not ones its base scene or an instance creates. With
## [param deleting], the refusal says what can be done instead, since nothing in this scene can.
func fixed(node: Node, deleting: bool = false) -> String:
	if node == root:
		return "The root of %s cannot be moved, renamed, copied or deleted." % path
	if node.owner == null:
		return foreign(node)
	if node.owner != root:
		# Editable children keep values here and no more; the scene instanced may have the node from
		# a scene it inherits, which is the one to edit.
		var instanced: String = node.owner.scene_file_path
		var packed: PackedScene = load(instanced) as PackedScene
		var made_by: Dictionary = makers(packed.get_state()) if packed != null else {}
		var maker: String = str(made_by.get(str(node.owner.get_path_to(node)), instanced))
		var inside: String = (
			"%s is inside the scene instanced at %s (%s), which creates it again on load."
			% [path_of(node), path_of(node.owner), instanced]
		)
		return inside + (_deleted_elsewhere(node, maker) if deleting else " Edit %s instead." % maker)
	var at: String = path_of(node)
	if _base_paths.has(at):
		var maker: String = str(_base_paths[at])
		var made: String = (
			"%s is made by %s, a scene %s inherits, which creates it again on load." % [at, maker, path]
		)
		return made + (_deleted_elsewhere(node, maker) if deleting else " Edit that scene instead.")
	return ""


## Each node the scenes [param state] inherits give it, by path, with the deepest file making it more
## than values; a node [param state] makes itself is not in it.
static func makers(state: SceneState) -> Dictionary:
	var made_by: Dictionary = {}
	var at: SceneState = state.get_base_scene_state()
	while at != null:
		for index: int in at.get_node_count():
			var given: String = _relative(str(at.get_node_path(index)))
			var made: bool = (
				at.get_node_instance(index) != null or not str(at.get_node_type(index)).is_empty()
			)
			if made or not made_by.has(given):
				made_by[given] = at.get_path()
		at = at.get_base_scene_state()
	return made_by


## What a caller can do with [param node], made by [param maker], instead of deleting it here.
static func _deleted_elsewhere(node: Node, maker: String) -> String:
	var hidden: String = (
		"set its visible to false here to hide it in this scene alone, or " if "visible" in node else ""
	)
	return (
		(
			" No scene can delete a node another scene makes: %sdelete it in %s, which removes it from "
			+ "every scene using that one."
		)
		% [hidden, maker]
	)


## Why the folder a new file at [param file_path] goes in cannot be made, or "" once it is there. The
## engine makes no folder when it saves, so a create into one not yet made failed with no more than
## the engine's error, while script_edit create made its folder and went ahead.
static func make_folder_for(file_path: String) -> String:
	var folder: String = file_path.get_base_dir()
	if DirAccess.dir_exists_absolute(folder):
		return ""
	var made: Error = DirAccess.make_dir_recursive_absolute(folder)
	return "" if made == OK else "Could not make the folder %s: %s" % [folder, error_string(made)]


## Why [param script], loaded from [param script_path], cannot be attached because the editor could not
## compile it, or "". A script that did not compile has no base type, and the refusal built from that
## said "start.gd extends , so it cannot be on a Control root" about a script that was fine, whose
## failure was a class it called being behind in the editor. A headless engine compiles every
## script from its file, so only an editor can hold a copy that is behind.
static func uncompiled(script: Script, script_path: String) -> String:
	if not str(script.get_instance_base_type()).is_empty():
		return ""
	if not Engine.is_editor_hint():
		return (
			(
				"%s does not compile, so it cannot be attached. script_diagnostics on it gives the "
				+ "parser's errors."
			)
			% script_path
		)
	return (
		(
			"%s does not compile in the editor, so it cannot be attached. script_diagnostics on it "
			+ "gives the parser's errors. If they deny a member that another class's file declares, "
			+ "the editor's copy of that class is behind: editor_rescan with reloadScript on that "
			+ "class, then ask again."
		)
		% script_path
	)


## The script a project declares [param type_name] in with class_name, as {"script", "path",
## "base"} with base the engine class its objects are made as, or {"error"} when that script cannot
## make one, or an empty dictionary when no script declares it. The editor's create dialogs offer
## these classes beside the engine's, and ClassDB knows only the engine's.
static func script_class(type_name: String, kind: String) -> Dictionary:
	for entry: Dictionary in ProjectSettings.get_global_class_list():
		if str(entry.get("class", "")) != type_name:
			continue
		var declaring: String = str(entry.get("path", ""))
		if entry.get("is_abstract", false) == true:
			return {
				"error":
				"%s, declared in %s, is abstract, so nothing can be made of it." % [type_name, declaring]
			}
		var script: Script = load(declaring) as Script
		if script == null:
			return {"error": "%s is declared in %s, which does not load." % [type_name, declaring]}
		var failed: String = uncompiled(script, declaring)
		if not failed.is_empty():
			return {"error": failed}
		var base: String = str(script.get_instance_base_type())
		if not ClassDB.is_parent_class(base, kind):
			return {
				"error":
				"%s, declared in %s, extends %s, which is not a %s." % [type_name, declaring, base, kind]
			}
		return {"script": script, "path": declaring, "base": base}
	return {}


## The engine class and the script a create makes for [param type_name] and [param given], the
## res:// path of the script the call named or "", as {"type", "script"}, or {"error"}. A class_name
## a project script declares is that script on its engine class; [param argument] names the
## argument the type came in, for the refusal when the call also named another script.
static func made_as(type_name: String, given: String, kind: String, argument: String) -> Dictionary:
	if ClassDB.class_exists(type_name):
		return {"type": type_name, "script": given}
	var declared: Dictionary = script_class(type_name, kind)
	if declared.has("error"):
		return declared
	if declared.is_empty():
		return {"type": type_name, "script": given}
	var declaring: String = str(declared["path"])
	if not given.is_empty() and given != declaring:
		return {
			"error":
			(
				"%s %s is the class %s declares, and script names %s: pass one of them."
				% [argument, type_name, declaring, given]
			)
		}
	return {"type": str(declared["base"]), "script": declaring}


## Why no node can be called [param node_name], wherever it sits, or "".
static func unfit_name(node_name: String) -> String:
	if node_name.is_empty():
		return "A node needs a name."
	var valid: String = node_name.validate_node_name()
	if valid != node_name:
		return (
			(
				"%s is not a name a node can have; Godot would save it as %s. The characters "
				+ '. : @ / " %% cannot be in a node name.'
			)
			% [node_name, valid]
		)
	return ""


## Why [param child_name] cannot be given to a child of [param parent], or "". Godot renames a node
## whose name is taken or holds a character a path cannot, and the next call naming it would then
## reach another node.
func unusable_name(parent: Node, child_name: String, moving: Node = null) -> String:
	var unfit: String = unfit_name(child_name)
	if not unfit.is_empty():
		return unfit
	var taken: Node = parent.get_node_or_null(NodePath(child_name))
	if taken != null and taken != moving and taken.get_parent() == parent:
		# The root by its name, since its path is ".", and ". already has a child" read as a typo.
		var holder: String = "The root, %s," % parent.name if parent == root else path_of(parent)
		return "%s already has a child named %s." % [holder, child_name]
	return ""


## The properties this scene's own file sets on [param node], each with the value the file gives it.
func set_here(node: Node) -> Dictionary:
	return set_at(path_of(node))


## Where the values of [param node], at [param at] in the file, come from when the file does not set
## them: "" for a node this scene makes, which holds them all, or the scene that makes the node, the
## one it is instanced from or one this scene inherits.
func values_from(node: Node, at: String) -> String:
	if node != root and not node.scene_file_path.is_empty():
		return node.scene_file_path
	if node != root and node.owner != root:
		return node.owner.scene_file_path if node.owner != null else ""
	return str(_base_paths.get(at, ""))


## The groups this scene's own file puts the node at [param at] in.
func groups_at(at: String) -> PackedStringArray:
	var named: PackedStringArray = []
	if _state == null:
		return named
	for index: int in _state.get_node_count():
		if _relative(str(_state.get_node_path(index))) == at:
			named.append_array(_state.get_node_groups(index))
	return named


## The properties this scene's own file sets on the node at [param at], with the values it gives.
func set_at(at: String) -> Dictionary:
	var held: Dictionary = {}
	if _state == null:
		return held
	for index: int in _state.get_node_count():
		if _relative(str(_state.get_node_path(index))) != at:
			continue
		for p: int in _state.get_node_property_count(index):
			held[str(_state.get_node_property_name(index, p))] = _state.get_node_property_value(index, p)
	return held


## Whether [param loaded], read off [param saved] (a copy instantiated from the pack), is
## [param given], held by the node in [member root]. A node is compared by where it sits in each,
## in a list of nodes as much as alone: the copy's nodes are others with the same places.
func kept(saved: Node, loaded: Variant, given: Variant) -> bool:
	if loaded is Node and given is Node:
		var loaded_node: Node = loaded
		var given_node: Node = given
		return str(saved.get_path_to(loaded_node)) == str(root.get_path_to(given_node))
	if loaded is Array and given is Array:
		var loaded_items: Array = loaded
		var given_items: Array = given
		if given_items.any(func(item: Variant) -> bool: return item is Node):
			if loaded_items.size() != given_items.size():
				return false
			for index: int in given_items.size():
				if not kept(saved, loaded_items[index], given_items[index]):
					return false
			return true
	return GdhSame.same(loaded, given)


## Packs [member root], has [param check] read the result as the file will hold it, and writes the
## file only if the check answers "". Frees [member root] either way.
##
## The check reads a scene instantiated from the pack, which is what loading the file gives, so
## anything the pack leaves out (a property with no storage, a node the scene does not own) is seen
## as missing before the file is touched.
func write(check: Callable = Callable()) -> Dictionary:
	var packed: PackedScene = PackedScene.new()
	var packing: Error = packed.pack(root)
	if packing != OK:
		return refuse("Failed to pack %s: %s" % [path, error_string(packing)])
	var headless: bool = not Engine.is_editor_hint()
	if headless:
		var settled: Array = _settled(packed)
		if not str(settled[1]).is_empty():
			return refuse("Nothing was written: " + str(settled[1]))
		packed = settled[0]
		if not path.ends_with(".tscn") and _holds_scripted_embedded():
			var binary: String = (
				"Nothing was written: %s is a binary scene holding an embedded resource with a script "
				+ "that is not a tool, and what that script changed when a headless engine loaded it "
				+ "cannot be told apart from the file here. "
			)
			return refuse(binary % path + GdhHeadlessCheck.REMEDY)
	if check.is_valid():
		var saved: Node = packed.instantiate(PackedScene.GEN_EDIT_STATE_MAIN)
		if saved == null:
			return refuse("The packed copy of %s did not instantiate, so nothing was written." % path)
		var missing: String = str(check.call(saved))
		saved.free()
		if not missing.is_empty():
			return refuse("Nothing was written: " + missing)
	var also: Array[Dictionary] = _also_saved(packed.get_state())
	close()
	var previous: Variant = null
	if FileAccess.file_exists(path):
		previous = FileAccess.get_file_as_bytes(path)
	written_pack = packed
	var state: SceneState = packed.get_state()
	var values: Array = []
	for index: int in state.get_node_count():
		values.append_array(_stored_at(state, index).values())
	var carried: Dictionary = GdhHeadlessCheck.embedded_in(values, {})
	var written: Dictionary = save_packed(packed, path)
	if not written.is_empty() or not headless or not path.ends_with(".tscn"):
		if written.is_empty():
			also_saved.append_array(also)
		return written
	var unkept: String = GdhHeadlessCheck.settle_saved(
		path,
		_text,
		values,
		null,
		{},
		_reached,
		carried,
		func() -> Error: return GdhSceneUids.save_keeping_uid(packed, path)
	)
	if unkept.is_empty():
		also_saved.append_array(also)
		return {}
	return {
		"ok": false, "error": "Nothing was written: " + unkept + GdhHeadlessCheck.put_back(path, previous)
	}


## Each property [param state] stores differently from the file, on a node the file held and the call
## did not ask to change, as {node, property, was, saved}: was left out where the file did not set it,
## saved where the write does not. The engine writes a node as it holds it once the file has loaded,
## and one property can set others as it loads, as anchors_preset gives a centred Control both grow
## directions, so a file not written by the editor gains lines on nodes nobody named.
func _also_saved(state: SceneState) -> Array[Dictionary]:
	var noted: Array[Dictionary] = []
	var values: GdhSerialisation = GdhSerialisation.new()
	for index: int in state.get_node_count():
		var node: Node = _node_at(str(state.get_node_path(index)))
		if node == null:
			continue
		var id: int = node.get_instance_id()
		if _asked.has(id) or not _filed.has(id):
			continue
		var filed: Dictionary = _filed[id]
		var stored: Dictionary = _stored_at(state, index)
		var names: Dictionary = filed.duplicate()
		names.merge(stored)
		for key: Variant in names:
			var name: String = str(key)
			var held: bool = filed.has(name)
			if held == stored.has(name) and (not held or GdhSame.same(stored[name], filed[name])):
				continue
			var entry: Dictionary = {"node": path_of(node), "property": name}
			if held:
				entry["was"] = values.serialize_value(filed[name])
			if stored.has(name):
				entry["saved"] = values.serialize_value(stored[name])
			noted.append(entry)
	return noted


func _holds_scripted_embedded() -> bool:
	var seen: Dictionary = {}
	var nodes: Array[Node] = [root]
	while not nodes.is_empty():
		var node: Node = nodes.pop_back()
		if GdhHeadlessCheck.holds_scripted_embedded(node, seen):
			return true
		nodes.append_array(node.get_children())
	return false


## Writes [param packed] to [param scene_path], making its directory, and brings the editor up to
## date with it. Answers a refusal, or {}.
static func save_packed(packed: PackedScene, scene_path: String) -> Dictionary:
	var directory: String = scene_path.get_base_dir()
	if not DirAccess.dir_exists_absolute(directory):
		var made: Error = DirAccess.make_dir_recursive_absolute(directory)
		if made != OK:
			return {"ok": false, "error": "Could not create %s: %s" % [directory, error_string(made)]}
	var saving: Error = GdhSceneUids.save_keeping_uid(packed, scene_path)
	if saving != OK:
		return {"ok": false, "error": "Failed to save %s: %s" % [scene_path, error_string(saving)]}
	refresh(scene_path)
	return {}


## Brings the editor up to date with a scene file written under it: the cached copy anything holds,
## the editor's file list, and the tab showing it, whether current or not.
static func refresh(scene_path: String) -> void:
	if ResourceLoader.has_cached(scene_path):
		var _replaced: Resource = ResourceLoader.load(scene_path, "", ResourceLoader.CACHE_MODE_REPLACE)
	if not Engine.is_editor_hint():
		return
	scan_later()
	if EditorInterface.get_open_scenes().has(scene_path):
		EditorInterface.reload_scene_from_path(scene_path)


## Has the editor scan its files once the call in hand has answered, rather than now.
##
## A scan's thread ends by writing the editor's file list to its cache, walking the list as it goes,
## while each save made in the editor updates an entry of that list on the main thread and frees
## what the entry held (4.7.2's [code]_save_filesystem_cache[/code] and
## [code]EditorNode::_resource_saved[/code]). A scene saved 250 ms after a resource's scan began was
## followed by garbage decoded as text and a dropped connection. Started at the end of the frame,
## the scan begins after every save the call makes, and the plugin turns away calls that could save
## until it is over.
static func scan_later() -> void:
	if scan_due:
		return
	scan_due = true
	_start_scan.call_deferred()


## [method EditorFileSystem.scan] does nothing, and says nothing, while the thread of the scan
## before it is still to be joined, which is a frame or two after that scan stops reporting itself,
## so a scan that leaves the editor not scanning is asked for once more once that is over. Asked of
## a scan that ended within the call, the second costs one more scan.
static func _start_scan() -> void:
	var filesystem: EditorFileSystem = EditorInterface.get_resource_filesystem()
	var tree: SceneTree = Engine.get_main_loop()
	while filesystem.is_scanning() or filesystem.is_importing():
		await tree.process_frame
	filesystem.scan()
	if not filesystem.is_scanning():
		await tree.process_frame
		await tree.process_frame
		filesystem.scan()
	scan_due = false


## Whether the editor holds unsaved changes to [param scene_path], for a read to say that the file
## it answers from is not what the editor shows.
static func unsaved(scene_path: String) -> bool:
	return Engine.is_editor_hint() and EditorInterface.get_unsaved_scenes().has(scene_path)


## [param packed] with what the scene's scripts changed put back, as [pack, ""], or [null, why not].
##
## On a node the tool did not ask to change, a difference is put back to what the file holds, or, for
## a property the file does not set, to what the node would load with without it. On a node it did
## ask to change, through a script that is not a tool, every property it did not name is put back to
## what it held before. Packed again afterwards and put back again until nothing differs, since
## putting one property back can run a setter that changes another already put back (a script
## setting speed in _init, whose setter tints modulate), and refused if something still does.
func _settled(packed: PackedScene) -> Array:
	var current: PackedScene = packed
	var left: Array[Array] = []
	for put_back: int in PUTTING_BACK_PASSES + 1:
		var stray: Array[Array] = _strays(current.get_state())
		var moved: Array[Array] = _moved_by_scripts()
		if stray.is_empty() and moved.is_empty():
			return [current, ""]
		if put_back == PUTTING_BACK_PASSES:
			left = stray
			left.append_array(moved)
			break
		for found: Array in stray:
			var node: Node = found[0]
			var name: String = found[1]
			var wanted: Variant = found[3] if found[2] else _unset_value(node, name)
			var held: Variant = node.get(name)
			node.set(name, wanted)
			if GdhHeadlessCheck.kept_by_engine(node, name, wanted, held):
				_engine_kept["%d:%s" % [node.get_instance_id(), name]] = true
		for found: Array in moved:
			var node: Node = found[0]
			var before: Dictionary = _before[node.get_instance_id()]
			for name: String in found[1]:
				node.set(name, before.get(name, GdhHeadlessCheck.default_of(node, name)))
		current = PackedScene.new()
		var packing: Error = current.pack(root)
		if packing != OK:
			return [null, "Failed to pack %s: %s" % [path, error_string(packing)]]
	var first: Array = left[0]
	var stray_node: Node = first[0]
	var named: String = str(first[1])
	if first[1] is Array:
		var names: Array = first[1]
		named = str(names[0])
	return [null, _stray_text(stray_node, named)]


## Each node the tool asked to change through a script that is not a tool, with the properties it did
## not name that no longer hold what they held before, as [node, names].
func _moved_by_scripts() -> Array[Array]:
	var moved: Array[Array] = []
	for key: Variant in _asked:
		var id: int = key
		var node: Node = instance_from_id(id) as Node
		if node == null or not root.is_ancestor_of(node) and node != root:
			continue
		var on: Dictionary = _asked[id]
		if not GdhHeadlessCheck.through_script(node, on):
			continue
		var before: Dictionary = _before[id]
		var changed: Array[String] = GdhHeadlessCheck.differing(node, before, on)
		if not changed.is_empty():
			moved.append([node, changed])
	return moved


## Every property [param state] stores differently from the file, on a node the tool did not ask to
## change it on, as [node, name, whether the file stores it, the file's value].
func _strays(state: SceneState) -> Array[Array]:
	var stray: Array[Array] = []
	for index: int in state.get_node_count():
		var node: Node = _node_at(str(state.get_node_path(index)))
		if node == null:
			continue
		var id: int = node.get_instance_id()
		if _asked.has(id):
			continue
		var filed: Dictionary = _filed.get(id, _filed.get(_copied_from.get(id, 0), {}))
		# A node is instanced before it is added to its parent, which is before its children are, so
		# what a script does as a scene loads stays on the script's own node. Anything else a pack
		# changes is Godot's doing and the editor's pack does it too: a Control saved without its
		# grow directions gets them back from anchors_preset's setter, and loses an anchors_preset
		# its layout mode does not store.
		if (
			not GdhHeadlessCheck.untooled(node.get_script())
			and not GdhHeadlessCheck.untooled(filed.get("script"))
		):
			continue
		var stored: Dictionary = _stored_at(state, index)
		var names: Dictionary = filed.duplicate()
		names.merge(stored)
		for key: Variant in names:
			var name: String = str(key)
			var held: bool = filed.has(name)
			if held == stored.has(name) and (not held or GdhSame.same(stored[name], filed[name])):
				continue
			if not held and GdhHeadlessCheck.at_default(node, name):
				continue
			if _engine_kept.has("%d:%s" % [id, name]):
				continue
			stray.append([node, name, held, filed.get(name)])
	return stray


func _stray_text(node: Node, name: String) -> String:
	var at: String = str(root.name) if node == root else path_of(node)
	if name == "script":
		return (
			(
				(
					"the script of %s did not start when a headless engine instanced %s, so the node would be "
					+ "saved without it; the engine's messages give its errors. "
				)
				% [at, path]
			)
			+ GdhHeadlessCheck.REMEDY
		)
	return (
		(
			(
				"%s.%s would be saved differently from what %s holds, and the call did not ask for it: the "
				+ "scene's scripts ran when a headless engine instanced it, as they do in the game and not in "
				+ "an editor. "
			)
			% [at, name, path]
		)
		+ GdhHeadlessCheck.REMEDY
	)


## What [param node] would load with for [param name] if this file did not set it: what the scenes
## it comes from store, followed down through every scene instanced or inherited, else its script's
## or class's default. Read from their files, since instancing them would run their scripts.
func _unset_value(node: Node, name: String) -> Variant:
	var base: SceneState = _state.get_base_scene_state() if _state != null else null
	if node == root or _base_paths.has(path_of(node)):
		return _value_in(base, path_of(node), node, name)
	var top: Node = node
	while top != root and top.owner != root:
		top = top.get_parent()
	if top == root or top.scene_file_path.is_empty():
		return GdhHeadlessCheck.default_of(node, name)
	if _base_paths.has(path_of(top)):
		return _value_in(base, path_of(node), node, name)
	var instanced: PackedScene = ResourceLoader.load(top.scene_file_path) as PackedScene
	return _value_in(
		instanced.get_state() if instanced != null else null, str(top.get_path_to(node)), node, name
	)


## What [param state] gives the node at [param at] for [param name], following it into the scene an
## enclosing node instances, or into the base scene, until a file sets it.
func _value_in(state: SceneState, at: String, node: Node, name: String) -> Variant:
	while state != null:
		var inside: String = ""
		var instanced: PackedScene = null
		for index: int in state.get_node_count():
			var here: String = _relative(str(state.get_node_path(index)))
			if here == at:
				for property: int in state.get_node_property_count(index):
					if str(state.get_node_property_name(index, property)) == name:
						return state.get_node_property_value(index, property)
			var scene: PackedScene = state.get_node_instance(index)
			if scene == null:
				continue
			var encloses: bool = here == at or here == "." or at.begins_with(here + "/")
			if encloses and (instanced == null or here.length() > inside.length() or inside == "."):
				inside = here
				instanced = scene
		if instanced != null:
			if inside == at:
				at = "."
			elif inside != ".":
				at = at.substr(inside.length() + 1)
			state = instanced.get_state()
		else:
			state = state.get_base_scene_state()
	return GdhHeadlessCheck.default_of(node, name)


func _node_at(node_path: String) -> Node:
	var at: String = _relative(node_path)
	return root if at == "." else root.get_node_or_null(NodePath(at))


static func _stored_at(state: SceneState, index: int) -> Dictionary:
	var stored: Dictionary = {}
	for property: int in state.get_node_property_count(index):
		stored[str(state.get_node_property_name(index, property))] = (state.get_node_property_value(
			index, property
		))
	return stored


static func _relative(node_path: String) -> String:
	return node_path.trim_prefix("./")
