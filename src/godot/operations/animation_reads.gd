extends RefCounted
## Animations and state machines read off their nodes: by the editor's tools from the scene it
## holds, and by a headless engine with none connected from a bare node of the class given what the
## file stores, which runs no script of the scene's, so a read answers the same either way.

const GdhFileReads = preload("file_reads.gd")
const GdhRead = preload("reading.gd")
const GdhSerialisation = preload("serialisation.gd")
const LOOP_MODE_NAMES: Dictionary[int, String] = {
	Animation.LOOP_NONE: "none",
	Animation.LOOP_LINEAR: "linear",
	Animation.LOOP_PINGPONG: "pingpong",
}
const UPDATE_MODE_NAMES: Dictionary[int, String] = {
	Animation.UPDATE_CONTINUOUS: "continuous",
	Animation.UPDATE_DISCRETE: "discrete",
	Animation.UPDATE_CAPTURE: "capture",
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
const ADVANCE_MODE_NAMES: Dictionary[int, String] = {
	AnimationNodeStateMachineTransition.ADVANCE_MODE_DISABLED: "disabled",
	AnimationNodeStateMachineTransition.ADVANCE_MODE_ENABLED: "enabled",
	AnimationNodeStateMachineTransition.ADVANCE_MODE_AUTO: "auto",
}


## [method animations] of the AnimationPlayer at [param player_path] in the file [param scene_path].
static func scene_animations(
	scene_path: String, player_path: String, animation_name: String
) -> Dictionary:
	var made: Array = _bare(scene_path, player_path, "AnimationPlayer")
	if made[0] == null:
		return made[1]
	var player: AnimationPlayer = made[0]
	var answer: Dictionary = animations(player, animation_name)
	player.free()
	return answer


## [method states] of the AnimationTree at [param tree_path] in the file [param scene_path].
static func scene_states(
	scene_path: String, tree_path: String, state_machine_path: String
) -> Dictionary:
	var made: Array = _bare(scene_path, tree_path, "AnimationTree")
	if made[0] == null:
		return made[1]
	var tree: AnimationTree = made[0]
	# The player the tree plays from, read from the file the same way, since a bare tree has no
	# siblings to find it among.
	# A path above the root names no node the file has, and finds none, as the editor finds none.
	var player: AnimationPlayer = null
	var player_path: String = ""
	if not str(tree.anim_player).is_empty():
		player_path = (tree_path + "/" + str(tree.anim_player)).simplify_path()
		if player_path.is_empty():
			player_path = "."
		var found: Array = _bare(scene_path, player_path, "AnimationPlayer")
		player = found[0]
	var reached: Node = null
	if player == null and not player_path.is_empty():
		reached = _bare(scene_path, player_path, "Node")[0]
	var unplayed: String = no_player(str(tree.anim_player), reached)
	if reached != null:
		reached.free()
	var answer: Dictionary = states(tree, state_machine_path, player, player_path, unplayed)
	tree.free()
	if player != null:
		player.free()
	return answer


## A node of the class the file gives the node at [param node_path], holding every property the
## files set but its script, as [node, null] or [null, refusal]. The caller frees it.
static func _bare(scene_path: String, node_path: String, kind: String) -> Array:
	var read: Dictionary = GdhFileReads.scene_node_of_kind(scene_path, node_path, kind)
	if not read.get("ok", false):
		return [null, read]
	var bare: Node = ClassDB.instantiate(str(read["type"]))
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
		return { "ok": true, "animations": listed }
	if not player.has_animation(StringName(animation_name)):
		return { "ok": false, "error": no_animation(player, str(player.name), animation_name) }
	var anim: Animation = player.get_animation(StringName(animation_name))
	var answer: Dictionary = _summary(anim)
	answer["ok"] = true
	answer["animationName"] = animation_name
	var tracks: Array[Dictionary] = []
	var values: GdhSerialisation = GdhSerialisation.new()
	for track: int in anim.get_track_count():
		tracks.append(_track(anim, track, values))
	answer["tracks"] = tracks
	return answer


## Why [param player], called [param called], cannot be asked for [param animation_name], with the
## animations it has.
static func no_animation(player: AnimationPlayer, called: String, animation_name: String) -> String:
	var names: PackedStringArray = player.get_animation_list()
	return (
		"%s has no animation %s. It has: %s."
		% [called, animation_name, ", ".join(names) if not names.is_empty() else "none"]
	)


static func _summary(anim: Animation) -> Dictionary:
	return {
		"length": held_seconds(anim.length),
		"loopMode": LOOP_MODE_NAMES.get(anim.loop_mode, str(anim.loop_mode)),
		"step": held_seconds(anim.step),
	}


## [param seconds], a key's time or an animation's length or step, as the shortest decimal holding
## the same 32-bit float. An animation keeps all three as 32-bit floats, so a key put at 0.7 read
## back as 0.699999988079071 and a step of 0.1 as 0.100000001490116.
static func held_seconds(seconds: float) -> float:
	var held: float = PackedFloat32Array([seconds])[0]
	for places: int in range(0, 10):
		var shorter: float = String.num(held, places).to_float()
		if PackedFloat32Array([shorter])[0] == held:
			return shorter
	return held


## Whether two times are one key's: the same 32-bit float, as a scene stores them.
static func same_time(first: float, second: float) -> bool:
	return PackedFloat32Array([first])[0] == PackedFloat32Array([second])[0]


static func _track(anim: Animation, track: int, values: GdhSerialisation) -> Dictionary:
	var kind: int = anim.track_get_type(track)
	var path: NodePath = anim.track_get_path(track)
	var shaped: Dictionary = {
		"type": TRACK_TYPE_NAMES.get(kind, str(kind)),
		"nodePath": str(path.get_concatenated_names()),
	}
	var property: String = str(path.get_concatenated_subnames())
	if not property.is_empty():
		shaped["property"] = property
	if kind == Animation.TYPE_VALUE:
		var mode: int = anim.value_track_get_update_mode(track)
		shaped["update"] = UPDATE_MODE_NAMES.get(mode, str(mode))
	var keyframes: Array[Dictionary] = []
	var methods: Dictionary = {}
	for key: int in anim.track_get_key_count(track):
		var keyframe: Dictionary = { "time": held_seconds(anim.track_get_key_time(track, key)) }
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
static func state_machine(
	tree: AnimationTree, state_machine_path: String
) -> AnimationNodeStateMachine:
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
		return (
			"The AnimationTree has no tree_root. Give it one with scene_node set: tree_root "
			+ '{"_type": "AnimationNodeStateMachine"} builds one into the scene, and the res:// '
			+ "path of one made with resource_edit create keeps it in a file of its own."
		)
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


## Why no state finds its animation when [param anim_player], an AnimationTree's path to its player,
## reaches no AnimationPlayer: [param reached] is the node it reaches instead, null for none.
static func no_player(anim_player: String, reached: Node) -> String:
	var until: String = "so no state plays anything until scene_node set points anim_player at one."
	if anim_player.is_empty():
		return "The AnimationTree has no anim_player, " + until
	if reached == null:
		return "The AnimationTree's anim_player %s reaches no node, %s" % [anim_player, until]
	return (
		"The AnimationTree's anim_player %s reaches %s, a %s rather than an AnimationPlayer, %s"
		% [anim_player, reached.name, reached.get_class(), until]
	)


## Why a state playing [param animation_name] from [param player], at [param player_path] from the
## scene root as playerNodePath takes it, plays nothing yet. anim_player is relative to the tree
## ("../Anim"), which no argument takes.
static func missing_animation(
	player: AnimationPlayer, player_path: String, animation_name: String
) -> String:
	var said: String = (
		(
			"The AnimationPlayer at %s has no animation %s yet, so the state plays nothing until "
			+ "it has one."
		)
		% [player_path, animation_name]
	)
	var close: PackedStringArray = GdhRead.nearest(animation_name, player.get_animation_list())
	if close.is_empty():
		return said
	return (
		said
		+ (
			" The nearest %s %s."
			% ["it has is" if close.size() == 1 else "it has are", ", ".join(close)]
		)
	)


## The states and transitions of the state machine at [param state_machine_path] in [param tree].
## A state playing an animation says whether [param player], at [param player_path], has it, as
## add_state answers: a state naming one it lacks plays nothing, and says so only in a log. With no
## player, each says [param unplayed], what [method no_player] made of the tree's path.
static func states(
	tree: AnimationTree,
	state_machine_path: String,
	player: AnimationPlayer,
	player_path: String,
	unplayed: String
) -> Dictionary:
	var sm: AnimationNodeStateMachine = state_machine(tree, state_machine_path)
	if sm == null:
		return { "ok": false, "error": no_machine(tree, state_machine_path) }
	var listed: Array[Dictionary] = []
	for state: StringName in sm.get_node_list():
		var node: AnimationNode = sm.get_node(state)
		var entry: Dictionary = { "stateName": str(state), "type": node.get_class() }
		if node is AnimationNodeAnimation:
			var plays: AnimationNodeAnimation = node
			entry["animationName"] = str(plays.animation)
			var found: bool = player != null and player.has_animation(plays.animation)
			entry["animationFound"] = found
			if player == null:
				entry["animationMissing"] = unplayed
			elif not found:
				entry["animationMissing"] = missing_animation(
					player, player_path, str(plays.animation)
				)
		listed.append(entry)
	var transitions: Array[Dictionary] = []
	for index: int in sm.get_transition_count():
		var transition: AnimationNodeStateMachineTransition = sm.get_transition(index)
		var shaped: Dictionary = {
			"from": str(sm.get_transition_from(index)),
			"to": str(sm.get_transition_to(index)),
			"transitionType":
			SWITCH_MODE_NAMES.get(transition.switch_mode, str(transition.switch_mode)),
			"advanceMode":
			ADVANCE_MODE_NAMES.get(transition.advance_mode, str(transition.advance_mode)),
		}
		var condition: String = str(transition.advance_condition)
		if not condition.is_empty():
			shaped["advanceCondition"] = condition
		# A condition is checked only on an auto transition, and the default is enabled: a machine
		# with its conditions set true stayed where it was, and nothing said why.
		if not condition.is_empty() and transition.advance_mode != transition.ADVANCE_MODE_AUTO:
			shaped["conditionNote"] = (
				(
					"advanceMode is %s, so %s never advances it: the engine checks a condition "
					+ "only on an auto transition%s. disconnect_states and connect_states again "
					+ "with the condition write it as auto"
				)
				% [
					shaped["advanceMode"],
					condition,
					(
						", and travel() still takes this one"
						if transition.advance_mode == transition.ADVANCE_MODE_ENABLED
						else ""
					),
				]
			)
		transitions.append(shaped)
	return { "ok": true, "states": listed, "transitions": transitions }


## The states of the AnimationTrees under [param root] that play [param animation_name] from
## [param player], as [[node, {animTreePath, state}]], a state named by the path of the nodes
## leading to it.
static func states_playing(root: Node, player: AnimationPlayer, animation_name: String) -> Array:
	var found: Array = []
	var trees: Array[Node] = root.find_children("*", "AnimationTree", true, false)
	if root is AnimationTree:
		trees.append(root)
	for node: Node in trees:
		var tree: AnimationTree = node
		if tree.tree_root == null or tree.get_node_or_null(tree.anim_player) != player:
			continue
		var tree_path: String = str(root.get_path_to(tree))
		_collect_playing(tree.tree_root, "", tree_path, animation_name, found)
	return found


static func _collect_playing(
	node: AnimationNode, at: String, tree_path: String, animation_name: String, found: Array
) -> void:
	if node is AnimationNodeAnimation:
		var plays: AnimationNodeAnimation = node
		if plays.animation == StringName(animation_name):
			found.append(
				[plays, { "animTreePath": tree_path, "state": "." if at.is_empty() else at }]
			)
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
		_collect_playing(
			child, step if at.is_empty() else at + "/" + step, tree_path, animation_name, found
		)
