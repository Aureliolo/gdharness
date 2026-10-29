@tool
extends "animation_tools.gd"
## The states and transitions of an AnimationTree's state machines, beside the players and tracks
## the script it extends edits, whose helpers it shares.

## How far right of the rightmost state a new one goes in the editor's graph, wider than a state's
## box there.
const STATE_SPACING: float = 200.0


# =============================================================================
# add_animation_state
# =============================================================================
func add_animation_state(args: Dictionary) -> Dictionary:
	var state_name: String = str(args.get("stateName", ""))
	var animation_name: String = str(args.get("animationName", ""))
	if state_name.is_empty():
		return { "ok": false, "error": "Missing stateName" }
	if animation_name.is_empty():
		return { "ok": false, "error": "Missing animationName" }
	var machine: Array = _machine_at(args)
	if machine[1] == null:
		return machine[3]
	var scene: GdhSceneFile = machine[0]
	var sm: AnimationNodeStateMachine = machine[1]
	var anim_tree: AnimationTree = machine[4]
	# add_node fails with nothing but a line in the editor's log on a name in use, and Start and End
	# are in use in every state machine.
	if sm.has_node(StringName(state_name)):
		return scene.refuse("The state machine already has a state named %s." % state_name)
	var reached: Node = anim_tree.get_node_or_null(anim_tree.anim_player)
	var player: AnimationPlayer = reached as AnimationPlayer
	var found: bool = player != null and player.has_animation(StringName(animation_name))

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
		# False when the tree has no player to look the animation up in, or its player has none of
		# that name.
		"animationFound": found,
		"position": GdhSerialisation.new().serialize_value(position),
	}
	# Written all the same, as the editor writes one: a state machine is often laid out before its
	# animations are made, and refusing it stopped a tree being built in that order.
	if player == null:
		answer["animationMissing"] = GdhAnimationReads.no_player(
			str(anim_tree.anim_player), reached
		)
	elif not found:
		answer["animationMissing"] = GdhAnimationReads.missing_animation(
			player, scene.path_of(player), animation_name
		)
	var files: Dictionary = machine[2]
	return _finish(scene, Callable(), files, answer)


# =============================================================================
# connect_animation_states
# =============================================================================
func connect_animation_states(args: Dictionary) -> Dictionary:
	var from_state: String = str(args.get("fromState", ""))
	var to_state: String = str(args.get("toState", ""))
	var transition_type: String = str(args.get("transitionType", "immediate"))
	var advance_condition: String = str(args.get("advanceCondition", ""))
	# Auto where it is the only mode that does what was asked: a condition is checked only on an
	# auto transition, and a machine leaves Start only through one. Written as the default enabled,
	# both did nothing, and the machine sat in Start with its conditions true.
	var auto: bool = not advance_condition.is_empty() or from_state == "Start"
	var advance_mode: String = str(args.get("advanceMode", "auto" if auto else "enabled"))

	if from_state.is_empty() or to_state.is_empty():
		return { "ok": false, "error": "Missing fromState or toState" }
	var advances: Dictionary = {
		"auto": AnimationNodeStateMachineTransition.ADVANCE_MODE_AUTO,
		"enabled": AnimationNodeStateMachineTransition.ADVANCE_MODE_ENABLED,
		"disabled": AnimationNodeStateMachineTransition.ADVANCE_MODE_DISABLED,
	}
	if not advances.has(advance_mode):
		return {
			"ok": false,
			"error": "Unsupported advanceMode: %s; it is auto, enabled or disabled" % advance_mode,
		}
	if not advance_condition.is_empty() and advance_mode != "auto":
		return {
			"ok": false,
			"error":
			(
				(
					"advanceCondition %s would never advance a transition whose advanceMode is %s: "
					+ "the engine checks a condition only on an auto one. Leave advanceMode out, "
					+ "or give auto"
				)
				% [advance_condition, advance_mode]
			),
		}
	var modes: Dictionary = {
		"sync": AnimationNodeStateMachineTransition.SWITCH_MODE_SYNC,
		"at_end": AnimationNodeStateMachineTransition.SWITCH_MODE_AT_END,
		"immediate": AnimationNodeStateMachineTransition.SWITCH_MODE_IMMEDIATE,
	}
	if not modes.has(transition_type):
		return { "ok": false, "error": "Unsupported transitionType: " + transition_type }
	var transition: AnimationNodeStateMachineTransition = AnimationNodeStateMachineTransition.new()
	transition.switch_mode = (
		GdhRead.as_int(modes[transition_type]) as AnimationNodeStateMachineTransition.SwitchMode
	)
	transition.advance_mode = (
		GdhRead.as_int(advances[advance_mode]) as AnimationNodeStateMachineTransition.AdvanceMode
	)
	if not advance_condition.is_empty():
		transition.advance_condition = StringName(advance_condition)

	var found: Array = _machine_at(args)
	if found[1] == null:
		return found[3]
	var scene: GdhSceneFile = found[0]
	var sm: AnimationNodeStateMachine = found[1]
	var problem: String = _transition_problem(sm, from_state, to_state)
	if not problem.is_empty():
		return scene.refuse(problem)

	sm.add_transition(StringName(from_state), StringName(to_state), transition)
	if not sm.has_transition(StringName(from_state), StringName(to_state)):
		return scene.refuse("The state machine did not take the transition.")
	_tell_the_tree(sm)
	var files: Dictionary = found[2]
	var made: Dictionary = {
		"ok": true,
		"from": from_state,
		"to": to_state,
		"transitionType": transition_type,
		"advanceMode": advance_mode,
	}
	if not advance_condition.is_empty():
		made["advanceCondition"] = advance_condition
	return _finish(scene, Callable(), files, made)


## Has the AnimationTree playing [param sm] list its parameters again. Adding or removing a
## transition does not say the tree changed, so the save kept the parameters from before it: a
## condition's parameter was written by the next call to change the machine, and a removed one's
## stayed until then.
static func _tell_the_tree(sm: AnimationNodeStateMachine) -> void:
	var _told: Error = sm.emit_signal(&"tree_changed")


## Why [param sm] cannot take a transition from [param from_state] to [param to_state], or "".
## Each is a condition add_transition fails on with only a line in the editor's log, and the
## transition was answered as made.
func _transition_problem(
	sm: AnimationNodeStateMachine, from_state: String, to_state: String
) -> String:
	for state: String in [from_state, to_state]:
		if not sm.has_node(StringName(state)):
			return _no_state(sm, state)
	if from_state == to_state:
		return "A transition needs two different states."
	if from_state == "End":
		return "No transition can leave End."
	if to_state == "Start":
		return "No transition can arrive at Start."
	if sm.has_transition(StringName(from_state), StringName(to_state)):
		return "There is already a transition from %s to %s." % [from_state, to_state]
	return ""


## The refusal for [param state_name], which [param sm] has no state of: with the nearest names it
## has, or else every state, since a machine has a handful.
static func _no_state(sm: AnimationNodeStateMachine, state_name: String) -> String:
	var said: String = "The state machine has no state named %s" % state_name
	var states: PackedStringArray = []
	for state: StringName in sm.get_node_list():
		var _listed: bool = states.append(str(state))
	var close: PackedStringArray = GdhRead.nearest(state_name, states)
	if not close.is_empty():
		return (
			"%s; the nearest it has %s %s."
			% [said, "is" if close.size() == 1 else "are", ", ".join(close)]
		)
	return "%s; its states are %s." % [said, ", ".join(states)]


## The state machine [param args] names, as [scene, machine, files, refusal, tree]: the machine is
## null and the refusal says why when the scene, the tree or the machine is not there.
func _machine_at(args: Dictionary) -> Array:
	var scene_path: String = GdhSceneFile.res_path("", str(args.get("scenePath", "")))
	var anim_tree_path: String = str(args.get("animTreePath", ""))
	if scene_path.strip_edges() == "res://":
		return [null, null, {}, { "ok": false, "error": "Missing scenePath" }]
	if anim_tree_path.is_empty():
		return [null, null, {}, { "ok": false, "error": "Missing animTreePath" }]
	var opened: Array = _open_at(scene_path, anim_tree_path, "AnimationTree")
	var scene: GdhSceneFile = opened[0]
	if opened[1] == null:
		return [scene, null, {}, opened[2]]
	var anim_tree: AnimationTree = opened[1]
	var machine: Array = _machine(scene, anim_tree, str(args.get("stateMachinePath", "")))
	if machine[0] == null:
		return [scene, null, {}, scene.refuse(str(machine[2]))]
	return [scene, machine[0], machine[1], {}, anim_tree]


# =============================================================================
# remove_animation_state, disconnect_animation_states
# =============================================================================
## Takes a state out of its state machine with every transition leaving or reaching it, which the
## engine drops with the state, and names those under transitionsRemoved. Start and End are part of
## every state machine.
func remove_animation_state(args: Dictionary) -> Dictionary:
	var state_name: String = str(args.get("stateName", ""))
	if state_name.is_empty():
		return { "ok": false, "error": "Missing stateName" }
	var found: Array = _machine_at(args)
	if found[1] == null:
		return found[3]
	var scene: GdhSceneFile = found[0]
	var sm: AnimationNodeStateMachine = found[1]
	if state_name in ["Start", "End"]:
		return scene.refuse(
			"%s is part of every state machine, so it cannot be removed." % state_name
		)
	if not sm.has_node(StringName(state_name)):
		return scene.refuse(_no_state(sm, state_name))
	var dropped: Array = []
	for index: int in sm.get_transition_count():
		var from: String = str(sm.get_transition_from(index))
		var to: String = str(sm.get_transition_to(index))
		if state_name in [from, to]:
			dropped.append({ "from": from, "to": to })
	sm.remove_node(StringName(state_name))
	if sm.has_node(StringName(state_name)):
		return scene.refuse("The state machine did not let go of %s." % state_name)
	for index: int in sm.get_transition_count():
		if state_name in [str(sm.get_transition_from(index)), str(sm.get_transition_to(index))]:
			return scene.refuse(
				"The state machine kept a transition of %s after the state went." % state_name
			)
	var files: Dictionary = found[2]
	var answer: Dictionary = { "ok": true, "removed": state_name, "transitionsRemoved": dropped }
	return _finish(scene, Callable(), files, answer)


## Takes out the transition from one state to another.
func disconnect_animation_states(args: Dictionary) -> Dictionary:
	var from_state: String = str(args.get("fromState", ""))
	var to_state: String = str(args.get("toState", ""))
	if from_state.is_empty() or to_state.is_empty():
		return { "ok": false, "error": "Missing fromState or toState" }
	var found: Array = _machine_at(args)
	if found[1] == null:
		return found[3]
	var scene: GdhSceneFile = found[0]
	var sm: AnimationNodeStateMachine = found[1]
	for state: String in [from_state, to_state]:
		if not sm.has_node(StringName(state)):
			return scene.refuse(_no_state(sm, state))
	if not sm.has_transition(StringName(from_state), StringName(to_state)):
		var leaving: PackedStringArray = []
		for index: int in sm.get_transition_count():
			if str(sm.get_transition_from(index)) == from_state:
				var _listed: bool = leaving.append(str(sm.get_transition_to(index)))
		var said: String = "There is no transition from %s to %s" % [from_state, to_state]
		if leaving.is_empty():
			return scene.refuse("%s; none leaves %s." % [said, from_state])
		return scene.refuse(
			"%s; the ones leaving %s go to %s." % [said, from_state, ", ".join(leaving)]
		)
	sm.remove_transition(StringName(from_state), StringName(to_state))
	if sm.has_transition(StringName(from_state), StringName(to_state)):
		return scene.refuse("The state machine did not let go of the transition.")
	_tell_the_tree(sm)
	var files: Dictionary = found[2]
	return _finish(
		scene, Callable(), files, { "ok": true, "removed": { "from": from_state, "to": to_state } }
	)
