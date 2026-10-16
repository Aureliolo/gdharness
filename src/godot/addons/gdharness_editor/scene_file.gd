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

const PropertyValues = preload("property_values.gd")

## Whether a scan asked for through [method scan_later] is still to start, which a caller waiting
## for the editor's files to settle has to wait through as well.
static var scan_due: bool = false

var root: Node = null
var path: String = ""
var _base_paths: Dictionary = {}
var _state: SceneState = null


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
	var base: SceneState = _state.get_base_scene_state()
	while base != null:
		for index: int in base.get_node_count():
			_base_paths[_relative(str(base.get_node_path(index)))] = true
		base = base.get_base_scene_state()
	return {}


## Why [param scene_path] cannot be written while the editor has it open, or "".
static func unsaved_in_editor(scene_path: String) -> String:
	if not EditorInterface.get_unsaved_scenes().has(scene_path):
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


func close() -> void:
	if root != null:
		root.free()
		root = null


## The path of [param node] as a tool names it: "." for the root.
func path_of(node: Node) -> String:
	return str(root.get_path_to(node))


## Why [param node]'s own properties and connections cannot be written, or "". A node inside an
## instanced scene belongs to that scene's file unless its children were made editable here.
func foreign(node: Node) -> String:
	if node == root or node.owner == root:
		return ""
	if node.owner != null and root.is_editable_instance(node.owner):
		return ""
	var owner_path: String = path_of(node.owner) if node.owner != null else "?"
	return (
		(
			"%s belongs to the scene instanced at %s (%s), and this scene saves nothing about it. Edit "
			+ "that scene instead."
		)
		% [path_of(node), owner_path, node.owner.scene_file_path if node.owner != null else "?"]
	)


## Why [param node] cannot be moved, renamed, copied or deleted, or "": the scene may only
## restructure nodes it declares itself, not ones its base scene or an instance creates.
func fixed(node: Node) -> String:
	if node == root:
		return "The root of %s cannot be moved, renamed, copied or deleted." % path
	if node.owner != root:
		var why: String = foreign(node)
		if why.is_empty():
			why = "%s is inside an instanced scene, which creates it again on load." % path_of(node)
		return why
	var at: String = path_of(node)
	if _base_paths.has(at):
		return (
			(
				"%s comes from the scene %s inherits from, which creates it again on load. Edit that "
				+ "scene instead."
			)
			% [at, path]
		)
	return ""


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
## failure was a class it called being behind in the editor.
static func uncompiled(script: Script, script_path: String) -> String:
	if not str(script.get_instance_base_type()).is_empty():
		return ""
	return (
		(
			"%s does not compile in the editor, so it cannot be attached. script_diagnostics on it gives "
			+ "the parser's errors. If they deny a member that another class's file declares, the "
			+ "editor's copy of that class is behind: editor_rescan with reloadScript on that class, then "
			+ "ask again."
		)
		% script_path
	)


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
		return "%s already has a child named %s." % [path_of(parent), child_name]
	return ""


## The names of the properties this scene's own file sets on [param node], whatever their values.
func set_here(node: Node) -> Dictionary:
	var names: Dictionary = {}
	if _state == null:
		return names
	var at: String = path_of(node)
	for index: int in _state.get_node_count():
		if _relative(str(_state.get_node_path(index))) != at:
			continue
		for property: int in _state.get_node_property_count(index):
			names[str(_state.get_node_property_name(index, property))] = true
	return names


## Whether [param loaded], read off [param saved] (a copy instantiated from the pack), is
## [param given], held by the node in [member root]. A node is compared by where it sits in each.
func kept(saved: Node, loaded: Variant, given: Variant) -> bool:
	if loaded is Node and given is Node:
		var loaded_node: Node = loaded
		var given_node: Node = given
		return str(saved.get_path_to(loaded_node)) == str(root.get_path_to(given_node))
	return PropertyValues.same(loaded, given)


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
	if check.is_valid():
		var saved: Node = packed.instantiate(PackedScene.GEN_EDIT_STATE_MAIN)
		if saved == null:
			return refuse("The packed copy of %s did not instantiate, so nothing was written." % path)
		var missing: String = str(check.call(saved))
		saved.free()
		if not missing.is_empty():
			return refuse("Nothing was written: " + missing)
	close()
	return save_packed(packed, path)


## Writes [param packed] to [param scene_path], making its directory, and brings the editor up to
## date with it. Answers a refusal, or {}.
static func save_packed(packed: PackedScene, scene_path: String) -> Dictionary:
	var directory: String = scene_path.get_base_dir()
	if not DirAccess.dir_exists_absolute(directory):
		var made: Error = DirAccess.make_dir_recursive_absolute(directory)
		if made != OK:
			return {"ok": false, "error": "Could not create %s: %s" % [directory, error_string(made)]}
	var saving: Error = ResourceSaver.save(packed, scene_path)
	if saving != OK:
		return {"ok": false, "error": "Failed to save %s: %s" % [scene_path, error_string(saving)]}
	refresh(scene_path)
	return {}


## Brings the editor up to date with a scene file written under it: the cached copy anything holds,
## the editor's file list, and the tab showing it, whether current or not.
static func refresh(scene_path: String) -> void:
	if ResourceLoader.has_cached(scene_path):
		var _replaced: Resource = ResourceLoader.load(scene_path, "", ResourceLoader.CACHE_MODE_REPLACE)
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
	return EditorInterface.get_unsaved_scenes().has(scene_path)


func _relative(node_path: String) -> String:
	if node_path == ".":
		return node_path
	return node_path.trim_prefix("./")
