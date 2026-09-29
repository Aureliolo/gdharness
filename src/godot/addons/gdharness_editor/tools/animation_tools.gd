@tool
extends Node

## Animations and animation trees, edited in the open editor.

const PropertyValues = preload("../property_values.gd")
const Read = preload("../reading.gd")
const SceneFile = preload("../scene_file.gd")

var _editor_plugin: EditorPlugin = null
var _properties: PropertyValues = PropertyValues.new()


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
	var scene: SceneFile = SceneFile.new()
	var refused: Dictionary = scene.open(scene_path, true)
	if not refused.is_empty():
		return [scene, null, refused]
	var node: Node = _find_node(scene.root, node_path)
	if node == null or not node.is_class(kind):
		return [scene, null, scene.refuse("%s not found at: %s" % [kind, node_path])]
	var foreign: String = scene.foreign(node)
	if not foreign.is_empty():
		return [scene, null, scene.refuse(foreign)]
	return [scene, node, {}]


## Writes [param scene] once [param check] passes, then the files of [param homes], answering
## [param answer] or a refusal.
func _finish(scene: SceneFile, check: Callable, homes: Dictionary, answer: Dictionary) -> Dictionary:
	var written: Dictionary = scene.write(check)
	if not written.is_empty():
		return written
	for file: Variant in homes:
		var resource: Resource = homes[file]
		var saving: Error = ResourceSaver.save(resource, str(file))
		if saving != OK:
			return {"ok": false, "error": "Failed to save %s: %s" % [file, error_string(saving)]}
		EditorInterface.get_resource_filesystem().update_file(str(file))
	return answer


func _parse_json_maybe(value: Variant) -> Variant:
	if typeof(value) != TYPE_STRING:
		return value
	var text: String = value
	var parsed: Variant = Read.json_or_null(text)
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
func _homes(scene: SceneFile, held: Array) -> Array:
	var homes: Dictionary = {}
	for entry: Array in held:
		var resource: Resource = entry[0]
		var at: String = resource.resource_path
		if at.is_empty() or at.get_slice("::", 0) == scene.path:
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
					"The %s is kept in %s, not in %s, and an edit here would not be saved there. Edit that "
					+ "file, or give the node a %s of its own in this scene."
				)
				% [entry[1], at.get_slice("::", 0), scene.path, entry[1]]
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


## The state machine at a slash-separated path of nested state machine names, or null when
## any step of the path is not one. Every node in a tree of state machines is a state machine
## itself, so the walk asks each step for the child by name and refuses anything else.
func _get_state_machine(
	anim_tree: AnimationTree, state_machine_path: String = ""
) -> AnimationNodeStateMachine:
	if not anim_tree:
		return null
	if state_machine_path.is_empty() or state_machine_path == "root":
		return anim_tree.tree_root as AnimationNodeStateMachine

	var current: AnimationNodeStateMachine = anim_tree.tree_root as AnimationNodeStateMachine
	for segment: String in state_machine_path.split("/", false):
		if segment.is_empty():
			continue
		if current == null or not current.has_node(StringName(segment)):
			return null
		current = current.get_node(StringName(segment)) as AnimationNodeStateMachine
	return current


## The state machine at [param state_machine_path] in [param anim_tree], with the files it is kept
## in, as [machine, homes, why not].
func _machine(scene: SceneFile, anim_tree: AnimationTree, state_machine_path: String) -> Array:
	var sm: AnimationNodeStateMachine = _get_state_machine(anim_tree, state_machine_path)
	if not sm:
		return [null, {}, "AnimationNodeStateMachine not found"]
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
	var loop_modes: Dictionary = {
		"none": Animation.LOOP_NONE, "linear": Animation.LOOP_LINEAR, "pingpong": Animation.LOOP_PINGPONG
	}
	if not loop_modes.has(loop_mode_name):
		return {"ok": false, "error": "Unsupported loopMode: " + loop_mode_name}

	var opened: Array = _open_at(scene_path, player_node_path, "AnimationPlayer")
	var scene: SceneFile = opened[0]
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
	anim.length = Read.as_float(args.get("length", 1.0), 1.0)
	anim.loop_mode = Read.as_int(loop_modes[loop_mode_name]) as Animation.LoopMode
	anim.step = Read.as_float(args.get("step", 0.1), 0.1)
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

	var opened: Array = _open_at(scene_path, player_node_path, "AnimationPlayer")
	var scene: SceneFile = opened[0]
	if opened[1] == null:
		return opened[2]
	var player: AnimationPlayer = opened[1]
	# Asked of the player, which knows every library: looking only in the default one refused
	# "moves/walk" as missing.
	if not player.has_animation(StringName(animation_name)):
		return scene.refuse("%s has no animation %s" % [player_node_path, animation_name])
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
		"ok": true, "trackType": str(track.get("type", "")), "trackIndex": track_idx, "keys": keys
	}
	if built[2] != null:
		answer["methodFound"] = built[2]
	var files: Dictionary = homes[1]
	return _finish(scene, check, files, answer)


## Adds [param track] to [param anim] with [param keyframes], as [index, why not, methodFound]:
## methodFound is null for a property track.
func _add_track(
	anim: Animation, track: Dictionary, target: Node, target_path: String, keyframes: Array
) -> Array:
	var track_type: String = str(track.get("type", ""))
	var keys: Array = []
	var method_found: Variant = null
	var track_idx: int = -1
	if track_type == "property":
		var prop_name: String = str(track.get("property", ""))
		if prop_name.is_empty():
			return [-1, "track.property is required for property track", null]
		var values: Array = _key_values(target, prop_name, keyframes)
		if not values[0]:
			return [-1, values[1], null]
		keys = values[1]
		track_idx = anim.add_track(Animation.TYPE_VALUE)
		anim.track_set_path(track_idx, NodePath(target_path + ":" + prop_name))
	elif track_type == "method":
		var method_name: String = str(track.get("method", ""))
		if method_name.is_empty():
			return [-1, "track.method is required for method track", null]
		for index: int in keyframes.size():
			var keyframe: Dictionary = keyframes[index]
			var given: Variant = keyframe.get("args", [])
			if not given is Array:
				return [-1, "keyframes[%d].args must be a list." % index, null]
			var arguments: Array = given
			keys.append({"method": method_name, "args": _parse_method_args(arguments)})
		method_found = target.has_method(method_name)
		track_idx = anim.add_track(Animation.TYPE_METHOD)
		anim.track_set_path(track_idx, NodePath(target_path))
	else:
		return [-1, "Unsupported track.type: " + track_type, null]

	for index: int in keyframes.size():
		var keyframe: Dictionary = keyframes[index]
		if anim.track_insert_key(track_idx, Read.as_float(keyframe["time"]), keys[index]) < 0:
			return [-1, "Keyframe %d could not be inserted." % index, null]
	return [track_idx, "", method_found]


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
		var seconds: float = Read.as_float(time)
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
		return [false, "%s has no property %s" % [target.get_class(), base]]
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
	var scene: SceneFile = opened[0]
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
		return scene.refuse(
			"%s has no animation %s for the state to play." % [str(anim_tree.anim_player), animation_name]
		)

	var anim_node: AnimationNodeAnimation = AnimationNodeAnimation.new()
	anim_node.animation = StringName(animation_name)
	sm.add_node(StringName(state_name), anim_node)
	if not sm.has_node(StringName(state_name)):
		return scene.refuse("The state machine did not take the state %s." % state_name)

	var answer: Dictionary = {
		"ok": true,
		"stateName": state_name,
		"animationName": animation_name,
		# False when the tree has no player to look the animation up in.
		"animationFound": player != null,
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
		Read.as_int(modes[transition_type]) as AnimationNodeStateMachineTransition.SwitchMode
	)
	if not advance_condition.is_empty():
		transition.advance_condition = StringName(advance_condition)

	var opened: Array = _open_at(scene_path, anim_tree_path, "AnimationTree")
	var scene: SceneFile = opened[0]
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
