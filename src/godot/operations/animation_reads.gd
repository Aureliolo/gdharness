extends RefCounted

## Animations and state machines read off their nodes: by the editor's tools from the scene it holds,
## and by a headless engine with none connected from a bare node of the class given what the file
## stores, which runs no script of the scene's, so a read answers the same either way.

const FileReads = preload("file_reads.gd")
const Serialisation = preload("serialisation.gd")

const LOOP_MODE_NAMES: Dictionary[int, String] = {
	Animation.LOOP_NONE: "none",
	Animation.LOOP_LINEAR: "linear",
	Animation.LOOP_PINGPONG: "pingpong",
}
const TRACK_TYPE_NAMES: Dictionary[int, String] = {
	Animation.TYPE_VALUE: "property",
	Animation.TYPE_POSITION_3D: "position_3d",
	Animation.TYPE_ROTATION_3D: "rotation_3d",
	Animation.TYPE_SCALE_3D: "scale_3d",
	Animation.TYPE_BLEND_SHAPE: "blend_shape",
	Animation.TYPE_METHOD: "method",
	Animation.TYPE_BEZIER: "bezier",
	Animation.TYPE_AUDIO: "audio",
	Animation.TYPE_ANIMATION: "animation",
}
const SWITCH_MODE_NAMES: Dictionary[int, String] = {
	AnimationNodeStateMachineTransition.SWITCH_MODE_IMMEDIATE: "immediate",
	AnimationNodeStateMachineTransition.SWITCH_MODE_SYNC: "sync",
	AnimationNodeStateMachineTransition.SWITCH_MODE_AT_END: "at_end",
}


## [method animations] of the AnimationPlayer at [param player_path] in the file [param scene_path].
static func scene_animations(scene_path: String, player_path: String, animation_name: String) -> Dictionary:
	var made: Array = _bare(scene_path, player_path, "AnimationPlayer")
	if made[0] == null:
		return made[1]
	var player: AnimationPlayer = made[0]
	var answer: Dictionary = animations(player, animation_name)
	player.free()
	return answer


## [method states] of the AnimationTree at [param tree_path] in the file [param scene_path].
static func scene_states(scene_path: String, tree_path: String, state_machine_path: String) -> Dictionary:
	var made: Array = _bare(scene_path, tree_path, "AnimationTree")
	if made[0] == null:
		return made[1]
	var tree: AnimationTree = made[0]
	var answer: Dictionary = states(tree, state_machine_path)
	tree.free()
	return answer


## A node of the class the file gives the node at [param node_path], holding every property the
## files set but its script, as [node, null] or [null, refusal]. The caller frees it.
static func _bare(scene_path: String, node_path: String, kind: String) -> Array:
	var read: Dictionary = FileReads.scene_node(scene_path, node_path)
	if not read.is_empty() and not read.get("ok", false):
		return [null, read]
	var type: String = str(read.get("type", ""))
	if not ClassDB.class_exists(type) or not ClassDB.is_parent_class(type, kind):
		return [null, {"ok": false, "error": "%s not found at: %s" % [kind, node_path]}]
	var bare: Node = ClassDB.instantiate(type)
	bare.name = str(read["name"])
	var given: Dictionary = read["properties"]
	for property: Variant in given:
		if str(property) != "script":
			bare.set(str(property), given[property])
	return [bare, null]


## The animations of [param player] with their lengths, or [param animation_name] whole when it is
## given. A track comes back in the shape add_track takes, so one read here can be written to
## another animation as it stands.
static func animations(player: AnimationPlayer, animation_name: String) -> Dictionary:
	if animation_name.is_empty():
		var listed: Array[Dictionary] = []
		for called: String in player.get_animation_list():
			var listed_one: Animation = player.get_animation(StringName(called))
			var summary: Dictionary = _summary(listed_one)
			summary["animationName"] = called
			summary["tracks"] = listed_one.get_track_count()
			listed.append(summary)
		return {"ok": true, "animations": listed}
	if not player.has_animation(StringName(animation_name)):
		var names: PackedStringArray = player.get_animation_list()
		return {
			"ok": false,
			"error":
			(
				"%s has no animation %s. It has: %s."
				% [player.name, animation_name, ", ".join(names) if not names.is_empty() else "none"]
			)
		}
	var anim: Animation = player.get_animation(StringName(animation_name))
	var answer: Dictionary = _summary(anim)
	answer["ok"] = true
	answer["animationName"] = animation_name
	var tracks: Array[Dictionary] = []
	var values: Serialisation = Serialisation.new()
	for track: int in anim.get_track_count():
		tracks.append(_track(anim, track, values))
	answer["tracks"] = tracks
	return answer


static func _summary(anim: Animation) -> Dictionary:
	return {
		"length": anim.length,
		"loopMode": LOOP_MODE_NAMES.get(anim.loop_mode, str(anim.loop_mode)),
		"step": anim.step,
	}


static func _track(anim: Animation, track: int, values: Serialisation) -> Dictionary:
	var kind: int = anim.track_get_type(track)
	var path: NodePath = anim.track_get_path(track)
	var shaped: Dictionary = {
		"type": TRACK_TYPE_NAMES.get(kind, str(kind)), "nodePath": str(path.get_concatenated_names())
	}
	var property: String = str(path.get_concatenated_subnames())
	if not property.is_empty():
		shaped["property"] = property
	var keyframes: Array[Dictionary] = []
	var methods: Dictionary = {}
	for key: int in anim.track_get_key_count(track):
		var keyframe: Dictionary = {"time": anim.track_get_key_time(track, key)}
		if kind == Animation.TYPE_METHOD:
			var method: String = str(anim.method_track_get_name(track, key))
			methods[method] = true
			keyframe["method"] = method
			keyframe["args"] = values.serialize_value(anim.method_track_get_params(track, key))
		else:
			keyframe["value"] = values.serialize_value(anim.track_get_key_value(track, key))
		keyframes.append(keyframe)
	# One method across every key is the track's, as add_track takes it. Keys calling different
	# methods, which the editor can make and add_track cannot, keep their own.
	if methods.size() == 1:
		shaped["method"] = methods.keys()[0]
		for keyframe: Dictionary in keyframes:
			var _shared: bool = keyframe.erase("method")
	shaped["keyframes"] = keyframes
	return shaped


## The state machine at a slash-separated path of nested state machine names in [param tree], or
## null when any step of the path is not one. Every node in a tree of state machines is a state
## machine itself, so the walk asks each step for the child by name and refuses anything else.
static func state_machine(tree: AnimationTree, state_machine_path: String) -> AnimationNodeStateMachine:
	if tree == null:
		return null
	var current: AnimationNodeStateMachine = tree.tree_root as AnimationNodeStateMachine
	if state_machine_path == "root":
		return current
	for segment: String in state_machine_path.split("/", false):
		if current == null or not current.has_node(StringName(segment)):
			return null
		current = current.get_node(StringName(segment)) as AnimationNodeStateMachine
	return current


## Why [method state_machine] found none at [param state_machine_path] in [param tree]: the step of
## the path that failed, and what is there instead.
static func no_machine(tree: AnimationTree, state_machine_path: String) -> String:
	if tree == null or tree.tree_root == null:
		return "The AnimationTree has no tree_root."
	var current: AnimationNodeStateMachine = tree.tree_root as AnimationNodeStateMachine
	if current == null:
		return (
			"The AnimationTree's tree_root is not a state machine: its type is %s."
			% tree.tree_root.get_class()
		)
	var walked: PackedStringArray = []
	for segment: String in state_machine_path.split("/", false):
		var where: String = "the root state machine"
		if not walked.is_empty():
			where = "the state machine at " + "/".join(walked)
		if not current.has_node(StringName(segment)):
			var names: PackedStringArray = []
			for state: StringName in current.get_node_list():
				if state != &"Start" and state != &"End":
					var _listed: bool = names.push_back(str(state))
			var held: String = ", ".join(names) if not names.is_empty() else "none"
			return (
				"%s has no state %s. Its states are: %s."
				% [where.to_upper()[0] + where.substr(1), segment, held]
			)
		var next: AnimationNode = current.get_node(StringName(segment))
		if not next is AnimationNodeStateMachine:
			return (
				"The state %s in %s is not a state machine: its type is %s."
				% [segment, where, next.get_class()]
			)
		current = next
		var _walked: bool = walked.push_back(segment)
	return "No state machine at " + state_machine_path


## The states and transitions of the state machine at [param state_machine_path] in [param tree].
static func states(tree: AnimationTree, state_machine_path: String) -> Dictionary:
	var sm: AnimationNodeStateMachine = state_machine(tree, state_machine_path)
	if sm == null:
		return {"ok": false, "error": no_machine(tree, state_machine_path)}
	var listed: Array[Dictionary] = []
	for state: StringName in sm.get_node_list():
		var node: AnimationNode = sm.get_node(state)
		var entry: Dictionary = {"stateName": str(state), "type": node.get_class()}
		if node is AnimationNodeAnimation:
			var plays: AnimationNodeAnimation = node
			entry["animationName"] = str(plays.animation)
		listed.append(entry)
	var transitions: Array[Dictionary] = []
	for index: int in sm.get_transition_count():
		var transition: AnimationNodeStateMachineTransition = sm.get_transition(index)
		var shaped: Dictionary = {
			"from": str(sm.get_transition_from(index)),
			"to": str(sm.get_transition_to(index)),
			"transitionType": SWITCH_MODE_NAMES.get(transition.switch_mode, str(transition.switch_mode)),
		}
		if not str(transition.advance_condition).is_empty():
			shaped["advanceCondition"] = str(transition.advance_condition)
		transitions.append(shaped)
	return {"ok": true, "states": listed, "transitions": transitions}
