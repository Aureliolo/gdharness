@tool
extends Node

## Animations and animation trees, edited in the open editor or, for a project no editor serves, by a
## headless engine.

const GdhAnimationReads = preload("../animation_reads.gd")
const GdhHeadlessCheck = preload("../headless_check.gd")
const GdhPropertyValues = preload("../property_values.gd")
const GdhRead = preload("../reading.gd")
const GdhSceneFile = preload("../scene_file.gd")
const GdhSerialisation = preload("../serialisation.gd")

## How far right of the rightmost state a new one goes in the editor's graph, wider than a state's
## box there.
const STATE_SPACING: float = 200.0
const LOOP_MODES: Dictionary = {
	"none": Animation.LOOP_NONE, "linear": Animation.LOOP_LINEAR, "pingpong": Animation.LOOP_PINGPONG
}

var _editor_plugin: EditorPlugin = null
var _properties: GdhPropertyValues = GdhPropertyValues.new()


func set_editor_plugin(plugin: EditorPlugin) -> void:
	_editor_plugin = plugin


# =============================================================================
# Shared helpers
# =============================================================================
func _ensure_res_path(path: String) -> String:
	if not path.begins_with("res://"):
		return "res://" + path
	return path


func _find_node(root: Node, path: String) -> Node:
	if path == "." or path.is_empty():
		return root
	return root.get_node_or_null(path)


## [param scene_path] opened for writing, with the node at [param node_path] in it, which must be a
## [param kind] the scene owns. Answers [scene, node, refusal]; the refusal is {} when both were
## found.
func _open_at(scene_path: String, node_path: String, kind: String) -> Array:
	var scene: GdhSceneFile = GdhSceneFile.new()
	var refused: Dictionary = scene.open(scene_path, true)
	if not refused.is_empty():
		return [scene, null, refused]
	var node: Node = _find_node(scene.root, node_path)
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
	var node: Node = _find_node(scene.root, node_path)
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
func _finish(scene: GdhSceneFile, check: Callable, homes: Dictionary, answer: Dictionary) -> Dictionary:
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
									"Nothing was written: %s holds a resource with a script that is not a tool, and what "
									+ "that script changed when a headless engine loaded it cannot be told apart from the "
									+ "edit. "
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
		var saving: Error = GdhSceneFile.save_keeping_uid(resource, str(file))
		if saving != OK:
			return {"ok": false, "error": "Failed to save %s: %s" % [file, error_string(saving)]}
		if Engine.is_editor_hint():
			EditorInterface.get_resource_filesystem().update_file(str(file))
	return answer


## Whether [param resource], or one it embeds, has a script that is not a tool, which a headless
## engine ran as it loaded the file.
func _scripted(resource: Resource) -> bool:
	var script: Script = resource.get_script()
	return (script != null and not script.is_tool()) or GdhHeadlessCheck.holds_scripted_embedded(resource, {})


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
					"The %s is kept in %s, not in %s, and an edit here would not be saved there. Edit it "
					+ "where it is kept instead."
				)
				% [entry[1], at.get_slice("::", 0), scene.path]
			)
		]
	return [true, homes]


## The library a new animation called [param animation_name] goes in, as [library, why not]: the
## default one, made when the player has none, or the one named before a slash, as the player
## names them ("moves/walk").
func _library_for(player: AnimationPlayer, animation_name: String) -> Array:
	var library: String = ""
	if animation_name.contains("/"):
		library = animation_name.get_slice("/", 0)
	if player.has_animation_library(StringName(library)):
		return [player.get_animation_library(StringName(library)), ""]
	if not library.is_empty():
		return [null, "%s has no animation library named %s." % [player.name, library]]
	var made: AnimationLibrary = AnimationLibrary.new()
	var adding: Error = player.add_animation_library("", made)
	if adding != OK:
		return [null, "Failed to create the default AnimationLibrary: " + error_string(adding)]
	return [made, ""]


## The library [param animation_name] is in on [param player].
func _library_of(player: AnimationPlayer, animation_name: String) -> AnimationLibrary:
	var library: String = animation_name.get_slice("/", 0) if animation_name.contains("/") else ""
	return player.get_animation_library(StringName(library))


## The state machine at [param state_machine_path] in [param anim_tree], with the files it is kept
## in, as [machine, homes, why not].
func _machine(scene: GdhSceneFile, anim_tree: AnimationTree, state_machine_path: String) -> Array:
	var sm: AnimationNodeStateMachine = GdhAnimationReads.state_machine(anim_tree, state_machine_path)
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
	var scene_path: String = _ensure_res_path(str(args.get("scenePath", "")))
	var player_node_path: String = str(args.get("playerNodePath", "."))
	var animation_name: String = str(args.get("animationName", ""))
	if scene_path.strip_edges() == "res://":
		return {"ok": false, "error": "Missing scenePath"}

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
	var scene_path: String = _ensure_res_path(str(args.get("scenePath", "")))
	var anim_tree_path: String = str(args.get("animTreePath", ""))
	var state_machine_path: String = str(args.get("stateMachinePath", ""))
	if scene_path.strip_edges() == "res://":
		return {"ok": false, "error": "Missing scenePath"}
	if anim_tree_path.is_empty():
		return {"ok": false, "error": "Missing animTreePath"}

	var opened: Array = _read_at(scene_path, anim_tree_path, "AnimationTree")
	var scene: GdhSceneFile = opened[0]
	if opened[1] == null:
		return opened[2]
	var anim_tree: AnimationTree = opened[1]
	return _read_in(scene, GdhAnimationReads.states(anim_tree, state_machine_path))


# =============================================================================
# create_animation
# =============================================================================
func create_animation(args: Dictionary) -> Dictionary:
	var scene_path: String = _ensure_res_path(str(args.get("scenePath", "")))
	var player_node_path: String = str(args.get("playerNodePath", "."))
	var animation_name: String = str(args.get("animationName", ""))
	var loop_mode_name: String = str(args.get("loopMode", "none"))

	if scene_path.strip_edges() == "res://":
		return {"ok": false, "error": "Missing scenePath"}
	if animation_name.strip_edges().is_empty():
		return {"ok": false, "error": "Missing animationName"}
	var loop_modes: Dictionary = LOOP_MODES
	if not loop_modes.has(loop_mode_name):
		return {"ok": false, "error": "Unsupported loopMode: " + loop_mode_name}
	var timing: String = _timing_refusal(args)
	if not timing.is_empty():
		return {"ok": false, "error": timing}

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
	var called: String = animation_name.get_slice("/", 1) if animation_name.contains("/") else animation_name
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
		"ok": true, "animationName": animation_name, "length": anim.length, "loopMode": loop_mode_name
	}
	var files: Dictionary = homes[1]
	return _finish(scene, check, files, answer)


# =============================================================================
# add_animation_track
# =============================================================================
func add_animation_track(args: Dictionary) -> Dictionary:
	var scene_path: String = _ensure_res_path(str(args.get("scenePath", "")))
	var player_node_path: String = str(args.get("playerNodePath", "."))
	var animation_name: String = str(args.get("animationName", ""))
	var given_track: Variant = args.get("track", {})

	if scene_path.strip_edges() == "res://":
		return {"ok": false, "error": "Missing scenePath"}
	if animation_name.strip_edges().is_empty():
		return {"ok": false, "error": "Missing animationName"}
	var track: Dictionary = given_track if given_track is Dictionary else {}
	if track.is_empty():
		return {"ok": false, "error": "Missing track"}
	var keyed: Array = _keyframes(track)
	if not keyed[0]:
		return {"ok": false, "error": keyed[1]}

	# Asked of the player, which knows every library: looking only in the default one refused
	# "moves/walk" as missing.
	var opened: Array = _animation_at(scene_path, player_node_path, animation_name)
	var scene: GdhSceneFile = opened[0]
	if opened[1] == null:
		return opened[2]
	var player: AnimationPlayer = opened[1]
	var anim: Animation = player.get_animation(StringName(animation_name))
	var homes: Array = _homes(
		scene, [[_library_of(player, animation_name), "animation library"], [anim, "animation"]]
	)
	if not homes[0]:
		return scene.refuse(str(homes[1]))

	var target_path: String = str(track.get("nodePath", ""))
	if target_path.is_empty():
		target_path = "."
	var target: Node = _animated(player, target_path)
	if target == null:
		return scene.refuse(
			(
				(
					"No node at %s from the player's root node, %s, which is what the track path is read "
					+ "against."
				)
				% [target_path, str(player.root_node)]
			)
		)
	var keyframes: Array = keyed[1]
	var built: Array = _add_track(anim, track, target, target_path, keyframes)
	if not str(built[1]).is_empty():
		return scene.refuse(str(built[1]))
	var track_idx: int = built[0]

	var at: String = scene.path_of(player)
	var keys: int = anim.track_get_key_count(track_idx)
	var check: Callable = func(saved: Node) -> String:
		var copy: AnimationPlayer = saved.get_node_or_null(at) as AnimationPlayer
		if copy == null or not copy.has_animation(StringName(animation_name)):
			return "%s would not be in the scene when it loads." % animation_name
		var loaded: Animation = copy.get_animation(StringName(animation_name))
		if loaded.get_track_count() <= track_idx or loaded.track_get_key_count(track_idx) != keys:
			return "the track would not be in %s when the scene loads." % animation_name
		return ""
	var answer: Dictionary = {
		"ok": true,
		"trackType": str(track.get("type", "")),
		"trackIndex": track_idx,
		"keys": keys,
		"keysAdded": keyframes.size(),
	}
	if built[3]:
		answer["existingTrack"] = true
	if built[2] != null:
		answer["methodFound"] = built[2]
	var past: String = _past_length(anim, animation_name)
	if not past.is_empty():
		answer["pastLength"] = past
	var files: Dictionary = homes[1]
	return _finish(scene, check, files, answer)


## Adds [param track] to [param anim] with [param keyframes], as [index, why not, methodFound,
## existing]: methodFound is null for a property track, and existing is whether the keys went into
## a track the animation already had for that path.
##
## Into that track rather than a second one beside it, as the editor keys a property it already
## animates: two tracks for one path both play, the later overriding the earlier, and a key meant
## to extend the motion was split off where reading the animation showed two halves.
func _add_track(
	anim: Animation, track: Dictionary, target: Node, target_path: String, keyframes: Array
) -> Array:
	var track_type: String = str(track.get("type", ""))
	var keys: Array = []
	var method_found: Variant = null
	var kind: Animation.TrackType = Animation.TYPE_VALUE
	var path: NodePath = NodePath(target_path)
	if track_type == "property":
		var prop_name: String = str(track.get("property", ""))
		if prop_name.is_empty():
			return [-1, "track.property is required for property track", null, false]
		var values: Array = _key_values(target, prop_name, keyframes)
		if not values[0]:
			return [-1, values[1], null, false]
		keys = values[1]
		path = NodePath(target_path + ":" + prop_name)
	elif track_type == "method":
		var method_name: String = str(track.get("method", ""))
		if method_name.is_empty():
			return [-1, "track.method is required for method track", null, false]
		for index: int in keyframes.size():
			var keyframe: Dictionary = keyframes[index]
			var given: Variant = keyframe.get("args", [])
			if not given is Array:
				return [-1, "keyframes[%d].args must be a list." % index, null, false]
			var arguments: Array = given
			keys.append({"method": method_name, "args": _parse_method_args(arguments)})
		method_found = target.has_method(method_name)
		kind = Animation.TYPE_METHOD
	else:
		return [-1, "Unsupported track.type: " + track_type, null, false]

	var track_idx: int = anim.find_track(path, kind)
	var existing: bool = track_idx >= 0
	if existing:
		# Checked before any key goes in, since track_insert_key replaces a key at the same time
		# without a word, and a refusal partway would leave the editor's scene half changed.
		for index: int in keyframes.size():
			var keyframe: Dictionary = keyframes[index]
			var time: float = GdhRead.as_float(keyframe["time"])
			if anim.track_find_key(track_idx, time, Animation.FIND_MODE_APPROX) >= 0:
				return [
					-1,
					(
						(
							"Track %d already animates %s and has a key at %s s, which keyframes[%d] would "
							+ "replace. Nothing was written."
						)
						% [track_idx, str(path), _seconds(time), index]
					),
					null,
					false
				]
	else:
		track_idx = anim.add_track(kind)
		anim.track_set_path(track_idx, path)
	for index: int in keyframes.size():
		var keyframe: Dictionary = keyframes[index]
		if anim.track_insert_key(track_idx, GdhRead.as_float(keyframe["time"]), keys[index]) < 0:
			return [-1, "Keyframe %d could not be inserted." % index, null, false]
	return [track_idx, "", method_found, existing]


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


## The keyframes of [param track], as [true, list] or [false, why]. Each needs its own time: one
## that was not a dictionary was skipped, and one without a time went in at 0, where the next such
## key replaced it, and the answer said nothing of either.
func _keyframes(track: Dictionary) -> Array:
	var given: Variant = track.get("keyframes", [])
	if not given is Array:
		return [false, "track.keyframes must be a list."]
	var keyframes: Array = given
	var times: Dictionary = {}
	for index: int in keyframes.size():
		if not keyframes[index] is Dictionary:
			return [false, "keyframes[%d] is not an object with a time." % index]
		var keyframe: Dictionary = keyframes[index]
		var time: Variant = keyframe.get("time")
		if not (time is float or time is int):
			return [false, "keyframes[%d] has no time." % index]
		var seconds: float = GdhRead.as_float(time)
		if times.has(seconds):
			return [
				false, "keyframes[%d] and [%d] are both at %s seconds." % [times[seconds], index, seconds]
			]
		times[seconds] = index
	return [true, keyframes]


## Each keyframe's value read as the property [param prop_name] on [param target] takes it, as
## [true, values] or [false, why]. Read without the property, a string "10" keyed on Label.text
## was stored as the number 10, and a Vector2 given as [1, 2] as a list.
func _key_values(target: Node, prop_name: String, keyframes: Array) -> Array:
	var base: String = prop_name.get_slice(":", 0)
	var declared: Dictionary = _properties.declaration(target, base)
	if declared.is_empty():
		return [false, GdhPropertyValues.no_property(target, base)]
	var values: Array = []
	for index: int in keyframes.size():
		var keyframe: Dictionary = keyframes[index]
		var raw: Variant = keyframe.get("value")
		if base != prop_name:
			# A subname such as position:x keys one component, which is a number.
			var component: Variant = _properties.parse(raw, TYPE_FLOAT)
			if not component is float:
				return [false, "keyframes[%d].value keys %s, which is a number." % [index, prop_name]]
			values.append(component)
			continue
		var value: Array = _properties.value_for(target, declared, raw)
		if not value[0]:
			return [false, "keyframes[%d]: %s" % [index, value[1]]]
		values.append(value[1])
	return [true, values]


# =============================================================================
# set_animation, rename_animation, remove_animation
# =============================================================================
## Why the length or step in [param args] cannot be taken, or "". The engine raises a length below
## a thousandth of a second to that without a word.
static func _timing_refusal(args: Dictionary) -> String:
	if args.has("length"):
		var length: Variant = args["length"]
		if not (length is float or length is int) or GdhRead.as_float(length) <= 0.0:
			return "length is the animation's length in seconds, more than 0, and %s is not." % _given(length)
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
	var scene_path: String = _ensure_res_path(str(args.get("scenePath", "")))
	var player_node_path: String = str(args.get("playerNodePath", "."))
	var animation_name: String = str(args.get("animationName", ""))
	var loop_mode_name: String = str(args.get("loopMode", ""))
	if scene_path.strip_edges() == "res://":
		return {"ok": false, "error": "Missing scenePath"}
	if animation_name.strip_edges().is_empty():
		return {"ok": false, "error": "Missing animationName"}
	if not (args.has("length") or args.has("loopMode") or args.has("step")):
		return {"ok": false, "error": "set changes length, loopMode or step, and was given none of them."}
	if args.has("loopMode") and not LOOP_MODES.has(loop_mode_name):
		return {"ok": false, "error": "Unsupported loopMode: " + loop_mode_name}
	var timing: String = _timing_refusal(args)
	if not timing.is_empty():
		return {"ok": false, "error": timing}

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
			return "%s would not be %s s long when the scene loads." % [animation_name, _seconds(length)]
		return ""
	var answer: Dictionary = {
		"ok": true,
		"animationName": animation_name,
		"length": anim.length,
		"loopMode": GdhAnimationReads.LOOP_MODE_NAMES.get(anim.loop_mode, str(anim.loop_mode)),
		"step": anim.step,
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
	var scene_path: String = _ensure_res_path(str(args.get("scenePath", "")))
	var player_node_path: String = str(args.get("playerNodePath", "."))
	var animation_name: String = str(args.get("animationName", ""))
	var new_name: String = str(args.get("newName", "")).strip_edges()
	if scene_path.strip_edges() == "res://":
		return {"ok": false, "error": "Missing scenePath"}
	if animation_name.strip_edges().is_empty():
		return {"ok": false, "error": "Missing animationName"}
	if new_name.is_empty():
		return {"ok": false, "error": "Missing newName"}
	var library_name: String = animation_name.get_slice("/", 0) if animation_name.contains("/") else ""
	var prefix: String = "" if library_name.is_empty() else library_name + "/"
	if not prefix.is_empty() and new_name.begins_with(prefix):
		new_name = new_name.trim_prefix(prefix)
	if new_name.contains("/"):
		return {
			"ok": false,
			"error":
			(
				(
					"rename keeps an animation in its library (%s), so newName is its name there, with "
					+ "no library before a slash."
				)
				% ("the default one" if library_name.is_empty() else library_name)
			),
		}
	for forbidden: String in [":", ",", "["]:
		if new_name.contains(forbidden):
			return {"ok": false, "error": "An animation's name cannot hold : , or [, and %s does." % new_name}
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
	var states: Array = _states_playing(scene, player, animation_name)
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
	var answer: Dictionary = {"ok": true, "animationName": new_full, "was": animation_name}
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
	var scene_path: String = _ensure_res_path(str(args.get("scenePath", "")))
	var player_node_path: String = str(args.get("playerNodePath", "."))
	var animation_name: String = str(args.get("animationName", ""))
	if scene_path.strip_edges() == "res://":
		return {"ok": false, "error": "Missing scenePath"}
	if animation_name.strip_edges().is_empty():
		return {"ok": false, "error": "Missing animationName"}

	var found: Array = _animation_at(scene_path, player_node_path, animation_name)
	if found[1] == null:
		return found[2]
	var scene: GdhSceneFile = found[0]
	var player: AnimationPlayer = found[1]
	var library: AnimationLibrary = _library_of(player, animation_name)
	var homes: Array = _homes(scene, [[library, "animation library"]])
	if not homes[0]:
		return scene.refuse(str(homes[1]))
	var called: String = animation_name.get_slice("/", 1) if animation_name.contains("/") else animation_name
	var autoplayed: bool = str(player.autoplay) == animation_name
	library.remove_animation(StringName(called))
	if player.has_animation(StringName(animation_name)):
		return scene.refuse("The library did not let go of %s." % animation_name)
	var answer: Dictionary = {"ok": true, "removed": animation_name}
	if autoplayed:
		player.autoplay = ""
		answer["autoplayCleared"] = true
	var orphaned: Array = []
	for state: Array in _states_playing(scene, player, animation_name):
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


## The states of [param scene]'s AnimationTrees that play [param animation_name] from [param player],
## as [[node, {animTreePath, state}]], a state named by the path of the nodes leading to it.
func _states_playing(scene: GdhSceneFile, player: AnimationPlayer, animation_name: String) -> Array:
	var found: Array = []
	var trees: Array[Node] = scene.root.find_children("*", "AnimationTree", true, false)
	if scene.root is AnimationTree:
		trees.append(scene.root)
	for node: Node in trees:
		var tree: AnimationTree = node
		if tree.tree_root == null or tree.get_node_or_null(tree.anim_player) != player:
			continue
		var tree_path: String = str(scene.root.get_path_to(tree))
		_collect_playing(tree.tree_root, "", tree_path, animation_name, found)
	return found


static func _collect_playing(
	node: AnimationNode, at: String, tree_path: String, animation_name: String, found: Array
) -> void:
	if node is AnimationNodeAnimation:
		var plays: AnimationNodeAnimation = node
		if plays.animation == StringName(animation_name):
			found.append([plays, {"animTreePath": tree_path, "state": "." if at.is_empty() else at}])
		return
	var children: Dictionary = {}
	if node is AnimationNodeStateMachine:
		var machine: AnimationNodeStateMachine = node
		for state: StringName in machine.get_node_list():
			children[str(state)] = machine.get_node(state)
	elif node is AnimationNodeBlendTree:
		var blend: AnimationNodeBlendTree = node
		for input: StringName in blend.get_node_list():
			children[str(input)] = blend.get_node(input)
	elif node is AnimationNodeBlendSpace1D:
		var line: AnimationNodeBlendSpace1D = node
		for point: int in line.get_blend_point_count():
			children[str(point)] = line.get_blend_point_node(point)
	elif node is AnimationNodeBlendSpace2D:
		var plane: AnimationNodeBlendSpace2D = node
		for point: int in plane.get_blend_point_count():
			children[str(point)] = plane.get_blend_point_node(point)
	for step: String in children:
		var child: AnimationNode = children[step]
		_collect_playing(child, step if at.is_empty() else at + "/" + step, tree_path, animation_name, found)


# =============================================================================
# add_animation_state
# =============================================================================
func add_animation_state(args: Dictionary) -> Dictionary:
	var scene_path: String = _ensure_res_path(str(args.get("scenePath", "")))
	var anim_tree_path: String = str(args.get("animTreePath", ""))
	var state_name: String = str(args.get("stateName", ""))
	var animation_name: String = str(args.get("animationName", ""))
	var state_machine_path: String = str(args.get("stateMachinePath", ""))

	if scene_path.strip_edges() == "res://":
		return {"ok": false, "error": "Missing scenePath"}
	for required: Array in [
		[anim_tree_path, "animTreePath"], [state_name, "stateName"], [animation_name, "animationName"]
	]:
		if str(required[0]).is_empty():
			return {"ok": false, "error": "Missing " + str(required[1])}

	var opened: Array = _open_at(scene_path, anim_tree_path, "AnimationTree")
	var scene: GdhSceneFile = opened[0]
	if opened[1] == null:
		return opened[2]
	var anim_tree: AnimationTree = opened[1]
	var machine: Array = _machine(scene, anim_tree, state_machine_path)
	if machine[0] == null:
		return scene.refuse(str(machine[2]))
	var sm: AnimationNodeStateMachine = machine[0]
	# add_node fails with nothing but a line in the editor's log on a name in use, and Start and End
	# are in use in every state machine.
	if sm.has_node(StringName(state_name)):
		return scene.refuse("The state machine already has a state named %s." % state_name)
	var player: AnimationPlayer = anim_tree.get_node_or_null(anim_tree.anim_player) as AnimationPlayer
	if player != null and not player.has_animation(StringName(animation_name)):
		# By its path from the scene root, as playerNodePath takes it; anim_player is relative to the
		# tree ("../Anim"), which no argument takes.
		return scene.refuse(
			(
				"The AnimationPlayer at %s has no animation %s for the state to play."
				% [str(scene.root.get_path_to(player)), animation_name]
			)
		)

	var anim_node: AnimationNodeAnimation = AnimationNodeAnimation.new()
	anim_node.animation = StringName(animation_name)
	# Beside the rightmost state: add_node puts a state at the origin, where the editor's graph
	# draws it over whatever is already there, Start included.
	var rightmost: Vector2 = Vector2.ZERO
	for state: StringName in sm.get_node_list():
		var held: Vector2 = sm.get_node_position(state)
		if held.x > rightmost.x:
			rightmost = held
	var position: Vector2 = rightmost + Vector2(STATE_SPACING, 0)
	sm.add_node(StringName(state_name), anim_node, position)
	if not sm.has_node(StringName(state_name)):
		return scene.refuse("The state machine did not take the state %s." % state_name)

	var answer: Dictionary = {
		"ok": true,
		"stateName": state_name,
		"animationName": animation_name,
		# False when the tree has no player to look the animation up in.
		"animationFound": player != null,
		"position": GdhSerialisation.new().serialize_value(position),
	}
	var files: Dictionary = machine[1]
	return _finish(scene, Callable(), files, answer)


# =============================================================================
# connect_animation_states
# =============================================================================
func connect_animation_states(args: Dictionary) -> Dictionary:
	var scene_path: String = _ensure_res_path(str(args.get("scenePath", "")))
	var anim_tree_path: String = str(args.get("animTreePath", ""))
	var from_state: String = str(args.get("fromState", ""))
	var to_state: String = str(args.get("toState", ""))
	var transition_type: String = str(args.get("transitionType", "immediate"))
	var state_machine_path: String = str(args.get("stateMachinePath", ""))
	var advance_condition: String = str(args.get("advanceCondition", ""))

	if scene_path.strip_edges() == "res://":
		return {"ok": false, "error": "Missing scenePath"}
	if anim_tree_path.is_empty():
		return {"ok": false, "error": "Missing animTreePath"}
	if from_state.is_empty() or to_state.is_empty():
		return {"ok": false, "error": "Missing fromState or toState"}
	var modes: Dictionary = {
		"sync": AnimationNodeStateMachineTransition.SWITCH_MODE_SYNC,
		"at_end": AnimationNodeStateMachineTransition.SWITCH_MODE_AT_END,
		"immediate": AnimationNodeStateMachineTransition.SWITCH_MODE_IMMEDIATE,
	}
	if not modes.has(transition_type):
		return {"ok": false, "error": "Unsupported transitionType: " + transition_type}
	var transition: AnimationNodeStateMachineTransition = AnimationNodeStateMachineTransition.new()
	transition.switch_mode = (
		GdhRead.as_int(modes[transition_type]) as AnimationNodeStateMachineTransition.SwitchMode
	)
	if not advance_condition.is_empty():
		transition.advance_condition = StringName(advance_condition)

	var opened: Array = _open_at(scene_path, anim_tree_path, "AnimationTree")
	var scene: GdhSceneFile = opened[0]
	if opened[1] == null:
		return opened[2]
	var anim_tree: AnimationTree = opened[1]
	var machine: Array = _machine(scene, anim_tree, state_machine_path)
	if machine[0] == null:
		return scene.refuse(str(machine[2]))
	var sm: AnimationNodeStateMachine = machine[0]
	var problem: String = _transition_problem(sm, from_state, to_state)
	if not problem.is_empty():
		return scene.refuse(problem)

	sm.add_transition(StringName(from_state), StringName(to_state), transition)
	if not sm.has_transition(StringName(from_state), StringName(to_state)):
		return scene.refuse("The state machine did not take the transition.")
	var files: Dictionary = machine[1]
	return _finish(scene, Callable(), files, {"ok": true, "from": from_state, "to": to_state})


## Why [param sm] cannot take a transition from [param from_state] to [param to_state], or "".
## Each is a condition add_transition fails on with only a line in the editor's log, and the
## transition was answered as made.
func _transition_problem(sm: AnimationNodeStateMachine, from_state: String, to_state: String) -> String:
	for state: String in [from_state, to_state]:
		if not sm.has_node(StringName(state)):
			return "The state machine has no state named %s." % state
	if from_state == to_state:
		return "A transition needs two different states."
	if from_state == "End":
		return "No transition can leave End."
	if to_state == "Start":
		return "No transition can arrive at Start."
	if sm.has_transition(StringName(from_state), StringName(to_state)):
		return "There is already a transition from %s to %s." % [from_state, to_state]
	return ""
