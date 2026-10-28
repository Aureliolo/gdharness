@tool
extends Node
## Animations and animation trees, edited in the open editor or, for a project no editor serves, by
## a headless engine.

const GdhAnimationReads = preload("../animation_reads.gd")
const GdhHeadlessCheck = preload("../headless_check.gd")
const GdhPropertyValues = preload("../property_values.gd")
const GdhRead = preload("../reading.gd")
const GdhSceneFile = preload("../scene_file.gd")
const GdhSceneUids = preload("../scene_uids.gd")
const GdhSerialisation = preload("../serialisation.gd")
const LOOP_MODES: Dictionary = {
	"none": Animation.LOOP_NONE,
	"linear": Animation.LOOP_LINEAR,
	"pingpong": Animation.LOOP_PINGPONG,
}

var _editor_plugin: EditorPlugin = null
var _properties: GdhPropertyValues = GdhPropertyValues.new()


func set_editor_plugin(plugin: EditorPlugin) -> void:
	_editor_plugin = plugin


# =============================================================================
# Shared helpers
# =============================================================================
## [param scene_path] opened for writing, with the node at [param node_path] in it, which must be a
## [param kind] the scene owns. Answers [scene, node, refusal]; the refusal is {} when both were
## found.
func _open_at(scene_path: String, node_path: String, kind: String) -> Array:
	var scene: GdhSceneFile = GdhSceneFile.new()
	var refused: Dictionary = scene.open(scene_path, true)
	if not refused.is_empty():
		return [scene, null, refused]
	var node: Node = GdhSceneFile.node_at(scene.root, node_path)
	if node == null or not node.is_class(kind):
		return [scene, null, _not_of_kind(scene, node, node_path, kind)]
	var foreign: String = scene.foreign(node)
	if not foreign.is_empty():
		return [scene, null, scene.refuse(foreign)]
	return [scene, node, {}]


## [param scene_path] opened for reading, as [method _open_at] answers. A node an instanced scene
## owns is read like any other, since nothing is written.
func _read_at(scene_path: String, node_path: String, kind: String) -> Array:
	var scene: GdhSceneFile = GdhSceneFile.new()
	var refused: Dictionary = scene.open(scene_path, false)
	if not refused.is_empty():
		return [scene, null, refused]
	var node: Node = GdhSceneFile.node_at(scene.root, node_path)
	if node == null or not node.is_class(kind):
		return [scene, null, _not_of_kind(scene, node, node_path, kind)]
	return [scene, node, {}]


## The refusal for [param node_path] in [param scene], where [param node] is what the scene has
## there, null or not a [param kind], with where the scene's nodes of that kind are.
func _not_of_kind(scene: GdhSceneFile, node: Node, node_path: String, kind: String) -> Dictionary:
	var said: String = "%s not found at: %s" % [kind, node_path]
	if node == null:
		said = scene.not_found(said, node_path)
	var held: PackedStringArray = []
	if scene.root.is_class(kind):
		var _root_held: bool = held.append(".")
	for found: Node in scene.root.find_children("*", kind, true, false):
		var _held: bool = held.append(str(scene.root.get_path_to(found)))
	var there: String = "" if node == null else node.get_class()
	return scene.refuse(GdhRead.not_of_kind(said, node_path, there, kind, held))


## Writes [param scene] once [param check] passes, then the files of [param homes], answering
## [param answer] or a refusal.
func _finish(
	scene: GdhSceneFile, check: Callable, homes: Dictionary, answer: Dictionary
) -> Dictionary:
	if not Engine.is_editor_hint():
		for file: Variant in homes:
			var home: Resource = homes[file]
			if _scripted(home):
				return (
					scene
					. refuse(
						(
							(
								(
									"Nothing was written: %s holds a resource with a script that "
									+ "is not a tool, and what that script changed when a headless "
									+ "engine loaded it cannot be told apart from the edit. "
								)
								% file
							)
							+ GdhHeadlessCheck.REMEDY
						)
					)
				)
	var written: Dictionary = scene.write(check)
	if not written.is_empty():
		return written
	for file: Variant in homes:
		var resource: Resource = homes[file]
		var saving: Error = GdhSceneUids.save_keeping_uid(resource, str(file))
		if saving != OK:
			return { "ok": false, "error": "Failed to save %s: %s" % [file, error_string(saving)] }
		if Engine.is_editor_hint():
			EditorInterface.get_resource_filesystem().update_file(str(file))
	return answer


## Whether [param resource], or one it embeds, has a script that is not a tool, which a headless
## engine ran as it loaded the file.
func _scripted(resource: Resource) -> bool:
	var script: Script = resource.get_script()
	return (
		(script != null and not script.is_tool())
		or GdhHeadlessCheck.holds_scripted_embedded(resource, {})
	)


func _parse_json_maybe(value: Variant) -> Variant:
	if typeof(value) != TYPE_STRING:
		return value
	var text: String = value
	var parsed: Variant = GdhRead.json_or_null(text)
	if parsed == null and text != "null":
		return value
	return parsed


func _parse_method_args(raw_args: Array) -> Array:
	var parsed_args: Array = []
	for raw_arg: Variant in raw_args:
		var parsed: Variant = _parse_json_maybe(raw_arg)
		parsed_args.append(_properties.parse(parsed))
	return parsed_args


## The files an edit to each of [param held] has to be saved in beside the scene, as
## [true, {file: resource}] or [false, why]. Each entry is [resource, what it is called].
##
## A resource that is part of the scene file is saved with it. One kept in a .tres of its own was
## edited in memory while only the scene was saved, which refers to the file, so the edit was
## answered as made and was gone; it is saved too. One inside some other file (an imported model,
## the scene this one inherits from) is refused, since nothing written here would keep the edit.
func _homes(scene: GdhSceneFile, held: Array) -> Array:
	var homes: Dictionary = {}
	for entry: Array in held:
		var resource: Resource = entry[0]
		var at: String = resource.resource_path
		# Built into the scene, or into a file saved beside it here: an animation inside a library
		# kept in its own .tres goes with the library.
		if at.is_empty() or at.get_slice("::", 0) == scene.path or homes.has(at.get_slice("::", 0)):
			continue
		if (
			not at.contains("::")
			and FileAccess.file_exists(at)
			and not FileAccess.file_exists(at + ".import")
		):
			homes[at] = resource
			continue
		return [
			false,
			(
				(
					"The %s is kept in %s, not in %s, and an edit here would not be saved there. "
					+ "Edit it where it is kept instead."
				)
				% [entry[1], at.get_slice("::", 0), scene.path]
			),
		]
	return [true, homes]


## The library a new animation called [param animation_name] goes in, as [library, why not, made]:
## the default one, or the one named before a slash, as the player names them ("moves/walk"). One
## the player lacks is made, built into the scene, and made says so; no other op makes a library,
## so refusing one left "moves/walk" with no way to be written.
func _library_for(player: AnimationPlayer, animation_name: String) -> Array:
	var library: String = ""
	if animation_name.contains("/"):
		library = animation_name.get_slice("/", 0)
	if player.has_animation_library(StringName(library)):
		return [player.get_animation_library(StringName(library)), "", false]
	var made: AnimationLibrary = AnimationLibrary.new()
	var adding: Error = player.add_animation_library(StringName(library), made)
	if adding != OK:
		var called: String = (
			"the default AnimationLibrary" if library.is_empty() else "the library " + library
		)
		return [null, "Failed to create %s: %s" % [called, error_string(adding)], false]
	return [made, "", true]


## The library [param animation_name] is in on [param player].
func _library_of(player: AnimationPlayer, animation_name: String) -> AnimationLibrary:
	var library: String = animation_name.get_slice("/", 0) if animation_name.contains("/") else ""
	return player.get_animation_library(StringName(library))


## The state machine at [param state_machine_path] in [param anim_tree], with the files it is kept
## in, as [machine, homes, why not].
func _machine(scene: GdhSceneFile, anim_tree: AnimationTree, state_machine_path: String) -> Array:
	var sm: AnimationNodeStateMachine = GdhAnimationReads.state_machine(
		anim_tree, state_machine_path
	)
	if not sm:
		return [null, {}, GdhAnimationReads.no_machine(anim_tree, state_machine_path)]
	var homes: Array = _homes(scene, [[sm, "state machine"]])
	if not homes[0]:
		return [null, {}, homes[1]]
	return [sm, homes[1], ""]


## The node [param track_path] animates, resolved as the player resolves it: from its root node.
func _animated(player: AnimationPlayer, track_path: String) -> Node:
	var from: Node = player.get_node_or_null(player.root_node)
	if from == null:
		return null
	return from.get_node_or_null(NodePath(track_path))


# =============================================================================
# read_animations, read_animation_states
# =============================================================================
## The animations of an AnimationPlayer, or one of them whole. A track comes back in the shape
## add_track takes, so one read here can be written to another animation as it stands.
func read_animations(args: Dictionary) -> Dictionary:
	var scene_path: String = GdhSceneFile.res_path("", str(args.get("scenePath", "")))
	var player_node_path: String = str(args.get("playerNodePath", "."))
	var animation_name: String = str(args.get("animationName", ""))
	if scene_path.strip_edges() == "res://":
		return { "ok": false, "error": "Missing scenePath" }

	var opened: Array = _read_at(scene_path, player_node_path, "AnimationPlayer")
	var scene: GdhSceneFile = opened[0]
	if opened[1] == null:
		return opened[2]
	var player: AnimationPlayer = opened[1]
	return _read_in(scene, GdhAnimationReads.animations(player, animation_name))


## [param answer] read from [param scene], with whether the editor holds the scene unsaved.
func _read_in(scene: GdhSceneFile, answer: Dictionary) -> Dictionary:
	if not answer.get("ok", false):
		return scene.refuse(str(answer.get("error", "")))
	answer["unsavedInEditor"] = GdhSceneFile.unsaved(scene.path)
	scene.close()
	return answer


## The states and transitions of a state machine in an AnimationTree.
func read_animation_states(args: Dictionary) -> Dictionary:
	var scene_path: String = GdhSceneFile.res_path("", str(args.get("scenePath", "")))
	var anim_tree_path: String = str(args.get("animTreePath", ""))
	var state_machine_path: String = str(args.get("stateMachinePath", ""))
	if scene_path.strip_edges() == "res://":
		return { "ok": false, "error": "Missing scenePath" }
	if anim_tree_path.is_empty():
		return { "ok": false, "error": "Missing animTreePath" }

	var opened: Array = _read_at(scene_path, anim_tree_path, "AnimationTree")
	var scene: GdhSceneFile = opened[0]
	if opened[1] == null:
		return opened[2]
	var anim_tree: AnimationTree = opened[1]
	var reached: Node = anim_tree.get_node_or_null(anim_tree.anim_player)
	var player: AnimationPlayer = reached as AnimationPlayer
	var player_path: String = "" if player == null else scene.path_of(player)
	var unplayed: String = GdhAnimationReads.no_player(str(anim_tree.anim_player), reached)
	return _read_in(
		scene,
		GdhAnimationReads.states(anim_tree, state_machine_path, player, player_path, unplayed)
	)


# =============================================================================
# create_animation
# =============================================================================
func create_animation(args: Dictionary) -> Dictionary:
	var scene_path: String = GdhSceneFile.res_path("", str(args.get("scenePath", "")))
	var player_node_path: String = str(args.get("playerNodePath", "."))
	var animation_name: String = str(args.get("animationName", ""))
	var loop_mode_name: String = str(args.get("loopMode", "none"))

	if scene_path.strip_edges() == "res://":
		return { "ok": false, "error": "Missing scenePath" }
	if animation_name.strip_edges().is_empty():
		return { "ok": false, "error": "Missing animationName" }
	var named: String = _name_refusal(animation_name)
	if not named.is_empty():
		return { "ok": false, "error": named }
	var loop_modes: Dictionary = LOOP_MODES
	if not loop_modes.has(loop_mode_name):
		return { "ok": false, "error": "Unsupported loopMode: " + loop_mode_name }
	var timing: String = _timing_refusal(args)
	if not timing.is_empty():
		return { "ok": false, "error": timing }

	var opened: Array = _open_at(scene_path, player_node_path, "AnimationPlayer")
	var scene: GdhSceneFile = opened[0]
	if opened[1] == null:
		return opened[2]
	var player: AnimationPlayer = opened[1]
	if player.has_animation(StringName(animation_name)):
		return scene.refuse("Animation already exists: " + animation_name)
	var library: Array = _library_for(player, animation_name)
	if library[0] == null:
		return scene.refuse(str(library[1]))
	var anim_lib: AnimationLibrary = library[0]
	var homes: Array = _homes(scene, [[anim_lib, "animation library"]])
	if not homes[0]:
		return scene.refuse(str(homes[1]))

	var anim: Animation = Animation.new()
	anim.length = GdhRead.as_float(args.get("length", 1.0), 1.0)
	anim.loop_mode = GdhRead.as_int(loop_modes[loop_mode_name]) as Animation.LoopMode
	anim.step = GdhRead.as_float(args.get("step", 0.1), 0.1)
	var called: String = (
		animation_name.get_slice("/", 1) if animation_name.contains("/") else animation_name
	)
	# As the editor names a new one: the file keeps it as resource_name, which the inspector shows.
	anim.resource_name = called
	var add_err: Error = anim_lib.add_animation(StringName(called), anim)
	if add_err != OK:
		return scene.refuse("Failed to add animation: " + error_string(add_err))

	var at: String = scene.path_of(player)
	var check: Callable = func(saved: Node) -> String:
		var copy: AnimationPlayer = saved.get_node_or_null(at) as AnimationPlayer
		if copy == null or not copy.has_animation(StringName(animation_name)):
			return "%s would not be in the scene when it loads." % animation_name
		return ""
	var answer: Dictionary = {
		"ok": true,
		"animationName": animation_name,
		"length": GdhAnimationReads.held_seconds(anim.length),
		"loopMode": loop_mode_name,
	}
	if library[2]:
		answer["libraryMade"] = (
			animation_name.get_slice("/", 0) if animation_name.contains("/") else ""
		)
	var files: Dictionary = homes[1]
	return _finish(scene, check, files, answer)


## Why [param animation_name] cannot name an animation, or "". The player refuses : , and [ in an
## animation's or a library's name, and reads one slash as the end of the library's.
static func _name_refusal(animation_name: String) -> String:
	if animation_name.count("/") > 1:
		return (
			(
				"%s names a library and an animation in it with one slash, as moves/walk; a "
				+ "library holds no libraries."
			)
			% animation_name
		)
	for forbidden: String in [":", ",", "["]:
		if animation_name.contains(forbidden):
			return "An animation's name cannot hold : , or [, and %s does." % animation_name
	for part: String in animation_name.split("/"):
		if part.strip_edges().is_empty() and animation_name.contains("/"):
			return "%s leaves the library's or the animation's name empty." % animation_name
	return ""


## The keys of [param anim], called [param animation_name], that lie past its end, where they never
## play, as a sentence naming each by its track's path and time, or "" when none does. The engine
## keeps such a key, as the editor does, so a longer length plays it again.
static func _past_length(anim: Animation, animation_name: String) -> String:
	var past: PackedStringArray = []
	for track: int in anim.get_track_count():
		for key: int in anim.track_get_key_count(track):
			var time: float = anim.track_get_key_time(track, key)
			if time > anim.length + 0.0001:
				var _added: bool = past.append(
					"%s at %s s" % [str(anim.track_get_path(track)), _seconds(time)]
				)
	return _past_sentence(anim, animation_name, past)


## The pastLength sentence for [param past], keys of [param anim] each named by its track's path and
## time, or "" for none.
static func _past_sentence(
	anim: Animation, animation_name: String, past: PackedStringArray
) -> String:
	if past.is_empty():
		return ""
	return (
		(
			"%s is %s s long, and %s past its end, where %s: %s. %s; scene_animation set "
			+ "with a longer length plays %s."
		)
		% [
			animation_name,
			_seconds(anim.length),
			"this key is" if past.size() == 1 else "these keys are",
			"it never plays" if past.size() == 1 else "they never play",
			", ".join(past),
			"It is kept" if past.size() == 1 else "They are kept",
			"it" if past.size() == 1 else "them",
		]
	)


## [param seconds] as a caller wrote it: a key at 2 reads 2, not 2.0.
static func _seconds(seconds: float) -> String:
	var rounded: float = snappedf(seconds, 0.0001)
	return str(int(rounded)) if rounded == floorf(rounded) else str(rounded)


# =============================================================================
# set_animation, rename_animation, remove_animation
# =============================================================================
## Why the length or step in [param args] cannot be taken, or "". The engine raises a length below
## a thousandth of a second to that without a word.
static func _timing_refusal(args: Dictionary) -> String:
	if args.has("length"):
		var length: Variant = args["length"]
		if not (length is float or length is int) or GdhRead.as_float(length) <= 0.0:
			return (
				"length is the animation's length in seconds, more than 0, and %s is not."
				% _given(length)
			)
	if args.has("step"):
		var step: Variant = args["step"]
		if not (step is float or step is int) or GdhRead.as_float(step) < 0.0:
			return "step is the keyframe snap in seconds, 0 or more, and %s is not." % _given(step)
	return ""


static func _given(value: Variant) -> String:
	if value is float or value is int:
		return _seconds(GdhRead.as_float(value))
	return JSON.stringify(value)


## [param scene_path] opened for writing with the player at [param player_node_path], which must
## have [param animation_name], as [method _open_at] answers.
func _animation_at(scene_path: String, player_node_path: String, animation_name: String) -> Array:
	var opened: Array = _open_at(scene_path, player_node_path, "AnimationPlayer")
	if opened[1] == null:
		return opened
	var scene: GdhSceneFile = opened[0]
	var player: AnimationPlayer = opened[1]
	if player.has_animation(StringName(animation_name)):
		return opened
	var said: String = GdhAnimationReads.no_animation(player, player_node_path, animation_name)
	return [scene, null, scene.refuse(said)]


## Changes the length, loop mode or step of an animation, naming any key a shorter length leaves
## past the end.
func set_animation(args: Dictionary) -> Dictionary:
	var scene_path: String = GdhSceneFile.res_path("", str(args.get("scenePath", "")))
	var player_node_path: String = str(args.get("playerNodePath", "."))
	var animation_name: String = str(args.get("animationName", ""))
	var loop_mode_name: String = str(args.get("loopMode", ""))
	if scene_path.strip_edges() == "res://":
		return { "ok": false, "error": "Missing scenePath" }
	if animation_name.strip_edges().is_empty():
		return { "ok": false, "error": "Missing animationName" }
	if not (args.has("length") or args.has("loopMode") or args.has("step")):
		return {
			"ok": false,
			"error": "set changes length, loopMode or step, and was given none of them.",
		}
	if args.has("loopMode") and not LOOP_MODES.has(loop_mode_name):
		return { "ok": false, "error": "Unsupported loopMode: " + loop_mode_name }
	var timing: String = _timing_refusal(args)
	if not timing.is_empty():
		return { "ok": false, "error": timing }

	var found: Array = _animation_at(scene_path, player_node_path, animation_name)
	if found[1] == null:
		return found[2]
	var scene: GdhSceneFile = found[0]
	var player: AnimationPlayer = found[1]
	var anim: Animation = player.get_animation(StringName(animation_name))
	var homes: Array = _homes(
		scene, [[_library_of(player, animation_name), "animation library"], [anim, "animation"]]
	)
	if not homes[0]:
		return scene.refuse(str(homes[1]))
	if args.has("length"):
		anim.length = GdhRead.as_float(args["length"])
	if args.has("loopMode"):
		anim.loop_mode = GdhRead.as_int(LOOP_MODES[loop_mode_name]) as Animation.LoopMode
	if args.has("step"):
		anim.step = GdhRead.as_float(args["step"])

	var length: float = anim.length
	var at: String = scene.path_of(player)
	var check: Callable = func(saved: Node) -> String:
		var copy: AnimationPlayer = saved.get_node_or_null(at) as AnimationPlayer
		if copy == null or not copy.has_animation(StringName(animation_name)):
			return "%s would not be in the scene when it loads." % animation_name
		if not is_equal_approx(copy.get_animation(StringName(animation_name)).length, length):
			return (
				"%s would not be %s s long when the scene loads."
				% [animation_name, _seconds(length)]
			)
		return ""
	var answer: Dictionary = {
		"ok": true,
		"animationName": animation_name,
		"length": GdhAnimationReads.held_seconds(anim.length),
		"loopMode": GdhAnimationReads.LOOP_MODE_NAMES.get(anim.loop_mode, str(anim.loop_mode)),
		"step": GdhAnimationReads.held_seconds(anim.step),
	}
	var past: String = _past_length(anim, animation_name)
	if not past.is_empty():
		answer["pastLength"] = past
	var files: Dictionary = homes[1]
	return _finish(scene, check, files, answer)


## Renames an animation within its library, taking along the player's autoplay and every state of
## the scene's trees that plays it, since a state naming an animation the player lacks plays nothing
## and says so only in the editor's log.
func rename_animation(args: Dictionary) -> Dictionary:
	var scene_path: String = GdhSceneFile.res_path("", str(args.get("scenePath", "")))
	var player_node_path: String = str(args.get("playerNodePath", "."))
	var animation_name: String = str(args.get("animationName", ""))
	var new_name: String = str(args.get("newName", "")).strip_edges()
	if scene_path.strip_edges() == "res://":
		return { "ok": false, "error": "Missing scenePath" }
	if animation_name.strip_edges().is_empty():
		return { "ok": false, "error": "Missing animationName" }
	if new_name.is_empty():
		return { "ok": false, "error": "Missing newName" }
	var library_name: String = (
		animation_name.get_slice("/", 0) if animation_name.contains("/") else ""
	)
	var prefix: String = "" if library_name.is_empty() else library_name + "/"
	if not prefix.is_empty() and new_name.begins_with(prefix):
		new_name = new_name.trim_prefix(prefix)
	if new_name.contains("/"):
		return {
			"ok": false,
			"error":
			(
				(
					"rename keeps an animation in its library (%s), so newName is its name there, "
					+ "with no library before a slash."
				)
				% ("the default one" if library_name.is_empty() else library_name)
			),
		}
	for forbidden: String in [":", ",", "["]:
		if new_name.contains(forbidden):
			return {
				"ok": false,
				"error": "An animation's name cannot hold : , or [, and %s does." % new_name,
			}
	var new_full: String = prefix + new_name

	var found: Array = _animation_at(scene_path, player_node_path, animation_name)
	if found[1] == null:
		return found[2]
	var scene: GdhSceneFile = found[0]
	var player: AnimationPlayer = found[1]
	if new_full == animation_name:
		return scene.refuse("%s is already called %s." % [animation_name, new_full])
	if player.has_animation(StringName(new_full)):
		return scene.refuse("%s already has an animation %s." % [player_node_path, new_full])
	var library: AnimationLibrary = _library_of(player, animation_name)
	var states: Array = GdhAnimationReads.states_playing(scene.root, player, animation_name)
	var held: Array = [[library, "animation library"]]
	for state: Array in states:
		held.append([state[0], "state playing %s" % animation_name])
	var homes: Array = _homes(scene, held)
	if not homes[0]:
		return scene.refuse(str(homes[1]))

	# Read before the rename, since the player moves its autoplay to the new name on its own; it
	# does not clear one when an animation is removed.
	var autoplayed: bool = str(player.autoplay) == animation_name
	library.rename_animation(StringName(animation_name.trim_prefix(prefix)), StringName(new_name))
	if not player.has_animation(StringName(new_full)):
		return scene.refuse("The library did not take the name %s." % new_full)
	# As the editor's rename sets it: the library's key alone left the file's resource_name, which
	# the inspector shows, on the old name.
	player.get_animation(StringName(new_full)).resource_name = new_name
	var answer: Dictionary = { "ok": true, "animationName": new_full, "was": animation_name }
	if autoplayed:
		answer["autoplay"] = new_full
	var followed: Array = []
	for state: Array in states:
		var plays: AnimationNodeAnimation = state[0]
		plays.animation = StringName(new_full)
		followed.append(state[1])
	if not followed.is_empty():
		answer["statesFollowed"] = followed

	var at: String = scene.path_of(player)
	var check: Callable = func(saved: Node) -> String:
		var copy: AnimationPlayer = saved.get_node_or_null(at) as AnimationPlayer
		if copy == null or not copy.has_animation(StringName(new_full)):
			return "%s would not be in the scene when it loads." % new_full
		return ""
	var files: Dictionary = homes[1]
	return _finish(scene, check, files, answer)


## Removes an animation, clearing the player's autoplay when it named it and naming the states of
## the scene's trees left playing nothing.
func remove_animation(args: Dictionary) -> Dictionary:
	var scene_path: String = GdhSceneFile.res_path("", str(args.get("scenePath", "")))
	var player_node_path: String = str(args.get("playerNodePath", "."))
	var animation_name: String = str(args.get("animationName", ""))
	if scene_path.strip_edges() == "res://":
		return { "ok": false, "error": "Missing scenePath" }
	if animation_name.strip_edges().is_empty():
		return { "ok": false, "error": "Missing animationName" }

	var found: Array = _animation_at(scene_path, player_node_path, animation_name)
	if found[1] == null:
		return found[2]
	var scene: GdhSceneFile = found[0]
	var player: AnimationPlayer = found[1]
	var library: AnimationLibrary = _library_of(player, animation_name)
	var homes: Array = _homes(scene, [[library, "animation library"]])
	if not homes[0]:
		return scene.refuse(str(homes[1]))
	var called: String = (
		animation_name.get_slice("/", 1) if animation_name.contains("/") else animation_name
	)
	var autoplayed: bool = str(player.autoplay) == animation_name
	library.remove_animation(StringName(called))
	if player.has_animation(StringName(animation_name)):
		return scene.refuse("The library did not let go of %s." % animation_name)
	var answer: Dictionary = { "ok": true, "removed": animation_name }
	if autoplayed:
		player.autoplay = ""
		answer["autoplayCleared"] = true
	var orphaned: Array = []
	for state: Array in GdhAnimationReads.states_playing(scene.root, player, animation_name):
		orphaned.append(state[1])
	if not orphaned.is_empty():
		answer["statesPlayingNothing"] = orphaned

	var at: String = scene.path_of(player)
	var check: Callable = func(saved: Node) -> String:
		var copy: AnimationPlayer = saved.get_node_or_null(at) as AnimationPlayer
		if copy == null or copy.has_animation(StringName(animation_name)):
			return "%s would still be in the scene when it loads." % animation_name
		return ""
	var files: Dictionary = homes[1]
	return _finish(scene, check, files, answer)
